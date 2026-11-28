/**
 * 3D 资产静态"编译检查"：不渲染、不依赖浏览器，先把能静态发现的问题全部找出来。
 *
 * 覆盖：
 * - scene3d/v1：规范校验、引用存在性、贴图头信息、光照/相机合理性、模型三角面与尺度
 * - glTF / GLB：容器完整性、buffer/bufferView/accessor 越界、索引越界、节点环与多父节点、
 *   材质/纹理/动画/蒙皮引用、POSITION min/max 与实际数据一致性、法线单位化等
 * - OBJ：面索引越界/退化面/顶点与法线合法性/材质库存在性
 * - STL：二进制长度、退化三角面、法线一致性
 * - 贴图：格式识别、尺寸/2 的幂/体积预算
 * - manifest：重复 id/path、文件缺失、大小/哈希漂移、kind 与目录不一致
 *
 * 输出风格对齐 check_svg：紧凑文本 + 精确位置（JSON 路径或行号）+ 修复建议。
 */

import { promises as fs } from 'node:fs';
import { readdirSync, type Dirent } from 'node:fs';
import * as path from 'node:path';
import crypto from 'node:crypto';
import { PathUtils } from '@/utils/PathUtils.js';
import {
    detectScene3dFormat,
    formatBytes,
    inspectScene3dAsset,
    parseGlb,
} from '@/scene3d/assetInspector.js';
import {
    collectScene3dRefs,
    SCENE3D_MAX_SPEC_BYTES,
    validateScene3dSpec,
} from '@/scene3d/spec.js';
import {
    normalizeAssetPath,
    readScene3dManifest,
    toAssetSlug,
    SCENE3D_DIR,
    SCENE3D_MANIFEST_PATH,
    SCENE3D_TEMP_DIR,
} from '@/scene3d/manifest.js';

export type Scene3dCheckFormat = 'scene3d' | 'glb' | 'gltf' | 'obj' | 'stl' | 'texture' | 'manifest';

export interface Scene3dCheckIssue {
    severity: 'error' | 'warning';
    code: string;
    location: string;
    message: string;
    fix?: string;
}

export interface Scene3dCheckReport {
    status: 'OK' | 'WARN' | 'ERROR';
    target: string;
    format: Scene3dCheckFormat;
    stats: Record<string, string | number>;
    issues: Scene3dCheckIssue[];
    errorCount: number;
    warningCount: number;
    totalIssues: number;
    durationMs: number;
}

export interface Scene3dCheckBatch {
    target: string;
    reports: Scene3dCheckReport[];
    errorCount: number;
    warningCount: number;
    durationMs: number;
    skippedFiles: number;
}

export interface Scene3dCheckOptions {
    content?: string;
    deep?: boolean;
    maxIssues?: number;
    filePath?: string;
}

const MAX_STORED_ISSUES = 400;
const MAX_DEEP_VALUES = 1_200_000;
const MAX_TEXTURE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_HEADER_BYTES = 64 * 1024;
const MAX_BUFFER_BYTES = 200 * 1024 * 1024;
const MAX_BATCH_FILES = 120;
const MAX_BATCH_DEPTH = 5;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ktx2']);
const MODEL_EXTENSIONS = new Set(['.glb', '.gltf', '.obj', '.stl']);
const SUPPORTED_RENDER_EXTENSIONS = new Set([
    'KHR_materials_unlit',
    'KHR_texture_transform',
    'KHR_materials_emissive_strength',
    'KHR_mesh_quantization',
]);
const UNSUPPORTED_RENDER_EXTENSIONS = new Set([
    'KHR_draco_mesh_compression',
    'EXT_meshopt_compression',
    'KHR_texture_basisu',
]);

const COMPONENT_SIZE: Record<number, number> = {
    5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4,
};
const TYPE_COMPONENTS: Record<string, number> = {
    SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
};
const INDEX_TYPES = new Set([5121, 5123, 5125]);
const ANIMATION_PATHS = new Set(['translation', 'rotation', 'scale', 'weights']);

class IssueCollector {
    readonly issues: Scene3dCheckIssue[] = [];
    errorCount = 0;
    warningCount = 0;

    error(code: string, location: string, message: string, fix?: string): void {
        this.push('error', code, location, message, fix);
    }

    warn(code: string, location: string, message: string, fix?: string): void {
        this.push('warning', code, location, message, fix);
    }

    private push(severity: 'error' | 'warning', code: string, location: string, message: string, fix?: string): void {
        if (severity === 'error') this.errorCount += 1;
        else this.warningCount += 1;
        if (this.issues.length < MAX_STORED_ISSUES) {
            this.issues.push({ severity, code, location, message, fix });
        }
    }
}

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value);
}

function isIndex(value: unknown, length: number): value is number {
    return isInt(value) && value >= 0 && value < length;
}

function finalizeReport(
    target: string,
    format: Scene3dCheckFormat,
    collector: IssueCollector,
    stats: Record<string, string | number>,
    maxIssues: number,
    startedAt: number,
): Scene3dCheckReport {
    const totalIssues = collector.errorCount + collector.warningCount;
    const limit = Math.max(1, Math.min(200, Math.round(maxIssues || 30)));
    return {
        status: collector.errorCount > 0 ? 'ERROR' : collector.warningCount > 0 ? 'WARN' : 'OK',
        target,
        format,
        stats,
        issues: collector.issues.slice(0, limit),
        errorCount: collector.errorCount,
        warningCount: collector.warningCount,
        totalIssues,
        durationMs: Date.now() - startedAt,
    };
}

// ═══════════════════════════════════════════════════════════════
// 图片头解析（PNG / JPEG / WebP / KTX2）
// ═══════════════════════════════════════════════════════════════

export interface ImageHeader {
    format: 'png' | 'jpeg' | 'webp' | 'ktx2' | 'unknown';
    width?: number;
    height?: number;
    bitDepth?: number;
}

export function readImageHeader(buffer: Buffer): ImageHeader {
    if (buffer.length >= 26 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.toString('ascii', 12, 16) === 'IHDR') {
        return {
            format: 'png',
            width: buffer.readUInt32BE(16),
            height: buffer.readUInt32BE(20),
            bitDepth: buffer[24],
        };
    }
    if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < buffer.length) {
            if (buffer[offset] !== 0xff) { offset += 1; continue; }
            const marker = buffer[offset + 1];
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
            const length = buffer.readUInt16BE(offset + 2);
            if (length < 2) break;
            const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
            if (isSof && offset + 8 < buffer.length) {
                return {
                    format: 'jpeg',
                    height: buffer.readUInt16BE(offset + 5),
                    width: buffer.readUInt16BE(offset + 7),
                    bitDepth: buffer[offset + 4],
                };
            }
            offset += 2 + length;
        }
        return { format: 'jpeg' };
    }
    if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
        const chunk = buffer.toString('ascii', 12, 16);
        if (chunk === 'VP8X' && buffer.length >= 30) {
            const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
            const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
            return { format: 'webp', width, height };
        }
        return { format: 'webp' };
    }
    if (buffer.length >= 28 && buffer.readUInt32LE(0) === 0xab4b5458) {
        return {
            format: 'ktx2',
            width: buffer.readUInt32LE(20),
            height: buffer.readUInt32LE(24),
        };
    }
    return { format: 'unknown' };
}

function isPowerOfTwo(value: number): boolean {
    return value > 0 && (value & (value - 1)) === 0;
}

async function readFileHead(absolutePath: string, maxBytes: number): Promise<Buffer> {
    const handle = await fs.open(absolutePath, 'r');
    try {
        const stat = await handle.stat();
        const length = Math.max(0, Math.min(stat.size, maxBytes));
        const buffer = Buffer.alloc(length);
        if (length > 0) await handle.read(buffer, 0, length, 0);
        return buffer;
    } finally {
        await handle.close().catch(() => undefined);
    }
}

async function checkTexture(
    absolutePath: string,
    relPath: string,
    collector: IssueCollector,
    stats: Record<string, string | number>,
): Promise<void> {
    let buffer: Buffer;
    try {
        const stat = await fs.stat(absolutePath);
        stats.bytes = stat.size;
        // 大图只读文件头，避免把几十 MB 贴图整体读入主进程
        buffer = stat.size <= MAX_TEXTURE_BYTES
            ? await fs.readFile(absolutePath)
            : await readFileHead(absolutePath, MAX_IMAGE_HEADER_BYTES);
    } catch (error: any) {
        collector.error('TEXTURE_UNREADABLE', relPath, `贴图读取失败：${error?.message || error}`);
        return;
    }
    const header = readImageHeader(buffer);
    stats.format = header.format;
    if (header.format === 'unknown') {
        collector.error('TEXTURE_FORMAT_UNKNOWN', relPath, '无法识别图片格式（支持 PNG/JPEG/WebP/KTX2）');
        return;
    }
    const extension = path.extname(relPath).toLowerCase();
    const expected = extension === '.jpg' || extension === '.jpeg'
        ? 'jpeg'
        : extension === '.png'
            ? 'png'
            : extension === '.webp'
                ? 'webp'
                : extension === '.ktx2' ? 'ktx2' : null;
    if (expected && expected !== header.format) {
        collector.warn('TEXTURE_MIME_MISMATCH', relPath, `扩展名 ${extension} 与实际格式 ${header.format} 不一致`, '统一扩展名与文件内容');
    }
    if (header.width && header.height) {
        stats.size = `${header.width}x${header.height}`;
        const maxSide = Math.max(header.width, header.height);
        if (maxSide > 2048) {
            collector.warn('TEXTURE_TOO_LARGE', relPath, `尺寸 ${header.width}x${header.height} 超过 2048，Web 端建议 ≤2048`, '压缩或生成 mipmap/LOD');
        }
        if (!isPowerOfTwo(header.width) || !isPowerOfTwo(header.height)) {
            collector.warn('TEXTURE_NOT_POT', relPath, `尺寸 ${header.width}x${header.height} 不是 2 的幂`, '尽量使用 2 的幂尺寸（512/1024/2048）');
        }
        if (header.width < 4 || header.height < 4) {
            collector.warn('TEXTURE_TINY', relPath, `尺寸 ${header.width}x${header.height} 过小，可能是占位图`);
        }
    }
    if (typeof stats.bytes === 'number' && stats.bytes > 5 * 1024 * 1024) {
        collector.warn('TEXTURE_HEAVY', relPath, `文件 ${formatBytes(stats.bytes)} 超过 5MB`, '压缩为 WebP/JPEG 或降低分辨率');
    }
}

// ═══════════════════════════════════════════════════════════════
// glTF / GLB
// ═══════════════════════════════════════════════════════════════

interface GltfContext {
    workspaceRoot: string;
    relPath: string;
    absDir: string;
    json: any;
    collector: IssueCollector;
    deep: boolean;
    stats: Record<string, string | number>;
    buffers: Array<Buffer | null>;
    bufferDeclared: number[];
    accessorCache: Map<number, { values: number[]; count: number; components: number; componentType: number } | null>;
    hugeAccessors: Set<number>;
}

function accessorElementSize(componentType: number, type: string): number {
    const componentSize = COMPONENT_SIZE[componentType];
    const components = TYPE_COMPONENTS[type];
    if (!componentSize || !components) return 0;
    if (type.startsWith('MAT')) {
        const dimension = Number(type.slice(3));
        const columnSize = Math.ceil((dimension * componentSize) / 4) * 4;
        return dimension * columnSize;
    }
    return componentSize * components;
}

function decodeDataUri(uri: string): Buffer | null {
    const comma = uri.indexOf(',');
    if (comma < 0) return null;
    const meta = uri.slice(5, comma);
    const payload = uri.slice(comma + 1);
    try {
        if (/;base64/i.test(meta)) return Buffer.from(payload, 'base64');
        return Buffer.from(decodeURIComponent(payload), 'utf8');
    } catch {
        return null;
    }
}

