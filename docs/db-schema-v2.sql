-- =============================================================================
-- MapVideo V2 关系型数据库结构
-- 目标引擎：SQLite（桌面端 node:sqlite / DatabaseSync）；Dexie 端见报告第 6.4 节
-- 命名约定：表名与 TS 实体同名并转 snake_case（elementMarker ↔ element_marker），
--          主键统一 <实体>_id，时间统一 *_sec（秒，REAL）/ *_at（epoch ms，仅审计字段用）
-- 字符集：UTF-8；时间单位：**秒**（REAL，存用户输入的原值）；
--          渲染 / 导出时按 project.default_fps 换算为帧（帧是派生量，不入库）
-- 规模：15 张表 / 3 视图 / 0 触发器（不使用触发器，理由见第 10 节）
--
-- ★ 2026-09-10 元素建模改版（按工具栏类别聚合）：
--   取消 element 基表与 13 张按元素类型拆分的子表，改为 4 张「类别宽表」，
--   每张表自带全部公共列，用 type 判别列区分类别内的子类型（类别内 STI）：
--     element_marker    标记类（Pin 工具）  type ∈ point | flag | military_symbol
--     element_route     路线类（Route 工具）type ∈ line | moving_point | connector
--     element_shape     形状类（Shape 工具）type ∈ polygon | arrow | double_arrow | gathering | encirclement
--     element_territory 疆域类（Terr 工具） type = territory
--   图片类作为「独立元素类型」已下线，但以「point 的一种形态」回归：
--   element_marker.shape 扩展为 9 种（circle/text/pin/bubble/emoji/image/gif/model/icon），
--   媒体资源经 asset_id（用户上传）或 builtin_id（内置打包进应用、不入库）引用；
--   能力矩阵（模型不可着色 / 不能贴地，GIF 不可着色）由 CHECK 约束与属性面板共同保证。
--   疆域内部实体（势力/地块/兼并事件）
--   JSON 内联进 element_territory；元素标签（label）内联为 label_json。
--   代价与补偿：跨表引用（connector 端点、keyframe 归属）失去外键，改由
--   应用层清理 + 一致性自检视图兜底（不使用触发器，见第 10 节）；
--   跨类别列表查询用 v_element_index。
-- =============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- -----------------------------------------------------------------------------
-- 1. 合集与项目聚合根
-- -----------------------------------------------------------------------------

-- 合集：项目之上的一层分组。
--   · 默认合集 id 恒为 'default'（不可改名、不可删除），新建项目 / 导入未指定归属时落在这里
--   · 删合集只把其下项目移回默认合集（应用层先迁移再删，故用 RESTRICT 防误删）
CREATE TABLE IF NOT EXISTS collection (  -- 合集：项目之上的一层分组（合集 ▸ 项目 ▸ 元素）；默认合集恒为 default，不可改名/删除
  collection_id TEXT PRIMARY KEY,  -- 合集 id（默认合集恒为 default，不可删除）
  name          TEXT    NOT NULL,  -- 合集名（默认合集名为「默认合集」，不可改名）
  ord           INTEGER NOT NULL DEFAULT 0,  -- 合集排序（默认合集固定 -1，恒排最前）
  created_at    INTEGER NOT NULL,  -- 创建时间（毫秒时间戳）
  updated_at    INTEGER NOT NULL  -- 最后修改时间（毫秒时间戳）
);

CREATE TABLE IF NOT EXISTS project (  -- 项目本体：身份 / 归属 / 审计 / 投影 / 生效底图与高程 / GlobalConfig 配置列
  project_id            TEXT PRIMARY KEY,  -- 项目 id
  name                  TEXT    NOT NULL,  -- 项目名
  description           TEXT,  -- 项目描述
  -- 所属合集；缺省即默认合集（见上）
  collection_id         TEXT    NOT NULL DEFAULT 'default'  -- 所属合集（默认 default）；删合集时其下项目回落到默认合集
                        REFERENCES collection(collection_id) ON DELETE RESTRICT,
  created_at            INTEGER NOT NULL,  -- 创建时间（毫秒时间戳）
  updated_at            INTEGER NOT NULL,  -- 最后保存时间（毫秒时间戳）

  -- 地图投影：渲染方式，属于项目本身（随项目走，与内容类配置分离）
  projection            TEXT    NOT NULL DEFAULT 'mercator'  -- 地图投影：mercator 平面 / globe 3D 球体（渲染方式，随项目走）
                        CHECK (projection IN ('mercator','globe')),

  -- 当前生效的底图 / 高程图：存内置配置的 id 字符串（如 'osm' / 'none'），配置本身在代码里
  active_base_map_id      TEXT,  -- 当前生效底图的配置 id（底图是代码内置常量，不入库）
  active_elevation_map_id TEXT,  -- 当前生效高程图的配置 id（同上）

  -- 项目级配置（GlobalConfig；原 project_config 1:1 表已合并进来）
  default_duration_sec      REAL NOT NULL DEFAULT 5 CHECK (default_duration_sec > 0),  -- 默认章节时长（秒）
  default_fps           INTEGER NOT NULL DEFAULT 30 CHECK (default_fps BETWEEN 1 AND 240),  -- 默认帧率（1–240）
  resolution_w          INTEGER NOT NULL DEFAULT 1920 CHECK (resolution_w > 0),  -- 默认导出宽度（px）
  resolution_h          INTEGER NOT NULL DEFAULT 1080 CHECK (resolution_h > 0),  -- 默认导出高度（px）
  -- 画幅标签（如「1080p 横屏 (16:9)」）由 w×h 推导，不落库
  default_easing        TEXT    NOT NULL DEFAULT 'easeInOut',  -- 默认缓动类型
  -- 地形夸张：覆盖当前生效高程图的内置默认值（内置 1.5；0=平坦、1=真实比例，面板范围 0–50）
  elevation_exaggeration REAL CHECK (elevation_exaggeration IS NULL OR elevation_exaggeration BETWEEN 0 AND 50)  -- 地形夸张系数（覆盖内置默认 1.5；0=平坦、1=真实比例；空=用内置默认）
,
  -- 全片总长（秒）
  end_sec REAL NOT NULL DEFAULT 0 CHECK (end_sec >= 0)  -- 全片总长（秒）
);

-- -----------------------------------------------------------------------------
-- 2. 资源与素材
-- -----------------------------------------------------------------------------

-- 【底图 / 高程图不入库】
-- 它们是代码内置的常量配置（BUILTIN_BASE_MAPS / BUILTIN_ELEVATION_MAPS），
-- 项目与章节只保存所选配置的 id 字符串（project.active_base_map_id）。
-- 取舍：省掉两张表与两处外键（连带消除原本的循环外键问题）；
--       代价是底图 / 高程图配置不可由用户在运行时增删改。
-- 例外：**地形夸张系数用户可调**（面板滑动条 0–50），因此作为「对当前生效高程图的覆盖值」
--      落在 project.elevation_exaggeration（NULL = 沿用内置默认的 1.5）。

