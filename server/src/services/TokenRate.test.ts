import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    TOKEN_RATE_PUBLISH_INTERVAL_MS,
    TOKEN_RATE_WINDOW_MS,
    computeTokenRate,
    getTokenRateSnapshot,
    recordTokenDelta,
    resetTokenRate,
    subscribeTokenRate,
} from '../../../client/src/services/tokenRate.js';

/**
 * 回归用例：状态栏「T/s」实时速率。
 * 采样窗口 5s、发布节拍 1s；父级不应因为速率刷新而重渲染。
 */

describe('computeTokenRate', () => {
    it('空采样返回 0', () => {
        expect(computeTokenRate([], 1000)).toBe(0);
    });

    it('窗口内总量按秒折算为平均速率', () => {
        const now = 10_000;
        const rate = computeTokenRate([
            { at: now - 1000, tokens: 5000 },
            { at: now - 3000, tokens: 5000 },
        ], now, 5000);
        // 10000 tokens / 5s 窗口
        expect(rate).toBe(2000);
    });

    it('默认窗口下同一批采样的速率按窗口长度摊薄', () => {
        const now = 10_000;
        const rate = computeTokenRate([
            { at: now - 1000, tokens: 5000 },
            { at: now - 3000, tokens: 5000 },
        ], now);
        expect(rate).toBe(Math.round(10_000 / (TOKEN_RATE_WINDOW_MS / 1000)));
    });

    it('窗口外的旧采样点被忽略', () => {
        const now = 10_000;
        const rate = computeTokenRate([
            { at: now - TOKEN_RATE_WINDOW_MS - 1, tokens: 999_999 },
            { at: now - 500, tokens: 2500 },
        ], now, 5000);
        expect(rate).toBe(500);
    });

    it('未来时间戳（时钟回拨）不会被计入', () => {
        const now = 10_000;
        expect(computeTokenRate([{ at: now + 5000, tokens: 10_000 }], now)).toBe(0);
    });
});

describe('tokenRate store', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        resetTokenRate();
    });

    afterEach(() => {
        vi.useRealTimers();
        resetTokenRate();
    });

    it('按 1s 节拍发布速率，并只在数值变化时通知', async () => {
        const listener = vi.fn();
        const unsubscribe = subscribeTokenRate(listener);

        recordTokenDelta(5000);
        await vi.advanceTimersByTimeAsync(TOKEN_RATE_PUBLISH_INTERVAL_MS);
        // 5000 tokens / 默认窗口秒数
        expect(getTokenRateSnapshot()).toBe(Math.round(5000 / (TOKEN_RATE_WINDOW_MS / 1000)));

        const callsAfterFirstPublish = listener.mock.calls.length;
        // 没有新增用量时，窗口内总量不变，不应重复通知
        await vi.advanceTimersByTimeAsync(TOKEN_RATE_PUBLISH_INTERVAL_MS);
        expect(listener.mock.calls.length).toBe(callsAfterFirstPublish);

        unsubscribe();
    });

    it('空闲超过窗口后速率回落为 0', async () => {
        const unsubscribe = subscribeTokenRate(() => undefined);
        recordTokenDelta(3000);
        await vi.advanceTimersByTimeAsync(TOKEN_RATE_PUBLISH_INTERVAL_MS);
        expect(getTokenRateSnapshot()).toBeGreaterThan(0);

        await vi.advanceTimersByTimeAsync(TOKEN_RATE_WINDOW_MS + TOKEN_RATE_PUBLISH_INTERVAL_MS);
        expect(getTokenRateSnapshot()).toBe(0);
        unsubscribe();
    });

    it('忽略非正数与非有限值', async () => {
        const unsubscribe = subscribeTokenRate(() => undefined);
        recordTokenDelta(0);
        recordTokenDelta(-100);
        recordTokenDelta(Number.NaN);
        await vi.advanceTimersByTimeAsync(TOKEN_RATE_PUBLISH_INTERVAL_MS);
        expect(getTokenRateSnapshot()).toBe(0);
        unsubscribe();
    });

    it('取消订阅后停止采样定时器', async () => {
        const listener = vi.fn();
        const unsubscribe = subscribeTokenRate(listener);
        unsubscribe();

        recordTokenDelta(5000);
        await vi.advanceTimersByTimeAsync(TOKEN_RATE_PUBLISH_INTERVAL_MS * 3);
        expect(listener).not.toHaveBeenCalled();
        expect(getTokenRateSnapshot()).toBe(0);
    });
});
