/**
 * scene3d/v1 场景规范的校验与归一化。
 *
 * 客户端（client/src/three/scene-runtime.ts）负责渲染，本模块负责在写入磁盘前
 * 拦住大模型最容易犯的参数错误：类型写错、枚举拼错、数值越界、引用缺失。
 * 校验输出带路径（objects[2].rotation[0]）与修复建议，便于模型一次改对。
 */

export const SCENE3D_SCHEMA = 'scene3d/v1';
export const SCENE3D_MAX_OBJECTS = 400;
export const SCENE3D_MAX_LIGHTS = 16;
export const SCENE3D_MAX_DEPTH = 8;
export const SCENE3D_MAX_SPEC_BYTES = 256 * 1024;

export const SCENE3D_OBJECT_TYPES = [
    'box', 'sphere', 'cylinder', 'cone', 'torus', 'torusKnot',
    'plane', 'ring', 'capsule', 'model', 'group',
] as const;

export const SCENE3D_LIGHT_TYPES = ['ambient', 'directional', 'point', 'spot'] as const;

export type Scene3dVec3 = [number, number, number];

export interface Scene3dIssue {
    severity: 'error' | 'warning';
    path: string;
    message: string;
    fix?: string;
}

export interface Scene3dValidation {
    ok: boolean;
    spec: Record<string, any> | null;
    errors: Scene3dIssue[];
    warnings: Scene3dIssue[];
    summary: string;
    estimatedTriangles: number;
}

const OBJECT_KEYS = new Set([
    'type', 'name', 'position', 'rotation', 'scale', 'material', 'castShadow', 'receiveShadow',
    'size', 'radius', 'radiusTop', 'radiusBottom', 'height', 'width', 'innerRadius', 'outerRadius',
    'tube', 'length', 'arc', 'p', 'q', 'widthSegments', 'heightSegments', 'radialSegments',
    'tubularSegments', 'thetaSegments', 'capSegments', 'openEnded', 'src', 'children',
]);

const MATERIAL_KEYS = new Set([
    'color', 'metalness', 'roughness', 'emissive', 'emissiveIntensity', 'opacity',
    'transparent', 'wireframe', 'flatShading', 'side', 'map',
]);

const LIGHT_KEYS = new Set([
    'type', 'color', 'intensity', 'position', 'target', 'castShadow', 'distance', 'angle', 'penumbra',
]);

const TOP_LEVEL_KEYS = new Set([
    'schema', 'name', 'description', 'background', 'camera', 'render', 'lights', 'objects',
]);

const POSITIVE_FIELDS = ['radius', 'radiusTop', 'radiusBottom', 'height', 'width', 'innerRadius', 'outerRadius', 'tube', 'length'];
const INTEGER_FIELDS = ['widthSegments', 'heightSegments', 'radialSegments', 'tubularSegments', 'thetaSegments', 'capSegments'];

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isVec3(value: unknown): value is Scene3dVec3 {
    return Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);
}

function pushIssue(list: Scene3dIssue[], severity: 'error' | 'warning', path: string, message: string, fix?: string) {
    list.push({ severity, path, message, fix });
}

function checkNumber(
    errors: Scene3dIssue[],
    path: string,
    value: unknown,
    options: { min?: number; max?: number; integer?: boolean; optional?: boolean } = {},
) {
    if (value === undefined) {
        if (!options.optional) pushIssue(errors, 'error', path, '缺少必填数值');
        return;
    }
    if (!isFiniteNumber(value)) {
        pushIssue(errors, 'error', path, `应为有限数值，实际为 ${JSON.stringify(value)}`);
        return;
    }
    if (options.integer && !Number.isInteger(value)) pushIssue(errors, 'error', path, '应为整数');
    if (options.min !== undefined && value < options.min) pushIssue(errors, 'error', path, `不能小于 ${options.min}`);
    if (options.max !== undefined && value > options.max) pushIssue(errors, 'error', path, `不能大于 ${options.max}`);
}

function checkVec3(errors: Scene3dIssue[], path: string, value: unknown, max = 10_000) {
    if (!isVec3(value)) {
        pushIssue(errors, 'error', path, '应为 [x, y, z] 三元数值数组');
        return;
    }
    value.forEach((entry, index) => {
        if (Math.abs(entry) > max) pushIssue(errors, 'error', `${path}[${index}]`, `绝对值不能超过 ${max}`);
    });
}

function checkColor(errors: Scene3dIssue[], path: string, value: unknown) {
    if (value === undefined) return;
    if (typeof value !== 'string' || !/^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)$/.test(value.trim())) {
        pushIssue(errors, 'error', path, '颜色应为 #rrggbb / #rgb 或标准色名', '如 "#4f9cff"');
    }
}

