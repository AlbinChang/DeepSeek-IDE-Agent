import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkflowService } from '@/workflow/WorkflowService.js';
import type { WorkflowEngine } from '@/workflow/types.js';
import { WorkflowTools } from '@/tools/WorkflowTools.js';

const createEngine = (): WorkflowEngine => ({
    startRun: vi.fn(async () => ({ ok: true, runId: 'wf-run-1', status: 'queued' as const, position: 0 })),
    getRun: vi.fn(async () => ({
        schemaVersion: 1 as const,
        runId: 'wf-run-1',
        workflow: { name: 'demo', path: '.workflow/demo.workflow.yaml' },
        workflowName: 'demo',
        workflowPath: '.workflow/demo.workflow.yaml',
        userId: 'user-1',
        root: '/workspace',
        status: 'succeeded' as const,
        inputs: {},
        createdAt: 1,
        steps: [],
    })),
    listRuns: vi.fn(async () => []),
    cancelRun: vi.fn(async () => true),
    resumeRun: vi.fn(async () => true),
    cancelUserRuns: vi.fn(async () => {}),
    getStats: vi.fn(() => ({ active: 0, queued: 0, workers: [] })),
    shutdown: vi.fn(async () => {}),
});

const tool = (name: string) => {
    const definition = WorkflowTools.getDefinitions().find((entry) => entry.name === name);
    if (!definition) throw new Error(`tool not found: ${name}`);
    return definition;
};

const context = (root: string) => ({ userId: 'user-1', workspaceRoot: root, traceId: 'trace-1' });

describe('WorkflowTools', () => {
    let root: string;
    let engine: WorkflowEngine;
    const service = WorkflowService.getInstance();

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'workflow-tools-'));
        await mkdir(path.join(root, '.workflow'), { recursive: true });
        await writeFile(
            path.join(root, '.workflow', 'demo.workflow.yaml'),
            'document:\n  dsl: 1.0.0\n  name: demo\n  version: 1.0.0\ndo:\n  - work:\n      call: agent\n      with:\n        prompt: hi\n',
            'utf8',
        );
        engine = createEngine();
        service.setEngine(engine);
    });

    afterEach(async () => {
        service.setEngine(null);
        await rm(root, { recursive: true, force: true });
    });

    it('lists and validates workflows from the workspace', async () => {
        const listResult: any = await tool('list_workflows').execute({}, context(root));
        expect(listResult.workflows).toHaveLength(1);
        expect(listResult.workflows[0].name).toBe('demo');

        const validation: any = await tool('validate_workflow').execute({ name: 'demo' }, context(root));
        expect(validation.validation.ok).toBe(true);
    });

    it('runs a workflow through the engine port', async () => {
        const result: any = await tool('run_workflow').execute({
            name: 'demo',
            inputs: { requirement: 'x' },
        }, context(root));

        expect(result.runId).toBe('wf-run-1');
        expect(engine.startRun).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'user-1',
            root,
            name: 'demo',
            wait: false,
        }));
    });

    it('queries, cancels and resumes runs', async () => {
        const run: any = await tool('get_workflow_run').execute({ runId: 'wf-run-1' }, context(root));
        expect(run.status).toBe('succeeded');

        const cancelled: any = await tool('cancel_workflow').execute({ runId: 'wf-run-1' }, context(root));
        expect(cancelled.cancelled).toBe(true);
        expect(engine.cancelRun).toHaveBeenCalledWith({ userId: 'user-1', root, runId: 'wf-run-1' });

        const resumed: any = await tool('resume_workflow').execute({
            runId: 'wf-run-1',
            decision: 'approve',
        }, context(root));
        expect(resumed.resumed).toBe(true);
        expect(engine.resumeRun).toHaveBeenCalledWith({
            userId: 'user-1',
            root,
            runId: 'wf-run-1',
            decision: 'approve',
        });

        await tool('resume_workflow').execute({ runId: 'wf-run-1' }, context(root));
        expect(engine.resumeRun).toHaveBeenLastCalledWith({
            userId: 'user-1',
            root,
            runId: 'wf-run-1',
            decision: undefined,
        });
    });

    it('surfaces engine errors as tool errors', async () => {
        (engine.startRun as any).mockResolvedValueOnce({ ok: false, error: 'WORKFLOW_QUEUE_FULL' });
        await expect(tool('run_workflow').execute({ name: 'demo' }, context(root)))
            .rejects.toThrow('WORKFLOW_QUEUE_FULL');
    });

    it('compiles workflows with semantic diagnostics and strict mode', async () => {
        await writeFile(
            path.join(root, '.workflow', 'broken.workflow.yaml'),
            `document:
  dsl: 1.0.0
  name: broken
  input:
    schema:
      properties:
        requirement: { type: string }
do:
  - first:
      when: "\${ .inputs.requirement == }"
      set: { a: 1 }
  - first:
      set: { a: "\${steps.missing.output}" }
  - after:
      call: agent
      with:
        prompt: "hi"
        tools: [run_workflow]
      then: stop
`,
            'utf8',
        );

        const result: any = await tool('validate_workflow').execute({ name: 'broken' }, context(root));
        expect(result.validation.ok).toBe(false);
        expect(result.validation.errorCount).toBeGreaterThan(0);
        const found = result.validation.issues.map((issue: any) => issue.code);
        expect(found).toContain('expr_syntax');
        expect(found).toContain('duplicate_step_name');
        expect(found).toContain('steps_ref_unknown');
        expect(result.summary).toContain('❌');

        const filtered: any = await tool('validate_workflow').execute({
            name: 'broken',
            codes: ['steps_ref_unknown'],
        }, context(root));
        expect(filtered.validation.issues.map((issue: any) => issue.code)).toEqual(['steps_ref_unknown']);
    });

    it('fails strict compile when only warnings remain', async () => {
        await writeFile(
            path.join(root, '.workflow', 'warn.workflow.yaml'),
            `document:
  dsl: 1.0.0
  name: warn
do:
  - only:
      call: agent
      with:
        prompt: "hi \${inputs.ghost}"
      then: stop
`,
            'utf8',
        );

        const loose: any = await tool('validate_workflow').execute({ name: 'warn' }, context(root));
        expect(loose.validation.ok).toBe(true);
        expect(loose.validation.warningCount).toBeGreaterThan(0);

        const strict: any = await tool('validate_workflow').execute({ name: 'warn', strict: true }, context(root));
        expect(strict.validation.ok).toBe(false);
        expect(strict.summary).toContain('❌');
    });

    it('links with.tools against registered tool names when provided', async () => {
        await writeFile(
            path.join(root, '.workflow', 'tools.workflow.yaml'),
            `document:
  dsl: 1.0.0
  name: tools
do:
  - use:
      call: agent
      with:
        prompt: "hi"
        tools: [read_file, totally_missing_tool]
`,
            'utf8',
        );

        const withRegistry = WorkflowTools.getDefinitions({ knownTools: () => ['read_file'] })
            .find((entry) => entry.name === 'validate_workflow')!;
        const result: any = await withRegistry.execute({ name: 'tools' }, context(root));
        const codes = result.validation.issues.map((issue: any) => issue.code);
        expect(codes).toContain('tool_unknown');
        expect(result.validation.ok).toBe(true); // 链接问题按 warning 处理
    });
});
