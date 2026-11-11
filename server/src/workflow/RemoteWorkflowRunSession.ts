import type {
    WorkflowRunInfo,
    WorkflowStepInfo,
    WorkflowUsage,
} from '@/workflow/types.js';
import {
    previewOutputValue,
    sanitizeOutputValue,
    type WorkflowRunChannel,
} from '@/workflow/WorkflowRunSession.js';
import type {
    WorkerToMainMessage,
    WorkflowWorkerCheckpointMessage,
    WorkflowWorkerRunConfig,
} from '@/workflow/workerProtocol.js';

export interface RemoteWorkflowRunSessionOptions {
    config: WorkflowWorkerRunConfig;
    steps: WorkflowStepInfo[];
    usage?: WorkflowUsage;
    lastSeq?: number;
    maxOutputChars: number;
    send: (message: WorkerToMainMessage) => void;
}

/**
 * Worker 内的 Run 会话：不写磁盘，只把状态/事件发给主进程。
 * 主进程是 run.json / events.jsonl 的唯一写者。
 */
export class RemoteWorkflowRunSession implements WorkflowRunChannel {
    public readonly snapshot: WorkflowRunInfo;
    private readonly config: WorkflowWorkerRunConfig;
    private readonly maxOutputChars: number;
    private readonly send: (message: WorkerToMainMessage) => void;

    constructor(options: RemoteWorkflowRunSessionOptions) {
        this.config = options.config;
        this.maxOutputChars = options.maxOutputChars;
        this.send = options.send;
        this.snapshot = {
            schemaVersion: 1,
            runId: options.config.runId,
            workflow: {
                name: options.config.workflowName,
                path: '',
            },
            workflowName: options.config.workflowName,
            userId: options.config.userId,
            root: options.config.root,
            status: 'running',
            inputs: {},
            createdAt: Date.now(),
            steps: options.steps,
            usage: options.usage,
            lastSeq: options.lastSeq || 0,
        };
    }

    public get runId(): string {
        return this.config.runId;
    }

    public async patch(patch: Partial<WorkflowRunInfo>): Promise<void> {
        Object.assign(this.snapshot, patch);
        const statePatch: { currentTask?: string } = {};
        if (typeof patch.currentTask === 'string') {
            statePatch.currentTask = patch.currentTask;
        }
        if (Object.keys(statePatch).length > 0) {
            this.send({ type: 'run.patch', runId: this.runId, patch: statePatch });
        }
    }

    public async upsertStep(step: WorkflowStepInfo): Promise<void> {
        const index = this.snapshot.steps.findIndex((entry) => entry.path === step.path);
        if (index >= 0) {
            this.snapshot.steps[index] = step;
        } else {
            this.snapshot.steps.push(step);
        }
        this.send({ type: 'run.step', runId: this.runId, step });
    }

    public async addUsage(usage: WorkflowUsage): Promise<void> {
        const current = this.snapshot.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        this.snapshot.usage = {
            inputTokens: current.inputTokens + (usage.inputTokens || 0),
            outputTokens: current.outputTokens + (usage.outputTokens || 0),
            totalTokens: current.totalTokens + (usage.totalTokens || 0),
        };
        this.send({ type: 'run.usage', runId: this.runId, usage });
    }

    public async emit(type: string, data: Record<string, unknown> = {}): Promise<void> {
        this.send({ type: 'run.event', runId: this.runId, eventType: type, data });
    }

    public checkpoint(checkpoint: WorkflowWorkerCheckpointMessage['checkpoint']): void {
        this.send({ type: 'run.checkpoint', runId: this.runId, checkpoint });
    }

    public sanitizeOutput(value: unknown): unknown {
        return sanitizeOutputValue(value, this.maxOutputChars);
    }

    public previewOutput(value: unknown): string {
        return previewOutputValue(value, this.maxOutputChars);
    }
}
