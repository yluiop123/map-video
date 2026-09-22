/**
 * verify-provider-templates.mjs — 「模板组 + 接口行 + 能力实例」三张表的库侧回归
 *
 * 覆盖：全新库建表、模板组逐字往返、整组覆写不残留、实例读写与生效唯一、
 *       真外键（删被引用的组要拦住 / 删组级联删接口行）、异步配对自检视图，
 *       以及旧库（provider_endpoint 副本 + secrets_json）启动 → 让位 → 铺 seed → 搬回 Key。
 * 运行：node --experimental-sqlite tools/verify-provider-templates.mjs
 * 退出码非 0 表示有失败项。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureV2Schema, listTemplateGroupsV2, upsertTemplateGroupV2, removeTemplateGroupV2,
  listProvidersV2, upsertProviderV2, removeProviderV2, setActiveProviderV2, migrateProvidersFromStale,
} from '../electron/db-v2.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DDL = fs.readFileSync(path.join(HERE, '..', 'docs', 'db-schema-v2.sql'), 'utf8');

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed += 1;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail !== undefined && !pass ? `\n         ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
/** 递归按 key 排序后比较（列出来的字段顺序不该影响判定） */
const canon = (v) => Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
  : v;
const eq = (name, got, want) => check(name, JSON.stringify(canon(got)) === JSON.stringify(canon(want)), { got, want });
const fresh = () => {
  const db = new DatabaseSync(':memory:');
  check(`${'建表'} 成功`, ensureV2Schema(db) === true);
  db.exec('PRAGMA foreign_keys = ON');   // 主进程那边同样是开着的
  return db;
};

/** 一组三条接口（语音：合成 + 查询 + 克隆），字段故意给满，用来验逐字往返 */
const GROUP = {
  tplGroup: 'verify-tts', kind: 'tts', label: { zh: '校验用语音', en: 'Verify voice' },
  note: { zh: '只给回归用', en: 'regression only' },
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1', models: ['cosyvoice-v3.5-flash', 'qwen3-tts-flash'],
  defaultModel: 'cosyvoice-v3.5-flash', defaultVoice: 'longanyang',
  rows: [
    {
      role: 'synthesize', mode: 'sync', method: 'POST', url: '{baseUrl}/services/audio/tts/SpeechSynthesizer',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {apiKey}' }, query: {},
      body: { model: '{model}', input: { text: '{text}', voice: '{voice}' }, parameters: { format: '{format}' } },
      vars: [{ name: 'text', stage: 'call', type: 'string' }, { name: 'format', stage: 'instance', type: 'string', default: 'mp3', options: ['mp3', 'wav'] }],
      resp: { audio: '', errorCode: 'code', error: 'message' },
    },
    {
      role: 'query', mode: 'sync', method: 'GET', url: '{baseUrl}/api/v1/tasks/{taskId}',
      headers: { Authorization: 'Bearer {apiKey}' },
      resp: { audio: 'output.results[0].url', status: 'output.task_status', success: ['SUCCEEDED'], pending: ['RUNNING'], fail: ['FAILED', 'CANCELED'] },
      decode: 'url', fetchHeaders: { Authorization: 'Bearer {apiKey}' }, pollIntervalMs: 900, pollTimeoutMs: 45000,
    },
    {
      role: 'clone', mode: 'sync', method: 'POST', url: '{baseUrl}/services/audio/tts/customization',
      body: { model: 'voice-enrollment', input: { action: 'create_voice', target_model: '{model}', prefix: '{prefix}', url: 'data:audio/wav;base64,{wavB64}' } },
      vars: [{ name: 'wavB64', stage: 'call', type: 'string' }],
      resp: { voiceId: 'output.voice_id' }, refSampleRateHz: 16000,
    },
  ],
};

