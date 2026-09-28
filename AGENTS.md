# AGENTS.md — MapVideo 项目上下文（AI 助手必读）

> 本文件是**当前事实的唯一权威**，也是每个会话都要吃进上下文的文件 —— 写在这里的每一句都必须是「现在如此」或「改的时候必须如此」。
> 沿革、对照、验收流水不写（那些是 git log / chat 的职责）；可照抄的具体值一律由生成链产出并配 `--check`（见 §3）。

## 1. 项目是什么

**MapVideo**：基于 Remotion + MapLibre GL 的「地图视频」生成框架。用户在浏览器编辑器里用军事态势符号（箭头/包围圈/集结点）、路线动画、区域高亮、相机关键帧、弹出元素等制作地图讲解视频（项目 = 单条连续时间线），并可在浏览器内直接导出 MP4。

## 2. 技术栈与关键版本

| 项 | 值 | 备注 |
|---|---|---|
| React / TS / Vite | 18 / 5.6 / 6 | 入口 `src/main.tsx`，StrictMode 开启 |
| remotion | 4.0.515 | 预览用编辑器自身，导出用 `@remotion/web-renderer`（纯浏览器 MP4） |
| **maplibre-gl** | **5.24** | globe 投影、WebGL2；v5 的行为差异都记在 §6（`isStyleLoaded`、`getStyle()` 代价） |
| turf / dexie / zustand / milsymbol | 7 / 4 / 5 / 3 | 空间计算 / IndexedDB / 状态 / APP-6 符号 |

## 3. 常用命令

```bash
npm run dev            # http://localhost:5173/map-video/ （vite base=/map-video/）
npm run build          # tsc -b && vite build（网页 Lite 产物）
npm run build:desktop  # 桌面产物（相对路径 base=./）
npm run electron:dev   # 桌面开发：vite 热更 + Electron 窗口（日志写 logs/dev-vite.log · dev-electron.log）
npm run dist:win       # 打 Windows 包 → release/
```

- **`release/`**：`MapVideo Setup <v>.exe`（NSIS 安装版）与 `MapVideo <v>.exe`（Portable）功能相同，留一份即可；`latest.yml` / `*.blockmap` 供 electron-updater 差分更新；`win-unpacked/` 是中间产物，可删。
- **5173 不一定属于本项目**：本机别的项目（如 `D:\frontend\cs101` 的 vitepress）也可能占它，而 `scripts/dev-desktop.mjs` 把 5173 写死两处（探活 + `ELECTRON_RENDERER_URL`）—— 撞车时它会「探活成功」却把窗口指到别的项目。别去 kill 别人的进程，改手动两步：`npx vite --port 5178 --strictPort` + `ELECTRON_RENDERER_URL=http://localhost:5178/map-video/ ELECTRON_ENABLE_LOGGING=1 node_modules/electron/dist/electron.exe . --remote-debugging-port=9223`。
- 无测试框架。回归验证靠 `npx tsc -b` + `npm run build` + `tools/*.mjs`（浏览器自动化需本机 Chrome 带 `--remote-debugging-port`，桌面端用 `MV_CDP=9223`）。
- `tools/` 只留**跑得动、还会再跑**的东西，读文件头注释即可用，四类：
  ① **文档生成链**（改了源头就必须重跑，`--check` 只校验不写入）：
     `db-field-notes.mjs`（字段中文说明词表，漏一条直接报错）→ `gen-db-field-dict.mjs`（注入 `docs/db-tables.md`）→ `comment-ddl.mjs`（把说明写成 DDL 行尾注释）；
     `gen-template-json-doc.mjs`（把 `src/lib/template-seed.ts` 展开成 `docs/provider-engine.md` §九）；
     `gen-template-init-sql.mjs`（同一份 seed 导出成 `docs/provider-template-init.sql`：全新库的初始化脚本，也是「界面里改乱了想退回内置那一版」的一条命令）。**seed 仍是运行时唯一来源**，那份 SQL 是它的导出。
  ② **离线回归**（不联网、秒级）：`verify-project-roundtrip` / `verify-public-layers` / `verify-provider-templates` / `verify-request-engine` / `audit-fk-indexes` / `verify-path-interpolation`（逐帧路径插值与 `turf.along` 逐字同值）。
  ③ **浏览器自动化**：`smoke-desktop` / `smoke-backend` / `test-fx` / `test-overlays` / `test-timeline` / `test-import` / `verify-render-gate`（逐帧门禁：该跳的还在显示、该动的还在动）；公共助手 `pw-page.mjs`（复用标签页）。
  ④ **会花配额 / 改数据**：`try-real-calls.mjs`（真发上游，也会在账号下留资源）/ `bench-preview.mjs`（性能基线，采样存 `tools/.bench/`）/ `bench-attribution.mjs`（把自耗时归因到我们的函数）/ `stress-project.mjs`（建几百元素的 `__perf-stress` 场景）。
  **一次性验证脚本用完就删**，别留在目录里当考古。

## 4. 目录结构（src/）