-- 素材表（**唯一**的素材存储，合并了原 custom_symbol / custom_image）：
-- 把 base64 dataURL 从项目 JSON 中剥离出来，是本次改造收益最大的一项。
-- kind 覆盖：image（含静态图与 gif）/ model / audio / video / font / **icon**（用户图标库条目）。
-- asset_id 为**随机 id**（与文件名解耦，改名不影响引用）；桌面端文件按「项目 / 类型 / 时间戳」命名：
--   userData/projects/<projectId>/<images|models|audio|video|fonts>/<YYYYMMDD-HHmmss>-<assetId><ext>
-- 不再做 sha256 内容寻址去重 —— 同一文件上传两次就是两份（时间戳命名永不重名）。
-- 原 custom_symbol（图标库）/ custom_image（图片库）本质上都只是「项目收录的一个素材」，
-- 由 kind 区分：icon 即原图标库条目，image 即原图片库条目。
-- ★ 只存输入原值：字节数 / 尺寸 / 时长 / 帧数 / 模型包围盒等都是**从文件解析出来的派生值**，
--   不入库（需要时按 mime 现场解析——图片取 naturalWidth、音频用 duration、GIF 用 gifuct、模型用 glTF 头）。
CREATE TABLE IF NOT EXISTS asset (  -- 素材仓库：图片 / GIF / 模型 / 音频 / 视频 / 图标 / 字体统一存此表，业务表只留 asset_id
  asset_id      TEXT PRIMARY KEY,  -- 素材 id（随机生成，与文件名/内容解耦，改名不影响引用）
  kind          TEXT NOT NULL CHECK (kind IN ('image','gif','model','audio','video','font','icon')),  -- 素材种类：image 图片 / gif 动图 / model 3D 模型 / audio 音频 / video 视频 / font 字体 / icon 用户图标库条目（合并了原 custom_symbol / custom_image）
  name          TEXT NOT NULL DEFAULT '',  -- 原文件名 / 展示名
  mime          TEXT NOT NULL,  -- MIME 类型（如 image/png）
  storage       TEXT NOT NULL CHECK (storage IN ('file','blob')),  -- 存放方式：file 外置文件 / blob 库内联
  rel_path      TEXT,  -- 外置方式下的相对路径（相对 userData/projects/）
  blob          BLOB,  -- 内联方式下的小文件二进制
  created_at    INTEGER NOT NULL,  -- 入库时间（毫秒时间戳）
  CHECK ((storage = 'file' AND rel_path IS NOT NULL)
      OR (storage = 'blob' AND blob      IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_asset_kind ON asset(kind);
CREATE INDEX IF NOT EXISTS ix_asset_name ON asset(name);

-- -----------------------------------------------------------------------------
-- 3. 时间轴（项目 = 单条连续时间线，无章节）
-- -----------------------------------------------------------------------------

-- 相机视角关键帧：sec = 「到达时间」（绝对秒），move_duration_sec = 起飞提前量（秒）
CREATE TABLE IF NOT EXISTS camera_keyframe (  -- 视角关键帧：停留 → 飞行 → 落位；含 follow 跟随 / orbit 环绕视角
  kf_id            TEXT PRIMARY KEY,  -- 视角关键帧 id
  project_id       TEXT NOT NULL REFERENCES project(project_id) ON DELETE CASCADE,  -- 所属项目
  sec            REAL NOT NULL CHECK (sec >= 0),  -- 到达时间（秒，项目绝对时间轴）—— 语义为「停留 → 飞行 → 落位」的落位时刻
  center_lng       REAL NOT NULL,  -- 视角中心经度
  center_lat       REAL NOT NULL,  -- 视角中心纬度
  zoom             REAL NOT NULL,  -- 缩放级别
  pitch            REAL,  -- 俯仰角（度）
  bearing          REAL,  -- 方向角（度）
  easing           TEXT,  -- 飞行缓动类型
  move_duration_sec    REAL CHECK (move_duration_sec IS NULL OR move_duration_sec >= 0),  -- 起飞提前量（秒，默认 2 秒）
  camera_type      TEXT CHECK (camera_type IS NULL OR camera_type IN ('fixed','follow','orbit')),  -- 视角类型：fixed 固定 / follow 跟随 / orbit 环绕

  -- follow 视角：跟随目标只能是路线类元素（line / moving_point）
  -- 单列外键 + SET NULL：复合外键会连带清空 NOT NULL 的 project_id（见报告 5.6）
  -- 跟随的时间窗口由「被跟随路线的显示起止」推导，不另存 follow_start/end（派生值不入库）
  follow_route_element_id TEXT REFERENCES element_route(element_id) ON DELETE SET NULL,  -- 跟随的路线元素（外键指向 element_route，只能是 line / moving_point；删除后置空，退化为固定视角）
  follow_direction        INTEGER CHECK (follow_direction IS NULL OR follow_direction IN (0,1)),  -- 跟随视角是否按路线切线自动定向

  -- orbit 视角
  orbit_speed    REAL,  -- 环绕速度（度/秒）
  orbit_duration_sec REAL,  -- 环绕时长（秒）
  ord            INTEGER NOT NULL DEFAULT 0  -- 同章节内排序
);
CREATE INDEX IF NOT EXISTS ix_camera_kf_chapter ON camera_keyframe(project_id, sec);
CREATE INDEX IF NOT EXISTS ix_camera_kf_follow  ON camera_keyframe(follow_route_element_id);

-- -----------------------------------------------------------------------------
-- 3b. 图层（元素的分组）：项目 ▸ 图层 ▸ 元素
--     图层带自己的显隐与显示区间；元素通过 layer_id 归属图层（删图层连带删元素）。
--     元素的时间（start_sec/end_sec）为项目绝对秒，渲染时与图层区间取交集；
--     元素是否「随图层全程可见」由元素表的时间语义 + 应用层决定。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS layer (  -- 图层：元素的分组（项目 ▸ 图层 ▸ 元素），单类型图层（标记/路线/形状/疆域/图片），带自己的显隐与显示区间
  layer_id   TEXT PRIMARY KEY,  -- 图层 id
  project_id TEXT NOT NULL REFERENCES project(project_id) ON DELETE CASCADE,  -- 所属项目（删项目连带删图层）
  type       TEXT NOT NULL CHECK (type IN ('marker','route','shape','territory','image')),  -- 图层类型（单类型图层）：marker 标记 / route 路线 / shape 形状 / territory 疆域 / image 图片
  name       TEXT NOT NULL DEFAULT '',  -- 图层名
  visible    INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0,1)),  -- 是否显示（0/1）
  start_sec  REAL NOT NULL CHECK (start_sec >= 0),  -- 图层显示起点（秒，项目绝对时间）
  end_sec    REAL NOT NULL,  -- 图层显示终点（秒，项目绝对时间）
  ord        INTEGER NOT NULL DEFAULT 0,  -- 同项目内排序
  CHECK (end_sec >= start_sec)
);
CREATE INDEX IF NOT EXISTS ix_layer_project ON layer(project_id, ord);

-- -----------------------------------------------------------------------------
-- 4. 元素表（5 张类别宽表）
--    公共列（每张表都有）：element_id / project_id / layer_id / type / name / visible /
--    start_sec / end_sec / anim_effect / keyframes_json / ord，以及平铺后的标签列 label_*。
-- -----------------------------------------------------------------------------

-- 5.1 标记类元素（Pin 工具）：point（点/文字/图标）· flag（旗标）· military_symbol（APP-6 军标）
CREATE TABLE IF NOT EXISTS element_marker (  -- 标记类元素（Pin 工具）：point / flag / military_symbol 一张宽表，type 判别
  element_id     TEXT PRIMARY KEY,  -- 元素 id（全库唯一，4 张类别表共享同一 id 空间）
  project_id     TEXT NOT NULL REFERENCES project(project_id) ON DELETE CASCADE,  -- 所属项目
  layer_id       TEXT REFERENCES layer(layer_id) ON DELETE CASCADE,  -- 所属图层（删图层连带删元素；元素可换图层）
  type           TEXT NOT NULL CHECK (type IN ('point','flag','military_symbol')),  -- 子类型判别列：point 点 / flag 旗标 / military_symbol 军标（Pin 工具）

  name           TEXT NOT NULL DEFAULT '',  -- 元素名（与属性面板首字段 LABEL 同步）
  visible        INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0,1)),  -- 是否显示（0/1）
  start_sec    REAL NOT NULL CHECK (start_sec >= 0),  -- 出现时间（秒）
  end_sec      REAL NOT NULL,  -- 消失时间（秒）
  anim_effect    TEXT CHECK (anim_effect IS NULL OR anim_effect IN ('grow','move','fill','march','marchplain')),  -- 动画效果：grow 增长 / move 移动 / fill 填充 / march 填充行进 / marchplain 行进
  fly_mode       INTEGER NOT NULL DEFAULT 0 CHECK (fly_mode IN (0,1)),  -- 悬空飞行模式：按高度剖面离地显示
  show_icon      INTEGER NOT NULL DEFAULT 0 CHECK (show_icon IN (0,1)),  -- 是否显示移动图标
  move_start_sec REAL,  -- 移动图标出发时间（秒）
  move_end_sec   REAL,  -- 移动图标到达时间（秒）
  uniform_move     INTEGER CHECK (uniform_move IS NULL OR uniform_move IN (0,1)),  -- 是否全程匀速（0 则按各路径点自定义到达时间）
  point_times_json TEXT CHECK (point_times_json IS NULL OR json_valid(point_times_json)),  -- 各路径点到达时间数组（秒，非匀速时使用）
  -- 标签（原 label_json 平铺：面板上每个小项 = 一列）
  label_text        TEXT,  -- 标签文字（与元素名同步）
  label_font_size   REAL,  -- 标签字号
  label_color       TEXT,  -- 标签文字颜色
  label_position    TEXT CHECK (label_position IS NULL OR label_position IN ('top','bottom','left','right','center')),  -- 标签位置：top/bottom/left/right/center
  label_offset_x    REAL,  -- 标签水平像素偏移（0=居中，负左正右）
  label_offset_y    REAL,  -- 标签垂直像素偏移（0=居中，正值向上）
  label_bg_color    TEXT,  -- 标签背景色（默认透明）
  label_bg_padding  REAL,  -- 标签背景内边距
  label_bg_radius   REAL,  -- 标签背景圆角
  label_font_weight TEXT CHECK (label_font_weight IS NULL OR label_font_weight IN ('normal','bold')),  -- 标签字重：normal / bold
  keyframes_json TEXT CHECK (keyframes_json IS NULL OR json_valid(keyframes_json)),  -- 动画关键帧数组（原 element_keyframe 表内联）：[{property,sec,easing,value_num,value_json}]；同 property 同 sec 不得重复
  ord            INTEGER NOT NULL DEFAULT 0,  -- 同章节内排序

  -- 位置（三类标记都落在单点）
  lng            REAL NOT NULL,  -- 经度（三类标记都落在单点）
  lat            REAL NOT NULL,  -- 纬度
  rotation       REAL,  -- 贴地旋转角（0–360 度）

  -- point 专属：视觉形态（9 种）+ 资源引用
  --   circle 圆点 · text 文字 · pin 水滴针 · bubble 气泡 · emoji 表情
  --   image 图片 · gif 动图 · model 3D 模型（three.js + custom layer）· icon 图标库（lucide / react-icons / 自建）
  shape          TEXT CHECK (shape IS NULL OR shape IN (  -- 点呈现形态（9 种）：circle 圆点 / text 纯文字 / pin 水滴针 / bubble 气泡 / emoji 表情 / image 图片 / gif 动图 / model 3D 模型 / icon 图标库
                   'circle','text','pin','bubble','emoji','image','gif','model','icon')),
  emoji          TEXT,  -- 表情字符（type=point 且 shape=emoji 时必填）
  scale          REAL CHECK (scale IS NULL OR (scale >= 0.3 AND scale <= 3)),  -- 等比缩放（0.3–3，同时影响点与标签字号）
  orientation    TEXT CHECK (orientation IS NULL OR orientation IN ('faceCam','flat')),  -- 朝向：faceCam 面向镜头 / flat 贴地（shape=model 不能贴地，CHECK 保证）
  color          TEXT,  -- 可着色形态的主色（shape=model / gif 时禁用，CHECK 保证）
  asset_id       TEXT REFERENCES asset(asset_id) ON DELETE SET NULL,  -- 用户上传的图片 / GIF / 模型素材（删除素材则置空）
  builtin_id     TEXT,  -- 内置资源 id（打包进应用、不入库）：image:flag-red / gif:radar / model:drone / icon:lucide:MapPin
  icon_lib       TEXT,  -- 图标库命名空间：lucide / react-icons/xxx / 自建库名（shape=icon 时用）
  icon_name      TEXT,  -- 图标名（shape=icon 时必填，可指向内置库或 custom_symbol.name）
  -- 资源形态表现参数（原 visual_meta_json 平铺；面板上每个小项 = 一列）
  visual_fit        TEXT CHECK (visual_fit IS NULL OR visual_fit IN ('contain','cover')),  -- image 适配方式：contain / cover
  visual_tintable   INTEGER CHECK (visual_tintable IS NULL OR visual_tintable IN (0,1)),  -- image 是否允许着色（0/1）
  visual_fps        REAL,  -- gif 帧率
  visual_loop       INTEGER CHECK (visual_loop IS NULL OR visual_loop IN (0,1)),  -- gif 是否循环（0/1）
  visual_altitude   REAL,  -- model 离地高度（米）
  visual_auto_rotate REAL,  -- model 自转角速度（度/秒）
  visual_spin       REAL,  -- model 初始朝向（度）
  visual_pitch_align INTEGER CHECK (visual_pitch_align IS NULL OR visual_pitch_align IN (0,1)),  -- model 是否随地图俯仰倾斜（0/1）
  visual_animation  TEXT,  -- model 播放的动画片段名
  visual_stroke_width REAL,  -- icon 描边粗细

  -- flag 专属
  flag_text      TEXT,  -- 旗面文字（type=flag 时必填）
  flag_color     TEXT,  -- 旗面颜色
  flag_text_color TEXT,  -- 旗面文字颜色
  flag_font_size REAL,  -- 旗面字号
  flag_width     REAL,  -- 旗面宽度（px）

  -- military_symbol 专属
  sidc           TEXT,  -- APP-6 军标符号编码（type=military_symbol 时必填）
  symbol_size    REAL,  -- 军标尺寸
  echelon        TEXT,  -- 军标梯队 / 规模标注
  symbol_label   TEXT,  -- 军标旁附加文字

  CHECK (end_sec >= start_sec),
  CHECK (move_end_sec IS NULL OR move_start_sec IS NULL OR move_end_sec > move_start_sec),
  CHECK (type <> 'point' OR shape IS NOT 'emoji' OR emoji IS NOT NULL),
  -- 媒体形态（image/gif/model/icon）必须指明来源：用户上传 asset 或内置 builtin
  CHECK (type <> 'point' OR shape IS NULL
         OR shape IN ('circle','text','pin','bubble','emoji')
         OR asset_id IS NOT NULL OR builtin_id IS NOT NULL),
  CHECK (type <> 'point' OR shape IS NOT 'icon' OR icon_name IS NOT NULL),
  -- 能力矩阵（与属性面板「隐藏不可用控件」一一对应）
  CHECK (shape IS NOT 'model' OR color IS NULL),                        -- 模型不可着色（多材质）
  CHECK (shape IS NOT 'gif'   OR color IS NULL),                        -- GIF 不可着色（多帧彩色）
  CHECK (shape IS NOT 'model' OR orientation IS NULL OR orientation = 'faceCam'),  -- 模型不能贴地
  CHECK (type <> 'flag'  OR flag_text IS NOT NULL),
  CHECK (type <> 'military_symbol' OR sidc IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_marker_chapter ON element_marker(project_id, ord);
CREATE INDEX IF NOT EXISTS ix_marker_type    ON element_marker(project_id, type);
CREATE INDEX IF NOT EXISTS ix_marker_asset   ON element_marker(asset_id);
CREATE INDEX IF NOT EXISTS ix_marker_layer   ON element_marker(layer_id);

-- 5.2 路线类元素（Route 工具）：line（线/贝塞尔/大圆弧）· moving_point（移动点）·
--     connector（连接线，引用其它元素 → 弱引用 from/to）
CREATE TABLE IF NOT EXISTS element_route (  -- 路线类元素（Route 工具）：line / moving_point / connector 一张宽表，type 判别
  element_id     TEXT PRIMARY KEY,  -- 元素 id（全库唯一，4 张类别表共享同一 id 空间）
  project_id     TEXT NOT NULL REFERENCES project(project_id) ON DELETE CASCADE,  -- 所属项目
  layer_id       TEXT REFERENCES layer(layer_id) ON DELETE CASCADE,  -- 所属图层（删图层连带删元素；元素可换图层）
  type           TEXT NOT NULL CHECK (type IN ('line','moving_point','connector')),  -- 子类型判别列：line 线 / moving_point 移动点 / connector 连接线（Route 工具）

  name           TEXT NOT NULL DEFAULT '',  -- 元素名（与属性面板首字段 LABEL 同步）
  visible        INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0,1)),  -- 是否显示（0/1）
  start_sec    REAL NOT NULL CHECK (start_sec >= 0),  -- 出现时间（秒）
  end_sec      REAL NOT NULL,  -- 消失时间（秒）
  anim_effect    TEXT CHECK (anim_effect IS NULL OR anim_effect IN ('grow','move','fill','march','marchplain')),  -- 动画效果：grow / move / fill / march / marchplain
  fly_mode       INTEGER NOT NULL DEFAULT 0 CHECK (fly_mode IN (0,1)),  -- 悬空飞行模式：路线与图标按高度剖面离地显示
  show_icon      INTEGER NOT NULL DEFAULT 0 CHECK (show_icon IN (0,1)),  -- 是否显示移动图标
  -- 移动图标（原 move_icon_json 平铺：面板「显示标记」每个小项 = 一列）
  move_icon_shape          TEXT CHECK (move_icon_shape IS NULL OR move_icon_shape IN ('dot','pin','emoji','bubble','text','flag','image','gif','model','icon','military_symbol')),  -- 移动图标形态：dot/pin/emoji/bubble/text/flag + 图片/动图/模型/图标库/军标
  move_icon_color          TEXT,  -- 移动图标主色
  move_icon_emoji          TEXT,  -- 移动图标表情字符（形态=emoji）
  move_icon_scale          REAL,  -- 移动图标等比缩放
  move_icon_label_text     TEXT,  -- 移动图标标签文字
  move_icon_label_color    TEXT,  -- 移动图标标签文字颜色
  move_icon_label_bg       TEXT,  -- 移动图标标签背景色（默认透明）
  move_icon_label_size     REAL,  -- 移动图标标签字号
  move_icon_label_padding  REAL,  -- 移动图标标签内边距
  move_icon_label_radius   REAL,  -- 移动图标标签圆角
  move_icon_label_pos      TEXT,  -- 移动图标标签位置（旧枚举：top/bottom/left/right）
  move_icon_label_offset_x REAL,  -- 移动图标标签水平像素偏移（0=居中，负左正右）
  move_icon_label_offset_y REAL,  -- 移动图标标签垂直像素偏移（0=居中，正值向上）
  move_icon_flag_text      TEXT,  -- 移动图标为旗帜时的旗面文字
  move_icon_flag_color     TEXT,  -- 移动图标为旗帜时的旗面颜色
  move_icon_builtin_id     TEXT,  -- 移动图标内置资源 id（不入库资源）
  move_icon_asset_id       TEXT REFERENCES asset(asset_id) ON DELETE SET NULL,  -- 移动图标上传素材 id（删素材置空）
  move_icon_icon_lib       TEXT,  -- 移动图标图标库命名空间
  move_icon_icon_name      TEXT,  -- 移动图标图标名
  move_icon_orientation    TEXT CHECK (move_icon_orientation IS NULL OR move_icon_orientation IN ('faceCam','flat')),  -- 移动图标朝向：faceCam 面向镜头 / flat 贴地
  move_icon_rotation       REAL,  -- 移动图标贴地旋转角（度）
  move_icon_show_label     INTEGER CHECK (move_icon_show_label IS NULL OR move_icon_show_label IN (0,1)),  -- 移动图标是否显示标签（0/1）
  move_start_sec REAL,  -- 移动图标出发时间（秒）
  move_end_sec   REAL,  -- 移动图标到达时间（秒）
  uniform_move     INTEGER CHECK (uniform_move IS NULL OR uniform_move IN (0,1)),  -- 是否全程匀速（0 则按各路径点自定义到达时间）
  point_times_json TEXT CHECK (point_times_json IS NULL OR json_valid(point_times_json)),  -- 各路径点到达时间数组（秒）
  -- 标签（原 label_json 平铺）
  label_text        TEXT,  -- 标签文字（与元素名同步）
  label_font_size   REAL,  -- 标签字号
  label_color       TEXT,  -- 标签文字颜色
  label_position    TEXT CHECK (label_position IS NULL OR label_position IN ('top','bottom','left','right','center')),  -- 标签位置：top/bottom/left/right/center
  label_offset_x    REAL,  -- 标签水平像素偏移（0=居中，负左正右）
  label_offset_y    REAL,  -- 标签垂直像素偏移（0=居中，正值向上）
  label_bg_color    TEXT,  -- 标签背景色（默认透明）
  label_bg_padding  REAL,  -- 标签背景内边距
  label_bg_radius   REAL,  -- 标签背景圆角
  label_font_weight TEXT CHECK (label_font_weight IS NULL OR label_font_weight IN ('normal','bold')),  -- 标签字重：normal / bold
  keyframes_json TEXT CHECK (keyframes_json IS NULL OR json_valid(keyframes_json)),  -- 动画关键帧数组（原 element_keyframe 表内联）：[{property,sec,easing,value_num,value_json}]；同 property 同 sec 不得重复
  ord            INTEGER NOT NULL DEFAULT 0,  -- 同章节内排序

  -- line / moving_point 路径（line_type=bezier 时为控制点，arc 时为大圆弧端点）
  coords_json       TEXT CHECK (coords_json IS NULL OR json_valid(coords_json)),  -- 路径点数组 [[lng,lat],…]；line_type=bezier 时为控制点、arc 时为大圆弧端点（line / moving_point 必填）

  -- line 专属
  line_width        REAL,  -- 线宽（px）
  line_color        TEXT,  -- 线条颜色（moving_point 时为主色）
  line_dash_on      REAL,  -- 虚线段长（原 line_dash_json[0]）
  line_dash_off     REAL,  -- 虚线空白长（原 line_dash_json[1]）
  line_type         TEXT CHECK (line_type IS NULL OR line_type IN ('straight','bezier','arc')),  -- 线型：straight 直线 / bezier 贝塞尔 / arc 大圆弧航线
  line_arrow        INTEGER CHECK (line_arrow IS NULL OR line_arrow IN (0,1)),  -- 线末端是否带方向箭头（0/1）
  -- 行军路线动画（原 route_effect_json 平铺）：光点颜色/宽度/步长/同时存在数量
  route_dot_enabled    INTEGER CHECK (route_dot_enabled IS NULL OR route_dot_enabled IN (0,1)),  -- 行军光点动画是否开启（0/1）
  route_dot_count      INTEGER,  -- 同时存在的光点数量
  route_dot_width      REAL,  -- 光点宽度（px）
  route_dot_color      TEXT,  -- 光点颜色
  route_dot_frame_step INTEGER,  -- 每 N 帧光点前进一步
  flow_speed        REAL,  -- 流动速度（0 关闭；>0 每 N 帧相位前进一步，行军蚁效果）
  plain_path        INTEGER CHECK (plain_path IS NULL OR plain_path IN (0,1)),  -- 无样式路线：预览与导出不画线，仅显示移动图标
  -- 战线梳齿（原 front_style_json 平铺）
  front_tooth_length REAL,  -- 战线梳齿长度（px）
  front_tooth_gap    REAL,  -- 战线梳齿间距（px）
  front_tooth_angle  REAL,  -- 梳齿偏角（度）
  front_side         INTEGER CHECK (front_side IS NULL OR front_side IN (-1,1)),  -- 梳齿朝向侧：1 右 / -1 左

  -- moving_point 专属（轨迹拖尾）
  trail_color       TEXT,  -- 拖尾颜色（type=moving_point）
  trail_width       REAL,  -- 拖尾宽度（px）
  trail_length      INTEGER,  -- 拖尾长度（帧）

  -- connector 专属：端点弱引用（可指向任意类别元素，因元素已分表，无法建外键）
  from_element_id   TEXT,  -- 连接线起点元素（弱引用：可指向任意类别元素，元素已分表故无外键；删元素时由应用层连带删除本行）
  to_element_id     TEXT,  -- 连接线终点元素（弱引用；与起点不得相同）
  animated          INTEGER CHECK (animated  IS NULL OR animated  IN (0,1)),  -- 连接线是否流动动画（0/1）
  arrowhead         INTEGER CHECK (arrowhead IS NULL OR arrowhead IN (0,1)),  -- 连接线是否显示末端箭头（0/1）

  CHECK (end_sec >= start_sec),
  CHECK (move_end_sec IS NULL OR move_start_sec IS NULL OR move_end_sec > move_start_sec),
  CHECK (type <> 'line'         OR coords_json IS NOT NULL),
  CHECK (type <> 'moving_point' OR coords_json IS NOT NULL),
  CHECK (type <> 'connector'    OR (from_element_id IS NOT NULL AND to_element_id IS NOT NULL)),
  CHECK (from_element_id IS NULL OR to_element_id IS NULL OR from_element_id <> to_element_id)
);
CREATE INDEX IF NOT EXISTS ix_route_chapter ON element_route(project_id, ord);
CREATE INDEX IF NOT EXISTS ix_route_type    ON element_route(project_id, type);
-- 连接线端点：应用层按 from/to 反查清理，必须建索引（否则删元素时全表扫描）
CREATE INDEX IF NOT EXISTS ix_route_from    ON element_route(project_id, from_element_id);
CREATE INDEX IF NOT EXISTS ix_route_to      ON element_route(project_id, to_element_id);
CREATE INDEX IF NOT EXISTS ix_route_layer   ON element_route(layer_id);

