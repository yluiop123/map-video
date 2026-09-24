# MapVideo V2 表清单速查

> 27 张表、4 个视图、**不使用触发器** —— 元素表按工具栏分为 5 张类别宽表（另有 5 张同构的公共元素副本表），从「整个项目塞进一列 JSON」到「规范化关系表」的逐表对照。

- **数据源**：`docs/db-schema-v2.sql`（唯一事实源，DDL 已实测可执行）
- **设计依据**：`docs/db-redesign.md`
- **规模**：27 张表 · 5 张元素类别宽表 + 5 张公共元素副本表 · 4 个视图 · 0 个触发器 · 703 列（外键全部有索引）

**目录**

- 一、27 张表的构成与分流规则
- 二、字段归属：TS 类型 → 数据库表
- 三、27 张表逐表速查（按 11 组）
- 四、每张表的字段（字段字典）
- 五、工具栏与元素类型
- 六、容易混淆的 5 组
- 七、一次「打开」与一次「保存」
- 附：4 个视图，以及为什么没有触发器

## 一、27 张表的构成与分流规则

**27 张表不是 24 个新概念**，而是同一个项目数据按「字段从哪来、怎么用」拆开的结果。整体按下面四条规则分流：

| 规则 | 判据 | 处理方式 | 落到的表 |
|---|---|---|---|
| **P1** 必列化 | 身份、时间、引用关系 —— 需要检索、排序、约束 | 提升为独立列 | `element_marker` / `element_route` / `element_shape` / `element_territory` / `element_image` 的公共列，及其 5 张公共副本表 |
| **P2** 独立成表 | 自身有 id 或顺序语义，需被单独寻址或约束 | 1:N 子表 | `narration_entry`、`public_element_*` |
| **P3** 留下 JSON | 固定形状、整体读写、不参与约束与检索的配置块 | JSON 列 + `json_valid()` | `display_json`、`countries_json` / `plots_json` / `events_json` 等 |
| **P4** 外置存储 | 大体积二进制（图片、音频、视频、字体） | 独立 `asset` 表，业务表只留 `asset_id` | `asset` |

#### 一句话理解 27 张表的构成

- **5 张**是「元素」，按**工具栏按钮**聚合：标记 · 路线 · 形状 · 疆域 · 图片**各一张宽表**，表内用 `type` 判别列区分该工具下的全部子类型（详见第三节、第五节）；动画关键帧也内联在各表的 `keyframes_json` 列；
- **6 张**是「公共图层库」：`public_layer` + 5 张与项目元素表**同构**的公共副本表（把某个图层连元素整体复制一份，供其它项目导入）；
- **5 张**是「时间轴上的子集合」：镜头关键帧、屏幕特效、字幕档、字幕条目、配乐段落；
- **1 张**是「弹窗」：`overlay` 本体（custom / person 内容块内联 `payload_json`，原 3 张内容块表已删除）；
- **1 张**是「素材库」：`asset`（自定义图标 / 图片 / GIF / 模型 / 音频等二进制，`kind` 区分，按「项目 / 类型 / 时间戳」落盘）；
- **2 张**是「底图 / 高程目录」：`base_map` · `elevation_map`，**每项目一份**（内置项在创建项目时作为普通行复制进来，之后各项目各改各的）；
- **4 张**是「应用配置」：`provider_template` · `provider` · `voice` · `task`（与项目内容解耦，见 `docs/provider-engine.md`）；
- **3 张**是合集、项目本体、图层。

## 二、字段归属：TS 类型 → 数据库表

下表左边是代码里的数据模型（`src/types/index.ts`），右边是它落到哪张表 —— 理解这套设计最直接的入口。

| TS 类型（src/types/index.ts） | 落到表 | 处理方式与理由 |
|---|---|---|
| （合集层级） | `collection` + `project.collection_id` | 项目之上的一层分组（合集 ▸ 项目 ▸ 图层 ▸ 元素）；未指定归属时落默认合集 `default` |
| `MapVideoProject.id / name / description / createdAt / updatedAt` | `project` | P1 列化 |
| `globalConfig`（defaultDuration / defaultFPS / defaultResolution / defaultEasing） | `project` 的配置列（`default_duration_sec` / `default_fps` / `resolution_w` / `resolution_h` / `default_easing`） | P1 列化：配置并入项目本体（原 1:1 `project_config` 表已取消） |
| `globalConfig.projection` | `project` 的 `projection` 列 | P1 列化：地图投影是项目自身的属性（渲染方式），随项目走，不属于「默认值类」配置 |
| `baseMaps[]`（`BaseMapConfig`：id/name/style） | `base_map`（**每项目一份**） | 面板能增删改 → 必须能存：内置目录在创建项目时作为普通行复制进来，之后各项目各改各的；`style` 是 URL 走 `style_url`，是内联样式对象走 `style_json` |
| `elevationMaps[]`（`ElevationMapConfig`：id/name/url/encoding/exaggeration/style） | `elevation_map`（**每项目一份**） | 同上；**地形夸张系数直接落在本行**（0–50，空=渲染端默认 1.5），不再是 `project` 上的孤立覆盖值 |
| `activeBaseMapId` / `activeElevationMapId` | `project.active_base_map_id` / `active_elevation_map_id` | 弱引用上面两张表的行；不建外键是因为父子互引（项目行须先于子行写入） |
| `customSymbols[]` / `customImages[]`（图标库 / 图片库登记） | `asset`（`kind='icon'` / `kind='image'`） | **三表已合并**：两者都只是项目收录的一个素材行，二进制走 P4 外置 |
| `layers[]`（`Layer`：type/name/visible/startFrame/endFrame/elements[]） | `layer` + 各元素表的 `layer_id` | P2：**项目 ▸ 图层 ▸ 元素**；单类型图层（marker / route / shape / territory / image）；删图层连带删元素（CASCADE） |
| （公共图层库：整层复制的副本） | `public_layer` + `public_element_marker` / `_route` / `_shape` / `_territory` / `_image`（5 张同构副本表） | P2：与项目侧一一对应的**独立副本**，`public_layer_id` 外键（删公共图层 CASCADE）；副本**必须自洽** —— `asset_id` 是弱引用，失效引用由启动体检清空（不造假素材行）；`element_id` 是全库主键，副本一律加后缀避免撞车 |
| `project.elements[]`（`layers[].elements` 的派生镜像） | `element_marker` / `element_route` / `element_shape` / `element_territory` / `element_image`（5 张类别宽表） | P1 公共字段 + 表内 `type` 判别子类型（取消基表）；镜像不入库，只存图层归属 |
| `elements[].style` / `drawProgress` / `morphKeyframes`（关键帧数组） | 类别表的 `keyframes_json`（P3 内联） | 运行时元素对象本就内联关键帧；同 property 同时刻由应用层去重 |
| `elements[].label`（`LabelConfig`） | 各元素表的 `label_json` 列 | P3 内联：1:1 且可选，跟随元素整体读写 |
| `camera[]`（项目级） | `camera_keyframe` | P2；`followRoute.routeElementId` 变成外键（删路线 → 退化为固定视角） |
| `overlays[]`（项目级） | `overlay` | P2：本体一张；custom / person 的内容块内联在 `payload_json`（原两张中间表已删除） |
| `fx[]`（`ScreenFxItem`） | `screen_fx` | P2：屏幕空间特效窗口，与地图元素区分 |
| `narration`（`NarrationTrack`） | `narration` + `narration_entry` | P2：档（样式/1:1）+ 条目（1:N） |
| `music[]`（项目级） | `music_track` | P2；音频本体走 `asset` |
| `territory` 元素内的 `countries / plots / events` | `element_territory` 的 `countries_json` / `plots_json` / `events_json` | P3 内联：疆域自包含、整体读写；代价是失去复合外键，由 `v_check_territory_ref` 视图兜底 |
| `geo_image` 元素（地理配准贴图） | `element_image` 的 `grid_json` | P3 内联：控制点网格 `(rows+1)×(cols+1)`（2×2=四角投影，更大=网格变形）；图片本体走**全局素材库**（`asset_id` 弱引用、无外键） |
| （二进制素材） | `asset` | P4 外置存储：图片 / 音频 / 视频 / 字体统一入表，业务表只留 `asset_id` |
| `providers` | `provider` + `provider_template` | 独立聚合；界面拿到的实例 = provider 行 + 它引用的模板行（`values_json` 两段 + 模板声明），**没有 `active` 与部分唯一索引** —— 一个模板多条实例，调用处选一条 |

> 注：底图 / 高程图**每项目一份**（`base_map` / `elevation_map`）—— 面板支持增删改与调地形夸张，「内置常量不入库」的前提早已不成立。
> **例外**：「地形夸张系数」用户在面板可调（0–50，默认 1.5），是对当前生效高程图的覆盖值，因此落在 `project.elevation_exaggeration`（为空则用内置默认）。

## 三、27 张表逐表速查（按 11 组）

读法：**表名** · 一句话职责 · 主键 · 删除行为。

### 组 1 · 合集 / 项目 / 图层（含配置） 3 张

