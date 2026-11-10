import { sanitizeForStore, WorkflowRunStore } from '@/workflow/WorkflowRunStore.js';
import type {
    WorkflowEvent,
    WorkflowRunInfo,
    WorkflowStepInfo,
    WorkflowUsage,
} from '@/workflow/types.js';

const EVENT_STRING_LIMIT = 2000;

/**
 * 单次 run 的内存快照 + 持久化会话。
 * 所有写入串行化，避免 run.json 并发覆盖。
 */
export class WorkflowRunSession {
    private writeChain: Promise<void> = Promise.resolve();
    private closed = false;

    constructor(
        private readonly store: WorkflowRunStore,
        public readonly snapshot: WorkflowRunInfo,
        private readonly publish: (event: WorkflowEvent) => void,
        private readonly maxOutputChars: number,
    ) {}

    public get runId(): string {
        return this.snapshot.runId;
    }

    public async patch(patch: Partial<WorkflowRunInfo>): Promise<void> {
        Object.assign(this.snapshot, patch);
        await this.persist();
    }

    public async upsertStep(step: WorkflowStepInfo): Promise<void> {
        const index = this.snapshot.steps.findIndex((entry) => entry.path === step.path);
        if (index >= 0) {
            this.snapshot.steps[index] = step;
        } else {
            this.snapshot.steps.push(step);
        }
        await this.persist();
    }

    public async addUsage(usage: WorkflowUsage): Promise<void> {
        const current = this.snapshot.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        this.snapshot.usage = {
            inputTokens: current.inputTokens + (usage.inputTokens || 0),
            outputTokens: current.outputTokens + (usage.outputTokens || 0),
            totalTokens: current.totalTokens + (usage.totalTokens || 0),
        };
        await this.persist();
    }

    public async emit(type: string, data: Record<string, unknown> = {}): Promise<void> {
        if (this.closed) return;
        const seq = (this.snapshot.lastSeq || 0) + 1;
        this.snapshot.lastSeq = seq;
        const sanitizedData = sanitizeForStore(data, EVENT_STRING_LIMIT) as Record<string, unknown>;
        const event: WorkflowEvent = {
            ...sanitizedData,
            runId: this.snapshot.runId,
            seq,
            type,
            timestamp: Date.now(),
        };

        try {
            await this.store.appendEvent(this.snapshot.runId, event);
        } catch (error) {
            console.warn(`[WorkflowRun] Failed to append event ${type} for ${this.snapshot.runId}:`, error);
        }
        try {
            this.publish(event);
        } catch (error) {
            console.warn(`[WorkflowRun] Event bus publish failed for ${this.snapshot.runId}:`, error);
        }
        await this.persist();
    }

    public sanitizeOutput(value: unknown): unknown {
        const sanitized = sanitizeForStore(value, this.maxOutputChars);
        try {
            const serialized = JSON.stringify(sanitized);
            if (typeof serialized === 'string' && serialized.length > this.maxOutputChars) {
                return `${serialized.slice(0, this.maxOutputChars)}…[truncated ${serialized.length - this.maxOutputChars} chars]`;
            }
        } catch {
            return String(sanitized);
        }
        return sanitized;
    }

    public previewOutput(value: unknown): string {
        const sanitized = sanitizeForStore(value, this.maxOutputChars);
        if (typeof sanitized === 'string') return sanitized;
        try {
            return JSON.stringify(sanitized);
        } catch {
            return String(sanitized);
        }
    }

    public async persist(): Promise<void> {
        if (this.closed) return;
        const snapshot = JSON.parse(JSON.stringify(this.snapshot)) as WorkflowRunInfo;
        this.writeChain = this.writeChain
            .catch(() => {})
            .then(() => this.store.save(snapshot))
            .catch((error) => {
                console.warn(`[WorkflowRun] Failed to persist run ${this.snapshot.runId}:`, error);
            });
        await this.writeChain;
    }

    public async close(): Promise<void> {
        await this.persist();
        this.closed = true;
    }
}
