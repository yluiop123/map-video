/**
 * 飞行拱形自定义图层（原生 WebGL Custom Layer，earcut 用于多边形三角化）。
 *
 * **真 3D 几何**：路线在 CPU 端构建成世界空间 3D 网格，经 MapLibre v5 的
 * projectTileFor3D 投影——mercator 与 globe（3D 球体）均正确。
 *  · 路线 → **圆柱管**：沿路径每采样点生成 8 边形圆截面环，开放路径两端加圆盘端帽；
 *    截面在**屏幕空间**构造（宽高一致，不随俯仰压扁），半径按屏幕像素定义；
 *  · 立体感：顶点带法向，片元做固定光向的 Lambert 光照（相机无关），上亮下暗；
 *  · 高度：由路径总长度决定（flyArcHeightMeters，data.heightM），世界坐标固定米数——
 *    缩放/俯仰/旋转都不改变弧线（历史实现曾按相机换算拱高并叠加屏幕兜底抬升，已移除）。
 *  · 仅服务 line 类路线（直线/曲线/带箭头直线/箭头曲线）；箭头元素的飞行渲染已移除。
 *  - 高程语义：自定义图层路径下 elevation=米（mercator 内部按 z=meters/(R·cos lat) 换算，
 *    globe 直接米，shader 内逐顶点换算）；**拱高由路径总长度决定**（flyArcHeightMeters，
 *    世界坐标固定米数）——缩放/俯仰/旋转都不改变弧线高度，不再做屏幕空间兜底抬升；
 *  - 线宽/端帽在屏幕空间扩展（NDC 偏移），与标记点平移一致；
 *  - 相机静止时缓冲零重建（mercat 位置不随相机变；仅 dash 距离依赖相机，脏检查重建）；
 *  - 线模式自带侧边/端帽/虚线端 1px 抗锯齿；多边形模式（箭头填充）由闭合 AA 描边覆盖轮廓锯齿。
 *
 * 用法：renderLine / renderArrow 在 fly 模式下每帧调用 setFlyRibbon(map, key, data)（内部脏检查）；
 * 关闭/删除时传 null 或 clearFlyRibbons。选中拾取：pickFlyRibbon；标记点/光点/头部图标用
 * projectLifted 取与拱形一致的屏幕位置（或直接注册为贴图标记点 setFlyMarker，与拱精确对齐）。
 *
 * 限制：globe 背面（地平线外）与 terrain 高程不参与计算，与旧实现一致。
 */
import type { Map as MaplibreMap } from 'maplibre-gl';

/** 飞行高度剖面（返回 0..1）：起点爬升 → 巡航 → 终点下降（smoothstep，ramp=0.18） */
export function flyHeight01(p: number): number {
  const x = Math.max(0, Math.min(1, p || 0));
  const ramp = 0.18;
  const ss = (t: number) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };
  if (x < ramp) return ss(x / ramp);
  if (x > 1 - ramp) return ss((1 - x) / ramp);
  return 1;
}

/** 线模式的一条路径（f 缺省时用 frac 弧长映射；closed 时首尾相连无端帽） */
export interface FlyRibbonLinePath {
  coords: [number, number][];
  f?: number[];
  /** 每顶点绝对抬升 0..1（如地面投影 track 全 0）；提供时优先于 flyHeight01(f) 且不做弧长加密 */
  lifts?: number[];
  closed?: boolean;
}

export interface FlyRibbonDataLine {
  kind?: 'line';
  paths: FlyRibbonLinePath[];
  /** 弧长映射区间（无 per-vertex f 时生效） */
  frac?: { a: number; b: number };
  color: string;
  widthPx: number;
  opacity?: number;
  dash?: number[];
  /** 弧顶高度（米）——由路径总长度决定（flyArcHeightMeters），**与相机无关** */
  heightM?: number;
}

/** 飞行层数据类型：仅线（管）——箭头元素的飞行渲染已移除 */
export type FlyRibbonData = FlyRibbonDataLine;

const LAYER_ID = 'fly-ribbons';
/** 顶点布局：aPos(3: merc x, y, zElev) + aNrm(3: 法向，光照用) + aDist(1: 沿线屏幕弧长，虚线用) */
const VERT_STRIDE = 7;
/** 管截面边数（8 边形视觉上即圆柱） */
const TUBE_SIDES = 8;
/** 拱形视觉高度（屏幕 px）——仅兜底换算用（flyLiftMeters），正常路径高度见 flyArcHeightMeters */
export const FLY_VISUAL_PX = 96;

/**
 * 飞行弧顶高度（米）——**由路径总长度决定，与相机视角无关**。
 * 高度 = 总长 × 0.12（约 300m ~ 25km 之间），配合 flyHeight01 的爬升/巡航/下降剖面，
 * 呈现一段固定的真实弧线；缩放、俯仰、旋转都不改变它。
 */
export function flyArcHeightMeters(totalLenMeters: number): number {
  const l = Number.isFinite(totalLenMeters) ? Math.max(0, totalLenMeters) : 0;
  return Math.max(300, Math.min(25000, l * 0.12));
}
const M_PER_SAMPLE = 1000;
/** 地球半径（米），mercator z 单位换算用：z = meters / (R·cos lat)，与 MercatorCoordinate.fromLngLat 一致 */
const EARTH_R = 6378137;

/** 调试钩子（自动化回归用）：window.__flyRibbonDbg */
export const flyRibbonDbg: Record<string, any> =
  typeof window !== 'undefined' ? (((window as any).__flyRibbonDbg ||= { renderCalls: 0, drawn: 0, setCalls: 0 }) as Record<string, any>) : {};

interface RibbonEntry {
  data: FlyRibbonData;
  buffer: WebGLBuffer | null;
  vertCount: number;
  buildKey: string;
  lastCamSig: string;
}

interface RibbonGlState {
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  program: WebGLProgram | null;
  variantName: string;
  aPos: number;
  aNrm: number;
  aDist: number;
  uViewport: WebGLUniformLocation | null;
  uColor: WebGLUniformLocation | null;
  uOpacity: WebGLUniformLocation | null;
  uWidthPx: WebGLUniformLocation | null;
  uLiftM: WebGLUniformLocation | null;
  uScreenLift: WebGLUniformLocation | null;
  uZIsMercator: WebGLUniformLocation | null;
  uEdgeAA: WebGLUniformLocation | null;
  uDashTotal: WebGLUniformLocation | null;
  uDashCount: WebGLUniformLocation | null;
  uDash: WebGLUniformLocation | null;
  uProjMatrix: WebGLUniformLocation | null;
  uTileMerc: WebGLUniformLocation | null;
  uClipPlane: WebGLUniformLocation | null;
  uProjTransition: WebGLUniformLocation | null;
  uFallbackMatrix: WebGLUniformLocation | null;
  markerProgram: WebGLProgram | null;
  markerAPos: number;
  markerAUV: number;
  markerUTex: WebGLUniformLocation | null;
  markerUOpacity: WebGLUniformLocation | null;
  markerTextures: Map<string, WebGLTexture>;
  freeBuffers: WebGLBuffer[];
}

