/**
 * bench-attribution.mjs — 把 CPU profile 的自耗时**归因到我们的渲染函数**上
 *
 * `bench-preview.mjs` 只有「函数自耗时 top」，而 top 榜上全是 turf 与 maplibre 的压缩名
 * （distance / getCoord / receive），看不出是谁每帧在调它们。这里沿调用栈往上找第一个
 * 属于我们的帧（map-renderer / keyframe-interpolation / military-* / route-time / territory），
 * 把这份自耗时记到它头上，于是「getLineMidpoint ← renderLine 781ms/6s」这种结论才有出处。
 *
 *   node tools/bench-attribution.mjs --secs 6
 * 前置与 bench-preview 相同：MV_CDP=9223 MV_BENCH=1、已打开项目、**窗口在前台**
 * （窗口被最小化时 profiler 里 (idle) 会占八成，归因表全是废话）。
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const SECS = Number(arg('secs', 6));
const cdp = process.env.MV_CDP || 'http://127.0.0.1:9223';

const browser = await chromium.connectOverCDP(cdp);
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('localhost:5173'));
const client = await ctx.newCDPSession(page);
await client.send('Profiler.enable');
await client.send('Profiler.setSamplingInterval', { interval: 100 });

// 先让编辑端起来播放（bench 同款做法：直控播放头）
await page.evaluate(() => {
  const s = window.__editorStore.getState();
  s.setPlayRate?.(1);
  s.setCurrentFrame(0);
  s.setIsPlaying(true);
});
await client.send('Profiler.start');
await page.waitForTimeout(SECS * 1000);
await page.evaluate(() => window.__editorStore.getState().setIsPlaying(false));
const { profile } = await client.send('Profiler.stop');
await client.send('Profiler.disable').catch(() => {});

const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of (n.children || [])) parent.set(c, n.id);

const self = new Map();
const total = profile.samples.length;
for (const id of profile.samples) self.set(id, (self.get(id) || 0) + 1);
const ms = (c) => Math.round((c / total) * SECS * 1000);

/** 我们的源文件（渲染层）—— 自耗时归到它，并记住它属于哪个函数 */
const OURS = /src\/(lib|components)\/(map-renderer|keyframe-interpolation|military-geometry|military-plots|route-time|territory)\.ts/;
function ownerOf(node) {
  let cur = node;
  const chain = [];
  while (cur) {
    const cf = cur.callFrame;
    const url = cf.url || '';
    if (OURS.test(url)) {
      chain.push(`${cf.functionName || '(anon)'} @ ${url.match(/(map-renderer|keyframe-interpolation|military-\w+|route-time|territory)\.ts/)[1]}:${cf.lineNumber + 1}`);
    }
    if (chain.length >= 3) break;
    cur = parent.has(cur.id) ? nodes.get(parent.get(cur.id)) : null;
  }
  return chain;
}

const byOwner = new Map();
const byLeaf = new Map();
for (const [id, c] of self) {
  const n = nodes.get(id);
  if (!n) continue;
  const cf = n.callFrame;
  const leaf = `${cf.functionName || '(anon)'} @ ${(cf.url || '').split('/').slice(-1)[0].split('?')[0]}:${cf.lineNumber + 1}`;
  byLeaf.set(leaf, (byLeaf.get(leaf) || 0) + c);
  const chain = ownerOf(n);
  const key = chain.length ? chain.join('  <-  ') : `(无我们的帧：${leaf})`;
  byOwner.set(key, (byOwner.get(key) || 0) + c);
}

const out = {
  secs: SECS,
  sampledMs: SECS * 1000,
  byOwner: [...byOwner.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22).map(([k, v]) => ({ ms: ms(v), at: k })),
  hotLeaves: [...byLeaf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => ({ ms: ms(v), fn: k })),
};
console.log(JSON.stringify(out, null, 1));
fs.writeFileSync('tools/.bench/attribute-last.json', JSON.stringify(out, null, 1));
await browser.close();
