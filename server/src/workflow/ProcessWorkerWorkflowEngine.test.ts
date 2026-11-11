import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProcessWorkerWorkflowEngine } from '@/workflow/ProcessWorkerWorkflowEngine.js';
import { WorkflowRunStore } from '@/workflow/WorkflowRunStore.js';
import type { WorkflowRunInfo } from '@/workflow/types.js';
import type {
    MainToWorkerMessage,
    WorkerToMainMessage,
    WorkflowWorkerHandle,
    WorkflowWorkerSpawnRequest,
    WorkflowWorkerSpawner,
    WorkflowWorkerRunStartMessage,
} from '@/workflow/workerProtocol.js';
import { WORKFLOW_WORKER_PROTOCOL_VERSION } from '@/workflow/workerProtocol.js';

type StartBehavior = (handle: FakeWorkerHandle, message: WorkflowWorkerRunStartMessage) => void;

class FakeWorkerHandle implements WorkflowWorkerHandle {
    public readonly workerId: string;
    public readonly pid = Math.floor(Math.random() * 10000) + 1000;
    public readonly messages: MainToWorkerMessage[] = [];
    public killed = false;
    private readonly messageListeners = new Set<(message: WorkerToMainMessage) => void>();
    private readonly exitListeners = new Set<(code: number | null) => void>();
    private exitCode: number | null | undefined;

    constructor(
        request: WorkflowWorkerSpawnRequest,
        private readonly onStart: StartBehavior,
    ) {
        this.workerId = request.workerId;
    }

    public postMessage(message: MainToWorkerMessage): void {
        this.messages.push(message);
        if (message.type === 'worker.init') {
            queueMicrotask(() => {
                this.emit({
                    type: 'worker.ready',
                    workerId: this.workerId,
                    pid: this.pid,
                    protocolVersion: WORKFLOW_WORKER_PROTOCOL_VERSION,
                });
            });
        }
        if (message.type === 'run.start') {
            queueMicrotask(() => this.onStart(this, message));
        }
        if (message.type === 'run.cancel') {
            queueMicrotask(() => this.exit(0));
        }
    }

    public emit(message: WorkerToMainMessage): void {
        for (const listener of this.messageListeners) listener(message);
    }

    public exit(code: number): void {
        if (this.exitCode !== undefined) return;
        this.exitCode = code;
        for (const listener of this.exitListeners) listener(code);
    }

    public kill(): void {
        this.killed = true;
        this.exit(0);
    }

    public onMessage(listener: (message: WorkerToMainMessage) => void): () => void {
        this.messageListeners.add(listener);
        return () => this.messageListeners.delete(listener);
    }

    public onExit(listener: (code: number | null) => void): () => void {
        this.exitListeners.add(listener);
        if (this.exitCode !== undefined) queueMicrotask(() => listener(this.exitCode ?? null));
        return () => this.exitListeners.delete(listener);
    }

    public getMetrics(): { memMB?: number; cpu?: number } {
        return { memMB: 123, cpu: 1.5 };
    }

    public getLogTail(): string {
        return 'fake crash';
    }
}

class FakeSpawner implements WorkflowWorkerSpawner {
    public readonly handles: FakeWorkerHandle[] = [];
    private readonly behaviors: StartBehavior[] = [];
    public defaultBehavior: StartBehavior = (handle, message) => {
        this.emitSuccess(handle, message, { ok: true }, message.steps[0]?.path || '/do/0/step');
    };
    public maxConcurrent = 0;
    private active = 0;

    public enqueue(behavior: StartBehavior): void {
        this.behaviors.push(behavior);
    }

    public spawn(request: WorkflowWorkerSpawnRequest): FakeWorkerHandle {
        const behavior = this.behaviors.shift() || this.defaultBehavior;
        let handle!: FakeWorkerHandle;
        handle = new FakeWorkerHandle(request, (worker, message) => {
            this.active++;
            this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
            const original = behavior;
            original(worker, message);
        });
        // 结果/退出时释放并发计数
        const originalKill = handle.kill.bind(handle);
        handle.kill = () => {
            this.active = Math.max(0, this.active - 1);
            originalKill();
        };
        const originalExit = handle.exit.bind(handle);
        handle.exit = (code: number) => {
            this.active = Math.max(0, this.active - 1);
            originalExit(code);
        };
        this.handles.push(handle);
        return handle;
    }

