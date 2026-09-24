/**
 * taskStore — 在途异步任务的调度器
 *
 * 状态全在 `task` 表里，不在内存：关窗口、刷新页面、甚至换一次进程，重启后 hydrate
 * 把到点的行捞回来接着推。这是这张表存在的唯一理由（`providerTaskId` 只在一次调用内有意义，
 * 几十分钟就过期，所以「续跑」指的是接着查、接着取产物，不是凭空造任务）。
 *
 * 循环放在渲染端而不是主进程：`${}` 求值、outputs、异步配对这套引擎只有渲染端一份，
 * 主进程再实现一遍就是「同一条事实两处真相」（AGENTS §6.24 那条老教训）。
 */
import { create } from 'zustand';
import type { TaskRow } from '../types';
import type { InstanceDef } from '../lib/request-engine';
import { IS_DESKTOP } from '../lib/backend';
import { useProviderStore } from './providerStore';
import { useProjectStore } from './projectStore';
import { decodeAudioDuration, queryStep, submitStep } from '../lib/providers';
import { putAssetBytes } from '../lib/assets';
import { retriable } from '../lib/request-engine';

/** 一次动作的入参：调用级参数原样存进 input_json，重试 = 取它重发 */
export interface StartTask {
  category: 'tts' | 'image';
  providerId: string;
  projectId?: string;
  entryId?: string;
  batchId?: string;
  input: Record<string, unknown>;
}

interface TaskState {
  rows: TaskRow[];
  /**
   * 跑完的产物（assetId + 时长），**只在内存里**，不落库：
   * 弹窗开着时直接从这儿拿（不必等字幕行先落库）；关着时由 applyResult 回填到项目条目上。
   */
  results: Record<string, { assetId: string; durationSec: number }>;
  /** 启动时把没跑完的捞回来接着推（顺带清掉很久以前的已结束行） */
  hydrate: () => Promise<void>;
  start: (t: StartTask) => Promise<TaskRow>;
  cancelBatch: (batchId: string) => Promise<void>;
  /** 某批次的进度（done = 已结束的行数） */
  progressOf: (batchId: string) => { done: number; total: number };
  /** 推进一步（导出给回归与手动重试；平时由 tick 驱动） */
  advance: (taskId: string) => Promise<TaskRow | undefined>;
  tick: () => Promise<void>;
}

const now = () => Date.now();
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || d);

/** 查询节奏与重试：都是实例级参数（账号限额是账号的事，不属模板形状） */
function pacing(inst: InstanceDef) {
  const v = inst.values.instance ?? {};
  return {
    intervalMs: num(v.queryIntervalMs, 2000),
    maxAttempts: num(v.queryMaxAttempts, 300),
    retries: num(v.retryTimes, 2),
  };
}

const isOpen = (t: TaskRow) => t.status === 'submitting' || t.status === 'querying';

let timer: ReturnType<typeof setInterval> | null = null;
/**
 * 一轮没跑完就不开下一轮。
 * setInterval 不会等 await：一条同步合成要 1.4s（比 1s 的轮询间隔长），
 * 上一轮还挂在 fetch 上，下一轮又从库里捞到同一条 `submitting` 行 —— 于是同一个任务
 * 发两次请求、拿两份产物（实测：task 表一行，asset 表两行）。
 */
let ticking = false;
function ensureTicking() {
  if (!IS_DESKTOP || timer) return;
  timer = setInterval(() => { void useTaskStore.getState().tick(); }, 1000);
}

async function persist(row: TaskRow): Promise<TaskRow> {
  const stamped = { ...row, updatedAt: now() };
  if (IS_DESKTOP) {
    const r = await window.mapvideo!.tasks.save(stamped);
    stamped.taskId = r.taskId;
  }
  useTaskStore.setState((s) => ({
    rows: s.rows.some((x) => x.taskId === stamped.taskId)
      ? s.rows.map((x) => (x.taskId === stamped.taskId ? stamped : x))
      : [...s.rows, stamped],
  }));
  return stamped;
}

async function applyResult(row: TaskRow, bytes: Uint8Array, mime?: string) {
  // 产物字节当场进素材库：项目里只留 assetId（一条 6 秒配音 ≈ 400KB 文本，内联会把存档撑爆），
  // 而异步查询回来的链接是带时效的 —— 不留链接、只留我们自己的这一份
  const kind = row.category === 'tts' ? 'audio' : 'image';
  const { assetId } = await putAssetBytes(bytes, mime || (row.category === 'tts' ? 'audio/mpeg' : 'image/png'), row.taskId, kind);
  const text = String(row.input?.text ?? '');
  const durationSec = kind === 'audio' ? await decodeAudioDuration(bytes, text) : 0;
  // 先留在内存：字幕弹窗开着时它直接取这一份，不必要求「先生成必须先落库」
  useTaskStore.setState((s) => ({ results: { ...s.results, [row.taskId]: { assetId, durationSec } } }));
  if (row.category !== 'tts' || !row.entryId) return;
  const project = useProjectStore.getState().project;
  if (!project || project.id !== row.projectId) return;            // 项目没开着：留给下一轮（见 advance 的门禁）
  if (!project.narration?.entries.some((e) => e.id === row.entryId)) return;  // 这条字幕还没落库，等弹窗「应用」
  const fps = project.globalConfig?.defaultFPS || 30;
  useProjectStore.getState().updateNarrationEntry(row.entryId, {
    audioId: assetId, durationFrames: Math.max(1, Math.round(durationSec * fps)), status: 'ready', error: undefined,
  });
}

