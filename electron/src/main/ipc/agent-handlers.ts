/**
 * Agent Chat IPC Handler
 * 
 * 替换 ChatSSERoute.ts，直接在 Main Process 中运行 AgentChatComponent，
 * 通过 IPC 事件流式推送结果到 Renderer。
 */
import { IpcMain, BrowserWindow } from 'electron';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'path';
import { PROJECT_ROOT, SERVER_SRC, CONFIG_ROOT } from '../index.js';
import type { LLMRequestJournal, LLMRequestRecord } from '@/services/LLMRequestJournal.js';

// 动态导入 server 模块（tsx 会自动处理 @/ 路径别名）
// 注意：运行时 tsx 会从 server/tsconfig.json 解析 @/ → ./src/

// 活跃的 Agent 流追踪（用于取消）
const activeAgentStreams = new Map<string, AbortController>();
// 缓存已初始化的服务实例
let agentServiceInstance: any = null;
let agentChatComponentInstance: any = null;

async function getAgentService(): Promise<any> {
    if (agentServiceInstance) return agentServiceInstance;
    
    // 双保险：入口模块（main/index.ts）顶层已注入这些环境变量；
    // 此处再次设置，防止未来重构改变入口初始化顺序（PathUtils 在首次 import 时冻结路径常量）
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
    
    // 先初始化 AgentService，确保路径环境变量已注入后再触发 server 模块链的初始化
    // （AgentChatComponent 静态导入 AgentService → PathUtils，若跳过此步会以错误路径冻结 CONFIG_ROOT）
    await getAgentService();
    
    const { AgentChatComponent } = await import('@/services/AgentChatComponent.js');
    agentChatComponentInstance = AgentChatComponent.getInstance();
    return agentChatComponentInstance;
}

async function getLLMRequestJournal(): Promise<LLMRequestJournal> {
    const { LLMRequestJournal } = await import('@/services/LLMRequestJournal.js');
    return LLMRequestJournal.getInstance();
}

/**
 * 从持久化存储读取用户设置，解析出实际使用的 provider 配置（含 apiKey）。
 *
 * 读取优先级（由高到低）：
 *   1. <workspaceRoot>/.llm/users/<userId>/settings.json  （工作区配置）
 *   2. <PROJECT_ROOT>/.llm/users/<userId>/settings.json    （Electron 全局配置）
 *   3. <PROJECT_ROOT>/.electron-store/settings.json        （settings:sync 总是写入这里）
 *   4. SettingsService.getDefaultSettings()                 （环境变量兜底）
 *
 * 所有路径均绕过 SettingsService 内存缓存，直接读盘，确保更新后的 key 立即生效。
 */
async function resolveProviderConfig(
    userId: string,
    root: string,
    requestedProvider?: string,
    requestedModel?: string,
) {
    const { AIProviderFactory } = await import('@/services/AIProviderFactory.js');
    const { SettingsService } = await import('@/services/SettingsService.js');

    let settings = SettingsService.getDefaultSettings();

    // 候选路径列表（按优先级排序）
    const candidatePaths: string[] = [];
    if (root) {
        candidatePaths.push(path.join(root, '.llm', 'users', userId, 'settings.json'));
    }
    candidatePaths.push(path.join(PROJECT_ROOT, '.llm', 'users', userId, 'settings.json'));
    candidatePaths.push(path.join(PROJECT_ROOT, '.electron-store', 'settings.json'));

    for (const candidatePath of candidatePaths) {
        try {
            if (!fs.existsSync(candidatePath)) continue;
            const raw = fs.readFileSync(candidatePath, 'utf-8');
            let parsed: any;
            try {
                parsed = JSON.parse(raw);
            } catch {
                continue;
            }

            // .electron-store 格式为 { "user:<userId>": { providers, ... } }
            const userData = parsed?.[`user:${userId}`] || parsed;
            if (userData && typeof userData === 'object' && userData.providers) {
                settings = { ...settings, ...userData };
                console.log(`[AgentIPC] Loaded settings from: ${candidatePath}`);
                break;
            }
        } catch {
            // 文件损坏或不可读，尝试下一个路径
        }
    }

    return AIProviderFactory.resolveSelection(
        settings.providers,
        settings.activeProvider,
        settings.activeModel,
        requestedProvider,
        requestedModel,
    );
}

