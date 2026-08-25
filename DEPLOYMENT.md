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

## 三、配置 API Key

在应用内右上角点击 **设置 (Settings)** 配置 API Key，或在目标机器 `%APPDATA%\DeepSeek IDE Agent\.env`（或安装目录 `resources/.env`）配置：

```bash
DEEPSEEK_API_KEY=sk-your-api-key-here
```

---

## 四、自定义打包配置

编辑 [electron/electron-builder.yml](electron/electron-builder.yml) 控制安装包行为（图标、快捷方式、安装目录、asar 解包配置等）。

