// 回归：兼并事件「蚕食」特效（扩散机制 + 湍流置换前沿）
// 场景：地块A(左,国家1) f=10 瞬时归国家2 → 地块B(右,国家1) f=30 蚕食归国家2（前线=B左缘）
// 验证：1) f=29 B整块旧色  2) f=38 前线刚咬入、远端仍旧色  3) f=42 近端新色+远端旧色
//      4) f=50 全部吞并  5) 任意探点至多1个填充feature（互斥两块，无颜色叠加态）  6) 分帧截图目检湍流前沿
// 前置：Chrome --remote-debugging-port=9222 + npm run dev（改过 src 需重启 dev，避免 ?t= 模块版本错位）
import { chromium } from 'playwright-core';
import { getWorkPage } from './pw-page.mjs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await getWorkPage(ctx);
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
const consoleLog = [];
page.on('console', (msg) => { const t = `[${msg.type()}] ${msg.text().slice(0, 200)}`; if (/warn|error|territory/.test(t)) consoleLog.push(t); if (consoleLog.length > 40) consoleLog.shift(); });
await page.setViewportSize({ width: 1680, height: 950 });
const log = (tag, v) => console.log(tag, typeof v === 'string' ? v : JSON.stringify(v));

await page.goto('http://localhost:5173/map-video/');
await page.waitForTimeout(2500);
await page.evaluate(async () => {
  const dbs = await indexedDB.databases();
  for (const d of dbs) indexedDB.deleteDatabase(d.name);
});
await page.reload();
await page.waitForTimeout(2500);
await page.getByPlaceholder('项目名称').fill('疆域收缩');
await page.getByText('创建', { exact: true }).first().click();
await page.waitForSelector('canvas', { timeout: 20000 });
await page.waitForTimeout(2500);
await page.evaluate(() => window.__sharedMap.get().jumpTo({ center: [111.0, 30.25], zoom: 8 }));
await page.waitForTimeout(800);

// 直接注入疆域元素：A(110.6-111.0) B(111.0-111.4) 严格共享边界 x=111.0
// ev0: f=10 A 瞬时归国家2（建立前线）；ev1: f=30 B 蚕食归国家2（duration=30）
const inj = await page.evaluate(async () => {
  const names = performance.getEntriesByType('resource').map((e) => e.name);
  let st = null;
  for (const url of names.filter((n) => n.includes('/src/stores/projectStore'))) {
    try { const m = await import(url); if (m?.useProjectStore?.getState().project) { st = m.useProjectStore; break; } } catch { /* next */ }
  }
  if (!st) return { ok: false, why: 'projectStore 未找到' };
  const s = st.getState();
  const ch = s.project.chapters[0];
  const terr = {
    id: 'terr_t', type: 'territory', name: '疆域', visible: true, locked: false,
    startFrame: ch.startFrame, endFrame: ch.endFrame, style: {},
    countries: [{ id: 'c1', name: '国家1', color: '#E23B3B' }, { id: 'c2', name: '国家2', color: '#2E7DD1' }],
    plots: [
      { id: 'pa', name: 'A', ownerId: 'c1', rings: [[[110.6, 30.0], [111.0, 30.0], [111.0, 30.5], [110.6, 30.5], [110.6, 30.0]]] },
      { id: 'pb', name: 'B', ownerId: 'c1', rings: [[[111.0, 30.0], [111.4, 30.0], [111.4, 30.5], [111.0, 30.5], [111.0, 30.0]]] },
    ],
    events: [
      { id: 'ev0', frame: 10, plotIds: ['pa'], toCountryId: 'c2', effect: { preset: 'instant', highlight: false } },
      { id: 'ev1', frame: 30, plotIds: ['pb'], toCountryId: 'c2', effect: { preset: 'shrink', duration: 30, highlight: false } },
    ],
    display: { countryBorders: true, plotBorders: true, borderWidth: 3, fillOpacity: 0.45, countryNames: false, plotNames: false, labelAlign: 'map', labelScale: 1 },
  };
  s.addElement(ch.id, terr);
  return { ok: true, terrId: terr.id, paId: 'pa', pbId: 'pb' };
});
log('注入:', inj);
if (!inj.ok) { log('FAIL', inj.why); process.exit(1); }

const probe = (lng, lat) => page.evaluate(async ([lng, lat, terrId]) => {
  const m = window.__sharedMap.get();
  const pt = m.project([lng, lat]);
  const feats = m.queryRenderedFeatures([pt.x, pt.y], { layers: ['terr-layer-' + terrId] });
  return feats.map((f) => f.properties?.color);
}, [lng, lat, inj.terrId]);
const probeBorder = (lng, lat) => page.evaluate(async ([lng, lat, terrId]) => {
  const m = window.__sharedMap.get();
  const pt = m.project([lng, lat]);
  const feats = m.queryRenderedFeatures([pt.x, pt.y], { layers: ['terr-border-' + terrId] });
  return feats.map((f) => f.properties?.color);
}, [lng, lat, inj.terrId]);
const setFrame = (f) => page.evaluate(async (f) => {
  const names = performance.getEntriesByType('resource').map((e) => e.name);
  for (const url of names.filter((n) => n.includes('/src/stores/editorStore'))) {
    try { const m = await import(url); if (m.useEditorStore) { m.useEditorStore.getState().setCurrentFrame(f); break; } } catch { /* next */ }
  }
}, f);
const refocus = () => page.evaluate(() => window.__sharedMap.get().jumpTo({ center: [111.0, 30.25], zoom: 8 }));

