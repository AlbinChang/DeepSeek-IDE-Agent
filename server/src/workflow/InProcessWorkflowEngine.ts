import { config as globalConfig } from '@/config/index.js';
import type { AgentService } from '@/services/AgentService.js';
import {
    WorkflowApprovalPause,
    WorkflowCancelledError,
    WorkflowTimeoutError,
} from '@/workflow/errors.js';
import {
    buildCheckpoint,
    buildInitialSteps,
    prepareWorkflowInputs,
    resolveApprovalDecision,
    samePath,
} from '@/workflow/engineUtils.js';
import { WorkflowRegistry } from '@/workflow/WorkflowRegistry.js';
import { WorkflowRunner } from '@/workflow/WorkflowRunner.js';
import { WorkflowRunSession } from '@/workflow/WorkflowRunSession.js';
import { WorkflowRunStore, sanitizeForStore } from '@/workflow/WorkflowRunStore.js';
import {
    DefaultWorkflowStepExecutor,
    type WorkflowStepExecutor,
} from '@/workflow/WorkflowStepExecutor.js';
import {
    NULL_WORKFLOW_EVENT_BUS,
    type WorkflowDefinition,
    type WorkflowEngine,
    type WorkflowEventBus,
    type WorkflowRunCancelRequest,
    type WorkflowRunInfo,
    type WorkflowRunLookup,
    type WorkflowRunQuery,
    type WorkflowRunRequest,
    type WorkflowRunResumeRequest,
    type WorkflowRunStartResult,
    type WorkflowRuntimeStats,
} from '@/workflow/types.js';

export interface InProcessWorkflowEngineOptions {
    agentService?: AgentService;
    executor?: WorkflowStepExecutor;
    maxWorkers?: number;
    maxQueueSize?: number;
    maxConcurrentRunsPerWorkflow?: number;
    maxRunDurationMs?: number;
    maxStoredRuns?: number;
}

interface QueuedRun {
    request: WorkflowRunRequest;
    definition: WorkflowDefinition;
    snapshot: WorkflowRunInfo;
    session: WorkflowRunSession;
    concurrencyKey: string;
    startIndex?: number;
    initialContext?: Record<string, unknown>;
    waitResolver?: (run: WorkflowRunInfo) => void;
    waitTimer?: ReturnType<typeof setTimeout>;
}

interface ActiveRun {
    runId: string;
    userId: string;
    root: string;
    workflowName: string;
    concurrencyKey: string;
    controller: AbortController;
    promise: Promise<void>;
}

function concurrencyKeyFor(request: WorkflowRunRequest, workflowName: string): string {
    const group = request.concurrencyGroup?.trim();
    return group ? `group:${group}` : `workflow:${workflowName}`;
}

/**
 * Phase 1 执行引擎：主进程内调度，多 run 并行（受 maxWorkers 限制）。
 * 端口与 ProcessWorkerWorkflowEngine 完全一致，后续切换 Worker 不需要改 IPC/工具。
 */
export class InProcessWorkflowEngine implements WorkflowEngine {
    private eventBus: WorkflowEventBus = NULL_WORKFLOW_EVENT_BUS;
    private readonly executor: WorkflowStepExecutor;
    private readonly maxWorkers: number;
    private readonly maxQueueSize: number;
    private readonly maxConcurrentRunsPerWorkflow: number;
    private readonly maxRunDurationMs: number;
    private readonly maxStoredRuns: number;

    private readonly queue: QueuedRun[] = [];
    private readonly active = new Map<string, ActiveRun>();
    private readonly sessions = new Map<string, WorkflowRunSession>();
    private readonly reconciledRoots = new Set<string>();
    private closed = false;

    constructor(options: InProcessWorkflowEngineOptions = {}) {
        this.executor = options.executor || new DefaultWorkflowStepExecutor({
            agentService: options.agentService,
        });
        this.maxWorkers = Math.max(1, options.maxWorkers ?? globalConfig.workflow.maxWorkers);
        this.maxQueueSize = Math.max(1, options.maxQueueSize ?? globalConfig.workflow.maxQueueSize);
        this.maxConcurrentRunsPerWorkflow = Math.max(
            1,
            options.maxConcurrentRunsPerWorkflow ?? globalConfig.workflow.maxConcurrentRunsPerWorkflow,
        );
        this.maxRunDurationMs = Math.max(1000, options.maxRunDurationMs ?? globalConfig.workflow.maxRunDurationMs);
        this.maxStoredRuns = Math.max(1, options.maxStoredRuns ?? globalConfig.workflow.maxStoredRuns);
    }