const entriesByMap = new WeakMap<MaplibreMap, Map<string, RibbonEntry>>();
const glStateByMap = new WeakMap<MaplibreMap, RibbonGlState>();

const VERT_SRC = (prelude: string, define: string) => `
${prelude}
${define}
attribute vec3 aPos;
attribute vec3 aNrm;
attribute float aDist;
varying float vDist;
varying float vShade;
void main() {
  // aPos.xy = 归一化 mercator；aPos.z = 高程（CPU 端已按投影换算：mercator=米/(R·cosLat)，globe=米）
  vec4 cp = projectTileFor3D(aPos.xy, aPos.z);
  gl_Position = vec4(cp.xy, 0.0, cp.w);
  // 立体光照：固定光向（与相机无关），法向来自管面/挤出侧面 → 上亮下暗
  vec3 N = normalize(aNrm);
  vec3 L = normalize(vec3(0.42, -0.34, 0.84));
  // 轻量光照：环境光为主 + 法向贡献，既保留立体明暗又不压暗整体颜色
  vShade = 0.72 + 0.28 * max(0.0, dot(N, L));
  vDist = aDist;
}
`;

const FRAG_SRC = `
precision highp float;
uniform vec4 uColor;
uniform float uOpacity;
uniform float uDashTotal;
uniform float uDashCount;
uniform float uDash[6];
varying float vDist;
varying float vShade;
void main() {
  float alpha = 1.0;
  if (uDashTotal > 0.0) {
    float d = mod(vDist, uDashTotal);
    float acc = 0.0;
    float aD = 0.0;
    float edge = 1.0;
    for (int i = 0; i < 6; i++) {
      if (float(i) >= uDashCount) break;
      float seg = uDash[i];
      if (d < acc + seg) {
        aD = (i == 0 || i == 2 || i == 4) ? 1.0 : 0.0;
        edge = min(d - acc, acc + seg - d);
        break;
      }
      acc += seg;
    }
    alpha = aD * (1.0 - smoothstep(0.0, 1.0, edge));
  }
  if (alpha <= 0.003) discard;
  gl_FragColor = vec4(uColor.rgb * vShade, uColor.a * uOpacity * alpha);
}
`;

/** lnglat → 归一化 web mercator [0..1] */
function lnglatToMerc(c: [number, number]): [number, number] {
  const x = (c[0] + 180) / 360;
  const lat = Math.max(-85.051129, Math.min(85.051129, c[1]));
  const s = Math.sin((lat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return [x, y];
}

function hexToRgba(color: string): [number, number, number, number] {
  const c = (color || '#FF0000').trim();
  let m = /^#([0-9a-fA-F]{6})$/.exec(c);
  if (m) {
    const v = parseInt(m[1], 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, 1];
  }
  m = /^#([0-9a-fA-F]{3})$/.exec(c);
  if (m) {
    const v = m[1];
    return [parseInt(v[0] + v[0], 16) / 255, parseInt(v[1] + v[1], 16) / 255, parseInt(v[2] + v[2], 16) / 255, 1];
  }
  m = /rgba?\(([^)]+)\)/.exec(c);
  if (m) {
    const parts = m[1].split(',').map((x) => parseFloat(x.trim()));
    const a = parts.length > 3 && parts[3] !== undefined ? parts[3] : 1;
    return [(parts[0] || 0) / 255, (parts[1] || 0) / 255, (parts[2] || 0) / 255, a];
  }
  return [1, 0, 0, 1];
}

/** mercator 空间按弧长加密路径到 target 点（f 数组随插值），不足 target 时才加密 */
function densifyMerc(
  pts: [number, number][],
  fArr: number[] | null,
  closed: boolean,
  target: number
): { pts: [number, number][]; f: number[] | null } {
  const n0 = pts.length;
  if (n0 < 2 || n0 >= target) return { pts, f: fArr };
  const edgeCount = closed ? n0 : n0 - 1;
  let total = 0;
  const edgeLen: number[] = [];
  for (let i = 0; i < edgeCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n0];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    edgeLen.push(l);
    total += l;
  }
  if (!(total > 0)) return { pts, f: fArr };
  const n = target;
  const outPts: [number, number][] = [];
  const outF: number[] = [];
  let segI = 0;
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const want = (k / (n - (closed ? 0 : 1))) * total;
    while (segI < edgeCount - 1 && acc + edgeLen[segI] < want) {
      acc += edgeLen[segI];
      segI++;
    }
    const segL = edgeLen[segI];
    const t = segL > 0 ? Math.max(0, Math.min(1, (want - acc) / segL)) : 0;
    const a = pts[segI];
    const b = pts[(segI + 1) % n0];
    outPts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    if (fArr) {
      const fa = fArr[segI];
      const fb = fArr[(segI + 1) % n0];
      outF.push(fa + (fb - fa) * t);
    }
  }
  if (closed) outPts[outPts.length - 1] = [...outPts[0]] as [number, number];
  return { pts: outPts, f: fArr ? outF : null };
}

/** 相机签名（仅影响 dash 的屏幕弧长距离；merc 位置本身不随相机变） */
function cameraSig(map: MaplibreMap): string {
  const c = map.getCenter();
  const canvas = map.getCanvas();
  const proj = (map as any)?.getProjection?.()?.type ?? '?';
  return [
    map.getZoom().toFixed(5), c.lng.toFixed(7), c.lat.toFixed(7),
    map.getPitch().toFixed(3), map.getBearing().toFixed(3),
    canvas.clientWidth, canvas.clientHeight, proj,
  ].join('|');
}

/** mat4(column-major) × vec4 */
function mat4MulVec4(m: ArrayLike<number>, v: [number, number, number, number]): [number, number, number, number] {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ];
}

