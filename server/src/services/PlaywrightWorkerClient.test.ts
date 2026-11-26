import { describe, expect, it, vi } from 'vitest';

import { PlaywrightWorkerClient } from '@/services/PlaywrightWorkerClient.js';
import type {
    MainToWorkerMessage,
    PlaywrightMcpLaunchConfig,
    PlaywrightWorkerErrorCode,
    PlaywrightWorkerHandle,
    PlaywrightWorkerSpawner,
    WorkerToMainMessage,
} from '@/services/playwrightWorkerProtocol.js';
import { PLAYWRIGHT_WORKER_PROTOCOL_VERSION } from '@/services/playwrightWorkerProtocol.js';

const LAUNCH_CONFIG: PlaywrightMcpLaunchConfig = {
    command: 'node',
    args: ['/fake/cli.js'],
    cwd: '/fake/ws',
    env: {},
};

/** 可编程的假 Worker：记录收到的消息，按用例决定如何应答 */
class FakeHandle implements PlaywrightWorkerHandle {
    public readonly pid = 4242;
    public readonly sent: MainToWorkerMessage[] = [];
    public killed = false;

    private readonly messageListeners = new Set<(message: WorkerToMainMessage) => void>();
    private readonly exitListeners = new Set<(code: number | null) => void>();
    private exiting = false;

    constructor(private readonly respond: (handle: FakeHandle, message: MainToWorkerMessage) => void) {}

    public postMessage(message: MainToWorkerMessage): void {
        if (this.killed) return;
        this.sent.push(message);
        queueMicrotask(() => {
            if (this.killed) return;
            this.respond(this, message);
        });
    }

    public onMessage(listener: (message: WorkerToMainMessage) => void): () => void {
        this.messageListeners.add(listener);
        return () => this.messageListeners.delete(listener);
    }

    public onExit(listener: (code: number | null) => void): () => void {
        this.exitListeners.add(listener);
        return () => this.exitListeners.delete(listener);
    }

    public kill(): void {
        if (this.killed) return;
        this.killed = true;
        this.emitExit(null);
    }

    public emit(message: WorkerToMainMessage): void {
        for (const listener of [...this.messageListeners]) listener(message);
    }

    public emitExit(code: number | null): void {
        if (this.exiting) return;
        this.exiting = true;
        for (const listener of [...this.exitListeners]) listener(code);
    }

    public ready(): void {
        this.emit({ type: 'worker.ready', protocolVersion: PLAYWRIGHT_WORKER_PROTOCOL_VERSION, pid: this.pid });
    }

    public ok(requestId: string, data: unknown): void {
        this.emit({ type: 'mcp.result', requestId, ok: true, data, durationMs: 1 });
    }

    public fail(requestId: string, code: PlaywrightWorkerErrorCode, error: string): void {
        this.emit({ type: 'mcp.result', requestId, ok: false, code, error, durationMs: 1 });
    }
}

const CONNECT_RESULT = { tools: [], resources: [], prompts: [], pid: 4242, durationMs: 1 };

class FakeSpawner implements PlaywrightWorkerSpawner {
    public readonly handles: FakeHandle[] = [];

    constructor(private readonly respond: (handle: FakeHandle, message: MainToWorkerMessage) => void) {}

    public spawn(): PlaywrightWorkerHandle {
        const handle = new FakeHandle(this.respond);
        this.handles.push(handle);
        queueMicrotask(() => handle.ready());
        return handle;
    }

    public get latest(): FakeHandle {
        return this.handles[this.handles.length - 1];
    }
}

/** 默认应答：connect 立刻成功，call 立刻返回文本 */
const defaultRespond = (handle: FakeHandle, message: MainToWorkerMessage): void => {
    if (message.type === 'mcp.connect') handle.ok(message.requestId, CONNECT_RESULT);
    if (message.type === 'mcp.call') handle.ok(message.requestId, { content: [{ type: 'text', text: 'ok' }] });
};

