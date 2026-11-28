/**
 * 3D 资产结构解析：glb / gltf / obj / stl / scene3d。
 *
 * 大模型无法直接 read_file 二进制模型，本模块把模型结构压成紧凑文本
 * （节点/网格/三角面/材质/动画/包围盒），让 Agent 能"看见"资产再决定下一步。
 * 纯 Node 实现，不引入 glTF 运行时依赖；包围盒按节点 TRS 逐层变换到世界空间。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { PathUtils } from '@/utils/PathUtils.js';
import {
    collectScene3dRefs,
    formatScene3dIssues,
    validateScene3dSpec,
    type Scene3dVec3,
} from '@/scene3d/spec.js';

export type Scene3dAssetFormat = 'glb' | 'gltf' | 'obj' | 'stl' | 'scene3d';

export interface Scene3dAssetRef {
    src: string;
    exists: boolean;
    bytes?: number;
}

export interface Scene3dAssetInfo {
    path: string;
    format: Scene3dAssetFormat;
    bytes: number;
    summary: string;
    meta: Record<string, any>;
    warnings: string[];
    refs: Scene3dAssetRef[];
}

const GLB_MAGIC = 0x46546c67;
const GLB_CHUNK_JSON = 0x4e4f534a;
const GLB_CHUNK_BIN = 0x004e4942;

const TRIANGLE_MODES = new Set([4]);
const STRIP_MODES = new Set([5, 6]);

type Mat4 = number[];

function identityMatrix(): Mat4 {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiplyMatrices(a: Mat4, b: Mat4): Mat4 {
    const out = new Array<number>(16).fill(0);
    for (let column = 0; column < 4; column += 1) {
        for (let row = 0; row < 4; row += 1) {
            let sum = 0;
            for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[column * 4 + k];
            out[column * 4 + row] = sum;
        }
    }
    return out;
}

function composeTrs(node: any): Mat4 {
    if (Array.isArray(node?.matrix) && node.matrix.length === 16 && node.matrix.every(Number.isFinite)) {
        return node.matrix.slice();
    }
    const t = Array.isArray(node?.translation) ? node.translation : [0, 0, 0];
    const q = Array.isArray(node?.rotation) && node.rotation.length === 4 ? node.rotation : [0, 0, 0, 1];
    const s = Array.isArray(node?.scale) ? node.scale : [1, 1, 1];
    const [x, y, z, w] = q;
    const [sx, sy, sz] = s;
    const xx = x * x;
    const yy = y * y;
    const zz = z * z;
    const xy = x * y;
    const xz = x * z;
    const yz = y * z;
    const wx = w * x;
    const wy = w * y;
    const wz = w * z;
    return [
        (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
        2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
        2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
        t[0] ?? 0, t[1] ?? 0, t[2] ?? 0, 1,
    ];
}

function transformPoint(matrix: Mat4, point: Scene3dVec3): Scene3dVec3 {
    const [x, y, z] = point;
    return [
        matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
        matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
        matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    ];
}

function emptyBounds() {
    return {
        min: [Infinity, Infinity, Infinity] as Scene3dVec3,
        max: [-Infinity, -Infinity, -Infinity] as Scene3dVec3,
        valid: false,
    };
}

function expandBounds(bounds: ReturnType<typeof emptyBounds>, point: Scene3dVec3) {
    for (let index = 0; index < 3; index += 1) {
        if (point[index] < bounds.min[index]) bounds.min[index] = point[index];
        if (point[index] > bounds.max[index]) bounds.max[index] = point[index];
    }
    bounds.valid = true;
}

function finalizeBounds(bounds: ReturnType<typeof emptyBounds>) {
    if (!bounds.valid) return null;
    const round = (value: number) => Math.round(value * 1000) / 1000;
    return {
        min: bounds.min.map(round),
        max: bounds.max.map(round),
        size: bounds.max.map((value, index) => round(value - bounds.min[index])),
    };
}

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '?';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

function formatVec(value: unknown): string {
    if (!Array.isArray(value)) return '?';
    return `[${value.map((entry) => (typeof entry === 'number' ? Math.round(entry * 1000) / 1000 : entry)).join(',')}]`;
}

export function parseGlb(buffer: Buffer): {
    json: any;
    bin: Buffer | null;
    binBytes: number;
    version: number;
    declaredLength: number;
    chunks: Array<{ type: number; length: number }>;
} {
    if (buffer.length < 12) throw new Error('GLB 头部不足 12 字节');
    const magic = buffer.readUInt32LE(0);
    if (magic !== GLB_MAGIC) throw new Error('不是合法的 GLB 文件（magic 不匹配）');
    const version = buffer.readUInt32LE(4);
    if (version !== 2) throw new Error(`不支持的 GLB 版本 ${version}（仅支持 glTF 2.0）`);
    const totalLength = buffer.readUInt32LE(8);
    if (totalLength > buffer.length) throw new Error(`GLB 声明长度 ${totalLength} 超过实际文件大小 ${buffer.length}（文件可能被截断）`);

    let offset = 12;
    let json: any = null;
    let bin: Buffer | null = null;
    let binBytes = 0;
    const chunks: Array<{ type: number; length: number }> = [];
    while (offset + 8 <= totalLength) {
        const chunkLength = buffer.readUInt32LE(offset);
        const chunkType = buffer.readUInt32LE(offset + 4);
        const dataStart = offset + 8;
        if (dataStart + chunkLength > totalLength) throw new Error('GLB chunk 长度越界（文件损坏）');
        chunks.push({ type: chunkType, length: chunkLength });
        if (chunkType === GLB_CHUNK_JSON) {
            const text = buffer.subarray(dataStart, dataStart + chunkLength).toString('utf8').trim();
            json = JSON.parse(text);
        } else if (chunkType === GLB_CHUNK_BIN) {
            binBytes = chunkLength;
            bin = Buffer.from(buffer.subarray(dataStart, dataStart + chunkLength));
        }
        offset = dataStart + chunkLength;
        offset += (4 - (offset % 4)) % 4;
    }
    if (!json) throw new Error('GLB 缺少 JSON chunk');
    return { json, bin, binBytes, version, declaredLength: totalLength, chunks };
}

function summarizeGltfJson(json: any): { meta: Record<string, any>; warnings: string[] } {
    const warnings: string[] = [];
    const meshes: any[] = Array.isArray(json.meshes) ? json.meshes : [];
    const accessors: any[] = Array.isArray(json.accessors) ? json.accessors : [];
    const nodes: any[] = Array.isArray(json.nodes) ? json.nodes : [];

    let primitives = 0;
    let triangles = 0;
    let vertices = 0;
    let morphTargets = 0;
    for (const mesh of meshes) {
        for (const primitive of Array.isArray(mesh?.primitives) ? mesh.primitives : []) {
            primitives += 1;
            const mode = primitive?.mode ?? 4;
            const positionAccessor = primitive?.attributes?.POSITION;
            const positionCount = Number.isInteger(positionAccessor) ? accessors[positionAccessor]?.count ?? 0 : 0;
            const indexCount = Number.isInteger(primitive?.indices) ? accessors[primitive.indices]?.count ?? positionCount : positionCount;
            if (TRIANGLE_MODES.has(mode)) triangles += Math.floor(indexCount / 3);
            else if (STRIP_MODES.has(mode)) triangles += Math.max(0, indexCount - 2);
            else warnings.push(`网格 "${mesh?.name || '?'}" 使用非三角面模式 mode=${mode}，未计入三角面`);
            vertices += positionCount;
            if (primitive?.targets) morphTargets += primitive.targets.length;
        }
    }

    // 世界空间包围盒：沿节点层级复合 TRS
    const bounds = emptyBounds();
    const visit = (nodeIndex: number, parentMatrix: Mat4, depth: number) => {
        if (depth > 64) return;
        const node = nodes[nodeIndex];
        if (!node) return;
        const world = multiplyMatrices(parentMatrix, composeTrs(node));
        if (Number.isInteger(node.mesh)) {
            const mesh = meshes[node.mesh];
            for (const primitive of Array.isArray(mesh?.primitives) ? mesh.primitives : []) {
                const accessor = accessors[primitive?.attributes?.POSITION];
                if (!Array.isArray(accessor?.min) || !Array.isArray(accessor?.max)) continue;
                const [minX, minY, minZ] = accessor.min;
                const [maxX, maxY, maxZ] = accessor.max;
                for (const x of [minX, maxX]) {
                    for (const y of [minY, maxY]) {
                        for (const z of [minZ, maxZ]) expandBounds(bounds, transformPoint(world, [x, y, z]));
                    }
                }
            }
        }
        for (const child of Array.isArray(node.children) ? node.children : []) visit(child, world, depth + 1);
    };
    const sceneIndex = Number.isInteger(json.scene) ? json.scene : 0;
    const sceneNodes = json.scenes?.[sceneIndex]?.nodes;
    if (Array.isArray(sceneNodes)) {
        for (const nodeIndex of sceneNodes) visit(nodeIndex, identityMatrix(), 0);
    } else {
        nodes.forEach((node, index) => {
            if (!Number.isInteger(node?.parent)) visit(index, identityMatrix(), 0);
        });
    }

    const extensionsUsed: string[] = Array.isArray(json.extensionsUsed) ? json.extensionsUsed : [];
    for (const ext of Array.isArray(json.extensionsRequired) ? json.extensionsRequired : []) {
        if (!extensionsUsed.includes(ext)) extensionsUsed.push(ext);
    }
    const unsupported = extensionsUsed.filter((ext) =>
        ext === 'KHR_draco_mesh_compression' || ext === 'EXT_meshopt_compression' || ext === 'KHR_texture_basisu',
    );
    if (unsupported.length > 0) {
        warnings.push(`使用了压缩扩展 ${unsupported.join(', ')}；Web 预览需要额外解码器，建议导出时关闭 Draco/Meshopt/BasisU`);
    }
    if (extensionsUsed.includes('KHR_materials_unlit')) warnings.push('包含 unlit 材质，预览会按 PBR 近似渲染');

    const meta = {
        generator: json.asset?.generator ?? '',
        gltfVersion: json.asset?.version ?? '',
        scenes: Array.isArray(json.scenes) ? json.scenes.length : 0,
        nodes: nodes.length,
        meshes: meshes.length,
        primitives,
        triangles,
        vertices,
        materials: Array.isArray(json.materials) ? json.materials.length : 0,
        textures: Array.isArray(json.textures) ? json.textures.length : 0,
        images: Array.isArray(json.images) ? json.images.length : 0,
        animations: Array.isArray(json.animations) ? json.animations.length : 0,
        animationNames: (Array.isArray(json.animations) ? json.animations : []).map((item: any) => item?.name).filter(Boolean).slice(0, 5),
        skins: Array.isArray(json.skins) ? json.skins.length : 0,
        morphTargets,
        extensionsUsed,
        bounds: finalizeBounds(bounds),
    };
    if (triangles > 300_000) warnings.push(`三角面 ${triangles} 偏高，Web 端建议 ≤10 万（可减面或做 LOD）`);
    return { meta, warnings };
}

async function inspectGltfLike(
    buffer: Buffer,
    format: 'glb' | 'gltf',
    relPath: string,
    workspaceRoot: string,
): Promise<Scene3dAssetInfo> {
    let json: any;
    let binBytes = 0;
    if (format === 'glb') {
        const parsed = parseGlb(buffer);
        json = parsed.json;
        binBytes = parsed.binBytes;
    } else {
        try {
            json = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''));
        } catch (error: any) {
            throw new Error(`glTF JSON 解析失败：${error?.message || error}`);
        }
    }
    if (!json || typeof json !== 'object') throw new Error('glTF 内容不是 JSON 对象');
    if (json.asset?.version && String(json.asset.version) !== '2.0') {
        throw new Error(`不支持的 glTF 版本 ${json.asset.version}（仅支持 2.0）`);
    }
    const { meta, warnings } = summarizeGltfJson(json);
    if (format === 'glb' && binBytes > 0) meta.binBytes = binBytes;

    const refs: Scene3dAssetRef[] = [];
    const baseDir = path.dirname(relPath);
    for (const entry of Array.isArray(json.buffers) ? json.buffers : []) {
        if (typeof entry?.uri === 'string' && !entry.uri.startsWith('data:')) {
            const target = path.posix.normalize(path.posix.join(baseDir.replace(/\\/g, '/'), entry.uri));
            const exists = await fileExistsInWorkspace(target, workspaceRoot);
            refs.push({ src: entry.uri, exists: exists.exists, bytes: exists.bytes });
            if (!exists.exists) warnings.push(`外部 buffer 缺失：${entry.uri}（.gltf 需连同 .bin 一起拷贝，或改用 .glb 单文件）`);
        }
    }
    for (const entry of Array.isArray(json.images) ? json.images : []) {
        if (typeof entry?.uri === 'string' && !entry.uri.startsWith('data:')) {
            const target = path.posix.normalize(path.posix.join(baseDir.replace(/\\/g, '/'), entry.uri));
            const exists = await fileExistsInWorkspace(target, workspaceRoot);
            refs.push({ src: entry.uri, exists: exists.exists, bytes: exists.bytes });
            if (!exists.exists) warnings.push(`贴图缺失：${entry.uri}`);
        }
    }

    const header = `[3d] ${format.toUpperCase()} ${formatBytes(buffer.length)}` +
        (meta.generator ? ` | generator="${meta.generator}"` : '') +
        ` | scenes=${meta.scenes} nodes=${meta.nodes} meshes=${meta.meshes} prims=${meta.primitives}` +
        ` tris=${meta.triangles.toLocaleString('en-US')} verts=${meta.vertices.toLocaleString('en-US')}` +
        ` materials=${meta.materials} textures=${meta.textures} anims=${meta.animations} skins=${meta.skins}`;
    const boundsLine = meta.bounds
        ? ` bounds min=${formatVec(meta.bounds.min)} max=${formatVec(meta.bounds.max)} size=${formatVec(meta.bounds.size)}`
        : ' bounds unknown';
    const extLine = meta.extensionsUsed.length > 0 ? `\n extensions=${meta.extensionsUsed.join(', ')}` : '';
    const animLine = meta.animationNames?.length ? `\n animations=${meta.animationNames.join(', ')}` : '';
    const summary = header + boundsLine + extLine + animLine;

    return { path: relPath, format, bytes: buffer.length, summary, meta, warnings, refs };
}

/** 相对路径存在性检查：以工作区文件所在目录为基准，禁止越出工作区 */
async function fileExistsInWorkspace(target: string, workspaceRoot: string) {
    if (target.startsWith('..')) return { exists: false, bytes: undefined };
    try {
        const absolute = PathUtils.resolveWritePath(target, workspaceRoot);
        const stat = await fs.stat(absolute);
        return { exists: stat.isFile(), bytes: stat.size };
    } catch {
        return { exists: false, bytes: undefined };
    }
}

