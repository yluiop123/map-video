// 回归：疆域系统（新建疆域 → 导入中国 → 兼并点选 → 生成事件 → 特效帧截图）
// 用法：Chrome 开 --remote-debugging-port=9222（临时 profile），dev server 5173，然后 node tools/test-territory.mjs
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
await page.reload();
await page.waitForTimeout(2500);

const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

const shot = async (tag) => {
  for (let i = 0; i < 4; i++) {
    try {
      await page.bringToFront();
      await page.evaluate(() => window.focus());
      await page.mouse.move(400, 300);
      await page.screenshot({ path: path.join(OUT_DIR, `terr-${tag}.png`), timeout: 12000 });
      return true;
    } catch (e) {
      if (i === 3) { console.log(`shot ${tag} FAIL:`, String(e).slice(0, 90)); return false; }
      await page.waitForTimeout(1200);
    }
  }
  return false;
};

// 欢迎页 → 新建项目进编辑器
if ((await page.locator('canvas').count()) === 0) {
  await page.getByPlaceholder('项目名称').fill('疆域回归');
  await page.getByText('创建', { exact: true }).first().click();
  await page.waitForTimeout(2000);
}
await page.waitForSelector('canvas', { timeout: 20000 });
await page.waitForTimeout(3500);

// 1) 疆域 → 新建疆域
await page.getByTitle('疆域', { exact: true }).first().click();
await page.waitForTimeout(500);
await page.getByText('新建疆域').first().click();
await page.waitForTimeout(1500);
const panelText = await page.evaluate(() => document.body.innerText);
console.log('Panel:', panelText.includes('疆域设置'), panelText.includes('新增国家'), panelText.includes('兼并事件'));
await shot('01-new');

// 2) 导入疆域 → 中国
await page.getByTitle('疆域', { exact: true }).first().click();
await page.waitForTimeout(500);
await page.getByText('导入疆域').first().click();
await page.waitForTimeout(600);
await page.getByPlaceholder('搜索：中国 / Japan / 巴西 …').fill('中国');
await page.waitForTimeout(500);
await page.getByTitle('导入 中国', { exact: true }).first().click();
try {
  await page.waitForFunction(() => document.body.innerText.includes('已导入'), { timeout: 20000 });
  const txt = await page.evaluate(() => (document.body.innerText.match(/已导入[^\n]*/) || ['?'])[0]);
  console.log('Import:', txt);
} catch { console.log('Import: 等待导入结果超时'); }
await shot('02-imported');
await page.getByText('完成', { exact: true }).first().click();
await page.waitForTimeout(800);

// 3) 兼并模式：经 map.project 换算屏幕坐标，点选 大陆 + 海南 两个地块
await page.getByTitle('疆域', { exact: true }).first().click();
await page.waitForTimeout(400);
await page.getByText('兼并', { exact: true }).first().click();
await page.waitForTimeout(600);
const pts = await page.evaluate(() => {
  const m = window.__sharedMap?.get?.();
  const cv = document.querySelector('canvas');
  if (!m || !cv) return null;
  const b = cv.getBoundingClientRect();
  const toXY = (lng, lat) => { const p = m.project([lng, lat]); return [b.x + p.x, b.y + p.y]; };
  return { mainland: toXY(104, 35), hainan: toXY(109.9, 19.2) };
});
if (!pts) {
  console.log('⚠ 拿不到共享地图实例（window.__sharedMap）');
} else {
  await page.mouse.click(pts.mainland[0], pts.mainland[1]);
  await page.waitForTimeout(450);
  await page.mouse.click(pts.hainan[0], pts.hainan[1]);
  await page.waitForTimeout(700);
}
await shot('03-picked');

// 4) 生成兼并事件
const createBtn = page.getByText(/生成兼并事件（已选/).first();
if (await createBtn.count()) {
  await createBtn.click();
  await page.waitForTimeout(700);
  console.log('Event created ✔');
} else {
  console.log('⚠ 未点到地块（事件按钮未激活）');
}
await shot('04-event');

// 5) 步进观察特效：+1s（渐变中/高亮起）→ +2s（稳定归属）
const fwd = page.locator('button[title="前进 1 秒"]').first();
if (await fwd.count()) {
  await fwd.click();
  await page.waitForTimeout(400);
  await shot('05-draw-phase');
  await fwd.click();
  await page.waitForTimeout(300);
  await fwd.click();
  await page.waitForTimeout(400);
  await shot('06-settled');
} else {
  console.log('⚠ 找不到「前进 1 秒」按钮');
}

console.log('PageErrors:', errors.length ? errors : 'none');
browser.close();
process.exit(0);