-- 5.3 形状类元素（Shape 工具，含「区域」行政区高亮）：polygon · arrow · double_arrow ·
--     gathering（集结地）· encirclement（包围圈）
CREATE TABLE IF NOT EXISTS element_shape (  -- 形状类元素（Shape 工具）：polygon / arrow / double_arrow / gathering / encirclement；Region 行政区也写此表
  element_id     TEXT PRIMARY KEY,  -- 元素 id（全库唯一，4 张类别表共享同一 id 空间）
  project_id     TEXT NOT NULL REFERENCES project(project_id) ON DELETE CASCADE,  -- 所属项目
  layer_id       TEXT REFERENCES layer(layer_id) ON DELETE CASCADE,  -- 所属图层（删图层连带删元素；元素可换图层）
  type           TEXT NOT NULL CHECK (type IN ('polygon','arrow','double_arrow','gathering','encirclement')),  -- 子类型判别列：polygon 多边形 / arrow 箭头 / double_arrow 钳形 / gathering 集结地 / encirclement 包围圈（Shape 工具）

  name           TEXT NOT NULL DEFAULT '',  -- 元素名（与属性面板首字段 LABEL 同步）
  visible        INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0,1)),  -- 是否显示（0/1）
  start_sec    REAL NOT NULL CHECK (start_sec >= 0),  -- 出现时间（秒）
  end_sec      REAL NOT NULL,  -- 消失时间（秒）
  anim_effect    TEXT CHECK (anim_effect IS NULL OR anim_effect IN ('grow','move','fill','march','marchplain')),  -- 动画效果：grow / move / fill / march / marchplain
  fly_mode       INTEGER NOT NULL DEFAULT 0 CHECK (fly_mode IN (0,1)),  -- 悬空飞行模式
  show_icon      INTEGER NOT NULL DEFAULT 0 CHECK (show_icon IN (0,1)),  -- 是否显示移动图标
  -- 移动图标（原 move_icon_json 平铺：面板「显示标记」每个小项 = 一列）
  move_icon_shape          TEXT CHECK (move_icon_shape IS NULL OR move_icon_shape IN ('dot','pin','emoji','bubble','text','flag','image','gif','model','icon','military_symbol')),  -- 移动图标形态：dot/pin/emoji/bubble/text/flag + 图片/动图/模型/图标库/军标
  move_icon_color          TEXT,  -- 移动图标主色
  move_icon_emoji          TEXT,  -- 移动图标表情字符（形态=emoji）
  move_icon_scale          REAL,  -- 移动图标等比缩放
  move_icon_label_text     TEXT,  -- 移动图标标签文字
  move_icon_label_color    TEXT,  -- 移动图标标签文字颜色
  move_icon_label_bg       TEXT,  -- 移动图标标签背景色（默认透明）
  move_icon_label_size     REAL,  -- 移动图标标签字号
  move_icon_label_padding  REAL,  -- 移动图标标签内边距
  move_icon_label_radius   REAL,  -- 移动图标标签圆角
  move_icon_label_pos      TEXT,  -- 移动图标标签位置（旧枚举：top/bottom/left/right）
  move_icon_label_offset_x REAL,  -- 移动图标标签水平像素偏移（0=居中，负左正右）
  move_icon_label_offset_y REAL,  -- 移动图标标签垂直像素偏移（0=居中，正值向上）
  move_icon_flag_text      TEXT,  -- 移动图标为旗帜时的旗面文字
  move_icon_flag_color     TEXT,  -- 移动图标为旗帜时的旗面颜色
  move_icon_builtin_id     TEXT,  -- 移动图标内置资源 id（不入库资源）
  move_icon_asset_id       TEXT REFERENCES asset(asset_id) ON DELETE SET NULL,  -- 移动图标上传素材 id（删素材置空）
  move_icon_icon_lib       TEXT,  -- 移动图标图标库命名空间
  move_icon_icon_name      TEXT,  -- 移动图标图标名
  move_icon_orientation    TEXT CHECK (move_icon_orientation IS NULL OR move_icon_orientation IN ('faceCam','flat')),  -- 移动图标朝向：faceCam 面向镜头 / flat 贴地
  move_icon_rotation       REAL,  -- 移动图标贴地旋转角（度）
  move_icon_show_label     INTEGER CHECK (move_icon_show_label IS NULL OR move_icon_show_label IN (0,1)),  -- 移动图标是否显示标签（0/1）
  move_start_sec REAL,  -- 移动图标出发时间（秒）
  move_end_sec   REAL,  -- 移动图标到达时间（秒）
  uniform_move     INTEGER CHECK (uniform_move IS NULL OR uniform_move IN (0,1)),  -- 是否全程匀速（0 则按各路径点自定义到达时间）
  point_times_json TEXT CHECK (point_times_json IS NULL OR json_valid(point_times_json)),  -- 各路径点到达时间数组（秒）
  -- 标签（原 label_json 平铺）
  label_text        TEXT,  -- 标签文字（与元素名同步）
  label_font_size   REAL,  -- 标签字号
  label_color       TEXT,  -- 标签文字颜色
  label_position    TEXT CHECK (label_position IS NULL OR label_position IN ('top','bottom','left','right','center')),  -- 标签位置：top/bottom/left/right/center
  label_offset_x    REAL,  -- 标签水平像素偏移（0=居中，负左正右）
  label_offset_y    REAL,  -- 标签垂直像素偏移（0=居中，正值向上）
  label_bg_color    TEXT,  -- 标签背景色（默认透明）
  label_bg_padding  REAL,  -- 标签背景内边距
  label_bg_radius   REAL,  -- 标签背景圆角
  label_font_weight TEXT CHECK (label_font_weight IS NULL OR label_font_weight IN ('normal','bold')),  -- 标签字重：normal / bold
  keyframes_json TEXT CHECK (keyframes_json IS NULL OR json_valid(keyframes_json)),  -- 动画关键帧数组（原 element_keyframe 表内联）：[{property,sec,easing,value_num,value_json}]；同 property 同 sec 不得重复
  ord            INTEGER NOT NULL DEFAULT 0,  -- 同章节内排序

  -- polygon 专属
  --   poly：rings_json 是输入；circle / rect / star：几何由下面的参数算出（派生值不入库，rings_json 留空）
  rings_json         TEXT CHECK (rings_json IS NULL OR json_valid(rings_json)),  -- 多边形环数组：rings[0] 为外环，其余为洞（type=polygon 时必填）
  fill_color         TEXT,  -- 填充色
  fill_opacity       REAL CHECK (fill_opacity IS NULL OR fill_opacity BETWEEN 0 AND 1),  -- 填充透明度（0–1）
  stroke_color       TEXT,  -- 描边色
  stroke_width       REAL,  -- 描边宽度（px）
  shape_kind         TEXT CHECK (shape_kind IS NULL OR shape_kind IN ('poly','rect','circle','star')),  -- 多边形种类：poly 多边形 / rect 矩形 / circle 圆 / star 五角星
  -- rect：两个对角点（原 rect_meta_json 平铺）
  rect_c1_lng        REAL,  -- 矩形对角点1经度
  rect_c1_lat        REAL,  -- 矩形对角点1纬度
  rect_c2_lng        REAL,  -- 矩形对角点2经度
  rect_c2_lat        REAL,  -- 矩形对角点2纬度
  poly_curve         INTEGER CHECK (poly_curve IS NULL OR poly_curve IN (0,1)),  -- 各边曲线化（闭合贝塞尔拟合，0/1）
  -- 防御圈锯齿（原 defense_style_json 平铺）
  defense_tooth_length REAL,  -- 防御圈锯齿长度（px）
  defense_tooth_gap    REAL,  -- 防御圈锯齿间距（px）
  defense_tooth_angle  REAL,  -- 防御圈锯齿偏角（度）
  defense_side         INTEGER CHECK (defense_side IS NULL OR defense_side IN (-1,1)),  -- 防御圈锯齿朝向侧：1 右 / -1 左
  -- 填充渐变（原 fill_gradient_json 平铺）
  gradient_enabled   INTEGER CHECK (gradient_enabled IS NULL OR gradient_enabled IN (0,1)),  -- 填充渐变是否开启（0/1）
  gradient_from      TEXT,  -- 渐变起始色
  gradient_to        TEXT,  -- 渐变结束色

  -- arrow 专属
  from_lng       REAL,  -- 箭头起点经度（type=arrow 时必填）
  from_lat       REAL,  -- 箭头起点纬度
  to_lng         REAL,  -- 箭头终点经度
  to_lat         REAL,  -- 箭头终点纬度
  path_json      TEXT CHECK (path_json IS NULL OR json_valid(path_json)),  -- 弯曲燕尾箭头的控制点（≥2 个时按贝塞尔渲染）
  arrow_type     TEXT CHECK (arrow_type IS NULL OR arrow_type IN (  -- 箭头类型（type=arrow 时必填）：swallowtail 燕尾 / simple / block / pincer 钳形 / curved / curved-simple / attack / straight
                   'swallowtail','simple','block','pincer','curved','curved-simple','attack','straight')),
  width          REAL,  -- 箭头宽度（px）
  color          TEXT,  -- 颜色（箭头 / 集结地 / 钳形共用）

  -- double_arrow 专属（钳形攻势）
  points_json    TEXT CHECK (points_json IS NULL OR json_valid(points_json)),  -- 4 个控制点（type=double_arrow 钳形攻势时必填）

  -- gathering / encirclement 专属（circle / star 也复用 center_lng / center_lat / radius）
  center_lng     REAL,  -- 中心经度（gathering / encirclement 必填）
  center_lat     REAL,  -- 中心纬度
  radius         REAL,  -- 半径（米，gathering / encirclement 必填）
  pulse_animation INTEGER CHECK (pulse_animation IS NULL OR pulse_animation IN (0,1)),  -- 是否脉冲动画（集结地，0/1）
  rotation       REAL,  -- 绕中心旋转角（度）

  CHECK (end_sec >= start_sec),
  CHECK (move_end_sec IS NULL OR move_start_sec IS NULL OR move_end_sec > move_start_sec),
  CHECK (radius IS NULL OR radius > 0),
  CHECK (type <> 'polygon' OR shape_kind IS NOT 'poly'   OR rings_json IS NOT NULL),
  CHECK (type <> 'polygon' OR shape_kind IS NOT 'circle' OR (center_lng IS NOT NULL AND center_lat IS NOT NULL AND radius IS NOT NULL)),
  CHECK (type <> 'polygon' OR shape_kind IS NOT 'rect'   OR (rect_c1_lng IS NOT NULL AND rect_c1_lat IS NOT NULL AND rect_c2_lng IS NOT NULL AND rect_c2_lat IS NOT NULL)),
  CHECK (type <> 'polygon' OR shape_kind IS NOT 'star'   OR (center_lng IS NOT NULL AND center_lat IS NOT NULL AND radius IS NOT NULL)),
  CHECK (type <> 'arrow' OR arrow_type IS NOT NULL),
  CHECK (type <> 'arrow' OR (from_lng IS NOT NULL AND from_lat IS NOT NULL
                             AND to_lng IS NOT NULL AND to_lat IS NOT NULL)),
  CHECK (type <> 'double_arrow' OR points_json IS NOT NULL),
  CHECK (type <> 'gathering'    OR (center_lng IS NOT NULL AND center_lat IS NOT NULL AND radius IS NOT NULL)),
  CHECK (type <> 'encirclement' OR (center_lng IS NOT NULL AND center_lat IS NOT NULL AND radius IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_shape_chapter ON element_shape(project_id, ord);
CREATE INDEX IF NOT EXISTS ix_shape_type    ON element_shape(project_id, type);
CREATE INDEX IF NOT EXISTS ix_shape_layer   ON element_shape(layer_id);

-- 5.4 疆域类元素（Terr 工具）：势力 / 地块 / 兼并事件全部 JSON 内联
--     countries_json: [{ countryId, name, color, ord }]
--     plots_json:     [{ plotId, name, rings, ownerId, ord }]        rings = GeoJSON 环数组
--     events_json:    [{ eventId, sec, toCountryId, preset, duration_sec, highlight, plotIds[], ord }]
CREATE TABLE IF NOT EXISTS element_territory (  -- 疆域类元素（Terr 工具）：势力 / 地块 / 兼并事件 JSON 内联，自包含
  element_id     TEXT PRIMARY KEY,  -- 元素 id（全库唯一，4 张类别表共享同一 id 空间）
  project_id     TEXT NOT NULL REFERENCES project(project_id) ON DELETE CASCADE,  -- 所属项目
  layer_id       TEXT REFERENCES layer(layer_id) ON DELETE CASCADE,  -- 所属图层（删图层连带删元素；元素可换图层）
  type           TEXT NOT NULL DEFAULT 'territory' CHECK (type = 'territory'),  -- 子类型判别列（固定 territory）

  name           TEXT NOT NULL DEFAULT '',  -- 元素名（与属性面板首字段 LABEL 同步）
  visible        INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0,1)),  -- 是否显示（0/1）
  start_sec    REAL NOT NULL CHECK (start_sec >= 0),  -- 出现时间（秒）
  end_sec      REAL NOT NULL,  -- 消失时间（秒）
  anim_effect    TEXT CHECK (anim_effect IS NULL OR anim_effect IN ('grow','move','fill','march','marchplain')),  -- 动画效果：grow / move / fill / march / marchplain
  -- 标签（原 label_json 平铺）
  label_text        TEXT,  -- 标签文字（与元素名同步）
  label_font_size   REAL,  -- 标签字号
  label_color       TEXT,  -- 标签文字颜色
  label_position    TEXT CHECK (label_position IS NULL OR label_position IN ('top','bottom','left','right','center')),  -- 标签位置：top/bottom/left/right/center
  label_offset_x    REAL,  -- 标签水平像素偏移（0=居中，负左正右）
  label_offset_y    REAL,  -- 标签垂直像素偏移（0=居中，正值向上）
  label_bg_color    TEXT,  -- 标签背景色（默认透明）
  label_bg_padding  REAL,  -- 标签背景内边距
  label_bg_radius   REAL,  -- 标签背景圆角
  label_font_weight TEXT CHECK (label_font_weight IS NULL OR label_font_weight IN ('normal','bold')),  -- 标签字重：normal / bold
  keyframes_json TEXT CHECK (keyframes_json IS NULL OR json_valid(keyframes_json)),  -- 动画关键帧数组（原 element_keyframe 表内联）：[{property,sec,easing,value_num,value_json}]；property ∈ opacity/scale/rotation/draw_progress/progress/path_progress/fill_progress/morph；同 property 同 sec 不得重复
  ord            INTEGER NOT NULL DEFAULT 0,  -- 同章节内排序

  -- 显示配置（原 display_json 平铺）：边界 / 线宽 / 透明度 / 标签
  display_country_borders INTEGER NOT NULL DEFAULT 1 CHECK (display_country_borders IN (0,1)),  -- 是否显示势力边界（0/1）
  display_plot_borders    INTEGER NOT NULL DEFAULT 1 CHECK (display_plot_borders IN (0,1)),  -- 是否显示地块边界（0/1）
  display_border_width    REAL NOT NULL DEFAULT 3 CHECK (display_border_width >= 0),  -- 势力边界线宽（px）
  display_fill_opacity    REAL NOT NULL DEFAULT 0.45 CHECK (display_fill_opacity BETWEEN 0 AND 1),  -- 填充透明度（0–1）
  display_country_names   INTEGER NOT NULL DEFAULT 1 CHECK (display_country_names IN (0,1)),  -- 是否显示势力名标签（0/1）
  display_plot_names      INTEGER NOT NULL DEFAULT 0 CHECK (display_plot_names IN (0,1)),  -- 是否显示地块名标签（0/1）
  display_label_align     TEXT NOT NULL DEFAULT 'map' CHECK (display_label_align IN ('map','viewport')),  -- 标签朝向：map 随图 / viewport 面向镜头
  display_label_scale     REAL NOT NULL DEFAULT 1 CHECK (display_label_scale > 0),  -- 标签缩放倍数
  countries_json TEXT CHECK (countries_json IS NULL OR json_valid(countries_json)),  -- 势力数组：[{countryId,name,color,ord}]
  plots_json     TEXT CHECK (plots_json     IS NULL OR json_valid(plots_json)),  -- 地块数组：[{plotId,name,rings,ownerId,ord}]；ownerId 须能在 countries_json 中命中（由 v_check_territory_ref 校验）
  events_json    TEXT CHECK (events_json    IS NULL OR json_valid(events_json)),  -- 兼并事件数组：[{eventId,sec,toCountryId,preset,duration_sec,highlight,plotIds[],ord}]；时间与时长均为秒；toCountryId 同上

  CHECK (end_sec >= start_sec)
);
CREATE INDEX IF NOT EXISTS ix_territory_chapter ON element_territory(project_id, ord);
CREATE INDEX IF NOT EXISTS ix_territory_layer   ON element_territory(layer_id);

