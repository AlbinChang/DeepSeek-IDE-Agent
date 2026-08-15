# Electron 桌面应用迁移文档

> **状态：✅ 迁移已完成**（2026-06-28）
> Web 模式代码已清理，应用现为纯 Electron 架构。

## 架构

```
┌─────────────────────────────────────────┐
│              Electron App               │
│  ┌──────────────┐  ┌────────────────┐  │
│  │ Main Process  │  │  Renderer      │  │
│  │ • AI Agent    │◀─┤  • React UI    │  │
│  │ • node-pty    │  │  • Monaco      │  │
│  │ • FileSystem  │  │  • xterm.js    │  │
│  │ • simple-git  │  │  • Tailwind    │  │
│  └──────────────┘  └────────────────┘  │
└─────────────────────────────────────────┘
```

## 已完成

### IPC 处理器

| 文件 | 功能 |
|------|------|
| `electron/src/main/ipc/agent-handlers.ts` | Agent 对话（替代 ChatSSERoute） |
| `electron/src/main/ipc/file-handlers.ts` | 文件操作（替代 REST） |
| `electron/src/main/ipc/terminal-handlers.ts` | 终端 PTY（吸收 terminal-server） |
| `electron/src/main/ipc/git-handlers.ts` | Git 操作（替代 REST Git 路由） |
| `electron/src/main/ipc/settings-handlers.ts` | 设置管理 |
| `electron/src/main/ipc/context-handlers.ts` | 上下文 & 补全 |
| `electron/src/main/ipc/app-handlers.ts` | 工作区选择、应用信息 |

### 前端适配

| 文件 | 说明 |
|------|------|
| `client/src/services/electron-bridge.ts` | IPC 桥接层（纯 IPC，无 web fallback） |
| `client/src/components/*.tsx` | 全部组件已纯净化（移除非 Electron 分支及 axios/fetch 兜底） |
| `client/src/hooks/useAgentSSE.ts` | Agent 对话消费（IPC 直连） |
| `client/src/components/Terminal.tsx` | 终端适配（IPC node-pty 直连） |

### 已清理的历史债务

- `client/src/components/AgentChatSimulator.tsx` — 废弃调试仿真组件
- `client/src/hooks/HookTester.tsx` / `useAgent.ts` — 废弃无头测试组件与 Hook
- `server/src/services/test-skill-logic.ts` — 临时调试测试脚本
- `server/src/tools/BrowserAutomationTools.ts` — 已被 `BrowserMcpAdapter` 替代的废弃存根
- `client/static-server.js` — 旧版 Web 静态托管服务
- `scripts/start-services.mjs` — 旧版 Web 三进程启动脚本
- `jvm8-monitor/`、`client/src/workers/`、`server/src/agents/` — 空目录
- 前端所有组件中的 `axios`、`API_BASE`、`WS_BASE` 双轨制回退与心跳死循环
- `electron/src/main/ipc/context-handlers.ts` 对接真正的 `CompletionService`

## 运行与构建命令

```bash
npm test                 # 运行全套 Vitest 单元测试
npm run electron:dev     # 开发模式（esbuild + Vite + Electron）
npm run electron:build   # 全量构建
npm run electron:dist    # 生成桌面安装包
```
