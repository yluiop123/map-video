# MapVideo V2 表清单速查

> 23 张表、3 个视图、6 个触发器 —— 元素表按工具栏分为 4 张类别宽表，从「整个项目塞进一列 JSON」到「规范化关系表」的逐表对照。

- **数据源**：`docs/db-schema-v2.sql`（唯一事实源，DDL 已实测可执行）
- **设计依据**：`docs/db-redesign.md`
- **规模**：23 张表 · 4 张元素类别宽表 · 3 个视图 · 6 个触发器 · 33 个外键（32 个有索引，1 个有意豁免）

**目录**

- 一、23 张表从哪来
- 二、V1 字段 → V2 表（完整对照）
- 三、23 张表逐表速查（按 10 组）
- 四、每张表的字段（字段字典）
- 五、工具栏与元素类型
- 六、容易混淆的 5 组
- 七、一次「打开」与一次「保存」
- 附：3 个视图与 6 个触发器

## 一、23 张表从哪来

先把最容易误解的一点说清楚：**23 张表不是 23 个新概念**。它们是同一个项目文档按「字段从哪来、怎么用」拆开的结果。V1 的库层只有两张表 —— `projects(id, name, data, size, updated_at)` 与 `providers`，其中 `data` 一列装着整个项目的 JSON；Dexie 端是一样的单表结构。所以 V2 的 23 张表，本质是把这个 JSON 的字段按下面四条规则分流：

| 规则 | 判据 | 处理方式 | 落到的表 |
|---|---|---|---|
| **P1** 必列化 | 身份、时间、引用关系 —— 需要检索、排序、约束 | 提升为独立列 | `element_marker` / `element_route` / `element_shape` / `element_territory` 的公共列、`chapter` 的公共列 |
| **P2** 独立成表 | 自身有 id 或顺序语义，需被单独寻址或约束 | 1:N 子表 | `element_keyframe`、`overlay_block`、`narration_entry` |
| **P3** 留下 JSON | 固定形状、整体读写、不参与约束与检索的配置块 | JSON 列 + `json_valid()` | `display_json`、`title_style_json`、`transition_json`、`countries_json` / `plots_json` / `events_json` 等 |
| **P4** 外置存储 | 大体积二进制（图片、音频、视频、字体） | 独立 `asset` 表，业务表只留 `asset_id` | `asset` |

#### 一句话理解 23 张表的构成

- **4 张**是「元素」，按**工具栏按钮**聚合：标记 · 路线 · 形状 · 疆域**各一张宽表**，表内用 `type` 判别列区分该工具下的全部子类型（详见第三节、第五节）；
- **1 张**是「元素附属」：`element_keyframe`（所有元素共用的动画关键帧，按 `element_id` 弱引用）；
- **7 张**是「章节的子集合」：章节里能放的东西，除去元素之外都在这里（镜头关键帧、弹窗、特效、字幕、配乐…）；
- **4 张**是「素材库」（底图、高程图、自定义图标、二进制素材）；
- **3 张**是「弹窗内容块」；
- **4 张**是合集、项目本体、项目配置与应用配置。

## 二、V1 字段 → V2 表（完整对照）

下表左边是你在代码里看到的 `MapVideoProject` / `Chapter` 字段（`src/types/index.ts`），右边是它落到了哪张表。这是理解这套设计最直接的入口。

| V1 结构（src/types/index.ts） | 落到 V2 | 处理方式与理由 |
|---|---|---|
| （合集层级，V1 无对应字段） | `collection` + `project.collection_id` | 新增：项目之上加一层分组（合集 ▸ 项目 ▸ 章节 ▸ 元素）；未指定归属时落默认合集 `default` |
| `MapVideoProject.id / name / description / createdAt / updatedAt` | `project` | P1 列化 |
| `globalConfig`（defaultDuration / defaultFPS / defaultResolution / defaultEasing / projection） | `project_config` | P2 独立成表：配置与项目本体职责分离（1:1，主键即外键）；配置面板只读写这张表 |
| `baseMaps[]` + `activeBaseMapId` | `base_map` + `project.active_base_map_id` | P2；循环外键用 `SET NULL` 断开 |
| `elevationMaps[]` + `activeElevationMapId` | `elevation_map` + `project.active_elevation_map_id` | P2 |
| `customSymbols[]`（`url` 可能是 data URL） | `custom_symbol` + `asset` | 元数据留表内，二进制走 P4 外置 新增 |
| `chapters[]` | `chapter` | P1；`titleStyle` / `transition` 按 P3 留在 JSON 列 |
| `chapters[].elements[]` | `element_marker` / `element_route` / `element_shape` / `element_territory`（4 张类别宽表） | P1 公共字段 + 表内 `type` 判别子类型（取消基表） |
| `elements[].style`（`Keyframe[]` 数组） | `element_keyframe` | P2：8 种 property 统一一张表，带时间轴语义与唯一约束 |
| `elements[].label`（`LabelConfig`） | 各元素表的 `label_json` 列 | P3 内联：取消基表后 1:1 附属表失去统一外键目标，改为内联 JSON 列 |
| `chapters[].camera[]` | `camera_keyframe` | P2；`followRoute.routeElementId` 变成外键（删路线 → 退化为固定视角） |
| `chapters[].overlays[]` | `overlay` + `overlay_block` + `person_block` | P2：本体一张，两类内容块各一张 |
| `chapters[].effects[]`（`ChapterEffect`） | `chapter_fx` | P2 |
| `chapters[].fx[]`（`ScreenFxItem`） | `screen_fx` | P2：屏幕空间特效窗口，与地图元素区分 |
| `chapters[].narration`（`NarrationTrack`） | `narration` + `narration_entry` | P2：档（样式/1:1）+ 条目（1:N） |
| `chapters[].music[]` | `music_track` | P2；音频本体走 `asset` |
| `territory` 元素内的 `countries / plots / events` | `element_territory` 的 `countries_json` / `plots_json` / `events_json` | P3 内联：疆域自包含、整体读写；代价是失去复合外键，由 `v_check_territory_ref` 视图兜底 |
| — | `asset` | 新增 V1 把图片/音频以 base64 塞在 JSON 里，保存时全量重写 |
| `providers`（V1 就是独立表） | `provider` | 保持独立；新增「每 kind 至多一条 active」的部分唯一索引 |

## 三、23 张表逐表速查（按 10 组）

读法：**表名** · 一句话职责 · 主键 · 删除行为。V1 已有 表示这张表 V1 就存在（仅 `projects` 与 `providers` 两张，其余都是新拆出来的）。

### 组 1 · 合集与项目（含配置） 3 张

| 表 | 职责 | 主键 | 关键点 |
|---|---|---|---|
| `collection` | 项目之上的一层分组（合集 ▸ 项目 ▸ 章节 ▸ 元素） | `collection_id` | 默认合集恒为 `default`：**不可改名、不可删除**；删其它合集时其下项目回落默认合集（**不删项目**） |
| `project` | 项目本体：身份 + 归属 + 审计字段 + 当前生效的底图与高程图 | `project_id` | `collection_id` 指回所属合集（默认 `default`）；`active_base_map_id` 有意不建索引（恒 1 行，扫描成本是常数） |
| `project_config` | 项目级配置（GlobalConfig）：默认时长 / 帧率 / 分辨率 / 缓动 / 投影 | `project_id` | 与 `project` **1:1**（主键即外键）；配置独立成表，配置面板只读写这张表 |

### 组 2 · 资源与素材 4 张

| 表 | 职责 | 主键 | 删除行为 |
|---|---|---|---|
| `base_map` | 底图配置（MapLibre style URL 或内联样式） | `base_id` | 删项目 → 级联 |
| `elevation_map` | 高程/地形栅格源（含编码、夸张系数） | `emap_id` | 删项目 → 级联；被章节/项目引用则置空 |
| `custom_symbol` | 自定义图标库（icon / image / svg 的元数据） | `symbol_id` | 被元素占用时 **RESTRICT 拒绝删除**（旧实现会静默损坏图标） |
| `asset` 新增 | 所有大体积二进制的唯一入口（图片/音频/视频/字体），按 `sha256` 去重 | `asset_id` | 孤儿回收是待办项（需定期清理或引用计数） |

### 组 3 · 章节与时间轴 7 张

一个 `Chapter` 对象里的 7 类子集合，逐类一张表。

