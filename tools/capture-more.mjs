// 逐个激活工具/面板后整页截图 + 全文转储
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve('docs/studio-shots');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages().find((p) => p.url().includes('mapimator'));
await page.bringToFront();
await page.setViewportSize({ width: 1680, height: 950 });

const esc = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(600); };
const shot = async (tag) => {
  await page.screenshot({ path: path.join(OUT_DIR, `${tag}-page.png`) });
  const txt = await page.evaluate(() => document.body.innerText.replace(/\n{3,}/g, '\n\n'));
  const vis = await page.evaluate(() => {
    // 只输出视口内可见的文本节点所在块
    return Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"],input,select,textarea,h3,label'))
      .map((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || r.bottom > innerHeight) return '';
        return `[${Math.round(r.x)},${Math.round(r.y)}] ${el.tagName.toLowerCase()}: ${(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50)}`;
      }).filter(Boolean).join('\n');
  });
  writeFileSync(path.join(OUT_DIR, `${tag}-elements.txt`), `URL:${page.url()}\n\n==VISIBLE TEXT==\n${txt}\n\n==VISIBLE CONTROLS==\n${vis}`, 'utf8');
  console.log(`${tag} ok`);
};

// 点击工具栏按钮的通用函数：按可见文本精确定位
const clickTool = async (name) => {
  await page.mouse.click(840, 470); // 地图空白处收起可能的弹层
  await esc();
  await page.getByRole('button', { name, exact: true }).first().click({ timeout: 5000 });
  await page.waitForTimeout(1400);
};

// 地图中心放置一个元素以确保面板出现
try { await clickTool(/^(Pin|📍)$/); await shot('10-pin-active'); } catch (e) { console.log('pin:', e.message.split('\n')[0]); }
try { await clickTool('Text'); await page.keyboard.type('HELLO'); await page.waitForTimeout(600); await shot('11-text-tool'); } catch (e) { console.log('text:', e.message.split('\n')[0]); }
try {
  await clickTool(/^Shapes$/);
  await page.waitForTimeout(600);
  await shot('12-shapes-menu');
} catch (e) { console.log('shapes:', e.message.split('\n')[0]); }

// Storyboard 卡片 ⋯ 菜单（View 1 卡片右上角三点）
try {
  await esc();
  await page.mouse.click(160, 880); // 卡片头部区域
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, '13-card-area.png') });
} catch (e) { console.log('card:', e.message.split('\n')[0]); }

console.log('all done');
process.exit(0);
