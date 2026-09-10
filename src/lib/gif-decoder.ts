/**
 * gif-decoder.ts — GIF 解码（帧序列，确定性）
 *
 * 输出的是「每帧完整画面」的 ImageData 数组，供渲染端按 frame 取用：
 *   frameIndex = floor(t / frameDuration) % frames.length
 * 这样预览与导出的同一帧永远得到同一张图（Remotion 确定性要求）。
 * 不用 requestAnimationFrame、不依赖真实时间。
 */
import { parseGIF, decompressFrames } from 'gifuct-js';

export interface GifFrames {
  width: number;
  height: number;
  /** 每帧完整画面（RGBA，已按 disposal 合成） */
  frames: ImageData[];
  /** 每帧显示时长（毫秒） */
  delays: number[];
  /** 一轮总时长（毫秒） */
  totalMs: number;
}

async function decode(bytes: ArrayBuffer): Promise<GifFrames | null> {
  try {
    const gif = parseGIF(bytes);
    const raw = decompressFrames(gif, true);
    if (!raw.length) return null;

    const W = gif.lsd?.width || raw[0].dims.width;
    const H = gif.lsd?.height || raw[0].dims.height;
    const canvas = new Uint8ClampedArray(W * H * 4);
    const frames: ImageData[] = [];
    const delays: number[] = [];

    for (const f of raw) {
      // disposal=3：本帧绘制前先记录当前画面，绘制后恢复
      const restore = f.disposalType === 3 ? new Uint8ClampedArray(canvas) : null;

      const { top, left, width, height } = f.dims;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const si = (y * width + x) * 4;
          const a = f.patch[si + 3];
          if (a === 0) continue;               // 透明像素不覆盖
          const di = ((top + y) * W + (left + x)) * 4;
          canvas[di] = f.patch[si];
          canvas[di + 1] = f.patch[si + 1];
          canvas[di + 2] = f.patch[si + 2];
          canvas[di + 3] = a;
        }
      }

      frames.push(new ImageData(new Uint8ClampedArray(canvas), W, H));
      // GIF delay 单位是 1/100 秒；下限 20ms 防抖
      delays.push(Math.max(20, (f.delay || 10) * 10));

      if (f.disposalType === 2) {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const di = ((top + y) * W + (left + x)) * 4;
            canvas[di] = canvas[di + 1] = canvas[di + 2] = canvas[di + 3] = 0;
          }
        }
      } else if (restore) {
        canvas.set(restore);
      }
    }

    const totalMs = delays.reduce((a, b) => a + b, 0);
    return { width: W, height: H, frames, delays, totalMs };
  } catch {
    return null;
  }
}

const cache = new Map<string, Promise<GifFrames | null>>();

/** 按 key 解码（带缓存）；load 负责取回字节 */
export function decodeGifCached(
  key: string,
  load: () => Promise<ArrayBuffer | null>,
): Promise<GifFrames | null> {
  let p = cache.get(key);
  if (!p) {
    p = load().then((buf) => (buf ? decode(buf) : null));
    cache.set(key, p);
  }
  return p;
}

/** 由「当前帧 + 帧率」算 GIF 帧索引（毫秒时间轴，确定性） */
export function gifFrameAt(g: GifFrames, elapsedMs: number): number {
  if (g.frames.length <= 1 || g.totalMs <= 0) return 0;
  let t = elapsedMs % g.totalMs;
  for (let i = 0; i < g.delays.length; i++) {
    t -= g.delays[i];
    if (t < 0) return i;
  }
  return g.frames.length - 1;
}

export function clearGifCache(): void {
  cache.clear();
}
