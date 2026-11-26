/**
 * Playwright MCP utilityProcess Worker 入口。
 *
 * 全生命周期都在这里：MCP Client、stdio transport、以及 transport 背后的 Chrome。
 * 主进程只通过消息驱动它，因此任何卡死都可以「连进程带浏览器一起杀」再重建。
 *
 * 关键设计：
 * - 工具调用超时后主动 hardReset（taskkill 整棵进程树 + 关闭 transport），
 *   而不是像旧实现那样只 reject 外层 Promise、把僵死的 MCP 连接留在那里；
 * - 监听 transport/client 关闭，第一时间把 mcp.state 上报给主进程；
 * - 未捕获异常直接 exit(1)，让主进程的监督器走「崩溃 → 重建」路径。
 */

import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
    PLAYWRIGHT_WORKER_PROTOCOL_VERSION,
    isMainToWorkerMessage,
    type MainToWorkerMessage,
    type PlaywrightMcpLaunchConfig,
    type PlaywrightWorkerErrorCode,
    type WorkerToMainMessage,
} from '@/services/playwrightWorkerProtocol.js';

interface ParentPortLike {
    postMessage(message: unknown): void;
    on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

function send(message: WorkerToMainMessage): void {
    if (parentPort) {
        parentPort.postMessage(message);
        return;
    }
    // 纯 Node（child_process.fork）下的兼容通道，便于本地调试/测试
    const childProcess = process as unknown as { send?: (message: unknown) => void };
    childProcess.send?.(message);
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
    send({ type: 'worker.log', level, message });
}

function replyOk(requestId: string, data: unknown, durationMs: number): void {
    send({ type: 'mcp.result', requestId, ok: true, data, durationMs });
}

function replyError(
    requestId: string,
    code: PlaywrightWorkerErrorCode,
    error: string,
    durationMs: number,
): void {
    send({ type: 'mcp.result', requestId, ok: false, code, error, durationMs });
}

let client: Client | null = null;
let transport: StdioClientTransport | null = null;
let connected = false;
let resetting = false;
let lastConfig: PlaywrightMcpLaunchConfig | null = null;
/**
 * 连接代际。每次重置/新建连接都递增，用它丢弃迟到的状态上报——
 * 否则「超时重置」的 connected=false 可能在重连成功之后才送达宿主，
 * 把刚恢复的连接又标成断开。
 */
let connectionGeneration = 0;
/** 已取消的调用 requestId（工具本身无法中断，但结果会被丢弃） */
const cancelledRequests = new Set<string>();
/** 上一次成功 list 到的资源/提示，供连接复用时返回 */
let cachedResources: any[] = [];
let cachedPrompts: any[] = [];

const CONNECTION_ERROR_PATTERN = /econnrefused|enotfound|econnreset|epipe|not connected|transport closed|connection.*closed|spawn .*enoent/i;

function isConnectionError(error: unknown): boolean {
    const message = String((error as Error)?.message || error);
    return CONNECTION_ERROR_PATTERN.test(message);
}

/** 杀掉 MCP CLI 的整棵进程树（Windows 下 Chrome 是孙进程，SIGTERM 杀不干净） */
function killProcessTree(pid: number | null | undefined): void {
    if (!pid) return;
    if (process.platform === 'win32') {
        try {
            const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore',
            });
            killer.on('error', () => undefined);
            return;
        } catch {
            // 回退到 transport.close()
        }
    }
    try {
        process.kill(pid, 'SIGKILL');
    } catch {
        // 进程可能已退出
    }
}

async function hardReset(reason: string): Promise<void> {
    if (resetting) return;
    resetting = true;
    const generation = ++connectionGeneration;
    const previousTransport = transport;
    const previousClient = client;
    transport = null;
    client = null;
    const wasConnected = connected;
    connected = false;

    try {
        killProcessTree(previousTransport?.pid ?? null);
    } catch {
        // ignore
    }
    try {
        await previousTransport?.close();
    } catch {
        // ignore
    }
    try {
        await previousClient?.close();
    } catch {
        // ignore
    }

    resetting = false;
    if (wasConnected) {
        log('warn', `MCP 连接已重置：${reason}`);
    }
    // 重置期间如果已经重建了连接（generation 变化），这条迟到的断开状态必须丢弃
    if (connectionGeneration === generation) {
        send({ type: 'mcp.state', connected: false, reason });
    }
}

