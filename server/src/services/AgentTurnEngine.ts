/**
 * AgentTurnEngine — 可复用的 Agent 对话轮次执行引擎
 *
 * 封装单次"用户指令 → AI 调用（流式）→ 工具执行 → 循环"的核心逻辑，
 * 供 AgentChatComponent 及其他 Agent 复用。
 *
 * 职责范围：
 *  - 流式调用 AI API，收集 text / reasoning / tool_calls
 *  - 可重试错误自动重试（指数退避 + 抖动）：网络层按 AGENT_API_RETRY_LIMIT（默认 3 次），
 *    服务限流 HTTP 429 按 AGENT_API_RATE_LIMIT_RETRY_LIMIT（默认 10 次），
 *    服务过载 HTTP 408/409/425/5xx 按 AGENT_API_SERVICE_BUSY_RETRY_LIMIT（默认 100 次）；
 *    累计限流超过阈值时自动把上下文压缩到低水位，避免上下文过长导致持续限流
 *  - 按顺序执行工具调用，将结果推入 activeHistory
 *  - 每轮调用后执行 prepareMessages 整理上下文
 *  - 向前端 emit 事件（text / reasoning / annotation / stage / error）
 *  - Telemetry 记录（每轮 token 用量与耗时）
 *  - 最终回答后调用 agentService.updateSessionHistory 持久化
 *
 * 不负责：
 *  - 外层 TODO 循环 / 目标达成判断（由调用方 AgentChatComponent 处理）
 *  - 系统提示词构建（由调用方提供 prepareMessages 函数）
 *  - AbortSignal 以外的并发/会话管理
 */

import * as path from "path";
import type { ToolExecutionContext, ToolManager } from "@/services/ToolManager.js";
import { AIProviderFactory } from "@/services/AIProviderFactory.js";
import type { ModelProviderConfig } from "@/services/SettingsService.js";
import { TodoService } from "@/services/TodoService.js";
import { TelemetryService } from "@/services/TelemetryService.js";
import { config as globalConfig } from "@/config/index.js";
import { getBeijingLogTimePrefix } from "@/utils/TimeUtils.js";
import { classifyRetryableError, computeRetryDelayMs } from "@/utils/ApiRetryUtils.js";
import { sanitizeJsonStrings, sanitizeLoneSurrogates } from "@/utils/UnicodeUtils.js";
import { estimateMessagesJsonBytes } from "@/services/MessagePreparationService.js";
import { accumulateTokenUsage, normalizeTokenUsage, type TokenUsage } from "@/utils/TokenUsage.js";
import {
    LLMRequestJournal,
    type AgentStage,
    type LLMRequestRecord,
    type LLMRequestRecoveryContext,
} from "@/services/LLMRequestJournal.js";
import { LLMResponseLog } from "@/services/LLMResponseLog.js";
import { extractReasoningText } from "../utils/ReasoningUtils.js";
import {
    buildCorruptionMessage,
    detectRepeatedControlToken,
    findControlToken,
    isModelMismatch,
    ModelOutputCorruptionError,
    ModelSubstitutionError,
    probeLeadingContent,
    type ControlTokenHit,
    type CorruptionPhase,
    type ModelOutputDiagnostics,
} from "@/services/ModelOutputGuard.js";

const getTS = () => getBeijingLogTimePrefix();

/** 首段正文至少攒够这么多字符再判定是否泄漏控制标记，避免把控制标记拆包后漏检。 */
const PREFIX_PROBE_CHARS = 32;

/**
 * 工具参数增量检测的尾部重叠字符数：控制标记可能被拆到多个 delta 中，
 * 检测时把已累积内容的尾部与本次增量拼接后再扫描。
 */
const TOOL_ARGUMENT_SCAN_OVERLAP_CHARS = 48;

/** 丢弃被替换模型的回复后，重新请求前的短暂等待，避免连续冲撞网关。 */
const SUBSTITUTION_RETRY_DELAY_MS = 300;

/**
 * 直接重试预算耗尽后，注入纠正指令再重试的轮数。
 * 相同的请求容易被同一故障后端重复复现，改变请求内容（追加纠正指令）能提高恢复概率。
 */
const CORRUPTION_RECOVERY_ROUNDS = 1;

/** 模型输出异常重试的退避基数（毫秒），随重试次数线性放大。 */
const CORRUPTION_RETRY_BASE_DELAY_MS = 600;

function resolveHost(baseURL?: string): string | undefined {
    if (!baseURL) return undefined;
    try {
        return new URL(baseURL).host;
    } catch {
        return undefined;
    }
}

function formatByteSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}

/** 毫秒转「x分y秒」，用于重试进度与墙钟预算提示。 */
function formatDurationMs(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
}

/** 把异常整理成可写入 .llm_response 的纯数据（避免 Error 实例序列化后丢字段）。 */
function describeErrorForLog(error: any) {
    if (!error) return undefined;
    const verdict = classifyRetryableError(error);
    return {
        name: typeof error?.name === "string" ? error.name : undefined,
        message: String(error?.message ?? error),
        code: error?.code ?? error?.cause?.code,
        status: verdict.status,
        category: verdict.category,
        retryable: verdict.retryable,
        stack: typeof error?.stack === "string"
            ? error.stack.split("\n").slice(0, 5).join("\n")
            : undefined,
    };
}

/**
 * 最大流式重试次数（网络超时 / 连接错误 / DNS 失败等）。
 * 从 globalConfig.agent.apiRetryLimit 读取（可通过环境变量 AGENT_API_RETRY_LIMIT 覆盖，默认 3 次）。
 */
const RETRY_LIMIT = globalConfig.agent.apiRetryLimit;
/**
 * 服务过载类错误（HTTP 408/409/425/500/502/503/504，如 DeepSeek 的「503 Service is too busy」）
 * 的最大重试次数。可通过环境变量 AGENT_API_SERVICE_BUSY_RETRY_LIMIT 覆盖，默认 100 次。
 */
const SERVICE_BUSY_RETRY_LIMIT = globalConfig.agent.apiServiceBusyRetryLimit;
/**
 * 服务限流（HTTP 429）的最大重试次数。可通过 AGENT_API_RATE_LIMIT_RETRY_LIMIT 覆盖，默认 10 次。
 * 429 往往由并发或请求体积触发，盲目重试上百次只会让任务长时间卡死；
 * 累计限流超过阈值时会先压缩上下文再继续。
 */
const RATE_LIMIT_RETRY_LIMIT = globalConfig.agent.apiRateLimitRetryLimit;
/** 累计限流超过该次数后，提前把上下文压缩到低水位（AGENT_RATE_LIMIT_COMPACT_THRESHOLD，默认 3）。 */
const RATE_LIMIT_COMPACT_THRESHOLD = globalConfig.agent.rateLimitCompactThreshold;
/**
 * 连续重试的墙钟预算（AGENT_API_RETRY_MAX_ELAPSED_MS，默认 10 分钟；0 = 不限制）。
 * 限流/过载重试预算高达上百次且退避上限 30s，只靠次数限制会让一次对话卡死几十分钟，
 * 这里额外按实际耗时兜底，超时后如实报错交还给用户重试。
 */
const RETRY_MAX_ELAPSED_MS = globalConfig.agent.apiRetryMaxElapsedMs;
/** 单轮内允许的总重试次数上限（三类预算中最大者），具体次数在 catch 分支内按分类决定 */
const MAX_ALLOWED_RETRIES = Math.max(RETRY_LIMIT, SERVICE_BUSY_RETRY_LIMIT, RATE_LIMIT_RETRY_LIMIT);
/** turn 事件 ID 的步长：必须大于单轮最大重试次数，否则相邻轮次的 ID 会重叠导致前端串流。 */
const TURN_ID_STRIDE = MAX_ALLOWED_RETRIES + 1;
const CLIENT_INLINE_STRING_LIMIT = 1200;
const CLIENT_MAX_ARRAY_ITEMS = 80;
const CLIENT_MAX_OBJECT_KEYS = 80;
const CLIENT_VISIBLE_REASONING_LIMIT = 60_000;
const CLIENT_VISIBLE_CONTENT_LIMIT = 120_000;

type ClientRedactionMeta = {
    redacted: boolean;
    redactedStringChars: number;
    truncatedItems: number;
    truncatedKeys: number;
    totalContentChars?: number;
    fileCount?: number;
};

function hiddenTextSummary(chars: number, reason: string) {
    return {
        hidden: true,
        chars,
        reason,
        note: "内容已在前端隐藏，仅保留字符计数以避免页面内存溢出。",
    };
}

function createRedactionMeta(): ClientRedactionMeta {
    return {
        redacted: false,
        redactedStringChars: 0,
        truncatedItems: 0,
        truncatedKeys: 0,
    };
}

function sanitizeValueForClient(value: any, meta: ClientRedactionMeta, depth: number = 0): any {
    if (typeof value === "string") {
        if (value.length > CLIENT_INLINE_STRING_LIMIT) {
            meta.redacted = true;
            meta.redactedStringChars += value.length;
            return hiddenTextSummary(value.length, "large_string");
        }
        return value;
    }

    if (value === null || value === undefined || typeof value !== "object") return value;

    if (depth >= 6) {
        meta.redacted = true;
        return { hidden: true, reason: "max_depth" };
    }

    if (Array.isArray(value)) {
        const visible = value.slice(0, CLIENT_MAX_ARRAY_ITEMS).map((item) => sanitizeValueForClient(item, meta, depth + 1));
        if (value.length > CLIENT_MAX_ARRAY_ITEMS) {
            meta.redacted = true;
            meta.truncatedItems += value.length - CLIENT_MAX_ARRAY_ITEMS;
            visible.push({ hidden: true, omittedItems: value.length - CLIENT_MAX_ARRAY_ITEMS, reason: "array_too_large" });
        }
        return visible;
    }

    const entries = Object.entries(value);
    const next: Record<string, any> = {};
    for (const [key, entryValue] of entries.slice(0, CLIENT_MAX_OBJECT_KEYS)) {
        next[key] = sanitizeValueForClient(entryValue, meta, depth + 1);
    }
    if (entries.length > CLIENT_MAX_OBJECT_KEYS) {
        meta.redacted = true;
        meta.truncatedKeys += entries.length - CLIENT_MAX_OBJECT_KEYS;
        next.__omittedKeys = entries.length - CLIENT_MAX_OBJECT_KEYS;
    }
    return next;
}