| 表 | 对应 V1 字段 | 主键 | 关键字段 / 行为 |
|---|---|---|---|
| `chapter` | `Chapter` 本体 | `chapter_id` | 绝对帧区间；标题样式/转场按 P3 留在 JSON 列 |
| `camera_keyframe` | `camera[]` | `kf_id` | `frame` 是**到达时间**，`move_duration` 是起飞提前量；`follow_route_element_id` 删路线后 `SET NULL`（退化为固定视角） |
| `screen_fx` | `fx[]` | `fx_id` | 屏幕空间特效窗口（天气/画面），与地图元素分离 |
| `chapter_fx` | `effects[]` | `fx_id` | 章节级特效（动画预设等） |
| `narration` | `narration` 的样式部分 | `chapter_id` | 1:1，主键即外键 |
| `narration_entry` | `narration.entries[]` | `entry_id` | 一条字幕 = 一行；音频走 `asset` |
| `music_track` | `music[]` | `track_id` | 章内可多段；音频走 `asset` |

### 组 4 · 标记类元素 1 张 Pin 工具

工具条「标记」按钮的产出：一键在当前地图中心放置。三种标记形态（点 / 旗标 / 军标）**合并进同一张宽表**，用 `type` 判别列区分；公共字段（章节、时间轴、层级、可见性、标签、移动图标）每行都有。

| 表 | type 取值 | 主键 | 工具入口 | 存什么 |
|---|---|---|---|---|
| `element_marker` | `point` | `element_id` | Pin 工具（一键放置） | 经纬度、**9 种形态**（圆点/文字/水滴针/气泡/表情 ＋ 图片/GIF/模型/图标库）、缩放、朝向、贴地旋转、资源引用（asset_id / builtin_id / icon_lib+icon_name） |
| `element_marker` | `flag` | `element_id` | 标记面板切到 Marker（原地改类型） | 位置、旗面文案（flag_text）、配色、字号、宽度 |
| `element_marker` | `military_symbol` | `element_id` | **当前无入口**（导入 / 旧数据） | 军标 SIDC、位置、旋转、梯队、附加文字 |

### 组 5 · 路线类元素 1 张 Route 工具

「路线」按钮的产出：进入绘制模式采点成线。线型（直线/贝塞尔/大圆弧）与路线特效都在右侧 Settings 里切换，不新增表。移动点与连接线也并入本表。

| 表 | type 取值 | 主键 | 工具入口 | 存什么 |
|---|---|---|---|---|
| `element_route` | `line` | `element_id` | Route 工具；Shape 下菜单里的直线/曲线/带箭头/战线/行军箭头也写这张表 | 路径数组（coords_json）、线型、线宽虚线、路线特效、流动速度、无样式路线、战线梳齿 |
| `element_route` | `moving_point` | `element_id` | **当前无入口**（绘制模式已实现，工具条无按钮） | 路径点数组、拖尾颜色/宽度/长度 |
| `element_route` | `connector` | `element_id` | **当前无入口** | 起止端点（**弱引用**：元素已分表故无外键，删端点由清理触发器连带删除）、线宽/颜色/箭头 |

### 组 6 · 形状类元素 1 张 Shape 工具

「形状」按钮带下拉菜单，分三组共 19 项：多点绘制 / 两点绘制 / 特殊图形；五种形状**合并进同一张宽表**。**区域工具（Region）的行政区高亮也写这张表**——它的产物就是 `polygon`，因此不单列一组。

| 表 | type 取值 | 主键 | 工具入口 | 存什么 |
|---|---|---|---|---|
| `element_shape` | `polygon` | `element_id` | Shape：多边形 / 曲线多边 / 直线·曲线防御圈 / 圆 / 矩形 / 五角星 ＋**Region 工具** | 环数组、填充描边、形状种类与各自元数据、曲线化、防御圈锯齿、渐变、旋转 |
| `element_shape` | `arrow` | `element_id` | Shape：带箭头直线/曲线、行军箭头、燕尾箭头、自定义燕尾、自定义箭头 | 起终点、弯曲控制点、箭头类型、宽度、填充透明度、绘制缩放 |
| `element_shape` | `double_arrow` | `element_id` | Shape：钳形（4 点自动合成） | 4 个控制点（points_json）、颜色 |
| `element_shape` | `gathering` | `element_id` | Shape：集结点（两点绘制） | 中心、半径、颜色、脉冲、旋转 |
| `element_shape` | `encirclement` | `element_id` | **当前无入口**（绘制模式已实现，工具条无按钮） | 中心、半径、填充与描边色 |

### 组 7 · 疆域类元素 1 张 Terr 工具

「疆域」按钮带下拉菜单：新建疆域 / 导入 / 绘制地块 / 兼并。势力、地块、兼并事件**全部 JSON 内联**进本表（`countries_json` / `plots_json` / `events_json`），疆域自包含、整体读写。

| 表 | 主键 | 工具入口 | 职责 |
|---|---|---|---|
| `element_territory` | `element_id` | Terr：新建疆域 / 绘制地块 / 兼并 | `display_json` 显示配置 + 三个 JSON 列承载原 `territory_*` 四张表的全部内容；`plot.ownerId` / `event.toCountryId` 的合法性由 `v_check_territory_ref` 视图校验 |

### 组 8 · 元素附属（跨类别） 1 张 跨类别

取消 `element` 基表后，被所有元素共用的附属表只剩动画关键帧；标签已内联进各元素表的 `label_json` 列。

| 表 | 职责 | 主键 | 关键点 |
|---|---|---|---|
| `element_keyframe` | 元素动画关键帧 | `kf_id` | **所有元素共用**；8 种 property（透明度/缩放/旋转/绘制进度/路径进度/填充进度/morph）统一一张表；`element_id` 为**弱引用**（元素分属 4 张表），删元素由清理触发器连带删除；`chapter_id` 仍是外键 |

### 组 9 · 叠加层（弹窗） 3 张

| 表 | 职责 | 主键 | 关键点 |
|---|---|---|---|
| `overlay` | 弹窗本体（10 类：文本/图片/图表/人物/对话…） | `overlay_id` | 图表/时间轴/对话等内容按 P3 留在 `payload_json` |
| `overlay_block` | custom 类弹窗的内容块序列 | `block_id` | 只有需要逐块排序的弹窗才用 |
| `person_block` | 人物卡片的内容块（头像/姓名/简介/引言/对白） | `block_id` | 5 种块类型，带版式配置 |

### 组 10 · 应用配置 1 张 V1 已有

| 表 | 职责 | 主键 | 关键点 |
|---|---|---|---|
| `provider` | LLM / TTS 服务商配置 | `provider_id` | 与项目内容解耦（Key 只存本机）；`ux_provider_active` 保证每个 kind 至多一条生效 |

## 四、每张表的字段（字段字典）

<!-- FIELD-DICT:BEGIN -->
> 本节由 DDL 自动生成（`tools/gen-db-field-dict.mjs`），共 **23 张表 / 339 个列，每列都有中文说明**。字段说明取自 `tools/db-field-notes.mjs`（人工词表，339 条），结构与约束取自 DDL；脚本会与 SQLite 实测结构交叉校验，并强制「每个字段必须有说明」，缺一条就报错。

> 元素相关的 **4 张类别宽表按工具条分类**（标记 / 路线 / 形状 / 疆域），每张表用 `type` 判别列承载该工具下的全部元素类型；图片类（Image 工具）已下线。工具条的完整对照见本文第五节。

> 读法：**列**为字段名；**约束**中 `PK` 主键、`NOT NULL` 必填、`FK` 外键（其后为删除行为：CASCADE 级联删除 / SET NULL 置空 / RESTRICT 拒绝删除）。

#### 快速跳转

- **组 1 · 合集与项目（含配置）**：`collection` · `project` · `project_config`
- **组 2 · 资源与素材**：`base_map` · `elevation_map` · `custom_symbol` · `asset`
- **组 3 · 章节与时间轴**：`chapter` · `camera_keyframe` · `screen_fx` · `chapter_fx` · `narration` · `narration_entry` · `music_track`
- **组 4 · 标记类元素（Pin 工具）**：`element_marker`
- **组 5 · 路线类元素（Route 工具）**：`element_route`
- **组 6 · 形状类元素（Shape 工具）**：`element_shape`
- **组 7 · 疆域类元素（Terr 工具）**：`element_territory`
- **组 8 · 元素附属（跨类别）**：`element_keyframe`
- **组 9 · 叠加层（弹窗）**：`overlay` · `overlay_block` · `person_block`
- **组 10 · 应用配置**：`provider`

### 组 1 · 合集与项目（含配置）

#### collection

