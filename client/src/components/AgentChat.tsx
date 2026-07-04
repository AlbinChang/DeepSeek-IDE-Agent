import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAgentSSE } from '@/hooks/useAgentSSE';
import { Send, Loader2, Settings, Box, User, Cpu, Square, Trash2, CheckCircle2, XCircle, Brain, Copy, ClipboardCheck, ChevronDown } from 'lucide-react';
import { TodoList } from './TodoList';
import { SettingsModal } from '@/components/SettingsModal';
import { LazySyntaxHighlighter } from './LazySyntaxHighlighter';
import { useAgentContext, useTodoContext } from '@/providers/AgentContext';
import { USER_ID, API_BASE } from '@/config';
import { electronBridge } from '@/services/electron-bridge';
import type { Message, MessagePart, StreamProgress } from '@/hooks/useAgentSSE';

interface ChatMessageItemProps {
    message: Message;
    isLastItem: boolean;
    isLoading: boolean;
    isThinkingExpanded: boolean;
    onToggleThinking: () => void;
    markdownComponentsWithCode: any;
    markdownComponentsTextOnly: any;
}

const toolArgNumberFormatter = new Intl.NumberFormat('zh-CN');

const formatToolArgMeta = (meta: any): string | null => {
    if (!meta || !meta.redacted) return null;
    const parts: string[] = [];
    const totalContentChars = Number(meta.totalContentChars || 0);
    const redactedStringChars = Number(meta.redactedStringChars || 0);
    const fileCount = Number(meta.fileCount || 0);
    if (fileCount > 0) parts.push(`${toolArgNumberFormatter.format(fileCount)} 个文件`);
    if (totalContentChars > 0) parts.push(`${toolArgNumberFormatter.format(totalContentChars)} 个正文字符`);
    else if (redactedStringChars > 0) parts.push(`${toolArgNumberFormatter.format(redactedStringChars)} 个长文本字符`);
    if (Number(meta.truncatedItems || 0) > 0) parts.push(`省略 ${toolArgNumberFormatter.format(Number(meta.truncatedItems))} 项`);
    if (Number(meta.truncatedKeys || 0) > 0) parts.push(`省略 ${toolArgNumberFormatter.format(Number(meta.truncatedKeys))} 个字段`);
    return parts.length > 0 ? `已隐藏大文本参数：${parts.join('，')}` : '已隐藏大文本参数';
};

