import { config as globalConfig } from '@/config/index.js';
import {
    WorkflowApprovalPause,
    WorkflowCancelledError,
    WorkflowTimeoutError,
} from '@/workflow/errors.js';
import { buildCheckpoint } from '@/workflow/engineUtils.js';
import { RemoteWorkflowRunSession } from '@/workflow/RemoteWorkflowRunSession.js';
import { WorkflowRunner } from '@/workflow/WorkflowRunner.js';
import {
    DefaultWorkflowStepExecutor,
    type WorkflowStepExecutor,
} from '@/workflow/WorkflowStepExecutor.js';
import type {
    MainToWorkerMessage,
    WorkerToMainMessage,
    WorkflowWorkerRunStartMessage,
} from '@/workflow/workerProtocol.js';
import {
    WORKFLOW_WORKER_PROTOCOL_VERSION,
} from '@/workflow/workerProtocol.js';

export interface WorkflowWorkerHostOptions {
    send: (message: WorkerToMainMessage) => void;
    executor?: WorkflowStepExecutor;
    workerId: string;
    pid?: number;
}

interface RunningWorkflow {
    runId: string;
    controller: AbortController;
    session: RemoteWorkflowRunSession;
    heartbeatTimer?: ReturnType<typeof setInterval>;
}

/**
 * Worker 侧运行时：只执行 WorkflowRunner，不启动 Fastify/UI。
 * 通过注入 send/executor 可在测试中直接驱动。
 */
export class WorkflowWorkerHost {
    private readonly send: (message: WorkerToMainMessage) => void;
    private readonly executor: WorkflowStepExecutor;
    private readonly workerId: string;
    private readonly pid: number;
    private running: RunningWorkflow | null = null;
    private initialized = false;

    constructor(options: WorkflowWorkerHostOptions) {
        this.send = options.send;
        this.executor = options.executor || new DefaultWorkflowStepExecutor();
        this.workerId = options.workerId;
        this.pid = options.pid ?? process.pid;
    }

    /** 通知主进程 Worker 已就绪；重复调用是幂等的。 */
    public announceReady(): void {
        this.send({
            type: 'worker.ready',
            workerId: this.workerId,
            pid: this.pid,
            protocolVersion: WORKFLOW_WORKER_PROTOCOL_VERSION,
        });
    }

    public handleMessage(message: MainToWorkerMessage): void {
        switch (message.type) {
            case 'worker.init':
                if (message.protocolVersion !== WORKFLOW_WORKER_PROTOCOL_VERSION) {
                    this.send({
                        type: 'worker.error',
                        workerId: this.workerId,
                        message: `Unsupported workflow worker protocol: ${String(message.protocolVersion)}`,
                    });
                    return;
                }
                this.initialized = true;
                this.announceReady();
                return;
            case 'run.start':
                void this.startRun(message);
                return;
            case 'run.cancel':
                this.cancelRun(message.runId, message.reason);
                return;
            case 'run.ack':
                return;
            case 'ping':
                this.send({ type: 'pong', seq: message.seq });
                return;
            default:
                return;
        }
    }

    private async startRun(message: WorkflowWorkerRunStartMessage): Promise<void> {
        if (this.running) {
            this.send({
                type: 'worker.error',
                workerId: this.workerId,
                message: `Worker ${this.workerId} is already running ${this.running.runId}`,
            });
            return;
        }
        if (!this.initialized) {
            this.send({
                type: 'worker.error',
                workerId: this.workerId,
                message: 'Worker received run.start before worker.init',
            });
            return;
        }

        const config = message.config;
        const controller = new AbortController();
        const session = new RemoteWorkflowRunSession({
            config,
            steps: message.steps,
            maxOutputChars: globalConfig.workflow.maxStepOutputChars,
            send: this.send,
        });
        const heartbeatMs = Math.max(500, config.heartbeatIntervalMs || globalConfig.workflow.heartbeatIntervalMs);

        const running: RunningWorkflow = {
            runId: config.runId,
            controller,
            session,
        };
        this.running = running;

        const emitHeartbeat = () => {
            if (this.running !== running) return;
            const memMB = Math.round(process.memoryUsage().rss / (1024 * 1024));
            this.send({
                type: 'run.heartbeat',
                runId: running.runId,
                memMB,
                currentTask: session.snapshot.currentTask,
            });
        };
        emitHeartbeat();
        running.heartbeatTimer = setInterval(emitHeartbeat, heartbeatMs);
        running.heartbeatTimer.unref?.();

        let lastCheckpointIndex = message.startIndex || 0;
        const runner = new WorkflowRunner({
            session,
            definition: message.definition,
            inputs: message.inputs,
            executor: this.executor,
            abortSignal: controller.signal,
            traceId: config.traceId,
            userId: config.userId,
            root: config.root,
            provider: config.provider,
            model: config.model,
            reasoningEffort: config.reasoningEffort,
            locale: config.locale,
            startIndex: message.startIndex,
            initialContext: message.initialContext,
            onCheckpoint: (checkpoint) => {
                lastCheckpointIndex = checkpoint.nextStepIndex;
                session.checkpoint(buildCheckpoint(
                    checkpoint.nextStepIndex,
                    checkpoint.context,
                    session.snapshot.steps,
                    globalConfig.workflow.maxStepOutputChars,
                ));
            },
        });
        try {
            await runner.run();
            if (controller.signal.aborted) {
                throw controller.signal.reason || new WorkflowCancelledError('Workflow cancelled');
            }
            this.send({
                type: 'run.result',
                runId: running.runId,
                status: 'succeeded',
                usage: session.snapshot.usage,
            });
        } catch (error: any) {
            if (error instanceof WorkflowApprovalPause) {
                this.send({
                    type: 'run.result',
                    runId: running.runId,
                    status: 'waiting_approval',
                    approval: error.approval,
                    checkpoint: buildCheckpoint(
                        error.topLevelIndex + 1,
                        runner.getContextValues(),
                        session.snapshot.steps,
                        globalConfig.workflow.maxStepOutputChars,
                    ),
                    usage: session.snapshot.usage,
                });
            } else {
                const reason = controller.signal.reason;
                const cancelled = error instanceof WorkflowCancelledError
                    || (!(reason instanceof WorkflowTimeoutError) && controller.signal.aborted);
                const timedOut = error instanceof WorkflowTimeoutError || reason instanceof WorkflowTimeoutError;
                const messageText = error?.message || String(error);
                this.send({
                    type: 'run.result',
                    runId: running.runId,
                    status: cancelled ? 'cancelled' : 'failed',
                    error: messageText,
                    timedOut,
                    usage: session.snapshot.usage,
                    checkpoint: buildCheckpoint(
                        lastCheckpointIndex,
                        runner.getContextValues(),
                        session.snapshot.steps,
                        globalConfig.workflow.maxStepOutputChars,
                    ),
                });
            }
        } finally {
            if (running.heartbeatTimer) clearInterval(running.heartbeatTimer);
            if (this.running === running) this.running = null;
        }
    }

    private cancelRun(runId: string, reason?: string): void {
        if (!this.running || this.running.runId !== runId) return;
        this.running.controller.abort(new WorkflowCancelledError(reason || 'Workflow cancelled by user'));
    }

    public dispose(): void {
        this.cancelRun(this.running?.runId || '', 'Workflow worker disposed');
    }

    /** 仅供测试/诊断：Worker 当前是否有 run。 */
    public get isBusy(): boolean {
        return Boolean(this.running);
    }
}
