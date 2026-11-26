import { useState, useCallback, useEffect, useRef } from "react";
import { USER_ID } from "@/config";
import { useAgentContext, useTodoContext, useProblemContext } from "@/providers/AgentContext";
import {
    clearWorkspaceChatHistory,
    loadChatUiState,
    loadWorkspaceChatHistory,
    recordTokenUsage,
    type ChatMessage,
    type TokenUsage,
} from "@/services/db";
import { ChatPersistence } from "@/services/ChatPersistence";
import { recordTokenDelta } from "@/services/tokenRate";
import { createUsageRecorder } from "@/services/tokenUsageAccounting";
import {
    buildFinalizedRow,
    messagePersistSignature,
    selectMessagesToPersist,
} from "@/services/chatHistorySnapshot";
import { createClientId } from "@/utils/id";
import { normalizeWorkspaceKey } from "@/utils/path";
import { electronBridge, type AgentRecoveryInfo } from "@/services/electron-bridge";

export interface MessagePart {
    id: string;
    type: 'reasoning' | 'text' | 'stage' | 'annotation' | 'error' | 'notice' | 'meta';
    content: string;
    method?: string;
    params?: any;
    timestamp: number;
}

export interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    reasoning_content?: string; 
    parts: MessagePart[];
    timestamp: number;
    traceId?: string;
    isFinal?: boolean;
}

export interface StreamProgress {
    receivedChars: number;
    contentChars: number;
    reasoningChars: number;
    toolArgumentChars: number;
    deltaChars: number;
    channel?: 'content' | 'reasoning' | 'tool_arguments' | 'complete';
    toolName?: string;
    turn?: number;
    updatedAt: number;
}

const MAX_HISTORY_MESSAGES = 80;
const MAX_STAGE_ITEMS = 120;
// 流式 UI 提交节流间隔（毫秒）。
// 此前每个 rAF（约 16ms / 60fps）都会把整条消息提交给 React；超长任务下单条消息
// 会累积上万个 part，60fps 的全量协调会直接吃满主线程（表现为对话越久越卡）。
// 模型 token 的到达速率远低于 20fps，50ms（约 20fps）既看不出停顿，又把渲染开销降到 1/3。
const STREAM_FLUSH_INTERVAL_MS = 50;
const INLINE_STRING_LIMIT = 1200;
const RENDERED_TEXT_LIMIT = 200_000;
const LIVE_TEXT_PART_LIMIT = 120_000;
const LIVE_REASONING_PART_LIMIT = 60_000;
const MAX_ARRAY_ITEMS = 80;
const MAX_OBJECT_KEYS = 80;

type RedactionMeta = {
    redacted: boolean;
    redactedStringChars: number;
    truncatedItems: number;
    truncatedKeys: number;
    totalContentChars?: number;
    fileCount?: number;
};

type LiveTextMeta = {
    totalChars: number;
    visibleChars: number;
    truncated: boolean;
    limit: number;
    label: string;
};

const createRedactionMeta = (): RedactionMeta => ({
    redacted: false,
    redactedStringChars: 0,
    truncatedItems: 0,
    truncatedKeys: 0,
});

const hiddenTextSummary = (chars: number, reason: string) => ({
    hidden: true,
    chars,
    reason,
    note: '内容已在前端隐藏，仅保留字符计数以避免页面内存溢出。',
});

const trimMessagesForMemory = (items: Message[]): Message[] => {
    if (items.length <= MAX_HISTORY_MESSAGES) return items;
    return items.slice(-MAX_HISTORY_MESSAGES);
};

const liveTruncationNotice = (label: string, chars: number) =>
    `\n\n[${label}过长，前端已停止追加显示；已接收 ${chars.toLocaleString('zh-CN')} 字符，后续仅保留实时计数以避免页面内存溢出。]`;

const appendLimitedLiveText = (
    currentContent: string,
    incoming: string,
    label: string,
    limit: number,
    previousMeta?: Partial<LiveTextMeta>
): { content: string; meta: LiveTextMeta } => {
    const delta = incoming || '';
    const previousTotal = Number(previousMeta?.totalChars);
    const totalChars = (Number.isFinite(previousTotal) && previousTotal > 0 ? previousTotal : currentContent.length) + delta.length;
    const previousVisible = Number(previousMeta?.visibleChars);
    const visibleChars = Number.isFinite(previousVisible) && previousVisible > 0
        ? previousVisible
        : Math.min(currentContent.length, limit);

    if (!delta) {
        return {
            content: currentContent,
            meta: {
                totalChars,
                visibleChars,
                truncated: !!previousMeta?.truncated,
                limit,
                label,
            },
        };
    }

    if (previousMeta?.truncated) {
        return {
            content: currentContent,
            meta: {
                totalChars,
                visibleChars,
                truncated: true,
                limit,
                label,
            },
        };
    }

    const remaining = Math.max(0, limit - currentContent.length);
    if (delta.length <= remaining) {
        const content = currentContent + delta;
        return {
            content,
            meta: {
                totalChars,
                visibleChars: Math.min(content.length, limit),
                truncated: false,
                limit,
                label,
            },
        };
    }

    const visibleDelta = remaining > 0 ? delta.slice(0, remaining) : '';
    return {
        content: currentContent + visibleDelta + liveTruncationNotice(label, totalChars),
        meta: {
            totalChars,
            visibleChars: Math.min(limit, currentContent.length + visibleDelta.length),
            truncated: true,
            limit,
            label,
        },
    };
};

