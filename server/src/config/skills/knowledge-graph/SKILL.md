---
name: knowledge-graph
description: DuckDB 知识图谱建模、写入、遍历与百万级分析规范；涉及实体关系、图谱、路径、社区发现、PageRank 或 kg_* 工具时使用。
triggers:
  - 知识图谱
  - 图谱
  - duckdb
  - kg_
  - 实体关系
  - 关系图
  - 路径分析
  - pagerank
  - 社区发现
  - 连通分量
---

# DuckDB 知识图谱操作规范

## 0. 一句话原则

实体/关系数据只经 `kg_*` 工具写入工作区 `.duckdb/kg.duckdb`；**禁止**用 `read_file`/`file_write`/`run_powershell_command` 直接操作 `.duckdb` 或 `.wal` 文件。

## 1. 选工具

| 需求 | 工具 |
| --- | --- |
| 看状态/结构/做完整性核验 | `kg_admin`（status / schema / optimize / validate / reindex） |
| 声明类型层级与关系 domain/range、对称/传递 | `kg_vocab`（define / list / delete） |
| 语义编译校验（发布前门禁） | `kg_lint`（strict / deep / codes） |
| 合并重复实体（同一实体归一） | `kg_merge` |
| 任意只读统计、抽查、`props` 过滤 | `kg_query` |
| 新增/更新少量节点或关系（≤5000） | `kg_upsert` |
| 从 NDJSON/CSV/Parquet 批量入库（≥1 万行） | `kg_import` |
| 按属性找节点/边（等值/范围/包含/存在/in） | `kg_find` |
| 声明/查看/删除属性规范 | `kg_attr_define` / `kg_attr_list` / `kg_attr_delete` |
| 看某点周围 N 跳子图 | `kg_traverse` |
| 两点之间关系链（可逐跳约束） | `kg_path` |
| 规模、类型分布、度、PageRank、连通分量、社区 | `kg_analyze` |
| 清理数据 | `kg_delete` |

## 2. 建模约定

```text
kg_nodes(id PK, type, name, props JSON)
kg_edges(src, dst, type, weight, props JSON, PK(src,dst,type))
kg_attr_defs(scope, key, value_type, required, indexed, enum_values,
             domain, unique_value, identity)
kg_node_props / kg_edge_props：indexed 属性的实体化索引
kg_vocab_defs(kind, name, parent, domain_types, range_types, is_symmetric, is_transitive)
kg_identity(key_hash PK, node_id, keys_json)：identity 组合键的 md5 索引
```

- `id` 稳定且唯一；`type` 用英文标识（`person`、`company`、`works_at`）。
- 展示名放 `name`，扩展信息放 `props`，不要把结构信息塞进 `name`。
- `props` 必须是 JSON **对象**（key-value），不支持数组/标量；单实体 ≤64KB。
- 属性 key 只允许 `[A-Za-z_][A-Za-z0-9_]{0,63}`（扁平，不含点/引号）。
- 同一对节点可有多种 `type` 的边；重复写入自动 UPSERT，不会产生重复边。

## 2.1 属性治理（必须先声明）

| 步骤 | 工具 | 说明 |
| --- | --- | --- |
| 声明属性 | `kg_attr_define` | `type`: string/number/boolean/date/json；可设 `required`、`enum`、`indexed`、`unique`、`identity`、`domain` |
| 查看规范/分布 | `kg_attr_list` | `includeStats:true` 看覆盖率/去重数；`topValues` 看取值分布 |
| 删除规范 | `kg_attr_delete` | 只删规范与索引，保留 props 历史值 |
| 写入校验 | `kg_upsert` | 已声明属性强校验必填/类型/枚举；未声明属性默认 warning，`strictProps:true` 拒绝 |
| 存量核验 | `kg_admin validate` | 必填缺失/类型/枚举/索引漂移/未声明属性/孤儿边 |
| 重建索引 | `kg_admin reindex` | 索引异常或历史变更后执行（整表重建，秒级） |

- `json` 类型不可索引；`indexed:true` 仅支持 string/number/boolean/date。
- 变更已有属性类型需 `confirm:true`；省略 `indexed/required/enum` 时保留原值。
- `kg_find` 的 `filter` 里写了未声明属性不会报错，结果会带 `undeclaredKeys` 并提示不走索引。
- `kg_admin validate` 直接给结论：`✅ 合规` / `❌ N 项违规`（`severity:error` 必须为 0，`info` 仅参考）。

## 2.2 语义唯一性与 RDF 对齐（强约束）

