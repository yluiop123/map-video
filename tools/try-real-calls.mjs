/**
 * try-real-calls.mjs — 用真实上游验证 seed 与引擎（会花配额，只在明确要求时跑）
 *
 *   node --experimental-strip-types tools/try-real-calls.mjs [tts|image|image-async|all]
 *
 * Key 从 D:/createVideo/api_key.txt 读（不打印、不入库）；产物写到 tools/.tmp-real/。
 * 走的是渲染端同一份代码：template-seed 的模板行 + request-engine 的求值与五步取回管线，
 * 传输用 node 的 fetch（等价于桌面端主进程 net:request）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { SEED_GROUPS } from '../src/lib/template-seed.ts';
import { callRole } from '../src/lib/request-engine.ts';

const KEY_FILE = 'D:/createVideo/api_key.txt';
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\//, ''), '.tmp-real');
const which = process.argv[2] ?? 'all';

const key = fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim() : process.env.DASHSCOPE_API_KEY?.trim();
if (!key) { console.error('没有可用 Key（D:/createVideo/api_key.txt 或 DASHSCOPE_API_KEY）'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const groupOf = (id) => SEED_GROUPS.find((g) => g.tplGroup === id);
const deps = {
  send: async (req) => {
    const url = new URL(req.url);
    for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, String(v));
    const res = await fetch(url.href, { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : JSON.stringify(req.body ?? {}) });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) return { status: res.status, contentType: ct, json: await res.json().catch(() => undefined) };
    if (ct.startsWith('text/')) return { status: res.status, contentType: ct, text: await res.text() };
    return { status: res.status, contentType: ct, bytes: new Uint8Array(await res.arrayBuffer()) };
  },
  fetchBytes: async (u, headers) => {
    const res = await fetch(u, { headers: headers && Object.keys(headers).length ? headers : undefined });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type') || undefined };
  },
};

const ctx = (g, over = {}) => ({
  baseUrl: g.baseUrl, apiKey: key, model: g.defaultModel, voice: g.defaultVoice, speed: 1, mode: 'sync', params: {}, ...over,
});

const save = (name, bytes) => {
  const p = path.join(OUT, name);
  fs.writeFileSync(p, Buffer.from(bytes));
  return `${(fs.statSync(p).size / 1024).toFixed(0)}KB → ${path.basename(p)}`;
};

let failed = 0;
const step = async (name, fn) => {
  const started = Date.now();
  try {
    const msg = await fn();
    console.log(`  ok   ${name} (${((Date.now() - started) / 1000).toFixed(1)}s) ${msg}`);
  } catch (e) {
    failed += 1;
    console.log(` FAIL  ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

if (which === 'all' || which === 'tts') {
  const g = groupOf('dashscope-cosyvoice');
  await step('语音合成（CosyVoice 系统音色 longanyang）', async () => {
    const r = await callRole(g, ctx(g, { params: { format: 'mp3', sampleRate: 24000 } }), 'synthesize', { text: '这是一次真实调用回归，用来确认模板形状。' }, deps);
    if (!r.bytes?.length) throw new Error(`没拿到音频：${JSON.stringify(r.values)}`);
    return save('tts-cosyvoice.mp3', r.bytes);
  });
  const q = groupOf('dashscope-qwen-tts');
  await step('语音合成（Qwen-TTS，产物是带时效链接 → 当场下载）', async () => {
    const r = await callRole(q, ctx(q), 'synthesize', { text: '这是一次真实调用回归。' }, deps);
    if (!r.bytes?.length) throw new Error(`没拿到音频：${JSON.stringify(r.values)}`);
    return save('tts-qwen.wav', r.bytes);
  });
}

if (which === 'all' || which === 'image') {
  const g = groupOf('dashscope-image');
  await step('图片生成·同步（z-image-turbo）', async () => {
    const r = await callRole(g, ctx(g, { params: { size: '1024*1024', promptExtend: false, watermark: false } }), 'generate', { prompt: '一只戴宇航员头盔的橘猫，赛博朋克风格，8k' }, deps);
    if (!r.bytes?.length) throw new Error(`没拿到图片：${JSON.stringify(r.values)}`);
    return save('image-sync.png', r.bytes);
  });
}

if (which === 'all' || which === 'image-async') {
  const g = groupOf('dashscope-image');
  // 异步变体只认万相模型（z-image-turbo 走它会回一句误导性的 "url error"），实测用 wan2.6-t2i
  await step('图片生成·异步（提交 + 轮询 + 下载）', async () => {
    const r = await callRole(g, { ...ctx(g, { model: 'wan2.6-t2i', params: { size: '1024*1024', count: 1, promptExtend: false, watermark: false } }), mode: 'async' }, 'generate', { prompt: '中国水墨风格的连绵群山，留白' }, deps);
    if (!r.bytes?.length) throw new Error(`没拿到图片：${JSON.stringify(r.values)} / steps=${JSON.stringify(r.steps.map((s) => s.values))}`);
    return save('image-async.png', r.bytes);
  });
}

console.log(failed ? `\n===== ${failed} 项失败 =====` : '\n===== 全部通过 =====');
process.exit(failed ? 1 : 0);
