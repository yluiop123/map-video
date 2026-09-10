/**
 * procedural-anim.ts — 内置动图：程序化动画（canvas 逐帧绘制，无 GIF 文件）
 *
 * 与 GIF 解码走同一条路：由「经过的毫秒数」决定当前帧，**不依赖 RAF / 真实时间**，
 * 因此 Remotion 乱序或重复渲染同一帧都得到同一张图。
 *
 * 着色：白色基图（'#FFFFFF'）绘制，渲染端按元素 color 传入即可染色；
 * 白色 = 原色，与 ensureImageIcon 的 multiply 染色管线语义一致。
 */
import type { ProceduralAnim } from './builtin-assets';

const SIZE = 64;
const C = SIZE / 2;

let cv: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;

function ensureCtx(): CanvasRenderingContext2D | null {
  if (ctx) return ctx;
  if (typeof document === 'undefined') return null;
  cv = document.createElement('canvas');
  cv.width = SIZE;
  cv.height = SIZE;
  ctx = cv.getContext('2d', { willReadFrequently: true })!;
  return ctx;
}

/** hex → rgba（带透明度）；解析失败回退白色 */
function withAlpha(color: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return `rgba(255,255,255,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** 绘制一帧；elapsedMs 为动画已播放时间（毫秒），color 为基图颜色（默认白色） */
export function renderProceduralAnim(anim: ProceduralAnim, elapsedMs: number, color = '#FFFFFF'): ImageData | null {
  const g = ensureCtx();
  if (!g) return null;

  const period = 1600;                       // 默认一个循环 1.6s
  const p = ((elapsedMs % period) + period) % period / period;  // 相位 0..1
  const t = p * Math.PI * 2;

  g.clearRect(0, 0, SIZE, SIZE);
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = 3;
  g.lineCap = 'round';

  switch (anim.type) {
    case 'radar': {
      g.globalAlpha = 0.85;
      g.beginPath();
      g.arc(C, C, 24, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 0.25;
      g.beginPath();
      g.arc(C, C, 12, 0, Math.PI * 2);
      g.stroke();
      // 扫描扇形
      g.globalAlpha = 1;
      const a0 = t;
      const grad = g.createConicGradient ? g.createConicGradient(a0, C, C) : null;
      if (grad) {
        grad.addColorStop(0, withAlpha(color, 0.95));
        grad.addColorStop(0.18, withAlpha(color, 0.25));
        grad.addColorStop(0.35, withAlpha(color, 0));
        grad.addColorStop(1, withAlpha(color, 0));
        g.fillStyle = grad;
        g.beginPath();
        g.moveTo(C, C);
        g.arc(C, C, 24, 0, Math.PI * 2);
        g.fill();
      } else {
        g.strokeStyle = color;
        g.beginPath();
        g.moveTo(C, C);
        g.lineTo(C + Math.cos(a0) * 22, C + Math.sin(a0) * 22);
        g.stroke();
      }
      break;
    }
    case 'pulse':
    case 'sonar': {
      const rings = anim.type === 'sonar' ? 4 : (anim.rings ?? 3);
      for (let i = 0; i < rings; i++) {
        const ph = (p + i / rings) % 1;
        g.globalAlpha = Math.max(0, 1 - ph) * 0.9;
        g.beginPath();
        g.arc(C, C, 4 + ph * 22, 0, Math.PI * 2);
        g.stroke();
      }
      g.globalAlpha = 1;
      g.beginPath();
      g.arc(C, C, 3, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'blink': {
      g.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(t));
      g.beginPath();
      g.arc(C, C, 16, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'sweep': {
      const x = p * SIZE;
      g.globalAlpha = 0.9;
      g.beginPath();
      g.moveTo(x, 8);
      g.lineTo(x, SIZE - 8);
      g.stroke();
      g.globalAlpha = 0.3;
      g.beginPath();
      g.arc(C, C, 22, 0, Math.PI * 2);
      g.stroke();
      break;
    }
    case 'spin': {
      g.globalAlpha = 0.9;
      for (let i = 0; i < 8; i++) {
        const a = t + (i / 8) * Math.PI * 2;
        g.globalAlpha = 0.25 + 0.65 * (i / 8);
        g.beginPath();
        g.moveTo(C + Math.cos(a) * 12, C + Math.sin(a) * 12);
        g.lineTo(C + Math.cos(a) * 24, C + Math.sin(a) * 24);
        g.stroke();
      }
      break;
    }
    case 'crosshair': {
      const r = 16 + Math.sin(t) * 5;
      g.globalAlpha = 0.95;
      g.beginPath();
      g.arc(C, C, r, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 0.8;
      g.beginPath();
      g.moveTo(C - 26, C); g.lineTo(C - r - 4, C);
      g.moveTo(C + r + 4, C); g.lineTo(C + 26, C);
      g.moveTo(C, C - 26); g.lineTo(C, C - r - 4);
      g.moveTo(C, C + r + 4); g.lineTo(C, C + 26);
      g.stroke();
      break;
    }
    case 'wave': {
      g.globalAlpha = 0.95;
      for (let i = 0; i < 4; i++) {
        const x = C - 21 + i * 14;
        const h = 8 + 12 * Math.abs(Math.sin(t - i * 0.6));
        g.beginPath();
        g.roundRect ? g.roundRect(x - 3, C - h / 2, 6, h, 3) : g.rect(x - 3, C - h / 2, 6, h);
        g.fill();
      }
      break;
    }
    default:
      break;
  }

  g.globalAlpha = 1;
  return g.getImageData(0, 0, SIZE, SIZE);
}