```
components/
  EditableMap.tsx      # 编辑态地图画布：绘制/拖拽/选中/相机插值/悬停光标（最复杂的文件）
  Toolbar.tsx          # TopBar(Logo/项目芯片/搜索/撤销重做/保存/导出/字幕生成) + FloatingTools(地图上方工具条，每个工具弹窗底部一行「图层」选择器)
  MapStyleChip.tsx     # 左下角底图芯片：弹出 底图/高程/3D投影 面板
  ChapterMenu.tsx      # 顶栏章节弹出菜单
  ShortcutsDialog.tsx  # 快捷键速查弹窗（改键盘绑定必须同步这里）
  MapSearchBox.tsx     # 地名/坐标搜索（地图实例经 lib/shared-map.ts 共享）
  FxPanelBody.tsx      # 特效面板：天气/画面/弹窗/音乐 四页签（字幕不在这里，见 GenerateDialog）
  ImageGenerateField.tsx # 「描述 → 一张图」输入区（只有人物弹窗的照片区在用）
  HotFixField.tsx      # 发音修正：词→读音、原文→换成，两组行编辑器
  ProviderPanel.tsx    # ⚙ AI 的「实例设置」页（含试调用）
  TemplatesPane.tsx    # ⚙ 左侧「接口模板」页（一行一份模板；这一页不预览、不发请求）
  SettingsDialog.tsx   # ⚙ 外壳：左文案/语音/图片，右嵌 ProviderPanel
  VoiceField.tsx       # 音色选择器（字幕生成与 ⚙ 提交那一格共用）：内置表按 group 分组 + 克隆音色 + 试听
  GenerateDialog.tsx   # 字幕生成：文案 / 逐行字幕 / 配音 / 间隔 / 样式（也是字幕条目与样式的唯一编辑处）
  TimelineEditor.tsx   # 播放条 + 镜头流块 + 元素轨道
  KeyframePanel.tsx    # 右侧「视角属性」
  PropertiesPanel.tsx  # 右侧 Settings 面板（Pin/Route/Shape/Image 四类）
  ElementsPanel.tsx    # 左侧图层浮层：搜索/显隐/导入/统计
  PresentationMode.tsx # 演示模式（全屏播放，地图实例保持挂载、绝不重建）
  App.tsx              # 布局：TopBar + 全幅地图舞台 + 时间线（舞台盒子带 isolate，见 §6.23）
  ui/                  # primitives.tsx（本项目自研）+ shadcn 原子；新界面优先用 shadcn 那批
compositions/          # Remotion 导出端：MapVideo / MapScene / OverlayRenderer
lib/
  map-renderer.ts      # ★ 核心：所有地图元素的渲染
  keyframe-interpolation.ts  # 相机插值（frame=到达时间 + moveDuration=起飞提前量）
  military-*.ts        # 军标几何（燕尾/钳形/进攻/集结地）
  regions.ts / geojson.ts / gpx.ts / export-video.ts / time.ts / easing-labels.ts / utils.ts
  layers.ts            # ★ resolveTargetLayerId（归属解析唯一处）/ editableIdSet 要用它
  asset-refs.ts        # ★ 项目里所有素材引用位的唯一清单（导出带字节、导入改 id 都读它）
  request-engine.ts    # ★ 接口模板求值：三层取值 / `${x}` 与删键级联 / requiredOutputsOf / validateTemplate / retriable；不碰网络不碰 DOM
  template-seed.ts     # 内置接口模板 seed（六份，一行一份完整模板）
  providers.ts         # 调用薄壳：callLLM/callTTS/callImage/cloneVoice → 全走引擎，没有协议分支
  audition.ts          # 全应用**一路**声音（playAudition / stopAudition，播新的必先停旧的）
  audio-gain.ts        # 配音 >100% 的本地增益（narrationGain / bakeGain / mixGain + 手写 WAV 编码，见 §6.31）
  preview-audio.ts     # 预览侧音频混流与倍速
  backend.ts           # IS_DESKTOP / IS_DEV 与 window.mapvideo.* 类型门面
  i18n.ts              # 界面文案类型 L = string | {zh,en}（只有 value 进请求体）
  tw-colors.ts         # Tailwind 官方色板（ColorPicker 的唯一取色来源）
  voices.ts            # 只剩内置的克隆参考样本清单（public/voices/*.mp3）；音色表是模板候选值，不在这里
stores/
  projectStore.ts      # 项目数据操作 + 撤销重做 + 持久化
  editorStore.ts       # 播放头 / 选中元素 / currentCamera / 门禁 selectedLayerId / 弹窗开合
  interactionStore.ts  # 绘制模式 + pendingPlace
  providerStore.ts     # 模板与实例两张表；current(category) 给调用处选实例（激活记 picked，不入库）
  voiceStore.ts        # 克隆音色账本（voice 表）：命中唯一键就复用
  taskStore.ts         # 在途异步任务的调度器（状态在 task 表，跨重启续跑）
types/index.ts         # 全部数据模型（改数据结构先看这里）
```

## 5. 领域模型

- **项目 = 单条连续时间线**：`startFrame` 恒 0、`endFrame` 是派生量（不入库，见 §10）；`elements/camera/overlays/fx/narration/music` 全用**项目绝对帧**；底图/高程/投影是项目自己的数据（`base_map` / `elevation_map` 行）。
- **★ 图层（Layer）是元素的唯一归属：项目 ▸ 图层 ▸ 元素**。图层单类型（marker / route / shape / territory / 图片），带自己的显隐与区间；`project.elements` 是 `deriveElements(layers)` 算出的**派生镜像**（store 的 patch 自动重算），**不要直接写它** —— 改元素一律经 `updateElement` / 图层 API，否则丢归属。`layerTypeOf(element.type)` 决定它进哪个图层。删图层连带删其元素。
- **★ 图层顺序 = 地图叠放顺序**（列表靠前在上层）：新建图层一律经 `insertLayerSorted()` 按 `LAYER_RANK`（标记 0 → 路线 1 → 形状 2 → 疆域 3 → 图片 4）插入；用户拖动后以拖动结果为准。MapLibre 只认 `addLayer` 先后，所以 `renderElements` 之后要调 **`restackByLayerOrder(map, ids)`**（**编辑端与导出端都要调**）：它按倒序自底向上排，同图层元素保持组内序，故「移动标记在其线之上」「疆域标签在其面之上」不会被打破；签名未变时直接返回。
- **★ 选中图层 = 地图上的「可编辑层」**：`editorStore.selectedLayerId` 非空时只有该层可编辑，为 null 时全部可编辑。门禁由 **`editableIdSet(project, selectedLayerId)`** 一处给出，插在 `pickElement`（命中不可编辑者要继续往下找，否则上层会吃掉点击）、`hitRouteVertex`、顶点 feats、`routeEdit` 失效判定。
  - `selectElement` **不清** `selectedLayerId`（清了门禁自毁）；代价是 Del 优先级 = 有选中元素先删元素，否则删整层。
  - 写入收口：`projectStore.patch()` 每次写回后把「选中元素的宿主层」同步为可编辑层；新建/导入后调 `focusHostOf(id)`。图层行点选用 `focusLayer`（只改门禁），图层块/行用 `selectLayer(id, type)`（两者都改）。
  - **必须对「图层已不存在」自愈**：找不到该层时返回 `null`（= 全部可编辑），返回空集等于整张地图静默只读。换项目调 `resetSelection()`（选中态存的是项目内 id）。
