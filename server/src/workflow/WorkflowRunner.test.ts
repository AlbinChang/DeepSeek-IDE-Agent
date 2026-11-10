import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkflowApprovalPause, WorkflowTimeoutError, WorkflowUnsupportedError } from '@/workflow/errors.js';
import { WorkflowRunner } from '@/workflow/WorkflowRunner.js';
import { WorkflowRunSession } from '@/workflow/WorkflowRunSession.js';
import { WorkflowRunStore } from '@/workflow/WorkflowRunStore.js';
import type {
    WorkflowStepExecutionResult,
    WorkflowStepExecutor,
    WorkflowStepExecutionContext,
} from '@/workflow/WorkflowStepExecutor.js';
import type {
    WorkflowDefinition,
    WorkflowEvent,
    WorkflowRunInfo,
} from '@/workflow/types.js';

class FakeExecutor implements WorkflowStepExecutor {
    public calls: Array<{ kind: string; definition: Record<string, any>; ctx: WorkflowStepExecutionContext }> = [];
    public handler: ((kind: string, definition: Record<string, any>, ctx: WorkflowStepExecutionContext) => Promise<any>) | null = null;

    public async execute(
        kind: string,
        definition: Record<string, any>,
        ctx: WorkflowStepExecutionContext,
    ): Promise<WorkflowStepExecutionResult> {
        this.calls.push({ kind, definition, ctx });
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
        return { output: `${kind}-output` };
    }
}

const createDefinition = (steps: Record<string, any>[]): WorkflowDefinition => ({
    summary: {
        name: 'demo',
        path: '.workflow/demo.workflow.yaml',
        title: 'Demo',
        inputs: [],
        stepCount: steps.length,
    },
    document: { do: steps },
    steps,
    yaml: '',
    validation: { ok: true, issues: [], validator: 'builtin' },
});

