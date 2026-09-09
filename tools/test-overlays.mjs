// 回归：弹窗系统重构（自定义块/9 预设卡/9 型图表/旧类型迁移）
// 验证：1) normalizeOverlayContent 旧→自定义块迁移  2) 预设卡网格截图（A 静态/B 数据）
//       3) 9 型图表逐个截图（生长动画满帧）  4) 全程无 PageError
// 前置：Chrome --remote-debugging-port=9222 + npm run dev（改过 src 需重启 dev）
import { chromium } from 'playwright-core';
import { getWorkPage } from './pw-page.mjs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await getWorkPage(ctx);
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
const log = (tag, v) => console.log(tag, typeof v === 'string' ? v : JSON.stringify(v));

await page.setViewportSize({ width: 1680, height: 950 });
await page.goto('http://localhost:5173/map-video/');
await page.waitForTimeout(2500);
await page.evaluate(async () => {
  const dbs = await indexedDB.databases();
  for (const d of dbs) indexedDB.deleteDatabase(d.name);
});
await page.reload();
await page.waitForTimeout(2500);
await page.getByPlaceholder('项目名称').fill('弹窗测试');
await page.getByText('创建', { exact: true }).first().click();
await page.waitForSelector('canvas', { timeout: 20000 });
await page.waitForTimeout(2000);

const setFrame = (f) => page.evaluate(async (f) => {
  const names = performance.getEntriesByType('resource').map((e) => e.name);
  for (const url of names.filter((n) => n.includes('/src/stores/editorStore'))) {
    try { const m = await import(url); if (m.useEditorStore) { m.useEditorStore.getState().setCurrentFrame(f); break; } } catch { /* next */ }
  }
}, f);

// 1) 迁移单测：旧类型 → 自定义块
const mig = await page.evaluate(async () => {
  const m = await import('/map-video/src/types/index.ts');
  const n = m.normalizeOverlayContent;
  const mkChild = (content) => ({ id: 'c', name: '', position: 'center', content, startFrame: 0, endFrame: 100, type: content.type });
  const r1 = n({ type: 'text', text: { content: 'hi', fontSize: 20, color: '#fff' } });
  const r2 = n({ type: 'list', list: { title: 'T', items: ['a', 'b'] } });
  const r3 = n({ type: 'image', image: { url: 'u.png' } });
  const r4 = n({ type: 'video', src: 'v.mp4' });
  const r5 = n({ type: 'audio', audio: { url: 'a.mp3' } });
  const r6 = n({ type: 'group', children: [mkChild({ type: 'text', text: { content: 'c1', fontSize: 12, color: '#fff' } }), mkChild({ type: 'group', children: [] })] });
  const r7 = n({ type: 'custom', custom: { blocks: [{ id: 'k', type: 'text', text: { content: 'x', fontSize: 12, color: '#fff' } }] } });
  return {
    r1: r1.type === 'custom' && r1.custom.blocks.length === 1,
    r2: r2.type === 'custom' && r2.custom.blocks.length === 3,
    r3: r3.custom.blocks[0]?.type === 'image',
    r4: r4.custom.blocks[0]?.type === 'video',
    r5: r5.type === 'custom' && r5.custom.blocks.length === 0 && !!r5.custom.audio?.url,
    r6: r6.custom.blocks.length === 1,
    r7: r7.custom.blocks.length === 1 && r7.custom.blocks[0].id === 'k',
  };
});
log('迁移:', mig);
let ok = true;
const check = (tag, cond) => { ok = ok && !!cond; log(cond ? 'OK ' : 'FAIL', tag); };
check('迁移 text→1块', mig.r1);
check('迁移 list→标题+2条', mig.r2);
check('迁移 image→图片块', mig.r3);
check('迁移 video→视频块', mig.r4);
check('迁移 audio→纯背景语音', mig.r5);
check('迁移 group(递归拍平+空组跳过)', mig.r6);
check('迁移 custom 幂等', mig.r7);

