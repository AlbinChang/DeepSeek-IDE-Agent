import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FileTools } from '@/tools/FileTools.js';
import { buildEvaluationReportDocument } from '@/services/EvaluationAgentService.js';

async function readSource(relativePath: string) {
    return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

const TEST_ROOT = path.join(os.tmpdir(), `evaluation-report-retention-${Date.now()}`);
const REPORT_RELATIVE = '.evaluate/evl_result.md';

let workspaceRoot = '';

function reportPath() {
    return path.join(workspaceRoot, '.evaluate', 'evl_result.md');
}

function seedReport(content: string) {
    fs.mkdirSync(path.join(workspaceRoot, '.evaluate'), { recursive: true });
    fs.writeFileSync(reportPath(), content, 'utf8');
}

describe('评估报告保留机制', () => {
    beforeEach(() => {
        fs.mkdirSync(TEST_ROOT, { recursive: true });
        workspaceRoot = fs.mkdtempSync(path.join(TEST_ROOT, 'ws-'));
    });

    afterAll(() => {
        fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    });

    it('delete_path 拒绝删除 .evaluate 下的评估报告，文件保持完好', async () => {
        seedReport('# 评估Agent的评估报告\n\n执行结论：已经达成目标');

        await expect(FileTools.deletePath(workspaceRoot, REPORT_RELATIVE))
            .rejects.toThrow(/禁止通过 delete_path 修改或删除 Agent 系统内部路径/);

        expect(fs.existsSync(reportPath())).toBe(true);
        expect(fs.readFileSync(reportPath(), 'utf8')).toContain('执行结论：已经达成目标');
    });

    it('delete_path 拒绝递归删除整个 .evaluate 目录', async () => {
        seedReport('# 评估Agent的评估报告');

        await expect(FileTools.deletePath(workspaceRoot, '.evaluate', true))
            .rejects.toThrow(/Agent 系统内部路径/);

        expect(fs.existsSync(reportPath())).toBe(true);
    });

    it('file_write / file_replace 拒绝改写 .evaluate 与 .memory', async () => {
        seedReport('# 原始评估报告');

        await expect(FileTools.writeFile(workspaceRoot, REPORT_RELATIVE, '覆盖内容'))
            .rejects.toThrow(/禁止通过 file_write/);
        await expect(FileTools.writeFile(workspaceRoot, '.memory/user_instructs.json', '[]'))
            .rejects.toThrow(/禁止通过 file_write/);
        await expect(FileTools.editFileByReplace(workspaceRoot, REPORT_RELATIVE, '原始', '被改'))
            .rejects.toThrow(/禁止通过 file_replace/);

        expect(fs.readFileSync(reportPath(), 'utf8')).toContain('原始评估报告');
    });

    it('普通工作区文件仍可正常写入、替换与删除', async () => {
        await FileTools.writeFile(workspaceRoot, 'notes/todo.md', '旧内容');
        await FileTools.editFileByReplace(workspaceRoot, 'notes/todo.md', '旧内容', '新内容');
        expect(fs.readFileSync(path.join(workspaceRoot, 'notes/todo.md'), 'utf8')).toBe('新内容');

        await FileTools.deletePath(workspaceRoot, 'notes/todo.md');
        expect(fs.existsSync(path.join(workspaceRoot, 'notes/todo.md'))).toBe(false);
    });

    it('空评估报告不生成文档，从而保留上一次有效报告', () => {
        expect(buildEvaluationReportDocument('', true)).toBeNull();
        expect(buildEvaluationReportDocument('   \n  ', false)).toBeNull();

        const document = buildEvaluationReportDocument('# 评估Agent的评估报告\n执行结论：已经达成目标', true);
        expect(document).toContain('# 评估Agent的评估报告');
        expect(document).toContain('报告状态：完整');
    });

    it('评估报告只在「清空会话」路径被删除，对话主流程从不触碰', async () => {
        const chat = await readSource('services/AgentChatComponent.ts');
        const clearSessionStart = chat.indexOf('public async clearSession');
        const handleChatStart = chat.indexOf('async handleChat');
        expect(clearSessionStart).toBeGreaterThanOrEqual(0);
        expect(handleChatStart).toBeGreaterThan(clearSessionStart);

        // 整份文件中删除评估报告的语句只能出现一次，且必须落在 clearSession 内部
        const deleteSites = [...chat.matchAll(/FileIO\.deletePath\(\s*["']\.evaluate/g)];
        expect(deleteSites).toHaveLength(1);
        const deleteIndex = deleteSites[0].index ?? -1;
        expect(deleteIndex).toBeGreaterThan(clearSessionStart);
        expect(deleteIndex).toBeLessThan(handleChatStart);
    });

    it('清空会话 IPC 会等待清理完成后再返回成功', async () => {
        const handlers = await readSource('../../electron/src/main/ipc/agent-handlers.ts');
        expect(handlers).toContain('await agentChatComponent.clearSession(');
    });
});
