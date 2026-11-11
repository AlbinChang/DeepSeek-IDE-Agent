import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import type {
    WorkflowEvent,
    WorkflowRunInfo,
    WorkflowRunQuery,
    WorkflowRunStatus,
} from '@/workflow/types.js';

const RUNS_DIRECTORY = path.join('.workflow', '.runs');
const RUN_ID_PATTERN = /^wf-[a-z0-9]+-[a-z0-9]+$/;
const MAX_SANITIZE_DEPTH = 6;
const MAX_SANITIZE_KEYS = 100;

const SECRET_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isSecretKey(key: string): boolean {
    if (/api[-_]?key|authorization|password|secret|cookie/i.test(key)) return true;
    const normalized = key.replace(/[-_]/g, '').toLowerCase();
    return ['token', 'accesstoken', 'refreshtoken', 'authtoken', 'idtoken', 'bearertoken'].includes(normalized);
}

export function sanitizeForStore(value: unknown, maxStringChars: number, depth = 0): unknown {
    if (typeof value === 'string') {
        const masked = value.replace(SECRET_PATTERN, 'sk-***');
        if (masked.length <= maxStringChars) return masked;
        return `${masked.slice(0, maxStringChars)}…[truncated ${masked.length - maxStringChars} chars]`;
    }
    if (value === null || value === undefined || typeof value !== 'object') return value;
    if (depth >= MAX_SANITIZE_DEPTH) return '[max-depth]';
    if (Array.isArray(value)) {
        return value.slice(0, MAX_SANITIZE_KEYS).map((item) => sanitizeForStore(item, maxStringChars, depth + 1));
    }

    const result: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, MAX_SANITIZE_KEYS)) {
        if (FORBIDDEN_OBJECT_KEYS.has(key)) continue;
        if (isSecretKey(key)) {
            result[key] = entry ? '******' : entry;
            continue;
        }
        result[key] = sanitizeForStore(entry, maxStringChars, depth + 1);
    }
    return result;
}

export function isValidRunId(runId: string): boolean {
    return typeof runId === 'string' && RUN_ID_PATTERN.test(runId);
}

function isSamePath(left: string, right: string): boolean {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export class WorkflowRunStore {
    constructor(private readonly root: string) {}

    public get runsDirectory(): string {
        return path.join(this.root, RUNS_DIRECTORY);
    }

    public newRunId(): string {
        return `wf-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    }

    public getRunDirectory(runId: string): string {
        if (!isValidRunId(runId)) {
            throw new Error(`Invalid workflow runId: ${runId}`);
        }
        return path.join(this.runsDirectory, runId);
    }

    public async create(snapshot: WorkflowRunInfo): Promise<void> {
        const directory = this.getRunDirectory(snapshot.runId);
        await fs.mkdir(path.join(directory, 'artifacts'), { recursive: true });
        await this.writeSnapshot(snapshot);
    }

    public async save(snapshot: WorkflowRunInfo): Promise<void> {
        await fs.mkdir(this.getRunDirectory(snapshot.runId), { recursive: true });
        await this.writeSnapshot(snapshot);
    }

    public async read(runId: string): Promise<WorkflowRunInfo | null> {
        let raw: string;
        try {
            raw = await fs.readFile(path.join(this.getRunDirectory(runId), 'run.json'), 'utf8');
        } catch (error: any) {
            if (error?.code === 'ENOENT') return null;
            throw error;
        }
        try {
            const parsed = JSON.parse(raw) as WorkflowRunInfo;
            if (!parsed || parsed.runId !== runId || parsed.schemaVersion !== 1) return null;
            return parsed;
        } catch {
            return null;
        }
    }

    public async list(query: WorkflowRunQuery = {}): Promise<WorkflowRunInfo[]> {
        let entries: Dirent[];
        try {
            entries = await fs.readdir(this.runsDirectory, { withFileTypes: true });
        } catch (error: any) {
            if (error?.code === 'ENOENT') return [];
            throw error;
        }

        const runs: WorkflowRunInfo[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
            const run = await this.read(entry.name);
            if (!run) continue;
            if (query.userId && run.userId !== query.userId) continue;
            if (query.root && !isSamePath(run.root, query.root)) continue;
            if (query.status && run.status !== query.status) continue;
            runs.push(run);
        }
        runs.sort((left, right) => right.createdAt - left.createdAt);
        return runs;
    }

    public async appendEvent(runId: string, event: WorkflowEvent): Promise<void> {
        const directory = this.getRunDirectory(runId);
        await fs.mkdir(directory, { recursive: true });
        await fs.appendFile(path.join(directory, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
    }

    public async readEvents(runId: string, limit = 500): Promise<WorkflowEvent[]> {
        let raw: string;
        try {
            raw = await fs.readFile(path.join(this.getRunDirectory(runId), 'events.jsonl'), 'utf8');
        } catch (error: any) {
            if (error?.code === 'ENOENT') return [];
            throw error;
        }
        const lines = raw.split(/\r?\n/).filter(Boolean);
        const selected = lines.slice(-Math.max(1, limit));
        const events: WorkflowEvent[] = [];
        for (const line of selected) {
            try {
                events.push(JSON.parse(line) as WorkflowEvent);
            } catch {
                // 单行损坏不影响其余事件
            }
        }
        return events;
    }

    /**
     * 清理已结束的 run：排队/运行中/等待审批的记录永不删除；
     * failed/cancelled/succeeded/interrupted 只保留最新的 maxRuns 条，避免中断记录无限增长。
     */
    public async prune(maxRuns: number): Promise<number> {
        const runs = await this.list();
        const active: WorkflowRunStatus[] = ['queued', 'running', 'waiting_approval'];
        const removable = runs
            .filter((run) => !active.includes(run.status))
            .sort((left, right) => right.createdAt - left.createdAt);
        const keep = new Set(runs.filter((run) => active.includes(run.status)).map((run) => run.runId));
        for (const run of removable.slice(0, Math.max(0, maxRuns - keep.size))) {
            keep.add(run.runId);
        }

        let removed = 0;
        for (const run of runs) {
            if (keep.has(run.runId)) continue;
            await fs.rm(this.getRunDirectory(run.runId), { recursive: true, force: true });
            removed++;
        }
        return removed;
    }

    public async delete(runId: string): Promise<void> {
        await fs.rm(this.getRunDirectory(runId), { recursive: true, force: true });
    }

    private async writeSnapshot(snapshot: WorkflowRunInfo): Promise<void> {
        const target = path.join(this.getRunDirectory(snapshot.runId), 'run.json');
        const temporary = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
        await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2), 'utf8');
        try {
            for (let attempt = 0; ; attempt++) {
                try {
                    await fs.rename(temporary, target);
                    break;
                } catch (error) {
                    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
                    if (attempt >= 2 || !['EPERM', 'EBUSY', 'EACCES'].includes(String(code))) throw error;
                    await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
                }
            }
        } catch (error) {
            try {
                await fs.rm(temporary, { force: true });
            } catch (cleanupError) {
                console.warn('[WorkflowRunStore] Failed to remove temporary snapshot:', cleanupError);
            }
            throw error;
        }
    }
}
