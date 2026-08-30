// 组合测试：不同底图 × 3D × 高程 在播放时的表现
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('localhost:5173')) || await ctx.newPage();
await page.bringToFront();

const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(`[err] ${m.text().slice(0, 200)}`); });

const stop = async () => { try { await page.locator('button[title*="暂停"]').first().click({ timeout: 2000 }); } catch {} await page.waitForTimeout(300); };
const play = async () => { try { await page.locator('button[title*="播放"]').first().click({ timeout: 2000 }); } catch (e) { logs.push('[play] ' + e.message.split('\n')[0]); } await page.waitForTimeout(2200); };
const shot = async (tag) => { await page.screenshot({ path: `docs/studio-shots/combo-${tag}.png` }); console.log('shot', tag, 'errs+', logs.length); };

const setSelect = async (title, label) => {
  const sel = page.locator(`select[title="${title}"]`);
  await sel.selectOption({ label }).catch(async (e) => logs.push(`[sel ${title}=${label}] ` + e.message.split('\n')[0]));
  await page.waitForTimeout(3500); // 等样式加载
};

await setSelect('底图', '暗色地图');
await play(); await shot('dark-play'); await stop();

await setSelect('底图', '卫星影像');
await play(); await shot('sat-play'); await stop();

// 3D 开
await page.locator('button[title*="3D"]').first().click();
await page.waitForTimeout(2500);
await setSelect('底图', 'OpenStreetMap');
await play(); await shot('osm-3d-play'); await stop();

// 高程
await setSelect('高程', '地形高程 (MapLibre)');
await play(); await shot('terrain-play'); await stop();
// 关 3D 复原
await page.locator('button[title*="3D"]').first().click();
await page.waitForTimeout(1500);

writeFileSync('docs/studio-shots/combo-errors.txt', logs.join('\n') || '(no errors)', 'utf8');
console.log('total errors:', logs.length);
process.exit(0);
