// 回归：时间线轨道化（特效轨道 / 弹窗轨道 / 元素分道 / 标题芯片）
// 验证：1) 特效块按类型着色且点击打开对应页签  2) 弹窗块+标题芯片  3) 时间重叠元素自动分道（y 不同）
// 前置：Chrome --remote-debugging-port=9222 + npm run dev（改过 src 需重启 dev）
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
for (const p of ctx.pages()) await p.close().catch(() => {});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
await page.setViewportSize({ width: 1680, height: 950 });
const log = (tag, v) => console.log(tag, typeof v === 'string' ? v : JSON.stringify(v));

await page.goto('http://localhost:5173/map-video/');
await page.waitForTimeout(2500);
await page.evaluate(async () => {
  const dbs = await indexedDB.databases();
  for (const d of dbs) indexedDB.deleteDatabase(d.name);
});
await page.reload();
await page.waitForTimeout(2500);
await page.getByPlaceholder('项目名称').fill('轨道测试');
await page.getByText('创建', { exact: true }).first().click();
await page.waitForSelector('canvas', { timeout: 20000 });
await page.waitForTimeout(2000);

// 注入：3 个特效（闪光与震动时间重叠 → 特效轨道应出现第 2 道）+ 2 个弹窗（重叠 → 第 2 道）+ 标题 + 5 个时间重叠元素（→ 3 道）
const inj = await page.evaluate(async () => {
  const names = performance.getEntriesByType('resource').map((e) => e.name);
  let st = null; let ed = null;
  for (const url of names.filter((n) => n.includes('/src/stores/projectStore'))) {
    try { const m = await import(url); if (m?.useProjectStore?.getState().project) { st = m.useProjectStore; break; } } catch { /* next */ }
  }
  for (const url of names.filter((n) => n.includes('/src/stores/editorStore'))) {
    try { const m = await import(url); if (m?.useEditorStore) { ed = m.useEditorStore; break; } } catch { /* next */ }
  }
  if (!st || !ed) return { ok: false, why: 'store 未找到' };
  const s = st.getState();
  const ch = s.project.chapters[0];
  s.addScreenFx(ch.id, { id: 'fx_snow', kind: 'weather', name: '雪', startFrame: 30, endFrame: 150, weather: { type: 'snow', intensity: 0.8, wind: 0.2 }, enabled: true });
  s.addScreenFx(ch.id, { id: 'fx_shake', kind: 'screen', name: '震动', startFrame: 60, endFrame: 120, effect: { type: 'shake', intensity: 0.7 }, enabled: true });
  s.addScreenFx(ch.id, { id: 'fx_flash', kind: 'screen', name: '闪光', startFrame: 70, endFrame: 100, effect: { type: 'flash', intensity: 0.8, color: '#FFFFFF' }, enabled: true });
  s.addOverlay(ch.id, { id: 'ov_text', type: 'text', name: '文字', position: 'top', content: { type: 'text', text: { content: '渡江战役·总攻发起', fontSize: 30, color: '#FFD700', bold: true } }, startFrame: 30, endFrame: 150, animation: 'fadeIn', exitAnimation: 'fadeOut', scale: 1 });
  s.addOverlay(ch.id, { id: 'ov_list', type: 'list', name: '战役进程', position: 'bottomLeft', content: { type: 'list', list: { title: '战役进程', items: ['3月5日 渡江集结', '3月9日 总攻发起'] } }, startFrame: 45, endFrame: 160, animation: 'slideInLeft', exitAnimation: 'fadeOut', widthPct: 30 });
  s.updateChapter(ch.id, { titleStyle: { show: true, fontFamily: "'Geist','Noto Sans SC',system-ui,sans-serif", fontSize: 40, color: '#FFFFFF', weight: 700, align: 'left', vPos: 'bottom', bg: 'card', bgColor: '#0c0a09', shadow: true, showSubtitle: false } });
  // 5 个两两时间重叠的标记：0-3000 / 100-200 / 150-240 / 210-400 / 250-350 → 应分 3 道
  const mk = (i, sf, ef) => ({ id: `el_t${i}`, type: 'point', name: `标记${i}`, visible: true, locked: false, startFrame: sf, endFrame: ef, coordinates: [104.5 + i * 0.4, 31.5 + i * 0.25], shape: 'circle', color: '#4C9EFF', label: { text: `标记${i}`, color: '#FFFFFF', position: 'top' }, style: {} });
  s.addElements(ch.id, [mk(1, 0, 3000), mk(2, 100, 200), mk(3, 150, 240), mk(4, 210, 400), mk(5, 250, 350)]);
  ed.getState().setCurrentFrame(75);
  return { ok: true, elements: s.project.chapters[0].elements.length };
});
log('注入:', inj);
if (!inj.ok) { log('FAIL', inj.why); process.exit(1); }
await page.waitForTimeout(1200);

