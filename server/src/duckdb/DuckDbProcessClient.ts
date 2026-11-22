/**
 * DuckDB 独立进程客户端（Agent 侧唯一入口）。
 *
 * - 每个工作区一个 Worker 子进程；同一时刻只跑一条请求（DuckDB 单连接串行）。
 * - 请求/响应走 NDJSON over stdio；进程崩溃自动在下次调用时重启。
 * - 禁止任何调用方直接打开 .duckdb 文件，数据访问只能经此客户端。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import {
    DUCKDB_ERROR_CODES,
    DUCKDB_PROTOCOL_VERSION,
    DuckDbToolError,
    isDuckDbWorkerMessage,
    type DuckDbOperation,
} from './duckdbProtocol.js';
import { PROJECT_ROOT } from '@/utils/PathUtils.js';

export interface DuckDbClientOptions {
    /** 每个数据库实例的 DuckDB 内存上限（MB） */
    memoryLimitMb?: number;
    /** DuckDB 查询线程数 */
    threads?: number;
    /** 单次请求默认超时 */
    queryTimeoutMs?: number;
    /** 空闲多久后自动回收 Worker */
    idleTimeoutMs?: number;
    /** 同时存活的 Worker 上限 */
    maxWorkers?: number;
    /** 显式指定 Worker bundle 路径 */
    entryPath?: string;
    /** 显式指定 Node/Electron 可执行文件 */
    nodePath?: string;
    env?: NodeJS.ProcessEnv;
}

export interface DuckDbRunOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
}

interface PendingRequest {
    finish: (error?: Error, value?: unknown) => void;
    timer?: NodeJS.Timeout;
}

const DEFAULT_QUERY_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_WORKERS = 3;
const READY_TIMEOUT_MS = 20_000;
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_IN_WINDOW = 5;

function readEnvInt(name: string, fallback: number, min: number, max: number): number {
    const raw = Number(process.env[name]);
    if (!Number.isFinite(raw)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(raw)));
}

export class DuckDbProcessClient {
    private static instance?: DuckDbProcessClient;

    private readonly sessions = new Map<string, WorkspaceSession>();
    /** 工作区 → 保活计数（长任务期间阻止空闲回收；即使 Worker 尚未启动也记录，启动后立即生效） */
    private readonly keepAliveCounts = new Map<string, number>();
    private readonly options: Required<Pick<DuckDbClientOptions, 'memoryLimitMb' | 'threads' | 'queryTimeoutMs' | 'idleTimeoutMs' | 'maxWorkers'>> &
        Pick<DuckDbClientOptions, 'entryPath' | 'nodePath' | 'env'>;

    public static getInstance(): DuckDbProcessClient {
        if (!DuckDbProcessClient.instance) {
            DuckDbProcessClient.instance = new DuckDbProcessClient();
        }
        return DuckDbProcessClient.instance;
    }

    constructor(options: DuckDbClientOptions = {}) {
        this.options = {
            memoryLimitMb: options.memoryLimitMb ?? readEnvInt('DUCKDB_MEMORY_LIMIT_MB', 2048, 128, 65536),
            threads: options.threads ?? readEnvInt(
                'DUCKDB_THREADS',
                Math.max(1, Math.min(4, (os.availableParallelism?.() || os.cpus().length || 4) - 1)),
                1,
                64,
            ),
            queryTimeoutMs: options.queryTimeoutMs ?? readEnvInt('DUCKDB_QUERY_TIMEOUT_MS', DEFAULT_QUERY_TIMEOUT_MS, 1_000, 600_000),
            idleTimeoutMs: options.idleTimeoutMs ?? readEnvInt('DUCKDB_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS, 10_000, 3_600_000),
            maxWorkers: options.maxWorkers ?? readEnvInt('DUCKDB_MAX_WORKERS', DEFAULT_MAX_WORKERS, 1, 16),
            entryPath: options.entryPath,
            nodePath: options.nodePath,
            env: options.env,
        };
    }

    /**
     * 向指定工作区的 DuckDB Worker 发一条请求。
     * payload 必须可 JSON 序列化；超出上限的批量由上层拆分。
     */
    public async run(
        workspaceRoot: string,
        op: DuckDbOperation,
        payload: Record<string, unknown> = {},
        options: DuckDbRunOptions = {},
    ): Promise<unknown> {
        if (process.env.DUCKDB_DISABLED === '1') {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.workerUnavailable,
                'DuckDB 知识图谱能力已被 DUCKDB_DISABLED=1 关闭。',
            );
        }
        const root = path.resolve(workspaceRoot);
        const session = this.getOrCreateSession(root);
        const timeoutMs = options.timeoutMs ?? this.options.queryTimeoutMs;
        return await session.run(op, payload, timeoutMs, options.signal);
    }

