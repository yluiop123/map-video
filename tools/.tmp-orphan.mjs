// 一次性：验证「开关关掉留下的那一格」有 ⚠ 与可用的「移除这一格」（用完即删）
import { chromium } from 'playwright-core';

const b = await chromium.connectOverCDP('http://localhost:9223');
const page = b.contexts()[0].pages()[0];
const t = (ms) => page.waitForTimeout(ms);
await page.goto('http://localhost:5173/map-video/', { waitUntil: 'networkidle' });
await t(2000);
const stamp = `__orphan-check-${Date.now() % 100000}`;
if (!(await page.locator('button[title="设置 · AI"]').count())) {
  await page.fill('input[placeholder="项目名称"]', stamp);
  await page.click('button:has-text("创建")');
}
await page.locator('button[title="设置 · AI"]').waitFor({ timeout: 15000 });
await t(800);
await page.click('button[title="设置 · AI"]');
await page.getByRole('dialog').waitFor({ timeout: 8000 });
await t(500);
await page.getByText('接口模板', { exact: true }).first().click();
await t(500);
await page.getByRole('tab', { name: '语音', exact: true }).click();
await t(400);
await page.getByRole('button', { name: '＋ 模板' }).click();
await t(700);
// 开克隆 + 开「建前先上传」→ 长出上传那一格，并往地址里填点东西（证明移除是真删内容，不是隐藏）
await page.locator('#tpl-clone').click(); await t(500);
await page.locator('#tpl-upload').click(); await t(700);
const upTab = page.getByRole('tab', { name: /上传/ });
const tabText1 = await upTab.textContent();
await upTab.click(); await t(500);
await page.locator('input[placeholder="${baseUrl}/…"]').fill('${baseUrl}/my/upload');
await t(600);
// 关掉「建前先上传」→ 这一格应留下并标 ⚠
await page.locator('#tpl-upload').click(); await t(700);
const tabText2 = await page.getByRole('tab', { name: /上传/ }).textContent().catch(() => null);
const band = await page.evaluate(() => {
  const txt = document.body.innerText;
  return { 有说明带: txt.includes('不会被调用'), 有移除按钮: txt.includes('移除这一格'), 校验点名: txt.includes('移除这一格') && txt.includes('⚠') };
});
await page.screenshot({ path: 'tools/.bench/orphan-slot.png' });
// 点移除 → 二次确认 → 那一格应彻底没了
await page.getByRole('button', { name: '移除这一格' }).click();
await t(500);
await page.getByRole('button', { name: '确定' }).last().click();
await t(800);
const after = await page.evaluate(async () => {
  const rows = await window.mapvideo.templates.list();
  const t2 = rows.find((x) => x.name?.startsWith('自定义') && x.category === 'tts');
  return {
    还有上传页签: document.body.innerText.includes('桥接 · 上传'),
    那一格在库里: !!(t2?.upload),
    克隆那一格还在: !!(t2?.clone),
  };
});
console.log(JSON.stringify({ tabText1, tabText2, ...band, ...after }, null, 1));
// 收尾：删临时模板与临时项目
await page.getByRole('button', { name: '删除', exact: true }).first().click();
await t(400);
await page.getByRole('button', { name: '确定' }).last().click();
await t(600);
await page.keyboard.press('Escape');
await t(300);
const names = await page.evaluate(async () => {
  const ps = window.__projectStore.getState();
  for (const x of (await ps.listProjects()).filter((r) => r.name.startsWith('__orphan-check-'))) await ps.deleteProject(x.id);
  return (await ps.listProjects()).map((r) => r.name);
});
console.log('项目:', JSON.stringify(names));
await b.close();
