// 复用已有 localhost 标签页，关闭多余的，返回唯一工作页
export async function getWorkPage(ctx) {
  const locals = ctx.pages().filter((p) => p.url().includes('localhost:5173'));
  const page = locals[0] || (await ctx.newPage());
  for (let i = 1; i < locals.length; i++) { try { await locals[i].close(); } catch {} }
  // 关闭无关空白页
  for (const p of ctx.pages()) {
    if (p !== page && (p.url() === 'about:blank')) { try { await p.close(); } catch {} }
  }
  await page.bringToFront();
  return page;
}
