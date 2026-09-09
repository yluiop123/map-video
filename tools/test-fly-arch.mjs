// 飞行拱形（WebGL Custom Layer ribbon）回归：
// 1) 生成测试配置并经项目列表导入；2) 固定相机（pitch 52）逐帧截图拱形剖面；
// 3) 拾取测试：在抬升线上合成点击应选中元素；4) 收集 console 错误。
// 用法：node tools/test-fly-arch.mjs   （需 9222 调试端口；截图存 docs/studio-shots/flyarch-*.png）
import { chromium } from 'playwright-core';
import { getWorkPage } from './pw-page.mjs';
import fs from 'node:fs';

const cfg = {
  version: 1,
  exportedAt: new Date().toISOString(),
  project: {
    id: 'flyarch-test',
    name: 'flyarch-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    globalConfig: {
      defaultDuration: 300, defaultFPS: 30,
      defaultResolution: { width: 1920, height: 1080, label: '1080P' },
      defaultEasing: 'easeInOut', projection: 'mercator',
    },
    chapters: [{
      id: 'ch-fly', title: '拱形测试', order: 0,
      startFrame: 0, endFrame: 300,
      elements: [{
        id: 'el-fly-line', type: 'line', name: '飞行路线',
        visible: true, locked: false,
        startFrame: 0, endFrame: 240,
        style: {},
        coordinates: [[103.9, 30.45], [104.5, 30.85], [105.15, 30.65], [105.75, 31.1]],
        drawProgress: [],
        lineWidth: 6, lineColor: '#FF3300', lineType: 'bezier',
        animEffect: 'grow', flyMode: true, showIcon: true,
        moveIcon: { shape: 'pin', color: '#0033FF', scale: 1.2, showLabel: true, labelText: '突击群', labelColor: '#FFFFFF' },
        label: { text: '北线走廊', fontSize: 13, color: '#FFFFFF', position: 'top' },
        shapeCategory: 'route',
      }],
      camera: [{ frame: 0, center: [104.85, 30.78], zoom: 9.2, pitch: 52, bearing: -25, moveDuration: 60, easing: 'easeInOut' }],
      overlays: [], effects: [], fx: [],
    }],
    baseMaps: [{
      id: 'osm', name: 'OpenStreetMap',
      style: {
        version: 8,
        sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OSM' } },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
      },
    }],
    activeBaseMapId: 'osm',
    elevationMaps: [{ id: 'none', name: '无高程（平面）', url: '' }],
    activeElevationMapId: 'none',
    customSymbols: [],
  },
};
const cfgPath = 'D:/frontend/map-video/flyarch-config.json';
fs.writeFileSync(cfgPath, JSON.stringify(cfg), 'utf8');

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await getWorkPage(ctx);
const errors = [];
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', (err) => errors.push('PAGEERROR: ' + err.message));

