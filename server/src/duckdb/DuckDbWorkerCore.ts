/**
 * DuckDB Worker 核心：所有数据库读写都发生在这里（独立子进程内）。
 *
 * 设计要点：
 * - 模型永远拿不到数据库连接，只能通过 kg_* 工具 → IPC → 本类。
 * - schema 固定（kg_nodes / kg_edges / kg_metrics / kg_meta），读写都走参数化 SQL。
 * - 面向百万级图：批量 upsert 用一条 JSON→json_each 语句，遍历用递归 CTE，
 *   分析算法用迭代式聚合（PageRank / 标签传播），全部在 DuckDB 内完成。
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import {
    DUCKDB_ERROR_CODES,
    DuckDbToolError,
} from './duckdbProtocol.js';
import {
    KG_LIMITS,
    assertReadOnlySql,
    assertSafeIdentifier,
    clampInt,
    jsonListParam,
    normalizeStringArray,
} from './sqlGuard.js';
import {
    assertAttrKey,
    assertAttrScope,
    assertAttrType,
    buildAttrPredicateSql,
    normalizePredicates,
    normalizePropKeys,
    type AttrPredicate,
    type AttrScope,
    type AttrType,
    type SqlParam,
} from './attributePredicates.js';
import {
    assertVocabKind,
    assertVocabName,
    buildEffectivePropertyRules,
    buildTypeClosure,
    normalizeTypeList,
    type EffectivePropertyRule,
    type VocabDefinition,
    type VocabKind,
} from './semanticVocabulary.js';

export const KG_SCHEMA_VERSION = '3';

const NODE_PROPS_DDL = `CREATE TABLE IF NOT EXISTS kg_node_props (
        node_id VARCHAR NOT NULL,
        key VARCHAR NOT NULL,
        val_text VARCHAR,
        val_num DOUBLE,
        PRIMARY KEY (node_id, key)
    )`;
const EDGE_PROPS_DDL = `CREATE TABLE IF NOT EXISTS kg_edge_props (
        src VARCHAR NOT NULL,
        dst VARCHAR NOT NULL,
        type VARCHAR NOT NULL,
        key VARCHAR NOT NULL,
        val_text VARCHAR,
        val_num DOUBLE,
        PRIMARY KEY (src, dst, type, key)
    )`;
const IDENTITY_DDL = `CREATE TABLE IF NOT EXISTS kg_identity (
        key_hash VARCHAR PRIMARY KEY,
        node_id VARCHAR NOT NULL,
        keys_json VARCHAR,
        updated_at TIMESTAMP NOT NULL DEFAULT now()
    )`;

const SCHEMA_DDL = [
    `CREATE TABLE IF NOT EXISTS kg_meta (
        key VARCHAR PRIMARY KEY,
        value VARCHAR
    )`,
    `CREATE TABLE IF NOT EXISTS kg_nodes (
        id VARCHAR PRIMARY KEY,
        type VARCHAR NOT NULL,
        name VARCHAR,
        props JSON,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS kg_edges (
        src VARCHAR NOT NULL,
        dst VARCHAR NOT NULL,
        type VARCHAR NOT NULL,
        weight DOUBLE NOT NULL DEFAULT 1.0,
        props JSON,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now(),
        PRIMARY KEY (src, dst, type)
    )`,
    `CREATE TABLE IF NOT EXISTS kg_metrics (
        node_id VARCHAR NOT NULL,
        metric VARCHAR NOT NULL,
        value DOUBLE,
        label VARCHAR,
        updated_at TIMESTAMP NOT NULL DEFAULT now(),
        PRIMARY KEY (metric, node_id)
    )`,
    `CREATE TABLE IF NOT EXISTS kg_attr_defs (
        scope VARCHAR NOT NULL,
        key VARCHAR NOT NULL,
        value_type VARCHAR NOT NULL,
        description VARCHAR,
        required BOOLEAN NOT NULL DEFAULT false,
        indexed BOOLEAN NOT NULL DEFAULT false,
        enum_values JSON,
        domain JSON,
        unique_value BOOLEAN NOT NULL DEFAULT false,
        identity BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now(),
        PRIMARY KEY (scope, key)
    )`,
    `CREATE TABLE IF NOT EXISTS kg_vocab_defs (
        kind VARCHAR NOT NULL,
        name VARCHAR NOT NULL,
        parent VARCHAR,
        domain_types JSON,
        range_types JSON,
        is_symmetric BOOLEAN NOT NULL DEFAULT false,
        is_transitive BOOLEAN NOT NULL DEFAULT false,
        description VARCHAR,
        created_at TIMESTAMP NOT NULL DEFAULT now(),
        updated_at TIMESTAMP NOT NULL DEFAULT now(),
        PRIMARY KEY (kind, name)
    )`,
    `CREATE TABLE IF NOT EXISTS kg_identity (
        key_hash VARCHAR PRIMARY KEY,
        node_id VARCHAR NOT NULL,
        keys_json VARCHAR,
        updated_at TIMESTAMP NOT NULL DEFAULT now()
    )`,
    NODE_PROPS_DDL,
    EDGE_PROPS_DDL,
    'CREATE INDEX IF NOT EXISTS idx_kg_edges_src ON kg_edges(src)',
    'CREATE INDEX IF NOT EXISTS idx_kg_edges_dst ON kg_edges(dst)',
    'CREATE INDEX IF NOT EXISTS idx_kg_edges_type ON kg_edges(type)',
    'CREATE INDEX IF NOT EXISTS idx_kg_nodes_type ON kg_nodes(type)',
    'CREATE INDEX IF NOT EXISTS idx_kg_metrics_metric ON kg_metrics(metric)',
    'CREATE INDEX IF NOT EXISTS idx_kg_node_props_text ON kg_node_props(key, val_text)',
    'CREATE INDEX IF NOT EXISTS idx_kg_node_props_num ON kg_node_props(key, val_num)',
    'CREATE INDEX IF NOT EXISTS idx_kg_edge_props_text ON kg_edge_props(key, val_text)',
    'CREATE INDEX IF NOT EXISTS idx_kg_edge_props_num ON kg_edge_props(key, val_num)',
    'CREATE INDEX IF NOT EXISTS idx_kg_identity_node ON kg_identity(node_id)',
    'CREATE INDEX IF NOT EXISTS idx_kg_vocab_parent ON kg_vocab_defs(kind, parent)',
];

/** v2 → v3：属性规范扩展语义唯一性字段（幂等）。 */
const SCHEMA_MIGRATIONS = [
    'ALTER TABLE kg_attr_defs ADD COLUMN IF NOT EXISTS domain JSON',
    'ALTER TABLE kg_attr_defs ADD COLUMN IF NOT EXISTS unique_value BOOLEAN DEFAULT false',
    'ALTER TABLE kg_attr_defs ADD COLUMN IF NOT EXISTS identity BOOLEAN DEFAULT false',
];

const NODE_UPSERT_SQL = `
    INSERT INTO kg_nodes (id, type, name, props)
    SELECT
        json_extract_string(j.value, '$.id'),
        json_extract_string(j.value, '$.type'),
        COALESCE(json_extract_string(j.value, '$.name'), ''),
        CAST(json_extract_string(j.value, '$.props') AS JSON)
    FROM json_each(?::JSON) AS j
    ON CONFLICT (id) DO UPDATE SET
        type = excluded.type,
        name = excluded.name,
        props = COALESCE(excluded.props, kg_nodes.props),
        updated_at = now()
`;

const EDGE_UPSERT_SQL = `
    INSERT INTO kg_edges (src, dst, type, weight, props)
    SELECT
        json_extract_string(j.value, '$.src'),
        json_extract_string(j.value, '$.dst'),
        json_extract_string(j.value, '$.type'),
        COALESCE(CAST(json_extract_string(j.value, '$.weight') AS DOUBLE), 1.0),
        CAST(json_extract_string(j.value, '$.props') AS JSON)
    FROM json_each(?::JSON) AS j
    ON CONFLICT (src, dst, type) DO UPDATE SET
        weight = excluded.weight,
        props = COALESCE(excluded.props, kg_edges.props),
        updated_at = now()
`;

const ID_LIST_PREDICATE = `IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))`;

export interface DuckDbOpenOptions {
    dbPath: string;
    workspaceRoot: string;
    tempDir: string;
    memoryLimitMb?: number;
    threads?: number;
}

export interface DuckDbQueryResult {
    columns: string[];
    rows: Record<string, unknown>[];
    rowCount: number;
    truncated: boolean;
    elapsedMs: number;
}

export interface DuckDbTraverseResult {
    startIds: string[];
    depth: number;
    direction: 'out' | 'in' | 'both';
    nodes: Record<string, unknown>[];
    edges: Record<string, unknown>[];
    totalNodes: number;
    walkNodes: number;
    totalEdges: number;
    truncated: boolean;
    elapsedMs: number;
}

export interface AttributeDefinition {
    scope: AttrScope;
    key: string;
    value_type: AttrType;
    description?: string | null;
    required?: boolean;
    indexed?: boolean;
    enum_values?: string[] | null;
    /** RDFS domain：只允许这些实体类型携带该属性。 */
    domain?: string[] | null;
    /** owl:InverseFunctionalProperty：同一值只能属于一个实体。 */
    unique_value?: boolean;
    /** 组成节点自然键（实体同一性判定）。 */
    identity?: boolean;
}

export interface SemanticDiagnostic {
    code: string;
    severity: 'error' | 'warning' | 'info';
    count: number;
    message: string;
    hint?: string;
    sample?: Record<string, unknown>[];
}

export class DuckDbWorkerCore {
    private instance?: DuckDBInstance;
    private connection?: DuckDBConnection;
    private openOptions?: DuckDbOpenOptions;
    private openedAt = 0;
    private readonly log: (level: 'info' | 'warn' | 'error', message: string) => void;

    constructor(options: { log?: (level: 'info' | 'warn' | 'error', message: string) => void } = {}) {
        this.log = options.log || (() => undefined);
    }

    public get isOpen(): boolean {
        return Boolean(this.connection);
    }

    public get dbPath(): string | undefined {
        return this.openOptions?.dbPath;
    }

    /** 由 Worker 主循环在超时/取消时调用。 */
    public interrupt(): void {
        try {
            this.connection?.interrupt();
        } catch (error) {
            this.log('warn', `interrupt failed: ${(error as Error).message}`);
        }
    }

    public async open(options: DuckDbOpenOptions): Promise<Record<string, unknown>> {
        const dbPath = this.assertDbPath(options.dbPath, options.workspaceRoot);
        const tempDir = path.resolve(options.tempDir);
        await fs.mkdir(path.dirname(dbPath), { recursive: true });
        await fs.mkdir(tempDir, { recursive: true });

        if (this.connection && this.openOptions?.dbPath === dbPath) {
            return await this.stats();
        }
        await this.close();

        const memoryLimitMb = clampInt(options.memoryLimitMb, 128, 65536, 2048);
        const threads = clampInt(options.threads, 1, 64, 4);
        this.instance = await DuckDBInstance.create(dbPath, {
            memory_limit: `${memoryLimitMb}MB`,
            threads: String(threads),
            temp_directory: tempDir,
            preserve_insertion_order: 'false',
        });
        this.connection = await this.instance.connect();
        // 进度条属于 session setting，不是 create config option。
        await this.connection.run('SET enable_progress_bar = false');
        await this.connection.run('SET enable_progress_bar_print = false');
        this.openOptions = { ...options, dbPath, tempDir };
        this.openedAt = Date.now();

        await this.bootstrapSchema();
        this.log('info', `opened ${dbPath} (memory=${memoryLimitMb}MB, threads=${threads})`);
        return await this.stats();
    }

    public async close(): Promise<void> {
        try {
            this.connection?.closeSync();
        } catch {
            // ignore
        }
        try {
            this.instance?.closeSync();
        } catch {
            // ignore
        }
        this.connection = undefined;
        this.instance = undefined;
        this.openOptions = undefined;
    }

    public async handle(op: string, payload: Record<string, unknown> = {}): Promise<unknown> {
        switch (op) {
            case 'ping': return { pong: true, pid: process.pid, opened: this.isOpen };
            case 'open': return await this.open(payload as unknown as DuckDbOpenOptions);
            case 'stats': return await this.stats();
            case 'schema': return await this.schema();
            case 'query': return await this.query(payload);
            case 'export': return await this.exportData(payload);
            case 'upsert': return await this.upsert(payload);
            case 'delete': return await this.deleteData(payload);
            case 'traverse': return await this.traverse(payload);
            case 'path': return await this.findPaths(payload);
            case 'analyze': return await this.analyze(payload);
            case 'import': return await this.importData(payload);
            case 'find': return await this.findItems(payload);
            case 'attr_define': return await this.defineAttribute(payload);
            case 'attr_list': return await this.listAttributes(payload);
            case 'attr_delete': return await this.deleteAttribute(payload);
            case 'attr_reindex': return await this.rebuildAttributeIndexes();
            case 'vocab_define': return await this.defineVocab(payload);
            case 'vocab_list': return await this.listVocab(payload);
            case 'vocab_delete': return await this.deleteVocab(payload);
            case 'lint': return await this.lint(payload);
            case 'merge': return await this.mergeEntities(payload);
            case 'validate': return await this.validate();
            case 'checkpoint': return await this.checkpoint();
            default:
                throw new DuckDbToolError(
                    DUCKDB_ERROR_CODES.invalidRequest,
                    `未知的 DuckDB 操作：${op}`,
                );
        }
    }

    // ─── 生命周期与元信息 ──────────────────────────────────

