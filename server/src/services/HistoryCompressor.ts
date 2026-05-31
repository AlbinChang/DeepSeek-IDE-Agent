/**
 * 历史消息 Token 估算工具。
 *
 * 原含有 AI 驱动的语义压缩能力（compress/loadConfig），经代码分析确认从未被调用，
 * 实际压缩逻辑已简化为 HistoryOptimizerService 中的过滤 + 截断策略。
 * 仅保留 estimateTokens 作为轻量 Token 估算器。
 */

export class HistoryCompressor {
    /**
     * 预计算消息数组的 JSON 字节总数（UTF-8），供后续零开销 Token 估算复用。
     * 避免在多处重复 JSON.stringify 整个数组。
     */
    static computeByteLength(messages: any[]): number {
        // 每条消息单独序列化后累加，加上 JSON 数组开销：[ ] + 逗号分隔符
        if (messages.length === 0) return 2; // "[]"
        let sum = 0;
        for (const m of messages) {
            sum += Buffer.byteLength(JSON.stringify(m), 'utf8');
        }
        // 数组开销：首尾 [ ] = 2，n-1 个逗号 = n-1，总计 n+1
        return sum + messages.length + 1;
    }

    /** 简单 Token 估算：UTF-8 字节数 / 4 */
    static estimateTokens(messages: any[]): number {
        return HistoryCompressor.computeByteLength(messages) / 4;
    }

    /** 从预计算的字节总数估算 Token，零序列化开销 */
    static estimateTokensFromByteLength(totalBytes: number): number {
        return totalBytes / 4;
    }
}
