/**
 * Playwright Worker 宿主侧监督器。
 *
 * 职责（全部围绕「别让主进程被一个僵死的浏览器拖垮」）：
 * - 拉起/重启独立的 Playwright MCP Worker 进程；
 * - 每个请求都带超时看门狗，超时即杀掉 Worker 进程树（含 Chrome）并重建；
 * - Worker 崩溃/退出立即感知，先让在途请求失败，再按退避策略自动重启；
 * - 对上层暴露与平台无关的最小接口，Electron / 纯 Node 都可用。
 */

import {
    PLAYWRIGHT_WORKER_PROTOCOL_VERSION,
    type MainToWorkerMessage,
    type PlaywrightMcpLaunchConfig,
    type PlaywrightWorkerConnectResult,
    type PlaywrightWorkerErrorCode,
    type PlaywrightWorkerHandle,
    type PlaywrightWorkerSpawner,
    type WorkerToMainMessage,
} from '@/services/playwrightWorkerProtocol.js';
import { getBeijingLogTimePrefix } from '@/utils/TimeUtils.js';

const getTS = () => getBeijingLogTimePrefix();

/** Worker 就绪超时（进程启动 + IPC 握手） */
const DEFAULT_READY_TIMEOUT_MS = 15_000;
/** 工具调用超时后，宿主再等这么久才判定 Worker 僵死并强杀 */
const DEFAULT_WATCHDOG_GRACE_MS = 10_000;
/** 自动重启的最大次数（成功后清零） */
const DEFAULT_MAX_RESTARTS = 5;
/** 重启退避基数（毫秒），按 2^n 递增，上限 8s */
const RESTART_BACKOFF_BASE_MS = 500;
const RESTART_BACKOFF_MAX_MS = 8_000;

export interface PlaywrightWorkerCallError extends Error {
    code: PlaywrightWorkerErrorCode | 'worker_exited' | 'worker_timeout' | 'worker_not_started';
}

const createCallError = (
    code: PlaywrightWorkerCallError['code'],
    message: string,
): PlaywrightWorkerCallError => Object.assign(new Error(message), { code });

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    kind: 'connect' | 'call' | 'restart' | 'dispose';
}

export interface PlaywrightWorkerStatus {
    running: boolean;
    connected: boolean;
    pid?: number;
    lastError?: string;
    restarts: number;
}

export interface PlaywrightWorkerClientOptions {
    spawner: PlaywrightWorkerSpawner;
    readyTimeoutMs?: number;
    watchdogGraceMs?: number;
    maxRestarts?: number;
    /** Worker 连接状态变化（含崩溃）时回调，用于同步原 Prompt/工具列表 */
    onStateChange?: (connected: boolean, reason?: string) => void;
}

export class PlaywrightWorkerClient {
    private readonly spawner: PlaywrightWorkerSpawner;
    private readonly readyTimeoutMs: number;
    private readonly watchdogGraceMs: number;
    private readonly maxRestarts: number;
    private readonly onStateChange?: (connected: boolean, reason?: string) => void;

    private handle: PlaywrightWorkerHandle | null = null;
    private connected = false;
    private disposed = false;
    private restarts = 0;
    private lastError?: string;
    private lastConfig?: PlaywrightMcpLaunchConfig;
    private lastConnectResult?: PlaywrightWorkerConnectResult;
    private pending = new Map<string, PendingRequest>();
    private connectedWaiters = new Set<() => void>();
    private seq = 0;
    private restartTimer: ReturnType<typeof setTimeout> | null = null;
    private starting: Promise<void> | null = null;

    constructor(options: PlaywrightWorkerClientOptions) {
        this.spawner = options.spawner;
        this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
        this.watchdogGraceMs = options.watchdogGraceMs ?? DEFAULT_WATCHDOG_GRACE_MS;
        this.maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
        this.onStateChange = options.onStateChange;
    }

    getStatus(): PlaywrightWorkerStatus {
        return {
            running: this.handle !== null,
            connected: this.connected,
            pid: this.handle?.pid,
            lastError: this.lastError,
            restarts: this.restarts,
        };
    }

    /** 确保 Worker 进程存在（不保证 MCP 已连接） */
    async ensureStarted(): Promise<void> {
        if (this.disposed) throw createCallError('worker_not_started', 'Playwright Worker 已释放');
        if (this.handle) return;
        if (this.starting) return this.starting;

        this.starting = (async () => {
            const handle = this.spawner.spawn();
            this.handle = handle;
            handle.onMessage((message) => this.handleMessage(message));
            handle.onExit((code) => this.handleExit(handle, code));

            await this.waitForReady();
            console.log(`${getTS()} [PlaywrightWorker] Worker ready (pid=${handle.pid ?? '?'})`);
        })().finally(() => {
            this.starting = null;
        });

        return this.starting;
    }

