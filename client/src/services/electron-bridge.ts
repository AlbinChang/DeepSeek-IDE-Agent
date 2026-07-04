/**
 * Electron Bridge Service
 * 
 * 桌面应用专用桥接层 —— 通过 IPC 调用主进程能力。
 * 重构后已移除 Web HTTP/SSE/WS 回退路径，仅保留 IPC 直连。
 */

// ── 获取 preload 注入的 electronAPI ──
const api: any = (window as any).electronAPI || null;

console.log(`[ElectronBridge] IPC ready (api=${!!api})`);

/** 安全调用 IPC 方法 */
function getIpcApi(): any {
    const currentApi = api || (window as any).electronAPI;
    if (!currentApi) {
        throw new Error(
            '[ElectronBridge] window.electronAPI 未注入。' +
            '请确认 preload 脚本已正确加载（DevTools → Sources → preload.cjs）。'
        );
    }
    return currentApi;
}

async function callIpc(method: string, args: any[]): Promise<any> {
    const ipcApi = getIpcApi();
    const fn = ipcApi[method];
    if (typeof fn !== 'function') {
        throw new Error(
            `[ElectronBridge] electronAPI.${method} 不是函数。` +
            `可用方法: ${Object.keys(ipcApi).join(', ')}`
        );
    }
    return fn(...args);
}

// ── 事件类型 ──
export type AgentSSEEventType = 'init' | 'stage' | 'reasoning' | 'text' | 'annotation' | 'progress' | 'error' | 'done' | 'heartbeat';

export interface AgentSSEPayload {
    type: AgentSSEEventType;
    content?: string;
    traceId?: string;
    model?: string;
    method?: string;
    params?: any;
    channel?: 'content' | 'reasoning' | 'tool_arguments' | 'complete';
    receivedChars?: number;
    contentChars?: number;
    reasoningChars?: number;
    toolArgumentChars?: number;
    deltaChars?: number;
    toolName?: string;
    turn?: number;
    timestamp: number;
    isFinal?: boolean;
    streamId?: string;
}