5 列 · 主键 `collection_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `collection_id` | TEXT | `PK` | 合集 id（默认合集恒为 default，不可删除） |
| `name` | TEXT | `NOT NULL` | 合集名（默认合集名为「默认合集」，不可改名） |
| `ord` | INTEGER | `NOT NULL` | 合集排序（默认合集固定 -1，恒排最前） · 默认 `0` |
| `created_at` | INTEGER | `NOT NULL` | 创建时间（毫秒时间戳） |
| `updated_at` | INTEGER | `NOT NULL` | 最后修改时间（毫秒时间戳） |

#### project

8 列 · 主键 `project_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `project_id` | TEXT | `PK` | 项目 id |
| `name` | TEXT | `NOT NULL` | 项目名 |
| `description` | TEXT | — | 项目描述 |
| `collection_id` | TEXT | `NOT NULL` `FK → collection RESTRICT` | 所属合集（默认 default）；删合集时其下项目回落到默认合集 · 默认 `'default'` |
| `created_at` | INTEGER | `NOT NULL` | 创建时间（毫秒时间戳） |
| `updated_at` | INTEGER | `NOT NULL` | 最后保存时间（毫秒时间戳） |
| `active_base_map_id` | TEXT | `FK → base_map SET NULL` | 当前生效底图（删除该底图则置空） |
| `active_elevation_map_id` | TEXT | `FK → elevation_map SET NULL` | 当前生效高程图（删除则置空） |

#### project_config

8 列 · 主键 `project_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `project_id` | TEXT | `PK` `FK → project CASCADE` | 所属项目（1:1，主键即外键） |
| `default_duration` | INTEGER | `NOT NULL` | 默认章节时长（帧） · `CHECK (default_duration > 0)` |
| `default_fps` | INTEGER | `NOT NULL` | 默认帧率（1–240） · `CHECK (default_fps BETWEEN 1 AND 240)` |
| `resolution_w` | INTEGER | `NOT NULL` | 默认导出宽度（px） · `CHECK (resolution_w > 0)` |
| `resolution_h` | INTEGER | `NOT NULL` | 默认导出高度（px） · `CHECK (resolution_h > 0)` |
| `resolution_label` | TEXT | `NOT NULL` | 分辨率标签（如 1080p） |
| `default_easing` | TEXT | `NOT NULL` | 默认缓动类型 |
| `projection` | TEXT | `NOT NULL` | 地图投影：mercator 平面 / globe 3D 球体 · 默认 `'mercator'` · `CHECK (projection IN ('mercator','globe'))` |

### 组 2 · 资源与素材

#### base_map

5 列 · 主键 `base_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `base_id` | TEXT | `PK` | 底图 id |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `name` | TEXT | `NOT NULL` | 底图名 |
| `style` | TEXT | `NOT NULL` | MapLibre style URL 或内联样式 JSON |
| `ord` | INTEGER | `NOT NULL` | 同项目内排序 · 默认 `0` |

#### elevation_map

8 列 · 主键 `emap_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `emap_id` | TEXT | `PK` | 高程图 id |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `name` | TEXT | `NOT NULL` | 高程图名 |
| `url` | TEXT | `NOT NULL` | 高程栅格瓦片 URL（terrain-rgb / terrarium） · 默认 `''` |
| `encoding` | TEXT | — | 高程编码格式：mapbox / terrarium · `CHECK (encoding IS NULL OR encoding IN ('mapbox','terrarium'))` |
| `exaggeration` | REAL | — | 地形夸张系数 |
| `style` | TEXT | — | 可选的关联底图样式 |
| `ord` | INTEGER | `NOT NULL` | 同项目内排序 · 默认 `0` |

#### custom_symbol

10 列 · 主键 `symbol_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `symbol_id` | TEXT | `PK` | 图标 id |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `name` | TEXT | `NOT NULL` | 图标名（icon 形态由 element_marker.icon_name 引用它） |
| `ns` | TEXT | `NOT NULL` | 命名空间 / 自建库名（内置 lucide·react-icons 不进库；用户自建库写这里，默认 custom） · 默认 `'custom'` |
| `kind` | TEXT | `NOT NULL` | 图标类型：icon 图标 / image 图片 / svg 矢量 / gif 动图 · `CHECK (kind IN ('icon','image','svg','gif'))` |
| `asset_id` | TEXT | `FK → asset RESTRICT` | 图标二进制素材（V2 外置存储） |
| `url` | TEXT | — | 兼容字段：外链地址或 data URL（旧数据） |
| `width` | INTEGER | `NOT NULL` | 原始宽度（px，统一规范为 64×64） · 默认 `64` · `CHECK (width > 0)` |
| `height` | INTEGER | `NOT NULL` | 原始高度（px） · 默认 `64` · `CHECK (height > 0)` |
| `ord` | INTEGER | `NOT NULL` | 同项目内排序 · 默认 `0` |

**表级约束**

- `CHECK (asset_id IS NOT NULL OR url IS NOT NULL)`
- `UNIQUE (project_id, ns, name)`

#### asset

14 列 · 主键 `asset_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `asset_id` | TEXT | `PK` | 素材 id |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `kind` | TEXT | `NOT NULL` | 素材种类：image 图片 / gif 动图 / model 3D 模型 / audio 音频 / video 视频 / font 字体 · `CHECK (kind IN ('image','gif','model','audio','video','font'))` |
| `mime` | TEXT | `NOT NULL` | MIME 类型（如 image/png） |
| `byte_size` | INTEGER | `NOT NULL` | 原始字节数 · `CHECK (byte_size >= 0)` |
| `sha256` | TEXT | `NOT NULL` | 内容哈希，同图去重（内容寻址） |
| `storage` | TEXT | `NOT NULL` | 存放方式：file 外置文件 / blob 库内联 · `CHECK (storage IN ('file','blob'))` |
| `rel_path` | TEXT | — | 外置方式下的相对路径（相对 userData/assets/） |
| `blob` | BLOB | — | 内联方式下的小文件二进制 |
| `width` | INTEGER | — | 图片宽度（px） |
| `height` | INTEGER | — | 图片高度（px） |
| `duration_ms` | INTEGER | — | 音视频时长（毫秒） |
| `meta_json` | TEXT | — | 媒体元信息（免下载即可预览/校验）：model={bbox,animations,triangles}；gif={frames,fps,loop} · `CHECK (meta_json IS NULL OR json_valid(meta_json))` |
| `created_at` | INTEGER | `NOT NULL` | 入库时间（毫秒时间戳） |

**表级约束**

- `CHECK ((storage = 'file' AND rel_path IS NOT NULL) OR (storage = 'blob' AND blob IS NOT NULL))`

### 组 3 · 章节与时间轴

#### chapter

11 列 · 主键 `chapter_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `chapter_id` | TEXT | `PK` | 章节 id |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `title` | TEXT | `NOT NULL` | 章节标题 · 默认 `''` |
| `subtitle` | TEXT | — | 章节副标题 |
| `order_index` | INTEGER | `NOT NULL` | 章节顺序（决定时间线页签次序） · 默认 `0` |
| `start_frame` | INTEGER | `NOT NULL` | 起始帧（绝对帧） · `CHECK (start_frame >= 0)` |
| `end_frame` | INTEGER | `NOT NULL` | 结束帧（绝对帧） |
| `base_map_id` | TEXT | `FK → base_map SET NULL` | 本节覆盖底图（删除则置空，回落到项目底图） |
| `elevation_map_id` | TEXT | `FK → elevation_map SET NULL` | 本节覆盖高程图（删除则置空） |
| `title_style_json` | TEXT | — | 标题样式配置块（字号/配色/预设） · `CHECK (title_style_json IS NULL OR json_valid(title_style_json))` |
| `transition_json` | TEXT | — | 进入本节的转场（类型 + 时长） · `CHECK (transition_json IS NULL OR json_valid(transition_json))` |

**表级约束**

- `CHECK (end_frame > start_frame)`

#### camera_keyframe

