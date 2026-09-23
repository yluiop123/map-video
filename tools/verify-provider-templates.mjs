/**
 * verify-provider-templates.mjs — 「模板组 + 接口行 + 能力实例」三张表的库侧回归
 *
 * 覆盖：全新库建表、模板组逐字往返、整组覆写不残留、实例读写与生效唯一、
 *       真外键（删被引用的组要拦住 / 删组级联删接口行）、异步配对自检视图，
 *       旧库（provider_endpoint 副本 + secrets_json）启动 → 让位 → 铺 seed → 搬回 Key，
 *       以及模板表自身的形状漂移（vars_json 一列 → inst/req 两列）让位重铺后外键与索引不坏。
 * 运行：node --experimental-sqlite tools/verify-provider-templates.mjs
 * 退出码非 0 表示有失败项。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureV2Schema, listTemplateGroupsV2, upsertTemplateGroupV2, removeTemplateGroupV2,
  listProvidersV2, upsertProviderV2, migrateProvidersFromStale,
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
  tplGroup: 'verify-tts', kind: 'tts', label: '校验用语音',
  note: '只给回归用',
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1', models: ['cosyvoice-v3.5-flash', 'qwen3-tts-flash'],
  defaultModel: 'cosyvoice-v3.5-flash', defaultVoice: 'longanyang',
  rows: [
    {
      role: 'synthesize', mode: 'sync', method: 'POST', url: '{baseUrl}/services/audio/tts/SpeechSynthesizer',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {apiKey}' }, query: {},
      body: { model: '{model}', input: { text: '{text}', voice: '{voice}' }, parameters: { format: '{format}' } },
      reqParams: [{ name: 'text', type: 'string' }],
      instParams: [{ name: 'format', type: 'string', default: 'mp3', options: ['mp3', 'wav'] }],
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
      reqParams: [{ name: 'wavB64', type: 'string' }],
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
  eq('1.4 组头逐字往返（label/note 是单个字符串、models、默认值）',
    { label: got.label, note: got.note, baseUrl: got.baseUrl, models: got.models, defaultModel: got.defaultModel, defaultVoice: got.defaultVoice },
    { label: GROUP.label, note: GROUP.note, baseUrl: GROUP.baseUrl, models: GROUP.models, defaultModel: GROUP.defaultModel, defaultVoice: GROUP.defaultVoice });
  eq('1.5 三条接口行逐字往返', got.rows, GROUP.rows.map((r, i) => ({
    ...r, ord: i, tplId: `verify-tts:${r.role}:${r.mode}`,
    query: r.query ?? {}, headers: r.headers ?? {}, instParams: r.instParams ?? [], reqParams: r.reqParams ?? [],
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

// ---------- 2. 一处一份（kind 主键） ----------
console.log('\n[2] 能力配置：一个能力一行');
{
  const db = fresh();
  upsertTemplateGroupV2(db, GROUP);
  const cfg = {
    kind: 'tts', tplGroup: 'verify-tts', baseUrl: 'https://d/api/v1',
    apiKey: 'sk-长-KEY', apiKey2: 'ak-2', mode: 'async', model: 'cosyvoice-v3.5-flash', voice: 'longanyang',
    speed: 1.2, params: { format: 'wav' }, maxConcurrency: 3, retryTimes: 0, extra: '{"a":1}',
  };
  upsertProviderV2(db, cfg);
  const got = listProvidersV2(db).find((c) => c.kind === 'tts');
  eq('2.1 逐字往返（两把 Key / mode / params / 并发重试；行身份就是 kind）', { ...got, id: undefined }, cfg);
  upsertProviderV2(db, { ...cfg, apiKey: 'sk-改过的', params: { format: 'mp3' }, maxConcurrency: 1 });
  const again = listProvidersV2(db).find((c) => c.kind === 'tts');
  check('2.2 再存一次是覆盖那一行，不是又加一条', listProvidersV2(db).length === 1
    && again.apiKey === 'sk-改过的' && again.params.format === 'mp3' && again.maxConcurrency === 1);
  const cur = listProvidersV2(db).find((c) => c.kind === 'tts');
  upsertProviderV2(db, { ...cur, apiKey2: undefined });
  check('2.3 第二凭证可以留空（存回同一行）', listProvidersV2(db).find((c) => c.kind === 'tts').apiKey2 === undefined);
  upsertProviderV2(db, { ...cfg, kind: 'llm', apiKey: 'sk-llm' });
  eq('2.4 一个能力一行（llm 与 tts 互不干扰）', listProvidersV2(db).map((c) => `${c.kind}:${c.apiKey}`), ['llm:sk-llm', 'tts:sk-改过的']);
  check('2.5 想给同一 kind 插第二行会被主键拦住', (() => {
    try { db.prepare("INSERT INTO provider (kind, tpl_group) VALUES ('llm','verify-tts')").run(); return false; }
    catch (e) { return /UNIQUE|PRIMARY/i.test(String(e.message)); }
  })());
  db.prepare("DELETE FROM provider WHERE kind = 'tts'").run();
  check('2.6 清掉一行不碰另一行（一能力一行 = 主键即身份）', listProvidersV2(db).map((c) => c.kind).join() === 'llm');
  check('2.7 tpl_group 是真外键：删掉被引用的组会拦住', (() => {
    try { removeTemplateGroupV2(db, 'verify-tts'); return false; }
    catch (e) { return /FOREIGN KEY/i.test(String(e.message)); }
  })());
  db.prepare("DELETE FROM provider WHERE kind = 'llm'").run();
  removeTemplateGroupV2(db, 'verify-tts');
  check('2.8 没人引用后删组，接口行随级联一起清', db.prepare("SELECT COUNT(*) c FROM provider_template WHERE tpl_group='verify-tts'").get().c === 0);
  db.close();
}

// ---------- 3. 异步配对自检 ----------
console.log('\n[3] 异步配对自检视图');
{
  const db = fresh();
  upsertTemplateGroupV2(db, { ...GROUP, rows: [GROUP.rows[1]] });   // 只有查询行，没有异步生成行
  upsertProviderV2(db, { kind: 'tts', tplGroup: 'verify-tts', baseUrl: '', apiKey: '', mode: 'async', model: '', params: {} });
  const hit = db.prepare("SELECT problem FROM v_check_async_pairing WHERE ref_id='tts'").get();
  check('3.1 异步实例缺异步生成接口 → 视图抓到', !!hit && hit.problem.includes('异步的生成接口'), hit);
  upsertTemplateGroupV2(db, { ...GROUP, rows: [GROUP.rows[0], { ...GROUP.rows[0], role: 'synthesize', mode: 'async', resp: { taskId: 'output.task_id' } }] });
  const hit2 = db.prepare("SELECT problem FROM v_check_async_pairing WHERE ref_id='tts'").get();
  check('3.2 有异步生成但没查询行 → 换个措辞抓到', !!hit2 && hit2.problem.includes('查询接口'), hit2);
  upsertTemplateGroupV2(db, { ...GROUP, rows: [...GROUP.rows, { ...GROUP.rows[0], role: 'synthesize', mode: 'async', resp: { taskId: 'output.task_id' } }] });
  check('3.3 配齐后自检清零', db.prepare("SELECT COUNT(*) c FROM v_check_async_pairing WHERE ref_id='tts'").get().c === 0);
  upsertProviderV2(db, { kind: 'tts', tplGroup: 'verify-tts', baseUrl: '', apiKey: '', mode: 'sync', model: '', params: {} });
  check('3.4 改成同步后不参与这条自检', db.prepare("SELECT COUNT(*) c FROM v_check_async_pairing").get().c === 0);
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
  upsertTemplateGroupV2(db, { tplGroup: 'openai-chat', kind: 'llm', label: 'OpenAI 兼容对话', rows: [{ role: 'generate', mode: 'sync', url: '{baseUrl}/chat/completions', instParams: [], reqParams: [], resp: { content: 'choices[0].message.content' } }] });
  upsertTemplateGroupV2(db, { tplGroup: 'dashscope-image', kind: 'image', label: '通义图片', rows: [{ role: 'generate', mode: 'async', url: '{baseUrl}/submit', instParams: [{ name: 'size' }], reqParams: [], resp: { taskId: 'output.task_id' } }] });
  const moved = migrateProvidersFromStale(db);
  eq('4.5 两个能力各搬回一行', moved, 2);
  const byKind = Object.fromEntries(listProvidersV2(db).map((r) => [r.kind, r]));
  check('4.6 Key 从 secrets_json 搬进 api_key 列', byKind.llm.apiKey === 'sk-<用户的长 Key 不得丢>', byKind.llm.apiKey);
  eq('4.7 recipe → tpl_group', { llm: byKind.llm.tplGroup, image: byKind.image.tplGroup }, { llm: 'openai-chat', image: 'dashscope-image' });
  check('4.8 模型 / 音色保住（行身份 = kind，不再有"哪条生效"）', byKind.llm.model === 'deepseek-chat' && byKind.llm.id === 'llm');
  eq('4.9 散在接口行的 overrides 汇总成 params_json', byKind.image.params, { size: '2048*1152', watermark: true });
  check('4.10 旧接口行有 async → 该能力的 mode 变异步', byKind.image.mode === 'async');
  check('4.11 搬完不留 stale 表', !db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%__stale'").get());
  check('4.12 幂等：再跑一次不重复搬', migrateProvidersFromStale(db) === 0 && listProvidersV2(db).length === 2);
  db.close();
}

// ---------- 5. 模板表形状漂移：vars_json 一列（带 stage）→ inst/req 两列 ----------
console.log('\n[5] 旧模板表（vars_json / 行级 label）让位重铺');
{
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE provider_template_group (tpl_group TEXT PRIMARY KEY, kind TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '', note TEXT, base_url TEXT NOT NULL DEFAULT '', models_json TEXT,
      default_model TEXT NOT NULL DEFAULT '', default_voice TEXT, ord INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE provider_template (tpl_id TEXT PRIMARY KEY,
      tpl_group TEXT NOT NULL REFERENCES provider_template_group(tpl_group) ON DELETE CASCADE,
      role TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'sync', ord INTEGER NOT NULL DEFAULT 0,
      label TEXT, method TEXT NOT NULL DEFAULT 'POST', url TEXT NOT NULL DEFAULT '',
      headers_json TEXT, query_json TEXT, body_json TEXT, vars_json TEXT, resp_json TEXT,
      decode_kind TEXT, fetch_headers_json TEXT, poll_interval_ms INTEGER NOT NULL DEFAULT 1500,
      poll_timeout_ms INTEGER NOT NULL DEFAULT 120000, ref_sample_rate INTEGER);
    CREATE UNIQUE INDEX ux_tpl_role ON provider_template(tpl_group, role, mode);
    CREATE INDEX ix_tpl_group ON provider_template(tpl_group, ord);
    CREATE TABLE provider (kind TEXT PRIMARY KEY,
      tpl_group TEXT NOT NULL REFERENCES provider_template_group(tpl_group),
      base_url TEXT NOT NULL DEFAULT '', api_key TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'sync',
      model TEXT NOT NULL DEFAULT '', params_json TEXT, max_concurrency INTEGER NOT NULL DEFAULT 1,
      retry_times INTEGER NOT NULL DEFAULT 2);
    CREATE INDEX ix_provider_tpl ON provider(tpl_group);`);
  db.prepare(`INSERT INTO provider_template_group (tpl_group, kind, label) VALUES ('openai-chat','llm','我改过的组名')`).run();
  db.prepare(`INSERT INTO provider_template (tpl_id, tpl_group, role, mode, url, vars_json)
    VALUES ('openai-chat:generate:sync','openai-chat','generate','sync','{baseUrl}/chat/completions',
            '[{"name":"temperature","stage":"instance","label":{"zh":"温度","en":"Temp"}}]')`).run();
  db.prepare(`INSERT INTO provider (kind, tpl_group, api_key, model)
    VALUES ('llm','openai-chat','sk-不得丢','deepseek-chat')`).run();

  check('5.1 ensureV2Schema 成功', ensureV2Schema(db) === true);
  const staleCols = db.prepare('PRAGMA table_info(provider_template__stale)').all().map((c) => c.name);
  check('5.2 旧模板两表让位但没删（用户改过的模板要留档）',
    staleCols.includes('vars_json') && !!db.prepare("SELECT 1 FROM provider_template__stale LIMIT 1").get()
    && !!db.prepare("SELECT label FROM provider_template_group__stale WHERE tpl_group='openai-chat'").get());
  const tc = db.prepare('PRAGMA table_info(provider_template)').all().map((c) => c.name);
  check('5.3 新表按新形状建好（inst/req 两列、无行级 label）',
    tc.includes('inst_params_json') && tc.includes('req_params_json') && !tc.includes('vars_json') && !tc.includes('label'), tc);
  const fkSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider'").get().sql;
  check('5.4 改名没把实例的外键写成死表（让位改名要先关 foreign_keys）',
    !fkSql.includes('__stale'), fkSql);
  const idx = (t) => db.prepare(`PRAGMA index_list(${t})`).all().map((i) => i.name);
  check('5.5 索引没跟着旧表跑掉（新表上唯一 + 外键索引都在）',
    idx('provider_template').includes('ux_tpl_role') && idx('provider_template').includes('ix_tpl_group')
    && idx('provider').includes('ix_provider_tpl'), { t: idx('provider_template'), p: idx('provider') });

  db.exec('PRAGMA foreign_keys = ON');
  check('5.6 让位后模板表是空的（hydrate 的 seed-if-empty 会重铺）',
    db.prepare('SELECT COUNT(*) c FROM provider_template').get().c === 0);
  upsertTemplateGroupV2(db, { tplGroup: 'openai-chat', kind: 'llm', label: 'OpenAI 兼容对话',
    rows: [{ role: 'generate', mode: 'sync', url: '{baseUrl}/chat/completions',
      instParams: [{ name: 'temperature', type: 'int', default: 7, label: '温度（×10）' }],
      reqParams: [{ name: 'userPrompt', type: 'string' }], resp: { content: 'choices[0].message.content' } }] });
  const p = listProvidersV2(db).find((c) => c.kind === 'llm');
  check('5.7 这处配置照读、Key 保住、引用的组重铺后仍然对得上',
    p && p.apiKey === 'sk-不得丢' && p.tplGroup === 'openai-chat' && p.id === 'llm', p);
  const g = listTemplateGroupsV2(db).find((x) => x.tplGroup === 'openai-chat');
  eq('5.8 新形状的入参读写往返', { label: g.label, inst: g.rows[0].instParams, req: g.rows[0].reqParams },
    { label: 'OpenAI 兼容对话',
      inst: [{ name: 'temperature', type: 'int', default: 7, label: '温度（×10）' }],
      req: [{ name: 'userPrompt', type: 'string' }] });
  const staleCount = () => db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name LIKE '%__stale'").get().c;
  check('5.9 幂等：再启动一次不再让位（stale 表不叠加、重铺的行还在）',
    ensureV2Schema(db) === true && staleCount() === 2 && db.prepare('SELECT COUNT(*) c FROM provider_template').get().c === 1);
  db.close();
}

// ---------- 6. 一处一份：v2「同能力多实例 + 生效」压成每能力一行 ----------
console.log('\n[6] 旧「一个能力多条实例」压扁');
{
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE provider_template_group (tpl_group TEXT PRIMARY KEY, kind TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '', note TEXT, base_url TEXT NOT NULL DEFAULT '', models_json TEXT,
      default_model TEXT NOT NULL DEFAULT '', default_voice TEXT, ord INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE provider (provider_id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
      tpl_group TEXT NOT NULL REFERENCES provider_template_group(tpl_group), base_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '', api_key2 TEXT, mode TEXT NOT NULL DEFAULT 'sync', model TEXT NOT NULL DEFAULT '',
      voice TEXT, speed REAL NOT NULL DEFAULT 1, params_json TEXT, max_concurrency INTEGER NOT NULL DEFAULT 1,
      retry_times INTEGER NOT NULL DEFAULT 2, extra TEXT, active INTEGER NOT NULL DEFAULT 0, ord INTEGER NOT NULL DEFAULT 0);
    CREATE UNIQUE INDEX ux_provider_active ON provider(kind) WHERE active = 1;`);
  db.prepare(`INSERT INTO provider_template_group (tpl_group, kind, label) VALUES
    ('dashscope-image','image','通义图片'),('dashscope-cosyvoice','tts','通义语音')`).run();
  db.prepare(`INSERT INTO provider (provider_id, kind, label, tpl_group, base_url, api_key, mode, model, active, ord) VALUES
    ('img-a','image','通义图片 (同步)','dashscope-image','https://a/api/v1','sk-同步','sync','z-image-turbo',0,1),
    ('img-b','image','通义万相 (异步)','dashscope-image','https://b/api/v1','sk-生效','async','wan2.6-t2i',1,2),
    ('img-c','image','通义图片生成','dashscope-image','https://c/api/v1','sk-第三条','sync','z-image-turbo',0,3),
    ('tts-1','tts','通义配音','dashscope-cosyvoice','https://d/api/v1','sk-配音','sync','cosyvoice-v3-flash',1,4)`).run();

  check('6.1 认「还带 provider_id / active」为正标志 → 让位', ensureV2Schema(db) === true
    && !!db.prepare("SELECT name FROM sqlite_master WHERE name='provider__stale'").get());
  const cols = db.prepare('PRAGMA table_info(provider)').all().map((c) => c.name);
  check('6.2 新表已无 provider_id / active / ord / label',
    !['provider_id', 'active', 'ord', 'label'].some((c) => cols.includes(c)) && cols.includes('kind'), cols);
  db.exec('PRAGMA foreign_keys = ON');
  eq('6.3 每能力只搬一行（生效那条优先，其余丢弃）', migrateProvidersFromStale(db), 2);
  const byKind = Object.fromEntries(listProvidersV2(db).map((r) => [r.kind, r]));
  check('6.4 图片留的是「生效」那份（Key / 模型 / 异步都跟着它）',
    byKind.image.apiKey === 'sk-生效' && byKind.image.model === 'wan2.6-t2i' && byKind.image.mode === 'async', byKind.image);
  check('6.5 语音那份照搬', byKind.tts.apiKey === 'sk-配音' && byKind.tts.tplGroup === 'dashscope-cosyvoice');
  check('6.6 搬干净就不留 stale 表', !db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%__stale'").get());
  db.close();
}

console.log(`\n===== ${failed ? `${failed} 项失败` : '全部通过'} =====`);
process.exit(failed ? 1 : 0);
