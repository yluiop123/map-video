/**
 * layers.ts — 图层工具：派生扁平元素、时间解析、公共图层库
 *
 * 数据模型：项目 = Layer[]，每个图层含自己的显隐 / 显示区间 / 元素列表。
 * `project.elements` 是**派生镜像**（store 的 patch 自动重算），供渲染 / 面板 / 相机等沿用扁平读取。
 */
import type { Layer, LayerType, MapElement } from '../types';

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
// 存「图层（含其全部元素）」的 JSON；用 localStorage（双端可用，体量仅为几何数据）。

export interface PublicLayer {
  id: string;
  name: string;
  elements: MapElement[];
  savedAt: number;
}

const LIB_KEY = 'mapvideo.publicLayers';

export function listPublicLayers(): PublicLayer[] {
  try {
    const raw = localStorage.getItem(LIB_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeLibrary(list: PublicLayer[]): void {
  try { localStorage.setItem(LIB_KEY, JSON.stringify(list)); } catch { /* 容量不足等 */ }
}

/** 保存一个公共图层（同名覆盖），返回新库列表 */
export function savePublicLayer(name: string, elements: MapElement[]): PublicLayer[] {
  const list = listPublicLayers();
  const item: PublicLayer = { id: `pl_${Date.now().toString(36)}`, name: name || '未命名图层', elements, savedAt: Date.now() };
  const next = [item, ...list.filter((x) => x.name !== name)];
  writeLibrary(next);
  return next;
}

export function removePublicLayer(id: string): PublicLayer[] {
  const next = listPublicLayers().filter((x) => x.id !== id);
  writeLibrary(next);
  return next;
}
