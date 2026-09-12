# MapVideo 数据库设计

> 规范化关系模型：元素建模、关联多重性、主外键策略与约束补偿。

- **引擎**：SQLite（`node:sqlite`，桌面端）/ Dexie（网页端）
- **规模**：18 张表 · 3 视图 · 0 触发器（DDL 已实测执行；不使用触发器，见 2.6）
- **配套**：`docs/db-schema-v2.sql`（DDL 事实源）、`docs/db-tables.md`（表清单与字段字典）、`docs/db-er-diagram.mmd`（E-R 图源）

## 结论摘要

把数据语义下沉到数据库，由结构本身保证正确性：

- **元素建模**：12 个元素子类型按工具栏聚合为 **4 张类别宽表**（标记 / 路线 / 形状 / 疆域），表内用 `type` 判别列区分子类型，子类型必填规则由 CHECK 约束表达
- **关联与多重性**：用主外键、唯一索引与 1:N / 1:1 表结构固化；元素间引用（连接线端点、关键帧归属）因元素分表而失去外键目标，改由**应用层清理 + 自检视图**兜底（不使用触发器）
- **生命周期**：用 `CASCADE / SET NULL / RESTRICT` 三档策略区分，删除父实体时由数据库负责清理
- **大体积素材**：二进制内容从项目数据中剥离进 `asset` 表（sha256 内容寻址），业务表只留 `asset_id`

## 一、页面元素清单与关系梳理

### 1.1 三层结构

编辑页面上的全部可视与可交互对象，收敛为三个层次。`Project` 是聚合根，`Chapter` 是时间与生命周期的边界，`MapElement` 是真正被绘制的内容。

| 层次 | 实体 | 说明 | 数量级 |
|---|---|---|---|
| 聚合根 | `MapVideoProject` | 全局配置、底图/高程图目录、自定义符号、章节目录 | 1 |
| 章节层 | `Chapter` | 标题/时间跨度/相机/元素/弹窗/特效/字幕/配乐，以及可覆盖的底图 | 1 – 数十 |
| 内容层 | `MapElement`（12 子类） | 地图上绘制的一切：点、线、面、箭头、军标、旗、连接线、疆域 | 每章 0 – 数百 |
| 叠加层 | `OverlayItem`（11 类型） | 屏幕空间弹窗：图表、人物卡、战报、时间线、引用、对比、计数、对话、地点、自定义块 | 每章 0 – 数十 |
| 时间层 | `CameraKeyframe` / `ScreenFxItem` / `ChapterEffect` / `NarrationTrack` / `MusicTrack` | 镜头、天气与画面特效、章特效、字幕、配乐 | 每章 0 – 数十 |
| 资源层 | `BaseMapConfig` / `ElevationMapConfig` / `CustomSymbol` / `CustomImage` | 底图、地形、自定义图标、自定义图片库；其中**底图 / 高程图是代码内置常量（不入库，但地形夸张覆盖值存 `project_config`）**，图标 / 图片统一入 `asset`（`kind='icon'` / `'image'`，三表已合并） | 各 0 – 数十 |
| 配置层 | `ProviderConfig` | LLM / TTS 连接配置，**独立聚合**，不属于项目内容 | 0 – 数十 |

### 1.2 元素结构：一个判别联合

`MapElementBase` 提供公共字段（`id`、`type`、`name`、`visible`、`locked`、`startFrame`、`endFrame`、`style`、`zIndex`、`shapeCategory`、`animEffect`、`flyMode`、`showIcon`、`moveIcon` 与移动时间语义），**12 个**具体类型通过 `type` 判别字段「特化」出各自的几何与样式字段；入库时按工具栏聚合为 4 张类别宽表（见 2.3）。

#### 子类字段量级差异极大——这是选型的关键依据

