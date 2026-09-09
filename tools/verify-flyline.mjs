// 验证：flyMode「屏幕平移」实现——路线/箭头/图标的几何与动画和正常情况完全一致，
// 仅靠 line/icon/fill-translate(anchor=viewport) 悬停到原路线上方，不做任何投影计算。
// 注意：queryRenderedFeatures 不把 translate 计入命中（按源几何测试），故用确定性检查：
//   1) 线体源数据 === 注入坐标（飞行零改动几何，与正常情况完全一样）
//   2) paint 读回：line/icon/fill-translate = [0,-H]、anchor = viewport（H=64×剖面(r)）
//   3) 图标锚点（源数据）：在路径上（弧长插值，屏幕偏差 <3px）
//   4) 箭头图标锚点：在 from→to 线性位置上，且在（未平移的）箭身内
// 前置：Chrome --remote-debugging-port=9222；dev server 已启动
// 用法：node tools/verify-flyline.mjs   （重复运行会先清理上次注入的 verify-fly-* 元素）
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().filter((p) => p.url().includes('localhost:5173'))[0] || (await ctx.newPage());
await page.bringToFront();
const errs = [];
page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message));

await page.goto('http://localhost:5173/map-video/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);
const listVisible = await page.getByText('最近项目').isVisible({ timeout: 2500 }).catch(() => false);
if (listVisible) { await page.locator('.space-y-2 > div').first().click(); await page.waitForTimeout(5000); }

// 相机摆到验证区域
await page.evaluate(() => {
  const map = window.__sharedMap?.get?.();
  if (map) map.jumpTo({ center: [106.2, 31.7], zoom: 6.5, pitch: 0, bearing: 0 });
});
await page.waitForTimeout(800);

// 清理上次残留 + 注入 flyMode 路线（3 转折点）与 flyMode 燕尾箭头；同时清空章节相机关键帧
// （否则 setCurrentFrame 会把相机拽回章节关键帧 zoom4，37~64px 偏移在 zoom4 下与路线本身重叠无法验证）
const injected = await page.evaluate(async () => {
  const ps = await import('/map-video/src/stores/projectStore.ts');
  const es = await import('/map-video/src/stores/editorStore.ts');
  const st = ps.useProjectStore.getState();
  const project = st.project;
  if (!project) return 'no-project';
  for (const c of project.chapters) {
    for (const el of [...c.elements]) {
      if (el.id.startsWith('verify-fly-')) st.deleteElement(c.id, el.id);
    }
  }
  const esState = es.useEditorStore.getState();
  const chapterId = esState.selectedChapterId || project.chapters[0].id;
  const chapter = project.chapters.find((c) => c.id === chapterId) || project.chapters[0];
  st.updateChapter(chapter.id, { camera: [] });
  const fps = project.globalConfig?.defaultFPS || 30;
  const start = chapter.startFrame ?? 0;
  const dur = 10 * fps;
  const ts = Date.now().toString(36);
  const lineEl = {
    id: 'verify-fly-' + ts + '-l', name: '飞行平移验证', visible: true, locked: false, style: {},
    type: 'line',
    coordinates: [[104.0, 30.0], [106.0, 33.2], [108.5, 30.6]],
    drawProgress: [{ frame: start, value: 1 }],
    startFrame: start, endFrame: start + dur,
    animEffect: 'move', moveStartFrame: start, moveEndFrame: start + dur,
    showIcon: true, uniformMove: true, flyMode: true,
    lineWidth: 6, lineColor: '#FF3300',
  };
  const arrowEl = {
    id: 'verify-fly-' + ts + '-a', name: '飞行平移验证-箭头', visible: true, locked: false, style: {},
    type: 'arrow', from: [104.3, 30.2], to: [107.8, 32.8], arrowType: 'swallowtail',
    width: 40, color: '#E23B3B', progress: [{ frame: start, value: 1 }],
    startFrame: start, endFrame: start + dur,
    animEffect: 'move', moveStartFrame: start, moveEndFrame: start + dur,
    showIcon: true, flyMode: true,
  };
  st.addElements(chapter.id, [lineEl, arrowEl]);
  es.useEditorStore.getState().setCurrentFrame(start + Math.round(dur / 2));
  return 'ok';
});
console.log('inject:', injected);
await page.waitForTimeout(1500);
await page.screenshot({ path: 'docs/studio-shots/verify-fly-a-flat.png' });

// 倾斜 + 旋转（用户实际场景：老实现在此视角线/图标会飘到路线旁边）
await page.evaluate(() => {
  const map = window.__sharedMap?.get?.();
  if (map) map.jumpTo({ center: [106.2, 31.7], zoom: 6.5, pitch: 52, bearing: 28 });
});
await page.waitForTimeout(1200);
await page.screenshot({ path: 'docs/studio-shots/verify-fly-b-pitch.png' });

// —— 确定性量化检测 ——
const measureAt = async (ratios, tag) => {
  const rows = [];
  for (const r of ratios) {
    await page.evaluate((f) => (async () => {
      const ps = await import('/map-video/src/stores/projectStore.ts');
      const es = await import('/map-video/src/stores/editorStore.ts');
      const project = ps.useProjectStore.getState().project;
      const chapter = project.chapters.find((c) => c.id === (es.useEditorStore.getState().selectedChapterId || project.chapters[0].id)) || project.chapters[0];
      const fps = project.globalConfig?.defaultFPS || 30;
      es.useEditorStore.getState().setCurrentFrame(chapter.startFrame + Math.round(10 * fps * f));
    })(), r);
    await page.waitForTimeout(700);
    const res = await page.evaluate(async () => {
      const ps = await import('/map-video/src/stores/projectStore.ts');
      const es = await import('/map-video/src/stores/editorStore.ts');
      const project = ps.useProjectStore.getState().project;
      const chapter = project.chapters.find((c) => c.id === (es.useEditorStore.getState().selectedChapterId || project.chapters[0].id)) || project.chapters[0];
      const l = chapter.elements.find((e) => e.id.startsWith('verify-fly-') && e.type === 'line');
      const a = chapter.elements.find((e) => e.id.startsWith('verify-fly-') && e.type === 'arrow');
      return { l: l?.id, a: a?.id };
    });
    const dev = await page.evaluate(({ li, ai, r }) => (async () => {
      const map = window.__sharedMap?.get?.();
      if (!map) return { error: 'no map' };
      const FLY = 64, RAMP = 0.18;
      const ss = (t) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };
      const fly01 = (p) => { const x = Math.max(0, Math.min(1, p || 0)); return x < RAMP ? ss(x / RAMP) : x > 1 - RAMP ? ss((1 - x) / RAMP) : 1; };
      const H = fly01(r) * FLY;
      const getData = async (src) => { const s = map.getSource(src); return s ? await s.getData() : null; };
      const fmt = (v) => (Array.isArray(v) ? v.map((x) => +(+x).toFixed(1)) : v);
      const paintOf = (layer, prop) => { try { return fmt(map.getPaintProperty(layer, prop)); } catch { return undefined; } };

      // 1) 线体源数据 === 注入坐标（飞行零改动几何）
      const lineData = await getData('line-' + li);
      const injectedCoords = [[104.0, 30.0], [106.0, 33.2], [108.5, 30.6]];
      const lineCoords = lineData?.features?.[0]?.geometry?.coordinates || [];
      const lineDataExact = JSON.stringify(lineCoords) === JSON.stringify(injectedCoords);

      // 2) paint 读回：各图层 translate=[0,-H]、anchor=viewport
      const paint = {
        lineTranslate: paintOf('line-layer-' + li, 'line-translate'),
        lineAnchor: paintOf('line-layer-' + li, 'line-translate-anchor'),
        hitTranslate: paintOf('line-hit-' + li, 'line-translate'),
        iconTranslate: paintOf('line-move-layer-' + li, 'icon-translate'),
        iconAnchor: paintOf('line-move-layer-' + li, 'icon-translate-anchor'),
        arrowBodyTranslate: paintOf('arrow-layer-' + ai, 'fill-translate'),
        arrowBodyAnchor: paintOf('arrow-layer-' + ai, 'fill-translate-anchor'),
        arrowIconTranslate: paintOf('arrow-move-layer-' + ai, 'icon-translate'),
        arrowIconAnchor: paintOf('arrow-move-layer-' + ai, 'icon-translate-anchor'),
      };

      // 3) 路线图标锚点：应在注入路径的弧长 r 处（haversine 弧长插值近似 turf.along）
      const R = 6371008.8, rad = Math.PI / 180;
      const hav = (a, b) => { const dy = (b[1] - a[1]) * rad, dx = (b[0] - a[0]) * rad; const s = Math.sin(dy / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dx / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
      const segs = [hav(injectedCoords[0], injectedCoords[1]), hav(injectedCoords[1], injectedCoords[2])];
      const total = segs[0] + segs[1];
      const groundAt = (t) => { const d = total * Math.max(0, Math.min(1, t)); if (d <= segs[0]) { const f = d / segs[0]; return [injectedCoords[0][0] + (injectedCoords[1][0] - injectedCoords[0][0]) * f, injectedCoords[0][1] + (injectedCoords[1][1] - injectedCoords[0][1]) * f]; } const f = (d - segs[0]) / segs[1]; return [injectedCoords[1][0] + (injectedCoords[2][0] - injectedCoords[1][0]) * f, injectedCoords[1][1] + (injectedCoords[2][1] - injectedCoords[1][1]) * f]; };
      const iconData = await getData('line-move-src-' + li);
      const anchor = iconData?.features?.[0]?.geometry?.coordinates;
      let iconPosDev = -1;
      if (anchor) {
        const p = map.project(anchor), e = map.project(groundAt(r));
        iconPosDev = Math.hypot(p.x - e.x, p.y - e.y);
      }

      // 4) 箭头图标锚点：应在 from→to 线性 r 处，且在（未平移的）箭身体内
      const aIconData = await getData('arrow-move-src-' + ai);
      const aAnchor = aIconData?.features?.[0]?.geometry?.coordinates;
      const bodyData = await getData('arrow-' + ai);
      let arrowPosDev = -1, arrowInside = false;
      if (aAnchor) {
        const from = [104.3, 30.2], to = [107.8, 32.8];
        const ex = from[0] + (to[0] - from[0]) * r, ey = from[1] + (to[1] - from[1]) * r;
        const p = map.project(aAnchor), e = map.project([ex, ey]);
        arrowPosDev = Math.hypot(p.x - e.x, p.y - e.y);
        for (const ft of bodyData?.features || []) {
          const ring = ft.geometry?.coordinates?.[0] || [];
          let cross = 0;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if ((yi > aAnchor[1]) !== (yj > aAnchor[1]) && aAnchor[0] < ((xj - xi) * (aAnchor[1] - yi)) / (yj - yi) + xi) cross++;
          }
          if (cross % 2 === 1) { arrowInside = true; break; }
        }
      }
      return {
        H: +H.toFixed(1), zoom: +map.getZoom().toFixed(2), pitch: +map.getPitch().toFixed(1), bearing: +map.getBearing().toFixed(1),
        lineDataExact, paint,
        iconPosDev: +iconPosDev.toFixed(2),
        arrowPosDev: +arrowPosDev.toFixed(2), arrowInside,
      };
    })(), { li: res.l, ai: res.a, r });
    rows.push({ tag, ratio: r, ...dev });
    console.log(`[${tag}] ratio=${r}`, JSON.stringify(dev));
  }
  return rows;
};

const results = [];
results.push(...(await measureAt([0.5, 0.1, 0.25, 0.75, 0.9], 'pitch6.5')));

// 缩放变化（translate 与相机无关，任何 zoom 下都应正确）
await page.evaluate(() => {
  const map = window.__sharedMap?.get?.();
  if (map) map.jumpTo({ center: [106.2, 31.7], zoom: 8, pitch: 52, bearing: 28 });
});
await page.waitForTimeout(1500);
await page.screenshot({ path: 'docs/studio-shots/verify-fly-c-zoom.png' });
results.push(...(await measureAt([0.5, 0.25, 0.75], 'zoom8')));

// 播放头 0.25 / 0.75 各截一张（爬升/降落段：图标骑线、整条路线同步升/降）
await page.evaluate(() => {
  const map = window.__sharedMap?.get?.();
  if (map) map.jumpTo({ center: [106.2, 31.7], zoom: 6.5, pitch: 52, bearing: 28 });
});
await page.waitForTimeout(1200);
for (const frac of [0.25, 0.75]) {
  await page.evaluate((f) => (async () => {
    const ps = await import('/map-video/src/stores/projectStore.ts');
    const es = await import('/map-video/src/stores/editorStore.ts');
    const project = ps.useProjectStore.getState().project;
    const chapter = project.chapters.find((c) => c.id === (es.useEditorStore.getState().selectedChapterId || project.chapters[0].id)) || project.chapters[0];
    const fps = project.globalConfig?.defaultFPS || 30;
    es.useEditorStore.getState().setCurrentFrame(chapter.startFrame + Math.round(10 * fps * f));
  })(), frac);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `docs/studio-shots/verify-fly-d-${String(frac).replace('.', '_')}.png` });
}

