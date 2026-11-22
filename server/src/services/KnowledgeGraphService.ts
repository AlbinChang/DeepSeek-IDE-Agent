/**
 * 知识图谱工具层：把 kg_* 工具参数翻译成 DuckDB Worker 请求，并把结果压缩成
 * 适合模型上下文的文本（超限时落盘到 .duckdb/exports/）。
 *
 * 数据文件（.duckdb/kg.duckdb、.wal）只允许 Worker 进程打开；本文件不读取、
 * 不修改任何数据库文件。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { DuckDbProcessClient } from '@/duckdb/DuckDbProcessClient.js';
import { DuckDbToolError, DUCKDB_ERROR_CODES } from '@/duckdb/duckdbProtocol.js';
import { KG_LIMITS, assertSafeIdentifier } from '@/duckdb/sqlGuard.js';
import { PathUtils } from '@/utils/PathUtils.js';

interface ToolContextLike {
    abortSignal?: AbortSignal;
    userId?: string;
    traceId?: string;
}

const EXPORT_DIR = '.duckdb/exports';
const DEFAULT_MAX_BYTES = KG_LIMITS.resultBytesDefault;
const MAX_CELL_CHARS = 160;

export class KnowledgeGraphService {
    constructor(private readonly workspaceRoot: string) {}

    private get client(): DuckDbProcessClient {
        return DuckDbProcessClient.getInstance();
    }

    private get root(): string {
        return path.resolve(this.workspaceRoot);
    }

    // ─── 工具入口 ──────────────────────────────────────────

    public async admin(params: Record<string, unknown>, context?: ToolContextLike): Promise<string> {
        const action = String(params.action || 'status').trim().toLowerCase();
        if (!['status', 'schema', 'optimize', 'validate'].includes(action)) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                'action 只支持 status / schema / optimize / validate。',
            );
        }
        switch (action) {
            case 'status': {
                const stats = await this.run('stats', {}, context);
                return this.formatStats(stats);
            }
            case 'schema': {
                const schema = await this.run('schema', {}, context);
                const tables = (schema as any).tables || {};
                const lines = [
                    `[kg_admin schema] kuzu/db=${(schema as any).schemaVersion ? `v${(schema as any).schemaVersion}` : '?'} ，数据目录=.duckdb/`,
                    '',
                    '## kg_nodes（实体）',
                    this.formatTable(['column_name', 'column_type', 'null'], tables.kg_nodes || []),
                    '',
                    '## kg_edges（关系）',
                    this.formatTable(['column_name', 'column_type', 'null'], tables.kg_edges || []),
                    '',
                    '## 索引',
                    this.formatTable(['table_name', 'index_name', 'is_unique'], (schema as any).indexes || []),
                    '',
                    '提示：每条边由 (src, dst, type) 唯一确定；props 为 JSON，可用 props->>\'键\' 过滤。',
                ];
                return lines.join('\n');
            }
            case 'optimize': {
                const checkpoint = await this.run('checkpoint', {}, context);
                const stats = await this.run('stats', {}, context);
                return `[kg_admin optimize] 已 checkpoint，用时 ${(checkpoint as any).elapsedMs}ms。\n${this.formatStats(stats)}`;
            }
            case 'validate': {
                const result = await this.run('validate', {}, context);
                const checks = (result as any).checks || [];
                return [
                    '[kg_admin validate] 数据完整性检查',
                    this.formatTable(['check', 'value'], checks.map((item: any) => ({
                        check: `${item.check}（${item.hint}）`,
                        value: item.value,
                    }))),
                ].join('\n');
            }
            default:
                throw new DuckDbToolError(
                    DUCKDB_ERROR_CODES.invalidRequest,
                    'action 只支持 status / schema / optimize / validate。',
                );
        }
    }

    public async query(params: Record<string, unknown>, context?: ToolContextLike): Promise<string> {
        const sql = typeof params.sql === 'string' ? params.sql : '';
        if (!sql.trim()) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, 'kg_query 需要 sql 参数。');
        }

        if (params.outputPath !== undefined && params.outputPath !== null && String(params.outputPath).trim()) {
            const exported = await this.run('export', {
                sql,
                outputPath: String(params.outputPath),
                format: params.format || 'parquet',
            }, context);
            return [
                `[kg_query export] ${(exported as any).format} → ${this.toWorkspaceRelative((exported as any).outputPath)}`,
                `大小 ${formatBytes((exported as any).bytes)}，用时 ${(exported as any).elapsedMs}ms。`,
                '提示：导出文件位于工作区，可直接用 read_file 查看小文件样本。',
            ].join('\n');
        }

        const result = await this.run('query', {
            sql,
            params: params.params,
            maxRows: params.maxRows,
        }, context) as any;
        const header = `[kg_query] ${result.rowCount} 行${result.truncated ? '（已达到 maxRows 上限，结果被截断）' : ''} · ${result.elapsedMs}ms`;

        let text = `${header}\n${this.formatTable(result.columns, result.rows)}`;
        if (result.truncated) {
            text += `\n提示：结果超过 maxRows=${result.rowCount}，请加 WHERE/LIMIT 缩小范围，或传 outputPath 导出完整结果。`;
        }
        return await this.finalize('kg_query', text, result);
    }

    public async upsert(params: Record<string, unknown>, context?: ToolContextLike): Promise<string> {
        const nodes = Array.isArray(params.nodes) ? params.nodes : [];
        const edges = Array.isArray(params.edges) ? params.edges : [];
        if (!nodes.length && !edges.length) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                'kg_upsert 至少需要 nodes 或 edges 数组。',
            );
        }

        let writtenNodes = 0;
        let writtenEdges = 0;
        const started = Date.now();
        try {
            for (const chunk of chunkArray(nodes, KG_LIMITS.upsertChunkSize)) {
                const result = await this.run('upsert', { nodes: chunk }, context) as any;
                writtenNodes += Number(result.changedNodes ?? result.nodes ?? 0);
            }
            for (const chunk of chunkArray(edges, KG_LIMITS.upsertChunkSize)) {
                const result = await this.run('upsert', { edges: chunk }, context) as any;
                writtenEdges += Number(result.changedEdges ?? result.edges ?? 0);
            }
        } catch (error) {
            throw new Error(
                `kg_upsert 已写入 ${writtenNodes} 个节点 / ${writtenEdges} 条边后失败：${(error as Error).message}`,
            );
        }

        return [
            `[kg_upsert] 提交 ${nodes.length} 个节点 / ${edges.length} 条边`,
            `数据库变更：${writtenNodes} 行节点 / ${writtenEdges} 行边 · ${Date.now() - started}ms`,
            '语义：按主键 (节点 id) / (src,dst,type) UPSERT；未传的 props 保留原值。',
        ].join('\n');
    }

    public async delete(params: Record<string, unknown>, context?: ToolContextLike): Promise<string> {
        const result = await this.run('delete', {
            nodeIds: params.nodeIds,
            nodeTypes: params.nodeTypes,
            edgeTypes: params.edgeTypes,
            edgeKeys: params.edgeKeys,
            cascade: params.cascade !== false,
            all: params.all === true,
            confirm: params.confirm === true,
        }, context) as any;
        return [
            '[kg_delete] 完成',
            `删除节点 ${result.changedNodes} 行，删除关系 ${result.changedEdges} 行 · ${result.elapsedMs}ms`,
            params.cascade === false ? '注意：cascade=false，指向被删节点的边可能成为孤儿（可用 kg_admin validate 核验）。' : '',
        ].filter(Boolean).join('\n');
    }

    public async traverse(params: Record<string, unknown>, context?: ToolContextLike): Promise<string> {
        const result = await this.run('traverse', {
            startIds: params.startIds,
            depth: params.depth,
            direction: params.direction,
            edgeTypes: params.edgeTypes,
            nodeTypes: params.nodeTypes,
            maxNodes: params.maxNodes,
            maxEdges: params.maxEdges,
        }, context) as any;

        const nodeLines = (result.nodes || []).map((node: any) => ({
            id: node.id,
            type: node.type,
            name: node.name ?? '',
            depth: node.depth,
        }));
        const edgeLines = (result.edges || []).map((edge: any) => ({
            src: edge.src,
            dst: edge.dst,
            type: edge.type,
            weight: edge.weight,
        }));

        const header = `[kg_traverse] direction=${result.direction} depth=${result.depth} `
            + `节点 ${result.totalNodes}${result.truncated ? '（已截断）' : ''} / 边 ${result.totalEdges} · ${result.elapsedMs}ms`;
        const text = [
            header,
            '',
            `## 节点（${nodeLines.length}/${result.totalNodes}）`,
            this.formatTable(['depth', 'id', 'type', 'name'], nodeLines),
            '',
            `## 关系（${edgeLines.length}/${result.totalEdges}）`,
            this.formatTable(['src', 'dst', 'type', 'weight'], edgeLines),
        ].join('\n');
        return await this.finalize('kg_traverse', text, result);
    }

    public async path(params: Record<string, unknown>, context?: ToolContextLike): Promise<string> {
        const result = await this.run('path', {
            from: params.from,
            to: params.to,
            maxDepth: params.maxDepth,
            direction: params.direction,
            edgeTypes: params.edgeTypes,
            maxPaths: params.maxPaths,
        }, context) as any;

        const nodeMap = new Map<string, any>(
            (result.nodes || []).map((node: any) => [String(node.id), node]),
        );
        const paths: string[][] = (result.paths || []).map((item: any) => item.nodes || []);
        if (!paths.length) {
            return `[kg_path] ${result.from} → ${result.to} 未找到路径（direction=${result.direction}，maxDepth 见请求）。`
                + '\n提示：放宽 maxDepth、切换 direction=both，或先用 kg_traverse 确认连通性。';
        }
        const lines = paths.map((ids, index) => {
            const described = ids.map((id) => {
                const node = nodeMap.get(id);
                return node ? `${id}(${node.type}${node.name ? `:${node.name}` : ''})` : id;
            });
            return `${index + 1}. ${described.join(' → ')}  [${ids.length - 1} 跳]`;
        });
        return await this.finalize('kg_path', `[kg_path] ${result.from} → ${result.to}，命中 ${paths.length} 条`
            + `${result.truncated ? '（可能还有更多）' : ''} · ${result.elapsedMs}ms\n${lines.join('\n')}`, result);
    }

    public async analyze(params: Record<string, unknown>, context?: ToolContextLike): Promise<string> {
        const algorithm = String(params.algorithm || '').trim().toLowerCase();
        if (!['summary', 'degree', 'pagerank', 'components', 'communities'].includes(algorithm)) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                'algorithm 只支持 summary / degree / pagerank / components / communities。',
            );
        }
        const result = await this.run('analyze', {
            algorithm,
            topN: params.topN,
            iterations: params.iterations,
            damping: params.damping,
            tolerance: params.tolerance,
            persist: params.persist === true,
        }, context) as any;

        if (algorithm === 'summary') {
            const text = [
                `[kg_analyze summary] 节点 ${result.nodes} / 边 ${result.edges} · 活跃节点 ${result.activeNodes} · 孤立节点 ${result.isolatedNodes} · 平均度 ${round(result.avgDegree)}`,
                '',
                '## 节点类型 Top',
                this.formatTable(['type', 'count'], result.nodeTypes || []),
                '',
                '## 关系类型 Top',
                this.formatTable(['type', 'count'], result.edgeTypes || []),
                '',
                `存储：${formatBytes(result.stats?.dbBytes || 0)}（WAL ${formatBytes(result.stats?.walBytes || 0)}）· DuckDB ${result.stats?.duckdbVersion || ''}`,
            ].join('\n');
            return await this.finalize('kg_analyze_summary', text, result);
        }

        if (algorithm === 'degree') {
            const text = [
                `[kg_analyze degree] Top ${(result.top || []).length} 节点${result.persisted ? '（已写入 kg_metrics）' : ''} · ${result.elapsedMs}ms`,
                this.formatTable(['degree', 'out_degree', 'in_degree', 'id', 'type', 'name'], result.top || []),
            ].join('\n');
            return await this.finalize('kg_analyze_degree', text, result);
        }

        if (algorithm === 'pagerank') {
            const text = [
                `[kg_analyze pagerank] 迭代 ${result.iterations} 次 · ${result.converged ? '已收敛' : '未收敛（可加大 iterations）'} · maxDelta=${round(result.maxDelta)} · ${result.elapsedMs}ms`,
                this.formatTable(['score', 'id', 'type', 'name'], result.top || []),
            ].join('\n');
            return await this.finalize('kg_analyze_pagerank', text, result);
        }

        if (algorithm === 'components' || algorithm === 'communities') {
            const label = algorithm === 'components' ? '连通分量' : '社区';
            const key = algorithm === 'components' ? 'component_id' : 'community_id';
            const count = algorithm === 'components' ? result.components : result.communities;
            const text = [
                `[kg_analyze ${algorithm}] ${label} ${count} 个 · 迭代 ${result.iterations} 次 · ${result.converged ? '已收敛' : '未收敛（可加大 iterations）'} · ${result.elapsedMs}ms`,
                this.formatTable([key, 'size'], result.top || []),
                result.persisted ? '结果已写入 kg_metrics。' : '',
            ].filter(Boolean).join('\n');
            return await this.finalize(`kg_analyze_${algorithm}`, text, result);
        }

        throw new DuckDbToolError(
            DUCKDB_ERROR_CODES.invalidRequest,
            'algorithm 只支持 summary / degree / pagerank / components / communities。',
        );
    }

    public async importData(params: Record<string, unknown>, context?: ToolContextLike): Promise<string> {
        const target = String(params.target || '').trim().toLowerCase();
        if (target !== 'nodes' && target !== 'edges') {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, 'target 必须是 nodes 或 edges。');
        }
        const filePath = this.resolveWorkspacePath(String(params.path || ''), 'path');
        this.assertNotDatabaseFile(filePath);
        const columnMap = this.normalizeColumnMap(params.columnMap);
        const result = await this.run('import', {
            target,
            path: filePath,
            format: params.format,
            columnMap,
            mode: params.mode || 'merge',
            confirm: params.confirm === true,
        }, context) as any;

        return [
            `[kg_import] ${result.target} ← ${this.toWorkspaceRelative(result.path)}（${result.format}, ${result.mode}）`,
            `写入/更新 ${result.changed} 行 · ${result.elapsedMs}ms`,
            `源列：${(result.columns || []).join(', ')}`,
            result.mode === 'replace' ? '⚠ 已先清空目标表。' : '',
        ].filter(Boolean).join('\n');
    }

    // ─── 内部实现 ──────────────────────────────────────────

    private async run(
        op: Parameters<DuckDbProcessClient['run']>[1],
        payload: Record<string, unknown>,
        context?: ToolContextLike,
    ): Promise<unknown> {
        return await this.client.run(this.root, op, payload, {
            signal: context?.abortSignal,
        });
    }

    private formatTable(columns: string[], rows: Record<string, unknown>[]): string {
        if (!columns.length) return '(无列)';
        if (!rows.length) return '(0 行)';
        const header = columns.join(' | ');
        const lines = rows.map((row) => columns
            .map((column) => formatCell(row?.[column]))
            .join(' | '));
        return [header, ...lines].join('\n');
    }

    private formatStats(stats: unknown): string {
        const value = stats as any;
        return [
            `[kg_admin status] DuckDB ${value.duckdbVersion || '?'} · 数据库 ${this.toWorkspaceRelative(value.dbPath || '')}`,
            `节点 ${value.nodes} · 边 ${value.edges} · 指标 ${value.metrics}`,
            `文件 ${formatBytes(value.dbBytes || 0)}（WAL ${formatBytes(value.walBytes || 0)}）· 内存上限 ${value.memoryLimit || '?'} · threads ${value.threads || '?'}`,
            `temp_directory ${value.tempDirectory || '?'} · uptime ${Math.round((value.uptimeMs || 0) / 1000)}s · pid ${value.pid}`,
        ].join('\n');
    }

    /** 超限结果落盘，返回预览 + 文件指针，保证不撑爆模型上下文。 */
    private async finalize(toolName: string, text: string, payload: unknown): Promise<string> {
        if (Buffer.byteLength(text, 'utf8') <= DEFAULT_MAX_BYTES) return text;
        const dir = path.join(this.root, EXPORT_DIR);
        await fs.mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filePath = path.join(dir, `${toolName}-${stamp}.json`);
        await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
        const preview = text.slice(0, 6000);
        return [
            preview,
            '',
            `…（结果共 ${formatBytes(Buffer.byteLength(text, 'utf8'))}，超出上下文预算）`,
            `完整结果已写入：${this.toWorkspaceRelative(filePath)}`,
            '提示：用 kg_query 加 WHERE/LIMIT 精确取数，或配合 read_file 分段查看该 JSON。',
        ].join('\n');
    }

    private normalizeColumnMap(value: unknown): Record<string, string> {
        if (value === undefined || value === null) return {};
        if (typeof value !== 'object' || Array.isArray(value)) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, 'columnMap 必须是对象。');
        }
        const entries = Object.entries(value as Record<string, unknown>);
        if (entries.length > KG_LIMITS.importColumnsMax) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.limitExceeded,
                `columnMap 最多 ${KG_LIMITS.importColumnsMax} 项。`,
            );
        }
        const normalized: Record<string, string> = {};
        for (const [key, column] of entries) {
            assertSafeIdentifier(key, `columnMap 键 ${key}`);
            normalized[key] = assertSafeIdentifier(String(column), `columnMap.${key}`);
        }
        return normalized;
    }

    private resolveWorkspacePath(relativePath: string, label: string): string {
        const value = String(relativePath || '').trim();
        if (!value) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, `${label} 不能为空。`);
        }
        const abs = PathUtils.resolveWritePath(value, this.root);
        return abs;
    }

    private assertNotDatabaseFile(absPath: string): void {
        if (/\.(duckdb|wal)(\.|$)/i.test(absPath)) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.pathRejected,
                '禁止直接操作 .duckdb / .wal 数据库文件；请通过 kg_* 工具访问。',
            );
        }
    }

    private toWorkspaceRelative(absPath: string): string {
        if (!absPath) return '';
        try {
            return PathUtils.getRelativePath(absPath, this.root);
        } catch {
            return absPath;
        }
    }
}

function chunkArray<T>(items: T[], size: number): T[][] {
    if (!items.length) return [];
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

function formatCell(value: unknown): string {
    if (value === null || value === undefined) return '∅';
    let text: string;
    if (typeof value === 'string') {
        text = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
        text = String(value);
    } else {
        try {
            text = JSON.stringify(value);
        } catch {
            text = String(value);
        }
    }
    if (text.length > MAX_CELL_CHARS) {
        text = `${text.slice(0, MAX_CELL_CHARS)}…`;
    }
    return text.replace(/\|/g, '\\|').replace(/\r?\n/g, '\\n');
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function round(value: unknown): number {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.round(num * 1e6) / 1e6;
}
