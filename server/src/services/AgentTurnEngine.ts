/**
 * AgentTurnEngine — 可复用的 Agent 对话轮次执行引擎
 *
 * 封装单次"用户指令 → AI 调用（流式）→ 工具执行 → 循环"的核心逻辑，
 * 供 AgentChatComponent 及其他 Agent 复用。
 *
 * 职责范围：
 *  - 流式调用 AI API，收集 text / reasoning / tool_calls
 *  - 网络层错误自动重试（指数退避，最多 RETRY_LIMIT 次，可通过 AGENT_API_RETRY_LIMIT 配置）
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

import { AgentService } from "@/services/AgentService.js";
import { TodoService } from "@/services/TodoService.js";
import { TelemetryService } from "@/services/TelemetryService.js";
import { config as globalConfig } from "@/config/index.js";
import { getBeijingLogTimePrefix } from "@/utils/TimeUtils.js";
import { extractReasoningText } from "../utils/ReasoningUtils.js";

const getTS = () => getBeijingLogTimePrefix();

/**
 * 最大流式重试次数（网络超时 / 连接错误 / DNS 失败等）。
 * 从 globalConfig.agent.apiRetryLimit 读取（可通过环境变量 AGENT_API_RETRY_LIMIT 覆盖，默认 3 次）。
 */
