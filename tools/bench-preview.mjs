/**
 * bench-preview.mjs — 编辑端预览播放的性能基线（批次 7 的第 0 步）
 *
 * 只读不改应用代码：靠 `window.__editorStore` 直控播放头，靠 CDP Profiler 拿函数自耗时，
 * 靠 rAF 间隔 / longtask / MutationObserver 拿「每帧到底做了多少活」的标量。
 * 后面每一条改动都要拿这份数字对比，不许凭手感说「变快了」。
 *
 * 用法：
 *   node tools/bench-preview.mjs                      # 默认 1× 跑 6 秒
 *   node tools/bench-preview.mjs --rate 3 --secs 4    # 3 倍速
 *   node tools/bench-preview.mjs --label after-app    # 存 tools/.bench/after-app.json
 *   node tools/bench-preview.mjs --against tools/.bench/baseline.json   # 打印与基线的差
 * 前置：桌面端（或网页版）带 CDP 起来，且**已打开某个项目的编辑器**：
 *   MV_CDP=9223 npm run electron:dev
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : (i > 0 ? true : dflt);
};
const RATE = Number(arg('rate', 1));
const SECS = Number(arg('secs', 6));
const LABEL = String(arg('label', `rate${RATE}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`));
const OUT_DIR = path.join(process.cwd(), 'tools', '.bench');
const cdp = process.env.MV_CDP || 'http://127.0.0.1:9223';

const browser = await chromium.connectOverCDP(cdp);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('localhost:5173'));
if (!page) { console.error(`没找到 5173 页面（CDP: ${cdp}）`); process.exit(2); }
await page.bringToFront();

const ready = await page.evaluate(() => {
  const s = window.__editorStore;
  if (!s) return { ok: false, why: 'window.__editorStore 不在（页面没加载完？）' };
  const st = s.getState();
  // 项目列表页也有这个 store，但那里没有编辑器：没有画布与播放条就等于没东西可测
  const hasEditor = !!document.querySelector('canvas') && !!document.querySelector('button[title="字幕 / 配音 / 字幕样式"]');
  return { ok: hasEditor, frame: st.currentFrame, playing: st.isPlaying, why: hasEditor ? '' : '当前不在编辑器页（项目列表？）—— 先打开一个项目再跑' };
});
if (!ready.ok) { console.error('前置不满足：', ready.why); process.exit(2); }

const client = await ctx.newCDPSession(page);
// 窗口被遮挡/最小化时 Chrome 会把 rAF 节流到 ~1Hz，测出来的数字全是假的。
// 页面级 session 拿不到窗口 API，所以走 browser 级 session + /json/list 的 targetId 把它拉回前台。
let windowState = '未知';
try {
  const targets = await (await fetch(`${cdp.replace(/\/$/, '')}/json/list`)).json();
  const t = targets.find((x) => x.url?.includes('localhost:5173'));
  const browserClient = await browser.newBrowserCDPSession();
  const { windowId } = await browserClient.send('Browser.getWindowForTarget', { targetId: t?.id });
  const b = await browserClient.send('Browser.getWindowBounds', { windowId });
  windowState = b.bounds.windowState;
  if (windowState !== 'normal' && windowState !== 'maximized') {
    await browserClient.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    windowState = `${windowState}→normal`;
  }
} catch (e) { windowState = `拿不到窗口（${e instanceof Error ? e.message.slice(0, 40) : e}）`; }
await client.send('Page.enable');
await client.send('Emulation.setFocusEmulationEnabled', { enabled: true });
try { await client.send('Page.setWebLifecycleState', { state: 'active' }); } catch { /* 老版本没有 */ }
await page.bringToFront();
await page.waitForTimeout(600);   // 等窗口真正确定下来再开始采样

