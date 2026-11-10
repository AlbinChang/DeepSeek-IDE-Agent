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