| type | 专有字段数 | 几何载体 | 备注 |
|---|---|---|---|
| `flag` | 6 | `coordinates` | 最简单：文字 + 颜色 + 尺寸 |
| `encirclement` / `gathering` | 4 / 5 | `center` + `radius` | 纯标量 |
| `point` | 10 | `coordinates` | 5 种形态 × 朝向 × 缩放 |
| `custom_icon` / `military_symbol` | 6 / 5 | `coordinates` | 引用 `CustomSymbol` / `sidc` |
| `moving_point` / `double_arrow` | 4 / 3 | `path` / `points` | 含关键帧曲线 |
| `line` | 13 | `coordinates[]` | 含路线特效、流动、战线梳齿 |
| `arrow` | 9 | `from` / `to` / `path` | 8 种箭头形态 |
| `polygon` | 19 | `coordinates[][]` | 4 种形状 + 形变关键帧 + 防御圈 |
| `connector` | 6 | **无**（引用两个元素） | **唯一引用其它元素的类型** |
| `territory` | 4 组子实体 | `plots[].rings` | 内部还有势力 / 地块 / 兼并事件三张子表 |

字段数从 3 到 19 不等，且 `territory` 是组合结构。这个离散度直接否决了「单表继承」，详见 2.3。

### 1.3 关联关系与多重性总表

元素之间以及元素与资源之间的关联共 **34 条**。按语义分三类：**组合**（子对象随父消亡，生命周期绑定）、**关联**（引用一个独立存在的对象）、**继承**（1:1 具化）。

| # | 关联 | 方向 | 多重性 | 类别 |
|---|---|---|---|---|
| 1 | Project → Chapter | 1 → N | 一章属唯一项目 | 组合 |
| 2 | Project → BaseMap / ElevationMap / CustomSymbol | 1 → N | 资源项目级共享 | 组合 |
| 3 | Project → activeBaseMapId / activeElevationMapId | N → 1 | 可空引用 | 关联 |
| 4 | Chapter → Element | 1 → N | 元素不跨章节 | 组合 |
| 5 | Chapter → CameraKeyframe | 1 → N | 至少 1 个初始视角 | 组合 |
| 6 | Chapter → Overlay / ScreenFx / ChapterEffect / MusicTrack | 1 → N | 可为空集合 | 组合 |
| 7 | Chapter → NarrationTrack | 1 → 1 | 恒存在（可空内容） | 组合 |
| 8 | NarrationTrack → NarrationEntry | 1 → N | 字幕条顺序排列 | 组合 |
| 9 | Chapter → BaseMap / ElevationMap | N → 1 | 可空，覆盖项目默认 | 关联 |
| 10 | Element → 13 个子类 | 1 → 1 | **恰好一个**具化 | 继承 |
| 11 | Element → ElementLabel | 1 → 0..1 | 仅 point / line 有 | 组合 |
| 12 | Element → ElementKeyframe | 1 → N | opacity/scale/rotation/progress | 组合 |
| 13 | `connector.fromElementId` → Element | N → 1 | 一个元素可被多条线引用 | 关联 |
| 14 | `connector.toElementId` → Element | N → 1 | 同上，两列独立外键 | 关联 |
| 15 | `cameraKeyframe.followRoute.routeElementId` → Element | N → 1 | 可空；**须同章节** | 关联 |
| 16 | `customIcon.symbolId` → CustomSymbol | N → 1 | 必填 | 关联 |
| 17 | `element.moveIcon.symbolId` → CustomSymbol | N → 1 | 弱引用，藏在 `moveIcon` 内 | 弱关联 |
| 18 | TerritoryElement → TerritoryCountry | 1 → N | 势力列表 | 组合 |
| 19 | TerritoryElement → TerritoryPlot | 1 → N | 地块列表 | 组合 |
| 20 | TerritoryElement → TerritoryEvent | 1 → N | 按 sec 升序 | 组合 |
| 21 | `plot.ownerId` → TerritoryCountry | N → 1 | **须同疆域** | 关联 |
| 22 | `event.toCountryId` → TerritoryCountry | N → 1 | **须同疆域** | 关联 |
| 23 | TerritoryEvent ↔ TerritoryPlot（`plotIds[]`） | N ↔ M | 一次兼并吞并多块 | 关联 |
| 24 | Overlay → OverlayBlock | 1 → N | custom 类型的内容块 | 组合 |
| 25 | Overlay → PersonBlock | 1 → N | person 类型的 5 类槽位 | 组合 |
| 26 | `overlay.content.children[]` → OverlayItem | N → 1 | 旧 group 自引用，已废弃 | 遗留 |
| 27 | Overlay（person/custom）→ 音频资产 | N → 1 | 可空 | 关联 |
| 28 | 各实体 → 图片 / 音频 / 视频（dataURL 或 URL） | N → 1 | **当前为无约束的裸字符串** | 弱关联 |
| 29 | ProviderConfig | — | 独立聚合，无外键 | 孤立 |

