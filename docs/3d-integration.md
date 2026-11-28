# 3D 场景与资产集成

> 状态：v1（2026-11）· 作用域：Electron 桌面端 + Agent 工具链
> 代码入口：[scene-runtime.ts](../client/src/three/scene-runtime.ts) · [Scene3dTools.ts](../server/src/tools/Scene3dTools.ts) · [Model3DPreview.tsx](../client/src/components/Model3DPreview.tsx)

## 1. 目标与边界

给 IDE 增加一条"可自检"的 3D 生产线：AI 写声明式场景 → 无头渲染出图 → 读像素/几何统计 → 迭代，直到交付。

| 能力 | v1 提供 | 不提供 |
| --- | --- | --- |
| 场景建模 | `scene3d/v1` JSON：基础几何体、分组、模型引用、PBR 材质、灯光、相机 | 布尔建模、雕刻、绑定、IK |
| 资产导入 | `.glb/.gltf/.obj/.stl` 解析、三角面/包围盒/动画统计、规范化归档 | Draco/Meshopt/BasisU 解码 |
| 预览 | IDE 内可交互 3D 视口 + Playwright 无头 PNG | 视频/序列帧导出 |
| 资产治理 | `.3d/` 目录约定、`manifest.json`、哈希去重、缺失检测 | 资产版本控制系统（依赖 Git） |
| AI 自检 | 三角面、draw call、包围盒、像素覆盖率、平均亮度 | 语义理解画面内容（需多模态模型） |

**分工铁律**：资产的物理属性（建模/雕刻/UV/烘焙/绑定）归 Blender 等 DCC；显示、交互与场景编排归 Three.js。不要用代码"复原"设计稿材质。

## 2. 设计原则

1. **文本优先**：AI 的主产物是 `.scene3d.json` + `.glb`，不是截图。JSON 可 git diff、可局部改、可校验。
2. **一份运行时，两个消费者**：客户端交互预览与服务端无头截图共用 `client/src/three/scene-runtime.ts`，避免"预览和截图不一样"。
3. **零构建迭代**：场景规范不引入运行时依赖；`create_3d_scene` 校验后直接落盘，客户端打开即看。
4. **最小依赖**：3D 只引入 `three`（客户端 + 构建产物）；GLB/OBJ/STL 解析与包围盒计算为纯 Node 实现（~300 行），不引入 glTF 转换器。
5. **可观测**：每次渲染返回几何与像素统计，让纯文本模型也能判断"画面是不是空的"。

## 3. 架构

```text
┌──────────────────────────── Client (Electron Renderer) ────────────────────────────┐
│ FileEditor ── viewMode: 3d ──> Model3DPreview (lazy)                                │
│                                   │  scene3d JSON / readFileBinary(IPC)             │
│                                   ▼                                                 │
│                        client/src/three/scene-runtime.ts  ◄── 唯一渲染实现          │
│                        three.js + OrbitControls + GLTF/OBJ/STL Loader               │
└───────────────────────────────────▲─────────────────────────────────────────────────┘
                                    │ 同一份 TS 源码，两种打包
        ┌───────────────────────────┴────────────────────────────┐
        │ Vite (ESM, 交互)                                        │ esbuild (IIFE, 无头)
        │                                                         ▼
        │                                    electron/dist/three/scene-runtime.js
        │                                    extraResources → resources/three/
        │                                                         │
┌───────┴──────────────── Server (Electron Main / Worker) ─────────┴──────────────────┐
│ Scene3dTools (6 个原子工具)                                                         │
│   ├─ spec.ts            校验/归一化/引用收集/三角面估算                              │
│   ├─ assetInspector.ts  GLB 容器解析、glTF 节点 TRS 世界包围盒、OBJ/STL 统计         │
│   ├─ assetChecker.ts    静态编译检查（缓冲/索引/节点环/动画/蒙皮/贴图/manifest）     │
│   ├─ manifest.ts        .3d 骨架、manifest 读写、哈希、缺失检测                      │
│   └─ previewRenderer.ts Playwright Chromium + 临时 HTTP 服务（随机端口 + token）     │
└─────────────────────────────────────────────────────────────────────────────────────┘
                                    │
                              .3d/ 资产目录（工作区）
```

### 3.1 场景规范（scene3d/v1）

