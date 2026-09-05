// 疆域系统核心逻辑：归属推导 / 颜色渐变 / 国界并集 / 描线切片 / 位图标签 / 导入合并
// 纯函数 + turf，供编辑器与导出端共用（渲染层在 map-renderer.renderTerritory）
import * as turf from '@turf/turf';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import type {
  TerritoryCountry, TerritoryEvent, TerritoryPlot, TerritoryElement, TerritoryDisplay,
} from '../types';

/** 自动配色盘（按国家数量循环取色，保证相邻国家颜色区分） */
export const TERRITORY_PALETTE = [
  '#E23B3B', '#2E7DD1', '#3AA655', '#F5A623', '#8E44AD', '#16A085',
  '#E67E22', '#2980B9', '#C0392B', '#27AE60', '#D4AC0D', '#7F8C8D',
  '#D35400', '#1ABC9C', '#9B59B6', '#34495E', '#E91E63', '#00BCD4',
  '#8BC34A', '#FF5722', '#673AB7', '#4CAF50', '#FFC107', '#795548',
];

/** 空疆域元素缺省值 */
export function defaultTerritoryDisplay() {
  return {
    countryBorders: true,
    plotBorders: true,
    borderWidth: 3,
    fillOpacity: 0.45,
    countryNames: true,
    plotNames: false,
    labelAlign: 'map' as const,
    labelScale: 1,
  };
}

/** 兼容旧存档：display 缺字段时补默认值（旧版保存的项目可能缺 fillOpacity/labelScale 等） */
export function normalizeTerritoryDisplay(display?: Partial<TerritoryDisplay> | null): TerritoryDisplay {
  return { ...defaultTerritoryDisplay(), ...(display || {}) };
}

// ========== 特效时序 ==========
// 事件在 frame=F 生效：描线 [F, F+0.6D] → 颜色渐变 [F+0.3D, F+D]（与描线尾部交叠）→ 高亮脉冲 [F+D, F+D+0.5D]

export interface FxWindow { start: number; drawEnd: number; fadeEnd: number; glowEnd: number }

export function effectWindow(ev: TerritoryEvent): FxWindow {
  const D = Math.max(1, ev.effect?.duration ?? 30);
  const preset = ev.effect?.preset ?? 'draw';
  const start = ev.frame;
  if (preset === 'instant') {
    const glowEnd = ev.effect?.highlight ? start + Math.max(12, D * 0.4) : start;
    return { start, drawEnd: start, fadeEnd: start, glowEnd };
  }
  const drawEnd = start + Math.max(1, D * 0.6);
  const fadeEnd = start + D;
  const glowEnd = ev.effect?.highlight ? fadeEnd + Math.max(12, D * 0.5) : fadeEnd;
  return { start, drawEnd, fadeEnd, glowEnd };
}

/** 事件按帧排序（副本） */
export function sortedEvents(events: TerritoryEvent[]): TerritoryEvent[] {
  return [...(events || [])].sort((a, b) => a.frame - b.frame);
}

/** 作用于某地块的有序事件 */
function eventsForPlot(events: TerritoryEvent[], plotId: string): TerritoryEvent[] {
  return sortedEvents(events).filter((ev) => ev.plotIds.includes(plotId));
}

/** 当前帧某地块的归属国 id */
export function ownerAt(plot: TerritoryPlot, events: TerritoryEvent[], frame: number): string {
  const evs = eventsForPlot(events, plot.id);
  let owner = plot.ownerId;
  for (const ev of evs) {
    if (frame >= ev.frame) owner = ev.toCountryId;
  }
  return owner;
}

