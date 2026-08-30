import { chromium } from 'playwright-core';
import { getWorkPage } from './pw-page.mjs';
import { writeFileSync } from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await getWorkPage(ctx);
await page.bringToFront();

const errs = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(0, 8).join('\n')}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`[console] ${m.text().slice(0, 300)}`); });

await page.goto('http://localhost:5173/map-video/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);
const listVisible = await page.getByText('最近项目').isVisible({ timeout: 2000 }).catch(() => false);
if (listVisible) { await page.locator('.space-y-2 > div').first().click(); await page.waitForTimeout(5000); }

const all = await page.locator('button[title*="播放"]').evaluateAll(els => els.map(e => e.getAttribute('title')));
console.log('播放 matches:', JSON.stringify(all));
console.log('exact playBtn count:', await page.locator('button[title="播放 (空格)"]').count());
await page.locator('button[title="播放 (空格)"]').first().click({ timeout: 4000 });
await page.waitForTimeout(300);
console.log('after 300ms pauseBtn:', await page.locator('button[title*="暂停"]').count());
await page.waitForTimeout(1500);
console.log('after 1.8s pauseBtn:', await page.locator('button[title*="暂停"]').count());
const t = await page.evaluate(() => Array.from(document.querySelectorAll('div')).map(d => d.textContent || '').find(t => /\d\d:\d\d\.\d\d \/ /.test(t)));
console.log('time text:', t && (t.match(/\d\d:\d\d\.\d\d \/ \d\d:\d\d\.\d\d/) || [])[0]);
writeFileSync('docs/studio-shots/cam-errors.txt', errs.join('\n\n') || '(no errors)', 'utf8');
console.log('errors:', errs.length);
try { await page.locator('button[title*="暂停"]').first().click({ timeout: 1000 }); } catch {}
process.exit(0);