// ---------- 1. 模板组读写 ----------
console.log('\n[1] 模板组与接口行');
{
  const db = fresh();
  check('1.1 新库没有 provider_endpoint 表', !db.prepare("SELECT name FROM sqlite_master WHERE name='provider_endpoint'").get());
  check('1.2 三张表都在', [' provider_template_group', ' provider_template', ' provider'].every((n) => db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(n.trim())));
  check('1.3 空库 list 返回空', listTemplateGroupsV2(db).length === 0);

  upsertTemplateGroupV2(db, GROUP);
  const got = listTemplateGroupsV2(db).find((g) => g.tplGroup === 'verify-tts');
  eq('1.4 组头逐字往返（label/note 双语、models、默认值）',
    { label: got.label, note: got.note, baseUrl: got.baseUrl, models: got.models, defaultModel: got.defaultModel, defaultVoice: got.defaultVoice },
    { label: GROUP.label, note: GROUP.note, baseUrl: GROUP.baseUrl, models: GROUP.models, defaultModel: GROUP.defaultModel, defaultVoice: GROUP.defaultVoice });
  eq('1.5 三条接口行逐字往返', got.rows, GROUP.rows.map((r, i) => ({
    ...r, ord: i, tplId: `verify-tts:${r.role}:${r.mode}`,
    query: r.query ?? {}, headers: r.headers ?? {}, vars: r.vars ?? [],
    pollIntervalMs: r.role === 'query' ? 900 : 1500, pollTimeoutMs: r.role === 'query' ? 45000 : 120000,
  })));
  check('1.6 方括号下标原样存回', got.rows[1].resp.audio === 'output.results[0].url', got.rows[1].resp);
  check('1.7 音频槽留空不被吞（响应体即产物这条语义要能存）', got.rows[0].resp.audio === '', got.rows[0].resp);

  upsertTemplateGroupV2(db, { ...GROUP, rows: [GROUP.rows[0]] });
  const after = listTemplateGroupsV2(db).find((g) => g.tplGroup === 'verify-tts');
  check('1.8 整组覆写：删掉的行不残留', after.rows.length === 1 && after.rows[0].role === 'synthesize', after.rows.map((r) => r.role));
  check('1.9 同组同 role+mode 只能一条（唯一索引）', (() => {
    try {
      db.prepare(`INSERT INTO provider_template (tpl_id, tpl_group, role, mode, url) VALUES ('x1','verify-tts','synthesize','sync','/a')`).run();
      return false;
    } catch (e) { return /UNIQUE/i.test(String(e.message)); }
  })());
  db.close();
}

// ---------- 2. 实例读写与生效 ----------
console.log('\n[2] 能力实例');
{
  const db = fresh();
  upsertTemplateGroupV2(db, GROUP);
  const cfg = {
    id: 'tts-1', kind: 'tts', label: '通义配音', tplGroup: 'verify-tts', baseUrl: 'https://d/api/v1',
    apiKey: 'sk-长-KEY', apiKey2: 'ak-2', mode: 'async', model: 'cosyvoice-v3.5-flash', voice: 'longanyang',
    speed: 1.2, params: { format: 'wav' }, maxConcurrency: 3, retryTimes: 0, extra: '{"a":1}',
  };
  upsertProviderV2(db, cfg);
  const got = listProvidersV2(db).find((c) => c.id === 'tts-1');
  eq('2.1 实例逐字往返（含两把 Key / mode / params / 并发重试）', { ...got, sort: undefined }, { ...cfg, active: false });
  upsertProviderV2(db, { ...cfg, apiKey: 'sk-改过的', params: { format: 'mp3' }, maxConcurrency: 1 });
  const again = listProvidersV2(db).find((c) => c.id === 'tts-1');
  check('2.2 改 Key 与参数写回同一行', again.apiKey === 'sk-改过的' && again.params.format === 'mp3' && again.maxConcurrency === 1);
  check('2.3 第二凭证可以留空', (() => {
    upsertProviderV2(db, { ...cfg, id: 'tts-2', apiKey2: undefined });
    return listProvidersV2(db).find((c) => c.id === 'tts-2').apiKey2 === undefined;
  })());
  setActiveProviderV2(db, 'tts', 'tts-1');
  setActiveProviderV2(db, 'tts', 'tts-2');
  eq('2.4 切生效时旧生效行自动落下', listProvidersV2(db).filter((c) => c.kind === 'tts' && c.active).map((c) => c.id), ['tts-2']);
  check('2.5 同一 kind 两条生效被唯一索引拦住', (() => {
    try { db.prepare("UPDATE provider SET active = 1 WHERE provider_id = 'tts-1'").run(); return false; }
    catch (e) { return /UNIQUE/i.test(String(e.message)); }
  })());
  check('2.6 tpl_group 是真外键：删掉被引用的组会拦住', (() => {
    try { removeTemplateGroupV2(db, 'verify-tts'); return false; }
    catch (e) { return /FOREIGN KEY/i.test(String(e.message)); }
  })());
  removeProviderV2(db, 'tts-1');
  removeProviderV2(db, 'tts-2');
  removeTemplateGroupV2(db, 'verify-tts');
  check('2.7 没人引用后删组，接口行随级联一起清', db.prepare("SELECT COUNT(*) c FROM provider_template WHERE tpl_group='verify-tts'").get().c === 0);
  db.close();
}