export const useTaskStore = create<TaskState>((set, get) => ({
  rows: [],
  results: {},

  hydrate: async () => {
    if (!IS_DESKTOP) return;
    try {
      await window.mapvideo!.tasks.prune();
      const open = await window.mapvideo!.tasks.open();
      set({ rows: open });
      if (open.length) console.log(`[tasks] 续跑在途任务 ${open.length} 条`);
      ensureTicking();
    } catch (e) {
      console.warn('[tasks] 读取失败:', e);
    }
  },

  start: async (t) => {
    const taskId = `tk_${Math.random().toString(36).slice(2, 10)}`;
    const row: TaskRow = {
      taskId, batchId: t.batchId ?? taskId, providerId: t.providerId,
      projectId: t.projectId, entryId: t.entryId, category: t.category,
      status: 'submitting', input: t.input, queryCount: 0, rebuildCount: 0,
      nextQueryAt: now(), createdAt: now(),
    };
    ensureTicking();
    return persist(row);
  },

  cancelBatch: async (batchId) => {
    for (const r of get().rows.filter((x) => x.batchId === batchId && isOpen(x))) {
      await persist({ ...r, status: 'canceled', finishedAt: now() });
    }
  },

  progressOf: (batchId) => {
    const rows = get().rows.filter((x) => x.batchId === batchId);
    return { done: rows.filter((x) => !isOpen(x)).length, total: rows.length };
  },

  /**
   * 推进一条任务一步。
   * 项目没开着时**不回填也不失败** —— 把下次时间推后，等那个项目打开再跑
   * （产物链接有时效，所以宁可晚点查，也别查回来却没地方放）。
   */
  advance: async (taskId) => {
    const row = get().rows.find((x) => x.taskId === taskId);
    if (!row || !isOpen(row)) return row;
    const inst = useProviderStore.getState().instances.find((x) => x.id === row.providerId);
    if (!inst) return persist({ ...row, status: 'failed', error: `实例「${row.providerId}」已经不在了`, finishedAt: now() });
    if (row.projectId && useProjectStore.getState().project?.id !== row.projectId) {
      return persist({ ...row, nextQueryAt: now() + 5000 });
    }
    const { intervalMs, maxAttempts, retries } = pacing(inst);
    try {
      if (row.status === 'submitting') {
        const r = await submitStep(inst, (row.input ?? {}) as Record<string, unknown>);
        if (r.done) {
          await applyResult(row, r.bytes, r.mime);
          return persist({ ...row, status: 'success', finishedAt: now() });
        }
        return persist({ ...row, status: 'querying', providerTaskId: r.providerTaskId, nextQueryAt: now() + intervalMs });
      }
      const upstream = { ...(row.input?.upstream as Record<string, unknown> | undefined), taskId: row.providerTaskId };
      const q = await queryStep(inst, upstream);
      if (q.done) {
        await applyResult(row, q.bytes, q.mime);
        return persist({ ...row, status: 'success', finishedAt: now() });
      }
      if (row.queryCount + 1 >= maxAttempts) {
        return persist({ ...row, status: 'failed', error: `查了 ${row.queryCount + 1} 次还没完成（最后一次状态 ${q.status ?? '未知'}）` });
      }
      return persist({ ...row, queryCount: row.queryCount + 1, nextQueryAt: now() + intervalMs });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 只重试限流与服务端故障；业务错（模型名不存在、参数非法）重试只是白烧配额
      if (retriable(e) && row.queryCount < retries) {
        return persist({ ...row, queryCount: row.queryCount + 1, error: msg, nextQueryAt: now() + intervalMs * (row.queryCount + 2) });
      }
      return persist({ ...row, status: 'failed', error: msg, finishedAt: now() });
    }
  },

  /**
   * 一轮：捞到点的任务，按「同一实例最多 batchConcurrency 条」推进（账号限额是实例的事）。
   * 串行 await 而不是并发 spawn —— 一轮里谁在跑一目了然，也不会有两个循环互相抢行。
   */
  tick: async () => {
    if (!IS_DESKTOP || ticking) return;
    ticking = true;
    try {
      const due = (await window.mapvideo!.tasks.due()).filter(isOpen);
      if (!due.length) return;
      useTaskStore.setState((s) => ({
        rows: [...s.rows, ...due.filter((d) => !s.rows.some((x) => x.taskId === d.taskId))],
      }));
      const perProvider = new Map<string, number>();
      const limitOf = (providerId: string) => {
        const inst = useProviderStore.getState().instances.find((x) => x.id === providerId);
        return Math.max(1, num(inst?.values.instance?.batchConcurrency, 1));
      };
      for (const row of due) {
        const used = perProvider.get(row.providerId) ?? 0;
        if (used >= limitOf(row.providerId)) continue;
        perProvider.set(row.providerId, used + 1);
        await get().advance(row.taskId);
      }
    } finally {
      ticking = false;
    }
  },
}));
