// 抓导出对话框与 Shapes 工具
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve('docs/studio-shots');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('mapimator'));
await page.bringToFront();
await page.setViewportSize({ width: 1680, height: 950 });

const esc = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(600); };
const shot = async (tag) => {
  await page.screenshot({ path: path.join(OUT_DIR, `${tag}-page.png`) });
  const txt = await page.evaluate(() => document.body.innerText.replace(/\n{3,}/g, '\n\n'));
  writeFileSync(path.join(OUT_DIR, `${tag}-elements.txt`), `URL:${page.url()}\n${txt}`, 'utf8');
  console.log(`${tag} saved`);
};

// 放弃未保存更改弹窗如果出现：点 Discard/Dont save
try {
  const discard = page.getByRole('button', { name: /discard|don.?t save|放弃/i }).first();
  if (await discard.isVisible({ timeout: 1500 })) { await discard.click(); await page.waitForTimeout(800); }
} catch {}

// 关闭可能存在的 Highlight Region 弹窗（右上 × 按钮）
try {
  const close = page.getByRole('button', { name: /close/i }).first();
  if (await close.isVisible({ timeout: 1000 })) { await close.click(); await page.waitForTimeout(600); }
} catch {}
await esc();

// 先 Save Changes（初始化项目），否则 Export 按钮禁用
try {
  await page.locator('button', { hasText: /Save Changes|not initialized/i }).first().click({ timeout: 5000 });
  await page.waitForTimeout(3000);
  console.log('saved');
} catch (e) { console.log('save skip:', e.message.split('\n')[0]); }

// Export Video 对话框
await page.locator('button', { hasText: 'Export Video' }).first().click({ timeout: 8000 });
await page.waitForTimeout(2500);
await shot('06-export-dialog');
console.log('done-export');

process.exit(0);
