---
name: web-research
description: 联网搜索、资料调研、网页内容采集与代码仓库克隆的规范：检索优先级、镜像加速、网页转 Markdown 与图片本地化。涉及联网搜索、查资料、抓取网页、下载文章、克隆仓库时使用。
triggers:
  - 联网
  - 搜索
  - 查资料
  - 调研
  - 检索
  - 抓取
  - 爬取
  - 网页
  - 下载文章
  - 下载网页
  - 克隆
  - clone
  - 仓库
---

# 联网检索与网页采集规范

## 1. 检索优先级

进行网络搜索、资料查找、知识探索或技术调研时，优先使用国际资源：官方文档、GitHub、Stack Overflow、MDN、Wikipedia、arXiv、DevDocs、Hacker News、技术博客。国外资源更新更及时、更权威、覆盖更全面。

不要因为用户位于中国大陆就默认优先中文平台（CSDN、博客园、知乎、简书、百度百科）。

只有境外资源确实不可访问时才用国内资源补充。判断不可达的明确信号：同一资源连续 3 次超时或连接失败，且排除代理/VPN 干扰后仍打不开。

说明：此条针对知识检索；软件包下载与仓库克隆走下一节的镜像策略。

## 2. Git 仓库克隆的镜像加速

当前运行环境在中国大陆，克隆仓库优先用 gitee 镜像，避免直连 GitHub 超时。

查找顺序（`github.com/{owner}/{repo}`）：

1. `https://gitee.com/mirrors/{repo}.git`（gitee 按仓库名收录热门仓库，不含 org 前缀，如 `microsoft/playwright` → `gitee.com/mirrors/playwright.git`）。
2. `https://gitee.com/{owner}/{repo}.git`（gitee 原生托管）。
3. 以上都不存在才回退 `https://github.com/{owner}/{repo}.git`。

完整克隆前先用 `git ls-remote <候选URL> HEAD` 探测：exit 0 = 可用，exit 128 = 不存在，立即换下一个源，禁止盲目整仓克隆。

从镜像克隆后，若需要跟进上游：`git remote add upstream https://github.com/{owner}/{repo}.git`，之后 `git fetch upstream` 同步。

注意事项：

- gitee 对仓库大小/单文件有限制，超大仓库或 >100MB 文件可能失败，直接回退官方源或加速代理，不要反复重试。
- 镜像可能滞后；用户需要最新 commit/release/tag 时必须从 upstream 拉取确认。
- 用户明确指定仓库 URL 时以用户为准，禁止擅自替换来源。
- 同一源连续失败 2 次立即切换，禁止反复重试。

## 3. 网页内容 → Markdown

1. 用 `playwright__browser_navigate` 打开页面，`playwright__browser_evaluate` 提取正文（优先 `document.querySelector("article")?.innerText`，否则 `document.body.innerText`），用 `file_write` 写入 `.md`（`encoding: "utf-8"`）。
2. 长文分段提取、分段写入，禁止一次性抓整页导致截断。
3. **严禁用截图代替内容保存**。截图只允许用于 UI 视觉验收、调试布局、用户明确要求看效果。

## 4. 图片本地化铁律

1. 保存到 `docs/` 下的网页内容，图片必须下载到工作区 `docs/images/` 统一存放。
2. 先用 `playwright__browser_evaluate` 收集图片清单：
   `() => Array.from(document.images).map(i => ({ src: i.src, alt: i.alt }))`
3. 用 `run_powershell_command` 执行 `Invoke-WebRequest -Uri "<图片URL>" -OutFile "docs/images/<文件名>" -Headers @{ Referer = "<页面URL>"; "User-Agent" = "Mozilla/5.0 ... Chrome/126.0" }`（防盗链站点必须带 Referer 与浏览器 UA）。
4. 文件名以文章名做前缀防冲突，保持原格式（jpg/png/webp/gif）。
5. md 中必须以本地相对路径引用图片（如 `../images/文章名-img-01.png`），严禁直接嵌入 http/https 图片 URL。
6. 更新已有 md 时，若发现网络图片 URL，必须下载并替换为本地路径。
7. 参考材料默认存 `docs/references/<主题>/`；最终交付物禁止写入 `.temp/`。

## 5. 采集后自检

- md 中是否残留 `http(s)://` 图片链接？
- 正文是否完整（标题、表格、代码块、图注未丢失）？
- 图片文件是否真实落盘、大小非零、可正常打开？
- 是否误用了截图交付？如是，立即改为文本提取。
