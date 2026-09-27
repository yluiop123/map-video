/**
 * gen-template-init-sql.mjs — 把内置接口模板导出成一份可执行的初始化 SQL
 *
 *   node --experimental-strip-types tools/gen-template-init-sql.mjs          # 写 docs/provider-template-init.sql
 *   node --experimental-strip-types tools/gen-template-init-sql.mjs --check   # 只校验（内容漂移就报错退出）
 *
 * 唯一事实源仍是 `src/lib/template-seed.ts`（运行时按它铺表，见 providerStore.hydrate）；
 * 这份 SQL 是它的**导出**：给全新库当初始化脚本，也给「界面里改乱了想退回内置那一版」的人一条命令。
 * 用 upsert 而不是先 DELETE —— `provider.tpl_id` 是真外键（无 ON DELETE），有实例引用时删父行会被拒。
 * 它只写 `provider_template`，**一个字的实例数据都不碰**（地址与密钥都在 `provider.values_json` 里）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED_TEMPLATES } from '../src/lib/template-seed.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'docs', 'provider-template-init.sql');
const check = process.argv.includes('--check');

const q = (v) => `'${String(v).replaceAll("'", "''")}'`;
const json = (v) => (v === undefined || v === null ? 'NULL' : q(JSON.stringify(v)));
/** 模板行里不该有任何密钥（密钥在实例那一侧）—— 这份文件要进仓库，写之前先拦一道 */
const SECRET = /sk-[A-Za-z0-9]{16,}|[a-z0-9]{32,}(?=[^a-z0-9]|$)/i;

const COLS = ['tpl_id', 'name', 'category', 'caps_json', 'instance_params_json', 'sync_json', 'async_json', 'upload_json', 'clone_json', 'ord'];

const body = SEED_TEMPLATES.map((t, n) => {
  const vals = [q(t.id), q(t.name), q(t.category), json(t.caps), json(t.instanceParams), json(t.sync), json(t.async), json(t.upload), json(t.clone), String(n)];
  const upd = COLS.slice(1).map((c, i) => `${c} = excluded.${c}`).join(', ');
  return `-- ${t.name}（${t.category}）\nINSERT INTO provider_template (${COLS.join(', ')})\nVALUES (${vals.join(', ')})\nON CONFLICT(tpl_id) DO UPDATE SET ${upd};\n`;
}).join('\n');

const header = `-- 内置接口模板的初始化 SQL —— 由 tools/gen-template-init-sql.mjs 从 src/lib/template-seed.ts 生成，别手改（--check 会盯漂移）
-- 只写 provider_template 这一张表：实例的取值（地址 / 密钥 / 模型）都在 provider.values_json 里，这份脚本不碰。
-- 可以反复执行（存在即覆盖成内置那一版），也可以只挑其中一条执行。
`;

const sql = `${header}${body}`;
const leak = SECRET.exec(sql);
if (leak) { console.error(`✗ 生成的 SQL 里有像密钥的串（${leak[0].slice(0, 6)}…）—— 模板行不该带敏感值，先查是哪一列`); process.exit(1); }

if (check) {
  const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const same = now.replace(/\r\n/g, '\n') === sql;
  console.log(same ? `接口模板初始化 SQL 与 seed 一致 ✓（${SEED_TEMPLATES.length} 份）` : '✗ docs/provider-template-init.sql 与 seed 不一致，重跑 tools/gen-template-init-sql.mjs');
  process.exit(same ? 0 : 1);
}
fs.writeFileSync(OUT, sql, 'utf8');
console.log(`已写入 docs/provider-template-init.sql（${SEED_TEMPLATES.length} 份模板 · ${sql.split('\n').length} 行）`);
