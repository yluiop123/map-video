// 连续抓取：Pin/Region 工具面板、卡片菜单、导出对话框
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve('docs/studio-shots');
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const pages = ctx.pages();
const page = pages.find((p) => p.url().includes('mapimator')) || pages[pages.length - 1];

await page.bringToFront();
await page.setViewportSize({ width: 1680, height: 950 });
await page.waitForTimeout(800);

const shot = async (tag) => {
  await page.screenshot({ path: path.join(OUT_DIR, `${tag}-page.png`) });
  const controls = await page.evaluate(() => {
    const sel = '[role="dialog"],[role="menu"],[data-state="open"] *,form,.panel,[class*="Panel" i],[class*="sidebar" i] *';
    return Array.from(document.querySelectorAll(sel)).slice(0, 300).map((el, i) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return '';
      const label =
        el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') ||
        (el.innerText || '').trim().split('\n')[0].slice(0, 60) || el.tagName.toLowerCase();
      return `[${String(i).padStart(3)}] <${el.tagName.toLowerCase()}> "${label.replace(/\s+/g, ' ').slice(0,60)}" @(${Math.round(r.x)},${Math.round(r.y)}) ${Math.round(r.width)}x${Math.round(r.height)}`;
    }).filter(Boolean);
  });
  writeFileSync(path.join(OUT_DIR, `${tag}-elements.txt`), controls.join('\n'), 'utf8');
  console.log(`${tag}: ${controls.length} panel controls`);
};

const esc = async () => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
};

// 01 Pin 工具激活（地图中心落点 + 右侧样式面板）
try {
  await page.getByRole('button', { name: 'Pin', exact: true }).first().click({ timeout: 4000 });
  await page.waitForTimeout(1500);
  await shot('02-pin-tool');
} catch (e) { console.log('pin skip:', e.message.split('\n')[0]); }
await esc();

// 02 Region 工具
try {
  await page.getByRole('button', { name: 'Region', exact: true }).first().click({ timeout: 4000 });
  await page.waitForTimeout(1800);
  await shot('04-region-tool');
} catch (e) { console.log('region skip:', e.message.split('\n')[0]); }
await esc();

// 03 卡片三点菜单
try {
  await page.locator('#radix-\\_r\\_1c\\_').click({ timeout: 3000 });
} catch {}
try {
  await page.locator('[id^="radix-"]').nth(2).click({ timeout: 3000 }); // 备选
} catch {}
try {
  // View 1 卡片上的 ⋯ 菜单：aria 可能是 "More options" 之类，用坐标兜底
  const card = await page.getByText('View 1', { exact: false }).first().boundingBox();
  if (card) { await page.mouse.click(card.x + 130, card.y - 6); await page.waitForTimeout(1000); await shot('05-card-menu'); }
} catch (e) { console.log('cardmenu skip:', e.message.split('\n')[0]); }
await esc();

// 04 Export 对话框
try {
  await page.getByRole('button', { name: /Export Video/i }).click({ timeout: 4000 });
  await page.waitForTimeout(2000);
  await shot('06-export-dialog');
} catch (e) { console.log('export skip:', e.message.split('\n')[0]); }

console.log('done');
process.exit(0);
