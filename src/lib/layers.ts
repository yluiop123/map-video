/**
 * layers.ts — 图层工具：派生扁平元素、时间解析、公共图层库
 *
 * 数据模型：项目 = Layer[]，每个图层含自己的显隐 / 显示区间 / 元素列表。
 * `project.elements` 是**派生镜像**（store 的 patch 自动重算），供渲染 / 面板 / 相机等沿用扁平读取。
 */
import type { ConnectorElement, Layer, LayerType, MapElement } from '../types';
import { generateId } from '../types';
import { IS_DESKTOP } from './backend';

/** 元素类型 → 图层类型 */
export function layerTypeOf(el: MapElement): LayerType {
  switch (el.type) {
    case 'point': case 'flag': return 'marker';
    case 'line': case 'moving_point': case 'connector': return 'route';
    case 'polygon': case 'arrow': case 'double_arrow': case 'gathering': case 'encirclement': return 'shape';
    case 'territory': return 'territory';
    case 'geo_image': return 'image';
    default: return 'marker';
  }
}

export const LAYER_TYPE_LABEL: Record<LayerType, string> = {
  marker: '标记', route: '路线', shape: '形状', territory: '疆域', image: '图片',
};

export const LAYER_TYPES: LayerType[] = ['marker', 'route', 'shape', 'territory', 'image'];

/**
 * 图层默认序（也是地图叠放序）：标记 → 路线 → 形状 → 疆域 → 图片。
 * 列表里**靠前的显示在地图上层**，所以图片在最底、标记在最上。
 */
export const LAYER_RANK: Record<LayerType, number> = {
  marker: 0, route: 1, shape: 2, territory: 3, image: 4,
};

/**
 * 新图层插入到「按类型序」该在的位置：排在第一个类型序更靠后的图层之前。
 * 只定位新层，不重排既有层（用户拖动出来的自定义顺序要保留）。
 */
export function insertLayerSorted(layers: Layer[], layer: Layer): Layer[] {
  const r = LAYER_RANK[layer.type];
  const at = layers.findIndex((L) => LAYER_RANK[L.type] > r);
  if (at < 0) return [...layers, layer];
  return [...layers.slice(0, at), layer, ...layers.slice(at)];
}

/** 每类图层的「写入目标」（元素 id）；未设置 = 自动（该类第一个图层） */
export type TargetLayers = Partial<Record<LayerType, string>>;

/**
 * 新建 / 改类型时决定元素落到哪个图层：
 * 显式指定 → 用户记住的目标图层（须同类型）→ 该类第一个图层 → null（调用方新建）。
 */
export function resolveTargetLayerId(
  layers: Layer[] | undefined,
  type: LayerType,
  targets?: TargetLayers | null,
  explicitId?: string | null,
): string | null {
  const byId = (id?: string | null) => (id ? (layers || []).find((L) => L.id === id && L.type === type) : undefined);
  return (byId(explicitId) || byId(targets?.[type]) || (layers || []).find((L) => L.type === type))?.id ?? null;
}

/** 可移动到该元素的其它同类型图层（排除当前所在层） */
export function movableLayersFor(layers: Layer[] | undefined, el: MapElement): Layer[] {
  const type = layerTypeOf(el);
  const cur = (layers || []).find((L) => (L.elements || []).some((x) => x.id === el.id))?.id;
  return (layers || []).filter((L) => L.type === type && L.id !== cur);
}

/**
 * 从图层派生扁平元素数组（供渲染/面板读取）：
 * · 回填 layerId；
 * · 元素可见性 = 元素自身可见 && 图层可见；
 * · 时间：customTime 关 → 用图层显示区间；开 → 与图层区间取交集。
 */
export function deriveElements(layers: Layer[] | undefined): MapElement[] {
  const out: MapElement[] = [];
  for (const L of layers || []) {
    const ls = L.startFrame;
    const le = Math.max(L.startFrame, L.endFrame);
    const layerVisible = L.visible !== false;
    for (const el of L.elements || []) {
      const custom = el.customTime === true;
      const s = custom ? Math.max(el.startFrame, ls) : ls;
      const e = custom ? Math.min(el.endFrame, le) : le;
      out.push({
        ...el,
        layerId: L.id,
        visible: (el.visible !== false) && layerVisible && e > s,
        startFrame: s,
        endFrame: Math.max(s + 1, e),
      });
    }
  }
  return out;
}

/** 按 id 在图层中找到元素及其图层（返回引用，可直接改） */
export function findElementInLayers(layers: Layer[], elementId: string): { layer: Layer; element: MapElement; index: number } | null {
  for (const layer of layers || []) {
    const index = layer.elements.findIndex((el) => el.id === elementId);
    if (index >= 0) return { layer, element: layer.elements[index], index };
  }
  return null;
}

// ========== 公共图层库（全局，跨项目） ==========
// 桌面端：入库（public_layer + 5 张 public_element_* 表，见 electron/db-v2.mjs）；
// 网页端：Lite 无 SQLite，退回 localStorage（仅几何 JSON）。

