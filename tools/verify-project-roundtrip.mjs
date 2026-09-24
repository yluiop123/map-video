/**
 * verify-project-roundtrip.mjs — 项目「存进去 = 取出来」回归验证
 *
 * 钉住两条反复踩过的约定（AGENTS §10）：
 *   1) **只存输入原值**：读取端还原出的字段必须与写入时逐字相等，尤其 0 / false / 空串
 *      这类「falsy 但合法」的值不能被 `||` 吞成默认值；
 *   2) **帧 ↔ 秒换算互逆**：写入端按当前 fps 除、读取端按同一 fps 乘回来，二次往返不得漂移。
 *      注意：全项目 fps 恒为 30（`defaultFPS` 只在新建项目时写入，没有任何 UI 改它），
 *      所以「改帧率后时长不变」目前不在保证范围内 —— 真要支持改 fps，需要的是
 *      「改 fps 时把全项目帧值按比例重算」，而不是只改这一个数。
 * 运行：node --experimental-strip-types --experimental-sqlite tools/verify-project-roundtrip.mjs
 * 退出码非 0 表示有失败项。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveProjectV2, getProjectV2 } from '../electron/db-v2.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DDL = fs.readFileSync(path.join(HERE, '..', 'docs', 'db-schema-v2.sql'), 'utf8');
const FPS = 30;

function open() {
  const db = new DatabaseSync(':memory:');
  db.exec(DDL);
  db.prepare("INSERT INTO collection (collection_id, name, ord, created_at, updated_at) VALUES ('default','默认合集',-1,?,?)").run(1, 1);
  return db;
}

function project(id, fps) {
  const s2f = (sec) => Math.round(sec * fps);
  return {
    id, name: id, collectionId: 'default', createdAt: new Date(), updatedAt: new Date(),
    globalConfig: { defaultFPS: fps, defaultDuration: s2f(12), projection: 'globe', defaultEasing: 'linear', defaultResolution: { width: 1280, height: 720, label: '720p' } },
    startFrame: 0, endFrame: s2f(60), layers: [], elements: [], camera: [], fx: [], overlays: [],
    narration: { entries: [], style: {} }, music: [],
    baseMaps: [
      { id: 'osm', name: 'OSM', style: 'https://a/b.json' },
      { id: 'sat', name: '卫星', style: { version: 8, sources: {}, layers: [] } },
    ],
    activeBaseMapId: 'sat',
    elevationMaps: [
      { id: 'none', name: '无高程（平面）', url: '' },
      { id: 'aws', name: 'AWS', url: 'https://s/{z}/{x}/{y}.png', encoding: 'terrarium', exaggeration: 0, style: 'https://s/y.json' },
    ],
    activeElevationMapId: 'aws',
  };
}

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed += 1;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? `\n         ${detail}` : ''}`);
};
const diffKeys = (a, b, keys) => keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

const db = open();
const src = project('rt', FPS);
saveProjectV2(db, src);
const got = getProjectV2(db, 'rt');

console.log('\n[1] 输入原值逐字往返');
const gcKeys = ['defaultDuration', 'defaultFPS', 'projection', 'defaultEasing'];
check('1.1 globalConfig 无漂移', diffKeys(src.globalConfig, got.globalConfig, gcKeys).length === 0,
  `差异: ${JSON.stringify(diffKeys(src.globalConfig, got.globalConfig, gcKeys))} · 存 ${JSON.stringify(src.globalConfig)} → 取 ${JSON.stringify(got.globalConfig)}`);
check('1.2 底图目录完整（URL 与内联样式对象并存）', JSON.stringify(got.baseMaps) === JSON.stringify(src.baseMaps),
  JSON.stringify(got.baseMaps));
check('1.3 高程目录完整，exaggeration=0 未被吞成默认值', JSON.stringify(got.elevationMaps) === JSON.stringify(src.elevationMaps),
  JSON.stringify(got.elevationMaps));
check('1.4 生效指针回读正确', got.activeBaseMapId === 'sat' && got.activeElevationMapId === 'aws',
  `${got.activeBaseMapId} / ${got.activeElevationMapId}`);
check('1.5 空串 url（无高程占位项）没有变成 undefined', got.elevationMaps[0]?.url === '', JSON.stringify(got.elevationMaps[0]));
check('1.6 帧率换算后 defaultDuration 回到原帧值', got.globalConfig.defaultDuration === src.globalConfig.defaultDuration,
  `${src.globalConfig.defaultDuration} → ${got.globalConfig.defaultDuration}`);

console.log('\n[2] 重复保存幂等（存 → 读 → 再存 → 再读 不变）');
{
  const db2 = open();
  saveProjectV2(db2, project('idem', FPS));
  const once = getProjectV2(db2, 'idem');
  saveProjectV2(db2, once);
  const twice = getProjectV2(db2, 'idem');
  const keys = ['baseMaps', 'elevationMaps', 'activeBaseMapId', 'activeElevationMapId', 'layers', 'music', 'overlays', 'fx'];
  check('2.1 二次往返无字段漂移', diffKeys(once, twice, keys).length === 0,
    `差异: ${JSON.stringify(diffKeys(once, twice, keys))}`);
  check('2.2 帧 ↔ 秒互逆：endFrame 稳定', twice.endFrame === once.endFrame, `${once.endFrame} → ${twice.endFrame}`);
  check('2.3 二次往返不产生重复行', getProjectV2(db2, 'idem').baseMaps.length === 2,
    JSON.stringify(getProjectV2(db2, 'idem').baseMaps.map((m) => m.id)));
}

console.log('\n[3] 同名内置 id 可跨项目共存（复合主键）');
{
  saveProjectV2(db, project('rt-b', FPS));
  const a = getProjectV2(db, 'rt');
  const b = getProjectV2(db, 'rt-b');
  check('3.1 两个项目各自持有整套底图', a.baseMaps.length === 2 && b.baseMaps.length === 2,
    `${a.baseMaps.length} / ${b.baseMaps.length}`);
  check('3.2 互不覆盖', a.baseMaps[0].name === 'OSM' && b.activeBaseMapId === 'sat');
}

console.log('\n[4] globalConfig 缺字段也得存得下去（写入端不得把「没配」写成 0）');
{
  const db4 = open();
  const bare = { id: 'bare', name: '没配时长', collectionId: 'default', layers: [], elements: [], camera: [], fx: [], overlays: [], music: [], narration: { entries: [], style: {} } };
  let err = null;
  try { saveProjectV2(db4, bare); } catch (e) { err = e; }
  check('4.1 缺 defaultDuration 不撞 CHECK (default_duration_sec > 0)', err === null, err && String(err.message));
  const g4 = err ? null : getProjectV2(db4, 'bare');
  check('4.2 落的是列默认 5 秒（30fps 下 = 150 帧）', g4?.globalConfig?.defaultDuration === 150,
    g4 && JSON.stringify(g4.globalConfig));
}

console.log('\n[5] 发音修正（narration.hot_fix_json）逐字往返');
{
  const db5 = open();
  const hotFix = { pronunciation: [{ 重庆: 'chong2 qing4' }, { 六安: 'lu4 an1' }], replace: [{ AI: '人工智能' }] };
  const p5 = { ...project('hf', FPS), narration: { entries: [], style: {}, hotFix } };
  saveProjectV2(db5, p5);
  const g5 = getProjectV2(db5, 'hf');
  check('5.1 存进去 = 取出来（一条 = 单键对象，顺序也不变）',
    JSON.stringify(g5?.narration?.hotFix) === JSON.stringify(hotFix), JSON.stringify(g5?.narration?.hotFix));
  const p5b = { ...project('hf2', FPS), narration: { entries: [], style: {} } };
  saveProjectV2(db5, p5b);
  check('5.2 没填修正 → 列存 NULL，读出来也不带假空对象', (() => {
    const row = db5.prepare('SELECT hot_fix_json FROM narration WHERE project_id=?').get('hf2');
    return row.hot_fix_json === null && getProjectV2(db5, 'hf2').narration?.hotFix == null;
  })());
}

console.log(`\n===== ${failed ? `${failed} 项失败` : '全部通过'} =====`);
process.exit(failed ? 1 : 0);
