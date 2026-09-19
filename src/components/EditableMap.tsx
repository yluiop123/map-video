import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { Camera, RotateCcw, ChevronDown } from 'lucide-react';
import { useConfirm } from './ui/ConfirmHost';
import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as turf from '@turf/turf';
import {
  renderElements, restackByLayerOrder, setRenderFps, setVisualReadyHandler,
  buildArrowGeometry, buildSelectionFeature, pixelsToDegrees, rotatePt, resolveFollowCam, resolveOrbitCam,
} from '../lib/map-renderer';
import { buildDoubleArrow, buildGatheringPlace } from '../lib/military-plots';
import { pickFlyRibbon } from '../lib/fly-ribbon';
import { interpolateCamera, getEasing, interpolateKeyframes, interpolatePath, resolveKfIndex } from '../lib/keyframe-interpolation';
import { getStyleUrl } from '../lib/map-style';
import { sharedMap } from '../lib/shared-map';
import { findRegionsAt, loadRegionData, regionHitsToShapes } from '../lib/regions';
import { useProjectStore, setHistoryMuted, snapshotHistory } from '../stores/projectStore';
import { useInteractionStore } from '../stores/interactionStore';
import { useEditorStore } from '../stores/editorStore';
import { generateId } from '../types';
import { defaultVisualFor } from '../lib/pin-visual';
import { defaultTerritoryDisplay, coordKey, distToRingBoundary, insertRingVertex, moveSharedVertices, removeSharedVertex, ringOpen, traceRingPath, trimPlotOverlap, splitPlotByLine } from '../lib/territory';
import type {
  MapVideoProject, MapElement, PointElement, PointShape,
  MovingPointElement, LineElement, PolygonElement, ArrowElement, DoubleArrowElement,
  EncirclementElement, GatheringElement, FlagElement, CameraKeyframe, TerritoryElement
} from '../types';

interface EditableMapProps {
  project: MapVideoProject;
  currentFrame: number;
}

const DRAW_MODES = ['add_moving_line', 'add_moving_bezier', 'add_line', 'add_bezier', 'add_line_arc', 'add_polygon', 'add_rect', 'add_arrow', 'add_curved', 'add_attack', 'add_pincer', 'add_encirclement', 'add_gathering', 'add_shape_line', 'add_shape_bezier', 'add_shape_line_arrow', 'add_shape_bezier_arrow', 'add_shape_march', 'add_shape_swallowtail', 'add_shape_circle', 'add_shape_star', 'add_special_swallow', 'add_shape_front_line', 'add_shape_front_curve', 'add_shape_poly_curve', 'add_shape_poly_defend', 'add_shape_poly_curve_defend', 'add_terr_plot', 'terr_split', 'terr_annex'];

const POLY_DRAW_MODES = new Set(['add_polygon', 'add_shape_poly_curve', 'add_shape_poly_defend', 'add_shape_poly_curve_defend', 'add_terr_plot']);
const LINE_PREVIEW_MODES = new Set(['add_line', 'add_bezier', 'add_moving_line', 'add_moving_bezier', 'add_shape_line', 'add_shape_bezier', 'add_shape_line_arrow', 'add_shape_bezier_arrow', 'add_shape_front_line', 'add_shape_front_curve', 'terr_split']);

/** 分割地块模式的光标：剪刀（白描边 + 黑线，保证深浅底图上都清晰） */
const SCISSORS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="#ffffff" stroke-width="5"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></g><g stroke="#111111" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></g></svg>`;
const SCISSORS_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(SCISSORS_SVG)}") 8 8, crosshair`;