```json
{
  "schema": "scene3d/v1",
  "name": "product-console",
  "background": "#0d1117",
  "camera": { "position": [3, 2, 5], "target": [0, 0.8, 0], "fov": 40, "autoFrame": true },
  "render": { "shadows": true, "grid": true, "axes": false, "environment": "studio", "exposure": 1 },
  "lights": [
    { "type": "directional", "position": [5, 8, 4], "intensity": 2.4, "castShadow": true },
    { "type": "ambient", "intensity": 0.25 }
  ],
  "objects": [
    { "type": "box", "size": [1.2, 0.6, 0.8], "position": [0, 0.3, 0], "material": { "color": "#4f9cff" } },
    { "type": "model", "src": "../models/robot-arm.glb", "position": [1.6, 0, 0] }
  ]
}
```

- 单位米、Y 轴向上、`rotation` 为**角度制**。
- 对象类型：`box` `sphere` `cylinder` `cone` `torus` `torusKnot` `plane` `ring` `capsule` `model` `group`。
- 材质按 PBR：`color metalness roughness emissive emissiveIntensity opacity transparent wireframe flatShading side map`。
- 未给 `camera.position` 时按包围盒自动取景；`autoFrame: true` 强制。
- 相对引用以**场景文件所在目录**为基准（`../models/x.glb`）。
- 上限：400 个对象、16 盏灯、8 层嵌套、256KB JSON；超出在写入前报错。

校验器给出 `objects[2].radius` 这类精确路径与修复建议，模型可一次改对。

### 3.2 渲染运行时

`createPreview(canvas, spec, options)` 返回句柄：`resize / renderOnce / resetView / setWireframe / setGrid / setAutoRotate / snapshot / stats / pixelStats / dispose`。

- 渲染设置：sRGB 输出、ACES Filmic、PCFSoft 阴影、`preserveDrawingBuffer`。
- 默认三点光 + `RoomEnvironment` 环境反射（`render.environment: "none"` 关闭）。
- 无头模式 `renderPreview()`：加载完成后只渲染一帧，读回帧缓冲计算覆盖率与亮度。
- 通过 `options.resolveUrl` 解耦资源加载：客户端走 IPC → blob URL；无头端走临时 HTTP。

### 3.3 客户端查看器

- `FileEditor` 新增 `viewMode: '3d'`：`.glb/.gltf/.obj/.stl` 与 `.scene3d.json` 默认进 3D 视口；文本型（gltf/obj/scene3d）可切回编辑器。
- `Model3DPreview` 懒加载（three 只在打开 3D 文件时进入包）。
- `.gltf` 外链 `.bin`/贴图在客户端先内联为 blob URL，避免 blob 基址解析失败。
- 工具栏：网格、线框、自动旋转、重置视角、导出 PNG；左下角显示三角面/网格数/draw call/包围盒。
- 监听 `ui:file:changed`：Agent 覆写二进制模型后自动重载。

### 3.4 无头预渲染

1. 生成随机 token，启动 `127.0.0.1:0` 临时 HTTP 服务（所有路由都必须带 token）：
   - `/s/<token>/` 内联 HTML（场景 JSON + baseDir）
   - `/s/<token>/runtime.js` 预构建 IIFE
   - `/s/<token>/<path>` 工作区文件（禁止目录穿越）
2. Playwright Chromium（SwiftShader WebGL）打开页面，等待 `window.__scene3d.ready`。
3. `page.screenshot()` → PNG；读取页面回报的 `stats` / `pixelStats`。
4. 关闭浏览器与服务；渲染任务串行化，避免并发拉起多个 Chromium。
5. 工作区文件只在该次渲染的生命周期内可读（随机端口 + token + 进程内服务）；页面通过 Playwright 路由拦截，只允许访问本次服务与 `data:`/`blob:` 资源，防止模型内嵌 URL 发起外部请求。

### 3.5 Agent 工具

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `create_3d_scene` | 校验并写入 `.3d/scenes/<slug>.scene3d.json`，建档，默认渲染 | `name` `spec` `render` `width` `height` `tags` |
| `check_3d_asset` | 静态编译检查（不渲染）：规范/引用/缓冲/索引/节点环/动画/蒙皮/贴图/manifest；支持目录体检与写入前 content 预检 | `path` `content` `format` `deep` `maxIssues` |
| `render_3d_preview` | 场景/模型 → PNG，返回几何与像素统计 | `path` `width` `height` `output` `background` |
| `inspect_3d_asset` | glb/gltf 节点、三角面、材质、动画、世界包围盒；obj/stl 统计；scene3d 校验 | `path` |
| `list_3d_assets` | manifest 查询，标记 missing | `kind` `tag` `query` `limit` |
| `register_3d_asset` | 复制进 `.3d` 规范目录、哈希、去重（`-vNN`）、登记 | `path` `name` `copy` `tags` |

