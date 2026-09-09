/**
 * 时间线：播放条 + 轨道区（镜头流 / 特效 / 弹窗 / 元素分道）。
 * 轨道行统一「左侧标签槽 + 右侧轨道区」结构，所有块按章节时长百分比定位；
 * 特效/弹窗块点击跳转并打开特效面板对应标签；元素按时间不重叠自动分道。
 */
import { useEffect, useState } from 'react';
import { Play, Pause, SkipBack, SkipForward, ChevronsLeft, ChevronsRight, Layers, Keyboard, Sparkles } from 'lucide-react';
import { useProjectStore } from '../stores/projectStore';
import { useEditorStore } from '../stores/editorStore';
import { formatClock } from '../lib/time';
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

export function TimelineEditor() {
  const project = useProjectStore((s) => s.project);
  const currentFrame = useEditorStore((s) => s.currentFrame);
  const setCurrentFrame = useEditorStore((s) => s.setCurrentFrame);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const setIsPlaying = useEditorStore((s) => s.setIsPlaying);
  const selectedChapterId = useEditorStore((s) => s.selectedChapterId);
  const selectedKeyframeIdx = useEditorStore((s) => s.selectedKeyframeIdx);
  const selectKeyframe = useEditorStore((s) => s.selectKeyframe);
  const selectedElementId = useEditorStore((s) => s.selectedElementId);
  const selectElement = useEditorStore((s) => s.selectElement);
  const elementsOpen = useEditorStore((s) => s.elementsOpen);
  const setElementsOpen = useEditorStore((s) => s.setElementsOpen);
  const openFx = useEditorStore((s) => s.openFx);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

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
  const chapter = project.chapters.find((c) => c.id === selectedChapterId) || project.chapters[0];
  const chapterStart = chapter.startFrame;
  const chapterEnd = chapter.endFrame;
  const chapterDur = Math.max(1, chapterEnd - chapterStart);

  // 选中章节变化时，把当前帧钳制到章节范围内（便于编辑当前章节）
  useEffect(() => {
    if (currentFrame < chapterStart || currentFrame > chapterEnd) {
      setCurrentFrame(chapterStart);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter.id]);

  // 播放（仅当前章节内循环）
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      // rAF 回调的 now 是垂直同步帧起始时间，可能早于 effect 初始化的 last：负 dt 会把播放头推成负帧
      const dt = Math.max(0, Math.min(0.25, (now - last) / 1000));
      last = now;
      const next = useEditorStore.getState().currentFrame + dt * fps;
      if (next >= chapterEnd) {
        useEditorStore.getState().setCurrentFrame(chapterEnd);
        useEditorStore.getState().setIsPlaying(false);
        return;
      }
      useEditorStore.getState().setCurrentFrame(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, fps, chapterEnd]);

  const localFrame = Math.max(0, Math.min(chapterDur, currentFrame - chapterStart));

  // 播放头完全落在某视角的镜头动画区间（移动段）才选中该视角；否则取消选中
  useEffect(() => {
    // 正在编辑元素/特效/无面板时，播放头移动不打断当前面板
    if (['element', 'fx', 'none'].includes(useEditorStore.getState().panelMode)) return;
    const kfs = chapter.camera;
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
  }, [currentFrame, chapter.camera]);
  const localSeconds = localFrame / fps;
  const chapterSeconds = chapterDur / fps;

  const togglePlay = () => {
    if (currentFrame >= chapterEnd) setCurrentFrame(chapterStart);
    setIsPlaying(!isPlaying);
  };

  // ===== 轨道数据准备（统一钳制到章节内，按 % 定位） =====
  const clampF = (f: number) => Math.max(chapterStart, Math.min(chapterEnd, f));
  const leftPct = (f: number) => `${((clampF(f) - chapterStart) / chapterDur) * 100}%`;
  const widthPct = (s: number, e: number) => `${Math.max(0.5, ((clampF(e) - clampF(s)) / chapterDur) * 100)}%`;

  // 特效块（天气 + 画面）
  const fxItems: ScreenFxItem[] = (chapter.fx || []).filter((f) => f.enabled !== false);
  const fxNorm = fxItems.map((f) => ({ fx: f, start: clampF(f.startFrame), end: Math.max(clampF(f.startFrame) + 1, clampF(f.endFrame)) }));
  const fxLaneIdx = packLanes(fxNorm);
  const fxLanes = fxNorm.length ? Math.max(...fxLaneIdx) + 1 : 1;
  const fxMetaOf = (fx: ScreenFxItem) =>
    fx.kind === 'weather'
      ? WEATHERS.find((w) => w.type === fx.weather?.type)
      : SCREEN_FXS.find((s) => s.type === fx.effect?.type);

  // 弹窗块
  const popItems: OverlayItem[] = (chapter.overlays || []);
  const popNorm = popItems.map((o) => ({ ov: o, start: clampF(o.startFrame), end: Math.max(clampF(o.startFrame) + 1, clampF(o.endFrame)) }));
  const popLaneIdx = packLanes(popNorm);
  const popLanes = popNorm.length ? Math.max(...popLaneIdx) + 1 : 1;

  // 元素分道
  const els = chapter.elements;
  const elNorm = els.map((el) => ({ el, start: clampF(el.startFrame), end: Math.max(clampF(el.startFrame) + 1, clampF(el.endFrame)) }));
  const elLaneIdx = packLanes(elNorm);
  const elLanes = elNorm.length ? Math.max(...elLaneIdx) + 1 : 1;

  // 行高：刻度 24 + 镜头流 28 + 特效/弹窗道 20/道 + 元素道 18/道 + 配音/音乐行 22×2
  // 另计入每行 mt-1（4px）行距与底部余量，避免内容被裁切出现滚动条
  const LANE_H = 20;
  const EL_LANE_H = 18;
  const rowCount = 6; // 镜头流 + 特效 + 弹窗 + 元素 + 配音 + 音乐
  const contentH = 24 + 28 + (fxLanes + popLanes) * LANE_H + elLanes * EL_LANE_H + 22 * 2 + (rowCount - 1) * 4 + 6;
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
          onClick={() => { setCurrentFrame(chapterStart); setIsPlaying(false); }}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
          title="回本段开头"
        >
          <SkipBack size={15} />
        </button>
        <button
          onClick={() => setCurrentFrame(Math.max(chapterStart, currentFrame - fps))}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
          title="后退 1 秒"
        >
          <ChevronsLeft size={15} />
        </button>
        <button
          onClick={() => setCurrentFrame(Math.min(chapterEnd, currentFrame + fps))}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
          title="前进 1 秒"
        >
          <ChevronsRight size={15} />
        </button>
        <button
          onClick={() => { setCurrentFrame(chapterEnd); setIsPlaying(false); }}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
          title="跳至本段结尾"
        >
          <SkipForward size={15} />
        </button>

        <div className="ml-2 text-sm text-muted-foreground tabular-nums">
          {formatClock(localSeconds)} / {formatClock(chapterSeconds)}
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

        <span className="text-xs text-muted-foreground truncate max-w-[200px]">{chapter.title}</span>
        <div className="text-xs text-muted-foreground shrink-0">FPS: {fps}</div>
      </div>

      {/* 轨道区（内容超高时纵向滚动，播放头贯穿全部行） */}
      <div className="overflow-y-auto overflow-x-hidden" style={{ height: trackVisibleH }}>
        <div className="relative" style={{ height: contentH }}>
          {/* 播放头 */}
          <div
            className="absolute top-0 bottom-0 left-14 right-0 pointer-events-none"
            style={{ zIndex: 30 }}
          >
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-red-500"
              style={{ left: `${(localFrame / chapterDur) * 100}%` }}
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
              const kfs: CameraKeyframe[] = [...(chapter.camera || [])].sort((a, b) => a.frame - b.frame);
              return kfs.map((kf, i) => {
                const prevFrame = i > 0 ? kfs[i - 1].frame : chapterStart;
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
                  start = Math.max(chapterStart, fr.startFrame ?? kf.frame);
                  end = Math.max(start, Math.min(chapterEnd, fr.endFrame ?? kf.frame));
                } else if (orbit) {
                  start = Math.max(chapterStart, kf.frame);
                  end = Math.max(start, Math.min(chapterEnd, kf.frame + Math.round((kf.orbit?.duration ?? 2) * fps)));
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
                      title={`视角1 · 起点锚定 · t=${((kf.frame - chapterStart) / fps).toFixed(1)}s`}
                    />
                  );
                }
                return (
                  <button
                    key={`kf-${kf.frame}-${i}`}
                    onClick={() => { selectKeyframe(i); setCurrentFrame(start); }}
                    className={`absolute top-1 h-6 rounded-md z-10 overflow-hidden border ${
                      active ? 'bg-brand ring-2 ring-brand/40 border-brand' : 'bg-brand/50 hover:bg-brand/70 border-brand/60'
                    }`}
                    style={{ left: leftPct(start), width: widthPct(start, end) }}
                    title={follow
                      ? `跟随视角${i + 1} · 跟随 ${moveSec}s · ${((start - chapterStart) / fps).toFixed(1)}s → ${((end - chapterStart) / fps).toFixed(1)}s`
                      : orbit
                        ? `环绕视角${i + 1} · 开始 ${((start - chapterStart) / fps).toFixed(1)}s · 持续 ${moveSec}s`
                        : `视角${i + 1} · 移动 ${moveSec}s · 到达 t=${((kf.frame - chapterStart) / fps).toFixed(1)}s`}
                  >
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
                        onClick={() => { setCurrentFrame(start); openFx(fx.kind === 'weather' ? 'weather' : 'screen', fx.id); }}
                        className={`absolute top-0.5 bottom-0.5 rounded border flex items-center overflow-hidden z-10 hover:brightness-110 transition-[filter] ${color}`}
                        style={{ left: leftPct(start), width: widthPct(start, end) }}
                        title={`${meta?.label || fx.name} · ${((start - chapterStart) / fps).toFixed(1)}s → ${((end - chapterStart) / fps).toFixed(1)}s`}
                      >
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
                        onClick={() => { setCurrentFrame(start); openFx('popup', ov.id); }}
                        className={`absolute top-0.5 bottom-0.5 rounded border flex items-center overflow-hidden z-10 hover:brightness-110 transition-[filter] ${POPUP_BLOCK_COLOR}`}
                        style={{ left: leftPct(start), width: widthPct(start, end) }}
                        title={`${ov.name} · ${((start - chapterStart) / fps).toFixed(1)}s → ${((end - chapterStart) / fps).toFixed(1)}s`}
                      >
                        <span className="px-1 text-[10px] leading-none truncate">{meta?.icon || '💬'} {ov.name}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </TrackRow>

          {/* 元素轨道：按时间不重叠自动分道，重叠元素不再互相覆盖 */}
          <TrackRow label="📦 元素" height={elLanes * EL_LANE_H}>
            <div className="absolute inset-0 flex flex-col gap-px py-px">
              {Array.from({ length: elLanes }, (_, lane) => (
                <div key={lane} className="relative flex-1">
                  {elNorm.map(({ el, start, end }, i) => {
                    if (elLaneIdx[i] !== lane) return null;
                    const selected = selectedElementId === el.id;
                    const wPct = ((clampF(end) - clampF(start)) / chapterDur) * 100;
                    return (
                      <button
                        key={el.id}
                        onClick={() => selectElement(el.id)}
                        className={`absolute top-0.5 bottom-0.5 rounded-sm border flex items-center overflow-hidden z-10 transition-colors ${
                          selected
                            ? 'bg-emerald-300/90 border-emerald-100 ring-1 ring-brand text-emerald-950'
                            : 'bg-emerald-500/60 border-emerald-400/50 text-emerald-50 hover:bg-emerald-500/80'
                        }`}
                        style={{ left: leftPct(start), width: widthPct(start, end) }}
                        title={`${el.name} · ${((start - chapterStart) / fps).toFixed(1)}s → ${((end - chapterStart) / fps).toFixed(1)}s`}
                      >
                        {wPct > 7 && <span className="px-1 text-[9px] leading-none truncate">{el.name}</span>}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </TrackRow>

          {/* 配音/字幕轨道：每条字幕一块（宽=显示时长），点击打开字幕页签 */}
          <TrackRow label="🎙 配音" height={22}>
            {(chapter.narration?.entries || []).map((e) => {
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
                  title={`${e.text.slice(0, 24)} · ${((start - chapterStart) / fps).toFixed(1)}s → ${((end - chapterStart) / fps).toFixed(1)}s`}
                >
                  {e.durationFrames / chapterDur > 0.07 && <span className="px-1 text-[9px] leading-none truncate">{e.text}</span>}
                </button>
              );
            })}
          </TrackRow>

          {/* 背景音乐轨道：每段音乐一块（startFrame/endFrame 为章内相对帧），点击打开音乐页签 */}
          <TrackRow label="🎵 音乐" height={22}>
            {(chapter.music || []).map((m) => {
              const start = chapterStart + m.startFrame;
              const end = chapterStart + m.endFrame;
              return (
                <button
                  key={m.id}
                  onClick={() => { setCurrentFrame(start); openFx('music'); }}
                  className="absolute top-0.5 bottom-0.5 rounded border flex items-center overflow-hidden z-10 hover:brightness-110 transition-[filter] bg-violet-500/60 border-violet-400/50"
                  style={{ left: leftPct(start), width: widthPct(start, end) }}
                  title={`${m.name}${m.loop ? '（循环）' : ''} · ${((start - chapterStart) / fps).toFixed(1)}s → ${((end - chapterStart) / fps).toFixed(1)}s`}
                >
                  {(end - start) / chapterDur > 0.07 && <span className="px-1 text-[9px] leading-none truncate">🎵 {m.name}</span>}
                </button>
              );
            })}
          </TrackRow>

          {/* 点击跳转（章节内，位于轨道下层） */}
          <div
            className="absolute inset-0 cursor-pointer z-0"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const percent = Math.max(0, Math.min(1, (e.clientX - rect.left - 56) / (rect.width - 56)));
              setCurrentFrame(Math.round(chapterStart + percent * chapterDur));
            }}
          />
        </div>
      </div>

      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}
