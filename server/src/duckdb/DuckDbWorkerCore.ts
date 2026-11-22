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

export const KG_SCHEMA_VERSION = '1';

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
    'CREATE INDEX IF NOT EXISTS idx_kg_edges_src ON kg_edges(src)',
    'CREATE INDEX IF NOT EXISTS idx_kg_edges_dst ON kg_edges(dst)',
    'CREATE INDEX IF NOT EXISTS idx_kg_edges_type ON kg_edges(type)',
    'CREATE INDEX IF NOT EXISTS idx_kg_nodes_type ON kg_nodes(type)',
    'CREATE INDEX IF NOT EXISTS idx_kg_metrics_metric ON kg_metrics(metric)',
];

const NODE_UPSERT_SQL = `
    INSERT INTO kg_nodes (id, type, name, props)
    SELECT
        json_extract_string(j.value, '$.id'),
        json_extract_string(j.value, '$.type'),
        COALESCE(json_extract_string(j.value, '$.name'), ''),
        json_extract(j.value, '$.props')
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
        json_extract(j.value, '$.props')
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

type SqlParam = string | number | boolean | null;

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
            await con.run(
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
                    (SELECT count(*)::BIGINT FROM kg_metrics) AS metrics`,
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
        const indexes = await this.rows(
            `SELECT index_name, table_name, is_unique, expressions
             FROM duckdb_indexes() WHERE table_name IN ('kg_nodes','kg_edges','kg_metrics')
             ORDER BY table_name, index_name`,
        );
        return {
            schemaVersion: KG_SCHEMA_VERSION,
            tables: {
                kg_nodes: nodes,
                kg_edges: edges,
                kg_metrics: metrics,
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
        const counts = await this.stats();
        return { checks: results, stats: counts };
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

        const started = Date.now();
        await con.run('BEGIN TRANSACTION');
        try {
            let changedNodes = 0;
            let changedEdges = 0;
            if (nodes.length) {
                const result = await con.run(NODE_UPSERT_SQL, [JSON.stringify(nodes)]);
                changedNodes = result.rowsChanged;
            }
            if (edges.length) {
                const result = await con.run(EDGE_UPSERT_SQL, [JSON.stringify(edges)]);
                changedEdges = result.rowsChanged;
            }
            await con.run('COMMIT');
            return {
                nodes: nodes.length,
                edges: edges.length,
                changedNodes,
                changedEdges,
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
                changedEdges = (await con.run('DELETE FROM kg_edges')).rowsChanged;
                changedNodes = (await con.run('DELETE FROM kg_nodes')).rowsChanged;
            } else {
                if (nodeIds.length) {
                    const json = jsonListParam(nodeIds);
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
                    changedEdges += (await con.run(
                        `DELETE FROM kg_edges WHERE type ${ID_LIST_PREDICATE}`,
                        [jsonListParam(edgeTypes)],
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
                        [JSON.stringify(normalized)],
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
        const buildWalkCte = (name: 'walk_out' | 'walk_in'): string => {
            const outward = name === 'walk_out';
            params.push(jsonListParam(startIds));
            let edgeFilter = '';
            if (edgeTypes.length) {
                params.push(jsonListParam(edgeTypes));
                edgeFilter = ` AND e.type IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))`;
            }
            const nextExpr = outward ? 'e.dst' : 'e.src';
            const joinColumn = outward ? 'e.src' : 'e.dst';
            return `${name}(id, depth) AS (
                SELECT json_extract_string(value, '$') AS id, 0 AS depth FROM json_each(?::JSON)
                UNION
                SELECT ${nextExpr}, ${name}.depth + 1
                FROM ${name} JOIN kg_edges e ON ${joinColumn} = ${name}.id
                WHERE ${name}.depth < ${depth}${edgeFilter}
            )`;
        };

        let cteSql: string;
        let unionSql: string;
        if (direction === 'both') {
            // 真正的无向可达性：同一层内既走 src→dst 也走 dst→src，
            // LATERAL + 两个索引友好的分支比 OR 连接更快（1M 边实测约 100ms/3 跳）。
            params.push(jsonListParam(startIds));
            let outFilter = '';
            let inFilter = '';
            if (edgeTypes.length) {
                const listParam = jsonListParam(edgeTypes);
                params.push(listParam);
                outFilter = ` AND e.type IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))`;
                params.push(listParam);
                inFilter = ` AND e.type IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))`;
            }
            cteSql = `WITH RECURSIVE walk(id, depth) AS (
                SELECT json_extract_string(value, '$') AS id, 0 AS depth FROM json_each(?::JSON)
                UNION
                SELECT nb.next_id, walk.depth + 1
                FROM walk, LATERAL (
                    SELECT e.dst AS next_id FROM kg_edges e WHERE e.src = walk.id${outFilter}
                    UNION ALL
                    SELECT e.src AS next_id FROM kg_edges e WHERE e.dst = walk.id${inFilter}
                ) nb
                WHERE walk.depth < ${depth}
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
            const nodeRows = await this.rows(
                `SELECT n.id, n.type, n.name, n.props, v.depth
                 FROM kg_walk_view v JOIN kg_nodes n ON n.id = v.id
                 ORDER BY v.depth, n.id
                 LIMIT ?`,
                [maxNodes],
            );

            const totalEdges = Number(await this.scalar(
                `SELECT count(*)::BIGINT AS c FROM kg_edges e
                 JOIN kg_walk_view s ON s.id = e.src
                 JOIN kg_walk_view t ON t.id = e.dst`,
            ) || 0);
            const edgeRows = await this.rows(
                `SELECT e.src, e.dst, e.type, e.weight
                 FROM kg_edges e
                 JOIN kg_walk_view s ON s.id = e.src
                 JOIN kg_walk_view t ON t.id = e.dst
                 ORDER BY e.src, e.dst, e.type
                 LIMIT ?`,
                [maxEdges],
            );

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
        const started = Date.now();

        if (from === to) {
            return {
                from, to, direction, paths: [{ nodes: [from], length: 0 }],
                nodes: await this.nodeDetails([from]), truncated: false,
                elapsedMs: Date.now() - started,
            };
        }

        // 逐层 BFS：每层只保留「首次到达」的边界，工作量 O(V+E)，
        // 避免递归 CTE 在稠密图上按路径数指数爆炸（10 万边/20 出度时旧实现 6 跳即超时）。
        const params: SqlParam[] = [];
        let nextExpr: string;
        let fromSql: string;
        let edgeFilter = '';
        if (direction === 'both') {
            let outFilter = '';
            let inFilter = '';
            if (edgeTypes.length) {
                const listParam = jsonListParam(edgeTypes);
                params.push(listParam, listParam);
                outFilter = ` AND e.type IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))`;
                inFilter = ` AND e.type IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))`;
            }
            nextExpr = 'nb.next_id';
            fromSql = `kg_path_frontier f, LATERAL (
                SELECT e.dst AS next_id FROM kg_edges e WHERE e.src = f.id${outFilter}
                UNION ALL
                SELECT e.src AS next_id FROM kg_edges e WHERE e.dst = f.id${inFilter}
            ) nb`;
        } else if (direction === 'out') {
            nextExpr = 'e.dst';
            fromSql = 'kg_path_frontier f JOIN kg_edges e ON e.src = f.id';
        } else {
            nextExpr = 'e.src';
            fromSql = 'kg_path_frontier f JOIN kg_edges e ON e.dst = f.id';
        }
        if (direction !== 'both' && edgeTypes.length) {
            params.push(jsonListParam(edgeTypes));
            edgeFilter = ` AND e.type IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))`;
        }

        try {
            await con.run('CREATE OR REPLACE TEMP TABLE kg_path_visited (id VARCHAR, depth INTEGER, parent VARCHAR)');
            await con.run('CREATE OR REPLACE TEMP TABLE kg_path_frontier AS SELECT ?::VARCHAR AS id', [from]);
            await con.run('INSERT INTO kg_path_visited VALUES (?, 0, NULL)', [from]);

            let foundDepth = -1;
            for (let depth = 1; depth <= maxDepth; depth++) {
                const sql = `
                    CREATE OR REPLACE TEMP TABLE kg_path_next AS
                    SELECT DISTINCT ${nextExpr} AS id, f.id AS parent
                    FROM ${fromSql}
                    WHERE ${nextExpr} IS NOT NULL${edgeFilter}
                      AND NOT EXISTS (
                          SELECT 1 FROM kg_path_visited v WHERE v.id = ${nextExpr}
                      )`;
                await con.run(sql, params);
                const added = Number(await this.scalar(
                    'SELECT count(*)::BIGINT AS c FROM kg_path_next',
                ) || 0);
                if (added === 0) break;
                await con.run(
                    `INSERT INTO kg_path_visited SELECT id, ${depth}, parent FROM kg_path_next`,
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
                    from, to, direction, paths: [], nodes: [],
                    truncated: false, elapsedMs: Date.now() - started,
                };
            }

            const visitedRows = await this.rows(
                'SELECT id, depth, parent FROM kg_path_visited WHERE depth <= ?',
                [foundDepth],
            );
            const parents = new Map<string, Map<number, Set<string>>>();
            for (const row of visitedRows) {
                const id = String((row as any).id);
                const depth = Number((row as any).depth);
                const parent = (row as any).parent == null ? null : String((row as any).parent);
                if (!parents.has(id)) parents.set(id, new Map());
                const byDepth = parents.get(id)!;
                if (!byDepth.has(depth)) byDepth.set(depth, new Set());
                if (parent) byDepth.get(depth)!.add(parent);
            }

            const paths: { nodes: string[]; length: number }[] = [];
            const reconstruct = (node: string, depth: number, suffix: string[]) => {
                if (paths.length >= maxPaths) return;
                if (depth === 0) {
                    paths.push({ nodes: [node, ...suffix], length: foundDepth });
                    return;
                }
                const candidates = parents.get(node)?.get(depth);
                if (!candidates) return;
                for (const parent of candidates) {
                    reconstruct(parent, depth - 1, [node, ...suffix]);
                    if (paths.length >= maxPaths) return;
                }
            };
            reconstruct(to, foundDepth, []);

            const ids = Array.from(new Set(paths.flatMap((item) => item.nodes)));
            return {
                from, to, direction,
                paths,
                nodes: await this.nodeDetails(ids),
                truncated: paths.length >= maxPaths,
                elapsedMs: Date.now() - started,
            };
        } finally {
            await con.run('DROP TABLE IF EXISTS kg_path_visited').catch(() => undefined);
            await con.run('DROP TABLE IF EXISTS kg_path_frontier').catch(() => undefined);
            await con.run('DROP TABLE IF EXISTS kg_path_next').catch(() => undefined);
        }
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
            await con.run('COMMIT');
            return {
                target,
                mode,
                format,
                path: filePath,
                columns: Array.from(available.keys()),
                changed: result.rowsChanged,
                elapsedMs: Date.now() - started,
            };
        } catch (error) {
            await con.run('ROLLBACK').catch(() => undefined);
            throw error;
        }
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
        try {
            JSON.parse(json);
        } catch {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, `${label} 不是合法 JSON。`);
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

    private async nodeDetails(ids: string[]): Promise<Record<string, unknown>[]> {
        if (!ids.length) return [];
        return await this.rows(
            `SELECT id, type, name FROM kg_nodes
             WHERE id IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))`,
            [jsonListParam(ids)],
        );
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
