---
name: md-to-pdf
description: Markdown 转 PDF 的唯一推荐方案（md-to-pdf）、配色排版规范与防乱码检查。涉及 MD 转 PDF、导出 PDF、生成 PDF 报告时使用。
triggers:
  - pdf
  - md-to-pdf
  - markdown 转 pdf
  - 导出 pdf
  - 转pdf
  - 转 pdf
---

# Markdown → PDF 规范

## 1. 技术选型

必须使用 Node.js 技术栈（CSS 渲染更完整、中文更稳定）。

**唯一推荐：`md-to-pdf`（npm，基于 Chromium/Puppeteer）**

1. 安装：`pnpm add -g md-to-pdf`（或 `pnpm dlx md-to-pdf` / `npx md-to-pdf` 免安装）。
2. 基本用法：`md-to-pdf input.md` 输出 `input.pdf`，支持 GFM 表格、代码高亮、Mermaid、KaTeX。
3. 自定义样式：`md-to-pdf input.md --stylesheet style.css`（CSS 可控制字体、边距、配色、页码、页眉页脚、代码块主题、分页符）。
4. 配置文件：`md-to-pdf --config pdf-config.json`（多文件批量转换、每文件独立样式、页眉页脚模板）。
5. 代码高亮主题：`md-to-pdf input.md --highlight-style atom-one-light`（内置 30+ 主题）。
6. 优势：完整 CSS3 渲染引擎，flexbox/grid/`@page`/分页媒体/打印样式原生支持。

**备用**：`markdown-pdf`（npm），`pnpm dlx markdown-pdf input.md -o output.pdf --css-path style.css`，仅用于简单场景。

**禁止**：fpdf / reportlab / WeasyPrint / pdfkit / Pandoc-LaTeX 等 Python 系方案（CSS 支持差、中文排版不稳定、Windows 配置易失败）。

## 2. 配色规范（克制的冷感莫兰迪色系）

- 主色 ≤ 2 种；背景纯白 `#FFFFFF` 或极浅灰 `#FAFBFC`。
- 标题：深蓝灰 `#2C3E50` 或深灰 `#1A1A2E`。
- 正文：深灰 `#333333` 或 `#34495E`。
- 强调（链接/重点）：柔和蓝 `#3498DB` 或墨绿 `#27AE60`，仅作点缀。
- 代码块：背景 `#F5F6FA`，文字 `#2C3E50`。
- 表格：表头底色 `#ECF0F1` + 文字 `#2C3E50`，奇数行 `#F8F9FA`。
- 分隔线/边框：`#E0E3E8`，0.5px。
- 禁止：高饱和撞色、荧光色、霓虹色、纯黑背景、花哨渐变、多彩混搭。

## 3. 排版规范

- 正文 10–11pt，标题 14–18pt，行高 1.6–1.8。
- A4；页边距上下 20mm、左右 22mm。
- 段间距 > 行间距；留白 ≥ 15%。
- 统一左对齐；中文优先思源黑体/微软雅黑，代码用 Consolas / Fira Code。

## 4. 防乱码（P1 级事故红线）

1. `file_write` 创建 `.md` / `.html` / `.css` 必须传 `encoding: "utf-8"`。
2. HTML 模板首行必须有 `<meta charset="UTF-8">`。
3. `md-to-pdf` 默认 UTF-8，无需额外编码参数。
4. 转换完成后读回 PDF/文本确认中文无乱码（问号替代、方块、`锟斤拷`、未解码转义序列均为事故），发现即立即修复。

## 5. 验收

- 打开生成的 PDF 检查：分页位置合理、表格未截断、代码块未溢出页边距、页码/页眉正确、中文完整。
- 交付时说明生成命令与样式文件路径，便于用户复现。
