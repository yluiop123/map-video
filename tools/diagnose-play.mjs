// 打开本地项目 → 自动创建 → 播放 → 截图 + 抓错误
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => { if (['error','warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text().slice(0,300)}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack||'').split('\n').slice(0,4).join('\n')}`));
page.on('requestfailed', (r) => { if (!r.url().includes('mapimator')) logs.push(`[reqfail] ${r.url().slice(0,120)} :: ${r.failure()?.errorText}`); });

await page.goto('http://localhost:5173/map-video/', { waitUntil: 'networkidle', timeout: 30000 }).catch(e=>logs.push('[goto]'+e.message));
await page.waitForTimeout(1500);

// 若在项目列表页 → 创建项目
const hasCreate = await page.getByText('新建项目', { exact: true }).isVisible({timeout:2000}).catch(()=>false);
if (hasCreate) {
  await page.getByPlaceholder('项目名称').fill('播放测试');
  await page.getByRole('button', { name: '创建' }).click();
  await page.waitForTimeout(6000); // 等地图加载
}

await page.screenshot({ path: 'docs/studio-shots/play-0-idle.png' });

// 点击播放（title=播放）
try {
  await page.locator('button[title*="播放"]').first().click({ timeout: 4000 });
} catch (e) { logs.push('[playclick] ' + e.message.split('\n')[0]); }

await page.waitForTimeout(2600);
await page.screenshot({ path: 'docs/studio-shots/play-1-playing.png' });
await page.waitForTimeout(2000);
await page.screenshot({ path: 'docs/studio-shots/play-2-later.png' });

writeFileSync('docs/studio-shots/play-errors.txt', logs.join('\n') || '(no errors)', 'utf8');
console.log('errors:', logs.length);
process.exit(0);
