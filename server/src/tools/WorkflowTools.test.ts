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
});
