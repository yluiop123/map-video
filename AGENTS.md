# AGENTS.md — MapVideo 项目上下文（AI 助手必读）

> 目的：让任何 AI 编码工具（Codex / ZCode / Claude 等）在本目录打开后，快速理解项目现状、约定与坑，避免重复踩坑或破坏已有功能。
> 本文件是**当前事实的唯一权威**（原 docs/ARCHITECTURE.md 早期设计稿已删除）。

## 1. 项目是什么

**MapVideo**：基于 Remotion + MapLibre GL 的「地图视频」生成框架。用户在浏览器编辑器里用军事态势符号（箭头/包围圈/集结点）、路线动画、区域高亮、相机关键帧、弹出元素等制作地图讲解视频（项目=单条连续时间线），并可在浏览器内直接导出 MP4。

## 2. 技术栈与关键版本

| 项 | 值 | 备注 |
|---|---|---|
| React / TS / Vite | 18 / 5.6 / 6 | 入口 `src/main.tsx`，StrictMode 开启 |
| remotion | 4.0.515 | 预览用编辑器自身，导出用 `@remotion/web-renderer`（纯浏览器 MP4） |
| **maplibre-gl** | **5.24** | 已从 v4 升级；globe 投影、WebGL2；行为与 v4 有差异（见 §6） |
| turf / dexie / zustand / milsymbol | 7 / 4 / 5 / 3 | 空间计算 / IndexedDB / 状态 / APP-6 符号 |

## 3. 常用命令

```bash
npm run dev            # http://localhost:5173/map-video/ （vite base=/map-video/）
npm run build          # tsc -b && vite build（网页 Lite 产物）
npm run build:desktop  # 桌面产物（相对路径 base=./）
npm run electron:dev   # 桌面开发：vite 热更 + Electron 窗口（日志自动写 logs/dev-vite.log · logs/dev-electron.log）
npm run dist:win       # 打 Windows 包 → release/
```

- **`release/` 产物说明**：`MapVideo Setup <v>.exe`（NSIS 安装版）与 `MapVideo <v>.exe`（Portable 免安装版）功能相同，二选一即可；`latest.yml` / `*.blockmap` 供 electron-updater 差分更新；`win-unpacked/` 是**中间产物**（内含真正的 `MapVideo.exe`），可删；只需留一份时删其余。

- 无测试框架。回归验证靠：`npx tsc -b` + `npm run build` + `tools/*.mjs` 自动化（需本机 Chrome 开 `--remote-debugging-port=9222`，临时 profile：`C:\Users\23659\AppData\Local\Temp\opencode\mv-studio-profile`，配合 `playwright-core`）。
- `tools/` 只留**跑得动、还会再跑**的东西，读文件头注释即可用，四类：
  ① 文档生成链：`db-field-notes.mjs`（698 字段中文说明词表，`gen-db-field-dict` 的**必需输入**，漏一条直接报错）→ `gen-db-field-dict.mjs`（注入 `docs/db-tables.md`，`--check` 只校验）→ `comment-ddl.mjs`（把说明写成 DDL 行尾注释）；另一支：`gen-template-json-doc.mjs`（把 `src/lib/template-seed.ts` 里的内置模板展开成「参数总表 + 逐列 JSON」，注入 `docs/provider-engine.md` 第九节，`--check` 只校验 —— 那节原先手抄还拿 `/* … */` 省略参数表，结果「到底声明了哪些参数」在文档里查不到）；同一份 seed 还导出成 **`docs/provider-template-init.sql`**（`gen-template-init-sql.mjs`，`--check` 盯漂移）—— 全新库的初始化脚本，也是「界面里改乱了想退回内置那一版」的一条命令；**seed 仍是运行时唯一来源**，那份 SQL 是它的导出（回归 [9] 执行两遍后逐字读回 = seed）；
  ② 离线回归（不联网、秒级）：`verify-project-roundtrip` / `verify-public-layers` / `verify-provider-templates` / `verify-request-engine` / `audit-fk-indexes` / `verify-path-interpolation`（逐帧路径插值与 `turf.along` 逐字同值）；
  ③ 浏览器自动化（Chrome 9222，或桌面端 `MV_CDP=9223`）：`smoke-desktop` / `smoke-backend` / `test-fx` / `test-overlays` / `test-timeline` / `test-import` / `verify-render-gate`（逐帧门禁：该跳的还在显示、该动的还在动，自建临时项目 `__gate-check` 并在跑完删除），公共助手 `pw-page.mjs`（标签页复用，避免每次开新标签）；
  ④ 会花配额 / 改数据的：`try-real-calls.mjs`（真发上游）、`bench-preview.mjs`（预览性能基线，采样结果存 `tools/.bench/`，不入库）、`bench-attribution.mjs`（把自耗时归因到我们的渲染函数，见 §6.28）、`stress-project.mjs`（建 / 开 / 删 `__perf-stress`：几百元素的测量场景，用户自己的项目太轻量不出差别）。
  **一次性验证脚本用完就删**，别留在目录里当考古（2026-09-24 清掉 13 个：验「疆域蚕食」「飞行拖尾」那两版实现的探帧脚本、`verify-dot`、`verify-dark-ui`、`bench-fk-indexes.cjs`、头注释写着「用完即删」的 `smoke-fx-tabs`）。

## 4. 目录结构（src/）

```
components/
  EditableMap.tsx      # 编辑态地图画布：绘制交互/拖拽/选中/相机插值/悬停光标（最复杂的文件）
  Toolbar.tsx          # 导出两个组件：TopBar(顶栏 Logo/项目芯片/搜索/撤销重做/保存/导出/字幕生成) + FloatingTools(地图上方浮动工具条：5 个工具，每个工具弹窗底部一行「图层」选择器)
  MapStyleChip.tsx     # 地图左下角底图芯片（Mapimator SATELLITE 样式）：弹出 底图/高程/3D投影 面板
  ChapterMenu.tsx      # 顶栏章节弹出菜单：切换/重命名/复制/删除/新增/章节设置
  ShortcutsDialog.tsx  # 快捷键速查弹窗（时间线「快捷键」按钮触发）；改键盘绑定需同步此文件内容
  MapSearchBox.tsx     # 地名/坐标搜索，内嵌顶栏（项目芯片右侧）；地图实例经 lib/shared-map.ts 共享，EditableMap load/unload 时 set
  FxPanelBody.tsx      # 特效面板主体：天气/画面/弹窗/音乐 四页签（**无字幕页签**，字幕已迁到 GenerateDialog）；服务配置弹窗已搬去 ProviderPanel
  ImageGenerateField.tsx # 「描述 → 一张图」输入区（现在只有弹窗·人物的照片区在用）：尺寸/模型按模板声明长控件，产物 dataURL 交给调用方
  HotFixField.tsx    # 字幕生成里的「发音修正」：词 → 读音 / 原文 → 换成 两组行编辑器（存的就是上游 hot_fix 那份形状）
  ProviderPanel.tsx    # ⚙ 设置 · AI 的「实例设置」页：实例芯片一排 + ＋实例 / 模板下拉 / 同步异步 / 实例级参数 / 按请求分区的请求级参数（密钥按声明渲染成密码框）
  TemplatesPane.tsx    # ⚙ 左侧独立的「接口模板」入口：一行一份模板（三栏：模板列表 · 能力开关与推导出的接口槽卡片 · 实例级参数表）+ 每格一张参数表（**这一页不预览、不发请求**）；返回项分「引擎要读的（固定名，只填路径）」与折叠的「给下一个请求用的变量」
  SettingsDialog.tsx   # ⚙ 设置 · AI 外壳：左侧文案 / 语音 / 图片三类，右侧嵌 ProviderPanel（唯一入口，内联那份已删）
  VoiceField.tsx      # 音色选择器（字幕生成 + ⚙ 提交那一格共用）：上「内置音色」按模板的音色表分组（男/女，默认折叠）＋ 下「克隆音色」（内置男声/女声样本格 + ⬆上传其它音色）+ 试听
  GenerateDialog.tsx   # 顶栏「字幕生成」：需求 → AI 文案 / 整篇字幕文案 / 逐行字幕 + 逐行配音（可覆盖）+ 间隔 + 字幕样式；也是字幕条目与样式的唯一编辑处；四段全部可折叠
  TimelineEditor.tsx   # 播放条(播放预览胶囊+步进+元素面板开关) + 镜头流块(宽=移动时长) + 元素轨道；刻度间隔随时长自适应
  KeyframePanel.tsx    # 右侧「视角属性」：到达时间/移动时长(默认2s)/中心/缩放(1位小数)/俯仰/方向/缓动
  PropertiesPanel.tsx  # Mapimator 式 Settings 面板（Pin/Route/Shape/Image 四类，见 §5）
  ElementsPanel.tsx    # 左侧浮动元素面板：搜索/眼睛显隐/副标题/GeoJSON-GPX 导入/底部统计（由右下「元素」按钮开合）
  App.tsx              # 布局：TopBar + 全幅地图舞台(浮动工具条/元素浮层/右侧浮层) + 时间线
  ui/                  # 共享原子两处：primitives.tsx（本项目自研：Section/Field/StyleGrid/Toggle/ColorPicker/OptionBlocks/PanelHeader）
                       #   + shadcn 原子（button/input/textarea/label/select/dialog/popover/tooltip/tabs/switch/slider/progress/badge/collapsible/radio-group/card…）
                       #   新界面优先用 shadcn 那批；旧面板沿用 primitives，别为用而用；配置见根目录 components.json（`npx shadcn add <名字>` 追加）
  RegionPickerDialog.tsx / FrameTimeField.tsx / TaskTray.tsx(顶栏「在途 N」浮层) / ImageGenerateField.tsx / HotFixField.tsx 等
compositions/          # Remotion 导出端：MapVideo(单轴渲染) / MapScene / OverlayRenderer
lib/
  map-renderer.ts      # ★ 核心：所有地图元素的渲染（点7样式/路线/形状/标签位图/动画）
  keyframe-interpolation.ts  # 相机/通用关键帧插值（含 moveDuration 停留-飞行语义）
  military-plots.ts / military-geometry.ts  # 移植自 plot_ol 的军标算法（燕尾/钳形/进攻/集结地）
  regions.ts           # 行政区边界加载与点选/按名查找（默认 johan world.geo.json，可换源）
  geojson.ts / gpx.ts / export-video.ts / time.ts / easing-labels.ts / utils.ts
  asset-refs.ts      # ★ 项目里所有素材引用位的唯一清单（导出配置 JSON 带字节、导入改 id 都走它；新增引用位只改这里）
  request-engine.ts    # ★ 接口模板求值：三层取值 + `${x}` 求值与删键级联 / readPath / applyOutputs / runSync·submitAsync·queryOnce·runClone / validateTemplate / retriable(只有 429·5xx 才算「重试有用」)；不碰网络不碰 DOM
  template-seed.ts     # 内置接口模板 seed（7 份，一行一份完整模板：deepseek 文案 / 千问图 / 千问语音两条（qwen-tts 与带音量+发音修正的 qwen-audio-tts）/ ElevenLabs 语音 / MiniMax 语音 / MiniMax 图）；首次建库铺成表行，之后是普通可编辑数据；接新供应商改这里或界面上自己填
  providers.ts         # 供应商调用薄壳：callLLM/callTTS/callImage/cloneVoice + declaredOptions/declaredDefault（界面按声明长控件）→ 全走引擎；**没有协议分支**
  audition.ts          # 全应用**一路**声音（试听配音 / 音色）：playAudition / stopAudition，播新的必先停旧的
  backend.ts           # IS_DESKTOP 与 window.mapvideo.* 的类型门面（projects/assets/voices/tasks/providers…）
  i18n.ts              # 显示文案类型 L = string | {zh,en}（只有 value 进请求体）
  tw-colors.ts         # Tailwind 官方色板（22 族 × 11 阶，ColorPicker 的唯一取色来源，数值由 tailwindcss/colors 导出后落盘；族顺序跟 docs/colors 页一致）
  voices.ts            # 只剩内置的**克隆参考样本**清单（public/voices/*.mp3）；系统音色表不在这里 —— 它是模板里「音色 ID」那条参数的候选值（见 template-seed）；克隆账本在 `voice` 表 / `stores/voiceStore.ts`
stores/
  projectStore.ts      # 项目数据全部操作 + 撤销/重做 + IndexedDB(dexie) 持久化
  editorStore.ts       # 播放头 currentFrame / isPlaying / 选中元素 / currentCamera / cameraSeek / elementsOpen
  interactionStore.ts  # 绘制模式 + pendingPlace(一键中心放置) + focusReq
  providerStore.ts     # 接口模板 + 实例（两张表的全量状态，current(category) 给调用处选实例）
  voiceStore.ts        # 克隆音色账本（voice 表）：clone() 命中唯一键就复用，不重复建音色
  taskStore.ts         # 在途异步任务的调度器（状态全在 task 表；渲染端 1s 一轮 tick，跨重启续跑）
types/index.ts         # 全部数据模型（改数据结构先看这里）
```

