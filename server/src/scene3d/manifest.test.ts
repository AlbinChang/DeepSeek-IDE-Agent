import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    assetIdFromPath,
    ensureScene3dScaffold,
    listScene3dAssets,
    readScene3dManifest,
    removeScene3dAsset,
    toAssetSlug,
    upsertScene3dAsset,
} from './manifest.js';

describe('.3d 资产清单', () => {
    let workspaceRoot = '';

    beforeEach(async () => {
        workspaceRoot = await mkdtemp(path.join(tmpdir(), 'scene3d-manifest-'));
    });

    afterEach(async () => {
        if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
    });

    it('幂等创建目录骨架与约定文件', async () => {
        const created = await ensureScene3dScaffold(workspaceRoot);
        const second = await ensureScene3dScaffold(workspaceRoot);

        expect(created).toContain('.3d/README.md');
        expect(created).toContain('.3d/.gitignore');
        expect(created).toContain('.3d/manifest.json');
        expect(second).toEqual([]);
        const readme = await readFile(path.join(workspaceRoot, '.3d', 'README.md'), 'utf8');
        expect(readme).toContain('scene3d/v1');
        const gitignore = await readFile(path.join(workspaceRoot, '.3d', '.gitignore'), 'utf8');
        expect(gitignore).toContain('.temp/');
    });

    it('写入资产并保留创建时间、描述与标签', async () => {
        await upsertScene3dAsset(workspaceRoot, {
            id: 'robot',
            name: 'Robot',
            kind: 'model',
            path: '.3d/models/robot.glb',
            description: '主模型',
            tags: ['product'],
            bytes: 100,
        });
        const first = await readScene3dManifest(workspaceRoot);
        await upsertScene3dAsset(workspaceRoot, {
            id: 'robot',
            name: 'Robot',
            kind: 'model',
            path: '.3d/models/robot.glb',
            preview: '.3d/renders/robot.png',
            meta: { triangles: 12 },
        });
        const second = await readScene3dManifest(workspaceRoot);

        expect(first.assets).toHaveLength(1);
        expect(second.assets).toHaveLength(1);
        expect(second.assets[0].description).toBe('主模型');
        expect(second.assets[0].tags).toEqual(['product']);
        expect(second.assets[0].preview).toBe('.3d/renders/robot.png');
        expect(second.assets[0].meta.triangles).toBe(12);
        expect(second.assets[0].createdAt).toBe(first.assets[0].createdAt);
    });

    it('按 kind/tag/关键字过滤并标记缺失文件', async () => {
        await upsertScene3dAsset(workspaceRoot, { id: 'a', name: 'A', kind: 'model', path: '.3d/models/a.glb', tags: ['x'] });
        await upsertScene3dAsset(workspaceRoot, { id: 'b', name: 'B', kind: 'scene', path: '.3d/scenes/b.scene3d.json', tags: ['y'] });
        await writeFile(path.join(workspaceRoot, '.3d', 'models', 'a.glb'), 'x');

        const models = await listScene3dAssets(workspaceRoot, { kind: 'model' });
        const tagged = await listScene3dAssets(workspaceRoot, { tag: 'y' });
        const byQuery = await listScene3dAssets(workspaceRoot, { query: 'scenes/b' });

        expect(models.total).toBe(1);
        expect(models.assets[0].missing).toBe(false);
        expect(tagged.assets[0].id).toBe('b');
        expect(tagged.assets[0].missing).toBe(true);
        expect(byQuery.assets[0].id).toBe('b');
    });

    it('支持按 id/路径移除登记', async () => {
        await upsertScene3dAsset(workspaceRoot, { id: 'a', name: 'A', kind: 'model', path: '.3d/models/a.glb' });

        expect(await removeScene3dAsset(workspaceRoot, 'a')).toBe(true);
        expect(await removeScene3dAsset(workspaceRoot, 'a')).toBe(false);
        expect((await readScene3dManifest(workspaceRoot)).assets).toHaveLength(0);
    });

    it('slug 规范化', () => {
        expect(toAssetSlug('Product Console')).toBe('product-console');
        expect(toAssetSlug('产品控制台')).toMatch(/^asset-[0-9a-f]{6}$/);
        expect(assetIdFromPath('.3d/models/robot-arm.glb')).toBe('robot-arm');
        expect(assetIdFromPath('.3d/scenes/robot.scene3d.json')).toBe('robot');
    });

    it('manifest 文件为 2 空格格式化 JSON', async () => {
        await ensureScene3dScaffold(workspaceRoot);
        const file = path.join(workspaceRoot, '.3d', 'manifest.json');
        const raw = await readFile(file, 'utf8');
        const info = await stat(file);

        expect(raw).toContain('\n  "schema"');
        expect(info.size).toBeGreaterThan(0);
    });
});
