/**
 * BrowserMcpAdapter — Playwright MCP 浏览器自动化适配器
 *
 * 设计理念：
 * - 纯适配器模式：不管理浏览器会话，Playwright MCP 自身具备会话管理能力
 * - Agent 初始化阶段即建立 MCP Client 连接，获取工具定义 / 资源定义 / 提示模板
 * - 将 Playwright MCP 原生工具桥接为 Agent ToolDefinition，直接转发调用
 * - 无会话管理、无预览服务器、无协议自愈、无参数标准化——全部交由 Playwright MCP 处理
 *
 * 架构参考：
 * - McpService 的 Client 管理 + 工具桥接模式
 * - 遵循 user+workspace 隔离策略
 */

import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolDefinition } from '@/services/ToolManager.js';
import { getBeijingLogTimePrefix } from '@/utils/TimeUtils.js';

const getTS = () => getBeijingLogTimePrefix();

// ============================================================
// 类型定义
// ============================================================

/** Playwright MCP 原生工具描述 */
export interface PlaywrightNativeTool {
    name: string;
    description?: string;
    inputSchema: {
        type: 'object';
        properties?: Record<string, unknown>;
        required?: string[];
    };
}

/** Playwright MCP 原生资源描述 */
export interface PlaywrightNativeResource {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
}

/** Playwright MCP 原生提示模板 */
export interface PlaywrightNativePrompt {
    name: string;
    description?: string;
    arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

/** 适配器连接状态 */
interface AdapterState {
    client: Client;
    transport: StdioClientTransport;
    connected: boolean;
    tools: PlaywrightNativeTool[];
    resources: PlaywrightNativeResource[];
    prompts: PlaywrightNativePrompt[];
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

    /** userId\u0000workspaceRoot → AdapterState */
    private connections = new Map<string, AdapterState>();

    private constructor() {}

    public static getInstance(): BrowserMcpAdapter {
        if (!BrowserMcpAdapter.instance) {
            BrowserMcpAdapter.instance = new BrowserMcpAdapter();
        }
        return BrowserMcpAdapter.instance;
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

        const state: AdapterState = {
            client: null as any,
            transport: null as any,
            connected: false,
            tools: [],
            resources: [],
            prompts: [],
            lastConnectedAt: 0,
            errorCount: 0,
        };

        try {
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

            // 3. 创建 stdio transport + MCP client
            //
            // 注意：Electron 单进程架构下 AgentService/BrowserMcpAdapter 直接运行在
            // Electron 主进程中，此时 process.execPath 指向 electron.exe 而非 node.exe。
            // 若不加区分地把 electron.exe 当作 Node 可执行文件去启动 Playwright MCP CLI，
            // Electron 会尝试把该 CLI 脚本当作应用入口加载（而不是以纯 Node 脚本运行），
            // 导致 MCP stdio 握手失败 → state.connected 恒为 false → 系统提示词报告
            // "浏览器自动化工具当前不可用"。
            // 设置 ELECTRON_RUN_AS_NODE=1 强制子进程以纯 Node 进程运行；在非 Electron
            // 环境（如独立 server 进程）下该变量被忽略，不影响行为。
            const transport = new StdioClientTransport({
                command: process.execPath,
                args: cliArgs,
                cwd: workspaceRoot,
                env: {
                    ...(process.env as Record<string, string>),
                    ELECTRON_RUN_AS_NODE: '1',
                },
            });

            const client = new Client(
                { name: 'deepseek-ide-agent-playwright-adapter', version: '1.0.0' },
                { capabilities: {} },
            );

            await client.connect(transport);

            // 4. 获取工具定义（无需打开网页）
            const toolsResult = await client.listTools();
            const tools: PlaywrightNativeTool[] = (toolsResult?.tools || []).map((t: any) => ({
                name: String(t.name || ''),
                description: typeof t.description === 'string' ? t.description : undefined,
                inputSchema: {
                    type: 'object' as const,
                    properties: (t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema))
                        ? (t.inputSchema.properties as Record<string, unknown> || {})
                        : {},
                    required: Array.isArray(t.inputSchema?.required) ? t.inputSchema.required : [],
                },
            }));

            // 5. 获取资源定义（如果 Playwright MCP 支持）
            let resources: PlaywrightNativeResource[] = [];
            try {
                const resourcesResult = await client.listResources();
                resources = (resourcesResult?.resources || []).map((r: any) => ({
                    uri: String(r.uri || ''),
                    name: String(r.name || ''),
                    description: typeof r.description === 'string' ? r.description : undefined,
                    mimeType: typeof r.mimeType === 'string' ? r.mimeType : undefined,
                }));
            } catch (err: any) {
                // listResources 是可选的，某些 MCP 服务器可能不支持
                console.log(`${getTS()} [BrowserMcpAdapter] listResources not supported or failed: ${err?.message || err}`);
            }

            // 6. 获取提示模板（如果 Playwright MCP 支持）
            let prompts: PlaywrightNativePrompt[] = [];
            try {
                const promptsResult = await client.listPrompts();
                prompts = (promptsResult?.prompts || []).map((p: any) => ({
                    name: String(p.name || ''),
                    description: typeof p.description === 'string' ? p.description : undefined,
                    arguments: Array.isArray(p.arguments) ? p.arguments.map((a: any) => ({
                        name: String(a.name || ''),
                        description: typeof a.description === 'string' ? a.description : undefined,
                        required: Boolean(a.required),
                    })) : undefined,
                }));
            } catch (err: any) {
                console.log(`${getTS()} [BrowserMcpAdapter] listPrompts not supported or failed: ${err?.message || err}`);
            }

            // 7. 更新状态
            state.client = client;
            state.transport = transport;
            state.connected = true;
            state.tools = tools;
            state.resources = resources;
            state.prompts = prompts;
            state.lastConnectedAt = startedAt;
            state.errorCount = 0;

            this.connections.set(key, state);

            const duration = Date.now() - startedAt;
            console.log(
                `${getTS()} [BrowserMcpAdapter] ✅ Connected Playwright MCP ` +
                `(${tools.length} tools, ${resources.length} resources, ${prompts.length} prompts, ${duration}ms)`,
            );
        } catch (err: any) {
            state.connected = false;
            state.errorCount = 1;
            state.lastError = String(err?.message || err);
            this.connections.set(key, state);
            console.error(`${getTS()} [BrowserMcpAdapter] ❌ Failed to connect: ${state.lastError}`);

            // 尝试清理
            try { await state.transport?.close(); } catch {}
            try { await state.client?.close(); } catch {}
        }
    }

