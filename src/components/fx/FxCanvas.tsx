/**
 * 天气/云层特效画布（双端同源：编辑器预览与 Remotion 导出共用）。
 * 绘制是 frame 的纯函数（lib/screenfx 确定性算法），保证导出逐帧一致。
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { ScreenFxItem } from '../../types';
import { drawWeather, drawCloudReveal, hashSeed } from '../../lib/screenfx';

interface FxCanvasProps {
  fx: ScreenFxItem;
  /** 当前帧（绝对帧；内部换算局部帧） */
  frame: number;
  fps: number;
  /** 导出画幅（缺省铺满父容器） */
  width?: number;
  height?: number;
  style?: React.CSSProperties;
}

export function FxCanvas({ fx, frame, fps, width, height, style }: FxCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: width ?? 0, h: height ?? 0 });

  useLayoutEffect(() => {
    if (width && height) { setSize({ w: width, h: height }); return; }
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [width, height]);

  useLayoutEffect(() => {
    const cv = ref.current;
    if (!cv || size.w <= 0 || size.h <= 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(size.w * dpr) || cv.height !== Math.round(size.h * dpr)) {
      cv.width = Math.round(size.w * dpr);
      cv.height = Math.round(size.h * dpr);
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const local = Math.max(0, frame - fx.startFrame);
    if (frame < fx.startFrame || frame >= fx.endFrame) return;
    if (fx.kind === 'weather' && fx.weather) {
      drawWeather({
        ctx, w: size.w, h: size.h,
        type: fx.weather.type, intensity: fx.weather.intensity, wind: fx.weather.wind,
        localFrame: local, dur: Math.max(1, fx.endFrame - fx.startFrame), fps, seed: hashSeed(fx.id),
      });
    } else if (fx.kind === 'screen' && fx.effect?.type === 'cloudReveal') {
      const p = Math.min(1, local / Math.max(1, fx.endFrame - fx.startFrame));
      const ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      drawCloudReveal(ctx, size.w, size.h, ease, hashSeed(fx.id), local, fps, fx.effect.intensity ?? 0.6);
    }
  }, [fx, frame, fps, size.w, size.h]);

  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', ...style }}>
      <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}