async function loadGltfBuffers(ctx: GltfContext, glbBin: Buffer | null): Promise<void> {
    const buffers = Array.isArray(ctx.json.buffers) ? ctx.json.buffers : [];
    ctx.stats.buffers = buffers.length;
    for (let index = 0; index < buffers.length; index += 1) {
        const entry = buffers[index];
        const declared = entry?.byteLength;
        if (!isPositiveInteger(declared)) {
            ctx.collector.error('GLTF_BUFFER_BYTELENGTH', `buffers[${index}].byteLength`, '应为正整数');
            ctx.bufferDeclared[index] = 0;
            ctx.buffers[index] = null;
            continue;
        }
        ctx.bufferDeclared[index] = declared;
        let actual: Buffer | null = null;
        if (typeof entry.uri === 'string' && entry.uri) {
            if (entry.uri.startsWith('data:')) {
                actual = decodeDataUri(entry.uri);
                if (!actual) ctx.collector.error('GLTF_BUFFER_DATA_URI', `buffers[${index}].uri`, 'data URI 解码失败');
            } else {
                let decoded = entry.uri;
                try { decoded = decodeURIComponent(entry.uri); } catch { /* keep raw */ }
                const absolute = path.resolve(ctx.absDir, decoded);
                try {
                    const stat = await fs.stat(absolute);
                    if (stat.size > MAX_BUFFER_BYTES) {
                        ctx.collector.warn('GLTF_BUFFER_TOO_LARGE', `buffers[${index}].uri`, `外部 buffer ${formatBytes(stat.size)} 超出 ${formatBytes(MAX_BUFFER_BYTES)}，跳过数据级校验`);
                        actual = null;
                    } else {
                        actual = await fs.readFile(absolute);
                    }
                } catch {
                    ctx.collector.error('GLTF_BUFFER_MISSING', `buffers[${index}].uri`, `外部 buffer 不存在：${entry.uri}`, '拷贝 .bin 或改用 .glb 单文件');
                }
            }
        } else if (index === 0 && glbBin) {
            actual = glbBin;
        } else {
            ctx.collector.error('GLTF_BUFFER_NO_URI', `buffers[${index}]`, '缺少 uri，且不是 GLB 的 BIN chunk（仅 buffer 0 可省略）');
        }
        ctx.buffers[index] = actual;
        if (actual) {
            if (actual.length < declared) {
                ctx.collector.error(
                    'GLTF_BUFFER_TOO_SHORT',
                    `buffers[${index}]`,
                    `声明 ${declared} 字节，实际只有 ${actual.length} 字节`,
                    '重新导出或补齐 .bin',
                );
            } else if (actual.length > declared + 4) {
                ctx.collector.warn(
                    'GLTF_BUFFER_EXTRA_BYTES',
                    `buffers[${index}]`,
                    `实际 ${actual.length} 字节大于声明 ${declared} 字节（尾部有多余数据）`,
                );
            }
        }
    }
}

function readAccessor(
    ctx: GltfContext,
    index: number,
): { values: number[]; count: number; components: number; componentType: number } | null {
    if (ctx.accessorCache.has(index)) return ctx.accessorCache.get(index) ?? null;
    ctx.accessorCache.set(index, null);
    const accessor = ctx.json.accessors?.[index];
    if (!isRecord(accessor)) return null;
    const componentType = accessor.componentType;
    const type = accessor.type;
    const components = TYPE_COMPONENTS[type];
    const componentSize = COMPONENT_SIZE[componentType];
    if (!components || !componentSize) return null;
    if (type.startsWith('MAT')) return null;
    const count = accessor.count;
    if (!isPositiveInteger(count)) return null;
    if (count * components > MAX_DEEP_VALUES) {
        if (!ctx.hugeAccessors.has(index)) {
            ctx.hugeAccessors.add(index);
            ctx.collector.warn('GLTF_ACCESSOR_TOO_LARGE', `accessors[${index}]`, `count×components=${count * components} 超出深度检查上限，已跳过数据级校验`);
        }
        return null;
    }
    const viewIndex = accessor.bufferView;
    const view = ctx.json.bufferViews?.[viewIndex];
    if (!isRecord(view)) return null;
    const buffer = ctx.buffers[view.buffer];
    if (!buffer) return null;
    const elementSize = accessorElementSize(componentType, type);
    const stride = isPositiveInteger(view.byteStride) ? view.byteStride : elementSize;
    const offset = (isInt(view.byteOffset) ? view.byteOffset : 0) + (isInt(accessor.byteOffset) ? accessor.byteOffset : 0);
    const required = offset + (count - 1) * stride + elementSize;
    if (!elementSize || required > buffer.length || offset < 0) return null;

    const values: number[] = new Array(count * components);
    const normalized = accessor.normalized === true;
    let cursor = offset;
    for (let element = 0; element < count; element += 1) {
        for (let component = 0; component < components; component += 1) {
            const at = cursor + component * componentSize;
            let value: number;
            switch (componentType) {
                case 5126: value = buffer.readFloatLE(at); break;
                case 5125: value = buffer.readUInt32LE(at); break;
                case 5123: value = buffer.readUInt16LE(at); break;
                case 5122: value = buffer.readInt16LE(at); break;
                case 5121: value = buffer.readUInt8(at); break;
                case 5120: value = buffer.readInt8(at); break;
                default: value = 0;
            }
            if (normalized && componentType !== 5126) {
                if (componentType === 5121) value /= 255;
                else if (componentType === 5123) value /= 65535;
                else if (componentType === 5120) value = Math.max(value / 127, -1);
                else if (componentType === 5122) value = Math.max(value / 32767, -1);
            }
            values[element * components + component] = value;
        }
        cursor += stride;
    }
    const result = { values, count, components, componentType };
    ctx.accessorCache.set(index, result);
    return result;
}

function checkGltfBuffersAndViews(ctx: GltfContext): void {
    const views = Array.isArray(ctx.json.bufferViews) ? ctx.json.bufferViews : [];
    ctx.stats.bufferViews = views.length;
    views.forEach((view: any, index: number) => {
        if (!isRecord(view)) {
            ctx.collector.error('GLTF_BUFFERVIEW_INVALID', `bufferViews[${index}]`, '应为对象');
            return;
        }
        if (!isIndex(view.buffer, ctx.bufferDeclared.length)) {
            ctx.collector.error('GLTF_BUFFERVIEW_BUFFER', `bufferViews[${index}].buffer`, 'buffer 索引无效');
        }
        const length = view.byteLength;
        const offset = isInt(view.byteOffset) ? view.byteOffset : 0;
        if (!isPositiveInteger(length)) {
            ctx.collector.error('GLTF_BUFFERVIEW_BYTELENGTH', `bufferViews[${index}].byteLength`, '应为正整数');
        } else {
            const declared = ctx.bufferDeclared[view.buffer] ?? 0;
            if (offset < 0 || offset + length > declared) {
                ctx.collector.error(
                    'GLTF_BUFFERVIEW_OOB',
                    `bufferViews[${index}]`,
                    `byteOffset(${offset}) + byteLength(${length}) 超出 buffer 声明长度 ${declared}`,
                );
            }
        }
        if (view.byteStride !== undefined) {
            if (!isInt(view.byteStride) || view.byteStride < 4 || view.byteStride > 252 || view.byteStride % 4 !== 0) {
                ctx.collector.error('GLTF_BUFFERVIEW_STRIDE', `bufferViews[${index}].byteStride`, 'byteStride 必须是 4-252 之间且为 4 的倍数');
            }
        }
        if (view.target !== undefined && view.target !== 34962 && view.target !== 34963) {
            ctx.collector.warn('GLTF_BUFFERVIEW_TARGET', `bufferViews[${index}].target`, 'target 应为 34962(ARRAY_BUFFER) 或 34963(ELEMENT_ARRAY_BUFFER)');
        }
    });

    const accessors = Array.isArray(ctx.json.accessors) ? ctx.json.accessors : [];
    ctx.stats.accessors = accessors.length;
    accessors.forEach((accessor: any, index: number) => {
        if (!isRecord(accessor)) {
            ctx.collector.error('GLTF_ACCESSOR_INVALID', `accessors[${index}]`, '应为对象');
            return;
        }
        const componentType = accessor.componentType;
        const type = accessor.type;
        const count = accessor.count;
        if (!COMPONENT_SIZE[componentType]) {
            ctx.collector.error('GLTF_ACCESSOR_COMPONENT', `accessors[${index}].componentType`, '不支持/缺失 componentType');
        }
        if (!TYPE_COMPONENTS[type]) {
            ctx.collector.error('GLTF_ACCESSOR_TYPE', `accessors[${index}].type`, 'type 应为 SCALAR/VEC2/VEC3/VEC4/MAT2/MAT3/MAT4');
        }
        if (!isPositiveInteger(count)) {
            ctx.collector.error('GLTF_ACCESSOR_COUNT', `accessors[${index}].count`, 'count 应为正整数');
            return;
        }
        if (accessor.normalized === true && componentType === 5126) {
            ctx.collector.warn('GLTF_ACCESSOR_NORMALIZED', `accessors[${index}].normalized`, 'float 类型不需要 normalized');
        }
        if (Array.isArray(accessor.min) && Array.isArray(accessor.max)) {
            if (accessor.min.length !== accessor.max.length) {
                ctx.collector.error('GLTF_ACCESSOR_MINMAX', `accessors[${index}]`, 'min/max 长度不一致');
            }
            for (let i = 0; i < accessor.min.length; i += 1) {
                if (typeof accessor.min[i] !== 'number' || !Number.isFinite(accessor.min[i])
                    || typeof accessor.max[i] !== 'number' || !Number.isFinite(accessor.max[i])) {
                    ctx.collector.error('GLTF_ACCESSOR_MINMAX', `accessors[${index}]`, 'min/max 含非数值');
                    break;
                }
                if (accessor.min[i] > accessor.max[i]) {
                    ctx.collector.error('GLTF_ACCESSOR_MINMAX', `accessors[${index}]`, `min[${i}] > max[${i}]`);
                    break;
                }
            }
        }
        const viewIndex = accessor.bufferView;
        if (viewIndex === undefined) {
            if (!accessor.sparse) {
                ctx.collector.error('GLTF_ACCESSOR_NO_DATA', `accessors[${index}]`, '既没有 bufferView 也没有 sparse，无法提供数据');
            }
            return;
        }
        const view = ctx.json.bufferViews?.[viewIndex];
        if (!isRecord(view)) {
            ctx.collector.error('GLTF_ACCESSOR_BUFFERVIEW', `accessors[${index}].bufferView`, 'bufferView 索引无效');
            return;
        }
        const elementSize = accessorElementSize(componentType, type);
        const stride = isPositiveInteger(view.byteStride) ? view.byteStride : elementSize;
        const offset = (isInt(view.byteOffset) ? view.byteOffset : 0) + (isInt(accessor.byteOffset) ? accessor.byteOffset : 0);
        const viewLength = isPositiveInteger(view.byteLength) ? view.byteLength : 0;
        const required = (isInt(accessor.byteOffset) ? accessor.byteOffset : 0) + (count - 1) * stride + elementSize;
        if (elementSize && required > viewLength) {
            ctx.collector.error(
                'GLTF_ACCESSOR_OOB',
                `accessors[${index}]`,
                `需要 ${required} 字节，bufferView 只有 ${viewLength} 字节`,
                '导出时对齐 byteStride / count，或检查是否漏写 bufferView.byteLength',
            );
        }
        if (stride && elementSize > stride) {
            ctx.collector.error('GLTF_ACCESSOR_STRIDE', `accessors[${index}]`, '元素大小大于 bufferView.byteStride');
        }
        if (COMPONENT_SIZE[componentType] && offset % COMPONENT_SIZE[componentType] !== 0) {
            ctx.collector.warn('GLTF_ACCESSOR_ALIGNMENT', `accessors[${index}]`, 'byteOffset 未按 componentType 对齐');
        }
    });
}

