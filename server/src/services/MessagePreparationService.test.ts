import { describe, expect, it } from "vitest";

import { MessagePreparationService } from "./MessagePreparationService.js";

const SYSTEM_PROMPT = "MAIN_SYSTEM_PROMPT";
const PINNED_USER = "本轮用户原始指令";

function build(messages: any[], opts: { maxBytes?: number; lowWatermarkBytes?: number; minMessagesBeforeTrim?: number } = {}) {
    return MessagePreparationService.buildMessages({
        systemPrompt: SYSTEM_PROMPT,
        pinnedUserMessage: PINNED_USER,
        incomingMessages: messages,
        ...opts,
    });
}

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
});
