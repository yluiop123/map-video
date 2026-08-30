import { chromium } from 'playwright-core';
import { getWorkPage } from './pw-page.mjs';
import { writeFileSync } from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await getWorkPage(ctx);
await page.bringToFront();
const errs = [];
page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message));

await page.goto('http://localhost:5173/map-video/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1200);
const listVisible = await page.getByText('最近项目').isVisible({ timeout: 2500 }).catch(() => false);
if (listVisible) { await page.locator('.space-y-2 > div').first().click(); await page.waitForTimeout(5000); }

// 1. 选中视角1块 → 打开右侧面板
await page.locator('button[title*="起点锚定"]').first().click({ timeout: 5000 });
await page.waitForTimeout(600);

// 2. 回到起点
await page.locator('button[title="回本段开头"]').first().click();
await page.waitForTimeout(400);

// 3. 推进播放头到 ~5s（⏩ ×5）
for (let i = 0; i < 5; i++) { await page.locator('button[title="前进 1 秒"]').first().click(); await page.waitForTimeout(120); }

// 4. 拖拽地图改变视角（画布空白处向左上拖）
await page.mouse.move(680, 430);
await page.mouse.down();
for (let i = 1; i <= 10; i++) { await page.mouse.move(680 + i * 25, 430 - i * 10); await page.waitForTimeout(30); }
await page.mouse.up();
await page.waitForTimeout(800);

// 5. ＋ 新视角（用右侧面板按钮）
await page.locator('button[title*="新增一个视角"]').click({ timeout: 5000 });
await page.waitForTimeout(600);
const kfCount = await page.locator('button[title*="视角"], button[title*="锚定"]').count();
console.log('keyframe blocks:', kfCount);

// 6. 回起点播放
await page.locator('button[title="回本段开头"]').first().click();
await page.waitForTimeout(300);
await page.locator('button[title="播放 (空格)"]').first().click();
await page.waitForTimeout(1200);
await page.screenshot({ path: 'docs/studio-shots/fly-1s.png' });
await page.waitForTimeout(2000);
await page.screenshot({ path: 'docs/studio-shots/fly-3s.png' });
await page.waitForTimeout(1500);
await page.screenshot({ path: 'docs/studio-shots/fly-5s.png' });
try { await page.locator('button[title="暂停 (空格)"]').first().click({ timeout: 1500 }); } catch {}

writeFileSync('docs/studio-shots/fly-errors.txt', errs.join('\n') || '(no errors)', 'utf8');
console.log('errors:', errs.length);
process.exit(0);