| 表 | 职责 | 主键 | 关键点 | 前端对应 |
|---|---|---|---|---|
| `collection` | 项目之上的一层分组（合集 ▸ 项目 ▸ 元素） | `collection_id` | 默认合集恒为 `default`：**不可改名、不可删除**；删其它合集时其下项目回落默认合集（**不删项目**） | 项目列表页左栏合集列表（`ProjectManager.tsx`） |
| `project` | 项目本体：身份 + 归属 + 审计字段 + 地图投影 + 当前生效的底图与高程图 | `project_id` | `collection_id` 指回所属合集（默认 `default`）；`active_base_map_id` 有意不建索引（恒 1 行，扫描成本是常数） | 项目卡片（`ProjectManager.tsx`）；运行时即 `projectStore.project` |
| `layer` | 图层：元素的分组，**单类型**（marker / route / shape / territory / image），带显隐与显示区间 | `layer_id` | 随项目 **CASCADE**；元素通过 `layer_id` 归属（删图层连带删元素）；`ord` 定序 | 左侧「图层」浮层（`ElementsPanel.tsx`）+ 时间线图层轨道 |

### 组 2 · 底图 / 高程图 / 素材 3 张

| 表 | 职责 | 主键 | 删除行为 | 前端对应 |
|---|---|---|---|---|
| `base_map` | 底图目录（**项目自带一份**）：id / 名称 / 样式（URL 或内联对象二选一） | `project_id + base_map_id`（内置 id 各项目同名） | 随项目 **CASCADE** | 地图左下角底图芯片面板（`MapStyleChip.tsx`）+ `projectStore.addBaseMap / removeBaseMap` |
| `elevation_map` | 高程图目录（**项目自带一份**）：瓦片 URL / 编码 / **地形夸张系数** / 可选配套底图 | `project_id + elevation_map_id` | 随项目 **CASCADE** | 同一面板的「高程」区（选择 + 夸张系数滑动条） |
| `asset` | 唯一素材存储（图片 / GIF / 模型 / 音频 / 字体 / 用户图标，`kind` 区分），按「项目 / 类型 / 时间戳」落盘（随机 `assetId`，不做内容寻址去重） | `asset_id` | 随项目 **CASCADE**；孤儿回收是待办项（需定期清理或引用计数） | 属性面板上传行（`ResourceUploadRow`）、标记面板自定义图片网格（`CustomImageGrid`）、字幕/配乐音频上传（`lib/assets.ts`） |

### 组 3 · 时间轴 5 张

项目这条连续时间线上，除元素之外的 5 类子集合，逐类一张表（原 `chapter` 表已随「章节」概念一并取消）。

| 表 | 内容 | 主键 | 关键字段 / 行为 | 前端对应 |
|---|---|---|---|---|
| `camera_keyframe` | `camera[]` | `kf_id` | `frame` 是**到达时间**，`move_duration` 是起飞提前量；`follow_route_element_id` 删路线后 `SET NULL`（退化为固定视角） | 「视角」面板（`KeyframePanel.tsx` / `CameraEditor.tsx`） |
| `screen_fx` | `fx[]` | `fx_id` | 屏幕空间特效窗口（天气/画面），与地图元素分离 | 「特效」面板（`FxPanelBody.tsx`）+ 时间轴特效轨道 |
| `narration` | `narration` 的样式部分 | `project_id` | 1:1，主键即外键 | 「字幕」面板（`FxPanelBody.tsx`） |
| `narration_entry` | `narration.entries[]` | `entry_id` | 一条字幕 = 一行；音频走 `asset` | 时间轴「🎙 配音」轨道 + 字幕面板（TTS / 导入 SRT） |
| `music_track` | `music[]`（项目级） | `track_id` | 项目单轨多段（项目绝对时间）；音频走 `asset` | 时间轴「音乐」轨道 + 音乐面板（内置/导入） |

### 组 4 · 标记类元素 1 张 Pin 工具

工具条「标记」按钮的产出：一键在当前地图中心放置。三种标记形态（点 / 旗标 / 军标）**合并进同一张宽表**，用 `type` 判别列区分；公共字段（图层归属、时间轴、层级、可见性、标签、移动图标）每行都有。
属性面板：`PropertiesPanel.tsx` 标记设置区（9 种视觉形态 + 资源选择 + 标签）。

| 表 | type 取值 | 主键 | 工具入口 | 存什么 |
|---|---|---|---|---|
| `element_marker` | `point` | `element_id` | Pin 工具（一键放置） | 经纬度、**10 种形态**（圆点/文字/水滴针/气泡/表情 ＋ 图片/GIF/模型/图标库/军标）、缩放、朝向、贴地旋转、资源引用（asset_id / builtin_id / icon_lib+icon_name） |
| `element_marker` | `flag` | `element_id` | 标记面板切到 Marker（原地改类型） | 位置、旗面文案（flag_text）、配色、字号、宽度 |
| `element_marker` | `military_symbol` | `element_id` | **当前无入口**（导入 / 旧数据） | 军标 SIDC、位置、旋转、梯队、附加文字 |

### 组 5 · 路线类元素 1 张 Route 工具

「路线」按钮的产出：进入绘制模式采点成线。线型（直线/贝塞尔/大圆弧）与路线特效都在右侧 Settings 里切换，不新增表。移动点也并入本表。
属性面板：`PropertiesPanel.tsx` 路线设置区（均匀移动 / 逐点到达时间 / 动画起止 / 显示标记）。

| 表 | type 取值 | 主键 | 工具入口 | 存什么 |
|---|---|---|---|---|
| `element_route` | `line` | `element_id` | Route 工具；Shape 下菜单里的直线/曲线/带箭头/战线/行军箭头也写这张表 | 路径数组（coords_json）、线型、线宽虚线、路线特效、流动速度、无样式路线、战线梳齿 |
| `element_route` | `moving_point` | `element_id` | **当前无入口**（绘制模式已实现，工具条无按钮） | 路径点数组、拖尾颜色/宽度/长度 |

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

### 组 8 · 贴图类元素 1 张 Image 工具

工具条「图片」按钮：导入图片 / 从全局素材库插入，在地图上拖控制点做地理配准。图片本体存**全局素材库**（跨项目），本表只存配准参数（控制点网格 `grid_json`）。

| 表 | 主键 | 工具入口 | 职责 |
|---|---|---|---|
| `element_image` | `element_id` | Image（工具栏「图片」） | `grid_json` 控制点网格 `(rows+1)×(cols+1)`（`cols/rows=1` = 四角投影；更大 = 网格变形）；`asset_id` 为全局素材库弱引用（无外键）；`opacity` 不透明度 |

### 组 9 · 叠加层（弹窗） 1 张

| 表 | 职责 | 主键 | 关键点 | 前端对应 |
|---|---|---|---|---|
| `overlay` | 弹窗本体（10 类：文本/图片/图表/人物/对话…） | `overlay_id` | 图表/时间轴/对话等内容按 P3 留在 `payload_json` | 「弹窗」面板（`FxPanelBody.tsx`）+ 画面渲染 `fx/FxRender.tsx` OverlayContentView |

### 组 10 · 应用配置（接口模板 / 实例 / 音色 / 任务）4 张

「一家供应商怎么发请求」只有模板这一处真相（模板即数据，见 `docs/provider-engine.md`）：**模板行**一份装下同步 / 异步 / 桥接 / 克隆全部接法，**实例行**只留「选哪份模板 + 一组取值」，**音色**与**任务**是两本账本。协议列、代码里的 `switch`、以及「模板组」这一层表都一并删掉。

| 表 | 职责 | 主键 | 关键点 | 前端对应 |
|---|---|---|---|---|
| `provider_template` | **一行 = 一份完整模板**（这一家这个功能怎么发、返回从哪取、产物怎么变字节） | `tpl_id` | 六个接口槽各占一个 JSON 列（`sync` / `async` / `download` / `upload` / `clone` + 模板级 `headers`）；`outputs` 是**自由 map**（`{想要名字: 相对路径}`）不再是固定槽位；`category` **不写 CHECK**（TS 类型 + 保存前 `validateTemplate` 管）；`use_clone` / `upload` 两个开关决定界面上那两格显不显示 | ⚙ →「接口模板」（`TemplatesPane.tsx`，三栏） |
| `provider` | 实例：引用哪份模板 + 同步异步 + 一组取值（**一个模板可配几套账号**） | `provider_id` | **只有五个业务列**：`tpl_id`（真外键，被引用时删不掉）· `name` · `sync` · `values_json{instance,requests}` · 时间戳；`baseUrl` / 密钥 / 模型 / 尺寸全是模板声明的参数，**密钥 = `valueType:'secret'` 的普通参数**；没有 `active`，调用处选实例 | ⚙ →「文案 / 语音 / 图片」（`ProviderPanel.tsx`） |
| `voice` | 克隆音色账本：**同实例 + 同参考音频 + 同目标模型只建一次** | `voice_row_id` | 唯一键 `ux_voice_once(provider_id, source_hash, target_model)` —— voiceId 换模型即失效（实测 418）；`source_asset_id` 是 `RESTRICT`（原件被音色引用时删不掉，失效靠它重建）；`status` 就是抢占标志 | 字幕生成里的「克隆音色」区（`VoicePicker.tsx`） |
| `task` | 在途异步任务：唯一价值是**跨重启续跑** | `task_id` | `batch_id` 一次动作一批；`project_id` / `entry_id` 是**弱引用**（保存项目 = 删了重写，挂成真外键会让每次自动保存 CASCADE 掉在途任务；删项目由 `removeProjectV2` 显式清）；`provider_id` 真外键 `CASCADE`；`artifact_id` `SET NULL`（产物当场落 `asset`）；`next_query_at` 给调度器错峰 | 逐条配音状态 + 顶栏在途任务浮层 |

