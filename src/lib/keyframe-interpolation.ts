import type { Keyframe, CameraKeyframe, EasingType } from '../types';
import * as turf from '@turf/turf';

// ========== 缓动函数 ==========

const easings: Record<EasingType, (t: number) => number> = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => t * (2 - t),
  easeInOut: (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
  cubicIn: (t) => t * t * t,
  cubicOut: (t) => (--t) * t * t + 1,
  cubicInOut: (t) => t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
  spring: (t) => {
    const c4 = (2 * Math.PI) / 3;
    return t === 0 ? 0 : t === 1 ? 1 :
      Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
  bounce: (t) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
};

// ========== 基础工具 ==========

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 按类型取缓动函数（供地图 easeTo 等复用，保证与关键帧一致） */
export function getEasing(type: string): (t: number) => number {
  return easings[type as EasingType] || easings.linear;
}

// ========== 关键帧插值 ==========

export function interpolateKeyframes<T>(
  keyframes: Keyframe<T> | Keyframe<T>[],
  frame: number,
  interpolator: (a: T, b: T, t: number) => T = (a, b, t) => {
    if (typeof a === 'number' && typeof b === 'number') {
      return lerp(a, b, t) as T;
    }
    return t < 0.5 ? a : b;
  }
): T {
  const kfArray = Array.isArray(keyframes) ? keyframes : [keyframes];

  if (kfArray.length === 0) {
    throw new Error('No keyframes provided');
  }

  if (kfArray.length === 1) {
    return kfArray[0].value;
  }

  let prev = kfArray[0];
  let next = kfArray[kfArray.length - 1];

  for (let i = 0; i < kfArray.length - 1; i++) {
    if (frame >= kfArray[i].frame && frame <= kfArray[i + 1].frame) {
      prev = kfArray[i];
      next = kfArray[i + 1];
      break;
    }
  }

  if (frame <= prev.frame) return prev.value;
  if (frame >= next.frame) return next.value;

  const range = next.frame - prev.frame;
  const progress = range === 0 ? 0 : (frame - prev.frame) / range;
  const easing = easings[next.easing || 'linear'];
  const t = easing(progress);

  return interpolator(prev.value, next.value, t);
}

// ========== 坐标插值 ==========

export function interpolateCoordinates(
  a: [number, number],
  b: [number, number],
  t: number
): [number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
}

// ========== 路径插值 ==========

export function interpolatePath(
  path: [number, number][],
  progress: number
): [number, number] {
  if (path.length === 0) return [0, 0];
  if (path.length === 1) return path[0];

  const line = turf.lineString(path);
  const length = turf.length(line);
  const distance = length * Math.max(0, Math.min(1, progress));
  const point = turf.along(line, distance);
  return point.geometry.coordinates as [number, number];
}

// ========== 相机插值 ==========

/**
 * 当前帧归属哪个视角关键帧：处于「飞行区」时归属目标关键帧（i+1），否则停在 i。
 * 编辑端与导出端**必须共用**（此前两端各写一份，改一处就会「预览镜头 ≠ 导出镜头」）。
 */
export function resolveKfIndex(kfs: CameraKeyframe[], frame: number, fps: number): number {
  if (kfs.length === 0) return -1;
  for (let i = 0; i < kfs.length - 1; i++) {
    const next = kfs[i + 1];
    const gap = Math.max(0, next.frame - kfs[i].frame);
    const move = typeof next.moveDuration === 'number' ? Math.min(next.moveDuration, gap) : Math.min(2 * fps, gap);
    const moveStart = next.frame - move;
    if (frame < moveStart) return i;        // 停留区：显示视角 i
    if (frame <= next.frame) return i + 1;  // 飞行区：正飞向视角 i+1
  }
  return kfs.length - 1;
}

export function interpolateCamera(
  keyframes: CameraKeyframe[],
  frame: number,
  fps: number
): CameraKeyframe {
  if (keyframes.length === 0) {
    return { frame, center: [104.0, 35.0], zoom: 4 };
  }
  const arr = [...keyframes].sort((a, b) => a.frame - b.frame);

  if (arr.length === 1 || frame <= arr[0].frame) return { ...arr[0], frame };
  const last = arr[arr.length - 1];
  if (frame >= last.frame) return { ...last, frame };

  // 找到所在段 [a → b]
  let a = arr[0], b = last;
  for (let i = 0; i < arr.length - 1; i++) {
    if (frame >= arr[i].frame && frame <= arr[i + 1].frame) {
      a = arr[i]; b = arr[i + 1];
      break;
    }
  }

  const gap = Math.max(0, b.frame - a.frame);
  if (gap === 0) return { ...b, frame };

  // 移动窗口：默认 2 秒（不超过段长）；配置 moveDuration 后以其为准
  const dRaw = typeof b.moveDuration === 'number'
    ? Math.min(b.moveDuration, gap)
    : Math.min(2 * fps, gap);
  const startFrame = b.frame - dRaw;

  if (frame <= startFrame) return { ...a, frame };

  const progress = dRaw === 0 ? 0 : (frame - startFrame) / dRaw;
  const easing = easings[b.easing || 'linear'];
  const t = easing(Math.max(0, Math.min(1, progress)));

  return {
    center: interpolateCoordinates(a.center, b.center, t),
    zoom: lerp(a.zoom, b.zoom, t),
    pitch: lerp(a.pitch || 0, b.pitch || 0, t),
    bearing: lerp(a.bearing || 0, b.bearing || 0, t),
    frame,
    easing: b.easing,
  };
}
// 注：总时长计算已迁到 lib/project-duration.ts（按内容结束帧，而非容器 endFrame）
