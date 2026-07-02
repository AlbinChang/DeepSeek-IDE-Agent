/**
 * Terminal IPC Handler
 * 
 * 吸收 terminal-server，直接使用 node-pty 管理伪终端。
 * 通过 IPC 事件将终端输出流式推送到 Renderer 的 xterm.js。
 */
import { IpcMain, BrowserWindow } from 'electron';
import * as os from 'os';
import * as path from 'path';
import { PROJECT_ROOT } from '../index.js';

// node-pty 动态导入（原生模块）
let pty: any = null;
async function getPty() {
    if (pty) return pty;
    pty = await import('node-pty');
    return pty;
}

// 终端会话管理
interface TerminalSession {
    sessionId: string;
    ptyProcess: any;
    userId: string;
    workDir: string;
    createdAt: number;
    lastActivity: number;
    outputBuffer: Array<{ data: string; timestamp: number }>;
    /** 标记是否已被显式销毁，防止 onExit 异步事件污染新 session 的 renderer listener */
    explicitlyDestroyed?: boolean;
}

const terminalSessions = new Map<string, TerminalSession>();
const MAX_OUTPUT_BUFFER = 500; // 最多保留 500 条输出
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 分钟超时

// 定时清理过期会话
setInterval(() => {
    const now = Date.now();
    for (const [id, session] of terminalSessions) {
        if (now - session.lastActivity > SESSION_TIMEOUT) {
            try { session.ptyProcess.kill(); } catch {}
            terminalSessions.delete(id);
            console.log(`[TerminalIPC] Cleaned up session: ${id}`);
        }
    }
}, 60_000);

function getShell(): string {
    if (os.platform() === 'win32') {
        return 'powershell.exe';
    }
    return process.env.SHELL || '/bin/bash';
}

export function registerTerminalIpc(ipcMain: IpcMain, mainWindow: BrowserWindow) {
    
    // ── 创建终端会话 ──
    ipcMain.handle('terminal:create', async (_event, params: {
        userId: string;
        sessionId?: string;
        workDir?: string;
        cols?: number;
        rows?: number;
    }) => {
        try {
            const ptyModule = await getPty();
            
            const sessionId = params.sessionId || `term-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
            const workDir = params.workDir || PROJECT_ROOT || os.homedir();
            const cols = params.cols || 80;
            const rows = params.rows || 24;

            // 如果该用户已有会话，先销毁
            for (const [id, session] of terminalSessions) {
                if (session.userId === params.userId && session.workDir !== workDir) {
                    try { session.ptyProcess.kill(); } catch {}
                    terminalSessions.delete(id);
                }
            }

            // 确保工作目录存在
            const fs = await import('fs');
            if (!fs.existsSync(workDir)) {
                fs.mkdirSync(workDir, { recursive: true });
            }

            const shell = getShell();
            const shellArgs: string[] = [];
            
            // Windows PowerShell 特殊处理
            if (os.platform() === 'win32' && shell === 'powershell.exe') {
                // 不再追加 -NoExit，避免双提示符问题
            }

            console.log(`[TerminalIPC] Creating PTY: sessionId=${sessionId}, cwd=${workDir}, shell=${shell}, cols=${cols}, rows=${rows}`);

            const ptyProcess = ptyModule.spawn(shell, shellArgs, {
                name: 'xterm-256color',
                cols,
                rows,
                cwd: workDir,
                env: { ...process.env, TERM: 'xterm-256color' },
            });

            const session: TerminalSession = {
                sessionId,
                ptyProcess,
                userId: params.userId,
                workDir,
                createdAt: Date.now(),
                lastActivity: Date.now(),
                outputBuffer: [],
            };

            // 监听 PTY 输出，流式推送到 Renderer
            ptyProcess.onData((data: string) => {
                session.lastActivity = Date.now();
                
                // 追加到回放缓冲区
                session.outputBuffer.push({ data, timestamp: Date.now() });
                if (session.outputBuffer.length > MAX_OUTPUT_BUFFER) {
                    session.outputBuffer.shift();
                }

                // 推送到 Renderer
                if (!mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('terminal:output', {
                        sessionId,
                        data,
                        type: 'delta',
                    });
                }
            });

            // PTY 退出处理
            ptyProcess.onExit(({ exitCode, signal }: any) => {
                console.log(`[TerminalIPC] PTY exited: sessionId=${sessionId}, code=${exitCode}, signal=${signal}, explicit=${session.explicitlyDestroyed}`);
                // 如果已被显式销毁，跳过向 renderer 发送退出事件，避免触发前端误重连
                if (!session.explicitlyDestroyed && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('terminal:output', {
                        sessionId,
                        data: `\r\n[进程已退出，退出码: ${exitCode}]\r\n`,
                        type: 'exit',
                        exitCode,
                    });
                }
                terminalSessions.delete(sessionId);
            });

            terminalSessions.set(sessionId, session);

            // Windows: 3 秒后自动发送回车初始化
            if (os.platform() === 'win32') {
                setTimeout(() => {
                    if (terminalSessions.has(sessionId)) {
                        try {
                            ptyProcess.write('\r');
                        } catch {}
                    }
                }, 500);
            }

            return {
                success: true,
                sessionId,
                cwd: workDir,
            };
        } catch (err: any) {
            console.error('[TerminalIPC] Error creating terminal:', err);
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── 发送终端输入 ──
    ipcMain.on('terminal:input', (_event, params: { sessionId: string; data: string }) => {
        const session = terminalSessions.get(params.sessionId);
        if (session) {
            session.lastActivity = Date.now();
            try {
                session.ptyProcess.write(params.data);
            } catch (err) {
                console.error(`[TerminalIPC] Error writing to PTY:`, err);
            }
        }
    });

    // ── 调整终端大小 ──
    ipcMain.on('terminal:resize', (_event, params: { sessionId: string; cols: number; rows: number }) => {
        const session = terminalSessions.get(params.sessionId);
        if (session) {
            session.lastActivity = Date.now();
            try {
                session.ptyProcess.resize(params.cols, params.rows);
            } catch (err) {
                console.error(`[TerminalIPC] Error resizing PTY:`, err);
            }
        }
    });

    // ── 销毁终端 ──
    ipcMain.on('terminal:destroy', (_event, sessionId: string) => {
        const session = terminalSessions.get(sessionId);
        if (session) {
            session.explicitlyDestroyed = true;  // 先标记，抑制 onExit 向 renderer 发送退出事件
            try { session.ptyProcess.kill(); } catch {}
            terminalSessions.delete(sessionId);
            console.log(`[TerminalIPC] Destroyed session: ${sessionId}`);
        }
    });

    // ── 获取终端快照（重连时使用） ──
    ipcMain.handle('terminal:snapshot', async (_event, sessionId: string) => {
        const session = terminalSessions.get(sessionId);
        if (!session) return { success: false, error: 'Session not found' };
        
        return {
            success: true,
            sessionId,
            cwd: session.workDir,
            outputBuffer: session.outputBuffer.map(b => ({ data: b.data, timestamp: b.timestamp })),
        };
    });

    console.log('[TerminalIPC] Terminal IPC handlers registered');
}