// 页内探针：帧间隔 / DOM 变更条数 / 长任务数
await page.evaluate(({ ms }) => {
  const b = (window.__bench = { frames: [], mutations: 0, longtasks: 0, stop: false });
  let last = performance.now();
  const tick = (t) => { b.frames.push(t - last); last = t; if (!b.stop) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  new MutationObserver((recs) => { b.mutations += recs.length; })
    .observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  try { new PerformanceObserver((l) => { b.longtasks += l.getEntries().length; }).observe({ entryTypes: ['longtask'] }); }
  catch { /* 老浏览器没有 longtask */ }
  b.timer = setTimeout(() => { b.stop = true; }, ms + 2000);
}, { ms: SECS * 1000 });

await client.send('Profiler.enable');
await client.send('Profiler.setSamplingInterval', { interval: 200 });   // µs
await client.send('Profiler.start');

// 起播：回到 0 帧，按指定倍速
await page.evaluate((rate) => {
  const s = window.__editorStore.getState();
  s.setPlayRate?.(rate);
  s.setCurrentFrame(0);
  s.setIsPlaying(true);
}, RATE);
await page.waitForTimeout(SECS * 1000);
const endFrame = await page.evaluate(() => {
  window.__editorStore.getState().setIsPlaying(false);
  return window.__editorStore.getState().currentFrame;
});

const { profile } = await client.send('Profiler.stop');
await client.send('Profiler.disable');

// 自耗时按「函数 @ 文件:行」聚合
const byFn = new Map();
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const total = profile.samples.length;
for (const id of profile.samples) {
  const n = nodes.get(id);
  const cf = n?.callFrame;
  if (!cf) continue;
  const url = (cf.url || '').replace(/^https?:\/\/[^/]+/, '').split('/').slice(-1).join('/');
  const key = `${cf.functionName || '(anonymous)'} @ ${url}:${cf.lineNumber}`;
  byFn.set(key, (byFn.get(key) || 0) + 1);
}
const selfMs = (c) => (total ? (c / total) * (SECS * 1000) : 0);
const top = [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)
  .map(([fn, c]) => ({ fn, ms: Math.round(selfMs(c)) }));
// idle 占比是判别依据：接近 100% = 根本没在干活（被节流），接近 0 = 主线程真的忙不过来
const idleMs = top.find((t) => t.fn.startsWith('(idle)'))?.ms ?? 0;
const idleShare = +(idleMs / (SECS * 1000) * 100).toFixed(1);

const probe = await page.evaluate(() => {
  const b = window.__bench; clearTimeout(b.timer);
  const f = b.frames.slice(1).sort((x, y) => x - y);
  const pct = (p) => (f.length ? +f[Math.floor((f.length - 1) * p)].toFixed(1) : 0);
  return {
    rafCount: b.frames.length, medianMs: pct(0.5), p95Ms: pct(0.95), maxMs: f[f.length - 1] ?? 0,
    janky: f.filter((x) => x > 25).length,          // 掉出 40fps 以下的帧
    mutations: b.mutations, longtasks: b.longtasks,
  };
});
await page.evaluate(() => { delete window.__bench; });

const result = {
  at: new Date().toISOString(), rate: RATE, secs: SECS, endFrame: Math.round(endFrame), windowState,
  fps: +(probe.rafCount / SECS).toFixed(1), ...probe,
  mutationsPerSec: +(probe.mutations / SECS).toFixed(1),
  idleShare, topSelf: top,
};
// 两道护栏：rAF 不到 60Hz = 被后台节流；播放头没推进 = 根本没在播（不在编辑器页 / 被打断）。
// 这两种数字存进基线都会害了后面的对比，所以直接判无效、不落盘。
result.valid = result.fps >= 30 && result.endFrame >= 10;

fs.mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, `${LABEL}.json`);

const K = ['fps', 'medianMs', 'p95Ms', 'maxMs', 'janky', 'mutationsPerSec', 'longtasks', 'endFrame', 'idleShare'];
console.log(`\n== 预览基线 ${LABEL}（${SECS}s @ ${RATE}×，播到第 ${result.endFrame} 帧，窗口状态 ${result.windowState}）`);
for (const k of K) console.log(`  ${k.padEnd(16)} ${result[k]}`);
// 先给自耗时排行再判有效与否：数字无效时，这张表正是判断「被节流」还是「真忙」的依据
console.log(`  函数自耗时 top（采样 ${total} 个，按 ${SECS}s 折算）:`);
for (const t of top.slice(0, 12)) console.log(`    ${String(t.ms).padStart(5)}ms  ${t.fn}`);
if (!result.valid) {
  if (result.fps < 30) {
    console.log(`\n!! rAF 只有 ${result.fps} fps —— 页面被后台节流了。用 MV_BENCH=1 重启桌面端（关掉 Chromium 后台节流），或把窗口切到前台。`);
  }
  if (result.endFrame < 10) {
    console.log(`\n!! 6 秒里播放头只走到第 ${result.endFrame} 帧 —— 根本没在播（不在编辑器页？播放被打断？）。这份数字无效。`);
  }
  console.log('   不写文件，避免脏数据进基线。');
  await browser.close();
  process.exit(3);
}
fs.writeFileSync(file, JSON.stringify(result, null, 1));
console.log(`  存 → ${path.relative(process.cwd(), file)}`);

const against = arg('against');
if (against && fs.existsSync(against)) {
  const base = JSON.parse(fs.readFileSync(against, 'utf8'));
  console.log(`\n== 对比 ${path.basename(against)}`);
  for (const k of K) {
    const b = base[k], n = result[k];
    if (typeof b !== 'number' || typeof n !== 'number') continue;
    const d = n - b;
    const pct = b ? `${((d / b) * 100).toFixed(1)}%` : '—';
    const good = k === 'fps' ? d > 0 : d < 0;
    console.log(`  ${k.padEnd(16)} ${b} → ${n}  ${d >= 0 ? '+' : ''}${d.toFixed(1)} (${pct}) ${Math.abs(d) < 1e-9 ? '' : good ? '↓好' : '↑差'}`);
  }
}
await browser.close();
