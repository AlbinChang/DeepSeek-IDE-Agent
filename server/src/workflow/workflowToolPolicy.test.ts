import { describe, expect, it } from 'vitest';
import { resolveEvaluatorTools } from '@/workflow/workflowToolPolicy.js';

describe('workflow evaluator tool policy', () => {
    it('grants calculate so numeric claims can be re-computed', () => {
        expect(resolveEvaluatorTools().has('calculate')).toBe(true);
        expect(resolveEvaluatorTools(['calculate']).has('calculate')).toBe(true);
    });
});
