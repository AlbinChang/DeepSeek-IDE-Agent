import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronRight, ArrowLeft, ArrowRight, FolderOpen, Clock, Check } from 'lucide-react';

interface RecentEntry {
    path: string;
    timestamp: number;
}

interface HeaderProps {
    activeFile: string;
    workspaceRoot: string | null;
    recentWorkspaces: RecentEntry[];
    onBack?: () => void;
    onForward?: () => void;
    canBack?: boolean;
    canForward?: boolean;
    onOpenWorkspace: () => void;
    onSwitchWorkspace: (path: string) => void;
}

/**
 * 顶部导航栏 — 工作区管理 + 历史导航 + 文件面包屑
 */
export const Header: React.FC<HeaderProps> = ({
    activeFile, workspaceRoot, recentWorkspaces,
    onBack, onForward, canBack, canForward,
    onOpenWorkspace, onSwitchWorkspace
}) => {
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    // 点击外部关闭菜单
    useEffect(() => {
        if (!menuOpen) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [menuOpen]);

    const handleSelectWorkspace = useCallback((path: string) => {
        setMenuOpen(false);
        onSwitchWorkspace(path);
    }, [onSwitchWorkspace]);

    const handleOpenNew = useCallback(() => {
        setMenuOpen(false);
        onOpenWorkspace();
    }, [onOpenWorkspace]);

    const pathSegments = activeFile.split('/');

    // 格式化工作区路径为简短显示名
    const workspaceLabel = workspaceRoot
        ? workspaceRoot.replace(/\\/g, '/').split('/').pop() || workspaceRoot
        : '工作区';

    // 格式化最近工作区路径为可读名称
    const formatRecentLabel = (p: string) => {
        const normalized = p.replace(/\\/g, '/').replace(/\/+$/, '');
        const parts = normalized.split('/');
        // 显示最后两级目录
        if (parts.length >= 2) {
            return parts.slice(-2).join('/');
        }
        return normalized;
    };

    return (
        <div data-testid="header-container" className="h-[24px] w-full bg-[#000000] flex items-center justify-between px-3 select-none">
            {/* 左侧：工作区菜单 + 历史导航 */}
            <div className="flex items-center gap-3">
                {/* 工作区下拉菜单 */}
                <div ref={menuRef} className="relative flex items-center">
                    <button
                        onClick={() => setMenuOpen(!menuOpen)}
                        className="flex items-center gap-1.5 pr-3 border-r border-white/15 mr-1 text-white hover:bg-white/5 rounded-sm px-1 py-0.5 transition-colors cursor-pointer"
                        title={workspaceRoot || '点击管理工作区'}
                    >
                        <FolderOpen size={11} className="text-white/70" />
                        <span className="text-white text-[9px] uppercase tracking-wider font-black max-w-[160px] truncate">
                            {workspaceLabel}
                        </span>
                        <svg className="w-2 h-2 text-white/75" viewBox="0 0 8 5" fill="currentColor">
                            <path d="M0 0l4 5 4-5z"/>
                        </svg>
                    </button>

                    {/* 下拉菜单面板 */}
                    {menuOpen && (
                        <div className="absolute top-full left-0 mt-1 w-72 bg-[#1a1a1a] border border-white/15 rounded-md shadow-2xl z-[100] py-1 overflow-hidden">
                            {/* 当前工作区信息 */}
                            {workspaceRoot && (
                                <div className="px-3 py-1.5 border-b border-white/5">
                                    <span className="text-[8px] text-white/65 uppercase tracking-wider">当前工作区</span>
                                    <div className="text-[9px] text-white/80 font-mono truncate mt-0.5" title={workspaceRoot}>
                                        {workspaceRoot}
                                    </div>
                                </div>
                            )}

                            {/* 打开新工作区 */}
                            <button
                                onClick={handleOpenNew}
                                className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/5 transition-colors text-left"
                            >
                                <FolderOpen size={11} className="text-white/75" />
                                <span className="text-[9px] text-white/90 font-medium">打开新工作区</span>
                            </button>

                            {/* 分隔线 */}
                            <div className="mx-2 my-1 border-t border-white/10"/>

                            {/* 最近工作区 */}
                            <div className="px-3 py-1">
                                <span className="text-[8px] text-white/60 uppercase tracking-wider">最近工作区</span>
                            </div>

                            {recentWorkspaces.length > 0 ? (
                                <div className="max-h-[240px] overflow-y-auto">
                                    {recentWorkspaces.map((entry, idx) => (
                                        <button
                                            key={`${entry.path}-${idx}`}
                                            onClick={() => handleSelectWorkspace(entry.path)}
                                            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-white/5 transition-colors text-left group"
                                        >
                                            <Clock size={10} className="text-white/60 shrink-0 group-hover:text-white/70" />
                                            <span
                                                className="text-[9px] text-white/75 group-hover:text-white/90 font-mono truncate flex-1"
                                                title={entry.path}
                                            >
                                                {formatRecentLabel(entry.path)}
                                            </span>
                                            {workspaceRoot?.replace(/\\/g, '/').replace(/\/+$/, '') === entry.path.replace(/\\/g, '/').replace(/\/+$/, '') && (
                                                <Check size={10} className="text-green-400 shrink-0" />
                                            )}
                                        </button>
                                    ))}
                                </div>
                            ) : (
                                <div className="px-3 py-2">
                                    <span className="text-[9px] text-white/60">暂无最近工作区记录</span>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* 历史导航 */}
                <div className="flex items-center gap-1 mr-2 scale-75">
                    <button 
                        disabled={!canBack} 
                        onClick={onBack}
                        className={`p-1 rounded hover:bg-white/5 transition-colors ${canBack ? 'text-white' : 'text-white/70 cursor-not-allowed'}`}
                    >
                        <ArrowLeft size={12} />
                    </button>
                    <button 
                        disabled={!canForward} 
                        onClick={onForward}
                        className={`p-1 rounded hover:bg-white/5 transition-colors ${canForward ? 'text-white' : 'text-white/70 cursor-not-allowed'}`}
                    >
                        <ArrowRight size={12} />
                    </button>
                </div>

                {/* 文件面包屑 */}
                <div className="flex items-center gap-1.5 text-[8.5px] text-white overflow-hidden font-black tracking-widest">
                    {pathSegments.map((seg, i) => (
                        <React.Fragment key={i}>
                            <button className="hover:text-white transition-colors truncate max-w-[750px] opacity-90 hover:opacity-100">
                                {seg}
                            </button>
                            {i < pathSegments.length - 1 && <ChevronRight size={8} className="opacity-60" />}
                        </React.Fragment>
                    ))}
                </div>
            </div>
        </div>
    );
};