| 目标 | 声明方式 | 校验点 |
| --- | --- | --- |
| 节点类型分层（rdfs:subClassOf） | `kg_vocab {action:"define", kind:"class", name, parent}` | `kg_lint`：`vocab_unknown_parent` / `vocab_cycle` |
| 关系域/值域（rdfs:domain/range） | `kg_vocab {kind:"property", name, domain, range}` | `kg_upsert` 拒绝违规；`kg_lint` 报 `edge_*_violation` |
| 属性只允许某些类型 | `kg_attr_define {domain:[...]}` | `kg_upsert` 拒绝；`kg_lint` 报 `attr_domain_violation` |
| 值全局唯一（owl:InverseFunctionalProperty） | `kg_attr_define {unique:true}` | `kg_upsert` 冲突拒绝；`kg_lint` 报 `attr_unique_duplicate` |
| 实体自然键（同一性） | `kg_attr_define {identity:true}`（可多个组合） | `kg_identity` 索引 + `kg_lint`：`identity_duplicate` / `identity_incomplete` / `identity_index_drift` |
| 对称关系 | `kg_vocab {symmetric:true}` | `kg_lint`：`symmetric_missing_inverse` |
| 传递关系 | `kg_vocab {transitive:true}` | `kg_lint {deep:true}`：`transitive_missing_shortcut` |
| 重复实体归一（owl:sameAs） | `kg_merge {source, target, confirm:true}` | 合并后 `kg_lint` 复检 |

- **先声明再写入**：声明后 `kg_upsert` 才强校验；`strictSchema:true` 可拒绝未声明的节点/关系类型。
- **唯一性冲突不可绕过**：写入被拒时先用 `kg_merge` 归一重复实体，或修正值；不要指望 `kg_query` 改数据（只读）。
- **词表演进是受控变更**：收紧 `domain/range` 后旧数据不会自动改写，`kg_lint` 会立刻报违规，修完才算发布。
- **发布门禁**：`kg_lint {strict:true}` 返回 `ok:true` 才算语义一致；仅 `kg_admin validate` 通过不代表语义合规。

## 3. 写入流程

1. 先用 `kg_find`/`kg_query` 确认 ID 命名与是否已存在（避免重复实体）。
2. 关系类型先用 `kg_vocab` 声明 `domain/range`；写入新属性前先 `kg_attr_define` 声明类型/必填/枚举；需要检索加速时加 `indexed:true`。
3. 同一实体只能有一个邮箱/工号这类语义时，用 `unique:true` 或 `identity:true` 表达。
4. 少量数据用 `kg_upsert`；大批量先落 NDJSON/Parquet 再 `kg_import`。
5. 导入列名不一致时用 `columnMap`，例如 `{"src":"from_id","dst":"to_id","type":"rel"}`。
6. 只有确认要重建时才用 `mode:"replace" + confirm:true`。
7. 导入/词表变更后执行 `kg_lint`；索引异常时 `kg_admin reindex`。

```text
kg_vocab { action:"define", kind:"class", name:"person" }
kg_vocab { action:"define", kind:"class", name:"employee", parent:"person" }
kg_vocab { action:"define", kind:"property", name:"works_at",
           domain:["person"], range:["company"] }
kg_attr_define { scope:"node", key:"email", type:"string", unique:true }
kg_attr_define { scope:"node", key:"employee_no", type:"string", identity:true }
kg_upsert {
  nodes: [{ id: "p1", type: "person", name: "张三",
            props: { dept: "风控", email: "z@corp", employee_no: "E-001" } }],
  edges: [{ src: "p1", dst: "c1", type: "works_at", props: { role: "ceo" } }],
  strictProps: true, strictSchema: true
}
kg_lint { strict:true, sampleLimit:3 }        # 发布前门禁，ok:true 才算通过
```

## 4. 查询写法

```sql
-- 类型分布
SELECT type, count(*) AS c FROM kg_nodes GROUP BY type ORDER BY c DESC LIMIT 20;
-- JSON 属性过滤
SELECT id, name FROM kg_nodes WHERE type = 'person' AND props->>'dept' = '风控' LIMIT 50;
-- 关系统计
SELECT type, count(*) AS c FROM kg_edges GROUP BY type ORDER BY c DESC LIMIT 20;
-- 两跳邻居（小范围）
SELECT DISTINCT e2.dst FROM kg_edges e1
JOIN kg_edges e2 ON e2.src = e1.dst
WHERE e1.src = 'p1' AND e1.type = 'knows' AND e2.type = 'knows' LIMIT 100;
```

规则：

- 单条只读 SQL；不能出现 `INSERT/UPDATE/DELETE/COPY/ATTACH/PRAGMA`。
- 不能调用 `read_csv/read_json/read_parquet/glob` 等文件函数。
- 默认 200 行、最多 2000 行；需要全量时传 `outputPath` 导出（parquet/csv/json）。
- `params` 只支持标量；列表用 JSON 字符串：

