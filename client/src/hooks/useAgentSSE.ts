import { useState, useCallback, useEffect, useRef } from "react";
import Dexie from "dexie";
import { USER_ID, API_BASE } from "@/config";
import { useAgentContext, useTodoContext, useProblemContext } from "@/providers/AgentContext";
import { db } from "@/services/db";
import { createClientId } from "@/utils/id";
import { electronBridge } from "@/services/electron-bridge";

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
    const { locale, workspaceRoot, provider, model, settings } = useAgentContext();
    const { setTodos } = useTodoContext();
    const { addProblems } = useProblemContext();
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
        if (!electronBridge.isElectron) {
            try {
                await fetch(`${API_BASE}/api/chat/stop`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ userId: USER_ID, workspaceRoot })
                });
            } catch (e) {
                console.error("Failed to stop chat:", e);
            }
        }
        setIsLoading(false);
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
        const userInstruct = msg.content + (editorContext || '');

        const userVisibleContent = capRenderedText(userInstruct, '用户输入');
        const userMsg: Message = { 
            ...msg, 
            content: userVisibleContent,
            parts: [{ id: createClientId(), type: 'text', content: userVisibleContent, timestamp: Date.now() }],
            timestamp: Date.now(),
            traceId: currentTraceId // 关联本次链路
        };
        setMessages(prev => trimMessagesForMemory([...prev, userMsg]));

        // ═══════════════════════════════════════════════════════════════
        // 【性能优化 v2】统一 rAF 批量提交：将所有类型的 chunk 合并到
        // 同一个 pending buffer，每个 rAF 周期内只触发一次 React 状态更新。
        // 消除之前 text/reasoning 与 annotation/init/error/done 之间的
        // 双重 setMessages + setData 调用，大幅减少重渲染次数。
        // ═══════════════════════════════════════════════════════════════
        const currentAssistantMsgId = createClientId();

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
            | { kind: 'done' }
            | { kind: 'diagnostics'; entries: import('@/providers/AgentContext').ProblemEntry[] };

        const pendingBufferRef: { current: PendingChunk[] } = { current: [] };
        let rafId: number | null = null;
        // 标记是否需要在本次 flush 前取消已有 rAF（用于 terminal 事件立即刷新）
        let needsImmediateFlush = false;

        const flushAllPending = () => {
            rafId = null;
            const buffer = pendingBufferRef.current;
            if (buffer.length === 0) return;
            pendingBufferRef.current = [];

            // ── 分离不同类型 ──
            const textDeltas: { content: string; turn?: number }[] = [];
            const reasoningDeltas: { content: string; turn?: number }[] = [];
            const annotations: { content: string; method: string; params: any }[] = [];
            const stages: { message: string }[] = [];
            let latestProgress: StreamProgress | null = null;
            let latestTodos: any[] | null = null;
            let initTraceId: string | null = null;
            let errorContent: string | null = null;
            let isDone = false;
            const diagnosticsEntries: import('@/providers/AgentContext').ProblemEntry[] = [];

            for (const chunk of buffer) {
                switch (chunk.kind) {
                    case 'text': textDeltas.push(chunk); break;
                    case 'reasoning': reasoningDeltas.push(chunk); break;
                    case 'annotation': annotations.push(chunk); break;
                    case 'stage': stages.push(chunk); break;
                    case 'progress': latestProgress = chunk.progress; break;
                    case 'todo': latestTodos = chunk.todos; break;
                    case 'init': initTraceId = chunk.traceId; break;
                    case 'error': errorContent = chunk.content; break;
                    case 'done': isDone = true; break;
                    case 'diagnostics': diagnosticsEntries.push(...chunk.entries); break;
                }
            }

            // ── 提交 messages（合并 text/reasoning/annotation/init/error/done） ──
            const hasMessageChanges = textDeltas.length > 0 || reasoningDeltas.length > 0
                || annotations.length > 0 || initTraceId !== null || errorContent !== null || isDone;

            if (hasMessageChanges) {
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

                    // init
                    if (initTraceId) last.traceId = initTraceId;

                    // 合并连续的同类 delta 为大块，减少 parts 内的段数
                    const mergedTextDeltas: { content: string; turn?: number }[] = [];
                    for (const d of textDeltas) {
                        const prev = mergedTextDeltas[mergedTextDeltas.length - 1];
                        if (prev && prev.turn === d.turn) { prev.content += d.content; }
                        else { mergedTextDeltas.push({ ...d }); }
                    }
                    const mergedReasoningDeltas: { content: string; turn?: number }[] = [];
                    for (const d of reasoningDeltas) {
                        const prev = mergedReasoningDeltas[mergedReasoningDeltas.length - 1];
                        if (prev && prev.turn === d.turn) { prev.content += d.content; }
                        else { mergedReasoningDeltas.push({ ...d }); }
                    }

                    // reasoning deltas
                    for (const delta of mergedReasoningDeltas) {
                        const partIndex = last.parts.length - 1;
                        const currentPart = last.parts[partIndex];
                        if (!currentPart || currentPart.type !== 'reasoning' || (delta.turn !== undefined && (currentPart as any).turn !== delta.turn)) {
                            const limited = appendLimitedLiveText('', delta.content, '推理文本', LIVE_REASONING_PART_LIMIT);
                            const nextPart: MessagePart = { id: createClientId(), type: 'reasoning', content: limited.content, params: { liveText: limited.meta }, timestamp: Date.now() };
                            (nextPart as any).turn = delta.turn;
                            last.parts.push(nextPart);
                        } else {
                            const limited = appendLimitedLiveText(currentPart.content || '', delta.content, '推理文本', LIVE_REASONING_PART_LIMIT, currentPart.params?.liveText);
                            last.parts[partIndex] = { ...currentPart, content: limited.content, params: { ...(currentPart.params || {}), liveText: limited.meta } };
                        }
                        last.reasoning_content = undefined;
                    }

                    // text deltas
                    for (const delta of mergedTextDeltas) {
                        const partIndex = last.parts.length - 1;
                        const currentPart = last.parts[partIndex];
                        if (!currentPart || currentPart.type !== 'text' || (delta.turn !== undefined && (currentPart as any).turn !== delta.turn)) {
                            const limited = appendLimitedLiveText('', delta.content, '回复正文', LIVE_TEXT_PART_LIMIT);
                            const nextPart: MessagePart = { id: createClientId(), type: 'text', content: limited.content, params: { liveText: limited.meta }, timestamp: Date.now() };
                            (nextPart as any).turn = delta.turn;
                            last.parts.push(nextPart);
                        } else {
                            const limited = appendLimitedLiveText(currentPart.content || '', delta.content, '回复正文', LIVE_TEXT_PART_LIMIT, currentPart.params?.liveText);
                            last.parts[partIndex] = { ...currentPart, content: limited.content, params: { ...(currentPart.params || {}), liveText: limited.meta } };
                        }
                        const contentLimited = appendLimitedLiveText(last.content || '', delta.content, '回复正文', LIVE_TEXT_PART_LIMIT, (last as any).contentMeta);
                        last.content = contentLimited.content;
                        (last as any).contentMeta = contentLimited.meta;
                    }

                    // annotations
                    for (const ann of annotations) {
                        // 预计算工具参数 JSON 字符串，避免 JSX render 中每帧重复 JSON.stringify
                        const precomputedArgsJson = ann.method === 'tool/call' && ann.params?.args
                            ? JSON.stringify(ann.params.args, null, 2)
                            : undefined;
                        last.parts.push({
                            id: createClientId(),
                            type: 'annotation',
                            content: ann.content,
                            method: ann.method,
                            params: precomputedArgsJson !== undefined
                                ? { ...ann.params, _argsJson: precomputedArgsJson }
                                : ann.params,
                            timestamp: Date.now(),
                        });
                    }

                    // error
                    if (errorContent) {
                        last.parts.push({ id: createClientId(), type: 'error', content: errorContent, timestamp: Date.now() });
                        last.isFinal = true;
                    }

                    // done
                    if (isDone) {
                        last.isFinal = true;
                        db.chatHistory.put({ ...sanitizeMessageForClient(userMsg), workspaceRoot }).catch(console.error);
                        db.chatHistory.put({ ...sanitizeMessageForClient(last), workspaceRoot }).catch(console.error);
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

        const scheduleFlush = () => {
            if (rafId === null && !needsImmediateFlush) {
                rafId = requestAnimationFrame(flushAllPending);
            }
        };

        // ── 统一的 Chunk 处理器（Electron IPC 和 Web SSE 共用） ──
        const processStreamChunk = (chunk: any) => {
            // terminal 事件：init / error / done → 立即刷新所有 pending + 本次数据
            const isTerminal = chunk.type === 'init' || chunk.type === 'error' || chunk.type === 'done';

            if (isTerminal) {
                if (rafId !== null) {
                    cancelAnimationFrame(rafId);
                    rafId = null;
                }
                needsImmediateFlush = true;
            }

            // ── 路由到 pending buffer ──
            if (chunk.type === 'stage') {
                pendingBufferRef.current.push({ kind: 'stage', message: chunk.content });
            } else if (chunk.method === 'todo/update' && chunk.params?.todos) {
                pendingBufferRef.current.push({ kind: 'todo', todos: chunk.params.todos });
            } else if (chunk.type === 'progress') {
                pendingBufferRef.current.push({
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
                pendingBufferRef.current.push({ kind: 'text', content: chunk.content || '', turn: chunk.turn });
            } else if (chunk.type === 'reasoning') {
                pendingBufferRef.current.push({ kind: 'reasoning', content: chunk.content || '', turn: chunk.turn });
            } else if (chunk.type === 'annotation') {
                const sanitized = sanitizeAnnotationParams(chunk.method, chunk.params);
                pendingBufferRef.current.push({
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
                        pendingBufferRef.current.push({ kind: 'diagnostics', entries });
                    }
                }
                // 文件写入/编辑工具执行成功后，通知编辑器刷新
                // detail 同时携带相对 path 与绝对 absolutePath，供 FileEditor 归一化匹配
                const fileWriteTools = new Set(['file_write', 'file_replace', 'file_insert', 'file_replace_all', 'delete_path']);
                if (chunk.method === 'tool/result' && fileWriteTools.has(chunk.params?.toolName)) {
                    const filePath = chunk.params?.filePath;
                    if (filePath && typeof filePath === 'string') {
                        window.dispatchEvent(new CustomEvent('ui:file:changed', {
                            detail: { path: filePath, absolutePath: chunk.params?.absolutePath },
                        }));
                    }
                }
            } else if (chunk.type === 'init') {
                pendingBufferRef.current.push({ kind: 'init', traceId: chunk.traceId });
            } else if (chunk.type === 'error') {
                pendingBufferRef.current.push({ kind: 'error', content: chunk.content || chunk.message || 'An internal error occurred' });
            } else if (chunk.type === 'done') {
                pendingBufferRef.current.push({ kind: 'done' });
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
            const defaultEffort = activeProvider?.defaultReasoningEffort === 'max' ? 'max' : 'high';
            const shouldEnableThinking = activeProvider?.enableThinking !== false;

            const reasoningEffortValue = shouldEnableThinking
                ? ((): 'high' | 'max' => {
                    try {
                        const v = window.localStorage.getItem('reasoning_effort');
                        if (v === 'max' || v === 'high') return v;
                        return defaultEffort;
                    } catch {
                        return defaultEffort;
                    }
                })()
                : undefined;

            // ═══════════════════════════════════════
            // Electron IPC 路径（替换 SSE fetch）
            // ═══════════════════════════════════════
            if (electronBridge.isElectron) {
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
                    },
                    (chunk) => {
                        processStreamChunk(chunk);
                    },
                    controller.signal
                );
                
                // 流结束后刷新 pending
                if (rafId !== null) {
                    cancelAnimationFrame(rafId);
                    rafId = null;
                }
                flushAllPending();
            } else {

            // ═══════════════════════════════════════
            // Web SSE 路径（原有逻辑）
            // ═══════════════════════════════════════
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
                    traceId: currentTraceId,
                    reasoningEffort: reasoningEffortValue,
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
                            
                            // 统一使用 processStreamChunk（与 Electron IPC 路径共享逻辑）
                            processStreamChunk(chunk);
                        } catch (e) {
                            console.error("Failed to parse SSE chunk", e, dataString);
                        }
                    }
                }
            }

            // 流式结束后刷新所有尚未提交的 pending
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            flushAllPending();
            } // 结束 else 块（Web SSE 路径）
        } catch (e: any) { 
            // 异常时也刷新剩余的 pending
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            flushAllPending();

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
        // 注意：确认交互由 UI 层的自定义弹窗完成。
        // 禁止在此使用 window.confirm —— Electron 中原生对话框关闭后会破坏渲染窗口的
        // 键盘焦点状态，导致输入框长时间无法聚焦（Chromium 已知 bug）。
        try {
            if (electronBridge.isElectron) {
                // Electron 模式：通过 IPC 调用主进程清空会话（含 TODO 持久化清理）
                await electronBridge.clearSession({ userId: USER_ID, workspaceRoot });
            } else {
                // Web 模式：通过 HTTP API 清空会话
                await fetch(`${API_BASE}/api/chat/clear`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ userId: USER_ID, workspaceRoot })
                });
            }
            // 清空本地 IndexedDB
            await db.chatHistory.where("workspaceRoot").equals(workspaceRoot).delete();
            setMessages([]);
            setInput("");
            setData([]);
            setStreamProgress(null);
            setTodos([]);
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
