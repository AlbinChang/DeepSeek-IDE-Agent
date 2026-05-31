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

/** 判断是否为 Playwright 桥接工具 */
export function isPlaywrightBridgeTool(toolName: string): boolean {
    return toolName.startsWith(`${PLAYWRIGHT_MCP_PREFIX}${TOOL_NAME_SEPARATOR}`);
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
            const transport = new StdioClientTransport({
                command: process.execPath,
                args: cliArgs,
                cwd: workspaceRoot,
                env: process.env as Record<string, string>,
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

        return state.tools.map((nativeTool) => {
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
    }

    /**
     * 构建桥接工具的描述文本
     */
    private buildToolDescription(nativeTool: PlaywrightNativeTool): string {
        const parts: string[] = [];
        parts.push(`[Playwright MCP] ${nativeTool.description || nativeTool.name}`);
        parts.push('(浏览器自动化原生工具，由 Playwright MCP 服务器提供)');
        return parts.join(' ');
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
     * 格式化 MCP 工具返回结果
     */
    private formatResult(raw: unknown): unknown {
        if (!raw || typeof raw !== 'object') {
            return { status: 'success', content: [{ type: 'text', text: String(raw) }] };
        }

        const result = raw as Record<string, unknown>;

        // MCP 标准响应格式: { content: [{ type: "text", text: "..." }, ...] }
        if (result.content && Array.isArray(result.content)) {
            const textParts: string[] = [];
            for (const item of result.content as Array<Record<string, unknown>>) {
                if (item.type === 'text' && typeof item.text === 'string') {
                    textParts.push(item.text);
                }
            }
            return {
                status: 'success',
                content: result.content,
                text: textParts.join('\n'),
                isError: Boolean(result.isError),
            };
        }

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
            '### 浏览器自动化工具 (BROWSER AUTOMATION VIA PLAYWRIGHT MCP)',
            `✅ Playwright MCP 已连接，共 ${state.tools.length} 个浏览器自动化工具可用。`,
            '',
            '**工具命名规则**：所有 Playwright 工具以 `playwright__` 为前缀，后接原生工具名。',
            '例如：`playwright__browser_navigate`、`playwright__browser_snapshot`、`playwright__browser_evaluate`。',
            '',
            '**调用方式**：与内置工具完全相同，直接通过工具名调用即可。Playwright MCP 自动管理浏览器会话，无需手动 open/close。',
            '',
            '**可用工具列表**：',
        ];

        for (const tool of state.tools) {
            const agentName = buildPlaywrightToolName(tool.name);
            const desc = tool.description || '(无描述)';
            lines.push(`- **\`${agentName}\`**: ${desc}`);
        }

        lines.push('');
        lines.push('**使用策略**：');
        lines.push('- 优先使用 `playwright__browser_snapshot` 获取页面可访问性快照，了解页面结构。');
        lines.push('- 使用 `playwright__browser_evaluate` 进行定向数据抽取（返回 JavaScript 表达式结果）。');
        lines.push('- 使用 `playwright__browser_take_screenshot` 仅用于视觉留存，不用于数据采集。');
        lines.push('- 交互前先获取最新快照确认元素引用（ref）仍然有效。');
        lines.push('');
        lines.push('**本地文件预览 (LOCAL HTML FILE PREVIEW)**：');
        lines.push('- ✅ 支持通过 `file://` 协议打开本地 HTML 文件进行预览（已启用 `--allow-unrestricted-file-access`）。');
        lines.push('- 使用 `playwright__browser_navigate` 导航到本地文件，格式为 `file:///盘符:/路径/文件.html`（Windows）或 `file:///路径/文件.html`（Unix）。');
        lines.push('- 示例：`playwright__browser_navigate` 参数 `{ "url": "file:///D:/project/dist/index.html" }`');
        lines.push('- 导航到 `file://` 页面后，页面内引用的相对路径资源（CSS/JS/图片）可正常加载。');
        lines.push('- 如果页面需要从本地 HTTP 服务器加载（如 webpack-dev-server、vite），先确保开发服务器已启动，再用 `http://localhost:端口` 导航。');
        lines.push('');
        lines.push('**⚠️ 浏览器清理强制规则 (MANDATORY BROWSER CLEANUP)**：');
        lines.push('- **任务完成时必须关闭浏览器**：在确认所有任务完成、准备输出最终答复之前，必须调用 `playwright__browser_close` 关闭浏览器。');
        lines.push('- **不再需要浏览器时立即关闭**：一旦完成网页数据采集、截图或交互操作，无需继续使用浏览器时，应立即调用 `playwright__browser_close` 释放资源。');
        lines.push('- **禁止保持浏览器打开**：不要在任务完成后保持浏览器会话打开。浏览器会话消耗系统资源，必须在不需要时显式关闭。');
        lines.push('- **关闭标签页**：如果只需要关闭当前标签页而非整个浏览器，可使用 `playwright__browser_tabs`（参数 `{ "action": "close" }`）关闭当前活跃标签页。');
        lines.push('- **关闭前确认**：在调用 `playwright__browser_close` 之前，确保已提取并保存所有需要的数据（截图、文本内容等），关闭后浏览器状态将不可恢复。');

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
