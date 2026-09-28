/**
 * map-style.ts — 底图 + 高程合并为 MapLibre style
 *
 * 编辑端（EditableMap）与导出端（MapScene）**必须共用这一个实现**：
 * 此前两端各写了一份 `getStyleUrl`，已经出现漂移（编辑端多一个 `elevation.url` 判断），
 * 导致「编辑器里看到的底图/地形」与「导出视频里的」可能不一致。
 *
 * 目录（有哪些底图 / 高程可选）是**全局一份**的独立数据，不在项目里：调用方把它传进来
 * （编辑端与导出端都读 `stores/mapCatalogStore`）。项目只带「选了哪一行」与夸张系数。
 */
import type { StyleSpecification } from 'maplibre-gl';
import type { MapVideoProject } from '../types';
import type { MapCatalog } from './map-catalog';
import { FLAT_ELEVATION_ID } from './map-catalog';

const EMPTY_STYLE: StyleSpecification = { version: 8, sources: {}, layers: [] };

/** 渲染端的地形夸张默认值（项目没填过时用它） */
export const DEFAULT_TERRAIN_EXAGGERATION = 1.5;

export function getStyleUrl(project: MapVideoProject, catalog: MapCatalog): string | StyleSpecification {
  // 项目选的那一行可能已被删（目录是共享数据，别的机器/别的时刻删掉都会留下悬空引用）：
  // 回落到目录第一条，而不是抛错 —— 悬空只是「换个底图」，不该变成空白地图
  const baseMap = catalog.baseMaps.find((b) => b.id === project.activeBaseMapId) || catalog.baseMaps[0];
  const style = baseMap?.style;
  if (!style) return EMPTY_STYLE;
  if (typeof style === 'string') return style;

  const elevId = project.activeElevationMapId ?? FLAT_ELEVATION_ID;
  const elevation = catalog.elevationMaps.find((e) => e.id === elevId && e.url);
  if (!elevation?.url || style.sources?.elevation) return style;

  return {
    ...style,
    sources: {
      ...(style.sources || {}),
      elevation: {
        type: 'raster-dem',
        tiles: [elevation.url],
        tileSize: 256,
        encoding: elevation.encoding || 'terrarium',
      },
    },
    // 必须用 ?? 而不是 ||：exaggeration = 0（完全平坦）是**合法有效值**，
    // 用 || 会把 0 当作「未设置」回退成 1.5 —— 表现为「设了 0 却仍有地形起伏」。
    terrain: {
      source: 'elevation',
      exaggeration: project.terrainExaggeration ?? DEFAULT_TERRAIN_EXAGGERATION,
    },
  } as StyleSpecification;
}
