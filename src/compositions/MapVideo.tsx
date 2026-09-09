import { AbsoluteFill, Audio, Loop, Sequence, useCurrentFrame } from 'remotion';
import { MapScene } from './MapScene';
import { useProjectStore } from '../stores/projectStore';
import { OverlayRenderer } from './OverlayRenderer';
import { ChapterTitleView, ScreenFxLayer, SubtitleLayer } from '../components/fx/FxRender';
import { screenFxCombinedAt } from '../lib/screenfx';
import { buildTransition, clamp01 } from './transition';
import type { MapVideoProject, MusicTrack, NarrationEntry } from '../types';

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

/** 音频音量包络：BGM 淡入/淡出（相对帧 → 0..1） */
function musicVolumeAt(track: MusicTrack, localFrame: number, fps: number): number {
  const fadeInF = Math.max(1, Math.round((track.fadeIn || 0) * fps));
  const fadeOutF = Math.max(1, Math.round((track.fadeOut || 0) * fps));
  const inV = fadeInF > 1 ? Math.min(1, localFrame / fadeInF) : 1;
  const outV = fadeOutF > 1 ? Math.min(1, (track.endFrame - track.startFrame - localFrame) / fadeOutF) : 1;
  return (track.volume ?? 0.6) * Math.min(inV, outV);
}

/** 配音音量包络：进出各 5 帧微淡，避免爆音 */
function narrationVolumeAt(localFrame: number): number {
  return Math.min(1, localFrame / 5, 1);
}

/** 章/项目音频轨：配音按条摆放；BGM 用 Loop 循环至区间结束（Remotion 内联音频 → web-renderer 混流） */
export const ChapterAudio: React.FC<{
  chapterStart: number;
  narrationEntries: NarrationEntry[];
  music: MusicTrack[];
  fps: number;
}> = ({ chapterStart, narrationEntries, music, fps }) => {
  return (
    <>
      {narrationEntries.map((e) =>
        e.audioUrl && e.durationFrames > 0 ? (
          <Sequence key={`nar-${e.id}`} from={e.startFrame} durationInFrames={e.durationFrames} name={`narration-${e.id}`}>
            <Audio src={e.audioUrl} volume={(f) => narrationVolumeAt(f)} />
          </Sequence>
        ) : null
      )}
      {music.map((m) => {
        const len = Math.max(1, m.endFrame - m.startFrame);
        return (
          <Sequence key={`mus-${m.id}`} from={chapterStart + m.startFrame} durationInFrames={len} name={`music-${m.id}`}>
            <Loop durationInFrames={len}>
              <Audio src={m.url} volume={(f) => musicVolumeAt(m, f, fps)} />
            </Loop>
          </Sequence>
        );
      })}
    </>
  );
};

export const MapVideo: React.FC<MapVideoProps> = ({ projectId: _projectId, project: propProject }) => {
  const frame = useCurrentFrame();
  const fps = useProjectStore((s) => s.project?.globalConfig.defaultFPS) ?? 30;
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

  // 本章画面特效（震动作用于整个画面容器；其余为叠加层）
  const shake = screenFxCombinedAt(currentChapter.fx, frame, fps).shake;

  return (
    <AbsoluteFill style={{ backgroundColor: '#222230', overflow: 'hidden' }}>
      {/* 前章画面：仅转场期间渲染，淡出/移出 */}
      {active && ts.showPrevious && prevChapter && (
        <AbsoluteFill style={{ zIndex: 1, opacity: ts.outgoing.opacity ?? 1 }}>
          <MapScene chapter={prevChapter} project={project} frame={prevFrame} />
          <OverlayRenderer overlays={prevChapter.overlays || []} frame={prevFrame} />
        </AbsoluteFill>
      )}

      {/* 本章画面：套用进入转场（淡入/擦拭/缩放/遮罩显露）+ 特效震动 */}
      <AbsoluteFill style={{ zIndex: 2, overflow: 'hidden', ...ts.incoming }}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            transform: shake ? `translate(${shake.x}px, ${shake.y}px)` : undefined,
          }}
        >
          <MapScene chapter={currentChapter} project={project} realtimeKey={undefined} frame={frame} />
          <OverlayRenderer overlays={currentChapter.overlays || []} frame={frame} />
          <ChapterTitleView chapter={currentChapter} frame={frame} />
          <SubtitleLayer narration={currentChapter.narration} frame={frame - currentChapter.startFrame} fps={fps} />
        </div>
        {/* 屏幕特效层（天气/云层/闪光/暗角/黑白场）不受震动影响 */}
        <ScreenFxLayer fxList={currentChapter.fx} frame={frame} fps={fps} />
      </AbsoluteFill>

      {/* 音频轨：配音 + 背景音乐（Remotion 内联音频，导出时混流） */}
      <ChapterAudio
        chapterStart={currentChapter.startFrame}
        narrationEntries={currentChapter.narration?.entries || []}
        music={currentChapter.music || []}
        fps={fps}
      />

      {/* 黑/白场遮罩：逐渐淡出以露出本章画面（置于最上层，覆盖标题与场景） */}
      {ts.maskColor && maskOpacity > 0 && (
        <AbsoluteFill
          style={{ zIndex: 100, backgroundColor: ts.maskColor, opacity: maskOpacity, pointerEvents: 'none' }}
        />
      )}
    </AbsoluteFill>
  );
};