function checkGltfMeshes(ctx: GltfContext): void {
    const accessors = Array.isArray(ctx.json.accessors) ? ctx.json.accessors : [];
    const meshes = Array.isArray(ctx.json.meshes) ? ctx.json.meshes : [];
    ctx.stats.meshes = meshes.length;
    let primitives = 0;
    let triangles = 0;

    const positionAccessors = new Set<number>();
    const indexAccessors = new Map<number, { position: number; mode: number }>();
    const normalAccessors = new Set<number>();

    meshes.forEach((mesh: any, meshIndex: number) => {
        if (!isRecord(mesh)) {
            ctx.collector.error('GLTF_MESH_INVALID', `meshes[${meshIndex}]`, '应为对象');
            return;
        }
        if (!Array.isArray(mesh.primitives) || mesh.primitives.length === 0) {
            ctx.collector.error('GLTF_MESH_PRIMITIVES', `meshes[${meshIndex}].primitives`, '需要非空 primitives 数组');
            return;
        }
        if (mesh.primitives.length > 16) {
            ctx.collector.warn('GLTF_MESH_DRAW_CALLS', `meshes[${meshIndex}].primitives`, `${mesh.primitives.length} 个 primitive 会增加 draw call`, '合并材质/网格');
        }
        mesh.primitives.forEach((primitive: any, primitiveIndex: number) => {
            const at = `meshes[${meshIndex}].primitives[${primitiveIndex}]`;
            if (!isRecord(primitive)) {
                ctx.collector.error('GLTF_PRIMITIVE_INVALID', at, '应为对象');
                return;
            }
            primitives += 1;
            const mode = primitive.mode ?? 4;
            if (!isInt(mode) || mode < 0 || mode > 6) {
                ctx.collector.error('GLTF_PRIMITIVE_MODE', `${at}.mode`, 'mode 应为 0-6');
            }
            const attributes = primitive.attributes;
            if (!isRecord(attributes) || Object.keys(attributes).length === 0) {
                ctx.collector.error('GLTF_PRIMITIVE_ATTRIBUTES', `${at}.attributes`, '需要非空 attributes 对象');
                return;
            }
            let firstCount: number | null = null;
            for (const [name, accessorIndex] of Object.entries(attributes)) {
                if (!isIndex(accessorIndex, accessors.length)) {
                    ctx.collector.error('GLTF_PRIMITIVE_ATTRIBUTE_INDEX', `${at}.attributes.${name}`, 'accessor 索引无效');
                    continue;
                }
                const accessor = accessors[accessorIndex];
                const count = accessor?.count;
                if (typeof count === 'number') {
                    if (firstCount === null) firstCount = count;
                    else if (firstCount !== count) {
                        ctx.collector.error('GLTF_PRIMITIVE_ATTRIBUTE_COUNT', `${at}.attributes.${name}`, `顶点数 ${count} 与其他属性 ${firstCount} 不一致`);
                    }
                }
                if ((name === 'POSITION' || name === 'NORMAL') && accessor) {
                    if (accessor.type !== 'VEC3') {
                        ctx.collector.error('GLTF_ATTRIBUTE_TYPE', `accessors[${accessorIndex}].type`, `${name} 必须是 VEC3`);
                    }
                    if (accessor.componentType !== 5126) {
                        ctx.collector.warn('GLTF_ATTRIBUTE_COMPONENT', `accessors[${accessorIndex}].componentType`, `${name} 建议使用 float(5126)，当前 ${accessor.componentType}`);
                    }
                }
                if (name === 'POSITION') positionAccessors.add(accessorIndex);
                if (name === 'NORMAL') normalAccessors.add(accessorIndex);
            }
            if (!('POSITION' in attributes)) {
                ctx.collector.warn('GLTF_PRIMITIVE_NO_POSITION', `${at}.attributes`, '缺少 POSITION，Web 端无法正常渲染');
            }
            if (primitive.indices !== undefined) {
                if (!isIndex(primitive.indices, accessors.length)) {
                    ctx.collector.error('GLTF_PRIMITIVE_INDICES', `${at}.indices`, 'indices accessor 索引无效');
                } else {
                    const accessor = accessors[primitive.indices];
                    if (!INDEX_TYPES.has(accessor?.componentType)) {
                        ctx.collector.error('GLTF_INDICES_COMPONENT', `accessors[${primitive.indices}].componentType`, '索引只能用 5121/5123/5125 无符号整数');
                    }
                    if (accessor?.type !== 'SCALAR') {
                        ctx.collector.error('GLTF_INDICES_TYPE', `accessors[${primitive.indices}].type`, '索引 accessor type 应为 SCALAR');
                    }
                    if (mode === 4 && typeof accessor?.count === 'number' && accessor.count % 3 !== 0) {
                        ctx.collector.warn('GLTF_INDICES_STRIP', `accessors[${primitive.indices}].count`, `TRIANGLES 模式下索引数 ${accessor.count} 不是 3 的倍数`);
                    }
                    if (isInt(attributes.POSITION)) indexAccessors.set(primitive.indices, { position: attributes.POSITION, mode });
                }
            }
            if (primitive.material !== undefined && !isIndex(primitive.material, (ctx.json.materials as any[])?.length ?? 0)) {
                ctx.collector.error('GLTF_PRIMITIVE_MATERIAL', `${at}.material`, 'material 索引无效');
            }
            const positionCount = isInt(attributes.POSITION) ? accessors[attributes.POSITION]?.count ?? 0 : 0;
            const indexCount = isInt(primitive.indices) ? accessors[primitive.indices]?.count ?? positionCount : positionCount;
            if (mode === 4) triangles += Math.floor(indexCount / 3);
            else if (mode === 5 || mode === 6) triangles += Math.max(0, indexCount - 2);
            if (Array.isArray(primitive.targets)) {
                primitive.targets.forEach((target: any, targetIndex: number) => {
                    if (!isRecord(target)) {
                        ctx.collector.error('GLTF_MORPH_TARGET', `${at}.targets[${targetIndex}]`, '应为对象');
                        return;
                    }
                    for (const [name, accessorIndex] of Object.entries(target)) {
                        if (!isIndex(accessorIndex, accessors.length)) {
                            ctx.collector.error('GLTF_MORPH_ACCESSOR', `${at}.targets[${targetIndex}].${name}`, 'accessor 索引无效');
                        } else if (positionCount && accessors[accessorIndex]?.count !== positionCount) {
                            ctx.collector.error('GLTF_MORPH_COUNT', `${at}.targets[${targetIndex}].${name}`, 'morph target 顶点数与 POSITION 不一致');
                        }
                    }
                });
            }
        });
    });
    ctx.stats.primitives = primitives;
    ctx.stats.triangles = triangles;
    if (triangles > 300_000) {
        ctx.collector.warn('GLTF_TRIANGLE_BUDGET', 'meshes', `三角面 ${triangles} 偏高（Web 首屏建议 ≤10 万）`, '减面或做 LOD');
    }

    if (ctx.deep) {
        checkGltfPositionData(ctx, positionAccessors);
        checkGltfIndexData(ctx, indexAccessors);
        checkGltfNormalData(ctx, normalAccessors);
    }
}

function checkGltfPositionData(ctx: GltfContext, accessors: Set<number>): void {
    for (const index of accessors) {
        const accessor = ctx.json.accessors[index];
        const data = readAccessor(ctx, index);
        if (!data) continue;
        let invalid = 0;
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < data.values.length; i += 3) {
            for (let axis = 0; axis < 3; axis += 1) {
                const value = data.values[i + axis];
                if (!Number.isFinite(value)) { invalid += 1; continue; }
                if (value < min[axis]) min[axis] = value;
                if (value > max[axis]) max[axis] = value;
            }
        }
        if (invalid > 0) {
            ctx.collector.error('GLTF_POSITION_INVALID', `accessors[${index}]`, `POSITION 含 ${invalid} 个 NaN/Inf 分量`);
            continue;
        }
        if (!Array.isArray(accessor.min) || accessor.min.length !== 3 || !Array.isArray(accessor.max) || accessor.max.length !== 3) {
            ctx.collector.error('GLTF_POSITION_MINMAX', `accessors[${index}]`, 'POSITION 必须提供长度为 3 的 min/max', '导出时重新计算包围盒');
            continue;
        }
        const scale = Math.max(1, ...min.map(Math.abs), ...max.map(Math.abs));
        const tolerance = scale * 1e-3;
        const mismatch = [0, 1, 2].some((axis) =>
            Math.abs(min[axis] - accessor.min[axis]) > tolerance || Math.abs(max[axis] - accessor.max[axis]) > tolerance);
        if (mismatch) {
            ctx.collector.warn(
                'GLTF_POSITION_BOUNDS_MISMATCH',
                `accessors[${index}].min/max`,
                `声明的包围盒与实际顶点不一致（实际 min=[${min.map((v) => v.toFixed(3))}] max=[${max.map((v) => v.toFixed(3))}]）`,
                '重新导出或重新计算 min/max',
            );
        }
    }
}

function checkGltfIndexData(ctx: GltfContext, entries: Map<number, { position: number; mode: number }>): void {
    const accessors = Array.isArray(ctx.json.accessors) ? ctx.json.accessors : [];
    for (const [index, info] of entries) {
        const data = readAccessor(ctx, index);
        if (!data) continue;
        const positionCount = accessors[info.position]?.count ?? 0;
        let outOfRange = 0;
        let firstBad = -1;
        let degenerate = 0;
        for (let i = 0; i < data.values.length; i += 1) {
            const value = data.values[i];
            if (!Number.isInteger(value) || value < 0 || value >= positionCount) {
                outOfRange += 1;
                if (firstBad < 0) firstBad = i;
            }
        }
        if (outOfRange > 0) {
            ctx.collector.error(
                'GLTF_INDEX_OUT_OF_RANGE',
                `accessors[${index}]`,
                `${outOfRange} 个索引超出顶点数 ${positionCount}（首个位置 ${firstBad}，值 ${data.values[firstBad]}）`,
                '检查导出时的索引类型/偏移或是否拼接了错误的几何体',
            );
        }
        if (info.mode === 4) {
            for (let i = 0; i + 2 < data.values.length; i += 3) {
                const a = data.values[i];
                const b = data.values[i + 1];
                const c = data.values[i + 2];
                if (a === b || b === c || a === c) degenerate += 1;
            }
            if (degenerate > 0) {
                ctx.collector.warn('GLTF_DEGENERATE_TRIANGLES', `accessors[${index}]`, `${degenerate} 个退化三角形（重复索引）`, '清理零面积三角形');
            }
        }
    }
}

function checkGltfNormalData(ctx: GltfContext, accessors: Set<number>): void {
    for (const index of accessors) {
        const data = readAccessor(ctx, index);
        if (!data) continue;
        let offUnit = 0;
        let invalid = 0;
        let checked = 0;
        for (let i = 0; i < data.values.length; i += 3) {
            const x = data.values[i];
            const y = data.values[i + 1];
            const z = data.values[i + 2];
            if (![x, y, z].every(Number.isFinite)) { invalid += 1; continue; }
            checked += 1;
            const length = Math.hypot(x, y, z);
            if (length > 0 && Math.abs(length - 1) > 0.2) offUnit += 1;
        }
        if (invalid > 0) ctx.collector.error('GLTF_NORMAL_INVALID', `accessors[${index}]`, `NORMAL 含 ${invalid} 个 NaN/Inf 分量`);
        if (offUnit > 0 && offUnit > checked * 0.1) {
            ctx.collector.warn('GLTF_NORMAL_NOT_UNIT', `accessors[${index}]`, `${offUnit}/${checked} 个法线长度偏离 1（±20%）`, '导出前归一化法线');
        }
    }
}

