import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT, SERVER_ROOT } from '@/utils/PathUtils.js';

interface ServerConf {
    port?: number;
    portRetryLimit?: number;
    host?: string;
}

interface ClientConf {
    devPort?: number;
    staticPort?: number;
    host?: string;
    apiPort?: number;
    wsPort?: number;
    terminalPort?: number;
}

interface TerminalConf {
    port?: number;
    portRetryLimit?: number;
    host?: string;
}

function parsePositiveInt(raw: string | undefined, fallback: number, min: number = 0): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    const normalized = Math.floor(parsed);
    if (normalized < min) return fallback;
    return normalized;
}

function loadServerConf(): ServerConf {
    const confPath = path.join(SERVER_ROOT, 'server_conf.json');
    try {
        if (!fs.existsSync(confPath)) return {};
        const raw = fs.readFileSync(confPath, 'utf-8');
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch {
        return {};
    }
}

function loadClientConf(): ClientConf {
    const confPath = path.join(PROJECT_ROOT, 'client', 'server_conf.json');
    try {
        if (!fs.existsSync(confPath)) return {};
        const raw = fs.readFileSync(confPath, 'utf-8');
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch {
        return {};
    }
}

function loadTerminalConf(): TerminalConf {
    const confPath = path.join(PROJECT_ROOT, 'terminal-server', 'server_conf.json');
    try {
        if (!fs.existsSync(confPath)) return {};
        const raw = fs.readFileSync(confPath, 'utf-8');
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch {
        return {};
    }
}

// 多环境适配：尝试加载不同位置的 .env
const envPathRoot = path.join(PROJECT_ROOT, '.env');
const envPathServer = path.join(SERVER_ROOT, '.env');

if (fs.existsSync(envPathRoot)) {
    dotenv.config({ path: envPathRoot });
} else if (fs.existsSync(envPathServer)) {
    dotenv.config({ path: envPathServer });
} else {
    dotenv.config();
}

const serverConf = loadServerConf();
const clientConf = loadClientConf();
const terminalConf = loadTerminalConf();

/**
 * 全局配置对象
 * 对齐技术规范 第 3.2 节：环境感知与集中配置管理
 */
export const config = {
    // 基础服务配置
    port: Number(serverConf.port) || Number(process.env.PORT) || 3001,
    portRetryLimit: Number(serverConf.portRetryLimit) || parsePositiveInt(process.env.PORT_RETRY_LIMIT, 20, 0),
    host: String(serverConf.host || process.env.HOST || '0.0.0.0'),
    servicePorts: {
        clientDevPort: Number(clientConf.devPort) || Number(clientConf.staticPort) || 5174,
        serverPort: Number(serverConf.port) || Number(process.env.PORT) || 3001,
        terminalPort: Number(terminalConf.port) || Number(clientConf.terminalPort) || 3003,
    },
    workspaceRoot: process.env.WORKSPACE_ROOT || '',
    
    // 日志与调试
    debug: {
        log: process.env.DEBUG_LOG === 'true',
        verbose: process.env.ENABLE_VERBOSE_LOGS === 'true',
    },

    // AI 模型配置 (DeepSeek 优先)
    ai: {
        apiKey: process.env.DEEPSEEK_API_KEY || '',
        baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    },

    // 用户指令记忆配置
    memory: {
        recentInstructionsLimit: parsePositiveInt(process.env.AGENT_RECENT_INSTRUCTIONS_LIMIT, 3, 0),
        recentInstructionsSkip: parsePositiveInt(process.env.AGENT_RECENT_INSTRUCTIONS_SKIP, 1, 0),
        maxStoredInstructions: parsePositiveInt(process.env.AGENT_MAX_STORED_INSTRUCTIONS, 100, 1),
    },

    // Agent 运行参数
    agent: {
        maxTurns: parsePositiveInt(process.env.AGENT_MAX_TURNS, 1000, 1),
        apiRetryLimit: parsePositiveInt(process.env.AGENT_API_RETRY_LIMIT, 3, 0),
        maxHistoryBytes: parsePositiveInt(process.env.AGENT_MAX_HISTORY_BYTES, 1024 * 1024, 1),
        lowWatermarkBytes: parsePositiveInt(process.env.AGENT_LOW_WATERMARK_BYTES, 128 * 1024, 1),
    },

    // read_file 工具限制
    readFile: {
        maxLines: parsePositiveInt(process.env.AGENT_READ_FILE_MAX_LINES, 3000, 1),
        maxFileSizeBytes: parsePositiveInt(process.env.AGENT_READ_FILE_MAX_FILE_SIZE_BYTES, 200 * 1024, 1),
        maxContentBytes: parsePositiveInt(process.env.AGENT_READ_FILE_MAX_CONTENT_BYTES, 200 * 1024, 1),
        longLineThreshold: parsePositiveInt(process.env.AGENT_READ_FILE_LONG_LINE_THRESHOLD, 1000, 1),
    },

    // Git 基础配置
    git: {
        historyLimit: parsePositiveInt(process.env.AGENT_GIT_HISTORY_LIMIT, 50, 1),
    },

    // 工程级规范配置
    rules: {
        maxMainRuleLength: 10000, 
        folderName: '.rules',
        mainFileName: 'rule.md'
    }
};