    public async closeWorkspace(workspaceRoot: string): Promise<void> {
        const root = path.resolve(workspaceRoot);
        this.keepAliveCounts.delete(root);
        const session = this.sessions.get(root);
        if (!session) return;
        this.sessions.delete(root);
        await session.stop();
    }

    public async shutdownAll(): Promise<void> {
        const sessions = Array.from(this.sessions.values());
        this.sessions.clear();
        this.keepAliveCounts.clear();
        await Promise.all(sessions.map((session) => session.stop()));
    }

    /** 只读诊断：当前存活的工作区 Worker。 */
    public listSessions(): { workspaceRoot: string; pid?: number; startedAt?: number; lastUsedAt: number }[] {
        return Array.from(this.sessions.entries()).map(([root, session]) => ({
            workspaceRoot: root,
            pid: session.pid,
            startedAt: session.startedAt,
            lastUsedAt: session.lastUsedAt,
        }));
    }

    /**
     * 长任务保活：调用期间不回收 Worker。
     *
     * 典型场景：`run_workflow { wait:true, timeoutSeconds:2400 }` 期间可能几分钟不碰 kg_*，
     * 空闲回收会把 Worker 停掉，之后每个 kg 步骤都要冷启动，日志还会误导用户以为出错。
     * 返回释放函数（可重复调用）。
     */
    public acquireKeepAlive(workspaceRoot: string): () => void {
        const root = path.resolve(workspaceRoot);
        this.keepAliveCounts.set(root, (this.keepAliveCounts.get(root) ?? 0) + 1);
        this.sessions.get(root)?.notifyPinChanged();
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const next = Math.max(0, (this.keepAliveCounts.get(root) ?? 1) - 1);
            if (next === 0) this.keepAliveCounts.delete(root);
            else this.keepAliveCounts.set(root, next);
            this.sessions.get(root)?.notifyPinChanged();
        };
    }

    /** 诊断：空闲回收策略与保活状态。 */
    public describeIdlePolicy(workspaceRoot: string): {
        idleTimeoutMs: number;
        keepAlive: number;
        running: boolean;
        lastUsedAt?: number;
    } {
        const root = path.resolve(workspaceRoot);
        const session = this.sessions.get(root);
        return {
            idleTimeoutMs: this.options.idleTimeoutMs,
            keepAlive: this.keepAliveCounts.get(root) ?? 0,
            running: session?.isRunning ?? false,
            lastUsedAt: session?.lastUsedAt,
        };
    }

    private getOrCreateSession(root: string): WorkspaceSession {
        const existing = this.sessions.get(root);
        if (existing) return existing;

        if (this.sessions.size >= this.options.maxWorkers) {
            const idle = Array.from(this.sessions.entries())
                .filter(([, session]) => !session.busy)
                .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
            if (idle) {
                this.sessions.delete(idle[0]);
                void idle[1].stop();
                console.log(`[DuckDbWorker] evicted idle worker for ${idle[0]}`);
            }
        }

        const session = new WorkspaceSession(
            root,
            this.options,
            () => (this.keepAliveCounts.get(root) ?? 0) > 0,
        );
        this.sessions.set(root, session);
        return session;
    }
}

class WorkspaceSession {
    public pid?: number;
    public startedAt?: number;
    public lastUsedAt = Date.now();
    public busy = false;

    private child?: ChildProcessWithoutNullStreams;
    private startPromise?: Promise<void>;
    private readonly pending = new Map<number, PendingRequest>();
    private queue: Promise<unknown> = Promise.resolve();
    private sequence = 0;
    private stderrTail = '';
    private idleTimer?: NodeJS.Timeout;
    private restarts: number[] = [];
    private lastExit?: { code: number | null; at: number };
    private stopping = false;
    private stopPromise?: Promise<void>;

