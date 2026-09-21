/**
 * verify-provider-endpoint.mjs — 供应商「模板即数据」改版的库侧回归
 *
 * 覆盖：旧库（provider 带 api_key / protocol）启动 → 按新 DDL 重建并搬回行（Key 不丢）、
 *       protocol → recipe 的映射、接口模板行读写逐字往返、缺省 endpoints 不擦已有模板、
 *       级联删除、每个 kind 只一条生效、异步配对自检视图能抓悬挂。
 * 运行：node --experimental-sqlite tools/verify-provider-endpoint.mjs
 * 退出码非 0 表示有失败项。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureV2Schema, listProvidersV2, upsertProviderV2, removeProviderV2, setActiveProviderV2,
} from '../electron/db-v2.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DDL = fs.readFileSync(path.join(HERE, '..', 'docs', 'db-schema-v2.sql'), 'utf8');

/** 改版前的 provider 表（api_key + protocol 白名单） */
const OLD_PROVIDER_DDL = `
CREATE TABLE provider (
  provider_id TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('llm','tts','image')),
  label      TEXT NOT NULL DEFAULT '',
  base_url   TEXT NOT NULL DEFAULT '',
  api_key    TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  protocol   TEXT CHECK (protocol IS NULL OR protocol IN ('openai-speech','minimax-t2a','volc-tts','cosyvoice','qwen-tts','custom')),
  voice      TEXT,
  speed      REAL NOT NULL DEFAULT 1,
  extra      TEXT,
  active     INTEGER NOT NULL DEFAULT 0,
  ord        INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX ux_provider_active ON provider(kind) WHERE active = 1;
`;

const LEGACY = [
  { id: 'qwen-tts-iqc4e7', kind: 'tts', label: '通义语音 (Qwen-TTS)', base_url: 'https://dashscope.aliyuncs.com/api/v1', api_key: 'sk-<用户的长 Key 不得丢>', model: 'qwen3-tts-flash', protocol: 'qwen-tts', voice: 'Ethan', active: 1, ord: 1 },
  { id: 'cv-1', kind: 'tts', label: '通义语音 (CosyVoice)', base_url: 'https://dashscope.aliyuncs.com/api/v1', api_key: 'sk-cv', model: 'cosyvoice-v3-flash', protocol: 'cosyvoice', voice: 'longanyang', active: 0, ord: 2 },
  { id: 'volc-1', kind: 'tts', label: '火山', base_url: 'https://x', api_key: 'a|b', model: '', protocol: 'volc-tts', voice: 'v', active: 0, ord: 3 },
  { id: 'img-1', kind: 'image', label: '通义图片', base_url: 'https://dashscope.aliyuncs.com/api/v1', api_key: 'sk-i', model: 'z-image-turbo', protocol: null, voice: null, active: 1, ord: 4 },
  { id: 'llm-1', kind: 'llm', label: 'DeepSeek', base_url: 'https://api.deepseek.com', api_key: 'sk-d', model: 'deepseek-chat', protocol: null, voice: null, active: 1, ord: 5 },
];

function seedOldDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(OLD_PROVIDER_DDL);
  const ins = db.prepare(`INSERT INTO provider (provider_id, kind, label, base_url, api_key, model, protocol, voice, active, ord)
    VALUES (@id, @kind, @label, @base_url, @api_key, @model, @protocol, @voice, @active, @ord)`);
  for (const r of LEGACY) ins.run(r);
  return db;
}

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed += 1;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail !== undefined && !pass ? `\n         ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};

// ---------- 1. 旧库启动：重建 + 搬回 ----------
console.log('\n[1] 旧库启动体检（api_key/protocol → secrets_json/recipe）');
{
  const db = seedOldDb();
  check('1.1 ensureV2Schema 成功', ensureV2Schema(db) === true);
  const list = listProvidersV2(db);
  check('1.2 五行都在、顺序不变', list.map((r) => r.id).join(',') === LEGACY.map((r) => r.id).join(','), list.map((r) => r.id));
  const byId = Object.fromEntries(list.map((r) => [r.id, r]));
  check('1.3 Key 原样进 secrets_json.apiKey', byId['qwen-tts-iqc4e7'].secrets.apiKey === 'sk-<用户的长 Key 不得丢>', byId['qwen-tts-iqc4e7'].secrets);
  eq('1.4 protocol → recipe 映射', {
    qwen: byId['qwen-tts-iqc4e7'].recipe, cv: byId['cv-1'].recipe, volc: byId['volc-1'].recipe,
    img: byId['img-1'].recipe, llm: byId['llm-1'].recipe,
  }, { qwen: 'dashscope-qwen-tts', cv: 'dashscope-cosyvoice', volc: 'volc-tts', img: 'dashscope-image', llm: 'openai-chat' });
  check('1.5 模型/音色/生效标记都保住',
    byId['qwen-tts-iqc4e7'].model === 'qwen3-tts-flash' && byId['qwen-tts-iqc4e7'].voice === 'Ethan' && byId['qwen-tts-iqc4e7'].active === true);
  check('1.6 无 provider__stale 残留', db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='provider__stale'").get().c === 0);
  check('1.7 新表已无 protocol / api_key 列', (() => {
    const cols = db.prepare('PRAGMA table_info(provider)').all().map((c) => c.name);
    return !cols.includes('protocol') && !cols.includes('api_key') && cols.includes('secrets_json') && cols.includes('recipe');
  })());
  const before = JSON.stringify(list);
  ensureV2Schema(db);
  check('1.8 幂等：二次启动不再重建', JSON.stringify(listProvidersV2(db)) === before);
  db.close();
}

function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
}

// ---------- 2. 接口模板行读写 ----------
console.log('\n[2] 接口模板读写往返');
{
  const db = new DatabaseSync(':memory:');
  ensureV2Schema(db);
  db.exec('PRAGMA foreign_keys = ON');   // 级联删除要有；主进程那边同样是开着的
  const tpl = {
    role: 'image.generate', mode: 'async', method: 'post', path: '{baseUrl}/submit',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {secrets.apiKey}' },
    query: { v: '1' },
    body: { model: '{model}', input: { prompt: '{prompt}' }, parameters: { size: '{size}' } },
    vars: [{ name: 'prompt', kind: 'inject' }, { name: 'size', kind: 'param', type: 'string', default: '1024*1024', options: ['1024*1024', '2048*1152'] }],
    overrides: { size: '2048*1152' },
    resp: { kind: 'json', decode: 'url', pick: { taskId: 'output.task_id' } },
    poll: { taskId: 'output.task_id', statusRole: 'image.query', intervalMs: 1500, timeoutMs: 60000, done: { path: 'output.task_status', equals: 'SUCCEEDED' }, then: { image: 'output.results.0.url' } },
  };
  const cfg = { id: 'p1', kind: 'image', recipe: 'dashscope-image-async', label: '测试', baseUrl: 'https://x', secrets: { apiKey: 'sk-1' }, model: 'm', endpoints: [tpl] };
  upsertProviderV2(db, cfg);
  const got = listProvidersV2(db).find((c) => c.id === 'p1');
  eq('2.1 模板逐字往返（含 vars / poll / overrides）', got.endpoints[0], { ...tpl, method: 'POST', enabled: true });
  check('2.2 第二个密钥槽独立存（不再拼在 apiKey 里）', (() => {
    upsertProviderV2(db, { ...cfg, secrets: { apiKey: 'sk-1', secret2: 'grp-9' } });
    return listProvidersV2(db).find((c) => c.id === 'p1').secrets.secret2 === 'grp-9';
  })());
  // 只改模型名，不给 endpoints —— 用户调过的模板不能被擦掉
  upsertProviderV2(db, { ...cfg, model: 'm2' });
  const after = listProvidersV2(db).find((c) => c.id === 'p1');
  check('2.3 缺省 endpoints 时保留库里的模板', after.model === 'm2' && after.endpoints.length === 1 && after.endpoints[0].poll.timeoutMs === 60000);
  check('2.4 同 provider 同 role 只能一条（唯一索引）', db.prepare('PRAGMA index_list(provider_endpoint)').all().some((i) => i.unique));

  // 异步配对自检（先建供应商，再挂一个没有配套查询接口的异步模板）
  db.prepare("INSERT INTO provider (provider_id, kind, recipe, label, base_url, secrets_json, model, ord) VALUES ('p2','image','r','','','{}','',9)").run();
  db.prepare(`INSERT INTO provider_endpoint (endpoint_id, provider_id, role, ord, enabled, mode, method, path, poll_json)
    VALUES ('p2:image.generate','p2','image.generate',0,1,'async','POST','/x','{"taskId":"a","statusRole":"image.query","done":{"path":"s","equals":"OK"}}')`).run();
  check('2.5 异步缺查询接口 → v_check_async_pairing 抓到', db.prepare("SELECT COUNT(*) c FROM v_check_async_pairing WHERE ref_id='p2'").get().c === 1,
    db.prepare('SELECT * FROM v_check_async_pairing').all());
  db.prepare("INSERT INTO provider_endpoint (endpoint_id, provider_id, role, ord, enabled, mode, method, path) VALUES ('p2:image.query','p2','image.query',1,1,'sync','GET','/q')").run();
  check('2.6 补上 image.query 后自检清零', db.prepare("SELECT COUNT(*) c FROM v_check_async_pairing WHERE ref_id='p2'").get().c === 0);

  // 删除供应商级联清接口行
  removeProviderV2(db, 'p2');
  check('2.7 删供应商级联删掉接口模板行', db.prepare("SELECT COUNT(*) c FROM provider_endpoint WHERE provider_id='p2'").get().c === 0);

  // 每个 kind 至多一条生效
  upsertProviderV2(db, { ...cfg, id: 'p3' });
  setActiveProviderV2(db, 'image', 'p1');
  setActiveProviderV2(db, 'image', 'p3');
  const actives = listProvidersV2(db).filter((c) => c.kind === 'image' && c.active === true).map((c) => c.id);
  eq('2.8 切生效时旧生效行自动落下', actives, ['p3']);
  check('2.9 同一 kind 两条生效会被唯一索引拦住', (() => {
    try { db.prepare("UPDATE provider SET active = 1 WHERE provider_id = 'p1'").run(); return false; }
    catch (e) { return /UNIQUE/i.test(String(e.message)); }
  })());
  db.close();
}

console.log(`\n===== ${failed ? `${failed} 项失败` : '全部通过'} =====`);
process.exit(failed ? 1 : 0);
