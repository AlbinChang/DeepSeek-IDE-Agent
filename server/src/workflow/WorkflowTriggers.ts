import * as path from 'node:path';

import { parseDurationMs } from '@/workflow/expressions.js';
import type { WorkflowValidationIssue } from '@/workflow/types.js';

export type WorkflowTrigger =
    | { type: 'interval'; everyMs: number; inputs: Record<string, unknown> }
    | { type: 'file'; paths: string[]; inputs: Record<string, unknown> };

export function parseWorkflowTriggers(value: unknown): {
    triggers: WorkflowTrigger[];
    issues: WorkflowValidationIssue[];
} {
    const triggers: WorkflowTrigger[] = [];
    const issues: WorkflowValidationIssue[] = [];
    if (value === undefined) return { triggers, issues };
    if (!Array.isArray(value) || value.length > 20) {
        return {
            triggers,
            issues: [{ path: '/x-workflow-triggers', message: '触发器必须是最多 20 项的数组', severity: 'error' }],
        };
    }
    value.forEach((entry: unknown, index: number) => {
        const pointer = `/x-workflow-triggers/${index}`;
        const issue = (message: string) => issues.push({ path: pointer, message, severity: 'error' });
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            issue('触发器必须是对象');
            return;
        }
        const record = entry as Record<string, unknown>;
        if (record.inputs !== undefined && (!record.inputs || typeof record.inputs !== 'object' || Array.isArray(record.inputs))) {
            issue('触发器 inputs 必须是对象');
            return;
        }
        const inputs = (record.inputs || {}) as Record<string, unknown>;
        if (record.type === 'interval') {
            const everyMs = parseDurationMs(record.every);
            if (everyMs === undefined || !Number.isSafeInteger(everyMs) || everyMs < 1000 || everyMs > 365 * 86_400_000) {
                issue('interval 的 every 必须是 1 秒至 365 天的时间');
                return;
            }
            triggers.push({ type: 'interval', everyMs, inputs });
            return;
        }
        if (record.type === 'file') {
            if (!Array.isArray(record.paths) || record.paths.length === 0 || record.paths.length > 50) {
                issue('file 的 paths 必须包含 1–50 个工作区相对文件路径');
                return;
            }
            const paths: string[] = [];
            for (const raw of record.paths) {
                if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0') || /[:*?[\]{}]/.test(raw)
                    || path.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
                    issue('file 路径必须是无通配符的工作区相对文件路径');
                    return;
                }
                const normalized = raw.replace(/\\/g, '/');
                const parts = normalized.split('/');
                if (parts.some((part) => !part || part === '.' || part === '..')
                    || parts[0].toLowerCase() === '.git'
                    || (parts[0].toLowerCase() === '.workflow' && parts[1]?.toLowerCase() === '.runs')) {
                    issue('file 路径不能越出工作区或指向 .git / .workflow/.runs');
                    return;
                }
                paths.push(normalized);
            }
            triggers.push({ type: 'file', paths, inputs });
            return;
        }
        issue('触发器 type 必须是 interval 或 file');
    });
    return { triggers, issues };
}