-- -----------------------------------------------------------------------------
-- 4b. 贴图（地理配准图片）：工具栏「图片」产出
--     图片本体存**全局素材库**（asset_id 弱引用，不入本表 / 也不做 FK）；
--     本表只存配准参数：控制点网格（cols×rows，2×2=四角投影，更大=网格变形）。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS element_image (  -- 贴图类元素（Image 工具）：地理配准图片的控制点网格；图片本体走全局素材库，本表只存配准参数
  element_id     TEXT PRIMARY KEY,  -- 元素 id（全库唯一，类别表共享同一 id 空间）
  project_id     TEXT NOT NULL REFERENCES project(project_id) ON DELETE CASCADE,  -- 所属项目
  layer_id       TEXT REFERENCES layer(layer_id) ON DELETE CASCADE,  -- 所属图层（删图层连带删元素；元素可换图层）
  type           TEXT NOT NULL DEFAULT 'geo_image' CHECK (type = 'geo_image'),  -- 子类型判别列（固定 geo_image）

  name           TEXT NOT NULL DEFAULT '',  -- 元素名（与属性面板首字段 LABEL 同步）
  visible        INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0,1)),  -- 是否显示（0/1）
  start_sec      REAL NOT NULL CHECK (start_sec >= 0),  -- 出现时间（秒）
  end_sec        REAL NOT NULL,  -- 消失时间（秒）

  asset_id       TEXT,  -- 图片素材 id（全局素材库，弱引用、无外键）
  aspect         REAL CHECK (aspect IS NULL OR aspect > 0),  -- 图片宽高比（宽/高），切片渲染用
  cols           INTEGER NOT NULL DEFAULT 1 CHECK (cols >= 1),  -- 配准网格列数（1=四角投影，≥2=网格变形）
  rows           INTEGER NOT NULL DEFAULT 1 CHECK (rows >= 1),  -- 配准网格行数
  grid_json      TEXT CHECK (grid_json IS NULL OR json_valid(grid_json)),  -- 控制点数组（行优先 (rows+1)×(cols+1) 个 [lng,lat]）
  opacity        REAL CHECK (opacity IS NULL OR opacity BETWEEN 0 AND 1),  -- 不透明度（0–1）
  ord            INTEGER NOT NULL DEFAULT 0,  -- 同章内排序

  CHECK (end_sec >= start_sec)
);
CREATE INDEX IF NOT EXISTS ix_element_image ON element_image(project_id, ord);
CREATE INDEX IF NOT EXISTS ix_image_layer   ON element_image(layer_id);

