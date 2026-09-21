#!/usr/bin/env node
/**
 * gen-db-field-dict.mjs — 从 DDL 生成「逐表字段字典」（Markdown），注入 docs/db-tables.md
 *
 * 为什么用生成而不是手写：22 张表 300+ 个列，手写必然与 DDL 漂移。
 * 本脚本把 DDL 当作唯一事实源，改了 DDL 重跑即可，且会断言与 SQLite 解析结果一致。
 * 注：文档一律用 Markdown（2026-09-11 起不再生成 HTML）。
 *
 * 用法：
 *   node --experimental-sqlite tools/gen-db-field-dict.mjs                # 默认 docs/db-schema-v2.sql → docs/db-tables.md
 *   node --experimental-sqlite tools/gen-db-field-dict.mjs --check        # 只校验不写入（CI/提交前用）
 *   node --experimental-sqlite tools/gen-db-field-dict.mjs --ddl x.sql --md y.md
 *
 * 注入位置：docs/db-tables.md 中 <!-- FIELD-DICT:BEGIN --> 与 <!-- FIELD-DICT:END --> 之间
 * 退出码：0 正常；1 校验失败或标记缺失
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import FIELD_NOTES from './db-field-notes.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};
const CHECK_ONLY = argv.includes('--check');
const DDL = opt('--ddl', 'docs/db-schema-v2.sql');
const MD = opt('--md', 'docs/db-tables.md');
const MARKER = 'FIELD-DICT';

// 分组：与 db-tables.md §3 保持一致（顺序即输出顺序）
// 元素部分按「工具条按钮」分类（见 docs/db-tables.md 第五节），而非按技术结构分类
const GROUPS = [
  ['组 1 · 合集 / 项目 / 图层（含配置）', ['collection', 'project', 'layer']],
  ['组 2 · 底图 / 高程图 / 素材', ['base_map', 'elevation_map', 'asset']],
  ['组 3 · 时间轴', ['camera_keyframe', 'screen_fx', 'narration', 'narration_entry', 'music_track']],
  ['组 4 · 标记类元素（Pin 工具）', ['element_marker']],
  ['组 5 · 路线类元素（Route 工具）', ['element_route']],
  ['组 6 · 形状类元素（Shape 工具）', ['element_shape']],
  ['组 7 · 疆域类元素（Terr 工具）', ['element_territory']],
  ['组 8 · 贴图类元素（Image 工具）', ['element_image']],
  ['组 9 · 叠加层（弹窗）', ['overlay']],
  ['组 10 · 应用配置', ['provider', 'provider_endpoint']],
  ['组 11 · 公共图层与公共元素（跨项目图库）', ['public_layer', 'public_element_marker', 'public_element_route', 'public_element_shape', 'public_element_territory', 'public_element_image']],
];

// 元素表的「工具入口」标注（事实源：src/components/Toolbar.tsx 的 TOOLS / SHAPE_GROUPS / TERR_ITEMS
// + interactionStore 的 PlaceKind + PropertiesPanel 的标记形态切换）
// 2026-09-10 改版：5 张类别宽表，每表用 type 判别列承载该工具下的全部元素类型
const TOOL_ENTRY = {
  element_marker: 'Pin 工具（一键放置到地图中心）；标记面板切到 Marker（旗标）、导入/旧数据的军标也写这张表',
  element_route: 'Route 工具；Shape 子菜单的直线/曲线/带箭头/战线/行军箭头也写这张表',
  element_shape: 'Shape：多边形/曲线多边/防御圈/圆/矩形/五角星/钳形/集结地/包围圈；Region 工具的行政区高亮也写这张表',
  element_territory: 'Terr：新建疆域 / 绘制地块 / 兼并（势力、地块、事件 JSON 内联在本表）',
  element_image: 'Image 工具（工具栏「图片」）：导入图片做地理配准贴图（四角/网格变形），图片本体走全局素材库',
  element_keyframe: '跨类别（所有元素共用，按 element_id 弱引用）',
};

/**
 * 每张表「职责 + 对应的前端元素」（工具栏按钮 / 组件文件 / TS 类型）。
 * 字段字典每表头部输出一行，速查页第三节的手工表格与此保持同源语义。
 * 标注「当前无 UI 入口」的表 = store/DDL 已支持但面板尚未接入。
 */
