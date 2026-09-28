/**
 * map-catalog.ts — 底图 / 高程图的内置目录（**全库一份，所有项目共用**）
 *
 * 这一份常量是内置目录的唯一来源：库里的目录行由渲染端在启动时按它铺
 * （`stores/mapCatalogStore`），主进程不再复制一份 —— 那是第二处真相。
 * 项目侧只存「选了目录里哪一行」（activeBaseMapId / activeElevationMapId）
 * 与地形夸张系数（terrainExaggeration）：目录不是项目内容。
 */
import type { BaseMapConfig, ElevationMapConfig } from '../types';

/** 地图侧的可选项（面板列的两组，渲染端读的就是它） */
export interface MapCatalog {
  baseMaps: BaseMapConfig[];
  elevationMaps: ElevationMapConfig[];
}

/** 已下线的底图 id（Natural Earth 示例，中国边界不符合国标）：库里还留着旧行的话铺不进目录 */
export const REMOVED_BASE_MAP_IDS = new Set(['demotiles']);

export const DEFAULT_BASE_MAPS: BaseMapConfig[] = [
  {
    id: 'osm',
    name: 'OpenStreetMap',
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '© OpenStreetMap contributors',
        },
      },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    } as import('maplibre-gl').StyleSpecification,
  },
  { id: 'dark', name: '暗色地图', style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json' },
  { id: 'light', name: '亮色地图', style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json' },
  { id: 'voyager', name: '探索者地图', style: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json' },
  {
    id: 'satellite', name: '卫星影像',
    style: {
      version: 8,
      sources: {
        sat: {
          type: 'raster',
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          tileSize: 256,
          attribution: '© Esri World Imagery',
        },
      },
      layers: [{ id: 'sat', type: 'raster', source: 'sat' }],
    } as import('maplibre-gl').StyleSpecification,
  },
  { id: 'openfreemap', name: 'OpenFreeMap', style: 'https://tiles.openfreemap.org/styles/liberty' },
  { id: 'maplibre-demo', name: 'MapLibre 示例（国标）', style: 'geo/maplibre-demo.json' },
];

export const DEFAULT_ELEVATION_MAPS: ElevationMapConfig[] = [
  { id: 'none', name: '无高程（平面）', url: '' },
  { id: 'maplibre-terrain', name: '地形高程 (MapLibre)', url: 'https://demotiles.maplibre.org/terrain-tiles/tiles.json', encoding: 'terrarium' },
  { id: 'aws-terrain', name: '地形高程 (AWS Terrarium)', url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png', encoding: 'terrarium' },
];

/** 内置清单去掉已下线的 id（每次给新数组，别让调用方改到常量本身） */
export function defaultCatalog(): MapCatalog {
  return {
    baseMaps: DEFAULT_BASE_MAPS.filter((b) => !REMOVED_BASE_MAP_IDS.has(b.id)).map((b) => ({ ...b })),
    elevationMaps: DEFAULT_ELEVATION_MAPS.map((e) => ({ ...e })),
  };
}

/** 「无高程（平面）」占位项的 id：面板与渲染端都用它判「不做地形」 */
export const FLAT_ELEVATION_ID = 'none';
/** 新建项目默认生效的底图 */
export const DEFAULT_BASE_MAP_ID = 'satellite';