function checkGltfNodesAndScenes(ctx: GltfContext): void {
    const nodes = Array.isArray(ctx.json.nodes) ? ctx.json.nodes : [];
    const meshes = Array.isArray(ctx.json.meshes) ? ctx.json.meshes : [];
    const skins = Array.isArray(ctx.json.skins) ? ctx.json.skins : [];
    const cameras = Array.isArray(ctx.json.cameras) ? ctx.json.cameras : [];
    ctx.stats.nodes = nodes.length;

    const parentCount = new Map<number, number>();
    nodes.forEach((node: any, index: number) => {
        if (!isRecord(node)) {
            ctx.collector.error('GLTF_NODE_INVALID', `nodes[${index}]`, '应为对象');
            return;
        }
        if (node.mesh !== undefined && !isIndex(node.mesh, meshes.length)) {
            ctx.collector.error('GLTF_NODE_MESH', `nodes[${index}].mesh`, 'mesh 索引无效');
        }
        if (node.skin !== undefined && !isIndex(node.skin, skins.length)) {
            ctx.collector.error('GLTF_NODE_SKIN', `nodes[${index}].skin`, 'skin 索引无效');
        }
        if (node.camera !== undefined && !isIndex(node.camera, cameras.length)) {
            ctx.collector.error('GLTF_NODE_CAMERA', `nodes[${index}].camera`, 'camera 索引无效');
        }
        if (Array.isArray(node.children)) {
            for (const child of node.children) {
                if (!isIndex(child, nodes.length)) {
                    ctx.collector.error('GLTF_NODE_CHILD', `nodes[${index}].children`, `子节点索引 ${child} 无效`);
                    continue;
                }
                parentCount.set(child, (parentCount.get(child) ?? 0) + 1);
            }
        }
        if (node.matrix !== undefined) {
            if (!Array.isArray(node.matrix) || node.matrix.length !== 16 || !node.matrix.every(Number.isFinite)) {
                ctx.collector.error('GLTF_NODE_MATRIX', `nodes[${index}].matrix`, 'matrix 必须是 16 个有限数值');
            }
            if (node.translation !== undefined || node.rotation !== undefined || node.scale !== undefined) {
                ctx.collector.warn('GLTF_NODE_MATRIX_TRS', `nodes[${index}]`, '同时设置 matrix 与 TRS，TRS 会被忽略');
            }
        }
        if (node.translation !== undefined && (!Array.isArray(node.translation) || node.translation.length !== 3 || !node.translation.every(Number.isFinite))) {
            ctx.collector.error('GLTF_NODE_TRANSLATION', `nodes[${index}].translation`, 'translation 必须是 3 个有限数值');
        }
        if (node.rotation !== undefined) {
            if (!Array.isArray(node.rotation) || node.rotation.length !== 4 || !node.rotation.every(Number.isFinite)) {
                ctx.collector.error('GLTF_NODE_ROTATION', `nodes[${index}].rotation`, 'rotation 必须是 4 个有限数值（四元数）');
            } else if (node.rotation.every((value: number) => value === 0)) {
                ctx.collector.error('GLTF_NODE_ROTATION_ZERO', `nodes[${index}].rotation`, '四元数不能全为 0');
            }
        }
        if (node.scale !== undefined) {
            if (!Array.isArray(node.scale) || node.scale.length !== 3 || !node.scale.every(Number.isFinite)) {
                ctx.collector.error('GLTF_NODE_SCALE', `nodes[${index}].scale`, 'scale 必须是 3 个有限数值');
            } else if (node.scale.some((value: number) => value === 0)) {
                ctx.collector.warn('GLTF_NODE_SCALE_ZERO', `nodes[${index}].scale`, 'scale 含 0，模型会被压扁/不可见');
            }
        }
    });

    for (const [node, count] of parentCount) {
        if (count > 1) ctx.collector.error('GLTF_NODE_MULTI_PARENT', `nodes[${node}]`, `被 ${count} 个父节点引用（glTF 节点只能有一个父节点）`);
    }

    const state = new Array<number>(nodes.length).fill(0);
    const visit = (index: number, stack: number[]) => {
        if (state[index] === 2) return;
        if (state[index] === 1) {
            const cycle = [...stack.slice(stack.indexOf(index)), index].join(' → ');
            ctx.collector.error('GLTF_NODE_CYCLE', `nodes[${index}]`, `节点层级存在环：${cycle}`);
            return;
        }
        state[index] = 1;
        const children = Array.isArray(nodes[index]?.children) ? nodes[index].children : [];
        for (const child of children) {
            if (isIndex(child, nodes.length)) visit(child, [...stack, index]);
        }
        state[index] = 2;
    };
    nodes.forEach((_node: unknown, index: number) => visit(index, []));

    const scenes = Array.isArray(ctx.json.scenes) ? ctx.json.scenes : [];
    ctx.stats.scenes = scenes.length;
    scenes.forEach((scene: any, index: number) => {
        if (!isRecord(scene)) {
            ctx.collector.error('GLTF_SCENE_INVALID', `scenes[${index}]`, '应为对象');
            return;
        }
        if (scene.nodes !== undefined) {
            if (!Array.isArray(scene.nodes)) {
                ctx.collector.error('GLTF_SCENE_NODES', `scenes[${index}].nodes`, '应为数组');
            } else {
                for (const node of scene.nodes) {
                    if (!isIndex(node, nodes.length)) {
                        ctx.collector.error('GLTF_SCENE_NODE_INDEX', `scenes[${index}].nodes`, `节点索引 ${node} 无效`);
                    }
                }
            }
        }
    });
    if (ctx.json.scene !== undefined && !isIndex(ctx.json.scene, scenes.length)) {
        ctx.collector.error('GLTF_DEFAULT_SCENE', 'scene', '默认 scene 索引无效');
    }
}

function checkGltfMaterialsAndTextures(ctx: GltfContext): Promise<void> | void {
    const materials = Array.isArray(ctx.json.materials) ? ctx.json.materials : [];
    const textures = Array.isArray(ctx.json.textures) ? ctx.json.textures : [];
    const images = Array.isArray(ctx.json.images) ? ctx.json.images : [];
    const samplers = Array.isArray(ctx.json.samplers) ? ctx.json.samplers : [];
    ctx.stats.materials = materials.length;
    ctx.stats.textures = textures.length;

    const checkTextureIndex = (value: unknown, at: string) => {
        if (value === undefined) return;
        if (!isRecord(value) || !isIndex(value.index, textures.length)) {
            ctx.collector.error('GLTF_TEXTURE_INDEX', at, 'texture 索引无效');
        }
    };

    materials.forEach((material: any, index: number) => {
        const at = `materials[${index}]`;
        if (!isRecord(material)) {
            ctx.collector.error('GLTF_MATERIAL_INVALID', at, '应为对象');
            return;
        }
        const pbr = material.pbrMetallicRoughness;
        if (pbr !== undefined) {
            if (!isRecord(pbr)) {
                ctx.collector.error('GLTF_PBR_INVALID', `${at}.pbrMetallicRoughness`, '应为对象');
            } else {
                if (pbr.baseColorFactor !== undefined) {
                    if (!Array.isArray(pbr.baseColorFactor) || pbr.baseColorFactor.length !== 4 || !pbr.baseColorFactor.every((v: number) => typeof v === 'number' && v >= 0 && v <= 1)) {
                        ctx.collector.error('GLTF_PBR_BASE_COLOR', `${at}.pbrMetallicRoughness.baseColorFactor`, '应为 4 个 0-1 数值');
                    }
                }
                for (const key of ['metallicFactor', 'roughnessFactor']) {
                    const value = pbr[key];
                    if (value !== undefined && (typeof value !== 'number' || value < 0 || value > 1)) {
                        ctx.collector.error('GLTF_PBR_FACTOR', `${at}.pbrMetallicRoughness.${key}`, '应为 0-1 数值');
                    }
                }
                checkTextureIndex(pbr.baseColorTexture, `${at}.pbrMetallicRoughness.baseColorTexture`);
                checkTextureIndex(pbr.metallicRoughnessTexture, `${at}.pbrMetallicRoughness.metallicRoughnessTexture`);
            }
        }
        checkTextureIndex(material.normalTexture, `${at}.normalTexture`);
        checkTextureIndex(material.occlusionTexture, `${at}.occlusionTexture`);
        checkTextureIndex(material.emissiveTexture, `${at}.emissiveTexture`);
        if (material.emissiveFactor !== undefined && (!Array.isArray(material.emissiveFactor) || material.emissiveFactor.length !== 3)) {
            ctx.collector.error('GLTF_EMISSIVE_FACTOR', `${at}.emissiveFactor`, '应为 3 个数值');
        }
        if (material.alphaMode !== undefined && !['OPAQUE', 'MASK', 'BLEND'].includes(material.alphaMode)) {
            ctx.collector.error('GLTF_ALPHA_MODE', `${at}.alphaMode`, '应为 OPAQUE/MASK/BLEND');
        }
        if (material.doubleSided !== undefined && typeof material.doubleSided !== 'boolean') {
            ctx.collector.error('GLTF_DOUBLE_SIDED', `${at}.doubleSided`, '应为 boolean');
        }
    });

    textures.forEach((texture: any, index: number) => {
        if (!isRecord(texture)) {
            ctx.collector.error('GLTF_TEXTURE_INVALID', `textures[${index}]`, '应为对象');
            return;
        }
        if (texture.source !== undefined && !isIndex(texture.source, images.length)) {
            ctx.collector.error('GLTF_TEXTURE_SOURCE', `textures[${index}].source`, 'image 索引无效');
        }
        if (texture.sampler !== undefined && !isIndex(texture.sampler, samplers.length)) {
            ctx.collector.error('GLTF_TEXTURE_SAMPLER', `textures[${index}].sampler`, 'sampler 索引无效');
        }
    });

    samplers.forEach((sampler: any, index: number) => {
        if (!isRecord(sampler)) {
            ctx.collector.error('GLTF_SAMPLER_INVALID', `samplers[${index}]`, '应为对象');
            return;
        }
        if (sampler.magFilter !== undefined && ![9728, 9729].includes(sampler.magFilter)) {
            ctx.collector.error('GLTF_SAMPLER_FILTER', `samplers[${index}].magFilter`, '只支持 9728/9729');
        }
        if (sampler.minFilter !== undefined && ![9728, 9729, 9984, 9985, 9986, 9987].includes(sampler.minFilter)) {
            ctx.collector.error('GLTF_SAMPLER_FILTER', `samplers[${index}].minFilter`, 'minFilter 值无效');
        }
        for (const key of ['wrapS', 'wrapT']) {
            if (sampler[key] !== undefined && ![33071, 33648, 10497].includes(sampler[key])) {
                ctx.collector.error('GLTF_SAMPLER_WRAP', `samplers[${index}].${key}`, 'wrap 应为 33071/33648/10497');
            }
        }
    });

    const textureTasks: Array<Promise<void>> = [];
    images.forEach((image: any, index: number) => {
        if (!isRecord(image)) {
            ctx.collector.error('GLTF_IMAGE_INVALID', `images[${index}]`, '应为对象');
            return;
        }
        if (image.uri !== undefined && image.bufferView !== undefined) {
            ctx.collector.error('GLTF_IMAGE_SOURCE', `images[${index}]`, 'uri 与 bufferView 只能二选一');
        }
        if (typeof image.uri === 'string' && image.uri && !image.uri.startsWith('data:')) {
            let decoded = image.uri;
            try { decoded = decodeURIComponent(image.uri); } catch { /* keep raw */ }
            const absolute = path.resolve(ctx.absDir, decoded);
            const displayPath = normalizeAssetPath(path.posix.join(path.posix.dirname(ctx.relPath), decoded));
            textureTasks.push((async () => {
                try {
                    await fs.access(absolute);
                } catch {
                    ctx.collector.error('GLTF_IMAGE_MISSING', `images[${index}].uri`, `贴图不存在：${image.uri}`, '打包进 GLB 或补齐相对路径');
                    return;
                }
                await checkTexture(absolute, displayPath, ctx.collector, {});
            })());
        }
        if (image.bufferView !== undefined) {
            const view = ctx.json.bufferViews?.[image.bufferView];
            if (!isRecord(view)) {
                ctx.collector.error('GLTF_IMAGE_BUFFERVIEW', `images[${index}].bufferView`, 'bufferView 索引无效');
            }
        }
    });
    return textureTasks.length > 0 ? Promise.all(textureTasks).then(() => undefined) : undefined;
}