### 组 11 · 公共图层与公共元素（跨项目图库） 6 张

「把当前图层共享到公共库」/「从公共库导入图层」的落地表（`ElementsPanel.tsx` 的 ★ 按钮 + `PublicLayerDialog.tsx`）。**与项目侧同构**，差别只有两处：外键换成 `public_layer_id`，且 `asset_id` **降级为弱引用**（公共库不属于任何项目，无法对项目的 `asset` 行建外键）。

| 表 | 内容 | 主键 | 关键点 | 前端对应 |
|---|---|---|---|---|
| `public_layer` | 公共图层本体（类型 / 名称 / 显隐 / 显示区间 / 排序 + 审计时间） | `public_layer_id` | 无 `project_id`：库是全局的，导入时才生成项目侧 `layer` 行；`type` 与项目图层同一 CHECK | 「公共图层库」弹窗（`PublicLayerDialog.tsx`） |
| `public_element_marker` | 标记类副本 | `element_id` | 与 `element_marker` 同构 | 同上 |
| `public_element_route` | 路线类副本 | `element_id` | 与 `element_route` 同构 | 同上 |
| `public_element_shape` | 形状类副本 | `element_id` | 与 `element_shape` 同构 | 同上 |
| `public_element_territory` | 疆域类副本 | `element_id` | 与 `element_territory` 同构（三个 JSON 列整体复制） | 同上 |
| `public_element_image` | 贴图类副本 | `element_id` | 与 `element_image` 同构；`asset_id` 弱引用，解析不到时由启动体检清空 | 同上 |

**副本必须自洽**（不变量）：`asset_id` 是弱引用，素材被删后副本可能指向不存在的行 —— 由启动体检 `repairAssetRefs` 把这类引用清空（不造假素材行；项目侧 `element_*.asset_id` 是外键，带着悬空引用插入会被整笔事务打回）；副本元素 id 一律加后缀（保存 `:pb<pubId>`、导入 `:im<layerId>`），因为 `element_id` 是全库主键，不换 id 会让「同一图层导入两次」互相撞车（`deleteElement` 按 id 过滤会一次删两条）。数据库侧留 `v_check_dangling` 做体检 —— 兜底，不拦截写入。


## 四、每张表的字段（字段字典）

<!-- FIELD-DICT:BEGIN -->
> 本节由 DDL 自动生成（`tools/gen-db-field-dict.mjs`），共 **27 张表 / 703 个列，每列都有中文说明**。字段说明取自 `tools/db-field-notes.mjs`（人工词表，703 条），结构与约束取自 DDL；脚本会与 SQLite 实测结构交叉校验，并强制「每个字段必须有说明」，缺一条就报错。

> 元素相关的 **5 张类别宽表按工具条分类**（标记 / 路线 / 形状 / 疆域 / 图片），每张表用 `type` 判别列承载该工具下的全部元素类型。工具条的完整对照见本文第五节。

> 读法：**列**为字段名；**约束**中 `PK` 主键、`NOT NULL` 必填、`FK` 外键（其后为删除行为：CASCADE 级联删除 / SET NULL 置空 / RESTRICT 拒绝删除）。

#### 快速跳转

- **组 1 · 合集 / 项目 / 图层（含配置）**：`collection` · `project` · `layer`
- **组 2 · 底图 / 高程图 / 素材**：`base_map` · `elevation_map` · `asset`
- **组 3 · 时间轴**：`camera_keyframe` · `screen_fx` · `narration` · `narration_entry` · `music_track`
- **组 4 · 标记类元素（Pin 工具）**：`element_marker`
- **组 5 · 路线类元素（Route 工具）**：`element_route`
- **组 6 · 形状类元素（Shape 工具）**：`element_shape`
- **组 7 · 疆域类元素（Terr 工具）**：`element_territory`
- **组 8 · 贴图类元素（Image 工具）**：`element_image`
- **组 9 · 叠加层（弹窗）**：`overlay`
- **组 10 · 应用配置（接口模板 / 实例 / 音色 / 任务）**：`provider_template` · `provider` · `voice` · `task`
- **组 11 · 公共图层与公共元素（跨项目图库）**：`public_layer` · `public_element_marker` · `public_element_route` · `public_element_shape` · `public_element_territory` · `public_element_image`

### 组 1 · 合集 / 项目 / 图层（含配置）

#### collection — 合集：项目之上的一层分组（合集 ▸ 项目 ▸ 元素）；默认合集恒为 default，不可改名/删除

**职责**：合集：项目之上的一层分组（合集 ▸ 项目 ▸ 章节 ▸ 元素）　**前端**：项目列表页左栏合集列表（ProjectManager.tsx）

5 列 · 主键 `collection_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `collection_id` | TEXT | `PK` | 合集 id（默认合集恒为 default，不可删除） |
| `name` | TEXT | `NOT NULL` | 合集名（默认合集名为「默认合集」，不可改名） |
| `ord` | INTEGER | `NOT NULL` | 合集排序（默认合集固定 -1，恒排最前） · 默认 `0` |
| `created_at` | INTEGER | `NOT NULL` | 创建时间（毫秒时间戳） |
| `updated_at` | INTEGER | `NOT NULL` | 最后修改时间（毫秒时间戳） |

#### project — 项目本体：身份 / 归属 / 审计 / 投影 / 生效底图与高程指针 / GlobalConfig 配置列

**职责**：项目本体：身份 / 归属 / 审计 / 投影 / 生效底图与高程指针　**前端**：项目列表页项目卡片（ProjectManager.tsx）；运行时即 projectStore.project

14 列 · 主键 `project_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `project_id` | TEXT | `PK` | 项目 id |
| `name` | TEXT | `NOT NULL` | 项目名 |
| `description` | TEXT | — | 项目描述 |
| `collection_id` | TEXT | `NOT NULL` `FK → collection RESTRICT` | 所属合集（默认 default）；删合集时其下项目回落到默认合集 · 默认 `'default'` |
| `created_at` | INTEGER | `NOT NULL` | 创建时间（毫秒时间戳） |
| `updated_at` | INTEGER | `NOT NULL` | 最后保存时间（毫秒时间戳） |
| `projection` | TEXT | `NOT NULL` | 地图投影：mercator 平面 / globe 3D 球体（渲染方式，随项目走） · 默认 `'mercator'` · `CHECK (projection IN ('mercator','globe'))` |
| `active_base_map_id` | TEXT | — | 当前生效底图 id（弱引用 base_map.base_map_id，只引用本项目内的行） |
| `active_elevation_map_id` | TEXT | — | 当前生效高程图 id（弱引用 elevation_map.elevation_map_id；NULL = 无高程） |
| `default_duration_sec` | REAL | `NOT NULL` | 默认时长（秒，仅作新建项目的初始容器长度） · 默认 `5` · `CHECK (default_duration_sec > 0)` |
| `default_fps` | INTEGER | `NOT NULL` | 默认帧率（1–240） · 默认 `30` · `CHECK (default_fps BETWEEN 1 AND 240)` |
| `resolution_w` | INTEGER | `NOT NULL` | 默认导出宽度（px） · 默认 `1920` · `CHECK (resolution_w > 0)` |
| `resolution_h` | INTEGER | `NOT NULL` | 默认导出高度（px） · 默认 `1080` · `CHECK (resolution_h > 0)` |
| `default_easing` | TEXT | `NOT NULL` | 默认缓动类型 · 默认 `'easeInOut'` |

#### layer — 图层：元素的分组（项目 ▸ 图层 ▸ 元素），单类型图层（标记/路线/形状/疆域/图片），带自己的显隐与显示区间

**职责**：图层：元素的分组（项目 ▸ 图层 ▸ 元素），单类型图层，带显隐与显示区间　**前端**：左侧「图层」浮层（ElementsPanel.tsx）+ 时间线图层轨道

