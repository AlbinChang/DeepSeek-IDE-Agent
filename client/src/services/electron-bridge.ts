/**
 * Electron Bridge Service
 * 
 * 在 Electron 和 Web 两种运行模式之间提供统一的 API 接口。
 * - Electron 模式：通过 window.electronAPI 使用 IPC 通信
 * - Web 模式：使用原有的 HTTP/SSE/WebSocket 通信
 * 
 * 使用方式：其他模块 import { electronBridge } from '@/services/electron-bridge'
 * 然后调用 electronBridge.startAgentChat() 等方法。
 */

import { API_BASE, TERMINAL_HTTP_BASE } from '@/config';

// ── 运行环境检测（多重保障） ──
// 1. preload 注入的 API 对象（主要检测手段）
// 2. 全局 Electron 标记（后备）
// 3. userAgent 中的 Electron 标识（兜底）
const hasElectronAPI = typeof window !== 'undefined' && !!(window as any).electronAPI;
const hasElectronFlag = typeof window !== 'undefined' && !!(window as any).__IS_ELECTRON__;
const hasElectronUA = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent);
const isElectron = hasElectronAPI || hasElectronFlag || hasElectronUA;

// contextBridge 暴露的 API 使用 getter 实现，`in` 运算符对其无效。
// 因此不用 Proxy 检查方法存在性，直接包装每次调用：成功则返回，失败则抛明确错误。
const api: any = (window as any).electronAPI || null;

console.log(
    `[ElectronBridge] isElectron=${isElectron} ` +
    `(api=${!!api}, flag=${hasElectronFlag}, ua=${hasElectronUA})`
);

/** 安全调用 IPC 方法，失败时抛诊断错误（永不回退 HTTP） */
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

// ── SSE 事件类型（与后端 ChatSSERoute 保持一致） ──
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

