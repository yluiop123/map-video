/**
 * verify-provider-templates.mjs — 四张配置表（模板 / 实例 / 音色 / 任务）的库侧回归
 *
 * 覆盖：全新库建表（不再有 provider_template_group）、模板整份逐字往返、实例多条共存与
 *       values 两段读写、真外键（删被引用的模板要拦住 / 删实例不牵连模板）、voice 幂等键、
 *       task 随项目级联清掉、异步配对的自检视图，以及三代旧形状（provider_endpoint 副本 /
 *       组表 + 每 role 一行 / 每能力一条实例）启动让位后把密钥搬进 values.instance。
 * 运行：node --experimental-sqlite tools/verify-provider-templates.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureV2Schema, listTemplatesV2, upsertTemplateV2, removeTemplateV2,
  listProvidersV2, upsertProviderV2, removeProviderV2, migrateProvidersFromStale, retireProviderIfStale,
} from '../electron/db-v2.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DDL = fs.readFileSync(path.join(HERE, '..', 'docs', 'db-schema-v2.sql'), 'utf8');
void DDL; // ensureV2Schema 自己按路径读，这里只作存在性检查

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed += 1;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail !== undefined && !pass ? `\n         ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
  : v);
const eq = (name, got, want) => check(name, JSON.stringify(canon(got)) === JSON.stringify(canon(want)), { got, want });
const fresh = () => {
  const db = new DatabaseSync(':memory:');
  check('建表成功', ensureV2Schema(db) === true);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
};

/** 一份字段给满的模板（三层参数 / outputs / 两枚举 / 桥接都上，用来验逐字往返） */
const TPL = {
  id: 'verify-image', name: '回归用图片', category: 'image', note: '只给回归用',
  useClone: false, hasUpload: false,
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ${apiKey}' },
  instanceParams: [
    { key: 'baseUrl', label: '服务地址', valueType: 'string', defaultValue: 'https://x/v1' },
    { key: 'apiKey', label: 'API Key', valueType: 'secret' },
    { key: 'timeoutMs', label: '超时', valueType: 'number', defaultValue: 30000 },
  ],
  sync: { submit: { path: '${baseUrl}/gen', method: 'POST', requestParams: [{ key: 'size', label: '尺寸', valueType: 'enum', options: ['1024*1024', '2048*2048'] }], callParams: [{ key: 'prompt', label: '描述', valueType: 'text' }], body: { size: '${size}', prompt: '${prompt}' }, outputs: { url: 'output.url' }, outputFormat: 'url' } },
  async: {
    submit: { path: '${baseUrl}/submit', method: 'POST', headers: { 'X-DashScope-Async': 'enable' }, body: { prompt: '${prompt}' }, outputs: { taskId: 'output.task_id' } },
    query: { path: '${baseUrl}/tasks/${taskId}', method: 'GET', outputs: { status: 'output.task_status', url: 'output.results[0].url' }, successValues: ['SUCCEEDED'], failureValues: ['FAILED', 'UNKNOWN'], outputFormat: 'url' },
  },
  download: { path: '${baseUrl}/files/retrieve?file_id=${fileId}', method: 'GET', outputs: { url: 'file.download_url' } },
};

