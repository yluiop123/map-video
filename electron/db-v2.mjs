/**
 * 桌面端 V2 关系型库：DDL 执行 + 多表 ↔ MapVideoProject 双向 mapper。
 * DDL 唯一事实源：docs/db-schema-v2.sql。
 *
 * 时间约定：表内存秒（REAL），运行时 MapVideoProject 用帧；fps = globalConfig.defaultFPS。
 * 元素按类别拆表：point/flag/military_symbol→element_marker；line/moving_point/connector→element_route；
 * polygon/arrow/double_arrow/gathering/encirclement→element_shape；territory→element_territory。
 * 仅「坐标集合」等变长数据保留 JSON 列；标签 / 移动标记 / 表现参数已平铺为列。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 依次尝试 dev（cwd）/ 打包（electron 同级）/ resources 三种位置的 DDL */
export function resolveDdlPath() {
  const candidates = [
    path.join(process.cwd(), 'docs', 'db-schema-v2.sql'),
    path.join(HERE, '..', 'docs', 'db-schema-v2.sql'),
    path.join(process.resourcesPath || '', 'docs', 'db-schema-v2.sql'),
    path.join(process.resourcesPath || '', 'app', 'docs', 'db-schema-v2.sql'),
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* 忽略 */ }
  }
  return null;
}

/** 建 V2 表 / 索引 / 视图（幂等；DDL 全部 IF NOT EXISTS）。返回是否成功。 */
export function ensureV2Schema(db) {
  const ddlPath = resolveDdlPath();
  if (!ddlPath) {
    console.warn('[db-v2] 未找到 docs/db-schema-v2.sql，跳过 V2 建表');
    return false;
  }
  // 旧版遗留表（已被 V2 取代 / 功能已删除，直接清掉）：
  //   collections → collection；projects → project；transition_event（转场功能已删除）
  for (const t of ['collections', 'projects', 'transition_event']) {
    try { db.exec(`DROP TABLE IF EXISTS ${t}`); } catch { /* 忽略 */ }
  }
  // 旧版为「章节级」结构（存在 chapter 表）——项目已改为单条连续时间线，结构整体变化。
  // 按「不做向后兼容」约定：直接丢弃时间轴 / 元素相关表并重建（collection / asset 保留）。
  try {
    const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chapter'").get();
    if (legacy) {
      try { db.exec('PRAGMA foreign_keys = OFF'); } catch { /* 忽略 */ }
      for (const t of ['chapter', 'camera_keyframe', 'screen_fx', 'overlay', 'narration', 'narration_entry',
        'element_marker', 'element_route', 'element_shape', 'element_territory', 'element_image', 'music_track', 'project', 'projects']) {
        try { db.exec(`DROP TABLE IF EXISTS ${t}`); } catch { /* 忽略 */ }
      }
      for (const v of ['v_element_index', 'v_check_dangling', 'v_check_territory_ref']) {
        try { db.exec(`DROP VIEW IF EXISTS ${v}`); } catch { /* 忽略 */ }
      }
      try { db.exec('PRAGMA foreign_keys = ON'); } catch { /* 忽略 */ }
      console.log('[db-v2] 检测到旧章节级结构，已丢弃时间轴/元素/旧 projects 表并重建（项目=单条连续时间线）');
    }
  } catch { /* 忽略 */ }
  try {
    const ddl = fs.readFileSync(ddlPath, 'utf8');
    // 先给旧表补缺失列（CREATE TABLE IF NOT EXISTS 不会改已存在的表）；
    // 必须早于 db.exec(ddl)：视图引用了新列（layer_id），旧表缺列会让整段 DDL 失败。
    ensureAllColumns(db, ddl);
    // 视图每次重建（引用列可能变化；IF NOT EXISTS 不会更新旧定义）
    db.exec('DROP VIEW IF EXISTS v_element_index; DROP VIEW IF EXISTS v_check_dangling; DROP VIEW IF EXISTS v_check_territory_ref;');
    db.exec(ddl);
    return true;
  } catch (e) {
    console.error('[db-v2] V2 DDL 执行失败:', e?.message || e);
    return false;
  }
}

/**
 * 解析 DDL 各表的列定义（列名 → 类型，忽略表级约束），用于给旧库补齐新增列。
 * CREATE TABLE IF NOT EXISTS 不会改已存在的表，所以新增列需在此自动 ALTER。
 */
function ddlTableColumns(ddl) {
  const map = new Map();
  const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(ddl))) {
    const body = m[2].replace(/--[^\n]*/g, ''); // 去注释
    const cols = {};
    let buf = '';
    let depth = 0;
    const flush = () => {
      const line = buf.trim();
      buf = '';
      if (!line) return;
      const first = line.split(/\s+/)[0];
      if (/^(PRIMARY|CHECK|FOREIGN|UNIQUE|CONSTRAINT)$/i.test(first)) return;
      if (!/^[a-z_][a-z0-9_]*$/i.test(first)) return;
      const type = (line.slice(first.length).trim().split(/\s+/)[0] || 'TEXT').toUpperCase();
      // 类型必须是常见 SQL 类型，避免把表级/续行误判成列
      if (/^[A-Z]+$/.test(type) && !/^(ON|OR|AND|IN|NULL|NOT|DEFAULT|CHECK|REFERENCES)$/.test(type)) {
        cols[first] = type;
      }
    };
    for (const ch of body) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { flush(); continue; }
      buf += ch;
    }
    flush();
    map.set(m[1], cols);
  }
  return map;
}

