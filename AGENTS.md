# AGENTS.md — MapVideo 项目上下文（AI 助手必读）

> 目的：让任何 AI 编码工具（Codex / ZCode / Claude 等）在本目录打开后，快速理解项目现状、约定与坑，避免重复踩坑或破坏已有功能。
> 本文件是**当前事实的唯一权威**；`docs/ARCHITECTURE.md` 是早期设计稿，与现状有出入，仅作历史参考。

## 1. 项目是什么

**MapVideo**：基于 Remotion + MapLibre GL 的「地图视频」生成框架。用户在浏览器编辑器里用军事态势符号（箭头/包围圈/集结点）、路线动画、区域高亮、相机关键帧、弹出元素等制作分章节的地图讲解视频，并可在浏览器内直接导出 MP4。

## 2. 技术栈与关键版本

| 项 | 值 | 备注 |
|---|---|---|
| React / TS / Vite | 18 / 5.6 / 6 | 入口 `src/main.tsx`，StrictMode 开启 |
| remotion | 4.0.515 | 预览用编辑器自身，导出用 `@remotion/web-renderer`（纯浏览器 MP4） |
| **maplibre-gl** | **5.24** | 已从 v4 升级；globe 投影、WebGL2；行为与 v4 有差异（见 §6） |
| turf / dexie / zustand / milsymbol | 7 / 4 / 5 / 3 | 空间计算 / IndexedDB / 状态 / APP-6 符号 |

## 3. 常用命令

```bash
npm run dev     # http://localhost:5173/map-video/ （vite base=/map-video/）
npm run build   # tsc -b && vite build
```

- 无测试框架。回归验证靠：`npx tsc -b` + `npm run build` + `tools/*.mjs` 自动化（需本机 Chrome 开 `--remote-debugging-port=9222`，临时 profile：`C:\Users\23659\AppData\Local\Temp\opencode\mv-studio-profile`，配合 `playwright-core`）。
- `tools/` 下脚本为自动化回归（test-* / verify-*），读文件头注释即可用；`pw-page.mjs` 是标签页复用助手（避免每次开新标签）。

## 4. 目录结构（src/）

```
components/
  EditableMap.tsx      # 编辑态地图画布：绘制交互/拖拽/选中/相机插值/悬停光标（最复杂的文件）
  Toolbar.tsx          # 导出两个组件：TopBar(顶栏 Logo/项目芯片/章节菜单/搜索/撤销重做/保存/导出) + FloatingTools(地图上方浮动工具条：选择+六工具)
  MapStyleChip.tsx     # 地图左下角底图芯片（Mapimator SATELLITE 样式）：弹出 底图/高程/3D投影 面板
  ChapterMenu.tsx      # 顶栏章节弹出菜单：切换/重命名/复制/删除/新增/章节设置
  ShortcutsDialog.tsx  # 快捷键速查弹窗（时间线「快捷键」按钮触发）；改键盘绑定需同步此文件内容
  MapSearchBox.tsx     # 地名/坐标搜索，内嵌顶栏（项目芯片右侧）；地图实例经 lib/shared-map.ts 共享，EditableMap load/unload 时 set
  TimelineEditor.tsx   # 播放条(播放预览胶囊+步进+元素面板开关) + 镜头流块(宽=移动时长) + 元素轨道；刻度间隔随时长自适应
  KeyframePanel.tsx    # 右侧「视角属性」：到达时间/移动时长(默认2s)/中心/缩放(1位小数)/俯仰/方向/缓动
  PropertiesPanel.tsx  # Mapimator 式 Settings 面板（Pin/Route/Shape/Image 四类，见 §5）
  ElementsPanel.tsx    # 左侧浮动元素面板：搜索/眼睛显隐/副标题/GeoJSON-GPX 导入/底部统计（由右下「元素」按钮开合）
  App.tsx              # 布局：TopBar + 全幅地图舞台(浮动工具条/元素浮层/右侧浮层) + 时间线 + 底部章节卡片
  ui/primitives.tsx    # 共享 UI 原子：Section/Field/StyleGrid/Toggle/ColorPicker/OptionBlocks/PanelHeader（勿在各面板重复定义）
  RegionPickerDialog.tsx / FrameTimeField.tsx / Storyboard.tsx(已废弃文件仍存在) 等
compositions/          # Remotion 导出端：MapVideo(章节调度+转场) / MapScene / OverlayRenderer / transition.ts
lib/
  map-renderer.ts      # ★ 核心：所有地图元素的渲染（点7样式/路线/形状/标签位图/动画）
  keyframe-interpolation.ts  # 相机/通用关键帧插值（含 moveDuration 停留-飞行语义）
  military-plots.ts / military-geometry.ts  # 移植自 plot_ol 的军标算法（燕尾/钳形/进攻/集结地）
  regions.ts           # 行政区边界加载与点选/按名查找（默认 johan world.geo.json，可换源）
  geojson.ts / gpx.ts / export-video.ts / time.ts / easing-labels.ts / utils.ts
stores/
  projectStore.ts      # 项目数据全部操作 + 撤销/重做 + IndexedDB(dexie) 持久化
  editorStore.ts       # 播放头 currentFrame / isPlaying / 选中元素与章节 / currentCamera / cameraSeek / elementsOpen
  interactionStore.ts  # 绘制模式 + pendingPlace(一键中心放置) + focusReq
types/index.ts         # 全部数据模型（改数据结构先看这里）
```

