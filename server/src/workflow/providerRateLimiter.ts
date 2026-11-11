import { WorkflowCancelledError } from '@/workflow/errors.js';

interface Waiter {
    resolve: () => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
    onAbort: () => void;
}

interface Bucket {
    tokens: number;
    updatedAt: number;
    waiters: Waiter[];
    timer?: ReturnType<typeof setTimeout>;
}

/** Per-provider/model token bucket shared by all runs owned by an engine. */
export class ProviderRequestRateLimiter {
    private readonly buckets = new Map<string, Bucket>();
    private closed = false;

    constructor(
        private readonly requestsPerMinute: number,
        private readonly burst: number,
    ) {
        if (!Number.isFinite(requestsPerMinute) || requestsPerMinute < 0
            || !Number.isInteger(burst) || burst < 1) {
            throw new Error('Invalid workflow provider request rate limit');
        }
    }

    public acquire(key: string, signal: AbortSignal): Promise<void> {
        if (this.closed) return Promise.reject(new WorkflowCancelledError('Workflow rate limiter is closed'));
        if (signal.aborted) return Promise.reject(this.abortReason(signal));
        if (this.requestsPerMinute === 0) return Promise.resolve();

        const bucket = this.buckets.get(key) || {
            tokens: this.burst,
            updatedAt: Date.now(),
            waiters: [],
        };
        this.buckets.set(key, bucket);
        this.refill(bucket);
        if (bucket.waiters.length === 0 && bucket.tokens >= 1) {
            bucket.tokens -= 1;
            this.schedule(key, bucket);
            return Promise.resolve();
        }

        return new Promise<void>((resolve, reject) => {
            const waiter: Waiter = {
                resolve,
                reject,
                signal,
                onAbort: () => {
                    const index = bucket.waiters.indexOf(waiter);
                    if (index < 0) return;
                    bucket.waiters.splice(index, 1);
                    signal.removeEventListener('abort', waiter.onAbort);
                    reject(this.abortReason(signal));
                    this.schedule(key, bucket);
                },
            };
            bucket.waiters.push(waiter);
            signal.addEventListener('abort', waiter.onAbort, { once: true });
            if (signal.aborted) waiter.onAbort();
            else this.schedule(key, bucket);
        });
    }

    public shutdown(): void {
        this.closed = true;
        for (const bucket of this.buckets.values()) {
            if (bucket.timer) clearTimeout(bucket.timer);
            for (const waiter of bucket.waiters) {
                waiter.signal.removeEventListener('abort', waiter.onAbort);
                waiter.reject(new WorkflowCancelledError('Workflow rate limiter is closed'));
            }
        }
        this.buckets.clear();
    }

    private refill(bucket: Bucket): void {
        const now = Date.now();
        const elapsed = Math.max(0, now - bucket.updatedAt);
        bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed * this.requestsPerMinute / 60_000);
        bucket.updatedAt = now;
    }

    private schedule(key: string, bucket: Bucket): void {
        if (bucket.timer) clearTimeout(bucket.timer);
        bucket.timer = undefined;
        this.refill(bucket);

        while (bucket.waiters.length > 0 && bucket.tokens >= 1) {
            const waiter = bucket.waiters.shift()!;
            waiter.signal.removeEventListener('abort', waiter.onAbort);
            bucket.tokens -= 1;
            waiter.resolve();
        }
        if (bucket.waiters.length === 0 && bucket.tokens >= this.burst) {
            this.buckets.delete(key);
            return;
        }
        const target = bucket.waiters.length > 0 ? 1 : this.burst;
        const delay = Math.max(1, Math.ceil((target - bucket.tokens) * 60_000 / this.requestsPerMinute));
        bucket.timer = setTimeout(() => this.schedule(key, bucket), Math.min(delay, 2_147_483_647));
        if (bucket.waiters.length === 0) bucket.timer.unref?.();
    }

    private abortReason(signal: AbortSignal): unknown {
        return signal.reason instanceof Error
            ? signal.reason
            : new WorkflowCancelledError('Workflow request cancelled while waiting for rate limit');
    }
}
