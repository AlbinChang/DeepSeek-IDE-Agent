# Agent 长期记忆架构

工作区内 `.memory/` 与 `.evaluate/` 是 **Agent 内部记忆目录**，不属于用户交付物。
本文档描述四个记忆文件的职责、编号规则、保留策略与检索方式。

---

## 1. 文件清单

| 文件 | 生产方 | 消费方 | 保留策略 |
|---|---|---|---|
| `.memory/user_instructs.json` | `MemoryService.recordUserInstruction` | 主 Agent / 评估 Agent（按需 `read_file` 或工具） | 最近 `AGENT_MAX_STORED_INSTRUCTIONS` 条（默认 20，硬上限 20） |
| `.memory/user_instructs_reply.json` | `MemoryService.recordMainAgentReply` | 主 Agent / 评估 Agent（`list_main_agent_replies` / `read_main_agent_reply`） | **与 `user_instructs.json` 一一对应**（见 §3） |
| `.memory/never_mistake_again.json` | `NeverMistakeTools.appendRule` | 主 Agent（提示词注入 + `list_never_mistake_rules`） | 最近 20 条 |
| `.memory/user_preferences.json` | `UserPreferenceTools.upsertPreference` | 主 Agent（`list_user_preferences`） | 最近 200 条，置信度按 30 天半衰期衰减 |
| `.memory/dialog_counter.json` | `MemoryService`（后台计数器） | `MemoryService` | 单值，单调递增，永不回退 |
| `.evaluate/evl_result.md` | `EvaluationAgentService` | 主 Agent（上下文缺失时按需 `read_file`） | 覆盖写入，仅保留最近一次 |

> `.memory/` 与 `.evaluate/` 均被 Agent 视为系统内部目录：禁止修改、删除、重命名，禁止写入「文件变更清单」，禁止当作交付物输出。

### 1.1 评估报告的保留与保护

`.evaluate/evl_result.md` 是「最近一次评估 Agent 结果」的落盘副本，规则如下：

| 时机 | 行为 |
|---|---|
| 每次评估完成 | 覆盖写入（报告不完整/评估失败也写入对应报告） |
| 评估产出为空 | **不写盘**，保留上一次有效报告 |
| 新对话、任务结束、工作区切换、应用重启、评估失败 | **一律保留** |
| 用户显式点击「清空历史会话」 | 删除该文件（唯一清除入口） |
| Workflow 评估步骤 | `persistReport: false`，不覆盖该文件 |

为保证上述语义不被绕过，Agent 工具层对系统状态目录做了**写保护**：
`write_file` / `replace_in_file` / `insert_in_file` / `file_patch` / `delete_path` 命中
`.evaluate/` 或 `.memory/` 下的任何路径时直接报错拒绝，提示改用对应记忆工具。
记忆与报告的写入只发生在系统服务（`MemoryService`、`EvaluationAgentService`）内部。

---

## 2. 对话编号（dialogIndex）

每次用户发起**新**对话（即写入 `user_instructs.json` 的那一轮），后台计数器 +1，从 `1` 开始单调递增。

- 计数器落盘在 `.memory/dialog_counter.json`：`{ "lastDialogIndex": 16 }`
- 编号写入 `user_instructs.json` 每条记录的 `dialogIndex` 字段，作为「对话 ↔ 回复」的唯一绑定键
- 对话被保留策略淘汰后，编号**不回收**；新对话永远拿到更大的编号

因此编号是绝对序号，不是窗口内的相对序号：

```
用户对话保留最近 6 次  →  user_instructs.json 中 dialogIndex = 11,12,13,14,15,16
主Agent 回复保留        →  11.1 11.2 … 11.n
                          12.1 12.2 … 12.n
                          …
                          16.1 16.2 … 16.n
```

### 2.1 历史数据迁移

旧版 `user_instructs.json` 没有 `dialogIndex` 字段。首次读取时按**时间顺序**补齐：
最旧的一条记为 `1`，最新的一条记为 `n`，计数器置为 `n`。迁移只发生一次，之后编号单调递增。

### 2.2 异常恢复不重复计数

崩溃/重启后恢复同一次请求时（`resume`），沿用当前对话编号，**不递增计数器、不新增指令记录**，
避免同一次对话被拆成两个编号。

---

## 3. 主 Agent 回复编号（dialogIndex.replyIndex）

主 Agent 在一次对话内可能因评估反馈、TODO 未终态等原因**循环多轮**，每轮都会产出一份最终回复。
这些回复按出现顺序编号：

