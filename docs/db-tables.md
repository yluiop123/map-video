# MapVideo V2 表清单速查

> 14 张表、3 个视图、**不使用触发器** —— 元素表按工具栏分为 4 张类别宽表，从「整个项目塞进一列 JSON」到「规范化关系表」的逐表对照。

- **数据源**：`docs/db-schema-v2.sql`（唯一事实源，DDL 已实测可执行）
- **设计依据**：`docs/db-redesign.md`
- **规模**：14 张表 · 4 张元素类别宽表 · 3 个视图 · 0 个触发器 · 365 列（外键全部有索引）

**目录**

- 一、14 张表的构成与分流规则
- 二、字段归属：TS 类型 → 数据库表
- 三、14 张表逐表速查（按 9 组）
- 四、每张表的字段（字段字典）
- 五、工具栏与元素类型
- 六、容易混淆的 5 组
- 七、一次「打开」与一次「保存」
- 附：3 个视图，以及为什么没有触发器

## 一、14 张表的构成与分流规则

**14 张表不是 23 个新概念**，而是同一个项目数据按「字段从哪来、怎么用」拆开的结果。整体按下面四条规则分流：

| 规则 | 判据 | 处理方式 | 落到的表 |
|---|---|---|---|
| **P1** 必列化 | 身份、时间、引用关系 —— 需要检索、排序、约束 | 提升为独立列 | `element_marker` / `element_route` / `element_shape` / `element_territory` 的公共列、`chapter` 的公共列 |
| **P2** 独立成表 | 自身有 id 或顺序语义，需被单独寻址或约束 | 1:N 子表 | `narration_entry` |
| **P3** 留下 JSON | 固定形状、整体读写、不参与约束与检索的配置块 | JSON 列 + `json_valid()` | `display_json`、`countries_json` / `plots_json` / `events_json` 等 |
| **P4** 外置存储 | 大体积二进制（图片、音频、视频、字体） | 独立 `asset` 表，业务表只留 `asset_id` | `asset` |

#### 一句话理解 14 张表的构成

- **4 张**是「元素」，按**工具栏按钮**聚合：标记 · 路线 · 形状 · 疆域**各一张宽表**，表内用 `type` 判别列区分该工具下的全部子类型（详见第三节、第五节）；动画关键帧也内联在各表的 `keyframes_json` 列；
- **7 张**是「章节的子集合」：章节里能放的东西，除去元素之外都在这里（镜头关键帧、弹窗、特效、字幕、配乐…）；
- **1 张**是「素材库」：`asset`（自定义图标 / 图片 / GIF / 模型 / 音频等二进制，`kind` 区分，按「项目 / 类型 / 时间戳」落盘）；
- **3 张**是「弹窗内容块」；
- **4 张**是合集、项目本体、项目配置与应用配置。

## 二、字段归属：TS 类型 → 数据库表

下表左边是代码里的数据模型（`src/types/index.ts`），右边是它落到哪张表 —— 理解这套设计最直接的入口。

| TS 类型（src/types/index.ts） | 落到表 | 处理方式与理由 |
|---|---|---|
| （合集层级） | `collection` + `project.collection_id` | 项目之上的一层分组（合集 ▸ 项目 ▸ 章节 ▸ 元素）；未指定归属时落默认合集 `default` |
| `MapVideoProject.id / name / description / createdAt / updatedAt` | `project` | P1 列化 |
| `globalConfig`（defaultDuration / defaultFPS / defaultResolution / defaultEasing） | `project` 的配置列（`default_duration_sec` / `default_fps` / `resolution_w` / `resolution_h` / `default_easing`） | P1 列化：配置并入项目本体（原 1:1 `project_config` 表已取消） |
| `globalConfig.projection` | `project` 的 `projection` 列 | P1 列化：地图投影是项目自身的属性（渲染方式），随项目走，不属于「默认值类」配置 |
| `activeBaseMapId` / `activeElevationMapId` | `project.active_base_map_id` / `active_elevation_map_id` | **不入库**：配置是代码内置常量，项目只存选中的 id 字符串 |
| `elevationMaps[].exaggeration`（面板滑动条可调） | `project.elevation_exaggeration` | 对当前生效高程图的**覆盖值**（0–50，默认 1.5）；配置本身不入库，但这一项用户可改，所以必须落库 |
| `customSymbols[]` / `customImages[]`（图标库 / 图片库登记） | `asset`（`kind='icon'` / `kind='image'`） | **三表已合并**：两者都只是项目收录的一个素材行，二进制走 P4 外置 |
| `chapters[]` | `chapter` | P1 |
| `chapters[].elements[]` | `element_marker` / `element_route` / `element_shape` / `element_territory`（4 张类别宽表） | P1 公共字段 + 表内 `type` 判别子类型（取消基表） |
| `elements[].style` / `drawProgress` / `morphKeyframes`（关键帧数组） | 4 张类别表的 `keyframes_json`（P3 内联） | 运行时元素对象本就内联关键帧；同 property 同时刻由应用层去重 |
| `elements[].label`（`LabelConfig`） | 各元素表的 `label_json` 列 | P3 内联：1:1 且可选，跟随元素整体读写 |
| `chapters[].camera[]` | `camera_keyframe` | P2；`followRoute.routeElementId` 变成外键（删路线 → 退化为固定视角） |
| `chapters[].overlays[]` | `overlay` | P2：本体一张；custom / person 的内容块内联在 `payload_json`（原两张中间表已删除） |
| `chapters[].fx[]`（`ScreenFxItem`） | `screen_fx` | P2：屏幕空间特效窗口，与地图元素区分 |
| `chapters[].narration`（`NarrationTrack`） | `narration` + `narration_entry` | P2：档（样式/1:1）+ 条目（1:N） |
| `music[]`（项目级） | `music_track` | P2；音频本体走 `asset` |
| `territory` 元素内的 `countries / plots / events` | `element_territory` 的 `countries_json` / `plots_json` / `events_json` | P3 内联：疆域自包含、整体读写；代价是失去复合外键，由 `v_check_territory_ref` 视图兜底 |
| （二进制素材） | `asset` | P4 外置存储：图片 / 音频 / 视频 / 字体统一入表，业务表只留 `asset_id` |
| `providers` | `provider` | 独立聚合；「每 kind 至多一条 active」由部分唯一索引保证 |

> 注：底图 / 高程图**不入库** —— 它们是代码内置的常量配置，项目与章节只保存所选配置的 id 字符串（`project.active_base_map_id` / `chapter.base_map_id`）。
> **例外**：「地形夸张系数」用户在面板可调（0–50，默认 1.5），是对当前生效高程图的覆盖值，因此落在 `project.elevation_exaggeration`（为空则用内置默认）。

## 三、14 张表逐表速查（按 9 组）

读法：**表名** · 一句话职责 · 主键 · 删除行为。

### 组 1 · 合集与项目（含配置） 2 张

| 表 | 职责 | 主键 | 关键点 | 前端对应 |
|---|---|---|---|---|
| `collection` | 项目之上的一层分组（合集 ▸ 项目 ▸ 章节 ▸ 元素） | `collection_id` | 默认合集恒为 `default`：**不可改名、不可删除**；删其它合集时其下项目回落默认合集（**不删项目**） | 项目列表页左栏合集列表（`ProjectManager.tsx`） |
| `project` | 项目本体：身份 + 归属 + 审计字段 + 地图投影 + 当前生效的底图与高程图 | `project_id` | `collection_id` 指回所属合集（默认 `default`）；`active_base_map_id` 有意不建索引（恒 1 行，扫描成本是常数） | 项目卡片（`ProjectManager.tsx`）；运行时即 `projectStore.project` |

### 组 2 · 资源与素材 1 张

| 表 | 职责 | 主键 | 删除行为 | 前端对应 |
|---|---|---|---|---|
| `asset` | 唯一素材存储（图片 / GIF / 模型 / 音频 / 字体 / 用户图标，`kind` 区分），按「项目 / 类型 / 时间戳」落盘（随机 `assetId`，不做内容寻址去重） | `asset_id` | 随项目 **CASCADE**；孤儿回收是待办项（需定期清理或引用计数） | 属性面板上传行（`ResourceUploadRow`）、标记面板自定义图片网格（`CustomImageGrid`）、字幕/配乐音频上传（`lib/assets.ts`） |

### 组 3 · 章节与时间轴 6 张

一个 `Chapter` 对象里的 6 类子集合，逐类一张表。

| 表 | 内容 | 主键 | 关键字段 / 行为 | 前端对应 |
|---|---|---|---|---|
| `chapter` | `Chapter` 本体 | `chapter_id` | 起止时间（`start_sec` / `end_sec`，秒） | 顶部章节页签 + 时间轴章节条（`TimelineEditor.tsx`）；底图/高程/3D 在底图芯片（`MapStyleChip.tsx`） |
| `camera_keyframe` | `camera[]` | `kf_id` | `frame` 是**到达时间**，`move_duration` 是起飞提前量；`follow_route_element_id` 删路线后 `SET NULL`（退化为固定视角） | 「视角」面板（`KeyframePanel.tsx` / `CameraEditor.tsx`） |
| `screen_fx` | `fx[]` | `fx_id` | 屏幕空间特效窗口（天气/画面），与地图元素分离 | 「特效」面板（`FxPanelBody.tsx`）+ 时间轴特效轨道 |
| `narration` | `narration` 的样式部分 | `chapter_id` | 1:1，主键即外键 | 「字幕」面板（`FxPanelBody.tsx`） |
| `narration_entry` | `narration.entries[]` | `entry_id` | 一条字幕 = 一行；音频走 `asset` | 时间轴「🎙 配音」轨道 + 字幕面板（TTS / 导入 SRT） |
| `music_track` | `music[]`（项目级） | `track_id` | 项目单轨多段（项目绝对时间）；音频走 `asset` | 时间轴「音乐」轨道 + 音乐面板（内置/导入） |

### 组 4 · 标记类元素 1 张 Pin 工具