export function EditableMap({ project, currentFrame }: EditableMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const cameraRef = useRef({ center: [104.0, 35.0] as [number, number], zoom: 4, pitch: 0, bearing: 0 });
  /** 始终指向最新的事件回调（地图事件在 load 时一次性注册） */
  const handlersRef = useRef<Record<string, any>>({});

  // 绘制状态机
  const drawRef = useRef<{
    points: [number, number][];
    cursor: [number, number] | null;   // 鼠标当前位置（用于橡皮筋预览）
    phase: 'collect' | 'radius';       // collect: 采点；radius: 圆类第二步定半径
    hits: string[];                    // 连线模式命中的元素 id
    marks: (TerrSnap | null)[];        // 疆域绘制：与 points 平行的吸附标记（描幕/T 型分叉用）
  }>({ points: [], cursor: null, phase: 'collect', hits: [], marks: [] });

  const addElement = useProjectStore((s) => s.addElement);
  const addElements = useProjectStore((s) => s.addElements);
  const mode = useInteractionStore((s) => s.mode);
  const selectElement = useEditorStore((s) => s.selectElement);
  const selectedElementId = useEditorStore((s) => s.selectedElementId);
  const setMode = useInteractionStore((s) => s.setMode);
  const [viewSaved, setViewSaved] = useState(false);
  const [viewBarHidden, setViewBarHidden] = useState(false);

  // 渲染帧率注入（GIF 逐帧 / 模型自转基准）
  useEffect(() => {
    setRenderFps(project.globalConfig?.defaultFPS ?? 30);
  }, [project.globalConfig?.defaultFPS]);

  // 稳定 styleUrl 引用：对象样式+高程合并时 getStyleUrl 每次渲染都返回新对象，
  // 若直接作 effect 依赖，地图 move → setCurrentCamera → 重渲染 → 重建地图，无限循环狂闪。
  // 以底图/高程配置的内容签名做 memo，仅在真正切换/修改底图或高程时重建地图。
  const baseMapStyleKey = JSON.stringify(
    project.baseMaps.find((b) => b.id === project.activeBaseMapId)?.style ?? null
  );
  const elevationKey = JSON.stringify(
    project.elevationMaps.find((e) => e.id === project.activeElevationMapId && e.url) ?? null
  );
  const styleUrl = useMemo(
    () => getStyleUrl(project),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseMapStyleKey, elevationKey, project.activeBaseMapId, project.activeElevationMapId]
  );

  // ===== 初始化地图 =====
  useEffect(() => {
    if (!containerRef.current) return;

    // 切换底图/高程时保留当前相机位置
    const prevCam = cameraRef.current;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleUrl,
      center: prevCam.center,
      zoom: prevCam.zoom,
      pitch: prevCam.pitch,
      bearing: prevCam.bearing,
      attributionControl: false,
      fadeDuration: 0,
    });

    // 立即注册实例：个别瓦片/字形解码失败会阻止 'load' 触发，若等 load 再赋值，
    // 一键放置等依赖 mapRef 的功能会静默失效（getCenter 等在 load 前即可用）
    mapRef.current = map;
    sharedMap.set(map);

    // 外部瓦片源（卫星图/DEM）放大时会间歇性返回不完整/损坏的图片，
    // MapLibre 解码失败抛 InvalidStateError（The source image could not be decoded）。
    // 该瓦片本身会被跳过、重试即可恢复，降级为警告避免打断渲染/污染控制台。
    map.on('error', (e: any) => {
      const msg = String(e?.error?.message || e?.message || '');
      if (/could not be decoded|failed to decode|Failed to fetch|NetworkError|aborted/i.test(msg)) {
        console.warn('[map] 瓦片加载/解码失败（已跳过，可重试）:', msg);
        return;
      }
      console.error('[map]', e?.error || e);
    });

    map.on('load', () => {
      mapRef.current = map;
      sharedMap.set(map);
      setStyleTick((n) => n + 1);
      if (project.camera && project.camera.length > 0 && prevCam.zoom === 4 && prevCam.center[0] === 104) {
        const cam = project.camera[0];
        map.jumpTo({ center: cam.center, zoom: cam.zoom, pitch: cam.pitch || 0, bearing: cam.bearing || 0 });
      }
      // 3D 球体投影（读全局配置最新值，避免闭包过期）
      const st = useProjectStore.getState();
      applyProjection(map, ((st.project?.globalConfig.projection) ?? 'mercator') === 'globe');
      // 元素刷新
      // 编辑端：传 interactive=true（绘制编辑辅助图形；导出端 MapScene 不传）
      renderElements(map, project.elements, currentFrame, project.globalConfig.defaultFPS, true);
      // 列表顺序 = 地图叠放顺序（靠前的在上层）
      restackByLayerOrder(map, project.elements.map((el) => el.id));

      // ===== 地图事件注册（一次性；回调经 handlersRef 取最新） =====
      const H = () => handlersRef.current;
      const onMouseMoveMap = (e: any) => H().handleHover?.(e);
      const onMouseOutMap = () => H().handleHoverOut?.();
      const onMouseDownMap = (e: any) => H().handleMouseDown?.(e);
      const onClickMap = (e: any) => H().handleClick?.(e);
      const onDblClickMap = (e: any) => H().handleDblClick?.(e);
      const onContextMenuMap = (e: any) => H().handleContextMenu?.(e);
      const onWinMove = (e: MouseEvent) => H().handleWindowMouseMove?.(e);
      const onWinUp = () => H().handleWindowMouseUp?.();
      const onMoveEndMap = () => H().handleMoveEnd?.();
      map.on('mousemove', onMouseMoveMap);
      map.on('mouseout', onMouseOutMap);
      map.on('mousedown', onMouseDownMap);
      map.on('click', onClickMap);
      map.on('dblclick', onDblClickMap);
      map.on('contextmenu', onContextMenuMap);
      window.addEventListener('mousemove', onWinMove);
      window.addEventListener('mouseup', onWinUp);
      map.on('moveend', onMoveEndMap);
      (map as any).__mvHandlers = { onMouseMoveMap, onMouseOutMap, onMouseDownMap, onClickMap, onDblClickMap, onContextMenuMap, onWinMove, onWinUp, onMoveEndMap };
    });
    map.on('move', () => {
      const c = map.getCenter();
      const cam = {
        center: [c.lng, c.lat] as [number, number],
        zoom: map.getZoom(),
        pitch: map.getPitch(),
        bearing: map.getBearing(),
      };
      cameraRef.current = cam;
      useEditorStore.getState().setCurrentCamera(cam);
    });

    return () => {
      const h = (map as any).__mvHandlers;
      if (h) {
        map.off('mousemove', h.onMouseMoveMap);
        map.off('mouseout', h.onMouseOutMap);
        map.off('mousedown', h.onMouseDownMap);
        map.off('click', h.onClickMap);
        map.off('dblclick', h.onDblClickMap);
        map.off('contextmenu', h.onContextMenuMap);
        window.removeEventListener('mousemove', h.onWinMove);
        window.removeEventListener('mouseup', h.onWinUp);
        map.off('moveend', h.onMoveEndMap);
      }
      map.remove();
      mapRef.current = null;
      sharedMap.set(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleUrl]);

  // ===== 一键放置（Mapimator 式：点工具即落图中心，再拖拽微调） =====
  const pendingPlace = useInteractionStore((s) => s.pendingPlace);
  useEffect(() => {
    const map = mapRef.current;
    if (!pendingPlace || !map) return;
    const c = map.getCenter();
    const lngLat: [number, number] = [c.lng, c.lat];
    const kind = pendingPlace.kind;

    let el: MapElement | null = null;
    if (kind === 'pin') {
      const s = pendingPlace.pinStyle ?? 'pin';
      const base = {
        id: generateId(), visible: true, locked: false,
        startFrame: 0, endFrame: project.endFrame, style: {},
        coordinates: lngLat,
      };
      if (s === 'flag') {
        el = {
          ...base, type: 'flag', name: '旗帜', text: '旗',
          flagColor: '#E23B3B', textColor: '#FFFFFF', fontSize: 28, flagWidth: 216, scale: 1,
        } as FlagElement;
      } else if (s === 'text') {
        el = {
          ...base, type: 'point', name: '文字标记', shape: 'text', iconSize: 0, color: '#FF4444',
          label: { text: '文字', fontSize: 14, color: '#000000', position: 'center', bgColor: '#FFFFFF', bgPadding: 3, bgRadius: 3, fontWeight: 'bold' },
        } as PointElement;
      } else if (s === 'bubble' || s === 'emoji') {
        el = {
          ...base, type: 'point', name: s === 'bubble' ? '气泡标记' : '表情标记', shape: s, iconSize: 10, color: '#FF4444',
          ...(s === 'emoji' ? { emoji: '📍' } : {}),
          // 气泡默认标签（白底黑字）与渲染端 renderPoint 的默认一致，避免面板/实际不符
          ...(s === 'bubble' ? { label: { text: '气泡', fontSize: 13, color: '#000000', position: 'center', bgColor: '#FFFFFF', bgPadding: 8, bgRadius: 6 } } : {}),
        } as PointElement;
      } else if (s === 'image' || s === 'gif' || s === 'model' || s === 'icon' || s === 'milsym') {
        // 资源形态：交给能力矩阵补默认值（军标 = milsymbol 生成，符号图 builtinId 'milsym:<SIDC>'）
        const visual = defaultVisualFor(s === 'milsym' ? 'military_symbol' : (s as unknown as PointShape), { coordinates: lngLat } as PointElement);
        const nameOf = { image: '图片标记', gif: '动图标记', model: '模型标记', icon: '图标标记', milsym: '军标' } as const;
        el = { ...base, type: 'point', name: nameOf[s], color: '#FF4444', iconSize: 10, ...visual } as PointElement;
      } else {
        el = {
          ...base, type: 'point', name: '标记点', color: '#FF4444', iconSize: 10, shape: 'pin',
          label: { text: '标记点', fontSize: 13, color: '#000000', position: 'top', bgColor: '#FFFFFF', bgPadding: 6, bgRadius: 6 },
        } as PointElement;
      }
    } else if (kind === 'territory') {
      el = {
        id: generateId(), type: 'territory', name: '疆域', visible: true, locked: false,
        startFrame: 0, endFrame: project.endFrame, style: {},
        countries: [{ id: generateId(), name: '势力1', color: '#E23B3B' }],
        plots: [], events: [], display: defaultTerritoryDisplay(),
      } as TerritoryElement;
    }

    if (el) {
      addElement(el);
      selectElement(el.id);
      focusHostOf(el.id);
    }
    useInteractionStore.getState().clearPendingPlace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPlace?.ts]);

  // 进入行政区模式时预加载边界数据
  useEffect(() => {
    if (mode === 'add_region') loadRegionData().catch(() => { /* 点击时提示 */ });
  }, [mode]);

  // ===== 3D 球体开关实时切换（投影项目固定） =====
  const globeOn = (project.globalConfig.projection ?? 'mercator') === 'globe';
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    applyProjection(map, globeOn);
  }, [globeOn, styleUrl]);

  const [styleTick, setStyleTick] = useState(0);
  // 资源位图（图片/动图/模型/图标库）首次就绪 → 重跑一次 renderElements，
  // 把图层上的占位图换成真实位图（否则要等下一次元素变更才显示，「点两次」就是这个原因）
  useEffect(() => {
    setVisualReadyHandler(() => setStyleTick((n) => n + 1));
    return () => setVisualReadyHandler(null);
  }, []);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const presenting = useEditorStore((s) => s.presenting);
  const confirm = useConfirm();
  const routeEditMode = useEditorStore((s) => s.routeEdit);
  // ===== 元素刷新 =====
  // 不用 isStyleLoaded 门禁（v5 中它会频繁 false 吞掉逐帧高亮动画）；
  // 样式未就绪时 renderElements 内部 addSource 会抛错，这里 catch 后等下一帧重试。
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      // 编辑端：传 interactive=true（绘制编辑辅助图形；导出端 MapScene 不传）
      renderElements(map, project.elements, currentFrame, project.globalConfig.defaultFPS, true);
      // 列表顺序 = 地图叠放顺序（靠前的在上层）
      restackByLayerOrder(map, project.elements.map((el) => el.id));
    } catch { /* style 未就绪，下一帧重试 */ }
  }, [project, currentFrame, project.globalConfig.defaultFPS, styleTick]);


  // ===== 镜头插值：播放/改帧时应用到镜头关键帧 =====
  // 注意 1：不要用 isStyleLoaded 作门禁——字形/瓦片未就绪时它常为 false，
  //         会把离散跳帧（⏩/点击时间线）的相机更新全部吞掉；jumpTo 不依赖 style。
  // 注意 2：依赖用 project.camera（数组引用）而非 project——否则任何元素属性修改
  //         都会重建 project 对象，把用户手动平移的地图拽回关键帧位置。
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (project.camera && project.camera.length > 0) {
      const kfs = [...project.camera].sort((a, b) => a.frame - b.frame);
      const fps = project.globalConfig.defaultFPS;
      const cam = interpolateCamera(project.camera, currentFrame, fps);
      // 跟随视角：center 动态跟随选中路线的动画进度点，bearing 按切线方向
      let jump = { center: cam.center, zoom: cam.zoom, pitch: cam.pitch || 0, bearing: cam.bearing || 0 };
      const kfIdx = resolveKfIndex(kfs, currentFrame, fps);
      const kf = kfIdx >= 0 ? kfs[Math.min(kfIdx, kfs.length - 1)] : undefined;
      if (kf?.followRoute) {
        const fc = resolveFollowCam(project.elements, kf, currentFrame);
        if (fc) jump = fc;
      } else if (kf?.orbit) {
        const oc = resolveOrbitCam(kf, currentFrame, fps);
        if (oc) jump = oc;
      }
      try {
        map.jumpTo(jump);
      } catch { /* 相机尚未可用 */ }
    }
  }, [currentFrame, project.camera]);

  // ===== 移动点选中：高亮圈跟随移动点（逐帧） =====
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const srcId = 'selection-move';
    const el = project.elements.find((x) => x.id === selectedElementId);
    let coord: [number, number] | null = null;
    if (el && el.type === 'moving_point') {
      const prog = el.pathProgress?.length
        ? (interpolateKeyframes(el.pathProgress, currentFrame) as number)
        : 1;
      coord = interpolatePath(el.path, Math.max(0, Math.min(1, prog)));
    }
    const fc = coord ? turf.featureCollection([turf.point(coord)]) : turf.featureCollection([] as any);
    try {
      if (map.getSource(srcId)) {
        (map.getSource(srcId) as any).setData(fc);
      } else {
        map.addSource(srcId, { type: 'geojson', data: fc } as any);
        map.addLayer({
          id: srcId, type: 'circle', source: srcId,
          paint: {
            'circle-radius': 13,
            'circle-color': '#FFD700',
            'circle-opacity': 0.18,
            'circle-stroke-width': 2.5,
            'circle-stroke-color': '#FFD700',
          },
        });
      }
    } catch { /* style 未就绪：load 后（styleTick）随下一帧重试 */ }
  }, [currentFrame, selectedElementId, project, styleTick]);

  // ===== 兼并模式：已选地块高亮 =====
  const terrSelPlots = useEditorStore((s) => s.terrSelPlots);
  // 编辑目标地块（双击地块/面板「⊙」设置）：变化时刷新顶点标记
  const terrPlotId = useEditorStore((s) => s.terrPlotId);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const srcId = 'terr-sel';
    const feats: any[] = [];
    if (terrSelPlots.length) {
      for (const el of project.elements) {
        if (el.type !== 'territory') continue;
        for (const p of (el as TerritoryElement).plots) {
          if (terrSelPlots.includes(p.id) && p.rings?.[0]?.length >= 4) {
            feats.push(turf.polygon(p.rings as [number, number][][]));
          }
        }
      }
    }
    const fc = turf.featureCollection(feats);
    try {
      if (map.getSource(srcId)) {
        (map.getSource(srcId) as GeoJSONSource).setData(fc);
      } else {
        map.addSource(srcId, { type: 'geojson', data: fc } as any);
        map.addLayer({ id: 'terr-sel-fill', type: 'fill', source: srcId, paint: { 'fill-color': '#FFD700', 'fill-opacity': 0.16 } });
        map.addLayer({ id: 'terr-sel-line', type: 'line', source: srcId, paint: { 'line-color': '#FFD700', 'line-width': 3, 'line-opacity': 0.95 } });
      }
      map.setLayoutProperty('terr-sel-fill', 'visibility', feats.length ? 'visible' : 'none');
      map.setLayoutProperty('terr-sel-line', 'visibility', feats.length ? 'visible' : 'none');
    } catch { /* style 未就绪：styleTick 后重试 */ }
  }, [terrSelPlots, project, styleTick]);

  // ===== 镜头跳转指令（从镜头面板跳到对应视角，沿用关键帧缓动/时长） =====
  const cameraSeek = useEditorStore((s) => s.cameraSeek);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !cameraSeek) return;
    const cam = cameraSeek.cam;
    map.easeTo({
      center: cam.center,
      zoom: cam.zoom,
      pitch: cam.pitch || 0,
      bearing: cam.bearing || 0,
      duration: cameraSeek.duration ?? 1,
      easing: getEasing(cameraSeek.easing || 'linear'),
    });
  }, [cameraSeek]);

  // ===== 绘制模式禁用双击缩放 =====
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (DRAW_MODES.includes(mode)) {
      map.doubleClickZoom.disable();
    } else if (mode === 'select' && project.elements.some((x) => x.type === 'territory')) {
      // 选择模式：双击保留给「编辑地块边界」，禁用双击缩放（滚轮/捏合仍可缩放）
      map.doubleClickZoom.disable();
    } else {
      map.doubleClickZoom.enable();
    }
    // 切换模式一律先隐藏吸附指示圈（避免上次未隐藏时在非绘制态残留蓝色空心圈），
    // 进入 add_terr_plot 后由 mousemove 按需重新显示。
    if (map.getLayer('terr-snap')) {
      map.setLayoutProperty('terr-snap', 'visibility', 'none');
    }
  }, [mode, styleUrl, project]);

  // ===== 重置绘制状态 =====
  const resetDraw = useCallback(() => {
    drawRef.current = { points: [], cursor: null, phase: 'collect', hits: [], marks: [] };
    cleanupPreview(mapRef.current);
    const m0 = mapRef.current;
    if (m0?.getLayer('terr-snap')) m0.setLayoutProperty('terr-snap', 'visibility', 'none');
  }, []);

  // ===== 橡皮筋预览 =====
  const updatePreview = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const { points, cursor } = drawRef.current;
    if (points.length === 0 && !cursor) return;

    const fc: any[] = [];

    // 箭头预览宽度（像素 → 经纬度），保证与最终渲染一致且不随缩放变化
    const ARROW_PX = 15;
    const anchorLat = (points[0]?.[1] ?? cursor?.[1] ?? 35);
    const arrowWidth = pixelsToDegrees(ARROW_PX, map.getZoom(), anchorLat);

    if ((mode === 'add_line' || mode === 'add_bezier' || mode === 'add_shape_line' || mode === 'add_shape_bezier' || mode === 'add_shape_line_arrow' || mode === 'add_shape_bezier_arrow' || mode === 'add_shape_front_line' || mode === 'add_shape_front_curve' || mode === 'terr_split') && cursor) {
      const coords = [...points, cursor];
      const eff = (mode === 'add_bezier' || mode === 'add_shape_bezier' || mode === 'add_shape_bezier_arrow' || mode === 'add_shape_front_curve') ? approxBezier(coords) : coords;
      if (eff.length >= 2) fc.push(turf.lineString(eff));
    } else if (mode === 'add_moving_line') {
      const coords = cursor ? [...points, cursor] : points;
      if (coords.length >= 2) fc.push(turf.lineString(coords));
      else if (cursor) fc.push(turf.point(cursor));
    } else if (mode === 'add_moving_bezier') {
      const coords = cursor ? [...points, cursor] : points;
      if (coords.length >= 2) {
        const eff = approxBezier(coords);
        fc.push(turf.lineString(eff));
      } else if (cursor) fc.push(turf.point(cursor));
    } else if (mode === 'add_curved' && (points.length > 0 || cursor)) {
      // 燕尾箭头（curved）：跟随鼠标实时预览
      const basePts = cursor && points.length > 0 ? [...points, cursor] : points;
      if (basePts.length >= 2) {
        const rings = buildArrowGeometry(basePts[0], basePts[basePts.length - 1], arrowWidth, 'curved', basePts);
        rings.forEach((r) => fc.push(turf.polygon([[...r, r[0]]])));
      }
    } else if (mode === 'add_shape_march' && (points.length > 0 || cursor)) {
      // 行军箭头（curved-simple）：跟随鼠标实时预览
      const basePts = cursor && points.length > 0 ? [...points, cursor] : points;
      if (basePts.length >= 2) {
        const rings = buildArrowGeometry(basePts[0], basePts[basePts.length - 1], arrowWidth, 'curved-simple', basePts);
        rings.forEach((r) => fc.push(turf.polygon([[...r, r[0]]])));
      }
    } else if (mode === 'add_shape_swallowtail' && (points.length > 0 || cursor)) {
      // 燕尾箭头（curved）：跟随鼠标实时预览
      const basePts = cursor && points.length > 0 ? [...points, cursor] : points;
      if (basePts.length >= 2) {
        const rings = buildArrowGeometry(basePts[0], basePts[basePts.length - 1], arrowWidth, 'curved', basePts);
        rings.forEach((r) => fc.push(turf.polygon([[...r, r[0]]])));
      }
    } else if (mode === 'add_special_swallow' && (points.length > 0 || cursor)) {
      // 自定义燕尾箭头（attack 算法，尾部燕尾）：跟随鼠标实时预览
      const basePts = cursor && points.length > 0 ? [...points, cursor] : points;
      if (basePts.length >= 2) {
        const rings = buildArrowGeometry(basePts[0], basePts[basePts.length - 1], arrowWidth, 'attack', basePts);
        rings.forEach((r) => fc.push(turf.polygon([[...r, r[0]]])));
      }
    } else if (mode === 'add_attack' && (points.length > 0 || cursor)) {
      // 自定义箭头（attack）：跟随鼠标实时预览
      const basePts = cursor && points.length > 0 ? [...points, cursor] : points;
      if (basePts.length >= 2) {
        const rings = buildArrowGeometry(basePts[0], basePts[basePts.length - 1], arrowWidth, 'attack', basePts);
        rings.forEach((r) => fc.push(turf.polygon([[...r, r[0]]])));
      }
    } else if (POLY_DRAW_MODES.has(mode as any) && cursor) {
      const coords = [...points, cursor];
      // 曲线多边：预览已闭合的曲线环（拟合），默认给直线边预览
      if (mode === 'add_shape_poly_curve' || mode === 'add_shape_poly_curve_defend') {
        if (coords.length >= 3) {
          const closed = [...coords, coords[0]];
          const smooth = approxBezier(closed);
          fc.push(turf.lineString(smooth));
        } else {
          fc.push(turf.lineString([...coords, coords[0]]));
        }
      } else {
        fc.push(turf.lineString([...coords, coords[0]]));
      }
    } else if (mode === 'add_arrow' && points.length >= 1 && cursor) {
      const rings = buildArrowGeometry(points[0], cursor, arrowWidth, 'swallowtail');
      rings.forEach((ring) => fc.push(turf.polygon([[...ring, ring[0]]])));
    } else if (mode === 'add_pincer' && points.length >= 2) {
      // 钳形攻势：≥3 点后用 buildDoubleArrow 显示真实形状（不画控制点引导线）
      const previewPts = cursor ? [...points, cursor] : points;
      if (previewPts.length >= 3) {
        const ring = buildDoubleArrowPreview(previewPts);
        if (ring.length >= 3) fc.push(turf.polygon([[...ring, ring[0]]]));
      }
    } else if (mode === 'add_rect' && points.length >= 1 && cursor) {
      // 矩形预览：对角两点
      const [x1, y1] = points[0];
      const [x2, y2] = cursor;
      const ring: [number, number][] = [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]];
      fc.push(turf.polygon([ring]));
    } else if ((mode === 'add_encirclement') && points.length >= 1 && cursor) {
      // 包围圈：虚线圆环
      const r = Math.max(0.5, turf.distance(points[0], cursor, { units: 'kilometers' }));
      const ring = circleCoords(points[0], r);
      fc.push(turf.lineString([...ring, ring[0]]));
      fc.push(turf.point(points[0]));
    } else if (mode === 'add_gathering' && points.length >= 1 && cursor) {
      // 集结点：曲边集结地形状
      const r = Math.max(0.5, turf.distance(points[0], cursor, { units: 'kilometers' }));
      const c = points[0];
      const rDeg = r / 111;
      const p0: [number, number] = [c[0] - rDeg * 1.1, c[1]];
      const p1: [number, number] = [c[0], c[1] + rDeg * 1.5];
      const p2: [number, number] = [c[0] + rDeg * 1.1, c[1]];
      const shape = buildGatheringPlace([p0, p1, p2] as any) as [number, number][];
      if (shape.length >= 3) fc.push(turf.polygon([[...shape, shape[0]]]));
      fc.push(turf.point(points[0]));
    } else if ((mode === 'add_shape_circle' || mode === 'add_shape_star') && points.length >= 1 && cursor) {
      // 圆 / 五角星：第1点=圆心,移动调半径
      const r = Math.max(0.5, turf.distance(points[0], cursor, { units: 'kilometers' }));
      const ring = mode === 'add_shape_circle'
        ? circleCoords(points[0], r)
        : polyStarCoords(points[0], r);
      fc.push(turf.lineString([...ring, ring[0]]));
      fc.push(turf.point(points[0]));
    }

    // 已采集顶点
    if (points.length > 0) fc.push(...points.map((p) => turf.point(p)));

    // 线类模式不显示填充层，避免出现区域样式
    const showFill = !LINE_PREVIEW_MODES.has(mode);
    setPreviewData(map, { type: 'FeatureCollection', features: fc } as any, showFill);
  }, [mode]);

  // ===== 点击地图 =====
  const handleClick = useCallback((e: maplibregl.MapMouseEvent) => {
    const map = mapRef.current;
    if (!map) return;
    if (skipClickRef.current) { skipClickRef.current = false; return; }
    const lngLat: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    const d = drawRef.current;

    // —— 点类元素：一次点击完成 ——
    if (mode === 'add_point') {
      createElementAndSelect({
        id: generateId(), type: 'point', name: '标记点', visible: true, locked: false,
        startFrame: 0, endFrame: project.endFrame, style: {},
        coordinates: lngLat, color: '#FF4444', iconSize: 10,
      } as PointElement);
      return;
    }
    if (mode === 'add_text') {
      createElementAndSelect({
        id: generateId(), type: 'point', name: '文字', visible: true, locked: false,
        startFrame: 0, endFrame: project.endFrame, style: {},
        coordinates: lngLat, shape: 'text', iconSize: 0,
        label: { text: '文字', fontSize: 14, color: '#FFFFFF', position: 'center', bgColor: 'rgba(0,0,0,0)', bgPadding: 3, bgRadius: 3, fontWeight: 'bold' },
      } as PointElement);
      return;
    }
    if (mode === 'add_flag') {
      createElementAndSelect({
        id: generateId(), type: 'flag', name: '旗帜', visible: true, locked: false,
        startFrame: 0, endFrame: project.endFrame, style: {},
        coordinates: lngLat, text: '旗帜', flagColor: '#E23B3B', textColor: '#FFFFFF',
        fontSize: 14, flagWidth: 72,
      } as FlagElement);
      return;
    }
    // —— 行政区一键高亮：点击国土自动生成可编辑的高亮面 ——
    if (mode === 'add_region') {
      void (async () => {
        try {
          const hits = await findRegionsAt(lngLat);
          if (!hits.length) return;
          const els = regionHitsToShapes(hits).map((s) => makeRegionPolygon(s.name, s.rings as [number, number][][], project));
          if (els.length) {
            addElements(els);
            selectElement(els[0].id);
            focusHostOf(els[0].id);
            setMode('select');
          }
        } catch {
          alert('行政区边界数据加载失败，请检查网络后重试');
        }
      })();
      return;
    }

    // —— 箭头：两步（起点→终点） / 弯曲箭头：采点双击完成 ——
    if (mode === 'add_arrow') {
      if (d.points.length === 0) {
        d.points = [lngLat];
        d.cursor = lngLat;
        updatePreview();
      } else {
        createElementAndSelect({
          id: generateId(), type: 'arrow', name: '箭头', visible: true, locked: false,
          startFrame: 0, endFrame: project.endFrame, style: {},
          from: d.points[0], to: lngLat, arrowType: 'swallowtail', width: 15, color: '#E23B3B',
          progress: [{ frame: 0, value: 1 }], drawZoom: map.getZoom(),
        } as ArrowElement);
        resetDraw();
      }
      return;
    }
    if (mode === 'add_curved') {
      // 多点采点，双击/回车完成
      d.points.push(lngLat);
      d.cursor = lngLat;
      updatePreview();
      return;
    }
    if (mode === 'add_rect') {
      // 两步：第1击定对角 → 第2击生成矩形
      if (d.points.length === 0) {
        d.points = [lngLat];
        d.cursor = lngLat;
        updatePreview();
      } else {
        const [x1, y1] = d.points[0];
        const [x2, y2] = lngLat;
        const ring: [number, number][] = [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]];
        createElementAndSelect({
          id: generateId(), type: 'polygon', name: '矩形', visible: true, locked: false,
          startFrame: 0, endFrame: project.endFrame, style: {},
          coordinates: [ring],
          fillColor: '#E23B3B', fillOpacity: 0.25, strokeColor: '#E23B3B', strokeWidth: 2,
          shapeKind: 'rect',
          rectMeta: { c1: [x1, y1], c2: [x2, y2] },
          shapeCategory: 'two',
        } as PolygonElement);
        resetDraw();
      }
      return;
    }
    if (mode === 'add_pincer') {
      // 钳形攻势：4 控制点 → DoubleArrow（双箭头对进）。到 4 个自动完成
      d.points.push(lngLat);
      d.cursor = lngLat;
      updatePreview();
      if (d.points.length >= 4) {
        const pts = dedupePoints(d.points);
        createElementAndSelect({
          id: generateId(), type: 'double_arrow', name: '钳形攻势', visible: true, locked: false,
          startFrame: 0, endFrame: project.endFrame, style: {},
          points: pts.slice(0, 4) as [number, number][],
          color: '#E23B3B',
          progress: [{ frame: 0, value: 1 }],
          shapeCategory: 'special',
        } as DoubleArrowElement);
        resetDraw();
      }
      return;
    }
    if (mode === 'add_attack') {
      // 进攻箭头：多点采点，双击完成
      d.points.push(lngLat);
      d.cursor = lngLat;
      updatePreview();
      return;
    }
    if (mode === 'add_encirclement' || mode === 'add_gathering' || mode === 'add_shape_circle' || mode === 'add_shape_star') {
      if (d.points.length === 0) {
        d.points = [lngLat];
        d.phase = 'radius';
        d.cursor = lngLat;
        updatePreview();
      } else {
        const radius = Math.max(0.5, turf.distance(d.points[0], lngLat, { units: 'kilometers' }));
        if (mode === 'add_encirclement') {
          createElementAndSelect({
            id: generateId(), type: 'encirclement', name: '包围圈', visible: true, locked: false,
            startFrame: 0, endFrame: project.endFrame, style: {},
            center: d.points[0], radius, fillColor: '#D33030', strokeColor: '#D33030',
          } as EncirclementElement);
        } else if (mode === 'add_gathering') {
          createElementAndSelect({
            id: generateId(), type: 'gathering', name: '集结点', visible: true, locked: false,
            startFrame: 0, endFrame: project.endFrame, style: {},
            center: d.points[0], radius, color: '#FF6600', pulseAnimation: true,
            shapeCategory: 'two',
          } as GatheringElement);
        } else if (mode === 'add_shape_circle') {
          createElementAndSelect({
            id: generateId(), type: 'polygon', name: '圆', visible: true, locked: false,
            startFrame: 0, endFrame: project.endFrame, style: {},
            coordinates: [circleCoords(d.points[0], radius)],
            fillColor: '#E23B3B', fillOpacity: 0.25, strokeColor: '#E23B3B', strokeWidth: 2,
            shapeKind: 'circle',
            circleMeta: { center: d.points[0], radius },
            shapeCategory: 'two',
          } as PolygonElement);
        } else {
          createElementAndSelect({
            id: generateId(), type: 'polygon', name: '五角星', visible: true, locked: false,
            startFrame: 0, endFrame: project.endFrame, style: {},
            coordinates: [polyStarCoords(d.points[0], radius)],
            fillColor: '#E23B3B', fillOpacity: 0.25, strokeColor: '#E23B3B', strokeWidth: 2,
            shapeKind: 'star',
            starMeta: { center: d.points[0], radius },
            shapeCategory: 'two',
          } as PolygonElement);
        }
        resetDraw();
      }
      return;
    }

    // —— 疆域地块绘制：吸附已有顶点/边 + 沿边界描幕 ——
    if (mode === 'add_terr_plot') {
      const terrs = (project.elements.filter((x) => x.type === 'territory') || []) as TerritoryElement[];
      const snap = terrSnapNear(map, lngLat, terrs, { vertexPx: 12, edgePx: 12 });
      const pt: [number, number] = snap ? snap.pt : lngLat;
      // 描幕：上一点与本点吸附到同一地块（顶点或边）→ 自动插入两点间整段边界。
      // Alt=长弧（共享段恰为长弧时）；Ctrl=不描幕直连。
      const prev = d.marks[d.marks.length - 1];
      if (snap && prev && prev.pid === snap.pid) {
        const plot = terrs.find((t) => t.id === snap.elId)?.plots.find((p) => p.id === snap.pid);
        if (plot?.rings?.[0]) {
          const viOf = (mk: NonNullable<typeof snap>) => (mk.kind === 'vertex' ? mk.vi : nearestRingVertexIndex(plot.rings[0], mk.pt));
          const i0 = viOf(prev);
          const i1 = viOf(snap);
          const oe = e.originalEvent as MouseEvent | undefined;
          const ctrlSkip = oe?.ctrlKey === true;
          const longArc = oe?.altKey === true;
          if (!ctrlSkip && i0 !== i1) {
            for (const m of traceRingPath(ringOpen(plot.rings[0]), i0, i1, longArc)) {
              d.points.push(m);
              d.marks.push(null);
            }
          }
        }
      }
      d.points.push(pt);
      d.marks.push(snap);
      d.cursor = pt;
      updatePreview();
      return;
    }

    // —— 疆域：分割地块（两点画切线，切开当前编辑地块） ——
    if (mode === 'terr_split') {
      if (d.points.length === 0) {
        d.points = [lngLat];
        d.cursor = lngLat;
        updatePreview();
        return;
      }
      const a = d.points[0];
      const b = lngLat;
      const st = useEditorStore.getState();
      const proj = useProjectStore.getState();
      const terr = (project.elements.find((x) => x.id === st.selectedElementId && x.type === 'territory')
        || project.elements.find((x) => x.type === 'territory')) as TerritoryElement | undefined;
      const plotId = st.terrPlotId ?? terr?.plots[0]?.id ?? null;
      const plot = terr?.plots.find((p) => p.id === plotId);
      if (!terr || !plot) {
        void confirm({ message: '请先选中要分割的地块（在「疆域」面板点 ⊙ 或双击地图上的地块）', confirmText: '知道了', danger: false });
        resetDraw();
        return;
      }
      const pieces = splitPlotByLine(plot.rings, [a, b]);
      if (!pieces) {
        void confirm({ message: '切线未贯穿该地块：请让起点与终点分别落在地块外侧', confirmText: '知道了', danger: false });
        resetDraw();
        return;
      }
      const baseName = plot.name || '地块';
      const kept = terr.plots.filter((p) => p.id !== plot.id);
      const added = pieces.map((rings, i) => ({
        id: generateId(), name: `${baseName}·${i + 1}`, rings, ownerId: plot.ownerId,
      }));
      proj.updateElement(terr.id, { plots: [...kept, ...added] } as Partial<MapElement>);
      st.setTerrPlotId(added[0]?.id ?? null);
      resetDraw();
      return;
    }

    // —— 移动路径 / 线 / 贝塞尔 / 大圆弧 / 面：采点，双击或回车完成 ——
    if (mode === 'add_moving_line' || mode === 'add_moving_bezier' || mode === 'add_line' || mode === 'add_bezier' || mode === 'add_line_arc' || POLY_DRAW_MODES.has(mode as any) || mode === 'add_shape_line' || mode === 'add_shape_bezier' || mode === 'add_shape_line_arrow' || mode === 'add_shape_bezier_arrow' || mode === 'add_shape_march' || mode === 'add_shape_swallowtail' || mode === 'add_special_swallow' || mode === 'add_shape_front_line' || mode === 'add_shape_front_curve') {
      d.points.push(lngLat);
      d.cursor = lngLat;
      updatePreview();
      return;
    }

    // —— 疆域：兼并点选（点地块加入/移出选择，空白处不动作） ——
    if (mode === 'terr_annex') {
      const layers = (map.getStyle().layers || []).map((l: any) => l.id).filter((id: string) => id.startsWith('terr-layer-'));
      const feats = layers.length ? map.queryRenderedFeatures(e.point, { layers }) : [];
      if (feats.length) {
        const f = feats[0] as any;
        const pid = f?.properties?.pid as string;
        const tid = f?.properties?.tid as string;
        if (pid) {
          useEditorStore.getState().toggleTerrSelPlot(pid);
          if (tid) selectElement(tid);
        }
      }
      return;
    }

    // —— 选择模式：命中检测 ——
    if (mode === 'select') {
      selectElement(pickElement(map, e.point, project.elements, editableIdSet(project, useEditorStore.getState().selectedLayerId)));
    }
  }, [mode, project, project, addElement, addElements, selectElement, setMode, updatePreview, resetDraw, confirm]);

  /** 把某元素的宿主层设为地图上的「可编辑层」：刚画完 / 刚导入的东西应当能立刻拖 */
  const focusHostOf = (elementId: string) => {
    const host = useProjectStore.getState().project?.layers.find((L) => L.elements.some((el) => el.id === elementId));
    if (host) useEditorStore.getState().focusLayer(host.id);
  };

  const createElementAndSelect = useCallback((element: MapElement) => {
    addElement(element);
    selectElement(element.id);
    focusHostOf(element.id);
    setMode('select');
  }, [project.id, addElement, selectElement, setMode]);

  // ===== 双击完成绘制 =====
  const finishDrawing = useCallback(() => {
    const map = mapRef.current;
    const d = drawRef.current;
    if (!map) return;

    let pts = dedupePoints(d.points);

    if (mode === 'add_pincer') {
      // 钳形攻势：4 控制点 → DoubleArrow
      if (pts.length < 3) return;
      createElementAndSelect({
        id: generateId(), type: 'double_arrow', name: '钳形攻势', visible: true, locked: false,
        startFrame: 0, endFrame: project.endFrame, style: {},
        points: pts as [number, number][],
        color: '#E23B3B',
        progress: [{ frame: 0, value: 1 }],
        shapeCategory: 'special',
      } as DoubleArrowElement);
    } else if (mode === 'add_attack') {
      if (pts.length < 2) return;
      createElementAndSelect({
        id: generateId(), type: 'arrow', name: '自定义箭头', visible: true, locked: false,
        startFrame: 0, endFrame: project.endFrame, style: {},
        from: pts[0] as [number, number], to: pts[pts.length - 1] as [number, number], arrowType: 'attack', path: pts,
        width: 15, color: '#E23B3B',
        progress: [{ frame: 0, value: 1 }], drawZoom: map.getZoom(),
        shapeCategory: 'special',
      } as ArrowElement);
    } else if (mode === 'add_moving_line') {
      if (pts.length < 2) return;
      createElementAndSelect({
        id: generateId(), type: 'moving_point', name: '移动点(直线)', visible: true, locked: false,
        startFrame: 0, endFrame: project.endFrame, style: {},
        path: pts,
        pathProgress: [{ frame: 0, value: 0 }, { frame: project.endFrame, value: 1 }],
        color: '#FF6600',
      } as MovingPointElement);
    } else if (mode === 'add_moving_bezier') {
      if (pts.length < 2) return;
      // 贝塞尔平滑后作为路径
      const smooth = approxBezier(pts);
      createElementAndSelect({
        id: generateId(), type: 'moving_point', name: '移动点(曲线)', visible: true, locked: false,
        startFrame: 0, endFrame: project.endFrame, style: {},
        path: smooth,
        pathProgress: [{ frame: 0, value: 0 }, { frame: project.endFrame, value: 1 }],
        color: '#FF6600',
      } as MovingPointElement);
    } else if (mode === 'add_line_arc') {
      if (pts.length < 2) return;
      createElementAndSelect({
        id: generateId(), type: 'line', name: '大圆弧航线', visible: true, locked: false,
        startFrame: 0, endFrame: project.endFrame, style: {},
        coordinates: pts,
        drawProgress: [{ frame: 0, value: 1 }],
        lineWidth: 8, lineColor: '#2277FF', lineType: 'arc',
      } as LineElement);
    } else if (mode === 'add_line' || mode === 'add_bezier' || mode === 'add_shape_line' || mode === 'add_shape_bezier' || mode === 'add_shape_line_arrow' || mode === 'add_shape_bezier_arrow') {
      if (pts.length < 2) return;
      const shape = mode === 'add_shape_line' || mode === 'add_shape_bezier' || mode === 'add_shape_line_arrow' || mode === 'add_shape_bezier_arrow';
      const bez = mode === 'add_bezier' || mode === 'add_shape_bezier' || mode === 'add_shape_bezier_arrow';
      const arrow = mode === 'add_shape_line_arrow' || mode === 'add_shape_bezier_arrow';
      // 路线弹窗的样式请求：仅在模式匹配时套用（无样式路线 / 归入路线类）
      const rr = useInteractionStore.getState().pendingRouteStyle;
      const rstyle = rr && rr.mode === mode ? rr.style : null;
      if (rstyle) useInteractionStore.getState().clearPendingRouteStyle();
      const isPlain = rstyle === 'plain-straight' || rstyle === 'plain-bezier';
      const asRoute = isPlain || rstyle === 'arrow-line' || rstyle === 'arrow-curve';
      createElementAndSelect({
        id: generateId(), type: 'line',
        name: isPlain ? (bez ? '无样式曲线' : '无样式直线') : arrow ? (bez ? '带箭头曲线' : '带箭头直线') : bez ? '曲线' : (shape ? '直线' : '路线'),
        visible: true, locked: false,
        startFrame: 0, endFrame: project.endFrame, style: {},
        coordinates: pts,
        drawProgress: [{ frame: 0, value: 1 }],
        showIcon: !shape || asRoute,
        uniformMove: true,
        // 路线默认动画：路线移动（move），起止与显示区间一致
        ...((!shape || asRoute) ? { animEffect: 'move' as const, moveStartFrame: 0, moveEndFrame: project.endFrame } : {}),
        lineWidth: 8, lineColor: '#FF4444',
        ...(bez ? { lineType: 'bezier' as const } : (isPlain || rstyle === 'arrow-line') ? { lineType: 'straight' as const } : {}),
        ...(arrow ? { lineArrow: true } : {}),
        ...(isPlain ? { plainPath: true as const } : {}),
        ...(asRoute ? { shapeCategory: 'route' as const } : shape ? { shapeCategory: 'multi' as const } : {}),
      } as LineElement);
    } else if (mode === 'add_shape_march') {
      if (pts.length < 2) return;
      const rr = useInteractionStore.getState().pendingRouteStyle;
      const asRoute = rr?.mode === mode;
      if (asRoute) useInteractionStore.getState().clearPendingRouteStyle();
      createElementAndSelect({
        id: generateId(), type: 'arrow', name: '行军箭头', visible: true, locked: false,
        startFrame: 0, endFrame: project.endFrame, style: {},
        from: pts[0] as [number, number], to: pts[pts.length - 1] as [number, number], arrowType: 'curved-simple', path: pts,
        width: 15, color: '#E23B3B',
        progress: [{ frame: 0, value: 1 }],
        showIcon: true, uniformMove: true,
        ...(asRoute ? { animEffect: 'move' as const, moveStartFrame: 0, moveEndFrame: project.endFrame } : {}),
        drawZoom: map.getZoom(),
        shapeCategory: asRoute ? 'route' : 'multi',
      } as ArrowElement);
    } else if (mode === 'add_shape_swallowtail') {
      if (pts.length < 2) return;
      createElementAndSelect({
        id: generateId(), type: 'arrow', name: '燕尾箭头', visible: true, locked: false,
        startFrame: 0, endFrame: project.endFrame, style: {},
        from: pts[0] as [number, number], to: pts[pts.length - 1] as [number, number], arrowType: 'curved', path: pts,
        width: 15, color: '#E23B3B',
        progress: [{ frame: 0, value: 1 }],
        showIcon: true, uniformMove: true,
        drawZoom: map.getZoom(),
        shapeCategory: 'multi',
      } as ArrowElement);
    } else if (mode === 'add_special_swallow') {
      if (pts.length < 2) return;
      createElementAndSelect({
        id: generateId(), type: 'arrow', name: '自定义燕尾箭头', visible: true, locked: false,
        startFrame: 0, endFrame: project.endFrame, style: {},
        from: pts[0] as [number, number], to: pts[pts.length - 1] as [number, number], arrowType: 'attack', path: pts,
        width: 15, color: '#E23B3B',
        progress: [{ frame: 0, value: 1 }],
        showIcon: true, uniformMove: true,
        drawZoom: map.getZoom(),
        shapeCategory: 'special',
      } as ArrowElement);
    } else if (mode === 'add_shape_front_line' || mode === 'add_shape_front_curve') {
      if (pts.length < 2) return;
      const curved = mode === 'add_shape_front_curve';
      createElementAndSelect({
        id: generateId(), type: 'line',
        name: curved ? '弯曲战线' : '直线战线',
        visible: true, locked: false,
        startFrame: 0, endFrame: project.endFrame, style: {},
        coordinates: pts,
        drawProgress: [{ frame: 0, value: 1 }],
        lineWidth: 8, lineColor: '#FF6600',
        lineType: curved ? ('bezier' as const) : ('straight' as const),
        frontStyle: { toothLength: 14, toothGap: 24, toothAngle: 0, side: 1 },
        shapeCategory: 'multi',
      } as LineElement);
    } else if (mode === 'add_terr_plot') {
      // 绘制地块：闭合环 → 加入选中疆域（无则新建）；完成后保持模式可连续绘制
      const d0 = drawRef.current;
      // 末点吸附回首点时去掉，避免双重闭合
      if (pts.length > 1 && Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 1e-9 && Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 1e-9) pts = pts.slice(0, -1);
      if (pts.length < 3) return;
      const ring = [...pts, pts[0]] as [number, number][];
      const st = useEditorStore.getState();
      const proj = useProjectStore.getState();
      let target = project.elements.find((x) => x.id === st.selectedElementId && x.type === 'territory') as TerritoryElement | undefined
        || project.elements.find((x) => x.type === 'territory') as TerritoryElement | undefined;
      // T 型分叉：吸附到邻边上的点同时插入相邻地块环，保证共享边界可联动
      const splitPlots = new Map<string, TerritoryElement['plots']>();
      const splitSeen = new Set<string>();
      for (const mk of d0.marks || []) {
        if (!mk || mk.kind !== 'edge') continue;
        const sig = `${mk.pid}:${coordKey(mk.pt)}`; // 双击附加采点会重复同一吸附 → 去重
        if (splitSeen.has(sig)) continue;
        splitSeen.add(sig);
        const terrEl = project.elements.find((x) => x.id === mk.elId && x.type === 'territory') as TerritoryElement | undefined;
        if (!terrEl) continue;
        const cur = splitPlots.get(mk.elId) ?? terrEl.plots;
        if (!cur.find((p) => p.id === mk.pid)) continue;
        splitPlots.set(mk.elId, cur.map((p) => (p.id === mk.pid ? { ...p, rings: [insertRingVertex(p.rings[0], mk.pt), ...p.rings.slice(1)] } : p)));
      }
      const newCountry = { id: generateId(), name: '势力1', color: '#E23B3B' };
      if (!target) {
        target = {
          id: generateId(), type: 'territory', name: '疆域', visible: true, locked: false,
          startFrame: 0, endFrame: project.endFrame, style: {},
          countries: [newCountry], plots: [], events: [], display: defaultTerritoryDisplay(),
        } as TerritoryElement;
        addElement(target);
      }
      // 本轮全部地块更新（T 分叉 + 重叠修剪回插）先累积，统一一次写回，避免相互覆盖
      const pend = new Map<string, TerritoryElement['plots']>(splitPlots);
      const baseOf = (elId: string) => pend.get(elId) ?? (project.elements.find((x) => x.id === elId && x.type === 'territory') as TerritoryElement | undefined)?.plots;
      const countryId = target.countries[0]?.id || newCountry.id;
      // 重叠修剪：与既有地块的重叠沿既有边界裁齐（顶点与邻块一致 → 自动共享），完全被覆盖则放弃
      const others: { elId: string; pid: string; ring: [number, number][]; keys: Set<string> }[] = [];
      for (const el of project.elements) {
        if (el.type !== 'territory') continue;
        for (const p of baseOf(el.id) ?? []) {
          if (p.rings?.[0] && p.rings[0].length >= 4) {
            others.push({ elId: el.id, pid: p.id, ring: p.rings[0], keys: new Set(p.rings[0].map(coordKey)) });
          }
        }
      }
      const trimmed = trimPlotOverlap(ring, others.map((o) => o.ring));
      if (!trimmed) { resetDraw(); return; }
      // 反向 T 分叉：修剪产生的交点（落在邻块边界上）回插邻块环，保证共享边可联动
      if (trimmed[0] !== ring) {
        const trimPts = trimmed.flatMap((r) => r.slice(0, -1));
        for (const v of trimPts) {
          const vk = coordKey(v);
          for (const o of others) {
            if (o.keys.has(vk)) continue;
            if (distToRingBoundary(v, o.ring) < 1e-6) {
              const cur = baseOf(o.elId);
              if (!cur?.find((p) => p.id === o.pid)) continue;
              const next = cur.map((p) => (p.id === o.pid ? { ...p, rings: [insertRingVertex(p.rings[0], v), ...p.rings.slice(1)] } : p));
              pend.set(o.elId, next);
              o.keys.add(vk);
              o.ring = next.find((p) => p.id === o.pid)!.rings[0];
            }
          }
        }
      }
      for (const [elId, nextPlots] of pend) {
        if (elId !== target.id) proj.updateElement(elId, { plots: nextPlots } as Partial<MapElement>);
      }
      const plot = { id: generateId(), name: `地块${target.plots.length + 1}`, rings: trimmed, ownerId: countryId };
      proj.updateElement(target.id, {
        plots: [...(pend.get(target.id) ?? target.plots), plot],
        ...(target.countries.length ? {} : { countries: [newCountry] }),
      } as Partial<MapElement>);
      useEditorStore.getState().setTerrPlotId(plot.id);
      selectElement(target.id);
      resetDraw();
      return;
    } else if (POLY_DRAW_MODES.has(mode as any)) {
      if (pts.length < 3) return;
      pts = [...pts, pts[0]];
      const curve = mode === 'add_shape_poly_curve' || mode === 'add_shape_poly_curve_defend';
      const defend = mode === 'add_shape_poly_defend' || mode === 'add_shape_poly_curve_defend';
      createElementAndSelect({
        id: generateId(), type: 'polygon',
        name: curve ? (defend ? '曲线防御圈' : '曲线多边') : (defend ? '直线防御圈' : '多边形'),
        visible: true, locked: false,
        startFrame: 0, endFrame: project.endFrame, style: {},
        coordinates: [pts],
        fillColor: '#E23B3B', fillOpacity: 0.25, strokeColor: '#E23B3B', strokeWidth: defend ? 8 : 2,
        shapeKind: 'poly',
        polyCurve: curve || undefined,
        defenseStyle: defend ? { toothLength: 14, toothGap: 24, toothAngle: 0, side: 1 } : undefined,
        shapeCategory: 'multi',
      } as PolygonElement);
    } else if (mode === 'add_curved') {
      if (pts.length < 2) return;
      const rr = useInteractionStore.getState().pendingRouteStyle;
      const asRoute = rr?.mode === mode;
      if (asRoute) useInteractionStore.getState().clearPendingRouteStyle();
      createElementAndSelect({
        id: generateId(), type: 'arrow', name: asRoute ? '燕尾箭头' : '弯曲箭头', visible: true, locked: false,
        startFrame: 0, endFrame: project.endFrame, style: {},
        from: pts[0] as [number, number], to: pts[pts.length - 1] as [number, number], arrowType: 'curved', path: pts,
        width: 15, color: '#E23B3B',
        progress: [{ frame: 0, value: 1 }],
        ...(asRoute ? { showIcon: true, uniformMove: true, animEffect: 'move' as const, moveStartFrame: 0, moveEndFrame: project.endFrame } : {}),
        drawZoom: map.getZoom(),
        shapeCategory: asRoute ? 'route' : 'special',
      } as ArrowElement);
    }

    resetDraw();
  }, [mode, project, addElement, selectElement, setMode, resetDraw, createElementAndSelect]);

  const handleDblClick = useCallback((e?: maplibregl.MapMouseEvent) => {
    // 任何相关模式双击已有地块 → 进入该地块边界编辑（绘制模式限空笔，避免与"完成绘制"冲突）
    const map = mapRef.current;
    const m = useInteractionStore.getState().mode;
    const d = drawRef.current;
    const dblStroke = m === 'add_terr_plot'
      && d.points.length === 2
      && Math.abs(d.points[0][0] - d.points[1][0]) < 1e-9
      && Math.abs(d.points[0][1] - d.points[1][1]) < 1e-9; // 双击自带的两次采点重合 = 空笔双击
    if (map && e && (m === 'select' || m === 'terr_annex' || dblStroke)) {
      const layers = (map.getStyle().layers || []).map((l: any) => l.id).filter((id: string) => id.startsWith('terr-layer-'));
      const feats = layers.length ? map.queryRenderedFeatures(e.point, { layers }) : [];
      const f = feats[0] as any;
      const pid = f?.properties?.pid as string | undefined;
      const tid = f?.properties?.tid as string | undefined;
      if (pid && tid) {
        const st = useProjectStore.getState();
        const terr = (st.project || project)
          .elements.find((x) => x.id === tid && x.type === 'territory') as TerritoryElement | undefined;
        if (terr) {
          if (m === 'add_terr_plot') { resetDraw(); setMode('select'); } // 编辑需退出绘制模式（顶点拖拽在选择模式）
          useEditorStore.getState().setTerrPlotId(pid);
          selectElement(terr.id);
          return;
        }
      }
    }
    finishDrawing();
    useEditorStore.getState().setRouteEdit('none');
  }, [finishDrawing, project, selectElement, resetDraw, setMode]);

  // ===== 悬停元素 → 移动光标（select 模式） =====
  const setCanvasCursor = useCallback((c: string) => {
    const m = mapRef.current;
    if (m) m.getCanvas().style.cursor = c;
  }, []);

  const handleHover = useCallback((e: maplibregl.MapMouseEvent) => {
    const m = mapRef.current;
    if (!m) return;
    if (useInteractionStore.getState().mode !== 'select') return; // 其他模式由 getCursor 处理
    if (dragRef.current.active) { m.getCanvas().style.cursor = 'move'; return; }
    if (useEditorStore.getState().routeEdit === 'add') { m.getCanvas().style.cursor = 'crosshair'; return; }
    const hit = pickElement(m, e.point, project.elements, editableIdSet(project, useEditorStore.getState().selectedLayerId));
    m.getCanvas().style.cursor = hit ? 'move' : '';
  }, [project.elements]);

  const handleHoverOut = useCallback(() => {
    // 鼠标移出地图：隐藏吸附指示圈（否则会在上次吸附点残留蓝色空心圈），复位光标
    const m = mapRef.current;
    if (m?.getLayer('terr-snap')) {
      try { m.setLayoutProperty('terr-snap', 'visibility', 'none'); } catch { /* style 未就绪 */ }
    }
    if (useInteractionStore.getState().mode === 'select') setCanvasCursor('');
  }, [setCanvasCursor]);

  // 模式切换时同步画布光标
  useEffect(() => {
    setCanvasCursor(mode === 'select' ? '' : mode === 'terr_split' ? SCISSORS_CURSOR : mode.startsWith('add_') ? 'crosshair' : '');
  }, [mode, setCanvasCursor]);

  // ===== 拖拽移动元素 / 顶点编辑 =====
  // pendingLngLat：整元素拖拽期间的「地图预览位置」。点/旗标拖动只改地图源、不写 store，
  // 松手时再一次性提交（避免每个 mousemove 触发全量元素重渲染造成明显延迟）。
  const dragRef = useRef<{ active: boolean; elementId: string | null; x: number; y: number; vertex?: number; pendingLngLat?: [number, number] | null }>({
    active: false, elementId: null, x: 0, y: 0, pendingLngLat: null,
  });
  // 顶点命中后抑制紧随的 click 取消（否则刚选中的路线被空白点击取消）
  const skipClickRef = useRef(false);
  // 元素整体拖拽是否真正移动过（用于抑制松手后 MapLibre 补发的 click 改选）
  const dragMovedRef = useRef(false);

  const handleMouseDown = useCallback((e: maplibregl.MapMouseEvent) => {
    const map = mapRef.current;
    if (!map || mode !== 'select') return;
    // 用 getState() 现取，避免闭包章旧（selectedElementId/project 每次择/样式切换都会变）
    const st = useProjectStore.getState();
    const selId = useEditorStore.getState().selectedElementId;
    const ch = st.project || project;
    // 只有「当前选中图层」里的元素在地图上可编辑；未选中图层时全部可编辑
    const ed = editableIdSet(ch, useEditorStore.getState().selectedLayerId);
    const rEdit = useEditorStore.getState().routeEdit;
    const selEl = rEdit !== 'none' && selId ? ch.elements.find((x) => x.id === selId) : undefined;
    const editPath = selEl ? routePathOf(selEl) : null;

    // 添加点模式：命中已有顶点 → 退出添加模式转顶点拖拽（任意关键点都可编辑）；
    // 命中空白地图 → 在带路径的选中路线末尾追加（可连续追加，仅路线类）。
    const APPENDABLE = new Set(['line', 'moving_point', 'arrow', 'double_arrow']);
    if (rEdit === 'add') {
      const vAdd = hitRouteVertex(map, e.point, ch.elements, selId, ed);
      if (vAdd) {
        useEditorStore.getState().setRouteEdit('none');
      } else if (editPath && APPENDABLE.has((selEl as MapElement).type)) {
        const c = editPath.map((p2) => [p2[0], p2[1]] as [number, number]);
        const last = c[c.length - 1];
        const np: [number, number] = [e.lngLat.lng, e.lngLat.lat];
        if (Math.abs(last[0] - np[0]) < 1e-7 && Math.abs(last[1] - np[1]) < 1e-7) return;
        c.push(np);
        const fAdd = (selEl as MapElement).type === 'moving_point' || (selEl as MapElement).type === 'arrow' ? 'path' : (selEl as MapElement).type === 'double_arrow' ? 'points' : 'coordinates';
        useProjectStore.getState().updateElement((selEl as MapElement).id, { [fAdd]: c } as Partial<MapElement>);
        skipClickRef.current = true;
        return;
      }
    }
    // 无选中路线或编辑模式已失效：清掉残留模式，透传正常选择/拖拽
    if (rEdit !== 'none') useEditorStore.getState().setRouteEdit('none');
    // 优先命中路线顶点（可见标记点）：命中即选中该路线并进入顶点拖拽
    const v = hitRouteVertex(map, e.point, ch.elements, selId, ed);
    if (v) {
      // 疆域：Alt+点击顶点 → 删除（共享顶点同步删除；保底 3 点，少了删地块）
      const vEl = ch.elements.find((x) => x.id === v.eid);
      if (vEl?.type === 'territory' && e.originalEvent.altKey) {
        const terr = vEl as TerritoryElement;
        const pid = useEditorStore.getState().terrPlotId;
        const plot = terr.plots.find((p) => p.id === pid);
        const open = plot?.rings?.[0] ? ringOpen(plot.rings[0]) : null;
        const victim = open?.[v.idx];
        if (open && victim && open.length > 3) {
          const { plots: nextPlots, removedPlotIds } = removeSharedVertex(terr.plots, victim);
          snapshotHistory();
          useProjectStore.getState().updateElement(terr.id, { plots: nextPlots } as Partial<MapElement>);
          if (pid && removedPlotIds.includes(pid)) {
            const next = nextPlots[0];
            useEditorStore.getState().setTerrPlotId(next?.id ?? null);
          }
          skipClickRef.current = true;
          return;
        }
      }
      setHistoryMuted(true);
      snapshotHistory();
      dragRef.current = { active: true, elementId: v.eid, x: e.originalEvent?.clientX ?? e.point.x, y: e.originalEvent?.clientY ?? e.point.y, vertex: v.idx };
      skipClickRef.current = true;
      selectElement(v.eid);
      map.dragPan.disable();
      return;
    }
    const hit = pickElement(map, e.point, ch.elements, ed);
    if (hit) {
      // 拖拽开始前快照一次（绕过 700ms 节流）
      setHistoryMuted(true);
      snapshotHistory();
      dragRef.current = { active: true, elementId: hit, x: e.originalEvent?.clientX ?? e.point.x, y: e.originalEvent?.clientY ?? e.point.y };
      dragMovedRef.current = false;
      selectElement(hit);
      map.dragPan.disable();
    }
  }, [mode, selectElement, project.id]);

  const handleWindowMouseMove = useCallback((e: globalThis.MouseEvent) => {
    const map = mapRef.current;

    // 添加点模式：终点 → 光标 橡皮筋预览
    if (map && useEditorStore.getState().routeEdit === 'add') {
      const st = useProjectStore.getState();
      const selId = useEditorStore.getState().selectedElementId;
      const addCh = st.project;
      const addEl = (addCh?.elements || project.elements).find((x) => x.id === selId);
      const addPath = addEl ? routePathOf(addEl) : null;
      const abox = containerRef.current?.getBoundingClientRect();
      if (addPath && abox) {
        const p = map.unproject([e.clientX - abox.left, e.clientY - abox.top]);
        const last = addPath[addPath.length - 1] as [number, number];
        const line = turf.lineString([last, [p.lng, p.lat]]);
        try {
          if (map.getSource('route-add-preview')) {
            (map.getSource('route-add-preview') as GeoJSONSource).setData(turf.featureCollection([line]));
          } else {
            map.addSource('route-add-preview', { type: 'geojson', data: turf.featureCollection([line]) } as any);
            map.addLayer({
              id: 'route-add-preview', type: 'line', source: 'route-add-preview',
              paint: { 'line-color': '#3B82F6', 'line-width': 2, 'line-dasharray': [2, 2] },
            });
          }
          if (map.getLayer('route-add-preview')) {
            map.setLayoutProperty('route-add-preview', 'visibility', 'visible');
            map.moveLayer('route-add-preview');
          }
        } catch { // style 未就绪
        }
      }
    }

    // 绘制中更新光标位置 → 预览（疆域绘制：先吸附已有顶点/边并显示指示圈）
    // 顶点拖拽进行中不显示吸附圈（编辑拖拽不应触发绘制吸附）
    if (map && DRAW_MODES.includes(useInteractionStore.getState().mode) && !(dragRef.current.active && dragRef.current.vertex !== undefined)) {
      const bbox = containerRef.current?.getBoundingClientRect();
      if (bbox) {
        const p = map.unproject([e.clientX - bbox.left, e.clientY - bbox.top]);
        const cur: [number, number] = [p.lng, p.lat];
        if (useInteractionStore.getState().mode === 'add_terr_plot') {
          const st = useProjectStore.getState();
          const terrs = ((st.project || project).elements.filter((x) => x.type === 'territory') || []) as TerritoryElement[];
          const snap = terrSnapNear(map, cur, terrs, { vertexPx: 12, edgePx: 12 });
          if (snap) {
            drawRef.current.cursor = snap.pt;
            updateTerrSnapMarker(map, snap.pt, snap.kind);
          } else {
            drawRef.current.cursor = cur;
            if (map.getLayer('terr-snap')) map.setLayoutProperty('terr-snap', 'visibility', 'none');
          }
        } else {
          drawRef.current.cursor = cur;
        }
        updatePreview();
      }
    }

    const drag = dragRef.current;
    if (!map || !drag.active || !drag.elementId) return;

    // 顶点拖拽：只更新被拖动的路径点（起点/终点/中间点）
    if (drag.vertex !== undefined) {
      const el = project.elements.find((x) => x.id === drag.elementId);
      if (!el) return;
      const bb = containerRef.current?.getBoundingClientRect();
      if (!bb) return;
      const changed = patchElementVertex(el, drag.vertex, e.clientX, e.clientY, bb, map, project.id);
      if (changed) {
        drag.x = e.clientX;
        drag.y = e.clientY;
      }
      return;
    }

    const dx = Math.abs(e.clientX - drag.x);
    const dy = Math.abs(e.clientY - drag.y);
    if (dx < 3 && dy < 3) return;
    dragMovedRef.current = true;

    const bbox = containerRef.current?.getBoundingClientRect();
    if (!bbox) return;
    const lngLat = map.unproject([e.clientX - bbox.left, e.clientY - bbox.top]);
    const pt: [number, number] = [lngLat.lng, lngLat.lat];
    // 点 / 旗标：只改地图源（零 React 重渲染），松手再提交 store —— 消除拖动延迟
    const el = project.elements.find((x) => x.id === drag.elementId);
    if (el && (el.type === 'point' || el.type === 'flag') && previewMoveElementOnMap(map, el, pt)) {
      drag.pendingLngLat = pt;
      drag.x = e.clientX;
      drag.y = e.clientY;
      return;
    }
    // 贴图：按指针位移整体平移（保持抓取点在图片上的相对位置，不跳到左上角）
    if (el && el.type === 'geo_image') {
      const prev = map.unproject([drag.x - bbox.left, drag.y - bbox.top]);
      const ddx = pt[0] - prev.lng;
      const ddy = pt[1] - prev.lat;
      const cur = useProjectStore.getState().project?.elements.find((x) => x.id === drag.elementId);
      const g = (cur && cur.type === 'geo_image' ? cur.grid : el.grid).map((p) => [p[0] + ddx, p[1] + ddy] as [number, number]);
      useProjectStore.getState().updateElement(el.id, { grid: g } as Partial<MapElement>);
      drag.x = e.clientX;
      drag.y = e.clientY;
      return;
    }
    moveElementTo(project, drag.elementId, pt);
    drag.x = e.clientX;
    drag.y = e.clientY;
  }, [project, updatePreview]);

  const handleWindowMouseUp = useCallback(() => {
    const drag = dragRef.current;
    if (drag.active) {
      mapRef.current?.dragPan.enable();
    }
    // 真正拖动过：抑制紧随的 map click —— 否则拖到别的元素上松手会改选成那个元素
    if (drag.active && dragMovedRef.current) {
      skipClickRef.current = true;
      // 兜底：若 MapLibre 没有补发 click，避免残留标志吞掉下一次点击
      setTimeout(() => { skipClickRef.current = false; }, 300);
    }
    dragMovedRef.current = false;
    // 点 / 旗标：拖动期间只改了地图源，这里把最终位置一次性写回 store
    if (drag.active && drag.elementId && drag.pendingLngLat) {
      const st = useProjectStore.getState();
      const ch = st.project?.elements.some((x) => x.id === drag.elementId) ? st.project : undefined;
      if (ch) moveElementTo(ch, drag.elementId, drag.pendingLngLat);
    }
    dragRef.current = { active: false, elementId: null, x: 0, y: 0, pendingLngLat: null };
    // 无条件复位：拖拽被中断时若留 true，undo/redo 会从此**静默失效**
    setHistoryMuted(false);
  }, []);

  // 兜底：组件卸载时复位历史静音（拖拽中卸载/异常路径没有 mouseup，否则全局撤销栈失效）
  useEffect(() => () => setHistoryMuted(false), []);

  // ===== 右键：撤销上一点 / 取消 =====
  const handleContextMenu = useCallback((e: maplibregl.MapMouseEvent) => {
    e.preventDefault();
    const d = drawRef.current;
    if (d.points.length > 0) {
      d.points.pop();
      d.marks?.pop();
      if (d.points.length === 0) d.phase = 'collect';
      updatePreview();
    }
  }, [updatePreview]);

  // ===== 键盘 =====
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'Enter') finishDrawing();
      if (e.key === 'Escape') { resetDraw(); setMode('select'); useEditorStore.getState().setRouteEdit('none'); }

      if ((e.key === 'Delete' || e.key === 'Backspace')) {
        const d = drawRef.current;
        // 绘制中：Backspace 撤销上一个点
        if (DRAW_MODES.includes(useInteractionStore.getState().mode) && d.points.length > 0 && e.key === 'Backspace') {
          e.preventDefault();
          d.points.pop();
          d.marks?.pop();
          if (d.points.length === 0) d.phase = 'collect';
          updatePreview();
          return;
        }
        // 有选中元素先删元素；没有元素而选中了图层才删整层（图层选中态现在常驻，不再与元素互斥）
        const layerId = useEditorStore.getState().selectedLayerId;
        const id = useEditorStore.getState().selectedElementId;
        if (id) {
          e.preventDefault();
          const el = project.elements.find((x) => x.id === id);
          void confirm({
            message: `删除「${el?.name || '元素'}」？`,
            danger: true,
            confirmText: '删除',
          }).then((ok) => {
            if (!ok) return;
            useProjectStore.getState().deleteElement(id);
            selectElement(null);
          });
        } else if (layerId) {
          e.preventDefault();
          const L = useProjectStore.getState().project?.layers.find((x) => x.id === layerId);
          if (!L) return;
          void confirm({
            message: `删除图层「${L.name}」及其 ${L.elements.length} 个元素？`,
            danger: true,
            confirmText: '删除',
          }).then((ok) => {
            if (!ok) return;
            useProjectStore.getState().deleteLayer(layerId);
            useEditorStore.getState().selectLayer(null);
            selectElement(null);
          });
        } else if (useEditorStore.getState().fxSelId) {
          // 选中了特效/弹窗项：Del 删除该项（天气/画面/弹窗）
          e.preventDefault();
          const fxId = useEditorStore.getState().fxSelId;
          const ch = useProjectStore.getState().project;
          const sfx = ch?.fx?.find((f) => f.id === fxId);
          const ov = ch?.overlays?.find((o) => o.id === fxId);
          if (!sfx && !ov) return;
          void confirm({
            message: `删除「${sfx?.name || ov?.name || '特效'}」？`,
            danger: true,
            confirmText: '删除',
          }).then((ok) => {
            if (!ok) return;
            const s2 = useProjectStore.getState();
            if (sfx) s2.removeScreenFx(sfx.id);
            else if (ov) s2.deleteOverlay(ov.id);
            useEditorStore.getState().setFxSelId(null);
          });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finishDrawing, project.id, setMode, selectElement, resetDraw, updatePreview]);

  // ===== 每次渲染同步最新回调，供一次性注册的地图事件调用 =====
  handlersRef.current = {
    handleClick, handleDblClick, handleMouseDown, handleContextMenu,
    handleHover, handleHoverOut, handleWindowMouseMove, handleWindowMouseUp,
    // 交互（缩放/平移/倾斜）结束：按新 zoom 重算 zoom 相关几何（如飞行路线悬空高度、箭头像素宽度）
    handleMoveEnd: () => setStyleTick((n) => n + 1),
  };

  // ===== 选中高亮 =====
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const sourceId = 'selection-highlight';

    // 清理旧图层
    ['selection-line', 'selection-fill', 'selection-point'].forEach((id) => {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    if (map.getSource(sourceId)) map.removeSource(sourceId);

    const el = project.elements.find((x) => x.id === selectedElementId);
    if (!el) return;
    // 路线类元素不做线状高亮，顶点标识已足够
    if (el.type === 'line' || el.type === 'moving_point' || el.type === 'arrow' || el.type === 'double_arrow') return;
    if (el.type === 'polygon' || el.type === 'encirclement' || el.type === 'gathering') return;

    const feature = buildSelectionFeature(el);
    if (!feature) return;

    const data = { type: 'FeatureCollection', features: [feature] };
    try {
    const geomType = feature.geometry?.type;

    map.addSource(sourceId, { type: 'geojson', data } as any);

    // 仅对面状几何添加填充层
    if (geomType === 'Polygon' || geomType === 'MultiPolygon') {
      map.addLayer({
        id: 'selection-fill', type: 'fill', source: sourceId,
        paint: { 'fill-color': '#FFD700', 'fill-opacity': 0.12 },
      });
    }
    // 线状几何 + 面状几何都添加描边层
    if (geomType === 'LineString' || geomType === 'MultiLineString' || geomType === 'Polygon' || geomType === 'MultiPolygon') {
      map.addLayer({
        id: 'selection-line', type: 'line', source: sourceId,
        paint: { 'line-color': '#FFD700', 'line-width': 6, 'line-opacity': 0.55 },
      });
    }
    // 点状几何添加圆形高亮
    if (geomType === 'Point') {
      map.addLayer({
        id: 'selection-point', type: 'circle', source: sourceId,
        paint: {
          'circle-radius': 14,
          'circle-color': '#FFD700',
          'circle-opacity': 0.25,
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#FFD700',
        },
      });
    }
    } catch { /* style 未就绪：下次选择或 load 后（styleTick）重试 */ }
  }, [selectedElementId, project, styleTick]);

  // ===== 选中变化：路径点编辑模式自动复位 =====
  useEffect(() => {
    const map0 = mapRef.current;
    if (routeEditMode !== 'add' && map0 && map0.getLayer('route-add-preview')) {
      map0.setLayoutProperty('route-add-preview', 'visibility', 'none');
    }
    if (routeEditMode === 'none') return;
    const el = selectedElementId ? project.elements.find((x) => x.id === selectedElementId) : null;
    const ed = editableIdSet(project, useEditorStore.getState().selectedLayerId);
    if (!el || !routePathOf(el) || (ed && !ed.has(el.id))) useEditorStore.getState().setRouteEdit('none');
  }, [selectedElementId, project, routeEditMode]);

  // ===== 路线顶点标识：所有路线元素显示路径点，选中的更大更亮 =====
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const srcId = 'vertex-markers';
    const feats: any[] = [];
    // 只画可编辑层的顶点：非激活层的顶点画出来却拖不动会误导（命中判定同样已过滤）
    const ed = editableIdSet(project, useEditorStore.getState().selectedLayerId);
    for (const el of project.elements) {
      if (ed && !ed.has(el.id)) continue;
      const path = routePathOf(el);
      if (!path) continue;
      const sel = el.id === selectedElementId;
      path.forEach((c, i) => feats.push(turf.point(c, { eid: el.id, idx: i, sel, kind: i === 0 ? 'start' : i === path.length - 1 ? 'end' : 'mid' })));
    }
    const data = turf.featureCollection(feats);
    try {
      if (map.getSource(srcId)) {
        (map.getSource(srcId) as any).setData(data);
        if (map.getLayer('vertex-dot')) map.moveLayer('vertex-dot'); // 保持顶点在图形前面
      } else {
        map.addSource(srcId, { type: 'geojson', data } as any);
        map.addLayer({
          id: 'vertex-dot', type: 'circle', source: srcId,
          paint: {
            'circle-radius': ['case', ['get', 'sel'], 8, 5],
            'circle-color': ['match', ['get', 'kind'], 'start', '#FF4444', 'end', '#3B82F6', '#FFD700'],
            'circle-stroke-color': '#FFFFFF',
            'circle-stroke-width': 2,
          },
        });
      }
    } catch { /* style 未就绪：styleTick 后重试 */ }
  }, [project, selectedElementId, styleTick, terrPlotId]);

  // ===== 播放 / 演示时隐藏编辑辅助（顶点标识 / 选中高亮） =====
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const vis = isPlaying || presenting ? 'none' : 'visible';
    // 注意：不包含 'terr-snap'（吸附指示圈）——它只由绘制悬停逻辑按需显示/隐藏，
    // 否则选中元素/项目变化时会把上次残留的蓝圈重新设为 visible。
    ['vertex-dot', 'selection-line', 'selection-fill', 'selection-point', 'selection-move'].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    });
  }, [isPlaying, presenting, project, selectedElementId, styleTick]);

  // ===== 左侧列表定位请求 =====
  const focusReq = useInteractionStore((s) => s.focusReq);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusReq) return;
    const el = project.elements.find((x) => x.id === focusReq.elementId);
    if (!el) return;

    try {
      const feature = buildSelectionFeature(el);
      if (!feature) return;
      const bbox = turf.bbox(feature);
      const isPoint = bbox[0] === bbox[2] && bbox[1] === bbox[3];
      if (isPoint) {
        map.flyTo({ center: [bbox[0], bbox[1]], zoom: Math.max(map.getZoom(), 8), duration: 600 });
      } else {
        map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 90, duration: 600, maxZoom: 11 });
      }
    } finally {
      useInteractionStore.getState().clearFocus();
    }
  }, [focusReq, project]);

  const getCursor = () => (mode === 'terr_split' ? SCISSORS_CURSOR : (mode.startsWith('add_') || routeEditMode === 'add') ? 'crosshair' : 'default');

  /** Update View：镜头流有选中视角 → 更新该视角；无选中 → 新增视角 */
  const handleUpdateView = useCallback(() => {
    const st = useProjectStore.getState();
    if (!st.project) return;
    const ch = [st.project].find((c) => c.id === project.id) || project;
    const cam = useEditorStore.getState().currentCamera;
    const fps = st.project.globalConfig.defaultFPS;
    let frame = Math.max(0, Math.round(useEditorStore.getState().currentFrame));
    const kfs = [...(ch.camera || [])].sort((a, b) => a.frame - b.frame);

    // 当前播放头所在的视角（与时间线自动选中同一套区间判定）；不在任何视角区间 → null。
    // 不能用 selectedKeyframeIdx：只有 1 个视角时时间线会恒选第 0 个，
    // 拖动播放头到别处再「更新视角」就会误改第 0 帧那个视角。
    const activeIdx = (() => {
      if (kfs.length === 0) return null;
      if (frame <= kfs[0].frame) return 0;
      for (let i = 1; i < kfs.length; i++) {
        const prev = kfs[i - 1];
        const kf = kfs[i];
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
        if (frame >= start && frame <= end) return i;
      }
      return null;
    })();

    // 无镜头流 / 播放头不在任何视角区间 → 在播放头处新增视角
    if (kfs.length === 0 || activeIdx === null) {
      while (kfs.some((k) => Math.abs(k.frame - frame) < 1)) frame += fps;
      // 前一个视角：所有 frame < 新 frame 的视角中最大者（中间插入时不能用最后一个视角）
      const prevKfs = kfs.filter((k) => k.frame < frame);
      const prevF = prevKfs.length ? prevKfs[prevKfs.length - 1].frame : 0;
      const newKf: CameraKeyframe = {
        frame, center: [cam.center[0], cam.center[1]], zoom: cam.zoom,
        pitch: cam.pitch || 0, bearing: cam.bearing || 0, easing: 'easeInOut',
        moveDuration: Math.min(2 * fps, Math.max(0, frame - prevF)),
      };
      const next = [...kfs, newKf].sort((a, b) => a.frame - b.frame);
      st.setProjectCamera(next);
      useEditorStore.getState().selectKeyframe(next.findIndex((k) => k.frame === frame));
      useEditorStore.getState().setCurrentFrame(frame);
      setViewSaved(true);
      setTimeout(() => setViewSaved(false), 1200);
      return;
    }

    // 命中视角 → 更新它
    const idx = Math.min(activeIdx, kfs.length - 1);
    const target = kfs[idx];
    const isOrbit = target.cameraType === 'orbit' || !!target.orbit;
    const isFollow = target.cameraType === 'follow' || !!target.followRoute;
    kfs[idx] = {
      ...target,
      // 环绕视角：保留环绕中心与环绕配置，只更新俯仰/缩放
      ...(isOrbit ? { center: target.center, zoom: cam.zoom, pitch: cam.pitch || 0 } : {}),
      ...(isFollow ? { center: target.center, zoom: cam.zoom, pitch: cam.pitch || 0 } : {}),
      ...(!isOrbit && !isFollow
        ? { center: [cam.center[0], cam.center[1]], zoom: cam.zoom, pitch: cam.pitch || 0, bearing: cam.bearing || 0 }
        : {}),
    };
    st.setProjectCamera(kfs);
    useEditorStore.getState().selectKeyframe(idx);
    // 播放头吸附到该视角的到达帧：镜头插值 effect 会精确返回刚保存的画面，
    // 避免飞行窗口内播放头继续插值、把刚保存的视角拽回旧位置。
    const tgtFrame = kfs[idx].frame;
    useEditorStore.getState().setCurrentFrame(tgtFrame);
    setViewSaved(true);
    setTimeout(() => setViewSaved(false), 1200);
  }, [project]);

  /** ⟳ 预览：飞到"播放头所在视角"的原始设置 */
  const handlePreviewKf = useCallback(() => {
    const st = useProjectStore.getState();
    if (!st.project) return;
    const ch = [st.project].find((c) => c.id === project.id) || project;
    const kfs = [...(ch.camera || [])].sort((a, b) => a.frame - b.frame);
    if (kfs.length === 0) return;
    const frame = Math.max(0, Math.round(useEditorStore.getState().currentFrame));
    const fps = st.project.globalConfig.defaultFPS;const idx = resolveKfIndex(kfs, frame, fps);
    const kf = kfs[Math.max(0, idx)];
    const prevF = idx > 0 ? kfs[idx - 1].frame : 0;
    const moveFrames = typeof kf.moveDuration === 'number' ? Math.min(kf.moveDuration, kf.frame - prevF) : Math.min(2 * fps, kf.frame - prevF);
    useEditorStore.getState().seekCamera(
      { center: kf.center, zoom: kf.zoom, pitch: kf.pitch || 0, bearing: kf.bearing || 0 },
      kf.easing || 'linear',
      Math.max(0.2, Math.min(6, moveFrames / st.project.globalConfig.defaultFPS))
    );
  }, [project]);

  /** 添加跟随视角：center 动态跟随选中路线的动画进度点 */
  const handleFollowView = useCallback(() => {
    const st = useProjectStore.getState();
    if (!st.project) return;
    const ch = [st.project].find((c) => c.id === project.id) || project;
    const selId = useEditorStore.getState().selectedElementId;
    if (!selId) { void confirm({ message: '请先在地图上选中一条路线，再添加跟随视角', confirmText: '知道了', danger: false }); return; }
    const route = ch.elements.find((e) => e.id === selId);
    if (!route || (route.type !== 'line' && route.type !== 'moving_point' && route.type !== 'arrow')) {
      void confirm({ message: '请选中一条路线（直线/曲线/箭头）来跟随', confirmText: '知道了', danger: false });
      return;
    }
    const startF = route.startFrame;
    const endF = route.endFrame;
    // 校验：现有视角 frame 是否落在该路线的显示时间区间内
    const kfs = [...(ch.camera || [])].sort((a, b) => a.frame - b.frame);
    const conflict = kfs.find((k) => k.frame >= startF && k.frame <= endF);
    if (conflict) {
      void confirm({ message: `现有视角（t=${((conflict.frame - 0) / st.project.globalConfig.defaultFPS).toFixed(1)}s）落在该路线的显示时间区间内，无法添加跟随视角`, confirmText: '知道了', danger: true });
      return;
    }
    const cam = useEditorStore.getState().currentCamera;
    const fps = st.project.globalConfig.defaultFPS;
    // 跟随视角帧 = 路线显示开始（保证不与区间内现有视角冲突）
    const frame = Math.max(0, startF);
    const newKf: CameraKeyframe = {
      frame,
      center: [cam.center[0], cam.center[1]] as [number, number],
      zoom: cam.zoom,
      pitch: cam.pitch || 0,
      bearing: cam.bearing || 0,
      easing: 'easeInOut',
      moveDuration: Math.min(2 * fps, Math.max(0, frame - (kfs.length ? kfs[kfs.length - 1].frame : 0))),
      cameraType: 'follow' as const,
      followRoute: { routeElementId: route.id, followDirection: true, startFrame: startF, endFrame: endF },
    };
    const next = [...kfs, newKf].sort((a, b) => a.frame - b.frame);
    st.setProjectCamera(next);
    useEditorStore.getState().selectKeyframe(next.findIndex((k) => k === newKf));
    // 点击「跟随」不跳转播放头/视角（视角保持当前地图画面，播放时才跟随）
    setViewSaved(true);
    setTimeout(() => setViewSaved(false), 1200);
  }, [project, confirm]);

  /** 添加环绕视角：相机绕当前中心点旋转（bearing 随时间变化） */
  const handleOrbitView = useCallback(() => {
    const st = useProjectStore.getState();
    if (!st.project) return;
    const ch = [st.project].find((c) => c.id === project.id) || project;
    const cam = useEditorStore.getState().currentCamera;
    const fps = st.project.globalConfig.defaultFPS;
    const frame = Math.max(0, Math.round(useEditorStore.getState().currentFrame));
    // 环绕时长默认 2 秒
    const orbitDur = 2;
    const kfs = [...(ch.camera || [])].sort((a, b) => a.frame - b.frame);
    const spanStart = frame;
    const spanEnd = frame + orbitDur * fps;
    // 校验：与其他视角时间是否重叠（frame 落在 [spanStart, spanEnd]）
    const conflict = kfs.find((k) => k.frame >= spanStart && k.frame <= spanEnd);
    if (conflict) {
      void confirm({ message: `环绕视角时长 ${orbitDur}s，与现有视角（t=${((conflict.frame - 0) / fps).toFixed(1)}s）时间重叠，无法添加`, confirmText: '知道了', danger: true });
      return;
    }
    const newKf: CameraKeyframe = {
      frame,
      center: [cam.center[0], cam.center[1]] as [number, number],
      zoom: cam.zoom,
      pitch: cam.pitch || 0,
      bearing: cam.bearing || 0,
      easing: 'easeInOut',
      cameraType: 'orbit',
      orbit: { speed: 45, duration: orbitDur },
    };
    const next = [...kfs, newKf].sort((a, b) => a.frame - b.frame);
    st.setProjectCamera(next);
    useEditorStore.getState().selectKeyframe(next.findIndex((k) => k === newKf));
    useEditorStore.getState().setCurrentFrame(frame);
    setViewSaved(true);
    setTimeout(() => setViewSaved(false), 1200);
  }, [project, confirm]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" style={{ cursor: getCursor() }} />

      {/* TILT 倾斜滑块已移除（俯仰在右侧视角属性中设置） */}

      {/* 视角工具条（Mapimator 风格胶囊）：更新视角 / 预览飞回 / 收起；播放预览时隐藏 */}
      {mode === 'select' && !viewBarHidden && !isPlaying && !presenting && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[30] flex items-center gap-1 h-10 px-1.5 rounded-full bg-[#1c1917]/95 backdrop-blur border border-white/10 shadow-lg">
          <button
            onClick={handleUpdateView}
            className="h-8 px-3 flex items-center gap-1.5 rounded-full text-xs font-medium text-foreground/85 hover:bg-white/10 transition-colors"
            title="把当前地图视角写入「播放头所在视角」的关键帧"
          >
            <Camera size={14} className="text-muted-foreground" />
            更新视角
          </button>
          <button
            onClick={handleFollowView}
            className="h-8 px-3 flex items-center gap-1.5 rounded-full text-xs font-medium text-foreground/85 hover:bg-white/10 transition-colors"
            title="添加跟随视角：center 跟随选中路线的动画进度"
          >
            <Camera size={14} className="text-muted-foreground" />
            跟随
          </button>
          <button
            onClick={handleOrbitView}
            className="h-8 px-3 flex items-center gap-1.5 rounded-full text-xs font-medium text-foreground/85 hover:bg-white/10 transition-colors"
            title="添加环绕视角：相机绕当前中心点旋转"
          >
            <Camera size={14} className="text-muted-foreground" />
            环绕视角
          </button>
          <button
            onClick={handlePreviewKf}
            className="w-8 h-8 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
            title="预览：飞回「播放头所在视角」的原始设置"
          >
            <RotateCcw size={14} />
          </button>
          <div className="w-px h-4 bg-white/10 mx-0.5" />
          <button
            onClick={() => setViewBarHidden(true)}
            className="w-8 h-8 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors"
            title="收起视角工具"
          >
            <ChevronDown size={14} />
          </button>
          {viewSaved && (
            <span className="absolute -top-7 left-1/2 -translate-x-1/2 text-[11px] text-emerald-400 bg-black/80 rounded px-2 py-0.5 whitespace-nowrap">已更新所在视角</span>
          )}
        </div>
      )}
      {mode === 'select' && viewBarHidden && !isPlaying && !presenting && (
        <button
          onClick={() => setViewBarHidden(false)}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[30] w-9 h-9 flex items-center justify-center rounded-full bg-[#1c1917]/95 backdrop-blur border border-white/10 shadow-lg text-muted-foreground hover:text-foreground transition-colors"
          title="展开视角工具"
        >
          <Camera size={15} />
        </button>
      )}

      {mode !== 'select' && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/75 text-white px-4 py-2 rounded text-xs z-20 whitespace-nowrap">
          {modeHint(mode)}
        </div>
      )}
    </div>
  );
}

