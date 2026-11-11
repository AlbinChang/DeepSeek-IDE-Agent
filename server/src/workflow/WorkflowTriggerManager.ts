import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { samePath, workflowDefinitionHash } from '@/workflow/engineUtils.js';
import { AsyncKeyedLock } from '@/workflow/AsyncKeyedLock.js';
import { WorkflowRegistry } from '@/workflow/WorkflowRegistry.js';
import { parseWorkflowTriggers, type WorkflowTrigger } from '@/workflow/WorkflowTriggers.js';
import type { WorkflowService } from '@/workflow/WorkflowService.js';

interface TriggerState {
    id: string;
    name: string;
    path: string;
    hash: string;
    trigger: WorkflowTrigger;
    nextAt: number;
    signatures: Map<string, string>;
    pending: boolean;
    lastRunId?: string;
    lastError?: string;
}

interface WorkspaceState {
    userId: string;
    root: string;
    realRoot: string;
    triggers: Map<string, TriggerState>;
    nextRefresh: number;
    timer?: ReturnType<typeof setInterval>;
    pending?: Promise<void>;
}

export interface WorkflowTriggerManagerOptions {
    pollIntervalMs?: number;
    refreshIntervalMs?: number;
    cooldownMs?: number;
}

/** Opt-in local triggers. They are active only while a workspace is registered. */
export class WorkflowTriggerManager {
    private readonly workspaces = new Map<string, WorkspaceState>();
    private readonly lifecycle = new AsyncKeyedLock();
    private readonly pollIntervalMs: number;
    private readonly refreshIntervalMs: number;
    private readonly cooldownMs: number;
    private closed = false;

    constructor(
        private readonly service: Pick<WorkflowService, 'run' | 'getRun'>,
        options: WorkflowTriggerManagerOptions = {},
    ) {
        this.pollIntervalMs = Math.max(100, options.pollIntervalMs ?? 1000);
        this.refreshIntervalMs = Math.max(this.pollIntervalMs, options.refreshIntervalMs ?? 15_000);
        this.cooldownMs = Math.max(this.pollIntervalMs, options.cooldownMs ?? 5000);
    }

    public async activate(userId: string, root: string): Promise<void> {
        if (this.closed) throw new Error('Workflow trigger manager is closed');
        await this.lifecycle.run(userId, () => this.activateLocked(userId, root));
    }

    private async activateLocked(userId: string, root: string): Promise<void> {
        const existing = this.workspaces.get(userId);
        if (existing && samePath(existing.root, root)) return;
        await this.deactivateLocked(userId);
        const state: WorkspaceState = {
            userId,
            root,
            realRoot: await fs.realpath(root),
            triggers: new Map(),
            nextRefresh: 0,
        };
        if (this.closed) return;
        this.workspaces.set(userId, state);
        const initial = this.refresh(state);
        state.pending = initial;
        try {
            await initial;
        } catch (error) {
            if (this.workspaces.get(userId) === state) this.workspaces.delete(userId);
            throw error;
        } finally {
            if (state.pending === initial) state.pending = undefined;
        }
        if (this.workspaces.get(userId) !== state) return;
        state.timer = setInterval(() => this.scheduleTick(state), this.pollIntervalMs);
        state.timer.unref?.();
    }

    public async deactivate(userId: string, root?: string): Promise<void> {
        await this.lifecycle.run(userId, () => this.deactivateLocked(userId, root));
    }

    private async deactivateLocked(userId: string, root?: string): Promise<void> {
        const state = this.workspaces.get(userId);
        if (!state || (root && !samePath(state.root, root))) return;
        this.workspaces.delete(userId);
        if (state.timer) clearInterval(state.timer);
        try {
            await state.pending;
        } catch (error) {
            console.warn(`[WorkflowTrigger] Failed to stop workspace ${state.root}:`, error);
        }
    }

    public async shutdown(): Promise<void> {
        this.closed = true;
        await Promise.all(Array.from(this.workspaces.keys(), (userId) => this.deactivate(userId)));
    }

    private scheduleTick(state: WorkspaceState): void {
        if (state.pending || this.workspaces.get(state.userId) !== state) return;
        const operation = this.tick(state).catch((error: unknown) => {
            console.warn(`[WorkflowTrigger] Failed to inspect workspace ${state.root}:`, error);
        });
        state.pending = operation;
        void operation.finally(() => {
            if (state.pending === operation) state.pending = undefined;
        });
    }