18 列 · 主键 `kf_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `kf_id` | TEXT | `PK` | 视角关键帧 id |
| `chapter_id` | TEXT | `NOT NULL` `FK → chapter CASCADE` | 所属章节 |
| `frame` | INTEGER | `NOT NULL` | 到达时间（绝对帧）—— 语义为「停留 → 飞行 → 落位」的落位时刻 · `CHECK (frame >= 0)` |
| `center_lng` | REAL | `NOT NULL` | 视角中心经度 |
| `center_lat` | REAL | `NOT NULL` | 视角中心纬度 |
| `zoom` | REAL | `NOT NULL` | 缩放级别 |
| `pitch` | REAL | — | 俯仰角（度） |
| `bearing` | REAL | — | 方向角（度） |
| `easing` | TEXT | — | 飞行缓动类型 |
| `move_duration` | INTEGER | — | 起飞提前量（帧，默认 2×fps） · `CHECK (move_duration IS NULL OR move_duration >= 0)` |
| `camera_type` | TEXT | — | 视角类型：fixed 固定 / follow 跟随 / orbit 环绕 · `CHECK (camera_type IS NULL OR camera_type IN ('fixed','follow','orbit'))` |
| `follow_route_element_id` | TEXT | `FK → element_route SET NULL` | 跟随的路线元素（外键指向 element_route，只能是 line / moving_point；删除后置空，退化为固定视角） |
| `follow_direction` | INTEGER | — | 跟随视角是否按路线切线自动定向 · `CHECK (follow_direction IS NULL OR follow_direction IN (0,1))` |
| `follow_start_frame` | INTEGER | — | 跟随动画开始帧（默认取路线显示起点） |
| `follow_end_frame` | INTEGER | — | 跟随动画结束帧（默认取路线显示终点） |
| `orbit_speed` | REAL | — | 环绕速度（度/秒） |
| `orbit_duration` | REAL | — | 环绕时长（秒） |
| `ord` | INTEGER | `NOT NULL` | 同章节内排序 · 默认 `0` |

#### screen_fx

13 列 · 主键 `fx_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `fx_id` | TEXT | `PK` | 特效窗口 id |
| `chapter_id` | TEXT | `NOT NULL` `FK → chapter CASCADE` | 所属章节 |
| `kind` | TEXT | `NOT NULL` | 类别：weather 天气 / screen 画面特效 · `CHECK (kind IN ('weather','screen'))` |
| `name` | TEXT | `NOT NULL` | 显示名（时间线轨道上展示） · 默认 `''` |
| `start_frame` | INTEGER | `NOT NULL` | 起始帧（绝对帧） · `CHECK (start_frame >= 0)` |
| `end_frame` | INTEGER | `NOT NULL` | 结束帧（绝对帧） |
| `weather_type` | TEXT | — | 天气类型：rain 雨 / snow 雪 / lightning 闪电 / fog 雾 · `CHECK (weather_type IS NULL OR weather_type IN ('rain','snow','lightning','fog'))` |
| `intensity` | REAL | — | 强度（0–1） · `CHECK (intensity IS NULL OR intensity BETWEEN 0 AND 1)` |
| `wind` | REAL | — | 风向风力（-1..1，向右为正） · `CHECK (wind IS NULL OR wind BETWEEN -1 AND 1)` |
| `effect_type` | TEXT | — | 画面特效：shake 震动 / flash 闪光 / vignette 暗角 / cloudReveal 云散 / fadeBlack / fadeWhite · `CHECK (effect_type IS NULL OR effect_type IN ( 'shake','flash','vignette','cloudReveal','fadeBlack','fadeWhite'))` |
| `effect_color` | TEXT | — | 特效颜色（flash、fade 类使用） |
| `enabled` | INTEGER | `NOT NULL` | 是否启用 · 默认 `1` · `CHECK (enabled IN (0,1))` |
| `ord` | INTEGER | `NOT NULL` | 同章节内排序 · 默认 `0` |

**表级约束**

- `CHECK (end_frame >= start_frame)`
- `CHECK ((kind = 'weather' AND weather_type IS NOT NULL) OR (kind = 'screen' AND effect_type IS NOT NULL))`

#### chapter_fx

11 列 · 主键 `fx_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `fx_id` | TEXT | `PK` | 特效 id |
| `chapter_id` | TEXT | `NOT NULL` `FK → chapter CASCADE` | 所属章节 |
| `type` | TEXT | `NOT NULL` | 特效类型：cursor_track 指针轨迹 / focus_glow 区域渐显 / scan_line 扫描线 · `CHECK (type IN ('cursor_track','focus_glow','scan_line'))` |
| `path_json` | TEXT | — | 指针轨迹的地理路径（cursor_track 用） · `CHECK (path_json IS NULL OR json_valid(path_json))` |
| `color` | TEXT | — | 特效颜色 |
| `frame_step` | INTEGER | — | 推进步长（帧） |
| `center_lng` | REAL | — | 中心经度（focus_glow 用） |
| `center_lat` | REAL | — | 中心纬度（focus_glow 用） |
| `radius` | REAL | — | 半径（focus_glow 用） |
| `direction` | TEXT | — | 扫描方向：horizontal 横向 / vertical 纵向（scan_line 用） · `CHECK (direction IS NULL OR direction IN ('horizontal','vertical'))` |
| `ord` | INTEGER | `NOT NULL` | 同章节内排序 · 默认 `0` |

**表级约束**

- `CHECK (type IS NOT 'scan_line' OR direction IS NOT NULL)`

#### narration

2 列 · 主键 `chapter_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `chapter_id` | TEXT | `PK` `FK → chapter CASCADE` | 章节 id（本章一份配音档，1:1） |
| `style_json` | TEXT | `NOT NULL` | 字幕样式：字号/颜色/描边/底色/距底位置/最大宽度 · `CHECK (json_valid(style_json))` |

#### narration_entry

10 列 · 主键 `entry_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `entry_id` | TEXT | `PK` | 字幕条 id |
| `chapter_id` | TEXT | `NOT NULL` `FK → chapter CASCADE` | 所属章节 |
| `text` | TEXT | `NOT NULL` | 字幕文本（同时也是配音朗读文本） · 默认 `''` |
| `audio_asset_id` | TEXT | `FK → asset SET NULL` | 配音音频（TTS 生成或导入） |
| `duration_frames` | INTEGER | `NOT NULL` | 字幕显示时长（帧；无音频时按字数估算） · `CHECK (duration_frames >= 1)` |
| `start_frame` | INTEGER | `NOT NULL` | 章内起始帧（默认自动顺排） · `CHECK (start_frame >= 0)` |
| `locked` | INTEGER | `NOT NULL` | 手动定位后锁定，不再参与自动顺排 · 默认 `0` · `CHECK (locked IN (0,1))` |
| `status` | TEXT | — | 配音状态：none / pending / ready / error · `CHECK (status IS NULL OR status IN ('none','pending','ready','error'))` |
| `error` | TEXT | — | 配音失败原因 |
| `ord` | INTEGER | `NOT NULL` | 同章节内排序 · 默认 `0` |

#### music_track

11 列 · 主键 `track_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `track_id` | TEXT | `PK` | 音乐段 id |
| `chapter_id` | TEXT | `NOT NULL` `FK → chapter CASCADE` | 所属章节 |
| `name` | TEXT | `NOT NULL` | 曲目名 · 默认 `''` |
| `audio_asset_id` | TEXT | `FK → asset SET NULL` | 音频素材 |
| `start_frame` | INTEGER | `NOT NULL` | 起效起始帧（章内绝对帧） · `CHECK (start_frame >= 0)` |
| `end_frame` | INTEGER | `NOT NULL` | 起效结束帧（章内绝对帧） |
| `volume` | REAL | `NOT NULL` | 音量（0–1） · 默认 `1` · `CHECK (volume BETWEEN 0 AND 1)` |
| `loop` | INTEGER | `NOT NULL` | 是否循环播放 · 默认 `0` · `CHECK (loop IN (0,1))` |
| `fade_in` | REAL | `NOT NULL` | 淡入时长（秒） · 默认 `0` · `CHECK (fade_in >= 0)` |
| `fade_out` | REAL | `NOT NULL` | 淡出时长（秒） · 默认 `0` · `CHECK (fade_out >= 0)` |
| `ord` | INTEGER | `NOT NULL` | 同章节内排序 · 默认 `0` |

**表级约束**

- `CHECK (end_frame >= start_frame)`

### 组 4 · 标记类元素（Pin 工具）

#### element_marker