// ========== 提示文案 ==========

function modeHint(mode: string): string {
  switch (mode) {
    case 'add_point': return '点击地图放置标记点';
    case 'add_text': return '点击地图放置文字贴片（右侧可改内容/样式）';
    case 'add_moving_line': return '单击加路径点(≥2个) · 双击完成 · Backspace撤销 · Esc取消';
    case 'add_moving_bezier': return '单击加控制点(≥2个) · 双击完成生成曲线路径 · Esc取消';
    case 'add_flag': return '点击地图插旗';
    case 'add_line': return '单击加点 · 双击完成 · Backspace撤销 · Esc取消';
    case 'add_bezier': return '单击加控制点(≥2个) · 双击完成生成曲线 · Esc取消';
    case 'add_line_arc': return '单击加点(≥2个) · 双击完成 · 相邻点按地球大圆展开';
    case 'add_rect': return '第1击定对角 → 移动预览 → 第2击生成矩形';
    case 'add_polygon': return '单击加顶点(≥3个) · 双击完成闭合 · Backspace撤销 · Esc取消';
    case 'add_region': return '点击国土 → 按边界自动生成高亮区域（跨海国家会拆为多个面）';
    case 'add_arrow': return '第1击定起点 → 移动预览 → 第2击定终点';
    case 'add_curved': return '单击加控制点(≥2个) · 双击完成生成曲线箭头 · Esc取消';
    case 'add_attack': return '单击加控制点(≥2个) · 双击完成生成进攻箭头 · Esc取消';
    case 'add_pincer': return '单击加控制点(4个) · 自动生成双箭头钳形攻势 · Esc取消';
    case 'add_encirclement': return '第1击定圆心 → 移动调半径 → 第2击确认';
    case 'add_gathering': return '第1击定中心 → 移动调半径 → 第2击确认';
    case 'add_shape_line': return '单击加点 · 双击完成(标注直线) · Esc取消';
    case 'add_shape_bezier': return '单击加控制点(≥2) · 双击完成曲线 · Esc取消';
    case 'add_shape_line_arrow': return '单击加点 · 双击完成带箭头直线 · Esc取消';
    case 'add_shape_bezier_arrow': return '单击加控制点(≥2) · 双击完成带箭头曲线 · Esc取消';
    case 'add_shape_march': return '单击加控制点(≥2) · 双击完成行军箭头 · Esc取消';
    case 'add_shape_swallowtail': return '单击加控制点(≥2) · 双击完成燕尾箭头 · Esc取消';
    case 'add_shape_poly_curve': return '单击加顶点(≥3) · 双击完成曲线多边(边曲线化) · Esc取消';
    case 'add_shape_poly_defend': return '单击加顶点(≥3) · 双击完成直线防御圈(锯齿) · Esc取消';
    case 'add_shape_poly_curve_defend': return '单击加顶点(≥3) · 双击完成曲线防御圈(曲线+锯齿) · Esc取消';
    case 'add_shape_circle': return '第1击定圆心 → 移动调半径 → 第2击确认（不可旋转）';
    case 'add_shape_star': return '第1击定中心 → 移动调半径 → 第2击确认五角星';
    case 'add_special_swallow': return '单击加控制点(≥2) · 双击完成自定义燕尾箭头 · Esc取消';
    case 'add_shape_front_line': return '单击加点 · 双击完成直线战线（一侧梳齿） · Esc取消';
    case 'add_shape_front_curve': return '单击加控制点(≥2) · 双击完成弯曲战线（一侧梳齿） · Esc取消';
    case 'add_terr_plot': return '单击加顶点(≥3) · 靠邻边吸附，两点间自动描幕边界(Alt反向/Ctrl直连) · 双击完成 · 空笔双击已有地块=编辑边界 · Esc取消';
    case 'terr_split': return '点两下画一条切线（两端落在地块外）→ 切开当前编辑地块 · Esc取消';
    case 'terr_annex': return '点击地块加入/移出选择 · 双击地块编辑边界 · 右侧面板「生成兼并事件」 · Esc取消';
    default: return '';
  }
}

