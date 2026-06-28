# DeepSeek IDE Agent — 部署文档

> 应用已重构为纯 Electron 桌面架构。部署 = 打包 `.exe` 安装包 → 分发安装。

## 一、开发机构建

```powershell
cd d:\web-ide-agent

# 确保依赖已安装
npm install --prefix client
cd electron && npm install && cd ..

# 生成桌面安装包
npm run electron:dist
```

产物位于 `electron/release/`：
```
DeepSeek IDE Agent Setup x.x.x.exe    # Windows 安装包
```

## 二、用户安装

直接运行 `.exe` 安装包，无需安装 Node.js、npm 或任何依赖。Electron 运行时已内嵌在安装包中。

## 三、配置 API Key

在应用内设置中配置，或手动在安装目录创建 `.env`：

```bash
DEEPSEEK_API_KEY=sk-your-api-key-here
```

## 四、自定义打包

编辑 `electron/electron-builder.yml` 控制安装包行为（快捷方式、安装目录等）。