let ok = true;
const check = (tag, cond) => { ok = ok && cond; log(cond ? 'OK ' : 'FAIL', tag); };

const probe = () => page.evaluate(() => {
  const tlText = document.body.innerText;
  const btnByTitle = (kw) => [...document.querySelectorAll('button')].filter((b) => { const t = b.getAttribute('title') || ''; return t.includes(kw) && t.includes('·'); });
  const boxes = (btns) => btns.map((b) => { const r = b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; });
  return {
    hasRows: ['镜头流', '特效', '弹窗'].every((k) => tlText.includes(k)),
    hasTitleChip: [...document.querySelectorAll('button')].some((b) => (b.getAttribute('title') || '').includes('章节标题')),
    snowBlocks: boxes(btnByTitle('雪 ·')),
    shakeBlocks: boxes(btnByTitle('震动 ·')),
    flashBlocks: boxes(btnByTitle('闪光 ·')),
    popupBlocks: boxes(btnByTitle('文字 ·')).concat(boxes(btnByTitle('战役进程 ·'))),
    elMarks: boxes(btnByTitle('标记')),
  };
});

// 1) 行结构 + 特效/弹窗块存在
const d1 = await probe();
log('结构:', d1);
check('轨道行存在(镜头流/特效/弹窗)', d1.hasRows);
check('标题芯片存在', d1.hasTitleChip);
check('雪块存在', d1.snowBlocks.length === 1);
check('震动块存在', d1.shakeBlocks.length === 1);
check('闪光块存在', d1.flashBlocks.length === 1);
// 震动(60-120)与闪光(70-100)重叠 → 不同道（y 不同）
check('特效重叠自动分道(震动/闪光 y 不同)', Math.abs(d1.shakeBlocks[0].y - d1.flashBlocks[0].y) > 4);
// 文字(30-150)与战役进程(45-160)重叠 → 不同道
check('弹窗重叠自动分道', d1.popupBlocks.length === 2 && Math.abs(d1.popupBlocks[0].y - d1.popupBlocks[1].y) > 4);
// 元素 5 个分 3 道：标记1(y1) 与 标记2(y2) 与 标记3(y3) 两两不同
const ys = [...new Set(d1.elMarks.map((b) => b.y))];
check('元素分道≥3', d1.elMarks.length === 5 && ys.length >= 3);

// 截图：时间线区域 + 全页
await page.screenshot({ path: 'docs/studio-shots/v19-timeline-f75-full.png' });
const vp = page.viewportSize();
await page.screenshot({ path: 'docs/studio-shots/v19-timeline-f75.png', clip: { x: 0, y: vp.height - 300, width: vp.width, height: 300 } });

// 2) 点击特效块 → 打开特效窗口并切到天气页签
await page.locator('button[title*="雪 ·"]').first().click();
await page.waitForTimeout(600);
const dlg1 = await page.evaluate(() => document.body.innerText.includes('添加天气'));
check('点击雪块→打开天气页签', dlg1);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// 3) 点击弹窗块 → 弹窗页签
await page.locator('button[title*="战役进程 ·"]').first().click();
await page.waitForTimeout(600);
const dlg2 = await page.evaluate(() => document.body.innerText.includes('添加弹窗卡片'));
check('点击弹窗块→弹窗页签', dlg2);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

// 4) 点击元素块 → 选中元素（store selectedElementId + 右侧属性面板出现）
await page.locator('button[title*="标记3 ·"]').first().click();
await page.waitForTimeout(600);
const dlg3 = await page.evaluate(async () => {
  const names = performance.getEntriesByType('resource').map((e) => e.name);
  for (const url of names.filter((n) => n.includes('/src/stores/editorStore'))) {
    try { const m = await import(url); if (m?.useEditorStore) { const s = m.useEditorStore.getState(); return { sel: s.selectedElementId, panel: document.body.innerText.includes('大小') || document.body.innerText.includes('SIZE') }; } } catch { /* next */ }
  }
  return { sel: null, panel: false };
});
log('元素选中:', dlg3);
check('点击元素块→选中元素', dlg3.sel === 'el_t3' && dlg3.panel);

log('PageErrors:', errs.length ? errs : 'none');
log('总体:', ok && !errs.length ? 'ALL OK' : 'HAS FAIL');
page.close();
process.exit(ok && !errs.length ? 0 : 1);
