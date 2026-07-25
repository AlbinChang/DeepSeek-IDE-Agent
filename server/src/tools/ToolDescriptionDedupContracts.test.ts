import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function readSource(relativePath: string) {
    return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function extractToolDescription(source: string, toolName: string) {
    const nameIndex = source.indexOf(`name: '${toolName}'`);
    expect(nameIndex).toBeGreaterThanOrEqual(0);

    const descriptionIndex = source.indexOf('description:', nameIndex);
    const parametersIndex = source.indexOf('parameters:', descriptionIndex);
    expect(descriptionIndex).toBeGreaterThan(nameIndex);
    expect(parametersIndex).toBeGreaterThan(descriptionIndex);

    return source.slice(descriptionIndex, parametersIndex);
}

function countOccurrences(text: string, needle: string) {
    return text.split(needle).length - 1;
}

describe('tool description deduplication contracts', () => {
    it('keeps write tool descriptions focused instead of repeating field contracts', async () => {
        const source = await readSource('services/AgentService.ts');
        const fileWrite = extractToolDescription(source, 'file_write');
        const fileReplace = extractToolDescription(source, 'file_replace');
        const fileInsert = extractToolDescription(source, 'file_insert');

        expect(fileWrite.length).toBeLessThanOrEqual(1200);
        expect(fileReplace.length).toBeLessThanOrEqual(2000);
        expect(fileInsert.length).toBeLessThanOrEqual(1500);
        expect(countOccurrences(fileWrite, 'startLine')).toBeLessThanOrEqual(1);
        expect(countOccurrences(fileReplace, 'oldText')).toBeLessThanOrEqual(6);
    });

    it('keeps todo descriptions concise', async () => {
        // 注：browser_mcp_call 已随 2026.05 BrowserMcpAdapter 重构移除（见 BrowserAutomationTools.ts 顶部
        // @deprecated 说明）。浏览器工具现由 Playwright MCP 动态桥接为 playwright__* 工具，
        // 描述文本在运行时由 BrowserMcpAdapter.buildToolDescription() 动态生成，不再是可静态扫描的源码字面量。
        const todoSource = await readSource('tools/TodoTools.ts');
        const appendTodo = extractToolDescription(todoSource, 'append_todo');

        expect(appendTodo.length).toBeLessThanOrEqual(900);
        expect(countOccurrences(appendTodo, 'operation')).toBeLessThanOrEqual(3);
    });
});