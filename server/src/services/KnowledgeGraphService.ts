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
        if (!['status', 'schema', 'optimize', 'validate', 'reindex'].includes(action)) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                'action 只支持 status / schema / optimize / validate / reindex。',
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
                    `[kg_admin schema] duckdb=${(schema as any).schemaVersion ? `schema v${(schema as any).schemaVersion}` : '?'} ，数据目录=.duckdb/`,
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
                    '## 属性规范（kg_attr_defs）',
                    this.formatTable(['column_name', 'column_type', 'null'], tables.kg_attr_defs || []),
                    '',
                    '提示：每条边由 (src, dst, type) 唯一确定；props 为 JSON 对象，可用 props->>\'键\' 过滤。',
                ];
                return lines.join('\n');
            }
            case 'optimize': {
                const checkpoint = await this.run('checkpoint', {}, context);
                const stats = await this.run('stats', {}, context);
                return `[kg_admin optimize] 已 checkpoint，用时 ${(checkpoint as any).elapsedMs}ms。\n${this.formatStats(stats)}`;
            }
            case 'reindex': {
                const result = await this.run('attr_reindex', {}, context);
                return [
                    `[kg_admin reindex] 重建 ${(result as any).rebuiltAttributes} 个索引属性，写入 ${(result as any).indexedRows} 行属性索引`
                    + `${(result as any).identityRows !== undefined ? `，身份键 ${(result as any).identityRows} 行` : ''}。`,
                    '提示：索引用于 kg_find 与 kg_lint；props 原值不受影响。',
                ].join('\n');
            }
            case 'validate': {
                const result = await this.run('validate', {}, context);
                const checks: any[] = (result as any).checks || [];
                const issues: string[] = (result as any).issues || [];
                const drift = checks.filter((item) => String(item.check).endsWith('_index_drift')
                    && Number(item.value) !== 0);
                const lines = [
                    issues.length
                        ? `[kg_admin validate] ❌ ${issues.length} 项违规：${issues.slice(0, 10).join(', ')}${issues.length > 10 ? ' …' : ''}`
                        : '[kg_admin validate] ✅ 合规：未发现违规项（info 项仅供参考）',
                    this.formatTable(['severity', 'check', 'value', 'hint'], checks),
                ];
                if (drift.length) {
                    lines.push('', '修复：执行 kg_admin reindex 重建属性索引后重新校验。');
                }
                return lines.join('\n');
            }
            default:
                throw new DuckDbToolError(
                    DUCKDB_ERROR_CODES.invalidRequest,
                    'action 只支持 status / schema / optimize / validate / reindex。',
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
        const warnings = new Set<string>();
        const started = Date.now();
        try {
            for (const chunk of chunkArray(nodes, KG_LIMITS.upsertChunkSize)) {
                const result = await this.run('upsert', {
                    nodes: chunk,
                    strictProps: params.strictProps === true,
                    strictSchema: params.strictSchema === true,
                }, context) as any;
                writtenNodes += Number(result.changedNodes ?? result.nodes ?? 0);
                for (const warning of result.warnings || []) warnings.add(String(warning));
            }
            for (const chunk of chunkArray(edges, KG_LIMITS.upsertChunkSize)) {
                const result = await this.run('upsert', {
                    edges: chunk,
                    strictProps: params.strictProps === true,
                    strictSchema: params.strictSchema === true,
                }, context) as any;
                writtenEdges += Number(result.changedEdges ?? result.edges ?? 0);
                for (const warning of result.warnings || []) warnings.add(String(warning));
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
            warnings.size ? `⚠ ${Array.from(warnings).slice(0, 5).join('；')}` : '',
        ].filter(Boolean).join('\n');
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
            nodeFilter: params.nodeFilter,
            edgeFilter: params.edgeFilter,
            nodePropKeys: params.nodePropKeys,
            edgePropKeys: params.edgePropKeys,
            maxNodes: params.maxNodes,
            maxEdges: params.maxEdges,
        }, context) as any;

        const nodeLines = (result.nodes || []).map((node: any) => ({
            id: node.id,
            type: node.type,
            name: node.name ?? '',
            depth: node.depth,
            ...(node.props !== undefined ? { props: node.props } : {}),
        }));
        const edgeLines = (result.edges || []).map((edge: any) => ({
            src: edge.src,
            dst: edge.dst,
            type: edge.type,
            weight: edge.weight,
            ...(edge.props !== undefined ? { props: edge.props } : {}),
        }));

        const header = `[kg_traverse] direction=${result.direction} depth=${result.depth} `
            + `节点 ${result.totalNodes}${result.truncated ? '（已截断）' : ''} / 边 ${result.totalEdges} · ${result.elapsedMs}ms`;
        const nodeColumns = nodeLines.some((line: any) => 'props' in line)
            ? ['depth', 'id', 'type', 'name', 'props']
            : ['depth', 'id', 'type', 'name'];
        const edgeColumns = edgeLines.some((line: any) => 'props' in line)
            ? ['src', 'dst', 'type', 'weight', 'props']
            : ['src', 'dst', 'type', 'weight'];
        const text = [
            header,
            '',
            `## 节点（${nodeLines.length}/${result.totalNodes}）`,
            this.formatTable(nodeColumns, nodeLines),
            '',
            `## 关系（${edgeLines.length}/${result.totalEdges}）`,
            this.formatTable(edgeColumns, edgeLines),
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
            nodeFilter: params.nodeFilter,
            edgeFilter: params.edgeFilter,
            hopFilters: params.hopFilters,
            nodePropKeys: params.nodePropKeys,
            edgePropKeys: params.edgePropKeys,
            maxPaths: params.maxPaths,
        }, context) as any;

        const nodeMap = new Map<string, any>(
            (result.nodes || []).map((node: any) => [String(node.id), node]),
        );
        const edgeMap = new Map<string, any>(
            (result.edges || []).map((edge: any) => [`${edge.src}\u001f${edge.dst}\u001f${edge.type}`, edge]),
        );
        const describeNode = (id: string): string => {
            const node = nodeMap.get(id);
            if (!node) return id;
            const props = node.props ? ` ${formatCell(node.props)}` : '';
            return `${id}(${node.type}${node.name ? `:${node.name}` : ''})${props}`;
        };
        const describeEdge = (edge: any): string => {
            const detail = edgeMap.get(`${edge.src}\u001f${edge.dst}\u001f${edge.type}`);
            const props = detail?.props ? ` ${formatCell(detail.props)}` : '';
            const weight = detail?.weight ?? edge.weight;
            return `-[${edge.type}${weight != null ? `:${weight}` : ''}]->${props}`;
        };

        const paths: any[] = result.paths || [];
        if (!paths.length) {
            return `[kg_path] ${result.from} → ${result.to} 未找到路径（direction=${result.direction}，maxDepth=${result.maxDepth ?? params.maxDepth ?? KG_LIMITS.pathDepthDefault}）。`
                + '\n提示：放宽 maxDepth、切换 direction=both，或先用 kg_find/kg_traverse 确认连通性。';
        }
        const lines = paths.map((path: any, index: number) => {
            const nodes: string[] = path.nodes || [];
            const edges: any[] = path.edges || [];
            let rendered = describeNode(nodes[0]);
            for (let i = 0; i < edges.length; i++) {
                rendered += ` ${describeEdge(edges[i])} ${describeNode(nodes[i + 1])}`;
            }
            return `${index + 1}. ${rendered}  [${path.length} 跳]`;
        });

        const edgeLines = (result.edges || []).map((edge: any) => ({
            src: edge.src,
            dst: edge.dst,
            type: edge.type,
            weight: edge.weight,
            ...(edge.props !== undefined ? { props: edge.props } : {}),
        }));
        const edgeTable = edgeLines.length
            ? `\n\n## 关系明细\n${this.formatTable(
                edgeLines.some((line: any) => 'props' in line)
                    ? ['src', 'dst', 'type', 'weight', 'props']
                    : ['src', 'dst', 'type', 'weight'],
                edgeLines,
            )}`
            : '';

        return await this.finalize(
            'kg_path',
            `[kg_path] ${result.from} → ${result.to}，命中 ${paths.length} 条`
            + `${result.truncated ? '（可能还有更多）' : ''} · ${result.elapsedMs}ms\n${lines.join('\n')}${edgeTable}`,
            result,
        );
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
            result.indexedRows !== undefined ? `已重建属性索引 ${result.indexedRows} 行${result.identityRows ? `，身份键 ${result.identityRows} 行` : ''}。` : '',
            result.mode === 'replace' ? '⚠ 已先清空目标表。' : '',
            '提示：导入后执行 kg_lint 做语义校验（必填/类型/枚举/词表/唯一性）。',
        ].filter(Boolean).join('\n');
    }

    public async attrDefine(params: Record<string, unknown>, context?: ToolContextLike): Promise<string> {
        const result = await this.run('attr_define', {
            scope: params.scope,
            key: params.key,
            type: params.type,
            description: params.description,
            required: params.required === true,
            indexed: params.indexed === true,
            unique: params.unique === true,
            identity: params.identity === true,
            domain: params.domain,
            enum: params.enum,
            confirm: params.confirm === true,
        }, context) as any;
        return [
            `[kg_attr_define] ${result.scope}.${result.key} : ${result.type}`
            + `${result.required ? ' · required' : ''}${result.indexed ? ' · indexed' : ''}`
            + `${result.unique ? ' · unique' : ''}${result.identity ? ' · identity' : ''}`,
            result.domain?.length ? `属性域（rdfs:domain）：${result.domain.join(' / ')}` : '',
            result.indexed
                ? `已回填属性索引 ${result.indexRows ?? result.indexedRows ?? 0} 行，可用于 kg_find 等值/范围检索。`
                : '未建索引；如需属性检索加速请传 indexed:true。',
            result.enumValues?.length ? `枚举：${result.enumValues.join(', ')}` : '',
            result.identity ? `已重建身份键索引 ${result.identityRows} 行（实体同一性判定）。` : '',
            result.unique ? '唯一性在 kg_upsert 写入时强校验（唯一值冲突会被拒绝）。' : '',
            result.typeChanged ? '⚠ 类型已变更；历史数据可能不符合新类型，请执行 kg_lint。' : '',
        ].filter(Boolean).join('\n');
    }

    public async attrList(params: Record<string, unknown>, context?: ToolContextLike): Promise<string> {
        const includeStats = params.includeStats === true;
        const result = await this.run('attr_list', {
            scope: params.scope || 'all',
            includeStats,
            topValues: params.topValues,
        }, context) as any;
        const definitions: any[] = result.definitions || [];
        if (!definitions.length) {
            return '[kg_attr_list] 尚未声明任何属性。写入 props 前建议先用 kg_attr_define 声明类型/必填/枚举/索引。';
        }
        const columns = ['scope', 'key', 'value_type', 'required', 'indexed', 'unique_value', 'identity', 'indexRows'];
        if (includeStats) columns.push('presentRows', 'distinctValues');
        const lines = [
            `[kg_attr_list] ${definitions.length} 个属性规范`,
            this.formatTable(columns, definitions),
        ];
        for (const def of definitions) {
            if (Array.isArray(def.topValues) && def.topValues.length) {
                lines.push('', `## ${def.scope}.${def.key} Top`, this.formatTable(['value', 'count'], def.topValues));
            }
        }
        return await this.finalize('kg_attr_list', lines.join('\n'), result);
    }

    public async attrDelete(params: Record<string, unknown>, context?: ToolContextLike): Promise<string> {
        const result = await this.run('attr_delete', {
            scope: params.scope,
            key: params.key,
        }, context) as any;
        return [
            `[kg_attr_delete] ${result.scope}.${result.key}：${result.deleted ? '规范已删除' : '规范不存在'}，清理索引 ${result.removedIndexRows} 行。`,
            result.note,
        ].join('\n');
    }

    public async find(params: Record<string, unknown>, context?: ToolContextLike): Promise<string> {
        const result = await this.run('find', {
            scope: params.scope || 'nodes',
            filter: params.filter,
            types: params.types,
            srcIds: params.srcIds,
            dstIds: params.dstIds,
            propKeys: params.propKeys,
            limit: params.limit,
        }, context) as any;
        const items: any[] = result.items || [];
        const scope = result.scope === 'edges' ? 'edges' : 'nodes';
        const base = scope === 'nodes'
            ? ['id', 'type', 'name']
            : ['src', 'dst', 'type', 'weight'];
        const columns = items.some((item) => item.props !== undefined)
            ? [...base, 'props']
            : base;
        const header = `[kg_find ${scope}] ${items.length}/${result.total}`
            + `${result.truncated ? '（已截断）' : ''} · 属性索引 ${result.usedIndex ? '已命中' : '未使用'} · ${result.elapsedMs}ms`;
        const undeclared: string[] = result.undeclaredKeys || [];
        const warning = undeclared.length
            ? `\n⚠ 未声明属性 ${undeclared.join(', ')}：仍按 props 原值过滤且不走索引，建议先 kg_attr_define。`
            : '';
        return await this.finalize(
            `kg_find_${scope}`,
            `${header}${warning}\n${this.formatTable(columns, items)}`,
            result,
        );
    }

    // ─── 语义层：词表 / 编译检查 / 合并 ────────────────────

    public async vocab(params: Record<string, unknown>, context?: ToolContextLike): Promise<string> {
        const action = String(params.action || 'list').trim().toLowerCase();
        if (!['define', 'list', 'delete'].includes(action)) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                'kg_vocab action 只支持 define / list / delete。',
            );
        }
        if (action === 'define') {
            const result = await this.run('vocab_define', {
                kind: params.kind,
                name: params.name,
                parent: params.parent,
                domain: params.domain,
                range: params.range,
                symmetric: params.symmetric,
                transitive: params.transitive,
                description: params.description,
            }, context) as any;
            const effective = result.effective;
            return [
                `[kg_vocab define] ${result.kind} ${result.name}${result.created ? '（新增）' : '（更新）'}`,
                result.parent ? `父级（subClassOf/subPropertyOf）：${result.parent}` : '',
                effective?.domain?.length ? `生效 domain（含子类）：${effective.domain.join(' / ')}` : '',
                effective?.range?.length ? `生效 range（含子类）：${effective.range.join(' / ')}` : '',
                result.symmetric ? '对称关系（owl:SymmetricProperty）' : '',
                result.transitive ? '传递关系（owl:TransitiveProperty）' : '',
                '提示：声明后用 kg_lint 做编译式校验，写入时 domain/range 会被强校验。',
            ].filter(Boolean).join('\n');
        }
        if (action === 'delete') {
            const result = await this.run('vocab_delete', {
                kind: params.kind,
                name: params.name,
            }, context) as any;
            return [
                `[kg_vocab delete] ${result.kind} ${result.name}：${result.deleted ? '已删除' : '不存在'}，现存数据引用 ${result.usage} 行。`,
                result.note,
            ].join('\n');
        }
        const result = await this.run('vocab_list', {
            kind: params.kind,
            includeUsage: params.includeUsage !== false,
        }, context) as any;
        const definitions: any[] = result.definitions || [];
        if (!definitions.length) {
            return '[kg_vocab list] 尚未声明任何类型。建议用 kg_vocab define kind:"class" 声明节点类型、kind:"property" 声明关系类型与 domain/range。';
        }
        const lines = [
            `[kg_vocab list] ${definitions.length} 个声明`,
            this.formatTable(
                ['kind', 'name', 'parent', 'usage', 'symmetric', 'transitive'],
                definitions,
            ),
        ];
        const constrained = definitions.filter((def) => def.effectiveDomain || def.effectiveRange);
        if (constrained.length) {
            lines.push('', '## 关系约束（生效值，含子类）', this.formatTable(
                ['name', 'effectiveDomain', 'effectiveRange'],
                constrained.map((def) => ({
                    name: def.name,
                    effectiveDomain: def.effectiveDomain,
                    effectiveRange: def.effectiveRange,
                })),
            ));
        }
        const undeclaredNodes: string[] = result.undeclaredNodeTypes || [];
        const undeclaredEdges: string[] = result.undeclaredEdgeTypes || [];
        if (undeclaredNodes.length) lines.push('', `⚠ 未声明的节点类型：${undeclaredNodes.join(', ')}`);
        if (undeclaredEdges.length) lines.push('', `⚠ 未声明的关系类型：${undeclaredEdges.join(', ')}`);
        return await this.finalize('kg_vocab_list', lines.join('\n'), result);
    }

    public async lint(params: Record<string, unknown>, context?: ToolContextLike): Promise<string> {
        const result = await this.run('lint', {
            strict: params.strict === true,
            deep: params.deep === true,
            maxIssues: params.maxIssues,
            sampleLimit: params.sampleLimit,
            codes: params.codes,
        }, context) as any;
        const diagnostics: any[] = result.diagnostics || [];
        const header = result.ok
            ? `[kg_lint] ✅ 语义一致（error 0${result.warningCount ? `，warning ${result.warningCount}` : ''}${result.infoCount ? `，info ${result.infoCount}` : ''}）· ${result.elapsedMs}ms`
            : `[kg_lint] ❌ ${result.errorCount} 类 error / ${result.errorRows} 行受影响`
                + `${result.warningCount ? `，warning ${result.warningCount} 类` : ''} · ${result.elapsedMs}ms`;
        const lines = [
            header,
            `词表：class ${result.vocab?.classes ?? 0} / property ${result.vocab?.properties ?? 0}`
            + `${result.vocab?.identityKeys?.length ? ` · 身份键 ${result.vocab.identityKeys.join(' + ')}` : ''}`
            + `${result.strict ? ' · strict' : ''}${result.deep ? ' · deep' : ''}`,
        ];
        if (!diagnostics.length) {
            lines.push('', '未发现语义问题。');
            return lines.join('\n');
        }
        lines.push('', this.formatTable(
            ['severity', 'code', 'count', 'message', 'hint'],
            diagnostics,
        ));
        for (const item of diagnostics.slice(0, 5)) {
            if (Array.isArray(item.sample) && item.sample.length) {
                lines.push('', `## ${item.code} 样例`, this.formatTable(Object.keys(item.sample[0]), item.sample));
            }
        }
        const fixable = diagnostics.filter((item) => item.code === 'identity_duplicate' || item.code === 'id_normalized_duplicate');
        if (fixable.length) {
            lines.push('', '修复建议：实体重复用 kg_merge 合并；索引/身份漂移用 kg_admin reindex。');
        }
        return await this.finalize('kg_lint', lines.join('\n'), result);
    }

    public async merge(params: Record<string, unknown>, context?: ToolContextLike): Promise<string> {
        const result = await this.run('merge', {
            source: params.source,
            target: params.target,
            keepProps: params.keepProps,
            confirm: params.confirm === true,
        }, context) as any;
        return [
            `[kg_merge] ${result.source} → ${result.target}（props 策略 ${result.keepProps}）· ${result.elapsedMs}ms`,
            `改接关系 ${result.movedEdges} 条，删除 ${result.deletedEdges} 条，丢弃自环 ${result.droppedSelfLoops} 条。`,
            `合并后属性：${(result.props || []).join(', ') || '（无）'}。`,
            '提示：合并会删除 source；如涉及唯一/身份键，建议随后执行 kg_lint 复检。',
        ].join('\n');
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
            `节点 ${value.nodes} · 边 ${value.edges} · 指标 ${value.metrics} · 属性规范 ${value.attrDefs ?? 0}（索引 ${value.indexedAttrs ?? 0}）`,
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