8 列 · 主键 `layer_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `layer_id` | TEXT | `PK` | 图层 id |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目（删项目连带删图层） |
| `type` | TEXT | `NOT NULL` | 图层类型（单类型图层）：marker 标记 / route 路线 / shape 形状 / territory 疆域 / image 图片 · `CHECK (type IN ('marker','route','shape','territory','image'))` |
| `name` | TEXT | `NOT NULL` | 图层名 · 默认 `''` |
| `visible` | INTEGER | `NOT NULL` | 是否显示（0/1） · 默认 `1` · `CHECK (visible IN (0,1))` |
| `start_sec` | REAL | `NOT NULL` | 图层显示起点（秒，项目绝对时间） · `CHECK (start_sec >= 0)` |
| `end_sec` | REAL | `NOT NULL` | 图层显示终点（秒，项目绝对时间） |
| `ord` | INTEGER | `NOT NULL` | 同项目内排序 · 默认 `0` |

**表级约束**

- `CHECK (end_sec >= start_sec)`（同项目内排序）

### 组 2 · 底图 / 高程图 / 素材

#### base_map — 底图目录：项目自带一份（内置项在创建项目时复制进来），存底图名与样式（URL 或内联对象）

**职责**：底图目录：项目自带一份（内置项创建项目时复制进来），可增删改　**前端**：地图左下角「底图」芯片面板（MapStyleChip.tsx）+ projectStore.addBaseMap / removeBaseMap

6 列 · 主键 —

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `base_map_id` | TEXT | `NOT NULL` | 底图 id（同项目内唯一：内置项如 osm / satellite 在各项目里同名） |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `name` | TEXT | `NOT NULL` | 显示名（底图面板里的名字） · 默认 `''` |
| `style_url` | TEXT | — | 底图样式 URL（与 style_json 二选一；可为相对路径如 geo/x.json） |
| `style_json` | TEXT | — | 内联 MapLibre 样式对象（卫星底图走这条；与 style_url 二选一） · `CHECK (style_json IS NULL OR json_valid(style_json))` |
| `ord` | INTEGER | `NOT NULL` | 同项目内排序（面板顺序） · 默认 `0` |

**表级约束**

- `CHECK (style_url IS NOT NULL OR style_json IS NOT NULL)`（同项目内排序（面板顺序））
- `PRIMARY KEY (project_id, base_map_id)`

#### elevation_map — 高程图目录：项目自带一份，地形夸张系数直接落在本行

**职责**：高程图目录：项目自带一份，地形夸张系数直接落在本行　**前端**：底图芯片面板的「高程」区（MapStyleChip.tsx 选择 + 夸张系数滑动条）

8 列 · 主键 —

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `elevation_map_id` | TEXT | `NOT NULL` | 高程图 id（同项目内唯一：内置项如 none / aws-terrain 在各项目里同名） |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `name` | TEXT | `NOT NULL` | 显示名（高程面板里的名字） · 默认 `''` |
| `url` | TEXT | `NOT NULL` | 高程栅格瓦片 URL；空串 = 「无高程（平面）」占位项 · 默认 `''` |
| `encoding` | TEXT | — | 高程编码：mapbox / terrarium（缺省按 terrarium） · `CHECK (encoding IS NULL OR encoding IN ('mapbox','terrarium'))` |
| `exaggeration` | REAL | — | 地形夸张系数（0=平坦、1=真实比例；空=用渲染端默认 1.5） · `CHECK (exaggeration IS NULL OR exaggeration BETWEEN 0 AND 50)` |
| `style_url` | TEXT | — | 可选：选用该高程时一并换用的底图样式 URL |
| `ord` | INTEGER | `NOT NULL` | 同项目内排序（面板顺序） · 默认 `0` |

**表级约束**

- `PRIMARY KEY (project_id, elevation_map_id)`（同项目内排序（面板顺序））

#### asset — 素材仓库：图片 / GIF / 模型 / 音频 / 视频 / 图标 / 字体统一存此表，业务表只留 asset_id

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

- `CHECK ((storage = 'file' AND rel_path IS NOT NULL) OR (storage = 'blob' AND blob IS NOT NULL))`（入库时间（毫秒时间戳））

### 组 3 · 时间轴

#### camera_keyframe — 视角关键帧：停留 → 飞行 → 落位；含 follow 跟随 / orbit 环绕视角

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
| `ord` | INTEGER | `NOT NULL` | 同项目内排序 · 默认 `0` |

#### screen_fx — 屏幕空间特效窗口：天气 / 画面叠加（非地图元素），两分支字段并存

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
| `ord` | INTEGER | `NOT NULL` | 同项目内排序 · 默认 `0` |

**表级约束**

- `CHECK (end_sec >= start_sec)`（同项目内排序）
- `CHECK ((kind = 'weather' AND weather_type IS NOT NULL) OR (kind = 'screen' AND effect_type IS NOT NULL))`

#### narration — 字幕 / 配音档：样式部分，与项目 1:1

**职责**：字幕 / 配音档（样式部分，1:1）　**前端**：顶栏「字幕生成」弹窗的字幕样式区（GenerateDialog.tsx）

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

#### narration_entry — 字幕条：文本 + 配音音频 + 显示时长

**职责**：字幕条：文本 + 配音音频 + 显示时长　**前端**：顶栏「字幕生成」弹窗逐条编辑 / TTS / 导入 SRT（GenerateDialog.tsx）+ 时间轴「🎙 配音」轨道（TimelineEditor.tsx）

9 列 · 主键 `entry_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `entry_id` | TEXT | `PK` | 字幕条 id |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `text` | TEXT | `NOT NULL` | 字幕文本（同时也是配音朗读文本） · 默认 `''` |
| `audio_asset_id` | TEXT | `FK → asset SET NULL` | 配音音频（TTS 生成或导入） |
| `url` | TEXT | — | 音频地址（asset 不可用时的内联 dataURL / 站内路径） |
| `duration_sec` | REAL | — | 显示时长（秒）：空=自动（有配音随音频、无配音按字数估算）；非空=手动覆盖 · `CHECK (duration_sec IS NULL OR duration_sec > 0)` |
| `start_sec` | REAL | `NOT NULL` | 起始时间（秒，项目绝对时间；默认自动顺排） · `CHECK (start_sec >= 0)` |
| `locked` | INTEGER | `NOT NULL` | 手动定位后锁定，不再参与自动顺排 · 默认 `0` · `CHECK (locked IN (0,1))` |
| `ord` | INTEGER | `NOT NULL` | 同项目内排序 · 默认 `0` |

#### music_track — 项目级背景音乐：单轨多段（项目绝对时间、段内循环、淡入淡出）

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

- `CHECK (end_sec IS NULL OR end_sec >= start_sec)`（同项目内排序）

### 组 4 · 标记类元素（Pin 工具）

#### element_marker — 标记类元素（Pin 工具）：point / flag / military_symbol 一张宽表，type 判别

**职责**：标记类元素：Pin 工具产出，3 种 type 合并一张宽表　**前端**：工具条「标记」按钮 + 标记属性面板（PropertiesPanel，10 种视觉形态）

58 列 · 主键 `element_id` · 工具入口：Pin 工具（一键放置到地图中心）；标记面板切到 Marker（旗标）、导入/旧数据的军标也写这张表

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `element_id` | TEXT | `PK` | 元素 id（全库唯一，5 张类别表共享同一 id 空间） |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `layer_id` | TEXT | `FK → layer CASCADE` | 所属图层（删图层连带删元素；元素可换图层） |
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
| `ord` | INTEGER | `NOT NULL` | 同图层内排序 · 默认 `0` |
| `lng` | REAL | `NOT NULL` | 经度（三类标记都落在单点） |
| `lat` | REAL | `NOT NULL` | 纬度 |
| `rotation` | REAL | — | 贴地旋转角（0–360 度） |
| `shape` | TEXT | — | 点呈现形态（10 种）：circle 圆点 / text 纯文字 / pin 水滴针 / bubble 气泡 / emoji 表情 / image 图片 / gif 动图 / model 3D 模型 / icon 图标库 / military_symbol 军标 · `CHECK (shape IS NULL OR shape IN ( 'circle','text','pin','bubble','emoji','image','gif','model','icon','military_symbol'))` |
| `emoji` | TEXT | — | 表情字符（type=point 且 shape=emoji 时必填） |
| `scale` | REAL | — | 等比缩放（0.3–3，同时影响点与标签字号） · `CHECK (scale IS NULL OR (scale >= 0.3 AND scale <= 3))` |
| `orientation` | TEXT | — | 朝向：faceCam 面向镜头 / flat 贴地（shape=model 不能贴地，CHECK 保证） · `CHECK (orientation IS NULL OR orientation IN ('faceCam','flat'))` |
| `color` | TEXT | — | 主色（着色）：除 emoji 外全部形态可用（multiply 染色，白色=原色） |
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

- `CHECK (end_sec >= start_sec)`（军标旁附加文字）
- `CHECK (move_end_sec IS NULL OR move_start_sec IS NULL OR move_end_sec > move_start_sec)`
- `CHECK (type <> 'point' OR shape IS NOT 'emoji' OR emoji IS NOT NULL)`
- `CHECK (type <> 'point' OR shape IS NULL OR shape IN ('circle','text','pin','bubble','emoji') OR asset_id IS NOT NULL OR builtin_id IS NOT NULL)`（媒体形态（image/gif/model/icon）必须指明来源：用户上传 asset 或内置 builtin）
- `CHECK (type <> 'point' OR shape IS NOT 'icon' OR icon_name IS NOT NULL)`
- `CHECK (shape IS NOT 'model' OR orientation IS NULL OR orientation = 'faceCam')`（能力矩阵（与属性面板「隐藏不可用控件」一一对应））
- `CHECK (type <> 'flag' OR flag_text IS NOT NULL)`（模型不能贴地）
- `CHECK (type <> 'military_symbol' OR sidc IS NOT NULL)`

### 组 5 · 路线类元素（Route 工具）

#### element_route — 路线类元素（Route 工具）：line / moving_point 一张宽表，type 判别

**职责**：路线类元素：line / moving_point　**前端**：工具条「路线」按钮 + 路线属性面板（含均匀移动与逐点到达时间）

