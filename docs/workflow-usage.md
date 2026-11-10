# Workflow 使用指南（Phase 1.5）

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

### 1.1 执行模型（Phase 1.5）

- Electron 下每个 run 独占一个 `utilityProcess` Worker（worker-per-run）；不同 run 可并行，默认 `maxWorkers = min(4, CPU-1)`。
- 主进程是 `run.json` / `events.jsonl` 的唯一写者；Worker 只上报事件、步骤、checkpoint。
- Worker 心跳默认 5s；30s 无心跳、异常退出或主进程关闭 → run 标记 `interrupted`。
- 每个顶层步骤完成后写入 checkpoint；`resume_workflow` 对 `interrupted`（无需 decision）与 `waiting_approval`（需要 approve/reject）都可用。
- 审批暂停后 Worker 退出释放槽位，恢复时启动新 Worker 从 checkpoint 继续。
- Agent/evaluator 步骤按 `provider:model` 做跨 Worker 并发限制（默认 2），避免多 Worker 同时打爆模型 API。
- 同一 workflow 默认串行（`WORKFLOW_MAX_CONCURRENT_RUNS_PER_WORKFLOW=1`）；可用 `concurrencyGroup` 让不同 workflow 共享串行组。
- standalone server 没有 Electron `utilityProcess`，继续使用进程内引擎；行为与 Worker 模式一致（队列/审批/取消/checkpoint）。

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
- `run.shell.environment` 会追加/覆盖子进程环境变量（仅字符串值）。
- 取消/超时会通过 `AbortSignal` 终止命令；Windows 使用 `taskkill /T /F` 清理进程树。
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
- 审批暂停后 Worker 会退出释放槽位；`resume_workflow` 启动新 Worker 从下一个顶层步骤继续。
- `interrupted` 的 run 也可以不带 decision 直接 `resume_workflow`，从最后一个顶层 checkpoint 继续。

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
- `run.script` / `run.container` / `http` / `emit` / `listen`：尚未启用（`run.script` 等会明确报错）。

### 4.11 `fork` 并行分支

```yaml
- parallel:
    fork:
      branches:
        - do:
            - readA: { call: tool, with: { tool: read_file, args: { path: A.md } } }
            - summarizeA: { call: agent, with: { prompt: "总结 ${ .steps.readA.output }" } }
        - do:
            - readB: { call: tool, with: { tool: read_file, args: { path: B.md } } }
            - summarizeB: { call: agent, with: { prompt: "总结 ${ .steps.readB.output }" } }
```

- 分支在同一个 Worker/进程内并行执行；默认等待全部分支（`allSettled`），任一分支失败则整个 fork 失败。
- `fork.compete: true` 时取最先成功完成的分支，并取消其他分支；若全部分支失败则抛第一个错误。
- 分支默认使用父上下文的**独立副本**；全部成功或竞争胜出后才合并胜出分支的 `set` 结果，避免并发写竞争。
- 分支内步骤路径形如 `/do/0/parallel/branch-0/do/...`，便于 UI 展示。
- 分支内不支持审批（仅顶层 `do`）。
- 可运行示例：`.workflow/examples/parallel-review.workflow.yaml`。

### 4.12 子工作流（`call: workflow` / `run.workflow`）

```yaml
- child:
    call: workflow
    with:
      name: child-workflow          # 或 .workflow/child-workflow.workflow.yaml
      inputs:
        target: ${ .inputs.target }
```

```yaml
- child:
    run:
      workflow:
        name: child-workflow
        inputs:
          target: ${ .inputs.target }
```

- 子工作流从工作区 `.workflow/` 加载，支持默认输入/必填校验。
- 嵌套深度由 `WORKFLOW_MAX_SUBWORKFLOW_DEPTH` 限制（默认 3）；循环引用会被拒绝。
- 子工作流步骤路径形如 `/do/0/child/subworkflow/do/0/...`；步骤记录写入同一个 run。
- 步骤预算与父 run 共享（`maxSteps`/wall-clock 从父 run 启动时间计算）。
- 子工作流内**不支持审批**；需要审批时请放在顶层。
- 子工作流 context 与父 context 隔离，只通过步骤输出传递结果（返回子工作流最后一步输出）。
- 崩溃恢复以父 run 的顶层 checkpoint 为准；恢复时整个子工作流会重新执行。
- 可运行示例：`.workflow/examples/subworkflow-demo.workflow.yaml` + `child-note.workflow.yaml`。

### 4.13 HTTP 请求（`call: http` / `run.http`）

```yaml
- fetch:
    call: http
    with:
      method: GET
      url: https://api.example.com/items
      headers:
        accept: application/json
      timeout: 30s
      failOnError: true     # 默认 false；true 时 4xx/5xx 抛错
```

```yaml
- submit:
    run:
      http:
        method: POST
        url: https://api.example.com/items
        headers:
          authorization: "Bearer ${ .inputs.token }"
        body:
          name: ${ .inputs.name }
```

- 输出：`{ status, statusText, headers, body, url }`；JSON 响应自动解析。
- 默认禁止 `localhost`、私网、链路本地、保留地址和 `.local/.internal` 主机；需要访问本地服务时显式设置 `WORKFLOW_HTTP_ALLOW_PRIVATE=true`。
- 禁止 URL 内嵌用户名/密码；跳过 `host`/`connection`/`content-length`/`transfer-encoding` 等危险请求头。
- 最多跟随 5 次重定向，每次都会重新做内网地址校验；303/301/302 POST 按标准降级为 GET。
- 响应体默认上限 1 MB、超时默认 60s；超限/超时会让步骤失败。
- 注意：DNS 校验与实际连接之间仍存在 DNS rebinding 窗口；不要把 HTTP 步骤当作安全边界，敏感网络请使用专用代理。

