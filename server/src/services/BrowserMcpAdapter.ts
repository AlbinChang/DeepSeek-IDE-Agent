/**
 * BrowserMcpAdapter — Playwright MCP 浏览器自动化适配器
 *
 * 设计理念：
 * - 纯适配器模式：不自己实现浏览器会话，直接桥接 Playwright MCP 的原生工具
 * - Agent 初始化阶段即建立连接，获取工具定义 / 资源定义 / 提示模板
 * - MCP Client 与它拉起的浏览器托管在独立 Worker 进程里（PlaywrightWorkerClient
 *   负责超时看门狗与退避重建），僵死时连进程树一起杀掉重建，不再拖垮主进程
 *
 * 架构参考：
 * - McpService 的 Client 管理 + 工具桥接模式
 * - 遵循 user+workspace 隔离策略
 */

import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { ToolDefinition } from '@/services/ToolManager.js';
import { getBeijingLogTimePrefix } from '@/utils/TimeUtils.js';
import { PlaywrightWorkerClient } from '@/services/PlaywrightWorkerClient.js';
import { ChildProcessPlaywrightSpawner } from '@/services/childProcessPlaywrightSpawner.js';
import type {
    PlaywrightMcpLaunchConfig,
    PlaywrightNativePromptDescriptor,
    PlaywrightNativeResourceDescriptor,
    PlaywrightNativeToolDescriptor,
    PlaywrightWorkerSpawner,
} from '@/services/playwrightWorkerProtocol.js';

const getTS = () => getBeijingLogTimePrefix();

// ============================================================
// 类型定义
// ============================================================

/** Playwright MCP 原生工具描述（与 Worker 协议共用同一结构） */
export type PlaywrightNativeTool = PlaywrightNativeToolDescriptor;

/** Playwright MCP 原生资源描述 */
export type PlaywrightNativeResource = PlaywrightNativeResourceDescriptor;

/** Playwright MCP 原生提示模板 */
export type PlaywrightNativePrompt = PlaywrightNativePromptDescriptor;

/** 适配器连接状态 */
interface AdapterState {
    /**
     * Worker 监督器：MCP Client 与 Chrome 都跑在独立进程里。
     * 这里只持有句柄，不再直接持有 transport/client——旧实现把僵死的 MCP 连接
     * 留在主进程内存里，超时后既杀不掉也无法感知，只能重启应用。
     */
    worker: PlaywrightWorkerClient;
    connected: boolean;
    tools: PlaywrightNativeToolDescriptor[];
    resources: PlaywrightNativeResourceDescriptor[];
    prompts: PlaywrightNativePromptDescriptor[];
    lastConnectedAt: number;
    errorCount: number;
    lastError?: string;
}

// ============================================================
// 常量
// ============================================================

/** 桥接工具名前缀 */
export const PLAYWRIGHT_MCP_PREFIX = 'playwright';

/** 工具名前缀分隔符 */
const TOOL_NAME_SEPARATOR = '__';

/** 连接失败熔断阈值 */
const CIRCUIT_BREAKER_THRESHOLD = 3;

/** 默认工具调用超时（ms） */
const DEFAULT_TOOL_TIMEOUT = 30_000;

/**
 * 断连后等待监督器自愈的时间（ms）。
 * 超时重置的恢复通常只需 1 次退避（500ms），给 3s 足够覆盖两次退避。
 */
const RECOVERY_WAIT_MS = 3_000;

/**
 * 导航类工具：真实耗时由 `--timeout-navigation` 决定（默认 120s），
 * 旧的统一 30s 宿主超时会把「页面还在正常加载」误判成僵死。
 */
const NAVIGATION_TOOL_NAMES = new Set([
    'browser_navigate',
    'browser_navigate_back',
    'browser_wait_for',
]);

/**
 * 计算单个工具调用的宿主超时。
 * 必须给 MCP CLI 自身的预算留出余量，否则会在 CLI 还正常工作时就把它杀掉。
 */
