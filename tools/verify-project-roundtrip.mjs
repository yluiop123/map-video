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
import { saveProjectV2, getProjectV2, ensureV2Schema, saveBaseMapV2, listBaseMapsV2, saveElevationMapV2, listElevationMapsV2, removeBaseMapV2 } from '../electron/db-v2.mjs';

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
    // 目录是全局一份的数据（见 [7] 节）；项目只记选了哪一行 + 夸张系数
    activeBaseMapId: 'sat',
    activeElevationMapId: 'aws',
    terrainExaggeration: 0,
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
check('1.2 生效指针回读正确（指向全局目录的两行）', got.activeBaseMapId === 'sat' && got.activeElevationMapId === 'aws',
  `${got.activeBaseMapId} / ${got.activeElevationMapId}`);
check('1.3 地形夸张 0（完全平坦）没被吞成默认值 1.5', got.terrainExaggeration === 0,
  `存 0 → 取 ${JSON.stringify(got.terrainExaggeration)}`);
check('1.4 目录不在项目数据里了（项目不再自带一套底图）',
  got.baseMaps === undefined && got.elevationMaps === undefined,
  JSON.stringify(Object.keys(got).filter((k) => /maps?/i.test(k))));
check('1.6 帧率换算后 defaultDuration 回到原帧值', got.globalConfig.defaultDuration === src.globalConfig.defaultDuration,
  `${src.globalConfig.defaultDuration} → ${got.globalConfig.defaultDuration}`);

console.log('\n[2] 重复保存幂等（存 → 读 → 再存 → 再读 不变）');
{
  const db2 = open();
  saveProjectV2(db2, project('idem', FPS));
  const once = getProjectV2(db2, 'idem');
  saveProjectV2(db2, once);
  const twice = getProjectV2(db2, 'idem');
  const keys = ['activeBaseMapId', 'activeElevationMapId', 'terrainExaggeration', 'layers', 'music', 'overlays', 'fx'];
  check('2.1 二次往返无字段漂移', diffKeys(once, twice, keys).length === 0,
    `差异: ${JSON.stringify(diffKeys(once, twice, keys))}`);
  check('2.2 帧 ↔ 秒互逆：endFrame 稳定', twice.endFrame === once.endFrame, `${once.endFrame} → ${twice.endFrame}`);
  check('2.3 二次往返夸张系数仍是 0（没被默认值冲掉）', twice.terrainExaggeration === 0,
    JSON.stringify(twice.terrainExaggeration));
}

