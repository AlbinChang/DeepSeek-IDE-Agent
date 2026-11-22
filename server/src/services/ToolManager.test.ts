import { describe, expect, it } from 'vitest';

import { ToolManager } from '@/services/ToolManager.js';

const createManager = () => {
    const manager = new ToolManager();
    manager.registerTool({
        name: 'write_file',
        description: 'test file writer',
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
        name: 'replace_in_file',
        description: 'test file replacer',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                oldText: { type: 'string' },
                newText: { type: 'string' }
            },
            required: ['path', 'oldText', 'newText']
        },
        execute: async () => ({ status: 'success' })
    });
    manager.registerTool({
        name: 'insert_in_file',
        description: 'test file inserter',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                startLine: { type: 'integer', minimum: 1 },
                newText: { type: 'string' }
            },
            required: ['path', 'startLine', 'newText']
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
    it('rejects write_file when content is missing', async () => {
        await expect(createManager().executeTool('user', 'write_file', {
            path: 'report.md'
        }, 'trace')).rejects.toThrow('content 缺少必填字段');
    });

    it('rejects replace_in_file when oldText is missing', async () => {
        await expect(createManager().executeTool('user', 'replace_in_file', {
            path: 'report.md',
            newText: 'hello'
        }, 'trace')).rejects.toThrow('oldText 缺少必填字段');
    });

    it('rejects insert_in_file when startLine is missing', async () => {
        await expect(createManager().executeTool('user', 'insert_in_file', {
            path: 'report.md',
            newText: 'hello'
        }, 'trace')).rejects.toThrow('startLine 缺少必填字段');
    });

    it('rejects browser_mcp_call when toolName is missing', async () => {
        await expect(createManager().executeTool('user', 'browser_mcp_call', {}, 'trace')).rejects.toThrow(
            'toolName 缺少必填字段'
        );
    });

    it('rejects tools outside the allowed tool name set', async () => {
        const manager = createManager();
        await expect(manager.executeTool(
            'user',
            'write_file',
            { path: 'report.md', content: 'hello' },
            'trace',
            { allowedToolNames: new Set(['replace_in_file']) },
        )).rejects.toThrow('Tool "write_file" is not allowed in this run');
    });

    it('allows tools inside the allowed tool name set', async () => {
        const manager = createManager();
        await expect(manager.executeTool(
            'user',
            'write_file',
            { path: 'report.md', content: 'hello' },
            'trace',
            { allowedToolNames: new Set(['write_file']) },
        )).resolves.toEqual({ status: 'success' });
    });

    it('rejects browser_mcp_call when args is missing', async () => {
        await expect(createManager().executeTool('user', 'browser_mcp_call', {
            toolName: 'browser_snapshot'
        }, 'trace')).rejects.toThrow('args 缺少必填字段');
    });
});

describe('ToolManager legacy tool-name aliases', () => {
    it('resolves 宾+动 legacy names to the canonical 动+宾 tools', async () => {
        const manager = createManager();
        expect(manager.getTool('file_write')?.name).toBe('write_file');
        await expect(manager.executeTool(
            'user',
            'file_insert',
            { path: 'report.md', startLine: 1, newText: 'hello' },
            'trace',
        )).resolves.toEqual({ status: 'success' });
    });

    it('accepts a legacy name in the allowed tool set', async () => {
        const manager = createManager();
        await expect(manager.executeTool(
            'user',
            'write_file',
            { path: 'report.md', content: 'hello' },
            'trace',
            { allowedToolNames: new Set(['file_write']) },
        )).resolves.toEqual({ status: 'success' });
    });
});