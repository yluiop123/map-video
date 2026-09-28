# MapVideo 数据库设计（设计依据）

> 只回答「为什么这么设计」。当前结构不由本文描述：DDL 看 `docs/db-schema-v2.sql`，
> 表与字段看 `docs/db-tables.md`（生成），配置层四层看 `docs/provider-engine.md`。

- **引擎**：SQLite（`node:sqlite`，桌面端）/ Dexie（网页端）
- **规模**：表 / 视图 / 列数**不抄在这里** —— 以 `docs/db-tables.md` 里 `gen-db-field-dict` 写出的那一行为准（改 DDL 后重跑，`--check` 盯漂移）
- **配套**：`docs/db-schema-v2.sql`（DDL 事实源）、`docs/db-tables.md`（表清单与字段字典）、`docs/db-er-diagram.mmd`（E-R 图源）

## 结论摘要

把数据语义下沉到数据库，由结构本身保证正确性：

- **元素建模**：12 个元素子类型按工具栏聚合为 **5 张类别宽表**（标记 / 路线 / 形状 / 疆域 / 贴图），表内用 `type` 判别列区分子类型，子类型必填规则由 CHECK 约束表达
- **关联与多重性**：用主外键、唯一索引与 1:N / 1:1 表结构固化；少数无法建外键的引用（贴图 / 公共库副本的 `asset_id`、疆域 JSON 内部引用）由**写入端保证 + 自检视图**兜底（不使用触发器）
- **生命周期**：用 `CASCADE / SET NULL / RESTRICT` 三档策略区分，删除父实体时由数据库负责清理
- **大体积素材**：二进制内容从项目数据中剥离进 `asset` 表（assetId 随机、不做内容去重），业务表只留 `asset_id`

## 一、关系模型设计

### 1.1 归一化策略：哪些列化、哪些留 JSON

全量规范化会把 100+ 个样式标量炸成 100+ 张表；全量 JSON 就等于把整个项目塞回一列。先定一条可复用的判定规则，再逐字段归类：

| 级别 | 判定标准 | 处理方式 | 典型字段 |
|---|---|---|---|
| **P1** 必列化 | 身份、时间轴、以及构成引用图的字段 —— 约束与查询都依赖它们 | 独立列 + 主键 / 外键 / CHECK | `id`、`start_sec`、`end_sec`、`project_id`、`from_element_id` |
| **P2** 独立成表 | 子结构自身有 id 或顺序语义，需被单独约束或寻址 | 1:N 子表 | `narration_entry` |
| **P3** 保留 JSON | 固定形状、整体读写、不参与约束与检索的配置块 | JSON 列 + `json_valid()` 约束 | `display_json`、`front_style_json`、`route_effect_json`、`label_json`、`countries_json` / `plots_json` / `events_json` |
| **P4** 外置存储 | 大体积二进制内容 | 独立 `asset` 表，业务表只留 `asset_id` | 图片、音频、视频、模型、字体 |

注：`chart.data` / `timeline.items` / `dialogue.items` 虽是数组，但不被单独寻址、无逐项约束，按 P3 留在 `payload_json`；而关键帧虽也是数组，却带 `(element_id, property, sec)` 唯一性与时间轴语义，按 P2 建表。

### 1.2 元素建模：按工具栏聚合的 5 张类别宽表

元素共 12 个子类型（point / flag / military_symbol / line / moving_point / polygon / arrow / double_arrow / gathering / encirclement / territory / geo_image）。它们**共享同一套公共字段**（id、项目与图层归属、时间轴、可见性、层级、动画与移动配置），但**专有字段差异极大**（从 3 个到 47 个）。

三种映射方案的取舍：

| 方案 | 结构 | 问题 |
|---|---|---|
| 单表继承（STI） | 一张 `element` 承载全部子类列 | 13 类字段合计 60+ 列，多数行大面积 NULL；**子类必填规则无法表达**（如「`shape = 'emoji'` 时 `emoji` 必填」），约束退化回应用层 |
| 按类型拆表（1 基表 + 13 子表） | 主键共享的 CTI | 字段可各自约束，但 **`type` 判别列与子表行的一致性需要额外维护**；跨实体级联会留下孤儿基类行；表数量最多 |
| **按工具栏聚合（采用）** | **5 张类别宽表**，表内 `type` 判别子类型 | 表数量少；同类别内共享列；子类型必填规则由 `type` + CHECK 表达 |

