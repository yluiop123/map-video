// 复现用户反馈：1) flyMode 高度不明显 2) flyMode 开启后标记点看不到
// 用法：node tools/probe-fly2.mjs   （需 9222 调试端口 + flyarch-config.json）
import { chromium } from 'playwright-core';
import { getWorkPage } from './pw-page.mjs';
import { writeFileSync } from 'fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await getWorkPage(ctx);
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`[${msg.type()}] ${msg.text()}`); });
page.on('pageerror', (err) => errors.push('PAGEERROR: ' + err.message));

await page.goto('http://localhost:5173/map-video/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);

const listVisible = await page.getByText('最近项目').isVisible({ timeout: 2500 }).catch(() => false);
if (!listVisible) { await page.locator('button[title="项目列表"]').click(); await page.waitForTimeout(1000); }
await page.locator('input[type="file"]').first().setInputFiles('D:/frontend/map-video/flyarch-config.json');
await page.waitForTimeout(6000);

const report = {};

const setCam = async () => {
  await page.evaluate(() => {
    const m = window.__sharedMap.get();
    m.jumpTo({ center: [104.85, 30.78], zoom: 9.2, pitch: 52, bearing: -25 });
  });
  await page.waitForTimeout(600);
};

const inspect = async (tag, frame) => {
  await setCam();
  await page.evaluate((f) => { window.__editorStore.setState({ currentFrame: f, isPlaying: false }); }, frame);
  await page.waitForTimeout(800);
  const d = await page.evaluate(() => {
    const m = window.__sharedMap?.get();
    const dbg = { ...(window.__flyRibbonDbg || {}) };
    delete dbg.mainMatrix;
    const layerInfo = (id) => {
      const l = m?.getLayer?.(id);
      if (!m || !l) return 'absent';
      let vis = '?';
      try { vis = m.getLayoutProperty(id, 'visibility'); } catch { /* */ }
      let tr = null;
      try {
        tr = l.type === 'symbol'
          ? (m.getPaintProperty(id, l.type === 'symbol' && (id.includes('label')) ? 'text-translate' : 'icon-translate') ?? null)
          : null;
      } catch { /* */ }
      return { type: l.type, vis: vis ?? 'visible(auto)', tr };
    };
    // 标记的实际屏幕位置 vs 拱形上应有位置
    const flyMarkers = null;
    return {
      dbg,
      icon: layerInfo('line-move-layer-el-fly-line'),
      mlabel: layerInfo('line-mlabel-el-fly-line'),
      labelBg: layerInfo('linelabel-bg-el-fly-line'),
      label: layerInfo('linelabel-el-fly-line'),
      head: layerInfo('line-head-el-fly-line'),
      flyMarkers,
    };
  });
  report[`${tag}@f${frame}`] = d;
  await page.screenshot({ path: `docs/studio-shots/fly2-${tag}-f${frame}.png` });
};

// 选中路线元素（时间线元素行点击）
await page.evaluate(() => {
  const st = window.__editorStore ? window.__editorStore.getState() : null;
  window.__editorStore.setState({ selectedElementId: 'el-fly-line', panelMode: 'element' });
});
await page.waitForTimeout(800);

await inspect('initial', 0);
await inspect('initial', 150);
await inspect('initial', 260);

// 通过 UI 面板切换 飞行 开关（关闭→开启），确认 UI 路径也正常
const flySwitch = page.locator('button[role="switch"]').filter({ hasText: '' });
// 找 PropertiesPanel 里的飞行 Toggle：直接用文本定位行
const flyRow = page.getByText('✈️ 飞行（路线与图标不贴地）', { exact: false }).first();
if (await flyRow.isVisible({ timeout: 2000 }).catch(() => false)) {
  await flyRow.click(); // toggle off
  await page.waitForTimeout(1200);
  await inspect('flyoff', 150);
  await flyRow.click(); // toggle on
  await page.waitForTimeout(1200);
  await inspect('flyon', 150);
  await inspect('flyon', 30);
} else {
  report.flyRow = 'NOT FOUND in panel';
}

writeFileSync('docs/studio-shots/fly2-report.json', JSON.stringify(report, null, 2), 'utf8');
console.log('errors:', errors.length ? errors.slice(0, 8) : 'none');
process.exit(0);
