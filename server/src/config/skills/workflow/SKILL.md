---
name: workflow
description: 声明式 .workflow YAML 的 DSL/schema 速查与 validate/run/resume 工具用法；编写、修改、校验、运行、审批恢复工作流时先读本规范。
triggers:
  - 工作流
  - workflow
  - .workflow
  - workflow.yaml
  - 声明式流程
  - 流程编排
  - 自动化流程
  - 子工作流
  - 子流程
  - validate_workflow
  - run_workflow
  - 审批流
---

# Workflow DSL 与工具规范

## 0. 最短路径

1. 在 `.workflow/<name>.workflow.yaml` 写定义（结构见 §2）。
2. `validate_workflow { name, strict: true, deep: true }`，`ok:true` 才继续。
3. `run_workflow { name, inputs }` → 用返回的 `runId` 调 `get_workflow_run`。
4. 审批暂停用 `resume_workflow { runId, decision: "approve" | "reject" }`；`interrupted` 可省略 decision。

本文件即权威 schema，无需再查找其他文档。

## 1. 目录与硬约束

- 定义放 `.workflow/`，推荐 `.workflow/<name>.workflow.yaml`；兼容 `.yaml` / `.yml`。
- 单文件 ≤256 KB；最多扫描 3 层；`.workflow/tools/`、`.workflow/assets/` 是保留资产目录，不参与工作流扫描。
- `.workflow/.runs/` 由系统管理，只读，禁止写入。
- shell 步骤 cwd 是工作区根目录；脚本放 `.workflow/tools/`，用相对路径或 `$env:WORKFLOW_DIR` 引用；禁止在工作区根新建 `tools/`、`scripts/`。
- 顶层 `do` 必须是非空数组，每项是**单键对象**：`- 步骤名: { ...步骤定义 }`。

## 2. 文档骨架

```yaml
document:
  dsl: 1.0.0
  namespace: my-team
  name: feature-delivery      # 调用名；可省略但会 warning
  version: 1.0.0
  title: 功能交付
  summary: 一句话说明
  input:
    schema:
      type: object
      required: [requirement]
      properties:
        requirement: { type: string, description: 需求描述 }
        mode: { type: string, default: fast, enum: [fast, full] }
do:
  - stepName:
      <operation>
```

- `document.input.schema` 支持 `required` / `default`：`run_workflow.inputs` 缺必填会拒绝，缺省有 default 会自动补齐。
- 步骤名全局共享 `steps.<name>` 命名空间，必须唯一且可引用（`[A-Za-z_][A-Za-z0-9_-]*`）。

## 3. 通用步骤字段

| 字段 | 说明 |
| --- | --- |
| `when` | bool/number/表达式；为假时步骤 `skipped`，不执行、不消耗步骤预算。 |
| `continueOnError` | `true` 仅容忍普通步骤错误/超时；取消、审批、预算、持久化错误不被容忍。失败步骤记录 `failed` + `tolerated:true`。 |
| `timeout.after` | 时长：`30s`、`10m`、`PT30S`、`{ seconds: 30 }`；默认 600s。 |
| `output.schema` | 仅 agent 步骤使用：对最终输出做 JSON Schema 轻量校验（type/required/properties/items/enum/min/max/pattern/组合器）。 |
| `then: exit` | 结束当前序列；后续步骤不再执行。 |

## 4. 操作类型

### 4.1 `set`

```yaml
- prepare:
    set:
      branch: main
      greeting: "Hello ${ .inputs.name }"
```

写入 `.context.*`，供后续 `${ .context.greeting }` 使用。

### 4.2 `call: agent`

```yaml
- plan:
    call: agent
    with:
      prompt: |
        按需求制定计划：${ .inputs.requirement }
      tools: [read_file, list_files, write_file]
      maxTurns: 12
    output:
      schema:
        type: object
        required: [files]
        properties:
          files: { type: array, items: { type: string } }
```

- `with.prompt`（或 `with.instruction`）必填；`with.tools` 省略时只有只读工具。
- 写文件/命令/浏览器工具**必须**显式列入 `with.tools`：`write_file`、`replace_in_file`、`insert_in_file`、`replace_all_in_file`、`delete_path`、`run_powershell_command`、`run_cmd_command`、`playwright__browser_*`。
- 默认只读工具：`read_skill`、`read_file`、`read_file_by_byte`、`list_files`、`calculate`、`check_svg`。
- 禁止在 workflow 内调用 workflow 管理工具（`list_workflows`/`get_workflow`/`validate_workflow`/`run_workflow`/`get_workflow_run`/`cancel_workflow`/`resume_workflow`）和 TODO 写工具。

### 4.3 `call: tool`

```yaml
- read:
    call: tool
    with:
      tool: read_file
      args:
        path: README.md
```

`with.tool` 必填，`with.args` 传给目标工具。工具名用规范动宾名（历史宾+动名仍兼容但 validate 会 warning）。

### 4.4 `run.shell` / `call: shell`

```yaml
- test:
    run:
      shell:
        command: pnpm test
        acceptedExitCodes: [0, 4]
        environment:
          CI: "1"
    timeout:
      after: 10m
```

- 统一走 `run_powershell_command` + 命令安全护栏。
- 业务性非零退出码用 `acceptedExitCodes` 声明；禁止用 `exit 0` 吞掉真实崩溃。
- 不要把不可信输入（尤其 `.inputs`）直接插值进 shell。

### 4.5 `call: evaluator`

```yaml
- review:
    call: evaluator
    with:
      target: ${ .steps.implement.output }
      instruction: 测试通过、无越界修改
      requirePass: true
```

evaluator 永久只读；写工具会被移除。`requirePass: true` 时非 `goal_achieved` 直接失败。

