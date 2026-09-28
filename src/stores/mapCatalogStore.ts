/**
 * mapCatalogStore — 底图 / 高程目录（**全库一份，所有项目共用**）
 *
 * 为什么它不在项目里：目录是「有哪些图可选」，不是这一片片子的内容。所有项目读同一张表，
 * 项目只记 `activeBaseMapId` / `activeElevationMapId` 与 `terrainExaggeration`（见 types）。
 *
 * 内置那几份**不在主进程复制一份清单**：库里为空时由这里按 `lib/map-catalog.ts` 的常量铺行，
 * 铺完就是普通可编辑数据（表与 src 的常量之间只有这一条单向关系）。
 */
import { create } from 'zustand';
import type { BaseMapConfig, ElevationMapConfig } from '../types';
import { defaultCatalog } from '../lib/map-catalog';
import { storage } from '../lib/storage';

interface MapCatalogState {
  baseMaps: BaseMapConfig[];
  elevationMaps: ElevationMapConfig[];
  /** 铺过 / 读过了 —— 面板与渲染端在它之前拿到的是空目录，不该据此判「没有底图」 */
  ready: boolean;
  hydrate: () => Promise<void>;
  /** 重新按内置常量铺一遍（「恢复默认」的落点） */
  resetToDefaults: () => Promise<void>;
  addBaseMap: (row: BaseMapConfig) => Promise<void>;
  removeBaseMap: (id: string) => Promise<void>;
  addElevationMap: (row: ElevationMapConfig) => Promise<void>;
  removeElevationMap: (id: string) => Promise<void>;
}

/**
 * StrictMode 会把 effect 跑两遍：两次并发 hydrate 会各自铺一遍常量行。
 * 铺表本身是 upsert（幂等），但白写一遍库 —— 用一处模块级在途标记挡住。
 */
let hydrating: Promise<void> | null = null;

export const useMapCatalogStore = create<MapCatalogState>((set, get) => ({
  baseMaps: [],
  elevationMaps: [],
  ready: false,

  hydrate: async () => {
    if (get().ready) return;
    if (hydrating) return hydrating;
    hydrating = (async () => {
      try {
        let base = await storage.listBaseMaps();
        let elev = await storage.listElevationMaps();
        if (!base.length || !elev.length) {
          const seed = defaultCatalog();
          if (!base.length) {
            for (let i = 0; i < seed.baseMaps.length; i++) await storage.saveBaseMap(seed.baseMaps[i], i);
            base = seed.baseMaps;
          }
          if (!elev.length) {
            for (let i = 0; i < seed.elevationMaps.length; i++) await storage.saveElevationMap(seed.elevationMaps[i], i);
            elev = seed.elevationMaps;
          }
        }
        set({ baseMaps: base, elevationMaps: elev, ready: true });
      } finally {
        hydrating = null;
      }
    })();
    return hydrating;
  },

  resetToDefaults: async () => {
    const seed = defaultCatalog();
    for (const [i, b] of seed.baseMaps.entries()) await storage.saveBaseMap(b, i);
    for (const [i, e] of seed.elevationMaps.entries()) await storage.saveElevationMap(e, i);
    set({ baseMaps: seed.baseMaps, elevationMaps: seed.elevationMaps, ready: true });
  },

  addBaseMap: async (row) => {
    const list = [...get().baseMaps, row];
    await storage.saveBaseMap(row, list.length - 1);
    set({ baseMaps: list });
  },

  removeBaseMap: async (id) => {
    await storage.removeBaseMap(id);
    set({ baseMaps: get().baseMaps.filter((b) => b.id !== id) });
  },

  addElevationMap: async (row) => {
    const list = [...get().elevationMaps, row];
    await storage.saveElevationMap(row, list.length - 1);
    set({ elevationMaps: list });
  },

  removeElevationMap: async (id) => {
    await storage.removeElevationMap(id);
    set({ elevationMaps: get().elevationMaps.filter((e) => e.id !== id) });
  },
}));

/**
 * 当前生效的底图 / 高程（渲染端与面板共用这一处解析）。
 * **目录读不到 / 项目选的那一行已被删 → 回落到目录第一条**，不抛错也不给空地图。
 */
export function resolveCatalog(baseMaps: BaseMapConfig[], elevationMaps: ElevationMapConfig[], project: {
  activeBaseMapId?: string; activeElevationMapId?: string | null;
}) {
  const base = baseMaps.find((b) => b.id === project.activeBaseMapId) ?? baseMaps[0] ?? null;
  const elev = elevationMaps.find((e) => e.id === project.activeElevationMapId && e.url) ?? null;
  return { base, elev };
}
