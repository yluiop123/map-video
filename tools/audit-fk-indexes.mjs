#!/usr/bin/env node
/**
 * audit-fk-indexes.mjs — 外键索引覆盖审计
 *
 * 为什么需要：SQLite 的外键强制检查本身几乎不花钱（实测 31k 行插入，FK 开/关差 ~1µs/行），
 * 真正的成本在于「父行被删除/更新时，若子表外键列没有索引，SQLite 必须全表扫描子表」。
 * 实测 5000 行子表、删除 200 个被引用父行：无索引 3592ms → 有索引 129ms（28×）。
 * 所以结论是「不要删外键，补齐子表列索引」——本脚本用来保证这一点持续成立。
 *
 * 做法：对每张表读 PRAGMA foreign_key_list 拿到各 FK 的子列，
 * 再用 PRAGMA index_list / index_info 检查是否存在某个索引以这些子列作为前缀。
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
const EXPECTED_EXCEPTIONS = [
  {
    match: (r) => r.table === 'project' && r.childCols.join(',') === 'active_base_map_id',
    reason: 'project 表恒为 1 行，父行删除时的全表扫描成本是常数 1 行，无需索引',
  },
];

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

db.close();
for (const s of ['', '-wal', '-shm']) fs.rmSync(tmp + s, { force: true });

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
console.log(unexpected.length === 0 ? '结果：无非预期缺口 ✓' : `结果：${unexpected.length} 个缺口需补索引 ✗`);

process.exit(unexpected.length === 0 ? 0 : 1);