// 汇总。屏幕偏差为模型近似（脚本 haversine/线性插值 vs 应用 turf 测地插值），
// 且俯仰 52° 下视口外/地平线附近 map.project 会被钳制产生伪影：按 zoom 分级容差。
const expShift = (row) => JSON.stringify([0, -row.H]);
const posTol = (row) => (row.zoom >= 7 ? 15 : 5);
const okRow = (row) => {
  const P = row.paint || {};
  return row.lineDataExact === true
    && JSON.stringify(P.lineTranslate) === expShift(row) && P.lineAnchor === 'viewport'
    && JSON.stringify(P.hitTranslate) === expShift(row)
    && JSON.stringify(P.iconTranslate) === expShift(row) && P.iconAnchor === 'viewport'
    && JSON.stringify(P.arrowBodyTranslate) === expShift(row) && P.arrowBodyAnchor === 'viewport'
    && JSON.stringify(P.arrowIconTranslate) === expShift(row) && P.arrowIconAnchor === 'viewport'
    && row.iconPosDev >= 0 && row.iconPosDev < posTol(row)
    && row.arrowPosDev >= 0 && row.arrowPosDev < posTol(row) && row.arrowInside === true;
};
const bad = results.filter((r) => !okRow(r));
const report = results.map((r) =>
  `ratio=${r.ratio} cam=${r.tag} zoom=${r.zoom} pitch=${r.pitch} bearing=${r.bearing} H=${r.H} ` +
  `dataExact=${r.lineDataExact} iconPosDev=${r.iconPosDev} arrowPosDev=${r.arrowPosDev} arrowInside=${r.arrowInside}`
).join('\n');
const allOk = bad.length === 0;
writeFileSync('docs/studio-shots/verify-flyline-report.txt',
  report + '\n\npaint@r=0.5: ' + JSON.stringify(results.find((r) => r.ratio === 0.5)?.paint) + '\n\n' + (allOk ? 'ALL PASS' : 'FAIL:\n' + JSON.stringify(bad, null, 2)), 'utf8');
console.log(allOk ? 'RESULT: ALL PASS' : 'RESULT: FAIL');
if (!allOk) console.log(JSON.stringify(bad, null, 2));
writeFileSync('docs/studio-shots/verify-flyline-errors.txt', errs.join('\n') || '(no errors)', 'utf8');
console.log('errors:', errs.length);
process.exit(0);