describe('WorkflowRunner', () => {
    let root: string;
    let store: WorkflowRunStore;
    let session: WorkflowRunSession;
    let snapshot: WorkflowRunInfo;
    let events: WorkflowEvent[];

    const createRunner = (
        steps: Record<string, any>[],
        executor: WorkflowStepExecutor,
        inputs: Record<string, unknown> = {},
        options: { abortSignal?: AbortSignal; startIndex?: number; initialContext?: Record<string, unknown> } = {},
    ) => new WorkflowRunner({
        session,
        definition: createDefinition(steps),
        inputs,
        executor,
        abortSignal: options.abortSignal || new AbortController().signal,
        traceId: 'trace-1',
        userId: 'user-1',
        root,
        startIndex: options.startIndex,
        initialContext: options.initialContext,
    });

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'workflow-runner-'));
        store = new WorkflowRunStore(root);
        events = [];
        const runId = store.newRunId();
        snapshot = {
            schemaVersion: 1,
            runId,
            workflow: { name: 'demo', path: '.workflow/demo.workflow.yaml' },
            workflowName: 'demo',
            workflowPath: '.workflow/demo.workflow.yaml',
            userId: 'user-1',
            root,
            status: 'running',
            inputs: {},
            createdAt: Date.now(),
            steps: [],
            lastSeq: 0,
        };
        await store.create(snapshot);
        session = new WorkflowRunSession(store, snapshot, (event) => events.push(event), 4096);
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('runs sequential set + agent steps and resolves expressions lazily', async () => {
        const executor = new FakeExecutor();
        const runner = createRunner([
            { prepare: { set: { branch: 'feature', count: 2 } } },
            { plan: { call: 'agent', with: { prompt: 'Plan ${ .context.branch } for ${ .inputs.name }' } } },
        ], executor, { name: 'demo' });

        await runner.run();

        expect(executor.calls).toHaveLength(1);
        expect(executor.calls[0].kind).toBe('agent');
        expect(executor.calls[0].definition.with.prompt).toBe('Plan feature for demo');
        expect(runner.getContextValues()).toEqual({ branch: 'feature', count: 2 });

        const prepare = snapshot.steps.find((step) => step.name === 'prepare');
        const plan = snapshot.steps.find((step) => step.name === 'plan');
        expect(prepare?.status).toBe('succeeded');
        expect(plan?.status).toBe('succeeded');
        expect(plan?.output).toBe('agent-output');
        expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
            'step.started',
            'step.output',
        ]));
    });

    it('executes the first matching switch case', async () => {
        const executor = new FakeExecutor();
        const runner = createRunner([
            {
                choose: {
                    switch: [
                        { when: "${ .inputs.mode == 'fast' }", do: [{ fast: { call: 'agent', with: { prompt: 'fast' } } }] },
                        { default: { do: [{ slow: { call: 'agent', with: { prompt: 'slow' } } }] } },
                    ],
                },
            },
        ], executor, { mode: 'fast' });

        await runner.run();

        expect(executor.calls).toHaveLength(1);
        expect(executor.calls[0].definition.with.prompt).toBe('fast');
    });

    it('iterates for-loops with each/at variables', async () => {
        const executor = new FakeExecutor();
        const runner = createRunner([
            {
                loop: {
                    for: { each: 'item', at: 'index', in: '${ .inputs.items }' },
                    do: [
                        { work: { call: 'agent', with: { prompt: 'item ${ item } at ${ index }' } } },
                    ],
                },
            },
        ], executor, { items: ['a', 'b'] });

        await runner.run();

        expect(executor.calls.map((call) => call.definition.with.prompt)).toEqual([
            'item a at 0',
            'item b at 1',
        ]);
        expect(executor.calls.map((call) => call.ctx.stepPath)).toEqual([
            '/do/0/loop/iter-0/do/0/work',
            '/do/0/loop/iter-1/do/0/work',
        ]);
    });

    it('retries try steps and falls back to catch.do', async () => {
        const executor = new FakeExecutor();
        let attempts = 0;
        executor.handler = async (kind) => {
            if (kind === 'agent') {
                attempts++;
                if (attempts < 2) throw new Error('transient');
                return { output: 'ok' };
            }
            return { output: 'fallback' };
        };
        const runner = createRunner([
            {
                guarded: {
                    try: [{ work: { call: 'agent', with: { prompt: 'do' } } }],
                    catch: {
                        retry: { delay: { milliseconds: 1 }, limit: { attempt: { count: 2 } } },
                        do: [{ fallback: { set: { recovered: true } } }],
                    },
                },
            },
        ], executor);

        await runner.run();

        expect(attempts).toBe(2);
        expect(runner.getContextValues().recovered).toBeUndefined();
        expect(events.some((event) => event.type === 'step.retried')).toBe(true);
    });

    it('executes catch.do when retries are exhausted', async () => {
        const executor = new FakeExecutor();
        executor.handler = async (kind) => {
            if (kind === 'agent') throw new Error('always fails');
            return { output: 'fallback' };
        };
        const runner = createRunner([
            {
                guarded: {
                    try: [{ work: { call: 'agent', with: { prompt: 'do' } } }],
                    catch: {
                        retry: { delay: { milliseconds: 1 }, limit: { attempt: { count: 1 } } },
                        do: [{ recover: { set: { recovered: true } } }],
                    },
                },
            },
        ], executor);

        await runner.run();

        expect(runner.getContextValues().recovered).toBe(true);
        const guarded = snapshot.steps.find((step) => step.name === 'guarded');
        expect(guarded?.status).toBe('succeeded');
    });

    it('pauses at top-level approval steps', async () => {
        const executor = new FakeExecutor();
        const runner = createRunner([
            { approve: { call: 'approval', with: { message: 'ok?' } } },
            { after: { call: 'agent', with: { prompt: 'after' } } },
        ], executor);

        await expect(runner.run()).rejects.toBeInstanceOf(WorkflowApprovalPause);
        const approve = snapshot.steps.find((step) => step.name === 'approve');
        expect(approve?.status).toBe('waiting_approval');
        expect(executor.calls.some((call) => call.definition.with?.prompt === 'after')).toBe(false);
    });

    it('enforces per-step timeouts', async () => {
        const executor = new FakeExecutor();
        executor.handler = () => new Promise(() => {});
        const runner = createRunner([
            {
                slow: {
                    call: 'agent',
                    with: { prompt: 'slow' },
                    timeout: { after: { milliseconds: 20 } },
                },
            },
        ], executor);

        await expect(runner.run()).rejects.toBeInstanceOf(WorkflowTimeoutError);
        const slow = snapshot.steps.find((step) => step.name === 'slow');
        expect(slow?.status).toBe('failed');
    });

    it('rejects unsupported fork steps', async () => {
        const executor = new FakeExecutor();
        const runner = createRunner([
            { parallel: { fork: { branches: [] } } },
        ], executor);

        await expect(runner.run()).rejects.toBeInstanceOf(WorkflowUnsupportedError);
    });

    it('does not allow set to pollute the prototype', async () => {
        const executor = new FakeExecutor();
        const runner = createRunner([
            { evil: { set: { ['__proto__']: { polluted: true }, safe: 1 } } },
        ], executor);

        await runner.run();

        expect(({} as any).polluted).toBeUndefined();
        expect(runner.getContextValues()).toMatchObject({ safe: 1 });
        expect((runner.getContextValues() as any).polluted).toBeUndefined();
    });

    it('stops after a step with then: exit', async () => {
        const executor = new FakeExecutor();
        const runner = createRunner([
            { stop: { set: { done: true }, then: 'exit' } },
            { never: { call: 'agent', with: { prompt: 'never' } } },
        ], executor);

        await runner.run();

        expect(executor.calls).toHaveLength(0);
    });
});