const TABLE_FRONTEND = {
  collection: { role: '合集：项目之上的一层分组（合集 ▸ 项目 ▸ 章节 ▸ 元素）', fe: '项目列表页左栏合集列表（ProjectManager.tsx）' },
  project: { role: '项目本体：身份 / 归属 / 审计 / 投影 / 生效底图与高程指针', fe: '项目列表页项目卡片（ProjectManager.tsx）；运行时即 projectStore.project' },
  layer: { role: '图层：元素的分组（项目 ▸ 图层 ▸ 元素），单类型图层，带显隐与显示区间', fe: '左侧「图层」浮层（ElementsPanel.tsx）+ 时间线图层轨道' },
  base_map: { role: '底图目录：项目自带一份（内置项创建项目时复制进来），可增删改', fe: '地图左下角「底图」芯片面板（MapStyleChip.tsx）+ projectStore.addBaseMap / removeBaseMap' },
  elevation_map: { role: '高程图目录：项目自带一份，地形夸张系数直接落在本行', fe: '底图芯片面板的「高程」区（MapStyleChip.tsx 选择 + 夸张系数滑动条）' },
  asset: { role: '素材仓库（**唯一**素材存储，合并原 custom_symbol / custom_image）：按项目 / 类型 / 时间戳落盘', fe: '属性面板上传行（PropertiesPanel ResourceUploadRow）、标记面板自定义图片网格（CustomImageGrid）、字幕配音 / 配乐音频上传、导出配置内嵌还原（lib/assets.ts）' },
  camera_keyframe: { role: '视角关键帧（停留 → 飞行 → 落位；follow / orbit 视角）', fe: '「视角」面板（KeyframePanel.tsx / CameraEditor.tsx）' },
  screen_fx: { role: '屏幕空间特效窗口（天气 / 画面叠加，非地图元素）', fe: '右侧「特效」面板（FxPanelBody.tsx）+ 时间轴特效轨道' },
  narration: { role: '字幕 / 配音档（样式部分，1:1）', fe: '顶栏「字幕生成」弹窗的字幕样式区（GenerateDialog.tsx）' },
  narration_entry: { role: '字幕条：文本 + 配音音频 + 显示时长', fe: '顶栏「字幕生成」弹窗逐条编辑 / TTS / 导入 SRT（GenerateDialog.tsx）+ 时间轴「🎙 配音」轨道（TimelineEditor.tsx）' },
  music_track: { role: '项目级背景音乐：单轨多段（绝对时间、循环、淡入淡出）', fe: '时间轴「音乐」轨道（TimelineEditor.tsx）+ 音乐面板（内置/导入）' },
  element_marker: { role: '标记类元素：Pin 工具产出，3 种 type 合并一张宽表', fe: '工具条「标记」按钮 + 标记属性面板（PropertiesPanel，10 种视觉形态）' },
  element_route: { role: '路线类元素：line / moving_point', fe: '工具条「路线」按钮 + 路线属性面板（含均匀移动与逐点到达时间）' },
  element_shape: { role: '形状类元素：polygon / arrow / double_arrow / gathering / encirclement（Region 行政区也写此表）', fe: '工具条「形状」下拉 + 形状属性面板' },
  element_territory: { role: '疆域元素：势力 / 地块 / 兼并事件 JSON 内联，自包含', fe: '工具条「疆域」下拉（TerritoryImportDialog.tsx 导入 + 疆域属性面板）' },
  element_image: { role: '贴图元素：地理配准图片（控制点网格），图片存全局素材库、本表只存配准参数', fe: '工具条「图片」（导入/素材库插入）+ 贴图属性面板（PropertiesPanel GeoImageSettings）' },
  overlay: { role: '弹窗本体（10 类内容：文本 / 图片 / 图表 / 人物 / 对话…）', fe: '右侧「弹窗」面板（FxPanelBody.tsx）+ 画面渲染 fx/FxRender.tsx OverlayContentView' },
  overlay_block: { role: 'custom 类弹窗的内容块序列（逐块排序）', fe: '弹窗面板「自定义」类型的块编辑（FxPanelBody.tsx）' },
  person_block: { role: '人物卡片内容块（头像 / 姓名 / 简介 / 引言 / 对白 5 种）', fe: '弹窗面板「人物」类型的块编辑（FxPanelBody.tsx）' },
  provider: { role: 'AI 服务商配置：文案生成 / 语音（含克隆）/ 图片生成（Key 只存本机，与项目内容解耦）', fe: '顶栏「设置 · AI」弹窗（SettingsDialog.tsx，左侧切换三类能力）' },
  provider_endpoint: { role: '接口模板行：一家供应商配齐的每个 role 一条（怎么发、怎么取回、同步还是异步）', fe: '顶栏「设置 · AI」→ 供应商详情（接口模板页签，批次 3）' },
  public_layer: { role: '公共图层：跨项目图库的图层（把项目图层连元素整体复制过来）', fe: '左侧「图层」浮层「加入公共图层 / 导入公共图层」' },
  public_element_marker: { role: '公共标记元素（public_layer 内副本，与 element_marker 同构）', fe: '同上' },
  public_element_route: { role: '公共路线元素（public_layer 内副本，与 element_route 同构）', fe: '同上' },
  public_element_shape: { role: '公共形状元素（public_layer 内副本，与 element_shape 同构）', fe: '同上' },
  public_element_territory: { role: '公共疆域元素（public_layer 内副本，与 element_territory 同构）', fe: '同上' },
  public_element_image: { role: '公共贴图元素（public_layer 内副本，与 element_image 同构）', fe: '同上' },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- 解析 DDL ----------
const ddl = fs.readFileSync(DDL, 'utf8');

/** 去掉字符串字面量后的文本，用于安全地找注释/括号 */
function maskQuotes(s) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") inStr = !inStr;
    out += inStr ? ' ' : c;
  }
  return out;
}

