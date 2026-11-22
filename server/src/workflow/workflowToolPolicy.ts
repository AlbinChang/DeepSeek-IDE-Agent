/**
 * Workflow 步骤的工具权限策略（单一真值来源）。
 *
 * 执行器用它裁剪 `with.tools`，编译检查用它提前告警/报错，
 * 避免「配置里写了但运行时被静默丢弃」的语义漂移。
 */

export const READONLY_AGENT_TOOLS = [
    'read_skill',
    'read_file',
    'read_file_by_byte',
    'list_files',
    'calculate',
];

export const READONLY_EVALUATOR_TOOLS = [
    'read_skill',
    'read_file',
    'read_file_by_byte',
    'list_files',
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
    'file_write',
    'delete_path',
    'file_replace',
    'file_insert',
    'file_replace_all',
    'run_powershell_command',
    'run_cmd_command',
];

export function resolveAgentTools(requested?: string[]): ReadonlySet<string> {
    const tools = new Set(requested && requested.length > 0 ? requested : READONLY_AGENT_TOOLS);
    for (const name of FORBIDDEN_WORKFLOW_TOOLS) tools.delete(name);
    for (const name of FORBIDDEN_TODO_WRITE_TOOLS) tools.delete(name);
    return tools;
}

export function resolveEvaluatorTools(requested?: string[]): ReadonlySet<string> {
    const tools = new Set(requested && requested.length > 0 ? requested : READONLY_EVALUATOR_TOOLS);
    for (const name of FORBIDDEN_WORKFLOW_TOOLS) tools.delete(name);
    for (const name of FORBIDDEN_TODO_WRITE_TOOLS) tools.delete(name);
    for (const name of EVALUATOR_FORBIDDEN_WRITE_TOOLS) tools.delete(name);
    return tools;
}