const createClient = (
    spawner: FakeSpawner,
    overrides: Partial<ConstructorParameters<typeof PlaywrightWorkerClient>[0]> = {},
) => new PlaywrightWorkerClient({
    spawner,
    readyTimeoutMs: 50,
    watchdogGraceMs: 20,
    maxRestarts: 2,
    ...overrides,
});

describe('PlaywrightWorkerClient', () => {
    it('connect 后工具调用走 worker 进程', async () => {
        const spawner = new FakeSpawner(defaultRespond);
        const client = createClient(spawner);

        await client.connect(LAUNCH_CONFIG, true);
        const result = await client.callTool('browser_navigate', { url: 'https://example.com' }, 1000);

        expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
        expect(spawner.latest.sent.find((message) => message.type === 'mcp.call'))
            .toMatchObject({ name: 'browser_navigate', args: { url: 'https://example.com' } });
        await client.dispose();
    });

    it('未连接时调用直接失败，不排队等待', async () => {
        const spawner = new FakeSpawner(defaultRespond);
        const client = createClient(spawner);

        await expect(client.callTool('browser_navigate', {}, 1000))
            .rejects.toMatchObject({ code: 'mcp_not_connected' });
        await client.dispose();
    });

    it('Worker 报告工具超时：标记断开并自动重建，不重复杀进程', async () => {
        let callCount = 0;
        const spawner = new FakeSpawner((handle, message) => {
            if (message.type === 'mcp.connect') {
                handle.ok(message.requestId, CONNECT_RESULT);
                return;
            }
            if (message.type === 'mcp.call') {
                callCount += 1;
                // 第一次：Worker 内部判定超时（它会自己杀掉 MCP 子进程）
                if (callCount === 1) {
                    handle.fail(message.requestId, 'tool_timeout', 'Playwright MCP tool call timed out');
                    return;
                }
                handle.ok(message.requestId, { content: [{ type: 'text', text: 'recovered' }] });
            }
        });
        const client = createClient(spawner, { maxRestarts: 3 });

        await client.connect(LAUNCH_CONFIG, true);
        await expect(client.callTool('browser_snapshot', {}, 5000))
            .rejects.toMatchObject({ code: 'tool_timeout' });
        expect(client.getStatus().connected).toBe(false);

        await vi.waitFor(() => {
            expect(spawner.handles.length).toBeGreaterThan(1);
            expect(client.getStatus().connected).toBe(true);
        }, { timeout: 3000, interval: 50 });

        const result = await client.callTool('browser_snapshot', {}, 1000);
        expect(result).toEqual({ content: [{ type: 'text', text: 'recovered' }] });
        await client.dispose();
    });

    it('Worker 完全无响应：宿主看门狗强杀进程树并重建', async () => {
        let callCount = 0;
        const spawner = new FakeSpawner((handle, message) => {
            if (message.type === 'mcp.connect') {
                handle.ok(message.requestId, CONNECT_RESULT);
                return;
            }
            if (message.type === 'mcp.call') {
                callCount += 1;
                // 第一次调用永远不返回（连超时都上报不了 → 进程僵死）
                if (callCount === 1) return;
                handle.ok(message.requestId, { content: [{ type: 'text', text: 'recovered' }] });
            }
        });
        const client = createClient(spawner, { maxRestarts: 3 });

        await client.connect(LAUNCH_CONFIG, true);
        await expect(client.callTool('browser_snapshot', {}, 30))
            .rejects.toMatchObject({ code: 'worker_timeout' });
        expect(spawner.handles[0].killed).toBe(true);

        await vi.waitFor(() => {
            expect(spawner.handles.length).toBeGreaterThan(1);
            expect(client.getStatus().connected).toBe(true);
        }, { timeout: 3000, interval: 50 });

        const result = await client.callTool('browser_snapshot', {}, 1000);
        expect(result).toEqual({ content: [{ type: 'text', text: 'recovered' }] });
        await client.dispose();
    });

    it('worker 崩溃后立即感知并让在途请求失败', async () => {
        let callCount = 0;
        const spawner = new FakeSpawner((handle, message) => {
            if (message.type === 'mcp.connect') {
                handle.ok(message.requestId, CONNECT_RESULT);
                return;
            }
            if (message.type === 'mcp.call') {
                callCount += 1;
                if (callCount === 1) {
                    handle.emitExit(137);
                    return;
                }
                handle.ok(message.requestId, { content: [{ type: 'text', text: 'after-crash' }] });
            }
        });
        const client = createClient(spawner, { maxRestarts: 3 });

        await client.connect(LAUNCH_CONFIG, true);
        await expect(client.callTool('browser_snapshot', {}, 5000))
            .rejects.toMatchObject({ code: 'worker_exited' });

        await vi.waitFor(() => {
            expect(client.getStatus().connected).toBe(true);
        }, { timeout: 3000, interval: 50 });
        await client.dispose();
    });

    it('自动重建次数达上限后停止重启，避免崩溃风暴', async () => {
        const spawner = new FakeSpawner((handle, message) => {
            if (message.type === 'mcp.connect') {
                handle.ok(message.requestId, CONNECT_RESULT);
                return;
            }
            if (message.type === 'mcp.call') handle.emitExit(1);
        });
        const client = createClient(spawner, { maxRestarts: 1 });

        await client.connect(LAUNCH_CONFIG, true);
        await expect(client.callTool('browser_snapshot', {}, 5000)).rejects.toBeTruthy();

        // 第一次崩溃会触发重建；重建后的再次崩溃超过上限，不再拉起新进程
        await vi.waitFor(() => {
            expect(spawner.handles.length).toBe(2);
        }, { timeout: 3000, interval: 50 });

        const afterRecovery = spawner.handles.length;
        await new Promise((resolve) => setTimeout(resolve, 900));
        expect(spawner.handles.length).toBe(afterRecovery);
        await client.dispose();
    });

    it('自愈窗口内 waitForConnected 等到重连成功再返回', async () => {
        const spawner = new FakeSpawner(defaultRespond);
        const client = createClient(spawner, { maxRestarts: 3 });

        await client.connect(LAUNCH_CONFIG, true);
        // 模拟一次让连接进入自愈窗口的崩溃
        spawner.latest.emitExit(1);
        expect(client.getStatus().connected).toBe(false);

        const recovered = await client.waitForConnected(3000);
        expect(recovered).toBe(true);
        expect(client.getStatus().connected).toBe(true);
        await client.dispose();
    });

    it('未连接且无重建机会时 waitForConnected 超时返回 false', async () => {
        const spawner = new FakeSpawner(defaultRespond);
        const client = createClient(spawner);

        const recovered = await client.waitForConnected(30);
        expect(recovered).toBe(false);
        await client.dispose();
    });

    it('dispose 后 waitForConnected 立即失败，不白等', async () => {
        const spawner = new FakeSpawner(defaultRespond);
        const client = createClient(spawner);

        const waiting = client.waitForConnected(5000);
        await client.dispose();
        await expect(waiting).resolves.toBe(false);
    });

    it('dispose 后不再重建，并杀掉 worker', async () => {
        const spawner = new FakeSpawner(defaultRespond);
        const client = createClient(spawner);

        await client.connect(LAUNCH_CONFIG, true);
        const handle = spawner.latest;
        await client.dispose();

        expect(handle.killed).toBe(true);
        expect(client.getStatus().running).toBe(false);
        await expect(client.callTool('browser_snapshot', {}, 1000))
            .rejects.toMatchObject({ code: 'worker_not_started' });
    });

    it('协议版本不匹配时拒绝复用 worker', async () => {
        const spawner: PlaywrightWorkerSpawner = {
            spawn: () => {
                const handle = new FakeHandle(defaultRespond);
                queueMicrotask(() => handle.emit({
                    type: 'worker.ready',
                    protocolVersion: PLAYWRIGHT_WORKER_PROTOCOL_VERSION + 1,
                    pid: 1,
                }));
                return handle;
            },
        };
        const client = new PlaywrightWorkerClient({ spawner, readyTimeoutMs: 50 });
        await expect(client.connect(LAUNCH_CONFIG, true))
            .rejects.toMatchObject({ code: 'worker_not_started' });
        await client.dispose();
    });
});
