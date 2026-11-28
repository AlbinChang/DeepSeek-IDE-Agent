import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    checkScene3dContent,
    checkScene3dDirectory,
    checkScene3dFile,
    formatScene3dCheckBatch,
    formatScene3dCheckReport,
    readImageHeader,
} from './assetChecker.js';
import { ensureScene3dScaffold, upsertScene3dAsset, readScene3dManifest, writeScene3dManifest } from './manifest.js';
import { hashFile } from './manifest.js';

const POSITIONS = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
const INDICES = new Uint16Array([0, 1, 2]);

function buildTriangleBin(indices: Uint16Array = INDICES): Buffer {
    const buffer = Buffer.alloc(36 + 6);
    Buffer.from(POSITIONS.buffer).copy(buffer, 0);
    Buffer.from(indices.buffer).copy(buffer, 36);
    return buffer;
}

function baseGltf(overrides: Record<string, any> = {}): Record<string, any> {
    return {
        asset: { version: '2.0', generator: 'vitest' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
        buffers: [{ uri: 'tri.bin', byteLength: 42 }],
        bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
            { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
        ],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
            { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
        ],
        ...overrides,
    };
}

function buildGlb(json: Record<string, any>, bin: Buffer): Buffer {
    const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
    const jsonPadded = Buffer.concat([jsonBuffer, Buffer.alloc((4 - (jsonBuffer.length % 4)) % 4, 0x20)]);
    const binPadded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4, 0)]);
    const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(total, 8);
    const jsonHeader = Buffer.alloc(8);
    jsonHeader.writeUInt32LE(jsonPadded.length, 0);
    jsonHeader.writeUInt32LE(0x4e4f534a, 4);
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(binPadded.length, 0);
    binHeader.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, jsonHeader, jsonPadded, binHeader, binPadded]);
}

function glbJson(): Record<string, any> {
    return baseGltf({ buffers: [{ byteLength: 42 }] });
}

function pngHeader(width: number, height: number): Buffer {
    const buffer = Buffer.alloc(26);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
    buffer.writeUInt32BE(13, 8);
    buffer.write('IHDR', 12, 'ascii');
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    buffer[24] = 8;
    buffer[25] = 6;
    return buffer;
}

const VALID_SCENE = {
    schema: 'scene3d/v1',
    background: '#0b0d12',
    camera: { position: [3, 2, 5], target: [0, 0.5, 0] },
    lights: [{ type: 'directional', position: [4, 8, 4], intensity: 2 }],
    objects: [{ type: 'box', size: [1, 1, 1], position: [0, 0.5, 0], material: { color: '#4f9cff' } }],
};

function codes(report: { issues: Array<{ code: string }> }): string[] {
    return report.issues.map((issue) => issue.code);
}

