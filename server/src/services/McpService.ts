/**
 * McpService — MCP 工具集成核心服务
 *
 * 职责：
 *  - 扫描 workspace .mcp/ 目录，加载并校验 JSON 配置
 *  - 管理 MCP Client 生命周期（连接/重连/熔断/清理）
 *  - 将原生 MCP 工具桥接为 Agent ToolDefinition
 *  - 生成系统提示词片段（注入 buildSystemPrompt）
 *  - 执行 MCP 工具调用并格式化结果
 *
 * 设计参考：
 *  - SkillService 的目录扫描 + 缓存模式
 *  - BrowserAutomationTools 的 MCP Client 管理模式
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolDefinition } from '@/services/ToolManager.js';
import { validateAndExtractConfig } from '@/utils/McpConfigValidator.js';
import { resolveEnvPlaceholders } from '@/utils/McpEnvResolver.js';
import { formatBeijingIso, getBeijingLogTimePrefix } from '@/utils/TimeUtils.js';
import type {
    McpServerConfig,
    McpClientState,
    McpNativeTool,
    McpLoadResult,
    McpToolGroupSummary,
} from '@/types/mcp.js';
import { buildMcpAgentToolName, parseMcpAgentToolName } from '@/types/mcp.js';

const getTS = () => getBeijingLogTimePrefix();

/** .mcp 配置目录名 */
const MCP_CONFIG_DIR = '.mcp';

/** 配置文件扩展名 */
const MCP_CONFIG_EXT = '.json';

/** 最大 MCP 服务器数 */
const MAX_MCP_SERVERS = 20;

/** 默认工具调用超时（ms） */
const DEFAULT_TOOL_TIMEOUT = 30_000;

/** 连接失败熔断阈值（连续失败 N 次后不再重试） */
const CIRCUIT_BREAKER_THRESHOLD = 3;

export class McpService {
    private static instance: McpService;

    /** userId\u0000workspaceRoot → McpClientState[] 映射（用户级别隔离） */
    private sessionClients = new Map<string, McpClientState[]>();

    /** workspaceRoot → 配置缓存（5 秒 TTL，配置在所有用户间共享） */
    private configCache = new Map<string, { configs: McpServerConfig[]; errors: Array<{ file: string; error: string }>; timestamp: number }>();
    private readonly CONFIG_CACHE_TTL = 10_000;

    private constructor() {}

    public static getInstance(): McpService {
        if (!McpService.instance) {
            McpService.instance = new McpService();
        }
        return McpService.instance;
    }

    /** 构建 session 级别的隔离 key */
    private static sessionKey(userId: string, workspaceRoot: string): string {
        return `${userId}\u0000${workspaceRoot}`;
    }

    // ============================================================
    // 配置加载（workspace 级别，用户间共享）
    // ============================================================

    /**
     * 扫描 workspace 的 .mcp/ 目录，解析所有 JSON 配置文件
     * 结果会被缓存（5 秒 TTL）
     */
    async loadWorkspaceMcpConfigs(workspaceRoot: string): Promise<McpLoadResult> {
        const now = Date.now();
        const cached = this.configCache.get(workspaceRoot);
        if (cached && (now - cached.timestamp < this.CONFIG_CACHE_TTL)) {
            return { configs: cached.configs, errors: cached.errors };
        }

        const configs: McpServerConfig[] = [];
        const errors: Array<{ file: string; error: string }> = [];
        const mcpDir = path.join(workspaceRoot, MCP_CONFIG_DIR);

        try {
            const stat = await fs.stat(mcpDir);
            if (!stat.isDirectory()) {
                this.configCache.set(workspaceRoot, { configs, errors, timestamp: now });
                return { configs, errors };
            }

            const entries = await fs.readdir(mcpDir, { withFileTypes: true });
            const jsonFiles = entries
                .filter((e) => e.isFile() && e.name.endsWith(MCP_CONFIG_EXT))
                .sort((a, b) => a.name.localeCompare(b.name))
                .slice(0, MAX_MCP_SERVERS);

            if (entries.length > MAX_MCP_SERVERS) {
                console.warn(`${getTS()} [McpService] .mcp/ contains ${entries.length} config files, only first ${MAX_MCP_SERVERS} loaded.`);
            }

            for (const file of jsonFiles) {
                const filePath = path.join(mcpDir, file.name);
                try {
                    const raw = await fs.readFile(filePath, 'utf-8');
                    let parsed: unknown;
                    try {
                        parsed = JSON.parse(raw);
                    } catch {
                        errors.push({ file: file.name, error: 'JSON 解析失败' });
                        continue;
                    }

                    const result = validateAndExtractConfig(parsed, file.name);
                    if (result.valid && result.config) {
                        // 解析环境变量占位符
                        if (result.config.env) {
                            result.config.env = resolveEnvPlaceholders(result.config.env);
                        }
                        configs.push(result.config);
                        console.log(`${getTS()} [McpService] Loaded MCP config: ${result.config.name} (${file.name})`);
                    }
                    if (result.errors.length > 0) {
                        for (const err of result.errors) {
                            errors.push({ file: file.name, error: err });
                        }
                    }
                } catch (err: any) {
                    errors.push({ file: file.name, error: `读取失败: ${err.message || err}` });
                }
            }
        } catch (err: any) {
            if (err.code !== 'ENOENT') {
                console.warn(`${getTS()} [McpService] Failed to read .mcp/ directory: ${err.message || err}`);
            }
            // .mcp/ 目录不存在是正常情况，不算错误
        }

        this.configCache.set(workspaceRoot, { configs, errors, timestamp: now });
        console.log(`${getTS()} [McpService] Loaded ${configs.length} MCP configs from ${workspaceRoot}/${MCP_CONFIG_DIR}/ (${errors.length} errors)`);
        return { configs, errors };
    }

