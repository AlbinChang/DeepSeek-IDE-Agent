import { describe, expect, it } from 'vitest';

import {
    isMainToWorkerMessage,
    isWorkerToMainMessage,
    WORKFLOW_WORKER_PROTOCOL_VERSION,
} from '@/workflow/workerProtocol.js';

describe('workflow worker protocol', () => {
    it('accepts valid init/run messages and rejects wrong protocol versions', () => {
        expect(isMainToWorkerMessage({
            type: 'worker.init',
            protocolVersion: WORKFLOW_WORKER_PROTOCOL_VERSION,
            workerId: 'w1',
        })).toBe(true);
        expect(isMainToWorkerMessage({
            type: 'worker.init',
            protocolVersion: 99,
            workerId: 'w1',
        })).toBe(false);
        expect(isMainToWorkerMessage({
            type: 'run.start',
            config: {
                runId: 'wf-1',
                root: 'D:/ws',
                workflowName: 'demo',
                traceId: 't',
                userId: 'u',
                heartbeatIntervalMs: 1000,
            },
            definition: { summary: { name: 'demo', path: '.workflow/demo.workflow.yaml', inputs: [], stepCount: 1 }, steps: [] },
            inputs: {},
            steps: [],
        })).toBe(true);
        expect(isMainToWorkerMessage({ type: 'run.cancel' })).toBe(false);
    });

    it('guards worker result/step messages', () => {
        expect(isWorkerToMainMessage({
            type: 'run.result',
            runId: 'wf-1',
            status: 'succeeded',
        })).toBe(true);
        expect(isWorkerToMainMessage({
            type: 'run.result',
            runId: 'wf-1',
            status: 'unknown',
        })).toBe(false);
        expect(isWorkerToMainMessage({
            type: 'run.step',
            runId: 'wf-1',
            step: { path: '/do/0/a', name: 'a', status: 'succeeded', attempts: 1 },
        })).toBe(true);
        expect(isWorkerToMainMessage({
            type: 'run.step',
            runId: 'wf-1',
            step: { name: 'a' },
        })).toBe(false);
    });
});
