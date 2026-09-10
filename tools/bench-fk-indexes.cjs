// 外键成本基准：对比 SQLite 外键 ON / OFF / 补索引 / 删触发器 四种模式下的写入与删除成本
//
// 用途：给「要不要删外键」这类设计决策提供实测依据；DDL 变更后重跑可验证是否退化。
// 运行： node --experimental-sqlite tools/bench-fk-indexes.cjs
//
// 实测结论（2026-09，31k 行 / 5000 行连接线表）：
//   · 外键强制检查 ≈ 1µs/行（31k 行插入差 7~32ms，落入抖动范围）→ 不是瓶颈
//   · 缺索引才是瓶颈：删 200 个被引用端点 3592ms → 补索引 131ms（27×）
//   · 关掉外键"很快"是假象：它根本没做清理（1 万条连接线悬空、章节删除未级联）
//   · 触发器比外键贵（131ms → 35ms），但承载同章节一致性/孤儿清理/类型切换
//   · 最大杠杆是批处理：300 行逐条提交 387ms vs 单事务 6.1ms（63×）
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ddl = fs.readFileSync('docs/db-schema-v2.sql', 'utf8');
const TMP = path.join(os.tmpdir(), 'mv-fk-bench');
fs.mkdirSync(TMP, { recursive: true });

const N_POINT = 5000;      // 点元素
const N_CONN = 5000;       // 连接线（引用前 200 个点）
const N_LABEL = 1000;
const N_KF = 20000;        // 关键帧
const DEL_TARGETS = 200;   // 被删除的端点数量（每个被 2 条连接线引用）

const EXTRA_INDEXES = [
  'CREATE INDEX IF NOT EXISTS ix_conn_from ON element_connector(chapter_id, from_element_id)',
  'CREATE INDEX IF NOT EXISTS ix_conn_to   ON element_connector(chapter_id, to_element_id)',
];

function openDb(tag, fk, extra, dropTriggers) {
  const p = path.join(TMP, tag + '.db');
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(p + suffix, { force: true });
  const db = new DatabaseSync(p, { enableForeignKeyConstraints: fk });
  db.exec(ddl);                    // 注意：DDL 第 9 行自带 PRAGMA foreign_keys = ON
  if (!fk) db.exec('PRAGMA foreign_keys = OFF');   // 必须在建表之后才能真正关掉
  if (extra) for (const s of EXTRA_INDEXES) db.exec(s);
  if (dropTriggers) {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((r) => r.name);
    for (const n of names) db.exec(`DROP TRIGGER IF EXISTS ${n}`);
  }
  let on = null;
  try { on = Object.values(db.prepare('PRAGMA foreign_keys').get())[0]; } catch { /* ignore */ }
  return { db, fkOn: on === 1 };
}

const ms = (fn) => {
  const t = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
};

const rs = (db, sql) => {
  try { return Object.values(db.prepare(sql).get())[0]; } catch (e) { return 'ERR:' + e.message.slice(0, 60); }
};

function seed(db) {
  const now = Date.now();
  db.exec('BEGIN');
  db.prepare(`INSERT INTO project (project_id,name,created_at,updated_at,default_duration,default_fps,resolution_w,resolution_h,resolution_label,default_easing)
              VALUES (?,?,?,?,?,?,?,?,?,?)`).run('p1', 'bench', now, now, 300, 30, 1920, 1080, '1080p', 'easeInOut');
  db.prepare(`INSERT INTO chapter (chapter_id,project_id,title,order_index,start_frame,end_frame) VALUES (?,?,?,?,?,?)`)
    .run('c1', 'p1', '章一', 0, 0, 9000);

  const insEl = db.prepare(`INSERT INTO element (element_id,chapter_id,type,name,start_frame,end_frame,z_index,ord) VALUES (?,?,?,?,?,?,?,?)`);
  const insPt = db.prepare(`INSERT INTO element_point (element_id,lng,lat,shape,scale) VALUES (?,?,?,?,?)`);
  const insCn = db.prepare(`INSERT INTO element_connector (element_id,chapter_id,from_element_id,to_element_id) VALUES (?,?,?,?)`);
  const insLb = db.prepare(`INSERT INTO element_label (element_id,text) VALUES (?,?)`);
  const insKf = db.prepare(`INSERT INTO element_keyframe (kf_id,element_id,property,frame,value_num) VALUES (?,?,?,?,?)`);
  const P = ['opacity', 'scale', 'rotation', 'draw_progress', 'progress', 'path_progress', 'fill_progress', 'morph'];

  for (let i = 0; i < N_POINT; i++) {
    const id = 'pt' + i;
    insEl.run(id, 'c1', 'point', '点' + i, 0, 9000, i, i);
    insPt.run(id, 116.4 + i * 1e-5, 39.9, 'pin', 1);
  }
  for (let i = 0; i < N_CONN; i++) {
    const id = 'cn' + i;
    insEl.run(id, 'c1', 'connector', '线' + i, 0, 9000, N_POINT + i, i);
    insCn.run(id, 'c1', 'pt' + (i % DEL_TARGETS), 'pt' + ((i + 3) % DEL_TARGETS));
  }
  for (let i = 0; i < N_LABEL; i++) insLb.run('pt' + i, '标签' + i);
  for (let i = 0; i < N_KF; i++) {
    // (element_id, property) 在前 40000 次循环内唯一，frame 取常量，避免撞 UNIQUE 约束
    insKf.run('kf' + i, 'pt' + (i % N_POINT), P[Math.floor(i / N_POINT) % 8], 0, 0.5);
  }
  db.exec('COMMIT');
}

