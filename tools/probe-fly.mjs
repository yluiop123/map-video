// fly-ribbon 渲染探针：导入 flyarch 项目 → mercator/globe 双投影对照 → 输出 window.__flyRibbonDbg + 截图
// 用法：node tools/probe-fly.mjs   （需 9222 调试端口 + flyarch-config.json）
import { chromium } from 'playwright-core';
import { getWorkPage } from './pw-page.mjs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await getWorkPage(ctx);
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') errors.push(`[${msg.type()}] ${msg.text()}`); });
page.on('pageerror', (err) => errors.push('PAGEERROR: ' + err.message));

await page.goto('http://localhost:5173/map-video/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);

const listVisible = await page.getByText('最近项目').isVisible({ timeout: 2500 }).catch(() => false);
if (!listVisible) { await page.locator('button[title="项目列表"]').click(); await page.waitForTimeout(1000); }
await page.locator('input[type="file"]').first().setInputFiles('D:/frontend/map-video/flyarch-config.json');
await page.waitForTimeout(6000);

const chip = page.locator('button[title="底图 / 高程 / 3D"]');
const setGlobe = async (on) => {
  const toggle = page.locator('button[title*="3D 球体"]');
  const open = await toggle.isVisible({ timeout: 1200 }).catch(() => false);
  if (!open) { await chip.click(); await page.waitForTimeout(400); }
  await toggle.click();
  await page.waitForTimeout(1800);
  await chip.click(); // 关闭面板避免遮挡
  await page.waitForTimeout(300);
};

const snap = async (name) => {
  await page.evaluate(() => {
    const m = window.__sharedMap.get();
    m.jumpTo({ center: [104.85, 30.78], zoom: 9.2, pitch: 52, bearing: -25 });
  });
  await page.waitForTimeout(700);
  await page.evaluate(() => { window.__editorStore.setState({ currentFrame: 150, isPlaying: false }); });
  await page.waitForTimeout(1000);
  const d = await page.evaluate(() => {
    const m = window.__sharedMap?.get();
    const dbg = { ...(window.__flyRibbonDbg || {}) };
    delete dbg.dpdMainMatrix; delete dbg.dpdProjMatrix; delete dbg.matrix; delete dbg.mvpMatrix;
    return {
      projection: m?.getProjection?.()?.type ?? '?',
      layer: m?.getLayer?.('fly-ribbons') ? 'present' : 'absent',
      dbg,
    };
  });
  console.log(name, JSON.stringify(d));
  await page.screenshot({ path: `docs/studio-shots/flyarch-probe-${name}.png` });
};

await snap('merc');
await setGlobe(true);
await snap('globe');
await setGlobe(false);
await snap('merc2');
console.log('console errors:', errors.length ? errors.slice(0, 10) : 'none');
process.exit(0);