**为什么按工具栏聚合**

- **贴合使用心智**：工具栏只有 4 个元素入口（标记 / 路线 / 形状 / 疆域），属性面板、渲染管线、查询维度都按这个维度组织，表结构与之一一对应
- **表数量可控**：12 张子表 → 5 张宽表，DDL、映射层与后续演进都显著简化
- **约束不丢失**：子类型必填仍写在表上，例如

  ```sql
  -- element_marker：emoji 形态必须有字符
  CHECK (type <> 'point' OR shape IS NOT 'emoji' OR emoji IS NOT NULL)
  -- element_route：line 必须有路径点
  CHECK (type <> 'line' OR coords_json IS NOT NULL)
  ```

**代价与补偿**

取消 `element` 基表后，跨类别的**元素间引用**失去外键目标，只能由「写入端保证 + 自检视图」兜底（见 2.5；无触发器）—— 这是连接线当年被否掉的直接原因；跨类别列举元素（时间线轨道、元素列表）改用视图 `v_element_index`（5 张表公共列的 UNION），**不做 5 路 JOIN**。

### 1.3 引用完整性策略

删除行为按「被引用对象的消失是否让引用失去意义」分档：

| 引用边 | 基数 | ON DELETE | 依据 |
|---|---|---|---|
| `project.collection_id` → `collection` | N:1 | **RESTRICT** | 删合集前须先把其下项目迁移到默认合集（应用层负责） |
| `project` → `project` | 1:1 | **CASCADE** | 配置随项目消亡 |
| 元素类别表 → `project` | N:1 | **CASCADE** | 项目是元素的生命周期边界 |
| `camera_keyframe.follow_route_element_id` → `element_route` | N:1 | **SET NULL** | 路线被删时视角退化为固定镜头 |
| `asset` 内部（`kind='icon'` 被元素引用） | N:1 | 应用层检查 | 三表合并后图标与素材同行，删除被引用素材由引用检查保护 |
| `element_marker.asset_id` → `asset` | N:1 | **SET NULL** | 素材被删则元素退回内置或空态 |
| `overlay（内容块内联）` / `overlay（人物块内联）` → `overlay` | N:1 | **CASCADE** | 内容块随弹窗消亡 |

#### 弱引用的补偿机制

取消基表后剩下的弱引用只有三处，全部由写入端保证（**不使用触发器**）：

（`project.active_base_map_id` / `active_elevation_map_id` 曾是「父子互引」的弱引用；底图 / 高程目录改成全库一份后互引不存在了，两列仍保持弱引用 —— 目录行由渲染端按常量铺，挂成真外键会让「目录还没铺好时的一次保存」直接崩。悬空由 `v_check_dangling` 照。）

1. **写入端保证**：`element_image.asset_id`（贴图本体）、`public_element_*.asset_id`（公共库副本）、`element_territory` 的 countries / plots / events JSON 内部引用、`project.active_base_map_id` / `active_elevation_map_id`（项目 ↔ 子行互引，见 1.2）、`task.project_id` / `task.entry_id`（任务行是调度状态、不是项目内容，而保存项目 = 删了重写，挂成真外键会让每次自动保存 CASCADE 掉在途任务；删项目由 `removeProjectV2` 显式清）。项目侧 `element_marker.asset_id`、`move_icon_asset_id`、音频列、`camera_keyframe.follow_route_element_id` 都是真外键（SET NULL），删除父行由数据库负责，应用层无需连带清理
2. **`v_check_dangling` 视图**：检出悬空的跟随机位（`PRAGMA foreign_keys=OFF` 的批量迁移与老库才会出现），`v_check_territory_ref` 检出疆域 JSON 内部失配，正常应返回 0 行