-- -----------------------------------------------------------------------------
-- 5. 元素动画关键帧：**已内联**进 4 张类别表的 keyframes_json（P3）
--    运行时元素对象本就内联关键帧数组（drawProgress / morphKeyframes 等），
--    独立成表反而需要「元素 ↔ 关键帧」的弱引用维护，故取消该表。
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 6. 叠加层（弹出元素）
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS overlay (  -- 叠加层（弹窗）：本体一张，custom / person 内容块内联在 payload_json
  overlay_id   TEXT PRIMARY KEY,  -- 弹窗 id
  project_id   TEXT NOT NULL REFERENCES project(project_id) ON DELETE CASCADE,  -- 所属项目
  type         TEXT NOT NULL CHECK (type IN (  -- 弹窗类型：custom / chart / person / report / timeline / quote / compare / counter / dialogue / place
                 'custom','chart','person','report','timeline','quote','compare',
                 'stat','seal','iconRow',
                 'counter','dialogue','place')),
  name         TEXT NOT NULL DEFAULT '',  -- 显示名（时间线轨道上展示）
  position     TEXT NOT NULL CHECK (position IN (  -- 九宫格位置：top / topLeft / center / bottomRight 等 9 种
                 'top','bottom','left','right','center',
                 'topLeft','topRight','bottomLeft','bottomRight')),
  start_sec  REAL NOT NULL CHECK (start_sec >= 0),  -- 出现时间（秒）
  end_sec    REAL NOT NULL,  -- 消失时间（秒）
  animation      TEXT,  -- 入场动画预设
  exit_animation TEXT,  -- 退场动画预设（结束前 20 帧播放）
  scale        REAL,  -- 整体缩放
  offset_x     REAL NOT NULL DEFAULT 0,  -- 横向微调（%，-40..40）
  offset_y     REAL NOT NULL DEFAULT 0,  -- 纵向微调（%，-40..40）
  z_index      INTEGER NOT NULL DEFAULT 0,  -- 层级
  -- 卡片背景（原 bg_json 平铺）
  bg_color     TEXT,  -- 卡片背景色
  bg_opacity   REAL CHECK (bg_opacity IS NULL OR bg_opacity BETWEEN 0 AND 1),  -- 卡片背景不透明度（0–1）
  bg_blur      REAL,  -- 卡片背景模糊半径
  bg_radius    REAL,  -- 卡片圆角半径
  bg_border    TEXT,  -- 卡片边框颜色
  -- P3：类型专属载荷整体存取：custom 的内容块 / person 的人物块 + report/quote/compare/chart 等
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),  -- 类型专属载荷整体存取：custom 内容块 / person 人物块 / report/quote/compare/chart 等
  -- person 布局 + 整卡语音
  person_layout_json TEXT CHECK (person_layout_json IS NULL OR json_valid(person_layout_json)),  -- 人物卡版式：图片方位/对齐/间距/卡片宽/名言样式/叠图
  audio_asset_id TEXT REFERENCES asset(asset_id) ON DELETE SET NULL,  -- 背景语音（卡片可见时播放；导出混流待支持）
  parent_overlay_id TEXT REFERENCES overlay(overlay_id) ON DELETE CASCADE,  -- 父弹窗（group 嵌套结构）
  ord          INTEGER NOT NULL DEFAULT 0,  -- 同章节内排序
  CHECK (end_sec >= start_sec)
);
CREATE INDEX IF NOT EXISTS ix_overlay_chapter ON overlay(project_id, start_sec);
CREATE INDEX IF NOT EXISTS ix_overlay_parent  ON overlay(parent_overlay_id);

