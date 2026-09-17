// 行政区边界数据加载与点选查询
// 默认数据源为世界国家级低精度边界（约250KB）；可替换为省界等更细的数据源。
// 中国国土用内置官方边界覆盖（见 applyChinaOverride）：johan 世界数据把台湾列为独立要素且中国
// 不含南海诸岛/十段线，不符合国内标准地图；改用 DataV·国家标准地图（public/geo/china.json）。
import * as turf from '@turf/turf';
import type { GeoJSONCollection } from './geojson';

/** 可用的数据源列表（依次回退尝试） */
let sources = [
  'https://cdn.jsdelivr.net/gh/johan/world.geo.json@master/countries.geo.json',
  'https://raw.githubusercontent.com/johan/world.geo.json/master/countries.geo.json',
];

let cache: GeoJSONCollection | null = null;
let inflight: Promise<GeoJSONCollection> | null = null;

/** 内置中国官方边界：DataV 阿里云国家标准地图（含台湾、南海诸岛及十段线），public 资源离线可用 */
function chinaOverrideUrl(): string {
  return new URL('geo/china.json', document.baseURI).href;
}
let chinaGeometry: Promise<unknown | null> | null = null;
function loadChinaGeometry(): Promise<unknown | null> {
  if (!chinaGeometry) {
    chinaGeometry = fetch(chinaOverrideUrl())
      .then((r) => (r.ok ? r.json() : null))
      .then((fc: any) => fc?.features?.[0]?.geometry ?? null)
      .catch(() => null);
  }
  return chinaGeometry;
}

/** 用内置官方边界替换世界数据里的中国，并移除独立的「台湾」要素（已并入中国） */
async function applyChinaOverride(fc: GeoJSONCollection): Promise<GeoJSONCollection> {
  const geometry = await loadChinaGeometry();
  if (!geometry) return fc;
  let replaced = false;
  const features = (fc.features as any[])
    .filter((f) => {
      const nm = regionName(f?.properties || {});
      const id = String(f?.id || '').toUpperCase();
      return !(nm === 'Taiwan' || id === 'TWN');
    })
    .map((f) => {
      const nm = regionName(f?.properties || {});
      const id = String(f?.id || '').toUpperCase();
      if (!replaced && (nm === 'China' || id === 'CHN')) {
        replaced = true;
        return { ...f, geometry };
      }
      return f;
    });
  return { ...fc, features };
}

/** 更换数据源（例如省级边界），并清空缓存 */
export function setRegionSources(urls: string[]) {
  sources = urls.filter(Boolean);
  cache = null;
  inflight = null;
}

async function fetchJson(url: string): Promise<GeoJSONCollection> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

/** 加载（带缓存与多源回退） */
export function loadRegionData(): Promise<GeoJSONCollection> {
  if (cache) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = (async () => {
    let lastErr: unknown = null;
    for (const url of sources) {
      try {
        const data = await fetchJson(url);
        if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
          throw new Error('Invalid FeatureCollection');
        }
        const merged = await applyChinaOverride(data);
        cache = merged;
        return merged;
      } catch (err) {
        lastErr = err;
      }
    }
    inflight = null;
    throw lastErr instanceof Error ? lastErr : new Error('区域数据加载失败');
  })();
  return inflight;
}

export interface RegionHit {
  /** 区域名称 */
  name: string;
  /** Polygon 单环数组 或 MultiPolygon 多面坐标 */
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: unknown;
  };
}

/** 判断要素是否包含点（对 Polygon / MultiPolygon 均有效） */
function containsPoint(feature: any, pt: [number, number]): boolean {
  try {
    return turf.booleanPointInPolygon(turf.point(pt), feature, { ignoreBoundary: false });
  } catch {
    return false;
  }
}

/** 取区域显示名（兼容常见属性字段） */
function regionName(props: Record<string, unknown>): string {
  const keys = ['name', 'NAME', 'name_en', 'ADMIN', 'admin', 'Name', 'CN_NAME'];
  for (const k of keys) {
    const v = props?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '区域';
}

/**
 * 点选行政区：返回包含该点的所有要素（通常为一个国家；跨边界面可能多个）
 */
export async function findRegionsAt(lngLat: [number, number]): Promise<RegionHit[]> {
  const fc = await loadRegionData();
  const hits: RegionHit[] = [];
  for (const f of fc.features as any[]) {
    const t = f?.geometry?.type;
    if (t !== 'Polygon' && t !== 'MultiPolygon') continue;
    if (containsPoint(f, lngLat)) {
      hits.push({ name: regionName(f.properties || {}), geometry: f.geometry });
    }
  }
  return hits;
}

/** 数据源中全部区域名（供后续搜索列表面板使用） */
export async function listRegionNames(): Promise<string[]> {
  const fc = await loadRegionData();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of fc.features as any[]) {
    const n = regionName(f.properties || {});
    if (!seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

/** 按名称取要素几何（供区域列表面板创建元素） */
export async function findRegionByName(name: string): Promise<RegionHit | null> {
  const fc = await loadRegionData();
  return findRegionByNameIn(fc, name);
}

/** 在指定 FeatureCollection 里按名称取要素几何（供「时代疆域图」等自定义数据源使用） */
export function findRegionByNameIn(fc: GeoJSONCollection, name: string): RegionHit | null {
  for (const f of fc.features as any[]) {
    const t = f?.geometry?.type;
    if (t !== 'Polygon' && t !== 'MultiPolygon') continue;
    const nm = regionName(f.properties || {});
    if (nm === name || nm.includes(name) || name.includes(nm)) {
      return { name: nm, geometry: f.geometry };
    }
  }
  return null;
}

/** 列出某个 FeatureCollection 的全部区域（名称 + 几何），用于整幅导入 */
export function listRegionsIn(fc: GeoJSONCollection): RegionHit[] {
  const out: RegionHit[] = [];
  for (const f of fc.features as any[]) {
    const t = f?.geometry?.type;
    if (t !== 'Polygon' && t !== 'MultiPolygon') continue;
    out.push({ name: regionName(f.properties || {}), geometry: f.geometry });
  }
  return out;
}

// ========== 命中 → 面几何（供点选与列表面板共用） ==========

/** 行政区要素 → 面几何（MultiPolygon 拆成多个面） */
export function regionHitsToShapes(
  hits: RegionHit[]
): { name: string; rings: number[][][] }[] {
  const out: { name: string; rings: number[][][] }[] = [];
  for (const hit of hits) {
    if (hit.geometry.type === 'Polygon') {
      out.push({ name: hit.name, rings: hit.geometry.coordinates as number[][][] });
    } else {
      const polys = hit.geometry.coordinates as number[][][][];
      polys.forEach((rings, i) => {
        const suffix = polys.length > 1 ? `·${i + 1}` : '';
        out.push({ name: `${hit.name}${suffix}`, rings });
      });
    }
  }
  return out;
}
