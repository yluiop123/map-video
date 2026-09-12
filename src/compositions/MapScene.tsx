import { useEffect, useRef, useState } from 'react';
import { AbsoluteFill, useDelayRender, useVideoConfig, useCurrentFrame } from 'remotion';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { renderElements, setCustomSymbols, setRenderFps, resolveFollowCam, resolveOrbitCam } from '../lib/map-renderer';
import { interpolateCamera, resolveKfIndex } from '../lib/keyframe-interpolation';
import { getAssetUrl, getAssetBytes } from '../lib/assets';
import { getStyleUrl } from '../lib/map-style';
import type { Chapter, MapVideoProject, MapElement } from '../types';

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
        // 投影按章节绑定，缺省继承项目默认
        if (((chapter.projection ?? project.globalConfig.projection) ?? 'mercator') === 'globe') {
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

  /**
   * 预加载异步资源：Remotion 会乱序渲染帧，GIF 解码 / 图片加载 / 模型解析若未完成，
   * 先渲染的帧会拿到 1×1 占位图，且结果依赖渲染时序（非确定性）。
   * 编辑端有 setVisualReady 重渲染兜底，导出端必须在这里等齐再放行。
   */
  useEffect(() => {
    const media = chapter.elements.filter(
      (el) => el.type === 'point' && el.assetId && (el.shape === 'image' || el.shape === 'gif' || el.shape === 'model')
    ) as unknown as Array<MapElement & { assetId: string; shape: string }>;
    if (!media.length) return;
    const h = delayRender('Loading media assets...');
    void Promise.all(media.map(async (el) => {
      const url = await getAssetUrl(el.assetId);
      if (!url) return;
      if (el.shape === 'image') {
        await new Promise<void>((res) => {
          const img = new Image();
          img.onload = () => res();
          img.onerror = () => res();   // 坏图不阻塞渲染
          img.src = url;
        });
      } else if (el.shape === 'gif') {
        const { decodeGifCached } = await import('../lib/gif-decoder');
        // key 必须与渲染端一致（assetId），否则预热的是另一份缓存白等
        await decodeGifCached(el.assetId, async () => {
          const bytes = await getAssetBytes(el.assetId);
          if (!bytes) return null;
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        });
      } else {
        const { preloadModelAssets } = await import('../lib/model-renderer');
        await preloadModelAssets([url]);
      }
    })).finally(() => continueRender(h));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter.elements, delayRender, continueRender]);

  // 帧更新：相机 + 元素
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const h = delayRender('Rendering frame...');
    setCustomSymbols([]);
    setRenderFps(fps);   // GIF 逐帧 / 模型自转的时间基准（双端一致）

    // 无论渲染成功与否都必须放行 continueRender：否则一次异常 / idle 不来 → 整次导出永久挂起
    let settled = false;
    let bail: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (settled) return;          // continueRender 只允许放行一次
      settled = true;
      clearTimeout(bail);
      continueRender(h);
    };

    try {
      if (chapter.camera && chapter.camera.length > 0) {
        const cam = interpolateCamera(chapter.camera, frame, fps);
        let jc = { center: cam.center, zoom: cam.zoom, pitch: cam.pitch || 0, bearing: cam.bearing || 0 };
        const kfs = [...chapter.camera].sort((a, b) => a.frame - b.frame);
        const kfIdx = resolveKfIndex(kfs, frame, fps);   // 与编辑端共用同一归属算法，避免预览≠导出
        const kf = kfs[Math.max(0, kfIdx)];
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
    } catch (err) {
      console.error('[MapScene] render failed:', err);
    }

    map.once('idle', finish);
    // 兜底：离线瓦片 / 资源缺失时 idle 可能永远不来，超时强制放行
    bail = setTimeout(finish, 3000);
    map.triggerRepaint();
    return () => clearTimeout(bail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, chapter, fps, delayRender, continueRender]);

  return (
    <AbsoluteFill>
      <div ref={ref} style={{ width, height, position: 'absolute' }} />
    </AbsoluteFill>
  );
};

// 注：底图 + 高程的 style 解析已抽到 lib/map-style.ts，由编辑端与导出端共用
// （此前两端各写一份 getStyleUrl 并已漂移）。