## 5. Agent 工具

聊天 Agent 可直接使用：

| 工具 | 作用 |
|---|---|
| `list_workflows` | 列出 `.workflow` 工作流 |
| `get_workflow` | 查看 YAML + 元数据 + 校验 |
| `validate_workflow` | 校验单个或全部 |
| `run_workflow` | 入队执行；`wait=true` 等待终态/审批；可选 `concurrencyGroup` 同组串行 |
| `get_workflow_run` | 查询运行/步骤/用量/审批 |
| `list_workflow_runs` | 列出运行记录 |
| `cancel_workflow` | 取消排队/运行/等待审批 |
| `resume_workflow` | `approve` / `reject` 审批；`interrupted` 运行可省略 decision 直接恢复 |

## 6. Desktop IPC / 客户端

- IPC 通道：`workflow:list/get/validate/run/getRun/cancel/resume/workers`。
- 事件通道：`workflow:event`（按 `runId` 归属，与 chat 的 `agent:event` 解耦）。
- 客户端桥接：`electronAPI.workflow.*`、`workflowBridge`、`workflowBridge.onEvent()`。
- `workflow:workers` 返回 `{ active, queued, workers: [{ workerId, pid, runId, memMB, cpu }] }`；`memMB/cpu` 来自 `app.getAppMetrics()`。

## 7. 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `WORKFLOW_ENABLED` | `true` | 总开关；关闭后 run/cancel/resume 拒绝 |
| `WORKFLOW_MAX_WORKERS` | `min(4, CPU-1)` | utilityProcess 并发 Worker 上限 |
| `WORKFLOW_MAX_QUEUE_SIZE` | `20` | 排队上限 |
| `WORKFLOW_MAX_CONCURRENT_RUNS_PER_WORKFLOW` | `1` | 同一工作流/并发组的上限 |
| `WORKFLOW_MAX_RUN_DURATION_MS` | `7200000` | 单 run 最大时长 |
| `WORKFLOW_WORKER_HEAP_MB` | `512` | Worker V8 堆上限（`--js-flags=--max-old-space-size`） |
| `WORKFLOW_HEARTBEAT_INTERVAL_MS` | `5000` | Worker 心跳间隔 |
| `WORKFLOW_HEARTBEAT_TIMEOUT_MS` | `30000` | 心跳超时判定 |
| `WORKFLOW_WORKER_READY_TIMEOUT_MS` | `15000` | Worker 启动就绪超时 |
| `WORKFLOW_CANCEL_GRACE_MS` | `8000` | 取消后强杀 Worker 的宽限期 |
| `WORKFLOW_MAX_STORED_RUNS` | `50` | 保留运行记录数 |
| `WORKFLOW_MAX_STEPS` | `200` | 单 run 最大步骤数（fork/子工作流共享） |
| `WORKFLOW_MAX_SUBWORKFLOW_DEPTH` | `3` | 子工作流最大嵌套深度 |
| `WORKFLOW_MAX_STEP_OUTPUT_CHARS` | `65536` | 单步骤输出持久化上限 |
| `WORKFLOW_DEFAULT_STEP_TIMEOUT_MS` | `600000` | 默认步骤超时 |
| `WORKFLOW_AGENT_STEP_MAX_TURNS` | `12` | Agent 步骤默认轮次 |
| `WORKFLOW_AGENT_CONCURRENCY_PER_PROVIDER` | `2` | 同一 provider:model 的 agent/evaluator 并发上限（Worker 模式跨进程生效） |
| `WORKFLOW_HTTP_ALLOW_PRIVATE` | `false` | 是否允许 HTTP 步骤访问私网/localhost |
| `WORKFLOW_HTTP_MAX_RESPONSE_BYTES` | `1048576` | HTTP 响应体上限 |
| `WORKFLOW_HTTP_TIMEOUT_MS` | `60000` | HTTP 请求超时 |

## 8. Phase 1.5 限制

- Worker 是故障隔离单元，不是安全沙箱；与主进程同 OS 用户/文件权限。
- 审批仅支持顶层步骤；fork 分支/子工作流内审批会报错。
- `run.script` / `run.container` / `emit` / `listen` 尚未启用。
- HTTP 步骤默认阻止私网地址；DNS rebinding 仍是已知窗口。
- `run.shell.environment` 未透传。
- `workflow:event` 只推送 run/step 级事件，不逐 token 推送。
- 取消对 Agent 步骤即时生效；shell 步骤通过 `AbortSignal` 终止，Windows 会清理进程树。Worker 收到取消后若在宽限期内未退出会被强杀。
- Worker 为冷启动、worker-per-run；`WORKFLOW_MAX_RUNS_PER_WORKER` / `MAX_WORKER_RESTARTS` 预留给热池。
- 心跳依赖 Worker 事件循环；长时间同步 CPU 步骤可能触发心跳超时（默认 30s）。这类步骤建议拆分或改用 `shell`。
- 本地文件队列只能单机恢复；跨重启/跨机器请通过 `WorkflowEngine` 端口接 Temporal/Restate。
