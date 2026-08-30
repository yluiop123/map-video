import { useEffect, useRef, useState } from 'react';
import { AbsoluteFill, useDelayRender, useVideoConfig, useCurrentFrame } from 'remotion';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { renderElements, setCustomSymbols, resolveFollowCam, resolveOrbitCam } from '../lib/map-renderer';
import { interpolateCamera } from '../lib/keyframe-interpolation';
import type { Chapter, MapVideoProject } from '../types';

interface MapSceneProps {
  chapter: Chapter;
  project: MapVideoProject;
  realtimeKey?: unknown;
  /** 覆盖帧号（绝对帧）。用于转场时钳制前章画面到其结束态。缺省时用 useCurrentFrame()。 */
  frame?: number;
}

export const MapScene: React.FC<MapSceneProps> = ({ chapter, project, realtimeKey: _realtimeKey, frame: frameOverride }) => {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const { delayRender, continueRender } = useDelayRender();
  const { width, height, fps } = useVideoConfig();
  const frame = frameOverride ?? useCurrentFrame();
  const [handle] = useState(() => delayRender('Loading map...'));

  const styleUrl = getStyleUrl(project, chapter);

  // 初始化地图（只执行一次）
  useEffect(() => {
    if (!ref.current) return;

    const map = new maplibregl.Map({
      container: ref.current,
      style: styleUrl,
      center: [104.0, 35.0],
      zoom: 4,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
    });

    map.on('load', () => {
      mapRef.current = map;
      try {
        if ((project.globalConfig.projection ?? 'mercator') === 'globe') {
          map.setProjection({ type: 'globe' });
        }
      } catch { /* */ }
      map.once('idle', () => continueRender(handle));
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleUrl, handle, continueRender]);

  // 帧更新：相机 + 元素
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const h = delayRender('Rendering frame...');
    setCustomSymbols(project.customSymbols);

    if (chapter.camera && chapter.camera.length > 0) {
      const cam = interpolateCamera(chapter.camera, frame, fps);
      let jc = { center: cam.center, zoom: cam.zoom, pitch: cam.pitch || 0, bearing: cam.bearing || 0 };
      const kfs = [...chapter.camera].sort((a, b) => a.frame - b.frame);
      let kfIdx = kfs.length - 1;
      for (let i = 0; i < kfs.length - 1; i++) {
        const next = kfs[i + 1];
        const gap = Math.max(0, next.frame - kfs[i].frame);
        const move = typeof next.moveDuration === 'number' ? Math.min(next.moveDuration, gap) : Math.min(2 * fps, gap);
        if (frame < next.frame - move) { kfIdx = i; break; }
        if (frame <= next.frame) { kfIdx = i + 1; break; }
      }
      const kf = kfs[Math.min(kfIdx, kfs.length - 1)];
      if (kf?.followRoute) {
        const fc = resolveFollowCam(chapter.elements, kf, frame);
        if (fc) jc = fc;
      } else if (kf?.orbit) {
        const oc = resolveOrbitCam(kf, frame, fps);
        if (oc) jc = oc;
      }
      map.jumpTo(jc);
    }

    renderElements(map, chapter.elements, frame, fps);

    map.once('idle', () => continueRender(h));
    map.triggerRepaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, chapter, fps, delayRender, continueRender]);

  return (
    <AbsoluteFill>
      <div ref={ref} style={{ width, height, position: 'absolute' }} />
    </AbsoluteFill>
  );
};

// ========== 样式解析（含高程） ==========

function getStyleUrl(project: MapVideoProject, chapter: Chapter): any {
  const activeId = chapter.baseMapId || project.activeBaseMapId;
  const baseMap = project.baseMaps.find((b) => b.id === activeId);
  const style = baseMap?.style as any;
  if (typeof style === 'string') return style;

  let styleObj = style;
  if (typeof styleObj !== 'string' && styleObj) {
    const elevId = chapter.elevationMapId !== undefined ? chapter.elevationMapId : project.activeElevationMapId;
    const elevation = project.elevationMaps.find((e) => e.id === elevId && e.url);
    if (elevation && !styleObj.sources?.elevation) {
      styleObj = {
        ...styleObj,
        sources: {
          ...(styleObj.sources || {}),
          elevation: {
            type: 'raster-dem',
            tiles: [elevation.url],
            tileSize: 256,
            encoding: elevation.encoding || 'terrarium',
          },
        },
        terrain: { source: 'elevation', exaggeration: elevation.exaggeration || 1.5 },
      };
    }
  }
  return styleObj;
}
