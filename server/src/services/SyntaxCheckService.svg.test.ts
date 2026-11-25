import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SyntaxCheckService } from './SyntaxCheckService.js';

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

describe('SyntaxCheckService — SVG 写后门禁', () => {
    let workspaceRoot = '';

    beforeAll(async () => {
        workspaceRoot = await mkdtemp(path.join(tmpdir(), 'svg-gate-'));
        await writeFile(
            path.join(workspaceRoot, 'bad.svg'),
            `<svg ${SVG_NS} viewBox="0 0 100 100">\n<rect x="10" y="10" width="10" height="10"/>\n<rect x="90" y="10" width="40" height="10"/>\n</svg>`,
        );
        await writeFile(
            path.join(workspaceRoot, 'ok.svg'),
            `<svg ${SVG_NS} viewBox="0 0 100 100"><rect x="10" y="10" width="40" height="10"/></svg>`,
        );
    });

    afterAll(async () => {
        if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
    });

    it('把 .svg 纳入强制检查扩展名', () => {
        expect(SyntaxCheckService.isEnforcedExtension('.svg')).toBe(true);
    });

    it('越界的 SVG 判为 error 并给出带行号的诊断', async () => {
        const [result] = await SyntaxCheckService.checkFiles(workspaceRoot, ['bad.svg']);

        expect(result.status).toBe('error');
        expect(result.checker).toBe('svg-bounds');
        expect(SyntaxCheckService.isGatePass(result)).toBe(false);
        expect(result.diagnostics?.[0]?.line).toBe(3);
        expect(result.diagnostics?.[0]?.message).toContain('右');
    });

    it('未越界的 SVG 通过门禁', async () => {
        const [result] = await SyntaxCheckService.checkFiles(workspaceRoot, ['ok.svg']);

        expect(result.status).toBe('ok');
        expect(SyntaxCheckService.isGatePass(result)).toBe(true);
        expect(SyntaxCheckService.buildWriteFeedback(result)).toEqual({});
    });

    it('写文件反馈携带首条诊断，便于模型就地修正', async () => {
        const [result] = await SyntaxCheckService.checkFiles(workspaceRoot, ['bad.svg']);
        const feedback = SyntaxCheckService.buildWriteFeedback(result);

        expect(feedback.syntax).toContain('errors: 1');
        expect(feedback.syntax).toContain('L3');
    });
});
