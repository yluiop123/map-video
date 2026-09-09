// 冒烟2：特效面板字幕/音乐页签渲染与未配置 Provider 的降级提示（用完即删）
import { chromium } from 'playwright-core';
import { getWorkPage } from './pw-page.mjs';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const page = await getWorkPage(ctx);

// 确保在编辑器内（上一步已进入），点「特效」按钮
await page.waitForTimeout(1500);
const out = {};
try {
  await page.click('button:has-text("特效")', { timeout: 5000 });
  await page.waitForTimeout(600);
  // 切到「字幕」页签
  await page.click('button:has-text("字幕")', { timeout: 5000 });
  await page.waitForTimeout(600);
  out.subtitleTab = {
    hasTtsSection: await page.evaluate(() => document.body.innerText.includes('配音服务')),
    ttsNotConfigured: await page.evaluate(() => document.body.innerText.includes('未配置')),
    hasAddBtn: await page.evaluate(() => document.body.innerText.includes('添加')),
    hasAiBtn: await page.evaluate(() => document.body.innerText.includes('AI 文案')),
    hasStyle: await page.evaluate(() => document.body.innerText.includes('字幕样式')),
  };
  // 点「全部生成配音」（无文本 → 应 alert 提示而非崩溃）
  page.once('dialog', (d) => { out.genAllAlert = d.message(); d.dismiss(); });
  await page.click('button:has-text("全部生成配音")');
  await page.waitForTimeout(800);
  // 切到「音乐」页签
  await page.click('button:has-text("音乐")', { timeout: 5000 });
  await page.waitForTimeout(600);
  out.musicTab = {
    hasImport: await page.evaluate(() => document.body.innerText.includes('导入音乐')),
    hasHint: await page.evaluate(() => document.body.innerText.includes('循环')),
  };
} catch (e) {
  out.error = String(e).slice(0, 300);
}
console.log(JSON.stringify(out, null, 2));
const pass = out.subtitleTab?.hasTtsSection && out.subtitleTab?.hasAiBtn && out.subtitleTab?.hasStyle && out.musicTab?.hasImport && !out.error;
console.log(pass ? 'FX-TAB PASS' : 'FX-TAB FAIL');
await browser.close();
process.exit(pass ? 0 : 1);
