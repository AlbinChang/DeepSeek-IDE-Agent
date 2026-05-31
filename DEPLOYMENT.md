# DeepSeek IDE Agent 离线生产环境部署文档

> **环境：** Windows Server / Windows 10+ (纯内网离线环境)
> **前提：** 开发机和生产机的 Node.js 版本（如 v18.x 或 v20.x）与架构（如 x64）**必须一致**！
> **极简理念：** 开发机完成构建并打包全部依赖，生产机直接拷贝运行即可。

---

## 一、开发机打包配置

在**有网**的开发机上（Windows 环境，Node.js 版本应与生产机一致），执行以下操作完成文件提取：

### 1.1 准备目录
新建一个空文件夹用于归档部署包：`D:\deepseek-ide-offline-pkg`

### 1.1.1 先执行统一构建（与代码脚本一致）
在开发机项目根目录执行：

```bash
npm run build
```

该命令会按顺序构建：

- `server`（`tsc && tsc-alias && postbuild`）
- `terminal-server`（`tsc`）
- `client`（`tsc -b && vite build`）

### 1.2 拷贝清单
由于是离线环境，且目标机器无外网无法执行 `npm install`，因此**必须直接拷贝 `node_modules`**。
请将以下开发机中的文件夹及文件**原封不动**地拷贝到 `D:\deepseek-ide-offline-pkg` 下对应的目录结构中：

```
D:\deepseek-ide-offline-pkg\                  ← 离线部署包根目录
├── .env                                 ← 自己新建：环境变量配置文件
│
├── client\
│   ├── dist\                            ← 从开发机 client\dist 拷贝
│   ├── node_modules\                    ← 从开发机 client\node_modules 拷贝
│   └── static-server.js                 ← 从开发机 client\static-server.js 拷贝
│
├── server\
│   ├── dist\                            ← 从开发机 server\dist 拷贝
│   └── node_modules\                    ← 从开发机 server\node_modules 拷贝
│
└── terminal-server\
    ├── dist\                            ← 从开发机 terminal-server\dist 拷贝
    └── node_modules\                    ← 从开发机 terminal-server\node_modules 拷贝
```

> **核心注意：** `terminal-server\node_modules` 包含 C++ 预编译的底层二进制文件（`node-pty`），这就是为什么要求开发机和生产机 Node.js 大版本及操作系统架构必须保持一致的原因。两者环境一致，复制 `node_modules` 就会无缝运行。

### 1.3 准备 .env 文件
在 `D:\deepseek-ide-offline-pkg\.env` 中写入基础配置（如果是内网本地大模型，请替换内部地址）：

```ini
NODE_ENV=production
PORT=3001
DEEPSEEK_API_KEY=修改为你真正的_API_KEY
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
AGENT_RECENT_INSTRUCTIONS_LIMIT=3
AGENT_RECENT_INSTRUCTIONS_SKIP=1
AGENT_MAX_STORED_INSTRUCTIONS=100
```

### 1.3.1 用户指令记忆开关说明（新增）
为避免“最近历史注入条数”被误以为是写死常量，以下 3 个开关已支持通过根目录 `.env` 配置：

| 变量名 | 默认值 | 作用说明 | 建议取值 |
| :--- | :--- | :--- | :--- |
| AGENT_RECENT_INSTRUCTIONS_LIMIT | 3 | 每轮系统提示词中注入“历史用户指令记录”的条数上限。设置为 0 可关闭该注入。 | 0-10 |
| AGENT_RECENT_INSTRUCTIONS_SKIP | 1 | 注入前先跳过最新 N 条记录。默认跳过 1 条（通常是当前回合刚记录的指令）。 | 0-3 |
| AGENT_MAX_STORED_INSTRUCTIONS | 100 | 工作区指令记忆文件的最大保留条数。超过后按时间倒序截断，保留最新记录。 | 50-500 |

> 说明：以上参数用于平衡上下文连贯性与 Token 消耗。系统运行态仅统计模型 API 返回的 Token usage 真值，不做本地价格估算。若任务通常较短，可降低 `AGENT_RECENT_INSTRUCTIONS_LIMIT`；若需要更强的跨会话连续性，可适当提高 `AGENT_MAX_STORED_INSTRUCTIONS`。

