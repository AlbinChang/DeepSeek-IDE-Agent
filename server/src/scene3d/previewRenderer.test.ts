import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderScene3dPreview } from './previewRenderer.js';

const RUN_RENDER = process.env.RUN_3D_RENDER_TEST === '1';

function buildTriangleGlb(): Buffer {
    const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
    const indices = new Uint16Array([0, 1, 2]);
    const bin = Buffer.alloc(44);
    Buffer.from(positions.buffer).copy(bin, 0);
    Buffer.from(indices.buffer).copy(bin, 36);
    const json = {
        asset: { version: '2.0', generator: 'vitest' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
            { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
        ],
        bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
            { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
        ],
        buffers: [{ byteLength: 42 }],
    };
    const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
    const jsonPadded = Buffer.concat([jsonBuffer, Buffer.alloc((4 - (jsonBuffer.length % 4)) % 4, 0x20)]);
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

describe('3D 无头渲染', () => {
    let workspaceRoot = '';

    beforeAll(async () => {
        workspaceRoot = await mkdtemp(path.join(tmpdir(), 'scene3d-render-'));
        await writeFile(path.join(workspaceRoot, 'triangle.glb'), buildTriangleGlb());
    });

    afterAll(async () => {
        if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
    });

    it.skipIf(!RUN_RENDER)('渲染内联场景并回报像素统计', async () => {
        const result = await renderScene3dPreview({
            workspaceRoot,
            spec: {
                schema: 'scene3d/v1',
                background: '#0b0d12',
                objects: [{ type: 'box', size: [1, 1, 1], material: { color: '#4f9cff' } }],
            },
            width: 320,
            height: 200,
        });

        expect(result.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect(result.stats.triangles).toBe(12);
        expect(result.pixelStats?.coverage ?? 0).toBeGreaterThan(0.01);
        expect(result.pixelStats?.meanLuma ?? 0).toBeGreaterThan(0);
        expect(result.width).toBe(320);
        expect(result.height).toBe(200);
    }, 120_000);

    it.skipIf(!RUN_RENDER)('通过 GLTFLoader 渲染 .glb 模型', async () => {
        const result = await renderScene3dPreview({
            workspaceRoot,
            spec: {
                schema: 'scene3d/v1',
                objects: [{ type: 'model', src: 'triangle.glb', material: { color: '#ffb454', side: 'double' } }],
            },
            width: 240,
            height: 160,
        });

        expect(result.stats.triangles).toBe(1);
        expect(result.stats.meshes).toBe(1);
        expect(result.png.length).toBeGreaterThan(1000);
    }, 120_000);

    it.skipIf(!RUN_RENDER)('加载 material.map 贴图（HTTP 资源路径）', async () => {
        await writeFile(
            path.join(workspaceRoot, 'red.png'),
            Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
        );
        const result = await renderScene3dPreview({
            workspaceRoot,
            spec: {
                schema: 'scene3d/v1',
                background: '#000000',
                render: { grid: false, environment: 'none', shadows: false },
                lights: [{ type: 'ambient', intensity: 3 }],
                objects: [{
                    type: 'box',
                    size: [2, 2, 2],
                    material: { color: '#ffffff', map: 'red.png', metalness: 0, roughness: 1 },
                }],
            },
            width: 160,
            height: 160,
        });

        // 白色基底 * 红色贴图 → 红色；若贴图未加载会保持高亮白色
        expect(result.pixelStats).not.toBeNull();
        expect(result.pixelStats!.coverage).toBeGreaterThan(0.05);
        expect(result.pixelStats!.meanLuma).toBeLessThan(0.5);
    }, 120_000);

    it.skipIf(!RUN_RENDER)('画面全黑时 coverage 接近 0（供 Agent 识别空场景）', async () => {
        const result = await renderScene3dPreview({
            workspaceRoot,
            spec: {
                schema: 'scene3d/v1',
                background: '#000000',
                render: { grid: false, environment: 'none', shadows: false },
                lights: [{ type: 'ambient', intensity: 0.1 }],
                objects: [{ type: 'box', size: [1, 1, 1], material: { color: '#000000', metalness: 0, roughness: 1 } }],
            },
            width: 200,
            height: 120,
        });

        expect(result.pixelStats).not.toBeNull();
        expect(result.pixelStats!.coverage).toBeLessThan(0.005);
    }, 120_000);
});
