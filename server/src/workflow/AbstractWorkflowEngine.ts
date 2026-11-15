import { config as globalConfig } from '@/config/index.js';
import { AsyncKeyedLock } from '@/workflow/AsyncKeyedLock.js';
import {
    areResumeInputsCompatible,
    buildInitialSteps,
    clampTimerDelay,
    isReplayValuePreserved,
    prepareWorkflowInputs,
    resolveApprovalDecision,
    samePath,
    workflowDefinitionHash,
} from '@/workflow/engineUtils.js';
import { WorkflowQueueAdmission } from '@/workflow/WorkflowQueueAdmission.js';
import { getResumeDefinitionError } from '@/workflow/WorkflowResume.js';
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
    type WorkflowWorkerStats,
} from '@/workflow/types.js';

/** 排队中的 run；引擎实现可在派生接口上追加自有字段。 */
export interface WorkflowQueuedRun {
    request: WorkflowRunRequest;
    definition: WorkflowDefinition;
    snapshot: WorkflowRunInfo;
    session: WorkflowRunSession;
    concurrencyKey: string;
    startIndex?: number;
    initialContext?: Record<string, unknown>;
    waitResolver?: (run: WorkflowRunInfo) => void;
    waitTimer?: ReturnType<typeof setTimeout>;
    ready?: boolean;
}

/** 运行中的 run 的公共视图；派生实现自有字段（Worker 句柄、AbortController 等）。 */
export interface WorkflowActiveRun {
    readonly runId: string;
    readonly userId: string;
    readonly root: string;
    readonly workflowName: string;
    readonly concurrencyKey: string;
    readonly session: WorkflowRunSession;
}

/** 队列/并发/预算限额，两个引擎的构造参数子集。 */
export interface WorkflowEngineLimits {
    maxWorkers?: number;
    maxQueueSize?: number;
    maxConcurrentRunsPerWorkflow?: number;
    maxRunDurationMs?: number;
    maxStoredRuns?: number;
    maxTokens?: number;
}

export function concurrencyKeyFor(request: WorkflowRunRequest, workflowName: string): string {
    const group = request.concurrencyGroup?.trim();
    return group ? `group:${group}` : `workflow:${workflowName}`;
}

export function terminalStatus(status: WorkflowRunInfo['status']): boolean {
    return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status);
}

/**
 * 工作流引擎骨架：承载队列、准入、串行化锁、持久化恢复与取消编排。
 *
 * 具体执行方式（主进程内执行 vs Worker 子进程）由子类通过以下钩子决定：
 * - `startItem`：实际启动一次运行
 * - `onStartItemFailed`：启动失败后的收尾
 * - `cancelActiveRun`：取消正在运行的 run
 * - `awaitActivePause`：等待审批中的 run 让出控制权
 * - `describeWorkers`：运行时统计
 * - `stopRunningWork` / `afterShutdown`：关停
 */