// ========== 辅助函数 ==========

// 注：底图 + 高程的 style 解析已抽到 lib/map-style.ts，由编辑端与导出端共用
// （此前两端各写一份 getStyleUrl 并已漂移）。

/** 路线类元素的可编辑路径点（line/moving_point/arrow/double_arrow） */
/** 路线类元素的可编辑路径点（line/moving_point/arrow/double_arrow/polygon等形状） */
function routePathOf(el: MapElement): [number, number][] | null {
  if (el.type === 'line') return (el.coordinates?.length ?? 0) >= 2 ? el.coordinates : null;
  if (el.type === 'moving_point') return (el.path?.length ?? 0) >= 2 ? el.path : null;
  if (el.type === 'arrow') {
    if (el.path && el.path.length >= 2) return el.path;
    return el.from && el.to ? [el.from, el.to] : null;
  }
  if (el.type === 'double_arrow') return (el.points?.length ?? 0) >= 2 ? el.points : null;
  if (el.type === 'polygon') {
    // 形状：rect=对角点（随 rotation 显示在旋转后位置）；circle/star=中心+半径顶点；poly=顶点（去闭合点）
    if (el.shapeKind === 'rect' && el.rectMeta) {
      const cx = (el.rectMeta.c1[0] + el.rectMeta.c2[0]) / 2;
      const cy = (el.rectMeta.c1[1] + el.rectMeta.c2[1]) / 2;
      return [
        rotatePt(el.rectMeta.c1, [cx, cy], el.rotation || 0),
        rotatePt(el.rectMeta.c2, [cx, cy], el.rotation || 0),
      ];
    }
    if (el.shapeKind === 'circle' && el.circleMeta) {
      return [el.circleMeta.center, circleRadiusHandle(el.circleMeta.center, el.circleMeta.radius, el.rotation || 0)];
    }
    if (el.shapeKind === 'star' && el.starMeta) {
      return [el.starMeta.center, starRadiusHandle(el.starMeta.center, el.starMeta.radius, el.rotation || 0)];
    }
    const ring = el.coordinates[0];
    if (!ring || ring.length < 3) return null;
    const closeGap = Math.abs(ring[0][0] - ring[ring.length - 1][0]) < 1e-9 && Math.abs(ring[0][1] - ring[ring.length - 1][1]) < 1e-9;
    return closeGap ? ring.slice(0, -1) : ring;
  }
  if (el.type === 'gathering') {
    return [el.center, circleRadiusHandle(el.center, el.radius, el.rotation || 0)];
  }
  if (el.type === 'encirclement') {
    return [el.center, circleRadiusHandle(el.center, el.radius)];
  }
  if (el.type === 'territory') {
    // 疆域：编辑当前选中的地块外环（terrPlotId 在疆域面板点「⊙」设定；悬空/未设时兜底到第一个地块，
    // 避免 alt 删点/删除地块/切换元素后编辑点消失）
    const terr = el as TerritoryElement;
    const plot = terr.plots.find((p) => p.id === useEditorStore.getState().terrPlotId) || terr.plots[0];
    if (!plot?.rings?.[0] || plot.rings[0].length < 3) return null;
    const ring = plot.rings[0];
    const closed = Math.abs(ring[0][0] - ring[ring.length - 1][0]) < 1e-9 && Math.abs(ring[0][1] - ring[ring.length - 1][1]) < 1e-9;
    return closed ? ring.slice(0, -1) : ring;
  }
  if (el.type === 'geo_image') {
    // 贴图：控制点网格即可拖拽的配准点
    return (el.grid?.length ?? 0) >= 4 ? el.grid : null;
  }
  return null;
}