const sanitizeValueForClient = (value: any, meta: RedactionMeta, depth = 0): any => {
    if (typeof value === 'string') {
        if (value.length > INLINE_STRING_LIMIT) {
            meta.redacted = true;
            meta.redactedStringChars += value.length;
            return hiddenTextSummary(value.length, 'large_string');
        }
        return value;
    }

    if (value === null || value === undefined || typeof value !== 'object') return value;

    if (depth >= 6) {
        meta.redacted = true;
        return { hidden: true, reason: 'max_depth' };
    }

    if (Array.isArray(value)) {
        const visible = value.slice(0, MAX_ARRAY_ITEMS).map(item => sanitizeValueForClient(item, meta, depth + 1));
        if (value.length > MAX_ARRAY_ITEMS) {
            meta.redacted = true;
            meta.truncatedItems += value.length - MAX_ARRAY_ITEMS;
            visible.push({ hidden: true, omittedItems: value.length - MAX_ARRAY_ITEMS, reason: 'array_too_large' });
        }
        return visible;
    }

    const entries = Object.entries(value);
    const next: Record<string, any> = {};
    for (const [key, entryValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
        next[key] = sanitizeValueForClient(entryValue, meta, depth + 1);
    }
    if (entries.length > MAX_OBJECT_KEYS) {
        meta.redacted = true;
        meta.truncatedKeys += entries.length - MAX_OBJECT_KEYS;
        next.__omittedKeys = entries.length - MAX_OBJECT_KEYS;
    }
    return next;
};

const sanitizeWriteToolArgs = (toolName: string, args: any, meta: RedactionMeta): any | null => {
    if (!args || typeof args !== 'object') return null;

    // 兼容历史（宾+动）命名 file_write
    if (toolName === 'write_file' || toolName === 'file_write') {
        const contentChars = typeof args.content === 'string' ? args.content.length : Number(args.content?.chars) || 0;
        meta.redacted = true;
        meta.redactedStringChars += contentChars;
        meta.totalContentChars = contentChars;
        return sanitizeValueForClient({
            ...args,
            content: hiddenTextSummary(contentChars, 'file_content'),
        }, meta);
    }

    return null;
};

const sanitizeAnnotationParams = (method?: string, params?: any): any => {
    if (!params || typeof params !== 'object') return params;

    if (method === 'tool/call') {
        const toolName = String(params.toolName || '');
        const meta = createRedactionMeta();
        const args = sanitizeWriteToolArgs(toolName, params.args, meta) ?? sanitizeValueForClient(params.args, meta);
        const existingMeta = params.argsMeta && typeof params.argsMeta === 'object' ? params.argsMeta : null;
        return {
            ...params,
            args,
            argsMeta: existingMeta || meta,
        };
    }

    if (method === 'tool/result') {
        const meta = createRedactionMeta();
        const result = sanitizeValueForClient(params.result, meta);
        return {
            ...params,
            result,
            resultMeta: meta.redacted ? meta : params.resultMeta,
        };
    }

    return params;
};

const capRenderedText = (value: string | undefined, label: string): string => {
    if (!value || value.length <= RENDERED_TEXT_LIMIT) return value || '';
    return `${value.slice(0, RENDERED_TEXT_LIMIT)}\n\n[${label} 过长，前端已截断显示；原始字符数：${value.length}]`;
};

const sanitizeMessagePart = (part: MessagePart): MessagePart => ({
    ...part,
    content: capRenderedText(part.content, part.type === 'reasoning' ? '推理文本' : '消息内容'),
    params: part.type === 'annotation' ? sanitizeAnnotationParams(part.method, part.params) : part.params,
});

const sanitizeMessageForClient = (message: any): any => ({
    ...message,
    content: capRenderedText(message.content, '消息内容'),
    // 仅供前端内存/渲染节流：reasoning 文本已体现在 parts 中，顶层字段不再保留。
    // 客户端从不把消息回传给后端，API 回传链路（服务端 AgentTurnEngine）不受此处影响。
    reasoning_content: undefined,
    parts: Array.isArray(message.parts) ? message.parts.map(sanitizeMessagePart) : [],
});

export function useAgentSSE() {
    const { locale, workspaceRoot, provider, model, settings } = useAgentContext();
    const { todos, setTodos } = useTodoContext();
    const { addProblems } = useProblemContext();
    const [messages, setMessages] = useState<Message[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [input, setInput] = useState("");
    const [data, setData] = useState<any[]>([]); 
    const [streamProgress, setStreamProgress] = useState<StreamProgress | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    // 本轮流式对话是否已通过 error 事件渲染过错误（防止 bridge 异常路径重复追加错误消息）
    const receivedErrorRef = useRef(false);
    /**
     * IndexedDB 后台持久化队列：用户消息、流式 assistant 快照、工具结果、错误提示
     * 都会在运行过程中异步落库，不再依赖 done 事件，关闭应用后重启可完整恢复。
     */
    const persistenceRef = useRef<ChatPersistence | null>(null);
    if (!persistenceRef.current) {
        persistenceRef.current = new ChatPersistence();
    }
    /** 清空会话后短暂抑制写入，避免刚删除的数据又被旧状态写回。 */
    const suppressPersistUntilRef = useRef(0);
    /** 恢复完成前不写 UI 状态，避免用初始空值覆盖 IndexedDB 里的任务流水线/草稿。 */
    const restoreReadyRef = useRef(false);
    /** 最新输入草稿：恢复时用于判断用户是否已开始输入，避免覆盖。 */
    const inputRef = useRef(input);
    inputRef.current = input;
    /**
     * 本轮 assistant 消息的最新快照（由流式提交处维护）。
     * 流结束时用它做「终态兜底落库」：不依赖 React 副作用时序，
     * 保证最后一轮内容（含 isFinal）一定写入 IndexedDB。
     */
    const liveAssistantSnapshotRef = useRef<Message | null>(null);
    /** 已落库消息的内容指纹，避免同一条消息在每个流式分片都重复写库。 */
    const persistedSignatureRef = useRef<Map<string, string>>(new Map());
    /** 从 IndexedDB 恢复出来的消息：已是落库快照，不再回写（否则每次重启都会被二次清洗，内容逐次退化）。 */
    const restoredMessageIdsRef = useRef<Set<string>>(new Set());

    // 编辑器上下文：监听当前激活文件与选中范围，用于附加到用户指令
    const editorContextRef = useRef<{
        activeFile: string;
        hasSelection: boolean;
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
        selectedText: string;
    }>({
        activeFile: '',
        hasSelection: false,
        startLine: 0,
        startColumn: 0,
        endLine: 0,
        endColumn: 0,
        selectedText: '',
    });

    useEffect(() => {
        const handleFileActive = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            const nextFile = (detail?.activeFile || '').trim();
            editorContextRef.current = {
                ...editorContextRef.current,
                activeFile: nextFile,
                // 文件切换时重置选中状态与文本，避免旧文件的选中信息污染新文件
                hasSelection: false,
                startLine: 0,
                startColumn: 0,
                endLine: 0,
                endColumn: 0,
                selectedText: '',
            };
        };

        const handleCursorUpdate = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (!detail) return;
            editorContextRef.current = {
                ...editorContextRef.current,
                hasSelection: detail.hasSelection === true,
                startLine: detail.startLine ?? 0,
                startColumn: detail.startColumn ?? 0,
                endLine: detail.endLine ?? 0,
                endColumn: detail.endColumn ?? 0,
                selectedText: detail.selectedText || '',
            };
        };

        window.addEventListener('ui:file:active', handleFileActive);
        window.addEventListener('ui:cursor:update', handleCursorUpdate);

        return () => {
            window.removeEventListener('ui:file:active', handleFileActive);
            window.removeEventListener('ui:cursor:update', handleCursorUpdate);
        };
    }, []);

    useEffect(() => {
        const loadStartedAt = Date.now();
        const inputAtRestoreStart = inputRef.current;
        let cancelled = false;
        /** 是否已经把恢复结果应用到 messages（用于区分「加载前失败」与「已部分恢复」）。 */
        let appliedRestored = false;
        restoreReadyRef.current = false;
        const restore = async () => {
            try {
                // 放到微任务后执行：避免在 effect 内同步 setState 触发级联渲染告警
                await Promise.resolve();
                if (cancelled) return;

                if (!workspaceRoot) {
                    setMessages([]);
                    setData([]);
                    setStreamProgress(null);
                    setInput("");
                    restoreReadyRef.current = true;
                    return;
                }

                const [history, uiState] = await Promise.all([
                    loadWorkspaceChatHistory(workspaceRoot, MAX_HISTORY_MESSAGES).catch((error) => {
                        console.error('[AgentChat] Failed to load chat messages:', error);
                        return [] as ChatMessage[];
                    }),
                    loadChatUiState(workspaceRoot).catch((error) => {
                        console.error('[AgentChat] Failed to load chat UI state:', error);
                        return undefined;
                    }),
                ]);
                if (cancelled) return;

                const restoredMessages: Message[] = [];
                let unrestorable = 0;
                for (const row of history) {
                    if (row?.role !== 'user' && row?.role !== 'assistant') continue;
                    try {
                        restoredMessages.push(sanitizeMessageForClient({
                            ...row,
                            isFinal: true,
                            parts: Array.isArray(row.parts) && row.parts.length > 0
                                ? row.parts
                                : [{ id: createClientId(), type: 'text', content: row.content, timestamp: row.timestamp }],
                        } as any) as Message);
                    } catch (error) {
                        // 单条脏数据（历史版本写入的非字符串 content、异常 parts）不应拖垮整段历史恢复。
                        unrestorable += 1;
                        console.error('[AgentChat] Skipped an unrestorable chat message:', row?.id, error);
                    }
                }
                if (unrestorable > 0) {
                    console.warn(`[AgentChat] ${unrestorable} 条历史消息无法还原，已跳过以保证其余内容可恢复。`);
                }
                restoredMessageIdsRef.current = new Set(restoredMessages.map(m => m.id));
                persistedSignatureRef.current = new Map();

                // 恢复期间用户可能已经发送了新消息：保留加载开始后产生、且未在历史中的消息，
                // 避免异步恢复把刚输入的内容覆盖掉。
                setMessages(prev => {
                    const restoredIds = new Set(restoredMessages.map(m => m.id));
                    const inFlight = prev.filter(m => m.timestamp >= loadStartedAt && !restoredIds.has(m.id));
                    if (inFlight.length === 0) return trimMessagesForMemory(restoredMessages);
                    const merged = [...restoredMessages, ...inFlight]
                        .sort((left, right) => left.timestamp - right.timestamp);
                    return trimMessagesForMemory(merged);
                });
                appliedRestored = true;

                // 恢复 UI 状态；没有快照时清空旧工作区残留（data / 草稿）。
                setTodos(Array.isArray(uiState?.todos) ? uiState.todos : []);
                setData(Array.isArray(uiState?.stages) ? uiState.stages.slice(-MAX_STAGE_ITEMS) : []);
                setStreamProgress(null);
                setInput(current => (
                    current !== inputAtRestoreStart
                        ? current
                        : (typeof uiState?.input === 'string' ? uiState.input : '')
                ));
            } catch (error) {
                if (cancelled) return;
                console.error('[AgentChat] Failed to restore chat history from IndexedDB:', error);
                // 已经恢复出部分消息时不要清空（否则一次脏数据就会让整段历史消失）。
                if (!appliedRestored) {
                    setMessages(prev => prev.filter(m => m.timestamp >= loadStartedAt));
                }
            } finally {
                if (!cancelled) restoreReadyRef.current = true;
            }
        };

        void restore();
        return () => {
            cancelled = true;
        };
    }, [workspaceRoot, setTodos]);

    // ── 流式过程中的异步持久化 ──
    // 按消息粒度做「指纹差异」落库：任意一条 assistant 消息内容变化都会入队，
    // 不再只写「最后一条」——否则一旦末尾追加了提示/错误气泡，正在产出的
    // assistant 消息就再也写不进 IndexedDB（重启后表现为该轮内容丢失）。
    // 队列按 800ms 合并落库；isFinal 时立即 flush。
    useEffect(() => {
        if (!workspaceRoot || messages.length === 0) return;
        if (Date.now() < suppressPersistUntilRef.current) return;

        const persistence = persistenceRef.current;
        if (!persistence) return;

        const { rows, finalized } = selectMessagesToPersist(messages, {
            workspaceRoot,
            workspaceKey: normalizeWorkspaceKey(workspaceRoot),
            signatures: persistedSignatureRef.current,
            skipIds: restoredMessageIdsRef.current,
        });

        for (const row of rows) {
            persistence.scheduleMessage(row as ChatMessage);
        }
        if (finalized) {
            void persistence.flush();
        }
    }, [messages, workspaceRoot]);

    // 任务流水线 / 阶段提示 / 输入草稿与消息分开保存，重启后一并恢复。
    useEffect(() => {
        if (!workspaceRoot || !restoreReadyRef.current) return;
        if (Date.now() < suppressPersistUntilRef.current) return;
        const persistence = persistenceRef.current;
        if (!persistence) return;

        persistence.scheduleUiState({
            workspaceKey: normalizeWorkspaceKey(workspaceRoot),
            workspaceRoot,
            todos,
            stages: data,
            input,
            updatedAt: Date.now(),
        });
    }, [workspaceRoot, todos, data, input]);

    // 页面隐藏/关闭前尽力 flush，缩小“最后不到 1 秒内容”丢失的窗口。
    useEffect(() => {
        const persistence = persistenceRef.current;
        if (!persistence) return;

        const flush = () => { void persistence.flush(); };
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'hidden') flush();
        };
        window.addEventListener('pagehide', flush);
        window.addEventListener('beforeunload', flush);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            window.removeEventListener('pagehide', flush);
            window.removeEventListener('beforeunload', flush);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            void persistence.flush();
        };
    }, []);

    const stop = useCallback(async () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        setIsLoading(false);
        // 中止时把已生成的部分内容落库，避免恢复后只剩半截气泡却缺少工具结果。
        void persistenceRef.current?.flush();
    }, []);

    const append = useCallback(async (
        msg: { id: string, role: 'user', content: string },
        recovery?: Pick<AgentRecoveryInfo, 'requestIndex' | 'traceId'>,
    ): Promise<boolean> => {
        if (!workspaceRoot) return false;
        
        setIsLoading(true);
        setInput("");
        setData([]); 
        setStreamProgress(null);
        receivedErrorRef.current = false;
        liveAssistantSnapshotRef.current = null;

        const controller = new AbortController();
        abortControllerRef.current = controller;
        const currentTraceId = recovery?.traceId || createClientId(); // 1. 前端强制生成 TraceID

        // 构建编辑器上下文（附加到用户消息，前端聊天窗口可见 + 后端 Agent 可感知）
        const ctx = editorContextRef.current;
        let editorContext = '';
        if (ctx.activeFile) {
            if (ctx.hasSelection && ctx.selectedText) {
                editorContext = [
                    '',
                    '[附加信息 — 编辑器上下文]',
                    `文件: ${ctx.activeFile}`,
                    `选中区域: 第${ctx.startLine}行第${ctx.startColumn}列 至 第${ctx.endLine}行第${ctx.endColumn}列`,
                    '选中文本:',
                    '```',
                    ctx.selectedText,
                    '```',
                ].join('\n');
            } else {
                editorContext = [
                    '',
                    '[附加信息 — 编辑器上下文]',
                    `文件: ${ctx.activeFile}`,
                    `光标位置: 第${ctx.startLine}行第${ctx.startColumn}列`,
                ].join('\n');
            }
        }
        const userInstruct = recovery ? msg.content : msg.content + (editorContext || '');

        const userVisibleContent = capRenderedText(userInstruct, '用户输入');
        const userMsg: Message = { 
            ...msg, 
            content: userVisibleContent,
            parts: [{ id: createClientId(), type: 'text', content: userVisibleContent, timestamp: Date.now() }],
            timestamp: Date.now(),
            traceId: currentTraceId // 关联本次链路
        };
        setMessages(prev => trimMessagesForMemory([...prev, userMsg]));

        // 用户消息立即落库：即使随后崩溃/关闭应用，也不会丢失本次指令。
        persistenceRef.current?.scheduleMessage({
            id: userMsg.id,
            workspaceRoot,
            workspaceKey: normalizeWorkspaceKey(workspaceRoot),
            role: 'user',
            content: userMsg.content,
            reasoning_content: userMsg.reasoning_content,
            parts: userMsg.parts,
            timestamp: userMsg.timestamp,
            traceId: userMsg.traceId,
            isFinal: true,
        }, { immediate: true });

        // ═══════════════════════════════════════════════════════════════
        // 【性能优化 v2】统一 rAF 批量提交：将所有类型的 chunk 合并到
        // 同一个 pending buffer，每个 rAF 周期内只触发一次 React 状态更新。
        // 消除之前 text/reasoning 与 annotation/init/error/done 之间的
        // 双重 setMessages + setData 调用，大幅减少重渲染次数。
        // ═══════════════════════════════════════════════════════════════
        const currentAssistantMsgId = createClientId();
        let accumulatedUsage: TokenUsage | null = null;
        let tokenUsagePersisted = false;
        let tokenUsageWriteQueue = Promise.resolve();
        const usageRecorder = createUsageRecorder({
            messageId: currentAssistantMsgId,
            workspaceRoot,
        });
        const persistTokenUsage = (usage: TokenUsage | null) => {
            if (!usage || !Number.isFinite(usage.totalTokens) || usage.totalTokens <= 0) return;

            // 落库的是增量、并按北京自然日分桶（见 tokenUsageAccounting）：
            // 时间取真实发生时刻——否则 23:45 开始、跨过零点的长任务会把 00:00 之后的
            // 全部用量都算进前一天，状态栏「今日」在第二天长时间显示 0。
            const write = usageRecorder.record(usage);
            if (!write) return;

            // 状态栏「T/s」速率：只统计**生成**（输出）token。
            // 用量里的 prompt token 每次调用都会把整个上下文重算一遍（实测输入:输出 ≈ 100:1），
            // 混进来会把速率放大两个数量级，看起来像「没有除以窗口秒数」。
            recordTokenDelta(write.deltaOutputTokens, write.timestamp);

            tokenUsagePersisted = true;
            const record = {
                id: write.id,
                workspaceRoot: write.workspaceRoot,
                timestamp: write.timestamp,
                inputTokens: write.inputTokens,
                outputTokens: write.outputTokens,
                totalTokens: write.totalTokens,
            };
            tokenUsageWriteQueue = tokenUsageWriteQueue
                .then(() => recordTokenUsage(record))
                .catch(console.error);
        };
        const accumulateTokenUsage = (usage: TokenUsage) => {
            if (![usage.inputTokens, usage.outputTokens, usage.totalTokens].every(Number.isFinite)) return;
            accumulatedUsage = {
                inputTokens: (accumulatedUsage?.inputTokens || 0) + usage.inputTokens,
                outputTokens: (accumulatedUsage?.outputTokens || 0) + usage.outputTokens,
                totalTokens: (accumulatedUsage?.totalTokens || 0) + usage.totalTokens,
            };
            persistTokenUsage(accumulatedUsage);
        };

        // 统一的 pending 缓冲区：累积 text/reasoning delta、annotation、stage、progress、todo
        type PendingChunk =
            | { kind: 'text'; content: string; turn?: number }
            | { kind: 'reasoning'; content: string; turn?: number }
            | { kind: 'annotation'; content: string; method: string; params: any }
            | { kind: 'stage'; message: string }
            | { kind: 'progress'; progress: StreamProgress }
            | { kind: 'todo'; todos: any[] }
            | { kind: 'init'; traceId: string }
            | { kind: 'error'; content: string }
            | { kind: 'notice'; content: string; method: string; params: any }
            | { kind: 'doneText'; content: string }
            | { kind: 'usage'; usage: TokenUsage }
            | { kind: 'done'; usage: TokenUsage | null }
            | { kind: 'diagnostics'; entries: import('@/providers/AgentContext').ProblemEntry[] };

        /**
         * 消息 parts 操作流：严格保留事件到达顺序。
         * 历史上这里按「text/reasoning 先于 annotation」分组应用，导致同一批 buffer 中
         * 后到的工具 annotation 被排到先到的正文之前（或反之），长评估场景下评估报告
         * 与工具卡片渲染顺序颠倒，最终答复被工具卡片“截断”在消息末尾。
         */
        type PartOp =
            | { op: 'text'; content: string; turn?: number }
            | { op: 'reasoning'; content: string; turn?: number }
            | { op: 'annotation'; content: string; method: string; params: any }
            | { op: 'notice'; content: string; method: string; params: any };

        const pendingBufferRef: { current: PendingChunk[] } = { current: [] };
        let rafId: number | null = null;
        // 与 rafId 配合的节流定时器：保证两次 React 提交之间至少间隔
        // STREAM_FLUSH_INTERVAL_MS，避免高频 chunk 驱动 60fps 全量重渲染。
        let flushTimerId: ReturnType<typeof setTimeout> | null = null;
        let lastFlushAt = 0;
        // 目录树刷新去抖计时器：命令类工具（如下载图片的 run_powershell_command）
        // 会在文件写入工具集之外创建/修改文件，需在工具结果流式到达期间
        // 批量收敛为少量 ui:file-tree:refresh 事件，避免高频触发 listFiles
        let treeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
        const scheduleTreeRefresh = (immediate = false) => {
            if (treeRefreshTimer !== null) {
                clearTimeout(treeRefreshTimer);
                treeRefreshTimer = null;
            }
            if (immediate) {
                window.dispatchEvent(new CustomEvent('ui:file-tree:refresh'));
                return;
            }
            treeRefreshTimer = setTimeout(() => {
                treeRefreshTimer = null;
                window.dispatchEvent(new CustomEvent('ui:file-tree:refresh'));
            }, 1200);
        };
        // 标记是否需要在本次 flush 前取消已有 rAF（用于 terminal 事件立即刷新）
        let needsImmediateFlush = false;

        // 相邻同类增量合并：节流/后台（rAF 停摆）期间 pending 缓冲区可能堆积数万个
        // token 级 chunk。相邻 text/reasoning 直接拼成一个 chunk，progress/todo 只保留
        // 最后一条，既保持事件顺序，又让缓冲区大小与「类型切换次数」而非 token 数相关。
        const pushPendingChunk = (chunk: PendingChunk) => {
            const buffer = pendingBufferRef.current;
            const last = buffer.length > 0 ? buffer[buffer.length - 1] : null;
            if (last && last.kind === chunk.kind) {
                if ((chunk.kind === 'text' && last.kind === 'text') || (chunk.kind === 'reasoning' && last.kind === 'reasoning')) {
                    if (last.turn === chunk.turn) {
                        buffer[buffer.length - 1] = { ...last, content: last.content + chunk.content };
                        return;
                    }
                } else if (chunk.kind === 'progress' || chunk.kind === 'todo') {
                    buffer[buffer.length - 1] = chunk;
                    return;
                }
            }
            buffer.push(chunk);
        };

        const cancelScheduledFlush = () => {
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            if (flushTimerId !== null) {
                clearTimeout(flushTimerId);
                flushTimerId = null;
            }
        };

        const flushAllPending = () => {
            rafId = null;
            if (flushTimerId !== null) {
                clearTimeout(flushTimerId);
                flushTimerId = null;
            }
            lastFlushAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
            const buffer = pendingBufferRef.current;
            if (buffer.length === 0) return;
            pendingBufferRef.current = [];

            // ── 分离非消息状态与消息 parts 操作流 ──
            const partOps: PartOp[] = [];
            const stages: { message: string }[] = [];
            let latestProgress: StreamProgress | null = null;
            let latestTodos: any[] | null = null;
            let initTraceId: string | null = null;
            let errorContent: string | null = null;
            let doneTextContent: string | null = null;
            let doneUsage: TokenUsage | null = null;
            let isDone = false;
            const diagnosticsEntries: import('@/providers/AgentContext').ProblemEntry[] = [];

            for (const chunk of buffer) {
                switch (chunk.kind) {
                    case 'text': partOps.push({ op: 'text', content: chunk.content, turn: chunk.turn }); break;
                    case 'reasoning': partOps.push({ op: 'reasoning', content: chunk.content, turn: chunk.turn }); break;
                    case 'annotation': partOps.push({ op: 'annotation', content: chunk.content, method: chunk.method, params: chunk.params }); break;
                    case 'notice': partOps.push({ op: 'notice', content: chunk.content, method: chunk.method, params: chunk.params }); break;
                    case 'stage': stages.push(chunk); break;
                    case 'progress': latestProgress = chunk.progress; break;
                    case 'todo': latestTodos = chunk.todos; break;
                    case 'init': initTraceId = chunk.traceId; break;
                    case 'error': errorContent = chunk.content; break;
                    case 'doneText': doneTextContent = chunk.content; break;
                    case 'usage': accumulateTokenUsage(chunk.usage); break;
                    case 'done':
                        isDone = true;
                        doneUsage = chunk.usage;
                        break;
                    case 'diagnostics': diagnosticsEntries.push(...chunk.entries); break;
                }
            }

            if (isDone && !tokenUsagePersisted) {
                persistTokenUsage(accumulatedUsage?.totalTokens ? accumulatedUsage : doneUsage);
            }

            // ── 提交 messages（严格按事件到达顺序合并 text/reasoning/annotation/init/error/done） ──
            const hasMessageChanges = partOps.length > 0
                || initTraceId !== null || errorContent !== null || isDone || doneTextContent !== null;

            if (hasMessageChanges) {
                setMessages(prev => {
                    const next = [...prev];
                    let lastIndex = next.length - 1;
                    let last = next[lastIndex];

                    // done 事件幂等：若最后一条 assistant 消息已处于终态，且本次
                    // 增量仅包含重复的 done 事件，则不再新建空白终态消息
                    // （避免重复 done 生成空消息气泡并污染历史记录）
                    if (isDone && last && last.role === "assistant" && last.isFinal
                        && partOps.length === 0 && errorContent === null
                        && initTraceId === null) {
                        return next;
                    }

                    if (!last || last.role !== "assistant" || last.isFinal) {
                        last = {
                            id: currentAssistantMsgId,
                            role: "assistant",
                            content: "",
                            parts: [],
                            timestamp: Date.now(),
                        };
                        next.push(last);
                        lastIndex = next.length - 1;
                    } else {
                        last = { ...last, parts: [...(last.parts || [])] };
                        next[lastIndex] = last;
                    }

                    // init
                    if (initTraceId) last.traceId = initTraceId;

                    // 单遍按事件顺序应用 parts：
                    // 仅当「当前最后一个 part」与 delta 同类型且同 turn 时才合并，
                    // 否则新建 part —— 这样 tool annotation 与正文的相对顺序
                    // 永远与后端 emit 顺序一致，不会出现分组重排导致的颠倒。
                    for (const op of partOps) {
                        if (op.op === 'reasoning') {
                            const partIndex = last.parts.length - 1;
                            const currentPart = last.parts[partIndex];
                            if (!currentPart || currentPart.type !== 'reasoning' || (op.turn !== undefined && (currentPart as any).turn !== op.turn)) {
                                const limited = appendLimitedLiveText('', op.content, '推理文本', LIVE_REASONING_PART_LIMIT);
                                const nextPart: MessagePart = { id: createClientId(), type: 'reasoning', content: limited.content, params: { liveText: limited.meta }, timestamp: Date.now() };
                                (nextPart as any).turn = op.turn;
                                last.parts.push(nextPart);
                            } else {
                                const limited = appendLimitedLiveText(currentPart.content || '', op.content, '推理文本', LIVE_REASONING_PART_LIMIT, currentPart.params?.liveText);
                                last.parts[partIndex] = { ...currentPart, content: limited.content, params: { ...(currentPart.params || {}), liveText: limited.meta } };
                            }
                            last.reasoning_content = undefined;
                        } else if (op.op === 'text') {
                            const partIndex = last.parts.length - 1;
                            const currentPart = last.parts[partIndex];
                            if (!currentPart || currentPart.type !== 'text' || (op.turn !== undefined && (currentPart as any).turn !== op.turn)) {
                                const limited = appendLimitedLiveText('', op.content, '回复正文', LIVE_TEXT_PART_LIMIT);
                                const nextPart: MessagePart = { id: createClientId(), type: 'text', content: limited.content, params: { liveText: limited.meta }, timestamp: Date.now() };
                                (nextPart as any).turn = op.turn;
                                last.parts.push(nextPart);
                            } else {
                                const limited = appendLimitedLiveText(currentPart.content || '', op.content, '回复正文', LIVE_TEXT_PART_LIMIT, currentPart.params?.liveText);
                                last.parts[partIndex] = { ...currentPart, content: limited.content, params: { ...(currentPart.params || {}), liveText: limited.meta } };
                            }
                            const contentLimited = appendLimitedLiveText(last.content || '', op.content, '回复正文', LIVE_TEXT_PART_LIMIT, (last as any).contentMeta);
                            last.content = contentLimited.content;
                            (last as any).contentMeta = contentLimited.meta;
                        } else if (op.op === 'notice') {
                            last.parts.push({
                                id: createClientId(),
                                type: 'notice',
                                content: op.content,
                                method: op.method,
                                params: op.params,
                                timestamp: Date.now(),
                            });
                        } else {
                            // annotation：按到达顺序插入 parts，避免被后续正文“插队”
                            // 预计算工具参数 JSON 字符串，避免 JSX render 中每帧重复 JSON.stringify
                            const precomputedArgsJson = op.method === 'tool/call' && op.params?.args
                                ? JSON.stringify(op.params.args, null, 2)
                                : undefined;
                            last.parts.push({
                                id: createClientId(),
                                type: 'annotation',
                                content: op.content,
                                method: op.method,
                                params: precomputedArgsJson !== undefined
                                    ? { ...op.params, _argsJson: precomputedArgsJson }
                                    : op.params,
                                timestamp: Date.now(),
                            });
                        }
                    }

                    // error
                    if (errorContent) {
                        last.parts.push({ id: createClientId(), type: 'error', content: errorContent, timestamp: Date.now() });
                        last.isFinal = true;
                    }

                    // 防御：若消息中尚未包含任何文本答复（例如全部步骤仅调用了工具），
                    // 采用 done 携带的结论正文作为兜底文本，避免前端展示空白气泡或让用户无法理解最终结果
                    if (doneTextContent && (!last.content || !last.content.trim()) && !last.parts.some(p => p.type === 'text')) {
                        const limited = appendLimitedLiveText('', doneTextContent, '回复正文', LIVE_TEXT_PART_LIMIT);
                        last.parts.push({
                            id: createClientId(),
                            type: 'text',
                            content: limited.content,
                            params: { liveText: limited.meta },
                            timestamp: Date.now(),
                        });
                        last.content = limited.content;
                        (last as any).contentMeta = limited.meta;
                    }

                    // done：持久化由 messages 副作用统一完成（最后一条 assistant 且 isFinal=true 时立即 flush），
                    // 不再在此直接写 IndexedDB，避免与流式快照写入互相覆盖。
                    if (isDone) {
                        last.isFinal = true;
                    }

                    // 记录本轮 assistant 消息的最新快照：流结束时用它做终态兜底落库，
                    // 不依赖 React 副作用是否已经执行（否则最后一段内容会丢在队列外）。
                    if (last.role === 'assistant') {
                        liveAssistantSnapshotRef.current = {
                            ...last,
                            parts: Array.isArray(last.parts) ? [...last.parts] : [],
                        };
                    }

                    return trimMessagesForMemory(next);
                });
            }

            // ── 提交 stages ──
            if (stages.length > 0) {
                setData(prev => {
                    const next = [...prev];
                    for (const s of stages) {
                        next.push({ type: 'stage', message: s.message, timestamp: Date.now() });
                    }
                    return next.slice(-MAX_STAGE_ITEMS);
                });
            }

            // ── 提交 progress ──
            if (latestProgress) {
                setStreamProgress(latestProgress);
            }

            // ── 提交 todos ──
            if (latestTodos) {
                setTodos(latestTodos);
            }

            // ── 提交 diagnostics ──
            if (diagnosticsEntries.length > 0) {
                addProblems(diagnosticsEntries);
            }
        };

        // 窗口最小化/被遮挡时 rAF 不会回调，但 Agent 仍在持续产出 token。
        // 此时改为直接提交，避免 pending 缓冲区在后台无限增长、回到前台时一次性爆发。
        const scheduleFlushFrame = () => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
                flushAllPending();
                return;
            }
            rafId = requestAnimationFrame(flushAllPending);
        };

        const scheduleFlush = () => {
            if (rafId !== null || flushTimerId !== null || needsImmediateFlush) return;
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            const elapsed = now - lastFlushAt;
            if (elapsed >= STREAM_FLUSH_INTERVAL_MS) {
                scheduleFlushFrame();
            } else {
                flushTimerId = setTimeout(() => {
                    flushTimerId = null;
                    scheduleFlushFrame();
                }, STREAM_FLUSH_INTERVAL_MS - elapsed);
            }
        };

        // ── 统一的 Chunk 处理器（Electron IPC 和 Web SSE 共用） ──
        const processStreamChunk = (chunk: any) => {
            // terminal 事件：init / error / done → 立即刷新所有 pending + 本次数据
            const isTerminal = chunk.type === 'init' || chunk.type === 'error' || chunk.type === 'done';

            if (isTerminal) {
                cancelScheduledFlush();
                needsImmediateFlush = true;
            }

            // ── 路由到 pending buffer ──
            if (chunk.type === 'stage') {
                pushPendingChunk({ kind: 'stage', message: chunk.content });
            } else if (chunk.method === 'todo/update' && chunk.params?.todos) {
                pushPendingChunk({ kind: 'todo', todos: chunk.params.todos });
            } else if (chunk.type === 'progress') {
                pushPendingChunk({
                    kind: 'progress',
                    progress: {
                        receivedChars: Number(chunk.receivedChars) || 0,
                        contentChars: Number(chunk.contentChars) || 0,
                        reasoningChars: Number(chunk.reasoningChars) || 0,
                        toolArgumentChars: Number(chunk.toolArgumentChars) || 0,
                        deltaChars: Number(chunk.deltaChars) || 0,
                        channel: chunk.channel,
                        toolName: chunk.toolName,
                        turn: chunk.turn,
                        updatedAt: chunk.timestamp || Date.now(),
                    },
                });
            } else if (chunk.type === 'text') {
                pushPendingChunk({ kind: 'text', content: chunk.content || '', turn: chunk.turn });
            } else if (chunk.type === 'reasoning') {
                pushPendingChunk({ kind: 'reasoning', content: chunk.content || '', turn: chunk.turn });
            } else if (chunk.type === 'notice') {
                pushPendingChunk({
                    kind: 'notice',
                    content: chunk.content || chunk.message || '',
                    method: chunk.code || chunk.method || 'notice',
                    params: chunk.params,
                });
            } else if (chunk.type === 'annotation') {
                const sanitized = sanitizeAnnotationParams(chunk.method, chunk.params);
                pushPendingChunk({
                    kind: 'annotation',
                    content: chunk.content || chunk.method || '',
                    method: chunk.method,
                    params: sanitized,
                });
                // 提取语法检查结果 → diagnostics
                if (chunk.method === 'tool/result' && sanitized?.result?.syntaxCheck) {
                    const sc = sanitized.result.syntaxCheck;
                    const diags = sc.diagnostics || [];
                    if (diags.length > 0) {
                        const entries = diags.map((d: any) => ({
                            filePath: sc.path || '',
                            line: d.line,
                            column: d.column,
                            message: d.message || '未知错误',
                            severity: (sc.status === 'ok' ? 'info' : 'error') as 'error' | 'warning' | 'info',
                            code: sc.checker,
                            checker: sc.checker,
                            timestamp: Date.now(),
                        }));
                        pushPendingChunk({ kind: 'diagnostics', entries });
                    }
                }
                // 文件写入/编辑工具执行成功后，通知编辑器刷新
                // detail 同时携带相对 path 与绝对 absolutePath，供 FileEditor 归一化匹配
                const fileWriteTools = new Set([
                    'write_file',
                    'replace_in_file',
                    'insert_in_file',
                    'replace_all_in_file',
                    'delete_path',
                    // 兼容历史（宾+动）命名与其他别名
                    'file_write',
                    'file_replace',
                    'file_insert',
                    'file_replace_all',
                    'create_file',
                    'apply_patch',
                ]);
                // 命令/终端类工具可能间接创建、下载、删除文件
                // （如 run_powershell_command 的 Invoke-WebRequest 下载图片到 docs/images/），
                // 其结果不携带 filePath，但仍必须触发目录树刷新
                const shellTools = new Set([
                    'run_powershell_command',
                    'run_cmd_command',
                    'execute_command',
                    'terminal_execute',
                    'run_terminal_command',
                ]);
                if (chunk.method === 'tool/result') {
                    const toolName = chunk.params?.toolName;
                    if (fileWriteTools.has(toolName)) {
                        const filePath = chunk.params?.filePath;
                        if (filePath && typeof filePath === 'string') {
                            window.dispatchEvent(new CustomEvent('ui:file:changed', {
                                detail: { path: filePath, absolutePath: chunk.params?.absolutePath },
                            }));
                        }
                        scheduleTreeRefresh();
                    } else if (shellTools.has(toolName)) {
                        scheduleTreeRefresh();
                    }
                }
            } else if (chunk.type === 'usage') {
                const usage = chunk.usage as TokenUsage | null;
                if (usage && typeof usage === 'object') {
                    pushPendingChunk({ kind: 'usage', usage });
                }
            } else if (chunk.type === 'init') {
                pushPendingChunk({ kind: 'init', traceId: chunk.traceId });
            } else if (chunk.type === 'error') {
                receivedErrorRef.current = true;
                pushPendingChunk({ kind: 'error', content: chunk.content || chunk.message || 'An internal error occurred' });
            } else if (chunk.type === 'done') {
                const doneText = typeof chunk.content === 'string' ? chunk.content.trim() : '';
                if (doneText && doneText !== 'Processing complete') {
                    pushPendingChunk({ kind: 'doneText', content: doneText });
                }
                pushPendingChunk({ kind: 'done', usage: chunk.usage || null });
                // 回合结束：无论工具类型，兜底刷新目录树，
                // 覆盖命令类工具（下载图片等）造成的文件系统变化
                scheduleTreeRefresh(true);
            }

            // ── 刷新策略 ──
            if (isTerminal) {
                // terminal 事件：立即刷新
                flushAllPending();
                needsImmediateFlush = false;
            } else {
                // 非 terminal 事件：通过 rAF 延迟批量刷新
                scheduleFlush();
            }
        };

        try {
            const activeProvider = settings?.providers?.find(p => p.id === provider) || settings?.providers?.[0];
            const defaultEffort: 'default' | 'low' | 'high' | 'max' =
                activeProvider?.defaultReasoningEffort === 'max' ? 'max'
                    : activeProvider?.defaultReasoningEffort === 'low' ? 'low'
                    : activeProvider?.defaultReasoningEffort === 'default' ? 'default'
                        : 'high';
            const shouldEnableThinking = activeProvider?.enableThinking !== false;

            const reasoningEffortValue = shouldEnableThinking
                ? ((): 'default' | 'low' | 'high' | 'max' => {
                    try {
                        const v = window.localStorage.getItem('reasoning_effort');
                        if (v === 'default' || v === 'low' || v === 'high' || v === 'max') return v;
                        return defaultEffort;
                    } catch {
                        return defaultEffort;
                    }
                })()
                : undefined;

            // ═══════════════════════════════════════
            // Electron IPC 路径
            // ═══════════════════════════════════════
            await electronBridge.startAgentChat(
                {
                    userId: USER_ID,
                    userInstruct,
                    root: workspaceRoot,
                    locale,
                    provider,
                    model,
                    traceId: currentTraceId,
                    reasoningEffort: reasoningEffortValue,
                    recoveryRequestIndex: recovery?.requestIndex,
                },
                (chunk) => {
                    processStreamChunk(chunk);
                },
                controller.signal
            );
            
            // 流结束后刷新 pending
            cancelScheduledFlush();
            flushAllPending();
            return !receivedErrorRef.current && !controller.signal.aborted;
        } catch (e: any) { 
            // 异常时也刷新剩余的 pending
            cancelScheduledFlush();
            flushAllPending();
            // 异常终止同样兜底刷新目录树
            scheduleTreeRefresh(true);

            if (e.name === 'AbortError') {
                console.log("SSE Request Aborted");
            } else {
                console.error("SSE Connection Error:", e);
                // 若错误已通过流内 error 事件渲染过，则不再重复创建错误消息，
                // 避免同一错误在界面中出现两次。
                if (receivedErrorRef.current) return false;
                const errorMsg: Message = { 
                    id: createClientId(), 
                    role: 'assistant', 
                    content: "Error: " + e.message, 
                    parts: [{ id: createClientId(), type: 'error', content: e.message, timestamp: Date.now() }],
                    timestamp: Date.now(),
                    isFinal: true
                };
                setMessages(prev => trimMessagesForMemory([...prev, errorMsg]));
            }
            return false;
        } finally { 
            cancelScheduledFlush();
            setIsLoading(false); 
            abortControllerRef.current = null;

            // ── 终态兜底落库（不依赖 React 副作用时序） ──
            // 流结束（正常/异常/中止）时把本轮 assistant 消息以 isFinal 立即写入 IndexedDB：
            // 1) React 的 setMessages 是异步提交，若此处只 flush 队列，最后一段内容还没入队就会丢；
            // 2) 应用紧接着被关闭时，未提交的快照会让重启后「本轮内容缺失」。
            const snapshot = liveAssistantSnapshotRef.current as Message | null;
            liveAssistantSnapshotRef.current = null;
            // 用户刚点过「清空历史会话」时不要再把本轮快照写回（否则清空后数据重现）
            if (snapshot && Date.now() >= suppressPersistUntilRef.current) {
                const finalRow = buildFinalizedRow(
                    {
                        id: snapshot.id,
                        role: 'assistant',
                        content: snapshot.content,
                        reasoning_content: snapshot.reasoning_content,
                        parts: snapshot.parts,
                        timestamp: snapshot.timestamp,
                        traceId: snapshot.traceId,
                        isFinal: true,
                    },
                    workspaceRoot,
                    normalizeWorkspaceKey(workspaceRoot),
                );
                persistedSignatureRef.current.set(finalRow.id, messagePersistSignature(finalRow));
                persistenceRef.current?.scheduleMessage(finalRow as ChatMessage, { immediate: true });
                // 状态侧同步补上终态标记，避免该消息在本次会话里一直停留在「流式中」分支
                setMessages(prev => prev.map(m => (
                    m.id === finalRow.id && !m.isFinal ? { ...m, isFinal: true } : m
                )));
            }

            // 兜底 flush：确保队列里剩余快照（含工具结果）全部落库。
            void persistenceRef.current?.flush();
            if (treeRefreshTimer !== null) {
                clearTimeout(treeRefreshTimer);
                treeRefreshTimer = null;
            }
        }
    }, [workspaceRoot, locale, provider, model, settings]);

    const resume = useCallback(async (recovery: Pick<AgentRecoveryInfo, 'requestIndex' | 'traceId'>) => {
        return append({
            id: createClientId(),
            role: 'user',
            content: '继续完成上次未完成的对话任务',
        }, recovery);
    }, [append]);

    const clearHistory = useCallback(async () => {
        if (!workspaceRoot) return;
        // 注意：确认交互由 UI 层的自定义弹窗完成。
        // 禁止在此使用 window.confirm —— Electron 中原生对话框关闭后会破坏渲染窗口的
        // 键盘焦点状态，导致输入框长时间无法聚焦（Chromium 已知 bug）。

        // 先把队列里尚未完成的写入 flush 完，再丢弃快照并短暂抑制写入，
        // 避免「清空事务」与「在途写事务」交错导致旧数据被写回。
        const persistence = persistenceRef.current;
        if (persistence) {
            await persistence.flush();
            persistence.clearPending();
        }
        suppressPersistUntilRef.current = Date.now() + 3000;

        try {
            // Electron 模式：通过 IPC 调用主进程清空会话（含 TODO 持久化清理）
            await electronBridge.clearSession({ userId: USER_ID, workspaceRoot });
        } catch (e) {
            // 服务端清空失败不应阻塞本地 UI 内容的删除
            console.error("Failed to clear server session:", e);
        }

        try {
            // 清空本地 IndexedDB（消息 + UI 状态）
            await clearWorkspaceChatHistory(workspaceRoot);
        } catch (e) {
            console.error("Failed to clear local chat history:", e);
        } finally {
            // 无论 IndexedDB 删除是否成功，都先清空当前 UI（失败时数据会在下次启动时重现）
            setMessages([]);
            setInput("");
            setData([]);
            setStreamProgress(null);
            setTodos([]);
            // 清空本地缓存指纹，避免旧消息的落库记录影响新一轮写入
            restoredMessageIdsRef.current = new Set();
            persistedSignatureRef.current = new Map();
            liveAssistantSnapshotRef.current = null;
        }
    }, [workspaceRoot, setTodos]);

    const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
        setInput(e.target.value);
    }, []);

    const handleSubmit = useCallback(async (e?: React.FormEvent) => {
        if (e) e.preventDefault();
        if (!input.trim() || isLoading) return;
        await append({ id: createClientId(), role: 'user', content: input });
    }, [input, isLoading, append]);

    return {
        messages,
        input,
        setInput,
        isLoading,
        data,
        streamProgress,
        handleInputChange,
        handleSubmit,
        clearHistory,
        append,
        resume,
        stop
    };
}
