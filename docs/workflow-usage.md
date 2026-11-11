# Workflow 使用指南

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

### 1.1 执行模型

- Electron 下每个 run 独占一个 `utilityProcess` Worker（worker-per-run）；不同 run 可并行，默认 `maxWorkers = min(4, CPU-1)`。
- 主进程是 `run.json` / `events.jsonl` 的唯一写者；Worker 只上报事件、步骤、checkpoint。
- Worker 心跳默认 5s；30s 无心跳、异常退出或主进程关闭 → run 标记 `interrupted`。
- 每个顶层步骤完成后写入 checkpoint；`resume_workflow` 对 `interrupted`（无需 decision）与 `waiting_approval`（需要 approve/reject）都可用。
- 审批暂停后 Worker 退出释放槽位，恢复时启动新 Worker 从 checkpoint 继续。
- Agent/evaluator 步骤按 `provider:model` 做跨 Worker 并发限制（默认 2），避免多 Worker 同时打爆模型 API。
- 可选的请求令牌桶按 `provider:model` 限制每次实际模型请求，包括重试和 evaluator 请求；默认关闭，不影响普通聊天。
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
- 取消/超时会通过 `AbortSignal` 终止命令；Windows 使用 `taskkill /T /F`，POSIX 使用独立进程组和组级终止。Windows 已做实际测试；POSIX 组信号目前只有模拟测试，部署时应在目标系统验证。
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

- 支持顶层步骤以及 `switch`、`for`、`try`、`fork`、子工作流中的审批。暂停后 Worker 退出释放槽位。
- 顶层审批从下一步骤继续；嵌套审批从所在顶层容器重放，并复用已持久化的成功叶子步骤输出和 `set` 结果，不重复执行这些已完成步骤。
- `fork` 内出现审批时，会先等待其他分支结束，再保存暂停状态；其他分支很长时审批提示可能延迟。
- 如果恢复所需的上下文或已完成步骤输出被脱敏/截断，系统拒绝批准恢复并保留等待状态，可选择拒绝该审批。父/子工作流定义在暂停后发生变化时也会拒绝恢复。
- 敏感输入不以明文落盘；如果输入被脱敏，进程重启后恢复时需要通过 `resume_workflow` 的 `inputs`、桌面审批表单或 REST 接口重新提供原始输入。系统会检查仍可核对的字段，但重启后无法验证已脱敏字段或截断部分是否与原值一致；必须由操作人确认输入完全一致。
- `interrupted` 的 run 也可以不带 decision 直接 `resume_workflow`，从最后一个顶层 checkpoint 继续。
- checkpoint 不提供外部副作用的 exactly-once 保证：崩溃或取消时尚未完成并持久化的 HTTP、命令、文件或模型调用可能在恢复时再次执行。写操作应设计为幂等，必要时使用人工审批。

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
- `run.script` / `run.container` / `emit` / `listen`：不支持并在运行时明确报错，不会被静默跳过。

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

- 分支在同一个 Worker/进程内并行执行；默认等待全部分支（`allSettled`），任一分支失败则整个 fork 失败。同时运行的分支数受 `WORKFLOW_MAX_FORK_PARALLEL`（默认 4）限制，其余分支排队。
- `fork.compete: true` 时取最先成功完成的分支，并取消其他分支；若全部分支失败则抛第一个错误。
- 分支默认使用父上下文的**独立副本**；全部成功或竞争胜出后才合并胜出分支的 `set` 结果，避免并发写竞争。
- 分支内步骤路径形如 `/do/0/parallel/branch-0/do/...`，便于 UI 展示。
- 分支内支持审批；暂停前会等待其他分支结束，恢复时跳过已完成的叶子步骤。
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
- 子工作流内支持审批；恢复前会校验相关父/子定义未发生变化。
- 子工作流 context 与父 context 隔离，只通过步骤输出传递结果（返回子工作流最后一步输出）。
- 非审批中断恢复仍以父 run 的最后一个顶层 checkpoint 为准；该 checkpoint 后未完成的子工作流可能重新执行。
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
- 最多跟随 5 次重定向，每次重新解析并校验目标，实际连接固定使用已验证的 DNS 地址；跨源重定向会移除认证、Cookie 及名称含 secret/token/key 的请求头。303/301/302 POST 按标准降级为 GET。
- 响应体默认上限 1 MB（解压后计算）、超时默认 60s，DNS 解析也计入超时；超限/超时会让步骤失败。
- 进程隔离不是安全沙箱；仍应限制工作区信任、网络出口和可用工具。显式允许私网后不再提供私网地址保护。

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
| `resume_workflow` | `approve` / `reject` 审批；`interrupted` 可省略 decision；重启后可用 `inputs` 补充原始敏感输入 |

## 6. Desktop IPC / 客户端