只读的 `inspect_3d_asset` / `check_3d_asset` / `list_3d_assets` 已加入 workflow 只读工具默认集。

### 3.5.1 编译检查覆盖范围

`check_3d_asset` 是渲染前的静态闸门，秒级返回 `code + 位置 + 修复建议`：

- **scene3d**：字段规范、引用存在性/越界、贴图头信息、零灯光、相机重合/在包围盒内、模型三角面与尺度、总三角面预算。
- **glTF / GLB**：容器长度与 chunk 对齐、buffer 声明/实际长度、bufferView/accessor 越界、索引越界、退化三角形、POSITION min/max 与实际顶点一致、法线单位化、节点环/多父节点、材质/纹理/采样器引用、动画 output 数量与时间递增、蒙皮 IBM 数量、压缩扩展告警。
- **OBJ**：面索引越界/0 索引、NaN 顶点、退化面、法线单位化、`mtllib` 存在性。
- **STL**：二进制长度、NaN/零面积面、法线绕序。
- **贴图**：PNG/JPEG/WebP/KTX2 头识别、扩展名一致、>2048、非 2 的幂、>5MB。
- **manifest**：重复 id/path、文件缺失、大小/哈希漂移、kind 与目录不一致、预览缺失、`.3d/.temp` 未清理。

`deep:false` 跳过数据级校验（索引范围/包围盒/法线/时间轴/哈希），仅做结构与引用检查。

### 3.6 技能与提示词

- `server/src/config/skills/3d-asset/SKILL.md`：路线选择、场景速查、工具顺序、视觉质量、性能预算、Blender 导出清单、高频错误。
- `main-agent.json`：在 `skill_usage_contract` 中补充"3D 产物只进 `.3d/`、先读 `3d-asset`"的约束（不新增常驻条目，保持提示词预算）；能力清单同步。

## 4. 资产治理（.3d）

```text
.3d/
  manifest.json          # { schema, updatedAt, assets[] }
  README.md              # 由 ensureScene3dScaffold 首次创建
  .gitignore             # .temp/
  scenes/ models/ textures/ renders/
  .temp/<run-id>/        # 临时产物
```

manifest 记录：`id name kind path description tags preview bytes hash meta createdAt updatedAt`。

- `id` 由文件名派生（小写 kebab）；中文名回退 `asset-<hash6>` 并告警。
- `preview` 保留最近一次渲染；`renders/` 同名覆盖。
- 删除文件后不自动清 manifest，`list_3d_assets` 会标 `missing`，`check_3d_asset path=.3d/manifest.json` 会列出缺失/哈希漂移/重复 id。
- `register_3d_asset` 同名不同内容自动 `-v02…-v99`，不覆盖既有资产。

## 5. 构建与发布

| 环节 | 命令 / 配置 |
| --- | --- |
| 构建无头运行时 | `pnpm --filter deepseek-ide-agent-electron run build:scene-runtime` → `electron/dist/three/scene-runtime.js` |
| 开发模式 | `electron/scripts/dev.mjs` 第 2.8 步自动构建 |
| 生产打包 | `electron-builder.yml`：`dist/three` → `resources/three` |
| 运行时定位 | Electron 主进程注入 `SCENE3D_RUNTIME`；服务端回退 `electron/dist/three/scene-runtime.js` |
| Playwright | 主进程构建把 `playwright` / `playwright-core` 标为 external；依赖声明在 `electron/package.json` |
| Worker 解析 | 主进程注入 `SCENE3D_REQUIRE_BASE`（应用根 `package.json`），utilityProcess 内的 `createRequire` 据此定位 `node_modules/playwright` |
| 客户端 | `three` + `@types/three`（`0.187.0`），Vite 按需打包 |

> 未安装 Chromium 的环境，3D 工具仍可用（校验/解析/清单），只有 `render_3d_preview` 会报错并给出 `playwright install chromium` 提示。

## 6. 验证

