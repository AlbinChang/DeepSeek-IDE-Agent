/**
 * Preload Script — 安全桥接层
 * 
 * 通过 contextBridge 向渲染进程暴露有限的、安全的 API。
 * 渲染进程只能通过 window.electronAPI 访问主进程能力，
 * 无法直接访问 Node.js API 或文件系统。
 */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import * as os from 'node:os';

// ── 注入 Electron 环境标记（供 electron-bridge.ts 多重检测兜底） ──
contextBridge.exposeInMainWorld('__IS_ELECTRON__', true);
// 与 app:info 使用同一来源，确保渲染进程生成的 userId 与后台 Agent 身份一致。
const electronUserId = process.env.USERNAME || os.userInfo().username || 'unknown';
contextBridge.exposeInMainWorld('__ELECTRON_USER_ID__', electronUserId);

// ── 类型定义 ──
export interface ElectronAPI {
    // Agent 对话（替换 SSE）
    startAgentChat: (params: AgentChatParams) => Promise<string>; // 返回 streamId
    cancelAgentChat: (streamId: string) => void;
    clearSession: (params: { userId: string; workspaceRoot?: string }) => Promise<{ success: boolean; error?: string }>;
    onAgentEvent: (callback: (event: AgentEvent) => void) => () => void; // 返回取消订阅函数

    // 文件操作（替换 REST /api/files/*）
    readFile: (params: FileReadParams) => Promise<FileReadResult>;
    readFileBinary: (params: { filePath: string; root?: string }) => Promise<{ success: boolean; base64?: string; size?: number; mimeType?: string; error?: string }>;
    writeFile: (params: FileWriteParams) => Promise<FileWriteResult>;
    createFile: (params: FileCreateParams) => Promise<FileCreateResult>;
    listFiles: (params: ListFilesParams) => Promise<ListFilesResult>;
    searchFiles: (params: SearchFilesParams) => Promise<SearchFilesResult>;
    getFileMd5: (params: { filePath: string }) => Promise<{ md5: string }>;
    deleteFile: (params: { filePath: string; root?: string }) => Promise<{ success: boolean; error?: string }>;
    renameFile: (params: { oldPath: string; newPath: string; root?: string }) => Promise<{ success: boolean; newPath?: string; error?: string }>;
    listJarContents: (params: { jarPath: string; innerPath?: string; root?: string }) => Promise<{ success: boolean; files?: Array<{ name: string; type: 'file' | 'directory'; path: string; isDirectory: boolean; isFile: boolean }>; totalCount?: number; error?: string }>;
    readJarEntry: (params: { jarPath: string; entryPath: string; root?: string }) => Promise<{ success: boolean; content?: string; encoding?: string; lineCount?: number; isBinary?: boolean; entryPath?: string; error?: string }>;

    // 终端（替换 terminal-server SSE/REST）
    createTerminal: (params: TerminalCreateParams) => Promise<TerminalCreateResult>;
    sendTerminalInput: (params: TerminalInputParams) => void;
    resizeTerminal: (params: TerminalResizeParams) => void;
    destroyTerminal: (sessionId: string) => void;
    onTerminalOutput: (callback: (data: TerminalOutputEvent) => void) => () => void;

    // Git 操作
    gitInit: (params: GitParams) => Promise<any>;
    gitStatus: (params: GitParams) => Promise<any>;
    gitLog: (params: GitParams & { maxCount?: number }) => Promise<any>;
    gitDiff: (params: GitParams & { file?: string }) => Promise<any>;
    gitFileHistory: (params: GitParams & { filePath: string }) => Promise<any>;

    // 设置
    getSettings: (userId: string) => Promise<any>;
    saveSettings: (params: SettingsParams) => Promise<any>;
    syncSettings: (params: SettingsSyncParams) => Promise<any>;
    testConnection: (params: any) => Promise<any>;

    // 编辑器上下文（替换 /ws/context WebSocket）
    updateContext: (context: EditorContext) => void;
    onContextBroadcast: (callback: (ctx: EditorContext) => void) => () => void;

    // 代码补全（替换 /ws/completion WebSocket）
    requestCompletion: (params: CompletionParams) => Promise<string>; // 返回 completionId
    cancelCompletion: (completionId: string) => void;
    onCompletionResult: (callback: (result: CompletionResult) => void) => () => void;

    // 工作区
    initWorkspace: (params: WorkspaceInitParams) => Promise<WorkspaceInitResult>;
    selectWorkspace: () => Promise<string | null>;
    getWorkspaceRoot: (userId: string) => Promise<string | null>;
    getWorkspaceStatus: (params: { userId: string }) => Promise<{ initialized: boolean; workspaceRoot: string | null }>;
    resetWorkspace: (params: { userId: string }) => Promise<{ success: boolean }>;

    // 应用
    getAppInfo: () => Promise<AppInfo>;
    revealInExplorer: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    onSystemEvent: (callback: (event: SystemEvent) => void) => () => void;

