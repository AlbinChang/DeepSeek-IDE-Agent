import { config as globalConfig } from '@/config/index.js';
import type { AgentService } from '@/services/AgentService.js';
import {
    AbstractWorkflowEngine,
    type WorkflowActiveRun,
    type WorkflowEngineLimits,
    type WorkflowQueuedRun,
} from '@/workflow/AbstractWorkflowEngine.js';
import {
    WorkflowApprovalPause,
    WorkflowCancelledError,
    WorkflowPersistenceError,
    WorkflowTimeoutError,
} from '@/workflow/errors.js';
import { buildCheckpoint, clampTimerDelay } from '@/workflow/engineUtils.js';
import { ProviderConcurrencyLimiter } from '@/workflow/providerLimiter.js';
import { ProviderRequestRateLimiter } from '@/workflow/providerRateLimiter.js';
import { WorkflowRunner } from '@/workflow/WorkflowRunner.js';
import { WorkflowRunSession } from '@/workflow/WorkflowRunSession.js';
import {
    DefaultWorkflowStepExecutor,
    type WorkflowStepExecutor,
} from '@/workflow/WorkflowStepExecutor.js';
import type { WorkflowRunInfo, WorkflowWorkerStats } from '@/workflow/types.js';

export interface InProcessWorkflowEngineOptions extends WorkflowEngineLimits {
    agentService?: AgentService;
    executor?: WorkflowStepExecutor;
    agentConcurrencyPerProvider?: number;
    agentRequestsPerMinute?: number;
    agentRequestBurst?: number;
}

interface InProcessActiveRun extends WorkflowActiveRun {
    controller: AbortController;
    promise: Promise<void>;
}

/**
 * Phase 1 执行引擎：主进程内调度，多 run 并行（受 maxWorkers 限制）。
 * 端口与 ProcessWorkerWorkflowEngine 完全一致，后续切换 Worker 不需要改 IPC/工具。
 */
export class InProcessWorkflowEngine extends AbstractWorkflowEngine<InProcessActiveRun> {
    private readonly executor: WorkflowStepExecutor;
    private readonly limiter: ProviderConcurrencyLimiter;
    private readonly rateLimiter: ProviderRequestRateLimiter;

    constructor(options: InProcessWorkflowEngineOptions = {}) {
        super(options);
        this.limiter = new ProviderConcurrencyLimiter(
            Math.max(1, options.agentConcurrencyPerProvider ?? globalConfig.workflow.agentConcurrencyPerProvider),
        );
        this.rateLimiter = new ProviderRequestRateLimiter(
            options.agentRequestsPerMinute ?? globalConfig.workflow.agentRequestsPerMinute,
            options.agentRequestBurst ?? globalConfig.workflow.agentRequestBurst,
        );
        this.executor = options.executor || new DefaultWorkflowStepExecutor({
            agentService: options.agentService,
            acquirePermit: (kind, provider, model, signal) => this.limiter.acquire(
                `${(provider || 'default').toLowerCase()}:${model || 'default'}`,
                signal,
            ),
            acquireRequestToken: (provider, model, signal) => this.rateLimiter.acquire(
                `${provider.toLowerCase()}:${model}`,
                signal,
            ),
        });
    }

    protected describeWorkers(): WorkflowWorkerStats[] {
        return Array.from(this.active.values()).map((item) => ({
            workerId: 'in-process',
            pid: process.pid,
            runId: item.runId,
        }));
    }

    protected async stopRunningWork(): Promise<void> {
        const activations = Array.from(this.active.values());
        for (const item of activations) {
            item.controller.abort(new WorkflowCancelledError('引擎关闭'));
        }
        await Promise.allSettled(activations.map((item) => item.promise));
    }

    protected afterShutdown(): void {
        this.limiter.shutdown('引擎关闭');
        this.rateLimiter.shutdown();
    }

    protected async awaitActivePause(active: InProcessActiveRun): Promise<void> {
        // 进程内 run 在审批暂停时仍持有 promise，直接等它落库完成
        await active.promise;
    }

    protected async cancelActiveRun(active: InProcessActiveRun): Promise<boolean> {
        if (active.session.snapshot.status === 'waiting_approval') {
            await active.promise;
            return false;
        }
        active.controller.abort(new WorkflowCancelledError('Workflow cancelled by user'));
        return true;
    }