```text
kg_query { sql: "SELECT * FROM kg_nodes WHERE id IN (SELECT json_extract_string(value,'$') FROM json_each(?::JSON))", params: ["[\"p1\",\"p2\"]"] }
```

## 5. 遍历与路径

- 百万级图：`kg_traverse` 的 `depth` 控制在 2–3，配合 `edgeTypes` 过滤；上限 10 跳，10 跳会覆盖稠密图的大部分节点。
- 只关心出边用 `direction:"out"`，只关心入边用 `"in"`；`both` 是无向可达（含混合方向路径）。
- 路径查询使用逐层 BFS（visited 去重），工作量 O(V+E)，`maxDepth` 上限 10；稠密图建议 ≤6。
- 属性约束：`nodeFilter` 约束新到达节点、`edgeFilter` 约束可走的边；`kg_path.hopFilters[i]` 只作用于第 i+1 跳。
- 用 `nodePropKeys`/`edgePropKeys` 只取需要的属性（≤20 个），不传则不返回 props。
- 结果被截断时先收窄类型/深度/属性条件，不要盲目加大 `maxNodes`。

### 5.1 多跳属性推理范式

谓词：`{key, op, value}`，数组为 AND；`op` 支持 `eq/ne/gt/gte/lt/lte/contains/starts_with/exists/in`。

```text
# 起点：高风险公司（indexed 属性走索引）
kg_find { scope:"nodes", types:["company"],
          filter:[{key:"risk",op:"eq",value:"high"}], propKeys:["risk"] }

# 扩张：大额转账 + 高风险节点
kg_traverse { startIds:["c1"], depth:3, direction:"both",
              edgeFilter:[{key:"amount",op:"gte",value:100000}],
              nodeFilter:{key:"risk",op:"eq",value:"high"},
              edgePropKeys:["amount"], nodePropKeys:["risk"] }

# 逐跳：第 1 跳大额转账，第 2 跳到达高风险节点
kg_path { from:"p1", to:"c9", maxDepth:6,
          hopFilters:[
            { edgeFilter:[{key:"amount",op:"gte",value:100000}] },
            { nodeFilter:{key:"risk",op:"eq",value:"high"} }
          ],
          edgePropKeys:["amount","when"], nodePropKeys:["risk"] }

# 聚合：直接 join 属性索引表
kg_query { sql: "SELECT p.val_text AS risk, count(*) c
                 FROM kg_nodes n JOIN kg_node_props p ON p.node_id = n.id
                 WHERE p.key = 'risk' GROUP BY 1 ORDER BY c DESC" }
```

- 起点未知时先 `kg_find`，不要遍历全图找 ID。
- `nodeTypes` 只过滤返回节点，不限制遍历；要限制遍历请用 `nodeFilter`。
- `kg_path` 返回每条路径的节点与边；边明细单独列出，可直接用于解释推理链。

## 6. 分析

| algorithm | 何时用 | 关键参数 |
| --- | --- | --- |
| `summary` | 初次接触数据 | `topN` |
| `degree` | 找枢纽节点 | `topN`, `persist` |
| `pagerank` | 影响力排序 | `iterations`(20), `damping`(0.85), `persist` |
| `components` | 判断是否连通/孤岛 | `iterations`, `persist` |
| `communities` | 近似社区划分 | `iterations`, `persist` |

- `persist:true` 写入 `kg_metrics`，之后用 `kg_query` 复用，避免重复计算。
- 未收敛时优先加 `iterations`，不要重复跑同一个算法。

## 7. 性能与安全

- 导入优先 Parquet/NDJSON；百万行不要用 `kg_upsert` 逐条写。
- 先聚合后明细：`summary` → `degree` → `kg_find`/`traverse` → `path`。
- 10 跳双向遍历在 100 万边稠密图上实测 ≈0.46s；路径 BFS 10 跳 ≈0.62s，可放心用于连通性核查。
- 属性索引回填是一次性成本（5 万节点+100 万边 ≈5.9s）；百万级以下 JSON 过滤本身已很快，`indexed` 主要服务高频/千万级检索。
- 频繁写入后执行 `kg_admin optimize` 收敛 WAL；索引异常执行 `kg_admin reindex`。
- 超时：降低 `depth`/`iterations`、增加 `edgeTypes`/`type` 过滤、缩小查询范围。
- 核验数据用 `kg_admin validate` 或 `kg_query`，不要绕过工具读文件。

## 8. 详细文档

完整架构、参数契约、环境变量与故障排查见 `docs/duckdb-knowledge-graph.md`。
