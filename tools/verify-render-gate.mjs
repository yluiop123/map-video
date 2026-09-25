/**
 * verify-render-gate.mjs — 逐帧渲染门禁（map-renderer 的 `isFrameStatic`）的回归
 *
 * 门禁的失效模式很安静：该重画的元素被跳过 → 画面停在最后一次真跑的那一帧，
 * 什么都不报错。所以这里不看像素，直接断言地图状态：
 *   1 静态点（被跳过的那类）还在显示
 *   2 gif：`pt-vis-*` 位图的像素逐帧在变
 *   3 模型自转：`pt-vis-*` 的 imageId（含角度）逐帧在变
 *   4 透明度关键帧：paint 值逐帧在变
 *   5 沿线移动的图标：source 里的坐标逐帧在变
 *   6 改元素属性 → 下一帧就是新值（换引用即放行）
 * 自己建一个 6 元素的临时项目 `__gate-check`，跑完删掉，不碰用户数据。
 *
 *   node tools/verify-render-gate.mjs
 * 前置：MV_CDP=9223 MV_BENCH=1 的桌面端、窗口在前台、编辑器已打开（项目随意）。
 * 图层命名坑：circle 形态的主图层是 `point-layer-<id>-shape`（symbol），裸的
 * `point-layer-<id>` 是那层不显示的 circle 层；gif/model 走 `point-layer-<id>-icon`。
 */
import { chromium } from 'playwright-core';
const cdp = process.env.MV_CDP || 'http://127.0.0.1:9223';
const NAME = '__gate-check';
const browser = await chromium.connectOverCDP(cdp);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('localhost:5173'));

const built = await page.evaluate(async (name) => {
  const st = window.__projectStore.getState();
  const list = await window.mapvideo.projects.list();
  const old = (list || []).find((p) => p.name === name);
  if (old) await st.deleteProject(old.id);
  await st.createProject(name);
  const p = window.__projectStore.getState().project;
  const end = p.endFrame;
  const base = (id, extra) => ({
    id, name: id, visible: true, locked: false, startFrame: 0, endFrame: end, style: {}, ...extra,
  });
  const els = [
    base('gc-static', { type: 'point', coordinates: [100.0, 34.0], shape: 'circle', color: '#FF3B30' }),
    base('gc-gif', { type: 'point', coordinates: [102.0, 34.0], shape: 'gif', builtinId: 'gif:radar' }),
    base('gc-model', { type: 'point', coordinates: [104.0, 34.0], shape: 'model', builtinId: 'model:drone', visualMeta: { autoRotate: 120 } }),
    base('gc-opacity', {
      type: 'point', coordinates: [106.0, 34.0], shape: 'circle', color: '#3B82F6',
      style: { opacity: [{ frame: 0, value: 1 }, { frame: 300, value: 0.05 }] },
    }),
    base('gc-line', {
      type: 'line', coordinates: [[100, 32], [108, 32]], lineType: 'straight', lineWidth: 6, lineColor: '#22C55E',
      drawProgress: [], showIcon: true, animEffect: 'move', moveStartFrame: 0, moveEndFrame: 300,
    }),
  ];
  window.__projectStore.getState().addElements(els);
  window.__editorStore.getState().setPlayRate?.(1);
  window.__editorStore.getState().setIsPlaying(false);
  return { end, count: window.__projectStore.getState().project.elements.length };
}, NAME);
await page.waitForTimeout(7000);

const at = async (frame) => page.evaluate((f) => {
  window.__editorStore.getState().setCurrentFrame(f);
  return f;
}, frame);

