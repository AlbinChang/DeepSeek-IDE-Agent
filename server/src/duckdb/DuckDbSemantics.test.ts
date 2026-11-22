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
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kg-semantic-test-'));
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

describe('DuckDbWorkerCore semantic governance', () => {
    it('declares a vocabulary with domain/range and rejects violating writes', async () => {
        await core.defineVocab({ kind: 'class', name: 'person' });
        await core.defineVocab({ kind: 'class', name: 'employee', parent: 'person' });
        await core.defineVocab({ kind: 'class', name: 'company' });
        const property = await core.defineVocab({
            kind: 'property', name: 'works_at', domain: ['person'], range: ['company'],
        }) as any;
        expect(property.effective.domain.sort()).toEqual(['employee', 'person']);
        expect(property.effective.range).toEqual(['company']);

        await core.upsert({
            nodes: [
                { id: 'p1', type: 'person', name: 'P1' },
                { id: 'e1', type: 'employee', name: 'E1' },
                { id: 'c1', type: 'company', name: 'C1' },
            ],
        });
        // 子类实例满足父类 domain
        const ok = await core.upsert({
            edges: [{ src: 'e1', dst: 'c1', type: 'works_at' }],
        }) as any;
        expect(ok.edges).toBe(1);

        await expect(core.upsert({ nodes: [{ id: 'x1', type: 'product', name: 'X1' }] }))
            .resolves.toBeTruthy();
        await expect(core.upsert({ edges: [{ src: 'x1', dst: 'c1', type: 'works_at' }] }))
            .rejects.toThrow(/rdfs:domain/);

        await core.upsert({
            nodes: [{ id: 'x2', type: 'product', name: 'X2' }],
        });
        await expect(core.upsert({ edges: [{ src: 'e1', dst: 'x2', type: 'works_at' }] }))
            .rejects.toThrow(/rdfs:range/);

        await expect(core.upsert({
            nodes: [{ id: 'z1', type: 'unknown_type' }],
            strictSchema: true,
        })).rejects.toThrow(/词表声明/);

        const listed = await core.listVocab({ kind: 'property' }) as any;
        expect(listed.definitions[0].usage).toBe(1);
        expect(listed.undeclaredEdgeTypes).toEqual([]);
    });

    it('enforces attribute domain, unique values and identity keys', async () => {
        await core.defineAttribute({
            scope: 'node', key: 'email', type: 'string', unique: true, domain: ['person', 'employee'],
        });
        await core.defineAttribute({
            scope: 'node', key: 'employee_no', type: 'string', identity: true, domain: ['employee'],
        });

        await expect(core.upsert({
            nodes: [{ id: 'c9', type: 'company', name: 'C9', props: { email: 'c9@corp' } }],
        })).rejects.toThrow(/属性域/);

        await core.upsert({
            nodes: [{ id: 'p2', type: 'person', name: 'P2', props: { email: 'p2@corp' } }],
        });
        await expect(core.upsert({
            nodes: [{ id: 'p3', type: 'person', name: 'P3', props: { email: 'p2@corp' } }],
        })).rejects.toThrow(/unique/);
        await expect(core.upsert({
            nodes: [
                { id: 'p4', type: 'person', name: 'P4', props: { email: 'dup@corp' } },
                { id: 'p5', type: 'person', name: 'P5', props: { email: 'dup@corp' } },
            ],
        })).rejects.toThrow(/批次内/);

        await core.upsert({
            nodes: [{ id: 'e2', type: 'employee', name: 'E2', props: { employee_no: 'E-001' } }],
        });
        await expect(core.upsert({
            nodes: [{ id: 'e3', type: 'employee', name: 'E3', props: { employee_no: 'E-001' } }],
        })).rejects.toThrow(/身份键冲突/);
        await expect(core.upsert({
            nodes: [
                { id: 'e4', type: 'employee', name: 'E4', props: { employee_no: 'E-100' } },
                { id: 'e5', type: 'employee', name: 'E5', props: { employee_no: 'E-100' } },
            ],
        })).rejects.toThrow(/身份键（employee_no）冲突/);

        const identity = await core.query({
            sql: 'SELECT count(*)::BIGINT AS c FROM kg_identity',
        }) as any;
        expect(Number(identity.rows[0].c)).toBe(1);
    });

    it('runs a compile-style lint that reports semantic diagnostics', async () => {
        const clean = await core.lint({}) as any;
        expect(clean.diagnostics.some((item: any) => item.severity === 'error')).toBe(false);
        expect(clean.ok).toBe(true);

        // 制造语义破损：自环式对称关系缺失、类型越界、身份键缺失、ID 近重复
        await core.defineVocab({ kind: 'property', name: 'knows', symmetric: true });
        await core.defineVocab({ kind: 'property', name: 'part_of', transitive: true });
        await core.upsert({
            nodes: [
                { id: 'k1', type: 'person', props: { email: 'k1@corp' } },
                { id: 'k2', type: 'person', props: { email: 'k2@corp' } },
                { id: 'K1', type: 'person' },
            ],
            edges: [
                { src: 'k1', dst: 'k2', type: 'knows' },
                { src: 'k1', dst: 'k2', type: 'relates_to' },
                { src: 'k1', dst: 'k2', type: 'part_of' },
                { src: 'k2', dst: 'c1', type: 'part_of' },
            ],
        });

        const report = await core.lint({ deep: true }) as any;
        const codes = report.diagnostics.map((item: any) => item.code);
        expect(codes).toContain('symmetric_missing_inverse');
        expect(codes).toContain('transitive_missing_shortcut');
        expect(codes).toContain('identity_incomplete');
        expect(codes).toContain('id_normalized_duplicate');
        expect(codes).toContain('vocab_undeclared_edge_type');

        // 词表演进（收紧 range）后，历史数据立即变成语义违规 → 编译检查必须报错
        await core.defineVocab({ kind: 'property', name: 'works_at', domain: ['person'], range: ['bank'] });
        const broken = await core.lint({}) as any;
        const brokenCodes = broken.diagnostics.map((item: any) => item.code);
        expect(brokenCodes).toContain('edge_range_violation');
        expect(broken.ok).toBe(false);
        expect(broken.errorRows).toBeGreaterThan(0);

        const filtered = await core.lint({ codes: ['symmetric_missing_inverse'] }) as any;
        expect(filtered.diagnostics).toHaveLength(1);
        expect(filtered.diagnostics[0].count).toBe(1);
    });

    it('merges duplicate entities and keeps semantic uniqueness intact', async () => {
        await core.upsert({
            nodes: [
                {
                    id: 'dup_a', type: 'employee', name: 'Dup A',
                    props: { email: 'dup@corp', employee_no: 'E-900', nick: 'a' },
                },
                {
                    id: 'dup_b', type: 'employee', name: 'Dup B',
                    props: { email: 'dup_b@corp', employee_no: 'E-901', dept: '风控' },
                },
                { id: 'n1', type: 'person' },
            ],
            edges: [
                { src: 'n1', dst: 'dup_a', type: 'knows' },
                { src: 'dup_a', dst: 'dup_b', type: 'knows' },
            ],
        });

        const merged = await core.mergeEntities({
            source: 'dup_a', target: 'dup_b', keepProps: 'merge', confirm: true,
        }) as any;
        expect(merged.movedEdges).toBe(2);
        expect(merged.droppedSelfLoops).toBe(1);
        expect(merged.props).toEqual(expect.arrayContaining(['email', 'employee_no', 'dept', 'nick']));

        const remaining = await core.query({
            sql: "SELECT id, props FROM kg_nodes WHERE id LIKE 'dup%'",
        }) as any;
        expect(remaining.rows).toHaveLength(1);
        expect(remaining.rows[0].id).toBe('dup_b');

        const edges = await core.query({
            sql: `SELECT src, dst, type FROM kg_edges
                  WHERE src LIKE 'dup%' OR dst LIKE 'dup%' OR src = 'n1'
                  ORDER BY src, dst`,
        }) as any;
        expect(edges.rows).toEqual([{ src: 'n1', dst: 'dup_b', type: 'knows' }]);

        const identity = await core.query({
            sql: "SELECT node_id, keys_json FROM kg_identity WHERE node_id = 'dup_b'",
        }) as any;
        expect(identity.rows[0].keys_json).toContain('E-901');

        await core.query({ sql: 'SELECT 1' });
    });

    it('migrates a v2 database to v3 semantic columns', async () => {
        const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kg-semantic-legacy-'));
        const legacyRoot = path.join(legacyDir, 'workspace');
        await fs.mkdir(path.join(legacyRoot, '.duckdb'), { recursive: true });
        const dbPath = path.join(legacyRoot, '.duckdb', 'kg.duckdb');

        const instance = await DuckDBInstance.create(dbPath);
        const connection = await instance.connect();
        await connection.run('CREATE TABLE kg_meta (key VARCHAR PRIMARY KEY, value VARCHAR)');
        await connection.run("INSERT INTO kg_meta VALUES ('schema_version', '2')");
        await connection.run(
            `CREATE TABLE kg_attr_defs (
                scope VARCHAR NOT NULL, key VARCHAR NOT NULL, value_type VARCHAR NOT NULL,
                description VARCHAR, required BOOLEAN NOT NULL DEFAULT false,
                indexed BOOLEAN NOT NULL DEFAULT false, enum_values JSON,
                created_at TIMESTAMP NOT NULL DEFAULT now(),
                updated_at TIMESTAMP NOT NULL DEFAULT now(),
                PRIMARY KEY (scope, key)
            )`,
        );
        await connection.run(
            `INSERT INTO kg_attr_defs (scope, key, value_type, required, indexed)
             VALUES ('node', 'legacy_key', 'string', true, true)`,
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
            const stats = await legacyCore.stats() as any;
            expect(String(stats.schemaVersion)).toBe('3');

            const defs = await legacyCore.listAttributes({ scope: 'node' }) as any;
            expect(defs.definitions[0].key).toBe('legacy_key');
            expect(defs.definitions[0].unique_value).toBe(false);
            expect(defs.definitions[0].identity).toBe(false);
            expect(defs.definitions[0].domain).toBeNull();

            const vocab = await legacyCore.defineVocab({
                kind: 'class', name: 'legacy_type',
            }) as any;
            expect(vocab.created).toBe(true);
        } finally {
            await legacyCore.close();
            await fs.rm(legacyDir, { recursive: true, force: true });
        }
    });
});
