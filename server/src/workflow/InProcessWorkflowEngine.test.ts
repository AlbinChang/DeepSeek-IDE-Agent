import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
        vi.restoreAllMocks();
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

    it('resumes nested loop approvals without repeating completed steps', async () => {
        await writeFile(path.join(root, '.workflow', 'loop-approval.workflow.yaml'), `
document:
  name: loop-approval
do:
  - loop:
      for:
        each: item
        in: [a, b]
      do:
        - before:
            call: agent
            with:
              prompt: "before \${ item }"
        - approve:
            call: approval
            with:
              message: "Approve \${ item }"
        - after:
            call: agent
            with:
              prompt: "after \${ item }"
`, 'utf8');

        const first = await engine.startRun({
            userId, root, name: 'loop-approval', wait: true, timeoutSeconds: 5,
        });
        expect(first.run?.status).toBe('waiting_approval');
        expect(first.run?.approval?.stepPath).toContain('/iter-0/');

        const runId = first.runId!;
        expect(await engine.resumeRun({ userId, root, runId, decision: 'approve' })).toBe(true);
        const second = await waitFor(async () => {
            const run = await engine.getRun({ userId, root, runId });
            return run?.status === 'waiting_approval' && run.approval?.stepPath.includes('/iter-1/')
                ? run : undefined;
        });
        expect(second.approval?.message).toBe('Approve b');
        expect(await engine.resumeRun({ userId, root, runId, decision: 'approve' })).toBe(true);

        await waitFor(async () => {
            const run = await engine.getRun({ userId, root, runId });
            return run?.status === 'succeeded' ? run : undefined;
        });
        expect(executor.calls.filter((call) => call.kind === 'agent').map((call) => call.prompt))
            .toEqual(['before a', 'after a', 'before b', 'after b']);
    });

    it('resumes an approval in a subworkflow without repeating its completed steps', async () => {
        await writeFile(path.join(root, '.workflow', 'child-approval.workflow.yaml'), `
document:
  name: child-approval
do:
  - before:
      call: agent
      with:
        prompt: child before
  - approve:
      call: approval
  - after:
      call: agent
      with:
        prompt: child after
`, 'utf8');
        await writeFile(path.join(root, '.workflow', 'parent-approval.workflow.yaml'), `
document:
  name: parent-approval
do:
  - child:
      call: workflow
      with:
        name: child-approval
  - done:
      call: agent
      with:
        prompt: parent after
`, 'utf8');

        const first = await engine.startRun({
            userId, root, name: 'parent-approval', wait: true, timeoutSeconds: 5,
        });
        expect(first.run?.status).toBe('waiting_approval');
        expect(first.run?.approval?.stepPath).toContain('/subworkflow/do/1/approve');
        const runId = first.runId!;
        expect(await engine.resumeRun({ userId, root, runId, decision: 'approve' })).toBe(true);
        await waitFor(async () => {
            const run = await engine.getRun({ userId, root, runId });
            return run?.status === 'succeeded' ? run : undefined;
        });
        expect(executor.calls.filter((call) => call.kind === 'agent').map((call) => call.prompt))
            .toEqual(['child before', 'child after', 'parent after']);
    });

    it('handles multiple fork approvals and preserves each branch context', async () => {
        await writeFile(path.join(root, '.workflow', 'fork-approval.workflow.yaml'), `
document:
  name: fork-approval
do:
  - prepare:
      set:
        shared: original
  - parallel:
      fork:
        branches:
          - do:
              - leftBefore:
                  call: agent
                  with:
                    prompt: left before
              - leftApprove:
                  call: approval
              - leftSet:
                  set:
                    shared: updated
              - leftAfter:
                  call: agent
                  with:
                    prompt: left after
          - do:
              - rightBefore:
                  call: agent
                  with:
                    prompt: right before
              - rightApprove:
                  call: approval
              - rightSet:
                  set:
                    right: done
  - finish:
      call: agent
      with:
        prompt: "\${ .context.shared } / \${ .context.right }"
`, 'utf8');

        const first = await engine.startRun({
            userId, root, name: 'fork-approval', wait: true, timeoutSeconds: 5,
        });
        expect(first.run?.status).toBe('waiting_approval');
        expect(first.run?.approval?.stepPath).toContain('/branch-0/');
        const runId = first.runId!;
        expect(await engine.resumeRun({ userId, root, runId, decision: 'approve' })).toBe(true);
        const second = await waitFor(async () => {
            const run = await engine.getRun({ userId, root, runId });
            return run?.status === 'waiting_approval' && run.approval?.stepPath.includes('/branch-1/')
                ? run : undefined;
        });
        expect(second.checkpoint?.replayFromStep).toBe(true);
        expect(await engine.resumeRun({ userId, root, runId, decision: 'approve' })).toBe(true);
        await waitFor(async () => {
            const run = await engine.getRun({ userId, root, runId });
            return run?.status === 'succeeded' ? run : undefined;
        });
        const prompts = executor.calls.filter((call) => call.kind === 'agent').map((call) => call.prompt);
        expect(prompts.filter((prompt) => prompt === 'left before')).toHaveLength(1);
        expect(prompts.filter((prompt) => prompt === 'right before')).toHaveLength(1);
        expect(prompts.filter((prompt) => prompt === 'left after')).toHaveLength(1);
        expect(prompts).toContain('updated / done');
    });

    it('serializes competing approval decisions for the same run', async () => {
        await writeFile(path.join(root, '.workflow', 'approval.workflow.yaml'), workflowYaml({ approval: true, name: 'approval' }), 'utf8');
        const first = await engine.startRun({
            userId, root, name: 'approval', inputs: { name: 'Ada' }, wait: true, timeoutSeconds: 5,
        });
        const runId = first.runId!;
        const decisions = await Promise.all([
            engine.resumeRun({ userId, root, runId, decision: 'approve' }),
            engine.resumeRun({ userId, root, runId, decision: 'approve' }),
        ]);
        expect(decisions.filter(Boolean)).toHaveLength(1);
        await waitFor(async () => {
            const run = await engine.getRun({ userId, root, runId });
            return run?.status === 'succeeded' ? run : undefined;
        });
        expect(executor.calls.filter((call) => call.prompt === 'after Ada')).toHaveLength(1);
    });

    it('serializes cancellation with approval so a cancelled run cannot restart', async () => {
        await writeFile(path.join(root, '.workflow', 'approval.workflow.yaml'), workflowYaml({ approval: true, name: 'approval' }), 'utf8');
        executor.handler = async (kind, definition, ctx) => {
            if (kind === 'approval') {
                return { approval: { stepPath: ctx.stepPath, requestedAt: Date.now() } };
            }
            return new Promise((_resolve, reject) => {
                if (ctx.abortSignal.aborted) {
                    reject(ctx.abortSignal.reason);
                } else {
                    ctx.abortSignal.addEventListener('abort', () => reject(ctx.abortSignal.reason), { once: true });
                }
            });
        };
        const first = await engine.startRun({
            userId, root, name: 'approval', inputs: { name: 'Ada' }, wait: true, timeoutSeconds: 5,
        });
        const request = { userId, root, runId: first.runId! };
        const [resumed, cancelled] = await Promise.all([
            engine.resumeRun({ ...request, decision: 'approve' }),
            engine.cancelRun(request),
        ]);
        expect([resumed, cancelled]).toEqual([true, true]);
        const final = await waitFor(async () => {
            const run = await engine.getRun(request);
            return run?.status === 'cancelled' ? run : undefined;
        });
        expect(final.status).toBe('cancelled');

        const second = await engine.startRun({
            userId, root, name: 'approval', inputs: { name: 'Ada' }, wait: true, timeoutSeconds: 5,
        });
        const secondRequest = { userId, root, runId: second.runId! };
        const [cancelFirst, resumeSecond] = await Promise.all([
            engine.cancelRun(secondRequest),
            engine.resumeRun({ ...secondRequest, decision: 'approve' }),
        ]);
        expect([cancelFirst, resumeSecond]).toEqual([true, false]);
        expect((await engine.getRun(secondRequest))?.status).toBe('cancelled');
    });

    it('enforces queue capacity for concurrent starts and approval resumes', async () => {
        await engine.shutdown();
        engine = new InProcessWorkflowEngine({
            executor, maxWorkers: 1, maxQueueSize: 1, maxConcurrentRunsPerWorkflow: 1,
        });
        await writeFile(path.join(root, '.workflow', 'approval.workflow.yaml'), workflowYaml({ approval: true, name: 'approval' }), 'utf8');
        const paused = await engine.startRun({
            userId, root, name: 'approval', inputs: { name: 'Ada' }, wait: true, timeoutSeconds: 5,
        });
        executor.handler = async (_kind, _definition, ctx) => new Promise((_resolve, reject) => {
            if (ctx.abortSignal.aborted) reject(ctx.abortSignal.reason);
            else ctx.abortSignal.addEventListener('abort', () => reject(ctx.abortSignal.reason), { once: true });
        });
        await engine.startRun({ userId, root, name: 'demo', inputs: { name: 'Ada' } });
        await waitFor(async () => engine.getStats().active === 1);
        const attempts = await Promise.all([
            engine.startRun({ userId, root, name: 'demo', inputs: { name: 'Ada' } }),
            engine.startRun({ userId, root, name: 'demo', inputs: { name: 'Ada' } }),
        ]);
        expect(attempts.filter((result) => result.ok)).toHaveLength(1);
        expect(attempts.find((result) => !result.ok)?.error).toBe('WORKFLOW_QUEUE_FULL');
        const request = { userId, root, runId: paused.runId! };
        expect(await engine.resumeRun({ ...request, decision: 'approve' })).toBe(false);
        expect((await engine.getRun(request))?.status).toBe('waiting_approval');
        expect(await engine.resumeRun({ ...request, decision: 'reject' })).toBe(true);
        expect((await engine.getRun(request))?.status).toBe('cancelled');
    });

    it('does not let workflow catch hide a persistence failure', async () => {
        await writeFile(path.join(root, '.workflow', 'disk-error.workflow.yaml'), `
document:
  name: disk-error
do:
  - guarded:
      try:
        - action:
            call: agent
            with:
              prompt: run once
      catch:
        do:
          - fallback:
              call: agent
              with:
                prompt: should not run
`, 'utf8');
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const save = WorkflowRunStore.prototype.save;
        executor.handler = async () => {
            vi.spyOn(WorkflowRunStore.prototype, 'save')
                .mockRejectedValueOnce(new Error('disk full'))
                .mockImplementation(save);
            return { output: 'finished' };
        };
        const result = await engine.startRun({
            userId, root, name: 'disk-error', wait: true, timeoutSeconds: 5,
        });
        expect(result.run?.status).toBe('interrupted');
        expect(result.run?.error).toContain('disk full');
        expect(executor.calls).toHaveLength(1);
        expect((await new WorkflowRunStore(root).read(result.runId!))?.status).toBe('interrupted');
    });

    it('does not execute or strand a run when queue event persistence fails', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const append = WorkflowRunStore.prototype.appendEvent;
        vi.spyOn(WorkflowRunStore.prototype, 'appendEvent')
            .mockRejectedValueOnce(new Error('disk full'))
            .mockImplementation(append);
        await expect(engine.startRun({
            userId, root, name: 'demo', inputs: { name: 'Ada' }, wait: true,
        })).rejects.toThrow('disk full');
        expect(engine.getStats().active).toBe(0);
        expect(engine.getStats().queued).toBe(0);
        expect(executor.calls).toHaveLength(0);
        const runs = await new WorkflowRunStore(root).list({ userId, root });
        expect(runs[0]?.status).toBe('interrupted');
    });

    it('marks a resumed run interrupted if its resume event cannot be saved', async () => {
        await writeFile(path.join(root, '.workflow', 'approval.workflow.yaml'), workflowYaml({ approval: true, name: 'approval' }), 'utf8');
        const paused = await engine.startRun({
            userId, root, name: 'approval', inputs: { name: 'Ada' }, wait: true, timeoutSeconds: 5,
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const append = WorkflowRunStore.prototype.appendEvent;
        vi.spyOn(WorkflowRunStore.prototype, 'appendEvent')
            .mockRejectedValueOnce(new Error('disk full'))
            .mockImplementation(append);
        const query = { userId, root, runId: paused.runId! };
        await expect(engine.resumeRun({ ...query, decision: 'approve' })).rejects.toThrow('disk full');
        expect(engine.getStats().queued).toBe(0);
        expect((await engine.getRun(query))?.status).toBe('interrupted');
        expect(executor.calls.filter((call) => call.kind === 'agent')).toHaveLength(0);
    });

    it('does not resolve a wait=true call immediately for very large timeoutSeconds', async () => {
        executor.handler = async (_kind, _definition, ctx) => new Promise((_resolve, reject) => {
            if (ctx.abortSignal.aborted) {
                reject(ctx.abortSignal.reason);
            } else {
                ctx.abortSignal.addEventListener('abort', () => reject(ctx.abortSignal.reason), { once: true });
            }
        });
        let settled = false;
        const started = engine.startRun({
            userId, root, name: 'demo', inputs: { name: 'Ada' }, wait: true, timeoutSeconds: 10_000_000,
        });
        void started.then(() => { settled = true; });
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(settled).toBe(false);

        const runs = await engine.listRuns({ userId, root });
        await Promise.all(runs.map((run) => engine.cancelRun({ userId, root, runId: run.runId })));
        const result = await started;
        expect(result.run?.status).toBe('cancelled');
    });

    it('persists reported token usage and enforces the budget across an approval resume', async () => {
        await engine.shutdown();
        engine = new InProcessWorkflowEngine({ executor, maxWorkers: 1, maxTokens: 10 });
        await writeFile(path.join(root, '.workflow', 'budget.workflow.yaml'), `
document:
  name: budget
do:
  - first:
      call: agent
      with: { prompt: first }
  - approve:
      call: approval
  - second:
      call: agent
      with: { prompt: second }
`, 'utf8');
        executor.handler = async (kind, _definition, ctx) => {
            if (kind === 'approval') {
                return { approval: { stepPath: ctx.stepPath, requestedAt: Date.now() } };
            }
            ctx.checkTokenBudget();
            const totalTokens = ctx.stepName === 'first' ? 6 : 5;
            const usage = { inputTokens: totalTokens, outputTokens: 0, totalTokens };
            ctx.recordUsage(usage);
            ctx.verifyTokenBudget();
            return { output: 'ok', usage };
        };
        const first = await engine.startRun({
            userId, root, name: 'budget', wait: true, timeoutSeconds: 5,
        });
        expect(first.run?.status).toBe('waiting_approval');
        expect(first.run?.usage?.totalTokens).toBe(6);
        const query = { userId, root, runId: first.runId! };
        expect(await engine.resumeRun({ ...query, decision: 'approve' })).toBe(true);
        const failed = await waitFor(async () => {
            const run = await engine.getRun(query);
            return run?.status === 'failed' ? run : undefined;
        });
        expect(failed.usage?.totalTokens).toBe(11);
        expect(failed.error).toContain('token');
        const persisted = await waitFor(async () => {
            const run = await new WorkflowRunStore(root).read(first.runId!);
            return run?.status === 'failed' ? run : undefined;
        });
        expect(persisted.usage?.totalTokens).toBe(11);
    });

    it('refuses unsafe nested replay when a completed output was truncated', async () => {
        await writeFile(path.join(root, '.workflow', 'large-approval.workflow.yaml'), `
document:
  name: large-approval
do:
  - container:
      switch:
        - when: true
          do:
            - before:
                call: agent
                with:
                  prompt: large
            - approve:
                call: approval
`, 'utf8');
        executor.handler = async (kind, _definition, ctx) => kind === 'approval'
            ? { approval: { stepPath: ctx.stepPath, requestedAt: Date.now() } }
            : { output: 'x'.repeat(100_000) };
        const first = await engine.startRun({
            userId, root, name: 'large-approval', wait: true, timeoutSeconds: 5,
        });
        expect(first.run?.status).toBe('waiting_approval');
        expect(first.run?.checkpoint?.resumeError).toContain('无法安全恢复');
        const runId = first.runId!;
        expect(await engine.resumeRun({ userId, root, runId, decision: 'approve' })).toBe(false);
        const current = await engine.getRun({ userId, root, runId });
        expect(current?.status).toBe('waiting_approval');
        expect(current?.error).toContain('无法安全恢复');
        expect(executor.calls.filter((call) => call.kind === 'agent')).toHaveLength(1);
        expect(await engine.resumeRun({ userId, root, runId, decision: 'reject' })).toBe(true);
    });

    it('requires sensitive inputs to be supplied again after a restart', async () => {
        await writeFile(path.join(root, '.workflow', 'secret-approval.workflow.yaml'), `
document:
  name: secret-approval
  input:
    schema:
      type: object
      required: [token]
      properties:
        token: { type: string }
        label: { type: string }
do:
  - approve:
      call: approval
  - after:
      call: agent
      with:
        prompt: "value \${ .inputs.token }"
`, 'utf8');
        const first = await engine.startRun({
            userId,
            root,
            name: 'secret-approval',
            inputs: { token: 'private-value', label: 'original' },
            provider: 'provider-a',
            model: 'model-b',
            concurrencyGroup: 'my-group',
            wait: true,
            timeoutSeconds: 5,
        });
        expect(first.run?.status).toBe('waiting_approval');
        expect(first.run?.inputs.token).toBe('******');
        expect(first.run?.resumeInputsRequired).toBe(true);
        const runId = first.runId!;
        expect(await engine.resumeRun({
            userId, root, runId, decision: 'approve', inputs: { token: 'wrong', label: 'original' },
        })).toBe(false);
        expect((await engine.getRun({ userId, root, runId }))?.error).toContain('不一致');

        await engine.shutdown();
        engine = new InProcessWorkflowEngine({ executor, maxWorkers: 1 });
        expect(await engine.resumeRun({ userId, root, runId, decision: 'approve' })).toBe(false);
        const paused = await engine.getRun({ userId, root, runId });
        expect(paused?.error).toContain('重新提供原始输入');
        expect(paused?.execution).toMatchObject({
            provider: 'provider-a',
            model: 'model-b',
            concurrencyGroup: 'my-group',
        });
        expect(await engine.resumeRun({
            userId, root, runId, decision: 'approve', inputs: { token: 'private-value', label: 'changed' },
        })).toBe(false);
        expect((await engine.getRun({ userId, root, runId }))?.error).toContain('不一致');
        expect(await engine.resumeRun({
            userId, root, runId, decision: 'approve', inputs: { token: 'private-value', label: 'original' },
        })).toBe(true);
        await waitFor(async () => {
            const run = await engine.getRun({ userId, root, runId });
            return run?.status === 'succeeded' ? run : undefined;
        });
        expect(executor.calls.some((call) => call.prompt === 'value private-value')).toBe(true);
    });

    it('refuses to replay an approval after a child workflow definition changes', async () => {
        const childPath = path.join(root, '.workflow', 'versioned-child.workflow.yaml');
        await writeFile(childPath, `
document:
  name: versioned-child
do:
  - approve:
      call: approval
  - work:
      call: agent
      with:
        prompt: original
`, 'utf8');
        await writeFile(path.join(root, '.workflow', 'versioned-parent.workflow.yaml'), `
document:
  name: versioned-parent
do:
  - child:
      call: workflow
      with:
        name: versioned-child
`, 'utf8');
        const started = await engine.startRun({
            userId, root, name: 'versioned-parent', wait: true, timeoutSeconds: 5,
        });
        expect(started.run?.status).toBe('waiting_approval');
        await writeFile(childPath, `
document:
  name: versioned-child
do:
  - approve:
      call: approval
  - work:
      call: agent
      with:
        prompt: changed
`, 'utf8');
        const runId = started.runId!;
        expect(await engine.resumeRun({ userId, root, runId, decision: 'approve' })).toBe(false);
        const paused = await engine.getRun({ userId, root, runId });
        expect(paused?.status).toBe('waiting_approval');
        expect(paused?.error).toContain('子工作流定义已修改');
        expect(executor.calls.some((call) => call.prompt === 'changed')).toBe(false);
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
