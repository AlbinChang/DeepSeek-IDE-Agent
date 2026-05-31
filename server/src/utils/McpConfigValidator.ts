/**
 * MCP 配置文件格式校验器
 * 校验 .mcp/*.json 文件的结构合法性
 */

import type { McpServerConfig, McpConfigFile } from '@/types/mcp.js';

/** 允许的 transport 类型 */
const VALID_TRANSPORTS = new Set(['stdio']);

/** 配置名合法字符：字母、数字、连字符、下划线 */
const VALID_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface ValidationResult {
    valid: boolean;
    config?: McpServerConfig;
    errors: string[];
}

/**
 * 校验并从原始 JSON 中提取 McpServerConfig
 * 支持两种格式：
 *   1. Claude Code 兼容格式：{ "mcpServers": { "name": { command, args, ... } } }
 *   2. 扁平单服务器格式：{ "name": "...", "command": "...", ... }
 */
export function validateAndExtractConfig(
    raw: unknown,
    fileName: string,
): ValidationResult {
    const errors: string[] = [];

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { valid: false, errors: [`${fileName}: 配置文件必须是 JSON 对象`] };
    }

    const obj = raw as Record<string, unknown>;

    // 格式 1：Claude Code 兼容的 mcpServers 映射
    if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
        const servers = obj.mcpServers as Record<string, unknown>;
        const serverNames = Object.keys(servers);
        if (serverNames.length === 0) {
            return { valid: false, errors: [`${fileName}: mcpServers 为空`] };
        }
        // 只取第一个服务器（每个文件建议只配一个，多个服务器应分文件）
        const name = serverNames[0];
        const serverRaw = servers[name];
        if (!serverRaw || typeof serverRaw !== 'object' || Array.isArray(serverRaw)) {
            return { valid: false, errors: [`${fileName}: mcpServers.${name} 必须是对象`] };
        }
        const server = serverRaw as Record<string, unknown>;

        if (serverNames.length > 1) {
            errors.push(`${fileName}: mcpServers 包含多个服务器（${serverNames.join(', ')}），建议每个 .mcp/*.json 只配置一个服务器；当前仅加载 "${name}"`);
        }

        const description = typeof server.description === 'string' ? server.description : `${name} MCP Server`;
        return buildConfig({
            name,
            description,
            command: server.command,
            args: server.args,
            env: server.env,
            autoApprove: server.autoApprove,
            timeout: server.timeout,
        }, fileName);
    }

    // 格式 2：扁平单服务器格式
    if (typeof obj.name === 'string' && typeof obj.command === 'string') {
        return buildConfig({
            name: obj.name,
            description: typeof obj.description === 'string' ? obj.description : `${obj.name} MCP Server`,
            transport: obj.transport,
            command: obj.command,
            args: obj.args,
            env: obj.env,
            autoApprove: obj.autoApprove,
            timeout: obj.timeout,
        }, fileName);
    }

    return { valid: false, errors: [`${fileName}: 无法识别的配置格式，需要 "name" + "command" 或 "mcpServers" 字段`] };
}

function buildConfig(
    raw: {
        name: unknown;
        description: string;
        transport?: unknown;
        command: unknown;
        args?: unknown;
        env?: unknown;
        autoApprove?: unknown;
        timeout?: unknown;
    },
    fileName: string,
): ValidationResult {
    const errors: string[] = [];

    // name 校验
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) {
        errors.push(`${fileName}: "name" 是必填字段`);
    } else if (!VALID_NAME_PATTERN.test(name)) {
        errors.push(`${fileName}: "name" (${name}) 只能包含字母、数字、连字符和下划线`);
    } else if (name.startsWith('browser')) {
        errors.push(`${fileName}: "name" 不能以 "browser" 开头（与内置浏览器工具冲突）`);
    }

    // transport 校验（默认 stdio）
    const transport = typeof raw.transport === 'string' ? raw.transport : 'stdio';
    if (!VALID_TRANSPORTS.has(transport)) {
        errors.push(`${fileName}: "transport" 必须是 "stdio"，当前值: "${transport}"`);
    }

    // command 校验
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    if (!command) {
        errors.push(`${fileName}: "command" 是必填字段`);
    }

    // args 校验
    let args: string[] = [];
    if (raw.args !== undefined && raw.args !== null) {
        if (Array.isArray(raw.args)) {
            args = raw.args.map((a) => String(a));
        } else {
            errors.push(`${fileName}: "args" 必须是字符串数组`);
        }
    }

    // env 校验
    let env: Record<string, string> | undefined;
    if (raw.env !== undefined && raw.env !== null) {
        if (typeof raw.env === 'object' && !Array.isArray(raw.env)) {
            env = {};
            for (const [k, v] of Object.entries(raw.env as Record<string, unknown>)) {
                env[k] = String(v);
            }
        } else {
            errors.push(`${fileName}: "env" 必须是键值对对象`);
        }
    }

    // autoApprove 校验
    let autoApprove: string[] | undefined;
    if (raw.autoApprove !== undefined && raw.autoApprove !== null) {
        if (Array.isArray(raw.autoApprove)) {
            autoApprove = raw.autoApprove.map((a) => String(a));
        } else {
            errors.push(`${fileName}: "autoApprove" 必须是字符串数组`);
        }
    }

    // timeout 校验
    let timeout: number | undefined;
    if (raw.timeout !== undefined && raw.timeout !== null) {
        const t = Number(raw.timeout);
        if (Number.isFinite(t) && t > 0) {
            timeout = Math.floor(t);
        } else {
            errors.push(`${fileName}: "timeout" 必须是正整数（毫秒）`);
        }
    }

    if (errors.length > 0) {
        return { valid: false, errors };
    }

    return {
        valid: true,
        config: {
            name: name!,
            description: raw.description,
            transport: transport as 'stdio',
            command: command!,
            args,
            env,
            autoApprove,
            timeout,
        },
        errors: [],
    };
}