- IPC 通道：`workflow:list/get/validate/run/getRun/listRuns/cancel/resume/workers`。
- 事件通道：`workflow:event`（按 `runId` 归属，与 chat 的 `agent:event` 解耦）。
- 客户端桥接：`electronAPI.workflow.*`、`workflowBridge`、`workflowBridge.onEvent()`。
- 桌面端侧边栏提供「工作流」面板：列表、输入表单、运行、运行记录、步骤时间线、取消/审批/中断恢复。
- 定义详情支持 Mermaid 图预览；同名定义按文件路径区分。需要补充敏感输入时，审批/恢复表单接受 JSON 对象。
- `workflow:workers` 返回 `{ active, queued, workers: [{ workerId, pid, runId, memMB, cpu }] }`；`memMB/cpu` 来自 `app.getAppMetrics()`。

## 7. 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `WORKFLOW_ENABLED` | `true` | 总开关；关闭后 run/cancel/resume 拒绝 |
| `WORKFLOW_TRIGGERS_ENABLED` | `false` | 允许已初始化的工作区自动执行定时/文件触发器 |
| `WORKFLOW_MAX_WORKERS` | `min(4, CPU-1)` | utilityProcess 并发 Worker 上限 |
| `WORKFLOW_MAX_QUEUE_SIZE` | `20` | 排队上限 |
| `WORKFLOW_MAX_CONCURRENT_RUNS_PER_WORKFLOW` | `1` | 同一工作流/并发组的上限 |
| `WORKFLOW_MAX_RUN_DURATION_MS` | `7200000` | 单 run 最大时长 |
| `WORKFLOW_WORKER_HEAP_MB` | `512` | Worker V8 堆上限（`--js-flags=--max-old-space-size`） |
| `WORKFLOW_HEARTBEAT_INTERVAL_MS` | `5000` | Worker 心跳间隔 |
| `WORKFLOW_HEARTBEAT_TIMEOUT_MS` | `30000` | 心跳超时判定 |
| `WORKFLOW_WORKER_READY_TIMEOUT_MS` | `15000` | Worker 启动就绪超时 |
| `WORKFLOW_CANCEL_GRACE_MS` | `8000` | 取消后强杀 Worker 的宽限期 |
| `WORKFLOW_MAX_STORED_RUNS` | `50` | 已结束 run（含 `interrupted`）保留数量；排队/运行中/待审批永不清理 |
| `WORKFLOW_MAX_STEPS` | `200` | 单 run 最大步骤数（fork/子工作流共享） |
| `WORKFLOW_MAX_FORK_PARALLEL` | `4` | 单个 `fork` 同时运行的分支数上限，超出的分支排队 |
| `WORKFLOW_MAX_TOKENS` | `0` | 已报告的模型 token 总预算；`0` 关闭。达到上限后不再发起模型请求，超限后失败 |
| `WORKFLOW_MAX_SUBWORKFLOW_DEPTH` | `3` | 子工作流最大嵌套深度 |
| `WORKFLOW_MAX_STEP_OUTPUT_CHARS` | `65536` | 单步骤输出持久化上限 |
| `WORKFLOW_DEFAULT_STEP_TIMEOUT_MS` | `600000` | 默认步骤超时 |
| `WORKFLOW_AGENT_STEP_MAX_TURNS` | `12` | Agent 步骤默认轮次 |
| `WORKFLOW_AGENT_CONCURRENCY_PER_PROVIDER` | `2` | 同一 provider:model 的 agent/evaluator 并发上限（Worker 模式跨进程生效） |
| `WORKFLOW_AGENT_REQUESTS_PER_MINUTE` | `0` | 同一 provider:model 每分钟实际模型请求数（含重试）；`0` 关闭 |
| `WORKFLOW_AGENT_REQUEST_BURST` | `2` | 请求令牌桶突发容量 |
| `WORKFLOW_HTTP_ALLOW_PRIVATE` | `false` | 是否允许 HTTP 步骤访问私网/localhost |
| `WORKFLOW_HTTP_MAX_RESPONSE_BYTES` | `1048576` | HTTP 响应体上限 |
| `WORKFLOW_HTTP_TIMEOUT_MS` | `60000` | HTTP 请求超时 |
| `WORKFLOW_HTTP_API_ENABLED` | `false` | 启用 standalone server 的 Workflow REST/SSE |
| `WORKFLOW_HTTP_API_TOKEN` | 空 | API 启用时必填的独立 Bearer 凭据 |

token 预算依据供应商返回的 usage 计算；开启预算后，成功响应未提供 usage 会失败。单次请求、已在途的并行请求和未返回 usage 的失败请求仍可能导致实际用量超过预算，因此不能将其当作严格计费上限。预算和已记录 usage 跨审批/重启恢复继续累计。

## 8. 可选 REST / SSE

