// 回归：深色主题 + Mapimator 布局截图（顶栏/浮动工具条/浮层面板/底部卡片/时间线）
// 用法：Chrome 开 --remote-debugging-port=9222（临时 profile），然后 node tools/verify-dark-ui.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve('docs/studio-shots/new');
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('localhost:5173')) || (await ctx.newPage());
await page.bringToFront();
await page.setViewportSize({ width: 1680, height: 950 });
if (!page.url().includes('localhost:5173')) await page.goto('http://localhost:5173/map-video/');
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message.slice(0, 200)));
await page.reload();
await page.waitForTimeout(3000);

const shot = (tag) => page.screenshot({ path: path.join(OUT_DIR, `${tag}.png`) });

// 欢迎页（深色化检查）→ 建项目进编辑器
const hasCanvas = (await page.locator('canvas').count()) > 0;
if (!hasCanvas) {
  await shot('00-welcome');
  await page.getByPlaceholder('项目名称').fill('dark回归');
  await page.getByText('创建', { exact: true }).first().click();
  await page.waitForTimeout(3000);
}
await page.waitForSelector('canvas', { timeout: 20000 });
await page.waitForTimeout(3000);
const toolTitles = await page.evaluate(() =>
  Array.from(document.querySelectorAll('button[title]')).map((b) => b.title).slice(0, 30)
);
console.log('TOOL TITLES:', JSON.stringify(toolTitles));

// 1) 编辑器初始状态
await shot('01-editor');

// 2) 放一个 Pin → 右侧浮动设置面板
await page.locator('button[title="Pin"]').first().click();
await page.waitForTimeout(1500);
await shot('02-pin-panel');

// 3) 打开元素浮层
await page.locator('button', { hasText: '元素' }).first().click();
await page.waitForTimeout(800);
await shot('03-elements');

// 4) 时间线放一个镜头关键帧 → 视角属性面板
await page.locator('button[title*="新增一个视角"]').first().click().catch(() => console.log('no kf btn'));
await page.waitForTimeout(1000);
await shot('04-keyframe');

console.log('DONE');
console.log('ERRORS:', JSON.stringify(errors.slice(0, 8), null, 1));
process.exit(0);