/** 圆/集结点等的半径手柄点（中心方向 rotatePt([r/111,0], rot)，即旋转后的东向点） */
function circleRadiusHandle(center: [number, number], radiusKm: number, rotDeg = 0): [number, number] {
  return rotatePt([center[0] + radiusKm / 111, center[1]], center, rotDeg);
}

/** 五角星半径手柄点：旋转后的第一个外顶点（星形渲染的首个外顶点角度 = -90°） */
function starRadiusHandle(center: [number, number], radiusKm: number, rotDeg = 0): [number, number] {
  return rotatePt([center[0], center[1] - radiusKm / 111], center, rotDeg);
}

/** 顶点拖拽写回：按元素类型更新对应字段；返回是否已写。bbox=地图容器盒。 */
function patchElementVertex(el: MapElement, idx: number, clientX: number, clientY: number, bbox: DOMRect, map: maplibregl.Map, _chapterId: string): boolean {
  const lngLat = map.unproject([clientX - bbox.left, clientY - bbox.top]);
  const pt: [number, number] = [lngLat.lng, lngLat.lat];

  if (el.type === 'moving_point' || el.type === 'arrow') {
    const path = el.path && el.path.length >= 2 ? el.path : (el.type === 'arrow' && el.from ? [el.from, el.to!] : null);
    if (!path || idx >= path.length) return false;
    const c = path.map((p) => [p[0], p[1]] as [number, number]);
    c[idx] = pt;
    useProjectStore.getState().updateElement(el.id, { path: c } as Partial<MapElement>);
    return true;
  }
  if (el.type === 'double_arrow') {
    if (idx >= el.points.length) return false;
    const c = el.points.map((p) => [p[0], p[1]] as [number, number]);
    c[idx] = pt;
    useProjectStore.getState().updateElement(el.id, { points: c } as Partial<MapElement>);
    return true;
  }
  if (el.type === 'line') {
    if (idx >= el.coordinates.length) return false;
    const c = el.coordinates.map((p) => [p[0], p[1]] as [number, number]);
    c[idx] = pt;
    useProjectStore.getState().updateElement(el.id, { coordinates: c } as Partial<MapElement>);
    return true;
  }
  if (el.type === 'polygon') {
    if (el.shapeKind === 'rect' && el.rectMeta) {
      if (idx > 1) return false;
      // 手柄是旋转后的显示位置：逆旋转回来再写对角点，保持 rotation 不变
      const rot = el.rotation || 0;
      const cx = (el.rectMeta.c1[0] + el.rectMeta.c2[0]) / 2;
      const cy = (el.rectMeta.c1[1] + el.rectMeta.c2[1]) / 2;
      const invPt = rotatePt(pt, [cx, cy], -rot);
      const c1 = idx === 0 ? invPt : el.rectMeta.c1;
      const c2 = idx === 1 ? invPt : el.rectMeta.c2;
      useProjectStore.getState().updateElement(el.id, {
        rectMeta: { c1, c2 },
        coordinates: [shapeRectRing(c1, c2)],
      } as Partial<MapElement>);
      return true;
    }
    if ((el.shapeKind === 'circle' && el.circleMeta) || (el.shapeKind === 'star' && el.starMeta)) {
      const meta = el.shapeKind === 'circle' ? el.circleMeta! : el.starMeta!;
      if (idx === 0) {
        const patch = el.shapeKind === 'circle'
          ? { circleMeta: { ...meta, center: pt } as PolygonElement['circleMeta'], coordinates: [circleCoords(pt, meta.radius)] }
          : { starMeta: { ...meta, center: pt } as PolygonElement['starMeta'], coordinates: [polyStarCoords(pt, meta.radius)] };
        useProjectStore.getState().updateElement(el.id, patch as Partial<MapElement>);
        return true;
      }
      if (idx === 1) {
        const rkm = Math.max(0.5, turf.distance(meta.center, pt, { units: 'kilometers' }));
        const patch = el.shapeKind === 'circle'
          ? { circleMeta: { ...meta, radius: rkm } as PolygonElement['circleMeta'], coordinates: [circleCoords(meta.center, rkm)] }
          : { starMeta: { ...meta, radius: rkm } as PolygonElement['starMeta'], coordinates: [polyStarCoords(meta.center, rkm)] };
        useProjectStore.getState().updateElement(el.id, patch as Partial<MapElement>);
        return true;
      }
      return false;
    }
    // 普通多边形：仅当是合环比率映射（poly）
    const ring = el.coordinates[0];
    if (!ring || ring.length < 3) return false;
    const closed = Math.abs(ring[0][0] - ring[ring.length - 1][0]) < 1e-9 && Math.abs(ring[0][1] - ring[ring.length - 1][1]) < 1e-9;
    if (idx >= ring.length - (closed ? 1 : 0)) return false;
    const c = ring.map((p) => [p[0], p[1]] as [number, number]);
    c[idx] = pt;
    // 闭合环的末尾闭合点与首点本就是同一几何点：拖起点(idx 0)时若不同步改它，
    // 闭合点会残留在原位置，导致图形不随动（直线）或 smoothClosedRing 追加首点多出一条边（曲线）。
    if (closed) c[c.length - 1] = c[0];
    useProjectStore.getState().updateElement(el.id, { coordinates: [c] } as Partial<MapElement>);
    return true;
  }
  if (el.type === 'gathering') {
    const rkm = idx === 0 ? el.radius : Math.max(0.5, turf.distance(el.center, pt, { units: 'kilometers' }));
    const center = idx === 0 ? pt : el.center;
    useProjectStore.getState().updateElement(el.id, { center, radius: rkm } as Partial<MapElement>);
    return true;
  }
  if (el.type === 'encirclement') {
    const rkm = idx === 0 ? el.radius : Math.max(0.5, turf.distance(el.center, pt, { units: 'kilometers' }));
    const center = idx === 0 ? pt : el.center;
    useProjectStore.getState().updateElement(el.id, { center, radius: rkm } as Partial<MapElement>);
    return true;
  }
  if (el.type === 'territory') {
    // 疆域：拖拽顶点 → 同键共享顶点在所有地块中同步移动（边界不裂缝）；
    // 落点邻近其他顶点(≤8px)时焊合为共享顶点。
    const terr = el as TerritoryElement;
    const pid = useEditorStore.getState().terrPlotId;
    const plot = terr.plots.find((p) => p.id === pid);
    if (!plot?.rings?.[0] || plot.rings[0].length < 3) return false;
    const ring = plot.rings[0];
    const closed = Math.abs(ring[0][0] - ring[ring.length - 1][0]) < 1e-9 && Math.abs(ring[0][1] - ring[ring.length - 1][1]) < 1e-9;
    if (idx >= ring.length - (closed ? 1 : 0)) return false;
    let target = pt;
    // 焊点仅对其他地块的顶点（≤8px）：避免把同环相邻顶点焊死（零长度边/塌边）
    const weld = terrSnapNear(map, pt, [terr], { vertexPx: 8, edgePx: 0, excludePlotId: pid, excludeKey: coordKey(ring[idx]) });
    if (weld?.kind === 'vertex') target = weld.pt;
    const nextPlots = moveSharedVertices(terr.plots, ring[idx], target);
    useProjectStore.getState().updateElement(el.id, { plots: nextPlots } as Partial<MapElement>);
    return true;
  }
  if (el.type === 'geo_image') {
    if (!el.grid || idx >= el.grid.length) return false;
    const g = el.grid.map((p) => [p[0], p[1]] as [number, number]);
    g[idx] = pt;
    useProjectStore.getState().updateElement(el.id, { grid: g } as Partial<MapElement>);
    return true;
  }
  return false;
}

