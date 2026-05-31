# DeepSeek IDE Agent

<p align="center">
  <img src="https://img.shields.io/badge/DeepSeek-Reasoner-14b8a6?style=for-the-badge&logo=deepseek&logoColor=white" alt="DeepSeek"/>
  <img src="https://img.shields.io/badge/React-19-0d9488?style=for-the-badge&logo=react" alt="React 19"/>
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178c6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/Fastify-5-f97316?style=for-the-badge&logo=fastify&logoColor=white" alt="Fastify"/>
  <img src="https://img.shields.io/badge/license-MIT-22c55e?style=for-the-badge" alt="License"/>
</p>

<p align="center">
  <b>🧠 双核 AI Agent 驱动的浏览器端 IDE</b> — 让 AI 直接在您的代码工作区中思考、编码与迭代
</p>

---

### 🏗️ 功能架构

<p align="center">
  <img src="docs/functional-architecture.svg" alt="功能架构图" width="100%"/>
</p>

### ⚙️ 技术架构

<p align="center">
  <img src="docs/technical-architecture.svg" alt="技术架构图" width="100%"/>
</p>

---

## 1. 环境要求

- Node.js 18+（推荐 20.x LTS）
- npm 9+
- Windows / macOS / Linux
- Git（可选，用于版本控制功能）

## 2. 配置环境变量（必须）

项目通过根目录 `.env` 文件管理所有运行参数，**不配置 API Key 将无法使用 AI 功能**。

```bash
# 在项目根目录执行，从模板创建 .env
cp .env.example .env
```

然后编辑 `.env`，**至少填写以下两项**：

```ini
# [必需] 你的 DeepSeek API Key（从 https://platform.deepseek.com 获取）
DEEPSEEK_API_KEY=sk-your_api_key_here

# [必需] 模型 ID：deepseek-chat（通用）/ deepseek-reasoner（推理增强）
DEEPSEEK_MODEL=deepseek-chat
```

> **💡 兼容 OpenAI 接口**：如果使用其他兼容 OpenAI API 的服务（如本地 Ollama、OneAPI 等），只需修改 `DEEPSEEK_BASE_URL` 和 `DEEPSEEK_MODEL` 即可，变量名保持不变。