/** 对比实库与 DDL：给旧表补齐缺失的列（只加列，不加约束，保持幂等） */
function ensureAllColumns(db, ddl) {
  for (const [table, cols] of ddlTableColumns(ddl)) {
    let have;
    try { have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)); }
    catch { continue; }
    if (!have.size) continue;
    for (const [col, type] of Object.entries(cols)) {
      if (have.has(col)) continue;
      try {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type || 'TEXT'}`);
        console.log(`[db-v2] 补列 ${table}.${col}`);
      } catch (e) {
        console.warn(`[db-v2] 补列失败 ${table}.${col}:`, e?.message || e);
      }
    }
  }
}

// ---------- 小工具 ----------
const n = (v) => (v === undefined ? null : v);
const j = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const b = (v) => (v === undefined || v === null ? null : (v ? 1 : 0));
const bit = (v) => v === 1 || v === true;
const J = (s, dflt) => { try { return s == null ? dflt : JSON.parse(s); } catch { return dflt; } };

const ELEMENT_CATEGORY = {
  point: 'marker', flag: 'marker', military_symbol: 'marker',
  line: 'route', moving_point: 'route', connector: 'route',
  polygon: 'shape', arrow: 'shape', double_arrow: 'shape', gathering: 'shape', encirclement: 'shape',
  territory: 'territory',
  geo_image: 'image',
};

/** 标签 → 列（label_*） */
function labelCols(l) {
  if (!l) return {};
  return {
    label_text: n(l.text), label_font_size: n(l.fontSize), label_color: n(l.color),
    label_position: n(l.position), label_offset_x: n(l.offsetX), label_offset_y: n(l.offsetY),
    label_bg_color: n(l.bgColor), label_bg_padding: n(l.bgPadding), label_bg_radius: n(l.bgRadius),
    label_font_weight: n(l.fontWeight),
  };
}
function colsToLabel(r) {
  if (r.label_text == null && r.label_color == null && r.label_bg_color == null && r.label_position == null) return undefined;
  return {
    text: r.label_text ?? '', fontSize: r.label_font_size ?? undefined, color: r.label_color ?? undefined,
    position: r.label_position ?? undefined, offsetX: r.label_offset_x ?? undefined, offsetY: r.label_offset_y ?? undefined,
    bgColor: r.label_bg_color ?? undefined, bgPadding: r.label_bg_padding ?? undefined,
    bgRadius: r.label_bg_radius ?? undefined, fontWeight: r.label_font_weight ?? undefined,
  };
}

/** 移动标记 → 列（move_icon_*） */
function moveIconCols(mi) {
  if (!mi) return {};
  return {
    move_icon_shape: n(mi.shape), move_icon_color: n(mi.color), move_icon_emoji: n(mi.emoji), move_icon_scale: n(mi.scale),
    move_icon_label_text: n(mi.labelText), move_icon_label_color: n(mi.labelColor), move_icon_label_bg: n(mi.labelBg),
    move_icon_label_size: n(mi.labelSize), move_icon_label_padding: n(mi.labelPadding), move_icon_label_radius: n(mi.labelRadius),
    move_icon_label_pos: n(mi.labelPos), move_icon_label_offset_x: n(mi.labelOffsetX), move_icon_label_offset_y: n(mi.labelOffsetY),
    move_icon_flag_text: n(mi.flagText), move_icon_flag_color: n(mi.flagColor),
    move_icon_builtin_id: n(mi.builtinId), move_icon_asset_id: n(mi.assetId),
    move_icon_icon_lib: n(mi.iconLib), move_icon_icon_name: n(mi.iconName),
    move_icon_orientation: n(mi.orientation), move_icon_rotation: n(mi.rotation), move_icon_show_label: b(mi.showLabel),
  };
}
function colsToMoveIcon(r) {
  if (r.move_icon_shape == null && r.move_icon_color == null && r.move_icon_asset_id == null && r.move_icon_label_text == null) return undefined;
  const mi = {
    shape: r.move_icon_shape ?? undefined, color: r.move_icon_color ?? undefined, emoji: r.move_icon_emoji ?? undefined,
    scale: r.move_icon_scale ?? undefined, labelText: r.move_icon_label_text ?? undefined, labelColor: r.move_icon_label_color ?? undefined,
    labelBg: r.move_icon_label_bg ?? undefined, labelSize: r.move_icon_label_size ?? undefined,
    labelPadding: r.move_icon_label_padding ?? undefined, labelRadius: r.move_icon_label_radius ?? undefined,
    labelPos: r.move_icon_label_pos ?? undefined, labelOffsetX: r.move_icon_label_offset_x ?? undefined,
    labelOffsetY: r.move_icon_label_offset_y ?? undefined, flagText: r.move_icon_flag_text ?? undefined,
    flagColor: r.move_icon_flag_color ?? undefined, builtinId: r.move_icon_builtin_id ?? undefined,
    assetId: r.move_icon_asset_id ?? undefined, iconLib: r.move_icon_icon_lib ?? undefined,
    iconName: r.move_icon_icon_name ?? undefined, orientation: r.move_icon_orientation ?? undefined,
    rotation: r.move_icon_rotation ?? undefined, showLabel: r.move_icon_show_label == null ? undefined : bit(r.move_icon_show_label),
  };
  return mi;
}

const VISUAL_COLS = ['fit', 'tintable', 'fps', 'loop', 'altitude', 'auto_rotate', 'spin', 'pitch_align', 'animation', 'stroke_width'];
function visualCols(vm) {
  if (!vm) return {};
  return {
    visual_fit: n(vm.fit), visual_tintable: b(vm.tintable), visual_fps: n(vm.fps), visual_loop: b(vm.loop),
    visual_altitude: n(vm.altitude), visual_auto_rotate: n(vm.autoRotate), visual_spin: n(vm.spin),
    visual_pitch_align: b(vm.pitchAlign), visual_animation: n(vm.animation), visual_stroke_width: n(vm.strokeWidth),
  };
}
function colsToVisual(r) {
  if (VISUAL_COLS.every((k) => r[`visual_${k}`] == null)) return undefined;
  return {
    fit: r.visual_fit ?? undefined, tintable: r.visual_tintable == null ? undefined : bit(r.visual_tintable),
    fps: r.visual_fps ?? undefined, loop: r.visual_loop == null ? undefined : bit(r.visual_loop),
    altitude: r.visual_altitude ?? undefined, autoRotate: r.visual_auto_rotate ?? undefined,
    spin: r.visual_spin ?? undefined, pitchAlign: r.visual_pitch_align == null ? undefined : bit(r.visual_pitch_align),
    animation: r.visual_animation ?? undefined, strokeWidth: r.visual_stroke_width ?? undefined,
  };
}

/** 元素动画关键帧 → keyframes_json（帧→秒；标量走 value_json，morph 存坐标数组） */
function kfsToJson(el, f2s) {
  const out = [];
  const push = (property, arr) => { for (const k of arr || []) out.push({ property, sec: f2s(k.frame), easing: k.easing, value_json: k.value }); };
  push('opacity', el.style?.opacity);
  push('scale', el.style?.scale);
  push('rotation', el.style?.rotation);
  push('draw_progress', el.drawProgress);
  push('progress', el.progress);
  push('path_progress', el.pathProgress);
  push('fill_progress', el.fillProgress);
  for (const m of el.morphKeyframes || []) out.push({ property: 'morph', sec: f2s(m.frame), easing: m.easing, value_json: m.coordinates });
  return out.length ? JSON.stringify(out) : null;
}
function jsonToKfs(json, s2f) {
  const style = {};
  const drawProgress = []; const progress = []; const pathProgress = []; const fillProgress = []; const morphKeyframes = [];
  for (const k of J(json, [])) {
    const frame = s2f(k.sec);
    const kf = { frame, value: k.value_json, easing: k.easing };
    switch (k.property) {
      case 'opacity': case 'scale': case 'rotation': (style[k.property] ||= []).push(kf); break;
      case 'draw_progress': drawProgress.push(kf); break;
      case 'progress': progress.push(kf); break;
      case 'path_progress': pathProgress.push(kf); break;
      case 'fill_progress': fillProgress.push(kf); break;
      case 'morph': morphKeyframes.push({ frame, coordinates: k.value_json, easing: k.easing }); break;
    }
  }
  return { style, drawProgress, progress, pathProgress, fillProgress, morphKeyframes };
}

// ---------- 保存 ----------
export function saveProjectV2(db, project) {
  const fps = project.globalConfig?.defaultFPS || 30;
  const f2s = (f) => (typeof f === 'number' ? f / fps : 0);
  const now = Date.now();
  const gc = project.globalConfig || {};

  db.exec('BEGIN');
  try {
    // 清掉旧子行（chapter CASCADE 会连带 element/overlay/...）
    db.prepare('DELETE FROM project WHERE project_id = ?').run(project.id);

    // 保证所属合集在 V2 collection 表存在（否则 project.collection_id 外键失败）。
    // 合集名以旧 collections 表为准，这里仅补一行满足外键（表名不同：collection vs collections）。
    const collectionId = project.collectionId || 'default';
    db.prepare('INSERT OR IGNORE INTO collection (collection_id, name, ord, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(collectionId, '', 0, now, now);

    // 素材占位：元素/移动标记引用的 assetId 在当前桌面端是文件式存储、不在 V2 asset 表，
    // 为保证 FK 通过，先插入占位行（读取时不依赖 asset 表）。
    const assetIds = new Set();
    for (const el of project.elements || []) {
      if (el.assetId) assetIds.add(el.assetId);
      if (el.moveIcon?.assetId) assetIds.add(el.moveIcon.assetId);
    }
    if (assetIds.size) {
      const insAsset = db.prepare('INSERT OR IGNORE INTO asset (asset_id,kind,name,mime,storage,rel_path,created_at) VALUES (?,?,?,?,?,?,?)');
      for (const a of assetIds) insAsset.run(a, 'image', '', 'application/octet-stream', 'file', '', now);
    }

    db.prepare(`INSERT INTO project (
      project_id, name, description, collection_id, created_at, updated_at, projection,
      active_base_map_id, active_elevation_map_id, default_duration_sec, default_fps,
      resolution_w, resolution_h, default_easing, elevation_exaggeration, end_sec
    ) VALUES (@project_id,@name,@description,@collection_id,@created_at,@updated_at,@projection,
      @active_base_map_id,@active_elevation_map_id,@default_duration_sec,@default_fps,
      @resolution_w,@resolution_h,@default_easing,@elevation_exaggeration,@end_sec)`).run({
      project_id: project.id, name: project.name || '未命名', description: n(project.description),
      collection_id: project.collectionId || 'default',
      created_at: new Date(project.createdAt || now).getTime(), updated_at: now,
      projection: project.globalConfig?.projection || 'mercator',
      active_base_map_id: n(project.activeBaseMapId), active_elevation_map_id: n(project.activeElevationMapId),
      default_duration_sec: n(gc.defaultDuration) ?? 5, default_fps: fps,
      resolution_w: n(gc.defaultResolution?.width) ?? 1920, resolution_h: n(gc.defaultResolution?.height) ?? 1080,
      default_easing: gc.defaultEasing || 'easeInOut',
      elevation_exaggeration: gc.elevationExaggeration ?? null,
      end_sec: f2s(project.endFrame),
    });

    const insKf = db.prepare(`INSERT INTO camera_keyframe (
      kf_id, project_id, sec, center_lng, center_lat, zoom, pitch, bearing, easing, move_duration_sec,
      camera_type, follow_route_element_id, follow_direction, orbit_speed, orbit_duration_sec, ord
    ) VALUES (@kf_id,@project_id,@sec,@center_lng,@center_lat,@zoom,@pitch,@bearing,@easing,@move_duration_sec,
      @camera_type,@follow_route_element_id,@follow_direction,@orbit_speed,@orbit_duration_sec,@ord)`);
    const insFx = db.prepare(`INSERT INTO screen_fx (
      fx_id, project_id, kind, name, start_sec, end_sec, weather_type, intensity, wind,
      effect_type, effect_color, enabled, ord
    ) VALUES (@fx_id,@project_id,@kind,@name,@start_sec,@end_sec,@weather_type,@intensity,@wind,
      @effect_type,@effect_color,@enabled,@ord)`);
    const insOverlay = db.prepare(`INSERT INTO overlay (
      overlay_id, project_id, type, name, position, start_sec, end_sec, animation, exit_animation, scale,
      offset_x, offset_y, z_index, bg_color, bg_opacity, bg_blur, bg_radius, bg_border,
      payload_json, person_layout_json, audio_asset_id, parent_overlay_id, ord
    ) VALUES (@overlay_id,@project_id,@type,@name,@position,@start_sec,@end_sec,@animation,@exit_animation,@scale,
      @offset_x,@offset_y,@z_index,@bg_color,@bg_opacity,@bg_blur,@bg_radius,@bg_border,
      @payload_json,@person_layout_json,@audio_asset_id,@parent_overlay_id,@ord)`);
    const insNarration = db.prepare(`INSERT INTO narration (
      project_id, font_size, font_family, color, stroke_color, stroke_width, bg, bg_color, pos_y, max_pct
    ) VALUES (@project_id,@font_size,@font_family,@color,@stroke_color,@stroke_width,@bg,@bg_color,@pos_y,@max_pct)`);
    const insEntry = db.prepare(`INSERT INTO narration_entry (
      entry_id, project_id, text, audio_asset_id, url, duration_sec, start_sec, locked, ord
    ) VALUES (@entry_id,@project_id,@text,@audio_asset_id,@url,@duration_sec,@start_sec,@locked,@ord)`);
    const insMusic = db.prepare(`INSERT INTO music_track (
      track_id, project_id, name, audio_asset_id, url, start_sec, end_sec, volume, loop, fade_in, fade_out, ord
    ) VALUES (@track_id,@project_id,@name,@audio_asset_id,@url,@start_sec,@end_sec,@volume,@loop,@fade_in,@fade_out,@ord)`);

    // 图层（项目 ▸ 图层 ▸ 元素）
    const insLayer = db.prepare(`INSERT INTO layer (
      layer_id, project_id, type, name, visible, start_sec, end_sec, ord
    ) VALUES (@layer_id,@project_id,@type,@name,@visible,@start_sec,@end_sec,@ord)`);
    const layers = project.layers || [];
    layers.forEach((L, i) => insLayer.run({
      layer_id: L.id, project_id: project.id, type: L.type || 'marker', name: L.name || '',
      visible: b(L.visible !== false), start_sec: f2s(L.startFrame), end_sec: f2s(L.endFrame), ord: i,
    }));

    // 元素（先于相机：跟随视角外键引用路线元素）
    for (const L of layers) for (const el of L.elements || []) saveElementV2(db, project.id, L.id, el, f2s);
    // 相机
    (project.camera || []).forEach((kf, i) => insKf.run({
      kf_id: `${project.id}:kf:${i}`, project_id: project.id, sec: f2s(kf.frame),
      center_lng: kf.center[0], center_lat: kf.center[1], zoom: kf.zoom, pitch: n(kf.pitch), bearing: n(kf.bearing),
      easing: n(kf.easing), move_duration_sec: kf.moveDuration == null ? null : f2s(kf.moveDuration),
      camera_type: n(kf.cameraType), follow_route_element_id: n(kf.followRoute?.routeElementId),
      follow_direction: n(kf.followRoute?.followDirection) == null ? null : b(kf.followRoute.followDirection),
      orbit_speed: n(kf.orbit?.speed), orbit_duration_sec: n(kf.orbit?.duration), ord: i,
    }));
    // 特效
    (project.fx || []).forEach((fx, i) => insFx.run({
      fx_id: fx.id, project_id: project.id, kind: fx.kind, name: fx.name || '',
      start_sec: f2s(fx.startFrame), end_sec: f2s(fx.endFrame),
      weather_type: n(fx.weather?.type), intensity: n(fx.weather?.intensity ?? fx.effect?.intensity),
      wind: n(fx.weather?.wind), effect_type: n(fx.effect?.type), effect_color: n(fx.effect?.color),
      enabled: b(fx.enabled !== false), ord: i,
    }));
    // 弹窗
    (project.overlays || []).forEach((o, i) => insOverlay.run({
      overlay_id: o.id, project_id: project.id, type: o.type, name: o.name || '', position: o.position,
      start_sec: f2s(o.startFrame), end_sec: f2s(o.endFrame), animation: n(o.animation), exit_animation: n(o.exitAnimation),
      scale: n(o.scale), offset_x: o.offsetX ?? 0, offset_y: o.offsetY ?? 0, z_index: o.zIndex ?? 0,
      bg_color: n(o.bg?.color), bg_opacity: n(o.bg?.opacity), bg_blur: n(o.bg?.blur), bg_radius: n(o.bg?.radius),
      bg_border: n(o.bg?.border), payload_json: j(o.content), person_layout_json: null,
      audio_asset_id: null, parent_overlay_id: null, ord: i,
    }));
    // 字幕 / 配音
    const nar = project.narration || { entries: [], style: {} };
    const st = nar.style || {};
    insNarration.run({
      project_id: project.id, font_size: st.fontSize ?? 40, font_family: n(st.fontFamily), color: st.color ?? '#E9DEC4',
      stroke_color: st.strokeColor ?? '#000000', stroke_width: st.strokeWidth ?? 0, bg: st.bg ?? 'none',
      bg_color: st.bgColor ?? '#000000', pos_y: st.posY ?? 2, max_pct: st.maxPct ?? 92,
    });
    (nar.entries || []).forEach((e, i) => insEntry.run({
      entry_id: e.id, project_id: project.id, text: e.text || '', audio_asset_id: null, url: n(e.audioUrl),
      duration_sec: e.durationFrames == null ? null : f2s(e.durationFrames),
      start_sec: f2s(e.startFrame), locked: e.locked ? 1 : 0, ord: i,
    }));
    // 项目级背景音乐：单轨多段，挂在项目上（绝对秒）
    (project.music || []).forEach((m, i) => insMusic.run({
      track_id: m.id, project_id: project.id, name: m.name || '', audio_asset_id: null, url: n(m.url),
      start_sec: f2s(m.startFrame), end_sec: m.endFrame == null ? null : f2s(m.endFrame),
      volume: m.volume ?? 0.6, loop: m.loop ? 1 : 0, fade_in: m.fadeIn ?? 0, fade_out: m.fadeOut ?? 0, ord: i,
    }));
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    throw e;
  }
  return { id: project.id };
}

function saveElementV2(db, chapterId, layerId, el, f2s) {
  const cat = ELEMENT_CATEGORY[el.type] || 'marker';
  const common = {
    element_id: el.id, project_id: chapterId, layer_id: n(layerId), type: el.type, name: el.name || '',
    visible: b(el.visible !== false), start_sec: f2s(el.startFrame), end_sec: f2s(el.endFrame),
    anim_effect: n(el.animEffect), keyframes_json: kfsToJson(el, f2s), ord: 0,
    ...labelCols(el.label),
  };
  if (cat === 'marker') {
    db.prepare(`INSERT INTO element_marker (
      element_id, project_id, layer_id, type, name, visible, start_sec, end_sec, anim_effect,
      fly_mode, show_icon, move_start_sec, move_end_sec, uniform_move, point_times_json,
      label_text,label_font_size,label_color,label_position,label_offset_x,label_offset_y,label_bg_color,label_bg_padding,label_bg_radius,label_font_weight,
      keyframes_json, ord, lng, lat, rotation, shape, emoji, scale, orientation, color,
      asset_id, builtin_id, icon_lib, icon_name,
      visual_fit,visual_tintable,visual_fps,visual_loop,visual_altitude,visual_auto_rotate,visual_spin,visual_pitch_align,visual_animation,visual_stroke_width,
      flag_text, flag_color, flag_text_color, flag_font_size, flag_width, sidc, symbol_size, echelon, symbol_label
    ) VALUES (
      @element_id,@project_id,@layer_id,@type,@name,@visible,@start_sec,@end_sec,@anim_effect,
      @fly_mode,@show_icon,@move_start_sec,@move_end_sec,@uniform_move,@point_times_json,
      @label_text,@label_font_size,@label_color,@label_position,@label_offset_x,@label_offset_y,@label_bg_color,@label_bg_padding,@label_bg_radius,@label_font_weight,
      @keyframes_json,@ord,@lng,@lat,@rotation,@shape,@emoji,@scale,@orientation,@color,
      @asset_id,@builtin_id,@icon_lib,@icon_name,
      @visual_fit,@visual_tintable,@visual_fps,@visual_loop,@visual_altitude,@visual_auto_rotate,@visual_spin,@visual_pitch_align,@visual_animation,@visual_stroke_width,
      @flag_text,@flag_color,@flag_text_color,@flag_font_size,@flag_width,@sidc,@symbol_size,@echelon,@symbol_label)`).run({
      ...common,
      fly_mode: el.flyMode ? 1 : 0, show_icon: el.showIcon ? 1 : 0,
      move_start_sec: el.moveStartFrame == null ? null : f2s(el.moveStartFrame),
      move_end_sec: el.moveEndFrame == null ? null : f2s(el.moveEndFrame),
      uniform_move: n(el.uniformMove) == null ? null : b(el.uniformMove),
      point_times_json: el.pointTimes ? JSON.stringify(el.pointTimes.map(f2s)) : null,
      lng: el.coordinates?.[0] ?? 0, lat: el.coordinates?.[1] ?? 0, rotation: n(el.rotation),
      shape: n(el.shape), emoji: n(el.emoji), scale: n(el.scale), orientation: n(el.orientation), color: n(el.color),
      asset_id: n(el.assetId), builtin_id: n(el.builtinId), icon_lib: n(el.iconLib), icon_name: n(el.iconName),
      ...visualCols(el.visualMeta),
      flag_text: n(el.text), flag_color: n(el.flagColor), flag_text_color: n(el.textColor),
      flag_font_size: n(el.fontSize), flag_width: n(el.flagWidth),
      sidc: n(el.sidc), symbol_size: n(el.symbolSize), echelon: n(el.echelon), symbol_label: n(el.symbolLabel),
    });
    return;
  }
  if (cat === 'route') {
    db.prepare(`INSERT INTO element_route (
      element_id, project_id, layer_id, type, name, visible, start_sec, end_sec, anim_effect,
      fly_mode, show_icon, move_start_sec, move_end_sec, uniform_move, point_times_json,
      label_text,label_font_size,label_color,label_position,label_offset_x,label_offset_y,label_bg_color,label_bg_padding,label_bg_radius,label_font_weight,
      keyframes_json, ord, coords_json, line_width, line_color, line_dash_on, line_dash_off, line_type, line_arrow,
      route_dot_enabled, route_dot_count, route_dot_width, route_dot_color, route_dot_frame_step,
      flow_speed, plain_path, front_tooth_length, front_tooth_gap, front_tooth_angle, front_side,
      trail_color, trail_width, trail_length, from_element_id, to_element_id, animated, arrowhead,
      move_icon_shape,move_icon_color,move_icon_emoji,move_icon_scale,move_icon_label_text,move_icon_label_color,move_icon_label_bg,move_icon_label_size,move_icon_label_padding,move_icon_label_radius,move_icon_label_pos,move_icon_label_offset_x,move_icon_label_offset_y,move_icon_flag_text,move_icon_flag_color,move_icon_builtin_id,move_icon_asset_id,move_icon_icon_lib,move_icon_icon_name,move_icon_orientation,move_icon_rotation,move_icon_show_label
    ) VALUES (
      @element_id,@project_id,@layer_id,@type,@name,@visible,@start_sec,@end_sec,@anim_effect,
      @fly_mode,@show_icon,@move_start_sec,@move_end_sec,@uniform_move,@point_times_json,
      @label_text,@label_font_size,@label_color,@label_position,@label_offset_x,@label_offset_y,@label_bg_color,@label_bg_padding,@label_bg_radius,@label_font_weight,
      @keyframes_json,@ord,@coords_json,@line_width,@line_color,@line_dash_on,@line_dash_off,@line_type,@line_arrow,
      @route_dot_enabled,@route_dot_count,@route_dot_width,@route_dot_color,@route_dot_frame_step,
      @flow_speed,@plain_path,@front_tooth_length,@front_tooth_gap,@front_tooth_angle,@front_side,
      @trail_color,@trail_width,@trail_length,@from_element_id,@to_element_id,@animated,@arrowhead,
      @move_icon_shape,@move_icon_color,@move_icon_emoji,@move_icon_scale,@move_icon_label_text,@move_icon_label_color,@move_icon_label_bg,@move_icon_label_size,@move_icon_label_padding,@move_icon_label_radius,@move_icon_label_pos,@move_icon_label_offset_x,@move_icon_label_offset_y,@move_icon_flag_text,@move_icon_flag_color,@move_icon_builtin_id,@move_icon_asset_id,@move_icon_icon_lib,@move_icon_icon_name,@move_icon_orientation,@move_icon_rotation,@move_icon_show_label)`).run({
      ...common,
      fly_mode: el.flyMode ? 1 : 0, show_icon: el.showIcon ? 1 : 0,
      move_start_sec: el.moveStartFrame == null ? null : f2s(el.moveStartFrame),
      move_end_sec: el.moveEndFrame == null ? null : f2s(el.moveEndFrame),
      uniform_move: n(el.uniformMove) == null ? null : b(el.uniformMove),
      point_times_json: el.pointTimes ? JSON.stringify(el.pointTimes.map(f2s)) : null,
      coords_json: j(el.coordinates || el.path),
      line_width: n(el.lineWidth), line_color: n(el.lineColor),
      line_dash_on: el.lineDashArray?.[0] ?? null, line_dash_off: el.lineDashArray?.[1] ?? null,
      line_type: n(el.lineType), line_arrow: b(el.lineArrow),
      route_dot_enabled: el.routeEffect ? b(el.routeEffect.enabled) : null,
      route_dot_count: n(el.routeEffect?.dotCount), route_dot_width: n(el.routeEffect?.spotWidth),
      route_dot_color: n(el.routeEffect?.spotColor), route_dot_frame_step: n(el.routeEffect?.frameStep),
      flow_speed: n(el.flowSpeed), plain_path: b(el.plainPath),
      front_tooth_length: n(el.frontStyle?.toothLength), front_tooth_gap: n(el.frontStyle?.toothGap),
      front_tooth_angle: n(el.frontStyle?.toothAngle), front_side: n(el.frontStyle?.side),
      trail_color: n(el.trail?.color), trail_width: n(el.trail?.width), trail_length: n(el.trail?.length),
      from_element_id: n(el.fromElementId), to_element_id: n(el.toElementId),
      animated: n(el.animated) == null ? null : b(el.animated), arrowhead: n(el.arrowhead) == null ? null : b(el.arrowhead),
      ...moveIconCols(el.moveIcon),
    });
    return;
  }
  if (cat === 'shape') {
    const cMeta = el.circleMeta || el.starMeta;
    db.prepare(`INSERT INTO element_shape (
      element_id, project_id, layer_id, type, name, visible, start_sec, end_sec, anim_effect,
      fly_mode, show_icon, move_start_sec, move_end_sec, uniform_move, point_times_json,
      label_text,label_font_size,label_color,label_position,label_offset_x,label_offset_y,label_bg_color,label_bg_padding,label_bg_radius,label_font_weight,
      keyframes_json, ord, rings_json, fill_color, fill_opacity, stroke_color, stroke_width, shape_kind,
      rect_c1_lng,rect_c1_lat,rect_c2_lng,rect_c2_lat,
      poly_curve, defense_tooth_length, defense_tooth_gap, defense_tooth_angle, defense_side,
      gradient_enabled, gradient_from, gradient_to,
      from_lng, from_lat, to_lng, to_lat, path_json, arrow_type, width, color,
      points_json, center_lng, center_lat, radius, pulse_animation, rotation,
      move_icon_shape,move_icon_color,move_icon_emoji,move_icon_scale,move_icon_label_text,move_icon_label_color,move_icon_label_bg,move_icon_label_size,move_icon_label_padding,move_icon_label_radius,move_icon_label_pos,move_icon_label_offset_x,move_icon_label_offset_y,move_icon_flag_text,move_icon_flag_color,move_icon_builtin_id,move_icon_asset_id,move_icon_icon_lib,move_icon_icon_name,move_icon_orientation,move_icon_rotation,move_icon_show_label
    ) VALUES (
      @element_id,@project_id,@layer_id,@type,@name,@visible,@start_sec,@end_sec,@anim_effect,
      @fly_mode,@show_icon,@move_start_sec,@move_end_sec,@uniform_move,@point_times_json,
      @label_text,@label_font_size,@label_color,@label_position,@label_offset_x,@label_offset_y,@label_bg_color,@label_bg_padding,@label_bg_radius,@label_font_weight,
      @keyframes_json,@ord,@rings_json,@fill_color,@fill_opacity,@stroke_color,@stroke_width,@shape_kind,
      @rect_c1_lng,@rect_c1_lat,@rect_c2_lng,@rect_c2_lat,
      @poly_curve,@defense_tooth_length,@defense_tooth_gap,@defense_tooth_angle,@defense_side,
      @gradient_enabled,@gradient_from,@gradient_to,
      @from_lng,@from_lat,@to_lng,@to_lat,@path_json,@arrow_type,@width,@color,
      @points_json,@center_lng,@center_lat,@radius,@pulse_animation,@rotation,
      @move_icon_shape,@move_icon_color,@move_icon_emoji,@move_icon_scale,@move_icon_label_text,@move_icon_label_color,@move_icon_label_bg,@move_icon_label_size,@move_icon_label_padding,@move_icon_label_radius,@move_icon_label_pos,@move_icon_label_offset_x,@move_icon_label_offset_y,@move_icon_flag_text,@move_icon_flag_color,@move_icon_builtin_id,@move_icon_asset_id,@move_icon_icon_lib,@move_icon_icon_name,@move_icon_orientation,@move_icon_rotation,@move_icon_show_label)`).run({
      ...common,
      fly_mode: el.flyMode ? 1 : 0, show_icon: el.showIcon ? 1 : 0,
      move_start_sec: el.moveStartFrame == null ? null : f2s(el.moveStartFrame),
      move_end_sec: el.moveEndFrame == null ? null : f2s(el.moveEndFrame),
      uniform_move: n(el.uniformMove) == null ? null : b(el.uniformMove),
      point_times_json: el.pointTimes ? JSON.stringify(el.pointTimes.map(f2s)) : null,
      rings_json: el.coordinates ? JSON.stringify(el.coordinates) : null,
      fill_color: n(el.fillColor), fill_opacity: n(el.fillOpacity), stroke_color: n(el.strokeColor), stroke_width: n(el.strokeWidth),
      shape_kind: n(el.shapeKind),
      rect_c1_lng: n(el.rectMeta?.c1?.[0]), rect_c1_lat: n(el.rectMeta?.c1?.[1]), rect_c2_lng: n(el.rectMeta?.c2?.[0]), rect_c2_lat: n(el.rectMeta?.c2?.[1]),
      poly_curve: b(el.polyCurve),
      defense_tooth_length: n(el.defenseStyle?.toothLength), defense_tooth_gap: n(el.defenseStyle?.toothGap),
      defense_tooth_angle: n(el.defenseStyle?.toothAngle), defense_side: n(el.defenseStyle?.side),
      gradient_enabled: el.fillGradient ? b(el.fillGradient.enabled) : null,
      gradient_from: n(el.fillGradient?.fromColor), gradient_to: n(el.fillGradient?.toColor),
      from_lng: n(el.from?.[0]), from_lat: n(el.from?.[1]), to_lng: n(el.to?.[0]), to_lat: n(el.to?.[1]),
      path_json: j(el.path), arrow_type: n(el.arrowType), width: n(el.width), color: n(el.color),
      points_json: j(el.points),
      center_lng: cMeta ? n(cMeta.center[0]) : n(el.center?.[0]),
      center_lat: cMeta ? n(cMeta.center[1]) : n(el.center?.[1]),
      radius: cMeta ? n(cMeta.radius) : n(el.radius),
      pulse_animation: n(el.pulseAnimation) == null ? null : b(el.pulseAnimation), rotation: n(el.rotation),
      ...moveIconCols(el.moveIcon),
    });
    return;
  }
  if (cat === 'image') {
    const grid = Array.isArray(el.grid) ? el.grid : [];
    db.prepare(`INSERT INTO element_image (
      element_id, project_id, layer_id, type, name, visible, start_sec, end_sec,
      asset_id, aspect, cols, rows, grid_json, opacity, ord
    ) VALUES (@element_id,@project_id,@layer_id,@type,@name,@visible,@start_sec,@end_sec,
      @asset_id,@aspect,@cols,@rows,@grid_json,@opacity,@ord)`).run({
      element_id: el.id, project_id: chapterId, layer_id: n(layerId), type: el.type, name: el.name || '',
      visible: b(el.visible !== false), start_sec: f2s(el.startFrame), end_sec: f2s(el.endFrame),
      asset_id: n(el.assetId), aspect: n(el.aspect),
      cols: Math.max(1, Math.round(el.cols || 1)), rows: Math.max(1, Math.round(el.rows || 1)),
      grid_json: grid.length ? JSON.stringify(grid) : null,
      opacity: n(el.opacity), ord: 0,
    });
    return;
  }
  // territory
  const d = el.display || {};
  db.prepare(`INSERT INTO element_territory (
    element_id, project_id, layer_id, type, name, visible, start_sec, end_sec, anim_effect,
    label_text,label_font_size,label_color,label_position,label_offset_x,label_offset_y,label_bg_color,label_bg_padding,label_bg_radius,label_font_weight,
    keyframes_json, ord,
    display_country_borders, display_plot_borders, display_border_width, display_fill_opacity,
    display_country_names, display_plot_names, display_label_align, display_label_scale,
    countries_json, plots_json, events_json
  ) VALUES (
    @element_id,@project_id,@layer_id,@type,@name,@visible,@start_sec,@end_sec,@anim_effect,
    @label_text,@label_font_size,@label_color,@label_position,@label_offset_x,@label_offset_y,@label_bg_color,@label_bg_padding,@label_bg_radius,@label_font_weight,
    @keyframes_json,@ord,
    @display_country_borders,@display_plot_borders,@display_border_width,@display_fill_opacity,
    @display_country_names,@display_plot_names,@display_label_align,@display_label_scale,
    @countries_json,@plots_json,@events_json)`).run({
    ...common,
    display_country_borders: b(d.countryBorders !== false),
    display_plot_borders: b(d.plotBorders !== false),
    display_border_width: d.borderWidth ?? 3,
    display_fill_opacity: d.fillOpacity ?? 0.45,
    display_country_names: b(d.countryNames !== false),
    display_plot_names: b(d.plotNames === true),
    display_label_align: d.labelAlign ?? 'map',
    display_label_scale: d.labelScale ?? 1,
    countries_json: j(el.countries), plots_json: j(el.plots),
    events_json: j((el.events || []).map((e) => ({
      id: e.id, sec: f2s(e.frame), plotIds: e.plotIds, toCountryId: e.toCountryId,
      effect: e.effect ? { preset: e.effect.preset, duration_sec: e.effect.duration == null ? undefined : f2s(e.effect.duration), highlight: e.effect.highlight } : undefined,
    }))),
  });
  return;
}

// ---------- 读取 ----------
export function getProjectV2(db, id) {
  const p = db.prepare('SELECT * FROM project WHERE project_id = ?').get(id);
  if (!p) return null;
  const fps = p.default_fps || 30;
  const s2f = (s) => (typeof s === 'number' ? Math.round(s * fps) : 0);
  const pid = p.project_id;
  const camera = db.prepare('SELECT * FROM camera_keyframe WHERE project_id = ? ORDER BY ord').all(pid).map((k) => ({
    frame: s2f(k.sec), center: [k.center_lng, k.center_lat], zoom: k.zoom,
    pitch: k.pitch ?? undefined, bearing: k.bearing ?? undefined, easing: k.easing ?? undefined,
    moveDuration: k.move_duration_sec == null ? undefined : s2f(k.move_duration_sec),
    cameraType: k.camera_type ?? undefined,
    ...(k.follow_route_element_id ? { followRoute: { routeElementId: k.follow_route_element_id, followDirection: k.follow_direction == null ? undefined : bit(k.follow_direction) } } : {}),
    ...(k.orbit_speed != null || k.orbit_duration_sec != null ? { orbit: { speed: k.orbit_speed ?? undefined, duration: k.orbit_duration_sec ?? undefined } } : {}),
  }));
  const fx = db.prepare('SELECT * FROM screen_fx WHERE project_id = ? ORDER BY ord').all(pid).map((f) => ({
    id: f.fx_id, kind: f.kind, name: f.name,
    startFrame: s2f(f.start_sec), endFrame: s2f(f.end_sec), enabled: f.enabled !== 0,
    ...(f.kind === 'weather' ? { weather: { type: f.weather_type, intensity: f.intensity ?? 0.6, wind: f.wind ?? 0 } } : {}),
    ...(f.kind === 'screen' ? { effect: { type: f.effect_type, intensity: f.intensity ?? 0.6, color: f.effect_color ?? undefined } } : {}),
  }));
  const overlays = db.prepare('SELECT * FROM overlay WHERE project_id = ? ORDER BY ord').all(pid).map((o) => ({
    id: o.overlay_id, type: o.type, name: o.name, position: o.position,
    startFrame: s2f(o.start_sec), endFrame: s2f(o.end_sec),
    animation: o.animation ?? undefined, exitAnimation: o.exit_animation ?? undefined,
    scale: o.scale ?? undefined, offsetX: o.offset_x, offsetY: o.offset_y, zIndex: o.z_index,
    ...(o.bg_color != null || o.bg_opacity != null ? { bg: { color: o.bg_color ?? '#000000', opacity: o.bg_opacity ?? 0.6, blur: o.bg_blur ?? 0, radius: o.bg_radius ?? 12, border: o.bg_border ?? undefined } } : {}),
    content: J(o.payload_json, { type: o.type }),
  }));
  const st = db.prepare('SELECT * FROM narration WHERE project_id = ?').get(pid);
  const entries = db.prepare('SELECT * FROM narration_entry WHERE project_id = ? ORDER BY ord').all(pid).map((e) => ({
    id: e.entry_id, text: e.text, audioUrl: e.url ?? undefined, durationFrames: s2f(e.duration_sec ?? 0), startFrame: s2f(e.start_sec), locked: e.locked === 1,
  }));
  const elements = readElementsV2(db, pid, s2f);
  // 图层（项目 ▸ 图层 ▸ 元素）：按 layer_id 归组；无图层表时兜底一个默认图层
  const layerRows = db.prepare('SELECT * FROM layer WHERE project_id = ? ORDER BY ord').all(pid);
  const byLayer = new Map();
  for (const el of elements) {
    const lid = el.layerId || '';
    const arr = byLayer.get(lid);
    if (arr) arr.push(el); else byLayer.set(lid, [el]);
  }
  const layers = layerRows.length
    ? layerRows.map((L) => ({
        id: L.layer_id, type: L.type || 'marker', name: L.name, visible: L.visible !== 0,
        startFrame: s2f(L.start_sec), endFrame: s2f(L.end_sec), elements: byLayer.get(L.layer_id) || [],
      }))
    : [{ id: `${pid}:layer`, type: 'marker', name: '标记 1', visible: true, startFrame: 0, endFrame: s2f(p.end_sec), elements }];
  return {
    id: pid, name: p.name, description: p.description ?? undefined,
    collectionId: p.collection_id, createdAt: new Date(p.created_at), updatedAt: new Date(p.updated_at),
    globalConfig: {
      defaultDuration: p.default_duration_sec, defaultFPS: p.default_fps,
      defaultResolution: { width: p.resolution_w, height: p.resolution_h, label: `${p.resolution_w}x${p.resolution_h}` },
      defaultEasing: p.default_easing, projection: p.projection, elevationExaggeration: p.elevation_exaggeration ?? undefined,
    },
    startFrame: 0,
    endFrame: s2f(p.end_sec),
    layers, elements, camera, fx, overlays,
    narration: { entries, style: st ? { fontSize: st.font_size, fontFamily: st.font_family ?? undefined, color: st.color, strokeColor: st.stroke_color, strokeWidth: st.stroke_width, bg: st.bg, bgColor: st.bg_color, posY: st.pos_y, maxPct: st.max_pct } : undefined },
    music: db.prepare('SELECT * FROM music_track WHERE project_id = ? ORDER BY ord').all(pid).map((m) => ({
      id: m.track_id, name: m.name, url: m.url ?? undefined, startFrame: s2f(m.start_sec), endFrame: m.end_sec == null ? s2f(m.start_sec) : s2f(m.end_sec),
      volume: m.volume, loop: m.loop === 1, fadeIn: m.fade_in, fadeOut: m.fade_out,
    })),
    baseMaps: [], elevationMaps: [], activeBaseMapId: p.active_base_map_id ?? 'osm', activeElevationMapId: p.active_elevation_map_id ?? 'none',
  };
}

function readElementsV2(db, chapterId, s2f) {
  const out = [];
  const kfOf = (r) => jsonToKfs(r.keyframes_json, s2f);
  const base = (r) => {
    const k = kfOf(r);
    return {
      id: r.element_id, type: r.type, name: r.name, visible: r.visible !== 0,
      layerId: r.layer_id ?? undefined,
      startFrame: s2f(r.start_sec), endFrame: s2f(r.end_sec),
      style: k.style, label: colsToLabel(r),
      ...(r.anim_effect ? { animEffect: r.anim_effect } : {}),
      ...(r.point_times_json ? { pointTimes: J(r.point_times_json, []).map(s2f) } : {}),
      ...(r.type !== 'point' && r.type !== 'flag' && r.type !== 'military_symbol' && r.type !== 'territory' ? {
        flyMode: r.fly_mode === 1, showIcon: r.show_icon === 1,
        moveStartFrame: r.move_start_sec == null ? undefined : s2f(r.move_start_sec),
        moveEndFrame: r.move_end_sec == null ? undefined : s2f(r.move_end_sec),
        uniformMove: r.uniform_move == null ? undefined : bit(r.uniform_move),
        moveIcon: colsToMoveIcon(r),
      } : {}),
    };
  };
  for (const r of db.prepare('SELECT * FROM element_marker WHERE project_id = ?').all(chapterId)) {
    if (r.type === 'flag') {
      out.push({ ...base(r), type: 'flag', coordinates: [r.lng, r.lat], text: r.flag_text ?? '', flagColor: r.flag_color ?? '#E23B3B', textColor: r.flag_text_color ?? '#FFFFFF', fontSize: r.flag_font_size ?? 28, flagWidth: r.flag_width ?? 216, scale: r.scale ?? 1 });
    } else {
      out.push({
        ...base(r), type: 'point', coordinates: [r.lng, r.lat],
        iconSize: r.icon_size ?? undefined, color: r.color ?? undefined, shape: r.shape ?? undefined, emoji: r.emoji ?? undefined,
        scale: r.scale ?? undefined, orientation: r.orientation ?? undefined, rotation: r.rotation ?? undefined,
        builtinId: r.builtin_id ?? undefined, assetId: r.asset_id ?? undefined, iconLib: r.icon_lib ?? undefined, iconName: r.icon_name ?? undefined,
        visualMeta: colsToVisual(r),
        ...(r.sidc ? { sidc: r.sidc, symbolSize: r.symbol_size ?? undefined, echelon: r.echelon ?? undefined, symbolLabel: r.symbol_label ?? undefined } : {}),
      });
    }
  }
  for (const r of db.prepare('SELECT * FROM element_route WHERE project_id = ?').all(chapterId)) {
    const k = kfOf(r);
    if (r.type === 'connector') {
      out.push({ ...base(r), type: 'connector', fromElementId: r.from_element_id, toElementId: r.to_element_id, lineWidth: r.line_width ?? 4, lineColor: r.line_color ?? '#FF6600', lineDashArray: r.line_dash_on != null ? [r.line_dash_on, r.line_dash_off ?? 0] : undefined, animated: r.animated == null ? undefined : bit(r.animated), arrowhead: r.arrowhead == null ? undefined : bit(r.arrowhead) });
    } else if (r.type === 'moving_point') {
      out.push({ ...base(r), type: 'moving_point', path: J(r.coords_json, []), pathProgress: k.progress, color: r.line_color ?? undefined, trail: r.trail_color || r.trail_width != null || r.trail_length != null ? { color: r.trail_color ?? undefined, width: r.trail_width ?? undefined, length: r.trail_length ?? undefined } : undefined });
    } else {
      out.push({
        ...base(r), type: 'line', coordinates: J(r.coords_json, []), drawProgress: k.drawProgress,
        lineWidth: r.line_width ?? 8, lineColor: r.line_color ?? '#FF0000',
        lineDashArray: r.line_dash_on != null ? [r.line_dash_on, r.line_dash_off ?? 0] : undefined,
        lineType: r.line_type ?? undefined, lineArrow: r.line_arrow == null ? undefined : bit(r.line_arrow),
        routeEffect: r.route_dot_enabled == null ? undefined : { enabled: bit(r.route_dot_enabled), spotColor: r.route_dot_color ?? '#FFE066', spotWidth: r.route_dot_width ?? 6, frameStep: r.route_dot_frame_step ?? 10, dotCount: r.route_dot_count ?? 1 },
        flowSpeed: r.flow_speed ?? undefined, plainPath: r.plain_path == null ? undefined : bit(r.plain_path),
        frontStyle: r.front_tooth_length == null && r.front_side == null ? undefined : { toothLength: r.front_tooth_length ?? undefined, toothGap: r.front_tooth_gap ?? undefined, toothAngle: r.front_tooth_angle ?? undefined, side: r.front_side ?? undefined },
      });
    }
  }
  for (const r of db.prepare('SELECT * FROM element_shape WHERE project_id = ?').all(chapterId)) {
    const k = kfOf(r);
    const mi = colsToMoveIcon(r);
    if (r.type === 'arrow') {
      const from = [r.from_lng, r.from_lat]; const to = [r.to_lng, r.to_lat];
      const path = J(r.path_json, null);
      out.push({ ...base(r), type: 'arrow', from, to, path: path ?? undefined, arrowType: r.arrow_type, width: r.width ?? 15, color: r.color ?? '#E23B3B', progress: k.progress, drawZoom: undefined });
    } else if (r.type === 'double_arrow') {
      out.push({ ...base(r), type: 'double_arrow', points: J(r.points_json, []), color: r.color ?? '#E23B3B', progress: k.progress });
    } else if (r.type === 'gathering' || r.type === 'encirclement') {
      out.push({ ...base(r), type: r.type, center: [r.center_lng, r.center_lat], radius: r.radius, color: r.color ?? undefined, fillColor: r.fill_color ?? undefined, strokeColor: r.stroke_color ?? undefined, pulseAnimation: r.pulse_animation == null ? undefined : bit(r.pulse_animation), rotation: r.rotation ?? undefined });
    } else {
      const poly = {
        ...base(r), type: 'polygon', coordinates: J(r.rings_json, []), fillColor: r.fill_color ?? '#E23B3B', fillOpacity: r.fill_opacity ?? 0.25,
        strokeColor: r.stroke_color ?? '#E23B3B', strokeWidth: r.stroke_width ?? 2, shapeKind: r.shape_kind ?? undefined,
        polyCurve: r.poly_curve == null ? undefined : bit(r.poly_curve), rotation: r.rotation ?? undefined,
        defenseStyle: r.defense_tooth_length == null && r.defense_side == null ? undefined : { toothLength: r.defense_tooth_length ?? undefined, toothGap: r.defense_tooth_gap ?? undefined, toothAngle: r.defense_tooth_angle ?? undefined, side: r.defense_side ?? undefined },
        fillGradient: r.gradient_enabled == null && r.gradient_from == null ? undefined : { enabled: bit(r.gradient_enabled), fromColor: r.gradient_from ?? '#E23B3B', toColor: r.gradient_to ?? '#FFFFFF' },
        fillProgress: k.fillProgress, morphKeyframes: k.morphKeyframes,
      };
      if (r.shape_kind === 'rect') poly.rectMeta = { c1: [r.rect_c1_lng, r.rect_c1_lat], c2: [r.rect_c2_lng, r.rect_c2_lat] };
      if (r.shape_kind === 'circle') poly.circleMeta = { center: [r.center_lng, r.center_lat], radius: r.radius };
      if (r.shape_kind === 'star') poly.starMeta = { center: [r.center_lng, r.center_lat], radius: r.radius };
      out.push(poly);
    }
  }
  for (const r of db.prepare('SELECT * FROM element_territory WHERE project_id = ?').all(chapterId)) {
    out.push({
      ...base(r), type: 'territory', countries: J(r.countries_json, []), plots: J(r.plots_json, []),
      events: J(r.events_json, []).map((e) => ({
        id: e.id ?? e.eventId, frame: s2f(e.sec), plotIds: e.plotIds ?? [], toCountryId: e.toCountryId,
        effect: e.effect?.preset ? { preset: e.effect.preset, duration: e.effect.duration_sec == null ? undefined : s2f(e.effect.duration_sec), highlight: e.effect.highlight } : undefined,
      })),
      display: { countryBorders: r.display_country_borders !== 0, plotBorders: r.display_plot_borders !== 0, borderWidth: r.display_border_width, fillOpacity: r.display_fill_opacity, countryNames: r.display_country_names !== 0, plotNames: r.display_plot_names === 1, labelAlign: r.display_label_align, labelScale: r.display_label_scale },
    });
  }
  for (const r of db.prepare('SELECT * FROM element_image WHERE project_id = ?').all(chapterId)) {
    out.push({
      id: r.element_id, type: 'geo_image', name: r.name, visible: r.visible !== 0,
      layerId: r.layer_id ?? undefined,
      startFrame: s2f(r.start_sec), endFrame: s2f(r.end_sec), style: {},
      assetId: r.asset_id ?? undefined, aspect: r.aspect ?? 1,
      cols: r.cols ?? 1, rows: r.rows ?? 1, grid: J(r.grid_json, []),
      opacity: r.opacity ?? undefined,
    });
  }
  return out;
}

/** 一次性迁移：旧 projects JSON 表 → V2 多表（仅当 V2 project 为空时）。保留旧表以便回滚。 */
export function migrateLegacyProjects(_db) {
  // 旧 projects JSON 是「章节级」结构，项目现已改为单条连续时间线，无法直接映射。
  // 按「不做向后兼容」约定不再迁移（旧数据由 ensureV2Schema 随旧表一并丢弃）。
  return 0;
}

export function listProjectsV2(db) {
  return db.prepare('SELECT project_id AS id, name, updated_at AS updatedAt, collection_id AS collectionId FROM project ORDER BY updated_at DESC').all();
}

export function removeProjectV2(db, id) {
  db.prepare('DELETE FROM project WHERE project_id = ?').run(id);
}
