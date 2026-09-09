// 疆域系统核心逻辑：归属推导 / 颜色渐变 / 势力边界并集 / 描线切片 / 位图标签 / 导入合并
// 纯函数 + turf，供编辑器与导出端共用（渲染层在 map-renderer.renderTerritory）
import * as turf from '@turf/turf';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import type {
  TerritoryCountry, TerritoryEvent, TerritoryPlot, TerritoryElement, TerritoryDisplay,
} from '../types';

/** 自动配色盘（按势力数量循环取色，保证相邻势力颜色区分） */
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

/** 渲染用归属（国界联合/名称标签）：动画事件（fade/draw/spread/shrink）进行中保持旧归属，
 *  完成后才切换；instant 仍在事件帧立即切换。 */
export function ownerVisualAt(plot: TerritoryPlot, events: TerritoryEvent[], frame: number): string {
  const evs = eventsForPlot(events, plot.id);
  let owner = plot.ownerId;
  for (const ev of evs) {
    if (frame < ev.frame) continue;
    const preset = ev.effect?.preset ?? 'draw';
    if (preset === 'instant') { owner = ev.toCountryId; continue; }
    if (frame >= effectWindow(ev).fadeEnd) owner = ev.toCountryId;
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

/** 当前帧地块填充色（含渐变插值）：返回 hex。
 *  allPlots 供 spread（扩散）与 shrink（蚕食）判定占领方前线；缺省时回退为整块渐变。 */
export function plotColorAt(
  plot: TerritoryPlot, events: TerritoryEvent[], frame: number, countries: TerritoryCountry[],
  allPlots?: TerritoryPlot[],
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
  const prev = countryColor(prevOwner);
  if (preset === 'spread') {
    // 扩散：推进区由渲染层单独绘制新色，本体保持旧色；
    // 与占领方无共享边界（无前线可依）→ 回退为整块渐变
    if (allPlots && spreadFrontier(plot, events, ev, allPlots).length) return prev;
    return lerpColor(prev, target, t);
  }
  if (preset === 'shrink') {
    // 蚕食：动画期间本体（未吞并区/描边）保持旧色，已吞并区由渲染层单独绘制新色；
    // 无前线（无邻接）→ 回退为整块渐变
    if (allPlots && spreadFrontier(plot, events, ev, allPlots).length) return prev;
    return lerpColor(prev, target, t);
  }
  // fade / draw：整块颜色渐变（描线动画仅 draw 有）
  return lerpColor(prev, target, t);
}

/** 当前帧地块的描线进度（0–1；未在描线期返回 1）与高亮强度（0–1） */
export function plotFxAt(plot: TerritoryPlot, events: TerritoryEvent[], frame: number, countries: TerritoryCountry[]): { draw: number; glow: number; glowColor: string } {
  const evs = eventsForPlot(events, plot.id);
  let draw = 1, glow = 0, glowColor = '#FFFFFF';
  for (const ev of evs) {
    const preset = ev.effect?.preset ?? 'draw';
    const win = effectWindow(ev);
    // 描线进度（仅 draw 有描线阶段；fade=纯渐变，spread=扩散，instant 无动画）
    if (preset === 'draw' && frame >= win.start && frame < win.drawEnd) {
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

// ========== 兼并扩散（spread）：从与占领方相邻的边界向外推进 ==========

/** 点到线段距离（平面度坐标） */
function distToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

/** 扩散前线：地块各环上与占领方既有地块共享/接触的边段（1e-5° 容差 + 内含判定）。
 *  返回空 = 无前线（无邻接或占领方尚无地块）→ 上层回退整块渐变。 */
function spreadFrontier(
  plot: TerritoryPlot, events: TerritoryEvent[], ev: TerritoryEvent, allPlots: TerritoryPlot[],
): [number, number][][] {
  const sameEvent = new Set(ev.plotIds);
  const invRings: [number, number][][] = [];
  for (const pl of allPlots) {
    if (pl.id === plot.id || sameEvent.has(pl.id)) continue;
    if (!pl.rings?.[0] || pl.rings[0].length < 4) continue;
    if (ownerAt(pl, events, ev.frame) !== ev.toCountryId) continue;
    for (const r of pl.rings) if (r && r.length >= 4) invRings.push(r);
  }
  if (!invRings.length) return [];
  const eps = 1e-5;
  const segs: [number, number][][] = [];
  for (const ring of plot.rings) {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i], b = ring[i + 1];
      const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      let hit = false;
      for (const r of invRings) {
        if (distToRingBoundary(mid, r) < eps) { hit = true; break; }
        try {
          if (turf.booleanPointInPolygon(turf.point(mid), turf.polygon([r]))) { hit = true; break; }
        } catch { /* 非法环跳过 */ }
      }
      if (hit) segs.push([a, b]);
    }
  }
  return segs;
}

export interface PlotSpreadState {
  active: boolean;                        // 正在扩散（渲染层绘制 region 新色覆盖）
  p: number;                              // 扩散进度 0–1
  color: string;                          // 新色（占领方颜色）
  region: [number, number][][][] | null;  // 新色区域（每个面=环组；含洞）
}

/** 当前帧地块的扩散动画状态（渲染层据此绘制推进区；编辑端/导出端共用）。
 *  active=false 时渲染层不画覆盖层，颜色由 plotColorAt 的回退逻辑接管。 */
export function plotSpreadAt(
  plot: TerritoryPlot, events: TerritoryEvent[], frame: number, countries: TerritoryCountry[], allPlots: TerritoryPlot[],
): PlotSpreadState {
  const evs = eventsForPlot(events, plot.id);
  for (const ev of sortedEvents(evs)) {
    if ((ev.effect?.preset ?? 'draw') !== 'spread') continue;
    const win = effectWindow(ev);
    if (frame < win.start || frame >= win.fadeEnd) continue;
    const p = clamp01((frame - win.start) / Math.max(1, win.fadeEnd - win.start));
    const color = countries.find((c) => c.id === ev.toCountryId)?.color || '#888888';
    const segs = spreadFrontier(plot, events, ev, allPlots);
    if (!segs.length) return { active: false, p, color, region: null };
    // 推进半径 = 前线到最远顶点的距离 × 进度（1.08 冗余保证收尾全覆盖）
    let maxD = 0;
    for (const ring of plot.rings) {
      for (const v of ring) {
        let best = Infinity;
        for (const [a, b] of segs) best = Math.min(best, distToSegment(v, a, b));
        if (best > maxD) maxD = best;
      }
    }
    if (!Number.isFinite(maxD) || maxD <= 0) return { active: false, p, color, region: null };
    const r = Math.max(1e-7, p * maxD * 1.08);
    try {
      const buf = turf.buffer(turf.multiLineString(segs), r, { units: 'degrees' });
      const bufGeom = (buf as unknown as { geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon } | null)?.geometry;
      if (!bufGeom) return { active: false, p, color, region: null };
      const plotPoly = turf.polygon(plot.rings);
      const inter = turf.intersect(turf.featureCollection([buf as any, plotPoly]));
      const g = (inter as unknown as { geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon } | null)?.geometry;
      if (!g) return { active: false, p, color, region: null };
      const polys: [number, number][][][] = g.type === 'Polygon'
        ? [g.coordinates as [number, number][][]]
        : (g.coordinates as [number, number][][][]);
      return { active: true, p, color, region: polys.length ? polys : null };
    } catch (e) {
      // 剪裁失败：收尾阶段直接整块新色，否则视为未激活（避免闪烁）
      console.warn('[territory] spread buffer/intersect 失败:', e);
      return p > 0.9
        ? { active: true, p, color, region: [plot.rings] }
        : { active: false, p, color, region: null };
    }
  }
  return { active: false, p: 0, color: '', region: null };
}

// ========== 兼并蚕食（shrink）：扩散机制 + 湍流置换前沿 ==========
// 与占领方邻接的前线（同 spread 判定）整体向外推进；前沿各点沿内法向叠加
// 多频正弦湍流置换（相位随进度漂移、幅度随进度收敛）→ 有机指状边缘；
// 未吞并区始终贴原始轮廓。无前线（无邻接）→ 整块渐变兜底（与扩散一致）。

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** 字符串种子 → n 个稳定相位（0–2π）：湍流形状编辑端/导出端一致 */
function phasesOf(key: string, n: number): number[] {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  const s = (h >>> 0) + 0.5;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = Math.sin(s * (12.9898 + i * 7.233)) * 43758.5453;
    out.push((v - Math.floor(v)) * Math.PI * 2);
  }
  return out;
}

/** 湍流置换矢量场：x/y 各三频正弦叠加（归一化坐标，波长约地块跨度 1/2、1/4、1/8），相位随进度漂移 */
function turbVec(nx: number, ny: number, p: number, ph: number[]): [number, number] {
  const vx = 0.55 * Math.sin(nx * 12.6 + ny * 4.1 + p * 2.2 + ph[0])
    + 0.30 * Math.sin(nx * 5.3 - ny * 24.8 - p * 1.6 + ph[1])
    + 0.15 * Math.sin(nx * 50.2 + ny * 9.7 + p * 3.1 + ph[2]);
  const vy = 0.55 * Math.sin(nx * 7.7 - ny * 11.9 - p * 1.9 + ph[3])
    + 0.30 * Math.sin(nx * 21.4 + ny * 5.6 + p * 2.7 + ph[4])
    + 0.15 * Math.sin(nx * 8.9 + ny * 47.3 - p * 3.4 + ph[5]);
  return [vx, vy];
}

export interface PlotShrinkState {
  active: boolean;                        // 蚕食进行中（渲染层互斥绘制：未吞并=旧色，已吞并=新色）
  p: number;                              // 缓动后进度 0–1
  fade: number;                           // 未吞并区不透明度系数（恒 1：前线推过即自然消失）
  color: string;                          // 新色（占领方）
  prevColor: string;                      // 旧色（未吞并区）
  region: [number, number][][][] | null;  // 未吞并区（保持原始轮廓）；null=已被完全吞并
}

/** 当前帧地块的蚕食动画状态（编辑端/导出端共用）。
 *  前线=与占领方邻接的边界，随进度扩散推进；前沿叠加湍流置换（指状有机边缘）；
 *  无邻接前线 → active=false，由 plotColorAt 的整块渐变兜底（与扩散一致）。 */
export function plotShrinkAt(
  plot: TerritoryPlot, events: TerritoryEvent[], frame: number, countries: TerritoryCountry[], allPlots: TerritoryPlot[],
): PlotShrinkState {
  const evs = eventsForPlot(events, plot.id);
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    if ((ev.effect?.preset ?? 'draw') !== 'shrink') continue;
    const win = effectWindow(ev);
    if (frame < win.start || frame >= win.fadeEnd) continue;
    const countryColor = (id: string) => countries.find((c) => c.id === id)?.color || '#888888';
    const prevOwner = i === 0 ? plot.ownerId : evs[i - 1].toCountryId;
    const color = countryColor(ev.toCountryId);
    const prevColor = countryColor(prevOwner);
    if (!plot.rings?.[0] || plot.rings[0].length < 4) {
      return { active: true, p: 1, fade: 1, color, prevColor, region: null };
    }
    const raw = clamp01((frame - win.start) / Math.max(1, win.fadeEnd - win.start));
    const p = easeInOutCubic(raw);
    const mk = (region: [number, number][][][] | null): PlotShrinkState =>
      ({ active: true, p, fade: 1, color, prevColor, region });
    if (raw >= 0.97) return mk(null); // 收尾：跳过残带发丝差集，直接落位
    // 前线（同扩散判定）：与占领方既有地块接触的边段
    const segs = spreadFrontier(plot, events, ev, allPlots);
    if (!segs.length) return { active: false, p, fade: 1, color, prevColor, region: null };
    // 几何量：推进半径上限（前线到最远顶点）、跨度（湍流波长与采样步长基准）
    let maxD = 0, xs0 = Infinity, xs1 = -Infinity, ys0 = Infinity, ys1 = -Infinity;
    for (const ring of plot.rings) {
      for (const v of ring) {
        let best = Infinity;
        for (const [a, b] of segs) best = Math.min(best, distToSegment(v, a, b));
        if (best > maxD) maxD = best;
        if (v[0] < xs0) xs0 = v[0];
        if (v[0] > xs1) xs1 = v[0];
        if (v[1] < ys0) ys0 = v[1];
        if (v[1] > ys1) ys1 = v[1];
      }
    }
    if (!Number.isFinite(maxD) || maxD <= 0) return { active: false, p, fade: 1, color, prevColor, region: null };
    const span = Math.max(1e-7, Math.max(xs1 - xs0, ys1 - ys0));
    const ph = phasesOf(`${plot.id}|${ev.id}`, 6);
    const plotPoly = turf.polygon(plot.rings as [number, number][][]);
    const inside = (pt: [number, number]) => {
      try { return turf.booleanPointInPolygon(turf.point(pt), plotPoly); } catch { return false; }
    };
    // 各前线段的内法向（中点沿法向微移落在地块内为正）
    const segData = segs.map(([a, b]) => {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1e-12;
      let nx = -dy / len, ny = dx / len;
      const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (!inside([mid[0] + nx * 1e-4, mid[1] + ny * 1e-4])) { nx = -nx; ny = -ny; }
      return { a, b, len, nx, ny, tx: dx / len, ty: dy / len };
    });
    // 顶点法向合并（相邻前线段共享顶点取平均 → 置换后前线链无缝衔接）
    const vnorm = new Map<string, { x: number; y: number }>();
    for (const sd of segData) {
      for (const pt of [sd.a, sd.b]) {
        const key = coordKey(pt);
        const e = vnorm.get(key) || { x: 0, y: 0 };
        e.x += sd.nx; e.y += sd.ny;
        vnorm.set(key, e);
      }
    }
    const vNormal = (pt: [number, number]) => {
      const e = vnorm.get(coordKey(pt));
      if (!e) return null;
      const l = Math.hypot(e.x, e.y);
      return l > 1e-12 ? { nx: e.x / l, ny: e.y / l } : null;
    };
    // 前线链（按环序连段，断点/跨环开新链）；段内加密采样 → 湍流置换出前沿折线。
    // 起步容差 tol：推进量未超过 tol 的前沿段不产生已吞并条带（避免与地块边界重合的
    // 退化差集 → 发丝级新色描边伪影）；连续已咬入的采样段各成条带。
    const R = p * maxD * 1.65;                                 // 平均推进距离（冗余保证收尾全覆盖）
    const wN = 0.62 * (1 - 0.6 * p);                           // 法向湍流幅度（随进度收敛，提前清场）
    const wT = 0.5 * (1 - 0.5 * p);                            // 切向湍流幅度
    const tol = maxD * 0.045;                                  // 起步/收尾容差
    const step = Math.max(span * 0.04, 1e-6);
    type ChainPt = { x: number; y: number; nx: number; ny: number; tx: number; ty: number; eat: boolean };
    const chains: ChainPt[][] = [];
    let cur: ChainPt[] | null = null;
    let prevB: string | null = null;
    for (const sd of segData) {
      if (!cur || prevB !== coordKey(sd.a)) { cur = []; chains.push(cur); }
      const na = vNormal(sd.a) || { nx: sd.nx, ny: sd.ny };
      const nb = vNormal(sd.b) || { nx: sd.nx, ny: sd.ny };
      const subdiv = Math.max(1, Math.ceil(sd.len / step));
      for (let k = cur.length === 0 ? 0 : 1; k <= subdiv; k++) {
        const t = k / subdiv;
        const px = sd.a[0] + (sd.b[0] - sd.a[0]) * t;
        const py = sd.a[1] + (sd.b[1] - sd.a[1]) * t;
        let nx = na.nx + (nb.nx - na.nx) * t;
        let ny = na.ny + (nb.ny - na.ny) * t;
        const nl = Math.hypot(nx, ny) || 1;
        nx /= nl; ny /= nl;
        const [vx, vy] = turbVec(px / span, py / span, p, ph);
        const offN = R * (1 + wN * vx) - tol;                  // 法向：推进 + 指状起伏，越过容差才算咬入
        const offT = R * wT * vy;                              // 切向：置换抖动（位置驱动，共享顶点天然一致）
        const eat = offN > 0;
        const adv = Math.max(offN, 0);
        cur.push({ x: px + nx * adv + sd.tx * offT, y: py + ny * adv + sd.ty * offT, nx, ny, tx: sd.tx, ty: sd.ty, eat });
      }
      prevB = coordKey(sd.b);
    }
    // 链端沿切向延伸出地块范围：避免端部滑移/容差在地块上下边缘留下未覆盖残带
    const ext = span * 1.2;
    for (const ch of chains) {
      if (!ch.length) continue;
      const first = ch[0], last = ch[ch.length - 1];
      ch.unshift({ x: first.x - first.tx * ext, y: first.y - first.ty * ext, nx: first.nx, ny: first.ny, tx: first.tx, ty: first.ty, eat: true });
      ch.push({ x: last.x + last.tx * ext, y: last.y + last.ty * ext, nx: last.nx, ny: last.ny, tx: last.tx, ty: last.ty, eat: true });
    }
    // 前线链 → 已吞并区（连续咬入段的条带）；多链/多段求并集
    const back = maxD * 4 + span * 0.5 + 1e-3;
    const strips: Feature<Polygon>[] = [];
    for (const ch of chains) {
      let run: ChainPt[] = [];
      const flush = () => {
        if (run.length >= 2) {
          const ring: [number, number][] = [
            ...run.map((q) => [q.x, q.y] as [number, number]),
            ...run.slice().reverse().map((q) => [q.x - q.nx * back, q.y - q.ny * back] as [number, number]),
          ];
          ring.push(ring[0]); // GeoJSON 环必须闭合
          try { strips.push(turf.polygon([ring]) as Feature<Polygon>); } catch { /* 跳过坏链 */ }
        }
        run = [];
      };
      for (const q of ch) { if (q.eat) run.push(q); else flush(); }
      flush();
    }
    if (!strips.length) return mk([plot.rings as [number, number][][]]); // 尚未咬入 → 整块保持旧色
    try {
      let eaten: Feature<Polygon | MultiPolygon>[] = strips;
      if (strips.length > 1) {
        try {
          const u = turf.union(turf.featureCollection(strips)) as unknown as Feature<Polygon | MultiPolygon> | null;
          if (u) eaten = [u];
        } catch { /* 并集失败 → 逐条带作差 */ }
      }
      const diff = turf.difference(turf.featureCollection([plotPoly as Feature<Polygon>, ...eaten]));
      const g = (diff as unknown as { geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon } | null)?.geometry;
      if (!g) return mk(null); // 差集为空 → 已被完全吞并
      const polys: [number, number][][][] | null = g.type === 'Polygon'
        ? [g.coordinates as [number, number][][]]
        : g.type === 'MultiPolygon'
          ? (g.coordinates as [number, number][][][])
          : null;
      if (polys && polys.length) return mk(polys);
      return mk(null);
    } catch (e) {
      console.warn('[territory] shrink 前线切分失败，整块渐变兜底:', e);
      return p > 0.9 ? mk(null) : { active: false, p, fade: 1, color, prevColor, region: null };
    }
  }
  return { active: false, p: 0, fade: 1, color: '', prevColor: '', region: null };
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

/** 同势力地块并集（势力边界外边界）：失败返回 null（渲染层回退为逐地块描边） */
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

/** 面要素质心（供势力/地块名锚点） */
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
// 势力标签=大号加粗白字+深色描边+势力色圆点前缀；地块标签=小号+半透明圆角底条（pill），二者一眼可分。

export interface TerritoryLabelStyle {
  size: number; bold?: boolean; color?: string; halo?: string; haloWidth?: number;
  /** 半透明圆角底条（地块标签用） */
  bg?: string;
  /** 文字左侧色点（势力标签用，颜色=势力色） */
  dotColor?: string;
}

export function makeTerritoryLabelImageData(text: string, st: TerritoryLabelStyle): ImageData {
  const size = Math.max(8, Math.round(st.size));
  const haloWidth = st.haloWidth ?? 3;
  const dotR = st.dotColor ? Math.max(2, Math.round(size * 0.16)) : 0;
  const padL = haloWidth + (dotR > 0 ? dotR * 2 + Math.max(4, Math.round(size * 0.3)) : 0);
  const padR = haloWidth + (st.bg ? 5 : 0);
  const canvas = document.createElement('canvas');
  const ctx0 = canvas.getContext('2d')!;
  const font = `${st.bold === false ? '' : 'bold '}${size}px "Microsoft YaHei", "PingFang SC", sans-serif`;
  ctx0.font = font;
  const tw = Math.ceil(ctx0.measureText(text || ' ').width);
  const w = padL + tw + padR + 4;
  const h = Math.ceil(size * 1.5) + haloWidth * 2;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  if (st.bg) {
    // 圆角底条（pill）
    ctx.fillStyle = st.bg;
    const r = Math.min((h - 2) / 2, 8);
    ctx.beginPath();
    ctx.moveTo(1 + r, 1);
    ctx.arcTo(w - 1, 1, w - 1, h - 1, r);
    ctx.arcTo(w - 1, h - 1, 1, h - 1, r);
    ctx.arcTo(1, h - 1, 1, 1, r);
    ctx.arcTo(1, 1, w - 1, 1, r);
    ctx.closePath();
    ctx.fill();
  }
  if (dotR > 0) {
    ctx.fillStyle = st.dotColor || '#FFFFFF';
    ctx.beginPath();
    ctx.arc(haloWidth + dotR, h / 2, dotR, 0, Math.PI * 2);
    ctx.fill();
  }
  const tx = padL + tw / 2;
  if (haloWidth > 0 && !st.bg) {
    ctx.strokeStyle = st.halo || 'rgba(0,0,0,0.85)';
    ctx.lineWidth = haloWidth * 2;
    ctx.strokeText(text || '', tx, h / 2);
  }
  ctx.fillStyle = st.color || '#FFFFFF';
  ctx.fillText(text || '', tx, h / 2);
  return ctx.getImageData(0, 0, w, h);
}

/** 位图标签 imageId（同文案+样式复用同一张贴图） */
export function territoryLabelImageId(text: string, st: TerritoryLabelStyle): string {
  const key = `${text}|${st.size}|${st.bold === false ? 0 : 1}|${st.color}|${st.halo || ''}|${st.haloWidth ?? 3}|${st.bg || ''}|${st.dotColor || ''}`;
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

/** 内置势力库/GeoJSON 解析出的地块，并入库（同名势力合并、自动配色） */
export function mergeShapesIntoTerritory(
  el: TerritoryElement, shapes: TerritoryShapeInput[],
): { countries: TerritoryCountry[]; plots: TerritoryPlot[] } {
  const countries = [...el.countries];
  const plots = [...el.plots];
  const byName = new Map(countries.map((c) => [c.name, c]));
  for (const s of shapes) {
    const cname = (s.countryName || '未知势力').trim() || '未知势力';
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
    const cname = pickProp(props, COUNTRY_KEYS) || name || '未知势力';
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