function checkString(errors: Scene3dIssue[], path: string, value: unknown, max = 1024) {
    if (typeof value !== 'string' || !value.trim()) {
        pushIssue(errors, 'error', path, '应为非空字符串');
        return;
    }
    if (value.length > max) pushIssue(errors, 'error', path, `长度不能超过 ${max} 字符`);
}

export function estimateObjectTriangles(object: Record<string, any>): number {
    const n = (value: unknown, fallback: number) => (isFiniteNumber(value) ? value : fallback);
    switch (object.type) {
        case 'box': return 12;
        case 'sphere': return Math.round(n(object.widthSegments, 32) * n(object.heightSegments, 24) * 2);
        case 'cylinder': return Math.round(n(object.radialSegments, 32) * 4);
        case 'cone': return Math.round(n(object.radialSegments, 32) * 2);
        case 'torus': return Math.round(n(object.radialSegments, 16) * n(object.tubularSegments, 64) * 2);
        case 'torusKnot': return Math.round(n(object.tubularSegments, 128) * n(object.radialSegments, 16) * 2);
        case 'plane': return Math.max(2, Math.round(n(object.widthSegments, 1) * n(object.heightSegments, 1) * 2));
        case 'ring': return Math.round(n(object.thetaSegments, 48) * 2);
        case 'capsule': return Math.round(n(object.radialSegments, 20) * (n(object.capSegments, 8) * 2 + 1) * 2);
        case 'group': return (Array.isArray(object.children) ? object.children : [])
            .reduce((sum: number, child: any) => sum + (isRecord(child) ? estimateObjectTriangles(child) : 0), 0);
        default: return 0;
    }
}

function validateMaterial(errors: Scene3dIssue[], warnings: Scene3dIssue[], path: string, material: unknown) {
    if (material === undefined) return;
    if (!isRecord(material)) {
        pushIssue(errors, 'error', path, 'material 应为对象');
        return;
    }
    for (const key of Object.keys(material)) {
        if (!MATERIAL_KEYS.has(key)) pushIssue(warnings, 'warning', `${path}.${key}`, '未知字段（渲染时会被忽略）');
    }
    checkColor(errors, `${path}.color`, material.color);
    checkColor(errors, `${path}.emissive`, material.emissive);
    checkNumber(errors, `${path}.metalness`, material.metalness, { min: 0, max: 1, optional: true });
    checkNumber(errors, `${path}.roughness`, material.roughness, { min: 0, max: 1, optional: true });
    checkNumber(errors, `${path}.emissiveIntensity`, material.emissiveIntensity, { min: 0, max: 10, optional: true });
    checkNumber(errors, `${path}.opacity`, material.opacity, { min: 0, max: 1, optional: true });
    if (material.side !== undefined && !['front', 'back', 'double'].includes(material.side)) {
        pushIssue(errors, 'error', `${path}.side`, '应为 front | back | double');
    }
    if (material.map !== undefined) checkString(errors, `${path}.map`, material.map);
}

