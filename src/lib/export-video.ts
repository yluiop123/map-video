import { renderMediaOnWeb, canRenderMediaOnWeb, type WebRendererContainer, type WebRendererVideoCodec, type WebRendererAudioCodec } from '@remotion/web-renderer';
import { MapVideo } from '../compositions/MapVideo';
import type { MapVideoProject } from '../types';
import { projectContentDuration } from './project-duration';
import { getAssetUrl } from './assets';

export interface ExportOptions {
  project: MapVideoProject;
  container?: WebRendererContainer;
  videoCodec?: WebRendererVideoCodec | null;
  /** 导出覆盖项：不传则用项目全局配置 */
  width?: number;
  height?: number;
  fps?: number;
  onProgress?: (progress: number) => void;
  onArtifact?: (artifact: unknown) => void;
  signal?: AbortSignal;
}

/**
 * 导出前把音频 assetId 一次性水合成可播放地址：项目里只有 id，
 * 而 Remotion 的 <Audio> 要 src，组件本身不等异步（保持每帧确定性）。
 */
async function hydrateAudioSrc(project: MapVideoProject): Promise<Record<string, string>> {
  const ids = new Set<string>();
  for (const e of project.narration?.entries ?? []) if (e.audioId) ids.add(e.audioId);
  for (const m of project.music ?? []) if (m.audioId) ids.add(m.audioId);
  const out: Record<string, string> = {};
  for (const id of ids) {
    const url = await getAssetUrl(id);
    if (url) out[id] = url;
  }
  return out;
}

/** 常用导出画幅预设 */
export const EXPORT_PRESETS = [
  { label: '1080p 横屏 (16:9)', width: 1920, height: 1080 },
  { label: '竖屏 (9:16)', width: 1080, height: 1920 },
  { label: '方形 (1:1)', width: 1080, height: 1080 },
] as const;

export async function checkExportSupport(
  project: MapVideoProject,
  width?: number,
  height?: number
): Promise<boolean> {
  try {
    const w = width ?? project.globalConfig.defaultResolution.width;
    const h = height ?? project.globalConfig.defaultResolution.height;
    const result = await canRenderMediaOnWeb({ width: w, height: h, container: 'mp4', muted: true });
    return result.canRender;
  } catch {
    return false;
  }
}

export async function exportVideo(options: ExportOptions): Promise<Blob> {
  const { project, container, videoCodec, onProgress, onArtifact, signal } = options;

  // 导出长度按「内容实际结束帧」算，而不是容器 endFrame（可留白/定格）
  const totalFrames = projectContentDuration([project]);
  const fps = options.fps ?? project.globalConfig.defaultFPS;
  const width = options.width ?? project.globalConfig.defaultResolution.width;
  const height = options.height ?? project.globalConfig.defaultResolution.height;

  const audioSrc = await hydrateAudioSrc(project);

  const composition = {
    component: MapVideo,
    id: 'MapVideo',
    width,
    height,
    fps,
    durationInFrames: Math.max(1, totalFrames),
    defaultProps: { projectId: project.id, audioSrc } as Record<string, unknown>,
  };

  // 传递项目快照到 composition，避免依赖外部 store
  const result = await renderMediaOnWeb({
    composition,
    inputProps: { projectId: project.id, project, audioSrc } as Record<string, unknown>,
    container: container ?? 'mp4',
    videoCodec: videoCodec ?? null,
    onProgress: (p) => {
      if (onProgress) onProgress(p.progress);
    },
    onArtifact: (artifact) => {
      if (onArtifact) onArtifact(artifact);
    },
    signal: signal ?? null,
    hardwareAcceleration: 'no-preference',
    isProduction: true,
    logLevel: 'warn',
    // 音频混流：composition 内 <Audio>（配音/BGM）经 remotion TRenderAsset 收集后由 mediabunny 编码进 MP4
    muted: false,
    audioCodec: 'aac' as WebRendererAudioCodec,
    sampleRate: 48000,
  });

  return await result.getBlob();
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
