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

// 3. providers SQLite：一行 = 一条实例（同 id 连存两次是覆盖不是加行），tpl_id 是真外键
out.providers = await page.evaluate(async () => {
  const mv = window.mapvideo;
  const beforeP = await mv.providers.list();
  const beforeT = await mv.templates.list();
  const tplId = 'smoke-tpl';
  const tpl = { id: tplId, name: '冒烟模板', category: 'llm', instanceParams: [], sync: { submit: { path: '${baseUrl}/x', method: 'POST', body: {} } } };
  await mv.templates.save(tpl);
  const inst = (apiKey) => ({ id: 'smoke-prov', tplId, name: '冒烟实例', sync: true, values: { instance: { baseUrl: 'https://x', apiKey }, requests: {} } });
  await mv.providers.upsert(inst('sk-a'));
  await mv.providers.upsert(inst('sk-b'));
  const rows = (await mv.providers.list()).filter((x) => x.id === 'smoke-prov');
  const row = rows[0];
  const okShape = rows.length === 1 && row.tplId === tplId && row.values.instance.apiKey === 'sk-b';
  // 模板被实例引用时删不掉（真外键）；清场顺序必须是先实例后模板
  const fkBlocks = await mv.templates.remove(tplId).then(() => false, () => true);
  await mv.providers.remove('smoke-prov');
  await (beforeT.some((t) => t.id === tplId) ? mv.templates.save(tpl) : mv.templates.remove(tplId));
  return { okShape, fkBlocks, 实例数回到: (await mv.providers.list()).length, 跑之前就有: beforeP.length };
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
const pass = out.preload && out.projects.gotName === '桌面冒烟' && out.providers.okShape && out.providers.fkBlocks && out.codecs.webcodecs && out.codecs.webgl2;
console.log(pass ? 'DESKTOP SMOKE PASS' : 'DESKTOP SMOKE FAIL');
await browser.close();
process.exit(pass ? 0 : 1);