44 列 · 主键 `element_id` · 工具入口：Pin 工具（一键放置到地图中心）；标记面板切到 Marker（旗标）、导入/旧数据的军标也写这张表

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `element_id` | TEXT | `PK` | 元素 id（全库唯一，4 张类别表共享同一 id 空间） |
| `chapter_id` | TEXT | `NOT NULL` `FK → chapter CASCADE` | 所属章节 |
| `type` | TEXT | `NOT NULL` | 子类型判别列：point 点 / flag 旗标 / military_symbol 军标（Pin 工具） · `CHECK (type IN ('point','flag','military_symbol'))` |
| `name` | TEXT | `NOT NULL` | 元素名（与属性面板首字段 LABEL 同步） · 默认 `''` |
| `visible` | INTEGER | `NOT NULL` | 是否显示（0/1） · 默认 `1` · `CHECK (visible IN (0,1))` |
| `locked` | INTEGER | `NOT NULL` | 是否锁定（0/1，锁定后不可拖动） · 默认 `0` · `CHECK (locked IN (0,1))` |
| `start_frame` | INTEGER | `NOT NULL` | 出现帧（绝对帧） · `CHECK (start_frame >= 0)` |
| `end_frame` | INTEGER | `NOT NULL` | 消失帧（绝对帧） |
| `z_index` | INTEGER | `NOT NULL` | 层级（越大越靠上） · 默认 `0` |
| `shape_category` | TEXT | — | 来源分类：multi 多点 / two 两点 / special 特殊 / route 路线（决定属性面板形态） · `CHECK (shape_category IS NULL OR shape_category IN ('multi','two','special','route'))` |
| `anim_effect` | TEXT | — | 动画效果：grow 增长 / move 移动 / fill 填充 / march 填充行进 / marchplain 行进 · `CHECK (anim_effect IS NULL OR anim_effect IN ('grow','move','fill','march','marchplain'))` |
| `fly_mode` | INTEGER | `NOT NULL` | 悬空飞行模式：按高度剖面离地显示 · 默认 `0` · `CHECK (fly_mode IN (0,1))` |
| `show_icon` | INTEGER | `NOT NULL` | 是否显示移动图标 · 默认 `0` · `CHECK (show_icon IN (0,1))` |
| `move_icon_json` | TEXT | — | 移动图标样式配置块（dot/pin/emoji/bubble/text/flag + 标签） · `CHECK (move_icon_json IS NULL OR json_valid(move_icon_json))` |
| `move_start_frame` | INTEGER | — | 移动图标出发帧 |
| `move_end_frame` | INTEGER | — | 移动图标到达帧 |
| `uniform_move` | INTEGER | — | 是否全程匀速（0 则按各路径点自定义到达时间） · `CHECK (uniform_move IS NULL OR uniform_move IN (0,1))` |
| `point_times_json` | TEXT | — | 各路径点到达帧数组（非匀速时使用） · `CHECK (point_times_json IS NULL OR json_valid(point_times_json))` |
| `label_json` | TEXT | — | 元素标签（原 element_label 内联）：{text,fontSize,color,position,bgColor,bgPadding,bgRadius,fontWeight} · `CHECK (label_json IS NULL OR json_valid(label_json))` |
| `ord` | INTEGER | `NOT NULL` | 同章节内排序 · 默认 `0` |
| `lng` | REAL | `NOT NULL` | 经度（三类标记都落在单点） |
| `lat` | REAL | `NOT NULL` | 纬度 |
| `rotation` | REAL | — | 贴地旋转角（0–360 度） |
| `shape` | TEXT | — | 点呈现形态（9 种）：circle 圆点 / text 纯文字 / pin 水滴针 / bubble 气泡 / emoji 表情 / image 图片 / gif 动图 / model 3D 模型 / icon 图标库 · `CHECK (shape IS NULL OR shape IN ( 'circle','text','pin','bubble','emoji','image','gif','model','icon'))` |
| `emoji` | TEXT | — | 表情字符（type=point 且 shape=emoji 时必填） |
| `scale` | REAL | — | 等比缩放（0.3–3，同时影响点与标签字号） · `CHECK (scale IS NULL OR (scale >= 0.3 AND scale <= 3))` |
| `orientation` | TEXT | — | 朝向：faceCam 面向镜头 / flat 贴地（shape=model 不能贴地，CHECK 保证） · `CHECK (orientation IS NULL OR orientation IN ('faceCam','flat'))` |
| `color` | TEXT | — | 可着色形态的主色（shape=model / gif 时禁用，CHECK 保证） |
| `icon` | TEXT | — | 历史内置图标名（兼容旧数据；新逻辑走 icon_lib + icon_name） |
| `icon_size` | REAL | — | 自定义图标的显示尺寸（px） |
| `asset_id` | TEXT | `FK → asset SET NULL` | 用户上传的图片 / GIF / 模型素材（删除素材则置空） |
| `builtin_id` | TEXT | — | 内置资源 id（打包进应用、不入库）：image:flag-red / gif:radar / model:drone / icon:lucide:MapPin |
| `icon_lib` | TEXT | — | 图标库命名空间：lucide / react-icons/xxx / 自建库名（shape=icon 时用） |
| `icon_name` | TEXT | — | 图标名（shape=icon 时必填，可指向内置库或 custom_symbol.name） |
| `visual_meta_json` | TEXT | — | P3 表现参数：image={fit,tintable}；gif={fps,loop}；model={scale,altitude,autoRotate,spin,pitchAlign,animation}；icon={strokeWidth} · `CHECK (visual_meta_json IS NULL OR json_valid(visual_meta_json))` |
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

- `CHECK (end_frame >= start_frame)`
- `CHECK (move_end_frame IS NULL OR move_start_frame IS NULL OR move_end_frame > move_start_frame)`
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

37 列 · 主键 `element_id` · 工具入口：Route 工具；Shape 子菜单的直线/曲线/带箭头/战线/行军箭头也写这张表；连接线无工具入口

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `element_id` | TEXT | `PK` | 元素 id（全库唯一，4 张类别表共享同一 id 空间） |
| `chapter_id` | TEXT | `NOT NULL` `FK → chapter CASCADE` | 所属章节 |
| `type` | TEXT | `NOT NULL` | 子类型判别列：line 线 / moving_point 移动点 / connector 连接线（Route 工具） · `CHECK (type IN ('line','moving_point','connector'))` |
| `name` | TEXT | `NOT NULL` | 元素名（与属性面板首字段 LABEL 同步） · 默认 `''` |
| `visible` | INTEGER | `NOT NULL` | 是否显示（0/1） · 默认 `1` · `CHECK (visible IN (0,1))` |
| `locked` | INTEGER | `NOT NULL` | 是否锁定（0/1） · 默认 `0` · `CHECK (locked IN (0,1))` |
| `start_frame` | INTEGER | `NOT NULL` | 出现帧（绝对帧） · `CHECK (start_frame >= 0)` |
| `end_frame` | INTEGER | `NOT NULL` | 消失帧（绝对帧） |
| `z_index` | INTEGER | `NOT NULL` | 层级（越大越靠上） · 默认 `0` |
| `shape_category` | TEXT | — | 来源分类：multi / two / special / route · `CHECK (shape_category IS NULL OR shape_category IN ('multi','two','special','route'))` |
| `anim_effect` | TEXT | — | 动画效果：grow / move / fill / march / marchplain · `CHECK (anim_effect IS NULL OR anim_effect IN ('grow','move','fill','march','marchplain'))` |
| `fly_mode` | INTEGER | `NOT NULL` | 悬空飞行模式：路线与图标按高度剖面离地显示 · 默认 `0` · `CHECK (fly_mode IN (0,1))` |
| `show_icon` | INTEGER | `NOT NULL` | 是否显示移动图标 · 默认 `0` · `CHECK (show_icon IN (0,1))` |
| `move_icon_json` | TEXT | — | 移动图标样式配置块 · `CHECK (move_icon_json IS NULL OR json_valid(move_icon_json))` |
| `move_start_frame` | INTEGER | — | 移动图标出发帧 |
| `move_end_frame` | INTEGER | — | 移动图标到达帧 |
| `uniform_move` | INTEGER | — | 是否全程匀速（0 则按各路径点自定义到达时间） · `CHECK (uniform_move IS NULL OR uniform_move IN (0,1))` |
| `point_times_json` | TEXT | — | 各路径点到达帧数组 · `CHECK (point_times_json IS NULL OR json_valid(point_times_json))` |
| `label_json` | TEXT | — | 元素标签（内联）：{text,fontSize,color,position,bgColor,bgPadding,bgRadius,fontWeight} · `CHECK (label_json IS NULL OR json_valid(label_json))` |
| `ord` | INTEGER | `NOT NULL` | 同章节内排序 · 默认 `0` |
| `coords_json` | TEXT | — | 路径点数组 [[lng,lat],…]；line_type=bezier 时为控制点、arc 时为大圆弧端点（line / moving_point 必填） · `CHECK (coords_json IS NULL OR json_valid(coords_json))` |
| `line_width` | REAL | — | 线宽（px） |
| `line_color` | TEXT | — | 线条颜色（moving_point 时为主色） |
| `line_dash_json` | TEXT | — | 虚线参数 [实线长, 空白长] · `CHECK (line_dash_json IS NULL OR json_valid(line_dash_json))` |
| `line_type` | TEXT | — | 线型：straight 直线 / bezier 贝塞尔 / arc 大圆弧航线 · `CHECK (line_type IS NULL OR line_type IN ('straight','bezier','arc'))` |
| `line_arrow` | INTEGER | — | 线末端是否带方向箭头（0/1） · `CHECK (line_arrow IS NULL OR line_arrow IN (0,1))` |
| `route_effect_json` | TEXT | — | 行军路线动画：光点颜色/宽度/步长/同时存在数量 · `CHECK (route_effect_json IS NULL OR json_valid(route_effect_json))` |
| `flow_speed` | REAL | — | 流动速度（0 关闭；>0 每 N 帧相位前进一步，行军蚁效果） |
| `plain_path` | INTEGER | — | 无样式路线：预览与导出不画线，仅显示移动图标 · `CHECK (plain_path IS NULL OR plain_path IN (0,1))` |
| `front_style_json` | TEXT | — | 战线梳齿装饰（齿长/齿距/偏角/朝向侧） · `CHECK (front_style_json IS NULL OR json_valid(front_style_json))` |
| `trail_color` | TEXT | — | 拖尾颜色（type=moving_point） |
| `trail_width` | REAL | — | 拖尾宽度（px） |
| `trail_length` | INTEGER | — | 拖尾长度（帧） |
| `from_element_id` | TEXT | — | 连接线起点元素（弱引用：可指向任意类别元素，元素已分表故无外键；删端点由清理触发器连带删除本行） |
| `to_element_id` | TEXT | — | 连接线终点元素（弱引用；与起点不得相同） |
| `animated` | INTEGER | — | 连接线是否流动动画（0/1） · `CHECK (animated IS NULL OR animated IN (0,1))` |
| `arrowhead` | INTEGER | — | 连接线是否显示末端箭头（0/1） · `CHECK (arrowhead IS NULL OR arrowhead IN (0,1))` |

