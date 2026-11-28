/**
 * .3d 资产目录与 manifest 治理。
 *
 * 约定（与 3d-asset 技能、docs/3d-integration.md 保持一致）：
 *   .3d/scenes/     scene3d/v1 场景 JSON（文本、可 git diff）
 *   .3d/models/     glb / gltf / obj / stl 模型
 *   .3d/textures/   贴图
 *   .3d/renders/    预览 PNG（同名覆盖，保留最新）
 *   .3d/.temp/      临时产物（.gitignore 忽略）
 *   .3d/manifest.json 资产索引（唯一真值）
 */

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { PathUtils } from '@/utils/PathUtils.js';

export const SCENE3D_DIR = '.3d';
export const SCENE3D_MANIFEST_PATH = '.3d/manifest.json';
export const SCENE3D_ASSETS_SCHEMA = '3d-assets/v1';
export const SCENE3D_SCENES_DIR = '.3d/scenes';
export const SCENE3D_MODELS_DIR = '.3d/models';
export const SCENE3D_TEXTURES_DIR = '.3d/textures';
export const SCENE3D_RENDERS_DIR = '.3d/renders';
export const SCENE3D_TEMP_DIR = '.3d/.temp';

export type Scene3dAssetKind = 'scene' | 'model' | 'texture';

export interface Scene3dAssetRecord {
    id: string;
    name: string;
    kind: Scene3dAssetKind;
    /** 工作区相对路径（统一 / 分隔） */
    path: string;
    description?: string;
    tags?: string[];
    /** 最近一次预览 PNG 的工作区相对路径 */
    preview?: string;
    bytes?: number;
    hash?: string;
    meta?: Record<string, any>;
    createdAt: string;
    updatedAt: string;
}

export interface Scene3dManifest {
    schema: string;
    updatedAt: string;
    assets: Scene3dAssetRecord[];
}

export interface Scene3dAssetFilter {
    kind?: Scene3dAssetKind;
    tag?: string;
    query?: string;
    limit?: number;
}

const SCENE3D_README = [
    '# 3D 资产目录（.3d）',
    '',
    '本目录由 DeepSeek IDE Agent 的 3D 能力维护。目录结构与命名是约定，改名前请同步 manifest。',
    '',
    '## 目录',
    '',
    '| 目录 | 内容 |',
    '| --- | --- |',
    '| `scenes/` | `scene3d/v1` 声明式场景 JSON（文本，可 git diff） |',
    '| `models/` | `glb` / `gltf` / `obj` / `stl` 模型 |',
    '| `textures/` | 贴图（png/jpg/webp） |',
    '| `renders/` | 预览 PNG，同名覆盖保留最新 |',
    '| `.temp/` | 临时产物，已 gitignore，任务结束清理 |',
    '| `manifest.json` | 资产索引（唯一真值），由工具自动维护 |',
    '',
    '## 命名',
    '',
    '- 文件与 id 统一小写 kebab：`product-console.scene3d.json`、`robot-arm.glb`。',
    '- 同一资产固定同一 slug：`scenes/robot-arm.scene3d.json` ↔ `renders/robot-arm.png`。',
    '- 版本用 `-v02` 后缀，不建 `final/ final2/ new/` 之类的平行目录。',
    '',
    '## 工具',
    '',
    '- `create_3d_scene`：写场景 + 建档 +（可选）渲染预览。',
    '- `check_3d_asset`：静态编译检查（规范/引用/缓冲/索引/节点环/动画/贴图/manifest），支持目录体检。',
    '- `render_3d_preview`：场景/模型 → PNG，返回三角面、包围盒、像素覆盖率。',
    '- `inspect_3d_asset`：导入模型后先看结构（节点/三角面/材质/动画/包围盒）。',
    '- `list_3d_assets` / `register_3d_asset`：查询与登记 manifest。',
    '',
    '## 规则',
    '',
    '1. 二进制模型不进 `scenes/`；场景引用模型用相对路径（`../models/robot-arm.glb`）。',
    '2. 中间产物放 `.temp/<run>/`，交付前删除；`renders/` 只保留最终预览。',
    '3. 大模型（>10 万三角面）先减面或做 LOD；导出关闭 Draco / Meshopt / BasisU 压缩。',
    '4. 从 Blender 导出选 glTF 2.0 + `+Y Up`，应用变换（Apply Transform），贴图打包进 GLB。',
    '5. 提交前确认 `manifest.json` 无 `missing` 记录。',
    '',
].join('\n');

