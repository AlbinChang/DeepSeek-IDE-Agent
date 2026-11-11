import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkflowRunSession } from '@/workflow/WorkflowRunSession.js';
import { WorkflowRunStore } from '@/workflow/WorkflowRunStore.js';
import type { WorkflowRunInfo } from '@/workflow/types.js';

describe('WorkflowRunSession', () => {
    let root: string;
    let store: WorkflowRunStore;
    let run: WorkflowRunInfo;

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'workflow-session-'));
        store = new WorkflowRunStore(root);
        run = {
            schemaVersion: 1,
            runId: store.newRunId(),
            workflow: { name: 'test', path: '.workflow/test.workflow.yaml' },
            workflowName: 'test',
            userId: 'user',
            root,
            status: 'running',
            inputs: {},
            createdAt: Date.now(),
            steps: [],
        };
        await store.create(run);
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    it('persists and publishes concurrent events in sequence order', async () => {
        const append = store.appendEvent.bind(store);
        vi.spyOn(store, 'appendEvent').mockImplementation(async (runId, event) => {
            if (event.seq % 2 === 1) await new Promise((resolve) => setTimeout(resolve, 5));
            await append(runId, event);
        });
        const published: number[] = [];
        const session = new WorkflowRunSession(store, run, (event) => published.push(event.seq), 4096);
        await Promise.all(Array.from({ length: 10 }, (_, index) => session.emit('step.log', { index })));
        const events = await store.readEvents(run.runId);
        expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect(events.map((event) => event.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        expect(published).toEqual(events.map((event) => event.seq));
        await session.close();
    });

    it('surfaces a persistence failure and allows a later write to retry', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const save = store.save.bind(store);
        vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk full')).mockImplementation(save);
        const session = new WorkflowRunSession(store, run, () => {}, 4096);
        await expect(session.patch({ status: 'failed' })).rejects.toThrow('disk full');
        await expect(session.patch({ status: 'interrupted' })).resolves.toBeUndefined();
        expect((await store.read(run.runId))?.status).toBe('interrupted');
    });

    it('does not consume an event sequence number when appending fails', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const append = store.appendEvent.bind(store);
        vi.spyOn(store, 'appendEvent').mockRejectedValueOnce(new Error('disk full')).mockImplementation(append);
        const session = new WorkflowRunSession(store, run, () => {}, 4096);
        await expect(session.emit('first')).rejects.toThrow('disk full');
        await session.emit('second');
        expect((await store.readEvents(run.runId)).map((event) => event.seq)).toEqual([1]);
        expect((await store.read(run.runId))?.lastSeq).toBe(1);
    });
});
