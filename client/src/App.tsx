import { useState, useRef, useEffect, useCallback, lazy, Suspense } from 'react';
import { 
  Files, Box, Cpu, HardDrive, Terminal as TerminalIcon, 
  RefreshCw, FolderSync, GitBranch, Search, Puzzle, ListTodo, Loader2, Clock, X, FolderOpen, AlertCircle
} from 'lucide-react';
import { 
  Panel, 
  Group as PanelGroup, 
  Separator as PanelResizeHandle 
} from 'react-resizable-panels';
import { FileTree } from '@/components/FileTree';
import { Header } from '@/components/Header';
import { StatusBar } from '@/components/StatusBar';
import { switchWorkspace } from '@/services/WorkspaceSwitchService';
import { useAgentContext, useProblemContext } from '@/providers/AgentContext';
import { GATEWAY_EVENT, LEGACY_WS_EVENT } from '@/config';
import { electronBridge } from '@/services/electron-bridge';
import { getRecentWorkspaces, removeRecentWorkspace, type RecentWorkspaceEntry } from '@/services/RecentWorkspaces';

// 拖拽分割线组件 (对齐 工业级交互规范)
const ResizeHandle = ({ className = '', id }: { className?: string; id?: string }) => (
  <PanelResizeHandle
    id={id}
    className={`w-[4px] h-full bg-white/[0.03] hover:bg-white/10 transition-colors cursor-col-resize relative z-30 group ${className}`}
  >
    <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-[1px] bg-white/20 group-hover:bg-white/40 group-active:bg-white/60 transition-colors" />
  </PanelResizeHandle>
);

const HorizontalResizeHandle = ({ className = '', id }: { className?: string; id?: string }) => (
  <PanelResizeHandle
    id={id}
    className={`h-[4px] w-full bg-white/[0.03] hover:bg-white/10 transition-colors cursor-row-resize relative z-30 group ${className}`}
  >
    <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-[1px] bg-white/20 group-hover:bg-white/40 group-active:bg-white/60 transition-colors" />
  </PanelResizeHandle>
);

const Terminal = lazy(() => import('@/components/Terminal').then((mod) => ({ default: mod.Terminal })));
const AgentChat = lazy(() => import('@/components/AgentChat').then((mod) => ({ default: mod.AgentChat })));
const SourceControl = lazy(() => import('@/components/SourceControl').then((mod) => ({ default: mod.SourceControl })));
const FileEditor = lazy(() => import('@/components/FileEditor').then((mod) => ({ default: mod.FileEditor })));
const SearchPanel = lazy(() => import('@/components/SearchPanel').then((mod) => ({ default: mod.SearchPanel })));
const ProblemList = lazy(() => import('@/components/ProblemList').then((mod) => ({ default: mod.ProblemList })));

const PanelFallback = ({ label }: { label: string }) => (
  <div className="h-full w-full flex items-center justify-center text-[10px] font-semibold tracking-[0.22em] uppercase text-white/35 bg-black/30">
    {label}
  </div>
);

