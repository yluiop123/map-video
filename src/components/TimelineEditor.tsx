/**
 * 时间线：播放条 + 轨道区（镜头流 / 特效 / 弹窗 / 元素分道）。
 * 轨道行统一「左侧标签槽 + 右侧轨道区」结构，所有块按时间线时长百分比定位；
 * 特效/弹窗块点击跳转并打开特效面板对应标签；元素按时间不重叠自动分道。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, SkipBack, SkipForward, ChevronsLeft, ChevronsRight, Layers, Keyboard, Sparkles, RectangleHorizontal } from 'lucide-react';
import { useProjectStore, setHistoryMuted } from '../stores/projectStore';
import { useEditorStore } from '../stores/editorStore';
import { formatClock } from '../lib/time';
import { EXPORT_PRESETS } from '../lib/export-video';
import { projectContentEndFrame } from '../lib/project-duration';
import { ShortcutsDialog } from './ShortcutsDialog';
import { WEATHERS, SCREEN_FXS, POPUP_TYPES } from './FxPanelBody';
import type { CameraKeyframe, ScreenFxItem, OverlayItem } from '../types';

/** 特效类型 → 轨道块配色（浅色文字保证可读） */
const FX_BLOCK_COLORS: Record<string, string> = {
  rain: 'bg-sky-500/70 border-sky-300/50 text-sky-50',
  snow: 'bg-cyan-300/60 border-cyan-100/50 text-cyan-950',
  lightning: 'bg-violet-500/70 border-violet-300/50 text-violet-50',
  fog: 'bg-stone-400/55 border-stone-200/40 text-stone-50',
  shake: 'bg-orange-500/70 border-orange-300/50 text-orange-50',
  flash: 'bg-yellow-400/70 border-yellow-200/60 text-yellow-950',
  vignette: 'bg-stone-800/85 border-stone-500/50 text-stone-100',
  cloudReveal: 'bg-slate-300/55 border-slate-100/50 text-slate-900',
  fadeBlack: 'bg-black/85 border-white/25 text-white',
  fadeWhite: 'bg-white/80 border-white/70 text-stone-900',
};
const FX_BLOCK_FALLBACK = 'bg-brand/60 border-brand/50 text-white';
const POPUP_BLOCK_COLOR = 'bg-amber-500/65 border-amber-300/50 text-amber-50';

/** 时间不重叠分道（贪婪占用第一道空闲）：返回每项所在道次，时间重叠的项自动换行 */
function packLanes(items: { start: number; end: number }[]): number[] {
  const order = items.map((_, i) => i).sort((a, b) => items[a].start - items[b].start || items[a].end - items[b].end);
  const ends: number[] = [];
  const lane = new Array(items.length).fill(0);
  for (const i of order) {
    let l = ends.findIndex((e) => items[i].start >= e);
    if (l === -1) { l = ends.length; ends.push(items[i].end); } else { ends[l] = items[i].end; }
    lane[i] = l;
  }
  return lane;
}

/** 轨道行：左侧标签槽（w-14）+ 右侧轨道区（相对定位，块按 % 定位） */
function TrackRow({ label, height, children }: { label: string; height: number; children: React.ReactNode }) {
  return (
    <div className="flex mt-1 first:mt-0" style={{ height }}>
      <div className="w-14 shrink-0 flex items-start justify-end pr-1.5 pt-[3px] text-[10px] text-muted-foreground select-none pointer-events-none whitespace-nowrap">
        {label}
      </div>
      <div className="flex-1 relative min-w-0">{children}</div>
    </div>
  );
}

/** 轨道块两端的拖拽手柄：拖动改开始/结束时间 */
function DragHandles({ onDrag }: { onDrag: (e: React.PointerEvent, mode: 'left' | 'right') => void }) {
  return (
    <>
      <span
        className="absolute left-0 top-0 bottom-0 w-1.5 z-20 cursor-ew-resize"
        onPointerDown={(e) => onDrag(e, 'left')}
      />
      <span
        className="absolute right-0 top-0 bottom-0 w-1.5 z-20 cursor-ew-resize"
        onPointerDown={(e) => onDrag(e, 'right')}
      />
    </>
  );
}