```powershell
# 单元：规范校验 / 资产解析 / 编译检查 / manifest / 工具 / 写后门禁（无头渲染默认跳过）
pnpm --filter deepseek-ide-agent-server exec vitest run src/scene3d src/tools/Scene3dTools.test.ts src/services/SyntaxCheckService.scene3d.test.ts

# 类型检查
pnpm --filter deepseek-ide-agent-server typecheck
pnpm --filter client exec tsc -b

# 真实无头渲染（需要已构建运行时 + Chromium）
pnpm --filter deepseek-ide-agent-electron run build:scene-runtime
$env:RUN_3D_RENDER_TEST='1'
pnpm --filter deepseek-ide-agent-server exec vitest run src/scene3d/previewRenderer.test.ts src/tools/Scene3dTools.test.ts -t render_3d_preview
```

集成用例断言：PNG 魔数、文件体积、`tris`、`coverage > 1%`、GLB 经 GLTFLoader 渲染、贴图映射、全黑场景 `coverage < 0.5%`、manifest `preview` 回填。
编译检查用例覆盖：accessor/bufferView 越界、索引越界、POSITION 包围盒漂移、节点环/多父节点、动画 output 数量、蒙皮 IBM 数量、OBJ 面索引、STL 长度/退化面、贴图头、manifest 缺失/哈希漂移/重复 id、目录批量体检。

## 7. 性能与限制

- 场景对象 ≤400、灯 ≤16；超过 50 万预估三角面给出警告。
- 模型导入建议：单文件 ≤20MB、三角面 ≤30 万（超出告警）；Web 首屏预算 10 万三角面。
- GLB 容器解析只读 JSON chunk，不加载 BIN；大文件仍会整体读入内存（≤50MB 由 IPC/工具侧约束）。
- 无头渲染串行执行；单次冷启动约 1–3s，场景渲染约 1–4s（SwiftShader）。
- 不支持 Draco / Meshopt / BasisU；`inspect_3d_asset` 会明确提示。

## 8. 技术债与取舍

| 取舍 | 原因 |
| --- | --- |
| 手写 GLB/glTF 解析（无 `@gltf-transform`） | 只需元数据/包围盒；免去重依赖与版本漂移，逻辑可单测 |
| 手写静态检查器（无 glTF-Validator） | 需要与 IDE 的 `scene3d` 规范、`.3d` manifest 和渲染器能力对齐，统一输出格式；校验逻辑可单测 |
| 不引入 React Three Fiber | 单个查看器 + 一份框架无关运行时，避免 React 绑定渗透到无头端 |
| 无头渲染用 Playwright 而非服务端 GL | 复用现有 Chromium 依赖，离线可用，截图即真机效果 |
| 场景 JSON 自定义 DSL | 比直接生成 three.js 代码更可控、可校验、可回归；渲染器负责解释 |
| `.3d/.temp` 输出 HTML 内存化 | 不在工作区落临时文件，失败也不留垃圾 |

## 9. 路线图（v2）

- `.scene3d.json` → `.glb` 导出（场景烘焙）。
- 模型动画时间轴与多 clip 选择。
- 贴图/材质预览缓存与 Draco 解码器（按需）。
- 多机位批渲染与序列帧 → MP4。
- 场景差异对比（manifest 记录 hash + 缩略图）。

## 10. 相关文件

| 文件 | 职责 |
| --- | --- |
| `client/src/three/scene-runtime.ts` | 场景解释器 + three.js 渲染 |
| `client/src/components/Model3DPreview.tsx` | IDE 交互查看器 |
| `client/src/components/FileEditor.tsx` | `3d` 视图模式与切换 |
| `server/src/scene3d/spec.ts` | 规范校验 |
| `server/src/scene3d/assetInspector.ts` | GLB/glTF/OBJ/STL 解析 |
| `server/src/scene3d/assetChecker.ts` | 静态编译检查（glTF 数据级/OBJ/STL/贴图/manifest） |
| `server/src/scene3d/manifest.ts` | `.3d` 骨架与资产索引 |
| `server/src/scene3d/previewRenderer.ts` | Playwright 无头渲染 |
| `server/src/tools/Scene3dTools.ts` | 5 个 Agent 工具 |
| `server/src/config/skills/3d-asset/SKILL.md` | 技能规范 |
| `electron/scripts/build-scene-runtime.mjs` | 无头运行时构建 |
