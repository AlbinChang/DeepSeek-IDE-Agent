import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceRegistry } from '@/services/WorkspaceRegistry.js';
import { InProcessWorkflowEngine } from '@/workflow/InProcessWorkflowEngine.js';
import { registerWorkflowHttpRoutes } from '@/workflow/WorkflowHttpRoutes.js';
import { WorkflowService } from '@/workflow/WorkflowService.js';
import type { WorkflowStepExecutor } from '@/workflow/WorkflowStepExecutor.js';

const TOKEN = 'workflow-test-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

describe('Workflow HTTP API', () => {
    let root: string;
    let app: FastifyInstance;
    let service: WorkflowService;
    let workspaces: WorkspaceRegistry;

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'workflow-http-api-'));
        await mkdir(path.join(root, '.workflow'), { recursive: true });
        await writeFile(path.join(root, '.workflow', 'demo.workflow.yaml'), `
document:
  name: demo
do:
  - approval:
      call: approval
  - finish:
      set:
        done: true
`, 'utf8');
        await writeFile(path.join(root, '.workflow', 'stream.workflow.yaml'), `
document:
  name: stream
do:
  - delay:
      wait: 500ms
  - finish:
      set:
        done: true
`, 'utf8');
        const executor: WorkflowStepExecutor = {
            execute: async (kind, _definition, context) => kind === 'approval'
                ? { approval: { stepPath: context.stepPath, requestedAt: Date.now() } }
                : { output: 'ok' },
        };
        service = new WorkflowService();
        service.setEngine(new InProcessWorkflowEngine({ executor, maxWorkers: 2 }));
        workspaces = new WorkspaceRegistry();
        workspaces.set('alice', root);
        app = Fastify();
        await registerWorkflowHttpRoutes(app, service, workspaces, { enabled: true, token: TOKEN });
        await app.ready();
    });

    afterEach(async () => {
        await service.shutdown();
        await app.close();
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    it('requires a bearer token and checks the registered workspace', async () => {
        const unauthorized = await app.inject({ method: 'GET', url: '/api/workflows?userId=alice' });
        expect(unauthorized.statusCode).toBe(401);
        const invalid = await app.inject({
            method: 'GET', url: '/api/workflows?userId=alice', headers: { authorization: 'Bearer wrong' },
        });
        expect(invalid.statusCode).toBe(401);
        const mismatch = await app.inject({
            method: 'GET',
            url: `/api/workflows?userId=alice&root=${encodeURIComponent(path.join(root, 'other'))}`,
            headers: AUTH,
        });
        expect(mismatch.statusCode).toBe(403);
        const list = await app.inject({ method: 'GET', url: '/api/workflows?userId=alice', headers: AUTH });
        expect(list.statusCode).toBe(200);
        expect(list.json().workflows.map((workflow: { name: string }) => workflow.name)).toContain('demo');
    });

    it('starts, lists, and approves a run through the REST interface', async () => {
        const start = await app.inject({
            method: 'POST',
            url: '/api/workflows/runs',
            headers: AUTH,
            payload: { userId: 'alice', name: 'demo', wait: true, timeoutSeconds: 5 },
        });
        expect(start.statusCode).toBe(202);
        const runId = start.json().runId as string;
        expect(start.json().run.status).toBe('waiting_approval');

        const list = await app.inject({ method: 'GET', url: '/api/workflows/runs?userId=alice', headers: AUTH });
        expect(list.statusCode).toBe(200);
        expect(list.json().runs.map((run: { runId: string }) => run.runId)).toContain(runId);
        const resume = await app.inject({
            method: 'POST',
            url: `/api/workflows/runs/${runId}/resume`,
            headers: AUTH,
            payload: { userId: 'alice', decision: 'approve' },
        });
        expect(resume.statusCode).toBe(200);

        const deadline = Date.now() + 5000;
        let status: string | undefined;
        while (Date.now() < deadline) {
            const result = await app.inject({
                method: 'GET', url: `/api/workflows/runs/${runId}?userId=alice`, headers: AUTH,
            });
            status = result.json().run.status;
            if (status === 'succeeded') break;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(status).toBe('succeeded');
        workspaces.set('bob', root);
        const otherUser = await app.inject({
            method: 'GET', url: `/api/workflows/runs/${runId}?userId=bob`, headers: AUTH,
        });
        expect(otherUser.statusCode).toBe(404);
    });

    it('streams persisted and live events with monotonically increasing IDs', async () => {
        const start = await app.inject({
            method: 'POST', url: '/api/workflows/runs', headers: AUTH,
            payload: { userId: 'alice', name: 'stream' },
        });
        const runId = start.json().runId as string;
        const address = await app.listen({ host: '127.0.0.1', port: 0 });
        const controller = new AbortController();
        try {
            const response = await fetch(`${address}/api/workflows/runs/${runId}/events?userId=alice`, {
                headers: AUTH,
                signal: controller.signal,
            });
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('text/event-stream');
            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            let text = '';
            while (!text.includes('"type":"run.completed"')) {
                const chunk = await reader.read();
                if (chunk.done) break;
                text += decoder.decode(chunk.value, { stream: true });
            }
            const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
            expect(ids.length).toBeGreaterThan(1);
            expect(ids).toEqual([...new Set(ids)].sort((left, right) => left - right));
            expect(text).toContain('"type":"run.completed"');
            await reader.cancel();
        } finally {
            controller.abort();
        }
    }, 15_000);

    it('replays events after Last-Event-ID and closes on workspace reset', async () => {
        const start = await app.inject({
            method: 'POST', url: '/api/workflows/runs', headers: AUTH,
            payload: { userId: 'alice', name: 'stream', wait: true, timeoutSeconds: 5 },
        });
        const runId = start.json().runId as string;
        const run = await service.getRun({ userId: 'alice', root, runId, includeEvents: true });
        const lastSeq = run!.events![run!.events!.length - 1].seq;
        expect(lastSeq).toBeGreaterThan(1);
        const address = await app.listen({ host: '127.0.0.1', port: 0 });
        const controller = new AbortController();
        try {
            const response = await fetch(`${address}/api/workflows/runs/${runId}/events?userId=alice`, {
                headers: { ...AUTH, 'last-event-id': String(lastSeq - 1) },
                signal: controller.signal,
            });
            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            let text = '';
            while (!text.includes(`id: ${lastSeq}\n`)) {
                const chunk = await reader.read();
                if (chunk.done) break;
                text += decoder.decode(chunk.value, { stream: true });
            }
            const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
            expect(ids).toEqual([lastSeq]);
            await workspaces.reset('alice');
            const next = await reader.read();
            expect(next.done).toBe(true);
        } finally {
            controller.abort();
        }
    }, 15_000);

    it('resets and replays when Last-Event-ID is ahead of the run', async () => {
        const start = await app.inject({
            method: 'POST', url: '/api/workflows/runs', headers: AUTH,
            payload: { userId: 'alice', name: 'stream', wait: true, timeoutSeconds: 5 },
        });
        const runId = start.json().runId as string;
        const address = await app.listen({ host: '127.0.0.1', port: 0 });
        const controller = new AbortController();
        try {
            const response = await fetch(`${address}/api/workflows/runs/${runId}/events?userId=alice`, {
                headers: { ...AUTH, 'last-event-id': '999999' },
                signal: controller.signal,
            });
            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            let text = '';
            while (!text.includes('"type":"run.completed"')) {
                const chunk = await reader.read();
                if (chunk.done) break;
                text += decoder.decode(chunk.value, { stream: true });
            }
            expect(text).toContain('event: reset');
            expect(text).toContain('id: 1\n');
            expect(text).toContain('"type":"run.completed"');
            await reader.cancel();
        } finally {
            controller.abort();
        }
    }, 15_000);

    it('does not register the API when disabled and refuses a missing token', async () => {
        const disabled = Fastify();
        try {
            await registerWorkflowHttpRoutes(disabled, service, workspaces, { enabled: false });
            expect((await disabled.inject({ method: 'GET', url: '/api/workflows?userId=alice' })).statusCode).toBe(404);
            await expect(registerWorkflowHttpRoutes(disabled, service, workspaces, { enabled: true }))
                .rejects.toThrow('WORKFLOW_HTTP_API_TOKEN');
        } finally {
            await disabled.close();
        }
    });
});
