// 缓动类型的友好命名（技术名保留为 title）
import type { EasingType } from '../types';

export const EASING_OPTIONS: { value: EasingType; label: string; title: string }[] = [
  { value: 'easeInOut', label: '平滑', title: 'easeInOut · 慢起快中慢收' },
  { value: 'linear', label: '匀速', title: 'linear · 恒定速度' },
  { value: 'easeIn', label: '缓入', title: 'easeIn · 起步渐快' },
  { value: 'easeOut', label: '急停', title: 'easeOut · 快进急减速停' },
  { value: 'cubicIn', label: '加速', title: 'cubicIn' },
  { value: 'cubicOut', label: '减速', title: 'cubicOut' },
  { value: 'cubicInOut', label: '强平滑', title: 'cubicInOut' },
  { value: 'spring', label: '弹性', title: 'spring · 到达带弹性回弹' },
  { value: 'bounce', label: '弹跳', title: 'bounce · 落地弹跳' },
];

export function easingLabel(v?: string): string {
  return EASING_OPTIONS.find((o) => o.value === v)?.label || v || 'linear';
}