70 列 · 主键 `element_id` · 工具入口：Route 工具；Shape 子菜单的直线/曲线/带箭头/战线/行军箭头也写这张表

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `element_id` | TEXT | `PK` | 元素 id（全库唯一，5 张类别表共享同一 id 空间） |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `layer_id` | TEXT | `FK → layer CASCADE` | 所属图层（删图层连带删元素；元素可换图层） |
| `type` | TEXT | `NOT NULL` | 子类型判别列：line 线 / moving_point 移动点（Route 工具） · `CHECK (type IN ('line','moving_point'))` |
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
| `ord` | INTEGER | `NOT NULL` | 同图层内排序 · 默认 `0` |
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

**表级约束**

- `CHECK (end_sec >= start_sec)`（拖尾长度（帧））
- `CHECK (move_end_sec IS NULL OR move_start_sec IS NULL OR move_end_sec > move_start_sec)`
- `CHECK (type <> 'line' OR coords_json IS NOT NULL)`
- `CHECK (type <> 'moving_point' OR coords_json IS NOT NULL)`

### 组 6 · 形状类元素（Shape 工具）

#### element_shape — 形状类元素（Shape 工具）：polygon / arrow / double_arrow / gathering / encirclement；Region 行政区也写此表

**职责**：形状类元素：polygon / arrow / double_arrow / gathering / encirclement（Region 行政区也写此表）　**前端**：工具条「形状」下拉 + 形状属性面板

81 列 · 主键 `element_id` · 工具入口：Shape：多边形/曲线多边/防御圈/圆/矩形/五角星/钳形/集结地/包围圈；Region 工具的行政区高亮也写这张表

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `element_id` | TEXT | `PK` | 元素 id（全库唯一，5 张类别表共享同一 id 空间） |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `layer_id` | TEXT | `FK → layer CASCADE` | 所属图层（删图层连带删元素；元素可换图层） |
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
| `ord` | INTEGER | `NOT NULL` | 同图层内排序 · 默认 `0` |
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

- `CHECK (end_sec >= start_sec)`（绕中心旋转角（度））
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

#### element_territory — 疆域类元素（Terr 工具）：势力 / 地块 / 兼并事件 JSON 内联，自包含

**职责**：疆域元素：势力 / 地块 / 兼并事件 JSON 内联，自包含　**前端**：工具条「疆域」下拉（TerritoryImportDialog.tsx 导入 + 疆域属性面板）

32 列 · 主键 `element_id` · 工具入口：Terr：新建疆域 / 绘制地块 / 兼并（势力、地块、事件 JSON 内联在本表）

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `element_id` | TEXT | `PK` | 元素 id（全库唯一，5 张类别表共享同一 id 空间） |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `layer_id` | TEXT | `FK → layer CASCADE` | 所属图层（删图层连带删元素；元素可换图层） |
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
| `ord` | INTEGER | `NOT NULL` | 同图层内排序 · 默认 `0` |
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

- `CHECK (end_sec >= start_sec)`（兼并事件数组：[{eventId,sec,toCountryId,preset,duration_sec,highlight,plotIds[],ord}]；时间与时长均为秒；toCountryId 同上）

### 组 8 · 贴图类元素（Image 工具）

#### element_image — 贴图类元素（Image 工具）：地理配准图片的控制点网格；图片本体走全局素材库，本表只存配准参数

**职责**：贴图元素：地理配准图片（控制点网格），图片存全局素材库、本表只存配准参数　**前端**：工具条「图片」（导入/素材库插入）+ 贴图属性面板（PropertiesPanel GeoImageSettings）

15 列 · 主键 `element_id` · 工具入口：Image 工具（工具栏「图片」）：导入图片做地理配准贴图（四角/网格变形），图片本体走全局素材库

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `element_id` | TEXT | `PK` | 元素 id（全库唯一，类别表共享同一 id 空间） |
| `project_id` | TEXT | `NOT NULL` `FK → project CASCADE` | 所属项目 |
| `layer_id` | TEXT | `FK → layer CASCADE` | 所属图层（删图层连带删元素；元素可换图层） |
| `type` | TEXT | `NOT NULL` | 子类型判别列（固定 geo_image） · 默认 `'geo_image'` · `CHECK (type = 'geo_image')` |
| `name` | TEXT | `NOT NULL` | 元素名（与属性面板首字段 LABEL 同步） · 默认 `''` |
| `visible` | INTEGER | `NOT NULL` | 是否显示（0/1） · 默认 `1` · `CHECK (visible IN (0,1))` |
| `start_sec` | REAL | `NOT NULL` | 出现时间（秒） · `CHECK (start_sec >= 0)` |
| `end_sec` | REAL | `NOT NULL` | 消失时间（秒） |
| `asset_id` | TEXT | — | 图片素材 id（全局素材库，弱引用、无外键） |
| `aspect` | REAL | — | 图片宽高比（宽/高），切片渲染用 · `CHECK (aspect IS NULL OR aspect > 0)` |
| `cols` | INTEGER | `NOT NULL` | 配准网格列数（1=四角投影，≥2=网格变形） · 默认 `1` · `CHECK (cols >= 1)` |
| `rows` | INTEGER | `NOT NULL` | 配准网格行数 · 默认 `1` · `CHECK (rows >= 1)` |
| `grid_json` | TEXT | — | 控制点数组（行优先 (rows+1)×(cols+1) 个 [lng,lat]） · `CHECK (grid_json IS NULL OR json_valid(grid_json))` |
| `opacity` | REAL | — | 不透明度（0–1） · `CHECK (opacity IS NULL OR opacity BETWEEN 0 AND 1)` |
| `ord` | INTEGER | `NOT NULL` | 同图层内排序 · 默认 `0` |

**表级约束**

- `CHECK (end_sec >= start_sec)`（同图层内排序）

### 组 9 · 叠加层（弹窗）

#### overlay — 叠加层（弹窗）：本体一张，custom / person 内容块内联在 payload_json

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
| `ord` | INTEGER | `NOT NULL` | 同项目内排序 · 默认 `0` |

**表级约束**

- `CHECK (end_sec >= start_sec)`（同项目内排序）

### 组 10 · 应用配置（接口模板 / 实例 / 音色 / 任务）

#### provider_template — 接口模板：一行 = 一个完整模板（同步 / 异步 / 桥接 / 上传 / 克隆都在这一行的 JSON 列里）

**职责**：接口模板：一行一份完整模板（同步 / 异步 / 桥接 / 上传 / 克隆都在这行的 JSON 列里）　**前端**：⚙ 设置 · AI → 左侧「接口模板」（TemplatesPane.tsx，三栏 + 每接口卡片）

16 列 · 主键 `tpl_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `tpl_id` | TEXT | `PK` | 模板 id（一行 = 一份完整模板）：deepseek-chat / qwen-image / qwen-tts / custom-1 … |
| `name` | TEXT | `NOT NULL` | 模板名（用户自填的单个字符串，不做中英两份） · 默认 `''` |
| `category` | TEXT | `NOT NULL` | 分类：llm 文案 / tts 语音 / image 图片（取值由 TS 联合类型管，不加 CHECK） |
| `use_clone` | INTEGER | `NOT NULL` | 有没有克隆音色接口（只有 tts 用得上） · 默认 `0` · `CHECK (use_clone IN (0,1))` |
| `upload` | INTEGER | `NOT NULL` | 克隆前要不要先上传拿 fileId（use_clone=1 才有意义；0 = 直接塞 base64） · 默认 `0` · `CHECK (upload IN (0,1))` |
| `headers_json` | TEXT | — | 模板级请求头 JSON（这一行的所有请求共用一份） · `CHECK (headers_json IS NULL OR json_valid(headers_json))` |
| `instance_params_json` | TEXT | — | 实例级参数声明 JSON（超时 / 并发 / 查询节奏 / 失效信号…取值回落到 provider.values_json） · `CHECK (instance_params_json IS NULL OR json_valid(instance_params_json))` |
| `sync_json` | TEXT | — | 同步接法 { submit }（一条请求直接拿产物） · `CHECK (sync_json IS NULL OR json_valid(sync_json))` |
| `async_json` | TEXT | — | 异步接法 { submit, query }（query 里配 successValues / failureValues 两个枚举） · `CHECK (async_json IS NULL OR json_valid(async_json))` |
| `download_json` | TEXT | — | 桥接请求：fileId → 最终下载地址（同步异步共用；不配 = 上一步直接给产物） · `CHECK (download_json IS NULL OR json_valid(download_json))` |
| `upload_json` | TEXT | — | 桥接请求：本地文件 → fileId（仅克隆用） · `CHECK (upload_json IS NULL OR json_valid(upload_json))` |
| `clone_json` | TEXT | — | 克隆音色请求：参考音频 → voiceId · `CHECK (clone_json IS NULL OR json_valid(clone_json))` |
| `ref_sample_rate` | INTEGER | — | 克隆参考音频要求采样率 Hz（CosyVoice 16k / Qwen-TTS 24k，写死过一次就出事） |
| `ord` | INTEGER | `NOT NULL` | 列表排序（同分类内） · 默认 `0` |
| `created_at` | INTEGER | — | 创建时间（epoch ms，审计用） |
| `updated_at` | INTEGER | — | 最后修改时间（epoch ms，审计用） |

#### provider — 实例：一个模板可以配几套账号，调用处选实例（取值全在 values_json，密钥不占具名列）

**职责**：实例：用哪份模板 + 全部取值（密钥是声明成 secret 的普通参数，不占具名列）　**前端**：⚙ 设置 · AI → 左侧文案 / 语音 / 图片（ProviderPanel.tsx，实例芯片 + 表单）

7 列 · 主键 `provider_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `provider_id` | TEXT | `PK` | 实例 id：prov_tts_minimax … |
| `tpl_id` | TEXT | `NOT NULL` `FK → provider_template` | 用哪一份模板（真外键） |
| `name` | TEXT | `NOT NULL` | 实例名（界面与任务列表用它认，如「MiniMax-TTS-生产」） · 默认 `''` |
| `sync` | INTEGER | `NOT NULL` | 走同步还是异步：决定用模板里 sync_json 还是 async_json 那套 · 默认 `1` · `CHECK (sync IN (0,1))` |
| `values_json` | TEXT | — | 全部取值 JSON：{ instance: { baseUrl, apiKey, timeoutMs… }, requests: { "async.submit": { model, size… } } }（密钥是声明成 secret 的普通参数，不占具名列） · `CHECK (values_json IS NULL OR json_valid(values_json))` |
| `created_at` | INTEGER | — | 创建时间（epoch ms，审计用） |
| `updated_at` | INTEGER | — | 最后修改时间（epoch ms，审计用） |

