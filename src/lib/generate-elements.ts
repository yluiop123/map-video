/**
 * generate-elements.ts — 一键生成：把「意图 + 已解析地名」构造成软件内置元素
 *
 * 所有产物都是普通 MapElement（line / moving_point / arrow / double_arrow /
 * encirclement / gathering / polygon / flag / territory），走既有渲染与面板，可再手动编辑。
 * 帧由 store 落到项目绝对帧。
 */
import * as turf from '@turf/turf';
import {
  generateId,
  type MapElement, type LineElement, type MovingPointElement, type ArrowElement,
  type DoubleArrowElement, type EncirclementElement, type GatheringElement,
  type PolygonElement, type FlagElement, type TerritoryElement,
} from '../types';
import { findRegionByName, type RegionHit } from './regions';

type XY = [number, number];

/** LLM 给出的元素意图 */
export interface GenElementSpec {
  kind: string;                // route|move|arrow|double_arrow|encircle|gather|polygon|circle|flag|territory
  label?: string;
  /** 端点 / 顶点顺序（地名） */
  places?: string[];
  /** 中心地名（encircle/gather/circle/flag） */
  at?: string;
  /** 半径（公里，encircle/gather/circle） */
  radiusKm?: number;
  /** 箭头样式：attack|curved|curved-simple|swallowtail|straight… */
  arrowType?: string;
  /** 路线动画：grow / move */
  animate?: string;
  /** 疆域：区域名（国家/地区） */
  region?: string;
}

const RED = '#E23B3B';
const GOLD = '#FFD24A';

function base(name: string, duration: number) {
  return { id: generateId(), name, visible: true, locked: false, startFrame: 0, endFrame: Math.max(1, duration), style: {} };
}

const resolvePts = (names: string[] | undefined, byName: Map<string, XY>): XY[] =>
  (names || []).map((n) => byName.get(n)).filter((p): p is XY => !!p);

/** 同步构造（军标/疆域之外的类别）。construction 失败返回 null */
export function buildGeneratedElement(spec: GenElementSpec, byName: Map<string, XY>, duration: number): MapElement | null {
  const kind = (spec.kind || '').toLowerCase();
  const label = spec.label || '';
  const pts = resolvePts(spec.places, byName);
  const at = spec.at ? byName.get(spec.at) : undefined;

  switch (kind) {
    case 'route':
    case 'line': {
      if (pts.length < 2) return null;
      return {
        ...base(label || '路线', duration), type: 'line', coordinates: pts,
        lineType: 'straight', lineWidth: 6, lineColor: RED,
        drawProgress: [{ frame: 0, value: 1 }],
        ...(spec.animate === 'move' ? { routeEffect: { enabled: true, spotColor: GOLD, spotWidth: 6, frameStep: 2, dotCount: 1 } } : {}),
        shapeCategory: 'route',
      } as LineElement;
    }
    case 'move':
    case 'moving_point': {
      if (pts.length < 2) return null;
      return {
        ...base(label || '移动', duration), type: 'moving_point', path: pts,
        pathProgress: [{ frame: 0, value: 0 }, { frame: Math.max(1, duration), value: 1 }], color: GOLD,
      } as MovingPointElement;
    }
    case 'arrow': {
      if (pts.length < 2) return null;
      return {
        ...base(label || '进攻', duration), type: 'arrow',
        from: pts[0], to: pts[pts.length - 1], path: pts,
        arrowType: (spec.arrowType as ArrowElement['arrowType']) || 'attack',
        width: 15, color: RED, progress: [{ frame: 0, value: 1 }],
        shapeCategory: 'route',
      } as ArrowElement;
    }
    case 'double_arrow':
    case 'pincer': {
      if (pts.length < 2) return null;
      return {
        ...base(label || '对进', duration), type: 'double_arrow', points: pts,
        color: RED, progress: [{ frame: 0, value: 1 }],
      } as DoubleArrowElement;
    }
    case 'encircle':
    case 'encirclement': {
      if (!at) return null;
      return {
        ...base(label || '包围', duration), type: 'encirclement', center: at,
        radius: spec.radiusKm ?? 60, fillColor: RED, strokeColor: RED,
      } as EncirclementElement;
    }
    case 'gather':
    case 'gathering': {
      if (!at) return null;
      return {
        ...base(label || '集结', duration), type: 'gathering', center: at,
        radius: spec.radiusKm ?? 50, color: RED, pulseAnimation: true,
      } as GatheringElement;
    }
    case 'polygon':
    case 'poly': {
      if (pts.length < 3) return null;
      const ring = [...pts, pts[0]];
      return {
        ...base(label || '区域', duration), type: 'polygon', coordinates: [ring], shapeKind: 'poly',
        fillColor: RED, fillOpacity: 0.25, strokeColor: RED, strokeWidth: 2,
      } as PolygonElement;
    }
    case 'circle': {
      if (!at) return null;
      const radius = spec.radiusKm ?? 80;
      const ring = turf.circle(at, radius, { steps: 64 }).geometry.coordinates[0] as XY[];
      return {
        ...base(label || '圆形区域', duration), type: 'polygon', coordinates: [ring], shapeKind: 'circle',
        circleMeta: { center: at, radius },
        fillColor: RED, fillOpacity: 0.25, strokeColor: RED, strokeWidth: 2,
      } as PolygonElement;
    }
    case 'flag': {
      if (!at) return null;
      return {
        ...base(label || spec.at || '旗标', duration), type: 'flag', coordinates: at,
        text: label || spec.at || '', flagColor: RED, textColor: '#FFFFFF', fontSize: 14, flagWidth: 64,
      } as FlagElement;
    }
    default:
      return null;
  }
}

/** RegionHit 几何 → 单势力地块 */
function hitToCountryPlot(hit: RegionHit, color: string): { country: TerritoryElement['countries'][number]; plots: TerritoryElement['plots'] } {
  const countryId = generateId();
  const plots: TerritoryElement['plots'] = [];
  const g = hit.geometry;
  const geoms: unknown[] = g.type === 'Polygon' ? [g.coordinates] : (g.coordinates as unknown[]);
  for (const poly of geoms) {
    const rings = poly as XY[][];
    if (!Array.isArray(rings) || rings.length === 0) continue;
    plots.push({ id: generateId(), name: hit.name, rings: rings as TerritoryElement['plots'][number]['rings'], ownerId: countryId });
  }
  return { country: { id: countryId, name: hit.name, color }, plots };
}

function territoryDisplay() {
  return {
    countryBorders: true, plotBorders: true, borderWidth: 2, fillOpacity: 0.35,
    countryNames: true, plotNames: false, labelAlign: 'viewport' as const, labelScale: 1,
  };
}

/** 疆域：按区域名取边界（内置/联网行政区数据），构造单势力地块 */
export async function buildGeneratedTerritory(region: string, duration: number): Promise<MapElement | null> {
  const hit = await findRegionByName(region);
  if (!hit) return null;
  const { country, plots } = hitToCountryPlot(hit, RED);
  if (!plots.length) return null;
  return {
    ...base(region, duration), type: 'territory',
    countries: [country], plots, events: [], display: territoryDisplay(),
  } as TerritoryElement;
}