工具条「标记」按钮的产出：一键在当前地图中心放置。三种标记形态（点 / 旗标 / 军标）**合并进同一张宽表**，用 `type` 判别列区分；公共字段（章节、时间轴、层级、可见性、标签、移动图标）每行都有。
属性面板：`PropertiesPanel.tsx` 标记设置区（9 种视觉形态 + 资源选择 + 标签）。

| 表 | type 取值 | 主键 | 工具入口 | 存什么 |
|---|---|---|---|---|
| `element_marker` | `point` | `element_id` | Pin 工具（一键放置） | 经纬度、**9 种形态**（圆点/文字/水滴针/气泡/表情 ＋ 图片/GIF/模型/图标库）、缩放、朝向、贴地旋转、资源引用（asset_id / builtin_id / icon_lib+icon_name） |
| `element_marker` | `flag` | `element_id` | 标记面板切到 Marker（原地改类型） | 位置、旗面文案（flag_text）、配色、字号、宽度 |
| `element_marker` | `military_symbol` | `element_id` | **当前无入口**（导入 / 旧数据） | 军标 SIDC、位置、旋转、梯队、附加文字 |

### 组 5 · 路线类元素 1 张 Route 工具

「路线」按钮的产出：进入绘制模式采点成线。线型（直线/贝塞尔/大圆弧）与路线特效都在右侧 Settings 里切换，不新增表。移动点与连接线也并入本表。
属性面板：`PropertiesPanel.tsx` 路线设置区（均匀移动 / 逐点到达时间 / 动画起止 / 显示标记）。

| 表 | type 取值 | 主键 | 工具入口 | 存什么 |
|---|---|---|---|---|
| `element_route` | `line` | `element_id` | Route 工具；Shape 下菜单里的直线/曲线/带箭头/战线/行军箭头也写这张表 | 路径数组（coords_json）、线型、线宽虚线、路线特效、流动速度、无样式路线、战线梳齿 |
| `element_route` | `moving_point` | `element_id` | **当前无入口**（绘制模式已实现，工具条无按钮） | 路径点数组、拖尾颜色/宽度/长度 |
| `element_route` | `connector` | `element_id` | **当前无入口** | 起止端点（**弱引用**：元素已分表故无外键，删元素时由应用层连带清理本行）、线宽/颜色/箭头 |

### 组 6 · 形状类元素 1 张 Shape 工具

「形状」按钮带下拉菜单，分三组共 19 项：多点绘制 / 两点绘制 / 特殊图形；五种形状**合并进同一张宽表**。**区域工具（Region）的行政区高亮也写这张表**——它的产物就是 `polygon`，因此不单列一组。
属性面板：`PropertiesPanel.tsx` 形状设置区。

| 表 | type 取值 | 主键 | 工具入口 | 存什么 |
|---|---|---|---|---|
| `element_shape` | `polygon` | `element_id` | Shape：多边形 / 曲线多边 / 直线·曲线防御圈 / 圆 / 矩形 / 五角星 ＋**Region 工具** | 环数组、填充描边、形状种类与各自元数据、曲线化、防御圈锯齿、渐变、旋转 |
| `element_shape` | `arrow` | `element_id` | Shape：带箭头直线/曲线、行军箭头、燕尾箭头、自定义燕尾、自定义箭头 | 起终点、弯曲控制点、箭头类型、宽度、填充透明度、绘制缩放 |
| `element_shape` | `double_arrow` | `element_id` | Shape：钳形（4 点自动合成） | 4 个控制点（points_json）、颜色 |
| `element_shape` | `gathering` | `element_id` | Shape：集结点（两点绘制） | 中心、半径、颜色、脉冲、旋转 |
| `element_shape` | `encirclement` | `element_id` | **当前无入口**（绘制模式已实现，工具条无按钮） | 中心、半径、填充与描边色 |

### 组 7 · 疆域类元素 1 张 Terr 工具

「疆域」按钮带下拉菜单：新建疆域 / 导入 / 绘制地块 / 兼并。势力、地块、兼并事件**全部 JSON 内联**进本表（`countries_json` / `plots_json` / `events_json`），疆域自包含、整体读写。
面板：`TerritoryImportDialog.tsx`（导入）+ `PropertiesPanel.tsx` 疆域设置区。

| 表 | 主键 | 工具入口 | 职责 |
|---|---|---|---|
| `element_territory` | `element_id` | Terr：新建疆域 / 绘制地块 / 兼并 | `display_json` 显示配置 + 三个 JSON 列承载原 `territory_*` 四张表的全部内容；`plot.ownerId` / `event.toCountryId` 的合法性由 `v_check_territory_ref` 视图校验 |

### 组 8 · 叠加层（弹窗） 1 张

| 表 | 职责 | 主键 | 关键点 | 前端对应 |
|---|---|---|---|---|
| `overlay` | 弹窗本体（10 类：文本/图片/图表/人物/对话…） | `overlay_id` | 图表/时间轴/对话等内容按 P3 留在 `payload_json` | 「弹窗」面板（`FxPanelBody.tsx`）+ 画面渲染 `fx/FxRender.tsx` OverlayContentView |

### 组 9 · 应用配置 1 张

| 表 | 职责 | 主键 | 关键点 | 前端对应 |
|---|---|---|---|---|
| `provider` | AI 服务商配置：文案生成 / 语音（含克隆）/ 图片生成 | `provider_id` | 与项目内容解耦（Key 只存本机）；`ux_provider_active` 保证每个 kind 至多一条生效 | 顶栏「设置 · AI」弹窗（`SettingsDialog.tsx`）；字幕面板内也可打开（`FxPanelBody.tsx`） |

## 四、每张表的字段（字段字典）

<!-- FIELD-DICT:BEGIN -->
> 本节由 DDL 自动生成（`tools/gen-db-field-dict.mjs`），共 **14 张表 / 365 个列，每列都有中文说明**。字段说明取自 `tools/db-field-notes.mjs`（人工词表，365 条），结构与约束取自 DDL；脚本会与 SQLite 实测结构交叉校验，并强制「每个字段必须有说明」，缺一条就报错。

> 元素相关的 **4 张类别宽表按工具条分类**（标记 / 路线 / 形状 / 疆域），每张表用 `type` 判别列承载该工具下的全部元素类型；图片类（Image 工具）已下线。工具条的完整对照见本文第五节。

> 读法：**列**为字段名；**约束**中 `PK` 主键、`NOT NULL` 必填、`FK` 外键（其后为删除行为：CASCADE 级联删除 / SET NULL 置空 / RESTRICT 拒绝删除）。

#### 快速跳转

- **组 1 · 合集与项目（含配置）**：`collection` · `project`
- **组 2 · 资源与素材**：`asset`
- **组 3 · 时间轴**：`camera_keyframe` · `screen_fx` · `narration` · `narration_entry` · `music_track`
- **组 4 · 标记类元素（Pin 工具）**：`element_marker`
- **组 5 · 路线类元素（Route 工具）**：`element_route`
- **组 6 · 形状类元素（Shape 工具）**：`element_shape`
- **组 7 · 疆域类元素（Terr 工具）**：`element_territory`
- **组 8 · 叠加层（弹窗）**：`overlay`
- **组 9 · 应用配置**：`provider`

### 组 1 · 合集与项目（含配置）

#### collection

**职责**：合集：项目之上的一层分组（合集 ▸ 项目 ▸ 章节 ▸ 元素）　**前端**：项目列表页左栏合集列表（ProjectManager.tsx）

5 列 · 主键 `collection_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `collection_id` | TEXT | `PK` | 合集 id（默认合集恒为 default，不可删除） |
| `name` | TEXT | `NOT NULL` | 合集名（默认合集名为「默认合集」，不可改名） |
| `ord` | INTEGER | `NOT NULL` | 合集排序（默认合集固定 -1，恒排最前） · 默认 `0` |
| `created_at` | INTEGER | `NOT NULL` | 创建时间（毫秒时间戳） |
| `updated_at` | INTEGER | `NOT NULL` | 最后修改时间（毫秒时间戳） |

#### project

**职责**：项目本体：身份 / 归属 / 审计 / 投影与生效底图的**默认值**引用　**前端**：项目列表页项目卡片（ProjectManager.tsx）；运行时即 projectStore.project

16 列 · 主键 `project_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `project_id` | TEXT | `PK` | 项目 id |
| `name` | TEXT | `NOT NULL` | 项目名 |
| `description` | TEXT | — | 项目描述 |
| `collection_id` | TEXT | `NOT NULL` `FK → collection RESTRICT` | 所属合集（默认 default）；删合集时其下项目回落到默认合集 · 默认 `'default'` |
| `created_at` | INTEGER | `NOT NULL` | 创建时间（毫秒时间戳） |
| `updated_at` | INTEGER | `NOT NULL` | 最后保存时间（毫秒时间戳） |
| `projection` | TEXT | `NOT NULL` | 地图投影：mercator 平面 / globe 3D 球体（渲染方式，随项目走） · 默认 `'mercator'` · `CHECK (projection IN ('mercator','globe'))` |
| `active_base_map_id` | TEXT | — | 当前生效底图的配置 id（底图是代码内置常量，不入库） |
| `active_elevation_map_id` | TEXT | — | 当前生效高程图的配置 id（同上） |
| `default_duration_sec` | REAL | `NOT NULL` | 默认章节时长（秒） · 默认 `5` · `CHECK (default_duration_sec > 0)` |
| `default_fps` | INTEGER | `NOT NULL` | 默认帧率（1–240） · 默认 `30` · `CHECK (default_fps BETWEEN 1 AND 240)` |
| `resolution_w` | INTEGER | `NOT NULL` | 默认导出宽度（px） · 默认 `1920` · `CHECK (resolution_w > 0)` |
| `resolution_h` | INTEGER | `NOT NULL` | 默认导出高度（px） · 默认 `1080` · `CHECK (resolution_h > 0)` |
| `default_easing` | TEXT | `NOT NULL` | 默认缓动类型 · 默认 `'easeInOut'` |
| `elevation_exaggeration` | REAL | — | 地形夸张系数（覆盖内置默认 1.5；0=平坦、1=真实比例；空=用内置默认） · `CHECK (elevation_exaggeration IS NULL OR elevation_exaggeration BETWEEN 0 AND 50)` |
| `end_sec` | REAL | `NOT NULL` | 全片总长（秒） · 默认 `0` · `CHECK (end_sec >= 0)` |

