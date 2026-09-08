import { extractReasoningText, hasReasoningField } from "../utils/ReasoningUtils.js";
import { config as globalConfig } from "@/config/index.js";

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
 * - 维持固定前缀（system + 历史  + pinned user intent）
 * - 按字节阈值裁剪历史，避免上下文无限膨胀
 * - 校验工具调用链完整性，防止 API 400
 */
export class MessagePreparationService {
    public static buildMessages(options: MessagePreparationOptions): any[] {
        const {
            systemPrompt,
            pinnedUserMessage,
            incomingMessages,
            pinnedUserPrefix = "",
            minMessagesBeforeTrim = 10,
            maxBytes = globalConfig.agent.maxHistoryBytes,
            lowWatermarkBytes = globalConfig.agent.lowWatermarkBytes,
        } = options;

        const result: any[] = [{ role: "system", content: systemPrompt }];
        const pinnedUserMsg = { role: "user", content: `${pinnedUserPrefix}${pinnedUserMessage}` };

        let msgsToProcess = [...incomingMessages];

        // 找到 pinnedUserMsg 在 incomingMessages 中的索引
        const pinnedUserIndex = msgsToProcess.findIndex(
            (m) => m.role === "user" && m.content === pinnedUserMsg.content
        );

        // pinnedUserIndex之前的消息不做裁剪，直接加入结果
        if (pinnedUserIndex > 0) {
            result.push(...msgsToProcess.slice(1, pinnedUserIndex+1)); //1是因为第0条是system消息，已经加入result了
            msgsToProcess = msgsToProcess.slice(pinnedUserIndex+1);
        }
        else
        {
            // 如果 pinnedUserMsg 不在 incomingMessages 中，则将其加入结果
            result.push(pinnedUserMsg);
        }

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

        // 单次反向扫描构建 tool_call 响应状态表：tool_call_id → 是否存在后续 tool 消息回复
        const toolCallHasResponse = new Map<string, boolean>();
        for (let i = msgsToProcess.length - 1; i >= 0; i--) {
            const m = msgsToProcess[i];
            if (m.role === "tool" && m.tool_call_id) {
                toolCallHasResponse.set(m.tool_call_id, true);
            }
        }

        // 【修复 400 工具链断裂】幸存 tool_call_id 集合：仅登记「tool_calls 未被删除」的 assistant 消息。
        // tool 消息只允许引用幸存集合中的 id，从根上保证输出序列合法：
        //   - assistant(tool_calls) 之后必有对应 tool 消息（API 400 防御）
        //   - 不残留孤儿 tool 消息（其 assistant 被裁剪或 tool_calls 被删除时一并丢弃）
        // 旧的 preRole 检查会在「system 指令插入工具结果之间」时误删后续 tool 消息，
        // 而 assistant 的 tool_calls 因响应表仍视为齐全而被保留 → 触发 DeepSeek 400。
        const survivingCallIds = new Set<string>();

        for (let i = 0; i < msgsToProcess.length; i++) {
            const m = msgsToProcess[i];
            if (m.role === "system") {
                if (m.content !== systemPrompt) {
                    result.push({ role: "system", content: m.content });
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

            if (m.role === "tool") {
                // 孤儿 tool 消息（对应 assistant 被裁剪，或 assistant 的 tool_calls 已被删除）→ 丢弃
                if (!survivingCallIds.has(m.tool_call_id)) {
                    continue;
                }
            }

            if (m.role === "assistant" && Array.isArray(clean.tool_calls) && clean.tool_calls.length > 0) {
                clean.reasoning_content = hasReasoningField(m) ? extractReasoningText(m) : "";

                // O(1) 检查每个 tool_call 是否有响应（替代原 O(N) 向前扫描）
                const allResponded = clean.tool_calls.every(
                    (tc: any) => toolCallHasResponse.has(tc.id)
                );
                if (!allResponded) {
                    // 响应不完整：删除 tool_calls 避免 API 400，且不登记幸存集合
                    // （其后残余的 tool 消息将因不在幸存集合中而被丢弃）
                    delete clean.tool_calls;
                    if (!clean.content) {
                        continue;
                    }
                } else {
                    for (const tc of clean.tool_calls) {
                        if (tc.id) survivingCallIds.add(tc.id);
                    }
                }
            }

            result.push(clean);
        }

        return result;
    }
}
