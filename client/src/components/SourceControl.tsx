import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { 
    GitBranch,
    AlertCircle, Loader2,
        ChevronDown, ChevronRight,
        History,
        RefreshCw,
        Clock3,
        FileClock
} from 'lucide-react';
import { useAgentContext } from '@/providers/AgentContext';
import { GATEWAY_EVENT } from '@/config';
import { electronBridge } from '@/services/electron-bridge';

interface GitFileStatus {
    path: string;
    index: string;
    working_dir: string;
}

interface GitStatus {
    not_added: string[];
    conflicted: string[];
    created: string[];
    deleted: string[];
    modified: string[];
    renamed: string[];
    staged: string[];
    files: GitFileStatus[];
    current: string;
    tracking: string;
    ahead: number;
    behind: number;
}

interface GitCommitRecord {
        hash: string;
        shortHash: string;
        author: string;
        date: string;
        message: string;
}

type SourceControlView = 'changes' | 'history';

const HISTORY_LIMIT = 40;

/** diff 内容最大渲染字符数，超出则截断以避免大 diff 阻塞主线程 */
const DIFF_RENDER_MAX_CHARS = 80_000;

/* ===================================================================
 * CommitItem — React.memo 隔离每条 commit 的重渲染
 * =================================================================== */
interface CommitItemProps {
    commit: GitCommitRecord;
    isSelected: boolean;
    onSelect: (hash: string) => void;
}

const CommitItem = React.memo<CommitItemProps>(({ commit, isSelected, onSelect }) => {
    const handleClick = useCallback(() => {
        onSelect(commit.hash);
    }, [commit.hash, onSelect]);

    return (
        <button
            onClick={handleClick}
            className={`w-full text-left px-3 py-2 border-l-2 transition-colors ${
                isSelected ? 'border-white bg-white/10' : 'border-transparent hover:bg-white/5'
            }`}
            style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 56px' }}
        >
            <div className="flex items-center gap-2">
                <FileClock size={11} className="text-white/40 shrink-0" />
                <span className="text-[9px] font-black text-white tracking-tight">{commit.shortHash}</span>
                <span className="text-[8px] text-white/40 truncate">{commit.author}</span>
            </div>
            <div className="mt-1 text-[8px] text-white/70 line-clamp-2 break-words">{commit.message}</div>
            <div className="mt-1 text-[7px] text-white/30">{commit.date}</div>
        </button>
    );
});
CommitItem.displayName = 'CommitItem';


/* ===================================================================
 * DiffViewer — 截断大 diff，避免阻塞主线程
 * =================================================================== */
interface DiffViewerProps {
    diff: string;
    isLoading: boolean;
    maxChars?: number;
}

