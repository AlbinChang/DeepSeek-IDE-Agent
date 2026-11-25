---
name: temp-hygiene
description: .temp 临时目录治理：run 目录、命名、manifest、去重与清理。
triggers:
  - 临时文件
  - 临时目录
  - .temp
  - 目录太乱
  - 清理临时
  - 重复文件
---

# .temp 治理

## 结构

每个任务一个 `.temp/<YYYYMMDD-HHMMSS>-<ascii-slug>/`：
`src/` 脚本、`data/` 小子集、`out/` 结果、`logs/`、`cache/`，根放 `manifest.json`。
`.temp` 根目录禁止散文件（应用固定目录除外）。

## 命名

`<step>-<purpose>[-vNN].<ext>`，如 `01-extract.csv`、`02-gate-v02.json`。
禁止 `ev_1.py`、`vd_a.json`、`final/final2/check/recheck/probe/tmp`；同一逻辑文件优先覆盖。

## 大数据

长期数据集放 `.temp` 之外的 `data/`；禁止把 >50MB 数据整份复制到多个用例。
只读基线用硬链接/junction；可写数据用子集或独立输出。硬链接仅限不再修改的文件。

## manifest

```json
{"runId":"...","goal":"...","inputs":[],"outputs":[],"status":"in-progress|done|abandoned","ttlDays":7}
```

## 生命周期

结束删除本轮 `src/ logs/ cache/`、失败分支、`__pycache__`、重复副本；保留 `out/` + manifest。
单 run >2GB 或 >200 文件先报告。最终交付移出 `.temp`。不得删除其他 run/用户文件。

## 存量审计

按大小找疑似重复（同尺寸仍需 SHA256 确认）：

```powershell
Get-ChildItem .temp -Recurse -File -Force | Where-Object Length -gt 50MB |
  Group-Object Length | Where-Object Count -gt 1 |
  Sort-Object { $_.Group[0].Length*($_.Count-1) } -Descending |
  Select-Object Count,@{n='MB';e={[math]::Round($_.Group[0].Length/1MB,1)}},@{n='ReclaimMB';e={[math]::Round(($_.Group[0].Length*($_.Count-1))/1MB,1)}}
```

去重默认 dry-run：先按哈希分组列计划，确认后用 `New-Item -ItemType HardLink` 替换重复项；可写数据不要硬链接。

## 自检

根目录只有 run 目录；文件在 run 内；命名可读；无 >50MB 重复；manifest 已更新；中间产物已删。