// 回归：兼并事件特效
// 1) fade ≠ draw：fade 无描线动画（terr-dsrc 空），draw 有描线切片
// 2) spread 扩散：从占领方相邻边界向外推进（近端先变色，远端后变色，收尾全覆盖；无邻接时回退渐变）
// 前置：Chrome --remote-debugging-port=9222 + npm run dev（改过 src 需重启 dev，避免 ?t= 模块版本错位）
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
const consoleLog = [];
page.on('console', (msg) => { const t = `[${msg.type()}] ${msg.text().slice(0, 220)}`; if (/warn|error|territory/.test(t)) consoleLog.push(t); if (consoleLog.length > 40) consoleLog.shift(); });
await page.setViewportSize({ width: 1680, height: 950 });
await page.addInitScript(() => { try { performance.setResourceTimingBufferSize(20000); } catch { /* */ } });
const log = (tag, v) => console.log(tag, typeof v === 'string' ? v : JSON.stringify(v));

// 页内：解析 app 正在使用的 store 模块（project 非空优先，其次 t= 最新）
const IN_RESOLVE = `
async (storeName) => {
  const names = performance.getEntriesByType('resource').map((e) => e.name);
  const cands = names.filter((n) => n.includes('/src/stores/' + storeName));
  let best = null, bestT = -1;
  for (const url of cands) {
    try {
      const m = await import(url);
      if (!m || !m.useProjectStore) continue;
      const st = m.useProjectStore;
      const t = +(url.match(/[?&]t=(\\d+)/) || [])[1] || 0;
      if (st.getState().project) return st;
      if (t >= bestT) { best = st; bestT = t; }
    } catch { /* next */ }
  }
  return best;
}`;

const pageErr = () => errs.length ? errs : 'none';

await page.goto('http://localhost:5173/map-video/');
await page.waitForTimeout(2500);
await page.evaluate(async () => {
  const dbs = await indexedDB.databases();
  for (const d of dbs) indexedDB.deleteDatabase(d.name);
});
await page.reload();
await page.waitForTimeout(2500);
await page.getByPlaceholder('项目名称').fill('疆域扩散');
await page.getByText('创建', { exact: true }).first().click();
await page.waitForSelector('canvas', { timeout: 20000 });
await page.waitForTimeout(2500);
await page.evaluate(() => window.__sharedMap.get().jumpTo({ center: [110.9, 30.25], zoom: 8 }));
await page.waitForTimeout(800);

// 进绘制模式：画 A（左）+ B（右，共享左边界）
await page.evaluate(async () => {
  const names = performance.getEntriesByType('resource').map((e) => e.name);
  const url = names.find((n) => n.includes('/src/stores/interactionStore')) || '/map-video/src/stores/interactionStore.ts';
  const it = await import(url);
  Object.values(it).forEach((v) => { if (v && v.setState) v.setState({ mode: 'add_terr_plot' }); });
});
await page.waitForTimeout(600);
const xy = (lng, lat) => page.evaluate(([lng, lat]) => {
  const m = window.__sharedMap.get();
  const cv = document.querySelector('canvas');
  const b = cv.getBoundingClientRect();
  const p = m.project([lng, lat]);
  return [b.x + p.x, b.y + p.y];
}, [lng, lat]);
const click = async (lng, lat) => { const [x, y] = await xy(lng, lat); await page.mouse.click(x, y); await page.waitForTimeout(120); };
const dbl = async (lng, lat) => { const [x, y] = await xy(lng, lat); await page.mouse.dblclick(x, y); await page.waitForTimeout(400); };
for (const [lng, lat] of [[110.6, 30.0], [111.0, 30.0], [111.0, 30.5], [110.6, 30.5]]) await click(lng, lat);
await dbl(110.6, 30.5);
for (const [lng, lat] of [[111.0, 30.0], [111.4, 30.0], [111.4, 30.5], [111.0, 30.5]]) await click(lng, lat);
await dbl(111.0, 30.5);
await page.waitForTimeout(700);

// 注入 国家2 + spread 事件（B → 国家2，frame=30，duration=30）；并把 A（与 B 相邻）划给 国家2 作为入侵方既有领土
const inj = await page.evaluate(async ({ RESOLVE }) => {
  const resolve = eval(RESOLVE);
  const st = await resolve('projectStore');
  if (!st) return { ok: false, why: 'projectStore 未找到' };
  const s = st.getState();
  const ch = s.project.chapters[0];
  const terr = ch.elements.find((x) => x.type === 'territory');
  if (!terr) return { ok: false, why: '无疆域元素' };
  const aPlot = terr.plots[0];
  const bPlot = terr.plots[1];
  if (!aPlot || !bPlot) return { ok: false, why: '地块不足' };
  const c2 = { id: 'c2', name: '国家2', color: '#2E7DD1' };
  const ev = { id: 'ev1', frame: 30, plotIds: [bPlot.id], toCountryId: 'c2', effect: { preset: 'spread', duration: 30, highlight: false } };
  const plots = terr.plots.map((p) => (p.id === aPlot.id ? { ...p, ownerId: 'c2' } : p));
  s.updateElement(ch.id, terr.id, { countries: [...terr.countries, c2], events: [...terr.events, ev], plots });
  return { ok: true, terrId: terr.id, plotB: bPlot.id };
}, { RESOLVE: IN_RESOLVE });
log('注入:', inj);
if (!inj.ok) { log('FAIL', inj.why); process.exit(1); }