    public setEventBus(bus: WorkflowEventBus): void {
        this.eventBus = bus || NULL_WORKFLOW_EVENT_BUS;
    }

    public async startRun(request: WorkflowRunRequest): Promise<WorkflowRunStartResult> {
        if (this.closed) {
            return { ok: false, error: 'WORKFLOW_ENGINE_CLOSED' };
        }
        if (this.queue.length >= this.maxQueueSize) {
            return { ok: false, error: 'WORKFLOW_QUEUE_FULL' };
        }

        await this.reconcile(request.root);
        const registry = new WorkflowRegistry(request.root);
        const definition = await registry.loadDefinition(request.path || request.name);
        if (!definition) {
            return { ok: false, error: `Workflow not found: ${request.path || request.name}` };
        }
        if (!definition.validation.ok) {
            return {
                ok: false,
                error: 'WORKFLOW_VALIDATION_FAILED',
                issues: definition.validation.issues,
            };
        }

        const prepared = prepareWorkflowInputs(definition, request.inputs);
        if (!prepared.ok) {
            return { ok: false, error: prepared.error };
        }
        const inputs = prepared.inputs;

        const store = new WorkflowRunStore(request.root);
        const runId = store.newRunId();
        const now = Date.now();
        const snapshot: WorkflowRunInfo = {
            schemaVersion: 1,
            runId,
            workflow: {
                name: definition.summary.name,
                title: definition.summary.title,
                version: definition.summary.version,
                namespace: definition.summary.namespace,
                path: definition.summary.path,
            },
            workflowName: definition.summary.name,
            workflowPath: definition.summary.path,
            userId: request.userId,
            root: request.root,
            status: 'queued',
            inputs: sanitizeForStore(inputs, globalConfig.workflow.maxStepOutputChars) as Record<string, unknown>,
            createdAt: now,
            steps: buildInitialSteps(definition.steps),
            lastSeq: 0,
        };

        await store.create(snapshot);
        const session = new WorkflowRunSession(
            store,
            snapshot,
            (event) => this.eventBus.publish(event),
            globalConfig.workflow.maxStepOutputChars,
        );
        this.sessions.set(runId, session);

        const item: QueuedRun = {
            request: { ...request, inputs },
            definition,
            snapshot,
            session,
            concurrencyKey: concurrencyKeyFor(request, definition.summary.name),
        };

        let waitPromise: Promise<WorkflowRunInfo> | null = null;
        if (request.wait) {
            waitPromise = new Promise<WorkflowRunInfo>((resolve) => {
                item.waitResolver = resolve;
            });
            const timeoutMs = request.timeoutSeconds && request.timeoutSeconds > 0
                ? request.timeoutSeconds * 1000
                : this.maxRunDurationMs;
            item.waitTimer = setTimeout(() => {
                const resolve = item.waitResolver;
                item.waitResolver = undefined;
                item.waitTimer = undefined;
                resolve?.({ ...snapshot });
            }, timeoutMs);
        }

        this.queue.push(item);
        await session.emit('run.queued', {
            workflow: definition.summary.name,
            position: this.queue.length - 1,
        });
        this.pump();

        if (waitPromise) {
            const run = await waitPromise;
            return { ok: true, runId, status: run.status, run };
        }
        return {
            ok: true,
            runId,
            status: 'queued',
            position: Math.max(0, this.queue.findIndex((entry) => entry.snapshot.runId === runId)),
        };
    }

    public async getRun(query: WorkflowRunLookup): Promise<WorkflowRunInfo | null> {
        const store = new WorkflowRunStore(query.root);
        const active = this.sessions.get(query.runId);
        const run = active ? { ...active.snapshot } : await store.read(query.runId);
        if (!run) return null;
        if (run.userId !== query.userId || !samePath(run.root, query.root)) return null;
        if (query.includeEvents) {
            run.events = await store.readEvents(query.runId);
        }
        return run;
    }

    public async listRuns(query: WorkflowRunQuery): Promise<WorkflowRunInfo[]> {
        if (!query.root) return [];
        await this.reconcile(query.root);
        return new WorkflowRunStore(query.root).list(query);
    }

