import { describe, expect, it } from "vitest";

import { AIProviderFactory } from "./AIProviderFactory.js";

describe("AIProviderFactory.parseReasoningEffortAlias — DeepSeek 官方别名口径 (2026-09-10)", () => {
    const cases: Array<[unknown, string | null]> = [
        ["minimal", "low"],
        ["low", "low"],
        ["medium", "high"],
        ["high", "high"],
        ["xhigh", "high"],
        ["max", "max"],
        ["ultra", "max"],
        ["default", "default"],
        ["  MAX  ", "max"],
        ["UNKNOWN", null],
        [42, null],
        [null, null],
        [undefined, null],
        ["", null],
        [true, null],
    ];

    it.each(cases)("%j 归一化为 %j", (input, expected) => {
        expect(AIProviderFactory.parseReasoningEffortAlias(input)).toBe(expected);
    });
});

describe("AIProviderFactory.mapReasoningEffort", () => {
    it("DeepSeek: low | high | max 原样透传，default 省略字段", () => {
        const deepseek = { id: "deepseek", modelId: "deepseek-reasoner" };
        expect(AIProviderFactory.mapReasoningEffort(deepseek, "low")).toBe("low");
        expect(AIProviderFactory.mapReasoningEffort(deepseek, "high")).toBe("high");
        expect(AIProviderFactory.mapReasoningEffort(deepseek, "max")).toBe("max");
        expect(AIProviderFactory.mapReasoningEffort(deepseek, "default")).toBeNull();
    });

    it("Qwen: max→xhigh, high→medium, low→low, default→null", () => {
        const qwen = { id: "qwen", modelId: "qwen-max" };
        expect(AIProviderFactory.mapReasoningEffort(qwen, "max")).toBe("xhigh");
        expect(AIProviderFactory.mapReasoningEffort(qwen, "high")).toBe("medium");
        expect(AIProviderFactory.mapReasoningEffort(qwen, "low")).toBe("low");
        expect(AIProviderFactory.mapReasoningEffort(qwen, "default")).toBeNull();
    });

    it("未显式传入时回落到 provider.defaultReasoningEffort", () => {
        const provider = { id: "deepseek", modelId: "deepseek-reasoner", defaultReasoningEffort: "low" as const };
        expect(AIProviderFactory.mapReasoningEffort(provider, null)).toBe("low");
    });

    it("非法档位回落系统默认 high", () => {
        const provider = { id: "deepseek", modelId: "deepseek-reasoner", defaultReasoningEffort: "invalid" as any };
        expect(AIProviderFactory.mapReasoningEffort(provider, null)).toBe("high");
    });
});

describe("AIProviderFactory.buildThinkingOptions", () => {
    it("DeepSeek 非 default 档注入 extra_body.thinking.enabled + reasoning_effort + user_id", () => {
        const opts = AIProviderFactory.buildThinkingOptions(
            { id: "deepseek", modelId: "deepseek-reasoner" },
            "low",
            "main-agent",
            "C:/ws",
        );
        expect(opts.reasoning_effort).toBe("low");
        expect(opts.extra_body?.thinking).toEqual({ type: "enabled" });
        expect(typeof opts.extra_body?.user_id).toBe("string");
    });

    it("Qwen 非 default 档仅发送 reasoning_effort，不注入 DeepSeek 专属 extra_body", () => {
        const opts = AIProviderFactory.buildThinkingOptions(
            { id: "qwen", modelId: "qwen-max" },
            "high",
            "main-agent",
            "C:/ws",
        );
        expect(opts).toEqual({ reasoning_effort: "medium" });
    });

    it("enableThinking=false 时不注入 thinking / reasoning 参数", () => {
        const opts = AIProviderFactory.buildThinkingOptions(
            { id: "deepseek", modelId: "deepseek-reasoner", enableThinking: false },
            "max",
        );
        expect(opts.reasoning_effort).toBeUndefined();
        expect(opts.extra_body?.thinking).toBeUndefined();
    });

    it("default 档：DeepSeek 仅保留 user_id（KV Cache），不发送 reasoning_effort / thinking", () => {
        const opts = AIProviderFactory.buildThinkingOptions(
            { id: "deepseek", modelId: "deepseek-reasoner" },
            "default",
            "main-agent",
            "C:/ws",
        );
        expect(opts.reasoning_effort).toBeUndefined();
        expect(opts.extra_body?.thinking).toBeUndefined();
        expect(typeof opts.extra_body?.user_id).toBe("string");
    });
});