#### voice — 克隆音色账本：同一份参考音频在同一实例 + 同一目标模型下只建一次

**职责**：克隆音色账本：同实例 + 同参考音频 + 同目标模型只建一次（幂等键）　**前端**：字幕生成弹窗内的「克隆音色」区（VoicePicker.tsx）+ 音色管理

15 列 · 主键 `voice_row_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `voice_row_id` | TEXT | `PK` | 行 id（不是厂商的 voiceId，那个在 voice_id 列） |
| `provider_id` | TEXT | `NOT NULL` `FK → provider CASCADE` | 属于哪个实例（音色池按实例隔离） |
| `source_hash` | TEXT | `NOT NULL` | 参考音频内容哈希（幂等键的一维） |
| `target_model` | TEXT | `NOT NULL` | 绑定的模型（实测：voiceId 换模型即失效，所以它必须进唯一键） |
| `source_asset_id` | TEXT | `NOT NULL` `FK → asset RESTRICT` | 参考音频原件（失效时靠它重建；删素材会被拦） |
| `label` | TEXT | `NOT NULL` | 界面显示名（如「男声·内置」「客服音色」） · 默认 `''` |
| `file_id` | TEXT | — | 上传桥接返回的 fileId（一体式厂商留空） |
| `file_id_expires_at` | INTEGER | — | fileId 过期时间（epoch ms；空 = 不知过期） |
| `voice_id` | TEXT | — | 克隆返回的厂商音色 ID |
| `voice_id_expires_at` | INTEGER | — | voiceId 过期时间（epoch ms；空 = 不知过期） |
| `status` | TEXT | `NOT NULL` | 状态机：cloning / ready / failed / expired（抢占靠它，只建一次） · 默认 `'cloning'` |
| `error` | TEXT | — | 失败原因（原样带上游 code/message） |
| `attempts` | INTEGER | `NOT NULL` | 尝试次数（重建上限判据） · 默认 `0` |
| `created_at` | INTEGER | — | 创建时间（epoch ms，审计用） |
| `updated_at` | INTEGER | — | 最后修改时间（epoch ms，审计用） |

#### task — 异步任务：唯一价值是跨重启续跑（关窗口、刷新页面都不丢在途任务）

**职责**：异步任务：跨重启续跑（提交 / 查询 / 当场落素材 / 回填字幕）　**前端**：字幕生成的逐条状态 + 顶栏在途任务浮层；调度在主进程扫库

17 列 · 主键 `task_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `task_id` | TEXT | `PK` | 本地任务 id（与厂商的 provider_task_id 无关） |
| `batch_id` | TEXT | `NOT NULL` | 批次 id（一次「全部生成配音」= 一个 batchId + N 条 task） |
| `provider_id` | TEXT | `NOT NULL` `FK → provider CASCADE` | 用哪个实例发的 |
| `project_id` | TEXT | — | 回填到哪个项目（弱引用：删项目由 removeProjectV2 显式清） |
| `entry_id` | TEXT | — | 回填到哪条字幕（弱引用：字幕行没了就是「没地方放」，调度器当场跳过） |
| `category` | TEXT | `NOT NULL` | 任务种类：tts / image（llm 不进表，同步一把梭） |
| `status` | TEXT | `NOT NULL` | 本地状态：submitting / querying / success / failed / canceled（厂商状态值不入库） · 默认 `'submitting'` |
| `input_json` | TEXT | — | 提交参数快照（重试 = 取原值重新调生成接口） · `CHECK (input_json IS NULL OR json_valid(input_json))` |
| `provider_task_id` | TEXT | — | 厂商任务 id（只在一次调用内有意义，几十分钟后过期） |
| `artifact_id` | TEXT | `FK → asset SET NULL` | 最终产物（时效链接当场下载后落 asset） |
| `error` | TEXT | — | 失败原因（原样带上游 code/message） |
| `query_count` | INTEGER | `NOT NULL` | 已查询次数（超 maxAttempts 判失败） · 默认 `0` |
| `rebuild_count` | INTEGER | `NOT NULL` | 音色重建次数（上限 1，避免死循环） · 默认 `0` |
| `next_query_at` | INTEGER | — | 下次查询时间（epoch ms；调度器靠它错峰，不做每任务独立循环） |
| `created_at` | INTEGER | — | 创建时间（epoch ms，审计用） |
| `updated_at` | INTEGER | — | 最后修改时间（epoch ms，审计用） |
| `finished_at` | INTEGER | — | 结束时间（epoch ms，成功或失败的时刻） |

### 组 11 · 公共图层与公共元素（跨项目图库）

#### public_layer — 公共图层：跨项目图库（把项目图层连元素整体复制过来，导入到任意项目）

**职责**：公共图层：跨项目图库的图层（把项目图层连元素整体复制过来）　**前端**：左侧「图层」浮层「加入公共图层 / 导入公共图层」

9 列 · 主键 `public_layer_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `public_layer_id` | TEXT | `PK` | 公共图层 id |
| `type` | TEXT | `NOT NULL` | 图层类型（单类型）：marker 标记 / route 路线 / shape 形状 / territory 疆域 / image 图片 · `CHECK (type IN ('marker','route','shape','territory','image'))` |
| `name` | TEXT | `NOT NULL` | 图层名 · 默认 `''` |
| `visible` | INTEGER | `NOT NULL` | 是否显示（0/1） · 默认 `1` · `CHECK (visible IN (0,1))` |
| `start_sec` | REAL | `NOT NULL` | 显示起点（秒，沿用源图层区间、导入时不自动归零） · `CHECK (start_sec >= 0)` |
| `end_sec` | REAL | `NOT NULL` | 显示终点（秒） |
| `ord` | INTEGER | `NOT NULL` | 排序 · 默认 `0` |
| `created_at` | INTEGER | `NOT NULL` | 创建时间（毫秒时间戳） |
| `updated_at` | INTEGER | `NOT NULL` | 更新时间（毫秒时间戳） |

**表级约束**

- `CHECK (end_sec >= start_sec)`（更新时间（毫秒时间戳））

#### public_element_marker — 公共标记元素：public_layer 内的标记副本（与 element_marker 同构）

**职责**：公共标记元素（public_layer 内副本，与 element_marker 同构）　**前端**：同上

57 列 · 主键 `element_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `element_id` | TEXT | `PK` | 元素 id（全库唯一，5 张类别表共享同一 id 空间） |
| `public_layer_id` | TEXT | `NOT NULL` `FK → public_layer CASCADE` | 所属公共图层（删公共图层连带删元素） |
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
| `ord` | INTEGER | `NOT NULL` | 同图层内排序 · 默认 `0` |
| `lng` | REAL | `NOT NULL` | 经度（三类标记都落在单点） |
| `lat` | REAL | `NOT NULL` | 纬度 |
| `rotation` | REAL | — | 贴地旋转角（0–360 度） |
| `shape` | TEXT | — | 点呈现形态（10 种）：circle 圆点 / text 纯文字 / pin 水滴针 / bubble 气泡 / emoji 表情 / image 图片 / gif 动图 / model 3D 模型 / icon 图标库 / military_symbol 军标 · `CHECK (shape IS NULL OR shape IN ( 'circle','text','pin','bubble','emoji','image','gif','model','icon','military_symbol'))` |
| `emoji` | TEXT | — | 表情字符（type=point 且 shape=emoji 时必填） |
| `scale` | REAL | — | 等比缩放（0.3–3，同时影响点与标签字号） · `CHECK (scale IS NULL OR (scale >= 0.3 AND scale <= 3))` |
| `orientation` | TEXT | — | 朝向：faceCam 面向镜头 / flat 贴地（shape=model 不能贴地，CHECK 保证） · `CHECK (orientation IS NULL OR orientation IN ('faceCam','flat'))` |
| `color` | TEXT | — | 主色（着色）：除 emoji 外全部形态可用（multiply 染色，白色=原色） |
| `asset_id` | TEXT | — | 用户上传的图片 / GIF / 模型素材（删除素材则置空） |
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

