import React, { useEffect, useRef } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { useAgentContext } from '@/providers/AgentContext';
import { USER_ID, TERMINAL_HTTP_BASE } from '@/config';
import { Lock } from 'lucide-react';
import { electronBridge } from '@/services/electron-bridge';

export const Terminal: React.FC = () => {
    const { workspaceRoot } = useAgentContext();
    const terminalRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<XTerm | null>(null);
    const reconnectTimeoutRef = useRef<any | null>(null);
    const resizeTimeoutRef = useRef<any | null>(null);
    const initOpenTimeoutRef = useRef<any | null>(null);
    const inputLineBufferRef = useRef('');
    const rafRef = useRef<number | null>(null);
    const isReadyRef = useRef<boolean>(true); // 修改：默认为 true，解决 E2E 测试和组件初次挂载时的显示延迟问题
    const lastDimsRef = useRef<{ cols: number, rows: number } | null>(null); // 新增：Resize 幂等校验
    const activeESRef = useRef<EventSource | null>(null); // 新增：单实例引用，防止多开导致的重复输出
    const hasConnectedRef = useRef<boolean>(false); // 新增：防止延迟可见时重复调用 connectTerminal

    useEffect(() => {
        if (!terminalRef.current || !workspaceRoot) return;

        let isDisposed = false;
        let dataDisposer: { dispose: () => void } | undefined;

        const term = new XTerm({
            theme: {
                background: '#000000',
                foreground: '#ffffff',
                cursor: '#10B981',
                selectionBackground: 'rgba(255, 255, 255, 0.2)',
                black: '#000000',
                red: '#EF4444',
                green: '#10B981',
                yellow: '#F59E0B',
                blue: '#3B82F6',
                magenta: '#8B5CF6',
                cyan: '#06B6D4',
                white: '#FFFFFF',
            },
            cursorBlink: true,
            fontFamily: 'JetBrains Mono, Menlo, Monaco, "Courier New", monospace',
            fontSize: 12,
            lineHeight: 1.3,
            scrollback: 5000,
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        
        // 使用唯一 sessionId（含时间戳），避免 workspaceRoot 切换时旧 PTY 的异步退出事件
        // 污染新 PTY 的 listener（两者 sessionId 相同会导致误触发重连循环）
        const sessionId = `term-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

        const clearTerminalReplayBuffer = async () => {
            try {
                await fetch(`${TERMINAL_HTTP_BASE}/terminal/clear-buffer`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: USER_ID, sessionId })
                });
            } catch (error) {
                console.warn('[Terminal] Failed to clear replay buffer:', error);
            }
        };

        const processInputBufferForClear = (rawInput: string) => {
            for (const ch of rawInput) {
                if (ch === '\r') {
                    const command = inputLineBufferRef.current.trim().toLowerCase();
                    if (command === 'clear' || command === 'cls' || command === 'clear-host') {
                        term.clear();
                        void clearTerminalReplayBuffer();
                    }
                    inputLineBufferRef.current = '';
                    continue;
                }

                if (ch === '\n') continue;

                if (ch === '\u007f' || ch === '\b') {
                    inputLineBufferRef.current = inputLineBufferRef.current.slice(0, -1);
                    continue;
                }

                if (ch === '\u0015') {
                    inputLineBufferRef.current = '';
                    continue;
                }

                if (ch >= ' ' && ch <= '~') {
                    inputLineBufferRef.current += ch;
                    if (inputLineBufferRef.current.length > 512) {
                        inputLineBufferRef.current = inputLineBufferRef.current.slice(-512);
                    }
                }
            }
        };

        // 对齐 43.1.2: PTY 初始化重试机制 (Section 43.1.2 Retry Strategy)
        const connectTerminal = () => {
            if (isDisposed) return;
            
            // ── Electron 模式：使用 IPC 直接操作 node-pty ──
            if (electronBridge.isElectron) {
                console.log(`[Terminal] [${new Date().toLocaleTimeString()}] Connecting via Electron IPC...`);
                
                // 创建终端会话
                electronBridge.createTerminal({
                    userId: USER_ID,
                    sessionId,
                    workDir: workspaceRoot,
                    cols: term.cols,
                    rows: term.rows,
                }).then((result: any) => {
                    if (isDisposed) return;
                    console.log('[Terminal] Electron PTY created:', result);
                    isReadyRef.current = true;
                    // 仅当 xterm 实例仍存活且未被销毁时才聚焦
                    if (xtermRef.current && !(xtermRef.current as any)._disposed) {
                        term.focus();
                    }
                }).catch((err: any) => {
                    if (isDisposed) return;
                    console.error('[Terminal] Failed to create PTY:', err);
                    // 重试
                    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
                    reconnectTimeoutRef.current = setTimeout(connectTerminal, 2000);
                });
                
                // 监听终端输出
                const outputCleanup = electronBridge.onTerminalOutput((output: any) => {
                    if (isDisposed || output.sessionId !== sessionId) return;
                    if (output.type === 'exit') {
                        console.warn('[Terminal] PTY exited, reconnecting...');
                        if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
                        reconnectTimeoutRef.current = setTimeout(connectTerminal, 300);
                        return;
                    }
                    try {
                        term.write(output.data, () => {
                            if (term.buffer.active.baseY > 0) {
                                term.scrollToBottom();
                            }
                        });
                    } catch (err) {
                        // ignore write errors
                    }
                });

                // [Fix] 注册键盘输入监听，将用户按键转发给 node-pty。
                // 此前该分支缺少 term.onData 绑定（仅 SSE/Web 分支有），
                // 导致 electronBridge.isElectron 恒为 true 时终端完全无法交互输入。
                if (!dataDisposer) {
                    dataDisposer = term.onData((data) => {
                        processInputBufferForClear(data);
                        electronBridge.sendTerminalInput(sessionId, data);
                    });
                }
                
                return () => {
                    outputCleanup();
                    electronBridge.destroyTerminal(sessionId);
                };
            }
            
            // [Fix] 显式销毁旧的 SSE 实例，防止多连接导致的重复字符输出
            if (activeESRef.current) {
                console.log(`[Terminal] Closing stale EventSource before reconnect...`);
                activeESRef.current.close();
            }
            
            console.log(`[Terminal] [${new Date().toLocaleTimeString()}] Establishing SSE Stream...`);
            
            const params = new URLSearchParams({
                userId: USER_ID,
                sessionId,
                root: workspaceRoot,
                cols: term.cols.toString(),
                rows: term.rows.toString()
            });

            const eventSource = new EventSource(`${TERMINAL_HTTP_BASE}/terminal/stream?${params.toString()}`);
            activeESRef.current = eventSource;

            eventSource.addEventListener('snapshot', (e: MessageEvent) => {
                if (isDisposed || eventSource !== activeESRef.current) return;
                try {
                    const data = JSON.parse(e.data);
                    term.clear();
                    term.write(data.payload, () => {
                        // [工业级对齐] 快照回放后必须强制同步到底部
                        term.scrollToBottom();
                    });
                } catch (err) {}
            });

            eventSource.addEventListener('delta', (e: MessageEvent) => {
                if (isDisposed || eventSource !== activeESRef.current) return;
                try {
                    const data = JSON.parse(e.data);
                    term.write(data.payload, () => {
                        // [工业级对齐] 确保内容写入后，UI 自动滚动到最底部
                        // 解决图片中显示的“滚动条拉到底但内容未对齐底部”的问题
                        if (term.buffer.active.baseY > 0) {
                            term.scrollToBottom();
                        }
                    });
                } catch (err) {}
            });

            eventSource.onopen = () => {
                if (isDisposed) return;
                console.log('[Terminal] SSE Connected.');
                // 仅当 xterm 实例仍存活且未被销毁时才聚焦
                if (xtermRef.current && !(xtermRef.current as any)._disposed) {
                    term.focus();
                }
            };

            eventSource.onerror = () => {
                // 如果是当前活动的连接失败，才尝试重连
                if (eventSource === activeESRef.current) {
                    console.warn('[Terminal] SSE Connection failed, retrying...');
                    eventSource.close();
                    if (!isDisposed) {
                        if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
                        reconnectTimeoutRef.current = setTimeout(connectTerminal, 2000);
                    }
                }
            };

            eventSource.addEventListener('exit', () => {
                if (isDisposed || eventSource !== activeESRef.current) return;
                console.warn('[Terminal] PTY exited, reconnecting terminal stream...');
                eventSource.close();
                if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
                reconnectTimeoutRef.current = setTimeout(connectTerminal, 300);
            });

            // 监听输入并发送 REST POST
            if (!dataDisposer) {
                dataDisposer = term.onData((data) => {
                    processInputBufferForClear(data);
                    if (electronBridge.isElectron) {
                        electronBridge.sendTerminalInput(sessionId, data);
                    } else {
                        fetch(`${TERMINAL_HTTP_BASE}/terminal/input`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ userId: USER_ID, sessionId, data, root: workspaceRoot, cols: term.cols, rows: term.rows })
                        }).catch(err => console.error('[Terminal] Input failed', err));
                    }
                });
            }

            return () => {
                eventSource.close();
                if (activeESRef.current === eventSource) activeESRef.current = null;
            };
        };

        let streamCleanup: (() => void) | undefined;
        const bufferedData: string[] = [];

        const handleResize = () => {
            if (isDisposed || !terminalRef.current) return;

            // 对齐 43.1: 如果之前因为容器没宽度而延迟了 open，在此处补位挂载
            if (!xtermRef.current && terminalRef.current.clientWidth > 0) {
                console.log('[Terminal] Container now visible, delayed open triggering...');
                term.open(terminalRef.current);
                xtermRef.current = term;
                // 首次连接（仅一次），防止重复创建 PTY / SSE
                if (!hasConnectedRef.current) {
                    hasConnectedRef.current = true;
                    try {
                        fitAddon.fit();
                        isReadyRef.current = true;
                        if (bufferedData.length > 0) {
                            bufferedData.forEach(d => { try { term.write(d); } catch (e) {} });
                            bufferedData.length = 0;
                        }
                        const { cols, rows } = term;
                        if (lastDimsRef.current?.cols !== cols || lastDimsRef.current?.rows !== rows) {
                            lastDimsRef.current = { cols, rows };
                            if (electronBridge.isElectron) {
                                electronBridge.resizeTerminal(sessionId, cols, rows);
                            } else {
                                fetch(`${TERMINAL_HTTP_BASE}/terminal/resize`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ userId: USER_ID, sessionId, cols, rows, root: workspaceRoot })
                                }).catch(err => console.error('[Terminal] Initial resize failed', err));
                            }
                        }
                    } catch (e) {
                        console.warn('[Terminal] Delayed init error:', e);
                    }
                    streamCleanup = connectTerminal();
                }
            }

            if (!xtermRef.current) return;
            const termInstance = xtermRef.current;
            // @ts-ignore - Check for disposal
            if ((termInstance as any)._disposed) return;
            
            // [2026.03] 修复：引入 Resize 防抖逻辑，并增加尺寸边界保护 (Size Sanitization)
            // 严禁发送 rows < 2 或 cols < 10 的极小尺寸，避免 Shell 产生巨大的 Reflow 洪水
            const throttleResize = () => {
                if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
                resizeTimeoutRef.current = setTimeout(() => {
                    if (isDisposed || (termInstance as any)._disposed) return;
                    
                    const { cols, rows } = termInstance;
                    // 对齐 4.5.11: 尺寸安全阈值，防止无效尺寸导致后端的 PTY 指令堆叠
                    if (cols < 10 || rows < 2) {
                        console.warn(`[Terminal] [${new Date().toLocaleTimeString()}] Resizing aborted: dimensions too small (${cols}x${rows})`);
                        return;
                    }

                    // [2026.03] 修复：Resize 幂等校验，防止冗余的 ResizeObserver 信号触发布署后的 PTY 重绘
                    if (lastDimsRef.current?.cols === cols && lastDimsRef.current?.rows === rows) {
                        return;
                    }

                    console.log(`[Terminal] [${new Date().toLocaleTimeString()}] Debounced Resize: ${cols}x${rows}`);
                    lastDimsRef.current = { cols, rows };
                    if (electronBridge.isElectron) {
                        electronBridge.resizeTerminal(sessionId, cols, rows);
                    } else {
                        fetch(`${TERMINAL_HTTP_BASE}/terminal/resize`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ userId: USER_ID, sessionId, cols, rows, root: workspaceRoot })
                        }).catch(err => console.error('[Terminal] Resize failed', err));
                    }
                    termInstance.scrollToBottom();
                }, 300); // 300ms 稳定后发送
            };

            try {
                // 对齐 4.5.11: 容错处理 (Resize Observer 可能在容器隐藏时触发)
                if (terminalRef.current && terminalRef.current.clientWidth > 0 && terminalRef.current.clientHeight > 0) {
                    const core = (termInstance as any)._core;
                    const renderService = core?._renderService;
                    // 工业级双重防护 (Section 43.2.1): 
                    // 1. hasRenderer() 确保渲染引擎挂载。
                    // 2. try-access dimensions 确保内部 getter 不抛错。
                    const isRenderable = renderService && 
                                       typeof renderService.hasRenderer === 'function' && 
                                       renderService.hasRenderer();
                    
                    if (isRenderable) {
                        try {
                            const dims = renderService.dimensions;
                            if (dims) {
                                fitAddon.fit();
                                throttleResize();
                            }
                        } catch (e) {
                             console.log('[Terminal] Renderer dimension check skipped (transient state)');
                        }
                    }
                }
            } catch (e) {
                console.warn('[Terminal] Resize fit failed:', e);
            }
        };

        const resizeObserver = new ResizeObserver(() => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            rafRef.current = requestAnimationFrame(handleResize);
        });

        // 始终启动 ResizeObserver，确保容器从 display:none 变为可见时能触发 handleResize
        if (terminalRef.current) {
            resizeObserver.observe(terminalRef.current);
        }

        if (terminalRef.current) {
            // 对齐 43.1: 工业级延迟挂载 (延迟 50ms 确保容器在 DOM 中已稳定且非 display:none)
            initOpenTimeoutRef.current = setTimeout(() => {
                if (isDisposed || !terminalRef.current) return;

                // [Fix] ResizeObserver 的 handleResize 延迟挂载路径可能已抢先完成 open + connectTerminal
                // （observe() 后会立即触发一次回调）。若已连接则直接跳过，
                // 否则会用同一 sessionId 重复创建 PTY，导致主进程旧 PTY 泄漏并双写输出。
                if (hasConnectedRef.current || xtermRef.current) return;
                
                // 确保容器有物理尺寸，避免 xterm Agent助手计算抛错 (Section 4.5.11)
                if (terminalRef.current.clientWidth === 0) {
                    console.log('[Terminal] Container has no width, deferring open...');
                    // 如果还不可见，我们不 open，等 ResizeObserver 触发
                    return;
                }

                // 防止 handleResize 中重复连接
                hasConnectedRef.current = true;
                term.open(terminalRef.current);
                xtermRef.current = term;

                // 首次 fit
                try {
                    const core = (term as any)._core;
                    const renderService = core?._renderService;
                    if (renderService && typeof renderService.hasRenderer === 'function' && renderService.hasRenderer()) {
                        fitAddon.fit();
                        isReadyRef.current = true;
                        if (bufferedData.length > 0) {
                            bufferedData.forEach(d => { try { term.write(d); } catch (e) {} });
                            bufferedData.length = 0;
                        }

                        // [2026.03] 修复：首次元尺寸同步也进行幂等校验，防止与 throttleResize 冲突
                        const { cols, rows } = term;
                        if (lastDimsRef.current?.cols !== cols || lastDimsRef.current?.rows !== rows) {
                            lastDimsRef.current = { cols, rows };
                            if (electronBridge.isElectron) {
                                electronBridge.resizeTerminal(sessionId, cols, rows);
                            } else {
                                fetch(`${TERMINAL_HTTP_BASE}/terminal/resize`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ userId: USER_ID, sessionId, cols, rows, root: workspaceRoot })
                                }).catch(err => console.error('[Terminal] Initial resize failed', err));
                            }
                        }
                    }
                } catch (e) {}

                // 发起连接
                streamCleanup = connectTerminal();
            }, 50);
        }

        // 监听全局终端数据事件 (由 Agent 执行工具触发，对齐 Section 4.1.5)
        const handleGlobalTerminalData = (e: any) => {
            if (isDisposed) return;
            if (e.detail && typeof e.detail === 'string') {
                if (isReadyRef.current) {
                    try {
                        term.write(e.detail);
                    } catch (err) {
                        console.warn('[Terminal] Global data write failed:', err);
                    }
                } else {
                    bufferedData.push(e.detail);
                }
            }
        };
        window.addEventListener('ui:terminal:data', handleGlobalTerminalData);

        return () => {
            isDisposed = true;
            // [Fix] 显式关闭活跃的 SSE 连接
            if (activeESRef.current) {
                console.log(`[Terminal] Cleanup: Closing active EventSource`);
                activeESRef.current.close();
                activeESRef.current = null;
            }
            if (dataDisposer) dataDisposer.dispose();
            if (streamCleanup) streamCleanup();
            if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
            if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
            if (initOpenTimeoutRef.current) clearTimeout(initOpenTimeoutRef.current);
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            inputLineBufferRef.current = '';
            window.removeEventListener('ui:terminal:data', handleGlobalTerminalData);
            resizeObserver.disconnect();
            
            console.log(`[Terminal] [${new Date().toLocaleTimeString()}] Detaching Terminal UI`);
            
            term.dispose();
            xtermRef.current = null;
        };
    }, [workspaceRoot]);

    return (
        <div className="w-full h-full bg-black relative flex flex-col min-h-0" data-testid="terminal-container">
            {!workspaceRoot && (
                <div className="absolute inset-0 z-10 bg-black/80 backdrop-blur-[2px] flex flex-col items-center justify-center p-6 border-t border-white/5 shadow-2xl overflow-hidden">
                    <div className="w-12 h-12 border border-white/10 shadow-2xl flex items-center justify-center mb-6 relative group animate-pulse">
                        <Lock size={20} strokeWidth={0.5} className="text-white opacity-20" />
                    </div>
                    <div className="space-y-4 max-w-xs text-center relative z-20">
                        <h3 className="text-[10px] font-black uppercase tracking-[0.4em] text-white opacity-40">终端区域已锁定 (PTY_LOCKED)</h3>
                        <div className="h-[1px] w-8 bg-white/10 mx-auto" />
                        <p className="text-[7.5px] text-white/20 leading-relaxed uppercase tracking-[0.2em] font-medium max-w-[180px] mx-auto">
                            终端已受限：Agent 需要一个物理链路以执行命令。请在左侧侧边台初始化工作区。
                        </p>
                    </div>
                </div>
            )}
            <div 
                ref={terminalRef} 
                className="flex-1 w-full h-full p-2"
                style={{ overflow: 'hidden' }}
            />
        </div>
    );
};