/**
 * 把带高程（米）的 lnglat 点投影到屏幕 CSS px（与 fly-ribbon 着色器同一投影矩阵）。
 * 用于：标记点/光点/头部图标的 icon-translate 与拾取判定。
 * mercator：elevation 单位=mercator z（meters/(R·cos lat)）；globe：mercator→单位球面→
 * 按高程外推→globe 矩阵（与 shader projectTileFor3D/interpolateProjectionFor3D 一致）。
 * lift01（0..1）提供时叠加屏幕空间兜底抬升（低俯仰下世界高程在屏幕上趋近 0，见 flyScreenLiftPx）。
 */
export function projectLifted(
  map: MaplibreMap,
  lnglat: [number, number],
  liftM: number,
  lift01?: number
): { x: number; y: number } {
  const canvas = map.getCanvas();
  const w = Math.max(1, canvas.clientWidth);
  const h = Math.max(1, canvas.clientHeight);
  const t = (map as any).transform;
  const isGlobe = (map as any).getProjection?.()?.type === 'globe';
  try {
    const pd = t.getProjectionDataForCustomLayer(isGlobe);
    const merc = lnglatToMerc(lnglat);
    let clip: [number, number, number, number];
    if (isGlobe) {
      // 与 shader 同源：mercator [0..1] → 经纬球面坐标 → (1+h/R) 外推 → globe 矩阵
      const sx = merc[0] * Math.PI * 2 + Math.PI;
      const sy = 2 * Math.atan(Math.exp(Math.PI - merc[1] * Math.PI * 2)) - Math.PI * 0.5;
      const len = Math.cos(sy);
      const k = 1 + (liftM || 0) / 6371008.8;
      clip = mat4MulVec4(pd.mainMatrix, [Math.sin(sx) * len * k, Math.sin(sy) * k, Math.cos(sx) * len * k, 1]);
      const trans = typeof pd.projectionTransition === 'number' ? pd.projectionTransition : 1;
      if (trans < 0.999) {
        // mercator↔globe 过渡：与 shader interpolateProjectionFor3D 同构（fallback 直接吃米制高程）
        const fb = mat4MulVec4(pd.fallbackMatrix || pd.mainMatrix, [merc[0], merc[1], liftM || 0, 1]);
        clip = [
          fb[0] + (clip[0] - fb[0]) * trans,
          fb[1] + (clip[1] - fb[1]) * trans,
          fb[2] + (clip[2] - fb[2]) * trans,
          fb[3] + (clip[3] - fb[3]) * trans,
        ];
      }
    } else {
      const z = (liftM || 0) / (EARTH_R * Math.cos((lnglat[1] * Math.PI) / 180));
      clip = mat4MulVec4(pd.mainMatrix, [merc[0], merc[1], z, 1]);
    }
    const cw = clip[3] !== 0 ? clip[3] : 1;
    const x = (clip[0] / cw * 0.5 + 0.5) * w;
    const y = (1 - (clip[1] / cw * 0.5 + 0.5)) * h;
    // lift01 已不再叠加屏幕空间兜底（高度只由世界高程决定，不随相机变）
    void lift01;
    return { x, y };
  } catch {
    // 兜底：地面投影（matrix 异常时无抬升近似）
    const p = map.project(lnglat as any);
    return { x: p.x, y: p.y };
  }
}

/**
 * 当前相机下，「FLY_VISUAL_PX 视觉高度」对应的高程米数（随 zoom/pitch 自适应，各缩放观感稳定）。
 * 采样屏幕中心点抬升 M_PER_SAMPLE 米的屏幕像素差换算；pitch≈0（俯视）时不可见，回退固定值。
 */
export function flyLiftMeters(map: MaplibreMap): number {
  const c = map.getCenter();
  const ll: [number, number] = [c.lng, c.lat];
  try {
    const base = projectLifted(map, ll, 0);
    const up = projectLifted(map, ll, M_PER_SAMPLE);
    const d = Math.hypot(up.x - base.x, up.y - base.y);
    if (d > 0.5) return Math.min(200000, (FLY_VISUAL_PX * M_PER_SAMPLE) / d);
  } catch { /* */ }
  return 15000;
}

/**
 * 屏幕空间兜底抬升（px）——已停用（恒 0）。
 * 原因：它把「相机俯仰」混进高度，导致拱形随视角变；现在高度由路径总长决定（flyArcHeightMeters），
 * 世界空间高程就是唯一真相。保留此导出仅为兼容潜在外部引用。
 */
export function flyScreenLiftPx(_map: MaplibreMap): number {
  return 0;
}

/** 归一化 mercator → 经纬度（半径换算与屏幕弧长需要真实纬度） */
function mercToLngLat(m: [number, number]): [number, number] {
  const lng = m[0] * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * m[1]))) * 180) / Math.PI;
  return [lng, lat];
}