async function inspectObj(buffer: Buffer, relPath: string): Promise<Scene3dAssetInfo> {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    if (text.includes('\u0000')) throw new Error('OBJ 内容含 null 字节，疑似二进制文件');
    let vertices = 0;
    let faces = 0;
    let triangles = 0;
    let normals = 0;
    let uvs = 0;
    let groups = 0;
    const materials = new Set<string>();
    const mtlLibs = new Set<string>();
    const bounds = emptyBounds();
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const space = line.indexOf(' ');
        if (space < 0) continue;
        const keyword = line.slice(0, space);
        const rest = line.slice(space + 1).trim();
        if (keyword === 'v') {
            const parts = rest.split(/\s+/).slice(0, 3).map(Number);
            if (parts.length === 3 && parts.every(Number.isFinite)) {
                vertices += 1;
                expandBounds(bounds, [parts[0], parts[1], parts[2]]);
            }
        } else if (keyword === 'vn') {
            normals += 1;
        } else if (keyword === 'vt') {
            uvs += 1;
        } else if (keyword === 'f') {
            const count = rest.split(/\s+/).filter(Boolean).length;
            if (count >= 3) {
                faces += 1;
                triangles += count - 2;
            }
        } else if (keyword === 'o' || keyword === 'g') {
            groups += 1;
        } else if (keyword === 'usemtl') {
            materials.add(rest);
        } else if (keyword === 'mtllib') {
            mtlLibs.add(rest);
        }
    }
    const warnings: string[] = [];
    if (vertices === 0) throw new Error('OBJ 未解析到任何顶点（v 行），文件可能无效或为空');
    if (mtlLibs.size > 0) warnings.push(`引用了材质库 ${Array.from(mtlLibs).join(', ')}；IDE 预览不加载 .mtl，颜色按默认材质显示`);
    if (triangles > 300_000) warnings.push(`三角面 ${triangles} 偏高，Web 端建议 ≤10 万`);
    const meta = {
        vertices,
        faces,
        triangles,
        normals,
        uvs,
        groups,
        materials: Array.from(materials).slice(0, 12),
        mtlLibs: Array.from(mtlLibs),
        bounds: finalizeBounds(bounds),
    };
    const summary = `[3d] OBJ ${formatBytes(buffer.length)} | verts=${vertices} faces=${faces} tris=${triangles}` +
        ` normals=${normals} uvs=${uvs} groups=${groups} materials=${materials.size}` +
        (meta.bounds ? `\n bounds min=${formatVec(meta.bounds.min)} max=${formatVec(meta.bounds.max)} size=${formatVec(meta.bounds.size)}` : '');
    return { path: relPath, format: 'obj', bytes: buffer.length, summary, meta, warnings, refs: [] };
}