### 组 2 · 资源与素材

#### asset

**职责**：素材仓库（**唯一**素材存储，合并原 custom_symbol / custom_image）：按项目 / 类型 / 时间戳落盘　**前端**：属性面板上传行（PropertiesPanel ResourceUploadRow）、标记面板自定义图片网格（CustomImageGrid）、字幕配音 / 配乐音频上传、导出配置内嵌还原（lib/assets.ts）

8 列 · 主键 `asset_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `asset_id` | TEXT | `PK` | 素材 id（随机生成，与文件名/内容解耦，改名不影响引用） |
| `kind` | TEXT | `NOT NULL` | 素材种类：image 图片 / gif 动图 / model 3D 模型 / audio 音频 / video 视频 / font 字体 / icon 用户图标库条目（合并了原 custom_symbol / custom_image） · `CHECK (kind IN ('image','gif','model','audio','video','font','icon'))` |
| `name` | TEXT | `NOT NULL` | 原文件名 / 展示名 · 默认 `''` |
| `mime` | TEXT | `NOT NULL` | MIME 类型（如 image/png） |
| `storage` | TEXT | `NOT NULL` | 存放方式：file 外置文件 / blob 库内联 · `CHECK (storage IN ('file','blob'))` |
| `rel_path` | TEXT | — | 外置方式下的相对路径（相对 userData/projects/） |
| `blob` | BLOB | — | 内联方式下的小文件二进制 |
| `created_at` | INTEGER | `NOT NULL` | 入库时间（毫秒时间戳） |

**表级约束**

- `CHECK ((storage = 'file' AND rel_path IS NOT NULL) OR (storage = 'blob' AND blob IS NOT NULL))`

### 组 3 · 时间轴

#### camera_keyframe

**职责**：视角关键帧（停留 → 飞行 → 落位；follow / orbit 视角）　**前端**：「视角」面板（KeyframePanel.tsx / CameraEditor.tsx）

16 列 · 主键 `kf_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `kf_id` | TEXT | `PK` | 视角关键帧 id |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `sec` | REAL | `NOT NULL` | 到达时间（秒，项目绝对时间轴）—— 语义为「停留 → 飞行 → 落位」的落位时刻 · `CHECK (sec >= 0)` |
| `center_lng` | REAL | `NOT NULL` | 视角中心经度 |
| `center_lat` | REAL | `NOT NULL` | 视角中心纬度 |
| `zoom` | REAL | `NOT NULL` | 缩放级别 |
| `pitch` | REAL | — | 俯仰角（度） |
| `bearing` | REAL | — | 方向角（度） |
| `easing` | TEXT | — | 飞行缓动类型 |
| `move_duration_sec` | REAL | — | 起飞提前量（秒，默认 2 秒） · `CHECK (move_duration_sec IS NULL OR move_duration_sec >= 0)` |
| `camera_type` | TEXT | — | 视角类型：fixed 固定 / follow 跟随 / orbit 环绕 · `CHECK (camera_type IS NULL OR camera_type IN ('fixed','follow','orbit'))` |
| `follow_route_element_id` | TEXT | `FK → element_route SET NULL` | 跟随的路线元素（外键指向 element_route，只能是 line / moving_point；删除后置空，退化为固定视角） |
| `follow_direction` | INTEGER | — | 跟随视角是否按路线切线自动定向 · `CHECK (follow_direction IS NULL OR follow_direction IN (0,1))` |
| `orbit_speed` | REAL | — | 环绕速度（度/秒） |
| `orbit_duration_sec` | REAL | — | 环绕时长（秒） |
| `ord` | INTEGER | `NOT NULL` | 同章节内排序 · 默认 `0` |

#### screen_fx

**职责**：屏幕空间特效窗口（天气 / 画面叠加，非地图元素）　**前端**：右侧「特效」面板（FxPanelBody.tsx）+ 时间轴特效轨道

13 列 · 主键 `fx_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `fx_id` | TEXT | `PK` | 特效窗口 id |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `kind` | TEXT | `NOT NULL` | 类别：weather 天气 / screen 画面特效 · `CHECK (kind IN ('weather','screen'))` |
| `name` | TEXT | `NOT NULL` | 显示名（时间线轨道上展示） · 默认 `''` |
| `start_sec` | REAL | `NOT NULL` | 起始时间（秒，项目绝对时间轴） · `CHECK (start_sec >= 0)` |
| `end_sec` | REAL | `NOT NULL` | 结束时间（秒，项目绝对时间轴） |
| `weather_type` | TEXT | — | 天气类型：rain 雨 / snow 雪 / lightning 闪电 / fog 雾 · `CHECK (weather_type IS NULL OR weather_type IN ('rain','snow','lightning','fog'))` |
| `intensity` | REAL | — | 强度（0–1） · `CHECK (intensity IS NULL OR intensity BETWEEN 0 AND 1)` |
| `wind` | REAL | — | 风向风力（-1..1，向右为正） · `CHECK (wind IS NULL OR wind BETWEEN -1 AND 1)` |
| `effect_type` | TEXT | — | 画面特效：shake 震动 / flash 闪光 / vignette 暗角 / cloudReveal 云散 / fadeBlack / fadeWhite · `CHECK (effect_type IS NULL OR effect_type IN ( 'shake','flash','vignette','cloudReveal','fadeBlack','fadeWhite'))` |
| `effect_color` | TEXT | — | 特效颜色（flash、fade 类使用） |
| `enabled` | INTEGER | `NOT NULL` | 是否启用 · 默认 `1` · `CHECK (enabled IN (0,1))` |
| `ord` | INTEGER | `NOT NULL` | 同章节内排序 · 默认 `0` |

**表级约束**

- `CHECK (end_sec >= start_sec)`
- `CHECK ((kind = 'weather' AND weather_type IS NOT NULL) OR (kind = 'screen' AND effect_type IS NOT NULL))`

#### narration

**职责**：字幕 / 配音档（样式部分，1:1）　**前端**：右侧「字幕」面板（FxPanelBody.tsx）

10 列 · 主键 `project_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `project_id` | TEXT | `PK` `FK → project CASCADE` | 项目 id（每项目一份配音档，1:1） |
| `font_size` | REAL | `NOT NULL` | 字幕字号 · `CHECK (font_size > 0)` |
| `font_family` | TEXT | — | 字体族（空=楷体默认） |
| `color` | TEXT | `NOT NULL` | 字幕文字颜色 |
| `stroke_color` | TEXT | `NOT NULL` | 字幕描边颜色 |
| `stroke_width` | REAL | `NOT NULL` | 字幕描边宽度 · `CHECK (stroke_width >= 0)` |
| `bg` | TEXT | `NOT NULL` | 字幕背景：none 无 / bar 底部条带 · `CHECK (bg IN ('none','bar'))` |
| `bg_color` | TEXT | `NOT NULL` | 字幕背景色 |
| `pos_y` | REAL | `NOT NULL` | 字幕距底百分比（0–40） · `CHECK (pos_y BETWEEN 0 AND 40)` |
| `max_pct` | REAL | `NOT NULL` | 字幕最大宽度百分比 · `CHECK (max_pct > 0 AND max_pct <= 100)` |

#### narration_entry

**职责**：字幕条：文本 + 配音音频 + 显示时长　**前端**：时间轴「🎙 配音」轨道（TimelineEditor.tsx）+ 字幕面板逐条编辑 / TTS / 导入 SRT

9 列 · 主键 `entry_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `entry_id` | TEXT | `PK` | 字幕条 id |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `text` | TEXT | `NOT NULL` | 字幕文本（同时也是配音朗读文本） · 默认 `''` |
| `audio_asset_id` | TEXT | `FK → asset SET NULL` | 配音音频（TTS 生成或导入） |
| `url` | TEXT | — | 音频地址（asset 不可用时的内联 dataURL / 站内路径） |
| `duration_sec` | REAL | — | 显示时长（秒）：空=自动（有配音随音频、无配音按字数估算）；非空=手动覆盖 · `CHECK (duration_sec IS NULL OR duration_sec >= 1)` |
| `start_sec` | REAL | `NOT NULL` | 章内起始时间（秒，默认自动顺排） · `CHECK (start_sec >= 0)` |
| `locked` | INTEGER | `NOT NULL` | 手动定位后锁定，不再参与自动顺排 · 默认 `0` · `CHECK (locked IN (0,1))` |
| `ord` | INTEGER | `NOT NULL` | 同章节内排序 · 默认 `0` |

#### music_track

**职责**：项目级背景音乐：单轨多段（绝对时间、循环、淡入淡出）　**前端**：时间轴「音乐」轨道（TimelineEditor.tsx）+ 音乐面板（内置/导入）

12 列 · 主键 `track_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `track_id` | TEXT | `PK` | 音乐段 id |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目（项目级单轨多段） |
| `name` | TEXT | `NOT NULL` | 曲目名 · 默认 `''` |
| `audio_asset_id` | TEXT | `FK → asset SET NULL` | 音频素材 |
| `url` | TEXT | — | 音频地址（asset 不可用时的内联 dataURL / 站内路径） |
| `start_sec` | REAL | `NOT NULL` | 起效起始时间（秒，项目绝对时间轴） · `CHECK (start_sec >= 0)` |
| `end_sec` | REAL | — | 结束时间（秒）：空=随音频长度；非空=手动覆盖 |
| `volume` | REAL | `NOT NULL` | 音量（0–1） · 默认 `1` · `CHECK (volume BETWEEN 0 AND 1)` |
| `loop` | INTEGER | `NOT NULL` | 是否循环播放 · 默认 `0` · `CHECK (loop IN (0,1))` |
| `fade_in` | REAL | `NOT NULL` | 淡入时长（秒） · 默认 `0` · `CHECK (fade_in >= 0)` |
| `fade_out` | REAL | `NOT NULL` | 淡出时长（秒） · 默认 `0` · `CHECK (fade_out >= 0)` |
| `ord` | INTEGER | `NOT NULL` | 同项目内排序 · 默认 `0` |

**表级约束**