export function resolvePlaywrightToolTimeout(
    nativeToolName: string,
    env: NodeJS.ProcessEnv = process.env,
): number {
    const readPositive = (value: string | undefined, fallback: number): number => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };

    if (NAVIGATION_TOOL_NAMES.has(nativeToolName)) {
        const navigationBudget = readPositive(env.BROWSER_MCP_TIMEOUT_NAVIGATION, 120_000);
        return Math.max(DEFAULT_TOOL_TIMEOUT, navigationBudget + 30_000);
    }
    const actionBudget = readPositive(env.BROWSER_MCP_TIMEOUT_ACTION, 10_000);
    return Math.max(DEFAULT_TOOL_TIMEOUT, actionBudget + 20_000);
}

/** 构建桥接工具名 */
export function buildPlaywrightToolName(nativeToolName: string): string {
    return `${PLAYWRIGHT_MCP_PREFIX}${TOOL_NAME_SEPARATOR}${nativeToolName}`;
}

/** 解析桥接工具名 */
export function parsePlaywrightToolName(agentToolName: string): { nativeToolName: string } | null {
    const idx = agentToolName.indexOf(TOOL_NAME_SEPARATOR);
    if (idx <= 0) return null;
    const prefix = agentToolName.slice(0, idx);
    if (prefix !== PLAYWRIGHT_MCP_PREFIX) return null;
    return {
        nativeToolName: agentToolName.slice(idx + TOOL_NAME_SEPARATOR.length),
    };
}

// ============================================================
// BrowserMcpAdapter
// ============================================================

export class BrowserMcpAdapter {
    private static instance: BrowserMcpAdapter;

    /**
     * Worker 启动器：Electron 主进程注入 utilityProcess 版本；
     * 未注入时（纯 Node / 本地调试）回退到 child_process.fork。
     */
    private static workerSpawner: PlaywrightWorkerSpawner | null = null;
    /** Worker bundle 路径；为空时按约定目录探测 */
    private static workerEntry: string | null = null;

    /** userId\u0000workspaceRoot → AdapterState */
    private connections = new Map<string, AdapterState>();

    private constructor() {}

    public static getInstance(): BrowserMcpAdapter {
        if (!BrowserMcpAdapter.instance) {
            BrowserMcpAdapter.instance = new BrowserMcpAdapter();
        }
        return BrowserMcpAdapter.instance;
    }

    /**
     * 注入 Worker 运行时（由 Electron 主进程在启动时调用）。
     * 不注入时自动使用 child_process 版本，保证非 Electron 环境同样具备隔离能力。
     */
    public static configureWorkerRuntime(options: {
        spawner?: PlaywrightWorkerSpawner | null;
        entry?: string | null;
    }): void {
        BrowserMcpAdapter.workerSpawner = options.spawner ?? null;
        BrowserMcpAdapter.workerEntry = options.entry ?? null;
    }

    /** 解析 Worker bundle 路径（开发/打包两种布局） */
    public static resolveWorkerEntry(): string | null {
        if (BrowserMcpAdapter.workerEntry && existsSync(BrowserMcpAdapter.workerEntry)) {
            return BrowserMcpAdapter.workerEntry;
        }
        const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath || '';
        const candidates = [
            path.resolve(process.cwd(), 'dist', 'workers', 'playwrightMcpWorker.cjs'),
            path.resolve(process.cwd(), 'workers', 'playwrightMcpWorker.cjs'),
            // 从仓库根目录启动（如独立 server 进程）时指向 electron 产物
            path.resolve(process.cwd(), 'electron', 'dist', 'workers', 'playwrightMcpWorker.cjs'),
            path.resolve(process.cwd(), '..', 'dist', 'workers', 'playwrightMcpWorker.cjs'),
            resourcesPath ? path.resolve(resourcesPath, 'workers', 'playwrightMcpWorker.cjs') : '',
        ].filter(Boolean);
        return candidates.find((candidate) => existsSync(candidate)) || null;
    }

    private static resolveWorkerSpawner(): PlaywrightWorkerSpawner {
        if (BrowserMcpAdapter.workerSpawner) return BrowserMcpAdapter.workerSpawner;
        const entry = BrowserMcpAdapter.resolveWorkerEntry();
        if (!entry) {
            throw new Error(
                '未找到 Playwright Worker bundle（playwrightMcpWorker.cjs）。'
                + '请先执行 `pnpm --filter deepseek-ide-agent-electron run build:playwright-worker`。',
            );
        }
        BrowserMcpAdapter.workerSpawner = new ChildProcessPlaywrightSpawner({ entry, env: process.env });
        return BrowserMcpAdapter.workerSpawner;
    }