**表级约束**

- `CHECK (end_frame >= start_frame)`
- `CHECK (move_end_frame IS NULL OR move_start_frame IS NULL OR move_end_frame > move_start_frame)`
- `CHECK (type <> 'line' OR coords_json IS NOT NULL)`
- `CHECK (type <> 'moving_point' OR coords_json IS NOT NULL)`
- `CHECK (type <> 'connector' OR (from_element_id IS NOT NULL AND to_element_id IS NOT NULL))`
- `CHECK (from_element_id IS NULL OR to_element_id IS NULL OR from_element_id <> to_element_id)`

### 组 6 · 形状类元素（Shape 工具）

#### element_shape

47 列 · 主键 `element_id` · 工具入口：Shape：多边形/曲线多边/防御圈/圆/矩形/五角星/钳形/集结地/包围圈；Region 工具的行政区高亮也写这张表

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `element_id` | TEXT | `PK` | 元素 id（全库唯一，4 张类别表共享同一 id 空间） |
| `chapter_id` | TEXT | `NOT NULL` `FK → chapter CASCADE` | 所属章节 |
| `type` | TEXT | `NOT NULL` | 子类型判别列：polygon 多边形 / arrow 箭头 / double_arrow 钳形 / gathering 集结地 / encirclement 包围圈（Shape 工具） · `CHECK (type IN ('polygon','arrow','double_arrow','gathering','encirclement'))` |
| `name` | TEXT | `NOT NULL` | 元素名（与属性面板首字段 LABEL 同步） · 默认 `''` |
| `visible` | INTEGER | `NOT NULL` | 是否显示（0/1） · 默认 `1` · `CHECK (visible IN (0,1))` |
| `locked` | INTEGER | `NOT NULL` | 是否锁定（0/1） · 默认 `0` · `CHECK (locked IN (0,1))` |
| `start_frame` | INTEGER | `NOT NULL` | 出现帧（绝对帧） · `CHECK (start_frame >= 0)` |
| `end_frame` | INTEGER | `NOT NULL` | 消失帧（绝对帧） |
| `z_index` | INTEGER | `NOT NULL` | 层级（越大越靠上） · 默认 `0` |
| `shape_category` | TEXT | — | 来源分类：multi 多点 / two 两点 / special 特殊 / route 路线 · `CHECK (shape_category IS NULL OR shape_category IN ('multi','two','special','route'))` |
| `anim_effect` | TEXT | — | 动画效果：grow / move / fill / march / marchplain · `CHECK (anim_effect IS NULL OR anim_effect IN ('grow','move','fill','march','marchplain'))` |
| `fly_mode` | INTEGER | `NOT NULL` | 悬空飞行模式 · 默认 `0` · `CHECK (fly_mode IN (0,1))` |
| `show_icon` | INTEGER | `NOT NULL` | 是否显示移动图标 · 默认 `0` · `CHECK (show_icon IN (0,1))` |
| `move_icon_json` | TEXT | — | 移动图标样式配置块 · `CHECK (move_icon_json IS NULL OR json_valid(move_icon_json))` |
| `move_start_frame` | INTEGER | — | 移动图标出发帧 |
| `move_end_frame` | INTEGER | — | 移动图标到达帧 |
| `uniform_move` | INTEGER | — | 是否全程匀速（0 则按各路径点自定义到达时间） · `CHECK (uniform_move IS NULL OR uniform_move IN (0,1))` |
| `point_times_json` | TEXT | — | 各路径点到达帧数组 · `CHECK (point_times_json IS NULL OR json_valid(point_times_json))` |
| `label_json` | TEXT | — | 元素标签（内联） · `CHECK (label_json IS NULL OR json_valid(label_json))` |
| `ord` | INTEGER | `NOT NULL` | 同章节内排序 · 默认 `0` |
| `rings_json` | TEXT | — | 多边形环数组：rings[0] 为外环，其余为洞（type=polygon 时必填） · `CHECK (rings_json IS NULL OR json_valid(rings_json))` |
| `fill_color` | TEXT | — | 填充色 |
| `fill_opacity` | REAL | — | 填充透明度（0–1） · `CHECK (fill_opacity IS NULL OR fill_opacity BETWEEN 0 AND 1)` |
| `stroke_color` | TEXT | — | 描边色 |
| `stroke_width` | REAL | — | 描边宽度（px） |
| `shape_kind` | TEXT | — | 多边形种类：poly 多边形 / rect 矩形 / circle 圆 / star 五角星 · `CHECK (shape_kind IS NULL OR shape_kind IN ('poly','rect','circle','star'))` |
| `circle_meta_json` | TEXT | — | 圆的圆心与半径（shape_kind=circle 时必填） · `CHECK (circle_meta_json IS NULL OR json_valid(circle_meta_json))` |
| `rect_meta_json` | TEXT | — | 矩形的两个对角点（shape_kind=rect 时必填） · `CHECK (rect_meta_json IS NULL OR json_valid(rect_meta_json))` |
| `star_meta_json` | TEXT | — | 五角星的圆心与半径（shape_kind=star 时必填） · `CHECK (star_meta_json IS NULL OR json_valid(star_meta_json))` |
| `poly_curve` | INTEGER | — | 各边曲线化（闭合贝塞尔拟合，0/1） · `CHECK (poly_curve IS NULL OR poly_curve IN (0,1))` |
| `defense_style_json` | TEXT | — | 防御圈锯齿装饰（齿长/齿距/偏角/朝向侧） · `CHECK (defense_style_json IS NULL OR json_valid(defense_style_json))` |
| `fill_gradient_json` | TEXT | — | 填充渐变（起止色 + 开关） · `CHECK (fill_gradient_json IS NULL OR json_valid(fill_gradient_json))` |
| `from_lng` | REAL | — | 箭头起点经度（type=arrow 时必填） |
| `from_lat` | REAL | — | 箭头起点纬度 |
| `to_lng` | REAL | — | 箭头终点经度 |
| `to_lat` | REAL | — | 箭头终点纬度 |
| `path_json` | TEXT | — | 弯曲燕尾箭头的控制点（≥2 个时按贝塞尔渲染） · `CHECK (path_json IS NULL OR json_valid(path_json))` |
| `arrow_type` | TEXT | — | 箭头类型（type=arrow 时必填）：swallowtail 燕尾 / simple / block / pincer 钳形 / curved / curved-simple / attack / straight · `CHECK (arrow_type IS NULL OR arrow_type IN ( 'swallowtail','simple','block','pincer','curved','curved-simple','attack','straight'))` |
| `width` | REAL | — | 箭头宽度（px） |
| `color` | TEXT | — | 颜色（箭头 / 集结地 / 钳形共用） |
| `draw_zoom` | REAL | — | 绘制时缩放级别，用于换算固定地理宽度的箭头 |
| `points_json` | TEXT | — | 4 个控制点（type=double_arrow 钳形攻势时必填） · `CHECK (points_json IS NULL OR json_valid(points_json))` |
| `center_lng` | REAL | — | 中心经度（gathering / encirclement 必填） |
| `center_lat` | REAL | — | 中心纬度 |
| `radius` | REAL | — | 半径（米，gathering / encirclement 必填） |
| `pulse_animation` | INTEGER | — | 是否脉冲动画（集结地，0/1） · `CHECK (pulse_animation IS NULL OR pulse_animation IN (0,1))` |
| `rotation` | REAL | — | 绕中心旋转角（度） |

