/**
 * verify-public-layers.mjs — 公共图层库（复制/导入）回归验证
 *
 * 覆盖：整层复制的 id 重映射与自洽、素材占位顺序、级联删除、自检视图，
 *       以及时间窗保长平移（clampWindowMove，直接测 src/lib/time.ts 的真函数）。
 * 运行：node --experimental-strip-types --experimental-sqlite tools/verify-public-layers.mjs
 * 退出码非 0 表示有失败项。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  saveProjectV2, getProjectV2, saveLayerToPublicV2, importPublicLayerV2, removePublicLayerV2, listPublicLayersV2,
} from '../electron/db-v2.mjs';
import { clampWindowMove } from '../src/lib/time.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DDL = fs.readFileSync(path.join(HERE, '..', 'docs', 'db-schema-v2.sql'), 'utf8');
const FPS = 30;
const PROJ_TABLES = ['element_marker', 'element_route', 'element_shape', 'element_territory', 'element_image'];
const PUB_TABLES = PROJ_TABLES.map((t) => `public_${t}`);

function open() {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  db.prepare("INSERT INTO collection (collection_id, name, ord, created_at, updated_at) VALUES ('default','默认合集',-1,?,?)").run(1, 1);
  return db;
}

/** 夹具项目：marker 层两个标记 + route 层两条路线 */
function baseProject(id) {
  const markerLayer = {
    id: `${id}:Lm`, type: 'marker', name: '标记层', visible: true, startFrame: 0, endFrame: 10 * FPS,
    elements: [
      { id: `${id}:m1`, type: 'point', name: '北', startFrame: FPS, endFrame: 8 * FPS, coordinates: [116.3, 39.9], shape: 'circle' },
      { id: `${id}:m2`, type: 'point', name: '南', startFrame: FPS, endFrame: 8 * FPS, coordinates: [116.4, 39.8], shape: 'circle' },
    ],
  };
  const routeLayer = {
    id: `${id}:Lr`, type: 'route', name: '路线层', visible: true, startFrame: 0, endFrame: 10 * FPS,
    elements: [
      { id: `${id}:r1`, type: 'line', name: '路A', startFrame: FPS, endFrame: 8 * FPS, coordinates: [[116.3, 39.9], [116.35, 39.95]], lineWidth: 3, lineColor: '#fff' },
      { id: `${id}:r2`, type: 'line', name: '路B', startFrame: FPS, endFrame: 8 * FPS, coordinates: [[116.4, 39.8], [116.45, 39.85]], lineWidth: 3, lineColor: '#fff' },
    ],
  };
  const layers = [markerLayer, routeLayer];
  return {
    id, name: id, collectionId: 'default', createdAt: new Date(), updatedAt: new Date(),
    globalConfig: { defaultFPS: FPS, defaultDuration: 10 * FPS, projection: 'mercator', defaultResolution: { width: 1920, height: 1080 } },
    startFrame: 0, endFrame: 10 * FPS, layers,
    elements: layers.flatMap((L) => L.elements),
    camera: [], fx: [], overlays: [], narration: { entries: [], style: {} }, music: [],
  };
}