-- 内容块（custom 的 blocks / person 的 5 类块）与 payload、布局一起内联在 overlay.payload_json /
-- person_layout_json 中：弹窗整体读写，内容块不单独寻址，原 overlay_block / person_block 两张中间表已删除。

-- -----------------------------------------------------------------------------
-- 7. 章节级特效 / 字幕 / 配乐
-- -----------------------------------------------------------------------------
-- 注：原 chapter_fx（游标轨迹/聚焦辉光/扫描线）已删除 —— 该功能从未实现渲染与 UI，
--     属设计遗留；将来要做类似效果时按实际需求重新设计。

-- 特效窗口：天气 / 画面特效（屏幕空间），两分支字段并存
CREATE TABLE IF NOT EXISTS screen_fx (  -- 屏幕空间特效窗口：天气 / 画面叠加（非地图元素），两分支字段并存
  fx_id      TEXT PRIMARY KEY,  -- 特效窗口 id
  project_id TEXT NOT NULL REFERENCES project(project_id) ON DELETE CASCADE,  -- 所属项目
  kind       TEXT NOT NULL CHECK (kind IN ('weather','screen')),  -- 类别：weather 天气 / screen 画面特效
  name       TEXT NOT NULL DEFAULT '',  -- 显示名（时间线轨道上展示）
  start_sec REAL NOT NULL CHECK (start_sec >= 0),  -- 起始时间（秒，项目绝对时间轴）
  end_sec   REAL NOT NULL,  -- 结束时间（秒，项目绝对时间轴）
  weather_type TEXT CHECK (weather_type IS NULL OR weather_type IN ('rain','snow','lightning','fog')),  -- 天气类型：rain 雨 / snow 雪 / lightning 闪电 / fog 雾
  intensity  REAL CHECK (intensity IS NULL OR intensity BETWEEN 0 AND 1),  -- 强度（0–1）
  wind       REAL CHECK (wind IS NULL OR wind BETWEEN -1 AND 1),  -- 风向风力（-1..1，向右为正）
  effect_type TEXT CHECK (effect_type IS NULL OR effect_type IN (  -- 画面特效：shake 震动 / flash 闪光 / vignette 暗角 / cloudReveal 云散 / fadeBlack / fadeWhite
                'shake','flash','vignette','cloudReveal','fadeBlack','fadeWhite')),
  effect_color TEXT,  -- 特效颜色（flash、fade 类使用）
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),  -- 是否启用
  ord        INTEGER NOT NULL DEFAULT 0,  -- 同章节内排序
  CHECK (end_sec >= start_sec),
  CHECK ((kind = 'weather' AND weather_type IS NOT NULL)
      OR (kind = 'screen'  AND effect_type  IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_screen_fx ON screen_fx(project_id, start_sec);

-- 字幕档：1:1 持有样式（原 style_json 平铺为列）；字幕条 1:N
CREATE TABLE IF NOT EXISTS narration (  -- 字幕 / 配音档：样式部分，与项目 1:1
  project_id   TEXT PRIMARY KEY REFERENCES project(project_id) ON DELETE CASCADE,  -- 项目 id（每项目一份配音档，1:1）
  font_size    REAL NOT NULL CHECK (font_size > 0),  -- 字幕字号
  font_family  TEXT,  -- 字体族（空=楷体默认）
  color        TEXT NOT NULL,  -- 字幕文字颜色
  stroke_color TEXT NOT NULL,  -- 字幕描边颜色
  stroke_width REAL NOT NULL CHECK (stroke_width >= 0),  -- 字幕描边宽度
  bg           TEXT NOT NULL CHECK (bg IN ('none','bar')),  -- 字幕背景：none 无 / bar 底部条带
  bg_color     TEXT NOT NULL,  -- 字幕背景色
  pos_y        REAL NOT NULL CHECK (pos_y BETWEEN 0 AND 40),  -- 字幕距底百分比（0–40）
  max_pct      REAL NOT NULL CHECK (max_pct > 0 AND max_pct <= 100)  -- 字幕最大宽度百分比
);

CREATE TABLE IF NOT EXISTS narration_entry (  -- 字幕条：文本 + 配音音频 + 显示时长
  entry_id      TEXT PRIMARY KEY,  -- 字幕条 id
  project_id    TEXT NOT NULL REFERENCES project(project_id) ON DELETE CASCADE,  -- 所属项目
  text          TEXT NOT NULL DEFAULT '',  -- 字幕文本（同时也是配音朗读文本）
  audio_asset_id TEXT REFERENCES asset(asset_id) ON DELETE SET NULL,  -- 配音音频（TTS 生成或导入）
  -- 音频地址（asset 不可用时的内联 dataURL / 站内路径；与 audio_asset_id 二选一）
  url           TEXT,  -- 音频地址（asset 不可用时的内联 dataURL / 站内路径）
  -- 显示时长（秒）：NULL = 自动（有配音随音频、无配音按字数估算）；非空 = 手动覆盖值
  duration_sec REAL CHECK (duration_sec IS NULL OR duration_sec >= 1),  -- 显示时长（秒）：空=自动（有配音随音频、无配音按字数估算）；非空=手动覆盖
  start_sec     REAL NOT NULL CHECK (start_sec >= 0),  -- 章内起始时间（秒，默认自动顺排）
  locked        INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),  -- 手动定位后锁定，不再参与自动顺排
  ord           INTEGER NOT NULL DEFAULT 0  -- 同章节内排序
);
CREATE INDEX IF NOT EXISTS ix_narration_entry ON narration_entry(project_id, start_sec);

-- 项目级背景音乐：单轨多段（段用项目绝对时间），同一轨道不同时间段放不同音乐
CREATE TABLE IF NOT EXISTS music_track (  -- 项目级背景音乐：单轨多段（项目绝对时间、段内循环、淡入淡出）
  track_id      TEXT PRIMARY KEY,  -- 音乐段 id
  project_id    TEXT NOT NULL REFERENCES project(project_id) ON DELETE CASCADE,  -- 所属项目（项目级单轨多段）
  name          TEXT NOT NULL DEFAULT '',  -- 曲目名
  audio_asset_id TEXT REFERENCES asset(asset_id) ON DELETE SET NULL,  -- 音频素材
  -- 音频地址（asset 不可用时的内联 dataURL / 站内路径；与 audio_asset_id 二选一）
  url           TEXT,  -- 音频地址（asset 不可用时的内联 dataURL / 站内路径）
  start_sec   REAL NOT NULL CHECK (start_sec >= 0),  -- 起效起始时间（秒，项目绝对时间轴）
  -- 结束时间：NULL = 随音频长度（循环则随项目）；非空 = 手动覆盖值
  end_sec     REAL,  -- 结束时间（秒）：空=随音频长度；非空=手动覆盖
  volume        REAL NOT NULL DEFAULT 1 CHECK (volume BETWEEN 0 AND 1),  -- 音量（0–1）
  loop          INTEGER NOT NULL DEFAULT 0 CHECK (loop IN (0,1)),  -- 是否循环播放
  fade_in       REAL NOT NULL DEFAULT 0 CHECK (fade_in  >= 0),  -- 淡入时长（秒）
  fade_out      REAL NOT NULL DEFAULT 0 CHECK (fade_out >= 0),  -- 淡出时长（秒）
  ord           INTEGER NOT NULL DEFAULT 0,  -- 同项目内排序
  CHECK (end_sec IS NULL OR end_sec >= start_sec)
);
CREATE INDEX IF NOT EXISTS ix_music_track ON music_track(project_id, start_sec);

-- -----------------------------------------------------------------------------
-- 8. 应用配置聚合（与项目内容解耦，Key 只存本机）
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS provider (  -- 应用配置：AI 文案 / 配音 / 图片服务商（密钥只存本机，与项目内容解耦）
  provider_id TEXT PRIMARY KEY,  -- 服务商配置 id
  kind       TEXT NOT NULL CHECK (kind IN ('llm','tts','image')),  -- 类别：llm 文案生成 / tts 语音合成（含克隆）/ image 图片生成
  label      TEXT NOT NULL DEFAULT '',  -- 显示名
  base_url   TEXT NOT NULL DEFAULT '',  -- 接口基础地址
  api_key    TEXT NOT NULL DEFAULT '',  -- 密钥（只存本机，不入项目文件）
  model      TEXT NOT NULL DEFAULT '',  -- 模型名 / TTS 音色模型
  protocol   TEXT CHECK (protocol IS NULL OR protocol IN (  -- TTS 协议：openai-speech / minimax-t2a / volc-tts / qwen-tts / custom
               'openai-speech','minimax-t2a','volc-tts','qwen-tts','custom')),
  voice      TEXT,  -- 音色 / 说话人 ID
  speed      REAL NOT NULL DEFAULT 1 CHECK (speed BETWEEN 0.5 AND 2),  -- 语速（0.5–2）
  extra      TEXT CHECK (extra IS NULL OR json_valid(extra)),  -- 附加请求参数（JSON，合并进请求体）
  active     INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),  -- 是否生效（每个 kind 至多一条为 1）
  ord        INTEGER NOT NULL DEFAULT 0  -- 同类内排序
);
-- 每个 kind 至多一条生效（部分唯一索引，替代旧的「先清后置」两步写法）
CREATE UNIQUE INDEX IF NOT EXISTS ux_provider_active
  ON provider(kind) WHERE active = 1;