    // 诊断
    getDiagnostics: (params: { filePath: string }) => Promise<DiagnosticsResult>;
    getDiagnosticsBatch: (params: { filePaths: string[] }) => Promise<DiagnosticsResult[]>;
}

// ── 参数/结果类型 ──
interface AgentChatParams {
    userId: string;
    userInstruct: string;
    traceId: string;
    locale?: string;
    root?: string;
    reasoningEffort?: 'high' | 'max';
    provider?: string;
    model?: string;
}

interface AgentEvent {
    streamId: string;
    type: 'init' | 'stage' | 'reasoning' | 'text' | 'annotation' | 'progress' | 'error' | 'done' | 'heartbeat';
    content?: string;
    traceId?: string;
    model?: string;
    method?: string;
    params?: any;
    channel?: string;
    receivedChars?: number;
    contentChars?: number;
    reasoningChars?: number;
    toolArgumentChars?: number;
    deltaChars?: number;
    toolName?: string;
    turn?: number;
    timestamp: number;
    isFinal?: boolean;
}

interface FileReadParams { filePath: string; startLine?: number; endLine?: number; encoding?: string; root?: string; }
interface FileReadResult { content: string; encoding: string; lineCount: number; }
interface FileWriteParams { filePath: string; content: string; encoding?: string; root?: string; }
interface FileWriteResult { success: boolean; filePath: string; }
interface FileCreateParams { filePath: string; type?: 'file' | 'directory' | 'folder'; root?: string; }
interface FileCreateResult { success: boolean; filePath?: string; type?: 'file' | 'directory'; error?: string; }
interface ListFilesParams { dirPath: string; depth?: number; root?: string; }
interface ListFilesResult { files: Array<{ name: string; type: 'file' | 'directory'; path: string; }>; }
interface SearchFilesParams { pattern: string; root?: string; maxResults?: number; }
interface SearchFilesResult { results: Array<{ path: string; line: number; content: string; }>; }

interface TerminalCreateParams { userId: string; sessionId?: string; workDir?: string; cols?: number; rows?: number; }
interface TerminalCreateResult { sessionId: string; cwd: string; }
interface TerminalInputParams { sessionId: string; data: string; }
interface TerminalResizeParams { sessionId: string; cols: number; rows: number; }
interface TerminalOutputEvent { sessionId: string; data: string; type: 'delta' | 'snapshot' | 'exit'; exitCode?: number; }

interface GitParams { root?: string; }
interface SettingsParams { userId: string; settings: any; root?: string; }
interface SettingsSyncParams { userId: string; settings: any; root?: string; }

interface EditorContext {
    userId: string;
    currentFile?: string | null;
    selection?: { startLine: number; startColumn: number; endLine: number; endColumn: number } | null;
    workspaceRoot?: string;
}

interface CompletionParams {
    userId: string;
    filePath: string;
    position: { line: number; column: number };
    context?: string;
    root?: string;
}

interface CompletionResult {
    completionId: string;
    text: string;
    isFinal: boolean;
}

interface WorkspaceInitParams { userId: string; root: string; }
interface WorkspaceInitResult { success: boolean; root: string; }

interface AppInfo {
    version: string;
    platform: string;
    arch: string;
    electronVersion: string;
    nodeVersion: string;
    isDev: boolean;
    username: string;
}

interface SystemEvent {
    type: 'workspace_ready' | 'workspace_changed' | 'settings_updated';
    payload?: any;
}

interface DiagnosticEntry {
    line?: number;
    column?: number;
    message: string;
    severity: 'error' | 'warning' | 'info';
    code?: string;
}

interface DiagnosticsResult {
    success: boolean;
    filePath: string;
    extension: string;
    checker: string;
    passed: boolean;
    summary: string;
    diagnostics: DiagnosticEntry[];
    durationMs: number;
}

