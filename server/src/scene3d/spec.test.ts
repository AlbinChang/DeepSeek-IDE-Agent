import { describe, expect, it } from 'vitest';
import {
    collectScene3dRefs,
    formatScene3dIssues,
    SCENE3D_SCHEMA,
    validateScene3dSpec,
} from './spec.js';

const minimalSpec = () => ({
    objects: [
        { type: 'box', size: [1, 1, 1], position: [0, 0.5, 0], material: { color: '#4f9cff', metalness: 0.2 } },
    ],
});

describe('scene3d 规范校验', () => {
    it('最小场景通过校验并补齐 schema', () => {
        const result = validateScene3dSpec(minimalSpec());

        expect(result.ok).toBe(true);
        expect(result.spec?.schema).toBe(SCENE3D_SCHEMA);
        expect(result.summary).toContain('objects=1');
        expect(result.warnings.some((issue) => issue.path === 'schema')).toBe(true);
    });

    it('拒绝未知对象类型并给出路径', () => {
        const result = validateScene3dSpec({ objects: [{ type: 'cube' }] });

        expect(result.ok).toBe(false);
        expect(result.errors[0].path).toBe('objects[0].type');
        expect(formatScene3dIssues(result)).toContain('objects[0].type');
    });

    it('校验数值范围、枚举与三元数组', () => {
        const result = validateScene3dSpec({
            objects: [
                { type: 'sphere', radius: -1 },
                { type: 'box', size: [1, 2] },
                { type: 'cylinder', radialSegments: 1024 },
                { type: 'plane', material: { side: 'both' } },
            ],
        });

        expect(result.ok).toBe(false);
        const paths = result.errors.map((issue) => issue.path);
        expect(paths).toContain('objects[0].radius');
        expect(paths).toContain('objects[1].size');
        expect(paths).toContain('objects[2].radialSegments');
        expect(paths).toContain('objects[3].material.side');
    });

    it('group 递归校验并拒绝空 children', () => {
        const ok = validateScene3dSpec({
            objects: [{ type: 'group', position: [0, 0, 0], children: [{ type: 'sphere' }] }],
        });
        const bad = validateScene3dSpec({ objects: [{ type: 'group', children: [] }] });

        expect(ok.ok).toBe(true);
        expect(bad.ok).toBe(false);
        expect(bad.errors.some((issue) => issue.path === 'objects[0].children')).toBe(true);
    });

    it('未知字段只告警不阻断', () => {
        const result = validateScene3dSpec({
            objects: [{ type: 'box', positin: [1, 2, 3] }],
        });

        expect(result.ok).toBe(true);
        expect(result.warnings.some((issue) => issue.path === 'objects[0].positin')).toBe(true);
    });

    it('收集模型与贴图引用', () => {
        const refs = collectScene3dRefs({
            objects: [
                { type: 'model', src: '../models/robot.glb' },
                {
                    type: 'group',
                    children: [{ type: 'plane', material: { map: '../textures/floor.png' } }],
                },
            ],
        });

        expect(refs).toEqual(['../models/robot.glb', '../textures/floor.png']);
    });

    it('拒绝超出对象上限的场景', () => {
        const objects = Array.from({ length: 401 }, () => ({ type: 'box' }));
        const result = validateScene3dSpec({ objects });

        expect(result.ok).toBe(false);
        expect(result.errors.some((issue) => issue.path === 'objects')).toBe(true);
    });

    it('缺少 objects 时直接判失败', () => {
        const result = validateScene3dSpec({ schema: SCENE3D_SCHEMA });

        expect(result.ok).toBe(false);
        expect(result.spec).toBeNull();
        expect(result.errors.some((issue) => issue.path === 'objects')).toBe(true);
    });
});