// ---------- 1. 模板读写 ----------
console.log('\n[1] 模板表（一行一份完整模板）');
{
  const db = fresh();
  check('1.1 provider_template_group 这张表不再存在', !db.prepare("SELECT name FROM sqlite_master WHERE name='provider_template_group'").get());
  check('1.2 四张配置表都在', ['provider_template', 'provider', 'voice', 'task'].every((n) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(n)));
  check('1.3 空库 list 返回空', listTemplatesV2(db).length === 0);
  upsertTemplateV2(db, TPL);
  const got = listTemplatesV2(db).find((t) => t.id === 'verify-image');
  eq('1.4 整份逐字往返（三层参数 / outputs / 两枚举 / 桥接 / 异步头）',
    { name: got.name, category: got.category, note: got.note, headers: got.headers, instanceParams: got.instanceParams, sync: got.sync, async: got.async, download: got.download },
    { name: TPL.name, category: TPL.category, note: TPL.note, headers: TPL.headers, instanceParams: TPL.instanceParams, sync: TPL.sync, async: TPL.async, download: TPL.download });
  check('1.5 方括号下标原样存回（output.results[0].url）', got.async.query.outputs.url === 'output.results[0].url', got.async.query.outputs);
  eq('1.6 useClone=false 读回是 false', { useClone: got.useClone, hasUpload: got.hasUpload }, { useClone: false, hasUpload: false });
  upsertTemplateV2(db, { ...TPL, async: undefined, download: undefined });
  const after = listTemplatesV2(db).find((t) => t.id === 'verify-image');
  check('1.7 整份覆写：删掉的接口不残留', !after.async && !after.download, Object.keys(after));
  check('1.8 同 id 再存是覆盖不是加行', listTemplatesV2(db).filter((t) => t.id === 'verify-image').length === 1);
  removeTemplateV2(db, 'verify-image');
  check('1.9 删掉后表空', listTemplatesV2(db).length === 0);
  db.close();
}

// ---------- 2. 实例（多实例 + values 两段） ----------
console.log('\n[2] 实例：一个模板可以配几套账号');
{
  const db = fresh();
  upsertTemplateV2(db, TPL);
  const i1 = {
    id: 'prov_a', tplId: 'verify-image', name: '生产', sync: false,
    values: { instance: { baseUrl: 'https://a/v1', apiKey: 'sk-长-KEY 不得丢', timeoutMs: 30000 }, requests: { 'async.submit': { model: 'wan-a' }, 'sync.submit': { size: '2048*2048' } } },
  };
  upsertProviderV2(db, i1);
  eq('2.1 逐字往返（values 两段原样回来）', listProvidersV2(db).find((x) => x.id === 'prov_a'), i1);
  upsertProviderV2(db, { ...i1, values: { instance: { ...i1.values.instance, apiKey: 'sk-改过的' }, requests: { 'async.submit': { model: 'wan-b' } } } });
  const again = listProvidersV2(db).find((x) => x.id === 'prov_a');
  check('2.2 再存一次是覆盖那一行', listProvidersV2(db).length === 1 && again.values.instance.apiKey === 'sk-改过的' && again.values.requests['async.submit'].model === 'wan-b', again.values);
  check('2.3 sync=false 读回 false、缺 requests 也不造空壳', again.sync === false);
  upsertProviderV2(db, { ...i1, id: 'prov_b', name: '备用', sync: true, values: { instance: { baseUrl: 'https://b/v1', apiKey: 'sk-b' }, requests: {} } });
  eq('2.4 同一份模板可以挂多条实例（调用处选一条）', listProvidersV2(db).map((x) => `${x.id}:${x.sync ? 'sync' : 'async'}`).sort(), ['prov_a:async', 'prov_b:sync']);
  check('2.5 想插同 id 第二行会被主键拦住', (() => {
    try { db.prepare("INSERT INTO provider (provider_id, tpl_id) VALUES ('prov_a','verify-image')").run(); return false; }
    catch (e) { return /UNIQUE|PRIMARY/i.test(String(e.message)); }
  })());
  check('2.6 tpl_id 是真外键：模板被实例引用时删不掉', (() => {
    try { removeTemplateV2(db, 'verify-image'); return false; }
    catch (e) { return /FOREIGN KEY/i.test(String(e.message)); }
  })());
  removeProviderV2(db, 'prov_a');
  check('2.7 删一条实例不动另一条', listProvidersV2(db).map((x) => x.id).join() === 'prov_b');
  db.close();
}

