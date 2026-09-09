// 桌面端冒烟：preload 注入 / SQLite 项目 CRUD / providers CRUD / WebCodecs / 页面错误（用完即删）
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://localhost:9223');
const ctx = browser.contexts()[0];
// Electron 窗口的 page
let page = ctx.pages().find((p) => p.url().startsWith('app://')) || ctx.pages()[0];
await page.waitForTimeout(1500);

const out = {};
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));

// 1. preload 注入
out.preload = await page.evaluate(() => !!window.mapvideo?.desktop);

// 2. 项目 SQLite CRUD
out.projects = await page.evaluate(async () => {
  const mv = window.mapvideo;
  await mv.projects.save({ id: 'smoke-1', name: '桌面冒烟', data: { id: 'smoke-1', name: '桌面冒烟' } });
  const list = await mv.projects.list();
  const got = await mv.projects.get('smoke-1');
  await mv.projects.remove('smoke-1');
  const after = await mv.projects.list();
  return { listCount: list.length, gotName: got?.name, afterCount: after.length };
});

// 3. providers SQLite CRUD + active
out.providers = await page.evaluate(async () => {
  const mv = window.mapvideo;
  await mv.providers.upsert({ id: 'p1', kind: 'llm', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test', model: 'deepseek-chat' });
  await mv.providers.upsert({ id: 'p2', kind: 'tts', label: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1/t2a_v2', apiKey: 'k&&g', model: 'speech-02-turbo', protocol: 'minimax-t2a', voice: 'male-qn-qingse' });
  await mv.providers.setActive('llm', 'p1');
  await mv.providers.setActive('tts', 'p2');
  const list = await mv.providers.list();
  await mv.providers.remove('p1');
  await mv.providers.remove('p2');
  return { added: list.length, kinds: [...new Set(list.map((c) => c.kind))].sort() };
});

// 4. WebCodecs / WebGL2（导出能力前提）
out.codecs = await page.evaluate(async () => ({
  webcodecs: typeof window.VideoEncoder === 'function',
  webgl2: !!document.createElement('canvas').getContext('webgl2'),
}));

// 5. 项目列表页文本（Lite/桌面说明）
out.pageHead = await page.evaluate(() => document.body.innerText.slice(0, 120).replace(/\n/g, ' | '));

out.pageErrors = errs;
console.log(JSON.stringify(out, null, 2));
const pass = out.preload && out.projects.gotName === '桌面冒烟' && out.providers.added === 2 && out.codecs.webcodecs && out.codecs.webgl2;
console.log(pass ? 'DESKTOP SMOKE PASS' : 'DESKTOP SMOKE FAIL');
await browser.close();
process.exit(pass ? 0 : 1);