// 2) 注入预设卡（A 静态 5 张 / B 数据 5 张）
const base = { visible: true };
const A = [
  { id: 'o_custom', type: 'custom', name: '自定义', position: 'topLeft', startFrame: 50, endFrame: 400,
    content: { type: 'custom', custom: { blocks: [
      { id: 'b1', type: 'text', text: { content: '渡江战役', fontSize: 18, color: '#FFFFFF', bold: true, align: 'left' } },
      { id: 'b2', type: 'text', text: { content: '百万雄师过大江，一举突破长江防线。', fontSize: 13, color: '#d6d3d1', align: 'left' } },
    ] } } },
  { id: 'o_person', type: 'person', name: '人物', position: 'topRight', startFrame: 50, endFrame: 400,
    content: { type: 'person', person: { imageUrl: '', name: '粟裕', title: '总前委委员', description: '负责战役指挥。', speech: '先取长山列岛，断敌退路。' } } },
  { id: 'o_report', type: 'report', name: '战报', position: 'bottomLeft', startFrame: 50, endFrame: 400,
    content: { type: 'report', report: { title: '战报', value: '3.2万', unit: '人', note: '歼敌与俘虏合计' } } },
  { id: 'o_timeline', type: 'timeline', name: '时间线', position: 'bottomRight', startFrame: 50, endFrame: 400,
    content: { type: 'timeline', timeline: { title: '战役进程', items: [{ time: '3月5日', text: '渡江集结' }, { time: '3月8日', text: '总攻发起' }, { time: '3月9日', text: '解放南京' }] } } },
  { id: 'o_quote', type: 'quote', name: '引用', position: 'top', startFrame: 50, endFrame: 400,
    content: { type: 'quote', quote: { text: '兵者，国之大事，死生之地，存亡之道，不可不察也。', source: '《孙子兵法·始计》' } } },
].map((o) => ({ ...base, ...o, animation: 'fadeIn', exitAnimation: 'fadeOut', scale: 1 }));
const B = [
  { id: 'o_compare', type: 'compare', name: '对比', position: 'topLeft', startFrame: 450, endFrame: 800,
    content: { type: 'compare', compare: { title: '双方对比', left: { label: '我方', value: 80000 }, right: { label: '敌方', value: 52000 }, unit: '人' } } },
  { id: 'o_counter', type: 'counter', name: '计数', position: 'topRight', startFrame: 450, endFrame: 800,
    content: { type: 'counter', counter: { value: 32000, label: '伤亡统计', unit: '人', durationFrames: 90 } } },
  { id: 'o_dialogue', type: 'dialogue', name: '对话', position: 'bottomLeft', startFrame: 450, endFrame: 800,
    content: { type: 'dialogue', dialogue: { title: '往来电文', items: [{ who: '张司令', text: '命令：即刻渡江！' }, { who: '李军长', text: '收到，部队已集结完毕。' }] } } },
  { id: 'o_stats', type: 'stats', name: '态势', position: 'bottomRight', startFrame: 450, endFrame: 800,
    content: { type: 'stats', stats: { title: '当前态势', items: [{ label: '兵力', value: 82, unit: '%' }, { label: '装备', value: 65, unit: '%' }, { label: '补给', value: 90, unit: '%' }] } } },
  { id: 'o_place', type: 'place', name: '地点', position: 'top', startFrame: 450, endFrame: 800,
    content: { type: 'place', place: { name: '南京', description: '国民政府首都，1949年4月23日解放。' } } },
].map((o) => ({ ...base, ...o, animation: 'fadeIn', exitAnimation: 'fadeOut', scale: 1 }));

const inj = await page.evaluate(async (list) => {
  const names = performance.getEntriesByType('resource').map((e) => e.name);
  let st = null;
  for (const url of names.filter((n) => n.includes('/src/stores/projectStore'))) {
    try { const m = await import(url); if (m?.useProjectStore?.getState().project) { st = m.useProjectStore; break; } } catch { /* next */ }
  }
  if (!st) return { ok: false, why: 'projectStore 未找到' };
  const s = st.getState();
  const ch = s.project.chapters[0];
  for (const o of list) s.addOverlay(ch.id, o);
  return { ok: true, count: st.getState().project.chapters[0].overlays.length };
}, [...A, ...B]);
log('注入预设:', inj);
check('注入 10 张预设卡', inj.ok && inj.count === 10);

