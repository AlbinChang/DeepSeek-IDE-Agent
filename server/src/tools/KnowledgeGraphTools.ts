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

    async attrDefine(params: any, context?: any) {
        return await this.service().attrDefine(params || {}, context);
    }

    async attrList(params: any, context?: any) {
        return await this.service().attrList(params || {}, context);
    }

    async attrDelete(params: any, context?: any) {
        return await this.service().attrDelete(params || {}, context);
    }

    async find(params: any, context?: any) {
        return await this.service().find(params || {}, context);
    }

    async vocab(params: any, context?: any) {
        return await this.service().vocab(params || {}, context);
    }

    async lint(params: any, context?: any) {
        return await this.service().lint(params || {}, context);
    }

    async merge(params: any, context?: any) {
        return await this.service().merge(params || {}, context);
    }

    static getDefinitions() {
        const stringOrArray = (description: string) => ({
            description,
            anyOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
            ],
        });
        const predicateProperties = {
            key: { type: 'string', description: '属性 key（字母/数字/下划线，≤64）' },
            op: {
                type: 'string',
                enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'exists', 'in'],
                description: '比较方式，默认 eq',
            },
            value: { description: '比较值；in 传数组，exists 省略；eq 支持 string/number/boolean' },
        };
        const filterSchema = (description: string) => ({
            description,
            anyOf: [
                { type: 'object', properties: predicateProperties, required: ['key', 'op'] },
                {
                    type: 'array',
                    description: '多个条件按 AND 组合',
                    items: { type: 'object', properties: predicateProperties, required: ['key', 'op'] },
                },
            ],
        });
        const groupEnumSchema = () => ({
            type: 'array',
            description: '枚举值（string/number/boolean，≤200）',
            items: {},
        });

        return [
            {
                name: 'kg_admin',
                description: '图谱运维：status 状态 / schema 结构 / optimize 落盘 / validate 核验 / reindex 重建属性索引。',
                parameters: {
                    type: 'object',
                    properties: {
                        action: {
                            type: 'string',
                            enum: ['status', 'schema', 'optimize', 'validate', 'reindex'],
                            description: '默认 status',
                        },
                        verbose: { type: 'boolean', description: 'validate 时展示全部检查项（默认只展示非 0 项）' },
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
                        strictProps: { type: 'boolean', description: 'true 时拒绝未声明的属性' },
                        strictSchema: { type: 'boolean', description: 'true 时拒绝未声明的节点/关系类型' },
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
                        nodeFilter: filterSchema('节点属性条件（逐跳约束后续节点）'),
                        edgeFilter: filterSchema('边属性条件（逐跳约束可走的边）'),
                        nodePropKeys: stringOrArray('返回节点时附带这些属性'),
                        edgePropKeys: stringOrArray('返回边时附带这些属性'),
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
                        nodeFilter: filterSchema('全局节点属性条件（所有跳）'),
                        edgeFilter: filterSchema('全局边属性条件（所有跳）'),
                        hopFilters: {
                            type: 'array',
                            description: '按跳次序的属性条件，第 1 项作用于第 1 跳；与全局条件取 AND',
                            items: {
                                type: 'object',
                                properties: {
                                    nodeFilter: filterSchema('该跳到达节点的属性条件'),
                                    edgeFilter: filterSchema('该跳所用边的属性条件'),
                                },
                            },
                        },
                        nodePropKeys: stringOrArray('返回节点时附带这些属性'),
                        edgePropKeys: stringOrArray('返回边时附带这些属性'),
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
            {
                name: 'kg_define_attr',
                description: '声明/更新属性规范：类型、必填、枚举、是否索引；indexed 会自动回填属性索引。',
                parameters: {
                    type: 'object',
                    properties: {
                        scope: { type: 'string', enum: ['node', 'edge'] },
                        key: { type: 'string', description: '属性名（字母/数字/下划线，≤64）' },
                        type: {
                            type: 'string',
                            enum: ['string', 'number', 'boolean', 'date', 'json'],
                            description: 'string/number/boolean/date 可索引；json 不可索引',
                        },
                        description: { type: 'string', description: '属性说明' },
                        required: { type: 'boolean', description: '写入时强制必填' },
                        indexed: { type: 'boolean', description: '建立属性索引供 kg_find 加速' },
                        unique: { type: 'boolean', description: '值全局唯一（owl:InverseFunctionalProperty）' },
                        identity: { type: 'boolean', description: '组成节点身份键（自然键，仅 node）' },
                        domain: stringOrArray('属性只允许出现的实体类型（rdfs:domain）'),
                        enum: groupEnumSchema(),
                        confirm: { type: 'boolean', description: '变更已有属性类型时需 true' },
                    },
                    required: ['scope', 'key', 'type'],
                },
            },
            {
                name: 'kg_list_attrs',
                description: '列出属性规范；includeStats 返回覆盖率/去重数，topValues 返回 Top 值。',
                parameters: {
                    type: 'object',
                    properties: {
                        scope: { type: 'string', enum: ['all', 'node', 'edge'], description: '默认 all' },
                        includeStats: { type: 'boolean', description: '统计覆盖率与去重数' },
                        topValues: { type: 'integer', minimum: 0, maximum: 10, description: '每个属性返回 Top N 值' },
                    },
                },
            },
            {
                name: 'kg_delete_attr',
                description: '删除属性规范及其索引；节点/边 props 中的历史值保留。',
                parameters: {
                    type: 'object',
                    properties: {
                        scope: { type: 'string', enum: ['node', 'edge'] },
                        key: { type: 'string', description: '属性名' },
                    },
                    required: ['scope', 'key'],
                },
            },
            {
                name: 'kg_find',
                description: '按属性结构化检索节点/边（eq/ne/范围/包含/存在/in），可只返回指定属性。',
                parameters: {
                    type: 'object',
                    properties: {
                        scope: { type: 'string', enum: ['nodes', 'edges'], description: '默认 nodes' },
                        filter: filterSchema('属性条件；数组为 AND'),
                        types: stringOrArray('节点/关系类型过滤'),
                        srcIds: stringOrArray('仅边：起点 ID 过滤'),
                        dstIds: stringOrArray('仅边：终点 ID 过滤'),
                        propKeys: stringOrArray('返回这些属性'),
                        limit: { type: 'integer', minimum: 1, maximum: 500, description: '默认 50' },
                    },
                },
            },
            {
                name: 'kg_vocab',
                description: '类型词表（RDFS/OWL 子集）：define 声明类型与 domain/range，list 查看，delete 删除声明。',
                parameters: {
                    type: 'object',
                    properties: {
                        action: {
                            type: 'string',
                            enum: ['define', 'list', 'delete'],
                            description: '默认 list',
                        },
                        kind: {
                            type: 'string',
                            enum: ['class', 'property'],
                            description: 'class=节点类型，property=关系类型',
                        },
                        name: { type: 'string', description: '类型名（字母开头，≤128）' },
                        parent: { type: 'string', description: '父类型（subClassOf / subPropertyOf）' },
                        domain: stringOrArray('关系起点允许的节点类型（rdfs:domain）'),
                        range: stringOrArray('关系终点允许的节点类型（rdfs:range）'),
                        symmetric: { type: 'boolean', description: '对称关系（owl:SymmetricProperty）' },
                        transitive: { type: 'boolean', description: '传递关系（owl:TransitiveProperty）' },
                        description: { type: 'string', description: '语义说明' },
                        includeUsage: { type: 'boolean', description: 'list 时统计使用量，默认 true' },
                    },
                    required: ['action'],
                },
            },
            {
                name: 'kg_lint',
                description: '语义编译校验：词表域/值域、唯一性/身份键、属性域、必填/类型/枚举、索引漂移、对称/传递一致性。',
                parameters: {
                    type: 'object',
                    properties: {
                        strict: { type: 'boolean', description: 'true 时 warning 也算不合规' },
                        deep: { type: 'boolean', description: 'true 时检查传递闭包缺失（较慢）' },
                        maxIssues: { type: 'integer', minimum: 1, maximum: 200, description: '返回诊断条数，默认 50' },
                        sampleLimit: { type: 'integer', minimum: 0, maximum: 10, description: '每类问题返回样例数，默认 3' },
                        codes: stringOrArray('只检查这些诊断码'),
                    },
                },
            },
            {
                name: 'kg_merge',
                description: '合并重复实体（owl:sameAs 归一）：改接关系、合并属性、删除 source；需 confirm:true。',
                parameters: {
                    type: 'object',
                    properties: {
                        source: { type: 'string', description: '被合并（将删除）的实体 ID' },
                        target: { type: 'string', description: '保留的实体 ID' },
                        keepProps: {
                            type: 'string',
                            enum: ['merge', 'target', 'source'],
                            description: '属性合并策略，默认 merge（target 覆盖同 key）',
                        },
                        confirm: { type: 'boolean', description: '必须为 true' },
                    },
                    required: ['source', 'target', 'confirm'],
                },
            },
        ];
    }
}