### 1.4 依赖方向

依赖方向是单向的，且**引用方向与删除级联方向相反**：

- **数据引用方向：子 → 父。**外键永远写在「依赖方」（`element.chapterId`、`connector.fromElementId`、`plot.ownerId`），被引用方不持有反向指针。

- **删除级联方向：父 → 子。**删除父实体时沿外键反向传播。`chapter` 不知道自己有哪些 `element`，但删它时必须清理干净——这正是需要数据库级联的原因。

- **元素间依赖是「点状」的，不是树。**只有 `connector` 与 `cameraKeyframe.followRoute` 引用其它元素，其余 11 类元素彼此独立。因此依赖图是「一个浅层 DAG + 大量孤立节点」，不存在深递归删除。

- **代码层依赖：**`types → lib → stores → components → compositions` 严格单向（与数据层方向一致，这是好设计，V2 不改变）。

## 二、关系模型设计

### 2.1 归一化策略：哪些列化、哪些留 JSON

全量规范化会把 100+ 个样式标量炸成 100+ 张表；全量 JSON 就等于把整个项目塞回一列。先定一条可复用的判定规则，再逐字段归类：

| 级别 | 判定标准 | 处理方式 | 典型字段 |
|---|---|---|---|
| **P1** 必列化 | 身份、时间轴、以及构成引用图的字段 —— 约束与查询都依赖它们 | 独立列 + 主键 / 外键 / CHECK | `id`、`start_sec`、`end_sec`、`chapter_id`、`from_element_id` |
| **P2** 独立成表 | 子结构自身有 id 或顺序语义，需被单独约束或寻址 | 1:N 子表 | `overlay_block`、`person_block`、`narration_entry` |
| **P3** 保留 JSON | 固定形状、整体读写、不参与约束与检索的配置块 | JSON 列 + `json_valid()` 约束 | `display_json`、`front_style_json`、`route_effect_json`、`label_json`、`countries_json` / `plots_json` / `events_json` |
| **P4** 外置存储 | 大体积二进制内容 | 独立 `asset` 表，业务表只留 `asset_id` | 图片、音频、视频、模型、字体 |

注：`chart.data` / `timeline.items` / `dialogue.items` 虽是数组，但不被单独寻址、无逐项约束，按 P3 留在 `payload_json`；而关键帧虽也是数组，却带 `(element_id, property, sec)` 唯一性与时间轴语义，按 P2 建表。

### 2.2 实体清单（18 张表，按结构分 10 组）

| 组 | 表 | 说明 |
|---|---|---|
| **1. 合集与项目** | `collection`、`project`、`project_config` | 合集是项目之上的分组；`project` 只留身份 / 归属 / 审计与生效底图；`project_config` 承载 GlobalConfig（1:1，主键即外键） |
| **2. 资源与素材** | `asset` | 唯一素材存储，承担 P4 外置存储；按「项目 / 类型 / 时间戳」落盘（随机 `assetId`，不做内容寻址去重）；底图 / 高程图不入库（代码内置常量，项目只存 id，但**地形夸张覆盖值**存 `project_config`） |
| **4. 标记类元素** | `element_marker` | type ∈ point / flag / military_symbol |
| **5. 路线类元素** | `element_route` | type ∈ line / moving_point / connector |
| **6. 形状类元素** | `element_shape` | type ∈ polygon / arrow / double_arrow / gathering / encirclement |
| **7. 疆域类元素** | `element_territory` | type = territory；势力 / 地块 / 兼并事件 JSON 内联 |
| **8. 叠加层** | `overlay`、`overlay_block`、`person_block` | overlay 承载 10 类弹窗，仅 custom / person 需要子表 |
| **9. 应用配置** | `provider` | 与项目内容解耦；「每 kind 至多一条 active」由部分唯一索引保证 |