## 5. 领域模型速记

- **项目（单条连续时间线）**：`startFrame`恒 0、`endFrame`为总长；`elements/camera/overlays/fx/narration/music` 全用**项目绝对帧**；底图/高程/投影项目固定。
- **★ 图层（Layer）是元素的唯一归属：项目 ▸ 图层 ▸ 元素**。图层**单类型**（marker / route / shape / territory / 图片），带自己的显隐与显示区间；`project.elements` 是 `deriveElements(layers)` 算出的**派生镜像**（store 的 patch 自动重算），只为让渲染/面板/相机等沿用扁平读取，**不要直接写 `project.elements`**（改元素一律经 `updateElement` / 图层 API，否则会丢归属）。元素的 `type` 决定它进哪个图层（`layerTypeOf`）。删图层连带删其元素；图层在浮层与时间线都可拖动改序。
- **★ 图层顺序 = 地图叠放顺序（列表靠前的在上层）**：新建图层（含自动建的）一律经 `insertLayerSorted()` 按 `LAYER_RANK`（标记 0 → 路线 1 → 形状 2 → 疆域 3 → 图片 4）插入，所以默认序固定为**标记·路线·形状·疆域·图片**、图片在最底、标记在最上；用户拖动后以拖动结果为准（该函数只给新层定位，不重排既有层）。图层面板与时间线都读 `project.layers`，顺序天然一致。地图侧 MapLibre 只认 `addImage/addLayer` 先后、重渲染不会移动图层，故 `renderElements` 之后要调 **`restackByLayerOrder(map, project.elements.map(e => e.id))`**（编辑端 `EditableMap` 与导出端 `MapScene` **都要调**）；它按列表倒序自底向上排，**同一元素的图层保持组内现有顺序**，所以「路线的移动标记在其线之上」「疆域标签在其面之上」不会被打破。签名（当前相对序）未变化时直接返回，避免每帧 `moveLayer`。
- **★ 选中图层 = 地图上的「可编辑层」**：`editorStore.selectedLayerId` 非空时，**只有该层的元素**在地图上有激活态编辑效果（可点选 / 可拖 / 顶点 / 高亮），其它层在地图上只读；**为 null 时全部可编辑**（否则一进编辑器什么都点不动）。门禁由 `editableIdSet(project, selectedLayerId)` 统一（`EditableMap.tsx`），插在 `pickElement`（命中即跳过不可编辑者，继续往下找，否则上层不可编辑元素会把点击吃掉）、`hitRouteVertex`、顶点标识 feats、`routeEdit` 失效判定。**关键：`selectElement` 不再清 `selectedLayerId`**（否则点一下元素门禁自毁）；代价是 Del 优先级翻转为**有选中元素先删元素，无元素才删整层**。收口两处：`projectStore.patch()` 每次写回后把「选中元素的宿主层」同步为可编辑层（改类型迁移也走这里）；新建/导入后调 `focusHostOf(id)`（`createElementAndSelect` / `pendingPlace` / 区域导入）让刚画的东西立刻可拖。图层面板元素行点击用 `focusLayer(id)`（只改门禁、不改写入目标），图层行/时间线图层块用 `selectLayer(id, type)`（两者都改）。**门禁必须对「图层已不存在」自愈**：`editableIdSet` 找不到该层时返回 `null`（= 全部可编辑），不能返回空集合 —— 空集等价于「整张地图静默只读」，而删掉当前选中的图层、撤销/重做换掉图层集合都会造出这种悬挂 id。另：换项目时（`createProject` / `loadProject` / `importProjectConfig`）调 `editorStore.resetSelection()`，选中态存的是项目内 id，不清就会带着旧项目的引用进新页面。
- **编辑辅助图层不得进命中区**：`getAllElementLayers`（EditableMap）只认 id 里含 `-layer-`/`-label-` 的图层，所以「移动点的全程路径虚线」`moving-guide-layer-*` 会被算成元素图层 —— 它覆盖整条路径，等于给那个移动图标铺了一个全长拖拽手柄，还会吃掉虚线下其它元素的点击。已按 `linespot-` 的先例一并排除；**新增编辑辅助图层时必须同时加进这张排除表**。
- **★ 归属解析只有一处：`resolveTargetLayerId(layers, type, targets, explicitId)`**（`lib/layers.ts`）= 显式指定 → 该类型的「写入目标」→ 该类第一个图层 → 调用方新建。**「写入目标」按类型记在 `editorStore.targetLayers`**（会话内状态，不入库）：入口是**每个工具弹窗底部那一行「图层」**（`Toolbar.tsx` `LayerPickRow`）——只列该类型的图层，选择即调 `selectLayer(id, type)` 同步设为「写入目标」+「可编辑层」（图层面板与时间线随之激活）；该类型一个图层都没有时只显示「新建×图层」。（早先放在浮动工具条上的 `LayerTargetChip` 芯片已移除，不再提供「自动」选项。）配套：元素行 hover 的「移动到…」（`movableLayersFor` 只列同类型、排除当前层，调 `moveElementsToLayer`）；`updateElement` 在 `changes.type` 跨类别时**自动把元素迁到目标类型图层**——单类型图层的不变量靠这两处守住，新增任何改 `type` 的路径都必须走 `updateElement`。
- **底图 / 高程图每项目一份**：`project.baseMaps` / `elevationMaps` 不是全局常量，创建项目时从内置目录复制成行（`base_map` / `elevation_map`，复合主键 `project_id + *_id`，内置 id 各项目同名），之后各项目各改各的；`active_*_map_id` 是**弱引用**（父子互引，建 FK 就得「插项目→插子行→回写项目」三步）。地形夸张存 `elevation_map.exaggeration`（0 是合法值，读取端一律用 `??`/`== null` 判定，别用 `||`）。**随之改变的语义**：用户删掉的内置底图**不再在下次加载时自动补回**（`stripRemovedBaseMaps` 只清已下线 id，不再 push 缺失的默认项）——目录既然是项目自己的数据，就不能替用户复活他删掉的东西；要给用户机推送新内置底图，得单独做，不要塞回 load 路径。
- **MapElement** 判别联合：point(9种形态: shape=circle/pin/bubble/emoji/text + image/gif/model/icon；可带 iconUrl 自定义图)、line(straight/bezier/arc + label + routeEffect + flowSpeed)、moving_point(path+pathProgress)、polygon(shapeKind=poly/rect/circle + circleMeta/rectMeta)、arrow(7种箭头)、double_arrow、encirclement、gathering、flag、military_symbol、territory。（**custom_icon 类型与 Image 工具已于 2026-09-10 下线**；旧数据由 `normalizeChapters` 在 load/import 时退化为 point）
- **CameraKeyframe**：frame=**到达时间**（绝对帧）；`moveDuration`(帧)=起飞提前量，**默认 2*fps**；语义=停留→飞行→落位（`interpolateCamera(kfs, frame, fps)`）。
- **LabelConfig**：text/color/position(上左下右中)/bgColor(默认透明)/bgPadding/bgRadius/fontWeight。渲染=canvas 气泡位图（makeBubbleImageData，仅 BUBBLE 样式带尾巴）。
- **PointElement 特有**：shape、emoji、scale(0.3–3 等比缩放点+label)、orientation(faceCam/flat)、rotation(贴地旋转)、iconUrl、label。
- **★ 字幕 / 配音只在「字幕生成」里编辑**（特效弹窗已无字幕页签，`FxTab` 也去掉了 `'subtitle'`）。入口两处：顶栏「字幕生成」按钮、时间线「🎙 配音」块点击 —— 都走 `editorStore.subtitleOpen`（同一个弹窗实例，`Toolbar.tsx` 里挂载）。**弹窗 = 四段可折叠区 + 行列表**（`Fold`；展开与否记在 `editorStore.dialogSections`，键带 `subtitle:` 前缀 —— 一个弹窗一个命名空间，会话内记住、不入库）：① **需求**（上面写需求，右下角「🤖 生成文案」）；② **字幕文案**（整篇草稿，与下面的行列表是**同一份内容的两种看法**：没动过草稿时它跟着行列表 join，动过就锁定草稿，直到点「按行应用」—— 逐字符重拆行会打断输入，敲回车那一下光标会跳）；③ **配音音色**（折叠标题带上当前音色名）；④ **字幕样式**（标题带「楷体 · 40 号 · 距底 2%」这类摘要；每一项都有标签 —— `StyleRow` 左标签右控件，滑块另起一行 `SliderRow`，不再是一排裸控件）。**没有参考资料，也没有导入 / 导出 SRT**（2026-09-26 按要求删：参考资料只是提示词上下文、不需要用户手改，SRT 那条路 `splitScript` 认时间轴本就覆盖；`parseSrt` / `srtTime` 随之从 `providers.ts` 下线）。**行列表**：一行 = 一条字幕 + 一段配音，左边一枚「出场秒」（顺排算出来的，不是输入项），右边依次是状态徽标、这一行的**停顿**（`停 [__] s`）、🔊/🔁 生成或**覆盖**配音、▶ 试听、✕ 删除；**＋加一行、▶▶ 全部生成配音（串行、只补没配音的行）、整片字幕间隔（0–5 秒滑块）、配音音量（滑块）**都在行列表下面那一排。**字幕间隔存两处**：整片一个默认值（`narration.gap_sec`，新建项目默认 1 秒），每行可单独覆盖（`narration_entry.gap_sec`，**留空 = 跟整片，0 是「这一行不停」的有效值** —— 两态必须分得开）；顺排函数 `resequenceRows(rows, gapSec, fps)` 在每行末尾加上这个停顿，改了立刻重排未锁定的行。**配音音量只有整片一层**（`narration.volume`，0–1，默认满格）：生效点在**两处必须同时改**（§6.7 双端一致）——预览 `preview-audio.desiredAt` 与导出 `MapVideo.NarrationAudio`（乘进 `narrationVolumeAt`）。曾做过「每行可覆盖」那一层（`narration_entry.volume`），2026-09-27 按要求删掉：它是**混音量、不是合成量**，逐句响淡该走上游合成参数（能吃 `volume` 的那条端点），而不是在播放器里乘系数 —— 而且混音端根本放不大（见 §6.31）。**每行右侧一枚状态徽标**（`RowStatus`）：未配音 / 排队中 / 合成中 / 配音时长（如 `4.6s`）/ 失败（原因原样放 `title`，不翻译）—— 批量 30 行时只有顶部一个汇总数字根本看不出哪行卡住，所以状态必须逐行摆；`SubRow.error` 与 `NarrationEntry.error` 一起落库。**试听全应用只有一路声音**（`lib/audition.ts`：模块内单个 Audio，新的播之前自动停旧的）—— 逐行试听、音色区试听、时间线预览不再各响各的；再点同一条 = 停止；时间线开始播放（`editorStore.isPlaying`）与弹窗卸载时 `stopAudition()`。**字幕行的输入框含换行即按行拆成多条字幕**（整篇文案一次贴入的入口，回车同义；首句留在原行以保住它已有的配音）；输入框用 `LineInput` 按 `scrollHeight` 自增高（默认一行，不再固定两行；**增高要把边框那 2px 算进去**，算成 `scrollHeight` 本身会让一行也长滚动条）。底部「字幕样式」写 `setNarrationStyle`，**随时生效**（样式是项目级设置，`applyGeneratedProject` 那套强制默认样式的做法早已去掉）。
  **一屏到底**：**没有步骤①/②，也没有「手动填写文案」与「返回重写」**。文案有两个来源：🤖 AI 生成、📥 展开「字幕文案」贴整篇（`splitScript` 认序号 / 时间轴与引号，所以一份 SRT 正文粘进去照样拆对）；也可在行内直接贴（含换行即按行拆分）。
  **配音音色在弹窗内选**（`VoiceField`，两段式，受控：`{inst, slot, spec, value, onPick}`）：上段 = 这一份模板声明的**音色表**，按候选值的 `group` 分组（**男声 / 女声 /（上游给了才长出第三组，空组不显示）中性**），**默认折叠**（折叠时标题带条数与当前选中的音色名，别改成默认展开 —— 一组就有 19 个色块，展开会把字幕区挤走）；**表就是数据**：`template-seed.ts` 里「音色 ID」那条参数的 `options`（`{value,label,group,note,models}`），铺进库后是普通可编辑行，⚙ 的接口模板页能改 —— 代码里**没有音色表，也没有按模板 id 分支的 `systemVoicesFor`**（那是最后一处协议分支，2026-09-26 拆掉）。名字仍须逐字对官方（ElevenLabs 那 21 条是跑 `/v1/voices` 把 `labels.gender` 抄回来的，官方就有 `neutral` 这一档，不是从名字猜的）。下段「克隆音色」= 内置样本格（**男声·内置 / 女声·内置**，对应 `public/voices/male.mp3`/`female.mp3`，即用户提供的历史-男/女）+ ⬆ 上传其它音色；样本格没克隆过时是**虚线**，点它=先克隆再选中，克隆过即与寻常音色无异。
  **音色与它绑的模型记在实例的「提交」那一格里**（`values.requests[<submit>].voice` / `.model`）：字幕生成与 ⚙ 改的是**同一处**，所以「下次打开还是这个音色」不需要第二本账，`genVoice` 也不再单独攥一份 voiceId —— 引擎三层取值自会拿。为什么绑的模型要一起写：克隆出的 voice_id 只在克隆时那条模型上有效（拿系统音色 `Ethan` 去喂 `-vc` 模型，上游回 `InvalidParameter`，2026-09-24 实测；反方向按上游文档同样不通），所以选克隆音色时把它绑的模型一并写进**同一格**（不写进实例别处，也不是只活一次的调用参数）。现在两条都是**声明**：系统音色各自带 `models: ['qwen3-tts-flash']`（`visibleOptions` 按这一格当前 `model` 过滤，选了 `-vc` 时内置那一段自然空掉），克隆音色的目标模型 = **克隆那一格自己声明的 `model`**（`cloneTargetModel`，不再 `find(m => m.includes('-vc'))` 猜字符串）。「克隆音色」区在不在看**这份模板有没有配 `clone` 接口**（`supports(inst, 'clone')`），不认协议字符串；克隆账本 = **`voice` 表**（`useVoiceStore`，唯一键 `(provider_id, source_hash, target_model)`，同样本同模型直接复用不在服务端反复建音色，参考音频原件存 `asset`，音色失效靠它重建），**不在 localStorage 记第二份**。候选值为空（自建模板没填表，或当前模型下一条都不适用）时才长出「手填音色 ID」输入框。`voiceModelOf` 取不到实例值时回落到模板声明的默认值，与引擎三层取值同一条规则。**同一个组件也长在 ⚙ 的「提交」那一格上**（`ParamSpec.voiceTable` 为真 → `ParamControl` 渲染 `VoiceField` 而不是普通控件）：那里显示的就是这条实例钉的音色，两处改哪边都跟得上；试听不在 ⚙ 开（那次真发的正确入口是「试调用」）。
  **发音修正（项目级）在字幕生成弹窗里**（`HotFixField`，一段折叠区，在「配音音色」下面，**默认折叠** —— 标题带条数，一条没填显示「未填」；`IS_DESKTOP` 门禁）：两组行编辑器 —— 词 → 读音、原文 → 换成，存进 `project.narration.hotFix` → `narration.hot_fix_json`。保存的形状**就是上游 `hot_fix` 那一份**（一条 = 单键对象），所以调用时零转换：`genVoice` 把它塞进 task 的 `input.hotFix`，试听也带（`VoiceField` 的 `extra`），模板把这条参数声明成 `json` 就原样进体（引擎不改形状，也没有 `transform` 那格了）。空 = 不传这个参数（整键消失）。**这一格有没有消费者由 `referencesArg(模板, 那一格, 'hotFix')` 当场判**（请求体里写了 `${hotFix}` 才算）：没写时折叠区标题与说明点名「当前配音模板不认这个参数，填了不会发出去」并给出两条出路（换模板 / 去 ⚙ 加那一格），不再像以前那样留一句「声明了才生效」的免责小字 —— 引擎对没人引用的调用级参数是**静默删键**，用户看不出区别。内置里吃它的是「千问语音（音量 / 发音修正）」那份（`input.hot_fix`，`cosyvoice-v2` 不支持；形状与音色名逐字抄自官方 HTTP 参考，**尚未真发**）；`qwen3-tts-flash` 那条端点整个没有 hot_fix。
  **打开即载入项目现有字幕继续编辑**（不再有 `editOnly` 分支）；「应用字幕与配音」只写 `setNarrationEntries`（字幕比片长久时补一次 `setProjectEndFrame`），**不动元素 / 弹窗 / 特效 / 相机**。
  原「AI 顺带生成地图元素」的整条链路已删除：`lib/generate-elements.ts` / `lib/gazetteer.ts` / `lib/geocode.ts` / `lib/camera-plan.ts` / `projectStore.applyGeneratedProject` / 类型 `GeneratedChapterPlan`·`GeneratedOverlaySpec`，以及弹窗里的地名解析与「待填坐标」区块。
