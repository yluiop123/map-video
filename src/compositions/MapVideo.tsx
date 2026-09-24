import { AbsoluteFill, Audio, Loop, Sequence, useCurrentFrame } from 'remotion';
import { MapScene } from './MapScene';
import { useProjectStore } from '../stores/projectStore';
import { OverlayRenderer } from './OverlayRenderer';
import { ScreenFxLayer, SubtitleLayer } from '../components/fx/FxRender';
import { screenFxCombinedAt } from '../lib/screenfx';
import type { MapVideoProject, MusicTrack, NarrationEntry } from '../types';

interface MapVideoProps {
  projectId?: string;
  project?: MapVideoProject;
  /**
   * 音频 assetId → 可播放地址，由导出入口一次水合后传进来。
   * 项目数据里只有 id（字节在 asset 表 / 素材库），而 Remotion 组件要保持纯渲染 ——
   * 不等异步、不读库，所以地址只能从外面给。
   */
  audioSrc?: Record<string, string>;
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

/** 配音轨：按条摆放（Remotion 内联音频 → web-renderer 混流） */
export const NarrationAudio: React.FC<{
  narrationEntries: NarrationEntry[];
  audioSrc: Record<string, string>;
}> = ({ narrationEntries, audioSrc }) => {
  return (
    <>
      {narrationEntries.map((e) =>
        e.audioId && audioSrc[e.audioId] && e.durationFrames > 0 ? (
          <Sequence key={`nar-${e.id}`} from={e.startFrame} durationInFrames={e.durationFrames} name={`narration-${e.id}`}>
            <Audio src={audioSrc[e.audioId]} volume={(f) => narrationVolumeAt(f)} />
          </Sequence>
        ) : null
      )}
    </>
  );
};

/** 项目级背景音乐轨：单轨多段（项目绝对帧），段内用 Loop 循环至段末 */
export const ProjectMusic: React.FC<{
  music: MusicTrack[];
  fps: number;
  audioSrc: Record<string, string>;
}> = ({ music, fps, audioSrc }) => {
  return (
    <>
      {music.map((m) => {
        const src = audioSrc[m.audioId];
        if (!src) return null;
        const len = Math.max(1, m.endFrame - m.startFrame);
        return (
          <Sequence key={`mus-${m.id}`} from={m.startFrame} durationInFrames={len} name={`music-${m.id}`}>
            <Loop durationInFrames={len}>
              <Audio src={src} volume={(f) => musicVolumeAt(m, f, fps)} />
            </Loop>
          </Sequence>
        );
      })}
    </>
  );
};

/** 单条连续时间线渲染：地图 + 弹窗 + 字幕 + 屏幕特效 */
export const MapVideo: React.FC<MapVideoProps> = ({ projectId: _projectId, project: propProject, audioSrc = {} }) => {
  const frame = useCurrentFrame();
  const fps = useProjectStore((s) => s.project?.globalConfig.defaultFPS) ?? 30;
  const storeProject = useProjectStore((s) => s.project);
  const project = propProject || storeProject;

  if (!project) return null;

  const shake = screenFxCombinedAt(project.fx, frame, fps).shake;

  return (
    <AbsoluteFill style={{ backgroundColor: '#222230', overflow: 'hidden' }}>
      <AbsoluteFill style={{ zIndex: 2, overflow: 'hidden' }}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            transform: shake ? `translate(${shake.x}px, ${shake.y}px)` : undefined,
          }}
        >
          <MapScene chapter={project} project={project} realtimeKey={undefined} frame={frame} />
          <OverlayRenderer overlays={project.overlays || []} frame={frame} />
          <SubtitleLayer narration={project.narration} frame={frame} fps={fps} />
        </div>
        {/* 屏幕特效层（天气/云层/闪光/暗角/黑白场）不受震动影响 */}
        <ScreenFxLayer fxList={project.fx} frame={frame} fps={fps} />
      </AbsoluteFill>

      {/* 音频轨：配音（绝对帧）+ 项目级背景音乐 */}
      <NarrationAudio narrationEntries={project.narration?.entries || []} audioSrc={audioSrc} />
      <ProjectMusic music={project.music || []} fps={fps} audioSrc={audioSrc} />
    </AbsoluteFill>
  );
};