- **编辑辅助图层不得进命中区**：`getAllElementLayers` 只认 id 含 `-layer-`/`-label-` 的图层。**新增辅助图层时必须同时加进这张排除表**。
- **★ 归属解析只有一处：`resolveTargetLayerId(layers, type, targets, explicitId)`** = 显式指定 → 该类型的「写入目标」→ 该类第一个图层 → 调用方新建。「写入目标」记在 `editorStore.targetLayers`（会话内、不入库），入口是**每个工具弹窗底部那一行「图层」**；`updateElement` 在 `changes.type` 跨类别时自动迁移图层 —— 单类型图层的不变量靠这两处守住，**新增任何改 `type` 的路径都必须走 `updateElement`**。
- **MapElement** 判别联合：point（9 种形态：shape=circle/pin/bubble/emoji/text + image/gif/model/icon，可带 iconUrl）、line（straight/bezier/arc + label + routeEffect + flowSpeed）、moving_point、polygon（poly/rect/circle）、arrow（7 种）、double_arrow、encirclement、gathering、flag、military_symbol、territory。custom_icon 与 Image 工具已下线，旧数据在 load 时退化为 point。
- **CameraKeyframe**：`frame` = **到达时间**（绝对帧），`moveDuration` = 飞行时长（默认 2×fps）；语义 = 停留 → 飞行 → 落位。
- **LabelConfig**：text/color/position/bgColor(默认透明)/bgPadding/bgRadius/fontWeight；渲染走 canvas 气泡位图，只有 BUBBLE 样式带尾巴，TEXT 强制 center。
- **★ 字幕 / 配音只在「字幕生成」里编辑**（`FxTab` 没有 `'subtitle'`）。两处入口都走 `editorStore.subtitleOpen`（`Toolbar.tsx` 挂载同一个弹窗实例）。
  - **弹窗 = 四段可折叠区 + 行列表**（`Fold`，开合记在 `editorStore.dialogSections`，键带 `subtitle:` 前缀 —— 一个弹窗一个命名空间，会话内记住、不入库）：① 需求（右下角「🤖 生成文案」）；② 字幕文案（整篇草稿，与行列表是**同一份内容的两种看法**：没动过草稿就跟着行列表 join，动过即锁定，直到点「按行应用」）；③ 配音音色（折叠标题带当前音色名）；④ 字幕样式（标题带「楷体 · 40 号 · 距底 2%」这类摘要，每项都有 `StyleRow` 标签）。没有参考资料、也没有 SRT 导入导出。
  - **行列表**：一行 = 一条字幕 + 一段配音。左边**只有序号**（出场时间是顺排算出的派生值，不占列）；右边依次是状态徽标、这一行的停顿芯片、🔊/🔁 生成或覆盖配音、▶ 试听、✕ 删除。下面一排：＋加一行、▶▶ 全部生成配音（串行、只补没配音的行）、整片字幕间隔（0–5 秒滑块）、配音音量（滑块 0–300%）。
  - **停顿存两处**：整片默认值 `narration.gap_sec`（新项目 1 秒），每行可覆盖 `narration_entry.gap_sec` —— **留空 = 跟整片，0 是「这一行不停」的有效值**，两态必须分得开；顺排函数 `resequenceRows(rows, gapSec, fps)` 改了就立刻重排未锁定的行。
  - **音量只有整片一层**（`narration.volume`，0–3）：生效点在**两处必须同时改**（§6.7）—— 预览 `preview-audio.desiredAt` 与导出 `MapVideo.NarrationAudio`；>1 走 `lib/audio-gain.ts`（见 §6.31）。
  - **状态徽标必须逐行摆**（`RowStatus`）：未配音 / 排队中 / 合成中 / 配音时长 / 失败（原因原样进 `title`，不翻译）—— 批量 30 行时顶部汇总数字看不出哪行卡住。`SubRow.error` 与 `NarrationEntry.error` 一起落库。
  - **试听全应用只有一路声音**（`lib/audition.ts`）：逐行试听、音色区试听、时间线预览不各响各的；再点同一条 = 停止；开始播放与弹窗卸载时 `stopAudition()`。
  - 行输入框**含换行即按行拆成多条**（整篇一次贴入的入口；首句留在原行以保住它已有的配音）；`LineInput` 按 `scrollHeight` 自增高，**要把边框那 2px 算进去**。
  - 打开即载入项目现有字幕继续编辑；「应用字幕与配音」只写 `setNarrationEntries`（字幕比片长久时补 `setProjectEndFrame`），**不动元素 / 弹窗 / 特效 / 相机**。
- **配音音色**（`VoiceField`，受控 `{inst, slot, spec, value, onPick}`）：
  - 界面上给人看的永远是**是谁**（`voiceLabelOf`：表里查到 = 「女声 · 龙安风悦」，账本查到 = 「男声·克隆」，都不是才退回那串 id）—— 折叠标题与组件内那一行共用它，别各自拼。
  - 上段 = 这一份模板声明的**音色表**，按候选值 `group` 分组（男声 / 女声 / 上游给了才长出的中性；空组不显示），**默认折叠**（一组 19 个色块，默认展开会把字幕区挤走）。**表就是数据**：`template-seed.ts` 里「音色 ID」那条参数的 `options`（`{value,label,group,note,models}`），铺进库后是普通可编辑行 —— 代码里没有音色表，也没有按模板 id 分支的函数。名字必须逐字对官方。
  - 下段「克隆音色」= 内置样本格（`public/voices/male.mp3`/`female.mp3`）+ ⬆ 上传其它音色；没克隆过时是虚线，点它 = 先克隆再选中。
  - **音色与它绑的模型记在实例的「提交」那一格**（`values.requests[<submit>].voice` / `.model`）：字幕生成与 ⚙ 改的是同一处，所以「下次打开还是这个音色」不需要第二本账。克隆出的 id 只在克隆时那条模型上有效（拿系统音色喂 `-vc` 模型上游回 `InvalidParameter`），所以选音色时把它带的模型一起写进**同一格**。内置格与克隆格遵守同一条规则：内置格自己带 `models[0]`，点它把模型一起换回去。
  - **当前模型把整张内置表过滤空时不给手填框**，而是显示「当前模型只吃克隆出来的音色」+ 一枚「换回内置音色」；手填框只在**表本身是空的**（自建模板没填）时出现。
  - 同一个组件也长在 ⚙ 的「提交」那一格（`ParamSpec.voiceTable` 为真 → `ParamControl` 渲染它）；⚙ 里不开试听（真发的正确入口是「试调用」）。
  - 克隆账本 = **`voice` 表**（`useVoiceStore`，唯一键 `(provider_id, source_hash, target_model)`），参考音频原件存 `asset`，失效靠它重建；不在 localStorage 记第二份。
- **发音修正（项目级）**：`HotFixField`，在「配音音色」下面的折叠区（默认折叠，标题带条数），存 `project.narration.hotFix` → `narration.hot_fix_json`。存的形状**就是上游 `hot_fix` 那一份**（一条 = 单键对象），调用时零转换；空 = 整键消失。**这一格显示与否由 `referencesArg(模板, 那一格, 'hotFix')` 当场判**：请求体里没写 `${hotFix}` 就**整段不显示**（填了也不会发出去的东西不该占一屏）。上游形状备查：`input.hot_fix = {pronunciation:[{词:音}], replace:[{原:换}]}`。
- **时间线配音块只能整体平移**：`beginBlockDrag` 的 kind 有 `'narration'`，只挂 `onPointerDown(mode:'move')`、**不给 `DragHandles`**；拖动写 `setNarrationEntries` 且置 `locked: true`。时长始终由音频/字数决定。
- **背景音乐**：`project.music: MusicTrack[]` 是**单轨多段**（绝对帧，段内可循环），默认第一段铺满全片；内置曲目在「选用」那一刻就把字节复制进素材库，项目里不留站内路径。
- **弹窗（overlay）**：新建默认 `position: 'center'`（`POS_BASE.center = [0,0]`）。**人物卡只有一种版式**（`PersonContent` = 照片 + 姓名 + 简介 + 一句台词）：样式预设、「显示照片」开关（照片有没有就是 `imageUrl` 空不空）、照片方位、职务/身份、整卡语音都已下线 —— **界面上没有格子的字段就不该留在数据里**。引用卡（`type:'quote'`）是另一类弹窗。
- **坐标一律 5 位小数**（`toFixed(5)` + `step=0.00001`），视角缩放 1 位小数。
- **合集（Collection）**：`合集 ▸ 项目 ▸ 元素`。`id='default'` 的默认合集不可改名、不可删除（名字 = `DEFAULT_COLLECTION_NAME`）；新建/未指定归属时落默认合集；删合集只把项目移回默认合集，**不删项目**。