    /**
     * 获取已缓存的配置（不扫描文件系统）
     */
    getCachedConfigs(workspaceRoot: string): McpServerConfig[] {
        return this.configCache.get(workspaceRoot)?.configs ?? [];
    }

    // ============================================================
    // 生命周期管理（session 级别，userId 隔离）
    // ============================================================

    /**
     * 为指定用户+workspace 连接所有 MCP 服务器
     * 应在 workspace 初始化 / 切换时调用
     */
    async connectAll(userId: string, workspaceRoot: string): Promise<void> {
        const { configs } = await this.loadWorkspaceMcpConfigs(workspaceRoot);

        // 先断开该用户的旧连接
        await this.disconnectAll(userId, workspaceRoot);

        if (configs.length === 0) return;

        const states: McpClientState[] = [];
        for (const config of configs) {
            const state = await this.connectOne(config);
            states.push(state);
        }
        this.sessionClients.set(McpService.sessionKey(userId, workspaceRoot), states);

        const connectedCount = states.filter((s) => s.connected).length;
        console.log(`${getTS()} [McpService] Connected ${connectedCount}/${states.length} MCP servers for user ${userId} @ ${workspaceRoot}`);
    }

    /**
     * 连接单个 MCP 服务器
     */
    private async connectOne(config: McpServerConfig): Promise<McpClientState> {
        const startedAt = Date.now();
        console.log(`${getTS()} [McpService] Connecting MCP server "${config.name}" (${config.command} ${config.args?.join(' ')})...`);

        const state: McpClientState = {
            config,
            client: null as any,
            transport: null as any,
            connected: false,
            tools: [],
            lastConnectedAt: 0,
            errorCount: 0,
        };

        try {
            const transport = new StdioClientTransport({
                command: config.command,
                args: config.args,
                env: config.env as Record<string, string> | undefined,
            });

            const client = new Client(
                { name: `deepseek-ide-agent__${config.name}`, version: '1.0.0' },
                { capabilities: {} },
            );

            await client.connect(transport);

            // 获取工具列表
            const toolsResult = await client.listTools();
            const tools: McpNativeTool[] = (toolsResult?.tools || []).map((t: any) => ({
                name: String(t.name || ''),
                description: typeof t.description === 'string' ? t.description : undefined,
                inputSchema: {
                    type: 'object' as const,
                    properties: (t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema))
                        ? (t.inputSchema.properties as Record<string, any> || {})
                        : {},
                    required: Array.isArray(t.inputSchema?.required) ? t.inputSchema.required : [],
                },
            }));

            state.client = client;
            state.transport = transport;
            state.connected = true;
            state.tools = tools;
            state.lastConnectedAt = startedAt;
            state.errorCount = 0;

            const duration = Date.now() - startedAt;
            console.log(`${getTS()} [McpService] ✅ Connected "${config.name}" (${tools.length} tools, ${duration}ms)`);
        } catch (err: any) {
            state.connected = false;
            state.errorCount = 1;
            state.lastError = String(err?.message || err);
            console.error(`${getTS()} [McpService] ❌ Failed to connect "${config.name}": ${state.lastError}`);

            // 尝试清理
            try { await state.transport?.close(); } catch {}
            try { await state.client?.close(); } catch {}
        }

