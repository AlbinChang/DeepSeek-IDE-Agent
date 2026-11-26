# 浏览器自动化（Playwright MCP）

Agent 通过 `@playwright/mcp` 暴露 `playwright__*` 工具（导航、快照、点击、截图等）。本文说明其运行时结构、故障自愈语义与配置。

## 1. 进程结构

```
Electron 主进程
  └─ BrowserMcpAdapter（每 user+workspace 一个连接状态）
       └─ PlaywrightWorkerClient（宿主监督器：超时看门狗 / 退避重建）
            └─ utilityProcess Worker   ← electron/src/workers/playwrightMcpWorker.ts
                 └─ MCP Client ──stdio──> @playwright/mcp CLI
                                            └─ Chrome / Chromium
```

- MCP Client、MCP 子进程、浏览器**全部**在 Worker 进程里；主进程只持有句柄与消息通道。
- 纯 Node 环境（测试、独立 server）自动退回 `ChildProcessPlaywrightSpawner`（`fork` + IPC），语义一致。
- Worker 产物：`electron/dist/workers/playwrightMcpWorker.cjs`（单文件 CJS）。修改 Worker 代码后需重新 `pnpm --filter deepseek-ide-agent-electron run build:playwright-worker`；`pnpm run dev` 与 `pnpm run build` 已包含该步骤。

## 2. 为什么必须是独立进程

旧的实现在 Electron 主进程里直接持有 `Client` + `StdioClientTransport`，真实日志中表现为：`browser_resize` / `browser_navigate` / `browser_tabs` / `browser_close` 反复 `Playwright MCP tool call timed out after 30000ms`，且 `browser_close` 7/7 次全部超时，重启应用才能恢复。根因链是：

1. 超时只 reject 外层 Promise，**不取消也不重置**底层 MCP 请求 → 僵死的连接被永久复用，后续每次调用都排在一个永远不会返回的请求后面；
2. 超时不被判定为连接错误 → `connected` 仍为 `true` → 熔断重连永不触发；
3. 没有监听 transport/client 关闭 → 子进程已经死了也无人知晓；
4. `StdioClientTransport.close()` 在 Windows 只对顶层进程发信号，Chrome 作为孙进程残留。

放进独立进程后，上述四点都变成可处理的问题：超时可以直接杀掉整棵进程树（含 Chrome）再重建，主进程完全不受影响。

## 3. 自愈语义

| 场景 | 表现 | 处理 |
|---|---|---|
| 工具调用超过宿主预算 | Worker 自报 `tool_timeout`，并 `taskkill /T /F` 掉 MCP 子进程树 | 宿主标记断开，退避 500ms 后自动重建并重连 |
| Worker 完全无响应（看门狗 `预算 + 10s`） | 宿主强杀进程树 | 同上 |
| Worker 崩溃/被杀 | 立刻感知（`onExit`），在途请求立即失败 | 退避重建；连续失败达 5 次后停止，避免崩溃风暴 |
| 网络/管道级连接错误 | Worker 上报 `mcp.state connected=false` | 同上 |
| 断连期间的调用 | 先等自愈窗口（3s），仍未恢复则立即返回 `mcp_not_connected` | 不会把整轮对话拖死 |

工具调用的宿主预算按工具类型区分（见 `resolvePlaywrightToolTimeout`）：

- 导航类（`browser_navigate` / `browser_navigate_back` / `browser_wait_for`）= `BROWSER_MCP_TIMEOUT_NAVIGATION + 30s`，默认 150s；
- 其他工具 = `max(30s, BROWSER_MCP_TIMEOUT_ACTION + 20s)`，默认 30s。

旧实现对所有工具一律 30s，导致「页面还在正常加载」也被判成僵死——真实日志里的 `browser_navigate` 超时即由此而来。

退避序列：500ms → 1s → 2s → 4s → 8s，成功连接一次即清零。

`BrowserMcpAdapter` 对外 API 保持不变（`connect` / `disconnect` / `getConnectionState` / `isConnected` / `getBridgeToolDefinitions` / `getBridgeToolsMetadata` / `executeTool` / `callNativeTool` / `buildSystemPrompt`）；工作区切换与退出时会 `dispose` Worker，浏览器进程随之结束。

## 4. 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `BROWSER_MCP_BROWSER` | `chrome` | 浏览器通道 |
| `BROWSER_MCP_HEADLESS` | `false` | `true` 时无头运行 |
| `BROWSER_MCP_TIMEOUT_NAVIGATION` | `120000` | 导航超时（ms） |
| `BROWSER_MCP_TIMEOUT_ACTION` | `10000` | 动作超时（ms） |
| `BROWSER_MCP_VIEWPORT_SIZE` | 未设置 | 例：`1920x1080` |
| `BROWSER_MCP_ISOLATED` | `false` | 每次会话独立 profile，不持久化 |
| `BROWSER_MCP_IGNORE_HTTPS_ERRORS` | `false` | 忽略自签名证书错误 |
| `BROWSER_MCP_NO_SANDBOX` | `false` | Docker/CI 环境需要 |
| `BROWSER_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS` | `true` | 允许 `file://` 访问本地 HTML |

## 5. 排查

- 工具持续返回 `Playwright MCP 未连接`：先看主进程日志中的 `[PlaywrightWorker]`，能看到重建原因（`tool_timeout` / `worker_exited:<code>` / `watchdog_timeout`）。
- Worker 异常退出会附带最近 20 行 stderr（Chrome 输出），用于定位启动失败。
- Worker 的 stdout/stderr 必须被宿主持续消费；管道写满会让子进程阻塞在写系统调用上，表现为「所有工具调用卡死」——新增 spawner 时不要留下无人读取的 `'pipe'`。
