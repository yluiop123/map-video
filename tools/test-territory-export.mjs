// 回归：疆域+兼并事件 → 导出 MP4 → 逐帧出图+取色（验证导出端相机/填充/事件变色）
// 前置：Chrome 开 --remote-debugging-port=9222（隔离 profile），npm run dev 已启动
// 产物：docs/studio-shots/v12-frame-*.png；终端输出各时间点中心/偏移点颜色
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'docs/studio-shots';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('localhost:5173')) || (await ctx.newPage());
await page.bringToFront();
await page.setViewportSize({ width: 1680, height: 950 });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

await page.evaluate(async () => {
  const dbs = await indexedDB.databases();
  for (const d of dbs) indexedDB.deleteDatabase(d.name);
});
await page.reload();
await page.waitForTimeout(3000);
await page.getByPlaceholder('项目名称').fill('疆域导出3');
await page.getByText('创建', { exact: true }).first().click();
await page.waitForTimeout(2000);
await page.waitForSelector('canvas', { timeout: 20000 });
await page.waitForTimeout(3000);

await page.evaluate(async () => {
  const mod = await import('/map-video/src/stores/projectStore.ts');
  const st = mod.useProjectStore.getState();
  const proj = st.project;
  const ch = proj.chapters[0];
  const chapters = proj.chapters.map((c, i) => (i === 0
    ? { ...c, startFrame: 0, endFrame: 90, camera: [{ ...c.camera[0], frame: 0, center: [110.9, 30.25], zoom: 8, pitch: 0, bearing: 0 }] }
    : c));
  mod.useProjectStore.setState({ project: { ...proj, chapters } });
});
await page.evaluate(() => window.__sharedMap.get().jumpTo({ center: [110.9, 30.25], zoom: 8 }));
await page.waitForTimeout(800);

await page.evaluate(async () => {
  const it = await import('/map-video/src/stores/interactionStore.ts');
  it.useInteractionStore.setState({ mode: 'add_terr_plot' });
});
await page.waitForTimeout(600);
const xy = (lng, lat) => page.evaluate(([lng, lat]) => {
  const m = window.__sharedMap.get();
  const cv = document.querySelector('canvas');
  const b = cv.getBoundingClientRect();
  const p = m.project([lng, lat]);
  return [b.x + p.x, b.y + p.y];
}, [lng, lat]);
const click = async (lng, lat) => { const [x, y] = await xy(lng, lat); await page.mouse.click(x, y); await page.waitForTimeout(150); };
for (const [lng, lat] of [[110.6, 30.0], [111.2, 30.0], [111.2, 30.5], [110.6, 30.5]]) await click(lng, lat);
{ const [x, y] = await xy(110.6, 30.5); await page.mouse.dblclick(x, y); }
await page.waitForTimeout(700);

await page.evaluate(async () => {
  const mod = await import('/map-video/src/stores/projectStore.ts');
  const st = mod.useProjectStore.getState();
  const proj = st.project;
  const ch = proj.chapters[0];
  const els = ch.elements.map((e) => (e.type === 'territory' ? {
    ...e,
    countries: [...e.countries, { id: 'c2', name: '国家2', color: '#3B82F6' }],
    events: [{ id: 'ev1', frame: 45, plotIds: [e.plots[0].id], toCountryId: 'c2', effect: { preset: 'draw', duration: 30, highlight: true } }],
  } : e));
  const chapters = proj.chapters.map((c, i) => (i === 0 ? { ...c, elements: els } : c));
  mod.useProjectStore.setState({ project: { ...proj, chapters } });
});
await page.waitForTimeout(500);

await page.evaluate(() => {
  const orig = URL.createObjectURL.bind(URL);
  window.__blob = null;
  URL.createObjectURL = (b) => {
    const u = orig(b);
    if (b && typeof b.type === 'string' && b.type.includes('video')) window.__blob = b;
    return u;
  };
});
console.log('开始导出…');
const consoleLog = [];
page.on('console', (msg) => { consoleLog.push(`[${msg.type()}] ${msg.text().slice(0, 200)}`); if (consoleLog.length > 60) consoleLog.shift(); });
const t0 = Date.now();
await page.getByText('导出视频', { exact: true }).first().click();
let ok = false;
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(1000);
  if (await page.evaluate(() => !!window.__blob)) { ok = true; break; }
  if (i % 5 === 4) console.log(`  …${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
if (!ok) {
  console.log('FAIL: 未拿到导出 blob');
  console.log('--- console 尾部 ---');
  for (const l of consoleLog.slice(-30)) console.log(l);
  await page.screenshot({ path: 'docs/studio-shots/v15-export-fail.png' });
  await browser.close();
  process.exit(1);
}
console.log(`导出完成 ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// 逐帧出图 + 取色（中心 + 中心左上偏移以避开中心标签）
const frames = await page.evaluate(async () => {
  const v = document.createElement('video');
  v.src = URL.createObjectURL(window.__blob);
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  document.body.appendChild(v);
  const wt = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  await wt(new Promise((r) => { v.onloadeddata = r; v.onerror = () => r(); }), 15000);
  await wt(v.play().catch(() => {}), 5000).catch(() => {});
  v.pause();
  const W = v.videoWidth || 1920, H = v.videoHeight || 1080;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const small = document.createElement('canvas');
  small.width = 640; small.height = Math.round(H / W * 640);
  const gs = small.getContext('2d');
  const grab = async (t) => {
    await wt(new Promise((r) => { v.onseeked = r; v.currentTime = t; }), 10000).catch(() => {});
    g.drawImage(v, 0, 0);
    gs.drawImage(c, 0, 0, small.width, small.height);
    const px = (fx, fy) => { const d = g.getImageData(Math.round(W * fx), Math.round(H * fy), 3, 3).data; return [d[0], d[1], d[2]]; };
    return {
      t,
      center: px(0.5, 0.5),
      offCenter: px(0.42, 0.42),
      png: small.toDataURL('image/png'),
    };
  };
  const out = [];
  for (const t of [0.5, 1.8, 2.8]) out.push(await grab(t));
  v.remove();
  return out;
});
for (const f of frames) {
  console.log(`t=${f.t}s 中心:`, JSON.stringify(f.center), ' 偏移点:', JSON.stringify(f.offCenter));
  const b64 = f.png.split(',')[1];
  fs.writeFileSync(path.join(OUT, `v12-frame-${f.t}.png`), Buffer.from(b64, 'base64'));
}
console.log('帧图已存 v12-frame-*.png');
await browser.close();
process.exit(0);
