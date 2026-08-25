# DeepSeek IDE Agent — Windows 10 生产环境打包与迁移总结

> **文档版本**：1.0.0  
> **打包时间**：2026-08-24  
> **目标系统**：Windows 10 / Windows 11 (x64)  
> **架构类型**：单进程纯 Electron 桌面应用（Main Process 集成 Agent 引擎、node-pty 终端与文件操作，Renderer 进程运行 React 19 + Monaco Editor UI）

---

## 目录

- [一、打包产物概述](#一打包产物概述)
- [二、打包核心适配与踩坑解决](#二打包核心适配与踩坑解决)
  - [1. 前端静态资源相对路径修复](#1-前端静态资源相对路径修复)
  - [2. 构建产物自动归集流水线](#2-构建产物自动归集流水线)
  - [3. 生产模式多环境路径自适应](#3-生产模式多环境路径自适应)
  - [4. node-pty 原生模块免编译适配](#4-node-pty-原生模块免编译适配)
  - [5. 国内下载镜像环境配置](#5-国内下载镜像环境配置)
  - [6. 根目录构建流水线整合](#6-根目录构建流水线整合)
- [三、构建与打包命令规范](#三构建与打包命令规范)
- [四、迁移至生产环境 Windows 10 操作指南](#四迁移至生产环境-windows-10-操作指南)
  - [方案 A：使用安装包安装（推荐）](#方案-a使用安装包安装推荐)
  - [方案 B：使用绿色免安装便携版](#方案-b使用绿色免安装便携版)
- [五、生产环境配置与运维说明](#五生产环境配置与运维说明)
  - [1. API Key 配置](#1-api-key-配置)
  - [2. 数据与存储目录结构](#2-数据与存储目录结构)
  - [3. 日志与排错](#3-日志与排错)
- [六、测试与质量验证](#六测试与质量验证)

---

## 一、打包产物概述

所有打包产物均生成在 `electron/release/` 目录下：

| 产物名称 | 类型 | 大小 | 说明 |
|---------|------|------|------|
| **`DeepSeek IDE Agent Setup 1.0.0.exe`** | NSIS 安装程序 | 约 **92.8 MB** | **生产分发首选**。支持自定义安装路径、自动创建桌面快捷方式与开始菜单项，卸载干净。 |
| **`win-unpacked/`** | 绿色免安装目录 | 约 **310 MB** (解压后) | 免安装便携版，文件夹内双击 `DeepSeek IDE Agent.exe` 即可直接运行。 |
| **`DeepSeek IDE Agent Setup 1.0.0.exe.blockmap`** | 差异更新块表 | 约 98 KB | 用于后续自动更新与差量下载。 |

---

## 二、打包核心适配与踩坑解决

在本次打包过程中，对项目进行了以下 6 项关键工程适配，确保打包产物在脱离源码开发环境后仍能稳定无缝运行：

### 1. 前端静态资源相对路径修复
- **问题现象**：Vite 默认构建产物使用绝对根路径（如 `/assets/...`、`/monacoeditorwork/...`）。在 Electron 生产环境中通过 `win.loadFile()`（`file://` 本地文件协议）加载页面时，所有静态资源和 Monaco Editor Worker 会请求到 `file:///assets/...` 导致 404 白屏。
- **解决方案**：在 `client/vite.config.ts` 中配置 `base: './'`，确保所有 HTML、JS、CSS、字体、SVG 以及 Monaco Worker 路径全部生成为相对路径。

### 2. 构建产物自动归集流水线
- **问题现象**：前端产物输出在 `client/dist`，而 `electron-builder` 打包时以 `electron/` 目录为打包上下文，若手动复制极易遗漏或版本不一致。
- **解决方案**：
  - 新增自动化拷贝脚本 `electron/scripts/copy-renderer.mjs`。
  - 修改 `electron/package.json` 中的 `build:renderer` 脚本为：`pnpm --filter client run build && node scripts/copy-renderer.mjs`。
  - 自动将 Vite 产物同步到 `electron/dist/renderer` 并在打包时封装入 `app.asar`。

### 3. 生产模式多环境路径自适应
- **问题现象**：
  1. 开发模式下应用直接在工程根目录读写 `.electron-store` 和 `logs/`，但在生产环境下，如果用户将软件安装至 `C:\Program Files\` 等系统目录，直接写安装目录会触发 `EPERM` 权限被拒绝异常。
  2. 运行时配置（如 `main-agent.json`、`evaluator-agent.json`）需要从打包外部资源 `process.resourcesPath/config` 中稳定读取。
- **解决方案**：改造 `electron/src/main/index.ts` 中的路径解析逻辑：
  - **`isPackaged` 智能判断**：通过 `app.isPackaged` 分离开发与生产路径。
  - **配置根路径 `CONFIG_ROOT`**：打包后优先指向 `process.resourcesPath/config`（由 `electron-builder.yml` 的 `extraResources` 自动拷入）。
  - **用户数据与存储根路径 `PROJECT_ROOT`**：打包后切换为 Windows 规范的 `app.getPath('userData')`（即 `%APPDATA%\DeepSeek IDE Agent`），彻底规避安装目录写权限问题。
  - **前端入口 `CLIENT_DIST`**：打包后自适应定位到 `app.asar/dist/renderer`。
  - **环境变量 `.env`**：支持从 `process.resourcesPath/.env` 与 `userData/.env` 双重探测加载。

### 4. node-pty 原生模块免编译适配
- **问题现象**：`node-pty` 为 C++ 原生 Addon，`electron-builder` 在 Windows 下默认尝试调用 `node-gyp` 和 MSVC 工具链重新构建，在缺少 Visual Studio Build Tools 的环境下会报错中断：`Could not find any Visual Studio installation to use`。
- **解决方案**：
  - 在 `electron/electron-builder.yml` 中显式设置 `npmRebuild: false`。
  - 配合 `asarUnpack: [ "node_modules/node-pty/**", "node_modules/@playwright/**" ]`，直接复用 `node-pty@1.1.0` 自带的官方 Windows x64 预编译二进制（`prebuilds/win32-x64/conpty.node`、`pty.node` 等），实现零 C++ 编译依赖打包。

### 5. 国内下载镜像环境配置
- **问题现象**：构建时从 GitHub 下载 `electron-v33.4.11-win32-x64.zip`、`winCodeSign` 以及 `nsis-3.0.4.1` 等工具包时极易发生网络超时或断流。
- **解决方案**：引入国内镜像环境变量支持（NpmMirror），加速打包流程：
  ```powershell
  $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
  $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
  ```

### 6. 根目录构建流水线整合
- **解决方案**：在根目录 `package.json` 中统一串联：
  - `pnpm run electron:build`：一键编译 preload (`dist/preload.cjs`) + main process (`dist/main/index.js`) + client (`dist/renderer`)。
  - `pnpm run electron:dist`：先自动触发全量 build，再执行 electron-builder 打包生成 NSIS 安装包。

---

## 三、构建与打包命令规范

后续如需再次构建与发布，请在 PowerShell 中执行以下标准流程：

```powershell
# 1. 切换至项目根目录
cd d:\web-ide-agent

# 2. 配置国内镜像加速（首次打包或缓存失效时必要）
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"

# 3. 运行全套单元测试（验证无代码破坏）
pnpm test

# 4. 生成 Windows 生产安装包（全量编译 + 打包）
pnpm run electron:dist
```

> **仅打包解压目录（测试用）**：
> ```powershell
> pnpm run electron:pack
> ```

---

## 四、迁移至生产环境 Windows 10 操作指南

### 方案 A：使用安装包安装（推荐）

1. **传输文件**：将 `electron/release/DeepSeek IDE Agent Setup 1.0.0.exe` 拷贝到生产环境 Windows 10 电脑（可通过 U 盘、局域网共享或内网分发）。
2. **执行安装**：
   - 双击 `DeepSeek IDE Agent Setup 1.0.0.exe`。
   - 可自由选择安装位置（如 `D:\Program Files\DeepSeek IDE Agent` 或默认路径）。
   - 勾选创建桌面快捷方式。
3. **完成启动**：点击“完成”或从桌面快捷方式启动应用。

### 方案 B：使用绿色免安装便携版

1. **压缩归档**：将 `electron/release/win-unpacked/` 目录打成 `.zip` 压缩包。
2. **传输解压**：拷贝至目标机器并解压至任意目录（例如 `D:\DeepSeek-IDE-Agent\`）。
3. **运行**：双击运行目录内的 `DeepSeek IDE Agent.exe`。

---

## 五、生产环境配置与运维说明

### 1. API Key 配置

进入应用后，有以下两种方式配置模型 API Key：

- **方式 1（推荐）**：在界面右上角点击 **设置 (Settings)** 图标，在模型配置中填入 `DeepSeek API Key` 并保存（设置将自动持久化至本地数据库）。
- **方式 2**：在安装目录的 `resources/` 目录下（或 `%APPDATA%\DeepSeek IDE Agent\` 目录下）创建/修改 `.env` 文件：
  ```env
  DEEPSEEK_API_KEY=sk-your-deepseek-api-key-here
  ```

### 2. 数据与存储目录结构

生产环境下各数据与配置路径分布如下：

```
C:\Users\<用户名>\AppData\Roaming\DeepSeek IDE Agent\   (%APPDATA%)
├── .electron-store/            # 用户设置及本地存储
├── .llm/users/<userId>/        # 用户对话记忆、工作区配置
└── logs/                       # 运行日志目录
    └── app-YYYY-MM-DD.log      # 按天切分的运行时结构化日志
```

### 3. 日志与排错

- **查看日志**：如果生产环境遇到问题，可打开 `%APPDATA%\DeepSeek IDE Agent\logs\` 查看当日运行日志。
- **控制台调试**：若需查看前端控制台输出，可以在快捷方式后添加 `--dev` 参数启动以调出 Chrome DevTools。

---

## 六、测试与质量验证

本次打包已完成严谨的质量与功能验证：

1. **单元测试矩阵**：
   - 全量测试通过：**13 个测试套件，165 项测试全部通过（100% Passed）**。
   - 覆盖进程安全守护（`ProcessSafetyGuard`）、网页智能提取（`WebPageSaver`）、多工作区数据隔离（`WorkspaceIsolationContracts`）、数学计算引擎（`CalculatorTool`）等全部核心模块。
2. **打包完整性校验**：
   - 前端相对路径资源校验完成，Monaco Editor 代码提示、代码着色 worker 正常解析。
   - `node-pty` 原生 Windows x64 二进制在 asarUnpack 目录中正确签名与释放。
   - 生产模式路径（`userData`、`resources/config`、`resources/.env`）全部对齐。