- `CHECK (end_sec >= start_sec)`（军标旁附加文字）
- `CHECK (move_end_sec IS NULL OR move_start_sec IS NULL OR move_end_sec > move_start_sec)`
- `CHECK (type <> 'point' OR shape IS NOT 'emoji' OR emoji IS NOT NULL)`
- `CHECK (type <> 'point' OR shape IS NULL OR shape IN ('circle','text','pin','bubble','emoji') OR asset_id IS NOT NULL OR builtin_id IS NOT NULL)`（媒体形态（image/gif/model/icon）必须指明来源：用户上传 asset 或内置 builtin）
- `CHECK (type <> 'point' OR shape IS NOT 'icon' OR icon_name IS NOT NULL)`
- `CHECK (shape IS NOT 'model' OR orientation IS NULL OR orientation = 'faceCam')`（能力矩阵（与属性面板「隐藏不可用控件」一一对应））
- `CHECK (type <> 'flag' OR flag_text IS NOT NULL)`（模型不能贴地）
- `CHECK (type <> 'military_symbol' OR sidc IS NOT NULL)`

#### public_element_route — 公共路线元素：public_layer 内的路线副本（与 element_route 同构）

**职责**：公共路线元素（public_layer 内副本，与 element_route 同构）　**前端**：同上

69 列 · 主键 `element_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `element_id` | TEXT | `PK` | 元素 id（全库唯一，5 张类别表共享同一 id 空间） |
| `public_layer_id` | TEXT | `NOT NULL` `FK → public_layer CASCADE` | 所属公共图层（删公共图层连带删元素） |
| `type` | TEXT | `NOT NULL` | 子类型判别列：line 线 / moving_point 移动点（Route 工具） · `CHECK (type IN ('line','moving_point'))` |
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
| `move_icon_asset_id` | TEXT | — | 移动图标上传素材 id（删素材置空） |
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
| `ord` | INTEGER | `NOT NULL` | 同图层内排序 · 默认 `0` |
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

**表级约束**

- `CHECK (end_sec >= start_sec)`（拖尾长度（帧））
- `CHECK (move_end_sec IS NULL OR move_start_sec IS NULL OR move_end_sec > move_start_sec)`
- `CHECK (type <> 'line' OR coords_json IS NOT NULL)`
- `CHECK (type <> 'moving_point' OR coords_json IS NOT NULL)`

#### public_element_shape — 公共形状元素：public_layer 内的形状副本（与 element_shape 同构）

**职责**：公共形状元素（public_layer 内副本，与 element_shape 同构）　**前端**：同上

80 列 · 主键 `element_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `element_id` | TEXT | `PK` | 元素 id（全库唯一，5 张类别表共享同一 id 空间） |
| `public_layer_id` | TEXT | `NOT NULL` `FK → public_layer CASCADE` | 所属公共图层（删公共图层连带删元素） |
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
| `move_icon_asset_id` | TEXT | — | 移动图标上传素材 id（删素材置空） |
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
| `ord` | INTEGER | `NOT NULL` | 同图层内排序 · 默认 `0` |
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

- `CHECK (end_sec >= start_sec)`（绕中心旋转角（度））
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

#### public_element_territory — 公共疆域元素：public_layer 内的疆域副本（与 element_territory 同构）

**职责**：公共疆域元素（public_layer 内副本，与 element_territory 同构）　**前端**：同上