function checkGltfAnimationsAndSkins(ctx: GltfContext): void {
    const accessors = Array.isArray(ctx.json.accessors) ? ctx.json.accessors : [];
    const nodes = Array.isArray(ctx.json.nodes) ? ctx.json.nodes : [];
    const animations = Array.isArray(ctx.json.animations) ? ctx.json.animations : [];
    ctx.stats.animations = animations.length;

    const inputAccessors = new Set<number>();
    animations.forEach((animation: any, animationIndex: number) => {
        const at = `animations[${animationIndex}]`;
        if (!isRecord(animation) || !Array.isArray(animation.samplers) || !Array.isArray(animation.channels)) {
            ctx.collector.error('GLTF_ANIMATION_INVALID', at, '需要 samplers 与 channels 数组');
            return;
        }
        animation.samplers.forEach((sampler: any, samplerIndex: number) => {
            const samplerAt = `${at}.samplers[${samplerIndex}]`;
            if (!isRecord(sampler)) {
                ctx.collector.error('GLTF_ANIMATION_SAMPLER', samplerAt, '应为对象');
                return;
            }
            const inputIndex = sampler.input;
            const outputIndex = sampler.output;
            if (!isIndex(inputIndex, accessors.length)) {
                ctx.collector.error('GLTF_ANIMATION_INPUT', `${samplerAt}.input`, 'accessor 索引无效');
            } else if (accessors[inputIndex]?.type !== 'SCALAR') {
                ctx.collector.error('GLTF_ANIMATION_INPUT_TYPE', `accessors[${inputIndex}].type`, '动画 input 必须是 SCALAR');
            } else {
                inputAccessors.add(inputIndex);
            }
            if (!isIndex(outputIndex, accessors.length)) {
                ctx.collector.error('GLTF_ANIMATION_OUTPUT', `${samplerAt}.output`, 'accessor 索引无效');
            }
            if (sampler.interpolation !== undefined && !['LINEAR', 'STEP', 'CUBICSPLINE'].includes(sampler.interpolation)) {
                ctx.collector.error('GLTF_ANIMATION_INTERPOLATION', `${samplerAt}.interpolation`, '应为 LINEAR/STEP/CUBICSPLINE');
            }
        });
        animation.channels.forEach((channel: any, channelIndex: number) => {
            const channelAt = `${at}.channels[${channelIndex}]`;
            if (!isRecord(channel)) {
                ctx.collector.error('GLTF_ANIMATION_CHANNEL', channelAt, '应为对象');
                return;
            }
            if (!isIndex(channel.sampler, animation.samplers.length)) {
                ctx.collector.error('GLTF_ANIMATION_CHANNEL_SAMPLER', `${channelAt}.sampler`, 'sampler 索引无效');
                return;
            }
            const pathValue = channel.target?.path;
            if (!isRecord(channel.target) || !isIndex(channel.target.node, nodes.length) || !ANIMATION_PATHS.has(pathValue)) {
                ctx.collector.error('GLTF_ANIMATION_TARGET', `${channelAt}.target`, 'target.node 或 target.path 无效');
                return;
            }
            const sampler = animation.samplers[channel.sampler];
            if (!isRecord(sampler)) return;
            const input = accessors[sampler.input];
            const output = accessors[sampler.output];
            if (!isPositiveInteger(input?.count) || !isPositiveInteger(output?.count)) return;
            const expectedType = pathValue === 'rotation' ? 'VEC4' : pathValue === 'weights' ? 'SCALAR' : 'VEC3';
            if (output.type !== expectedType) {
                ctx.collector.error(
                    'GLTF_ANIMATION_OUTPUT_TYPE',
                    `accessors[${sampler.output}].type`,
                    `${pathValue} 的 output 应为 ${expectedType}，当前 ${output.type}`,
                );
            }
            const components = pathValue === 'rotation' ? 4 : pathValue === 'weights' ? 1 : 3;
            const multiplier = sampler.interpolation === 'CUBICSPLINE' ? 3 : 1;
            const expected = input.count * components * multiplier;
            if (output.count !== expected) {
                ctx.collector.error(
                    'GLTF_ANIMATION_OUTPUT_COUNT',
                    `${channelAt}.target.${pathValue}`,
                    `output 关键帧数 ${output.count} 与 input ${input.count}×${components}${multiplier > 1 ? '×3(CUBICSPLINE)' : ''}=${expected} 不一致`,
                );
            }
        });
    });

    if (ctx.deep) {
        for (const index of inputAccessors) {
            const data = readAccessor(ctx, index);
            if (!data) continue;
            let nonIncreasing = 0;
            let negative = 0;
            for (let i = 0; i < data.values.length; i += 1) {
                if (data.values[i] < 0) negative += 1;
                if (i > 0 && data.values[i] <= data.values[i - 1]) nonIncreasing += 1;
            }
            if (nonIncreasing > 0) {
                ctx.collector.error('GLTF_ANIMATION_INPUT_ORDER', `accessors[${index}]`, `${nonIncreasing} 个时间点未严格递增`, '关键帧时间必须递增');
            }
            if (negative > 0) {
                ctx.collector.warn('GLTF_ANIMATION_INPUT_NEGATIVE', `accessors[${index}]`, `${negative} 个负时间值`);
            }
        }
    }

    const skins = Array.isArray(ctx.json.skins) ? ctx.json.skins : [];
    ctx.stats.skins = skins.length;
    skins.forEach((skin: any, index: number) => {
        const at = `skins[${index}]`;
        if (!isRecord(skin) || !Array.isArray(skin.joints) || skin.joints.length === 0) {
            ctx.collector.error('GLTF_SKIN_JOINTS', at, '需要非空 joints 数组');
            return;
        }
        for (const joint of skin.joints) {
            if (!isIndex(joint, nodes.length)) {
                ctx.collector.error('GLTF_SKIN_JOINT_INDEX', `${at}.joints`, `joint 索引 ${joint} 无效`);
                break;
            }
        }
        if (skin.inverseBindMatrices !== undefined) {
            const accessor = accessors[skin.inverseBindMatrices];
            if (!isRecord(accessor)) {
                ctx.collector.error('GLTF_SKIN_IBM', `${at}.inverseBindMatrices`, 'accessor 索引无效');
            } else {
                if (accessor.type !== 'MAT4') ctx.collector.error('GLTF_SKIN_IBM_TYPE', `${at}.inverseBindMatrices`, '应为 MAT4');
                if (accessor.count !== skin.joints.length) {
                    ctx.collector.error(
                        'GLTF_SKIN_IBM_COUNT',
                        `${at}.inverseBindMatrices`,
                        `count ${accessor.count} 与 joints 数量 ${skin.joints.length} 不一致`,
                    );
                }
            }
        }
        if (skin.skeleton !== undefined && !isIndex(skin.skeleton, nodes.length)) {
            ctx.collector.error('GLTF_SKIN_SKELETON', `${at}.skeleton`, 'skeleton 节点索引无效');
        }
    });
}

function checkGltfExtensions(ctx: GltfContext): void {
    const used: string[] = Array.isArray(ctx.json.extensionsUsed) ? ctx.json.extensionsUsed : [];
    const required: string[] = Array.isArray(ctx.json.extensionsRequired) ? ctx.json.extensionsRequired : [];
    for (const extension of required) {
        if (!used.includes(extension)) {
            ctx.collector.error('GLTF_EXTENSION_REQUIRED_NOT_USED', 'extensionsRequired', `${extension} 未出现在 extensionsUsed`);
        }
    }
    const unsupported = used.filter((extension) => UNSUPPORTED_RENDER_EXTENSIONS.has(extension));
    if (unsupported.length > 0) {
        ctx.collector.warn(
            'GLTF_COMPRESSION_UNSUPPORTED',
            'extensionsUsed',
            `使用了 ${unsupported.join(', ')}；IDE 预览与多数 Web 端缺少解码器`,
            'Blender 导出时关闭 Draco/Meshopt/BasisU 压缩',
        );
    }
    const unknown = used.filter((extension) => !SUPPORTED_RENDER_EXTENSIONS.has(extension) && !UNSUPPORTED_RENDER_EXTENSIONS.has(extension));
    if (unknown.length > 0) {
        ctx.collector.warn('GLTF_EXTENSION_UNKNOWN', 'extensionsUsed', `未识别的扩展：${unknown.join(', ')}（渲染时可能被忽略）`);
    }
}

async function checkGltfAsset(
    workspaceRoot: string,
    relPath: string,
    buffer: Buffer,
    options: Scene3dCheckOptions,
    startedAt: number,
): Promise<Scene3dCheckReport> {
    const collector = new IssueCollector();
    const stats: Record<string, string | number> = { bytes: buffer.length };
    const format: 'glb' | 'gltf' = detectScene3dFormat(relPath) === 'glb' ? 'glb' : 'gltf';
    let json: any = null;
    let glbBin: Buffer | null = null;
    if (format === 'glb') {
        try {
            const parsed = parseGlb(buffer);
            json = parsed.json;
            glbBin = parsed.bin;
            stats.binBytes = parsed.binBytes;
            if (parsed.declaredLength !== buffer.length) {
                collector.warn('GLB_LENGTH_MISMATCH', 'header', `声明长度 ${parsed.declaredLength}，实际 ${buffer.length} 字节（尾部有多余数据）`);
            }
            const jsonChunks = parsed.chunks.filter((chunk) => chunk.type === 0x4e4f534a);
            if (jsonChunks.length !== 1) {
                collector.error('GLB_JSON_CHUNK_COUNT', 'chunks', `JSON chunk 数量应为 1，实际 ${jsonChunks.length}`);
            }
            parsed.chunks.forEach((chunk, index) => {
                if (chunk.length % 4 !== 0) {
                    collector.warn('GLB_CHUNK_ALIGNMENT', `chunks[${index}]`, `chunk 长度 ${chunk.length} 未按 4 字节对齐`);
                }
            });
        } catch (error: any) {
            collector.error('GLB_CONTAINER', 'header', String(error?.message || error), '重新导出 GLB');
            return finalizeReport(relPath, format, collector, stats, options.maxIssues ?? 30, startedAt);
        }
    } else {
        try {
            json = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''));
        } catch (error: any) {
            collector.error('GLTF_JSON_PARSE', 'root', `JSON 解析失败：${error?.message || error}`);
            return finalizeReport(relPath, format, collector, stats, options.maxIssues ?? 30, startedAt);
        }
    }
    if (!isRecord(json)) {
        collector.error('GLTF_ROOT_INVALID', 'root', '根节点必须是 JSON 对象');
        return finalizeReport(relPath, format, collector, stats, options.maxIssues ?? 30, startedAt);
    }
    if (json.asset?.version !== '2.0') {
        collector.error('GLTF_VERSION', 'asset.version', `仅支持 glTF 2.0，当前为 ${JSON.stringify(json.asset?.version)}`);
    }
    if (json.asset?.generator) stats.generator = String(json.asset.generator).slice(0, 60);

    const arrayFields = ['scenes', 'nodes', 'meshes', 'accessors', 'bufferViews', 'buffers', 'materials', 'textures', 'images', 'samplers', 'animations', 'skins', 'cameras'];
    for (const field of arrayFields) {
        if (json[field] !== undefined && !Array.isArray(json[field])) {
            collector.error('GLTF_ARRAY_FIELD', field, '应为数组');
        }
    }

    const ctx: GltfContext = {
        workspaceRoot,
        relPath,
        absDir: path.dirname(PathUtils.resolveReadPath(relPath, workspaceRoot)),
        json,
        collector,
        deep: options.deep !== false,
        stats,
        buffers: [],
        bufferDeclared: [],
        accessorCache: new Map(),
        hugeAccessors: new Set(),
    };

    await loadGltfBuffers(ctx, glbBin);
    if (format === 'glb' && glbBin && Array.isArray(json.buffers) && json.buffers[0]?.uri !== undefined) {
        collector.warn('GLB_UNUSED_BIN', 'buffers[0].uri', 'GLB 同时包含 BIN chunk 与外部 buffer uri，BIN chunk 会被忽略');
    }
    checkGltfBuffersAndViews(ctx);
    checkGltfMeshes(ctx);
    checkGltfNodesAndScenes(ctx);
    const textureTask = checkGltfMaterialsAndTextures(ctx);
    if (textureTask) await textureTask;
    checkGltfAnimationsAndSkins(ctx);
    checkGltfExtensions(ctx);

    return finalizeReport(relPath, format, collector, stats, options.maxIssues ?? 30, startedAt);
}