/** 从括号内的内容里切出顶层逗号分隔的项，并收集每项的 -- 注释 */
function splitItems(body) {
  const items = [];
  let buf = '';
  let depth = 0;
  let comments = [];
  let inStr = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "'") inStr = !inStr;
    if (!inStr && c === '-' && body[i + 1] === '-') {
      let j = body.indexOf('\n', i);
      if (j === -1) j = body.length;
      comments.push(body.slice(i + 2, j).trim());
      i = j;
      continue;
    }
    if (!inStr && c === '(') depth++;
    if (!inStr && c === ')') depth--;
    if (!inStr && c === ',' && depth === 0) {
      items.push({ raw: buf.trim(), comments: comments.filter(Boolean) });
      buf = '';
      comments = [];
      continue;
    }
    buf += c;
  }
  if (buf.trim() || comments.length) items.push({ raw: buf.trim(), comments: comments.filter(Boolean) });
  return items;
}

/** 提取平衡括号内的内容（引号感知：不把字符串里的括号当层级，但保留字符串原文） */
function parens(s, keyword) {
  const out = [];
  const re = new RegExp(keyword + '\\s*\\(', 'gi');
  let m;
  while ((m = re.exec(s))) {
    let depth = 0;
    let inStr = false;
    const start = m.index + m[0].length - 1;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (ch === "'") inStr = !inStr;
      if (!inStr && ch === '(') depth++;
      else if (!inStr && ch === ')') {
        depth--;
        if (depth === 0) {
          out.push(s.slice(start + 1, i).replace(/\s+/g, ' ').trim());
          re.lastIndex = i;
          break;
        }
      }
    }
  }
  return out;
}

