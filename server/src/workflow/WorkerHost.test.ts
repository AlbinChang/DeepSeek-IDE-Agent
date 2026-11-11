import { describe, expect, it } from 'vitest';

import { WorkflowCancelledError } from '@/workflow/errors.js';
import { WorkflowWorkerHost } from '@/workflow/WorkerHost.js';
import type { WorkflowStepExecutor } from '@/workflow/WorkflowStepExecutor.js';
import type { WorkflowExecutableDefinition } from '@/workflow/types.js';
import type {
    MainToWorkerMessage,
    WorkerToMainMessage,
    WorkflowWorkerRunStartMessage,
    WorkflowWorkerResultMessage,
} from '@/workflow/workerProtocol.js';
import { WORKFLOW_WORKER_PROTOCOL_VERSION } from '@/workflow/workerProtocol.js';

function definition(steps: Record<string, any>[], name = 'test'): WorkflowExecutableDefinition {
    return {
        summary: {
            name,
            path: `.workflow/${name}.workflow.yaml`,
            inputs: [],
            stepCount: steps.length,
        },
        steps,
    };
}

function startMessage(
    def: WorkflowExecutableDefinition,
    overrides: Partial<WorkflowWorkerRunStartMessage> = {},
): WorkflowWorkerRunStartMessage {
    return {
        type: 'run.start',
        config: {
            runId: 'wf-test-1',
            traceId: 'wf-test-1',
            userId: 'u1',
            root: process.cwd(),
            workflowName: def.summary.name,
            heartbeatIntervalMs: 5000,
        },
        definition: def,
        inputs: {},
        steps: [],
        ...overrides,
    };
}

function createHost(executor: WorkflowStepExecutor) {
    const messages: WorkerToMainMessage[] = [];
    let hostRef: WorkflowWorkerHost;
    const result = new Promise<WorkflowWorkerResultMessage>((resolve) => {
        const host = new WorkflowWorkerHost({
            workerId: 'test-worker',
            send: (message) => {
                messages.push(message);
                if (message.type === 'run.result') resolve(message);
            },
            executor,
        });
        hostRef = host;
    });
    return { messages, result, getHost: () => hostRef };
}

