#!/usr/bin/env node
/**
 * comment-ddl.mjs — 把字段中文说明注入 DDL（docs/db-schema-v2.sql）行尾注释
 *
 * SQLite 不存储表/字段注释，故把 tools/db-field-notes.mjs 的中文说明写成 DDL 行尾 `-- 中文`，
 * 让 schema 自带中文注释（用 DB 工具看 DDL / 编辑器即可读）。
 *
 * 幂等：先去掉该行已有行尾注释再追加，可反复运行。
 * 用法：node tools/comment-ddl.mjs [--check]
 */
import fs from 'node:fs';
import FIELD_NOTES from './db-field-notes.mjs';

const CHECK = process.argv.includes('--check');
const DDL = 'docs/db-schema-v2.sql';
// 统一为 LF 处理（CRLF 下 `.` 不匹配 `\r`，会导致行尾正则失配）
const text = fs.readFileSync(DDL, 'utf8').replace(/\r\n/g, '\n');
const lines = text.split('\n');

const out = [];
let table = null;
for (const line of lines) {
  const createM = line.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(/i);
  if (createM) { table = createM[1]; out.push(line); continue; }
  if (table && /^\);\s*$/.test(line.trim())) { table = null; out.push(line); continue; }

  if (table) {
    // 单行列定义：两空格缩进 + 列名 + 类型
    const colM = line.match(/^(\s{2})([a-z_][a-z0-9_]*)(\s+(?:TEXT|INTEGER|REAL|BLOB|NUMERIC|INT)\b.*)$/i);
    const note = colM ? FIELD_NOTES[table]?.[colM[2]] : null;
    if (colM && note) {
      const head = `${colM[1]}${colM[2]}${colM[3]}`.replace(/\s*--.*$/, '').replace(/\s+$/, '');
      out.push(`${head}  -- ${note}`);
      continue;
    }
  }
  out.push(line);
}

const next = out.join('\n');
if (next === text) {
  console.log(`[comment-ddl] 无需变更（${CHECK ? 'check' : '写回'}）`);
} else if (CHECK) {
  console.error('[comment-ddl] DDL 注释与词表不一致（请运行 node tools/comment-ddl.mjs 写回）');
  process.exit(1);
} else {
  fs.writeFileSync(DDL, next);
  console.log('[comment-ddl] 已写入行尾中文注释');
}
