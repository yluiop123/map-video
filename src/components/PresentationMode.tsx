/**
 * PresentationMode — 演示模式（PPT 式全屏播放）
 *
 * 只在播控与 HUD 上工作：地图仍由 App 里那一份 EditableMap 渲染（不重建实例），
 * 本组件挂载即从片头开播，播到内容结束停在最后一帧。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, X } from 'lucide-react';
import type { MapVideoProject } from '../types';
import { useEditorStore } from '../stores/editorStore';
import { projectContentEndFrame } from '../lib/project-duration';
import { formatClock } from '../lib/time';

/** 演示的结束帧：内容实际结束（不是时间线至少铺满 60s 的那个长度） */
function presentEndFrame(project: MapVideoProject): number {
  const fps = project.globalConfig.defaultFPS || 30;
  return Math.max(fps, projectContentEndFrame(project) || project.endFrame);
}

/** HUD 无操作后淡出 */
const HUD_IDLE_MS = 3000;

export function PresentationMode({ project }: { project: MapVideoProject }) {
  const fps = project.globalConfig.defaultFPS || 30;
  const end = presentEndFrame(project);
  const currentFrame = useEditorStore((s) => s.currentFrame);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wake = useCallback(() => {
    setIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), HUD_IDLE_MS);
  }, []);

  // 挂载即从片头开播；卸载（退出演示）时停掉播放
  useEffect(() => {
    const ed = useEditorStore.getState();
    ed.setCurrentFrame(0);
    ed.setIsPlaying(true);
    wake();
    return () => useEditorStore.getState().setIsPlaying(false);
  }, [wake]);

  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      // rAF 的 now 可能早于 last（垂直同步），负 dt 会把播放头推成负帧
      const dt = Math.max(0, Math.min(0.25, (now - last) / 1000));
      last = now;
      const st = useEditorStore.getState();
      const next = st.currentFrame + dt * fps * st.playRate;
      if (next >= end) {
        st.setCurrentFrame(end);
        st.setIsPlaying(false);
        return;
      }
      st.setCurrentFrame(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, fps, end]);

  useEffect(() => {
    const step = (frames: number) => {
      const st = useEditorStore.getState();
      st.setIsPlaying(false);
      st.setCurrentFrame(Math.max(0, Math.min(end, st.currentFrame + frames)));
    };
    const onKey = (e: KeyboardEvent) => {
      const st = useEditorStore.getState();
      if (e.key === 'F5' || e.key === 'Escape') {
        e.preventDefault();
        st.setPresenting(false);
      } else if (e.code === 'Space') {
        e.preventDefault();
        if (!st.isPlaying && st.currentFrame >= end) st.setCurrentFrame(0);
        st.setIsPlaying(!st.isPlaying);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        step(fps);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        step(-fps);
      } else if (e.key === 'Home') {
        e.preventDefault();
        step(-end);
      } else if (e.key === 'End') {
        e.preventDefault();
        st.setIsPlaying(false);
        st.setCurrentFrame(end);
      }
      wake();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fps, end, wake]);

  const sec = currentFrame / fps;
  const totalSec = end / fps;

  // 进度条可点/可拖：按横向比例定位播放头（拖动期间不改播放/暂停状态）
  const barRef = useRef<HTMLDivElement>(null);
  const seekTo = (clientX: number) => {
    const el = barRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const k = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    useEditorStore.getState().setCurrentFrame(k * end);
  };
  const onBarDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    seekTo(e.clientX);
    const move = (ev: PointerEvent) => seekTo(ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className="absolute inset-0 z-50 pointer-events-none"
      onMouseMove={wake}
      onClick={wake}
      style={{ cursor: idle ? 'none' : undefined }}
    >
      <div
        className={`absolute left-1/2 -translate-x-1/2 bottom-6 flex items-center gap-2 h-11 pl-2 pr-3 rounded-full bg-black/70 backdrop-blur border border-white/10 shadow-2xl transition-opacity duration-300 pointer-events-auto ${
          idle ? 'opacity-0' : 'opacity-100'
        }`}
      >
        <button
          onClick={() => {
            const st = useEditorStore.getState();
            if (!st.isPlaying && st.currentFrame >= end) st.setCurrentFrame(0);
            st.setIsPlaying(!st.isPlaying);
          }}
          className="w-8 h-8 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 text-foreground transition-colors"
          title={isPlaying ? '暂停 (空格)' : '播放 (空格)'}
        >
          {isPlaying ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <span className="text-xs text-foreground/80 tabular-nums whitespace-nowrap">
          {formatClock(sec)} / {formatClock(totalSec)}
        </span>
        <div
          ref={barRef}
          onPointerDown={onBarDown}
          className="w-40 h-4 -my-1.5 flex items-center cursor-pointer"
          title="点击或拖动可跳转进度"
        >
          <div className="w-full h-1 rounded-full bg-white/15 overflow-hidden">
            <div className="h-full bg-brand" style={{ width: `${Math.min(100, (sec / totalSec) * 100)}%` }} />
          </div>
        </div>
        <button
          onClick={() => useEditorStore.getState().setPresenting(false)}
          className="w-8 h-8 flex items-center justify-center rounded-full text-foreground/70 hover:text-foreground hover:bg-white/10 transition-colors"
          title="退出演示 (Esc)"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
