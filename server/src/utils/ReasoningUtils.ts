const REASONING_KEYS = [
    "reasoning_content",
    "reasoning",
    "reasoning_details",
    "thinking_content",
    "thinking",
] as const;

function flattenReasoningValue(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    if (Array.isArray(value)) {
        return value
            .map((item) => flattenReasoningValue(item))
            .filter(Boolean)
            .join("");
    }

    if (value && typeof value === "object") {
        const candidate = value as Record<string, unknown>;

        for (const key of ["content", "text", "value", ...REASONING_KEYS]) {
            const nested = flattenReasoningValue(candidate[key]);
            if (nested) {
                return nested;
            }
        }

        if (Array.isArray(candidate.summary)) {
            const summary = flattenReasoningValue(candidate.summary);
            if (summary) {
                return summary;
            }
        }
    }

    return "";
}

export function extractReasoningText(payload: unknown): string {
    if (!payload || typeof payload !== "object") {
        return "";
    }

    const source = payload as Record<string, unknown>;
    for (const key of REASONING_KEYS) {
        const reasoning = flattenReasoningValue(source[key]);
        if (reasoning) {
            return reasoning;
        }
    }

    return "";
}

export function hasReasoningField(payload: unknown): boolean {
    if (!payload || typeof payload !== "object") {
        return false;
    }

    const source = payload as Record<string, unknown>;
    return REASONING_KEYS.some((key) => Object.prototype.hasOwnProperty.call(source, key));
}