    public emitSuccess(
        handle: FakeWorkerHandle,
        message: WorkflowWorkerRunStartMessage,
        output: unknown,
        stepPath: string,
    ): void {
        handle.emit({
            type: 'run.step',
            runId: message.config.runId,
            step: {
                path: stepPath,
                name: stepPath.split('/').pop() || 'step',
                status: 'succeeded',
                attempts: 1,
                output,
                outputPreview: JSON.stringify(output),
            },
        });
        handle.emit({
            type: 'run.event',
            runId: message.config.runId,
            eventType: 'step.output',
            data: { path: stepPath, preview: JSON.stringify(output) },
        });
        handle.emit({
            type: 'run.checkpoint',
            runId: message.config.runId,
            checkpoint: {
                nextStepIndex: 1,
                context: { ok: true },
                completedPaths: [stepPath],
            },
        });
        handle.emit({
            type: 'run.result',
            runId: message.config.runId,
            status: 'succeeded',
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        });
    }
}

async function createRoot(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'wf-process-engine-'));
}

async function writeWorkflow(root: string, name: string, body: string): Promise<void> {
    const directory = path.join(root, '.workflow');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${name}.workflow.yaml`), body, 'utf8');
}

async function waitForStatus(
    engine: ProcessWorkerWorkflowEngine,
    query: { userId: string; root: string; runId: string },
    status: WorkflowRunInfo['status'],
    timeoutMs = 5000,
): Promise<WorkflowRunInfo> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const run = await engine.getRun(query);
        if (run?.status === status) return run;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const latest = await engine.getRun(query);
    throw new Error(`Timed out waiting for ${status}; latest=${latest?.status}`);
}

const roots: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
    })));
});

async function waitForGrant(handle: FakeWorkerHandle, requestId: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (handle.messages.some((message) => (
            message.type === 'run.permit.granted' && message.requestId === requestId
        ))) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for permit ${requestId}`);
}