function sanitizeWriteToolArgsForClient(toolName: string, args: any, meta: ClientRedactionMeta): any | null {
    if (!args || typeof args !== "object") return null;

    if (toolName === "write_file") {
        const contentChars = typeof args.content === "string" ? args.content.length : 0;
        if (contentChars > 0) {
            meta.redacted = true;
            meta.redactedStringChars += contentChars;
            meta.totalContentChars = contentChars;
        }

        return sanitizeValueForClient({
            ...args,
            content: hiddenTextSummary(contentChars, "file_content"),
        }, meta);
    }

    if (toolName === "replace_in_file") {
        const oldTextChars = typeof args.oldText === "string" ? args.oldText.length : 0;
        const newTextChars = typeof args.newText === "string" ? args.newText.length : 0;
        const totalContentChars = oldTextChars + newTextChars;
        if (totalContentChars > 0) {
            meta.redacted = true;
            meta.redactedStringChars += totalContentChars;
            meta.totalContentChars = totalContentChars;
        }

        return sanitizeValueForClient({
            ...args,
            oldText: oldTextChars > 0 ? hiddenTextSummary(oldTextChars, "old_text") : args.oldText,
            newText: newTextChars > 0 ? hiddenTextSummary(newTextChars, "new_text") : args.newText,
        }, meta);
    }

    if (toolName === "insert_in_file") {
        const newTextChars = typeof args.newText === "string" ? args.newText.length : 0;
        if (newTextChars > 0) {
            meta.redacted = true;
            meta.redactedStringChars += newTextChars;
            meta.totalContentChars = newTextChars;
        }

        return sanitizeValueForClient({
            ...args,
            newText: newTextChars > 0 ? hiddenTextSummary(newTextChars, "new_text") : args.newText,
        }, meta);
    }



    return null;
}

function buildClientToolCallParams(toolCallId: string, toolName: string, parsedArgs: any) {
    const meta = createRedactionMeta();
    const writeToolArgs = sanitizeWriteToolArgsForClient(toolName, parsedArgs, meta);
    const args = writeToolArgs ?? sanitizeValueForClient(parsedArgs, meta);
    return {
        toolCallId,
        toolName,
        args,
        argsMeta: meta,
    };
}

function streamTruncationNotice(label: string, totalChars: number) {
    return `\n\n[${label}过长，前端已停止追加显示；后续仅保留实时字符计数以避免页面内存溢出。当前已接收 ${totalChars.toLocaleString("zh-CN")} 字符。]\n`;
}

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * AgentTurnEngine 所需的最小宿主能力。
 * AgentService 结构上满足该接口，因此现有调用方无需改动。
 */
export interface AgentTurnHost {
    toolManager: Pick<ToolManager, "executeTool">;
    updateSessionHistory?(userId: string, history: any[], workspaceRoot?: string): void;
}

export interface PrepareMessagesOptions {
    /** 强制裁剪到低水位（累计限流后的提前压缩）。 */
    forceCompact?: boolean;
}

export type PrepareMessages = (msgs: any[], options?: PrepareMessagesOptions) => Promise<any[]>;

export interface AgentTurnEngineOptions {
    /** OpenAI 兼容的 client 实例（由 AIProviderFactory.getClient 创建） */
    client: any;
    /** 最终使用的 model ID（已经过 provider 解析） */
    finalModelId: string;
    /** 当前活跃历史（含系统提示词），引擎会在此基础上追加并返回更新后的副本 */
    activeHistory: any[];
    /** 所有工具的 OpenAI function schema 数组 */
    toolsMetadata: any[];
    /** 推理模式额外参数（由 AIProviderFactory.buildThinkingOptions 生成；default 档位时不含 reasoning_effort） */
    thinkingOptions: any;
    /** Agent 宿主能力（工具执行与会话历史持久化） */
    agentService: AgentTurnHost;
    /** 工作区根路径（用于 TodoService） */
    root: string;
    /** 用户标识 */
    userId: string;
    /** 当前请求的 Trace ID（透传给工具执行） */
    currentTraceId: string;
    /** 经过优化压缩后的历史快照（用于最终回答时更新会话历史） */
    optimizedMessages: any[];
    /** 最后一条用户消息记录（用于最终回答时更新会话历史） */
    lastUserMsgRecord: any;
    /**
     * 重建 activeHistory 的函数（注入系统提示词 + 按字节裁剪）。
     * 在每轮工具调用结束后调用，保持上下文整洁。
     * 累计限流触发提前压缩时会以 `{ forceCompact: true }` 调用。
     */
    prepareMessages: PrepareMessages;
    /** 用户发起取消时的 AbortSignal */
    abortSignal?: AbortSignal;
    /** 可选请求门控：每次实际模型请求（包括重试）之前执行。 */
    beforeApiRequest?: () => Promise<void>;
    /** 成功请求后的 usage 校验；失败不会触发模型请求重试。 */
    afterApiRequest?: (usage: TokenUsage | null) => void;
    /** 向客户端推送流式事件的函数 */
    emit: (chunk: any) => void;
    /** 整个请求的开始时间戳（用于计算每轮耗时并上报 Telemetry） */
    startTimeStamp: number;
    /**
     * 本次调用前已累计的总步骤数（跨外层 TODO 循环积累）。
     * 默认 0，引擎会将其累加后在结果中返回。
     */
    totalSteps?: number;
    /**
     * 当前使用的模型供应商配置。
     * Qwen 系模型不允许中途插入 system 消息，请求前会由安全网将所有非首条
     * system 消息降级为 user 消息（加前缀），保证循环迭代过程中消息序列合规。
     */
    provider?: Partial<ModelProviderConfig>;
    /**
     * 是否跳过会话历史持久化。
     * 设为 true 时，runTurns 不会调用 agentService.updateSessionHistory。
     * 评估 Agent 的对话旅程是临时的、短暂的，不应污染主 Agent 的持久化历史。
     */
    skipPersist?: boolean;
    /** 恢复时首个模型调用重放此原始请求体。 */
    resumeRequest?: LLMRequestRecord;
    /** 当前请求所属的 Agent 阶段。 */
    agentStage?: AgentStage;
    /** 用于在重启后重建外层 Agent 对话循环的上下文。 */
    recoveryContext?: LLMRequestRecoveryContext;
    /**
     * 只允许执行的工具名集合。
     * 未列出的工具不会出现在本轮 tools schema 中；若模型仍输出未列出的工具名，执行前直接拒绝。
     */
    allowedToolNames?: ReadonlySet<string>;
    /**
     * 最大轮次上限（默认不限制，保持现有 chat 行为）。
     * 达到上限后追加一次禁止工具调用的收尾轮次（tool_choice:"none"），要求模型给出最终答复。
     */
    maxTurns?: number;
    /**
     * 从第一轮起就禁止工具调用（工具 schema 仍保留，tool_choice:"none"）。
     * 用于评估报告重写/续写等必须直接产出正文的场景。
     */
    forceFinalAnswer?: boolean;
    /**
     * 跳过 Telemetry 写盘（多 Worker 场景避免并发写 DAU）。
     * 默认 false，保持现有行为。
     */
    skipTelemetry?: boolean;
    /** skipTelemetry 时的用量回传通道（通常由 Worker 上报主进程）。 */
    telemetrySink?: (usage: TokenUsage, modelId: string) => void;
    /** 跳过 LLM 请求日志（workflow 步骤不参与 chat 崩溃恢复）。 */
    skipJournal?: boolean;
    /** workflow 运行标识（透传给工具上下文）。 */
    runId?: string;
    /** workflow 步骤路径（透传给工具上下文）。 */
    stepPath?: string;
    /** 执行该轮次的 worker 标识（透传给工具上下文）。 */
    workerId?: string;
}

export interface AgentTurnEngineResult {
    /** 经过所有轮次执行后的活跃历史（可直接传入下一次 runTurns 或外层逻辑） */
    activeHistory: any[];
    /** 本次 runTurns 中所有成功模型调用的累计用量；无 usage 数据时为 null */
    usage: TokenUsage | null;
    /**
     * 本次 runTurns 执行的轮次数。
     * 结合调用方传入的 totalSteps 可还原全局步骤计数。
     */
    totalSteps: number;
    /** 本轮引擎最终 assistant 的文本答复（无最终答复时为空字符串） */
    finalAssistantContent: string;
    /** 本轮引擎最终 assistant 的推理内容 */
    finalAssistantReasoning: string;
    /**
     * 最后一次模型请求的 finish_reason（stop/tool_calls/length/content_filter/...）。
     * 未收到该字段时为 null。调用方可用 "length" 判断输出是否被长度上限截断。
     */
    finishReason: string | null;
}

// ---------------------------------------------------------------------------
// 引擎主体
// ---------------------------------------------------------------------------

/**
 * 构造「工具参数 JSON 非法/被截断」回传给模型的错误信息。
 * finish_reason=length 或参数明显未闭合时，明确提示是输出长度上限导致，并给出分块写入方案，
 * 避免模型把问题误判成工具自身的长度限制而反复重试同一段内容。
 */
export function buildToolArgumentErrorMessage(
    toolName: string,
    argumentsLength: number,
    argumentsText: string,
    finishReason: string | null,
    parseError: unknown,
): { message: string; looksTruncated: boolean } {
    const looksTruncated = finishReason === "length"
        || (argumentsLength >= 4096 && !/[}\]]\s*$/.test(argumentsText));
    const splitHint = toolName === "write_file"
        || toolName === "insert_in_file"
        || toolName === "replace_in_file"
        ? '请拆成多次较小调用：先用 write_file 写表头+前 N 行，再用 insert_in_file（startLine=当前总行数+1）追加后续块；单次 content 建议 ≤100 行/8KB，CSV 中的换行和双引号必须正确转义，或改用脚本生成后再写。'
        : '请缩小单次参数体积后重新调用，确保 JSON 完整闭合。';
    const message = looksTruncated
        ? `模型输出达到长度上限（finish_reason=${finishReason ?? 'unknown'}），工具 ${toolName} 的参数被截断，已跳过执行（argumentsLength=${argumentsLength}）。${splitHint}`
        : `工具参数不是合法 JSON（已跳过执行）：${String(parseError)}。${splitHint}`;
    return { message, looksTruncated };
}

