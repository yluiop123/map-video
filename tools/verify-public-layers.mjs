/**
 * verify-public-layers.mjs — 公共图层库（复制/导入）回归验证
 *
 * 覆盖：跨图层连接线端点的自洽裁剪、素材占位顺序、级联删除、自检视图，
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

/**
 * 夹具项目：marker 层两个标记 + route 层两条路线、两条连接线
 * —— cCross 的端点是**另一个图层**的标记（真实常规用法），cSame 的端点是本图层内的路线。
 */
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
      { id: `${id}:cCross`, type: 'connector', name: '跨层连线', startFrame: FPS, endFrame: 8 * FPS, fromElementId: `${id}:m1`, toElementId: `${id}:m2`, lineWidth: 4, lineColor: '#FF6600' },
      { id: `${id}:cSame`, type: 'connector', name: '同层连线', startFrame: FPS, endFrame: 8 * FPS, fromElementId: `${id}:r1`, toElementId: `${id}:r2`, lineWidth: 4, lineColor: '#00CCFF' },
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

const liveElementIds = (db, whereCol, id, tables) => {
  const out = new Set();
  for (const t of tables) for (const r of db.prepare(`SELECT element_id FROM ${t} WHERE ${whereCol} = ?`).all(id)) out.add(r.element_id);
  return out;
};
/** 连接线端点（只有 route 表有端点列） */
function connectorEndpoints(db, routeTable, whereCol, id) {
  const out = [];
  for (const r of db.prepare(`SELECT element_id, from_element_id, to_element_id FROM ${routeTable} WHERE ${whereCol} = ? AND type = 'connector'`).all(id)) {
    out.push([r.element_id, r.from_element_id], [r.element_id, r.to_element_id]);
  }
  return out.filter(([, end]) => end);
}
const danglingOf = (db, tables, whereCol, id) => {
  const ids = liveElementIds(db, whereCol, id, tables);
  const routeTable = tables.find((t) => t.endsWith('element_route'));
  return connectorEndpoints(db, routeTable, whereCol, id).filter(([, end]) => !ids.has(end));
};

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed += 1;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? `\n         ${detail}` : ''}`);
};

// ---------- 1. 复制进公共库：跨图层端点的连接线被剔除且被报告 ----------
{
  console.log('\n[1] 图层 → 公共库：副本自洽');
  const db = open();
  saveProjectV2(db, baseProject('p1'));
  const r = saveLayerToPublicV2(db, 'p1:Lr');
  check('1.1 报告被剔除的连接线', r.dropped.length === 1 && r.dropped[0] === '跨层连线', `dropped=${JSON.stringify(r.dropped)}`);
  const d = danglingOf(db, PUB_TABLES, 'public_layer_id', r.id);
  check('1.2 公共库内无悬空端点', d.length === 0, `悬空 ${d.length} 个: ${JSON.stringify(d)}`);
  const left = db.prepare('SELECT name FROM public_element_route WHERE public_layer_id = ?').all(r.id).map((x) => x.name);
  check('1.3 同图层端点的连接线完整保留', left.includes('同层连线') && left.includes('路A') && left.length === 3, JSON.stringify(left));
  // 端点 id 必须指向副本自己（不是源项目）
  const src = db.prepare("SELECT COUNT(*) AS c FROM public_element_route WHERE public_layer_id = ? AND (from_element_id LIKE 'p1:%' OR to_element_id LIKE 'p1:%') AND from_element_id NOT LIKE '%:pb%'").get(r.id).c;
  check('1.4 不残留源项目元素 id', src === 0, `残留 ${src} 行`);
  // 自检视图现在能发现公共库的悬空引用
  check('1.5 v_check_dangling 对健康副本为 0', db.prepare("SELECT COUNT(*) AS c FROM v_check_dangling WHERE edge LIKE 'public_%'").get().c === 0);
  db.prepare('INSERT INTO public_element_route (element_id, public_layer_id, type, name, visible, start_sec, end_sec, fly_mode, show_icon, from_element_id, to_element_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run('bad:1', r.id, 'connector', '手工悬空', 1, 0, 5, 0, 0, 'nope:not-exist', 'nope:not-exist-2');
  check('1.6 v_check_dangling 能抓出公共库悬空端点', db.prepare("SELECT COUNT(*) AS c FROM v_check_dangling WHERE edge LIKE 'public_%'").get().c === 2,
    JSON.stringify(db.prepare("SELECT edge, ref_id, target FROM v_check_dangling WHERE edge LIKE 'public_%'").all()));
  // 源项目删除后公共库仍自洽
  db.prepare("DELETE FROM project WHERE project_id = 'p1'").run();
  check('1.7 删源项目后公共库依旧自洽', danglingOf(db, PUB_TABLES, 'public_layer_id', r.id).filter(([, e]) => !e.startsWith('nope:')).length === 0);
}

// ---------- 2. 公共库 → 项目：导入后端点全部可解析 ----------
{
  console.log('\n[2] 公共库 → 目标项目');
  const db = open();
  saveProjectV2(db, baseProject('src'));
  saveProjectV2(db, baseProject('dst'));
  const pub = saveLayerToPublicV2(db, 'src:Lr').id;
  const imp = importPublicLayerV2(db, pub, 'dst');
  check('2.1 导入不新增悬空', imp.dropped.length === 0 && danglingOf(db, PROJ_TABLES, 'layer_id', imp.id).length === 0,
    `dropped=${JSON.stringify(imp.dropped)}`);
  const proj = getProjectV2(db, 'dst');
  const layer = proj.layers.find((L) => L.id === imp.id);
  check('2.2 导入图层可被读取端还原', !!layer && layer.type === 'route' && layer.elements.length === 3,
    layer ? `${layer.name}: ${layer.elements.map((e) => e.type).join(',')}` : '未找到图层');
  const cSame = layer?.elements.find((e) => e.name === '同层连线');
  const endsOk = cSame && layer.elements.some((e) => e.id === cSame.fromElementId) && layer.elements.some((e) => e.id === cSame.toElementId);
  check('2.3 连接线端点解析到导入后的元素', !!endsOk, cSame ? `${cSame.fromElementId} → ${cSame.toElementId}` : '无连接线');
  check('2.4 原项目元素不受影响', getProjectV2(db, 'src').layers.find((L) => L.id === 'src:Lr').elements.length === 4);
  check('2.5 导入图层 ord 不与既有图层重复', (() => {
    const ords = db.prepare("SELECT ord FROM layer WHERE project_id = 'dst'").all().map((r) => r.ord);
    return new Set(ords).size === ords.length;
  })(), db.prepare("SELECT ord FROM layer WHERE project_id = 'dst'").all().map((r) => r.ord).join(','));
}

// ---------- 3. 素材缺失：占位必须早于元素插入（否则整笔事务被外键打回） ----------
{
  console.log('\n[3] 引用缺失素材的元素');
  const db = open();
  saveProjectV2(db, baseProject('p3'));
  const pub = saveLayerToPublicV2(db, 'p3:Lm').id;
  const info = db.prepare('PRAGMA table_info(public_element_marker)').all();
  const vals = Object.fromEntries(info.map((c) => [c.name, c.notnull ? (/INT|REAL|NUMERIC/.test(c.type) ? 0 : '') : null]));
  Object.assign(vals, {
    element_id: 'ghost:host', public_layer_id: pub, type: 'point', name: '幽灵', visible: 1,
    start_sec: 0, end_sec: 5, asset_id: 'asset-not-exists', fly_mode: 0, show_icon: 0,
  });
  db.prepare(`INSERT INTO public_element_marker (${info.map((c) => c.name).join(',')}) VALUES (${info.map((c) => '@' + c.name).join(',')})`).run(vals);
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
  check('4.1 列表元素数按裁剪后统计', listPublicLayersV2(db).find((x) => x.id === pub)?.count === 3,
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
