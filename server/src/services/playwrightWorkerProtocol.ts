/**
 * 主进程 <-> Playwright MCP Worker 协议。
 *
 * 为什么要有独立 Worker：
 * Playwright MCP 是 stdio 服务器，背后还挂着一个真实 Chrome。它一旦卡死/半死不活，
 * 主进程里的 MCP Client 只会表现为「所有工具调用都 30s 超时」，既杀不掉也查不出，
 * 只能重启应用。把整个 MCP Client + Chrome 生命周期放进独立进程后：
 * - 任何工具超时都可以直接杀掉整个进程树（含 Chrome）并重建，主进程不受影响；
 * - 子进程崩溃由 onExit 立即感知，不用等 30s 超时；
 * - 主进程只负责「监督」，不再持有 MCP 连接状态。
 *
 * 本文件不依赖 Electron，主进程、Worker、测试共用；消息必须可 JSON 序列化。
 */

export const PLAYWRIGHT_WORKER_PROTOCOL_VERSION = 1;

/** Worker 内启动 Playwright MCP CLI 所需的参数 */
export interface PlaywrightMcpLaunchConfig {
    /** Node 可执行文件（Electron 下是 electron.exe + ELECTRON_RUN_AS_NODE=1） */
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
}

export interface PlaywrightWorkerConnectRequest {
    type: 'mcp.connect';
    requestId: string;
    config: PlaywrightMcpLaunchConfig;
}

export interface PlaywrightWorkerCallRequest {
    type: 'mcp.call';
    requestId: string;
    name: string;
    args: Record<string, unknown>;
    /** Worker 侧工具超时；超时后 Worker 会自杀重建 MCP 子进程 */
    timeoutMs: number;
}

export interface PlaywrightWorkerCancelRequest {
    type: 'mcp.cancel';
    requestId: string;
    /** 要取消的调用 requestId */
    targetRequestId: string;
}

export interface PlaywrightWorkerRestartRequest {
    type: 'mcp.restart';
    requestId: string;
    reason?: string;
}

export interface PlaywrightWorkerDisposeRequest {
    type: 'mcp.dispose';
    requestId: string;
}

export interface PlaywrightWorkerPingRequest {
    type: 'worker.ping';
    seq: number;
}

export type MainToWorkerMessage =
    | PlaywrightWorkerConnectRequest
    | PlaywrightWorkerCallRequest
    | PlaywrightWorkerCancelRequest
    | PlaywrightWorkerRestartRequest
    | PlaywrightWorkerDisposeRequest
    | PlaywrightWorkerPingRequest;

export interface PlaywrightNativeToolDescriptor {
    name: string;
    description?: string;
    inputSchema: {
        type: 'object';
        properties?: Record<string, unknown>;
        required?: string[];
    };
}

export interface PlaywrightNativeResourceDescriptor {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
}

export interface PlaywrightNativePromptDescriptor {
    name: string;
    description?: string;
    arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

/** mcp.connect / mcp.restart 的返回数据 */
export interface PlaywrightWorkerConnectResult {
    tools: PlaywrightNativeToolDescriptor[];
    resources: PlaywrightNativeResourceDescriptor[];
    prompts: PlaywrightNativePromptDescriptor[];
    pid: number | null;
    durationMs: number;
}

/** 失败分类：决定主进程是否要重建 Worker */
export type PlaywrightWorkerErrorCode =
    | 'mcp_not_connected'
    | 'mcp_connect_failed'
    | 'tool_timeout'
    | 'tool_cancelled'
    | 'tool_error';

export type WorkerToMainMessage =
    | { type: 'worker.ready'; protocolVersion: number; pid: number }
    | { type: 'worker.pong'; seq: number }
    | {
        type: 'mcp.result';
        requestId: string;
        ok: boolean;
        data?: unknown;
        error?: string;
        code?: PlaywrightWorkerErrorCode;
        durationMs: number;
    }
    | { type: 'mcp.state'; connected: boolean; reason?: string }
    | { type: 'worker.log'; level: 'info' | 'warn' | 'error'; message: string };

/** Worker 进程句柄：Electron utilityProcess 与 child_process.fork 的统一抽象 */
export interface PlaywrightWorkerHandle {
    readonly pid?: number;
    postMessage(message: MainToWorkerMessage): void;
    onMessage(listener: (message: WorkerToMainMessage) => void): () => void;
    onExit(listener: (code: number | null) => void): () => void;
    kill(): void;
}

export interface PlaywrightWorkerSpawner {
    spawn(): PlaywrightWorkerHandle;
}

const MAIN_TO_WORKER_TYPES = new Set<MainToWorkerMessage['type']>([
    'mcp.connect',
    'mcp.call',
    'mcp.cancel',
    'mcp.restart',
    'mcp.dispose',
    'worker.ping',
]);

const WORKER_TO_MAIN_TYPES = new Set<WorkerToMainMessage['type']>([
    'worker.ready',
    'worker.pong',
    'mcp.result',
    'mcp.state',
    'worker.log',
]);

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isMainToWorkerMessage(value: unknown): value is MainToWorkerMessage {
    if (!isObject(value)) return false;
    const type = value.type;
    if (typeof type !== 'string') return false;
    if (!MAIN_TO_WORKER_TYPES.has(type as MainToWorkerMessage['type'])) return false;
    switch (type) {
        case 'mcp.connect':
            return typeof value.requestId === 'string' && isObject(value.config);
        case 'mcp.call':
            return typeof value.requestId === 'string'
                && typeof value.name === 'string'
                && isObject(value.args);
        case 'mcp.cancel':
            return typeof value.requestId === 'string' && typeof value.targetRequestId === 'string';
        case 'mcp.restart':
        case 'mcp.dispose':
            return typeof value.requestId === 'string';
        case 'worker.ping':
            return typeof value.seq === 'number';
        default:
            return false;
    }
}

export function isWorkerToMainMessage(value: unknown): value is WorkerToMainMessage {
    if (!isObject(value)) return false;
    const type = value.type;
    if (typeof type !== 'string') return false;
    if (!WORKER_TO_MAIN_TYPES.has(type as WorkerToMainMessage['type'])) return false;
    switch (type) {
        case 'worker.ready':
            return typeof value.protocolVersion === 'number';
        case 'worker.pong':
            return typeof value.seq === 'number';
        case 'mcp.result':
            return typeof value.requestId === 'string' && typeof value.ok === 'boolean';
        case 'mcp.state':
            return typeof value.connected === 'boolean';
        case 'worker.log':
            return typeof value.message === 'string';
        default:
            return false;
    }
}