    /**
     * 建立/复用 MCP 连接并返回工具清单。
     * 已连接且工具清单已缓存时直接复用，避免每次对话都重启浏览器。
     */
    async connect(config: PlaywrightMcpLaunchConfig, force = false): Promise<PlaywrightWorkerConnectResult> {
        this.lastConfig = config;
        if (this.connected && !force && this.lastConnectResult) {
            return this.lastConnectResult;
        }
        await this.ensureStarted();

        const requestId = this.nextRequestId('connect');
        const timeoutMs = this.readyTimeoutMs * 4;
        const result = await this.request(requestId, {
            type: 'mcp.connect',
            requestId,
            config,
        }, timeoutMs, 'connect') as PlaywrightWorkerConnectResult;

        this.connected = true;
        this.restarts = 0;
        this.lastError = undefined;
        this.lastConnectResult = result;
        this.notifyConnected();
        this.onStateChange?.(true);
        return result;
    }

    /**
     * 等待连接恢复（通常用于工具调用前一瞬间处于自愈窗口的情况）。
     * 返回 true 表示已连接；false 表示超时或已释放。
     */
    waitForConnected(timeoutMs: number): Promise<boolean> {
        if (this.connected) return Promise.resolve(true);
        if (this.disposed) return Promise.resolve(false);

        return new Promise<boolean>((resolve) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout>;
            const finish = (value: boolean) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.connectedWaiters.delete(notify);
                resolve(value);
            };
            const notify = () => finish(this.connected);
            this.connectedWaiters.add(notify);
            timer = setTimeout(() => finish(false), timeoutMs);
            timer.unref?.();
        });
    }

    /**
     * 调用一个 MCP 原生工具。
     * 超时/进程死亡都会让 Worker 自愈：这里额外加上看门狗时间，超时后强杀并重建。
     */
    async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
        if (this.disposed) throw createCallError('worker_not_started', 'Playwright Worker 已释放');
        if (!this.connected) {
            throw createCallError('mcp_not_connected', 'Playwright MCP 未连接');
        }

        const requestId = this.nextRequestId('call');
        try {
            return await this.request(requestId, {
                type: 'mcp.call',
                requestId,
                name,
                args,
                timeoutMs,
            }, timeoutMs + this.watchdogGraceMs, 'call');
        } catch (error) {
            const code = (error as PlaywrightWorkerCallError).code;
            // Worker 侧已判定超时：它正在自杀重建 MCP 子进程，这里等待重连即可
            if (code === 'tool_timeout') {
                this.connected = false;
                this.scheduleRecovery(`tool timeout: ${name}`);
            }
            throw error;
        }
    }

    /** 主动重启 Worker（杀掉进程树后重建并重连） */
    async restart(reason = 'manual'): Promise<void> {
        if (this.disposed) return;
        console.warn(`${getTS()} [PlaywrightWorker] Restarting worker (${reason})`);
        this.killHandle();
        this.connected = false;
        this.restarts += 1;
        this.onStateChange?.(false, reason);
        if (!this.lastConfig) return;
        await this.connect(this.lastConfig, true).catch((error) => {
            this.lastError = String((error as Error)?.message || error);
            console.error(`${getTS()} [PlaywrightWorker] Reconnect after restart failed: ${this.lastError}`);
        });
    }

    /** 释放 Worker（应用退出 / 工作区切换） */
    async dispose(): Promise<void> {
        this.disposed = true;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        this.connected = false;
        // 唤醒等待者，避免调用方在退出路径上白等到超时
        this.wakeWaiters();
        this.killHandle();
    }

    // ── 内部实现 ──────────────────────────────────────────

    private nextRequestId(kind: string): string {
        this.seq += 1;
        return `${kind}-${this.seq}`;
    }

    private notifyConnected(): void {
        this.wakeWaiters();
    }

    /** 唤醒所有 waitForConnected 等待者（按当前连接状态结算） */
    private wakeWaiters(): void {
        if (this.connectedWaiters.size === 0) return;
        const waiters = [...this.connectedWaiters];
        this.connectedWaiters.clear();
        for (const waiter of waiters) waiter();
    }

    private waitForReady(): Promise<void> {
        return new Promise((resolve, reject) => {
            const handle = this.handle;
            if (!handle) {
                reject(createCallError('worker_not_started', 'Worker 未启动'));
                return;
            }
            const timer = setTimeout(() => {
                cleanup();
                reject(createCallError('worker_not_started', `Playwright Worker 就绪超时（${this.readyTimeoutMs}ms）`));
                this.killHandle();
            }, this.readyTimeoutMs);

            const offMessage = handle.onMessage((message) => {
                if (message.type !== 'worker.ready') return;
                cleanup();
                if (message.protocolVersion !== PLAYWRIGHT_WORKER_PROTOCOL_VERSION) {
                    reject(createCallError(
                        'worker_not_started',
                        `Playwright Worker 协议版本不匹配（期望 ${PLAYWRIGHT_WORKER_PROTOCOL_VERSION}，实际 ${message.protocolVersion}）`,
                    ));
                    return;
                }
                resolve();
            });
            const offExit = handle.onExit((code) => {
                cleanup();
                reject(createCallError('worker_exited', `Playwright Worker 启动失败（exit=${code}）`));
            });

            function cleanup() {
                clearTimeout(timer);
                offMessage();
                offExit();
            }
        });
    }

    private request(
        requestId: string,
        message: MainToWorkerMessage,
        timeoutMs: number,
        kind: PendingRequest['kind'],
    ): Promise<unknown> {
        const handle = this.handle;
        if (!handle) {
            return Promise.reject(createCallError('worker_not_started', 'Playwright Worker 未启动'));
        }

        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                // 看门狗超时：说明 Worker 已经无法自愈（连自杀都没做到），直接杀进程树
                this.lastError = `Worker 看门狗超时（${timeoutMs}ms，${kind}）`;
                console.error(`${getTS()} [PlaywrightWorker] ${this.lastError}；将重建 Worker`);
                this.killHandle();
                this.connected = false;
                this.onStateChange?.(false, 'watchdog_timeout');
                this.scheduleRecovery('watchdog_timeout');
                reject(createCallError('worker_timeout', this.lastError));
            }, timeoutMs);

            this.pending.set(requestId, { resolve, reject, timer, kind });
            try {
                handle.postMessage(message);
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                reject(createCallError('worker_exited', `发送给 Worker 失败: ${(error as Error)?.message || error}`));
            }
        });
    }

    private handleMessage(message: WorkerToMainMessage): void {
        switch (message.type) {
            case 'worker.ready':
                return;
            case 'worker.pong':
                return;
            case 'worker.log':
                if (message.level === 'error') console.error(`${getTS()} [PlaywrightWorker] ${message.message}`);
                else if (message.level === 'warn') console.warn(`${getTS()} [PlaywrightWorker] ${message.message}`);
                return;
            case 'mcp.state':
                if (!message.connected) {
                    this.connected = false;
                    this.lastError = message.reason || this.lastError;
                    this.onStateChange?.(false, message.reason);
                }
                return;
            case 'mcp.result': {
                const pending = this.pending.get(message.requestId);
                if (!pending) return;
                this.pending.delete(message.requestId);
                clearTimeout(pending.timer);
                if (message.ok) {
                    pending.resolve(message.data);
                } else {
                    const error = createCallError(
                        (message.code as PlaywrightWorkerCallError['code']) || 'tool_error',
                        message.error || 'Playwright Worker 调用失败',
                    );
                    pending.reject(error);
                }
                return;
            }
            default:
                return;
        }
    }

    private handleExit(handle: PlaywrightWorkerHandle, code: number | null): void {
        // 已被 killHandle()/重建流程接管：忽略旧进程的退出事件，
        // 否则会把新一代 worker 的 handle 清空，并覆盖掉更有意义的失败原因。
        if (this.handle !== handle) return;

        const wasConnected = this.connected;
        this.handle = null;
        this.connected = false;
        this.rejectAllPending(createCallError('worker_exited', `Playwright Worker 已退出（exit=${code}）`));
        if (this.disposed) return;

        this.lastError = `Playwright Worker 已退出（exit=${code}）`;
        console.warn(`${getTS()} [PlaywrightWorker] ${this.lastError}`);
        this.onStateChange?.(false, `worker_exited:${code}`);
        if (wasConnected || this.lastConfig) {
            this.scheduleRecovery(`worker_exited:${code}`);
        }
    }

    private rejectAllPending(error: Error): void {
        for (const [requestId, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
            this.pending.delete(requestId);
        }
    }

    /** 自动重建：退避 + 上限，避免崩溃风暴 */
    private scheduleRecovery(reason: string): void {
        if (this.disposed || this.restartTimer || !this.lastConfig) return;
        if (this.restarts >= this.maxRestarts) {
            this.lastError = `自动重建已达上限（${this.maxRestarts} 次），最后一次原因：${reason}`;
            console.error(`${getTS()} [PlaywrightWorker] ${this.lastError}`);
            return;
        }
        this.restarts += 1;
        const delay = Math.min(RESTART_BACKOFF_BASE_MS * 2 ** (this.restarts - 1), RESTART_BACKOFF_MAX_MS);
        console.log(`${getTS()} [PlaywrightWorker] Scheduling recovery in ${delay}ms (attempt ${this.restarts}/${this.maxRestarts}, reason=${reason})`);
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (this.disposed) return;
            const config = this.lastConfig;
            if (!config) return;
            void (async () => {
                try {
                    this.killHandle();
                    await this.ensureStarted();
                    await this.connect(config, true);
                    console.log(`${getTS()} [PlaywrightWorker] Recovery succeeded`);
                } catch (error) {
                    this.lastError = String((error as Error)?.message || error);
                    console.error(`${getTS()} [PlaywrightWorker] Recovery failed: ${this.lastError}`);
                    this.scheduleRecovery('recovery_failed');
                }
            })();
        }, delay);
        this.restartTimer.unref?.();
    }

    private killHandle(): void {
        const handle = this.handle;
        this.handle = null;
        if (!handle) return;
        this.rejectAllPending(createCallError('worker_exited', 'Playwright Worker 已重建'));
        try {
            handle.kill();
        } catch {
            // 进程可能已退出
        }
    }
}