    /** 构建隔离 key */
    private static sessionKey(userId: string, workspaceRoot: string): string {
        return `${userId}\u0000${workspaceRoot}`;
    }

    // ============================================================
    // 生命周期管理
    // ============================================================

    /**
     * 为指定用户+workspace 连接 Playwright MCP 服务器
     * 应在 workspace 初始化时调用（与 McpService.connectAll 同级）
     */
    async connect(userId: string, workspaceRoot: string): Promise<void> {
        const key = BrowserMcpAdapter.sessionKey(userId, workspaceRoot);

        // 已有连接则跳过
        if (this.connections.has(key)) {
            const existing = this.connections.get(key)!;
            if (existing.connected) {
                console.log(`${getTS()} [BrowserMcpAdapter] Already connected for user ${userId} @ ${workspaceRoot}`);
                return;
            }
            // 连接断开则清理重建
            await this.disconnect(userId, workspaceRoot);
        }

        const startedAt = Date.now();
        console.log(`${getTS()} [BrowserMcpAdapter] Connecting Playwright MCP for user ${userId} @ ${workspaceRoot}...`);

        let spawner: PlaywrightWorkerSpawner;
        try {
            spawner = BrowserMcpAdapter.resolveWorkerSpawner();
        } catch (err: any) {
            // Worker bundle 缺失属于部署问题，直接失败并保留原状态，不抛给调用方
            console.error(`${getTS()} [BrowserMcpAdapter] ❌ Worker runtime unavailable: ${err?.message || err}`);
            return;
        }

        const state: AdapterState = {
            worker: new PlaywrightWorkerClient({
                spawner,
                onStateChange: (connected, reason) => {
                    const current = this.connections.get(key);
                    if (!current || current !== state) return;
                    if (connected !== current.connected) {
                        console.log(
                            `${getTS()} [BrowserMcpAdapter] Worker state → ${connected ? 'connected' : 'disconnected'}`
                            + (reason ? ` (${reason})` : ''),
                        );
                    }
                    current.connected = connected;
                    if (!connected && reason) {
                        current.lastError = reason;
                    }
                },
            }),
            connected: false,
            tools: [],
            resources: [],
            prompts: [],
            lastConnectedAt: 0,
            errorCount: 0,
        };

        try {
            const launchConfig = await this.buildLaunchConfig(workspaceRoot);
            const result = await state.worker.connect(launchConfig, true);

            state.connected = true;
            state.tools = result.tools;
            state.resources = result.resources;
            state.prompts = result.prompts;
            state.lastConnectedAt = startedAt;
            state.errorCount = 0;
            state.lastError = undefined;

            this.connections.set(key, state);

            const duration = Date.now() - startedAt;
            console.log(
                `${getTS()} [BrowserMcpAdapter] ✅ Connected Playwright MCP via worker `
                + `(${result.tools.length} tools, ${result.resources.length} resources, `
                + `${result.prompts.length} prompts, ${duration}ms, worker pid=${result.pid ?? 'n/a'})`,
            );
        } catch (err: any) {
            state.connected = false;
            state.errorCount = 1;
            state.lastError = String(err?.message || err);
            this.connections.set(key, state);
            console.error(`${getTS()} [BrowserMcpAdapter] ❌ Failed to connect: ${state.lastError}`);

            // 连接失败不保留半死状态：杀掉 worker，下次 connect 会重新拉起干净进程
            try { await state.worker.dispose(); } catch {}
        }
    }

