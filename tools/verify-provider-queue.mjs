/**
 * verify-provider-queue.mjs — 批量调度的离线回归（不联网）
 *
 * 覆盖：并发上限、只重试 429/5xx、业务错不重试、取消后不再开新行、逐条进度与逐条落库钩子。
 * 运行：node --experimental-strip-types tools/verify-provider-queue.mjs
 */
import { runBatch, retriable } from '../src/lib/provider-queue.ts';
import { EngineError } from '../src/lib/request-engine.ts';

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed += 1;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail !== undefined && !pass ? `\n         ${JSON.stringify(detail)}` : ''}`);
};

check('1.1 只重试限流与服务端故障', retriable(new EngineError('x', 429)) && retriable(new EngineError('x', 503)));
check('1.2 业务错（400 / 404）不重试', !retriable(new EngineError('Model not exist.', 400)) && !retriable(new EngineError('nope', 404)));
check('1.3 没带状态码的错（CORS / 参数缺失）不重试', !retriable(new EngineError('请求失败（可能被 CORS 拦截）')));

// 并发上限：同时在场的项目数峰值
let live = 0;
let peak = 0;
const res1 = await runBatch(Array.from({ length: 9 }, () => async () => {
  live += 1; peak = Math.max(peak, live);
  await new Promise((r) => setTimeout(r, 5));
  live -= 1;
}), { concurrency: 3 });
check('2.1 并发不超过 maxConcurrency', peak <= 3 && peak > 1, { peak });
check('2.2 全部跑完', res1.ok === 9 && res1.failed.length === 0, res1);

// 重试：前两次 429，第三次成
let tries = 0;
const res2 = await runBatch([async () => {
  tries += 1;
  if (tries < 3) throw new EngineError('Too Many Requests', 429);
}], { retries: 2 });
check('3.1 限流会重试到成功', tries === 3 && res2.failed.length === 0, { tries, res2 });

// 业务错不重试：一次就记失败
let biz = 0;
const res3 = await runBatch([async () => { biz += 1; throw new EngineError('Model not exist.', 400); }], { retries: 3 });
check('3.2 业务错只打一次并点名', biz === 1 && res3.failed[0]?.error.includes('Model not exist'), { biz, res3 });

// 取消：第一条完成后取消，剩下的不再开始
let started = 0;
let cancel = false;
const res4 = await runBatch(Array.from({ length: 6 }, () => async () => {
  started += 1;
  await new Promise((r) => setTimeout(r, 5));
  if (started === 1) cancel = true;
}), { concurrency: 1, isCancelled: () => cancel });
check('4.1 取消后不再开始新的行', started <= 3 && res4.cancelled > 0, { started, cancelled: res4.cancelled });

// 进度与逐条落库：产物一到就回调，不等整批
const seen = [];
let lastProgress = 0;
await runBatch([async () => 'a', async () => { throw new EngineError('x', 400); }, async () => 'c'], {
  onItem: (v) => seen.push(v),
  onProgress: (done) => { lastProgress = done; },
});
check('5.1 成功项逐条回调（失败项不回调）', JSON.stringify(seen) === JSON.stringify(['a', 'c']), seen);
check('5.2 进度按每条完成推进', lastProgress === 3, lastProgress);

console.log(failed ? `\n===== ${failed} 项失败 =====` : '\n===== 全部通过 =====');
process.exit(failed ? 1 : 0);
