import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderRequestRateLimiter } from '@/workflow/providerRateLimiter.js';

afterEach(() => {
    vi.useRealTimers();
});

describe('ProviderRequestRateLimiter', () => {
    it('limits each provider/model independently, honors burst and queues fairly', async () => {
        vi.useFakeTimers();
        const limiter = new ProviderRequestRateLimiter(60, 2);
        const signal = new AbortController().signal;
        await limiter.acquire('one:model', signal);
        await limiter.acquire('one:model', signal);
        const granted: number[] = [];
        const first = limiter.acquire('one:model', signal).then(() => granted.push(1));
        const second = limiter.acquire('one:model', signal).then(() => granted.push(2));
        await limiter.acquire('two:model', signal);
        expect(granted).toEqual([]);
        await vi.advanceTimersByTimeAsync(999);
        expect(granted).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(granted).toEqual([1]);
        await vi.advanceTimersByTimeAsync(1000);
        await Promise.all([first, second]);
        expect(granted).toEqual([1, 2]);
        limiter.shutdown();
    });

    it('removes cancelled waiters and rejects pending requests on shutdown', async () => {
        vi.useFakeTimers();
        const limiter = new ProviderRequestRateLimiter(60, 1);
        const first = new AbortController();
        await limiter.acquire('provider:model', first.signal);
        const cancelled = new AbortController();
        const wait = limiter.acquire('provider:model', cancelled.signal);
        const rejected = expect(wait).rejects.toThrow('cancelled');
        cancelled.abort(new Error('cancelled'));
        await rejected;
        const pending = limiter.acquire('provider:model', first.signal);
        const shutdown = expect(pending).rejects.toThrow('closed');
        limiter.shutdown();
        await shutdown;
    });

    it('is disabled by default rate zero without delaying requests', async () => {
        const limiter = new ProviderRequestRateLimiter(0, 1);
        const signal = new AbortController().signal;
        await Promise.all(Array.from({ length: 10 }, () => limiter.acquire('provider:model', signal)));
        limiter.shutdown();
    });
});
