// 连接调试端口的 Chrome：可选先 Esc 清场 → 点击坐标 → 截图 + 元素文本
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve('docs/studio-shots');
mkdirSync(OUT_DIR, { recursive: true });

const tag = process.argv[2] || 'xx';
const cx = Number(process.argv[3] || NaN);
const cy = Number(process.argv[4] || NaN);

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const pages = ctx.pages();
const page = pages.find((p) => p.url().includes('mapimator')) || pages[pages.length - 1];

await page.bringToFront();
await page.setViewportSize({ width: 1680, height: 950 });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
if (!Number.isNaN(cx) && !Number.isNaN(cy)) {
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(1200);
}
await page.screenshot({ path: path.join(OUT_DIR, `${tag}-page.png`), fullPage: false });

const bodyText = await page.evaluate(() =>
  document.body.innerText.replace(/\n{3,}/g, '\n\n')
);
const controls = await page.evaluate(() => {
  const sel = 'button,[role="button"],[role="menuitem"],[role="tab"],input,select,textarea,a[href],[contenteditable="true"]';
  return Array.from(document.querySelectorAll(sel)).slice(0, 500).map((el, i) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return '';
    const label =
      el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') ||
      (el.innerText || '').trim().slice(0, 50) || el.tagName.toLowerCase();
    return `[${String(i).padStart(3)}] <${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}> "${label.replace(/\s+/g, ' ')}" @(${Math.round(r.x)},${Math.round(r.y)}) ${Math.round(r.width)}x${Math.round(r.height)}`;
  }).filter(Boolean);
});

writeFileSync(
  path.join(OUT_DIR, `${tag}-elements.txt`),
  `URL: ${page.url()}\n\n===== BODY TEXT =====\n${bodyText}\n\n===== CONTROLS (${controls.length}) =====\n${controls.join('\n')}\n`,
  'utf8'
);

console.log(`Saved ${tag} (${controls.length} controls)`);
process.exit(0);