function App() {
  const [activeFile, setActiveFile] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const [activeSidebarView, setActiveSidebarView] = useState<'explorer' | 'git' | 'search' | 'extensions' | 'todo'>('explorer');
  const [bottomPanelTab, setBottomPanelTab] = useState<'terminal' | 'problems'>('terminal');
  const { workspaceRoot, setWorkspaceRoot } = useAgentContext();
  const { problems } = useProblemContext();
  const workspaceRootRef = useRef<string | null>(workspaceRoot);
  const [isSwitchingWorkspace, setIsSwitchingWorkspace] = useState(false);
  const [workspaceSwitchModal, setWorkspaceSwitchModal] = useState<'hidden' | 'confirm' | 'input' | 'switching'>('hidden');
  const [workspaceSwitchInput, setWorkspaceSwitchInput] = useState('');
  const [workspaceSwitchError, setWorkspaceSwitchError] = useState<string | null>(null);
  const workspaceSwitchInputRef = useRef<HTMLInputElement>(null);
  const [recentWorkspaces, setRecentWorkspaces] = useState<RecentWorkspaceEntry[]>([]);

  // 启动时加载最近工作区列表
  useEffect(() => {
    setRecentWorkspaces(getRecentWorkspaces());
  }, []);

  // 处理文件切换并记录历史 (对齐 3.1 节)
  const navigateToFile = useCallback((file: string, updateHistory = true) => {
    if (!file) return;
    setActiveFile(file);

    if (updateHistory) {
      setHistory((prev) => {
        const truncated = prev.slice(0, historyIndexRef.current + 1);
        if (truncated.length > 0 && truncated[truncated.length - 1] === file) {
          return prev;
        }

        const nextHistory = [...truncated, file].slice(-20);
        const nextIndex = nextHistory.length - 1;
        historyIndexRef.current = nextIndex;
        setHistoryIndex(nextIndex);
        return nextHistory;
      });
    }
  }, []);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    historyIndexRef.current = historyIndex;
  }, [historyIndex]);

  const goBack = useCallback(() => {
    const currentIndex = historyIndexRef.current;
    if (currentIndex > 0) {
      const prev = currentIndex - 1;
      historyIndexRef.current = prev;
      setHistoryIndex(prev);
      navigateToFile(historyRef.current[prev], false);
    }
  }, [navigateToFile]);

  const goForward = useCallback(() => {
    const currentIndex = historyIndexRef.current;
    if (currentIndex < historyRef.current.length - 1) {
      const next = currentIndex + 1;
      historyIndexRef.current = next;
      setHistoryIndex(next);
      navigateToFile(historyRef.current[next], false);
    }
  }, [navigateToFile]);

  const [lockedFiles, setLockedFiles] = useState<Record<string, string>>({}); // path -> toolCallId
  const [editorMode, setEditorMode] = useState<'editor' | 'diff'>('editor');
  const activeFileRef = useRef(activeFile);

  const closeActiveFile = useCallback(() => {
    setActiveFile('');
    setEditorMode('editor');
  }, []);

  const handleFileSelect = useCallback((file: string) => {
    if (!file) {
      closeActiveFile();
      return;
    }

    navigateToFile(file);
  }, [closeActiveFile, navigateToFile]);

  useEffect(() => {
    activeFileRef.current = activeFile;
    window.dispatchEvent(new CustomEvent('ui:file:active', { detail: { activeFile } }));
  }, [activeFile]);

  // 监听 Problems 面板的文件跳转请求
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.filePath) {
        handleFileSelect(detail.filePath);
      }
    };
    window.addEventListener('ui:file:open', handler);
    return () => window.removeEventListener('ui:file:open', handler);
  }, [handleFileSelect]);

  useEffect(() => {
    workspaceRootRef.current = workspaceRoot;
  }, [workspaceRoot]);

  useEffect(() => {
    const preloadHeavyPanels = () => {
      void import('@/components/FileEditor');
      void import('@/components/AgentChat');
      void import('@/components/Terminal');
    };

    const windowWithIdle = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    if (windowWithIdle.requestIdleCallback) {
      const idleId = windowWithIdle.requestIdleCallback(() => preloadHeavyPanels(), { timeout: 2000 });
      return () => {
        windowWithIdle.cancelIdleCallback?.(idleId);
      };
    }

    const timer = window.setTimeout(preloadHeavyPanels, 1200);
    return () => clearTimeout(timer);
  }, []);

  // 工作区切换弹窗：自动聚焦输入框 + 加载最近工作区
  useEffect(() => {
    if (workspaceSwitchModal === 'input') {
      const timer = setTimeout(() => workspaceSwitchInputRef.current?.focus(), 50);
      // 加载最近工作区列表
      setRecentWorkspaces(getRecentWorkspaces());
      return () => clearTimeout(timer);
    }
  }, [workspaceSwitchModal]);

  // 初始同步：状态监控与事件总线 (对齐 15.0 Hot Reattach)
  useEffect(() => {
    // Delay connect by one tick so transient cleanup/re-run cycles do not
    // create CONNECT->CLOSE races before handshake is established.
    let isDisposed = false;
    const connectTimer = window.setTimeout(() => {
      if (isDisposed) return;
      // 通过 IPC 订阅系统事件
      const sysCleanup = electronBridge.onSystemEvent((event) => {
        if (!event) return;
        window.dispatchEvent(new CustomEvent(GATEWAY_EVENT, { detail: event }));
        window.dispatchEvent(new CustomEvent(LEGACY_WS_EVENT, { detail: event }));
        const payload = (event as any).payload || {};
        switch (event.type) {
          case 'system:ready':
            if (payload && payload.initialized && payload.workspaceRoot) {
              if (payload.workspaceRoot !== workspaceRootRef.current) {
                setWorkspaceRoot(payload.workspaceRoot);
              }
            }
            break;
          case 'system:standby':
            break;
          case 'editor:lock':
            setLockedFiles(prev => ({ ...prev, [payload.path]: payload.toolCallId }));
            break;
          case 'editor:unlock':
            setLockedFiles(prev => {
              const next = { ...prev };
              delete next[payload.path];
              return next;
            });
            break;
          case 'terminal:data':
            window.dispatchEvent(new CustomEvent('ui:terminal:data', { detail: payload }));
            break;
        }
      });
      (window as any).__electronSysCleanup = sysCleanup;
    }, 0);

    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.ctrlKey && e.key === 'l') {
            e.preventDefault();
            // 精确定位 AgentChat 面板的主输入框（排除 Monaco 编辑器、临时复制 textarea 等干扰）
            const chatTextarea = document.querySelector('[data-testid="agent-chat-input"]') as HTMLElement;
            if (chatTextarea) {
                chatTextarea.focus();
            } else {
                // 降级方案：查找 form 内的 textarea（非 readonly 且非隐藏）
                const fallback = document.querySelector('form textarea:not([readonly])') as HTMLElement;
                fallback?.focus();
            }
        }
    };
    window.addEventListener('keydown', handleKeyDown);
    const onFileSelectRequest = (e: any) => {
        const payload = e.detail;
        if (typeof payload === 'string') {
        if (!payload) {
          closeActiveFile();
          return;
        }
            setEditorMode('editor');
            navigateToFile(payload);
        } else if (payload && payload.path) {
            // 支持带 mode 的复杂选择事件 (对齐 Diff 视图重构)
            setEditorMode(payload.mode || 'editor');
            navigateToFile(payload.path);
        }
    };
    window.addEventListener('ui:file:select', onFileSelectRequest);
    return () => {
      isDisposed = true;
      clearTimeout(connectTimer);
      // 清理 IPC 系统事件订阅
      const sysCleanup = (window as any).__electronSysCleanup;
      if (typeof sysCleanup === 'function') sysCleanup();
      delete (window as any).__electronSysCleanup;
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('ui:file:select', onFileSelectRequest);
    };
  }, [closeActiveFile, navigateToFile, workspaceRoot]);

  const isCurrentFileLocked = !!lockedFiles[activeFile];
  // const supportedLspLanguages = ['java', 'python', 'typescript', 'javascript'];

  return (
    <div className="flex flex-col h-full w-full bg-black text-white font-sans overflow-hidden antialiased relative">
      <div className="h-[24px] shrink-0 z-50 bg-[#080808] border-b border-white/50 shadow-[0_1px_4px_rgba(0,0,0,0.5)]">
        <Header 
          activeFile={activeFile} 
          workspaceRoot={workspaceRoot}
          recentWorkspaces={recentWorkspaces}
          onBack={goBack} 
          onForward={goForward} 
          canBack={historyIndex > 0} 
          canForward={historyIndex < history.length - 1}
          onOpenWorkspace={() => {
            if (electronBridge.isElectron) {
              electronBridge.selectWorkspace().then((selectedPath) => {
                if (selectedPath) {
                  setWorkspaceSwitchInput(selectedPath);
                  setWorkspaceSwitchError(null);
                  setWorkspaceSwitchModal('input');
                  setRecentWorkspaces(getRecentWorkspaces());
                }
              }).catch(() => {});
            }
          }}
          onSwitchWorkspace={(newPath: string) => {
            setWorkspaceSwitchInput(newPath);
            setWorkspaceSwitchError(null);
            setWorkspaceSwitchModal('switching');
            setIsSwitchingWorkspace(true);
            void (async () => {
              try {
                const result = await switchWorkspace(newPath, workspaceRootRef.current);
                if (!result || result.status !== 'success') {
                  throw new Error('工作区切换未返回有效结果');
                }
                setWorkspaceSwitchModal('hidden');
                setWorkspaceRoot(result.workspaceRoot);
                setActiveFile('');
              } catch (e: any) {
                const errMsg = e?.message || String(e || '未知错误');
                console.error('[WorkspaceSwitch] 切换失败:', errMsg);
                setWorkspaceSwitchModal('input');
                setWorkspaceSwitchError(`切换失败: ${errMsg}`);
              } finally {
                setIsSwitchingWorkspace(false);
              }
            })();
          }}
        />
      </div>

      <div className="flex-1 flex min-w-0 min-h-0 overflow-hidden relative bg-black">
        <PanelGroup orientation="horizontal">
          {/* Explorer Sidebar */}
          <Panel defaultSize={15} minSize={10} className="flex flex-row min-h-0 bg-[#050505] shadow-xl z-20">
            {/* Activity Bar (Stark narrow strip) 对齐 Section 15.2 */}
            <div className="w-[44px] flex flex-col items-center py-2 gap-4 bg-black border-r border-white/15 shrink-0">
               {[
                 { id: 'explorer', icon: Files, label: '资源管理器' },
                 { id: 'search', icon: Search, label: 'SEARCH' },
                 { id: 'git', icon: GitBranch, label: '源代码管理' }
               ].map((item) => (
                 <button 
                  key={item.id}
                  onClick={() => setActiveSidebarView(item.id as any)}
                  data-testid={`activity-bar-${item.id}`}
                  className={`p-2 transition-all relative group ${
                    activeSidebarView === item.id ? 'text-white' : 'text-white/40 hover:text-white'
                  }`}
                  title={item.label}
                 >
                   <item.icon size={20} className={activeSidebarView === item.id ? 'stroke-[2.5px]' : 'stroke-[1.5px]'} />
                   {activeSidebarView === item.id && (
                     <div className="absolute left-0 top-1.5 bottom-1.5 w-[2px] bg-white shadow-[0_0_8px_white]" />
                   )}
                 </button>
               ))}
            </div>

            {/* Sidebar View Content Area */}
            <div className="flex-1 flex flex-col min-w-0 min-h-0">
              <div className="h-[24px] px-3 gap-2 uppercase text-[7.5px] font-black text-white flex items-center border-b border-white/20 tracking-[0.2em] bg-white/[0.02] shrink-0">
                {activeSidebarView === 'explorer' && <><Files size={9} className="text-white/80" /> 资源管理器</>}
                {activeSidebarView === 'git' && <><GitBranch size={9} className="text-white/80" /> 源代码管理</>}
                {activeSidebarView === 'search' && <><Search size={9} className="text-white/80" /> 全局搜索</>}
                {activeSidebarView === 'todo' && <><ListTodo size={9} className="text-white/80" /> 任务流水线 (MISSION_PIPELINE)</>}
                {activeSidebarView === 'extensions' && <><Puzzle size={9} className="text-white/80" /> 插件枢纽 (PLUGINS)</>}

                <div className="ml-auto flex items-center gap-1">
                  {workspaceRoot && (
                    <button 
                      onClick={() => {
                        if (isSwitchingWorkspace) return;
                        setWorkspaceSwitchError(null);
                        setWorkspaceSwitchModal('confirm');
                      }}
                      disabled={isSwitchingWorkspace}
                      className="p-1 hover:bg-white/10 rounded-sm transition-colors text-white opacity-80 hover:opacity-100 disabled:opacity-40 disabled:cursor-not-allowed"
                      title="切换工作区 (SWITCH)"
                      data-testid="switch-workspace-btn"
                    >
                      <FolderSync size={10} />
                    </button>
                  )}
                  <button 
                    onClick={() => window.dispatchEvent(new CustomEvent('ui:file-tree:refresh'))}
                    className="p-1 hover:bg-white/10 rounded-sm transition-colors text-white opacity-40 hover:opacity-100"
                    title="同步文件系统 (SYNC)"
                  >
                    <RefreshCw size={10} />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-hidden min-h-0 bg-[#080808]/40">
                {activeSidebarView === 'explorer' ? (
                  <FileTree activeFile={activeFile} onFileSelect={handleFileSelect} />
                ) : activeSidebarView === 'git' ? (
                  <Suspense fallback={<PanelFallback label="Loading Git" />}>
                    <SourceControl />
                  </Suspense>
                ) : activeSidebarView === 'search' ? (
                  <Suspense fallback={<PanelFallback label="Loading Search" />}>
                    <SearchPanel activeFile={activeFile} onFileSelect={handleFileSelect} />
                  </Suspense>
                ) : (
                  <div className="h-full flex flex-col p-6 items-center justify-center opacity-[0.05] pointer-events-none select-none animate-pulse">
                     <Box size={48} className="text-white mb-4" />
                     <div className="text-[10px] font-black uppercase tracking-[0.5em] text-white">UNDER_CONSTRUCTION</div>
                  </div>
                )}
              </div>
            </div>
          </Panel>

          <ResizeHandle />

          {/* Editor & Terminal Middle Section */}
          <Panel defaultSize={28} minSize={15} className="flex flex-col min-w-0 min-h-0 relative bg-black z-10">
            <PanelGroup orientation="vertical">
              <Panel defaultSize={75} minSize={20} className="flex flex-col overflow-hidden relative min-h-0">
                {activeFile ? (
                  <Suspense fallback={<PanelFallback label="Loading Editor" />}>
                    <FileEditor 
                      activeFile={activeFile} 
                      isLocked={isCurrentFileLocked} 
                      mode={editorMode}
                      onClose={closeActiveFile}
                    />
                  </Suspense>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center bg-black relative" data-testid="empty-editor-placeholder">
                    <div className="absolute inset-0 opacity-[0.01] flex items-center justify-center pointer-events-none">
                      <Box size={400} />
                    </div>
                    <div className="z-10 flex flex-col items-center gap-6">
                      <div className="flex items-center gap-4 animate-pulse opacity-20">
                        <Cpu size={32} className="text-white" />
                        <div className="w-[1px] h-8 bg-white/10" />
                        <HardDrive size={32} className="text-white" />
                      </div>
                      <div className="flex flex-col items-center gap-1">
                        <div className="text-[10px] font-black text-white/5 uppercase tracking-[0.5em]">系统Agent助手待机 (STANDBY)</div>
                        <div className="text-[8px] font-medium text-white/[0.03] uppercase tracking-[0.3em]">节点集群：已集成 (INTEGRATED)</div>
                      </div>
                    </div>
                  </div>
                )}
              </Panel>

              <HorizontalResizeHandle />

              <Panel defaultSize={25} minSize={10} className="bg-[#020202] flex flex-col shrink-0 z-20 min-h-0">
                {/* 底部面板 Tab 栏 */}
                <div className="h-[24px] bg-[#0a0a0a] flex items-center border-b border-white/10 shrink-0">
                  {[
                    { id: 'terminal' as const, icon: TerminalIcon, label: '终端' },
                    { id: 'problems' as const, icon: AlertCircle, label: '问题' },
                  ].map((tab) => {
                    const isActive = bottomPanelTab === tab.id;
                    const errorCount = tab.id === 'problems' ? problems.filter(p => p.severity === 'error').length : 0;
                    const warnCount = tab.id === 'problems' ? problems.filter(p => p.severity === 'warning').length : 0;
                    return (
                      <button
                        key={tab.id}
                        onClick={() => setBottomPanelTab(tab.id)}
                        className={`h-full px-3 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider transition-colors border-b-[1.5px] shrink-0 ${
                          isActive
                            ? 'text-white border-white/80 bg-white/[0.04]'
                            : 'text-white/35 border-transparent hover:text-white/60 hover:bg-white/[0.02]'
                        }`}
                      >
                        <tab.icon size={11} className={isActive ? 'text-white/90' : 'text-white/35'} />
                        <span>{tab.label}</span>
                        {tab.id === 'problems' && problems.length > 0 && (
                          <span className="text-[8px] ml-0.5">
                            {errorCount > 0 && <span className="text-red-400">({errorCount})</span>}
                            {errorCount === 0 && warnCount > 0 && <span className="text-yellow-400/70">({warnCount})</span>}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  <div className="flex-1" />
                  {bottomPanelTab === 'terminal' && (
                    <div className="flex items-center gap-1.5 px-2 opacity-60">
                      <div className="w-1.5 h-1.5 rounded-full bg-white/60" />
                      <span className="text-[7px] text-white/60">就绪</span>
                    </div>
                  )}
                </div>

                {/* 底部面板内容区 — 使用 CSS 可见性控制，避免终端销毁重建 */}
                <div className="flex-1 overflow-hidden min-h-0">
                  <div className={bottomPanelTab === 'terminal' ? '' : 'hidden'}>
                    <Suspense fallback={<PanelFallback label="Loading Terminal" />}>
                      <Terminal />
                    </Suspense>
                  </div>
                  <div className={bottomPanelTab === 'problems' ? '' : 'hidden'}>
                    <Suspense fallback={<PanelFallback label="Loading Problems" />}>
                      <ProblemList />
                    </Suspense>
                  </div>
                </div>
              </Panel>
            </PanelGroup>
          </Panel>

          <ResizeHandle />

          {/* Right Sidebar Group */}
          <Panel defaultSize={40} minSize={20} className="flex flex-col bg-[#010101] z-20 shadow-[-10px_0_30px_-15px_rgba(0,0,0,0.8)] min-h-0">
            <Suspense fallback={<PanelFallback label="Loading Chat" />}>
              <AgentChat />
            </Suspense>
          </Panel>

        </PanelGroup>
      </div>

      <div className="h-[24px] shrink-0 z-30 bg-[#080808] border-t border-white/20 flex items-center">
        <StatusBar />
      </div>

      {/* 工作区切换弹窗（替代被 Electron 禁用的 window.prompt） */}
      {workspaceSwitchModal !== 'hidden' && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-[#1a1a1a] border border-white/20 rounded-lg shadow-2xl w-[480px] max-w-[90vw] overflow-hidden">
            {/* 标题栏 */}
            <div className="h-8 px-4 flex items-center border-b border-white/10 bg-[#111]">
              <FolderSync size={14} className={`${workspaceSwitchModal === 'switching' ? 'animate-spin' : ''} text-white/70 mr-2`} />
              <span className="text-xs font-semibold text-white/80">
                {workspaceSwitchModal === 'switching' ? '正在切换工作区…' : '切换工作区'}
              </span>
            </div>

            {workspaceSwitchModal === 'confirm' ? (
              <>
                <div className="p-5 text-sm text-white/80 leading-relaxed">
                  确定要切换工作区吗？<br />
                  <span className="text-white/50 text-xs">当前所有编辑器上下文将被重置。</span>
                </div>
                <div className="flex justify-end gap-2 px-5 pb-4">
                  <button
                    onClick={() => { setWorkspaceSwitchModal('hidden'); setWorkspaceSwitchError(null); }}
                    className="px-4 py-1.5 text-xs rounded bg-white/10 hover:bg-white/20 text-white/70 transition-colors"
                  >
                    取消
                  </button>
                  <button
                    onClick={() => { setWorkspaceSwitchModal('input'); setWorkspaceSwitchInput(''); setWorkspaceSwitchError(null); }}
                    className="px-4 py-1.5 text-xs rounded bg-white/20 hover:bg-white/30 text-white transition-colors"
                  >
                    确定
                  </button>
                </div>
              </>
            ) : workspaceSwitchModal === 'switching' ? (
              <div className="p-8 flex flex-col items-center gap-4">
                <Loader2 size={32} className="animate-spin text-white/60" />
                <p className="text-sm text-white/60">正在初始化新工作区，请稍候…</p>
              </div>
            ) : (
              <>
                <div className="p-5">
                  <label className="block text-xs text-white/60 mb-2">
                    请输入新的工作区物理路径（留空将重置并返回引导页）:
                  </label>
                  <input
                    ref={workspaceSwitchInputRef}
                    type="text"
                    value={workspaceSwitchInput}
                    onChange={(e) => { setWorkspaceSwitchInput(e.target.value); setWorkspaceSwitchError(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') document.getElementById('ws-switch-ok-btn')?.click(); }}
                    disabled={isSwitchingWorkspace}
                    className="w-full px-3 py-2 text-sm bg-black border border-white/20 rounded text-white placeholder-white/30 focus:outline-none focus:border-white/50 transition-colors disabled:opacity-40"
                    placeholder="例如: D:\my-project"
                  />
                  {workspaceSwitchError && (
                    <p className="mt-2 text-xs text-red-400">{workspaceSwitchError}</p>
                  )}

                  {/* 最近打开的工作区 */}
                  {recentWorkspaces.length > 0 && (
                    <div className="mt-4">
                      <div className="flex items-center gap-1.5 mb-2">
                        <Clock size={11} className="text-white/35" />
                        <span className="text-[10px] text-white/35 uppercase tracking-wider">最近打开的工作区</span>
                      </div>
                      <div className="max-h-[160px] overflow-y-auto space-y-0.5 custom-scrollbar-thin">
                        {recentWorkspaces.map((entry) => (
                          <div
                            key={entry.path}
                            className="flex items-center gap-2 px-2 py-1.5 rounded group hover:bg-white/5 cursor-pointer transition-colors"
                            onClick={() => {
                              setWorkspaceSwitchInput(entry.path);
                              setWorkspaceSwitchError(null);
                            }}
                            title={entry.path}
                          >
                            <FolderOpen size={12} className="text-white/25 shrink-0 group-hover:text-white/50 transition-colors" />
                            <span className="text-[11px] text-white/60 truncate flex-1 group-hover:text-white/80 transition-colors">
                              {entry.path}
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                removeRecentWorkspace(entry.path);
                                setRecentWorkspaces(getRecentWorkspaces());
                              }}
                              className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5 rounded hover:bg-white/10 transition-all shrink-0"
                              title="从列表中移除"
                            >
                              <X size={10} className="text-white/50" />
                            </button>
                          </div>
                        ))}
                      </div>
                      <div className="mt-1.5 text-right">
                        <button
                          onClick={() => {
                            if (electronBridge.isElectron) {
                              electronBridge.selectWorkspace().then((selectedPath) => {
                                if (selectedPath) {
                                  setWorkspaceSwitchInput(selectedPath);
                                  setWorkspaceSwitchError(null);
                                }
                              }).catch(() => {});
                            }
                          }}
                          className="text-[9px] text-white/30 hover:text-white/60 transition-colors uppercase tracking-wider"
                        >
                          浏览文件夹...
                        </button>
                      </div>
                    </div>
                  )}
                  {recentWorkspaces.length === 0 && (
                    <div className="mt-4">
                      <div className="flex items-center gap-1.5 mb-1">
                        <Clock size={11} className="text-white/20" />
                        <span className="text-[10px] text-white/20 uppercase tracking-wider">暂无最近工作区记录</span>
                      </div>
                      {electronBridge.isElectron && (
                        <button
                          onClick={() => {
                            electronBridge.selectWorkspace().then((selectedPath) => {
                              if (selectedPath) {
                                setWorkspaceSwitchInput(selectedPath);
                                setWorkspaceSwitchError(null);
                              }
                            }).catch(() => {});
                          }}
                          className="text-[9px] text-white/30 hover:text-white/60 transition-colors uppercase tracking-wider"
                        >
                          浏览文件夹...
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex justify-end gap-2 px-5 pb-4">
                  <button
                    onClick={() => { setWorkspaceSwitchModal('hidden'); setWorkspaceSwitchError(null); }}
                    disabled={isSwitchingWorkspace}
                    className="px-4 py-1.5 text-xs rounded bg-white/10 hover:bg-white/20 text-white/70 transition-colors disabled:opacity-30"
                  >
                    取消
                  </button>
                  <button
                    id="ws-switch-ok-btn"
                    disabled={isSwitchingWorkspace}
                    onClick={() => {
                      const newPath = workspaceSwitchInput.trim();
                      setWorkspaceSwitchError(null);
                      setWorkspaceSwitchModal('switching');
                      setIsSwitchingWorkspace(true);

                      void (async () => {
                        try {
                          const result = await switchWorkspace(newPath, workspaceRootRef.current);
                          // 防御：确保返回了有效的 workspaceRoot
                          if (!result || result.status !== 'success') {
                            throw new Error('工作区切换未返回有效结果');
                          }
                          setWorkspaceSwitchModal('hidden');
                          setWorkspaceRoot(result.workspaceRoot);
                          setActiveFile('');
                        } catch (e: any) {
                          const errMsg = e?.message || String(e || '未知错误');
                          console.error('[WorkspaceSwitch] 切换失败:', errMsg);
                          // 回到输入步骤，显示错误，不把 workspaceRoot 置 null
                          setWorkspaceSwitchModal('input');
                          setWorkspaceSwitchError(`切换失败: ${errMsg}`);
                        } finally {
                          setIsSwitchingWorkspace(false);
                        }
                      })();
                    }}
                    className="px-4 py-1.5 text-xs rounded bg-white/20 hover:bg-white/30 text-white transition-colors disabled:opacity-30"
                  >
                    确定
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