CREATE INDEX IF NOT EXISTS ix_provider_kind ON provider(kind, ord);

-- =============================================================================
-- 9. 外键支撑索引（FK 子表列必须建索引 —— SQLite 上外键唯一的真实成本来源）
-- =============================================================================
-- 背景：SQLite 对外键的强制检查成本极低（实测 31k 行插入，FK 开/关仅差 ~1µs/行），
--       但**父行被删除/更新时，若子表外键列没有索引，SQLite 必须全表扫描子表**。
--       实测：5000 行连接线表，删除 200 个被引用端点 ——
--         无索引 3592ms  →  补索引 129ms（27×）
--       所以正确做法不是删外键，而是把子表列索引补齐。
-- 审计工具：node --experimental-sqlite tools/audit-fk-indexes.mjs（改 DDL 后必跑）
--   对每张表 PRAGMA foreign_key_list / index_list / index_info，
--   检查每个 FK 的子列是否被某个索引的前缀完整覆盖。

-- ① 素材引用：asset 的孤儿回收 / 「是否被引用」查询由全表扫描变为索引查找
CREATE INDEX IF NOT EXISTS ix_overlay_audio_asset  ON overlay(audio_asset_id);
CREATE INDEX IF NOT EXISTS ix_narration_audio_asset ON narration_entry(audio_asset_id);
-- 元素「移动标记」素材引用（平铺自 move_icon_json）
CREATE INDEX IF NOT EXISTS ix_route_move_icon_asset ON element_route(move_icon_asset_id);
CREATE INDEX IF NOT EXISTS ix_shape_move_icon_asset ON element_shape(move_icon_asset_id);
CREATE INDEX IF NOT EXISTS ix_music_audio_asset     ON music_track(audio_asset_id);
-- 注：element_marker(asset_id) 的索引见 5.1（ix_marker_asset）