async function ensureConnected(config: PlaywrightMcpLaunchConfig): Promise<{ tools: any[]; resources: any[]; prompts: any[]; pid: number | null }> {
    lastConfig = config;
    if (client && connected) {
        // 复用已有连接：返回缓存的工具/资源/提示清单，
        // 否则宿主侧的 resources/prompts 会被这次「重连」清空。
        const tools = (await client.listTools()).tools || [];
        return {
            tools,
            resources: cachedResources,
            prompts: cachedPrompts,
            pid: transport?.pid ?? null,
        };
    }

    const nextTransport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        env: config.env,
        // 不要用 'pipe'：SDK 会把子进程 stderr 接到一个没人读的 PassThrough，
        // 缓冲区写满后 Chrome/MCP 会被阻塞在 stderr 写入上，表现为所有工具调用卡死。
        // 'inherit' 让输出落到本 Worker 的 stderr，由主进程侧统一消费。
        stderr: 'inherit',
    });

    const nextClient = new Client(
        { name: 'deepseek-ide-agent-playwright-worker', version: '2.0.0' },
        { capabilities: {} },
    );

    // 连接断开必须立刻上报：否则主进程只能等 30s 工具超时才发觉浏览器已经没了
    nextTransport.onclose = () => {
        if (resetting || transport !== nextTransport) return;
        connected = false;
        send({ type: 'mcp.state', connected: false, reason: 'transport_closed' });
    };
    nextClient.onclose = () => {
        if (resetting || client !== nextClient) return;
        connected = false;
        send({ type: 'mcp.state', connected: false, reason: 'client_closed' });
    };
    nextClient.onerror = (error) => {
        if (resetting || client !== nextClient) return;
        log('error', `MCP client error: ${error?.message || error}`);
        if (isConnectionError(error)) {
            connected = false;
            send({ type: 'mcp.state', connected: false, reason: `client_error:${error?.message || error}` });
        }
    };

    await nextClient.connect(nextTransport);

    transport = nextTransport;
    client = nextClient;
    connected = true;
    connectionGeneration += 1;

    const tools = (await nextClient.listTools()).tools || [];
    const resources = await nextClient.listResources()
        .then((result) => result.resources || [])
        .catch(() => []);
    const prompts = await nextClient.listPrompts()
        .then((result) => result.prompts || [])
        .catch(() => []);

    cachedResources = resources;
    cachedPrompts = prompts;

    return { tools, resources, prompts, pid: nextTransport.pid ?? null };
}

async function handleConnect(message: Extract<MainToWorkerMessage, { type: 'mcp.connect' }>): Promise<void> {
    const startedAt = Date.now();
    try {
        const result = await ensureConnected(message.config);
        replyOk(message.requestId, {
            tools: result.tools.map((tool: any) => ({
                name: String(tool?.name || ''),
                description: typeof tool?.description === 'string' ? tool.description : undefined,
                inputSchema: {
                    type: 'object',
                    properties: (tool?.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema))
                        ? (tool.inputSchema.properties || {})
                        : {},
                    required: Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : [],
                },
            })),
            resources: result.resources.map((resource: any) => ({
                uri: String(resource?.uri || ''),
                name: String(resource?.name || ''),
                description: typeof resource?.description === 'string' ? resource.description : undefined,
                mimeType: typeof resource?.mimeType === 'string' ? resource.mimeType : undefined,
            })),
            prompts: result.prompts.map((prompt: any) => ({
                name: String(prompt?.name || ''),
                description: typeof prompt?.description === 'string' ? prompt.description : undefined,
                arguments: Array.isArray(prompt?.arguments)
                    ? prompt.arguments.map((arg: any) => ({
                        name: String(arg?.name || ''),
                        description: typeof arg?.description === 'string' ? arg.description : undefined,
                        required: Boolean(arg?.required),
                    }))
                    : undefined,
            })),
            pid: result.pid,
            durationMs: Date.now() - startedAt,
        }, Date.now() - startedAt);
        send({ type: 'mcp.state', connected: true });
    } catch (error) {
        await hardReset('connect_failed');
        replyError(message.requestId, 'mcp_connect_failed', String((error as Error)?.message || error), Date.now() - startedAt);
    }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            onTimeout();
            reject(Object.assign(new Error(`Playwright MCP tool call timed out after ${timeoutMs}ms`), {
                code: 'tool_timeout' as PlaywrightWorkerErrorCode,
            }));
        }, timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