- **时间线配音块只能整体平移**：`beginBlockDrag` 的 kind 多了一支 `'narration'`，块上只挂 `onPointerDown(mode:'move')`、**不给 `DragHandles`**（所以两端拉不出），拖动写 `setNarrationEntries` 且置 `locked: true`（顺排不再把它拉回）。时长始终由音频/字数估算决定，与其它轨道（fx/弹窗/图层可拉伸）不同。
- **背景音乐（项目级）**：`project.music: MusicTrack[]` 是**单轨多段**（段用**项目绝对帧**，段内可循环），不是片段字段；默认第一段铺满全片（内置 `public/bgm` 或导入）。时间线只显示与当前章节相交的段；播放/预览/导出（`MapVideo.ProjectMusic` / `preview-audio`）都按项目绝对帧走。
- **坐标显示一律 5 位小数**（toFixed(5) + step=0.00001）；视角缩放显示 1 位小数。
- **合集（Collection）**：项目之上的一层分组（`合集 ▸ 项目 ▸ 元素`）。`id = 'default'` 的**「默认合集」不可改名、不可删除**（名称由 `DEFAULT_COLLECTION_NAME` 常量决定）；新建项目 / 导入未指定归属时落默认合集；删合集只把项目移回默认合集，**不删项目**。

## 6. 血泪教训（改代码前必读，全部踩过）

1. **禁止用 `isStyleLoaded()` 做相机/事件 effect 的门禁**。v5 中字形/瓦片未就绪时它频繁返回 false，会吞掉离散跳帧（⏩/点时间线）的相机更新与首次事件注册。
   - 相机 effect 只判 `mapRef.current`，`jumpTo` 用 try/catch。
   - 地图事件在 `map.on('load')` 里**一次性注册**，回调经 `handlersRef.current` 取最新（latest-callback ref 模式）；不要在独立 effect 里注册地图事件。
2. **元素类型切换（ID 不变）会残留旧图层**。`renderElements` 维护 id→type 签名表，签名变化先 `removeElementLayers` 整体重建。新增渲染分支时记得纳入该机制。
3. **MapLibre 重名 layer 会自动加数字后缀**：从 layerId 反解元素 id 必须用「已知元素 id 前缀匹配」（`EditableMap.elementIdFromLayerId`），简单截断会匹配失败。
4. **thin line 难选中**：线元素有透明宽热区层 `line-hit-{id}`（line-width≥12, opacity 0）。
5. **数据默认值**：moveDuration 默认 2s；label.bgColor 默认透明；仅 BUBBLE 样式带尾巴；TEXT 无位置项（强制 center）；缩放/尺寸走 `scale`，不要再加固定像素字段。
6. **自动保存：停止编辑 5s 后静默落盘**（2026-09-19 用户拍板保留）。三条硬规矩：① 排程前必须 `isProjectDirty(project)` 判脏，否则 `saveProject` 造新引用 → effect 重跑变成每 5 秒无限写库；② 回项目列表前要先 `void saveProject()` 补存（应用内导航不触发 beforeunload，5s 内退出会丢最后一次编辑）；③ 导出视频**不落盘**。手动 💾 仍在。④ `saveProject` 在 `await` 之后**只在当前项目仍是那份快照时才回填**（`if (get().project !== project) return;`）：退出项目是「先发起补存、再 `set({project:null})`」，无条件 `set({project:updated})` 会把旧快照塞回去，表现成**「点『项目列表』没反应」**（实测：撤掉守卫即复现，加上守卫即停在列表页），顺带还会回滚这几秒内的编辑。
7. **双端一致**：改渲染/相机逻辑必须同时检查编辑器 `EditableMap` 与导出端 `compositions/MapScene`。导出端相机已传 fps。
 8. **PowerShell 内联 node -e 处理中文/复杂引号会碎**：批量改文件一律写一次性 `.cjs` 脚本用 fs+utf8（用完即删）。
