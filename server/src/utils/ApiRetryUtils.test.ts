import { describe, expect, it, vi } from "vitest";

import {
    classifyRetryableError,
    computeRetryDelayMs,
    withApiRetry,
    SERVICE_BUSY_HTTP_STATUS,
} from "./ApiRetryUtils.js";

describe("classifyRetryableError", () => {
    it("treats HTTP 503 (DeepSeek Service is too busy) as retryable service_busy", () => {
        const verdict = classifyRetryableError({ status: 503, message: "Service is too busy" });
        expect(verdict.retryable).toBe(true);
        expect(verdict.category).toBe("service_busy");
        expect(verdict.status).toBe(503);
    });

    it("treats 429/500/502/504 as retryable service_busy", () => {
        for (const status of [429, 500, 502, 504]) {
            const verdict = classifyRetryableError({ status });
            expect(verdict.retryable).toBe(true);
            expect(verdict.category).toBe("service_busy");
        }
    });

    it("does NOT retry 4xx client errors like 400/401/403/404", () => {
        for (const status of [400, 401, 403, 404]) {
            const verdict = classifyRetryableError({ status });
            expect(verdict.retryable).toBe(false);
            expect(verdict.category).toBe("non_retryable");
        }
    });

    it("treats network-layer errors (no HTTP status) as retryable network", () => {
        const cases = [
            { code: "ENOTFOUND" },
            { code: "ECONNREFUSED" },
            { code: "ETIMEDOUT" },
            { code: "UND_ERR_BODY_TIMEOUT" },
            { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } },
            { message: "fetch failed" },
            { message: "terminated" },
        ];
        for (const err of cases) {
            const verdict = classifyRetryableError(err);
            expect(verdict.retryable).toBe(true);
            expect(verdict.category).toBe("network");
        }
    });

    it("supports error.response?.status shape (raw fetch style)", () => {
        const verdict = classifyRetryableError({ response: { status: 503 }, message: "overloaded" });
        expect(verdict.retryable).toBe(true);
        expect(verdict.category).toBe("service_busy");
    });
});

describe("computeRetryDelayMs", () => {
    it("returns exponential backoff with jitter bounded by maxDelayMs", () => {
        vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter = 1.0
        try {
            expect(computeRetryDelayMs(0, "network")).toBe(1000);   // 1000 * 2^0
            expect(computeRetryDelayMs(1, "network")).toBe(2000);   // 1000 * 2^1
            expect(computeRetryDelayMs(2, "network")).toBe(4000);   // 1000 * 2^2
            expect(computeRetryDelayMs(0, "service_busy")).toBe(2000); // 2000 * 2^0
            // 超过上限被钳制
            expect(computeRetryDelayMs(20, "network", 30_000)).toBe(30_000);
        } finally {
            vi.restoreAllMocks();
        }
    });
});

describe("withApiRetry", () => {
    // 退避逻辑已在 computeRetryDelayMs 单测中验证；这里让 setTimeout 即时触发，
    // 避免真实指数退避把测试拖到超时。
    const mockInstantTimers = () => {
        vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void) => {
            handler();
            return 0 as any;
        }) as any);
    };
    const restoreTimers = () => {
        vi.restoreAllMocks();
    };

    it("succeeds immediately when no error", async () => {
        const fn = vi.fn().mockResolvedValue("ok");
        await expect(withApiRetry(fn)).resolves.toBe("ok");
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries up to serviceBusyRetries for 503 then succeeds", async () => {
        mockInstantTimers();
        try {
            let calls = 0;
            const fn = vi.fn().mockImplementation(async () => {
                calls++;
                if (calls < 4) throw { status: 503, message: "Service is too busy" };
                return "done";
            });
            const onRetry = vi.fn();
            await expect(
                withApiRetry(fn, { serviceBusyRetries: 10, onRetry })
            ).resolves.toBe("done");
            expect(calls).toBe(4);
            expect(onRetry).toHaveBeenCalledTimes(3);
        } finally {
            restoreTimers();
        }
    });

    it("throws original error after exhausting service-busy retries", async () => {
        mockInstantTimers();
        try {
            const err = { status: 503, message: "Service is too busy" };
            const fn = vi.fn().mockRejectedValue(err);
            await expect(withApiRetry(fn, { serviceBusyRetries: 3 })).rejects.toBe(err);
            expect(fn).toHaveBeenCalledTimes(4); // 1 次原始 + 3 次重试
        } finally {
            restoreTimers();
        }
    });

    it("does not retry non-retryable errors (e.g. 401)", async () => {
        const err = { status: 401, message: "Invalid API key" };
        const fn = vi.fn().mockRejectedValue(err);
        await expect(withApiRetry(fn, { serviceBusyRetries: 10 })).rejects.toBe(err);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("uses retries limit for network-layer errors", async () => {
        mockInstantTimers();
        try {
            const err = { code: "ENOTFOUND" };
            const fn = vi.fn().mockRejectedValue(err);
            await expect(withApiRetry(fn, { retries: 2, serviceBusyRetries: 10 })).rejects.toBe(err);
            expect(fn).toHaveBeenCalledTimes(3); // 1 次原始 + 2 次重试
        } finally {
            restoreTimers();
        }
    });
});

describe("SERVICE_BUSY_HTTP_STATUS", () => {
    it("includes the transient overload status codes", () => {
        expect([...SERVICE_BUSY_HTTP_STATUS].sort((a, b) => a - b)).toEqual([408, 409, 425, 429, 500, 502, 503, 504]);
    });
});