async function handleCall(message: Extract<MainToWorkerMessage, { type: 'mcp.call' }>): Promise<void> {
    const startedAt = Date.now();
    if (!client || !connected) {
        replyError(message.requestId, 'mcp_not_connected', 'Playwright MCP 未连接', Date.now() - startedAt);
        return;
    }
    if (cancelledRequests.delete(message.requestId)) {
        replyError(message.requestId, 'tool_cancelled', '调用已被取消', Date.now() - startedAt);
        return;
    }

    const activeClient = client;
    let timedOut = false;
    try {
        const result = await withTimeout(
            activeClient.callTool({ name: message.name, arguments: message.args || {} }),
            message.timeoutMs,
            () => {
                timedOut = true;
                // 关键：超时后必须把僵死的 MCP 连接连根拔掉，
                // 否则后续所有调用都会排在一个永远不返回的工具后面（旧实现就是这样永久僵死）。
                void hardReset(`tool_timeout:${message.name}`);
            },
        );

        if (cancelledRequests.delete(message.requestId)) {
            replyError(message.requestId, 'tool_cancelled', '调用已被取消', Date.now() - startedAt);
            return;
        }
        replyOk(message.requestId, result, Date.now() - startedAt);
    } catch (error) {
        const durationMs = Date.now() - startedAt;
        const code: PlaywrightWorkerErrorCode = timedOut
            ? 'tool_timeout'
            : isConnectionError(error) ? 'mcp_not_connected' : 'tool_error';
        if (code === 'mcp_not_connected' && !timedOut) {
            await hardReset(`tool_connection_error:${message.name}`);
        }
        replyError(message.requestId, code, String((error as Error)?.message || error), durationMs);
    }
}

function handleMessage(message: MainToWorkerMessage): void {
    switch (message.type) {
        case 'worker.ping':
            send({ type: 'worker.pong', seq: message.seq });
            return;
        case 'mcp.connect':
            void handleConnect(message);
            return;
        case 'mcp.call':
            void handleCall(message);
            return;
        case 'mcp.cancel':
            cancelledRequests.add(message.targetRequestId);
            return;
        case 'mcp.restart':
            void (async () => {
                const startedAt = Date.now();
                if (message.reason) log('info', `收到重启指令：${message.reason}`);
                await hardReset(message.reason || 'restart_requested');
                if (!lastConfig) {
                    replyError(message.requestId, 'mcp_connect_failed', '缺少连接配置，无法重连', Date.now() - startedAt);
                    return;
                }
                await handleConnect({
                    type: 'mcp.connect',
                    requestId: message.requestId,
                    config: lastConfig,
                });
            })();
            return;
        case 'mcp.dispose':
            void (async () => {
                const startedAt = Date.now();
                await hardReset('dispose');
                replyOk(message.requestId, { disposed: true }, Date.now() - startedAt);
                setTimeout(() => process.exit(0), 50).unref?.();
            })();
            return;
        default:
            return;
    }
}

if (parentPort) {
    parentPort.on('message', (event) => {
        if (!isMainToWorkerMessage(event.data)) {
            log('warn', '忽略来自主进程的非法消息');
            return;
        }
        handleMessage(event.data);
    });
} else {
    process.on('message', (data) => {
        if (!isMainToWorkerMessage(data)) {
            log('warn', '忽略来自主进程的非法消息');
            return;
        }
        handleMessage(data);
    });
}

process.on('uncaughtException', (error) => {
    log('error', `uncaughtException: ${error?.stack || error}`);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    log('error', `unhandledRejection: ${String(reason)}`);
    process.exit(1);
});
process.on('exit', () => {
    try {
        killProcessTree(transport?.pid ?? null);
    } catch {
        // ignore
    }
});

send({ type: 'worker.ready', protocolVersion: PLAYWRIGHT_WORKER_PROTOCOL_VERSION, pid: process.pid });