**表级约束**

- `CHECK (end_frame >= start_frame)`
- `CHECK (move_end_frame IS NULL OR move_start_frame IS NULL OR move_end_frame > move_start_frame)`
- `CHECK (radius IS NULL OR radius > 0)`
- `CHECK (type <> 'polygon' OR rings_json IS NOT NULL)`
- `CHECK (type <> 'polygon' OR shape_kind IS NOT 'circle' OR circle_meta_json IS NOT NULL)`
- `CHECK (type <> 'polygon' OR shape_kind IS NOT 'rect' OR rect_meta_json IS NOT NULL)`
- `CHECK (type <> 'polygon' OR shape_kind IS NOT 'star' OR star_meta_json IS NOT NULL)`
- `CHECK (type <> 'arrow' OR arrow_type IS NOT NULL)`
- `CHECK (type <> 'arrow' OR (from_lng IS NOT NULL AND from_lat IS NOT NULL AND to_lng IS NOT NULL AND to_lat IS NOT NULL))`
- `CHECK (type <> 'double_arrow' OR points_json IS NOT NULL)`
- `CHECK (type <> 'gathering' OR (center_lng IS NOT NULL AND center_lat IS NOT NULL AND radius IS NOT NULL))`
- `CHECK (type <> 'encirclement' OR (center_lng IS NOT NULL AND center_lat IS NOT NULL AND radius IS NOT NULL))`

### 组 7 · 疆域类元素（Terr 工具）

#### element_territory

16 列 · 主键 `element_id` · 工具入口：Terr：新建疆域 / 绘制地块 / 兼并（势力、地块、事件 JSON 内联在本表）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `element_id` | TEXT | `PK` | 元素 id（全库唯一，4 张类别表共享同一 id 空间） |
| `chapter_id` | TEXT | `NOT NULL` `FK → chapter CASCADE` | 所属章节 |
| `type` | TEXT | `NOT NULL` | 子类型判别列（固定 territory） · 默认 `'territory'` · `CHECK (type = 'territory')` |
| `name` | TEXT | `NOT NULL` | 元素名（与属性面板首字段 LABEL 同步） · 默认 `''` |
| `visible` | INTEGER | `NOT NULL` | 是否显示（0/1） · 默认 `1` · `CHECK (visible IN (0,1))` |
| `locked` | INTEGER | `NOT NULL` | 是否锁定（0/1） · 默认 `0` · `CHECK (locked IN (0,1))` |
| `start_frame` | INTEGER | `NOT NULL` | 出现帧（绝对帧） · `CHECK (start_frame >= 0)` |
| `end_frame` | INTEGER | `NOT NULL` | 消失帧（绝对帧） |
| `z_index` | INTEGER | `NOT NULL` | 层级（越大越靠上） · 默认 `0` |
| `anim_effect` | TEXT | — | 动画效果：grow / move / fill / march / marchplain · `CHECK (anim_effect IS NULL OR anim_effect IN ('grow','move','fill','march','marchplain'))` |
| `label_json` | TEXT | — | 元素标签（内联） · `CHECK (label_json IS NULL OR json_valid(label_json))` |
| `ord` | INTEGER | `NOT NULL` | 同章节内排序 · 默认 `0` |
| `display_json` | TEXT | `NOT NULL` | 显示配置：势力边界/地块边界/线宽/填充透明度/标签开关/标签朝向与缩放 · `CHECK (json_valid(display_json))` |
| `countries_json` | TEXT | — | 势力数组（JSON 内联，原 territory_country 表）：[{countryId,name,color,ord}] · `CHECK (countries_json IS NULL OR json_valid(countries_json))` |
| `plots_json` | TEXT | — | 地块数组（JSON 内联，原 territory_plot 表）：[{plotId,name,rings,ownerId,ord}]；ownerId 须能在 countries_json 中命中（由 v_check_territory_ref 校验） · `CHECK (plots_json IS NULL OR json_valid(plots_json))` |
| `events_json` | TEXT | — | 兼并事件数组（JSON 内联，原 territory_event / event_plot 表）：[{eventId,frame,toCountryId,preset,duration,highlight,plotIds[],ord}]；toCountryId 同上 · `CHECK (events_json IS NULL OR json_valid(events_json))` |

**表级约束**

- `CHECK (end_frame >= start_frame)`

### 组 8 · 元素附属（跨类别）

#### element_keyframe

10 列 · 主键 `kf_id` · 工具入口：跨类别（所有元素共用，按 element_id 弱引用）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `kf_id` | TEXT | `PK` | 关键帧 id |
| `element_id` | TEXT | `NOT NULL` | 所属元素 id（弱引用：元素分属 4 张表，无外键；删元素由 AFTER DELETE 清理触发器连带删除本行） |
| `element_type` | TEXT | `NOT NULL` | 所属元素的具体类型（point / line / polygon / territory 等 12 种，便于定位与统计） · `CHECK (element_type IN ( 'point','flag','military_symbol', 'line','moving_point','connector', 'polygon','arrow','double_arrow','gathering','encirclement', 'territory'))` |
| `chapter_id` | TEXT | `NOT NULL` `FK → chapter CASCADE` | 所属章节（外键，删章节时级联清理本章全部关键帧） |
| `property` | TEXT | `NOT NULL` | 动画属性：opacity / scale / rotation / draw_progress / progress / path_progress / fill_progress / morph · `CHECK (property IN ( 'opacity','scale','rotation','draw_progress','progress', 'path_progress','fill_progress','morph'))` |
| `frame` | INTEGER | `NOT NULL` | 时间（绝对帧） · `CHECK (frame >= 0)` |
| `easing` | TEXT | — | 缓动类型 |
| `value_num` | REAL | — | 数值（标量属性的快路径） |
| `value_json` | TEXT | — | JSON 值（morph 的环数据） · `CHECK (value_json IS NULL OR json_valid(value_json))` |
| `ord` | INTEGER | `NOT NULL` | 同元素同属性内排序 · 默认 `0` |

**表级约束**

- `CHECK (value_num IS NOT NULL OR value_json IS NOT NULL)`
- `UNIQUE (element_id, property, frame)`

### 组 9 · 叠加层（弹窗）

#### overlay

19 列 · 主键 `overlay_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `overlay_id` | TEXT | `PK` | 弹窗 id |
| `chapter_id` | TEXT | `NOT NULL` `FK → chapter CASCADE` | 所属章节 |
| `type` | TEXT | `NOT NULL` | 弹窗类型：custom / chart / person / report / timeline / quote / compare / counter / dialogue / place · `CHECK (type IN ( 'custom','chart','person','report','timeline','quote','compare', 'counter','dialogue','place'))` |
| `name` | TEXT | `NOT NULL` | 显示名（时间线轨道上展示） · 默认 `''` |
| `position` | TEXT | `NOT NULL` | 九宫格位置：top / topLeft / center / bottomRight 等 9 种 · `CHECK (position IN ( 'top','bottom','left','right','center', 'topLeft','topRight','bottomLeft','bottomRight'))` |
| `start_frame` | INTEGER | `NOT NULL` | 出现帧（绝对帧） · `CHECK (start_frame >= 0)` |
| `end_frame` | INTEGER | `NOT NULL` | 消失帧（绝对帧） |
| `animation` | TEXT | — | 入场动画预设 |
| `exit_animation` | TEXT | — | 退场动画预设（结束前 20 帧播放） |
| `scale` | REAL | — | 整体缩放 |
| `offset_x` | REAL | `NOT NULL` | 横向微调（%，-40..40） · 默认 `0` |
| `offset_y` | REAL | `NOT NULL` | 纵向微调（%，-40..40） · 默认 `0` |
| `z_index` | INTEGER | `NOT NULL` | 层级 · 默认 `0` |
| `bg_json` | TEXT | — | 卡片背景：颜色/透明度/模糊/圆角/边框 · `CHECK (bg_json IS NULL OR json_valid(bg_json))` |
| `payload_json` | TEXT | — | 类型专属内容块（图表数据、时间线条目、对话列表等固定形状配置） · `CHECK (payload_json IS NULL OR json_valid(payload_json))` |
| `person_layout_json` | TEXT | — | 人物卡版式：图片方位/对齐/间距/卡片宽/名言样式/叠图 · `CHECK (person_layout_json IS NULL OR json_valid(person_layout_json))` |
| `audio_asset_id` | TEXT | `FK → asset SET NULL` | 背景语音（卡片可见时播放；导出混流待支持） |
| `parent_overlay_id` | TEXT | `FK → overlay CASCADE` | 父弹窗（兼容旧 group 嵌套结构） |
| `ord` | INTEGER | `NOT NULL` | 同章节内排序 · 默认 `0` |

**表级约束**

- `CHECK (end_frame >= start_frame)`

#### overlay_block

11 列 · 主键 `block_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `block_id` | TEXT | `PK` | 内容块 id |
| `overlay_id` | TEXT | `NOT NULL` `FK → overlay CASCADE` | 所属弹窗 |
| `kind` | TEXT | `NOT NULL` | 块类型：text 文字 / image 图片 / video 视频 · `CHECK (kind IN ('text','image','video'))` |
| `text_content` | TEXT | — | 文字内容（kind=text） |
| `font_size` | REAL | — | 字号（kind=text） |
| `color` | TEXT | — | 文字颜色（kind=text） |
| `bold` | INTEGER | — | 是否加粗（0/1） · `CHECK (bold IS NULL OR bold IN (0,1))` |
| `align` | TEXT | — | 对齐：left / center / right · `CHECK (align IS NULL OR align IN ('left','center','right'))` |
| `asset_id` | TEXT | `FK → asset SET NULL` | 图片或视频素材 |
| `url` | TEXT | — | 外链地址（与 asset_id 二选一） |
| `ord` | INTEGER | `NOT NULL` | 块顺序 · 默认 `0` |

