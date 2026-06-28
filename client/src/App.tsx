import { useState, useRef, useEffect, useCallback, lazy, Suspense } from 'react';
import { 
  Files, Box, Cpu, HardDrive, Terminal as TerminalIcon, 
  RefreshCw, FolderSync, GitBranch, Search, Puzzle, ListTodo
} from 'lucide-react';
import { 
  Panel, 
  Group as PanelGroup, 
  Separator as PanelResizeHandle 
} from 'react-resizable-panels';
import { FileTree } from '@/components/FileTree';
import { Header } from '@/components/Header';
import { StatusBar } from '@/components/StatusBar';
import { WorkerManager } from '@/services/WorkerManager';
import { switchWorkspace } from '@/services/WorkspaceSwitchService';
import { useAgentContext } from '@/providers/AgentContext';
import { USER_ID, WS_BASE, GATEWAY_EVENT, LEGACY_WS_EVENT } from '@/config';
import { electronBridge } from '@/services/electron-bridge';

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
  const { workspaceRoot, setWorkspaceRoot } = useAgentContext();
  const workspaceRootRef = useRef<string | null>(workspaceRoot);
  const [isSwitchingWorkspace, setIsSwitchingWorkspace] = useState(false);

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

  // 初始同步：状态监控与事件总线 (对齐 15.0 Hot Reattach)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const rootFromUrl = params.get('root');
    const rootHint = workspaceRoot || rootFromUrl;
    const urlSuffix = rootHint ? `&root=${encodeURIComponent(rootHint)}` : '';

    // Delay connect by one tick so transient cleanup/re-run cycles do not
    // create CONNECT->CLOSE races before handshake is established.
    let isDisposed = false;
    const connectTimer = window.setTimeout(() => {
      if (isDisposed) return;
      // Electron 模式：不使用 WebSocket，改用 IPC 事件（通过 electronBridge.onSystemEvent）
      if (electronBridge.isElectron) {
        // 订阅 IPC 系统事件替代 WebSocket
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
        // 在 cleanup 中取消订阅
        const origCleanup = () => { sysCleanup(); };
        (window as any).__electronSysCleanup = origCleanup;
        return;
      }
      WorkerManager.connect('system-events', `${WS_BASE}/ws/events?userId=${USER_ID}${urlSuffix}`, (msg) => {
          if (!msg) return;
        const normalized = (msg?.jsonrpc === '2.0' && msg?.method === 'event/push' && msg?.params)
          ? { type: msg.params.type, payload: msg.params.payload }
          : msg;

        window.dispatchEvent(new CustomEvent(GATEWAY_EVENT, { detail: normalized }));
        // 兼容历史监听器，后续可移除。
        window.dispatchEvent(new CustomEvent(LEGACY_WS_EVENT, { detail: normalized }));
        const payload = normalized.payload || {};
        switch (normalized.type) {
            case 'system:ready':
              // Ready is authoritative: adopt backend root when available.
              if (payload && payload.initialized && payload.workspaceRoot) {
                if (payload.workspaceRoot !== workspaceRootRef.current) {
                  setWorkspaceRoot(payload.workspaceRoot);
                }
              }
              break;
            case 'system:standby':
              // Standby can be emitted by stale/old channels during workspace switch.
              // Do not clear workspaceRoot here; explicit reset/switch flows own root state transitions.
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
    }, 0);

    const handleKeyDown = (e: KeyboardEvent) => {
        if (e.ctrlKey && e.key === 'l') {
            e.preventDefault();
            (document.querySelector('textarea') as HTMLElement)?.focus();
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
      if (electronBridge.isElectron) {
        // 清理 IPC 系统事件订阅
        const sysCleanup = (window as any).__electronSysCleanup;
        if (typeof sysCleanup === 'function') sysCleanup();
        delete (window as any).__electronSysCleanup;
      } else {
        WorkerManager.close('system-events');
      }
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
          onBack={goBack} 
          onForward={goForward} 
          canBack={historyIndex > 0} 
          canForward={historyIndex < history.length - 1} 
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
                      onClick={async () => {
                        if (isSwitchingWorkspace) return;
                          if (confirm('确定要切换工作区吗？当前所有编辑器上下文将被重置。')) {
                              const newPath = prompt('请输入新的工作区物理路径 (留空将重置并返回引导页):');
                              if (newPath !== null) {
                                  try {
                              setIsSwitchingWorkspace(true);
                                      const result = await switchWorkspace(newPath, workspaceRootRef.current);
                                      setWorkspaceRoot(result.workspaceRoot);
                                      setActiveFile('');
                                  } catch (e) {
                                      console.error('Failed to change workspace:', e);
                                      alert('切换工作区失败，系统将回退至锁定状态');
                                      setWorkspaceRoot(null);
                            } finally {
                              setIsSwitchingWorkspace(false);
                                  }
                              }
                          }
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
                <div className="h-[20px] bg-[#080808] flex items-center px-3 text-[8px] font-black uppercase border-b border-white/20 text-white gap-2 tracking-[0.2em]">
                  <TerminalIcon size={9} className="text-white" /> 终端 (TERMINAL) <span className="text-white/80 font-mono">/ tty_main</span>
                  <div className="ml-auto flex items-center gap-1.5 opacity-100">
                    <div className="w-1.5 h-1.5 rounded-full bg-white/60" />
                    <span className="text-[7px]">就绪 (READY)</span>
                  </div>
                </div>
                <div className="flex-1 overflow-hidden min-h-0">
                  <Suspense fallback={<PanelFallback label="Loading Terminal" />}>
                    <Terminal />
                  </Suspense>
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
    </div>
  );
}

export default App;