-- ② 元素关键帧：FK 指向 chapter，删章节时避免扫描
--    （element_id 是弱引用、无 FK，索引 ix_element_kf 见第 6 节）

-- ③ 底图 / 高程图 / 合集被引用（删父行走 SET NULL / RESTRICT，低频但同样应避免扫描）
CREATE INDEX IF NOT EXISTS ix_project_collection   ON project(collection_id);
-- 注：底图 / 高程图列已不是外键（配置在代码里），无需外键支撑索引

-- =============================================================================
-- 10. 不使用触发器：弱引用的一致性由应用层保证
-- =============================================================================
--
-- 本设计**不定义任何触发器**（2026-09-12 起全部移除）。理由：
--   1) 双端不一致：网页端是 Dexie（IndexedDB），**没有触发器**，
--      数据库侧触发器只在桌面端生效，同一条业务规则会存在两套真相；
--   2) 规则被藏在表定义之外：读 DDL 看不出「删一个元素到底会连带删掉什么」；
--   3) 清理逻辑与写入端重复，隐式行为干扰调试、导入与数据修复。
--
-- 因此把规则前移到唯一的写入路径（应用层），两端行为一致：
--   · 删除元素 → 一并删除「以它为端点的 connector」与「挂在它名下的关键帧」
--   · camera_keyframe.follow_route_element_id 只允许引用**同一章节**内的路线元素
--   · 写入顺序：先建元素，再建引用它的连接线 / 关键帧
--
-- 数据库侧只保留 v_check_dangling / v_check_territory_ref 两个**自检视图**用于体检，
-- 它们不拦截写入，只把「数据已损坏」从隐性变为可检测。

-- =============================================================================
-- 11. 视图
-- =============================================================================

-- 12.1 跨类别元素索引：取消基表后，轨道 / 列表 / 计数查这里，不必手写 4 表 UNION
CREATE VIEW IF NOT EXISTS v_element_index AS
SELECT 'marker' AS category, element_id, project_id, layer_id, type, name, visible,
       start_sec, end_sec, ord
  FROM element_marker
UNION ALL
SELECT 'route', element_id, project_id, layer_id, type, name, visible,
       start_sec, end_sec, ord
  FROM element_route
UNION ALL
SELECT 'shape', element_id, project_id, layer_id, type, name, visible,
       start_sec, end_sec, ord
  FROM element_shape
UNION ALL
SELECT 'territory', element_id, project_id, layer_id, type, name, visible,
       start_sec, end_sec, ord
  FROM element_territory
UNION ALL
SELECT 'image', element_id, project_id, layer_id, type, name, visible,
       start_sec, end_sec, ord
  FROM element_image;

-- 12.2 悬空引用自检（弱引用 + 外键未开启时应为 0；迁移后与老库体检）
CREATE VIEW IF NOT EXISTS v_check_dangling AS
SELECT 'connector.from' AS edge, r.element_id AS ref_id, r.from_element_id AS target
  FROM element_route r
  WHERE r.type = 'connector' AND r.from_element_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM element_marker    WHERE element_id = r.from_element_id
      UNION ALL SELECT 1 FROM element_route     WHERE element_id = r.from_element_id
      UNION ALL SELECT 1 FROM element_shape     WHERE element_id = r.from_element_id
      UNION ALL SELECT 1 FROM element_territory WHERE element_id = r.from_element_id)
UNION ALL
SELECT 'connector.to', r.element_id, r.to_element_id
  FROM element_route r
  WHERE r.type = 'connector' AND r.to_element_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM element_marker    WHERE element_id = r.to_element_id
      UNION ALL SELECT 1 FROM element_route     WHERE element_id = r.to_element_id
      UNION ALL SELECT 1 FROM element_shape     WHERE element_id = r.to_element_id
      UNION ALL SELECT 1 FROM element_territory WHERE element_id = r.to_element_id)
UNION ALL
SELECT 'camera.follow_route', k.kf_id, k.follow_route_element_id
  FROM camera_keyframe k
  WHERE k.follow_route_element_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM element_route WHERE element_id = k.follow_route_element_id);

-- 12.3 疆域 JSON 内部一致性（复合外键被 JSON 化后，用 json_each 恢复部分校验）
CREATE VIEW IF NOT EXISTS v_check_territory_ref AS
SELECT t.element_id, p.value->>'ownerId' AS ref_id, '地块归属势力不存在' AS problem
  FROM element_territory t, json_each(t.plots_json) p
  WHERE t.plots_json IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM json_each(t.countries_json) c
                    WHERE c.value->>'countryId' = p.value->>'ownerId')
UNION ALL
SELECT t.element_id, e.value->>'toCountryId', '兼并事件目标势力不存在'
  FROM element_territory t, json_each(t.events_json) e
  WHERE t.events_json IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM json_each(t.countries_json) c
                    WHERE c.value->>'countryId' = e.value->>'toCountryId');

-- 用法：SELECT * FROM v_check_dangling;
--       SELECT * FROM v_check_territory_ref;

-- =============================================================================
-- 已知约束与设计取舍
-- =============================================================================
-- 1) 底图 / 高程图不入库：配置是代码内置常量，project 只存 id 字符串。
--    理由：配置数量固定、无需用户自定义，入库只会多出两张表与两处外键（还曾形成循环）。
-- 2) 【本版最大取舍】取消 element 基表后，跨表弱引用失去数据库级外键：
--    · connector.from/to（可指向任意类别元素）→ 应用层清理 + 自检视图
--    · element_keyframe 表已取消（关键帧内联进类别表 keyframes_json），不再有此弱引用
--    代价：写入侧需保证「先建元素、再建引用它的连接线 / 关键帧」，
--          且删除元素时要一并清理引用它的连接线与关键帧（无触发器兜底，见第 10 节）。
--    收益：元素表数量 14 → 4，模块边界与工具栏一致，读写路径更直观。
-- 3) 疆域内部实体（势力/地块/兼并事件）JSON 内联进 element_territory：
--    放弃了原先的复合外键与唯一约束，一致性改由 12.3 视图 + 应用层保证。
--    好处是疆域自包含、整体读写、无 4 次 JOIN。
-- 4) 类别宽表内用 type + CHECK 表达子类型必填项（类别内 STI）；
--    未选「每子类型一张表」是为了让表与工具栏按钮一一对应。
-- 5) element_keyframe.value_num 与 value_json 至少一列非空，由 CHECK 保证；
--    标量属性（opacity/scale/rotation/progress）走 value_num，morph 走 value_json。
-- 6) 大体积二进制一律进 asset（file 或 blob），业务表只存 asset_id，
--    避免项目 JSON base64 膨胀导致的「每次保存全量重写」。
-- 7) 布尔一律 INTEGER 0/1 + CHECK，不使用 SQLite 无类型的裸字段。
-- 8) JSON 列全部带 json_valid() 约束（SQLite 3.45+ 内置，node:sqlite 已满足）。
