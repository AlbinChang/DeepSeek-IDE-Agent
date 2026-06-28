# DeepSeek IDE Agent — 启动指南

## 目录

- [1. 环境要求](#1-环境要求)
- [2. 快速开始（Web 模式）](#2-快速开始web-模式)
- [3. Electron 桌面应用模式](#3-electron-桌面应用模式)
- [4. 构建与打包](#4-构建与打包)
- [5. 项目结构](#5-项目结构)
- [6. 常见问题](#6-常见问题)

---

## 1. 环境要求

| 依赖 | 版本要求 | 说明 |
|------|----------|------|
| **Node.js** | ≥ 20.x | 推荐 20.19+ LTS |
| **npm** | ≥ 10.x | 随 Node.js 附带 |
| **Windows** | 10/11 x64 | 开发 & 打包平台 |
| **Git** | ≥ 2.30 | 源码管理功能需要 |

> **注意**：`node-pty` 包含 C++ 原生模块，Windows 上需要 **Microsoft Visual C++ Build Tools** 或 **Windows SDK**。如遇 `node-pty` 安装失败，运行：
> ```powershell
> npm install --global windows-build-tools
> ```

---

## 2. 快速开始（Web 模式）

Web 模式沿用原有的三进程架构，适合调试和开发。

### 2.1 配置 API Key

在项目根目录创建 `.env` 文件：

```bash
# d:\web-ide-agent\.env
DEEPSEEK_API_KEY=sk-your-api-key-here
OPENAI_API_KEY=sk-your-openai-key   # 可选，多 Provider 支持
```

> `.env` 已加入 `.gitignore`，不会提交到仓库。

### 2.2 安装 & 启动

```powershell
# 1. 在项目根目录安装所有子项目依赖
cd d:\web-ide-agent
npm install --prefix client
npm install --prefix server
npm install --prefix terminal-server

# 2. 启动开发模式（三进程并行）
npm run dev
```

启动后访问 **http://localhost:5174**。

| 进程 | 端口 | 技术栈 |
|------|------|--------|
| 🌐 Web Client | `5174` | Vite 7 + React 19 |
| ⚙️ API Server | `3001` | Fastify 5 + OpenAI SDK |
| 💻 Terminal Server | `3003` | Fastify 4 + node-pty |

### 2.3 生产模式启动（Web）

```powershell
# 构建所有子项目
npm run build

# 启动生产服务
npm run start
```

---

## 3. Electron 桌面应用模式

Electron 模式将三个进程合并为单应用，**零网络开销**。

### 3.1 首次安装 Electron 依赖

```powershell
# 进入 electron 目录安装依赖（含 electron 二进制 ~100MB，需等待）
cd d:\web-ide-agent\electron
npm install
```

> 如果下载 `electron` 二进制缓慢，可设置国内镜像：
> ```powershell
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> npm install
> ```

### 3.2 启动 Electron 开发模式

```powershell
# 回到项目根目录
cd d:\web-ide-agent

# 一键启动（编译 preload → 启动 Vite → 启动 Electron）
npm run electron:dev
```

启动后会自动：
1. 编译 `preload.ts` → `electron/dist/preload.js`（esbuild，毫秒级）
2. 启动 Vite Dev Server（端口 `5174`，支持 HMR 热更新）
3. 启动 Electron 窗口，加载 `http://localhost:5174`

控制台颜色标签：
- `[PRELOAD]` 紫色 — preload 编译状态
- `[VITE]` 黄色 — Vite 开发服务器
- `[ELECTRON]` 绿色 — Electron 主进程

### 3.3 与 Web 模式的差异

| 功能 | Web 模式 | Electron 模式 |
|------|----------|---------------|
| Agent 对话 | `fetch` SSE 流 | **IPC 事件流**（直调 AgentChatComponent） |
| 文件保存 | `axios POST /api/files/save` | **`fs.writeFileSync`**（零网络开销） |
| 文件搜索 | `axios GET /api/search` | **直搜文件系统** |
| 终端 | SSE 连接 terminal-server | **node-pty 直连**（主进程内） |
| Git 操作 | REST API 调用 | **simple-git 直调** |
| 设置持久化 | REST `/api/settings/sync` | **IPC + 本地 JSON 文件** |
| 连接测试 | 服务端代理转发 | **主进程直连 AI API** |

### 3.4 工作区选择

Electron 模式下，启动后会弹出原生文件夹选择对话框，或通过应用内的 **工作区初始化** 功能选择项目目录。

---

## 4. 构建与打包

### 4.1 构建 Electron 应用

```powershell
cd d:\web-ide-agent

# 构建所有组件（preload + main process + renderer）
npm run electron:build
```

构建产物：
```
electron/dist/
├── preload.cjs             # 编译后的 preload 脚本（CJS，Electron preload 必须用 .cjs）
└── main/
    └── index.js            # 编译后的主进程（ESM）
client/dist/                # Vite 构建的前端静态文件
```

### 4.2 打包为桌面安装包

```powershell
cd d:\web-ide-agent

# 仅打包目录（测试用，不生成安装包）
npm run electron:pack

# 生成安装包
npm run electron:dist       # 全平台（当前平台）
```

平台特定打包：
```powershell
npm run electron:dist       # 等同于 electron-builder --win（Windows 上）
# 或在 electron 目录内：
cd electron
npm run dist:win            # Windows .exe (NSIS 安装包)
npm run dist:mac            # macOS .dmg
npm run dist:linux          # Linux .AppImage
```

打包产物位于 `electron/release/`。

### 4.3 安装包配置

编辑 `electron/electron-builder.yml`：

```yaml
appId: com.deepseek.ide-agent
productName: DeepSeek IDE Agent

win:
  target:
    - target: nsis        # NSIS 安装包（推荐）
      arch: [x64]

nsis:
  oneClick: false                    # 非一键安装，允许选择目录
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true        # 创建桌面快捷方式
  createStartMenuShortcut: true      # 创建开始菜单快捷方式

asar: true                           # 打包为 asar 压缩
asarUnpack:
  - node_modules/node-pty/**         # 原生模块需解包
  - node_modules/@playwright/**
```

---

## 5. 项目结构

```
web-ide-agent/
├── .env                          # API Key 等环境变量（不提交 Git）
├── package.json                  # 根 scripts
│
├── client/                       # 前端 React 应用
│   ├── src/
│   │   ├── components/           # UI 组件
│   │   │   ├── AgentChat.tsx      # AI 对话面板
│   │   │   ├── FileEditor.tsx     # Monaco 编辑器
│   │   │   ├── Terminal.tsx       # xterm.js 终端
│   │   │   ├── FileTree.tsx       # 文件树
│   │   │   ├── SourceControl.tsx  # Git 管理
│   │   │   ├── SearchPanel.tsx    # 文件搜索
│   │   │   └── SettingsModal.tsx  # LLM 配置
│   │   ├── hooks/
│   │   │   ├── useAgentSSE.ts     # Agent SSE 消费（Electron 已改造）
│   │   │   └── useTerminalConnection.ts  # 终端适配 Hook
│   │   ├── services/
│   │   │   └── electron-bridge.ts # Electron ↔ Web 统一 API 桥
│   │   ├── types/
│   │   │   └── electron.d.ts     # window.electronAPI 类型声明
│   │   └── providers/
│   │       └── AgentContext.tsx   # 全局状态 + 设置管理（Electron 已改造）
│   └── vite.config.ts
│
├── server/                       # 后端 API 服务
│   └── src/
│       ├── services/
│       │   ├── AgentService.ts        # Agent 工具注册 & 生命周期
│       │   ├── AgentTurnEngine.ts     # AI 流式调用 & 工具执行引擎
│       │   ├── AgentChatComponent.ts  # 对话外层循环
│       │   ├── ChatSSERoute.ts        # SSE 路由（Web 专用）
│       │   └── ...
│       └── config/
│           ├── main-agent.json        # 主 Agent 系统提示词
│           └── evaluator-agent.json   # 评估 Agent 提示词
│
├── terminal-server/              # 终端 PTY 服务（Web 专用，Electron 已吸收）
│
├── electron/                     # Electron 桌面应用
│   ├── package.json              # Electron 33 + electron-builder
│   ├── tsconfig.json             # Main Process TypeScript 配置
│   ├── electron-builder.yml      # 打包配置
│   ├── MIGRATION.md              # 迁移文档
│   ├── scripts/
│   │   └── dev.mjs               # 开发启动脚本
│   └── src/
│       └── main/
│           ├── index.ts          # App 入口 & 窗口管理
│           ├── preload.ts        # contextBridge 安全桥接
│           └── ipc/
│               ├── agent-handlers.ts     # Agent 对话 IPC
│               ├── file-handlers.ts      # 文件操作 IPC
│               ├── terminal-handlers.ts  # 终端 IPC（吸收 terminal-server）
│               ├── git-handlers.ts       # Git 操作 IPC
│               ├── settings-handlers.ts  # 设置管理 IPC
│               ├── context-handlers.ts   # 上下文 & 补全 IPC
│               └── app-handlers.ts       # 应用级 IPC
│
└── scripts/
    └── start-services.mjs        # Web 模式三进程编排脚本
```

---

## 6. 常见问题

### Q: `npm install` 在 electron/ 目录失败？

A: `node-pty` 是 C++ 原生模块，需要编译工具链。
```powershell
# 安装 Windows 构建工具（管理员终端）
npm install --global --production windows-build-tools

# 或安装 Visual Studio 2022 Build Tools，勾选 "Desktop development with C++"
```

### Q: `electron:dev` 启动后白屏？

A: 检查 Vite 开发服务器是否成功启动（控制台应有 `[VITE] Dev server ready` 日志）。手动访问 `http://localhost:5174` 确认前端可用。

### Q: Electron 窗口打开后 AI 对话无响应？

A: 确认根目录 `.env` 文件存在且 API Key 正确。Electron Main Process 会从项目根加载 `.env`：
```powershell
# 测试 API Key 是否有效
cd d:\web-ide-agent
Get-Content .env
```

### Q: 能否同时运行 Web 模式和 Electron 模式？

A: 可以，但需要不同端口。Web 模式默认用 `5174`，Electron 开发模式也用 `5174`。如需同时运行，修改 `electron/scripts/dev.mjs` 中的 `VITE_PORT` 环境变量：
```powershell
$env:VITE_DEV_PORT="5175"
npm run electron:dev
```

### Q: 打包后的安装包在哪？

A: `electron/release/` 目录。Windows 上生成 `DeepSeek IDE Agent Setup x.x.x.exe`。

### Q: 如何在 Electron 中调试？

A: 开发模式下 Electron 窗口会自动打开 DevTools（`openDevTools({ mode: 'detach' })`）。Main Process 日志输出在启动终端中。

### Q: Web 模式还有必要保留吗？

A: 保留。Web 模式用于：
- 无需安装桌面应用的快速体验
- 远程服务器部署（通过浏览器访问）
- 前端 UI 的独立开发调试（HMR 速度更快）

---

## 命令速查

```powershell
# ═══════════════════════════════════════
# 首次安装
# ═══════════════════════════════════════
npm install --prefix client
npm install --prefix server
npm install --prefix terminal-server
cd electron && npm install && cd ..

# ═══════════════════════════════════════
# 日常开发
# ═══════════════════════════════════════
npm run dev              # Web 三进程开发模式
npm run electron:dev     # Electron 桌面开发模式

# ═══════════════════════════════════════
# 构建 & 部署
# ═══════════════════════════════════════
npm run build            # Web 模式构建
npm run electron:build   # Electron 应用构建
npm run electron:dist    # 生成桌面安装包
```
