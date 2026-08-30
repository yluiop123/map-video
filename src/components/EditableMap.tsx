import { useEffect, useRef, useCallback, useState } from 'react';
import { Camera, RotateCcw, ChevronDown } from 'lucide-react';
import { useConfirm } from './ui/ConfirmHost';
import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as turf from '@turf/turf';
import {
  renderElements, setCustomSymbols,
  buildArrowGeometry, buildSelectionFeature, pixelsToDegrees,
} from '../lib/map-renderer';
import { buildDoubleArrow, buildGatheringPlace } from '../lib/military-plots';
import { interpolateCamera, getEasing, interpolateKeyframes, interpolatePath } from '../lib/keyframe-interpolation';
import { sharedMap } from '../lib/shared-map';
import { findRegionsAt, loadRegionData, regionHitsToShapes } from '../lib/regions';
import { useProjectStore, setHistoryMuted, snapshotHistory } from '../stores/projectStore';
import { useInteractionStore } from '../stores/interactionStore';
import { useEditorStore } from '../stores/editorStore';
import { generateId } from '../types';
import type {
  Chapter, MapVideoProject, MapElement, PointElement,
  MovingPointElement, LineElement, PolygonElement, ArrowElement, DoubleArrowElement,
  EncirclementElement, GatheringElement, FlagElement, CameraKeyframe
} from '../types';

interface EditableMapProps {
  project: MapVideoProject;
  chapter: Chapter;
  currentFrame: number;
}

const DRAW_MODES = ['add_moving_line', 'add_moving_bezier', 'add_line', 'add_bezier', 'add_line_arc', 'add_polygon', 'add_rect', 'add_arrow', 'add_curved', 'add_attack', 'add_pincer', 'add_encirclement', 'add_gathering'];
const LINE_PREVIEW_MODES = new Set(['add_line', 'add_bezier', 'add_moving_line', 'add_moving_bezier']);