// ---------- 3. 异步配对自检 ----------
console.log('\n[3] 异步配对自检视图');
{
  const db = fresh();
  upsertTemplateGroupV2(db, { ...GROUP, rows: [GROUP.rows[1]] });   // 只有查询行，没有异步生成行
  upsertProviderV2(db, { id: 'a1', kind: 'tts', label: '', tplGroup: 'verify-tts', baseUrl: '', apiKey: '', mode: 'async', model: '', params: {} });
  const hit = db.prepare("SELECT problem FROM v_check_async_pairing WHERE ref_id='a1'").get();
  check('3.1 异步实例缺异步生成接口 → 视图抓到', !!hit && hit.problem.includes('异步的生成接口'), hit);
  upsertTemplateGroupV2(db, { ...GROUP, rows: [GROUP.rows[0], { ...GROUP.rows[0], role: 'synthesize', mode: 'async', resp: { taskId: 'output.task_id' } }] });
  const hit2 = db.prepare("SELECT problem FROM v_check_async_pairing WHERE ref_id='a1'").get();
  check('3.2 有异步生成但没查询行 → 换个措辞抓到', !!hit2 && hit2.problem.includes('查询接口'), hit2);
  upsertTemplateGroupV2(db, { ...GROUP, rows: [...GROUP.rows, { ...GROUP.rows[0], role: 'synthesize', mode: 'async', resp: { taskId: 'output.task_id' } }] });
  check('3.3 配齐后自检清零', db.prepare("SELECT COUNT(*) c FROM v_check_async_pairing WHERE ref_id='a1'").get().c === 0);
  upsertProviderV2(db, { id: 's1', kind: 'tts', label: '', tplGroup: 'verify-tts', baseUrl: '', apiKey: '', mode: 'sync', model: '', params: {} });
  check('3.4 同步实例不参与这条自检', db.prepare("SELECT COUNT(*) c FROM v_check_async_pairing WHERE ref_id='s1'").get().c === 0);
  db.close();
}