#### person_block

9 列 · 主键 `block_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `block_id` | TEXT | `PK` | 内容块 id |
| `overlay_id` | TEXT | `NOT NULL` `FK → overlay CASCADE` | 所属弹窗 |
| `kind` | TEXT | `NOT NULL` | 块类型：image 头像 / name 姓名 / intro 介绍 / quote 名言 / dialogue 台词 · `CHECK (kind IN ('image','name','intro','quote','dialogue'))` |
| `show` | INTEGER | `NOT NULL` | 是否显示该块（0/1） · 默认 `1` · `CHECK (show IN (0,1))` |
| `text` | TEXT | — | 块文字（姓名/介绍/名言/台词） |
| `asset_id` | TEXT | `FK → asset SET NULL` | 头像图片素材 |
| `image_size` | REAL | — | 头像尺寸（px，60–360） · `CHECK (image_size IS NULL OR (image_size >= 60 AND image_size <= 360))` |
| `mask` | TEXT | — | 头像遮罩：none / bottom / top / circle 圆形 / feather 羽化 · `CHECK (mask IS NULL OR mask IN ('none','bottom','top','circle','feather'))` |
| `ord` | INTEGER | `NOT NULL` | 块顺序 · 默认 `0` |

### 组 10 · 应用配置

#### provider

12 列 · 主键 `provider_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `provider_id` | TEXT | `PK` | 服务商配置 id |
| `kind` | TEXT | `NOT NULL` | 类别：llm 大模型 / tts 语音合成 · `CHECK (kind IN ('llm','tts'))` |
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

资源两来源：**`asset_id`**（用户上传，进 asset 表外置存储）与 **`builtin_id`**（内置资源，打包进应用、不入库）；图标形态额外用 `icon_lib` + `icon_name` 定位，自建库落在 `custom_symbol`（`ns` 命名空间 + `UNIQUE(project_id, ns, name)`）。

## 六、容易混淆的 5 组

| 容易混的地方 | 区别 |
|---|---|
| `element_marker` / `element_route` / `element_shape` / `element_territory` vs 表内 `type` | 四张表按**工具栏**分（标记 / 路线 / 形状 / 疆域）；表内的 `type` 才是具体元素类型（point / line / polygon…）。找元素先看它在哪个工具下，再用 `type` 区分 |
| `label_json`（元素表内的一列） vs `element_keyframe`（独立表） | 前者是**文字气泡内容**，作为一列 JSON 跟随元素一起读写（取消基表后不再独立成表）；后者是**动画曲线**（1:N，8 种属性，按 `element_id` 弱引用） |
| `narration` vs `narration_entry` | 前者是「这一章的配音档」（样式、总开关，1:1）；后者是「档里的一条条字幕」（1:N） |
| `overlay` vs `overlay_block` / `person_block` | 前者是弹窗本体；后两者是弹窗**内部**的内容块，且只有 custom / person 两类弹窗才需要 |
| `screen_fx` vs `chapter_fx` | 前者是**屏幕空间**的特效窗口（天气、画面叠加，有起止帧）；后者是**章节级**特效配置（动画预设、转场风格） |

## 七、一次「打开」与一次「保存」

#### 打开项目（读）

      - 读 `project`（身份 / 归属 / 生效底图）与 `project_config`（全局配置）各一行

      - 读 `chapter`（按 `order_index`）→ 章节列表与时间轴

      - 查视图 `v_element_index`（四张类别表的公共列 UNION）→ 时间线轨道与元素列表（**不做 JOIN**）

      - 按需取类别表：只有真正要渲染的元素才查它所属的类别表（marker / route / shape / territory），连带取出专属列

      - 组装回 `MapVideoProject` 对象交给 store（上层无感）

#### 保存项目（写）

      - 整个保存过程放在**一个事务**里（实测：逐条提交 vs 单事务差 63 倍）

      - 先写父表（`project` → `project_config` → `chapter` → `元素类别表`），再写 `element_keyframe`；连接线端点、关键帧都是**弱引用**，须先建被引用元素

      - 二进制素材先入 `asset`，业务表只写 `asset_id`

      - 同类别内切换子类型只需 `UPDATE type` + 补齐该子类型的必填字段（CHECK 会校验）；**跨类别**切换则是「删旧表行 → 插新表行」

      - 保存后跑一遍一致性自检视图（`v_check_dangling` / `v_check_territory_ref`），应全部返回 0 行

#### 注意：这是设计稿，还没落地到代码

当前 `electron/main.mjs` 与 `src/stores/db.ts` 仍然是 V1 的两张表结构（`projects.data` 一列 JSON）。落地需要新增承载「多表 ↔ `MapVideoProject`」双向映射的模块，并由它保持**导出格式不变**（仍输出 V1 结构的 JSON），这样老存档与网页端零改动。具体迁移步骤与 5 个未决问题见 `docs/db-redesign.html` 第七节。

## 附：3 个视图与 6 个触发器是什么

表之外还有两组对象，它们不是表，但看 DDL 时会遇到，一并说清。

### 3 个视图（不存数据，只是固化查询）

| 视图 | 类别 | 作用 |
|---|---|---|
| `v_element_index` | 读取便利 | 把 4 张类别表的公共列 UNION 成一张「元素总表」：取消基表后，轨道 / 列表 / 计数查这里，不用手写 4 表 UNION |
| `v_check_dangling` | 一致性自检 | 查悬空引用：连接线指向已删除的元素、关键帧挂在已删除的元素上、跟随机位指向已删除的路线。迁移后与老库体检用，正常应返回 0 行 |
| `v_check_territory_ref` | 一致性自检 | 疆域 JSON 内部一致性：`plots_json` 的 `ownerId`、`events_json` 的 `toCountryId` 必须能在 `countries_json` 中命中（复合外键被 JSON 化后的补偿） |

### 6 个触发器（补外键表达不了的规则）

| 触发器 | 数量 | 补的是什么规则 |
|---|---|---|
| `trg_camera_follow_chapter_ins` / `_upd` | 2 | 跟随机位只能引用**同一章节**内的路线元素（不能改用复合外键：`SET NULL` 会连带清空 NOT NULL 的 `chapter_id`） |
| `trg_marker_cleanup` / `trg_route_cleanup` / `trg_shape_cleanup` / `trg_territory_cleanup` | 4 | **弱引用反向清理**：删除任一元素时，连带删除以它为端点的连接线、以及挂在它名下的动画关键帧。这是「取消基表后连接线 / 关键帧无法用外键 CASCADE」这一取舍的补偿 |

  MapVideo V2 表清单速查 · 由 docs/db-schema-v2.sql 与 src/types/index.ts 的实际定义整理，表名、主键、外键均取自 DDL 实测解析结果
  配套文件：docs/db-redesign.html（设计依据与选型对比）· docs/db-schema-v2.sql（可执行 DDL）· tools/audit-fk-indexes.mjs（外键索引审计）