    /**
     * 构建 Playwright MCP 启动配置。
     *
     * 注意：Electron 主进程下 process.execPath 指向 electron.exe 而非 node.exe。
     * 若不加区分地把 electron.exe 当作 Node 可执行文件去启动 Playwright MCP CLI，
     * Electron 会尝试把该 CLI 脚本当作应用入口加载（而不是以纯 Node 脚本运行），
     * 导致 MCP stdio 握手失败。因此设置 ELECTRON_RUN_AS_NODE=1 强制子进程以纯
     * Node 进程运行；非 Electron 环境下该变量被忽略。
     */
    private async buildLaunchConfig(workspaceRoot: string): Promise<PlaywrightMcpLaunchConfig> {
        // 1. 解析 Playwright MCP CLI 路径
        const cliPath = BrowserMcpAdapter.resolveMcpCliPath();
        const outputRoot = path.join(workspaceRoot, '.temp', 'playwright-mcp', 'adapter');
        await fs.mkdir(outputRoot, { recursive: true });

        // 2. 构建启动参数
        const cliArgs: string[] = [
            cliPath,
            '--browser',
            String(process.env.BROWSER_MCP_BROWSER || 'chrome'),
            '--output-dir',
            outputRoot,
            '--timeout-navigation',
            String(process.env.BROWSER_MCP_TIMEOUT_NAVIGATION || '120000'),
            '--timeout-action',
            String(process.env.BROWSER_MCP_TIMEOUT_ACTION || '10000'),
        ];

        // 允许访问 file:// 本地 HTML 文件（默认开启，方便预览本地页面）
        // 关闭方式：设置 BROWSER_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=false
        if (String(process.env.BROWSER_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS || 'true').toLowerCase() !== 'false') {
            cliArgs.push('--allow-unrestricted-file-access');
        }

        // headless 模式（默认非 headless，方便调试）
        if (String(process.env.BROWSER_MCP_HEADLESS || '').toLowerCase() === 'true') {
            cliArgs.push('--headless');
        }

        // 忽略 HTTPS 证书错误（本地开发服务器常用自签名证书）
        if (String(process.env.BROWSER_MCP_IGNORE_HTTPS_ERRORS || '').toLowerCase() === 'true') {
            cliArgs.push('--ignore-https-errors');
        }

        // 禁用沙箱（Docker/CI 环境需要）
        if (String(process.env.BROWSER_MCP_NO_SANDBOX || '').toLowerCase() === 'true') {
            cliArgs.push('--no-sandbox');
        }

        // 自定义视口大小
        const viewportSize = String(process.env.BROWSER_MCP_VIEWPORT_SIZE || '').trim();
        if (viewportSize) {
            cliArgs.push('--viewport-size', viewportSize);
        }

        // 隔离模式：每次会话独立 profile，不持久化
        if (String(process.env.BROWSER_MCP_ISOLATED || '').toLowerCase() === 'true') {
            cliArgs.push('--isolated');
        }

        return {
            command: process.execPath,
            args: cliArgs,
            cwd: workspaceRoot,
            env: {
                ...(process.env as Record<string, string>),
                ELECTRON_RUN_AS_NODE: '1',
            },
        };
    }
    /**
     * 断开指定用户+workspace 的 Playwright MCP 连接
     */
    async disconnect(userId: string, workspaceRoot: string): Promise<void> {
        const key = BrowserMcpAdapter.sessionKey(userId, workspaceRoot);
        const state = this.connections.get(key);
        if (!state) return;

        console.log(`${getTS()} [BrowserMcpAdapter] Disconnecting Playwright MCP for user ${userId} @ ${workspaceRoot}`);
        try { await state.worker.dispose(); } catch (err: any) {
            console.warn(`${getTS()} [BrowserMcpAdapter] Worker dispose failed: ${err?.message || err}`);
        }
        this.connections.delete(key);
    }

    /** 关闭所有 worker（应用退出时调用） */
    async shutdown(): Promise<void> {
        const states = Array.from(this.connections.values());
        this.connections.clear();
        await Promise.allSettled(states.map((state) => state.worker.dispose()));
    }

    /**
     * 获取连接状态
     */
    getConnectionState(userId: string, workspaceRoot: string): AdapterState | undefined {
        return this.connections.get(BrowserMcpAdapter.sessionKey(userId, workspaceRoot));
    }

    /**
     * 判断是否已连接
     */
    isConnected(userId: string, workspaceRoot: string): boolean {
        return this.getConnectionState(userId, workspaceRoot)?.connected ?? false;
    }

    // ============================================================
    // 工具桥接
    // ============================================================