        return state;
    }

    /**
     * 断开指定用户+workspace 的所有 MCP 连接
     */
    async disconnectAll(userId: string, workspaceRoot: string): Promise<void> {
        const key = McpService.sessionKey(userId, workspaceRoot);
        const states = this.sessionClients.get(key);
        if (!states || states.length === 0) return;

        console.log(`${getTS()} [McpService] Disconnecting ${states.length} MCP servers for user ${userId} @ ${workspaceRoot}`);
        for (const state of states) {
            try { await state.transport?.close(); } catch {}
            try { await state.client?.close(); } catch {}
        }
        this.sessionClients.delete(key);
    }

    /**
     * 获取指定用户+workspace 的 MCP 客户端状态
     */
    private getClientStates(userId: string, workspaceRoot: string): McpClientState[] {
        return this.sessionClients.get(McpService.sessionKey(userId, workspaceRoot)) || [];
    }

    /**
     * 根据服务器名查找客户端状态
     */
    private findClientState(userId: string, workspaceRoot: string, serverName: string): McpClientState | undefined {
        return this.getClientStates(userId, workspaceRoot).find((s) => s.config.name === serverName);
    }

    // ============================================================
    // 工具桥接
    // ============================================================

    /**
     * 生成所有 MCP 桥接工具的 ToolDefinition（供 ToolManager.registerTool 使用）
     */
    getBridgeToolDefinitions(userId: string, workspaceRoot: string): ToolDefinition[] {
        const states = this.getClientStates(userId, workspaceRoot);
        const definitions: ToolDefinition[] = [];

        for (const state of states) {
            if (!state.connected) continue;

            for (const nativeTool of state.tools) {
                const agentName = buildMcpAgentToolName(state.config.name, nativeTool.name);
                const description = this.buildToolDescription(state.config, nativeTool);

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
                        return await this.executeMcpTool(agentName, params, resolvedUserId, wsRoot);
                    },
                });
            }
        }

        console.log(`${getTS()} [McpService] Built ${definitions.length} MCP bridge tool definitions`);
        return definitions;
    }

    /**
     * 生成 MCP 工具的 OpenAI function-calling 元数据
     */
    getMcpToolsMetadata(userId: string, workspaceRoot: string): Array<{ type: 'function'; function: { name: string; description: string; parameters: any } }> {
        const states = this.getClientStates(userId, workspaceRoot);
        const metadata: Array<{ type: 'function'; function: { name: string; description: string; parameters: any } }> = [];

        for (const state of states) {
            if (!state.connected) continue;

            for (const nativeTool of state.tools) {
                const agentName = buildMcpAgentToolName(state.config.name, nativeTool.name);
                const description = this.buildToolDescription(state.config, nativeTool);

                metadata.push({
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
                });
            }
        }

        return metadata;
    }

    /**
     * 构建桥接工具的描述文本
     */
    private buildToolDescription(config: McpServerConfig, nativeTool: McpNativeTool): string {
        const parts: string[] = [];
        parts.push(`[MCP:${config.name}] ${nativeTool.description || nativeTool.name}`);
        parts.push(`(来自用户配置的 ${config.name} MCP 服务器)`);
        if (config.description && config.description !== config.name) {
            parts.push(`服务器描述: ${config.description}`);
        }
        return parts.join(' ');
    }

    // ============================================================
    // 工具执行
    // ============================================================

    /**
     * 执行 MCP 工具调用
     */
    async executeMcpTool(
        agentToolName: string,
        params: Record<string, unknown>,
        userId: string,
        workspaceRoot: string,
    ): Promise<any> {
        const parsed = parseMcpAgentToolName(agentToolName);
        if (!parsed) {
            return { status: 'error', message: `无效的 MCP 工具名: ${agentToolName}` };
        }

        const { serverName, nativeToolName } = parsed;
        const state = this.findClientState(userId, workspaceRoot, serverName);

        if (!state) {
            return { status: 'error', message: `MCP 服务器 "${serverName}" 未找到或未连接` };
        }

        if (!state.connected) {
            // 尝试重连
            if (state.errorCount < CIRCUIT_BREAKER_THRESHOLD) {
                console.log(`${getTS()} [McpService] Attempting reconnect for "${serverName}"...`);
                const newState = await this.connectOne(state.config);
                // 替换旧状态
                const key = McpService.sessionKey(userId, workspaceRoot);
                const states = this.sessionClients.get(key) || [];
                const idx = states.findIndex((s) => s.config.name === serverName);
                if (idx >= 0) states[idx] = newState;

                if (newState.connected) {
                    return await this.executeMcpTool(agentToolName, params, userId, workspaceRoot);
                }
            }
            return { status: 'error', message: `MCP 服务器 "${serverName}" 未连接（${state.lastError || '未知原因'}）` };
        }

        const timeout = state.config.timeout || DEFAULT_TOOL_TIMEOUT;
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
            console.log(`${getTS()} [McpService] ✅ ${agentToolName} (${duration}ms)`);

            return this.formatMcpResult(result);
        } catch (err: any) {
            const duration = Date.now() - startedAt;
            state.errorCount += 1;
            state.lastError = String(err?.message || err);
            console.error(`${getTS()} [McpService] ❌ ${agentToolName} failed (${duration}ms): ${state.lastError}`);

            // 检查是否是连接级别的错误
            if (this.isConnectionError(err)) {
                state.connected = false;
            }

            return {
                status: 'error',
                message: `MCP 工具 "${nativeToolName}" 执行失败: ${state.lastError}`,
                toolName: agentToolName,
                durationMs: duration,
            };
        }
    }

    /**
     * 格式化 MCP 工具返回结果
     */
    private formatMcpResult(raw: any): any {
        if (!raw || typeof raw !== 'object') {
            return { status: 'success', content: [{ type: 'text', text: String(raw) }] };
        }

        // MCP 标准响应格式: { content: [{ type: "text", text: "..." }, ...] }
        if (raw.content && Array.isArray(raw.content)) {
            const textParts: string[] = [];
            for (const item of raw.content) {
                if (item.type === 'text' && typeof item.text === 'string') {
                    textParts.push(item.text);
                }
            }
            return {
                status: 'success',
                content: raw.content,
                text: textParts.join('\n'),
                isError: Boolean(raw.isError),
            };
        }

        return { status: 'success', ...raw };
    }

    // ============================================================
    // 系统提示词生成
    // ============================================================

    /**
     * 生成 MCP 工具的系统提示词片段
     * 注入到 buildSystemPrompt 的 DYNAMIC SUFFIX 区域
     */
    buildMcpSystemPrompt(userId: string, workspaceRoot: string): string {
        const states = this.getClientStates(userId, workspaceRoot);
        const connected = states.filter((s) => s.connected);
        const disconnected = states.filter((s) => !s.connected);

        if (states.length === 0) return '';

        const lines: string[] = [
            '### 用户配置的 MCP 工具 (USER-CONFIGURED MCP TOOLS)',
            `检测到工作区 \`.mcp/\` 目录下配置了 ${states.length} 个 MCP 服务器（${connected.length} 个已连接，${disconnected.length} 个未连接）。`,
            '',
            '**工具命名规则**：MCP 工具名格式为 `{服务器名}__{原生工具名}`（双下划线分隔）。例如 `github__search_repositories`。',
            '**调用方式**：与内置工具完全相同，直接通过工具名调用即可，系统会自动路由到对应的 MCP 服务器。',
            '',
        ];

        // 已连接服务器及其工具
        for (const state of connected) {
            lines.push(`#### ${state.config.name} (✅ 已连接)`);
            if (state.config.description) {
                lines.push(`> ${state.config.description}`);
            }
            lines.push(`共 ${state.tools.length} 个工具：`);
            for (const tool of state.tools) {
                const agentName = buildMcpAgentToolName(state.config.name, tool.name);
                const desc = tool.description || '(无描述)';
                lines.push(`- **\`${agentName}\`**: ${desc}`);
            }
            lines.push('');
        }

        // 未连接服务器
        for (const state of disconnected) {
            lines.push(`#### ${state.config.name} (❌ 未连接 — ${state.lastError || '未知错误'})`);
            lines.push(`> 该 MCP 服务器的工具当前不可用，请检查配置。`);
            lines.push('');
        }

        lines.push('**注意事项**：');
        lines.push('- MCP 工具由用户配置，其行为由外部 MCP 服务器决定；若工具返回错误，检查对应的 MCP 服务器是否正常运行。');
        lines.push('- 每个 MCP 工具名都以服务器名前缀开头，避免与内置工具冲突。');
        lines.push('- 不确定某个 MCP 工具的参数时，可通过工具名推断其用途，或尝试以合理参数调用。');

        return lines.join('\n');
    }

    /**
     * 获取 MCP 工具组摘要（用于其他上下文）
     */
    getToolGroupSummaries(userId: string, workspaceRoot: string): McpToolGroupSummary[] {
        const states = this.getClientStates(userId, workspaceRoot);
        return states.map((state) => ({
            serverName: state.config.name,
            description: state.config.description,
            connected: state.connected,
            toolCount: state.tools.length,
            tools: state.tools.map((t) => ({
                name: buildMcpAgentToolName(state.config.name, t.name),
                description: t.description || '(无描述)',
            })),
        }));
    }

    // ============================================================
    // 辅助方法
    // ============================================================

    /**
     * 带超时的 Promise
     */
    private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`MCP tool call timed out after ${timeoutMs}ms`));
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
    private isConnectionError(err: any): boolean {
        const msg = String(err?.message || err || '').toLowerCase();
        return /econnrefused|enotfound|econnreset|epipe|not connected|transport closed|connection.*closed/i.test(msg);
    }
}
