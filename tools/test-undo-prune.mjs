/**
 * test-undo-prune.mjs —— 撤销 / 重做换快照后的「选中 id 剪枝」回归
 *
 * 查的是：撤销栈换回一份旧 project 时，指向已消失元素 / 图层 / 关键帧 / 特效项的选中 id
 * 有没有跟着清掉（不清就会属性面板对着空 id 找、时间线高亮错位、Del 打空）。
 * 项目快照是**当参数传进去的假对象**，所以不读也不写用户库里的真实项目，只碰 editorStore 选中态。
 *
 * 用法（前置：桌面端带 CDP 起来，dev server 在 5173）：
 *   MV_CDP=9223 npm run electron:dev
 *   node tools/test-undo-prune.mjs
 */
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP(process.env.MV_CDP || 'http://127.0.0.1:9223');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('localhost:5173'));
if (!page) { console.error('找不到 5173 页面'); process.exit(2); }

// 页面可能还带着改代码之前的旧模块（实测报过 noSuchKey: pruneSelectionTo），先 reload 再探
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => !!window.__editorStore, null, { timeout: 60000 });
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  const es = window.__editorStore;
  if (!es) return { err: '没有 __editorStore' };
  if (typeof es.getState().pruneSelectionTo !== 'function') return { err: '页面还是旧模块（pruneSelectionTo 不在）' };

  const alive = {
    elements: [{ id: 'E1' }], layers: [{ id: 'L1' }], camera: [{}, {}, {}],
    fx: [{ id: 'F1' }], overlays: [{ id: 'O1' }],
  };
  const dead = { elements: [], layers: [], camera: [], fx: [], overlays: [] };
  const st = () => {
    const s = es.getState();
    return { el: s.selectedElementId, layer: s.selectedLayerId, kf: s.selectedKeyframeIdx, fx: s.fxSelId, panel: s.panelMode };
  };
  const pickAll = () => {
    const s = es.getState();
    s.selectElement('E1'); s.selectLayer('L1', 'marker'); s.selectKeyframe(2); s.openFx('weather', 'F1');
    return st();
  };
  const r = {};
  // ① 全都活着 → 一个都不该清
  r.before = pickAll();
  es.getState().pruneSelectionTo(alive);
  r.aliveKept = st();
  // ② 关键帧越界、且面板正停在「视角属性」→ 清 idx 并把面板收起
  es.getState().selectKeyframe(2);
  es.getState().pruneSelectionTo({ ...alive, camera: [{}, {}] });
  r.kfOverflow = st();
  // ③ 弹窗项存的是 overlays 里的 id → 不能被「fx 数组里没它」误清
  es.getState().openFx('popup', 'O1');
  es.getState().pruneSelectionTo({ ...alive, fx: [] });
  r.overlayKept = st();
  // ④ 快照里什么都没有 → 四项全清
  pickAll();
  es.getState().pruneSelectionTo(dead);
  r.deadPruned = st();
  // ⑤ 传 null（撤销到没有项目的快照）不能抛
  let nullThrew = null;
  try { es.getState().pruneSelectionTo(null); } catch (e) { nullThrew = String(e); }
  r.nullThrew = nullThrew;
  // 还原：选中态与「写入目标」都清回干净样子
  es.getState().setTargetLayer('marker', null);
  es.getState().resetSelection();
  r.after = st();
  r.targetLayers = JSON.stringify(es.getState().targetLayers);
  return r;
});

console.log(JSON.stringify(out, null, 1));
if (out.err) { console.log('FAIL —— ' + out.err); process.exit(1); }
const sel = (o) => `${o.el}/${o.layer}/kf${o.kf}/fx${o.fx}/${o.panel}`;
const checks = {
  '①全活着→不清': sel(out.aliveKept) === sel(out.before),
  '②越界关键帧清掉': out.kfOverflow.kf === null && out.kfOverflow.panel === 'none',
  '②其它不受影响': out.kfOverflow.el === 'E1' && out.kfOverflow.layer === 'L1',
  '③弹窗 id 不误清': out.overlayKept.fx === 'O1',
  '④快照空则全清': out.deadPruned.el === null && out.deadPruned.layer === null
    && out.deadPruned.fx === null && out.deadPruned.kf === null,
  '⑤null 不抛': out.nullThrew === null,
  '⑥现场已还原': out.after.el === null && out.after.layer === null && out.targetLayers === '{}',
};
for (const [k, v] of Object.entries(checks)) console.log(`${v ? 'ok  ' : 'FAIL'} ${k}`);
const pass = Object.values(checks).every(Boolean);
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
