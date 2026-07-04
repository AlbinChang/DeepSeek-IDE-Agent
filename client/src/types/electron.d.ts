/**
 * Electron API 类型声明
 * 
 * 为渲染进程提供 window.electronAPI 的 TypeScript 类型。
 * 与 electron/src/main/preload.ts 中的 contextBridge 暴露的 API 保持一致。
 */

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

interface FileReadParams {
    filePath: string;
    startLine?: number;
    endLine?: number;
    encoding?: string;
    root?: string;
}

interface FileReadResult {
    success: boolean;
    content?: string;
    encoding?: string;
    lineCount?: number;
    filePath?: string;
    error?: string;
}

interface FileWriteParams {
    filePath: string;
    content: string;
    encoding?: string;
    root?: string;
}

interface FileWriteResult {
    success: boolean;
    filePath?: string;
    error?: string;
}

interface ListFilesParams {
    dirPath: string;
    depth?: number;
    root?: string;
}

interface ListFilesResult {
    success: boolean;
    files?: Array<{
        name: string;
        path: string;
        type: 'file' | 'directory';
        isDirectory: boolean;
        isFile: boolean;
    }>;
    totalCount?: number;
    error?: string;
}

interface SearchFilesParams {
    pattern: string;
    root?: string;
    maxResults?: number;
}

interface SearchFilesResult {
    success: boolean;
    results?: Array<{ path: string; line: number; content: string }>;
    error?: string;
}

interface TerminalCreateParams {
    userId: string;
    sessionId?: string;
    workDir?: string;
    cols?: number;
    rows?: number;
}

interface TerminalCreateResult {
    success: boolean;
    sessionId?: string;
    cwd?: string;
    error?: string;
}

interface TerminalInputParams {
    sessionId: string;
    data: string;
}

interface TerminalResizeParams {
    sessionId: string;
    cols: number;
    rows: number;
}

interface TerminalOutputEvent {
    sessionId: string;
    data: string;
    type: 'delta' | 'snapshot' | 'exit';
    exitCode?: number;
}

interface GitParams {
    root?: string;
}

interface SettingsParams {
    userId: string;
    settings: any;
    root?: string;
}

interface SettingsSyncParams {
    userId: string;
    settings: any;
    root?: string;
}

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

interface WorkspaceInitParams {
    userId: string;
    root: string;
}

interface WorkspaceInitResult {
    success: boolean;
    root: string;
    error?: string;
}

interface AppInfo {
    version: string;
    platform: string;
    arch: string;
    electronVersion: string;
    nodeVersion: string;
    isDev: boolean;
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

interface ElectronAPI {
    // Agent
    startAgentChat: (params: AgentChatParams) => Promise<string>;
    cancelAgentChat: (streamId: string) => void;
    clearSession: (params: { userId: string; workspaceRoot?: string }) => Promise<{ success: boolean; error?: string }>;
    onAgentEvent: (callback: (event: AgentEvent) => void) => () => void;

    // Files
    readFile: (params: FileReadParams) => Promise<FileReadResult>;
    writeFile: (params: FileWriteParams) => Promise<FileWriteResult>;
    listFiles: (params: ListFilesParams) => Promise<ListFilesResult>;
    searchFiles: (params: SearchFilesParams) => Promise<SearchFilesResult>;
    getFileMd5: (params: { filePath: string }) => Promise<{ success: boolean; md5?: string; error?: string }>;
    deleteFile: (params: { filePath: string; root?: string }) => Promise<{ success: boolean; error?: string }>;
    renameFile: (params: { oldPath: string; newPath: string; root?: string }) => Promise<{ success: boolean; newPath?: string; error?: string }>;

    // Terminal
    createTerminal: (params: TerminalCreateParams) => Promise<TerminalCreateResult>;
    sendTerminalInput: (params: TerminalInputParams) => void;
    resizeTerminal: (params: TerminalResizeParams) => void;
    destroyTerminal: (sessionId: string) => void;
    onTerminalOutput: (callback: (data: TerminalOutputEvent) => void) => () => void;

    // Git
    gitStatus: (params: GitParams) => Promise<any>;
    gitLog: (params: GitParams & { maxCount?: number }) => Promise<any>;
    gitDiff: (params: GitParams & { file?: string }) => Promise<any>;
    gitFileHistory: (params: GitParams & { filePath: string }) => Promise<any>;

    // Settings
    getSettings: (userId: string) => Promise<any>;
    saveSettings: (params: SettingsParams) => Promise<any>;
    syncSettings: (params: SettingsSyncParams) => Promise<any>;
    testConnection: (params: any) => Promise<any>;

    // Context
    updateContext: (context: EditorContext) => void;
    onContextBroadcast: (callback: (ctx: EditorContext) => void) => () => void;

    // Completion
    requestCompletion: (params: CompletionParams) => Promise<string>;
    cancelCompletion: (completionId: string) => void;
    onCompletionResult: (callback: (result: CompletionResult) => void) => () => void;

    // Workspace
    initWorkspace: (params: WorkspaceInitParams) => Promise<WorkspaceInitResult>;
    selectWorkspace: () => Promise<string | null>;
    getWorkspaceRoot: (userId: string) => Promise<string | null>;
    getWorkspaceStatus: (params: { userId: string }) => Promise<{ initialized: boolean; workspaceRoot: string | null }>;
    resetWorkspace: (params: { userId: string }) => Promise<{ success: boolean }>;

    // App
    getAppInfo: () => Promise<AppInfo>;
    revealInExplorer: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    onSystemEvent: (callback: (event: SystemEvent) => void) => () => void;

    // Diagnostics
    getDiagnostics: (params: { filePath: string }) => Promise<DiagnosticsResult>;
    getDiagnosticsBatch: (params: { filePaths: string[] }) => Promise<DiagnosticsResult[]>;
}

declare global {
    interface Window {
        electronAPI?: ElectronAPI;
    }
}

export {};