export function registerAgentIpc(ipcMain: IpcMain, mainWindow: BrowserWindow) {

    ipcMain.handle('agent:recovery:get', async (_event, params: { userId: string; root: string }) => {
        try {
            const journal = await getLLMRequestJournal();
            const record = await journal.getPendingRecovery(params.root, params.userId);
            return {
                success: true,
                recovery: record
                    ? {
                        requestIndex: record.requestIndex,
                        userId: record.metadata.userId,
                        modelId: record.metadata.modelId,
                        providerId: record.metadata.providerId,
                        agentStage: record.metadata.agentStage,
                        timestamp: record.metadata.timestamp,
                        traceId: record.metadata.traceId,
                    }
                    : null,
            };
        } catch (error: any) {
            console.error('[AgentIPC] Failed to check agent recovery:', error);
            return { success: false, recovery: null, error: error?.message || String(error) };
        }
    });

    ipcMain.handle('agent:recovery:discard', async (_event, params: {
        userId: string;
        root: string;
        requestIndex: number;
    }) => {
        try {
            const journal = await getLLMRequestJournal();
            await journal.discardRecovery(params.root, params.userId, params.requestIndex);
            return { success: true };
        } catch (error: any) {
            console.error('[AgentIPC] Failed to discard agent recovery:', error);
            return { success: false, error: error?.message || String(error) };
        }
    });
    
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
            recoveryRequestIndex,
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

        // handleChat 在正常完成路径已自行发送 done 事件；此处兜底仅在
        // handleChat 未发送任何终态事件（中断/异常）时补发，避免重复 done。
        let terminalEmitted = false;

        void (async () => {
            try {
                const agentService = await getAgentService();
                const agentChatComponent = await getAgentChatComponent();

                let recoveryRequest: LLMRequestRecord | undefined;
                if (recoveryRequestIndex !== undefined) {
                    if (!root) {
                        throw new Error('Cannot resume an Agent request without its workspace root');
                    }
                    const journal = await getLLMRequestJournal();
                    recoveryRequest = await journal.readPendingRequest(root, userId, recoveryRequestIndex);
                }

                // 从持久化存储读取用户设置，解析实际 API key 与模型配置
                const resolved = await resolveProviderConfig(
                    userId,
                    root,
                    recoveryRequest?.metadata.providerId || provider,
                    recoveryRequest?.metadata.modelId || model,
                );
                if (recoveryRequest?.metadata.providerId && resolved.provider !== recoveryRequest.metadata.providerId) {
                    throw new Error(
                        `Cannot resume request: provider "${recoveryRequest.metadata.providerId}" is no longer configured`,
                    );
                }
                const activeTraceId = recoveryRequest?.metadata.traceId || traceId;
                const recoveredInstruction = recoveryRequest?.metadata.recoveryContext?.userInstruction;
                const activeUserInstruction = typeof recoveredInstruction === 'string'
                    ? recoveredInstruction
                    : userInstruct;

                // 发送初始化事件（使用解析后的 model，与 SSE 路径一致）
                sendEvent({
                    type: 'init',
                    traceId: activeTraceId,
                    model: recoveryRequest?.metadata.modelId || resolved.modelId,
                    timestamp: Date.now(),
                });

                // 调用 AgentChatComponent.handleChat
                await agentChatComponent.handleChat(
                    agentService,
                    userId,
                    resolved.provider,
                    resolved.modelId,
                    activeUserInstruction, // 保持原始类型（string），与 SSE 路径一致
                    activeTraceId,
                    locale,
                    abortController.signal,
                    (chunk: any) => {
                        if (chunk.type === 'done' || chunk.type === 'error') {
                            terminalEmitted = true;
                        }
                        // 将 SSE 事件格式映射为 IPC 事件
                        // 注意：此处为显式字段白名单，新增事件字段（如 usage）必须同步转发，
                        // 否则会被静默丢弃 —— 历史上 usage 字段曾在此丢失，导致状态栏 token 用量永不更新。
                        sendEvent({
                            type: chunk.type || 'text',
                            content: chunk.content ?? chunk.message,
                            // usage：每次模型调用结束的增量用量；done 事件上则为整轮汇总用量
                            usage: chunk.usage,
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
                    resolved.providerConfig,
                    root,
                    undefined,
                    recoveryRequest,
                );

                // 完成事件兜底（handleChat 在中断/异常路径可能未发送终态事件）
                if (!terminalEmitted) {
                    sendEvent({ type: 'done', timestamp: Date.now() });
                }
                
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
