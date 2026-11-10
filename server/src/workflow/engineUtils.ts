import * as path from 'node:path';

import { sanitizeForStore } from '@/workflow/WorkflowRunStore.js';
import type {
    WorkflowCheckpoint,
    WorkflowDefinition,
    WorkflowStepInfo,
} from '@/workflow/types.js';

export function samePath(left: string, right: string): boolean {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function buildInitialSteps(steps: Record<string, any>[], basePath = '/do'): WorkflowStepInfo[] {
    return steps.map((entry, index) => {
        const name = (entry && typeof entry === 'object' && Object.keys(entry)[0]) || `step-${index}`;
        return {
            path: `${basePath}/${index}/${name}`,
            name,
            status: 'pending',
            attempts: 0,
        };
    });
}

export function resolveApprovalDecision(decision: unknown): boolean | undefined {
    if (decision === undefined || decision === null) return undefined;
    if (typeof decision === 'boolean') return decision;
    if (typeof decision === 'string') {
        const normalized = decision.trim().toLowerCase();
        if (['approve', 'approved', 'yes', 'ok', 'accept'].includes(normalized)) return true;
        if (['reject', 'rejected', 'no', 'deny', 'cancel'].includes(normalized)) return false;
        return undefined;
    }
    if (typeof decision === 'object') {
        const record = decision as Record<string, unknown>;
        if (typeof record.approved === 'boolean') return record.approved;
        if (typeof record.decision === 'string') return resolveApprovalDecision(record.decision);
    }
    return undefined;
}

export type PrepareWorkflowInputsResult =
    | { ok: true; inputs: Record<string, unknown> }
    | { ok: false; error: string };

/**
 * 合并 inputs、补默认值、校验必填与序列化大小。
 * 主进程/standalone/测试共用，保证准入规则一致。
 */
export function prepareWorkflowInputs(
    definition: WorkflowDefinition,
    rawInputs: Record<string, unknown> | undefined,
): PrepareWorkflowInputsResult {
    const inputs: Record<string, unknown> = { ...(rawInputs || {}) };
    try {
        if (JSON.stringify(inputs).length > 256 * 1024) {
            return { ok: false, error: 'WORKFLOW_INPUTS_TOO_LARGE' };
        }
    } catch {
        return { ok: false, error: 'WORKFLOW_INPUTS_NOT_SERIALIZABLE' };
    }

    for (const input of definition.summary.inputs) {
        if (inputs[input.name] !== undefined) continue;
        if (input.default !== undefined) {
            inputs[input.name] = input.default;
        } else if (input.required) {
            return { ok: false, error: `Missing required input: ${input.name}` };
        }
    }
    return { ok: true, inputs };
}

export function buildCheckpoint(
    nextStepIndex: number,
    context: Record<string, unknown>,
    steps: WorkflowStepInfo[],
    maxStringChars: number,
): WorkflowCheckpoint {
    return {
        nextStepIndex,
        context: sanitizeForStore(context, maxStringChars) as Record<string, unknown>,
        completedPaths: steps.filter((step) => step.status === 'succeeded').map((step) => step.path),
    };
}
