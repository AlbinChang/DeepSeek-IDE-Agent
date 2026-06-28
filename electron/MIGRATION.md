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
| `client/src/components/*.tsx` | 全部组件已适配 IPC |
| `client/src/hooks/useAgentSSE.ts` | Agent 对话消费（IPC） |
| `client/src/hooks/useTerminalConnection.ts` | 终端适配（IPC node-pty） |

### 已删除

- `client/src/services/WorkerManager.ts` — WebSocket 管理器
- `client/src/workers/socket.worker.ts` — WebSocket Worker
- `terminal-server/` — Web 模式终端服务
- `npm run dev` / `npm run start` / `npm run build` — Web 模式脚本

## 开发命令

```bash
npm run electron:dev     # 开发模式
npm run electron:build   # 构建
npm run electron:dist    # 生成安装包
```