const RETRY_LIMIT = globalConfig.agent.apiRetryLimit;
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

    if (toolName === "single_file_write") {
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

    if (toolName === "single_file_edit") {
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
            action: args.action,
        }, meta);
    }

    if (toolName === "multi_file_write") {
        const files = Array.isArray(args.files) ? args.files : [];
        let totalContentChars = 0;
        const summarizedFiles = files.slice(0, CLIENT_MAX_ARRAY_ITEMS).map((file: any) => {
            const contentChars = typeof file?.content === "string" ? file.content.length : 0;
            totalContentChars += contentChars;
            return sanitizeValueForClient({
                ...file,
                content: hiddenTextSummary(contentChars, "file_content"),
            }, meta);
        });

        if (files.length > CLIENT_MAX_ARRAY_ITEMS) {
            for (const file of files.slice(CLIENT_MAX_ARRAY_ITEMS)) {
                if (typeof file?.content === "string") totalContentChars += file.content.length;
            }
            meta.redacted = true;
            meta.truncatedItems += files.length - CLIENT_MAX_ARRAY_ITEMS;
            summarizedFiles.push({ hidden: true, omittedItems: files.length - CLIENT_MAX_ARRAY_ITEMS, reason: "too_many_files" });
        }

        meta.redacted = true;
        meta.redactedStringChars += totalContentChars;
        meta.totalContentChars = totalContentChars;
        meta.fileCount = files.length;

        return sanitizeValueForClient({
            ...args,
            files: summarizedFiles,
            fileCount: files.length,
            totalContentChars,
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

export interface AgentTurnEngineOptions {
    /** OpenAI 兼容的 client 实例（由 AIProviderFactory.getClient 创建） */
    client: any;
    /** 最终使用的 model ID（已经过 provider 解析） */
    finalModelId: string;
    /** 当前活跃历史（含系统提示词），引擎会在此基础上追加并返回更新后的副本 */
    activeHistory: any[];
    /** 所有工具的 OpenAI function schema 数组 */
    toolsMetadata: any[];
    /** 推理模式额外参数（e.g. { reasoning_effort: 'max' }，由 AIProviderFactory.buildThinkingOptions 生成） */
    thinkingOptions: any;
    /** AgentService 实例（用于工具执行与会话历史持久化） */
    agentService: AgentService;
    /** 工作区根路径（用于 TodoService） */
    root: string;
    /** 用户标识 */
    userId: string;
    /** 当前请求的 Trace ID（透传给工具执行） */
    currentTraceId: string;
    /** 经过优化压缩后的历史快照（用于最终回答时保存到 SessionStore） */
    optimizedMessages: any[];
    /** 最后一条用户消息记录（用于最终回答时保存到 SessionStore） */
    lastUserMsgRecord: any;
    /**
     * 重建 activeHistory 的函数（注入系统提示词 + 按字节裁剪）。
     * 在每轮工具调用结束后调用，保持上下文整洁。
     */
    prepareMessages: (msgs: any[]) => Promise<any[]>;
    /** 用户发起取消时的 AbortSignal */
    abortSignal?: AbortSignal;
    /** 向客户端推送流式事件的函数 */
    emit: (chunk: any) => void;
    /** 整个请求的开始时间戳（用于计算每轮耗时并上报 Telemetry） */
    startTimeStamp: number;
    /**
     * 本次调用前已累计的总步骤数（跨外层 TODO 循环积累）。
     * 默认 0，引擎会将其累加后在结果中返回。
     */
    totalSteps?: number;
    /** 单次 runTurns 允许的最大轮次，超出则强制退出（默认 1000） */
    maxTurns?: number;
}

export interface AgentTurnEngineResult {
    /** 经过所有轮次执行后的活跃历史（可直接传入下一次 runTurns 或外层逻辑） */
    activeHistory: any[];
    /** 最后一轮 API 返回的 usage 对象（含 total_tokens 等），无调用时为 null */
    usage: any;
    /**
     * 本次 runTurns 执行的轮次数。
     * 结合调用方传入的 totalSteps 可还原全局步骤计数。
     */
    totalSteps: number;
    /** 本轮引擎最终 assistant 的文本答复（无最终答复时为空字符串） */
    finalAssistantContent: string;
    /** 本轮引擎最终 assistant 的推理内容 */
    finalAssistantReasoning: string;
}

// ---------------------------------------------------------------------------
// 引擎主体
// ---------------------------------------------------------------------------

export class AgentTurnEngine {
    /**
     * 执行 Agent 内层轮次循环：
     *   AI 流式调用 → 收集 response → 执行工具调用 → 循环
     * 直到模型不再返回 tool_calls（最终回答）或达到 maxTurns 为止。
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
        } = options;

        const MAX_TURNS = options.maxTurns ?? globalConfig.agent.maxTurns;
        let activeHistory = [...options.activeHistory];
        let usage: any = null;
        let turns = 0;
        let totalSteps = options.totalSteps ?? 0;
        let finalAssistantContent = "";
        let finalAssistantReasoning = "";

        while (turns < MAX_TURNS) {
            turns++;

            if (abortSignal?.aborted) {
                console.log(`${getTS()} [AgentTurnEngine] AI generation aborted for user: ${userId}`);
                break;
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
            let fullContent = "";
            let fullReasoning = "";
            let toolCalls: any[] = [];
            let localUsage: any = null;

            while (retryCount <= RETRY_LIMIT && !apiSuccess) {
                try {
                    fullContent = "";
                    fullReasoning = "";
                    toolCalls = [];
                    localUsage = null;

                    // currentTurnId 在重试时递增，确保前端生成新的消息气泡
                    const currentTurnId = turns * 100 + retryCount;
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

                    const response = await client.chat.completions.create({
                        model: finalModelId,
                        messages: activeHistory,
                        tools: toolsMetadata as any,
                        stream: true,
                        stream_options: { include_usage: true },
                        ...thinkingOptions,
                    } as any, { signal: abortSignal });

                    if (response) {
                        for await (const chunk of response as any) {
                            if (chunk.usage) {
                                localUsage = chunk.usage;
                            }

                            const delta = chunk.choices[0]?.delta as any;
                            if (!delta) continue;

                            const reasoningDelta = extractReasoningText(delta);
                            if (reasoningDelta) {
                                fullReasoning += reasoningDelta;
                                emitVisibleStreamDelta("reasoning", reasoningDelta, currentTurnId);
                                emitStreamProgress("reasoning", reasoningDelta.length);
                            }
                            if (delta.content) {
                                fullContent += delta.content;
                                emitVisibleStreamDelta("text", delta.content, currentTurnId);
                                emitStreamProgress("content", delta.content.length);
                            }
                            if (delta.tool_calls) {
                                delta.tool_calls.forEach((tc: any) => {
                                    if (!toolCalls[tc.index]) {
                                        toolCalls[tc.index] = { id: tc.id, function: { name: "", arguments: "" } };
                                    }
                                    if (tc.id) toolCalls[tc.index].id = tc.id;
                                    if (tc.function?.name) toolCalls[tc.index].function.name = tc.function.name;
                                    if (tc.function?.arguments) {
                                        toolCalls[tc.index].function.arguments += tc.function.arguments;
                                        toolArgumentChars += tc.function.arguments.length;
                                        emitStreamProgress("tool_arguments", tc.function.arguments.length, toolCalls[tc.index].function.name || undefined);
                                    }
                                });
                            }
                        }
                    }
                    emitStreamProgress("complete", 0, undefined, true);

                    apiSuccess = true;
                    if (localUsage) usage = localUsage;
                } catch (error: any) {
                    if (abortSignal?.aborted) throw error;

                    // ================================================================
                    // 判断是否为可重试的网络层错误（连接未建立 / DNS 失败 / 流中断等）
                    // ================================================================
                    // 核心判据：error.status === undefined 表示从未收到 HTTP 响应，
                    // 即连接根本未到达服务器，必定是网络层问题，应重试。
                    // 覆盖场景：DNS 解析失败(ENOTFOUND)、连接被拒(ECONNREFUSED)、
                    // 流式中断(UND_ERR_BODY_TIMEOUT/terminated)、TLS 握手失败等。
                    const isRetryableNetworkError =
                        error.status === undefined ||                          // 无 HTTP 响应 = 网络层错误
                        error.code === "ETIMEDOUT" ||
                        error.code === "ECONNRESET" ||
                        error.cause?.code === "ENOTFOUND" ||                  // DNS 解析失败
                        error.cause?.code === "ECONNREFUSED" ||              // 连接被拒
                        error.cause?.code === "ECONNRESET" ||
                        error.cause?.code === "EAI_AGAIN" ||                  // DNS 临时失败
                        error.cause?.code === "EPIPE" ||                     // 管道断裂
                        error.cause?.code === "UND_ERR_BODY_TIMEOUT" ||      // undici 流读超时
                        error.cause?.code === "UND_ERR_CONNECT_TIMEOUT" ||   // undici 连接超时
                        (typeof error.cause?.code === 'string' && error.cause.code.startsWith("UND_ERR_")) || // 其他 undici 错误
                        error.cause?.message?.includes("fetch failed") ||     // fetch 通用失败
                        error.message?.includes("terminated");               // 流式连接被终止

                    if (isRetryableNetworkError && retryCount < RETRY_LIMIT) {
                        retryCount++;
                        const errCode = error.cause?.code || error.code || error.status || 'NETWORK';
                        console.warn(
                            `${getTS()} [AgentTurnEngine] 遇到网络层错误 (code=${errCode})，正在进行第 ${retryCount}/${RETRY_LIMIT} 次重试...`
                        );
                        emit({ type: "stage", content: `网络连接中断，正在自动进行第 ${retryCount} 次自动重试...` });
                        // 制造视觉断层补偿
                        emit({
                            type: "text",
                            content: "\n\n_[网络异常，自动重新请求生成中...]_ \n\n",
                            turn: turns * 100 + retryCount - 1,
                        });
                        // 指数退避
                        await new Promise((resolve) => setTimeout(resolve, 2000 * retryCount));
                    } else {
                        throw error; // 非超时错误，或超过重试上限，向上抛出
                    }
                }
            }

            // ---------------------------------------------------------------
            // 构建 assistant 消息
            // ---------------------------------------------------------------
            const assistantMsg: any = { role: "assistant", content: fullContent };
            if (fullReasoning) assistantMsg.reasoning_content = fullReasoning;

            // ---------------------------------------------------------------
            // 有工具调用：执行工具，继续循环
            // ---------------------------------------------------------------
            if (toolCalls.length > 0) {
                const tool_calls_map = toolCalls.map((tc) => ({
                    id: tc.id,
                    type: "function",
                    function: { name: tc.function.name, arguments: tc.function.arguments },
                }));

                assistantMsg.tool_calls = tool_calls_map;
                // DeepSeek thinking mode 协议：工具循环中的 assistant 消息必须携带 reasoning_content 字段
                if (!Object.prototype.hasOwnProperty.call(assistantMsg, "reasoning_content")) {
                    assistantMsg.reasoning_content = "";
                }
                activeHistory.push(assistantMsg);

                for (const tc of tool_calls_map) {
                    if (!tc.function.name) continue;
                    if (abortSignal?.aborted) break;

                    let parsedArgs = {};
                    try {
                        parsedArgs = JSON.parse(tc.function.arguments || "{}");
                    } catch (e) {
                        console.error(
                            `${getTS()} [AgentTurnEngine] JSON parse error for tool ${tc.function.name}. argumentsLength=${tc.function.arguments?.length || 0}`
                        );
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
                            { workspaceRoot: root }
                        );

                        if (process.env.DEBUG_LOG === "true") {
                            console.log(`${getTS()} [AgentTurnEngine] [DEBUG] Tool ${tc.function.name} result success.`);
                        }

                        emit({
                            type: "annotation",
                            method: "tool/result",
                            params: { toolCallId: tc.id, toolName: tc.function.name, result },
                        });

                        activeHistory.push({
                            role: "tool",
                            tool_call_id: tc.id,
                            content: typeof result === "string" ? result : JSON.stringify(result),
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
                        // 2026.03 [LOG_UPGRADE] 将具体错误信息透传给前端，防止显示模糊的 "An internal error occurred"
                        emit({ type: "error", content: `Tool Error [${tc.function.name}]: ${toolErr.message}` });
                        activeHistory.push({
                            role: "tool",
                            tool_call_id: tc.id,
                            content: `Error: ${toolErr.message}`,
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

                // 工具调用结束后 content 可能为空（纯推理模型），将 reasoning_content 复制过来供前端展示
                if (!fullContent && fullReasoning) {
                    assistantMsg.content = fullReasoning;
                    const visibleReasoning = fullReasoning.length > CLIENT_VISIBLE_CONTENT_LIMIT
                        ? `${fullReasoning.slice(0, CLIENT_VISIBLE_CONTENT_LIMIT)}${streamTruncationNotice("推理文本", fullReasoning.length)}`
                        : fullReasoning;
                    emit({ type: "text", content: visibleReasoning, turn: turns });
                }

                // 工具循环结束（最终回答），持久化时保留推理内容
                const assistantMsgToSave = { ...assistantMsg };
                const historyToSave = [...optimizedMessages, lastUserMsgRecord, assistantMsgToSave];
                agentService.updateSessionHistory(userId, historyToSave, root);

                finalAssistantContent = assistantMsgToSave.content || "";
                finalAssistantReasoning = assistantMsgToSave.reasoning_content || "";

                break; // 退出内层轮次循环，交还控制权给调用方
            }

            // 每轮工具调用结束后重建 activeHistory（注入最新系统提示词 + 按字节裁剪）
            activeHistory = await prepareMessages(activeHistory);

            // ---------------------------------------------------------------
            // Telemetry：记录本轮 token 用量与耗时
            // ---------------------------------------------------------------
            const turnDuration = Date.now() - startTimeStamp;
            if (usage) {
                const totalTokensConsumed = usage.total_tokens || 0;
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

            console.log(
                `${getTS()} [AgentTurnEngine] Completed turn ${turns} for user: ${userId} (Duration: ${turnDuration}ms)`
            );
        }

        return {
            activeHistory,
            usage,
            totalSteps,
            finalAssistantContent,
            finalAssistantReasoning,
        };
    }
}
