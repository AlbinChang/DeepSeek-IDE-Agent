/** Reserves queue capacity while asynchronous validation and persistence run. */
export class WorkflowQueueAdmission {
    private reservations = 0;

    constructor(
        private readonly limit: number,
        private readonly queued: () => number,
    ) {}

    public reserve(): (() => void) | undefined {
        if (this.queued() + this.reservations >= this.limit) return undefined;
        this.reservations++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.reservations--;
        };
    }
}