9. **pincer(钳形) 与 double_arrow**：预览与最终必须同用 `buildDoubleArrow`；不要用 buildArrowGeometry 的 pincer 分支做预览。
11. **镜头插值 effect 的依赖必须是 `project.camera`（数组引用）而非 `project`**：任何元素属性修改都会重建 project 对象，若依赖 project 会在每次改样式/改属性时触发 `jumpTo`，把用户手动平移的地图拽回关键帧位置。
10. **地图事件 vs 播放循环**：`map.on('move')` 会 60fps 触发 `setCurrentCamera`→全订阅组件重渲染，属预期；不要在 move 回调里做重活。
12. **Windows + Node 22 不能直接 spawn `.cmd`/`.bat`**（CVE-2024-27980，会 EINVAL）：必须 `shell: true` 或走真实 exe 路径（`scripts/dev-desktop.mjs` 已修：Electron 用 `require('electron')` 返回的真实路径）。
13. **本机安全删除守卫**：批量删除 >50 项会被拦（典型场景：Vite 重建依赖缓存 `node_modules/.vite`、npm install 后的临时目录）。规避方式是 **mv 挪走而非删除**：`move node_modules\.vite node_modules\.vite.bak.%RANDOM%`。
14. **全局宿主组件必须在所有布局分支挂载**：`<ConfirmHost />` 这类 zustand 驱动的全局 UI 宿主，若只挂在编辑器分支，项目列表页里的 `await confirm(...)` 会**永久挂起**（弹窗不渲染 → Promise 既不 resolve 也不 reject），表现是「点删除没反应」且**无任何报错**。新增整屏布局 / 提前 `return` 分支时，记得一并挂载。
15. **异步资源位图首次就绪必须触发一次重渲染**：图片 / 动图 / 模型 / 图标库走异步 `addImage`，此前图层挂的是 `VIS_PLACEHOLDER`；只调 `map.triggerRepaint()` 不会改图层的 `icon-image`，表现为「点两次才显示」。现由 `setVisualReadyHandler` → 编辑器 `setStyleTick(+1)` 修正——**新增异步资源管线时，必须在「首次 addImage」分支（不是 `updateImage`）调 `notifyVisualReady`**，否则会陷入逐帧重渲染死循环或再次出现该 bug。
16. **zustand 的 selector 绝不能返回新引用**：`useProjectStore((s) => s.project?.xxx || [])`、`.filter()`、`.map()` 每次都产生新数组，`useSyncExternalStore` 会判定快照已变 → **无限重渲染**（控制台报 `Maximum update depth exceeded`）。selector 只返回原值，空值兜底放组件外用模块级常量（如 `EMPTY_CUSTOM_IMAGES`）。
17. **Tailwind 的定位工具互斥，别叠在同一个 class 串里**：`relative fixed inset-0` 同时挂上时 `relative` 会赢（CSS 源码顺序决定，与 class 书写顺序无关），于是 `inset-0` 失效、元素高度塌成 0（演示模式曾因此整棵树不显示）。条件切换定位方式要把基类一起换掉：`${presenting ? 'fixed inset-0' : 'relative h-screen'}`。
18. **渲染位图的「已生成」缓存绝不能放模块级**：地图实例会随切项目重建（`EditableMap` 的 `new maplibregl.Map` / `map.remove()`），届时 `map.hasImage()` 全空，但模块级 `Map` 仍记着「这张图生成过了」→ 新地图永远等不到 `addImage`，图层引用不存在的 icon-image 就什么都不画。`renderFlag` 曾因此让**旗帜整类不显示**（点标记用的 `shapeImageCache` 有在 `clearRenderCaches()` 里清，所以只有旗帜中招）；现在只以 `map.hasImage(imageId)` 判定，addImage 抛错就等下一帧重试。新增位图管线时同理：**要么用 per-map 缓存，要么记得在 `clearRenderCaches()` 里清**。
19. **「动画效果 = 路线移动」必须顺带打开「显示标记」**：那个沿路线走的标记就是这个动画的主体，而形状工具下拉建的「直线」默认 `showIcon: false`。原先写的是 `showIcon ?? true`，false 被原样保留 → 选了动画什么也不动，面板里的「动画开始/结束时间」也成了摆设。规则：**选 move 就 `showIcon = true`**（反向已在「显示标记」开关里：打开时若无动画则补 move）。
20. **`renderLine` 的 `noAnim`（原名 isShapeLine）只表示「没被显式要求动画的形状线」**：形状线默认「一致显示」（整条一次画完、不看动画起止、不 march / 不 fly），判据是 `shapeCategory ∈ {multi,special}` **且 `animEffect` 为空**；用户显式选了动画，就别再拿「它是形状线」当理由忽略 `moveStartFrame/moveEndFrame`。以后写这类「按默认语义压制用户输入」的门禁，都要给显式值让路。
21. **`PropertiesPanel.tsx` 曾混着单 `\r` 换行的行**（早年内联脚本改写的残留），git 因此把整个 blob 判成 `-text`：任何一处小改都显示成整文件重写，blame / review 全废（2026-09-19 已统一为 CRLF）。批量改文件时**读也要 `newline=''`**，只在 `open(...,'w')` 加是漏的 —— universal-newlines 会把 `\r` 和 `\r\n` 都吞成 `\n`。改完用 `git ls-files --eol <file>` 确认是 `i/lf w/crlf`。
22. **TTS 的「协议 ↔ 模型名 ↔ 音色」三者必须成套**（2026-09-19 上游 HTTP 400 `InvalidParameter / Model not exist.` 的成因）：`providers.ts` 里 `case 'qwen-tts'` 实现的其实是 **CosyVoice** 端点（`/services/audio/tts/SpeechSynthesizer`，设置面板下拉一直标着 "DashScope CosyVoice"），而预设往里填的是 Qwen-TTS 的模型名 `qwen3-tts` —— 模型名发错了端点（能报 "Model not exist" 说明 baseUrl 与路径是对的）。现在拆成 `cosyvoice`（音色 `long*`，如 longanyang）与 `qwen-tts`（`/services/aigc/multimodal-generation/generation`，音色 `Cherry` 那套）。合法模型名：CosyVoice 端点 = `cosyvoice-v3-flash` / `v3.5-flash` / `v3-plus` / `v3.5-plus` / `v2`，同端点还承载 `qwen-audio-3.0-tts-flash`（本机 `D:/frontend/qwen/vioce.py` 实测在用）；Qwen-TTS = `qwen3-tts-flash` / `qwen-tts`（**`qwen3-tts` 单独不是合法名**）。音色同理：`long*` 属 CosyVoice、`Cherry` 属 Qwen-TTS，且带 `_v3` 的名字不与 v2 通用 —— 所以 UI 里不给自由输入，只给官方表抄来的下拉列表。声音克隆**两条端点都有、形状不同**（CosyVoice 系：`voice-enrollment` + `action:'create_voice'` + `prefix` → `output.voice_id`；Qwen-TTS：`qwen-voice-enrollment` + `action:'create'` + `preferred_name` + `input.audio.data` → `output.voice`，且合成必须用同款 `target_model`，参考音频要求 ≥24kHz 而 CosyVoice 转 16k）—— 这些差异现在是 `provider_template` 里的数据（seed 组 `dashscope-cosyvoice` / `dashscope-qwen-tts`），不再是代码分支。改任何一项都要同时核对端点、模型、音色三项。**2026-09-22 真实调用实测**：`SpeechSynthesizer` 回的是 JSON、音频在 `output.audio.url`（不是响应体字节）；系统音色 `longanyang` 只认 `cosyvoice-v3-flash`，`v3.5-flash` 承载克隆音色（418 就是拿系统音色去喂它）。
    - **参考音频的采样率不是模板字段**（2026-09-25 他拍板：删掉这个概念）：转码固定输出 `24000`（`providers.ts` 的 `REF_SAMPLE_RATE_HZ`，`ref_sample_rate` 列已下线）。将来要接「只收 16k」的一家，改这个常量，**不要再把它做成模板上的一个格子** —— 一个用户看不懂、又只有一处会用的数字不值得占界面与库表。
23. **弹层的「层」有两个独立陷阱（2026-09-20 字幕生成弹窗两处同报）**：
    - **宿主带 `overflow-y-auto` 时不能用 `absolute` 浮层**：子面板会被宿主裁掉，实测表现为「点了没反应」（`ColorPicker` 的色板当时顶边已经在弹窗之外）。共享原子一律走 `createPortal(…, document.body)` + `position:fixed`，在 `useLayoutEffect` 里按触发块与视口算位置（下方放不下就翻到上方，最后再夹一次 —— 只夹 `top` 不夹 `bottom` 仍会露半截）。面板脱离了 `wrapRef`，所以点击外关闭必须同时放过 `popRef`，否则 mousedown 先把面板卸掉、`click` 再也打不到色块；滚动 / 改窗口尺寸要**重新定位**而不是关闭（早先写成关闭，结果连面板内拖滚动条都把面板关掉 —— 宿主 `overflow-y-auto` 滚动时同理）。
    - **地图舞台内的 `zIndex` 会漏到模态窗之上**：`FxPreviewLayer` 里字幕是 `zIndex: 60`，而 `GenerateDialog` 是 `z-50`，舞台盒子原本没有层叠上下文，60 就跑去和根上下文比大小，于是**预览字幕盖住字幕生成弹窗**。修法是给 `App.tsx` 那个 `absolute` 的 stageBox 加 `isolate`，把地图 / 字幕 / 弹窗卡片 / 屏幕特效压成一个上下文（组内相对顺序不变，MapLibre 图层照旧）。A/B 实测：`isolation:isolate` 时舞台内 z-60 探针的命中区被弹窗夺回，改回 `auto` 即复现遮挡。以后新增「舞台内高 z-index 的预览层」不必再单独跟模态窗比大小。
24. **枚举白名单不要写进 DDL，接口形状也不要写进 switch**（2026-09-21 两条相关教训，同日已一并解决）：
    - 起因：`provider.protocol` 的 `CHECK (… IN (五项))` 是「一家供应商怎么发请求」的第四份真相（另三份是 renderer 的 switch、主进程的 switch、`assertTtsPairing`）。拆出 `cosyvoice` 协议时只改了三处，DDL 那份漏了 → 新行插库报 `CHECK constraint failed`；而 `providerStore.dbSync()` 只 `console.warn`，渲染端读的是 zustand 内存态，所以**当场全好、重启即丢**（`hydrate()` 用库里的行覆盖状态）。
    - 现在的做法（2026-09-23 定稿，2026-09-25 换成能力开关驱动）：**四张表**（`docs/provider-engine.md`）——`provider_template`（**一行 = 一份完整模板**：category / **`caps_json` 能力开关（调用方式 · 建音色 · 参考音频怎么交：单独上传/base64/表单）** / **实例级参数声明** / `sync_json`·`async_json`·`upload_json`·`clone_json` 四个接口槽列（**产物形式是每一格自己的 `artifactForm`**：none / 响应体即字节 / base64 / hex / 链接当场下 —— 没有「再问一次地址」的 download 那一格，`download_json` 已下线）。**该有哪几格、每格必须交出哪些字段、那一格发 Body 还是表单，全部由 caps 推导**（`slotsOf` / `requiredOutputsOf` / `multipartSlotOf`），早先的 `use_clone` / `upload` 两列已下线 —— 它们与「`clone_json` 空不空」是三份真相）、`provider`（**只有五个业务列**：引用哪份模板 + 名字 + 同步异步 + `values_json{instance,requests}`；一份模板可挂多条实例，调用处选实例，没有 `active`）、`voice`（克隆音色账本，唯一键 `(provider_id, source_hash, target_model)`）、`task`（在途异步任务，跨重启续跑）。**实例不内置任何字段**：`baseUrl` / 密钥 / 模型 / 尺寸全是模板声明的参数，密钥 = 声明成 `valueType:'secret'` 的普通参数（渲染成密码框 + 按声明打码），所以「哪些名字算敏感值」只有一处答案。**category·role 一律不加 CHECK**，取值由 TS 联合类型 + 保存前 `validateTemplate()` 管；接新供应商不改表、不加 switch、不改代码（模板行就是数据）。**模板名 / 参数 label 是用户自己填的单个字符串，不做中英两份**（自定义的东西没法自动翻；界面自身的标题才走 `t()`）。
    - 旧库的形状漂移仍走启动体检：`retireProviderIfStale()` 认**正标志**（不能认「缺了新列」——补列那步 `ensureAllColumns` 会先把新列名塞进旧表，把漂移盖住，实测踩过）：实例侧「带 recipe·secrets_json·protocol / `tpl_group` / `kind` / `base_url`·`api_key`·`params_json` 等具名列 / 还有 `provider_endpoint` 表」，模板侧「`provider_template` 还带 `tpl_group`·`role`·`vars_json`·行级 `label`（= 组表那版的形状）或 `use_clone`·`upload` 两列（= 能力开关还没并进 `caps_json` 的那一代）」。让位是**改名不删**（用户的模板改动与 Key 都是资产）→ DDL 建新表 → 渲染端 hydrate 先按 seed 铺模板、再调 `providers.migrate()` 把旧具名列并进 `values.instance`（`overrides_json`/`params_json` 一并汇总；有 async 行则实例 `sync=0`；`speed` 是旧表默认值 1 就别搬，会在 values 里留一个没人声明的键；搬不动的行留在 stale 表等下次，搬干净才 DROP 归档表）。**改名前要临时 `PRAGMA foreign_keys = OFF`**：外键条款的改写跟这个开关走，开着改父表名会把子表（`provider.tpl_id`）永远指向 `…__stale` 那份死表；同理改名前要把**命名索引**先 DROP（否则新表的 `CREATE INDEX IF NOT EXISTS` 会被静默跳过，丢掉唯一约束）。**`dropRetiredColumns` 必须排在 `db.exec(ddl)` 之后**：`ALTER TABLE … DROP COLUMN` 会重校验依赖该表的视图，而让位那一刻 `provider_template` 已被改名、还没重建回来，视图 `v_check_async_pairing` 指着一张不存在的表 → 删列直接失败（真机踩过，日志是 `error in view …: no such table: main.provider_template`）。**删列前要问一句「这一列有没有别人没有的值」**：`headers_json` 那代把认证头存在模板级、各槽 JSON 里没有，直接删列就是**下次真调用全 401**（不报错，只是取不到）——所以 `dropRetiredColumns` 前有一步 `foldTemplateHeadersIntoSlots`：认「列还在」这个正标志，把那对头并进每个还没有自己 headers 的槽（GET 那条顺手去掉 Content-Type，已有 headers 的槽不动），再删列。全库只有这一处一次性搬迁，是「不并就丢数据」的例外（其余按 §8 直删）。回归 `node --experimental-sqlite tools/verify-provider-templates.mjs`（[1][2] 两代新表逐字往返与真外键、[3] 音色唯一键与任务读写、[4] 异步配对自检、[5][6] 四代旧形状让位搬回、[7] 作废列清理（含「换代与删列同一次启动都要成」那条顺序回归 + 那对头并进各槽）、[8] `task` 表换代）。
    - 推广开一句：**凡是「用户能改、又能从别处推不出来」的值才入库；同一条事实只允许一处真相，宁可让它是一张表，也不要多处 if**。
