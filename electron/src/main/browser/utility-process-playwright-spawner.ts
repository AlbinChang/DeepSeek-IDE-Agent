/**
 * Playwright Worker 的 Electron utilityProcess 启动器。
 *
 * 只负责进程创建与信号转发，监督逻辑在 PlaywrightWorkerClient 里。
 * 杀进程时优先 taskkill 整棵树：MCP 进程下面还挂着 Chrome，
 * 只 kill 顶层会留下孤儿浏览器进程（旧实现的隐性泄漏点之一）。
 */

import { utilityProcess } from 'electron';
import { spawn as spawnProcess } from 'node:child_process';

import type {
    MainToWorkerMessage,
    PlaywrightWorkerHandle,
    PlaywrightWorkerSpawner,
    WorkerToMainMessage,
} from '@/services/playwrightWorkerProtocol.js';
import { isWorkerToMainMessage } from '@/services/playwrightWorkerProtocol.js';

export interface UtilityProcessPlaywrightSpawnerOptions {
    /** playwrightMcpWorker.cjs 的绝对路径 */
    entry: string;
    env?: NodeJS.ProcessEnv;
    serviceNamePrefix?: string;
}

export class UtilityProcessPlaywrightSpawner implements PlaywrightWorkerSpawner {
    private readonly entry: string;
    private readonly env: Record<string, string>;
    private readonly serviceNamePrefix: string;

    constructor(options: UtilityProcessPlaywrightSpawnerOptions) {
        this.entry = options.entry;
        this.serviceNamePrefix = options.serviceNamePrefix || 'playwright-mcp-worker';
        this.env = Object.fromEntries(
            Object.entries(options.env || process.env)
                .filter(([, value]) => typeof value === 'string'),
        ) as Record<string, string>;
    }

    public spawn(): PlaywrightWorkerHandle {
        const serviceName = `${this.serviceNamePrefix}-${process.pid}`;
        const child = utilityProcess.fork(this.entry, [], {
            serviceName,
            // 用 'pipe' 并显式消费输出：若管道无人读取，写满缓冲区后
            // Worker（及其内部 Chrome）会被阻塞在 stderr 写入上，表现为工具调用卡死。
            stdio: 'pipe',
            env: this.env,
        });
        return new UtilityProcessPlaywrightHandle(child, serviceName);
    }
}

class UtilityProcessPlaywrightHandle implements PlaywrightWorkerHandle {
    public pid?: number;

    private readonly messageListeners = new Set<(message: WorkerToMainMessage) => void>();
    private readonly exitListeners = new Set<(code: number | null) => void>();
    private readonly pending: WorkerToMainMessage[] = [];
    private readonly outputTail: string[] = [];
    private exitCode: number | null | undefined;

    constructor(
        private readonly child: Electron.UtilityProcess,
        private readonly serviceName: string,
    ) {
        this.pid = child.pid;
        drainToRingBuffer(child.stdout, this.outputTail);
        drainToRingBuffer(child.stderr, this.outputTail);
        child.on('spawn', () => {
            this.pid = child.pid;
        });
        child.on('message', (message: unknown) => {
            if (!isWorkerToMainMessage(message)) {
                console.warn(`[PlaywrightWorker] Ignoring invalid message (${this.serviceName})`);
                return;
            }
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
        child.on('exit', (code: number) => {
            this.exitCode = code;
            if (code !== 0 && this.outputTail.length > 0) {
                console.warn(
                    `[PlaywrightWorker] ${this.serviceName} exited with code ${code}. Recent output:\n`
                    + this.outputTail.join('\n'),
                );
            }
            this.outputTail.length = 0;
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
        this.child.postMessage(message);
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
                const fallback = setTimeout(() => {
                    if (this.exitCode === undefined) {
                        try {
                            this.child.kill();
                        } catch {
                            // ignore
                        }
                    }
                }, 1000);
                fallback.unref?.();
                return;
            } catch {
                // 回退到 child.kill()
            }
        }
        try {
            this.child.kill();
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
