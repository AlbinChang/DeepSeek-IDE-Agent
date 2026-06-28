# DeepSeek IDE Agent

<p align="center">
  <img src="https://img.shields.io/badge/DeepSeek-Reasoner-14b8a6?style=for-the-badge&logo=deepseek&logoColor=white" alt="DeepSeek"/>
  <img src="https://img.shields.io/badge/Electron-33-47848f?style=for-the-badge&logo=electron&logoColor=white" alt="Electron"/>
  <img src="https://img.shields.io/badge/React-19-0d9488?style=for-the-badge&logo=react" alt="React 19"/>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/license-MIT-22c55e?style=for-the-badge" alt="License"/>
</p>

<p align="center">
  <b>🧠 双核 AI Agent 驱动的 Electron 桌面 IDE</b> — 让 AI 直接在您的代码工作区中思考、编码与迭代
</p>

---

## 1. 环境要求

- Node.js 20+（推荐 20.19+ LTS）
- npm 10+
- Windows 10/11 x64
- Git（可选，用于版本控制功能）

> `node-pty` 包含 C++ 原生模块，需安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)（勾选 "Desktop development with C++"）。

## 2. 配置 API Key

在项目根目录创建 `.env` 文件：

```bash
DEEPSEEK_API_KEY=sk-your-api-key-here
DEEPSEEK_MODEL=deepseek-chat
```

> 从 [platform.deepseek.com](https://platform.deepseek.com/api_keys) 获取 API Key。兼容所有 OpenAI 接口的服务。

## 3. 安装 & 启动

```powershell
cd d:\web-ide-agent

# 安装前端依赖
npm install --prefix client

# 安装 Electron 及原生模块（首次需下载 ~100MB 二进制）
cd electron && npm install && cd ..

# 一键启动
npm run electron:dev
```

> 📖 详细启动指南：[docs/STARTUP.md](docs/STARTUP.md)

## 4. 架构概览

系统采用 **Electron 单应用** 架构，所有功能通过 IPC 在主进程中直调，零网络开销。

| 功能 | 实现方式 |
|------|----------|
| Agent 对话 | IPC → OpenAI SDK 直调 DeepSeek API |
| 文件读写 | IPC → `fs` 直调文件系统 |
| 终端 | IPC → `node-pty` 伪终端 |
| Git 操作 | IPC → `simple-git` 直调 |
| 设置管理 | IPC → 本地 JSON 文件 |

### 双核 Agent 循环

1. **主 Agent**：接收指令，执行工具调用（文件、终端、浏览器等），产出结果。
2. **评估 Agent**：独立核验主 Agent 产出，生成评估报告，决定是否继续迭代。

### 关键工具能力

| 工具类别 | 说明 |
| :--- | :--- |
| 文件操作 | 读取、写入、编辑、删除工作区文件 |
| 终端命令 | PowerShell / CMD 命令执行 |
| 代码搜索 | 工作区内的语义搜索与正则搜索 |
| Git 版本控制 | 查看状态、历史、差异 |
| MCP 工具 | 用户自定义 MCP 服务器工具 |

### 自定义 MCP 工具

在工作区根目录创建 `.mcp/` 文件夹，放入 MCP 配置 JSON 文件，Agent 自动扫描并注入：

```json
{
  "name": "github",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
}
```

## 5. 构建 & 打包

```powershell
npm run electron:build   # 构建应用
npm run electron:dist    # 生成桌面安装包 → electron/release/
```
}
```

工具将以 `{服务器名}__{原生工具名}` 格式注册（如 `github__search_repositories`），对 AI 模型完全透明。

> **离线环境注意**：如果在无网络的生产机上使用 MCP 工具，需将 MCP 服务器的 npm 包预先打包部署。详见 [DEPLOYMENT.md](./DEPLOYMENT.md) 第 1.3.3 节。

### Agent 行为契约（关键硬约束）

## 6. 常见问题

### Q1：启动后 Electron 白屏？

检查终端中是否显示 `[VITE] Dev server ready`。手动访问 `http://localhost:5174` 确认前端可用。如果端口被占用，`dev.mjs` 会自动清理。

### Q2：AI 对话无响应？

确认 `.env` 中 `DEEPSEEK_API_KEY` 有效。可手动测试：
```powershell
Get-Content d:\web-ide-agent\.env
```

### Q3：如何离线部署？

构建安装包后直接分发 `electron/release/` 中的 `.exe` 文件即可，无需 Node.js 环境。

### Q4：`node-pty` 编译失败？

安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)，勾选 "Desktop development with C++"。


```bash
# 1. 拷贝项目
cp -r deepseek-ide-agent deepseek-ide-agent-2    # macOS/Linux


## 7. 项目结构

```
web-ide-agent/
├── .env                    ← API Key 配置
├── package.json            ← 根级脚本
├── client/                 ← 前端（React 19 + Vite + Monaco Editor）
│   └── src/
│       ├── components/     ← UI 组件
│       ├── services/       ← electron-bridge IPC 桥接
│       └── providers/      ← React Context
├── server/                 ← Agent 核心逻辑（被 Electron 主进程引用）
│   └── src/
│       ├── config/         ← Agent 提示词配置
│       ├── services/       ← AgentEngine、McpService、GitService 等
│       └── tools/          ← Agent 工具实现
├── electron/               ← Electron 桌面应用
│   └── src/
│       └── main/
│           ├── index.ts    ← 主进程入口
│           ├── preload.ts  ← 安全桥接
│           └── ipc/        ← IPC 处理器（agent/file/terminal/git/...）
└── docs/
    └── STARTUP.md          ← 启动指南
```

---

## 11. 安全提醒

- ❌ **不要提交**：`.env`、API Key、Token、密码、私钥证书
- ❌ **不要提交**：`node_modules/`、`dist/`、`.temp/`、临时缓存文件
- ✅ **提交前检查**：
  ```bash
  git status
  ```
- `.env.example` 仅包含示例值，可安全提交；`.env` 已在 `.gitignore` 中排除