25. **`map.getStyle()` 是整份 style 的深序列化，不是「读个列表」**（2026-09-25 实测）：压测项目（340 元素 / 835 个 style 图层）单次 ~1ms，而 `hideElementLayers` / `showElementLayers` / `restackByLayerOrder` 原来每个元素各读一次 —— 一半元素不可见时就是每帧 170 次，帧时从 150ms 被顶到 300ms（6fps）。逐帧路径里要么整帧读一次共用（`styleLayerIds(map)`），要么先比签名再干活（`restackByLayerOrder`），别在 per-element 循环里读全表。同理 `getStyle()` 之后拿 `style.layers.length` 当「够不够大」的探针也是白花一次序列化。

26. **往地图推 GeoJSON 只有一个出口：`putGeoJSON`**（2026-09-25）。它的不变量是「签名 == 这个 source 现在装的内容」，所以**任何**绕过它直接 `src.setData(...)` 的写手都会把不变量打断 —— 表现是「拖到一半取消，图形不回位」（渲染器以为内容没变，把恢复性写入跳掉了）。`EditableMap` 里 7 处地图直改已全部改走同一个函数；新增写手时必须一起走。压测项目实测：加了门禁，逐帧 worker 写入（`receive` / `sendAsync`）从热点榜上掉下去，fps 10.3 → 12.8、中位帧时 150.3ms → 83.5ms。

27. **逐帧几何只算一次：三条契约一起成立才成立**（2026-09-25，压测项目 340 元素实测中位帧时 133.5ms → 50.1ms、fps 8 → 15）：
    - **缓存一律按「数据身份」，不按 id**：`cumLenByPath`（WeakMap，键 = 折线数组本身）、`effectiveByElement` / `staticLineDataByElement`（WeakMap，键 = 元素对象）。这条依赖项目数据不可变这个前提 —— 每次编辑都换对象/数组引用，所以「同一个引用」就等价于「输入一个都没变」。**任何人原地改元素字段（`el.coordinates.push(...)`）都会让缓存读到旧几何**，一律经 store 换对象。
    - **`isFrameStatic` 是「整帧跳过渲染器」的唯一判据，默认不跳**：只有确认渲染器对该元素既不读 `frame` 也不读相机才返回 true（现在是 flag / geo_image / 不带透明度关键帧且非 gif、非模型自转的 point）。**新增任何逐帧或逐相机的渲染分支，必须同时让它判 false**，否则画面会停在最后一次真跑的那一帧且不报错（gif 靠 `updateImage` 换像素、模型靠 imageId 里的角度 —— 两者都曾被误判为可跳过）。作废门禁的是 `renderElements` 的 `renderEpoch` 形参（编辑端传 `styleTick`：底图 `setStyle` 与异步位图首次就绪都走它），导出端 `MapScene` 恒 0 —— 它的 `mapRef.current` 只在 `map.on('load')` 里赋值，所以不存在「样式没就绪时 addImage 静默失败、再也没机会重试」。
    - **`putGeoJSON` 先比对象引用再比签名**：缓存生效后逐帧交回的是同一份 GeoJSON，引用相等即可直接返回，省掉 `JSON.stringify` 那趟整树序列化。
    回归：`node --experimental-strip-types tools/verify-path-interpolation.mjs`（缓存版路径插值与 `turf.along` **逐字同值**，不是「误差够小」）、`node tools/verify-render-gate.mjs`（六条地图状态断言，含「被跳过的静态点仍在显示」与「gif/模型/透明度/沿线图标必须继续动」）。

28. **测性能别拿 fps 当有效性护栏**（2026-09-25）：`tools/bench-preview.mjs` 原来判 `fps >= 30` 才算有效，于是**越重的场景越被判成脏数据**（340 元素实测就只剩 6~8 fps，而它恰恰是要测的那个场景）。节流看的是**特征**不是快慢：中位帧时 ≈1001ms 且 `idleShare` 七八十 = rAF 被钉在 1Hz（窗口最小化 / 没带 `MV_BENCH=1`）；`idleShare` 为 0 = 主线程真忙，那是目标数字。另两条口径：同一轮改动**同条件连跑两遍**（这台机器噪声有 ±50ms 量级），以及 `tools/bench-attribution.mjs` —— `bench-preview` 的自耗时 top 全是 turf/maplibre 的压缩名，看不出谁在调它们，归因到我们的函数才找得准（这次就是这么发现 `getLineMidpoint` 每帧把整条贝塞尔线重走两遍、占 6 秒里 781ms）。


29. **配置界面的每一个格子都必须有消费者；引擎读哪个键只能有一张表**（2026-09-25，⚙ AI 设置页被指出「字段不知道含义」后收口）：
    - **判据是「这一格在这一次有没有用」**，不是「这个字段存在」。所以 `Form`（multipart）出现在 `multipartSlotOf(tpl, slot)` 为真的那一格（上传那格恒真；克隆那格在 `cloneVia:'form'` 时真），**判据不是槽名** —— 早先硬写「只有 upload 有表单」，于是「克隆那格自己发 multipart」这种接法配不出来。发哪部分内容只此一处判据：界面摆 Body 还是表单、`validateTemplate` 查哪一格为空、新建草稿给什么形状、`buildRequest` 真发什么，全读它；**一格的两种形状不会同时发出**（换接法后留在另一格里的旧内容就地失效，不报错也不发半个）。表单为空会被 `validateTemplate` 点名，`产物封装` 整格消失（改成每一格的 `artifactForm`，与固定项「产物」并排），**请求头逐条接口各配一份**（中间版本把整份模板合成过一份 `headers_json`，结果是异步开关头被同步端点也收走一份 —— 同一家不同端点要的头本来就不一样，那一列已删），产物形式不在模板头问（逐格才有意义），llm 也不显示建音色开关（**三问都用不上时整节不显示，不留一个空标题**），参数名一律显示模板声明的 `label`、裸 key 只作 `title`。**界面不写「这套机制怎么运作」的解说句**（2026-09-25 点名删掉「下面该有哪几格接口…都由这几个答案推出来」与页首那段介绍）—— 机制写在 `docs/provider-engine.md`，界面上只留标签与选项。**新增一个通用格子之前，先证明它在每个 category × 每个槽位上都有消费者** —— 证明不了就别加（没有消费者的格子，2026-09-25 一并删掉：槽级 `timeoutMs`、模板级 `headers_json`、`needsSecret2` 那对没有任何调用点的函数）。
    - **`outputs` 分两类，界面上也分两处**：固定项（`requiredOutputsOf(tpl, slot)` 给的名字，写死、只能填路径，`validateTemplate` 要求必填项不能空）与自定义变量（折叠区，只给下游 `${它}` 用，引擎从不读）。反面教材就是产物那五个名字：代码里写的是 `values.audio ?? values.image ?? values.url ?? values.resultUrl ?? values.fileUrl`，界面却让人自己想起名字 —— 填错不报错，只是「产物取不到」，而 `status` 填错更糟：一路算中间态，查到次数上限才失败（几十分钟后才报）。**同一条事实（引擎读哪个键）只允许 `requiredOutputsOf` 这一处**，加新固定项时改它，界面、校验、文档（§九 是生成的）自动跟上。
    - **两条「取到值 ≠ 那件事」的判据**（2026-09-26 接 MiniMax 时才暴露，此前所有上游都不撞这两条）：① `error` / `errorCode` 里 **`0` / `ok` / `success` 按「没有错误」算** —— MiniMax 一类的成功响应是 HTTP 200 + `base_resp:{status_code:0,status_msg:'success'}`，按「取到值就算错」会把每一次成功读成失败（`errorOf` 一处认，模板照常填路径）；② 固定项「音色 ID」**可以不填路径**，判据是这一格自己有没有写 `${voiceId}` —— 上游不回 id 的那种（MiniMax 的 `voice_clone` 成功响应里只有 `base_resp`，名字就是请求里传的 `voice_id`），`runClone` 拿本轮发出去的名字当结果；既不填又不写的仍点名。
    - **开关与它管的东西不能存两份**：`use_clone` / `upload` 两列与「`clone_json` 空不空」是三份真相，于是既要手工同步、又要写校验拦不一致，而 `supports()` 读的仍是槽位 —— 现在开关（`caps_json`）是唯一输入，槽位与固定项都是推导，不一致没有发生的余地。
    - 回归：`node --experimental-strip-types tools/verify-request-engine.mjs`（含「必填固定项没填路径被点名」「自定义变量与参数同名被点名」「开关不需要的槽还留着被点名」「提交没交出任务号就点名」）。


30. **校验报出来的问题，界面上必须能执行掉；同一位置复用的组件不会重挂载**（2026-09-25 接口模板页两处同时中）：
    - 「能力开关不需要这一格，要么改开关要么删掉它」这条报错当时**没法执行** —— 那一格连页签都没有（页签只列推导出的槽），而设计又是「关开关不删内容」，于是用户只能看着一条消不掉的红色报错。现在：改成**关开关时当场弹确认、确定就连格移除**（取消 = 开关不动），页签上不再有 `⚠` 那种自相矛盾的状态。**推广**：写 `validateTemplate` 这类「保存前点名」的规则时，同时回答「用户在界面上怎么消掉它」；答不出来就先补那个入口，别留死循环式的报错。
    - `JsonBox`（Body / Headers / multipart 那三个 JSON 文本框）用 `useState(() => JSON.stringify(value))` 起值，而**切页签不会让它重挂载**（同一位置的同种组件被 React 复用）→ 框里留着上一格的内容，用户一编辑就写进另一格。修法是在外部值变化且与框内文本不等时跟着换（文本还不成形时不动）。**推广**：凡是「本地草稿 + 外部值」双状态的受控组件（文本框、开关组、行编辑器）被放在会切换的位置上复用，都必须处理外部值改变；或者干脆给组件加 `key={身份}` 强制重挂载 —— 二选一，别默认它会重挂载。