export function EditableMap({ project, chapter, currentFrame }: EditableMapProps) {
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
  }>({ points: [], cursor: null, phase: 'collect', hits: [] });

  const addElement = useProjectStore((s) => s.addElement);
  const addElements = useProjectStore((s) => s.addElements);
  const mode = useInteractionStore((s) => s.mode);
  const selectElement = useEditorStore((s) => s.selectElement);
  const selectedElementId = useEditorStore((s) => s.selectedElementId);
  const setMode = useInteractionStore((s) => s.setMode);
  const [viewSaved, setViewSaved] = useState(false);
  const [viewBarHidden, setViewBarHidden] = useState(false);

  // 注入自定义符号表（供 renderer 加载上传图标）
  useEffect(() => {
    setCustomSymbols(project.customSymbols);
  }, [project.customSymbols]);

  const styleUrl = getStyleUrl(project, chapter);

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

    map.on('load', () => {
      mapRef.current = map;
      sharedMap.set(map);
      setStyleTick((n) => n + 1);
      if (chapter.camera && chapter.camera.length > 0 && prevCam.zoom === 4 && prevCam.center[0] === 104) {
        const cam = chapter.camera[0];
        map.jumpTo({ center: cam.center, zoom: cam.zoom, pitch: cam.pitch || 0, bearing: cam.bearing || 0 });
      }
      // 3D 球体投影（读全局配置最新值，避免闭包过期）
      applyProjection(map, (useProjectStore.getState().project?.globalConfig.projection ?? 'mercator') === 'globe');
      // 元素刷新
      renderElements(map, chapter.elements, currentFrame, project.globalConfig.defaultFPS);

      // ===== 地图事件注册（一次性；回调经 handlersRef 取最新） =====
      const H = () => handlersRef.current;
      const onMouseMoveMap = (e: any) => H().handleHover?.(e);
      const onMouseOutMap = () => H().handleHoverOut?.();
      const onMouseDownMap = (e: any) => H().handleMouseDown?.(e);
      const onClickMap = (e: any) => H().handleClick?.(e);
      const onDblClickMap = () => H().handleDblClick?.();
      const onContextMenuMap = (e: any) => H().handleContextMenu?.(e);
      const onWinMove = (e: MouseEvent) => H().handleWindowMouseMove?.(e);
      const onWinUp = () => H().handleWindowMouseUp?.();
      map.on('mousemove', onMouseMoveMap);
      map.on('mouseout', onMouseOutMap);
      map.on('mousedown', onMouseDownMap);
      map.on('click', onClickMap);
      map.on('dblclick', onDblClickMap);
      map.on('contextmenu', onContextMenuMap);
      window.addEventListener('mousemove', onWinMove);
      window.addEventListener('mouseup', onWinUp);
      (map as any).__mvHandlers = { onMouseMoveMap, onMouseOutMap, onMouseDownMap, onClickMap, onDblClickMap, onContextMenuMap, onWinMove, onWinUp };
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
      el = {
        id: generateId(), type: 'point', name: '标记点', visible: true, locked: false,
        startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
        coordinates: lngLat, color: '#FF4444', iconSize: 10,
        label: { text: '标记点', fontSize: 13, color: '#000000', position: 'bottom', bgColor: '#FFFFFF', bgPadding: 6, bgRadius: 6 },
      } as PointElement;
    } else if (kind === 'image') {
      const first = project.customSymbols[0];
      el = {
        id: generateId(), type: 'custom_icon', name: '图片', visible: true, locked: false,
        startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
        coordinates: lngLat, symbolId: first?.id || '', size: 40, rotation: 0,
      };
    }

    if (el) {
      addElement(chapter.id, el);
      selectElement(el.id);
    }
    useInteractionStore.getState().clearPendingPlace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPlace?.ts]);

  // 进入行政区模式时预加载边界数据
  useEffect(() => {
    if (mode === 'add_region') loadRegionData().catch(() => { /* 点击时提示 */ });
  }, [mode]);

  // ===== 3D 球体开关实时切换 =====
  const globeOn = project.globalConfig.projection === 'globe';
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    applyProjection(map, globeOn);
  }, [globeOn, styleUrl]);

  const [styleTick, setStyleTick] = useState(0);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const confirm = useConfirm();
  const routeEditMode = useEditorStore((s) => s.routeEdit);
  // ===== 元素刷新 =====
  // 不用 isStyleLoaded 门禁（v5 中它会频繁 false 吞掉逐帧高亮动画）；
  // 样式未就绪时 renderElements 内部 addSource 会抛错，这里 catch 后等下一帧重试。
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      renderElements(map, chapter.elements, currentFrame, project.globalConfig.defaultFPS);
    } catch { /* style 未就绪，下一帧重试 */ }
  }, [chapter, currentFrame, project.globalConfig.defaultFPS, styleTick]);


  // ===== 镜头插值：播放/改帧时应用到镜头关键帧 =====
  // 注意 1：不要用 isStyleLoaded 作门禁——字形/瓦片未就绪时它常为 false，
  //         会把离散跳帧（⏩/点击时间线）的相机更新全部吞掉；jumpTo 不依赖 style。
  // 注意 2：依赖用 chapter.camera（数组引用）而非 chapter——否则任何元素属性修改
  //         都会重建 chapter 对象，把用户手动平移的地图拽回关键帧位置。
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (chapter.camera && chapter.camera.length > 0) {
      const cam = interpolateCamera(chapter.camera, currentFrame, project.globalConfig.defaultFPS);
      try {
        map.jumpTo({ center: cam.center, zoom: cam.zoom, pitch: cam.pitch || 0, bearing: cam.bearing || 0 });
      } catch { /* 相机尚未可用 */ }
    }
  }, [currentFrame, chapter.camera]);

  // ===== 移动点选中：高亮圈跟随移动点（逐帧） =====
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const srcId = 'selection-move';
    const el = chapter.elements.find((x) => x.id === selectedElementId);
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
  }, [currentFrame, selectedElementId, chapter, styleTick]);

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
    } else {
      map.doubleClickZoom.enable();
    }
  }, [mode, styleUrl]);

  // ===== 重置绘制状态 =====
  const resetDraw = useCallback(() => {
    drawRef.current = { points: [], cursor: null, phase: 'collect', hits: [] };
    cleanupPreview(mapRef.current);
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

    if ((mode === 'add_line' || mode === 'add_bezier') && cursor) {
      const coords = [...points, cursor];
      const eff = mode === 'add_bezier' ? approxBezier(coords) : coords;
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
      const previewPts = cursor && points.length > 0 ? [...points, cursor] : points;
      if (previewPts.length >= 2) {
        const rings = buildArrowGeometry(previewPts[0], previewPts[previewPts.length - 1], arrowWidth, 'curved', previewPts);
        rings.forEach((r) => fc.push(turf.polygon([[...r, r[0]]])));
      }
    } else if (mode === 'add_attack' && (points.length > 0 || cursor)) {
      const previewPts = cursor && points.length > 0 ? [...points, cursor] : points;
      if (previewPts.length >= 2) {
        const rings = buildArrowGeometry(previewPts[0], previewPts[previewPts.length - 1], arrowWidth, 'attack', previewPts);
        rings.forEach((r) => fc.push(turf.polygon([[...r, r[0]]])));
      }
    } else if (mode === 'add_polygon' && cursor) {
      const coords = [...points, cursor];
      fc.push(turf.lineString([...coords, coords[0]]));
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
        startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
        coordinates: lngLat, color: '#FF4444', iconSize: 10,
      } as PointElement);
      return;
    }
    if (mode === 'add_text') {
      createElementAndSelect({
        id: generateId(), type: 'point', name: '文字', visible: true, locked: false,
        startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
        coordinates: lngLat, shape: 'text', iconSize: 0,
        label: { text: '文字', fontSize: 14, color: '#FFFFFF', position: 'center', bgColor: 'rgba(0,0,0,0)', bgPadding: 3, bgRadius: 3, fontWeight: 'bold' },
      } as PointElement);
      return;
    }
    if (mode === 'add_flag') {
      createElementAndSelect({
        id: generateId(), type: 'flag', name: '旗帜', visible: true, locked: false,
        startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
        coordinates: lngLat, text: '旗帜', flagColor: '#E23B3B', textColor: '#FFFFFF',
        fontSize: 14, flagWidth: 72,
      } as FlagElement);
      return;
    }
    if (mode === 'add_custom') {
      const first = project.customSymbols[0];
      createElementAndSelect({
        id: generateId(), type: 'custom_icon', name: '自定义图标', visible: true, locked: false,
        startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
        coordinates: lngLat, symbolId: first?.id || '', size: 40, rotation: 0,
      });
      return;
    }

    // —— 行政区一键高亮：点击国土自动生成可编辑的高亮面 ——
    if (mode === 'add_region') {
      void (async () => {
        try {
          const hits = await findRegionsAt(lngLat);
          if (!hits.length) return;
          const els = regionHitsToShapes(hits).map((s) => makeRegionPolygon(s.name, s.rings as [number, number][][], chapter));
          if (els.length) {
            addElements(chapter.id, els);
            selectElement(els[0].id);
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
          startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
          from: d.points[0], to: lngLat, arrowType: 'swallowtail', width: 15, color: '#E23B3B',
          progress: [{ frame: chapter.startFrame, value: 1 }], drawZoom: map.getZoom(),
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
          startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
          coordinates: [ring],
          fillColor: '#E23B3B', fillOpacity: 0.25, strokeColor: '#E23B3B', strokeWidth: 2,
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
          startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
          points: pts.slice(0, 4) as [number, number][],
          color: '#E23B3B',
          progress: [{ frame: chapter.startFrame, value: 1 }],
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
    if (mode === 'add_encirclement' || mode === 'add_gathering') {
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
            startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
            center: d.points[0], radius, fillColor: '#D33030', strokeColor: '#D33030',
          } as EncirclementElement);
        } else {
          createElementAndSelect({
            id: generateId(), type: 'gathering', name: '集结点', visible: true, locked: false,
            startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
            center: d.points[0], radius, color: '#FF6600', pulseAnimation: true,
          } as GatheringElement);
        }
        resetDraw();
      }
      return;
    }

    // —— 移动路径 / 线 / 贝塞尔 / 大圆弧 / 面：采点，双击或回车完成 ——
    if (mode === 'add_moving_line' || mode === 'add_moving_bezier' || mode === 'add_line' || mode === 'add_bezier' || mode === 'add_line_arc' || mode === 'add_polygon') {
      d.points.push(lngLat);
      d.cursor = lngLat;
      updatePreview();
      return;
    }

    // —— 选择模式：命中检测 ——
    if (mode === 'select') {
      selectElement(pickElement(map, e.point, chapter.elements));
    }
  }, [mode, chapter, project, addElement, addElements, selectElement, setMode, updatePreview, resetDraw]);

  const createElementAndSelect = useCallback((element: MapElement) => {
    addElement(chapter.id, element);
    selectElement(element.id);
    setMode('select');
  }, [chapter.id, addElement, selectElement, setMode]);

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
        startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
        points: pts as [number, number][],
        color: '#E23B3B',
        progress: [{ frame: chapter.startFrame, value: 1 }],
      } as DoubleArrowElement);
    } else if (mode === 'add_attack') {
      if (pts.length < 2) return;
      createElementAndSelect({
        id: generateId(), type: 'arrow', name: '进攻箭头', visible: true, locked: false,
        startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
        from: pts[0], to: pts[pts.length - 1], arrowType: 'attack', path: pts,
        width: 15, color: '#E23B3B',
        progress: [{ frame: chapter.startFrame, value: 1 }], drawZoom: map.getZoom(),
      } as ArrowElement);
    } else if (mode === 'add_moving_line') {
      if (pts.length < 2) return;
      createElementAndSelect({
        id: generateId(), type: 'moving_point', name: '移动点(直线)', visible: true, locked: false,
        startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
        path: pts,
        pathProgress: [{ frame: chapter.startFrame, value: 0 }, { frame: chapter.endFrame, value: 1 }],
        color: '#FF6600',
      } as MovingPointElement);
    } else if (mode === 'add_moving_bezier') {
      if (pts.length < 2) return;
      // 贝塞尔平滑后作为路径
      const smooth = approxBezier(pts);
      createElementAndSelect({
        id: generateId(), type: 'moving_point', name: '移动点(曲线)', visible: true, locked: false,
        startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
        path: smooth,
        pathProgress: [{ frame: chapter.startFrame, value: 0 }, { frame: chapter.endFrame, value: 1 }],
        color: '#FF6600',
      } as MovingPointElement);
    } else if (mode === 'add_line_arc') {
      if (pts.length < 2) return;
      createElementAndSelect({
        id: generateId(), type: 'line', name: '大圆弧航线', visible: true, locked: false,
        startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
        coordinates: pts,
        drawProgress: [{ frame: chapter.startFrame, value: 1 }],
        lineWidth: 3, lineColor: '#2277FF', lineType: 'arc',
      } as LineElement);
    } else if (mode === 'add_line' || mode === 'add_bezier') {
      if (pts.length < 2) return;
      createElementAndSelect({
        id: generateId(), type: 'line',
        name: mode === 'add_bezier' ? '曲线' : '路线',
        visible: true, locked: false,
        startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
        coordinates: pts,
        drawProgress: [{ frame: chapter.startFrame, value: 1 }],
        lineWidth: 3, lineColor: '#FF4444',
        ...(mode === 'add_bezier' ? { lineType: 'bezier' as const } : {}),
      } as LineElement);
    } else if (mode === 'add_polygon') {
      if (pts.length < 3) return;
      pts = [...pts, pts[0]];
      createElementAndSelect({
        id: generateId(), type: 'polygon', name: '区域', visible: true, locked: false,
        startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
        coordinates: [pts],
        fillColor: '#E23B3B', fillOpacity: 0.25, strokeColor: '#E23B3B', strokeWidth: 2,
      } as PolygonElement);
    } else if (mode === 'add_curved') {
      if (pts.length < 2) return;
      createElementAndSelect({
        id: generateId(), type: 'arrow', name: '弯曲箭头', visible: true, locked: false,
        startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
        from: pts[0], to: pts[pts.length - 1], arrowType: 'curved', path: pts,
        width: 15, color: '#E23B3B',
        progress: [{ frame: chapter.startFrame, value: 1 }], drawZoom: map.getZoom(),
      } as ArrowElement);
    }

    resetDraw();
  }, [mode, chapter, addElement, selectElement, setMode, resetDraw, createElementAndSelect]);

  const handleDblClick = useCallback(() => {
    finishDrawing();
    useEditorStore.getState().setRouteEdit('none');
  }, [finishDrawing]);

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
    const hit = pickElement(m, e.point, chapter.elements);
    m.getCanvas().style.cursor = hit ? 'move' : '';
  }, [chapter.elements]);

  const handleHoverOut = useCallback(() => {
    if (useInteractionStore.getState().mode === 'select') setCanvasCursor('');
  }, [setCanvasCursor]);

  // 模式切换时同步画布光标
  useEffect(() => {
    setCanvasCursor(mode === 'select' ? '' : mode.startsWith('add_') ? 'crosshair' : '');
  }, [mode, setCanvasCursor]);

  // ===== 拖拽移动元素 / 顶点编辑 =====
  const dragRef = useRef<{ active: boolean; elementId: string | null; x: number; y: number; vertex?: number }>({
    active: false, elementId: null, x: 0, y: 0,
  });
  // 顶点命中后抑制紧随的 click 取消（否则刚选中的路线被空白点击取消）
  const skipClickRef = useRef(false);

  const handleMouseDown = useCallback((e: maplibregl.MapMouseEvent) => {
    const map = mapRef.current;
    if (!map || mode !== 'select') return;
    // 用 getState() 现取，避免闭包章旧（selectedElementId/chapter 每次择/样式切换都会变）
    const st = useProjectStore.getState();
    const selId = useEditorStore.getState().selectedElementId;
    const ch = st.project?.chapters.find((c) => c.id === chapter.id) || chapter;
    const rEdit = useEditorStore.getState().routeEdit;
    const selEl = rEdit !== 'none' && selId ? ch.elements.find((x) => x.id === selId) : undefined;
    const editPath = selEl ? routePathOf(selEl) : null;

    // 添加点模式：命中已有顶点 → 退出添加模式转顶点拖拽（任意关键点都可编辑）；
    // 命中空白地图 → 在带路径的选中路线末尾追加（可连续追加）。
    if (rEdit === 'add') {
      const vAdd = hitRouteVertex(map, e.point, ch.elements, selId);
      if (vAdd) {
        useEditorStore.getState().setRouteEdit('none');
      } else if (editPath) {
        const c = editPath.map((p2) => [p2[0], p2[1]] as [number, number]);
        const last = c[c.length - 1];
        const np: [number, number] = [e.lngLat.lng, e.lngLat.lat];
        if (Math.abs(last[0] - np[0]) < 1e-7 && Math.abs(last[1] - np[1]) < 1e-7) return;
        c.push(np);
        const fAdd = (selEl as MapElement).type === 'moving_point' || (selEl as MapElement).type === 'arrow' ? 'path' : (selEl as MapElement).type === 'double_arrow' ? 'points' : 'coordinates';
        useProjectStore.getState().updateElement(ch.id, (selEl as MapElement).id, { [fAdd]: c } as Partial<MapElement>);
        skipClickRef.current = true;
        return;
      }
    }
    // 无选中路线或编辑模式已失效：清掉残留模式，透传正常选择/拖拽
    if (rEdit !== 'none') useEditorStore.getState().setRouteEdit('none');
    // 优先命中路线顶点（可见标记点）：命中即选中该路线并进入顶点拖拽
    const v = hitRouteVertex(map, e.point, ch.elements, selId);
    if (v) {
      setHistoryMuted(true);
      snapshotHistory();
      dragRef.current = { active: true, elementId: v.eid, x: e.point.x, y: e.point.y, vertex: v.idx };
      skipClickRef.current = true;
      selectElement(v.eid);
      map.dragPan.disable();
      return;
    }
    const hit = pickElement(map, e.point, ch.elements);
    if (hit) {
      // 拖拽开始前快照一次（绕过 700ms 节流）
      setHistoryMuted(true);
      snapshotHistory();
      dragRef.current = { active: true, elementId: hit, x: e.point.x, y: e.point.y };
      selectElement(hit);
      map.dragPan.disable();
    }
  }, [mode, selectElement, chapter.id]);

  const handleWindowMouseMove = useCallback((e: globalThis.MouseEvent) => {
    const map = mapRef.current;

    // 添加点模式：终点 → 光标 橡皮筋预览
    if (map && useEditorStore.getState().routeEdit === 'add') {
      const st = useProjectStore.getState();
      const selId = useEditorStore.getState().selectedElementId;
      const addCh = st.project?.chapters.find((c) => c.id === chapter.id);
      const addEl = (addCh?.elements || chapter.elements).find((x) => x.id === selId);
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

    // 绘制中更新光标位置 → 预览
    if (map && DRAW_MODES.includes(useInteractionStore.getState().mode)) {
      const bbox = containerRef.current?.getBoundingClientRect();
      if (bbox) {
        const p = map.unproject([e.clientX - bbox.left, e.clientY - bbox.top]);
        drawRef.current.cursor = [p.lng, p.lat];
        updatePreview();
      }
    }

    const drag = dragRef.current;
    if (!map || !drag.active || !drag.elementId) return;

    // 顶点拖拽：只更新被拖动的路径点（起点/终点/中间点）
    if (drag.vertex !== undefined) {
      const el = chapter.elements.find((x) => x.id === drag.elementId);
      const path = el ? routePathOf(el) : null;
      if (!el || !path || drag.vertex >= path.length) return;
      const bbox = containerRef.current?.getBoundingClientRect();
      if (!bbox) return;
      const lngLat = map.unproject([e.clientX - bbox.left, e.clientY - bbox.top]);
      const c = path.map((p) => [p[0], p[1]] as [number, number]);
      c[drag.vertex] = [lngLat.lng, lngLat.lat];
      const field = el.type === 'moving_point' || el.type === 'arrow' ? 'path'
        : el.type === 'double_arrow' ? 'points' : 'coordinates';
      useProjectStore.getState().updateElement(chapter.id, drag.elementId, { [field]: c } as Partial<MapElement>);
      drag.x = e.clientX;
      drag.y = e.clientY;
      return;
    }

    const dx = Math.abs(e.clientX - drag.x);
    const dy = Math.abs(e.clientY - drag.y);
    if (dx < 3 && dy < 3) return;

    const bbox = containerRef.current?.getBoundingClientRect();
    if (!bbox) return;
    const lngLat = map.unproject([e.clientX - bbox.left, e.clientY - bbox.top]);
    moveElementTo(chapter, drag.elementId, [lngLat.lng, lngLat.lat]);
    drag.x = e.clientX;
    drag.y = e.clientY;
  }, [chapter, updatePreview]);

  const handleWindowMouseUp = useCallback(() => {
    if (dragRef.current.active) {
      mapRef.current?.dragPan.enable();
      setHistoryMuted(false);
    }
    dragRef.current = { active: false, elementId: null, x: 0, y: 0 };
  }, []);

  // ===== 右键：撤销上一点 / 取消 =====
  const handleContextMenu = useCallback((e: maplibregl.MapMouseEvent) => {
    e.preventDefault();
    const d = drawRef.current;
    if (d.points.length > 0) {
      d.points.pop();
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
          if (d.points.length === 0) d.phase = 'collect';
          updatePreview();
          return;
        }
        const id = useEditorStore.getState().selectedElementId;
        if (id) {
          e.preventDefault();
          const el = chapter.elements.find((x) => x.id === id);
          void confirm({
            message: `删除「${el?.name || '元素'}」？`,
            danger: true,
            confirmText: '删除',
          }).then((ok) => {
            if (!ok) return;
            useProjectStore.getState().deleteElement(chapter.id, id);
            selectElement(null);
          });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finishDrawing, chapter.id, setMode, selectElement, resetDraw, updatePreview]);

  // ===== 每次渲染同步最新回调，供一次性注册的地图事件调用 =====
  handlersRef.current = {
    handleClick, handleDblClick, handleMouseDown, handleContextMenu,
    handleHover, handleHoverOut, handleWindowMouseMove, handleWindowMouseUp,
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

    const el = chapter.elements.find((x) => x.id === selectedElementId);
    if (!el) return;
    // 路线类元素不做线状高亮，顶点标识已足够
    if (el.type === 'line' || el.type === 'moving_point' || el.type === 'arrow' || el.type === 'double_arrow') return;

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
  }, [selectedElementId, chapter, styleTick]);

  // ===== 选中变化：路径点编辑模式自动复位 =====
  useEffect(() => {
    const map0 = mapRef.current;
    if (routeEditMode !== 'add' && map0 && map0.getLayer('route-add-preview')) {
      map0.setLayoutProperty('route-add-preview', 'visibility', 'none');
    }
    if (routeEditMode === 'none') return;
    const el = selectedElementId ? chapter.elements.find((x) => x.id === selectedElementId) : null;
    if (!el || !routePathOf(el)) useEditorStore.getState().setRouteEdit('none');
  }, [selectedElementId, chapter, routeEditMode]);

  // ===== 路线顶点标识：所有路线元素显示路径点，选中的更大更亮 =====
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const srcId = 'vertex-markers';
    const feats: any[] = [];
    for (const el of chapter.elements) {
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
  }, [chapter, selectedElementId, styleTick]);

  // ===== 播放时隐藏编辑辅助（顶点标识 / 选中高亮） =====
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const vis = isPlaying ? 'none' : 'visible';
    ['vertex-dot', 'selection-line', 'selection-fill', 'selection-point', 'selection-move'].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    });
  }, [isPlaying, chapter, selectedElementId, styleTick]);

  // ===== 左侧列表定位请求 =====
  const focusReq = useInteractionStore((s) => s.focusReq);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusReq) return;
    const el = chapter.elements.find((x) => x.id === focusReq.elementId);
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
  }, [focusReq, chapter]);

  const getCursor = () => (mode.startsWith('add_') || routeEditMode === 'add' ? 'crosshair' : 'default');

  /** 解析"播放头所在视角"：
   *  视角 i 的画面停留区间 = [kf[i].frame, 下一视角起飞帧)；处于飞行窗口内则归属目标视角 */
  const resolveKfIndex = (kfs: CameraKeyframe[], frame: number, fps: number): number => {
    if (kfs.length === 0) return -1;
    for (let i = 0; i < kfs.length - 1; i++) {
      const next = kfs[i + 1];
      const gap = Math.max(0, next.frame - kfs[i].frame);
      const move = typeof next.moveDuration === 'number' ? Math.min(next.moveDuration, gap) : Math.min(2 * fps, gap);
      const moveStart = next.frame - move;
      if (frame < moveStart) return i;      // 停留区：当前显示视角 i
      if (frame <= next.frame) return i + 1; // 飞行区：正飞向视角 i+1
    }
    return kfs.length - 1;
  };

  /** Update View：把当前地图视角写入"播放头所在视角"（不再新增） */
  const handleUpdateView = useCallback(() => {
    const st = useProjectStore.getState();
    if (!st.project) return;
    const ch = st.project.chapters.find((c) => c.id === chapter.id) || chapter;
    const cam = useEditorStore.getState().currentCamera;
    const frame = Math.max(ch.startFrame, Math.round(useEditorStore.getState().currentFrame));
    const kfs = [...(ch.camera || [])].sort((a, b) => a.frame - b.frame);

    if (kfs.length === 0) {
      // 无关键帧时创建第一个
      const kf: CameraKeyframe = {
        frame, center: [cam.center[0], cam.center[1]], zoom: cam.zoom,
        pitch: cam.pitch || 0, bearing: cam.bearing || 0, easing: 'easeInOut',
      };
      st.setChapterCamera(ch.id, [kf]);
      useEditorStore.getState().selectKeyframe(0);
      setViewSaved(true);
      setTimeout(() => setViewSaved(false), 1200);
      return;
    }

    const fps = st.project.globalConfig.defaultFPS;const idx = resolveKfIndex(kfs, frame, fps);
    const target = kfs[Math.max(0, idx)];
    kfs[Math.max(0, idx)] = {
      ...target,
      center: [cam.center[0], cam.center[1]],
      zoom: cam.zoom,
      pitch: cam.pitch || 0,
      bearing: cam.bearing || 0,
    };
    st.setChapterCamera(ch.id, kfs);
    useEditorStore.getState().selectKeyframe(Math.max(0, idx));
    setViewSaved(true);
    setTimeout(() => setViewSaved(false), 1200);
  }, [chapter]);

  /** ⟳ 预览：飞到"播放头所在视角"的原始设置 */
  const handlePreviewKf = useCallback(() => {
    const st = useProjectStore.getState();
    if (!st.project) return;
    const ch = st.project.chapters.find((c) => c.id === chapter.id) || chapter;
    const kfs = [...(ch.camera || [])].sort((a, b) => a.frame - b.frame);
    if (kfs.length === 0) return;
    const frame = Math.max(ch.startFrame, Math.round(useEditorStore.getState().currentFrame));
    const fps = st.project.globalConfig.defaultFPS;const idx = resolveKfIndex(kfs, frame, fps);
    const kf = kfs[Math.max(0, idx)];
    const prevF = idx > 0 ? kfs[idx - 1].frame : ch.startFrame;
    const moveFrames = typeof kf.moveDuration === 'number' ? Math.min(kf.moveDuration, kf.frame - prevF) : Math.min(2 * fps, kf.frame - prevF);
    useEditorStore.getState().seekCamera(
      { center: kf.center, zoom: kf.zoom, pitch: kf.pitch || 0, bearing: kf.bearing || 0 },
      kf.easing || 'linear',
      Math.max(0.2, Math.min(6, moveFrames / st.project.globalConfig.defaultFPS))
    );
  }, [chapter]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" style={{ cursor: getCursor() }} />

      {/* TILT 倾斜滑块已移除（俯仰在右侧视角属性中设置） */}

      {/* 视角工具条（Mapimator 风格胶囊）：更新视角 / 预览飞回 / 收起 */}
      {mode === 'select' && !viewBarHidden && (
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
      {mode === 'select' && viewBarHidden && (
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
    case 'add_custom': return '点击地图放置图标';
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
    default: return '';
  }
}

// ========== 辅助函数 ==========

function getStyleUrl(project: MapVideoProject, chapter: Chapter): any {
  const activeId = chapter.baseMapId || project.activeBaseMapId;
  const baseMap = project.baseMaps.find((b) => b.id === activeId);
  const style = baseMap?.style as any;
  if (typeof style === 'string') return style;

  let styleObj = style;
  if (typeof styleObj !== 'string' && styleObj) {
    const elevId = chapter.elevationMapId !== undefined ? chapter.elevationMapId : project.activeElevationMapId;
    const elevation = project.elevationMaps.find((e) => e.id === elevId && e.url);
    if (elevation && elevation.url && !styleObj.sources?.elevation) {
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

/** 路线类元素的可编辑路径点（line/moving_point/arrow/double_arrow） */
function routePathOf(el: MapElement): [number, number][] | null {
  if (el.type === 'line') return (el.coordinates?.length ?? 0) >= 2 ? el.coordinates : null;
  if (el.type === 'moving_point') return (el.path?.length ?? 0) >= 2 ? el.path : null;
  if (el.type === 'arrow') {
    if (el.path && el.path.length >= 2) return el.path;
    return el.from && el.to ? [el.from, el.to] : null;
  }
  if (el.type === 'double_arrow') return (el.points?.length ?? 0) >= 2 ? el.points : null;
  return null;
}

/** 命中检测：屏幕 25px 内最近的路线顶点 */
function hitRouteVertex(map: maplibregl.Map, point: maplibregl.PointLike, elements: MapElement[], preferId?: string | null): { eid: string; idx: number } | null {
  const pt = point as maplibregl.Point;
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

function pickElement(map: maplibregl.Map, point: maplibregl.PointLike, elements: MapElement[]): string | null {
  const layers = getAllElementLayers(map);
  if (layers.length === 0) return null;
  const feats = map.queryRenderedFeatures(point, { layers });
  for (const f of feats) {
    const id = f.layer?.id;
    if (id) {
      const eid = elementIdFromLayerId(id, elements);
      if (eid) return eid;
    }
  }
  return null;
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

function moveElementTo(chapter: Chapter, elementId: string, lngLat: [number, number]) {
  const el = chapter.elements.find((e) => e.id === elementId);
  if (!el) return;

  if (el.type === 'point' || el.type === 'military_symbol' || el.type === 'custom_icon' || el.type === 'flag') {
    useProjectStore.getState().updateElement(chapter.id, elementId, { coordinates: lngLat });
  } else if (el.type === 'moving_point') {
    useProjectStore.getState().updateElement(chapter.id, elementId, { path: [lngLat, ...el.path.slice(1)] });
  }
}

/** 应用 3D 球体 / 平面投影 */
function applyProjection(map: maplibregl.Map, globe: boolean) {
  try {
    map.setProjection({ type: globe ? 'globe' : 'mercator' });
  } catch { /* 样式未就绪时忽略，load 后会再应用 */ }
}

function makeRegionPolygon(name: string, rings: [number, number][][], chapter: Chapter): PolygonElement {
  return {
    id: generateId(), type: 'polygon', name, visible: true, locked: false,
    startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
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
