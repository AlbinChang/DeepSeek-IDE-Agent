import { config as globalConfig } from '@/config/index.js';
import { WorkflowRegistry } from '@/workflow/WorkflowRegistry.js';
import { WorkflowTriggerManager } from '@/workflow/WorkflowTriggerManager.js';
import {
    NULL_WORKFLOW_EVENT_BUS,
    type WorkflowDetail,
    type WorkflowEngine,
    type WorkflowEvent,
    type WorkflowEventBus,
    type WorkflowRunCancelRequest,
    type WorkflowRunInfo,
    type WorkflowRunLookup,
    type WorkflowRunQuery,
    type WorkflowRunRequest,
    type WorkflowRunResumeRequest,
    type WorkflowRunStartResult,
    type WorkflowRuntimeStats,
    type WorkflowSummary,
    type WorkflowValidationResult,
} from '@/workflow/types.js';

export const WORKFLOW_DISABLED = 'WORKFLOW_DISABLED';
export const WORKFLOW_ENGINE_UNAVAILABLE = 'WORKFLOW_ENGINE_UNAVAILABLE';

/**
 * Workflow 能力入口：只依赖 WorkflowEngine / WorkflowEventBus 端口，
 * 不依赖 Electron/Fastify，方便在 Electron 主进程、standalone server 与测试中复用。
 */
export class WorkflowService {
    private static instance: WorkflowService | undefined;

    private engine: WorkflowEngine | null = null;
    private triggers: WorkflowTriggerManager | null = null;
    private eventBus: WorkflowEventBus = NULL_WORKFLOW_EVENT_BUS;
    private readonly subscribers = new Set<(event: WorkflowEvent) => void>();
    private readonly dispatcher: WorkflowEventBus = {
        publish: (event) => {
            try {
                this.eventBus.publish(event);
            } catch (error) {
                console.warn('[WorkflowService] Event bus failed:', error);
            }
            for (const listener of this.subscribers) {
                try {
                    listener(event);
                } catch (error) {
                    console.warn('[WorkflowService] Event subscriber failed:', error);
                }
            }
        },
    };

    public static getInstance(): WorkflowService {
        if (!WorkflowService.instance) {
            WorkflowService.instance = new WorkflowService();
        }
        return WorkflowService.instance;
    }

    public isEnabled(): boolean {
        return globalConfig.workflow.enabled;
    }

    public setEngine(engine: WorkflowEngine | null): void {
        this.engine = engine;
        engine?.setEventBus?.(this.dispatcher);
    }

    public getEngine(): WorkflowEngine | null {
        return this.engine;
    }

    public setEventBus(eventBus: WorkflowEventBus): void {
        this.eventBus = eventBus;
        this.engine?.setEventBus?.(this.dispatcher);
    }

    public publish(event: WorkflowEvent): void {
        this.dispatcher.publish(event);
    }

    public subscribe(listener: (event: WorkflowEvent) => void): () => void {
        this.subscribers.add(listener);
        return () => this.subscribers.delete(listener);
    }

    public async list(root: string): Promise<WorkflowSummary[]> {
        return new WorkflowRegistry(root).list();
    }

    public async get(root: string, name: string): Promise<WorkflowDetail | null> {
        return new WorkflowRegistry(root).get(name);
    }

    public async validate(root: string, name?: string): Promise<WorkflowValidationResult> {
        return new WorkflowRegistry(root).validate(name);
    }

    public async run(request: WorkflowRunRequest): Promise<WorkflowRunStartResult> {
        if (!this.isEnabled()) {
            return { ok: false, error: WORKFLOW_DISABLED };
        }
        if (!this.engine) {
            return { ok: false, error: WORKFLOW_ENGINE_UNAVAILABLE };
        }
        return this.engine.startRun(request);
    }

    public async getRun(query: WorkflowRunLookup): Promise<WorkflowRunInfo | null> {
        if (!this.engine) return null;
        return this.engine.getRun(query);
    }

    public async listRuns(query: WorkflowRunQuery): Promise<WorkflowRunInfo[]> {
        if (!this.engine?.listRuns) return [];
        return this.engine.listRuns(query);
    }

    public async cancel(request: WorkflowRunCancelRequest): Promise<boolean> {
        if (!this.isEnabled() || !this.engine) return false;
        return this.engine.cancelRun(request);
    }

    public async resume(request: WorkflowRunResumeRequest): Promise<boolean> {
        if (!this.isEnabled() || !this.engine) return false;
        return this.engine.resumeRun(request);
    }

    public getStats(): WorkflowRuntimeStats {
        if (!this.engine) {
            return { active: 0, queued: 0, workers: [] };
        }
        return this.engine.getStats();
    }

    public async cancelUserRuns(userId: string, root?: string): Promise<void> {
        await this.engine?.cancelUserRuns?.(userId, root);
    }

    public async activateTriggers(userId: string, root: string): Promise<void> {
        if (!globalConfig.workflow.enabled || !globalConfig.workflow.triggersEnabled) return;
        this.triggers ||= new WorkflowTriggerManager(this);
        await this.triggers.activate(userId, root);
    }

    public async deactivateTriggers(userId: string, root?: string): Promise<void> {
        await this.triggers?.deactivate(userId, root);
    }

    public async shutdown(): Promise<void> {
        await this.triggers?.shutdown();
        this.triggers = null;
        await this.engine?.shutdown();
        this.engine = null;
    }
}
