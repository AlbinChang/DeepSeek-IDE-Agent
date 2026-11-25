/**
 * Workflow 步骤的工具权限策略（单一真值来源）。
 *
 * 执行器用它裁剪 `with.tools`，编译检查用它提前告警/报错，
 * 避免「配置里写了但运行时被静默丢弃」的语义漂移。
 */

import { resolveToolName } from '@/tools/toolNames.js';

export const READONLY_AGENT_TOOLS = [
    'read_skill',
    'read_file',
    'read_file_by_byte',
    'list_files',
    'calculate',
    'check_svg',
];

export const READONLY_EVALUATOR_TOOLS = [
    'read_skill',
    'read_file',
    'read_file_by_byte',
    'list_files',
    'check_svg',
];

/** 禁止在 workflow 内部递归/管理的工具 */
export const FORBIDDEN_WORKFLOW_TOOLS = new Set([
    'list_workflows',
    'get_workflow',
    'validate_workflow',
    'run_workflow',
    'get_workflow_run',
    'cancel_workflow',
    'resume_workflow',
]);

/** v1 禁止 workflow 内部写全局 TODO SSOT */
export const FORBIDDEN_TODO_WRITE_TOOLS = new Set(['append_todo', 'update_todo', 'delete_todo']);

/** evaluator 永久只读：即使显式声明也不授予写能力 */
export const EVALUATOR_FORBIDDEN_WRITE_TOOLS = [
    'write_file',
    'delete_path',
    'replace_in_file',
    'insert_in_file',
    'replace_all_in_file',
    'run_powershell_command',
    'run_cmd_command',
];

/** 历史（宾+动）工具名统一转成规范（动+宾）名，保证老工作流仍能执行。 */
function normalizeRequested(requested?: string[]): string[] | undefined {
    return requested?.map((name) => resolveToolName(name));
}

export function resolveAgentTools(requested?: string[]): ReadonlySet<string> {
    const normalized = normalizeRequested(requested);
    const tools = new Set(normalized && normalized.length > 0 ? normalized : READONLY_AGENT_TOOLS);
    for (const name of FORBIDDEN_WORKFLOW_TOOLS) tools.delete(name);
    for (const name of FORBIDDEN_TODO_WRITE_TOOLS) tools.delete(name);
    return tools;
}

export function resolveEvaluatorTools(requested?: string[]): ReadonlySet<string> {
    const normalized = normalizeRequested(requested);
    const tools = new Set(normalized && normalized.length > 0 ? normalized : READONLY_EVALUATOR_TOOLS);
    for (const name of FORBIDDEN_WORKFLOW_TOOLS) tools.delete(name);
    for (const name of FORBIDDEN_TODO_WRITE_TOOLS) tools.delete(name);
    for (const name of EVALUATOR_FORBIDDEN_WRITE_TOOLS) tools.delete(name);
    return tools;
}
