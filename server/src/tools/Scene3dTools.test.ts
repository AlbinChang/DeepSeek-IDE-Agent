import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Scene3dTools } from './Scene3dTools.js';
import { readScene3dManifest } from '@/scene3d/manifest.js';

const RUN_RENDER = process.env.RUN_3D_RENDER_TEST === '1';

const OBJ_FIXTURE = ['o tri', 'v -1 -1 0', 'v 1 -1 0', 'v 0 1 0', 'f 1 2 3'].join('\n');

describe('3D 工具集', () => {
    let workspaceRoot = '';
    let tools: Scene3dTools;

    beforeEach(async () => {
        workspaceRoot = await mkdtemp(path.join(tmpdir(), 'scene3d-tools-'));
        tools = new Scene3dTools(workspaceRoot);
    });

    afterEach(async () => {
        if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
    });

    it('create_3d_scene 写入规范文件并建档（render:false）', async () => {
        const result = await tools.createScene({
            name: 'Product Console',
            description: '产品控制台',
            tags: ['product'],
            render: false,
            spec: {
                background: '#101418',
                objects: [{ type: 'box', size: [1, 0.4, 0.6], material: { color: '#4f9cff' } }],
            },
        });

        expect(result.path).toBe('.3d/scenes/product-console.scene3d.json');
        expect(result.summary).toContain('scene created');
        const written = JSON.parse(await readFile(path.join(workspaceRoot, '.3d', 'scenes', 'product-console.scene3d.json'), 'utf8'));
        expect(written.schema).toBe('scene3d/v1');
        expect(written.name).toBe('Product Console');

        const manifest = await readScene3dManifest(workspaceRoot);
        expect(manifest.assets).toHaveLength(1);
        expect(manifest.assets[0].kind).toBe('scene');
        expect(manifest.assets[0].tags).toEqual(['product']);
        expect(manifest.assets[0].meta.missingRefs).toEqual([]);
    });

    it('create_3d_scene 对非法规范抛错并指出字段路径', async () => {
        await expect(tools.createScene({
            name: 'bad',
            render: false,
            spec: { objects: [{ type: 'sphere', radius: -1 }] },
        })).rejects.toThrow(/objects\[0\]\.radius/);
    });

    it('create_3d_scene 记录缺失的模型引用', async () => {
        const result = await tools.createScene({
            name: 'with-model',
            render: false,
            spec: { objects: [{ type: 'model', src: '../models/robot.glb' }] },
        });

        expect(result.summary).toContain('引用缺失');
        const manifest = await readScene3dManifest(workspaceRoot);
        expect(manifest.assets[0].meta.missingRefs).toEqual(['../models/robot.glb']);
    });

    it('register_3d_asset 复制到 .3d/models 并登记元数据', async () => {
        await mkdir(path.join(workspaceRoot, 'assets'), { recursive: true });
        await writeFile(path.join(workspaceRoot, 'assets', 'robot.obj'), OBJ_FIXTURE);

        const result = await tools.registerAsset({ path: 'assets/robot.obj', name: 'Robot Arm', tags: ['hero'] });

        expect(result).toContain('.3d/models/robot-arm.obj');
        await expect(stat(path.join(workspaceRoot, '.3d', 'models', 'robot-arm.obj'))).resolves.toBeTruthy();
        const manifest = await readScene3dManifest(workspaceRoot);
        expect(manifest.assets[0].kind).toBe('model');
        expect(manifest.assets[0].meta.triangles).toBe(1);
        expect(manifest.assets[0].tags).toEqual(['hero']);
    });

    it('register_3d_asset 同名不同内容自动追加版本号', async () => {
        await mkdir(path.join(workspaceRoot, 'a'), { recursive: true });
        await mkdir(path.join(workspaceRoot, 'b'), { recursive: true });
        await writeFile(path.join(workspaceRoot, 'a', 'thing.obj'), OBJ_FIXTURE);
        await writeFile(path.join(workspaceRoot, 'b', 'thing.obj'), `${OBJ_FIXTURE}\n# changed`);

        await tools.registerAsset({ path: 'a/thing.obj', name: 'thing' });
        const second = await tools.registerAsset({ path: 'b/thing.obj', name: 'thing' });

        expect(second).toContain('.3d/models/thing-v02.obj');
    });

    it('inspect_3d_asset / list_3d_assets 输出可直接阅读的报告', async () => {
        await mkdir(path.join(workspaceRoot, 'assets'), { recursive: true });
        await writeFile(path.join(workspaceRoot, 'assets', 'robot.obj'), OBJ_FIXTURE);
        await tools.registerAsset({ path: 'assets/robot.obj', name: 'robot' });

        const inspected = await tools.inspectAsset({ path: '.3d/models/robot.obj' });
        const listed = await tools.listAssets({ kind: 'model' });
        const empty = await tools.listAssets({ query: 'nothing' });

        expect(inspected).toContain('[3d] OBJ');
        expect(inspected).toContain('tris=1');
        expect(listed).toContain('assets=1');
        expect(listed).toContain('model/robot');
        expect(empty).toContain('没有匹配资产');
    });

    it('check_3d_asset 支持内容预检、单文件与目录体检', async () => {
        const pre = await tools.checkAsset({
            content: JSON.stringify({ objects: [{ type: 'nope' }] }),
            format: 'scene3d',
        });
        expect(pre).toContain('SCENE3D_SPEC');
        expect(pre).toContain('errors=');

        await tools.createScene({
            name: 'check-me',
            render: false,
            spec: {
                lights: [{ type: 'ambient', intensity: 0.8 }],
                objects: [{ type: 'box', size: [1, 1, 1] }],
            },
        });
        const file = await tools.checkAsset({ path: '.3d/scenes/check-me.scene3d.json' });
        expect(file).toContain('[check_3d] OK');

        await mkdir(path.join(workspaceRoot, 'assets'), { recursive: true });
        await writeFile(path.join(workspaceRoot, 'assets', 'bad.obj'), 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9\n');
        const single = await tools.checkAsset({ path: 'assets/bad.obj' });
        expect(single).toContain('OBJ_FACE_OOB');

        const batch = await tools.checkAsset({ path: '.3d' });
        expect(batch).toContain('files=');
        expect(batch).toContain('.3d/scenes/check-me.scene3d.json');

        await expect(tools.checkAsset({})).rejects.toThrow(/path|content/);
    });

    it('缺失参数时抛出可操作的错误', async () => {
        await expect(tools.createScene({ name: 'x' })).rejects.toThrow(/spec/);
        await expect(tools.renderPreview({})).rejects.toThrow(/path/);
        await expect(tools.inspectAsset({})).rejects.toThrow(/path/);
        await expect(tools.registerAsset({ path: 'nope.glb' })).rejects.toThrow(/文件不存在/);
    });

    it.skipIf(!RUN_RENDER)('render_3d_preview 产出真实 PNG 与构图统计', async () => {
        await tools.createScene({
            name: 'render-smoke',
            render: false,
            spec: {
                background: '#0b0d12',
                objects: [{ type: 'box', size: [1, 1, 1], position: [0, 0.5, 0], material: { color: '#4f9cff' } }],
            },
        });

        const result = await tools.renderPreview({ path: '.3d/scenes/render-smoke.scene3d.json', width: 320, height: 200 });

        expect(result).toContain('.3d/renders/render-smoke.png');
        expect(result).toContain('tris=12');
        const png = await readFile(path.join(workspaceRoot, '.3d', 'renders', 'render-smoke.png'));
        expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect(png.length).toBeGreaterThan(1000);
        const coverage = Number(/coverage=([\d.]+)%/.exec(result)?.[1] ?? 0);
        expect(coverage).toBeGreaterThan(1);
        const manifest = await readScene3dManifest(workspaceRoot);
        expect(manifest.assets[0].preview).toBe('.3d/renders/render-smoke.png');
    }, 120_000);

    it.skipIf(!RUN_RENDER)('render_3d_preview 支持直接渲染模型文件', async () => {
        await mkdir(path.join(workspaceRoot, 'assets'), { recursive: true });
        await writeFile(path.join(workspaceRoot, 'assets', 'tri.obj'), OBJ_FIXTURE);

        const result = await tools.renderPreview({ path: 'assets/tri.obj', width: 240, height: 160 });

        expect(result).toContain('tris=1');
        const png = await readFile(path.join(workspaceRoot, '.3d', 'renders', 'tri.png'));
        expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    }, 120_000);
});
