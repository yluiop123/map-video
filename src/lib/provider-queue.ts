/**
 * provider-queue.ts — 一次动作发多条请求时的调度层（内存队列，不是表）
 *
 * 为什么要有它：逐行配音（30 行字幕 = 30 次合成，异步的每次还要轮询十几秒）、批量出图
 * 都是「一个用户动作 → N 次上游调用」。原先是 for 循环里 await：没有并发上限、没有取消、
 * 失败只能整批重来。
 *
 * 为什么不落成任务表：taskId 只在一次调用内有意义（上游任务几十分钟就过期），
 * 而「哪几行还没配音」项目数据本身就是清单（narration_entry 有没有音频）—— 再存一份就是第二处真相。
 */
export interface BatchOptions {
  /** 同时飞几条；来自实例的 maxConcurrency（1 = 串行） */
  concurrency?: number;
  /** 限流 / 5xx 的额外重试次数；来自实例的 retryTimes */
  retries?: number;
  /** 每次取任务前检查；取消只拦「还没开始的」，在途的那条会跑完 */
  isCancelled?: () => boolean;
  /** 每完成一条回调一次（含失败），界面据此显示 7/30 */
  onProgress?: (done: number, total: number) => void;
  /** 每条成功即刻落库的钩子（产物一拿到就存，不等整批） */
  onItem?: (value: unknown, index: number) => void;
}

export interface BatchResult {
  ok: number;
  /** 失败项的原始下标与点名信息 */
  failed: { index: number; error: string }[];
  cancelled: number;
}

/** 引擎的 EngineError 带 status；这里按鸭子类型取，免得为一次 instanceof 把两个模块绑死 */
function httpStatus(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
}

/** 只重试「再试一次可能成」的错：限流与服务端故障；业务错（模型名不存在、参数非法）重试只是浪费配额 */
export function retriable(e: unknown): boolean {
  const status = httpStatus(e);
  return status === 429 || (status !== undefined && status >= 500 && status < 600);
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 跑一批任务：固定 N 个 worker 从同一个游标取活，逐条回调进度与落库。
 * 调用方负责在 onItem 里把产物写进项目（失败行下次自然被「只补没配音的」重跑）。
 */
export async function runBatch<T>(jobs: (() => Promise<T>)[], o: BatchOptions = {}): Promise<BatchResult> {
  const total = jobs.length;
  const concurrency = Math.max(1, Math.min(o.concurrency ?? 1, total));
  const retries = Math.max(0, o.retries ?? 0);
  let cursor = 0;
  let done = 0;
  const failed: BatchResult['failed'] = [];

  const worker = async () => {
    for (;;) {
      // 取消只拦「还没开始的」：在途的那条会跑完，然后 worker 退出
      if (o.isCancelled?.()) return;
      const i = cursor++;
      if (i >= total) return;
      let attempt = 0;
      for (;;) {
        try {
          const v = await jobs[i]();
          o.onItem?.(v, i);
          break;
        } catch (e) {
          if (attempt < retries && retriable(e)) {
            attempt += 1;
            await wait(500 * 2 ** (attempt - 1));
            continue;
          }
          failed.push({ index: i, error: e instanceof Error ? e.message : String(e) });
          break;
        }
      }
      done += 1;
      o.onProgress?.(done, total);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  return { ok: done - failed.length, failed, cancelled: total - done };
}
