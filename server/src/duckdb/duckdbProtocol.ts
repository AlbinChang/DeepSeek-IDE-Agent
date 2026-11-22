/**
 * Agent ↔ DuckDB Worker IPC 协议。
 *
 * 传输：子进程 stdio，按行分隔的 JSON（NDJSON），UTF-8。
 * 约束：stdout 只允许协议消息；Worker 的日志一律写 stderr。
 * 该文件不依赖 electron / duckdb，可在工具侧、Worker 侧与单测中共享。
 */

export const DUCKDB_PROTOCOL_VERSION = 1;

/** 单条 IPC 消息上限（防误用超大 payload 撑爆管道）。 */
export const DUCKDB_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export type DuckDbOperation =
    | 'ping'
    | 'open'
    | 'query'
    | 'export'
    | 'upsert'
    | 'delete'
    | 'traverse'
    | 'path'
    | 'analyze'
    | 'import'
    | 'find'
    | 'attr_define'
    | 'attr_list'
    | 'attr_delete'
    | 'attr_reindex'
    | 'vocab_define'
    | 'vocab_list'
    | 'vocab_delete'
    | 'lint'
    | 'merge'
    | 'stats'
    | 'schema'
    | 'validate'
    | 'checkpoint';

export interface DuckDbRequest {
    id: number;
    op: DuckDbOperation;
    payload?: Record<string, unknown>;
    /** Worker 侧自保护超时；到点调用 connection.interrupt()。 */
    timeoutMs?: number;
}

export interface DuckDbCancelRequest {
    type: 'cancel';
    id: number;
}

export type DuckDbClientMessage = DuckDbRequest | DuckDbCancelRequest;

export interface DuckDbReadyMessage {
    type: 'ready';
    protocolVersion: number;
    pid: number;
    node: string;
}

export interface DuckDbLogMessage {
    type: 'log';
    level: 'info' | 'warn' | 'error';
    message: string;
}

export interface DuckDbErrorPayload {
    code: string;
    message: string;
    detail?: string;
}

export type DuckDbResponse =
    | { id: number; ok: true; result: unknown }
    | { id: number; ok: false; error: DuckDbErrorPayload };

export type DuckDbWorkerMessage = DuckDbReadyMessage | DuckDbLogMessage | DuckDbResponse;

export const DUCKDB_ERROR_CODES = {
    invalidRequest: 'INVALID_REQUEST',
    workerUnavailable: 'WORKER_UNAVAILABLE',
    workerExited: 'WORKER_EXITED',
    workerTimeout: 'WORKER_TIMEOUT',
    notOpen: 'DUCKDB_NOT_OPEN',
    sqlRejected: 'SQL_REJECTED',
    pathRejected: 'PATH_REJECTED',
    limitExceeded: 'LIMIT_EXCEEDED',
    duckdbError: 'DUCKDB_ERROR',
    interrupted: 'INTERRUPTED',
} as const;

export type DuckDbErrorCode = typeof DUCKDB_ERROR_CODES[keyof typeof DUCKDB_ERROR_CODES];

/** 可安全跨进程传递的工具层错误。 */
export class DuckDbToolError extends Error {
    public readonly code: string;
    public readonly detail?: string;

    constructor(code: string, message: string, detail?: string) {
        super(message);
        this.name = 'DuckDbToolError';
        this.code = code;
        this.detail = detail;
    }

    public toPayload(): DuckDbErrorPayload {
        return {
            code: this.code,
            message: this.message,
            ...(this.detail ? { detail: this.detail } : {}),
        };
    }
}

export function isDuckDbClientMessage(value: unknown): value is DuckDbClientMessage {
    if (!value || typeof value !== 'object') return false;
    const message = value as Record<string, unknown>;
    if (message.type === 'cancel') {
        return Number.isInteger(message.id);
    }
    return Number.isInteger(message.id)
        && typeof message.op === 'string'
        && (message.payload === undefined || (typeof message.payload === 'object' && message.payload !== null));
}

export function isDuckDbWorkerMessage(value: unknown): value is DuckDbWorkerMessage {
    if (!value || typeof value !== 'object') return false;
    const message = value as Record<string, unknown>;
    if (message.type === 'ready') {
        return message.protocolVersion === DUCKDB_PROTOCOL_VERSION
            && typeof message.pid === 'number';
    }
    if (message.type === 'log') {
        return typeof message.message === 'string';
    }
    return Number.isInteger(message.id)
        && typeof message.ok === 'boolean'
        && (message.ok === true || (typeof message.error === 'object' && message.error !== null));
}