// ── 统一接口 ──
export const electronBridge = {
    isElectron,

    // ═══════════════════════════════════════
    // Agent Chat（替换 SSE）
    // ═══════════════════════════════════════

    /**
     * 启动 Agent 对话，返回流式事件流。
     * Electron: 通过 IPC 事件推送
     * Web: 通过 fetch SSE 流式读取
     */
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
        if (isElectron) {
            // ── Electron IPC 模式 ──
            return new Promise((resolve, reject) => {
                const ipcApi = getIpcApi();
                const cleanup = ipcApi.onAgentEvent((event: any) => {
                    // 检查中止信号
                    if (abortSignal?.aborted) {
                        ipcApi.cancelAgentChat(event.streamId);
                        cleanup();
                        resolve();
                        return;
                    }

                    // 映射 IPC 事件到 SSE 兼容格式
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

                    // 流结束
                    if (event.type === 'done' || event.type === 'error') {
                        cleanup();
                        if (event.type === 'error') {
                            const errContent = event.content || 'Agent error';
                            console.error(`[ElectronBridge] Agent error event: ${errContent}`);
                            reject(new Error(errContent));
                        } else {
                            resolve();
                        }
                    }
                });

                // 启动对话
                callIpc('startAgentChat', [params]).catch((err: any) => {
                    cleanup();
                    reject(err);
                });

                // 监听中止信号
                if (abortSignal) {
                    abortSignal.addEventListener('abort', () => {
                        // streamId 在第一个事件中返回，这里无法提前获取
                        // 通过 cleanup 移除监听器
                        cleanup();
                        resolve();
                    });
                }
            });
        } else {
            // ── Web SSE 模式 ──
            const url = `${API_BASE}/api/chat/sse`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params),
                signal: abortSignal,
            });

            if (!response.ok) {
                const errBody = await response.text().catch(() => '');
                throw new Error(`Agent chat failed: ${response.status} ${errBody}`);
            }

            const reader = response.body?.getReader();
            if (!reader) throw new Error('No response body');

            const decoder = new TextDecoder();
            let buffer = '';

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(line.slice(6));
                                onEvent(data);
                                if (data.type === 'done' || data.type === 'error') {
                                    return;
                                }
                            } catch {
                                // 跳过非 JSON 行
                            }
                        }
                    }
                }
            } finally {
                reader.releaseLock();
            }
        }
    },

    // ═══════════════════════════════════════
    // File Operations（替换 REST）
    // ═══════════════════════════════════════

    async readFile(params: { filePath: string; startLine?: number; endLine?: number; root?: string }) {
        if (isElectron) return callIpc('readFile', [params]);
        const res = await fetch(`${API_BASE}/api/files/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
        return res.json();
    },
    async writeFile(params: { filePath: string; content: string; encoding?: string; root?: string }) {
        if (isElectron) return callIpc('writeFile', [params]);
        const res = await fetch(`${API_BASE}/api/files/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
        return res.json();
    },
    async listFiles(params: { dirPath: string; depth?: number; root?: string }) {
        if (isElectron) return callIpc('listFiles', [params]);
        const res = await fetch(`${API_BASE}/api/files/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
        return res.json();
    },
    async searchFiles(params: { pattern: string; root?: string; maxResults?: number }) {
        if (isElectron) return callIpc('searchFiles', [params]);
        const res = await fetch(`${API_BASE}/api/files/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
        return res.json();
    },
    async deleteFile(params: { filePath: string; root?: string }) {
        if (isElectron) return callIpc('deleteFile', [params]);
        const res = await fetch(`${API_BASE}/api/files/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
        return res.json();
    },
    async renameFile(params: { oldPath: string; newPath: string; root?: string }) {
        if (isElectron) return callIpc('renameFile', [params]);
        const res = await fetch(`${API_BASE}/api/files/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
        return res.json();
    },

    // ═══════════════════════════════════════
    // Terminal（替换 terminal-server）
    // ═══════════════════════════════════════

    async createTerminal(params: { userId: string; sessionId?: string; workDir?: string; cols?: number; rows?: number }) {
        if (isElectron) return callIpc('createTerminal', [params]);
        const res = await fetch(`${TERMINAL_HTTP_BASE}/terminal/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
        return res.json();
    },
    sendTerminalInput(sessionId: string, data: string) {
        if (isElectron) { callIpc('sendTerminalInput', [{ sessionId, data }]).catch(() => {}); return; }
        fetch(`${TERMINAL_HTTP_BASE}/terminal/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, data }) }).catch(() => {});
    },
    resizeTerminal(sessionId: string, cols: number, rows: number) {
        if (isElectron) { callIpc('resizeTerminal', [{ sessionId, cols, rows }]).catch(() => {}); return; }
        fetch(`${TERMINAL_HTTP_BASE}/terminal/resize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, cols, rows }) }).catch(() => {});
    },
    destroyTerminal(sessionId: string) {
        if (isElectron) { callIpc('destroyTerminal', [sessionId]).catch(() => {}); return; }
        fetch(`${TERMINAL_HTTP_BASE}/terminal/destroy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) }).catch(() => {});
    },
    onTerminalOutput(callback: (data: { sessionId: string; data: string; type: string; exitCode?: number }) => void): () => void {
        if (isElectron && api) return api.onTerminalOutput(callback);
        return () => {};
    },

    // ═══════════════════════════════════════
    // Settings
    // ═══════════════════════════════════════

    async getSettings(userId: string) {
        if (isElectron) return callIpc('getSettings', [userId]);
        return null;
    },
    async saveSettings(params: { userId: string; settings: any; root?: string }) {
        if (isElectron) return callIpc('saveSettings', [params]);
        return { success: false };
    },
    async syncSettings(params: { userId: string; settings: any; root?: string }) {
        if (isElectron) return callIpc('syncSettings', [params]);
        return { success: false };
    },
    async testConnection(params: { userId: string; workspaceRoot?: string; provider: any }) {
        if (isElectron) return callIpc('testConnection', [params]);
        const res = await fetch(`${API_BASE}/api/settings/test-connection`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
        return res.json();
    },

    // ═══════════════════════════════════════
    // Git Operations（替换 REST Git 路由）
    // ═══════════════════════════════════════

    async gitInit(params: { root?: string }) {
        if (isElectron) return callIpc('gitInit', [params]);
        const res = await fetch(`${API_BASE}/api/git/init`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: params.root }) });
        return res.json();
    },
    async gitStatus(params: { root?: string }) {
        if (isElectron) return callIpc('gitStatus', [params]);
        const res = await fetch(`${API_BASE}/api/git/status?path=${encodeURIComponent(params.root || '')}`);
        return res.json();
    },
    async gitLog(params: { root?: string; maxCount?: number }) {
        if (isElectron) return callIpc('gitLog', [params]);
        const res = await fetch(`${API_BASE}/api/git/history?path=${encodeURIComponent(params.root || '')}&limit=${params.maxCount || 40}`);
        return res.json();
    },
    async gitDiff(params: { root?: string; file?: string }) {
        if (isElectron) return callIpc('gitDiff', [params]);
        const query = params.file
            ? `${API_BASE}/api/git/commit-diff?path=${encodeURIComponent(params.root || '')}&filePath=${encodeURIComponent(params.file)}`
            : `${API_BASE}/api/git/commit-diff?path=${encodeURIComponent(params.root || '')}`;
        const res = await fetch(query);
        return res.json();
    },
    async gitFileHistory(params: { root?: string; filePath: string }) {
        if (isElectron) return callIpc('gitFileHistory', [params]);
        const res = await fetch(`${API_BASE}/api/git/file-history?path=${encodeURIComponent(params.root || '')}&filePath=${encodeURIComponent(params.filePath)}&limit=40`);
        return res.json();
    },

    // ═══════════════════════════════════════
    // Workspace
    // ═══════════════════════════════════════

    async selectWorkspace(): Promise<string | null> {
        if (isElectron) return callIpc('selectWorkspace', []);
        return prompt('请输入工作区路径:') || null;
    },
    async initWorkspace(params: { userId: string; root: string }) {
        if (isElectron) return callIpc('initWorkspace', [params]);
        const res = await fetch(`${API_BASE}/api/workspace/init`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
        return res.json();
    },
    async getWorkspaceRoot(userId: string): Promise<string | null> {
        if (isElectron) return callIpc('getWorkspaceRoot', [userId]);
        return null;
    },
    async getWorkspaceStatus(params: { userId: string }) {
        if (isElectron) return callIpc('getWorkspaceStatus', [params]);
        return { initialized: false, workspaceRoot: null };
    },
    async resetWorkspace(params: { userId: string }) {
        if (isElectron) return callIpc('resetWorkspace', [params]);
        return { success: false };
    },

    // ═══════════════════════════════════════
    // App Info
    // ═══════════════════════════════════════

    async getAppInfo() {
        if (isElectron) return callIpc('getAppInfo', []);
        return { version: 'web', platform: navigator.platform, arch: 'web', electronVersion: 'N/A', nodeVersion: 'N/A', isDev: import.meta.env.DEV };
    },
    onSystemEvent(callback: (event: { type: string; payload?: any }) => void): () => void {
        if (isElectron && api) return api.onSystemEvent(callback);
        return () => {};
    },

    // ═══════════════════════════════════════
    // Utility
    // ═══════════════════════════════════════

    /** 检查是否在 Electron 桌面应用中运行 */
    get isDesktop(): boolean {
        return isElectron;
    },
};
