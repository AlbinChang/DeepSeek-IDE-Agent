import { app, type BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { WorkspaceRegistry } from '@/services/WorkspaceRegistry.js';
import { InProcessWorkflowEngine } from '@/workflow/InProcessWorkflowEngine.js';
import { ProcessWorkerWorkflowEngine } from '@/workflow/ProcessWorkerWorkflowEngine.js';
import { WorkflowService } from '@/workflow/WorkflowService.js';
import type { WorkflowEvent, WorkflowEventBus } from '@/workflow/types.js';
import { UtilityProcessWorkflowSpawner } from './utility-process-spawner.js';

/** 开发/打包两种布局下定位 Worker bundle。 */
export function resolveWorkflowWorkerEntry(): string | null {
    const candidates = app.isPackaged
        ? [
            path.join(process.resourcesPath, 'workers', 'workflowWorker.cjs'),
            path.join(process.resourcesPath, 'workers', 'workflowWorker.js'),
            path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'workers', 'workflowWorker.cjs'),
            path.join(app.getAppPath(), 'dist', 'workers', 'workflowWorker.cjs'),
        ]
        : [
            path.join(app.getAppPath(), 'dist', 'workers', 'workflowWorker.cjs'),
        ];
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

/**
 * Electron 主进程中的 Workflow 运行时容器。
 *
 * 负责服务实例、事件总线、Worker 引擎注入与工作区生命周期挂钩。
 */
export class WorkflowRuntime {
    private static instance: WorkflowRuntime | undefined;

    private readonly service = WorkflowService.getInstance();
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

        // Phase 1.5：Electron 内使用 utilityProcess Worker 池；
        // Worker bundle 缺失时回退到进程内引擎，避免开发环境未构建时完全不可用。
        if (!this.service.getEngine()) {
            const workerEntry = resolveWorkflowWorkerEntry();
            if (workerEntry) {
                this.service.setEngine(new ProcessWorkerWorkflowEngine({
                    spawner: new UtilityProcessWorkflowSpawner({
                        entry: workerEntry,
                        env: process.env,
                    }),
                }));
                console.log('[WorkflowRuntime] Using utilityProcess workflow workers:', workerEntry);
            } else {
                console.warn('[WorkflowRuntime] workflowWorker.js not found; falling back to in-process engine.');
                this.service.setEngine(new InProcessWorkflowEngine());
            }
        }

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
