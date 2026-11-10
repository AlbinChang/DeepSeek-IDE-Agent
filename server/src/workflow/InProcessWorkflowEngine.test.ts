import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InProcessWorkflowEngine } from '@/workflow/InProcessWorkflowEngine.js';
import { WorkflowRunStore } from '@/workflow/WorkflowRunStore.js';
import type { WorkflowStepExecutor } from '@/workflow/WorkflowStepExecutor.js';
import type { WorkflowEvent } from '@/workflow/types.js';

class FakeExecutor implements WorkflowStepExecutor {
    public calls: Array<{ kind: string; stepPath: string; prompt?: string }> = [];
    public handler: ((kind: string, definition: Record<string, any>, ctx: any) => Promise<any>) | null = null;

    public async execute(kind: string, definition: Record<string, any>, ctx: any) {
        this.calls.push({ kind, stepPath: ctx.stepPath, prompt: definition.with?.prompt });
        if (this.handler) return this.handler(kind, definition, ctx);
        if (kind === 'approval') {
            return {
                approval: {
                    stepPath: ctx.stepPath,
                    message: definition.with?.message,
                    requestedAt: Date.now(),
                },
            };
        }
        return { output: `${kind}:${definition.with?.prompt || ''}` };
    }
}

const workflowYaml = (options: { approval?: boolean; requireName?: boolean; name?: string } = {}) => {
    const workflowName = options.name || 'demo';
    const steps = options.approval
        ? [
            '  - approve:\n      call: approval\n      with:\n        message: "确认继续？"',
            '  - after:\n      call: agent\n      with:\n        prompt: "after ${ .inputs.name }"',
        ]
        : [
            '  - work:\n      call: agent\n      with:\n        prompt: "hello ${ .inputs.name }"',
            '  - finish:\n      set:\n        done: true',
        ];
    return [
        'document:',
        '  dsl: 1.0.0',
        '  namespace: test',
        `  name: ${workflowName}`,
        '  version: 1.0.0',
        '  title: Demo',
        '  input:',
        '    schema:',
        '      type: object',
        options.requireName === false ? '' : '      required: [name]',
        '      properties:',
        '        name: { type: string }',
        'do:',
        ...steps,
        '',
    ].filter((line) => line !== '').join('\n');
};

async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 3000): Promise<T> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const value = await fn();
        if (value) return value as T;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('waitFor timed out');
}