    /**
     * 生成所有 Playwright MCP 桥接工具的 ToolDefinition
     * 在 Agent 初始化阶段调用，注册到 ToolManager
     */
    getBridgeToolDefinitions(userId: string, workspaceRoot: string): ToolDefinition[] {
        const state = this.getConnectionState(userId, workspaceRoot);
        if (!state || !state.connected) {
            console.warn(`${getTS()} [BrowserMcpAdapter] Not connected, returning 0 bridge tools`);
            return [];
        }

        const definitions: ToolDefinition[] = [];

        for (const nativeTool of state.tools) {
            const agentName = buildPlaywrightToolName(nativeTool.name);
            const description = this.buildToolDescription(nativeTool);

            definitions.push({
                name: agentName,
                description,
                parameters: {
                    type: 'object',
                    properties: nativeTool.inputSchema.properties || {},
                    required: nativeTool.inputSchema.required || [],
                },
                execute: async (params: any, context?: any) => {
                    const resolvedUserId = context?.userId || userId;
                    const wsRoot = context?.workspaceRoot || workspaceRoot;
                    return await this.executeTool(agentName, params, resolvedUserId, wsRoot);
                },
            });
        }

        console.log(`${getTS()} [BrowserMcpAdapter] Built ${definitions.length} Playwright bridge tool definitions`);
        return definitions;
    }

    /**
     * 生成 Playwright MCP 工具的 OpenAI function-calling 元数据
     */
    getBridgeToolsMetadata(userId: string, workspaceRoot: string): Array<{
        type: 'function';
        function: { name: string; description: string; parameters: unknown };
    }> {
        const state = this.getConnectionState(userId, workspaceRoot);
        if (!state || !state.connected) return [];

        const metadata = state.tools.map((nativeTool) => {
            const agentName = buildPlaywrightToolName(nativeTool.name);
            const description = this.buildToolDescription(nativeTool);

            return {
                type: 'function' as const,
                function: {
                    name: agentName,
                    description,
                    parameters: {
                        type: 'object',
                        properties: nativeTool.inputSchema.properties || {},
                        required: nativeTool.inputSchema.required || [],
                    },
                },
            };
        });

        return metadata;
    }

    /**
     * 构建桥接工具的描述文本
     */
    private buildToolDescription(nativeTool: PlaywrightNativeTool): string {
        return nativeTool.description?.trim() || nativeTool.name;
    }

    // ============================================================
    // 工具执行
    // ============================================================

    /**
     * 执行 Playwright MCP 工具调用
     */
    async executeTool(
        agentToolName: string,
        params: Record<string, unknown>,
        userId: string,
        workspaceRoot: string,
    ): Promise<unknown> {
        const parsed = parsePlaywrightToolName(agentToolName);
        if (!parsed) {
            return { status: 'error', message: `无效的 Playwright 工具名: ${agentToolName}` };
        }

        const { nativeToolName } = parsed;
        const key = BrowserMcpAdapter.sessionKey(userId, workspaceRoot);
        const state = this.connections.get(key);

        if (!state) {
            return { status: 'error', message: 'Playwright MCP 适配器未初始化，请先初始化工作区' };
        }

        if (!state.connected) {
            // 自愈窗口内（超时后监督器正在退避重建）优先等它自己恢复，
            // 避免每次工具调用都重建整个 worker 进程。
            const recovered = await state.worker.waitForConnected(RECOVERY_WAIT_MS);
            if (recovered) {
                console.log(`${getTS()} [BrowserMcpAdapter] Worker recovered automatically, retrying ${nativeToolName}`);
            } else if (state.errorCount < CIRCUIT_BREAKER_THRESHOLD) {
                // 自动恢复没赶上，主动重建一次（熔断阈值内）
                console.log(`${getTS()} [BrowserMcpAdapter] Attempting reconnect...`);
                await this.connect(userId, workspaceRoot);
            }

            const newState = this.connections.get(key);
            if (newState?.connected) {
                return await this.executeTool(agentToolName, params, userId, workspaceRoot);
            }
            return {
                status: 'error',
                message: `Playwright MCP 未连接（${newState?.lastError || state.lastError || '未知原因'}）`,
            };
        }

        const timeout = resolvePlaywrightToolTimeout(nativeToolName);
        const startedAt = Date.now();

        try {
            const result = await state.worker.callTool(nativeToolName, params || {}, timeout);

            const duration = Date.now() - startedAt;
            console.log(`${getTS()} [BrowserMcpAdapter] ✅ ${agentToolName} (${duration}ms)`);

            return this.formatResult(result);
        } catch (err: any) {
            const duration = Date.now() - startedAt;
            state.errorCount += 1;
            state.lastError = String(err?.message || err);
            console.error(`${getTS()} [BrowserMcpAdapter] ❌ ${agentToolName} failed (${duration}ms): ${state.lastError}`);

            // 连接级故障（超时/进程退出/协议中断）由监督器负责重建，
            // 这里只需读取最新状态，避免把已自动恢复的连接误标为断开。
            state.connected = state.worker.getStatus().connected;

            return {
                status: 'error',
                message: `Playwright 工具 "${nativeToolName}" 执行失败: ${state.lastError}`,
                toolName: agentToolName,
                durationMs: duration,
            };
        }
    }