function validateObject(
    errors: Scene3dIssue[],
    warnings: Scene3dIssue[],
    path: string,
    object: unknown,
    depth: number,
    stats: { objects: number; models: number; groups: number },
): number {
    if (!isRecord(object)) {
        pushIssue(errors, 'error', path, '应为对象');
        return 0;
    }
    if (depth > SCENE3D_MAX_DEPTH) {
        pushIssue(errors, 'error', path, `嵌套层级超过 ${SCENE3D_MAX_DEPTH}`);
        return 0;
    }
    stats.objects += 1;

    const type = object.type;
    if (typeof type !== 'string' || !(SCENE3D_OBJECT_TYPES as readonly string[]).includes(type)) {
        pushIssue(errors, 'error', `${path}.type`, `应为 ${SCENE3D_OBJECT_TYPES.join(' | ')} 之一`, `当前值 ${JSON.stringify(type)}`);
        return 0;
    }

    for (const key of Object.keys(object)) {
        if (!OBJECT_KEYS.has(key)) pushIssue(warnings, 'warning', `${path}.${key}`, '未知字段（渲染时会被忽略）');
    }

    if (object.position !== undefined) checkVec3(errors, `${path}.position`, object.position);
    if (object.rotation !== undefined) checkVec3(errors, `${path}.rotation`, object.rotation, 36_000);
    if (object.scale !== undefined) {
        if (isFiniteNumber(object.scale)) {
            if (object.scale <= 0) pushIssue(errors, 'error', `${path}.scale`, '必须大于 0');
        } else if (isVec3(object.scale)) {
            if (object.scale.some((value) => value <= 0)) pushIssue(errors, 'error', `${path}.scale`, '分量必须大于 0');
        } else {
            pushIssue(errors, 'error', `${path}.scale`, '应为数值或 [x, y, z] 三元数组');
        }
    }
    validateMaterial(errors, warnings, `${path}.material`, object.material);

    if (type === 'model') {
        stats.models += 1;
        checkString(errors, `${path}.src`, object.src);
    }
    if (type === 'group') {
        stats.groups += 1;
        if (!Array.isArray(object.children) || object.children.length === 0) {
            pushIssue(errors, 'error', `${path}.children`, 'group 需要非空 children 数组');
            return 0;
        }
        for (let index = 0; index < object.children.length; index += 1) {
            validateObject(errors, warnings, `${path}.children[${index}]`, object.children[index], depth + 1, stats);
        }
    }
    if (type === 'box' && object.size !== undefined && !isFiniteNumber(object.size) && !isVec3(object.size)) {
        pushIssue(errors, 'error', `${path}.size`, '应为数值或 [x, y, z] 三元数组');
    }
    for (const field of POSITIVE_FIELDS) {
        if (object[field] !== undefined) checkNumber(errors, `${path}.${field}`, object[field], { min: 0 });
    }
    for (const field of INTEGER_FIELDS) {
        if (object[field] !== undefined) checkNumber(errors, `${path}.${field}`, object[field], { min: 1, max: 256, integer: true });
    }
    return estimateObjectTriangles(object);
}

function validateLight(errors: Scene3dIssue[], warnings: Scene3dIssue[], path: string, light: unknown) {
    if (!isRecord(light)) {
        pushIssue(errors, 'error', path, '应为对象');
        return;
    }
    if (!(SCENE3D_LIGHT_TYPES as readonly string[]).includes(String(light.type))) {
        pushIssue(errors, 'error', `${path}.type`, `应为 ${SCENE3D_LIGHT_TYPES.join(' | ')} 之一`);
    }
    for (const key of Object.keys(light)) {
        if (!LIGHT_KEYS.has(key)) pushIssue(warnings, 'warning', `${path}.${key}`, '未知字段（渲染时会被忽略）');
    }
    checkColor(errors, `${path}.color`, light.color);
    checkNumber(errors, `${path}.intensity`, light.intensity, { min: 0, max: 100, optional: true });
    if (light.position !== undefined) checkVec3(errors, `${path}.position`, light.position);
    if (light.target !== undefined) checkVec3(errors, `${path}.target`, light.target);
    if (light.angle !== undefined) checkNumber(errors, `${path}.angle`, light.angle, { min: 1, max: 89, optional: true });
    if (light.penumbra !== undefined) checkNumber(errors, `${path}.penumbra`, light.penumbra, { min: 0, max: 1, optional: true });
}

/** 深度遍历收集场景引用的相对资源（模型 / 贴图），用于存在性检查与无头端 URL 映射 */
export function collectScene3dRefs(spec: Record<string, any>): string[] {
    const refs = new Set<string>();
    const walk = (object: any) => {
        if (!isRecord(object)) return;
        if (object.type === 'model' && typeof object.src === 'string' && object.src.trim()) refs.add(object.src.trim());
        if (isRecord(object.material) && typeof object.material.map === 'string' && object.material.map.trim()) {
            refs.add(object.material.map.trim());
        }
        if (Array.isArray(object.children)) object.children.forEach(walk);
    };
    for (const object of Array.isArray(spec?.objects) ? spec.objects : []) walk(object);
    return Array.from(refs);
}