const snap = () => page.evaluate(() => {
  const map = window.__sharedMap.get();
  const style = map.getStyle();
  const layers = style.layers || [];
  const layerOf = (id) => layers.find((l) => l.id === id);
  const iconAt = (id) => {
    const l = layerOf(id);
    return l && l.layout ? String(l.layout['icon-image']) : null;
  };
  const hashOf = (imgId) => {
    const img = imgId && map.getImage(String(imgId));
    const arr = img && (img.data && img.data.data ? img.data.data : img.data);
    if (!arr) return null;
    let h = 0;
    for (let i = 0; i < arr.length; i += 101) h = ((h << 5) - h + arr[i]) | 0;
    return h;
  };
  return {
    frame: window.__editorStore.getState().currentFrame,
    // circle 形态的主图层是 `-shape`（symbol），裸 `point-layer-<id>` 是那层不显示的 circle 层
    staticLayer: (() => {
      const l = layerOf('point-layer-gc-static-shape');
      return l ? { vis: (l.layout && l.layout.visibility) || 'visible', icon: l.layout && l.layout['icon-image'] } : null;
    })(),
    // gif / model 走位图管线：`-icon` 层，imageId 里带（或不带）角度
    gifLayer: layerOf('point-layer-gc-gif-icon') ? 'point-layer-gc-gif-icon' : null,
    gifImage: iconAt('point-layer-gc-gif-icon'),
    gifHash: hashOf(iconAt('point-layer-gc-gif-icon')),
    modelImage: iconAt('point-layer-gc-model-icon'),
    opacityPaint: (() => {
      const l = layerOf('point-layer-gc-opacity');
      return l && l.paint ? l.paint['circle-opacity'] ?? null : null;
    })(),
    lineIconCoord: (() => {
      const src = map.getSource('line-move-src-gc-line');
      const d = src && src._data;                     // v5 里 GeoJSON 挂在 _data.geojson
      const gj = d && (d.geojson || d);
      const f = gj && gj.features && gj.features[0];
      return f && f.geometry.type === 'Point' ? f.geometry.coordinates.slice() : null;
    })(),
  };
});

await at(60); await new Promise((r) => setTimeout(r, 900));
const a = await snap();
await at(180); await new Promise((r) => setTimeout(r, 900));
const b = await snap();

const edit = await page.evaluate(async () => {
  const map = window.__sharedMap.get();
  const st = window.__projectStore.getState();
  st.updateElement('gc-static', { color: '#A855F7' });
  await new Promise((r) => setTimeout(r, 900));
  const layers = map.getStyle().layers || [];
  const circle = layers.find((x) => x.id === 'point-layer-gc-static');
  const shape = layers.find((x) => x.id === 'point-layer-gc-static-shape');
  return {
    circleColor: circle && circle.paint ? circle.paint['circle-color'] : null,
    shapeIcon: shape && shape.layout ? String(shape.layout['icon-image']) : null,
  };
});

const chk = (ok) => (ok ? 'PASS' : 'FAIL');
const clean = await page.evaluate(async (name) => {
  const st = window.__projectStore.getState();
  const list = await window.mapvideo.projects.list();
  const hit = (list || []).find((p) => p.name === name);
  if (hit) await st.deleteProject(hit.id);
  return { removed: !!hit };
}, NAME);
console.log(JSON.stringify({ built, a, b, edit, clean }, null, 1));
console.log([
  `${chk(a.staticLayer && a.staticLayer.vis !== 'none' && !!a.staticLayer.icon)}  1 静态点在显示（${JSON.stringify(a.staticLayer)}）`,
  `${chk(a.gifHash !== null && b.gifHash !== null && a.gifHash !== b.gifHash)}  2 gif 像素逐帧在变（${a.gifHash} → ${b.gifHash}）`,
  `${chk(!!a.modelImage && !!b.modelImage && a.modelImage !== b.modelImage)}  3 模型自转换图（${a.modelImage} → ${b.modelImage}）`,
  `${chk(typeof a.opacityPaint === 'number' && a.opacityPaint !== b.opacityPaint)}  4 透明度关键帧继续走（${a.opacityPaint} → ${b.opacityPaint}）`,
  `${chk(a.lineIconCoord && b.lineIconCoord && a.lineIconCoord.join() !== b.lineIconCoord.join())}  5 沿线图标继续动（${JSON.stringify(a.lineIconCoord)} → ${JSON.stringify(b.lineIconCoord)}）`,
  `${chk(edit.circleColor === '#A855F7' && edit.shapeIcon === 'pt-dot-A855F7')}  6 改属性下一帧生效（${JSON.stringify(edit)}）`,
].join('\n'));
await browser.close();
