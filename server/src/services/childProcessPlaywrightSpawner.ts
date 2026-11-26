/**
 * Playwright Worker 的 child_process 启动器（非 Electron 环境的兜底实现）。
 *
 * Electron 主进程会注入 utilityProcess 版本；纯 Node（本地调试、集成测试、
 * 或将来把 server 拆成独立进程时）用 fork 即可获得同样的隔离与自愈能力。
 */

import { fork, spawn as spawnProcess, type ChildProcess } from 'node:child_process';

import type {
    MainToWorkerMessage,
    PlaywrightWorkerHandle,
    PlaywrightWorkerSpawner,
    WorkerToMainMessage,
} from '@/services/playwrightWorkerProtocol.js';
import { isWorkerToMainMessage } from '@/services/playwrightWorkerProtocol.js';

export interface ChildProcessPlaywrightSpawnerOptions {    /** playwrightMcpWorker.cjs 的绝对路径 */
    entry: string;
    env?: NodeJS.ProcessEnv;
}

export class ChildProcessPlaywrightSpawner implements PlaywrightWorkerSpawner {
    private readonly entry: string;
    private readonly env: Record<string, string>;

    constructor(options: ChildProcessPlaywrightSpawnerOptions) {
        this.entry = options.entry;
        this.env = Object.fromEntries(
            Object.entries(options.env || process.env)
                .filter(([, value]) => typeof value === 'string'),
        ) as Record<string, string>;
    }

    public spawn(): PlaywrightWorkerHandle {
        const child = fork(this.entry, [], {
            // stdout/stderr 必须被消费：Worker 里 Chrome 的日志量很大，
            // 若用 'pipe' 却不读取，管道缓冲区（~64KB）写满后子进程会被
            // 阻塞在写系统调用上，表现为「工具调用永久无响应」。
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            env: this.env,
        });
        return new ChildProcessPlaywrightHandle(child);
    }
}

class ChildProcessPlaywrightHandle implements PlaywrightWorkerHandle {
    public pid?: number;

    private readonly messageListeners = new Set<(message: WorkerToMainMessage) => void>();
    private readonly exitListeners = new Set<(code: number | null) => void>();
    private readonly pending: WorkerToMainMessage[] = [];
    private readonly stderrTail: string[] = [];
    private exitCode: number | null | undefined;

    constructor(private readonly child: ChildProcess) {
        this.pid = child.pid ?? undefined;
        drainToRingBuffer(child.stdout, this.stderrTail);
        drainToRingBuffer(child.stderr, this.stderrTail);
        child.on('message', (message: unknown) => {
            if (!isWorkerToMainMessage(message)) return;
            if (this.messageListeners.size === 0) {
                this.pending.push(message);
                return;
            }
            for (const listener of this.messageListeners) {
                try {
                    listener(message);
                } catch (error) {
                    console.warn('[PlaywrightWorker] Message listener failed:', error);
                }
            }
        });
        child.on('exit', (code: number | null) => {
            this.exitCode = code;
            if (code !== 0 && code !== null && this.stderrTail.length > 0) {
                console.warn(
                    `[PlaywrightWorker] Worker exited with code ${code}. Recent output:\n`
                    + this.stderrTail.join('\n'),
                );
            }
            this.stderrTail.length = 0;
            for (const listener of this.exitListeners) {
                try {
                    listener(code);
                } catch (error) {
                    console.warn('[PlaywrightWorker] Exit listener failed:', error);
                }
            }
        });
    }

    public postMessage(message: MainToWorkerMessage): void {
        this.child.send?.(message, (error) => {
            if (error) {
                console.warn(`[PlaywrightWorker] postMessage failed: ${error.message}`);
            }
        });
    }

    public onMessage(listener: (message: WorkerToMainMessage) => void): () => void {
        this.messageListeners.add(listener);
        if (this.pending.length > 0) {
            const queued = this.pending.splice(0, this.pending.length);
            for (const message of queued) listener(message);
        }
        return () => this.messageListeners.delete(listener);
    }

    public onExit(listener: (code: number | null) => void): () => void {
        this.exitListeners.add(listener);
        if (this.exitCode !== undefined) {
            queueMicrotask(() => listener(this.exitCode ?? null));
        }
        return () => this.exitListeners.delete(listener);
    }

    public kill(): void {
        if (this.exitCode !== undefined) return;
        if (this.pid && process.platform === 'win32') {
            try {
                const killer = spawnProcess('taskkill', ['/PID', String(this.pid), '/T', '/F'], {
                    windowsHide: true,
                    stdio: 'ignore',
                });
                killer.on('error', () => {
                    try {
                        this.child.kill();
                    } catch {
                        // ignore
                    }
                });
                return;
            } catch {
                // 回退
            }
        }
        try {
            this.child.kill('SIGKILL');
        } catch {
            // 可能已退出
        }
    }
}

/** 持续消费子进程输出，只保留末尾若干行用于事后诊断 */
function drainToRingBuffer(
    stream: NodeJS.ReadableStream | null | undefined,
    tail: string[],
    maxLines = 20,
): void {
    if (!stream) return;
    stream.setEncoding?.('utf8');
    let buffer = '';
    stream.on('data', (chunk: string | Buffer) => {
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (!line.trim()) continue;
            tail.push(line);
            if (tail.length > maxLines) tail.shift();
        }
    });
    stream.on('error', () => {
        // 进程退出时流关闭会报错，忽略
    });
}