## 5. 领域模型速记

- **Chapter**：startFrame/endFrame（绝对帧）、title/subtitle、elements、camera(视角关键帧)、overlays、transition、特效。章节页签=横向 tabs；时间线只显示当前章节。
- **MapElement** 判别联合：point(7种PIN样式: shape=dot/pin/bubble/emoji/text + flag + custom_icon + iconUrl)、line(straight/bezier/arc + label + routeEffect + flowSpeed)、moving_point(path+pathProgress)、polygon(shapeKind=poly/rect/circle + circleMeta/rectMeta)、arrow(7种箭头)、double_arrow、encirclement、gathering、flag、connector、military_symbol、custom_icon。
- **CameraKeyframe**：frame=**到达时间**（绝对帧）；`moveDuration`(帧)=起飞提前量，**默认 2*fps**；语义=停留→飞行→落位（`interpolateCamera(kfs, frame, fps)`）。
- **LabelConfig**：text/color/position(上左下右中)/bgColor(默认透明)/bgPadding/bgRadius/fontWeight。渲染=canvas 气泡位图（makeBubbleImageData，仅 BUBBLE 样式带尾巴）。
- **PointElement 特有**：shape、emoji、scale(0.3–3 等比缩放点+label)、orientation(faceCam/flat)、rotation(贴地旋转)、iconUrl、label。
- **坐标显示一律 5 位小数**（toFixed(5) + step=0.00001）；视角缩放显示 1 位小数。

## 6. 血泪教训（改代码前必读，全部踩过）

1. **禁止用 `isStyleLoaded()` 做相机/事件 effect 的门禁**。v5 中字形/瓦片未就绪时它频繁返回 false，会吞掉离散跳帧（⏩/点时间线）的相机更新与首次事件注册。
   - 相机 effect 只判 `mapRef.current`，`jumpTo` 用 try/catch。
   - 地图事件在 `map.on('load')` 里**一次性注册**，回调经 `handlersRef.current` 取最新（latest-callback ref 模式）；不要在独立 effect 里注册地图事件。
2. **元素类型切换（ID 不变）会残留旧图层**。`renderElements` 维护 id→type 签名表，签名变化先 `removeElementLayers` 整体重建。新增渲染分支时记得纳入该机制。
3. **MapLibre 重名 layer 会自动加数字后缀**：从 layerId 反解元素 id 必须用「已知元素 id 前缀匹配」（`EditableMap.elementIdFromLayerId`），简单截断会匹配失败。
4. **thin line 难选中**：线元素有透明宽热区层 `line-hit-{id}`（line-width≥12, opacity 0）。
5. **数据默认值**：moveDuration 默认 2s；label.bgColor 默认透明；仅 BUBBLE 样式带尾巴；TEXT 无位置项（强制 center）；缩放/尺寸走 `scale`，不要再加固定像素字段。
6. **操作不自动保存**：仅 💾/新建/导入写 IndexedDB；导出视频不落盘（用户明确要求，防中途状态覆盖）。
7. **双端一致**：改渲染/相机逻辑必须同时检查编辑器 `EditableMap` 与导出端 `compositions/MapScene`。导出端相机已传 fps。
 8. **PowerShell 内联 node -e 处理中文/复杂引号会碎**：批量改文件一律写一次性 `.cjs` 脚本用 fs+utf8（用完即删）。
9. **pincer(钳形) 与 double_arrow**：预览与最终必须同用 `buildDoubleArrow`；不要用 buildArrowGeometry 的 pincer 分支做预览。
11. **镜头插值 effect 的依赖必须是 `chapter.camera`（数组引用）而非 `chapter`**：任何元素属性修改都会重建 chapter 对象，若依赖 chapter 会在每次改样式/改属性时触发 `jumpTo`，把用户手动平移的地图拽回关键帧位置。
10. **地图事件 vs 播放循环**：`map.on('move')` 会 60fps 触发 `setCurrentCamera`→全订阅组件重渲染，属预期；不要在 move 回调里做重活。

## 7. UI 约定（Mapimator Studio 深色对齐，2026-08 全面改版）