await setFrame(120);
await page.waitForTimeout(500);
await page.screenshot({ path: 'docs/studio-shots/v19-overlay-a.png' });
await setFrame(520); // B组窗口
await page.waitForTimeout(500);
await page.screenshot({ path: 'docs/studio-shots/v19-overlay-b.png' });

// 3) 图表 9 型：各自独立时间窗 + 居中截图
const CHARTS = [
  { type: 'bar', title: '柱状图', data: [{ label: '一月', value: 420 }, { label: '二月', value: 680 }, { label: '三月', value: 510 }] },
  { type: 'hbar', title: '横向条形', data: [{ label: '步兵', value: 4200 }, { label: '装甲', value: 1800 }, { label: '炮兵', value: 2600 }] },
  { type: 'line', title: '折线图', data: [{ label: '1月', value: 120 }, { label: '2月', value: 300 }, { label: '3月', value: 220 }, { label: '4月', value: 480 }, { label: '5月', value: 610 }] },
  { type: 'area', title: '面积图', data: [{ label: '1月', value: 120 }, { label: '2月', value: 300 }, { label: '3月', value: 220 }, { label: '4月', value: 480 }, { label: '5月', value: 610 }] },
  { type: 'pie', title: '饼图', data: [{ label: '步兵', value: 42 }, { label: '装甲', value: 18 }, { label: '炮兵', value: 26 }, { label: '后勤', value: 14 }] },
  { type: 'donut', title: '环形图', data: [{ label: '步兵', value: 42 }, { label: '装甲', value: 18 }, { label: '炮兵', value: 26 }, { label: '后勤', value: 14 }] },
  { type: 'radar', title: '雷达图', color: '#4C9EFF', color2: '#F87171', data: [{ label: '火力', value: 85 }, { label: '机动', value: 70 }, { label: '防御', value: 60 }, { label: '后勤', value: 75 }, { label: '侦察', value: 55 }], data2: [{ label: '火力', value: 65 }, { label: '机动', value: 80 }, { label: '防御', value: 45 }, { label: '后勤', value: 50 }, { label: '侦察', value: 70 }] },
  { type: 'gauge', title: '仪表盘', data: [{ label: '补给率%', value: 76 }] },
  { type: 'vs', title: '双方对比', color: '#4C9EFF', color2: '#F87171', data: [{ label: '兵力', value: 80000 }, { label: '火炮', value: 1200 }, { label: '坦克', value: 300 }], data2: [{ label: '兵力', value: 52000 }, { label: '火炮', value: 900 }, { label: '坦克', value: 180 }] },
];
for (let i = 0; i < CHARTS.length; i++) {
  const cfg = CHARTS[i];
  const start = 500 + i * 160;
  const ov = { ...base, id: `o_chart_${cfg.type}`, type: 'chart', name: cfg.title, position: 'center',
    startFrame: start, endFrame: start + 140, animation: 'fadeIn', exitAnimation: 'fadeOut', scale: 1,
    content: { type: 'chart', chart: cfg } };
  await page.evaluate(async (o) => {
    const names = performance.getEntriesByType('resource').map((e) => e.name);
    for (const url of names.filter((n) => n.includes('/src/stores/projectStore'))) {
      try {
        const m = await import(url);
        if (m?.useProjectStore?.getState().project) {
          const s = m.useProjectStore.getState();
          s.addOverlay(s.project.chapters[0].id, o);
          break;
        }
      } catch { /* next */ }
    }
  }, ov);
  await setFrame(start + 60);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `docs/studio-shots/v19-chart-${cfg.type}.png` });
}

log('PageErrors:', errs);
check('无 PageError', errs.length === 0);
log('总体:', ok ? 'ALL OK' : 'HAS FAIL');
process.exit(ok ? 0 : 1);