/** 矩形环（对角点，逆时针闭环） */
function shapeRectRing(c1: [number, number], c2: [number, number]): [number, number][] {
  return [[c1[0], c1[1]], [c2[0], c1[1]], [c2[0], c2[1]], [c1[0], c2[1]], [c1[0], c1[1]]];
}

/** 命中检测：屏幕 25px 内最近的路线顶点 */
function hitRouteVertex(map: maplibregl.Map, point: maplibregl.PointLike, elements: MapElement[], preferId?: string | null, editable?: Set<string> | null): { eid: string; idx: number } | null {
  const pt = point as maplibregl.Point;
  if (editable) elements = elements.filter((el) => editable.has(el.id));
  const hitIn = (els: MapElement[]): { eid: string; idx: number } | null => {
    let best: { eid: string; idx: number } | null = null;
    let bestD = 25;
    for (const el of els) {
      const path = routePathOf(el);
      if (!path) continue;
      for (let i = 0; i < path.length; i++) {
        const p = map.project(path[i] as [number, number]);
        const d = Math.hypot(p.x - pt.x, p.y - pt.y);
        if (d < bestD) { bestD = d; best = { eid: el.id, idx: i }; }
      }
    }
    return best;
  };
  // 选中元素的顶点优先（避免其他路线重叠顶点抢命中）
  const sel = preferId ? elements.find((e) => e.id === preferId) : null;
  if (sel) {
    const hit = hitIn([sel]);
    if (hit) return hit;
  }
  return hitIn(elements.filter((e) => e.id !== preferId));
}