async function inspectStl(buffer: Buffer, relPath: string): Promise<Scene3dAssetInfo> {
    const warnings: string[] = [];
    const bounds = emptyBounds();
    let triangles = 0;
    let ascii = false;
    const declared = buffer.length >= 84 ? buffer.readUInt32LE(80) : 0;
    const isBinary = declared > 0 && 84 + declared * 50 === buffer.length;
    if (isBinary) {
        triangles = declared;
        for (let index = 0; index < triangles; index += 1) {
            const base = 84 + index * 50 + 12;
            for (let vertex = 0; vertex < 3; vertex += 1) {
                const offset = base + vertex * 12;
                expandBounds(bounds, [
                    buffer.readFloatLE(offset),
                    buffer.readFloatLE(offset + 4),
                    buffer.readFloatLE(offset + 8),
                ]);
            }
        }
    } else {
        ascii = true;
        const text = buffer.toString('utf8');
        if (!/solid/i.test(text.slice(0, 512))) throw new Error('STL 既不是合法二进制（长度不匹配）也不含 solid 头，文件可能损坏');
        let vertexBuffer: Scene3dVec3[] = [];
        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (trimmed.startsWith('facet')) {
                triangles += 1;
                vertexBuffer = [];
            } else if (trimmed.startsWith('vertex')) {
                const parts = trimmed.split(/\s+/).slice(1, 4).map(Number);
                if (parts.length === 3 && parts.every(Number.isFinite)) {
                    vertexBuffer.push([parts[0], parts[1], parts[2]]);
                    if (vertexBuffer.length === 3) {
                        for (const point of vertexBuffer) expandBounds(bounds, point);
                    }
                }
            }
        }
    }
    if (triangles === 0) throw new Error('STL 未解析到三角面');
    if (triangles > 300_000) warnings.push(`三角面 ${triangles} 偏高，Web 端建议 ≤10 万`);
    const meta = { triangles, vertices: triangles * 3, ascii, bounds: finalizeBounds(bounds) };
    const summary = `[3d] STL ${formatBytes(buffer.length)} (${ascii ? 'ascii' : 'binary'}) | tris=${triangles}` +
        (meta.bounds ? `\n bounds min=${formatVec(meta.bounds.min)} max=${formatVec(meta.bounds.max)} size=${formatVec(meta.bounds.size)}` : '');
    return { path: relPath, format: 'stl', bytes: buffer.length, summary, meta, warnings, refs: [] };
}