    constructor(
        private readonly workspaceRoot: string,
        private readonly options: {
            memoryLimitMb: number;
            threads: number;
            queryTimeoutMs: number;
            idleTimeoutMs: number;
            entryPath?: string;
            nodePath?: string;
            env?: NodeJS.ProcessEnv;
        },
        /** 长任务保活期间不得回收（由 client 的保活计数驱动） */
        private readonly isPinned: () => boolean = () => false,
    ) {}

    /** 保活计数变化时重排空闲回收计时器。 */
    public notifyPinChanged(): void {
        if (this.isPinned()) {
            if (this.idleTimer) clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
            return;
        }
        this.touchIdle();
    }

    /** 进程是否真的在跑（pid 会保留用于诊断，不能用来判断存活）。 */
    public get isRunning(): boolean {
        return Boolean(this.child);
    }

    public async run(
        op: DuckDbOperation,
        payload: Record<string, unknown>,
        timeoutMs: number,
        signal?: AbortSignal,
    ): Promise<unknown> {
        if (signal?.aborted) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.interrupted, '请求已被取消。');
        }
        const task = async () => {
            this.busy = true;
            try {
                await this.ensureStarted();
                if (signal?.aborted) {
                    throw new DuckDbToolError(DUCKDB_ERROR_CODES.interrupted, '请求已被取消。');
                }
                return await this.send(op, payload, timeoutMs, signal);
            } finally {
                this.busy = false;
                this.lastUsedAt = Date.now();
                this.touchIdle();
            }
        };
        const result = this.queue.then(task, task);
        this.queue = result.then(() => undefined, () => undefined);
        return await result;
    }

    public async stop(): Promise<void> {
        if (this.stopPromise) return await this.stopPromise;
        this.stopPromise = this.stopInternal();
        try {
            await this.stopPromise;
        } finally {
            this.stopPromise = undefined;
        }
    }

    private async stopInternal(): Promise<void> {
        this.stopping = true;
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = undefined;
        this.rejectAll(new DuckDbToolError(DUCKDB_ERROR_CODES.workerExited, 'DuckDB Worker 已关闭。'));
        const child = this.child;
        this.child = undefined;
        this.startPromise = undefined;
        if (!child) return;
        try {
            child.stdin.end();
        } catch {
            // ignore
        }
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                try {
                    child.kill();
                } catch {
                    // ignore
                }
                resolve();
            }, 800);
            timer.unref?.();
            child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    private async ensureStarted(): Promise<void> {
        if (this.stopPromise) {
            await this.stopPromise;
        }
        if (this.child && this.startPromise) {
            await this.startPromise;
            return;
        }
        if (!this.startPromise) {
            this.startPromise = this.start().catch((error) => {
                this.startPromise = undefined;
                throw error;
            });
        }
        await this.startPromise;
    }

    private async start(): Promise<void> {
        this.stopping = false;
        const now = Date.now();
        this.restarts = this.restarts.filter((timestamp) => now - timestamp < RESTART_WINDOW_MS);
        if (this.restarts.length >= MAX_RESTARTS_IN_WINDOW) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.workerUnavailable,
                `DuckDB Worker 在 ${RESTART_WINDOW_MS / 1000}s 内崩溃 ${this.restarts.length} 次，已暂停重启。请检查 stderr 日志。`,
                this.stderrTail.slice(-2000),
            );
        }

        const entry = resolveWorkerEntry(this.options.entryPath);
        if (!entry) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.workerUnavailable,
                '未找到 duckdbWorker 入口。请先运行 `pnpm --filter deepseek-ide-agent-electron run build:duckdb-worker`，或设置 DUCKDB_WORKER_ENTRY。',
            );
        }

        const execPath = this.options.nodePath || process.env.DUCKDB_NODE_PATH || process.execPath;
        const isElectronRuntime = Boolean(process.versions.electron);
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            ...(this.options.env || {}),
            ...(isElectronRuntime ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        };
        const nodePath = buildNodePath(entry);
        if (nodePath) {
            env.NODE_PATH = env.NODE_PATH ? `${nodePath}${path.delimiter}${env.NODE_PATH}` : nodePath;
        }

        const heapMb = readEnvInt('DUCKDB_WORKER_HEAP_MB', 2048, 256, 65536);
        const child = spawn(execPath, [`--max-old-space-size=${heapMb}`, entry], {
            cwd: this.workspaceRoot,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        }) as ChildProcessWithoutNullStreams;
        this.child = child;
        this.startedAt = Date.now();
        this.pid = child.pid;
        this.stderrTail = '';

        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk: string | Buffer) => {
            this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-8000);
        });
        child.on('error', (error) => {
            this.stderrTail = `${this.stderrTail}\nspawn error: ${error.message}`.slice(-8000);
        });

        const ready = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new DuckDbToolError(
                    DUCKDB_ERROR_CODES.workerUnavailable,
                    `DuckDB Worker 启动超时（${READY_TIMEOUT_MS}ms）。`,
                    this.stderrTail.slice(-2000),
                ));
            }, READY_TIMEOUT_MS);
            timer.unref?.();

            const lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
            lineReader.on('line', (line) => {
                const parsed = this.parseMessage(line);
                if (!parsed) return;
                if ('type' in parsed && parsed.type === 'ready') {
                    if (parsed.protocolVersion !== DUCKDB_PROTOCOL_VERSION) {
                        clearTimeout(timer);
                        reject(new DuckDbToolError(
                            DUCKDB_ERROR_CODES.workerUnavailable,
                            `DuckDB Worker 协议版本不匹配：${parsed.protocolVersion} != ${DUCKDB_PROTOCOL_VERSION}。`,
                        ));
                        return;
                    }
                    clearTimeout(timer);
                    resolve();
                    return;
                }
                if ('type' in parsed && parsed.type === 'log') {
                    this.stderrTail = `${this.stderrTail}${parsed.message}\n`.slice(-8000);
                    return;
                }
                this.handleResponse(parsed);
            });
            lineReader.on('close', () => {
                clearTimeout(timer);
                reject(new DuckDbToolError(
                    DUCKDB_ERROR_CODES.workerExited,
                    'DuckDB Worker 在就绪前退出。',
                    this.stderrTail.slice(-2000),
                ));
            });
        });

        child.once('exit', (code) => {
            this.lastExit = { code, at: Date.now() };
            // 只有非预期退出才计入崩溃窗口；空闲回收/主动关闭不算，否则反复回收会触发"暂停重启"。
            if (!this.stopping) this.restarts.push(Date.now());
            const detail = this.stderrTail.slice(-2000);
            this.child = undefined;
            this.startPromise = undefined;
            this.rejectAll(new DuckDbToolError(
                DUCKDB_ERROR_CODES.workerExited,
                `DuckDB Worker 退出（code=${code ?? 'null'}）。下次调用会自动重启。`,
                detail,
            ));
        });

        try {
            await ready;
        } catch (error) {
            try {
                child.kill();
            } catch {
                // ignore
            }
            throw error;
        }

        console.log(`[DuckDbWorker] started pid=${child.pid} workspace=${this.workspaceRoot}`);
        try {
            await this.send('open', {
                dbPath: path.join(this.workspaceRoot, '.duckdb', 'kg.duckdb'),
                workspaceRoot: this.workspaceRoot,
                tempDir: path.join(this.workspaceRoot, '.duckdb', 'tmp'),
                memoryLimitMb: this.options.memoryLimitMb,
                threads: this.options.threads,
            }, READY_TIMEOUT_MS * 3);
        } catch (error) {
            try {
                child.kill();
            } catch {
                // ignore
            }
            this.child = undefined;
            this.startPromise = undefined;
            throw error;
        }
    }

    private send(
        op: DuckDbOperation,
        payload: Record<string, unknown>,
        timeoutMs: number,
        signal?: AbortSignal,
    ): Promise<unknown> {
        const child = this.child;
        if (!child) {
            return Promise.reject(new DuckDbToolError(
                DUCKDB_ERROR_CODES.workerUnavailable,
                'DuckDB Worker 未运行。',
            ));
        }
        const id = ++this.sequence;
        return new Promise<unknown>((resolve, reject) => {
            const finish = (error?: Error, value?: unknown) => {
                if (entry.timer) clearTimeout(entry.timer);
                this.pending.delete(id);
                if (signal) signal.removeEventListener('abort', onAbort);
                if (error) reject(error);
                else resolve(value);
            };
            const onAbort = () => {
                this.write({ type: 'cancel', id });
                finish(new DuckDbToolError(DUCKDB_ERROR_CODES.interrupted, '请求已被取消。'));
            };
            const entry: PendingRequest = { finish };
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
            entry.timer = setTimeout(() => {
                this.write({ type: 'cancel', id });
                finish(new DuckDbToolError(
                    DUCKDB_ERROR_CODES.workerTimeout,
                    `DuckDB 请求超时（${Math.round(timeoutMs / 1000)}s）：${op}。可用 kg_analyze iterations / kg_query 更严格的过滤条件降低规模。`,
                ));
            }, timeoutMs);
            entry.timer.unref?.();
            this.pending.set(id, entry);

            const written = this.write({ id, op, payload, timeoutMs });
            if (!written) {
                finish(new DuckDbToolError(
                    DUCKDB_ERROR_CODES.workerExited,
                    'DuckDB Worker 管道已关闭。',
                    this.stderrTail.slice(-2000),
                ));
            }
        });
    }

    private write(message: Record<string, unknown>): boolean {
        const child = this.child;
        if (!child || child.stdin.destroyed) return false;
        try {
            child.stdin.write(`${JSON.stringify(message)}\n`);
            return true;
        } catch {
            return false;
        }
    }

    private parseMessage(line: string): any {
        const text = line.trim();
        if (!text) return null;
        try {
            const parsed = JSON.parse(text);
            return isDuckDbWorkerMessage(parsed) ? parsed : null;
        } catch {
            this.stderrTail = `${this.stderrTail}${text}\n`.slice(-8000);
            return null;
        }
    }

    private handleResponse(message: any): void {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.ok) {
            entry.finish(undefined, message.result);
        } else {
            entry.finish(new DuckDbToolError(
                message.error?.code || DUCKDB_ERROR_CODES.duckdbError,
                message.error?.message || 'DuckDB 执行失败。',
                message.error?.detail,
            ));
        }
    }

    private rejectAll(error: Error): void {
        const entries = Array.from(this.pending.values());
        this.pending.clear();
        for (const entry of entries) {
            entry.finish(error);
        }
    }

    private touchIdle(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = undefined;
        if (this.stopping) return;
        // 长任务（run_workflow / run_*_command 等）执行期间不回收，避免中途停止后反复冷启动
        if (this.isPinned()) return;
        this.idleTimer = setTimeout(() => {
            if (this.busy || this.isPinned()) return;
            const idleMinutes = Math.max(1, Math.round(this.options.idleTimeoutMs / 60_000));
            console.log(
                `[DuckDbWorker] 空闲 ${idleMinutes} 分钟，回收 Worker（${this.workspaceRoot}）；`
                + '下次 kg_* 调用会自动重启（冷启动约 1 秒），可用 DUCKDB_IDLE_TIMEOUT_MS 调整。',
            );
            void this.stop();
        }, this.options.idleTimeoutMs);
        this.idleTimer.unref?.();
    }
}