### 2.3 元素建模：按工具栏聚合的 4 张类别宽表

元素共 12 个子类型（point / flag / military_symbol / line / moving_point / connector / polygon / arrow / double_arrow / gathering / encirclement / territory）。它们**共享同一套公共字段**（id、章节、时间轴、可见性、层级、动画与移动配置），但**专有字段差异极大**（从 3 个到 47 个）。

三种映射方案的取舍：

| 方案 | 结构 | 问题 |
|---|---|---|
| 单表继承（STI） | 一张 `element` 承载全部子类列 | 12 类字段合计 60+ 列，多数行大面积 NULL；**子类必填规则无法表达**（如「`shape = 'emoji'` 时 `emoji` 必填」），约束退化回应用层 |
| 按类型拆表（1 基表 + 12 子表） | 主键共享的 CTI | 字段可各自约束，但 **`type` 判别列与子表行的一致性需要额外维护**；跨实体级联会留下孤儿基类行；表数量最多 |
| **按工具栏聚合（采用）** | **4 张类别宽表**，表内 `type` 判别子类型 | 表数量少；同类别内共享列；子类型必填规则由 `type` + CHECK 表达 |

**为什么按工具栏聚合**

- **贴合使用心智**：工具栏只有 4 个元素入口（标记 / 路线 / 形状 / 疆域），属性面板、渲染管线、查询维度都按这个维度组织，表结构与之一一对应
- **表数量可控**：12 张子表 → 4 张宽表，DDL、映射层与后续演进都显著简化
- **约束不丢失**：子类型必填仍写在表上，例如

  ```sql
  -- element_marker：emoji 形态必须有字符
  CHECK (type <> 'point' OR shape IS NOT 'emoji' OR emoji IS NOT NULL)
  -- element_route：连接线禁止自环
  CHECK (from_element_id IS NULL OR to_element_id IS NULL OR from_element_id <> to_element_id)
  ```

**代价与补偿**

取消 `element` 基表后，跨类别的**元素间引用**失去外键目标，由「应用层清理 + 自检视图」兜底（见 2.5；无触发器）；跨类别列举元素（时间线轨道、元素列表）改用视图 `v_element_index`（4 张表公共列的 UNION），**不做 4 路 JOIN**。

### 2.4 关键表字段定义

#### element_marker —— 标记类（44 列，最宽的一张）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `element_id` | TEXT | **PK** | 元素 id（与其它类别表共享同一 id 空间） |
| `chapter_id` | TEXT | **FK** → chapter CASCADE | 所属章节 |
| `type` | TEXT | **CHECK** IN (point, flag, military_symbol) | 子类型判别列 |
| `lng` / `lat` | REAL | NOT NULL | 坐标（三类标记都落在单点） |
| `shape` | TEXT | **CHECK** IN (circle, text, pin, bubble, emoji, image, gif, model, icon) | 点的 9 种视觉形态 |
| `asset_id` | TEXT | **FK** → asset SET NULL | 上传素材（图片 / GIF / 模型） |
| `builtin_id`、`icon_lib` + `icon_name` | TEXT | — | 内置资源 / 图标库引用 |
| `visual_meta_json` | TEXT | `json_valid()` | 形态专属参数（fit / fps / autoRotate / strokeWidth…） |
| `label_json` | TEXT | `json_valid()` | 元素标签（内联） |

其余公共列（`name` / `visible` / `locked` / `start_sec` / `end_sec` / `z_index` / `shape_category` / `anim_effect` / `fly_mode` / `show_icon` / `move_icon_json` / `ord`）见 `docs/db-tables.md` 的字段字典。

#### element_route —— 路线类（含唯一的元素间引用）

```sql
CREATE TABLE element_route (
  element_id TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapter(chapter_id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('line','moving_point','connector')),
  coords_json TEXT CHECK (coords_json IS NULL OR json_valid(coords_json)),
  -- connector 专用：端点弱引用（元素已分表，无外键目标）
  from_element_id TEXT,
  to_element_id   TEXT,
  CHECK (from_element_id IS NULL OR to_element_id IS NULL OR from_element_id <> to_element_id)
);
```

