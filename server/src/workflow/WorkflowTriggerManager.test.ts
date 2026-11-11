import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkflowRegistry } from '@/workflow/WorkflowRegistry.js';
import { WorkflowTriggerManager } from '@/workflow/WorkflowTriggerManager.js';
import { InProcessWorkflowEngine } from '@/workflow/InProcessWorkflowEngine.js';
import { WorkflowService } from '@/workflow/WorkflowService.js';

const waitUntil = async (condition: () => boolean, timeout = 4000) => {
    const deadline = Date.now() + timeout;
    while (!condition()) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for trigger');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
};

describe('WorkflowTriggerManager', () => {
    let root: string;
    let manager: WorkflowTriggerManager;
    let running: boolean;
    const run = vi.fn();
    const getRun = vi.fn();

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'workflow-trigger-'));
        await mkdir(path.join(root, '.workflow'), { recursive: true });
        running = false;
        run.mockReset().mockImplementation(async () => ({ ok: true, runId: `wf-${run.mock.calls.length}` }));
        getRun.mockReset().mockImplementation(async () => ({ status: running ? 'running' : 'succeeded' }));
        manager = new WorkflowTriggerManager(
            { run, getRun } as unknown as Pick<WorkflowService, 'run' | 'getRun'>,
            { pollIntervalMs: 100, refreshIntervalMs: 300, cooldownMs: 100 },
        );
    });

    afterEach(async () => {
        await manager.shutdown();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        vi.restoreAllMocks();
    });

    it('schedules intervals without overlapping a prior run and stops on workspace removal', async () => {
        await writeFile(path.join(root, '.workflow', 'periodic.yaml'), `
document: { name: periodic }
x-workflow-triggers:
  - type: interval
    every: 1s
    inputs: { message: hello }
do:
  - done: { set: { ok: true } }
`, 'utf8');
        await manager.activate('alice', root);
        expect(run).not.toHaveBeenCalled();
        await waitUntil(() => run.mock.calls.length === 1);
        expect(run.mock.calls[0][0]).toMatchObject({
            userId: 'alice', root, name: 'periodic', inputs: { message: 'hello' },
        });
        running = true;
        await new Promise((resolve) => setTimeout(resolve, 1200));
        expect(run).toHaveBeenCalledTimes(1);
        running = false;
        await waitUntil(() => run.mock.calls.length === 2);
        await manager.deactivate('alice', root);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        expect(run).toHaveBeenCalledTimes(2);
    }, 10_000);

    it('detects file edits, coalesces changes while a run is active, and reloads definitions', async () => {
        const watched = path.join(root, 'watched.txt');
        const workflow = path.join(root, '.workflow', 'file.yaml');
        await writeFile(watched, 'initial');
        await writeFile(workflow, `
document: { name: file }
x-workflow-triggers:
  - type: file
    paths: [watched.txt]
do:
  - done: { set: { ok: true } }
`, 'utf8');
        await manager.activate('alice', root);
        await writeFile(watched, 'changed once');
        await waitUntil(() => run.mock.calls.length === 1);
        running = true;
        await writeFile(watched, 'changed twice');
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(run).toHaveBeenCalledTimes(1);
        running = false;
        await waitUntil(() => run.mock.calls.length === 2);
        await writeFile(workflow, `
document: { name: file }
do:
  - done: { set: { ok: true } }
`, 'utf8');
        await new Promise((resolve) => setTimeout(resolve, 500));
        await writeFile(watched, 'changed after removal');
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(run).toHaveBeenCalledTimes(2);
    }, 10_000);

    it('rejects invalid triggers and paths during workflow validation', async () => {
        await writeFile(path.join(root, '.workflow', 'bad.yaml'), `
document: { name: bad }
x-workflow-triggers:
  - type: interval
    every: 20ms
  - type: file
    paths: [../secret.txt]
do:
  - done: { set: { ok: true } }
`, 'utf8');
        const validation = await new WorkflowRegistry(root).validate('bad');
        expect(validation.ok).toBe(false);
        expect(validation.issues.filter((issue) => issue.path.startsWith('/x-workflow-triggers'))).toHaveLength(2);
        await manager.activate('alice', root);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(run).not.toHaveBeenCalled();
    });

    it('never watches a symlink target outside the workspace', async () => {
        const outside = await mkdtemp(path.join(tmpdir(), 'workflow-trigger-outside-'));
        const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await writeFile(path.join(outside, 'secret.txt'), 'before');
            await symlink(outside, path.join(root, 'outside-link'), 'junction');
            await writeFile(path.join(root, '.workflow', 'unsafe.yaml'), `
document: { name: unsafe }
x-workflow-triggers:
  - type: file
    paths: [outside-link/secret.txt]
do:
  - done: { set: { ok: true } }
`, 'utf8');
            await manager.activate('alice', root);
            await writeFile(path.join(outside, 'secret.txt'), 'after');
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(run).not.toHaveBeenCalled();
            expect(warnings).toHaveBeenCalled();
        } finally {
            await manager.shutdown();
            await rm(outside, { recursive: true, force: true });
        }
    });

    it('persists trigger provenance on a real engine run', async () => {
        const service = new WorkflowService();
        service.setEngine(new InProcessWorkflowEngine());
        manager = new WorkflowTriggerManager(service, { pollIntervalMs: 100, refreshIntervalMs: 1000 });
        await writeFile(path.join(root, '.workflow', 'periodic.yaml'), `
document: { name: periodic }
x-workflow-triggers:
  - type: interval
    every: 1s
do:
  - done: { set: { ok: true } }
`, 'utf8');
        try {
            await manager.activate('alice', root);
            const deadline = Date.now() + 5000;
            let runs = await service.listRuns({ userId: 'alice', root });
            while (!runs.some((entry) => entry.status === 'succeeded') && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 50));
                runs = await service.listRuns({ userId: 'alice', root });
            }
            expect(runs[0]?.status).toBe('succeeded');
            expect(runs[0]?.trigger).toEqual({ type: 'interval', id: '.workflow/periodic.yaml:0' });
        } finally {
            await manager.shutdown();
            await service.shutdown();
        }
    }, 10_000);
});
