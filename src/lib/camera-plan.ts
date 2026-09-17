/**
 * camera-plan.ts — 确定性镜头编排（**无需 AI**）
 *
 * 给一章生成一组基础关键帧：起点概览 → 缓慢推近/微移 → 结束前落位。
 * 有具体目标（地名解析结果 / 手动给定）时以其为中心，否则用默认中国概览中心。
 * 生成结果就是普通 `CameraKeyframe[]`，可在「视角属性」面板逐项编辑。
 */
import type { CameraKeyframe } from '../types';

export interface CameraPlanTarget {
  center: [number, number];
  zoom?: number;
}

/**
 * @param startFrame 本章起始绝对帧
 * @param endFrame 本章结束绝对帧
 * @param fps 帧率
 * @param target 可选目标（中心 + 起始缩放）；缺省用中国概览
 */
export function planChapterCamera(
  startFrame: number,
  endFrame: number,
  fps: number,
  target?: CameraPlanTarget | null,
): CameraKeyframe[] {
  const center: [number, number] = target?.center ?? [104.0, 35.0];
  const baseZoom = target?.zoom ?? 4;
  const dur = Math.max(1, endFrame - startFrame);
  const round1 = (v: number) => Math.round(v * 10) / 10;
  const moveDur = Math.max(1, Math.round(fps * 1.6)); // 起飞提前量，默认约 1.6s

  const kfs: CameraKeyframe[] = [
    { frame: startFrame, center, zoom: baseZoom, easing: 'easeInOut' },
  ];
  // 中段缓慢推近
  const mid = startFrame + Math.round(dur * 0.5);
  if (mid > startFrame + Math.round(fps * 0.5)) {
    kfs.push({ frame: mid, center, zoom: round1(baseZoom + 0.7), easing: 'easeInOut', moveDuration: moveDur });
  }
  // 结束前落位（近景）
  const endKf = startFrame + Math.round(dur * 0.9);
  if (endKf > mid + Math.round(fps * 0.5)) {
    kfs.push({ frame: endKf, center, zoom: round1(baseZoom + 1.4), easing: 'easeInOut', moveDuration: moveDur });
  }
  return kfs;
}
