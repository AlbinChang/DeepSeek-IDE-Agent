/**
 * Electron-Adapted Terminal Hook
 * 
 * 对 Terminal.tsx 的 Electron 适配包装。
 * Web 模式使用原有的 SSE EventSource 连接 terminal-server；
 * Electron 模式使用 IPC 直接操作 node-pty。
 * 
 * 使用方式：在 Terminal.tsx 中导入 useTerminalConnection 替换原有的连接逻辑。
 */
import { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from 'xterm';
import { electronBridge } from '@/services/electron-bridge';
import { USER_ID, TERMINAL_HTTP_BASE } from '@/config';

interface UseTerminalConnectionOptions {
    xterm: XTerm | null;
    workspaceRoot: string | null;
    sessionId?: string;
    enabled?: boolean;
}

interface UseTerminalConnectionResult {
    isConnected: boolean;
    sessionId: string;
    sendInput: (data: string) => void;
    resize: (cols: number, rows: number) => void;
    disconnect: () => void;
    clearBuffer: () => Promise<void>;
}

/**
 * 终端连接 Hook — 自动选择 Electron IPC 或 Web SSE
 */
export function useTerminalConnection(options: UseTerminalConnectionOptions): UseTerminalConnectionResult {
    const { xterm, workspaceRoot, sessionId: customSessionId, enabled = true } = options;
    
    const sessionIdRef = useRef(customSessionId || `term-${Date.now()}`);
    const isConnectedRef = useRef(false);
    const cleanupRef = useRef<(() => void) | null>(null);
    const eventSourceRef = useRef<EventSource | null>(null);

    const sessionId = sessionIdRef.current;

    // ── Clear buffer ──
    const clearBuffer = useCallback(async () => {
        if (electronBridge.isElectron) {
            // Electron: 前端清屏 + IPC 通知后端清理回放缓冲
            // (IPC 模式没有独立的 replay buffer，PTY 输出是实时的)
            return;
        }
        // Web: 调用后端清理
        try {
            await fetch(`${TERMINAL_HTTP_BASE}/terminal/clear-buffer`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: USER_ID, sessionId }),
            });
        } catch {
            // 忽略清理失败
        }
    }, [sessionId]);

    // ── Send input ──
    const sendInput = useCallback((data: string) => {
        electronBridge.sendTerminalInput(sessionId, data);
    }, [sessionId]);

    // ── Resize ──
    const resize = useCallback((cols: number, rows: number) => {
        electronBridge.resizeTerminal(sessionId, cols, rows);
    }, [sessionId]);

    // ── Disconnect ──
    const disconnect = useCallback(() => {
        electronBridge.destroyTerminal(sessionId);
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
        }
        if (cleanupRef.current) {
            cleanupRef.current();
            cleanupRef.current = null;
        }
        isConnectedRef.current = false;
    }, [sessionId]);

    // ── 主连接逻辑 ──
    useEffect(() => {
        if (!enabled || !workspaceRoot || !xterm) return;

        let disposed = false;

        const connect = async () => {
            if (disposed) return;

            if (electronBridge.isElectron) {
                // ═══════════════════════════════
                // Electron IPC 模式
                // ═══════════════════════════════
                console.log(`[TerminalHook] Electron mode: creating PTY session ${sessionId}`);
                
                try {
                    const result = await electronBridge.createTerminal({
                        userId: USER_ID,
                        sessionId,
                        workDir: workspaceRoot,
                        cols: xterm.cols,
                        rows: xterm.rows,
                    });

                    if (result.success && !disposed) {
                        isConnectedRef.current = true;
                        console.log(`[TerminalHook] PTY created: cwd=${result.cwd}`);
                    }
                } catch (err) {
                    console.error('[TerminalHook] Failed to create PTY:', err);
                    return;
                }

                // 监听终端输出
                const unsub = electronBridge.onTerminalOutput((data) => {
                    if (data.sessionId === sessionId && xterm) {
                        if (data.type === 'delta' || data.type === 'snapshot') {
                            xterm.write(data.data);
                        } else if (data.type === 'exit') {
                            xterm.write(`\r\n[进程已退出，退出码: ${data.exitCode ?? '?'}]\r\n`);
                        }
                    }
                });

                cleanupRef.current = () => {
                    unsub();
                };

            } else {
                // ═══════════════════════════════
                // Web SSE 模式（原有逻辑）
                // ═══════════════════════════════
                console.log(`[TerminalHook] Web mode: connecting to terminal-server via SSE`);
                
                const params = new URLSearchParams({
                    userId: USER_ID,
                    sessionId,
                    root: workspaceRoot,
                    cols: String(xterm.cols),
                    rows: String(xterm.rows),
                });

                const eventSource = new EventSource(
                    `${TERMINAL_HTTP_BASE}/terminal/stream?${params.toString()}`
                );
                eventSourceRef.current = eventSource;

                eventSource.addEventListener('delta', (e: MessageEvent) => {
                    if (!disposed && xterm) {
                        xterm.write(e.data);
                    }
                });

                eventSource.addEventListener('snapshot', (e: MessageEvent) => {
                    if (!disposed && xterm) {
                        xterm.write(e.data);
                        isConnectedRef.current = true;
                    }
                });

                eventSource.addEventListener('exit', (e: MessageEvent) => {
                    if (!disposed && xterm) {
                        try {
                            const payload = JSON.parse(e.data);
                            xterm.write(`\r\n[进程已退出，退出码: ${payload.exitCode ?? '?'}]\r\n`);
                        } catch {
                            xterm.write(`\r\n${e.data}\r\n`);
                        }
                    }
                });

                eventSource.onerror = () => {
                    if (!disposed) {
                        console.warn('[TerminalHook] SSE connection error');
                    }
                };

                eventSource.onopen = () => {
                    if (!disposed) {
                        console.log('[TerminalHook] SSE connected');
                    }
                };

                cleanupRef.current = () => {
                    eventSource.close();
                    eventSourceRef.current = null;
                };
            }
        };

        connect();

        return () => {
            disposed = true;
            disconnect();
        };
    }, [enabled, workspaceRoot, xterm, sessionId, disconnect]);

    return {
        isConnected: isConnectedRef.current,
        sessionId,
        sendInput,
        resize,
        disconnect,
        clearBuffer,
    };
}
