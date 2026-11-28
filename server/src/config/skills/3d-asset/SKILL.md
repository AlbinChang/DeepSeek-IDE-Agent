---
name: 3d-asset
description: 3D 场景与资产全流程：scene3d 场景 JSON、glb/gltf 模型、Three.js 预览与无头渲染、.3d 资产治理、Blender 导出规范。
triggers:
  - 3d
  - three.js
  - threejs
  - blender
  - glb
  - gltf
  - 三维
  - 3d场景
  - 三维场景
  - 3d模型
  - 三维模型
  - 建模
  - 3d渲染
  - 产品展示
  - 数字孪生
  - 3d资产
---

# 3D 场景与资产规范

## 1. 先选路线，再动手

| 需求 | 方案 | 理由 |
| --- | --- | --- |
| 网页 3D 展示、产品旋转、交互 H5、营销页 | `scene3d/v1` 场景 + 本 IDE 预览 / Three.js | 声明式 JSON 可 diff、秒级迭代、零构建 |
| 需要真实建模、雕刻、绑定、动画、物理仿真、影视级渲染 | Blender 产出 `.glb` → `.3d/models/` | Three.js 不适合做资产生产管线 |
| 扁平图表、流程图、图标 | SVG（`read_skill("svg-diagram")`） | 2D 需求不要上 3D |
| 只差一张静态主图 | `render_3d_preview` 出 PNG | 不必引入完整 3D 前端 |

3D 只在"空间感/材质/视角"能带来信息增量时使用；纯数据展示优先 2D。

## 2. `.3d` 目录是唯一资产家

```text
.3d/
  manifest.json          # 资产索引（工具自动维护，唯一真值）
  scenes/                # <slug>.scene3d.json
  models/                # <slug>.glb / gltf / obj / stl
  textures/              # 贴图
  renders/               # <slug>.png 预览（同名覆盖，保留最新）
  .temp/<run-id>/        # 临时产物，已 gitignore，结束删除
```

铁律：

1. 3D 产物只进 `.3d/`，不在仓库根建 `models/`、`assets3d/`。
2. 小写 kebab：`product-console.scene3d.json`、`robot-arm.glb`；中文只放 `name`，slug 用英文/pinyin。
3. 同一资产固定同一 slug：场景、模型、预览三者同名。
4. 版本用 `-v02` 后缀；禁止 `final/ final2/ new/ copy/` 平行文件。
5. 渲染中间稿、试验脚本放 `.3d/.temp/<run>/`；交付前删除。非 3D 的通用临时文件仍按 `temp-hygiene` 放工作区 `.temp/`。
6. 不手工编辑 `manifest.json` 的 `path/hash`；用 `register_3d_asset` / `list_3d_assets` 维护。

## 3. scene3d/v1 速查