// ---------- 4. 旧库启动 → 让位 → 铺 seed → 搬回 ----------
console.log('\n[4] 旧形状（provider_endpoint 副本 + secrets_json）搬迁');
{
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE provider (
    provider_id TEXT PRIMARY KEY, kind TEXT NOT NULL, recipe TEXT NOT NULL DEFAULT '', label TEXT NOT NULL DEFAULT '',
    base_url TEXT NOT NULL DEFAULT '', secrets_json TEXT, model TEXT NOT NULL DEFAULT '', voice TEXT,
    speed REAL NOT NULL DEFAULT 1, extra TEXT, active INTEGER NOT NULL DEFAULT 0, ord INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX ux_provider_active ON provider(kind) WHERE active = 1;
    CREATE TABLE provider_endpoint (
    endpoint_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, role TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1, mode TEXT NOT NULL DEFAULT 'sync', method TEXT NOT NULL DEFAULT 'POST',
    path TEXT NOT NULL DEFAULT '', headers_json TEXT, query_json TEXT, body_json TEXT, vars_json TEXT,
    overrides_json TEXT, resp_kind TEXT, decode_kind TEXT, pick_json TEXT, poll_json TEXT);`);
  db.prepare(`INSERT INTO provider (provider_id, kind, recipe, label, base_url, secrets_json, model, voice, active, ord)
    VALUES ('llm-1','llm','openai-chat','DeepSeek','https://api.deepseek.com','{"apiKey":"sk-<用户的长 Key 不得丢>"}','deepseek-chat','',1,1)`).run();
  db.prepare(`INSERT INTO provider (provider_id, kind, recipe, label, base_url, secrets_json, model, voice, active, ord)
    VALUES ('img-1','image','dashscope-image','通义出图','https://d/api/v1','{"apiKey":"sk-i"}','z-image-turbo','',1,2)`).run();
  db.prepare(`INSERT INTO provider_endpoint (endpoint_id, provider_id, role, mode, overrides_json)
    VALUES ('img-1:image.generate','img-1','image.generate','async','{"size":"2048*1152","watermark":true}')`).run();

  check('4.1 ensureV2Schema 成功', ensureV2Schema(db) === true);
  check('4.2 旧表让位但没被删（Key 还在）', !!db.prepare("SELECT name FROM sqlite_master WHERE name='provider__stale'").get()
    && !!db.prepare("SELECT name FROM sqlite_master WHERE name='provider_endpoint__stale'").get());
  check('4.3 新表已无 recipe / secrets_json 列', (() => {
    const cols = db.prepare('PRAGMA table_info(provider)').all().map((c) => c.name);
    return !cols.includes('recipe') && !cols.includes('secrets_json') && cols.includes('tpl_group') && cols.includes('api_key');
  })());
  check('4.4 模板组没铺之前 migrate 搬不动（返回 0 且 stale 表留着）',
    migrateProvidersFromStale(db) === 0 && !!db.prepare("SELECT name FROM sqlite_master WHERE name='provider__stale'").get());

  db.exec('PRAGMA foreign_keys = ON');
  upsertTemplateGroupV2(db, { tplGroup: 'openai-chat', kind: 'llm', label: 'OpenAI 兼容对话', rows: [{ role: 'generate', mode: 'sync', url: '{baseUrl}/chat/completions', vars: [], resp: { content: 'choices[0].message.content' } }] });
  upsertTemplateGroupV2(db, { tplGroup: 'dashscope-image', kind: 'image', label: '通义图片', rows: [{ role: 'generate', mode: 'async', url: '{baseUrl}/submit', vars: [{ name: 'size', stage: 'instance' }], resp: { taskId: 'output.task_id' } }] });
  const moved = migrateProvidersFromStale(db);
  eq('4.5 两行都搬回', moved, 2);
  const list = listProvidersV2(db);
  const byId = Object.fromEntries(list.map((r) => [r.id, r]));
  check('4.6 Key 从 secrets_json 搬进 api_key 列', byId['llm-1'].apiKey === 'sk-<用户的长 Key 不得丢>', byId['llm-1'].apiKey);
  eq('4.7 recipe → tpl_group', { llm: byId['llm-1'].tplGroup, img: byId['img-1'].tplGroup }, { llm: 'openai-chat', img: 'dashscope-image' });
  check('4.8 模型 / 音色 / 生效标记保住', byId['llm-1'].model === 'deepseek-chat' && byId['llm-1'].active === true);
  eq('4.9 散在接口行的 overrides 汇总成 params_json', byId['img-1'].params, { size: '2048*1152', watermark: true });
  check('4.10 旧接口行有 async → 实例 mode 变异步', byId['img-1'].mode === 'async');
  check('4.11 搬完不留 stale 表', !db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%__stale'").get());
  check('4.12 幂等：再跑一次不重复搬', migrateProvidersFromStale(db) === 0 && listProvidersV2(db).length === 2);
  db.close();
}

console.log(`\n===== ${failed ? `${failed} 项失败` : '全部通过'} =====`);
process.exit(failed ? 1 : 0);
