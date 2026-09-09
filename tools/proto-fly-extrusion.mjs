// 原型对比：飞行路线的两种实现并排截图（不改应用代码，纯页面叠加原型层）
//   红色 = 现有实现：路线本体(贴地几何) + line-translate 屏幕上移 64px（flyMode 现状）
//   青色 = 真 3D 原型：fill-extrusion 悬空条带（hover: base=H-1500,height=H）/ 幕墙(wall: base=0,height=H)
// 前置：Chrome --remote-debugging-port=9222；dev server 已启动
// 用法：node tools/proto-fly-extrusion.mjs
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

const H = Number(process.argv[2] || 30000); // 悬空高度（米）
const shot = async (name, cam) => {
  await page.evaluate((c) => {
    const map = window.__sharedMap?.get?.();
    if (map) map.jumpTo(c);
  }, cam);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `docs/studio-shots/proto-fly-${name}.png` });
  console.log('shot:', name);
};

// 注入 flyMode 路线（应用现状渲染 = 红色屏幕平移）+ 清空章节相机避免拽回
await page.evaluate(async () => {
  const ps = await import('/map-video/src/stores/projectStore.ts');
  const es = await import('/map-video/src/stores/editorStore.ts');
  const st = ps.useProjectStore.getState();
  const project = st.project;
  if (!project) throw new Error('no project');
  for (const c of project.chapters) {
    for (const el of [...c.elements]) if (el.id.startsWith('verify-fly-') || el.id.startsWith('proto-fly-')) st.deleteElement(c.id, el.id);
  }
  const esState = es.useEditorStore.getState();
  const chapterId = esState.selectedChapterId || project.chapters[0].id;
  const chapter = project.chapters.find((c) => c.id === chapterId) || project.chapters[0];
  st.updateChapter(chapter.id, { camera: [] });
  const fps = project.globalConfig?.defaultFPS || 30;
  const start = chapter.startFrame ?? 0;
  const dur = 10 * fps;
  st.addElements(chapter.id, [{
    id: 'proto-fly-' + Date.now().toString(36), name: '飞行原型对比', visible: true, locked: false, style: {},
    type: 'line',
    coordinates: [[104.0, 30.0], [106.0, 33.2], [108.5, 30.6]],
    drawProgress: [{ frame: start, value: 1 }],
    startFrame: start, endFrame: start + dur,
    animEffect: 'move', moveStartFrame: start, moveEndFrame: start + dur,
    showIcon: true, uniformMove: true, flyMode: true,
    lineWidth: 6, lineColor: '#FF3300',
  }]);
  es.useEditorStore.getState().setCurrentFrame(start + Math.round(dur / 2));
});
await page.waitForTimeout(1500);

// 叠加 fill-extrusion 原型层（青色悬空条带 / 幕墙），mode=hover|wall
const addProto = async (mode, height) => {
  await page.evaluate(({ mode, height }) => {
    const map = window.__sharedMap?.get?.();
    if (!map) throw new Error('no map');
    const srcId = 'proto-fly-ext-src';
    const layerId = 'proto-fly-ext-layer';
    if (map.getLayer(layerId)) { map.removeLayer(layerId); }
    if (map.getSource(srcId)) { map.removeSource(srcId); }
    const path = [[104.0, 30.0], [106.0, 33.2], [108.5, 30.6]];
    const w = 0.22; // 半宽（度，约 24km）
    const left = [], right = [];
    for (let i = 0; i < path.length; i++) {
      const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      left.push([path[i][0] - dy * w, path[i][1] + dx * w]);
      right.push([path[i][0] + dy * w, path[i][1] - dx * w]);
    }
    const ring = [...left, ...right.reverse(), left[0]];
    map.addSource(srcId, { type: 'geojson', data: { type: 'Polygon', coordinates: [ring] } });
    map.addLayer({
      id: layerId, type: 'fill-extrusion', source: srcId,
      paint: {
        'fill-extrusion-color': '#00AAFF',
        'fill-extrusion-height': mode === 'wall' ? height : height,
        'fill-extrusion-base': mode === 'wall' ? 0 : height - 1500,
        'fill-extrusion-opacity': 0.8,
      },
    });
  }, { mode, height });
};

console.log('height(H) =', H, 'meters');
await addProto('hover', H);
await shot('flat-hover', { center: [106.2, 31.7], zoom: 6.5, pitch: 0, bearing: 0 });
await shot('pitch-hover', { center: [106.2, 31.7], zoom: 6.5, pitch: 52, bearing: 28 });
await shot('zoom4-hover', { center: [106.2, 31.7], zoom: 4, pitch: 0, bearing: 0 });
await page.evaluate(() => {
  const map = window.__sharedMap?.get?.();
  const l = map?.getLayer?.('proto-fly-ext-layer');
  if (map && l) { map.removeLayer('proto-fly-ext-layer'); map.removeSource('proto-fly-ext-src'); }
});
await addProto('wall', H);
await shot('pitch-wall', { center: [106.2, 31.7], zoom: 6.5, pitch: 52, bearing: 28 });

// 收尾清理：重载丢弃注入元素与原型层
await page.goto('http://localhost:5173/map-video/', { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(3000);
writeFileSync('docs/studio-shots/proto-fly-errors.txt', errs.join('\n') || '(no errors)', 'utf8');
console.log('errors:', errs.length);
process.exit(0);
