import { config as globalConfig } from '@/config/index.js';
import {
    AbstractWorkflowEngine,
    type WorkflowActiveRun,
    type WorkflowEngineLimits,
    type WorkflowQueuedRun,
} from '@/workflow/AbstractWorkflowEngine.js';
import { clampTimerDelay } from '@/workflow/engineUtils.js';
import { ProviderRequestRateLimiter } from '@/workflow/providerRateLimiter.js';
import { WorkflowRunSession } from '@/workflow/WorkflowRunSession.js';
import { WorkflowRunStore, sanitizeForStore } from '@/workflow/WorkflowRunStore.js';
import type { WorkflowRunInfo, WorkflowWorkerStats } from '@/workflow/types.js';
import type {
    WorkerToMainMessage,
    WorkflowWorkerHandle,
    WorkflowWorkerPermitMessage,
    WorkflowWorkerPermitReleaseMessage,
    WorkflowWorkerRateRequestMessage,
    WorkflowWorkerRateCancelMessage,
    WorkflowWorkerSpawner,
    WorkflowWorkerResultMessage,
} from '@/workflow/workerProtocol.js';
import { WORKFLOW_WORKER_PROTOCOL_VERSION } from '@/workflow/workerProtocol.js';

export interface ProcessWorkerWorkflowEngineOptions extends WorkflowEngineLimits {
    spawner: WorkflowWorkerSpawner;
    agentConcurrencyPerProvider?: number;
    agentRequestsPerMinute?: number;
    agentRequestBurst?: number;
    heartbeatIntervalMs?: number;
    heartbeatTimeoutMs?: number;
    workerReadyTimeoutMs?: number;
    cancelGraceMs?: number;
    workerHeapMB?: number;
    env?: NodeJS.ProcessEnv;
}

type QueuedRun = WorkflowQueuedRun;

interface ActiveRun extends WorkflowActiveRun {
    item: QueuedRun;
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
    finalizePromise?: Promise<void>;
    ready: boolean;
    readyResolver?: (ok: boolean) => void;
    initError?: string;
    heldPermits: Map<string, string>;
    rateRequests: Map<string, AbortController>;
    durationTimer?: ReturnType<typeof setTimeout>;
    cancelTimer?: ReturnType<typeof setTimeout>;
}

interface PermitWaiter {
    active: ActiveRun;
    requestId: string;
    key: string;
}

interface FinalizeOutcome {
    status: 'succeeded' | 'failed' | 'cancelled' | 'waiting_approval' | 'interrupted';
    error?: string;
    eventType?: string;
    eventData?: Record<string, unknown>;
    runStatus?: WorkflowRunInfo['status'];
}

/**
 * Phase 1.5 执行引擎：主进程调度 + Electron utilityProcess Worker 池。
 *
 * - 一个 run 独占一个 Worker（worker-per-run），多个 run 可并行
 * - 主进程是 run.json/events.jsonl 的唯一写者；Worker 只上报状态/事件
 * - Worker 崩溃/心跳超时 → interrupted，可从最后一个顶层 checkpoint 恢复
 * - 审批暂停后 Worker 退出释放槽位，恢复时启动新 Worker
 *
 * 队列/准入/恢复/取消编排复用 AbstractWorkflowEngine，本类只负责 Worker 生命周期。
 */
export class ProcessWorkerWorkflowEngine extends AbstractWorkflowEngine<ActiveRun> {
    private readonly spawner: WorkflowWorkerSpawner;
    private readonly agentConcurrencyPerProvider: number;
    private readonly rateLimiter: ProviderRequestRateLimiter;
    private readonly requestRateEnabled: boolean;
    private readonly heartbeatIntervalMs: number;
    private readonly heartbeatTimeoutMs: number;
    private readonly workerReadyTimeoutMs: number;
    private readonly cancelGraceMs: number;
    private readonly workerHeapMB: number;
    private readonly env: NodeJS.ProcessEnv;

    private readonly permitActive = new Map<string, number>();
    private readonly permitWaiters = new Map<string, PermitWaiter[]>();
    private readonly monitorTimer: ReturnType<typeof setInterval>;
    private workerSeq = 0;

