/**
 * verify-provider-protocol.mjs — 旧库 provider 表的 CHECK 白名单升级回归
 *
 * 背景：TTS 拆成 CosyVoice / Qwen-TTS 两条端点后，代码里 protocol='cosyvoice'，
 * 而老库的 `provider.protocol` CHECK 白名单没有这个值 → 新建的 CosyVoice 供应商行
 * 当场能用、重启即丢（hydrate 用库里的行覆盖）。启动体检（retireProviderIfStale +
 * restoreProviderRows）要能把它按新 DDL 重建，并原样搬回已填的行（含 API Key）。
 * 运行：node --experimental-sqlite tools/verify-provider-protocol.mjs
 * 退出码非 0 表示有失败项。
 */
import { DatabaseSync } from 'node:sqlite';
import { ensureV2Schema } from '../electron/db-v2.mjs';

/** 升级前的旧表定义（protocol 白名单里没有 cosyvoice） */
const OLD_PROVIDER_DDL = `
CREATE TABLE provider (
  provider_id TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('llm','tts','image')),
  label      TEXT NOT NULL DEFAULT '',
  base_url   TEXT NOT NULL DEFAULT '',
  api_key    TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  protocol   TEXT CHECK (protocol IS NULL OR protocol IN ('openai-speech','minimax-t2a','volc-tts','qwen-tts','custom')),
  voice      TEXT,
  speed      REAL NOT NULL DEFAULT 1 CHECK (speed BETWEEN 0.5 AND 2),
  extra      TEXT CHECK (extra IS NULL OR json_valid(extra)),
  active     INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  ord        INTEGER NOT NULL DEFAULT 0
);
`;

// 主进程写入用的那条 SQL（照 electron/main.mjs 的 db:providers:upsert）
const UPSERT = `
  INSERT INTO provider (provider_id, kind, label, base_url, api_key, model, protocol, voice, speed, extra, ord)
  VALUES (@id, @kind, @label, @baseUrl, @apiKey, @model, @protocol, @voice, @speed, @extra,
          COALESCE((SELECT ord FROM provider WHERE provider_id = @id), (SELECT COALESCE(MAX(ord), 0) + 1 FROM provider)))
  ON CONFLICT(provider_id) DO UPDATE SET kind=@kind, label=@label, base_url=@baseUrl, api_key=@apiKey, model=@model,
    protocol=@protocol, voice=@voice, speed=@speed, extra=@extra
`;

const OLD_ROW = {
  id: 'qwen-tts-iqc4e7', kind: 'tts', label: '通义语音 (Qwen-TTS)', baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  apiKey: 'sk-<本机已填的长 Key，不得被搬丢>', model: 'qwen3-tts-flash', protocol: 'qwen-tts', voice: 'Ethan', speed: 1, extra: null,
};

function seedOldDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(OLD_PROVIDER_DDL);
  db.prepare(UPSERT).run({ ...OLD_ROW });
  db.prepare(UPSERT).run({ ...OLD_ROW, id: 'deepseek-llm1', kind: 'llm', label: 'DeepSeek', apiKey: '', model: 'deepseek-flash', protocol: null, voice: null });
  // 旧表上「每个 kind 至多一条生效」靠部分唯一索引；建在旧表上，重建后必须仍在
  db.exec("CREATE UNIQUE INDEX ux_provider_active ON provider(kind) WHERE active = 1");
  db.prepare('UPDATE provider SET active = 1 WHERE provider_id = ?').run(OLD_ROW.id);
  return db;
}

const snapshot = (db) => db.prepare(
  'SELECT provider_id AS id, kind, label, api_key, model, protocol, voice, active, ord FROM provider ORDER BY ord, provider_id'
).all();

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed += 1;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? `\n         ${detail}` : ''}`);
};

// ---------- 1. 旧库启动：表按新 DDL 重建，行原样搬回 ----------
{
  console.log('\n[1] 旧库启动体检');
  const db = seedOldDb();
  const before = snapshot(db);
  check('1.0 旧表确实不认 cosyvoice', (() => {
    try {
      db.prepare(UPSERT).run({ ...OLD_ROW, id: 'cv-x', protocol: 'cosyvoice', model: 'cosyvoice-v3-flash', voice: 'longanyang' });
      return false;
    } catch { return true; }
  })(), '插入居然成功了 —— 夹具写错了');
  check('1.1 ensureV2Schema 返回成功', ensureV2Schema(db) === true);
  const after = snapshot(db);
  check('1.2 行数与内容逐字搬回', JSON.stringify(after) === JSON.stringify(before), `before=${JSON.stringify(before)}\n         after=${JSON.stringify(after)}`);
  check('1.3 旧表未残留', db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'provider__stale'").get().c === 0);
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider'").get().sql;
  check('1.4 新表白名单含 cosyvoice', /'cosyvoice'/.test(sql));
  // 让位一次就够：再启动不该再重建（否则每次启动都搬家）
  const ids = after.map((r) => r.id).join(',');
  ensureV2Schema(db);
  check('1.5 幂等：二次启动不再重建', snapshot(db).map((r) => r.id).join(',') === ids
    && db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name='provider__stale'").get().c === 0);

  // ---------- 2. CosyVoice 行现在存得进去，且重启读得回 ----------
  console.log('\n[2] CosyVoice 供应商行落库');
  let err = null;
  try {
    db.prepare(UPSERT).run({ ...OLD_ROW, id: 'cosyvoice-abc123', label: '通义语音 (CosyVoice)', protocol: 'cosyvoice', model: 'cosyvoice-v3-flash', voice: 'longanyang' });
  } catch (e) { err = e; }
  check('2.1 protocol=cosyvoice 写入不再报 CHECK', !err, err ? err.message : '');
  const back = db.prepare("SELECT provider_id AS id, model, voice FROM provider WHERE protocol = 'cosyvoice'").get();
  check('2.2 重开进程能读回该行（hydrate 走的是同一条 SELECT）', back?.id === 'cosyvoice-abc123' && back.voice === 'longanyang', JSON.stringify(back));
  check('2.3 一个 kind 只留一条生效（部分唯一索引仍在）', (() => {
    try { db.prepare('UPDATE provider SET active = 1 WHERE provider_id = ?').run('cosyvoice-abc123'); return false; }
    catch (e) { return /UNIQUE/i.test(String(e.message)); }
  })());
  db.close();
}

// ---------- 3. 全新库（无旧表）：不该触发改名 ----------
{
  console.log('\n[3] 干净库首次启动');
  const db = new DatabaseSync(':memory:');
  check('3.1 建表成功', ensureV2Schema(db) === true);
  check('3.2 没有 provider__stale 残留', db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name='provider__stale'").get().c === 0);
  let err = null;
  try {
    db.prepare(UPSERT).run({ ...OLD_ROW, id: 'cv-fresh', protocol: 'cosyvoice' });
  } catch (e) { err = e; }
  check('3.3 新库直接收 cosyvoice', !err, err ? err.message : '');
  db.close();
}

console.log(`\n===== ${failed ? `${failed} 项失败` : '全部通过'} =====`);
process.exit(failed ? 1 : 0);