## 6. 血泪教训（改代码前必读，全部踩过）

1. **别用 `isStyleLoaded()` 做相机 / 事件 effect 的门禁**：v5 在字形瓦片未就绪时频繁返回 false，会吞掉离散跳帧的相机更新与首次事件注册。相机 effect 只判 `mapRef.current`（`jumpTo` 包 try/catch）；地图事件在 `map.on('load')` 里**一次性注册**，回调经 `handlersRef.current` 取最新。
2. **元素类型切换（id 不变）会残留旧图层**：`renderElements` 维护 id→type 签名表，签名变化先整体重建；新增渲染分支要纳入该机制。
3. **MapLibre 重名 layer 会自动加数字后缀**：从 layerId 反解元素 id 必须用「已知元素 id 前缀匹配」（`elementIdFromLayerId`），截断会失败。
4. **细线难选中**：线元素要有透明热区层 `line-hit-{id}`（line-width ≥ 12、opacity 0）。
5. **默认值**：moveDuration = 2s；label.bgColor 透明；仅 BUBBLE 带尾巴；TEXT 强制 center；缩放/尺寸走 `scale`，不要再加固定像素字段。
6. **自动保存 = 停止编辑 5s 后静默落盘**，四条硬规矩：① 排程前先 `isProjectDirty()` 判脏（否则 `saveProject` 造新引用 → effect 重跑变成每 5 秒无限写库）；② 回项目列表前要 `void saveProject()` 补存（应用内导航不触发 beforeunload）；③ 导出视频**不落盘**；④ `saveProject` 在 `await` 之后**只在当前项目仍是那份快照时回填**（`if (get().project !== project) return;`）—— 无条件回填会把旧项目塞回状态，表现成「点『项目列表』没反应」，还会回滚这几秒的编辑。
7. **双端一致**：改渲染 / 相机 / 音频逻辑必须同时检查编辑端 `EditableMap`、预览端 `preview-audio` 与导出端 `compositions/MapScene`（导出端相机要传 fps）。
8. **PowerShell 内联 `node -e` 处理中文/复杂引号会碎**：批量改文件一律写一次性脚本用 fs + utf8（用完即删）。
9. **pincer（钳形）与 double_arrow**：预览与最终必须同用 `buildDoubleArrow`，不要用 `buildArrowGeometry` 的 pincer 分支做预览。
10. **地图事件 vs 播放循环**：`map.on('move')` 会 60fps 触发 `setCurrentCamera` → 全订阅组件重渲染，属预期；不要在 move 回调里做重活。
11. **镜头插值 effect 的依赖必须是 `project.camera`（数组引用）而非 `project`**：任何元素属性修改都会重建 project 对象，依赖 `project` 会把用户手动平移的地图每次编辑都拽回关键帧。
12. **Windows + Node 22 不能直接 spawn `.cmd`/`.bat`**（CVE-2024-27980 → EINVAL）：必须 `shell: true` 或走真实 exe 路径（`scripts/dev-desktop.mjs` 用 `require('electron')` 拿到的路径）。
13. **本机安全删除守卫会拦批量删除 >50 项**（典型：删 vite 依赖缓存）：规避方式是 **mv 挪走而非删除**（`node_modules\.vite` → `.vite.bak.%RANDOM%`）。
14. **全局宿主组件必须在所有布局分支挂载**：`<ConfirmHost />` 只挂编辑器分支时，项目列表页里的 `await confirm(...)` 会永久挂起（弹窗不渲染 → Promise 既不 resolve 也不 reject），表现成「点删除没反应」且无任何报错。
15. **异步资源位图首次就绪必须触发一次重渲染**：只调 `triggerRepaint()` 不改 `icon-image`，表现为「点两次才显示」。新增异步资源管线时必须在**首次 addImage 分支**调 `notifyVisualReady`（不是 `updateImage`），否则要么死循环重渲染、要么继续点两次才显示。
16. **zustand 的 selector 绝不能返回新引用**（`s.project?.xxx || []`、`.filter()`、`.map()` 每次都新）：`useSyncExternalStore` 判定快照已变 → 无限重渲染。selector 只返回原值，空值兜底放组件外用模块级常量。
17. **Tailwind 的定位工具互斥**：`relative fixed inset-0` 同时挂上时 `relative` 赢（CSS 源码顺序决定，与书写顺序无关），`inset-0` 失效、高度塌成 0。条件切换要把基类一起换掉。
18. **渲染位图的「已生成」缓存不能放模块级**：地图实例随换项目重建，`map.hasImage()` 全空而模块级 `Map` 仍记着「生成过了」→ 新地图永远等不到 addImage。一律以 `map.hasImage(imageId)` 为准；若用 per-map 缓存，记得在 `clearRenderCaches()` 里清。
19. **「动画 = 路线移动」必须顺带打开「显示标记」**：那个沿路线走的标记就是主体；`showIcon ?? true` 会把显式 false 留着 → 选了动画什么都不动。规则是**选 move 就强制 true**（反向在「显示标记」开关里：打开时若无动画补 move）。
20. **`renderLine` 的 `noAnim` 只表示「没被显式要求动画的形状线」**：形状线默认整条一次画完，判据是 `shapeCategory ∈ {multi,special}` **且 `animEffect` 为空**；用户显式选了动画，就别拿「它是形状线」当理由忽略起止帧。这类「按默认语义压制用户输入」的门禁都要给显式值让路。
21. **批量改文件时读也要 `newline=''`**：只在写的时候加是漏的 —— universal-newlines 会把 `\r` 和 `\r\n` 都吞成 `\n`，单 `\r` 的行会让 git 把整个 blob 判成 `-text`，blame / review 全废。改完用 `git ls-files --eol <file>` 确认。
22. **TTS 的「端点 ↔ 模型名 ↔ 音色」三者必须成套**（上游 400 `Model not exist` 的成因）：`long*` 属 CosyVoice、`Cherry` 那套属 Qwen-TTS、ElevenLabs 是另一族，且带 `_v3` 的名字不与 v2 通用 → **UI 里不给自由输入，只给官方表抄来的候选值**。现在这些差异全是 `provider_template` 里的数据，代码里没有协议分支（§6.24）。实测到的形状：`SpeechSynthesizer` 回 JSON、音频在 `output.audio.url`（时效链接，必须当场下载入库）；系统音色不与 `-vc` 克隆模型互换（`InvalidParameter`）；`qwen-voice-enrollment` 只吃 base64 且 `target_model` 必须是 `-vc` 那族。
23. **弹层的「层」有两个独立陷阱**：
    - 宿主带 `overflow-y-auto` 时**不能用 `absolute` 浮层**（会被裁掉，表现为「点了没反应」）。共享原子一律用 shadcn/Radix（自带 portal + `position:fixed`）；自己写的浮层要按触发块与视口算位置（下方放不下就翻到上方），面板脱离 `wrapRef` 所以点击外关闭必须同时放过它，滚动/改尺寸要**重新定位**而不是关闭。
    - **舞台内的 `zIndex` 会漏到模态窗之上**：`FxPreviewLayer` 的字幕 z-60 曾盖住 z-50 的字幕生成弹窗。修法是给 `App.tsx` 那个 absolute 舞台加 `isolate`，把地图/字幕/弹窗卡片/屏幕特效压成一个层叠上下文（组内相对顺序不变）。以后新增「舞台内高 z-index 的预览层」不必再单独跟模态窗比大小。