    protected async onStartItemFailed(item: WorkflowQueuedRun, error: unknown): Promise<void> {
        console.error(`[WorkflowEngine] Failed to start ${item.snapshot.runId}:`, error);
        const active = this.active.get(item.snapshot.runId);
        active?.controller.abort(new WorkflowCancelledError('工作流启动失败'));
        this.active.delete(item.snapshot.runId);
        this.sessions.delete(item.snapshot.runId);
        try {
            await item.session.patch({
                status: 'interrupted',
                finishedAt: Date.now(),
                error: `工作流启动失败: ${error instanceof Error ? error.message : String(error)}`,
            });
        } catch (persistenceError) {
            console.error(`[WorkflowEngine] Failed to persist interrupted run ${item.snapshot.runId}:`, persistenceError);
        }
        this.settleWait(item);
        this.pump();
    }

    protected async startItem(item: WorkflowQueuedRun): Promise<void> {
        const { snapshot, session } = item;
        const controller = new AbortController();
        const active: InProcessActiveRun = {
            runId: snapshot.runId,
            userId: snapshot.userId,
            root: snapshot.root,
            workflowName: snapshot.workflow.name,
            concurrencyKey: item.concurrencyKey,
            session,
            controller,
            promise: Promise.resolve(),
        };
        this.active.set(snapshot.runId, active);
        this.sessions.set(snapshot.runId, session);

        snapshot.status = 'running';
        snapshot.startedAt = snapshot.startedAt || Date.now();
        snapshot.worker = { workerId: 'in-process', pid: process.pid };
        snapshot.position = undefined;

        const promise = (async () => {
            const durationTimer = setTimeout(() => {
                controller.abort(new WorkflowTimeoutError(
                    `Workflow 运行超过最大时长 ${this.maxRunDurationMs}ms`,
                ));
            }, clampTimerDelay(this.maxRunDurationMs));

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
                maxTokens: this.maxTokens,
                startIndex: item.startIndex,
                initialContext: item.initialContext,
                replayCompletedPaths: snapshot.checkpoint?.replayFromStep
                    ? snapshot.checkpoint.completedPaths
                    : undefined,
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
                await this.settleFailedRun(snapshot, session, runner, controller, error);
            } finally {
                clearTimeout(durationTimer);
                this.active.delete(snapshot.runId);
                this.sessions.delete(snapshot.runId);
                if (snapshot.status !== 'waiting_approval' && snapshot.status !== 'interrupted') {
                    this.volatileInputs.delete(snapshot.runId);
                }
                this.settleWait(item);
                this.pruneSnapshots(snapshot.root);
                this.pump();
            }
        })();

        active.promise = promise;
        await promise;
    }

    private async settleFailedRun(
        snapshot: WorkflowRunInfo,
        session: WorkflowRunSession,
        runner: WorkflowRunner,
        controller: AbortController,
        error: any,
    ): Promise<void> {
        try {
            if (error instanceof WorkflowApprovalPause && !controller.signal.aborted && !this.closed) {
                await session.patch({
                    status: 'waiting_approval',
                    approval: error.approval,
                    currentTask: error.approval.stepPath,
                    checkpoint: buildCheckpoint(
                        error.topLevelIndex + (error.replayFromStep ? 0 : 1),
                        error.resumeContext ?? runner.getContextValues(),
                        snapshot.steps,
                        globalConfig.workflow.maxStepOutputChars,
                        error.replayFromStep,
                        error.definitionHashes,
                    ),
                });
                await session.emit('run.waiting_approval', {
                    path: error.approval.stepPath,
                    message: error.approval.message,
                    risk: error.approval.risk,
                });
                return;
            }

            const reason = controller.signal.reason;
            const interrupted = this.closed || error instanceof WorkflowPersistenceError;
            const timedOut = reason instanceof WorkflowTimeoutError;
            const cancelled = !timedOut && !interrupted && (reason instanceof WorkflowCancelledError
                || controller.signal.aborted);
            const status = interrupted ? 'interrupted' : timedOut ? 'failed' : cancelled ? 'cancelled' : 'failed';
            const message = error instanceof WorkflowPersistenceError
                ? `工作流状态持久化失败: ${error.message}`
                : interrupted
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
            await session.emit(
                status === 'cancelled' ? 'run.cancelled' : status === 'interrupted' ? 'run.interrupted' : 'run.failed',
                { error: message },
            );
        } catch (persistenceError) {
            snapshot.status = 'interrupted';
            snapshot.error = '工作流状态持久化失败，请检查存储';
            console.error(`[WorkflowEngine] Failed to persist run ${snapshot.runId}:`, persistenceError);
        }
    }
}
