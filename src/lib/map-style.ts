/**
 * map-style.ts — 底图 + 高程合并为 MapLibre style
 *
 * 编辑端（EditableMap）与导出端（MapScene）**必须共用这一个实现**：
 * 此前两端各写了一份 `getStyleUrl`，已经出现漂移（编辑端多一个 `elevation.url` 判断），
 * 导致「编辑器里看到的底图/地形」与「导出视频里的」可能不一致。
 */
import type { StyleSpecification } from 'maplibre-gl';
import type { MapVideoProject, Chapter } from '../types';

const EMPTY_STYLE: StyleSpecification = { version: 8, sources: {}, layers: [] };

export function getStyleUrl(project: MapVideoProject, chapter: Chapter): string | StyleSpecification {
  const activeId = chapter.baseMapId || project.activeBaseMapId;
  const baseMap = project.baseMaps.find((b) => b.id === activeId);
  const style = baseMap?.style;
  if (!style) return EMPTY_STYLE;
  if (typeof style === 'string') return style;

  const elevId = chapter.elevationMapId !== undefined ? chapter.elevationMapId : project.activeElevationMapId;
  const elevation = project.elevationMaps.find((e) => e.id === elevId && e.url);
  if (!elevation?.url || style.sources?.elevation) return style;

  return {
    ...style,
    sources: {
      ...(style.sources || {}),
      elevation: {
        type: 'raster-dem',
        tiles: [elevation.url],
        tileSize: 256,
        encoding: elevation.encoding || 'terrarium',
      },
    },
    // 必须用 ?? 而不是 ||：exaggeration = 0（完全平坦）是**合法有效值**，
    // 用 || 会把 0 当作「未设置」回退成 1.5 —— 表现为「设了 0 却仍有地形起伏」。
    terrain: { source: 'elevation', exaggeration: elevation.exaggeration ?? 1.5 },
  } as StyleSpecification;
}