    /**
     * 直接调用 Playwright MCP 原生工具（供服务端编排使用）。
     * 与 executeTool 的区别：
     * - 返回原始文本（不做 formatResult 包装），供服务端解析
     * - 失败时抛出异常
     * - 支持自定义超时（导航类操作需要更长时间）
     */
    public async callNativeTool(
        userId: string,
        workspaceRoot: string,
        nativeToolName: string,
        args: Record<string, unknown>,
        timeoutMs: number = DEFAULT_TOOL_TIMEOUT,
    ): Promise<{ text: string; isError: boolean }> {
        const key = BrowserMcpAdapter.sessionKey(userId, workspaceRoot);
        let state = this.connections.get(key);

        if (!state) {
            throw new Error('Playwright MCP 适配器未初始化，请先初始化工作区');
        }

        if (!state.connected) {
            const recovered = await state.worker.waitForConnected(RECOVERY_WAIT_MS);
            if (!recovered && state.errorCount < CIRCUIT_BREAKER_THRESHOLD) {
                await this.connect(userId, workspaceRoot);
                state = this.connections.get(key);
            }
            if (!state || !state.connected) {
                throw new Error(`Playwright MCP 未连接（${state?.lastError || '未知原因'}）`);
            }
        }

        try {
            const result = await state.worker.callTool(nativeToolName, args || {}, timeoutMs);

            const res = result as Record<string, unknown>;
            const textParts: string[] = [];
            if (Array.isArray(res?.content)) {
                for (const item of res.content as Array<Record<string, unknown>>) {
                    if (item?.type === 'text' && typeof item.text === 'string') {
                        textParts.push(item.text);
                    }
                }
            }
            return { text: textParts.join('\n'), isError: Boolean(res?.isError) };
        } catch (err: any) {
            state.errorCount += 1;
            state.lastError = String(err?.message || err);
            state.connected = state.worker.getStatus().connected;
            throw err;
        }
    }

    /**
     * 格式化 MCP 工具返回结果
     *
     * 【Token 优化】成功路径返回纯文本 string，跳过 AgentTurnEngine 的 JSON.stringify，
     * 消除 MCP 协议包装（{type: "text", text: ...}）和 \n → \\n 双重转义（实测节省 ~15% token）。
     * 对标 read_file / list_files 的纯文本化优化。
     */
    private formatResult(raw: unknown): unknown {
        if (!raw || typeof raw !== 'object') {
            return String(raw);
        }

        const result = raw as Record<string, unknown>;
        const isError = Boolean(result.isError);

        // MCP 标准响应格式: { content: [{ type: "text", text: "..." }, ...] }
        if (result.content && Array.isArray(result.content)) {
            const textParts: string[] = [];
            for (const item of result.content as Array<Record<string, unknown>>) {
                if (item?.type === 'text' && typeof item.text === 'string') {
                    textParts.push(item.text);
                }
            }
            const text = textParts.join('\n');
            if (isError) {
                return `[MCP Error] ${text || 'Unknown error'}`;
            }
            // 成功路径：纯文本 string → AgentTurnEngine 跳过 JSON.stringify
            return text;
        }

        // 非标准响应：保留结构化对象（通常很小）
        return { status: 'success', ...result };
    }

    // ============================================================
    // 系统提示词生成
    // ============================================================