/** 疆域吸附目标：顶点优先、其次边；仅命中屏幕像素阈值内的目标 */
interface TerrSnap { kind: 'vertex' | 'edge'; pt: [number, number]; elId: string; pid: string; vi: number }

function terrSnapNear(
  map: maplibregl.Map, cursor: [number, number], terrs: TerritoryElement[],
  opts: { vertexPx: number; edgePx: number; excludePlotId?: string | null; excludeKey?: string | null },
): TerrSnap | null {
  const win = pixelsToDegrees(Math.max(opts.vertexPx, opts.edgePx) * 2 + 4, map.getZoom(), cursor[1]) * 2;
  const cpx = map.project(cursor);
  let bestV: (Omit<TerrSnap, 'kind'> & { px: number }) | null = null;
  let bestE: (Omit<TerrSnap, 'kind' | 'vi'> & { px: number }) | null = null;
  const segInWin = (a: [number, number], b: [number, number]) =>
    !((a[0] < cursor[0] - win && b[0] < cursor[0] - win) || (a[0] > cursor[0] + win && b[0] > cursor[0] + win))
    && !((a[1] < cursor[1] - win && b[1] < cursor[1] - win) || (a[1] > cursor[1] + win && b[1] > cursor[1] + win));
  for (const terr of terrs) {
    for (const plot of terr.plots) {
      if (opts.excludePlotId && plot.id === opts.excludePlotId) continue;
      for (const ring of plot.rings) {
        const open = ringOpen(ring);
        // 顶点
        for (let i = 0; i < open.length; i++) {
          const p = open[i];
          if (Math.abs(p[0] - cursor[0]) > win || Math.abs(p[1] - cursor[1]) > win) continue;
          if (opts.excludeKey && coordKey(p) === opts.excludeKey) continue;
          const sp = map.project(p as [number, number]);
          const d = Math.hypot(sp.x - cpx.x, sp.y - cpx.y);
          if (d <= opts.vertexPx && (!bestV || d < bestV.px)) bestV = { px: d, pt: p, elId: terr.id, pid: plot.id, vi: i };
        }
        // 边（先框选，再屏幕像素精确测距；长直边也能命中中部）
        if (opts.edgePx <= 0) continue;
        for (let i = 0; i < open.length; i++) {
          const a = open[i], b = open[(i + 1) % open.length];
          if (!segInWin(a, b)) continue;
          const pa = map.project(a as [number, number]), pb = map.project(b as [number, number]);
          const dx = pb.x - pa.x, dy = pb.y - pa.y;
          const L2 = dx * dx + dy * dy;
          const t = L2 > 0 ? Math.max(0, Math.min(1, ((cpx.x - pa.x) * dx + (cpx.y - pa.y) * dy) / L2)) : 0;
          const qx = pa.x + dx * t, qy = pa.y + dy * t;
          const d = Math.hypot(qx - cpx.x, qy - cpx.y);
          if (d <= opts.edgePx && (!bestE || d < bestE.px)) {
            const ll = map.unproject([qx, qy]);
            bestE = { px: d, pt: [ll.lng, ll.lat], elId: terr.id, pid: plot.id };
          }
        }
      }
    }
  }
  if (bestV) return { kind: 'vertex', pt: bestV.pt, elId: bestV.elId, pid: bestV.pid, vi: bestV.vi };
  if (bestE) return { kind: 'edge', pt: bestE.pt, elId: bestE.elId, pid: bestE.pid, vi: -1 };
  return null;
}