| 编号 | 含义 |
|---|---|
| `1.1` | 第 1 次对话中主 Agent 的第 1 份最终回复 |
| `1.2` | 第 1 次对话中主 Agent 的第 2 份最终回复 |
| `1.n` | 第 1 次对话中主 Agent 的第 n 份最终回复 |
| `11.3` | 第 11 次对话中主 Agent 的第 3 份最终回复 |

### 3.1 记录结构（`.memory/user_instructs_reply.json`）

数组，**最新在前**（与其他记忆文件一致）：

```jsonc
[
  {
    "id": "16.2",
    "dialogIndex": 16,
    "replyIndex": 2,
    "timestamp": 1794481177492,
    "beijingTime": "2026-11-12T18:59:37+08:00",
    "instruction": "本次对话的用户指令（截断到 200 字）",
    "reply": "主 Agent 本轮的最终回复正文",
    "replyChars": 3821,
    "truncated": false,
    "steps": 14
  }
]
```

| 字段 | 说明 |
|---|---|
| `id` | `dialogIndex.replyIndex`，检索主键 |
| `dialogIndex` | 对话编号，与 `user_instructs.json` 一一对应 |
| `replyIndex` | 该对话内的回复序号，从 1 开始 |
| `beijingTime` | 北京时间 ISO-8601 |
| `instruction` | 该对话的用户指令摘要，便于不读 `user_instructs.json` 也知道上下文 |
| `reply` | 回复正文；超过单条上限时截断 |
| `replyChars` | 原文长度（截断前的字符数） |
| `truncated` | 是否发生截断 |
| `steps` | 产出该回复时主 Agent 已累计的工具轮次，用于判断投入规模 |

### 3.2 保留策略

写回复时按以下顺序裁剪：

1. **一一对应裁剪（核心）**：只保留 `dialogIndex` 仍存在于 `user_instructs.json` 的回复。
   `user_instructs.json` 淘汰了第 10 次对话，则 `10.1…10.n` 同步淘汰。
2. **单对话上限**：同一 `dialogIndex` 最多保留最近 `50` 条回复（异常长循环的安全阀）。
3. **单条上限**：单条 `reply` 最多 `20000` 字符，超出截断并置 `truncated: true`。
4. **文件总量上限**：文件超过 `2 MB` 时，从最旧的对话开始整组淘汰。

> 保留条数因此**与用户对话保留条数严格同源**：调小 `AGENT_MAX_STORED_INSTRUCTIONS`
> 会让两者同步收缩，不会出现「对话记着、回复丢了」或反之。

---

## 4. 检索方式

### 4.1 工具（推荐）

| 工具 | 参数 | 用途 |
|---|---|---|
| `list_main_agent_replies` | `{ limit?: number, dialogIndex?: number }` | 返回索引视图（`id`、时间、字符数、指令摘要、回复摘要），默认最近 20 条 |
| `read_main_agent_reply` | `{ id: string }` | 按 `id`（如 `"11.2"`）读取完整回复正文 |

两个工具对**主 Agent 与评估 Agent 均可用**（评估 Agent 复用主 Agent 工具集）。

### 4.2 直接读文件

`read_file(".memory/user_instructs_reply.json")` 适用于需要同时查看多条回复的场景。
大文件建议先用 `list_main_agent_replies` 定位 `id`，再 `read_main_agent_reply` 取正文，避免把整份记忆塞进上下文。

### 4.3 使用时机

**必须检索**：

- 用户说「继续」「接着上次」「之前那个方案」「刚才让你改的」等指代历史工作的指令，而当前上下文缺少对应细节时
- 需要确认自己在同一任务的多轮迭代中已经承诺过什么、交付过什么时
- 需要核对「上一轮最终结论」与「本轮结论」是否自相矛盾时

**禁止**：

- 每轮无差别加载历史回复（会挤占上下文并降低缓存命中）
- 用历史回复替代真实证据（文件/命令输出仍是唯一事实来源）

---

## 5. 与评估 Agent 的关系

- 评估 Agent 的评估报告仍落盘 `.evaluate/evl_result.md`（覆盖式，仅最近一次）
- 主 Agent 的每轮最终回复落盘 `.memory/user_instructs_reply.json`（累积式，与对话同生命周期）
- 两者互补：评估报告回答「上一轮哪里不合格」，回复记忆回答「我上一轮到底交付了什么」

---

## 6. 相关配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `AGENT_MAX_STORED_INSTRUCTIONS` | `20` | 用户对话保留条数；主 Agent 回复按同一批 `dialogIndex` 同步保留 |

代码位置：

- `server/src/services/MemoryService.ts` — 计数、写入、裁剪
- `server/src/tools/MainAgentReplyTools.ts` — 检索工具
- `server/src/services/AgentService.ts` — 提示词中的记忆策略
- `server/src/services/AgentChatComponent.ts` — 每轮回复的落盘点