export function validateScene3dSpec(input: unknown): Scene3dValidation {
    const errors: Scene3dIssue[] = [];
    const warnings: Scene3dIssue[] = [];

    if (!isRecord(input)) {
        return {
            ok: false,
            spec: null,
            errors: [{ severity: 'error', path: '(root)', message: '场景规范应为 JSON 对象' }],
            warnings,
            summary: 'invalid',
            estimatedTriangles: 0,
        };
    }

    const spec = JSON.parse(JSON.stringify(input)) as Record<string, any>;
    for (const key of Object.keys(spec)) {
        if (!TOP_LEVEL_KEYS.has(key)) pushIssue(warnings, 'warning', key, '未知顶层字段（渲染时会被忽略）');
    }

    if (spec.schema === undefined) {
        spec.schema = SCENE3D_SCHEMA;
        pushIssue(warnings, 'warning', 'schema', `缺少 schema，已补为 "${SCENE3D_SCHEMA}"`);
    } else if (spec.schema !== SCENE3D_SCHEMA) {
        pushIssue(errors, 'error', 'schema', `应为 "${SCENE3D_SCHEMA}"`, `当前值 ${JSON.stringify(spec.schema)}`);
    }

    if (spec.name !== undefined && typeof spec.name !== 'string') pushIssue(errors, 'error', 'name', '应为字符串');
    if (spec.description !== undefined && typeof spec.description !== 'string') pushIssue(errors, 'error', 'description', '应为字符串');
    checkColor(errors, 'background', spec.background);

    if (spec.camera !== undefined) {
        if (!isRecord(spec.camera)) {
            pushIssue(errors, 'error', 'camera', '应为对象');
        } else {
            if (spec.camera.position !== undefined) checkVec3(errors, 'camera.position', spec.camera.position);
            if (spec.camera.target !== undefined) checkVec3(errors, 'camera.target', spec.camera.target);
            if (spec.camera.fov !== undefined) checkNumber(errors, 'camera.fov', spec.camera.fov, { min: 5, max: 120, optional: true });
        }
    }

    if (spec.render !== undefined) {
        if (!isRecord(spec.render)) {
            pushIssue(errors, 'error', 'render', '应为对象');
        } else if (spec.render.environment !== undefined && !['studio', 'none'].includes(spec.render.environment)) {
            pushIssue(errors, 'error', 'render.environment', '应为 studio | none');
        }
    }

    if (spec.lights !== undefined) {
        if (!Array.isArray(spec.lights)) {
            pushIssue(errors, 'error', 'lights', '应为数组');
        } else {
            if (spec.lights.length > SCENE3D_MAX_LIGHTS) {
                pushIssue(errors, 'error', 'lights', `最多 ${SCENE3D_MAX_LIGHTS} 盏灯`);
            }
            spec.lights.forEach((light: unknown, index: number) => validateLight(errors, warnings, `lights[${index}]`, light));
        }
    }

    if (!Array.isArray(spec.objects) || spec.objects.length === 0) {
        pushIssue(errors, 'error', 'objects', '需要非空 objects 数组', '至少放一个基础几何体或 model');
        return {
            ok: false,
            spec: null,
            errors,
            warnings,
            summary: 'invalid',
            estimatedTriangles: 0,
        };
    }
    if (spec.objects.length > SCENE3D_MAX_OBJECTS) {
        pushIssue(errors, 'error', 'objects', `顶层对象数不能超过 ${SCENE3D_MAX_OBJECTS}`);
    }

    const stats = { objects: 0, models: 0, groups: 0 };
    let estimatedTriangles = 0;
    spec.objects.forEach((object: unknown, index: number) => {
        estimatedTriangles += validateObject(errors, warnings, `objects[${index}]`, object, 1, stats);
    });

    if (estimatedTriangles > 500_000) {
        pushIssue(warnings, 'warning', 'objects', `预估三角面 ${estimatedTriangles} 偏高，Web 端可能掉帧`, '降低分段数或改用模型');
    }

    const serializedBytes = Buffer.byteLength(JSON.stringify(spec), 'utf8');
    if (serializedBytes > SCENE3D_MAX_SPEC_BYTES) {
        pushIssue(errors, 'error', '(root)', `场景 JSON 超过 ${Math.round(SCENE3D_MAX_SPEC_BYTES / 1024)}KB 上限`);
    }

    const summary = [
        `objects=${stats.objects}`,
        `models=${stats.models}`,
        `groups=${stats.groups}`,
        `lights=${Array.isArray(spec.lights) ? spec.lights.length : 0}`,
        `estTris≈${estimatedTriangles}`,
    ].join(' ');

    return {
        ok: errors.length === 0,
        spec: errors.length === 0 ? spec : null,
        errors,
        warnings,
        summary,
        estimatedTriangles,
    };
}

export function formatScene3dIssues(validation: Scene3dValidation, limit = 12): string {
    const lines: string[] = [];
    const issues = [...validation.errors, ...validation.warnings].slice(0, limit);
    for (const issue of issues) {
        const prefix = issue.severity === 'error' ? '✗' : '⚠';
        lines.push(`${prefix} ${issue.path}: ${issue.message}${issue.fix ? `（${issue.fix}）` : ''}`);
    }
    const hidden = validation.errors.length + validation.warnings.length - issues.length;
    if (hidden > 0) lines.push(`…另有 ${hidden} 条未显示`);
    return lines.join('\n');
}