端点用**弱引用**：删除端点元素时，由应用层连带删除以它为端点的连接线。

#### 动画关键帧 —— 内联进类别表的 `keyframes_json`

透明度、缩放、旋转、绘制进度、路径进度、填充进度、morph 等曲线结构同构，作为 `keyframes_json` 列内联在 4 张类别宽表里（`[{property, sec, easing, value_num, value_json}]`）。运行时元素对象本就内联关键帧数组，独立成表反而需要「元素 ↔ 关键帧」的弱引用维护；「同一时刻同一属性不得重复」由应用层在写入时去重。

### 2.5 引用完整性策略

删除行为按「被引用对象的消失是否让引用失去意义」分档：

| 引用边 | 基数 | ON DELETE | 依据 |
|---|---|---|---|
| `project.collection_id` → `collection` | N:1 | **RESTRICT** | 删合集前须先把其下项目迁移到默认合集（应用层负责） |
| `project_config` → `project` | 1:1 | **CASCADE** | 配置随项目消亡 |
| 元素类别表 → `chapter` | N:1 | **CASCADE** | 章节是元素的生命周期边界 |
| `camera_keyframe.follow_route_element_id` → `element_route` | N:1 | **SET NULL** | 路线被删时视角退化为固定镜头 |
| `asset` 内部（`kind='icon'` 被元素引用） | N:1 | 应用层检查 | 三表合并后图标与素材同行，删除被引用素材由引用检查保护 |
| `element_marker.asset_id` → `asset` | N:1 | **SET NULL** | 素材被删则元素退回内置或空态 |
| `overlay_block` / `person_block` → `overlay` | N:1 | **CASCADE** | 内容块随弹窗消亡 |
| **`connector` 端点（`from` / `to`）** | N:1 ×2 | **弱引用 + 应用层清理** | 元素已分表，无外键目标 |

#### 弱引用的补偿机制

取消基表后有两处引用失去外键目标，改由**应用层清理 + 自检视图**兜底（**不使用触发器**）：

1. **应用层清理**（唯一的写入路径）：删除元素时连带删除以它为端点的连接线、以及挂在它名下的关键帧
2. **`v_check_dangling` 视图**：检出悬空引用（连接线端点、关键帧归属、跟随机位、自定义图标符号），正常应返回 0 行

> 为什么不用触发器：网页端是 Dexie（IndexedDB），**没有触发器**，数据库侧触发器只在桌面端生效，同一条规则会有两套真相；且规则藏在表定义之外、与写入端逻辑重复。详见 2.6。

#### 为什么跟随机位不用复合外键

直觉上可用复合外键 `(chapter_id, follow_route_element_id) → element_route(chapter_id, element_id)` 同时保证「同章节」与「删路线置空」。但 **SQLite 在复合外键触发 SET NULL 时会把全部引用列置空 —— 包括 NOT NULL 的 `chapter_id`**，操作会直接失败。

因此采取二分策略：

- 能配合 **CASCADE** 的同域约束 → 用**复合外键**
- 必须 **SET NULL** 的同域约束 → 退回**单列外键**（`camera_keyframe`），「同章节」这一条改由**应用层**校验

### 2.6 约束：不使用触发器

DDL **不定义任何触发器**（原 6 条已于 2026-09-12 全部移除）。移除理由：

| 理由 | 说明 |
|---|---|
| 双端不一致 | 网页端 Dexie（IndexedDB）没有触发器，数据库侧触发器只在桌面端生效，同一条规则会有两套真相 |
| 规则不可见 | 触发器把「删元素连带删什么」藏在表定义之外，读 DDL 看不出来 |
| 逻辑重复 | 清理逻辑与写入端重复，隐式行为干扰调试、导入与数据修复 |

原触发器承担的两条规则迁移到应用层：

| 原规则 | 现由谁保证 |
|---|---|
| 删元素 → 连带删除以它为端点的 connector、以及它名下的关键帧 | 应用层删除元素时一并清理 |
| 跟随机位只能引用同一章节内的路线元素 | 写入端校验（选择跟随机位时只列本章路线） |