const DiffViewer: React.FC<DiffViewerProps> = ({ diff, isLoading, maxChars = DIFF_RENDER_MAX_CHARS }) => {
    const [showFull, setShowFull] = useState(false);

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-full text-white/30 gap-2 text-[8px] uppercase tracking-widest">
                <Loader2 size={14} className="animate-spin" />
                加载差异中...
            </div>
        );
    }

    if (!diff) {
        return (
            <div className="h-full flex items-center justify-center text-[8px] uppercase tracking-widest text-white/20">
                选择左侧提交以查看变化详情
            </div>
        );
    }

    const needsTruncation = diff.length > maxChars;
    const displayText = needsTruncation && !showFull ? diff.slice(0, maxChars) : diff;

    return (
        <div className="h-full flex flex-col">
            <pre
                className="flex-1 min-h-0 p-3 text-[10px] leading-[1.45] text-white/75 whitespace-pre-wrap break-words font-mono overflow-y-auto custom-scrollbar"
                style={{ contentVisibility: 'auto' }}
            >
                {displayText}
            </pre>
            {needsTruncation && (
                <div className="shrink-0 px-3 py-1.5 border-t border-white/10 bg-yellow-950/30 text-[9px] text-yellow-300/80 font-medium flex items-center justify-between">
                    <span>
                        ⚠ Diff 内容过长（{diff.length.toLocaleString()} 字符），仅展示前 {maxChars.toLocaleString()} 字符
                    </span>
                    {!showFull && (
                        <button
                            onClick={() => setShowFull(true)}
                            className="px-2 py-0.5 border border-yellow-500/40 text-[8px] font-black uppercase tracking-wider hover:bg-yellow-500/20"
                        >
                            加载全部
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};


export const SourceControl: React.FC = () => {
  const { workspaceRoot } = useAgentContext();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [isUninitialized, setIsUninitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [activeView, setActiveView] = useState<SourceControlView>('changes');

    const [repoHistory, setRepoHistory] = useState<GitCommitRecord[]>([]);
    const [fileHistory, setFileHistory] = useState<GitCommitRecord[]>([]);
    const [selectedHistoryFile, setSelectedHistoryFile] = useState<string | null>(null);
    const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
    const [selectedCommitDiff, setSelectedCommitDiff] = useState<string>('');
    const [isHistoryLoading, setIsHistoryLoading] = useState(false);
    const [isDiffLoading, setIsDiffLoading] = useState(false);
    const [historyError, setHistoryError] = useState<string | null>(null);

  const [expandedGroups, setExpandedGroups] = useState({
    untracked: true,
    modified: true,
    staged: true
  });

  const toggleGroup = (group: keyof typeof expandedGroups) => {
    setExpandedGroups(prev => ({ ...prev, [group]: !prev[group] }));
  };

  const fetchStatus = useCallback(async (silent = false) => {
    // 2026.03 解耦: 如果 workspaceRoot 未确定，暂不拉取状态而非显示错误
    if (!workspaceRoot) return;
    
    if (!silent) setIsLoading(true);
    try {
                setErrorMessage(null);

                const result = await electronBridge.gitStatus({ root: workspaceRoot });
                if (!result.success) {
                    if (result.error?.toLowerCase().includes('not a git repository')) {
                        setIsUninitialized(true);
                        setStatus(null);
                        return;
                    }
                    throw new Error(result.error || 'Git status failed');
                }
                setIsUninitialized(false);
                setStatus(result as GitStatus);
        } catch (e: any) {
                console.error('Failed to fetch Git status:', e);
                setStatus(null);
                setIsUninitialized(false);
                setErrorMessage(e?.message || '无法获取 Git 状态');
    } finally {
        if (!silent) setIsLoading(false);
    }
        }, [workspaceRoot]);

    const fetchRepoHistory = useCallback(async (silent = false) => {
        if (!workspaceRoot) return;

        if (!silent) setIsHistoryLoading(true);
        try {
            setHistoryError(null);

            const result = await electronBridge.gitLog({ root: workspaceRoot, maxCount: HISTORY_LIMIT });
            if (result.success) {
                const commits = Array.isArray(result.all) ? result.all : [];
                setRepoHistory(commits as GitCommitRecord[]);
            } else {
                throw new Error(result.error || 'Git log failed');
            }
        } catch (e: any) {
            console.error('Failed to fetch Git history:', e);
            setRepoHistory([]);
            setHistoryError(e?.message || '无法获取 Git 提交历史');
        } finally {
            if (!silent) setIsHistoryLoading(false);
        }
    }, [workspaceRoot]);

    const fetchFileHistory = useCallback(async (filePath: string, silent = false) => {
        if (!workspaceRoot || !filePath) return;

        if (!silent) setIsHistoryLoading(true);
        try {
            setHistoryError(null);

            const result = await electronBridge.gitFileHistory({ root: workspaceRoot, filePath });
            if (result.success) {
                const commits = Array.isArray(result.all) ? result.all : [];
                setFileHistory(commits as GitCommitRecord[]);
            } else {
                throw new Error(result.error || 'File history failed');
            }
        } catch (e: any) {
            console.error('Failed to fetch file history:', e);
            setFileHistory([]);
            setHistoryError(e?.message || '无法获取文件历史');
        } finally {
            if (!silent) setIsHistoryLoading(false);
        }
    }, [workspaceRoot]);

    const fetchCommitDiff = useCallback(async (commitHash: string, filePath?: string) => {
        if (!workspaceRoot || !commitHash) return;

        setIsDiffLoading(true);
        try {
            setHistoryError(null);

            const result = await electronBridge.gitDiff({ root: workspaceRoot, file: filePath });
            if (result.success) {
                setSelectedCommitHash(commitHash);
                setSelectedCommitDiff(String(result.diff || ''));
            } else {
                throw new Error(result.error || 'Diff failed');
            }
        } catch (e: any) {
            console.error('Failed to fetch commit diff:', e);
            setSelectedCommitHash(commitHash);
            setSelectedCommitDiff('');
            setHistoryError(e?.message || '无法获取提交差异');
        } finally {
            setIsDiffLoading(false);
        }
    }, [workspaceRoot]);

    const openFileHistory = useCallback(async (filePath: string) => {
        if (!filePath) return;
        setActiveView('history');
        setSelectedHistoryFile(filePath);
        setSelectedCommitHash(null);
        setSelectedCommitDiff('');
        await fetchFileHistory(filePath);
    }, [fetchFileHistory]);

    const clearFileHistoryFocus = useCallback(async () => {
        setSelectedHistoryFile(null);
        setFileHistory([]);
        setSelectedCommitHash(null);
        setSelectedCommitDiff('');
        await fetchRepoHistory();
    }, [fetchRepoHistory]);

  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;

  useEffect(() => {
    fetchStatus();

    // 仅在「变更」视图时轮询 git status；历史视图无需轮询避免无谓 re-render
    const pollInterval = setInterval(() => {
        if (activeViewRef.current === 'changes') {
            fetchStatus(true);
        }
    }, 1000);

    // 订阅文件系统变更以触发状态自动刷新 (对齐 Section 2.2 FileTree.md)
    const handleFsChange = () => {
        if (activeViewRef.current === 'changes') fetchStatus(true);
    };
    const onWsMessage = (e: any) => {
        if (e.detail?.type === 'fs:changed' || e.detail?.type === 'fs:change') handleFsChange();
    };
    const onRefresh = () => {
        if (activeViewRef.current === 'changes') fetchStatus();
    };

    window.addEventListener(GATEWAY_EVENT, onWsMessage);
    window.addEventListener('ui:file-tree:refresh', onRefresh);

    return () => {
        clearInterval(pollInterval);
        window.removeEventListener(GATEWAY_EVENT, onWsMessage);
        window.removeEventListener('ui:file-tree:refresh', onRefresh);
    };
  }, [fetchStatus]);

  const initRepo = async () => {
    if (!workspaceRoot) return;
    
    setIsLoading(true);
    try {
        setErrorMessage(null);
        const result = await electronBridge.gitInit({ root: workspaceRoot });
        if (!result.success) throw new Error(result.error || 'Git init failed');
        await fetchStatus();
        window.dispatchEvent(new CustomEvent('ui:file-tree:refresh'));
    } catch (e: any) {
        console.error('Failed to init repo:', e);
        setErrorMessage(e?.message || '初始化存储库失败');
    } finally {
        setIsLoading(false);
    }
  };

    useEffect(() => {
        if (!workspaceRoot || activeView !== 'history') return;
        if (selectedHistoryFile) {
            fetchFileHistory(selectedHistoryFile, true);
        } else {
            fetchRepoHistory(true);
        }
    }, [activeView, selectedHistoryFile, workspaceRoot, fetchRepoHistory, fetchFileHistory]);

    const currentHistoryRecords = useMemo(() => {
        if (selectedHistoryFile) {
            return fileHistory;
        }
        return repoHistory;
    }, [selectedHistoryFile, fileHistory, repoHistory]);

    const renderHistoryAction = useCallback((filePath: string) => (
        <button
            onClick={(e) => {
                e.stopPropagation();
                openFileHistory(filePath);
            }}
            className="px-1.5 py-[1px] border border-white/10 rounded text-[7px] font-black uppercase tracking-[0.15em] text-white/40 hover:text-white hover:border-white/40"
            title="查看该文件历史"
        >
            HIST
        </button>
    ), [openFileHistory]);

  const getStatusIcon = (statusKey: string) => {
    switch (statusKey) {
        case 'M': return <span className="text-[9px] text-orange-400 font-bold w-4 text-center">M</span>;
        case 'D': return <span className="text-[9px] text-red-500 font-bold w-4 text-center">D</span>;
        case 'A': return <span className="text-[9px] text-emerald-400 font-bold w-4 text-center">A</span>;
        case 'U': return <span className="text-[9px] text-blue-400 font-bold w-4 text-center">U</span>;
        case '?': return <span className="text-[9px] text-emerald-500 font-bold w-4 text-center">U</span>;
        default: return <span className="text-[9px] text-white/40 w-4 text-center">?</span>;
    }
  };

  if (!workspaceRoot) {
     return (
        <div className="h-full flex flex-col items-center justify-center p-6 opacity-30 text-[10px] font-black uppercase tracking-[0.5em] text-white">
            WORKSPACE_LOCKED
        </div>
     );
  }

  if (isUninitialized) {
    return (
        <div className="h-full flex flex-col p-6 items-center justify-center gap-8 bg-black/40 animate-in fade-in slide-in-from-left-4 duration-500">
             <div className="flex flex-col items-center justify-center gap-4 group">
                <div className="p-4 rounded-full border border-white/5 bg-white/[0.01] shadow-[inset_0_0_20px_rgba(255,255,255,0.02)]">
                  <GitBranch size={40} className="text-white/40 group-hover:text-white/80 transition-colors" />
                </div>

                <div className="flex flex-col items-center gap-1">
                   <div className="text-[11px] font-black uppercase tracking-[0.5em] text-white/40 group-hover:text-white/80">GIT_SYNC_REQUIRED</div>
                   <div className="text-[8px] font-medium text-white/10 uppercase tracking-[0.2em]">未检测到本地版本库索引</div>
                </div>
                {isLoading ? (
                    <Loader2 size={16} className="animate-spin text-white/20 mt-4" />
                ) : (
                    <button 
                        onClick={initRepo}
                        className="mt-4 px-6 py-2 border border-white/10 rounded-sm text-[8px] font-black tracking-[0.3em] uppercase hover:bg-white/5 hover:border-white/40 transition-all active:scale-95"
                    >
                    初始化存储库 (INIT)
                    </button>
                )}
             </div>
        </div>
    );
  }

  // 渲染变更列表
  const renderStaged = () => {
     if (!status) return null;
     const stagedFiles = status.files.filter(f => f.index !== ' ' && f.index !== '?');
     if (stagedFiles.length === 0) return null;

     return (
        <div className="flex flex-col gap-1 mb-2">
            <div 
                onClick={() => toggleGroup('staged')}
                className="px-3 flex items-center justify-between group cursor-pointer py-1 hover:bg-white/5"
            >
                <div className="text-[9px] font-bold text-white/40 uppercase tracking-widest flex items-center gap-1">
                    {expandedGroups.staged ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                    已暂存文件 (STAGED)
                    <span className="bg-white/5 px-1 rounded text-[8px] ml-1">{stagedFiles.length}</span>
                </div>
            </div>
            {expandedGroups.staged && stagedFiles.map(f => (
                <div 
                    key={f.path} 
                    className="flex items-center gap-2 px-6 py-0.5 hover:bg-white/5 transition-colors group cursor-pointer"
                    onClick={() => window.dispatchEvent(new CustomEvent('ui:file:select', { detail: f.path }))}
                >
                    {getStatusIcon(f.index)}
                    <span className="text-[9px] flex-1 truncate tracking-tighter text-white/60 group-hover:text-white">
                        <span className="font-bold">{f.path.split(/[/\\]/).pop()}</span>
                        <span className="ml-2 text-[8px] text-white/30 lowercase italic">{f.path}</span>
                    </span>
                    {renderHistoryAction(f.path)}
                </div>
            ))}
        </div>
     );
  };

  const renderChanges = () => {
    if (!status) return null;
    const unstagedFiles = status.files.filter(f => f.working_dir !== ' ' && f.working_dir !== '?');
    if (unstagedFiles.length === 0) return null;

    return (
       <div className="flex flex-col gap-1 mb-2">
           <div 
                onClick={() => toggleGroup('modified')}
                className="px-3 flex items-center justify-between group cursor-pointer py-1 hover:bg-white/5"
           >
               <div className="text-[9px] font-bold text-white/40 uppercase tracking-widest flex items-center gap-1">
                   {expandedGroups.modified ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                   已修改文件 (MODIFIED)
                   <span className="bg-white/5 px-1 rounded text-[8px] ml-1">{unstagedFiles.length}</span>
               </div>
           </div>
           {expandedGroups.modified && unstagedFiles.map(f => (
               <div 
                    key={f.path} 
                    className="flex items-center gap-2 px-6 py-0.5 hover:bg-white/5 transition-colors group cursor-pointer"
                    onClick={() => {
                        console.log(`[SourceControl] Selecting file for diff: ${f.path}`);
                        if (f.path && f.path !== '.') {
                            window.dispatchEvent(new CustomEvent('ui:file:select', { 
                                detail: { path: f.path, mode: 'diff' } 
                            }));
                        }
                    }}
               >
                   {getStatusIcon(f.working_dir)}
                   <span className="text-[9px] flex-1 truncate tracking-tighter text-white/60 group-hover:text-white">
                       <span className="font-bold">{f.path.split(/[/\\]/).pop()}</span>
                       <span className="ml-2 text-[8px] text-white/30 lowercase italic">{f.path}</span>
                   </span>
                   {renderHistoryAction(f.path)}
               </div>
           ))}
       </div>
    );
  };

  const renderUntracked = () => {
    if (!status) return null;
    const untrackedFiles = status.files.filter(f => f.working_dir === '?' || f.index === '?');
    if (untrackedFiles.length === 0) return null;

    return (
       <div className="flex flex-col gap-1 mb-2">
           <div 
                onClick={() => toggleGroup('untracked')}
                className="px-3 flex items-center justify-between group cursor-pointer py-1 hover:bg-white/5"
           >
               <div className="text-[9px] font-bold text-white/40 uppercase tracking-widest flex items-center gap-1">
                   {expandedGroups.untracked ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                   未跟踪文件 (UNTRACKED)
                   <span className="bg-white/5 px-1 rounded text-[8px] ml-1">{untrackedFiles.length}</span>
               </div>
           </div>
           {expandedGroups.untracked && untrackedFiles.map(f => (
               <div 
                    key={f.path} 
                    className="flex items-center gap-2 px-6 py-0.5 hover:bg-white/5 transition-colors group cursor-pointer"
                    onClick={() => {
                        console.log(`[SourceControl] Selecting untracked file: ${f.path}`);
                        if (f.path && f.path !== '.') {
                            window.dispatchEvent(new CustomEvent('ui:file:select', { detail: f.path }));
                        }
                    }}
               >
                   {getStatusIcon('?')}
                   <span className="text-[9px] flex-1 truncate tracking-tighter text-white/60 group-hover:text-white">
                       <span className="font-bold">{f.path.split(/[/\\]/).pop()}</span>
                       <span className="ml-2 text-[8px] text-white/30 lowercase italic">{f.path}</span>
                   </span>
                                     {renderHistoryAction(f.path)}
               </div>
           ))}
       </div>
    );
  };

    const renderHistoryPanel = () => {
        return (
            <div className="h-full flex flex-col">
                {/* 仅在查看文件历史时显示返回栏；仓库历史模式下顶部工具栏已标明上下文 */}
                {selectedHistoryFile && (
                    <div className="px-3 py-2 border-b border-white/10 bg-white/[0.02] flex items-center gap-2">
                        <Clock3 size={12} className="text-white/40" />
                        <div className="text-[9px] font-black uppercase tracking-[0.2em] text-white/60">
                            文件历史记录 (FILE HISTORY)
                        </div>
                        <div className="ml-auto">
                            <button
                                onClick={clearFileHistoryFocus}
                                className="px-2 py-1 border border-white/10 text-[8px] font-black uppercase tracking-[0.2em] text-white/50 hover:text-white hover:border-white/40"
                            >
                                返回仓库历史
                            </button>
                        </div>
                    </div>
                )}

                {selectedHistoryFile && (
                    <div className="px-3 py-1.5 border-b border-white/10 bg-white/[0.01] text-[8px] text-white/50 font-mono truncate">
                        FILE: {selectedHistoryFile}
                    </div>
                )}

                {historyError && (
                    <div className="mx-3 mt-3 p-2 border border-red-500/40 bg-red-950/20 text-red-300 text-[9px] font-medium rounded-sm">
                        <div className="font-black uppercase tracking-wider mb-1">Git 历史拉取失败</div>
                        <div className="break-words">{historyError}</div>
                    </div>
                )}

                <div className="flex-1 min-h-0 flex flex-col">
                    <div className="flex-1 min-h-0 overflow-y-auto py-2 custom-scrollbar" style={{ willChange: 'scroll-position' }}>
                        {isHistoryLoading ? (
                            <div className="flex flex-col items-center justify-center h-full gap-2 opacity-20">
                                <Loader2 size={20} className="animate-spin" />
                                <span className="text-[8px] font-black tracking-widest uppercase">加载提交历史...</span>
                            </div>
                        ) : currentHistoryRecords.length > 0 ? (
                            currentHistoryRecords.map((commit) => (
                                <CommitItem
                                    key={commit.hash}
                                    commit={commit}
                                    isSelected={selectedCommitHash === commit.hash}
                                    onSelect={(hash) => fetchCommitDiff(hash, selectedHistoryFile || undefined)}
                                />
                            ))
                        ) : (
                            <div className="flex flex-col items-center justify-center h-full p-6 opacity-15">
                                <History size={28} className="mb-3" />
                                <div className="text-[9px] font-black uppercase tracking-widest">暂无历史记录</div>
                                <div className="text-[8px] mt-1">该仓库尚无可展示的提交</div>
                            </div>
                        )}
                    </div>

                    <div className="h-[42%] min-h-[140px] border-t border-white/10 bg-black/30 overflow-hidden">
                        <DiffViewer
                            diff={selectedCommitDiff}
                            isLoading={isDiffLoading}
                        />
                    </div>
                </div>
            </div>
        );
    };

    const renderChangesPanel = () => {
        return (
            <div className="flex-1 overflow-y-auto py-3 custom-scrollbar">
                {errorMessage && (
                    <div className="mx-3 mb-3 p-2 border border-red-500/40 bg-red-950/20 text-red-300 text-[9px] font-medium rounded-sm">
                        <div className="font-black uppercase tracking-wider mb-1">Git 状态拉取失败</div>
                        <div className="break-words">{errorMessage}</div>
                        <button
                            onClick={() => fetchStatus()}
                            className="mt-2 px-2 py-1 border border-red-400/50 text-red-200 text-[8px] font-black uppercase tracking-wider hover:bg-red-500/20"
                        >
                            重试
                        </button>
                    </div>
                )}

                {isLoading && !status ? (
                    <div className="flex flex-col items-center justify-center h-full gap-2 opacity-20">
                        <Loader2 size={24} className="animate-spin" />
                        <span className="text-[8px] font-black tracking-widest uppercase">扫描中 (SCANNING)...</span>
                    </div>
                ) : status && status.files.length > 0 ? (
                    <>
                        {renderUntracked()}
                        {renderChanges()}
                        {renderStaged()}
                    </>
                ) : status ? (
                    <div className="flex flex-col items-center justify-center h-full p-8 gap-4 opacity-10 grayscale">
                        <AlertCircle size={32} />
                        <div className="text-center">
                            <div className="text-[10px] font-black uppercase tracking-widest">无可提交项</div>
                            <div className="text-[8px] uppercase tracking-tight mt-1">WORKING_TREE_CLEAN</div>
                        </div>
                    </div>
                ) : null}
            </div>
        );
    };

  return (
    <div className="h-full flex flex-col bg-black text-white font-sans overflow-hidden">
                <div className="h-[28px] shrink-0 border-b border-white/10 bg-white/[0.02] flex items-center px-2 gap-1">
                    <button
                        onClick={() => setActiveView('changes')}
                        className={`px-2 py-1 text-[8px] font-black uppercase tracking-[0.2em] border ${
                            activeView === 'changes'
                                ? 'border-white/50 text-white bg-white/10'
                                : 'border-transparent text-white/40 hover:text-white hover:bg-white/5'
                        }`}
                    >
                        变更
                    </button>
                    <button
                        onClick={() => {
                            setActiveView('history');
                            if (!selectedHistoryFile) {
                                fetchRepoHistory();
                            }
                        }}
                        className={`px-2 py-1 text-[8px] font-black uppercase tracking-[0.2em] border flex items-center gap-1 ${
                            activeView === 'history'
                                ? 'border-white/50 text-white bg-white/10'
                                : 'border-transparent text-white/40 hover:text-white hover:bg-white/5'
                        }`}
                    >
                        <History size={10} /> 历史
                    </button>

                    <div className="ml-auto">
                        <button
                            onClick={() => {
                                if (activeView === 'history') {
                                    if (selectedHistoryFile) {
                                        fetchFileHistory(selectedHistoryFile);
                                    } else {
                                        fetchRepoHistory();
                                    }
                                } else {
                                    fetchStatus();
                                }
                            }}
                            className="p-1 border border-white/10 text-white/50 hover:text-white hover:border-white/40"
                            title="刷新"
                        >
                            <RefreshCw size={11} />
                        </button>
                    </div>
                </div>

                {activeView === 'changes' ? renderChangesPanel() : renderHistoryPanel()}
    </div>
  );
};