/** 边吸附点 → 最近环顶点索引（描摹起止定位用） */
function nearestRingVertexIndex(ring: [number, number][], pt: [number, number]): number {
  const open = ringOpen(ring);
  const k = Math.cos((pt[1] * Math.PI) / 180) || 1e-9;
  let best = 0, bestD = Infinity;
  for (let i = 0; i < open.length; i++) {
    const p = open[i];
    const d = ((p[0] - pt[0]) * k) ** 2 + (p[1] - pt[1]) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** 疆域吸附指示圈（vertex=白 / edge=蓝），置于最上层 */function updateTerrSnapMarker(map: maplibregl.Map, pt: [number, number], kind: 'vertex' | 'edge') {
  const data = turf.featureCollection([turf.point(pt, { kind })]);
  try {
    if (!map.getSource('terr-snap')) {
      map.addSource('terr-snap', { type: 'geojson', data } as any);
      map.addLayer({
        id: 'terr-snap', type: 'circle', source: 'terr-snap',
        paint: {
          'circle-radius': 8,
          'circle-color': ['match', ['get', 'kind'], 'edge', '#3B82F6', '#FFFFFF'],
          'circle-opacity': 0.2,
          'circle-stroke-color': ['match', ['get', 'kind'], 'edge', '#3B82F6', '#FFFFFF'],
          'circle-stroke-width': 2,
        },
      });
    } else {
      (map.getSource('terr-snap') as any).setData(data);
    }
    if (map.getLayer('terr-snap')) {
      map.setLayoutProperty('terr-snap', 'visibility', 'visible');
      map.moveLayer('terr-snap');
    }
  } catch { /* style 未就绪 */ }
}

/**
 * 当前「可编辑元素集合」：没选中图层 = 全部（否则一进编辑器就什么都点不动）；
 * 选中某图层 = 只有该图层的元素在地图上有激活态编辑效果（可点选 / 可拖 / 顶点）。
 * 图层被删掉后 selectedLayerId 会留着（撤销/重做也可能换掉图层集合）——
 * 指向不存在的图层**等同于没选**，必须回到「全部可编辑」，否则整张地图静默变成只读。
 */
function editableIdSet(project: MapVideoProject, activeLayerId: string | null): Set<string> | null {
  if (!activeLayerId) return null;
  const L = project.layers?.find((x) => x.id === activeLayerId);
  if (!L) return null;
  return new Set(L.elements.map((e) => e.id));
}

function pickElement(map: maplibregl.Map, point: maplibregl.PointLike, elements: MapElement[], editable?: Set<string> | null): string | null {
  const ok = (eid: string | null) => !!eid && (!editable || editable.has(eid));
  const layers = getAllElementLayers(map);
  if (layers.length > 0) {
    const feats = map.queryRenderedFeatures(point, { layers });
    for (const f of feats) {
      const id = f.layer?.id;
      if (id) {
        const eid = elementIdFromLayerId(id, elements);
        // 不可编辑层的元素压在上方时不能把点击吃掉：跳过它继续往下找
        if (ok(eid)) return eid;
      }
    }
  }
  // 飞行拱形（custom layer 不参与 queryRenderedFeatures）：点击点到抬升折线的屏幕距离判定
  const pickPx = Array.isArray(point) ? point[0] : point.x;
  const pickPy = Array.isArray(point) ? point[1] : point.y;
  const ribbon = pickFlyRibbon(map, pickPx, pickPy, elements);
  return ok(ribbon) ? ribbon : null;
}

function getAllElementLayers(map: maplibregl.Map): string[] {
  const style = map.getStyle();
  if (!style?.layers) return [];
  return style.layers
    .map((l: any) => l.id as string)
    .filter((id) => {
      // 排除绘制预览、选中高亮、行军光点等非元素图层
      if (id === 'draw-preview-fill' || id === 'draw-preview-line' || id === 'draw-preview-point') return false;
      if (id === 'selection-line' || id === 'selection-fill' || id === 'selection-point') return false;
      if (id.startsWith('linespot-')) return false;
      // 移动点的「全程路径虚线引导」是编辑辅助：它覆盖整条路径，纳入命中区会让
      // 虚线上任意一点都能选中/拖动那个移动图标，并吃掉它下面其它元素的点击
      if (id.startsWith('moving-guide-layer-')) return false;
      const eid = elementIdFromLayerId(id, []);
      return eid !== '';
    });
}

function elementIdFromLayerId(layerId: string, elements: MapElement[]): string {  // 提取最后一个 -layer- 或 -label- 之后的内容作为元素 id
  const layerIdx = layerId.lastIndexOf('-layer-');
  const labelIdx = layerId.lastIndexOf('-label-');
  const idx = Math.max(layerIdx, labelIdx);
  if (idx === -1) return '';
  let suffix = layerId.slice(idx + 7); // 跳过 "-layer-" 或 "-label-"

  // 优先：用真实元素 ID 精确匹配（处理 MapLibre 自动追加数字后缀的情况）
  if (elements.length > 0) {
    for (const el of elements) {
      if (suffix === el.id || suffix.startsWith(el.id + '-')) return el.id;
    }
  }

  // 回退：去掉尾部 -N 后缀
  suffix = suffix.replace(/-\d+$/, '');
  return suffix;
}

/** 整元素拖动期间的**地图源直改**（点 / 旗标）：不触碰 store，避免全量重渲染导致的拖动延迟。
 *  返回 false 表示源还没建好（尚未渲染），调用方回退到写 store。 */
function previewMoveElementOnMap(map: maplibregl.Map, el: MapElement, lngLat: [number, number]): boolean {
  const sid = el.type === 'flag' ? `flag-${el.id}` : `point-${el.id}`;
  const src = map.getSource(sid) as { setData?: (d: unknown) => void } | undefined;
  if (!src || typeof src.setData !== 'function') return false;
  const name = (el as { label?: { text?: string } }).label?.text || el.name;
  src.setData(turf.featureCollection([turf.point(lngLat, { name })]));
  return true;
}

function moveElementTo(project: MapVideoProject, elementId: string, lngLat: [number, number]) {
  const el = project.elements.find((e) => e.id === elementId);
  if (!el) return;

  if (el.type === 'point' || el.type === 'flag') {
    useProjectStore.getState().updateElement(elementId, { coordinates: lngLat });
  } else if (el.type === 'moving_point') {
    useProjectStore.getState().updateElement(elementId, { path: [lngLat, ...el.path.slice(1)] });
  } else if (el.type === 'polygon') {
    // 整体拖动：遍历所有环移动
    const base = routePathOf(el);
    if (!base || base.length === 0) return;
    const dx = lngLat[0] - base[0][0];
    const dy = lngLat[1] - base[0][1];
    const rings = el.coordinates.map((ring) => ring.map((p) => [p[0] + dx, p[1] + dy] as [number, number]));
    const meta: Partial<MapElement> = { coordinates: rings };
    if (el.shapeKind === 'circle' && el.circleMeta) {
      meta.circleMeta = { center: [el.circleMeta.center[0] + dx, el.circleMeta.center[1] + dy], radius: el.circleMeta.radius };
    } else if (el.shapeKind === 'star' && el.starMeta) {
      meta.starMeta = { center: [el.starMeta.center[0] + dx, el.starMeta.center[1] + dy], radius: el.starMeta.radius };
    } else if (el.shapeKind === 'rect' && el.rectMeta) {
      meta.rectMeta = {
        c1: [el.rectMeta.c1[0] + dx, el.rectMeta.c1[1] + dy],
        c2: [el.rectMeta.c2[0] + dx, el.rectMeta.c2[1] + dy],
      };
    }
    useProjectStore.getState().updateElement(elementId, meta);
  } else if (el.type === 'gathering' || el.type === 'encirclement') {
    const dx = lngLat[0] - el.center[0];
    const dy = lngLat[1] - el.center[1];
    useProjectStore.getState().updateElement(elementId, {
      center: [el.center[0] + dx, el.center[1] + dy],
    } as Partial<MapElement>);
  } else if (el.type === 'geo_image') {
    const g = el.grid;
    if (!g?.length) return;
    const dx = lngLat[0] - g[0][0];
    const dy = lngLat[1] - g[0][1];
    useProjectStore.getState().updateElement(elementId, {
      grid: g.map((p) => [p[0] + dx, p[1] + dy] as [number, number]),
    } as Partial<MapElement>);
  }
}

/** 应用 3D 球体 / 平面投影 */
function applyProjection(map: maplibregl.Map, globe: boolean) {
  try {
    map.setProjection({ type: globe ? 'globe' : 'mercator' });
  } catch { /* 样式未就绪时忽略，load 后会再应用 */ }
}

function makeRegionPolygon(name: string, rings: [number, number][][], project: MapVideoProject): PolygonElement {
  return {
    id: generateId(), type: 'polygon', name, visible: true, locked: false,
    startFrame: 0, endFrame: project.endFrame, style: {},
    coordinates: rings,
    fillColor: '#E23B3B', fillOpacity: 0.25, strokeColor: '#FF6666', strokeWidth: 2,
  } as PolygonElement;
}

function circleCoords(center: [number, number], radiusKm: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    pts.push([
      center[0] + (radiusKm / 111) * Math.cos(a),
      center[1] + (radiusKm / 111) * Math.sin(a),
    ]);
  }
  return pts;
}

/** 五角星外轮廓（outer 半径=radiusKm，inner=0.4×radiusKm），逆时针，闭合环 */
function polyStarCoords(center: [number, number], radiusKm: number): [number, number][] {
  const pts: [number, number][] = [];
  const outer = radiusKm / 111;
  const inner = outer * 0.4;
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    pts.push([center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)]);
  }
  pts.push([pts[0][0], pts[0][1]]);
  return pts;
}

/** 去除连续重复点（双击会触发两次 click） */
function dedupePoints(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-7 && Math.abs(last[1] - p[1]) < 1e-7) continue;
    out.push(p);
  }
  return out;
}

/** 近似贝塞尔预览（与正式渲染一致使用控制点） */
function approxBezier(coords: [number, number][]): [number, number][] {
  try {
    const spline = turf.bezierSpline(turf.lineString(coords), { resolution: 8000, sharpness: 0.6 });
    return spline.geometry.coordinates as [number, number][];
  } catch {
    return coords;
  }
}

function buildDoubleArrowPreview(points: [number, number][]): [number, number][] {
  try {
    return buildDoubleArrow(points.map((p) => p as number[])) as [number, number][];
  } catch {
    return points;
  }
}

// ===== 绘制预览图层 =====

function setPreviewData(map: maplibregl.Map, data: any, showFill: boolean = true) {
  const src = 'draw-preview';
  const fillId = 'draw-preview-fill';
  const lineId = 'draw-preview-line';
  const pointId = 'draw-preview-point';

  if (map.getSource(src)) {
    (map.getSource(src) as any).setData(data);
    // 动态显示/隐藏填充层
    if (map.getLayer(fillId)) {
      map.setLayoutProperty(fillId, 'visibility', showFill ? 'visible' : 'none');
    }
    return;
  }
  map.addSource(src, { type: 'geojson', data } as any);
  map.addLayer({
    id: fillId, type: 'fill', source: src,
    paint: { 'fill-color': '#00C853', 'fill-opacity': 0.15 },
    layout: { visibility: showFill ? 'visible' : 'none' },
  });
  map.addLayer({
    id: lineId, type: 'line', source: src,
    paint: { 'line-color': '#00C853', 'line-width': 2.5, 'line-dasharray': [3, 2] },
  });
  map.addLayer({
    id: pointId, type: 'circle', source: src,
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-radius': 5,
      'circle-color': '#00C853',
      'circle-stroke-width': 2,
      'circle-stroke-color': '#FFFFFF',
    },
  });
}

function cleanupPreview(map: maplibregl.Map | null) {
  if (!map) return;
  ['draw-preview-fill', 'draw-preview-line', 'draw-preview-point'].forEach((id) => {
    if (map.getLayer(id)) map.removeLayer(id);
  });
  if (map.getSource('draw-preview')) map.removeSource('draw-preview');
}