仅 standalone server 注册这些接口，默认关闭。启用时设置 `WORKFLOW_HTTP_API_ENABLED=true` 和足够随机、独立的 `WORKFLOW_HTTP_API_TOKEN`，然后重启服务。所有请求必须携带 `Authorization: Bearer <token>`；每次还需提供已初始化的 `userId`，可选 `root` 必须与该用户当前登记的工作区一致。此凭据是服务级共享凭据，并非每用户独立授权；不要将服务直接暴露给不可信网络，应结合 TLS、网络访问控制及密钥轮换。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/workflows?userId=...` | 列出定义 |
| GET | `/api/workflows/definitions/:name?userId=...` | 定义、校验结果和 Mermaid 图 |
| POST | `/api/workflows/validate` | `{ userId, name? }` |
| POST | `/api/workflows/runs` | `{ userId, name, inputs?, wait?, timeoutSeconds?, provider?, model?, concurrencyGroup? }` |
| GET | `/api/workflows/runs?userId=...&status=...` | 列出当前用户运行 |
| GET | `/api/workflows/runs/:runId?userId=...&includeEvents=true` | 运行快照及最近事件 |
| POST | `/api/workflows/runs/:runId/cancel` | `{ userId }` |
| POST | `/api/workflows/runs/:runId/resume` | `{ userId, decision?, inputs? }` |
| GET | `/api/workflows/runs/:runId/events?userId=...` | SSE 事件流 |

SSE 使用递增的事件 ID，重连可携带 `Last-Event-ID`；历史缺口、缓冲溢出或游标超前时会发送 `reset` 事件，客户端应重新读取运行快照。慢客户端会被断开并可重新连接；工作区切换、重置或服务关闭会结束流。浏览器原生 `EventSource` 不能自定义 Bearer 请求头，应使用支持自定义请求头的 SSE 客户端。

## 9. 可选自动触发

自动触发默认关闭。仅在信任工作区及其 workflow 文件时设置 `WORKFLOW_TRIGGERS_ENABLED=true` 并重启应用；初始化工作区后开始监听，重置/切换工作区或关闭应用后停止。触发器可以自动执行有副作用的步骤，应先审查 YAML 与工具权限。

```yaml
document:
  name: watched-review
  input:
    schema:
      type: object
      properties:
        mode: { type: string }

# 项目扩展，不属于 Open Workflow 标准语法
x-workflow-triggers:
  - type: interval
    every: 5m
    inputs: { mode: periodic }
  - type: file
    paths: [src/config.ts, README.md]
    inputs: { mode: changed }
do:
  - review:
      call: agent
      with:
        prompt: "检查当前工作区，模式：${ .inputs.mode }"
```

- `interval.every` 支持 `1s`、`5m`、`PT1H` 或 duration 对象，范围为 1 秒至 365 天；首次触发在一个完整间隔后。
- `file.paths` 为 1–50 个工作区相对**文件**路径，不支持目录或通配符，禁止路径穿越、`.git`、`.workflow/.runs` 和指向工作区外的符号链接。启动时建立基线，之后按文件元数据变化检测创建、修改或删除。
- 文件约每秒轮询，5 秒冷却期内的变更合并；同一触发器已有排队、运行中或待审批的 run 时不会重复入队，文件变更会在该 run 结束后再尝试。定时触发在上次 run 未完成时跳过该次，不补发。
- 避免监听 workflow 自己会修改的文件，否则可能产生持续触发的反馈循环。
- 定义约每 15 秒刷新；变更定义时重新建立该触发器基线。轮询是尽力而为：短时间内发生并恢复的变更、进程不在运行期间的变更或计划时刻不会补发，也不保证 exactly-once。
- 触发的 run 使用声明的静态 `inputs`，运行记录和桌面面板标识“定时触发”或“文件触发”。不要将密钥直接写入会提交版本库的 YAML。
- 当前没有 cron 表达式、事件消息投递、系统后台常驻服务或跨机器调度。

## 10. 限制和运行注意事项

- Worker 是故障隔离单元，不是安全沙箱；与主进程同 OS 用户/文件权限。
- `run.script` / `run.container` / `emit` / `listen` 尚未实现且会明确报错；模板市场、图形编辑和分布式后端属于报告中的可选 Phase 3，目前未实现。
- `workflow:event` 只推送 run/step 级事件，不逐 token 推送。
- 取消通过 `AbortSignal` 传播，实际中断速度取决于底层操作；shell 按上述平台策略清理，Worker 在宽限期内未退出会被强杀。
- Worker 为冷启动、worker-per-run；`WORKFLOW_MAX_RUNS_PER_WORKER` / `MAX_WORKER_RESTARTS` 预留给热池。
- 心跳依赖 Worker 事件循环；长时间同步 CPU 步骤可能触发心跳超时（默认 30s）。这类步骤建议拆分或改用 `shell`。
- `wait: true` 的 `timeoutSeconds` 与 `WORKFLOW_MAX_RUN_DURATION_MS` 超过 Node 定时器上限（约 24.8 天）时会被钳制到上限，不会立即提前返回；需要更长的作业请拆分或改由外部调度。
- 本地文件队列支持单机重启后的状态查询及有限恢复，不支持跨机器或事务性 exactly-once；如需分布式执行，应单独接入持久化后端。
