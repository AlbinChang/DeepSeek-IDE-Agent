import { app, utilityProcess } from 'electron';
import { spawn as spawnProcess } from 'node:child_process';

import type {
    MainToWorkerMessage,
    WorkerToMainMessage,
    WorkflowWorkerHandle,
    WorkflowWorkerMetrics,
    WorkflowWorkerSpawnRequest,
    WorkflowWorkerSpawner,
} from '@/workflow/workerProtocol.js';
import { isWorkerToMainMessage } from '@/workflow/workerProtocol.js';

export interface UtilityProcessWorkflowSpawnerOptions {
    /** workflowWorker.js 的绝对路径 */
    entry: string;
    /** 额外的环境变量；默认继承主进程 */
    env?: NodeJS.ProcessEnv;
    serviceNamePrefix?: string;
}

interface WorkerListeners {
    message: Set<(message: WorkerToMainMessage) => void>;
    exit: Set<(code: number | null) => void>;
}

/**
 * Electron utilityProcess 适配器。
 * 只负责进程生命周期/消息/stdout/stderr，不参与调度逻辑。
 */
export class UtilityProcessWorkflowSpawner implements WorkflowWorkerSpawner {
    private readonly entry: string;
    private readonly env: Record<string, string>;
    private readonly serviceNamePrefix: string;
    private readonly handles = new Set<UtilityProcessWorkerHandle>();

    constructor(options: UtilityProcessWorkflowSpawnerOptions) {
        this.entry = options.entry;
        this.serviceNamePrefix = options.serviceNamePrefix || 'workflow-worker';
        this.env = Object.fromEntries(
            Object.entries(options.env || process.env)
                .filter(([, value]) => typeof value === 'string'),
        ) as Record<string, string>;
    }

    public spawn(request: WorkflowWorkerSpawnRequest): WorkflowWorkerHandle {
        const serviceName = `${this.serviceNamePrefix}-${request.workerId}`;
        const child = utilityProcess.fork(this.entry, [], {
            serviceName,
            stdio: 'pipe',
            env: {
                ...this.env,
                WORKFLOW_WORKER_ID: request.workerId,
            },
            execArgv: [`--js-flags=--max-old-space-size=${request.heapMB}`],
        });
        const handle = new UtilityProcessWorkerHandle(child, serviceName);
        this.handles.add(handle);
        handle.onExit(() => this.handles.delete(handle));
        return handle;
    }

    public async shutdown(): Promise<void> {
        for (const handle of Array.from(this.handles)) {
            handle.kill();
        }
        this.handles.clear();
    }
}

class UtilityProcessWorkerHandle implements WorkflowWorkerHandle {
    public readonly workerId: string;
    public pid?: number;

    private readonly listeners: WorkerListeners = {
        message: new Set(),
        exit: new Set(),
    };
    private readonly pendingMessages: WorkerToMainMessage[] = [];
    private exitCode: number | null | undefined;
    private stderrTail = '';
    private stdoutTail = '';

    constructor(
        private readonly child: Electron.UtilityProcess,
        private readonly serviceName: string,
    ) {
        this.workerId = serviceName;
        this.pid = child.pid;

        child.on('spawn', () => {
            this.pid = child.pid;
        });

        child.on('message', (message: unknown) => {
            if (!isWorkerToMainMessage(message)) {
                console.warn('[WorkflowWorker] Ignoring invalid message from worker:', this.serviceName);
                return;
            }
            const typed = message;
            if (this.listeners.message.size === 0) {
                // 理论上不会发生：引擎在 spawn 后立即注册；这里只做防御。
                this.pendingMessages.push(typed);
                return;
            }
            for (const listener of this.listeners.message) {
                try {
                    listener(typed);
                } catch (error) {
                    console.warn('[WorkflowWorker] Message listener failed:', error);
                }
            }
        });

        child.on('exit', (code: number) => {
            this.exitCode = code;
            for (const listener of this.listeners.exit) {
                try {
                    listener(code);
                } catch (error) {
                    console.warn('[WorkflowWorker] Exit listener failed:', error);
                }
            }
        });

        child.stdout?.on('data', (chunk: Buffer | string) => {
            this.stdoutTail = `${this.stdoutTail}${String(chunk)}`.slice(-8000);
        });
        child.stderr?.on('data', (chunk: Buffer | string) => {
            this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-8000);
        });
    }

    public postMessage(message: MainToWorkerMessage): void {
        this.child.postMessage(message);
    }

    public kill(): void {
        if (this.exitCode !== undefined) return;
        if (this.pid && process.platform === 'win32') {
            try {
                // utilityProcess.kill() 不保证杀掉 shell 子进程树；优先让 taskkill 处理整棵树
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
                // taskkill 异常/权限不足时兜底
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
            // 进程可能已退出
        }
    }

    public onMessage(listener: (message: WorkerToMainMessage) => void): () => void {
        this.listeners.message.add(listener);
        if (this.pendingMessages.length > 0) {
            const pending = this.pendingMessages.splice(0, this.pendingMessages.length);
            for (const message of pending) {
                listener(message);
            }
        }
        return () => this.listeners.message.delete(listener);
    }

    public onExit(listener: (code: number | null) => void): () => void {
        this.listeners.exit.add(listener);
        if (this.exitCode !== undefined) {
            queueMicrotask(() => listener(this.exitCode ?? null));
        }
        return () => this.listeners.exit.delete(listener);
    }

    public getMetrics(): WorkflowWorkerMetrics {
        try {
            const metric = app.getAppMetrics().find((entry) => (
                entry.type === 'Utility' && entry.name === this.serviceName
            ));
            if (!metric) return {};
            return {
                memMB: Math.round(metric.memory.workingSetSize / 1024),
                cpu: metric.cpu?.percentCPUUsage,
            };
        } catch {
            return {};
        }
    }

    public getLogTail(): string {
        return [this.stderrTail, this.stdoutTail].filter(Boolean).join('\n').slice(-4000);
    }
}