31. **「把配音调响」不在混音端做（2026-09-27 查清，别再试第三遍）**：`narration.volume` 的上限就是 1，两条路都堵 —— 预览端 `HTMLAudioElement.volume` 取值域 `[0,1]`；导出端 `@remotion/web-renderer` 不支持 Remotion 的 >1 放大（那功能在 `<Html5Audio>` + `useWebAudioApi` 上，官方文档明写它不支持 web-renderer，`allowAmplificationDuringRender` 自 4.0.279 起废弃）。要真的更响只有两条：**上游合成参数**（能吃 `volume` 的那条端点，如 SpeechSynthesizer 的 `input.volume` 0–100，默认才 50 —— 内置模板已把它声明成默认 100），或**产物落库前离线增益转码**（WebAudio `OfflineAudioContext` 重编 WAV，代价一次解码编码且会削顶）。这条链路上的音量差是**上游给的电平**，不是我们的混音 bug。

## 7. UI 约定（Mapimator Studio 深色对齐，2026-08 全面改版）

- **主题**：stone 深色系（bg #0c0a09 / card #1c1917 / accent #292524 / border 白10%），令牌在 `src/index.css`（HSL 变量，无浅色主题）；字体 Geist（Google Fonts，index.html 引入，fallback system-ui）；品牌蓝 `--brand`（选中/播放头/Toggle）。参考截图目录已删除。
- **布局**：TopBar(h-14：Logo+项目芯片+地名搜索+撤销重做/保存/导出) → 全幅地图舞台（浮动工具条 top-center、左下角 MapStyleChip 底图/高程/3D、元素浮层左侧、设置浮层右侧 overlay）→ 时间线(播放条+轨道)。章节管理在顶栏 ChapterMenu 弹出框（切换/铅笔重命名/复制/删除/新增/章节设置），不再占用底部空间。
- **演示模式（PPT 式全屏播放）**：入口在播放条「演示」按钮与 `F5`，`Esc`/`F5`/HUD ✕ 退出；演示中 `Space` 暂停、`←/→` 步进 1 秒、`Home/End` 回首/尾、**进度条可点/可拖跳转**。实现：`editorStore.presenting` → `App` 隐藏 TopBar/时间线/浮层并 `requestFullscreen(rootRef)`（**地图实例保持挂载，绝不重建**），`PresentationMode.tsx` 负责播控与自动淡出的 HUD。**播到「内容结束帧」为止**（`projectContentEndFrame`），不是时间线那个「至少 60 秒」的长度；演示根节点用 `fixed inset-0`（非 `h-screen`）铺满，全屏被拒时退回窗口内演示。桌面端进全屏要 `setMenuBarVisibility(false)`（`autoHideMenuBar` 在 Windows 全屏时会留一条黑边），退出按 `isMenuBarVisible()` 还原。
- **预览倍速**：`editorStore.playRate`（1–5，默认 1），播放条「1x ▾」芯片选择；**只作用于预览播放头的推进**（`TimelineEditor` 与 `PresentationMode` 两处 rAF 循环都乘 `playRate`），导出仍按原速逐帧渲染。配音 / BGM 与播放头**同一倍速**：`lib/preview-audio.ts` 把每个音频元素的 `playbackRate` 设成 `playRate`（界面最高 5×，Chromium 支持到 16×），seek 只做漂移兜底（>0.3s 才纠一次）；`preservesPitch` 用浏览器默认值 `true`，所以倍速下是**连续且不变调**。
- 顶栏工具是**扁平一键直达**（点击即创建/进入模式），样式差异全部放右侧 Settings 面板切换；**没有下拉工具组**。工具条/时间线上的「图层」按钮开合左侧图层浮层（editorStore.elementsOpen，默认收起）。界面上指 Layer 的地方一律叫「图层」，「元素」只留给单个 element。
- Settings 面板结构：`{X} Settings` 头(✕关闭) → **LABEL**(首字段,同步元素 name) → 类型/样式按钮组(StyleGrid) → SIZE(等比%) → ORIENTATION → 图标颜色 → 时间 → Show Label + LABEL STYLE → **点动画**(开关默认关) → Delete Layer。Section 无边框、大写小标题+白5%分隔线。
- 右侧浮层显示条件：element 模式需有选中元素；keyframe 模式始终显示（editorStore.panelMode 三态）。
- 共享 UI 原子统一从 `components/ui/` 引入，勿再在各面板复制。**新写的界面一律用 shadcn 原子**（`ui/button`、`ui/dialog`、`ui/select`、`ui/popover`、`ui/tabs`、`ui/switch`、`ui/slider`、`ui/progress`、`ui/collapsible`、`ui/radio-group`、`ui/badge`、`ui/input`、`ui/textarea`、`ui/label`、`ui/tooltip`）；旧的 `primitives.tsx` 那批继续用、不强行迁移。shadcn 的浮层（Dialog/Popover/Select/Tooltip）自带 portal，**不要再手写 `createPortal(…, document.body)`**（血泪教训 23 那条的浮层定位交给 Radix）。令牌沿用 `index.css` 现有 HSL（shadcn 需要的 `--popover` / `--card` / `--input` / `--ring` 都在，tailwind 里已把 `popover` 补上映射）。开关用 Toggle（整行可点，滑块用 left 定位勿改 translate）；颜色选择一律用 ColorPicker（色板 = Tailwind 官方表 `lib/tw-colors.ts`，**族顺序跟 docs/colors 页一致**：先 red→rose 彩色再 slate→stone 中性，v4 独有的 taupe/mauve/mist/olive 因项目锁在 3.4 不收；默认只铺**每族 500 那一列** 24 格 + 「展开全色阶」看 22 族 × 11 阶，底部是 `input[type=color]` + **`#RRGGBB` 文本框**（认 `#abc` 缩写，回车/失焦生效，非法就退回原值不吞输入）；不要再写裸 `input[type=color]`，也不要再维护第四份色值表）；枚举选项一律用 OptionBlocks（横向选项块），**不写原生 `<select>`**；需要下拉时用 `ui/select`（Radix，不是原生）。图标上传走 IconUploadButton→UploadIconDialog（统一 64×64 + 命名入 customSymbols），现**仅服务于「移动图标」的 image 样式**（custom_icon 类型已下线）；PIN STYLE 网格由 PinStyleChooser 提供（标记/旗帜共用，Marker(flag) 与点类型面板结构已统一）。
- **供应商配置只在 ⚙ 一处改**，且**实例设置与接口模板是左侧两个独立入口**（不混在同一屏，也不是同一区的页签 —— 日常项与专家项混在一起，结果是没人敢动模板也看不清自己改了什么）。**「接口模板」那一页只在开发构建里露出来**（`IS_DEV = import.meta.env.DEV`，定义在 `lib/backend.ts`：跑 `npm run dev` / `electron:dev` 才有这一行，打包出去的正式包里没有 —— 改错一份模板会让全部调用坏掉）：`ProviderPanel`（文案 / 语音 / 图片三屏）= 实例芯片一排 + `＋实例` + 模板下拉 + **请求方式**（`selectableModesOf`：**模板只有一种接法时整行不显示** —— 没得选还摆一排单选就是假控件；实例存的那一档在模板里没接口时仍然长出来，否则红报错消不掉）+ **接口页签一排**（上传 / 克隆 / 提交 / 查询，只列这条实例真会走到的那几格 `usedSlotsOf`）+ 左栏**激活那一格的参数与试调用**（试调用只收 `trialKeysOf` = 这一格引用了、又**没有别处格子可填**的名字 —— 声明出来的参数一律在上面那张参数表里填，不在试调用里重复一栏；于是画面描述 / 合成文本这些只有一个入口）（真发一次，回显三样：**每一步的响应原文**（普通 JSON 美化后给，二进制只报字节数）→ 取到的字段 → **产物预览**（音频给播放器、图片直接显示，objectURL 随结果收回）；**失败也照这一套** —— 出错那一步的响应原文挂在 `EngineError.step` 上带回来，光有一行人话不够看。`${voiceData}` 是「上传文件」按钮 + 已选文件名与大小）、右栏**实例参数固定显示**（不随页签切走）。**试调用不再有第二排页签**，所以换页签必须 `key={格}` 重挂载它（草稿按参数名存，两格同名参数不是一回事，见 §6.30）；一份模板可以配多条实例（两套账号），调用处显式选一条，**没有 `active` 标记**；`TemplatesPane`（左侧「接口模板」）= 一行一份模板，三栏（模板列表 · 模板头（名字 + **能力开关**：**调用方式 = 同步 / 异步 两个复选框**（存 `caps.modes`，最后一个勾不让掉）/ **建音色 = 克隆开关 + 参考音频三选一**（`caps.cloneVia`：`upload` 先传、交回的引用注入成下一步的 `${voiceData}` / `base64` 文件进 JSON 体 / `form` 克隆那格自己发 multipart））与**由开关推导出的接口槽卡片** · 实例级参数表），**模板页没有「预览请求」也没有试调用**（要真发就得用实例的 Key，看形状也在实例页）；「恢复默认」用 seed 覆盖那一行。**接口槽不能手动加**（没有「＋ 槽」按钮，槽位全由开关推导）；**关开关时当场弹一次确认**：不再被调用的那几格连内容一起移除（取消 = 开关不动）—— 页签上不留 `⚠` 那种「自己进不去、又每次报错」的死结（`validateTemplate` 那条兜底仍在，措辞指向这个操作）。**异步的配对是同一行模板里的 `async.submit` ↔ `async.query` 两个键，不是指针列**，所以没有「查询接口指向自己」这种脏行的可能。**每格的返回项分两处显示**：「引擎要读的」= 固定名只能填路径，「给下一个请求用的变量」= 折叠的自定义区，只供 `${它}`（详见 §6.29）。**请求头逐条接口各配一份**（写在每个槽的 JSON 里，模板级 `headers_json` 那列已删 —— 共用一份等于替同步端点也带上异步开关头），**页签按调用顺序排**（上传 → 克隆 → 提交 → 查询；两套都勾了才在这一排**最左边**给一个「同步 | 异步」切换（OptionBlocks，不是下拉）—— **页签只写动作名，哪一侧由那个切换说明**，所以两份名字不重复。校验消息仍用引擎那份带前缀的全名（`REQ_LABEL`），两侧同时报错才分得清是谁，两侧同时报错才分得清是谁），**小节名旁边一枚 ⓘ，说明收在弹层里 —— 页面上不铺解释性长句**（`JsonBox` / `ParamTable` / `ListField` 都收进 `InfoHint`；「发出去的内容」「要填的参数」这两节的说明按他要求整条删掉，连 ⓘ 也不留），**两层参数表不用颜色分层**（两块各涂一种色 = 看着像两套东西，其实是一套行的两种归属）：小标题 + 一条延伸到右边界的细线，会留在库里的（实例级 / 这一格的）每行装框，每次调用现场给的不装框、整组缩在一道竖线后（`ParamTable variant="framed"|"flush"`）。卡片标题行**不再重复页签上已经写过的格名**，只剩方法下拉与地址。接口卡片内一律按**发出去的顺序**排三小节：**发出去的内容（这一条自己的 headers → body；`multipartSlotOf` 为真的那格换成 multipart 表单）→ 要填的参数（这一格一张表：填了值的走实例，没填的调用时给）→ 从响应里取**（最后一节里**「产物形式」与固定项「产物」并排两行、逐格一份**；查询那一格的「算成功 / 算失败」两个状态值也在这一节里）。**超时也没有槽级那一格**（`RequestDef.timeoutMs` 已删，只有实例级 `timeoutMs` 一份 —— 那格从来没有任何生产者）。
  **配置页的每个控件都必须对得上模板声明的参数**：实例级写回 `values.instance[key]`，每一格的参数写回 `values.requests[<ReqKey>][key]`（那一格没填的由调用点现场给）；**实例表本身没有一个具名列**（早先的 `base_url` / `api_key` / `model` / `voice` / `speed` 全已并进 `values_json`），密钥就是声明成 `valueType:'secret'` 的普通参数。
  **占位符一律 `${name}`**（早先的单花括号 `{name}` 作废）：整串位置保类型、嵌在字符串里插值、**没给值就删键**（父对象被删空连父键一起删）；声明了却没人给 = 当场点名，不发半个请求。调用级参数（`text` / `prompt` / `systemPrompt` / `userPrompt` / 参考音频）由调用点给值，界面输入框从占位符反推，不靠声明。
  参数控件一律按 `valueType` + `options` 走（有候选值 → OptionBlocks；boolean → 开/关；list → 行编辑器；secret → 密码框），**不写原生 `<select>`**；**没有 `file` 这一档** —— 那个文件是**引擎注入的固定名 `${voiceData}`**（与固定返回项 `artifact` 对偶：一个是这一步交进来的文件、一个是那一步交回去的文件 / 地址），值为 `{bytes,mime,name}`：同一个 `${voiceData}` 进 JSON 体换成 `data:<mime>;base64,…`、进 multipart 表单就是那个二进制分片，`${voiceData.mime}` / `.base64` / `.name` 单取；`cloneVia=upload` 时上传交回的引用由引擎注入成同一个名字，**克隆那一格三种接法写的都是 `${voiceData}`**（在参数表里声明它会被点名）。界面自身的文案走 `t('中文','English')`，但**用户自定义的模板名 / 参数 label 一律单个字符串**（自定义内容没有自动翻这回事），**只有 value 进请求体**。
  接口模板页的入参声明只有两处（实例级一张表在右栏，每一格一张表在卡片里）—— **不再有「调用级参数」那张表**：填了值的走实例，没填的由调用点现场给，「这一格要现场给哪些」由 `openKeysOf` 从占位符反推；字段一列一个（名字 / 类型下拉 / 说明 / 默认值 / 候选值 / 范围；**没有「必填」「加工方式」，也没有「文件限制」这三格** —— 声明出来的参数只有「实例里填」与「调用时给」两个来源，取值成形只看 `valueType`）；返回分两处：**固定项**（名字由 `requiredOutputsOf` 写死，只能填路径，必填项空着会被 `validateTemplate` 点名）与**自定义变量**（折叠区，`{ 名字: 相对路径 }`，只供下游 `${它}`，引擎从不读）。
  **看请求形状与发一次真请求都在实例页的「试调用」里**（它同时给求值后的请求与真发结果）；模板页不预览也不发请求，⚙ 里没有第二个入口，也没有独立的「连通性测试」那种按钮。