/** 某 scope 下的全部元素 id（跨 5 张类别表） */
const liveElementIds = (db, whereCol, id, tables) => {
  const out = new Set();
  for (const t of tables) for (const r of db.prepare(`SELECT element_id FROM ${t} WHERE ${whereCol} = ?`).all(id)) out.add(r.element_id);
  return out;
};
/** 整库元素 id（用于查全库重复） */
const allElementIds = (db, tables) => {
  const out = [];
  for (const t of tables) out.push(...db.prepare(`SELECT element_id FROM ${t}`).all().map((r) => r.element_id));
  return out;
};
/** 按表的列定义造一行（notnull 列给类型零值，其余 null） */
function blankRow(db, table, over) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const vals = Object.fromEntries(cols.map((c) => [c.name, c.notnull ? (/INT|REAL|NUMERIC/.test(c.type) ? 0 : '') : null]));
  Object.assign(vals, over);
  db.prepare(`INSERT INTO ${table} (${cols.map((c) => c.name).join(',')}) VALUES (${cols.map((c) => '@' + c.name).join(',')})`).run(vals);
}

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed += 1;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? `\n         ${detail}` : ''}`);
};

// ---------- 1. 图层 → 公共库：副本整体换 id，不残留源 id ----------
{
  console.log('\n[1] 图层 → 公共库：副本自洽');
  const db = open();
  saveProjectV2(db, baseProject('p1'));
  const r = saveLayerToPublicV2(db, 'p1:Lr');
  const ids = [...liveElementIds(db, 'public_layer_id', r.id, PUB_TABLES)];
  check('1.1 副本元素数与源图层一致', ids.length === 2, `${ids.length} 个: ${JSON.stringify(ids)}`);
  check('1.2 副本 id 全部带公共图层后缀', ids.every((x) => x.endsWith(`:pb${r.id}`)), JSON.stringify(ids));
  check('1.3 不残留源项目元素 id', !ids.some((x) => x === 'p1:r1' || x === 'p1:r2'), JSON.stringify(ids));
  // 两张公共图层互不撞 id（element_id 是全库主键）
  const r2 = saveLayerToPublicV2(db, 'p1:Lm');
  const all = allElementIds(db, PUB_TABLES);
  check('1.4 两张公共图层元素 id 不重复', new Set(all).size === all.length, JSON.stringify(all));
  check('1.5 v_check_dangling 对健康库为 0', db.prepare('SELECT COUNT(*) AS c FROM v_check_dangling').get().c === 0);
  db.prepare("DELETE FROM project WHERE project_id = 'p1'").run();
  const after = allElementIds(db, PUB_TABLES);
  check('1.6 删源项目后公共库副本完好', after.length === all.length, `删前 ${all.length} → 删后 ${after.length}`);
}

// ---------- 2. 公共库 → 项目：导入带新 id，可重复导入 ----------
{
  console.log('\n[2] 公共库 → 目标项目');
  const db = open();
  saveProjectV2(db, baseProject('src'));
  saveProjectV2(db, baseProject('dst'));
  const pub = saveLayerToPublicV2(db, 'src:Lr').id;
  const imp = importPublicLayerV2(db, pub, 'dst');
  const proj = getProjectV2(db, 'dst');
  const layer = proj.layers.find((L) => L.id === imp.id);
  check('2.1 导入图层可被读取端还原', !!layer && layer.type === 'route' && layer.elements.length === 2,
    layer ? `${layer.name}: ${layer.elements.map((e) => e.type).join(',')}` : '未找到图层');
  check('2.2 导入元素 id 全部带新后缀', (layer?.elements || []).every((e) => e.id.endsWith(`:im${imp.id}`)),
    (layer?.elements || []).map((e) => e.id).join(','));
  const dstIds = allElementIds(db, PROJ_TABLES);
  check('2.3 全库元素 id 无重复', new Set(dstIds).size === dstIds.length, JSON.stringify(dstIds));
  check('2.4 原项目元素不受影响', getProjectV2(db, 'src').layers.find((L) => L.id === 'src:Lr').elements.length === 2);
  check('2.5 导入图层 ord 不与既有图层重复', (() => {
    const ords = db.prepare("SELECT ord FROM layer WHERE project_id = 'dst'").all().map((r) => r.ord);
    return new Set(ords).size === ords.length;
  })(), db.prepare("SELECT ord FROM layer WHERE project_id = 'dst'").all().map((r) => r.ord).join(','));
  // 同一公共图层导入两次：id 必须再次换掉，否则 deleteElement 按 id 一次删两条
  const imp2 = importPublicLayerV2(db, pub, 'dst');
  const twice = allElementIds(db, PROJ_TABLES);
  check('2.6 同一公共图层可重复导入且 id 不撞', imp2.id !== imp.id && new Set(twice).size === twice.length,
    `${imp.id} / ${imp2.id} · 共 ${twice.length} 个元素`);
  // 自检视图仍能抓出弱引用悬空（外键关闭时插入的坏跟随机位 —— 视图正是为迁移/老库体检而存在）
  db.exec('PRAGMA foreign_keys = OFF');
  blankRow(db, 'camera_keyframe', { kf_id: 'dst:kfBad', project_id: 'dst', sec: 1, follow_route_element_id: 'nope' });
  db.exec('PRAGMA foreign_keys = ON');
  const dangling = db.prepare('SELECT edge, ref_id, target FROM v_check_dangling').all();
  check('2.7 v_check_dangling 能抓出悬空跟随机位', dangling.length === 1 && dangling[0].edge === 'camera.follow_route',
    JSON.stringify(dangling));
}

// ---------- 3. 素材缺失：占位必须早于元素插入（否则整笔事务被外键打回） ----------
{
  console.log('\n[3] 引用缺失素材的元素');
  const db = open();
  saveProjectV2(db, baseProject('p3'));
  const pub = saveLayerToPublicV2(db, 'p3:Lm').id;
  blankRow(db, 'public_element_marker', {
    element_id: 'ghost:host', public_layer_id: pub, type: 'point', name: '幽灵', visible: 1,
    start_sec: 0, end_sec: 5, asset_id: 'asset-not-exists', fly_mode: 0, show_icon: 0,
  });
  let err = null;
  try { importPublicLayerV2(db, pub, 'p3'); } catch (e) { err = e; }
  check('3.1 导入成功（不再外键回滚）', !err, err ? err.message : '');
  check('3.2 素材占位已补齐', db.prepare("SELECT COUNT(*) AS c FROM asset WHERE asset_id = 'asset-not-exists'").get().c === 1);
  check('3.3 幽灵元素确实落到了项目里', db.prepare("SELECT COUNT(*) AS c FROM element_marker WHERE element_id LIKE 'ghost:host:im%' AND project_id = 'p3'").get().c === 1);
}

// ---------- 4. 删除公共图层级联清元素 ----------
{
  console.log('\n[4] 删除公共图层');
  const db = open();
  saveProjectV2(db, baseProject('p4'));
  const pub = saveLayerToPublicV2(db, 'p4:Lr').id;
  check('4.1 列表元素数与图层内元素一致', listPublicLayersV2(db).find((x) => x.id === pub)?.count === 2,
    JSON.stringify(listPublicLayersV2(db).map((x) => `${x.name}:${x.count}`)));
  removePublicLayerV2(db, pub);
  const left = PUB_TABLES.reduce((n, t) => n + db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c, 0);
  check('4.2 ON DELETE CASCADE 清干净元素副本', left === 0, `残留 ${left} 行`);
}

// ---------- 5. 时间窗整体平移：撞边界保长（src/lib/time.ts 真函数） ----------
{
  console.log('\n[5] 时间窗保长平移 clampWindowMove');
  const cases = [
    ['中段平移', 60, 120, 30, 90, 150],
    ['拖过片头', 60, 120, -100, 0, 60],
    ['拖过片尾', 200, 260, 100, 240, 300],
    ['贴住片头继续拖', 30, 90, -999, 0, 60],
  ];
  for (const [name, s, e, d, wantS, wantE] of cases) {
    const [gs, ge] = clampWindowMove(s, e, d, 0, 300);
    check(`5 ${name} ${s}..${e} Δ${d} → ${wantS}..${wantE}`, gs === wantS && ge === wantE, `实得 ${gs}..${ge}`);
  }
  // 旧的逐端钳制写法在同样入参下会把区间压短（这正是图层块拖动丢时长的原因）
  const naive = (s, e, d) => [Math.max(0, s + d), Math.min(300, e + d)];
  check('5.x 对照：逐端钳制确实会压缩时长', naive(60, 120, -100)[1] === 20, `逐端钳制结果 ${JSON.stringify(naive(60, 120, -100))}（应为 60）`);
}

console.log(`\n===== ${failed ? `${failed} 项失败` : '全部通过'} =====`);
process.exit(failed ? 1 : 0);
