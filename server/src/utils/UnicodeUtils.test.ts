import { describe, expect, it } from "vitest";

import {
    hasLoneSurrogate,
    sanitizeJsonStrings,
    sanitizeLoneSurrogates,
} from "./UnicodeUtils.js";

const LONE_HIGH = "\uD83D";
const LONE_LOW = "\uDE00";
const EMOJI = "\uD83D\uDE00";

describe("UnicodeUtils.sanitizeLoneSurrogates", () => {
    it("合法字符串原样返回同一引用", () => {
        const text = `中文 ${EMOJI} text`;
        expect(hasLoneSurrogate(text)).toBe(false);
        expect(sanitizeLoneSurrogates(text)).toBe(text);
    });

    it("修复末尾孤立的高代理码元", () => {
        const text = `broken${LONE_HIGH}`;
        expect(hasLoneSurrogate(text)).toBe(true);
        expect(sanitizeLoneSurrogates(text)).toBe("broken\uFFFD");
    });

    it("修复孤立的低代理码元", () => {
        const text = `${LONE_LOW}broken`;
        expect(sanitizeLoneSurrogates(text)).toBe("\uFFFDbroken");
    });

    it("保留合法的代理对，只替换未配对部分", () => {
        const text = `a${LONE_HIGH}b${EMOJI}c${LONE_LOW}d`;
        expect(sanitizeLoneSurrogates(text)).toBe(`a\uFFFDb${EMOJI}c\uFFFDd`);
    });

    it("临近的完整代理对不会被误判", () => {
        const text = `${EMOJI}${EMOJI}`;
        expect(hasLoneSurrogate(text)).toBe(false);
        expect(sanitizeLoneSurrogates(text)).toBe(text);
    });
});

describe("UnicodeUtils.sanitizeJsonStrings", () => {
    it("请求体干净时保持原引用（不破坏消息字节数缓存）", () => {
        const payload = {
            model: "deepseek-flash",
            messages: [
                { role: "user", content: `hello ${EMOJI}` },
                { role: "assistant", content: "", reasoning_content: "ok" },
            ],
        };
        const result = sanitizeJsonStrings(payload);

        expect(result.repairedStrings).toBe(0);
        expect(result.value).toBe(payload);
        expect(result.value.messages).toBe(payload.messages);
    });

    it("递归修复嵌套消息与工具参数中的孤立代理码元", () => {
        const payload = {
            messages: [
                { role: "tool", tool_call_id: "call-1", content: `snapshot ${LONE_HIGH}` },
                {
                    role: "assistant",
                    content: "",
                    tool_calls: [{
                        id: "call-1",
                        type: "function",
                        function: {
                            name: "insert_in_file",
                            // 模型流式输出的原始字符串可能直接携带孤立代理码元
                            arguments: `{"path":"a.java","startLine":1,"newText":"x ${LONE_LOW}"}`,
                        },
                    }],
                },
            ],
        };
        const result = sanitizeJsonStrings(payload);

        expect(result.repairedStrings).toBe(2);
        expect(result.value).not.toBe(payload);
        const toolMessage = result.value.messages[0];
        const args = result.value.messages[1].tool_calls[0].function.arguments;

        expect(toolMessage.content).toBe("snapshot \uFFFD");
        expect(args).not.toContain(LONE_LOW);
        expect(args).toContain("\uFFFD");
        // 原始对象不被修改
        expect(payload.messages[0].content).toContain(LONE_HIGH);
    });

    it("只复制发生变化的层级", () => {
        const unchanged = { role: "user", content: "ok" };
        const payload = {
            messages: [
                unchanged,
                { role: "tool", tool_call_id: "call-1", content: `x${LONE_HIGH}` },
            ],
        };
        const result = sanitizeJsonStrings(payload);

        expect(result.value).not.toBe(payload);
        expect(result.value.messages).not.toBe(payload.messages);
        expect(result.value.messages[0]).toBe(unchanged);
    });
});
