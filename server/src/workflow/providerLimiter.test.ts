import { describe, expect, it } from 'vitest';

import { WorkflowCancelledError } from '@/workflow/errors.js';
import { ProviderConcurrencyLimiter } from '@/workflow/providerLimiter.js';

describe('ProviderConcurrencyLimiter', () => {
    it('serializes permits for the same provider key', async () => {
        const limiter = new ProviderConcurrencyLimiter(1);
        const first = await limiter.acquire('p:m', new AbortController().signal);
        let secondGranted = false;
        const secondPromise = limiter.acquire('p:m', new AbortController().signal).then((release) => {
            secondGranted = true;
            return release;
        });

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(secondGranted).toBe(false);

        first();
        const second = await secondPromise;
        expect(secondGranted).toBe(true);
        second();
        limiter.shutdown();
    });

    it('rejects queued permits when aborted or shut down', async () => {
        const limiter = new ProviderConcurrencyLimiter(1);
        const first = await limiter.acquire('p:m', new AbortController().signal);
        const controller = new AbortController();
        const queued = limiter.acquire('p:m', controller.signal);
        controller.abort();
        await expect(queued).rejects.toBeInstanceOf(WorkflowCancelledError);

        const queuedShutdown = limiter.acquire('p:m', new AbortController().signal);
        limiter.shutdown();
        await expect(queuedShutdown).rejects.toBeInstanceOf(WorkflowCancelledError);
        first();
    });
});