console.log('\n[3] 两个项目共用同一套全局目录');
{
  // 目录行由渲染端启动时按常量铺（saveProjectV2 从此不管目录）：这里做同一件事
  saveBaseMapV2(db, { id: 'osm', name: 'OSM', style: 'https://a/b.json' }, 0);
  saveBaseMapV2(db, { id: 'sat', name: '卫星', style: { version: 8, sources: {}, layers: [] } }, 1);
  saveProjectV2(db, project('rt-b', FPS));
  const a = getProjectV2(db, 'rt');
  const b = getProjectV2(db, 'rt-b');
  check('3.1 目录只有一份（不再是每个项目复制一套）', listBaseMapsV2(db).length === 2,
    JSON.stringify(listBaseMapsV2(db).map((m) => m.id)));
  check('3.2 两个项目各指各的行', a.activeBaseMapId === 'sat' && b.activeBaseMapId === 'sat');
  check('3.3 删掉一行只是少一个可选项：引用它的项目照样读得回来', (() => {
    removeBaseMapV2(db, 'sat');
    const g = getProjectV2(db, 'rt');
    return g.activeBaseMapId === 'sat' && listBaseMapsV2(db).length === 1;
  })());
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

console.log('\n[5b] 字幕间隔（gap_sec）：存输入原值，三态分得开');
{
  const db5b = open();
  const gapEntries = [
    { id: 'g1', text: '跟整片', durationFrames: 60, startFrame: 0 },
    { id: 'g2', text: '明确不间隔', durationFrames: 60, startFrame: 60, gapSec: 0 },
    { id: 'g3', text: '单独 0.7 秒', durationFrames: 60, startFrame: 120, gapSec: 0.7 },
  ];
  saveProjectV2(db5b, { ...project('gap', FPS), narration: { entries: gapEntries, style: {}, gapSec: 0.5 } });
  const g5b = getProjectV2(db5b, 'gap');
  check('5b.1 整片间隔原样往返（秒，不经帧换算）', g5b?.narration?.gapSec === 0.5, g5b?.narration?.gapSec);
  check('5b.2 三态分得开：未填 / 0 / 0.7',
    JSON.stringify(g5b?.narration?.entries?.map((e) => (e.gapSec === undefined ? 'null' : e.gapSec))) === '["null",0,0.7]',
    JSON.stringify(g5b?.narration?.entries?.map((e) => (e.gapSec === undefined ? 'null' : e.gapSec))));
  const row5b = db5b.prepare('SELECT gap_sec FROM narration WHERE project_id=?').get('gap');
  check('5b.3 库里就是那一列（0.5 秒），没被 f2s 乘成 15', row5b.gap_sec === 0.5, row5b.gap_sec);
  saveProjectV2(db5b, { ...project('gap0', FPS), narration: { entries: [], style: {} } });
  check('5b.4 老数据没这个值 → 读出来是 0（不是 undefined 也不是假默认）',
    getProjectV2(db5b, 'gap0')?.narration?.gapSec === 0, getProjectV2(db5b, 'gap0')?.narration?.gapSec);
}

console.log('\n[5c] 配音音量（narration.volume）：只有整片这一层，0 是有效值');
{
  const db5c = open();
  saveProjectV2(db5c, { ...project('vol', FPS), narration: { entries: [{ id: 'v1', text: '一句', durationFrames: 60, startFrame: 0 }], style: {}, volume: 0.8 } });
  const v = getProjectV2(db5c, 'vol');
  check('5c.1 整片音量原样往返', v?.narration?.volume === 0.8, v?.narration?.volume);
  saveProjectV2(db5c, { ...project('vol25', FPS), narration: { entries: [], style: {}, volume: 2.5 } });
  check('5c.1b 超过 100% 存得下（CHECK 已放宽到 3：>1 走本地增益，不重跑配音）',
    getProjectV2(db5c, 'vol25')?.narration?.volume === 2.5, getProjectV2(db5c, 'vol25')?.narration?.volume);
  check('5c.2 条目上没有音量这一层（要一句一句响是合成参数的事，不是混音）',
    v?.narration?.entries?.[0]?.volume === undefined, v?.narration?.entries?.[0]);
  saveProjectV2(db5c, { ...project('vol0', FPS), narration: { entries: [], style: {}, volume: 0 } });
  check('5c.3 0 存得下也读得回（`||` 会把它吞成满格）', getProjectV2(db5c, 'vol0')?.narration?.volume === 0);
  saveProjectV2(db5c, { ...project('vol1', FPS), narration: { entries: [], style: {} } });
  check('5c.4 老项目没这个值 → 读出来是 1（满格，不是 0 静音）',
    getProjectV2(db5c, 'vol1')?.narration?.volume === 1, getProjectV2(db5c, 'vol1')?.narration?.volume);
}

console.log('\n[6] 音频只存 assetId（字节不进项目数据）');
{
  const db6 = open();
  db6.prepare(`INSERT INTO asset (asset_id, kind, name, mime, storage, rel_path, created_at)
    VALUES ('as_voice','audio','voice.mp3','audio/mpeg','file','media/audio/voice.mp3',1)`).run();
  db6.prepare(`INSERT INTO asset (asset_id, kind, name, mime, storage, rel_path, created_at)
    VALUES ('as_bgm','audio','bgm.mp3','audio/mpeg','file','media/audio/bgm.mp3',1)`).run();
  const withAudio = {
    ...project('audio', FPS),
    narration: { entries: [{ id: 'e1', text: '一句', audioId: 'as_voice', durationFrames: 90, startFrame: 0 }], style: {} },
    music: [{ id: 'm1', name: '铺底', audioId: 'as_bgm', startFrame: 0, endFrame: 300, volume: 0.5, loop: false, fadeIn: 0, fadeOut: 0 }],
    overlays: [{
      id: 'o1', type: 'custom', name: '语音卡', position: 'top', startFrame: 0, endFrame: 60,
      content: { type: 'custom', custom: { blocks: [], audio: { audioId: 'as_voice', title: '旁白' } } },
    }],
  };
  saveProjectV2(db6, withAudio);
  const g6 = getProjectV2(db6, 'audio');
  check('6.1 配音 / BGM 的 id 逐字回来', g6.narration?.entries[0]?.audioId === 'as_voice' && g6.music[0]?.audioId === 'as_bgm',
    JSON.stringify({ n: g6.narration?.entries[0], m: g6.music[0] }));
  check('6.2 弹窗语音从 audio_asset_id 列装回 payload（标题在 payload 里）',
    g6.overlays[0]?.content?.custom?.audio?.audioId === 'as_voice' && g6.overlays[0]?.content?.custom?.audio?.title === '旁白',
    JSON.stringify(g6.overlays[0]?.content));
  check('6.3 id 不在 payload_json 里留第二份（同一条事实只有列那一处）', (() => {
    const row = db6.prepare("SELECT payload_json, audio_asset_id FROM overlay WHERE overlay_id='o1'").get();
    return !String(row.payload_json).includes('as_voice') && row.audio_asset_id === 'as_voice';
  })());
  db6.exec('PRAGMA foreign_keys = ON');
  db6.prepare("DELETE FROM asset WHERE asset_id='as_voice'").run();
  const after = getProjectV2(db6, 'audio');
  check('6.4 删素材 → 引用被 FK 置空，不留悬空 id', after.narration?.entries[0]?.audioId === undefined
    && after.overlays[0]?.content?.custom?.audio?.audioId === undefined, JSON.stringify(after.narration?.entries[0]));
  db6.close();
}

console.log('\n[7] 全局目录：样式只一格，两种形状都认');
{
  const db7 = open();
  saveBaseMapV2(db7, { id: 'osm', name: 'OSM', style: 'https://a/b.json' }, 0);
  saveBaseMapV2(db7, { id: 'sat', name: '卫星', style: { version: 8, sources: {}, layers: [] } }, 1);
  const rows = listBaseMapsV2(db7);
  check('7.1 样式 URL 存成 JSON 字符串、取回来还是字符串', rows[0].style === 'https://a/b.json', JSON.stringify(rows[0]));
  check('7.2 内联样式对象存进同一格、取回来还是对象（不再拆两列）',
    JSON.stringify(rows[1].style) === JSON.stringify({ version: 8, sources: {}, layers: [] }), JSON.stringify(rows[1]));
  check('7.3 顺序按 ord，不靠 id 蒙', rows.map((r) => r.id).join(',') === 'osm,sat', rows.map((r) => r.id).join(','));
  saveBaseMapV2(db7, { id: 'osm', name: 'OSM 改名', style: 'https://c/d.json' }, 0);
  check('7.4 同一 id 再存是覆盖不是插行',
    listBaseMapsV2(db7).length === 2 && listBaseMapsV2(db7)[0].name === 'OSM 改名', JSON.stringify(listBaseMapsV2(db7)));
  saveElevationMapV2(db7, { id: 'none', name: '无高程（平面）', url: '' }, 0);
  saveElevationMapV2(db7, { id: 'aws', name: 'AWS', url: 'https://s/{z}/{x}/{y}.png', encoding: 'terrarium' }, 1);
  const elev = listElevationMapsV2(db7);
  check('7.5 空串 url（占位项）没变成 undefined，也没有假造的缺省 encoding',
    elev[0].url === '' && elev[0].encoding === undefined && elev[1].encoding === 'terrarium', JSON.stringify(elev));
  check('7.6 高程行不带夸张系数（它在 project 上）', !('exaggeration' in elev[1]), JSON.stringify(elev[1]));
}

console.log('\n[8] 旧库的「每项目一套目录」启动让位');
{
  const legacy = new DatabaseSync(':memory:');
  legacy.exec(`CREATE TABLE project (project_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE base_map (base_map_id TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT, style_url TEXT, style_json TEXT, ord INTEGER, PRIMARY KEY (project_id, base_map_id));
    CREATE TABLE elevation_map (elevation_map_id TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT, url TEXT, encoding TEXT, exaggeration REAL, style_url TEXT, ord INTEGER, PRIMARY KEY (project_id, elevation_map_id));`);
  legacy.prepare(`INSERT INTO project (project_id,name,created_at,updated_at) VALUES ('lp','旧项目',1,1)`).run();
  legacy.prepare(`INSERT INTO base_map (base_map_id,project_id,name,style_url,style_json,ord) VALUES (?,?,?,?,?,?)`)
    .run('osm', 'lp', 'OSM', 'https://a/b.json', null, 0);
  legacy.prepare(`INSERT INTO elevation_map (elevation_map_id,project_id,name,url,exaggeration,ord) VALUES (?,?,?,?,?,?)`)
    .run('aws', 'lp', 'AWS', 'https://s', 1.5, 0);
  const ok = ensureV2Schema(legacy);
  const colsOf = (t) => legacy.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  check('8.1 让位后新表是全局形状（没有 project_id 了）',
    ok === true && !colsOf('base_map').includes('project_id') && !colsOf('elevation_map').includes('project_id'),
    `${colsOf('base_map')} / ${colsOf('elevation_map')}`);
  check('8.2 样式只留一格（style_url 不再成列）',
    !colsOf('base_map').includes('style_url') && colsOf('base_map').includes('style_json'), colsOf('base_map').join(','));
  check('8.3 夸张系数换了主人（project 上有这一列）', colsOf('project').includes('terrain_exaggeration'),
    colsOf('project').join(','));
  check('8.4 旧表改名归档、不是直接删（里面可能有用户手改过的行）',
    !!legacy.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='base_map__scoped_stale'").get());
  check('8.5 旧行没被搬进新表（那是每项目一套的复制品，由渲染端按常量重铺）',
    legacy.prepare('SELECT COUNT(*) c FROM base_map').get().c === 0);
}

console.log(`\n===== ${failed ? `${failed} 项失败` : '全部通过'} =====`);
process.exit(failed ? 1 : 0);