function bench(tag, fk, extra, dropTriggers) {
  const { db, fkOn } = openDb(tag, fk, extra, dropTriggers);

  // A. 建库写入（单事务）
  const tInsert = ms(() => seed(db));

  // B. 删除被引用的端点元素（触发 CASCADE + 孤儿清理触发器）
  const targets = Array.from({ length: DEL_TARGETS }, (_, i) => `'pt${i}'`).join(',');
  const tDeleteParents = ms(() => db.exec(`DELETE FROM element WHERE element_id IN (${targets})`));

  // C. 删除整章（全量级联）
  const tDeleteChapter = ms(() => db.exec(`DELETE FROM chapter WHERE chapter_id = 'c1'`));

  const res = {
    tag,
    fkOn,
    insertMs: +tInsert.toFixed(1),
    deleteInboundMs: +tDeleteParents.toFixed(2),
    deleteChapterMs: +tDeleteChapter.toFixed(2),
    orphansAfter: rs(db, 'SELECT COUNT(*) FROM v_check_subtype_missing'),
    danglingAfter: rs(db, 'SELECT COUNT(*) FROM v_check_dangling'),
    elementsLeft: rs(db, 'SELECT COUNT(*) FROM element'),
  };
  db.close();
  return res;
}

// D. 批处理对比：同样的真实写入，逐条自动提交 vs 单事务（外键开启）
function batching() {
  const { db } = openDb('batch', true, false);
  db.exec('BEGIN');
  db.prepare(`INSERT INTO project (project_id,name,created_at,updated_at,default_duration,default_fps,resolution_w,resolution_h,resolution_label,default_easing)
              VALUES (?,?,?,?,?,?,?,?,?,?)`).run('p1', 'b', 1, 1, 300, 30, 1920, 1080, '1080p', 'ease');
  db.prepare(`INSERT INTO chapter (chapter_id,project_id,title,order_index,start_frame,end_frame) VALUES (?,?,?,?,?,?)`).run('c1', 'p1', 'c', 0, 0, 100);
  db.exec('COMMIT');

  const el = db.prepare(`INSERT INTO element (element_id,chapter_id,type,name,start_frame,end_frame) VALUES (?,?,?,?,?,?)`);
  const pt = db.prepare(`INSERT INTO element_point (element_id,lng,lat,shape,scale) VALUES (?,?,?,?,?)`);
  const N = 300;
  const oneByOne = ms(() => {
    for (let i = 0; i < N; i++) {
      el.run('b' + i, 'c1', 'point', 'x', 0, 100);
      pt.run('b' + i, 116, 39, 'pin', 1);
    }
  });
  const inTx = ms(() => {
    db.exec('BEGIN');
    for (let i = 0; i < N; i++) {
      el.run('t' + i, 'c1', 'point', 'x', 0, 100);
      pt.run('t' + i, 116, 39, 'pin', 1);
    }
    db.exec('COMMIT');
  });
  db.close();
  return { rows: N, autocommitMs: +oneByOne.toFixed(1), oneTransactionMs: +inTx.toFixed(1) };
}

// E. 真实项目规模：数百元素量级，看外键的绝对成本（微秒级）
function smallScale(fk) {
  const { db } = openDb('small-' + (fk ? 'on' : 'off'), fk, false);
  const now = Date.now();
  db.exec('BEGIN');
  db.prepare(`INSERT INTO project (project_id,name,created_at,updated_at,default_duration,default_fps,resolution_w,resolution_h,resolution_label,default_easing)
              VALUES (?,?,?,?,?,?,?,?,?,?)`).run('p1', 's', now, now, 300, 30, 1920, 1080, '1080p', 'ease');
  db.prepare(`INSERT INTO chapter (chapter_id,project_id,title,order_index,start_frame,end_frame) VALUES (?,?,?,?,?,?)`).run('c1', 'p1', 'c', 0, 0, 9000);
  const el = db.prepare(`INSERT INTO element (element_id,chapter_id,type,name,start_frame,end_frame) VALUES (?,?,?,?,?,?)`);
  const pt = db.prepare(`INSERT INTO element_point (element_id,lng,lat,shape,scale) VALUES (?,?,?,?,?)`);
  const cn = db.prepare(`INSERT INTO element_connector (element_id,chapter_id,from_element_id,to_element_id) VALUES (?,?,?,?)`);
  for (let i = 0; i < 300; i++) { const id = 'pt' + i; el.run(id, 'c1', 'point', 'p', 0, 9000); pt.run(id, 116, 39, 'pin', 1); }
  for (let i = 0; i < 300; i++) { const id = 'cn' + i; el.run(id, 'c1', 'connector', 'c', 0, 9000); cn.run(id, 'c1', 'pt' + (i % 20), 'pt' + ((i + 5) % 20)); }
  db.exec('COMMIT');

  const targets = Array.from({ length: 20 }, (_, i) => `'pt${i}'`).join(',');
  const t = ms(() => db.exec(`DELETE FROM element WHERE element_id IN (${targets})`));
  const res = { fk: fk ? 'on' : 'off', deleteMs: +t.toFixed(3), perElementUs: +((t * 1000) / 20).toFixed(1) };
  db.close();
  return res;
}


const out = {
  scale: { N_POINT, N_CONN, N_LABEL, N_KF, DEL_TARGETS },
  runs: [
    bench('fk-on-noindex', true, false, false),
    bench('fk-on-indexed', true, true, false),
    bench('fk-on-indexed-notriggers', true, true, true),
    bench('fk-off-indexed', false, true, false),
  ],
  batching: batching(),
  smallScale: [smallScale(true), smallScale(false)],
};
console.log(JSON.stringify(out, null, 2));
fs.rmSync(TMP, { recursive: true, force: true });
