/**
 * Context & Completion IPC Handlers
 * 
 * 替换 /ws/context 和 /ws/completion WebSocket 路由。
 * 编辑器上下文同步 + AI 代码补全。
 */
import { IpcMain, BrowserWindow } from 'electron';
import { CompletionService } from '@/services/CompletionService.js';

// 上下文存储（内存中）
interface EditorContext {
    userId: string;
    currentFile?: string | null;
    selection?: {
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
    } | null;
    workspaceRoot?: string;
    timestamp: number;
}

const userContexts = new Map<string, EditorContext>();

export function registerContextIpc(ipcMain: IpcMain, mainWindow: BrowserWindow) {
    
    // ── 更新编辑器上下文 ──
    ipcMain.on('context:update', (_event, context: EditorContext) => {
        const key = `${context.userId}:${context.workspaceRoot || 'default'}`;
        userContexts.set(key, {
            ...context,
            timestamp: Date.now(),
        });
        
        // 广播给其他窗口（如果有）
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('context:broadcast', context);
        }
    });

    // ── 获取当前上下文 ──
    ipcMain.handle('context:get', async (_event, params: { userId: string; workspaceRoot?: string }) => {
        const key = `${params.userId}:${params.workspaceRoot || 'default'}`;
        const ctx = userContexts.get(key);
        return {
            success: true,
            context: ctx || null,
        };
    });

    console.log('[ContextIPC] Context IPC handlers registered');
}

// ── 代码补全（对接 CompletionService） ──
export function registerCompletionIpc(ipcMain: IpcMain, mainWindow: BrowserWindow) {
    
    const activeCompletions = new Map<string, AbortController>();

    // ── 请求代码补全 ──
    ipcMain.handle('completion:request', async (_event, params: {
        userId: string;
        filePath: string;
        position: { line: number; column: number };
        context?: string;
        root?: string;
    }) => {
        const completionId = `comp-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
        
        console.log(`[CompletionIPC] Completion requested: ${completionId}, file=${params.filePath}`);
        
        if (params.root) {
            const controller = new AbortController();
            activeCompletions.set(completionId, controller);
            (async () => {
                try {
                    const text = await CompletionService.getCompletion({
                        workspaceRoot: params.root,
                        userId: params.userId,
                        prefix: params.context || '',
                        suffix: '',
                        filePath: params.filePath,
                    });
                    if (!mainWindow.isDestroyed() && !controller.signal.aborted) {
                        mainWindow.webContents.send('completion:result', {
                            completionId,
                            text: text || '',
                            isFinal: true,
                        });
                    }
                } catch (err: any) {
                    console.error('[CompletionIPC] Completion error:', err);
                    if (!mainWindow.isDestroyed() && !controller.signal.aborted) {
                        mainWindow.webContents.send('completion:result', {
                            completionId,
                            text: '',
                            error: err?.message || 'Completion failed',
                            isFinal: true,
                        });
                    }
                } finally {
                    activeCompletions.delete(completionId);
                }
            })();
        } else {
            setTimeout(() => {
                if (!mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('completion:result', {
                        completionId,
                        text: '',
                        isFinal: true,
                    });
                }
            }, 50);
        }

        return completionId;
    });

    // ── 取消补全 ──
    ipcMain.on('completion:cancel', (_event, completionId: string) => {
        const controller = activeCompletions.get(completionId);
        if (controller) {
            controller.abort();
            activeCompletions.delete(completionId);
        }
    });

    console.log('[CompletionIPC] Completion IPC handlers registered');
}