    constructor(options: ProcessWorkerWorkflowEngineOptions) {
        super(options ?? {});
        if (!options?.spawner) {
            throw new Error('ProcessWorkerWorkflowEngine requires a spawner');
        }
        this.spawner = options.spawner;
        this.agentConcurrencyPerProvider = Math.max(
            1,
            options.agentConcurrencyPerProvider ?? globalConfig.workflow.agentConcurrencyPerProvider,
        );
        const requestsPerMinute = options.agentRequestsPerMinute ?? globalConfig.workflow.agentRequestsPerMinute;
        this.rateLimiter = new ProviderRequestRateLimiter(
            requestsPerMinute,
            options.agentRequestBurst ?? globalConfig.workflow.agentRequestBurst,
        );
        this.requestRateEnabled = requestsPerMinute > 0;
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

    // ── AbstractWorkflowEngine 钩子 ──────────────────────────

    protected describeWorkers(): WorkflowWorkerStats[] {
        return Array.from(this.active.values()).map((item) => {
            const metrics = item.handle?.getMetrics?.();
            return {
                workerId: item.item.snapshot.worker?.workerId || item.handle?.workerId || 'pending',
                pid: item.handle?.pid,
                runId: item.runId,
                memMB: metrics?.memMB ?? item.memMB,
                cpu: metrics?.cpu ?? item.cpu,
            };
        });
    }

    protected async stopRunningWork(): Promise<void> {
        clearInterval(this.monitorTimer);
        const running = Array.from(this.active.values());
        await Promise.all(running.map(async (item) => {
            if (item.finalized) {
                await item.finalizePromise;
                return;
            }
            item.terminating = true;
            this.clearTimers(item);
            item.offMessage?.();
            item.offExit?.();
            try {
                item.handle?.postMessage({
                    type: 'run.cancel',
                    runId: item.runId,
                    reason: '引擎关闭',
                });
            } catch {
                // Worker 可能已退出
            }
            await item.messageChain;
            await this.finalizeActive(item, {
                status: 'interrupted',
                error: '引擎关闭，运行被中断',
                eventType: 'run.interrupted',
            });
        }));
    }

    protected async afterShutdown(): Promise<void> {
        this.rateLimiter.shutdown();
        try {
            await this.spawner.shutdown?.();
        } catch (error) {
            console.warn('[WorkflowEngine] Failed to shutdown worker spawner:', error);
        }
    }

    protected async awaitActivePause(active: ActiveRun): Promise<void> {
        // Worker 审批暂停后会在消息链尾完成落库，等链尾即可看到最新快照
        await active.messageChain;
    }

    protected async cancelActiveRun(active: ActiveRun): Promise<boolean> {
        if (active.resultReceived || active.finalized) {
            await active.messageChain;
            await active.finalizePromise;
            return false;
        }
        this.requestCancel(active, 'user');
        return true;
    }

    protected async onStartItemFailed(item: QueuedRun, error: unknown): Promise<void> {
        const active = this.active.get(item.snapshot.runId);
        if (!active) {
            console.error(`[WorkflowEngine] Failed to start ${item.snapshot.runId}:`, error);
            return;
        }
        await this.finalizeActive(active, {
            status: 'interrupted',
            error: `工作流启动失败: ${error instanceof Error ? error.message : String(error)}`,
            eventType: 'run.interrupted',
        });
    }

    protected async startItem(item: QueuedRun): Promise<void> {
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
            rateRequests: new Map(),
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
        }, clampTimerDelay(this.maxRunDurationMs));

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
                    requestRateEnabled: this.requestRateEnabled,
                    maxTokens: this.maxTokens,
                },
                definition: {
                    summary: item.definition.summary,
                    steps: item.definition.steps,
                },
                inputs: item.request.inputs || {},
                steps: snapshot.steps,
                usage: snapshot.usage,
                startIndex: item.startIndex,
                initialContext: item.initialContext,
                replayCompletedPaths: snapshot.checkpoint?.replayFromStep
                    ? snapshot.checkpoint.completedPaths
                    : undefined,
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
            .catch(async (error: unknown) => {
                console.error(`[WorkflowEngine] Worker message handling failed for ${active.runId}:`, error);
                await this.finalizeActive(active, {
                    status: 'interrupted',
                    error: `工作流状态持久化失败: ${error instanceof Error ? error.message : String(error)}`,
                    eventType: 'run.interrupted',
                });
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
                        replayFromStep: message.checkpoint.replayFromStep,
                        resumeError: message.checkpoint.resumeError,
                        definitionHashes: message.checkpoint.definitionHashes,
                    },
                });
                return;
            case 'run.permit':
                this.handlePermitRequest(active, message);
                return;
            case 'run.permit.release':
                this.handlePermitRelease(active, message);
                return;
            case 'run.rate':
                this.handleRateRequest(active, message);
                return;
            case 'run.rate.cancel':
                this.handleRateCancel(active, message);
                return;
            case 'run.result':
                await this.handleResult(active, message);
                return;
            default:
                return;
        }
    }

    private handleRateRequest(active: ActiveRun, message: WorkflowWorkerRateRequestMessage): void {
        if (active.finalized || active.terminating || active.cancelRequested
            || active.rateRequests.has(message.requestId)) return;
        const controller = new AbortController();
        active.rateRequests.set(message.requestId, controller);
        const key = `${message.provider.toLowerCase()}:${message.model}`;
        void this.rateLimiter.acquire(key, controller.signal).then(() => {
            active.rateRequests.delete(message.requestId);
            if (!active.finalized && !active.terminating && !active.cancelRequested && !controller.signal.aborted) {
                active.handle?.postMessage({ type: 'run.rate.granted', requestId: message.requestId });
            }
        }).catch(async (error: unknown) => {
            active.rateRequests.delete(message.requestId);
            if (controller.signal.aborted || active.finalized) return;
            console.error(`[WorkflowEngine] Failed to grant rate request for ${active.runId}:`, error);
            await this.finalizeActive(active, {
                status: 'interrupted',
                error: `模型请求限速失败: ${error instanceof Error ? error.message : String(error)}`,
                eventType: 'run.interrupted',
            });
        });
    }

    private handleRateCancel(active: ActiveRun, message: WorkflowWorkerRateCancelMessage): void {
        const controller = active.rateRequests.get(message.requestId);
        active.rateRequests.delete(message.requestId);
        controller?.abort();
    }

    private handlePermitRequest(active: ActiveRun, message: WorkflowWorkerPermitMessage): void {
        if (active.finalized || !active.handle) return;
        if (active.heldPermits.has(message.requestId)) return;
        if (Array.from(this.permitWaiters.values()).some((waiters) =>
            waiters.some((waiter) => waiter.active === active && waiter.requestId === message.requestId))) return;
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
            const index = waiters.findIndex((waiter) =>
                waiter.active === active && waiter.requestId === message.requestId);
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
            if (waiter.active.finalized || waiter.active.cancelRequested || waiter.active.terminating
                || waiter.active.resultReceived || !this.active.has(waiter.active.runId)) continue;
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
        if (active.cancelRequested && !active.timedOut) {
            status = 'cancelled';
            error = 'Workflow cancelled by user';
        }
        if (active.timedOut && status !== 'waiting_approval') {
            // 审批已就绪时保留等待态，避免超时覆盖掉可恢复的 checkpoint
            status = 'failed';
            error = `Workflow 运行超过最大时长 ${this.maxRunDurationMs}ms`;
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
                            replayFromStep: message.checkpoint.replayFromStep,
                            resumeError: message.checkpoint.resumeError,
                            definitionHashes: message.checkpoint.definitionHashes,
                        }
                        : active.session.snapshot.checkpoint,
                    finishedAt: undefined,
                    error: undefined,
                });
                await active.session.emit('run.waiting_approval', {
                    path: approval?.stepPath,
                    message: approval?.message,
                    risk: approval?.risk,
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
                            replayFromStep: message.checkpoint.replayFromStep,
                            resumeError: message.checkpoint.resumeError,
                            definitionHashes: message.checkpoint.definitionHashes,
                        }
                        : active.session.snapshot.checkpoint,
                });
                await active.session.emit('run.failed', { error: safeError || 'Workflow failed' });
            }
        } catch (handlingError) {
            console.error(`[WorkflowEngine] Failed to finalize worker result for ${active.runId}:`, handlingError);
            active.resultReceived = false;
            await this.finalizeActive(active, {
                status: 'interrupted',
                error: '工作流结果持久化失败，请检查存储',
                eventType: 'run.interrupted',
            });
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
            await this.finalizeActive(active, {
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
        await this.finalizeActive(active, {
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

    private finalizeActive(active: ActiveRun, outcome: FinalizeOutcome): Promise<void> {
        if (active.finalizePromise) return active.finalizePromise;
        active.finalized = true;
        active.finalizePromise = Promise.resolve().then(() => this.finalizeActiveOnce(active, outcome));
        return active.finalizePromise;
    }

    private async finalizeActiveOnce(active: ActiveRun, outcome: FinalizeOutcome): Promise<void> {
        this.clearTimers(active);
        this.releaseRunPermits(active);
        for (const controller of active.rateRequests.values()) controller.abort();
        active.rateRequests.clear();
        active.offMessage?.();
        active.offExit?.();
        try {
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
        } catch (error) {
            active.session.snapshot.status = 'interrupted';
            active.session.snapshot.error = '工作流状态持久化失败，请检查存储';
            console.error(`[WorkflowEngine] Failed to persist interrupted run ${active.runId}:`, error);
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
        if (active.session.snapshot.status !== 'waiting_approval'
            && active.session.snapshot.status !== 'interrupted') {
            this.volatileInputs.delete(active.runId);
        }
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
}
