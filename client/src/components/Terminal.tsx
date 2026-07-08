/**
 * Terminal — xterm.js + node-pty 透明管道
 *
 * 架构原则：Terminal 组件只做三件事：
 *   1. 用户按键 → 原样转发 PTY（不分析、不缓冲、不拦截）
 *   2. PTY 输出 → 原样写入 xterm（不缓冲、不回放、不重排）
 *   3. 容器 resize → 同步 cols/rows 到 PTY
 *
 * Agent 的输出（ui:terminal:data）直接写入 xterm，不做任何延迟/暂存。
 * 这才是真实终端的行为——不同来源的输出天然可能交叠，xterm 和 PTY 自己会处理。
 */

import React, { useEffect, useRef } from 'react';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { useAgentContext } from '@/providers/AgentContext';
import { USER_ID } from '@/config';
import { Lock } from 'lucide-react';
import { electronBridge } from '@/services/electron-bridge';

const XTERM_THEME = {
    background: '#000000',
    foreground: '#ffffff',
    cursor: '#10B981',
    selectionBackground: 'rgba(255,255,255,0.2)',
    black: '#000000', red: '#EF4444', green: '#10B981',
    yellow: '#F59E0B', blue: '#3B82F6', magenta: '#8B5CF6',
    cyan: '#06B6D4', white: '#FFFFFF',
} as const;

export const Terminal: React.FC = () => {
    const { workspaceRoot } = useAgentContext();
    const containerRef = useRef<HTMLDivElement>(null);
    const xtermRef = useRef<XTerm | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const sessionIdRef = useRef<string>('');
    const lastDimsRef = useRef<{ cols: number; rows: number } | null>(null);
    const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // 同步判断视口是否在底部（写入前调用，免疫异步 scroll 事件污染）
    const isAtBottom = (): boolean => {
        const t = xtermRef.current;
        if (!t) return true;
        const b = t.buffer.active;
        return b.viewportY >= b.baseY - 1;
    };

    useEffect(() => {
        const container = containerRef.current;
        if (!container || !workspaceRoot) return;

        // ── 1. 初始化 xterm ──
        const isWindows = /windows/i.test(navigator.userAgent);
        const term = new XTerm({
            theme: XTERM_THEME,
            cursorBlink: true,
            fontFamily: 'JetBrains Mono, Menlo, Monaco, "Courier New", monospace',
            fontSize: 12,
            lineHeight: 1.3,
            scrollback: 5000,
            windowsMode: isWindows, // ConPTY 折行模型对齐
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(container);
        fitAddon.fit();

        xtermRef.current = term;
        fitAddonRef.current = fitAddon;

        const sessionId = `term-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
        sessionIdRef.current = sessionId;

        let disposed = false;

        // ── 2. 创建 PTY ──
        const createPty = () => {
            if (disposed) return;
            electronBridge.createTerminal({
                userId: USER_ID,
                sessionId,
                workDir: workspaceRoot,
                cols: term.cols,
                rows: term.rows,
            }).then((result: any) => {
                if (!disposed && result?.success) {
                    console.log('[Terminal] PTY ready:', result.sessionId);
                    // 尺寸幂等同步
                    const { cols, rows } = term;
                    if (cols >= 10 && rows >= 2 &&
                        (lastDimsRef.current?.cols !== cols || lastDimsRef.current?.rows !== rows)) {
                        lastDimsRef.current = { cols, rows };
                        electronBridge.resizeTerminal(sessionId, cols, rows);
                    }
                    term.focus();
                }
            }).catch((err: any) => {
                console.error('[Terminal] PTY create failed:', err);
            });
        };

        createPty();

        // ── 3. PTY 输出 → xterm ──
        const outputUnsub = electronBridge.onTerminalOutput((output: any) => {
            if (disposed || output.sessionId !== sessionId) return;

            if (output.type === 'exit') {
                term.write(`\r\n\x1b[33m[进程已退出，退出码: ${output.exitCode ?? '?'}]\x1b[0m\r\n`);
                // 自动重连
                setTimeout(() => { if (!disposed) createPty(); }, 500);
                return;
            }

            const wasAtBottom = isAtBottom();
            term.write(output.data, () => {
                if (wasAtBottom) term.scrollToBottom();
            });
        });

        // ── 4. 用户按键 → PTY（直接转发，零处理） ──
        const dataDisposer = term.onData((data: string) => {
            electronBridge.sendTerminalInput(sessionId, data);
        });

        // ── 5. Agent 输出 → xterm（直接写入，无延迟） ──
        const onAgentEcho = (e: Event) => {
            if (disposed) return;
            const detail = (e as CustomEvent).detail;
            if (typeof detail === 'string' && detail.length > 0) {
                try { term.write(detail); } catch { /* ignore */ }
            }
        };
        window.addEventListener('ui:terminal:data', onAgentEcho);

        // ── 6. Resize 处理 ──
        const syncResize = () => {
            if (disposed) return;
            try {
                fitAddon.fit();
                const { cols, rows } = term;
                if (cols < 10 || rows < 2) return; // 尺寸安全阀
                if (lastDimsRef.current?.cols === cols && lastDimsRef.current?.rows === rows) return;

                lastDimsRef.current = { cols, rows };
                electronBridge.resizeTerminal(sessionId, cols, rows);

                // fit 后同步滚动位置
                if (isAtBottom()) term.scrollToBottom();
            } catch { /* ignore */ }
        };

        const onResize = () => {
            if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
            resizeTimerRef.current = setTimeout(syncResize, 150);
        };

        const resizeObserver = new ResizeObserver(onResize);
        resizeObserver.observe(container);

        // ── 7. 清理 ──
        return () => {
            disposed = true;
            outputUnsub();
            dataDisposer.dispose();
            resizeObserver.disconnect();
            if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
            window.removeEventListener('ui:terminal:data', onAgentEcho);
            electronBridge.destroyTerminal(sessionId);
            term.dispose();
            xtermRef.current = null;
            fitAddonRef.current = null;
        };
    }, [workspaceRoot]);

    // ── 渲染 ──
    return (
        <div className="w-full h-full bg-black relative flex flex-col min-h-0" data-testid="terminal-container">
            {!workspaceRoot && (
                <div className="absolute inset-0 z-10 bg-black/80 flex flex-col items-center justify-center p-6">
                    <div className="w-12 h-12 border border-white/10 flex items-center justify-center mb-6 animate-pulse">
                        <Lock size={20} className="text-white/20" />
                    </div>
                    <h3 className="text-[10px] font-semibold uppercase tracking-[0.3em] text-white/30">
                        终端已锁定
                    </h3>
                    <p className="text-[8px] text-white/15 mt-3 tracking-wide">
                        请先初始化工作区
                    </p>
                </div>
            )}
            <div className="flex-1 w-full relative min-h-0">
                <div ref={containerRef} className="absolute inset-0" />
            </div>
        </div>
    );
};
