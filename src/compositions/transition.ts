import type { CSSProperties } from 'react';
import type { TransitionType } from '../types';

/**
 * 章节进入转场的样式计算。
 * 一个章节被渲染为两层：前章画面（outgoing，转场时淡出/移出）在下，
 * 本章画面（incoming，套用进入效果）在上。部分类型（fadeBlack/fadeWhite）
 * 用一个全屏遮罩来实现——遮罩随 progress 淡出，露出本章画面。
 *
 * progress 取值范围 0→1：0 表示转场刚开始（完全显示上一章），
 * 1 表示转场结束（完全显示本章）。
 */
export interface TransitionStyle {
  /** 本章画面（进入方）套用的样式 */
  incoming: CSSProperties;
  /** 前章画面（退出方）套用的样式 */
  outgoing: CSSProperties;
  /** 是否需要渲染前章画面 */
  showPrevious: boolean;
  /** 全屏遮罩颜色（fadeBlack / fadeWhite），其余类型为 undefined */
  maskColor?: string;
}

export function buildTransition(
  type: TransitionType | undefined,
  progress: number
): TransitionStyle {
  const p = clamp01(progress);

  switch (type) {
    case 'fade':
      return {
        incoming: { opacity: p },
        outgoing: { opacity: 1 - p },
        showPrevious: true,
      };

    case 'dissolve':
      return {
        incoming: { opacity: p, filter: `blur(${(1 - p) * 8}px)` },
        outgoing: { opacity: 1 - p },
        showPrevious: true,
      };

    case 'wipeLeft':
      return {
        // 从左边缘向右展开，逐步露出本章画面
        incoming: { clipPath: `inset(0 0 0 ${(1 - p) * 100}%)` },
        outgoing: { opacity: 1 },
        showPrevious: true,
      };

    case 'wipeRight':
      return {
        // 从右边缘向左展开
        incoming: { clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` },
        outgoing: { opacity: 1 },
        showPrevious: true,
      };

    case 'zoom':
      return {
        // 本章画面由大缩小 + 淡入，产生"推入"感
        incoming: { transform: `scale(${1.6 - 0.6 * p})`, opacity: p < 0.25 ? p * 4 : 1 },
        outgoing: { opacity: 1 - p },
        showPrevious: true,
      };

    case 'mapFly':
      return {
        // 放大飞入：配合地图相机移动，视觉上是镜头拉近
        incoming: { transform: `scale(${0.62 + 0.38 * p})`, opacity: p },
        outgoing: { opacity: 1 - p * 0.6 },
        showPrevious: true,
      };

    case 'fadeBlack':
      return {
        incoming: { opacity: 1 },
        outgoing: { opacity: 1 },
        maskColor: '#000000',
        showPrevious: false,
      };

    case 'fadeWhite':
      return {
        incoming: { opacity: 1 },
        outgoing: { opacity: 1 },
        maskColor: '#ffffff',
        showPrevious: false,
      };

    case 'cut':
    case undefined:
    default:
      return { incoming: {}, outgoing: {}, showPrevious: false };
  }
}

export function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}
