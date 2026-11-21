import React, { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertTriangle, CheckCircle2, ChevronUp, XCircle } from 'lucide-react';
import type { MessagePart } from '@/hooks/useAgentSSE';

// ── 超长任务的渲染预算 ──
// 单次 4 小时以上的任务会在同一条 assistant 消息里累积上千个 part
// （每轮 tool/call + tool/result 各占一个，外加推理/正文 part）。
// Virtuoso 只能虚拟化「消息」，无法虚拟化消息内部的 part —— 若全量渲染，
// DOM 节点数与每次流式提交的协调成本都会随任务时长线性增长，
// 最终表现为对话越久越卡。
// 这里只渲染「最新的 N 个 part」，更早的记录折叠成一行可展开的入口，
// 使单条消息的渲染成本保持常量级。part 数据本身完整保留（复制/导出不受影响）。
const MAX_VISIBLE_PARTS = 160;
const PART_EXPAND_STEP = 200;
// 流式阶段单个 part 的最大渲染字符数（仅影响「正在增长的那个 part」）。
// 超长正文/推理若整段重新布局，每帧都会触发数十万字符的排版；
// 流式时只渲染尾部最新内容，消息结束后再完整渲染（此时只排版一次）。
const LIVE_PART_RENDER_CHARS = 20_000;

const partNumberFormatter = new Intl.NumberFormat('zh-CN');

const formatToolArgMeta = (meta: any): string | null => {
    if (!meta || !meta.redacted) return null;
    const parts: string[] = [];
    const totalContentChars = Number(meta.totalContentChars || 0);
    const redactedStringChars = Number(meta.redactedStringChars || 0);
    const fileCount = Number(meta.fileCount || 0);
    if (fileCount > 0) parts.push(`${partNumberFormatter.format(fileCount)} 个文件`);
    if (totalContentChars > 0) parts.push(`${partNumberFormatter.format(totalContentChars)} 个正文字符`);
    else if (redactedStringChars > 0) parts.push(`${partNumberFormatter.format(redactedStringChars)} 个长文本字符`);
    if (Number(meta.truncatedItems || 0) > 0) parts.push(`省略 ${partNumberFormatter.format(Number(meta.truncatedItems))} 项`);
    if (Number(meta.truncatedKeys || 0) > 0) parts.push(`省略 ${partNumberFormatter.format(Number(meta.truncatedKeys))} 个字段`);
    return parts.length > 0 ? `已隐藏大文本参数：${parts.join('，')}` : '已隐藏大文本参数';
};

const toLiveTail = (content: string): string => {
    if (content.length <= LIVE_PART_RENDER_CHARS) return content;
    const hidden = content.length - LIVE_PART_RENDER_CHARS;
    return `……[流式渲染仅显示最新 ${partNumberFormatter.format(LIVE_PART_RENDER_CHARS)} 字符，前 ${partNumberFormatter.format(hidden)} 字符将在本次回复结束后完整展示]\n\n${content.slice(-LIVE_PART_RENDER_CHARS)}`;
};

interface MessagePartViewProps {
    part: MessagePart;
    role: 'user' | 'assistant';
    isStreaming: boolean;
    /** 该 part 是否为当前正在增长的最后一个 part（流式输出中） */
    isLivePart: boolean;
    isThinkingExpanded: boolean;
    showReasoningCaret: boolean;
    onToggleThinking: () => void;
    markdownComponentsWithCode: any;
}

/**
 * 单个 part 的渲染单元。
 * 旧实现把全部 part 内联在消息组件里，任意增量都会重渲染整棵 part 子树；
 * 拆成 memo 组件后，未变化的 part 直接跳过（part 对象在增量追加时保持引用稳定）。
 */