/** 单条路径 → 交错顶点数组（线模式=3D 圆柱管；poly=沿法向挤出的立体块；位置=mercator XYZ） */
function buildVertices(
  map: MaplibreMap,
  data: FlyRibbonData
): { arr: Float32Array; count: number } | null {
  const isGlobe = (map as any)?.getProjection?.()?.type === 'globe';
  const zoom = map.getZoom();
  const verts: number[] = [];
  const push = (p: [number, number, number], nrm: [number, number, number], dist: number) => {
    verts.push(p[0], p[1], p[2], nrm[0], nrm[1], nrm[2], dist);
  };

  // ===== 线模式：圆柱管 =====
  for (const path of data.paths) {
    if (!path.coords || path.coords.length < 2) continue;
    const lifts = path.lifts && path.lifts.length === path.coords.length ? path.lifts : null;
    const dens = lifts
      ? { pts: path.coords.map(lnglatToMerc), f: path.f ?? null }
      : densifyMerc(
          path.coords.map(lnglatToMerc),
          path.f ?? null,
          !!path.closed,
          Math.min(400, Math.max(180, path.coords.length * 10))
        );
    const merc = dens.pts;
    const n = merc.length;
    if (n < 2) continue;
    const heightM = data.heightM ?? 0;
    const closed = !!path.closed;
    const fArr = dens.f;
    const fOf = (i: number): number => {
      if (fArr) return fArr[i];
      const a = data.frac?.a ?? 0;
      const b = data.frac?.b ?? 1;
      return a + (b - a) * (i / Math.max(1, n - 1));
    };
    const liftOf = (i: number): number =>
      lifts ? Math.max(0, Math.min(1, lifts[Math.min(i, lifts.length - 1)] ?? 0)) : flyHeight01(fOf(i));

    // 中心线 3D 点 + 沿管虚线距离（用真实经纬反算的屏幕弧长）
    const center: Array<[number, number, number]> = [];
    const dist: number[] = new Array(n);
    let prevPx: { x: number; y: number } | null = null;
    for (let i = 0; i < n; i++) {
      const lngLat = mercToLngLat(merc[i]);
      const cos = Math.cos((lngLat[1] * Math.PI) / 180);
      const z = isGlobe ? liftOf(i) * heightM : (liftOf(i) * heightM) / (EARTH_R * cos);
      center.push([merc[i][0], merc[i][1], z]);
      const px = map.project(lngLat as any);
      dist[i] = prevPx ? dist[i - 1] + Math.hypot(px.x - prevPx.x, px.y - prevPx.y) : 0;
      prevPx = px;
    }
    // 横截面：**屏幕空间正圆**（宽度 = 高度，不随俯仰被压扁）。
    // 用当前相机的「屏幕像素 → 地图偏移」逆矩阵把像素圆映射回 merc 偏移；
    // 顶点保持中心高程（截面在等高度面内偏移），投影后屏幕上即为正圆。
    const rPx = Math.max(4, Math.max(0.5, data.widthPx) * 0.9);   // 管屏幕半径（px）
    const midMerc = merc[Math.floor(n / 2)];
    const midLift = liftOf(Math.floor(n / 2)) * heightM;
    const Jinv = screenToMercInv(map, midMerc, midLift);
    const radialOffset = (i: number, th: number): [number, number] => {
      const sx = Math.cos(th) * rPx;
      const sy = Math.sin(th) * rPx;
      if (Jinv) return [Jinv[0] * sx + Jinv[1] * sy, Jinv[2] * sx + Jinv[3] * sy];
      // 回退（矩阵奇异时）：世界空间半径（会随俯仰压扁）
      const lat = mercToLngLat(merc[i])[1];
      const [rx, ry] = pxToMercRadii(lat, zoom, rPx, isGlobe);
      return [Math.cos(th) * rx, Math.sin(th) * ry];
    };
    const rings: Array<Array<[number, number, number]>> = [];
    const nrms: Array<Array<[number, number, number]>> = [];
    for (let i = 0; i < n; i++) {
      const ring: Array<[number, number, number]> = [];
      const rn: Array<[number, number, number]> = [];
      for (let k = 0; k < TUBE_SIDES; k++) {
        const th = (k / TUBE_SIDES) * Math.PI * 2;
        const [ox, oy] = radialOffset(i, th);
        ring.push([center[i][0] + ox, center[i][1] + oy, center[i][2]]);
        rn.push(norm3([ox, oy, 0]));
      }
      rings.push(ring);
      nrms.push(rn);
    }
    // 管身：相邻环连三角带
    const edges = closed ? n : n - 1;
    for (let i = 0; i < edges; i++) {
      const j = (i + 1) % n;
      for (let k = 0; k < TUBE_SIDES; k++) {
        const k2 = (k + 1) % TUBE_SIDES;
        push(rings[i][k], nrms[i][k], dist[i]);
        push(rings[j][k], nrms[j][k], dist[j]);
        push(rings[j][k2], nrms[j][k2], dist[j]);
        push(rings[i][k], nrms[i][k], dist[i]);
        push(rings[j][k2], nrms[j][k2], dist[j]);
        push(rings[i][k2], nrms[i][k2], dist[i]);
      }
    }
    // 端帽：开放路径起终点圆盘（法向沿切线）
    if (!closed) {
      const cap = (idx: number, sign: number) => {
        const C = center[idx];
        const T = norm3([
          (center[Math.min(n - 1, idx + 1)][0] - center[Math.max(0, idx - 1)][0]) * sign,
          (center[Math.min(n - 1, idx + 1)][1] - center[Math.max(0, idx - 1)][1]) * sign,
          (center[Math.min(n - 1, idx + 1)][2] - center[Math.max(0, idx - 1)][2]) * sign,
        ]);
        for (let k = 0; k < TUBE_SIDES; k++) {
          const k2 = (k + 1) % TUBE_SIDES;
          push(C, T, dist[idx]);
          push(rings[idx][k2], T, dist[idx]);
          push(rings[idx][k], T, dist[idx]);
        }
      };
      cap(0, -1);
      cap(n - 1, 1);
    }
  }
  return verts.length > 0 ? { arr: new Float32Array(verts), count: verts.length / VERT_STRIDE } : null;
}

/** 向量工具（3D 管/挤出几何用） */
function norm3(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
// （截面改用屏幕空间构造后，不再需要 3D 切线/叉积工具）

/**
 * 当前相机下「屏幕像素偏移 → mercator 偏移」的线性映射逆矩阵（局部线性化，返回 [m00,m01,m10,m11]）。
 * 用法：把截面圆在**屏幕空间**采样（cosθ·rPx, sinθ·rPx），再用逆矩阵换回地图偏移 ——
 * 这样横截面在屏幕上恒为正圆（宽高一致），不随俯仰角被透视压扁。
 * 返回 null 表示矩阵奇异（极端视角），调用方回退世界空间半径。
 */
function screenToMercInv(map: MaplibreMap, merc: [number, number], liftM: number): [number, number, number, number] | null {
  try {
    const eps = 1e-5;
    const p0 = projectLifted(map, mercToLngLat(merc), liftM);
    const p1 = projectLifted(map, mercToLngLat([merc[0] + eps, merc[1]]), liftM);
    const p2 = projectLifted(map, mercToLngLat([merc[0], merc[1] + eps]), liftM);
    const a = (p1.x - p0.x) / eps;
    const b = (p1.y - p0.y) / eps;
    const c = (p2.x - p0.x) / eps;
    const d = (p2.y - p0.y) / eps;
    const det = a * d - b * c;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-14) return null;
    return [d / det, -c / det, -b / det, a / det];
  } catch {
    return null;
  }
}

/** 该点纬度 / 当前 zoom 下，屏幕像素半径 → mercator 空间三分量半径（x/y 水平，z 高程） */
function pxToMercRadii(lat: number, zoom: number, rPx: number, isGlobe: boolean): [number, number, number] {
  const cos = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const worldMeters = 40075016.686 * cos;
  const metersPerPx = worldMeters / (512 * Math.pow(2, zoom));
  const rM = rPx * metersPerPx;
  return [
    rM / worldMeters,                                  // mercator x
    rM / 40075016.686,                                 // mercator y
    isGlobe ? rM : rM / (EARTH_R * cos),               // 高程（globe=米，mercator=z 单位）
  ];
}