- `CHECK (end_sec IS NULL OR end_sec >= start_sec)`

### 组 4 · 标记类元素（Pin 工具）

#### element_marker

**职责**：标记类元素：Pin 工具产出，3 种 type 合并一张宽表　**前端**：工具条「标记」按钮 + 标记属性面板（PropertiesPanel，9 种视觉形态）

57 列 · 主键 `element_id` · 工具入口：Pin 工具（一键放置到地图中心）；标记面板切到 Marker（旗标）、导入/旧数据的军标也写这张表

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `element_id` | TEXT | `PK` | 元素 id（全库唯一，4 张类别表共享同一 id 空间） |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `type` | TEXT | `NOT NULL` | 子类型判别列：point 点 / flag 旗标 / military_symbol 军标（Pin 工具） · `CHECK (type IN ('point','flag','military_symbol'))` |
| `name` | TEXT | `NOT NULL` | 元素名（与属性面板首字段 LABEL 同步） · 默认 `''` |
| `visible` | INTEGER | `NOT NULL` | 是否显示（0/1） · 默认 `1` · `CHECK (visible IN (0,1))` |
| `start_sec` | REAL | `NOT NULL` | 出现时间（秒） · `CHECK (start_sec >= 0)` |
| `end_sec` | REAL | `NOT NULL` | 消失时间（秒） |
| `anim_effect` | TEXT | — | 动画效果：grow 增长 / move 移动 / fill 填充 / march 填充行进 / marchplain 行进 · `CHECK (anim_effect IS NULL OR anim_effect IN ('grow','move','fill','march','marchplain'))` |
| `fly_mode` | INTEGER | `NOT NULL` | 悬空飞行模式：按高度剖面离地显示 · 默认 `0` · `CHECK (fly_mode IN (0,1))` |
| `show_icon` | INTEGER | `NOT NULL` | 是否显示移动图标 · 默认 `0` · `CHECK (show_icon IN (0,1))` |
| `move_start_sec` | REAL | — | 移动图标出发时间（秒） |
| `move_end_sec` | REAL | — | 移动图标到达时间（秒） |
| `uniform_move` | INTEGER | — | 是否全程匀速（0 则按各路径点自定义到达时间） · `CHECK (uniform_move IS NULL OR uniform_move IN (0,1))` |
| `point_times_json` | TEXT | — | 各路径点到达时间数组（秒，非匀速时使用） · `CHECK (point_times_json IS NULL OR json_valid(point_times_json))` |
| `label_text` | TEXT | — | 标签文字（与元素名同步） |
| `label_font_size` | REAL | — | 标签字号 |
| `label_color` | TEXT | — | 标签文字颜色 |
| `label_position` | TEXT | — | 标签位置：top/bottom/left/right/center · `CHECK (label_position IS NULL OR label_position IN ('top','bottom','left','right','center'))` |
| `label_offset_x` | REAL | — | 标签水平像素偏移（0=居中，负左正右） |
| `label_offset_y` | REAL | — | 标签垂直像素偏移（0=居中，正值向上） |
| `label_bg_color` | TEXT | — | 标签背景色（默认透明） |
| `label_bg_padding` | REAL | — | 标签背景内边距 |
| `label_bg_radius` | REAL | — | 标签背景圆角 |
| `label_font_weight` | TEXT | — | 标签字重：normal / bold · `CHECK (label_font_weight IS NULL OR label_font_weight IN ('normal','bold'))` |
| `keyframes_json` | TEXT | — | 动画关键帧数组（原 element_keyframe 表内联）：[{property,sec,easing,value_num,value_json}]；同 property 同 sec 不得重复 · `CHECK (keyframes_json IS NULL OR json_valid(keyframes_json))` |
| `ord` | INTEGER | `NOT NULL` | 同章节内排序 · 默认 `0` |
| `lng` | REAL | `NOT NULL` | 经度（三类标记都落在单点） |
| `lat` | REAL | `NOT NULL` | 纬度 |
| `rotation` | REAL | — | 贴地旋转角（0–360 度） |
| `shape` | TEXT | — | 点呈现形态（9 种）：circle 圆点 / text 纯文字 / pin 水滴针 / bubble 气泡 / emoji 表情 / image 图片 / gif 动图 / model 3D 模型 / icon 图标库 · `CHECK (shape IS NULL OR shape IN ( 'circle','text','pin','bubble','emoji','image','gif','model','icon'))` |
| `emoji` | TEXT | — | 表情字符（type=point 且 shape=emoji 时必填） |
| `scale` | REAL | — | 等比缩放（0.3–3，同时影响点与标签字号） · `CHECK (scale IS NULL OR (scale >= 0.3 AND scale <= 3))` |
| `orientation` | TEXT | — | 朝向：faceCam 面向镜头 / flat 贴地（shape=model 不能贴地，CHECK 保证） · `CHECK (orientation IS NULL OR orientation IN ('faceCam','flat'))` |
| `color` | TEXT | — | 可着色形态的主色（shape=model / gif 时禁用，CHECK 保证） |
| `asset_id` | TEXT | `FK → asset SET NULL` | 用户上传的图片 / GIF / 模型素材（删除素材则置空） |
| `builtin_id` | TEXT | — | 内置资源 id（打包进应用、不入库）：image:flag-red / gif:radar / model:drone / icon:lucide:MapPin |
| `icon_lib` | TEXT | — | 图标库命名空间：lucide / react-icons/xxx / 自建库名（shape=icon 时用） |
| `icon_name` | TEXT | — | 图标名（shape=icon 时必填，可指向内置库或 custom_symbol.name） |
| `visual_fit` | TEXT | — | image 适配方式：contain / cover · `CHECK (visual_fit IS NULL OR visual_fit IN ('contain','cover'))` |
| `visual_tintable` | INTEGER | — | image 是否允许着色（0/1） · `CHECK (visual_tintable IS NULL OR visual_tintable IN (0,1))` |
| `visual_fps` | REAL | — | gif 帧率 |
| `visual_loop` | INTEGER | — | gif 是否循环（0/1） · `CHECK (visual_loop IS NULL OR visual_loop IN (0,1))` |
| `visual_altitude` | REAL | — | model 离地高度（米） |
| `visual_auto_rotate` | REAL | — | model 自转角速度（度/秒） |
| `visual_spin` | REAL | — | model 初始朝向（度） |
| `visual_pitch_align` | INTEGER | — | model 是否随地图俯仰倾斜（0/1） · `CHECK (visual_pitch_align IS NULL OR visual_pitch_align IN (0,1))` |
| `visual_animation` | TEXT | — | model 播放的动画片段名 |
| `visual_stroke_width` | REAL | — | icon 描边粗细 |
| `flag_text` | TEXT | — | 旗面文字（type=flag 时必填） |
| `flag_color` | TEXT | — | 旗面颜色 |
| `flag_text_color` | TEXT | — | 旗面文字颜色 |
| `flag_font_size` | REAL | — | 旗面字号 |
| `flag_width` | REAL | — | 旗面宽度（px） |
| `sidc` | TEXT | — | APP-6 军标符号编码（type=military_symbol 时必填） |
| `symbol_size` | REAL | — | 军标尺寸 |
| `echelon` | TEXT | — | 军标梯队 / 规模标注 |
| `symbol_label` | TEXT | — | 军标旁附加文字 |

**表级约束**

- `CHECK (end_sec >= start_sec)`
- `CHECK (move_end_sec IS NULL OR move_start_sec IS NULL OR move_end_sec > move_start_sec)`
- `CHECK (type <> 'point' OR shape IS NOT 'emoji' OR emoji IS NOT NULL)`
- `CHECK (type <> 'point' OR shape IS NULL OR shape IN ('circle','text','pin','bubble','emoji') OR asset_id IS NOT NULL OR builtin_id IS NOT NULL)`（媒体形态（image/gif/model/icon）必须指明来源：用户上传 asset 或内置 builtin）
- `CHECK (type <> 'point' OR shape IS NOT 'icon' OR icon_name IS NOT NULL)`
- `CHECK (shape IS NOT 'model' OR color IS NULL)`（能力矩阵（与属性面板「隐藏不可用控件」一一对应））
- `CHECK (shape IS NOT 'gif' OR color IS NULL)`（模型不可着色（多材质））
- `CHECK (shape IS NOT 'model' OR orientation IS NULL OR orientation = 'faceCam')`（GIF 不可着色（多帧彩色））
- `CHECK (type <> 'flag' OR flag_text IS NOT NULL)`（模型不能贴地）
- `CHECK (type <> 'military_symbol' OR sidc IS NOT NULL)`

### 组 5 · 路线类元素（Route 工具）

#### element_route

**职责**：路线类元素：line / moving_point / connector　**前端**：工具条「路线」按钮 + 路线属性面板（含均匀移动与逐点到达时间）

