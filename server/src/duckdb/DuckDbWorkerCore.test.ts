import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DuckDbWorkerCore } from '@/duckdb/DuckDbWorkerCore.js';

let tempRoot: string;
let workspaceRoot: string;
let core: DuckDbWorkerCore;

beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kg-core-test-'));
    workspaceRoot = path.join(tempRoot, 'workspace');
    await fs.mkdir(path.join(workspaceRoot, '.duckdb'), { recursive: true });
    core = new DuckDbWorkerCore();
    await core.open({
        dbPath: path.join(workspaceRoot, '.duckdb', 'kg.duckdb'),
        workspaceRoot,
        tempDir: path.join(workspaceRoot, '.duckdb', 'tmp'),
        memoryLimitMb: 512,
        threads: 2,
    });
});

afterAll(async () => {
    await core.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('DuckDbWorkerCore', () => {
    it('bootstraps schema and performs idempotent upserts', async () => {
        const first = await core.upsert({
            nodes: [
                { id: 'alice', type: 'person', name: 'Alice' },
                { id: 'bob', type: 'person', name: 'Bob' },
                { id: 'acme', type: 'company', name: 'Acme' },
                { id: 'carol', type: 'person', name: 'Carol' },
            ],
            edges: [
                { src: 'alice', dst: 'bob', type: 'knows', weight: 2 },
                { src: 'bob', dst: 'acme', type: 'works_at' },
                { src: 'carol', dst: 'acme', type: 'works_at' },
            ],
        }) as any;
        expect(Number(first.changedNodes)).toBe(4);
        expect(Number(first.changedEdges)).toBe(3);

        const second = await core.upsert({
            nodes: [{ id: 'alice', type: 'person', name: 'Alice A.' }],
            edges: [{ src: 'alice', dst: 'bob', type: 'knows', weight: 5 }],
        }) as any;
        expect(Number(second.changedNodes)).toBe(1);

        const result = await core.query({
            sql: 'SELECT id, name FROM kg_nodes WHERE id = ?',
            params: ['alice'],
        }) as any;
        expect(result.rows).toEqual([{ id: 'alice', name: 'Alice A.' }]);

        const stats = await core.stats() as any;
        expect(Number(stats.nodes)).toBe(4);
        expect(Number(stats.edges)).toBe(3);
        expect(String(stats.duckdbVersion)).toMatch(/^v?\d+\./);
    });

    it('rejects write SQL sent through the read-only query path', async () => {
        await expect(core.query({ sql: 'DELETE FROM kg_nodes' })).rejects.toThrow(/只读/);
        await expect(core.query({ sql: "SELECT * FROM read_csv_auto('x.csv')" })).rejects.toThrow(/文件/);
    });

    it('traverses out / in / both with type filters', async () => {
        const out = await core.traverse({
            startIds: ['alice'], depth: 2, direction: 'out', maxNodes: 50, maxEdges: 50,
        }) as any;
        expect(out.nodes.map((node: any) => node.id).sort()).toEqual(['acme', 'alice', 'bob']);
        expect(out.edges.some((edge: any) => edge.type === 'works_at')).toBe(true);

        const inbound = await core.traverse({
            startIds: ['acme'], depth: 1, direction: 'in', maxNodes: 50, maxEdges: 50,
        }) as any;
        expect(inbound.nodes.map((node: any) => node.id).sort()).toEqual(['acme', 'bob', 'carol']);

        const filtered = await core.traverse({
            startIds: ['alice'], depth: 3, direction: 'both', edgeTypes: ['knows', 'works_at'], maxNodes: 50, maxEdges: 50,
        }) as any;
        expect(filtered.nodes.map((node: any) => node.id).sort()).toEqual(['acme', 'alice', 'bob', 'carol']);

        const knowsOnly = await core.traverse({
            startIds: ['alice'], depth: 3, direction: 'out', edgeTypes: ['works_at'], maxNodes: 50, maxEdges: 50,
        }) as any;
        expect(knowsOnly.nodes.map((node: any) => node.id)).toEqual(['alice']);

        const typed = await core.traverse({
            startIds: ['alice'], depth: 2, direction: 'out', nodeTypes: ['company'], maxNodes: 50, maxEdges: 50,
        }) as any;
        expect(typed.nodes.map((node: any) => node.id)).toEqual(['acme']);
        expect(typed.walkNodes).toBe(3);
    });

    it('finds shortest paths', async () => {
        const result = await core.findPaths({
            from: 'alice', to: 'acme', maxDepth: 4, direction: 'out', maxPaths: 3,
        }) as any;
        expect(result.paths[0].nodes).toEqual(['alice', 'bob', 'acme']);
        expect(result.paths[0].length).toBe(2);
        expect(result.nodes).toHaveLength(3);

        const none = await core.findPaths({
            from: 'acme', to: 'alice', maxDepth: 2, direction: 'out',
        }) as any;
        expect(none.paths).toEqual([]);

        // 参数顺序回归：edgeTypes 出现在 maxDepth 之后、to 之前。
        const mixed = await core.findPaths({
            from: 'bob', to: 'carol', maxDepth: 3, direction: 'both', edgeTypes: ['works_at'],
        }) as any;
        expect(mixed.paths[0].nodes).toEqual(['bob', 'acme', 'carol']);

        const inbound = await core.findPaths({
            from: 'acme', to: 'bob', maxDepth: 3, direction: 'in', edgeTypes: ['works_at'],
        }) as any;
        expect(inbound.paths[0].nodes).toEqual(['acme', 'bob']);
    });

    it('supports 10-hop traversal and bounded BFS path search', async () => {
        // 独立库，避免影响其它用例的规模假设。
        const chainDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kg-chain-'));
        const chainRoot = path.join(chainDir, 'workspace');
        await fs.mkdir(path.join(chainRoot, '.duckdb'), { recursive: true });
        const chainCore = new DuckDbWorkerCore();
        await chainCore.open({
            dbPath: path.join(chainRoot, '.duckdb', 'kg.duckdb'),
            workspaceRoot: chainRoot,
            tempDir: path.join(chainRoot, '.duckdb', 'tmp'),
            memoryLimitMb: 256,
            threads: 1,
        });
        try {
            const chainNodes = Array.from({ length: 31 }, (_, index) => ({ id: `c${index}`, type: 'chain' }));
            const chainEdges = Array.from({ length: 30 }, (_, index) => ({
                src: `c${index}`, dst: `c${index + 1}`, type: 'next',
            }));
            await chainCore.upsert({ nodes: chainNodes, edges: chainEdges });

            const walk = await chainCore.traverse({
                startIds: ['c0'], depth: 10, direction: 'both', maxNodes: 100, maxEdges: 100,
            }) as any;
            expect(walk.nodes.map((node: any) => node.id)).toEqual(
                Array.from({ length: 11 }, (_, index) => `c${index}`),
            );

            const path = await chainCore.findPaths({
                from: 'c0', to: 'c10', maxDepth: 10, direction: 'out',
            }) as any;
            expect(path.paths[0].length).toBe(10);
            expect(path.paths[0].nodes).toHaveLength(11);

            const tooFar = await chainCore.findPaths({
                from: 'c0', to: 'c30', maxDepth: 10, direction: 'out',
            }) as any;
            expect(tooFar.paths).toEqual([]);

            await chainCore.upsert({
                nodes: [{ id: 'd1', type: 'x' }, { id: 'd2', type: 'x' }, { id: 'd3', type: 'x' }, { id: 'd4', type: 'x' }],
                edges: [
                    { src: 'd1', dst: 'd2', type: 'e' },
                    { src: 'd1', dst: 'd3', type: 'e' },
                    { src: 'd2', dst: 'd4', type: 'e' },
                    { src: 'd3', dst: 'd4', type: 'e' },
                ],
            });
            const multi = await chainCore.findPaths({
                from: 'd1', to: 'd4', maxDepth: 5, direction: 'out', maxPaths: 5,
            }) as any;
            expect(multi.paths).toHaveLength(2);
            expect(multi.paths.every((item: any) => item.length === 2)).toBe(true);
        } finally {
            await chainCore.close();
            await fs.rm(chainDir, { recursive: true, force: true });
        }
    });

    it('computes degree, pagerank, components and communities', async () => {
        const degree = await core.analyze({ algorithm: 'degree', topN: 2 }) as any;
        expect(degree.top[0].id).toBe('acme');
        expect(Number(degree.top[0].degree)).toBe(2);

        const pagerank = await core.analyze({ algorithm: 'pagerank', iterations: 20, topN: 4, persist: true }) as any;
        expect(pagerank.iterations).toBeGreaterThan(0);
        expect(pagerank.top).toHaveLength(4);
        const total = pagerank.top.reduce((sum: number, row: any) => sum + Number(row.score), 0);
        expect(total).toBeGreaterThan(0.9);

        const metrics = await core.query({
            sql: "SELECT count(*)::INTEGER AS c FROM kg_metrics WHERE metric = 'pagerank'",
        }) as any;
        expect(Number(metrics.rows[0].c)).toBe(4);

        const components = await core.analyze({ algorithm: 'components', iterations: 10 }) as any;
        expect(components.components).toBe(1);
        expect(Number(components.top[0].size)).toBe(4);

        const communities = await core.analyze({ algorithm: 'communities', iterations: 10 }) as any;
        expect(communities.communities).toBeGreaterThanOrEqual(1);
    });

    it('imports ndjson and exports a parquet file', async () => {
        const importPath = path.join(workspaceRoot, 'nodes.ndjson');
        await fs.writeFile(importPath, [
            JSON.stringify({ id: 'dave', type: 'person', name: 'Dave', props: { level: 3 } }),
            JSON.stringify({ id: 'erin', type: 'person', name: 'Erin' }),
        ].join('\n'), 'utf8');
        const imported = await core.importData({ target: 'nodes', path: importPath }) as any;
        expect(Number(imported.changed)).toBe(2);
        expect(imported.columns).toEqual(expect.arrayContaining(['id', 'type', 'name', 'props']));

        const props = await core.query({
            sql: "SELECT props->>'level' AS level FROM kg_nodes WHERE id = 'dave'",
        }) as any;
        expect(String(props.rows[0].level)).toBe('3');

        const exportPath = path.join(workspaceRoot, '.duckdb', 'exports', 'people.parquet');
        const exported = await core.exportData({
            sql: "SELECT id, name FROM kg_nodes WHERE type = 'person' ORDER BY id",
            outputPath: exportPath,
            format: 'parquet',
        }) as any;
        expect(exported.bytes).toBeGreaterThan(0);

        const roundTrip = await core.query({
            sql: "SELECT count(*)::INTEGER AS c FROM read_parquet(?)",
            params: [exportPath],
        }).catch((error) => error);
        // 只读查询禁止 read_parquet，导出文件的复核请用 kg_import 或外部工具。
        expect(roundTrip).toBeInstanceOf(Error);

        const exportedJson = path.join(workspaceRoot, '.duckdb', 'exports', 'people.json');
        await core.exportData({ sql: 'SELECT id FROM kg_nodes', outputPath: exportedJson, format: 'json' });
        const text = await fs.readFile(exportedJson, 'utf8');
        expect(text).toContain('alice');
    });

    it('validates data and deletes with cascade', async () => {
        const validation = await core.validate() as any;
        const orphan = validation.checks.find((check: any) => check.check === 'orphan_edges_src');
        expect(Number(orphan.value)).toBe(0);

        const deleted = await core.deleteData({ nodeIds: ['bob'], cascade: true }) as any;
        expect(Number(deleted.changedNodes)).toBe(1);
        expect(Number(deleted.changedEdges)).toBe(2);

        const dangling = await core.query({
            sql: "SELECT count(*)::INTEGER AS c FROM kg_edges WHERE src = 'bob' OR dst = 'bob'",
        }) as any;
        expect(Number(dangling.rows[0].c)).toBe(0);

        await expect(core.deleteData({ all: true })).rejects.toThrow(/confirm/);
    });

    it('imports edge CSV with a column map and deletes exact edge keys', async () => {
        const csvPath = path.join(workspaceRoot, 'edges.csv');
        await fs.writeFile(csvPath, 'from_id,to_id,rel\nzoe,alice,advises\n', 'utf8');
        const imported = await core.importData({
            target: 'edges',
            path: csvPath,
            columnMap: { src: 'from_id', dst: 'to_id', type: 'rel' },
        }) as any;
        expect(Number(imported.changed)).toBe(1);

        const exact = await core.query({
            sql: "SELECT count(*)::INTEGER AS c FROM kg_edges WHERE src='zoe' AND dst='alice' AND type='advises'",
        }) as any;
        expect(Number(exact.rows[0].c)).toBe(1);

        const removed = await core.deleteData({
            edgeKeys: [{ src: 'zoe', dst: 'alice', type: 'advises' }],
        }) as any;
        expect(Number(removed.changedEdges)).toBe(1);

        await core.upsert({
            nodes: [{ id: 'tmp1', type: 'temp' }],
            edges: [{ src: 'tmp1', dst: 'alice', type: 'probe' }],
        });
        const byType = await core.deleteData({ nodeTypes: ['temp'] }) as any;
        expect(Number(byType.changedNodes)).toBe(1);
        expect(Number(byType.changedEdges)).toBe(1);
        const leftovers = await core.query({
            sql: "SELECT count(*)::INTEGER AS c FROM kg_edges WHERE src='tmp1' OR dst='tmp1'",
        }) as any;
        expect(Number(leftovers.rows[0].c)).toBe(0);
    });
});
