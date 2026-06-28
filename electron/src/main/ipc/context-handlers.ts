/**
 * Context & Completion IPC Handlers
 * 
 * 替换 /ws/context 和 /ws/completion WebSocket 路由。
 * 编辑器上下文同步 + AI 代码补全。
 */
import { IpcMain, BrowserWindow } from 'electron';

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

// ── 代码补全（简化实现，完整版需对接 CompletionService） ──
export function registerCompletionIpc(ipcMain: IpcMain, mainWindow: BrowserWindow) {
    
    const activeCompletions = new Map<string, AbortController>();

    // ── 请求代码补全 ──
    ipcMain.handle('completion:request', async (event, params: {
        userId: string;
        filePath: string;
        position: { line: number; column: number };
        context?: string;
        root?: string;
    }) => {
        const completionId = `comp-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
        
        // TODO: 对接 CompletionService 进行实际 AI 补全
        // 目前返回占位实现
        console.log(`[CompletionIPC] Completion requested: ${completionId}, file=${params.filePath}`);
        
        try {
            // 延迟发送结果（模拟异步补全）
            setTimeout(() => {
                if (!mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('completion:result', {
                        completionId,
                        text: '', // 实际补全结果
                        isFinal: true,
                    });
                }
            }, 100);
        } catch (err) {
            console.error('[CompletionIPC] Error:', err);
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
