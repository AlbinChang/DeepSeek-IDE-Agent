/**
 * 对应技术规范：流式数据解析工具
 * 专门用于解析 OpenAI 标准流格式 (兼容 reasoning_content / reasoning 等扩展字段)
 */
import { extractReasoningText } from "@/utils/ReasoningUtils.js";

export class StreamParser {
    /**
     * 解析 OpenAI 标准流 Chunk
     * 针对 DeepSeek Reasoner 模式特殊优化
     */
    static parseChunk(chunk: any): {
        text?: string,
        reasoning?: string,
        toolCalls?: any[],
        finishReason?: string
    } {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) return {};

        const result: any = {};

        // 1. 提取思考内容 (兼容不同模型的字段别名)
        const reasoning = extractReasoningText(delta);
        if (reasoning) {
            result.reasoning = reasoning;
        }

        // 2. 提取最终回答文本内容
        if (delta.content) {
            result.text = delta.content;
        }

        // 3. 提取工具调用
        if (delta.tool_calls) {
            result.toolCalls = delta.tool_calls;
        }

        // 4. 提取结束标识
        if (chunk.choices?.[0]?.finish_reason) {
            result.finishReason = chunk.choices[0].finish_reason;
        }

        return result;
    }

    /**
     * 格式化输出到控制台或日志，保持与原逻辑相似的结构以便调试
     */
    static formatForLog(parsed: any): string {
        let logStr = '';
        if (parsed.reasoning) logStr += `[Reasoning]: ${parsed.reasoning}`;
        if (parsed.text) logStr += parsed.text;
        if (parsed.toolCalls) {
            parsed.toolCalls.forEach((tc: any) => {
                if (tc.function?.name) logStr += `\n[Main Agent] Calling tool: ${tc.function.name}`;
                if (tc.function?.arguments) logStr += `\n[Args]: ${tc.function.arguments}`;
            });
        }
        return logStr;
    }
}

