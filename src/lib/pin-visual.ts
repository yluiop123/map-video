/**
 * pin-visual.ts — 标记形态的「能力矩阵」与资源解析（单一事实源）
 *
 * 这张矩阵同时驱动三处，改一处必须同步另两处：
 *   ① 属性面板：不支持的控件直接隐藏（如模型不显示「贴地」、GIF 不显示「颜色」）
 *   ② 数据库 CHECK：docs/db-schema-v2.sql 的 element_marker 约束
 *   ③ 渲染端：按形态选择管线（位图 / 逐帧 / 3D / 矢量）
 */
import type { PointElement, PointShape, VisualMeta } from '../types';
import { getBuiltinAsset, type BuiltinAsset } from './builtin-assets';

/** 资源来源类型 */
export type PinSourceKind = 'none' | 'media' | 'icon';

export interface PinCapability {
  /** 面板显示名 */
  label: string;
  /** 可着色（模型 / GIF / emoji 为 false） */
  canTint: boolean;
  /** 可贴地 flat（模型为 false） */
  canFlat: boolean;
  /** 可旋转 */
  canRotate: boolean;
  /** 可缩放 */
  canScale: boolean;
  /** 资源来源要求：none=矢量现画 / media=内置或上传 / icon=图标库 */
  source: PinSourceKind;
  /** 该形态支持的 visualMeta 字段（其余字段在切换形态时剔除） */
  metaFields: (keyof VisualMeta)[];
}

/** ★ 能力矩阵（与 element_marker 的 CHECK 约束一一对应） */
export const PIN_CAPABILITIES: Record<PointShape, PinCapability> = {
  circle: { label: '圆点', canTint: true, canFlat: true, canRotate: true, canScale: true, source: 'none', metaFields: [] },
  pin: { label: '水滴针', canTint: true, canFlat: true, canRotate: true, canScale: true, source: 'none', metaFields: [] },
  bubble: { label: '气泡', canTint: true, canFlat: true, canRotate: true, canScale: true, source: 'none', metaFields: [] },
  text: { label: '文字', canTint: true, canFlat: true, canRotate: true, canScale: true, source: 'none', metaFields: [] },
  emoji: { label: '表情', canTint: false, canFlat: true, canRotate: true, canScale: true, source: 'none', metaFields: [] },
  image: { label: '图片', canTint: true, canFlat: true, canRotate: true, canScale: true, source: 'media', metaFields: ['fit', 'tintable'] },
  gif: { label: '动图', canTint: true, canFlat: true, canRotate: true, canScale: true, source: 'media', metaFields: ['fps', 'loop'] },
  model: { label: '模型', canTint: true, canFlat: false, canRotate: true, canScale: true, source: 'media', metaFields: ['altitude', 'autoRotate', 'spin', 'pitchAlign', 'animation'] },
  icon: { label: '图标库', canTint: true, canFlat: true, canRotate: true, canScale: true, source: 'icon', metaFields: ['strokeWidth'] },
  military_symbol: { label: '军标', canTint: true, canFlat: true, canRotate: true, canScale: true, source: 'media', metaFields: ['fit', 'tintable'] },
};

export const ALL_POINT_SHAPES = Object.keys(PIN_CAPABILITIES) as PointShape[];

/** 取形态能力；未知形态按 circle 处理（兼容旧数据） */
export function getPinCapability(shape?: PointShape | null): PinCapability {
  return (shape && PIN_CAPABILITIES[shape]) || PIN_CAPABILITIES.circle;
}

/** 该形态是否为资源形态（image / gif / model / icon） */
export function isResourceShape(shape?: PointShape | null): boolean {
  return !!shape && getPinCapability(shape).source !== 'none';
}

/** 资源解析结果：渲染端据此决定取什么 */
export type PinVisualSource =
  | { type: 'builtin'; asset: BuiltinAsset }
  | { type: 'asset'; assetId: string }
  | { type: 'icon'; lib: string; name: string }
  | { type: 'legacy-url'; url: string }
  | { type: 'none' };

