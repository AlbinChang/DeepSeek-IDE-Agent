import { extractReasoningText, hasReasoningField } from "../utils/ReasoningUtils.js";

export interface MessagePreparationOptions {
    systemPrompt: string;
    pinnedUserMessage: string;
    incomingMessages: any[];
    pinnedUserPrefix?: string;
    minMessagesBeforeTrim?: number;
    maxBytes?: number;
    lowWatermarkBytes?: number;
}

/**
 * 统一的消息预处理器：
 * - 维持固定前缀（system + pinned user intent）
 * - 按字节阈值裁剪历史，避免上下文无限膨胀
 * - 校验工具调用链完整性，防止 API 400
 */
export class MessagePreparationService {
    public static buildMessages(options: MessagePreparationOptions): any[] {
        const {
            systemPrompt,
            pinnedUserMessage,
            incomingMessages,
            pinnedUserPrefix = "**当前用户意图**: \n",
            minMessagesBeforeTrim = 10,
            maxBytes = Number(process.env.AGENT_MAX_HISTORY_BYTES) || 1024 * 1024,
            lowWatermarkBytes = Number(process.env.AGENT_LOW_WATERMARK_BYTES) || 128 * 1024,
        } = options;

        const result: any[] = [{ role: "system", content: systemPrompt }];
        result.push({ role: "user", content: `${pinnedUserPrefix}${pinnedUserMessage}` });

        let msgsToProcess = [...incomingMessages];

        // 预计算每条消息的 JSON 字节数（只序列化一次每条消息），用于 O(n) 增量裁剪
        const msgJsonByteLens = msgsToProcess.map(
            m => Buffer.byteLength(JSON.stringify(m), 'utf8')
        );
        // JSON 数组序列化的开销：首尾 [ ] = 2 字节，每两个元素间一个逗号 = (n-1) 字节
        const arrayOverhead = (n: number) => (n > 0 ? n + 1 : 0); // 2 + (n-1) = n+1

        // 后缀和：suffixSum[i] = 从 i 到末尾的所有消息 JSON 字节数之和
        const n = msgsToProcess.length;
        const suffixSum = new Array(n + 1).fill(0);
        for (let i = n - 1; i >= 0; i--) {
            suffixSum[i] = suffixSum[i + 1] + msgJsonByteLens[i];
        }
        const calcTotalBytes = (startIdx: number) =>
            suffixSum[startIdx] + arrayOverhead(n - startIdx);

        let startIdx = 0;
        if (n > minMessagesBeforeTrim && calcTotalBytes(0) > maxBytes) {
            while (n - startIdx > minMessagesBeforeTrim && calcTotalBytes(startIdx) > lowWatermarkBytes) {
                // 移除队首 2 条消息：减去它们的 JSON 字节数 + 2（逗号开销）
                startIdx += 2;
            }
        }
        if (startIdx > 0) {
            msgsToProcess = msgsToProcess.slice(startIdx);
        }

        let preRole = "user";
        // 【性能优化】预构建 assistant tool_calls ID → 索引 的查找表，避免内层 O(n²) 扫描
        const assistantIndexById = new Map<string, number>();
        for (let i = 0; i < msgsToProcess.length; i++) {
            const m = msgsToProcess[i];
            if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
                for (const tc of m.tool_calls) {
                    if (tc.id) assistantIndexById.set(tc.id, i);
                }
            }
        }

        for (let i = 0; i < msgsToProcess.length; i++) {
            const m = msgsToProcess[i];
            if (m.role === "system") {
                if (m.content !== systemPrompt) {
                    result.push({ role: "system", content: m.content });
                    preRole = "system";
                }
                continue;
            }

            if (m.role === "user") {
                continue;
            }

            if (!m.role || (!m.content && !m.tool_calls && !m.tool_call_id)) continue;

            const clean: any = { role: m.role, content: m.content || "" };
            if (m.tool_calls) clean.tool_calls = m.tool_calls;
            if (m.tool_call_id) clean.tool_call_id = m.tool_call_id;

            if (m.role === "tool" && preRole !== "assistant" && preRole !== "tool") {
                continue;
            }

            if (m.role === "tool") {
                // 【性能优化】使用预构建的 Map 查找，替代 O(n) 数组扫描
                const hasMatchingCall = assistantIndexById.has(m.tool_call_id);
                if (!hasMatchingCall) {
                    continue;
                }
            }

            if (m.role === "assistant" && Array.isArray(clean.tool_calls) && clean.tool_calls.length > 0) {
                clean.reasoning_content = hasReasoningField(m) ? extractReasoningText(m) : "";

                const expectedIds = new Set(clean.tool_calls.map((tc: any) => tc.id));
                const respondedIds = new Set<string>();
                for (let j = i + 1; j < msgsToProcess.length; j++) {
                    const nxt = msgsToProcess[j];
                    if (nxt.role === "tool" && nxt.tool_call_id && expectedIds.has(nxt.tool_call_id)) {
                        respondedIds.add(nxt.tool_call_id);
                    } else if (nxt.role === "assistant" || nxt.role === "system") {
                        break;
                    }
                }
                if (respondedIds.size !== expectedIds.size) {
                    delete clean.tool_calls;
                    if (!clean.content) {
                        continue;
                    }
                }
            }

            preRole = m.role;
            result.push(clean);
        }

        return result;
    }
}
