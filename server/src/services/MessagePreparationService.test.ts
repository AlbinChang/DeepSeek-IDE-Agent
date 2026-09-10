import { describe, expect, it } from "vitest";

import { MessagePreparationService } from "./MessagePreparationService.js";

const SYSTEM_PROMPT = "MAIN_SYSTEM_PROMPT";
const PINNED_USER = "本轮用户原始指令";

function build(
    messages: any[],
    opts: {
        maxBytes?: number;
        lowWatermarkBytes?: number;
        minMessagesBeforeTrim?: number;
        pinnedUserMessage?: string;
        provider?: any;
    } = {}
) {
    return MessagePreparationService.buildMessages({
        systemPrompt: SYSTEM_PROMPT,
        pinnedUserMessage: opts.pinnedUserMessage ?? PINNED_USER,
        incomingMessages: messages,
        provider: opts.provider,
        ...opts,
    });
}

const QWEN_PROVIDER = { id: "qwen", name: "Qwen", modelId: "qwen38" };

const assistantToolCall = (toolCalls: any[], content = "") => ({
    role: "assistant",
    content,
    tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: "{}" },
    })),
    reasoning_content: "",
});

const toolResult = (id: string) => ({ role: "tool", tool_call_id: id, content: `result-of-${id}` });

describe("MessagePreparationService.buildMessages — 工具调用链完整性", () => {
    it("system 消息插入工具结果之间时，不割裂 tool_calls 与 tool 消息（修复 DeepSeek 400）", () => {
        const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: PINNED_USER },
            assistantToolCall([
                { id: "call-1", name: "update_todo" },
                { id: "call-2", name: "append_never_mistake_rule" },
            ]),
            toolResult("call-1"),
            { role: "system", content: "【系统注入指令】示例：工具结果之间的 system 消息。" },
            toolResult("call-2"),
        ];

        const result = build(messages);

        const assistant = result.find((m) => m.role === "assistant");
        expect(assistant?.tool_calls).toHaveLength(2);
        const toolMsgs = result.filter((m) => m.role === "tool");
        expect(toolMsgs.map((t) => t.tool_call_id)).toEqual(["call-1", "call-2"]);
        // 中间插入的 system 消息必须保留（语义不可丢）
        expect(result.some((m) => m.role === "system" && String(m.content).includes("系统注入指令"))).toBe(true);
    });

    it("孤儿 tool 消息（assistant 被裁剪）被丢弃，不产生悬空引用", () => {
        const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: PINNED_USER },
            // assistant(call-9) 连同第一条工具结果被裁掉，留下孤儿 tool 消息
            assistantToolCall([{ id: "call-9", name: "list_files" }]),
            toolResult("call-9"),
            toolResult("call-9-orphan"),
        ];

        // 强制触发裁剪：极小低水位 + 裁剪从队首按 2 条移除。
        // 裁剪后 msgsToProcess 只保留孤儿 tool 消息（其 assistant 已被移除）→ 必须被丢弃
        const result = build(messages, { maxBytes: 1, lowWatermarkBytes: 1, minMessagesBeforeTrim: 1 });

        expect(result.filter((m) => m.role === "tool")).toHaveLength(0);
        expect(result.filter((m) => m.role === "assistant")).toHaveLength(0);
    });

    it("assistant 的 tool_calls 缺少响应时整体删除，且不残留孤儿 tool 消息", () => {
        const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: PINNED_USER },
            // call-a 有响应，call-b 无响应 → 整体删除 tool_calls，残余 tool 消息一并丢弃
            assistantToolCall([
                { id: "call-a", name: "read_file" },
                { id: "call-b", name: "write_file" },
            ]),
            toolResult("call-a"),
        ];

        const result = build(messages);

        const assistant = result.find((m) => m.role === "assistant");
        expect(assistant?.tool_calls).toBeUndefined();
        expect(result.filter((m) => m.role === "tool")).toHaveLength(0);
    });

    it("assistant 的 tool_calls 全部有响应时完整保留", () => {
        const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: PINNED_USER },
            assistantToolCall([
                { id: "call-x", name: "update_todo" },
                { id: "call-y", name: "list_todos" },
            ]),
            toolResult("call-x"),
            toolResult("call-y"),
        ];

        const result = build(messages);

        const assistant = result.find((m) => m.role === "assistant");
        expect(assistant?.tool_calls).toHaveLength(2);
        expect(result.filter((m) => m.role === "tool")).toHaveLength(2);
    });

    it("工具轮的 reasoning_content 原封不动透传（不增、不删、不改）", () => {
        const exactReasoning = "第一轮推理内容\n包含换行与 `反引号` ★ 原始字符";
        const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: PINNED_USER },
            { ...assistantToolCall([{ id: "call-r1", name: "list_files" }]), reasoning_content: exactReasoning },
            toolResult("call-r1"),
        ];

        const result = build(messages);

        const assistant = result.find((m) => m.role === "assistant");
        // 逐字一致，不允许任何加工
        expect(assistant?.reasoning_content).toBe(exactReasoning);
        expect(assistant?.tool_calls).toHaveLength(1);
    });

    it("工具轮 reasoning_content 为空字符串时保持空字符串（不伪造、不兜底）", () => {
        const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: PINNED_USER },
            assistantToolCall([{ id: "call-r1", name: "list_files" }]), // 源消息 reasoning_content 为 ""
            toolResult("call-r1"),
        ];

        const result = build(messages);

        const assistant = result.find((m) => m.role === "assistant");
        expect(assistant?.reasoning_content).toBe("");
        expect(assistant?.tool_calls).toHaveLength(1);
    });

    it("源消息没有 reasoning_content 字段时不新增该字段（原样透传）", () => {
        const noReasoningToolCall = {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call-solo", type: "function", function: { name: "list_files", arguments: "{}" } }],
        };
        const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: PINNED_USER },
            noReasoningToolCall,
            toolResult("call-solo"),
        ];

        const result = build(messages);

        const assistant = result.find((m) => m.role === "assistant");
        expect(Object.prototype.hasOwnProperty.call(assistant, "reasoning_content")).toBe(false);
        expect(assistant?.tool_calls).toHaveLength(1);
    });

    it("无工具调用的 assistant 消息同样原样透传 reasoning_content", () => {
        const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: PINNED_USER },
            { role: "assistant", content: "最终回答", reasoning_content: "最终回答前的推理" },
        ];

        const result = build(messages);

        const assistant = result.find((m) => m.role === "assistant");
        expect(assistant?.reasoning_content).toBe("最终回答前的推理");
    });
});