/** 解析元素的资源来源（顺序：图标库 → 内置 → 上传素材 → 旧 iconUrl） */
export function resolvePinVisualSource(el: Pick<PointElement, 'shape' | 'builtinId' | 'assetId' | 'iconLib' | 'iconName' | 'iconUrl'>): PinVisualSource {
  if (el.shape === 'icon' && el.iconName) {
    return { type: 'icon', lib: el.iconLib || 'lucide', name: el.iconName };
  }
  const builtin = getBuiltinAsset(el.builtinId);
  if (builtin) return { type: 'builtin', asset: builtin };
  if (el.assetId) return { type: 'asset', assetId: el.assetId };
  if (el.iconUrl) return { type: 'legacy-url', url: el.iconUrl };
  return { type: 'none' };
}

/** 资源是否已配置（UI 用来提示「请选择图片/模型」，避免空态） */
export function hasPinResource(el: Pick<PointElement, 'shape' | 'builtinId' | 'assetId' | 'iconUrl' | 'iconName'>): boolean {
  if (!el.shape || getPinCapability(el.shape).source === 'none') return true;
  return resolvePinVisualSource(el).type !== 'none';
}

/** 剔除该形态不支持的 visualMeta 字段（切换形态时调用，避免残留脏数据） */
export function pruneVisualMeta(shape: PointShape, meta?: VisualMeta): VisualMeta | undefined {
  if (!meta) return undefined;
  const allowed = getPinCapability(shape).metaFields;
  const out: VisualMeta = {};
  for (const k of allowed) {
    const v = meta[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * 切换到某形态时的默认值补丁（保证切过去就有可用资源，不是空态）。
 * 会同时清掉不该有的字段（颜色 / 贴地 / 资源引用 / visualMeta 残留）。
 */
export function defaultVisualFor(shape: PointShape, el: PointElement): Partial<PointElement> {
  const cap = getPinCapability(shape);
  const base: Partial<PointElement> = {
    shape,
    // 不支持的能力一律清空，保证与数据库 CHECK 一致
    ...(cap.canTint ? {} : { color: undefined }),
    ...(cap.canFlat ? {} : { orientation: 'faceCam' as const, rotation: 0 }),
    // 资源引用先清空，再按形态赋默认
    builtinId: undefined,
    assetId: undefined,
    iconLib: undefined,
    iconName: undefined,
    visualMeta: pruneVisualMeta(shape, el.visualMeta),
  };

  switch (shape) {
    case 'circle':
      return { ...base, iconUrl: undefined, emoji: undefined, color: el.color || '#FF4444' };
    case 'pin':
      return { ...base, iconUrl: undefined, emoji: undefined, color: el.color || '#FF4444' };
    case 'bubble':
      return { ...base, iconUrl: undefined, emoji: undefined, color: el.color || '#FF4444' };
    case 'text':
      return { ...base, iconUrl: undefined, emoji: undefined, iconSize: 0 };
    case 'emoji':
      return { ...base, iconUrl: undefined, emoji: el.emoji || '📍' };
    case 'image':
      return { ...base, iconUrl: undefined, emoji: undefined, builtinId: 'image:flag', color: el.color || '#FFFFFF' };
    case 'gif':
      // 白色基图 + multiply 染色；默认白色=原色
      return { ...base, iconUrl: undefined, emoji: undefined, builtinId: 'gif:radar', color: el.color || '#FFFFFF' };
    case 'model':
      return {
        ...base,
        iconUrl: undefined,
        emoji: undefined,
        builtinId: 'model:drone',
        orientation: 'faceCam',
        rotation: 0,
        // 默认浅暖灰：纯白在强光下会过曝
        color: el.color || '#d7d3ce',
        visualMeta: { altitude: 0, spin: 0, autoRotate: 0, ...base.visualMeta },
      };
    case 'icon':
      return {
        ...base,
        iconUrl: undefined,
        emoji: undefined,
        iconLib: el.iconLib || 'lucide',
        iconName: el.iconName || 'MapPin',
        color: el.color || '#FFFFFF',
      };
    case 'military_symbol':
      // 军标 = 内置 SVG 线稿（白色框 + 兵种符号），multiply 染色；默认友军步兵
      return { ...base, iconUrl: undefined, emoji: undefined, builtinId: 'milsym:infantry', color: el.color || '#FFFFFF' };
    default:
      return base;
  }
}