### 2.7 一致性自检

提供 **3 个视图**，日常体检与数据修复后运行，均**应返回 0 行**：

| 视图 | 检出 |
|---|---|
| `v_element_index` | **读取便利**：4 张类别表的公共列 UNION 成「元素总表」，轨道 / 列表 / 计数直接查它 |
| `v_check_dangling` | 悬空引用：连接线端点、关键帧归属、跟随机位、自定义图标符号 |
| `v_check_territory_ref` | 疆域 JSON 内部一致性：`plots_json.ownerId` / `events_json.toCountryId` 必须能在 `countries_json` 中命中 |

## 三、设计依据汇总

| 设计决策 | 依据 |
|---|---|
| 元素按工具栏聚合为 4 张类别宽表 | 12 个子类型专有字段 3–47 个、离散度极大：单表继承会产出 60+ 可空列并丧失子类必填约束；按类型逐张拆表则表数最多且需额外维护判别列与具化行的一致性 |
| 动画关键帧内联为 `keyframes_json` | 运行时元素对象本就内联关键帧数组，独立成表需要弱引用维护；P3 内联跟随元素整体读写（原独立表已取消） |
| 元素标签内联为 `label_json` | 标签是可选 1:1 值对象；元素已分表，独立成表会失去统一的外键目标 |
| GlobalConfig 独立成 `project_config` | 配置与项目本体职责分离：`project` 只留身份 / 归属 / 审计字段，配置面板只读写配置表；将来新增配置项不改动 `project` 结构 |
| `asset` 表承担 P4 外置 | base64 内嵌是当前最大的性能问题；内容寻址（sha256）顺带获得同图去重 |
| 同域约束按删除行为二分 | 能配合 CASCADE 的用复合外键；必须 SET NULL 的（跟随机位）退回单列外键，「同章节」由应用层校验 —— SQLite 复合外键 SET NULL 会连带清空 NOT NULL 的 `chapter_id` |
| 样式标量走 P3 JSON | 固定形状、整体读写、不参与检索；列化它们会产生 100+ 张无意义的表 |
| `provider` 加部分唯一索引 | 「每 kind 至多一条 active」从应用层两步写（先全清后置位）升级为数据库保证 |
| 布尔统一 INTEGER 0/1 + CHECK | SQLite 无布尔类型，显式 CHECK 防止写入 `'true'`/`2` 之类的脏值 |
| 所有 JSON 列加 `json_valid()` | 保留 P3 灵活性的同时，至少保证「是合法 JSON」，避免半截字符串入库 |

## 四、收益与代价

#### 收益

- **正确性：**引用完整性由外键（`CASCADE` / `SET NULL` / `RESTRICT`）保证；弱引用（连接线端点、关键帧归属）由**应用层**在删除元素时一并清理

- **性能：**素材外置后项目 JSON 从数 MB 降到数十 KB；保存从全量重写变为按实体增量

- **可查询：**「找所有引用了已删符号的元素」从内存全扫变为一条 SQL

- **可演进：**结构变更不再散落成无版本的手工迁移链，改由集中式的一次性升级脚本处理

- **可诊断：**3 个自检视图把「数据损坏」从隐性变为可检测

#### 代价

- **适配层复杂度：**需要 `project-mapper.ts` 承担双向映射，约数百行

- **写入需事务：**保存一个元素要写它所属的类别表（+ 可能的关键帧表），必须包在事务里

- **弱引用的维护成本：**连接线端点与关键帧归属没有外键目标，新增跨表引用时必须重复「应用层清理 + 自检视图」这个模式；且清理只在写入端生效，数据库侧不再有第二道保险

- **两类存储范式并存：**桌面端规范化、网页端文档型，需在 mapper 层明确边界

## 五、验证结果

DDL 已用 Node 内置 `node:sqlite`（Node v22.22.2）在内存库中实际执行并跑完完整性用例：

- 18 表创建成功
- 3 视图
- 0 触发器（不使用触发器）
- 17/17 用例通过

