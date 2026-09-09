/**
 * 天气/画面特效的纯函数计算（帧确定性：同一 frame 输入必得同一输出）。
 * 编辑器预览与 Remotion 导出共用，保证双端逐帧一致；禁止内部使用 Math.random()。
 */
import type { ScreenFxItem, WeatherType } from '../types';

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/** 字符串→32位种子（FNV-1a） */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** 种子→[0,1) 确定性伪随机（mulberry32 单步） */
export function rand(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** 平滑升/降包络：窗口头尾各 15% 渐变（shake 等整窗特效通用） */
function envelope(localFrame: number, dur: number): number {
  if (dur <= 0) return 1;
  const p = clamp01(localFrame / Math.max(1, dur));
  const fade = Math.min(0.15, 1 / dur * 20);
  return Math.min(1, p / Math.max(1e-6, fade)) * Math.min(1, (1 - p) / Math.max(1e-6, fade));
}

/** 天气窗口包络：入场 1s 渐显 + 结尾 0.8s 渐隐（时长不足按 15% 比例）。
 * 注意：不能传固定窗口（如 30 帧）——否则 p=1 后 alpha 归零，天气 1 秒即消失。 */
export function weatherEnvelope(localFrame: number, dur: number): number {
  if (dur <= 2) return 1;
  const fadeIn = Math.max(2, Math.min(30, dur * 0.15));
  const fadeOut = Math.max(2, Math.min(24, dur * 0.15));
  return clamp01(localFrame / fadeIn) * clamp01((dur - localFrame) / fadeOut);
}

/** 特效项在当前帧是否激活（含 enabled 开关） */
export function isFxActive(fx: ScreenFxItem, frame: number): boolean {
  if (fx.enabled === false) return false;
  return frame >= fx.startFrame && frame < fx.endFrame;
}

// ========== 天气粒子（canvas 绘制） ==========

export interface WeatherDrawCtx {
  ctx: CanvasRenderingContext2D;
  w: number; h: number;
  type: WeatherType;
  intensity: number;   // 0–1
  wind: number;        // -1..1
  localFrame: number;  // 相对 startFrame
  /** 特效总时长（帧）：用于头尾渐显/渐隐包络 */
  dur: number;
  fps: number;
  seed: number;
}

/** 把天气层画到 canvas 上（双端共用）。调用方控制 clear。 */
export function drawWeather(c: WeatherDrawCtx): void {
  const { ctx, w, h, type, intensity, wind, localFrame, dur, fps, seed } = c;
  if (intensity <= 0) return;
  const t = localFrame / fps; // 秒
  const env = weatherEnvelope(localFrame, dur);
  const count = Math.round(40 + intensity * 260);

  if (type === 'rain') {
    ctx.strokeStyle = `rgba(174,194,224,${0.35 * env})`;
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    const speed = 900 + intensity * 500; // px/s
    const len = 14 + intensity * 14;
    const drift = wind * 260;
    for (let i = 0; i < count; i++) {
      const x0 = rand(seed + i * 3.1) * (w + 200) - 100;
      const y0 = rand(seed + i * 7.7) * h;
      const sp = speed * (0.75 + rand(seed + i * 11.3) * 0.5);
      const y = (y0 + t * sp) % (h + 40) - 20;
      const x = x0 + (y / Math.max(1, h)) * drift * 0.6 + drift * t * 0.2;
      const dx = (drift + 40) * (len / sp);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + dx, y + len);
      ctx.stroke();
    }
  } else if (type === 'snow') {
    ctx.fillStyle = `rgba(255,255,255,${0.8 * env})`;
    for (let i = 0; i < count; i++) {
      const x0 = rand(seed + i * 3.1) * w;
      const y0 = rand(seed + i * 7.7) * h;
      const sp = 40 + rand(seed + i * 11.3) * 90 * (0.4 + intensity);
      const size = 1.2 + rand(seed + i * 5.9) * 2.6;
      const sway = Math.sin(t * (0.6 + rand(seed + i * 2.7)) + seed + i) * (16 + wind * 60);
      const y = (y0 + t * sp) % (h + 20) - 10;
      const x = (x0 + sway + wind * t * 40) % (w + 40) - 20;
      ctx.globalAlpha = (0.35 + rand(seed + i * 9.1) * 0.65) * env;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else if (type === 'fog') {
    // 3 层漂移雾团（径向渐变），层速/相位由种子确定
    for (let layer = 0; layer < 3; layer++) {
      const alpha = (0.10 + intensity * 0.22) * env;
      const speed = (8 + layer * 6) * (1 + wind * 1.5);
      const blobW = w * (0.5 + layer * 0.15);
      const yy = h * (0.2 + layer * 0.28);
      const off = ((t * speed) % (w + blobW)) - blobW * 0.5;
      for (let k = -1; k <= 1; k++) {
        const cx = w * 0.5 + k * blobW * 0.8 + off;
        const g = ctx.createRadialGradient(cx, yy, 0, cx, yy, blobW * 0.6);
        g.addColorStop(0, `rgba(200,205,215,${alpha})`);
        g.addColorStop(1, 'rgba(200,205,215,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
    }
  } else if (type === 'lightning') {
    // 每 2.2s±种子偏移一次闪电： bolt 折线 + 双峰闪光
    const period = 2.2 + rand(seed) * 1.2;
    const strikeT = (t + rand(seed + 1) * period) % period;
    const strikeDur = 0.32;
    if (strikeT < strikeDur) {
      const p = strikeT / strikeDur;
      const flash = Math.max(0, Math.sin(p * Math.PI) * (1 - p * 0.5)) * intensity * env;
      // 全屏泛光
      ctx.fillStyle = `rgba(224,236,255,${0.16 * flash})`;
      ctx.fillRect(0, 0, w, h);
      // 主bolt：自上而下的折线（种子确定形状）
      const segs = 9;
      let x = w * (0.2 + rand(seed + 2) * 0.6);
      let y = -10;
      ctx.strokeStyle = `rgba(240,248,255,${0.9 * flash})`;
      ctx.lineWidth = 2.4;
      ctx.shadowColor = 'rgba(160,200,255,0.9)';
      ctx.shadowBlur = 18 * flash;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let s = 1; s <= segs; s++) {
        x += (rand(seed + 10 + s) - 0.5) * w * 0.09;
        y += (h * 0.75) / segs;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
      // 2 条分支
      for (let b = 0; b < 2; b++) {
        const bi = 3 + b * 3;
        let bx = w * (0.2 + rand(seed + 2) * 0.6);
        for (let s = 1; s < bi; s++) bx += (rand(seed + 10 + s) - 0.5) * w * 0.09;
        let by = (h * 0.75) * (bi / segs);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(bx, by);
        for (let s = 0; s < 4; s++) {
          bx += (rand(seed + 30 + b * 7 + s) - 0.5) * w * 0.06;
          by += h * 0.05;
          ctx.lineTo(bx, by);
        }
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }
  }
}

// ========== 画面特效状态（div/canvas 叠加 + 舞台 transform） ==========

export interface ScreenFxState {
  /** 全屏叠加层颜色+不透明度（flash/fadeBlack/fadeWhite/vignette；inner 为暗角中心亮区半径%） */
  overlay?: { color: string; opacity: number; inner?: number };
  /** 震动位移（px） */
  shake?: { x: number; y: number };
  /** 云层散开：进度 0(全遮)→1(全露)，由 FxCanvas 绘制云层 */
  cloud?: { p: number; seed: number };
}

/** 单个 screen 特效在当前帧的状态（无叠加返回 null） */
export function screenFxStateAt(fx: ScreenFxItem, frame: number, fps: number): ScreenFxState | null {
  if (!isFxActive(fx, frame) || !fx.effect) return null;
  const local = frame - fx.startFrame;
  const dur = Math.max(1, fx.endFrame - fx.startFrame);
  const p = clamp01(local / dur);
  const intensity = fx.effect.intensity;
  const color = fx.effect.color || '#000000';
  switch (fx.effect.type) {
    case 'flash': {
      // 窗口内两次衰减脉冲（第二次更弱）
      const pulse = (tt: number) => Math.max(0, Math.sin(tt * Math.PI)) * Math.pow(1 - tt, 1.6);
      const op = (pulse(p * 2.4) * 0.8 + pulse(Math.max(0, p * 2.4 - 1.6)) * 0.4) * intensity;
      return op > 0.005 ? { overlay: { color, opacity: clamp01(op) } } : null;
    }
    case 'vignette': {
      // 暗角：强度同时控制边缘不透明度与中心亮区半径——强度越大，中心亮区越小、边缘越实
      const op = Math.min(0.96, intensity * Math.min(1, local / (fps * 0.5)));
      const inner = Math.max(6, Math.round(55 - 48 * intensity));
      return op > 0.005 ? { overlay: { color: 'vignette', opacity: op, inner } } : null;
    }
    case 'fadeBlack':
    case 'fadeWhite': {
      const op = 1 - easeInOut(p); // 由全覆盖渐显
      return op > 0.005 ? { overlay: { color: fx.effect.type === 'fadeBlack' ? '#000000' : color, opacity: op } } : null;
    }
    case 'shake': {
      if (intensity <= 0) return null;
      const env = envelope(local, dur);
      const t = local / fps;
      const amp = intensity * 14 * env;
      const x = Math.sin(t * 34.7) * amp * 0.7 + Math.sin(t * 23.3 + 1.7) * amp * 0.3;
      const y = Math.cos(t * 29.1) * amp * 0.6 + Math.sin(t * 41.9 + 0.6) * amp * 0.4;
      return { shake: { x, y } };
    }
    case 'cloudReveal': {
      return { cloud: { p: easeInOut(p), seed: hashSeed(fx.id) } };
    }
    default:
      return null;
  }
}

/** 汇总当前帧全部 screen 特效：叠加取最大不透明度（后激活优先），震动求和 */
export function screenFxCombinedAt(
  fxList: ScreenFxItem[] | undefined, frame: number, fps: number,
): ScreenFxState {
  let overlay: { color: string; opacity: number } | undefined;
  let sx = 0, sy = 0;
  let cloud: { p: number; seed: number } | undefined;
  for (const fx of fxList || []) {
    if (fx.kind !== 'screen') continue;
    const st = screenFxStateAt(fx, frame, fps);
    if (!st) continue;
    if (st.overlay) {
      if (!overlay || st.overlay.opacity > overlay.opacity) overlay = st.overlay;
    }
    if (st.shake) { sx += st.shake.x; sy += st.shake.y; }
    if (st.cloud) cloud = st.cloud;
  }
  const out: ScreenFxState = {};
  if (overlay) out.overlay = overlay;
  if (sx || sy) out.shake = { x: sx, y: sy };
  if (cloud) out.cloud = cloud;
  return out;
}

/** 云层散开：起点=分散的半透明云层铺满天际（云间留缝、地图隐约可见）→ 云团错峰收缩漂移散开
 *  intensity 0–1 控制起始浓度（云团大小+不透明度整体缩放，0.6=标准） */
export function drawCloudReveal(
  ctx: CanvasRenderingContext2D, w: number, h: number, p: number, seed: number, localFrame: number, fps: number,
  intensity: number = 0.6,
): void {
  if (p >= 0.999) return;
  const t = localFrame / fps;
  const f = 0.55 + 0.75 * clamp01(intensity); // 浓度系数：0.55(最淡)~1.3(最浓)，0.6→1.0 标准
  const cellW = w / 6, cellH = h / 4;
  const base = Math.min(cellW, cellH);
  const drawPuff = (cx: number, cy: number, radius: number, alpha: number) => {
    if (alpha <= 0.012 || radius <= 1) return;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    g.addColorStop(0, `rgba(232,236,244,${alpha})`);
    g.addColorStop(0.55, `rgba(212,219,230,${alpha * 0.72})`);
    g.addColorStop(1, 'rgba(212,219,230,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  };
  // 背景层：少量大而淡的高层云（层次感、不填缝、更快散去）
  for (let i = 0; i < 8; i++) {
    const r0 = rand(seed + i * 11.7);
    const r1 = rand(seed + i * 23.3);
    const delay = rand(seed + i * 5.1) * 0.3;
    const pp = clamp01((p * 1.3 - delay) / (1 - delay));
    if (pp >= 1) continue;
    const ang = rand(seed + i * 7.9) * Math.PI * 2;
    const drift = pp * cellW * 1.6;
    drawPuff(
      w * (0.15 + 0.7 * r0) + Math.cos(ang) * drift + Math.sin(t * 0.3 + i) * 10,
      h * (0.15 + 0.7 * r1) + Math.sin(ang) * drift * 0.6 + t * 5,
      base * (0.7 + r0 * 0.3),
      0.2 * f * (1 - pp) * (1 - pp),
    );
  }
  // 主层：错行云团（起始明显分离、半透明、云间留缝可见地图；随后收缩+外漂+淡出）
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 6; gx++) {
      const i = gy * 6 + gx;
      const r0 = rand(seed + i * 3.7);
      const r1 = rand(seed + i * 9.2);
      const delay = rand(seed + i * 5.1) * 0.32;
      const pp = clamp01((p * 1.32 - delay) / (1 - delay));
      if (pp >= 1) continue;
      const cx0 = cellW * (gx + 0.5 + (gy % 2) * 0.5) + (r0 - 0.5) * cellW * 0.3;
      const cy0 = cellH * (gy + 0.5) + (r1 - 0.5) * cellH * 0.3;
      const ang = rand(seed + i * 7.9) * Math.PI * 2;
      const drift = pp * cellW * 1.4;
      const cx = cx0 + Math.cos(ang) * drift + Math.sin(t * 0.3 + i) * 8;
      const cy = cy0 + Math.sin(ang) * drift * 0.6 + t * 6;
      const radius = base * (0.62 + r1 * 0.2) * Math.min(1.25, f) * (1 - 0.75 * pp);
      const alpha = 0.75 * f * (1 - pp) * (1 - pp);
      drawPuff(cx, cy, radius, alpha);
    }
  }
}

/** 找出当前帧激活的天气特效（最多取第一个） */
export function activeWeatherAt(fxList: ScreenFxItem[] | undefined, frame: number): ScreenFxItem | null {
  for (const fx of fxList || []) {
    if (fx.kind === 'weather' && fx.weather && isFxActive(fx, frame)) return fx;
  }
  return null;
}
