# 限速与隔离

> 来源：[DeepSeek API Docs - 限速与隔离](https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit)

---

## 并发限速

对每个账号，DeepSeek API 不同模型的并发限制如下表所示。

若您有更高的并发需求，可提交[账号扩容申请工单](https://trtgsjkv6r.feishu.cn/share/base/form/shrcnda9jNKvhyYr8xb843xLEzc)，我们将根据您实际的业务需求匹配合适的并发量，扩容并不增加额外的费用。

| 模型 | 并发限制 |
| --- | --- |
| deepseek-v4-pro | 500 |
| deepseek-v4-flash | 2500 |

- 一个请求从发出后，到模型响应完成之前记为一个并发
- 并发限制以账号粒度计，与 API Key 无关
- 对于一个账号，在并发限度内，您的 API 请求都会得到响应；超过并发限度时，您会收到 HTTP 429 错误码

---

## user_id 隔离

用户可以向 API 传递 `user_id` 参数，来实现同一账号下，对您业务侧不同用户的细粒度管理。`user_id` 的具体功能如下：

- **内容安全隔离**：`user_id` 用于我们区分您业务侧的用户身份，以进行内容安全状况处理
- **KVCache 隔离**：`user_id` 用于我们对您业务侧用户进行 KVCache 隔离，以进行隐私管理
- **调度隔离**：`user_id` 用于我们对您业务侧用户进行调度隔离
  - 对于普通 API 用户，所有 `user_id` 合并计算并发限速
  - 对于提升了并发配额的 API 用户，我们会限制您账号下的总并发，同时我们会对每个您传入的 `user_id` 进行并发限制（空 id 为一个特殊的 `user_id`）。对每个 `user_id`，deepseek-v4-pro 并发限制为 500，deepseek-v4-flash 并发限制为 2500。若某个 `user_id` 超过了该限制，则您账号下设置了该 `user_id` 的请求将会收到 HTTP 429 错误码

### user_id 设置方法

`user_id` 参数需为满足正则表达式 `[a-zA-Z0-9\-_]+` 的字符串，最大长度为 512。请不要在 `user_id` 中包含用户隐私信息。

您可以通过以下方式，设置 `user_id` 参数：

#### OpenAI Chat Completions 接口

HTTP 请求体：

```json
{
    "model": "deepseek-v4-pro",
    "messages": {"role": "user", "content": "Hello!"},
    "user_id": "your_user_id"
}
```

如果您使用的是 OpenAI SDK，您需要将 `user_id` 参数放入 `extra_body` 参数下面：

```python
response = client.chat.completions.create(
    model="deepseek-v4-pro",
    messages=[{"role": "user", "content": "Hello!"}],
    extra_body={"user_id": "your_user_id"}
)
```

#### Anthropic 接口

HTTP 请求体：

```json
{
    "model": "deepseek-v4-pro",
    "messages": {"role": "user", "content": "Hello!"},
    "metadata": {"user_id": "your_user_id"},
    "max_tokens": 1024
}
```

如果您使用的是 Anthropic SDK，调用方式如下：

```python
message = client.messages.create(
    model="deepseek-v4-pro",
    messages=[{"role": "user", "type": "text", "content": "Hello!"}],
    metadata={"user_id": "your_user_id"},
    max_tokens=1024
)
```

---

---

## 项目实践：user_id 赋值策略

在本项目（web-ide-agent）中，利用 `user_id` 实现**流量隔离**与**提升 KV Cache 命中率**：

- **赋值逻辑**：`user_id = agentName + workspace`
  - `agentName`：当前使用的 Agent 名称（如 `main-agent`、`evaluator-agent` 等）
  - `workspace`：当前工作区路径标识
- **目的**：
  - 同一 Agent + 同一工作区的请求共享同一 `user_id`，最大化 KVCache 复用
  - 不同 Agent 或不同工作区之间隔离，避免缓存污染和并发互相影响
  - 内容安全层面按业务用户粒度隔离

---

## 项目实践：限流/过载重试、上下文提前压缩与重试预算

本项目的对话引擎（`AgentTurnEngine`）对限流错误做了独立处理：

| 错误类型 | HTTP 状态 | 重试预算 | 说明 |
| --- | --- | --- | --- |
| 服务限流 | 429 | `AGENT_API_RATE_LIMIT_RETRY_LIMIT`（默认 10） | 并发/配额/上下文体积触发的限流 |
| 服务过载 | 408/409/425/5xx | `AGENT_API_SERVICE_BUSY_RETRY_LIMIT`（默认 100） | 如「503 Service is too busy」 |
| 网络层 | 无 HTTP 响应 | `AGENT_API_RETRY_LIMIT`（默认 3） | DNS/连接/流中断等 |

限流自救策略：

- 三类错误**独立计数**，不会互相挤占重试预算。
- 429 与 408/409/425/5xx 服务过载**合并统计连续失败次数**：一次运行内累计超过
  `AGENT_RATE_LIMIT_COMPACT_THRESHOLD`（默认 3）次后，自动把对话历史裁剪到
  `AGENT_LOW_WATERMARK_BYTES`（低水位），再继续重试。
  DeepSeek 的「503 Service is too busy」常与请求体积过大相关，因此过载同样触发压缩；
  只对 429 做压缩会留下「503 → 重试上百次 → 仍然 503」的假死循环。
- 压缩通过 `MessagePreparationService` 的 `forceCompact` 生效：忽略常规
  `AGENT_MAX_HISTORY_BYTES` 触发阈值，直接裁剪到低水位，并允许保留少于 10 条历史消息。
  一旦上下文已在低水位以下、或压缩不再减小体积，本轮不再重复尝试压缩。
- **重试墙钟预算**：`AGENT_API_RETRY_MAX_ELAPSED_MS`（默认 10 分钟，0 表示不限制）。
  连续重试超过该时长仍未成功时，引擎停止自动重试并如实上抛错误，避免退避 × 上百次
  把一次对话拖成几十分钟的「无限重试」。
- 重试预算耗尽后如实上抛错误，不会再出现数百次甚至上千次的无意义重试。

---

## 请求体非法（HTTP 400）与孤立 UTF-16 代理码元

`400 请求格式不合法` / `Failed to parse the request body as JSON ... unexpected end of hex escape`
表示**请求体本身不是合法 JSON**，与限流、上下文长度无关，重试不会恢复。

本项目里唯一能把合法对象序列化成非法 JSON 的字符是**孤立的 UTF-16 代理码元**
（未配对的高/低代理，如 `\uD83D`）。`JSON.stringify` 会把它写成 `\ud83d`，
服务端 JSON 解析器（Rust serde_json）直接拒绝整个请求。

常见来源：

- 按 UTF-16 解码的文件内容（字节数为奇数或文件本身损坏）；
- 模型输出被截断，末尾停在代理对中间；
- 工具结果回显文件内容（`insert_in_file` / `replace_in_file` / `file_patch` 的
  `preview` 最容易命中，因为它会在一次工具调用后把部分变更内容带回模型；现已限制为首尾少量行）；
- 记忆/规则等被按 code unit 截断后注入提示词。

防御分三层（`server/src/utils/UnicodeUtils.ts`）：

1. **请求前统一修复**：`AgentTurnEngine` 在调用模型前对完整请求体执行
   `sanitizeJsonStrings`，把孤立代理码元替换为 `U+FFFD`；合法字符串保持原引用，
   不破坏消息字节数缓存。命中时会打印警告（含修复字段数）。
2. **写入历史前修复**：assistant 的 `content` / `reasoning_content` / `tool_calls.arguments`
   以及工具结果在进入 `activeHistory` 前清洗，避免污染后续所有轮次。
3. **落盘前修复**：`write_file` / `insert_in_file` / `replace_in_file` /
   `replace_all_in_file` 先清洗模型传入的文本，保证文件内容与工具回显一致。

> 合法代理对（emoji 等）不受影响；只替换无法组成代理对的单个 code unit。

另一个同类 400 来源是 **`tool_calls[].function.arguments` 被截断/污染**：
该字段协议上必须是 JSON 字符串，严格网关会校验并拒绝整个请求。引擎在
`JSON.parse` 失败时会把回放历史中的 `arguments` 收敛为 `{}`（工具不执行，
错误信息通过 tool 消息回传给模型重新发起合法调用）；空参数统一写成 `{}`。

---

## 请求/返回诊断：`.llm_response`

工作区下的 `.llm_response/` 目录会保存**每一次**模型请求的返回结果（含重试与被丢弃的响应）：

- 文件名：`response-1.json`、`response-2.json` … `response-10.json`，序号从 1 开始只增不减；
  进程首次写入或新会话开始时扫描目录承接历史计数，多进程并发写入使用独占创建保证不重号。
- 只保留**最近 100 个**响应文件（按序号淘汰最旧的），序号本身继续无限递增，避免长期运行耗尽磁盘。
- 文件内容固定两行：
  - 第 1 行：元数据（时间、模型、供应商、轮次/重试次数、消息条数与字节数、
    耗时、token 用量、返回的模型/指纹、`finish_reason`、重试分类与退避、错误信息等）
  - 第 2 行：返回结果（`content`、`reasoning_content`、`tool_calls`；失败时为已收到的部分内容）
- 写入为异步排队执行，任何写盘异常都不会影响对话主流程。
- 该目录已加入 `.gitignore`，可随时删除；它是分析「到底是上下文过大、并发过高，
  还是网关/模型侧故障」的第一手证据。

---

## 请求保活机制

您的请求发出后，有时需要等待一段时间才能获取服务器的响应。在这段时间里，您的 HTTP 请求会保持连接，并持续收到如下格式的返回内容：

- **非流式请求**：持续返回空行
- **流式请求**：持续返回 SSE keep-alive 注释（`: keep-alive`）

这些内容不影响对响应的 JSON body 的解析。如果您在自己解析 HTTP 响应，请注意处理这些空行或注释。

如果 10 分钟后，请求仍未开始推理，服务器将关闭连接。

---

**相关链接**：[Token 用量计算](https://api-docs.deepseek.com/zh-cn/quick_start/token_usage) | [错误码](https://api-docs.deepseek.com/zh-cn/quick_start/error_codes)