describe("MessagePreparationService.buildMessages — Qwen 中途 system 兼容", () => {
    it("Qwen 模型：中途 system 指令降级为 user 消息并加前缀，首条 system 保持 system", () => {
        const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: PINNED_USER },
            { role: "assistant", content: "先调用工具" },
            { role: "system", content: "【系统注入指令】中途继续推进任务。" },
        ];

        const result = build(messages, { provider: QWEN_PROVIDER });

        // 首条 system 保持不变
        expect(result[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
        // 中途 system → user + 前缀
        const converted = result.find((m) => String(m.content).includes("系统注入指令"));
        expect(converted?.role).toBe("user");
        expect(String(converted?.content)).toBe(`系统提示(非用户指令): 【系统注入指令】中途继续推进任务。`);
        // 输出中不允许存在除首条外的 system 消息
        expect(result.filter((m) => m.role === "system")).toHaveLength(1);
    });

    it("非 Qwen 模型：中途 system 指令保持 system 原样", () => {
        const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: PINNED_USER },
            { role: "assistant", content: "先调用工具" },
            { role: "system", content: "【系统注入指令】中途继续推进任务。" },
        ];

        const result = build(messages, { provider: { id: "deepseek", modelId: "deepseek-reasoner" } });

        const kept = result.find((m) => String(m.content).includes("系统注入指令"));
        expect(kept?.role).toBe("system");
        expect(String(kept?.content)).toBe("【系统注入指令】中途继续推进任务。");
    });

    it("非置顶 user 消息（迭代修复指令）在重建后保留，且不再注入原始用户意图覆盖", () => {
        const iterationDirective = "【迭代修复模式】请按评估报告在原文件上逐项修复。";
        const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: iterationDirective },
            { role: "assistant", content: "好的，我先读取目标文件" },
        ];

        // pinnedUserMessage 切换为迭代修复指令（对应 AgentChatComponent 的 currentPinnedUserMessage）
        const result = build(messages, { pinnedUserMessage: iterationDirective });

        const userMsgs = result.filter((m) => m.role === "user");
        expect(userMsgs).toHaveLength(1);
        expect(String(userMsgs[0].content)).toBe(iterationDirective);
    });

    it("非置顶 user 消息（Qwen 模式下降级而来的中途指令）重建时被保留", () => {
        const directive = "系统提示(非用户指令): 检测到仍有 TODO 任务未到终态，请继续推进。";
        const messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: PINNED_USER },
            { role: "assistant", content: "完成当前步骤" },
            { role: "user", content: directive },
        ];

        const result = build(messages, { provider: QWEN_PROVIDER });

        const directiveMsgs = result.filter((m) => m.role === "user" && String(m.content) === directive);
        expect(directiveMsgs).toHaveLength(1);
    });
});
