// 帧 ⇄ 秒 换算与格式化工具（内部数据仍以帧存储，仅展示/输入用秒）

export function frameToSeconds(frame: number, fps: number): number {
  return fps > 0 ? frame / fps : frame;
}

export function secondsToFrame(seconds: number, fps: number): number {
  return fps > 0 ? Math.max(0, Math.round(seconds * fps)) : Math.round(seconds);
}

/** 把帧数格式化为 mm:ss 时钟（按 fps） */
export function formatTimeFromFrames(frame: number, fps: number): string {
  return formatClock(frameToSeconds(frame, fps));
}

/** 把秒格式化为 mm:ss 时钟 */
export function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
}

/** 保留两位小数 */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 时间窗整体平移：撞边界时**保长**（贴边后不再压缩区间，只是停住）。
 * 两端各自钳制会让拖到片头/片尾时的时长被静默改变。
 */
export function clampWindowMove(
  origStart: number, origEnd: number, delta: number, lo: number, hi: number,
): [number, number] {
  let s = origStart + delta;
  let e = origEnd + delta;
  if (s < lo) { e += lo - s; s = lo; }
  if (e > hi) { s -= e - hi; e = hi; }
  return [Math.max(lo, s), Math.min(hi, e)];
}