// ═══════════════════════════════════════════════════════════════
// OBJ
// ═══════════════════════════════════════════════════════════════

async function checkObjAsset(
    workspaceRoot: string,
    relPath: string,
    content: string,
    startedAt: number,
    maxIssues: number,
): Promise<Scene3dCheckReport> {
    const collector = new IssueCollector();
    const stats: Record<string, string | number> = { bytes: Buffer.byteLength(content, 'utf8') };
    if (content.includes('\u0000')) {
        collector.error('OBJ_BINARY', 'file', 'OBJ 内容含 null 字节，疑似二进制文件');
        return finalizeReport(relPath, 'obj', collector, stats, maxIssues, startedAt);
    }
    let vertices = 0;
    let normals = 0;
    let uvs = 0;
    let faces = 0;
    let degenerate = 0;
    let offUnitNormals = 0;
    const mtlLibs = new Set<string>();
    let hasUsemtl = false;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line || line.startsWith('#')) continue;
        if (line.length > 1_000_000) {
            collector.warn('OBJ_LINE_TOO_LONG', `L${index + 1}`, '单行超过 1MB，可能是二进制或异常数据');
            continue;
        }
        const space = line.indexOf(' ');
        if (space < 0) continue;
        const keyword = line.slice(0, space);
        const rest = line.slice(space + 1).trim();
        if (keyword === 'v') {
            const parts = rest.split(/\s+/);
            if (parts.length < 3) {
                collector.error('OBJ_VERTEX_FIELDS', `L${index + 1}`, '顶点至少需要 3 个坐标');
                continue;
            }
            const values = parts.slice(0, 3).map(Number);
            if (!values.every(Number.isFinite)) {
                collector.error('OBJ_VERTEX_INVALID', `L${index + 1}`, `顶点坐标含 NaN/Inf：${rest.slice(0, 60)}`);
                continue;
            }
            vertices += 1;
            continue;
        }
        if (keyword === 'vn') {
            const values = rest.split(/\s+/).slice(0, 3).map(Number);
            if (values.length < 3 || !values.every(Number.isFinite)) {
                collector.error('OBJ_NORMAL_INVALID', `L${index + 1}`, '法线坐标无效');
                continue;
            }
            normals += 1;
            if (Math.abs(Math.hypot(values[0], values[1], values[2]) - 1) > 0.1) offUnitNormals += 1;
            continue;
        }
        if (keyword === 'vt') {
            uvs += 1;
            continue;
        }
        if (keyword === 'f') {
            const tokens = rest.split(/\s+/).filter(Boolean);
            if (tokens.length < 3) {
                collector.error('OBJ_FACE_TOO_FEW', `L${index + 1}`, `面至少需要 3 个顶点，实际 ${tokens.length}`);
                continue;
            }
            faces += 1;
            const indices: number[] = [];
            for (const token of tokens) {
                const raw = token.split('/')[0];
                const value = Number(raw);
                if (!Number.isInteger(value)) {
                    collector.error('OBJ_FACE_TOKEN', `L${index + 1}`, `无法解析顶点索引：${token}`);
                    indices.length = 0;
                    break;
                }
                if (value === 0) {
                    collector.error('OBJ_FACE_ZERO', `L${index + 1}`, 'OBJ 索引从 1 开始，0 非法');
                    indices.length = 0;
                    break;
                }
                const resolved = value > 0 ? value : vertices + value + 1;
                if (resolved < 1 || resolved > vertices) {
                    collector.error('OBJ_FACE_OOB', `L${index + 1}`, `顶点索引 ${value} 超出范围（当前 ${vertices} 个顶点）`);
                    indices.length = 0;
                    break;
                }
                indices.push(resolved);
            }
            if (indices.length >= 3 && new Set(indices).size !== indices.length) {
                degenerate += 1;
            }
            continue;
        }
        if (keyword === 'mtllib') {
            mtlLibs.add(rest);
            continue;
        }
        if (keyword === 'usemtl') {
            hasUsemtl = true;
        }
    }

    if (vertices === 0) collector.error('OBJ_NO_VERTICES', 'file', '未解析到任何顶点（v 行）');
    if (faces === 0) collector.error('OBJ_NO_FACES', 'file', '未解析到任何面（f 行）');
    if (hasUsemtl && mtlLibs.size === 0) {
        collector.warn('OBJ_USEMTL_WITHOUT_MTL', 'file', '使用了 usemtl 但没有 mtllib，材质不会生效');
    }
    if (offUnitNormals > 0) {
        collector.warn('OBJ_NORMAL_NOT_UNIT', 'file', `${offUnitNormals}/${normals} 个法线长度偏离 1（±10%）`, '导出前归一化法线');
    }
    if (degenerate > 0) collector.warn('OBJ_DEGENERATE_FACE', 'file', `${degenerate} 个面存在重复顶点索引`);

    const baseDir = path.dirname(PathUtils.resolveReadPath(relPath, workspaceRoot));
    for (const lib of mtlLibs) {
        try {
            await fs.access(path.resolve(baseDir, lib));
        } catch {
            collector.warn('OBJ_MTL_MISSING', 'mtllib', `材质库不存在：${lib}`, '拷贝 .mtl 或改用 .glb');
        }
    }

    stats.vertices = vertices;
    stats.normals = normals;
    stats.uvs = uvs;
    stats.faces = faces;
    return finalizeReport(relPath, 'obj', collector, stats, maxIssues, startedAt);
}

// ═══════════════════════════════════════════════════════════════
// STL
// ═══════════════════════════════════════════════════════════════

function triangleArea(a: [number, number, number], b: [number, number, number], c: [number, number, number]): number {
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
    const cx = aby * acz - abz * acy;
    const cy = abz * acx - abx * acz;
    const cz = abx * acy - aby * acx;
    return 0.5 * Math.hypot(cx, cy, cz);
}

async function checkStlAsset(
    relPath: string,
    buffer: Buffer,
    startedAt: number,
    maxIssues: number,
): Promise<Scene3dCheckReport> {
    const collector = new IssueCollector();
    const stats: Record<string, string | number> = { bytes: buffer.length };
    const declared = buffer.length >= 84 ? buffer.readUInt32LE(80) : 0;
    const isBinary = buffer.length >= 84 && 84 + declared * 50 === buffer.length;
    let triangles = 0;
    let degenerate = 0;
    let invalid = 0;
    let normalMismatch = 0;
    let ascii = false;

    if (isBinary) {
        triangles = declared;
        for (let index = 0; index < triangles; index += 1) {
            const base = 84 + index * 50;
            const normal: [number, number, number] = [
                buffer.readFloatLE(base),
                buffer.readFloatLE(base + 4),
                buffer.readFloatLE(base + 8),
            ];
            const points: Array<[number, number, number]> = [];
            for (let vertex = 0; vertex < 3; vertex += 1) {
                const offset = base + 12 + vertex * 12;
                points.push([buffer.readFloatLE(offset), buffer.readFloatLE(offset + 4), buffer.readFloatLE(offset + 8)]);
            }
            if (points.some((point) => point.some((value) => !Number.isFinite(value)))) {
                invalid += 1;
                continue;
            }
            if (triangleArea(points[0], points[1], points[2]) < 1e-12) {
                degenerate += 1;
                continue;
            }
            const abx = points[1][0] - points[0][0], aby = points[1][1] - points[0][1], abz = points[1][2] - points[0][2];
            const acx = points[2][0] - points[0][0], acy = points[2][1] - points[0][1], acz = points[2][2] - points[0][2];
            const cx = aby * acz - abz * acy;
            const cy = abz * acx - abx * acz;
            const cz = abx * acy - aby * acx;
            const length = Math.hypot(cx, cy, cz);
            if (length > 0) {
                const dot = (cx * normal[0] + cy * normal[1] + cz * normal[2]) / length;
                if (dot < 0.5) normalMismatch += 1;
            }
        }
    } else {
        const text = buffer.toString('utf8');
        if (!/^\s*solid/i.test(text.slice(0, 512))) {
            if (buffer.length >= 84 && declared > 0) {
                collector.error(
                    'STL_LENGTH_MISMATCH',
                    'header',
                    `二进制声明 ${declared} 个三角面，应为 ${84 + declared * 50} 字节，实际 ${buffer.length} 字节`,
                    '重新导出或补齐文件',
                );
            } else {
                collector.error('STL_CONTAINER', 'header', '既不是合法二进制 STL，也不含 ASCII solid 头', '重新导出 STL');
            }
            return finalizeReport(relPath, 'stl', collector, stats, maxIssues, startedAt);
        }
        ascii = true;
        let facetVertices = 0;
        let points: Array<[number, number, number]> = [];
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index].trim();
            if (line.startsWith('facet')) {
                if (facetVertices > 0 && facetVertices !== 3) {
                    collector.error('STL_FACET_VERTICES', `L${index + 1}`, `上一个 facet 顶点数为 ${facetVertices}，应为 3`);
                }
                facetVertices = 0;
                points = [];
            } else if (line.startsWith('vertex')) {
                const values = line.split(/\s+/).slice(1, 4).map(Number);
                if (values.length < 3 || !values.every(Number.isFinite)) {
                    collector.error('STL_VERTEX_INVALID', `L${index + 1}`, '顶点坐标无效');
                    continue;
                }
                facetVertices += 1;
                points.push([values[0], values[1], values[2]]);
            } else if (line.startsWith('endfacet')) {
                triangles += 1;
                if (facetVertices !== 3) {
                    collector.error('STL_FACET_VERTICES', `L${index + 1}`, `facet 顶点数为 ${facetVertices}，应为 3`);
                } else if (triangleArea(points[0], points[1], points[2]) < 1e-12) {
                    degenerate += 1;
                }
            }
        }
    }

    if (buffer.length < 84) {
        collector.error('STL_TOO_SHORT', 'header', `文件仅 ${buffer.length} 字节，不足以构成 STL 头`);
    }
    if (triangles === 0) collector.error('STL_NO_TRIANGLES', 'file', '未解析到任何三角面');
    if (invalid > 0) collector.error('STL_VERTEX_INVALID', 'file', `${invalid} 个三角面含 NaN/Inf 坐标`);
    if (degenerate > 0) collector.warn('STL_DEGENERATE', 'file', `${degenerate} 个零面积三角面`, '清理无效网格');
    if (normalMismatch > 0) {
        collector.warn('STL_NORMAL_MISMATCH', 'file', `${normalMismatch}/${triangles} 个面法线与顶点绕序不一致`, '重新计算法线或修正面朝向');
    }
    stats.triangles = triangles;
    stats.ascii = ascii ? 'true' : 'false';
    if (degenerate > 0) stats.degenerate = degenerate;
    return finalizeReport(relPath, 'stl', collector, stats, maxIssues, startedAt);
}

// ═══════════════════════════════════════════════════════════════
// scene3d
// ═══════════════════════════════════════════════════════════════

interface Bounds3 { min: [number, number, number]; max: [number, number, number] }

function unionBounds(target: Bounds3, other: Bounds3): void {
    for (let axis = 0; axis < 3; axis += 1) {
        target.min[axis] = Math.min(target.min[axis], other.min[axis]);
        target.max[axis] = Math.max(target.max[axis], other.max[axis]);
    }
}

