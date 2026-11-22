import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DuckDbProcessClient } from '@/duckdb/DuckDbProcessClient.js';
import { KnowledgeGraphService } from '@/services/KnowledgeGraphService.js';
import { KnowledgeGraphTools } from '@/tools/KnowledgeGraphTools.js';

let tempRoot: string;

beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kg-tools-test-'));
    await fs.mkdir(path.join(tempRoot, '.duckdb'), { recursive: true });
});

afterAll(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('knowledge graph tool surface', () => {
    it('exposes the full atomic tool set with valid schemas', () => {
        const definitions = KnowledgeGraphTools.getDefinitions();
        expect(definitions.map((def) => def.name)).toEqual([
            'kg_admin',
            'kg_query',
            'kg_upsert',
            'kg_delete',
            'kg_traverse',
            'kg_path',
            'kg_analyze',
            'kg_import',
            'kg_attr_define',
            'kg_attr_list',
            'kg_attr_delete',
            'kg_find',
            'kg_vocab',
            'kg_lint',
            'kg_merge',
        ]);
        const requiredByTool = new Map<string, string[]>(
            definitions.map((def) => [def.name, ((def.parameters as any).required as string[]) || []]),
        );
        for (const def of definitions) {
            expect(def.description.length, def.name).toBeLessThanOrEqual(160);
            expect((def.parameters as any).type).toBe('object');
            expect(typeof (def.parameters as any).properties).toBe('object');
        }
        expect(requiredByTool.get('kg_query')).toEqual(['sql']);
        expect(requiredByTool.get('kg_traverse')).toEqual(['startIds']);
        expect(requiredByTool.get('kg_path')).toEqual(['from', 'to']);
        expect(requiredByTool.get('kg_analyze')).toEqual(['algorithm']);
        expect(requiredByTool.get('kg_import')).toEqual(['target', 'path']);
    });

    it('refuses to touch the database file directly', async () => {
        const service = new KnowledgeGraphService(tempRoot);
        await expect(service.importData({ target: 'nodes', path: '.duckdb/kg.duckdb' }))
            .rejects.toMatchObject({ code: 'PATH_REJECTED' });
        await expect(service.importData({ target: 'nodes', path: '.duckdb/kg.duckdb.wal' }))
            .rejects.toMatchObject({ code: 'PATH_REJECTED' });
    });

    it('refuses paths outside the workspace', async () => {
        const service = new KnowledgeGraphService(tempRoot);
        await expect(service.importData({ target: 'nodes', path: '../outside.json' }))
            .rejects.toThrow(/SECURITY_VIOLATION|工作区/);
    });

    it('rejects an empty query before spawning a worker', async () => {
        const service = new KnowledgeGraphService(tempRoot);
        await expect(service.query({ sql: '   ' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        await expect(service.analyze({ algorithm: 'nope' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    });

    it('renders property objects and undeclared-key warnings without raw JSON text', async () => {        const responses: Record<string, any> = {
            path: {
                from: 'a', to: 'b', direction: 'out', maxDepth: 2, truncated: false, elapsedMs: 1,
                paths: [{ nodes: ['a', 'b'], edges: [{ src: 'a', dst: 'b', type: 'link' }], length: 1 }],
                nodes: [{ id: 'a', type: 'person', name: 'A', props: { risk: 'high' } }],
                edges: [{ src: 'a', dst: 'b', type: 'link', weight: 1, props: { amount: 20000 } }],
            },
            find: {
                scope: 'nodes', total: 1, limit: 50, truncated: false, usedIndex: false, elapsedMs: 1,
                undeclaredKeys: ['region'],
                items: [{ id: 'a', type: 'person', name: 'A', props: { region: 'east' } }],
            },
        };
        const fakeClient = {
            run: async (_root: string, op: string) => responses[op],
        };
        const spy = vi.spyOn(DuckDbProcessClient, 'getInstance')
            .mockReturnValue(fakeClient as unknown as DuckDbProcessClient);
        try {
            const service = new KnowledgeGraphService(tempRoot);
            const pathText = await service.path({ from: 'a', to: 'b' });
            expect(pathText).toContain('{"amount":20000}');
            expect(pathText).not.toContain('[object Object]');

            const findText = await service.find({ scope: 'nodes' });
            expect(findText).toContain('未声明属性 region');
            expect(findText).not.toContain('[object Object]');
        } finally {
            spy.mockRestore();
        }
    });

    it('keeps validate output compact unless verbose is requested', async () => {
        const checks = [
            { check: 'orphan_edges_src', value: 0, severity: 'error', hint: '边的 src 指向不存在的节点' },
            { check: 'node_attr_code_index_drift', value: 0, severity: 'error', hint: '属性索引行数 - 应有行数' },
            { check: 'self_loops', value: 2, severity: 'info', hint: '自环边数量（不一定是错误）' },
        ];
        const fakeClient = { run: async (_root: string, op: string) => (op === 'validate' ? { checks, issues: [] } : {}) };
        const spy = vi.spyOn(DuckDbProcessClient, 'getInstance')
            .mockReturnValue(fakeClient as unknown as DuckDbProcessClient);
        try {
            const service = new KnowledgeGraphService(tempRoot);
            const compact = await service.admin({ action: 'validate' });
            expect(compact).toContain('✅ 合规');
            expect(compact).toContain('self_loops');
            expect(compact).not.toContain('orphan_edges_src');
            expect(compact).toContain('verbose:true');

            const verbose = await service.admin({ action: 'validate', verbose: true });
            expect(verbose).toContain('orphan_edges_src');
            expect(verbose).toContain('node_attr_code_index_drift');
        } finally {
            spy.mockRestore();
        }
    });

    it('reports strict lint failures caused only by warnings', async () => {
        const fakeClient = {
            run: async (_root: string, op: string) => (op === 'lint' ? {
                ok: false,
                errorCount: 0,
                warningCount: 1,
                infoCount: 0,
                errorRows: 0,
                warningRows: 5,
                diagnostics: [{
                    severity: 'warning', code: 'identity_incomplete', count: 5,
                    message: '节点缺少完整身份键（code）', hint: '补齐身份属性',
                }],
                vocab: { classes: 2, properties: 1, identityKeys: ['code'] },
                elapsedMs: 3,
            } : {}),
        };
        const spy = vi.spyOn(DuckDbProcessClient, 'getInstance')
            .mockReturnValue(fakeClient as unknown as DuckDbProcessClient);
        try {
            const service = new KnowledgeGraphService(tempRoot);
            const text = await service.lint({ strict: true });
            expect(text).toContain('strict 未通过');
            expect(text).not.toContain('0 类 error / 0 行受影响');
        } finally {
            spy.mockRestore();
        }
    });

    it('does not claim an index rebuild when nothing changed', async () => {
        const fakeClient = {
            run: async (_root: string, op: string) => (op === 'attr_define' ? {
                scope: 'node', key: 'code', type: 'string', required: false,
                indexed: true, unique: false, identity: false, domain: null,
                enumValues: null, indexRows: 42, indexRebuilt: false, identityRows: 0, typeChanged: false,
            } : {}),
        };
        const spy = vi.spyOn(DuckDbProcessClient, 'getInstance')
            .mockReturnValue(fakeClient as unknown as DuckDbProcessClient);
        try {
            const service = new KnowledgeGraphService(tempRoot);
            const text = await service.attrDefine({ scope: 'node', key: 'code', type: 'string', indexed: true });
            expect(text).toContain('索引未变更（现有 42 行）');
            expect(text).not.toContain('已重建属性索引');
        } finally {
            spy.mockRestore();
        }
    });
});
