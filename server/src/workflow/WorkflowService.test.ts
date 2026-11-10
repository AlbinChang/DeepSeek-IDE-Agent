import { describe, expect, it, vi } from 'vitest';

import { config } from '@/config/index.js';
import { WorkflowService } from '@/workflow/WorkflowService.js';
import {
    WORKFLOW_DISABLED,
    WORKFLOW_ENGINE_UNAVAILABLE,
} from '@/workflow/WorkflowService.js';
import type { WorkflowEngine, WorkflowEvent } from '@/workflow/types.js';

function createEngine(): WorkflowEngine {
    return {
        setEventBus: vi.fn(),
        startRun: vi.fn(async () => ({ ok: true, runId: 'run-1', status: 'queued' as const })),
        getRun: vi.fn(async () => null),
        listRuns: vi.fn(async () => []),
        cancelRun: vi.fn(async () => true),
        resumeRun: vi.fn(async () => true),
        cancelUserRuns: vi.fn(async () => {}),
        getStats: vi.fn(() => ({ active: 1, queued: 2, workers: [] })),
        shutdown: vi.fn(async () => {}),
    };
}

describe('WorkflowService', () => {
    it('returns WORKFLOW_ENGINE_UNAVAILABLE when no engine is registered', async () => {
        const service = new WorkflowService();

        const result = await service.run({ userId: 'u', root: '/workspace', name: 'demo' });

        expect(result).toEqual({ ok: false, error: WORKFLOW_ENGINE_UNAVAILABLE });
        expect(service.getStats()).toEqual({ active: 0, queued: 0, workers: [] });
        expect(await service.getRun({ userId: 'u', root: '/workspace', runId: 'run-1' })).toBeNull();
        expect(await service.cancel({ userId: 'u', root: '/workspace', runId: 'run-1' })).toBe(false);
        expect(await service.resume({ userId: 'u', root: '/workspace', runId: 'run-1' })).toBe(false);
    });

    it('delegates run operations to the engine port', async () => {
        const service = new WorkflowService();
        const engine = createEngine();
        service.setEngine(engine);

        const result = await service.run({ userId: 'u', root: '/workspace', name: 'demo' });

        expect(result).toEqual({ ok: true, runId: 'run-1', status: 'queued' });
        expect(engine.startRun).toHaveBeenCalledWith({
            userId: 'u',
            root: '/workspace',
            name: 'demo',
        });
        expect(service.getStats()).toEqual({ active: 1, queued: 2, workers: [] });
        expect(await service.cancel({ userId: 'u', root: '/workspace', runId: 'run-1' })).toBe(true);
        expect(await service.resume({ userId: 'u', root: '/workspace', runId: 'run-1', decision: 'approve' })).toBe(true);
    });

    it('propagates the event bus to the engine', () => {
        const service = new WorkflowService();
        const engine = createEngine();
        service.setEngine(engine);

        const event: WorkflowEvent = { runId: 'run-1', seq: 1, type: 'run.started', timestamp: 1 };
        const publish = vi.fn();
        service.setEventBus({ publish });
        service.publish(event);

        expect(engine.setEventBus).toHaveBeenCalledTimes(2);
        expect(publish).toHaveBeenCalledWith(event);
    });

    it('rejects runs when the workflow feature is disabled', async () => {
        const service = new WorkflowService();
        const engine = createEngine();
        service.setEngine(engine);

        const originalEnabled = config.workflow.enabled;
        (config.workflow as { enabled: boolean }).enabled = false;
        try {
            const result = await service.run({ userId: 'u', root: '/workspace', name: 'demo' });
            expect(result).toEqual({ ok: false, error: WORKFLOW_DISABLED });
            expect(engine.startRun).not.toHaveBeenCalled();
        } finally {
            (config.workflow as { enabled: boolean }).enabled = originalEnabled;
        }
    });

    it('cancels user runs and shuts down the engine', async () => {
        const service = new WorkflowService();
        const engine = createEngine();
        service.setEngine(engine);

        await service.cancelUserRuns('u', '/workspace');
        await service.shutdown();

        expect(engine.cancelUserRuns).toHaveBeenCalledWith('u', '/workspace');
        expect(engine.shutdown).toHaveBeenCalledOnce();
        expect(service.getEngine()).toBeNull();
    });
});
