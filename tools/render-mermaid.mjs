#!/usr/bin/env node
/**
 * render-mermaid.mjs — 把 .mmd 图表源码预渲染成独立 SVG，并可注入 HTML 报告。
 *
 * 为什么要预渲染：报告若靠浏览器运行时加载 mermaid.js（3.5MB）解析 DOM 文本，
 * 一旦脚本执行时序 / DOM 内容有任何偏差，页面就会显示
 * 「Syntax error in text / mermaid version x.y.z」。预渲染后内联纯 SVG，
 * 离线可用、无 CDN 依赖、无运行时竞态。
 *
 * 用法：
 *   node tools/render-mermaid.mjs docs/db-er-diagram.mmd
 *   node tools/render-mermaid.mjs docs/db-er-diagram.mmd --out docs/db-er-diagram.svg
 *   node tools/render-mermaid.mjs docs/db-er-diagram.mmd --inject docs/db-redesign.html
 *   node tools/render-mermaid.mjs <in.mmd> --inject <html> --marker ER-SVG   # 默认 ER-SVG
 *
 * 参数：
 *   --out <path>       独立 SVG 输出路径（省略则不写文件）
 *   --inject <path>    把 SVG 注入该 HTML 中 <!-- MARKER:BEGIN --> 与 <!-- MARKER:END --> 之间
 *   --marker <name>    注入标记名，默认 ER-SVG
 *   --config <json|path> mermaid initialize 配置（JSON 文件路径或内联 JSON），与默认报告配色深合并
 *   --scale <n>        额外整体缩放，默认 1（写入 SVG 的 width/height）
 *   --chrome <path>    指定 Chrome 可执行文件（默认自动探测，可用 CHROME_PATH 覆盖）
 *   --keep-tmp         保留临时 HTML，便于排查
 *
 * 依赖：playwright-core（项目已有）+ 本机 Chrome。需要联网拉取 mermaid 一次，渲染后无需联网。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';

// 与 docs/*.html 报告的配色令牌保持一致（浅色底、蓝主色、无衬线 13px）
const DEFAULT_CONFIG = {
  startOnLoad: false,
  securityLevel: 'loose',
  theme: 'base',
  themeVariables: {
    fontFamily: '"Geist","Noto Sans SC",system-ui,-apple-system,"Segoe UI",sans-serif',
    fontSize: '13px',
    primaryColor: '#e6f1fb',
    primaryTextColor: '#0c447c',
    primaryBorderColor: '#185fa5',
    tertiaryColor: '#f7f7f6',
    lineColor: '#a8a29e',
    textColor: '#1c1917',
    mainBkg: '#e6f1fb',
    nodeBorder: '#185fa5',
    attributeBackgroundColorOdd: '#ffffff',
    attributeBackgroundColorEven: '#f4f8fc',
  },
  er: { useMaxWidth: true, layoutDirection: 'TB' },
};

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function parseArgs(argv) {
  const args = { marker: 'ER-SVG', scale: 1, input: null, out: null, inject: null, chrome: null, config: null, keepTmp: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--inject') args.inject = argv[++i];
    else if (a === '--marker') args.marker = argv[++i];
    else if (a === '--scale') args.scale = Number(argv[++i]) || 1;
    else if (a === '--chrome') args.chrome = argv[++i];
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--keep-tmp') args.keepTmp = true;
    else if (a.startsWith('--')) throw new Error(`未知参数 ${a}`);
    else args.input = a;
  }
  return args;
}

function findChrome(explicit) {
  const list = explicit ? [explicit, ...CHROME_CANDIDATES] : CHROME_CANDIDATES;
  for (const p of list) if (p && fs.existsSync(p)) return p;
  throw new Error('找不到 Chrome，可用 --chrome <path> 或 CHROME_PATH 环境变量指定');
}

const args = parseArgs(process.argv);
if (!args.input) {
  console.error('用法: node tools/render-mermaid.mjs <input.mmd> [--out x.svg] [--inject x.html] [--marker ER-SVG] [--config x.json]');
  process.exit(1);
}

// 主题配置：默认用报告配色；--config 可传 JSON 文件路径或内联 JSON 字符串
let config = DEFAULT_CONFIG;
if (args.config) {
  const raw = fs.existsSync(args.config) ? fs.readFileSync(args.config, 'utf8') : args.config;
  config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
}

const src = fs.readFileSync(args.input, 'utf8');
const chromePath = findChrome(args.chrome);
console.log(`[1/4] 图源 ${args.input}（${src.split(/\r?\n/).length} 行）· Chrome: ${chromePath}`);

// mermaid 用 render() 显式渲染：不经过 DOM 自动流程，也不依赖节点文本，报错可精确定位
const tmpHtml = path.join(os.tmpdir(), `mv-mermaid-${Date.now()}.html`);
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
fs.writeFileSync(
  tmpHtml,
  `<!doctype html><html><body style="margin:0;background:#fff">
<div id="out"></div>
<script type="text/plain" id="src">${esc(src)}</script>
<script src="${MERMAID_CDN}"></script>
<script>
  window.__cfg = ${JSON.stringify(config)};
  window.__render = async function () {
    if (!window.mermaid) return { ok: false, error: 'mermaid 脚本未加载（CDN 不可达？）' };
    try {
      mermaid.initialize(window.__cfg);
      var text = document.getElementById('src').textContent;
      var out = await mermaid.render('diagram', text);
      document.getElementById('out').innerHTML = out.svg;
      return { ok: true, version: (typeof mermaid.version === 'function' ? mermaid.version() : mermaid.version) || 'n/a' };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  };
</script>
</body></html>`,
  'utf8',
);

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('requestfailed', (r) => errors.push('REQ_FAIL ' + r.url().slice(0, 100)));
await page.goto('file:///' + tmpHtml.replace(/\\/g, '/'));

let res;
try {
  await page.waitForFunction(() => typeof window.__render === 'function', null, { timeout: 45000 });
  res = await page.evaluate(() => window.__render());
} catch (e) {
  res = { ok: false, error: '页面脚本未就绪：' + String(e.message || e) };
}

if (!res.ok) {
  await browser.close();
  fs.rmSync(tmpHtml, { force: true });
  console.error('[2/4] 渲染失败：' + res.error);
  if (errors.length) console.error('      ' + errors.join('\n      '));
  process.exit(2);
}
console.log(`[2/4] mermaid 版本 ${res.version}`);

const svg = await page.evaluate((scale) => {
  const el = document.querySelector('#out svg');
  el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  el.removeAttribute('data-processed');
  // 保留 viewBox（几何与字号按原始尺寸），width/height 显式写出供容器按原尺寸滚动
  const vb = (el.getAttribute('viewBox') || '').split(/\s+/).map(Number);
  el.style.maxWidth = '';
  el.removeAttribute('style');
  el.setAttribute('width', String(Math.round(vb[2] * scale)));
  el.setAttribute('height', String(Math.round(vb[3] * scale)));
  el.setAttribute('role', 'img');
  return { markup: el.outerHTML, w: vb[2], h: vb[3] };
}, args.scale);
await browser.close();
if (!args.keepTmp) fs.rmSync(tmpHtml, { force: true });

console.log(`[3/4] 渲染成功：viewBox ${Math.round(svg.w)}×${Math.round(svg.h)} · SVG ${(svg.markup.length / 1024).toFixed(1)}KB`);

if (args.out) {
  const header = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- 由 tools/render-mermaid.mjs 从 ${path.basename(args.input)} 预渲染；请勿手改，改源码后重新生成 -->\n`;
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, header + svg.markup + '\n', 'utf8');
  console.log(`      写出 ${args.out}`);
}

if (args.inject) {
  const html = fs.readFileSync(args.inject, 'utf8');
  const begin = `<!-- ${args.marker}:BEGIN -->`;
  const end = `<!-- ${args.marker}:END -->`;
  const bi = html.indexOf(begin);
  const ei = html.indexOf(end);
  if (bi === -1 || ei === -1) {
    console.error(`注入失败：${args.inject} 中找不到 ${begin} / ${end} 标记对`);
    process.exit(3);
  }
  const next = html.slice(0, bi + begin.length) + '\n' + svg.markup + '\n' + html.slice(ei);
  fs.writeFileSync(args.inject, next, 'utf8');
  console.log(`[4/4] 已注入 ${args.inject}（标记 ${args.marker}）`);
}