73 列 · 主键 `element_id` · 工具入口：Route 工具；Shape 子菜单的直线/曲线/带箭头/战线/行军箭头也写这张表；连接线无工具入口

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `element_id` | TEXT | `PK` | 元素 id（全库唯一，4 张类别表共享同一 id 空间） |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `type` | TEXT | `NOT NULL` | 子类型判别列：line 线 / moving_point 移动点 / connector 连接线（Route 工具） · `CHECK (type IN ('line','moving_point','connector'))` |
| `name` | TEXT | `NOT NULL` | 元素名（与属性面板首字段 LABEL 同步） · 默认 `''` |
| `visible` | INTEGER | `NOT NULL` | 是否显示（0/1） · 默认 `1` · `CHECK (visible IN (0,1))` |
| `start_sec` | REAL | `NOT NULL` | 出现时间（秒） · `CHECK (start_sec >= 0)` |
| `end_sec` | REAL | `NOT NULL` | 消失时间（秒） |
| `anim_effect` | TEXT | — | 动画效果：grow / move / fill / march / marchplain · `CHECK (anim_effect IS NULL OR anim_effect IN ('grow','move','fill','march','marchplain'))` |
| `fly_mode` | INTEGER | `NOT NULL` | 悬空飞行模式：路线与图标按高度剖面离地显示 · 默认 `0` · `CHECK (fly_mode IN (0,1))` |
| `show_icon` | INTEGER | `NOT NULL` | 是否显示移动图标 · 默认 `0` · `CHECK (show_icon IN (0,1))` |
| `move_icon_shape` | TEXT | — | 移动图标形态：dot/pin/emoji/bubble/text/flag + 图片/动图/模型/图标库/军标 · `CHECK (move_icon_shape IS NULL OR move_icon_shape IN ('dot','pin','emoji','bubble','text','flag','image','gif','model','icon','military_symbol'))` |
| `move_icon_color` | TEXT | — | 移动图标主色 |
| `move_icon_emoji` | TEXT | — | 移动图标表情字符（形态=emoji） |
| `move_icon_scale` | REAL | — | 移动图标等比缩放 |
| `move_icon_label_text` | TEXT | — | 移动图标标签文字 |
| `move_icon_label_color` | TEXT | — | 移动图标标签文字颜色 |
| `move_icon_label_bg` | TEXT | — | 移动图标标签背景色（默认透明） |
| `move_icon_label_size` | REAL | — | 移动图标标签字号 |
| `move_icon_label_padding` | REAL | — | 移动图标标签内边距 |
| `move_icon_label_radius` | REAL | — | 移动图标标签圆角 |
| `move_icon_label_pos` | TEXT | — | 移动图标标签位置（旧枚举：top/bottom/left/right） |
| `move_icon_label_offset_x` | REAL | — | 移动图标标签水平像素偏移（0=居中，负左正右） |
| `move_icon_label_offset_y` | REAL | — | 移动图标标签垂直像素偏移（0=居中，正值向上） |
| `move_icon_flag_text` | TEXT | — | 移动图标为旗帜时的旗面文字 |
| `move_icon_flag_color` | TEXT | — | 移动图标为旗帜时的旗面颜色 |
| `move_icon_builtin_id` | TEXT | — | 移动图标内置资源 id（不入库资源） |
| `move_icon_asset_id` | TEXT | `FK → asset SET NULL` | 移动图标上传素材 id（删素材置空） |
| `move_icon_icon_lib` | TEXT | — | 移动图标图标库命名空间 |
| `move_icon_icon_name` | TEXT | — | 移动图标图标名 |
| `move_icon_orientation` | TEXT | — | 移动图标朝向：faceCam 面向镜头 / flat 贴地 · `CHECK (move_icon_orientation IS NULL OR move_icon_orientation IN ('faceCam','flat'))` |
| `move_icon_rotation` | REAL | — | 移动图标贴地旋转角（度） |
| `move_icon_show_label` | INTEGER | — | 移动图标是否显示标签（0/1） · `CHECK (move_icon_show_label IS NULL OR move_icon_show_label IN (0,1))` |
| `move_start_sec` | REAL | — | 移动图标出发时间（秒） |
| `move_end_sec` | REAL | — | 移动图标到达时间（秒） |
| `uniform_move` | INTEGER | — | 是否全程匀速（0 则按各路径点自定义到达时间） · `CHECK (uniform_move IS NULL OR uniform_move IN (0,1))` |
| `point_times_json` | TEXT | — | 各路径点到达时间数组（秒） · `CHECK (point_times_json IS NULL OR json_valid(point_times_json))` |
| `label_text` | TEXT | — | 标签文字（与元素名同步） |
| `label_font_size` | REAL | — | 标签字号 |
| `label_color` | TEXT | — | 标签文字颜色 |
| `label_position` | TEXT | — | 标签位置：top/bottom/left/right/center · `CHECK (label_position IS NULL OR label_position IN ('top','bottom','left','right','center'))` |
| `label_offset_x` | REAL | — | 标签水平像素偏移（0=居中，负左正右） |
| `label_offset_y` | REAL | — | 标签垂直像素偏移（0=居中，正值向上） |
| `label_bg_color` | TEXT | — | 标签背景色（默认透明） |
| `label_bg_padding` | REAL | — | 标签背景内边距 |
| `label_bg_radius` | REAL | — | 标签背景圆角 |
| `label_font_weight` | TEXT | — | 标签字重：normal / bold · `CHECK (label_font_weight IS NULL OR label_font_weight IN ('normal','bold'))` |
| `keyframes_json` | TEXT | — | 动画关键帧数组（原 element_keyframe 表内联）：[{property,sec,easing,value_num,value_json}]；同 property 同 sec 不得重复 · `CHECK (keyframes_json IS NULL OR json_valid(keyframes_json))` |
| `ord` | INTEGER | `NOT NULL` | 同章节内排序 · 默认 `0` |
| `coords_json` | TEXT | — | 路径点数组 [[lng,lat],…]；line_type=bezier 时为控制点、arc 时为大圆弧端点（line / moving_point 必填） · `CHECK (coords_json IS NULL OR json_valid(coords_json))` |
| `line_width` | REAL | — | 线宽（px） |
| `line_color` | TEXT | — | 线条颜色（moving_point 时为主色） |
| `line_dash_on` | REAL | — | 虚线段长（原 line_dash_json[0]） |
| `line_dash_off` | REAL | — | 虚线空白长（原 line_dash_json[1]） |
| `line_type` | TEXT | — | 线型：straight 直线 / bezier 贝塞尔 / arc 大圆弧航线 · `CHECK (line_type IS NULL OR line_type IN ('straight','bezier','arc'))` |
| `line_arrow` | INTEGER | — | 线末端是否带方向箭头（0/1） · `CHECK (line_arrow IS NULL OR line_arrow IN (0,1))` |
| `route_dot_enabled` | INTEGER | — | 行军光点动画是否开启（0/1） · `CHECK (route_dot_enabled IS NULL OR route_dot_enabled IN (0,1))` |
| `route_dot_count` | INTEGER | — | 同时存在的光点数量 |
| `route_dot_width` | REAL | — | 光点宽度（px） |
| `route_dot_color` | TEXT | — | 光点颜色 |
| `route_dot_frame_step` | INTEGER | — | 每 N 帧光点前进一步 |
| `flow_speed` | REAL | — | 流动速度（0 关闭；>0 每 N 帧相位前进一步，行军蚁效果） |
| `plain_path` | INTEGER | — | 无样式路线：预览与导出不画线，仅显示移动图标 · `CHECK (plain_path IS NULL OR plain_path IN (0,1))` |
| `front_tooth_length` | REAL | — | 战线梳齿长度（px） |
| `front_tooth_gap` | REAL | — | 战线梳齿间距（px） |
| `front_tooth_angle` | REAL | — | 梳齿偏角（度） |
| `front_side` | INTEGER | — | 梳齿朝向侧：1 右 / -1 左 · `CHECK (front_side IS NULL OR front_side IN (-1,1))` |
| `trail_color` | TEXT | — | 拖尾颜色（type=moving_point） |
| `trail_width` | REAL | — | 拖尾宽度（px） |
| `trail_length` | INTEGER | — | 拖尾长度（帧） |
| `from_element_id` | TEXT | — | 连接线起点元素（弱引用：可指向任意类别元素，元素已分表故无外键；删元素时由应用层连带删除本行） |
| `to_element_id` | TEXT | — | 连接线终点元素（弱引用；与起点不得相同） |
| `animated` | INTEGER | — | 连接线是否流动动画（0/1） · `CHECK (animated IS NULL OR animated IN (0,1))` |
| `arrowhead` | INTEGER | — | 连接线是否显示末端箭头（0/1） · `CHECK (arrowhead IS NULL OR arrowhead IN (0,1))` |

**表级约束**

- `CHECK (end_sec >= start_sec)`
- `CHECK (move_end_sec IS NULL OR move_start_sec IS NULL OR move_end_sec > move_start_sec)`
- `CHECK (type <> 'line' OR coords_json IS NOT NULL)`
- `CHECK (type <> 'moving_point' OR coords_json IS NOT NULL)`
- `CHECK (type <> 'connector' OR (from_element_id IS NOT NULL AND to_element_id IS NOT NULL))`
- `CHECK (from_element_id IS NULL OR to_element_id IS NULL OR from_element_id <> to_element_id)`

### 组 6 · 形状类元素（Shape 工具）

#### element_shape

**职责**：形状类元素：polygon / arrow / double_arrow / gathering / encirclement（Region 行政区也写此表）　**前端**：工具条「形状」下拉 + 形状属性面板

