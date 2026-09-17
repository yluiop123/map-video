/**
 * project-duration.ts — 项目的「内容结束帧」
 *
 * 背景：项目的 `endFrame` 是容器长度（可留白 / 定格），
 * 但导出长度应当跟随内容实际结束的位置 —— 否则内容早结束会拖一段空白，
 * 内容超出又会被裁掉。
 *
 * 约定：
 *   · 元素 / 弹窗 / 特效窗口 / 相机关键帧 / 字幕条：存的是**绝对帧**
 *   · 配乐是**项目级**单轨多段（绝对帧），不影响单章长度，故不参与本节计算
 */
import type { MapVideoProject } from '../types';

/** 项目内所有「随时间存在的内容」的最后一帧（绝对帧）；无内容时返回 startFrame */
export function projectContentEndFrame(ch: MapVideoProject): number {
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
  return end;
}

/**
 * 项目内容总帧数：各内容结束帧的最大值。
 * 无任何随时间内容时回退到 endFrame（避免被算成 0 长度而消失）。
 */
export function projectContentDuration(projects: MapVideoProject[]): number {
  if (!projects.length) return 0;
  return Math.max(
    ...projects.map((ch) => {
      const contentEnd = projectContentEndFrame(ch);
      return contentEnd > ch.startFrame ? contentEnd : ch.endFrame;
    }),
  );
}

/** 「全程显示」的结束帧：项目容器长度与内容实际结束的较大者（元素自定义显示时间的关闭基准）。 */
export function fullDisplayEnd(project: MapVideoProject): number {
  return Math.max(1, Math.round(Math.max(project.endFrame || 0, projectContentEndFrame(project))));
}
