/**
 * audition.ts — 全应用共用的一个试听播放器
 *
 * 为什么要有这一个模块：字幕生成的逐行试听、音色区的试听、时间线预览各自 `new Audio()`
 * 时，互相不知道对方在响，表现就是「播下一条不停上一条、关掉弹窗还在响、两路声音叠着」。
 * 声音只应有一路 —— 和地图图层顺序同理，这条事实不能有两处真相。
 */

let current: HTMLAudioElement | null = null;

/** 停掉正在播的试听（没有在播时调用是安全的） */
export function stopAudition(): void {
  const el = current;
  current = null;
  if (el) { el.pause(); el.src = ''; }
}

/**
 * 播一条音频（dataURL 或 URL）：先把上一条停掉。
 * 返回 false 表示被浏览器的自动播放策略拦下；自然播完 / 出错时回调 onEnded。
 */
export async function playAudition(src: string, onEnded?: () => void): Promise<boolean> {
  stopAudition();
  const el = new Audio(src);
  current = el;
  const done = () => {
    if (current !== el) return;
    current = null;
    onEnded?.();
  };
  el.onended = done;
  el.onerror = done;
  try {
    await el.play();
    return true;
  } catch {
    done();
    return false;
  }
}