    /**
     * 断开指定用户+workspace 的 Playwright MCP 连接
     */
    async disconnect(userId: string, workspaceRoot: string): Promise<void> {
        const key = BrowserMcpAdapter.sessionKey(userId, workspaceRoot);
        const state = this.connections.get(key);
        if (!state) return;

        console.log(`${getTS()} [BrowserMcpAdapter] Disconnecting Playwright MCP for user ${userId} @ ${workspaceRoot}`);
        try { await state.transport?.close(); } catch {}
        try { await state.client?.close(); } catch {}
        this.connections.delete(key);
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
            // 尝试重连（熔断阈值内）
            if (state.errorCount < CIRCUIT_BREAKER_THRESHOLD) {
                console.log(`${getTS()} [BrowserMcpAdapter] Attempting reconnect...`);
                await this.connect(userId, workspaceRoot);
                const newState = this.connections.get(key);
                if (newState?.connected) {
                    return await this.executeTool(agentToolName, params, userId, workspaceRoot);
                }
            }
            return {
                status: 'error',
                message: `Playwright MCP 未连接（${state.lastError || '未知原因'}）`,
            };
        }

        const timeout = DEFAULT_TOOL_TIMEOUT;
        const startedAt = Date.now();

        try {
            const result = await this.withTimeout(
                state.client.callTool({
                    name: nativeToolName,
                    arguments: params || {},
                }),
                timeout,
            );

            const duration = Date.now() - startedAt;
            console.log(`${getTS()} [BrowserMcpAdapter] ✅ ${agentToolName} (${duration}ms)`);

            return this.formatResult(result);
        } catch (err: any) {
            const duration = Date.now() - startedAt;
            state.errorCount += 1;
            state.lastError = String(err?.message || err);
            console.error(`${getTS()} [BrowserMcpAdapter] ❌ ${agentToolName} failed (${duration}ms): ${state.lastError}`);

            // 检查是否为连接级错误
            if (this.isConnectionError(err)) {
                state.connected = false;
            }

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
            if (state.errorCount < CIRCUIT_BREAKER_THRESHOLD) {
                await this.connect(userId, workspaceRoot);
                state = this.connections.get(key);
            }
            if (!state || !state.connected) {
                throw new Error(`Playwright MCP 未连接（${state?.lastError || '未知原因'}）`);
            }
        }

        try {
            const result = await this.withTimeout(
                state.client.callTool({ name: nativeToolName, arguments: args || {} }),
                timeoutMs,
            );

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
            if (this.isConnectionError(err)) {
                state.connected = false;
            }
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
            '**📥 网页内容保存**：正文用 `browser_navigate` + `browser_evaluate` 提取后 `file_write` 写 .md（encoding: "utf-8"）；图片本地化到 `docs/images/` 并用相对路径引用。完整规范见 `read_skill("web-research")`。',
            '',
            '**🚫 截图禁令**：严禁用 `browser_take_screenshot` 截图「保存/下载/收藏」网页文章（不可检索、不可复制、体积巨大）。截图仅限：UI 视觉验收、调试布局样式、用户明确要求截图。内容采集必须用 `browser_evaluate` 提取文字后 `file_write`。',
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

    /**
     * 带超时的 Promise
     */
    private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Playwright MCP tool call timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            promise
                .then((result) => {
                    clearTimeout(timer);
                    resolve(result);
                })
                .catch((err) => {
                    clearTimeout(timer);
                    reject(err);
                });
        });
    }

    /**
     * 判断错误是否为连接级错误
     */
    private isConnectionError(err: unknown): boolean {
        const msg = String((err as any)?.message || err || '').toLowerCase();
        return /econnrefused|enotfound|econnreset|epipe|not connected|transport closed|connection.*closed/i.test(msg);
    }
}