单位米、Y 轴向上、**rotation 用角度制**（不是弧度）。

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
    { "type": "box", "size": [1.2, 0.6, 0.8], "position": [0, 0.3, 0],
      "material": { "color": "#4f9cff", "metalness": 0.3, "roughness": 0.35 } },
    { "type": "model", "src": "../models/robot-arm.glb", "position": [1.6, 0, 0], "scale": 1 }
  ]
}
```

- 对象类型：`box`(size) `sphere`(radius,widthSegments,heightSegments) `cylinder`(radiusTop,radiusBottom,height,radialSegments,openEnded) `cone`(radius,height,radialSegments) `torus`(radius,tube,radialSegments,tubularSegments,arc) `torusKnot`(radius,tube,tubularSegments,radialSegments,p,q) `plane`(width,height,widthSegments,heightSegments) `ring`(innerRadius,outerRadius,thetaSegments) `capsule`(radius,length,capSegments,radialSegments) `model`(src) `group`(children)。
- 通用字段：`name position rotation scale material castShadow receiveShadow`。
- 材质：`color metalness roughness emissive emissiveIntensity opacity transparent wireframe flatShading side(front|back|double) map`。
- 灯光：`ambient directional point spot`，`color intensity position target castShadow distance angle penumbra`；全场景最多 16 盏。
- 相机：不给 `position` 时自动取景；`autoFrame: true` 强制自动取景。
- 引用模型/贴图用**相对场景文件**的路径：`../models/x.glb`、`../textures/floor.png`。

## 4. 工具调用顺序

**从零做场景**

1. `create_3d_scene`（`render` 默认 true，会立即出预览图并返回三角面/包围盒/覆盖率）
2. `check_3d_asset`：静态编译检查引用/光照/相机/数据合法性（不渲染，秒级）
3. 看返回值：`coverage` 低于 0.5% 说明主体过小/在相机后/材质全黑；高于 70% 说明视角过近
4. 改 `camera` / `position` / `scale` / `lights` → `create_3d_scene` 覆盖同一文件（不要建 v2）
5. 交付前 `check_3d_asset path=.3d` 全目录体检 + `list_3d_assets` 确认 manifest 一致

**导入 Blender 模型**

1. 把 `.glb` 放进工作区任意位置（或让用户提供）
2. `inspect_3d_asset`：看 `tris / bounds / materials / anims`，确认不是空壳、单位合理（典型 0.1–10 米）
3. `check_3d_asset`：缓冲/索引越界、节点环、动画/蒙皮、POSITION 包围盒一致性
4. `register_3d_asset`：复制进 `.3d/models/` 并登记（同名不同内容自动 `-v02`）
5. `render_3d_preview` 单独出图检查，再 `create_3d_scene` 放进场景

**只出图**：`render_3d_preview path=.3d/models/x.glb width=1280 height=720`

**写文件前预检**：`check_3d_asset content="<场景 JSON>" format=scene3d`（scene3d/gltf/obj 支持）

## 5. 视觉质量标准

1. 主体占比（coverage）目标 5%–60%；居中、不贴边、不被裁切。
2. 主色 ≤3；金属/镜面材质必须有环境光（默认 `environment: "studio"`，设 `none` 会发黑）。
3. 深色背景配亮色主体，对比度 ≥4.5:1；纯黑背景加网格或轻微渐变。
4. 相机用 3/4 视角（如 `[3, 2, 5]` 看向 `[0, 0.8, 0]`），不要正对/俯视导致形体难辨。
5. 地台用 `render.grid: true`；**不要放 14×14 的大平面当地面**——自动取景会按最大包围盒缩放，主体被压成一小块。
6. 有阴影才有空间感：主光 `castShadow: true` + 承影面 `receiveShadow: true`（默认开启）。

## 6. 性能预算（Web）

| 指标 | 建议上限 |
| --- | --- |
| 三角面 | 首屏 ≤10 万，移动端 ≤5 万 |
| draw call | ≤100 |
| 贴图 | ≤2048×2048，2 的幂，PNG/JPG/WebP |
| 灯光 | 实时阴影主光 1 盏，其余不投影 |
| 文件 | 单个 `.glb` ≤20MB；整包首屏 ≤5MB |

超预算时：减面、合并网格、烘焙贴图、LOD；不要靠"加分段"提升圆滑度。

## 7. Blender → GLB 导出清单

1. 单位：米；`Apply Transform`（Ctrl+A → All Transforms），避免缩放继承。
2. 导出：glTF 2.0 Binary (`.glb`)，勾选 `+Y Up`（Three.js 的 Y 轴向上；漏勾会"躺平"）。
3. 压缩：**不要**开 Draco / Meshopt / BasisU —— IDE 预览与大部分 Web 端需要额外解码器。
4. 贴图：打包进 GLB（`Images: Automatic`），颜色贴图 sRGB，法线/粗糙度 Non-Color。
5. 动画：命名可读（`Idle`/`Walk`），预览只自动播放第一条。
6. 导出后必须 `inspect_3d_asset` 验证三角面、包围盒、材质、动画数量。

## 8. 色彩与渲染

1. Three.js 端按 sRGB 输出 + ACES Filmic 色调映射；不要在 JSON 里"手调"颜色补偿。
2. 金属度 0.8+ 时粗糙度给 0.1–0.3，否则像塑料；非金属 `metalness: 0`。
3. 自发光用于屏幕/灯带，`emissiveIntensity` 1–3，不要整块模型发光。
4. 半透明物体排序易穿帮：能用不透明就别用 `transparent`。

## 9. 迭代与交付

1. 每轮只改一个维度（相机 / 光 / 材质 / 布局），改完立即重渲染对比。
2. 覆盖率骤降/画面全黑 → 先查：模型引用是否缺失、相机是否在物体内部、灯光是否全黑、材质 `color` 是否为 `#000`。
3. 交付时给出：场景文件路径、预览图路径、模型来源与许可、三角面/尺寸数据。
4. 清理：删除 `.3d/.temp/` 中间稿；`renders/` 只保留最终版；`list_3d_assets` 不应有 `missing`。
5. 需要网页直接嵌入时，产物是 `.glb` + 场景 JSON；Three.js 侧只负责加载与交互，不再"用代码复原"材质。

## 10. 高频错误

| 错误 | 后果 | 正确做法 |
| --- | --- | --- |
| rotation 写弧度（`1.57`） | 转 1.57° 而不是 90° | 写 `90`（角度制） |
| 放大平面当地面 | 自动取景把主体缩成点 | 用 `render.grid` |
| `environment: "none"` + 金属材质 | 全黑 | 保持 `studio` |
| 引用 `models/x.glb`（相对工作区） | 找不到文件 | 相对场景文件：`../models/x.glb` |
| 中文 slug | 回退成 `asset-1a2b3c` | name 用英文/pinyin |
| 导出开 Draco | 预览报解码器缺失 | 关闭压缩扩展 |
| 建 `v2/final` 场景 | manifest 出现重复资产 | 覆盖同一文件 |
| 交付前不跑 `check_3d_asset` | 索引越界/空引用/重复 id 带病交付 | 交付前 `check_3d_asset path=.3d` 全量体检 |

## 11. 编译检查覆盖范围

`check_3d_asset` 不渲染，纯静态检查，秒级返回：

- **scene3d**：规范字段、引用存在性/越界、贴图头信息、零灯光、相机重合/在物体内部、模型三角面与尺寸、总三角面预算。
- **glTF / GLB**：容器长度/chunk 对齐、buffer 声明与实际、bufferView/accessor 越界、索引越界与退化三角形、POSITION min/max 与实际顶点一致、法线单位化、节点环与多父节点、材质/纹理/采样器引用、动画关键帧数量与时间递增、蒙皮 IBM 数量、压缩扩展告警。
- **OBJ**：面索引越界/0 索引、NaN 顶点、重复索引退化面、法线单位化、`mtllib` 存在性。
- **STL**：二进制长度、NaN/零面积面、法线绕序一致性。
- **贴图**：PNG/JPEG/WebP/KTX2 头识别、扩展名与格式一致、>2048、非 2 的幂、>5MB。
- **manifest**：重复 id/path、文件缺失、大小/哈希漂移、kind 与目录不一致、预览缺失、`.3d/.temp` 未清理。

输出带 `code + 位置 + 修复建议`，例如 `✗ GLTF_INDEX_OUT_OF_RANGE accessors[1]: 3 个索引超出顶点数 3`。`deep:false` 可跳过数据级校验（哈希/索引/包围盒）。