80 列 · 主键 `element_id` · 工具入口：Shape：多边形/曲线多边/防御圈/圆/矩形/五角星/钳形/集结地/包围圈；Region 工具的行政区高亮也写这张表

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `element_id` | TEXT | `PK` | 元素 id（全库唯一，4 张类别表共享同一 id 空间） |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `type` | TEXT | `NOT NULL` | 子类型判别列：polygon 多边形 / arrow 箭头 / double_arrow 钳形 / gathering 集结地 / encirclement 包围圈（Shape 工具） · `CHECK (type IN ('polygon','arrow','double_arrow','gathering','encirclement'))` |
| `name` | TEXT | `NOT NULL` | 元素名（与属性面板首字段 LABEL 同步） · 默认 `''` |
| `visible` | INTEGER | `NOT NULL` | 是否显示（0/1） · 默认 `1` · `CHECK (visible IN (0,1))` |
| `start_sec` | REAL | `NOT NULL` | 出现时间（秒） · `CHECK (start_sec >= 0)` |
| `end_sec` | REAL | `NOT NULL` | 消失时间（秒） |
| `anim_effect` | TEXT | — | 动画效果：grow / move / fill / march / marchplain · `CHECK (anim_effect IS NULL OR anim_effect IN ('grow','move','fill','march','marchplain'))` |
| `fly_mode` | INTEGER | `NOT NULL` | 悬空飞行模式 · 默认 `0` · `CHECK (fly_mode IN (0,1))` |
| `show_icon` | INTEGER | `NOT NULL` | 是否显示移动图标 · 默认 `0` · `CHECK (show_icon IN (0,1))` |
| `move_icon_shape` | TEXT | — | 移动图标形态：dot/pin/emoji/bubble/text/flag + 图片/动图/模型/图标库/军标 · `CHECK (move_icon_shape IS NULL OR move_icon_shape IN ('dot','pin','emoji','bubble','text','flag','image','gif','model','icon','military_symbol'))` |
| `move_icon_color` | TEXT | — | 移动图标主色 |
| `move_icon_emoji` | TEXT | — | 移动图标表情字符（形态=emoji） |
| `move_icon_scale` | REAL | — | 移动图标等比缩放 |
| `move_icon_label_text` | TEXT | — | 移动图标标签文字 |
| `move_icon_label_color` | TEXT | — | 移动图标标签文字颜色 |
| `move_icon_label_bg` | TEXT | — | 移动图标标签背景色（默认透明） |
| `move_icon_label_size` | REAL | — | 移动图标标签字号 |
| `move_icon_label_padding` | REAL | — | 移动图标标签内边距 |
| `move_icon_label_radius` | REAL | — | 移动图标标签圆角 |
| `move_icon_label_pos` | TEXT | — | 移动图标标签位置（旧枚举：top/bottom/left/right） |
| `move_icon_label_offset_x` | REAL | — | 移动图标标签水平像素偏移（0=居中，负左正右） |
| `move_icon_label_offset_y` | REAL | — | 移动图标标签垂直像素偏移（0=居中，正值向上） |
| `move_icon_flag_text` | TEXT | — | 移动图标为旗帜时的旗面文字 |
| `move_icon_flag_color` | TEXT | — | 移动图标为旗帜时的旗面颜色 |
| `move_icon_builtin_id` | TEXT | — | 移动图标内置资源 id（不入库资源） |
| `move_icon_asset_id` | TEXT | `FK → asset SET NULL` | 移动图标上传素材 id（删素材置空） |
| `move_icon_icon_lib` | TEXT | — | 移动图标图标库命名空间 |
| `move_icon_icon_name` | TEXT | — | 移动图标图标名 |
| `move_icon_orientation` | TEXT | — | 移动图标朝向：faceCam 面向镜头 / flat 贴地 · `CHECK (move_icon_orientation IS NULL OR move_icon_orientation IN ('faceCam','flat'))` |
| `move_icon_rotation` | REAL | — | 移动图标贴地旋转角（度） |
| `move_icon_show_label` | INTEGER | — | 移动图标是否显示标签（0/1） · `CHECK (move_icon_show_label IS NULL OR move_icon_show_label IN (0,1))` |
| `move_start_sec` | REAL | — | 移动图标出发时间（秒） |
| `move_end_sec` | REAL | — | 移动图标到达时间（秒） |
| `uniform_move` | INTEGER | — | 是否全程匀速（0 则按各路径点自定义到达时间） · `CHECK (uniform_move IS NULL OR uniform_move IN (0,1))` |
| `point_times_json` | TEXT | — | 各路径点到达时间数组（秒） · `CHECK (point_times_json IS NULL OR json_valid(point_times_json))` |
| `label_text` | TEXT | — | 标签文字（与元素名同步） |
| `label_font_size` | REAL | — | 标签字号 |
| `label_color` | TEXT | — | 标签文字颜色 |
| `label_position` | TEXT | — | 标签位置：top/bottom/left/right/center · `CHECK (label_position IS NULL OR label_position IN ('top','bottom','left','right','center'))` |
| `label_offset_x` | REAL | — | 标签水平像素偏移（0=居中，负左正右） |
| `label_offset_y` | REAL | — | 标签垂直像素偏移（0=居中，正值向上） |
| `label_bg_color` | TEXT | — | 标签背景色（默认透明） |
| `label_bg_padding` | REAL | — | 标签背景内边距 |
| `label_bg_radius` | REAL | — | 标签背景圆角 |
| `label_font_weight` | TEXT | — | 标签字重：normal / bold · `CHECK (label_font_weight IS NULL OR label_font_weight IN ('normal','bold'))` |
| `keyframes_json` | TEXT | — | 动画关键帧数组（原 element_keyframe 表内联）：[{property,sec,easing,value_num,value_json}]；同 property 同 sec 不得重复 · `CHECK (keyframes_json IS NULL OR json_valid(keyframes_json))` |
| `ord` | INTEGER | `NOT NULL` | 同章节内排序 · 默认 `0` |
| `rings_json` | TEXT | — | 多边形环数组：rings[0] 为外环，其余为洞（type=polygon 时必填） · `CHECK (rings_json IS NULL OR json_valid(rings_json))` |
| `fill_color` | TEXT | — | 填充色 |
| `fill_opacity` | REAL | — | 填充透明度（0–1） · `CHECK (fill_opacity IS NULL OR fill_opacity BETWEEN 0 AND 1)` |
| `stroke_color` | TEXT | — | 描边色 |
| `stroke_width` | REAL | — | 描边宽度（px） |
| `shape_kind` | TEXT | — | 多边形种类：poly 多边形 / rect 矩形 / circle 圆 / star 五角星 · `CHECK (shape_kind IS NULL OR shape_kind IN ('poly','rect','circle','star'))` |
| `rect_c1_lng` | REAL | — | 矩形对角点1经度 |
| `rect_c1_lat` | REAL | — | 矩形对角点1纬度 |
| `rect_c2_lng` | REAL | — | 矩形对角点2经度 |
| `rect_c2_lat` | REAL | — | 矩形对角点2纬度 |
| `poly_curve` | INTEGER | — | 各边曲线化（闭合贝塞尔拟合，0/1） · `CHECK (poly_curve IS NULL OR poly_curve IN (0,1))` |
| `defense_tooth_length` | REAL | — | 防御圈锯齿长度（px） |
| `defense_tooth_gap` | REAL | — | 防御圈锯齿间距（px） |
| `defense_tooth_angle` | REAL | — | 防御圈锯齿偏角（度） |
| `defense_side` | INTEGER | — | 防御圈锯齿朝向侧：1 右 / -1 左 · `CHECK (defense_side IS NULL OR defense_side IN (-1,1))` |
| `gradient_enabled` | INTEGER | — | 填充渐变是否开启（0/1） · `CHECK (gradient_enabled IS NULL OR gradient_enabled IN (0,1))` |
| `gradient_from` | TEXT | — | 渐变起始色 |
| `gradient_to` | TEXT | — | 渐变结束色 |
| `from_lng` | REAL | — | 箭头起点经度（type=arrow 时必填） |
| `from_lat` | REAL | — | 箭头起点纬度 |
| `to_lng` | REAL | — | 箭头终点经度 |
| `to_lat` | REAL | — | 箭头终点纬度 |
| `path_json` | TEXT | — | 弯曲燕尾箭头的控制点（≥2 个时按贝塞尔渲染） · `CHECK (path_json IS NULL OR json_valid(path_json))` |
| `arrow_type` | TEXT | — | 箭头类型（type=arrow 时必填）：swallowtail 燕尾 / simple / block / pincer 钳形 / curved / curved-simple / attack / straight · `CHECK (arrow_type IS NULL OR arrow_type IN ( 'swallowtail','simple','block','pincer','curved','curved-simple','attack','straight'))` |
| `width` | REAL | — | 箭头宽度（px） |
| `color` | TEXT | — | 颜色（箭头 / 集结地 / 钳形共用） |
| `points_json` | TEXT | — | 4 个控制点（type=double_arrow 钳形攻势时必填） · `CHECK (points_json IS NULL OR json_valid(points_json))` |
| `center_lng` | REAL | — | 中心经度（gathering / encirclement 必填） |
| `center_lat` | REAL | — | 中心纬度 |
| `radius` | REAL | — | 半径（米，gathering / encirclement 必填） |
| `pulse_animation` | INTEGER | — | 是否脉冲动画（集结地，0/1） · `CHECK (pulse_animation IS NULL OR pulse_animation IN (0,1))` |
| `rotation` | REAL | — | 绕中心旋转角（度） |

**表级约束**

- `CHECK (end_sec >= start_sec)`
- `CHECK (move_end_sec IS NULL OR move_start_sec IS NULL OR move_end_sec > move_start_sec)`
- `CHECK (radius IS NULL OR radius > 0)`
- `CHECK (type <> 'polygon' OR shape_kind IS NOT 'poly' OR rings_json IS NOT NULL)`
- `CHECK (type <> 'polygon' OR shape_kind IS NOT 'circle' OR (center_lng IS NOT NULL AND center_lat IS NOT NULL AND radius IS NOT NULL))`
- `CHECK (type <> 'polygon' OR shape_kind IS NOT 'rect' OR (rect_c1_lng IS NOT NULL AND rect_c1_lat IS NOT NULL AND rect_c2_lng IS NOT NULL AND rect_c2_lat IS NOT NULL))`
- `CHECK (type <> 'polygon' OR shape_kind IS NOT 'star' OR (center_lng IS NOT NULL AND center_lat IS NOT NULL AND radius IS NOT NULL))`
- `CHECK (type <> 'arrow' OR arrow_type IS NOT NULL)`
- `CHECK (type <> 'arrow' OR (from_lng IS NOT NULL AND from_lat IS NOT NULL AND to_lng IS NOT NULL AND to_lat IS NOT NULL))`
- `CHECK (type <> 'double_arrow' OR points_json IS NOT NULL)`
- `CHECK (type <> 'gathering' OR (center_lng IS NOT NULL AND center_lat IS NOT NULL AND radius IS NOT NULL))`
- `CHECK (type <> 'encirclement' OR (center_lng IS NOT NULL AND center_lat IS NOT NULL AND radius IS NOT NULL))`

### 组 7 · 疆域类元素（Terr 工具）

#### element_territory

**职责**：疆域元素：势力 / 地块 / 兼并事件 JSON 内联，自包含　**前端**：工具条「疆域」下拉（TerritoryImportDialog.tsx 导入 + 疆域属性面板）

