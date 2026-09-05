// 回归：疆域多段共享边（密集边界描幕按地理长度选弧）+ 单边角点共享 + T 型分叉 + 拖拽联动 + Alt 删点
// 用法：Chrome 开 --remote-debugging-port=9222（临时 profile），dev server 5173，然后 node tools/test-territory-edit.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve('docs/studio-shots');
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('localhost:5173')) || (await ctx.newPage());
await page.bringToFront();
await page.setViewportSize({ width: 1680, height: 950 });
if (!page.url().includes('localhost:5173')) await page.goto('http://localhost:5173/map-video/');

// 清空 IndexedDB → 重载出欢迎页 → 新建项目（保证干净状态）
await page.evaluate(async () => {
  const dbs = await indexedDB.databases();
  for (const d of dbs) indexedDB.deleteDatabase(d.name);
});
await page.reload();
await page.waitForTimeout(3000);
await page.getByPlaceholder('项目名称').fill('疆域多边回归');
await page.getByText('创建', { exact: true }).first().click();
await page.waitForTimeout(2000);
await page.waitForSelector('canvas', { timeout: 20000 });
await page.waitForTimeout(3500);

const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

const shot = async (tag) => {
  for (let i = 0; i < 4; i++) {
    try {
      await page.bringToFront();
      await page.evaluate(() => window.focus());
      await page.mouse.move(400, 300);
      await page.screenshot({ path: path.join(OUT_DIR, `terr-m-${tag}.png`), timeout: 12000 });
      return true;
    } catch (e) {
      if (i === 3) { console.log(`shot ${tag} FAIL:`, String(e).slice(0, 90)); return false; }
      await page.waitForTimeout(1200);
    }
  }
  return false;
};

// 读取疆域地块（键 = 1e-7° 网格坐标键）
const terrState = async () => page.evaluate(async () => {
  const mod = await import('/map-video/src/stores/projectStore.ts');
  const proj = mod.useProjectStore.getState().project;
  const ch = proj?.chapters?.[0];
  const terr = ch?.elements?.find((x) => x.type === 'territory');
  if (!terr) return null;
  const key = (p) => `${Math.round(p[0] * 1e7)},${Math.round(p[1] * 1e7)}`;
  return { plots: terr.plots.map((p) => ({ name: p.name, id: p.id, n: p.rings[0].length - 1, keys: p.rings[0].map(key), ys: p.rings[0].map((c) => +c[1].toFixed(4)) })) };
});
const hasKey = (st, plotName, k) => st?.plots?.find((p) => p.name === plotName)?.keys.includes(k) ?? false;

const xy = (lng, lat, dx = 0, dy = 0) => page.evaluate(([lng, lat, dx, dy]) => {
  const m = window.__sharedMap.get();
  const cv = document.querySelector('canvas');
  const b = cv.getBoundingClientRect();
  const p = m.project([lng, lat]);
  return [b.x + p.x + dx, b.y + p.y + dy];
}, [lng, lat, dx, dy]);

// 定位相机
await page.evaluate(() => window.__sharedMap.get().jumpTo({ center: [110.9, 30.2], zoom: 8 }));
await page.waitForTimeout(1000);

// 进入绘制地块模式
await page.getByTitle('疆域', { exact: true }).first().click();
await page.waitForTimeout(400);
await page.getByTitle('绘制地块（多点闭合）').first().click();
await page.waitForTimeout(600);

// —— A：西边界密集（11 顶点，西界 x=110.6 上 7 个中间点）——
const A_PTS = [
  [110.6, 30.0], [111.2, 30.0], [111.2, 30.5], [110.6, 30.5],
  [110.6, 30.44], [110.6, 30.38], [110.6, 30.32], [110.6, 30.26],
  [110.6, 30.20], [110.6, 30.14], [110.6, 30.08],
];
for (const [lng, lat] of A_PTS) {
  const [x, y] = await xy(lng, lat);
  await page.mouse.click(x, y);
  await page.waitForTimeout(160);
}
{
  const [x, y] = await xy(110.6, 30.08);
  await page.mouse.dblclick(x, y);
}
await page.waitForTimeout(900);
let st = await terrState();
console.log('A drawn:', st?.plots?.map((p) => `${p.name}(${p.n})`).join(' '), '→ 期望 地块1(11)');
await shot('1-A');

