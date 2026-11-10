import { config as globalConfig } from '@/config/index.js';
import {
    buildInitialSteps,
    prepareWorkflowInputs,
    resolveApprovalDecision,
    samePath,
} from '@/workflow/engineUtils.js';
import { WorkflowRegistry } from '@/workflow/WorkflowRegistry.js';
import { WorkflowRunSession } from '@/workflow/WorkflowRunSession.js';
import { WorkflowRunStore, sanitizeForStore } from '@/workflow/WorkflowRunStore.js';
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
import type {
    WorkerToMainMessage,
    WorkflowWorkerHandle,
    WorkflowWorkerPermitMessage,
    WorkflowWorkerPermitReleaseMessage,
    WorkflowWorkerSpawner,
    WorkflowWorkerResultMessage,
} from '@/workflow/workerProtocol.js';
import { WORKFLOW_WORKER_PROTOCOL_VERSION } from '@/workflow/workerProtocol.js';

export interface ProcessWorkerWorkflowEngineOptions {
    spawner: WorkflowWorkerSpawner;
    maxWorkers?: number;
    maxQueueSize?: number;
    maxConcurrentRunsPerWorkflow?: number;
    maxRunDurationMs?: number;
    maxStoredRuns?: number;
    agentConcurrencyPerProvider?: number;
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
    workerReadyTimeoutMs?: number;
    cancelGraceMs?: number;
    workerHeapMB?: number;
    env?: NodeJS.ProcessEnv;
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
    item: QueuedRun;
    runId: string;
    userId: string;
    root: string;
    workflowName: string;
    concurrencyKey: string;
    session: WorkflowRunSession;
    handle?: WorkflowWorkerHandle;
    offMessage?: () => void;
    offExit?: () => void;
    messageChain: Promise<void>;
    lastHeartbeatAt: number;
    memMB?: number;
    cpu?: number;
    cancelRequested: boolean;
    timedOut: boolean;
    resultReceived: boolean;
    terminating: boolean;
    finalized: boolean;
    ready: boolean;
    readyResolver?: (ok: boolean) => void;
    initError?: string;
    heldPermits: Map<string, string>;
    durationTimer?: ReturnType<typeof setTimeout>;
    cancelTimer?: ReturnType<typeof setTimeout>;
}

interface PermitWaiter {
    active: ActiveRun;
    requestId: string;
    key: string;
}

function concurrencyKeyFor(request: WorkflowRunRequest, workflowName: string): string {
    const group = request.concurrencyGroup?.trim();
    return group ? `group:${group}` : `workflow:${workflowName}`;
}

function terminalStatus(status: WorkflowRunInfo['status']): boolean {
    return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status);
}

/**
 * Phase 1.5 执行引擎：主进程调度 + Electron utilityProcess Worker 池。
 *
 * - 一个 run 独占一个 Worker（worker-per-run），多个 run 可并行
 * - 主进程是 run.json/events.jsonl 的唯一写者；Worker 只上报状态/事件
 * - Worker 崩溃/心跳超时 → interrupted，可从最后一个顶层 checkpoint 恢复
 * - 审批暂停后 Worker 退出释放槽位，恢复时启动新 Worker
 *
 * 不依赖 Electron：Worker 传输通过 WorkflowWorkerSpawner 注入，便于测试。
 */
export class ProcessWorkerWorkflowEngine implements WorkflowEngine {
    private eventBus: WorkflowEventBus = NULL_WORKFLOW_EVENT_BUS;
    private readonly spawner: WorkflowWorkerSpawner;
    private readonly maxWorkers: number;
    private readonly maxQueueSize: number;
    private readonly maxConcurrentRunsPerWorkflow: number;
    private readonly maxRunDurationMs: number;
    private readonly maxStoredRuns: number;
    private readonly agentConcurrencyPerProvider: number;
    private readonly heartbeatIntervalMs: number;
    private readonly heartbeatTimeoutMs: number;
    private readonly workerReadyTimeoutMs: number;
    private readonly cancelGraceMs: number;
    private readonly workerHeapMB: number;
    private readonly env: NodeJS.ProcessEnv;

