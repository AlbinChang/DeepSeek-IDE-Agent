import React, { useMemo } from 'react';
import { AlertCircle, AlertTriangle, Info, X, ChevronDown, FileText } from 'lucide-react';
import { useAgentContext, type ProblemEntry } from '@/providers/AgentContext';

/**
 * Problems 面板 — VS Code 风格的问题列表
 * 
 * 功能：
 * - 按严重程度分组（错误 > 警告 > 信息）
 * - 显示文件路径、行号、列号、问题描述
 * - 点击跳转到对应文件
 * - 悬停显示完整信息
 * - 一键清空
 * - 问题计数徽章
 */

const SEVERITY_ICON: Record<ProblemEntry['severity'], React.ReactNode> = {
    error: <AlertCircle size={12} className="text-red-400 shrink-0" />,
    warning: <AlertTriangle size={12} className="text-yellow-400 shrink-0" />,
    info: <Info size={12} className="text-blue-400 shrink-0" />,
};

const SEVERITY_ORDER: Record<ProblemEntry['severity'], number> = {
    error: 0,
    warning: 1,
    info: 2,
};

/** 从文件路径中提取文件名 */
function getFileName(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || filePath;
}

/** 从文件路径中提取目录部分 */
function getDirName(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    parts.pop();
    return parts.join('/') || '.';
}

export const ProblemList: React.FC = () => {
    const { problems, clearProblems, workspaceRoot } = useAgentContext();
    const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(new Set());

    // 按文件分组
    const grouped = useMemo(() => {
        const map = new Map<string, ProblemEntry[]>();
        for (const p of problems) {
            const list = map.get(p.filePath) || [];
            list.push(p);
            map.set(p.filePath, list);
        }
        // 组内按行号排序
        for (const [, list] of map) {
            list.sort((a, b) => {
                const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
                if (sevDiff !== 0) return sevDiff;
                return (a.line ?? 0) - (b.line ?? 0);
            });
        }
        return map;
    }, [problems]);

    const toggleGroup = (filePath: string) => {
        setCollapsedGroups(prev => {
            const next = new Set(prev);
            if (next.has(filePath)) {
                next.delete(filePath);
            } else {
                next.add(filePath);
            }
            return next;
        });
    };

    // 计数
    const errorCount = problems.filter(p => p.severity === 'error').length;
    const warnCount = problems.filter(p => p.severity === 'warning').length;

    const handleFileClick = (filePath: string, line?: number) => {
        if (!workspaceRoot) return;
        // 触发文件打开事件（由 App.tsx / FileEditor 监听）
        const fullPath = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '') + '/' + filePath.replace(/\\/g, '/');
        window.dispatchEvent(new CustomEvent('ui:file:open', {
            detail: { filePath: fullPath, line: line ?? 1, column: 1 }
        }));
    };

    return (
        <div className="flex flex-col h-full bg-[#0a0a0a] select-none" data-testid="problems-panel">
            {/* 头部工具栏 */}
            <div className="h-[22px] bg-[#0d0d0d] flex items-center px-2 border-b border-white/5 shrink-0 gap-1">
                <span className="text-[9px] font-semibold text-white/60 uppercase tracking-wider">
                    问题
                </span>
                {problems.length > 0 && (
                    <span className="text-[9px] text-white/40 ml-1">
                        ({problems.length})
                    </span>
                )}
                {errorCount > 0 && (
                    <span className="text-[9px] text-red-400/80 ml-1">
                        {errorCount} 错误
                    </span>
                )}
                {warnCount > 0 && (
                    <span className="text-[9px] text-yellow-400/80 ml-1">
                        {warnCount} 警告
                    </span>
                )}
                <div className="ml-auto">
                    {problems.length > 0 && (
                        <button
                            onClick={clearProblems}
                            className="p-0.5 hover:bg-white/10 rounded transition-colors"
                            title="清空所有问题"
                        >
                            <X size={10} className="text-white/30 hover:text-white/60" />
                        </button>
                    )}
                </div>
            </div>

            {/* 问题列表 */}
            <div className="flex-1 overflow-y-auto custom-scrollbar-thin">
                {problems.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full gap-2 opacity-30">
                        <Info size={20} className="text-white" />
                        <span className="text-[9px] text-white/50 uppercase tracking-wider">
                            暂无问题
                        </span>
                    </div>
                ) : (
                    <div className="py-0.5">
                        {Array.from(grouped.entries()).map(([filePath, entries]) => {
                            const isCollapsed = collapsedGroups.has(filePath);
                            const groupErrors = entries.filter(e => e.severity === 'error').length;
                            const groupWarns = entries.filter(e => e.severity === 'warning').length;

                            return (
                                <div key={filePath} className="mb-0.5">
                                    {/* 文件组标题 */}
                                    <div
                                        className="flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-white/[0.03] transition-colors group"
                                        onClick={() => toggleGroup(filePath)}
                                    >
                                        <ChevronDown
                                            size={10}
                                            className={`text-white/30 transition-transform shrink-0 ${isCollapsed ? '-rotate-90' : ''}`}
                                        />
                                        <FileText size={11} className="text-white/25 shrink-0" />
                                        <span className="text-[10px] text-white/70 truncate flex-1 font-medium">
                                            {getFileName(filePath)}
                                        </span>
                                        <span className="text-[8px] text-white/25 shrink-0 hidden group-hover:inline">
                                            {getDirName(filePath)}
                                        </span>
                                        {groupErrors > 0 && (
                                            <span className="text-[8px] text-red-400/70 shrink-0">×{groupErrors}</span>
                                        )}
                                        {groupWarns > 0 && (
                                            <span className="text-[8px] text-yellow-400/70 shrink-0">×{groupWarns}</span>
                                        )}
                                    </div>

                                    {/* 文件下的问题条目 */}
                                    {!isCollapsed && (
                                        <div>
                                            {entries.map((entry, i) => (
                                                <div
                                                    key={`${entry.filePath}-${entry.line}-${i}`}
                                                    className="flex items-start gap-1.5 px-3 py-0.5 hover:bg-white/[0.04] cursor-pointer transition-colors group"
                                                    onClick={() => handleFileClick(entry.filePath, entry.line)}
                                                    title={entry.message}
                                                >
                                                    <span className="mt-[3px]">{SEVERITY_ICON[entry.severity]}</span>
                                                    <span className="text-[9px] text-white/50 font-mono shrink-0 mt-[1px] min-w-[40px]">
                                                        {entry.line ? `L${entry.line}` : ''}{entry.column ? `:${entry.column}` : ''}
                                                    </span>
                                                    <span className="text-[10px] text-white/75 truncate flex-1 leading-[1.4]">
                                                        {entry.message}
                                                    </span>
                                                    {entry.code && (
                                                        <span className="text-[8px] text-white/25 shrink-0 mt-[2px] font-mono">
                                                            {entry.code}
                                                        </span>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* 底部状态栏 */}
            {problems.length > 0 && (
                <div className="h-[18px] bg-[#0d0d0d] border-t border-white/5 flex items-center px-2 gap-2 shrink-0">
                    <span className="text-[8px] text-white/30">
                        {Array.from(grouped.keys()).length} 个文件
                    </span>
                    <span className="text-[8px] text-white/20">·</span>
                    <span className="text-[8px] text-white/30">
                        {problems.length} 个问题
                    </span>
                </div>
            )}
        </div>
    );
};
