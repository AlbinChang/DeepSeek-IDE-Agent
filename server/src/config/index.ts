import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import os from 'os';
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

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
    if (raw === undefined) return fallback;
    const normalized = raw.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function defaultWorkflowMaxWorkers(): number {
    const cpuCount = os.cpus()?.length || 1;
    return Math.max(1, Math.min(4, cpuCount - 1));
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
    return {
        port: parsePositiveInt(process.env.TERMINAL_PORT, 3003, 1),
    };
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
        // user_instructs.json 最多保留的指令条数（默认 20；MemoryService 另有 20 条硬上限，只能调低）
        maxStoredInstructions: parsePositiveInt(process.env.AGENT_MAX_STORED_INSTRUCTIONS, 20, 1),
    },

    // Agent 运行参数
    agent: {
        // 网络层错误重试次数（DNS/连接/流中断等）
        apiRetryLimit: parsePositiveInt(process.env.AGENT_API_RETRY_LIMIT, 3, 0),
        // 服务过载类错误重试次数（HTTP 408/429/500/502/503/504，如 DeepSeek 503 Service is too busy）
        apiServiceBusyRetryLimit: parsePositiveInt(process.env.AGENT_API_SERVICE_BUSY_RETRY_LIMIT, 100, 0),
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

    // 工程级规范配置（按顺序探测，命中首个存在主文件的目录）
    rules: {
        maxMainRuleLength: 10000,
        sources: [
            { directory: '.rules', mainFileName: 'rule.md', discoverSiblingRules: false },
            { directory: '.lingma/rules', mainFileName: 'project_rule.md', discoverSiblingRules: true },
        ]
    },

    // 声明式 Workflow 编排（.workflow 目录）
    workflow: {
        // 总开关；关闭后 workflow:run/cancel/resume 直接拒绝，只读接口仍可用
        enabled: parseBoolean(process.env.WORKFLOW_ENABLED, true),
        // utilityProcess Worker 池大小
        maxWorkers: parsePositiveInt(process.env.WORKFLOW_MAX_WORKERS, defaultWorkflowMaxWorkers(), 1),
        // 排队 run 上限，超过后拒绝新 run
        maxQueueSize: parsePositiveInt(process.env.WORKFLOW_MAX_QUEUE_SIZE, 20, 1),
        // 同一 workflow 的并发 run 上限（写型流程建议保持 1）
        maxConcurrentRunsPerWorkflow: parsePositiveInt(process.env.WORKFLOW_MAX_CONCURRENT_RUNS_PER_WORKFLOW, 1, 1),
        // 单次 run 最大执行时长（默认 2 小时）
        maxRunDurationMs: parsePositiveInt(process.env.WORKFLOW_MAX_RUN_DURATION_MS, 2 * 60 * 60 * 1000, 1000),
        // Worker 堆上限（MB），通过 --js-flags=--max-old-space-size 传入
        workerHeapMB: parsePositiveInt(process.env.WORKFLOW_WORKER_HEAP_MB, 512, 128),
        // 心跳与超时
        heartbeatIntervalMs: parsePositiveInt(process.env.WORKFLOW_HEARTBEAT_INTERVAL_MS, 5000, 500),
        heartbeatTimeoutMs: parsePositiveInt(process.env.WORKFLOW_HEARTBEAT_TIMEOUT_MS, 30000, 1000),
        // Worker 启动就绪超时 / 取消后强制回收宽限期
        workerReadyTimeoutMs: parsePositiveInt(process.env.WORKFLOW_WORKER_READY_TIMEOUT_MS, 15000, 1000),
        cancelGraceMs: parsePositiveInt(process.env.WORKFLOW_CANCEL_GRACE_MS, 8000, 200),
        // Worker 复用与崩溃重启策略
        maxRunsPerWorker: parsePositiveInt(process.env.WORKFLOW_MAX_RUNS_PER_WORKER, 20, 1),
        maxWorkerRestarts: parsePositiveInt(process.env.WORKFLOW_MAX_WORKER_RESTARTS, 3, 0),
        workerRestartWindowMs: parsePositiveInt(process.env.WORKFLOW_WORKER_RESTART_WINDOW_MS, 5 * 60 * 1000, 1000),
        // 运行记录保留数量与单 run 预算
        maxStoredRuns: parsePositiveInt(process.env.WORKFLOW_MAX_STORED_RUNS, 50, 1),
        maxSteps: parsePositiveInt(process.env.WORKFLOW_MAX_STEPS, 200, 1),
        maxStepOutputChars: parsePositiveInt(process.env.WORKFLOW_MAX_STEP_OUTPUT_CHARS, 64 * 1024, 1024),
        defaultStepTimeoutMs: parsePositiveInt(process.env.WORKFLOW_DEFAULT_STEP_TIMEOUT_MS, 10 * 60 * 1000, 1000),
        agentStepMaxTurns: parsePositiveInt(process.env.WORKFLOW_AGENT_STEP_MAX_TURNS, 12, 1),
    }
};
