// 回归：特效窗口（天气/画面/弹窗/标题）编辑器预览 + 数据注入
// 验证：1) 云层散开遮幅→消散  2) 雪+弹窗+标题同帧可见  3) 震动=舞台 transform  4) 结束后全部消失
// 前置：Chrome --remote-debugging-port=9222 + npm run dev（改过 src 需重启 dev）
import { chromium } from 'playwright-core';
import { getWorkPage } from './pw-page.mjs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await getWorkPage(ctx);
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
const consoleLog = [];
page.on('console', (msg) => { const t = `[${msg.type()}] ${msg.text().slice(0, 160)}`; if (/error|warn/.test(t)) consoleLog.push(t); if (consoleLog.length > 30) consoleLog.shift(); });
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
await page.getByPlaceholder('项目名称').fill('特效测试');
await page.getByText('创建', { exact: true }).first().click();
await page.waitForSelector('canvas', { timeout: 20000 });
await page.waitForTimeout(2000);
await page.evaluate(() => window.__sharedMap.get().jumpTo({ center: [105.0, 32.0], zoom: 7 }));
await page.waitForTimeout(800);

// 注入：雪 + 云层散开 + 震动 + 文字弹窗 + 文字块 + 标题样式
const inj = await page.evaluate(async () => {
  const names = performance.getEntriesByType('resource').map((e) => e.name);
  let st = null;
  for (const url of names.filter((n) => n.includes('/src/stores/projectStore'))) {
    try { const m = await import(url); if (m?.useProjectStore?.getState().project) { st = m.useProjectStore; break; } } catch { /* next */ }
  }
  if (!st) return { ok: false, why: 'projectStore 未找到' };
  const s = st.getState();
  if (!s.addScreenFx) return { ok: false, why: 'addScreenFx 不存在（store 未更新？）' };
  const ch = s.project.chapters[0];
  s.addScreenFx(ch.id, { id: 'fx_snow', kind: 'weather', name: '雪', startFrame: 30, endFrame: 150, weather: { type: 'snow', intensity: 0.85, wind: 0.2 }, enabled: true });
  s.addScreenFx(ch.id, { id: 'fx_cloud', kind: 'screen', name: '云层散开', startFrame: 0, endFrame: 90, effect: { type: 'cloudReveal', intensity: 1 }, enabled: true });
  s.addScreenFx(ch.id, { id: 'fx_shake', kind: 'screen', name: '震动', startFrame: 60, endFrame: 120, effect: { type: 'shake', intensity: 0.9 }, enabled: true });
  s.addScreenFx(ch.id, { id: 'fx_vig', kind: 'screen', name: '暗角', startFrame: 100, endFrame: 165, effect: { type: 'vignette', intensity: 1 }, enabled: true });
  s.addOverlay(ch.id, { id: 'ov_text', type: 'text', name: '文字', position: 'top', content: { type: 'text', text: { content: '渡江战役·总攻发起', fontSize: 30, color: '#FFD700', bold: true } }, startFrame: 30, endFrame: 150, animation: 'fadeIn', exitAnimation: 'fadeOut', scale: 1 });
  s.addOverlay(ch.id, { id: 'ov_list', type: 'list', name: '文字块', position: 'bottomLeft', content: { type: 'list', list: { title: '战役进程', items: ['3月5日 渡江集结', '3月8日 炮火准备', '3月9日 总攻发起'] } }, startFrame: 45, endFrame: 160, animation: 'slideInLeft', exitAnimation: 'fadeOut', widthPct: 30 });
  s.updateChapter(ch.id, { titleStyle: { show: true, fontFamily: "'Geist','Noto Sans SC',system-ui,sans-serif", fontSize: 40, color: '#FFFFFF', weight: 700, align: 'left', vPos: 'bottom', bg: 'card', bgColor: '#0c0a09', shadow: true, showSubtitle: false } });
  return { ok: true };
});
log('注入:', inj);
if (!inj.ok) { log('FAIL', inj.why); process.exit(1); }

const setFrame = (f) => page.evaluate(async (f) => {
  const names = performance.getEntriesByType('resource').map((e) => e.name);
  for (const url of names.filter((n) => n.includes('/src/stores/editorStore'))) {
    try { const m = await import(url); if (m.useEditorStore) { m.useEditorStore.getState().setCurrentFrame(f); break; } } catch { /* next */ }
  }
}, f);
const refocus = () => page.evaluate(() => window.__sharedMap.get().jumpTo({ center: [105.0, 32.0], zoom: 7 }));
const dom = () => page.evaluate(() => ({
  canvases: document.querySelectorAll('canvas').length,
  hasText1: document.body.innerText.includes('渡江战役·总攻发起'),
  hasList: document.body.innerText.includes('战役进程'),
  hasTitle: document.body.innerText.includes('第一章'),
  hasShake: [...document.querySelectorAll('div')].some((el) => /translate\(-?\d+(\.\d+)?px/.test(el.getAttribute('style') || '')),
}));

let ok = true;
const check = (tag, cond) => { ok = ok && cond; log(cond ? 'OK ' : 'FAIL', tag); };

// 基线（f=200，全部特效已结束）
await setFrame(200);
await page.waitForTimeout(500);
const base = await dom();
log('基线 f=200:', base);
check('f=200 弹窗已消失', !base.hasText1 && !base.hasList);
check('f=200 标题仍显示', base.hasTitle);

// f=8 云层遮幅
await setFrame(8);
await page.waitForTimeout(500);
const d8 = await dom();
log('f=8:', d8);
check('f=8 云层画布存在(比基线多canvas)', d8.canvases > base.canvases);
// 云层重做回归：起点=分离的半透明云层（云间留缝可见地图、整体半透明、不成整片白幕）
const cloudStat = await page.evaluate(() => {
  const cv = [...document.querySelectorAll('canvas')].find((c) => (c.parentElement?.style?.zIndex || '') === '12');
  if (!cv) return null;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  let cov = 0, gap = 0, sum = 0, n = 0;
  for (let gy = 0; gy < 6; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      const x = Math.round((gx + 0.5) * cv.width / 8), y = Math.round((gy + 0.5) * cv.height / 6);
      const a = ctx.getImageData(x, y, 1, 1).data[3];
      sum += a; n++;
      if (a > 60) cov++;
      if (a < 45) gap++;
    }
  }
  return { cov: cov / n, gap: gap / n, avg: sum / n };
});
log('f=8 cloudStat:', cloudStat);
check('f=8 云层存在(覆盖>12%)', !!cloudStat && cloudStat.cov > 0.12);
check('f=8 云间留缝(近透明点>6%)', !!cloudStat && cloudStat.gap > 0.06);
check('f=8 云层半透明(平均α<175)', !!cloudStat && cloudStat.avg < 175);