- **主题**：stone 深色系（bg #0c0a09 / card #1c1917 / accent #292524 / border 白10%），令牌在 `src/index.css`（HSL 变量，无浅色主题）；字体 Geist（Google Fonts，index.html 引入，fallback system-ui）；品牌蓝 `--brand`（选中/播放头/Toggle）。参考截图在 `docs/studio-shots/ref/`。
- **布局**：TopBar(h-14：Logo+项目芯片+章节菜单芯片+地名搜索+撤销重做/保存/导出) → 全幅地图舞台（浮动工具条 top-center、左下角 MapStyleChip 底图/高程/3D、元素浮层左侧、设置浮层右侧 overlay）→ 时间线(播放条+轨道)。章节管理在顶栏 ChapterMenu 弹出框（切换/铅笔重命名/复制/删除/新增/章节设置），不再占用底部空间。
- 顶栏工具是**扁平一键直达**（点击即创建/进入模式），样式差异全部放右侧 Settings 面板切换；**没有下拉工具组**。工具条/时间线上的「元素」按钮开合左侧元素浮层（editorStore.elementsOpen，默认收起）。
- Settings 面板结构：`{X} Settings` 头(✕关闭) → **LABEL**(首字段,同步元素 name) → 类型/样式按钮组(StyleGrid) → SIZE(等比%) → ORIENTATION → CUSTOM IMAGE → 图标颜色 → 时间 → Show Label + LABEL STYLE → **点动画**(开关默认关) → Delete Layer。Section 无边框、大写小标题+白5%分隔线。
- 右侧浮层显示条件：element 模式需有选中元素；keyframe/chapter 模式始终显示（editorStore.panelMode 三态）。
- 共享 UI 原子统一从 `components/ui/primitives.tsx` 引入，勿再在各面板复制。开关用 Toggle（整行可点，滑块用 left 定位勿改 translate）；颜色选择一律用 ColorPicker（预设色板+自定义弹窗），不要再写裸 `input[type=color]`；枚举选项一律用 OptionBlocks（横向选项块），不要再写原生 `<select>`。图标上传走 IconUploadButton→UploadIconDialog（normalizeImageSquare 统一 64×64 + 命名入 customSymbols）；PIN STYLE 网格由 PinStyleChooser 共用（PinSettings 与 ImageSettings 同构，Marker(flag) 与点类型面板结构已统一）。
- 时间显示用秒（`lib/time.ts` / FrameTimeField），内部仍存帧。
- **路线顶点编辑**：EditableMap 对 line/moving_point/arrow/double_arrow 显示路径点标记（vertex-dot 图层，选中的更大更蓝），mousedown 优先命中顶点（12px）→ 拖拽只更新该点坐标（routePathOf/hitRouteVertex 辅助函数）；路径点坐标也可在属性面板「路径点」中输入/删除。燕尾箭头归入形状类别（categoryOf 特判 arrowType）。
- **属性面板双语**：editorStore.lang（中/EN，顶栏最右切换），标签用 `useT()` 钩子：`t('中文', 'English')`；新增属性标签必须双语。hints 暂仅中文。
- **保存脏标记**：projectStore 用模块级 savedProjectJSON 快照（createProject/loadProject/saveProject/importProjectConfig 时 markProjectSaved），TopBar 经 isProjectDirty(project) 比对，无修改时保存按钮禁用。新增会写 project 的动作无需额外处理。
- ⚠️ **本机 Vite 文件监听不可靠**（改动不触发热更新、旧进程会吐陈旧模块）：vite.config.ts 已开 `server.watch.usePolling`；重启 dev server 时务必确认 5173 旧进程已杀干净（npm 包装进程被杀后 vite 子进程会残留，用 `netstat -ano | grep 5173` 查）。

## 8. 协作约定

- 与用户**中文交流**，回复精简；改动后提醒刷新（用户浏览器常需 Ctrl+F5 才拿最新包）。
- 用户的真实测试数据在自己浏览器的 IndexedDB（如 test001 项目）；自动化调试 Chrome 的 profile 是隔离的——跨环境验证用「⚙️ 导出配置 json → 放项目根目录 → 脚本导入」的方式（参考 `tools/test-import.mjs`）。
- 导出视频、播放、镜头插值等改动完成后，优先用 `tools/` 脚本做一次带截图的自动化回归。

## 9. 已知待办 / 弱项

- ORIENTATION/点动画/移动点高亮圈等仅在编辑端验证过，导出端 MapScene 未逐项回归。
- `docs/ARCHITECTURE.md` 过时；新文档以本文件为准。
- 3D(globe) 下 `pixelsToDegrees` 为墨卡托近似，高纬度箭头宽度略有偏差。
- Region 数据源为世界国家级（英文属性名，内置 ~100 国中英映射）；省级需换 `setRegionSources` 数据源。
