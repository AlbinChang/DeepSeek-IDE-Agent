import { TodoService } from '@/services/TodoService.js';

/**
 * Todo 工具集 (Task Management Tools)
 * 对齐技术规范 Section 35：主代理任务管理与持久化
 *
 * 原子化设计：每个工具只做一件事，不再通过 operation 参数分发。
 * - list_todos: 读取当前任务清单
 * - append_todo: 追加新任务
 * - update_todo: 更新已有任务
 * - delete_todo: 删除任务
 */
export class TodoTools {
    constructor(private workspaceRoot: string) {}

    private guardBackgroundService(context: any) {
        if (context?.isBackgroundService) {
            throw new Error('权限越界：后台服务不可直接操作系统级任务清单。');
        }
    }

    private normalizeTodos(raw: any): any[] {
        if (!raw) return [];
        return Array.isArray(raw) ? raw : [raw];
    }

    private async totalCount(userId: string): Promise<number> {
        const todos = await TodoService.getTodos(this.workspaceRoot, userId);
        return todos.length;
    }

    // ─── 原子操作实现 ───────────────────────────────────────

    async listTodos(context: any) {
        this.guardBackgroundService(context);
        const userId = context?.userId || 'system';
        const todos = await TodoService.getTodos(this.workspaceRoot, userId);
        return { todos, total: todos.length };
    }

    async appendTodo(params: any, context: any) {
        this.guardBackgroundService(context);
        const userId = context?.userId || 'system';
        const normalizedTodos = this.normalizeTodos(params.todos);
        if (!normalizedTodos.length) throw new Error('append_todo 需要提供 todos 数组，每项至少包含 title');
        const appended = await TodoService.appendTodos(this.workspaceRoot, userId, normalizedTodos);
        const total = await this.totalCount(userId);
        return { status: 'success', appended, total };
    }

    async updateTodo(params: any, context: any) {
        this.guardBackgroundService(context);
        const userId = context?.userId || 'system';
        const normalizedTodos = this.normalizeTodos(params.todos);
        if (!normalizedTodos.length) throw new Error('update_todo 需要提供 todos 数组，每项至少包含 id');
        const updated: any[] = [];
        for (const item of normalizedTodos) {
            if (!item.id) throw new Error('update_todo 每项必须提供 id');
            const { id, ...updates } = item;
            const result = await TodoService.updateTodo(this.workspaceRoot, userId, id, updates);
            updated.push(result);
        }
        const total = await this.totalCount(userId);
        return { status: 'success', updated: updated.length === 1 ? updated[0] : updated, total };
    }

    async deleteTodo(params: any, context: any) {
        this.guardBackgroundService(context);
        const userId = context?.userId || 'system';
        // 原子化：统一使用 ids 参数（接受字符串或数组）
        const rawIds = params.ids;
        const ids: string[] = !rawIds ? [] : Array.isArray(rawIds) ? rawIds : [rawIds];
        if (!ids.length) throw new Error('delete_todo 需要提供 ids（任务 ID 字符串或字符串数组）');
        const deletion = await TodoService.deleteTodo(this.workspaceRoot, userId, ids);
        const total = await this.totalCount(userId);
        const deletedCount = Array.isArray(deletion) ? deletion.length : (deletion ? 1 : 0);
        return { status: 'success', deleted: deletedCount, total };
    }

    // ─── 原子工具定义 ───────────────────────────────────────

    static getDefinitions() {
        return [
            {
                name: 'list_todos',
                description: '读取当前任务清单（SSOT）。仅顶层 Agent 有权访问。当状态不清晰或历史被裁剪时优先调用此工具获取最新清单。',
                parameters: {
                    type: 'object',
                    properties: {},
                    required: []
                }
            },
            {
                name: 'append_todo',
                description: '向任务清单追加新任务。每项提供 title（必填）、status（可选，默认 not-started）、description（可选）。系统自动分配 id。返回追加的任务摘要及总数，需完整清单时调用 list_todos。',
                parameters: {
                    type: 'object',
                    properties: {
                        todos: {
                            type: 'array',
                            description: '待追加的任务数组。每项含 title（必填）、status/description（可选）。严禁传空数组。',
                            items: {
                                type: 'object',
                                properties: {
                                    title: { type: 'string', description: '简明操作目标。' },
                                    status: { type: 'string', enum: ['not-started', 'in-progress', 'completed', 'failed'], description: '任务状态，默认 not-started。' },
                                    description: { type: 'string', description: '执行说明或预期结论。' }
                                },
                                required: ['title']
                            }
                        }
                    },
                    required: ['todos']
                }
            },
            {
                name: 'update_todo',
                description: '⚠️ todos 为必填参数，不可省略！更新已有任务的状态或描述。每项必须提供 id 及待更新字段（status/description）。每项独立更新，不同结论自然拆分为不同数组元素。返回更新摘要及总数，需完整清单时调用 list_todos。',
                parameters: {
                    type: 'object',
                    properties: {
                        todos: {
                            type: 'array',
                            description: '待更新的任务数组。每项必须含 id，及至少一个待更新字段（status/description）。',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string', description: '任务 ID（必填）。' },
                                    status: { type: 'string', enum: ['not-started', 'in-progress', 'completed', 'failed'], description: '更新后的任务状态。' },
                                    description: { type: 'string', description: '更新后的执行说明或结论。' }
                                },
                                required: ['id']
                            }
                        }
                    },
                    required: ['todos']
                }
            },
            {
                name: 'delete_todo',
                description: '⚠️ ids 为必填参数，不可省略！删除指定任务。通过 ids 参数传入一个或多个任务 ID。返回删除数量及剩余总数，需完整清单时调用 list_todos。',
                parameters: {
                    type: 'object',
                    properties: {
                        ids: {
                            description: '待删除的任务 ID。可以是单个 ID 字符串或 ID 字符串数组。',
                            anyOf: [
                                { type: 'string' },
                                { type: 'array', items: { type: 'string' } }
                            ]
                        }
                    },
                    required: ['ids']
                }
            }
        ];
    }
}