describe('WorkflowWorkerHost', () => {
    it('continues a token budget from the persisted usage after worker restart', async () => {
        const { messages, result, getHost } = createHost({
            execute: async (_kind, _definition, ctx) => {
                ctx.checkTokenBudget?.();
                const usage = { inputTokens: 5, outputTokens: 0, totalTokens: 5 };
                ctx.recordUsage?.(usage);
                ctx.verifyTokenBudget?.();
                return { output: 'ok', usage };
            },
        });
        const host = getHost();
        host.handleMessage({
            type: 'worker.init', protocolVersion: WORKFLOW_WORKER_PROTOCOL_VERSION, workerId: 'test-worker',
        });
        const start = startMessage(definition([{ action: { call: 'agent', with: { prompt: 'test' } } }]));
        start.config.maxTokens = 10;
        start.usage = { inputTokens: 6, outputTokens: 0, totalTokens: 6 };
        host.handleMessage(start);
        const final = await result;
        expect(final.status).toBe('failed');
        expect(final.error).toContain('token');
        expect(messages.filter((message) => message.type === 'run.usage')).toHaveLength(1);
        expect(final.usage?.totalTokens).toBe(11);
    });

    it('executes a definition and reports step/checkpoint/result messages', async () => {
        const { messages, result, getHost } = createHost({
            execute: async () => ({ output: { unused: true } }),
        });
        const host = getHost();
        host.handleMessage({
            type: 'worker.init',
            protocolVersion: WORKFLOW_WORKER_PROTOCOL_VERSION,
            workerId: 'test-worker',
        });
        host.handleMessage(startMessage(definition([
            { first: { set: { value: 1 } } },
            { second: { set: { value: 2 } } },
        ])));

        const final = await result;
        expect(final.status).toBe('succeeded');
        const types = messages.map((message) => message.type);
        expect(types).toContain('worker.ready');
        expect(types).toContain('run.step');
        expect(types).toContain('run.checkpoint');
        const checkpoints = messages.filter((message) => message.type === 'run.checkpoint');
        const lastCheckpoint = checkpoints[checkpoints.length - 1];
        expect(
            lastCheckpoint && lastCheckpoint.type === 'run.checkpoint'
                ? lastCheckpoint.checkpoint.nextStepIndex
                : 0,
        ).toBe(2);
    });

    it('returns waiting_approval with a checkpoint', async () => {
        const { result, getHost } = createHost({
            execute: async (kind, _def, ctx) => {
                if (kind === 'approval') {
                    return {
                        approval: {
                            stepPath: ctx.stepPath,
                            message: 'please approve',
                            requestedAt: Date.now(),
                        },
                    };
                }
                return { output: 'ok' };
            },
        });
        const host = getHost();
        host.handleMessage({
            type: 'worker.init',
            protocolVersion: WORKFLOW_WORKER_PROTOCOL_VERSION,
            workerId: 'test-worker',
        });
        host.handleMessage(startMessage(definition([
            { approve: { call: 'approval' } },
            { after: { set: { done: true } } },
        ])));

        const final = await result;
        expect(final.status).toBe('waiting_approval');
        expect(final.approval?.stepPath).toContain('/approve');
        expect(final.checkpoint?.nextStepIndex).toBe(1);
    });

    it('replays a nested approval from its checkpoint without repeating completed work', async () => {
        const calls: string[] = [];
        const executor: WorkflowStepExecutor = {
            execute: async (kind, definition, ctx) => {
                if (kind === 'approval') {
                    return { approval: { stepPath: ctx.stepPath, requestedAt: Date.now() } };
                }
                calls.push(String(definition.with?.prompt));
                return { output: definition.with?.prompt };
            },
        };
        const def = definition([{
            container: {
                switch: [{
                    when: true,
                    do: [
                        { before: { call: 'agent', with: { prompt: 'before' } } },
                        { approval: { call: 'approval' } },
                        { after: { call: 'agent', with: { prompt: 'after' } } },
                    ],
                }],
            },
        }]);
        const first = createHost(executor);
        first.getHost().handleMessage({
            type: 'worker.init',
            protocolVersion: WORKFLOW_WORKER_PROTOCOL_VERSION,
            workerId: 'test-worker',
        });
        first.getHost().handleMessage(startMessage(def));
        const paused = await first.result;
        expect(paused.status).toBe('waiting_approval');
        expect(paused.checkpoint?.nextStepIndex).toBe(0);
        expect(paused.checkpoint?.replayFromStep).toBe(true);

        const stepsByPath = new Map(
            first.messages
                .filter((message) => message.type === 'run.step')
                .map((message) => [message.step.path, structuredClone(message.step)]),
        );
        const approved = stepsByPath.get(paused.approval!.stepPath)!;
        approved.status = 'succeeded';
        approved.output = { approved: true };
        const second = createHost(executor);
        second.getHost().handleMessage({
            type: 'worker.init',
            protocolVersion: WORKFLOW_WORKER_PROTOCOL_VERSION,
            workerId: 'test-worker',
        });
        second.getHost().handleMessage(startMessage(def, {
            steps: [...stepsByPath.values()],
            startIndex: paused.checkpoint!.nextStepIndex,
            initialContext: paused.checkpoint!.context,
            replayCompletedPaths: [...paused.checkpoint!.completedPaths, approved.path],
        }));
        const completed = await second.result;
        expect(completed.status).toBe('succeeded');
        expect(calls).toEqual(['before', 'after']);
    });

    it('cancels a running step through AbortSignal', async () => {
        const { result, getHost } = createHost({
            execute: async (_kind, _def, ctx) => {
                await new Promise((_resolve, reject) => {
                    if (ctx.abortSignal.aborted) {
                        reject(new WorkflowCancelledError('cancelled'));
                        return;
                    }
                    ctx.abortSignal.addEventListener('abort', () => {
                        reject(new WorkflowCancelledError('cancelled'));
                    }, { once: true });
                });
                return { output: 'unreachable' };
            },
        });
        const host = getHost();
        host.handleMessage({
            type: 'worker.init',
            protocolVersion: WORKFLOW_WORKER_PROTOCOL_VERSION,
            workerId: 'test-worker',
        });
        host.handleMessage(startMessage(definition([
            { slow: { call: 'agent', with: { prompt: 'wait' } } },
        ])));

        // 等 run.start 真正进入步骤后再取消
        await new Promise((resolve) => setTimeout(resolve, 20));
        host.handleMessage({ type: 'run.cancel', runId: 'wf-test-1', reason: 'user' });
        const final = await result;
        expect(final.status).toBe('cancelled');
    });

    it('reports failed when the executor throws', async () => {
        const { result, getHost } = createHost({
            execute: async () => {
                throw new Error('boom');
            },
        });
        const host = getHost();
        host.handleMessage({
            type: 'worker.init',
            protocolVersion: WORKFLOW_WORKER_PROTOCOL_VERSION,
            workerId: 'test-worker',
        });
        host.handleMessage(startMessage(definition([
            { fail: { call: 'tool', with: { tool: 'anything' } } },
        ])));

        const final = await result;
        expect(final.status).toBe('failed');
        expect(final.error).toContain('boom');
    });
});