export abstract class AbstractWorkflowEngine<TActive extends WorkflowActiveRun>
implements WorkflowEngine {
    protected eventBus: WorkflowEventBus = NULL_WORKFLOW_EVENT_BUS;
    protected readonly maxWorkers: number;
    protected readonly maxQueueSize: number;
    protected readonly maxConcurrentRunsPerWorkflow: number;
    protected readonly maxRunDurationMs: number;
    protected readonly maxStoredRuns: number;
    protected readonly maxTokens: number;
    protected readonly admission: WorkflowQueueAdmission;

    protected readonly queue: WorkflowQueuedRun[] = [];
    protected readonly active = new Map<string, TActive>();
    protected readonly sessions = new Map<string, WorkflowRunSession>();
    protected readonly volatileInputs = new Map<string, Record<string, unknown>>();
    protected closed = false;

    private readonly reconciledRoots = new Set<string>();
    private readonly reconcilingRoots = new Map<string, Promise<void>>();
    private readonly mutations = new AsyncKeyedLock();

    protected constructor(options: WorkflowEngineLimits = {}) {
        this.maxWorkers = Math.max(1, options.maxWorkers ?? globalConfig.workflow.maxWorkers);
        this.maxQueueSize = Math.max(1, options.maxQueueSize ?? globalConfig.workflow.maxQueueSize);
        this.maxConcurrentRunsPerWorkflow = Math.max(
            1,
            options.maxConcurrentRunsPerWorkflow ?? globalConfig.workflow.maxConcurrentRunsPerWorkflow,
        );
        this.maxRunDurationMs = Math.max(1000, options.maxRunDurationMs ?? globalConfig.workflow.maxRunDurationMs);
        this.maxStoredRuns = Math.max(1, options.maxStoredRuns ?? globalConfig.workflow.maxStoredRuns);
        this.maxTokens = Math.max(0, options.maxTokens ?? globalConfig.workflow.maxTokens);
        this.admission = new WorkflowQueueAdmission(this.maxQueueSize, () => this.queue.length);
    }

    // ── 子类钩子 ──────────────────────────────────────────────

    /** 启动一次运行；实现负责把 active 注册进 `this.active`。 */
    protected abstract startItem(item: WorkflowQueuedRun): Promise<void>;

    /** `startItem` 抛错后的收尾（落库 + settleWait + pump 由实现决定）。 */
    protected abstract onStartItemFailed(item: WorkflowQueuedRun, error: unknown): Promise<void>;

    /** 取消运行中的 run；返回 true 表示已就地完成取消、无需回退到存储层。 */
    protected abstract cancelActiveRun(active: TActive): Promise<boolean>;

    /** 等待审批中的 run 让出控制权后再读取持久化快照。 */
    protected abstract awaitActivePause(active: TActive): Promise<void>;

    protected abstract describeWorkers(): WorkflowWorkerStats[];

    /** 关停仍存活的运行（由 `shutdown` 调用）。 */
    protected abstract stopRunningWork(): Promise<void>;

    /** 关停收尾（释放限流器等）。 */
    protected abstract afterShutdown(): void | Promise<void>;

    // ── 公共生命周期 ──────────────────────────────────────────

    public setEventBus(bus: WorkflowEventBus): void {
        this.eventBus = bus || NULL_WORKFLOW_EVENT_BUS;
    }

    public async startRun(request: WorkflowRunRequest): Promise<WorkflowRunStartResult> {
        if (this.closed) {
            return { ok: false, error: 'WORKFLOW_ENGINE_CLOSED' };
        }
        const releaseAdmission = this.admission.reserve();
        if (!releaseAdmission) {
            return { ok: false, error: 'WORKFLOW_QUEUE_FULL' };
        }
        try {
            return await this.startAdmittedRun(request, releaseAdmission);
        } finally {
            releaseAdmission();
        }
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
        return this.mutations.run(request.runId, () => this.cancelRunLocked(request));
    }

    public async resumeRun(request: WorkflowRunResumeRequest): Promise<boolean> {
        return this.mutations.run(request.runId, async () => {
            if (resolveApprovalDecision(request.decision) === false) return this.resumeStoredRun(request);
            const releaseAdmission = this.admission.reserve();
            if (!releaseAdmission) return false;
            try {
                return await this.resumeStoredRun(request, releaseAdmission);
            } finally {
                releaseAdmission();
            }
        });
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
            workers: this.describeWorkers(),
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

        await this.stopRunningWork();
        this.volatileInputs.clear();
        await this.afterShutdown();
    }

    /** 首次访问某个工作区时，把上次进程遗留的 running 标记为 interrupted，并重新入队 queued。 */
    public async reconcile(root: string): Promise<void> {
        if (this.reconciledRoots.has(root)) return;
        const pending = this.reconcilingRoots.get(root);
        if (pending) return pending;
        const operation = this.reconcileRoot(root);
        this.reconcilingRoots.set(root, operation);
        try {
            await operation;
            this.reconciledRoots.add(root);
        } finally {
            this.reconcilingRoots.delete(root);
        }
    }

    // ── 内部实现 ──────────────────────────────────────────────

    protected createSession(store: WorkflowRunStore, run: WorkflowRunInfo): WorkflowRunSession {
        return new WorkflowRunSession(
            store,
            run,
            (event) => this.eventBus.publish(event),
            globalConfig.workflow.maxStepOutputChars,
        );
    }

    protected pruneSnapshots(root: string): void {
        void new WorkflowRunStore(root).prune(this.maxStoredRuns).catch((error) => {
            console.warn('[WorkflowEngine] Failed to prune workflow runs:', error);
        });
    }

    protected settleWait(item: WorkflowQueuedRun): void {
        const resolve = item.waitResolver;
        item.waitResolver = undefined;
        if (item.waitTimer) {
            clearTimeout(item.waitTimer);
            item.waitTimer = undefined;
        }
        resolve?.({ ...item.snapshot });
    }

    protected async markCancelled(session: WorkflowRunSession, reason: string): Promise<void> {
        await session.patch({
            status: 'cancelled',
            finishedAt: Date.now(),
            currentTask: undefined,
            approval: undefined,
            error: reason,
        });
        await session.emit('run.cancelled', { reason });
    }

    private async startAdmittedRun(
        request: WorkflowRunRequest,
        releaseAdmission: () => void,
    ): Promise<WorkflowRunStartResult> {
        await this.reconcile(request.root);
        if (this.closed) return { ok: false, error: 'WORKFLOW_ENGINE_CLOSED' };
        if (this.queue.length >= this.maxQueueSize) return { ok: false, error: 'WORKFLOW_QUEUE_FULL' };
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
        const storedInputs = sanitizeForStore(inputs, globalConfig.workflow.maxStepOutputChars) as Record<string, unknown>;
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
            workflowDefinitionHash: workflowDefinitionHash(definition.yaml),
            userId: request.userId,
            root: request.root,
            status: 'queued',
            inputs: storedInputs,
            resumeInputsRequired: !isReplayValuePreserved(inputs, storedInputs),
            trigger: request.trigger,
            execution: {
                provider: request.provider,
                model: request.model,
                reasoningEffort: request.reasoningEffort,
                locale: request.locale,
                concurrencyGroup: request.concurrencyGroup,
            },
            createdAt: Date.now(),
            steps: buildInitialSteps(definition.steps),
            lastSeq: 0,
        };

        await store.create(snapshot);
        if (this.closed) {
            snapshot.status = 'interrupted';
            snapshot.finishedAt = Date.now();
            snapshot.error = '引擎已关闭，无法启动工作流';
            await store.save(snapshot);
            return { ok: false, error: 'WORKFLOW_ENGINE_CLOSED' };
        }
        if (snapshot.resumeInputsRequired) {
            this.volatileInputs.set(runId, structuredClone(inputs));
        }
        const session = this.createSession(store, snapshot);
        this.sessions.set(runId, session);

        const item: WorkflowQueuedRun = {
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
            }, clampTimerDelay(timeoutMs));
        }

        await this.enqueue(item, 'run.queued', {
            workflow: definition.summary.name,
            position: this.queue.length,
            trigger: snapshot.trigger,
        }, releaseAdmission);

        if (waitPromise) {
            const run = await waitPromise;
            return { ok: true, runId, status: run.status, run };
        }
        return {
            ok: true,
            runId,
            status: snapshot.status,
            position: Math.max(0, this.queue.findIndex((entry) => entry.snapshot.runId === runId)),
        };
    }

    private async cancelRunLocked(request: WorkflowRunCancelRequest): Promise<boolean> {
        const queuedIndex = this.queue.findIndex((item) => item.snapshot.runId === request.runId);
        if (queuedIndex >= 0) {
            const [item] = this.queue.splice(queuedIndex, 1);
            if (item.snapshot.userId !== request.userId || !samePath(item.snapshot.root, request.root)) {
                this.queue.splice(queuedIndex, 0, item);
                return false;
            }
            this.sessions.delete(request.runId);
            this.volatileInputs.delete(request.runId);
            await this.markCancelled(item.session, '运行在排队阶段被取消');
            this.settleWait(item);
            return true;
        }

        const active = this.active.get(request.runId);
        if (active) {
            if (active.userId !== request.userId || !samePath(active.root, request.root)) return false;
            if (await this.cancelActiveRun(active)) return true;
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
        this.volatileInputs.delete(request.runId);
        await store.save(run);
        await this.createSession(store, run).emit('run.cancelled', { reason: 'user' });
        return true;
    }

    private async resumeStoredRun(
        request: WorkflowRunResumeRequest,
        releaseAdmission?: () => void,
    ): Promise<boolean> {
        if (this.closed) return false;
        const active = this.active.get(request.runId);
        if (active?.session.snapshot.status === 'waiting_approval') {
            await this.awaitActivePause(active);
        }
        const store = new WorkflowRunStore(request.root);
        const run = await store.read(request.runId);
        if (!run || run.userId !== request.userId || !samePath(run.root, request.root)) return false;
        if (run.status !== 'waiting_approval' && run.status !== 'interrupted') return false;

        const previousStatus = run.status;
        const decision = resolveApprovalDecision(request.decision);
        if (previousStatus === 'waiting_approval' && decision === undefined) return false;
        if (previousStatus === 'waiting_approval' && decision && run.checkpoint?.resumeError) {
            run.error = run.checkpoint.resumeError;
            await store.save(run);
            return false;
        }

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
            this.volatileInputs.delete(request.runId);
            await store.save(run);
            await this.createSession(store, run).emit('run.cancelled', { reason: 'approval_rejected' });
            return true;
        }

        const suppliedInputs = request.inputs ?? this.volatileInputs.get(run.runId);
        if (run.resumeInputsRequired && !suppliedInputs) {
            run.error = '运行输入已脱敏，恢复前请重新提供原始输入';
            await store.save(run);
            return false;
        }

        const definition = await new WorkflowRegistry(request.root).loadDefinition(run.workflowPath || run.workflow.name);
        if (!definition || !definition.validation.ok) {
            run.error = '工作流定义在恢复时已不可用或校验失败';
            await store.save(run);
            return false;
        }
        const definitionError = await getResumeDefinitionError(request.root, run, definition);
        if (definitionError) {
            run.error = definitionError;
            await store.save(run);
            return false;
        }
        const prepared = prepareWorkflowInputs(definition, suppliedInputs ?? run.inputs);
        if (!prepared.ok) {
            run.error = prepared.error;
            await store.save(run);
            return false;
        }
        if (request.inputs && !areResumeInputsCompatible(
            prepared.inputs,
            run.inputs,
            this.volatileInputs.get(run.runId),
            globalConfig.workflow.maxStepOutputChars,
        )) {
            run.error = '恢复输入与原始运行输入不一致';
            await store.save(run);
            return false;
        }
        run.inputs = sanitizeForStore(prepared.inputs, globalConfig.workflow.maxStepOutputChars) as Record<string, unknown>;
        run.resumeInputsRequired = !isReplayValuePreserved(prepared.inputs, run.inputs);
        if (run.resumeInputsRequired) this.volatileInputs.set(run.runId, structuredClone(prepared.inputs));
        else this.volatileInputs.delete(run.runId);

        if (approvalStep) {
            approvalStep.status = 'succeeded';
            approvalStep.finishedAt = Date.now();
            approvalStep.output = { approved: true, decision: request.decision };
            approvalStep.outputPreview = 'approved';
            if (run.checkpoint?.replayFromStep
                && !run.checkpoint.completedPaths.includes(approvalStep.path)) {
                run.checkpoint.completedPaths.push(approvalStep.path);
            }
        }
        run.status = 'queued';
        run.finishedAt = undefined;
        run.approval = undefined;
        run.currentTask = undefined;
        run.worker = undefined;
        run.error = undefined;
        await store.save(run);

        const session = this.createSession(store, run);
        this.sessions.set(run.runId, session);
        const item: WorkflowQueuedRun = {
            request: {
                userId: run.userId,
                root: run.root,
                name: run.workflow.name,
                path: run.workflowPath || run.workflow.path,
                ...run.execution,
                inputs: prepared.inputs,
            },
            definition,
            snapshot: run,
            session,
            concurrencyKey: concurrencyKeyFor(
                { ...run.execution, userId: run.userId, root: run.root, name: run.workflow.name },
                run.workflow.name,
            ),
            startIndex: run.checkpoint?.nextStepIndex ?? 0,
            initialContext: run.checkpoint?.context,
        };
        await this.enqueue(item, 'run.resumed', { decision: request.decision, previousStatus }, releaseAdmission);
        return true;
    }

    private async reconcileRoot(root: string): Promise<void> {
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
                await this.createSession(store, run).emit('run.interrupted', { error: run.error });
                continue;
            }

            if (run.status !== 'queued') continue;
            if (this.active.has(run.runId) || this.queue.some((item) => item.snapshot.runId === run.runId)) continue;
            if (run.resumeInputsRequired && !this.volatileInputs.has(run.runId)) {
                run.status = 'interrupted';
                run.finishedAt = Date.now();
                run.error = '运行输入已脱敏，恢复前请重新提供原始输入';
                await store.save(run);
                await this.createSession(store, run).emit('run.interrupted', { error: run.error });
                continue;
            }

            const definition = await new WorkflowRegistry(root).loadDefinition(run.workflowPath || run.workflow.name);
            if (!definition || !definition.validation.ok) {
                run.status = 'failed';
                run.finishedAt = Date.now();
                run.error = '重新入队失败：工作流定义不可用或校验失败';
                await store.save(run);
                continue;
            }

            const session = this.createSession(store, run);
            const item: WorkflowQueuedRun = {
                request: {
                    userId: run.userId,
                    root: run.root,
                    name: run.workflow.name,
                    path: run.workflowPath || run.workflow.path,
                    ...run.execution,
                    inputs: this.volatileInputs.get(run.runId) ?? run.inputs,
                },
                definition,
                snapshot: run,
                session,
                concurrencyKey: concurrencyKeyFor(
                    { ...run.execution, userId: run.userId, root: run.root, name: run.workflow.name },
                    run.workflow.name,
                ),
                startIndex: run.checkpoint?.nextStepIndex ?? 0,
                initialContext: run.checkpoint?.context,
            };
            await this.enqueue(item, 'run.requeued', {});
        }
        this.pump();
    }

    protected pump(): void {
        if (this.closed) return;
        while (this.active.size < this.maxWorkers) {
            const index = this.queue.findIndex((item) => {
                if (item.ready === false) return false;
                const runningForKey = Array.from(this.active.values())
                    .filter((active) => active.concurrencyKey === item.concurrencyKey)
                    .length;
                return runningForKey < this.maxConcurrentRunsPerWorkflow;
            });
            if (index < 0) return;
            const [item] = this.queue.splice(index, 1);
            void this.startItem(item).catch(async (error: unknown) => {
                try {
                    await this.onStartItemFailed(item, error);
                } catch (failureError) {
                    console.error(
                        `[WorkflowEngine] Failed to record start failure for ${item.snapshot.runId}:`,
                        failureError,
                    );
                }
            });
        }
    }

    private async enqueue(
        item: WorkflowQueuedRun,
        eventType: string,
        data: Record<string, unknown>,
        releaseAdmission?: () => void,
    ): Promise<void> {
        item.ready = false;
        this.sessions.set(item.snapshot.runId, item.session);
        this.queue.push(item);
        releaseAdmission?.();
        try {
            await item.session.emit(eventType, data);
        } catch (error) {
            const index = this.queue.indexOf(item);
            if (index >= 0) {
                this.queue.splice(index, 1);
                this.sessions.delete(item.snapshot.runId);
                try {
                    await item.session.patch({
                        status: 'interrupted',
                        finishedAt: Date.now(),
                        error: `工作流入队持久化失败: ${error instanceof Error ? error.message : String(error)}`,
                    });
                } catch (persistError) {
                    console.error(`[WorkflowEngine] Failed to persist interrupted run ${item.snapshot.runId}:`, persistError);
                }
                this.settleWait(item);
                this.pump();
            }
            throw error;
        }
        if (this.queue.includes(item)) {
            item.ready = true;
            this.pump();
        }
    }
}