const tables = new Map();
const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(/gi;
let m;
while ((m = createRe.exec(ddl))) {
  const name = m[1];
  // 找匹配的右括号
  let depth = 0;
  let end = -1;
  for (let i = m.index + m[0].length - 1; i < ddl.length; i++) {
    if (ddl[i] === '(') depth++;
    else if (ddl[i] === ')') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const bodyRaw = ddl.slice(m.index + m[0].length, end);
  // 建表行的行尾注释（如 element_point ( -- type = 'point'）属于「表」而非第一个字段
  let body = bodyRaw;
  let tableComment = null;
  const firstLineEnd = bodyRaw.indexOf('\n');
  const firstLine = firstLineEnd === -1 ? bodyRaw : bodyRaw.slice(0, firstLineEnd);
  const headComment = firstLine.match(/--\s*(.+)$/);
  if (headComment) {
    tableComment = headComment[1].trim();
    body = bodyRaw.replace(firstLine, firstLine.replace(/--.*$/, ''));
  }

  const cols = [];
  const constraints = [];
  for (const it of splitItems(body)) {
    const masked = maskQuotes(it.raw);
    if (/^(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|CONSTRAINT)\b/i.test(it.raw)) {
      constraints.push({
        kind: it.raw.split(/\s+/)[0].toUpperCase(),
        text: it.raw.replace(/\s+/g, ' ').trim(),
        comments: it.comments,
      });
      continue;
    }
    const nameM = it.raw.match(/^(\w+)\s+([\s\S]+)$/);
    if (!nameM) continue;
    const colName = nameM[1];
    const rest = nameM[2];
    const typeM = rest.match(/^\s*(TEXT|INTEGER|REAL|BLOB|NUMERIC|INT)\b/i);
    const refM = rest.match(/REFERENCES\s+(\w+)\s*\(([^)]*)\)(?:\s+ON\s+DELETE\s+(CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION))?/i);
    const defM = maskQuotes(rest).match(/DEFAULT\s+([^,\s]+(?:\([^)]*\))?)/i);
    cols.push({
      name: colName,
      type: typeM ? typeM[1].toUpperCase() : '',
      notNull: /\bNOT\s+NULL\b/i.test(masked),
      pk: /\bPRIMARY\s+KEY\b/i.test(masked),
      unique: /\bUNIQUE\b/i.test(masked),
      default: defM ? rest.slice(defM.index + defM[0].indexOf('DEFAULT') + 7, defM.index + defM[0].length).trim() : null,
      ref: refM ? { table: refM[1], cols: refM[2].split(',').map((c) => c.trim()).join(','), onDelete: (refM[3] || '').replace(/\s+/g, ' ').toUpperCase() } : null,
      checks: parens(it.raw, 'CHECK'),
      comment: it.comments.join(' ') || null,
    });
  }
  tables.set(name, { name, comment: tableComment, cols, constraints });
}

// ---------- 与 SQLite 实测结构交叉校验 ----------
const tmp = path.join(os.tmpdir(), `mv-field-dict-${Date.now()}.db`);
const db = new DatabaseSync(tmp);
db.exec(ddl);
const sqliteTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const problems = [];
for (const t of sqliteTables) {
  const parsed = tables.get(t);
  if (!parsed) { problems.push(`DDL 解析漏掉表 ${t}`); continue; }
  const info = db.prepare(`PRAGMA table_info(${t})`).all();
  if (info.length !== parsed.cols.length) {
    problems.push(`${t} 列数不一致：解析 ${parsed.cols.length} vs SQLite ${info.length}`);
  }
  const names = info.map((c) => c.name).join(',');
  const parsedNames = parsed.cols.map((c) => c.name).join(',');
  if (names !== parsedNames) problems.push(`${t} 列名/顺序不一致：\n  解析  ${parsedNames}\n  SQLite ${names}`);
  const fkSqlite = db.prepare(`PRAGMA foreign_key_list(${t})`).all().length;
  // 注意：PRAGMA 对复合外键是「一列一行」，所以这里比的是外键列数而非约束个数
  const fkParsedCols =
    parsed.cols.filter((c) => c.ref).length +
    parsed.constraints
      .filter((c) => c.kind === 'FOREIGN')
      .reduce((n, c) => n + (c.text.match(/^FOREIGN\s+KEY\s*\(([^)]*)\)/i)?.[1].split(',').length ?? 0), 0);
  if (fkSqlite !== fkParsedCols) problems.push(`${t} 外键列数不一致：解析 ${fkParsedCols} vs SQLite ${fkSqlite}`);
}
for (const t of tables.keys()) if (!sqliteTables.includes(t)) problems.push(`解析出多余表 ${t}`);

