/**
 * Context & Completion IPC Handlers
 *
 * 编辑器上下文同步 + AI 代码补全。
 * 编辑器上下文统一写入 AgentService.contextStore（LiveContextStore），
 * 主进程内不再维护第二份 userContexts 镜像，避免状态分叉。
 */
import { IpcMain, BrowserWindow } from 'electron';
import { CompletionService } from '@/services/CompletionService.js';

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

let agentServiceInstance: any = null;

async function getAgentService(): Promise<any> {
    if (agentServiceInstance) return agentServiceInstance;
    const { AgentService } = await import('@/services/AgentService.js');
    agentServiceInstance = AgentService.getInstance();
    return agentServiceInstance;
}

export function registerContextIpc(ipcMain: IpcMain, mainWindow: BrowserWindow) {

    // ── 更新编辑器上下文 ──
    ipcMain.on('context:update', (_event, context: EditorContext) => {
        void (async () => {
            const agentService = await getAgentService();
            const workspaceRoot = context.workspaceRoot || null;
            agentService.contextStore.updateContext(
                context.userId,
                { currentFile: context.currentFile ?? null },
                workspaceRoot,
            );
            if (context.selection) {
                agentService.updateContextSelection(context.userId, {
                    path: context.currentFile,
                    workspaceRoot,
                    startLine: context.selection.startLine,
                    startChar: context.selection.startColumn,
                    endLine: context.selection.endLine,
                    endChar: context.selection.endColumn,
                    text: '',
                });
            }
        })().catch((error: unknown) => {
            console.warn('[ContextIPC] Failed to update editor context:', error);
        });

        // 广播给其他窗口（如果有）
        if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send('context:broadcast', context);
        }
    });

    // ── 获取当前上下文 ──
    ipcMain.handle('context:get', async (_event, params: { userId: string; workspaceRoot?: string }) => {
        try {
            const agentService = await getAgentService();
            const ctx = agentService.contextStore.getContext(params.userId, params.workspaceRoot);
            if (!ctx) return { success: true, context: null };
            return {
                success: true,
                context: {
                    userId: params.userId,
                    workspaceRoot: params.workspaceRoot,
                    currentFile: ctx.currentFile,
                    selection: ctx.selection
                        ? {
                            startLine: ctx.selection.startLine,
                            startColumn: ctx.selection.startColumn,
                            endLine: ctx.selection.endLine,
                            endColumn: ctx.selection.endColumn,
                        }
                        : null,
                    timestamp: Date.now(),
                },
            };
        } catch (error: any) {
            return { success: false, context: null, error: error?.message || String(error) };
        }
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