24. **枚举白名单不要写进 DDL，接口形状也不要写进 switch**：`CHECK (protocol IN (五项))` 是第四份真相，加一家就漏一处（新行插库报 `CHECK constraint failed`）。而 `providerStore.dbSync()` 只 `console.warn`，渲染端读的是内存态 —— 于是**当场全好、重启即丢**。现在的做法：category/role/caps 一律不加 CHECK，取值由 TS 联合类型 + 保存前 `validateTemplate()` 管；接新供应商 = 加一行模板数据，不改表、不加 switch、不改代码。
    旧库形状漂移靠启动体检让位：**认正标志**（不能认「缺了新列」—— 补列那步会先把新列名塞进旧表，把漂移盖住）；让位是**改名不删**（用户的模板改动与 Key 都是资产）→ 建新表 → 渲染端把旧具名列并进 `values.instance`。**改名前要临时 `PRAGMA foreign_keys = OFF`**（外键条款跟着这个开关走，开着改父表名会让子表永远指向 `…__stale` 死表），且命名索引要先 DROP（否则新表的 `CREATE INDEX IF NOT EXISTS` 被静默跳过，丢唯一约束）。**`dropRetiredColumns` 必须排在 `db.exec(ddl)` 之后**（DROP COLUMN 会重校验依赖该表的视图，让位那一刻视图指着不存在的表）。**删列前先问「这一列有没有别人没有的值」**：`headers_json` 那代把认证头存在模板级，直接删列 = 下次真调用全 401 且不报错。
    推广：**凡是「用户能改、又推不出来」的值才入库；同一条事实只允许一处真相**（宁可多一张表，也不要多处 if）。
25. **`map.getStyle()` 是整份 style 的深序列化，不是「读个列表」**（实测每次数百图层 ~1ms）：不要在 per-element 循环里读它 —— 一半元素不可见时就是每帧 170 次，帧时从 150ms 顶到 300ms。要么整帧读一次共用（`styleLayerIds(map)`），要么先比签名再干活。拿 `style.layers.length` 当探针同样是白花一次序列化。
26. **往地图推 GeoJSON 只有一个出口：`putGeoJSON`**，不变量是「签名 == 这个 source 现在装的内容」。任何绕过它直接 `src.setData()` 的写手都会打断它（表现为「拖到一半取消，图形不回位」—— 渲染器以为内容没变，把恢复性写入跳掉了）。**新增写手必须一起走**。
27. **逐帧几何只算一次，三条契约一起成立才成立**：
    - **缓存一律按「数据身份」不按 id**（WeakMap，键 = 折线数组 / 元素对象）。这依赖项目数据不可变：每次编辑都换引用，所以「同一引用」= 「输入没变」。**任何人原地改元素字段都会让缓存读到旧几何** —— 一律经 store 换对象。
    - **`isFrameStatic` 是「整帧跳过渲染器」的唯一判据，默认不跳**：只有确认渲染器对该元素既不读 `frame` 也不读相机才返回 true。**新增任何逐帧或逐相机的分支，必须同时让它判 false**，否则画面停在最后一次真跑的那帧且不报错。让缓存整体失效靠 `renderElements` 的 `renderEpoch` 形参（编辑端传 `styleTick`），导出端恒 0（它的 map 只在 `map.on('load')` 里赋值，不存在样式没就绪时 addImage 静默失败）。
    - **`putGeoJSON` 先比对象引用再比签名**（缓存生效后交回的是同一份，省掉整树 `JSON.stringify`）。
    回归：`verify-path-interpolation`（缓存版与 `turf.along` **逐字同值**，不是「误差够小」）、`verify-render-gate`（含「被跳过的静态点仍在显示」与「gif/模型/透明度/沿线图标必须继续动」）。
28. **测性能别拿 fps 当有效性护栏**：`fps >= 30` 会让**越重的场景越被判成脏数据**，而那正是要测的场景。看特征不看快慢：中位帧时 ≈1001ms 且 `idleShare` 七八十 = rAF 被钉在 1Hz（窗口最小化 / 没带 `MV_BENCH=1`）；`idleShare` 为 0 = 主线程真忙。同一轮改动**同条件连跑两遍**（本机噪声 ±50ms），归因要用 `bench-attribution`（自耗时 top 全是压缩名，看不出谁在调 turf/maplibre）。
29. **配置界面的每一个格子都必须有消费者；引擎读哪个键只能有一张表**：
    - **判据是「这一格在这次有没有用」**，不是「这个字段存在」。multipart 表单只在 `multipartSlotOf(tpl, slot)` 为真时出现（判据不是槽名）；一格的两种形状不会同时发出（换接法后留在另一格的旧内容就地失效）。**加新格子前先证明它在每个 category × 每个槽位都有消费者**，证明不了就别加。
    - **`outputs` 分两类**：固定项（`requiredOutputsOf` 给的名字，界面只能填路径、`validateTemplate` 要求必填项不许留空）与自定义变量（折叠区，只给下游 `${它}`，引擎从不读）。名字代码里写死、只此一处，界面/校验/文档都读它（§九 是生成的）。
    - **两条「取到值 ≠ 那件事」的判据**：① `error`/`errorCode` 里 `0`/`ok`/`success` 按「没有错误」算（否则每一次成功都被读成失败）；② 固定项「音色 ID」可以不填路径，判据是这一格自己写没写 `${voiceId}`（上游不回 id 的那种，`runClone` 拿本轮发出去的名字当结果）。
    - **开关与它管的东西不能存两份**：能力开关 `caps_json` 是唯一输入，接口槽、固定项、校验项全是推导 —— 不一致没有发生的余地。
    - 回归：`verify-request-engine`（含「必填固定项没填路径被点名」「自定义变量与参数同名被点名」「开关不需要的槽还留着被点名」「提交没交任务号被点名」）。
