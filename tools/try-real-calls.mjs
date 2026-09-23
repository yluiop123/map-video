/**
 * try-real-calls.mjs — 用真实上游验证 seed 模板与引擎（**会花配额，只在明确要求时跑**）
 *
 *   node --experimental-strip-types tools/try-real-calls.mjs [llm|image|image-async|tts|clone|all]
 *
 * Key 从项目根目录 key.txt 读（`deepseek:` / `qwen:` 两段），**不打印、不入库**；产物写 tools/.tmp-real/。
 * 走的是渲染端同一份代码：template-seed 的模板 + request-engine 的求值与取回管线，
 * 传输用 node 的 fetch（等价于桌面端主进程的 net:request）。
 * `clone` 要单独点名才跑 —— 它会在账号下留下音色资源。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED_TEMPLATES, seedTemplate } from '../src/lib/template-seed.ts';
import { runSync, submitAsync, queryOnce, runClone, validateTemplate, buildRequest } from '../src/lib/request-engine.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '.tmp-real');
const which = process.argv[2] ?? 'all';

/** key.txt：`名字 :` 单独一行是标签（冒号必须有，否则一整串 Key 也会被当成标签），紧跟其后的非空行是 Key */
function readKeys(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  const isLabel = (s) => /^([A-Za-z0-9_.-]+)\s*:\s*$/.exec(s);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i += 1) {
    const label = isLabel(lines[i]);
    const val = lines[i + 1];
    if (label && val && !isLabel(val)) out[label[1].toLowerCase()] = val;
  }
  return out;
}

const KEYS = readKeys(path.join(HERE, '..', 'key.txt'));

/** 一条实例：baseUrl 用模板声明的默认值，Key 按标签取；requests 那层填这次要试的模型 */
function instOf(tplId, keyName, requests = {}, sync = true) {
  const tpl = seedTemplate(tplId);
  const baseUrl = (tpl.instanceParams ?? []).find((x) => x.key === 'baseUrl')?.defaultValue ?? '';
  const apiKey = KEYS[keyName] ?? process.env[`${keyName.toUpperCase()}_API_KEY`];
  if (!apiKey) throw new Error(`没有 ${keyName} 的 Key（key.txt 里 ${keyName}: 那一段）`);
  return { id: `try-${tplId}`, tplId, name: '', sync, values: { instance: { baseUrl, apiKey, timeoutMs: 120000 }, requests } };
}

/** multipart 表单：文件值要包成 Blob */
function formOf(form) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) {
    if (v == null) continue;
    if (typeof v === 'string') fd.append(k, v);
    else fd.append(k, new Blob([v]), k);
  }
  return fd;
}

const deps = {
  send: async (r) => {
    const body = r.method === 'GET' ? undefined
      : r.form != null ? formOf(r.form)
      : r.body != null ? JSON.stringify(r.body) : undefined;
    const res = await fetch(r.url, { method: r.method, headers: r.headers, body, signal: AbortSignal.timeout(r.timeoutMs ?? 120000) });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) return { status: res.status, contentType: ct, json: await res.json().catch(() => undefined) };
    if (ct.startsWith('text/') || ct.includes('xml')) return { status: res.status, contentType: ct, text: await res.text() };
    return { status: res.status, contentType: ct, bytes: new Uint8Array(await res.arrayBuffer()) };
  },
  fetchBytes: async (url, headers) => {
    const res = await fetch(url, { headers: headers && Object.keys(headers).length ? headers : undefined });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type') || undefined };
  },
};

