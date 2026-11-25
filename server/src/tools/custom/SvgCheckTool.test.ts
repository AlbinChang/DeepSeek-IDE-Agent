import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SvgCheckTool } from './SvgCheckTool.js';

const OVERFLOW_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">',
    '  <rect x="10" y="10" width="60" height="30"/>',
    '  <rect x="150" y="10" width="80" height="30"/>',
    '</svg>',
].join('\n');

describe('check_svg 工具', () => {
    let workspaceRoot = '';

    beforeAll(async () => {
        workspaceRoot = await mkdtemp(path.join(tmpdir(), 'svg-check-'));
        await writeFile(path.join(workspaceRoot, 'ok.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');
        await writeFile(path.join(workspaceRoot, 'bad.svg'), OVERFLOW_SVG);
    });

    afterAll(async () => {
        if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
    });

    it('对越界源码返回 FAIL 报告，含行号、像素与修正建议', async () => {
        const result = await SvgCheckTool.execute({ content: OVERFLOW_SVG }, { workspaceRoot });

        expect(result).toContain('[check_svg] ERROR');
        expect(result).toContain('errors=1');
        expect(result).toContain('L3');
        expect(result).toContain('right');
        expect(result).toContain('fix:');
    });

    it('通过工作区文件路径校验', async () => {
        const ok = await SvgCheckTool.execute({ path: 'ok.svg' }, { workspaceRoot });
        const bad = await SvgCheckTool.execute({ path: 'bad.svg' }, { workspaceRoot });

        expect(ok).toContain('[check_svg] OK');
        expect(bad).toContain('[check_svg] ERROR');
    });

    it('文件不存在时返回 ERROR 而不是抛异常', async () => {
        const result = await SvgCheckTool.execute({ path: 'missing.svg' }, { workspaceRoot });

        expect(result).toContain('[check_svg] ERROR');
        expect(result).toContain('读取失败');
    });

    it('同时提供 path 与 content 时以 path 为准', async () => {
        const result = await SvgCheckTool.execute({ path: 'ok.svg', content: OVERFLOW_SVG }, { workspaceRoot });

        expect(result).toContain('[check_svg] OK');
        expect(result).toContain('已忽略 content');
    });

    it('缺少 path 与 content 时抛错提示调用方式', async () => {
        await expect(SvgCheckTool.execute({}, { workspaceRoot }))
            .rejects.toThrow(/path.*content/);
    });

    it('未初始化工作区且使用 path 时抛错', async () => {
        await expect(SvgCheckTool.execute({ path: 'ok.svg' }, {}))
            .rejects.toThrow(/Workspace not initialized/);
    });

    it('问题超过 maxIssues 时提示还有未显示项', async () => {
        const body = Array.from({ length: 5 }, (_, i) => `<rect x="95" y="${i * 10}" width="20" height="5"/>`).join('');
        const result = await SvgCheckTool.execute({
            content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`,
            maxIssues: 2,
        }, { workspaceRoot });

        expect(result).toContain('errors=5');
        expect(result).toContain('另有 3 条未显示');
    });
});
