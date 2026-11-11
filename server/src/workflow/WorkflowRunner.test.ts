import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkflowApprovalPause, WorkflowTimeoutError } from '@/workflow/errors.js';
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
        await rm(root, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 50,
        });
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

    it('runs fork branches concurrently and merges branch contexts in order', async () => {
        const executor = new FakeExecutor();
        let active = 0;
        let maxActive = 0;
        executor.handler = async (kind, definition) => {
            if (kind !== 'agent') return { output: `${kind}-output` };
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 30));
            active--;
            return { output: definition.with?.prompt };
        };
        const runner = createRunner([
            {
                parallel: {
                    fork: {
                        branches: [
                            {
                                do: [
                                    { leftSet: { set: { left: 'L' } } },
                                    { leftWork: { call: 'agent', with: { prompt: 'left' } } },
                                ],
                            },
                            {
                                do: [
                                    { rightSet: { set: { right: 'R' } } },
                                    { rightWork: { call: 'agent', with: { prompt: 'right' } } },
                                ],
                            },
                        ],
                    },
                },
            },
            { combine: { set: { combined: '${ .context.left }-${ .context.right }' } } },
        ], executor);

        await runner.run();

        expect(maxActive).toBe(2);
        expect(runner.getContextValues()).toMatchObject({ left: 'L', right: 'R', combined: 'L-R' });
        const forkStep = snapshot.steps.find((step) => step.name === 'parallel');
        expect(forkStep?.status).toBe('succeeded');
        expect(Array.isArray(forkStep?.output)).toBe(true);
        expect((forkStep?.output as unknown[]).length).toBe(2);
        expect(snapshot.steps.some((step) => step.path.includes('/branch-0/do/'))).toBe(true);
        expect(snapshot.steps.some((step) => step.path.includes('/branch-1/do/'))).toBe(true);
    });

    it('fails the fork when any branch fails', async () => {
        const executor = new FakeExecutor();
        executor.handler = async (kind, definition) => {
            if (definition.with?.prompt === 'boom') throw new Error('branch exploded');
            return { output: 'ok' };
        };
        const runner = createRunner([
            {
                parallel: {
                    fork: {
                        branches: [
                            { do: [{ ok: { call: 'agent', with: { prompt: 'ok' } } }] },
                            { do: [{ bad: { call: 'agent', with: { prompt: 'boom' } } }] },
                        ],
                    },
                },
            },
        ], executor);

        await expect(runner.run()).rejects.toThrow('branch exploded');
        const forkStep = snapshot.steps.find((step) => step.name === 'parallel');
        expect(forkStep?.status).toBe('failed');
        const badStep = snapshot.steps.find((step) => step.name === 'bad');
        expect(badStep?.status).toBe('failed');
    });

    it('runs a subworkflow with its own inputs and nested step paths', async () => {
        const executor = new FakeExecutor();
        const childYaml = [
            'document:',
            '  name: child',
            '  input:',
            '    schema:',
            '      type: object',
            '      properties:',
            '        prefix: { type: string }',
            'do:',
            '  - greet:',
            '      set:',
            '        message: "${ .inputs.prefix }-child"',
            '  - echo:',
            '      call: agent',
            '      with:',
            '        prompt: "${ .context.message }"',
        ].join('\n');
        await mkdir(path.join(root, '.workflow'), { recursive: true });
        await writeFile(path.join(root, '.workflow', 'child.workflow.yaml'), childYaml, 'utf8');

        const runner = createRunner([
            {
                sub: {
                    call: 'workflow',
                    with: {
                        name: 'child',
                        inputs: { prefix: 'hello' },
                    },
                },
            },
        ], executor);

        await runner.run();

        expect(executor.calls.some((call) => call.ctx.workflowName === 'child')).toBe(true);
        expect(executor.calls.find((call) => call.ctx.workflowName === 'child')?.definition.with?.prompt).toBe('hello-child');
        expect(snapshot.steps.some((step) => step.path.includes('/subworkflow/do/0/greet'))).toBe(true);
        const subStep = snapshot.steps.find((step) => step.name === 'sub');
        expect(subStep?.status).toBe('succeeded');
    });

    it('detects cyclic subworkflows', async () => {
        const executor = new FakeExecutor();
        const childYaml = [
            'document:',
            '  name: child',
            'do:',
            '  - loopBack:',
            '      call: workflow',
            '      with:',
            '        name: demo',
        ].join('\n');
        await mkdir(path.join(root, '.workflow'), { recursive: true });
        await writeFile(path.join(root, '.workflow', 'child.workflow.yaml'), childYaml, 'utf8');
        await writeFile(
            path.join(root, '.workflow', 'demo.workflow.yaml'),
            'document:\n  name: demo\ndo:\n  - noop:\n      set:\n        ok: true\n',
            'utf8',
        );

        const runner = createRunner([
            {
                sub: {
                    call: 'workflow',
                    with: { name: 'child' },
                },
            },
        ], executor);

        await expect(runner.run()).rejects.toThrow(/循环子工作流/);
        const subStep = snapshot.steps.find((step) => step.name === 'sub');
        expect(subStep?.status).toBe('failed');
    });

    it('returns the first successful branch when fork.compete is enabled', async () => {
        const executor = new FakeExecutor();
        executor.handler = async (kind, definition) => {
            if (definition.with?.prompt === 'slow') {
                await new Promise((resolve) => setTimeout(resolve, 100));
                return { output: 'slow' };
            }
            return { output: 'fast' };
        };
        const runner = createRunner([
            {
                race: {
                    fork: {
                        compete: true,
                        branches: [
                            { do: [{ slow: { call: 'agent', with: { prompt: 'slow' } } }] },
                            { do: [{ fast: { call: 'agent', with: { prompt: 'fast' } } }] },
                        ],
                    },
                },
            },
        ], executor);

        await runner.run();

        const raceStep = snapshot.steps.find((step) => step.name === 'race');
        expect(raceStep?.output).toBe('fast');
        const slowStep = snapshot.steps.find((step) => step.name === 'slow');
        expect(slowStep?.status).toBe('cancelled');
    });

    it('cancels nested steps when a container step times out', async () => {
        const executor = new FakeExecutor();
        executor.handler = () => new Promise(() => {});
        const runner = createRunner([
            {
                container: {
                    switch: [
                        {
                            when: true,
                            do: [{ inner: { call: 'agent', with: { prompt: 'hang' } } }],
                        },
                    ],
                    timeout: { after: { milliseconds: 20 } },
                },
            },
        ], executor);

        await expect(runner.run()).rejects.toBeInstanceOf(WorkflowTimeoutError);
        let inner = snapshot.steps.find((step) => step.name === 'inner');
        for (let attempt = 0; attempt < 100 && inner?.status === 'running'; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            inner = snapshot.steps.find((step) => step.name === 'inner');
        }
        expect(inner?.status).toBe('cancelled');
        expect(snapshot.steps.find((step) => step.name === 'container')?.status).toBe('failed');
    });

    it('routes call: http and run.http to the http executor', async () => {
        const executor = new FakeExecutor();
        const runner = createRunner([
            { fetch: { call: 'http', with: { url: 'https://example.com' } } },
            { fetchRun: { run: { http: { url: 'https://example.com', method: 'GET' } } } },
        ], executor);

        await runner.run();

        expect(executor.calls.map((call) => call.kind)).toEqual(['http', 'http']);
        expect(executor.calls[0].definition.with?.url).toBe('https://example.com');
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

    it('rejects emit/listen steps instead of silently skipping them', async () => {
        const executor = new FakeExecutor();
        const runner = createRunner([
            { publish: { emit: { event: { with: { type: 'demo' } } } } },
            { never: { call: 'agent', with: { prompt: 'never' } } },
        ], executor);

        await expect(runner.run()).rejects.toThrow(/emit\/listen/);
        expect(executor.calls).toHaveLength(0);
        expect(snapshot.steps.find((step) => step.name === 'publish')?.status).toBe('failed');
    });

    it('queues fork branches beyond the configured parallelism and still runs them all', async () => {
        const executor = new FakeExecutor();
        let started = 0;
        let active = 0;
        let maxActive = 0;
        executor.handler = async (kind, definition) => {
            if (kind !== 'agent') return { output: `${kind}-output` };
            active++;
            started++;
            maxActive = Math.max(maxActive, active);
            // 等前 4 个分支都进入运行态再结束，避免依赖调度时序
            const deadline = Date.now() + 2000;
            while (started < 4 && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            active--;
            return { output: definition.with?.prompt };
        };
        const runner = createRunner([
            {
                wide: {
                    fork: {
                        branches: Array.from({ length: 6 }, (_, index) => ({
                            do: [{ [`work${index}`]: { call: 'agent', with: { prompt: `p${index}` } } }],
                        })),
                    },
                },
            },
        ], executor);

        await runner.run();

        expect(maxActive).toBe(4);
        expect((snapshot.steps.find((step) => step.name === 'wide')?.output as unknown[]).length).toBe(6);
    });
});
