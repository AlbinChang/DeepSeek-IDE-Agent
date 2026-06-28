import { useState, useCallback, useEffect, useRef, startTransition } from "react";
import Dexie from "dexie";
import { USER_ID, API_BASE } from "@/config";
import { useAgentContext } from "@/providers/AgentContext";
import { db } from "@/services/db";
import { createClientId } from "@/utils/id";

export interface MessagePart {
    id: string;
    type: 'reasoning' | 'text' | 'stage' | 'annotation' | 'error' | 'meta';
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

    if (toolName === 'file_write') {
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
    reasoning_content: undefined,
    parts: Array.isArray(message.parts) ? message.parts.map(sanitizeMessagePart) : [],
});

export function useAgentSSE() {
    const { locale, workspaceRoot, setTodos, provider, model, settings } = useAgentContext();
    const [messages, setMessages] = useState<Message[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [input, setInput] = useState("");
    const [data, setData] = useState<any[]>([]); 
    const [streamProgress, setStreamProgress] = useState<StreamProgress | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);

    // 编辑器上下文：监听当前激活文件与选中范围，用于附加到用户指令
    const editorContextRef = useRef<{
        activeFile: string;
        hasSelection: boolean;
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
    }>({
        activeFile: '',
        hasSelection: false,
        startLine: 0,
        startColumn: 0,
        endLine: 0,
        endColumn: 0,
    });

    useEffect(() => {
        const handleFileActive = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            const nextFile = (detail?.activeFile || '').trim();
            editorContextRef.current = {
                ...editorContextRef.current,
                activeFile: nextFile,
                // 文件切换时重置选中状态，避免旧文件的选中信息污染新文件
                hasSelection: false,
                startLine: 0,
                startColumn: 0,
                endLine: 0,
                endColumn: 0,
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
        if (workspaceRoot) {
            db.chatHistory.where('[workspaceRoot+timestamp]')
                .between([workspaceRoot, Dexie.minKey], [workspaceRoot, Dexie.maxKey])
                .reverse()
                .limit(MAX_HISTORY_MESSAGES)
                .toArray()
                .then(history => {
                    const typedHistory = history
                        .sort((a, b) => a.timestamp - b.timestamp)
                        .map(h => sanitizeMessageForClient({
                            ...h,
                            parts: (h as any).parts || [{ id: createClientId(), type: 'text', content: (h as any).content, timestamp: (h as any).timestamp }]
                        } as any)) as Message[];
                    setMessages(trimMessagesForMemory(typedHistory));
                });
        } else {
            setMessages([]);
        }
    }, [workspaceRoot]);

    const stop = useCallback(async () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        try {
            await fetch(`${API_BASE}/api/chat/stop`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId: USER_ID, workspaceRoot })
            });
        } catch (e) {
            console.error("Failed to stop chat:", e);
        } finally {
            setIsLoading(false);
        }
    }, [workspaceRoot]);

    const append = useCallback(async (msg: { id: string, role: 'user', content: string }) => {
        if (!workspaceRoot) return;
        
        setIsLoading(true);
        setInput("");
        setData([]); 
        setStreamProgress(null);

        const controller = new AbortController();
        abortControllerRef.current = controller;
        const currentTraceId = createClientId(); // 1. 前端强制生成 TraceID

        const userVisibleContent = capRenderedText(msg.content, '用户输入');
        const userMsg: Message = { 
            ...msg, 
            content: userVisibleContent,
            parts: [{ id: createClientId(), type: 'text', content: userVisibleContent, timestamp: Date.now() }],
            timestamp: Date.now(),
            traceId: currentTraceId // 关联本次链路
        };
        setMessages(prev => trimMessagesForMemory([...prev, userMsg]));

        // 【性能优化】批量累积 text/reasoning delta，通过 rAF 合并多次 setMessages 调用
        // 避免每个 SSE chunk（每秒可能 20-50 个）都触发完整的 React 状态更新
        // 注意：这些变量必须在 try 块之前声明，因为 catch/finally 块需要访问它们
        const currentAssistantMsgId = createClientId();
        type PendingDelta = 
            | { type: 'text'; content: string; turn?: number }
            | { type: 'reasoning'; content: string; turn?: number };
        const pendingDeltasRef: { current: PendingDelta[] } = { current: [] };
        let rafId: number | null = null;

        const flushPendingDeltas = () => {
            rafId = null;
            const deltas = pendingDeltasRef.current;
            if (deltas.length === 0) return;
            pendingDeltasRef.current = [];

            // 合并连续的同类 delta 为大块，减少 parts 内的段数
            const merged: PendingDelta[] = [];
            for (const d of deltas) {
                const last = merged[merged.length - 1];
                if (last && last.type === d.type && last.turn === d.turn) {
                    last.content += d.content;
                } else {
                    merged.push({ ...d });
                }
            }

            // 构建单个 setMessages 更新函数
            setMessages(prev => {
                const next = [...prev];
                let lastIndex = next.length - 1;
                let last = next[lastIndex];

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

                for (const delta of merged) {
                    if (delta.type === 'reasoning') {
                        const partIndex = last.parts.length - 1;
                        const currentPart = last.parts[partIndex];
                        const nextContent = delta.content;

                        if (!currentPart || currentPart.type !== 'reasoning' || (delta.turn !== undefined && (currentPart as any).turn !== delta.turn)) {
                            const limited = appendLimitedLiveText('', nextContent, '推理文本', LIVE_REASONING_PART_LIMIT);
                            const nextPart: MessagePart = { id: createClientId(), type: 'reasoning', content: limited.content, params: { liveText: limited.meta }, timestamp: Date.now() };
                            (nextPart as any).turn = delta.turn;
                            last.parts.push(nextPart);
                        } else {
                            const limited = appendLimitedLiveText(currentPart.content || '', nextContent, '推理文本', LIVE_REASONING_PART_LIMIT, currentPart.params?.liveText);
                            last.parts[partIndex] = { ...currentPart, content: limited.content, params: { ...(currentPart.params || {}), liveText: limited.meta } };
                        }
                        last.reasoning_content = undefined;
                    } else {
                        // text
                        const partIndex = last.parts.length - 1;
                        const currentPart = last.parts[partIndex];
                        const nextContent = delta.content;

                        if (!currentPart || currentPart.type !== 'text' || (delta.turn !== undefined && (currentPart as any).turn !== delta.turn)) {
                            const limited = appendLimitedLiveText('', nextContent, '回复正文', LIVE_TEXT_PART_LIMIT);
                            const nextPart: MessagePart = { id: createClientId(), type: 'text', content: limited.content, params: { liveText: limited.meta }, timestamp: Date.now() };
                            (nextPart as any).turn = delta.turn;
                            last.parts.push(nextPart);
                        } else {
                            const limited = appendLimitedLiveText(currentPart.content || '', nextContent, '回复正文', LIVE_TEXT_PART_LIMIT, currentPart.params?.liveText);
                            last.parts[partIndex] = { ...currentPart, content: limited.content, params: { ...(currentPart.params || {}), liveText: limited.meta } };
                        }

                        const contentLimited = appendLimitedLiveText(last.content || '', nextContent, '回复正文', LIVE_TEXT_PART_LIMIT, (last as any).contentMeta);
                        last.content = contentLimited.content;
                        (last as any).contentMeta = contentLimited.meta;
                    }
                }

                return trimMessagesForMemory(next);
            });
        };

        const scheduleFlush = () => {
            if (rafId === null) {
                rafId = requestAnimationFrame(flushPendingDeltas);
            }
        };

        // 构建用户指令：若有打开文件且有文本选中，附加文件路径与行列区间
        const ctx = editorContextRef.current;
        const hasAttachedContext = !!(ctx.activeFile && ctx.hasSelection);
        const userInstruct = hasAttachedContext
            ? `${msg.content}\n\n[当前文件: ${ctx.activeFile} | 选中: L${ctx.startLine}:${ctx.startColumn}-L${ctx.endLine}:${ctx.endColumn}]`
            : msg.content;

        try {
            const activeProvider = settings?.providers?.find(p => p.id === provider) || settings?.providers?.[0];
            const defaultEffort = activeProvider?.defaultReasoningEffort === 'max' ? 'max' : 'high';
            const shouldEnableThinking = activeProvider?.enableThinking !== false;

            const res = await fetch(`${API_BASE}/api/chat/sse`, {
                method: "POST", 
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ 
                    userId: USER_ID, 
                    userInstruct, 
                    root: workspaceRoot, 
                    locale,
                    provider,
                    model,
                    traceId: currentTraceId, // 2. 强制透传给后端
                    // 2026.04: 思考强度 (high | max)；从 localStorage 读取，前端 UI 会写入
                    reasoningEffort: shouldEnableThinking
                        ? ((): 'high' | 'max' => {
                            try {
                                const v = window.localStorage.getItem('reasoning_effort');
                                if (v === 'max' || v === 'high') return v;
                                return defaultEffort;
                            } catch {
                                return defaultEffort;
                            }
                        })()
                        : undefined
                }),
                signal: controller.signal
            });

            if (!res.ok) {
                const errorData = await res.json().catch(() => ({}));
                throw new Error(errorData.error || "Request failed");
            }

            const reader = res.body?.getReader();
            if (!reader) throw new Error("ReadableStream not available");

            const decoder = new TextDecoder();
            let buf = "";
            const processedSseIds = new Set<string>();
            const processedSseIdQueue: string[] = [];

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                buf += decoder.decode(value, { stream: true });
                
                let boundary = buf.indexOf("\n\n");
                while (boundary !== -1) {
                    const block = buf.substring(0, boundary).trim();
                    buf = buf.substring(boundary + 2);
                    boundary = buf.indexOf("\n\n");

                    if (!block) continue;
                    
                    const lines = block.split("\n");
                    let dataString = "";
                    let eventName = "";
                    for (const line of lines) {
                        if (line.startsWith("data:")) {
                            dataString += line.substring(5).trim();
                        } else if (line.startsWith("event:")) {
                            eventName = line.substring(6).trim();
                        }
                    }
                    
                    if (eventName === "heartbeat") continue;

                    if (dataString) {
                        try {
                            const chunk = JSON.parse(dataString);
                            const sseId = (chunk as any).sseId;

                            if (sseId) {
                                if (processedSseIds.has(sseId)) continue;
                                processedSseIds.add(sseId);
                                processedSseIdQueue.push(sseId);
                                if (processedSseIdQueue.length > 5000) {
                                    const oldId = processedSseIdQueue.shift();
                                    if (oldId) processedSseIds.delete(oldId);
                                }
                            }
                            
                            if (chunk.type === 'stage') {
                                startTransition(() => {
                                    setData(prev => [...prev, { type: 'stage', message: chunk.content, timestamp: chunk.timestamp || Date.now() }].slice(-MAX_STAGE_ITEMS));
                                });
                                continue;
                            }

                            if (chunk.method === 'todo/update' && chunk.params?.todos) {
                                startTransition(() => setTodos(chunk.params.todos));
                                continue;
                            }

                            if (chunk.type === 'progress') {
                                startTransition(() => {
                                    setStreamProgress({
                                        receivedChars: Number(chunk.receivedChars) || 0,
                                        contentChars: Number(chunk.contentChars) || 0,
                                        reasoningChars: Number(chunk.reasoningChars) || 0,
                                        toolArgumentChars: Number(chunk.toolArgumentChars) || 0,
                                        deltaChars: Number(chunk.deltaChars) || 0,
                                        channel: chunk.channel,
                                        toolName: chunk.toolName,
                                        turn: chunk.turn,
                                        updatedAt: chunk.timestamp || Date.now()
                                    });
                                });
                                continue;
                            }

                            // 【性能优化】text/reasoning 事件：累积到 pendingDeltasRef，通过 rAF 批量刷新
                            if (chunk.type === 'text' || chunk.type === 'reasoning') {
                                // 先刷新已有的非 delta 事件（如之前的 annotation）
                                if (rafId !== null) {
                                    cancelAnimationFrame(rafId);
                                    flushPendingDeltas();
                                }
                                pendingDeltasRef.current.push({
                                    type: chunk.type,
                                    content: chunk.content || "",
                                    turn: chunk.turn,
                                });
                                scheduleFlush();
                                continue;
                            }

                            // 非 text/reasoning 事件（annotation、error、done、init）：先刷新 pending deltas，再立即更新
                            if (rafId !== null) {
                                cancelAnimationFrame(rafId);
                                flushPendingDeltas();
                            }

                            // 预计算 annotation 参数（在 setMessages 外部执行，避免阻塞状态更新）
                            const sanitizedAnnotationParams = chunk.type === 'annotation'
                                ? sanitizeAnnotationParams(chunk.method, chunk.params)
                                : undefined;

                            setMessages(prev => {
                                const next = [...prev];
                                let lastIndex = next.length - 1;
                                let last = next[lastIndex];

                                if (!last || last.role !== "assistant" || (last.isFinal && chunk.type !== 'done' && chunk.type !== 'error' && chunk.type !== 'init')) {
                                    last = { 
                                        id: currentAssistantMsgId, 
                                        role: "assistant", 
                                        content: "", 
                                        parts: [], 
                                        timestamp: Date.now(),
                                        traceId: chunk.traceId
                                    };
                                    next.push(last);
                                    lastIndex = next.length - 1;
                                } else {
                                    last = { ...last, parts: [...(last.parts || [])] };
                                    next[lastIndex] = last;
                                }

                                // 注意: text/reasoning 事件已通过上方的批量累积路径处理（rAF 批量刷新），
                                // 此处 switch 仅处理 annotation/error/done/init 等非 delta 事件
                                switch (chunk.type) {
                                    case "init":
                                        last.traceId = chunk.traceId;
                                        break;
                                    case "annotation":
                                        last.parts.push({
                                            id: createClientId(),
                                            type: 'annotation',
                                            content: chunk.content || chunk.method || "",
                                            method: chunk.method,
                                            params: sanitizedAnnotationParams,  // 预计算，避免在 setMessages 内重复执行
                                            timestamp: Date.now()
                                        });
                                        break;
                                    case "error":
                                        last.parts.push({ 
                                            id: createClientId(), 
                                            type: 'error', 
                                            content: chunk.content || chunk.message || "An internal error occurred", 
                                            timestamp: Date.now() 
                                        });
                                        last.isFinal = true;
                                        break;
                                    case "done":
                                        last.isFinal = true;
                                        // 全面落库（异步，不阻塞 UI 更新）
                                        db.chatHistory.put({ ...sanitizeMessageForClient(userMsg), workspaceRoot }).catch(console.error);
                                        db.chatHistory.put({ ...sanitizeMessageForClient(last), workspaceRoot }).catch(console.error);
                                        break;
                                }

                                return trimMessagesForMemory(next);
                            });
                        } catch (e) {
                            console.error("Failed to parse SSE chunk", e, dataString);
                        }
                    }
                }
            }

            // 【性能优化】流式结束后刷新所有尚未提交的 delta
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            flushPendingDeltas();
        } catch (e: any) { 
            // 异常时也刷新剩余的 delta
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            flushPendingDeltas();

            if (e.name === 'AbortError') {
                console.log("SSE Request Aborted");
            } else {
                console.error("SSE Connection Error:", e);
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
        } finally { 
            setIsLoading(false); 
            abortControllerRef.current = null;
        }
    }, [workspaceRoot, locale, provider, model, settings]);

    const clearHistory = useCallback(async () => {
        if (!workspaceRoot) return;
        if (!window.confirm("确定清空当前工作区的会话历史吗？")) return;
        
        try {
            await fetch(`${API_BASE}/api/chat/clear`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId: USER_ID, workspaceRoot })
            });
            await db.chatHistory.where("workspaceRoot").equals(workspaceRoot).delete();
            setMessages([]);
            setData([]);
            setStreamProgress(null);
            setTodos([]); // 2026.03: 显式清空前端 Todo 状态 (防止 UI 滞留)
        } catch (e) {
            console.error("Failed to clear history:", e);
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
        stop
    };
}