async function inspectScene3dFile(buffer: Buffer, relPath: string, workspaceRoot: string): Promise<Scene3dAssetInfo> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''));
    } catch (error: any) {
        throw new Error(`场景 JSON 解析失败：${error?.message || error}`);
    }
    const validation = validateScene3dSpec(parsed);
    if (!validation.ok) {
        throw new Error(`场景规范校验失败：\n${formatScene3dIssues(validation)}`);
    }

    const refs: Scene3dAssetRef[] = [];
    const warnings = validation.warnings.map((issue) => `${issue.path}: ${issue.message}`);
    const baseDir = path.dirname(relPath).replace(/\\/g, '/');
    for (const src of collectScene3dRefs(validation.spec!)) {
        if (/^(?:[a-zA-Z]:[\\/]|\/|data:|https?:)/.test(src)) {
            refs.push({ src, exists: true });
            continue;
        }
        const target = path.posix.normalize(path.posix.join(baseDir, src));
        try {
            const absolute = PathUtils.resolveWritePath(target, workspaceRoot);
            const stat = await fs.stat(absolute);
            refs.push({ src, exists: stat.isFile(), bytes: stat.size });
            if (!stat.isFile()) warnings.push(`引用不是文件：${src}`);
        } catch {
            refs.push({ src, exists: false });
            warnings.push(`引用缺失：${src}`);
        }
    }

    const meta = {
        objects: validation.summary,
        estimatedTriangles: validation.estimatedTriangles,
        refs,
        name: validation.spec?.name ?? '',
        schema: validation.spec?.schema,
    };
    const summary = `[3d] scene3d/v1 ${formatBytes(buffer.length)} | ${validation.summary}` +
        (refs.length > 0
            ? `\n refs: ${refs.map((ref) => `${ref.src}(${ref.exists ? formatBytes(ref.bytes ?? 0) : 'missing'})`).join(', ')}`
            : '');
    return { path: relPath, format: 'scene3d', bytes: buffer.length, summary, meta, warnings, refs };
}