const C1 = '#E23B3B', C2 = '#2E7DD1';
let ok = true;
const check = (tag, cond) => { ok = ok && cond; log(cond ? 'OK ' : 'FAIL', tag); };
const isC = (arr, c) => arr.length === 1 && arr[0] === c;

// 1) f=29 未生效：B 整块旧色（A 已瞬时归国家2）
await setFrame(29);
await page.waitForTimeout(600);
const b0 = await probe(111.2, 30.25);
log('f=29 B中心(应国家1):', b0, ' A中心(应国家2):', await probe(110.8, 30.25));
check('f=29 B整块旧色', isC(b0, C1));

// 诊断：直调 plotShrinkAt，确认前线/切片是否生效
const diag = await page.evaluate(async () => {
  const m = await import('/map-video/src/lib/territory.ts');
  const names = performance.getEntriesByType('resource').map((e) => e.name);
  for (const url of names.filter((n) => n.includes('/src/stores/projectStore'))) {
    try {
      const pm = await import(url);
      if (!pm?.useProjectStore?.getState().project) continue;
      const terr = pm.useProjectStore.getState().project.chapters[0].elements.find((x) => x.id === 'terr_t');
      if (!terr) return { err: '无疆域' };
      const pb = terr.plots.find((x) => x.id === 'pb');
      const st = m.plotShrinkAt(pb, terr.events, 42, terr.countries, terr.plots);
      return { active: st.active, p: st.p, regionRings: st.region ? st.region.reduce((a, g) => a + g.length, 0) : null };
    } catch (e) { return { err: String(e).slice(0, 160) } }
  }
  return { err: 'store 未找到' };
});
log('诊断 f=42 plotShrinkAt:', diag);

// 2) 蚕食推进（前线=B左缘 x=111.0，湍流置换前沿）
//    off = eased*0.4*1.65*(1±0.62收敛)-tol：f=31 未咬入 / f=38 前沿∈[111.02,111.08] / f=42→[111.08,111.26] / f=52 已清场
for (const f of [31, 38, 42, 52, 57]) {
  await setFrame(f);
  await page.waitForTimeout(600);
  const near = await probe(111.01, 30.25);   // 前线带内
  const far = await probe(111.35, 30.25);    // 远端
  const deep = await probe(111.2, 30.25);    // 深处
  const border = await probeBorder(111.4, 30.25); // 国界线（右缘）
  log(`f=${f} 近端:`, near, `远端:`, far, `深处:`, deep, `国界:`, border);
  check(`f=${f} 探点至多1个feature(无叠加态)`, near.length <= 1 && far.length <= 1 && deep.length <= 1);
  if (f === 31) {
    check('f=31 刚开跑整块旧色(无发丝咬入)', isC(near, C1) && isC(deep, C1) && isC(far, C1));
    check('f=31 国界线仍旧色(归属未提前翻转)', isC(border, C1));
  }
  if (f === 38) {
    check('f=38 深处未及(仍旧色)', isC(deep, C1));
    check('f=38 远端旧色', isC(far, C1));
  }
  if (f === 42) {
    check('f=42 近端已新色', isC(near, C2));
    check('f=42 远端旧色', isC(far, C1));
    check('f=42 国界线仍旧色', isC(border, C1));
  }
  if (f === 52) {
    check('f=52 近端新色', isC(near, C2));
    check('f=52 全部吞并(远端新色)', isC(far, C2));
  }
  if (f === 57) {
    check('f=57 收尾干净(近端新色)', isC(near, C2));
    check('f=57 收尾干净(远端新色)', isC(far, C2));
    check('f=57 国界线已切新色', isC(border, C2));
  }
  await refocus();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `docs/studio-shots/v18-shrink-turb-f${f}.png` });
}

// 3) f=60 全新色
await setFrame(60);
await page.waitForTimeout(600);
const done = await probe(111.2, 30.25);
log('f=60 B中心(应国家2):', done);
check('f=60 全新色', isC(done, C2));
await refocus();
await page.waitForTimeout(900);
await page.screenshot({ path: 'docs/studio-shots/v18-shrink-turb-f60.png' });

log('console 尾部:', consoleLog.slice(-10));
log('PageErrors:', errs.length ? errs : 'none');
log('总体:', ok ? 'ALL OK' : 'HAS FAIL');
page.close();
process.exit(ok && !errs.length ? 0 : 1);
