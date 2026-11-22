import { KnowledgeGraphService } from '@/services/KnowledgeGraphService.js';

/**
 * DuckDB 知识图谱原子工具集。
 *
 * 设计原则：
 * - 每个工具只做一类事，参数用结构化 schema 约束，模型不接触数据库文件。
 * - 所有数据访问由独立 DuckDB Worker 进程执行（见 DuckDbProcessClient）。
 * - 结果默认压缩成表格文本；超出上下文预算自动落盘到 .duckdb/exports/。
 */
export class KnowledgeGraphTools {
    constructor(private readonly workspaceRoot: string) {}

    private service(): KnowledgeGraphService {
        return new KnowledgeGraphService(this.workspaceRoot);
    }

    async admin(params: any, context?: any) {
        return await this.service().admin(params || {}, context);
    }

    async query(params: any, context?: any) {
        return await this.service().query(params || {}, context);
    }

    async upsert(params: any, context?: any) {
        return await this.service().upsert(params || {}, context);
    }

    async delete(params: any, context?: any) {
        return await this.service().delete(params || {}, context);
    }

    async traverse(params: any, context?: any) {
        return await this.service().traverse(params || {}, context);
    }

    async path(params: any, context?: any) {
        return await this.service().path(params || {}, context);
    }

    async analyze(params: any, context?: any) {
        return await this.service().analyze(params || {}, context);
    }

    async importData(params: any, context?: any) {
        return await this.service().importData(params || {}, context);
    }

    static getDefinitions() {
        const stringOrArray = (description: string) => ({
            description,
            anyOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
            ],
        });