    private async refresh(state: WorkspaceState): Promise<void> {
        const registry = new WorkflowRegistry(state.root);
        const summaries = await registry.list();
        const next = new Map<string, TriggerState>();
        for (const summary of summaries) {
            try {
                const definition = await registry.loadDefinition(summary.path);
                if (!definition) continue;
                if (!definition.validation.ok) {
                    if (definition.document['x-workflow-triggers'] !== undefined) {
                        console.warn(`[WorkflowTrigger] Invalid workflow definition ${summary.path}:`, definition.validation.issues);
                    }
                    continue;
                }
                const parsed = parseWorkflowTriggers(definition.document['x-workflow-triggers']);
                if (parsed.issues.length) continue;
                const hash = workflowDefinitionHash(definition.yaml);
                for (const [index, trigger] of parsed.triggers.entries()) {
                    const id = `${summary.path}:${index}`;
                    const existing = state.triggers.get(id);
                    if (existing?.hash === hash) {
                        next.set(id, existing);
                        continue;
                    }
                    const entry: TriggerState = {
                        id,
                        name: summary.name,
                        path: summary.path,
                        hash,
                        trigger,
                        nextAt: Date.now() + (trigger.type === 'interval' ? trigger.everyMs : 0),
                        signatures: new Map(),
                        pending: false,
                    };
                    if (trigger.type === 'file') {
                        for (const file of trigger.paths) {
                            entry.signatures.set(file, await this.fileSignature(state.realRoot, file));
                        }
                    }
                    next.set(id, entry);
                }
            } catch (error) {
                console.warn(`[WorkflowTrigger] Failed to load ${summary.path}:`, error);
            }
        }
        if (this.workspaces.get(state.userId) !== state) return;
        state.triggers = next;
        state.nextRefresh = Date.now() + this.refreshIntervalMs;
    }

    private async tick(state: WorkspaceState): Promise<void> {
        if (Date.now() >= state.nextRefresh) await this.refresh(state);
        for (const entry of state.triggers.values()) {
            if (this.workspaces.get(state.userId) !== state) return;
            try {
                const now = Date.now();
                if (entry.trigger.type === 'interval') {
                    if (now < entry.nextAt) continue;
                    entry.nextAt = now + entry.trigger.everyMs;
                    await this.fire(state, entry);
                } else {
                    for (const file of entry.trigger.paths) {
                        const signature = await this.fileSignature(state.realRoot, file);
                        if (entry.signatures.get(file) !== signature) entry.pending = true;
                        entry.signatures.set(file, signature);
                    }
                    if (entry.pending && now >= entry.nextAt && await this.fire(state, entry)) {
                        entry.pending = false;
                        entry.nextAt = now + this.cooldownMs;
                    }
                }
                entry.lastError = undefined;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (entry.lastError !== message) {
                    console.warn(`[WorkflowTrigger] Trigger ${entry.id} failed:`, error);
                    entry.lastError = message;
                }
                // interval 已推进 nextAt，不应因异常缩短周期造成重试风暴
                if (entry.trigger.type === 'file') entry.nextAt = Date.now() + this.cooldownMs;
            }
        }
    }

    private async fire(state: WorkspaceState, entry: TriggerState): Promise<boolean> {
        if (entry.lastRunId) {
            const previous = await this.service.getRun({
                userId: state.userId, root: state.root, runId: entry.lastRunId,
            });
            if (previous && ['queued', 'running', 'waiting_approval'].includes(previous.status)) return false;
            entry.lastRunId = undefined;
        }
        if (this.workspaces.get(state.userId) !== state) return false;
        const result = await this.service.run({
            userId: state.userId,
            root: state.root,
            name: entry.name,
            path: entry.path,
            inputs: structuredClone(entry.trigger.inputs),
            trigger: { type: entry.trigger.type, id: entry.id },
        });
        if (!result.ok || !result.runId) {
            throw new Error(result.error || 'Triggered workflow did not return a run ID');
        }
        entry.lastRunId = result.runId;
        return true;
    }

    private async fileSignature(root: string, relative: string): Promise<string> {
        const candidate = path.resolve(root, relative);
        let probe = candidate;
        let exists = true;
        while (true) {
            try {
                const resolved = await fs.realpath(probe);
                const inside = path.relative(root, resolved);
                if (inside.startsWith('..') || path.isAbsolute(inside)) {
                    throw new Error(`触发器路径越出工作区: ${relative}`);
                }
                const segments = inside.split(path.sep).map((part) => part.toLowerCase());
                if (segments[0] === '.git' || (segments[0] === '.workflow' && segments[1] === '.runs')) {
                    throw new Error(`触发器路径不能指向运行记录或 Git 数据: ${relative}`);
                }
                break;
            } catch (error: unknown) {
                if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
                exists = false;
                const parent = path.dirname(probe);
                if (parent === probe) throw error;
                probe = parent;
            }
        }
        if (!exists) return 'missing';
        const stat = await fs.stat(candidate);
        if (!stat.isFile()) throw new Error(`触发器路径不是普通文件: ${relative}`);
        return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
    }
}
