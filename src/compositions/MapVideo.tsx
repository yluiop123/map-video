import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { MapScene } from './MapScene';
import { useProjectStore } from '../stores/projectStore';
import { OverlayRenderer } from './OverlayRenderer';
import { buildTransition, clamp01 } from './transition';
import type { MapVideoProject } from '../types';

interface MapVideoProps {
  projectId?: string;
  project?: MapVideoProject;
}

/** 找到当前绝对 frame 所属章节的下标；越界时取其边界章节 */
function getChapterIndex(project: MapVideoProject, frame: number): number {
  const idx = project.chapters.findIndex((ch) => frame >= ch.startFrame && frame < ch.endFrame);
  if (idx !== -1) return idx;
  const last = project.chapters[project.chapters.length - 1];
  if (last && frame >= last.endFrame) return project.chapters.length - 1;
  return 0;
}

export const MapVideo: React.FC<MapVideoProps> = ({ projectId: _projectId, project: propProject }) => {
  const frame = useCurrentFrame();
  const storeProject = useProjectStore((s) => s.project);
  const project = propProject || storeProject;

  if (!project) return null;

  const idx = getChapterIndex(project, frame);
  const currentChapter = project.chapters[idx];
  const prevChapter = idx > 0 ? project.chapters[idx - 1] : null;

  // 进入本节的转场
  const transition = currentChapter.transition;
  const tDur = transition?.duration ?? 0;
  const tStart = currentChapter.startFrame;
  const active =
    !!transition && transition.type !== 'cut' && tDur > 0 && frame >= tStart && frame < tStart + tDur;
  const progress = active ? clamp01((frame - tStart) / tDur) : 1;

  const ts = buildTransition(transition?.type, progress);
  const maskOpacity = ts.maskColor ? clamp01(1 - progress) : 0;
  // 前章画面定格在其结束态（章节内容已动画完毕，便于整体淡出/扫出）
  const prevFrame = prevChapter ? Math.min(frame, prevChapter.endFrame) : 0;

  return (
    <AbsoluteFill style={{ backgroundColor: '#222230', overflow: 'hidden' }}>
      {/* 前章画面：仅转场期间渲染，淡出/移出 */}
      {active && ts.showPrevious && prevChapter && (
        <AbsoluteFill style={{ zIndex: 1, opacity: ts.outgoing.opacity ?? 1 }}>
          <MapScene chapter={prevChapter} project={project} frame={prevFrame} />
          <OverlayRenderer overlays={prevChapter.overlays || []} frame={prevFrame} />
        </AbsoluteFill>
      )}

      {/* 本章画面：套用进入转场（淡入/擦拭/缩放/遮罩显露） */}
      <AbsoluteFill style={{ zIndex: 2, overflow: 'hidden', ...ts.incoming }}>
        <MapScene chapter={currentChapter} project={project} realtimeKey={undefined} frame={frame} />
        <OverlayRenderer overlays={currentChapter.overlays || []} frame={frame} />
      </AbsoluteFill>

      {/* 黑/白场遮罩：逐渐淡出以露出本章画面（置于最上层，覆盖标题与场景） */}
      {ts.maskColor && maskOpacity > 0 && (
        <AbsoluteFill
          style={{ zIndex: 10, backgroundColor: ts.maskColor, opacity: maskOpacity, pointerEvents: 'none' }}
        />
      )}

      {/* 章节标题 */}
      {currentChapter.title && (
        <AbsoluteFill
          style={{ zIndex: 4, justifyContent: 'flex-end', alignItems: 'flex-start', padding: 60 }}
        >
          <div
            style={{
              background: 'rgba(0,0,0,0.6)',
              padding: '12px 24px',
              borderRadius: 8,
              opacity: active ? progress : 1,
            }}
          >
            <div style={{ color: '#fff', fontSize: 36, fontWeight: 'bold' }}>
              {currentChapter.title}
            </div>
            {currentChapter.subtitle && (
              <div style={{ color: '#ccc', fontSize: 20, marginTop: 4 }}>
                {currentChapter.subtitle}
              </div>
            )}
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