        return [
            {
                name: 'kg_admin',
                description: '图谱运维：status 状态 / schema 结构 / optimize 落盘 / validate 完整性核验。',
                parameters: {
                    type: 'object',
                    properties: {
                        action: {
                            type: 'string',
                            enum: ['status', 'schema', 'optimize', 'validate'],
                            description: '默认 status',
                        },
                    },
                    required: ['action'],
                },
            },
            {
                name: 'kg_query',
                description: '只读 SQL 查询 kg_nodes/kg_edges（单条 SELECT/WITH，自动限行）；大结果传 outputPath 导出。',
                parameters: {
                    type: 'object',
                    properties: {
                        sql: { type: 'string', description: '单条只读 SQL，表：kg_nodes(id,type,name,props) / kg_edges(src,dst,type,weight,props)' },
                        params: {
                            type: 'array',
                            description: '按 ? 顺序绑定的标量数组（string/number/boolean/null）',
                            items: {},
                        },
                        maxRows: { type: 'integer', minimum: 1, maximum: 2000, description: '返回行数上限，默认 200' },
                        outputPath: { type: 'string', description: '工作区相对路径；填写则改为导出结果文件' },
                        format: { type: 'string', enum: ['csv', 'json', 'parquet'], description: '导出格式，默认 parquet' },
                    },
                    required: ['sql'],
                },
            },
            {
                name: 'kg_upsert',
                description: '批量写入/更新实体与关系；按 id、(src,dst,type) 幂等 UPSERT，单次最多 5000。',
                parameters: {
                    type: 'object',
                    properties: {
                        nodes: {
                            type: 'array',
                            description: '实体数组',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string', description: '实体唯一 ID' },
                                    type: { type: 'string', description: '实体类型，如 person/company' },
                                    name: { type: 'string', description: '展示名' },
                                    props: { type: 'object', description: '任意 JSON 属性' },
                                },
                                required: ['id', 'type'],
                            },
                        },
                        edges: {
                            type: 'array',
                            description: '关系数组',
                            items: {
                                type: 'object',
                                properties: {
                                    src: { type: 'string', description: '起点 ID' },
                                    dst: { type: 'string', description: '终点 ID' },
                                    type: { type: 'string', description: '关系类型，如 knows/works_at' },
                                    weight: { type: 'number', description: '权重，默认 1' },
                                    props: { type: 'object', description: '任意 JSON 属性' },
                                },
                                required: ['src', 'dst', 'type'],
                            },
                        },
                    },
                },
            },
            {
                name: 'kg_delete',
                description: '删除实体/关系：按 id、类型、边键或 all；cascade 默认同时删除关联边，all 需 confirm。',
                parameters: {
                    type: 'object',
                    properties: {
                        nodeIds: stringOrArray('要删除的实体 ID'),
                        nodeTypes: stringOrArray('按实体类型删除'),
                        edgeTypes: stringOrArray('按关系类型删除'),
                        edgeKeys: {
                            type: 'array',
                            description: '精确边键数组',
                            items: {
                                type: 'object',
                                properties: {
                                    src: { type: 'string' },
                                    dst: { type: 'string' },
                                    type: { type: 'string' },
                                },
                                required: ['src', 'dst', 'type'],
                            },
                        },
                        cascade: { type: 'boolean', description: '删节点时同时删关联边，默认 true' },
                        all: { type: 'boolean', description: '清空整张图谱（慎用）' },
                        confirm: { type: 'boolean', description: 'all=true 时必须为 true' },
                    },
                },
            },
            {
                name: 'kg_traverse',
                description: '从起点做 N 跳邻域扩展（out/in/both），返回节点与关系子图；百万级图建议 depth≤3。',
                parameters: {
                    type: 'object',
                    properties: {
                        startIds: stringOrArray('起点实体 ID（必填）'),
                        depth: { type: 'integer', minimum: 1, maximum: 10, description: '跳数，默认 2；上限 10，百万级图建议 ≤3' },
                        direction: { type: 'string', enum: ['out', 'in', 'both'], description: '默认 both' },
                        edgeTypes: stringOrArray('只遍历指定关系类型'),
                        nodeTypes: stringOrArray('只返回指定实体类型'),
                        maxNodes: { type: 'integer', minimum: 1, maximum: 2000, description: '节点上限，默认 200' },
                        maxEdges: { type: 'integer', minimum: 1, maximum: 5000, description: '关系上限，默认 500' },
                    },
                    required: ['startIds'],
                },
            },
            {
                name: 'kg_path',
                description: '查找两节点间最短路径（BFS，out/in/both），返回节点链；稠密图建议 maxDepth≤6。',
                parameters: {
                    type: 'object',
                    properties: {
                        from: { type: 'string', description: '起点 ID' },
                        to: { type: 'string', description: '终点 ID' },
                        maxDepth: { type: 'integer', minimum: 1, maximum: 10, description: '最大跳数，默认 4；BFS 有界，稠密图建议 ≤6' },
                        direction: { type: 'string', enum: ['out', 'in', 'both'], description: '默认 out' },
                        edgeTypes: stringOrArray('只走指定关系类型'),
                        maxPaths: { type: 'integer', minimum: 1, maximum: 20, description: '最多返回路径数，默认 3' },
                    },
                    required: ['from', 'to'],
                },
            },
            {
                name: 'kg_analyze',
                description: '图谱分析：summary/degree/pagerank/components/communities；persist 可写入 kg_metrics。',
                parameters: {
                    type: 'object',
                    properties: {
                        algorithm: {
                            type: 'string',
                            enum: ['summary', 'degree', 'pagerank', 'components', 'communities'],
                        },
                        topN: { type: 'integer', minimum: 1, maximum: 200, description: '返回 Top N，默认 20' },
                        iterations: { type: 'integer', minimum: 1, maximum: 100, description: '迭代上限，默认 20' },
                        damping: { type: 'number', minimum: 0.1, maximum: 0.99, description: 'PageRank 阻尼，默认 0.85' },
                        tolerance: { type: 'number', description: 'PageRank 收敛阈值，默认 1e-6' },
                        persist: { type: 'boolean', description: '结果写入 kg_metrics' },
                    },
                    required: ['algorithm'],
                },
            },
            {
                name: 'kg_import',
                description: '从工作区 json/csv/parquet 文件批量导入节点或关系；merge 幂等，replace 需 confirm。',
                parameters: {
                    type: 'object',
                    properties: {
                        target: { type: 'string', enum: ['nodes', 'edges'] },
                        path: { type: 'string', description: '工作区相对路径' },
                        format: { type: 'string', enum: ['json', 'csv', 'parquet'], description: '缺省按扩展名推断' },
                        columnMap: {
                            type: 'object',
                            description: '源列名映射，如 {"id":"nid","src":"from"}',
                        },
                        mode: { type: 'string', enum: ['merge', 'replace'], description: '默认 merge' },
                        confirm: { type: 'boolean', description: 'replace 时必须为 true' },
                    },
                    required: ['target', 'path'],
                },
            },
        ];
    }
}