describe('ProcessWorkerWorkflowEngine', () => {
    it('runs a workflow through a worker and persists events', async () => {
        const root = await createRoot();
        roots.push(root);
        await writeWorkflow(root, 'basic', [
            'document:',
            '  name: basic',
            'do:',
            '  - first:',
            '      set:',
            '        value: 1',
        ].join('\n'));

        const spawner = new FakeSpawner();
        const engine = new ProcessWorkerWorkflowEngine({ spawner, maxWorkers: 1 });
        try {
            const result = await engine.startRun({
                userId: 'u1',
                root,
                name: 'basic',
                wait: true,
                timeoutSeconds: 5,
            });
            expect(result.ok).toBe(true);
            expect(result.run?.status).toBe('succeeded');

            const stored = await fs.readFile(
                path.join(root, '.workflow', '.runs', result.runId!, 'run.json'),
                'utf8',
            );
            const run = JSON.parse(stored) as WorkflowRunInfo;
            expect(run.status).toBe('succeeded');
            expect(run.steps[0].status).toBe('succeeded');

            const events = await fs.readFile(
                path.join(root, '.workflow', '.runs', result.runId!, 'events.jsonl'),
                'utf8',
            );
            expect(events).toContain('run.started');
            expect(events).toContain('step.output');
            expect(events).toContain('run.completed');
            expect(spawner.handles[0].messages.some((m) => m.type === 'run.start')).toBe(true);
        } finally {
            await engine.shutdown();
        }
    });

    it('interrupts a run when worker state cannot be persisted', async () => {
        const root = await createRoot();
        roots.push(root);
        await writeWorkflow(root, 'disk-error', 'document:\n  name: disk-error\ndo:\n  - first:\n      set:\n        value: 1\n');
        const spawner = new FakeSpawner();
        spawner.defaultBehavior = (handle, message) => {
            const save = WorkflowRunStore.prototype.save;
            vi.spyOn(WorkflowRunStore.prototype, 'save')
                .mockRejectedValueOnce(new Error('disk full'))
                .mockImplementation(save);
            handle.emit({
                type: 'run.step',
                runId: message.config.runId,
                step: { path: '/do/0/first', name: 'first', status: 'succeeded', attempts: 1 },
            });
        };
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const engine = new ProcessWorkerWorkflowEngine({ spawner, maxWorkers: 1 });
        try {
            const result = await engine.startRun({
                userId: 'u1', root, name: 'disk-error', wait: true, timeoutSeconds: 5,
            });
            expect(result.run?.status).toBe('interrupted');
            expect(result.run?.error).toContain('持久化失败');
            expect((await new WorkflowRunStore(root).read(result.runId!))?.status).toBe('interrupted');
            expect(engine.getStats().active).toBe(0);
        } finally {
            await engine.shutdown();
        }
    });

    it('runs different workflows in parallel up to maxWorkers', async () => {
        const root = await createRoot();
        roots.push(root);
        await writeWorkflow(root, 'one', 'document:\n  name: one\ndo:\n  - a:\n      set:\n        value: 1\n');
        await writeWorkflow(root, 'two', 'document:\n  name: two\ndo:\n  - b:\n      set:\n        value: 2\n');

        const spawner = new FakeSpawner();
        spawner.defaultBehavior = (handle, message) => {
            setTimeout(() => {
                spawner.emitSuccess(handle, message, { done: true }, message.steps[0]?.path || '/do/0/step');
            }, 80);
        };
        const engine = new ProcessWorkerWorkflowEngine({ spawner, maxWorkers: 2 });
        try {
            const [first, second] = await Promise.all([
                engine.startRun({ userId: 'u1', root, name: 'one', wait: true, timeoutSeconds: 5 }),
                engine.startRun({ userId: 'u1', root, name: 'two', wait: true, timeoutSeconds: 5 }),
            ]);
            expect(first.run?.status).toBe('succeeded');
            expect(second.run?.status).toBe('succeeded');
            expect(spawner.maxConcurrent).toBe(2);
        } finally {
            await engine.shutdown();
        }
    });

    it('marks a crashed worker run interrupted and resumes from checkpoint', async () => {
        const root = await createRoot();
        roots.push(root);
        await writeWorkflow(root, 'crashy', [
            'document:',
            '  name: crashy',
            'do:',
            '  - first:',
            '      set:',
            '        value: 1',
            '  - second:',
            '      set:',
            '        value: 2',
        ].join('\n'));

        const spawner = new FakeSpawner();
        spawner.enqueue((handle, message) => {
            const stepPath = message.steps[0]?.path || '/do/0/first';
            handle.emit({
                type: 'run.step',
                runId: message.config.runId,
                step: {
                    path: stepPath,
                    name: 'first',
                    status: 'succeeded',
                    attempts: 1,
                    output: { value: 1 },
                },
            });
            handle.emit({
                type: 'run.checkpoint',
                runId: message.config.runId,
                checkpoint: { nextStepIndex: 1, context: { value: 1 }, completedPaths: [stepPath] },
            });
            handle.exit(1);
        });

        let resumeStartIndex: number | undefined;
        spawner.enqueue((handle, message) => {
            resumeStartIndex = message.startIndex;
            spawner.emitSuccess(handle, message, { value: 2 }, message.steps[1]?.path || '/do/1/second');
        });

        const engine = new ProcessWorkerWorkflowEngine({ spawner, maxWorkers: 1 });
        try {
            const result = await engine.startRun({
                userId: 'u1',
                root,
                name: 'crashy',
                wait: true,
                timeoutSeconds: 5,
            });
            expect(result.run?.status).toBe('interrupted');
            expect(result.run?.checkpoint?.nextStepIndex).toBe(1);

            const resumed = await engine.resumeRun({
                userId: 'u1',
                root,
                runId: result.runId!,
            });
            expect(resumed).toBe(true);
            const final = await waitForStatus(engine, {
                userId: 'u1',
                root,
                runId: result.runId!,
            }, 'succeeded');
            expect(resumeStartIndex).toBe(1);
            expect(final.checkpoint).toBeUndefined();
        } finally {
            await engine.shutdown();
        }
    });

    it('pauses for approval and resumes in a fresh worker', async () => {
        const root = await createRoot();
        roots.push(root);
        await writeWorkflow(root, 'approval', [
            'document:',
            '  name: approval',
            'do:',
            '  - approve:',
            '      call: approval',
            '      with:',
            '        message: please approve',
            '  - after:',
            '      set:',
            '        value: 2',
        ].join('\n'));

        const spawner = new FakeSpawner();
        spawner.enqueue((handle, message) => {
            const stepPath = message.steps[0]?.path || '/do/0/approve';
            handle.emit({
                type: 'run.step',
                runId: message.config.runId,
                step: {
                    path: stepPath,
                    name: 'approve',
                    status: 'waiting_approval',
                    attempts: 1,
                },
            });
            handle.emit({
                type: 'run.event',
                runId: message.config.runId,
                eventType: 'run.waiting_approval',
                data: { path: stepPath, message: 'please approve' },
            });
            handle.emit({
                type: 'run.result',
                runId: message.config.runId,
                status: 'waiting_approval',
                approval: {
                    stepPath,
                    message: 'please approve',
                    requestedAt: Date.now(),
                },
                checkpoint: { nextStepIndex: 1, context: {}, completedPaths: [stepPath] },
            });
        });
        let resumedStartIndex: number | undefined;
        spawner.enqueue((handle, message) => {
            resumedStartIndex = message.startIndex;
            spawner.emitSuccess(handle, message, { value: 2 }, message.steps[1]?.path || '/do/1/after');
        });

        const engine = new ProcessWorkerWorkflowEngine({ spawner, maxWorkers: 1 });
        try {
            const result = await engine.startRun({
                userId: 'u1',
                root,
                name: 'approval',
                wait: true,
                timeoutSeconds: 5,
            });
            expect(result.run?.status).toBe('waiting_approval');
            expect(result.run?.approval?.stepPath).toContain('/approve');

            expect(await engine.resumeRun({
                userId: 'u1',
                root,
                runId: result.runId!,
                decision: 'approve',
            })).toBe(true);
            await waitForStatus(engine, { userId: 'u1', root, runId: result.runId! }, 'succeeded');
            expect(resumedStartIndex).toBe(1);
        } finally {
            await engine.shutdown();
        }
    });

    it('lets cancellation win over a concurrently arriving approval result', async () => {
        const root = await createRoot();
        roots.push(root);
        await writeWorkflow(root, 'approval-race', 'document:\n  name: approval-race\ndo:\n  - approve:\n      call: approval\n');
        const spawner = new FakeSpawner();
        const engine = new ProcessWorkerWorkflowEngine({ spawner, maxWorkers: 1 });
        spawner.defaultBehavior = (handle, message) => {
            void engine.cancelRun({ userId: 'u1', root, runId: message.config.runId });
            handle.emit({
                type: 'run.result', runId: message.config.runId, status: 'waiting_approval',
                approval: { stepPath: '/do/0/approve', requestedAt: Date.now() },
                checkpoint: { nextStepIndex: 1, context: {}, completedPaths: [] },
            });
        };
        try {
            const result = await engine.startRun({
                userId: 'u1', root, name: 'approval-race', wait: true, timeoutSeconds: 5,
            });
            expect(result.run?.status).toBe('cancelled');
            expect((await new WorkflowRunStore(root).read(result.runId!))?.status).toBe('cancelled');
        } finally {
            await engine.shutdown();
        }
    });

    it('serializes approval and cancellation while respecting queue capacity', async () => {
        const root = await createRoot();
        roots.push(root);
        await writeWorkflow(root, 'approval-race', 'document:\n  name: approval-race\ndo:\n  - approve:\n      call: approval\n');
        const spawner = new FakeSpawner();
        spawner.enqueue((handle, message) => {
            handle.emit({
                type: 'run.result', runId: message.config.runId, status: 'waiting_approval',
                approval: { stepPath: '/do/0/approve', requestedAt: Date.now() },
                checkpoint: { nextStepIndex: 1, context: {}, completedPaths: [] },
            });
        });
        spawner.defaultBehavior = () => {};
        const engine = new ProcessWorkerWorkflowEngine({
            spawner, maxWorkers: 1, maxQueueSize: 1, maxConcurrentRunsPerWorkflow: 1,
        });
        try {
            const paused = await engine.startRun({
                userId: 'u1', root, name: 'approval-race', wait: true, timeoutSeconds: 5,
            });
            await engine.startRun({ userId: 'u1', root, name: 'approval-race' });
            const attempts = await Promise.all([
                engine.startRun({ userId: 'u1', root, name: 'approval-race' }),
                engine.startRun({ userId: 'u1', root, name: 'approval-race' }),
            ]);
            expect(attempts.filter((result) => result.ok)).toHaveLength(1);
            expect(attempts.find((result) => !result.ok)?.error).toBe('WORKFLOW_QUEUE_FULL');
            const request = { userId: 'u1', root, runId: paused.runId! };
            expect(await engine.resumeRun({ ...request, decision: 'approve' })).toBe(false);
            expect((await engine.getRun(request))?.status).toBe('waiting_approval');
            const [cancelled, resumed] = await Promise.all([
                engine.cancelRun(request),
                engine.resumeRun({ ...request, decision: 'approve' }),
            ]);
            expect([cancelled, resumed]).toEqual([true, false]);
            expect((await engine.getRun(request))?.status).toBe('cancelled');
        } finally {
            await engine.shutdown();
        }
    });

    it('serializes runs in the same concurrency group', async () => {
        const root = await createRoot();
        roots.push(root);
        await writeWorkflow(root, 'group-a', 'document:\n  name: group-a\ndo:\n  - a:\n      set:\n        value: 1\n');
        await writeWorkflow(root, 'group-b', 'document:\n  name: group-b\ndo:\n  - b:\n      set:\n        value: 2\n');

        const spawner = new FakeSpawner();
        spawner.defaultBehavior = (handle, message) => {
            setTimeout(() => {
                spawner.emitSuccess(handle, message, { done: true }, message.steps[0]?.path || '/do/0/step');
            }, 60);
        };
        const engine = new ProcessWorkerWorkflowEngine({ spawner, maxWorkers: 2 });
        try {
            const [first, second] = await Promise.all([
                engine.startRun({
                    userId: 'u1',
                    root,
                    name: 'group-a',
                    concurrencyGroup: 'write-workspace',
                    wait: true,
                    timeoutSeconds: 5,
                }),
                engine.startRun({
                    userId: 'u1',
                    root,
                    name: 'group-b',
                    concurrencyGroup: 'write-workspace',
                    wait: true,
                    timeoutSeconds: 5,
                }),
            ]);
            expect(first.run?.status).toBe('succeeded');
            expect(second.run?.status).toBe('succeeded');
            expect(spawner.maxConcurrent).toBe(1);
        } finally {
            await engine.shutdown();
        }
    });

    it('limits agent permits per provider across workers', async () => {
        const root = await createRoot();
        roots.push(root);
        await writeWorkflow(root, 'permit-a', 'document:\n  name: permit-a\ndo:\n  - a:\n      set:\n        value: 1\n');
        await writeWorkflow(root, 'permit-b', 'document:\n  name: permit-b\ndo:\n  - b:\n      set:\n        value: 2\n');

        const spawner = new FakeSpawner();
        let permitActive = 0;
        let maxPermitActive = 0;
        spawner.defaultBehavior = (handle, message) => {
            const requestId = `permit-${message.config.runId}`;
            handle.emit({
                type: 'run.permit',
                runId: message.config.runId,
                requestId,
                kind: 'agent',
                provider: 'test-provider',
                model: 'test-model',
            });
            void waitForGrant(handle, requestId).then(() => {
                permitActive++;
                maxPermitActive = Math.max(maxPermitActive, permitActive);
                setTimeout(() => {
                    permitActive--;
                    handle.emit({ type: 'run.permit.release', runId: message.config.runId, requestId });
                    spawner.emitSuccess(handle, message, { done: true }, message.steps[0]?.path || '/do/0/step');
                }, 30);
            });
        };
        const engine = new ProcessWorkerWorkflowEngine({
            spawner,
            maxWorkers: 2,
            agentConcurrencyPerProvider: 1,
        });
        try {
            const [first, second] = await Promise.all([
                engine.startRun({ userId: 'u1', root, name: 'permit-a', wait: true, timeoutSeconds: 5 }),
                engine.startRun({ userId: 'u1', root, name: 'permit-b', wait: true, timeoutSeconds: 5 }),
            ]);
            expect(first.run?.status).toBe('succeeded');
            expect(second.run?.status).toBe('succeeded');
            expect(maxPermitActive).toBe(1);
        } finally {
            await engine.shutdown();
        }
    });

    it('does not remove another worker’s waiter when request IDs collide', async () => {
        const root = await createRoot();
        roots.push(root);
        for (const name of ['holder', 'waiter', 'cancelled-waiter']) {
            await writeWorkflow(root, name, `document:\n  name: ${name}\ndo:\n  - item:\n      set:\n        value: 1\n`);
        }
        const spawner = new FakeSpawner();
        spawner.defaultBehavior = (handle, message) => {
            handle.emit({
                type: 'run.permit',
                runId: message.config.runId,
                requestId: 'permit-1',
                kind: 'agent',
                provider: 'shared',
                model: 'model',
            });
        };
        const engine = new ProcessWorkerWorkflowEngine({
            spawner, maxWorkers: 3, agentConcurrencyPerProvider: 1,
        });
        const waitForStart = async (index: number) => {
            const deadline = Date.now() + 3000;
            while (Date.now() < deadline) {
                const handle = spawner.handles[index];
                const message = handle?.messages.find((entry) => entry.type === 'run.start');
                if (handle && message?.type === 'run.start') return { handle, message };
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            throw new Error('Worker did not start');
        };
        try {
            await engine.startRun({ userId: 'u1', root, name: 'holder' });
            const holder = await waitForStart(0);
            await waitForGrant(holder.handle, 'permit-1');
            await engine.startRun({ userId: 'u1', root, name: 'waiter' });
            const waiter = await waitForStart(1);
            await engine.startRun({ userId: 'u1', root, name: 'cancelled-waiter' });
            const cancelled = await waitForStart(2);
            await new Promise((resolve) => setTimeout(resolve, 50));
            cancelled.handle.emit({
                type: 'run.permit.release', runId: cancelled.message.config.runId, requestId: 'permit-1',
            });
            holder.handle.emit({
                type: 'run.permit.release', runId: holder.message.config.runId, requestId: 'permit-1',
            });
            await waitForGrant(waiter.handle, 'permit-1');
            expect(cancelled.handle.messages.some((message) => message.type === 'run.permit.granted')).toBe(false);
        } finally {
            await engine.shutdown();
        }
    });

    it('shares model request rate limits across workers and removes cancelled waiters', async () => {
        const root = await createRoot();
        roots.push(root);
        await writeWorkflow(root, 'rate', 'document:\n  name: rate\ndo:\n  - first:\n      set:\n        value: 1\n');
        const spawner = new FakeSpawner();
        const started: Array<{ handle: FakeWorkerHandle; message: WorkflowWorkerRunStartMessage }> = [];
        spawner.defaultBehavior = (handle, message) => {
            started.push({ handle, message });
            handle.emit({
                type: 'run.rate', runId: message.config.runId, requestId: 'rate-1',
                provider: 'OpenAI', model: 'model',
            });
        };
        const engine = new ProcessWorkerWorkflowEngine({
            spawner, maxWorkers: 3, maxConcurrentRunsPerWorkflow: 3,
            agentRequestsPerMinute: 60, agentRequestBurst: 1,
        });
        const waitUntil = async (condition: () => boolean, timeout = 2500) => {
            const deadline = Date.now() + timeout;
            while (!condition()) {
                if (Date.now() >= deadline) throw new Error('Timed out waiting for rate request');
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        };
        const granted = (index: number) => started[index]?.handle.messages.some(
            (message) => message.type === 'run.rate.granted' && message.requestId === 'rate-1',
        );
        try {
            await engine.startRun({ userId: 'u1', root, name: 'rate' });
            await waitUntil(() => started.length === 1 && Boolean(granted(0)));
            await engine.startRun({ userId: 'u1', root, name: 'rate' });
            await waitUntil(() => started.length === 2);
            await engine.startRun({ userId: 'u1', root, name: 'rate' });
            await waitUntil(() => started.length === 3);
            expect(started.every(({ message }) => message.config.requestRateEnabled)).toBe(true);
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(granted(1)).toBe(false);
            expect(granted(2)).toBe(false);
            started[1].handle.emit({
                type: 'run.rate.cancel', runId: started[1].message.config.runId, requestId: 'rate-1',
            });
            await waitUntil(() => Boolean(granted(2)));
            expect(granted(1)).toBe(false);
        } finally {
            await engine.shutdown();
        }
    });

    it('releases permits when a worker crashes', async () => {
        const root = await createRoot();
        roots.push(root);
        await writeWorkflow(root, 'permit-crash', 'document:\n  name: permit-crash\ndo:\n  - a:\n      set:\n        value: 1\n');
        await writeWorkflow(root, 'permit-after', 'document:\n  name: permit-after\ndo:\n  - b:\n      set:\n        value: 2\n');

        const spawner = new FakeSpawner();
        spawner.enqueue((handle, message) => {
            const requestId = `permit-${message.config.runId}`;
            handle.emit({
                type: 'run.permit',
                runId: message.config.runId,
                requestId,
                kind: 'agent',
                provider: 'crash-provider',
                model: 'm',
            });
            void waitForGrant(handle, requestId).then(() => handle.exit(1));
        });
        spawner.enqueue((handle, message) => {
            const requestId = `permit-${message.config.runId}`;
            handle.emit({
                type: 'run.permit',
                runId: message.config.runId,
                requestId,
                kind: 'agent',
                provider: 'crash-provider',
                model: 'm',
            });
            void waitForGrant(handle, requestId).then(() => {
                handle.emit({ type: 'run.permit.release', runId: message.config.runId, requestId });
                spawner.emitSuccess(handle, message, { done: true }, message.steps[0]?.path || '/do/0/step');
            });
        });

        const engine = new ProcessWorkerWorkflowEngine({
            spawner,
            maxWorkers: 2,
            agentConcurrencyPerProvider: 1,
        });
        try {
            const crashed = await engine.startRun({
                userId: 'u1',
                root,
                name: 'permit-crash',
                wait: true,
                timeoutSeconds: 5,
            });
            expect(crashed.run?.status).toBe('interrupted');

            const next = await engine.startRun({
                userId: 'u1',
                root,
                name: 'permit-after',
                wait: true,
                timeoutSeconds: 5,
            });
            expect(next.run?.status).toBe('succeeded');
        } finally {
            await engine.shutdown();
        }
    });

    it('cancels an active worker', async () => {
        const root = await createRoot();
        roots.push(root);
        await writeWorkflow(root, 'cancel', 'document:\n  name: cancel\ndo:\n  - wait:\n      wait: 5s\n');

        const spawner = new FakeSpawner();
        spawner.defaultBehavior = (handle, message) => {
            // 不主动结束；等待 run.cancel 后由 fake handle 退出，引擎标记 cancelled
            if (message.type === 'run.start') {
                handle.emit({
                    type: 'run.patch',
                    runId: message.config.runId,
                    patch: { currentTask: message.steps[0]?.path },
                });
            }
        };
        const engine = new ProcessWorkerWorkflowEngine({ spawner, maxWorkers: 1, cancelGraceMs: 200 });
        try {
            const result = await engine.startRun({ userId: 'u1', root, name: 'cancel' });
            expect(result.ok).toBe(true);
            expect(await engine.cancelRun({ userId: 'u1', root, runId: result.runId! })).toBe(true);
            const final = await waitForStatus(engine, {
                userId: 'u1',
                root,
                runId: result.runId!,
            }, 'cancelled');
            expect(final.status).toBe('cancelled');
        } finally {
            await engine.shutdown();
        }
    });

    it('marks a silent worker interrupted on heartbeat timeout', async () => {
        const root = await createRoot();
        roots.push(root);
        await writeWorkflow(root, 'silent', 'document:\n  name: silent\ndo:\n  - wait:\n      wait: 5s\n');

        const spawner = new FakeSpawner();
        spawner.defaultBehavior = () => {
            // 不发心跳，等待主进程超时回收
        };
        const engine = new ProcessWorkerWorkflowEngine({
            spawner,
            maxWorkers: 1,
            heartbeatIntervalMs: 200,
            heartbeatTimeoutMs: 1100,
            cancelGraceMs: 200,
        });
        try {
            const result = await engine.startRun({
                userId: 'u1',
                root,
                name: 'silent',
                wait: true,
                timeoutSeconds: 5,
            });
            expect(result.run?.status).toBe('interrupted');
            expect(result.run?.error).toContain('心跳超时');
        } finally {
            await engine.shutdown();
        }
    });

    it('rejects when the queue is full', async () => {
        const root = await createRoot();
        roots.push(root);
        await writeWorkflow(root, 'queue', 'document:\n  name: queue\ndo:\n  - wait:\n      wait: 5s\n');

        const spawner = new FakeSpawner();
        spawner.defaultBehavior = () => {};
        const engine = new ProcessWorkerWorkflowEngine({
            spawner,
            maxWorkers: 1,
            maxQueueSize: 1,
        });
        try {
            const first = await engine.startRun({ userId: 'u1', root, name: 'queue' });
            const second = await engine.startRun({ userId: 'u1', root, name: 'queue' });
            const third = await engine.startRun({ userId: 'u1', root, name: 'queue' });
            expect(first.ok).toBe(true);
            expect(second.ok).toBe(true);
            expect(third.ok).toBe(false);
            expect(third.error).toBe('WORKFLOW_QUEUE_FULL');
        } finally {
            await engine.shutdown();
        }
    });
});