function dataSig(data: FlyRibbonData): string {
  const sigOf = (c: [number, number][] | undefined): string => {
    if (!c || c.length < 1) return 'x';
    const mid = c[Math.floor(c.length / 2)];
    return `${c.length}|${c[0]?.[0].toFixed(6)},${c[0]?.[1].toFixed(6)}|${mid?.[0].toFixed(6)},${mid?.[1].toFixed(6)}|${c[c.length - 1]?.[0].toFixed(6)},${c[c.length - 1]?.[1].toFixed(6)}`;
  };
  const parts: string[] = ['line', data.color];
  {
    for (const p of data.paths) {
      parts.push(sigOf(p.coords), p.closed ? '1' : '0', String(p.f?.length ?? 0));
    }
    parts.push(`${data.frac?.a ?? 0}|${data.frac?.b ?? 1}`, String(data.widthPx), String(data.opacity ?? 1), data.dash ? data.dash.join(',') : '');
  }
  return parts.join('|');
}

function ensureGlState(
  map: MaplibreMap,
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  variantName: string,
  prelude: string,
  define: string
): RibbonGlState | null {
  let st = glStateByMap.get(map);
  if (st && st.program && st.variantName === variantName) return st;
  if (st?.program) {
    try { st.gl.deleteProgram(st.program); } catch { /* */ }
    glStateByMap.delete(map);
    st = undefined;
  }
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('[fly-ribbon] shader 编译失败:', gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  };
  const vs = compile((gl as WebGLRenderingContext).VERTEX_SHADER, VERT_SRC(prelude, define));
  const fs = compile((gl as WebGLRenderingContext).FRAGMENT_SHADER, FRAG_SRC);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('[fly-ribbon] program 链接失败:', gl.getProgramInfoLog(program));
    return null;
  }
  st = {
    gl,
    program,
    variantName,
    aPos: gl.getAttribLocation(program, 'aPos'),
    aNrm: gl.getAttribLocation(program, 'aNrm'),
    aDist: gl.getAttribLocation(program, 'aDist'),
    uViewport: gl.getUniformLocation(program, 'uViewport'),
    uColor: gl.getUniformLocation(program, 'uColor'),
    uOpacity: gl.getUniformLocation(program, 'uOpacity'),
    uWidthPx: gl.getUniformLocation(program, 'uWidthPx'),
    uLiftM: gl.getUniformLocation(program, 'uLiftM'),
    uScreenLift: gl.getUniformLocation(program, 'uScreenLift'),
    uZIsMercator: gl.getUniformLocation(program, 'uZIsMercator'),
    uEdgeAA: gl.getUniformLocation(program, 'uEdgeAA'),
    uDashTotal: gl.getUniformLocation(program, 'uDashTotal'),
    uDashCount: gl.getUniformLocation(program, 'uDashCount'),
    uDash: gl.getUniformLocation(program, 'uDash'),
    uProjMatrix: gl.getUniformLocation(program, 'u_projection_matrix'),
    uTileMerc: gl.getUniformLocation(program, 'u_projection_tile_mercator_coords'),
    uClipPlane: gl.getUniformLocation(program, 'u_projection_clipping_plane'),
    uProjTransition: gl.getUniformLocation(program, 'u_projection_transition'),
    uFallbackMatrix: gl.getUniformLocation(program, 'u_projection_fallback_matrix'),
    markerProgram: null,
    markerAPos: -1,
    markerAUV: -1,
    markerUTex: null,
    markerUOpacity: null,
    markerTextures: new Map(),
    freeBuffers: [],
  };
  glStateByMap.set(map, st);
  return st;
}

function ensureLayer(map: MaplibreMap): void {
  if (map.getLayer(LAYER_ID)) return;
  const layer: any = {
    id: LAYER_ID,
    type: 'custom',
    renderingMode: '2d',
    onAdd: () => { /* 程序在 render 时按 shaderData.pre/define 编译 */ },
    render: (gl: WebGLRenderingContext | WebGL2RenderingContext, options: any) => {
      drawRibbons(map, gl, options);
    },
    onRemove: () => {
      const st = glStateByMap.get(map);
      if (st) {
        try { if (st.program) st.gl.deleteProgram(st.program); } catch { /* */ }
        glStateByMap.delete(map);
      }
    },
  };
  try {
    map.addLayer(layer);
    flyRibbonDbg.layerAdded = true;
    flyRibbonDbg.addLayerError = null;
  } catch (e: any) {
    flyRibbonDbg.layerAdded = false;
    flyRibbonDbg.addLayerError = String(e?.message || e);
  }
}

