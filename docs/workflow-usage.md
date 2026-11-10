# Workflow 使用指南（Phase 1）

本项目的声明式 Workflow 放在工作区 `.workflow/` 目录，使用 Open Workflow DSL 1.0.0 的可执行子集。运行时复用现有 Agent、工具、评估与命令安全能力。

## 1. 目录约定

```text
<workspace>/
  .workflow/
    feature-delivery.workflow.yaml   # 推荐命名
    hello.yaml                       # 兼容普通 *.yaml / *.yml
    .runs/                           # 系统生成，建议加入 .gitignore
      <runId>/
        run.json                     # 运行快照
        events.jsonl                 # 追加式事件
        artifacts/                   # 预留的大产物目录
```

- 单文件上限 256 KB；最多扫描 3 层；隐藏目录（如 `.runs`）不会被当作工作流。
- `.workflow/.runs/` 由系统管理，Agent 只读。

## 2. 最小示例

```yaml
document:
  dsl: 1.0.0
  namespace: my-team
  name: hello
  version: 1.0.0
  title: 最小工作流
  input:
    schema:
      type: object
      required: [name]
      properties:
        name: { type: string }

do:
  - prepare:
      set:
        greeting: "Hello ${ .inputs.name }"

  - answer:
      call: agent
      with:
        prompt: |
          ${ .context.greeting }
          请用一句话说明当前工作区有哪些文件。
        tools: [list_files]
        maxTurns: 6

  - done:
      set:
        finished: true
```

## 3. 表达式

支持 `${ ... }`，禁止 `eval` / `new Function`。

| 表达式 | 含义 |
|---|---|
| `${ .inputs.name }` | 工作流输入 |
| `${ .workspace }` | 工作区绝对路径 |
| `${ .run.id }` / `${ .run.traceId }` | 运行 ID / Trace ID |
| `${ .steps.plan.output }` | 步骤输出 |
| `${ .steps.plan.status }` | 步骤状态 |
| `${ .context.key }` | `set` 写入的上下文 |
| `${ .env.PATH }` | 环境变量（KEY/TOKEN/SECRET 等自动脱敏为 `******`） |

- 运算符：`==`、`!=`、`>`、`<`、`>=`、`<=`、`&&`、`||`、`!`、`+`、`-`、`*`、`/`、`%`。
- 过滤器：`default(x)`、`json`、`join(sep)`、`upper`、`lower`、`length`、`keys`、`string`、`number`、`boolean`。
- 整个字符串只有一个 `${...}` 时保留原始类型；否则按字符串插值。
- 结果单值上限 256 KB。

## 4. 步骤类型

### 4.1 `set`

```yaml
- prepare:
    set:
      branch: main
      count: 3
```

### 4.2 `call: agent`

```yaml
- implement:
    call: agent
    with:
      prompt: |
        按计划实现：
        ${ .steps.plan.output }
      tools: [read_file, list_files, file_write, file_replace]
      maxTurns: 20
    output:
      schema:
        type: object
        required: [files]
        properties:
          files: { type: array, items: { type: string } }
```

- 默认只读工具：`read_skill`、`read_file`、`read_file_by_byte`、`list_files`、`calculate`。
- 写文件/命令/浏览器工具必须显式写进 `tools`。
- 禁止在工作流内调用 `run_workflow` / `resume_workflow` / `cancel_workflow`，以及 TODO 写工具。
- `output.schema` 使用内置轻量校验（type/required/properties/items/enum/数值与长度约束）。

### 4.3 `call: tool`

```yaml
- read:
    call: tool
    with:
      tool: read_file
      args:
        path: README.md
```

### 4.4 `run.shell` / `call: shell`

```yaml
- test:
    run:
      shell:
        command: pnpm test
    timeout:
      after:
        minutes: 10
```

- 统一走 `run_powershell_command`（Windows: powershell，macOS/Linux: pwsh）与 `ProcessSafetyGuard`。
- `run.shell.environment` 目前忽略并记录警告。
- **不要**把不可信输入（尤其是 `.inputs`）直接插值进 shell 命令；如需使用，先在脚本内部做参数校验，或改用只读/写文件工具。

### 4.5 `call: evaluator`

```yaml
- review:
    call: evaluator
    with:
      target: ${ .steps.implement.output }
      instruction: 代码可运行、测试通过、无越界修改
      requirePass: true
```