31 列 · 主键 `element_id` · 工具入口：Terr：新建疆域 / 绘制地块 / 兼并（势力、地块、事件 JSON 内联在本表）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `element_id` | TEXT | `PK` | 元素 id（全库唯一，4 张类别表共享同一 id 空间） |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `type` | TEXT | `NOT NULL` | 子类型判别列（固定 territory） · 默认 `'territory'` · `CHECK (type = 'territory')` |
| `name` | TEXT | `NOT NULL` | 元素名（与属性面板首字段 LABEL 同步） · 默认 `''` |
| `visible` | INTEGER | `NOT NULL` | 是否显示（0/1） · 默认 `1` · `CHECK (visible IN (0,1))` |
| `start_sec` | REAL | `NOT NULL` | 出现时间（秒） · `CHECK (start_sec >= 0)` |
| `end_sec` | REAL | `NOT NULL` | 消失时间（秒） |
| `anim_effect` | TEXT | — | 动画效果：grow / move / fill / march / marchplain · `CHECK (anim_effect IS NULL OR anim_effect IN ('grow','move','fill','march','marchplain'))` |
| `label_text` | TEXT | — | 标签文字（与元素名同步） |
| `label_font_size` | REAL | — | 标签字号 |
| `label_color` | TEXT | — | 标签文字颜色 |
| `label_position` | TEXT | — | 标签位置：top/bottom/left/right/center · `CHECK (label_position IS NULL OR label_position IN ('top','bottom','left','right','center'))` |
| `label_offset_x` | REAL | — | 标签水平像素偏移（0=居中，负左正右） |
| `label_offset_y` | REAL | — | 标签垂直像素偏移（0=居中，正值向上） |
| `label_bg_color` | TEXT | — | 标签背景色（默认透明） |
| `label_bg_padding` | REAL | — | 标签背景内边距 |
| `label_bg_radius` | REAL | — | 标签背景圆角 |
| `label_font_weight` | TEXT | — | 标签字重：normal / bold · `CHECK (label_font_weight IS NULL OR label_font_weight IN ('normal','bold'))` |
| `keyframes_json` | TEXT | — | 动画关键帧数组（原 element_keyframe 表内联）：[{property,sec,easing,value_num,value_json}]；property ∈ opacity/scale/rotation/draw_progress/progress/path_progress/fill_progress/morph；同 property 同 sec 不得重复 · `CHECK (keyframes_json IS NULL OR json_valid(keyframes_json))` |
| `ord` | INTEGER | `NOT NULL` | 同章节内排序 · 默认 `0` |
| `display_country_borders` | INTEGER | `NOT NULL` | 是否显示势力边界（0/1） · 默认 `1` · `CHECK (display_country_borders IN (0,1))` |
| `display_plot_borders` | INTEGER | `NOT NULL` | 是否显示地块边界（0/1） · 默认 `1` · `CHECK (display_plot_borders IN (0,1))` |
| `display_border_width` | REAL | `NOT NULL` | 势力边界线宽（px） · 默认 `3` · `CHECK (display_border_width >= 0)` |
| `display_fill_opacity` | REAL | `NOT NULL` | 填充透明度（0–1） · 默认 `0.45` · `CHECK (display_fill_opacity BETWEEN 0 AND 1)` |
| `display_country_names` | INTEGER | `NOT NULL` | 是否显示势力名标签（0/1） · 默认 `1` · `CHECK (display_country_names IN (0,1))` |
| `display_plot_names` | INTEGER | `NOT NULL` | 是否显示地块名标签（0/1） · 默认 `0` · `CHECK (display_plot_names IN (0,1))` |
| `display_label_align` | TEXT | `NOT NULL` | 标签朝向：map 随图 / viewport 面向镜头 · 默认 `'map'` · `CHECK (display_label_align IN ('map','viewport'))` |
| `display_label_scale` | REAL | `NOT NULL` | 标签缩放倍数 · 默认 `1` · `CHECK (display_label_scale > 0)` |
| `countries_json` | TEXT | — | 势力数组：[{countryId,name,color,ord}] · `CHECK (countries_json IS NULL OR json_valid(countries_json))` |
| `plots_json` | TEXT | — | 地块数组：[{plotId,name,rings,ownerId,ord}]；ownerId 须能在 countries_json 中命中（由 v_check_territory_ref 校验） · `CHECK (plots_json IS NULL OR json_valid(plots_json))` |
| `events_json` | TEXT | — | 兼并事件数组：[{eventId,sec,toCountryId,preset,duration_sec,highlight,plotIds[],ord}]；时间与时长均为秒；toCountryId 同上 · `CHECK (events_json IS NULL OR json_valid(events_json))` |

**表级约束**

- `CHECK (end_sec >= start_sec)`

### 组 8 · 叠加层（弹窗）

#### overlay

**职责**：弹窗本体（10 类内容：文本 / 图片 / 图表 / 人物 / 对话…）　**前端**：右侧「弹窗」面板（FxPanelBody.tsx）+ 画面渲染 fx/FxRender.tsx OverlayContentView

23 列 · 主键 `overlay_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `overlay_id` | TEXT | `PK` | 弹窗 id |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `type` | TEXT | `NOT NULL` | 弹窗类型：custom / chart / person / report / timeline / quote / compare / counter / dialogue / place · `CHECK (type IN ( 'custom','chart','person','report','timeline','quote','compare', 'stat','seal','iconRow', 'counter','dialogue','place'))` |
| `name` | TEXT | `NOT NULL` | 显示名（时间线轨道上展示） · 默认 `''` |
| `position` | TEXT | `NOT NULL` | 九宫格位置：top / topLeft / center / bottomRight 等 9 种 · `CHECK (position IN ( 'top','bottom','left','right','center', 'topLeft','topRight','bottomLeft','bottomRight'))` |
| `start_sec` | REAL | `NOT NULL` | 出现时间（秒） · `CHECK (start_sec >= 0)` |
| `end_sec` | REAL | `NOT NULL` | 消失时间（秒） |
| `animation` | TEXT | — | 入场动画预设 |
| `exit_animation` | TEXT | — | 退场动画预设（结束前 20 帧播放） |
| `scale` | REAL | — | 整体缩放 |
| `offset_x` | REAL | `NOT NULL` | 横向微调（%，-40..40） · 默认 `0` |
| `offset_y` | REAL | `NOT NULL` | 纵向微调（%，-40..40） · 默认 `0` |
| `z_index` | INTEGER | `NOT NULL` | 层级 · 默认 `0` |
| `bg_color` | TEXT | — | 卡片背景色 |
| `bg_opacity` | REAL | — | 卡片背景不透明度（0–1） · `CHECK (bg_opacity IS NULL OR bg_opacity BETWEEN 0 AND 1)` |
| `bg_blur` | REAL | — | 卡片背景模糊半径 |
| `bg_radius` | REAL | — | 卡片圆角半径 |
| `bg_border` | TEXT | — | 卡片边框颜色 |
| `payload_json` | TEXT | — | 类型专属载荷整体存取：custom 内容块 / person 人物块 / report/quote/compare/chart 等 · `CHECK (payload_json IS NULL OR json_valid(payload_json))` |
| `person_layout_json` | TEXT | — | 人物卡版式：图片方位/对齐/间距/卡片宽/名言样式/叠图 · `CHECK (person_layout_json IS NULL OR json_valid(person_layout_json))` |
| `audio_asset_id` | TEXT | `FK → asset SET NULL` | 背景语音（卡片可见时播放；导出混流待支持） |
| `parent_overlay_id` | TEXT | `FK → overlay CASCADE` | 父弹窗（group 嵌套结构） |
| `ord` | INTEGER | `NOT NULL` | 同章节内排序 · 默认 `0` |

**表级约束**

- `CHECK (end_sec >= start_sec)`

### 组 9 · 应用配置

#### provider

**职责**：AI 服务商配置：文案生成 / 语音（含克隆）/ 图片生成（Key 只存本机，与项目内容解耦）　**前端**：顶栏「设置 · AI」弹窗（SettingsDialog.tsx，左侧切换三类能力）

12 列 · 主键 `provider_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `provider_id` | TEXT | `PK` | 服务商配置 id |
| `kind` | TEXT | `NOT NULL` | 类别：llm 文案生成 / tts 语音合成（含克隆）/ image 图片生成 · `CHECK (kind IN ('llm','tts','image'))` |
| `label` | TEXT | `NOT NULL` | 显示名 · 默认 `''` |
| `base_url` | TEXT | `NOT NULL` | 接口基础地址 · 默认 `''` |
| `api_key` | TEXT | `NOT NULL` | 密钥（只存本机，不入项目文件） · 默认 `''` |
| `model` | TEXT | `NOT NULL` | 模型名 / TTS 音色模型 · 默认 `''` |
| `protocol` | TEXT | — | TTS 协议：openai-speech / minimax-t2a / volc-tts / qwen-tts / custom · `CHECK (protocol IS NULL OR protocol IN ( 'openai-speech','minimax-t2a','volc-tts','qwen-tts','custom'))` |
| `voice` | TEXT | — | 音色 / 说话人 ID |
| `speed` | REAL | `NOT NULL` | 语速（0.5–2） · 默认 `1` · `CHECK (speed BETWEEN 0.5 AND 2)` |
| `extra` | TEXT | — | 附加请求参数（JSON，合并进请求体） · `CHECK (extra IS NULL OR json_valid(extra))` |
| `active` | INTEGER | `NOT NULL` | 是否生效（每个 kind 至多一条为 1） · 默认 `0` · `CHECK (active IN (0,1))` |
| `ord` | INTEGER | `NOT NULL` | 同类内排序 · 默认 `0` |

<!-- FIELD-DICT:END -->

## 五、工具栏与元素类型：6 个按钮 → 4 张表 / 12 种元素

更正：本文早前写作「13 张元素子表 = 工具条上的 13 个按钮」，不准确；按新设计也不再是「一个类型一张表」。工具栏实际只有 **6 个按钮**（标记 / 路线 / 图片 / 形状 / 区域 / 疆域），其中「形状」「疆域」带下拉子菜单、共 19 + 4 个绘制项；**元素按工具栏聚合为 4 张类别宽表**，表内用 `type` 判别列区分子类型。图片类（Image 工具）已下线。