export interface PublicLayerInfo {
  id: string;
  type: LayerType;
  name: string;
  count: number;
}

/** 网页端 localStorage 形态：整层（显示区间 + 元素，时间沿用源项目的绝对帧） */
export interface PublicLayer {
  id: string;
  type: LayerType;
  name: string;
  startFrame: number;
  endFrame: number;
  elements: MapElement[];
  savedAt: number;
}

/**
 * 复制体必须自洽：端点不在本图层内的连接线整条剔除。
 * 图层是单类型的，而连接线的端点常是另一图层的标记——带着解析不到的端点导入到别的项目，
 * 连接线会变成悬空引用（宁缺不悬空，与桌面端 SQL 侧 prune 同一规则）。
 */
export function pruneForeignConnectors(elements: MapElement[]): { kept: MapElement[]; dropped: string[] } {
  const ids = new Set(elements.map((el) => el.id));
  const dropped: string[] = [];
  const kept = elements.filter((el) => {
    if (el.type !== 'connector') return true;
    const c = el as ConnectorElement;
    const ok = (!c.fromElementId || ids.has(c.fromElementId)) && (!c.toElementId || ids.has(c.toElementId));
    if (!ok) dropped.push(c.name || c.id);
    return ok;
  });
  return { kept, dropped };
}

const LIB_KEY = 'mapvideo.publicLayers';

function listLocal(): PublicLayer[] {
  try {
    const raw = localStorage.getItem(LIB_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeLocal(list: PublicLayer[]): void {
  try { localStorage.setItem(LIB_KEY, JSON.stringify(list)); } catch { /* 容量不足等 */ }
}

/** 公共图层列表（桌面端走 DB；网页端 localStorage） */
export async function listPublicLayers(): Promise<PublicLayerInfo[]> {
  if (IS_DESKTOP && window.mapvideo?.publicLayers) {
    const rows = await window.mapvideo.publicLayers.list();
    return rows.map((r) => ({ id: r.id, type: (r.type as LayerType) || 'marker', name: r.name, count: r.count }));
  }
  return listLocal().map((x) => ({ id: x.id, type: x.type || 'marker', name: x.name, count: x.elements.length }));
}

/** 把项目图层存为公共图层；返回因跨图层引用被剔除的元素名（同名覆盖） */
export async function saveLayerToPublic(layer: Layer): Promise<string[]> {
  if (IS_DESKTOP && window.mapvideo?.publicLayers) {
    const r = await window.mapvideo.publicLayers.save({ layerId: layer.id });
    return r.dropped || [];
  }
  const { kept, dropped } = pruneForeignConnectors(layer.elements);
  const item: PublicLayer = {
    id: `pl_${Date.now().toString(36)}`, type: layer.type, name: layer.name || '未命名图层',
    startFrame: layer.startFrame, endFrame: layer.endFrame, elements: kept, savedAt: Date.now(),
  };
  writeLocal([item, ...listLocal().filter((x) => x.name !== layer.name)]);
  return dropped;
}

/** 导入公共图层到项目：返回可直接并入项目的新图层（时间沿用源图层，不做自动归零） */
export async function importPublicLayer(publicId: string, projectId: string): Promise<{ layer?: Layer; dropped?: string[] }> {
  if (IS_DESKTOP && window.mapvideo?.publicLayers) {
    const r = await window.mapvideo.publicLayers.import({ publicLayerId: publicId, projectId });
    return { layer: r.layer || undefined, dropped: r.dropped };
  }
  const local = listLocal().find((x) => x.id === publicId);
  if (!local) return {};
  // 与桌面端同规则：副本必须带**新 id** 进项目，否则同一库导入两次就是重复 id
  // （deleteElement 按 id 过滤会一次删两条、updateElement 只命中第一条）。
  const layerId = generateId();
  const suf = `:im${layerId}`;
  const remap = new Map<string, string>();
  for (const el of local.elements) remap.set(el.id, el.id + suf);
  // 先整体换 id 与端点，再裁剪：裁剪判据是「端点是否在本图层内」，顺序反了会误删全部连接线
  const moved = local.elements.map((el) => {
    if (el.type !== 'connector') return { ...el, id: remap.get(el.id)! };
    const c = el as ConnectorElement;
    return {
      ...c, id: remap.get(c.id)!,
      fromElementId: remap.get(c.fromElementId) || c.fromElementId,
      toElementId: remap.get(c.toElementId) || c.toElementId,
    };
  });
  const { kept } = pruneForeignConnectors(moved);
  return {
    layer: {
      id: layerId, type: local.type || 'marker', name: local.name, visible: true,
      startFrame: local.startFrame, endFrame: local.endFrame, elements: kept,
    },
  };
}

export async function removePublicLayer(id: string): Promise<void> {
  if (IS_DESKTOP && window.mapvideo?.publicLayers) {
    await window.mapvideo.publicLayers.remove(id);
    return;
  }
  writeLocal(listLocal().filter((x) => x.id !== id));
}
