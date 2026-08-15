# DeepSeek IDE Agent — 启动指南

## 目录

- [1. 环境要求](#1-环境要求)
- [2. 快速开始](#2-快速开始)
- [3. 构建与打包](#3-构建与打包)
- [4. 项目结构](#4-项目结构)
- [5. 常见问题](#5-常见问题)

---

## 1. 环境要求

| 依赖 | 版本要求 | 说明 |
|------|----------|------|
| **Node.js** | ≥ 20.x | 推荐 20.19+ LTS |
| **pnpm** | ≥ 9.x / 10.x / 11.x | 包管理器（`npm i -g pnpm`） |
| **Windows** | 10/11 x64 | 开发 & 打包平台 |
| **Git** | ≥ 2.30 | 源码管理功能需要 |

> **注意**：`node-pty` 包含 C++ 原生模块，Windows 上需要 **Microsoft Visual C++ Build Tools** 或 **Windows SDK**。如遇 `node-pty` 编译失败，安装 Visual Studio Build Tools（勾选「使用 C++ 的桌面开发」）。

---

## 2. 快速开始

DeepSeek IDE Agent 现已重构为 **纯 Electron 桌面应用**。所有核心能力（Agent 对话、终端、文件操作、Git）均通过 IPC 直连主进程，零网络开销。

### 2.1 配置 API Key

在项目根目录创建 `.env` 文件：

```bash
# d:\web-ide-agent\.env
DEEPSEEK_API_KEY=sk-your-api-key-here
```

> `.env` 已加入 `.gitignore`，不会提交到仓库。

### 2.2 首次安装

```powershell
cd d:\web-ide-agent

# 安装项目全量依赖（基于 pnpm workspace，自动安装 client、server、electron 所有依赖）
pnpm install
```

> 如果下载 `electron` 二进制缓慢，可设置国内镜像：
> ```powershell
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> pnpm install
> ```

### 2.3 启动开发模式

```powershell
cd d:\web-ide-agent

# 一键启动（编译 preload → 启动 Vite → 启动 Electron）
pnpm run electron:dev
```

启动后会自动：
1. esbuild 编译 `preload.ts` + `main/index.ts`（毫秒级）
2. Vite Dev Server 启动（端口 `5174`，支持 HMR 热更新）
3. Electron 窗口打开，加载 `http://localhost:5174`

访问 `http://localhost:5174` 可单独调试前端 UI。

### 2.4 架构说明

所有功能均通过 **IPC（进程间通信）** 在主进程中直接执行：

| 功能 | 实现方式 |
|------|----------|
| Agent 对话 | IPC 事件流 → AgentChatComponent（OpenAI SDK） |
| 文件读写 | `file:read` / `file:write` IPC → `fs` 直调 |
| 文件搜索 | `file:search` IPC → 文件系统扫描 |
| 终端 | `terminal:*` IPC → `node-pty` 直连 |
| Git 操作 | `git:*` IPC → `simple-git` 直调 |
| 设置管理 | `settings:*` IPC → 本地 JSON 文件 |

控制台颜色标签：
- `[PRELOAD]` 紫色 — preload 编译
- `[MAIN]` 蓝色 — 主进程编译
- `[VITE]` 黄色 — Vite 开发服务器
- `[ELECTRON]` 绿色 — Electron 主进程

---

## 3. 构建与打包

### 3.1 构建 Electron 应用

```powershell
cd d:\web-ide-agent

# 构建所有组件（preload + main process + renderer）
pnpm run electron:build
```

构建产物：
```
electron/dist/
├── preload.cjs             # 编译后的 preload 脚本
└── main/
    └── index.js            # 编译后的主进程（含 server 模块）
client/dist/                # Vite 构建的前端静态文件
```

### 3.2 打包为桌面安装包

```powershell
cd d:\web-ide-agent

# 仅打包目录（测试用，不生成安装包）
pnpm run electron:pack

# 生成安装包
pnpm run electron:dist       # 当前平台
```

平台特定打包：
```powershell
cd electron
pnpm run dist:win            # Windows .exe (NSIS 安装包)
pnpm run dist:mac            # macOS .dmg
pnpm run dist:linux          # Linux .AppImage
```

打包产物位于 `electron/release/`。

### 3.3 安装包配置

编辑 `electron/electron-builder.yml`：

```yaml
appId: com.deepseek.ide-agent
productName: DeepSeek IDE Agent

win:
  target:
    - target: nsis
      arch: [x64]

nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true

asar: true
asarUnpack:
  - node_modules/node-pty/**
  - node_modules/@playwright/**
```

---

## 4. 项目结构

```
web-ide-agent/
├── .env                          # API Key（不提交 Git）
├── package.json                  # 根 scripts
│
├── client/                       # 前端 React 应用
│   └── src/
│       ├── components/           # UI 组件
│       │   ├── AgentChat.tsx      # AI 对话面板
│       │   ├── FileEditor.tsx     # Monaco 编辑器
│       │   ├── Terminal.tsx       # xterm.js 终端
│       │   ├── FileTree.tsx       # 文件树
│       │   ├── SourceControl.tsx  # Git 管理
│       │   ├── SearchPanel.tsx    # 文件搜索
│       │   └── SettingsModal.tsx  # LLM 配置
│       ├── hooks/                # React Hooks
│       │   ├── useAgentSSE.ts     # Agent 对话消费
│       │   └── useInlineCompletions.ts
│       ├── services/
│       │   └── electron-bridge.ts # IPC 桥接层
│       └── providers/
│           └── AgentContext.tsx   # 全局状态
│
├── server/                       # Agent 核心逻辑（被 Electron 主进程引用）
│   └── src/
│       ├── services/
│       │   ├── AgentService.ts        # 工具注册 & 生命周期
│       │   ├── AgentTurnEngine.ts     # AI 流式调用 & 工具执行
│       │   └── AgentChatComponent.ts  # 对话循环
│       └── config/
│           ├── main-agent.json        # 主 Agent 提示词
│           └── evaluator-agent.json   # 评估 Agent 提示词
│
├── electron/                     # Electron 桌面应用
│   ├── package.json              # Electron 33 + electron-builder
│   ├── electron-builder.yml      # 打包配置
│   ├── scripts/
│   │   └── dev.mjs               # 开发启动脚本
│   └── src/
│       └── main/
│           ├── index.ts          # 主进程入口
│           ├── preload.ts        # contextBridge 安全桥接
│           └── ipc/
│               ├── agent-handlers.ts     # Agent 对话
│               ├── file-handlers.ts      # 文件操作
│               ├── terminal-handlers.ts  # 终端 PTY
│               ├── git-handlers.ts       # Git 操作
│               ├── settings-handlers.ts  # 设置管理
│               ├── context-handlers.ts   # 上下文 & 补全
│               └── app-handlers.ts       # 应用级 IPC
│
└── docs/
    └── STARTUP.md                # 本文件
```

---

## 5. 常见问题

### Q: `pnpm install` 在 electron/ 目录失败？

A: `node-pty` 是 C++ 原生模块，需要编译工具链。
请安装 Visual Studio Build Tools（勾选「使用 C++ 的桌面开发」工作负荷）。

### Q: `electron:dev` 启动后白屏？

A: 检查 Vite 开发服务器是否成功启动（控制台应有 Vite ready 日志）。手动访问 `http://localhost:5174` 确认前端可用。

### Q: Electron 窗口打开后 AI 对话无响应？

A: 确认根目录 `.env` 文件存在且 `DEEPSEEK_API_KEY` 正确：
```powershell
Get-Content d:\web-ide-agent\.env
```

### Q: 如何在 Electron 中调试？

A: 开发模式下自动打开 DevTools。Main Process 日志输出在启动终端中。

### Q: 能否定制 Vite 端口？

A: 设置环境变量后启动：
```powershell
$env:VITE_DEV_PORT="5175"
pnpm run electron:dev
```

---

## 命令速查

```powershell
# ═══════════════════════════════════════
# 首次安装
# ═══════════════════════════════════════
pnpm install

# ═══════════════════════════════════════
# 日常开发
# ═══════════════════════════════════════
pnpm run electron:dev     # 启动 Electron 开发模式

# ═══════════════════════════════════════
# 构建 & 部署
# ═══════════════════════════════════════
pnpm run electron:build   # 构建应用
pnpm run electron:dist    # 生成桌面安装包
```
