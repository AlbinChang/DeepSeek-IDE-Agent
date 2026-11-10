import type { BrowserWindow } from 'electron';

import { WorkspaceRegistry } from '@/services/WorkspaceRegistry.js';
import { WorkflowService } from '@/workflow/WorkflowService.js';
import type { WorkflowEvent, WorkflowEventBus } from '@/workflow/types.js';

/**
 * Electron 主进程中的 Workflow 运行时容器。
 *
 * Phase 0 只负责服务实例、事件总线与工作区生命周期挂钩；
 * Phase 1.5 将在这里创建 ProcessWorkerWorkflowEngine 并注入 WorkflowService。
 */
export class WorkflowRuntime {
    private static instance: WorkflowRuntime | undefined;

    private readonly service = new WorkflowService();
    private getWindow: (() => BrowserWindow | null) | null = null;
    private unsubscribeWorkspace: (() => void) | null = null;
    private started = false;

    public static getInstance(): WorkflowRuntime {
        if (!WorkflowRuntime.instance) {
            WorkflowRuntime.instance = new WorkflowRuntime();
        }
        return WorkflowRuntime.instance;
    }

    public initialize(getWindow: () => BrowserWindow | null): void {
        this.getWindow = getWindow;

        const eventBus: WorkflowEventBus = {
            publish: (event) => this.publishToRenderer(event),
        };
        this.service.setEventBus(eventBus);

        if (!this.unsubscribeWorkspace) {
            this.unsubscribeWorkspace = WorkspaceRegistry.getInstance().onWorkspaceChange(
                async ({ userId, previousRoot }) => {
                    // 工作区重置/切换后，旧工作区的 run 不应继续后台执行
                    await this.service.cancelUserRuns(userId, previousRoot);
                },
            );
        }
    }

    public getService(): WorkflowService {
        return this.service;
    }

    public async start(): Promise<void> {
        if (this.started) return;
        this.started = true;
    }

    public async shutdown(): Promise<void> {
        this.started = false;
        this.unsubscribeWorkspace?.();
        this.unsubscribeWorkspace = null;
        await this.service.shutdown();
    }

    private publishToRenderer(event: WorkflowEvent): void {
        const window = this.getWindow?.();
        if (!window || window.isDestroyed()) return;
        window.webContents.send('workflow:event', event);
    }
}