// ── 暴露 API 到渲染进程 ──
contextBridge.exposeInMainWorld('electronAPI', {
    // Agent 对话
    startAgentChat: (params: AgentChatParams) => ipcRenderer.invoke('agent:chat', params),
    cancelAgentChat: (streamId: string) => ipcRenderer.send('agent:cancel', streamId),
    clearSession: (params: { userId: string; workspaceRoot?: string }) => ipcRenderer.invoke('agent:clear', params),
    onAgentEvent: (callback: (event: AgentEvent) => void) => {
        const handler = (_event: IpcRendererEvent, data: AgentEvent) => callback(data);
        ipcRenderer.on('agent:event', handler);
        return () => ipcRenderer.removeListener('agent:event', handler);
    },

    // 文件操作
    readFile: (params: FileReadParams) => ipcRenderer.invoke('file:read', params),
    readFileBinary: (params: { filePath: string; root?: string }) => ipcRenderer.invoke('file:readBinary', params),
    writeFile: (params: FileWriteParams) => ipcRenderer.invoke('file:write', params),
    createFile: (params: FileCreateParams) => ipcRenderer.invoke('file:create', params),
    listFiles: (params: ListFilesParams) => ipcRenderer.invoke('file:list', params),
    searchFiles: (params: SearchFilesParams) => ipcRenderer.invoke('file:search', params),
    getFileMd5: (params: { filePath: string }) => ipcRenderer.invoke('file:md5', params),
    deleteFile: (params: { filePath: string; root?: string }) => ipcRenderer.invoke('file:delete', params),
    renameFile: (params: { oldPath: string; newPath: string; root?: string }) => ipcRenderer.invoke('file:rename', params),
    listJarContents: (params: { jarPath: string; innerPath?: string; root?: string }) => ipcRenderer.invoke('file:listJar', params),
    readJarEntry: (params: { jarPath: string; entryPath: string; root?: string }) => ipcRenderer.invoke('file:readJarEntry', params),

    // 终端
    createTerminal: (params: TerminalCreateParams) => ipcRenderer.invoke('terminal:create', params),
    sendTerminalInput: (params: TerminalInputParams) => ipcRenderer.send('terminal:input', params),
    resizeTerminal: (params: TerminalResizeParams) => ipcRenderer.send('terminal:resize', params),
    destroyTerminal: (sessionId: string) => ipcRenderer.send('terminal:destroy', sessionId),
    onTerminalOutput: (callback: (data: TerminalOutputEvent) => void) => {
        const handler = (_event: IpcRendererEvent, data: TerminalOutputEvent) => callback(data);
        ipcRenderer.on('terminal:output', handler);
        return () => ipcRenderer.removeListener('terminal:output', handler);
    },

    // Git
    gitInit: (params: GitParams) => ipcRenderer.invoke('git:init', params),
    gitStatus: (params: GitParams) => ipcRenderer.invoke('git:status', params),
    gitLog: (params: GitParams & { maxCount?: number }) => ipcRenderer.invoke('git:log', params),
    gitDiff: (params: GitParams & { file?: string }) => ipcRenderer.invoke('git:diff', params),
    gitFileHistory: (params: GitParams & { filePath: string }) => ipcRenderer.invoke('git:fileHistory', params),

    // 设置
    getSettings: (userId: string) => ipcRenderer.invoke('settings:get', userId),
    saveSettings: (params: SettingsParams) => ipcRenderer.invoke('settings:set', params),
    syncSettings: (params: SettingsSyncParams) => ipcRenderer.invoke('settings:sync', params),
    testConnection: (params: any) => ipcRenderer.invoke('settings:test-connection', params),

    // 编辑器上下文
    updateContext: (context: EditorContext) => ipcRenderer.send('context:update', context),
    onContextBroadcast: (callback: (ctx: EditorContext) => void) => {
        const handler = (_event: IpcRendererEvent, ctx: EditorContext) => callback(ctx);
        ipcRenderer.on('context:broadcast', handler);
        return () => ipcRenderer.removeListener('context:broadcast', handler);
    },

    // 代码补全
    requestCompletion: (params: CompletionParams) => ipcRenderer.invoke('completion:request', params),
    cancelCompletion: (completionId: string) => ipcRenderer.send('completion:cancel', completionId),
    onCompletionResult: (callback: (result: CompletionResult) => void) => {
        const handler = (_event: IpcRendererEvent, result: CompletionResult) => callback(result);
        ipcRenderer.on('completion:result', handler);
        return () => ipcRenderer.removeListener('completion:result', handler);
    },

    // 工作区
    initWorkspace: (params: WorkspaceInitParams) => ipcRenderer.invoke('workspace:init', params),
    selectWorkspace: () => ipcRenderer.invoke('workspace:select'),
    getWorkspaceRoot: (userId: string) => ipcRenderer.invoke('workspace:getRoot', userId),
    getWorkspaceStatus: (params: { userId: string }) => ipcRenderer.invoke('workspace:status', params),
    resetWorkspace: (params: { userId: string }) => ipcRenderer.invoke('workspace:reset', params),

    // 应用
    getAppInfo: () => ipcRenderer.invoke('app:info'),
    revealInExplorer: (filePath: string) => ipcRenderer.invoke('app:revealInExplorer', filePath),
    onSystemEvent: (callback: (event: SystemEvent) => void) => {
        const handler = (_event: IpcRendererEvent, data: SystemEvent) => callback(data);
        ipcRenderer.on('system:event', handler);
        return () => ipcRenderer.removeListener('system:event', handler);
    },

    // 诊断
    getDiagnostics: (params: { filePath: string }) => ipcRenderer.invoke('diagnostics:get', params),
    getDiagnosticsBatch: (params: { filePaths: string[] }) => ipcRenderer.invoke('diagnostics:batch', params),
} satisfies ElectronAPI);

// TypeScript 类型声明：让渲染进程可以访问 window.electronAPI
// （实际声明在 client/src/types/electron.d.ts）
