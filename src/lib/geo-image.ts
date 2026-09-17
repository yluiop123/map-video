/**
 * geo-image.ts — 地理配准图片（贴图）工具函数
 *
 * 元素类型 geo_image：图片存全局素材库（assetId），元素保存控制点网格：
 *   · cols=1, rows=1（2×2 网格点）= 四角投影配准
 *   · cols/rows 更大 = 网格变形配准
 */
import type { GeoImageElement, MapElement, MapVideoProject } from '../types';
import { generateId } from '../types';
import { getAssetUrl } from './assets';

/** 读取图片宽高比（宽/高）；失败返回 1 */
export function loadImageAspect(assetId: string): Promise<number> {
  return getAssetUrl(assetId).then((url) => new Promise<number>((resolve) => {
    if (!url) return resolve(1);
    const im = new Image();
    im.onload = () => resolve(im.naturalWidth / Math.max(1, im.naturalHeight));
    im.onerror = () => resolve(1);
    im.src = url;
  }));
}

type XY = [number, number];

/** 按当前地图视野生成默认网格（图片按 aspect 内接视野中心） */
export function defaultGridForBounds(
  bounds: { west: number; east: number; south: number; north: number },
  aspect: number,
  cols = 1,
  rows = 1,
): XY[] {
  const { west, east, south, north } = bounds;
  const cx = (west + east) / 2;
  const cy = (south + north) / 2;
  const viewAspect = Math.abs(east - west) / Math.max(1e-6, Math.abs(north - south));
  let halfW = Math.abs(east - west) / 2;
  let halfH = Math.abs(north - south) / 2;
  if (aspect > viewAspect) halfH = halfW / aspect; else halfW = halfH * aspect;
  const grid: XY[] = [];
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      grid.push([cx + (c / cols * 2 - 1) * halfW, cy - (r / rows * 2 - 1) * halfH]);
    }
  }
  return grid;
}

/** 网格双线性重采样到新的行列密度（配准点不丢，只是插值加密/稀疏） */
export function resampleGrid(grid: XY[], cols: number, rows: number, newCols: number, newRows: number): XY[] {
  const nc = Math.max(1, Math.round(cols));
  const nr = Math.max(1, Math.round(rows));
  const oc = Math.max(1, Math.round(newCols));
  const or_ = Math.max(1, Math.round(newRows));
  if (oc === nc && or_ === nr) return grid;
  const at = (r: number, c: number): XY => grid[Math.min(r, nr) * (nc + 1) + Math.min(c, nc)] || [0, 0];
  const out: XY[] = [];
  for (let r = 0; r <= or_; r++) {
    for (let c = 0; c <= oc; c++) {
      const fu = (c / oc) * nc;
      const fv = (r / or_) * nr;
      const c0 = Math.min(nc - 1, Math.floor(fu));
      const r0 = Math.min(nr - 1, Math.floor(fv));
      const c1 = Math.min(nc, c0 + 1);
      const r1 = Math.min(nr, r0 + 1);
      const tu = fu - c0;
      const tv = fv - r0;
      const p00 = at(r0, c0), p10 = at(r0, c1), p01 = at(r1, c0), p11 = at(r1, c1);
      const x = (1 - tv) * ((1 - tu) * p00[0] + tu * p10[0]) + tv * ((1 - tu) * p01[0] + tu * p11[0]);
      const y = (1 - tv) * ((1 - tu) * p00[1] + tu * p10[1]) + tv * ((1 - tu) * p01[1] + tu * p11[1]);
      out.push([x, y]);
    }
  }
  return out;
}

/** 构造地理配准图片元素（默认四角） */
export function createGeoImageElement(
  project: MapVideoProject,
  assetId: string,
  aspect: number,
  bounds: { west: number; east: number; south: number; north: number },
  name = '贴图',
): GeoImageElement {
  return {
    id: generateId(), type: 'geo_image', name, visible: true, locked: false,
    startFrame: 0, endFrame: Math.max(1, project.endFrame), style: {},
    assetId, aspect, cols: 1, rows: 1, grid: defaultGridForBounds(bounds, aspect, 1, 1), opacity: 1,
  };
}

/** 网格密度调整（保留配准形状） */
export function withGridDensity(el: GeoImageElement, cols: number, rows: number): Partial<MapElement> {
  return { cols, rows, grid: resampleGrid(el.grid, el.cols, el.rows, cols, rows) } as Partial<MapElement>;
}