### 4.6 `call: approval`

```yaml
- approve:
    call: approval
    with:
      message: 是否接受本次变更？
      risk: medium
```

覆盖高价值文件、执行有副作用的外部操作前先审批。恢复时 `decision: approve | reject`。

### 4.7 子工作流 `call: workflow` / `run.workflow`

```yaml
- child:
    call: workflow
    with:
      name: child-workflow        # 或 .workflow 下相对路径
      inputs:
        target: ${ .inputs.target }
```

- 嵌套深度默认 3，循环引用会被拒绝；子流程输入同样做必填/default 校验。
- 子流程 context 与父隔离，只通过最后一步输出回传。

### 4.8 HTTP `call: http` / `run.http`

```yaml
- fetch:
    call: http
    with:
      method: GET
      url: https://api.example.com/items
      headers: { accept: application/json }
      timeout: 30s
      failOnError: true
```

默认禁止私网/localhost；响应体默认上限 1 MB。输出 `{ status, statusText, headers, body, url }`。

### 4.9 `switch`

```yaml
- choose:
    switch:
      - when: ${ .inputs.mode == 'fast' }
        do:
          - fast: { call: agent, with: { prompt: 快速模式 } }
      - default:
          do:
            - full: { call: agent, with: { prompt: 完整模式 } }
```

### 4.10 `for`

```yaml
- loop:
    for:
      each: item
      at: index
      in: ${ .inputs.items }
      # while: ${ index < 10 }   # 可选提前结束
    do:
      - work:
          call: agent
          with:
            prompt: "处理第 ${ index } 项：${ item }"
```

### 4.11 `try` / `catch` / `retry`

```yaml
- guarded:
    try:
      - work:
          call: agent
          with: { prompt: 实现功能 }
    catch:
      retry:
        delay: 5s
        backoff:
          exponential: {}
        limit:
          attempt:
            count: 2
      do:
        - report:
            set: { failed: true }
```

### 4.12 `fork` 并行

```yaml
- parallel:
    fork:
      branches:
        - do:
            - a: { call: agent, with: { prompt: A } }
        - do:
            - b: { call: agent, with: { prompt: B } }
      compete: false      # true 时取最先成功分支并取消其他分支
```

### 4.13 其他

```yaml
- pause: { wait: 5s }
- fail:
    raise:
      error:
        message: 前置检查失败
        type: validation
- stop:
    set: { done: true }
    then: exit
```

`run.script`、`run.container`、`emit`、`listen` 尚未实现，会明确报错。

## 5. 表达式

| 表达式 | 含义 |
| --- | --- |
| `${ .inputs.x }` | 工作流输入 |
| `${ .context.x }` | `set` 写入的上下文 |
| `${ .steps.plan.output }` / `${ .steps.plan.status }` | 步骤输出/状态（也可用 `.tolerated`） |
| `${ .run.id }` / `${ .run.traceId }` | 运行 ID / Trace ID |
| `${ .workspace }` | 工作区绝对路径 |
| `${ .env.KEY }` | 环境变量（密钥自动脱敏） |

- 运算符：`== != > < >= <= && || ! + - * / %`。
- 过滤器：`default(x)`、`json`、`join(sep)`、`upper`、`lower`、`length`、`keys`、`string`、`number`、`boolean`。
- 整个字符串只有一个 `${...}` 时保留原始类型；否则按字符串插值。
- 禁止 `eval`/`new Function`；未声明输入、前向 `steps` 引用会被 validate 警告。

## 6. 工具面

| 工具 | 用途 |
| --- | --- |
| `list_workflows` | 列出 `.workflow` 工作流 |
| `get_workflow` | 读取 YAML + 元数据 + 校验结果 |
| `validate_workflow` | 编译检查：结构 + 表达式 + 引用 + 权限 + schema；`strict` 把 warning 当失败，`deep` 检查资产/子流程，`codes` 过滤诊断码，`maxIssues` 默认 20 |
| `run_workflow` | 入队执行；`wait:true` 等终态/审批；`timeoutSeconds`、`concurrencyGroup`；步骤输出默认裁剪 |
| `get_workflow_run` | 查询状态/步骤/用量/审批；`includeStepOutput:true` 取步骤全文（≤2000 字符/步） |
| `list_workflow_runs` | 列出运行记录（可按状态过滤） |
| `cancel_workflow` | 取消排队/运行/等待审批 |
| `resume_workflow` | 审批 `approve`/`reject`；`interrupted` 可省略 decision；敏感输入被脱敏后需用 `inputs` 重新提供 |

## 7. 常见失败与修复

- `step_no_operation`：步骤没有 `call/run/set/switch/for/try/fork/wait/raise` 之一。
- `with_missing_prompt/tool/command/url/target`：补对应必填字段。
- `steps_ref_unknown` / `steps_ref_forward`：只能引用前面已执行的步骤；调整顺序或改用 `.context`。
- `tool_forbidden` / `tool_readonly`：从 `with.tools` 移除禁用工具；evaluator 不能写文件。
- `output_schema_invalid` 或输出不匹配：agent 必须输出纯 JSON；schema 字段与实际结构逐项对齐。
- `asset_missing` / `subworkflow_unknown`：`deep:true` 时会检查 `.workflow/**` 资产与子流程是否存在。
- `secret_literal`：不要把密钥写进 YAML；改用 `${ .env.XXX }`。

## 8. 最小可运行示例

```yaml
document:
  dsl: 1.0.0
  name: hello
  version: 1.0.0
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
          用一句话说明当前工作区有哪些文件。
        tools: [list_files]
        maxTurns: 6
  - done:
      set:
        finished: true
```
