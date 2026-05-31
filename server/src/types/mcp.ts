/**
 * MCP (Model Context Protocol) 类型定义
 * 用于支持用户在 workspace .mcp/ 目录下配置自定义 MCP 工具
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ============================================================
// 用户配置格式（.mcp/*.json 文件内容）
// ============================================================

/** 单个 MCP 服务器的原始配置（来自 .mcp/<name>.json） */
export interface McpServerConfig {
    /** MCP 服务器唯一标识，用于工具名前缀（如 "github" → 工具名 "github__search_repos"） */
    name: string;
    /** 服务描述，注入系统提示词帮助 AI 理解该组工具的用途 */
    description: string;
    /** 传输协议（首期仅支持 stdio） */
    transport: 'stdio';
    /** 启动命令 */
    command: string;
    /** 命令参数 */
    args: string[];
    /** 环境变量，支持 ${ENV_VAR} 占位符引用进程环境变量 */
    env?: Record<string, string>;
    /** 白名单工具：这些工具无需用户确认即可直接执行 */
    autoApprove?: string[];
    /** 工具调用超时（毫秒），默认 30000 */
    timeout?: number;
}

/** .mcp/*.json 文件的顶层结构 */
export interface McpConfigFile {
    mcpServers?: Record<string, {
        command: string;
        args?: string[];
        env?: Record<string, string>;
        description?: string;
        autoApprove?: string[];
        timeout?: number;
    }>;
    // 也支持扁平格式（单服务器单文件）
    name?: string;
    description?: string;
    transport?: 'stdio';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    autoApprove?: string[];
    timeout?: number;
}

// ============================================================
// 运行时状态
// ============================================================

/** MCP 原生工具描述（来自服务器的 tools/list 响应） */
export interface McpNativeTool {
    /** 原生工具名，如 "search_repositories" */
    name: string;
    /** 工具描述 */
    description?: string;
    /** JSON Schema 格式的输入参数定义 */
    inputSchema: {
        type: 'object';
        properties?: Record<string, any>;
        required?: string[];
    };
}

/** MCP 客户端运行时状态 */
export interface McpClientState {
    /** 配置快照 */
    config: McpServerConfig;
    /** MCP SDK Client 实例 */
    client: Client;
    /** 传输层实例 */
    transport: StdioClientTransport;
    /** 连接是否活跃 */
    connected: boolean;
    /** 从服务器获取的工具列表 */
    tools: McpNativeTool[];
    /** 最近一次成功连接的时间戳 */
    lastConnectedAt: number;
    /** 累计连接错误次数（用于熔断） */
    errorCount: number;
    /** 最近一次错误信息 */
    lastError?: string;
}

// ============================================================
// 工具桥接
// ============================================================

/** 桥接后的 Agent 工具名格式：{mcpName}__{nativeToolName}，如 "github__search_repositories" */
export type McpAgentToolName = string;

/** 工具名前缀分隔符 */
export const MCP_TOOL_NAME_SEPARATOR = '__';

/** 从 Agent 工具名解析出 MCP 服务器名和原生工具名 */
export function parseMcpAgentToolName(agentToolName: string): { serverName: string; nativeToolName: string } | null {
    const idx = agentToolName.indexOf(MCP_TOOL_NAME_SEPARATOR);
    if (idx <= 0) return null;
    return {
        serverName: agentToolName.slice(0, idx),
        nativeToolName: agentToolName.slice(idx + MCP_TOOL_NAME_SEPARATOR.length),
    };
}

/** 构建 Agent 工具名 */
export function buildMcpAgentToolName(serverName: string, nativeToolName: string): McpAgentToolName {
    return `${serverName}${MCP_TOOL_NAME_SEPARATOR}${nativeToolName}`;
}

// ============================================================
// 工作区状态
// ============================================================

/** MCP 配置加载结果 */
export interface McpLoadResult {
    /** 成功加载的配置 */
    configs: McpServerConfig[];
    /** 加载/校验失败的配置信息 */
    errors: Array<{ file: string; error: string }>;
}

/** 用于系统提示词的 MCP 工具组摘要 */
export interface McpToolGroupSummary {
    serverName: string;
    description: string;
    connected: boolean;
    toolCount: number;
    tools: Array<{ name: string; description: string }>;
}