    private readonly queue: QueuedRun[] = [];
    private readonly active = new Map<string, ActiveRun>();
    private readonly sessions = new Map<string, WorkflowRunSession>();
    private readonly reconciledRoots = new Set<string>();
    private readonly permitActive = new Map<string, number>();
    private readonly permitWaiters = new Map<string, PermitWaiter[]>();
    private readonly monitorTimer: ReturnType<typeof setInterval>;
    private workerSeq = 0;
    private closed = false;

    constructor(options: ProcessWorkerWorkflowEngineOptions) {
        if (!options?.spawner) {
            throw new Error('ProcessWorkerWorkflowEngine requires a spawner');
        }
        this.spawner = options.spawner;
        this.maxWorkers = Math.max(1, options.maxWorkers ?? globalConfig.workflow.maxWorkers);
        this.maxQueueSize = Math.max(1, options.maxQueueSize ?? globalConfig.workflow.maxQueueSize);
        this.maxConcurrentRunsPerWorkflow = Math.max(
            1,
            options.maxConcurrentRunsPerWorkflow ?? globalConfig.workflow.maxConcurrentRunsPerWorkflow,
        );
        this.maxRunDurationMs = Math.max(1000, options.maxRunDurationMs ?? globalConfig.workflow.maxRunDurationMs);
        this.maxStoredRuns = Math.max(1, options.maxStoredRuns ?? globalConfig.workflow.maxStoredRuns);
        this.agentConcurrencyPerProvider = Math.max(
            1,
            options.agentConcurrencyPerProvider ?? globalConfig.workflow.agentConcurrencyPerProvider,
        );
        this.heartbeatIntervalMs = Math.max(500, options.heartbeatIntervalMs ?? globalConfig.workflow.heartbeatIntervalMs);
        this.heartbeatTimeoutMs = Math.max(1000, options.heartbeatTimeoutMs ?? globalConfig.workflow.heartbeatTimeoutMs);
        this.workerReadyTimeoutMs = Math.max(1000, options.workerReadyTimeoutMs ?? globalConfig.workflow.workerReadyTimeoutMs);
        this.cancelGraceMs = Math.max(200, options.cancelGraceMs ?? globalConfig.workflow.cancelGraceMs);
        this.workerHeapMB = Math.max(128, options.workerHeapMB ?? globalConfig.workflow.workerHeapMB);
        this.env = options.env || process.env;

        this.monitorTimer = setInterval(
            () => this.monitorWorkers(),
            Math.max(500, Math.min(this.heartbeatIntervalMs, 5000)),
        );
        this.monitorTimer.unref?.();
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
        const definition = await new WorkflowRegistry(request.root).loadDefinition(request.path || request.name);
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
            createdAt: Date.now(),
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

        let waitPromise: Promise<WorkflowRunInfo> | undefined;
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
        const queuedIndex = this.queue.findIndex((item) => item.snapshot.runId === request.runId);
        if (queuedIndex >= 0) {
            const [item] = this.queue.splice(queuedIndex, 1);
            if (item.snapshot.userId !== request.userId || !samePath(item.snapshot.root, request.root)) {
                this.queue.splice(queuedIndex, 0, item);
                return false;
            }
            this.sessions.delete(request.runId);
            await this.markCancelled(item.session, '运行在排队阶段被取消');
            this.settleWait(item);
            return true;
        }

        const active = this.active.get(request.runId);
        if (active) {
            if (active.userId !== request.userId || !samePath(active.root, request.root)) return false;
            if (active.resultReceived || active.finalized) return false;
            this.requestCancel(active, 'user');
            return true;
        }

        const store = new WorkflowRunStore(request.root);
        const run = await store.read(request.runId);
        if (!run || run.userId !== request.userId || !samePath(run.root, request.root)) return false;
        if (terminalStatus(run.status)) return false;

        run.status = 'cancelled';
        run.finishedAt = Date.now();
        run.currentTask = undefined;
        run.worker = undefined;
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
        if (this.closed) return false;
        const store = new WorkflowRunStore(request.root);
        const run = await store.read(request.runId);
        if (!run || run.userId !== request.userId || !samePath(run.root, request.root)) return false;
        if (run.status !== 'waiting_approval' && run.status !== 'interrupted') return false;

        const previousStatus = run.status;
        const decision = resolveApprovalDecision(request.decision);
        if (previousStatus === 'waiting_approval' && decision === undefined) return false;

        const approvalStep = run.steps.find((step) => step.path === run.approval?.stepPath);
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
            run.worker = undefined;
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
        run.approval = undefined;
        run.currentTask = undefined;
        run.worker = undefined;
        run.error = undefined;
        run.finishedAt = undefined;
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
            workers: Array.from(this.active.values()).map((item) => {
                const metrics = item.handle?.getMetrics?.();
                return {
                    workerId: item.item.snapshot.worker?.workerId || item.handle?.workerId || 'pending',
                    pid: item.handle?.pid,
                    runId: item.runId,
                    memMB: metrics?.memMB ?? item.memMB,
                    cpu: metrics?.cpu ?? item.cpu,
                };
            }),
        };
    }

    public async shutdown(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        clearInterval(this.monitorTimer);

        const queued = this.queue.splice(0, this.queue.length);
        for (const item of queued) {
            this.sessions.delete(item.snapshot.runId);
            // 保持 queued 状态，下次启动 reconcile 时重新入队
            this.settleWait(item);
        }

        const running = Array.from(this.active.values());
        await Promise.all(running.map(async (item) => {
            if (item.finalized) return;
            item.terminating = true;
            this.clearTimers(item);
            try {
                item.handle?.postMessage({
                    type: 'run.cancel',
                    runId: item.runId,
                    reason: '引擎关闭',
                });
            } catch {
                // Worker 可能已退出
            }
            await this.finalizeActive(item, {
                status: 'interrupted',
                error: '引擎关闭，运行被中断',
                eventType: 'run.interrupted',
            });
        }));

        try {
            await this.spawner.shutdown?.();
        } catch (error) {
            console.warn('[WorkflowEngine] Failed to shutdown worker spawner:', error);
        }
    }

    /** 首次访问工作区时，把上次进程遗留的 running 标记 interrupted，并重新入队 queued。 */
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
                run.worker = undefined;
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
                const runningForKey = Array.from(this.active.values())
                    .filter((active) => active.concurrencyKey === item.concurrencyKey)
                    .length;
                return runningForKey < this.maxConcurrentRunsPerWorkflow;
            });
            if (index < 0) return;
            const [item] = this.queue.splice(index, 1);
            void this.startItem(item);
        }
    }

    private async startItem(item: QueuedRun): Promise<void> {
        const { snapshot, session } = item;
        const active: ActiveRun = {
            item,
            runId: snapshot.runId,
            userId: snapshot.userId,
            root: snapshot.root,
            workflowName: snapshot.workflow.name,
            concurrencyKey: item.concurrencyKey,
            session,
            messageChain: Promise.resolve(),
            lastHeartbeatAt: Date.now(),
            cancelRequested: false,
            timedOut: false,
            resultReceived: false,
            terminating: false,
            finalized: false,
            ready: false,
            heldPermits: new Map(),
        };
        this.active.set(snapshot.runId, active);
        this.sessions.set(snapshot.runId, session);

        snapshot.status = 'running';
        snapshot.startedAt = snapshot.startedAt || Date.now();
        snapshot.position = undefined;
        snapshot.error = undefined;

        const workerId = `wf-${this.workerSeq++}-${snapshot.runId.slice(-6)}`;
        let handle: WorkflowWorkerHandle;
        try {
            handle = this.spawner.spawn({
                workerId,
                runId: snapshot.runId,
                heapMB: this.workerHeapMB,
                env: this.env,
            });
        } catch (error: any) {
            await this.finalizeActive(active, {
                status: 'interrupted',
                error: `Worker 启动失败: ${error?.message || String(error)}`,
                eventType: 'run.interrupted',
            });
            return;
        }

        active.handle = handle;
        snapshot.worker = { workerId, pid: handle.pid };

        active.offMessage = handle.onMessage((message) => this.onWorkerMessage(active, message));
        active.offExit = handle.onExit((code) => this.onWorkerExit(active, code));

        active.durationTimer = setTimeout(() => {
            if (active.finalized || active.resultReceived) return;
            active.timedOut = true;
            this.requestCancel(active, 'timeout');
        }, this.maxRunDurationMs);

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
            worker: snapshot.worker,
        });

        const ready = await this.waitForReady(active);
        if (!ready) {
            if (active.finalized) return;
            if (active.initError) {
                await this.finalizeActive(active, {
                    status: 'interrupted',
                    error: active.initError,
                    eventType: 'run.interrupted',
                });
            } else {
                await this.finalizeActive(active, {
                    status: 'interrupted',
                    error: 'Worker 启动超时',
                    eventType: 'run.interrupted',
                });
            }
            return;
        }

        try {
            if (handle.pid && snapshot.worker) {
                snapshot.worker = { workerId, pid: handle.pid };
                await session.patch({ worker: snapshot.worker });
            }
            handle.postMessage({
                type: 'run.start',
                config: {
                    runId: snapshot.runId,
                    traceId: `wf-${snapshot.runId}`,
                    userId: snapshot.userId,
                    root: snapshot.root,
                    workflowName: snapshot.workflow.name,
                    provider: item.request.provider,
                    model: item.request.model,
                    reasoningEffort: item.request.reasoningEffort,
                    locale: item.request.locale,
                    heartbeatIntervalMs: this.heartbeatIntervalMs,
                },
                definition: {
                    summary: item.definition.summary,
                    steps: item.definition.steps,
                },
                inputs: item.request.inputs || {},
                steps: snapshot.steps,
                startIndex: item.startIndex,
                initialContext: item.initialContext,
            });
        } catch (error: any) {
            await this.finalizeActive(active, {
                status: 'interrupted',
                error: `Worker 启动消息发送失败: ${error?.message || String(error)}`,
                eventType: 'run.interrupted',
            });
        }
    }

    private async waitForReady(active: ActiveRun): Promise<boolean> {
        if (!active.handle) return false;
        const ready = new Promise<boolean>((resolve) => {
            active.readyResolver = resolve;
        });
        try {
            active.handle.postMessage({
                type: 'worker.init',
                protocolVersion: WORKFLOW_WORKER_PROTOCOL_VERSION,
                workerId: active.handle.workerId,
            });
        } catch {
            return false;
        }

        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), this.workerReadyTimeoutMs);
        });
        try {
            return await Promise.race([ready, timeout]);
        } finally {
            if (timer) clearTimeout(timer);
            active.readyResolver = undefined;
        }
    }

    private onWorkerMessage(active: ActiveRun, message: WorkerToMainMessage): void {
        const messageRunId = (message as { runId?: string }).runId;
        if (active.finalized || (messageRunId && messageRunId !== active.runId)) return;

        if (message.type === 'worker.ready') {
            active.ready = true;
            active.lastHeartbeatAt = Date.now();
            active.readyResolver?.(true);
            return;
        }
        if (message.type === 'run.heartbeat') {
            active.lastHeartbeatAt = Date.now();
            active.memMB = message.memMB;
            active.cpu = message.cpu;
            return;
        }
        if (message.type === 'pong') return;
        if (message.type === 'worker.error') {
            active.initError = message.message;
            active.readyResolver?.(false);
            return;
        }

        active.messageChain = active.messageChain
            .catch(() => undefined)
            .then(() => this.handleWorkerMessage(active, message))
            .catch((error) => {
                console.warn(`[WorkflowEngine] Worker message handling failed for ${active.runId}:`, error);
            });
    }

    private async handleWorkerMessage(active: ActiveRun, message: WorkerToMainMessage): Promise<void> {
        if (active.finalized) return;
        switch (message.type) {
            case 'worker.ready':
            case 'worker.error':
            case 'run.heartbeat':
            case 'pong':
                return;
            case 'log':
                if (message.level === 'error') {
                    console.warn(`[WorkflowWorker ${active.handle?.workerId}] ${message.message}`);
                }
                return;
            case 'run.event':
                await active.session.emit(message.eventType, message.data);
                return;
            case 'run.patch':
                if (typeof message.patch.currentTask === 'string') {
                    await active.session.patch({ currentTask: message.patch.currentTask });
                }
                return;
            case 'run.step':
                await active.session.upsertStep(message.step);
                return;
            case 'run.usage':
                await active.session.addUsage(message.usage);
                return;
            case 'run.checkpoint':
                await active.session.patch({
                    checkpoint: {
                        nextStepIndex: message.checkpoint.nextStepIndex,
                        context: sanitizeForStore(
                            message.checkpoint.context,
                            globalConfig.workflow.maxStepOutputChars,
                        ) as Record<string, unknown>,
                        completedPaths: message.checkpoint.completedPaths,
                    },
                });
                return;
            case 'run.permit':
                this.handlePermitRequest(active, message);
                return;
            case 'run.permit.release':
                this.handlePermitRelease(active, message);
                return;
            case 'run.result':
                await this.handleResult(active, message);
                return;
            default:
                return;
        }
    }

    private handlePermitRequest(active: ActiveRun, message: WorkflowWorkerPermitMessage): void {
        if (active.finalized || !active.handle) return;
        if (active.heldPermits.has(message.requestId)) return;
        const key = `${(message.provider || 'default').toLowerCase()}:${message.model || 'default'}`;
        const current = this.permitActive.get(key) || 0;
        if (current < this.agentConcurrencyPerProvider) {
            this.permitActive.set(key, current + 1);
            active.heldPermits.set(message.requestId, key);
            this.grantPermit(active, message.requestId);
            return;
        }
        const waiters = this.permitWaiters.get(key) || [];
        waiters.push({ active, requestId: message.requestId, key });
        this.permitWaiters.set(key, waiters);
    }

    private handlePermitRelease(active: ActiveRun, message: WorkflowWorkerPermitReleaseMessage): void {
        const key = active.heldPermits.get(message.requestId);
        if (key) {
            active.heldPermits.delete(message.requestId);
            const remaining = Math.max(0, (this.permitActive.get(key) || 0) - 1);
            if (remaining > 0) this.permitActive.set(key, remaining);
            else this.permitActive.delete(key);
            this.grantPermitWaiters(key);
            return;
        }
        for (const [waiterKey, waiters] of this.permitWaiters) {
            const index = waiters.findIndex((waiter) => waiter.requestId === message.requestId);
            if (index >= 0) {
                waiters.splice(index, 1);
                if (waiters.length === 0) this.permitWaiters.delete(waiterKey);
                return;
            }
        }
    }

    private grantPermitWaiters(key: string): void {
        const waiters = this.permitWaiters.get(key);
        if (!waiters) return;
        while ((this.permitActive.get(key) || 0) < this.agentConcurrencyPerProvider) {
            const waiter = waiters.shift();
            if (!waiter) break;
            if (waiter.active.finalized || !this.active.has(waiter.active.runId)) continue;
            if (waiter.active.heldPermits.has(waiter.requestId)) continue;
            this.permitActive.set(key, (this.permitActive.get(key) || 0) + 1);
            waiter.active.heldPermits.set(waiter.requestId, key);
            this.grantPermit(waiter.active, waiter.requestId);
        }
        if (waiters.length === 0) this.permitWaiters.delete(key);
    }

    private grantPermit(active: ActiveRun, requestId: string): void {
        try {
            active.handle?.postMessage({ type: 'run.permit.granted', requestId });
        } catch {
            const key = active.heldPermits.get(requestId);
            if (key) {
                active.heldPermits.delete(requestId);
                const remaining = Math.max(0, (this.permitActive.get(key) || 0) - 1);
                if (remaining > 0) this.permitActive.set(key, remaining);
                else this.permitActive.delete(key);
                this.grantPermitWaiters(key);
            }
        }
    }

    private releaseRunPermits(active: ActiveRun): void {
        const counts = new Map<string, number>();
        for (const [requestId, key] of active.heldPermits) {
            active.heldPermits.delete(requestId);
            counts.set(key, (counts.get(key) || 0) + 1);
        }
        for (const [key, count] of counts) {
            const remaining = Math.max(0, (this.permitActive.get(key) || 0) - count);
            if (remaining > 0) this.permitActive.set(key, remaining);
            else this.permitActive.delete(key);
        }
        for (const [key, waiters] of this.permitWaiters) {
            const remaining = waiters.filter((waiter) => waiter.active !== active);
            if (remaining.length > 0) this.permitWaiters.set(key, remaining);
            else this.permitWaiters.delete(key);
        }
        for (const key of counts.keys()) this.grantPermitWaiters(key);
    }

    private async handleResult(active: ActiveRun, message: WorkflowWorkerResultMessage): Promise<void> {
        if (active.finalized || active.resultReceived) return;
        active.resultReceived = true;
        this.clearTimers(active);

        let status = message.status;
        let error = message.error;
        if (active.cancelRequested && status === 'succeeded') {
            status = 'cancelled';
            error = 'Workflow cancelled by user';
        }
        if (active.timedOut && status !== 'waiting_approval') {
            status = 'failed';
            error = `Workflow 运行超过最大时长 ${this.maxRunDurationMs}ms`;
        }
        if (active.cancelRequested && status === 'failed' && !active.timedOut) {
            status = 'cancelled';
            error = error || 'Workflow cancelled by user';
        }

        const finishedAt = Date.now();
        const safeError = error ? String(sanitizeForStore(error, 4000)) : undefined;
        try {
            if (status === 'succeeded') {
                await active.session.patch({
                    status: 'succeeded',
                    finishedAt,
                    currentTask: undefined,
                    checkpoint: undefined,
                    approval: undefined,
                    error: undefined,
                });
                await active.session.emit('run.completed', {
                    status: 'succeeded',
                    usage: active.session.snapshot.usage,
                });
            } else if (status === 'waiting_approval') {
                const approval = message.approval;
                await active.session.patch({
                    status: 'waiting_approval',
                    approval,
                    currentTask: approval?.stepPath,
                    checkpoint: message.checkpoint
                        ? {
                            nextStepIndex: message.checkpoint.nextStepIndex,
                            context: sanitizeForStore(
                                message.checkpoint.context,
                                globalConfig.workflow.maxStepOutputChars,
                            ) as Record<string, unknown>,
                            completedPaths: message.checkpoint.completedPaths,
                        }
                        : active.session.snapshot.checkpoint,
                    finishedAt: undefined,
                    error: undefined,
                });
            } else if (status === 'cancelled') {
                await active.session.patch({
                    status: 'cancelled',
                    finishedAt,
                    currentTask: undefined,
                    approval: undefined,
                    error: safeError || 'Workflow cancelled by user',
                });
                await active.session.emit('run.cancelled', { reason: active.timedOut ? 'timeout' : 'user' });
            } else {
                await active.session.patch({
                    status: 'failed',
                    finishedAt,
                    currentTask: undefined,
                    approval: undefined,
                    error: safeError || 'Workflow failed',
                    checkpoint: message.checkpoint
                        ? {
                            nextStepIndex: message.checkpoint.nextStepIndex,
                            context: sanitizeForStore(
                                message.checkpoint.context,
                                globalConfig.workflow.maxStepOutputChars,
                            ) as Record<string, unknown>,
                            completedPaths: message.checkpoint.completedPaths,
                        }
                        : active.session.snapshot.checkpoint,
                });
                await active.session.emit('run.failed', { error: safeError || 'Workflow failed' });
            }
        } catch (handlingError) {
            console.warn(`[WorkflowEngine] Failed to finalize worker result for ${active.runId}:`, handlingError);
        } finally {
            await this.finishActive(active);
        }
    }

    /** 结果已应用后的收尾：停止 Worker、释放槽位、唤醒 wait 调用方。 */
    private async finishActive(active: ActiveRun): Promise<void> {
        await this.finalizeActive(active, { status: 'succeeded' });
    }

    private onWorkerExit(active: ActiveRun, code: number | null): void {
        // Worker 可能先发出 step/checkpoint/result，再触发 exit；
        // 必须等已到达的消息处理完，避免把成功/审批结果误判为 interrupted。
        active.messageChain = active.messageChain
            .catch(() => undefined)
            .then(() => this.handleWorkerExit(active, code))
            .catch((error) => {
                console.warn(`[WorkflowEngine] Worker exit handling failed for ${active.runId}:`, error);
            });
    }

    private async handleWorkerExit(active: ActiveRun, code: number | null): Promise<void> {
        if (active.finalized || active.resultReceived) return;

        const tail = active.handle?.getLogTail?.();
        const suffix = tail ? `\n${tail.slice(-2000)}` : '';
        if (active.cancelRequested) {
            void this.finalizeActive(active, {
                status: 'cancelled',
                error: active.timedOut
                    ? `Workflow 运行超过最大时长 ${this.maxRunDurationMs}ms`
                    : 'Workflow cancelled by user',
                eventType: 'run.cancelled',
                eventData: { reason: active.timedOut ? 'timeout' : 'user' },
                runStatus: active.timedOut ? 'failed' : 'cancelled',
            });
            return;
        }

        const reason = this.closed
            ? '引擎关闭，运行被中断'
            : `Workflow Worker 异常退出 (code=${String(code)})${suffix}`;
        void this.finalizeActive(active, {
            status: 'interrupted',
            error: reason,
            eventType: 'run.interrupted',
        });
    }

    private requestCancel(active: ActiveRun, reason: 'user' | 'timeout'): void {
        if (active.finalized || active.resultReceived) return;
        active.cancelRequested = true;
        if (reason === 'timeout') active.timedOut = true;
        try {
            active.handle?.postMessage({
                type: 'run.cancel',
                runId: active.runId,
                reason: reason === 'timeout' ? 'timeout' : 'user',
            });
        } catch {
            // Worker 可能已退出
        }
        if (active.cancelTimer) clearTimeout(active.cancelTimer);
        active.cancelTimer = setTimeout(() => {
            if (active.finalized || active.resultReceived) return;
            active.terminating = true;
            active.handle?.kill();
            void this.finalizeActive(active, {
                status: active.timedOut ? 'failed' : 'cancelled',
                error: active.timedOut
                    ? `Workflow 运行超过最大时长 ${this.maxRunDurationMs}ms`
                    : 'Workflow cancelled by user',
                eventType: active.timedOut ? 'run.failed' : 'run.cancelled',
                eventData: { reason: active.timedOut ? 'timeout' : 'user' },
            });
        }, this.cancelGraceMs);
        active.cancelTimer.unref?.();
    }

    private monitorWorkers(): void {
        const now = Date.now();
        for (const active of this.active.values()) {
            if (active.finalized || active.resultReceived || active.cancelRequested) continue;
            if (now - active.lastHeartbeatAt <= this.heartbeatTimeoutMs) continue;
            if (!active.handle) continue;
            active.terminating = true;
            void this.finalizeActive(active, {
                status: 'interrupted',
                error: `Workflow Worker 心跳超时（${this.heartbeatTimeoutMs}ms）`,
                eventType: 'run.interrupted',
            });
            active.handle.kill();
        }
    }

    private async finalizeActive(
        active: ActiveRun,
        outcome: {
            status: 'succeeded' | 'failed' | 'cancelled' | 'waiting_approval' | 'interrupted';
            error?: string;
            eventType?: string;
            eventData?: Record<string, unknown>;
            runStatus?: WorkflowRunInfo['status'];
        },
    ): Promise<void> {
        if (active.finalized) return;
        active.finalized = true;
        this.clearTimers(active);
        this.releaseRunPermits(active);
        active.offMessage?.();
        active.offExit?.();
        if (!active.resultReceived) {
            active.resultReceived = true;
            const status = outcome.runStatus || outcome.status;
            await active.session.patch({
                status,
                finishedAt: Date.now(),
                currentTask: undefined,
                approval: undefined,
                error: outcome.error ? String(sanitizeForStore(outcome.error, 4000)) : undefined,
                worker: outcome.status === 'interrupted'
                    ? active.session.snapshot.worker
                    : undefined,
            });
            if (outcome.eventType) {
                await active.session.emit(outcome.eventType, {
                    ...(outcome.eventData || {}),
                    error: outcome.error ? String(sanitizeForStore(outcome.error, 4000)) : undefined,
                });
            }
        }
        try {
            active.terminating = true;
            active.handle?.postMessage({ type: 'run.ack', runId: active.runId });
        } catch {
            // ignore
        }
        try {
            active.handle?.kill();
        } catch {
            // ignore
        }

        active.readyResolver?.(false);
        active.item.waitResolver?.({ ...active.session.snapshot });
        active.item.waitResolver = undefined;
        if (active.item.waitTimer) {
            clearTimeout(active.item.waitTimer);
            active.item.waitTimer = undefined;
        }
        this.active.delete(active.runId);
        this.sessions.delete(active.runId);
        void new WorkflowRunStore(active.root).prune(this.maxStoredRuns).catch((error) => {
            console.warn('[WorkflowEngine] Failed to prune workflow runs:', error);
        });
        this.pump();
    }

    private clearTimers(active: ActiveRun): void {
        if (active.durationTimer) {
            clearTimeout(active.durationTimer);
            active.durationTimer = undefined;
        }
        if (active.cancelTimer) {
            clearTimeout(active.cancelTimer);
            active.cancelTimer = undefined;
        }
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
}
