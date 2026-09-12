-- =============================================================================
-- MapVideo V2 关系型数据库结构
-- 目标引擎：SQLite（桌面端 node:sqlite / DatabaseSync）；Dexie 端见报告第 6.4 节
-- 命名约定：表名与 TS 实体同名并转 snake_case（elementMarker ↔ element_marker），
--          主键统一 <实体>_id，时间统一 *_frame（帧）/ *_at（epoch ms）
-- 字符集：UTF-8；时间单位：帧（整数），基准帧率见 project.default_fps
-- 规模：21 张表 / 3 视图 / 6 触发器
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
--   AFTER DELETE 清理触发器 + 一致性自检视图兜底；跨类别列表查询用 v_element_index。
-- =============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- -----------------------------------------------------------------------------
-- 1. 合集与项目聚合根
-- -----------------------------------------------------------------------------

-- 合集：项目之上的一层分组。
--   · 默认合集 id 恒为 'default'（不可改名、不可删除），新建项目 / 导入未指定归属时落在这里
--   · 删合集只把其下项目移回默认合集（应用层先迁移再删，故用 RESTRICT 防误删）
CREATE TABLE IF NOT EXISTS collection (
  collection_id TEXT PRIMARY KEY,
  name          TEXT    NOT NULL,
  ord           INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project (
  project_id            TEXT PRIMARY KEY,
  name                  TEXT    NOT NULL,
  description           TEXT,
  -- 所属合集；缺省即默认合集（见上）
  collection_id         TEXT    NOT NULL DEFAULT 'default'
                        REFERENCES collection(collection_id) ON DELETE RESTRICT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,

  -- 地图投影：渲染方式，属于项目本身（随项目走，与内容类配置分离）
  projection            TEXT    NOT NULL DEFAULT 'mercator'
                        CHECK (projection IN ('mercator','globe')),

  -- 当前生效的底图 / 高程图：存内置配置的 id 字符串（如 'osm' / 'none'），配置本身在代码里
  active_base_map_id      TEXT,
  active_elevation_map_id TEXT
);

-- 项目级配置（GlobalConfig）：与 project 1:1，主键即外键。
--   职责分离：project 只保留身份 / 归属 / 审计字段，配置独立成表 ——
--   配置面板只读写这张表，互不干扰；新增配置项也不改动 project 结构。
CREATE TABLE IF NOT EXISTS project_config (
  project_id            TEXT PRIMARY KEY REFERENCES project(project_id) ON DELETE CASCADE,
  default_duration      INTEGER NOT NULL CHECK (default_duration > 0),
  default_fps           INTEGER NOT NULL CHECK (default_fps BETWEEN 1 AND 240),
  resolution_w          INTEGER NOT NULL CHECK (resolution_w > 0),
  resolution_h          INTEGER NOT NULL CHECK (resolution_h > 0),
  resolution_label      TEXT    NOT NULL,
  default_easing        TEXT    NOT NULL
);

-- -----------------------------------------------------------------------------
-- 2. 资源与素材
-- -----------------------------------------------------------------------------

-- 【底图 / 高程图不入库】
-- 它们是代码内置的常量配置（BUILTIN_BASE_MAPS / BUILTIN_ELEVATION_MAPS），
-- 项目与章节只保存所选配置的 id 字符串（project.active_base_map_id / chapter.base_map_id）。
-- 取舍：省掉两张表与两处外键（连带消除原本的循环外键问题）；
--       代价是底图 / 高程图配置不可由用户在运行时增删改。

-- 用户图标库：图标 / 图片 / SVG / 动图；ns 为命名空间，支持「可扩展图标库」
-- （内置 lucide / react-icons 不进库，用 element_marker.icon_lib + icon_name 引用；
--   用户自建库/上传的图标写这里，ns='custom' 或自定义库名）
CREATE TABLE IF NOT EXISTS custom_symbol (
  symbol_id  TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(project_id) ON DELETE CASCADE,
  name       TEXT NOT NULL,                                        -- 图标名（icon_name 引用它）
  ns         TEXT NOT NULL DEFAULT 'custom',                       -- 命名空间 / 自建库名
  kind       TEXT NOT NULL CHECK (kind IN ('icon','image','svg','gif')),
  asset_id   TEXT REFERENCES asset(asset_id) ON DELETE RESTRICT,   -- V2：外置存储
  url        TEXT,                                                -- 兼容外链
  width      INTEGER NOT NULL DEFAULT 64 CHECK (width  > 0),
  height     INTEGER NOT NULL DEFAULT 64 CHECK (height > 0),
  ord        INTEGER NOT NULL DEFAULT 0,
  CHECK (asset_id IS NOT NULL OR url IS NOT NULL),
  UNIQUE (project_id, ns, name)
);
CREATE INDEX IF NOT EXISTS ix_custom_symbol_project ON custom_symbol(project_id, ord);

-- 素材表：把 base64 dataURL 从项目 JSON 中剥离出来，是本次改造收益最大的一项
-- kind 新增 gif / model：模型（glb/gltf）与动图体积大，必须外置，绝不内联进项目 JSON
CREATE TABLE IF NOT EXISTS asset (
  asset_id      TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(project_id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('image','gif','model','audio','video','font')),
  mime          TEXT NOT NULL,
  byte_size     INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256        TEXT NOT NULL,             -- 内容寻址,支持同图去重
  storage       TEXT NOT NULL CHECK (storage IN ('file','blob')),
  rel_path      TEXT,                      -- storage='file'：相对 userData/assets/
  blob          BLOB,                      -- storage='blob'：小文件内联
  width         INTEGER,
  height        INTEGER,
  duration_ms   INTEGER,
  -- 媒体元信息（供 UI 预览与校验，避免为了取尺寸而先下载整个文件）
  --   model: { bbox:[minX,minY,minZ,maxX,maxY,maxZ], animations:[名], triangles:n }
  --   gif:   { frames:n, fps, loop:bool }
  meta_json     TEXT CHECK (meta_json IS NULL OR json_valid(meta_json)),
  created_at    INTEGER NOT NULL,
  CHECK ((storage = 'file' AND rel_path IS NOT NULL)
      OR (storage = 'blob' AND blob      IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_asset_content ON asset(project_id, sha256);
CREATE INDEX        IF NOT EXISTS ix_asset_kind    ON asset(project_id, kind);

-- -----------------------------------------------------------------------------
-- 3. 章节与时间轴
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chapter (
  chapter_id     TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES project(project_id) ON DELETE CASCADE,
  title          TEXT NOT NULL DEFAULT '',
  order_index    INTEGER NOT NULL DEFAULT 0,
  start_frame    INTEGER NOT NULL CHECK (start_frame >= 0),
  end_frame      INTEGER NOT NULL,
  base_map_id      TEXT,              -- 章节级覆盖：存内置底图 id，空则跟随项目
  elevation_map_id TEXT,              -- 同上
  title_style_json TEXT CHECK (title_style_json IS NULL OR json_valid(title_style_json)),
  transition_json  TEXT CHECK (transition_json  IS NULL OR json_valid(transition_json)),
  CHECK (end_frame > start_frame)
);
CREATE INDEX IF NOT EXISTS ix_chapter_project ON chapter(project_id, order_index);
CREATE UNIQUE INDEX IF NOT EXISTS ux_chapter_span ON chapter(project_id, start_frame);

-- 相机视角关键帧：frame 语义 = 「到达时间」（绝对帧），move_duration = 起飞提前量
CREATE TABLE IF NOT EXISTS camera_keyframe (
  kf_id            TEXT PRIMARY KEY,
  chapter_id       TEXT NOT NULL REFERENCES chapter(chapter_id) ON DELETE CASCADE,
  frame            INTEGER NOT NULL CHECK (frame >= 0),
  center_lng       REAL NOT NULL,
  center_lat       REAL NOT NULL,
  zoom             REAL NOT NULL,
  pitch            REAL,
  bearing          REAL,
  easing           TEXT,
  move_duration    INTEGER CHECK (move_duration IS NULL OR move_duration >= 0),
  camera_type      TEXT CHECK (camera_type IS NULL OR camera_type IN ('fixed','follow','orbit')),

  -- follow 视角：跟随目标只能是路线类元素（line / moving_point）
  -- 单列外键 + SET NULL：复合外键会连带清空 NOT NULL 的 chapter_id（见报告 5.6）
  follow_route_element_id TEXT REFERENCES element_route(element_id) ON DELETE SET NULL,
  follow_direction        INTEGER CHECK (follow_direction IS NULL OR follow_direction IN (0,1)),
  follow_start_frame      INTEGER,
  follow_end_frame        INTEGER,

  -- orbit 视角
  orbit_speed    REAL,
  orbit_duration REAL,
  ord            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_camera_kf_chapter ON camera_keyframe(chapter_id, frame);
CREATE INDEX IF NOT EXISTS ix_camera_kf_follow  ON camera_keyframe(follow_route_element_id);

-- -----------------------------------------------------------------------------
-- 4. 元素表（4 张类别宽表）
--    公共列（每张表都有）：element_id / chapter_id / type / name / visible /
--    locked / start_frame / end_frame / z_index / shape_category / anim_effect /
--    fly_mode / show_icon / move_icon_json / move_start_frame / move_end_frame /
--    uniform_move / point_times_json / label_json / ord
--    类别内子类型用 type 判别列 + CHECK 表达「该子类型必填项」。
-- -----------------------------------------------------------------------------

-- 5.1 标记类元素（Pin 工具）：point（点/文字/图标）· flag（旗标）· military_symbol（APP-6 军标）
CREATE TABLE IF NOT EXISTS element_marker (
  element_id     TEXT PRIMARY KEY,
  chapter_id     TEXT NOT NULL REFERENCES chapter(chapter_id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('point','flag','military_symbol')),

  name           TEXT NOT NULL DEFAULT '',
  visible        INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0,1)),
  locked         INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
  start_frame    INTEGER NOT NULL CHECK (start_frame >= 0),
  end_frame      INTEGER NOT NULL,
  z_index        INTEGER NOT NULL DEFAULT 0,
  shape_category TEXT CHECK (shape_category IS NULL OR shape_category IN ('multi','two','special','route')),
  anim_effect    TEXT CHECK (anim_effect IS NULL OR anim_effect IN ('grow','move','fill','march','marchplain')),
  fly_mode       INTEGER NOT NULL DEFAULT 0 CHECK (fly_mode IN (0,1)),
  show_icon      INTEGER NOT NULL DEFAULT 0 CHECK (show_icon IN (0,1)),
  move_icon_json TEXT CHECK (move_icon_json IS NULL OR json_valid(move_icon_json)),
  move_start_frame INTEGER,
  move_end_frame   INTEGER,
  uniform_move     INTEGER CHECK (uniform_move IS NULL OR uniform_move IN (0,1)),
  point_times_json TEXT CHECK (point_times_json IS NULL OR json_valid(point_times_json)),
  label_json     TEXT CHECK (label_json IS NULL OR json_valid(label_json)),  -- 原 element_label 内联
  ord            INTEGER NOT NULL DEFAULT 0,

  -- 位置（三类标记都落在单点）
  lng            REAL NOT NULL,
  lat            REAL NOT NULL,
  rotation       REAL,

  -- point 专属：视觉形态（9 种）+ 资源引用
  --   circle 圆点 · text 文字 · pin 水滴针 · bubble 气泡 · emoji 表情
  --   image 图片 · gif 动图 · model 3D 模型（three.js + custom layer）· icon 图标库（lucide / react-icons / 自建）
  shape          TEXT CHECK (shape IS NULL OR shape IN (
                   'circle','text','pin','bubble','emoji','image','gif','model','icon')),
  emoji          TEXT,
  scale          REAL CHECK (scale IS NULL OR (scale >= 0.3 AND scale <= 3)),
  orientation    TEXT CHECK (orientation IS NULL OR orientation IN ('faceCam','flat')),
  color          TEXT,                                                  -- 可着色形态的主色（model / gif 禁用）
  icon           TEXT,                                                  -- 历史内置图标名（兼容旧数据）
  icon_size      REAL,
  asset_id       TEXT REFERENCES asset(asset_id) ON DELETE SET NULL,    -- 用户上传的图片 / GIF / 模型
  builtin_id     TEXT,                                                  -- 内置资源 id（打包进应用、不入库）：'image:flag-red' / 'gif:radar' / 'model:drone' / 'icon:lucide:MapPin'
  icon_lib       TEXT,                                                  -- 图标库命名空间：lucide / react-icons/xxx / 自建库名
  icon_name      TEXT,                                                  -- 图标名（shape='icon' 时必填）
  visual_meta_json TEXT CHECK (visual_meta_json IS NULL OR json_valid(visual_meta_json)),  -- P3：表现参数
  --   image: { fit:'contain'|'cover', tintable:bool }
  --   gif:   { fps:n, loop:bool }
  --   model: { scale, altitude, autoRotate, spin, pitchAlign, animation }
  --   icon:  { strokeWidth }

  -- flag 专属
  flag_text      TEXT,
  flag_color     TEXT,
  flag_text_color TEXT,
  flag_font_size REAL,
  flag_width     REAL,

  -- military_symbol 专属
  sidc           TEXT,
  symbol_size    REAL,
  echelon        TEXT,
  symbol_label   TEXT,

  CHECK (end_frame >= start_frame),
  CHECK (move_end_frame IS NULL OR move_start_frame IS NULL OR move_end_frame > move_start_frame),
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
CREATE INDEX IF NOT EXISTS ix_marker_chapter ON element_marker(chapter_id, z_index, ord);
CREATE INDEX IF NOT EXISTS ix_marker_type    ON element_marker(chapter_id, type);
CREATE INDEX IF NOT EXISTS ix_marker_asset   ON element_marker(asset_id);

-- 5.2 路线类元素（Route 工具）：line（线/贝塞尔/大圆弧）· moving_point（移动点）·
--     connector（连接线，引用其它元素 → 弱引用 from/to）
CREATE TABLE IF NOT EXISTS element_route (
  element_id     TEXT PRIMARY KEY,
  chapter_id     TEXT NOT NULL REFERENCES chapter(chapter_id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('line','moving_point','connector')),

  name           TEXT NOT NULL DEFAULT '',
  visible        INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0,1)),
  locked         INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
  start_frame    INTEGER NOT NULL CHECK (start_frame >= 0),
  end_frame      INTEGER NOT NULL,
  z_index        INTEGER NOT NULL DEFAULT 0,
  shape_category TEXT CHECK (shape_category IS NULL OR shape_category IN ('multi','two','special','route')),
  anim_effect    TEXT CHECK (anim_effect IS NULL OR anim_effect IN ('grow','move','fill','march','marchplain')),
  fly_mode       INTEGER NOT NULL DEFAULT 0 CHECK (fly_mode IN (0,1)),
  show_icon      INTEGER NOT NULL DEFAULT 0 CHECK (show_icon IN (0,1)),
  move_icon_json TEXT CHECK (move_icon_json IS NULL OR json_valid(move_icon_json)),
  move_start_frame INTEGER,
  move_end_frame   INTEGER,
  uniform_move     INTEGER CHECK (uniform_move IS NULL OR uniform_move IN (0,1)),
  point_times_json TEXT CHECK (point_times_json IS NULL OR json_valid(point_times_json)),
  label_json     TEXT CHECK (label_json IS NULL OR json_valid(label_json)),
  ord            INTEGER NOT NULL DEFAULT 0,

  -- line / moving_point 路径（line_type=bezier 时为控制点，arc 时为大圆弧端点）
  coords_json       TEXT CHECK (coords_json IS NULL OR json_valid(coords_json)),

  -- line 专属
  line_width        REAL,
  line_color        TEXT,
  line_dash_json    TEXT CHECK (line_dash_json IS NULL OR json_valid(line_dash_json)),
  line_type         TEXT CHECK (line_type IS NULL OR line_type IN ('straight','bezier','arc')),
  line_arrow        INTEGER CHECK (line_arrow IS NULL OR line_arrow IN (0,1)),
  route_effect_json TEXT CHECK (route_effect_json IS NULL OR json_valid(route_effect_json)),
  flow_speed        REAL,
  plain_path        INTEGER CHECK (plain_path IS NULL OR plain_path IN (0,1)),
  front_style_json  TEXT CHECK (front_style_json IS NULL OR json_valid(front_style_json)),

  -- moving_point 专属（轨迹拖尾）
  trail_color       TEXT,
  trail_width       REAL,
  trail_length      INTEGER,

  -- connector 专属：端点弱引用（可指向任意类别元素，因元素已分表，无法建外键）
  from_element_id   TEXT,
  to_element_id     TEXT,
  animated          INTEGER CHECK (animated  IS NULL OR animated  IN (0,1)),
  arrowhead         INTEGER CHECK (arrowhead IS NULL OR arrowhead IN (0,1)),

  CHECK (end_frame >= start_frame),
  CHECK (move_end_frame IS NULL OR move_start_frame IS NULL OR move_end_frame > move_start_frame),
  CHECK (type <> 'line'         OR coords_json IS NOT NULL),
  CHECK (type <> 'moving_point' OR coords_json IS NOT NULL),
  CHECK (type <> 'connector'    OR (from_element_id IS NOT NULL AND to_element_id IS NOT NULL)),
  CHECK (from_element_id IS NULL OR to_element_id IS NULL OR from_element_id <> to_element_id)
);
CREATE INDEX IF NOT EXISTS ix_route_chapter ON element_route(chapter_id, z_index, ord);
CREATE INDEX IF NOT EXISTS ix_route_type    ON element_route(chapter_id, type);
-- 连接线端点：清理触发器按 from/to 反查，必须建索引（否则删元素时全表扫描）
CREATE INDEX IF NOT EXISTS ix_route_from    ON element_route(chapter_id, from_element_id);
CREATE INDEX IF NOT EXISTS ix_route_to      ON element_route(chapter_id, to_element_id);

-- 5.3 形状类元素（Shape 工具，含「区域」行政区高亮）：polygon · arrow · double_arrow ·
--     gathering（集结地）· encirclement（包围圈）
CREATE TABLE IF NOT EXISTS element_shape (
  element_id     TEXT PRIMARY KEY,
  chapter_id     TEXT NOT NULL REFERENCES chapter(chapter_id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('polygon','arrow','double_arrow','gathering','encirclement')),

  name           TEXT NOT NULL DEFAULT '',
  visible        INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0,1)),
  locked         INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
  start_frame    INTEGER NOT NULL CHECK (start_frame >= 0),
  end_frame      INTEGER NOT NULL,
  z_index        INTEGER NOT NULL DEFAULT 0,
  shape_category TEXT CHECK (shape_category IS NULL OR shape_category IN ('multi','two','special','route')),
  anim_effect    TEXT CHECK (anim_effect IS NULL OR anim_effect IN ('grow','move','fill','march','marchplain')),
  fly_mode       INTEGER NOT NULL DEFAULT 0 CHECK (fly_mode IN (0,1)),
  show_icon      INTEGER NOT NULL DEFAULT 0 CHECK (show_icon IN (0,1)),
  move_icon_json TEXT CHECK (move_icon_json IS NULL OR json_valid(move_icon_json)),
  move_start_frame INTEGER,
  move_end_frame   INTEGER,
  uniform_move     INTEGER CHECK (uniform_move IS NULL OR uniform_move IN (0,1)),
  point_times_json TEXT CHECK (point_times_json IS NULL OR json_valid(point_times_json)),
  label_json     TEXT CHECK (label_json IS NULL OR json_valid(label_json)),
  ord            INTEGER NOT NULL DEFAULT 0,

  -- polygon 专属
  rings_json         TEXT CHECK (rings_json IS NULL OR json_valid(rings_json)),
  fill_color         TEXT,
  fill_opacity       REAL CHECK (fill_opacity IS NULL OR fill_opacity BETWEEN 0 AND 1),
  stroke_color       TEXT,
  stroke_width       REAL,
  shape_kind         TEXT CHECK (shape_kind IS NULL OR shape_kind IN ('poly','rect','circle','star')),
  circle_meta_json   TEXT CHECK (circle_meta_json IS NULL OR json_valid(circle_meta_json)),
  rect_meta_json     TEXT CHECK (rect_meta_json   IS NULL OR json_valid(rect_meta_json)),
  star_meta_json     TEXT CHECK (star_meta_json   IS NULL OR json_valid(star_meta_json)),
  poly_curve         INTEGER CHECK (poly_curve IS NULL OR poly_curve IN (0,1)),
  defense_style_json TEXT CHECK (defense_style_json IS NULL OR json_valid(defense_style_json)),
  fill_gradient_json TEXT CHECK (fill_gradient_json IS NULL OR json_valid(fill_gradient_json)),

  -- arrow 专属
  from_lng       REAL,
  from_lat       REAL,
  to_lng         REAL,
  to_lat         REAL,
  path_json      TEXT CHECK (path_json IS NULL OR json_valid(path_json)),
  arrow_type     TEXT CHECK (arrow_type IS NULL OR arrow_type IN (
                   'swallowtail','simple','block','pincer','curved','curved-simple','attack','straight')),
  width          REAL,
  color          TEXT,
  draw_zoom      REAL,

  -- double_arrow 专属（钳形攻势）
  points_json    TEXT CHECK (points_json IS NULL OR json_valid(points_json)),

  -- gathering / encirclement 专属
  center_lng     REAL,
  center_lat     REAL,
  radius         REAL,
  pulse_animation INTEGER CHECK (pulse_animation IS NULL OR pulse_animation IN (0,1)),
  rotation       REAL,

  CHECK (end_frame >= start_frame),
  CHECK (move_end_frame IS NULL OR move_start_frame IS NULL OR move_end_frame > move_start_frame),
  CHECK (radius IS NULL OR radius > 0),
  CHECK (type <> 'polygon' OR rings_json IS NOT NULL),
  CHECK (type <> 'polygon' OR shape_kind IS NOT 'circle' OR circle_meta_json IS NOT NULL),
  CHECK (type <> 'polygon' OR shape_kind IS NOT 'rect'   OR rect_meta_json   IS NOT NULL),
  CHECK (type <> 'polygon' OR shape_kind IS NOT 'star'   OR star_meta_json   IS NOT NULL),
  CHECK (type <> 'arrow' OR arrow_type IS NOT NULL),
  CHECK (type <> 'arrow' OR (from_lng IS NOT NULL AND from_lat IS NOT NULL
                             AND to_lng IS NOT NULL AND to_lat IS NOT NULL)),
  CHECK (type <> 'double_arrow' OR points_json IS NOT NULL),
  CHECK (type <> 'gathering'    OR (center_lng IS NOT NULL AND center_lat IS NOT NULL AND radius IS NOT NULL)),
  CHECK (type <> 'encirclement' OR (center_lng IS NOT NULL AND center_lat IS NOT NULL AND radius IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_shape_chapter ON element_shape(chapter_id, z_index, ord);
CREATE INDEX IF NOT EXISTS ix_shape_type    ON element_shape(chapter_id, type);

-- 5.4 疆域类元素（Terr 工具）：势力 / 地块 / 兼并事件全部 JSON 内联
--     countries_json: [{ countryId, name, color, ord }]
--     plots_json:     [{ plotId, name, rings, ownerId, ord }]        rings = GeoJSON 环数组
--     events_json:    [{ eventId, frame, toCountryId, preset, duration, highlight, plotIds[], ord }]
CREATE TABLE IF NOT EXISTS element_territory (
  element_id     TEXT PRIMARY KEY,
  chapter_id     TEXT NOT NULL REFERENCES chapter(chapter_id) ON DELETE CASCADE,
  type           TEXT NOT NULL DEFAULT 'territory' CHECK (type = 'territory'),

  name           TEXT NOT NULL DEFAULT '',
  visible        INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0,1)),
  locked         INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
  start_frame    INTEGER NOT NULL CHECK (start_frame >= 0),
  end_frame      INTEGER NOT NULL,
  z_index        INTEGER NOT NULL DEFAULT 0,
  anim_effect    TEXT CHECK (anim_effect IS NULL OR anim_effect IN ('grow','move','fill','march','marchplain')),
  label_json     TEXT CHECK (label_json IS NULL OR json_valid(label_json)),
  ord            INTEGER NOT NULL DEFAULT 0,

  display_json   TEXT NOT NULL CHECK (json_valid(display_json)),   -- 显示配置：边界/线宽/透明度/标签
  countries_json TEXT CHECK (countries_json IS NULL OR json_valid(countries_json)),
  plots_json     TEXT CHECK (plots_json     IS NULL OR json_valid(plots_json)),
  events_json    TEXT CHECK (events_json    IS NULL OR json_valid(events_json)),

  CHECK (end_frame >= start_frame)
);
CREATE INDEX IF NOT EXISTS ix_territory_chapter ON element_territory(chapter_id, z_index, ord);

-- -----------------------------------------------------------------------------
-- 5. 元素附属：动画关键帧
--    ★ 取消了 element 基表后，关键帧无法用外键指向「四张表之一」，故为弱引用：
--      element_id 不加外键，元素删除时由 AFTER DELETE 清理触发器（第 11 节）删除；
--      chapter_id 仍保留外键，保证「删章节」能级联清掉本章关键帧。
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS element_keyframe (
  kf_id       TEXT PRIMARY KEY,
  element_id  TEXT NOT NULL,                     -- 弱引用（元素分属 4 张表）
  element_type TEXT NOT NULL CHECK (element_type IN (
                'point','flag','military_symbol',
                'line','moving_point','connector',
                'polygon','arrow','double_arrow','gathering','encirclement',
                'territory')),
  chapter_id  TEXT NOT NULL REFERENCES chapter(chapter_id) ON DELETE CASCADE,
  property    TEXT NOT NULL CHECK (property IN (
                'opacity','scale','rotation','draw_progress','progress',
                'path_progress','fill_progress','morph')),
  frame       INTEGER NOT NULL CHECK (frame >= 0),
  easing      TEXT,
  value_num   REAL,                                    -- 标量快路径
  value_json  TEXT CHECK (value_json IS NULL OR json_valid(value_json)),  -- morph 用 rings
  ord         INTEGER NOT NULL DEFAULT 0,
  CHECK (value_num IS NOT NULL OR value_json IS NOT NULL),
  UNIQUE (element_id, property, frame)
);
CREATE INDEX IF NOT EXISTS ix_element_kf   ON element_keyframe(element_id, property, frame);
CREATE INDEX IF NOT EXISTS ix_element_kf_ch ON element_keyframe(chapter_id);

-- -----------------------------------------------------------------------------
-- 6. 叠加层（弹出元素）
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS overlay (
  overlay_id   TEXT PRIMARY KEY,
  chapter_id   TEXT NOT NULL REFERENCES chapter(chapter_id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN (
                 'custom','chart','person','report','timeline','quote','compare',
                 'counter','dialogue','place')),
  name         TEXT NOT NULL DEFAULT '',
  position     TEXT NOT NULL CHECK (position IN (
                 'top','bottom','left','right','center',
                 'topLeft','topRight','bottomLeft','bottomRight')),
  start_frame  INTEGER NOT NULL CHECK (start_frame >= 0),
  end_frame    INTEGER NOT NULL,
  animation      TEXT,
  exit_animation TEXT,
  scale        REAL,
  offset_x     REAL NOT NULL DEFAULT 0,
  offset_y     REAL NOT NULL DEFAULT 0,
  z_index      INTEGER NOT NULL DEFAULT 0,
  bg_json      TEXT CHECK (bg_json IS NULL OR json_valid(bg_json)),
  -- P3：report/quote/compare/counter/place/chart 等固定形状载荷整体存取
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  -- person 布局 + 整卡语音
  person_layout_json TEXT CHECK (person_layout_json IS NULL OR json_valid(person_layout_json)),
  audio_asset_id TEXT REFERENCES asset(asset_id) ON DELETE SET NULL,
  parent_overlay_id TEXT REFERENCES overlay(overlay_id) ON DELETE CASCADE,  -- 兼容旧 group 嵌套
  ord          INTEGER NOT NULL DEFAULT 0,
  CHECK (end_frame >= start_frame)
);
CREATE INDEX IF NOT EXISTS ix_overlay_chapter ON overlay(chapter_id, start_frame);
CREATE INDEX IF NOT EXISTS ix_overlay_parent  ON overlay(parent_overlay_id);

-- custom 类型的内容块（文字/图片/视频纵向堆叠）
CREATE TABLE IF NOT EXISTS overlay_block (
  block_id   TEXT PRIMARY KEY,
  overlay_id TEXT NOT NULL REFERENCES overlay(overlay_id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('text','image','video')),
  text_content TEXT,
  font_size  REAL,
  color      TEXT,
  bold       INTEGER CHECK (bold IS NULL OR bold IN (0,1)),
  align      TEXT CHECK (align IS NULL OR align IN ('left','center','right')),
  asset_id   TEXT REFERENCES asset(asset_id) ON DELETE SET NULL,
  url        TEXT,
  ord        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_overlay_block ON overlay_block(overlay_id, ord);

-- person 类型的人物卡内容块（5 类固定槽位）
CREATE TABLE IF NOT EXISTS person_block (
  block_id   TEXT PRIMARY KEY,
  overlay_id TEXT NOT NULL REFERENCES overlay(overlay_id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('image','name','intro','quote','dialogue')),
  show       INTEGER NOT NULL DEFAULT 1 CHECK (show IN (0,1)),
  text       TEXT,
  asset_id   TEXT REFERENCES asset(asset_id) ON DELETE SET NULL,
  image_size REAL CHECK (image_size IS NULL OR (image_size >= 60 AND image_size <= 360)),
  mask       TEXT CHECK (mask IS NULL OR mask IN ('none','bottom','top','circle','feather')),
  ord        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_person_block ON person_block(overlay_id, ord);

-- -----------------------------------------------------------------------------
-- 7. 章节级特效 / 字幕 / 配乐
-- -----------------------------------------------------------------------------

-- ChapterEffect 判别联合：三个分支字段并入一张表，靠 type 约束分支必填项
CREATE TABLE IF NOT EXISTS chapter_fx (
  fx_id      TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapter(chapter_id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('cursor_track','focus_glow','scan_line')),
  path_json  TEXT CHECK (path_json IS NULL OR json_valid(path_json)),
  color      TEXT,
  frame_step INTEGER,
  center_lng REAL,
  center_lat REAL,
  radius     REAL,
  direction  TEXT CHECK (direction IS NULL OR direction IN ('horizontal','vertical')),
  ord        INTEGER NOT NULL DEFAULT 0,
  CHECK (type IS NOT 'scan_line' OR direction IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_chapter_fx ON chapter_fx(chapter_id, ord);

-- 特效窗口：天气 / 画面特效（屏幕空间），两分支字段并存
CREATE TABLE IF NOT EXISTS screen_fx (
  fx_id      TEXT PRIMARY KEY,
  chapter_id TEXT NOT NULL REFERENCES chapter(chapter_id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('weather','screen')),
  name       TEXT NOT NULL DEFAULT '',
  start_frame INTEGER NOT NULL CHECK (start_frame >= 0),
  end_frame   INTEGER NOT NULL,
  weather_type TEXT CHECK (weather_type IS NULL OR weather_type IN ('rain','snow','lightning','fog')),
  intensity  REAL CHECK (intensity IS NULL OR intensity BETWEEN 0 AND 1),
  wind       REAL CHECK (wind IS NULL OR wind BETWEEN -1 AND 1),
  effect_type TEXT CHECK (effect_type IS NULL OR effect_type IN (
                'shake','flash','vignette','cloudReveal','fadeBlack','fadeWhite')),
  effect_color TEXT,
  enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  ord        INTEGER NOT NULL DEFAULT 0,
  CHECK (end_frame >= start_frame),
  CHECK ((kind = 'weather' AND weather_type IS NOT NULL)
      OR (kind = 'screen'  AND effect_type  IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS ix_screen_fx ON screen_fx(chapter_id, start_frame);

-- 字幕档：1:1 持有样式；字幕条 1:N
CREATE TABLE IF NOT EXISTS narration (
  chapter_id TEXT PRIMARY KEY REFERENCES chapter(chapter_id) ON DELETE CASCADE,
  style_json TEXT NOT NULL CHECK (json_valid(style_json))
);

CREATE TABLE IF NOT EXISTS narration_entry (
  entry_id      TEXT PRIMARY KEY,
  chapter_id    TEXT NOT NULL REFERENCES chapter(chapter_id) ON DELETE CASCADE,
  text          TEXT NOT NULL DEFAULT '',
  audio_asset_id TEXT REFERENCES asset(asset_id) ON DELETE SET NULL,
  duration_frames INTEGER NOT NULL CHECK (duration_frames >= 1),
  start_frame     INTEGER NOT NULL CHECK (start_frame >= 0),
  locked        INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0,1)),
  status        TEXT CHECK (status IS NULL OR status IN ('none','pending','ready','error')),
  error         TEXT,
  ord           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_narration_entry ON narration_entry(chapter_id, start_frame);

CREATE TABLE IF NOT EXISTS music_track (
  track_id      TEXT PRIMARY KEY,
  chapter_id    TEXT NOT NULL REFERENCES chapter(chapter_id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT '',
  audio_asset_id TEXT REFERENCES asset(asset_id) ON DELETE SET NULL,
  start_frame   INTEGER NOT NULL CHECK (start_frame >= 0),
  end_frame     INTEGER NOT NULL,
  volume        REAL NOT NULL DEFAULT 1 CHECK (volume BETWEEN 0 AND 1),
  loop          INTEGER NOT NULL DEFAULT 0 CHECK (loop IN (0,1)),
  fade_in       REAL NOT NULL DEFAULT 0 CHECK (fade_in  >= 0),
  fade_out      REAL NOT NULL DEFAULT 0 CHECK (fade_out >= 0),
  ord           INTEGER NOT NULL DEFAULT 0,
  CHECK (end_frame >= start_frame)
);
CREATE INDEX IF NOT EXISTS ix_music_track ON music_track(chapter_id, start_frame);

-- -----------------------------------------------------------------------------
-- 8. 应用配置聚合（与项目内容解耦，Key 只存本机）
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS provider (
  provider_id TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('llm','tts')),
  label      TEXT NOT NULL DEFAULT '',
  base_url   TEXT NOT NULL DEFAULT '',
  api_key    TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  protocol   TEXT CHECK (protocol IS NULL OR protocol IN (
               'openai-speech','minimax-t2a','volc-tts','qwen-tts','custom')),
  voice      TEXT,
  speed      REAL NOT NULL DEFAULT 1 CHECK (speed BETWEEN 0.5 AND 2),
  extra      TEXT CHECK (extra IS NULL OR json_valid(extra)),
  active     INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  ord        INTEGER NOT NULL DEFAULT 0
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
CREATE INDEX IF NOT EXISTS ix_custom_symbol_asset  ON custom_symbol(asset_id);
CREATE INDEX IF NOT EXISTS ix_overlay_audio_asset  ON overlay(audio_asset_id);
CREATE INDEX IF NOT EXISTS ix_overlay_block_asset   ON overlay_block(asset_id);
CREATE INDEX IF NOT EXISTS ix_person_block_asset    ON person_block(asset_id);
CREATE INDEX IF NOT EXISTS ix_narration_audio_asset ON narration_entry(audio_asset_id);
CREATE INDEX IF NOT EXISTS ix_music_audio_asset     ON music_track(audio_asset_id);
-- 注：element_marker(asset_id) 的索引见 5.1（ix_marker_asset）

-- ② 元素关键帧：FK 指向 chapter，删章节时避免扫描
--    （element_id 是弱引用、无 FK，索引 ix_element_kf 见第 6 节）

-- ③ 底图 / 高程图 / 合集被引用（删父行走 SET NULL / RESTRICT，低频但同样应避免扫描）
CREATE INDEX IF NOT EXISTS ix_project_collection   ON project(collection_id);
-- 注：底图 / 高程图列已不是外键（配置在代码里），无需外键支撑索引

-- =============================================================================
-- 10. 完整性触发器
-- =============================================================================

-- 11.1 跟随机位必须引用同一章节内的路线元素
--      （不能改用复合外键：SET NULL 会连带清空 NOT NULL 的 chapter_id）
CREATE TRIGGER IF NOT EXISTS trg_camera_follow_chapter_ins
BEFORE INSERT ON camera_keyframe
WHEN NEW.follow_route_element_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM element_route
                 WHERE element_id = NEW.follow_route_element_id
                   AND chapter_id = NEW.chapter_id)
BEGIN
  SELECT RAISE(ABORT, 'follow_route_element_id 必须属于同一章节的路线元素');
END;

CREATE TRIGGER IF NOT EXISTS trg_camera_follow_chapter_upd
BEFORE UPDATE OF follow_route_element_id ON camera_keyframe
WHEN NEW.follow_route_element_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM element_route
                 WHERE element_id = NEW.follow_route_element_id
                   AND chapter_id = NEW.chapter_id)
BEGIN
  SELECT RAISE(ABORT, 'follow_route_element_id 必须属于同一章节的路线元素');
END;

-- 11.2 跨表弱引用的反向清理（补偿「没有 element 基表 → 复合外键 CASCADE 不可用」）
--      删除任一元素时：
--        · 删掉以它为端点的连接线（connector）行
--        · 删掉它自己的动画关键帧
--      用 AFTER DELETE：若被删的是连接线自身，下方 DELETE 命中 0 行；
--      recursive_triggers 默认关闭，不会递归。
CREATE TRIGGER IF NOT EXISTS trg_marker_cleanup
AFTER DELETE ON element_marker
BEGIN
  DELETE FROM element_route
   WHERE type = 'connector'
     AND (from_element_id = OLD.element_id OR to_element_id = OLD.element_id);
  DELETE FROM element_keyframe WHERE element_id = OLD.element_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_route_cleanup
AFTER DELETE ON element_route
BEGIN
  DELETE FROM element_route
   WHERE type = 'connector'
     AND (from_element_id = OLD.element_id OR to_element_id = OLD.element_id);
  DELETE FROM element_keyframe WHERE element_id = OLD.element_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_shape_cleanup
AFTER DELETE ON element_shape
BEGIN
  DELETE FROM element_route
   WHERE type = 'connector'
     AND (from_element_id = OLD.element_id OR to_element_id = OLD.element_id);
  DELETE FROM element_keyframe WHERE element_id = OLD.element_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_territory_cleanup
AFTER DELETE ON element_territory
BEGIN
  DELETE FROM element_route
   WHERE type = 'connector'
     AND (from_element_id = OLD.element_id OR to_element_id = OLD.element_id);
  DELETE FROM element_keyframe WHERE element_id = OLD.element_id;
END;

-- =============================================================================
-- 11. 视图
-- =============================================================================

-- 12.1 跨类别元素索引：取消基表后，轨道 / 列表 / 计数查这里，不必手写 4 表 UNION
CREATE VIEW IF NOT EXISTS v_element_index AS
SELECT 'marker' AS category, element_id, chapter_id, type, name, visible, locked,
       start_frame, end_frame, z_index, ord
  FROM element_marker
UNION ALL
SELECT 'route', element_id, chapter_id, type, name, visible, locked,
       start_frame, end_frame, z_index, ord
  FROM element_route
UNION ALL
SELECT 'shape', element_id, chapter_id, type, name, visible, locked,
       start_frame, end_frame, z_index, ord
  FROM element_shape
UNION ALL
SELECT 'territory', element_id, chapter_id, type, name, visible, locked,
       start_frame, end_frame, z_index, ord
  FROM element_territory;

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
SELECT 'keyframe.element', k.kf_id, k.element_id
  FROM element_keyframe k
  WHERE NOT EXISTS (
      SELECT 1 FROM element_marker    WHERE element_id = k.element_id
      UNION ALL SELECT 1 FROM element_route     WHERE element_id = k.element_id
      UNION ALL SELECT 1 FROM element_shape     WHERE element_id = k.element_id
      UNION ALL SELECT 1 FROM element_territory WHERE element_id = k.element_id)
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
-- 1) 底图 / 高程图不入库：配置是代码内置常量，project / chapter 只存 id 字符串。
--    理由：配置数量固定、无需用户自定义，入库只会多出两张表与两处外键（还曾形成循环）。
-- 2) 【本版最大取舍】取消 element 基表后，跨表弱引用失去数据库级外键：
--    · connector.from/to（可指向任意类别元素）→ 靠 11.2 清理触发器 + 12.2 自检视图
--    · element_keyframe.element_id        → 同上
--    代价：写入侧需应用层保证「先建元素、再建引用它的连接线/关键帧」。
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