- 时间显示用秒（`lib/time.ts` / FrameTimeField），内部仍存帧。
- **路线「显示标记」与标记设置走同一套形态约定**：`moveIconStyleOf`（PropertiesPanel）与 `pinStyleOf` 逐条对应 —— **圆点 / 水滴针 归入「图片」类**（是内置图形，不是跳出图片类的独立形态），所以资源网格开头那两格点下去后资源区**不会消失**，只是选中态从圆点换到图片/水滴针；非资源形态（气泡/旗帜/文字/表情）不渲染资源区（`MoveResourcePicker` 自己 return null，调用处不再写 include 列表）。「图标样式」按钮行只列 气泡/旗帜/文字/表情 + 5 个资源形态，**不要**把圆点/水滴针单独提成按钮。
- **路线顶点编辑**：EditableMap 对 line/moving_point/arrow/double_arrow 显示路径点标记（vertex-dot 图层，选中的更大更蓝），mousedown 优先命中顶点（12px）→ 拖拽只更新该点坐标（routePathOf/hitRouteVertex 辅助函数）；路径点坐标也可在属性面板「路径点」中输入/删除。燕尾箭头归入形状类别（categoryOf 特判 arrowType）。
- **属性面板双语**：editorStore.lang（中/EN，顶栏最右切换），标签用 `useT()` 钩子：`t('中文', 'English')`；新增属性标签必须双语。hints 暂仅中文。
- **保存脏标记**：projectStore 用模块级 savedProjectJSON 快照（createProject/loadProject/saveProject/importProjectConfig 时 markProjectSaved），TopBar 经 isProjectDirty(project) 比对，无修改时保存按钮禁用。新增会写 project 的动作无需额外处理。
- ⚠️ **本机 Vite 文件监听不可靠**（改动不触发热更新、旧进程会吐陈旧模块）：vite.config.ts 已开 `server.watch.usePolling`；重启 dev server 时务必确认 5173 旧进程已杀干净（npm 包装进程被杀后 vite 子进程会残留，用 `netstat -ano | grep 5173` 查）。

## 8. 协作约定

- **★ 不为兼容性牺牲设计（用户明确要求，2026-09-11）**：改造 / 重构时**不考虑向后兼容**——不做老存档迁移、不保留旧字段、不写双读分支、不堆 `normalize*` 兜底链、不为旧库加兼容性 `ALTER TABLE`；一律按「设计是否合理」决策，数据结构可以直改，老数据可丢弃或重新生成。若某处确实必须保留兼容，先与用户确认。
- **AI 功能只有桌面端支持**（2026-09-23 拍板）：网页版隐藏 ⚙「设置 · AI」入口与字幕生成里的 AI 生成 / 配音 / 音色区（`IS_DESKTOP` 门禁），只留「字幕文案整篇贴入 / 逐行手写 / 字幕间隔 / 字幕样式」。音频在素材库（网页端是 Dexie Blob 行），所以已生成的配音在网页里照样能试听。
- 与用户**中文交流**，回复精简；改动后提醒刷新（用户浏览器常需 Ctrl+F5 才拿最新包）。
- 用户的真实测试数据在自己浏览器的 IndexedDB（如 test001 项目）；自动化调试 Chrome 的 profile 是隔离的——跨环境验证用「⚙️ 导出配置 json → 放项目根目录 → 脚本导入」的方式（参考 `tools/test-import.mjs`）。
- 导出视频、播放、镜头插值等改动完成后，优先用 `tools/` 脚本做一次带截图的自动化回归。

## 9. 已知待办 / 弱项

- ORIENTATION/点动画/移动点高亮圈等仅在编辑端验证过，导出端 MapScene 未逐项回归。
- docs/ARCHITECTURE.md 已删除；数据库设计见 `docs/db-schema-v2.sql`（唯一事实源）+ `docs/db-tables.md`（速查与字段字典）+ `docs/db-redesign.md`（设计依据）+ README「数据库设计」（简版，已按 V2 重写）。
- **弹窗图片 / 人物照片仍是内联 dataURL**：`OverlayBlock` 的 image/video 与 `person.imageUrl`（含 AI 生成那张 ≈2MB）还在 payload 里；音频那批已收口（见 §10「音频只存 assetId」条）。要做的是同一件事搬到图片上。
- **孤儿素材不清理**：元素/字幕/音乐行删掉后 `asset` 行与磁盘文件都留着（没有反向引用可查，也不做引用计数）。要么定期体检删孤儿，要么给 asset 加引用计数。
- 3D(globe) 下 `pixelsToDegrees` 为墨卡托近似，高纬度箭头宽度略有偏差。
- Region 数据源为世界国家级（英文属性名，内置 ~100 国中英映射）；省级需换 `setRegionSources` 数据源。

## 10. 数据库约定（V2：桌面端已落地，网页端仍为简化实现）

**规模**：27 张表 / 4 视图 / **0 触发器** / 698 列（源 `docs/db-schema-v2.sql`，可用 `node --experimental-sqlite` 直接执行验证）。

- **★ 片长（`project.endFrame`）不入库**（2026-09-19）：`project.end_sec` 列已删——它是纯派生量且**没有任何 UI 能改它**（`setProjectEndFrame` 零调用）。读取端 `getProjectV2` 现按内容实际结束推导：`endFrame = max(60s × fps, 元素/特效/弹窗/机位/字幕/音乐的结束帧)`，与时间线口径一致；空项目从原来的「100 秒幽灵容器」变成 60 秒。新增任何「容器长度」类字段前先问它是不是派生值。
- **★ 时间一律存秒（REAL），帧是派生量不入库**（2026-09-12）：所有时间点与时长都是 `*_sec`（`start_sec` / `end_sec` / `sec` / `duration_sec` / `move_duration_sec` / `default_duration_sec`），存的是**用户在 UI 上输入的原值**；渲染 / 导出时按 `default_fps` 换算为帧。这样改帧率时时长语义不变（存帧会因 fps 变化而失真）。
- **★ 只存输入原值，不存派生 / 换算值**：凡是能从别处算出来的都不入库或存为可空覆盖值 —— 例如字幕时长有配音时随音频（不落库）、无配音时才存估算值，`music_track` 的结束时间同理。典型反面：`FrameTimeField` 曾把「秒」输入换算成帧入库，改 fps 后用户输入就永久丢失了。
- **★ 音频只有 `asset` 一本账（2026-09-24）**：配音 / BGM / 弹窗语音在项目数据里**只有 assetId**（`NarrationEntry.audioId`、`MusicTrack.audioId`、`person.audioId`、`custom.audio.audioId`），字节走 `asset`（`kind='audio'`：桌面落 `userData/media/audio/`、网页存 Dexie Blob）。三条硬规矩：
  ① 库里对应 `audio_asset_id` 是**真外键 SET NULL**，弹窗那条从 `payload_json` 里摘出来单独成列（同一条事实不留第二份，`v_check_dangling` 才查得到）；
  ② 运行时地址一律现取 `getAssetUrl(assetId)`（按 id 缓存 objectURL）—— 预览池按 **id** 存元素、导出前在 `export-video` 里一次水合成 `audioSrc` 传给 Remotion（组件不等异步、不读库）；
  ③ 内置 BGM 在**「选用」那一刻**就把字节复制进素材库，项目里不留站内路径 —— 所以音频只有一种表示，消费点不用判「是 id 还是 URL」。
  代价照 §8 认：老库里内联的 `url` 列直接作废（`RETIRED_COLUMNS` 删列，不写迁移），旧配音重跑一次「全部生成配音」即可。
  **新增素材引用位时改 `lib/asset-refs.ts` 那一处**（导出带字节 / 导入改 id 都读它）—— 以前 `createExport` 只收 point 的 assetId，移动图标、地理贴图与全部音频都静默漏在导出文件外面。
- **时间的两个例外**：① `created_at` / `updated_at` 是 epoch **毫秒**（审计用，非播放时间）；② **离散步长 / 速率类**参数（`frame_step`、`flow_speed`、`trail_length`）UI 就是按「每 N 帧」输入的，**保持帧**。
- **落地范围**：**桌面端已按 V2 落地** —— `electron/db-v2.mjs` 做「多表 ↔ `MapVideoProject`」双向映射，帧↔秒换算就在这一层（写入 `f2s`、读出 `s2f`，fps 取 `globalConfig.defaultFPS`）。运行时（`src`）**仍以帧为基准**（`startFrame` / `endFrame` / `frame`），渲染端 Remotion 也用帧，不要在 store 里再换算一次。网页端（Dexie / localStorage）**仍是整对象存帧值的简化实现**，没有 V2 的多表与秒约定。

- **元素按工具栏聚合为类别宽表**，表内用 `type` 判别列区分子类型，**没有 `element` 基表**。元素通过 `layer_id` 归属**单类型图层**（`layer` 表：标记/路线/形状/疆域/图片），即 **项目 ▸ 图层 ▸ 元素**：

  | 表 | type 取值 | 工具栏 |
  |---|---|---|
  | `element_marker` | point / flag / military_symbol | Pin |
  | `element_route` | line / moving_point | Route |
  | `element_shape` | polygon / arrow / double_arrow / gathering / encirclement | Shape |
  | `element_territory` | territory（势力/地块/事件 JSON 内联） | Terr |
  | `element_image` | geo_image（地理配准贴图，控制点网格 JSON 内联） | Image（图片） |

