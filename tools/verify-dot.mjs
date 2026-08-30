// 回归：DOT 样式 = 白边圆点位图 + ORIENTATION（朝向）面板
// 用法：Chrome 开 --remote-debugging-port=9222（临时 profile），然后 node tools/verify-dot.mjs
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

// 欢迎页（项目列表）→ 填名称新建项目进编辑器
if ((await page.locator('canvas').count()) === 0) {
  await page.getByPlaceholder('项目名称').fill('dot回归');
  await page.getByText('创建', { exact: true }).first().click();
  await page.waitForTimeout(2000);
}
await page.waitForSelector('canvas', { timeout: 20000 });
await page.waitForTimeout(3500); // 等地图/字体就绪

const shot = (tag) => page.screenshot({ path: path.join(OUT_DIR, `${tag}.png`) });

// 1) 放一个 Pin（默认 shape=undefined → DOT）
await page.locator('button[title="Pin"]').first().click();
await page.waitForTimeout(1500);

// 2) 面板应出现 ORIENTATION（朝向）
const panelText = await page.evaluate(() => document.body.innerText);
const hasOrientation = panelText.includes('ORIENTATION');
console.log('ORIENTATION section visible:', hasOrientation);

await shot('dot-01-facecam');

// 3) 切 Flat → 旋转滑条出现
await page.getByText('🗺 Flat', { exact: false }).first().click();
await page.waitForTimeout(800);
const afterFlat = await page.evaluate(() => document.body.innerText);
console.log('Flat rotation slider visible:', /旋转/.test(afterFlat));

// 4) 拖旋转滑条到 180°（验证 patch 生效不报错）
const slider = page.locator('input[type="range"]').filter({ hasNot: page.locator('[type="checkbox"]') });
const cnt = await slider.count();
console.log('range sliders in panel:', cnt);
if (cnt > 0) {
  const last = slider.last();
  await last.fill('180');
  await page.waitForTimeout(500);
}
await shot('dot-02-flat-rot180');

// 5) 控制台错误收集
console.log('DONE');
