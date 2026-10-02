export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

const readTokenCount = (value: unknown): number | null => {
    if (value === undefined || value === null) return null;
    const count = Number(value);
    return Number.isFinite(count) && count >= 0 ? Math.trunc(count) : null;
};

export const normalizeTokenUsage = (usage: unknown): TokenUsage | null => {
    if (!usage || typeof usage !== 'object') return null;

    const value = usage as Record<string, unknown>;
    const input = readTokenCount(value.prompt_tokens ?? value.input_tokens ?? value.promptTokens ?? value.inputTokens);
    const output = readTokenCount(value.completion_tokens ?? value.output_tokens ?? value.completionTokens ?? value.outputTokens);
    const total = readTokenCount(value.total_tokens ?? value.totalTokens);

    if (input === null && output === null && total === null) return null;

    const inputTokens = input ?? 0;
    const outputTokens = output ?? 0;
    return {
        inputTokens,
        outputTokens,
        totalTokens: total ?? inputTokens + outputTokens,
    };
};

export const accumulateTokenUsage = (
    current: TokenUsage | null,
    next: unknown,
): TokenUsage | null => {
    const normalized = normalizeTokenUsage(next);
    if (!normalized) return current;
    if (!current) return normalized;

    return {
        inputTokens: current.inputTokens + normalized.inputTokens,
        outputTokens: current.outputTokens + normalized.outputTokens,
        totalTokens: current.totalTokens + normalized.totalTokens,
    };
};