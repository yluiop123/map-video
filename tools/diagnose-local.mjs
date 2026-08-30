// 打开本地预览页，收集 console/page 错误并截图
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await ctx.newPage();

const logs = [];
page.on('console', (m) => { if (['error','warning'].includes(m.type())) logs.push(`[console.${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack||'').split('\n').slice(0,6).join('\n')}`));
page.on('requestfailed', (r) => { if (r.url().includes('localhost')) logs.push(`[reqfail] ${r.url()} :: ${r.failure()?.errorText}`); });

await page.goto('http://localhost:5173/map-video/', { waitUntil: 'networkidle', timeout: 30000 }).catch((e)=>logs.push('[goto] '+e.message));
await page.waitForTimeout(2500);

await page.screenshot({ path: 'docs/studio-shots/local-preview.png' });
const bodyLen = await page.evaluate(() => document.body.innerText.length);
const rootHtmlLen = await page.evaluate(() => document.getElementById('root')?.innerHTML.length ?? -1);

writeFileSync('docs/studio-shots/local-preview-errors.txt',
  `bodyTextLen=${bodyLen} rootHtmlLen=${rootHtmlLen}\n\n` + logs.join('\n'), 'utf8');
console.log(`done body=${bodyLen} root=${rootHtmlLen} errs=${logs.length}`);
process.exit(0);