describe('InProcessWorkflowEngine', () => {
    let root: string;
    let executor: FakeExecutor;
    let engine: InProcessWorkflowEngine;
    let events: WorkflowEvent[];
    const userId = 'workflow-user';

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'workflow-engine-'));
        await mkdir(path.join(root, '.workflow'), { recursive: true });
        await writeFile(path.join(root, '.workflow', 'demo.workflow.yaml'), workflowYaml(), 'utf8');
        executor = new FakeExecutor();
        events = [];
        engine = new InProcessWorkflowEngine({
            executor,
            maxWorkers: 2,
            maxQueueSize: 10,
            maxConcurrentRunsPerWorkflow: 1,
            maxRunDurationMs: 10_000,
            maxStoredRuns: 10,
        });
        engine.setEventBus({ publish: (event) => events.push(event) });
    });

    afterEach(async () => {
        await engine.shutdown();
        await rm(root, { recursive: true, force: true });
    });

    it('runs a workflow to completion and persists steps/events', async () => {
        const result = await engine.startRun({
            userId,
            root,
            name: 'demo',
            inputs: { name: 'Ada' },
            wait: true,
            timeoutSeconds: 5,
        });

        expect(result.ok).toBe(true);
        expect(result.status).toBe('succeeded');
        expect(result.run?.steps.find((step) => step.name === 'work')?.status).toBe('succeeded');
        expect(result.run?.steps.find((step) => step.name === 'finish')?.status).toBe('succeeded');
        expect(executor.calls[0].prompt).toBe('hello Ada');
        expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
            'run.queued',
            'run.started',
            'step.started',
            'step.output',
            'run.completed',
        ]));

        const persisted = await new WorkflowRunStore(root).read(result.runId!);
        expect(persisted?.status).toBe('succeeded');
        expect(engine.getStats()).toEqual({ active: 0, queued: 0, workers: [] });
    });

    it('validates required inputs and applies defaults', async () => {
        const missing = await engine.startRun({
            userId,
            root,
            name: 'demo',
            inputs: {},
        });
        expect(missing.ok).toBe(false);
        expect(missing.error).toContain('Missing required input: name');

        const provided = await engine.startRun({
            userId,
            root,
            name: 'demo',
            inputs: { name: 'Ada' },
            wait: true,
            timeoutSeconds: 5,
        });
        expect(provided.ok).toBe(true);
        expect(provided.run?.inputs).toEqual({ name: 'Ada' });
    });

    it('pauses for approval and resumes from the next top-level step', async () => {
        await writeFile(path.join(root, '.workflow', 'approval.workflow.yaml'), workflowYaml({ approval: true, name: 'approval' }), 'utf8');

        const first = await engine.startRun({
            userId,
            root,
            name: 'approval',
            inputs: { name: 'Ada' },
            wait: true,
            timeoutSeconds: 5,
        });
        expect(first.ok).toBe(true);
        expect(first.status).toBe('waiting_approval');
        expect(first.run?.approval?.stepPath).toContain('/approve');

        const runId = first.runId!;
        expect(await engine.resumeRun({ userId, root, runId, decision: 'maybe' })).toBe(false);
        expect(await engine.resumeRun({ userId, root, runId, decision: 'approve' })).toBe(true);

        const done = await waitFor(async () => {
            const run = await engine.getRun({ userId, root, runId });
            return run?.status === 'succeeded' ? run : undefined;
        });
        expect(done.approval).toBeUndefined();
        expect(done.steps.find((step) => step.name === 'approve')?.status).toBe('succeeded');
        expect(done.steps.find((step) => step.name === 'after')?.status).toBe('succeeded');
        expect(executor.calls.some((call) => call.prompt === 'after Ada')).toBe(true);
    });

    it('cancels a waiting approval run when rejected', async () => {
        await writeFile(path.join(root, '.workflow', 'approval.workflow.yaml'), workflowYaml({ approval: true, name: 'approval' }), 'utf8');

        const first = await engine.startRun({
            userId,
            root,
            name: 'approval',
            inputs: { name: 'Ada' },
            wait: true,
            timeoutSeconds: 5,
        });
        expect(first.status).toBe('waiting_approval');

        expect(await engine.resumeRun({
            userId,
            root,
            runId: first.runId!,
            decision: 'reject',
        })).toBe(true);

        const run = await engine.getRun({ userId, root, runId: first.runId! });
        expect(run?.status).toBe('cancelled');
        expect(run?.steps.find((step) => step.name === 'approve')?.status).toBe('cancelled');
    });

    it('cancels an active run', async () => {
        executor.handler = () => new Promise((resolve) => {
            setTimeout(() => resolve({ output: 'late' }), 200);
        });

        const started = await engine.startRun({ userId, root, name: 'demo', inputs: { name: 'Ada' } });
        expect(started.ok).toBe(true);
        await waitFor(async () => (await engine.getRun({ userId, root, runId: started.runId! }))?.status === 'running');

        expect(await engine.cancelRun({ userId, root, runId: started.runId! })).toBe(true);

        const run = await waitFor(async () => {
            const current = await engine.getRun({ userId, root, runId: started.runId! });
            return current?.status === 'cancelled' ? current : undefined;
        });
        expect(run.status).toBe('cancelled');
    });

    it('limits concurrency per workflow and drains the queue', async () => {
        engine = new InProcessWorkflowEngine({
            executor,
            maxWorkers: 2,
            maxQueueSize: 10,
            maxConcurrentRunsPerWorkflow: 1,
            maxRunDurationMs: 10_000,
            maxStoredRuns: 10,
        });
        engine.setEventBus({ publish: (event) => events.push(event) });

        let release: (() => void) | null = null;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        executor.handler = async () => {
            await gate;
            return { output: 'done' };
        };

        const first = await engine.startRun({ userId, root, name: 'demo', inputs: { name: 'A' } });
        const second = await engine.startRun({ userId, root, name: 'demo', inputs: { name: 'B' } });
        expect(first.ok && second.ok).toBe(true);

        const saturated = await waitFor(async () => {
            const stats = engine.getStats();
            return stats.active === 1 && stats.queued === 1 ? stats : undefined;
        });
        expect(saturated.active).toBe(1);
        expect(saturated.queued).toBe(1);

        release?.();
        await waitFor(async () => {
            const stats = engine.getStats();
            return stats.active === 0 && stats.queued === 0 ? stats : undefined;
        });

        const firstRun = await engine.getRun({ userId, root, runId: first.runId! });
        const secondRun = await engine.getRun({ userId, root, runId: second.runId! });
        expect(firstRun?.status).toBe('succeeded');
        expect(secondRun?.status).toBe('succeeded');
    });

    it('marks stale running runs as interrupted and re-enqueues queued runs', async () => {
        const store = new WorkflowRunStore(root);
        const staleId = store.newRunId();
        await store.create({
            schemaVersion: 1,
            runId: staleId,
            workflow: { name: 'demo', path: '.workflow/demo.workflow.yaml' },
            workflowName: 'demo',
            workflowPath: '.workflow/demo.workflow.yaml',
            userId,
            root,
            status: 'running',
            inputs: { name: 'Stale' },
            createdAt: Date.now(),
            startedAt: Date.now(),
            steps: [],
            lastSeq: 0,
        });

        const freshEngine = new InProcessWorkflowEngine({ executor, maxWorkers: 1, maxQueueSize: 10 });
        freshEngine.setEventBus({ publish: (event) => events.push(event) });
        await freshEngine.reconcile(root);

        const stale = await store.read(staleId);
        expect(stale?.status).toBe('interrupted');
        await freshEngine.shutdown();
    });

    it('marks active runs interrupted and keeps queued runs for the next start', async () => {
        engine = new InProcessWorkflowEngine({
            executor,
            maxWorkers: 1,
            maxQueueSize: 10,
            maxConcurrentRunsPerWorkflow: 1,
            maxRunDurationMs: 10_000,
            maxStoredRuns: 10,
        });
        engine.setEventBus({ publish: (event) => events.push(event) });

        executor.handler = () => new Promise(() => {});
        const running = await engine.startRun({ userId, root, name: 'demo', inputs: { name: 'A' } });
        const queued = await engine.startRun({ userId, root, name: 'demo', inputs: { name: 'B' } });
        expect(running.ok && queued.ok).toBe(true);
        await waitFor(async () => (await engine.getRun({ userId, root, runId: running.runId! }))?.status === 'running');

        await engine.shutdown();

        const store = new WorkflowRunStore(root);
        expect((await store.read(running.runId!))?.status).toBe('interrupted');
        expect((await store.read(queued.runId!))?.status).toBe('queued');

        const nextExecutor = new FakeExecutor();
        const nextEngine = new InProcessWorkflowEngine({
            executor: nextExecutor,
            maxWorkers: 1,
            maxQueueSize: 10,
            maxConcurrentRunsPerWorkflow: 1,
            maxRunDurationMs: 10_000,
            maxStoredRuns: 10,
        });
        nextEngine.setEventBus({ publish: (event) => events.push(event) });
        engine = nextEngine;
        await nextEngine.reconcile(root);

        const resumed = await waitFor(async () => {
            const run = await nextEngine.getRun({ userId, root, runId: queued.runId! });
            return run?.status === 'succeeded' ? run : undefined;
        });
        expect(resumed.status).toBe('succeeded');
    });

    it('rejects unknown workflows and invalid definitions', async () => {
        const missing = await engine.startRun({ userId, root, name: 'missing' });
        expect(missing.ok).toBe(false);
        expect(missing.error).toContain('Workflow not found');

        await writeFile(path.join(root, '.workflow', 'invalid.workflow.yaml'), 'document:\n  name: invalid\ndo: []\n', 'utf8');
        const invalid = await engine.startRun({ userId, root, name: 'invalid' });
        expect(invalid.ok).toBe(false);
        expect(invalid.error).toBe('WORKFLOW_VALIDATION_FAILED');
        expect(invalid.issues?.length).toBeGreaterThan(0);
    });
});