// ── 统一接口（仅 IPC 路径） ──
export const electronBridge = {
    // 兼容旧代码的 isElectron 字段，始终为 true
    isElectron: true,

    // ═══ Agent Chat ═══
    async startAgentChat(
        params: {
            userId: string;
            userInstruct: string;
            traceId: string;
            locale?: string;
            root?: string;
            reasoningEffort?: 'high' | 'max';
            provider?: string;
            model?: string;
        },
        onEvent: (event: AgentSSEPayload) => void,
        abortSignal?: AbortSignal
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const ipcApi = getIpcApi();
            let streamId: string | null = null;

            const cleanup = ipcApi.onAgentEvent((event: any) => {
                // 首次事件中捕获 streamId（用于 abort 时发送取消信号）
                if (!streamId && event.streamId) {
                    streamId = event.streamId;
                }

                if (abortSignal?.aborted) {
                    if (streamId) ipcApi.cancelAgentChat(streamId);
                    cleanup();
                    resolve();
                    return;
                }

                onEvent({
                    type: event.type,
                    content: event.content,
                    traceId: event.traceId,
                    model: event.model,
                    method: event.method,
                    params: event.params,
                    channel: event.channel,
                    receivedChars: event.receivedChars,
                    contentChars: event.contentChars,
                    reasoningChars: event.reasoningChars,
                    toolArgumentChars: event.toolArgumentChars,
                    deltaChars: event.deltaChars,
                    toolName: event.toolName,
                    turn: event.turn,
                    timestamp: event.timestamp,
                    isFinal: event.isFinal,
                    streamId: event.streamId,
                });

                if (event.type === 'done' || event.type === 'error') {
                    cleanup();
                    if (event.type === 'error') {
                        console.error(`[ElectronBridge] Agent error: ${event.content || 'unknown'}`);
                        reject(new Error(event.content || 'Agent error'));
                    } else {
                        resolve();
                    }
                }
            });

            // 启动对话并捕获 streamId
            callIpc('startAgentChat', [params]).then((sid: string) => {
                if (sid && !streamId) streamId = sid;
            }).catch((err: any) => {
                cleanup();
                reject(err);
            });

            if (abortSignal) {
                abortSignal.addEventListener('abort', () => {
                    // 通知主进程取消会话
                    if (streamId) {
                        ipcApi.cancelAgentChat(streamId);
                    }
                    cleanup();
                    resolve();
                });
            }
        });
    },

    /** 清空会话（含 TODO 持久化清理） */
    async clearSession(params: { userId: string; workspaceRoot?: string }): Promise<{ success: boolean; error?: string }> {
        return callIpc('clearSession', [params]);
    },

    // ═══ File Operations ═══
    async readFile(params: { filePath: string; startLine?: number; endLine?: number; root?: string }) {
        return callIpc('readFile', [params]);
    },
    async readFileBinary(params: { filePath: string; root?: string }) {
        return callIpc('readFileBinary', [params]);
    },
    async writeFile(params: { filePath: string; content: string; encoding?: string; root?: string }) {
        return callIpc('writeFile', [params]);
    },
    async listFiles(params: { dirPath: string; depth?: number; root?: string }) {
        return callIpc('listFiles', [params]);
    },
    async searchFiles(params: { pattern: string; root?: string; maxResults?: number }) {
        return callIpc('searchFiles', [params]);
    },
    async deleteFile(params: { filePath: string; root?: string }) {
        return callIpc('deleteFile', [params]);
    },
    async renameFile(params: { oldPath: string; newPath: string; root?: string }) {
        return callIpc('renameFile', [params]);
    },

    // ═══ Terminal ═══
    async createTerminal(params: { userId: string; sessionId?: string; workDir?: string; cols?: number; rows?: number }) {
        return callIpc('createTerminal', [params]);
    },
    sendTerminalInput(sessionId: string, data: string) {
        callIpc('sendTerminalInput', [{ sessionId, data }]).catch(() => {});
    },
    resizeTerminal(sessionId: string, cols: number, rows: number) {
        callIpc('resizeTerminal', [{ sessionId, cols, rows }]).catch(() => {});
    },
    destroyTerminal(sessionId: string) {
        callIpc('destroyTerminal', [sessionId]).catch(() => {});
    },
    onTerminalOutput(callback: (data: { sessionId: string; data: string; type: string; exitCode?: number }) => void): () => void {
        if (api) return api.onTerminalOutput(callback);
        return () => {};
    },

    // ═══ Settings ═══
    async getSettings(userId: string) {
        return callIpc('getSettings', [userId]);
    },
    async saveSettings(params: { userId: string; settings: any; root?: string }) {
        return callIpc('saveSettings', [params]);
    },
    async syncSettings(params: { userId: string; settings: any; root?: string }) {
        return callIpc('syncSettings', [params]);
    },
    async testConnection(params: { userId: string; workspaceRoot?: string; provider: any }) {
        return callIpc('testConnection', [params]);
    },

    // ═══ Git Operations ═══
    async gitInit(params: { root?: string }) {
        return callIpc('gitInit', [params]);
    },
    async gitStatus(params: { root?: string }) {
        return callIpc('gitStatus', [params]);
    },
    async gitLog(params: { root?: string; maxCount?: number }) {
        return callIpc('gitLog', [params]);
    },
    async gitDiff(params: { root?: string; file?: string }) {
        return callIpc('gitDiff', [params]);
    },
    async gitFileHistory(params: { root?: string; filePath: string }) {
        return callIpc('gitFileHistory', [params]);
    },

    // ═══ Workspace ═══
    async selectWorkspace(): Promise<string | null> {
        return callIpc('selectWorkspace', []);
    },
    async initWorkspace(params: { userId: string; root: string }) {
        return callIpc('initWorkspace', [params]);
    },
    async getWorkspaceRoot(userId: string): Promise<string | null> {
        return callIpc('getWorkspaceRoot', [userId]);
    },
    async getWorkspaceStatus(params: { userId: string }) {
        return callIpc('getWorkspaceStatus', [params]);
    },
    async resetWorkspace(params: { userId: string }) {
        return callIpc('resetWorkspace', [params]);
    },

    // ═══ App Info ═══
    async getAppInfo() {
        return callIpc('getAppInfo', []);
    },
    async revealInExplorer(filePath: string): Promise<{ success: boolean; error?: string }> {
        return callIpc('revealInExplorer', [filePath]);
    },
    onSystemEvent(callback: (event: { type: string; payload?: any }) => void): () => void {
        if (api) return api.onSystemEvent(callback);
        return () => {};
    },

    // ═══ Utility ═══
    get isDesktop(): boolean {
        return true;
    },

    // ═══ Diagnostics ═══
    async getDiagnostics(params: { filePath: string }) {
        return callIpc('getDiagnostics', [params]);
    },
    async getDiagnosticsBatch(params: { filePaths: string[] }) {
        return callIpc('getDiagnosticsBatch', [params]);
    },
};
