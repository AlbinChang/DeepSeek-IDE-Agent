import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import { TodoService } from '@/services/TodoService.js';
import { TodoTools } from '@/tools/TodoTools.js';

describe('TodoTools atomic tool contract', () => {
    it('update_todo supports batch update via todos array with per-item updates', async () => {
        const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-tools-'));
        const userId = 'test-user';
        try {
            await TodoService.saveTodos(workspaceRoot, userId, [
                { id: 'first', title: 'First task', status: 'in-progress' },
                { id: 'second', title: 'Second task', status: 'not-started' },
                { id: 'third', title: 'Third task', status: 'not-started' },
            ]);

            const tool = new TodoTools(workspaceRoot);
            const result: any = await tool.updateTodo({
                todos: [
                    { id: 'first', status: 'completed', description: '第一项完成' },
                    { id: 'second', status: 'failed', description: '第二项失败' },
                ]
            }, { userId });

            expect(Array.isArray(result.updated)).toBe(true);
            expect(result.updated.length).toBe(2);
            expect(result.total).toBe(3);

            // 验证数据实际已持久化
            const savedTodos = await TodoService.getTodos(workspaceRoot, userId);
            expect(savedTodos.find((todo: any) => todo.id === 'first')?.status).toBe('completed');
            expect(savedTodos.find((todo: any) => todo.id === 'first')?.description).toBe('第一项完成');
            expect(savedTodos.find((todo: any) => todo.id === 'second')?.status).toBe('failed');
            expect(savedTodos.find((todo: any) => todo.id === 'second')?.description).toBe('第二项失败');
            expect(savedTodos.find((todo: any) => todo.id === 'third')?.status).toBe('not-started');
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('update_todo supports single update via todos array with one item', async () => {
        const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-tools-'));
        const userId = 'test-user';
        try {
            await TodoService.saveTodos(workspaceRoot, userId, [
                { id: 'single', title: 'Single task', status: 'in-progress' },
            ]);

            const tool = new TodoTools(workspaceRoot);
            const result: any = await tool.updateTodo({
                todos: [
                    { id: 'single', status: 'failed', description: '单项失败结论' }
                ]
            }, { userId });

            expect(result.total).toBe(1);
            expect(result.updated.id).toBe('single');
            expect(result.updated.status).toBe('failed');
            expect(result.updated.description).toBe('单项失败结论');
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('delete_todo supports batch delete via ids array', async () => {
        const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-tools-'));
        const userId = 'test-user';
        try {
            await TodoService.saveTodos(workspaceRoot, userId, [
                { id: 'a', title: 'Task A', status: 'completed' },
                { id: 'b', title: 'Task B', status: 'not-started' },
                { id: 'c', title: 'Task C', status: 'not-started' },
            ]);

            const tool = new TodoTools(workspaceRoot);
            const result: any = await tool.deleteTodo({
                ids: ['a', 'b']
            }, { userId });

            expect(result.deleted).toBe(2);
            expect(result.total).toBe(1);

            // 验证数据实际已持久化
            const savedTodos = await TodoService.getTodos(workspaceRoot, userId);
            expect(savedTodos).toHaveLength(1);
            expect(savedTodos[0].id).toBe('c');
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('delete_todo supports single delete via ids string', async () => {
        const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-tools-'));
        const userId = 'test-user';
        try {
            await TodoService.saveTodos(workspaceRoot, userId, [
                { id: 'x', title: 'Task X', status: 'not-started' },
                { id: 'y', title: 'Task Y', status: 'not-started' },
            ]);

            const tool = new TodoTools(workspaceRoot);
            const result: any = await tool.deleteTodo({
                ids: 'x'
            }, { userId });

            expect(result.deleted).toBe(1);
            expect(result.total).toBe(1);

            // 验证数据实际已持久化
            const savedTodos = await TodoService.getTodos(workspaceRoot, userId);
            expect(savedTodos).toHaveLength(1);
            expect(savedTodos[0].id).toBe('y');
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('documents atomic design: no operation parameter, each tool is single-purpose', () => {
        const definitions = TodoTools.getDefinitions();
        const toolNames = definitions.map(d => d.name);

        // 4 个原子工具
        expect(toolNames).toEqual([
            'list_todos',
            'append_todo',
            'update_todo',
            'delete_todo'
        ]);

        // 每个工具都没有 operation 参数
        for (const def of definitions) {
            const paramKeys = Object.keys(def.parameters.properties);
            expect(paramKeys).not.toContain('operation');
        }

        // list_todos 无必填参数
        const listDef = definitions.find(d => d.name === 'list_todos')!;
        expect(listDef.parameters.required).toEqual([]);

        // append_todo 需要 todos
        const appendDef = definitions.find(d => d.name === 'append_todo')!;
        expect(appendDef.parameters.required).toContain('todos');

        // update_todo 需要 todos
        const updateDef = definitions.find(d => d.name === 'update_todo')!;
        expect(updateDef.parameters.required).toContain('todos');

        // delete_todo 需要 ids（而非 id 单数形式）
        const deleteDef = definitions.find(d => d.name === 'delete_todo')!;
        expect(deleteDef.parameters.required).toContain('ids');
        expect(Object.keys(deleteDef.parameters.properties)).not.toContain('id');
        expect(Object.keys(deleteDef.parameters.properties)).not.toContain('todos');
    });

    it('rejects todo operations from background services', async () => {
        const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-tools-'));
        try {
            const tool = new TodoTools(workspaceRoot);
            const bgCtx = { userId: 'test-user', isBackgroundService: true };

            await expect(tool.listTodos(bgCtx)).rejects.toThrow(
                '权限越界：后台服务不可直接操作系统级任务清单。'
            );
            await expect(tool.appendTodo({ todos: [{ title: 'test' }] }, bgCtx)).rejects.toThrow(
                '权限越界：后台服务不可直接操作系统级任务清单。'
            );
            await expect(tool.updateTodo({ todos: [{ id: 'x', status: 'completed' }] }, bgCtx)).rejects.toThrow(
                '权限越界：后台服务不可直接操作系统级任务清单。'
            );
            await expect(tool.deleteTodo({ ids: 'x' }, bgCtx)).rejects.toThrow(
                '权限越界：后台服务不可直接操作系统级任务清单。'
            );
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('rejects update_todo with empty todos array', async () => {
        const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-tools-'));
        try {
            const tool = new TodoTools(workspaceRoot);
            await expect(tool.updateTodo({ todos: [] }, { userId: 'test-user' })).rejects.toThrow(
                'update_todo 需要提供 todos 数组'
            );
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('rejects delete_todo with empty ids', async () => {
        const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-tools-'));
        try {
            const tool = new TodoTools(workspaceRoot);
            await expect(tool.deleteTodo({ ids: [] }, { userId: 'test-user' })).rejects.toThrow(
                'delete_todo 需要提供 ids'
            );
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('returns warning when list_todos is called with accidental todos parameter', async () => {
        const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-tools-'));
        try {
            const tool = new TodoTools(workspaceRoot);
            const result: any = await tool.listTodos({
                todos: [{ title: 'Accidental todo' }]
            }, { userId: 'test-user' });

            expect(result.todos).toEqual([]);
            expect(result.total).toBe(0);
            expect(result.warning).toContain('list_todos 是纯只读查询工具');
        } finally {
            await fs.rm(workspaceRoot, { recursive: true, force: true });
        }
    });
});