完整配置项说明请参考 `.env.example` 文件内注释，或下方 [⚙️ 完整配置参考](#-完整配置参考) 章节。

## 3. 安装依赖

项目由三个子包组成（`server` / `client` / `terminal-server`），需要在**根目录和每个子目录**分别安装依赖：

```bash
# 根目录
npm install

# 三个子包（必须全部安装）
cd server && npm install && cd ..
cd client && npm install && cd ..
cd terminal-server && npm install && cd ..
```

> 如果遇到 `node-pty` 等原生模块编译失败，请确保已安装 [Windows Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)（Windows）或 Xcode Command Line Tools（macOS）。

## 4. 启动项目

### 4.1 开发模式（推荐）

```bash
npm run dev
```

该命令会启动三个服务，终端中会以不同颜色区分日志输出：

| 服务 | 端口 | 标签 | 说明 |
| :--- | :--- | :--- | :--- |
| 前端页面 (client) | **5174** | `WEB` | Vite 开发服务器，浏览器访问入口 |
| Agent 主服务 (server) | **3001** | `API` | 主 Agent + 评估 Agent 双核引擎 |
| 终端服务 (terminal-server) | **3003** | `PTY` | 伪终端服务，执行 Shell 命令 |

### 4.2 生产模式

```bash
npm run build   # 先构建
npm run start   # 再启动
```

### 4.3 访问地址

打开浏览器访问：**`http://localhost:5174`**

> 如果端口被占用，可通过 `.env` 中的 `DEV_PORT`、`PORT`、`TERMINAL_SERVER_PORT` 自定义端口号。

## 5. 首次使用

1. **打开前端**：浏览器访问 `http://localhost:5174`
2. **配置模型**：点击右上角 ⚙️ 设置按钮进入「LLM 配置中心」，填写 API Key / Base URL / Model。配置会自动持久化到工作区的 `.llm/` 目录，无需每次重新输入。若跳过前端配置，服务端将使用 `.env` 中的默认值作为兜底。
3. **选择工作区**：在左侧文件树顶部选择要操作的本地文件夹作为工作区（或提前在 `.env` 中设置 `WORKSPACE_ROOT`）
4. **开始对话**：在底部聊天输入框描述你的任务，Agent 会自动分析并执行

> **提示**：首次使用建议先用简单任务测试（如「列出当前目录的文件」），确认 Agent 可以正常读取工作区后再执行复杂任务。

## 6. 常用命令

在项目根目录执行：

```bash
# 开发模式启动（热重载）
npm run dev

# 一键构建全部子项目
npm run build

# 生产模式启动（需先 build）
npm run start

# 检查配置文件是否就绪
npm run check:conf
```

`npm run check:conf` 会检查以下文件是否存在：
- `server/server_conf.json`（服务端口配置）
- `terminal-server/server_conf.json`（终端端口配置）
- `client/server_conf.json`（前端端口配置）
- 各子项目的 `dist/` 构建产物目录

## 7. 架构概览

系统采用**主 Agent + 评估 Agent 双核循环**架构：

1. **主 Agent**（`AgentChatComponent` + `AgentTurnEngine`）：接收用户指令，执行工具调用（文件读写、终端命令、浏览器自动化、用户 MCP 工具等），产出最终回复。
2. **评估 Agent**（`EvaluationAgentService`）：独立核验主 Agent 产出，生成评估报告，决策是否需要继续迭代。
3. **历史会话优化**（`HistoryOptimizerService`）：负责上下文裁剪与清洗，确保多轮对话在 Token 限制内运行。

### 关键工具能力

| 工具类别 | 说明 |
| :--- | :--- |
| 文件操作 | 读取、写入、编辑、删除工作区内文件 |
| 终端命令 | 通过 PTY 伪终端执行 Shell/PowerShell 命令 |
| 浏览器自动化 | 基于 Playwright MCP 的网页浏览、截图、交互 |
| 代码搜索 | 工作区内的语义搜索与正则搜索 |
| Git 版本控制 | 查看状态、历史、差异（需工作区为 Git 仓库） |
| MCP 工具 | 用户自定义的 MCP 服务器工具（见下方） |

### 用户自定义 MCP 工具

在你的 **工作区根目录**（不是本项目目录）创建 `.mcp/` 文件夹，放入 MCP 服务器配置 JSON 文件（一个 `.json` 文件对应一个 MCP 服务器），Agent 启动后自动扫描并注入对应工具。

示例 `my-github.json`：

```json
{
  "name": "github",
  "description": "GitHub API 工具集",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
}
```

工具将以 `{服务器名}__{原生工具名}` 格式注册（如 `github__search_repositories`），对 AI 模型完全透明。

> **离线环境注意**：如果在无网络的生产机上使用 MCP 工具，需将 MCP 服务器的 npm 包预先打包部署。详见 [DEPLOYMENT.md](./DEPLOYMENT.md) 第 1.3.3 节。

### Agent 行为契约（关键硬约束）

主 Agent 与评估 Agent 的提示词配置文件位于：

- 主 Agent：`server/src/config/main-agent.json`
- 评估 Agent：`server/src/config/evaluator-agent.json`

当前版本已落地的核心约束：

| 约束类别 | 说明 |
| :--- | :--- |
| PPT/幻灯片 | 16:9 宽屏（960pt × 540pt），SVG 唯一绘制引擎，明亮清晰风格，零重叠/溢出/文字平铺 |
| 文档/报告 | 内容正确性、素材充分性、去重；禁止虚构数据/案例/引用 |
| 临时文件 | 仅允许放在 `.temp/` 目录；最终交付文件禁止放入 `.temp/` |
| 代码治理 | 编写代码时同步清理触达范围内的历史债务（重复实现、废弃代码、无效导入等） |
| 双核核验 | 主 Agent 与评估 Agent 共享同一套工具链，评估 Agent 可独立核验工作区产出 |

---

## 8. ⚙️ 完整配置参考

### 8.1 服务端口

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `3001` | Agent 主 API 服务端口 |
| `TERMINAL_SERVER_PORT` | `3003` | 终端 PTY 服务端口 |
| `DEV_PORT` | `5174` | 前端 Vite 开发服务器端口 |
| `HOST` | `0.0.0.0` | 服务监听地址 |
| `PORT_RETRY_LIMIT` | `20` | 端口冲突时最大重试次数 |

### 8.2 AI 模型

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `DEEPSEEK_API_KEY` | (空) | **[必需]** API Key |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | API 基址（兼容 OpenAI 接口） |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 模型 ID：`deepseek-chat`（通用）/ `deepseek-reasoner`（推理增强） |

### 8.3 Agent 运行参数

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `AGENT_MAX_TURNS` | `1000` | 单次对话最大迭代轮数，防止无限循环 |
| `AGENT_MAX_HISTORY_BYTES` | `1048576` (1MB) | 历史消息字节上限，超出触发裁剪 |
| `AGENT_LOW_WATERMARK_BYTES` | `131072` (128KB) | 历史裁剪低水位阈值 |
| `AGENT_SESSION_HISTORY_KEEP_LAST` | `10` | 跨会话保留最近 N 轮历史 |

### 8.4 用户指令记忆

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `AGENT_RECENT_INSTRUCTIONS_LIMIT` | `3` | 每轮系统提示注入的历史指令条数（设 0 关闭） |
| `AGENT_RECENT_INSTRUCTIONS_SKIP` | `1` | 注入时跳过最新 N 条（避免重复当前指令） |
| `AGENT_MAX_STORED_INSTRUCTIONS` | `100` | 工作区指令记忆文件最大保留条数 |

### 8.5 文件读取限制

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `AGENT_READ_FILE_MAX_LINES` | `3000` | 单次最大读取行数 |
| `AGENT_READ_FILE_MAX_FILE_SIZE_BYTES` | `204800` | 允许读取的文件大小上限（200KB） |
| `AGENT_READ_FILE_MAX_CONTENT_BYTES` | `204800` | 返回内容字节上限（200KB） |
| `AGENT_READ_FILE_LONG_LINE_THRESHOLD` | `1000` | 单行超长截断阈值（字符数） |

### 8.6 Git 与代码检查

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `AGENT_GIT_HISTORY_LIMIT` | `50` | Git 日志查询最大提交数 |
| `AGENT_SYNTAX_CHECK_MAX_FILES` | `20` | 语法检查单批次最大文件数 |
| `AGENT_SYNTAX_CHECK_TIMEOUT_MS` | `15000` | 单文件语法检查超时（毫秒） |

### 8.7 日志

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `LOG_LEVEL` | `INFO` | 日志级别：`SILENT` / `ERROR` / `WARN` / `INFO` / `DEBUG` |
| `DEBUG_LOG` | `false` | 开启 Agent 内部调试日志 |
| `ENABLE_VERBOSE_LOGS` | `false` | 开启 Fastify 详细请求日志 |

### 8.8 浏览器自动化（Playwright MCP）

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `BROWSER_MCP_BROWSER` | `chrome` | 浏览器通道（chrome / msedge / firefox / webkit） |
| `BROWSER_MCP_HEADLESS` | `false` | 无头模式（服务器环境建议设为 `true`） |
| `BROWSER_MCP_TIMEOUT_NAVIGATION` | `120000` | 页面导航超时（毫秒） |
| `BROWSER_MCP_TIMEOUT_ACTION` | `10000` | 页面动作超时（毫秒） |
| `BROWSER_MCP_IGNORE_HTTPS_ERRORS` | `false` | 忽略 HTTPS 证书错误 |
| `BROWSER_MCP_NO_SANDBOX` | `false` | 禁用浏览器沙箱（Docker/CI 环境需开启） |
| `BROWSER_MCP_VIEWPORT_SIZE` | (系统默认) | 自定义视口大小，如 `"1280x720"` |

---

## 9. 常见问题

### Q1：启动后服务立刻退出怎么办？

1. 先检查配置文件是否就绪：
   ```bash
   npm run check:conf
   ```
2. 确认三个子目录的 `node_modules` 均已安装（`server/`、`client/`、`terminal-server/`）
3. 查看终端报错信息，常见原因：
   - `.env` 文件不存在或格式错误
   - 端口被占用（`EADDRINUSE`）—— 结束残留的 `node.exe` 进程后重试
   - `node-pty` 原生模块编译失败 —— 重装 `terminal-server` 的依赖

### Q2：前端能打开但无法对话怎么办？

1. 确认 `server` 服务终端没有报错且显示「Server is running」
2. 检查是否已在「LLM 配置中心」填写正确的 API Key / Base URL / Model，或 `.env` 中 `DEEPSEEK_API_KEY` 是否有效
3. 打开浏览器开发者工具（F12）→ Network 标签，查看 `/api/chat/sse` 请求是否返回错误
4. 确认 API 基址（Base URL）在当前网络环境下可访问

### Q3：`npm run dev` 报 "Cannot find module tsx" 怎么办？

说明子项目的依赖未安装。请回到第 3 步，确保在 `server/`、`client/`、`terminal-server/` 三个目录都执行了 `npm install`。

### Q4：前端页面空白或报错？

1. 确认 `client` 服务终端显示 Vite 成功启动
2. 浏览器访问 `http://localhost:5174`（而非其他端口）
3. 清除浏览器缓存后重试

### Q5：如何在内网其他机器访问？

1. 确保本机防火墙已放行端口 `5174`、`3001`、`3003`
2. 在 `client/server_conf.json` 中将 `host` 改为 `"0.0.0.0"`（默认已是）
3. 其他机器通过 `http://<本机IP>:5174` 访问

### Q6：如何离线/生产环境部署？

详见 [DEPLOYMENT.md](./DEPLOYMENT.md)，包含完整的离线打包、部署和排错指南。

---

## 10. 项目结构

```
deepseek-ide-agent/
├── .env.example          ← 环境变量模板（复制为 .env 使用）
├── package.json          ← 根级脚本（dev / build / start / check:conf）
├── scripts/
│   └── start-services.mjs  ← 统一服务启动脚本
├── client/               ← 前端（React 19 + Vite + Monaco Editor）
│   ├── server_conf.json  ← 前端端口与后端地址配置
│   └── src/
│       ├── components/   ← UI 组件（AgentChat、FileTree、Terminal 等）
│       ├── services/     ← 前端服务层（IndexedDB、WebSocket）
│       └── providers/    ← React Context 状态管理
├── server/               ← Agent 主服务（Fastify 5 + OpenAI SDK）
│   ├── server_conf.json  ← 服务端口配置
│   └── src/
│       ├── config/       ← Agent 提示词配置（main-agent.json / evaluator-agent.json）
│       ├── services/     ← 核心服务（AgentEngine、McpService、GitService 等）
│       └── tools/        ← Agent 工具实现
└── terminal-server/      ← 终端 PTY 服务（Fastify + node-pty）
    ├── server_conf.json  ← 终端服务端口配置
    └── src/
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
