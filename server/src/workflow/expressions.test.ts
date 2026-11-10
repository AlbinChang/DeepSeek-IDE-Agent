import { describe, expect, it } from 'vitest';

import {
    evaluateExpression,
    parseDurationMs,
    resolveDeep,
    resolveTemplate,
    type WorkflowExpressionContext,
} from '@/workflow/expressions.js';

const createContext = (): WorkflowExpressionContext => ({
    inputs: {
        name: 'demo',
        count: 5,
        list: ['a', 'b', 'c'],
        enabled: true,
        nested: { value: 'x' },
    },
    env: { PATH: '/usr/bin', DEEPSEEK_API_KEY: '******' },
    workspace: '/workspace',
    run: { id: 'wf-1', traceId: 'trace-1' },
    steps: {
        plan: { status: 'succeeded', output: { files: ['a.ts'], steps: ['one'] } },
        failed: { status: 'failed', error: 'boom' },
    },
    context: { branch: 'main' },
});

describe('workflow expressions', () => {
    it('reads paths, array indexes and step outputs', () => {
        const ctx = createContext();
        expect(evaluateExpression('.inputs.name', ctx)).toBe('demo');
        expect(evaluateExpression('.inputs.list[1]', ctx)).toBe('b');
        expect(evaluateExpression('.steps.plan.output.files[0]', ctx)).toBe('a.ts');
        expect(evaluateExpression('.context.branch', ctx)).toBe('main');
        expect(evaluateExpression('.', ctx)).toBe(ctx);
    });

    it('supports comparisons and boolean operators', () => {
        const ctx = createContext();
        expect(evaluateExpression('.inputs.count > 3', ctx)).toBe(true);
        expect(evaluateExpression(".inputs.name == 'demo' && .inputs.enabled", ctx)).toBe(true);
        expect(evaluateExpression(".inputs.name != 'demo' || .inputs.count < 1", ctx)).toBe(false);
        expect(evaluateExpression('!.inputs.enabled', ctx)).toBe(false);
    });

    it('supports arithmetic and filters', () => {
        const ctx = createContext();
        expect(evaluateExpression('.inputs.count * 2 + 1', ctx)).toBe(11);
        expect(evaluateExpression(".inputs.missing | default('fallback')", ctx)).toBe('fallback');
        expect(evaluateExpression('.inputs.list | length', ctx)).toBe(3);
        expect(evaluateExpression(".inputs.list | join('-')", ctx)).toBe('a-b-c');
        expect(evaluateExpression(".inputs.name | upper", ctx)).toBe('DEMO');
        expect(evaluateExpression('.inputs.nested | json', ctx)).toBe('{"value":"x"}');
    });

    it('interpolates templates and preserves typed full expressions', () => {
        const ctx = createContext();
        expect(resolveTemplate('Hello ${ .inputs.name }', ctx)).toBe('Hello demo');
        expect(resolveTemplate('${ .inputs.count }', ctx)).toBe(5);
        expect(resolveTemplate('${ .inputs.list }', ctx)).toEqual(['a', 'b', 'c']);
    });

    it('resolves nested objects without executing JS', () => {
        const ctx = createContext();
        expect(resolveDeep({
            prompt: 'Plan for ${ .inputs.name }',
            limit: '${ .inputs.count }',
            nested: ['${ .context.branch }'],
        }, ctx)).toEqual({
            prompt: 'Plan for demo',
            limit: 5,
            nested: ['main'],
        });
        expect(() => evaluateExpression('(function(){ return 1 })()', ctx)).toThrow();
        expect(() => evaluateExpression('process.exit(0)', ctx)).toThrow();
    });

    it('blocks prototype access', () => {
        const ctx = createContext();
        expect(evaluateExpression('.inputs.__proto__', ctx)).toBeUndefined();
        expect(evaluateExpression(".inputs['constructor']", ctx)).toBeUndefined();
    });

    it('parses durations from numbers, objects and ISO strings', () => {
        expect(parseDurationMs(1500)).toBe(1500);
        expect(parseDurationMs({ seconds: 2, minutes: 1 })).toBe(62_000);
        expect(parseDurationMs('30s')).toBe(30_000);
        expect(parseDurationMs('PT5M')).toBe(300_000);
        expect(parseDurationMs('1h')).toBe(3_600_000);
        expect(parseDurationMs('invalid')).toBeUndefined();
    });

    it('rejects oversized expressions', () => {
        const ctx = createContext();
        expect(() => evaluateExpression(`'${'a'.repeat(5000)}'`, ctx)).toThrow('超过');
    });
});
