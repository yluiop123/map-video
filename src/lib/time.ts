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