const used = new Set(GROUPS.flatMap(([, list]) => list));
for (const t of sqliteTables) if (!used.has(t)) problems.push(`表 ${t} 未归入任何分组`);
for (const t of used) if (!sqliteTables.includes(t)) problems.push(`分组引用了不存在的表 ${t}`);

// 字段说明：tools/db-field-notes.mjs 优先，DDL 内联注释兜底；缺失即报错
for (const t of sqliteTables) {
  for (const c of tables.get(t).cols) {
    const note = FIELD_NOTES[t]?.[c.name];
    c.descSource = note && note.trim() ? 'notes' : c.comment && c.comment.trim() ? 'ddl' : null;
    c.desc = (note && note.trim()) || (c.comment && c.comment.trim()) || null;
  }
}
const descStats = sqliteTables.reduce(
  (acc, t) => {
    for (const c of tables.get(t).cols) {
      if (c.descSource === 'notes') acc.notes++;
      else if (c.descSource === 'ddl') acc.ddl.push(`${t}.${c.name}`);
    }
    return acc;
  },
  { notes: 0, ddl: [] },
);
const noDesc = sqliteTables.flatMap((t) => tables.get(t).cols.filter((c) => !c.desc).map((c) => `${t}.${c.name}`));
if (noDesc.length) {
  problems.push(`以下 ${noDesc.length} 个字段缺说明，请补 tools/db-field-notes.mjs：\n    ` + noDesc.join('\n    '));
}
const stale = [];
for (const [t, cols] of Object.entries(FIELD_NOTES)) {
  if (!sqliteTables.includes(t)) { stale.push(`${t}（该表不存在）`); continue; }
  const names = new Set(tables.get(t).cols.map((c) => c.name));
  for (const col of Object.keys(cols)) if (!names.has(col)) stale.push(`${t}.${col}`);
}
if (stale.length) {
  problems.push(`tools/db-field-notes.mjs 有 ${stale.length} 条失效条目（DDL 中已无此表/字段）：\n    ` + stale.join('\n    '));
}

db.close();
for (const s of ['', '-wal', '-shm']) fs.rmSync(tmp + s, { force: true });

if (problems.length) {
  console.error('校验失败：');
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}

// ---------- 生成 Markdown ----------
const totalCols = sqliteTables.reduce((n, t) => n + tables.get(t).cols.length, 0);

// 约束徽标（Markdown 行内代码）
const badge = (c) => {
  const parts = [];
  if (c.pk) parts.push('`PK`');
  if (c.notNull && !c.pk) parts.push('`NOT NULL`');
  if (c.unique && !c.pk) parts.push('`UNIQUE`');
  if (c.ref) parts.push(`\`FK → ${c.ref.table}${c.ref.onDelete ? ' ' + c.ref.onDelete : ''}\``);
  return parts.join(' ') || '—';
};

// 表格单元格转义：竖线与换行
const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