- **★ 不使用触发器（2026-09-12 起全部移除）**：数据库侧只有表 / 索引 / 视图，**没有触发器**。理由：网页端 Dexie（IndexedDB）没有触发器，数据库侧触发器只在桌面端生效 → 同一规则两套真相；且规则藏在表定义外、与写入端重复。
- **改版的代价 —— 弱引用**：五处 —— `element_image.asset_id`（贴图本体）、`public_element_*.asset_id`（公共库副本）、`element_territory` 的 countries/plots/events JSON 内部引用、`project.active_base_map_id` / `active_elevation_map_id`（父子互引，见 §5 底图条）、**`task.project_id` / `task.entry_id`**（见下），全部由写入端保证。（原先第五处 `provider_endpoint.poll_json.$.statusRole` —— 异步接口指向哪个查询接口的指针 —— 已随「一行一份模板」改版彻底消失：`async.submit` 与 `async.query` 现在是**同一行模板里的两个键**，`provider.tpl_id` 与 `voice.*` 是真外键。配置层其余照旧：模板被实例引用时删不掉、删实例连带删它的音色池（`CASCADE`）与参考音频（`RESTRICT`，失效靠原件重建）、产物 `artifact_id` 是 `SET NULL`。）
  **`task` 那两个引用为什么只能是弱引用（2026-09-24 实测）**：`saveProjectV2` 是「删掉项目那一行 + 连子表整批重写」（`DELETE FROM project` 靠 CASCADE 清子行），而字幕行每次保存都被删了重建 —— 挂成真外键就等于**用户每次自动保存都 CASCADE 掉自己正在跑的任务**（表现：刚点「生成本句配音」建好的行凭空消失，产物没地方放）。任务行是**调度状态、不是项目内容**，所以两列改弱引用：删项目由 `removeProjectV2` 显式清掉它的在途任务，字幕行没了就是「没地方放」，调度器当场跳过。**推广开一条**：凡是「指向 `project` 或某个每次保存都重写的行」的引用，都不能挂 `ON DELETE CASCADE` 真外键，否则保存即删数据。旧库那代的表形状由 `rebuildTaskIfFkBound` 在启动时让位重建（改名 → DDL 建新表 → 按共同列名搬回 → 删归档，回归 [8] 盯着）。
  项目侧 `element_marker.asset_id` / `move_icon_asset_id` / 音频列 / `camera_keyframe.follow_route_element_id` 都是**真外键**（SET NULL），删除素材或路线不需要应用层连带清理；动画关键帧内联在 `keyframes_json`，随元素生灭。曾存在的第三类 `element_route.from/to_element_id`（连接线端点）已随「连接线」整条下线（2026-09-19：无工具入口、坐标解析器从未接上，属不可达代码，却给每条写入路径加上「应用层清理 + 自检视图 + 索引 + 副本重映射」四件套）。数据库侧只留 `v_check_dangling`（悬空引用）、`v_check_territory_ref`（疆域 JSON 内部一致性，`json_each`）、`v_check_async_pairing`（选了异步的实例，它引用的模板行里 `async_json` 有没有 submit + query + successValues）三个**自检视图**——它们不拦截写入，只做体检。**新增跨表引用时必须重复「应用层清理 + 自检视图」这个模式，不要试图用触发器补**（能用真外键就别用弱引用；但先按上一条判断它到底能不能扛住「整项目重写」）。
- **★ 素材登记只有 `asset` 表这一本账（2026-09-19）**：桌面端曾另存一份 `userData/media/index.json` 映射，同一条事实两处真相，而 `asset` 表里的行反而是为过外键造的壳。现在 `assets:save/read/remove/list/exists` 全部读写 `asset` 表（`storage='file'` + `rel_path`）；删素材时项目侧靠 FK SET NULL，**公共库副本的引用要手工清**（`assets:remove` 里的 UPDATE）+ 启动 `repairAssetRefs` 兜底。配置 JSON 导入还原素材走 `putAssetBytes`（桌面落盘 / 网页存 Dexie Blob），**任一素材失败就中止整笔导入**，不再静默留下坏引用。
- **★ 公共图层副本必须自洽（不变量，2026-09-19）**：`public_layer` + 5 张 `public_element_*` 与项目侧同构，但 `asset_id` 是**弱引用**（公共库不属任何项目，建不了外键）。副本引用的素材若已不存在，由启动体检 `repairAssetRefs(db)` 把引用清空（**不再补占位行** —— 造一条 `rel_path=''` 的空壳 asset 只会让素材库多出一排点不开的死条目），元素保留、图不保留；副本元素 id 一律加后缀（`:pb<pubId>` / `:im<layerId>`），因为 `element_id` 是全库主键，不换 id 会让「同一图层导入两次」互相撞车。回归：`node --experimental-strip-types --experimental-sqlite tools/verify-public-layers.mjs`。
- **★ 新增/改动字段的同步清单（漏一步就会设计↔实现漂移）**：

  1. `docs/db-schema-v2.sql`（唯一事实源）改 DDL
  2. `tools/db-field-notes.mjs` 补/改字段中文说明 —— **漏补会直接报错**（生成器强制每列都有说明）
  3. 若新增表：还要改 `tools/gen-db-field-dict.mjs` 的 `GROUPS`（**不归组就直接报错「未归入任何分组」**）、`TABLE_FRONTEND`（非元素表的职责 / 前端入口）、`TOOL_ENTRY`（元素表）
  4. `node --experimental-sqlite tools/gen-db-field-dict.mjs` 重跑，把字段字典注入 `docs/db-tables.md`
  4.5 `node tools/comment-ddl.mjs`：把字段中文说明写成 DDL 行尾 `-- 中文`（SQLite 不存储注释，靠 DDL 自文档；幂等，改完字段说明后重跑）
  5. 手工同步文档中**标记外**的部分：表数 / 列数（`db-tables.md`、`db-redesign.md`、`AGENTS.md` 本节的规模行）、`db-tables.md` 第二节字段归属表与第三节逐表速查、`db-redesign.md` 2.2 实体清单与资源层说明、`docs/db-er-diagram.mmd` E-R 图
  6. 验证（六条全绿才算完）：
     `node --experimental-sqlite tools/gen-db-field-dict.mjs --check`（结构一致 + 说明全覆盖）·
     `node --experimental-sqlite tools/audit-fk-indexes.mjs`（外键索引缺口）·
     `node --experimental-strip-types --experimental-sqlite tools/verify-project-roundtrip.mjs`（**存进去 = 取出来**：输入原值逐字往返、falsy 合法值不被 `||` 吞、帧↔秒互逆、发音修正 JSON）·
     `node --experimental-strip-types --experimental-sqlite tools/verify-public-layers.mjs`（公共图层副本）·
     `node --experimental-sqlite tools/verify-provider-templates.mjs`（**四张配置表 + 三代旧形状让位**：模板/实例逐字往返、真外键拦删、音色唯一键含 target_model、任务读写与错峰查询、异步配对自检视图、让位不删表且把 Key 并进 values.instance、task 换代后行不丢）·
     `node --experimental-strip-types tools/verify-request-engine.mjs`（模板求值 / 出参解码 / 异步轮询 / 重试判据只认 429·5xx，全离线）

- **★ 给用户新增「可自定义」的字段时，回头检查它是否打破了设计稿的既有前提**（2026-09-12 教训两条）：
  - 地形夸张系数可调节、底图可增删改 → 打破了「底图/高程图是代码常量，配置不入库」的前提，2026-09-19 补了 `base_map` / `elevation_map` 两张表（**每项目一份**，内置项在创建项目时作为普通行复制进来，夸张系数直接落在 `elevation_map.exaggeration`）；
  - 自定义图片库 `customImages` 运行时已有 → 设计稿却没有对应表，补了 `custom_image`（后随三表合并并入 `asset`，`kind='image'`）。
  - 判断口诀：**「用户能改」的值就必须能存**，凡是「XX 不入库」这类取舍，都要确认它的前提（配置是否真的固定）仍然成立。

- **能力矩阵三处联动，改一处必须同步另两处**：**只有 `emoji` 不可着色**（表情字符自带颜色）、`model` 不可贴地（位图贴片）——其余 9 种形态都可着色（multiply 染色，白色=原色）。① DDL 的 CHECK（**不要**再给 model/gif 加 `color IS NULL` 约束，2026-09-19 已删）② 属性面板（隐藏不可用控件，见 `getPinCapability`）③ 渲染端（按形态选管线）。
- **外键策略**：保留外键（**不要为性能删外键**，强制检查 ≈1µs/行），但不使用触发器（见上一条）；真瓶颈是子表 FK 列无索引（补索引后 27×）。最大杠杆是事务批处理（63×），保存/导入必须整项目单事务 + WAL。
- **改 DDL 后必跑**：`tools/audit-fk-indexes.mjs`（外键索引审计）、`tools/gen-db-field-dict.mjs`（把字段字典注入 `docs/db-tables.md`，`--check` 只校验）、`tools/db-field-notes.mjs`（698 字段中文说明词表，**新增字段漏补说明会直接报错**）。
- **文档一律 Markdown**（2026-09-11 起）：`docs/` 下不再有 HTML，也不要用脚本生成 HTML；图用 ```mermaid 代码块内嵌（E-R 图源 `docs/db-er-diagram.mmd`），不再预渲染 SVG。

## 11. 标记（Pin）形态扩展的代码落点

point 有 **10 种视觉形态**：`circle/text/pin/bubble/emoji` + `image/gif/model/icon/military_symbol`。资源两来源：`asset_id`（用户上传，外置）与 `builtin_id`（内置、**不入库**）；图标形态用 `icon_lib` + `icon_name`（自建库条目落 `asset`，`kind='icon'`）。

| 文件 | 职责 |
|---|---|
| `lib/builtin-assets.ts` | 内置资源：20 图（内联 SVG）+ 8 动图（程序化）+ 5 模型（程序化简模）；换真实文件只需改常量 |
| `lib/pin-visual.ts` | **能力矩阵 + `defaultVisualFor` 的唯一事实源**（UI/CHECK/渲染三处共用） |
| `lib/icon-library.ts` | lucide 懒加载 → 位图（Vite 自动切 chunk） |
| `lib/assets.ts` | 素材门面：**assetId 随机**（不做内容去重，同文件传两次就是两份），objectURL 缓存；桌面端走 IPC 落盘 + `asset` 表登记、网页端 Dexie Blob |
| `lib/model-renderer.ts` | 3D 模型**离屏渲染**（独立 canvas + GL 上下文）→ ImageData |
| `lib/gif-decoder.ts` / `lib/procedural-anim.ts` | GIF 解码（gifuct-js，含 disposal 合成）/ 内置动图 canvas 绘制 |

**★ Remotion 确定性守则（改这几处务必遵守）**：
1. **three 用离屏渲染 → 位图 → 复用 MapLibre 图片管线**。不要改成「共享 MapLibre WebGL 上下文的 custom layer」——会带来抓帧时序、GL 状态污染、并发竞争三类风险。
2. **不用 `requestAnimationFrame`、不用 `clock/delta`**：GIF 与模型姿态都由 `frame`（经 `setRenderFps` 注入 fps 基准）决定，同一 frame 永远同一张图。
3. **异步资源必须预加载**：上传的模型在 `MapScene` 用 `delayRender` + `preloadModelAssets` 预加载，否则乱序渲染时某帧会空白。
4. **three 必须动态 import**（`await import('./model-renderer')`），否则 625KB 进主包。
5. **坑**：lucide-react 的 `icons` 导出是**组件表**而非 IconNode（`icons.MapPin` 是组件对象），转位图要 `renderToStaticMarkup(createElement(Comp, {color, strokeWidth, size}))`。