const save = (name, bytes) => {
  fs.mkdirSync(OUT, { recursive: true });
  const p = path.join(OUT, name);
  fs.writeFileSync(p, Buffer.from(bytes));
  return `${(fs.statSync(p).size / 1024).toFixed(0)}KB → ${path.basename(p)}`;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const step = async (name, fn) => {
  const started = Date.now();
  try {
    const msg = await fn();
    console.log(`  ok   ${name} (${((Date.now() - started) / 1000).toFixed(1)}s) ${msg ?? ''}`);
  } catch (e) {
    failed += 1;
    console.log(` FAIL  ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

// ---------- 0. 模板自检（不发网络，先确认 seed 本身没写错） ----------
console.log('\n[0] seed 模板自检');
for (const t of SEED_TEMPLATES) {
  const problems = validateTemplate(t);
  if (problems.length) { failed += 1; console.log(` FAIL  ${t.id}: ${problems.join(' / ')}`); }
  else console.log(`  ok   ${t.id}（${t.category}）形状自洽`);
}

if (which === 'all' || which === 'llm') {
  await step('文案生成（DeepSeek 对话）', async () => {
    const tpl = seedTemplate('deepseek-chat');
    const inst = instOf('deepseek-chat', 'deepseek', { 'sync.submit': { model: 'deepseek-flash' } });
    const r = await runSync(tpl, inst, deps, 'sync.submit', {
      systemPrompt: '你是地图视频的旁白撰稿人，回答要简短。',
      userPrompt: '用一句话说明「斯大林格勒战役」为何被视为二战转折点。',
    });
    if (typeof r.values.content !== 'string' || !r.values.content) throw new Error(`没取到文本：${JSON.stringify(r.values)}`);
    return `「${r.values.content.slice(0, 40)}…」`;
  });
}

if (which === 'all' || which === 'image') {
  await step('图片生成·同步（回图片链接 → 当场下载）', async () => {
    const tpl = seedTemplate('qwen-image');
    const inst = instOf('qwen-image', 'qwen', { 'sync.submit': { size: '1024*1024', watermark: false } });
    const r = await runSync(tpl, inst, deps, 'sync.submit', { prompt: '一只戴宇航员头盔的橘猫，赛博朋克风格，8k' });
    if (!r.bytes?.length) throw new Error(`没拿到图片：${JSON.stringify(r.values)}`);
    return save('image-sync.png', r.bytes);
  });
}

if (which === 'all' || which === 'image-async') {
  await step('图片生成·异步（提交 → 查询 → 下载）', async () => {
    const tpl = seedTemplate('qwen-image');
    const inst = instOf('qwen-image', 'qwen', { 'async.submit': { size: '1024*1024', n: 1 } }, false);
    const first = await submitAsync(tpl, inst, deps, { prompt: '中国水墨风格的连绵群山，大面积留白' });
    if (!first.taskId) throw new Error(`提交没拿到 taskId：${JSON.stringify(first.values)}`);
    // 排队实测要 9 分钟，所以按实例声明的查询节奏来（与界面同口径）
    const iv = Number(inst.values.instance.queryIntervalMs) || 5000;
    const max = Number(inst.values.instance.queryMaxAttempts) || 360;
    let up = first.values;
    for (let i = 0; i < max; i += 1) {
      await sleep(iv);
      let one;
      try {
        one = await queryOnce(tpl, inst, deps, up);
      } catch (e) {
        // 取不回产物时把上游原始响应打一份：产物路径写错是这类模板最常见的病
        const { req } = buildRequest(tpl, inst, 'async.query', {}, up);
        const raw = await deps.send(req);
        throw new Error(`${e instanceof Error ? e.message : String(e)}\n        上游原始响应：${JSON.stringify(raw.json ?? raw.text ?? raw.status).slice(0, 900)}`);
      }
      up = one.values;
      if (one.outcome === 'pending') continue;
      if (one.outcome === 'failed') throw new Error(`任务失败：${JSON.stringify(one.values)}`);
      if (!one.bytes?.length) throw new Error(`成功但没取到字节：${JSON.stringify(one.values)}`);
      return `第 ${i + 1} 次查询完成 · ${save('image-async.png', one.bytes)}`;
    }
    throw new Error(`查了 ${max} 次还没完成：${JSON.stringify(up)}`);
  });
}

if (which === 'all' || which === 'tts') {
  await step('语音合成（系统音色，回时效链接 → 当场下载）', async () => {
    const tpl = seedTemplate('qwen-tts');
    const inst = instOf('qwen-tts', 'qwen');
    const r = await runSync(tpl, inst, deps, 'sync.submit', { text: '这是一次真实调用回归，用来确认模板形状。', voice: 'Ethan' });
    if (!r.bytes?.length) throw new Error(`没拿到音频：${JSON.stringify(r.values)}`);
    return save('tts-qwen.wav', r.bytes);
  });
}

if (which === 'clone') {
  await step('声音复刻（参考音频 → voiceId）', async () => {
    const tpl = seedTemplate('qwen-tts');
    const inst = instOf('qwen-tts', 'qwen', { clone: { preferredName: 'mapvideo-reg' } });
    const sample = path.join(HERE, '..', 'public', 'voices', 'male.mp3');
    const b64 = fs.readFileSync(sample).toString('base64');
    const r = await runClone(tpl, inst, deps, { audioDataUri: `data:audio/mp3;base64,${b64}` });
    if (typeof r.values.voiceId !== 'string' || !r.values.voiceId) throw new Error(`没取到 voiceId：${JSON.stringify(r.values)}`);
    return `${r.values.voiceId}（合成时 model 必须是复刻那一步的目标模型）`;
  });
}

console.log(failed ? `\n===== ${failed} 项失败 =====` : '\n===== 全部通过 =====');
process.exit(failed ? 1 : 0);
