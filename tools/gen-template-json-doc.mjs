/**
 * gen-template-json-doc.mjs — 把内置模板的**具体参数与逐列 JSON** 注入 docs/provider-engine.md 第九节
 *
 * 为什么要有这条：第九节原先是手抄的 TS 片段，还拿 `/* … *\/` 把参数表省略掉了 ——
 * 于是「文档里到底声明了哪些参数、每列 JSON 长什么样」这个问题答不出来，改 seed 也没人发现文档过期。
 * 现在这节是生成的：事实源只有一个（`src/lib/template-seed.ts`），文档只是它的一份可读投影。
 *
 *   node --experimental-strip-types tools/gen-template-json-doc.mjs            # 写入
 *   node --experimental-strip-types tools/gen-template-json-doc.mjs --check    # 只校验（漂移则退出码 1）
 * 与 `gen-db-field-dict.mjs` 同一条链：改了表内容 / 字段说明就回来重跑一次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQ_LABEL, requiredOutputsOf, slotsOf } from '../src/lib/request-engine.ts';
import { SEED_TEMPLATES } from '../src/lib/template-seed.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(ROOT, 'docs', 'provider-engine.md');
const CHECK = process.argv.includes('--check');
const BEGIN = '<!-- BEGIN generated:seed-templates -->';
const END = '<!-- END generated:seed-templates -->';

const SLOT_COL = [
  ['sync.submit', 'sync_json', (t) => t.sync],
  ['async.submit', 'async_json', (t) => t.async],
  ['upload', 'upload_json', (t) => t.upload],
  ['clone', 'clone_json', (t) => t.clone],
];

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const json = (v) => '```json\n' + JSON.stringify(v ?? null, null, 2) + '\n```';

/** 候选值 / 范围 / 文件限制挤进同一列：一个参数只可能用得上其中一种 */
function rangeOf(p) {
  if (p.options?.length) {
    return p.options.map((o) => (typeof o === 'object' && o !== null ? `${o.value}（${o.label ?? ''}）` : String(o))).join(' · ');
  }
  if (p.valueType === 'number' || p.min !== undefined || p.max !== undefined) {
    return [p.min !== undefined ? `≥${p.min}` : '', p.max !== undefined ? `≤${p.max}` : '', p.step !== undefined ? `步长 ${p.step}` : '']
      .filter(Boolean).join(' ') || '—';
  }
  if (p.valueType === 'file') return [p.accept && `接受 ${p.accept}`, p.maxSize && `上限 ${p.maxSize}`].filter(Boolean).join('，') || '—';
  if (p.valueType === 'array' || p.valueType === 'list') return p.itemType ? `元素 ${p.itemType}` : '—';
  return '—';
}

/** 参数总表：声明层 + key + 显示名 + 类型 + 默认值 + 候选值/范围（没有「必填」「加工」这两列 —— 声明出来的参数只有两个来源：实例里填、调用时给） */
function paramRows(t) {
  const rows = [];
  const push = (layer, list) => (list ?? []).forEach((p) => rows.push(
    `| ${layer} | \`${p.key}\` | ${cell(p.label)} | ${p.valueType ?? 'string'} | ${p.defaultValue === undefined ? '—' : '`' + cell(JSON.stringify(p.defaultValue)) + '`'} | ${cell(rangeOf(p))} |`));
  push('实例级', t.instanceParams);
  for (const [slot] of SLOT_COL) {
    const def = slot === 'sync.submit' ? t.sync?.submit : slot === 'async.submit' ? t.async?.submit
      : slot === 'upload' ? t.upload : t.clone;
    if (!def) continue;
    push(`这一格 \`${slot}\``, def.requestParams);
  }
  return rows;
}

const HEAD = '| 层 | key | 显示名 | 类型 | 默认值 | 候选值 / 范围 |\n|---|---|---|---|---|---|';