> 为什么不用触发器：网页端是 Dexie（IndexedDB），**没有触发器**，数据库侧触发器只在桌面端生效，同一条规则会有两套真相；且规则藏在表定义之外、与写入端逻辑重复。详见 1.4。

#### 为什么跟随机位不用复合外键

直觉上可用复合外键 `(project_id, follow_route_element_id) → element_route(project_id, element_id)` 同时保证「同章节」与「删路线置空」。但 **SQLite 在复合外键触发 SET NULL 时会把全部引用列置空 —— 包括 NOT NULL 的 `project_id`**，操作会直接失败。

因此采取二分策略：

- 能配合 **CASCADE** 的同域约束 → 用**复合外键**
- 必须 **SET NULL** 的同域约束 → 退回**单列外键**（`camera_keyframe`），「同章节」这一条改由**应用层**校验

### 1.4 约束：不使用触发器

DDL **不定义任何触发器**（原 6 条已于 2026-09-12 全部移除）。移除理由：

| 理由 | 说明 |
|---|---|
| 双端不一致 | 网页端 Dexie（IndexedDB）没有触发器，数据库侧触发器只在桌面端生效，同一条规则会有两套真相 |
| 规则不可见 | 触发器把「删元素连带删什么」藏在表定义之外，读 DDL 看不出来 |
| 逻辑重复 | 清理逻辑与写入端重复，隐式行为干扰调试、导入与数据修复 |

原触发器承担的两条规则迁移到应用层：

| 原规则 | 现由谁保证 |
|---|---|
| 跟随机位只能引用同一章节内的路线元素 | 写入端校验（选择跟随机位时只列本章路线） |

**同类规则（公共图层副本必须自洽）**：`public_element_*` 与项目侧同构，但副本**脱离源项目独立存在**，`asset_id` 建不了指向项目 `asset` 的外键。于是有两条硬约束：① **失效引用要清、不能造假素材行** —— 删素材时 `assets:remove` 一并把副本里的引用置空，启动时 `repairAssetRefs` 再兜一次底（项目侧 `asset_id` 是真外键，带悬空引用插入会被整笔事务打回；塞占位行则是把坏数据藏进素材库）；② **副本 `element_id` 一律加后缀**（保存 `:pb<pubId>` / 导入 `:im<layerId>`），因为 `element_id` 是全库主键，不换 id 会让「同一图层导入两次」互相撞车。回归：`node --experimental-strip-types --experimental-sqlite tools/verify-public-layers.mjs`。

### 1.5 一致性自检

提供 **3 个视图**，日常体检与数据修复后运行，均**应返回 0 行**：

| 视图 | 检出 |
|---|---|
| `v_element_index` | **读取便利**：5 张类别表的公共列 UNION 成「元素总表」，轨道 / 列表 / 计数直接查它 |
| `v_check_dangling` | 悬空引用：跟随机位指向已删除的路线元素；贴图与公共库副本指向不存在的素材（无外键的那几列） |
| `v_check_territory_ref` | 疆域 JSON 内部一致性：`plots_json.ownerId` / `events_json.toCountryId` 必须能在 `countries_json` 中命中 |

## 二、设计依据汇总

| 设计决策 | 依据 |
|---|---|
| 元素按工具栏聚合为 4 张类别宽表 | 12 个子类型专有字段 3–47 个、离散度极大：单表继承会产出 60+ 可空列并丧失子类必填约束；按类型逐张拆表则表数最多且需额外维护判别列与具化行的一致性 |
| 动画关键帧内联为 `keyframes_json` | 运行时元素对象本就内联关键帧数组，独立成表需要弱引用维护；P3 内联跟随元素整体读写（原独立表已取消） |
| 元素标签内联为 `label_json` | 标签是可选 1:1 值对象；元素已分表，独立成表会失去统一的外键目标 |
| GlobalConfig 独立成 `project` | 配置与项目本体职责分离：`project` 只留身份 / 归属 / 审计字段，配置面板只读写配置表；将来新增配置项不改动 `project` 结构 |
| `asset` 表承担 P4 外置 | base64 内嵌是当前最大的性能问题；assetId 与文件名解耦，随机 id + 时间戳命名（不做内容寻址去重，代价是同文件传两次会存两份） |
| 同域约束按删除行为二分 | 能配合 CASCADE 的用复合外键；必须 SET NULL 的（跟随机位）退回单列外键，「同章节」由应用层校验 —— SQLite 复合外键 SET NULL 会连带清空 NOT NULL 的 `project_id` |
| 样式标量走 P3 JSON | 固定形状、整体读写、不参与检索；列化它们会产生 100+ 张无意义的表 |
| `provider` 用 `kind` 做主键 | 「一个能力一处配置」由数据库直接保证 —— 不再有「同 kind 多行 + 哪条生效」，也就不需要部分唯一索引与先清后置的两步写 |
| 布尔统一 INTEGER 0/1 + CHECK | SQLite 无布尔类型，显式 CHECK 防止写入 `'true'`/`2` 之类的脏值 |
| 所有 JSON 列加 `json_valid()` | 保留 P3 灵活性的同时，至少保证「是合法 JSON」，避免半截字符串入库 |

