// 冒烟测试：Full 模式健康探测 + TopBar 后端芯片 + 编辑器可交互（无截图，纯 DOM/状态断言）
// 用法: node tools/smoke-backend.mjs  （需 Chrome 9222 已开 5173 页面）
import { chromium } from 'playwright-core';
import { getWorkPage } from './pw-page.mjs';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0];
const page = await getWorkPage(ctx);
await page.goto('http://localhost:5173/map-video/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

// 1. 控制台错误收集（reload 后再挂监听）
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

// 2. 编辑器状态可访问
const hasStore = await page.evaluate(() => !!window.__editorStore);

// 3. 项目列表页 → 新建项目进入编辑器（以 TopBar 出现「导出视频」为准）
const stamp = `冒烟${Date.now() % 100000}`;
const onManager = await page.evaluate(() => !!document.querySelector('input[placeholder="项目名称"]'));
let entered = false;
let stepErr = null;
try {
  if (!onManager) throw new Error('项目列表页未出现');
  await page.fill('input[placeholder="项目名称"]', stamp);
  await page.click('button:has-text("创建")');
  await page.waitForFunction((n) => document.body.innerText.includes(n) && document.body.innerText.includes('导出视频'), stamp, { timeout: 8000 });
  entered = true;
} catch (e) { stepErr = String(e).slice(0, 200); }

// 4. TopBar 后端芯片（Full 模式应显示"后端已连接"）
await page.waitForTimeout(1000);
const chip = await page.evaluate(() => document.body.innerText.includes('后端已连接') || document.body.innerText.includes('登录'));

// 5. 后端探测结果（探测代码在页面里跑一遍）
const probe = await page.evaluate(async () => {
  try {
    const r = await fetch('/api/health');
    return await r.json();
  } catch { return { mode: 'lite' }; }
});

console.log(JSON.stringify({
  hasStore, entered, stepErr, backendChip: chip,
  probeMode: probe.mode, authRequired: probe.auth?.required ?? null,
  pageErrors: errs,
}, null, 2));

const pass = hasStore && entered && chip && probe.mode === 'full' && errs.length === 0;
console.log(pass ? 'SMOKE PASS' : 'SMOKE FAIL');
process.exit(pass ? 0 : 1);