function block() {
  const out = [];
  out.push('### 9.1 能力开关');
  out.push('');
  out.push('`caps_json` 一列装着全部开关，**该有哪些接口槽、每槽必须交出哪些字段、那一格发 Body 还是表单，全由它推导**（`slotsOf` / `requiredOutputsOf` / `multipartSlotOf`）。');
  out.push('界面上「调用方式」是**同步 / 异步 两个复选框**（存的就是 `modes`：只勾一个 = `sync`/`async`，都勾 = `both`）；「建音色」是**克隆开关 + 参考音频三选一**（`cloneVia`：`upload` 先传拿 `fileRef` / `base64` 文件进 JSON 体 / `form` 克隆那格自己发 multipart）。');
  out.push('');
  out.push('| 模板 | 调用方式 | 产物形式 | 建音色 | 参考音频怎么交 | 推导出的接口槽 |');
  out.push('|---|---|---|---|---|---|');
  for (const t of SEED_TEMPLATES) {
    out.push(`| \`${t.id}\` | ${t.caps.modes} | ${t.caps.artifact} | ${t.caps.clone ? '是' : '否'} | ${t.caps.clone ? `\`${t.caps.cloneVia}\`` : '—'} | ${slotsOf(t).map((k) => `\`${REQ_LABEL[k]}\``).join(' + ') || '（无）'} |`);
  }
  out.push('');
  out.push('### 9.2 每格必须交出的返回项（名字写死，只能填路径）');
  out.push('');
  out.push('这些名字就是引擎读取的键 —— 写错不会报错，只会「产物取不到」或「一路查到超时」，所以不给自定义。');
  out.push('自定义变量（只给下游 `${它}` 用、引擎不读）另在一格，不进这张表。');
  out.push('');
  out.push('| 模板 | 接口槽 | 固定项 | 名字（写死） | 必填 | 引擎拿它干什么 |');
  out.push('|---|---|---|---|---|---|');
  for (const t of SEED_TEMPLATES) {
    for (const key of slotsOf(t)) {
      for (const o of requiredOutputsOf(t, key)) {
        out.push(`| \`${t.id}\` | ${REQ_LABEL[key]} | ${o.label} | \`${o.name}\` | ${o.required ? '是' : '建议'} | ${o.hint} |`);
      }
    }
  }
  out.push('');
  out.push('### 9.3 三份模板各自声明了哪些参数');
  out.push('');
  out.push('「层」只有两处声明：实例级整条实例共用、每一格各一张表。同一格里填了值的走实例，没填的由调用点现场给（业务界面或试调用）—— 谁在什么时候给由取值优先级决定，不再靠「声明在哪张表」表达。');
  for (const t of SEED_TEMPLATES) {
    out.push('');
    out.push(`#### \`${t.id}\` · ${t.name}（${t.category}）`);
    out.push('');
    out.push(HEAD);
    out.push(...paramRows(t));
  }

  out.push('');
  out.push('### 9.4 逐列 JSON（照抄可用）');
  out.push('');
  out.push('下面每块就是 `provider_template` 那一行对应列里存的内容，键名与列名一一对应；`null` = 该列没配（界面上那一格也就不出现）。');
  for (const t of SEED_TEMPLATES) {
    out.push('');
    out.push(`#### \`${t.id}\``);
    out.push('');
    out.push(`- 标量列：\`category=${t.category}\`，\`caps_json=${JSON.stringify(t.caps)}\``);
    out.push('');
    out.push('- 请求头**没有独立列**：每条接口自己的 `headers` 就写在下面那几列的 JSON 里（同一家不同端点要的头并不相同）。');
    out.push('');
    out.push('**`instance_params_json`**（实例级参数**声明**）');
    out.push('');
    out.push(json(t.instanceParams ?? []));
    for (const [slot, col, get] of SLOT_COL) {
      const v = get(t);
      out.push('');
      out.push(`**\`${col}\`**（${slot}）`);
      out.push('');
      out.push(json(v ?? null));
    }
  }
  return out.join('\n');
}

const generated = `${BEGIN}\n_（本节由 \`node --experimental-strip-types tools/gen-template-json-doc.mjs\` 从 \`src/lib/template-seed.ts\` 生成，改 seed 后重跑；\`--check\` 只校验。）_\n\n${block()}\n${END}`;

// 读入即归一成 LF：编辑器/工具可能把文档写成 CRLF，混着写会让整份文件显示成全文件重写（见 AGENTS §6.21）
const src = fs.readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n');
const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}`);
if (!re.test(src)) {
  console.error(`文档里找不到 ${BEGIN} —— 第九节还没接上生成链`);
  process.exit(2);
}
const current = re.exec(src)[0];
if (CHECK) {
  const ok = current === generated;
  console.log(ok ? '第九节与 seed 一致 ✓' : '结果：文档已与 seed 漂移，重跑 gen-template-json-doc ✗');
  process.exit(ok ? 0 : 1);
}
fs.writeFileSync(DOC, src.replace(re, generated), 'utf8');
console.log(`已写入 ${path.relative(ROOT, DOC)} 第九节（${SEED_TEMPLATES.length} 份模板）`);
