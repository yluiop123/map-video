/**
 * chapter-duration.ts — 章节的「内容结束帧」
 *
 * 背景：章节的 `endFrame` 是用户手动设的**容器长度**（可留白 / 定格），
 * 但导出长度应当跟随内容实际结束的位置 —— 否则内容早结束会拖一段空白，
 * 内容超出又会被裁掉。
 *
 * 约定：
 *   · 元素 / 弹窗 / 特效窗口 / 相机关键帧 / 字幕条：存的是**绝对帧**
 *   · 配乐 `music[]`：存的是**章内相对帧**（见 MapVideo：`from={chapterStart + m.startFrame}`）
 */
import type { Chapter } from '../types';

/** 章节内所有「随时间存在的内容」的最后一帧（绝对帧）；无内容时返回 startFrame */
export function chapterContentEndFrame(ch: Chapter): number {
  let end = ch.startFrame;
  const push = (v?: number | null) => {
    if (typeof v === 'number' && Number.isFinite(v) && v > end) end = v;
  };

  for (const el of ch.elements || []) {
    push(el.endFrame);
    push((el as { moveEndFrame?: number }).moveEndFrame);   // 移动图标动画结束
  }
  for (const kf of ch.camera || []) push(kf.frame);          // 最后一个视角的到达帧
  for (const o of ch.overlays || []) push(o.endFrame);
  for (const fx of ch.fx || []) push(fx.endFrame);
  for (const e of ch.narration?.entries || []) {
    push((e.startFrame ?? ch.startFrame) + (e.durationFrames ?? 0));
  }
  for (const m of ch.music || []) push(ch.startFrame + (m.endFrame || 0));  // 章内相对 → 绝对

  return end;
}

/**
 * 项目内容总帧数：各章节内容结束帧的最大值。
 * 章节内没有任何随时间的内容时回退到它的 endFrame（避免空章节被算成 0 长度而消失）。
 */
export function projectContentDuration(chapters: Chapter[]): number {
  if (!chapters.length) return 0;
  return Math.max(
    ...chapters.map((ch) => {
      const contentEnd = chapterContentEndFrame(ch);
      return contentEnd > ch.startFrame ? contentEnd : ch.endFrame;
    }),
  );
}