    public async cancelRun(request: WorkflowRunCancelRequest): Promise<boolean> {
        const session = this.sessions.get(request.runId);
        if (session && session.snapshot.userId === request.userId && samePath(session.snapshot.root, request.root)) {
            const queueIndex = this.queue.findIndex((item) => item.snapshot.runId === request.runId);
            if (queueIndex >= 0) {
                const [item] = this.queue.splice(queueIndex, 1);
                this.sessions.delete(request.runId);
                await this.markCancelled(item.session, '运行在排队阶段被取消');
                this.settleWait(item);
                return true;
            }

            const active = this.active.get(request.runId);
            if (active) {
                active.controller.abort(new WorkflowCancelledError('Workflow cancelled by user'));
                return true;
            }
        }

        const store = new WorkflowRunStore(request.root);
        const run = await store.read(request.runId);
        if (!run || run.userId !== request.userId || !samePath(run.root, request.root)) return false;
        if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status)) return false;

        run.status = 'cancelled';
        run.finishedAt = Date.now();
        run.currentTask = undefined;
        run.error = 'Workflow cancelled by user';
        await store.save(run);
        const cancelSession = new WorkflowRunSession(
            store,
            run,
            (event) => this.eventBus.publish(event),
            globalConfig.workflow.maxStepOutputChars,
        );
        await cancelSession.emit('run.cancelled', { reason: 'user' });
        return true;
    }

    public async resumeRun(request: WorkflowRunResumeRequest): Promise<boolean> {
        const store = new WorkflowRunStore(request.root);
        const run = await store.read(request.runId);
        if (!run || run.userId !== request.userId || !samePath(run.root, request.root)) return false;
        if (run.status !== 'waiting_approval' && run.status !== 'interrupted') return false;

        const previousStatus = run.status;
        const decision = resolveApprovalDecision(request.decision);
        if (previousStatus === 'waiting_approval' && decision === undefined) return false;

        const approvalStepPath = run.approval?.stepPath;
        const approvalStep = run.steps.find((step) => step.path === approvalStepPath);

        if (decision === false) {
            if (approvalStep) {
                approvalStep.status = 'cancelled';
                approvalStep.finishedAt = Date.now();
                approvalStep.error = '审批被拒绝';
            }
            run.status = 'cancelled';
            run.finishedAt = Date.now();
            run.approval = undefined;
            run.currentTask = undefined;
            run.error = '审批被拒绝';
            await store.save(run);
            const session = new WorkflowRunSession(
                store,
                run,
                (event) => this.eventBus.publish(event),
                globalConfig.workflow.maxStepOutputChars,
            );
            await session.emit('run.cancelled', { reason: 'approval_rejected' });
            return true;
        }

        if (approvalStep) {
            approvalStep.status = 'succeeded';
            approvalStep.finishedAt = Date.now();
            approvalStep.output = { approved: true, decision: request.decision };
            approvalStep.outputPreview = 'approved';
        }
        run.status = 'queued';
        run.finishedAt = undefined;
        run.approval = undefined;
        run.currentTask = undefined;
        run.error = undefined;
        await store.save(run);

        const definition = await new WorkflowRegistry(request.root).loadDefinition(run.workflowPath || run.workflow.name);
        if (!definition || !definition.validation.ok) {
            run.status = 'failed';
            run.finishedAt = Date.now();
            run.error = '工作流定义在恢复时已不可用或校验失败';
            await store.save(run);
            return false;
        }

        const session = new WorkflowRunSession(
            store,
            run,
            (event) => this.eventBus.publish(event),
            globalConfig.workflow.maxStepOutputChars,
        );
        this.sessions.set(run.runId, session);
        await session.emit('run.resumed', { decision: request.decision, previousStatus });

        this.queue.push({
            request: {
                userId: run.userId,
                root: run.root,
                name: run.workflow.name,
                path: run.workflowPath || run.workflow.path,
                inputs: run.inputs,
            },
            definition,
            snapshot: run,
            session,
            concurrencyKey: `workflow:${run.workflow.name}`,
            startIndex: run.checkpoint?.nextStepIndex ?? 0,
            initialContext: run.checkpoint?.context,
        });
        this.pump();
        return true;
    }

    public async cancelUserRuns(userId: string, root?: string): Promise<void> {
        const matches = (candidateUserId: string, candidateRoot: string) => (
            candidateUserId === userId && (!root || samePath(candidateRoot, root))
        );

        const activeTargets = Array.from(this.active.values())
            .filter((item) => matches(item.userId, item.root));
        const queuedTargets = this.queue
            .filter((item) => matches(item.snapshot.userId, item.snapshot.root));

        await Promise.all([
            ...activeTargets.map((item) => this.cancelRun({
                userId: item.userId,
                root: item.root,
                runId: item.runId,
            })),
            ...queuedTargets.map((item) => this.cancelRun({
                userId: item.snapshot.userId,
                root: item.snapshot.root,
                runId: item.snapshot.runId,
            })),
        ]);

        if (!root) return;
        const waiting = await new WorkflowRunStore(root).list({
            userId,
            root,
            status: 'waiting_approval',
        });
        await Promise.all(waiting.map((run) => this.cancelRun({
            userId: run.userId,
            root: run.root,
            runId: run.runId,
        })));
    }

    public getStats(): WorkflowRuntimeStats {
        return {
            active: this.active.size,
            queued: this.queue.length,
            workers: Array.from(this.active.values()).map((item) => ({
                workerId: 'in-process',
                pid: process.pid,
                runId: item.runId,
            })),
        };
    }

    public async shutdown(): Promise<void> {
        if (this.closed) return;
        this.closed = true;

        const queued = this.queue.splice(0, this.queue.length);
        for (const item of queued) {
            this.sessions.delete(item.snapshot.runId);
            // 保持 queued 状态，下次启动 reconcile 时重新入队
            this.settleWait(item);
        }

        const activations = Array.from(this.active.values());
        for (const item of activations) {
            item.controller.abort(new WorkflowCancelledError('引擎关闭'));
        }
        await Promise.allSettled(activations.map((item) => item.promise));
    }

    /** 首次访问某个工作区时，把上次进程遗留的 running 标记为 interrupted，并重新入队 queued。 */
    public async reconcile(root: string): Promise<void> {
        if (this.reconciledRoots.has(root)) return;
        this.reconciledRoots.add(root);

        const store = new WorkflowRunStore(root);
        const runs = await store.list({ root });
        for (const run of runs) {
            if (run.status === 'running') {
                if (this.active.has(run.runId)) continue;
                run.status = 'interrupted';
                run.finishedAt = Date.now();
                run.currentTask = undefined;
                run.error = '应用重启，运行被中断';
                await store.save(run);
                const session = new WorkflowRunSession(
                    store,
                    run,
                    (event) => this.eventBus.publish(event),
                    globalConfig.workflow.maxStepOutputChars,
                );
                await session.emit('run.interrupted', { error: run.error });
                continue;
            }

            if (run.status !== 'queued') continue;
            if (this.active.has(run.runId) || this.queue.some((item) => item.snapshot.runId === run.runId)) continue;

            const definition = await new WorkflowRegistry(root).loadDefinition(run.workflowPath || run.workflow.name);
            if (!definition || !definition.validation.ok) {
                run.status = 'failed';
                run.finishedAt = Date.now();
                run.error = '重新入队失败：工作流定义不可用或校验失败';
                await store.save(run);
                continue;
            }

            const session = new WorkflowRunSession(
                store,
                run,
                (event) => this.eventBus.publish(event),
                globalConfig.workflow.maxStepOutputChars,
            );
            this.sessions.set(run.runId, session);
            this.queue.push({
                request: {
                    userId: run.userId,
                    root: run.root,
                    name: run.workflow.name,
                    path: run.workflowPath || run.workflow.path,
                    inputs: run.inputs,
                },
                definition,
                snapshot: run,
                session,
                concurrencyKey: `workflow:${run.workflow.name}`,
                startIndex: run.checkpoint?.nextStepIndex ?? 0,
                initialContext: run.checkpoint?.context,
            });
            await session.emit('run.requeued', {});
        }
        this.pump();
    }

    private pump(): void {
        if (this.closed) return;
        while (this.active.size < this.maxWorkers) {
            const index = this.queue.findIndex((item) => {
                const activeForKey = Array.from(this.active.values())
                    .filter((active) => active.concurrencyKey === item.concurrencyKey)
                    .length;
                return activeForKey < this.maxConcurrentRunsPerWorkflow;
            });
            if (index < 0) return;
            const [item] = this.queue.splice(index, 1);
            void this.startItem(item);
        }
    }

    private async startItem(item: QueuedRun): Promise<void> {
        const { snapshot, session } = item;
        const controller = new AbortController();
        const active: ActiveRun = {
            runId: snapshot.runId,
            userId: snapshot.userId,
            root: snapshot.root,
            workflowName: snapshot.workflow.name,
            concurrencyKey: item.concurrencyKey,
            controller,
            promise: Promise.resolve(),
        };
        this.active.set(snapshot.runId, active);
        this.sessions.set(snapshot.runId, session);

        snapshot.status = 'running';
        snapshot.startedAt = snapshot.startedAt || Date.now();
        snapshot.worker = { workerId: 'in-process', pid: process.pid };
        snapshot.position = undefined;

        let durationTimer: ReturnType<typeof setTimeout> | undefined;
        const promise = (async () => {
            durationTimer = setTimeout(() => {
                controller.abort(new WorkflowTimeoutError(
                    `Workflow 运行超过最大时长 ${this.maxRunDurationMs}ms`,
                ));
            }, this.maxRunDurationMs);

            const runner = new WorkflowRunner({
                session,
                definition: item.definition,
                inputs: item.request.inputs || {},
                executor: this.executor,
                abortSignal: controller.signal,
                traceId: `wf-${snapshot.runId}`,
                userId: snapshot.userId,
                root: snapshot.root,
                provider: item.request.provider,
                model: item.request.model,
                reasoningEffort: item.request.reasoningEffort,
                locale: item.request.locale,
                startIndex: item.startIndex,
                initialContext: item.initialContext,
                onCheckpoint: async (checkpoint) => {
                    await session.patch({
                        checkpoint: buildCheckpoint(
                            checkpoint.nextStepIndex,
                            checkpoint.context,
                            snapshot.steps,
                            globalConfig.workflow.maxStepOutputChars,
                        ),
                    });
                },
            });

            try {
                await session.patch({
                    status: 'running',
                    startedAt: snapshot.startedAt,
                    worker: snapshot.worker,
                    position: undefined,
                    error: undefined,
                });
                await session.emit('run.started', {
                    workflow: snapshot.workflow.name,
                    inputs: snapshot.inputs,
                });

                await runner.run();
                if (controller.signal.aborted) {
                    throw controller.signal.reason || new WorkflowCancelledError('Workflow cancelled');
                }
                await session.patch({
                    status: 'succeeded',
                    finishedAt: Date.now(),
                    currentTask: undefined,
                    checkpoint: undefined,
                    approval: undefined,
                    error: undefined,
                });
                await session.emit('run.completed', {
                    status: 'succeeded',
                    usage: snapshot.usage,
                });
            } catch (error: any) {
                if (error instanceof WorkflowApprovalPause) {
                    await session.patch({
                        status: 'waiting_approval',
                        approval: error.approval,
                        currentTask: error.approval.stepPath,
                        checkpoint: buildCheckpoint(
                            error.topLevelIndex + 1,
                            runner.getContextValues(),
                            snapshot.steps,
                            globalConfig.workflow.maxStepOutputChars,
                        ),
                    });
                } else {
                    const reason = controller.signal.reason;
                    const interrupted = this.closed;
                    const timedOut = reason instanceof WorkflowTimeoutError;
                    const cancelled = !timedOut && !interrupted && (reason instanceof WorkflowCancelledError
                        || controller.signal.aborted);
                    const status = interrupted ? 'interrupted' : timedOut ? 'failed' : cancelled ? 'cancelled' : 'failed';
                    const message = interrupted
                        ? '引擎关闭，运行被中断'
                        : timedOut
                            ? (reason instanceof Error ? reason.message : 'Workflow run timed out')
                            : (error?.message || String(error));
                    await session.patch({
                        status,
                        finishedAt: Date.now(),
                        currentTask: undefined,
                        approval: undefined,
                        error: message,
                    });
                    await session.emit(status === 'cancelled' ? 'run.cancelled' : status === 'interrupted' ? 'run.interrupted' : 'run.failed', {
                        error: message,
                    });
                }
            } finally {
                if (durationTimer) clearTimeout(durationTimer);
                this.active.delete(snapshot.runId);
                this.sessions.delete(snapshot.runId);
                this.settleWait(item);
                this.pruneSnapshots(storeFor(snapshot.root));
                this.pump();
            }
        })();

        active.promise = promise;
        await promise;
    }

    private async markCancelled(session: WorkflowRunSession, reason: string): Promise<void> {
        await session.patch({
            status: 'cancelled',
            finishedAt: Date.now(),
            currentTask: undefined,
            approval: undefined,
            error: reason,
        });
        await session.emit('run.cancelled', { reason });
    }

    private settleWait(item: QueuedRun): void {
        const resolve = item.waitResolver;
        item.waitResolver = undefined;
        if (item.waitTimer) {
            clearTimeout(item.waitTimer);
            item.waitTimer = undefined;
        }
        resolve?.({ ...item.snapshot });
    }

    private pruneSnapshots(store: WorkflowRunStore): void {
        void store.prune(this.maxStoredRuns).catch((error) => {
            console.warn('[WorkflowEngine] Failed to prune workflow runs:', error);
        });
    }
}

function storeFor(root: string): WorkflowRunStore {
    return new WorkflowRunStore(root);
}
