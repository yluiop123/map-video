#!/usr/bin/env node
/**
 * audit-fk-indexes.mjs — 结构审计：外键索引覆盖 + 项目表 / 公共副本列对称
 *
 * ── 一、外键索引覆盖 ─────────────────────────────────────────────────────────
 * 为什么需要：SQLite 的外键强制检查本身几乎不花钱（实测 31k 行插入，FK 开/关差 ~1µs/行），
 * 真正的成本在于「父行被删除/更新时，若子表外键列没有索引，SQLite 必须全表扫描子表」。
 * 实测 5000 行子表、删除 200 个被引用父行：无索引 3592ms → 有索引 129ms（28×）。
 * 所以结论是「不要删外键，补齐子表列索引」——本脚本用来保证这一点持续成立。
 * 做法：对每张表读 PRAGMA foreign_key_list 拿到各 FK 的子列，
 * 再用 PRAGMA index_list / index_info 检查是否存在某个索引以这些子列作为前缀。
 *
 * ── 二、公共副本列对称 ───────────────────────────────────────────────────────
 * `public_element_X` 是 `element_X` 的跨项目副本，关系**逐字固定**：
 *     公共侧 = 项目侧 − {project_id, layer_id, start_sec, end_sec} + {public_layer_id}
 * （显隐是图层的事、时间不进图库；导入时时间现场给）。所以**给项目表加/删列必须成对改公共侧** ——
 * 漏改的症状很隐蔽：写入端按目标表的列逐列配源，多出来的列永远 NULL、少掉的列当场报错或静默丢值。
 * 这里把这条不变量变成审计项（而不是靠改的人记得）。
 *
 * 用法：
 *   node --experimental-sqlite tools/audit-fk-indexes.mjs [ddl路径]   # 默认 docs/db-schema-v2.sql
 *   node --experimental-sqlite tools/audit-fk-indexes.mjs --verbose   # 打印全部已覆盖项
 *
 * 退出码：0 = 无非预期缺口；1 = 存在缺口（会列出）。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 有意豁免：理由必须写清楚，否则未来审计会产生噪音
// project.active_base_map_id / active_elevation_map_id 现在是**弱引用**（指向全局目录，
// 但目录行由渲染端铺，挂成真外键会让「目录还没铺好时的一次保存」直接崩）—— 不在这里豁免，
// 因为它们根本不出现在外键清单里；悬空由 v_check_dangling 照。
const EXPECTED_EXCEPTIONS = [];

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const ddlPath = argv.find((a) => !a.startsWith('--')) || 'docs/db-schema-v2.sql';

if (!fs.existsSync(ddlPath)) {
  console.error(`找不到 DDL 文件：${ddlPath}`);
  process.exit(1);
}

const tmp = path.join(os.tmpdir(), `mv-fk-audit-${Date.now()}.db`);
const db = new DatabaseSync(tmp);
db.exec(fs.readFileSync(ddlPath, 'utf8'));

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);

const gaps = [];
const ok = [];
for (const table of tables) {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
  const byId = new Map();
  for (const f of rows) {
    if (!byId.has(f.id)) byId.set(f.id, { parent: f.table, childCols: [] });
    byId.get(f.id).childCols.push(f.from); // PRAGMA 按 seq 返回，顺序即复合外键的列序
  }
  const indexes = db.prepare(`PRAGMA index_list(${table})`).all().map((idx) => ({
    name: idx.name,
    cols: db.prepare(`PRAGMA index_info(${idx.name})`).all().map((c) => c.name),
  }));

  for (const [id, fk] of byId) {
    const hit = indexes.find(
      (ix) => fk.childCols.length <= ix.cols.length && fk.childCols.every((c, i) => ix.cols[i] === c),
    );
    const rec = { table, fkId: id, childCols: fk.childCols, parent: fk.parent, index: hit ? hit.name : null };
    (hit ? ok : gaps).push(rec);
  }
}

// 列清单在关库前一次性读好（公共副本对称审计要用）
const colsByName = new Map(tables.map((t) => [t, db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)]));

db.close();
for (const s of ['', '-wal', '-shm']) fs.rmSync(tmp + s, { force: true });

// ── 公共副本列对称 ──
// 公共侧 = 项目侧 − {project_id, layer_id, start_sec, end_sec} + {public_layer_id}
const PUBLIC_ONLY = ['public_layer_id'];
const PROJECT_ONLY = ['project_id', 'layer_id', 'start_sec', 'end_sec'];
const pairOf = (t) => (/^public_element_/.test(t) ? t.replace(/^public_element_/, 'element_') : null);
const symmetry = [];
const byName = new Set(tables);
for (const pub of tables) {
  const proj = pairOf(pub);
  if (!proj) continue;
  if (!byName.has(proj)) { symmetry.push({ pub, proj, missing: ['(项目表不存在)'], extra: [] }); continue; }
  const expect = colsByName.get(proj).filter((c) => !PROJECT_ONLY.includes(c));
  const actual = colsByName.get(pub);
  const missing = expect.filter((c) => !actual.includes(c));                                  // 项目侧有、公共侧没跟上
  const extra = actual.filter((c) => !expect.includes(c) && !PUBLIC_ONLY.includes(c));        // 公共侧多出来的
  const noPubCol = actual.includes('public_layer_id') ? [] : ['(缺 public_layer_id)'];
  if (missing.length || extra.length || noPubCol.length) symmetry.push({ pub, proj, missing: [...missing, ...noPubCol], extra });
}

const unexpected = gaps.filter((g) => !EXPECTED_EXCEPTIONS.some((e) => e.match(g)));
const expected = gaps.filter((g) => EXPECTED_EXCEPTIONS.some((e) => e.match(g)));

console.log(`DDL: ${ddlPath}`);
console.log(`表 ${tables.length} 张 · 外键 ${ok.length + gaps.length} 个 · 有索引 ${ok.length} · 缺口 ${gaps.length}`);
if (verbose) {
  for (const r of ok) console.log(`  ✓ ${r.table}(${r.childCols.join(',')}) -> ${r.parent}  [${r.index}]`);
}
for (const r of expected) {
  const why = EXPECTED_EXCEPTIONS.find((e) => e.match(r)).reason;
  console.log(`  - 豁免 ${r.table}(${r.childCols.join(',')}) -> ${r.parent}：${why}`);
}
for (const r of unexpected) {
  console.log(`  ✗ 缺口 ${r.table}(${r.childCols.join(',')}) -> ${r.parent}`);
}
console.log(unexpected.length === 0 ? '外键索引：无非预期缺口 ✓' : `外键索引：${unexpected.length} 个缺口需补索引 ✗`);

console.log(`公共副本：${tables.filter(pairOf).length} 对 · 不对称 ${symmetry.length}`);
for (const s of symmetry) {
  if (s.missing.length) console.log(`  ✗ ${s.pub} 比 ${s.proj} 少：${s.missing.join(', ')}`);
  if (s.extra.length) console.log(`  ✗ ${s.pub} 比 ${s.proj} 多：${s.extra.join(', ')}`);
}
console.log(symmetry.length === 0 ? '公共副本：5 对列集合逐字对称 ✓' : `公共副本：${symmetry.length} 对需同步 ✗`);

const bad = unexpected.length + symmetry.length;
process.exit(bad === 0 ? 0 : 1);