30. **校验报出来的问题，界面上必须能执行掉；同一位置复用的组件不会重挂载**：
    - 写 `validateTemplate` 这类「保存前点名」的规则时，同时回答「用户在界面上怎么消掉它」；答不出来就先补那个入口。已发生的例子：关开关后残留的接口槽连页签都没有 → 现在改成**关开关时当场弹确认、确定就连格移除**（取消 = 开关不动）。
    - 「本地草稿 + 外部值」双状态的组件（`JsonBox`、开关组、行编辑器）放在会切换的位置上复用时，必须在外部值变化且与框内文本不等时跟着换，或者给 `key={身份}` 强制重挂载 —— 二选一，别默认它会重挂载（曾表现为切页签后编辑写进了另一格）。
31. **配音「比 100% 更响」只能自己烘进字节**：两条路都堵 —— 预览端 `HTMLAudioElement.volume` 取值域 [0,1]；导出端 `@remotion/web-renderer` 不支持 Remotion 的 >1 放大（`allowAmplificationDuringRender` 自 4.0.279 起废弃）。所以 `narration.volume` 存 **0–3**，>1 那份走 `lib/audio-gain.ts`：预览挂 `GainNode`（`el.volume` 恒 1），导出在 `hydrateAudioSrc` 里 `OfflineAudioContext` 增益后重编码 WAV 再交给 `<Audio>`（≤1 时根本不跑）。**改音量不需要重跑配音。** 另一半真相是上游给的电平：有的端点有 `input.volume`（0–100，默认只有 50），要更响就在自己的模板里声明这条参数。

## 7. UI 约定

- **主题**：stone 深色（bg #0c0a09 / card #1c1917 / accent #292524 / border 白 10%），令牌在 `src/index.css`（HSL 变量，无浅色主题）；字体 Geist。品牌蓝 `--brand` 用于选中 / 播放头 / Toggle。
- **布局**：TopBar(h-14) → 全幅地图舞台（浮动工具条 top-center、左下底图芯片、左侧图层浮层、右侧属性浮层）→ 时间线。章节管理在顶栏弹出菜单。**演示模式**：播放条「演示」/`F5` 进，`Esc` 出；`presenting` 时隐藏一切浮层并 `requestFullscreen(rootRef)`，**地图实例保持挂载、绝不重建**（桌面端要 `setMenuBarVisibility(false)`，退出按 `isMenuBarVisible()` 还原）。播到 `projectContentEndFrame` 为止，不是时间线长度。
- **预览倍速** `editorStore.playRate`（1–5）**只作用于预览播放头**（两处 rAF 循环都乘它），导出仍按原速。配音/BGM 与播放头同一倍速（`preview-audio` 设 `playbackRate`，seek 只做漂移兜底），`preservesPitch` 用浏览器默认 → 倍速下连续且不变调。
- 顶栏工具**扁平一键直达**，样式差异全在右侧 Settings 面板；**没有下拉工具组**。界面上指 Layer 的地方一律叫「图层」，「元素」只留给单个 element。
- **属性面板双语**：`editorStore.lang`（zh / en，顶栏最右切换），标签一律走 `useT()` 的 `t('中文', 'English')` —— **新增界面标签必须双语**（控件下方那行提示小字目前是中文单语）。用户自定义的模板名 / 参数 label 是单个字符串，不参与翻译。
- **shadcn 原子可追加**：配置见根目录 `components.json`，`npx shadcn add <名字>`；`ui/` 里已有 button/input/textarea/label/select/dialog/popover/tooltip/tabs/switch/slider/progress/badge/collapsible/radio-group/card。
- ⚠ **本机 Vite 文件监听不可靠**（改动不热更、旧进程会吐陈旧模块）：`vite.config.ts` 已开 `server.watch.usePolling`；重启 dev server 要确认旧进程已杀干净（`netstat -ano | grep 5173` —— npm 包装进程被杀后 vite 子进程会残留）。
- Settings 面板结构：头(✕) → LABEL（同步 element name）→ 类型/样式按钮组 → SIZE(等比%) → ORIENTATION → 颜色 → 时间 → Show Label + LABEL STYLE → 点动画（默认关）→ Delete Layer。Section 无边框、小标题 + 白 5% 分隔线。
- 右侧浮层：element 模式需有选中元素；keyframe 模式始终显示（`panelMode` 三态）。
- **原子统一从 `components/ui/` 引入**：新界面一律用 shadcn 原子，旧面板沿用 `primitives.tsx`、别为用而用。shadcn 浮层自带 portal，**不要再手写 `createPortal(…, document.body)`**（§6.23 那条的定位交给 Radix）。开关用 Toggle（整行可点，滑块用 left 定位勿改 translate）；颜色一律 ColorPicker（色板 = `lib/tw-colors.ts`，默认只铺每族 500 那一列 + 「展开全色阶」，底部是 `input[type=color]` 与 `#RRGGBB` 文本框；不要再维护第四份色值表）；枚举一律 OptionBlocks，**不写原生 `<select>`**（需要下拉时用 `ui/select`）。
- **供应商配置只在 ⚙ 一处改**，且**实例设置与接口模板是左侧两个独立入口**（日常项与专家项混在一屏的结果是没人敢动模板也看不清自己改了什么）。**「接口模板」那一页只在开发构建露出来**（`IS_DEV = import.meta.env.DEV`，定义在 `lib/backend.ts`）—— 改错一份模板会让全部调用坏掉。
  - 实例设置页 = 实例芯片一排（**激活那条带品牌蓝点 + 「使用中」**，只靠边框深浅看不出用的是哪条；点一下即换，`picked` 记在本地、重启还在）+ `＋实例` + 模板下拉 + **请求方式**（`selectableModesOf`：**模板只有一种接法时整行不显示** —— 没得选还摆一排单选就是假控件）+ **接口页签**（上传 → 克隆 → 提交 → 查询，只列这条实例真会走到的 `usedSlotsOf`）+ 左栏**激活那一格的参数与试调用**、右栏**实例参数**（不随页签切走）。
  - **试调用只收 `trialKeysOf`** = 这一格引用了、又没有别处格子可填的名字（声明出来的参数在上方参数表里填，同一名字不摆两处）。它同时给求值后的请求与真发结果，失败也照这一套：出错那步的响应原文挂在 `EngineError.step` 上带回来。换页签必须 `key={格}` 重挂载（草稿按参数名存，两格同名参数不是一回事，§6.30）。
  - 模板页 = 一行一份模板（模板列表 · 能力开关与推导出的接口槽卡片 · 实例级参数表），**没有「恢复默认」以外的写路径**；「恢复默认」用 seed 覆盖那一行，「补内置模板」只铺库里没有的那几份 —— **seed 改动不会推给已存在的行**，界面看到旧格子就是库里那一行还带着它。
  - **请求头逐条接口各配一份**（写在每个槽的 JSON 里；模板级共用一份等于替同步端点也带上异步开关头）。**产物形式也逐格一份**，与固定项「产物」并排在「从响应里取」那一节。
  - 接口卡片内按**发出去的顺序**排三小节：**发出去的内容 → 要填的参数 → 从响应里取**。小节名旁一枚 ⓘ，说明收在弹层里 —— **界面上不铺「这套机制怎么运作」的解说句**（机制写在 `docs/provider-engine.md`，界面只留标签与选项）。两层参数表不用颜色分层（会留在库里的每行装框，每次调用现场给的不装框、缩在一道竖线后）。
  - 配置页的**每个控件都必须对得上模板声明的参数**：实例级写 `values.instance[key]`，每格写 `values.requests[<ReqKey>][key]`；实例表本身没有具名列（`baseUrl`/密钥/模型/尺寸全是参数，密钥 = `valueType:'secret'` 的普通参数）。**占位符一律 `${name}`**：整串位置保类型、嵌在字符串里插值、没给值就删键（父键被删空一起删）；声明了却没人给 = 当场点名。控件按 `valueType` + `options` 走（候选值 → OptionBlocks，boolean → 开关，list → 行编辑器，secret → 密码框）。**没有 `file` 这一档** —— 那个文件是引擎注入的固定名 `${voiceData}`（值为 `{bytes,mime,name}`；进 JSON 体换 dataURI，进 multipart 是分片，`.mime`/`.base64`/`.name` 可单取）。
  - 界面文案走 `t('中文','English')`，但**用户自定义的模板名 / 参数 label 是单个字符串**（自定义内容没有自动翻这回事）。

