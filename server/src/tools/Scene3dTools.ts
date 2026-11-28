/**
 * 3D 原子工具集：场景创建、预渲染、资产解析、清单查询、登记导入。
 *
 * 设计原则与仓库其它工具一致：动宾命名、单次只做一件事、返回紧凑文本。
 * 所有 3D 产物统一落在工作区 .3d/ 下，临时文件放 .3d/.temp/。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { PathUtils } from '@/utils/PathUtils.js';
import {
    collectScene3dRefs,
    formatScene3dIssues,
    validateScene3dSpec,
    type Scene3dValidation,
} from '@/scene3d/spec.js';
import {
    detectScene3dFormat,
    formatBytes,
    formatScene3dAssetInfo,
    inspectScene3dAsset,
    type Scene3dAssetInfo,
} from '@/scene3d/assetInspector.js';
import {
    SCENE3D_MODELS_DIR,
    SCENE3D_RENDERS_DIR,
    SCENE3D_SCENES_DIR,
    SCENE3D_TEXTURES_DIR,
    assetIdFromPath,
    classifyScene3dKind,
    ensureScene3dScaffold,
    formatScene3dManifestEntry,
    hashFile,
    isInsideScene3dDir,
    isNonAsciiName,
    listScene3dAssets,
    normalizeAssetPath,
    toAssetSlug,
    upsertScene3dAsset,
    type Scene3dAssetKind,
} from '@/scene3d/manifest.js';
import { renderScene3dPreview, type Scene3dRenderResult } from '@/scene3d/previewRenderer.js';
import {
    checkScene3dContent,
    checkScene3dDirectory,
    checkScene3dFile,
    formatScene3dCheckBatch,
    formatScene3dCheckReport,
} from '@/scene3d/assetChecker.js';

const MODEL_EXTENSIONS = new Set(['.glb', '.gltf', '.obj', '.stl']);
const TEXTURE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ktx2']);

function formatBounds(bounds: Scene3dRenderResult['stats']['bounds'] | undefined): string {
    if (!bounds) return 'bounds=?';
    const round = (value: number) => Math.round(value * 100) / 100;
    return `bounds=${round(bounds.size[0])}×${round(bounds.size[1])}×${round(bounds.size[2])} center=[${bounds.center.map(round).join(',')}]`;
}

function formatRenderResult(outputPath: string, result: Scene3dRenderResult): string {
    const coverage = result.pixelStats ? `${(result.pixelStats.coverage * 100).toFixed(1)}%` : 'n/a';
    const meanLuma = result.pixelStats ? result.pixelStats.meanLuma.toFixed(3) : 'n/a';
    return [
        `[3d] ${outputPath} (${formatBytes(result.png.length)}, ${result.width}×${result.height})`,
        `tris=${result.stats.triangles} meshes=${result.stats.meshes} calls=${result.stats.drawCalls} objects=${result.stats.objects}`,
        formatBounds(result.stats.bounds),
        `coverage=${coverage} meanLuma=${meanLuma} duration=${result.durationMs}ms`,
        result.pixelStats && result.pixelStats.coverage < 0.005
            ? '⚠ 画面几乎为空（主体可能过小、在相机后方或材质全黑），请调整 camera/position/scale 后重渲染'
            : '',
    ].filter(Boolean).join('\n');
}

function resolveScenePath(workspaceRoot: string, name: string): string {
    const slug = toAssetSlug(name, 'scene');
    return normalizeAssetPath(`${SCENE3D_SCENES_DIR}/${slug}.scene3d.json`);
}

async function writeUtf8File(workspaceRoot: string, relPath: string, content: string): Promise<void> {
    const absolute = PathUtils.resolveWritePath(relPath, workspaceRoot);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
}

async function writeBinaryFile(workspaceRoot: string, relPath: string, content: Buffer): Promise<void> {
    const absolute = PathUtils.resolveWritePath(relPath, workspaceRoot);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
}

async function loadSceneSpec(workspaceRoot: string, relPath: string): Promise<{ validation: Scene3dValidation; raw: string }> {
    const absolute = PathUtils.resolveReadPath(relPath, workspaceRoot);
    const raw = await fs.readFile(absolute, 'utf8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch (error: any) {
        throw new Error(`场景 JSON 解析失败（${relPath}）：${error?.message || error}`);
    }
    return { validation: validateScene3dSpec(parsed), raw };
}

async function missingRefs(workspaceRoot: string, relPath: string, spec: Record<string, any>): Promise<string[]> {
    const baseDir = path.posix.dirname(normalizeAssetPath(relPath));
    const missing: string[] = [];
    for (const src of collectScene3dRefs(spec)) {
        if (/^(?:[a-zA-Z]:[\\/]|\/|data:|https?:)/.test(src)) continue;
        const target = path.posix.normalize(path.posix.join(baseDir, src));
        try {
            const absolute = PathUtils.resolveReadPath(target, workspaceRoot);
            const stat = await fs.stat(absolute);
            if (!stat.isFile()) missing.push(src);
        } catch {
            missing.push(src);
        }
    }
    return missing;
}

function modelSpec(modelPath: string): Record<string, any> {
    return {
        schema: 'scene3d/v1',
        render: { grid: true, environment: 'studio' },
        objects: [{ type: 'model', src: normalizeAssetPath(modelPath), castShadow: true, receiveShadow: true }],
    };
}

export class Scene3dTools {
    constructor(private workspaceRoot: string) {}

    /** 写场景 JSON + 建档（+ 可选预览渲染） */
    async createScene(params: any) {
        const name = String(params?.name ?? '').trim();
        if (!name) throw new Error('create_3d_scene 需要 name 参数（用于生成文件名与资产 id）');
        if (!params?.spec || typeof params.spec !== 'object' || Array.isArray(params.spec)) {
            throw new Error('create_3d_scene 需要 spec 对象（scene3d/v1 场景规范）');
        }

        const validation = validateScene3dSpec(params.spec);
        if (!validation.ok) {
            throw new Error(`场景规范校验失败，修正后重试：\n${formatScene3dIssues(validation)}`);
        }
        const spec = validation.spec!;
        if (!spec.name) spec.name = name;

        const targetPath = resolveScenePath(this.workspaceRoot, name);
        const created = await ensureScene3dScaffold(this.workspaceRoot);
        await writeUtf8File(this.workspaceRoot, targetPath, `${JSON.stringify(spec, null, 2)}\n`);

        const absolute = PathUtils.resolveWritePath(targetPath, this.workspaceRoot);
        const stat = await fs.stat(absolute);
        const hash = await hashFile(absolute);
        const missing = await missingRefs(this.workspaceRoot, targetPath, spec);
        const warnings = validation.warnings.map((issue) => `${issue.path}: ${issue.message}`);
        for (const src of missing) warnings.push(`引用缺失：${src}（渲染前先补齐）`);

        let previewPath: string | undefined;
        let renderLine = '';
        let renderError = '';
        if (params.render !== false) {
            try {
                const rendered = await this.renderSceneSpec(spec, path.posix.dirname(targetPath), params);
                previewPath = `${SCENE3D_RENDERS_DIR}/${toAssetSlug(name, 'scene')}.png`;
                await writeBinaryFile(this.workspaceRoot, previewPath, rendered.png);
                renderLine = formatRenderResult(previewPath, rendered);
            } catch (error: any) {
                renderError = String(error?.message || error);
            }
        }

        const asset = await upsertScene3dAsset(this.workspaceRoot, {
            id: toAssetSlug(name, 'scene'),
            name,
            kind: 'scene',
            path: targetPath,
            description: typeof params.description === 'string' ? params.description : undefined,
            tags: Array.isArray(params.tags) ? params.tags.map(String).slice(0, 10) : undefined,
            preview: previewPath,
            bytes: stat.size,
            hash,
            meta: {
                summary: validation.summary,
                estimatedTriangles: validation.estimatedTriangles,
                missingRefs: missing,
            },
        });

        const lines = [
            `[3d] scene created: ${targetPath} (${formatBytes(stat.size)})`,
            `id=${asset.id} ${validation.summary}`,
        ];
        if (isNonAsciiName(name)) {
            lines.push('⚠ name 含非 ASCII 字符，slug 已回退为哈希；建议传英文/pinyin name 便于资产检索');
        }
        if (created.length > 0) lines.push(`已初始化 .3d 目录：${created.join(', ')}`);
        if (warnings.length > 0) lines.push(...warnings.slice(0, 6).map((warning) => `⚠ ${warning}`));
        if (renderLine) lines.push(renderLine);
        if (renderError) lines.push(`⚠ 预览渲染失败（场景已保存）：${renderError}`);
        lines.push('下一步：渲染检查构图 → list_3d_assets 查清单 → 需要交付时把 .glb 交给 Three.js/Babylon 或导出视频。');
        return {
            status: 'success',
            path: targetPath,
            ...(previewPath ? { preview: previewPath } : {}),
            summary: lines.join('\n'),
        };
    }

    /** 场景或模型 → PNG 预览 */
    async renderPreview(params: any) {
        const relPath = String(params?.path ?? '').trim();
        if (!relPath) throw new Error('render_3d_preview 需要 path 参数');
        const format = detectScene3dFormat(relPath);
        if (!format) throw new Error(`不支持的 3D 资产：${relPath}（支持 .glb/.gltf/.obj/.stl/.scene3d.json）`);

        let spec: Record<string, any>;
        let baseDir: string;
        if (format === 'scene3d') {
            const { validation } = await loadSceneSpec(this.workspaceRoot, relPath);
            if (!validation.ok) throw new Error(`场景规范校验失败：\n${formatScene3dIssues(validation)}`);
            spec = validation.spec!;
            baseDir = path.posix.dirname(normalizeAssetPath(relPath));
        } else {
            spec = modelSpec(relPath);
            baseDir = '';
        }
        if (typeof params.background === 'string' && params.background.trim()) {
            spec = { ...spec, background: params.background.trim() };
        }

        const rendered = await this.renderSceneSpec(spec, baseDir, params);
        const output = typeof params.output === 'string' && params.output.trim()
            ? normalizeAssetPath(params.output)
            : `${SCENE3D_RENDERS_DIR}/${assetIdFromPath(relPath) || 'preview'}.png`;
        await writeBinaryFile(this.workspaceRoot, output, rendered.png);

        // 已登记的资产刷新 preview；未登记且位于 .3d 内则补登，保证清单与实际产物一致
        if (isInsideScene3dDir(relPath)) {
            const inspected = await inspectScene3dAsset(this.workspaceRoot, relPath).catch(() => null);
            await upsertScene3dAsset(this.workspaceRoot, {
                id: assetIdFromPath(relPath),
                name: inspected?.path ? path.posix.basename(inspected.path) : path.posix.basename(relPath),
                kind: classifyScene3dKind(relPath),
                path: relPath,
                preview: output,
                bytes: inspected?.bytes,
                meta: {
                    ...(inspected?.meta ?? {}),
                    lastRender: {
                        width: rendered.width,
                        height: rendered.height,
                        coverage: rendered.pixelStats?.coverage ?? null,
                        triangles: rendered.stats.triangles,
                        durationMs: rendered.durationMs,
                    },
                },
            });
        }

        const hint = isInsideScene3dDir(relPath)
            ? ''
            : `\n提示：该文件不在 .3d 内，未写入 manifest；需要归档时调用 register_3d_asset path=${relPath}。`;
        return formatRenderResult(output, rendered) + hint;
    }

    /** 资产结构解析（模型/场景） */
    async inspectAsset(params: any) {
        const relPath = String(params?.path ?? '').trim();
        if (!relPath) throw new Error('inspect_3d_asset 需要 path 参数');
        const info: Scene3dAssetInfo = await inspectScene3dAsset(this.workspaceRoot, relPath);
        return formatScene3dAssetInfo(info);
    }

    /** manifest 查询；文件缺失会标注 missing */
    async listAssets(params: any) {
        const kind = typeof params?.kind === 'string' ? params.kind.trim() as Scene3dAssetKind : undefined;
        const { assets, total } = await listScene3dAssets(this.workspaceRoot, {
            kind: kind || undefined,
            tag: typeof params?.tag === 'string' ? params.tag : undefined,
            query: typeof params?.query === 'string' ? params.query : undefined,
            limit: params?.limit,
        });
        if (total === 0) {
            return '[3d] .3d/manifest.json 中没有匹配资产。先用 create_3d_scene / register_3d_asset 建档。';
        }
        const lines = [`[3d] assets=${total}（显示 ${assets.length}）`];
        for (const asset of assets) lines.push(`- ${formatScene3dManifestEntry(asset)}`);
        const missing = assets.filter((asset) => asset.missing).length;
        if (missing > 0) lines.push(`⚠ ${missing} 个资产文件缺失：从 manifest 移除或恢复文件`);
        return lines.join('\n');
    }

    /** 登记 / 导入资产到 .3d 并写入 manifest */
    async registerAsset(params: any) {
        const sourcePath = normalizeAssetPath(String(params?.path ?? '').trim());
        if (!sourcePath) throw new Error('register_3d_asset 需要 path 参数');

        await ensureScene3dScaffold(this.workspaceRoot);
        const sourceAbsolute = PathUtils.resolveReadPath(sourcePath, this.workspaceRoot);
        const stat = await fs.stat(sourceAbsolute).catch(() => null);
        if (!stat || !stat.isFile()) throw new Error(`文件不存在：${sourcePath}`);

        const extension = path.extname(sourcePath).toLowerCase();
        const isSceneSpec = sourcePath.toLowerCase().endsWith('.scene3d.json');
        const kind: Scene3dAssetKind = MODEL_EXTENSIONS.has(extension)
            ? 'model'
            : isSceneSpec
                ? 'scene'
                : TEXTURE_EXTENSIONS.has(extension)
                    ? 'texture'
                    : classifyScene3dKind(sourcePath);
        if (!MODEL_EXTENSIONS.has(extension) && !TEXTURE_EXTENSIONS.has(extension) && !isSceneSpec) {
            throw new Error(`不支持的资产扩展名：${extension}（模型 glb/gltf/obj/stl，贴图 png/jpg/webp，场景 .scene3d.json）`);
        }

        const requestedName = String(params?.name ?? '').trim() || path.posix.basename(sourcePath, isSceneSpec ? '.scene3d.json' : extension);
        const slug = toAssetSlug(requestedName, kind);
        const targetDir = kind === 'model' ? SCENE3D_MODELS_DIR : kind === 'scene' ? SCENE3D_SCENES_DIR : SCENE3D_TEXTURES_DIR;
        const suffix = isSceneSpec ? '.scene3d.json' : extension;
        let targetPath = sourcePath;

        const copy = params?.copy !== false && !sourcePath.startsWith(`${targetDir}/`);
        if (copy) {
            targetPath = `${targetDir}/${slug}${suffix}`;
            let absolute = PathUtils.resolveWritePath(targetPath, this.workspaceRoot);
            let version = 2;
            while (true) {
                const existing = await fs.stat(absolute).catch(() => null);
                if (!existing) break;
                if (existing.size === stat.size && (await hashFile(absolute)) === (await hashFile(sourceAbsolute))) break;
                targetPath = `${targetDir}/${slug}-v${String(version).padStart(2, '0')}${suffix}`;
                absolute = PathUtils.resolveWritePath(targetPath, this.workspaceRoot);
                version += 1;
                if (version > 99) throw new Error(`目标目录中同名资产过多：${targetDir}/${slug}${suffix}`);
            }
            const alreadySameFile = normalizeAssetPath(targetPath) === sourcePath;
            if (!alreadySameFile) {
                await fs.mkdir(path.dirname(absolute), { recursive: true });
                await fs.copyFile(sourceAbsolute, absolute);
            }
        }

        const inspected = MODEL_EXTENSIONS.has(extension) || isSceneSpec
            ? await inspectScene3dAsset(this.workspaceRoot, targetPath).catch(() => null)
            : null;
        const absolute = PathUtils.resolveWritePath(targetPath, this.workspaceRoot);
        const copiedStat = await fs.stat(absolute);
        const record = await upsertScene3dAsset(this.workspaceRoot, {
            id: toAssetSlug(requestedName, kind),
            name: requestedName,
            kind,
            path: targetPath,
            description: typeof params?.description === 'string' ? params.description : undefined,
            tags: Array.isArray(params?.tags) ? params.tags.map(String).slice(0, 10) : undefined,
            bytes: copiedStat.size,
            hash: await hashFile(absolute),
            meta: inspected?.meta,
        });

        const lines = [
            `[3d] asset registered: ${record.path} (${formatBytes(copiedStat.size)})`,
            `id=${record.id} kind=${record.kind}${copy ? `（已复制到 ${targetDir}/）` : ''}`,
        ];
        if (inspected) {
            lines.push(inspected.summary);
            for (const warning of inspected.warnings.slice(0, 4)) lines.push(`⚠ ${warning}`);
        }
        if (kind === 'scene' && copy) {
            lines.push('⚠ 场景已复制到 .3d/scenes/：相对引用（../models/x.glb）按新目录解析，请 inspect_3d_asset 复核引用。');
        }
        if (isNonAsciiName(requestedName)) {
            lines.push('⚠ name 含非 ASCII 字符，建议补一个英文 name 便于检索');
        }
        if (kind !== 'scene' && isInsideScene3dDir(record.path)) {
            lines.push(`下一步：render_3d_preview path=${record.path} 生成预览；或 create_3d_scene 把模型放进场景。`);
        }
        return lines.join('\n');
    }

    /** 3D 资产静态编译检查：文件 / 目录 / 写入前内容 */
    async checkAsset(params: any) {
        const content = typeof params?.content === 'string' ? params.content : undefined;
        const pathParam = String(params?.path ?? '').trim();
        const deep = params?.deep !== false;
        const maxIssues = params?.maxIssues;

        if (content !== undefined) {
            const explicitFormat = typeof params?.format === 'string' ? params.format : '';
            const inferred = pathParam.toLowerCase().endsWith('.scene3d.json')
                ? 'scene3d'
                : pathParam.toLowerCase().endsWith('.gltf')
                    ? 'gltf'
                    : pathParam.toLowerCase().endsWith('.obj')
                        ? 'obj'
                        : '';
            const format = (explicitFormat || inferred || 'scene3d') as 'scene3d' | 'gltf' | 'obj';
            if (!['scene3d', 'gltf', 'obj'].includes(format)) {
                throw new Error('content 预检仅支持 scene3d/gltf/obj；STL/GLB 请先写入文件');
            }
            const report = await checkScene3dContent(this.workspaceRoot, content, {
                format,
                deep,
                maxIssues,
                filePath: pathParam || undefined,
            });
            return formatScene3dCheckReport(report, maxIssues ?? 20);
        }

        if (!pathParam) throw new Error('check_3d_asset 需要 path（文件或目录）或 content');
        const absolute = PathUtils.resolveReadPath(pathParam, this.workspaceRoot);
        const stat = await fs.stat(absolute).catch(() => null);
        if (!stat) throw new Error(`路径不存在：${pathParam}`);
        if (stat.isDirectory()) {
            const batch = await checkScene3dDirectory(this.workspaceRoot, pathParam, { deep, maxIssues });
            return formatScene3dCheckBatch(batch);
        }
        const report = await checkScene3dFile(this.workspaceRoot, pathParam, { deep, maxIssues });
        return formatScene3dCheckReport(report, maxIssues ?? 20);
    }

    private async renderSceneSpec(spec: Record<string, any>, baseDir: string, params: any): Promise<Scene3dRenderResult> {
        return renderScene3dPreview({
            workspaceRoot: this.workspaceRoot,
            spec,
            baseDir,
            width: params?.width,
            height: params?.height,
        });
    }

    static getDefinitions() {
        return [
            {
                name: 'create_3d_scene',
                description: '创建/覆盖 .3d/scenes 下的 scene3d/v1 场景 JSON（文本可 diff），自动建档，默认渲染预览。做 3D 场景首选；完整 schema 见 read_skill("3d-asset")。',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: '场景名，生成 kebab 文件名与资产 id；建议英文/pinyin' },
                        spec: {
                            type: 'object',
                            description: 'scene3d/v1 规范：{ schema, background?, camera?, render?, lights?, objects:[{type,...}] }；objects 至少 1 个，type ∈ box|sphere|cylinder|cone|torus|torusKnot|plane|ring|capsule|model|group。rotation 用角度制。',
                        },
                        description: { type: 'string', description: '一句话描述，写入 manifest' },
                        tags: { type: 'array', items: { type: 'string' }, description: '检索标签，最多 10 个' },
                        render: { type: 'boolean', description: '是否立即渲染预览，默认 true；批量创建时可设 false' },
                        width: { type: 'number', description: '预览宽度，默认 1280' },
                        height: { type: 'number', description: '预览高度，默认 720' },
                    },
                    required: ['name', 'spec'],
                },
            },
            {
                name: 'render_3d_preview',
                description: '把 .3d 场景或 glb/gltf/obj/stl 模型渲染成 PNG（无头浏览器 + three.js），返回三角面、包围盒、像素覆盖率与耗时，用于自检构图。',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: '工作区相对路径（.scene3d.json 或模型文件）' },
                        width: { type: 'number', description: '宽度，默认 1280，范围 64-4096' },
                        height: { type: 'number', description: '高度，默认 720，范围 64-4096' },
                        output: { type: 'string', description: 'PNG 输出路径，默认 .3d/renders/<slug>.png' },
                        background: { type: 'string', description: '覆盖背景色，如 #0b0d12' },
                    },
                    required: ['path'],
                },
            },
            {
                name: 'inspect_3d_asset',
                description: '解析 3D 资产结构：glb/gltf 的节点/网格/三角面/材质/动画/世界包围盒；obj/stl 的顶点面数；scene3d 的校验与引用检查。导入模型后先调用。',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: '工作区相对路径' },
                    },
                    required: ['path'],
                },
            },
            {
                name: 'check_3d_asset',
                description: '3D 资产静态编译检查（不渲染）：scene3d 规范/引用/光照/相机，GLB/glTF 缓冲与索引越界、节点环、动画/蒙皮、POSITION 包围盒一致性，OBJ 面索引，STL 退化面，贴图尺寸，manifest 一致性；支持目录批量体检。写文件/导入模型后与交付前必调用。',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: '工作区相对路径：文件（含 .3d/manifest.json）或目录（如 .3d）' },
                        content: { type: 'string', description: '写入前的文本内容预检（scene3d/gltf/obj）；提供时以 content 为准' },
                        format: { type: 'string', enum: ['scene3d', 'gltf', 'obj'], description: 'content 的格式；缺省按 path 推断，默认 scene3d' },
                        deep: { type: 'boolean', description: '是否做数据级校验（索引范围/顶点包围盒/法线/时间轴/哈希），默认 true' },
                        maxIssues: { type: 'number', description: '最多返回条数，默认 30' },
                    },
                    required: [],
                },
            },
            {
                name: 'list_3d_assets',
                description: '查询 .3d/manifest.json 资产清单，可按 kind/tag/关键字过滤；文件缺失会标注 missing。',
                parameters: {
                    type: 'object',
                    properties: {
                        kind: { type: 'string', enum: ['scene', 'model', 'texture'], description: '资产类型' },
                        tag: { type: 'string', description: '按标签精确过滤' },
                        query: { type: 'string', description: '在 id/name/description/path/tags 中模糊搜索' },
                        limit: { type: 'number', description: '最多返回条数，默认 50' },
                    },
                    required: [],
                },
            },
            {
                name: 'register_3d_asset',
                description: '登记/导入 3D 资产到 .3d（模型→models、贴图→textures、场景→scenes），计算哈希/三角面/包围盒并写入 manifest；同名不同内容自动加 -vNN。',
                parameters: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: '已有文件的工作区相对路径' },
                        name: { type: 'string', description: '资产名（生成 slug）；默认取文件名' },
                        description: { type: 'string', description: '一句话描述' },
                        tags: { type: 'array', items: { type: 'string' }, description: '检索标签，最多 10 个' },
                        copy: { type: 'boolean', description: '是否复制进 .3d 规范目录，默认 true；已在 .3d 内则原地登记' },
                    },
                    required: ['path'],
                },
            },
        ];
    }
}
