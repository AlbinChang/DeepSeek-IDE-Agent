import { WorkflowCancelledError, WorkflowError } from '@/workflow/errors.js';

interface WaitEntry {
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
    onAbort: () => void;
}

/**
 * 进程内 provider 级并发限制器（standalone / 测试用）。
 * Worker 引擎由主进程维护跨进程 permit 队列；这里保持相同语义。
 */
export class ProviderConcurrencyLimiter {
    private readonly active = new Map<string, number>();
    private readonly waiters = new Map<string, WaitEntry[]>();
    private closed = false;

    constructor(private readonly limit: number) {}

    public acquire(key: string, signal: AbortSignal): Promise<() => void> {
        if (this.closed) {
            return Promise.reject(new WorkflowCancelledError('Provider limiter closed'));
        }
        if (signal.aborted) {
            return Promise.reject(this.abortReason(signal));
        }
        const normalized = key || 'default:default';
        const current = this.active.get(normalized) || 0;
        if (current < this.limit) {
            this.active.set(normalized, current + 1);
            return Promise.resolve(this.createRelease(normalized));
        }
        return new Promise<() => void>((resolve, reject) => {
            const entry: WaitEntry = {
                resolve,
                reject,
                signal,
                onAbort: () => {
                    const entries = this.waiters.get(normalized);
                    if (entries) {
                        const index = entries.indexOf(entry);
                        if (index >= 0) entries.splice(index, 1);
                        if (entries.length === 0) this.waiters.delete(normalized);
                    }
                    signal.removeEventListener('abort', entry.onAbort);
                    reject(this.abortReason(signal));
                },
            };
            signal.addEventListener('abort', entry.onAbort, { once: true });
            const entries = this.waiters.get(normalized) || [];
            entries.push(entry);
            this.waiters.set(normalized, entries);
        });
    }

    public shutdown(reason = 'Provider limiter closed'): void {
        if (this.closed) return;
        this.closed = true;
        for (const entries of this.waiters.values()) {
            for (const entry of entries) {
                entry.signal.removeEventListener('abort', entry.onAbort);
                entry.reject(new WorkflowCancelledError(reason));
            }
        }
        this.waiters.clear();
        this.active.clear();
    }

    private abortReason(signal: AbortSignal): unknown {
        return signal.reason instanceof WorkflowError
            ? signal.reason
            : new WorkflowCancelledError(
                signal.reason instanceof Error ? signal.reason.message : 'Workflow cancelled',
            );
    }

    private createRelease(key: string): () => void {        let released = false;
        return () => {
            if (released) return;
            released = true;
            const remaining = Math.max(0, (this.active.get(key) || 0) - 1);
            if (remaining > 0) this.active.set(key, remaining);
            else this.active.delete(key);
            if (this.closed) return;

            const entries = this.waiters.get(key);
            while (entries && entries.length > 0 && (this.active.get(key) || 0) < this.limit) {
                const entry = entries.shift()!;
                entry.signal.removeEventListener('abort', entry.onAbort);
                if (entry.signal.aborted) continue;
                this.active.set(key, (this.active.get(key) || 0) + 1);
                entry.resolve(this.createRelease(key));
            }
            if (entries && entries.length === 0) this.waiters.delete(key);
        };
    }
}
