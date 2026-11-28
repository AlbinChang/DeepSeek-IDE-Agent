import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    detectScene3dFormat,
    formatScene3dAssetInfo,
    inspectScene3dAsset,
    parseGlb,
} from './assetInspector.js';

function buildGlb(json: Record<string, any>, binary?: Buffer): Buffer {
    const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
    const jsonPadded = Buffer.concat([jsonBuffer, Buffer.alloc((4 - (jsonBuffer.length % 4)) % 4, 0x20)]);
    const bin = binary ?? Buffer.alloc(12, 0);
    const total = 12 + 8 + jsonPadded.length + 8 + bin.length;
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(total, 8);
    const jsonHeader = Buffer.alloc(8);
    jsonHeader.writeUInt32LE(jsonPadded.length, 0);
    jsonHeader.writeUInt32LE(0x4e4f534a, 4);
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(bin.length, 0);
    binHeader.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, jsonHeader, jsonPadded, binHeader, bin]);
}

function buildBinaryStl(vertices: Array<[number, number, number]>): Buffer {
    const buffer = Buffer.alloc(84 + 50, 0);
    buffer.write('binary stl fixture', 0, 'utf8');
    buffer.writeUInt32LE(1, 80);
    vertices.forEach((vertex, index) => {
        const offset = 84 + 12 + index * 12;
        buffer.writeFloatLE(vertex[0], offset);
        buffer.writeFloatLE(vertex[1], offset + 4);
        buffer.writeFloatLE(vertex[2], offset + 8);
    });
    return buffer;
}

const CUBE_GLTF = {
    asset: { version: '2.0', generator: 'vitest' },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: [10, 0, 0], name: 'cube' }],
    meshes: [{ name: 'cube', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    accessors: [
        { type: 'VEC3', componentType: 5126, count: 8, min: [-1, -1, -1], max: [1, 1, 1] },
        { type: 'SCALAR', componentType: 5123, count: 36 },
    ],
    materials: [{ name: 'mat' }],
};

describe('3D 资产解析', () => {
    let workspaceRoot = '';

    beforeAll(async () => {
        workspaceRoot = await mkdtemp(path.join(tmpdir(), 'scene3d-inspect-'));
        await mkdir(path.join(workspaceRoot, '.3d', 'models'), { recursive: true });
        await mkdir(path.join(workspaceRoot, '.3d', 'scenes'), { recursive: true });
        await writeFile(path.join(workspaceRoot, '.3d', 'models', 'cube.glb'), buildGlb(CUBE_GLTF));
        await writeFile(path.join(workspaceRoot, '.3d', 'models', 'cube.gltf'), JSON.stringify(CUBE_GLTF));
        await writeFile(
            path.join(workspaceRoot, '.3d', 'models', 'tri.obj'),
            ['# obj fixture', 'o tri', 'v -1 -1 -1', 'v 1 -1 -1', 'v 0 1 0', 'usemtl red', 'f 1 2 3'].join('\n'),
        );
        await writeFile(
            path.join(workspaceRoot, '.3d', 'models', 'tri.stl'),
            buildBinaryStl([[-1, -1, -1], [1, -1, -1], [0, 1, 0]]),
        );
        await writeFile(
            path.join(workspaceRoot, '.3d', 'scenes', 'broken.scene3d.json'),
            JSON.stringify({
                schema: 'scene3d/v1',
                objects: [{ type: 'model', src: '../models/missing.glb' }],
            }),
        );
    });

    afterAll(async () => {
        if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
    });

    it('解析 GLB 元数据并按节点位移计算世界包围盒', async () => {
        const info = await inspectScene3dAsset(workspaceRoot, '.3d/models/cube.glb');

        expect(info.format).toBe('glb');
        expect(info.meta.nodes).toBe(1);
        expect(info.meta.meshes).toBe(1);
        expect(info.meta.triangles).toBe(12);
        expect(info.meta.vertices).toBe(8);
        expect(info.meta.materials).toBe(1);
        expect(info.meta.bounds.min).toEqual([9, -1, -1]);
        expect(info.meta.bounds.max).toEqual([11, 1, 1]);
        expect(formatScene3dAssetInfo(info)).toContain('tris=12');
    });

    it('解析 glTF JSON 并与 GLB 结果一致', async () => {
        const info = await inspectScene3dAsset(workspaceRoot, '.3d/models/cube.gltf');

        expect(info.format).toBe('gltf');
        expect(info.meta.triangles).toBe(12);
        expect(info.meta.bounds.size).toEqual([2, 2, 2]);
    });

    it('解析 OBJ 顶点/面/材质', async () => {
        const info = await inspectScene3dAsset(workspaceRoot, '.3d/models/tri.obj');

        expect(info.format).toBe('obj');
        expect(info.meta.vertices).toBe(3);
        expect(info.meta.faces).toBe(1);
        expect(info.meta.triangles).toBe(1);
        expect(info.meta.materials).toEqual(['red']);
        expect(info.meta.bounds.size).toEqual([2, 2, 1]);
    });

    it('解析二进制 STL', async () => {
        const info = await inspectScene3dAsset(workspaceRoot, '.3d/models/tri.stl');

        expect(info.format).toBe('stl');
        expect(info.meta.ascii).toBe(false);
        expect(info.meta.triangles).toBe(1);
        expect(info.meta.bounds.size).toEqual([2, 2, 1]);
    });

    it('场景引用缺失时在检查结果中告警', async () => {
        const info = await inspectScene3dAsset(workspaceRoot, '.3d/scenes/broken.scene3d.json');

        expect(info.format).toBe('scene3d');
        expect(info.refs[0].exists).toBe(false);
        expect(info.warnings.join('\n')).toContain('引用缺失');
    });

    it('拒绝损坏的 GLB 与未知扩展名', async () => {
        await writeFile(path.join(workspaceRoot, '.3d', 'models', 'bad.glb'), Buffer.from('not a glb'));

        await expect(inspectScene3dAsset(workspaceRoot, '.3d/models/bad.glb')).rejects.toThrow(/GLB|magic|头部/);
        await expect(inspectScene3dAsset(workspaceRoot, '.3d/models/none.xyz')).rejects.toThrow(/不支持/);
    });

    it('GLB chunk 越界时抛出明确错误', () => {
        const glb = buildGlb(CUBE_GLTF);
        glb.writeUInt32LE(glb.length + 100, 8);

        expect(() => parseGlb(glb)).toThrow(/超过实际文件大小|截断/);
    });

    it('按扩展名识别格式', () => {
        expect(detectScene3dFormat('a/b.scene3d.json')).toBe('scene3d');
        expect(detectScene3dFormat('a/b.GLB')).toBe('glb');
        expect(detectScene3dFormat('a/b.png')).toBeNull();
    });
});
