// 回归：旧 schema 项目（display 缺 fillOpacity）保存 → 重载 → loadProject 归一化 → 填充恢复
// 前置：Chrome 开 --remote-debugging-port=9222（隔离 profile），npm run dev 已启动
// 注意：改过 src 后需先重启 dev server，否则 HMR ?t= 版本模块会让页内 store 解析到旧实例
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
await page.setViewportSize({ width: 1680, height: 950 });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
await page.addInitScript(() => { try { performance.setResourceTimingBufferSize(20000); } catch { /* */ } });
const log = (tag, v) => console.log(tag, typeof v === 'string' ? v : JSON.stringify(v));

// 页内：解析 app 正在使用的 projectStore 实例（project 非空者优先，其次 t= 最新）
const IN_PAGE = async () => {
  const names = performance.getEntriesByType('resource').map((e) => e.name);
  const cands = names.filter((n) => n.includes('projectStore'));
  let best = null, bestT = -1;
  for (const url of cands) {
    try {
      const m = await import(url);
      if (!m || !m.useProjectStore) continue;
      const t = +(url.match(/[?&]t=(\d+)/) || [])[1] || 0;
      if (m.useProjectStore.getState().project) return m.useProjectStore;
      if (t >= bestT) { best = m.useProjectStore; bestT = t; }
    } catch { /* next */ }
  }
  return best;
};

await page.goto('http://localhost:5173/map-video/');
await page.waitForTimeout(2500);
await page.evaluate(async () => {
  const dbs = await indexedDB.databases();
  for (const d of dbs) indexedDB.deleteDatabase(d.name);
});
await page.reload();
await page.waitForTimeout(2500);
await page.getByPlaceholder('项目名称').fill('疆域重载2');
await page.getByText('创建', { exact: true }).first().click();
await page.waitForSelector('canvas', { timeout: 20000 });
await page.waitForTimeout(2500);
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

const probe = () => page.evaluate(() => {
  const m = window.__sharedMap.get();
  if (!m) return { err: 'no map' };
  const pt = m.project([110.9, 30.25]);
  const terr = m.getStyle().layers.filter((l) => l.id.startsWith('terr-layer-')).map((l) => l.id);
  const feats = m.queryRenderedFeatures([pt.x, pt.y], { layers: terr });
  let col = null;
  for (const f of feats) { const p = f.properties || {}; if (p.color) col = [p.color, p.op]; }
  return { col };
});
log('1 画完取色:', await probe());

// 模拟旧 schema → 保存（页内完成）
const stripRes = await page.evaluate(async () => {
  const fn = undefined; /* noop */
  const names = performance.getEntriesByType('resource').map((e) => e.name);
  const cands = names.filter((n) => n.includes('projectStore'));
  for (const url of cands) {
    try {
      const m = await import(url);
      if (!m || !m.useProjectStore) continue;
      const st = m.useProjectStore.getState();
      if (!st.project) continue;
      const p = st.project;
      const els = p.chapters[0].elements.map((e) => (e.type === 'territory' ? {
        ...e,
        display: { countryBorders: true, plotBorders: true, borderWidth: 3, countryNames: true, plotNames: false },
      } : e));
      m.useProjectStore.setState({ project: { ...p, chapters: p.chapters.map((c, i) => (i === 0 ? { ...c, elements: els } : c)) } });
      await m.useProjectStore.getState().saveProject();
      return { ok: true };
    } catch (err) { /* next */ }
  }
  return { ok: false, cands: cands.length };
});
log('2 旧schema保存:', stripRes);
if (!stripRes.ok) { log('FAIL', 'strip/save failed'); process.exit(1); }

await page.reload();
await page.waitForTimeout(2500);
const row = page.locator('div.cursor-pointer', { hasText: '疆域重载2' }).first();
await row.waitFor({ state: 'visible', timeout: 15000 });
await row.click();
await page.waitForSelector('canvas', { timeout: 20000 });
await page.waitForTimeout(2500);
await page.evaluate(() => window.__sharedMap.get().jumpTo({ center: [110.9, 30.25], zoom: 8 }));
await page.waitForTimeout(1500);

const after = await page.evaluate(async () => {
  const names = performance.getEntriesByType('resource').map((e) => e.name);
  const cands = names.filter((n) => n.includes('projectStore'));
  for (const url of cands) {
    try {
      const m = await import(url);
      if (!m || !m.useProjectStore) continue;
      const st = m.useProjectStore.getState();
      if (!st.project) continue;
      const terr = st.project.chapters[0].elements.find((x) => x.type === 'territory');
      const mm = window.__sharedMap.get();
      const pt = mm.project([110.9, 30.25]);
      const terrLayers = mm.getStyle().layers.filter((l) => l.id.startsWith('terr-layer-')).map((l) => l.id);
      const feats = mm.queryRenderedFeatures([pt.x, pt.y], { layers: terrLayers });
      let col = null;
      for (const f of feats) { const p = f.properties || {}; if (p.color) col = [p.color, p.op]; }
      return { col, display: terr ? terr.display : null };
    } catch { /* next */ }
  }
  return { err: 'no store with project', cands: cands.length };
});
log('3 重载后取色+display:', after);
page.close();
process.exit(0);
