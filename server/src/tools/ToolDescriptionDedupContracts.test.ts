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
        const multiFileWrite = extractToolDescription(source, 'multi_file_write');
        const singleFileWrite = extractToolDescription(source, 'single_file_write');
        const singleFileEdit = extractToolDescription(source, 'single_file_edit');

        expect(multiFileWrite.length).toBeLessThanOrEqual(1500);
        expect(singleFileWrite.length).toBeLessThanOrEqual(1200);
        expect(singleFileEdit.length).toBeLessThanOrEqual(3000);
        expect(countOccurrences(multiFileWrite, 'single_file_write')).toBeLessThanOrEqual(3);
        expect(countOccurrences(singleFileWrite, 'multi_file_write')).toBeLessThanOrEqual(1);
        expect(countOccurrences(singleFileWrite, 'startLine')).toBeLessThanOrEqual(1);
        expect(countOccurrences(singleFileEdit, 'oldText')).toBeLessThanOrEqual(8);
    });

    it('keeps todo and browser_mcp_call descriptions concise', async () => {
        const todoSource = await readSource('tools/TodoTools.ts');
        const browserSource = await readSource('tools/BrowserAutomationTools.ts');

        const appendTodo = extractToolDescription(todoSource, 'append_todo');
        const browserMcpCall = extractToolDescription(browserSource, 'browser_mcp_call');

        expect(appendTodo.length).toBeLessThanOrEqual(900);
        expect(browserMcpCall.length).toBeLessThanOrEqual(900);
        expect(countOccurrences(appendTodo, 'operation')).toBeLessThanOrEqual(3);
        expect(countOccurrences(browserMcpCall, 'browser_evaluate')).toBeLessThanOrEqual(2);
    });
});