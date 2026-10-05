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

function extractBetween(source: string, startMarker: string, endMarker: string) {
    const startIndex = source.indexOf(startMarker);
    expect(startIndex).toBeGreaterThanOrEqual(0);

    const endIndex = source.indexOf(endMarker, startIndex + startMarker.length);
    expect(endIndex).toBeGreaterThan(startIndex);
    return source.slice(startIndex, endIndex);
}

describe('tool description deduplication contracts', () => {
    it('keeps write tool descriptions focused instead of repeating field contracts', async () => {
        const source = await readSource('services/AgentService.ts');
        const fileWrite = extractToolDescription(source, 'file_write');
        const fileReplace = extractToolDescription(source, 'file_replace');
        const fileInsert = extractToolDescription(source, 'file_insert');

        expect(fileWrite.length).toBeLessThanOrEqual(200);
        expect(fileReplace.length).toBeLessThanOrEqual(200);
        expect(fileInsert.length).toBeLessThanOrEqual(180);
        expect(countOccurrences(fileWrite, 'startLine')).toBeLessThanOrEqual(1);
        expect(countOccurrences(fileReplace, 'oldText')).toBeLessThanOrEqual(2);
    });

    it('keeps todo descriptions concise', async () => {
        const todoSource = await readSource('tools/TodoTools.ts');
        const appendTodo = extractToolDescription(todoSource, 'append_todo');

        expect(appendTodo.length).toBeLessThanOrEqual(120);
        expect(countOccurrences(appendTodo, 'operation')).toBeLessThanOrEqual(3);
    });

    it('keeps every built-in function description within a concise budget', async () => {
        const tools = [
            ['services/AgentService.ts', 'read_file', 350],
            ['services/AgentService.ts', 'read_file_by_byte', 180],
            ['services/AgentService.ts', 'file_write', 200],
            ['services/AgentService.ts', 'list_files', 140],
            ['services/AgentService.ts', 'delete_path', 160],
            ['services/AgentService.ts', 'file_replace', 200],
            ['services/AgentService.ts', 'file_insert', 180],
            ['services/AgentService.ts', 'file_replace_all', 180],
            ['services/AgentService.ts', 'run_powershell_command', 180],
            ['services/AgentService.ts', 'run_cmd_command', 150],
            ['tools/TodoTools.ts', 'list_todos', 100],
            ['tools/TodoTools.ts', 'append_todo', 120],
            ['tools/TodoTools.ts', 'update_todo', 100],
            ['tools/TodoTools.ts', 'delete_todo', 100],
            ['tools/NeverMistakeTools.ts', 'list_never_mistake_rules', 120],
            ['tools/NeverMistakeTools.ts', 'append_never_mistake_rule', 140],
            ['tools/NeverMistakeTools.ts', 'delete_never_mistake_rule', 110],
            ['tools/UserPreferenceTools.ts', 'list_user_preferences', 150],
            ['tools/UserPreferenceTools.ts', 'upsert_user_preference', 150],
            ['tools/UserPreferenceTools.ts', 'delete_user_preference', 120],
            ['tools/custom/CalculatorTool.ts', 'calculate', 400],
        ] as const;

        for (const [relativePath, toolName, maxLength] of tools) {
            const source = await readSource(relativePath);
            const description = extractToolDescription(source, toolName);
            expect(description.length, `${relativePath}:${toolName}`).toBeLessThanOrEqual(maxLength);
        }
    });

    it('does not repeat bridged MCP tool descriptions in system prompts', async () => {
        const mcpSource = await readSource('services/McpService.ts');
        const browserSource = await readSource('services/BrowserMcpAdapter.ts');
        const mcpPrompt = extractBetween(
            mcpSource,
            'buildMcpSystemPrompt(userId: string, workspaceRoot: string): string {',
            'getToolGroupSummaries(',
        );
        const browserPrompt = extractBetween(
            browserSource,
            'buildSystemPrompt(userId: string, workspaceRoot: string): string {',
            'getToolSummaries(',
        );

        expect(mcpPrompt).not.toContain('tool.description');
        expect(browserPrompt).not.toContain('tool.description');
        expect(mcpSource).not.toContain('(来自用户配置的 ${config.name} MCP 服务器)');
        expect(browserSource).not.toContain('(浏览器自动化原生工具，由 Playwright MCP 服务器提供)');
        expect(mcpSource).toContain('return nativeTool.description?.trim() || nativeTool.name;');
        expect(browserSource).toContain('return nativeTool.description?.trim() || nativeTool.name;');
    });

    it('keeps the shared file-tool policy concise and defers argument details to schemas', async () => {
        const config = JSON.parse(await readSource('config/main-agent.json'));
        const fileToolContract = config.operation_guidelines.file_tools_contract;

        expect(fileToolContract.length).toBeLessThanOrEqual(300);
        expect(fileToolContract).toContain('具体参数以工具 schema 为准');
    });
});