describe('3D 资产编译检查', () => {
    let workspaceRoot = '';

    beforeAll(async () => {
        workspaceRoot = await mkdtemp(path.join(tmpdir(), 'scene3d-check-'));
        await writeFile(path.join(workspaceRoot, 'tri.bin'), buildTriangleBin());
        await writeFile(path.join(workspaceRoot, 'good.gltf'), JSON.stringify(baseGltf()));
        await writeFile(path.join(workspaceRoot, 'good.glb'), buildGlb(glbJson(), buildTriangleBin()));
        await writeFile(path.join(workspaceRoot, 'tri.obj'), ['v -1 -1 0', 'v 1 -1 0', 'v 0 1 0', 'f 1 2 3'].join('\n'));
        await writeFile(path.join(workspaceRoot, 'bad.obj'), ['v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 9'].join('\n'));
        await writeFile(path.join(workspaceRoot, 'tri.stl'), buildStl([[-1, -1, 0], [1, -1, 0], [0, 1, 0]]));
        await writeFile(path.join(workspaceRoot, 'red.png'), Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64',
        ));
        await writeFile(path.join(workspaceRoot, 'not-image.png'), 'hello');
        await mkdir(path.join(workspaceRoot, '.3d', 'scenes'), { recursive: true });
        await writeFile(path.join(workspaceRoot, '.3d', 'scenes', 'good.scene3d.json'), JSON.stringify(VALID_SCENE));
    });

    afterAll(async () => {
        if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true });
    });

    // ── scene3d ──
    it('合法场景通过', async () => {
        const report = await checkScene3dFile(workspaceRoot, '.3d/scenes/good.scene3d.json');

        expect(report.status).toBe('OK');
        expect(report.errorCount).toBe(0);
        expect(formatScene3dCheckReport(report)).toContain('[check_3d] OK');
    });

    it('缺失模型引用判错', async () => {
        await writeFile(
            path.join(workspaceRoot, '.3d', 'scenes', 'missing.scene3d.json'),
            JSON.stringify({ schema: 'scene3d/v1', objects: [{ type: 'model', src: '../models/nope.glb' }] }),
        );
        const report = await checkScene3dFile(workspaceRoot, '.3d/scenes/missing.scene3d.json');

        expect(report.status).toBe('ERROR');
        expect(codes(report)).toContain('SCENE3D_REF_MISSING');
    });

    it('零灯光、相机重合与相机在物体内部', async () => {
        await writeFile(
            path.join(workspaceRoot, '.3d', 'scenes', 'camera.scene3d.json'),
            JSON.stringify({
                schema: 'scene3d/v1',
                camera: { position: [0, 0, 0], target: [0, 0, 0] },
                lights: [{ type: 'ambient', intensity: 0 }],
                objects: [{ type: 'box', size: [4, 4, 4] }],
            }),
        );
        const report = await checkScene3dFile(workspaceRoot, '.3d/scenes/camera.scene3d.json');

        expect(codes(report)).toContain('SCENE3D_CAMERA_DEGENERATE');
        expect(codes(report)).toContain('SCENE3D_LIGHTS_ZERO');
        expect(codes(report)).toContain('SCENE3D_CAMERA_INSIDE');
    });

    it('非法贴图引用判错，合法贴图通过', async () => {
        await writeFile(
            path.join(workspaceRoot, '.3d', 'scenes', 'texture.scene3d.json'),
            JSON.stringify({
                schema: 'scene3d/v1',
                lights: [{ type: 'ambient', intensity: 1 }],
                objects: [{ type: 'plane', material: { map: '../textures/missing.png' } }],
            }),
        );
        const missing = await checkScene3dFile(workspaceRoot, '.3d/scenes/texture.scene3d.json');

        expect(codes(missing)).toContain('SCENE3D_REF_MISSING');

        await mkdir(path.join(workspaceRoot, '.3d', 'textures'), { recursive: true });
        await writeFile(path.join(workspaceRoot, '.3d', 'textures', 'bad.png'), 'hello');
        await writeFile(
            path.join(workspaceRoot, '.3d', 'scenes', 'texture2.scene3d.json'),
            JSON.stringify({
                schema: 'scene3d/v1',
                lights: [{ type: 'ambient', intensity: 1 }],
                objects: [{ type: 'plane', material: { map: '../textures/bad.png' } }],
            }),
        );
        const bad = await checkScene3dFile(workspaceRoot, '.3d/scenes/texture2.scene3d.json');

        expect(codes(bad)).toContain('TEXTURE_FORMAT_UNKNOWN');
    });

    it('content 预检可在写入前发现规范错误', async () => {
        const report = await checkScene3dContent(workspaceRoot, JSON.stringify({ objects: [{ type: 'nope' }] }), {
            format: 'scene3d',
        });

        expect(report.status).toBe('ERROR');
        expect(codes(report)).toContain('SCENE3D_SPEC');
    });

    // ── glTF / GLB ──
    it('合法 glTF / GLB 通过（含深度索引与包围盒校验）', async () => {
        const gltf = await checkScene3dFile(workspaceRoot, 'good.gltf');
        const glb = await checkScene3dFile(workspaceRoot, 'good.glb');

        expect(gltf.status).toBe('OK');
        expect(glb.status).toBe('OK');
        expect(gltf.stats.triangles).toBe(1);
        expect(glb.stats.binBytes).toBe(44);
    });

    it('accessor 越界', async () => {
        const json = baseGltf({
            accessors: [
                { bufferView: 0, componentType: 5126, count: 10, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
                { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
            ],
        });
        await writeFile(path.join(workspaceRoot, 'oob.gltf'), JSON.stringify(json));
        const report = await checkScene3dFile(workspaceRoot, 'oob.gltf');

        expect(codes(report)).toContain('GLTF_ACCESSOR_OOB');
    });

    it('索引越界与退化三角形', async () => {
        await writeFile(path.join(workspaceRoot, 'bad-index.bin'), buildTriangleBin(new Uint16Array([0, 1, 9])));
        await writeFile(
            path.join(workspaceRoot, 'bad-index.gltf'),
            JSON.stringify(baseGltf({ buffers: [{ uri: 'bad-index.bin', byteLength: 42 }] })),
        );
        const report = await checkScene3dFile(workspaceRoot, 'bad-index.gltf');

        expect(codes(report)).toContain('GLTF_INDEX_OUT_OF_RANGE');
    });

    it('POSITION 声明包围盒与实际数据不一致', async () => {
        const json = baseGltf({
            accessors: [
                { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-2, -1, 0], max: [1, 1, 0] },
                { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
            ],
        });
        await writeFile(path.join(workspaceRoot, 'bounds.gltf'), JSON.stringify(json));
        const report = await checkScene3dFile(workspaceRoot, 'bounds.gltf');

        expect(codes(report)).toContain('GLTF_POSITION_BOUNDS_MISMATCH');
    });

    it('节点环与多父节点', async () => {
        await writeFile(
            path.join(workspaceRoot, 'cycle.gltf'),
            JSON.stringify(baseGltf({
                nodes: [{ children: [1] }, { children: [0] }],
                scenes: [{ nodes: [0] }],
                meshes: [],
            })),
        );
        const cycle = await checkScene3dFile(workspaceRoot, 'cycle.gltf');

        expect(codes(cycle)).toContain('GLTF_NODE_CYCLE');

        await writeFile(
            path.join(workspaceRoot, 'multi-parent.gltf'),
            JSON.stringify(baseGltf({
                nodes: [{ children: [1] }, { mesh: 0 }, { children: [1] }],
                scenes: [{ nodes: [0, 2] }],
            })),
        );
        const multi = await checkScene3dFile(workspaceRoot, 'multi-parent.gltf');

        expect(codes(multi)).toContain('GLTF_NODE_MULTI_PARENT');
    });

    it('动画 output 数量不匹配', async () => {
        const bin = Buffer.alloc(42 + 8 + 24 + 4);
        Buffer.from(POSITIONS.buffer).copy(bin, 0);
        Buffer.from(INDICES.buffer).copy(bin, 36);
        bin.writeFloatLE(0, 42);
        bin.writeFloatLE(1, 46);
        await writeFile(path.join(workspaceRoot, 'anim.bin'), bin);
        const json = baseGltf({
            buffers: [{ uri: 'anim.bin', byteLength: bin.length }],
            bufferViews: [
                { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
                { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
                { buffer: 0, byteOffset: 42, byteLength: 8 },
                { buffer: 0, byteOffset: 50, byteLength: 24 },
            ],
            accessors: [
                { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
                { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
                { bufferView: 2, componentType: 5126, count: 2, type: 'SCALAR' },
                { bufferView: 3, componentType: 5126, count: 1, type: 'VEC3' },
            ],
            animations: [{
                samplers: [{ input: 2, output: 3 }],
                channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }],
            }],
        });
        await writeFile(path.join(workspaceRoot, 'anim.gltf'), JSON.stringify(json));
        const report = await checkScene3dFile(workspaceRoot, 'anim.gltf');

        expect(codes(report)).toContain('GLTF_ANIMATION_OUTPUT_COUNT');
    });

    it('蒙皮 IBM 数量不匹配', async () => {
        const bin = Buffer.concat([buildTriangleBin(), Buffer.alloc(64)]);
        await writeFile(path.join(workspaceRoot, 'skin.bin'), bin);
        const json = baseGltf({
            buffers: [{ uri: 'skin.bin', byteLength: bin.length }],
            bufferViews: [
                { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
                { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 },
                { buffer: 0, byteOffset: 42, byteLength: 64 },
            ],
            accessors: [
                { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
                { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
                { bufferView: 2, componentType: 5126, count: 1, type: 'MAT4' },
            ],
            nodes: [{ mesh: 0 }, {}],
            skins: [{ joints: [0, 1], inverseBindMatrices: 2 }],
        });
        await writeFile(path.join(workspaceRoot, 'skin.gltf'), JSON.stringify(json));
        const report = await checkScene3dFile(workspaceRoot, 'skin.gltf');

        expect(codes(report)).toContain('GLTF_SKIN_IBM_COUNT');
    });

    it('外部 buffer 缺失与 GLB 容器损坏', async () => {
        await writeFile(
            path.join(workspaceRoot, 'no-bin.gltf'),
            JSON.stringify(baseGltf({ buffers: [{ uri: 'nope.bin', byteLength: 42 }] })),
        );
        const missing = await checkScene3dFile(workspaceRoot, 'no-bin.gltf');
        expect(codes(missing)).toContain('GLTF_BUFFER_MISSING');

        await writeFile(path.join(workspaceRoot, 'bad.glb'), Buffer.from('not a glb'));
        const bad = await checkScene3dFile(workspaceRoot, 'bad.glb');
        expect(codes(bad)).toContain('GLB_CONTAINER');
    });

    // ── OBJ / STL / 贴图 ──
    it('OBJ 面索引越界 / 合法文件', async () => {
        const ok = await checkScene3dFile(workspaceRoot, 'tri.obj');
        const bad = await checkScene3dFile(workspaceRoot, 'bad.obj');

        expect(ok.status).toBe('OK');
        expect(bad.status).toBe('ERROR');
        expect(codes(bad)).toContain('OBJ_FACE_OOB');
    });

    it('OBJ 材质库缺失与非法顶点', async () => {
        await writeFile(
            path.join(workspaceRoot, 'mtl.obj'),
            ['mtllib missing.mtl', 'usemtl red', 'v 0 0 0', 'v NaN 0 0', 'v 0 1 0', 'f 1 2 3'].join('\n'),
        );
        const report = await checkScene3dFile(workspaceRoot, 'mtl.obj');

        expect(codes(report)).toContain('OBJ_VERTEX_INVALID');
        expect(codes(report)).toContain('OBJ_MTL_MISSING');
    });

    it('STL 合法 / 长度不匹配 / 退化面', async () => {
        const ok = await checkScene3dFile(workspaceRoot, 'tri.stl');
        expect(ok.status).toBe('OK');

        const mismatch = buildStl([[-1, -1, 0], [1, -1, 0], [0, 1, 0]]);
        mismatch.writeUInt32LE(2, 80);
        await writeFile(path.join(workspaceRoot, 'bad.stl'), mismatch);
        const broken = await checkScene3dFile(workspaceRoot, 'bad.stl');
        expect(codes(broken)).toContain('STL_LENGTH_MISMATCH');

        await writeFile(path.join(workspaceRoot, 'degenerate.stl'), buildStl([[0, 0, 0], [0, 0, 0], [0, 0, 0]]));
        const degenerate = await checkScene3dFile(workspaceRoot, 'degenerate.stl');
        expect(codes(degenerate)).toContain('STL_DEGENERATE');
    });

    it('贴图头解析 / 非法格式 / 超大尺寸', async () => {
        const header = readImageHeader(pngHeader(4096, 2048));
        expect(header).toMatchObject({ format: 'png', width: 4096, height: 2048 });

        const ok = await checkScene3dFile(workspaceRoot, 'red.png');
        expect(ok.status).toBe('OK');

        const bad = await checkScene3dFile(workspaceRoot, 'not-image.png');
        expect(codes(bad)).toContain('TEXTURE_FORMAT_UNKNOWN');

        await writeFile(path.join(workspaceRoot, 'huge.png'), pngHeader(4096, 2048));
        const huge = await checkScene3dFile(workspaceRoot, 'huge.png');
        expect(codes(huge)).toContain('TEXTURE_TOO_LARGE');
    });

    // ── manifest / 批量 ──
    it('manifest 缺失文件 / 哈希漂移 / 重复 id', async () => {
        await ensureScene3dScaffold(workspaceRoot);
        const modelPath = path.join(workspaceRoot, '.3d', 'models', 'a.obj');
        await mkdir(path.dirname(modelPath), { recursive: true });
        await writeFile(modelPath, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
        const absolute = path.resolve(modelPath);
        const size = (await stat(absolute)).size;
        const hash = await hashFile(absolute);
        await upsertScene3dAsset(workspaceRoot, {
            id: 'a',
            name: 'A',
            kind: 'model',
            path: '.3d/models/a.obj',
            bytes: size,
            hash,
            preview: '.3d/renders/a.png',
        });

        const ok = await checkScene3dFile(workspaceRoot, '.3d/manifest.json');
        expect(ok.status).toBe('WARN');
        expect(codes(ok)).toContain('MANIFEST_PREVIEW_MISSING');

        await writeFile(modelPath, 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n# changed\n');
        const drifted = await checkScene3dFile(workspaceRoot, '.3d/manifest.json');
        expect(codes(drifted)).toContain('MANIFEST_HASH_MISMATCH');
        expect(codes(drifted)).toContain('MANIFEST_SIZE_MISMATCH');

        const manifest = await readScene3dManifest(workspaceRoot);
        manifest.assets.push({ ...manifest.assets[0], path: '.3d/models/b.obj' });
        await writeScene3dManifest(workspaceRoot, manifest);
        const duplicated = await checkScene3dFile(workspaceRoot, '.3d/manifest.json');
        expect(codes(duplicated)).toContain('MANIFEST_DUPLICATE_ID');
    });

    it('目录批量体检查出坏文件并保留坏文件明细', async () => {
        const batch = await checkScene3dDirectory(workspaceRoot, '.3d');
        const text = formatScene3dCheckBatch(batch);

        expect(batch.reports.some((report) => report.format === 'manifest')).toBe(true);
        expect(text).toContain('[check_3d]');
        expect(text).toContain('.3d/scenes/good.scene3d.json');
    });
});

function buildStl(vertices: Array<[number, number, number]>): Buffer {
    const triangles = Math.max(1, Math.ceil(vertices.length / 3));
    const buffer = Buffer.alloc(84 + 50 * triangles, 0);
    buffer.write('binary stl fixture', 0, 'utf8');
    buffer.writeUInt32LE(triangles, 80);
    buffer.writeFloatLE(0, 84);
    buffer.writeFloatLE(0, 88);
    buffer.writeFloatLE(1, 92);
    for (let index = 0; index < vertices.length; index += 1) {
        const offset = 84 + 12 + index * 12;
        const vertex = vertices[index];
        buffer.writeFloatLE(vertex[0], offset);
        buffer.writeFloatLE(vertex[1], offset + 4);
        buffer.writeFloatLE(vertex[2], offset + 8);
    }
    return buffer;
}