// ---------- 3. voice 幂等键与 task 级联 ----------
console.log('\n[3] voice 幂等键 / task 随项目级联');
{
  const db = fresh();
  upsertTemplateV2(db, { ...TPL, category: 'tts', useClone: true });
  upsertProviderV2(db, { id: 'prov_t', tplId: 'verify-image', name: '配音生产', sync: true, values: { instance: { baseUrl: 'https://a/v1' }, requests: {} } });
  db.prepare(`INSERT INTO asset (asset_id, kind, name, mime, storage, rel_path, created_at)
    VALUES ('as_ref','audio','ref.wav','audio/wav','file','a/ref.wav',1)`).run();
  const mkVoice = (id, hash, model, asset) => db.prepare(
    `INSERT INTO voice (voice_row_id, provider_id, source_hash, target_model, source_asset_id, label, status)
     VALUES (?,?,?,?,?,?, 'cloning')`).run(id, 'prov_t', hash, model, asset ?? 'as_ref', '回归');
  mkVoice('v1', 'h1', 'cosyvoice-v3-flash');
  check('3.1 同实例 + 同音频 + 同模型只有一条（唯一键挡住第二次）', (() => {
    try { mkVoice('v2', 'h1', 'cosyvoice-v3-flash'); return false; } catch (e) { return /UNIQUE/i.test(String(e.message)); }
  })());
  mkVoice('v3', 'h1', 'cosyvoice-v3.5-flash');
  check('3.2 换个目标模型 = 另一条音色（voiceId 绑模型，实测踩过 418）',
    db.prepare('SELECT COUNT(*) c FROM voice').get().c === 2);
  check('3.3 参考音频是 RESTRICT：素材被音色引用时删不掉', (() => {
    try { db.prepare("DELETE FROM asset WHERE asset_id='as_ref'").run(); return false; } catch (e) { return /FOREIGN KEY/i.test(String(e.message)); }
  })());
  check('3.4 音色指向不存在的素材会被拦', (() => {
    try { mkVoice('v4', 'h9', 'm', 'as_none'); return false; } catch (e) { return /FOREIGN KEY/i.test(String(e.message)); }
  })());
  removeProviderV2(db, 'prov_t');
  check('3.5 删实例连带删它的音色池（ON DELETE CASCADE）', db.prepare('SELECT COUNT(*) c FROM voice').get().c === 0);

  db.prepare(`INSERT INTO collection (collection_id, name, ord, created_at, updated_at)
    VALUES ('default','默认合集',-1,1,1)`).run();
  db.prepare(`INSERT INTO project (project_id, name, collection_id, created_at, updated_at)
    VALUES ('p1','回归项目','default',1,1)`).run();
  upsertProviderV2(db, { id: 'prov_task', tplId: 'verify-image', name: '', sync: false, values: { instance: {}, requests: {} } });
  db.prepare(`INSERT INTO task (task_id, batch_id, provider_id, project_id, category, status, next_query_at)
    VALUES ('t1','b1','prov_task','p1','tts','submitting',1)`).run();
  check('3.6 task 必须有 provider（外键）', (() => {
    try { db.prepare("INSERT INTO task (task_id, batch_id, provider_id, category, status) VALUES ('t2','b1','nope','tts','submitting')").run(); return false; }
    catch (e) { return /FOREIGN KEY/i.test(String(e.message)); }
  })());
  db.prepare("DELETE FROM project WHERE project_id='p1'").run();
  check('3.7 删项目带走它的在途任务（不留悬空批次）', db.prepare("SELECT COUNT(*) c FROM task WHERE task_id='t1'").get().c === 0);
  db.close();
}

// ---------- 4. 异步配对自检 ----------
console.log('\n[4] 异步配对自检视图');
{
  const db = fresh();
  upsertTemplateV2(db, { ...TPL, async: { submit: TPL.async.submit } });   // 只有异步提交，没查询
  upsertProviderV2(db, { id: 'a1', tplId: 'verify-image', name: '', sync: false, values: { instance: {}, requests: {} } });
  const hit = db.prepare("SELECT problem FROM v_check_async_pairing WHERE ref_id='a1'").get();
  check('4.1 实例选了异步、模板缺查询 → 视图抓到', !!hit && hit.problem.includes('query'), hit);
  upsertTemplateV2(db, { ...TPL, async: { ...TPL.async, query: { ...TPL.async.query, successValues: undefined } } });
  check('4.2 查询没配成功值也抓到', (db.prepare("SELECT problem FROM v_check_async_pairing WHERE ref_id='a1'").get() || {}).problem?.includes('successValues'));
  upsertTemplateV2(db, TPL);
  check('4.3 配齐后自检清零', db.prepare('SELECT COUNT(*) c FROM v_check_async_pairing').get().c === 0);
  upsertProviderV2(db, { id: 'a1', tplId: 'verify-image', name: '', sync: true, values: { instance: {}, requests: {} } });
  check('4.4 改回同步就不参与这条自检', db.prepare('SELECT COUNT(*) c FROM v_check_async_pairing').get().c === 0);
  db.close();
}