function resolveWorkerEntry(explicit?: string): string | undefined {
    // Electron 注入 process.resourcesPath；纯 Node 下不存在。
    const resourcesRoot = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const candidates: (string | undefined)[] = [
        explicit,
        process.env.DUCKDB_WORKER_ENTRY,
        resourcesRoot
            ? path.join(resourcesRoot, 'app.asar', 'dist', 'workers', 'duckdbWorker.cjs')
            : undefined,
        resourcesRoot
            ? path.join(resourcesRoot, 'workers', 'duckdbWorker.cjs')
            : undefined,
        path.join(PROJECT_ROOT, 'electron', 'dist', 'workers', 'duckdbWorker.cjs'),
    ];
    for (const candidate of candidates) {
        if (!candidate) continue;
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch {
            // ignore
        }
    }
    return undefined;
}

/** 原生模块在打包后位于 asar.unpacked；补一条 NODE_PATH 兜底。 */
function buildNodePath(entry: string): string | undefined {
    const resourcesRoot = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const candidates = [
        resourcesRoot
            ? path.join(resourcesRoot, 'app.asar.unpacked', 'node_modules')
            : undefined,
        path.join(path.dirname(entry), '..', '..', 'node_modules'),
        path.join(PROJECT_ROOT, 'server', 'node_modules'),
        path.join(PROJECT_ROOT, 'node_modules'),
    ];
    const existing: string[] = [];
    for (const candidate of candidates) {
        if (!candidate) continue;
        try {
            if (fs.existsSync(candidate) && !existing.includes(candidate)) {
                existing.push(candidate);
            }
        } catch {
            // ignore
        }
    }
    return existing.length ? existing.join(path.delimiter) : undefined;
}