## 8. 协作约定

- **★ 不为兼容性牺牲设计**（用户明确要求）：重构时不考虑向后兼容 —— 不做老存档迁移、不保留旧字段、不写双读分支、不加兼容性 `ALTER TABLE`、不建 `normalize*` 兜底链。按「设计是否合理」决策，数据结构可直改，旧数据可丢弃或重生成。确实必须保留兼容时，先确认。
- **AI 功能只有桌面端支持**：网页版隐藏 ⚙ 入口与字幕生成里的 AI 生成 / 配音 / 音色区（`IS_DESKTOP` 门禁），只留「整篇贴入 / 逐行手写 / 间隔 / 样式」。已生成的配音在网页里照样能试听（素材库有字节）。
- 与用户**中文交流**，回复精简；改动后提醒刷新（常需 Ctrl+F5）。
- 用户的真实测试数据在自己浏览器的 IndexedDB；自动化调试用的 Chrome profile 是隔离的 —— 跨环境验证走「⚙ 导出配置 json → 项目根 → 脚本导入」（`tools/test-import.mjs`）。
- 导出视频、播放、镜头插值等改动完成后，用 `tools/` 脚本做一次带截图的自动化回归。
- 一次性验证脚本与临时产物用完就删；`tools/.tmp-real/` 是这类产物的去处（已 gitignore）。

## 9. 已知待办 / 弱项

- ORIENTATION / 点动画 / 移动点高亮圈等只在编辑端逐项验证过，导出端 `MapScene` 未逐条回归。
- **弹窗图片 / 人物照片仍是内联 dataURL**：`OverlayBlock` 的 image/video 与 `person.imageUrl`（含 AI 生成那张 ≈2MB）还在 payload 里；音频那批已收口（§10）。要做的是同一件事搬到图片上。
- **孤儿素材不清理**：行删掉后 `asset` 行与磁盘文件都留着（没有反向引用可查，也不做引用计数）。要么定期体检删孤儿，要么给 asset 加引用计数。
- 3D(globe) 下 `pixelsToDegrees` 为墨卡托近似，高纬度箭头宽度略有偏差。
- Region 数据源是世界国家级（英文属性名 + 内置中英映射）；省级需换 `setRegionSources` 数据源。
- 真机 MP4 导出（`@remotion/web-renderer` 全片渲染）这一轮没跑过回归。

## 10. 数据库约定

规模数字不写在这里 —— 表/列数以 `docs/db-tables.md` 里生成器写出的那一行为准（`gen-db-field-dict` 每次重算）。事实源是 `docs/db-schema-v2.sql`。

