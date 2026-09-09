// 验证 globe 下 projectLifted 是否错位（标记点不可见的根因）
import { chromium } from 'playwright-core';
import { getWorkPage } from './pw-page.mjs';
import { writeFileSync } from 'fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await getWorkPage(ctx);

await page.goto('http://localhost:5173/map-video/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1200);
const listVisible = await page.getByText('最近项目').isVisible({ timeout: 2500 }).catch(() => false);
if (!listVisible) { await page.locator('button[title="项目列表"]').click(); await page.waitForTimeout(800); }
await page.locator('input[type="file"]').first().setInputFiles('D:/frontend/map-video/flyarch-config.json');
await page.waitForTimeout(6000);

// 打开 3D globe
const chip = page.locator('button[title="底图 / 高程 / 3D"]');
await chip.click(); await page.waitForTimeout(400);
await page.locator('button[title*="3D 球体"]').click();
await page.waitForTimeout(1800);
await chip.click(); await page.waitForTimeout(300);

const out = await page.evaluate(() => {
  const m = window.__sharedMap.get();
  m.jumpTo({ center: [104.85, 30.78], zoom: 9.2, pitch: 52, bearing: -25 });
  return true;
});
await page.waitForTimeout(900);
await page.evaluate(() => { window.__editorStore.setState({ currentFrame: 150, isPlaying: false }); });
await page.waitForTimeout(900);

const res = await page.evaluate(async () => {
  const m = window.__sharedMap.get();
  const mod = await import('/map-video/src/lib/fly-ribbon.ts');
  const coord = [104.9, 30.8];
  const ground = m.project(coord);
  const lifted = mod.projectLifted(m, coord, 40000);
  const liftedSmall = mod.projectLifted(m, coord, 5000);
  // 拱形在 ratio 0.625 处应有位置：地面投影点往上
  const c = m.getCenter();
  const lc = mod.projectLifted(m, [c.lng, c.lat], 0);
  const lcUp = mod.projectLifted(m, [c.lng, c.lat], 50000);
  return {
    projection: m.getProjection()?.type,
    ground: { x: ground.x, y: ground.y },
    lifted5k: liftedSmall,
    lifted40k: lifted,
    centerGround: lc,
    centerUp50k: lcUp,
    liftM: mod.flyLiftMeters(m),
    canvasW: m.getCanvas().clientWidth,
    markerDrawn: (window.__flyRibbonDbg || {}).markerDrawn,
  };
});
console.log(JSON.stringify(res, null, 2));
await page.screenshot({ path: 'docs/studio-shots/fly3-globe-marker.png' });
process.exit(0);
