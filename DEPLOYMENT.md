# DeepSeek IDE Agent — 部署与发布指南

> 应用已重构为纯 Electron 桌面架构。部署 = 打包 `.exe` 安装包 → 分发安装到 Windows 10/11。

详细打包总结与踩坑适配说明请参阅：[docs/PACKAGING_SUMMARY.md](docs/PACKAGING_SUMMARY.md)。

---

## 一、开发机构建

```powershell
cd d:\web-ide-agent

# 1. 安装全量依赖（基于 pnpm workspace）
pnpm install

# 2. 配置国内镜像加速（避免 Electron 二进制和 NSIS 下载超时）
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"

# 3. 运行全量测试
pnpm test

# 4. 生成 Windows 生产桌面安装包（自动触发全量构建与打包）
pnpm run electron:dist
```

产物位于 [electron/release/](electron/release/)：
- **安装包**：`DeepSeek IDE Agent Setup 1.0.0.exe`（约 92.8 MB，推荐）
- **绿色便携版**：`win-unpacked/`（文件夹内含 `DeepSeek IDE Agent.exe`）

---

## 二、目标生产环境安装 (Windows 10/11)

### 方式 1：安装包分发（推荐）
直接运行 `DeepSeek IDE Agent Setup 1.0.0.exe` 进行安装，支持自定义安装路径，无需在目标机器安装 Node.js、npm 或 Python。

### 方式 2：绿色免安装
将 `electron/release/win-unpacked/` 打包为 zip 发送到目标机器，解压后直接双击 `DeepSeek IDE Agent.exe` 即可运行。

---

## 三、多实例并行（同时跑两个工作区）

应用是 **单实例 + 单窗口 + 每用户一个工作区** 的架构（`app.requestSingleInstanceLock()` 见 [electron/src/main/index.ts](electron/src/main/index.ts)，工作区唯一真值是 [server/src/services/WorkspaceRegistry.ts](server/src/services/WorkspaceRegistry.ts) 里按 userId 维护的 single root）。由此：

- **直接双击两次 exe 拿不到两个窗口**：第二个进程抢不到单实例锁，会在启动初期以 `exit 0` 静默退出，只会把已有窗口置前（无任何提示）。
- 要同时跑两个工作区，必须给第二个实例一个**独立的用户数据目录**（`--user-data-dir`），并且两个实例打开**不同的工作区**。

### 3.1 启动方式

PowerShell（临时验证用）：

```powershell
& "D:\web-ide-agent\electron\release\win-unpacked\DeepSeek IDE Agent.exe" --user-data-dir="D:\DeepSeekAgent-Data2"
```

桌面快捷方式（推荐，双击即用）：桌面右键 → 新建 → 快捷方式，目标填

```
"D:\web-ide-agent\electron\release\win-unpacked\DeepSeek IDE Agent.exe" --user-data-dir="D:\DeepSeekAgent-Data2"
```

批处理（复制多份即可开第 3、第 4 个实例，改 `Data2` 为 `Data3`…）：

```bat
@echo off
start "" "D:\web-ide-agent\electron\release\win-unpacked\DeepSeek IDE Agent.exe" --user-data-dir="D:\DeepSeekAgent-Data2"
```

> exe 路径带空格，必须用引号包住；`--user-data-dir` 写在引号外，其后的路径建议不加尾部反斜杠。该参数是 Chromium 启动开关（非产品内置功能），作用是把用户数据目录整体换掉。

### 3.2 首次启动后

1. 选择**与第一个实例不同**的工作区目录。
2. 模型/API Key 是**按工作区**存放的（`<工作区>\.llm\users\<用户名>\settings.json`）：新工作区没有配置时会回退到 `resources/.env` 的 `DEEPSEEK_API_KEY`，通常可直接使用；若使用自定义 provider/模型，需在该窗口重新配置一次（只影响该工作区）。

### 3.3 确认实例数量

```powershell
Get-CimInstance Win32_Process -Filter "Name='DeepSeek IDE Agent.exe'" |
  Where-Object { $_.CommandLine -notmatch '--type=' } |
  Select-Object ProcessId, CommandLine | Format-List
```

每个实例输出一行主进程，带 `--user-data-dir` 的那行即第二实例；`--type=` 用于过滤渲染/GPU 子进程。

### 3.4 硬性约束

| 约束 | 违反后果 |
| --- | --- |
| 两个实例的 `--user-data-dir` 必须不同 | 第二个实例秒退（`exit 0`），且无任何提示 |
| 两个实例必须打开不同工作区 | 同一工作区会争抢 `.duckdb` 文件锁、`.workflow/.runs`、`.llm-request` 请求编号、`.ide-agent/users/<用户>/todo.json` |
| 数据目录不要放在工作区内部 | 会被 Agent 当作项目文件扫描，也会出现在 `git status` 里 |
| 开发实例（`pnpm dev`）与打包版不要同时运行 | 两者共用默认 userData，会互抢单实例锁 |

### 3.5 数据目录与清理

- 第二个实例的全部本地状态都在 `--user-data-dir` 指定目录内：Chromium 单实例锁文件（`lockfile`）、设置（`.electron-store`）、前端 IndexedDB（对话历史 / UI 状态）。
- 因此新实例的**历史对话为空**；但工作区内的记忆（`.memory`、`.llm`、`.ide-agent`）跟随工作区，不会丢失。
- 打包版的 `PROJECT_ROOT` 即 `app.getPath('userData')`，日志写入 `<数据目录>\logs`（首次产生日志时创建，未跑过任务时该目录可能不存在）。
- 关闭窗口后删除该目录即可完全清理，工作区文件不受影响。
- 重新打包升级后 exe 路径不变，快捷方式继续有效。

---

## 四、配置 API Key

在应用内右上角点击 **设置 (Settings)** 配置 API Key，或在目标机器 `%APPDATA%\deepseek-ide-agent-electron\.env`（或安装目录 `resources/.env`；两者同时存在时以 `resources/.env` 为准）配置：

```bash
DEEPSEEK_API_KEY=sk-your-api-key-here
```

---

## 五、自定义打包配置

编辑 [electron/electron-builder.yml](electron/electron-builder.yml) 控制安装包行为（图标、快捷方式、安装目录、asar 解包配置等）。

