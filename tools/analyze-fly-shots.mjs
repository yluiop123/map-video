// 详细采样截图：尺寸 + 红/蓝像素的粗网格分布
import { chromium } from 'playwright-core';
import { getWorkPage } from './pw-page.mjs';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = await getWorkPage(browser.contexts()[0]);
await page.goto('file:///D:/frontend/map-video/docs/studio-shots/flyarch-probe-merc.png');
await page.waitForTimeout(200);
const r = await page.evaluate(() => {
  const img = document.querySelector('img');
  if (!img) return { err: 'no img' };
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  const W = c.width, H = c.height;
  const red = [], blue = [];
  let redN = 0, blueN = 0;
  for (let y = 0; y < H; y++) {
    for (let xx = 0; xx < W; xx++) {
      const i = (y * W + xx) * 4;
      const rr = d[i], g = d[i + 1], b = d[i + 2];
      if (rr > 200 && g < 90 && b < 90) { redN++; if (red.length < 1 || red[red.length - 1].y !== y) red.push({ y, x: xx }); }
      else if (b > 180 && rr < 90 && g < 90) { blueN++; if (blue.length < 8) blue.push({ y, x: xx }); }
    }
  }
  // 10 行粗网格：每行是否含红
  const grid = [];
  for (let gy = 0; gy < 12; gy++) {
    const y0 = Math.floor((gy / 12) * H), y1 = Math.floor(((gy + 1) / 12) * H);
    let has = false, cnt = 0;
    for (let y = y0; y < y1; y++) for (let xx = 0; xx < W; xx++) {
      const i = (y * W + xx) * 4;
      if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] < 90) { has = true; cnt++; }
    }
    grid.push(`${gy}:${has ? cnt : '-'}`);
  }
  return { W, H, redN, blueN, grid, firstRedRows: red.slice(0, 20) };
});
console.log(JSON.stringify(r));
process.exit(0);