/** 当前帧某地块的归属国（对象） */
export function ownerCountryAt(
  plot: TerritoryPlot, events: TerritoryEvent[], frame: number, countries: TerritoryCountry[],
): TerritoryCountry | undefined {
  const id = ownerAt(plot, events, frame);
  return countries.find((c) => c.id === id);
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 当前帧地块填充色（含渐变插值）：返回 hex */
export function plotColorAt(
  plot: TerritoryPlot, events: TerritoryEvent[], frame: number, countries: TerritoryCountry[],
): string {
  const evs = eventsForPlot(events, plot.id);
  const countryColor = (id: string) => countries.find((c) => c.id === id)?.color || '#888888';
  // 无事件或尚未到首个事件 → 初始色
  if (evs.length === 0 || frame < evs[0].frame) return countryColor(plot.ownerId);
  // 找到当前所处/最近的事件
  let idx = 0;
  for (let i = 0; i < evs.length; i++) {
    if (frame >= evs[i].frame) idx = i;
  }
  const ev = evs[idx];
  const target = countryColor(ev.toCountryId);
  const preset = ev.effect?.preset ?? 'draw';
  if (preset === 'instant') return target;
  const win = effectWindow(ev);
  const t = clamp01((frame - win.start) / Math.max(1, win.fadeEnd - win.start));
  if (t >= 1) return target;
  // 渐变起点 = 该事件之前地块的颜色（初始色或上一个事件的终色）
  const prevOwner = idx === 0 ? plot.ownerId : evs[idx - 1].toCountryId;
  return lerpColor(countryColor(prevOwner), target, t);
}

/** 当前帧地块的描线进度（0–1；未在描线期返回 1）与高亮强度（0–1） */
export function plotFxAt(plot: TerritoryPlot, events: TerritoryEvent[], frame: number, countries: TerritoryCountry[]): { draw: number; glow: number; glowColor: string } {
  const evs = eventsForPlot(events, plot.id);
  let draw = 1, glow = 0, glowColor = '#FFFFFF';
  for (const ev of evs) {
    const preset = ev.effect?.preset ?? 'draw';
    const win = effectWindow(ev);
    // 描线进度（instant 无描线阶段）
    if (preset !== 'instant' && frame >= win.start && frame < win.drawEnd) {
      draw = Math.min(draw, clamp01((frame - win.start) / Math.max(1, win.drawEnd - win.start)));
    }
    // 高亮脉冲（含 instant+highlight）
    if (ev.effect?.highlight && frame >= win.fadeEnd && frame < win.glowEnd) {
      const t = clamp01((frame - win.fadeEnd) / Math.max(1, win.glowEnd - win.fadeEnd));
      // 脉冲包络：起落两峰渐衰
      const pulse = Math.abs(Math.sin(t * Math.PI * 2)) * (1 - t * 0.6);
      if (pulse > glow) {
        glow = pulse;
        glowColor = countries.find((c) => c.id === ev.toCountryId)?.color || '#FFFFFF';
      }
    }
  }
  return { draw, glow, glowColor };
}

// ========== 颜色工具 ==========

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [136, 136, 136];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function lerpColor(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const bl = Math.round(b1 + (b2 - b1) * t);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}

/** 提亮（与白混合） */
export function lighten(color: string, amt: number): string {
  return lerpColor(color, '#FFFFFF', clamp01(amt));
}

// ========== 几何工具 ==========

/** 同国地块并集（国界外边界）：失败返回 null（渲染层回退为逐地块描边） */
export function unionCountryRings(ringsList: [number, number][][][]): Feature<Polygon | MultiPolygon> | null {
  const polys: Feature<Polygon>[] = [];
  for (const rings of ringsList) {
    if (!rings || !rings[0] || rings[0].length < 4) continue;
    try {
      polys.push(turf.polygon(rings as [number, number][][]));
    } catch { /* 跳过非法环 */ }
  }
  if (polys.length === 0) return null;
  if (polys.length === 1) return polys[0] as unknown as Feature<Polygon | MultiPolygon>;
  try {
    return turf.union(turf.featureCollection(polys)) as unknown as Feature<Polygon | MultiPolygon>;
  } catch {
    return null;
  }
}

/** 面要素质心（供国名/地块名锚点） */
export function centerOfFeature(f: Feature<Polygon | MultiPolygon>): [number, number] | null {
  try {
    const c = turf.centerOfMass(f as any);
    return [c.geometry.coordinates[0], c.geometry.coordinates[1]];
  } catch { /* */ }
  try {
    const c = turf.center(turf.featureCollection([f as any]));
    return [c.geometry.coordinates[0], c.geometry.coordinates[1]];
  } catch { return null; }
}

/** 点到环边界（各线段）的最短距离（平面近似，度） */
export function distToRingBoundary(p: [number, number], ring: [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((p[0] - x1) * dx + (p[1] - y1) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = x1 + t * dx - p[0];
    const ey = y1 + t * dy - p[1];
    const d = Math.sqrt(ex * ex + ey * ey);
    if (d < best) best = d;
  }
  return best;
}

/** 修剪新地块与既有地块的重叠：重叠部分沿既有边界裁齐。
 *  裁剪边的顶点与邻块环完全一致（coordKey 相同）→ 自动共享、拖拽联动。
 *  返回 rings（外环+洞，渲染端已支持洞），null=完全被覆盖应放弃创建。 */
export function trimPlotOverlap(
  ring: [number, number][], others: [number, number][][],
): [number, number][][] | null {
  const rest = others.filter((o) => o && o.length >= 4);
  if (!rest.length || !ring || ring.length < 4) return ring && ring.length >= 4 ? [ring] : null;
  try {
    const subject = turf.polygon([ring]);
    // 仅对"真正有面积重叠"的邻块做差集；仅贴边（共享边界）保持原样，
    // 避免 polygon-clipping 重建环时丢掉描摹/吸附的共享顶点
    const overlappers: Feature<Polygon>[] = [];
    for (const o of rest) {
      try {
        const inter = turf.intersect(turf.featureCollection([subject, turf.polygon([o])]));
        const g = (inter as unknown as { geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon } | null)?.geometry;
        if (g && g.type === 'Polygon' && turf.area(turf.polygon(g.coordinates as [number, number][][])) > 1e-12) {
          overlappers.push(turf.polygon([o]));
        }
      } catch { /* 忽略坏邻块 */ }
    }
    if (!overlappers.length) return [ring];
    const res = turf.difference(turf.featureCollection([subject, ...overlappers]));
    // turf 7 difference 返回 Feature<Polygon|MultiPolygon> | null
    const geom = (res as unknown as { geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon } | null)?.geometry;
    if (!geom) return null;
    const polys: [number, number][][][] = geom.type === 'Polygon'
      ? [geom.coordinates as [number, number][][]]
      : (geom.coordinates as [number, number][][][]);
    if (!polys.length) return null;
    // 多段结果取面积最大的一块（地块模型为单多边形）
    let best = polys[0];
    if (polys.length > 1) {
      let bestA = -1;
      for (const pr of polys) {
        let a = 0;
        try { a = turf.area(turf.polygon(pr)); } catch { /* */ }
        if (a > bestA) { bestA = a; best = pr; }
      }
    }
    if (!best?.[0] || best[0].length < 4) return null;
    return best;
  } catch (e) {
    // 差集失败（自交等）→ 保留原环，不阻塞绘制
    console.warn('[territory] trimPlotOverlap 差集失败，保留原环:', e);
    return [ring];
  }
}

/** 闭合环描线切片：t∈[0,1]，返回已绘制部分的开放折线 */
export function sliceRingClosed(ring: [number, number][], t: number): [number, number][] {
  const closed = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring : [...ring, ring[0]];
  const tt = clamp01(t);
  if (tt >= 0.999) return closed;
  try {
    const line = turf.lineString(closed as [number, number][]);
    const total = turf.length(line);
    if (total <= 0) return closed.slice(0, 2);
    const sliced = turf.lineSliceAlong(line, 0, total * tt);
    const cs = sliced.geometry.coordinates as [number, number][];
    return cs.length >= 2 ? cs : closed.slice(0, 2);
  } catch {
    const n = Math.max(2, Math.ceil(closed.length * tt));
    return closed.slice(0, n);
  }
}

// ========== 共享边界编辑（吸附/联动/描幕/T 型分叉） ==========
// 相邻地块共享边界的基础：坐标键相同（1e-7°≈1cm 网格）即视为同一顶点。
// 拖拽/删除按键同步所有副本；吸附与描幕保证新画的边天然共享。

/** 坐标键（1e-7° 网格） */
export function coordKey(p: [number, number]): string {
  return `${Math.round(p[0] * 1e7)},${Math.round(p[1] * 1e7)}`;
}

/** 去掉闭合环首尾重复顶点的开放序列 */
export function ringOpen(ring: [number, number][]): [number, number][] {
  const n = ring.length;
  if (n > 1 && coordKey(ring[0]) === coordKey(ring[n - 1])) return ring.slice(0, n - 1);
  return ring.slice();
}

/** 把所有地块环中与 fromPt 同键的顶点整体替换为 toPt（无匹配返回原数组） */
export function moveSharedVertices(
  plots: TerritoryPlot[], fromPt: [number, number], toPt: [number, number],
): TerritoryPlot[] {
  const key = coordKey(fromPt);
  let found = false;
  outer: for (const pl of plots) for (const ring of pl.rings) for (const p of ring) {
    if (coordKey(p) === key) { found = true; break outer; }
  }
  if (!found) return plots;
  return plots.map((pl) => ({
    ...pl,
    rings: pl.rings.map((ring) => ring.map((p) => (coordKey(p) === key ? toPt : p))),
  }));
}

/** 删除所有地块环中与 pt 同键的顶点（含闭合点）；外环剩余 <4 点的地块整体删除 */
export function removeSharedVertex(
  plots: TerritoryPlot[], pt: [number, number],
): { plots: TerritoryPlot[]; removedPlotIds: string[] } {
  const key = coordKey(pt);
  const out: TerritoryPlot[] = [];
  const removedPlotIds: string[] = [];
  for (const pl of plots) {
    const rings = pl.rings.map((ring) => ring.filter((p) => coordKey(p) !== key));
    if (!rings[0] || rings[0].length < 4) { removedPlotIds.push(pl.id); continue; }
    out.push({ ...pl, rings });
  }
  return { plots: out, removedPlotIds };
}

/** 把点 pt 插入闭合环中距其最近的边之后（T 型分叉，供相邻地块同步边界） */
export function insertRingVertex(ring: [number, number][], pt: [number, number]): [number, number][] {
  const n = ring.length;
  if (n < 2) return [...ring, pt];
  const key = coordKey(pt);
  const k0 = Math.cos((pt[1] * Math.PI) / 180) || 1e-9; // 经度按纬度缩放的平面近似
  const px = pt[0] * k0, py = pt[1];
  let best = 0, bestD = Infinity;
  for (let i = 0; i < n - 1; i++) {
    const a = ring[i], b = ring[i + 1];
    // 与端点重合的吸附点无需分叉（避免零长度边）
    if (coordKey(a) === key || coordKey(b) === key) return ring;
    const ax = a[0] * k0, ay = a[1], bx = b[0] * k0, by = b[1];
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
    const qx = ax + dx * t - px, qy = ay + dy * t - py;
    const d = qx * qx + qy * qy;
    if (d < bestD) { bestD = d; best = i; }
  }
  const out = ring.slice();
  out.splice(best + 1, 0, pt); // 闭合边命中时 best=n-2 → 插在闭合点之前，闭合性保持
  return out;
}

/** 描摹：沿开放环从 fromIdx 走到 toIdx 的中间顶点（不含两端）。
 *  弧线选择按「地理长度」而非顶点数——邻国边界顶点疏密不一时，顶点数最少的弧往往绕远。
 *  longArc=false 取较短弧（共享边界几乎总是较短一侧），true 取另一侧。 */
export function traceRingPath(
  open: [number, number][], fromIdx: number, toIdx: number, longArc: boolean,
): [number, number][] {
  const n = open.length;
  if (n < 3) return [];
  const f = ((fromIdx % n) + n) % n;
  const t = ((toIdx % n) + n) % n;
  if (f === t) return [];
  const walk = (step: number) => {
    const idxs: number[] = [];
    for (let i = (f + step + n) % n; i !== t; i = (i + step + n) % n) idxs.push(i);
    return idxs;
  };
  const fwd = walk(1);
  const bwd = walk(-1);
  const arcLen = (idxs: number[]) => {
    const seq = [open[f], ...idxs.map((i) => open[i]), open[t]];
    let L = 0;
    for (let i = 0; i < seq.length - 1; i++) {
      const [x1, y1] = seq[i], [x2, y2] = seq[i + 1];
      const k = Math.cos(((y1 + y2) / 2) * Math.PI / 180) || 1e-9;
      L += Math.hypot((x2 - x1) * k, y2 - y1); // 等距圆柱近似，仅用于方向选择
    }
    return L;
  };
  const goFwd = longArc ? arcLen(bwd) < arcLen(fwd) : arcLen(fwd) <= arcLen(bwd);
  return (goFwd ? fwd : bwd).map((i) => open[i]);
}

// ========== 名称标签位图（canvas，中文无忧；贴地/面向镜头由 symbol 层对齐控制） ==========

export interface TerritoryLabelStyle { size: number; bold?: boolean; color?: string; halo?: string; haloWidth?: number }

export function makeTerritoryLabelImageData(text: string, st: TerritoryLabelStyle): ImageData {
  const size = Math.max(8, Math.round(st.size));
  const haloWidth = st.haloWidth ?? 3;
  const canvas = document.createElement('canvas');
  const ctx0 = canvas.getContext('2d')!;
  const font = `${st.bold === false ? '' : 'bold '}${size}px "Microsoft YaHei", "PingFang SC", sans-serif`;
  ctx0.font = font;
  const tw = Math.ceil(ctx0.measureText(text || ' ').width);
  const w = tw + haloWidth * 2 + 6;
  const h = Math.ceil(size * 1.5) + haloWidth * 2;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  if (haloWidth > 0) {
    ctx.strokeStyle = st.halo || 'rgba(0,0,0,0.85)';
    ctx.lineWidth = haloWidth * 2;
    ctx.strokeText(text || '', w / 2, h / 2);
  }
  ctx.fillStyle = st.color || '#FFFFFF';
  ctx.fillText(text || '', w / 2, h / 2);
  return ctx.getImageData(0, 0, w, h);
}

/** 位图标签 imageId（同文案+样式复用同一张贴图） */
export function territoryLabelImageId(text: string, st: TerritoryLabelStyle): string {
  const key = `${text}|${st.size}|${st.bold === false ? 0 : 1}|${st.color}|${st.halo || ''}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return `tlbl${(h >>> 0).toString(36)}`;
}

// ========== 导入合并 ==========

export interface TerritoryShapeInput {
  countryName: string;
  plotName?: string;
  rings: [number, number][][];
}

/** 内置国家库/GeoJSON 解析出的地块，并入库（同名国合并、自动配色） */
export function mergeShapesIntoTerritory(
  el: TerritoryElement, shapes: TerritoryShapeInput[],
): { countries: TerritoryCountry[]; plots: TerritoryPlot[] } {
  const countries = [...el.countries];
  const plots = [...el.plots];
  const byName = new Map(countries.map((c) => [c.name, c]));
  for (const s of shapes) {
    const cname = (s.countryName || '未知国家').trim() || '未知国家';
    let c = byName.get(cname);
    if (!c) {
      c = { id: `tc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: cname, color: TERRITORY_PALETTE[countries.length % TERRITORY_PALETTE.length] };
      countries.push(c);
      byName.set(cname, c);
    }
    plots.push({
      id: `tp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: s.plotName || cname,
      rings: s.rings,
      ownerId: c.id,
    });
  }
  return { countries, plots };
}

const NAME_KEYS = ['name', 'NAME', 'Name', 'ADMIN', 'admin', '名称', '国名', 'country', 'COUNTRY', 'Country'];
const COUNTRY_KEYS = ['country', 'COUNTRY', 'Country', '国家', '所属国', 'owner', 'OWNER'];

function pickProp(props: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = props?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** GeoJSON FeatureCollection → 地块输入（Polygon=1 地块；MultiPolygon 每个面=1 地块） */
export function parseTerritoryGeoJSON(fc: any): TerritoryShapeInput[] {
  const out: TerritoryShapeInput[] = [];
  const features = Array.isArray(fc?.features) ? fc.features : [];
  for (const f of features) {
    const g = f?.geometry;
    if (!g) continue;
    const props = (f.properties || {}) as Record<string, unknown>;
    const name = pickProp(props, NAME_KEYS);
    const cname = pickProp(props, COUNTRY_KEYS) || name || '未知国家';
    const push = (rings: [number, number][][], idx: number, total: number) => {
      if (!rings || !rings[0] || rings[0].length < 4) return;
      const suffix = total > 1 ? `·${idx + 1}` : '';
      out.push({ countryName: cname, plotName: `${name || cname}${suffix}`, rings });
    };
    if (g.type === 'Polygon') {
      push(g.coordinates, 0, 1);
    } else if (g.type === 'MultiPolygon') {
      const parts = g.coordinates as unknown as [number, number][][][];
      parts.forEach((rings, i) => push(rings, i, parts.length));
    }
  }
  return out;
}