    /**
     * 生成 Playwright MCP 工具的系统提示词片段
     * 动态注入到 buildSystemPrompt 的 DYNAMIC SUFFIX 区域
     */
    buildSystemPrompt(userId: string, workspaceRoot: string): string {
        const state = this.getConnectionState(userId, workspaceRoot);

        if (!state) {
            return [
                '### 浏览器自动化工具 (BROWSER AUTOMATION VIA PLAYWRIGHT MCP)',
                'Playwright MCP 适配器未初始化。浏览器自动化工具当前不可用。',
            ].join('\n');
        }

        if (!state.connected) {
            return [
                '### 浏览器自动化工具 (BROWSER AUTOMATION VIA PLAYWRIGHT MCP)',
                `❌ Playwright MCP 未连接 — ${state.lastError || '未知错误'}`,
                '浏览器自动化工具当前不可用，请检查 Playwright MCP 服务状态。',
            ].join('\n');
        }

        const lines: string[] = [
            '### 浏览器自动化 (PLAYWRIGHT MCP)',
            `✅ 已连接，${state.tools.length} 个工具可用。工具名统一前缀 \`playwright__\`；参数与用途见函数工具定义，此处不重复。调用方式与内置工具相同，Playwright 自动管理会话。`,
            '',
            '**使用策略**：',
            '- 优先 `playwright__browser_snapshot` 获取可访问性快照了解页面结构。',
            '- 用 `playwright__browser_evaluate` 做定向数据抽取（返回 JS 表达式结果，不限长度）。',
            '- `playwright__browser_take_screenshot` 仅用于视觉留存，不用于数据采集。',
            '- 交互前先取最新快照，确认元素 ref 仍有效。',
            '',
            '**📥 网页内容保存**：正文用 `browser_navigate` + `browser_evaluate` 提取后 `write_file` 写 .md（encoding: "utf-8"）；图片本地化到 `docs/images/` 并用相对路径引用。完整规范见 `read_skill("web-research")`。',
            '',
            '**🚫 截图禁令**：严禁用 `browser_take_screenshot` 截图「保存/下载/收藏」网页文章（不可检索、不可复制、体积巨大）。截图仅限：UI 视觉验收、调试布局样式、用户明确要求截图。内容采集必须用 `browser_evaluate` 提取文字后 `write_file`。',
            '',
            '**本地文件预览**：支持 `file://` 打开本地 HTML（已启用 `--allow-unrestricted-file-access`），格式 `file:///盘符:/路径/文件.html`（Windows）或 `file:///路径/文件.html`（Unix），页面相对路径资源可正常加载。需由开发服务器加载时先启动服务再用 `http://localhost:端口` 导航。',
            '',
            '**⚠️ 浏览器清理强制规则**：任务完成、准备输出最终答复前必须 `playwright__browser_close` 关闭浏览器；数据采集/截图/交互结束后不再需要浏览器时立即关闭，禁止保持会话打开。仅需关闭当前标签页时用 `playwright__browser_tabs`（`{ "action": "close" }`）。关闭前确认所需数据已保存，关闭后状态不可恢复。',
        ];

        return lines.join('\n');
    }

    /**
     * 获取 Playwright MCP 工具摘要列表
     */
    getToolSummaries(userId: string, workspaceRoot: string): Array<{ name: string; description: string }> {
        const state = this.getConnectionState(userId, workspaceRoot);
        if (!state || !state.connected) return [];

        return state.tools.map((t) => ({
            name: buildPlaywrightToolName(t.name),
            description: t.description || '(无描述)',
        }));
    }

    // ============================================================
    // 辅助方法
    // ============================================================

    /**
     * 解析 Playwright MCP CLI 路径
     */
    private static resolveMcpCliPath(): string {
        const require = createRequire(import.meta.url);
        const pkgJsonPath = require.resolve('@playwright/mcp/package.json');
        const pkgRoot = path.dirname(pkgJsonPath);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const pkg = require(pkgJsonPath) as { bin?: string | Record<string, string> };
        const binValue = typeof pkg.bin === 'string'
            ? pkg.bin
            : (pkg.bin?.['playwright-mcp'] || 'cli.js');

        const cliPath = path.resolve(pkgRoot, binValue);
        if (existsSync(cliPath)) return cliPath;

        const fallback = path.resolve(pkgRoot, 'cli.js');
        if (existsSync(fallback)) return fallback;

        throw new Error(`Unable to locate Playwright MCP CLI. packageRoot=${pkgRoot}`);
    }
}
