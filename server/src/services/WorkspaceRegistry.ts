import * as path from 'node:path';

export type WorkspaceChangeReason = 'reset' | 'switch';

export interface WorkspaceChangeEvent {
    userId: string;
    /** 变更前的工作区根路径 */
    previousRoot: string;
    reason: WorkspaceChangeReason;
}

export type WorkspaceChangeListener = (event: WorkspaceChangeEvent) => void | Promise<void>;

/**
 * 工作区根路径的唯一真值来源。
 * 主进程 IPC、AgentService、Workflow 调度器共享同一实例，避免各自维护 Map 造成状态分叉。
 */
export class WorkspaceRegistry {
    private static instance: WorkspaceRegistry | undefined;

    private readonly roots = new Map<string, string>();
    private readonly listeners = new Set<WorkspaceChangeListener>();

    public static getInstance(): WorkspaceRegistry {
        if (!WorkspaceRegistry.instance) {
            WorkspaceRegistry.instance = new WorkspaceRegistry();
        }
        return WorkspaceRegistry.instance;
    }

    public get(userId: string): string | undefined {
        return this.roots.get(userId);
    }

    /** 直接写入，不触发变更通知；需要通知时使用 switchWorkspace/reset */
    public set(userId: string, root: string): string | undefined {
        const previous = this.roots.get(userId);
        this.roots.set(userId, root);
        return previous;
    }

    /**
     * 切换工作区；根路径实际变化时通知监听器（用于取消旧工作区的后台运行）。
     */
    public async switchWorkspace(userId: string, root: string): Promise<{ previousRoot?: string }> {
        const previousRoot = this.roots.get(userId);
        this.roots.set(userId, root);
        if (previousRoot && !this.isSamePath(previousRoot, root)) {
            await this.notify({ userId, previousRoot, reason: 'switch' });
        }
        return { previousRoot };
    }

    /**
     * 重置工作区；删除映射后通知监听器。
     * 单个监听器失败不会阻断重置流程。
     */
    public async reset(userId: string): Promise<string | undefined> {
        const previousRoot = this.roots.get(userId);
        this.roots.delete(userId);
        if (previousRoot) {
            await this.notify({ userId, previousRoot, reason: 'reset' });
        }
        return previousRoot;
    }

    public onWorkspaceChange(listener: WorkspaceChangeListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** 仅供测试使用：清空全部状态与监听器 */
    public clearForTests(): void {
        this.roots.clear();
        this.listeners.clear();
    }

    private async notify(event: WorkspaceChangeEvent): Promise<void> {
        if (this.listeners.size === 0) return;
        const results = await Promise.allSettled(
            Array.from(this.listeners, (listener) => Promise.resolve().then(() => listener(event))),
        );
        for (const result of results) {
            if (result.status === 'rejected') {
                console.warn('[WorkspaceRegistry] Workspace change listener failed:', result.reason);
            }
        }
    }

    private isSamePath(left: string, right: string): boolean {
        const normalizedLeft = path.resolve(left);
        const normalizedRight = path.resolve(right);
        if (process.platform === 'win32') {
            return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
        }
        return normalizedLeft === normalizedRight;
    }
}