// 页内：直接调用 plotSpreadAt/plotColorAt 看返回状态 + 检查图层是否建立（遍历所有 territory 模块版本）
const spreadDiag = (terrId) => page.evaluate(async (terrId) => {
  const names = performance.getEntriesByType('resource').map((e) => e.name);
  const m = window.__sharedMap.get();
  const out = {
    hasSpreadSrc: !!m.getSource('terr-ssrc-' + terrId),
    hasFillSrc: !!m.getSource('terr-' + terrId),
    hasDrawSrc: !!m.getSource('terr-dsrc-' + terrId),
    versions: [],
  };
  for (const url of names.filter((n) => n.includes('/src/lib/territory'))) {
    try {
      const mod = await import(url);
      if (!mod?.plotSpreadAt) { out.versions.push({ url: url.slice(-60), stale: true }); continue; }
      for (const u2 of names.filter((n) => n.includes('/src/stores/projectStore'))) {
        try {
          const pm = await import(u2);
          if (!pm?.useProjectStore) continue;
          const st = pm.useProjectStore.getState();
          if (!st.project) continue;
          const terr = st.project.chapters[0].elements.find((x) => x.type === 'territory' && x.id === terrId);
          if (!terr) continue;
          const pl = terr.plots[1];
          const r = mod.plotSpreadAt(pl, terr.events, 45, terr.countries, terr.plots);
          out.versions.push({
            url: url.slice(-60),
            active: r.active, p: r.p, regionPolys: r.region ? r.region.length : null,
            colorAt45: mod.plotColorAt(pl, terr.events, 45, terr.countries, terr.plots),
          });
        } catch (e2) { out.versions.push({ url: url.slice(-60), err2: String(e2).slice(0, 120) }); }
      }
    } catch (e1) { out.versions.push({ url: url.slice(-60), err1: String(e1).slice(0, 120) }); }
  }
  return out;
}, terrId);

const probe = (lng, lat, layers) => page.evaluate(async ([lng, lat, layers]) => {
  const m = window.__sharedMap.get();
  const pt = m.project([lng, lat]);
  const feats = m.queryRenderedFeatures([pt.x, pt.y], { layers });
  return feats.map((f) => ({ color: f.properties?.color, scolor: f.properties?.scolor, pid: f.properties?.pid }));
}, [lng, lat, layers]);
const setFrame = (f) => page.evaluate(async ({ RESOLVE, f }) => {
  const resolve = eval(RESOLVE);
  const st = await resolve('projectStore');
  const names = performance.getEntriesByType('resource').map((e) => e.name);
  let es = null;
  for (const url of names.filter((n) => n.includes('/src/stores/editorStore'))) {
    try { const m2 = await import(url); if (m2.useEditorStore) { es = m2.useEditorStore; break; } } catch { /* */ }
  }
  es?.getState().setCurrentFrame(f);
}, { RESOLVE: IN_RESOLVE, f });
// 切帧后相机跟随章节关键帧（默认 z4 全景）→ 探针不受影响，截图前拉回 z8
const refocus = () => page.evaluate(() => window.__sharedMap.get().jumpTo({ center: [111.0, 30.25], zoom: 8 }));
const drawCount = (terrId) => page.evaluate(async (terrId) => {
  const m = window.__sharedMap.get();
  const src = m.getSource('terr-dsrc-' + terrId);
  if (!src) return -1;
  const d = await src.getData();
  return d.features.length;
}, terrId);

// —— spread：frame 45（p=0.5）近端已变新色、远端仍是旧色（填充切分，无叠色） ——
const fillId = `terr-layer-${inj.terrId}`;
await setFrame(45);
await page.waitForTimeout(600);
const near = await probe(111.05, 30.25, [fillId]);
const far = await probe(111.32, 30.25, [fillId]);
log('p=0.5 近端(应国家2):', near);
log('p=0.5 远端(应国家1):', far);
log('扩散推进判定:', near[0]?.color === '#2E7DD1' && far[0]?.color === '#E23B3B' ? 'OK' : 'FAIL');
log('spreadDiag:', await spreadDiag(inj.terrId));
await refocus();
await page.waitForTimeout(900);
await page.screenshot({ path: 'docs/studio-shots/v17-spread-mid.png' });

// —— 收尾：frame 62 全覆盖 + 基底换色 ——
await setFrame(62);
await page.waitForTimeout(600);
const farDone = await probe(111.32, 30.25, [fillId]);
log('p=1 远端基底色(应国家2):', farDone);
log('收尾判定:', farDone[0]?.color === '#2E7DD1' ? 'OK' : 'FAIL');
await refocus();
await page.waitForTimeout(900);
await page.screenshot({ path: 'docs/studio-shots/v17-spread-done.png' });

// —— fade ≠ draw ——
const setPreset = (preset) => page.evaluate(async ({ RESOLVE, terrId, preset }) => {
  const resolve = eval(RESOLVE);
  const st = await resolve('projectStore');
  const s = st.getState();
  const ch = s.project.chapters[0];
  const terr = ch.elements.find((x) => x.id === terrId);
  s.updateElement(ch.id, terrId, {
    events: terr.events.map((e) => ({ ...e, effect: { ...e.effect, preset } })),
  });
}, { RESOLVE: IN_RESOLVE, terrId: inj.terrId, preset });
await setFrame(40);
await setPreset('fade');
await page.waitForTimeout(700);
const fadeDraw = await drawCount(inj.terrId);
await setPreset('draw');
await page.waitForTimeout(700);
const drawDraw = await drawCount(inj.terrId);
log(`fade 时描线切片数(应0): ${fadeDraw} | draw 时(应≥1): ${drawDraw}`);
log('fade≠draw 判定:', fadeDraw === 0 && drawDraw >= 1 ? 'OK' : 'FAIL');
log('console 尾部:', consoleLog.slice(-12));

log('PageErrors:', pageErr());
page.close();
process.exit(0);
