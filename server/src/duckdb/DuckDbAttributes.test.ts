import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DuckDbWorkerCore } from '@/duckdb/DuckDbWorkerCore.js';

let tempRoot: string;
let workspaceRoot: string;
let core: DuckDbWorkerCore;

beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kg-attr-test-'));
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

    await core.upsert({
        nodes: [
            { id: 'p1', type: 'person', name: 'P1', props: { age: 40, extra: 'legacy', risk: 'high' } },
            { id: 'p2', type: 'person', name: 'P2', props: { age: 30 } },
            { id: 'c1', type: 'company', name: 'C1' },
            { id: 'c2', type: 'company', name: 'C2' },
        ],
        edges: [
            { src: 'p1', dst: 'p2', type: 'transfer', props: { amount: 20000, when: '2024-01-01' } },
            { src: 'p1', dst: 'c2', type: 'works_at', props: { role: 'ceo' } },
            { src: 'p2', dst: 'c1', type: 'works_at', props: { role: 'analyst' } },
            { src: 'c1', dst: 'c2', type: 'supplies', props: { amount: 500000 } },
        ],
    });
});

afterAll(async () => {
    await core.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('DuckDbWorkerCore attribute governance', () => {
    it('defines attributes with indexes and reports stats', async () => {
        const risk = await core.defineAttribute({
            scope: 'node', key: 'risk', type: 'string',
            required: false, indexed: true, enum: ['high', 'low'],
        }) as any;
        expect(risk.indexed).toBe(true);

        await core.defineAttribute({ scope: 'node', key: 'age', type: 'number', indexed: true });
        await core.defineAttribute({ scope: 'edge', key: 'amount', type: 'number', indexed: true });
        await core.defineAttribute({ scope: 'edge', key: 'when', type: 'date', indexed: true });

        const listed = await core.listAttributes({
            scope: 'all', includeStats: true, topValues: 2,
        }) as any;
        expect(listed.definitions.map((def: any) => `${def.scope}.${def.key}`).sort())
            .toEqual(['edge.amount', 'edge.when', 'node.age', 'node.risk']);

        const age = listed.definitions.find((def: any) => def.key === 'age');
        expect(age.presentRows).toBe(2);
        expect(age.distinctValues).toBe(2);
        expect(age.indexRows).toBe(2);

        const amount = listed.definitions.find((def: any) => def.key === 'amount');
        expect(amount.indexRows).toBe(2);
        expect(amount.topValues).toHaveLength(2);

        const topOnly = await core.listAttributes({ scope: 'edge', topValues: 2 }) as any;
        const amountOnly = topOnly.definitions.find((def: any) => def.key === 'amount');
        expect(amountOnly.topValues).toHaveLength(2);
        expect(amountOnly.presentRows).toBeUndefined();
    });

    it('validates declared attributes on upsert', async () => {
        await core.defineAttribute({
            scope: 'node', key: 'risk', type: 'string', required: true, enum: ['high', 'low'],
        });
        await expect(core.upsert({ nodes: [{ id: 'x1', type: 'person' }] }))
            .rejects.toThrow(/缺少必填属性 "risk"/);
        await expect(core.upsert({ nodes: [{ id: 'x1', type: 'person', props: { risk: 'medium' } }] }))
            .rejects.toThrow(/必须是枚举值/);
        await expect(core.upsert({ nodes: [{ id: 'x1', type: 'person', props: { risk: 1 } }] }))
            .rejects.toThrow(/类型应为 string/);
        await expect(core.upsert({
            edges: [{ src: 'p1', dst: 'p2', type: 'probe', props: { amount: 'abc' } }],
        })).rejects.toThrow(/类型应为 number/);
        await expect(core.upsert({
            nodes: [{ id: 'x1', type: 'person', props: { risk: 'high', unknownKey: 1 } }],
            strictProps: true,
        })).rejects.toThrow(/未声明属性/);

        const warned = await core.upsert({
            nodes: [{ id: 'x1', type: 'person', props: { risk: 'high', unknownKey: 1 } }],
        }) as any;
        expect(warned.warnings.join(' ')).toContain('unknownKey');
        expect(Number(warned.changedNodes)).toBe(1);
    });

    it('finds entities by property predicates and uses the index', async () => {
        const highRisk = await core.findItems({
            scope: 'nodes',
            filter: [{ key: 'risk', op: 'eq', value: 'high' }],
            propKeys: ['risk'],
        }) as any;
        expect(highRisk.items.map((item: any) => item.id)).toEqual(['p1', 'x1']);
        expect(highRisk.usedIndex).toBe(true);
        expect(highRisk.items[0].props).toEqual({ risk: 'high' });
        expect(highRisk.undeclaredKeys).toEqual([]);

        const older = await core.findItems({
            scope: 'nodes', filter: { key: 'age', op: 'gte', value: 35 }, propKeys: ['age'],
        }) as any;
        expect(older.items.map((item: any) => item.id)).toEqual(['p1']);

        const contains = await core.findItems({
            scope: 'nodes', filter: { key: 'extra', op: 'contains', value: 'xyz' },
        }) as any;
        expect(contains.items).toEqual([]);

        const legacy = await core.findItems({
            scope: 'nodes', filter: { key: 'extra', op: 'contains', value: 'leg' },
        }) as any;
        expect(legacy.items.map((item: any) => item.id)).toEqual(['p1']);

        const transfer = await core.findItems({
            scope: 'edges',
            filter: [{ key: 'amount', op: 'gt', value: 10000 }],
            propKeys: ['amount'],
        }) as any;
        expect(transfer.items.map((item: any) => `${item.src}->${item.dst}`).sort())
            .toEqual(['c1->c2', 'p1->p2']);
        expect(transfer.usedIndex).toBe(true);

        const exists = await core.findItems({
            scope: 'edges', filter: { key: 'role', op: 'exists', value: null },
        }) as any;
        expect(exists.items).toHaveLength(2);
        expect(exists.undeclaredKeys).toEqual(['role']);
    });

    it('supports property filters in traverse and per-hop reasoning in path', async () => {
        const traversal = await core.traverse({
            startIds: ['p1'], depth: 2, direction: 'out',
            edgeFilter: [{ key: 'amount', op: 'gte', value: 10000 }],
            nodePropKeys: ['risk', 'age'],
            edgePropKeys: ['amount'],
        }) as any;
        expect(traversal.nodes.map((node: any) => node.id).sort()).toEqual(['p1', 'p2']);
        const transfer = traversal.edges.find((edge: any) => edge.type === 'transfer');
        expect(transfer.props).toEqual({ amount: 20000 });

        const pathResult = await core.findPaths({
            from: 'p1', to: 'c1', maxDepth: 4, direction: 'out',
            hopFilters: [
                { edgeFilter: [{ key: 'amount', op: 'gte', value: 10000 }] },
                {},
            ],
            edgePropKeys: ['amount', 'role'],
            nodePropKeys: ['risk'],
        }) as any;
        expect(pathResult.paths[0].nodes).toEqual(['p1', 'p2', 'c1']);
        expect(pathResult.paths[0].edges.map((edge: any) => edge.type))
            .toEqual(['transfer', 'works_at']);
        expect(pathResult.edges.some((edge: any) => edge.type === 'transfer' && edge.props?.amount === 20000))
            .toBe(true);

        const blocked = await core.findPaths({
            from: 'p1', to: 'c1', maxDepth: 4, direction: 'out',
            hopFilters: [{ edgeFilter: { key: 'amount', op: 'gt', value: 100000 } }],
        }) as any;
        expect(blocked.paths).toEqual([]);

        const nodeBlocked = await core.findPaths({
            from: 'p1', to: 'c1', maxDepth: 4, direction: 'out',
            hopFilters: [{}, { nodeFilter: { key: 'risk', op: 'eq', value: 'low' } }],
        }) as any;
        expect(nodeBlocked.paths).toEqual([]);

        const both = await core.findPaths({
            from: 'p1', to: 'c1', maxDepth: 4, direction: 'both',
            hopFilters: [{ edgeFilter: { key: 'amount', op: 'gte', value: 10000 } }],
        }) as any;
        expect(both.paths[0].nodes).toEqual(['p1', 'p2', 'c1']);
    });

    it('keeps the property index consistent across deletes and reindex', async () => {
        await core.deleteData({ nodeIds: ['x1'], cascade: true });
        const listed = await core.listAttributes({ scope: 'node' }) as any;
        const risk = listed.definitions.find((def: any) => def.key === 'risk');
        expect(risk.indexRows).toBe(1);

        await core.deleteAttribute({ scope: 'node', key: 'risk' });
        const afterDelete = await core.listAttributes({ scope: 'node' }) as any;
        expect(afterDelete.definitions.some((def: any) => def.key === 'risk')).toBe(false);

        const stats = await core.stats() as any;
        expect(Number(stats.attrDefs)).toBeGreaterThanOrEqual(3);

        const rebuilt = await core.rebuildAttributeIndexes() as any;
        expect(rebuilt.rebuiltAttributes).toBe(3);

        const validation = await core.validate() as any;
        const undeclared = validation.checks.find((check: any) => check.check === 'node_undeclared_attrs');
        expect(String(undeclared.value)).toContain('extra');
        const drift = validation.checks.filter((check: any) => String(check.check).endsWith('_index_drift'));
        expect(drift.every((check: any) => Number(check.value) === 0)).toBe(true);
        expect(validation.ok).toBe(true);
        expect(validation.issues).toEqual([]);
        expect(undeclared.severity).toBe('info');
    });

    it('reports violations and info checks separately', async () => {
        await core.defineAttribute({ scope: 'node', key: 'country', type: 'string', required: true });

        const failing = await core.validate() as any;
        expect(failing.ok).toBe(false);
        expect(failing.issues).toContain('node_attr_country_required_missing');
        expect(failing.checks
            .filter((check: any) => check.severity === 'info')
            .every((check: any) => Number(check.value) === 0 || typeof check.value === 'string'))
            .toBe(true);

        await core.deleteAttribute({ scope: 'node', key: 'country' });
        const restored = await core.validate() as any;
        expect(restored.ok).toBe(true);
    });

    it('migrates v1 double-encoded props to JSON objects on open', async () => {
        const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kg-attr-legacy-'));
        const legacyRoot = path.join(legacyDir, 'workspace');
        await fs.mkdir(path.join(legacyRoot, '.duckdb'), { recursive: true });
        const dbPath = path.join(legacyRoot, '.duckdb', 'kg.duckdb');

        const instance = await DuckDBInstance.create(dbPath);
        const connection = await instance.connect();
        await connection.run('CREATE TABLE kg_meta (key VARCHAR PRIMARY KEY, value VARCHAR)');
        await connection.run("INSERT INTO kg_meta VALUES ('schema_version', '1')");
        await connection.run(
            'CREATE TABLE kg_nodes (id VARCHAR PRIMARY KEY, type VARCHAR, name VARCHAR, props JSON)',
        );
        await connection.run(
            `INSERT INTO kg_nodes VALUES ('legacy', 'person', 'L', '"{\\"risk\\":\\"high\\"}"')`,
        );
        connection.closeSync();
        instance.closeSync();

        const legacyCore = new DuckDbWorkerCore();
        try {
            await legacyCore.open({
                dbPath,
                workspaceRoot: legacyRoot,
                tempDir: path.join(legacyRoot, '.duckdb', 'tmp'),
                memoryLimitMb: 256,
                threads: 1,
            });
            const result = await legacyCore.query({
                sql: "SELECT json_type(props) AS t, json_extract_string(props, '$.risk') AS risk FROM kg_nodes",
            }) as any;
            expect(result.rows[0].t).toBe('OBJECT');
            expect(result.rows[0].risk).toBe('high');
        } finally {
            await legacyCore.close();
            await fs.rm(legacyDir, { recursive: true, force: true });
        }
    });
});