## 三、收益与代价

#### 收益

- **正确性：**引用完整性由外键（`CASCADE` / `SET NULL` / `RESTRICT`）保证；仅存的五处弱引用（贴图素材、公共库副本素材、疆域 JSON、生效底图/高程指针、任务的 project_id/entry_id）由写入端保证 + 自检视图兜底

- **性能：**素材外置后项目 JSON 从数 MB 降到数十 KB；保存从全量重写变为按实体增量

- **可查询：**「找所有引用了已删符号的元素」从内存全扫变为一条 SQL

- **可演进：**结构变更不再散落成无版本的手工迁移链，改由集中式的一次性升级脚本处理

- **可诊断：**3 个自检视图把「数据损坏」从隐性变为可检测

#### 代价

- **适配层复杂度：**双向映射集中在 `electron/db-v2.mjs`（帧 ↔ 秒的换算就在这一层）

- **写入需事务：**保存一个元素要写它所属的类别表（+ 可能的关键帧表），必须包在事务里

- **弱引用的维护成本：**贴图 / 公共库副本的 `asset_id`、疆域 JSON、生效底图与高程指针、任务的 `project_id` / `entry_id` 没有外键目标，新增跨表引用时必须重复「写入端保证 + 自检视图」这个模式；且校验只在写入端生效，数据库侧不再有第二道保险

- **两类存储范式并存：**桌面端规范化、网页端文档型，需在 mapper 层明确边界

## 四、边界与兜底（这些取舍是有意的）

| 边界 | 为什么这样定 |
|---|---|
| 动画关键帧「同一 property 同一时刻只留一条」不建数据库唯一索引 | 关键帧内联在 `keyframes_json`，约束由写入端去重承担；换约束要把每类元素都拆出 JOIN |
| 跨表引用只在**写入端**校验，数据库侧靠 `v_check_dangling` / `v_check_territory_ref` / `v_check_async_pairing` 三个视图体检 | 视图不拦截写入，只做启动/回归时的自查；不用触发器（网页端 IndexedDB 没有触发器，同一条规则不能两套真相） |
| 撤销 / 重做历史栈完全在内存（快照式） | 数据库只承载「已保存」状态，这是有意的边界 —— 历史栈进库等于把 50 步快照写成 50 份项目 |
| 元素被删后 `asset` 行不自动回收 | 素材是全局资产、可能被公共库副本引用；孤儿清理是独立任务（见 AGENTS §9），不做引用计数 |
| `task` 对 `project` / `narration_entry` 用弱引用 | 「保存项目」= 删了重写，真外键 `CASCADE` 会让每次自动保存杀掉在途任务（详见 `docs/provider-engine.md` 第七条） |

---

MapVideo 数据模型分析与数据库重设计 · 基于 `src/types/index.ts`、`src/stores/projectStore.ts`、`src/stores/db.ts`、`electron/main.mjs`、`README.md` 的实际代码梳理。

配套产物：`docs/db-schema-v2.sql`（已验证可执行）、`docs/db-tables.md`（表清单与字段字典）、`docs/db-er-diagram.mmd`（E-R 图源）。