await page.goto('http://localhost:5173/map-video/', { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(1500);

// 项目列表 → 导入
const listVisible = await page.getByText('最近项目').isVisible({ timeout: 2500 }).catch(() => false);
if (!listVisible) { await page.locator('button[title="项目列表"]').click(); await page.waitForTimeout(1000); }
await page.locator('input[type="file"]').first().setInputFiles(cfgPath);
await page.waitForTimeout(6000);

// 固定相机（脚本视角）
await page.evaluate(() => {
  const m = window.__sharedMap && window.__sharedMap.get();
  if (m) m.jumpTo({ center: [104.85, 30.78], zoom: 9.2, pitch: 52, bearing: -25 });
});
await page.waitForTimeout(1200);

const setFrame = async (f, name, wait = 600) => {
  await page.evaluate((frame) => {
    window.__editorStore.setState({ currentFrame: frame, isPlaying: false });
  }, f);
  await page.waitForTimeout(wait);
  await page.screenshot({ path: `docs/studio-shots/flyarch-${name}.png` });
  console.log('shot:', name);
};
await setFrame(30, '1s');
await setFrame(90, '3s');
await setFrame(150, '5s');
await setFrame(240, '8s');
await setFrame(300, '10s');

// 拾取测试：回到显示帧，取路线实际路径点（巡航段）的抬升位置合成点击；
// 图标不参与原生拾取，必须走 pickFlyRibbon 兜底
await setFrame(150, 'pick', 700);
// 缩小相机让整条路线入屏（小视口下默认相机大部分路线在屏外）
await page.evaluate(() => {
  const m = window.__sharedMap && window.__sharedMap.get();
  if (m) m.jumpTo({ center: [104.85, 30.78], zoom: 8, pitch: 52, bearing: -25 });
});
await page.waitForTimeout(900);
// 拾取几何验证：在路线巡航段抬升位置点击，复刻 pickFlyRibbon 判定（距离≤threshold 命中）
const pickTest = await page.evaluate(() => {
  const m = window.__sharedMap && window.__sharedMap.get();
  if (!m) return { ok: false };
  const expectId = String((window.__flyRibbonDbg?.lastKey || '|').split('|')[0]);
  const t = m.transform;
  const isGlobe = m.getProjection().type === 'globe';
  const pd = t.getProjectionDataForCustomLayer(isGlobe);
  const M = pd.mainMatrix;
  const w = m.getCanvas().clientWidth, h = m.getCanvas().clientHeight;
  const R = 6378137;
  const projLift = (ll, liftM) => {
    const x = (ll[0] + 180) / 360;
    const la = Math.max(-85.051129, Math.min(85.051129, ll[1]));
    const s = Math.sin((la * Math.PI) / 180);
    const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    const z = isGlobe ? liftM : liftM / (R * Math.cos((ll[1] * Math.PI) / 180));
    const cl = [M[0]*x+M[4]*y+M[8]*z+M[12], M[1]*x+M[5]*y+M[9]*z+M[13], M[2]*x+M[6]*y+M[10]*z+M[14], M[3]*x+M[7]*y+M[11]*z+M[15]];
    return [(cl[0]/cl[3]*0.5+0.5)*w, (1-(cl[1]/cl[3]*0.5+0.5))*h];
  };
  const c = m.getCenter();
  const base = projLift([c.lng, c.lat], 0);
  const up = projLift([c.lng, c.lat], 1000);
  const liftM = Math.hypot(up[0]-base[0], up[1]-base[1]) > 0.5 ? 64*1000/Math.hypot(up[0]-base[0], up[1]-base[1]) : 15000;
  const src = m.getSource('line-el-fly-line');
  const coords = src ? (src._data?.features?.[0]?.geometry?.coordinates || src.serialize()?.data?.features?.[0]?.geometry?.coordinates || null) : null;
  if (!coords || coords.length < 3) return { ok: false, expectId };
  // 巡航段中间点（屏内优先，否则全路径找）
  const candidates = [];
  for (let i = 0; i < coords.length; i++) {
    const f = i / Math.max(1, coords.length - 1);
    const h01 = f < 0.18 ? f / 0.18 : (f > 0.82 ? (1 - f) / 0.18 : 1);
    const p = projLift(coords[i], h01 * liftM);
    if (p[0] >= 20 && p[1] >= 20 && p[0] <= w - 20 && p[1] <= h - 20) candidates.push(p);
  }
  if (candidates.length === 0) return { ok: false, reason: 'no on-screen point', expectId };
  const clickPt = candidates[Math.floor(candidates.length / 2)];
  // 复刻 pickFlyRibbon：点击点到抬升折线的最小距离
  let minD = Infinity;
  let prev = null;
  for (let i = 0; i < coords.length; i++) {
    const f = i / Math.max(1, coords.length - 1);
    const h01 = f < 0.18 ? f / 0.18 : (f > 0.82 ? (1 - f) / 0.18 : 1);
    const p = projLift(coords[i], h01 * liftM);
    if (prev) {
      const dx = p[0]-prev[0], dy = p[1]-prev[1];
      const l2 = dx*dx+dy*dy;
      let t2 = l2 > 0 ? ((clickPt[0]-prev[0])*dx + (clickPt[1]-prev[1])*dy)/l2 : 0;
      t2 = Math.max(0, Math.min(1, t2));
      minD = Math.min(minD, Math.hypot(clickPt[0]-(prev[0]+dx*t2), clickPt[1]-(prev[1]+dy*t2)));
    }
    prev = p;
  }
  const rect = m.getCanvas().getBoundingClientRect();
  return { ok: true, expectId, px: clickPt[0], py: clickPt[1], x: rect.left + clickPt[0], y: rect.top + clickPt[1], minD: Math.round(minD * 10) / 10, threshold: 12, hit: minD <= 12 };
});
console.log('pickTest:', JSON.stringify(pickTest));
if (pickTest.ok && pickTest.hit) {
  await page.mouse.click(pickTest.x, pickTest.y);
  await page.waitForTimeout(800);
  const selected = await page.evaluate(() => window.__editorStore.getState().selectedElementId);
  console.log('拾取测试: selected =', selected, '(期望', pickTest.expectId + ')');
}

console.log('console errors:', errors.length ? errors.slice(0, 8) : 'none');
process.exit(0);
