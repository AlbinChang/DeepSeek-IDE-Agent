import { describe, expect, it } from 'vitest';
import { accumulateTokenUsage, normalizeTokenUsage } from './TokenUsage.js';

describe('TokenUsage', () => {
    it('normalizes OpenAI-compatible usage fields', () => {
        expect(normalizeTokenUsage({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 })).toEqual({
            inputTokens: 120,
            outputTokens: 30,
            totalTokens: 150,
        });
    });

    it('supports input/output aliases and derives a missing total', () => {
        expect(normalizeTokenUsage({ input_tokens: '12', output_tokens: 8 })).toEqual({
            inputTokens: 12,
            outputTokens: 8,
            totalTokens: 20,
        });
    });

    it('accumulates multiple model calls and ignores missing usage', () => {
        const first = accumulateTokenUsage(null, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
        const second = accumulateTokenUsage(first, { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 });

        expect(accumulateTokenUsage(second, null)).toEqual({
            inputTokens: 140,
            outputTokens: 30,
            totalTokens: 170,
        });
    });
});