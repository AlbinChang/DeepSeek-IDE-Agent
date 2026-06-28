# Electron 桌面应用迁移指南

## 概述

将 DeepSeek IDE Agent 从 Web 三进程架构（Client + Server + Terminal-Server）迁移到 Electron 单进程桌面应用。

## 架构对比

### 迁移前（Web 架构）
```
Browser (React) ──HTTP/SSE──▶ Server (Fastify) ──REST──▶ Terminal-Server (Fastify + node-pty)
    │                              │
    └──WebSocket──────────────────┘
```
- 3 个独立 Node.js 进程
- HTTP/SSE/WS 协议通信（localohost 也走 TCP 栈）
- 浏览器沙箱限制文件/进程访问

### 迁移后（Electron 架构）
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
- 单进程架构（Main + Renderer）
- Electron IPC 替代 HTTP/SSE/WS
- 完整的文件系统和进程访问权限

## 已完成的迁移

### 1. Electron 项目脚手架 (`electron/`)
| 文件 | 说明 |
|------|------|
| `electron/package.json` | Electron + electron-builder 依赖 |
| `electron/tsconfig.json` | Main Process TypeScript 配置 |
| `electron/electron-builder.yml` | 打包/分发配置 |
| `electron/scripts/dev.mjs` | 开发启动脚本（Vite + Electron） |

### 2. Main Process 入口
| 文件 | 说明 |
|------|------|
| `electron/src/main/index.ts` | App 生命周期、窗口创建、IPC 注册 |
| `electron/src/main/preload.ts` | contextBridge 安全桥接 |

### 3. IPC 处理器（替换 HTTP/WS/SSE 路由）
| 文件 | 替换内容 |
|------|----------|
| `electron/src/main/ipc/agent-handlers.ts` | 替换 `ChatSSERoute.ts` — 直接调用 AgentChatComponent |
| `electron/src/main/ipc/file-handlers.ts` | 替换 REST `/api/files/*` — 直接使用 fs |
| `electron/src/main/ipc/terminal-handlers.ts` | **吸收 terminal-server** — 直接使用 node-pty |
| `electron/src/main/ipc/git-handlers.ts` | 替换 Git REST 路由 — 直接使用 simple-git |
| `electron/src/main/ipc/settings-handlers.ts` | 替换设置 REST 路由 + 连接测试 |
| `electron/src/main/ipc/context-handlers.ts` | 替换 `/ws/context` + `/ws/completion` |
| `electron/src/main/ipc/app-handlers.ts` | 新增：工作区选择对话框、应用信息 |

### 4. 前端适配层
| 文件 | 说明 |
|------|------|
| `client/src/types/electron.d.ts` | `window.electronAPI` TypeScript 声明 |
| `client/src/services/electron-bridge.ts` | 统一 API（自动选择 Electron IPC 或 Web HTTP，含 settings/testConnection） |
| `client/src/hooks/useTerminalConnection.ts` | 终端适配 Hook（IPC 模式 + SSE 模式） |
| `client/src/hooks/useAgentSSE.ts` | ✅ 已改造 — Electron IPC + Web SSE 双模 |
| `client/src/components/FileEditor.tsx` | ✅ 已改造 — `handleSaveFile` 支持 IPC 直写 |
| `client/src/components/SearchPanel.tsx` | ✅ 已改造 — 搜索支持 IPC 直搜文件系统 |
| `client/src/components/SourceControl.tsx` | ✅ 已改造 — Git status/log/diff 全部支持 IPC |
| `client/src/components/SettingsModal.tsx` | ✅ 已改造 — 连接测试 + 设置同步支持 IPC |
| `client/src/providers/AgentContext.tsx` | ✅ 已改造 — 设置加载/同步/刷新支持 IPC |

## 待完成的工作

### 中优先级
1. **代码补全 → 对接 CompletionService**
   - `electron/src/main/ipc/context-handlers.ts` 中的 CompletionService 集成（目前为占位实现）

### 低优先级
2. **electron-builder 打包测试** — 运行 `npm run electron:dist` 生成安装包
3. **自动更新机制** (`electron-updater`)
4. **原生菜单栏** (File/Edit/View/Help)
5. **多窗口支持** (设置独立窗口等)

## 开发命令

```bash
# Web 开发模式（原有方式，仍然可用）
npm run dev

# Electron 开发模式（新）
npm run electron:dev

# Electron 构建
npm run electron:build

# Electron 打包（生成安装包）
npm run electron:dist
```

## 关键设计决策

1. **增量迁移策略**：保留所有 Web 代码，`electron-bridge.ts` 在两种模式下均可工作
2. **安全优先**：预加载脚本使用 `contextBridge` + `contextIsolation`，不暴露 Node API
3. **服务复用**：Electron Main Process 直接 import `server/src/` 中的服务类（AgentService、AgentTurnEngine 等）
4. **IPC 替代协议**：
   - POST/SSE → `ipcMain.on` + `webContents.send`（流式推送）
   - REST → `ipcMain.handle` + `ipcRenderer.invoke`（请求-响应）
   - WebSocket → `ipcMain.on` + `webContents.send`（双向事件）

## 性能收益预估

| 指标 | Web 架构 | Electron 架构 | 改善 |
|------|----------|---------------|------|
| 进程数 | 3 (client + server + terminal) | 2 (main + renderer) | -33% |
| 文件读取延迟 | ~5-15ms (HTTP 往返) | ~0.5-2ms (fs 直读) | ~90% ↓ |
| 终端按键延迟 | ~3-8ms (HTTP POST) | ~0.1ms (IPC) | ~95% ↓ |
| Agent 流式延迟 | ~1-3ms (SSE 帧) | ~0.1ms (IPC 消息) | ~90% ↓ |
| 内存占用 | ~800MB (3 进程) | ~400MB (1 应用) | ~50% ↓ |
| 启动时间 | ~8-12s (3 进程并发) | ~3-5s | ~60% ↓ |