// 强度开关回归：intensity 0.1 vs 1.0 起始云层浓度必须明显不同
const cloudAvg = () => page.evaluate(() => {
  const cv = [...document.querySelectorAll('canvas')].find((c) => (c.parentElement?.style?.zIndex || '') === '12');
  if (!cv) return null;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  let sum = 0, n = 0;
  for (let gy = 0; gy < 6; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      sum += ctx.getImageData(Math.round((gx + 0.5) * cv.width / 8), Math.round((gy + 0.5) * cv.height / 6), 1, 1).data[3];
      n++;
    }
  }
  return sum / n;
});
const setCloudIntensity = (v) => page.evaluate(async (v) => {
  const names = performance.getEntriesByType('resource').map((e) => e.name);
  for (const url of names.filter((n) => n.includes('/src/stores/projectStore'))) {
    try {
      const m = await import(url);
      if (m?.useProjectStore?.getState().project) {
        const s = m.useProjectStore.getState();
        s.updateScreenFx(s.project.chapters[0].id, 'fx_cloud', { effect: { type: 'cloudReveal', intensity: v } });
        break;
      }
    } catch { /* next */ }
  }
}, v);
await setCloudIntensity(0.1);
await page.waitForTimeout(400);
const avgLow = await cloudAvg();
await setCloudIntensity(1);
await page.waitForTimeout(400);
const avgHigh = await cloudAvg();
log('强度对比: avg(0.1)=', avgLow, 'avg(1)=', avgHigh);
check('f=8 强度生效(0.1 明显淡于 1.0)', !!avgLow && !!avgHigh && avgHigh - avgLow > 25);
await setCloudIntensity(0.6);
await page.waitForTimeout(400);
await refocus(); await page.waitForTimeout(700);
await page.screenshot({ path: 'docs/studio-shots/v18-fx-f08-cloud.png' });

// f=40 雪+弹窗+标题（云层未散尽）
await setFrame(40);
await page.waitForTimeout(500);
const d40 = await dom();
log('f=40:', d40);
check('f=40 文字弹窗可见', d40.hasText1);
check('f=40 章节标题可见', d40.hasTitle);
await refocus(); await page.waitForTimeout(700);
await page.screenshot({ path: 'docs/studio-shots/v18-fx-f40.png' });

// f=75 震动 + 文字块
await setFrame(75);
await page.waitForTimeout(500);
const d75 = await dom();
log('f=75:', d75);
check('f=75 震动 transform 生效', d75.hasShake);
check('f=75 文字块可见', d75.hasList);
check('f=75 文字弹窗可见', d75.hasText1);
// 天气时长修复回归：雪(30-150) 在 f=75 应实际绘制粒子（天气画布 = zIndex 8 的 canvas）
const snowVis = await page.evaluate(() => {
  const cv = [...document.querySelectorAll('canvas')].find((c) => (c.parentElement?.style?.zIndex || '') === '8');
  if (!cv) return false;
  const ctx = cv.getContext('2d');
  if (!ctx) return false;
  const x = Math.max(0, (cv.width >> 1) - 60), y = Math.max(0, (cv.height >> 1) - 60);
  const d = ctx.getImageData(x, y, 120, 120).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++;
  return n > 30;
});
check('f=75 雪粒子实际绘制(天气时长修复)', snowVis);
await refocus(); await page.waitForTimeout(700);
await page.screenshot({ path: 'docs/studio-shots/v18-fx-f75.png' });

// f=140 震动已停、雪未停、暗角激活
await setFrame(140);
await page.waitForTimeout(500);
const d140 = await dom();
log('f=140:', d140);
check('f=140 震动已停', !d140.hasShake);
check('f=140 弹窗仍在', d140.hasText1);
// 暗角强度回归：intensity=1 时中心亮区半径应缩到 7%
const vig = await page.evaluate(() => [...document.querySelectorAll('div')].some((el) => {
  const s = el.getAttribute('style') || '';
  return s.includes('radial-gradient') && s.includes(' 7%');
}));
check('f=140 暗角强化(中心亮区 7%)', vig);
await refocus(); await page.waitForTimeout(700);
await page.screenshot({ path: 'docs/studio-shots/v19-fx-f140-vignette.png' });

log('console 尾部:', consoleLog.slice(-6));
log('PageErrors:', errs.length ? errs : 'none');
log('总体:', ok && !errs.length ? 'ALL OK' : 'HAS FAIL');
page.close();
process.exit(ok && !errs.length ? 0 : 1);
