/**
 * icon-library.ts — 图标库（lucide）→ 位图 dataURL
 *
 * ⚠ 实测：lucide-react 的 `icons` 导出的是**组件表**（`MapPin` 是组件对象，不是 IconNode 数组），
 * 所以要给地图用必须两步：① 拿到组件 ② `react-dom/server` 渲染成 SVG 字符串 → dataURL。
 * UI 预览则直接 React 渲染组件即可，无需经过 SVG。
 *
 * 体积策略（2026-09-11 改版）：不再 `import('lucide-react')` 全量动态导入 ——
 * 5000+ 图标的动态 chunk 在 dev 下预构建极慢，面板会一直停在「正在加载图标库」。
 * 改为**精选集静态具名导入**（tree-shake 后只打包这几十个），同步可用、秒开。
 * 注意 lucide 0.4xx 重命名：AlertTriangle→TriangleAlert、CheckCircle2→CircleCheckBig、
 * XCircle→CircleX、Unlock→LockOpen（BUILTIN_ICON_NAMES 已同步）。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LucideIcon } from 'lucide-react';
import {
  MapPin, MapPinned, LocateFixed, Crosshair, Navigation, Compass, Route, Milestone, Signpost,
  Target, Swords, Shield, ShieldAlert, Bomb, Radar, Rocket,
  Plane, PlaneTakeoff, Ship, Anchor, Truck, Car, TrainFront, Bike,
  Building2, Factory, Warehouse, TowerControl, Radio, Antenna, Satellite, Fuel,
  User, Users, UserRound, Flag, Star, Heart, Skull,
  TriangleAlert, Info, CircleCheckBig, CircleX, Eye, EyeOff, Lock, LockOpen,
  Circle, Square, Triangle, Hexagon, Diamond, ArrowUp, ArrowRight, Zap, Flame, Cloud, Wind, Waves,
} from 'lucide-react';

/** lucide 图标组件类型（ForwardRef 组件；与 LucideIcon 一致） */
export type IconComponent = LucideIcon;

/** 精选图标表（键=图标名）。静态打包、同步可用；按类别维护，与 BUILTIN_ICON_NAMES 一一对应 */
const LUCIDE_ICONS: Record<string, IconComponent> = {
  // 位置 / 导航
  MapPin, MapPinned, LocateFixed, Crosshair, Navigation, Compass, Route, Milestone, Signpost,
  // 军事 / 目标
  Target, Swords, Shield, ShieldAlert, Bomb, Radar, Rocket,
  // 交通 / 载具
  Plane, PlaneTakeoff, Ship, Anchor, Truck, Car, TrainFront, Bike,
  // 设施 / 建筑
  Building2, Factory, Warehouse, TowerControl, Radio, Antenna, Satellite, Fuel,
  // 人物 / 编组
  User, Users, UserRound, Flag, Star, Heart, Skull,
  // 状态 / 警示（lucide 0.4xx 新名）
  TriangleAlert, Info, CircleCheckBig, CircleX, Eye, EyeOff, Lock, LockOpen,
  // 通用
  Circle, Square, Triangle, Hexagon, Diamond, ArrowUp, ArrowRight, Zap, Flame, Cloud, Wind, Waves,
};

/** 精选图标组件表（同步返回，不再有加载态） */
export function loadLucideIcons(): Record<string, IconComponent> {
  return LUCIDE_ICONS;
}

/** 图标组件 → SVG dataURL（供 MapLibre 位图管线使用） */
export function iconComponentToDataUrl(
  Icon: IconComponent,
  color = '#FFFFFF',
  strokeWidth = 2,
): string {
  const svg = renderToStaticMarkup(createElement(Icon, { color, strokeWidth, size: 64 }));
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** 按「库 + 图标名」取位图 dataURL；非 lucide 返回 null（自建库走 custom_symbol） */
export function iconNameToDataUrl(
  lib: string,
  name: string,
  color = '#FFFFFF',
  strokeWidth = 2,
): string | null {
  if (lib !== 'lucide') return null;
  const Icon = LUCIDE_ICONS[name];
  return Icon ? iconComponentToDataUrl(Icon, color, strokeWidth) : null;
}

/** 图标库面板用：把候选名与真实存在的图标取交集 */
export function filterExistingIcons(names: string[]): string[] {
  return names.filter((n) => !!LUCIDE_ICONS[n]);
}