| 用例 | 验证内容 | 结果 |
|---|---|---|
| 1 | marker 表按 `type` 承载 point / flag / military_symbol 三种子类型 | 通过 |
| 2 | shape / route / territory 三张类别表插入正常 | 通过 |
| 3 | CHECK：point 的 `shape='emoji'` 必须给 emoji | 通过 被拒 |
| 4 | CHECK：flag 必须给 `flag_text` | 通过 被拒 |
| 5 | CHECK：connector 端点不得自环 | 通过 被拒 |
| 6 | CHECK：connector 必须给两端 | 通过 被拒 |
| 7 | `keyframes_json` 内联插入正常（合法 JSON） | 通过 |
| 8 | 删章节 → 元素与关键帧级联清理 | 通过 |
| 9 | **删元素 → 以它为端点的 connector 由应用层清理** | 通过 1 → 0（应用层） |
| 10 | 删元素 → 它名下的 keyframe 自动清理 | 通过 |
| 11 | 删连接线自身 → 无递归、无误删 | 通过 |
| 12 | 删被跟随的路线 → 跟随机位置空（FK SET NULL） | 通过 |
| 13 | follow 指向不存在 / 跨章节路线 → 由写入端拒绝 | 通过 被拒（应用层） |
| 14 | `v_check_territory_ref` 抓到「地块归属 / 兼并目标势力不存在」 | 通过 2 行 |
| 15 | `v_element_index` 汇总 4 类元素 | 通过 |
| 16 | `v_check_dangling` 在干净库上返回 0 行 | 通过 |
| 17 | `provider` 每 kind 至多一条 active | 通过 被拒 |

完整可执行 DDL：`docs/db-schema-v2.sql`（含分节注释与自检视图，无触发器）。

## 六、未决问题

| # | 问题 | 说明 |
|---|---|---|
| Q1 | `keyframes_json` 的「同一时刻重复定义」校验 | 内联后无数据库唯一索引，写入端需自行去重（同 property 同时刻只保留最后一个） |
| Q2 | `chapter` 时间跨度的重叠约束 | 当前只加了 `ux_chapter_span(project_id, start_sec)`（起点不重复）。是否允许章节时间区间重叠需与产品确认，若不允许需由应用层校验 |
| Q3 | 素材文件的生命周期与垃圾回收 | 元素被删后 `asset` 行仍在（无反向引用）。需要定期「孤儿素材清理」任务，或改用引用计数 |
| Q4 | `move_icon_json` 内的 `symbolId` 是弱引用 | P3 JSON 内的符号引用无法用外键约束。可选：把 `moveIcon` 提升为独立表以换取约束能力，但会为各类元素都增加一次 JOIN |
| Q5 | 撤销/重做（50 步历史栈）与数据库的关系 | 历史栈完全在内存（快照式）；数据库只承载「已保存」状态，这是有意的边界 |
| Q6 | 弱引用的一致性兜底策略 | `connector` 端点无外键目标，现由**应用层清理** + `v_check_dangling` 兜底（无触发器；关键帧已内联进元素表，不再有该弱引用）。**待定：是否在保存 / 导入后强制跑一次自检，非 0 行即回滚？** |
| Q7 | 疆域 JSON 内联后的一致性校验时机 | `plots_json.ownerId` / `events_json.toCountryId` 的合法性由 `v_check_territory_ref` 校验（`json_each` 实现）。待定：是否前置为写路径硬校验（保存前跑），避免脏数据入库 |
| Q8 | 图标库（原 `custom_symbol`）的 UI 入口 | 三表合并后图标库条目 = `asset(kind='icon')`；当前仍无上传/管理面板，待确认是否补入口或下线该能力 |

---

MapVideo 数据模型分析与数据库重设计 · 基于 `src/types/index.ts`、`src/stores/projectStore.ts`、`src/stores/db.ts`、`electron/main.mjs`、`README.md` 的实际代码梳理。

配套产物：`docs/db-schema-v2.sql`（已验证可执行）、`docs/db-tables.md`（表清单与字段字典）、`docs/db-er-diagram.mmd`（E-R 图源）。
