import { chromium } from 'playwright-core';
import { getWorkPage } from './pw-page.mjs';
import { writeFileSync } from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await getWorkPage(ctx);
await page.bringToFront();

const errs = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`));

await page.goto('http://localhost:5173/map-video/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);

// 项目列表 → 打开 test001
const listVisible = await page.getByText('最近项目').isVisible({ timeout: 2500 }).catch(() => false);
if (listVisible) {
  const item = page.locator('.space-y-2 > div', { hasText: 'test001' }).first();
  await item.click({ timeout: 5000 });
  await page.waitForTimeout(5000);
} else {
  // 已在编辑器：回主页再选 test001
  await page.locator('button[title="项目列表"]').click();
  await page.waitForTimeout(1200);
  const item = page.locator('.space-y-2 > div', { hasText: 'test001' }).first();
  await item.click({ timeout: 5000 });
  await page.waitForTimeout(5000);
}

const readState = () => page.evaluate(() => {
  const t = Array.from(document.querySelectorAll('div')).map(d => d.textContent || '').find(t => /\d\d:\d\d\.\d\d \/ \d\d:\d\d\.\d\d/.test(t));
  const time = (t && t.match(/\d\d:\d\d\.\d\d \/ \d\d:\d\d\.\d\d/) || [])[0] || '';
  const kfs = Array.from(document.querySelectorAll('button[title*="视角"], button[title*="起点锚定"]')).length;
  return { time, kfs };
});

console.log('before:', JSON.stringify(await readState()));
await page.screenshot({ path: 'docs/studio-shots/t001-0.png' });

// 播放 5 秒（元素动画/可见性应随时间变化）
await page.locator('button[title="播放 (空格)"]').first().click();
await page.waitForTimeout(2000);
console.log('t2s:', JSON.stringify(await readState()));
await page.screenshot({ path: 'docs/studio-shots/t001-2s.png' });
await page.waitForTimeout(3000);
console.log('t5s:', JSON.stringify(await readState()));
await page.screenshot({ path: 'docs/studio-shots/t001-5s.png' });
try { await page.locator('button[title="暂停 (空格)"]').first().click({ timeout: 2000 }); } catch {}

writeFileSync('docs/studio-shots/t001-errors.txt', errs.join('\n') || '(no errors)', 'utf8');
console.log('errors:', errs.length);
process.exit(0);
