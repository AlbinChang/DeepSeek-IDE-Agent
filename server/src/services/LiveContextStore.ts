export interface UserContext {
    currentFile: string | null;
    provider: string | null;      // 对齐 Section 4.4: 模型引擎透传
    modelId: string | null;       // 对齐 Section 32.2: 推理质量保障
    userName?: string;            // 用户身份
    selection: {
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
        text: string;
    } | null;
    cursor: {
        line: number;
        column: number;
    } | null;
    lastClick: {
        line: number;
        column: number;
    } | null;
    isFocused: boolean;
    focused?: boolean;            // 别名
    click?: any;                  // 点击数据
    recentDiagnostics: any[];
}

/**
 * 对应技术规范 3.2 节：动态上下文仓库 (Live Context Store)
 * 维护内存中的用户状态镜像，并在 Agent 发起对话前自动注入隐含上下文。
 *
 * 工作区根路径不在本类中重复保存：它以「(userId, workspaceRoot) 复合键」的形式
 * 体现在存储键上，真值来源统一由 WorkspaceRegistry 提供，避免多处状态分叉。
 */
export class LiveContextStore {
    private static instance: LiveContextStore;
    private contexts: Map<string, UserContext> = new Map();

    private constructor() {}

    static getInstance(): LiveContextStore {
        if (!LiveContextStore.instance) {
            LiveContextStore.instance = new LiveContextStore();
        }
        return LiveContextStore.instance;
    }

    private contextKey(userId: string, workspaceRoot?: string | null): string {
        return workspaceRoot ? `${userId}\u0000${workspaceRoot}` : userId;
    }

    updateContext(userId: string, update: Partial<UserContext>, workspaceRoot?: string | null) {
        const key = this.contextKey(userId, workspaceRoot);
        const current = this.contexts.get(key) || {
            currentFile: null,
            provider: null,
            modelId: null,
            selection: null,
            cursor: null,
            lastClick: null,
            isFocused: true,
            recentDiagnostics: []
        };
        this.contexts.set(key, { ...current, ...update });
    }

    /**
     * 更新选择区域 (供 API 直接调用)
     */
    updateSelection(userId: string, data: any) {
        this.updateContext(userId, {
            currentFile: data.path,
            selection: {
                startLine: data.startLine,
                startColumn: data.startChar,
                endLine: data.endLine,
                endColumn: data.endChar,
                text: data.text
            },
            cursor: {
                line: data.endLine,
                column: data.endChar
            }
        }, data.workspaceRoot || null);
    }

    /**
     * 更新点击焦点 (供 API 直接调用)
     */
    updateClick(userId: string, data: any) {
        this.updateContext(userId, {
            currentFile: data.path,
            lastClick: {
                line: data.line,
                column: data.char
            }
        }, data.workspaceRoot || null);
    }

    /**
     * 更新焦点状态
     */
    updateFocus(userId: string, focused: boolean, workspaceRoot?: string | null) {
        this.updateContext(userId, { isFocused: focused }, workspaceRoot || null);
    }

    getContext(userId: string, workspaceRoot?: string | null): UserContext | undefined {
        return this.contexts.get(this.contextKey(userId, workspaceRoot)) || this.contexts.get(userId);
    }
}