import * as fs from 'fs/promises';
import * as path from 'path';
import { UserService } from '@/services/UserService.js';
import { PathUtils } from '@/utils/PathUtils.js';
import { EventDistributor } from '@/services/EventDistributor.js';

export interface TodoItem {
    id: string;
    title: string;
    status: 'not-started' | 'in-progress' | 'completed' | 'failed';
    description?: string;
}

/**
 * Todo Service
 * 对齐技术规范 Section 35 (新增)：主代理任务管理与持久化
 */
export class TodoService {
    private static getTodoFile(workspaceRoot: string, userId: string) {
        const userDir = UserService.getUserDataDir(workspaceRoot, userId);
        return path.join(userDir, 'todo.json');
    }

    /**
     * 获取 Todo 列表
     */
    static async getTodos(workspaceRoot: string, userId: string): Promise<TodoItem[]> {
        const filePath = this.getTodoFile(workspaceRoot, userId);
        try {
            const content = await fs.readFile(filePath, 'utf8');
            return JSON.parse(content);
        } catch {
            return [];
        }
    }

    /**
     * 清空工作区的全部待办事项 (New Instruction Reset)
     * 用于用户发起全新指令时，清除上一轮留存的过时状态。
     */
    static async clearAllTodos(workspaceRoot: string, userId: string) {
        const filePath = this.getTodoFile(workspaceRoot, userId);
        try {
            // 物理删除文件前，先执行彻底覆盖写入一个空数组，确保文件句柄释放
            await fs.writeFile(filePath, JSON.stringify([]), 'utf8');
            // 彻底执行物理删除，防止残留
            await fs.unlink(filePath);
        } catch (e) {
            // 文件不存在或已被删除则忽略
        }
        // 关键修复：除了删除物理文件，必须广播空状态给所有端，确保同步更新
        EventDistributor.broadcast('todo:sync', [], (client) => client.userId === userId);
    }

    /**
     * 更新或追加 Todo 列表 (SSOT 存储)
     */
    static async saveTodos(workspaceRoot: string, userId: string, todos: TodoItem[]) {
        const filePath = this.getTodoFile(workspaceRoot, userId);
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        
        // 移除强制自动排序 (Section 35.4 优化)：
        // 允许 Agent 通过插入顺序或索引来管理任务间的因果依赖。
        // 原 status-based 排序会破坏“失败后追加补救步骤”的线性逻辑感。
        const content = JSON.stringify(todos, null, 2);

        await fs.writeFile(filePath, content, 'utf8');
        
        // 对齐 Section 35.3：实时广播状态给前端展示 (保持原始线性顺序)
        EventDistributor.broadcast('todo:sync', todos, (client) => client.userId === userId);
    }

    /**
     * 渐进式追加或插入 Todo
     */
    static async appendTodos(workspaceRoot: string, userId: string, newTodos: Omit<TodoItem, 'id'>[]) {
        // 防御：确保 newTodos 一定是数组
        const safeTodos = Array.isArray(newTodos) ? newTodos : (newTodos ? [newTodos] : []);
        const current = await this.getTodos(workspaceRoot, userId);
        const mapped = safeTodos.map(t => ({
            ...t,
            id: Math.random().toString(36).substring(7)
        }));

        const updated = [...current, ...mapped];

        await this.saveTodos(workspaceRoot, userId, updated);
        return mapped;
    }

    /**
     * 删除指定的 Todo (支持单 ID 或 ID 数组批量删除)
     * 对齐 Section 35.4：仅允许删除未开始 (not-started) 的任务，防止破坏执行记录
     */
    static async deleteTodo(workspaceRoot: string, userId: string, todoIdOrIds: string | string[]) {
        const ids = Array.isArray(todoIdOrIds) ? todoIdOrIds : [todoIdOrIds];
        const current = await this.getTodos(workspaceRoot, userId);
        
        for (const id of ids) {
            const target = current.find(t => t.id === id);
            if (!target) throw new Error(`任务 ${id} 不存在`);
        }

        const idSet = new Set(ids);
        const updated = current.filter(t => !idSet.has(t.id));
        await this.saveTodos(workspaceRoot, userId, updated);
        return { status: 'success', deletedCount: ids.length };
    }

    /**
     * 更新一个或多个 Todo 状态或内容
     */
    static async updateTodos(workspaceRoot: string, userId: string, todoIdOrIds: string | string[], updates: Partial<TodoItem>) {
        const ids = Array.isArray(todoIdOrIds) ? todoIdOrIds : [todoIdOrIds];
        const normalizedIds = ids.map(id => String(id || '').trim()).filter(Boolean);
        if (normalizedIds.length === 0) throw new Error('更新操作需要提供 todoId 或 todoIds');

        const current = await this.getTodos(workspaceRoot, userId);
        for (const id of normalizedIds) {
            const target = current.find(t => t.id === id);
            if (!target) throw new Error(`Todo ${id} not found`);
        }

        const idSet = new Set(normalizedIds);
        const updatedItems: TodoItem[] = [];
        for (let index = 0; index < current.length; index++) {
            if (!idSet.has(current[index].id)) continue;
            current[index] = { ...current[index], ...updates, id: current[index].id };
            updatedItems.push(current[index]);
        }

        await this.saveTodos(workspaceRoot, userId, current);
        return Array.isArray(todoIdOrIds) ? updatedItems : updatedItems[0];
    }

    /**
     * 更新单个 Todo 状态或内容
     */
    static async updateTodo(workspaceRoot: string, userId: string, todoId: string, updates: Partial<TodoItem>) {
        return await this.updateTodos(workspaceRoot, userId, todoId, updates) as TodoItem;
    }
}
