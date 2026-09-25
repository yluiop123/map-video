/**
 * 压测项目工具：__perf-stress 的建 / 开 / 删（bench-preview 与归因探针都要它当场景）
 *
 * 为什么要它：用户自己的项目（哈哈 8 元素、第一集）轻到量不出逐帧开销差别，
 * 性能改动必须先有几百元素的场景，数字才不是凭手感。
 * 元素 id 用等宽的 `ps0001`：变长又带 `-` 的 id 会互相子串包含，
 * 地图侧按「已知元素 id 前缀匹配」反解图层名就会互吞，造出「每帧狂调 moveLayer」的假热点。
 *
 *   node tools/stress-project.mjs            # 建（已在建好的项目里则只补元素）
 *   node tools/stress-project.mjs --open     # 打开它（bench 要求编辑器里已打开项目）
 *   node tools/stress-project.mjs --destroy   # 删掉它
 * 前置：MV_CDP=9223 MV_BENCH=1 npm run electron:dev，且窗口在前台（否则 rAF 被节流）。
 */
import { chromium } from 'playwright-core';

const cdp = process.env.MV_CDP || 'http://127.0.0.1:9223';
const TARGET = 340;
const NAME = '__perf-stress';
const mode = process.argv.includes('--destroy') ? 'destroy' : process.argv.includes('--open') ? 'open' : 'build';

const browser = await chromium.connectOverCDP(cdp);
const page = browser.contexts()[0].pages().find((p) => p.url().includes('localhost:5173'));
if (!page) { console.error(`没找到 5173 页面（CDP: ${cdp}）`); process.exit(2); }

const step = async (label, fn, arg) => {
  try {
    const v = await page.evaluate(fn, arg);
    console.log(`[${label}] ${JSON.stringify(v)}`);
    return v;
  } catch (e) {
    console.log(`[${label}] FAIL ${String(e.message).slice(0, 240)}`);
    throw e;
  }
};

if (mode === 'destroy') {
  await step('destroy', async () => {
    const st = window.__projectStore.getState();
    const list = await window.mapvideo.projects.list();
    const hit = (list || []).find((p) => p.name === '__perf-stress');
    if (hit) await st.deleteProject(hit.id);
    return { removed: hit ? hit.id : null, project: st.project?.name ?? null };
  });
} else if (mode === 'open') {
  // node tools/stress-project.mjs --open            打开压测项目
  // node tools/stress-project.mjs --open 哈哈       打开任意项目（用完把会话还给用户）
  await step('open', async (want) => {
    const st = window.__projectStore.getState();
    const name = want || '__perf-stress';
    if (st.project?.name === name) return { ok: true, already: true, els: st.project.elements.length };
    const list = await window.mapvideo.projects.list();
    const hit = (list || []).find((p) => p.name === name);
    if (!hit) return { ok: false, why: `库里没有「${name}」，先跑 node tools/stress-project.mjs 建一个` };
    await st.loadProject(hit.id);
    const p = window.__projectStore.getState().project;
    return { ok: true, name: p.name, els: p.elements.length, endFrame: p.endFrame };
  }, process.argv.find((a, i) => i > 2 && !a.startsWith('--')) || null);
} else {
  await step('prepare', async () => {
    const st = window.__projectStore.getState();
    let cur = st.project;
    if (!cur) {
      const list = await window.mapvideo.projects.list();
      const src = (list || []).find((p) => p.name !== '__perf-stress');
      if (!src) return { ok: false, why: '库里没有可复制的项目' };
      await st.loadProject(src.id);
      cur = window.__projectStore.getState().project;
    }
    if (cur.name === '__perf-stress') return { ok: true, mode: 'already', els: cur.elements.length };
    window.__perfSrc = JSON.parse(JSON.stringify({ name: cur.name, elements: cur.elements }));
    await st.createProject('__perf-stress');
    return { ok: true, mode: 'created', src: window.__perfSrc.name };
  });

  await step('clone', (target) => {
    const st = window.__projectStore.getState();
    if ((st.project?.elements?.length || 0) >= target - 20) return { skipped: st.project.elements.length };
    const src = window.__perfSrc;
    const rnd = () => (Math.random() - 0.5) * 12;
    const clones = [];
    let n = 0;
    while (clones.length < target && src.elements.length) {
      for (const el of src.elements) {
        const c = JSON.parse(JSON.stringify(el));
        n += 1;
        c.id = `ps${String(n).padStart(4, '0')}`;              // 等宽，互不为子串
        c.name = c.id;
        const dx = rnd(), dy = rnd();
        const shift = (p) => { if (Array.isArray(p) && typeof p[0] === 'number') { p[0] += dx; p[1] += dy; } return p; };
        if (c.coordinates) (Array.isArray(c.coordinates[0]) ? c.coordinates : [c.coordinates]).forEach(shift);
        if (c.path) c.path.forEach(shift);
        if (c.center) shift(c.center);
        clones.push(c);
        if (clones.length >= target) break;
      }
    }
    st.addElements(clones);
    const p = window.__projectStore.getState().project;
    const fps = p.globalConfig.defaultFPS;
    st.setProjectCamera([
      { frame: 0, center: [104, 35], zoom: 4 },
      { frame: 4 * fps, center: [110, 38], zoom: 5 },
      { frame: 8 * fps, center: [100, 32], zoom: 4.5 },
    ]);
    return { cloned: clones.length, els: p.elements.length, layers: p.layers.length };
  }, TARGET);

  await step('save', async () => {
    await window.__projectStore.getState().saveProject();
    const p = window.__projectStore.getState().project;
    const ids = p.elements.map((e) => e.id);
    const m = window.__sharedMap.get();
    const style = m && typeof m.getStyle === 'function' ? m.getStyle() : null;
    return {
      id: p.id, els: p.elements.length, endFrame: p.endFrame,
      idCollisions: ids.filter((a) => ids.some((b) => b !== a && b.includes(a))).length,
      byType: p.elements.reduce((mm, e) => ((mm[e.type] = (mm[e.type] || 0) + 1), mm), {}),
      styleLayers: style?.layers?.length ?? null,
    };
  });
}

await browser.close();