export function TimelineEditor() {
  const project = useProjectStore((s) => s.project);
  const currentFrame = useEditorStore((s) => s.currentFrame);
  const setCurrentFrame = useEditorStore((s) => s.setCurrentFrame);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const setIsPlaying = useEditorStore((s) => s.setIsPlaying);
  const selectedKeyframeIdx = useEditorStore((s) => s.selectedKeyframeIdx);
  const selectKeyframe = useEditorStore((s) => s.selectKeyframe);
  const selectedElementId = useEditorStore((s) => s.selectedElementId);
  const selectElement = useEditorStore((s) => s.selectElement);
  const elementsOpen = useEditorStore((s) => s.elementsOpen);
  const setElementsOpen = useEditorStore((s) => s.setElementsOpen);
  const openFx = useEditorStore((s) => s.openFx);
  const updateGlobalConfig = useProjectStore((s) => s.updateGlobalConfig);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [aspectOpen, setAspectOpen] = useState(false);

  useEffect(() => {
    if (!project) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        const { currentFrame, isPlaying } = useEditorStore.getState();
        setCurrentFrame(currentFrame);
        setIsPlaying(!isPlaying);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [project, setCurrentFrame, setIsPlaying]);

  if (!project) return null;

  const fps = project.globalConfig.defaultFPS;
  const resolution = project.globalConfig.defaultResolution;
  // 用最大公约数换算出简比（1920×1080 → 16:9）
  const aspectLabel = (() => {
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    const d = gcd(resolution.width, resolution.height) || 1;
    return `${resolution.width / d}:${resolution.height / d}`;
  })();
  const timelineStart = 0;
  // 播放/时间线终点 = max(内容实际结束帧, 60s)：改元素/弹窗/字幕时间后总时长即时跟随；
  // 内容不足 60 秒时预览/时间线也至少铺满 60 秒（便于摆放与拖拽）。
  const minFrames = Math.max(1, Math.round(60 * fps));
  const contentEnd = useMemo(() => projectContentEndFrame(project), [project]);
  const timelineEnd = Math.max(minFrames, contentEnd || project.endFrame);
  const timelineDur = Math.max(1, timelineEnd - timelineStart);

  // 播放头超出总范围时（如内容被缩短）回到起点
  useEffect(() => {
    if (currentFrame < timelineStart || currentFrame > timelineEnd) {
      setCurrentFrame(timelineStart);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, timelineEnd]);

  // 播放（仅当前时间线内循环）
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      // rAF 回调的 now 是垂直同步帧起始时间，可能早于 effect 初始化的 last：负 dt 会把播放头推成负帧
      const dt = Math.max(0, Math.min(0.25, (now - last) / 1000));
      last = now;
      const next = useEditorStore.getState().currentFrame + dt * fps;
      if (next >= timelineEnd) {
        useEditorStore.getState().setCurrentFrame(timelineStart);
        useEditorStore.getState().setIsPlaying(false);
        return;
      }
      useEditorStore.getState().setCurrentFrame(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, fps, timelineEnd, timelineStart]);

  const localFrame = Math.max(0, Math.min(timelineDur, currentFrame - timelineStart));

  // 播放头完全落在某视角的镜头动画区间（移动段）才选中该视角；否则取消选中
  useEffect(() => {
    // 正在编辑元素/特效/无面板时，播放头移动不打断当前面板
    if (['element', 'fx', 'none'].includes(useEditorStore.getState().panelMode)) return;
    const kfs = project.camera;
    const clear = () => {
      if (useEditorStore.getState().selectedKeyframeIdx !== null) {
        useEditorStore.getState().selectKeyframe(null);
      }
    };
    if (!kfs || kfs.length === 0) { clear(); return; }
    const arr = [...kfs].sort((a, b) => a.frame - b.frame);
    // 起点视角（第 1 个）：帧在它之前或它本身 → 选中（回本段开头/第 0 秒可选中）
    if (currentFrame <= arr[0].frame) {
      if (useEditorStore.getState().selectedKeyframeIdx !== 0) selectKeyframe(0);
      return;
    }
    // 只有一个视角：后续帧都属于它
    if (arr.length === 1) {
      if (useEditorStore.getState().selectedKeyframeIdx !== 0) selectKeyframe(0);
      return;
    }
    // 命中：帧落在某个视角的区间
    // 固定视角 = 移动动画区间 [kf.frame - moveDuration, kf.frame]
    // 跟随视角 = 跟随起止 [startFrame, endFrame]
    // 环绕视角 = 开始 + 环绕时长 [frame, frame + duration*fps]
    let hit: number | null = null;
    for (let i = 1; i < arr.length; i++) {
      const prev = arr[i - 1];
      const kf = arr[i];
      let start: number;
      let end: number;
      if (kf.followRoute) {
        start = kf.followRoute.startFrame ?? kf.frame;
        end = kf.followRoute.endFrame ?? kf.frame;
      } else if (kf.orbit) {
        start = kf.frame;
        end = kf.frame + Math.round((kf.orbit.duration ?? 2) * fps);
      } else {
        const gap = Math.max(0, kf.frame - prev.frame);
        const move = typeof kf.moveDuration === 'number' ? Math.min(kf.moveDuration, gap) : Math.min(2 * fps, gap);
        start = kf.frame - move;
        end = kf.frame;
      }
      if (currentFrame >= start && currentFrame <= end) { hit = i; break; }
    }
    if (hit === null) { clear(); return; }
    if (useEditorStore.getState().selectedKeyframeIdx !== hit) {
      selectKeyframe(hit);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFrame, project.camera]);
  const localSeconds = localFrame / fps;
  const chapterSeconds = timelineDur / fps;

  const togglePlay = () => {
    if (currentFrame >= timelineEnd) setCurrentFrame(timelineStart);
    setIsPlaying(!isPlaying);
  };

  // ===== 拖动播放头 scrub：轨道区按下并左右拖动即可控制当前时间（拖动时暂停播放） =====
  const trackAreaRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const scrubClientXRef = useRef<(clientX: number) => void>(() => {});
  scrubClientXRef.current = (clientX: number) => {
    const el = trackAreaRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const bodyLeft = rect.left + 56;               // 左侧标签槽宽 w-14
    const bodyW = Math.max(1, rect.width - 56);
    const pct = Math.max(0, Math.min(1, (clientX - bodyLeft) / bodyW));
    setCurrentFrame(Math.round(timelineStart + pct * timelineDur));
  };
  const startScrub = (clientX: number) => {
    setIsPlaying(false);
    draggingRef.current = true;
    scrubClientXRef.current(clientX);
  };
  useEffect(() => {
    const onMove = (e: PointerEvent) => { if (draggingRef.current) scrubClientXRef.current(e.clientX); };
    const onUp = () => { draggingRef.current = false; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  // ===== 拖动轨道块：整体平移 / 拖两端改起止时间（特效 · 弹窗 · 元素 · 视角） =====
  const suppressClickRef = useRef(false);
  const blockDragRef = useRef<null | {
    kind: 'fx' | 'popup' | 'element' | 'camera';
    id?: string;
    kf?: CameraKeyframe;
    frameNow?: number;
    minFrame?: number;
    maxFrame?: number;
    mode: 'move' | 'left' | 'right';
    startClientX: number;
    origStart: number;
    origEnd: number;
    moved: boolean;
  }>(null);

  // 拖动期间冻结轨道分道：否则块横向移动与别的元素时间重叠时会被重新分道 → 上下跳
  const [laneFreeze, setLaneFreeze] = useState<{ kind: 'fx' | 'popup' | 'element'; lanes: number; idx: Map<string, number> } | null>(null);

  /** 客户端 X → 时间线内的帧偏移（相对 timelineStart） */
  const frameOffsetAt = (clientX: number) => {
    const el = trackAreaRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const bodyLeft = rect.left + 56;               // 左侧标签槽宽 w-14
    const bodyW = Math.max(1, rect.width - 56);
    const pct = Math.max(0, Math.min(1, (clientX - bodyLeft) / bodyW));
    return pct * timelineDur;
  };

  const beginBlockDrag = (
    e: React.PointerEvent,
    spec: { kind: 'fx' | 'popup' | 'element' | 'camera'; mode: 'move' | 'left' | 'right'; start: number; end: number; id?: string; kf?: CameraKeyframe; minFrame?: number; maxFrame?: number },
  ) => {
    e.stopPropagation();
    setIsPlaying(false);
    blockDragRef.current = {
      kind: spec.kind, id: spec.id, kf: spec.kf, frameNow: spec.kf?.frame,
      minFrame: spec.minFrame, maxFrame: spec.maxFrame,
      mode: spec.mode, startClientX: e.clientX, origStart: spec.start, origEnd: spec.end, moved: false,
    };
    // 冻结当前分道（用拖动开始前的布局），拖动中不再重排（视角轨道不分道）
    if (spec.kind === 'fx') setLaneFreeze({ kind: 'fx', lanes: fxLanes, idx: new Map(fxNorm.map((n, i) => [n.fx.id, fxLaneIdx[i]])) });
    else if (spec.kind === 'popup') setLaneFreeze({ kind: 'popup', lanes: popLanes, idx: new Map(popNorm.map((n, i) => [n.ov.id, popLaneIdx[i]])) });
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = blockDragRef.current;
      if (!d) return;
      if (!d.moved && Math.abs(e.clientX - d.startClientX) < 3) return;
      document.body.style.userSelect = 'none';
      const delta = frameOffsetAt(e.clientX) - frameOffsetAt(d.startClientX);

      // 视角块：平移到达帧 / 拖边界改移动时长（跟随、环绕各有对应字段）
      if (d.kind === 'camera' && d.kf) {
        const orig = d.kf;
        const lo = d.minFrame ?? 1;
        const hi = d.maxFrame ?? timelineEnd;
        let updated: CameraKeyframe;
        if (orig.followRoute) {
          const fr = orig.followRoute;
          const s0 = fr.startFrame ?? orig.frame;
          const e0 = fr.endFrame ?? orig.frame;
          if (d.mode === 'left') {
            updated = { ...orig, followRoute: { ...fr, startFrame: Math.round(Math.max(lo, Math.min(s0 + delta, e0 - 1))), endFrame: e0 } };
          } else if (d.mode === 'right') {
            updated = { ...orig, followRoute: { ...fr, startFrame: s0, endFrame: Math.round(Math.max(s0 + 1, Math.min(e0 + delta, hi))) } };
          } else {
            const nf = Math.round(Math.max(lo, Math.min(hi, orig.frame + delta)));
            const rd = nf - orig.frame;
            updated = { ...orig, frame: nf, followRoute: { ...fr, startFrame: s0 + rd, endFrame: e0 + rd } };
          }
        } else if (orig.orbit) {
          const s0 = orig.frame;
          const e0 = orig.frame + Math.round((orig.orbit.duration ?? 2) * fps);
          if (d.mode === 'left') {
            const ns = Math.round(Math.max(lo, Math.min(s0 + delta, e0 - 1)));
            updated = { ...orig, frame: ns, orbit: { ...orig.orbit, duration: Math.max(1 / fps, (e0 - ns) / fps) } };
          } else if (d.mode === 'right') {
            const ne = Math.round(Math.max(s0 + 1, Math.min(e0 + delta, hi)));
            updated = { ...orig, frame: s0, orbit: { ...orig.orbit, duration: Math.max(1 / fps, (ne - s0) / fps) } };
          } else {
            updated = { ...orig, frame: Math.round(Math.max(lo, Math.min(hi, orig.frame + delta))) };
          }
        } else {
          const prevF = Math.max(0, (d.minFrame ?? 1) - 1);
          const md0 = typeof orig.moveDuration === 'number' ? orig.moveDuration : Math.min(2 * fps, Math.max(0, orig.frame - prevF));
          const s0 = orig.frame - md0;
          const e0 = orig.frame;
          // 普通视角：到达时间 = 结束时间，持续时间 = 结束 - 开始。
          // 拖右边界改结束（开始固定）→ 持续时间随之变化；拖左边界改开始（结束固定）。
          if (d.mode === 'left') {
            const ns = Math.round(Math.max(lo, Math.min(s0 + delta, e0 - 1)));
            updated = { ...orig, moveDuration: Math.max(1, e0 - ns) };
          } else if (d.mode === 'right') {
            const ne = Math.round(Math.max(s0 + 1, Math.min(e0 + delta, hi)));
            updated = { ...orig, frame: ne, moveDuration: Math.max(1, ne - s0) };
          } else {
            updated = { ...orig, frame: Math.round(Math.max(lo, Math.min(hi, orig.frame + delta))) };
          }
        }
        setHistoryMuted(d.moved);
        const st = useProjectStore.getState();
        const cam = st.project?.camera || [];
        st.setProjectCamera(cam.map((k) => (k.frame === d.frameNow ? updated : k)));
        d.frameNow = updated.frame;
        d.moved = true;
        return;
      }

      const minLen = Math.max(1, Math.round(fps * 0.1));
      let s = d.origStart;
      let en = d.origEnd;
      if (d.mode === 'move') {
        s = d.origStart + delta;
        en = d.origEnd + delta;
        if (s < timelineStart) { en += timelineStart - s; s = timelineStart; }
        if (en > timelineEnd) { s -= en - timelineEnd; en = timelineEnd; }
        s = Math.max(timelineStart, s);
        en = Math.min(timelineEnd, en);
      } else if (d.mode === 'left') {
        s = Math.max(timelineStart, Math.min(d.origStart + delta, d.origEnd - minLen));
      } else {
        en = Math.min(timelineEnd, Math.max(d.origEnd + delta, d.origStart + minLen));
      }
      s = Math.round(s);
      en = Math.round(en);
      // 整段拖动只压一次历史：首次移动提交，其余静默
      setHistoryMuted(d.moved);
      const st = useProjectStore.getState();
      if (d.kind === 'fx') st.updateScreenFx(d.id!, { startFrame: s, endFrame: en });
      else if (d.kind === 'popup') st.updateOverlay(d.id!, { startFrame: s, endFrame: en });
      else st.updateElement(d.id!, { startFrame: s, endFrame: en });
      d.moved = true;
    };
    const onUp = () => {
      const d = blockDragRef.current;
      blockDragRef.current = null;
      document.body.style.userSelect = '';
      setHistoryMuted(false);
      setLaneFreeze(null);
      if (d?.moved) {
        suppressClickRef.current = true;
        setTimeout(() => { suppressClickRef.current = false; }, 0);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timelineStart, timelineEnd, timelineDur, fps]);

  // ===== 轨道数据准备（统一钳制到时间线内，按 % 定位） =====
  const clampF = (f: number) => Math.max(timelineStart, Math.min(timelineEnd, f));
  const leftPct = (f: number) => `${((clampF(f) - timelineStart) / timelineDur) * 100}%`;
  const widthPct = (s: number, e: number) => `${Math.max(0.5, ((clampF(e) - clampF(s)) / timelineDur) * 100)}%`;

  // 特效块（天气 + 画面）
  /** 应用拖动冻结：拖动中的轨道沿用拖动前的分道，避免上下跳 */
  const applyFreeze = (kind: 'fx' | 'popup' | 'element', ids: string[], idx: number[], lanes: number) => {
    if (!laneFreeze || laneFreeze.kind !== kind) return { idx, lanes };
    return {
      idx: idx.map((v, i) => laneFreeze.idx.get(ids[i]) ?? v),
      lanes: Math.max(lanes, laneFreeze.lanes),
    };
  };

  const fxItems: ScreenFxItem[] = (project.fx || []).filter((f) => f.enabled !== false);
  const fxNorm = fxItems.map((f) => ({ fx: f, start: clampF(f.startFrame), end: Math.max(clampF(f.startFrame) + 1, clampF(f.endFrame)) }));
  const fxRaw = packLanes(fxNorm);
  const fxRawLanes = fxNorm.length ? Math.max(...fxRaw) + 1 : 1;
  const fxView = applyFreeze('fx', fxNorm.map((n) => n.fx.id), fxRaw, fxRawLanes);
  const fxLaneIdx = fxView.idx;
  const fxLanes = fxView.lanes;
  const fxMetaOf = (fx: ScreenFxItem) =>
    fx.kind === 'weather'
      ? WEATHERS.find((w) => w.type === fx.weather?.type)
      : SCREEN_FXS.find((s) => s.type === fx.effect?.type);

  // 弹窗块
  const popItems: OverlayItem[] = (project.overlays || []);
  const popNorm = popItems.map((o) => ({ ov: o, start: clampF(o.startFrame), end: Math.max(clampF(o.startFrame) + 1, clampF(o.endFrame)) }));
  const popRaw = packLanes(popNorm);
  const popRawLanes = popNorm.length ? Math.max(...popRaw) + 1 : 1;
  const popView = applyFreeze('popup', popNorm.map((n) => n.ov.id), popRaw, popRawLanes);
  const popLaneIdx = popView.idx;
  const popLanes = popView.lanes;

  // 元素分道
    const layers = project.layers || [];
    const layerNorm = layers.map((L) => ({ L, start: clampF(L.startFrame), end: Math.max(clampF(L.startFrame) + 1, clampF(L.endFrame)) }));
    const layerRaw = packLanes(layerNorm);
    const layerRawLanes = layerNorm.length ? Math.max(...layerRaw) + 1 : 1;
    const layerView = applyFreeze('element', layerNorm.map((n) => n.L.id), layerRaw, layerRawLanes);
    const layerLaneIdx = layerView.idx;
    const layerLanes = layerView.lanes;

  // 行高：刻度 24 + 镜头流 28 + 特效/弹窗道 20/道 + 元素道 18/道 + 配音/音乐行 22×2
  // 另计入每行 mt-1（4px）行距与底部余量，避免内容被裁切出现滚动条
  const LANE_H = 20;
  const EL_LANE_H = 18;
  const rowCount = 6; // 镜头流 + 特效 + 弹窗 + 元素 + 配音 + 音乐
  const contentH = 24 + 28 + (fxLanes + popLanes) * LANE_H + layerLanes * EL_LANE_H + 22 * 2 + (rowCount - 1) * 4 + 6;
  const trackVisibleH = Math.min(contentH, 250);

  return (
    <div className="border-t border-white/[0.06] bg-card shrink-0" style={{ height: 44 + trackVisibleH }}>
      {/* 播放控制（对齐 Mapimator 底栏：Play Preview 胶囊 + 图标按钮） */}
      <div className="h-11 flex items-center gap-1.5 px-3 border-b border-white/[0.06]">
        <button
          onClick={togglePlay}
          className="h-8 px-3.5 flex items-center gap-2 rounded-full bg-white/[0.07] border border-white/10 text-sm font-medium text-foreground/85 hover:bg-white/10 transition-colors"
          title={isPlaying ? '暂停 (空格)' : '播放预览 (空格)'}
        >
          {isPlaying ? <Pause size={14} /> : <Play size={14} />}
          播放预览
        </button>
        <button
          onClick={() => { setCurrentFrame(timelineStart); setIsPlaying(false); }}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
          title="回本段开头"
        >
          <SkipBack size={15} />
        </button>
        <button
          onClick={() => setCurrentFrame(Math.max(timelineStart, currentFrame - fps))}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
          title="后退 1 秒"
        >
          <ChevronsLeft size={15} />
        </button>
        <button
          onClick={() => setCurrentFrame(Math.min(timelineEnd, currentFrame + fps))}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
          title="前进 1 秒"
        >
          <ChevronsRight size={15} />
        </button>
        <button
          onClick={() => { setCurrentFrame(timelineEnd); setIsPlaying(false); }}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
          title="跳至本段结尾"
        >
          <SkipForward size={15} />
        </button>

        <div className="ml-2 text-sm text-muted-foreground tabular-nums">
          {formatClock(localSeconds)} / {formatClock(chapterSeconds)}
        </div>

        {/* 画幅切换（导出分辨率；位于「元素」按钮之前） */}
        <div className="relative ml-2">
          <button
            onClick={() => setAspectOpen((v) => !v)}
            className={`h-8 px-3 flex items-center gap-1.5 rounded-md text-xs font-medium transition-colors ${
              aspectOpen ? 'bg-white/10 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
            }`}
            title="切换常用画幅（导出分辨率）"
          >
            <RectangleHorizontal size={13} /> 画幅 {aspectLabel}
          </button>
          {aspectOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setAspectOpen(false)} />
              <div className="absolute bottom-full mb-2 left-0 z-50 w-56 bg-[#171412]/95 backdrop-blur-md border border-white/[0.14] rounded-xl shadow-2xl p-1.5">
                {EXPORT_PRESETS.map((p) => {
                  const on = p.width === resolution.width && p.height === resolution.height;
                  return (
                    <button
                      key={p.label}
                      onClick={() => {
                        updateGlobalConfig({ defaultResolution: { width: p.width, height: p.height, label: p.label } });
                        setAspectOpen(false);
                      }}
                      className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-xs transition-colors ${
                        on ? 'bg-brand/20 text-foreground' : 'text-foreground/80 hover:bg-white/[0.06]'
                      }`}
                    >
                      <span className="truncate">{p.label}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0">{p.width}×{p.height}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
        {/* 元素面板开关 + 特效 + 快捷键速查（紧跟时钟，靠左） */}
        <button
          onClick={() => setElementsOpen(!elementsOpen)}
          className={`ml-2 h-8 px-3 flex items-center gap-1.5 rounded-md text-xs font-medium transition-colors ${
            elementsOpen ? 'bg-white/10 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
          }`}
          title="元素列表"
        >
          <Layers size={13} /> 元素
        </button>
        <button
          onClick={() => openFx()}
          className="h-8 px-3 flex items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
          title="特效（天气/画面/弹窗/标题/字幕/音乐）"
        >
          <Sparkles size={13} /> 特效
        </button>
        <button
          onClick={() => setShortcutsOpen(true)}
          className="h-8 px-3 flex items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
          title="快捷键速查"
        >
          <Keyboard size={13} /> 快捷键
        </button>

        <div className="flex-1" />

        <span className="text-xs text-muted-foreground truncate max-w-[200px]">{project.name}</span>
        <div className="text-xs text-muted-foreground shrink-0">FPS: {fps}</div>
      </div>

      {/* 轨道区（内容超高时纵向滚动，播放头贯穿全部行） */}
      <div ref={trackAreaRef} className="overflow-y-auto overflow-x-hidden" style={{ height: trackVisibleH }}>
        <div className="relative" style={{ height: contentH }}>
          {/* 播放头（可拖动 scrub） */}
          <div
            className="absolute top-0 bottom-0 left-14 right-0 pointer-events-none"
            style={{ zIndex: 30 }}
          >
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-red-500"
              style={{ left: `${(localFrame / timelineDur) * 100}%` }}
            />
            <div
              className="absolute top-0 bottom-0 -ml-1.5 w-3 cursor-col-resize pointer-events-auto"
              style={{ left: `${(localFrame / timelineDur) * 100}%` }}
              title="拖动控制时间"
              onPointerDown={(e) => { e.preventDefault(); startScrub(e.clientX); }}
            />
          </div>

          {/* 时间刻度（与轨道同构：标签槽 + 刻度区） */}
          <div className="flex" style={{ height: 24 }}>
            <div className="w-14 shrink-0 border-b border-white/[0.06]" />
            <div className="flex-1 relative border-b border-white/[0.06]">
              {(() => {
                const step = chapterSeconds > 90 ? 20 : chapterSeconds > 45 ? 10 : chapterSeconds > 20 ? 5 : 1;
                const ticks = [];
                for (let i = 0; i <= chapterSeconds; i += step) {
                  ticks.push(
                    <div
                      key={i}
                      className="absolute bottom-0 text-[10px] text-muted-foreground"
                      style={{ left: `${(i / chapterSeconds) * 100}%` }}
                    >
                      <div className="w-px h-2 bg-white/20" />
                      <span className="ml-1">{i}s</span>
                    </div>
                  );
                }
                return ticks;
              })()}
            </div>
          </div>

          {/* 镜头流轨道：块长 = 移动持续时长，点选进入右侧属性 */}
          <TrackRow label="🎥 镜头流" height={28}>
            {(() => {
              const kfs: CameraKeyframe[] = [...(project.camera || [])].sort((a, b) => a.frame - b.frame);
              return kfs.map((kf, i) => {
                const prevFrame = i > 0 ? kfs[i - 1].frame : timelineStart;
                const follow = !!kf.followRoute;
                const orbit = !!kf.orbit;
                const moveFrames = i === 0
                  ? 0
                  : Math.max(1, typeof kf.moveDuration === 'number'
                      ? Math.min(kf.moveDuration, kf.frame - prevFrame)
                      : Math.min(2 * fps, kf.frame - prevFrame));
                // 跟随视角：块 = 跟随的起止时间；环绕视角：块 = 开始时间 + 环绕时长；否则 = 移动段
                let start: number;
                let end: number;
                if (follow) {
                  const fr = kf.followRoute!;
                  start = Math.max(timelineStart, fr.startFrame ?? kf.frame);
                  end = Math.max(start, Math.min(timelineEnd, fr.endFrame ?? kf.frame));
                } else if (orbit) {
                  start = Math.max(timelineStart, kf.frame);
                  end = Math.max(start, Math.min(timelineEnd, kf.frame + Math.round((kf.orbit?.duration ?? 2) * fps)));
                } else {
                  start = i === 0 ? kf.frame : kf.frame - moveFrames;
                  end = i === 0 ? kf.frame : kf.frame;
                }
                const active = selectedKeyframeIdx === i;
                const moveSec = ((end - start) / fps).toFixed(1);

                if (i === 0) {
                  return (
                    <button
                      key={`kf0-${kf.frame}`}
                      onClick={() => { selectKeyframe(0); setCurrentFrame(kf.frame); }}
                      className={`absolute top-1 h-6 w-3 -translate-x-1/2 rounded-sm z-10 ${
                        active ? 'bg-brand ring-2 ring-brand/40' : 'bg-brand/60 hover:bg-brand/80'
                      }`}
                      style={{ left: leftPct(kf.frame) }}
                      title={`视角1 · 起点锚定 · t=${((kf.frame - timelineStart) / fps).toFixed(1)}s`}
                    />
                  );
                }
                return (
                  <button
                    key={`kf-${kf.frame}-${i}`}
                    onPointerDown={(e) => beginBlockDrag(e, {
                      kind: 'camera', kf, mode: 'move', start, end,
                      minFrame: prevFrame + 1,
                      maxFrame: (kfs[i + 1]?.frame ?? timelineEnd) - 1,
                    })}
                    onClick={() => { if (suppressClickRef.current) return; selectKeyframe(i); setCurrentFrame(start); }}
                    className={`absolute top-1 h-6 rounded-md z-10 overflow-hidden border ${
                      active ? 'bg-brand ring-2 ring-brand/40 border-brand' : 'bg-brand/50 hover:bg-brand/70 border-brand/60'
                    }`}
                    style={{ left: leftPct(start), width: widthPct(start, end) }}
                    title={follow
                      ? `跟随视角${i + 1} · 跟随 ${moveSec}s · ${((start - timelineStart) / fps).toFixed(1)}s → ${((end - timelineStart) / fps).toFixed(1)}s（拖动可调整时间）`
                      : orbit
                        ? `环绕视角${i + 1} · 开始 ${((start - timelineStart) / fps).toFixed(1)}s · 持续 ${moveSec}s（拖动可调整时间）`
                        : `视角${i + 1} · 移动 ${moveSec}s · 到达 t=${((kf.frame - timelineStart) / fps).toFixed(1)}s（拖动可调整时间）`}
                  >
                    <DragHandles onDrag={(e, mode) => beginBlockDrag(e, {
                      kind: 'camera', kf, mode, start, end,
                      minFrame: prevFrame + 1,
                      maxFrame: (kfs[i + 1]?.frame ?? timelineEnd) - 1,
                    })} />
                    <span className="block h-full w-full text-[10px] leading-6 text-white text-left pl-1 truncate">
                      {i + 1}
                    </span>
                  </button>
                );
              });
            })()}
          </TrackRow>

          {/* 特效轨道：天气 + 画面特效（分道不重叠；点击跳转并打开对应标签） */}
          <TrackRow label="✨ 特效" height={fxLanes * LANE_H}>
            <div className="absolute inset-0 flex flex-col gap-px py-px">
              {Array.from({ length: fxLanes }, (_, lane) => (
                <div key={lane} className="relative flex-1">
                  {fxNorm.map(({ fx, start, end }, i) => {
                    if (fxLaneIdx[i] !== lane) return null;
                    const meta = fxMetaOf(fx);
                    const color = FX_BLOCK_COLORS[fx.kind === 'weather' ? fx.weather?.type || '' : fx.effect?.type || ''] || FX_BLOCK_FALLBACK;
                    return (
                      <button
                        key={fx.id}
                        onPointerDown={(e) => beginBlockDrag(e, { kind: 'fx', id: fx.id, mode: 'move', start, end })}
                        onClick={() => { if (suppressClickRef.current) return; setCurrentFrame(start); openFx(fx.kind === 'weather' ? 'weather' : 'screen', fx.id); }}
                        className={`absolute top-0.5 bottom-0.5 rounded border flex items-center overflow-hidden z-10 hover:brightness-110 transition-[filter] ${color}`}
                        style={{ left: leftPct(start), width: widthPct(start, end) }}
                        title={`${meta?.label || fx.name} · ${((start - timelineStart) / fps).toFixed(1)}s → ${((end - timelineStart) / fps).toFixed(1)}s（拖动可调整时间）`}
                      >
                        <DragHandles onDrag={(e, mode) => beginBlockDrag(e, { kind: 'fx', id: fx.id, mode, start, end })} />
                        <span className="px-1 text-[10px] leading-none truncate">{meta?.icon || '✨'} {fx.name}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </TrackRow>

          {/* 弹窗轨道：弹窗卡片（含文字块/图表等） */}
          <TrackRow label="💬 弹窗" height={popLanes * LANE_H}>
            <div className="absolute inset-0 flex flex-col gap-px py-px">
              {Array.from({ length: popLanes }, (_, lane) => (
                <div key={lane} className="relative flex-1">
                  {popNorm.map(({ ov, start, end }, i) => {
                    if (popLaneIdx[i] !== lane) return null;
                    const meta = POPUP_TYPES.find((p) => p.type === ov.type);
                    return (
                      <button
                        key={ov.id}
                        onPointerDown={(e) => beginBlockDrag(e, { kind: 'popup', id: ov.id, mode: 'move', start, end })}
                        onClick={() => { if (suppressClickRef.current) return; setCurrentFrame(start); openFx('popup', ov.id); }}
                        className={`absolute top-0.5 bottom-0.5 rounded border flex items-center overflow-hidden z-10 hover:brightness-110 transition-[filter] ${POPUP_BLOCK_COLOR}`}
                        style={{ left: leftPct(start), width: widthPct(start, end) }}
                        title={`${ov.name} · ${((start - timelineStart) / fps).toFixed(1)}s → ${((end - timelineStart) / fps).toFixed(1)}s（拖动可调整时间）`}
                      >
                        <DragHandles onDrag={(e, mode) => beginBlockDrag(e, { kind: 'popup', id: ov.id, mode, start, end })} />
                        <span className="px-1 text-[10px] leading-none truncate">{meta?.icon || '💬'} {ov.name}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </TrackRow>

          {/* 图层轨道：每块 = 一个图层的显示区间（播放预览里呈现的是图层而非具体元素） */}
          <TrackRow label="📦 图层" height={layerLanes * EL_LANE_H}>
            <div className="absolute inset-0 flex flex-col gap-px py-px">
              {Array.from({ length: layerLanes }, (_, lane) => (
                <div key={lane} className="relative flex-1">
                  {layerNorm.map(({ L, start, end }, i) => {
                    if (layerLaneIdx[i] !== lane) return null;
                    const hasSel = !!selectedElementId && (L.elements || []).some((el) => el.id === selectedElementId);
                    const wPct = ((clampF(end) - clampF(start)) / timelineDur) * 100;
                    return (
                      <button
                        key={L.id}
                        onClick={() => {
                          if (suppressClickRef.current) return;
                          setElementsOpen(true);
                          setCurrentFrame(start);
                          if (L.elements[0]) selectElement(L.elements[0].id);
                        }}
                        className={`absolute top-0.5 bottom-0.5 rounded-sm border flex items-center overflow-hidden z-10 transition-colors ${
                          hasSel
                            ? 'bg-emerald-300/90 border-emerald-100 ring-1 ring-brand text-emerald-950'
                            : L.visible === false
                              ? 'bg-emerald-500/20 border-emerald-400/30 text-emerald-50/60'
                              : 'bg-emerald-500/60 border-emerald-400/50 text-emerald-50 hover:bg-emerald-500/80'
                        }`}
                        style={{ left: leftPct(start), width: widthPct(start, end) }}
                        title={`${L.name} · ${L.elements.length} 个元素 · ${((start - timelineStart) / fps).toFixed(1)}s → ${((end - timelineStart) / fps).toFixed(1)}s`}
                      >
                        <span className={`px-1 text-[9px] leading-none truncate ${wPct > 1.5 ? '' : 'sr-only'}`}>📦 {L.name}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </TrackRow>

          {/* 配音/字幕轨道：每条字幕一块（宽=显示时长），点击打开字幕页签 */}
          <TrackRow label="🎙 配音" height={22}>
            {(project.narration?.entries || []).map((e) => {
              const start = e.startFrame;
              const end = e.startFrame + e.durationFrames;
              const st = e.status || 'none';
              return (
                <button
                  key={e.id}
                  onClick={() => { setCurrentFrame(start); openFx('subtitle'); }}
                  className={`absolute top-0.5 bottom-0.5 rounded border flex items-center overflow-hidden z-10 hover:brightness-110 transition-[filter] ${
                    st === 'ready' ? 'bg-sky-500/60 border-sky-400/50' : st === 'error' ? 'bg-red-500/50 border-red-400/50' : st === 'pending' ? 'bg-amber-500/60 border-amber-400/50' : 'bg-sky-500/30 border-sky-400/40'
                  }`}
                  style={{ left: leftPct(start), width: widthPct(start, end) }}
                  title={`${e.text.slice(0, 24)} · ${((start - timelineStart) / fps).toFixed(1)}s → ${((end - timelineStart) / fps).toFixed(1)}s`}
                >
                  {e.durationFrames / timelineDur > 0.07 && <span className="px-1 text-[9px] leading-none truncate">{e.text}</span>}
                </button>
              );
            })}
          </TrackRow>

          {/* 背景音乐轨道（项目级单轨多段，绝对帧）：只显示与本章相交的段，点击打开音乐页签 */}
          <TrackRow label="🎵 音乐" height={22}>
            {(project.music || []).filter((m) => m.endFrame > timelineStart && m.startFrame < timelineEnd).map((m) => {
              const start = m.startFrame;
              const end = m.endFrame;
              return (
                <button
                  key={m.id}
                  onClick={() => { setCurrentFrame(Math.max(timelineStart, Math.min(timelineEnd, start))); openFx('music'); }}
                  className="absolute top-0.5 bottom-0.5 rounded border flex items-center overflow-hidden z-10 hover:brightness-110 transition-[filter] bg-violet-500/60 border-violet-400/50"
                  style={{ left: leftPct(start), width: widthPct(start, end) }}
                  title={`${m.name}${m.loop ? '（循环）' : ''} · ${(start / fps).toFixed(1)}s → ${(end / fps).toFixed(1)}s`}
                >
                  {(Math.min(end, timelineEnd) - Math.max(start, timelineStart)) / timelineDur > 0.07 && <span className="px-1 text-[9px] leading-none truncate">🎵 {m.name}</span>}
                </button>
              );
            })}
          </TrackRow>

          {/* 点击/拖动跳转（时间线内，位于轨道下层）：点击定位、按住左右拖动 scrub */}
          <div
            className="absolute inset-0 cursor-col-resize z-0"
            onPointerDown={(e) => { e.preventDefault(); startScrub(e.clientX); }}
          />
        </div>
      </div>

      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}
