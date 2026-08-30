import { useEffect, useState } from 'react';
import { Play, Pause, SkipBack, SkipForward, ChevronsLeft, ChevronsRight, Layers, Keyboard } from 'lucide-react';
import { useProjectStore } from '../stores/projectStore';
import { useEditorStore } from '../stores/editorStore';
import { formatClock } from '../lib/time';
import { ShortcutsDialog } from './ShortcutsDialog';
import type { CameraKeyframe } from '../types';

export function TimelineEditor() {
  const project = useProjectStore((s) => s.project);
  const currentFrame = useEditorStore((s) => s.currentFrame);
  const setCurrentFrame = useEditorStore((s) => s.setCurrentFrame);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const setIsPlaying = useEditorStore((s) => s.setIsPlaying);
  const selectedChapterId = useEditorStore((s) => s.selectedChapterId);
  const selectedKeyframeIdx = useEditorStore((s) => s.selectedKeyframeIdx);
  const selectKeyframe = useEditorStore((s) => s.selectKeyframe);
  const elementsOpen = useEditorStore((s) => s.elementsOpen);
  const setElementsOpen = useEditorStore((s) => s.setElementsOpen);
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
      const dt = Math.min(0.25, (now - last) / 1000);
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
  const localSeconds = localFrame / fps;
  const chapterSeconds = chapterDur / fps;

  const togglePlay = () => {
    if (currentFrame >= chapterEnd) setCurrentFrame(chapterStart);
    setIsPlaying(!isPlaying);
  };

  return (
    <div className="border-t border-white/[0.06] bg-card" style={{ height: 180 }}>
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

        {/* 元素面板开关 + 快捷键速查（紧跟时钟，靠左） */}
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

      {/* 时间刻度 */}
      <div className="relative" style={{ height: 140 }}>
        {/* 刻度尺（间隔随章节时长自适应，避免密集重叠） */}
        <div className="h-6 border-b border-white/[0.06] flex items-end px-2">
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

        {/* 播放头 */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10"
          style={{ left: `${(localFrame / chapterDur) * 100}%` }}
        />

        {/* 镜头流轨道：块长 = 移动持续时长，点选进入右侧属性 */}
        <div className="mt-2 px-2 h-8 relative z-10">
          <span className="absolute right-2 top-0.5 text-[10px] text-muted-foreground pointer-events-none">🎥 镜头流</span>
          {(() => {
            const kfs: CameraKeyframe[] = [...(chapter.camera || [])].sort((a, b) => a.frame - b.frame);
            return kfs.map((kf, i) => {
              const prevFrame = i > 0 ? kfs[i - 1].frame : chapterStart;
              const moveFrames = i === 0
                ? 0
                : Math.max(1, typeof kf.moveDuration === 'number'
                    ? Math.min(kf.moveDuration, kf.frame - prevFrame)
                    : kf.frame - prevFrame);
              const start = i === 0 ? kf.frame : kf.frame - moveFrames;
              const left = (Math.max(0, start - chapterStart) / chapterDur) * 100;
              const width = i === 0 ? 0 : (moveFrames / chapterDur) * 100;
              const active = selectedKeyframeIdx === i;
              const moveSec = (moveFrames / fps).toFixed(1);

              if (i === 0) {
                return (
                  <button
                    key={`kf0-${kf.frame}`}
                    onClick={() => selectKeyframe(0)}
                    className={`absolute top-1 h-6 w-3 -translate-x-1/2 rounded-sm z-10 ${
                      active ? 'bg-brand ring-2 ring-brand/40' : 'bg-brand/60 hover:bg-brand/80'
                    }`}
                    style={{ left: `${(Math.max(0, kf.frame - chapterStart) / chapterDur) * 100}%` }}
                    title={`视角1 · 起点锚定 · t=${((kf.frame - chapterStart) / fps).toFixed(1)}s`}
                  />
                );
              }
              return (
                <button
                  key={`kf-${kf.frame}-${i}`}
                  onClick={() => selectKeyframe(i)}
                  className={`absolute top-1 h-6 rounded-md z-10 overflow-hidden border ${
                    active ? 'bg-brand ring-2 ring-brand/40 border-brand' : 'bg-brand/50 hover:bg-brand/70 border-brand/60'
                  }`}
                  style={{ left: `${left}%`, width: `${Math.max(0.8, width)}%` }}
                  title={`视角${i + 1} · 移动 ${moveSec}s · 到达 t=${((kf.frame - chapterStart) / fps).toFixed(1)}s`}
                >
                  <span className="block h-full w-full text-[10px] leading-6 text-white text-left pl-1 truncate">
                    {i + 1}
                  </span>
                </button>
              );
            });
          })()}
        </div>

        {/* 元素轨道 */}
        <div className="mt-1 px-2 h-8 relative z-10">
          <span className="absolute right-2 top-0.5 text-[10px] text-muted-foreground pointer-events-none">📦 元素</span>
          {chapter.elements.map((element) => {
            const elStart = (Math.max(0, element.startFrame - chapterStart) / chapterDur) * 100;
            const elWidth = Math.max(0.5, ((element.endFrame - element.startFrame) / chapterDur) * 100);
            return (
              <div
                key={element.id}
                className="absolute top-1 bottom-1 bg-emerald-500/60 border border-emerald-400/50 rounded-sm"
                style={{ left: `${elStart}%`, width: `${elWidth}%` }}
                title={`${element.name} · ${element.startFrame}-${element.endFrame}`}
              />
            );
          })}
        </div>

        {/* 点击跳转（章节内，位于轨道下层） */}
        <div
          className="absolute inset-0 cursor-pointer z-0"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            setCurrentFrame(Math.round(chapterStart + percent * chapterDur));
          }}
        />
      </div>

      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}