function drawRibbons(map: MaplibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext, options?: any): void {
  const entries = entriesByMap.get(map);
  const markerEntries = markerEntriesByMap.get(map);
  flyRibbonDbg.renderCalls++;
  // 无拱形但有待画标记点时也继续（如 grow 起始帧切片不足 2 点、拱形尚未注册）
  if ((!entries || entries.size === 0) && (!markerEntries || markerEntries.size === 0)) { flyRibbonDbg.lastNoEntries = true; return; }
  const variantName = options?.shaderData?.variantName ?? '';
  const prelude = options?.shaderData?.vertexShaderPrelude ?? '';
  const define = options?.shaderData?.define ?? '';
  const projData = options?.defaultProjectionData;
  const st = ensureGlState(map, gl, variantName, prelude, define);
  if (!st || !st.program) { flyRibbonDbg.noGlState = true; return; }
  const g = st.gl;
  const canvas = map.getCanvas();
  const dpr = gl.drawingBufferWidth / Math.max(1, canvas.clientWidth);
  const camSig = cameraSig(map);
  flyRibbonDbg.viewport = [gl.drawingBufferWidth, gl.drawingBufferHeight];
  flyRibbonDbg.dpr = dpr;
  flyRibbonDbg.entryCount = entries?.size ?? 0;
  flyRibbonDbg.camSig = camSig;
  let drawn = 0;
  let glErr = 0;
  let lastVert = 0;
  // MapLibre v5 渲染后可能残留自身 VAO 绑定：必须解绑，否则 attribPointer 写入它的 VAO 导致本层绘制状态错乱
  const gl2 = gl as WebGL2RenderingContext;
  if (typeof gl2.bindVertexArray === 'function') gl2.bindVertexArray(null);
  g.useProgram(st.program);
  g.enable(g.BLEND);
  g.blendFuncSeparate(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA, g.ONE, g.ONE_MINUS_SRC_ALPHA);
  // 3D 管的自身遮挡必须靠深度测试：否则远侧/内侧面按提交顺序覆盖近侧，出现"一段一段"的明暗斑块。
  // 不启用背面剔除（三角绕向未统一保证），仅开深度写入。
  try { g.enable(g.DEPTH_TEST); g.depthFunc(g.LEQUAL); g.depthMask(true); g.disable(g.CULL_FACE); } catch { /* 状态不可用时忽略 */ }
  g.uniform2f(st.uViewport as WebGLUniformLocation, canvas.clientWidth, canvas.clientHeight);
  // 投影 uniform（自定义图层路径下已缩放好：mercator z=米，globe=米）
  if (projData && st.uProjMatrix) {
    flyRibbonDbg.mainMatrix = Array.from((projData.mainMatrix || []) as number[]).map((v: number) => Number(v.toFixed(4)));
    g.uniformMatrix4fv(st.uProjMatrix, false, projData.mainMatrix);
    if (st.uTileMerc) g.uniform4fv(st.uTileMerc, projData.tileMercatorCoords);
    if (st.uClipPlane) g.uniform4fv(st.uClipPlane, projData.clippingPlane);
    if (st.uProjTransition) g.uniform1f(st.uProjTransition, projData.projectionTransition);
    if (st.uFallbackMatrix) g.uniformMatrix4fv(st.uFallbackMatrix, false, projData.fallbackMatrix);
  }
  for (const [, entry] of entries || []) {
    const data = entry.data;
    const sig = dataSig(data);
    const needRebuild = sig !== entry.buildKey || camSig !== entry.lastCamSig || !entry.buffer;
    if (needRebuild) {
      const built = buildVertices(map, data);
      if (!built) continue;
      let buf = entry.buffer || st.freeBuffers.pop() || null;
      if (!buf) buf = g.createBuffer();
      g.bindBuffer(g.ARRAY_BUFFER, buf);
      g.bufferData(g.ARRAY_BUFFER, built.arr, g.DYNAMIC_DRAW);
      entry.buffer = buf;
      entry.vertCount = built.count;
      entry.buildKey = sig;
      entry.lastCamSig = camSig;
    }
    if (entry.vertCount <= 0) continue;
    g.bindBuffer(g.ARRAY_BUFFER, entry.buffer);
    const bytes = VERT_STRIDE * 4;
    const strideAttrs: [number, number, number][] = [
      [st.aPos, 3, 0], [st.aNrm, 3, 12], [st.aDist, 1, 24],
    ];
    for (const [loc, size, off] of strideAttrs) {
      if (loc >= 0) { g.enableVertexAttribArray(loc); g.vertexAttribPointer(loc, size, g.FLOAT, false, bytes, off); }
    }
    const rgba = hexToRgba(data.color);
    g.uniform4f(st.uColor as WebGLUniformLocation, rgba[0], rgba[1], rgba[2], rgba[3]);
    g.uniform1f(st.uOpacity as WebGLUniformLocation, data.opacity ?? 1);
    // 几何已含高程与厚度（世界空间），高度不再经 uniform —— 相机无关
    const dash = data.dash ? (data.dash as number[]).filter((v) => v > 0).map((v) => v * Math.max(0.5, data.widthPx)) : [];
    if (dash.length >= 2) {
      const total = dash.reduce((a, b) => a + b, 0);
      const padded = dash.slice(0, 6);
      while (padded.length < 6) padded.push(0);
      g.uniform1f(st.uDashTotal as WebGLUniformLocation, total);
      g.uniform1f(st.uDashCount as WebGLUniformLocation, Math.min(6, dash.length));
      g.uniform1fv(st.uDash as WebGLUniformLocation, padded);
    } else {
      g.uniform1f(st.uDashTotal as WebGLUniformLocation, 0);
      g.uniform1f(st.uDashCount as WebGLUniformLocation, 0);
      g.uniform1fv(st.uDash as WebGLUniformLocation, [0, 0, 0, 0, 0, 0]);
    }
    g.drawArrays(g.TRIANGLES, 0, entry.vertCount);
    drawn++;
    glErr = g.getError();
    lastVert = entry.vertCount;
    for (const [loc] of strideAttrs) {
      if (loc >= 0) g.disableVertexAttribArray(loc);
    }
  }
  g.bindBuffer(g.ARRAY_BUFFER, null);
  // 恢复默认状态，避免影响后续图层（marker 绘制会自行设置）
  try { g.disable(g.DEPTH_TEST); g.depthMask(false); } catch { /* */ }
  flyRibbonDbg.drawn = drawn;
  flyRibbonDbg.glErr = glErr;
  flyRibbonDbg.lastVert = lastVert;
  // 飞行标记点：与 ribbon 同一投影，画在 3D 抬升位置（精确一致）
  if (markerEntriesByMap.get(map)?.size) {
    drawMarkers(map, st);
  }
}

/** 注册/更新一条飞行拱形 ribbon（key 形如 `${elementId}|main`；data=null 移除） */
export function setFlyRibbon(map: MaplibreMap, key: string, data: FlyRibbonData | null): void {
  let entries = entriesByMap.get(map);
  if (!entries) {
    if (!data) return;
    entries = new Map();
    entriesByMap.set(map, entries);
  }
  const prev = entries.get(key);
  if (!data) {
    if (prev) {
      const st = glStateByMap.get(map);
      if (prev.buffer && st) st.freeBuffers.push(prev.buffer);
      entries.delete(key);
      try { map.triggerRepaint(); } catch { /* */ }
    }
    return;
  }
  ensureLayer(map);
  const sig = dataSig(data);
  const changed = !prev || sig !== prev.buildKey;
  entries.set(key, { data, buffer: prev?.buffer || null, vertCount: prev?.vertCount || 0, buildKey: prev?.buildKey || '', lastCamSig: prev?.lastCamSig || '' });
  flyRibbonDbg.setCalls++;
  flyRibbonDbg.lastKey = key;
  if (changed) {
    try { map.triggerRepaint(); } catch { /* */ }
  }
}

/** 清除某元素的全部 ribbon（元素删除/类型切换/关闭飞行时调用） */
export function clearFlyRibbons(map: MaplibreMap, elementId: string): void {
  setFlyRibbon(map, `${elementId}|main`, null);
  setFlyRibbon(map, `${elementId}|ghost`, null);
  setFlyRibbon(map, `${elementId}|track`, null);
  setFlyRibbon(map, `${elementId}|afill`, null);
  setFlyRibbon(map, `${elementId}|astroke`, null);
}

