import { renderMediaOnWeb, canRenderMediaOnWeb, type WebRendererContainer, type WebRendererVideoCodec } from '@remotion/web-renderer';
import { MapVideo } from '../compositions/MapVideo';
import type { MapVideoProject } from '../types';
import { calculateTotalDuration } from './keyframe-interpolation';

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

/** 常用导出画幅预设 */
export const EXPORT_PRESETS = [
  { label: '1080p 横屏 (16:9)', width: 1920, height: 1080 },
  { label: '竖屏 (9:16)', width: 1080, height: 1920 },
  { label: '方形 (1:1)', width: 1080, height: 1080 },
  { label: '720p 横屏', width: 1280, height: 720 },
  { label: '4K 横屏', width: 3840, height: 2160 },
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

  const totalFrames = calculateTotalDuration(project.chapters);
  const fps = options.fps ?? project.globalConfig.defaultFPS;
  const width = options.width ?? project.globalConfig.defaultResolution.width;
  const height = options.height ?? project.globalConfig.defaultResolution.height;

  const composition = {
    component: MapVideo,
    id: 'MapVideo',
    width,
    height,
    fps,
    durationInFrames: Math.max(1, totalFrames),
    defaultProps: { projectId: project.id } as Record<string, unknown>,
  };

  // 传递项目快照到 composition，避免依赖外部 store
  const result = await renderMediaOnWeb({
    composition,
    inputProps: { projectId: project.id, project } as Record<string, unknown>,
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