export function detectScene3dFormat(relPath: string): Scene3dAssetFormat | null {
    const lower = relPath.toLowerCase();
    if (lower.endsWith('.scene3d.json')) return 'scene3d';
    if (lower.endsWith('.glb')) return 'glb';
    if (lower.endsWith('.gltf')) return 'gltf';
    if (lower.endsWith('.obj')) return 'obj';
    if (lower.endsWith('.stl')) return 'stl';
    return null;
}

export async function inspectScene3dAsset(workspaceRoot: string, unsafePath: string): Promise<Scene3dAssetInfo> {
    const format = detectScene3dFormat(unsafePath);
    if (!format) throw new Error(`不支持的 3D 资产类型：${unsafePath}（支持 .glb/.gltf/.obj/.stl/.scene3d.json）`);
    const absolute = PathUtils.resolveReadPath(unsafePath, workspaceRoot);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error(`不是文件：${unsafePath}`);
    const buffer = await fs.readFile(absolute);
    const relPath = PathUtils.getRelativePath(absolute, workspaceRoot).replace(/\\/g, '/');

    if (format === 'scene3d') return inspectScene3dFile(buffer, relPath, workspaceRoot);
    if (format === 'obj') return inspectObj(buffer, relPath);
    if (format === 'stl') return inspectStl(buffer, relPath);
    return inspectGltfLike(buffer, format, relPath, workspaceRoot);
}

export function formatScene3dAssetInfo(info: Scene3dAssetInfo, maxWarnings = 6): string {
    const lines = [info.summary];
    if (info.warnings.length > 0) {
        for (const warning of info.warnings.slice(0, maxWarnings)) lines.push(` ⚠ ${warning}`);
        if (info.warnings.length > maxWarnings) lines.push(` ⚠ …另有 ${info.warnings.length - maxWarnings} 条`);
    }
    return lines.join('\n');
}
