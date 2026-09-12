/**
 * route-time.ts — 路线「非匀速移动」的逐点到达时间
 *
 * · 均匀移动（默认）：整条路径在 [moveStartFrame, moveEndFrame] 内按**路径长度**匀速推进
 * · 非匀速移动：为每个路径点显式指定到达帧 `pointTimes[i]`
 *
 * 关闭「均匀移动」时，用按长度分配的到达时间作为初始值（等价于匀速），
 * 用户再逐点微调；渲染端（map-renderer）只依赖 pointTimes 与当前帧。
 */
import * as turf from '@turf/turf';

/** 按路径长度比例在 [start, end] 内为每个路径点分配到达帧；点数不足返回空数组 */
export function distributePointTimes(coords: [number, number][], start: number, end: number): number[] {
  if (!coords || coords.length < 2) return [];
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = turf.length(turf.lineString([coords[i - 1], coords[i]]));
    segs.push(d);
    total += d;
  }
  const out: number[] = [start];
  let acc = 0;
  for (const d of segs) {
    acc += d;
    out.push(total > 0 ? start + ((end - start) * acc) / total : end);
  }
  return out;
}

/**
 * 取可用的 pointTimes：数量与路径点一致则沿用（并修正单调性），
 * 缺失或点数已变（增删路径点后）则按长度重新分配。
 */
export function ensurePointTimes(
  coords: [number, number][],
  times: number[] | undefined,
  start: number,
  end: number,
): number[] {
  if (!coords || coords.length < 2) return [];
  if (times && times.length === coords.length) {
    const out = [...times];
    for (let i = 1; i < out.length; i++) {
      if (!(out[i] >= out[i - 1])) out[i] = out[i - 1];   // 单调不减（NaN 也一并兜住）
    }
    return out;
  }
  return distributePointTimes(coords, start, end);
}
