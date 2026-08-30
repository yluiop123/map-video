import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes('localhost:5173'));
if (!page) page = await ctx.newPage();
await page.bringToFront();

await page.goto('http://localhost:5173/map-video/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);

// 若在项目列表 → 打开第一个项目
const listVisible = await page.getByText('最近项目').isVisible({ timeout: 2000 }).catch(() => false);
if (listVisible) {
  await page.locator('.space-y-2 > div').first().click();
  await page.waitForTimeout(5000);
}

const readState = () => page.evaluate(() => {
  const time = Array.from(document.querySelectorAll('div')).map(d => d.textContent || '').find(t => /\d\d:\d\d\.\d\d \/ /.test(t));
  const blocks = Array.from(document.querySelectorAll('button[title*="视角"]')).map(b => {
    const s = getComputedStyle(b);
    return { title: b.getAttribute('title'), left: s.left, width: s.width, vis: s.visibility };
  });
  return { time, blocks };
});

await page.screenshot({ path: 'docs/studio-shots/cam-0.png' });
console.log('before:', JSON.stringify(await readState()));

// 播放
await page.locator('button[title*="播放"]').first().click({ timeout: 4000 }).catch(e => console.log('play click fail', e.message.split('\n')[0]));
await page.waitForTimeout(3000);
console.log('t+3s:', JSON.stringify(await readState()));
await page.screenshot({ path: 'docs/studio-shots/cam-1.png' });
await page.waitForTimeout(3000);
console.log('t+6s:', JSON.stringify(await readState()));
await page.screenshot({ path: 'docs/studio-shots/cam-2.png' });

// 停止
try { await page.locator('button[title*="暂停"]').first().click({ timeout: 2000 }); } catch {}
process.exit(0);
