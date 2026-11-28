import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SyntaxCheckService } from './SyntaxCheckService.js';

describe('SyntaxCheckService — scene3d 写后门禁', () => {
    let workspaceRoot = '';

    beforeAll(async () => {
        workspaceRoot = await mkdtemp(path.join(tmpdir(), 'scene3d-gate-'));
        await writeFile(
            path.join(workspaceRoot, 'ok.scene3d.json'),
            JSON.stringify({
                schema: 'scene3d/v1',
                objects: [{ type: 'box', size: [1, 1, 1] }],
            }),
        );
        await writeFile(
            path.join(workspaceRoot, 'bad.scene3d.json'),
            JSON.stringify({
                schema: 'scene3d/v1',
                objects: [{ type: 'sphere', radius: -1 }],
            }),
        );
    });

    afterAll(async () => {
        if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
    });

    it('合法的 scene3d 场景通过门禁', async () => {
        const [result] = await SyntaxCheckService.checkFiles(workspaceRoot, ['ok.scene3d.json']);

        expect(result.status).toBe('ok');
        expect(result.checker).toBe('scene3d-spec');
        expect(SyntaxCheckService.isGatePass(result)).toBe(true);
    });

    it('非法场景给出字段路径并判为失败', async () => {
        const [result] = await SyntaxCheckService.checkFiles(workspaceRoot, ['bad.scene3d.json']);

        expect(result.status).toBe('error');
        expect(result.message).toContain('scene3d');
        expect(result.diagnostics?.[0]?.message).toContain('objects[0].radius');
        expect(SyntaxCheckService.isGatePass(result)).toBe(false);
        const feedback = SyntaxCheckService.buildWriteFeedback(result);
        expect(feedback.syntax).toContain('objects[0].radius');
    });

    it('JSON 语法错误也能被捕获', async () => {
        await writeFile(path.join(workspaceRoot, 'broken.scene3d.json'), '{ "objects": [ }');
        const [result] = await SyntaxCheckService.checkFiles(workspaceRoot, ['broken.scene3d.json']);

        expect(result.status).toBe('error');
        expect(result.checker).toBe('scene3d-spec');
    });
});