    private assertDbPath(dbPath: string, workspaceRoot: string): string {
        const abs = path.resolve(String(dbPath || ''));
        const root = path.resolve(String(workspaceRoot || ''));
        const top = path.dirname(abs);
        const inside = abs === root || abs.startsWith(`${root}${path.sep}`);
        if (!inside) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.pathRejected,
                '数据库文件必须位于当前工作区内。',
            );
        }
        if (path.basename(top) !== '.duckdb') {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.pathRejected,
                '数据库文件必须放在工作区 .duckdb 目录下。',
            );
        }
        if (!/\.duckdb$/i.test(abs)) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.pathRejected,
                '数据库文件扩展名必须是 .duckdb。',
            );
        }
        return abs;
    }

    private requireConnection(): DuckDBConnection {
        if (!this.connection) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.notOpen, 'DuckDB 尚未打开。');
        }
        return this.connection;
    }

    private async bootstrapSchema(): Promise<void> {
        const con = this.requireConnection();
        await con.run('BEGIN TRANSACTION');
        try {
            for (const ddl of SCHEMA_DDL) {
                await con.run(ddl);
            }
            for (const ddl of SCHEMA_MIGRATIONS) {
                await con.run(ddl);
            }
            const previousVersion = await this.scalar(
                `SELECT value FROM kg_meta WHERE key = 'schema_version'`,
            );
            if (previousVersion && String(previousVersion) !== KG_SCHEMA_VERSION) {
                // v1 的 upsert 会把 props 二次编码成 JSON 字符串，v2 起统一为对象。
                await con.run(
                    `UPDATE kg_nodes SET props = CAST(json_extract_string(props, '$') AS JSON)
                     WHERE props IS NOT NULL AND json_type(props) = 'VARCHAR'`,
                );
                await con.run(
                    `UPDATE kg_edges SET props = CAST(json_extract_string(props, '$') AS JSON)
                     WHERE props IS NOT NULL AND json_type(props) = 'VARCHAR'`,
                );
                this.log('info', `migrated props encoding from schema v${previousVersion} to v${KG_SCHEMA_VERSION}`);
            }            await con.run(
                `INSERT INTO kg_meta (key, value) VALUES ('schema_version', ?)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
                [KG_SCHEMA_VERSION],
            );
            await con.run(
                `INSERT INTO kg_meta (key, value) VALUES ('created_at', ?)
                 ON CONFLICT (key) DO NOTHING`,
                [new Date().toISOString()],
            );
            await con.run('COMMIT');
        } catch (error) {
            await con.run('ROLLBACK').catch(() => undefined);
            throw error;
        }
    }

    public async stats(): Promise<Record<string, unknown>> {
        const con = this.requireConnection();
        const counts = await this.rows(
            `SELECT (SELECT count(*)::BIGINT FROM kg_nodes) AS nodes,
                    (SELECT count(*)::BIGINT FROM kg_edges) AS edges,
                    (SELECT count(*)::BIGINT FROM kg_metrics) AS metrics,
                    (SELECT count(*)::BIGINT FROM kg_attr_defs) AS attr_defs,
                    (SELECT count(*)::BIGINT FROM kg_attr_defs WHERE indexed) AS indexed_attrs`,
        );
        const settings = await this.rows(
            `SELECT current_setting('memory_limit') AS memory_limit,
                    current_setting('threads') AS threads,
                    current_setting('temp_directory') AS temp_directory`,
        );
        const dbPath = this.openOptions?.dbPath || '';
        const fileBytes = await this.fileSize(dbPath);
        const walBytes = await this.fileSize(`${dbPath}.wal`);
        return {
            duckdbVersion: await this.duckdbVersion(),
            dbPath,
            dbBytes: fileBytes,
            walBytes,
            schemaVersion: KG_SCHEMA_VERSION,
            nodes: counts[0]?.nodes ?? '0',
            edges: counts[0]?.edges ?? '0',
            metrics: counts[0]?.metrics ?? '0',
            attrDefs: counts[0]?.attr_defs ?? '0',
            indexedAttrs: counts[0]?.indexed_attrs ?? '0',
            memoryLimit: settings[0]?.memory_limit ?? null,
            threads: settings[0]?.threads ?? null,
            tempDirectory: settings[0]?.temp_directory ?? null,
            uptimeMs: this.openedAt ? Date.now() - this.openedAt : 0,
            pid: process.pid,
        };
    }

    public async schema(): Promise<Record<string, unknown>> {
        const nodes = await this.rows('DESCRIBE kg_nodes');
        const edges = await this.rows('DESCRIBE kg_edges');
        const metrics = await this.rows('DESCRIBE kg_metrics');
        const attrDefs = await this.rows('DESCRIBE kg_attr_defs');
        const nodeProps = await this.rows('DESCRIBE kg_node_props');
        const edgeProps = await this.rows('DESCRIBE kg_edge_props');
        const indexes = await this.rows(
            `SELECT index_name, table_name, is_unique, expressions
             FROM duckdb_indexes()
             WHERE table_name IN ('kg_nodes','kg_edges','kg_metrics','kg_attr_defs','kg_node_props','kg_edge_props')
             ORDER BY table_name, index_name`,
        );
        return {
            schemaVersion: KG_SCHEMA_VERSION,
            tables: {
                kg_nodes: nodes,
                kg_edges: edges,
                kg_metrics: metrics,
                kg_attr_defs: attrDefs,
                kg_node_props: nodeProps,
                kg_edge_props: edgeProps,
            },
            indexes,
            ddl: SCHEMA_DDL,
        };
    }

    public async checkpoint(): Promise<Record<string, unknown>> {
        const con = this.requireConnection();
        const started = Date.now();
        await con.run('CHECKPOINT');
        const dbPath = this.openOptions?.dbPath || '';
        return {
            elapsedMs: Date.now() - started,
            dbBytes: await this.fileSize(dbPath),
            walBytes: await this.fileSize(`${dbPath}.wal`),
        };
    }

    public async validate(): Promise<Record<string, unknown>> {
        const started = Date.now();
        const checks = [
            {
                name: 'orphan_edges_src',
                sql: `SELECT count(*)::BIGINT AS c FROM kg_edges e
                      LEFT JOIN kg_nodes n ON n.id = e.src WHERE n.id IS NULL`,
                hint: '边的 src 指向不存在的节点',
            },
            {
                name: 'orphan_edges_dst',
                sql: `SELECT count(*)::BIGINT AS c FROM kg_edges e
                      LEFT JOIN kg_nodes n ON n.id = e.dst WHERE n.id IS NULL`,
                hint: '边的 dst 指向不存在的节点',
            },
            {
                name: 'invalid_node_rows',
                sql: `SELECT count(*)::BIGINT AS c FROM kg_nodes
                      WHERE id IS NULL OR id = '' OR type IS NULL OR type = ''`,
                hint: '节点缺少 id / type',
            },
            {
                name: 'invalid_edge_rows',
                sql: `SELECT count(*)::BIGINT AS c FROM kg_edges
                      WHERE src IS NULL OR src = '' OR dst IS NULL OR dst = '' OR type IS NULL OR type = ''`,
                hint: '边缺少 src / dst / type',
            },
            {
                name: 'self_loops',
                sql: `SELECT count(*)::BIGINT AS c FROM kg_edges WHERE src = dst`,
                hint: '自环边数量（不一定是错误）',
            },
            {
                name: 'isolated_nodes',
                sql: `WITH active AS (SELECT src AS id FROM kg_edges UNION SELECT dst FROM kg_edges)
                      SELECT count(*)::BIGINT AS c FROM kg_nodes n
                      LEFT JOIN active a ON a.id = n.id WHERE a.id IS NULL`,
                hint: '没有任何连接的孤立节点数量',
            },
        ];

        const results: Record<string, unknown>[] = [];
        for (const check of checks) {
            const value = await this.scalar(check.sql);
            results.push({ check: check.name, value, hint: check.hint });
        }

        const defs = await this.loadAttrDefs();
        for (const def of defs) {
            const table = def.scope === 'node' ? 'kg_nodes' : 'kg_edges';
            const path = `'$."${def.key}"'`;
            const presence = `json_extract_string(props, ${path})`;
            const label = `${def.scope}_attr_${def.key}`;
            if (def.required) {
                results.push({
                    check: `${label}_required_missing`,
                    value: await this.scalar(`SELECT count(*)::BIGINT AS c FROM ${table} WHERE ${presence} IS NULL`),
                    hint: `必填属性 ${def.key}（${def.value_type}）缺失`,
                });
            }
            if (def.value_type === 'number') {
                results.push({
                    check: `${label}_type_invalid`,
                    value: await this.scalar(
                        `SELECT count(*)::BIGINT AS c FROM ${table}
                         WHERE ${presence} IS NOT NULL AND TRY_CAST(${presence} AS DOUBLE) IS NULL`,
                    ),
                    hint: 'number 类型属性无法转换为数字',
                });
            } else if (def.value_type === 'boolean') {
                results.push({
                    check: `${label}_type_invalid`,
                    value: await this.scalar(
                        `SELECT count(*)::BIGINT AS c FROM ${table}
                         WHERE ${presence} IS NOT NULL AND lower(${presence}) NOT IN ('true', 'false')`,
                    ),
                    hint: 'boolean 类型属性不是 true/false',
                });
            } else if (def.value_type === 'date') {
                results.push({
                    check: `${label}_type_invalid`,
                    value: await this.scalar(
                        `SELECT count(*)::BIGINT AS c FROM ${table}
                         WHERE ${presence} IS NOT NULL AND TRY_CAST(${presence} AS TIMESTAMP) IS NULL`,
                    ),
                    hint: 'date 类型属性不是可解析的 ISO 时间',
                });
            }
            if (def.enum_values?.length) {
                results.push({
                    check: `${label}_enum_invalid`,
                    value: await this.scalar(
                        `SELECT count(*)::BIGINT AS c FROM ${table}
                         WHERE ${presence} IS NOT NULL
                           AND ${presence} NOT IN (
                               SELECT json_extract_string(value, '$') FROM json_each(?::JSON)
                           )`,
                        [JSON.stringify(def.enum_values)],
                    ),
                    hint: `属性值不在枚举范围内：${def.enum_values.join(', ')}`,
                });
            }
            if (def.indexed) {
                const expressions = this.attrIndexExpressions(def);
                const expected = Number(await this.scalar(
                    `SELECT count(*)::BIGINT AS c FROM ${table} WHERE ${expressions.present}`,
                ) || 0);
                const indexTable = this.attrIndexTable(def.scope);
                const actual = Number(await this.scalar(
                    `SELECT count(*)::BIGINT AS c FROM ${indexTable} WHERE key = ?`,
                    [def.key],
                ) || 0);
                results.push({
                    check: `${label}_index_drift`,
                    value: actual - expected,
                    hint: '属性索引行数 - 应有行数；≠0 时执行 kg_admin reindex',
                });
            }
        }

        for (const scope of ['node', 'edge'] as AttrScope[]) {
            const table = scope === 'node' ? 'kg_nodes' : 'kg_edges';
            const defined = new Set(defs.filter((def) => def.scope === scope).map((def) => def.key));
            const keyRows = await this.rows(
                `SELECT DISTINCT unnest(json_keys(props)) AS key
                 FROM ${table} WHERE props IS NOT NULL`,
            );
            const extra = keyRows
                .map((row: any) => String(row.key))
                .filter((key) => !defined.has(key))
                .sort();
            results.push({
                check: `${scope}_undeclared_attrs`,
                value: extra.length ? extra.slice(0, 50).join(', ') : '0',
                hint: `未声明的属性 ${extra.length} 个；建议先 kg_define_attr 再写入`,
            });
        }

        results.push({
            check: 'node_prop_index_orphans',
            value: await this.scalar(
                `SELECT count(*)::BIGINT AS c FROM kg_node_props p
                 LEFT JOIN kg_nodes n ON n.id = p.node_id WHERE n.id IS NULL`,
            ),
            hint: '节点属性索引中存在已删除节点',
        });
        results.push({
            check: 'edge_prop_index_orphans',
            value: await this.scalar(
                `SELECT count(*)::BIGINT AS c FROM kg_edge_props p
                 LEFT JOIN kg_edges e ON e.src = p.src AND e.dst = p.dst AND e.type = p.type
                 WHERE e.src IS NULL`,
            ),
            hint: '边属性索引中存在已删除边',
        });
        for (const scope of ['node', 'edge'] as AttrScope[]) {
            const indexTable = this.attrIndexTable(scope);
            results.push({
                check: `${scope}_prop_index_undefined_keys`,
                value: await this.scalar(
                    `SELECT count(DISTINCT key)::BIGINT AS c FROM ${indexTable}
                     WHERE key NOT IN (
                        SELECT key FROM kg_attr_defs WHERE scope = ? AND indexed
                     )`,
                    [scope],
                ),
                hint: '属性索引中存在无对应规范的 key；执行 kg_admin reindex 清理',
            });
        }

        const infoChecks = new Set(['self_loops', 'isolated_nodes']);
        for (const item of results) {
            const name = String(item.check);
            item.severity = infoChecks.has(name) || name.endsWith('_undeclared_attrs') ? 'info' : 'error';
        }

        const counts = await this.stats();
        const issues = results
            .filter((item) => item.severity === 'error' && Number(item.value) !== 0)
            .map((item) => String(item.check));
        return {
            ok: issues.length === 0,
            issues,
            checks: results,
            stats: counts,
            elapsedMs: Date.now() - started,
        };
    }

    // ─── 读查询 ────────────────────────────────────────────

    public async query(payload: Record<string, unknown>): Promise<DuckDbQueryResult> {
        const con = this.requireConnection();
        const { sql } = assertReadOnlySql(String(payload.sql ?? ''));
        const maxRows = clampInt(
            payload.maxRows,
            1,
            KG_LIMITS.queryRowsMax,
            KG_LIMITS.queryRowsDefault,
        );
        const params = this.normalizeParams(payload.params);
        const started = Date.now();

        const reader = await con.streamAndReadUntil(sql, maxRows + 1, params);
        try {
            const columns = reader.deduplicatedColumnNames();
            const allRows = reader.getRowObjectsJson() as Record<string, unknown>[];
            const truncated = allRows.length > maxRows;
            const rows = truncated ? allRows.slice(0, maxRows) : allRows;
            return {
                columns,
                rows,
                rowCount: rows.length,
                truncated,
                elapsedMs: Date.now() - started,
            };
        } finally {
            reader.closeSync();
        }
    }

    public async exportData(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        const con = this.requireConnection();
        const { sql } = assertReadOnlySql(String(payload.sql ?? ''));
        const outputPath = this.resolveWorkspaceFile(payload.outputPath, 'outputPath');
        const format = this.normalizeFormat(payload.format, ['csv', 'json', 'parquet']);
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        const options = format === 'csv' ? 'FORMAT CSV, HEADER' : `FORMAT ${format.toUpperCase()}`;
        const started = Date.now();
        await con.run(`COPY (${sql}) TO '${this.escapeLiteral(outputPath)}' (${options})`);
        return {
            outputPath,
            format,
            bytes: await this.fileSize(outputPath),
            elapsedMs: Date.now() - started,
        };
    }

    // ─── 写入 ──────────────────────────────────────────────

    public async upsert(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        const con = this.requireConnection();
        const nodes = this.validateNodes(payload.nodes);
        const edges = this.validateEdges(payload.edges);
        if (!nodes.length && !edges.length) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                'kg_upsert 至少需要 nodes 或 edges 之一。',
            );
        }
        if (nodes.length > KG_LIMITS.upsertBatchMax || edges.length > KG_LIMITS.upsertBatchMax) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.limitExceeded,
                `单次最多 ${KG_LIMITS.upsertBatchMax} 个节点 / 边；大批量请用 kg_import。`,
            );
        }

        const nodeDefs = nodes.length ? await this.loadAttrDefs('node') : [];
        const edgeDefs = edges.length ? await this.loadAttrDefs('edge') : [];
        const strict = payload.strictProps === true;
        const warnings: string[] = [];
        nodes.forEach((node: any, index: number) => {
            warnings.push(...this.validateItemProps('node', node.props, nodeDefs, `nodes[${index}]`, strict));
        });
        edges.forEach((edge: any, index: number) => {
            warnings.push(...this.validateItemProps('edge', edge.props, edgeDefs, `edges[${index}]`, strict));
        });
        warnings.push(...await this.validateVocabulary(nodes, edges, payload.strictSchema === true));
        await this.assertUniqueness(nodes, edges, nodeDefs.concat(edgeDefs));

        const started = Date.now();
        await con.run('BEGIN TRANSACTION');
        try {
            let changedNodes = 0;
            let changedEdges = 0;
            if (nodes.length) {
                const result = await con.run(NODE_UPSERT_SQL, [JSON.stringify(nodes)]);
                changedNodes = result.rowsChanged;
                await this.syncNodeAttrIndex(nodes.map((node: any) => node.id), nodeDefs);
                await this.syncIdentityIndex(nodes.map((node: any) => String(node.id)));
            }
            if (edges.length) {
                const result = await con.run(EDGE_UPSERT_SQL, [JSON.stringify(edges)]);
                changedEdges = result.rowsChanged;
                await this.syncEdgeAttrIndex(
                    edges.map((edge: any) => ({ src: edge.src, dst: edge.dst, type: edge.type })),
                    edgeDefs,
                );
            }
            await con.run('COMMIT');
            return {
                nodes: nodes.length,
                edges: edges.length,
                changedNodes,
                changedEdges,
                warnings: warnings.slice(0, 10),
                elapsedMs: Date.now() - started,
            };
        } catch (error) {
            await con.run('ROLLBACK').catch(() => undefined);
            throw error;
        }
    }

    public async deleteData(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        const con = this.requireConnection();
        const nodeIds = normalizeStringArray(payload.nodeIds, 'nodeIds', KG_LIMITS.upsertBatchMax);
        const nodeTypes = normalizeStringArray(payload.nodeTypes, 'nodeTypes');
        const edgeTypes = normalizeStringArray(payload.edgeTypes, 'edgeTypes');
        const edgeKeys = Array.isArray(payload.edgeKeys) ? payload.edgeKeys : [];
        const deleteAll = payload.all === true;
        const cascade = payload.cascade !== false;
        const confirm = payload.confirm === true;

        if (deleteAll && !confirm) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                '清空图谱需要 confirm: true。',
            );
        }
        if (!deleteAll && !nodeIds.length && !nodeTypes.length && !edgeTypes.length && !edgeKeys.length) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                'kg_delete 需要 nodeIds / nodeTypes / edgeTypes / edgeKeys 之一，或 all:true + confirm:true。',
            );
        }

        let changedNodes = 0;
        let changedEdges = 0;
        const started = Date.now();
        await con.run('BEGIN TRANSACTION');
        try {
            if (deleteAll) {
                await con.run('DELETE FROM kg_node_props');
                await con.run('DELETE FROM kg_edge_props');
                await con.run('DELETE FROM kg_identity');
                changedEdges = (await con.run('DELETE FROM kg_edges')).rowsChanged;
                changedNodes = (await con.run('DELETE FROM kg_nodes')).rowsChanged;
            } else {
                if (nodeIds.length) {
                    const json = jsonListParam(nodeIds);
                    await con.run(
                        `DELETE FROM kg_node_props WHERE node_id ${ID_LIST_PREDICATE}`,
                        [json],
                    );
                    await con.run(
                        `DELETE FROM kg_identity WHERE node_id ${ID_LIST_PREDICATE}`,
                        [json],
                    );
                    if (cascade) {
                        changedEdges += (await con.run(
                            `DELETE FROM kg_edges WHERE src ${ID_LIST_PREDICATE} OR dst ${ID_LIST_PREDICATE}`,
                            [json, json],
                        )).rowsChanged;
                    }
                    changedNodes += (await con.run(
                        `DELETE FROM kg_nodes WHERE id ${ID_LIST_PREDICATE}`,
                        [json],
                    )).rowsChanged;
                }
                if (nodeTypes.length) {
                    const json = jsonListParam(nodeTypes);
                    await con.run(
                        `DELETE FROM kg_node_props WHERE node_id IN (
                            SELECT id FROM kg_nodes WHERE type ${ID_LIST_PREDICATE}
                         )`,
                        [json],
                    );
                    await con.run(
                        `DELETE FROM kg_identity WHERE node_id IN (
                            SELECT id FROM kg_nodes WHERE type ${ID_LIST_PREDICATE}
                         )`,
                        [json],
                    );
                    if (cascade) {
                        changedEdges += (await con.run(
                            `DELETE FROM kg_edges WHERE src IN (
                                SELECT id FROM kg_nodes WHERE type ${ID_LIST_PREDICATE}
                             ) OR dst IN (
                                SELECT id FROM kg_nodes WHERE type ${ID_LIST_PREDICATE}
                             )`,
                            [json, json],
                        )).rowsChanged;
                    }
                    changedNodes += (await con.run(
                        `DELETE FROM kg_nodes WHERE type ${ID_LIST_PREDICATE}`,
                        [json],
                    )).rowsChanged;
                }
                if (edgeTypes.length) {
                    const json = jsonListParam(edgeTypes);
                    await con.run(
                        `DELETE FROM kg_edge_props WHERE type ${ID_LIST_PREDICATE}`,
                        [json],
                    );
                    changedEdges += (await con.run(
                        `DELETE FROM kg_edges WHERE type ${ID_LIST_PREDICATE}`,
                        [json],
                    )).rowsChanged;
                }
                if (edgeKeys.length) {
                    const normalized = edgeKeys.map((item: any, index: number) => {
                        if (!item || typeof item !== 'object') {
                            throw new DuckDbToolError(
                                DUCKDB_ERROR_CODES.invalidRequest,
                                `edgeKeys[${index}] 必须是 {src,dst,type} 对象。`,
                            );
                        }
                        return {
                            src: this.requireString(item.src, `edgeKeys[${index}].src`),
                            dst: this.requireString(item.dst, `edgeKeys[${index}].dst`),
                            type: this.requireString(item.type, `edgeKeys[${index}].type`),
                        };
                    });
                    const keyJson = JSON.stringify(normalized);
                    const matchedKeys = `SELECT json_extract_string(value, '$.src') AS src,
                                                json_extract_string(value, '$.dst') AS dst,
                                                json_extract_string(value, '$.type') AS type
                                         FROM json_each(?::JSON)`;
                    await con.run(
                        `DELETE FROM kg_edge_props p WHERE EXISTS (
                            SELECT 1 FROM (${matchedKeys}) k
                            WHERE p.src = k.src AND p.dst = k.dst AND p.type = k.type
                         )`,
                        [keyJson],
                    );
                    changedEdges += (await con.run(
                        `DELETE FROM kg_edges WHERE EXISTS (
                            SELECT 1 FROM (
                                SELECT json_extract_string(value, '$.src') AS src,
                                       json_extract_string(value, '$.dst') AS dst,
                                       json_extract_string(value, '$.type') AS type
                                FROM json_each(?::JSON)
                            ) k
                            WHERE kg_edges.src = k.src
                              AND kg_edges.dst = k.dst
                              AND kg_edges.type = k.type
                         )`,
                        [keyJson],
                    )).rowsChanged;
                }
            }
            await con.run('COMMIT');
        } catch (error) {
            await con.run('ROLLBACK').catch(() => undefined);
            throw error;
        }

        return { changedNodes, changedEdges, elapsedMs: Date.now() - started };
    }

    // ─── 图遍历与路径 ──────────────────────────────────────

    public async traverse(payload: Record<string, unknown>): Promise<DuckDbTraverseResult> {
        const con = this.requireConnection();
        const startIds = normalizeStringArray(payload.startIds, 'startIds', 200);
        if (!startIds.length) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, 'kg_traverse 需要 startIds。');
        }
        const depth = clampInt(
            payload.depth,
            1,
            KG_LIMITS.traverseDepthMax,
            KG_LIMITS.traverseDepthDefault,
        );
        const direction = this.normalizeDirection(payload.direction);
        const edgeTypes = normalizeStringArray(payload.edgeTypes, 'edgeTypes');
        const nodeTypes = normalizeStringArray(payload.nodeTypes, 'nodeTypes');
        const nodeFilterPredicates = normalizePredicates(payload.nodeFilter, 'nodeFilter');
        const edgeFilterPredicates = normalizePredicates(payload.edgeFilter, 'edgeFilter');
        const nodePropKeys = normalizePropKeys(payload.nodePropKeys, 'nodePropKeys');
        const edgePropKeys = normalizePropKeys(payload.edgePropKeys, 'edgePropKeys');
        const maxNodes = clampInt(
            payload.maxNodes,
            1,
            KG_LIMITS.traverseNodesMax,
            KG_LIMITS.traverseNodesDefault,
        );
        const maxEdges = clampInt(
            payload.maxEdges,
            1,
            KG_LIMITS.traverseEdgesMax,
            KG_LIMITS.traverseEdgesDefault,
        );
        const started = Date.now();

        // 参数必须按 SQL 文本中 ? 的出现顺序入队。
        const params: SqlParam[] = [];
        const edgeFiltersSql = (alias: string): string => {
            let sql = '';
            if (edgeTypes.length) {
                params.push(jsonListParam(edgeTypes));
                sql += ` AND ${alias}.type IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))`;
            }
            const attrSql = buildAttrPredicateSql(edgeFilterPredicates, alias, params);
            if (attrSql) sql += ` AND (${attrSql})`;
            return sql;
        };
        const nodeFilterSql = (alias: string): string => {
            const attrSql = buildAttrPredicateSql(nodeFilterPredicates, alias, params);
            return attrSql ? ` AND (${attrSql})` : '';
        };

        const buildWalkCte = (name: 'walk_out' | 'walk_in'): string => {
            const outward = name === 'walk_out';
            params.push(jsonListParam(startIds));
            const filters = edgeFiltersSql('e') + nodeFilterSql('nn');
            const nextExpr = outward ? 'e.dst' : 'e.src';
            const joinColumn = outward ? 'e.src' : 'e.dst';
            const nodeJoin = nodeFilterPredicates.length ? `JOIN kg_nodes nn ON nn.id = ${nextExpr}` : '';
            return `${name}(id, depth) AS (
                SELECT json_extract_string(value, '$') AS id, 0 AS depth FROM json_each(?::JSON)
                UNION
                SELECT ${nextExpr}, ${name}.depth + 1
                FROM ${name} JOIN kg_edges e ON ${joinColumn} = ${name}.id
                ${nodeJoin}
                WHERE ${name}.depth < ${depth}${filters}
            )`;
        };

        let cteSql: string;
        let unionSql: string;
        if (direction === 'both') {
            // 真正的无向可达性：同一层内既走 src→dst 也走 dst→src，
            // LATERAL + 两个索引友好的分支比 OR 连接更快（1M 边实测约 100ms/3 跳）。
            params.push(jsonListParam(startIds));
            const outFilters = edgeFiltersSql('e');
            const inFilters = edgeFiltersSql('e');
            const nodeJoin = nodeFilterPredicates.length ? 'JOIN kg_nodes nn ON nn.id = nb.next_id' : '';
            const nodeFilters = nodeFilterSql('nn');
            cteSql = `WITH RECURSIVE walk(id, depth) AS (
                SELECT json_extract_string(value, '$') AS id, 0 AS depth FROM json_each(?::JSON)
                UNION
                SELECT nb.next_id, walk.depth + 1
                FROM walk, LATERAL (
                    SELECT e.dst AS next_id FROM kg_edges e WHERE e.src = walk.id${outFilters}
                    UNION ALL
                    SELECT e.src AS next_id FROM kg_edges e WHERE e.dst = walk.id${inFilters}
                ) nb
                ${nodeJoin}
                WHERE walk.depth < ${depth}${nodeFilters}
            )`;
            unionSql = 'SELECT id, depth FROM walk';
        } else if (direction === 'out') {
            cteSql = `WITH RECURSIVE ${buildWalkCte('walk_out')}`;
            unionSql = 'SELECT id, depth FROM walk_out';
        } else {
            cteSql = `WITH RECURSIVE ${buildWalkCte('walk_in')}`;
            unionSql = 'SELECT id, depth FROM walk_in';
        }

        try {
            await con.run(
                `CREATE OR REPLACE TEMP TABLE kg_walk AS
                 ${cteSql}
                 SELECT id, MIN(depth) AS depth FROM (${unionSql}) w GROUP BY id`,
                params,
            );

            let viewSql = 'SELECT id, depth FROM kg_walk';
            if (nodeTypes.length) {
                viewSql = `SELECT w.id, w.depth FROM kg_walk w
                           JOIN kg_nodes n ON n.id = w.id
                           WHERE n.type IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))`;
            }
            await con.run(
                `CREATE OR REPLACE TEMP TABLE kg_walk_view AS ${viewSql}`,
                nodeTypes.length ? [jsonListParam(nodeTypes)] : [],
            );

            const totalNodes = Number(await this.scalar('SELECT count(*)::BIGINT AS c FROM kg_walk') || 0);
            const viewNodes = Number(await this.scalar('SELECT count(*)::BIGINT AS c FROM kg_walk_view') || 0);

            const nodePropsExpr = this.buildPropsProjection('n', nodePropKeys);
            const nodeRows = this.parsePropsRows(await this.rows(
                `SELECT n.id, n.type, n.name${nodePropsExpr}, v.depth
                 FROM kg_walk_view v JOIN kg_nodes n ON n.id = v.id
                 ORDER BY v.depth, n.id
                 LIMIT ?`,
                [maxNodes],
            ));

            const edgeResultParams: SqlParam[] = [];
            let edgeResultFilter = '';
            if (edgeTypes.length) {
                edgeResultParams.push(jsonListParam(edgeTypes));
                edgeResultFilter += ` AND e.type IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))`;
            }
            const edgeAttrSql = buildAttrPredicateSql(edgeFilterPredicates, 'e', edgeResultParams);
            if (edgeAttrSql) edgeResultFilter += ` AND (${edgeAttrSql})`;

            const totalEdges = Number(await this.scalar(
                `SELECT count(*)::BIGINT AS c FROM kg_edges e
                 JOIN kg_walk_view s ON s.id = e.src
                 JOIN kg_walk_view t ON t.id = e.dst
                 WHERE 1 = 1${edgeResultFilter}`,
                edgeResultParams,
            ) || 0);
            const edgePropsExpr = this.buildPropsProjection('e', edgePropKeys);
            const edgeRows = this.parsePropsRows(await this.rows(
                `SELECT e.src, e.dst, e.type, e.weight${edgePropsExpr}
                 FROM kg_edges e
                 JOIN kg_walk_view s ON s.id = e.src
                 JOIN kg_walk_view t ON t.id = e.dst
                 WHERE 1 = 1${edgeResultFilter}
                 ORDER BY e.src, e.dst, e.type
                 LIMIT ?`,
                [...edgeResultParams, maxEdges],
            ));

            return {
                startIds,
                depth,
                direction,
                nodes: nodeRows,
                edges: edgeRows,
                totalNodes: viewNodes,
                walkNodes: totalNodes,
                totalEdges,
                truncated: viewNodes > nodeRows.length || totalEdges > edgeRows.length,
                elapsedMs: Date.now() - started,
            };
        } finally {
            await con.run('DROP TABLE IF EXISTS kg_walk').catch(() => undefined);
            await con.run('DROP TABLE IF EXISTS kg_walk_view').catch(() => undefined);
        }
    }

    private buildPropsProjection(alias: string, keys: string[]): string {
        if (!keys.length) return '';
        const pairs = keys.map((key) => `'${key}', json_extract(${alias}.props, '$."${key}"')`);
        return `, json_strip_nulls(json_object(${pairs.join(', ')})) AS props`;
    }

    /** DuckDB 的 JSON 列以 VARCHAR 返回，这里统一转成对象，避免工具层拿到 JSON 文本。 */
    private parsePropsRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
        for (const row of rows) {
            if (typeof row.props !== 'string') continue;
            try {
                row.props = JSON.parse(row.props);
            } catch {
                // 非 JSON 文本（历史脏数据）保持原样
            }
        }
        return rows;
    }

    public async findPaths(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        const con = this.requireConnection();
        const from = this.requireString(payload.from, 'from');
        const to = this.requireString(payload.to, 'to');
        const maxDepth = clampInt(
            payload.maxDepth,
            1,
            KG_LIMITS.pathDepthMax,
            KG_LIMITS.pathDepthDefault,
        );
        const maxPaths = clampInt(
            payload.maxPaths,
            1,
            KG_LIMITS.pathResultsMax,
            KG_LIMITS.pathResultsDefault,
        );
        const direction = this.normalizeDirection(payload.direction ?? 'out');
        const edgeTypes = normalizeStringArray(payload.edgeTypes, 'edgeTypes');
        const globalNodeFilter = normalizePredicates(payload.nodeFilter, 'nodeFilter');
        const globalEdgeFilter = normalizePredicates(payload.edgeFilter, 'edgeFilter');
        const hopFilters = this.normalizeHopFilters(payload.hopFilters);
        const nodePropKeys = normalizePropKeys(payload.nodePropKeys, 'nodePropKeys');
        const edgePropKeys = normalizePropKeys(payload.edgePropKeys, 'edgePropKeys');
        const started = Date.now();

        if (from === to) {
            return {
                from, to, direction,
                paths: [{ nodes: [from], edges: [], length: 0 }],
                nodes: await this.nodeDetails([from], nodePropKeys),
                edges: [],
                truncated: false,
                elapsedMs: Date.now() - started,
            };
        }

        try {
            await con.run(
                `CREATE OR REPLACE TEMP TABLE kg_path_visited (
                    id VARCHAR, depth INTEGER, parent VARCHAR,
                    via_src VARCHAR, via_dst VARCHAR, via_type VARCHAR
                 )`,
            );
            await con.run('CREATE OR REPLACE TEMP TABLE kg_path_frontier AS SELECT ?::VARCHAR AS id', [from]);
            await con.run(
                'INSERT INTO kg_path_visited VALUES (?, 0, NULL, NULL, NULL, NULL)',
                [from],
            );

            let foundDepth = -1;
            for (let depth = 1; depth <= maxDepth; depth++) {
                const hop = hopFilters[depth - 1];
                const nodePredicates = [...globalNodeFilter, ...(hop?.nodeFilter || [])];
                const edgePredicates = [...globalEdgeFilter, ...(hop?.edgeFilter || [])];
                const params: SqlParam[] = [];

                let nextExpr: string;
                let viaSelect: string;
                let fromSql: string;
                let filters = '';
                if (direction === 'both') {
                    const outFilters = this.buildEdgeFilterClause(edgeTypes, edgePredicates, 'e', params);
                    const inFilters = this.buildEdgeFilterClause(edgeTypes, edgePredicates, 'e', params);
                    nextExpr = 'nb.next_id';
                    viaSelect = 'nb.via_src AS via_src, nb.via_dst AS via_dst, nb.via_type AS via_type';
                    fromSql = `kg_path_frontier f, LATERAL (
                        SELECT e.dst AS next_id, e.src AS via_src, e.dst AS via_dst, e.type AS via_type
                        FROM kg_edges e WHERE e.src = f.id${outFilters}
                        UNION ALL
                        SELECT e.src AS next_id, e.src AS via_src, e.dst AS via_dst, e.type AS via_type
                        FROM kg_edges e WHERE e.dst = f.id${inFilters}
                    ) nb`;
                    if (nodePredicates.length) {
                        fromSql += ' JOIN kg_nodes nn ON nn.id = nb.next_id';
                    }
                    filters += this.buildNodeFilterClause(nodePredicates, 'nn', params);
                } else {
                    const outward = direction === 'out';
                    nextExpr = outward ? 'e.dst' : 'e.src';
                    viaSelect = 'e.src AS via_src, e.dst AS via_dst, e.type AS via_type';
                    fromSql = `kg_path_frontier f JOIN kg_edges e ON ${outward ? 'e.src' : 'e.dst'} = f.id`;
                    if (nodePredicates.length) {
                        fromSql += ` JOIN kg_nodes nn ON nn.id = ${nextExpr}`;
                    }
                    filters += this.buildEdgeFilterClause(edgeTypes, edgePredicates, 'e', params);
                    filters += this.buildNodeFilterClause(nodePredicates, 'nn', params);
                }

                await con.run(
                    `CREATE OR REPLACE TEMP TABLE kg_path_next AS
                     SELECT DISTINCT ${nextExpr} AS id, f.id AS parent, ${viaSelect}
                     FROM ${fromSql}
                     WHERE ${nextExpr} IS NOT NULL${filters}
                       AND NOT EXISTS (
                           SELECT 1 FROM kg_path_visited v WHERE v.id = ${nextExpr}
                       )`,
                    params,
                );
                const added = Number(await this.scalar(
                    'SELECT count(*)::BIGINT AS c FROM kg_path_next',
                ) || 0);
                if (added === 0) break;
                await con.run(
                    `INSERT INTO kg_path_visited
                     SELECT id, ${depth}, parent, via_src, via_dst, via_type FROM kg_path_next`,
                );
                const hit = Number(await this.scalar(
                    'SELECT count(*)::BIGINT AS c FROM kg_path_next WHERE id = ?',
                    [to],
                ) || 0);
                if (hit > 0) {
                    foundDepth = depth;
                    break;
                }
                await con.run(
                    'CREATE OR REPLACE TEMP TABLE kg_path_frontier AS SELECT DISTINCT id FROM kg_path_next',
                );
            }

            if (foundDepth < 0) {
                return {
                    from, to, direction, paths: [], nodes: [], edges: [],
                    maxDepth, truncated: false, elapsedMs: Date.now() - started,
                };
            }

            const visitedRows = await this.rows(
                `SELECT id, depth, parent, via_src, via_dst, via_type
                 FROM kg_path_visited WHERE depth <= ?`,
                [foundDepth],
            );
            type Step = { parent: string; via_src: string; via_dst: string; via_type: string };
            const steps = new Map<string, Map<number, Step[]>>();
            for (const row of visitedRows) {
                const id = String((row as any).id);
                const depth = Number((row as any).depth);
                const parent = (row as any).parent == null ? null : String((row as any).parent);
                if (!parent) continue;
                if (!steps.has(id)) steps.set(id, new Map());
                const byDepth = steps.get(id)!;
                if (!byDepth.has(depth)) byDepth.set(depth, []);
                byDepth.get(depth)!.push({
                    parent,
                    via_src: String((row as any).via_src),
                    via_dst: String((row as any).via_dst),
                    via_type: String((row as any).via_type),
                });
            }

            const paths: { nodes: string[]; edges: { src: string; dst: string; type: string }[]; length: number }[] = [];
            const reconstruct = (
                node: string,
                depth: number,
                nodesSuffix: string[],
                edgesSuffix: { src: string; dst: string; type: string }[],
            ) => {
                if (paths.length >= maxPaths) return;
                if (depth === 0) {
                    paths.push({ nodes: [node, ...nodesSuffix], edges: edgesSuffix, length: foundDepth });
                    return;
                }
                const candidates = steps.get(node)?.get(depth);
                if (!candidates) return;
                for (const step of candidates) {
                    reconstruct(
                        step.parent,
                        depth - 1,
                        [node, ...nodesSuffix],
                        [{ src: step.via_src, dst: step.via_dst, type: step.via_type }, ...edgesSuffix],
                    );
                    if (paths.length >= maxPaths) return;
                }
            };
            reconstruct(to, foundDepth, [], []);

            const ids = Array.from(new Set(paths.flatMap((item) => item.nodes)));
            const allEdges = paths.flatMap((item) => item.edges);
            return {
                from, to, direction, maxDepth,
                paths,
                nodes: await this.nodeDetails(ids, nodePropKeys),
                edges: await this.edgeDetails(allEdges, edgePropKeys),
                truncated: paths.length >= maxPaths,
                elapsedMs: Date.now() - started,
            };
        } finally {
            await con.run('DROP TABLE IF EXISTS kg_path_visited').catch(() => undefined);
            await con.run('DROP TABLE IF EXISTS kg_path_frontier').catch(() => undefined);
            await con.run('DROP TABLE IF EXISTS kg_path_next').catch(() => undefined);
        }
    }

    private normalizeHopFilters(
        value: unknown,
    ): { nodeFilter: AttrPredicate[]; edgeFilter: AttrPredicate[] }[] {
        if (value === undefined || value === null) return [];
        if (!Array.isArray(value)) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, 'hopFilters 必须是数组（按跳顺序）。');
        }
        if (value.length > KG_LIMITS.pathDepthMax) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.limitExceeded,
                `hopFilters 最多 ${KG_LIMITS.pathDepthMax} 项。`,
            );
        }
        return value.map((item: any, index: number) => ({
            nodeFilter: normalizePredicates(item?.nodeFilter, `hopFilters[${index}].nodeFilter`),
            edgeFilter: normalizePredicates(item?.edgeFilter, `hopFilters[${index}].edgeFilter`),
        }));
    }

    private buildEdgeFilterClause(
        edgeTypes: string[],
        predicates: AttrPredicate[],
        alias: string,
        params: SqlParam[],
    ): string {
        let sql = '';
        if (edgeTypes.length) {
            params.push(jsonListParam(edgeTypes));
            sql += ` AND ${alias}.type IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))`;
        }
        const attrSql = buildAttrPredicateSql(predicates, alias, params);
        if (attrSql) sql += ` AND (${attrSql})`;
        return sql;
    }

    private buildNodeFilterClause(
        predicates: AttrPredicate[],
        alias: string,
        params: SqlParam[],
    ): string {
        const sql = buildAttrPredicateSql(predicates, alias, params);
        return sql ? ` AND (${sql})` : '';
    }

    // ─── 分析算法 ──────────────────────────────────────────

    public async analyze(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        const algorithm = String(payload.algorithm || '').trim().toLowerCase();
        const topN = clampInt(
            payload.topN,
            1,
            KG_LIMITS.analysisTopMax,
            KG_LIMITS.analysisTopDefault,
        );
        const iterations = clampInt(
            payload.iterations,
            1,
            KG_LIMITS.iterationsMax,
            KG_LIMITS.iterationsDefault,
        );
        const persist = payload.persist === true;

        switch (algorithm) {
            case 'summary': return await this.analyzeSummary(topN);
            case 'degree': return await this.analyzeDegree(topN, persist);
            case 'pagerank': return await this.analyzePageRank(topN, iterations, persist, payload);
            case 'components': return await this.analyzeComponents(topN, iterations, persist);
            case 'communities': return await this.analyzeCommunities(topN, iterations, persist);
            default:
                throw new DuckDbToolError(
                    DUCKDB_ERROR_CODES.invalidRequest,
                    'algorithm 只支持 summary / degree / pagerank / components / communities。',
                );
        }
    }

    private async analyzeSummary(topN: number): Promise<Record<string, unknown>> {
        const overview = await this.rows(
            `SELECT (SELECT count(*)::BIGINT FROM kg_nodes) AS nodes,
                    (SELECT count(*)::BIGINT FROM kg_edges) AS edges,
                    (SELECT count(*)::BIGINT FROM (
                        SELECT src AS id FROM kg_edges UNION SELECT dst FROM kg_edges
                    )) AS active_nodes`,
        );
        const nodeTypes = await this.rows(
            `SELECT type, count(*)::BIGINT AS count FROM kg_nodes
             GROUP BY type ORDER BY count DESC, type LIMIT ?`,
            [topN],
        );
        const edgeTypes = await this.rows(
            `SELECT type, count(*)::BIGINT AS count FROM kg_edges
             GROUP BY type ORDER BY count DESC, type LIMIT ?`,
            [topN],
        );
        const nodes = Number(overview[0]?.nodes ?? 0);
        const edges = Number(overview[0]?.edges ?? 0);
        const activeNodes = Number(overview[0]?.active_nodes ?? 0);
        return {
            nodes,
            edges,
            activeNodes,
            isolatedNodes: Math.max(0, nodes - activeNodes),
            avgDegree: nodes > 0 ? (2 * edges) / nodes : 0,
            nodeTypes,
            edgeTypes,
            stats: await this.stats(),
        };
    }

    private async analyzeDegree(topN: number, persist: boolean): Promise<Record<string, unknown>> {
        const started = Date.now();
        const rows = await this.rows(
            `WITH deg AS (
                SELECT src AS id, count(*)::BIGINT AS out_degree, 0::BIGINT AS in_degree
                FROM kg_edges GROUP BY src
                UNION ALL
                SELECT dst, 0::BIGINT, count(*)::BIGINT FROM kg_edges GROUP BY dst
             )
             SELECT n.id, n.type, n.name,
                    sum(deg.out_degree)::BIGINT AS out_degree,
                    sum(deg.in_degree)::BIGINT AS in_degree,
                    (sum(deg.out_degree) + sum(deg.in_degree))::BIGINT AS degree
             FROM kg_nodes n JOIN deg ON deg.id = n.id
             GROUP BY n.id, n.type, n.name
             ORDER BY degree DESC, n.id
             LIMIT ?`,
            [topN],
        );
        if (persist) {
            const all = await this.rows(
                `WITH deg AS (
                    SELECT src AS id, count(*)::BIGINT AS out_degree, 0::BIGINT AS in_degree
                    FROM kg_edges GROUP BY src
                    UNION ALL
                    SELECT dst, 0::BIGINT, count(*)::BIGINT FROM kg_edges GROUP BY dst
                 )
                 SELECT id, (sum(out_degree) + sum(in_degree))::DOUBLE AS value
                 FROM deg GROUP BY id`,
            );
            await this.persistMetric(
                'degree',
                all.map((row: any) => ({ id: String(row.id), value: Number(row.value) || 0 })),
            );
        }
        return { algorithm: 'degree', top: rows, persisted: persist, elapsedMs: Date.now() - started };
    }

    private async analyzePageRank(
        topN: number,
        iterations: number,
        persist: boolean,
        payload: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
        const con = this.requireConnection();
        const damping = Math.min(0.99, Math.max(0.1, Number(payload.damping) || 0.85));
        const tolerance = Math.min(1, Math.max(1e-12, Number(payload.tolerance) || 1e-6));
        const started = Date.now();
        const nodeCount = Number(await this.scalar('SELECT count(*)::BIGINT AS c FROM kg_nodes') || 0);
        if (nodeCount === 0) {
            return { algorithm: 'pagerank', top: [], iterations: 0, converged: true, elapsedMs: 0 };
        }

        await con.run(
            `CREATE OR REPLACE TEMP TABLE kg_pr AS
             SELECT id, 1.0::DOUBLE / ${nodeCount} AS value FROM kg_nodes`,
        );

        let completed = 0;
        let converged = false;
        let maxDelta = Number.POSITIVE_INFINITY;
        try {
            for (let i = 0; i < iterations; i++) {
                await con.run(
                    `CREATE OR REPLACE TEMP TABLE kg_pr_next AS
                     WITH od AS (
                        SELECT src AS id, count(*)::DOUBLE AS c FROM kg_edges GROUP BY src
                     ),
                     dangling AS (
                        SELECT COALESCE(sum(p.value), 0)::DOUBLE AS s
                        FROM kg_pr p LEFT JOIN od ON od.id = p.id WHERE od.id IS NULL
                     ),
                     contrib AS (
                        SELECT e.dst AS id, sum(p.value / od.c)::DOUBLE AS s
                        FROM kg_edges e
                        JOIN kg_pr p ON p.id = e.src
                        JOIN od ON od.id = e.src
                        GROUP BY e.dst
                     )
                     SELECT n.id,
                            (1.0 - ${damping}) / ${nodeCount}
                            + ${damping} * (COALESCE(c.s, 0) + (SELECT s FROM dangling) / ${nodeCount}) AS value
                     FROM kg_nodes n LEFT JOIN contrib c ON c.id = n.id`,
                );
                maxDelta = Number(await this.scalar(
                    `SELECT COALESCE(max(abs(next.value - cur.value)), 0)::DOUBLE AS d
                     FROM kg_pr_next next JOIN kg_pr cur ON cur.id = next.id`,
                ) || 0);
                await con.run('CREATE OR REPLACE TEMP TABLE kg_pr AS SELECT * FROM kg_pr_next');
                completed = i + 1;
                if (maxDelta <= tolerance) {
                    converged = true;
                    break;
                }
            }

            const top = await this.rows(
                `SELECT p.id, n.type, n.name, round(p.value, 10) AS score
                 FROM kg_pr p LEFT JOIN kg_nodes n ON n.id = p.id
                 ORDER BY p.value DESC, p.id LIMIT ?`,
                [topN],
            );
            if (persist) {
                const all = await this.rows('SELECT id, value FROM kg_pr');
                await this.persistMetric(
                    'pagerank',
                    all.map((row: any) => ({ id: String(row.id), value: Number(row.value) || 0 })),
                );
            }
            return {
                algorithm: 'pagerank',
                top,
                iterations: completed,
                converged,
                maxDelta,
                damping,
                persisted: persist,
                elapsedMs: Date.now() - started,
            };
        } finally {
            await con.run('DROP TABLE IF EXISTS kg_pr').catch(() => undefined);
            await con.run('DROP TABLE IF EXISTS kg_pr_next').catch(() => undefined);
        }
    }

    private async analyzeComponents(
        topN: number,
        iterations: number,
        persist: boolean,
    ): Promise<Record<string, unknown>> {
        const con = this.requireConnection();
        const started = Date.now();
        const nodeCount = Number(await this.scalar('SELECT count(*)::BIGINT AS c FROM kg_nodes') || 0);
        if (nodeCount === 0) {
            return { algorithm: 'components', components: 0, top: [], iterations: 0, elapsedMs: 0 };
        }
        await con.run(
            'CREATE OR REPLACE TEMP TABLE kg_comp AS SELECT id, id AS label FROM kg_nodes',
        );
        let completed = 0;
        let changed = 0;
        try {
            for (let i = 0; i < iterations; i++) {
                await con.run(
                    `CREATE OR REPLACE TEMP TABLE kg_comp_next AS
                     WITH nb AS (
                        SELECT e.src AS id, c.label AS label
                        FROM kg_edges e JOIN kg_comp c ON c.id = e.dst
                        UNION ALL
                        SELECT e.dst AS id, c.label AS label
                        FROM kg_edges e JOIN kg_comp c ON c.id = e.src
                     ),
                     m AS (SELECT id, min(label) AS label FROM nb GROUP BY id)
                     SELECT c.id, least(c.label, COALESCE(m.label, c.label)) AS label
                     FROM kg_comp c LEFT JOIN m ON m.id = c.id`,
                );
                changed = Number(await this.scalar(
                    `SELECT count(*)::BIGINT AS c FROM kg_comp_next n
                     JOIN kg_comp c ON c.id = n.id WHERE n.label <> c.label`,
                ) || 0);
                await con.run('CREATE OR REPLACE TEMP TABLE kg_comp AS SELECT * FROM kg_comp_next');
                completed = i + 1;
                if (changed === 0) break;
            }
            const top = await this.rows(
                `SELECT label AS component_id, count(*)::BIGINT AS size
                 FROM kg_comp GROUP BY label ORDER BY size DESC, label LIMIT ?`,
                [topN],
            );
            const componentCount = Number(await this.scalar(
                'SELECT count(DISTINCT label)::BIGINT AS c FROM kg_comp',
            ) || 0);
            if (persist) {
                const all = await this.rows('SELECT id, label FROM kg_comp');
                await this.persistMetric(
                    'component',
                    all.map((row: any) => ({ id: String(row.id), label: String(row.label) })),
                );
            }
            return {
                algorithm: 'components',
                components: componentCount,
                top,
                iterations: completed,
                converged: changed === 0,
                persisted: persist,
                elapsedMs: Date.now() - started,
            };
        } finally {
            await con.run('DROP TABLE IF EXISTS kg_comp').catch(() => undefined);
            await con.run('DROP TABLE IF EXISTS kg_comp_next').catch(() => undefined);
        }
    }

    private async analyzeCommunities(
        topN: number,
        iterations: number,
        persist: boolean,
    ): Promise<Record<string, unknown>> {
        const con = this.requireConnection();
        const started = Date.now();
        const nodeCount = Number(await this.scalar('SELECT count(*)::BIGINT AS c FROM kg_nodes') || 0);
        if (nodeCount === 0) {
            return { algorithm: 'communities', communities: 0, top: [], iterations: 0, elapsedMs: 0 };
        }
        await con.run(
            'CREATE OR REPLACE TEMP TABLE kg_comm AS SELECT id, id AS label FROM kg_nodes',
        );
        let completed = 0;
        let changed = 0;
        try {
            for (let i = 0; i < iterations; i++) {
                await con.run(
                    `CREATE OR REPLACE TEMP TABLE kg_comm_next AS
                     WITH nb AS (
                        SELECT e.src AS id, c.label AS label
                        FROM kg_edges e JOIN kg_comm c ON c.id = e.dst
                        UNION ALL
                        SELECT e.dst AS id, c.label AS label
                        FROM kg_edges e JOIN kg_comm c ON c.id = e.src
                     ),
                     cnt AS (
                        SELECT id, label, count(*)::BIGINT AS weight,
                               row_number() OVER (PARTITION BY id ORDER BY count(*) DESC, label) AS rn
                        FROM nb GROUP BY id, label
                     )
                     SELECT c.id, COALESCE(cnt.label, c.label) AS label
                     FROM kg_comm c LEFT JOIN cnt ON cnt.id = c.id AND cnt.rn = 1`,
                );
                changed = Number(await this.scalar(
                    `SELECT count(*)::BIGINT AS c FROM kg_comm_next n
                     JOIN kg_comm c ON c.id = n.id WHERE n.label <> c.label`,
                ) || 0);
                await con.run('CREATE OR REPLACE TEMP TABLE kg_comm AS SELECT * FROM kg_comm_next');
                completed = i + 1;
                if (changed === 0) break;
            }
            const top = await this.rows(
                `SELECT label AS community_id, count(*)::BIGINT AS size
                 FROM kg_comm GROUP BY label ORDER BY size DESC, label LIMIT ?`,
                [topN],
            );
            const communityCount = Number(await this.scalar(
                'SELECT count(DISTINCT label)::BIGINT AS c FROM kg_comm',
            ) || 0);
            if (persist) {
                const all = await this.rows('SELECT id, label FROM kg_comm');
                await this.persistMetric(
                    'community',
                    all.map((row: any) => ({ id: String(row.id), label: String(row.label) })),
                );
            }
            return {
                algorithm: 'communities',
                communities: communityCount,
                top,
                iterations: completed,
                converged: changed === 0,
                persisted: persist,
                elapsedMs: Date.now() - started,
            };
        } finally {
            await con.run('DROP TABLE IF EXISTS kg_comm').catch(() => undefined);
            await con.run('DROP TABLE IF EXISTS kg_comm_next').catch(() => undefined);
        }
    }

    private async persistMetric(
        metric: string,
        entries: { id: string; value?: number; label?: string }[],
    ): Promise<void> {
        const con = this.requireConnection();
        await con.run('BEGIN TRANSACTION');
        try {
            await con.run('DELETE FROM kg_metrics WHERE metric = ?', [metric]);
            for (let i = 0; i < entries.length; i += KG_LIMITS.upsertChunkSize) {
                const chunk = entries.slice(i, i + KG_LIMITS.upsertChunkSize);
                await con.run(
                    `INSERT INTO kg_metrics (node_id, metric, value, label)
                     SELECT json_extract_string(j.value, '$.id'), ?,
                            CAST(json_extract_string(j.value, '$.value') AS DOUBLE),
                            json_extract_string(j.value, '$.label')
                     FROM json_each(?::JSON) AS j`,
                    [metric, JSON.stringify(chunk)],
                );
            }
            await con.run('COMMIT');
        } catch (error) {
            await con.run('ROLLBACK').catch(() => undefined);
            throw error;
        }
    }

    // ─── 属性规范与索引 ────────────────────────────────────

    private async loadAttrDefs(scope?: AttrScope): Promise<AttributeDefinition[]> {
        const columns = 'scope, key, value_type, description, required, indexed, enum_values, domain, unique_value, identity';
        const rows = scope
            ? await this.rows(
                `SELECT ${columns} FROM kg_attr_defs WHERE scope = ? ORDER BY key`,
                [scope],
            )
            : await this.rows(
                `SELECT ${columns} FROM kg_attr_defs ORDER BY scope, key`,
            );
        return rows.map((row: any) => ({
            scope: String(row.scope) as AttrScope,
            key: String(row.key),
            value_type: String(row.value_type) as AttrType,
            description: row.description == null ? null : String(row.description),
            required: Boolean(row.required),
            indexed: Boolean(row.indexed),
            unique_value: Boolean(row.unique_value),
            identity: Boolean(row.identity),
            domain: row.domain == null
                ? null
                : (typeof row.domain === 'string' ? JSON.parse(row.domain) : row.domain) as string[],
            enum_values: row.enum_values == null
                ? null
                : (typeof row.enum_values === 'string'
                    ? JSON.parse(row.enum_values)
                    : row.enum_values) as string[],
        }));
    }

    private attrIndexExpressions(def: AttributeDefinition): { text: string; num: string; present: string } {
        const path = `'$."${def.key}"'`;
        const text = `json_extract_string(props, ${path})`;
        switch (def.value_type) {
            case 'number':
                return {
                    text,
                    num: `TRY_CAST(${text} AS DOUBLE)`,
                    present: `TRY_CAST(${text} AS DOUBLE) IS NOT NULL`,
                };
            case 'boolean':
                return {
                    text: `lower(${text})`,
                    num: `CASE lower(${text}) WHEN 'true' THEN 1.0 WHEN 'false' THEN 0.0 END`,
                    present: `lower(${text}) IN ('true', 'false')`,
                };
            case 'date':
                return {
                    text,
                    num: `epoch_ms(TRY_CAST(${text} AS TIMESTAMP))`,
                    present: `TRY_CAST(${text} AS TIMESTAMP) IS NOT NULL`,
                };
            default:
                return { text, num: 'NULL::DOUBLE', present: `${text} IS NOT NULL` };
        }
    }

    private attrIndexTable(scope: AttrScope): string {
        return scope === 'node' ? 'kg_node_props' : 'kg_edge_props';
    }

    /**
     * 整表重建某 scope 的属性索引。
     *
     * 逐 key `DELETE + INSERT` 会在带主键/二级索引的表上产生海量行级墓碑，commit 时
     * 触发全库 checkpoint（百万级实测单属性 20s+）。这里改为「删表 → 建表 → 单次
     * 批量 INSERT」，只写一次、无墓碑，百万级可降到秒级。
     */
    private async rebuildScopeIndex(scope: AttrScope): Promise<number> {
        const con = this.requireConnection();
        const defs = (await this.loadAttrDefs(scope))
            .filter((def) => def.indexed && def.value_type !== 'json');
        const table = this.attrIndexTable(scope);
        const ddl = scope === 'node' ? NODE_PROPS_DDL : EDGE_PROPS_DDL;
        const indexDdl = scope === 'node'
            ? [
                'CREATE INDEX IF NOT EXISTS idx_kg_node_props_text ON kg_node_props(key, val_text)',
                'CREATE INDEX IF NOT EXISTS idx_kg_node_props_num ON kg_node_props(key, val_num)',
            ]
            : [
                'CREATE INDEX IF NOT EXISTS idx_kg_edge_props_text ON kg_edge_props(key, val_text)',
                'CREATE INDEX IF NOT EXISTS idx_kg_edge_props_num ON kg_edge_props(key, val_num)',
            ];
        const selects = defs.map((def) => {
            const expressions = this.attrIndexExpressions(def);
            const keyLiteral = `'${this.escapeLiteral(def.key)}'`;
            return scope === 'node'
                ? `SELECT id AS node_id, ${keyLiteral} AS key, ${expressions.text} AS val_text,
                          ${expressions.num} AS val_num FROM kg_nodes WHERE ${expressions.present}`
                : `SELECT src, dst, type, ${keyLiteral} AS key, ${expressions.text} AS val_text,
                          ${expressions.num} AS val_num FROM kg_edges WHERE ${expressions.present}`;
        });

        await con.run('BEGIN TRANSACTION');
        try {
            await con.run(`DROP TABLE IF EXISTS ${table}`);
            await con.run(ddl);
            for (const ddlIndex of indexDdl) await con.run(ddlIndex);
            let rows = 0;
            if (selects.length) {
                rows = (await con.run(
                    `INSERT INTO ${table} ${selects.join(' UNION ALL ')}`,
                )).rowsChanged;
            }
            await con.run('COMMIT');
            return rows;
        } catch (error) {
            await con.run('ROLLBACK').catch(() => undefined);
            throw error;
        }
    }

    public async defineAttribute(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        const con = this.requireConnection();
        const scope = assertAttrScope(payload.scope);
        const key = assertAttrKey(payload.key);
        const existing = (await this.loadAttrDefs(scope)).find((item) => item.key === key);

        const valueType = assertAttrType(
            payload.type ?? payload.value_type ?? existing?.value_type,
        );
        const uniqueValue = payload.unique === undefined
            ? Boolean(existing?.unique_value)
            : payload.unique === true;
        const identity = payload.identity === undefined
            ? Boolean(existing?.identity)
            : payload.identity === true;
        if (identity && scope !== 'node') {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                '只有节点属性可声明 identity（实体自然键）；关系唯一性由 (src,dst,type) 主键保证。',
            );
        }
        const indexedRequested = payload.indexed === undefined
            ? Boolean(existing?.indexed)
            : payload.indexed === true;
        // 唯一性/身份键必须可检索，否则无法在写入时校验。
        const indexed = indexedRequested || uniqueValue || identity;
        if (indexed && valueType === 'json') {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                'json 类型属性不支持索引；如需检索请改用 string/number/boolean/date。',
            );
        }
        const required = payload.required === undefined
            ? Boolean(existing?.required)
            : payload.required === true;
        const description = payload.description === undefined
            ? (existing?.description ?? null)
            : (payload.description == null ? null : String(payload.description).slice(0, 500));
        const enumValues = payload.enum === undefined
            ? (existing && existing.value_type === valueType ? existing.enum_values ?? null : null)
            : this.normalizeEnumValues(payload.enum, valueType);
        const domain = payload.domain === undefined
            ? (existing?.domain ?? null)
            : normalizeTypeList(payload.domain, 'domain');

        if (existing && existing.value_type !== valueType && payload.confirm !== true) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                `属性 ${scope}.${key} 已定义为 ${existing.value_type}，改为 ${valueType} 会破坏既有数据；确认请传 confirm:true。`,
            );
        }
        const uniqueChanged = Boolean(existing) && Boolean(existing?.unique_value) !== uniqueValue;
        const identityChanged = Boolean(existing) && Boolean(existing?.identity) !== identity;
        if ((uniqueChanged || identityChanged) && payload.confirm !== true) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                `变更 ${scope}.${key} 的唯一性/身份键会影响既有数据语义；确认请传 confirm:true。`,
            );
        }

        await con.run('BEGIN TRANSACTION');
        try {
            await con.run(
                `INSERT INTO kg_attr_defs
                    (scope, key, value_type, description, required, indexed, enum_values, domain, unique_value, identity)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (scope, key) DO UPDATE SET
                    value_type = excluded.value_type,
                    description = excluded.description,
                    required = excluded.required,
                    indexed = excluded.indexed,
                    enum_values = excluded.enum_values,
                    domain = excluded.domain,
                    unique_value = excluded.unique_value,
                    identity = excluded.identity,
                    updated_at = now()`,
                [
                    scope, key, valueType, description, required, indexed,
                    enumValues ? JSON.stringify(enumValues) : null,
                    domain ? JSON.stringify(domain) : null,
                    uniqueValue, identity,
                ],
            );
            await con.run('COMMIT');
            const needIndexRebuild = !existing
                || Boolean(existing.indexed) !== indexed
                || existing.value_type !== valueType;
            const indexRows = needIndexRebuild
                ? await this.rebuildScopeIndex(scope)
                : Number(await this.scalar(
                    `SELECT count(*)::BIGINT AS c FROM ${this.attrIndexTable(scope)} WHERE key = ?`,
                    [key],
                ) || 0);
            const needIdentityRebuild = scope === 'node'
                && (identityChanged || (!existing && identity) || (Boolean(existing) && existing!.value_type !== valueType));
            const identityRows = needIdentityRebuild ? await this.rebuildIdentityIndex() : 0;
            return {
                scope, key, type: valueType, required, indexed, unique: uniqueValue, identity,
                domain,
                enumValues,
                indexRows,
                indexRebuilt: needIndexRebuild,
                identityRows,
                indexedRows: indexRows,
                typeChanged: Boolean(existing && existing.value_type !== valueType),
            };
        } catch (error) {
            await con.run('ROLLBACK').catch(() => undefined);
            throw error;
        }
    }

    public async listAttributes(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        const scopeParam = String(payload.scope || 'all').toLowerCase();
        const scope = scopeParam === 'all' ? undefined : assertAttrScope(scopeParam);
        const includeStats = payload.includeStats === true;
        const topValues = clampInt(payload.topValues, 0, 10, 0);
        const defs = await this.loadAttrDefs(scope);

        const indexCounts = await this.rows(
            `SELECT 'node' AS scope, key, count(*)::BIGINT AS c FROM kg_node_props GROUP BY key
             UNION ALL
             SELECT 'edge', key, count(*)::BIGINT AS c FROM kg_edge_props GROUP BY key`,
        );
        const countMap = new Map<string, number>(
            indexCounts.map((row: any) => [`${row.scope}:${row.key}`, Number(row.c)]),
        );

        const stats = new Map<string, Record<string, unknown>>();
        if (includeStats) {
            for (const currentScope of ['node', 'edge'] as AttrScope[]) {
                const scopeDefs = defs.filter((def) => def.scope === currentScope);
                if (!scopeDefs.length) continue;
                const selects = scopeDefs.map((def, index) => {
                    const path = `'$."${def.key}"'`;
                    return `count(json_extract_string(props, ${path})) AS p${index},
                            approx_count_distinct(json_extract_string(props, ${path})) AS d${index}`;
                });
                const table = currentScope === 'node' ? 'kg_nodes' : 'kg_edges';
                const row = (await this.rows(
                    `SELECT count(*)::BIGINT AS total, ${selects.join(', ')} FROM ${table}`,
                ))[0] as any;
                scopeDefs.forEach((def, index) => {
                    stats.set(`${def.scope}:${def.key}`, {
                        totalRows: Number(row.total),
                        presentRows: Number(row[`p${index}`]),
                        distinctValues: Number(row[`d${index}`]),
                    });
                });
            }
        }

        if (topValues > 0) {
            for (const def of defs.slice(0, 10)) {
                const path = `'$."${def.key}"'`;
                const table = def.scope === 'node' ? 'kg_nodes' : 'kg_edges';
                const rows = await this.rows(
                    `SELECT json_extract_string(props, ${path}) AS value, count(*)::BIGINT AS count
                     FROM ${table}
                     WHERE json_extract_string(props, ${path}) IS NOT NULL
                     GROUP BY value ORDER BY count DESC, value LIMIT ?`,
                    [topValues],
                );
                const entry = stats.get(`${def.scope}:${def.key}`) || {};
                entry.topValues = rows;
                stats.set(`${def.scope}:${def.key}`, entry);
            }
        }

        return {
            definitions: defs.map((def) => ({
                ...def,
                indexRows: countMap.get(`${def.scope}:${def.key}`) || 0,
                ...(stats.get(`${def.scope}:${def.key}`) || {}),
            })),
        };
    }

    public async deleteAttribute(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        const con = this.requireConnection();
        const scope = assertAttrScope(payload.scope);
        const key = assertAttrKey(payload.key);
        const existing = (await this.loadAttrDefs(scope)).some((def) => def.key === key);
        const before = Number(await this.scalar(
            `SELECT count(*)::BIGINT AS c FROM ${this.attrIndexTable(scope)} WHERE key = ?`,
            [key],
        ) || 0);
        await con.run('DELETE FROM kg_attr_defs WHERE scope = ? AND key = ?', [scope, key]);
        const indexedRows = await this.rebuildScopeIndex(scope);
        return {
            scope,
            key,
            deleted: existing,
            removedIndexRows: existing ? before : 0,
            indexedRows,
            note: '仅删除属性规范与索引；节点/边 props 中的历史值保留。',
        };
    }

    public async rebuildAttributeIndexes(): Promise<Record<string, unknown>> {
        const started = Date.now();
        const defs = (await this.loadAttrDefs()).filter((def) => def.indexed);
        let indexedRows = 0;
        for (const scope of ['node', 'edge'] as AttrScope[]) {
            if (!defs.some((def) => def.scope === scope)) {
                // 没有任何索引属性时也要清空历史索引行
                await this.requireConnection().run(`DELETE FROM ${this.attrIndexTable(scope)}`);
                continue;
            }
            const scopeStarted = Date.now();
            const rows = await this.rebuildScopeIndex(scope);
            indexedRows += rows;
            this.log('info', `reindexed ${scope} attr index in ${Date.now() - scopeStarted}ms (${rows} rows)`);
        }
        const identityRows = await this.rebuildIdentityIndex();
        return { rebuiltAttributes: defs.length, indexedRows, identityRows, elapsedMs: Date.now() - started };
    }

    // ─── 语义层：词表 / 身份键 / 编译检查 / 合并 ──────────────

    private async loadVocabDefs(kind?: VocabKind): Promise<VocabDefinition[]> {
        const rows = kind
            ? await this.rows('SELECT * FROM kg_vocab_defs WHERE kind = ? ORDER BY name', [kind])
            : await this.rows('SELECT * FROM kg_vocab_defs ORDER BY kind, name');
        const parseList = (value: unknown): string[] | null => (value == null
            ? null
            : (typeof value === 'string' ? JSON.parse(value) : value) as string[]);
        return rows.map((row: any) => ({
            kind: String(row.kind) as VocabKind,
            name: String(row.name),
            parent: row.parent == null ? null : String(row.parent),
            domain: parseList(row.domain_types),
            range: parseList(row.range_types),
            symmetric: Boolean(row.is_symmetric),
            transitive: Boolean(row.is_transitive),
            description: row.description == null ? null : String(row.description),
        }));
    }

    private async loadSemanticRules(): Promise<{
        vocab: VocabDefinition[];
        classes: ReturnType<typeof buildTypeClosure>;
        properties: ReturnType<typeof buildTypeClosure>;
        rules: Map<string, EffectivePropertyRule>;
        attrDefs: AttributeDefinition[];
    }> {
        const vocab = await this.loadVocabDefs();
        const classes = buildTypeClosure(vocab, 'class');
        const properties = buildTypeClosure(vocab, 'property');
        const rules = buildEffectivePropertyRules(vocab, classes.descendants);
        return { vocab, classes, properties, rules, attrDefs: await this.loadAttrDefs() };
    }

    /** 把 domain 中的类型展开成「自身 + 子类」，语义与 RDFS domain 一致。 */
    private expandTypes(types: string[], classes: Map<string, Set<string>>): Set<string> {
        const set = new Set<string>();
        for (const type of types) {
            set.add(type);
            for (const member of classes.get(type) || []) set.add(member);
        }
        return set;
    }

    public async defineVocab(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        const con = this.requireConnection();
        const kind = assertVocabKind(payload.kind);
        const name = assertVocabName(payload.name);
        const existing = (await this.loadVocabDefs(kind)).find((def) => def.name === name);
        const parent = payload.parent === undefined
            ? (existing?.parent ?? null)
            : (payload.parent == null ? null : assertVocabName(payload.parent, 'parent'));
        const domain = kind === 'class'
            ? null
            : (payload.domain === undefined ? (existing?.domain ?? null) : normalizeTypeList(payload.domain, 'domain'));
        const range = kind === 'class'
            ? null
            : (payload.range === undefined ? (existing?.range ?? null) : normalizeTypeList(payload.range, 'range'));
        const symmetric = kind === 'class'
            ? false
            : (payload.symmetric === undefined ? Boolean(existing?.symmetric) : payload.symmetric === true);
        const transitive = kind === 'class'
            ? false
            : (payload.transitive === undefined ? Boolean(existing?.transitive) : payload.transitive === true);
        const description = payload.description === undefined
            ? (existing?.description ?? null)
            : (payload.description == null ? null : String(payload.description).slice(0, 500));

        if (kind === 'class' && (payload.domain !== undefined || payload.range !== undefined
            || payload.symmetric !== undefined || payload.transitive !== undefined)) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                'class 只支持 parent/description；domain/range/symmetric/transitive 属于 property。',
            );
        }
        if (parent === name) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, 'parent 不能是自身。');
        }
        if (parent) {
            const byName = new Map((await this.loadVocabDefs(kind)).map((def) => [def.name, def]));
            let cursor: string | null = parent;
            const seen = new Set<string>([name]);
            while (cursor) {
                if (seen.has(cursor)) {
                    throw new DuckDbToolError(
                        DUCKDB_ERROR_CODES.invalidRequest,
                        `parent 链形成环：${name} → ${parent}（会破坏类型层级语义）。`,
                    );
                }
                seen.add(cursor);
                cursor = byName.get(cursor)?.parent ?? null;
            }
        }

        await con.run(
            `INSERT INTO kg_vocab_defs (kind, name, parent, domain_types, range_types, is_symmetric, is_transitive, description)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (kind, name) DO UPDATE SET
                parent = excluded.parent,
                domain_types = excluded.domain_types,
                range_types = excluded.range_types,
                is_symmetric = excluded.is_symmetric,
                is_transitive = excluded.is_transitive,
                description = excluded.description,
                updated_at = now()`,
            [
                kind, name, parent,
                domain ? JSON.stringify(domain) : null,
                range ? JSON.stringify(range) : null,
                symmetric, transitive, description,
            ],
        );
        const rules = await this.loadSemanticRules();
        return {
            kind, name, parent, domain, range, symmetric, transitive,
            created: !existing,
            effective: rules.rules.get(name)
                ? {
                    domain: Array.from(rules.rules.get(name)?.domain || []),
                    range: Array.from(rules.rules.get(name)?.range || []),
                }
                : undefined,
        };
    }

    public async listVocab(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        const kindParam = payload.kind === undefined || payload.kind === null || payload.kind === ''
            ? undefined
            : assertVocabKind(payload.kind);
        const vocab = await this.loadVocabDefs(kindParam);
        const includeUsage = payload.includeUsage !== false;
        const classNames = new Set(vocab.filter((def) => def.kind === 'class').map((def) => def.name));
        const propertyNames = new Set(vocab.filter((def) => def.kind === 'property').map((def) => def.name));

        const nodeUsage = new Map<string, number>();
        const edgeUsage = new Map<string, number>();
        if (includeUsage) {
            for (const row of await this.rows('SELECT type, count(*)::BIGINT AS c FROM kg_nodes GROUP BY type')) {
                nodeUsage.set(String((row as any).type), Number((row as any).c));
            }
            for (const row of await this.rows('SELECT type, count(*)::BIGINT AS c FROM kg_edges GROUP BY type')) {
                edgeUsage.set(String((row as any).type), Number((row as any).c));
            }
        }

        const rules = await this.loadSemanticRules();
        return {
            definitions: vocab.map((def) => {
                const effective = def.kind === 'property' ? rules.rules.get(def.name) : undefined;
                return {
                    ...def,
                    usage: includeUsage
                        ? (def.kind === 'class'
                            ? nodeUsage.get(def.name) || 0
                            : edgeUsage.get(def.name) || 0)
                        : undefined,
                    effectiveDomain: effective?.domain ? Array.from(effective.domain) : null,
                    effectiveRange: effective?.range ? Array.from(effective.range) : null,
                };
            }),
            undeclaredNodeTypes: includeUsage
                ? Array.from(nodeUsage.keys()).filter((type) => !classNames.has(type)).slice(0, 50)
                : undefined,
            undeclaredEdgeTypes: includeUsage
                ? Array.from(edgeUsage.keys()).filter((type) => !propertyNames.has(type)).slice(0, 50)
                : undefined,
        };
    }

    public async deleteVocab(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        const con = this.requireConnection();
        const kind = assertVocabKind(payload.kind);
        const name = assertVocabName(payload.name);
        const existing = (await this.loadVocabDefs(kind)).some((def) => def.name === name);
        await con.run('DELETE FROM kg_vocab_defs WHERE kind = ? AND name = ?', [kind, name]);
        const usage = kind === 'class'
            ? Number(await this.scalar('SELECT count(*)::BIGINT AS c FROM kg_nodes WHERE type = ?', [name]) || 0)
            : Number(await this.scalar('SELECT count(*)::BIGINT AS c FROM kg_edges WHERE type = ?', [name]) || 0);
        return {
            kind, name, deleted: existing,
            usage,
            note: '仅删除词表声明；数据中的类型名保留，重新声明即可恢复约束。',
        };
    }

    // ─── 身份键（实体同一性） ───────────────────────────────

    private async identityDefs(): Promise<AttributeDefinition[]> {
        const defs = await this.loadAttrDefs('node');
        return defs
            .filter((def) => def.identity && def.value_type !== 'json')
            .sort((a, b) => a.key.localeCompare(b.key));
    }

    /**
     * 身份键适用类型（RDFS domain 语义）。
     *
     * 多类型图谱（company / org / industry）里，`code` 通常只属于 company；
     * 若不做 domain 收敛，`identity_incomplete` 会把所有其他类型都算成缺键。
     * 返回 null 表示未声明 domain，适用于全部节点。
     */
    private async identityScope(defs: AttributeDefinition[]): Promise<Set<string> | null> {
        const constrained = defs.filter((def) => def.domain?.length);
        if (!constrained.length) return null;
        const { classes } = await this.loadSemanticRules();
        let allowed: Set<string> | null = null;
        for (const def of constrained) {
            const expanded = this.expandTypes(def.domain as string[], classes.descendants);
            allowed = allowed
                ? new Set(Array.from<string>(allowed).filter((type) => expanded.has(type)))
                : expanded;
        }
        return allowed;
    }

    /** 身份键 SQL 类型过滤（空字符串表示不过滤；domain 交集为空则永不为真）。 */
    private identityTypeFilter(scope: Set<string> | null): string {
        if (!scope) return '';
        if (!scope.size) return '1 = 0';
        const list = Array.from(scope).map((type) => `'${this.escapeLiteral(type)}'`).join(', ');
        return `type IN (${list})`;
    }

    /** 属性的 domain 作用域（展开子类）；null 表示不限类型。 */
    private async attrDomainScope(def: AttributeDefinition): Promise<Set<string> | null> {
        if (!def.domain?.length) return null;
        const { classes } = await this.loadSemanticRules();
        return this.expandTypes(def.domain as string[], classes.descendants);
    }

    /** props 可能是 null / 'null' / 对象 / JSON 文本，统一成普通对象。 */
    private parsePropsObject(value: unknown): Record<string, unknown> {
        if (value === null || value === undefined) return {};
        try {
            const parsed = typeof value === 'string' ? JSON.parse(value) : value;
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? parsed as Record<string, unknown>
                : {};
        } catch {
            return {};
        }
    }

    /** 与 SQL 侧 md5(concat_ws(chr(31), ...)) 完全一致的哈希。 */
    private identityHash(defs: AttributeDefinition[], propsJson: string | null): { hash: string; keys: Record<string, unknown> } | null {
        if (!defs.length) return null;
        const props = this.parsePropsObject(propsJson);
        const parts: string[] = [];
        const keys: Record<string, unknown> = {};
        for (const def of defs) {
            const value = props[def.key];
            if (value === undefined || value === null || value === '') return null;
            parts.push(String(value));
            keys[def.key] = value;
        }
        return { hash: createHash('md5').update(parts.join('\x1f'), 'utf8').digest('hex'), keys };
    }

    private identitySqlExprs(defs: AttributeDefinition[]): { select: string; aliased: string; present: string } {
        const exprs = defs.map((def) => `json_extract_string(props, '$."${def.key}"')`);
        const nullChecks = exprs.map((expr) => `${expr} IS NOT NULL AND ${expr} <> ''`);
        return {
            select: exprs.join(', '),
            aliased: exprs.map((expr, index) => `${expr} AS k${index}`).join(', '),
            present: nullChecks.join(' AND '),
        };
    }

    private async rebuildIdentityIndex(): Promise<number> {
        const con = this.requireConnection();
        const defs = await this.identityDefs();
        await con.run('BEGIN TRANSACTION');
        try {
            await con.run('DROP TABLE IF EXISTS kg_identity');
            await con.run(IDENTITY_DDL);
            await con.run('CREATE INDEX IF NOT EXISTS idx_kg_identity_node ON kg_identity(node_id)');
            if (!defs.length) {
                await con.run('COMMIT');
                return 0;
            }
            const exprs = this.identitySqlExprs(defs);
            const keysJson = `json_object(${defs.map((def) => `'${def.key}', json_extract(props, '$."${def.key}"')`).join(', ')})::VARCHAR`;
            const typeFilter = this.identityTypeFilter(await this.identityScope(defs));
            const result = await con.run(
                `INSERT INTO kg_identity (key_hash, node_id, keys_json)
                 SELECT md5(concat_ws(chr(31), ${exprs.select})), id, ${keysJson}
                 FROM kg_nodes WHERE ${exprs.present}${typeFilter ? ` AND ${typeFilter}` : ''}
                 ON CONFLICT (key_hash) DO NOTHING`,
            );
            await con.run('COMMIT');
            return result.rowsChanged;
        } catch (error) {
            await con.run('ROLLBACK').catch(() => undefined);
            throw error;
        }
    }

    /** 写入后维护身份键索引（删除旧行 → 重新计算本批节点）。 */
    private async syncIdentityIndex(ids: string[]): Promise<number> {
        if (!ids.length) return 0;
        const defs = await this.identityDefs();
        const con = this.requireConnection();
        const idJson = jsonListParam(ids);
        await con.run(
            `DELETE FROM kg_identity WHERE node_id IN (
                SELECT json_extract_string(value, '$') FROM json_each(?::JSON)
             )`,
            [idJson],
        );
        if (!defs.length) return 0;
        const exprs = this.identitySqlExprs(defs);
        const keysJson = `json_object(${defs.map((def) => `'${def.key}', json_extract(props, '$."${def.key}"')`).join(', ')})::VARCHAR`;
        const typeFilter = this.identityTypeFilter(await this.identityScope(defs));
        const result = await con.run(
            `INSERT INTO kg_identity (key_hash, node_id, keys_json)
             SELECT md5(concat_ws(chr(31), ${exprs.select})), id, ${keysJson}
             FROM kg_nodes
             WHERE id IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))
               AND ${exprs.present}${typeFilter ? ` AND ${typeFilter}` : ''}`,
            [idJson],
        );
        return result.rowsChanged;
    }

    /**
     * 写入前校验语义唯一性：
     * - `unique` 属性值全局唯一（owl:InverseFunctionalProperty）；
     * - `identity` 组合键唯一（自然键），批内与库内都检查。
     */
    private async assertUniqueness(
        nodes: Record<string, unknown>[],
        edges: Record<string, unknown>[],
        attrDefs: AttributeDefinition[],
    ): Promise<void> {
        for (const scope of ['node', 'edge'] as AttrScope[]) {
            const items = scope === 'node' ? nodes : edges;
            if (!items.length) continue;
            const defs = attrDefs.filter((def) => def.scope === scope && def.unique_value);
            if (!defs.length) continue;
            const propsList = items.map((item) => this.parsePropsObject(item.props));
            for (const def of defs) {
                const domainScope = await this.attrDomainScope(def);
                if (domainScope && !domainScope.size) continue;
                const allowedList = domainScope
                    ? Array.from(domainScope).map((type) => `'${this.escapeLiteral(type)}'`).join(', ')
                    : '';
                const entries = items
                    .map((item, index) => ({ item, index }))
                    .filter(({ item }) => !domainScope || domainScope.has(String(item.type)))
                    .map(({ item, index }) => ({
                        id: scope === 'node'
                            ? String(item.id)
                            : `${item.src}\u001f${item.dst}\u001f${item.type}`,
                        value: propsList[index][def.key],
                    }))
                    .filter((entry) => entry.value !== undefined && entry.value !== null);
                if (!entries.length) continue;

                const seen = new Map<string, string>();
                for (const entry of entries) {
                    const key = String(entry.value);
                    const previous = seen.get(key);
                    if (previous && previous !== entry.id) {
                        throw new DuckDbToolError(
                            DUCKDB_ERROR_CODES.invalidRequest,
                            `${scope === 'node' ? '节点' : '关系'}属性 ${def.key} 声明为唯一（unique），批次内值 ${JSON.stringify(entry.value)} 同时出现在 ${previous} 与 ${entry.id}。`,
                        );
                    }
                    seen.set(key, entry.id);
                }

                const numeric = def.value_type === 'number';
                const valueColumn = numeric ? 'val_num' : 'val_text';
                const payload = JSON.stringify(entries.map((entry) => ({
                    id: entry.id,
                    v: numeric ? Number(entry.value) : (def.value_type === 'boolean'
                        ? String(entry.value).toLowerCase()
                        : String(entry.value)),
                })));
                const indexTable = this.attrIndexTable(scope);
                const keyExpr = scope === 'node'
                    ? 'p.node_id'
                    : `concat_ws(chr(31), p.src, p.dst, p.type)`;
                const domainJoin = allowedList
                    ? (scope === 'node'
                        ? ' JOIN kg_nodes dn ON dn.id = p.node_id'
                        : '')
                    : '';
                const domainWhere = allowedList
                    ? ` AND ${scope === 'node' ? 'dn.type' : 'p.type'} IN (${allowedList})`
                    : '';
                const conflict = await this.rows(
                    `SELECT ${keyExpr} AS id, p.${valueColumn} AS value
                     FROM ${indexTable} p${domainJoin}
                     JOIN (
                        SELECT json_extract_string(value, '$.id') AS id,
                               ${numeric ? 'TRY_CAST(json_extract_string(value, \'$.v\') AS DOUBLE)' : 'json_extract_string(value, \'$.v\')'} AS v
                        FROM json_each(?::JSON)
                     ) b ON p.${valueColumn} = b.v
                     WHERE p.key = ? AND ${keyExpr} <> b.id${domainWhere}
                     LIMIT 3`,
                    [payload, def.key],
                );
                if (conflict.length) {
                    throw new DuckDbToolError(
                        DUCKDB_ERROR_CODES.invalidRequest,
                        `${scope === 'node' ? '节点' : '关系'}属性 ${def.key} 声明为唯一（unique），值 ${JSON.stringify(conflict[0].value)} 已被 ${conflict[0].id} 占用。`,
                    );
                }
            }
        }

        const identityDefs = attrDefs.filter((def) => def.scope === 'node' && def.identity);
        if (!identityDefs.length || !nodes.length) return;
        const ordered = identityDefs.slice().sort((a, b) => a.key.localeCompare(b.key));
        const identityScope = await this.identityScope(ordered);
        const batchHashes = new Map<string, string>();
        const rows: { id: string; hash: string; keys: Record<string, unknown> }[] = [];
        for (const node of nodes) {
            if (identityScope && !identityScope.has(String(node.type))) continue;
            const tuple = this.identityHash(ordered, String(node.props ?? 'null'));
            if (!tuple) continue;
            const id = String(node.id);
            const owner = batchHashes.get(tuple.hash);
            if (owner && owner !== id) {
                throw new DuckDbToolError(
                    DUCKDB_ERROR_CODES.invalidRequest,
                    `实体身份键（${ordered.map((def) => def.key).join(' + ')}）冲突：${owner} 与 ${id} 相同值为 ${JSON.stringify(tuple.keys)}。同一实体请先用 kg_merge 合并。`,
                );
            }
            batchHashes.set(tuple.hash, id);
            rows.push({ id, hash: tuple.hash, keys: tuple.keys });
        }
        if (!rows.length) return;
        const existing = await this.rows(
            `SELECT i.key_hash, i.node_id, i.keys_json FROM kg_identity i
             WHERE i.key_hash IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))`,
            [JSON.stringify(rows.map((row) => row.hash))],
        );
        const batchIds = new Set(rows.map((row) => row.id));
        const conflict = existing.find((row: any) => !batchIds.has(String(row.node_id)));
        if (conflict) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                `实体身份键冲突：节点 ${conflict.node_id} 已占用相同身份值 ${conflict.keys_json}。同一实体请先用 kg_merge 合并。`,
            );
        }
    }

    /**
     * 写入前校验词表约束：类型声明、关系 domain/range、属性 domain。
     * `strictSchema` 时未声明的节点/关系类型直接拒绝。
     */
    private async validateVocabulary(
        nodes: Record<string, unknown>[],
        edges: Record<string, unknown>[],
        strictSchema: boolean,
    ): Promise<string[]> {
        const rules = await this.loadSemanticRules();
        const warnings: string[] = [];
        const classNames = new Set(rules.vocab.filter((def) => def.kind === 'class').map((def) => def.name));
        const propertyNames = new Set(rules.vocab.filter((def) => def.kind === 'property').map((def) => def.name));

        if (classNames.size) {
            const undeclared = Array.from(new Set(nodes
                .map((node) => String(node.type))
                .filter((type) => !classNames.has(type))));
            if (undeclared.length) {
                const message = `节点类型未在词表声明：${undeclared.slice(0, 5).join(', ')}${undeclared.length > 5 ? ' …' : ''}`;
                if (strictSchema) {
                    throw new DuckDbToolError(
                        DUCKDB_ERROR_CODES.invalidRequest,
                        `${message}。先 kg_vocab define kind:class 声明，或去掉 strictSchema。`,
                    );
                }
                warnings.push(message);
            }
        }
        if (propertyNames.size) {
            const undeclared = Array.from(new Set(edges
                .map((edge) => String(edge.type))
                .filter((type) => !propertyNames.has(type))));
            if (undeclared.length) {
                const message = `关系类型未在词表声明：${undeclared.slice(0, 5).join(', ')}${undeclared.length > 5 ? ' …' : ''}`;
                if (strictSchema) {
                    throw new DuckDbToolError(
                        DUCKDB_ERROR_CODES.invalidRequest,
                        `${message}。先 kg_vocab define kind:property 声明，或去掉 strictSchema。`,
                    );
                }
                warnings.push(message);
            }
        }

        if (edges.length) {
            const nodeTypeById = new Map(nodes.map((node) => [String(node.id), String(node.type)]));
            const missingIds = Array.from(new Set(edges
                .flatMap((edge) => [String(edge.src), String(edge.dst)])
                .filter((id) => !nodeTypeById.has(id))));
            if (missingIds.length) {
                const rows = await this.rows(
                    `SELECT id, type FROM kg_nodes
                     WHERE id IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))`,
                    [jsonListParam(missingIds)],
                );
                for (const row of rows as any[]) nodeTypeById.set(String(row.id), String(row.type));
            }
            for (let index = 0; index < edges.length; index += 1) {
                const edge = edges[index];
                const rule = rules.rules.get(String(edge.type));
                if (!rule) continue;
                const srcType = nodeTypeById.get(String(edge.src));
                const dstType = nodeTypeById.get(String(edge.dst));
                if (rule.domain && srcType && !rule.domain.has(srcType)) {
                    throw new DuckDbToolError(
                        DUCKDB_ERROR_CODES.invalidRequest,
                        `edges[${index}] 违反 rdfs:domain：${edge.type} 的起点应为 ${Array.from(rule.domain).join(' / ')}，实际 ${edge.src} 是 ${srcType}。`,
                    );
                }
                if (rule.range && dstType && !rule.range.has(dstType)) {
                    throw new DuckDbToolError(
                        DUCKDB_ERROR_CODES.invalidRequest,
                        `edges[${index}] 违反 rdfs:range：${edge.type} 的终点应为 ${Array.from(rule.range).join(' / ')}，实际 ${edge.dst} 是 ${dstType}。`,
                    );
                }
            }
        }

        const domainDefs = rules.attrDefs.filter((def) => def.domain?.length);
        if (domainDefs.length) {
            const parsed = {
                node: nodes.map((item) => this.parsePropsObject(item.props)),
                edge: edges.map((item) => this.parsePropsObject(item.props)),
            };
            for (const def of domainDefs) {
                const items = def.scope === 'node' ? nodes : edges;
                const propsList = def.scope === 'node' ? parsed.node : parsed.edge;
                const allowed = this.expandTypes(def.domain as string[], rules.classes.descendants);
                for (let index = 0; index < items.length; index += 1) {
                    const value = propsList[index][def.key];
                    if (value === undefined || value === null) continue;
                    if (allowed.has(String(items[index].type))) continue;
                    throw new DuckDbToolError(
                        DUCKDB_ERROR_CODES.invalidRequest,
                        `${def.scope === 'node' ? `nodes[${index}]` : `edges[${index}]`} 违反属性域：${def.key} 只允许 ${(def.domain as string[]).join(' / ')}，实际类型 ${items[index].type}。`,
                    );
                }
            }
        }

        return warnings;
    }

    // ─── 编译式语义检查（kg_lint） ──────────────────────────

    public async lint(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        const started = Date.now();
        const strict = payload.strict === true;
        const deep = payload.deep === true;
        const maxIssues = clampInt(payload.maxIssues, 1, 200, 50);
        const sampleLimit = clampInt(payload.sampleLimit, 0, 10, 3);
        const only = normalizeStringArray(payload.codes, 'codes');
        const diagnostics: SemanticDiagnostic[] = [];
        const push = (item: SemanticDiagnostic) => {
            if (only.length && !only.includes(item.code)) return;
            if (!item.count) return;
            diagnostics.push(item);
        };
        const sqlList = (values: string[]) => values
            .map((value) => `'${this.escapeLiteral(value)}'`)
            .join(', ');

        const rules = await this.loadSemanticRules();

        for (const [kind, closure] of [['class', rules.classes], ['property', rules.properties]] as const) {
            push({
                code: 'vocab_unknown_parent',
                severity: 'error',
                count: closure.unknownParents.length,
                message: `${kind} 的父类型未声明`,
                hint: '先用 kg_vocab define 声明父类型，或修正 parent。',
                sample: closure.unknownParents.slice(0, sampleLimit).map((chain) => ({ kind, chain })),
            });
            push({
                code: 'vocab_cycle',
                severity: 'error',
                count: closure.cycles.length,
                message: `${kind} 层级存在环`,
                hint: '类型层级必须是 DAG；用 kg_vocab define 改 parent 打断环。',
                sample: closure.cycles.slice(0, sampleLimit).map((chain) => ({ kind, chain })),
            });
        }

        const classNames = new Set(rules.vocab.filter((def) => def.kind === 'class').map((def) => def.name));
        const propertyNames = new Set(rules.vocab.filter((def) => def.kind === 'property').map((def) => def.name));
        const nodeTypeRows = await this.rows(
            'SELECT type, count(*)::BIGINT AS c FROM kg_nodes GROUP BY type ORDER BY c DESC',
        );
        const edgeTypeRows = await this.rows(
            'SELECT type, count(*)::BIGINT AS c FROM kg_edges GROUP BY type ORDER BY c DESC',
        );
        if (classNames.size) {
            const missing: any[] = nodeTypeRows.filter((row) => !classNames.has(String((row as any).type)));
            push({
                code: 'vocab_undeclared_node_type',
                severity: strict ? 'error' : 'warning',
                count: missing.reduce((total, row) => total + Number((row as any).c), 0),
                message: `${missing.length} 个节点类型未在词表声明`,
                hint: 'kg_vocab define kind:class 声明后，domain/range 与子类推断才会生效。',
                sample: missing.slice(0, sampleLimit).map((row) => ({
                    type: String((row as any).type), nodes: Number((row as any).c),
                })),
            });
        }
        if (propertyNames.size) {
            const missing: any[] = edgeTypeRows.filter((row) => !propertyNames.has(String((row as any).type)));
            push({
                code: 'vocab_undeclared_edge_type',
                severity: strict ? 'error' : 'warning',
                count: missing.reduce((total, row) => total + Number((row as any).c), 0),
                message: `${missing.length} 个关系类型未在词表声明`,
                hint: 'kg_vocab define kind:property 可声明 domain/range。',
                sample: missing.slice(0, sampleLimit).map((row) => ({
                    type: String((row as any).type), edges: Number((row as any).c),
                })),
            });
        }

        for (const rule of rules.rules.values()) {
            if (rule.domain) {
                const allowed = sqlList(Array.from(rule.domain));
                const count = Number(await this.scalar(
                    `SELECT count(*)::BIGINT AS c
                     FROM kg_edges e JOIN kg_nodes n ON n.id = e.src
                     WHERE e.type = ? AND n.type NOT IN (${allowed})`,
                    [rule.name],
                ) || 0);
                if (count) {
                    const sample = sampleLimit
                        ? await this.rows(
                            `SELECT e.src, n.type AS src_type, e.type FROM kg_edges e
                             JOIN kg_nodes n ON n.id = e.src
                             WHERE e.type = ? AND n.type NOT IN (${allowed}) LIMIT ?`,
                            [rule.name, sampleLimit],
                        )
                        : undefined;
                    push({
                        code: 'edge_domain_violation',
                        severity: 'error',
                        count,
                        message: `关系 ${rule.name} 的起点类型超出 rdfs:domain`,
                        hint: `允许：${Array.from(rule.domain).join(', ')}。修正数据或调整 kg_vocab 声明。`,
                        sample,
                    });
                }
            }
            if (rule.range) {
                const allowed = sqlList(Array.from(rule.range));
                const count = Number(await this.scalar(
                    `SELECT count(*)::BIGINT AS c
                     FROM kg_edges e JOIN kg_nodes n ON n.id = e.dst
                     WHERE e.type = ? AND n.type NOT IN (${allowed})`,
                    [rule.name],
                ) || 0);
                if (count) {
                    const sample = sampleLimit
                        ? await this.rows(
                            `SELECT e.src, e.dst, n.type AS dst_type, e.type FROM kg_edges e
                             JOIN kg_nodes n ON n.id = e.dst
                             WHERE e.type = ? AND n.type NOT IN (${allowed}) LIMIT ?`,
                            [rule.name, sampleLimit],
                        )
                        : undefined;
                    push({
                        code: 'edge_range_violation',
                        severity: 'error',
                        count,
                        message: `关系 ${rule.name} 的终点类型超出 rdfs:range`,
                        hint: `允许：${Array.from(rule.range).join(', ')}。`,
                        sample,
                    });
                }
            }
            if (rule.symmetric && sampleLimit >= 0) {
                const count = Number(await this.scalar(
                    `SELECT count(*)::BIGINT AS c FROM kg_edges e
                     WHERE e.type = ? AND NOT EXISTS (
                        SELECT 1 FROM kg_edges r
                        WHERE r.src = e.dst AND r.dst = e.src AND r.type = e.type
                     )`,
                    [rule.name],
                ) || 0);
                if (count) {
                    const sample = sampleLimit
                        ? await this.rows(
                            `SELECT e.src, e.dst, e.type FROM kg_edges e
                             WHERE e.type = ? AND NOT EXISTS (
                                SELECT 1 FROM kg_edges r
                                WHERE r.src = e.dst AND r.dst = e.src AND r.type = e.type
                             ) LIMIT ?`,
                            [rule.name, sampleLimit],
                        )
                        : undefined;
                    push({
                        code: 'symmetric_missing_inverse',
                        severity: 'warning',
                        count,
                        message: `对称关系 ${rule.name} 存在缺少反向边的情况`,
                        hint: `补齐反向边，或用 kg_vocab define symmetric:false 取消对称声明。`,
                        sample,
                    });
                }
            }
            if (deep && rule.transitive) {
                const count = Number(await this.scalar(
                    `SELECT count(*)::BIGINT AS c FROM (
                        SELECT DISTINCT e1.src, e2.dst
                        FROM kg_edges e1
                        JOIN kg_edges e2 ON e2.src = e1.dst AND e2.type = e1.type
                        WHERE e1.type = ? AND e1.src <> e2.dst
                          AND NOT EXISTS (
                            SELECT 1 FROM kg_edges s
                            WHERE s.src = e1.src AND s.dst = e2.dst AND s.type = e1.type
                          )
                     )`,
                    [rule.name],
                ) || 0);
                if (count) {
                    const sample = sampleLimit
                        ? await this.rows(
                            `SELECT DISTINCT e1.src, e2.dst, e1.type
                             FROM kg_edges e1
                             JOIN kg_edges e2 ON e2.src = e1.dst AND e2.type = e1.type
                             WHERE e1.type = ? AND e1.src <> e2.dst
                               AND NOT EXISTS (
                                 SELECT 1 FROM kg_edges s
                                 WHERE s.src = e1.src AND s.dst = e2.dst AND s.type = e1.type
                               ) LIMIT ?`,
                            [rule.name, sampleLimit],
                        )
                        : undefined;
                    push({
                        code: 'transitive_missing_shortcut',
                        severity: 'warning',
                        count,
                        message: `传递关系 ${rule.name} 缺少传递闭包捷径边`,
                        hint: '补齐捷径边，或用 kg_vocab define transitive:false 取消传递声明。',
                        sample,
                    });
                }
            }
        }

        for (const def of rules.attrDefs) {
            if (!def.domain?.length) continue;
            const allowed = sqlList(Array.from(this.expandTypes(def.domain, rules.classes.descendants)));
            const table = def.scope === 'node' ? 'kg_nodes' : 'kg_edges';
            const present = `json_extract_string(props, '$."${def.key}"') IS NOT NULL`;
            const count = Number(await this.scalar(
                `SELECT count(*)::BIGINT AS c FROM ${table}
                 WHERE ${present} AND type NOT IN (${allowed})`,
            ) || 0);
            if (count) {
                const sample = sampleLimit
                    ? await this.rows(
                        `SELECT ${def.scope === 'node' ? 'id' : 'src, dst'}, type FROM ${table}
                         WHERE ${present} AND type NOT IN (${allowed}) LIMIT ?`,
                        [sampleLimit],
                    )
                    : undefined;
                push({
                    code: 'attr_domain_violation',
                    severity: 'error',
                    count,
                    message: `属性 ${def.key} 出现在未授权类型上（rdfs:domain）`,
                    hint: `允许类型：${def.domain.join(', ')}。`,
                    sample,
                });
            }
        }

        for (const def of rules.attrDefs.filter((item) => item.unique_value)) {
            const indexTable = this.attrIndexTable(def.scope);
            const valueColumn = def.value_type === 'number' ? 'val_num' : 'val_text';
            const domainScope = await this.attrDomainScope(def);
            if (domainScope && !domainScope.size) continue;
            const allowed = domainScope
                ? Array.from(domainScope).map((type) => `'${this.escapeLiteral(type)}'`).join(', ')
                : '';
            const domainJoin = allowed && def.scope === 'node'
                ? ' JOIN kg_nodes dn ON dn.id = p.node_id'
                : '';
            const domainWhere = allowed
                ? ` AND ${def.scope === 'node' ? 'dn.type' : 'p.type'} IN (${allowed})`
                : '';
            const duplicates = await this.rows(
                `SELECT p.${valueColumn} AS value, count(*)::BIGINT AS c
                 FROM ${indexTable} p${domainJoin}
                 WHERE p.key = ? AND p.${valueColumn} IS NOT NULL${domainWhere}
                 GROUP BY 1 HAVING count(*) > 1 ORDER BY c DESC LIMIT ?`,
                [def.key, Math.max(sampleLimit, 1)],
            );
            if (duplicates.length) {
                const total = Number(await this.scalar(
                    `SELECT count(*)::BIGINT AS c FROM (
                        SELECT p.${valueColumn} FROM ${indexTable} p${domainJoin}
                        WHERE p.key = ? AND p.${valueColumn} IS NOT NULL${domainWhere}
                        GROUP BY 1 HAVING count(*) > 1
                     )`,
                    [def.key],
                ) || 0);
                push({
                    code: 'attr_unique_duplicate',
                    severity: 'error',
                    count: total,
                    message: `唯一属性 ${def.key} 存在重复值${allowed ? '（按 domain 统计）' : ''}`,
                    hint: '用 kg_merge 合并实体，或修正重复值后 kg_admin reindex。',
                    sample: duplicates,
                });
            }
        }

        const identityDefs = rules.attrDefs
            .filter((def) => def.scope === 'node' && def.identity)
            .sort((a, b) => a.key.localeCompare(b.key));
        if (identityDefs.length) {
            const exprs = this.identitySqlExprs(identityDefs);
            const scope = await this.identityScope(identityDefs);
            const scopeFilter = this.identityTypeFilter(scope);
            const scoped = (predicate: string) => (scopeFilter ? `${predicate} AND ${scopeFilter}` : predicate);
            const grouped = await this.rows(
                `WITH t AS (SELECT ${exprs.aliased} FROM kg_nodes WHERE ${scoped(exprs.present)})
                 SELECT *, count(*)::BIGINT AS c FROM t GROUP BY ALL HAVING count(*) > 1
                 ORDER BY c DESC LIMIT ?`,
                [Math.max(sampleLimit, 1)],
            );
            if (grouped.length) {
                const total = Number(await this.scalar(
                    `WITH t AS (SELECT ${exprs.aliased} FROM kg_nodes WHERE ${scoped(exprs.present)})
                     SELECT count(*)::BIGINT AS c FROM (
                        SELECT * FROM t GROUP BY ALL HAVING count(*) > 1
                     )`,
                ) || 0);
                push({
                    code: 'identity_duplicate',
                    severity: 'error',
                    count: total,
                    message: `实体身份键（${identityDefs.map((def) => def.key).join(' + ')}）存在重复`,
                    hint: '同一实体请用 kg_merge 合并；合并后 kg_lint 应归零。',
                    sample: grouped,
                });
            }
            const incomplete = Number(await this.scalar(
                `SELECT count(*)::BIGINT AS c FROM kg_nodes WHERE ${scoped(`NOT (${exprs.present})`)}`,
            ) || 0);
            push({
                code: 'identity_incomplete',
                severity: 'warning',
                count: incomplete,
                message: `节点缺少完整身份键（${identityDefs.map((def) => def.key).join(' + ')}）`
                    + `${scope ? `（仅统计 ${Array.from(scope).join('/')}）` : ''}`,
                hint: '补齐身份属性；不属于身份域的类型不参与判定。',
            });
            const orphans = Number(await this.scalar(
                `SELECT count(*)::BIGINT AS c FROM kg_identity i
                 LEFT JOIN kg_nodes n ON n.id = i.node_id WHERE n.id IS NULL`,
            ) || 0);
            push({
                code: 'identity_index_orphans',
                severity: 'error',
                count: orphans,
                message: '身份键索引存在已删除节点',
                hint: '执行 kg_admin reindex 重建身份索引。',
            });
            const drift = Number(await this.scalar(
                `WITH t AS (SELECT id, md5(concat_ws(chr(31), ${exprs.select})) AS h
                            FROM kg_nodes WHERE ${scoped(exprs.present)})
                 SELECT count(*)::BIGINT AS c FROM kg_identity i
                 LEFT JOIN t ON t.id = i.node_id
                 WHERE t.h IS NULL OR t.h <> i.key_hash`,
            ) || 0);
            push({
                code: 'identity_index_drift',
                severity: 'error',
                count: drift,
                message: '身份键索引与数据不一致',
                hint: '执行 kg_admin reindex 重建身份索引。',
            });
        }

        const normalizedIds = await this.rows(
            `SELECT lower(trim(id)) AS key, count(*)::BIGINT AS c FROM kg_nodes
             GROUP BY 1 HAVING count(*) > 1 ORDER BY c DESC LIMIT ?`,
            [Math.max(sampleLimit, 1)],
        );
        if (normalizedIds.length) {
            push({
                code: 'id_normalized_duplicate',
                severity: 'warning',
                count: normalizedIds.length,
                message: '存在仅大小写/空白不同的节点 ID（很可能是同一实体）',
                hint: '统一 ID 规范后合并；ID 是实体唯一标识，不应存在近重复。',
                sample: normalizedIds,
            });
        }

        const base = await this.validate() as any;
        for (const check of base.checks || []) {
            const numeric = Number(check.value);
            const isNumeric = Number.isFinite(numeric);
            push({
                code: String(check.check),
                severity: check.severity === 'info' ? 'info' : 'error',
                count: isNumeric ? numeric : 0,
                message: String(check.hint || check.check),
                hint: check.severity === 'info' ? '参考项，不影响合规判定。' : '执行 kg_admin validate / reindex 修复后复检。',
            });
        }

        const severityRank: Record<string, number> = { error: 0, warning: 1, info: 2 };
        diagnostics.sort((a, b) => (severityRank[a.severity] - severityRank[b.severity]) || (b.count - a.count));
        const errors = diagnostics.filter((item) => item.severity === 'error');
        const warnings = diagnostics.filter((item) => item.severity === 'warning');
        const infos = diagnostics.filter((item) => item.severity === 'info');
        return {
            ok: errors.length === 0 && (!strict || warnings.length === 0),
            strict,
            deep,
            errorCount: errors.length,
            warningCount: warnings.length,
            infoCount: infos.length,
            errorRows: errors.reduce((total, item) => total + item.count, 0),
            warningRows: warnings.reduce((total, item) => total + item.count, 0),
            diagnostics: diagnostics.slice(0, maxIssues),
            vocab: {
                classes: classNames.size,
                properties: propertyNames.size,
                identityKeys: identityDefs.map((def) => def.key),
            },
            elapsedMs: Date.now() - started,
        };
    }

    // ─── 实体合并（owl:sameAs 归一） ─────────────────────────

    public async mergeEntities(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        const con = this.requireConnection();
        const source = this.requireString(payload.source, 'source');
        const target = this.requireString(payload.target, 'target');
        if (source === target) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, 'source 与 target 不能相同。');
        }
        if (payload.confirm !== true) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                'kg_merge 会删除 source 并改接关系，需要 confirm: true。',
            );
        }
        const keep = String(payload.keepProps || 'merge').trim().toLowerCase();
        if (!['target', 'source', 'merge'].includes(keep)) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, 'keepProps 只支持 target / source / merge。');
        }
        const started = Date.now();
        const rows = await this.rows(
            'SELECT id, type, name, props FROM kg_nodes WHERE id IN (?, ?)',
            [source, target],
        ) as any[];
        const sourceRow = rows.find((row) => String(row.id) === source);
        const targetRow = rows.find((row) => String(row.id) === target);
        if (!sourceRow || !targetRow) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                `source/target 必须都已存在：source=${sourceRow ? '存在' : '缺失'}，target=${targetRow ? '存在' : '缺失'}。`,
            );
        }
        const parseProps = (value: unknown): Record<string, unknown> => this.parsePropsObject(value);
        const sourceProps = parseProps(sourceRow.props);
        const targetProps = parseProps(targetRow.props);
        const mergedProps = keep === 'target'
            ? { ...targetProps }
            : keep === 'source'
                ? { ...targetProps, ...sourceProps }
                : { ...sourceProps, ...targetProps };

        const movingEdges = await this.rows(
            'SELECT src, dst, type FROM kg_edges WHERE src = ? OR dst = ?',
            [source, source],
        ) as any[];
        const selfLoops = movingEdges.filter((edge) => (
            (String(edge.src) === source ? target : String(edge.src)) === (String(edge.dst) === source ? target : String(edge.dst))
        )).length;

        await con.run('BEGIN TRANSACTION');
        try {
            await con.run(
                `UPDATE kg_nodes SET props = CAST(? AS JSON), updated_at = now() WHERE id = ?`,
                [JSON.stringify(mergedProps), target],
            );
            await con.run(
                `INSERT INTO kg_edges (src, dst, type, weight, props)
                 SELECT ?, dst, type, weight, props FROM kg_edges
                 WHERE src = ? AND dst <> ?
                 ON CONFLICT (src, dst, type) DO NOTHING`,
                [target, source, target],
            );
            await con.run(
                `INSERT INTO kg_edges (src, dst, type, weight, props)
                 SELECT src, ?, type, weight, props FROM kg_edges
                 WHERE dst = ? AND src <> ?
                 ON CONFLICT (src, dst, type) DO NOTHING`,
                [target, source, target],
            );
            await con.run('DELETE FROM kg_edge_props WHERE src = ? OR dst = ?', [source, source]);
            const deletedEdges = (await con.run(
                'DELETE FROM kg_edges WHERE src = ? OR dst = ?',
                [source, source],
            )).rowsChanged;
            await con.run('DELETE FROM kg_node_props WHERE node_id = ?', [source]);
            await con.run('DELETE FROM kg_identity WHERE node_id IN (?, ?)', [source, target]);
            await con.run('DELETE FROM kg_nodes WHERE id = ?', [source]);

            const nodeDefs = await this.loadAttrDefs('node');
            await this.syncNodeAttrIndex([target], nodeDefs);
            const edgeDefs = await this.loadAttrDefs('edge');
            const affected = await this.rows(
                'SELECT src, dst, type FROM kg_edges WHERE src = ? OR dst = ?',
                [target, target],
            ) as any[];
            await this.syncEdgeAttrIndex(
                affected.map((edge) => ({ src: String(edge.src), dst: String(edge.dst), type: String(edge.type) })),
                edgeDefs,
            );
            const identityRows = await this.syncIdentityIndex([target]);
            await con.run('COMMIT');
            return {
                source, target, keepProps: keep,
                movedEdges: movingEdges.length,
                deletedEdges,
                droppedSelfLoops: selfLoops,
                identityRows,
                props: Object.keys(mergedProps),
                elapsedMs: Date.now() - started,
            };
        } catch (error) {
            await con.run('ROLLBACK').catch(() => undefined);
            throw error;
        }
    }

    private normalizeEnumValues(value: unknown, type: AttrType): string[] | null {
        if (value === undefined || value === null) return null;
        if (!Array.isArray(value) || value.length === 0) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, 'enum 需要非空数组。');
        }
        if (value.length > 200) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.limitExceeded, 'enum 最多 200 个值。');
        }
        if (type === 'json') {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, 'json 类型不支持 enum。');
        }
        if (type === 'number' && !value.every((item) => Number.isFinite(Number(item)))) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, 'number 类型的 enum 必须全是数字。');
        }
        if (type === 'boolean' && !value.every((item) => typeof item === 'boolean')) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, 'boolean 类型的 enum 必须全是布尔值。');
        }
        return Array.from(new Set(value.map((item) => String(item))));
    }

    private validateItemProps(
        scope: AttrScope,
        propsJson: string | null,
        defs: AttributeDefinition[],
        label: string,
        strict: boolean,
    ): string[] {
        const props = propsJson ? JSON.parse(propsJson) as Record<string, unknown> : {};
        const defMap = new Map(defs.map((def) => [def.key, def]));
        for (const def of defs) {
            const has = Object.prototype.hasOwnProperty.call(props, def.key) && props[def.key] !== null;
            if (!has) {
                if (def.required) {
                    throw new DuckDbToolError(
                        DUCKDB_ERROR_CODES.invalidRequest,
                        `${label} 缺少必填属性 "${def.key}"（${def.value_type}）。先用 kg_list_attrs 查看规范。`,
                    );
                }
                continue;
            }
            const value = props[def.key];
            if (!this.attrValueMatchesType(value, def.value_type)) {
                throw new DuckDbToolError(
                    DUCKDB_ERROR_CODES.invalidRequest,
                    `${label}.${def.key} 类型应为 ${def.value_type}，实际为 ${JSON.stringify(value)}。`,
                );
            }
            if (def.enum_values && !def.enum_values.includes(String(value))) {
                throw new DuckDbToolError(
                    DUCKDB_ERROR_CODES.invalidRequest,
                    `${label}.${def.key} 必须是枚举值之一：${def.enum_values.join(', ')}；实际为 ${JSON.stringify(value)}。`,
                );
            }
        }

        const unknownKeys = Object.keys(props).filter((key) => !defMap.has(key));
        if (unknownKeys.length && strict) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                `${label} 含未声明属性（strictProps=true）：${unknownKeys.join(', ')}。请先用 kg_define_attr 声明。`,
            );
        }
        if (unknownKeys.length) {
            const preview = unknownKeys.slice(0, 5).join(', ');
            return [`${label} 含未声明属性：${preview}${unknownKeys.length > 5 ? ' …' : ''}`];
        }
        return [];
    }

    private attrValueMatchesType(value: unknown, type: AttrType): boolean {
        switch (type) {
            case 'string': return typeof value === 'string';
            case 'number': return typeof value === 'number' && Number.isFinite(value);
            case 'boolean': return typeof value === 'boolean';
            case 'date': return typeof value === 'string' && !Number.isNaN(Date.parse(value));
            case 'json': return true;
            default: return false;
        }
    }

    private async syncNodeAttrIndex(ids: string[], defs: AttributeDefinition[]): Promise<void> {
        const indexed = defs.filter((def) => def.indexed && def.value_type !== 'json');
        if (!indexed.length || !ids.length) return;
        const con = this.requireConnection();
        const idJson = jsonListParam(ids);
        for (const def of indexed) {
            const expressions = this.attrIndexExpressions(def);
            await con.run(
                `DELETE FROM kg_node_props WHERE key = ? AND node_id IN (
                    SELECT json_extract_string(value, '$') FROM json_each(?::JSON)
                 )`,
                [def.key, idJson],
            );
            await con.run(
                `INSERT INTO kg_node_props (node_id, key, val_text, val_num)
                 SELECT id, ?, ${expressions.text}, ${expressions.num}
                 FROM kg_nodes
                 WHERE id IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))
                   AND ${expressions.present}`,
                [def.key, idJson],
            );
        }
    }

    private async syncEdgeAttrIndex(
        edgeKeys: { src: string; dst: string; type: string }[],
        defs: AttributeDefinition[],
    ): Promise<void> {
        const indexed = defs.filter((def) => def.indexed && def.value_type !== 'json');
        if (!indexed.length || !edgeKeys.length) return;
        const con = this.requireConnection();
        const keyJson = JSON.stringify(edgeKeys);
        const matchedKeys = `SELECT json_extract_string(value, '$.src') AS src,
                                    json_extract_string(value, '$.dst') AS dst,
                                    json_extract_string(value, '$.type') AS type
                             FROM json_each(?::JSON)`;
        for (const def of indexed) {
            const expressions = this.attrIndexExpressions(def);
            await con.run(
                `DELETE FROM kg_edge_props p WHERE p.key = ? AND EXISTS (
                    SELECT 1 FROM (${matchedKeys}) k
                    WHERE p.src = k.src AND p.dst = k.dst AND p.type = k.type
                 )`,
                [def.key, keyJson],
            );
            await con.run(
                `INSERT INTO kg_edge_props (src, dst, type, key, val_text, val_num)
                 SELECT e.src, e.dst, e.type, ?, ${expressions.text}, ${expressions.num}
                 FROM kg_edges e
                 WHERE EXISTS (
                    SELECT 1 FROM (${matchedKeys}) k
                    WHERE e.src = k.src AND e.dst = k.dst AND e.type = k.type
                 ) AND ${expressions.present}`,
                [def.key, keyJson],
            );
        }
    }

    // ─── 批量导入 ──────────────────────────────────────────

    public async importData(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        const con = this.requireConnection();
        const target = String(payload.target || '').trim().toLowerCase();
        if (target !== 'nodes' && target !== 'edges') {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                'target 必须是 nodes 或 edges。',
            );
        }
        const filePath = this.resolveWorkspaceFile(payload.path, 'path');
        const format = this.normalizeFormat(
            payload.format || this.inferFormat(filePath),
            ['json', 'csv', 'parquet'],
        );
        const sourceSql = this.buildScanSql(filePath, format);
        const columnMap = (payload.columnMap && typeof payload.columnMap === 'object')
            ? payload.columnMap as Record<string, unknown>
            : {};
        const mode = String(payload.mode || 'merge').toLowerCase();
        if (mode !== 'merge' && mode !== 'replace') {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, 'mode 只支持 merge / replace。');
        }
        if (mode === 'replace' && payload.confirm !== true) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                'replace 模式会先清空目标表，需要 confirm: true。',
            );
        }

        const description = await this.rows(`DESCRIBE SELECT * FROM ${sourceSql}`);
        const available = new Map<string, string>(
            description.map((row: any) => [String(row.column_name), String(row.column_type)]),
        );
        const required = target === 'nodes' ? ['id', 'type'] : ['src', 'dst', 'type'];
        for (const key of required) {
            const column = typeof columnMap[key] === 'string' ? String(columnMap[key]) : key;
            assertSafeIdentifier(column, `columnMap.${key}`);
            if (!available.has(column)) {
                throw new DuckDbToolError(
                    DUCKDB_ERROR_CODES.invalidRequest,
                    `源文件缺少列 ${column}（${target}.${key}）。可用列：${Array.from(available.keys()).join(', ')}`,
                );
            }
        }

        const columnExpr = (key: string, fallback: string): string => {
            const mapped = typeof columnMap[key] === 'string' ? String(columnMap[key]) : key;
            if (!available.has(mapped)) return fallback;
            assertSafeIdentifier(mapped, `columnMap.${key}`);
            return mapped;
        };
        const stringExpr = (key: string, fallback: string): string => {
            const mapped = columnExpr(key, '');
            if (!mapped) return fallback;
            const type = available.get(mapped) || '';
            if (/^json$/i.test(type)) {
                return `json_extract_string(${mapped}, '$')`;
            }
            return `CAST(${mapped} AS VARCHAR)`;
        };
        const propsExpr = (key: string): string => {
            const mapped = columnExpr(key, '');
            if (!mapped) return 'NULL::JSON';
            const type = available.get(mapped) || '';
            if (/^(json|struct|map)\b/i.test(type) || /\[\]$/.test(type)) {
                return `to_json(${mapped})`;
            }
            return `CAST(${mapped} AS JSON)`;
        };

        const started = Date.now();
        await con.run('BEGIN TRANSACTION');
        try {
            if (mode === 'replace') {
                await con.run(target === 'nodes' ? 'DELETE FROM kg_nodes' : 'DELETE FROM kg_edges');
            }
            let result;
            if (target === 'nodes') {
                const select = `
                    SELECT ${stringExpr('id', 'NULL')} AS id,
                           ${stringExpr('type', 'NULL')} AS type,
                           ${stringExpr('name', 'NULL')} AS name,
                           ${propsExpr('props')} AS props
                    FROM ${sourceSql}`;
                result = await con.run(`
                    INSERT INTO kg_nodes (id, type, name, props)
                    SELECT id, type, COALESCE(name, ''), props FROM (${select}) s
                    WHERE id IS NOT NULL AND type IS NOT NULL
                    ON CONFLICT (id) DO UPDATE SET
                        type = excluded.type,
                        name = excluded.name,
                        props = COALESCE(excluded.props, kg_nodes.props),
                        updated_at = now()`);
            } else {
                const select = `
                    SELECT ${stringExpr('src', 'NULL')} AS src,
                           ${stringExpr('dst', 'NULL')} AS dst,
                           ${stringExpr('type', 'NULL')} AS type,
                           COALESCE(CAST(${columnExpr('weight', 'NULL')} AS DOUBLE), 1.0) AS weight,
                           ${propsExpr('props')} AS props
                    FROM ${sourceSql}`;
                result = await con.run(`
                    INSERT INTO kg_edges (src, dst, type, weight, props)
                    SELECT src, dst, type, weight, props FROM (${select}) s
                    WHERE src IS NOT NULL AND dst IS NOT NULL AND type IS NOT NULL
                    ON CONFLICT (src, dst, type) DO UPDATE SET
                        weight = excluded.weight,
                        props = COALESCE(excluded.props, kg_edges.props),
                        updated_at = now()`);
            }
            const attrScope: AttrScope = target === 'nodes' ? 'node' : 'edge';
            await con.run('COMMIT');
            const indexedRows = await this.rebuildScopeIndex(attrScope);
            const identityRows = target === 'nodes' ? await this.rebuildIdentityIndex() : 0;
            return {
                target,
                mode,
                format,
                path: filePath,
                columns: Array.from(available.keys()),
                changed: result.rowsChanged,
                indexedRows,
                identityRows,
                elapsedMs: Date.now() - started,
            };
        } catch (error) {
            await con.run('ROLLBACK').catch(() => undefined);
            throw error;
        }
    }

    public async findItems(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
        const scopeParam = String(payload.scope || 'nodes').trim().toLowerCase();
        if (scopeParam !== 'nodes' && scopeParam !== 'edges') {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, 'scope 只支持 nodes / edges。');
        }
        const isNode = scopeParam === 'nodes';
        const started = Date.now();
        const predicates = normalizePredicates(payload.filter, 'filter');
        const propKeys = normalizePropKeys(payload.propKeys);
        const types = normalizeStringArray(payload.types, 'types');
        const limit = clampInt(payload.limit, 1, 500, 50);
        const defs = await this.loadAttrDefs(isNode ? 'node' : 'edge');
        const defMap = new Map(defs.map((def) => [def.key, def]));
        const undeclaredKeys = [...new Set(predicates.map((predicate) => predicate.key))]
            .filter((key) => !defMap.has(key));
        const params: SqlParam[] = [];
        const where: string[] = [];
        let usedIndex = false;

        for (const predicate of predicates) {
            const def = defMap.get(predicate.key);
            const candidate = def?.indexed
                ? this.buildIndexCandidateSql(isNode, def, predicate, params)
                : null;
            if (candidate) {
                where.push(candidate);
                usedIndex = true;
                continue;
            }
            const sql = buildAttrPredicateSql([predicate], isNode ? 'n' : 'e', params);
            if (sql) where.push(`(${sql})`);
        }

        if (types.length) {
            params.push(jsonListParam(types));
            where.push(`${isNode ? 'n' : 'e'}.type IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))`);
        }
        if (!isNode) {
            const srcIds = normalizeStringArray(payload.srcIds, 'srcIds', 200);
            const dstIds = normalizeStringArray(payload.dstIds, 'dstIds', 200);
            if (srcIds.length) {
                params.push(jsonListParam(srcIds));
                where.push(`e.src IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))`);
            }
            if (dstIds.length) {
                params.push(jsonListParam(dstIds));
                where.push(`e.dst IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))`);
            }
        }

        const alias = isNode ? 'n' : 'e';
        const table = isNode ? 'kg_nodes n' : 'kg_edges e';
        const columns = isNode
            ? 'n.id, n.type, n.name'
            : 'e.src, e.dst, e.type, e.weight';
        const propsExpr = propKeys.length
            ? `, json_strip_nulls(json_object(${propKeys.map((key) => `'${key}', json_extract(${alias}.props, '$."${key}"')`).join(', ')})) AS props`
            : '';
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const order = isNode ? 'n.id' : 'e.src, e.dst, e.type';

        const total = Number(await this.scalar(
            `SELECT count(*)::BIGINT AS c FROM ${table} ${whereSql}`,
            params,
        ) || 0);
        const items = this.parsePropsRows(await this.rows(
            `SELECT ${columns}${propsExpr} FROM ${table} ${whereSql} ORDER BY ${order} LIMIT ?`,
            [...params, limit],
        ));
        return {
            scope: scopeParam,
            items,
            total,
            limit,
            truncated: total > items.length,
            usedIndex,
            undeclaredKeys,
            elapsedMs: Date.now() - started,
        };
    }

    private buildIndexCandidateSql(
        isNode: boolean,
        def: AttributeDefinition,
        predicate: AttrPredicate,
        params: SqlParam[],
    ): string | null {
        const value = predicate.value;
        const start = params.length;
        let condition: string | null = null;
        const numeric = def.value_type === 'number' || def.value_type === 'boolean' || def.value_type === 'date';

        switch (predicate.op) {
            case 'eq': {
                if (value === null || value === undefined) return null;
                if (def.value_type === 'number') {
                    params.push(Number(value));
                    condition = 'val_num = ?';
                } else if (def.value_type === 'boolean') {
                    params.push(value === true || value === 'true' ? 1 : 0);
                    condition = 'val_num = ?';
                } else if (def.value_type === 'date') {
                    const epoch = Date.parse(String(value));
                    if (!Number.isFinite(epoch)) return null;
                    params.push(epoch);
                    condition = 'val_num = ?';
                } else {
                    params.push(String(value));
                    condition = 'val_text = ?';
                }
                break;
            }
            case 'gt':
            case 'gte':
            case 'lt':
            case 'lte': {
                if (!numeric) return null;
                const operator = predicate.op === 'gt' ? '>'
                    : predicate.op === 'gte' ? '>='
                        : predicate.op === 'lt' ? '<' : '<=';
                if (def.value_type === 'date') {
                    const epoch = Date.parse(String(value));
                    if (!Number.isFinite(epoch)) return null;
                    params.push(epoch);
                } else if (def.value_type === 'boolean') {
                    params.push(value === true || value === 'true' ? 1 : 0);
                } else {
                    params.push(Number(value));
                }
                condition = `val_num ${operator} ?`;
                break;
            }
            case 'in': {
                const values = Array.isArray(value) ? value : [];
                if (!values.length) return null;
                if (def.value_type === 'boolean') {
                    params.push(jsonListParam(values.map((item) => (
                        item === true || item === 'true' ? '1' : '0'
                    ))));
                    condition = `val_num IN (SELECT CAST(json_extract_string(value, '$') AS DOUBLE) FROM json_each(?::JSON))`;
                } else if (def.value_type === 'number') {
                    params.push(jsonListParam(values.map((item) => String(item))));
                    condition = `val_num IN (SELECT CAST(json_extract_string(value, '$') AS DOUBLE) FROM json_each(?::JSON))`;
                } else if (def.value_type === 'date') {
                    params.push(jsonListParam(values.map((item) => String(item))));
                    condition = `val_num IN (SELECT epoch_ms(TRY_CAST(json_extract_string(value, '$') AS TIMESTAMP)) FROM json_each(?::JSON))`;
                } else {
                    params.push(jsonListParam(values.map((item) => String(item))));
                    condition = `val_text IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))`;
                }
                break;
            }
            default:
                return null;
        }
        if (!condition) {
            params.length = start;
            return null;
        }
        // key 的 ? 在 SQL 中最先出现，需插到条件参数之前。
        params.splice(start, 0, def.key);

        return isNode
            ? `n.id IN (SELECT node_id FROM kg_node_props WHERE key = ? AND ${condition})`
            : `EXISTS (SELECT 1 FROM kg_edge_props p
                       WHERE p.src = e.src AND p.dst = e.dst AND p.type = e.type
                         AND p.key = ? AND ${condition})`;
    }

    // ─── 内部工具 ──────────────────────────────────────────

    private normalizeParams(value: unknown): SqlParam[] {
        if (value === undefined || value === null) return [];
        if (!Array.isArray(value)) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                'params 必须是标量数组（string/number/boolean/null）。',
            );
        }
        return value.map((item, index) => {
            if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
            if (typeof item === 'number' && Number.isFinite(item)) return item;
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                `params[${index}] 只支持标量；数组/对象请改写成 JSON 字符串再用 ?::JSON 解析。`,
            );
        });
    }

    private normalizeDirection(value: unknown): 'out' | 'in' | 'both' {
        const direction = String(value || 'both').trim().toLowerCase();
        if (direction === 'out' || direction === 'in' || direction === 'both') {
            return direction;
        }
        throw new DuckDbToolError(
            DUCKDB_ERROR_CODES.invalidRequest,
            'direction 只支持 out / in / both。',
        );
    }

    private normalizeFormat(value: unknown, allowed: string[]): string {
        const format = String(value || '').trim().toLowerCase();
        if (!allowed.includes(format)) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                `format 只支持 ${allowed.join(' / ')}。`,
            );
        }
        return format;
    }

    private inferFormat(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.json' || ext === '.ndjson' || ext === '.jsonl') return 'json';
        if (ext === '.csv' || ext === '.tsv') return 'csv';
        if (ext === '.parquet') return 'parquet';
        throw new DuckDbToolError(
            DUCKDB_ERROR_CODES.invalidRequest,
            '无法从扩展名推断格式，请显式传 format。',
        );
    }

    private buildScanSql(filePath: string, format: string): string {
        const literal = this.escapeLiteral(filePath);
        if (format === 'json') return `read_json_auto('${literal}')`;
        if (format === 'csv') return `read_csv_auto('${literal}')`;
        return `read_parquet('${literal}')`;
    }

    private resolveWorkspaceFile(value: unknown, label: string): string {
        const workspaceRoot = this.openOptions?.workspaceRoot;
        if (!workspaceRoot) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.notOpen, 'DuckDB 尚未打开。');
        }
        const raw = this.requireString(value, label);
        const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspaceRoot, raw);
        const rel = path.relative(path.resolve(workspaceRoot), abs);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.pathRejected,
                `${label} 必须位于工作区内。`,
            );
        }
        if (/\.(duckdb|wal)(\.|$)/i.test(abs)) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.pathRejected,
                `禁止直接读写数据库文件（${path.basename(abs)}）。请通过 kg_* 工具操作。`,
            );
        }
        return abs;
    }

    private validateNodes(value: unknown): Record<string, unknown>[] {
        if (value === undefined || value === null) return [];
        if (!Array.isArray(value)) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, 'nodes 必须是数组。');
        }
        return value.map((item: any, index: number) => {
            if (!item || typeof item !== 'object') {
                throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, `nodes[${index}] 必须是对象。`);
            }
            const id = this.requireString(item.id, `nodes[${index}].id`);
            const type = this.requireString(item.type, `nodes[${index}].type`);
            const name = item.name === undefined || item.name === null
                ? ''
                : this.requireString(item.name, `nodes[${index}].name`);
            return { id, type, name, props: this.normalizeProps(item.props, `nodes[${index}].props`) };
        });
    }

    private validateEdges(value: unknown): Record<string, unknown>[] {
        if (value === undefined || value === null) return [];
        if (!Array.isArray(value)) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, 'edges 必须是数组。');
        }
        return value.map((item: any, index: number) => {
            if (!item || typeof item !== 'object') {
                throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, `edges[${index}] 必须是对象。`);
            }
            const src = this.requireString(item.src, `edges[${index}].src`);
            const dst = this.requireString(item.dst, `edges[${index}].dst`);
            const type = this.requireString(item.type, `edges[${index}].type`);
            const weight = item.weight === undefined || item.weight === null ? 1 : Number(item.weight);
            if (!Number.isFinite(weight)) {
                throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, `edges[${index}].weight 必须是数字。`);
            }
            return { src, dst, type, weight, props: this.normalizeProps(item.props, `edges[${index}].props`) };
        });
    }

    private normalizeProps(value: unknown, label: string): string | null {
        if (value === undefined || value === null) return null;
        let json: string;
        if (typeof value === 'string') {
            json = value;
        } else {
            json = JSON.stringify(value);
        }
        if (json.length > 64 * 1024) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.limitExceeded, `${label} 超过 64KB 限制。`);
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(json);
        } catch {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, `${label} 不是合法 JSON。`);
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                `${label} 必须是 JSON 对象（key-value），不支持数组或标量。`,
            );
        }
        return json;
    }

    private requireString(value: unknown, label: string): string {
        if (typeof value !== 'string' || !value.trim()) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, `${label} 必须是非空字符串。`);
        }
        if (value.length > 512) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.limitExceeded, `${label} 超过 512 字符限制。`);
        }
        return value.trim();
    }

    private escapeLiteral(value: string): string {
        return value.replace(/'/g, "''");
    }

    private async nodeDetails(ids: string[], propKeys: string[] = []): Promise<Record<string, unknown>[]> {
        if (!ids.length) return [];
        const propsExpr = this.buildPropsProjection('n', propKeys);
        return this.parsePropsRows(await this.rows(
            `SELECT n.id, n.type, n.name${propsExpr} FROM kg_nodes n
             WHERE n.id IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))`,
            [jsonListParam(ids)],
        ));
    }

    private async edgeDetails(
        keys: { src: string; dst: string; type: string }[],
        propKeys: string[] = [],
    ): Promise<Record<string, unknown>[]> {
        const unique = Array.from(new Map(
            keys.map((key) => [`${key.src}\u001f${key.dst}\u001f${key.type}`, key]),
        ).values());
        if (!unique.length) return [];
        const propsExpr = this.buildPropsProjection('e', propKeys);
        return this.parsePropsRows(await this.rows(
            `SELECT e.src, e.dst, e.type, e.weight${propsExpr} FROM kg_edges e
             WHERE (e.src, e.dst, e.type) IN (
                SELECT json_extract_string(value, '$.src'),
                       json_extract_string(value, '$.dst'),
                       json_extract_string(value, '$.type')
                FROM json_each(?::JSON)
             )`,
            [JSON.stringify(unique)],
        ));
    }

    private async rows(sql: string, params: SqlParam[] = []): Promise<Record<string, unknown>[]> {
        const con = this.requireConnection();
        const reader = await con.runAndReadAll(sql, params);
        return reader.getRowObjectsJson() as Record<string, unknown>[];
    }

    private async scalar(sql: string, params: SqlParam[] = []): Promise<unknown> {
        const rows = await this.rows(sql, params);
        if (!rows.length) return undefined;
        return Object.values(rows[0])[0];
    }

    private async duckdbVersion(): Promise<string> {
        const value = await this.scalar('SELECT version() AS v');
        return String(value ?? 'unknown');
    }

    private async fileSize(filePath: string): Promise<number> {
        try {
            const stat = await fs.stat(filePath);
            return stat.size;
        } catch {
            return 0;
        }
    }
}

