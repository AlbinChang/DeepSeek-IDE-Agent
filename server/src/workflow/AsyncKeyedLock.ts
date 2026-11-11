/** Serializes asynchronous mutations sharing the same key. */
export class AsyncKeyedLock {
    private readonly tails = new Map<string, Promise<void>>();

    public async run<T>(runId: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.tails.get(runId);
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.tails.set(runId, current);
        if (previous) await previous;
        try {
            return await operation();
        } finally {
            release();
            if (this.tails.get(runId) === current) this.tails.delete(runId);
        }
    }
}