### 1.3.1.1 Agent 运行与文件读取参数（新增）

| 变量名 | 默认值 | 作用说明 |
| :--- | :--- | :--- |
| AGENT_MAX_TURNS | 1000 | Agent 主循环最大迭代轮数，防止无限循环。 |
| AGENT_MAX_HISTORY_BYTES | 1048576 (1MB) | 历史消息 JSON 序列化字节上限，超出触发裁剪。 |
| AGENT_LOW_WATERMARK_BYTES | 131072 (128KB) | 历史裁剪低位阈值，裁剪到此水位以下停止。 |
| AGENT_SESSION_HISTORY_KEEP_LAST | (无默认) | 跨会话保留最近 N 轮历史，未设置则不保留。 |
| AGENT_READ_FILE_MAX_LINES | 3000 | `read_file` 单次最大读取行数。 |
| AGENT_READ_FILE_MAX_FILE_SIZE_BYTES | 204800 (200KB) | 允许读取的目标文件大小上限。 |
| AGENT_READ_FILE_MAX_CONTENT_BYTES | 204800 (200KB) | 返回内容的字节总量上限。 |
| AGENT_READ_FILE_LONG_LINE_THRESHOLD | 1000 | 单行字符数阈值，超长行自动截断。 |
| AGENT_GIT_HISTORY_LIMIT | 50 | Git 日志查询的最大提交记录条数。 |
| AGENT_SYNTAX_CHECK_MAX_FILES | 20 | 语法检查单批次最大文件数。 |
| AGENT_SYNTAX_CHECK_TIMEOUT_MS | 15000 | 单文件语法检查超时（毫秒）。 |
| LOG_LEVEL | （无） | 日志级别（`DEBUG`/`INFO`/`WARN`/`ERROR`），无默认即全量输出。 |
| DEBUG_LOG | false | 开启调试日志（设为 `true`）。 |
| ENABLE_VERBOSE_LOGS | false | 开启 Verbose 级别日志（设为 `true`）。 |
| HOST | 0.0.0.0 | 服务监听地址。 |
| PORT | 3001 | 主 API 服务端口。 |
| TERMINAL_SERVER_PORT | 3003 | 终端服务端口。 |
| PORT_RETRY_LIMIT | 20 | 端口冲突时的最大重试次数。 |
| SHELL | (系统默认) | 自定义 Shell 路径（Unix），Windows 自动使用 PowerShell。 |
| JAVA_HOME | （无） | JDK 安装路径，用于 Java 编译/运行任务。 |

> 建议：生产环境建议至少设置 `AGENT_MAX_TURNS=500`、`AGENT_MAX_HISTORY_BYTES=524288`（512KB）以平衡性能与 Token 消耗。

### 1.3.2 浏览器自动化引擎（Playwright MCP）配置（新增）
当前版本浏览器工具（`browser_*`）已切换为 **微软官方 Playwright MCP** 作为底层执行引擎。
在离线部署时无需额外手工安装，只要按本指南完整拷贝 `server\node_modules` 即可。

可选环境变量（不配置则使用默认值）：

| 变量名 | 默认值 | 作用说明 |
| :--- | :--- | :--- |
| BROWSER_MCP_BROWSER | chrome | Playwright MCP 使用的浏览器通道（如 `chrome` / `msedge` / `firefox` / `webkit`）。 |
| BROWSER_MCP_HEADLESS | false | 是否无头模式。`true` 表示不弹出可视浏览器窗口。 |
| BROWSER_MCP_TIMEOUT_NAVIGATION | 120000 | 页面导航超时（毫秒）。 |
| BROWSER_MCP_TIMEOUT_ACTION | 10000 | 页面动作超时（毫秒）。 |
| BROWSER_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS | true | 允许 `file://` 协议打开本地 HTML 文件进行预览。设为 `false` 可恢复安全限制。 |
| BROWSER_MCP_IGNORE_HTTPS_ERRORS | false | 忽略 HTTPS 证书错误（本地开发服务器常用自签名证书）。设为 `true` 开启。 |
| BROWSER_MCP_NO_SANDBOX | false | 禁用浏览器沙箱（Docker/CI 等容器环境需要）。设为 `true` 开启。 |
| BROWSER_MCP_VIEWPORT_SIZE | (系统默认) | 自定义浏览器视口大小，如 `"1280x720"`。 |
| BROWSER_MCP_ISOLATED | false | 每次会话使用独立 profile，不持久化浏览器状态。设为 `true` 开启。 |

