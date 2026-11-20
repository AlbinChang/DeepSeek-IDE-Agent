import { describe, expect, it, vi } from "vitest";
import { ProviderConnectionTester } from "./ProviderConnectionTester.js";

const baseProvider = {
    id: "deepseek",
    name: "DeepSeek",
    type: "openai-compatible" as const,
    modelId: "deepseek-reasoner",
    apiKey: "secret-key",
    baseURL: "https://api.deepseek.com",
    enableThinking: true,
    defaultReasoningEffort: "high" as const,
};

async function* streamOf(chunks: any[]): AsyncIterable<any> {
    for (const chunk of chunks) yield chunk;
}

describe("ProviderConnectionTester", () => {
    it("treats the first streamed chunk as success and mirrors the agent request shape", async () => {
        const create = vi.fn(async () => streamOf([{ id: "chunk-1", model: "deepseek-reasoner-served" }]));

        const result = await ProviderConnectionTester.test(baseProvider, {
            clientFactory: () => ({ chat: { completions: { create } } }),
        });

        expect(result.success).toBe(true);
        expect(result.status).toBe("ok");
        expect(result.model).toBe("deepseek-reasoner-served");
        expect(typeof result.latencyMs).toBe("number");

        const [body] = create.mock.calls[0] as any[];
        // 回归点：必须使用流式请求（非流式 + 短超时是历史 timeout 的根因）
        expect(body.stream).toBe(true);
        expect(body.model).toBe("deepseek-reasoner");
        expect(body.max_tokens).toBeGreaterThan(1);
        expect(body.messages).toEqual([{ role: "user", content: "ping" }]);
        expect(body.reasoning_effort).toBe("high");
        expect(body.extra_body?.thinking).toEqual({ type: "enabled" });
    });

    it("omits thinking fields when the provider disables thinking", async () => {
        const create = vi.fn(async () => streamOf([{ model: "m" }]));

        await ProviderConnectionTester.test(
            { ...baseProvider, enableThinking: false },
            { clientFactory: () => ({ chat: { completions: { create } } }) },
        );

        const [body] = create.mock.calls[0] as any[];
        expect(body.stream).toBe(true);
        expect(body.reasoning_effort).toBeUndefined();
        // 关闭思考时仍保留 user_id（与 Agent 请求一致，仅用于 KV Cache 复用）
        expect(body.extra_body?.thinking).toBeUndefined();
    });

    it("accepts a gateway that ignores stream=true and returns a full response", async () => {
        const create = vi.fn(async () => ({ model: "plain-model", choices: [{ message: { content: "pong" } }] }));

        const result = await ProviderConnectionTester.test(baseProvider, {
            clientFactory: () => ({ chat: { completions: { create } } }),
        });

        expect(result.success).toBe(true);
        expect(result.status).toBe("ok");
        expect(result.model).toBe("plain-model");
    });

    it("aborts and reports timeout when no chunk arrives before the deadline", async () => {
        const create = vi.fn(async (_body: any, options?: { signal?: AbortSignal }) => {
            const signal = options?.signal;
            const hanging = (async function* () {
                await new Promise((_resolve, reject) => {
                    signal?.addEventListener("abort", () => {
                        const error = new Error("This operation was aborted");
                        error.name = "AbortError";
                        reject(error);
                    });
                });
                yield {};
            })();
            return hanging;
        });

        const result = await ProviderConnectionTester.test(baseProvider, {
            timeoutMs: 20,
            clientFactory: () => ({ chat: { completions: { create } } }),
        });

        expect(result.success).toBe(false);
        expect(result.status).toBe("timeout");
        expect(result.error).toContain("连接超时");
    });

    it("classifies authentication and routing failures", async () => {
        const unauthorized = Object.assign(new Error("401 Unauthorized"), { status: 401 });
        const authResult = await ProviderConnectionTester.test(baseProvider, {
            clientFactory: () => ({
                chat: { completions: { create: async () => { throw unauthorized; } } },
            }),
        });
        expect(authResult.success).toBe(false);
        expect(authResult.status).toBe("auth");
        expect(authResult.httpStatus).toBe(401);

        const notFound = Object.assign(new Error("404 Not Found"), { status: 404 });
        const notFoundResult = await ProviderConnectionTester.test(baseProvider, {
            clientFactory: () => ({
                chat: { completions: { create: async () => { throw notFound; } } },
            }),
        });
        expect(notFoundResult.success).toBe(false);
        expect(notFoundResult.status).toBe("not_found");
    });

    it("validates the raw provider fields before touching the network", async () => {
        const clientFactory = vi.fn(() => {
            throw new Error("client must not be created");
        });

        const result = await ProviderConnectionTester.test(
            { ...baseProvider, apiKey: "   " },
            { clientFactory },
        );

        expect(result.success).toBe(false);
        expect(result.status).toBe("invalid_request");
        expect(result.error).toContain("API Key");
        expect(clientFactory).not.toHaveBeenCalled();
    });
});