const SCENE3D_GITIGNORE = ['.temp/', ''].join('\n');

export function toAssetSlug(input: string, fallbackPrefix = 'asset'): string {
    const normalized = String(input ?? '')
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    if (normalized) return normalized;
    const hash = crypto.createHash('sha1').update(String(input ?? '')).digest('hex').slice(0, 6);
    return `${fallbackPrefix}-${hash}`;
}

export function isNonAsciiName(name: string): boolean {
    return /[^\x00-\x7F]/.test(String(name ?? ''));
}

export function normalizeAssetPath(relPath: string): string {
    return String(relPath ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

export function classifyScene3dKind(relPath: string): Scene3dAssetKind {
    const lower = normalizeAssetPath(relPath).toLowerCase();
    if (lower.endsWith('.scene3d.json')) return 'scene';
    if (['.glb', '.gltf', '.obj', '.stl'].some((ext) => lower.endsWith(ext))) return 'model';
    return 'texture';
}

export function assetIdFromPath(relPath: string): string {
    const normalized = normalizeAssetPath(relPath);
    const fileName = normalized.split('/').pop() || normalized;
    return toAssetSlug(fileName.replace(/\.(scene3d\.json|glb|gltf|obj|stl|png|jpe?g|webp|ktx2)$/i, ''));
}

export function isInsideScene3dDir(relPath: string): boolean {
    const normalized = normalizeAssetPath(relPath);
    return normalized === SCENE3D_DIR || normalized.startsWith(`${SCENE3D_DIR}/`);
}

/** 幂等创建 .3d 目录骨架；返回本次新建的条目（用于报告） */
export async function ensureScene3dScaffold(workspaceRoot: string): Promise<string[]> {
    const created: string[] = [];
    const dirs = [
        SCENE3D_DIR,
        SCENE3D_SCENES_DIR,
        SCENE3D_MODELS_DIR,
        SCENE3D_TEXTURES_DIR,
        SCENE3D_RENDERS_DIR,
        SCENE3D_TEMP_DIR,
    ];
    for (const dir of dirs) {
        const absolute = PathUtils.resolveWritePath(dir, workspaceRoot);
        try {
            await fs.access(absolute);
        } catch {
            await fs.mkdir(absolute, { recursive: true });
            created.push(dir);
        }
    }

    const files: Array<[string, string]> = [
        [`${SCENE3D_DIR}/README.md`, SCENE3D_README],
        [`${SCENE3D_DIR}/.gitignore`, SCENE3D_GITIGNORE],
    ];
    for (const [relPath, content] of files) {
        const absolute = PathUtils.resolveWritePath(relPath, workspaceRoot);
        try {
            await fs.access(absolute);
        } catch {
            await fs.writeFile(absolute, content, 'utf8');
            created.push(relPath);
        }
    }

    const manifestPath = PathUtils.resolveWritePath(SCENE3D_MANIFEST_PATH, workspaceRoot);
    try {
        await fs.access(manifestPath);
    } catch {
        await writeScene3dManifest(workspaceRoot, {
            schema: SCENE3D_ASSETS_SCHEMA,
            updatedAt: new Date().toISOString(),
            assets: [],
        });
        created.push(SCENE3D_MANIFEST_PATH);
    }
    return created;
}

export async function readScene3dManifest(workspaceRoot: string): Promise<Scene3dManifest> {
    const manifestPath = PathUtils.resolveWritePath(SCENE3D_MANIFEST_PATH, workspaceRoot);
    try {
        const raw = await fs.readFile(manifestPath, 'utf8');
        const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
        return {
            schema: typeof parsed?.schema === 'string' ? parsed.schema : SCENE3D_ASSETS_SCHEMA,
            updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
            assets: Array.isArray(parsed?.assets) ? parsed.assets.filter((entry: any) => entry && typeof entry.path === 'string') : [],
        };
    } catch {
        return { schema: SCENE3D_ASSETS_SCHEMA, updatedAt: new Date().toISOString(), assets: [] };
    }
}

export async function writeScene3dManifest(workspaceRoot: string, manifest: Scene3dManifest): Promise<void> {
    const manifestPath = PathUtils.resolveWritePath(SCENE3D_MANIFEST_PATH, workspaceRoot);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    const payload: Scene3dManifest = {
        schema: manifest.schema || SCENE3D_ASSETS_SCHEMA,
        updatedAt: new Date().toISOString(),
        assets: [...manifest.assets].sort((left, right) => left.path.localeCompare(right.path)),
    };
    const tempPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(tempPath, manifestPath);
}

export async function upsertScene3dAsset(
    workspaceRoot: string,
    record: Omit<Scene3dAssetRecord, 'createdAt' | 'updatedAt'> & Partial<Pick<Scene3dAssetRecord, 'createdAt'>>,
): Promise<Scene3dAssetRecord> {
    await ensureScene3dScaffold(workspaceRoot);
    const manifest = await readScene3dManifest(workspaceRoot);
    const targetPath = normalizeAssetPath(record.path);
    const existingIndex = manifest.assets.findIndex(
        (entry) => normalizeAssetPath(entry.path) === targetPath || entry.id === record.id,
    );
    const now = new Date().toISOString();
    const existing = existingIndex >= 0 ? manifest.assets[existingIndex] : null;
    // 字段级合并：刷新预览/元数据时不丢描述、标签与创建时间
    const next: Scene3dAssetRecord = {
        id: record.id,
        name: record.name || existing?.name || record.id,
        kind: record.kind,
        path: targetPath,
        description: record.description ?? existing?.description,
        tags: record.tags ?? existing?.tags,
        preview: record.preview ?? existing?.preview,
        bytes: record.bytes ?? existing?.bytes,
        hash: record.hash ?? existing?.hash,
        meta: record.meta ? { ...(existing?.meta ?? {}), ...record.meta } : existing?.meta,
        createdAt: existing?.createdAt || record.createdAt || now,
        updatedAt: now,
    };
    if (existingIndex >= 0) manifest.assets[existingIndex] = next;
    else manifest.assets.push(next);
    await writeScene3dManifest(workspaceRoot, manifest);
    return next;
}

export async function removeScene3dAsset(workspaceRoot: string, idOrPath: string): Promise<boolean> {
    const manifest = await readScene3dManifest(workspaceRoot);
    const target = normalizeAssetPath(idOrPath);
    const before = manifest.assets.length;
    manifest.assets = manifest.assets.filter((entry) => entry.id !== idOrPath && normalizeAssetPath(entry.path) !== target);
    if (manifest.assets.length === before) return false;
    await writeScene3dManifest(workspaceRoot, manifest);
    return true;
}

export async function listScene3dAssets(
    workspaceRoot: string,
    filter: Scene3dAssetFilter = {},
): Promise<{ assets: Array<Scene3dAssetRecord & { missing: boolean }>; total: number }> {
    const manifest = await readScene3dManifest(workspaceRoot);
    const query = String(filter.query ?? '').trim().toLowerCase();
    const tag = String(filter.tag ?? '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, Math.round(filter.limit ?? 50)));

    const matched = manifest.assets.filter((entry) => {
        if (filter.kind && entry.kind !== filter.kind) return false;
        if (tag && !(entry.tags ?? []).some((value) => String(value).toLowerCase() === tag)) return false;
        if (query) {
            const haystack = `${entry.id} ${entry.name} ${entry.description ?? ''} ${entry.path} ${(entry.tags ?? []).join(' ')}`.toLowerCase();
            if (!haystack.includes(query)) return false;
        }
        return true;
    });

    const assets = [] as Array<Scene3dAssetRecord & { missing: boolean }>;
    for (const entry of matched.slice(0, limit)) {
        let missing = false;
        try {
            const absolute = PathUtils.resolveWritePath(entry.path, workspaceRoot);
            const stat = await fs.stat(absolute);
            missing = !stat.isFile();
        } catch {
            missing = true;
        }
        assets.push({ ...entry, missing });
    }
    return { assets, total: matched.length };
}

export async function hashFile(absolutePath: string): Promise<string> {
    const buffer = await fs.readFile(absolutePath);
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function formatScene3dManifestEntry(entry: Scene3dAssetRecord & { missing?: boolean }): string {
    const parts = [`${entry.kind}/${entry.id}`, entry.path];
    if (entry.bytes !== undefined) parts.push(`${(entry.bytes / 1024).toFixed(1)}KB`);
    if (entry.preview) parts.push(`preview=${entry.preview}`);
    if (entry.tags?.length) parts.push(`tags=${entry.tags.join(',')}`);
    if (entry.missing) parts.push('missing');
    if (entry.description) parts.push(`— ${entry.description}`);
    return parts.join(' | ');
}