- **★ 时间一律存秒（REAL），帧是派生量不入库**：所有时间点/时长都是 `*_sec`，存**用户在界面上输入的原值**，渲染时按 `default_fps` 换算。这样改帧率时时长语义不失真。**只存输入原值**：凡能从别处算出来的都不入库（片长 `project.endFrame` 由 `getProjectV2` 按内容推导，字幕时长有配音时随音频）—— 新增任何「容器长度」类字段前先问它是不是派生值。反面教材：`FrameTimeField` 曾把「秒」换算成帧入库，改 fps 后用户输入永久丢失。
- **★ 音频只有 `asset` 一本账**：配音 / BGM / 弹窗语音在项目数据里**只有 assetId**，字节走 `asset`（`kind='audio'`：桌面落 `userData/media/audio/`，网页存 Dexie Blob）。三条硬规矩：① 库里 `audio_asset_id` 是**真外键 SET NULL**，弹窗那条从 `payload_json` 摘出来单独成列；② 运行时地址一律现取 `getAssetUrl(assetId)`（按 id 缓存 objectURL），预览按 id 存、导出前一次水合成 `audioSrc` 交给 Remotion（组件不等异步）；③ 内置 BGM 在**选用的那一刻**复制进素材库，项目里不留站内路径 —— 所以音频只有一种表示，消费点不用判「是 id 还是 URL」。**新增素材引用位时只改 `lib/asset-refs.ts`**（导出带字节 / 导入改 id 都读它；漏在那里 = 素材静默留在文件外面）。
- **时间的两个例外**：`created_at`/`updated_at` 是 epoch 毫秒（审计）；**离散步长/速率类**参数（`frame_step`、`flow_speed`、`trail_length`）UI 就按「每 N 帧」输入，保持帧。
- **元素按工具栏聚合为类别宽表**（`element_marker` / `element_route` / `element_shape` / `element_territory` / `element_image`），表内用 `type` 判别子类型，**没有 `element` 基表**；元素经 `layer_id` 归属单类型图层。
- **★ 不使用触发器**：网页端 Dexie 没有触发器，触发器只在桌面端生效 = 同一条规则两套真相，且规则藏在表定义外。跨表一致性由写入端 + 自检视图（`v_check_dangling` / `v_check_territory_ref` / `v_check_async_pairing`，都不拦截写入，只做体检）。**新增跨表引用时重复「应用层清理 + 自检视图」这个模式，不要试图用触发器补。**
- **弱引用只用在扛不住「整项目重写」的地方**：`saveProjectV2` 是「删掉项目行 + 连子表整批重写」，字幕行每次保存都被删了重建 —— 挂成真外键等于**用户每次自动保存都 CASCADE 掉正在跑的任务**。所以 `task.project_id`/`entry_id` 是弱引用，删项目由 `removeProjectV2` 显式清在途任务。**推广**：凡是「指向 `project` 或某个每次保存都重写的行」的引用，都不能挂 `ON DELETE CASCADE`。其余（`element_marker.asset_id`、`camera_keyframe.follow_route_element_id` 等）能挂真外键就挂（SET NULL）。
- **五处弱引用清单**：`element_image.asset_id`、`public_element_*.asset_id`、`element_territory` 的 JSON 内部引用、`project.active_*_map_id`（父子互引）、`task.{project_id,entry_id}`。
- **★ 素材登记只有 `asset` 表这一本账**：`assets:save/read/remove/list/exists` 全读写 `asset`（`storage='file'` + `rel_path`）。删素材时项目侧靠 FK SET NULL，**公共库副本的引用要手工清** + 启动 `repairAssetRefs` 兜底（引用了已删素材就清空引用、**不补占位行**）。配置 JSON 导入走 `putAssetBytes`，**任一素材失败就中止整笔导入**。
- **★ 公共图层副本必须自洽**：`public_layer` + 5 张 `public_element_*` 与项目侧同构，但 `asset_id` 是弱引用。副本元素 id 一律加后缀（`:pb<pubId>` / `:im<layerId>`）—— `element_id` 是全库主键，不换 id 会让「同一图层导入两次」互相撞车。回归 `verify-public-layers`。
- **底图 / 高程图每项目一份**：创建项目时从内置目录**复制成行**，之后各项目各改各的；`active_*_map_id` 是弱引用。地形夸张存 `elevation_map.exaggeration`（**0 是合法值，读取端一律 `??` / `== null`**）。推论：用户删掉的内置底图**不再自动补回**（`stripRemovedBaseMaps` 只清已下线 id）—— 要推新内置底图得单独做，别塞回 load 路径。
- **能力矩阵三处联动**（改一处必须同步另两处）：DDL 的 CHECK · 属性面板（隐藏不可用控件）· 渲染端管线。**只有 `emoji` 不可着色、`model` 不可贴地**，其余 9 种形态都可 multiply 染色。唯一事实源 `lib/pin-visual.ts`。
- **外键策略**：保留外键（强制检查 ≈1µs/行，真瓶颈是子表 FK 列无索引 —— 补索引后 27×）；最大杠杆是事务批处理（63×），保存/导入必须整项目单事务 + WAL。
- **★ 新增/改动字段的同步清单**（漏一步就会设计↔实现漂移）：
  1. `docs/db-schema-v2.sql` 改 DDL（唯一事实源）
  2. `tools/db-field-notes.mjs` 补字段中文说明（**漏补直接报错**）
  3. 新增表还要改 `gen-db-field-dict.mjs` 的 `GROUPS` / `TABLE_FRONTEND` / `TOOL_ENTRY`（不归组就报错）
  4. `node --experimental-sqlite tools/gen-db-field-dict.mjs` 注入 `docs/db-tables.md`；`node tools/comment-ddl.mjs` 写 DDL 行尾注释（SQLite 不存注释，靠自文档，幂等）
  5. 手工同步**生成标记外**的部分：表数列数、`db-tables.md` 第二节归属表、`db-redesign.md` 实体清单、`db-er-diagram.mmd`
  6. 六条全绿才算完：`gen-db-field-dict --check` · `audit-fk-indexes` · `verify-project-roundtrip` · `verify-public-layers` · `verify-provider-templates` · `verify-request-engine`（配置层四张表那批另有 `gen-template-json-doc --check` 与 `gen-template-init-sql --check`）
  - 判据口诀：**「用户能改」的值就必须能存**；凡是「XX 不入库」这类取舍，都要确认它的前提仍成立（底图/高程曾经不入库是因为它是常量，现在它可编辑了）。
- **网页端（Dexie）仍是简化实现**：整对象存帧值，没有 V2 的多表与秒约定；帧↔秒换算只在 `electron/db-v2.mjs` 这一层（`f2s` / `s2f`，fps 取 `globalConfig.defaultFPS`），运行时与 Remotion 都以帧为准，不要在 store 里再换算一次。
- **文档一律 Markdown**：`docs/` 下不要 HTML；图用 ```mermaid 内嵌（E-R 图源 `docs/db-er-diagram.mmd`）。

## 11. 标记（Pin）形态扩展的代码落点

point 有 **10 种视觉形态**：`circle/text/pin/bubble/emoji` + `image/gif/model/icon/military_symbol`。资源两来源：`asset_id`（用户上传）与 `builtin_id`（内置、**不入库**）；图标形态用 `icon_lib` + `icon_name`（自建库条目落 `asset`，`kind='icon'`）。

| 文件 | 职责 |
|---|---|
| `lib/builtin-assets.ts` | 内置资源：20 图（内联 SVG）+ 8 动图 + 5 模型（程序化）；换真实文件只需改常量 |
| `lib/pin-visual.ts` | **能力矩阵 + `defaultVisualFor` 的唯一事实源**（UI / CHECK / 渲染三处共用） |
| `lib/icon-library.ts` | lucide 懒加载 → 位图 |
| `lib/assets.ts` | 素材门面：assetId 随机（不做内容去重），objectURL 缓存；桌面走 IPC 落盘 + `asset` 表，网页存 Dexie Blob |
| `lib/model-renderer.ts` / `lib/gif-decoder.ts` / `lib/procedural-anim.ts` | 3D 离屏渲染 / GIF 解码（gifuct-js）/ 内置动图绘制 |

**★ Remotion 确定性守则（改这几处务必遵守）**：
1. **three 用离屏渲染 → 位图 → 复用 MapLibre 图片管线**。不要改成共享 MapLibre WebGL 上下文的 custom layer（抓帧时序、GL 状态污染、并发竞争三类风险）。
2. **不用 `requestAnimationFrame`、不用 `clock`/`delta`**：GIF 与模型姿态由 `frame`（经 `setRenderFps` 注入 fps）决定，同一 frame 永远同一张图。
3. **异步资源必须预加载**：上传的模型在 `MapScene` 用 `delayRender` + `preloadModelAssets`，否则乱序渲染时某帧空白。
4. **three 必须动态 import**（否则 625KB 进主包）。
5. **坑**：lucide-react 的 `icons` 导出是**组件表**而非 IconNode，转位图要 `renderToStaticMarkup(createElement(Comp, {color, strokeWidth, size}))`。

**路线标记的形态约定**：`moveIconStyleOf`（PropertiesPanel）与 `pinStyleOf` 逐条对应 —— **圆点 / 水滴针归入「图片」类**（是内置图形，不是跳出图片类的形态），所以资源网格开头那两格点下去后资源区**不会消失**；非资源形态（气泡/旗帜/文字/表情）不渲染资源区（`MoveResourcePicker` 自己 return null）。「图标样式」按钮行只列 气泡/旗帜/文字/表情 + 5 个资源形态，**不要**把圆点/水滴针单独提成按钮。

**路线顶点编辑**：line/moving_point/arrow/double_arrow 显示路径点标记（`routePathOf` / `hitRouteVertex`），mousedown 优先命中顶点（12px）→ 拖拽只更新该点坐标；顶点也可在属性面板「路径点」里输入/删除。燕尾箭头归入形状类别（`categoryOf` 特判 `arrowType`）。