function primitiveBounds(object: any): Bounds3 | null {
    const position = Array.isArray(object?.position) ? object.position : [0, 0, 0];
    if (!position.every(Number.isFinite)) return null;
    const scaleValue = typeof object?.scale === 'number'
        ? [object.scale, object.scale, object.scale]
        : Array.isArray(object?.scale) ? object.scale : [1, 1, 1];
    if (!scaleValue.every((value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0)) return null;
    const sx = scaleValue[0], sy = scaleValue[1], sz = scaleValue[2];
    const make = (rx: number, ry: number, rz: number): Bounds3 => ({
        min: [position[0] - rx * sx, position[1] - ry * sy, position[2] - rz * sz],
        max: [position[0] + rx * sx, position[1] + ry * sy, position[2] + rz * sz],
    });
    const number = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
    switch (object?.type) {
        case 'box': {
            const size = object.size;
            if (typeof size === 'number') return make(size / 2, size / 2, size / 2);
            if (Array.isArray(size) && size.length === 3) return make(size[0] / 2, size[1] / 2, size[2] / 2);
            return make(0.5, 0.5, 0.5);
        }
        case 'sphere': {
            const radius = number(object.radius, 0.5);
            return make(radius, radius, radius);
        }
        case 'cylinder':
        case 'cone': {
            const radius = Math.max(number(object.radius, 0.5), number(object.radiusTop, 0), number(object.radiusBottom, 0));
            const height = number(object.height, 1);
            return make(radius, height / 2, radius);
        }
        case 'capsule': {
            const radius = number(object.radius, 0.3);
            return make(radius, number(object.length, 0.6) / 2 + radius, radius);
        }
        case 'torus':
        case 'torusKnot': {
            const radius = number(object.radius, 0.5) + number(object.tube, 0.2);
            return make(radius, radius, radius);
        }
        case 'plane':
            return make(number(object.width, 1) / 2, number(object.height, 1) / 2, 0);
        case 'ring':
            return make(number(object.outerRadius, 0.5), number(object.outerRadius, 0.5), 0);
        default:
            return null;
    }
}

function scenePrimitiveBounds(objects: any[]): Bounds3 | null {
    const target: Bounds3 = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    let found = false;
    const walk = (list: any[]) => {
        for (const object of list) {
            if (!isRecord(object)) continue;
            if (object.type === 'group' && Array.isArray(object.children)) {
                walk(object.children);
                continue;
            }
            const bounds = primitiveBounds(object);
            if (bounds) {
                unionBounds(target, bounds);
                found = true;
            }
        }
    };
    walk(objects);
    return found ? target : null;
}

async function checkScene3dSpecContent(
    workspaceRoot: string,
    relPath: string,
    content: string,
    options: Scene3dCheckOptions,
    startedAt: number,
): Promise<Scene3dCheckReport> {
    const collector = new IssueCollector();
    const stats: Record<string, string | number> = { bytes: Buffer.byteLength(content, 'utf8') };
    let parsed: unknown;
    try {
        parsed = JSON.parse(content.replace(/^\uFEFF/, ''));
    } catch (error: any) {
        collector.error('SCENE3D_JSON_PARSE', 'root', `JSON 解析失败：${error?.message || error}`);
        return finalizeReport(relPath, 'scene3d', collector, stats, options.maxIssues ?? 30, startedAt);
    }
    if (Buffer.byteLength(content, 'utf8') > SCENE3D_MAX_SPEC_BYTES) {
        collector.warn('SCENE3D_TOO_LARGE', 'root', `场景 JSON 超过 ${Math.round(SCENE3D_MAX_SPEC_BYTES / 1024)}KB 预算`);
    }
    const validation = validateScene3dSpec(parsed);
    for (const issue of validation.errors) {
        collector.error('SCENE3D_SPEC', issue.path, issue.message, issue.fix);
    }
    for (const issue of validation.warnings) {
        collector.warn('SCENE3D_SPEC', issue.path, issue.message, issue.fix);
    }
    if (!validation.ok || !validation.spec) {
        return finalizeReport(relPath, 'scene3d', collector, stats, options.maxIssues ?? 30, startedAt);
    }
    const spec = validation.spec;
    stats.objects = validation.summary.match(/objects=(\d+)/)?.[1] ?? '?';
    stats.estTriangles = validation.estimatedTriangles;

    const baseDir = path.posix.dirname(normalizeAssetPath(relPath));
    let modelTriangles = 0;
    let refCount = 0;
    const refs = collectScene3dRefs(spec);
    stats.refs = refs.length;
    for (const src of refs) {
        if (/^(?:[a-zA-Z]:[\\/]|\/|data:|https?:)/.test(src)) {
            collector.warn('SCENE3D_REF_ABSOLUTE', 'objects', `引用了绝对路径/外部 URL：${src}`, '改用相对场景文件的路径，便于迁移');
            continue;
        }
        refCount += 1;
        const targetRel = path.posix.normalize(path.posix.join(baseDir, src));
        let targetAbs: string;
        try {
            targetAbs = PathUtils.resolveReadPath(targetRel, workspaceRoot);
        } catch {
            collector.error('SCENE3D_REF_INVALID', src, '引用路径无法解析');
            continue;
        }
        const workspaceAbs = path.resolve(workspaceRoot);
        const relativeToRoot = path.relative(workspaceAbs, targetAbs);
        if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
            collector.error('SCENE3D_REF_OUTSIDE', src, '引用越过工作区边界', '把资产拷贝进工作区 .3d/');
            continue;
        }
        let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
        try {
            stat = await fs.stat(targetAbs);
        } catch {
            stat = null;
        }
        if (!stat || !stat.isFile()) {
            collector.error('SCENE3D_REF_MISSING', src, '引用文件不存在', `补齐 ${targetRel} 或改用 .glb`);
            continue;
        }
        const extension = path.extname(targetRel).toLowerCase();
        if (IMAGE_EXTENSIONS.has(extension)) {
            await checkTexture(targetAbs, targetRel, collector, {});
        } else if (MODEL_EXTENSIONS.has(extension)) {
            try {
                const info = await inspectScene3dAsset(workspaceRoot, targetRel);
                const triangles = Number(info.meta?.triangles ?? 0);
                modelTriangles += triangles;
                if (triangles === 0) {
                    collector.warn('SCENE3D_MODEL_EMPTY', src, '模型未包含三角面（可能是空壳/非三角面模式）');
                }
                const size = info.meta?.bounds?.size;
                if (Array.isArray(size)) {
                    const maxSide = Math.max(...size);
                    const minSide = Math.min(...size.filter((value: number) => value > 0));
                    if (maxSide > 1000) collector.warn('SCENE3D_MODEL_SCALE', src, `模型尺寸 ${maxSide.toFixed(1)} 单位偏大，检查导出单位`);
                    if (Number.isFinite(minSide) && minSide < 0.001) collector.warn('SCENE3D_MODEL_SCALE', src, `模型尺寸 ${minSide} 过小，可能是毫米单位未换算`);
                }
                for (const warning of info.warnings.slice(0, 2)) collector.warn('SCENE3D_MODEL_WARN', src, warning);
            } catch (error: any) {
                collector.error('SCENE3D_REF_INVALID', src, `模型解析失败：${error?.message || error}`);
            }
        } else {
            collector.warn('SCENE3D_REF_TYPE', src, `不支持的引用类型：${extension}`);
        }
    }
    stats.modelTriangles = modelTriangles;
    const totalTriangles = validation.estimatedTriangles + modelTriangles;
    stats.estTriangles = totalTriangles;
    if (totalTriangles > 500_000) {
        collector.warn('SCENE3D_TRIANGLE_BUDGET', 'objects', `场景预估 ${totalTriangles} 三角面，Web 端可能掉帧`, '减面或拆分场景');
    }

    const lights = Array.isArray(spec.lights) ? spec.lights : [];
    if (lights.length === 0) {
        collector.warn('SCENE3D_NO_LIGHTS', 'lights', '未声明灯光，将使用默认三点光；如需可控光照请显式声明');
    } else {
        const totalIntensity = lights.reduce((sum: number, light: any) => sum + (typeof light?.intensity === 'number' ? light.intensity : 1), 0);
        if (totalIntensity <= 0) {
            collector.error('SCENE3D_LIGHTS_ZERO', 'lights', '所有灯光强度为 0，渲染结果会全黑');
        }
    }

    const camera = spec.camera;
    if (camera && Array.isArray(camera.position) && Array.isArray(camera.target)) {
        const distance = Math.hypot(
            camera.position[0] - camera.target[0],
            camera.position[1] - camera.target[1],
            camera.position[2] - camera.target[2],
        );
        if (distance < 1e-6) {
            collector.error('SCENE3D_CAMERA_DEGENERATE', 'camera', '相机位置与目标点重合，视角无法计算');
        }
        const bounds = scenePrimitiveBounds(Array.isArray(spec.objects) ? spec.objects : []);
        if (bounds) {
            const inside = [0, 1, 2].every((axis) => camera.position[axis] > bounds.min[axis] && camera.position[axis] < bounds.max[axis]);
            if (inside) {
                collector.warn('SCENE3D_CAMERA_INSIDE', 'camera.position', '相机位于物体包围盒内部，可能看到背面/内部', '把相机移出模型范围');
            }
        }
    }

    stats.lights = lights.length;
    stats.refsChecked = refCount;
    return finalizeReport(relPath, 'scene3d', collector, stats, options.maxIssues ?? 30, startedAt);
}

// ═══════════════════════════════════════════════════════════════
// manifest
// ═══════════════════════════════════════════════════════════════

async function checkManifest(
    workspaceRoot: string,
    relPath: string,
    options: Scene3dCheckOptions,
    startedAt: number,
): Promise<Scene3dCheckReport> {
    const collector = new IssueCollector();
    const stats: Record<string, string | number> = {};
    const manifestPath = PathUtils.resolveReadPath(relPath, workspaceRoot);
    let manifestRaw: string;
    try {
        manifestRaw = await fs.readFile(manifestPath, 'utf8');
    } catch {
        collector.error('MANIFEST_MISSING', relPath, '资产清单不存在', '先执行任意 3D 工具或 create_3d_scaffold 初始化 .3d/');
        return finalizeReport(relPath, 'manifest', collector, stats, options.maxIssues ?? 30, startedAt);
    }
    try {
        JSON.parse(manifestRaw);
    } catch (error: any) {
        collector.error('MANIFEST_JSON', relPath, `JSON 解析失败：${error?.message || error}`);
        return finalizeReport(relPath, 'manifest', collector, stats, options.maxIssues ?? 30, startedAt);
    }
    const manifest = await readScene3dManifest(workspaceRoot);
    stats.assets = manifest.assets.length;
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();
    let missing = 0;
    for (const asset of manifest.assets) {
        const assetPath = normalizeAssetPath(asset.path);
        if (seenIds.has(asset.id)) collector.error('MANIFEST_DUPLICATE_ID', assetPath, `重复的资产 id：${asset.id}`);
        seenIds.add(asset.id);
        if (seenPaths.has(assetPath)) collector.error('MANIFEST_DUPLICATE_PATH', assetPath, '同一路径登记了多次');
        seenPaths.add(assetPath);
        if (toAssetSlug(asset.id) !== asset.id) {
            collector.warn('MANIFEST_ID_FORMAT', assetPath, `id "${asset.id}" 不是小写 kebab`, '用 register_3d_asset 重新登记');
        }
        const expectedDir = asset.kind === 'model' ? `${SCENE3D_DIR}/models/` : asset.kind === 'scene' ? `${SCENE3D_DIR}/scenes/` : `${SCENE3D_DIR}/textures/`;
        if (!assetPath.startsWith(expectedDir)) {
            collector.warn('MANIFEST_KIND_PATH', assetPath, `${asset.kind} 资产不在 ${expectedDir} 下`, '归档到规范目录或修正 kind');
        }
        let absolute: string;
        try {
            absolute = PathUtils.resolveReadPath(assetPath, workspaceRoot);
        } catch {
            collector.error('MANIFEST_PATH_INVALID', assetPath, '资产路径无法解析');
            continue;
        }
        const relativeToRoot = path.relative(path.resolve(workspaceRoot), path.resolve(absolute));
        if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
            collector.error('MANIFEST_PATH_OUTSIDE', assetPath, '资产路径越过工作区边界', '把资产归档到工作区 .3d/');
            continue;
        }
        let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
        try {
            stat = await fs.stat(absolute);
        } catch {
            stat = null;
        }
        if (!stat || !stat.isFile()) {
            missing += 1;
            collector.error('MANIFEST_FILE_MISSING', assetPath, '登记的资产文件不存在', '恢复文件或从 manifest 移除');
            continue;
        }
        if (typeof asset.bytes === 'number' && asset.bytes !== stat.size) {
            collector.warn('MANIFEST_SIZE_MISMATCH', assetPath, `登记 ${asset.bytes} 字节，实际 ${stat.size} 字节`, '重新 register_3d_asset');
        }
        if (options.deep !== false && typeof asset.hash === 'string' && asset.hash) {
            const actual = crypto.createHash('sha256').update(await fs.readFile(absolute)).digest('hex');
            if (actual !== asset.hash) {
                collector.error('MANIFEST_HASH_MISMATCH', assetPath, '文件哈希与登记不一致（资产被手改）', '重新 register_3d_asset');
            }
        }
        if (asset.preview) {
            try {
                await fs.access(PathUtils.resolveReadPath(normalizeAssetPath(asset.preview), workspaceRoot));
            } catch {
                collector.warn('MANIFEST_PREVIEW_MISSING', assetPath, `预览图不存在：${asset.preview}`, '运行 render_3d_preview');
            }
        }
    }
    stats.missing = missing;
    try {
        const tempDir = PathUtils.resolveReadPath(SCENE3D_TEMP_DIR, workspaceRoot);
        const entries = await fs.readdir(tempDir).catch(() => [] as string[]);
        if (entries.length > 0) {
            collector.warn('MANIFEST_TEMP_NOT_CLEAN', SCENE3D_TEMP_DIR, `临时目录仍有 ${entries.length} 项`, '交付前清理 .3d/.temp/');
        }
    } catch {
        // ignore
    }
    return finalizeReport(relPath, 'manifest', collector, stats, options.maxIssues ?? 30, startedAt);
}