const ChatMessageItem: React.FC<ChatMessageItemProps> = React.memo(({
    message,
    isLastItem,
    isLoading,
    isThinkingExpanded,
    onToggleThinking,
    markdownComponentsWithCode,
    markdownComponentsTextOnly,
}) => {
    const parts = message.parts && message.parts.length > 0 ? message.parts : [];
    // 流式传输中且当前消息尚未完成 → 文本用纯文本渲染，避免 ReactMarkdown 每 16ms 重新解析整棵 AST
    const isStreaming = isLoading && isLastItem && !message.isFinal;

    return (
        <div className={'message-item flex flex-col ' + (message.role === 'user' ? 'items-end' : 'items-start')}>
            <div className='flex items-center gap-2 mb-1 px-1'>
                {message.role === 'assistant' ? (
                    <div className='flex items-center gap-1.5'>
                        <div className='w-3 h-3 bg-emerald-600 rounded-sm flex items-center justify-center'>
                            <Cpu className='w-2 h-2 text-white' />
                        </div>
                        <span className='text-[8pt] font-black uppercase tracking-[0.15em] text-emerald-500'>智能助手</span>
                    </div>
                ) : (
                    <div className='flex items-center gap-1.5'>
                        <div className='w-3 h-3 bg-white/10 rounded-sm flex items-center justify-center'>
                            <User className='w-2 h-2 text-white/60' />
                        </div>
                        <span className='text-[8pt] font-black uppercase tracking-[0.15em] text-white/40'>用户</span>
                    </div>
                )}
            </div>
            <div className={'max-w-[100%] w-full rounded-lg p-3 text-[8pt] ' + (message.role === 'user' ? 'bg-white/5 border border-white/10' : 'bg-transparent border-l border-emerald-500/20')}>
                {parts.length > 0 ? (
                    parts.map(part => (
                        <div key={part.id} className='mb-3 last:mb-0'>
                            {part.type === 'reasoning' && (
                                <div className='group flex flex-col gap-1.5'>
                                    <div
                                        onClick={onToggleThinking}
                                        className='flex items-center gap-2 text-[9px] text-emerald-500/60 font-medium cursor-pointer hover:bg-emerald-500/10 transition-all uppercase tracking-widest bg-emerald-500/5 px-2 py-0.5 rounded border border-emerald-500/10 w-fit'
                                    >
                                        <div className={'w-1 h-1 rounded-full bg-emerald-500/40 ' + (isLoading && isLastItem ? 'animate-pulse' : '')} />
                                        {isThinkingExpanded ? '收起内核推理' : '展开思维链'}
                                    </div>
                                    {isThinkingExpanded && (
                                        <div className='text-[8pt] text-white/70 font-mono bg-white/[0.01] p-2.5 rounded border border-white/5 italic whitespace-pre-wrap leading-snug shadow-inner overflow-hidden relative'>
                                            <div className='absolute top-0 left-0 w-0.5 h-full bg-emerald-500/20' />
                                            {part.content}
                                            {isLoading && isLastItem && part.content && !message.content && (
                                                <span className='inline-block w-1.5 h-3 ml-1 bg-emerald-500/40 animate-pulse align-middle' />
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}
                            {part.type === 'text' && (
                                message.role === 'user' ? (
                                    <div className='text-white/85 leading-normal font-sans text-[8pt] whitespace-pre-wrap'>
                                        {part.content || ''}
                                    </div>
                                ) : isStreaming ? (
                                    /* 流式传输中：纯文本渲染，跳过 ReactMarkdown AST 解析，消除每帧卡顿 */
                                    <div className='text-white/85 leading-normal font-sans text-[8pt] whitespace-pre-wrap break-words'>
                                        {part.content || ''}
                                    </div>
                                ) : (
                                    <div className='prose prose-invert prose-emerald prose-sm max-w-none text-white/85 leading-normal font-sans text-[8pt]'>
                                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponentsWithCode}>
                                            {part.content || ''}
                                        </ReactMarkdown>
                                    </div>
                                )
                            )}
                            {part.type === 'annotation' && part.method === 'tool/call' && (
                                <div className='my-2 overflow-hidden rounded border border-white/10 bg-white/[0.02]'>
                                    <div className='flex items-center gap-2 px-3 py-1.5 bg-white/5 border-b border-white/10'>
                                        <div className='w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse' />
                                        <span className='text-[8pt] font-bold text-amber-500/80 tracking-tighter'>正在调用: {part.params?.toolName}</span>
                                    </div>
                                    <div className='p-2 bg-black/20'>
                                        {formatToolArgMeta(part.params?.argsMeta) && (
                                            <div className='mb-2 rounded border border-amber-500/15 bg-amber-500/5 px-2 py-1 text-[7.5pt] font-medium text-amber-200/70'>
                                                {formatToolArgMeta(part.params?.argsMeta)}
                                            </div>
                                        )}
                                        <pre className='text-[7pt] text-white/40 overflow-x-auto font-mono'>
                                            {/* 使用预处理后的 JSON 字符串，避免 render 中重复 JSON.stringify */}
                                            {part.params?._argsJson ?? ''}
                                        </pre>
                                    </div>
                                </div>
                            )}
                            {part.type === 'annotation' && (part.method === 'tool/result' || part.method === 'tool/error') && (() => {
                                const res = part.params?.result;
                                const isErr = !!part.params?.error || res?.status === 'error';
                                const toolName = part.params?.toolName;
                                return (
                                    <div className={`my-2 overflow-hidden rounded border ${isErr ? 'border-red-500/20 bg-red-500/5' : 'border-white/10 bg-emerald-500/5'}`}>
                                        <div className={`flex items-center gap-2 px-3 py-1 border-b border-white/5 ${isErr ? 'bg-red-500/10' : 'bg-emerald-500/10'}`}>
                                            {isErr
                                                ? <XCircle className='w-3 h-3 text-red-400/70' />
                                                : <CheckCircle2 className='w-3 h-3 text-emerald-500/60' />}
                                            <span className={`text-[8pt] font-bold tracking-tighter ${isErr ? 'text-red-400/70' : 'text-emerald-500/60'}`}>
                                                {isErr ? '执行失败' : '执行成功'}: {toolName}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })()}
                            {part.type === 'error' && (
                                <div className='my-2 p-2 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-[8pt] flex items-center gap-2'>
                                    <div className='w-1 h-1 rounded-full bg-red-500' />
                                    {part.content}
                                </div>
                            )}
                        </div>
                    ))
                ) : (
                    message.role === 'user' ? (
                        <div className='text-white/85 leading-normal font-sans text-[8pt] whitespace-pre-wrap'>
                            {message.content || ''}
                        </div>
                    ) : isStreaming ? (
                        <div className='text-white/85 leading-normal font-sans text-[8pt] whitespace-pre-wrap break-words'>
                            {message.content || ''}
                        </div>
                    ) : (
                        <div className='prose prose-invert prose-emerald prose-sm max-w-none text-white/85 leading-normal font-sans text-[8pt]'>
                            <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                components={markdownComponentsTextOnly}
                            >
                                {message.content || ''}
                            </ReactMarkdown>
                        </div>
                    )
                )}
            </div>
        </div>
    );
}, (prevProps, nextProps) => {
    // 自定义比较：避免已完成的 message 因数组引用变化而重渲染
    // 仅当以下条件之一满足时才重渲染：
    // 1. message id 变化（不同消息）
    if (prevProps.message.id !== nextProps.message.id) return false;
    // 2. isLastItem / isLoading 变化
    if (prevProps.isLastItem !== nextProps.isLastItem) return false;
    if (prevProps.isLoading !== nextProps.isLoading) return false;
    // 3. isThinkingExpanded / onToggleThinking 变化
    if (prevProps.isThinkingExpanded !== nextProps.isThinkingExpanded) return false;
    if (prevProps.onToggleThinking !== nextProps.onToggleThinking) return false;
    // 4. 对于已完成的消息 (isFinal)，永不重渲染
    if (nextProps.message.isFinal && prevProps.message.isFinal) return true;
    // 5. 对于流式消息，比较 parts 长度和最后一个 part 的 content
    const prevLen = prevProps.message.parts?.length ?? 0;
    const nextLen = nextProps.message.parts?.length ?? 0;
    if (prevLen !== nextLen) return false;
    // 比较 content 摘要（对于长 content 来说很轻量）
    if (prevProps.message.content !== nextProps.message.content) return false;
    // markdownComponents 引用比较（useMemo 保证了稳定性）
    if (prevProps.markdownComponentsWithCode !== nextProps.markdownComponentsWithCode) return false;
    if (prevProps.markdownComponentsTextOnly !== nextProps.markdownComponentsTextOnly) return false;
    return true;
});

export const AgentChat: React.FC = () => {
    const { messages, input, setInput, handleInputChange, handleSubmit, isLoading, stop, data, streamProgress, clearHistory } = useAgentSSE();
    const { todos } = useTodoContext();
    const { workspaceRoot, provider, model, settings, setProvider } = useAgentContext();
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [isThinkingExpanded, setIsThinkingExpanded] = useState(true);
    const [isProviderMenuOpen, setIsProviderMenuOpen] = useState(false);
    const [copyState, setCopyState] = useState<'idle' | 'success' | 'error'>('idle');
    const [copyFeedback, setCopyFeedback] = useState('');
    const providerMenuRef = useRef<HTMLDivElement>(null);
    const copyResetTimerRef = useRef<number | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // 2026.04: 思考强度控制 (DeepSeek V4 / Gemini 3 均支持 reasoning_effort: high | max)
    // 默认 high，复杂 Agent 场景建议切换到 max。持久化到 localStorage，避免刷新丢失。
    const [reasoningEffort, setReasoningEffortState] = useState<'high' | 'max'>(() => {
        const saved = typeof window !== 'undefined' ? window.localStorage.getItem('reasoning_effort') : null;
        return saved === 'max' ? 'max' : 'high';
    });
    const setReasoningEffort = (v: 'high' | 'max') => {
        setReasoningEffortState(v);
        try { window.localStorage.setItem('reasoning_effort', v); } catch { /* ignore */ }
    };

    const [instructHistory, setInstructHistory] = useState<string[]>([]);
    const [historyIndex, setHistoryIndex] = useState<number>(-1);
    const [tempInput, setTempInput] = useState<string>('');

    // 本地历史持久化 key（按工作区隔离）
    const historyStorageKey = workspaceRoot ? `instruct_history_${workspaceRoot.replace(/[^a-zA-Z0-9\-_]/g, '_')}` : null;

    // 初次加载和回车发送后加载记录
    const fetchInstructHistory = async () => {
        if (!workspaceRoot) return;
        // Electron 模式：从 localStorage 读取本地历史
        if (electronBridge.isElectron) {
            try {
                const raw = historyStorageKey ? localStorage.getItem(historyStorageKey) : null;
                const parsed = raw ? JSON.parse(raw) : [];
                setInstructHistory(Array.isArray(parsed) ? parsed : []);
            } catch {
                setInstructHistory([]);
            }
            return;
        }
        try {
            const res = await fetch(`${API_BASE}/api/chat/instructs?userId=${USER_ID}&workspace=${encodeURIComponent(workspaceRoot)}`);
            const _data = await res.json();
            if (Array.isArray(_data)) {
                setInstructHistory(_data);
            }
        } catch (error) {
            console.error('Failed to fetch instruct history:', error);
        }
    };

    // 本地保存用户指令到 localStorage（Electron 模式）
    // 存储顺序：[最新, ..., 最旧]，与 ArrowUp 从 index 0 开始匹配
    const saveLocalInstruct = useCallback((content: string) => {
        if (!electronBridge.isElectron || !historyStorageKey || !content.trim()) return;
        try {
            const raw = localStorage.getItem(historyStorageKey);
            const existing: string[] = raw ? JSON.parse(raw) : [];
            // 去重：避免连续相同指令
            if (existing.length > 0 && existing[0] === content.trim()) return;
            // 前置插入，最新在前，最多 50 条
            const updated = [content.trim(), ...existing].slice(0, 50);
            localStorage.setItem(historyStorageKey, JSON.stringify(updated));
        } catch { /* ignore */ }
    }, [historyStorageKey]);

    // 监听新用户消息 → 自动保存到本地历史
    useEffect(() => {
        if (!electronBridge.isElectron || messages.length === 0) return;
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.role === 'user' && lastMsg?.content) {
            saveLocalInstruct(String(lastMsg.content));
            // 刷新列表
            fetchInstructHistory();
        }
    }, [messages.length]);

    useEffect(() => {
        fetchInstructHistory();
    }, [messages.length, workspaceRoot]); // 根据消息数和工作区变化重新获取最新记录

    // 快捷键支持：Enter 发送，Shift+Enter 换行，上/下箭头滚动历史记录
    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            setHistoryIndex(-1);
            setTempInput('');
            handleSubmit(e as any);
        } else if (e.key === 'ArrowUp') {
            // 对于单行文本随时允许翻阅历史；对于多行文本，仅当光标位于最初始位置时允许翻阅
            const isFirstLine = !e.currentTarget.value.includes('\n') || e.currentTarget.selectionStart === 0;
            if (isFirstLine && instructHistory.length > 0) {
                e.preventDefault();
                const nextIndex = historyIndex + 1;
                if (nextIndex < instructHistory.length) {
                    if (historyIndex === -1) {
                        setTempInput(input);
                    }
                    setHistoryIndex(nextIndex);
                    setInput(instructHistory[nextIndex]);
                }
            }
        } else if (e.key === 'ArrowDown') {
            if (historyIndex > -1) {
                e.preventDefault();
                const nextIndex = historyIndex - 1;
                setHistoryIndex(nextIndex);
                if (nextIndex === -1) {
                    setInput(tempInput);
                } else {
                    setInput(instructHistory[nextIndex]);
                }
            }
        }
    };

    const customHandleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        if (historyIndex !== -1) {
            setHistoryIndex(-1);
        }
        handleInputChange(e);
    };

    // 获取当前正在进行的 Stage 状态
    const currentStage = useMemo(() => {
        if (!isLoading) return null;
        const stages = data.filter(d => d.type === 'stage');
        return stages.length > 0 ? stages[stages.length - 1].message : null;
    }, [data, isLoading]);

    const numberFormatter = useMemo(() => new Intl.NumberFormat('zh-CN'), []);

    const formatProgressCount = useCallback((value: number) => {
        return numberFormatter.format(Math.max(0, Math.floor(value || 0)));
    }, [numberFormatter]);

    const getProgressLabel = useCallback((progress: StreamProgress | null) => {
        if (!progress) return null;
        if (progress.channel === 'tool_arguments') {
            return progress.toolName ? `工具参数 ${progress.toolName}` : '工具参数';
        }
        if (progress.channel === 'reasoning') return '推理文本';
        if (progress.channel === 'content') return '回复正文';
        return '模型输出';
    }, []);

    const currentProgressLabel = useMemo(() => getProgressLabel(streamProgress), [getProgressLabel, streamProgress]);

    const activeProviderConfig = useMemo(() => {
        return settings?.providers?.find(p => p.id === provider) || settings?.providers?.[0];
    }, [settings, provider]);

    const isConfigReady = useMemo(() => {
        if (!activeProviderConfig) return false;
        const hasModel = !!activeProviderConfig.modelId?.trim();
        const hasBaseURL = !!activeProviderConfig.baseURL?.trim();
        const hasApiKey = !!activeProviderConfig.apiKey?.trim();
        return hasModel && hasBaseURL && hasApiKey;
    }, [activeProviderConfig]);
    const thinkingEnabled = activeProviderConfig?.enableThinking !== false;

    const scrollRef = useRef<HTMLDivElement>(null);
    const bottomAnchorRef = useRef<HTMLDivElement>(null);
    const lastScrollHeightRef = useRef<number>(0);
    const isAutoScrollingRef = useRef<boolean>(true); // 追踪用户是否手动向上滚动，若是则暂停自动贴底
    const isProgrammaticScrollRef = useRef<boolean>(false);
    const lastScrollTopRef = useRef<number>(0);
    const scrollRafRef = useRef<number | null>(null);

    const normalizeExternalHref = useCallback((href?: string) => {
        const raw = String(href || '').trim();
        if (!raw) return '#';
        if (/^(https?:|mailto:|tel:)/i.test(raw)) return raw;
        if (raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('#')) return raw;
        return '#';
    }, []);

    const renderExternalLink = useCallback(({ href, children }: { href?: string; children: React.ReactNode }) => (
        <a
            href={normalizeExternalHref(href)}
            target='_blank'
            rel='noopener noreferrer nofollow'
            className='text-emerald-300/90 underline decoration-emerald-500/40 hover:decoration-emerald-300/80 transition-colors'
        >
            {children}
        </a>
    ), [normalizeExternalHref]);

    const markdownComponentsWithCode = useMemo(() => ({
        a: ({ href, children }: any) => renderExternalLink({ href, children }),
        code({ inline, className, children, ...props }: any) {
            const match = /language-(\w+)/.exec(className || '');
            return !inline && match ? (
                <LazySyntaxHighlighter
                    language={match[1]}
                    PreTag='div'
                    className='rounded border border-white/10 !bg-black/40 my-1 !p-1.5 !text-[8pt] font-mono'
                    codeTagProps={{ style: { lineHeight: '1.0', display: 'block' } }}
                    customStyle={{ lineHeight: '1.0' }}
                    {...props}
                >
                    {String(children).replace(/\n$/, '')}
                </LazySyntaxHighlighter>
            ) : (
                <code className='bg-white/10 px-1 py-0.5 rounded text-emerald-400 font-mono text-[8pt]' {...props}>{children}</code>
            );
        }
    }), [renderExternalLink]);

    const markdownComponentsTextOnly = useMemo(() => ({
        a: ({ href, children }: any) => renderExternalLink({ href, children })
    }), [renderExternalLink]);

    const toggleThinkingExpanded = useCallback(() => {
        setIsThinkingExpanded(prev => !prev);
    }, []);

    // 自动滚动到底部逻辑：当消息更新或 loading 状态变化时触发
    const scrollToBottom = (force: boolean = false) => {
        const container = scrollRef.current;
        if (!container) return;

        const { scrollHeight, clientHeight, scrollTop } = container;
        const distanceToBottom = scrollHeight - scrollTop - clientHeight;
        const isNearBottom = distanceToBottom < 160;
        const hasNewContent = scrollHeight > lastScrollHeightRef.current;

        if (!force && !(isAutoScrollingRef.current && (isNearBottom || hasNewContent || isLoading))) {
            lastScrollHeightRef.current = scrollHeight;
            return;
        }

        isProgrammaticScrollRef.current = true;
        // 仅使用 scrollTop 设置，避免 scrollIntoView 触发额外的强制回流
        container.scrollTop = container.scrollHeight;
        lastScrollHeightRef.current = container.scrollHeight;
        // 延迟重置标记，防止 handleScroll 误判
        requestAnimationFrame(() => {
            isProgrammaticScrollRef.current = false;
        });
    };

    // 记录上次滚动调度时间戳，流式期间每 ~50ms 最多滚动一次，避免布局颠簸
    const lastScrollScheduleRef = useRef<number>(0);
    const SCROLL_THROTTLE_MS = 50;

    const scheduleScrollToBottom = (force: boolean = false) => {
        const now = performance.now();
        // 非强制模式下，流式传输期间限制滚动频率
        if (!force && isLoading && now - lastScrollScheduleRef.current < SCROLL_THROTTLE_MS) {
            return;
        }
        lastScrollScheduleRef.current = now;

        if (scrollRafRef.current) {
            cancelAnimationFrame(scrollRafRef.current);
        }
        scrollRafRef.current = requestAnimationFrame(() => {
            scrollToBottom(force);
            scrollRafRef.current = null;
        });
    };

    // 监听用户滚动行为，判断是否需要暂停自动贴底
    const handleScroll = () => {
        if (!scrollRef.current) return;
        if (isProgrammaticScrollRef.current) return;

        const { scrollHeight, clientHeight, scrollTop } = scrollRef.current;
        const distanceToBottom = scrollHeight - scrollTop - clientHeight;
        const movingUp = scrollTop < lastScrollTopRef.current;
        lastScrollTopRef.current = scrollTop;

        if (movingUp && distanceToBottom > 220) {
            // 仅在“明显向上离开底部”时才关闭自动贴底，避免高频更新时误触发。
            isAutoScrollingRef.current = false;
            return;
        }

        if (distanceToBottom < 120) {
            isAutoScrollingRef.current = true;
        }
    };

    // 监听实时消息流（messages 内部 content 的变化）
    // 使用 useEffect 而非 useLayoutEffect：scheduleScrollToBottom 内部已用 rAF 异步调度，
    // 无需同步阻塞布局计算，避免高频 streaming 时阻塞主线程绘制。
    useEffect(() => {
        if (isLoading || isAutoScrollingRef.current) {
            scheduleScrollToBottom(false);
        }
    }, [messages, data, todos, isLoading, isThinkingExpanded]);

    useEffect(() => {
        if (!scrollRef.current) return;
        
        const observer = new ResizeObserver(() => {
            scheduleScrollToBottom(false);
        });
        
        const container = scrollRef.current;
        observer.observe(container);

        const chatContainer = container.closest('.flex.flex-col.h-full');
        const pipeline = chatContainer?.querySelector('.mission-pipeline-container');
        if (pipeline) observer.observe(pipeline);
        
        return () => observer.disconnect();
    }, []);

    // 监听关键状态变化
    useEffect(() => {
        // 当 Loading 结束时，强制执行一次不带平滑动画的滚动，确保 done 后的最终渲染可见
        if (!isLoading) {
            const timer = window.setTimeout(() => scheduleScrollToBottom(true), 80);
            return () => window.clearTimeout(timer);
        }
    }, [isLoading]);

    useEffect(() => {
        return () => {
            if (scrollRafRef.current) {
                cancelAnimationFrame(scrollRafRef.current);
            }
        };
    }, []);

    useEffect(() => {
        return () => {
            if (copyResetTimerRef.current) {
                window.clearTimeout(copyResetTimerRef.current);
            }
        };
    }, []);

    useEffect(() => {
        if (!isProviderMenuOpen) return;

        const handlePointerDown = (event: MouseEvent) => {
            if (!providerMenuRef.current?.contains(event.target as Node)) {
                setIsProviderMenuOpen(false);
            }
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsProviderMenuOpen(false);
            }
        };

        window.addEventListener('mousedown', handlePointerDown);
        window.addEventListener('keydown', handleKeyDown);

        return () => {
            window.removeEventListener('mousedown', handlePointerDown);
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [isProviderMenuOpen]);

    const getWaterfallParts = (m: Message): MessagePart[] => {
        if (m.parts && m.parts.length > 0) return m.parts;
        return [];
    };

    const formatTimestamp = (timestamp?: number): string => {
        if (!timestamp) return 'N/A';
        try {
            return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
        } catch {
            return String(timestamp);
        }
    };

    const stringifyPayload = (value: unknown): string => {
        if (value === undefined) return 'undefined';
        if (typeof value === 'string') return value;
        try {
            return JSON.stringify(value, null, 2);
        } catch {
            return String(value);
        }
    };

    const formatMessagePart = (part: MessagePart): string => {
        switch (part.type) {
            case 'reasoning':
                return part.content ? `[REASONING]\n${part.content}` : '';
            case 'text':
                return part.content || '';
            case 'stage':
                return part.content ? `[STAGE]\n${part.content}` : '';
            case 'annotation': {
                const toolName = part.params?.toolName || 'unknown-tool';
                if (part.method === 'tool/call') {
                    return `[TOOL_CALL] ${toolName}\nARGS:\n${stringifyPayload(part.params?.args ?? {})}`;
                }
                if (part.method === 'tool/result') {
                    const hasError = !!part.params?.error || part.params?.result?.status === 'error';
                    const statusText = hasError ? 'ERROR' : 'OK';
                    const payload = hasError
                        ? (part.params?.error || part.params?.result || part.content)
                        : (part.params?.result ?? part.content);
                    return `[TOOL_RESULT:${statusText}] ${toolName}\n${stringifyPayload(payload)}`;
                }
                if (part.method === 'tool/error') {
                    return `[TOOL_RESULT:ERROR] ${toolName}\n${stringifyPayload(part.params?.error || part.content)}`;
                }
                return `[ANNOTATION:${part.method || 'unknown'}]\n${stringifyPayload(part.params ?? part.content)}`;
            }
            case 'error':
                return `[ERROR]\n${part.content || 'Unknown error'}`;
            case 'meta':
                return `[META]\n${stringifyPayload(part.params ?? part.content)}`;
            default:
                return part.content || '';
        }
    };

    const setCopyFeedbackState = (status: 'success' | 'error', message: string) => {
        setCopyState(status);
        setCopyFeedback(message);
        if (copyResetTimerRef.current) {
            window.clearTimeout(copyResetTimerRef.current);
        }
        copyResetTimerRef.current = window.setTimeout(() => {
            setCopyState('idle');
            setCopyFeedback('');
        }, 2800);
    };

    const copyTextFallback = (text: string): boolean => {
        const previousActive = document.activeElement;
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        textarea.style.pointerEvents = 'none';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(textarea);
        // 还原焦点到主输入框（避免副文本域移除后焦点丢失到 body）
        if (previousActive === textareaRef.current || document.activeElement === document.body) {
            textareaRef.current?.focus();
        }
        return copied;
    };

    const buildSessionTranscript = (): string => {
        const header = [
            '# Session Transcript',
            `ExportedAt: ${formatTimestamp(Date.now())}`,
            `WorkspaceRoot: ${workspaceRoot || 'N/A'}`,
            `Provider: ${activeProviderConfig?.name || provider || 'N/A'}`,
            `Model: ${model || activeProviderConfig?.modelId || 'N/A'}`,
            `MessageCount: ${messages.length}`,
            '',
        ].join('\n');

        const blocks = messages.map((message, index) => {
            const roleLabel = message.role === 'user' ? 'USER' : 'ASSISTANT';
            const parts = getWaterfallParts(message);
            const partText = parts.map(formatMessagePart).filter(Boolean).join('\n\n').trim();
            const fallbackText = (message.content || '').trim();
            const body = partText || fallbackText || '(empty)';
            const traceLine = message.traceId ? `TraceId: ${message.traceId}` : '';

            return [
                `## ${index + 1}. ${roleLabel}`,
                `Timestamp: ${formatTimestamp(message.timestamp)}`,
                traceLine,
                '',
                body,
            ].filter(Boolean).join('\n');
        });

        return `${header}${blocks.join('\n\n')}`;
    };

    const handleCopySession = async () => {
        if (messages.length === 0) {
            setCopyFeedbackState('error', '当前无可复制会话');
            return;
        }

        const transcript = buildSessionTranscript();

        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(transcript);
            } else {
                const copied = copyTextFallback(transcript);
                if (!copied) throw new Error('clipboard fallback failed');
            }
            setCopyFeedbackState('success', `已复制完整会话（${messages.length}条）`);
        } catch (error) {
            console.error('Failed to copy session transcript:', error);
            setCopyFeedbackState('error', '复制失败，请检查浏览器剪贴板权限');
        }
    };

    // 清空历史会话
    const handleClearHistory = useCallback(async () => {
        await clearHistory();
        // 焦点恢复交给 useEffect 声明式处理，不在此处手动 rAF
    }, [clearHistory]);

    // 清空历史后自动将焦点归还给输入框。
    // 使用 useEffect 而非 requestAnimationFrame：
    //   - useEffect 保证在 React DOM commit 之后执行，ref 处于稳定状态
    //   - 双层 setTimeout 将 focus 推迟到浏览器布局/绘制完成后
    const prevMessageCountRef = useRef(messages.length);
    const focusRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        const wasNonEmpty = prevMessageCountRef.current > 0;
        prevMessageCountRef.current = messages.length;

        if (messages.length === 0 && wasNonEmpty && !isLoading) {
            // 第一层 setTimeout：等 React commit 微任务队列清空
            focusRestoreTimerRef.current = setTimeout(() => {
                // 第二层 setTimeout：确保浏览器布局/绘制完成
                focusRestoreTimerRef.current = setTimeout(() => {
                    textareaRef.current?.focus();
                    focusRestoreTimerRef.current = null;
                }, 0);
            }, 0);
        }

        return () => {
            if (focusRestoreTimerRef.current !== null) {
                clearTimeout(focusRestoreTimerRef.current);
                focusRestoreTimerRef.current = null;
            }
        };
    }, [messages.length, isLoading]);

    return (
        <div className='flex flex-col h-full bg-black text-white font-sans'>
             <div className='flex items-center justify-between px-4 pt-px pb-1 border-b border-white/5 bg-black/50 backdrop-blur-md sticky top-0 z-10'>
                <div className='flex items-center gap-2'>
                    <div className='w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)] animate-pulse' />
                    <span className='text-[10px] font-black tracking-[0.2em] text-emerald-500 uppercase'>智能助手</span>
                    {isLoading && currentStage && (
                        <div className="flex items-center gap-1.5 ml-2 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                            <Loader2 className="w-2.5 h-2.5 text-emerald-500 animate-spin" />
                            <span className="text-[9px] text-emerald-400 font-medium whitespace-nowrap overflow-hidden text-ellipsis max-w-[120px]">
                                {currentStage}
                            </span>
                        </div>
                    )}
                    {isLoading && streamProgress && currentProgressLabel && (
                        <div className="flex items-center gap-1.5 ml-2 px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-400/20">
                            <div className="w-1.5 h-1.5 rounded-full bg-cyan-300/70 animate-pulse" />
                            <span className="text-[9px] text-cyan-200/80 font-medium whitespace-nowrap">
                                已接收 {formatProgressCount(streamProgress.receivedChars)} 字符
                            </span>
                        </div>
                    )}
                </div>
                <div className='flex items-center gap-2'>
                    {messages.length > 0 && (
                        <button
                            onClick={handleCopySession}
                            title='复制整次会话（含推理与工具记录）'
                            className='p-1.5 hover:bg-white/10 rounded-md transition-colors text-white/40 hover:text-emerald-300'
                        >
                            {copyState === 'success'
                                ? <ClipboardCheck className='w-3.5 h-3.5' />
                                : <Copy className='w-3.5 h-3.5' />}
                        </button>
                    )}
                    {isLoading && (
                        <button 
                            onClick={stop} 
                            title="停止生成"
                            className='p-1.5 hover:bg-white/10 rounded-md transition-colors text-red-500/60 hover:text-red-500'
                        >
                            <Square className='w-3.5 h-3.5 fill-current' />
                        </button>
                    )}
                    {messages.length > 0 && !isLoading && (
                        <button 
                            onClick={handleClearHistory} 
                            title="清空历史会话"
                            className='p-1.5 hover:bg-white/10 rounded-md transition-colors text-white/40 hover:text-red-400 group'
                        >
                            <Trash2 className='w-3.5 h-3.5 group-hover:animate-bounce' />
                        </button>
                    )}
                     <button onClick={() => setIsSettingsOpen(true)} className='p-1.5 hover:bg-white/10 rounded-md transition-colors text-white/40 hover:text-white'>
                        <Settings className='w-3.5 h-3.5' />
                    </button>
                    {copyFeedback && (
                        <span className={`ml-1 text-[9px] font-black tracking-[0.08em] ${copyState === 'success' ? 'text-emerald-400/80' : 'text-red-400/80'}`}>
                            {copyFeedback}
                        </span>
                    )}
                </div>
            </div>

            <div onScroll={handleScroll} ref={scrollRef} className='flex-1 overflow-y-auto p-4 space-y-4'>
                {messages.length === 0 ? (
                    <div className='h-full flex flex-col items-center justify-center opacity-20 py-20'>
                        <Box className='w-8 h-8 mb-4 text-emerald-500/50' />
                        <h2 className='text-sm font-light tracking-widest text-white uppercase'>多模型推理式编码助手</h2>
                        <p className='text-[8px] text-white/60 mt-2 uppercase tracking-tighter'>当前节点: {(activeProviderConfig?.name || provider || 'N/A')} / {(model || activeProviderConfig?.modelId || 'N/A')}</p>
                    </div>
                ) : (
                    <>
                        {messages.map((m, idx) => (
                            <ChatMessageItem
                                key={m.id}
                                message={m}
                                isLastItem={idx === messages.length - 1}
                                isLoading={isLoading}
                                isThinkingExpanded={isThinkingExpanded}
                                onToggleThinking={toggleThinkingExpanded}
                                markdownComponentsWithCode={markdownComponentsWithCode}
                                markdownComponentsTextOnly={markdownComponentsTextOnly}
                            />
                        ))}
                        
                        {/* 实时 Stage 进度展示 */}
                        {isLoading && currentStage && (
                            <div className={'flex items-center gap-3 px-2 py-3 bg-emerald-500/5 border border-emerald-500/10 rounded-lg animate-in fade-in slide-in-from-bottom-2 duration-300 ' + (!isThinkingExpanded ? 'block' : 'hidden opacity-0')}>
                                <div className='relative flex items-center justify-center'>
                                    <Loader2 className='w-4 h-4 text-emerald-500 animate-spin' />
                                    <div className='absolute inset-0 bg-emerald-500/20 blur-sm rounded-full animate-pulse' />
                                </div>
                                <div className='flex flex-col gap-0.5'>
                                    <span className='text-[9px] font-black text-emerald-500/60 uppercase tracking-[0.2em]'>System Processor</span>
                                    <span className='text-[11px] font-medium text-emerald-400 capitalize tracking-tight'>
                                        {currentStage}
                                        <span className='inline-flex ml-1'>
                                            <span className='animate-[bounce_1.4s_infinite]'>.</span>
                                            <span className='animate-[bounce_1.4s_infinite_0.2s]'>.</span>
                                            <span className='animate-[bounce_1.4s_infinite_0.4s]'>.</span>
                                        </span>
                                    </span>
                                </div>
                            </div>
                        )}
                    </>
                )}
                <div ref={bottomAnchorRef} className='h-px w-full' aria-hidden='true' />
            </div>

            <form onSubmit={handleSubmit} className='px-1.5 pt-1.5 pb-px bg-black border-t border-white/5'>
                {/* 2026.03: 实时 TODO 任务悬浮窗 (已解耦重构) */}
                <div className="mission-pipeline-container">
                    <TodoList />
                </div>

                <div className='max-w-4xl mx-auto relative group'>
                    <div className='relative w-full bg-white/5 border border-white/10 rounded-xl transition-all focus-within:ring-1 focus-within:ring-emerald-500/20 focus-within:border-emerald-500/40'>
                        <textarea 
                            ref={textareaRef}
                            data-testid="agent-chat-input"
                            value={input} 
                            onChange={customHandleInputChange} 
                            onKeyDown={handleKeyDown}
                            placeholder={isConfigReady ? `${activeProviderConfig?.name || provider} 正在待命...` : '请先在设置中补全 API Key / Base URL / Model'}
                            className='w-full bg-transparent border-0 rounded-xl px-4 py-2.5 pr-24 focus:outline-none transition-all resize-none h-20 text-[12px] leading-relaxed text-white placeholder:text-white/20'
                        />
                        <div className='absolute right-2 bottom-2 flex items-center gap-2'>
                            {isLoading && (
                                <button type='button' onClick={stop} title='停止生成' className='p-2 hover:bg-white/10 rounded-lg text-white/40 hover:text-red-400 transition-all'>
                                    <Square className='w-4 h-4 fill-current' />
                                </button>
                            )}
                            <button type='submit' disabled={!isConfigReady || isLoading || !input.trim()} title='发送消息' className='p-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-white/5 disabled:text-white/10 rounded-lg text-white transition-all shadow-lg shadow-emerald-900/10'>
                               {isLoading ? <Loader2 className='w-4 h-4 animate-spin' /> : <Send className='w-4 h-4' />}
                            </button>
                        </div>
                    </div>
                    {/* 2026.04: 输入框下方工具条，显示思考强度开关 */}
                    <div className='flex flex-wrap items-center gap-2 mt-px px-1 text-[11px]'>
                        <div
                            className='inline-flex items-center gap-0.5 bg-white/5 border border-white/10 rounded-lg p-0.5'
                            title='思考强度：High（默认，快速）/ Max（深度思考，适合复杂 Agent 任务；会消耗更多 token）'
                        >
                            <Brain className='w-3 h-3 text-emerald-400/70 ml-1 mr-0.5' />
                            <span className='text-white/30 mr-1'>思考</span>
                            <button
                                type='button'
                                disabled={!thinkingEnabled}
                                onClick={() => setReasoningEffort('high')}
                                className={`px-2 py-0.5 rounded-md transition-all disabled:opacity-30 disabled:cursor-not-allowed ${reasoningEffort === 'high' ? 'bg-emerald-600/80 text-white shadow-inner' : 'text-white/40 hover:text-white/70'}`}
                            >
                                High
                            </button>
                            <button
                                type='button'
                                disabled={!thinkingEnabled}
                                onClick={() => setReasoningEffort('max')}
                                className={`px-2 py-0.5 rounded-md transition-all disabled:opacity-30 disabled:cursor-not-allowed ${reasoningEffort === 'max' ? 'bg-fuchsia-600/80 text-white shadow-inner' : 'text-white/40 hover:text-white/70'}`}
                            >
                                Max
                            </button>
                        </div>
                        {settings?.providers && settings.providers.length > 0 && (
                            <div ref={providerMenuRef} className='relative min-w-[220px] max-w-[320px]'>
                                <button
                                    type='button'
                                    onClick={() => setIsProviderMenuOpen((prev) => !prev)}
                                    aria-haspopup='listbox'
                                    aria-expanded={isProviderMenuOpen}
                                    title='切换当前对话使用的模型节点'
                                    className='w-full flex items-center justify-between gap-3 bg-white/5 border border-white/10 rounded-lg py-1.5 pl-3 pr-3 text-[11px] text-white/85 outline-none focus:border-[#0088ff]/50 transition-all font-medium hover:bg-white/[0.08]'
                                >
                                    <span className='truncate'>
                                        {(settings.providers.find((item) => item.id === provider)?.name || provider)} / {(settings.providers.find((item) => item.id === provider)?.modelId || model)}
                                    </span>
                                    <ChevronDown className={`w-3.5 h-3.5 text-white/40 transition-transform duration-200 ${isProviderMenuOpen ? 'rotate-180' : ''}`} />
                                </button>

                                {isProviderMenuOpen && (
                                    <div
                                        role='listbox'
                                        className='absolute bottom-full left-0 z-50 mb-2 w-full overflow-hidden rounded-xl border border-white/10 bg-[#0b0b0b] shadow-[0_16px_60px_rgba(0,0,0,0.75)] backdrop-blur-xl'
                                    >
                                        <div className='max-h-72 overflow-y-auto py-1 custom-scrollbar'>
                                            {settings.providers.map((item) => {
                                                const isActive = item.id === provider;
                                                return (
                                                    <button
                                                        key={item.id}
                                                        type='button'
                                                        role='option'
                                                        aria-selected={isActive}
                                                        onClick={() => {
                                                            setProvider(item.id);
                                                            setIsProviderMenuOpen(false);
                                                        }}
                                                        className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[11px] transition-colors ${isActive ? 'bg-[#0088ff]/15 text-white' : 'text-white/80 hover:bg-white/[0.08] hover:text-white'}`}
                                                    >
                                                        <span className='min-w-0 truncate'>
                                                            {(item.name || item.id)}
                                                        </span>
                                                        <span className='min-w-0 max-w-[55%] truncate font-mono text-[10px] text-white/35'>
                                                            {item.modelId}
                                                        </span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </form>
            
            <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />
        </div>
    );
};