/** 清除某元素的飞行标记点（元素删除/类型切换时调用） */
export function clearFlyMarkers(map: MaplibreMap, elementId: string): void {
  setFlyMarker(map, `${elementId}|icon`, null);
  setFlyMarker(map, `${elementId}|head`, null);   // 带箭头路线的三角头部（飞行时也走标记层）
}

/** 选中拾取：点击点到抬升折线的屏幕距离判定（CSS px；threshold 含线宽） */
export function pickFlyRibbon(map: MaplibreMap, px: number, py: number, elements: { id: string; flyMode?: boolean }[]): string | null {
  const entries = entriesByMap.get(map);
  if (!entries || entries.size === 0) return null;
  let bestId: string | null = null;
  let bestD = Infinity;
  for (const [key, entry] of entries) {
    if (key.endsWith('|ghost')) continue;
    const data = entry.data as FlyRibbonDataLine;
    const liftM = data.heightM ?? flyLiftMeters(map);
    const elId = key.slice(0, key.lastIndexOf('|'));
    const el = elements.find((e) => e.id === elId);
    if (!el || !el.flyMode) continue;
    const threshold = Math.max(12, (data.widthPx || 8) / 2 + 8);
    let dBest = Infinity;
    for (const path of data.paths) {
      const pts = path.coords;
      if (!pts || pts.length < 2) continue;
      const fArr = path.f ?? null;
      let prev: { x: number; y: number } | null = null;
      for (let i = 0; i < pts.length; i++) {
        const f = fArr ? fArr[i] : (data.frac?.a ?? 0) + ((data.frac?.b ?? 1) - (data.frac?.a ?? 0)) * (i / Math.max(1, pts.length - 1));
        const h = flyHeight01(f);
        const lifted = projectLifted(map, pts[i] as [number, number], h * liftM, h);
        if (prev) {
          const dx = lifted.x - prev.x;
          const dy = lifted.y - prev.y;
          const l2 = dx * dx + dy * dy;
          let t = l2 > 0 ? ((px - prev.x) * dx + (py - prev.y) * dy) / l2 : 0;
          t = Math.max(0, Math.min(1, t));
          const cx = prev.x + dx * t;
          const cy = prev.y + dy * t;
          const d = Math.hypot(px - cx, py - cy);
          if (d < dBest) dBest = d;
        }
        prev = lifted;
      }
      // 闭合环补一段首尾距离
      if (path.closed && pts.length > 2 && prev) {
        const h0 = flyHeight01(fArr ? fArr[0] : (data.frac?.a ?? 0));
        const lifted = projectLifted(map, pts[0] as [number, number], h0 * liftM, h0);
        const dx = lifted.x - prev.x;
        const dy = lifted.y - prev.y;
        const l2 = dx * dx + dy * dy;
        let t = l2 > 0 ? ((px - prev.x) * dx + (py - prev.y) * dy) / l2 : 0;
        t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(px - (prev.x + dx * t), py - (prev.y + dy * t));
        if (d < dBest) dBest = d;
      }
    }
    if (dBest - threshold < bestD) {
      bestD = dBest - threshold;
      bestId = elId;
    }
  }
  return bestD <= 0 ? bestId : null;
}

// ========== 飞行标记点（纹理图标，画在 3D 抬升位置，与 ribbon 同一投影） ==========
// 背景：MapLibre symbol 图层的 icon-translate 在俯仰下按「标牌平面」投影，与 map.project
// 不一致（实测 ~25px 偏差），无法精确落在拱上。改为在本自定义图层内按 projectLifted 的
// 屏幕位置直接绘制贴图四边形，做到与 ribbon 严格一致。

export interface FlyMarker {
  imgId: string;
  lnglat: [number, number];
  /** 抬升比例 0..1（flyHeight01） */
  lift01: number;
  /** 弧顶高度（米）——与所在路线 ribbon 的 heightM 一致（缺省时回退相机换算） */
  heightM?: number;
  /** 高度（CSS px，等比缩放） */
  sizePx: number;
  /** 锚点（图像内 0..1，默认 0.5/1.0 = 底部居中，如 pin） */
  anchorX?: number;
  anchorY?: number;
  /** 额外屏幕偏移（CSS px） */
  offsetPx?: [number, number];
  opacity?: number;
  /** 屏幕空间旋转（度，绕锚点）——用于箭头头部等需要指向的贴图 */
  rotate?: number;
}

const markerEntriesByMap = new WeakMap<MaplibreMap, Map<string, FlyMarker[]>>();

const MARKER_VERT_SRC = `
uniform vec2 uViewport;
attribute vec2 aPos;
attribute vec2 aUV;
varying vec2 vUV;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
  vUV = aUV;
}
`;

const MARKER_FRAG_SRC = `
precision highp float;
uniform sampler2D uTex;
uniform float uOpacity;
varying vec2 vUV;
void main() {
  vec4 c = texture2D(uTex, vUV);
  gl_FragColor = vec4(c.rgb, c.a * uOpacity);
}
`;

function ensureMarkerProgram(st: RibbonGlState): WebGLProgram | null {
  if (st.markerProgram) return st.markerProgram;
  const gl = st.gl;
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type);
    if (!sh) return null;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.warn('[fly-ribbon] 标记 shader 编译失败:', gl.getShaderInfoLog(sh));
      gl.deleteShader(sh);
      return null;
    }
    return sh;
  };
  const vs = compile((gl as WebGLRenderingContext).VERTEX_SHADER, MARKER_VERT_SRC);
  const fs = compile((gl as WebGLRenderingContext).FRAGMENT_SHADER, MARKER_FRAG_SRC);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('[fly-ribbon] 标记 program 链接失败:', gl.getProgramInfoLog(program));
    return null;
  }
  st.markerProgram = program;
  st.markerAPos = gl.getAttribLocation(program, 'aPos');
  st.markerAUV = gl.getAttribLocation(program, 'aUV');
  st.markerUTex = gl.getUniformLocation(program, 'uTex');
  st.markerUOpacity = gl.getUniformLocation(program, 'uOpacity');
  return program;
}