export const MessagePartView = React.memo(({
    part,
    role,
    isStreaming,
    isLivePart,
    isThinkingExpanded,
    showReasoningCaret,
    onToggleThinking,
    markdownComponentsWithCode,
}: MessagePartViewProps) => {
    if (part.type === 'reasoning') {
        return (
            <div className='group flex flex-col gap-1.5'>
                <div
                    onClick={onToggleThinking}
                    className='flex items-center gap-2 text-[9px] text-emerald-500/60 font-medium cursor-pointer hover:bg-emerald-500/10 transition-all uppercase tracking-widest bg-emerald-500/5 px-2 py-0.5 rounded border border-emerald-500/10 w-fit'
                >
                    <div className={'w-1 h-1 rounded-full bg-emerald-500/40 ' + (isLivePart ? 'animate-pulse' : '')} />
                    {isThinkingExpanded ? '收起内核推理' : '展开思维链'}
                </div>
                {isThinkingExpanded && (
                    <div className='text-[8pt] text-white/70 font-mono bg-white/[0.01] p-2.5 rounded border border-white/5 italic whitespace-pre-wrap leading-snug shadow-inner overflow-hidden relative'>
                        <div className='absolute top-0 left-0 w-0.5 h-full bg-emerald-500/20' />
                        {isLivePart ? toLiveTail(part.content || '') : (part.content || '')}
                        {showReasoningCaret && (
                            <span className='inline-block w-1.5 h-3 ml-1 bg-emerald-500/40 animate-pulse align-middle' />
                        )}
                    </div>
                )}
            </div>
        );
    }

    if (part.type === 'text') {
        if (role === 'user') {
            return (
                <div className='text-white/85 leading-normal font-sans text-[8pt] whitespace-pre-wrap'>
                    {part.content || ''}
                </div>
            );
        }
        return isStreaming ? (
            /* 流式传输中：纯文本渲染，跳过 ReactMarkdown AST 解析，消除每帧卡顿 */
            <div className='text-white/85 leading-normal font-sans text-[8pt] whitespace-pre-wrap break-words'>
                {isLivePart ? toLiveTail(part.content || '') : (part.content || '')}
            </div>
        ) : (
            <div className='prose prose-invert prose-emerald prose-sm max-w-none text-white/85 leading-normal font-sans text-[8pt]'>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponentsWithCode}>
                    {part.content || ''}
                </ReactMarkdown>
            </div>
        );
    }

    if (part.type === 'annotation' && part.method === 'tool/call') {
        const argsMetaLabel = formatToolArgMeta(part.params?.argsMeta);
        return (
            <div className='my-2 overflow-hidden rounded border border-white/10 bg-white/[0.02]'>
                <div className='flex items-center gap-2 px-3 py-1.5 bg-white/5 border-b border-white/10'>
                    {/* 仅为「当前正在执行」的卡片保留脉冲动画：历史卡片若常驻动画，
                        超长任务下会有上百个 CSS 动画同时运行，持续占用渲染线程。 */}
                    <div className={'w-1.5 h-1.5 rounded-full ' + (isLivePart ? 'bg-amber-500 animate-pulse' : 'bg-amber-500/40')} />
                    <span className='text-[8pt] font-bold text-amber-500/80 tracking-tighter'>正在调用: {part.params?.toolName}</span>
                </div>
                <div className='p-2 bg-black/20'>
                    {argsMetaLabel && (
                        <div className='mb-2 rounded border border-amber-500/15 bg-amber-500/5 px-2 py-1 text-[7.5pt] font-medium text-amber-200/70'>
                            {argsMetaLabel}
                        </div>
                    )}
                    <pre className='text-[7pt] text-white/40 overflow-x-auto font-mono'>
                        {/* 使用预处理后的 JSON 字符串，避免 render 中重复 JSON.stringify */}
                        {part.params?._argsJson ?? ''}
                    </pre>
                </div>
            </div>
        );
    }

    if (part.type === 'annotation' && (part.method === 'tool/result' || part.method === 'tool/error')) {
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
    }

    if (part.type === 'error') {
        return (
            <div className='my-2 p-2 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-[8pt] flex items-center gap-2'>
                <div className='w-1 h-1 rounded-full bg-red-500' />
                {part.content}
            </div>
        );
    }

    if (part.type === 'notice') {
        return (
            <div className={`my-2 p-2 rounded border text-[8pt] flex items-start gap-2 ${part.params?.resolved
                ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-200/90'
                : 'bg-amber-500/10 border-amber-500/25 text-amber-200/90'}`}>
                <AlertTriangle className={`w-3 h-3 mt-0.5 shrink-0 ${part.params?.resolved
                    ? 'text-emerald-400/80'
                    : 'text-amber-400/80'}`} />
                <div className='min-w-0 whitespace-pre-wrap break-words'>
                    <div className={`font-bold mb-0.5 ${part.params?.resolved
                        ? 'text-emerald-300/90'
                        : 'text-amber-300/90'}`}>
                        {part.method === 'MODEL_SUBSTITUTION'
                            ? (part.params?.resolved ? '模型来源已恢复' : '模型来源异常')
                            : '提示'}
                    </div>
                    <div>{part.content}</div>
                    {Array.isArray(part.params?.servedModels) && part.params.servedModels.length > 0 && (
                        <div className='mt-1 font-mono text-[7pt] text-amber-200/60 break-all'>
                            请求模型：{part.params?.requestedModel || '-'}
                            {' → '}实际返回：{part.params.servedModels.join(', ')}
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return null;
}, (prev, next) => {
    if (prev.part !== next.part) return false;
    if (prev.role !== next.role) return false;
    if (prev.isLivePart !== next.isLivePart) return false;
    if (prev.isStreaming !== next.isStreaming) return false;
    if (prev.showReasoningCaret !== next.showReasoningCaret) return false;
    if (prev.onToggleThinking !== next.onToggleThinking) return false;
    if (prev.markdownComponentsWithCode !== next.markdownComponentsWithCode) return false;
    // 折叠/展开思维链只影响 reasoning 单元：不要让正文 part 跟着重渲染，
    // 否则每次切换都会重新解析整段 Markdown（超长任务下可达数十万字符）。
    if (prev.part.type === 'reasoning' && prev.isThinkingExpanded !== next.isThinkingExpanded) return false;
    return true;
});

interface MessagePartListProps {
    parts: MessagePart[];
    role: 'user' | 'assistant';
    isStreaming: boolean;
    isActiveStream: boolean;
    isThinkingExpanded: boolean;
    hasMessageText: boolean;
    onToggleThinking: () => void;
    markdownComponentsWithCode: any;
}

export const MessagePartList = React.memo(({
    parts,
    role,
    isStreaming,
    isActiveStream,
    isThinkingExpanded,
    hasMessageText,
    onToggleThinking,
    markdownComponentsWithCode,
}: MessagePartListProps) => {
    const [expandedParts, setExpandedParts] = useState(0);
    const visibleLimit = MAX_VISIBLE_PARTS + expandedParts;

    const { visibleParts, hiddenCount } = useMemo(() => {
        if (parts.length <= visibleLimit) {
            return { visibleParts: parts, hiddenCount: 0 };
        }
        return { visibleParts: parts.slice(-visibleLimit), hiddenCount: parts.length - visibleLimit };
    }, [parts, visibleLimit]);

    return (
        <>
            {hiddenCount > 0 && (
                <button
                    type='button'
                    onClick={() => setExpandedParts(prev => prev + PART_EXPAND_STEP)}
                    title='展开更早的执行记录'
                    className='mb-2 flex w-full items-center justify-center gap-1.5 rounded border border-white/10 bg-white/[0.03] px-2 py-1 text-[8pt] text-white/40 transition-colors hover:bg-white/[0.07] hover:text-white/70'
                >
                    <ChevronUp className='h-3 w-3' />
                    已折叠更早的 {partNumberFormatter.format(hiddenCount)} 条记录（点击展开 {partNumberFormatter.format(Math.min(PART_EXPAND_STEP, hiddenCount))} 条）
                </button>
            )}
            {visibleParts.map((part, index) => (
                <div key={part.id} className='mb-3 last:mb-0'>
                    <MessagePartView
                        part={part}
                        role={role}
                        isStreaming={isStreaming}
                        isLivePart={isActiveStream && index === visibleParts.length - 1}
                        isThinkingExpanded={isThinkingExpanded}
                        showReasoningCaret={isActiveStream && !!part.content && !hasMessageText}
                        onToggleThinking={onToggleThinking}
                        markdownComponentsWithCode={markdownComponentsWithCode}
                    />
                </div>
            ))}
        </>
    );
});
