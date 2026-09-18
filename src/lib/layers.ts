/**
 * layers.ts — 图层工具：派生扁平元素、时间解析、公共图层库
 *
 * 数据模型：项目 = Layer[]，每个图层含自己的显隐 / 显示区间 / 元素列表。
 * `project.elements` 是**派生镜像**（store 的 patch 自动重算），供渲染 / 面板 / 相机等沿用扁平读取。
 */
import type { Layer, MapElement } from '../types';

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

/** 把一批元素并入指定图层（layerId 缺省用第一个图层；没有图层则新建一个） */
export function layerForAppend(layers: Layer[], layerId: string | undefined, makeDefault: () => Layer): { layers: Layer[]; targetId: string } {
  if (layerId) {
    const hit = layers.find((l) => l.id === layerId);
    if (hit) return { layers, targetId: hit.id };
  }
  if (layers.length > 0) return { layers, targetId: layers[0].id };
  const created = makeDefault();
  return { layers: [created], targetId: created.id };
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