// —— B：西侧新地块。两击吸附 A 密集西界的两端 → 按地理长度描摹 7 个中间点（顶点数会选错方向）——
{
  const [x, y] = await xy(110.6, 30.0, 3, 3);
  await page.mouse.click(x, y);
}
await page.waitForTimeout(200);
{
  const [x, y] = await xy(110.6, 30.5, 3, -3);
  await page.mouse.click(x, y);
}
await page.waitForTimeout(200);
{
  const [x, y] = await xy(110.0, 30.5);
  await page.mouse.click(x, y);
}
await page.waitForTimeout(200);
{
  const [x, y] = await xy(110.0, 30.0);
  await page.mouse.click(x, y);
}
await page.waitForTimeout(200);
{
  const [x, y] = await xy(110.0, 30.0);
  await page.mouse.dblclick(x, y);
}
await page.waitForTimeout(900);
st = await terrState();
// 从 A 实际存储坐标推导期望键（点击经像素量化，不能用理想坐标硬编码）
const aKeys = st.plots.find((p) => p.name === '地块1').keys;
const westKeys = aKeys.slice(4, 11);   // 西界 7 个中间点（vi4..vi10）
const aSW = aKeys[0], aNW = aKeys[3];  // 西界两端点
console.log('B drawn:', st?.plots?.map((p) => `${p.name}(${p.n})`).join(' '), '→ 期望 地块2(11)=2吸附+7描摹+2右侧');
console.log('B 端点共享:', hasKey(st, '地块2', aSW) && hasKey(st, '地块2', aNW) ? 'OK' : 'FAIL');
console.log('B 密集边描摹(按长度选弧):', westKeys.every((k) => hasKey(st, '地块2', k)) ? 'OK' : 'FAIL');
await shot('2-B');

// —— C：东侧新地块，两角点吸附 A 东边直边（单边基准场景）——
{
  const [x, y] = await xy(111.2, 30.0);
  await page.mouse.click(x, y);
}
await page.waitForTimeout(200);
{
  const [x, y] = await xy(111.8, 30.0);
  await page.mouse.click(x, y);
}
await page.waitForTimeout(200);
{
  const [x, y] = await xy(111.8, 30.5);
  await page.mouse.click(x, y);
}
await page.waitForTimeout(200);
{
  const [x, y] = await xy(111.2, 30.5);
  await page.mouse.click(x, y);
}
await page.waitForTimeout(200);
{
  const [x, y] = await xy(111.2, 30.5);
  await page.mouse.dblclick(x, y);
}
await page.waitForTimeout(900);
st = await terrState();
console.log('C drawn:', st?.plots?.map((p) => `${p.name}(${p.n})`).join(' '), '→ 期望 地块3(4)');
console.log('C 角点共享:', hasKey(st, '地块3', aKeys[1]) && hasKey(st, '地块3', aKeys[2]) ? 'OK' : 'FAIL');
await shot('3-C');

// —— D：南侧地块，两条边吸附 B 南边（边吸附 → T 型分叉点插入 B）——
{
  const [x, y] = await xy(110.2, 29.6);
  await page.mouse.click(x, y);
}
await page.waitForTimeout(200);
{
  const [x, y] = await xy(110.4, 29.6);
  await page.mouse.click(x, y);
}
await page.waitForTimeout(200);
{
  const [x, y] = await xy(110.4, 30.0);
  await page.mouse.click(x, y);
}
await page.waitForTimeout(200);
{
  const [x, y] = await xy(110.2, 30.0);
  await page.mouse.click(x, y);
}
await page.waitForTimeout(200);
{
  const [x, y] = await xy(110.2, 30.0);
  await page.mouse.dblclick(x, y);
}
await page.waitForTimeout(900);
st = await terrState();
const dKeys = st.plots.find((p) => p.name === '地块4').keys; // D: [SW, SE, T2, T1]
console.log('D drawn:', st?.plots?.map((p) => `${p.name}(${p.n})`).join(' '), '→ 期望 地块4(4) 且 地块2 分叉到(13)');
console.log('T 分叉入 B:', hasKey(st, '地块2', dKeys[2]) && hasKey(st, '地块2', dKeys[3]) ? 'OK' : 'FAIL');
await shot('4-D');

// —— 编辑：双击 B 进入边界编辑（仍在绘制模式，空笔双击）→ 拖共享顶点 → A 同步 ——
const sharedBefore = aKeys.filter((k) => hasKey(st, '地块2', k)); // A∩B 共享键（2端点+7描摹+…）
const w4 = aKeys[7]; // 被拖顶点 (110.6,30.26)
{
  const [x, y] = await xy(110.3, 30.25);
  await page.mouse.dblclick(x, y);
}
await page.waitForTimeout(900);
const from = await xy(110.6, 30.26);
const to = await xy(110.72, 30.26);
await page.mouse.move(from[0], from[1]);
await page.mouse.down();
for (let i = 1; i <= 6; i++) {
  await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 6, from[1] + ((to[1] - from[1]) * i) / 6);
  await page.waitForTimeout(60);
}
await page.mouse.up();
await page.waitForTimeout(900);
st = await terrState();
const aNow = st.plots.find((p) => p.name === '地块1').keys;
const bNow = st.plots.find((p) => p.name === '地块2').keys;
const sharedAfter = aNow.filter((k) => bNow.includes(k));
const newShared = sharedAfter.filter((k) => !sharedBefore.includes(k));
console.log('共享顶点联动(A+B 同步):', sharedAfter.length === sharedBefore.length && newShared.length === 1 ? 'OK' : 'FAIL', `(共享 ${sharedBefore.length}→${sharedAfter.length}, 新键 ${newShared.length})`);
console.log('旧坐标清除:', !aNow.includes(w4) && !bNow.includes(w4) ? 'OK' : 'FAIL');
await shot('5-drag');

