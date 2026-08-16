import React, { useEffect, useState } from 'react';
import { GitBranch, Hash, Activity, User, Code2 } from 'lucide-react';
import { USER_ID, GATEWAY_EVENT } from '@/config';
import { useAgentContext } from '@/providers/AgentContext';
import { electronBridge } from '@/services/electron-bridge';

interface StatusBarData {
    user?: {
        id: string;
        name: string;
    };
    model?: {
        provider: string;
        id: string;
    };
    git: {
        initialized?: boolean;
        branch: string;
        isDirty: boolean;
    };
    tokens: {
        total: number;
    };
    memory?: {
        heapUsed: string;
        heapLimit: string;
        percent: string;
    };
}

/**
 * 状态栏组件 (对齐技术规范 第 36 节)
 */
export const StatusBar: React.FC = () => {
    const { workspaceRoot, provider, model } = useAgentContext();
    const [status, setStatus] = useState<StatusBarData | null>(null);
    const [activeLang, setActiveLang] = useState('');
    const [activeFile, setActiveFile] = useState('');
    const [cursor, setCursor] = useState({ line: 0, column: 0, totalLines: 0, selection: 0 });

    const inferLanguageFromFile = (filePath: string): string => {
        const ext = filePath.split('.').pop()?.toLowerCase();
        switch (ext) {
            case 'java': return 'JAVA';
            case 'ts': return 'TYPESCRIPT';
            case 'tsx': return 'TSX';
            case 'js': return 'JAVASCRIPT';
            case 'jsx': return 'JSX';
            case 'py': return 'PYTHON';
            case 'go': return 'GO';
            case 'rs': return 'RUST';
            case 'json': return 'JSON';
            case 'yml':
            case 'yaml': return 'YAML';
            case 'md': return 'MARKDOWN';
            case 'html': return 'HTML';
            case 'css': return 'CSS';
            case 'xml': return 'XML';
            case 'pdf': return 'PDF';
            default: return 'TEXT';
        }
    };

    useEffect(() => {
        let isMounted = true;

        // 1. 系统与 Git 状态更新
        const fetchStatus = async () => {
            try {
                let username = 'Electron';
                try {
                    const appInfo = await electronBridge.getAppInfo();
                    if (appInfo?.username) {
                        username = appInfo.username;
                    }
                } catch {
                    // 获取失败时回退到默认值
                }

                let gitInfo = { initialized: false, branch: '', isDirty: false };
                if (workspaceRoot) {
                    try {
                        const gitRes = await electronBridge.gitStatus({ root: workspaceRoot });
                        if (gitRes && gitRes.success) {
                            gitInfo = {
                                initialized: true,
                                branch: (gitRes.current || '').trim() || 'HEAD',
                                isDirty: Array.isArray(gitRes.files) && gitRes.files.length > 0,
                            };
                        } else {
                            gitInfo = {
                                initialized: false,
                                branch: '',
                                isDirty: false,
                            };
                        }
                    } catch (gitErr) {
                        console.warn('[StatusBar] gitStatus error:', gitErr);
                        gitInfo = {
                            initialized: false,
                            branch: '',
                            isDirty: false,
                        };
                    }
                }

                if (!isMounted) return;

                setStatus(prev => ({
                    ...prev,
                    user: { id: username, name: username },
                    model: {
                        provider: provider || prev?.model?.provider || 'local',
                        id: model || prev?.model?.id || 'electron',
                    },
                    git: gitInfo,
                    tokens: prev?.tokens || { total: 0 },
                }));
            } catch (err) {
                // 忽略错误
            }
        };

        // 立即执行一次并开启定时器
        fetchStatus();
        const pollInterval = setInterval(fetchStatus, 2000);

        // 2. 订阅系统指标广播 (Websocket / IPC 用于高频应急推送)
        const handleWsMessage = (e: any) => {
            const msg = e.detail;
            if (msg.type === 'system:status_bar' && msg.payload) {
                if (isMounted) setStatus(msg.payload);
            } else if (msg.type === 'fs:changed' || msg.type === 'fs:change') {
                fetchStatus();
            }
        };

        const handleTreeRefresh = () => {
            fetchStatus();
        };

        window.addEventListener(GATEWAY_EVENT, handleWsMessage);
        window.addEventListener('ui:file-tree:refresh', handleTreeRefresh);

        // 3. 订阅光标位置变更 (Section 36.1)
        const handleCursor = (e: any) => setCursor(e.detail);
        window.addEventListener('ui:cursor:update', handleCursor);

        // 4. 监听全局语言切换
        const handleLangChange = (e: any) => setActiveLang(e.detail);
        window.addEventListener('ui:editor:lang_change', handleLangChange);

        // 5. 监听当前激活文件
        const handleActiveFile = (e: any) => {
            const nextFile = (e?.detail?.activeFile || '').trim();
            setActiveFile(nextFile);

            // 文件取消选中时，重置语言与光标态，避免残留上一次文件信息。
            if (!nextFile) {
                setActiveLang('');
                setCursor({ line: 0, column: 0, totalLines: 0, selection: 0 });
            }
        };
        window.addEventListener('ui:file:active', handleActiveFile);

        return () => {
            isMounted = false;
            clearInterval(pollInterval);
            window.removeEventListener(GATEWAY_EVENT, handleWsMessage);
            window.removeEventListener('ui:file-tree:refresh', handleTreeRefresh);
            window.removeEventListener('ui:cursor:update', handleCursor);
            window.removeEventListener('ui:editor:lang_change', handleLangChange);
            window.removeEventListener('ui:file:active', handleActiveFile);
        };
    }, [workspaceRoot, provider, model]); // 仅在工作区变化时重建轮询，避免语言变化触发重复定时器

    const hasActiveFile = !!activeFile;
    const isBuiltIn = hasActiveFile && activeLang.includes('(BUILT-IN)');
    const normalizedLang = activeLang.replace(' (BUILT-IN)', '').trim();
    const displayLang = hasActiveFile
        ? (normalizedLang ? normalizedLang.toUpperCase() : inferLanguageFromFile(activeFile))
        : '未选中文件';
    const hasCursorContext = hasActiveFile && cursor.totalLines > 0;
    const encodingLabel = hasActiveFile ? 'UTF-8' : '未选中文件';
    const encodingTitle = hasActiveFile ? '当前文件编码: UTF-8' : '未选中文件';
    const hasGitBranch = !!status?.git?.branch?.trim();
    const isGitInitialized = status?.git?.initialized ?? hasGitBranch;
    const gitBranchLabel = isGitInitialized ? (status?.git?.branch || 'master') : 'git未初始化';
    const gitTooltip = isGitInitialized
        ? `Git 仓库状态: Branch ${status?.git?.branch || 'master'} ${status?.git?.isDirty ? '(有未提交代码)' : '(已同步)'}`
        : 'Git 仓库状态: git未初始化（可执行 git init）';
    const gitIconClass = !isGitInitialized
        ? 'text-white opacity-20'
        : status?.git?.isDirty
            ? 'text-white opacity-90'
            : 'text-white opacity-40';

    return (
        <div data-testid="status-bar" className="h-[24px] w-full bg-[#0a0a0a] flex items-center justify-between px-3 text-white select-none font-medium tracking-tight border-t border-white/10">
            {/* 左侧：用户信息 & Git 分支 */}
            <div className="flex items-center gap-4 h-full">
                <div className="flex items-center gap-1.5 px-1 hover:bg-white/5 rounded-sm transition-colors h-full" title={`用户 ID: ${status?.user?.id || '?'}`}>
                    <div className="w-1.5 h-1.5 rounded-full bg-white opacity-40 animate-pulse" />
                    <User size={10} className="text-white opacity-60" />
                    <span className="font-black uppercase tracking-[0.1em] text-[8px] truncate max-w-[80px] text-white underline decoration-white/20 underline-offset-2">{status?.user?.name || USER_ID}</span>
                </div>

                <div 
                    className="flex items-center gap-1.5 border-l border-white/10 pl-3 group h-[10px] cursor-help"
                    title={gitTooltip}
                >
                    <GitBranch size={10} className={gitIconClass} />
                    <span className={`font-black tracking-[0.1em] text-[8px] ${isGitInitialized ? 'text-white opacity-90' : 'text-white opacity-70'}`}>{gitBranchLabel}</span>
                </div>
            </div>

            {/* 中间：运行时指标 & 警告 (对齐 19.3 节) */}
            <div className="flex items-center gap-6 h-full">
                <div className="flex items-center gap-2" title={`用量: ${status?.tokens?.total || 0} tokens`}>
                    <Hash size={9} className="text-white opacity-20" />
                    <div className="flex items-baseline gap-1">
                        <span className="font-mono text-[8.5px] font-black tabular-nums text-white opacity-100">{(status?.tokens?.total || 0).toLocaleString()}</span>
                        <span className="text-[7.5px] font-black text-white opacity-60">T</span>
                    </div>
                </div>

                {status?.memory && (
                    <div className="flex items-center gap-2 border-l border-white/10 pl-4 h-[10px]" title={`后端内存: ${status.memory.heapUsed} / ${status.memory.heapLimit}`}>
                        <Activity size={9} className={Number(status.memory.percent) > 85 ? "text-red-400 animate-pulse" : "text-white opacity-20"} />
                        <div className="flex items-baseline gap-1">
                            <span className={`font-mono text-[8.5px] font-black tabular-nums transition-colors duration-500 ${Number(status.memory.percent) > 85 ? 'text-red-400' : 'text-white/80'}`}>{status.memory.percent}%</span>
                            <span className="text-[7.5px] font-black text-white opacity-60">RAM</span>
                        </div>
                    </div>
                )}
            </div>

            {/* 右侧：编辑器状态 (对齐 2026.03: 前端仅识别语言，不检查 LSP 状态) */}
            <div className="flex items-center gap-4 scale-95 origin-right h-full">
                <div 
                    className="flex items-center gap-2 px-2 hover:bg-white/5 rounded-sm transition-colors cursor-pointer group h-full"
                    title={hasActiveFile ? `当前语言: ${displayLang}` : '未选中文件'}
                >
                    <div className="w-1.5 h-1.5 rounded-full bg-white opacity-40" />
                    <span className="uppercase font-black tracking-widest text-[8.5px] text-white opacity-100 group-hover:opacity-100">{displayLang}</span>
                    {isBuiltIn && <span className="uppercase font-black text-[7px] opacity-100 text-white ml-1">(BUILT-IN)</span>}
                </div>

                {/* 实时光标坐标与选择 (Section 36.1) */}
                <div 
                    className="flex items-center gap-4 border-l border-white/10 pl-3 font-mono h-[10px] cursor-default"
                    title={hasCursorContext
                        ? `编辑器坐标与编码: ${cursor.line} 行, ${cursor.column} 列 | 编码: UTF-8`
                        : '未选中文件内容'}
                >
                    <div className="flex items-center gap-2 min-w-[90px] justify-end">
                        {hasCursorContext ? (
                            <span className="text-[8.5px] font-black tabular-nums text-white opacity-100 group-hover:opacity-100">行 {cursor.line}, 列 {cursor.column}</span>
                        ) : (
                            <span className="text-[8px] font-black text-white/70 tracking-[0.1em]">未选中文件内容</span>
                        )}
                        {hasCursorContext && cursor.selection > 0 && (
                            <span className="text-[7.5px] bg-white/30 text-white px-1 font-black rounded-xs border border-white/20">
                                选中 {cursor.selection}
                            </span>
                        )}
                    </div>
                    
                    <div className="flex items-center gap-1.5 text-white border-l border-white/10 pl-3" title={encodingTitle}>
                        <span className={`text-[7.5px] font-black opacity-100 ${hasActiveFile ? 'tracking-[0.2em]' : 'tracking-[0.1em]'}`}>{encodingLabel}</span>
                    </div>
                    <Code2 size={10} className="text-white opacity-40" />
                </div>
            </div>
        </div>
    );
};


