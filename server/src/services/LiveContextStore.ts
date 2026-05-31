export interface UserContext {
    currentFile: string | null;
    workspaceRoot: string | null; // 对齐 Section 42.1: 战略工作区透传
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
 * 维护内存中的用户状态镜像，并在 Agent 发起对话前自动注入隐含上下文
 */
export class LiveContextStore {
    private static instance: LiveContextStore;
    private contexts: Map<string, UserContext> = new Map();
    private staticInfo: any = null;

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

    /**
     * 设置全局静态上下文 (如 OS, Shell, Node 版本等)
     * 避免后台服务（历史压缩等）重复获取 environment 信息
     */
    setStaticContext(info: any) {
        this.staticInfo = info;
    }

    updateContext(userId: string, update: Partial<UserContext>, workspaceRoot?: string | null) {
        const root = workspaceRoot || update.workspaceRoot || null;
        const key = this.contextKey(userId, root);
        const current = this.contexts.get(key) || {
            currentFile: null,
            workspaceRoot: root,
            provider: null,
            modelId: null,
            selection: null,
            cursor: null,
            lastClick: null,
            isFocused: true,
            recentDiagnostics: []
        };
        this.contexts.set(key, { ...current, ...update, workspaceRoot: root });
    }

    /**
     * 更新选择区域 (供 API 直接调用)
     */
    updateSelection(userId: string, data: any) {
        this.updateContext(userId, {
            currentFile: data.path,
            workspaceRoot: data.workspaceRoot || null,
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
            workspaceRoot: data.workspaceRoot || null,
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
        this.updateContext(userId, { isFocused: focused, workspaceRoot: workspaceRoot || null }, workspaceRoot || null);
    }

    getContext(userId: string, workspaceRoot?: string | null): UserContext | undefined {
        return this.contexts.get(this.contextKey(userId, workspaceRoot)) || this.contexts.get(userId);
    }

    /**
     * 清理指定用户的上下文 (对齐 23.1 节)
     */
    clearContext(userId: string) {
        this.contexts.delete(userId);
    }

    /**
     * 为 Prompt 注入实时上下文 (对齐 3.1 & 4.5.2 节)
     * 同时包含全局环境快照，以降低后台服务获取开销
     */
    getPromptContext(userId: string, workspaceRoot?: string | null): string {
        const ctx = this.getContext(userId, workspaceRoot);
        if (!ctx) return "No active context.";

        let envSection = "";
        if (this.staticInfo) {
            envSection = `
[System Environment - Static]
OS: ${this.staticInfo.os} (${this.staticInfo.arch})
Shell: ${this.staticInfo.shell}
Node.js: ${this.staticInfo.nodeVersion}
Hardware: ${this.staticInfo.cpuCores} Cores, ${this.staticInfo.totalMemory} RAM
User: ${this.staticInfo.env?.USER || 'unknown'}
CWD: ${this.staticInfo.cwd}
            `.trim();
        }

        return `
${envSection}

[Workspace Context]
Root: ${ctx.workspaceRoot || 'None'}
Provider: ${ctx.provider || 'default'}
Model ID: ${ctx.modelId || 'none'}

[User Current State - Dynamic]
Active File: ${ctx.currentFile || 'None'}
Editor Focused: ${ctx.isFocused}
Cursor Position: Line ${ctx.cursor?.line}, Col ${ctx.cursor?.column}
Last Mouse Click: ${ctx.lastClick ? `Line ${ctx.lastClick.line}, Col ${ctx.lastClick.column}` : 'None'}
Selected Code: ${ctx.selection ? `\n\`\`\`\n${ctx.selection.text}\n\`\`\`` : 'None'}
        `.trim();
    }
}