- 评估 Agent 只读工具；`persistReport: false`，不会覆盖主 Agent 的 `.evaluate/evl_result.md`。
- `requirePass: true` 时，非 `goal_achieved` 会抛错。

### 4.6 `call: approval`

```yaml
- approve:
    call: approval
    with:
      message: 是否接受本次变更？
      risk: medium
```

- Phase 1 仅支持顶层 `do` 中的审批；嵌套审批会在 Phase 2 支持。
- 审批暂停后 Worker/进程内槽位会释放，`resume_workflow` 从下一个顶层步骤继续。

### 4.7 `switch`

```yaml
- choose:
    switch:
      - when: ${ .inputs.mode == 'fast' }
        do:
          - fast: { call: agent, with: { prompt: 快速模式 } }
      - default:
          do:
            - slow: { call: agent, with: { prompt: 完整模式 } }
```

### 4.8 `for`

```yaml
- loop:
    for:
      each: item
      at: index
      in: ${ .inputs.items }
    do:
      - work:
          call: agent
          with:
            prompt: "处理第 ${ index } 项：${ item }"
```

### 4.9 `try` / `catch` / `retry`

```yaml
- guarded:
    try:
      - implement:
          call: agent
          with:
            prompt: 实现功能
    catch:
      retry:
        delay: { seconds: 5 }
        backoff:
          exponential: {}
        limit:
          attempt:
            count: 2
      do:
        - report:
            set:
              failed: true
```

### 4.10 其他

- `wait`：`{ wait: { seconds: 5 } }` 或 `wait: PT5S`。
- `raise`：`{ raise: { error: { message: 失败原因 } } }`。
- `then: exit`：结束当前序列。
- `fork` / `run.workflow` / `http` / `emit` / `listen`：Phase 1 尚未启用（`fork` 会明确报错）。

## 5. Agent 工具

聊天 Agent 可直接使用：

| 工具 | 作用 |
|---|---|
| `list_workflows` | 列出 `.workflow` 工作流 |
| `get_workflow` | 查看 YAML + 元数据 + 校验 |
| `validate_workflow` | 校验单个或全部 |
| `run_workflow` | 入队执行；`wait=true` 等待终态/审批 |
| `get_workflow_run` | 查询运行/步骤/用量/审批 |
| `list_workflow_runs` | 列出运行记录 |
| `cancel_workflow` | 取消排队/运行/等待审批 |
| `resume_workflow` | `approve` / `reject` 审批 |

## 6. Desktop IPC / 客户端

- IPC 通道：`workflow:list/get/validate/run/getRun/cancel/resume/workers`。
- 事件通道：`workflow:event`（按 `runId` 归属，与 chat 的 `agent:event` 解耦）。
- 客户端桥接：`electronAPI.workflow.*`、`workflowBridge`、`workflowBridge.onEvent()`。

## 7. 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `WORKFLOW_ENABLED` | `true` | 总开关；关闭后 run/cancel/resume 拒绝 |
| `WORKFLOW_MAX_WORKERS` | `min(4, CPU-1)` | 进程内并发 run 数（Phase 1.5 为 Worker 数） |
| `WORKFLOW_MAX_QUEUE_SIZE` | `20` | 排队上限 |
| `WORKFLOW_MAX_CONCURRENT_RUNS_PER_WORKFLOW` | `1` | 同一工作流并发 run 上限 |
| `WORKFLOW_MAX_RUN_DURATION_MS` | `7200000` | 单 run 最大时长 |
| `WORKFLOW_MAX_STORED_RUNS` | `50` | 保留运行记录数 |
| `WORKFLOW_MAX_STEPS` | `200` | 单 run 最大步骤数 |
| `WORKFLOW_MAX_STEP_OUTPUT_CHARS` | `65536` | 单步骤输出持久化上限 |
| `WORKFLOW_DEFAULT_STEP_TIMEOUT_MS` | `600000` | 默认步骤超时 |
| `WORKFLOW_AGENT_STEP_MAX_TURNS` | `12` | Agent 步骤默认轮次 |

## 8. Phase 1 限制

- 进程内执行；`utilityProcess` 多 Worker 是 Phase 1.5。
- `fork` 并行分支、子工作流、HTTP 步骤未启用。
- 审批仅支持顶层步骤。
- `run.shell.environment` 未透传。
- `workflow:event` 只推送 run/step 级事件，不逐 token 推送。
- 取消对 Agent 步骤即时生效；shell 步骤依赖其 `timeout`，不会立即杀掉子进程（Phase 2 改进）。