// ---------- 5. 三代旧形状让位 + 搬回 ----------
console.log('\n[5] 旧形状让位 → 密钥搬进 values.instance');
{
  const db = new DatabaseSync(':memory:');
  // v1：provider_endpoint 副本 + recipe + secrets_json
  db.exec(`CREATE TABLE provider (provider_id TEXT PRIMARY KEY, kind TEXT NOT NULL, recipe TEXT, label TEXT,
      base_url TEXT, secrets_json TEXT, model TEXT, voice TEXT, speed REAL, extra TEXT,
      active INTEGER DEFAULT 0, ord INTEGER DEFAULT 0);
    CREATE UNIQUE INDEX ux_provider_active ON provider(kind) WHERE active = 1;
    CREATE TABLE provider_endpoint (endpoint_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, role TEXT,
      mode TEXT DEFAULT 'sync', overrides_json TEXT);`);
  db.prepare(`INSERT INTO provider (provider_id, kind, recipe, label, base_url, secrets_json, model, active, ord)
    VALUES ('llm-1','llm','openai-chat','DeepSeek','https://api.deepseek.com','{"apiKey":"sk-不得丢-v1"}','deepseek-flash',1,1)`).run();
  db.prepare(`INSERT INTO provider_endpoint (endpoint_id, provider_id, role, mode, overrides_json)
    VALUES ('llm-1:x','llm-1','llm.generate','async','{"temperature":7}')`).run();
  check('5.1 ensureV2Schema 让位并建新表', ensureV2Schema(db) === true);
  check('5.2 旧表改名不删（Key 留在归档里）', !!db.prepare("SELECT 1 FROM provider__stale LIMIT 1").get()
    && !!db.prepare("SELECT 1 FROM provider_endpoint__stale LIMIT 1").get());
  const cols = db.prepare('PRAGMA table_info(provider)').all().map((c) => c.name);
  eq('5.3 新表只剩「选哪份模板 + 名字 + 同步异步 + values」四样', cols, ['provider_id', 'tpl_id', 'name', 'sync', 'values_json', 'created_at', 'updated_at']);
  check('5.4 模板表也换了一行一份的形状', !db.prepare('PRAGMA table_info(provider_template)').all().map((c) => c.name).includes('role'));
  check('5.5 模板没铺之前 migrate 搬不动（返回 0 且归档留着）',
    migrateProvidersFromStale(db) === 0 && !!db.prepare("SELECT 1 FROM provider__stale LIMIT 1").get());
  db.exec('PRAGMA foreign_keys = ON');
  upsertTemplateV2(db, { id: 'openai-chat', name: '对话', category: 'llm', instanceParams: [], sync: { submit: { path: '${baseUrl}/chat/completions', body: {} } } });
  eq('5.6 v1 行搬回：密钥 / baseUrl / 模型并进 values.instance，overrides 汇总进去', migrateProvidersFromStale(db), 1);
  const v1Row = listProvidersV2(db).find((x) => x.id === 'llm-1');
  eq('5.7 values.instance 内容对得上', v1Row.values.instance, { temperature: 7, baseUrl: 'https://api.deepseek.com', apiKey: 'sk-不得丢-v1', model: 'deepseek-flash' });
  check('5.8 旧接口行有 async → 这条实例变异步', v1Row.sync === false);
  check('5.9 搬干净就不留归档表', !db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%__stale'").get());
  check('5.10 幂等：再启动一次不再让位', ensureV2Schema(db) === true && listProvidersV2(db).length === 1);
  db.close();
}
{
  // 第二代：组表 + 每 role 一行 + 每能力一条实例（kind 主键 + api_key 具名列）
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE provider_template_group (tpl_group TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT, note TEXT,
      base_url TEXT DEFAULT '', models_json TEXT, default_model TEXT DEFAULT '', default_voice TEXT, ord INTEGER DEFAULT 0);
    CREATE TABLE provider_template (tpl_id TEXT PRIMARY KEY, tpl_group TEXT NOT NULL REFERENCES provider_template_group(tpl_group),
      role TEXT NOT NULL, mode TEXT DEFAULT 'sync', ord INTEGER DEFAULT 0, method TEXT DEFAULT 'POST', url TEXT DEFAULT '',
      headers_json TEXT, query_json TEXT, body_json TEXT, inst_params_json TEXT, req_params_json TEXT, resp_json TEXT,
      decode_kind TEXT, fetch_headers_json TEXT, poll_interval_ms INTEGER DEFAULT 1500, poll_timeout_ms INTEGER DEFAULT 120000,
      ref_sample_rate INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE provider (kind TEXT PRIMARY KEY, tpl_group TEXT NOT NULL REFERENCES provider_template_group(tpl_group),
      base_url TEXT DEFAULT '', api_key TEXT DEFAULT '', api_key2 TEXT, mode TEXT DEFAULT 'sync', model TEXT DEFAULT '',
      voice TEXT, speed REAL DEFAULT 1, params_json TEXT, max_concurrency INTEGER DEFAULT 1, retry_times INTEGER DEFAULT 2,
      extra TEXT, created_at INTEGER, updated_at INTEGER);`);
  db.prepare(`INSERT INTO provider_template_group (tpl_group, kind, label) VALUES ('qwen-image','image','千问图片')`).run();
  db.prepare(`INSERT INTO provider_template (tpl_id, tpl_group, role, mode, url) VALUES ('qwen-image:generate:async','qwen-image','generate','async','{baseUrl}/x')`).run();
  db.prepare(`INSERT INTO provider (kind, tpl_group, base_url, api_key, mode, model, params_json)
    VALUES ('image','qwen-image','https://g/v1','sk-不得丢-v2','async','qwen-image-3.0-pro','{"size":"2048*2048"}')`).run();
  check('5.11 第二代形状也被认出来', retireProviderIfStale(db) === true
    && !!db.prepare("SELECT 1 FROM provider__stale LIMIT 1").get()
    && !!db.prepare("SELECT 1 FROM provider_template__stale LIMIT 1").get());
  ensureV2Schema(db);
  db.exec('PRAGMA foreign_keys = ON');
  upsertTemplateV2(db, { id: 'qwen-image', name: '千问图片', category: 'image', instanceParams: [], async: { submit: { path: '${baseUrl}/x', body: {} }, query: { path: '${baseUrl}/tasks/${taskId}', method: 'GET', outputs: { status: 's' }, successValues: ['SUCCEEDED'] } } });
  eq('5.12 第二代行搬回', migrateProvidersFromStale(db), 1);
  const row = listProvidersV2(db)[0];
  eq('5.13 具名列并进 values.instance（params_json 一并带过来）', row.values.instance, { size: '2048*2048', baseUrl: 'https://g/v1', apiKey: 'sk-不得丢-v2', model: 'qwen-image-3.0-pro' });
  check('5.14 实例名沿用旧 label / 缺省时用模板名', row.name === '' || row.name === '千问图片', row.name);
  check('5.15 改名没把子表外键写成死表（让位期间临时关了 foreign_keys）',
    !db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider'").get().sql.includes('__stale'));
  db.close();
}

console.log(`\n===== ${failed ? `${failed} 项失败` : '全部通过'} =====`);
process.exit(failed ? 1 : 0);
