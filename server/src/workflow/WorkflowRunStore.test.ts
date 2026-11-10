import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkflowRunStore, sanitizeForStore } from '@/workflow/WorkflowRunStore.js';
import type { WorkflowEvent, WorkflowRunInfo } from '@/workflow/types.js';

const createRun = (runId: string, overrides: Partial<WorkflowRunInfo> = {}): WorkflowRunInfo => ({
    schemaVersion: 1,
    runId,
    workflow: { name: 'demo', path: '.workflow/demo.workflow.yaml' },
    workflowName: 'demo',
    workflowPath: '.workflow/demo.workflow.yaml',
    userId: 'user-1',
    root: '/workspace',
    status: 'queued',
    inputs: {},
    createdAt: 1000,
    steps: [],
    lastSeq: 0,
    ...overrides,
});

describe('WorkflowRunStore', () => {
    let root: string;
    let store: WorkflowRunStore;

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'workflow-store-'));
        store = new WorkflowRunStore(root);
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('creates, reads and updates a run atomically', async () => {
        const runId = store.newRunId();
        await store.create(createRun(runId));

        const created = await store.read(runId);
        expect(created?.status).toBe('queued');

        created!.status = 'running';
        created!.startedAt = 2000;
        await store.save(created!);

        const updated = await store.read(runId);
        expect(updated?.status).toBe('running');
        expect(updated?.startedAt).toBe(2000);
    });

    it('appends and reads events, keeping the latest limit', async () => {
        const runId = store.newRunId();
        await store.create(createRun(runId));
        const events: WorkflowEvent[] = [
            { runId, seq: 1, type: 'run.started', timestamp: 1 },
            { runId, seq: 2, type: 'step.started', timestamp: 2 },
            { runId, seq: 3, type: 'run.completed', timestamp: 3 },
        ];
        for (const event of events) {
            await store.appendEvent(runId, event);
        }

        expect(await store.readEvents(runId)).toEqual(events);
        expect((await store.readEvents(runId, 2)).map((event) => event.seq)).toEqual([2, 3]);
    });

    it('lists and filters runs by user and root', async () => {
        const first = store.newRunId();
        const second = store.newRunId();
        await store.create(createRun(first, { createdAt: 1000 }));
        await store.create(createRun(second, { createdAt: 2000, userId: 'user-2' }));

        expect((await store.list()).map((run) => run.runId)).toEqual([second, first]);
        expect((await store.list({ userId: 'user-1' })).map((run) => run.runId)).toEqual([first]);
        expect(await store.list({ root: '/other' })).toEqual([]);
    });

    it('rejects invalid runIds', async () => {
        await expect(store.read('../../etc')).rejects.toThrow('Invalid workflow runId');
        await expect(store.appendEvent('bad', { runId: 'bad', seq: 1, type: 'x', timestamp: 1 }))
            .rejects.toThrow('Invalid workflow runId');
    });

    it('prunes only terminal runs beyond the retention limit', async () => {
        const terminalIds: string[] = [];
        for (let index = 0; index < 3; index++) {
            const runId = store.newRunId();
            terminalIds.push(runId);
            await store.create(createRun(runId, {
                createdAt: 1000 + index,
                status: 'succeeded',
            }));
        }
        const activeId = store.newRunId();
        await store.create(createRun(activeId, { status: 'running', createdAt: 500 }));

        const removed = await store.prune(3);

        expect(removed).toBe(1);
        expect(await store.read(activeId)).not.toBeNull();
        expect(await store.read(terminalIds[0])).toBeNull();
        expect(await store.read(terminalIds[1])).not.toBeNull();
        expect(await store.read(terminalIds[2])).not.toBeNull();
    });

    it('masks secrets and truncates large strings', () => {
        expect(sanitizeForStore({ apiKey: 'sk-abc', text: 'sk-1234567890abcdef' }, 100)).toEqual({
            apiKey: '******',
            text: 'sk-***',
        });
        expect(sanitizeForStore({ accessToken: 'x', usage: { inputTokens: 12, outputTokens: 3 } }, 100)).toEqual({
            accessToken: '******',
            usage: { inputTokens: 12, outputTokens: 3 },
        });
        const truncated = sanitizeForStore('x'.repeat(20), 5) as string;
        expect(truncated.startsWith('xxxxx')).toBe(true);
        expect(truncated).toContain('truncated 15 chars');

        const polluted = sanitizeForStore(JSON.parse('{"__proto__":{"polluted":true},"safe":1}'), 100) as any;
        expect(polluted.safe).toBe(1);
        expect(({} as any).polluted).toBeUndefined();
    });
});
