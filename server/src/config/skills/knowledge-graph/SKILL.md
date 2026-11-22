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
| 看状态/结构/做完整性核验 | `kg_admin`（status / schema / optimize / validate） |
| 任意只读统计、抽查、`props` 过滤 | `kg_query` |
| 新增/更新少量节点或关系（≤5000） | `kg_upsert` |
| 从 NDJSON/CSV/Parquet 批量入库（≥1 万行） | `kg_import` |
| 看某点周围 N 跳子图 | `kg_traverse` |
| 两点之间关系链 | `kg_path` |
| 规模、类型分布、度、PageRank、连通分量、社区 | `kg_analyze` |
| 清理数据 | `kg_delete` |

## 2. 建模约定

```text
kg_nodes(id PK, type, name, props JSON)
kg_edges(src, dst, type, weight, props JSON, PK(src,dst,type))
```

- `id` 稳定且唯一；`type` 用英文标识（`person`、`company`、`works_at`）。
- 展示名放 `name`，扩展信息放 `props`，不要把结构信息塞进 `name`。
- 同一对节点可有多种 `type` 的边；重复写入自动 UPSERT，不会产生重复边。

## 3. 写入流程

1. 先用 `kg_query` 确认 ID 命名与是否已存在（避免重复实体）。
2. 少量数据用 `kg_upsert`；大批量先落 NDJSON/Parquet 再 `kg_import`。
3. 导入列名不一致时用 `columnMap`，例如 `{"src":"from_id","dst":"to_id","type":"rel"}`。
4. 只有确认要重建时才用 `mode:"replace" + confirm:true`。

```text
kg_upsert {
  nodes: [{ id: "p1", type: "person", name: "张三", props: { dept: "风控" } }],
  edges: [{ src: "p1", dst: "c1", type: "works_at" }]
}
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
- 结果被截断时先收窄类型/深度，不要盲目加大 `maxNodes`。

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
- 先聚合后明细：`summary` → `degree` → `traverse` → `path`。
- 10 跳双向遍历在 100 万边稠密图上实测 ≈0.46s；路径 BFS 10 跳 ≈0.62s，可放心用于连通性核查。
- 频繁写入后执行 `kg_admin optimize` 收敛 WAL。
- 超时：降低 `depth`/`iterations`、增加 `edgeTypes`/`type` 过滤、缩小查询范围。
- 核验数据用 `kg_admin validate` 或 `kg_query`，不要绕过工具读文件。

## 8. 详细文档

完整架构、参数契约、环境变量与故障排查见 `docs/duckdb-knowledge-graph.md`。