const out = [];
out.push(`> 本节由 DDL 自动生成（\`tools/gen-db-field-dict.mjs\`），共 **${sqliteTables.length} 张表 / ${totalCols} 个列，每列都有中文说明**。字段说明取自 \`tools/db-field-notes.mjs\`（人工词表，${descStats.notes} 条），结构与约束取自 DDL；脚本会与 SQLite 实测结构交叉校验，并强制「每个字段必须有说明」，缺一条就报错。\n`);
out.push('> 元素相关的 **5 张类别宽表按工具条分类**（标记 / 路线 / 形状 / 疆域 / 图片），每张表用 `type` 判别列承载该工具下的全部元素类型。工具条的完整对照见本文第五节。\n');
out.push('> 读法：**列**为字段名；**约束**中 `PK` 主键、`NOT NULL` 必填、`FK` 外键（其后为删除行为：CASCADE 级联删除 / SET NULL 置空 / RESTRICT 拒绝删除）。\n');

out.push('#### 快速跳转\n');
for (const [g, list] of GROUPS) {
  out.push(`- **${g}**：${list.map((t) => '`' + t + '`').join(' · ')}`);
}
out.push('');

for (const [g, list] of GROUPS) {
  out.push(`### ${g}\n`);
  for (const t of list) {
    const tb = tables.get(t);
    const pkCols = tb.cols.filter((c) => c.pk).map((c) => c.name).join(' + ');
    const entry = TOOL_ENTRY[t];
    const fe = TABLE_FRONTEND[t];
    out.push(`#### ${t}${tb.comment ? ` — ${tb.comment}` : ''}\n`);
    if (fe) out.push(`**职责**：${fe.role}　**前端**：${fe.fe}\n`);
    out.push(`${tb.cols.length} 列 · 主键 ${pkCols ? '`' + pkCols + '`' : '—'}${entry ? ` · 工具入口：${entry}` : ''}\n`);
    out.push('| 列 | 类型 | 约束 | 说明 |');
    out.push('|---|---|---|---|');
    for (const c of tb.cols) {
      const notes = [];
      if (c.desc) notes.push(c.desc);
      if (c.default) notes.push(`默认 \`${c.default}\``);
      if (c.checks.length) notes.push(c.checks.map((x) => `\`CHECK (${x})\``).join(' '));
      out.push(`| \`${c.name}\` | ${c.type || '—'} | ${badge(c)} | ${cell(notes.join(' · '))} |`);
    }
    out.push('');
    if (tb.constraints.length) {
      out.push('**表级约束**\n');
      for (const c of tb.constraints) {
        const extra = c.comments.length ? `（${c.comments.join('；')}）` : '';
        out.push(`- \`${c.text}\`${extra}`);
      }
      out.push('');
    }
  }
}

const generated = out.join('\n');
const begin = `<!-- ${MARKER}:BEGIN -->`;
const end = `<!-- ${MARKER}:END -->`;

if (CHECK_ONLY) {
  console.log(`校验通过：${sqliteTables.length} 张表 / ${totalCols} 列，分组完整，与 SQLite 结构一致`);
  console.log(`字段说明：词表 ${descStats.notes} 条` + (descStats.ddl.length ? ` · 沿用 DDL 内联注释 ${descStats.ddl.length} 条（${descStats.ddl.join(', ')}）` : ' · 全覆盖'));
  console.log(`生成内容 ${(generated.length / 1024).toFixed(1)}KB（--check 模式未写入）`);
  process.exit(0);
}

const md = fs.readFileSync(MD, 'utf8');
const bi = md.indexOf(begin);
const ei = md.indexOf(end);
if (bi === -1 || ei === -1) {
  console.error(`注入失败：${MD} 中找不到 ${begin} / ${end} 标记对`);
  process.exit(1);
}
fs.writeFileSync(MD, md.slice(0, bi + begin.length) + '\n' + generated + '\n' + md.slice(ei), 'utf8');
console.log(`已注入 ${MD}：${sqliteTables.length} 张表 / ${totalCols} 列（说明：词表 ${descStats.notes} 条${descStats.ddl.length ? ` + DDL 注释 ${descStats.ddl.length} 条` : ''}），生成内容 ${(generated.length / 1024).toFixed(1)}KB`);
