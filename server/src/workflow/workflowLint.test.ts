import { describe, expect, it } from 'vitest';

import { lintWorkflowDocument } from '@/workflow/workflowLint.js';

const doc = (steps: unknown[], extra: Record<string, unknown> = {}) => ({
    document: {
        dsl: '1.0.0',
        name: 'demo',
        input: {
            schema: {
                type: 'object',
                properties: { requirement: { type: 'string' } },
            },
        },
    },
    do: steps,
    ...extra,
});

const codes = (result: Awaited<ReturnType<typeof lintWorkflowDocument>>) =>
    result.diagnostics.map((item) => item.code);

describe('workflow lint (compile check)', () => {
    it('passes a well-formed workflow and keeps info out of diagnostics', async () => {
        const result = await lintWorkflowDocument(doc([
            { plan: { call: 'agent', with: { prompt: 'Plan ${ .inputs.requirement }' } } },
            { done: { set: { ok: true } } },
        ]));
        expect(result.ok).toBe(true);
        expect(result.diagnostics).toEqual([]);
        expect(result.stepCount).toBe(2);
    });

    it('reports declaration info separately', async () => {
        const result = await lintWorkflowDocument(doc([
            { done: { set: { ok: true } } },
        ]));
        expect(result.ok).toBe(true);
        expect(result.diagnostics).toEqual([]);
        expect(result.infos.map((item) => item.code)).toEqual(['input_unused']);
        expect(result.infoCount).toBe(1);
    });

    it('detects expression syntax errors in when and templates', async () => {
        const result = await lintWorkflowDocument(doc([
            { bad: { when: '${ .inputs.a == }', set: { x: 1 } } },
            { worse: { call: 'agent', with: { prompt: 'x ${ .inputs.a + }' } } },
            { unclosed: { when: '${ .inputs.a', set: { x: 1 } } },
        ]));
        expect(result.ok).toBe(false);
        expect(codes(result)).toEqual(['expr_syntax', 'expr_syntax', 'expr_syntax']);
        expect(result.errorCount).toBe(3);
    });

    it('detects unknown and forward step references and undeclared inputs', async () => {
        const result = await lintWorkflowDocument(doc([
            {
                first: {
                    set: { a: '${steps.missing.output}' },
                },
            },
            {
                second: {
                    set: { b: '${steps.third.output} ${inputs.ghost}' },
                },
            },
            { third: { set: { c: true } } },
        ]));
        const found = codes(result);
        expect(found).toContain('steps_ref_unknown');
        expect(found).toContain('steps_ref_forward');
        expect(found).toContain('inputs_ref_undeclared');
        expect(result.ok).toBe(false);
    });

    it('detects duplicate step names, unsupported then and steps after exit', async () => {
        const result = await lintWorkflowDocument(doc([
            { build: { set: { a: 1 }, then: 'stop' } },
            { build: { set: { a: 2 } } },
            { stop: { set: { done: true }, then: 'exit' } },
            { skipped: { set: { never: true } } },
        ]));
        const found = codes(result);
        expect(found).toContain('duplicate_step_name');
        expect(found).toContain('then_unknown');
        expect(found).toContain('step_after_exit');
        expect(result.ok).toBe(false);
    });

    it('validates step kinds and required with-fields', async () => {
        const result = await lintWorkflowDocument(doc([
            { a: { call: 'bogus' } },
            { b: { run: { script: 'x.py' } } },
            { c: { when: true } },
            { d: { call: 'agent', with: { prompt: '   ' } } },
            { e: { call: 'tool', with: {} } },
            { f: { call: 'shell', with: {} } },
            { g: { call: 'http', with: {} } },
            { h: { call: 'evaluator', with: {} } },
            { i: { call: 'workflow', with: {} } },
            { j: { emit: { topic: 'x' } } },
            { k: { for: { each: 'item' }, do: [{ n: { set: { x: 1 } } }] } },
        ]));
        const found = codes(result);
        expect(found).toContain('call_unknown');
        expect(found).toContain('run_unknown');
        expect(found).toContain('step_no_operation');
        expect(found).toContain('with_missing_prompt');
        expect(found).toContain('with_missing_tool');
        expect(found).toContain('with_missing_command');
        expect(found).toContain('with_missing_url');
        expect(found).toContain('with_missing_target');
        expect(found).toContain('with_missing_workflow');
        expect(found).toContain('step_event_unsupported');
        expect(found).toContain('for_in_missing');
        expect(result.ok).toBe(false);
    });

    it('applies tool policy checks to with.tools', async () => {
        const result = await lintWorkflowDocument(doc([
            {
                agent: {
                    call: 'agent',
                    with: {
                        prompt: 'hi',
                        tools: ['read_file', 'run_workflow', 'file_write', 'not_a_tool'],
                    },
                },
            },
            {
                evaluator: {
                    call: 'evaluator',
                    with: { target: 'out.md', tools: ['read_file', 'file_write'] },
                },
            },
        ]), { knownTools: ['read_file', 'list_files', 'file_write'] });
        const byCode = result.diagnostics.map((item) => `${item.code}:${item.path}`);
        expect(byCode.some((entry) => entry.startsWith('tool_forbidden'))).toBe(true);
        expect(byCode.some((entry) => entry.startsWith('tool_unknown'))).toBe(true);
        expect(byCode.some((entry) => entry.startsWith('tool_readonly'))).toBe(true);
        expect(result.ok).toBe(true); // 都是 warning，不阻止执行

        const invalid = await lintWorkflowDocument(doc([
            { agent: { call: 'agent', with: { prompt: 'hi', tools: 'read_file' } } },
        ]));
        expect(codes(invalid)).toContain('tools_invalid');
        expect(invalid.ok).toBe(false);
    });

    it('validates output schema, secrets and duration configs', async () => {
        const result = await lintWorkflowDocument(doc([
            {
                extract: {
                    call: 'agent',
                    with: {
                        prompt: 'hi',
                        apiKey: 'sk-live-1234567890',
                    },
                    output: {
                        schema: {
                            type: 'str',
                            required: [1],
                            properties: 'nope',
                            anyOf: [],
                        },
                    },
                },
            },
            { waitTooLong: { wait: 'soon' } },
            {
                retry: {
                    try: [{ t: { set: { x: 1 } } }],
                    catch: { retry: { limit: -1, delay: 'later' }, do: [{ c: { set: { x: 2 } } }] },
                },
            },
            { timeout: { set: { x: 1 }, timeout: { after: 'never' } } },
        ]));
        const found = codes(result);
        expect(found).toContain('secret_literal');
        expect(found).toContain('output_schema_invalid');
        expect(found).toContain('wait_invalid');
        expect(found).toContain('retry_invalid');
        expect(found.filter((code) => code === 'output_schema_invalid').length).toBeGreaterThanOrEqual(3);
        expect(result.ok).toBe(false);
    });

    it('checks referenced .workflow assets in deep mode', async () => {
        const workflow = doc([
            {
                run: {
                    call: 'shell',
                    with: { command: 'pwsh -File .workflow/tools/missing.ps1' },
                },
            },
        ]);
        const shallow = await lintWorkflowDocument(workflow);
        expect(codes(shallow)).not.toContain('asset_missing');

        const deep = await lintWorkflowDocument(workflow, {
            deep: true,
            fileExists: async (relative) => relative === '.workflow/tools/missing.ps1' ? false : true,
        });
        expect(codes(deep)).toContain('asset_missing');
        expect(deep.ok).toBe(false);
    });

    it('supports code filtering and issue limits', async () => {
        const result = await lintWorkflowDocument(doc([
            { a: { call: 'bogus' } },
            { b: { call: 'agent', with: {} } },
        ]), { codes: ['with_missing_prompt'], maxIssues: 1 });
        expect(codes(result)).toEqual(['with_missing_prompt']);
    });
});