| 工具条按钮 | 交互方式 | 落到哪张表的哪个 type |
|---|---|---|
| **标记** Pin | 一键放到地图中心，之后在面板里改样式/换形态 | `element_marker`：`point`（圆点/水滴针/气泡/Emoji/文字） 切到 Marker → `flag`；军标导入/旧数据 → `military_symbol` |
| **路线** Route | 进入绘制模式，采点成线 | `element_route`：`line`（线型与路线特效在右侧 Settings 切换） |
| **图片** Image | 已下线 | **已移除**：`custom_icon` 元素类型与 Image 工具不再存在 |
| **形状** Shape | 下拉菜单三组共 19 项：多点绘制 / 两点绘制 / 特殊图形 | `element_shape`：`polygon`（多边形/曲线多边/防御圈/圆/矩形/五角星）、`arrow`（带箭头/行军/燕尾/自定义）、`double_arrow`（钳形）、`gathering`（集结点） 其中带箭头/战线的直线属**路线表** `line` |
| **区域** Region | 打开行政区选择器，点国家/地区 | `element_shape` 的 `polygon`（按边界自动生成可编辑高亮面，跨海国家拆多个面）——**与形状共用一张表** |
| **疆域** Terr | 下拉菜单 4 项：新建疆域 / 导入 / 绘制地块 / 兼并 | `element_territory`（势力 / 地块 / 兼并事件 JSON 全部内联在本表） |

#### 当前没有工具栏入口的元素类型

    - `flag`（旗帜）：没有独立按钮，靠**标记面板切到 Marker** 原地改类型得到（同一张 `element_marker`）。

    - `moving_point`（移动点）、`encirclement`（包围圈）：绘制模式在代码里已实现，但工具条上没有按钮触发。

    - `military_symbol`（军标）、`connector`（连接线）：连绘制模式都没有，目前只能靠导入或旧数据存在（渲染端支持）。

看元素列表、画时间线轨道时查视图 `v_element_index`（四张类别表的公共列 UNION，**不需要 4 路 JOIN**）；真正画地图时才按已知的 `type` 去取对应类别表的专属列。

| 地图上的东西 | 表 | type 取值 | 专属字段（举例） |
|---|---|---|---|
| 点标记 | `element_marker` | `point` | shape（9 种）、emoji、scale、orientation、rotation、color、asset_id / builtin_id / icon_lib+icon_name、visual_meta_json |
| 旗帜 | `element_marker` | `flag` | flag_text、flag_color、flag_width |
| 军标（APP-6） | `element_marker` | `military_symbol` | sidc、echelon、symbol_size |
| 路线 / 飞线 | `element_route` | `line` | coords_json、line_type、route_effect_json、flow_speed |
| 移动点（带拖尾） | `element_route` | `moving_point` | coords_json、trail_color、trail_length |
| 连接线（连两个元素） | `element_route` | `connector` | **from_element_id / to_element_id**（弱引用，无外键） |
| 区域（多边形/矩形/圆/五角星） | `element_shape` | `polygon` | shape_kind、circle_meta_json、rect_meta_json、star_meta_json |
| 箭头（多种） | `element_shape` | `arrow` | arrow_type、from/to、path_json |
| 双箭头 / 钳形 | `element_shape` | `double_arrow` | points_json（走 `buildDoubleArrow` 几何） |
| 包围圈 / 集结点 | `element_shape` | `encirclement` / `gathering` | center_lng/lat、radius、pulse_animation |
| 疆域（势力/地块/兼并） | `element_territory` | `territory` | display_json ＋ countries_json / plots_json / events_json |

### 点标记的 9 种形态与能力矩阵

这张矩阵同时驱动三处：**属性面板**（不满足则隐藏控件）、**数据库 CHECK**（不满足则拒绝写入）、**渲染端**（按形态选管线）。

| 形态 | shape | 资源来源 | 缩放 | 贴地 flat | 旋转 | 着色 | 专属参数（visual_meta_json） |
|---|---|---|---|---|---|---|---|
| 圆点 | `circle` | — | ✓ | ✓ | ✓ | ✓ | — |
| 水滴针 | `pin` | — | ✓ | ✓ | ✓ | ✓ | — |
| 气泡 | `bubble` | — | ✓ | ✓ | ✓ | ✓ | — |
| 文字 | `text` | — | ✓ | ✓ | ✓ | ✓ | — |
| 表情 | `emoji` | 内置字符 | ✓ | ✓ | ✓ | ✗（自带色） | — |
| **图片** | `image` | 内置图集 / 上传 png·jpg·webp·**svg** | ✓ | ✓ | ✓ | ✓ | `{fit, tintable}` |
| **GIF** | `gif` | 内置动图 / 上传 gif·webp | ✓ | ✓ | ✓ | **✗**（多帧彩色） | `{fps, loop}` |
| **模型** | `model` | 内置模型 / 上传 glb·gltf | ✓ | **✗**（强制 3D 朝向） | ✓ | **✗**（多材质） | `{scale, altitude, autoRotate, spin, pitchAlign, animation}` |
| **图标库** | `icon` | lucide / react-icons / 自建库 | ✓ | ✓ | ✓ | ✓ | `{strokeWidth}` |

资源两来源：**`asset_id`**（用户上传，进 asset 表外置存储）与 **`builtin_id`**（内置资源，打包进应用、不入库）；图标形态额外用 `icon_lib` + `icon_name` 定位，自建库条目落在 `asset`（`kind='icon'`，`UNIQUE` 由应用层保证）。

## 六、容易混淆的 5 组

| 容易混的地方 | 区别 |
|---|---|
| `element_marker` / `element_route` / `element_shape` / `element_territory` vs 表内 `type` | 四张表按**工具栏**分（标记 / 路线 / 形状 / 疆域）；表内的 `type` 才是具体元素类型（point / line / polygon…）。找元素先看它在哪个工具下，再用 `type` 区分 |
| `label_json` vs `keyframes_json`（都是元素表内的一列） | 前者是**文字气泡内容**，后者是**动画曲线**（8 种属性的关键帧数组）—— 都作为一列 JSON 跟随元素一起读写，不再独立成表 |
| `narration` vs `narration_entry` | 前者是「这一章的配音档」（样式、总开关，1:1）；后者是「档里的一条条字幕」（1:N） |
| `overlay` 的内容块 | custom 的内容块 / person 的人物块内联在 `overlay.payload_json`，不再单独建表 |

## 七、一次「打开」与一次「保存」

#### 打开项目（读）

      - 读 `project`（身份 / 归属 / 生效底图 + 全局配置列）一行

      - 读 `chapter`（按 `order_index`）→ 章节列表与时间轴

      - 查视图 `v_element_index`（四张类别表的公共列 UNION）→ 时间线轨道与元素列表（**不做 JOIN**）

      - 按需取类别表：只有真正要渲染的元素才查它所属的类别表（marker / route / shape / territory），连带取出专属列

      - 组装回 `MapVideoProject` 对象交给 store（上层无感）

#### 保存项目（写）

      - 整个保存过程放在**一个事务**里（实测：逐条提交 vs 单事务差 63 倍）

      - 先写父表（`project` → `chapter` → `元素类别表`）；连接线端点是**弱引用**，须先建被引用元素

      - 二进制素材先入 `asset`，业务表只写 `asset_id`

      - 同类别内切换子类型只需 `UPDATE type` + 补齐该子类型的必填字段（CHECK 会校验）；**跨类别**切换则是「删旧表行 → 插新表行」

      - 保存后跑一遍一致性自检视图（`v_check_dangling` / `v_check_territory_ref`），应全部返回 0 行

#### 注意：本文是设计稿

本文描述的是**目标结构**；`electron/main.mjs` 与 `src/stores/db.ts` 目前是「项目 JSON + 合集 + 素材」的简化实现，尚未按本设计的多表结构落地。落地需要一个承载「多表 ↔ `MapVideoProject`」双向映射的模块。未决问题见 `docs/db-redesign.md` 末节。

## 附：3 个视图，以及为什么没有触发器

表之外原本还有触发器；本设计**不定义任何触发器**，理由见本节末尾。

### 3 个视图（不存数据，只是固化查询）

| 视图 | 类别 | 作用 |
|---|---|---|
| `v_element_index` | 读取便利 | 把 4 张类别表的公共列 UNION 成一张「元素总表」：取消基表后，轨道 / 列表 / 计数查这里，不用手写 4 表 UNION |
| `v_check_dangling` | 一致性自检 | 查悬空引用：连接线指向已删除的元素、关键帧挂在已删除的元素上、跟随机位指向已删除的路线。迁移后与老库体检用，正常应返回 0 行 |
| `v_check_territory_ref` | 一致性自检 | 疆域 JSON 内部一致性：`plots_json` 的 `ownerId`、`events_json` 的 `toCountryId` 必须能在 `countries_json` 中命中（复合外键被 JSON 化后的补偿） |

### 为什么没有触发器（原 6 条已全部移除）

原本 6 个触发器补的是外键表达不了的两类规则：`trg_camera_follow_chapter_ins/_upd`（跟随机位只能引用同一章节内的路线元素）、`trg_marker/route/shape/territory_cleanup`（弱引用反向清理）。**2026-09-12 起全部移除**，原因：

1. **双端不一致**：网页端是 Dexie（IndexedDB），**没有触发器** —— 数据库侧触发器只在桌面端生效，同一条规则会有两套真相；
2. **规则藏在表定义之外**：读 DDL 看不出「删一个元素到底连带删掉什么」；
3. **与写入端逻辑重复**：隐式行为干扰调试、导入与数据修复。

这些规则改由**应用层**（唯一的写入路径）保证，两端行为一致：

| 原触发器承担的规则 | 现在由谁保证 |
|---|---|
| 删元素 → 连带删除以它为端点的 connector、以及挂在它名下的关键帧 | 应用层删除元素时一并清理 |
| 跟随机位只能引用同一章节内的路线元素 | 写入端校验（选择跟随机位时只列本章路线） |

数据库侧只保留 `v_check_dangling` / `v_check_territory_ref` 两个**自检视图**：它们不拦截写入，只把「数据已损坏」从隐性变成可检测。

MapVideo V2 表清单速查 · 由 `docs/db-schema-v2.sql` 与 `src/types/index.ts` 的实际定义整理，表名、主键、外键均取自 DDL 实测解析结果。

配套文件：`docs/db-redesign.md`（设计依据与选型对比）· `docs/db-schema-v2.sql`（可执行 DDL）· `tools/audit-fk-indexes.mjs`（外键索引审计）
