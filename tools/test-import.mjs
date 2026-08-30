import { chromium } from 'playwright-core';
import { getWorkPage } from './pw-page.mjs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await getWorkPage(ctx);

await page.goto('http://localhost:5173/map-video/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1200);

// 项目列表 → 导入 test001 配置
const listVisible = await page.getByText('最近项目').isVisible({ timeout: 2500 }).catch(() => false);
if (!listVisible) { await page.locator('button[title="项目列表"]').click(); await page.waitForTimeout(1000); }
await page.locator('input[type="file"]').first().setInputFiles('D:/frontend/map-video/test001-config.json');
await page.waitForTimeout(6000);

const readState = () => page.evaluate(() => {
  const t = Array.from(document.querySelectorAll('div')).map(d => d.textContent || '').find(t => /\d\d:\d\d\.\d\d \/ \d\d:\d\d\.\d\d/.test(t));
  return (t && t.match(/\d\d:\d\d\.\d\d \/ /) || [''])[0];
});

// ⏩ ×25 → 25s（飞行 20→30s 的中段）
const fwd = page.locator('button[title="前进 1 秒"]').first();
for (let i = 0; i < 25; i++) { await fwd.click({ timeout: 3000 }); await page.waitForTimeout(60); }
await page.waitForTimeout(600);
console.log('seek 25s →', await readState());
await page.screenshot({ path: 'docs/studio-shots/imp-25s.png' });

// 再 +5s → 30s（到达视角3：pitch 60）
for (let i = 0; i < 5; i++) { await fwd.click({ timeout: 3000 }); await page.waitForTimeout(60); }
await page.waitForTimeout(800);
console.log('seek 30s →', await readState());
await page.screenshot({ path: 'docs/studio-shots/imp-30s.png' });

// 40s：视角3→4 漂移段
for (let i = 0; i < 10; i++) { await fwd.click({ timeout: 3000 }); await page.waitForTimeout(60); }
await page.waitForTimeout(800);
await page.screenshot({ path: 'docs/studio-shots/imp-40s.png' });
process.exit(0);
