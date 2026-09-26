// 一次性：用他库里的实例跑异步生图 —— 提交拿任务号 → 按当前配置查询（看产物形式有没有被消费）→ 改回 url 并补产物路径 → 再查同一个任务号。用完即删
import { chromium } from 'playwright-core';
import { getWorkPage } from './pw-page.mjs';

const b = await chromium.connectOverCDP('http://localhost:9223');
const page = await getWorkPage(b.contexts()[0]);

/** 遮罩会挡 Playwright 的命中测试，这里全用页内派发（React 受控输入走原生 setter + input 事件） */
const clickIn = (sel, text) => page.evaluate(({ sel, text }) => {
  const host = document.querySelector(sel);
  if (!host) return 'no host';
  const hit = [...host.querySelectorAll('button,[role="tab"]')].find((x) => (x.textContent || '').trim() === text);
  if (!hit) return `no button「${text}」（可选：${[...host.querySelectorAll('button,[role="tab"]')].map((x) => x.textContent?.trim()).filter(Boolean).slice(0, 24).join(' / ')}）`;
  hit.click();
  return 'clicked';
}, { sel, text });

const setReact = (sel, val) => page.evaluate(({ sel, val }) => {
  const el = document.querySelector(sel);
  if (!el) return 'no input';
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'set';
}, { sel, val });

const readOut = () => page.evaluate(() => [...document.querySelectorAll('[role="dialog"] pre')].pop()?.innerText ?? '');

const openDialogOnImage = async () => {
  await page.evaluate(() => location.reload());
  await page.waitForTimeout(7000);
  await page.evaluate(async () => {
    const st = window.__projectStore.getState();
    if (!st.project) {
      const list = await window.mapvideo.projects.list();
      await st.loadProject(list.find((x) => !x.name.startsWith('__'))?.id ?? list[0].id);
    }
  });
  await page.waitForTimeout(3000);
  await clickIn('body', '设置 · AI');
  await page.waitForTimeout(400);
  await page.evaluate(() => document.querySelector('button[title="设置 · AI"]')?.click());
  await page.waitForTimeout(1600);
  await clickIn('[role="dialog"]', '图片生成');
  await page.waitForTimeout(900);
  await clickIn('[role="dialog"]', '千问 文生图');
  await page.waitForTimeout(900);
};

const runTab = async (tab, fillVal) => {
  console.log(`  切到「${tab}」:`, await clickIn('[role="dialog"]', tab));
  await page.waitForTimeout(800);
  if (fillVal !== undefined) {
    await page.evaluate((v) => {
      const bs = [...document.querySelectorAll('[role="dialog"] input')].filter((x) => x.className.includes('w-40'));
      const el = bs[bs.length - 1];
      if (!el) return;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, fillVal);
  }
  console.log('  点试调用:', await clickIn('[role="dialog"]', '▶ 试调用'));
  const t0 = Date.now();
  let txt = '';
  while (Date.now() - t0 < 120000) {
    txt = await readOut();
    if (txt && !txt.includes('"method"')) break;
    await page.waitForTimeout(2500);
  }
  return txt;
};

await openDialogOnImage();
const sub = await runTab('提交');
console.log('① 异步提交回显:\n' + sub.slice(0, 220));
const taskId = (sub.match(/"taskId":\s*"([^"]+)"/) ?? [])[1] ?? '';
if (!taskId) { await b.close(); throw new Error('没拿到任务号'); }

// 图要排队：查询这一格反复打同一个任务号，直到它给出「产物取不到」或成功（这同时是「产物形式有没有被消费」的证据）
let q1 = '';
for (let i = 0; i < 12; i += 1) {
  q1 = await runTab('查询', taskId);
  if (/产物取不到|HTTP \d{3} →/.test(q1)) break;
  console.log(`  第 ${i + 1} 次查询还没到取产物那一步（${q1.slice(0, 60).replace(/\n/g, ' ')}），20 秒后再问`);
  await page.waitForTimeout(20000);
}
console.log('② 查询（他当前配置：artifact=base64、产物路径没填）:\n' + q1.slice(0, 320));

await page.evaluate(async (tid) => {
  const t = (await window.mapvideo.templates.list()).find((x) => x.id === 'qwen-image');
  t.caps = { ...t.caps, artifact: 'url' };
  t.async.query = { ...t.async.query, outputs: { ...t.async.query.outputs, fileRef: 'output.choices[0].message.content[0].image' } };
  await window.mapvideo.templates.save(t);
  const i = (await window.mapvideo.providers.list()).find((x) => x.id === 'prov_qwen_image');
  i.values.requests['async.query'] = { ...(i.values.requests['async.query'] ?? {}), taskId: tid };
  await window.mapvideo.providers.upsert(i);
}, taskId);

await openDialogOnImage();
const q2 = await runTab('查询', taskId);
console.log('③ 查询（artifact=url + 按实测补上产物路径）:\n' + q2.slice(0, 340));
await b.close();
