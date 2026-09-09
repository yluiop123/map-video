// 只截地图 canvas 元素，测量 pin 底部与 ribbon 顶部是否重合
import { chromium } from 'playwright-core';
import { getWorkPage } from './pw-page.mjs';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = await getWorkPage(browser.contexts()[0]);
await page.goto('http://localhost:5173/map-video/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1200);
const listVisible = await page.getByText('最近项目').isVisible({ timeout: 2500 }).catch(() => false);
if (!listVisible) { await page.locator('button[title="项目列表"]').click(); await page.waitForTimeout(800); }
await page.locator('input[type="file"]').first().setInputFiles('D:/frontend/map-video/flyarch-config.json');
await page.waitForTimeout(5000);
await page.evaluate(() => { window.__sharedMap.get().jumpTo({ center: [104.85, 30.78], zoom: 9.2, pitch: 52, bearing: -25 }); });
await page.waitForTimeout(600);
await page.evaluate(() => { window.__editorStore.setState({ currentFrame: 150, isPlaying: false }); });
await page.waitForTimeout(900);
// 读 icon-translate 与 ground
const meta = await page.evaluate(() => {
  const m = window.__sharedMap.get();
  const out = {};
  const iconLayer = m.getLayer('line-move-layer-el-fly-line');
  const tr = iconLayer ? m.getPaintProperty('line-move-layer-el-fly-line', 'icon-translate') : null;
  out.iconTranslate = tr;
  const iconSrc = m.getSource('line-move-src-el-fly-line');
  const pt = iconSrc ? (iconSrc._data?.features?.[0]?.geometry?.coordinates || null) : null;
  if (pt) { const p = m.project(pt); out.iconGround = [Math.round(p.x), Math.round(p.y)]; out.iconLnglat = pt; }
  return out;
});
console.log('meta:', JSON.stringify(meta));
await page.locator('.maplibregl-canvas').first().screenshot({ path: 'docs/studio-shots/canvas-pin.png' });
// 分析 canvas 截图
await page.goto('file:///D:/frontend/map-video/docs/studio-shots/canvas-pin.png');
await page.waitForTimeout(200);
const r = await page.evaluate(() => {
  const img = document.querySelector('img');
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  const W = c.width, H = c.height;
  const colRed = new Map();
  const blueBB = { xMin: 1e9, xMax: -1, yMin: 1e9, yMax: -1 };
  for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
    const i = (y * W + xx) * 4;
    const rr = d[i], g = d[i + 1], b = d[i + 2];
    if (rr > 200 && g < 90 && b < 90) {
      const a = colRed.get(xx) || [1e9, -1];
      a[0] = Math.min(a[0], y); a[1] = Math.max(a[1], y);
      colRed.set(xx, a);
    } else if (b > 180 && rr < 90 && g < 90) {
      blueBB.xMin = Math.min(blueBB.xMin, xx); blueBB.xMax = Math.max(blueBB.xMax, xx);
      blueBB.yMin = Math.min(blueBB.yMin, y); blueBB.yMax = Math.max(blueBB.yMax, y);
    }
  }
  const pinX = blueBB.xMin <= blueBB.xMax ? Math.round((blueBB.xMin + blueBB.xMax) / 2) : -1;
  let redTopAtPin = -1, redBottomAtPin = -1, redAtPin = 0;
  for (let xx = pinX - 12; xx <= pinX + 12; xx++) {
    const a = colRed.get(xx);
    if (a) { redTopAtPin = redTopAtPin === -1 ? a[0] : Math.min(redTopAtPin, a[0]); redBottomAtPin = Math.max(redBottomAtPin, a[1]); redAtPin++; }
  }
  let redXMax = -1;
  for (const xx of colRed.keys()) redXMax = Math.max(redXMax, xx);
  return { W, H, blueBB, pinX, pinBottomY: blueBB.yMax, redTopAtPin, redBottomAtPin, redAtPin, redXMax };
});
console.log(JSON.stringify(r));
process.exit(0);