// —— Alt+点击共享顶点 (110.6,30.32) → A/B 同步删除 ——
const w6 = aNow.includes(aKeys[6]) ? aKeys[6] : sharedAfter.find((k) => !westKeys.includes(k) && k !== aSW && k !== aNW && k !== aKeys[1] && k !== aKeys[2]) || aKeys[6];
{
  const [x, y] = await xy(110.6, 30.32);
  await page.keyboard.down('Alt');
  await page.mouse.click(x, y);
  await page.keyboard.up('Alt');
}
await page.waitForTimeout(900);
st = await terrState();
const aDel = st.plots.find((p) => p.name === '地块1').keys;
const bDel = st.plots.find((p) => p.name === '地块2').keys;
const delOK = !aDel.includes(w6) && !bDel.includes(w6);
console.log('Alt 删共享点:', delOK ? 'OK' : 'FAIL', '| 顶点数:', st?.plots?.map((p) => `${p.name}(${p.n})`).join(' '), '→ 期望 地块1(10) 地块2(12)');
await shot('6-del');
const aBeforeE = st.plots.find((p) => p.name === '地块1').keys;

// —— E：与 A 重叠的地块 → 完成后自动修剪（重叠消失 + 交点回插 A 反向分叉）——
// （前序场景后处于选择模式，需重新进入绘制地块模式）
await page.getByTitle('疆域', { exact: true }).first().click();
await page.waitForTimeout(300);
await page.getByTitle('绘制地块（多点闭合）').first().click();
await page.waitForTimeout(600);
{
  const pts = [[110.7, 30.3], [111.0, 30.3], [111.0, 30.7], [110.7, 30.7]];
  for (const [lng, lat] of pts) {
    const [x, y] = await xy(lng, lat);
    await page.mouse.click(x, y);
    await page.waitForTimeout(200);
  }
  const [x, y] = await xy(110.7, 30.7);
  await page.mouse.dblclick(x, y);
}
await page.waitForTimeout(1200);
st = await terrState();
const ePlot = st?.plots?.find((p) => p.name === '地块5');
const aE = st?.plots?.find((p) => p.name === '地块1');
const eOK = ePlot && ePlot.n === 4 && ePlot.ys.every((v) => v >= 30.49);
const eSplitOK = ePlot && aE && aE.n >= 12 && ePlot.keys.filter((k) => aE.keys.includes(k)).length >= 2; // 底边交点回插 A（含首击落在A边上的合法T分叉）
console.log('E 重叠修剪:', eOK ? 'OK' : 'FAIL', '| 交点回插 A:', eSplitOK ? 'OK' : 'FAIL', '| 顶点数:', st?.plots?.map((p) => `${p.name}(${p.n})`).join(' '), '→ 期望 地块5(4) 地块1(+2)');
const aAdd = (aE?.keys || []).filter((k) => !aBeforeE.includes(k));
console.log('A 新增键:', aAdd.map((k) => k.split(',').map((n) => (Number(n) / 1e7).toFixed(5)).join(',')).join(' | ') || '(无)');
await shot('7-trim');

// —— F：地块删点后自动移除 → terrPlotId 重定向 → 编辑点仍可见 ——
const markerState = () => page.evaluate(async () => {
  const me = await import('/map-video/src/stores/editorStore.ts');
  const mp = await import('/map-video/src/stores/projectStore.ts');
  const stE = me.useEditorStore.getState();
  const terr = mp.useProjectStore.getState().project?.chapters?.[0]?.elements?.find((x) => x.type === 'territory');
  let vCount = -1;
  try { vCount = window.__sharedMap.get().querySourceFeatures('vertex-markers').length; } catch { /* */ }
  return { terrPlotId: stE.terrPlotId, match: terr?.plots?.some((p) => p.id === stE.terrPlotId) ?? false, vCount };
});

// Esc → 选择模式 → 双击 E 内部进入编辑 → Alt 点掉 E 的西北角（4→3 → 地块被移除）
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
{
  const [x, y] = await xy(110.85, 30.6);
  await page.mouse.dblclick(x, y);
}
await page.waitForTimeout(900);
{
  const [x, y] = await xy(110.7, 30.7);
  await page.keyboard.down('Alt');
  await page.mouse.click(x, y);
  await page.keyboard.up('Alt');
}
await page.waitForTimeout(1000);
st = await terrState();
const eTri = st?.plots?.find((p) => p.name === '地块5'); // Alt 删点有 >3 守卫：4→3 三角形保留（整删走面板）
const mk = await markerState();
const fOK = eTri && eTri.n === 3 && mk.match && mk.vCount > 0;
console.log('F 删点后编辑保持:', fOK ? 'OK' : 'FAIL', `(E=${eTri ? eTri.n : 'removed'}, terrPlotId=${mk.match ? 'match' : 'stale'}, vCount=${mk.vCount})`);
await shot('8-retarget');

console.log('PageErrors:', errors.length ? errors : 'none');
await browser.close();
process.exit(0);
