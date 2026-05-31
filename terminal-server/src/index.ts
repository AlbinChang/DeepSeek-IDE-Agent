import Fastify from 'fastify';
import cors from '@fastify/cors';
import * as pty from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const BEIJING_TIME_ZONE = 'Asia/Shanghai';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── 文件日志（内联实现，terminal-server 作为独立包不依赖 server/src） ──
const TERMINAL_SERVER_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(TERMINAL_SERVER_ROOT, '..');
const LOG_DIR = path.join(PROJECT_ROOT, 'logs');
const LOG_FLUSH_INTERVAL = 5000;

let logBuffer: string[] = [];
let logStream: fs.WriteStream | null = null;
let logCurrentDate = '';

function getBeijingDateParts(date: Date) {
    const formatter = new Intl.DateTimeFormat('zh-CN', {
        timeZone: BEIJING_TIME_ZONE,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    });
    const m = new Map<string, string>();
    for (const p of formatter.formatToParts(date)) {
        if (p.type !== 'literal') m.set(p.type, p.value);
    }
    return {
        year: m.get('year') || '0000', month: m.get('month') || '00', day: m.get('day') || '00',
        hour: m.get('hour') || '00', minute: m.get('minute') || '00', second: m.get('second') || '00',
    };
}

function formatBeijingIso(date: Date = new Date()): string {
    const p = getBeijingDateParts(date);
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${ms}+08:00`;
}

function formatBeijingDate(date: Date = new Date()): string {
    const p = getBeijingDateParts(date);
    return `${p.year}-${p.month}-${p.day}`;
}

function ensureLogStream(): void {
    const today = formatBeijingDate();
    if (today !== logCurrentDate) {
        if (logStream) { try { logStream.end(); } catch { /* silent */ } logStream = null; }
        logCurrentDate = today;
    }
    if (!logStream) {
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        const filePath = path.join(LOG_DIR, `terminal-${today}.log`);
        logStream = fs.createWriteStream(filePath, { flags: 'a' });
    }
}

function writeToLogFile(level: string, message: string): void {
    try {
        const entry = JSON.stringify({ ts: formatBeijingIso(), level, svc: 'terminal', message });
        logBuffer.push(entry);
        if (level === 'ERROR' || logBuffer.length >= 50) flushLogBuffer();
    } catch { /* silent */ }
}

function flushLogBuffer(): void {
    if (logBuffer.length === 0) return;
    const lines = logBuffer.splice(0);
    try {
        ensureLogStream();
        if (logStream) logStream.write(lines.join('\n') + '\n');
    } catch { /* silent */ }
}

function flushLogSync(): void {
    if (logBuffer.length === 0) return;
    const lines = logBuffer.splice(0);
    try {
        const today = formatBeijingDate();
        if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
        fs.appendFileSync(path.join(LOG_DIR, `terminal-${today}.log`), lines.join('\n') + '\n');
    } catch { /* silent */ }
}

// 定时刷盘 & 进程退出保护
const _logFlushTimer = setInterval(flushLogBuffer, LOG_FLUSH_INTERVAL);
process.on('exit', flushLogSync);
process.on('SIGINT', () => { flushLogSync(); process.exit(0); });
process.on('SIGTERM', () => { flushLogSync(); process.exit(0); });

function getBeijingLogTimePrefix(date: Date = new Date()): string {
    const formatter = new Intl.DateTimeFormat('zh-CN', {
        timeZone: BEIJING_TIME_ZONE,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
    const parts = new Map<string, string>();
    for (const part of formatter.formatToParts(date)) {
        if (part.type !== 'literal') parts.set(part.type, part.value);
    }
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    return `[${parts.get('hour') || '00'}:${parts.get('minute') || '00'}:${parts.get('second') || '00'}.${ms}]`;
}

function stringifyArgs(args: unknown[]): string {
    return args.map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return `${a.name}: ${a.message} ${a.stack || ''}`;
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
}

function patchConsoleWithBeijingTime() {
    const methods: Array<'log' | 'info' | 'warn' | 'error' | 'debug'> = ['log', 'info', 'warn', 'error', 'debug'];
    const levelMap: Record<string, string> = { error: 'ERROR', warn: 'WARN', debug: 'DEBUG', log: 'INFO', info: 'INFO' };
    for (const method of methods) {
        const original = console[method].bind(console);
        console[method] = ((...args: unknown[]) => {
            // 控制台输出
            if (typeof args[0] === 'string' && /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]/.test(args[0] as string)) {
                original(...args);
            } else {
                original(getBeijingLogTimePrefix(), ...args);
            }
            // 文件日志
            try {
                writeToLogFile(levelMap[method] || 'INFO', stringifyArgs(args));
            } catch { /* silent */ }
        }) as typeof console[typeof method];
    }
}

patchConsoleWithBeijingTime();

type TerminalServerConf = {
    port?: number;
    portRetryLimit?: number;
    host?: string;
};

function loadTerminalServerConf(): TerminalServerConf {
    const confPath = path.resolve(__dirname, '../server_conf.json');
    try {
        if (!fs.existsSync(confPath)) return {};
        const raw = fs.readFileSync(confPath, 'utf-8');
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * 工业级终端服务 - 采用 SSE (下行) + REST (上行) 异步解耦架构
 * 解决了物理连接中断导致 PTY 进程丢失的问题
 */
class SessionManager {
    private sessions: Map<string, pty.IPty> = new Map();
    private replayBuffers: Map<string, string[]> = new Map();
    private lastActivity: Map<string, number> = new Map();
    private activeStreams: Map<string, number> = new Map();

    private readonly MAX_REPLAY_SIZE = 500; // 后端保留最近 500 次输出片段用于快照
    private readonly SESSION_TIMEOUT = 1800000; // 30 分钟无活动自动清理

    constructor() {
        // 定期清理过期会话
        setInterval(() => this.cleanupExpiredSessions(), 300000);
    }

    getOrCreateSession(id: string, root: string, cols: number, rows: number): pty.IPty {
        let session = this.sessions.get(id);
        
        // 路径不一致，必须重建
        if (session && root && path.normalize((session as any).cwd) !== path.normalize(root)) {
            console.log(`[SessionManager] CWD changed for ${id}, killing old PTY...`);
            this.killSession(id);
            session = undefined;
        }

        if (!session) {
            const isWin = process.platform === 'win32';
            const shell = isWin ? 'powershell.exe' : '/bin/bash';
            const shellArgs = isWin ? [] : ['--login'];

            console.log(`[SessionManager] Spawning new PTY for ${id} in ${root}`);
            session = pty.spawn(shell, shellArgs, {
                name: 'xterm-256color',
                cols: Math.max(cols || 80, 10),
                rows: Math.max(rows || 24, 2),
                cwd: path.resolve(root || '.'),
                env: {
                    ...process.env,
                    TERM: 'xterm-256color',
                    COLORTERM: 'truecolor',
                    LANG: 'zh_CN.UTF-8'
                } as any
            });

            (session as any).cwd = root;
            this.sessions.set(id, session);
            this.replayBuffers.set(id, []);
            
            // 数据监听并存入回放缓存
            session.onData((data) => {
                const buffer = this.replayBuffers.get(id) || [];
                if (buffer.length >= this.MAX_REPLAY_SIZE) buffer.shift();
                buffer.push(data);
                this.replayBuffers.set(id, buffer);
                this.lastActivity.set(id, Date.now());
            });

            // Windows 初始化回车
            if (isWin) {
                setTimeout(() => session?.write('\r'), 3000);
            }
        }
        
        this.lastActivity.set(id, Date.now());
        return session;
    }

    getSession(id: string): pty.IPty | undefined {
        return this.sessions.get(id);
    }

    touchSession(id: string) {
        if (this.sessions.has(id)) {
            this.lastActivity.set(id, Date.now());
        }
    }

    registerStream(id: string) {
        const next = (this.activeStreams.get(id) || 0) + 1;
        this.activeStreams.set(id, next);
        this.touchSession(id);
    }

    unregisterStream(id: string) {
        const current = this.activeStreams.get(id) || 0;
        if (current <= 1) {
            this.activeStreams.delete(id);
        } else {
            this.activeStreams.set(id, current - 1);
        }
    }

    private hasActiveStream(id: string): boolean {
        return (this.activeStreams.get(id) || 0) > 0;
    }

    writeToSession(id: string, data: string) {
        const session = this.sessions.get(id);
        if (session) {
            session.write(data);
            this.lastActivity.set(id, Date.now());
        }
    }

    getReplayData(id: string): string {
        return (this.replayBuffers.get(id) || []).join('');
    }

    clearReplayBuffer(id: string) {
        if (this.replayBuffers.has(id)) {
            this.replayBuffers.set(id, []);
            this.touchSession(id);
        }
    }

    killSession(id: string) {
        const session = this.sessions.get(id);
        if (session) {
            try { session.kill(); } catch (e) {}
            this.sessions.delete(id);
            this.replayBuffers.delete(id);
            this.lastActivity.delete(id);
        }
    }

    private cleanupExpiredSessions() {
        const now = Date.now();
        for (const [id, last] of this.lastActivity) {
            if (now - last > this.SESSION_TIMEOUT) {
                if (this.hasActiveStream(id)) continue;
                console.log(`[SessionManager] Session ${id} timed out, cleaning up...`);
                this.killSession(id);
            }
        }
    }
}

const sessionManager = new SessionManager();
const server = Fastify({ logger: false });

const decodeRootSafe = (raw: any): string => {
    if (!raw) return '';
    try {
        return decodeURIComponent(String(raw));
    } catch {
        return String(raw);
    }
};

server.register(cors, { origin: '*' });

/**
 * 终端输出流 (SSE)
 */
server.get('/terminal/stream', async (request, reply) => {
    const query = request.query as any;
    const userId = query.userId || 'anonymous';
    const sessionId = query.sessionId || 'default';
    const fullId = `${userId}:${sessionId}`;
    const rawRoot = query.root || '';
    const root = decodeRootSafe(rawRoot) || '.';
    const cols = Math.max(parseInt(String(query.cols || '80'), 10) || 80, 10);
    const rows = Math.max(parseInt(String(query.rows || '24'), 10) || 24, 2);

    console.log(`[Terminal] New SSE connection for ${fullId} (CWD: ${root})`);

    const ptySession = sessionManager.getOrCreateSession(fullId, root, cols, rows);
    sessionManager.registerStream(fullId);

    // 设置 SSE 响应头
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no'); // 禁用 nginx 缓冲
    
    // [修复] 处理 SSE 下的 CORS 问题
    // 由于我们绕过了 Fastify 的高层 reply 装饰器直接操作 reply.raw，
    // 需要手动设置 Access-Control-Allow-Origin。
    const origin = request.headers.origin || '*';
    reply.raw.setHeader('Access-Control-Allow-Origin', origin);
    reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
    
    // 初始化 SSE
    reply.raw.write(': welcome\n\n');

    // 保活心跳：防止中间网络层空闲断连，并标记会话活跃
    const heartbeat = setInterval(() => {
        if (reply.raw.destroyed) return;
        reply.raw.write(': ping\n\n');
        sessionManager.touchSession(fullId);
    }, 15000);

    // 1. 发送快照 (Snapshot)
    const snapshot = sessionManager.getReplayData(fullId);
    if (snapshot) {
        reply.raw.write(`event: snapshot\ndata: ${JSON.stringify({ payload: snapshot })}\n\n`);
    } else {
        reply.raw.write(`event: delta\ndata: ${JSON.stringify({ payload: "\r\n\x1b[32m[Terminal Gateway] Session Restored.\x1b[0m\r\n" })}\n\n`);
    }

    // 2. 持续推送 delta (Debounced)
    let buffer = "";
    let timeout: NodeJS.Timeout | null = null;

    const flushBuffer = () => {
        if (buffer.length > 0 && !reply.raw.destroyed) {
            reply.raw.write(`event: delta\ndata: ${JSON.stringify({ payload: buffer })}\n\n`);
            buffer = "";
            timeout = null;
            sessionManager.touchSession(fullId);
        }
    };

    const dataListener = ptySession.onData((data) => {
        buffer += data;
        if (buffer.length > 1024) {
             flushBuffer();
        } else if (!timeout) {
             timeout = setTimeout(flushBuffer, 20);
        }
    });

    const exitListener = ptySession.onExit(() => {
        if (!reply.raw.destroyed) {
            reply.raw.write(`event: exit\ndata: ${JSON.stringify({ message: 'Process exited' })}\n\n`);
            reply.raw.end();
        }
    });

    request.raw.on('close', () => {
        console.log(`[Terminal] SSE connection closed for ${fullId}`);
        clearInterval(heartbeat);
        sessionManager.unregisterStream(fullId);
        dataListener.dispose();
        exitListener.dispose();
    });
});

/**
 * 终端输入接口 (REST)
 */
server.post('/terminal/input', async (request, reply) => {
    const { userId, sessionId, data, root, cols, rows } = request.body as any;
    const fullId = `${userId || 'anonymous'}:${sessionId || 'default'}`;
    const safeCols = Math.max(parseInt(String(cols || '80'), 10) || 80, 10);
    const safeRows = Math.max(parseInt(String(rows || '24'), 10) || 24, 2);

    const hadSession = !!sessionManager.getSession(fullId);
    if (!hadSession) {
        const normalizedRoot = decodeRootSafe(root);
        if (!normalizedRoot) {
            return reply.status(409).send({ status: 'no-session', message: 'Session not found and root is required for recovery.' });
        }
        sessionManager.getOrCreateSession(fullId, normalizedRoot, safeCols, safeRows);
    }

    sessionManager.writeToSession(fullId, data);
    return reply.status(200).send({ status: 'ok', restored: !hadSession });
});

/**
 * 终端重置大小 (REST)
 */
server.post('/terminal/resize', async (request, reply) => {
    const { userId, sessionId, cols, rows, root } = request.body as any;
    const fullId = `${userId || 'anonymous'}:${sessionId || 'default'}`;
    const safeCols = Math.max(parseInt(String(cols || '80'), 10) || 80, 10);
    const safeRows = Math.max(parseInt(String(rows || '24'), 10) || 24, 2);

    let session = sessionManager.getSession(fullId);
    const hadSession = !!session;
    if (!session) {
        const normalizedRoot = decodeRootSafe(root);
        if (!normalizedRoot) {
            return reply.status(409).send({ status: 'no-session', message: 'Session not found and root is required for recovery.' });
        }
        session = sessionManager.getOrCreateSession(fullId, normalizedRoot, safeCols, safeRows);
    }

    if (session && safeCols > 0 && safeRows > 0) {
        try {
            session.resize(safeCols, safeRows);
            sessionManager.touchSession(fullId);
            console.log(`[Terminal] Resized ${fullId} to ${safeCols}x${safeRows}`);
        } catch (e) {}
    }
    return reply.status(200).send({ status: 'ok', restored: !hadSession });
});

/**
 * 清空会话回放缓存（用于 clear/cls 后防止滚动回显与重连复原旧内容）
 */
server.post('/terminal/clear-buffer', async (request, reply) => {
    const { userId, sessionId } = request.body as any;
    const fullId = `${userId || 'anonymous'}:${sessionId || 'default'}`;

    sessionManager.clearReplayBuffer(fullId);
    return reply.status(200).send({ status: 'ok' });
});

const terminalServerConf = loadTerminalServerConf();
const BASE_PORT = Number(terminalServerConf.port) || Number(process.env.TERMINAL_SERVER_PORT) || 3003;
const MAX_PORT_RETRIES = Number(terminalServerConf.portRetryLimit) || Number(process.env.PORT_RETRY_LIMIT) || 20;
const BIND_HOST = String(terminalServerConf.host || process.env.HOST || '0.0.0.0');

const startServer = (port: number, retriesLeft: number) => {
    server.listen({ port, host: BIND_HOST }, (err, address) => {
        if (!err) {
            console.log(`[Industrial Terminal Gateway] Power ON: ${address}`);
            return;
        }

        const isAddressInUse = (err as any)?.code === 'EADDRINUSE';
        if (isAddressInUse && retriesLeft > 0) {
            console.warn(`[Terminal] Port ${port} is in use, trying ${port + 1}...`);
            startServer(port + 1, retriesLeft - 1);
            return;
        }

        console.error(err);
        process.exit(1);
    });
};

startServer(BASE_PORT, MAX_PORT_RETRIES);