// ═══════════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════════

function formatOfPath(relPath: string): Scene3dCheckFormat | null {
    const lower = normalizeAssetPath(relPath).toLowerCase();
    if (lower === SCENE3D_MANIFEST_PATH) return 'manifest';
    if (lower.endsWith('.scene3d.json')) return 'scene3d';
    const detected = detectScene3dFormat(lower);
    if (detected) return detected;
    if (IMAGE_EXTENSIONS.has(path.extname(lower))) return 'texture';
    return null;
}

export async function checkScene3dFile(
    workspaceRoot: string,
    target: string,
    options: Scene3dCheckOptions = {},
): Promise<Scene3dCheckReport> {
    const startedAt = Date.now();
    const relPath = normalizeAssetPath(target);
    const format = formatOfPath(relPath);
    if (!format) {
        const collector = new IssueCollector();
        collector.error('CHECK_UNSUPPORTED', relPath, '不支持的文件类型（scene3d/glb/gltf/obj/stl/图片/manifest.json）');
        return finalizeReport(relPath, 'texture', collector, {}, options.maxIssues ?? 30, startedAt);
    }
    const maxIssues = options.maxIssues ?? 30;
    if (format === 'manifest') {
        return checkManifest(workspaceRoot, relPath, options, startedAt);
    }
    const absolute = PathUtils.resolveReadPath(relPath, workspaceRoot);
    if (format === 'texture') {
        const collector = new IssueCollector();
        const stats: Record<string, string | number> = {};
        let header: ImageHeader;
        let size = 0;
        try {
            const stat = await fs.stat(absolute);
            size = stat.size;
            stats.bytes = size;
            const head = size <= MAX_TEXTURE_BYTES
                ? await fs.readFile(absolute)
                : await readFileHead(absolute, MAX_IMAGE_HEADER_BYTES);
            header = readImageHeader(head);
        } catch (error: any) {
            collector.error('CHECK_READ_FAILED', relPath, `读取失败：${error?.message || error}`);
            return finalizeReport(relPath, format, collector, stats, maxIssues, startedAt);
        }
        const extension = path.extname(relPath).toLowerCase();
        const expected = extension === '.jpg' || extension === '.jpeg' ? 'jpeg' : extension.slice(1);
        if (header.format === 'unknown') {
            collector.error('TEXTURE_FORMAT_UNKNOWN', relPath, '无法识别图片格式（支持 PNG/JPEG/WebP/KTX2）');
        } else if (expected && expected !== header.format) {
            collector.warn('TEXTURE_MIME_MISMATCH', relPath, `扩展名 ${extension} 与实际格式 ${header.format} 不一致`, '统一扩展名与文件内容');
        }
        stats.format = header.format;
        if (header.width && header.height) {
            stats.size = `${header.width}x${header.height}`;
            if (Math.max(header.width, header.height) > 2048) {
                collector.warn('TEXTURE_TOO_LARGE', relPath, `尺寸 ${header.width}x${header.height} 超过 2048`, '压缩或生成 LOD');
            }
            if (!isPowerOfTwo(header.width) || !isPowerOfTwo(header.height)) {
                collector.warn('TEXTURE_NOT_POT', relPath, `尺寸 ${header.width}x${header.height} 不是 2 的幂`, '使用 512/1024/2048');
            }
        }
        if (size > 5 * 1024 * 1024) {
            collector.warn('TEXTURE_HEAVY', relPath, `文件 ${formatBytes(size)} 超过 5MB`, '压缩或降低分辨率');
        }
        return finalizeReport(relPath, 'texture', collector, stats, maxIssues, startedAt);
    }

    let buffer: Buffer;
    try {
        buffer = await fs.readFile(absolute);
    } catch (error: any) {
        const collector = new IssueCollector();
        collector.error('CHECK_READ_FAILED', relPath, `读取失败：${error?.message || error}`);
        return finalizeReport(relPath, format, collector, {}, maxIssues, startedAt);
    }

    if (format === 'scene3d') {
        const content = options.content ?? buffer.toString('utf8');
        return checkScene3dSpecContent(workspaceRoot, relPath, content, options, startedAt);
    }
    if (format === 'obj') {
        const content = options.content ?? buffer.toString('utf8');
        return checkObjAsset(workspaceRoot, relPath, content, startedAt, maxIssues);
    }
    if (format === 'stl') {
        if (options.content !== undefined) {
            const collector = new IssueCollector();
            collector.error('STL_CONTENT_UNSUPPORTED', relPath, 'STL 为二进制格式，不支持 content 预检；请写入文件后检查');
            return finalizeReport(relPath, 'stl', collector, {}, maxIssues, startedAt);
        }
        return checkStlAsset(relPath, buffer, startedAt, maxIssues);
    }
    return checkGltfAsset(workspaceRoot, relPath, buffer, options, startedAt);
}

/** 内容预检：用于写入磁盘前的检查（scene3d / gltf / obj） */
export async function checkScene3dContent(
    workspaceRoot: string,
    content: string,
    options: Scene3dCheckOptions & { format: 'scene3d' | 'gltf' | 'obj' },
): Promise<Scene3dCheckReport> {
    const startedAt = Date.now();
    const relPath = normalizeAssetPath(options.filePath || `inline.${options.format === 'scene3d' ? 'scene3d' : options.format}${options.format === 'scene3d' ? '.json' : ''}`);
    if (options.format === 'scene3d') return checkScene3dSpecContent(workspaceRoot, relPath, content, options, startedAt);
    if (options.format === 'obj') return checkObjAsset(workspaceRoot, relPath, content, startedAt, options.maxIssues ?? 30);
    const buffer = Buffer.from(content, 'utf8');
    return checkGltfAsset(workspaceRoot, relPath, buffer, options, startedAt);
}

function collectCheckableFiles(dir: string, root: string, depth: number, output: string[]): void {
    if (depth > MAX_BATCH_DEPTH || output.length >= MAX_BATCH_FILES * 4) return;
    let entries: Dirent[];
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.temp') continue;
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectCheckableFiles(absolute, root, depth + 1, output);
            continue;
        }
        if (!entry.isFile()) continue;
        const rel = normalizeAssetPath(path.relative(root, absolute));
        // 预览图是产物而非输入资产，不参与贴图预算/POT 检查（manifest 会校验其存在性）
        if (rel.startsWith(`${SCENE3D_DIR}/renders/`)) continue;
        if (formatOfPath(rel)) output.push(rel);
    }
}

/** 目录批量体检：清单 + 所有支持的资产（深度受控） */
export async function checkScene3dDirectory(
    workspaceRoot: string,
    target: string,
    options: Scene3dCheckOptions = {},
): Promise<Scene3dCheckBatch> {
    const startedAt = Date.now();
    const relDir = normalizeAssetPath(target || '.');
    const absoluteDir = PathUtils.resolveReadPath(relDir, workspaceRoot);
    // `check_3d_asset path=.` 视为"体检整个 3D 资产库"，自动收敛到 .3d/
    const scanDir = relDir === '.' ? path.join(path.resolve(workspaceRoot), SCENE3D_DIR) : absoluteDir;
    const files: string[] = [];
    collectCheckableFiles(scanDir, path.resolve(workspaceRoot), 0, files);
    const unique = Array.from(new Set(files));
    const limited = unique.slice(0, MAX_BATCH_FILES);
    const reports: Scene3dCheckReport[] = [];
    for (const file of limited) {
        reports.push(await checkScene3dFile(workspaceRoot, file, options));
    }
    return {
        target: relDir,
        reports,
        errorCount: reports.reduce((sum, report) => sum + report.errorCount, 0),
        warningCount: reports.reduce((sum, report) => sum + report.warningCount, 0),
        durationMs: Date.now() - startedAt,
        skippedFiles: Math.max(0, unique.length - limited.length),
    };
}

export function formatScene3dCheckReport(report: Scene3dCheckReport, maxIssues = 20): string {
    const statsText = Object.entries(report.stats)
        .map(([key, value]) => `${key}=${value}`)
        .join(' ');
    const lines = [
        `[check_3d] ${report.status} ${report.target} | ${report.format}${statsText ? ` | ${statsText}` : ''}` +
        ` | errors=${report.errorCount} warnings=${report.warningCount} duration=${report.durationMs}ms`,
    ];
    const shown = report.issues.slice(0, maxIssues);
    for (const issue of shown) {
        const icon = issue.severity === 'error' ? '✗' : '⚠';
        lines.push(`${icon} ${issue.code} ${issue.location}: ${issue.message}${issue.fix ? `（${issue.fix}）` : ''}`);
    }
    const hidden = report.totalIssues - shown.length;
    if (hidden > 0) lines.push(`…另有 ${hidden} 条未显示（先修上面的，或调大 maxIssues）`);
    return lines.join('\n');
}

export function formatScene3dCheckBatch(batch: Scene3dCheckBatch, maxIssuesPerFile = 6): string {
    const lines = [
        `[check_3d] ${batch.errorCount > 0 ? 'ERROR' : batch.warningCount > 0 ? 'WARN' : 'OK'} ${batch.target} | files=${batch.reports.length}` +
        ` errors=${batch.errorCount} warnings=${batch.warningCount} duration=${batch.durationMs}ms` +
        (batch.skippedFiles > 0 ? ` skipped=${batch.skippedFiles}` : ''),
    ];
    for (const report of batch.reports) {
        const statsText = Object.entries(report.stats)
            .filter(([key]) => ['assets', 'missing', 'triangles', 'objects', 'estTriangles', 'size', 'format', 'bytes'].includes(key))
            .map(([key, value]) => `${key}=${value}`)
            .join(' ');
        if (report.status === 'OK') {
            lines.push(`✓ ${report.target} | ${report.format}${statsText ? ` | ${statsText}` : ''}`);
            continue;
        }
        const reportIcon = report.status === 'ERROR' ? '✗' : '⚠';
        lines.push(`${reportIcon} ${report.target} | ${report.format} | errors=${report.errorCount} warnings=${report.warningCount}${statsText ? ` | ${statsText}` : ''}`);
        for (const issue of report.issues.slice(0, maxIssuesPerFile)) {
            const icon = issue.severity === 'error' ? '✗' : '⚠';
            lines.push(`  ${icon} ${issue.code} ${issue.location}: ${issue.message}`);
        }
        const hidden = report.totalIssues - Math.min(report.issues.length, maxIssuesPerFile);
        if (hidden > 0) lines.push(`  …另有 ${hidden} 条`);
    }
    return lines.join('\n');
}