> 建议：纯服务器环境（无桌面）可设置 `BROWSER_MCP_HEADLESS=true`；桌面运维排障场景建议保持默认可视模式。
> 本地 HTML 预览：默认已开启 `file://` 支持，可直接导航到 `file:///盘符:/路径/文件.html` 预览本地页面。

### 1.3.3 用户 MCP 工具离线部署（2026.05 新增）
系统支持用户在 workspace `.mcp/` 目录下配置自定义 MCP 服务器。**离线环境下**需注意：

*   MCP 服务器依赖的 npm 包（如 `@modelcontextprotocol/server-github`）在生产机 `npm install` 不可用的前提下，需预先在开发机全局安装，并将对应 `node_modules` 或二进制文件纳入部署包。
*   推荐做法：在开发机上，于 workspace 的 `.mcp/` 配置中使用本地路径而非 `npx`，例如：
    ```json
    {
      "name": "my-tool",
      "transport": "stdio",
      "command": "node",
      "args": [".mcp-servers/my-tool/index.js"]
    }
    ```
*   MCP 服务通过 stdio 协议启动子进程，需确保生产机的 Node.js 版本与开发机一致（与 `node-pty` 同理）。
*   环境变量占位符（`${ENV_VAR}` / `${env:VAR}`）在运行时由 `McpEnvResolver` 解析为生产机上的实际环境变量值。

### 1.4 压缩传输
将 `D:\deepseek-ide-offline-pkg` 整个目录使用 ZIP 压缩，然后通过 U盘/内网文件系统 传给生产机，并解压到生产机上的任意盘符，例如：解压为 `D:\deepseek-ide-agent`。

---

## 二、生产机离线启动

不需要安装任何额外工具，直接使用 Windows 自带的 PowerShell 手动启动。为方便查看不同模块的日志（调试模式），请并排打开 **3 个独立的 PowerShell 窗口**并分别执行：

**窗口 1：启动 API 中心 (端口 3001)**
```powershell
cd D:\deepseek-ide-agent\server
node --max-old-space-size=4096 dist\index.js
```

**窗口 2：启动 PTY 终端服务 (端口 3003)**
```powershell
cd D:\deepseek-ide-agent\terminal-server
node dist\index.js
```

**窗口 3：启动前端静态资源托管 (端口 5174)**
```powershell
cd D:\deepseek-ide-agent\client
node static-server.js
```

> 服务全部运行起来后，在浏览器直接访问 **`http://localhost:5174`** 即可使用。
> 若要停止服务，直接在对应 PowerShell 窗口里按下 `Ctrl + C`，或直接点击系统右上角红叉关闭窗口即可。

---

## 三、常见排错

| 故障现象 | 解决方案 |
| :--- | :--- |
| **浏览器打不开 `http://localhost:5174`** | 1. 确认窗口3控制台没有报错； 2. 如果是从内网里的别的机器访问，请确保本机的 Windows 防火墙已放行入站端口 `5174` `3001` 和 `3003`。 |
| **Terminal 报错初始化失败/找不到模块** | 典型的原生扩展环境不匹配！开发机和生产机的 Node.js 版本（命令行输入 `node -v` 检查）或 系统层架构（32位/64位）不兼容，导致直接拷贝的 `node-pty.node` 无法执行。必须使两台机器环境版本一致！ |
| **API 连接或 AI 返回 401 报错** | 检查根目录下的 `.env` 文件，确认里面的模型配置（如 `DEEPSEEK_BASE_URL`）能在你当前纯内网环境联通。 |
| **端口 3001 提示 `EADDRINUSE`** | 说明端口被占用或上次没关干净。打开任务管理器，强制结束残留的 `node.exe` 进程即可。 |
