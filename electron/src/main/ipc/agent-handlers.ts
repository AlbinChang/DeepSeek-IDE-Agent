/**
 * Agent Chat IPC Handler
 * 
 * 替换 ChatSSERoute.ts，直接在 Main Process 中运行 AgentChatComponent，
 * 通过 IPC 事件流式推送结果到 Renderer。
 */
import { IpcMain, BrowserWindow } from 'electron';
import * as crypto from 'node:crypto';
import * as path from 'path';
import { PROJECT_ROOT, SERVER_SRC, CONFIG_ROOT } from '../index.js';

// 动态导入 server 模块（tsx 会自动处理 @/ 路径别名）
// 注意：运行时 tsx 会从 server/tsconfig.json 解析 @/ → ./src/

// 活跃的 Agent 流追踪（用于取消）
const activeAgentStreams = new Map<string, AbortController>();
// 缓存已初始化的服务实例
let agentServiceInstance: any = null;
let agentChatComponentInstance: any = null;

async function getAgentService(): Promise<any> {
    if (agentServiceInstance) return agentServiceInstance;
    
    // 设置环境变量让 PathUtils 正确解析路径（必须在 import 之前设置）
    process.env.SERVER_ROOT = SERVER_SRC;
    process.env.PROJECT_ROOT = PROJECT_ROOT;
    process.env.CONFIG_ROOT = CONFIG_ROOT;
    
    // 动态导入 server 模块（esbuild --alias:@=../server/src 解析 @/ 路径别名）
    const { AgentService } = await import('@/services/AgentService.js');
    agentServiceInstance = AgentService.getInstance();
    return agentServiceInstance;
}

async function getAgentChatComponent(): Promise<any> {
    if (agentChatComponentInstance) return agentChatComponentInstance;
    
    const { AgentChatComponent } = await import('@/services/AgentChatComponent.js');
    agentChatComponentInstance = AgentChatComponent.getInstance();
    return agentChatComponentInstance;
}

export function registerAgentIpc(ipcMain: IpcMain, mainWindow: BrowserWindow) {
    
    // ── 启动 Agent 对话 ──
    ipcMain.handle('agent:chat', async (_event, params) => {
        const {
            streamId = crypto.randomUUID(),
            userId,
            userInstruct,
            traceId,
            locale,
            root,
            reasoningEffort,
            provider,
            model,
        } = params;

        console.log(`[AgentIPC] Starting chat: streamId=${streamId}, userId=${userId}, traceId=${traceId}`);

        // 创建 AbortController 用于取消
        const abortController = new AbortController();
        activeAgentStreams.set(streamId, abortController);

        const sendEvent = (data: any) => {
            if (!mainWindow.isDestroyed()) {
                mainWindow.webContents.send('agent:event', { streamId, ...data });
            }
        };

        void (async () => {
            try {
                const agentService = await getAgentService();
                const agentChatComponent = await getAgentChatComponent();

                // 发送初始化事件
                sendEvent({
                    type: 'init',
                    traceId,
                    model: model || 'deepseek-chat',
                    timestamp: Date.now(),
                });

                // 调用 AgentChatComponent.handleChat
                await agentChatComponent.handleChat(
                    agentService,
                    userId,
                    provider || 'deepseek',
                    model || 'deepseek-chat',
                    userInstruct, // 保持原始类型（string），与 SSE 路径一致
                    traceId,
                    locale,
                    abortController.signal,
                    (chunk: any) => {
                        // 将 SSE 事件格式映射为 IPC 事件
                        sendEvent({
                            type: chunk.type || 'text',
                            content: chunk.content ?? chunk.message,
                            method: chunk.method,
                            params: chunk.params,
                            channel: chunk.channel,
                            receivedChars: chunk.receivedChars,
                            contentChars: chunk.contentChars,
                            reasoningChars: chunk.reasoningChars,
                            toolArgumentChars: chunk.toolArgumentChars,
                            deltaChars: chunk.deltaChars,
                            toolName: chunk.toolName,
                            turn: chunk.turn,
                            timestamp: chunk.timestamp || Date.now(),
                            isFinal: chunk.isFinal,
                        });
                    },
                    reasoningEffort,
                    undefined, // providerConfig - will be resolved from settings
                    root,
                );

                // 完成事件
                sendEvent({ type: 'done', timestamp: Date.now() });
                
            } catch (err: any) {
                if (err?.name === 'AbortError') {
                    sendEvent({ type: 'done', content: 'cancelled', timestamp: Date.now() });
                } else {
                    const errorMsg = err?.message || String(err);
                    const errorStack = err?.stack || '';
                    console.error(`[AgentIPC] Error: ${errorMsg}`);
                    if (errorStack) console.error(`[AgentIPC] Stack: ${errorStack}`);
                    sendEvent({
                        type: 'error',
                        content: `[Main Process] ${errorMsg}`,
                        timestamp: Date.now(),
                    });
                    sendEvent({ type: 'done', timestamp: Date.now() });
                }
            } finally {
                activeAgentStreams.delete(streamId);
            }
        })();

        return streamId;
    });

    // ── 取消 Agent 对话 ──
    ipcMain.on('agent:cancel', (_event, streamId: string) => {
        console.log(`[AgentIPC] Cancelling stream: ${streamId}`);
        const controller = activeAgentStreams.get(streamId);
        if (controller) {
            controller.abort();
            activeAgentStreams.delete(streamId);
        }
    });

    // ── 清空会话 ──
    ipcMain.handle('agent:clear', async (_event, params: { userId: string; workspaceRoot?: string }) => {
        try {
            const agentChatComponent = await getAgentChatComponent();
            agentChatComponent.clearSession(params.userId, params.workspaceRoot);
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err?.message };
        }
    });

    console.log('[AgentIPC] Agent IPC handlers registered');
}
