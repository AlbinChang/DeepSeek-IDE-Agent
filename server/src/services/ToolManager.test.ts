import { describe, expect, it } from 'vitest';

import { ToolManager } from '@/services/ToolManager.js';

const createManager = () => {
    const manager = new ToolManager();
    manager.registerTool({
        name: 'multi_file_write',
        description: 'test batch writer',
        parameters: {
            type: 'object',
            properties: {
                files: {
                    type: 'array',
                    minItems: 2,
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string' },
                            content: { type: 'string' }
                        },
                        required: ['path', 'content']
                    }
                }
            },
            required: ['files']
        },
        execute: async () => ({ status: 'success' })
    });
    manager.registerTool({
        name: 'single_file_write',
        description: 'test single writer',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                content: { type: 'string' },
                encoding: { type: 'string' }
            },
            required: ['path', 'content']
        },
        execute: async () => ({ status: 'success' })
    });
    manager.registerTool({
        name: 'single_file_edit',
        description: 'test single editor',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                action: { type: 'string', enum: ['replace', 'insert'] },
                oldText: { type: 'string' },
                newText: { type: 'string' },
                startLine: { type: 'integer', minimum: 1 }
            },
            required: ['path', 'action', 'newText']
        },
        execute: async () => ({ status: 'success' })
    });
    manager.registerTool({
        name: 'browser_mcp_call',
        description: 'test browser mcp caller',
        parameters: {
            type: 'object',
            properties: {
                toolName: { type: 'string' },
                args: { type: 'object' }
            },
            required: ['toolName', 'args']
        },
        execute: async () => ({ status: 'success' })
    });
    return manager;
};

describe('ToolManager argument validation', () => {
    it('rejects multi_file_write when files is missing', async () => {
        await expect(createManager().executeTool('user', 'multi_file_write', {}, 'trace')).rejects.toThrow(
            'files 缺少必填字段'
        );
    });

    it('rejects multi_file_write when files is empty', async () => {
        await expect(createManager().executeTool('user', 'multi_file_write', { files: [] }, 'trace')).rejects.toThrow(
            'files 至少需要 2 项'
        );
    });

    it('rejects multi_file_write when only one file is provided', async () => {
        await expect(createManager().executeTool('user', 'multi_file_write', {
            files: [{ path: 'report.md', content: 'hello' }]
        }, 'trace')).rejects.toThrow(
            'files 至少需要 2 项'
        );
    });

    it('rejects multi_file_write items without path or content', async () => {
        await expect(createManager().executeTool('user', 'multi_file_write', { files: [{}] }, 'trace')).rejects.toThrow(
            'files[0].path 缺少必填字段'
        );
    });

    it('rejects single_file_write when content is missing', async () => {
        await expect(createManager().executeTool('user', 'single_file_write', {
            path: 'report.md'
        }, 'trace')).rejects.toThrow('content 缺少必填字段');
    });

    it('rejects single_file_edit when action is missing', async () => {
        await expect(createManager().executeTool('user', 'single_file_edit', {
            path: 'report.md',
            newText: 'hello'
        }, 'trace')).rejects.toThrow('action 缺少必填字段');
    });

    it('rejects single_file_edit when action is invalid', async () => {
        await expect(createManager().executeTool('user', 'single_file_edit', {
            path: 'report.md',
            action: 'delete',
            newText: ''
        }, 'trace')).rejects.toThrow('action');
    });

    it('rejects browser_mcp_call when toolName is missing', async () => {
        await expect(createManager().executeTool('user', 'browser_mcp_call', {}, 'trace')).rejects.toThrow(
            'toolName 缺少必填字段'
        );
    });

    it('rejects browser_mcp_call when args is missing', async () => {
        await expect(createManager().executeTool('user', 'browser_mcp_call', {
            toolName: 'browser_snapshot'
        }, 'trace')).rejects.toThrow('args 缺少必填字段');
    });
});