export class AgentTurnEngine {
    /**
     * 执行 Agent 内层轮次循环：
     *   AI 流式调用 → 收集 response → 执行工具调用 → 循环
     * 直到模型不再返回 tool_calls（最终回答）为止。
     *
     * @returns 更新后的 activeHistory、最终 usage 以及累计步骤数
     */
    static async runTurns(options: AgentTurnEngineOptions): Promise<AgentTurnEngineResult> {
        const {
            client,
            finalModelId,
            toolsMetadata,
            thinkingOptions,
            agentService,
            root,
            userId,
            currentTraceId,
            optimizedMessages,
            lastUserMsgRecord,
            prepareMessages,
            abortSignal,
            emit,
            startTimeStamp,
            allowedToolNames,
            maxTurns,
            skipTelemetry,
            telemetrySink,
            skipJournal,
            runId,
            stepPath,
            workerId,
        } = options;

        let activeHistory = options.resumeRequest
            ? [...options.resumeRequest.payload.messages]
            : [...options.activeHistory];
        let usage: TokenUsage | null = null;
        let turns = 0;
        let totalSteps = options.totalSteps ?? 0;
        let finalAssistantContent = "";
        let finalAssistantReasoning = "";
        let lastNonEmptyAssistantContent = "";
        let lastAssistantReasoning = "";
        let finalTurnRequested = options.forceFinalAnswer === true;
        let forceFinalAnswer = options.forceFinalAnswer === true;
        let lastFinishReason: string | null = null;
        let truncationNotified = false;
        /**
         * 整个 runTurns 内累计的「限流 / 过载」重试次数（HTTP 429 与 408/409/425/5xx 合并计数），
         * 压缩成功或请求成功后清零。跨轮次累计，避免“每轮重新计数”导致上下文已经过长却始终不到阈值。
         *
         * 5xx「Service is too busy」与 429 一样常见于请求体积过大，只对 429 做压缩会留下
         * 「503 → 重试上百次 → 仍然 503」的假死循环。
         */
        let overloadRetryCount = 0;
        let rateLimitCompactionInFlight = false;
        /** 压缩已无法再减小体积（已在低水位 / 无收益）时置位，本轮不再重复尝试。 */
        let compactionExhausted = false;
        /** 连续重试窗口的起点（首次失败时刻）；成功一次即清零重新计时。 */
        let retryBudgetStartedAt: number | null = null;
        /** 恢复请求的原始 payload 只在首轮重放；限流压缩后必须停用重放，否则压缩后的历史不会生效。 */
        let resumeReplayPayload = options.resumeRequest?.payload;

        /**
         * 限流/过载后的自救：把 activeHistory 强制裁剪到低水位，降低请求体积。
         * @returns 是否真正压缩掉了内容（用于决定要不要重置限流计数）。
         */
        const compactHistoryAfterOverload = async (reason: string): Promise<boolean> => {
            if (rateLimitCompactionInFlight || compactionExhausted) return false;
            const lowWatermarkBytes = globalConfig.agent.lowWatermarkBytes;
            const beforeBytes = estimateMessagesJsonBytes(activeHistory);
            if (beforeBytes <= lowWatermarkBytes) {
                // 上下文已经在低水位以下，继续压缩没有收益：本轮的后续重试不再重复处理
                compactionExhausted = true;
                return false;
            }

            rateLimitCompactionInFlight = true;
            try {
                const compacted = await prepareMessages(activeHistory, { forceCompact: true });
                const afterBytes = estimateMessagesJsonBytes(compacted);
                if (afterBytes >= beforeBytes) {
                    compactionExhausted = true;
                    console.warn(
                        `${getTS()} [AgentTurnEngine] 限流后压缩上下文未减少体积（${formatByteSize(beforeBytes)}），保留原历史继续重试`,
                    );
                    return false;
                }

                activeHistory = compacted;
                resumeReplayPayload = undefined;
                console.warn(
                    `${getTS()} [AgentTurnEngine] 累计限流/过载 ${overloadRetryCount} 次（${reason}），已提前压缩上下文：`
                    + `${formatByteSize(beforeBytes)} -> ${formatByteSize(afterBytes)}（低水位 ${formatByteSize(lowWatermarkBytes)}）`,
                );
                emit({
                    type: "notice",
                    code: "RATE_LIMIT_CONTEXT_COMPACTED",
                    level: "warning",
                    content: `本次运行已累计 ${overloadRetryCount} 次被限流或服务过载（${reason}），为降低请求体积，已自动把上下文从 `
                        + `${formatByteSize(beforeBytes)} 压缩到 ${formatByteSize(afterBytes)}，随后继续重试。`,
                    params: {
                        reason,
                        beforeBytes,
                        afterBytes,
                        lowWatermarkBytes,
                        threshold: RATE_LIMIT_COMPACT_THRESHOLD,
                        model: finalModelId,
                    },
                });
                return true;
            } catch (error: any) {
                console.warn(
                    `${getTS()} [AgentTurnEngine] 限流后压缩上下文失败：${String(error?.message || error)}`,
                );
                return false;
            } finally {
                rateLimitCompactionInFlight = false;
            }
        };

        const maxTurnLimit = typeof maxTurns === "number" && Number.isFinite(maxTurns) && maxTurns > 0
            ? Math.floor(maxTurns)
            : undefined;
        const effectiveToolsMetadata = allowedToolNames
            ? toolsMetadata.filter((tool) => {
                const name = tool?.function?.name;
                return typeof name === "string" && allowedToolNames.has(name);
            })
            : toolsMetadata;
        const toolExecutionContext: ToolExecutionContext = {
            workspaceRoot: root,
            abortSignal,
            emit,
            ...(runId ? { runId } : {}),
            ...(stepPath ? { stepPath } : {}),
            ...(workerId ? { workerId } : {}),
            ...(allowedToolNames ? { allowedToolNames } : {}),
        };
        const outputGuardEnabled = globalConfig.agent.modelOutputGuard;
        const substitutionRetryLimit = globalConfig.agent.modelSubstitutionRetries;
        // 模型输出异常（控制标记泄漏）时的丢弃重试预算，可通过 AGENT_MODEL_CORRUPTION_RETRIES 覆盖
        const corruptionRetryLimit = globalConfig.agent.modelCorruptionRetries;
        const servedModels = new Set<string>();
        const systemFingerprints = new Set<string>();
        let substitutionNotified = false;
        /**
         * @param retryInfo 本次轮次内针对模型替换做过多少次“丢弃重试”，以及最终是否拿到请求的模型。
         *   用于把“已重试成功”和“重试后仍被替换”区分开，避免同一次替换重复刷屏。
         */
        const notifyModelSubstitution = (retryInfo?: { retries: number; resolved: boolean }) => {
            if (substitutionNotified) return;
            const served = Array.from(servedModels);
            // servedModels 会跨轮次累积，这里只关心“与所选模型不一致”的返回值
            const mismatched = served.filter((id) => isModelMismatch(finalModelId, [id]));
            if (mismatched.length === 0) return;
            const resolved = retryInfo?.resolved === true;
            substitutionNotified = true;
            const retries = retryInfo?.retries ?? 0;
            const systemFingerprint = Array.from(systemFingerprints)[0];
            const servedList = mismatched.join(', ');
            console.warn(
                `${getTS()} [AgentTurnEngine] 供应商回报的模型与请求不一致：请求 ${finalModelId}，`
                + `实际 ${servedList}（丢弃重试 ${retries} 次，${resolved ? '已恢复' : '仍被替换'}）`,
            );
            const content = resolved
                ? `检测到服务端返回的模型为“${servedList}”（与所选“${finalModelId}”不一致），`
                    + `已丢弃该次回复并重试，第 ${retries} 次重试后已恢复为所选模型。`
                : retries > 0
                    ? `服务端返回的模型与所选模型不一致：请求“${finalModelId}”，实际返回“${servedList}”。`
                        + `已丢弃被替换的回复并重试 ${retries} 次仍不一致，以下回复来自“${servedList}”，`
                        + '请核对供应商、网关路由与模型配置。'
                    : `服务端返回的模型与所选模型不一致：请求“${finalModelId}”，实际返回“${servedList}”。`
                        + '本次回答可能来自被替换或降级的后端，请核对供应商、网关路由与模型配置。';
            emit({
                type: 'notice',
                code: 'MODEL_SUBSTITUTION',
                level: 'warning',
                content,
                params: {
                    requestedModel: finalModelId,
                    servedModels: mismatched,
                    systemFingerprint,
                    providerId: options.provider?.id,
                    baseUrlHost: resolveHost(options.provider?.baseURL),
                    retries,
                    resolved,
                },
            });
        };
        const buildCorruptionError = (hit: ControlTokenHit, phase: CorruptionPhase) => {
            const diagnostics: ModelOutputDiagnostics = {
                requestedModel: finalModelId,
                servedModels: Array.from(servedModels),
                systemFingerprints: Array.from(systemFingerprints),
                providerId: options.provider?.id,
                baseUrlHost: resolveHost(options.provider?.baseURL),
            };
            return new ModelOutputCorruptionError(
                buildCorruptionMessage(hit, phase, diagnostics),
                { phase, hit, diagnostics },
            );
        };

        while (true) {
            turns++;

            if (abortSignal?.aborted) {
                console.log(`${getTS()} [AgentTurnEngine] AI generation aborted for user: ${userId}`);
                break;
            }

            if (maxTurnLimit && turns > maxTurnLimit && !finalTurnRequested) {
                finalTurnRequested = true;
                forceFinalAnswer = true;
                emit({
                    type: "stage",
                    content: `已达到最大轮次 ${maxTurnLimit}，停止调用工具并生成最终答复。`,
                });
                activeHistory.push({
                    role: "user",
                    content: "[系统] 已达到本次运行的最大轮次上限。请不要调用任何工具，直接基于当前进展给出最终答复。",
                });
            }

            totalSteps++;
            console.log(`${getTS()} [AgentTurnEngine] Starting turn ${turns} (Total steps: ${totalSteps}) for user: ${userId}`);

            // 首轮：检查是否已有 TODO 任务（仅做日志，不插入提示词）
            if (turns === 1) {
                const todos = await TodoService.getTodos(root, userId);
                if (todos && todos.length > 0) {
                    console.log(`${getTS()} [AgentTurnEngine] TODOs detected at the start of the turn loop, user: ${userId}`);
                }
            }

            // ---------------------------------------------------------------
            // AI 流式请求（含网络超时自动重试）
            // ---------------------------------------------------------------
            let retryCount = 0;
            let apiSuccess = false;
            let retryStageVisible = false;
            let fullContent = "";
            let fullReasoning = "";
            let toolCalls: any[] = [];
            let localUsage: TokenUsage | null = null;
            let finishReason: string | null = null;
            // 本轮的“模型输出异常 → 丢弃响应并重试”计数；与网络/服务过载/模型替换的重试预算相互独立
            let corruptionRetries = 0;
            let corruptionRecoveryRounds = 0;
            // 本轮的“模型被替换 → 丢弃回复并重试”计数；与网络错误重试预算相互独立
            let substitutionRetries = 0;
            // 重试预算耗尽或已有内容送到前端时，接受该次回复，仅在结束时提示
            let substitutionAccepted = false;
            // 各分类的重试预算相互独立：网络错误不应挤占服务过载/限流的重试次数
            const retryAttempts: Record<'rate_limited' | 'service_busy' | 'network', number> = {
                rate_limited: 0,
                service_busy: 0,
                network: 0,
            };

            while (retryCount <= MAX_ALLOWED_RETRIES && !apiSuccess) {
                fullContent = "";
                fullReasoning = "";
                toolCalls = [];
                localUsage = null;
                finishReason = null;
                /** 本次实际请求的起始时刻：用于响应日志耗时与重试墙钟预算 */
                const attemptStartedAt = Date.now();
                /** 本次请求实际返回的模型 / 指纹（servedModels 是跨轮次累计的，日志需要单次快照） */
                const attemptServedModels = new Set<string>();
                const attemptSystemFingerprints = new Set<string>();
                let contentPrefixConfirmed = false;
                let pendingContentPrefix = "";
                // 推理内容与正文同理：控制标记被拆包时先缓冲前缀，判定安全后再送出
                let reasoningPrefixConfirmed = false;
                let pendingReasoningPrefix = "";

                const currentTurnId = turns * TURN_ID_STRIDE + retryCount;
                let toolArgumentChars = 0;
                let emittedClientReasoningChars = 0;
                let emittedClientContentChars = 0;
                let reasoningTruncationNotified = false;
                let contentTruncationNotified = false;
                let lastProgressEmitAt = 0;
                let lastProgressChars = 0;
                const emitStreamProgress = (
                    channel: "content" | "reasoning" | "tool_arguments" | "complete",
                    deltaChars: number = 0,
                    toolName?: string,
                    force: boolean = false
                ) => {
                    const receivedChars = fullContent.length + fullReasoning.length + toolArgumentChars;
                    if (receivedChars <= 0) return;

                    const now = Date.now();
                    if (!force && now - lastProgressEmitAt < 300 && receivedChars - lastProgressChars < 2048) {
                        return;
                    }

                    lastProgressEmitAt = now;
                    lastProgressChars = receivedChars;
                    emit({
                        type: "progress",
                        channel,
                        receivedChars,
                        contentChars: fullContent.length,
                        reasoningChars: fullReasoning.length,
                        toolArgumentChars,
                        deltaChars,
                        toolName,
                        turn: currentTurnId,
                        timestamp: now,
                    });
                };

                const emitVisibleStreamDelta = (type: "reasoning" | "text", deltaText: string, turn: number) => {
                    const isReasoning = type === "reasoning";
                    const limit = isReasoning ? CLIENT_VISIBLE_REASONING_LIMIT : CLIENT_VISIBLE_CONTENT_LIMIT;
                    const label = isReasoning ? "推理文本" : "回复正文";
                    const emittedChars = isReasoning ? emittedClientReasoningChars : emittedClientContentChars;
                    const alreadyNotified = isReasoning ? reasoningTruncationNotified : contentTruncationNotified;

                    if (emittedChars >= limit) {
                        if (!alreadyNotified) {
                            const totalChars = isReasoning ? fullReasoning.length : fullContent.length;
                            emit({ type, content: streamTruncationNotice(label, totalChars), turn });
                            if (isReasoning) reasoningTruncationNotified = true;
                            else contentTruncationNotified = true;
                        }
                        return;
                    }

                    const remaining = Math.max(0, limit - emittedChars);
                    const visibleText = deltaText.length <= remaining ? deltaText : deltaText.slice(0, remaining);
                    if (visibleText) {
                        emit({ type, content: visibleText, turn });
                        if (isReasoning) emittedClientReasoningChars += visibleText.length;
                        else emittedClientContentChars += visibleText.length;
                    }

                    if (deltaText.length > remaining && !alreadyNotified) {
                        const totalChars = isReasoning ? fullReasoning.length : fullContent.length;
                        emit({ type, content: streamTruncationNotice(label, totalChars), turn });
                        if (isReasoning) {
                            reasoningTruncationNotified = true;
                            emittedClientReasoningChars = limit;
                        } else {
                            contentTruncationNotified = true;
                            emittedClientContentChars = limit;
                        }
                    }
                };

                // 收尾轮次保留 tools schema（部分供应商要求带 tool_calls 的历史必须同时携带 tools），
                // 通过 tool_choice:"none" 禁止继续调用工具。
                const toolsForRequest = forceFinalAnswer
                    ? (effectiveToolsMetadata.length > 0 ? effectiveToolsMetadata : undefined)
                    : (allowedToolNames ? effectiveToolsMetadata : toolsMetadata);
                // 恢复请求只在压缩前的首轮重放原始 payload；一旦因限流压缩过上下文，
                // resumeReplayPayload 会被清空，后续请求改用重建后的 activeHistory。
                const replayPayload = turns === 1 ? resumeReplayPayload : undefined;
                const rawRequestPayload = replayPayload ?? {
                    model: finalModelId,
                    messages: AIProviderFactory.buildProviderSafeMessages(activeHistory, options.provider),
                    ...(toolsForRequest !== undefined ? { tools: toolsForRequest as any } : {}),
                    stream: true,
                    stream_options: { include_usage: true },
                    ...(forceFinalAnswer && toolsForRequest !== undefined ? { tool_choice: "none" as const } : {}),
                    ...(globalConfig.agent.maxOutputTokens > 0
                        ? { max_tokens: globalConfig.agent.maxOutputTokens }
                        : {}),
                    ...thinkingOptions,
                };
                // 请求体 Unicode 安全网：JSON.stringify 会把未配对的 UTF-16 代理码元序列化成
                // `\ud83d` 这类孤立代理转义，DeepSeek / 网关的 JSON 解析器会直接拒绝整个请求，
                // 返回 400（如「请求格式不合法」/ `unexpected end of hex escape`）。
                // 工具结果（例如 insert_in_file 的 contextSnapshot）、UTF-16 文件内容、
                // 被截断的模型输出都可能携带这类码元；这里统一替换为 U+FFFD，
                // 保证请求体永远是合法 JSON。合法字符串保持原引用，不产生额外拷贝。
                const sanitizedRequest = sanitizeJsonStrings(rawRequestPayload);
                const requestPayload = sanitizedRequest.value;
                if (sanitizedRequest.repairedStrings > 0) {
                    console.warn(
                        `${getTS()} [AgentTurnEngine] 请求体包含 ${sanitizedRequest.repairedStrings} 处孤立 UTF-16 代理码元，`
                        + `已替换为 U+FFFD（否则服务端会以 400 拒绝整个请求；turn=${turns}）`,
                    );
                }

                if (!skipJournal) {
                    await LLMRequestJournal.getInstance().recordRequest({
                        root,
                        userId,
                        modelId: typeof requestPayload.model === "string" ? requestPayload.model : finalModelId,
                        providerId: options.provider?.id,
                        agentStage: options.agentStage ?? "主Agent",
                        traceId: currentTraceId,
                        recoveryContext: options.recoveryContext,
                        payload: requestPayload,
                    });
                }

                /**
                 * 每次实际请求（成功 / 失败 / 被丢弃）都异步落盘到工作区 `.llm_response`。
                 * 第一行元数据、第二行返回结果，便于回溯「限流到底是上下文过大、并发还是网关问题」。
                 * 写入失败只告警，绝不影响对话主流程。
                 */
                let attemptLogged = false;
                const recordAttempt = (info: {
                    success: boolean;
                    error?: any;
                    retry?: Record<string, unknown>;
                }) => {
                    if (attemptLogged) return;
                    attemptLogged = true;
                    try {
                        const payloadMessages = Array.isArray((requestPayload as any).messages)
                            ? (requestPayload as any).messages as any[]
                            : [];
                        LLMResponseLog.getInstance().record({
                            root,
                            metadata: {
                                timestamp: new Date(attemptStartedAt).toISOString(),
                                timestampMs: attemptStartedAt,
                                userId,
                                agentStage: options.agentStage ?? "主Agent",
                                traceId: currentTraceId,
                                runId,
                                stepPath,
                                workerId,
                                provider: {
                                    id: options.provider?.id,
                                    host: resolveHost(options.provider?.baseURL),
                                },
                                request: {
                                    model: finalModelId,
                                    turn: turns,
                                    attempt: retryCount + 1,
                                    messages: payloadMessages.length,
                                    messageBytes: estimateMessagesJsonBytes(payloadMessages),
                                    tools: Array.isArray((requestPayload as any).tools)
                                        ? (requestPayload as any).tools.length
                                        : 0,
                                    maxOutputTokens: globalConfig.agent.maxOutputTokens,
                                    thinking: thinkingOptions,
                                    resumedPayload: replayPayload !== undefined,
                                    // 请求体修复的孤立代理码元数：>0 说明历史/工具结果曾携带非法 Unicode
                                    unicodeRepairs: sanitizedRequest.repairedStrings,
                                },
                                durationMs: Date.now() - attemptStartedAt,
                                elapsedSinceRunStartMs: Date.now() - startTimeStamp,
                                success: info.success,
                                servedModels: Array.from(attemptServedModels),
                                systemFingerprints: Array.from(attemptSystemFingerprints),
                                finishReason,
                                usage: localUsage,
                                overloadRetryCount,
                                retryBudgetElapsedMs: retryBudgetStartedAt === null
                                    ? 0
                                    : Date.now() - retryBudgetStartedAt,
                                retry: info.retry,
                                error: describeErrorForLog(info.error),
                            },
                            result: {
                                content: fullContent,
                                reasoning_content: fullReasoning,
                                tool_calls: toolCalls.filter(Boolean),
                                finishReason,
                                usage: localUsage,
                            },
                        });
                    } catch (logError) {
                        console.warn(`${getTS()} [AgentTurnEngine] 写入 .llm_response 失败：`, logError);
                    }
                };

                await options.beforeApiRequest?.();
                try {
                    const response = await client.chat.completions.create(
                        requestPayload as any,
                        { signal: abortSignal },
                    );

                    if (response) {
                        for await (const chunk of response as any) {
                            if (chunk.usage) {
                                localUsage = normalizeTokenUsage(chunk.usage) || localUsage;
                            }
                            const servedModel = (chunk as any)?.model;
                            if (typeof servedModel === "string" && servedModel.trim()) {
                                servedModels.add(servedModel.trim());
                                attemptServedModels.add(servedModel.trim());
                            }
                            const fingerprint = (chunk as any)?.system_fingerprint;
                            if (typeof fingerprint === "string" && fingerprint.trim()) {
                                systemFingerprints.add(fingerprint.trim());
                                attemptSystemFingerprints.add(fingerprint.trim());
                            }

                            // 模型替换检测：必须在任何增量送出之前判定，
                            // 这样“丢弃本次回复”才不会留下半截内容。
                            if (outputGuardEnabled && !substitutionAccepted
                                && isModelMismatch(finalModelId, Array.from(servedModels))) {
                                const nothingEmitted = !contentPrefixConfirmed
                                    && emittedClientReasoningChars === 0
                                    && emittedClientContentChars === 0
                                    && toolArgumentChars === 0;
                                if (nothingEmitted && substitutionRetries < substitutionRetryLimit) {
                                    substitutionRetries++;
                                    throw new ModelSubstitutionError(
                                        `服务端返回的模型与所选不一致：请求 ${finalModelId}，`
                                        + `实际 ${Array.from(servedModels).join(', ')}；已丢弃本次回复并重试`,
                                        {
                                            attempt: substitutionRetries,
                                            limit: substitutionRetryLimit,
                                            requestedModel: finalModelId,
                                            servedModels: Array.from(servedModels),
                                        },
                                    );
                                }
                                // 已送出内容或重试预算用尽：接受该回复，结束时统一提示
                                substitutionAccepted = true;
                            }

                            const choice = chunk.choices?.[0] as any;
                            // finish_reason 可能只出现在最后一个 delta 为空的 chunk 上，
                            // 必须在 delta 判空之前采集，否则永远拿不到截断信号。
                            const chunkFinishReason = choice?.finish_reason;
                            if (typeof chunkFinishReason === "string" && chunkFinishReason) {
                                finishReason = chunkFinishReason;
                            }
                            const delta = choice?.delta as any;
                            if (!delta) continue;

                            // 重试成功后，第一条增量到达即清除顶部的“正在重试”状态，
                            // 避免 token 已恢复输出但按钮/横幅仍停留在 429 重试态。
                            if (retryStageVisible) {
                                emit({ type: "stage", content: "" });
                                retryStageVisible = false;
                            }

                            // 【原封不动】reasoning_content 优先直接拼接 delta 的原始字符串，
                            // 不做任何加工（不增、不删、不改），保证后续请求能逐字回传 API。
                            // 仅当该字段非字符串（如其他供应商的 reasoning/thinking 字段）时才走兼容解析。
                            const reasoningDelta =
                                typeof delta.reasoning_content === "string"
                                    ? delta.reasoning_content
                                    : extractReasoningText(delta);
                            if (reasoningDelta) {
                                fullReasoning += reasoningDelta;
                                // 与正文一致：先缓冲推理前缀，命中控制标记时整条响应丢弃，
                                // 而不是把拆包的控制标记直接送给前端/写入历史。
                                if (!reasoningPrefixConfirmed && outputGuardEnabled) {
                                    pendingReasoningPrefix += reasoningDelta;
                                    const reasoningProbe = probeLeadingContent(pendingReasoningPrefix);
                                    if (reasoningProbe.state === 'suspect') {
                                        throw buildCorruptionError(reasoningProbe.hit, 'prefix');
                                    }
                                    if (reasoningProbe.state === 'clean' || pendingReasoningPrefix.length >= PREFIX_PROBE_CHARS) {
                                        reasoningPrefixConfirmed = true;
                                        emitVisibleStreamDelta("reasoning", pendingReasoningPrefix, currentTurnId);
                                        emitStreamProgress("reasoning", pendingReasoningPrefix.length);
                                        pendingReasoningPrefix = "";
                                    }
                                } else {
                                    emitVisibleStreamDelta("reasoning", reasoningDelta, currentTurnId);
                                    emitStreamProgress("reasoning", reasoningDelta.length);
                                }
                            }
                            if (delta.content) {
                                fullContent += delta.content;
                                if (!contentPrefixConfirmed && outputGuardEnabled) {
                                    pendingContentPrefix += delta.content;
                                    const probe = probeLeadingContent(pendingContentPrefix);
                                    if (probe.state === 'suspect') {
                                        throw buildCorruptionError(probe.hit, 'prefix');
                                    }
                                    if (probe.state === 'clean' || pendingContentPrefix.length >= PREFIX_PROBE_CHARS) {
                                        contentPrefixConfirmed = true;
                                        emitVisibleStreamDelta("text", pendingContentPrefix, currentTurnId);
                                        emitStreamProgress("content", pendingContentPrefix.length);
                                        pendingContentPrefix = "";
                                    }
                                } else {
                                    emitVisibleStreamDelta("text", delta.content, currentTurnId);
                                    emitStreamProgress("content", delta.content.length);
                                }
                            }
                            if (delta.tool_calls) {
                                delta.tool_calls.forEach((tc: any) => {
                                    if (!toolCalls[tc.index]) {
                                        toolCalls[tc.index] = { id: tc.id, function: { name: "", arguments: "" } };
                                    }
                                    const toolCall = toolCalls[tc.index];
                                    if (tc.id) toolCall.id = tc.id;
                                    if (tc.function?.name) {
                                        if (outputGuardEnabled) {
                                            const nameHit = findControlToken(tc.function.name);
                                            if (nameHit) throw buildCorruptionError(nameHit, 'tool_arguments');
                                        }
                                        toolCall.function.name = tc.function.name;
                                    }
                                    if (tc.function?.arguments) {
                                        // 工具参数必须是 JSON：出现控制标记说明整条响应已损坏，
                                        // 必须在执行工具/写入历史之前丢弃并重新请求。
                                        const overlapStart = Math.max(0, toolCall.function.arguments.length - TOOL_ARGUMENT_SCAN_OVERLAP_CHARS);
                                        const probeText = toolCall.function.arguments.slice(overlapStart) + tc.function.arguments;
                                        if (outputGuardEnabled) {
                                            const argumentHit = findControlToken(probeText);
                                            if (argumentHit) throw buildCorruptionError(argumentHit, 'tool_arguments');
                                        }
                                        toolCall.function.arguments += tc.function.arguments;
                                        toolArgumentChars += tc.function.arguments.length;
                                        emitStreamProgress("tool_arguments", tc.function.arguments.length, toolCall.function.name || undefined);
                                    }
                                });
                            }
                        }
                    }
                    if (!reasoningPrefixConfirmed && pendingReasoningPrefix) {
                        const reasoningFinalProbe = probeLeadingContent(pendingReasoningPrefix);
                        if (reasoningFinalProbe.state === 'suspect') {
                            throw buildCorruptionError(reasoningFinalProbe.hit, 'prefix');
                        }
                        emitVisibleStreamDelta("reasoning", pendingReasoningPrefix, currentTurnId);
                        emitStreamProgress("reasoning", pendingReasoningPrefix.length);
                        pendingReasoningPrefix = "";
                    }
                    if (!contentPrefixConfirmed && pendingContentPrefix) {
                        const finalProbe = probeLeadingContent(pendingContentPrefix);
                        if (finalProbe.state === 'suspect') {
                            throw buildCorruptionError(finalProbe.hit, 'prefix');
                        }
                        emitVisibleStreamDelta("text", pendingContentPrefix, currentTurnId);
                        emitStreamProgress("content", pendingContentPrefix.length);
                        pendingContentPrefix = "";
                    }
                    if (outputGuardEnabled) {
                        const reasoningBodyHit = detectRepeatedControlToken(fullReasoning);
                        if (reasoningBodyHit) throw buildCorruptionError(reasoningBodyHit, 'body');
                        const bodyHit = detectRepeatedControlToken(fullContent);
                        if (bodyHit) throw buildCorruptionError(bodyHit, 'body');
                    }
                    if (isModelMismatch(finalModelId, Array.from(servedModels))) {
                        notifyModelSubstitution({ retries: substitutionRetries, resolved: false });
                    } else if (substitutionRetries > 0) {
                        notifyModelSubstitution({ retries: substitutionRetries, resolved: true });
                    }
                    emitStreamProgress("complete", 0, undefined, true);

                    // 空响应/仅 usage 的响应不会走到增量清除逻辑，这里兜底清除重试状态
                    if (retryStageVisible) {
                        emit({ type: "stage", content: "" });
                        retryStageVisible = false;
                    }

                    apiSuccess = true;
                    // 请求成功说明上下文与网关状态已恢复：清零限流/过载计数与重试墙钟预算
                    overloadRetryCount = 0;
                    retryBudgetStartedAt = null;
                    recordAttempt({ success: true });
                    if (finishReason === "length") {
                        console.warn(
                            `${getTS()} [AgentTurnEngine] 模型输出达到长度上限（finish_reason=length），内容可能被截断：`
                            + `contentChars=${fullContent.length}, reasoningChars=${fullReasoning.length}, turn=${turns}`,
                        );
                    }
                    if (forceFinalAnswer && toolCalls.length > 0) {
                        console.warn(`${getTS()} [AgentTurnEngine] Ignoring unexpected tool calls after final-answer request`);
                        toolCalls = [];
                    }
                    usage = accumulateTokenUsage(usage, localUsage);
                    if (localUsage) {
                        telemetrySink?.(localUsage, finalModelId);
                        emit({ type: "usage", usage: localUsage });
                    }
                    if (fullContent && fullContent.trim()) {
                        lastNonEmptyAssistantContent = fullContent.trim();
                    }
                    if (fullReasoning && fullReasoning.trim()) {
                        lastAssistantReasoning = fullReasoning.trim();
                    }
                } catch (error: any) {
                    if (abortSignal?.aborted) {
                        recordAttempt({
                            success: false,
                            error,
                            retry: { willRetry: false, reason: 'aborted' },
                        });
                        throw error;
                    }

                    if (error instanceof ModelSubstitutionError) {
                        // 被替换的回复一字未出，可以安全丢弃并立即重新请求；
                        // 这次重试不占用网络/服务过载的重试预算（retryCount 保持不变）。
                        console.warn(
                            `${getTS()} [AgentTurnEngine] 服务端模型被替换，丢弃本次回复并重试 `
                            + `(${error.detail.attempt}/${error.detail.limit})：${error.message}`,
                        );
                        if (localUsage) {
                            // 已产生的 token 真实消耗过，仍需计入用量与预算
                            usage = accumulateTokenUsage(usage, localUsage);
                            telemetrySink?.(localUsage, finalModelId);
                            localUsage = null;
                        }
                        emit({
                            type: "stage",
                            content: `服务端模型与所选不一致（请求 ${finalModelId}，实际 ${error.detail.servedModels.join(', ')}），`
                                + `已丢弃本次回复并重试（第 ${error.detail.attempt}/${error.detail.limit} 次）...`,
                        });
                        retryStageVisible = true;
                        recordAttempt({
                            success: false,
                            error,
                            retry: {
                                willRetry: true,
                                category: 'model_substitution',
                                attempt: error.detail.attempt,
                                limit: error.detail.limit,
                                delayMs: SUBSTITUTION_RETRY_DELAY_MS,
                            },
                        });
                        await new Promise((resolve) => setTimeout(resolve, SUBSTITUTION_RETRY_DELAY_MS));
                        continue;
                    }

                    if (error instanceof ModelOutputCorruptionError) {
                        console.warn(
                            `${getTS()} [AgentTurnEngine] 模型输出异常（${error.detail.phase}）：${error.message}`,
                        );
                        // 被丢弃的响应已真实消耗 token，仍需计入用量与预算
                        if (localUsage) {
                            usage = accumulateTokenUsage(usage, localUsage);
                            telemetrySink?.(localUsage, finalModelId);
                            localUsage = null;
                        }

                        const phaseLabel = error.detail.phase === 'tool_arguments'
                            ? '工具调用参数包含控制标记'
                            : error.detail.phase === 'body'
                                ? '正文包含控制标记'
                                : '控制标记泄漏';
                        // 异常响应一律不写入历史（工具也不会执行）。已送到前端的部分只影响展示，
                        // 丢弃整条响应后重新请求即可恢复，不能因为一次异常输出就终止整个任务。
                        if (corruptionRetries < corruptionRetryLimit) {
                            corruptionRetries++;
                            emit({
                                type: "stage",
                                content: `检测到模型输出异常（${phaseLabel}），已丢弃本次响应并重新请求`
                                    + `（第 ${corruptionRetries}/${corruptionRetryLimit} 次）...`,
                            });
                            if (emittedClientContentChars > 0 || emittedClientReasoningChars > 0) {
                                emit({
                                    type: "text",
                                    content: `\n\n_[模型输出异常，已丢弃本次回复并重新请求（第 ${corruptionRetries} 次）...]_ \n\n`,
                                    turn: currentTurnId,
                                });
                            }
                            retryStageVisible = true;
                            recordAttempt({
                                success: false,
                                error,
                                retry: {
                                    willRetry: true,
                                    category: 'model_output_corruption',
                                    phase: error.detail.phase,
                                    attempt: corruptionRetries,
                                    limit: corruptionRetryLimit,
                                    delayMs: CORRUPTION_RETRY_BASE_DELAY_MS * corruptionRetries,
                                },
                            });
                            await new Promise((resolve) => setTimeout(resolve, CORRUPTION_RETRY_BASE_DELAY_MS * corruptionRetries));
                            continue;
                        }

                        // 相同请求容易被同一故障后端重复复现：注入纠正指令后再试一轮
                        if (corruptionRetryLimit > 0 && corruptionRecoveryRounds < CORRUPTION_RECOVERY_ROUNDS) {
                            corruptionRecoveryRounds++;
                            corruptionRetries = 0;
                            emit({
                                type: "notice",
                                code: "MODEL_OUTPUT_CORRUPTED",
                                level: "warning",
                                content: `模型连续 ${corruptionRetryLimit} 次返回异常输出（${phaseLabel}），这些响应已全部丢弃；`
                                    + `现在注入纠正指令后重新请求（第 ${corruptionRecoveryRounds}/${CORRUPTION_RECOVERY_ROUNDS} 轮）。`,
                                params: {
                                    phase: error.detail.phase,
                                    token: error.detail.hit.token,
                                    requestedModel: finalModelId,
                                    servedModels: Array.from(servedModels),
                                    providerId: options.provider?.id,
                                    baseUrlHost: resolveHost(options.provider?.baseURL),
                                },
                            });
                            activeHistory.push(
                                AIProviderFactory.buildMidConversationDirective(options.provider, [
                                    '上一次请求的模型响应包含异常控制标记（BOS/EOS 等特殊 token），已被系统丢弃，不属于有效上下文。',
                                    '请重新给出正常回答：只输出面向用户的有效内容，不要输出任何特殊 token 或控制标记。',
                                    '如果需要调用工具，请给出完整的工具名与合法的 JSON 参数。',
                                ].join('\n')),
                            );
                            retryStageVisible = true;
                            recordAttempt({
                                success: false,
                                error,
                                retry: {
                                    willRetry: true,
                                    category: 'model_output_corruption_recovery',
                                    phase: error.detail.phase,
                                    recoveryRound: corruptionRecoveryRounds,
                                    limit: CORRUPTION_RECOVERY_ROUNDS,
                                },
                            });
                            await new Promise((resolve) => setTimeout(resolve, CORRUPTION_RETRY_BASE_DELAY_MS * 2));
                            continue;
                        }

                        // 重试手段用尽仍然异常：先给出“模型被替换”的明确提示，再上抛
                        recordAttempt({
                            success: false,
                            error,
                            retry: {
                                willRetry: false,
                                category: 'model_output_corruption',
                                phase: error.detail.phase,
                                reason: 'corruption_retries_exhausted',
                                attempt: corruptionRetries,
                                limit: corruptionRetryLimit,
                                recoveryRounds: corruptionRecoveryRounds,
                            },
                        });
                        notifyModelSubstitution({ retries: substitutionRetries, resolved: false });
                        throw error;
                    } else {
                        // ================================================================
                        // 可重试错误分类（共享工具 ApiRetryUtils）：
                        // - rate_limited：HTTP 429（并发/配额/上下文体积触发的限流）
                        //   → 按 RATE_LIMIT_RETRY_LIMIT（默认 10 次）重试；
                        //     累计超过 RATE_LIMIT_COMPACT_THRESHOLD 次后先把上下文压缩到低水位
                        // - service_busy：HTTP 408/409/425/500/502/503/504（服务过载/临时故障）
                        //   → 按 SERVICE_BUSY_RETRY_LIMIT（默认 100 次）重试，覆盖 DeepSeek
                        //     「503 Service is too busy」等场景
                        // - network：无 HTTP 响应（DNS 解析失败 / 连接被拒 / 流中断 / TLS 握手失败等）
                        //   → 按 RETRY_LIMIT（默认 3 次）重试
                        // 注意：error.status 有值（如 503）不代表不可重试，旧的「仅 status===undefined
                        // 才重试」逻辑会漏掉服务过载类错误，这正是本处优化的关键。
                        // ================================================================
                        const verdict = classifyRetryableError(error);
                        const retryCategory = verdict.category === 'non_retryable' ? null : verdict.category;
                        const maxRetries = retryCategory === 'rate_limited'
                            ? RATE_LIMIT_RETRY_LIMIT
                            : retryCategory === 'service_busy' ? SERVICE_BUSY_RETRY_LIMIT
                                : retryCategory === 'network' ? RETRY_LIMIT
                                    : 0;
                        const attemptInCategory = retryCategory ? retryAttempts[retryCategory] : 0;
                        const label = retryCategory === 'rate_limited'
                            ? '请求限流'
                            : retryCategory === 'service_busy' ? '服务过载' : '网络异常';

                        if (verdict.retryable && retryCategory && attemptInCategory < maxRetries
                            && retryCount < MAX_ALLOWED_RETRIES) {
                            // 连续重试墙钟预算：服务过载预算默认 100 次、退避上限 30s，
                            // 只按次数限制会让一次对话卡死几十分钟（用户看到的就是“无限重试”）。
                            if (retryBudgetStartedAt === null) {
                                retryBudgetStartedAt = attemptStartedAt;
                            }
                            const retryElapsedMs = Date.now() - retryBudgetStartedAt;
                            if (RETRY_MAX_ELAPSED_MS > 0 && retryElapsedMs >= RETRY_MAX_ELAPSED_MS) {
                                const budgetError = Object.assign(
                                    new Error(
                                        `连续重试已持续 ${formatDurationMs(retryElapsedMs)}（上限 ${formatDurationMs(RETRY_MAX_ELAPSED_MS)}），`
                                        + `最近一次错误：${label}（${verdict.reason}）。已停止自动重试，请稍后手动重试。`,
                                    ),
                                    { status: verdict.status > 0 ? verdict.status : undefined, cause: error, code: error?.code },
                                );
                                console.warn(
                                    `${getTS()} [AgentTurnEngine] ${budgetError.message} `
                                    + `(分类 ${retryCategory}，第 ${attemptInCategory}/${maxRetries} 次，本轮累计 ${retryCount} 次)`,
                                );
                                recordAttempt({
                                    success: false,
                                    error: budgetError,
                                    retry: {
                                        willRetry: false,
                                        category: retryCategory,
                                        reason: 'retry_budget_exceeded',
                                        status: verdict.status,
                                        attemptInCategory,
                                        maxRetries,
                                        elapsedMs: retryElapsedMs,
                                        limitMs: RETRY_MAX_ELAPSED_MS,
                                        lastError: describeErrorForLog(error),
                                    },
                                });
                                emit({ type: "stage", content: "" });
                                retryStageVisible = false;
                                throw budgetError;
                            }

                            retryAttempts[retryCategory] = attemptInCategory + 1;
                            retryCount++;

                            // 429 与服务过载（408/409/425/5xx）都可能由请求体积过大引发：
                            // 累计超过阈值后先把上下文压缩到低水位再重试，
                            // 避免“上下文过长 → 持续 429/503 → 无限重试”的死循环。
                            if (retryCategory === 'rate_limited' || retryCategory === 'service_busy') {
                                overloadRetryCount++;
                                if (overloadRetryCount > RATE_LIMIT_COMPACT_THRESHOLD) {
                                    const compacted = await compactHistoryAfterOverload(verdict.reason);
                                    if (compacted) overloadRetryCount = 0;
                                }
                            }

                            const delayMs = computeRetryDelayMs(retryAttempts[retryCategory] - 1, retryCategory);
                            const errCode = error.cause?.code || error.code || (verdict.status > 0 ? `HTTP ${verdict.status}` : 'NETWORK');
                            console.warn(
                                `${getTS()} [AgentTurnEngine] 遇到${label}错误 (${verdict.reason}, code=${errCode})，`
                                + `正在进行第 ${retryAttempts[retryCategory]}/${maxRetries} 次重试`
                                + `（本轮累计 ${retryCount} 次，连续重试已 ${formatDurationMs(retryElapsedMs)}）...`
                            );
                            recordAttempt({
                                success: false,
                                error,
                                retry: {
                                    willRetry: true,
                                    category: retryCategory,
                                    reason: verdict.reason,
                                    status: verdict.status,
                                    attemptInCategory: retryAttempts[retryCategory],
                                    maxRetries,
                                    delayMs,
                                    elapsedMs: retryElapsedMs,
                                    overloadRetryCount,
                                },
                            });
                            emit({
                                type: "stage",
                                content: `${label}（${verdict.reason}），正在自动进行第 ${retryCount} 次自动重试`
                                    + `（已重试 ${formatDurationMs(retryElapsedMs)}，上限 ${formatDurationMs(RETRY_MAX_ELAPSED_MS)}）...`,
                            });
                            retryStageVisible = true;
                            // 制造视觉断层补偿
                            emit({
                                type: "text",
                                content: `\n\n_[${label}，自动重新请求生成中（第 ${retryCount} 次）...]_ \n\n`,
                                turn: turns * TURN_ID_STRIDE + retryCount - 1,
                            });
                            // 指数退避 + 抖动（服务过载/限流类退避更激进，避免惊群）
                            await new Promise((resolve) => setTimeout(resolve, delayMs));
                        } else {
                            recordAttempt({
                                success: false,
                                error,
                                retry: {
                                    willRetry: false,
                                    category: retryCategory ?? 'non_retryable',
                                    reason: verdict.reason,
                                    status: verdict.status,
                                    attemptInCategory,
                                    maxRetries,
                                    exhausted: retryCategory !== null && attemptInCategory >= maxRetries,
                                    retriesDisabled: !verdict.retryable,
                                },
                            });
                            throw error; // 不可重试错误，或超过对应分类的重试上限，向上抛出
                        }
                    }
                }
                if (apiSuccess) options.afterApiRequest?.(localUsage);
            }

            // ---------------------------------------------------------------
            // 构建 assistant 消息
            // ---------------------------------------------------------------
            // 孤立代理码元会污染后续所有请求（见请求体 Unicode 安全网），
            // 写历史前先清洗，避免模型输出被截断时把非法 Unicode 扩散到工具轮。
            const assistantMsg: any = { role: "assistant", content: sanitizeLoneSurrogates(fullContent) };
            // 【原封不动】DeepSeek thinking mode（2026-09-10 口径）：请求携带 tools 参数时，
            // 后续每一轮 assistant 消息都必须完整回传 reasoning_content，否则 API 返回 400
            //（判定依据是「是否携带 tools」，而非「该轮是否实际发生工具调用」）。
            // 此处把本轮流式采集到的推理内容逐字写入，不做任何加工：
            //  - 模型有输出 → 原样携带；
            //  - 模型未输出（续接轮）→ 保留空字符串，与 API 返回的消息形态一致，不伪造、不删减。
            assistantMsg.reasoning_content = sanitizeLoneSurrogates(fullReasoning);

            // ---------------------------------------------------------------
            // 有工具调用：执行工具，继续循环
            // ---------------------------------------------------------------
            if (toolCalls.length > 0) {
                // filter(Boolean)：流式 tool_calls 可能因 index 不连续产生空洞，
                // 空洞会以 null 形式进入请求体并触发 400；
                // arguments 统一清洗孤立代理码元（模型输出被截断时可能携带）。
                const tool_calls_map = toolCalls.filter(Boolean).map((tc) => {
                    const rawArguments = typeof tc.function.arguments === "string"
                        ? sanitizeLoneSurrogates(tc.function.arguments)
                        : "";
                    return {
                        id: tc.id,
                        type: "function",
                        function: {
                            name: tc.function.name,
                            // 工具调用协议要求 arguments 是 JSON 字符串：
                            // 空参数统一落成 "{}"，避免部分网关把空字符串判为格式错误。
                            arguments: rawArguments.trim() ? rawArguments : "{}",
                        },
                    };
                });

                assistantMsg.tool_calls = tool_calls_map;
                activeHistory.push(assistantMsg);

                for (const tc of tool_calls_map) {
                    if (!tc.function.name) continue;
                    if (abortSignal?.aborted) break;

                    if (allowedToolNames && !allowedToolNames.has(tc.function.name)) {
                        const errMessage = `Tool "${tc.function.name}" is not allowed in this run`;
                        console.warn(`${getTS()} [AgentTurnEngine] Blocked disallowed tool call: ${tc.function.name}`);
                        emit({
                            type: "annotation",
                            method: "tool/error",
                            params: { toolCallId: tc.id, toolName: tc.function.name, error: errMessage },
                        });
                        activeHistory.push({
                            role: "tool",
                            tool_call_id: tc.id,
                            content: sanitizeLoneSurrogates(`Error: ${errMessage}`),
                        });
                        continue;
                    }

                    let parsedArgs: any = {};
                    const rawArguments = typeof tc.function.arguments === "string" ? tc.function.arguments.trim() : "";
                    if (rawArguments) {
                        try {
                            parsedArgs = JSON.parse(rawArguments);
                        } catch (e: any) {
                            // 参数被截断/污染时不要退化成空参数执行工具（可能造成误操作），
                            // 把错误回传给模型，让它在下一轮重新发起合法调用。
                            const originalArgumentsLength = typeof tc.function.arguments === "string"
                                ? tc.function.arguments.length
                                : 0;
                            const { message: errMessage, looksTruncated } = buildToolArgumentErrorMessage(
                                tc.function.name,
                                originalArgumentsLength,
                                String(tc.function.arguments || ""),
                                finishReason,
                                e?.message || e,
                            );
                            // 被截断/污染的 arguments 不能原样回放：严格网关会校验
                            // tool_calls[].function.arguments 必须是合法 JSON，否则整个请求
                            // 返回 400（如「请求格式不合法」）。收敛为 "{}"：工具不会执行，
                            // 下一轮由模型根据 tool 错误信息重新发起合法调用。
                            tc.function.arguments = "{}";
                            console.error(
                                `${getTS()} [AgentTurnEngine] JSON parse error for tool ${tc.function.name}.`
                                + ` argumentsLength=${originalArgumentsLength} finishReason=${finishReason ?? 'unknown'} looksTruncated=${looksTruncated}`
                            );
                            emit({
                                type: "annotation",
                                method: "tool/error",
                                params: { toolCallId: tc.id, toolName: tc.function.name, error: errMessage },
                            });
                            activeHistory.push({
                                role: "tool",
                                tool_call_id: tc.id,
                                content: sanitizeLoneSurrogates(`Error: ${errMessage}`),
                            });
                            continue;
                        }
                    }
                    if (parsedArgs === null || typeof parsedArgs !== "object") {
                        parsedArgs = {};
                    }

                    emit({
                        type: "annotation",
                        method: "tool/call",
                        params: buildClientToolCallParams(tc.id, tc.function.name, parsedArgs),
                    });
                    emit({ type: "stage", content: `执行工具: ${tc.function.name}...` });

                    try {
                        if (process.env.DEBUG_LOG === "true") {
                            const clientSafeParams = buildClientToolCallParams(tc.id, tc.function.name, parsedArgs);
                            console.log(
                                `${getTS()} [AgentTurnEngine] [DEBUG] Executing tool: ${tc.function.name} with args:`,
                                JSON.stringify(clientSafeParams.args)
                            );
                        }

                        const result = await agentService.toolManager.executeTool(
                            userId,
                            tc.function.name,
                            parsedArgs,
                            currentTraceId,
                            toolExecutionContext
                        );

                        if (process.env.DEBUG_LOG === "true") {
                            console.log(`${getTS()} [AgentTurnEngine] [DEBUG] Tool ${tc.function.name} result success.`);
                        }

                        // 文件编辑工具执行后附上文件路径，供前端编辑器感知刷新：
                        // - filePath: Agent 传入的相对路径（原样）
                        // - absolutePath: 基于工作区 root 解析的绝对路径
                        //   前端用两者 + workspaceRoot 做归一化比较，兼容绝对/相对两种 activeFile
                        const fileRelPath =
                            typeof parsedArgs === 'object' && parsedArgs !== null
                                ? (typeof (parsedArgs as any).path === 'string'
                                    ? (parsedArgs as any).path
                                    : (typeof (parsedArgs as any).filePath === 'string'
                                        ? (parsedArgs as any).filePath
                                        : (typeof (parsedArgs as any).targetPath === 'string'
                                            ? (parsedArgs as any).targetPath
                                            : null)))
                                : null;

                        emit({
                            type: "annotation",
                            method: "tool/result",
                            params: {
                                toolCallId: tc.id,
                                toolName: tc.function.name,
                                result,
                                ...(fileRelPath
                                    ? { filePath: fileRelPath, absolutePath: path.resolve(root, fileRelPath) }
                                    : {}),
                            },
                        });

                        // tool 消息的 content 必须是字符串：工具返回 undefined/函数时
                        // JSON.stringify 会得到 undefined，字段被丢弃后请求体会变成非法结构。
                        const serializedResult = typeof result === "string" ? result : JSON.stringify(result);
                        activeHistory.push({
                            role: "tool",
                            tool_call_id: tc.id,
                            // 工具结果可能回显文件内容（如 insert_in_file 的 contextSnapshot）：
                            // UTF-16 解码/截断产生的孤立代理码元必须在回传模型前修复，
                            // 否则下一次请求会被服务端以 400 拒绝。
                            content: sanitizeLoneSurrogates(
                                typeof serializedResult === "string" ? serializedResult : "null",
                            ),
                        });

                        // todo 工具执行后同步 TODO 状态到前端（原子工具集）
                        const todoToolNames = new Set(['manage_todo', 'list_todos', 'append_todo', 'update_todo', 'delete_todo']);
                        if (todoToolNames.has(tc.function.name)) {
                            const todosFromTool = result && typeof result === "object" ? (result as any).todos : undefined;
                            const todos = Array.isArray(todosFromTool)
                                ? todosFromTool
                                : await TodoService.getTodos(root, userId);
                            emit({ type: "annotation", method: "todo/update", params: { todos } });
                        }
                    } catch (toolErr: any) {
                        console.error(
                            `${getTS()} [AgentTurnEngine] Tool execution error (${tc.function.name}):`,
                            toolErr
                        );
                        // 工具执行错误属于可恢复错误，不应以 type:"error" 发送，
                        // 否则前端/Electron bridge 会将其视为致命错误终止整个会话。
                        // 改用 annotation 事件，模型可在下一轮根据错误信息修正参数重试。
                        const errMessage = String(toolErr?.message || toolErr || 'Unknown tool error');
                        emit({
                            type: "annotation",
                            method: "tool/error",
                            params: { toolCallId: tc.id, toolName: tc.function.name, error: errMessage },
                        });
                        activeHistory.push({
                            role: "tool",
                            tool_call_id: tc.id,
                            content: sanitizeLoneSurrogates(`Error: ${errMessage}`),
                        });
                    }
                }
            } else {
                // ---------------------------------------------------------------
                // 无工具调用：最终回答，持久化并退出循环
                // ---------------------------------------------------------------
                console.log(
                    `${getTS()} [AgentTurnEngine] Assistant response (no tool calls) for user: ${userId}, turn: ${turns}:`,
                    fullContent
                );
                // 只记录最终答复这一轮的 finish_reason；工具轮次的 tool_calls 不应冒充最终原因。
                lastFinishReason = finishReason;

                // 明确告知前端“本次回答被长度上限截断”，避免把半截报告当成完整结论。
                if (finishReason === "length" && !truncationNotified) {
                    truncationNotified = true;
                    emit({
                        type: "notice",
                        code: "MODEL_OUTPUT_TRUNCATED",
                        level: "warning",
                        content: "模型输出达到长度上限，本次回复可能不完整；如需完整结果请重试或提高 AGENT_MAX_OUTPUT_TOKENS。",
                        params: {
                            finishReason,
                            contentChars: fullContent.length,
                            reasoningChars: fullReasoning.length,
                        },
                    });
                }

                // 工具调用结束后 content 可能为空（纯推理模型），将 reasoning_content 复制过来供前端展示
                if (!fullContent && fullReasoning) {
                    assistantMsg.content = sanitizeLoneSurrogates(fullReasoning);
                    const visibleReasoning = fullReasoning.length > CLIENT_VISIBLE_CONTENT_LIMIT
                        ? `${fullReasoning.slice(0, CLIENT_VISIBLE_CONTENT_LIMIT)}${streamTruncationNotice("推理文本", fullReasoning.length)}`
                        : fullReasoning;
                    emit({ type: "text", content: visibleReasoning, turn: turns });
                }

                // 防御：若当前轮 assistant content 仍为空（例如模型在前轮已随工具调用输出了正文，本轮仅返回 stop 标志），
                // 优先回退到本轮对话中最近一次非空的 assistant 回复，避免被空回复覆盖导致前端丢失答复
                if (!assistantMsg.content || !assistantMsg.content.trim()) {
                    if (lastNonEmptyAssistantContent) {
                        assistantMsg.content = sanitizeLoneSurrogates(lastNonEmptyAssistantContent);
                        // 若当前轮尚未向客户端输出该正文，进行补发确保前端能收到
                        if (!fullContent) {
                            emit({ type: "text", content: lastNonEmptyAssistantContent, turn: turns });
                        }
                    } else if (lastAssistantReasoning) {
                        assistantMsg.content = sanitizeLoneSurrogates(lastAssistantReasoning);
                        const visibleReasoning = lastAssistantReasoning.length > CLIENT_VISIBLE_CONTENT_LIMIT
                            ? `${lastAssistantReasoning.slice(0, CLIENT_VISIBLE_CONTENT_LIMIT)}${streamTruncationNotice("推理文本", lastAssistantReasoning.length)}`
                            : lastAssistantReasoning;
                        emit({ type: "text", content: visibleReasoning, turn: turns });
                    } else {
                        // 终极兜底：若此前完全没有正文和推理，检查 TODO 状态生成明确结论，杜绝空白消息
                        const currentTodos = await TodoService.getTodos(root, userId).catch(() => []);
                        if (currentTodos.length > 0) {
                            const completedCount = currentTodos.filter(t => String(t.status).toLowerCase() === 'completed').length;
                            const fallbackReply = [
                                `已完成全部任务规划（${completedCount}/${currentTodos.length} 项达到终态）：`,
                                ...currentTodos.map((t, idx) => `${idx + 1}. [${t.status === 'completed' ? '已完成' : '失败'}] ${t.title || '未命名任务'}${t.description ? ` - ${t.description}` : ''}`),
                                '',
                                '所有任务已执行完毕。'
                            ].join('\n');
                            assistantMsg.content = fallbackReply;
                            emit({ type: "text", content: fallbackReply, turn: turns });
                        }
                    }
                }

                // 工具循环结束（最终回答），持久化时保留推理内容
                const assistantMsgToSave = { ...assistantMsg };
                if (!options.skipPersist) {
                    const historyToSave = [...optimizedMessages, lastUserMsgRecord, assistantMsgToSave];
                    agentService.updateSessionHistory?.(userId, historyToSave, root);
                }

                finalAssistantContent = assistantMsg.content || "";
                finalAssistantReasoning = assistantMsg.reasoning_content || "";

                break; // 退出内层轮次循环，交还控制权给调用方
            }

            // 每轮工具调用结束后重建 activeHistory（注入最新系统提示词 + 按字节裁剪）
            activeHistory = await prepareMessages(activeHistory);

            // ---------------------------------------------------------------
            // Telemetry：记录本轮 token 用量与耗时
            // ---------------------------------------------------------------
            const turnDuration = Date.now() - startTimeStamp;
            if (localUsage) {
                if (!skipTelemetry) {
                    const totalTokensConsumed = localUsage.totalTokens;
                    TelemetryService.recordRequest(
                        true,
                        turnDuration,
                        totalTokensConsumed,
                        "chat",
                        finalModelId,
                        userId
                    );
                    console.log(
                        `${getTS()} [AgentTurnEngine] Telemetry recorded: ${totalTokensConsumed} tokens for model ${finalModelId} (Turn Duration: ${turnDuration}ms)`
                    );
                }
            }

            console.log(
                `${getTS()} [AgentTurnEngine] Completed turn ${turns} for user: ${userId} (Duration: ${turnDuration}ms)`
            );
        }

        if (finalTurnRequested) {
            if (!finalAssistantContent && lastNonEmptyAssistantContent) {
                finalAssistantContent = lastNonEmptyAssistantContent;
            }
            if (!finalAssistantReasoning && lastAssistantReasoning) {
                finalAssistantReasoning = lastAssistantReasoning;
            }
        }

        return {
            activeHistory,
            usage,
            totalSteps,
            finalAssistantContent,
            finalAssistantReasoning,
            finishReason: lastFinishReason,
        };
    }
}
