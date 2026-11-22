/**
 * DuckDB Worker 进程入口（独立进程，NDJSON over stdio）。
 *
 * 启动方式：Electron / Node 以 `ELECTRON_RUN_AS_NODE=1` 或纯 node 运行本 bundle。
 * stdout 只写协议消息；所有日志改写到 stderr，避免污染 IPC。
 */
import { createInterface } from 'node:readline';
import {
    DUCKDB_ERROR_CODES,
    DUCKDB_PROTOCOL_VERSION,
    DuckDbToolError,
    isDuckDbClientMessage,
    type DuckDbResponse,
    type DuckDbWorkerMessage,
} from './duckdbProtocol.js';
import { DuckDbWorkerCore } from './DuckDbWorkerCore.js';

const startedAt = Date.now();

function send(message: DuckDbWorkerMessage): void {
    try {
        process.stdout.write(`${JSON.stringify(message)}\n`);
    } catch {
        // stdout 已断开，进程即将退出
    }
}

function sendLog(level: 'info' | 'warn' | 'error', message: string): void {
    process.stderr.write(`[duckdb-worker ${level}] ${message}\n`);
}

// 原生库 / 依赖可能 console.log，必须全部转向 stderr。
console.log = (...args: unknown[]) => {
    process.stderr.write(`${args.map(String).join(' ')}\n`);
};
console.info = console.log;
console.debug = console.log;
console.warn = console.log;

const core = new DuckDbWorkerCore({ log: sendLog });
const inFlight = new Map<number, { timer: NodeJS.Timeout }>();
let closing = false;

async function handleLine(line: string): Promise<void> {
    const text = line.trim();
    if (!text) return;

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        sendLog('warn', `dropped malformed IPC message: ${(error as Error).message}`);
        return;
    }

    if (!isDuckDbClientMessage(parsed)) {
        sendLog('warn', 'dropped IPC message with invalid shape');
        return;
    }

    if ('type' in parsed) {
        if (parsed.type === 'cancel' && inFlight.has(parsed.id)) {
            sendLog('info', `interrupting request #${parsed.id}`);
            core.interrupt();
        }
        return;
    }

    const request = parsed;
    const timeoutMs = Number(request.timeoutMs);
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            sendLog('warn', `request #${request.id} (${request.op}) exceeded ${timeoutMs}ms, interrupting`);
            core.interrupt();
        }, timeoutMs)
        : undefined;
    if (timer) timer.unref?.();
    if (timer) inFlight.set(request.id, { timer });

    let response: DuckDbResponse;
    try {
        const result = await core.handle(request.op, request.payload || {});
        response = { id: request.id, ok: true, result };
    } catch (error) {
        const toolError = error instanceof DuckDbToolError
            ? error
            : new DuckDbToolError(
                DUCKDB_ERROR_CODES.duckdbError,
                (error as Error)?.message || String(error),
                (error as Error)?.stack,
            );
        response = { id: request.id, ok: false, error: toolError.toPayload() };
    } finally {
        const entry = inFlight.get(request.id);
        if (entry?.timer) clearTimeout(entry.timer);
        inFlight.delete(request.id);
    }
    send(response);
}

async function shutdown(code = 0): Promise<void> {
    if (closing) return;
    closing = true;
    for (const entry of inFlight.values()) {
        if (entry.timer) clearTimeout(entry.timer);
    }
    inFlight.clear();
    await core.close().catch(() => undefined);
    process.exit(code);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
    void handleLine(line);
});
rl.on('close', () => {
    sendLog('info', `stdin closed after ${Date.now() - startedAt}ms, shutting down`);
    void shutdown(0);
});

process.on('uncaughtException', (error) => {
    sendLog('error', `uncaughtException: ${error.stack || error.message}`);
    void shutdown(1);
});
process.on('unhandledRejection', (reason) => {
    sendLog('error', `unhandledRejection: ${String(reason)}`);
    void shutdown(1);
});
process.on('SIGTERM', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));

send({
    type: 'ready',
    protocolVersion: DUCKDB_PROTOCOL_VERSION,
    pid: process.pid,
    node: process.version,
});