31 列 · 主键 `element_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `element_id` | TEXT | `PK` | 元素 id（全库唯一，5 张类别表共享同一 id 空间） |
| `public_layer_id` | TEXT | `NOT NULL` `FK → public_layer CASCADE` | 所属公共图层（删公共图层连带删元素） |
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
| `ord` | INTEGER | `NOT NULL` | 同图层内排序 · 默认 `0` |
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

- `CHECK (end_sec >= start_sec)`（兼并事件数组：[{eventId,sec,toCountryId,preset,duration_sec,highlight,plotIds[],ord}]；时间与时长均为秒；toCountryId 同上）

#### public_element_image — 公共贴图元素：public_layer 内的贴图副本（与 element_image 同构）

**职责**：公共贴图元素（public_layer 内副本，与 element_image 同构）　**前端**：同上

14 列 · 主键 `element_id`

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `element_id` | TEXT | `PK` | 元素 id（全库唯一，类别表共享同一 id 空间） |
| `public_layer_id` | TEXT | `NOT NULL` `FK → public_layer CASCADE` | 所属公共图层（删公共图层连带删元素） |
| `type` | TEXT | `NOT NULL` | 子类型判别列（固定 geo_image） · 默认 `'geo_image'` · `CHECK (type = 'geo_image')` |
| `name` | TEXT | `NOT NULL` | 元素名（与属性面板首字段 LABEL 同步） · 默认 `''` |
| `visible` | INTEGER | `NOT NULL` | 是否显示（0/1） · 默认 `1` · `CHECK (visible IN (0,1))` |
| `start_sec` | REAL | `NOT NULL` | 出现时间（秒） · `CHECK (start_sec >= 0)` |
| `end_sec` | REAL | `NOT NULL` | 消失时间（秒） |
| `asset_id` | TEXT | — | 图片素材 id（全局素材库，弱引用、无外键） |
| `aspect` | REAL | — | 图片宽高比（宽/高），切片渲染用 · `CHECK (aspect IS NULL OR aspect > 0)` |
| `cols` | INTEGER | `NOT NULL` | 配准网格列数（1=四角投影，≥2=网格变形） · 默认 `1` · `CHECK (cols >= 1)` |
| `rows` | INTEGER | `NOT NULL` | 配准网格行数 · 默认 `1` · `CHECK (rows >= 1)` |
| `grid_json` | TEXT | — | 控制点数组（行优先 (rows+1)×(cols+1) 个 [lng,lat]） · `CHECK (grid_json IS NULL OR json_valid(grid_json))` |
| `opacity` | REAL | — | 不透明度（0–1） · `CHECK (opacity IS NULL OR opacity BETWEEN 0 AND 1)` |
| `ord` | INTEGER | `NOT NULL` | 同图层内排序 · 默认 `0` |

**表级约束**

- `CHECK (end_sec >= start_sec)`（同图层内排序）

<!-- FIELD-DICT:END -->

## 五、工具栏与元素类型：5 个按钮 → 5 张表 / 12 种元素

元素**按工具栏聚合为 5 张类别宽表**，表内用 `type` 判别列区分子类型。工具条当前是 **5 个按钮**（标记 / 路线 / 形状 / 疆域 / 图片，见 `Toolbar.tsx` 的 `TOOLS`），其中「形状」「疆域」带下拉子菜单；「区域」（行政区高亮）的产物就是 `polygon`，与形状共用一张表，不单列按钮。

| 工具条按钮 | 交互方式 | 落到哪张表的哪个 type |
|---|---|---|
| **标记** Pin | 一键放到地图中心，之后在面板里改样式/换形态 | `element_marker`：`point`（圆点/水滴针/气泡/Emoji/文字） 切到 Marker → `flag`；军标导入/旧数据 → `military_symbol` |
| **路线** Route | 进入绘制模式，采点成线 | `element_route`：`line`（线型与路线特效在右侧 Settings 切换） |
| **形状** Shape | 下拉菜单三组共 19 项：多点绘制 / 两点绘制 / 特殊图形 | `element_shape`：`polygon`（多边形/曲线多边/防御圈/圆/矩形/五角星）、`arrow`（带箭头/行军/燕尾/自定义）、`double_arrow`（钳形）、`gathering`（集结点） 其中带箭头/战线的直线属**路线表** `line` |
| **区域** Region（形状下拉内） | 打开行政区选择器，点国家/地区 | `element_shape` 的 `polygon`（按边界自动生成可编辑高亮面，跨海国家拆多个面）——**与形状共用一张表** |
| **疆域** Terr | 下拉菜单 4 项：新建疆域 / 导入 / 绘制地块 / 兼并 | `element_territory`（势力 / 地块 / 兼并事件 JSON 全部内联在本表） |
| **图片** Image | 导入图片 / 从全局素材库插入，拖控制点做地理配准 | `element_image`：`geo_image`（控制点网格 `grid_json` 内联，图片本体走全局素材库） |

#### 当前没有工具栏入口的元素类型

    - `flag`（旗帜）：没有独立按钮，靠**标记面板切到 Marker** 原地改类型得到（同一张 `element_marker`）。

    - `moving_point`（移动点）、`encirclement`（包围圈）：绘制模式在代码里已实现，但工具条上没有按钮触发。

    - `military_symbol`（军标）：不再是独立工具，而是标记的 10 种形态之一（Pin 工具面板里选）。

看元素列表、画时间线轨道时查视图 `v_element_index`（五张类别表的公共列 UNION，**不需要 5 路 JOIN**）；真正画地图时才按已知的 `type` 去取对应类别表的专属列。

| 地图上的东西 | 表 | type 取值 | 专属字段（举例） |
|---|---|---|---|
| 点标记 | `element_marker` | `point` | shape（10 种）、emoji、scale、orientation、rotation、color、asset_id / builtin_id / icon_lib+icon_name、visual_meta_json |
| 旗帜 | `element_marker` | `flag` | flag_text、flag_color、flag_width |
| 军标（APP-6） | `element_marker` | `military_symbol` | sidc、echelon、symbol_size |
| 路线 / 飞线 | `element_route` | `line` | coords_json、line_type、route_effect_json、flow_speed |
| 移动点（带拖尾） | `element_route` | `moving_point` | coords_json、trail_color、trail_length |
| 区域（多边形/矩形/圆/五角星） | `element_shape` | `polygon` | shape_kind、circle_meta_json、rect_meta_json、star_meta_json |
| 箭头（多种） | `element_shape` | `arrow` | arrow_type、from/to、path_json |
| 双箭头 / 钳形 | `element_shape` | `double_arrow` | points_json（走 `buildDoubleArrow` 几何） |
| 包围圈 / 集结点 | `element_shape` | `encirclement` / `gathering` | center_lng/lat、radius、pulse_animation |
| 疆域（势力/地块/兼并） | `element_territory` | `territory` | display_json ＋ countries_json / plots_json / events_json |

### 点标记的 10 种形态与能力矩阵

这张矩阵同时驱动三处：**属性面板**（不满足则隐藏控件）、**数据库 CHECK**（不满足则拒绝写入）、**渲染端**（按形态选管线）。

| 形态 | shape | 资源来源 | 缩放 | 贴地 flat | 旋转 | 着色 | 专属参数（visual_meta_json） |
|---|---|---|---|---|---|---|---|
| 圆点 | `circle` | — | ✓ | ✓ | ✓ | ✓ | — |
| 水滴针 | `pin` | — | ✓ | ✓ | ✓ | ✓ | — |
| 气泡 | `bubble` | — | ✓ | ✓ | ✓ | ✓ | — |
| 文字 | `text` | — | ✓ | ✓ | ✓ | ✓ | — |
| 表情 | `emoji` | 内置字符 | ✓ | ✓ | ✓ | **✗**（唯一不可着色：表情字符自带颜色） | — |
| **图片** | `image` | 内置图集 / 上传 png·jpg·webp·**svg** | ✓ | ✓ | ✓ | ✓ | `{fit, tintable}` |
| **GIF** | `gif` | 内置动图 / 上传 gif·webp | ✓ | ✓ | ✓ | ✓ | `{fps, loop}` |
| **模型** | `model` | 内置模型 / 上传 glb·gltf | ✓ | **✗**（位图贴片，强制面向镜头） | ✓ | ✓ | `{altitude, autoRotate, spin, pitchAlign, animation}` |
| **图标库** | `icon` | lucide / react-icons / 自建库 | ✓ | ✓ | ✓ | ✓ | `{strokeWidth}` |
| **军标** | `military_symbol` | 内置 milsymbol 按 SIDC 生成 | ✓ | ✓ | ✓ | ✓ | `{fit, tintable}` |

资源两来源：**`asset_id`**（用户上传，进 asset 表外置存储）与 **`builtin_id`**（内置资源，打包进应用、不入库）；图标形态额外用 `icon_lib` + `icon_name` 定位，自建库条目落在 `asset`（`kind='icon'`，`UNIQUE` 由应用层保证）。

## 六、容易混淆的 5 组

| 容易混的地方 | 区别 |
|---|---|
| `element_marker` / `element_route` / `element_shape` / `element_territory` / `element_image` vs 表内 `type` | 五张表按**工具栏**分（标记 / 路线 / 形状 / 疆域 / 图片）；表内的 `type` 才是具体元素类型（point / line / polygon…）。找元素先看它在哪个工具下，再用 `type` 区分 |
| `label_json` vs `keyframes_json`（都是元素表内的一列） | 前者是**文字气泡内容**，后者是**动画曲线**（8 种属性的关键帧数组）—— 都作为一列 JSON 跟随元素一起读写，不再独立成表 |
| `narration` vs `narration_entry` | 前者是「全片的配音档」（样式、总开关，与项目 1:1）；后者是「档里的一条条字幕」（1:N） |
| `overlay` 的内容块 | custom 的内容块 / person 的人物块内联在 `overlay.payload_json`，不再单独建表 |
| `layer` vs `public_layer`（字段几乎一样） | `layer` 属于某个项目（`project_id` 外键，删项目 CASCADE）；`public_layer` 是**跨项目图库里的独立副本**，没有项目归属，`element_id` 与源项目**无关**（整层复制时重新加后缀）。导入 = 从副本再复制一份进项目，之后两者互不影响 |

## 七、一次「打开」与一次「保存」

#### 打开项目（读）

      - 读 `project`（身份 / 归属 / 生效底图 + 全局配置列）一行

      - 读 `layer`（按 `ord`）→ 图层列表；图层是元素的唯一归属，**项目 ▸ 图层 ▸ 元素**

      - 查视图 `v_element_index`（5 张类别表的公共列 UNION）→ 时间线轨道与元素列表（**不做 JOIN**）

      - 按需取类别表：只有真正要渲染的元素才查它所属的类别表（marker / route / shape / territory / image），连带取出专属列

      - `*_sec` 按 `default_fps` 换算成帧，组装回 `MapVideoProject`（含 `layers[]` 与其 `elements[]`，`project.elements` 由图层派生）交给 store（上层无感）

#### 保存项目（写）

      - 整个保存过程放在**一个事务**里（实测：逐条提交 vs 单事务差 63 倍）

      - 先写父表（`project` → `layer` → `元素类别表`）；素材是**弱引用**，`asset` 行须先于引用它的元素

      - 二进制素材先入 `asset`，业务表只写 `asset_id`（**顺序不能反**：项目侧 `asset_id` 有外键，缺行会回滚整笔事务）

      - 帧 → 秒在写入端换算（只存用户输入的原值，fps 变了时长不失真）

      - 同类别内切换子类型只需 `UPDATE type` + 补齐该子类型的必填字段（CHECK 会校验）；**跨类别**切换则是「删旧表行 → 插新表行」（图层类型也要跟着换）

      - 保存后跑一遍一致性自检视图（`v_check_dangling` / `v_check_territory_ref`），应全部返回 0 行

#### 实现状态

桌面端（`electron/db-v2.mjs` + `electron/main.mjs` 的 `db:*` IPC）已按本设计的多表结构落地：`ensureV2Schema` 建表、`saveProjectV2` / `getProjectV2` 做多表 ↔ `MapVideoProject` 双向映射、`*PublicLayerV2` 管公共图层库，并带引用完整性（外键默认开启）。网页端仍是 Dexie / localStorage 的简化实现（ IndexedDB 无外键、无触发器，规则由 `src/lib` 应用层保证）。未决问题见 `docs/db-redesign.md` 末节。

## 附：4 个视图，以及为什么没有触发器

表之外原本还有触发器；本设计**不定义任何触发器**，理由见本节末尾。

### 4 个视图（不存数据，只是固化查询）

| 视图 | 类别 | 作用 |
|---|---|---|
| `v_element_index` | 读取便利 | 把 5 张类别表的公共列 UNION 成一张「元素总表」：取消基表后，轨道 / 列表 / 计数查这里，不用手写 5 表 UNION |
| `v_check_dangling` | 一致性自检 | 查悬空引用：跟随机位指向已删除的路线元素；`element_image.asset_id` 与公共库副本的 `asset_id` 指向不存在的素材（这几列没有外键，只能靠视图）。写入端对应动作是启动体检 `repairAssetRefs`；正常应返回 0 行 |
| `v_check_territory_ref` | 一致性自检 | 疆域 JSON 内部一致性：`plots_json` 的 `ownerId`、`events_json` 的 `toCountryId` 必须能在 `countries_json` 中命中（复合外键被 JSON 化后的补偿） |

### 为什么没有触发器（原 6 条已全部移除）

原本 6 个触发器补的是外键表达不了的两类规则：`trg_camera_follow_chapter_ins/_upd`（跟随机位只能引用同一章节内的路线元素）、`trg_marker/route/shape/territory_cleanup`（弱引用反向清理）。**2026-09-12 起全部移除**，原因：

1. **双端不一致**：网页端是 Dexie（IndexedDB），**没有触发器** —— 数据库侧触发器只在桌面端生效，同一条规则会有两套真相；
2. **规则藏在表定义之外**：读 DDL 看不出「删一个元素到底连带删掉什么」；
3. **与写入端逻辑重复**：隐式行为干扰调试、导入与数据修复。

这些规则改由**应用层**（唯一的写入路径）保证，两端行为一致：

| 原触发器承担的规则 | 现在由谁保证 |
|---|---|
| 公共图层副本的素材引用不得悬空 | 删素材时一并清空副本引用（`assets:remove`）+ 启动体检 `repairAssetRefs` 兜底 |
| 副本元素 id 不得与既有行撞车 | 保存 / 导入两条路径统一给 `element_id` 加后缀（`:pb<pubId>` / `:im<layerId>`） |
| 跟随机位只能引用同一项目内的路线元素 | 写入端校验（选择跟随机位时只列本项目路线）+ 外键 `SET NULL` 兜底 |

数据库侧只保留 `v_check_dangling` / `v_check_territory_ref` 两个**自检视图**：它们不拦截写入，只把「数据已损坏」从隐性变成可检测。

MapVideo V2 表清单速查 · 由 `docs/db-schema-v2.sql` 与 `src/types/index.ts` 的实际定义整理，表名、主键、外键均取自 DDL 实测解析结果。

配套文件：`docs/db-redesign.md`（设计依据与选型对比）· `docs/db-schema-v2.sql`（可执行 DDL）· `tools/audit-fk-indexes.mjs`（外键索引审计）