function ensureMarkerTexture(st: RibbonGlState, imgId: string, imgData: ImageData): WebGLTexture | null {
  let tex: WebGLTexture | null = st.markerTextures.get(imgId) ?? null;
  if (tex) return tex;
  const gl = st.gl;
  tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, imgData.width, imgData.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, imgData.data);
  } catch (e) {
    try { gl.deleteTexture(tex); } catch { /* */ }
    st.markerTextures.delete(imgId);
    return null;
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  st.markerTextures.set(imgId, tex);
  return tex;
}

function drawMarkers(map: MaplibreMap, st: RibbonGlState): void {
  const entries = markerEntriesByMap.get(map);
  if (!entries || entries.size === 0) return;
  const program = ensureMarkerProgram(st);
  if (!program) return;
  const gl = st.gl;
  const canvas = map.getCanvas();
  const w = Math.max(1, canvas.clientWidth);
  const h = Math.max(1, canvas.clientHeight);
  // 每个标记点用自己路线的弧顶高度（与管/ribbon 严格对齐）；缺省回退相机换算
  const fallbackLiftM = flyLiftMeters(map);
  // 复用 ribbon 主 buffer 槽绘制四边形顶点
  let vbuf = st.freeBuffers.pop() || null;
  if (!vbuf) vbuf = gl.createBuffer();
  if (!vbuf) return;
  gl.useProgram(program);
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  try { gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.CULL_FACE); } catch { /* */ }
  gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
  if (st.markerAPos >= 0) { gl.enableVertexAttribArray(st.markerAPos); gl.vertexAttribPointer(st.markerAPos, 2, gl.FLOAT, false, 16, 0); }
  if (st.markerAUV >= 0) { gl.enableVertexAttribArray(st.markerAUV); gl.vertexAttribPointer(st.markerAUV, 2, gl.FLOAT, false, 16, 8); }
  const verts: number[] = [];
  let boundTex: WebGLTexture | null = null;
  let drawnMarkers = 0;
  for (const [, markers] of entries) {
    for (const mk of markers) {
      const img = (map as any).getImage?.(mk.imgId);
      if (!img || !img.data) continue;
      const tex = ensureMarkerTexture(st, mk.imgId, img.data);
      if (!tex) continue;
      const lift01 = Math.max(0, Math.min(1, mk.lift01));
      const pos = projectLifted(map, mk.lnglat, lift01 * (mk.heightM ?? fallbackLiftM), lift01);
      if (pos.x < -200 || pos.y < -200 || pos.x > w + 200 || pos.y > h + 200) continue;
      const ox = mk.offsetPx ? mk.offsetPx[0] : 0;
      const oy = mk.offsetPx ? mk.offsetPx[1] : 0;
      const imgW = img.data.width || mk.sizePx;
      const imgH = img.data.height || mk.sizePx;
      const k = mk.sizePx / Math.max(1, imgH);
      const qw = imgW * k;
      const qh = mk.sizePx;
      const ax = mk.anchorX ?? 0.5;
      const ay = mk.anchorY ?? 1;
      const left = pos.x + ox - ax * qw;
      const top = pos.y + oy - ay * qh;
      const ndcX = (x: number) => (x / w) * 2 - 1;
      const ndcY = (y: number) => 1 - (y / h) * 2;
      // 四个角（CSS px）：左上 / 右上 / 右下 / 左下（配 uv 0,0 / 1,0 / 1,1 / 0,1）
      const corners: [number, number][] = [
        [left, top], [left + qw, top], [left + qw, top + qh], [left, top + qh],
      ];
      const rot = (typeof mk.rotate === 'number' && mk.rotate !== 0) ? (mk.rotate * Math.PI) / 180 : 0;
      if (rot) {
        // 绕锚点（pos）旋转四个角
        const cx = pos.x + ox;
        const cy = pos.y + oy;
        const cs = Math.cos(rot);
        const sn = Math.sin(rot);
        for (const c of corners) {
          const dx = c[0] - cx;
          const dy = c[1] - cy;
          c[0] = cx + dx * cs - dy * sn;
          c[1] = cy + dx * sn + dy * cs;
        }
      }
      const p = corners.map((c) => [ndcX(c[0]), ndcY(c[1])] as [number, number]);
      // 纹理 v=0 = 图像顶行；屏幕上方顶点必须配 v=0
      verts.push(p[0][0], p[0][1], 0, 0, p[1][0], p[1][1], 1, 0, p[2][0], p[2][1], 1, 1);
      verts.push(p[0][0], p[0][1], 0, 0, p[2][0], p[2][1], 1, 1, p[3][0], p[3][1], 0, 1);
      if (tex !== boundTex) {
        if (boundTex) {
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
          gl.drawArrays(gl.TRIANGLES, 0, verts.length / 4);
          verts.length = 0;
        }
        boundTex = tex;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(st.markerUTex, 0);
      }
      gl.uniform1f(st.markerUOpacity, mk.opacity ?? 1);
      drawnMarkers++;
    }
  }
  if (verts.length > 0) {
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, verts.length / 4);
  }
  if (st.markerAPos >= 0) gl.disableVertexAttribArray(st.markerAPos);
  if (st.markerAUV >= 0) gl.disableVertexAttribArray(st.markerAUV);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  st.freeBuffers.push(vbuf);
  if (drawnMarkers > 0) flyRibbonDbg.markerDrawn = drawnMarkers;
}

/** 注册/更新飞行标记点（key 形如 `${elementId}|icon`；markers=null 移除） */
export function setFlyMarker(map: MaplibreMap, key: string, markers: FlyMarker[] | null): void {
  let entries = markerEntriesByMap.get(map);
  if (!entries) {
    if (!markers) return;
    entries = new Map();
    markerEntriesByMap.set(map, entries);
  }
  if (!markers) {
    if (entries.delete(key)) { try { map.triggerRepaint(); } catch { /* */ } }
    return;
  }
  const sig = markers.map((m) => `${m.imgId}|${m.lnglat[0].toFixed(6)},${m.lnglat[1].toFixed(6)}|${m.lift01.toFixed(3)}|${m.heightM ?? ''}|${m.sizePx}|${m.anchorX ?? 0.5}|${m.anchorY ?? 1}|${m.offsetPx ? m.offsetPx.join(',') : ''}|${m.opacity ?? 1}|${m.rotate ?? 0}`).join(';');
  const prev = entries.get(key);
  if (!prev || (prev as any).__sig !== sig) {
    (markers as any).__sig = sig;
    entries.set(key, markers);
    try { map.triggerRepaint(); } catch { /* */ }
  }
}