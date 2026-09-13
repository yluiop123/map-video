import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import * as turf from '@turf/turf';
import { interpolateKeyframes, interpolatePath } from './keyframe-interpolation';
import { setFlyRibbon, clearFlyRibbons, flyHeight01, flyArcHeightMeters, projectLifted, flyLiftMeters, setFlyMarker, clearFlyMarkers } from './fly-ribbon';
import {
  buildAttackArrow, buildStraightArrow, buildDoubleArrow, buildGatheringPlace,
} from './military-plots';
import {
  ownerAt, ownerVisualAt, plotColorAt, plotFxAt, plotSpreadAt, plotShrinkAt, unionCountryRings, centerOfFeature,
  sliceRingClosed, makeTerritoryLabelImageData, territoryLabelImageId,
  normalizeTerritoryDisplay,
} from './territory';
import type { TerritoryLabelStyle } from './territory';
import type {
  MapElement, PointElement, MovingPointElement, LineElement,
  PolygonElement, ArrowElement, DoubleArrowElement, EncirclementElement,
  GatheringElement, ConnectorElement,
  FlagElement, CameraKeyframe,
  TerritoryElement,
} from '../types';
import { getPinCapability, resolvePinVisualSource } from './pin-visual';
import { getBuiltinAsset } from './builtin-assets';
import { iconNameToDataUrl } from './icon-library';
import { getAssetUrl, getAssetBytes } from './assets';
import { decodeGifCached, gifFrameAt, type GifFrames } from './gif-decoder';
import { renderProceduralAnim } from './procedural-anim';
// 注意：model-renderer（three.js）走**动态 import** —— 只有真正渲染模型形态时才加载，
// 否则 three 会被打进主 chunk，首屏凭空多出 ~650KB。

/** 渲染帧率（由 EditableMap / MapScene 注入；GIF 逐帧与模型自转都按它换算，保证双端一致） */
let renderFps = 30;
export function setRenderFps(fps: number): void {
  renderFps = fps > 0 ? fps : 30;
}

// ========== 主渲染函数 ==========

// 记录每个 map 上已被渲染的元素 ID 与类型签名（类型切换时需整体重建图层）
const renderedByMap = new WeakMap<maplibregl.Map, Set<string>>();
const renderedTypeByMap = new WeakMap<maplibregl.Map, Map<string, string>>();
// 记录被 hideElementLayers 隐藏过的元素 id：重新可见时需整体恢复层可见性
const hiddenElByMap = new WeakMap<maplibregl.Map, Set<string>>();
// 箭头图标已注册颜色（元素 id → 颜色），颜色变化需重注册
const renderedHeadColorByMap = new WeakMap<maplibregl.Map, Map<string, string>>();

// ========== 防御圈锯齿：屏幕像素级，须随相机变化重算 ==========
// 锯齿是按当前相机用 map.project/unproject 在屏幕像素上采样生成的，
// 只锚定在元素变化（而非相机）时重算会导致：创建后相机跳帧 / 手动平移缩放时
// 锯齿停留在上次投影，表现为"不显示"或"跟随有问题"。
type DefendJob = {
  srcId: string;
  layerId: string;
  ring: [number, number][];
  toothLen: number;
  toothGap: number;
  side: 1 | -1;
  tiltRad: number;
};
const defendJobsByMap = new WeakMap<maplibregl.Map, Map<string, DefendJob>>();
const defendMoveBound = new WeakSet<maplibregl.Map>();

function clearDefendJob(map: maplibregl.Map, elementId: string): void {
  defendJobsByMap.get(map)?.delete(elementId);
}

/** 相机变化（move/rotate/zoom）会同时改变屏幕投影，一次性为 map 挂锯齿重算监听 */
function ensureDefendRecompute(map: maplibregl.Map): void {
  if (defendMoveBound.has(map)) return;
  defendMoveBound.add(map);
  const tick = () => {
    const jobs = defendJobsByMap.get(map);
    if (!jobs) return;
    for (const j of jobs.values()) {
      try {
        const teeth = buildToothedTeeth(map, j.ring, j.toothLen, j.toothGap, j.side, j.tiltRad);
        const fc = turf.featureCollection(teeth.map((l) => turf.lineString(l)));
        if (map.getSource(j.srcId)) (map.getSource(j.srcId) as GeoJSONSource).setData(fc);
      } catch { /* style 未就绪 */ }
    }
  };
  map.on('move', tick);
}

export function removeElementLayers(map: maplibregl.Map, elementId: string): void {
  const style = map.getStyle();
  if (!style?.layers) return;
  const prefixRe = new RegExp(`^(${elementId}|[a-z]+-${elementId}|[a-z]+-[a-z]+-${elementId})-`);
  const idRe = new RegExp(`(${elementId})$`);
  for (const layer of style.layers) {
    const id = layer.id;
    if (id.includes(elementId) && id !== elementId) {
      try { map.removeLayer(id); } catch { /* 顺序问题，忽略 */ }
    }
  }
  // 移除相关 source
  const sources = (style as any).sources;
  if (sources) {
    for (const sid of Object.keys(sources)) {
      if (sid.includes(elementId) || idRe.test(sid) || prefixRe.test(sid)) {
        try { map.removeSource(sid); } catch { /* */ }
      }
    }
  }
  clearDefendJob(map, elementId);
  clearFlyRibbons(map, elementId);
  clearFlyMarkers(map, elementId);
}

/** 隐藏元素的所有图层（显示时间之外时调用，避免图层残留） */
export function hideElementLayers(map: maplibregl.Map, elementId: string): void {
  const style = map.getStyle();
  if (!style?.layers) return;
  for (const layer of style.layers) {
    const id = layer.id;
    if (id.includes(elementId) && id !== elementId) {
      try { map.setLayoutProperty(id, 'visibility', 'none'); } catch { /* 非 symbol/line 层或已隐藏 */ }
    }
  }
}

/** 恢复元素所有图层可见性（hideElementLayers 的逆操作；个别渲染函数随后会按条件重新修正） */
export function showElementLayers(map: maplibregl.Map, elementId: string): void {
  const style = map.getStyle();
  if (!style?.layers) return;
  for (const layer of style.layers) {
    const id = layer.id;
    if (id.includes(elementId) && id !== elementId) {
      try { map.setLayoutProperty(id, 'visibility', 'visible'); } catch { /* */ }
    }
  }
}


/**
 * @param interactive 是否**编辑端**。编辑辅助图形（如移动点全程虚线引导）仅在此为
 *   true 时绘制，避免泄漏进导出画面。默认 false —— 新调用点默认面向导出更安全。
 */
export function renderElements(
  map: maplibregl.Map,
  elements: MapElement[],
  frame: number,
  _fps: number,
  interactive = false
): void {
  const currentIds = new Set(elements.map((e) => e.id));
  const rendered = renderedByMap.get(map) || new Set<string>();

  // 清理：当前不存在的元素，删除其图层
  for (const id of rendered) {
    if (!currentIds.has(id)) {
      removeElementLayers(map, id);
    }
  }

  // 清理：元素 ID 未变但类型切换（如 直线→燕尾箭头），旧类型图层需整体重建
  const prevMeta = renderedTypeByMap.get(map) || new Map<string, string>();
  for (const el of elements) {
    const sig = prevMeta.get(el.id);
    if (sig && sig !== el.type) {
      removeElementLayers(map, el.id);
    }
  }
  renderedByMap.set(map, currentIds);
  const nextMeta = new Map<string, string>();
  for (const el of elements) nextMeta.set(el.id, el.type);
  renderedTypeByMap.set(map, nextMeta);

  const hiddenEls = hiddenElByMap.get(map) || new Set<string>();
  hiddenElByMap.set(map, hiddenEls);
  for (const element of elements) {
    if (!isVisible(element, frame)) {
      // 不可见：隐藏该元素所有图层（避免上一帧残留导致"显示时间之外仍显示"）
      hideElementLayers(map, element.id);
      hiddenEls.add(element.id);
      continue;
    }
    if (hiddenEls.delete(element.id)) {
      // 曾被隐藏过（时间窗瞬时越界，如播放首帧负 dt）：先整体恢复可见，
      // 渲染函数随后按条件修正（否则渲染器不逐帧重设 visibility 的层如 terr 填充会永久消失）
      showElementLayers(map, element.id);
    }

    switch (element.type) {
      case 'point': renderPoint(map, element, frame); break;
      case 'moving_point': renderMovingPoint(map, element, frame, interactive); break;
      case 'line': renderLine(map, element, frame); break;
      case 'polygon': renderPolygon(map, element, frame); break;
      case 'arrow': renderArrow(map, element, frame); break;
      case 'double_arrow': renderDoubleArrow(map, element, frame); break;
      case 'encirclement': renderEncirclement(map, element, frame); break;
      case 'gathering': renderGathering(map, element, frame); break;
      case 'connector': renderConnector(map, element); break;
      case 'flag': renderFlag(map, element); break;
      case 'territory': renderTerritory(map, element as TerritoryElement, frame); break;
    }
  }
}

// ========== 可见性判断 ==========

function isVisible(element: MapElement, frame: number): boolean {
  return element.visible && frame >= element.startFrame && frame <= element.endFrame;
}

function getOpacity(el: MapElement, frame: number): number {
  return el.style?.opacity ? (interpolateKeyframes(el.style.opacity, frame) as number) : 1;
}

/** 计算进度类关键帧（绘制/路径/箭头） */
function getProgress(kfs: { frame: number; value: number }[] | undefined, frame: number): number {
  if (!kfs || kfs.length === 0) return 1;
  return interpolateKeyframes(kfs, frame) as number;
}

// ========== 高亮辅助 ==========

// ========== 渲染：固定点 ==========

/** canvas 形状图缓存：id -> ImageData（跨地图复用） */
const shapeImageCache = new Map<string, ImageData>();

function getCached(key: string, make: () => ImageData): ImageData {
  let d = shapeImageCache.get(key);
  if (!d) { d = make(); shapeImageCache.set(key, d); }
  return d;
}

/** 水滴定位针（MAP PIN） */
function makePinImageData(color: string): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = 48; canvas.height = 48;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(24, 18, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(11, 26);
  ctx.lineTo(24, 46);
  ctx.lineTo(37, 26);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(24, 18, 5, 0, Math.PI * 2);
  ctx.fill();
  return ctx.getImageData(0, 0, 48, 48);
}

/** 白边圆点（DOT）：与 Pin 同走位图 symbol 渲染，支持贴地/旋转 */
function makeDotImageData(color: string): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = 24; canvas.height = 24;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(12, 12, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  return ctx.getImageData(0, 0, 24, 24);
}

/** 线末端三角箭头图标：像素作图中轴指向右侧，以 viewport 对齐呈现（不受 zoom/投影影响） */
function makeTriangleImage(color: string, size: number): ImageData {
  const pad = 2;
  const w = Math.max(4, Math.ceil(size + pad * 2));
  const h = Math.max(4, Math.ceil(size + pad * 2));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(w - pad, h / 2);          // 右顶点（指向方向）
  ctx.lineTo(pad, pad);                // 左上
  ctx.lineTo(pad, h - pad);            // 左下
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1;
  ctx.stroke();
  return ctx.getImageData(0, 0, w, h);
}

/** 气泡（BUBBLE 带尾 / 普通 label 无尾）：背景可透明，尺寸随字号/边距自适应 */
function makeBubbleImageData(
  text: string, bg: string, fg: string,
  fontSize = 13, radius = 8, padding = 8, tail = true
): ImageData {
  const canvas = document.createElement('canvas');
  const ctx0 = canvas.getContext('2d')!;
  const font = `bold ${fontSize}px "Microsoft YaHei", sans-serif`;
  ctx0.font = font;
  const tw = Math.ceil(ctx0.measureText(text || ' ').width);
  const tailH = tail ? 8 : 3;
  const w = Math.max(fontSize * 2.4, Math.ceil(tw + padding * 2));
  const h = Math.ceil(fontSize + padding * 2 + tailH);
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const transparent = bg === 'transparent' || /rgba\([^)]*,\s*0\)\s*$/.test(bg);
  const bh = h - tailH;
  const rr = Math.min(radius, bh / 2);
  if (!transparent) {
    ctx.fillStyle = bg;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(rr, 1);
    ctx.lineTo(w - rr, 1);
    ctx.arcTo(w - 1, 1, w - 1, rr, rr);
    ctx.lineTo(w - 1, bh - rr);
    ctx.arcTo(w - 1, bh, w - rr, bh, rr);
    if (tail) {
      ctx.lineTo(w / 2 + 6, bh);
      ctx.lineTo(w / 2, h - 1);
      ctx.lineTo(w / 2 - 6, bh);
    } else {
      ctx.lineTo(rr, bh);
    }
    ctx.arcTo(1, bh, 1, bh - rr, rr);
    ctx.lineTo(1, rr);
    ctx.arcTo(1, 1, rr, 1, rr);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  // 文字
  ctx.font = font;
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text || '', w / 2, (bh + 1) / 2 + 1);
  return ctx.getImageData(0, 0, w, h);
}

/** Emoji 彩色位图（文本层会丢色，用 canvas 位图保证彩色） */
function makeEmojiImageData(char: string): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = 48; canvas.height = 48;
  const ctx = canvas.getContext('2d')!;
  ctx.font = '38px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(char || '📍', 24, 26);
  return ctx.getImageData(0, 0, 48, 48);
}

function ensureShapeImage(map: maplibregl.Map, imageId: string, data: ImageData) {
  if (map.hasImage(imageId)) return;
  try {
    map.addImage(imageId, data, { pixelRatio: 1 });
    map.triggerRepaint();
  } catch { /* */ }
}

function renderPoint(map: maplibregl.Map, element: PointElement, frame: number) {
  const sourceId = `point-${element.id}`;
  const layerId = `point-layer-${element.id}`;
  const labelLayerId = `point-label-${element.id}`;
  const shape = element.shape || 'circle';
  const cap = getPinCapability(shape);
  /** 资源形态（image / gif / model / icon） */
  const isResourceShape = cap.source !== 'none';
  /** 走位图管线的形态（model 走 3D custom layer，见渲染端模型章节） */
  const isVisualShape = shape === 'image' || shape === 'gif' || shape === 'icon' || shape === 'model' || shape === 'military_symbol';
  const visualSrc = isResourceShape ? resolvePinVisualSource(element) : ({ type: 'none' } as const);
  const legacyIconUrl = element.iconUrl;
  const hasVisual = (isVisualShape && visualSrc.type !== 'none') || !!legacyIconUrl;
  const visualKey = legacyIconUrl
    || (visualSrc.type === 'builtin' ? visualSrc.asset.id
      : visualSrc.type === 'asset' ? visualSrc.assetId
      : visualSrc.type === 'icon' ? `${visualSrc.lib}:${visualSrc.name}`
      : '');
  const visualTint = element.color || '#FFFFFF';
  // 模型自转：角度由 frame 决定（确定性），量化为 10° 一档并纳入 imageId —— 换角度即换图
  const modelAngle = shape === 'model'
    ? Math.round(((element.visualMeta?.spin ?? 0) + (element.visualMeta?.autoRotate ?? 0) * (frame / renderFps)) / 10) * 10
    : 0;
  const visualImageId = `pt-vis-${hashStr(visualKey + visualTint + (shape === 'model' ? `@${modelAngle}` : ''))}`;
  const isTextPin = shape === 'text';
  const useShapeImg = shape === 'pin' || shape === 'bubble' || shape === 'circle';
  const isEmoji = shape === 'emoji';
  const circleVisible = !hasVisual && !isTextPin && !useShapeImg && !isEmoji;
  const labelHidden = element.label?.text === '';
  const hasLabel = (!!element.label?.text || isTextPin) && !labelHidden && shape !== 'bubble';
  // 文案偏移：优先连续偏移（offsetX / offsetY，0 = 居中，向上/左为负）；
  // 未设置时回退旧的位置枚举（兼容存量数据）；text 钉固定居中
  const hasCustomOffset = typeof element.label?.offsetX === 'number' || typeof element.label?.offsetY === 'number';
  const labelPos = hasCustomOffset || isTextPin ? 'center' : (element.label?.position || 'top');
  const emojiChar = element.emoji || '📍';
  const emojiImgId = 'pt-emoji-' + Array.from(emojiChar).map((c) => c.codePointAt(0)!.toString(16)).join('-');
  const scale = element.scale ?? 1;

  // 形状图（水滴/气泡/emoji）缓存 id
  const pinColor = element.color || '#FF4444';
  const bubbleBg = element.label?.bgColor || '#111111';
  const bubbleFg = element.label?.color || '#FFFFFF';
  const bubbleText = element.label?.text || element.name || '';
  const shapeImgId = shape === 'pin'
    ? `pt-pin-${pinColor.replace('#', '')}`
    : shape === 'circle'
    ? `pt-dot-${pinColor.replace('#', '')}`
    : `pt-bub-${hashStr(bubbleText + bubbleBg + bubbleFg + scale)}`;

  // 形状图数据就绪（懒生成；不设 isStyleLoaded 门禁——底图加载失败/慢时也要能注册图标，
  // 否则 dot/emoji/bubble 会空白。addImage 内部有 try/catch，style 未就绪时静默等下一帧重试。）
  if (shape === 'pin') ensureShapeImage(map, shapeImgId, getCached(`pin-${pinColor}`, () => makePinImageData(pinColor)));
  else if (shape === 'circle') ensureShapeImage(map, shapeImgId, getCached(`dot-${pinColor}`, () => makeDotImageData(pinColor)));
  else if (shape === 'bubble') ensureShapeImage(map, shapeImgId, getCached(`bub-${hashStr(bubbleText + bubbleBg + bubbleFg + scale)}`, () => makeBubbleImageData(bubbleText, bubbleBg, bubbleFg, 13 * scale, element.label?.bgRadius ?? 6, element.label?.bgPadding ?? 8, true)));
  else if (isEmoji) ensureShapeImage(map, emojiImgId, getCached(emojiImgId, () => makeEmojiImageData(emojiChar)));

  // 点标签背景图（LABEL）：无尾标签位图，默认透明背景；BUBBLE 才有尾巴
  const labelText = element.label?.text || element.name || '';
  const labelBg = element.label?.bgColor || 'rgba(0,0,0,0)';
  const labelFg = element.label?.color || '#FFFFFF';
  const labelSize = 13 * scale;
  const labelImgId = `pt-lbl-${hashStr(labelText + labelBg + labelFg + labelSize + (element.label?.bgRadius ?? 6) + (element.label?.bgPadding ?? 6) + shape)}`;
  // 偏移：自定义偏移（中心锚 + 像素偏移，0 居中；offsetY 正值向上，屏幕坐标需取负）；
  // 默认位于上方 40px；未设置偏移时按位置枚举避让本体
  const labelOffsetPx: [number, number] = hasCustomOffset
    ? [(element.label?.offsetX ?? 0) * scale, -(element.label?.offsetY ?? 40) * scale]
    : getLabelPixelOffset(shape, labelPos, scale);
  // ORIENTATION：faceCam=始终面向摄像机（默认）；flat=贴地 + 地图空间旋转
  const flat = element.orientation === 'flat';
  const pitchAlign = flat ? 'map' as const : 'viewport' as const;
  const rotAlign = flat ? 'map' as const : 'viewport' as const;
  const iconRotate = flat ? (element.rotation || 0) : 0;

  const opacity = getOpacity(element, frame);
  const geojson = turf.featureCollection([turf.point(element.coordinates, { name: element.label?.text || element.name, emoji: emojiChar })]);

  if (map.getSource(sourceId)) {
    (map.getSource(sourceId) as GeoJSONSource).setData(geojson);
    // 更新 circle 可见性
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, 'visibility', circleVisible ? 'visible' : 'none');
      map.setPaintProperty(layerId, 'circle-opacity', opacity);
      map.setPaintProperty(layerId, 'circle-color', element.color || '#FF4444');
      map.setPaintProperty(layerId, 'circle-radius', 8 * scale);
    }
    // 形状图 / emoji 层可见性 + 图像引用/缩放/朝向刷新
    if (map.getLayer(`${layerId}-shape`)) {
      map.setLayoutProperty(`${layerId}-shape`, 'visibility', useShapeImg && !(shape === 'bubble' && labelHidden) ? 'visible' : 'none');
      if (useShapeImg) {
        map.setLayoutProperty(`${layerId}-shape`, 'icon-image', shapeImgId);
        map.setLayoutProperty(`${layerId}-shape`, 'icon-anchor', shape === 'circle' ? 'center' : 'bottom');
        map.setLayoutProperty(`${layerId}-shape`, 'icon-size', scale);
        map.setLayoutProperty(`${layerId}-shape`, 'icon-pitch-alignment', pitchAlign);
        map.setLayoutProperty(`${layerId}-shape`, 'icon-rotation-alignment', rotAlign);
        map.setLayoutProperty(`${layerId}-shape`, 'icon-rotate', iconRotate);
      }
    }
    if (map.getLayer(`${layerId}-emoji`)) {
      map.setLayoutProperty(`${layerId}-emoji`, 'visibility', isEmoji ? 'visible' : 'none');
      if (isEmoji) {
        map.setLayoutProperty(`${layerId}-emoji`, 'icon-image', emojiImgId);
        map.setLayoutProperty(`${layerId}-emoji`, 'icon-size', scale);
        map.setLayoutProperty(`${layerId}-emoji`, 'icon-pitch-alignment', pitchAlign);
        map.setLayoutProperty(`${layerId}-emoji`, 'icon-rotation-alignment', rotAlign);
        map.setLayoutProperty(`${layerId}-emoji`, 'icon-rotate', iconRotate);
      }
    }
    // LABEL：无尾标签位图（默认透明背景 + 防遮挡偏移）
    if (map.getLayer(labelLayerId)) {
      map.setLayoutProperty(labelLayerId, 'visibility', hasLabel ? 'visible' : 'none');
      if (hasLabel) {
        if (!map.hasImage(labelImgId)) ensureShapeImage(map, labelImgId, getCached(labelImgId, () => makeBubbleImageData(labelText, labelBg, labelFg, labelSize, element.label?.bgRadius ?? 6, element.label?.bgPadding ?? 6, false)));
        map.setLayoutProperty(labelLayerId, 'icon-image', labelImgId);
        map.setLayoutProperty(labelLayerId, 'icon-anchor', getIconAnchor(labelPos) as any);
        map.setLayoutProperty(labelLayerId, 'icon-offset', labelOffsetPx as any);
        map.setLayoutProperty(labelLayerId, 'icon-pitch-alignment', pitchAlign);
        map.setLayoutProperty(labelLayerId, 'icon-rotation-alignment', rotAlign);
        map.setLayoutProperty(labelLayerId, 'icon-rotate', iconRotate);
        map.setPaintProperty(labelLayerId, 'icon-opacity', opacity);
      }
    }
    // 更新资源视觉层（图片 / GIF 静帧 / 图标 / 旧 iconUrl）
    if (map.getLayer(`${layerId}-icon`)) {
      map.setLayoutProperty(`${layerId}-icon`, 'visibility', hasVisual ? 'visible' : 'none');
      if (hasVisual) {
        if (map.hasImage(visualImageId)) {
          map.setLayoutProperty(`${layerId}-icon`, 'icon-image', visualImageId);
        }
        map.setLayoutProperty(`${layerId}-icon`, 'icon-size', visualIconSize(element, isVisualShape, scale));
        map.setLayoutProperty(`${layerId}-icon`, 'icon-pitch-alignment', pitchAlign);
        map.setLayoutProperty(`${layerId}-icon`, 'icon-rotation-alignment', rotAlign);
        map.setLayoutProperty(`${layerId}-icon`, 'icon-rotate', iconRotate);
        map.setPaintProperty(`${layerId}-icon`, 'icon-opacity', opacity);
      }
    }
    // 更新 label（气泡位图：可见性 + 图像/锚点/缩放/透明度同步）
    if (map.getLayer(labelLayerId)) {
      map.setLayoutProperty(labelLayerId, 'visibility', hasLabel ? 'visible' : 'none');
      if (hasLabel) {
        if (!map.hasImage(labelImgId)) ensureShapeImage(map, labelImgId, getCached(labelImgId, () => makeBubbleImageData(labelText, labelBg, labelFg, labelSize, element.label?.bgRadius ?? 6, element.label?.bgPadding ?? 6, false)));
        map.setLayoutProperty(labelLayerId, 'icon-image', labelImgId);
        map.setLayoutProperty(labelLayerId, 'icon-anchor', getIconAnchor(labelPos) as any);
        // 位置/偏移变化需同步（否则拖动位置滑块地图不更新）
        map.setLayoutProperty(labelLayerId, 'icon-offset', labelOffsetPx as any);
        map.setPaintProperty(labelLayerId, 'icon-opacity', opacity);
      }
    }
  } else {
    map.addSource(sourceId, { type: 'geojson', data: geojson });

    // 圆形标记（无 icon 时显示）
    map.addLayer({
      id: layerId, type: 'circle', source: sourceId,
      paint: {
        'circle-radius': 8 * scale,
        'circle-color': element.color || '#FF4444',
        'circle-stroke-width': 2,
        'circle-stroke-color': '#FFFFFF',
        'circle-opacity': opacity,
      },
      layout: { visibility: circleVisible ? 'visible' : 'none' },
    });

    // 形状图（水滴/气泡）与 emoji 层
    map.addLayer({
      id: `${layerId}-shape`, type: 'symbol', source: sourceId,
      layout: {
        'icon-image': shapeImgId,
        'icon-anchor': shape === 'circle' ? 'center' : 'bottom',
        'icon-allow-overlap': true,
        'icon-size': scale,
        'visibility': useShapeImg && !(shape === 'bubble' && labelHidden) ? 'visible' : 'none',
      },
    });
    map.addLayer({
      id: `${layerId}-emoji`, type: 'symbol', source: sourceId,
      layout: {
        'icon-image': emojiImgId,
        'icon-allow-overlap': true,
        'icon-size': scale,
        'visibility': isEmoji ? 'visible' : 'none',
      },
      paint: { 'icon-opacity': opacity },
    });

    // 资源视觉层（图片 / GIF 静帧 / 图标库）：资源异步就绪后由更新分支切到真实图
    ensurePlaceholderImage(map);
    map.addLayer({
      id: `${layerId}-icon`, type: 'symbol', source: sourceId,
      layout: {
        'icon-image': map.hasImage(visualImageId) ? visualImageId : VIS_PLACEHOLDER,
        'icon-allow-overlap': true,
        'icon-size': visualIconSize(element, isVisualShape, scale),
        'icon-pitch-alignment': pitchAlign,
        'icon-rotation-alignment': rotAlign,
        'icon-rotate': iconRotate,
        'visibility': hasVisual ? 'visible' : 'none',
      },
      paint: { 'icon-opacity': opacity },
    });

    // LABEL：无尾标签位图层（默认透明背景 + 防遮挡偏移）
    if (hasLabel) {
      ensureShapeImage(map, labelImgId, getCached(labelImgId, () => makeBubbleImageData(labelText, labelBg, labelFg, labelSize, element.label?.bgRadius ?? 6, element.label?.bgPadding ?? 6, false)));
    }
    map.addLayer({
      id: labelLayerId, type: 'symbol', source: sourceId,
      layout: {
        'icon-image': labelImgId,
        'icon-anchor': getIconAnchor(labelPos) as any,
        'icon-offset': labelOffsetPx as any,
        'icon-allow-overlap': true,
        'icon-size': 1,
        'visibility': hasLabel ? 'visible' : 'none',
      },
      paint: { 'icon-opacity': opacity },
    });
  }

  // 资源位图（内置 SVG / 上传素材 / 图标库）：异步就绪后 addImage 并触发重绘
  if (hasVisual) {
    if (shape === 'model') {
      ensureModelImage(map, visualImageId, visualSrc, modelAngle, visualTint);
    } else if (shape === 'gif') {
      ensureGifFrame(map, element, visualImageId, visualKey, visualSrc, frame, visualTint);
    } else {
      const tint = (!legacyIconUrl && cap.canTint) ? visualTint : undefined;
      ensureVisualImage(map, visualImageId, () => {
        if (legacyIconUrl) return legacyIconUrl;
        if (visualSrc.type === 'builtin') return visualSrc.asset.src || null;
        if (visualSrc.type === 'asset') return getAssetUrl(visualSrc.assetId);
        if (visualSrc.type === 'icon') {
          // 图标按元素 color 染色（此前硬编码 '#FFFFFF' 导致图标永远白色）
          return iconNameToDataUrl(visualSrc.lib, visualSrc.name, tint || '#FFFFFF', element.visualMeta?.strokeWidth ?? 2);
        }
        return null;
      }, tint);
    }
  }

}


/** label 位图锚点（与文字位置语义相反：label 在点上方 → 图片锚点在底部） */
function getIconAnchor(position: string): string {
  switch (position) {
    case 'top': return 'bottom';
    case 'bottom': return 'top';
    case 'left': return 'right';
    case 'right': return 'left';
    case 'center': return 'center';
    default: return 'top';
  }
}

/** label 像素偏移：避开水滴针/圆点本体，避免盖住图形 */
function getLabelPixelOffset(shape: string, pos: string, scale: number): [number, number] {
  const g = 6;
  const dotR = (shape === 'circle' ? 9.5 : 8) * scale;
  // emoji 位图 48px（icon-size=scale），避让半径按其实际尺寸
  const r = shape === 'emoji' ? 24 * scale : dotR;
  const pinH = 44 * scale;
  if (shape === 'pin') {
    switch (pos) {
      case 'top': return [0, -(pinH + g)];
      case 'bottom': return [0, g];
      case 'left': return [-(12 * scale + g), 0];
      case 'right': return [12 * scale + g, 0];
      default: return [0, 0];
    }
  }
  switch (pos) {
    case 'top': return [0, -(r + g)];
    case 'bottom': return [0, r + g];
    case 'left': return [-(r + g), 0];
    case 'right': return [r + g, 0];
    case 'center': return [0, 0];
    default: return [0, r + g];
  }
}

/**
 * 资源位图**首次就绪**时的通知钩子。
 *
 * 图片 / 动图 / 模型 / 图标库是异步加载的：首次渲染时图层先挂 VIS_PLACEHOLDER，
 * 等 addImage 完成后如果只 triggerRepaint，图层的 icon-image 仍是占位图 ——
 * 必须让编辑器再跑一次 renderElements 才会把 icon-image 切成真实位图
 * （否则表现为「点两次才显示」）。此处回调由 EditableMap 注册为 setStyleTick(+1)。
 * 注意：只在 addImage（首次创建）时通知，updateImage（GIF/模型逐帧换图）不通知，避免死循环。
 */
let onVisualReady: (() => void) | null = null;

/** 注册「资源位图就绪」回调（编辑器用；传 null 注销） */
export function setVisualReadyHandler(fn: (() => void) | null): void {
  onVisualReady = fn;
}

function notifyVisualReady(map: maplibregl.Map): void {
  try { map.triggerRepaint(); } catch { /* style 未就绪 */ }
  try { onVisualReady?.(); } catch { /* ignore */ }
}

/** 资源视觉层占位图（1×1 透明），避免 addLayer 时 icon-image 尚未加载而报错 */
const VIS_PLACEHOLDER = 'pt-vis-placeholder';

function ensurePlaceholderImage(map: maplibregl.Map): void {
  if (map.hasImage(VIS_PLACEHOLDER)) return;
  try {
    map.addImage(VIS_PLACEHOLDER, { width: 1, height: 1, data: new Uint8ClampedArray(4) }, { pixelRatio: 1 });
  } catch { /* style 未就绪：下一帧重试 */ }
}

/** 视觉层显示尺寸：资源形态随 scale（位图基准 64px），旧 iconUrl 沿用 iconSize 逻辑 */
function visualIconSize(element: PointElement, isVisualShape: boolean, scale: number): number {
  return isVisualShape ? scale : (element.iconSize || 24) / 64;
}

/** GIF 解码结果缓存（按资源 key） */
const gifFrameCache = new Map<string, GifFrames>();
const gifPending = new Set<string>();
const modelPending = new Set<string>();

/**
 * 清空渲染位图与解码缓存（切项目 / 卸载时调用）。
 * 这些缓存只增不减，长编辑会话会持续占用内存。
 */
export function clearRenderCaches(): void {
  gifFrameCache.clear();
  shapeImageCache.clear();
  gifPending.clear();
  modelPending.clear();
}

/** 当前元素相对自身起点的播放毫秒（GIF 循环 / 程序化动画的相位基准） */
function elapsedMsOf(element: { startFrame?: number }, frame: number): number {
  return Math.max(0, frame - (element.startFrame || 0)) * (1000 / renderFps);
}

/** 3D 模型：离屏渲染 → ImageData → 走普通位图管线（确定性，与 Remotion 兼容） */
function ensureModelImage(
  map: maplibregl.Map,
  imageId: string,
  src: ReturnType<typeof resolvePinVisualSource>,
  angle: number,
  color?: string,
): void {
  if (map.hasImage(imageId) || modelPending.has(imageId)) return;
  modelPending.add(imageId);
  void (async () => {
    const { renderProceduralModel, renderGltfModel } = await import('./model-renderer');
    let data: ImageData | null = null;
    if (src.type === 'builtin' && src.asset.model) {
      data = renderProceduralModel(src.asset.model.kind, angle, color || '#d7d3ce');
    } else if (src.type === 'asset') {
      const url = await getAssetUrl(src.assetId);
      data = url ? await renderGltfModel(url, angle, color) : null;
    }
    if (data) {
      try {
        if (map.hasImage(imageId)) map.updateImage(imageId, data);
        else { map.addImage(imageId, data, { pixelRatio: 1 }); notifyVisualReady(map); }
      } catch { /* style 未就绪：下一帧重试 */ }
    }
  })().finally(() => modelPending.delete(imageId));
}

/**
 * 路线/箭头「显示标记」的资源来源解析（与 point 的 resolvePinVisualSource 同构；
 * 优先级：图标库 → 内置资源 → 上传素材）。
 */
function moveIconVisualSrc(mi: LineElement['moveIcon']): ReturnType<typeof resolvePinVisualSource> {
  if (!mi) return { type: 'none' };
  if (mi.shape === 'icon' && mi.iconName) return { type: 'icon', lib: mi.iconLib || 'lucide', name: mi.iconName };
  const builtin = getBuiltinAsset(mi.builtinId);
  if (builtin) return { type: 'builtin', asset: builtin };
  if (mi.assetId) return { type: 'asset', assetId: mi.assetId };
  return { type: 'none' };
}

/** ImageData 染色（multiply + 恢复 alpha）；白色=原色直接返回。用于上传 GIF 帧统一着色 */
function tintImageData(data: ImageData, color?: string): ImageData {
  if (!color || color.toUpperCase() === '#FFFFFF') return data;
  const w = data.width;
  const h = data.height;
  const src = document.createElement('canvas');
  src.width = w; src.height = h;
  src.getContext('2d')!.putImageData(data, 0, 0);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = out.getContext('2d', { willReadFrequently: true })!;
  octx.drawImage(src, 0, 0);
  octx.globalCompositeOperation = 'multiply';
  octx.fillStyle = color;
  octx.fillRect(0, 0, w, h);
  octx.globalCompositeOperation = 'destination-in';
  octx.drawImage(src, 0, 0);           // 恢复原 alpha
  return octx.getImageData(0, 0, w, h);
}

/**
 * 动图：内置走程序化动画（canvas 逐帧绘制）；上传的 GIF 解码一次后按 frame 换帧。
 * 两者都由 elapsedMs 决定当前帧 —— 同一 frame 永远得到同一张图（Remotion 确定性）。
 * 着色：内置动图白色基图直接按 color 绘制；上传 GIF 帧取出后 multiply 染色（帧缓存保持原色）。
 */
function ensureGifFrame(
  map: maplibregl.Map,
  element: { startFrame?: number },
  imageId: string,
  key: string,
  src: ReturnType<typeof resolvePinVisualSource>,
  frame: number,
  color?: string,
): void {
  const ms = elapsedMsOf(element, frame);

  // 内置程序化动图
  if (src.type === 'builtin' && src.asset.anim) {
    const data = renderProceduralAnim(src.asset.anim, ms, color || '#FFFFFF');
    if (data) {
      try {
        if (map.hasImage(imageId)) map.updateImage(imageId, data);
        else { map.addImage(imageId, data, { pixelRatio: 1 }); notifyVisualReady(map); }
      } catch { /* style 未就绪 */ }
    }
    return;
  }

  // 上传的 GIF：先解码，之后每帧 updateImage
  const cached = gifFrameCache.get(key);
  if (cached) {
    const data = tintImageData(cached.frames[gifFrameAt(cached, ms)], color);
    try {
      if (map.hasImage(imageId)) map.updateImage(imageId, data);
      else { map.addImage(imageId, data, { pixelRatio: 1 }); notifyVisualReady(map); }
    } catch { /* style 未就绪 */ }
    return;
  }

  if (gifPending.has(key)) return;
  gifPending.add(key);
  void decodeGifCached(key, async () => {
    if (src.type === 'asset') {
      const bytes = await getAssetBytes(src.assetId);
      if (!bytes) return null;
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    }
    if (src.type === 'legacy-url') {
      try {
        const res = await fetch(src.url);
        return await res.arrayBuffer();
      } catch {
        return null;
      }
    }
    return null;
  })
    .then((g) => { if (g) gifFrameCache.set(key, g); })
    .finally(() => gifPending.delete(key));
}

const visualPending = new Set<string>();

/** 异步加载资源位图到 MapLibre（按 imageId 去重；就绪后触发重绘） */
function ensureVisualImage(
  map: maplibregl.Map,
  imageId: string,
  loader: () => string | null | Promise<string | null>,
  tint?: string,
): void {
  if (map.hasImage(imageId) || visualPending.has(imageId)) return;
  visualPending.add(imageId);
  void Promise.resolve()
    .then(loader)
    .then((src) => { if (src) ensureImageIcon(map, imageId, src, 64, tint); })
    .catch(() => { /* 资源缺失：保持占位 */ })
    .finally(() => visualPending.delete(imageId));
}



// ========== 渲染：移动点 ==========

function renderMovingPoint(map: maplibregl.Map, element: MovingPointElement, frame: number, interactive = false) {
  const progress = getProgress(element.pathProgress, frame);
  const currentPos = interpolatePath(element.path, progress);

  const guideSourceId = `moving-guide-${element.id}`;
  const guideLayerId = `moving-guide-layer-${element.id}`;
  const pathLine = turf.lineString(element.path);

  // 全程路径虚线引导：仅编辑端观察用（导出时若画出来会污染视频画面）
  if (interactive) {
    if (map.getSource(guideSourceId)) {
      (map.getSource(guideSourceId) as GeoJSONSource).setData(turf.featureCollection([pathLine]));
    } else {
      map.addSource(guideSourceId, { type: 'geojson', data: turf.featureCollection([pathLine]) });
      map.addLayer({
        id: guideLayerId, type: 'line', source: guideSourceId,
        paint: {
          'line-color': element.color || '#FF6600',
          'line-width': 2,
          'line-dasharray': [2, 2],
          'line-opacity': 0.5,
        },
      });
    }
  }

  const sourceId = `moving-${element.id}`;
  const layerId = `moving-layer-${element.id}`;
  const geojson = turf.featureCollection([turf.point(currentPos, { name: element.name })]);

  if (map.getSource(sourceId)) {
    (map.getSource(sourceId) as GeoJSONSource).setData(geojson);
  } else {
    map.addSource(sourceId, { type: 'geojson', data: geojson });
    map.addLayer({
      id: layerId, type: 'circle', source: sourceId,
      paint: {
        'circle-radius': 9,
        'circle-color': element.color || '#FF6600',
        'circle-stroke-width': 3,
        'circle-stroke-color': '#FFFFFF',
      },
    });
  }
}

// ========== 线（直线 / 贝塞尔） ==========

/** 计算线的实际几何（含贝塞尔/大圆弧展开），供渲染与选中高亮共用 */
export function lineEffectiveCoordinates(element: LineElement): [number, number][] {
  if (element.lineType === 'bezier' && element.coordinates.length >= 2) {
    try {
      const spline = turf.bezierSpline(turf.lineString(element.coordinates), { resolution: 8000, sharpness: 0.6 });
      return spline.geometry.coordinates as [number, number][];
    } catch {
      return element.coordinates;
    }
  }
  if (element.lineType === 'arc' && element.coordinates.length >= 2) {
    // 大圆弧：相邻顶点两两按地球大圆展开（适合洲际航线）
    const pts = element.coordinates;
    const out: [number, number][] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) continue;
      try {
        const gc = turf.greatCircle(a as [number, number], b as [number, number], { npoints: 96 });
        const cs = gc.geometry.coordinates as [number, number][];
        if (out.length === 0) out.push(...cs);
        else out.push(...cs.slice(1));
      } catch {
        if (i === 0) out.push(a);
      }
    }
    out.push(pts[pts.length - 1]);
    return out.length > 1 ? out : element.coordinates;
  }
  return element.coordinates;
}

/** 非均匀移动比例：按各路径点到达帧线性插值（首点到达前=起点，末点到达=完成）。
 * 只依赖 pointTimes 与当前帧，不受动画窗口(animStart/animEnd)截断。 */
export function nonUniformRatio(element: MapElement, frame: number): number {
  const times = (element as LineElement).pointTimes!;
  const n = times.length - 1;
  if (n < 1) return frame >= times[0] ? 1 : 0;
  // 绘制开始前（首点到达前）：起点（标记此时停在起点）
  if (frame <= times[0]) return 0;
  if (frame >= times[n]) return 1;
  for (let i = 0; i < n; i++) {
    if (frame >= times[i] && frame < times[i + 1]) {
      const span = Math.max(1, times[i + 1] - times[i]);
      return (i + (frame - times[i]) / span) / n;
    }
  }
  return 1;
}

function renderLine(map: maplibregl.Map, element: LineElement, frame: number) {
  const sourceId = `line-${element.id}`;
  const layerId = `line-layer-${element.id}`;
  const hitLayerId = `line-hit-${element.id}`;

  // 动画区间：路线线(shapeCategory='route')的显式 moveStartFrame/moveEndFrame 优先；
  // 形状线(shapeCategory='multi')直接完整显示，不套用 grow/fill/move 动画（与「一致显示」一致）
  const isShapeLine = element.shapeCategory === 'multi' || element.shapeCategory === 'special';
  const animStart = (!isShapeLine && element.moveStartFrame !== undefined) ? element.moveStartFrame : element.startFrame;
  const animEnd = (!isShapeLine && element.moveEndFrame !== undefined) ? element.moveEndFrame : element.endFrame;
  const anim = element.animEffect || 'grow';
  const isGrowOrFill = anim === 'grow' || anim === 'fill';
  const isMarch = (anim === 'march' || anim === 'marchplain') && !isShapeLine;
  const isFlyMode = !!element.flyMode && !isShapeLine;
  // 非均匀移动：线增长与标记同步（按各点到达帧映射路径比例；首点=绘制开始，末点=完成）
  const nonUniform = element.uniformMove === false && element.pointTimes && element.pointTimes.length >= 2;
  let progress = isShapeLine
    ? 1
    : isGrowOrFill || isMarch
      ? (animEnd > animStart ? Math.max(0, Math.min(1, (frame - animStart) / (animEnd - animStart))) : 1)
      : getProgress(element.drawProgress, frame);
  if (nonUniform) {
    progress = nonUniformRatio(element, frame);
  }
  const effective = lineEffectiveCoordinates(element);
  const isPlain = !!element.plainPath;

  // march 行进：定长亮段沿路线推进（头部前进），走过的消失，剩余段半透明不断变短
  const MARCH_FRAC = 0.35;
  let marchBright: any = null;
  let marchBase: any = null;
  let marchHead: [number, number] | null = null;
  let marchH = 0;
  let marchL = 0;
  let marchTotal = 0;
  if (isMarch && effective.length >= 2) {
    const full = turf.lineString(effective);
    const total = turf.length(full);
    if (total > 0) {
      const L = total * MARCH_FRAC;
      const h = L + (total - L) * progress;
      marchTotal = total;
      marchL = L;
      marchH = h;
      marchBright = turf.featureCollection([turf.lineSliceAlong(full, Math.max(0, h - L), h)]);
      if (anim === 'march' && total - h > total * 0.004) marchBase = turf.featureCollection([turf.lineSliceAlong(full, h, total)]);
      marchHead = turf.along(full, h).geometry.coordinates as [number, number];
    }
  }

  let data: any;
  if (isMarch && marchBright) {
    data = marchBright;
  } else if ((!isGrowOrFill && !nonUniform) || progress >= 1) {
    data = turf.featureCollection([turf.lineString(effective)]);
  } else {
    const full = turf.lineString(effective);
    const totalLength = turf.length(full);
    const sliced = turf.lineSliceAlong(full, 0, totalLength * Math.max(0.001, progress));
    data = turf.featureCollection([sliced]);
  }

  if (map.getSource(sourceId)) {
    (map.getSource(sourceId) as GeoJSONSource).setData(data);
    if (map.getLayer(layerId)) {
      map.setPaintProperty(layerId, 'line-color', element.lineColor || '#FF0000');
      map.setPaintProperty(layerId, 'line-width', element.lineWidth || 8);
      if (element.lineDashArray) {
        map.setPaintProperty(layerId, 'line-dasharray', element.lineDashArray);
      } else {
        try { map.setPaintProperty(layerId, 'line-dasharray', undefined); } catch { /* 重置失败忽略 */ }
      }
    }
  } else {
    map.addSource(sourceId, { type: 'geojson', data });
    // 点击热区层：宽透明线，提升选中命中率
    map.addLayer({
      id: hitLayerId, type: 'line', source: sourceId,
      paint: {
        'line-color': element.lineColor || '#FF0000',
        'line-width': Math.max(12, (element.lineWidth || 8) + 8),
        'line-opacity': 0,
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    });
    // 可见线层
    map.addLayer({
      id: layerId, type: 'line', source: sourceId,
      paint: {
        'line-color': element.lineColor || '#FF0000',
        'line-width': element.lineWidth || 8,
        ...(element.lineDashArray ? { 'line-dasharray': element.lineDashArray } : {}),
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    });
  }
  // 无样式路线：线条本身不显示（热区层保留可选中）
  if (map.getLayer(layerId)) {
    map.setLayoutProperty(layerId, 'visibility', isPlain ? 'none' : 'visible');
  }

  // ===== 飞行拱形（主线）：高度沿路线变化（起点贴地→逐渐抬升→巡航→逐渐降落回贴地）=====
  // 平滑拱形由 WebGL Custom Layer（fly-ribbon）逐顶点完成：相机变化零几何重算；基础线/热区隐藏，
  // 选中改由 pickFlyRibbon 屏幕距离判定。
  cleanupLegacyFlyBands(map);
  const flyActive = isFlyMode && !isPlain && effective.length >= 2;
  let flyFracA = 0;
  let flyFracB = 1;
  let flyFullKm = 1;
  let flyFullCumGeo: number[] | null = null;
  let flyDataF: number[] | null = null;
  /** 弧顶高度（米）：由路径总长度决定，与相机无关（挂点/光点/标记点共用） */
  let flyHeightM = 0;
  if (flyActive) {
    flyFullKm = geoLengthKm(effective);
    flyFullCumGeo = geodesicCum(effective);
    flyHeightM = flyArcHeightMeters(flyFullKm * 1000);
    const dataLine = data?.features?.[0]?.geometry?.coordinates as [number, number][] | undefined;
    if (isMarch && marchTotal > 0) {
      flyFracA = Math.max(0, marchH - marchL) / marchTotal;
      flyFracB = marchH / marchTotal;
      flyDataF = null;
    } else if (dataLine && dataLine.length >= 2) {
      // 全路线测地线绝对分数（与标记点同弧长空间）：ribbon 高度与标记点轨迹完全一致
      flyDataF = geodesicFracAbs(dataLine, flyFullKm);
      flyFracB = Math.max(0.001, Math.min(1, flyDataF[flyDataF.length - 1] || 1));
    }
    if (dataLine && dataLine.length >= 2) {
      try { map.setLayoutProperty(layerId, 'visibility', 'none'); } catch { /* */ }
      try { map.setLayoutProperty(hitLayerId, 'visibility', 'none'); } catch { /* */ }
      setFlyRibbon(map, `${element.id}|main`, {
        paths: [{ coords: dataLine, f: flyDataF ?? undefined }],
        frac: { a: flyFracA, b: flyFracB },
        color: element.lineColor || '#FF0000',
        widthPx: element.lineWidth || 8,
        opacity: 1,
        dash: element.lineDashArray,
        heightM: flyHeightM,
      });
    } else {
      setFlyRibbon(map, `${element.id}|main`, null);
    }
  } else {
    setFlyRibbon(map, `${element.id}|main`, null);
    try { if (map.getLayer(hitLayerId)) map.setLayoutProperty(hitLayerId, 'visibility', 'visible'); } catch { /* */ }
  }

  // fill 填充效果：底层完整半透明线；march：剩余段半透明（不断变短）
  const fillSrcId = `line-fill-src-${element.id}`;
  const fillLayerId = `line-fill-layer-${element.id}`;
  if ((anim === 'fill' && !isPlain) || (isMarch && !isPlain && marchBase)) {
    const fullData = anim === 'fill' ? turf.featureCollection([turf.lineString(effective)]) : marchBase;
    try {
      if (map.getSource(fillSrcId)) {
        (map.getSource(fillSrcId) as GeoJSONSource).setData(fullData);
        if (map.getLayer(fillLayerId)) map.setLayoutProperty(fillLayerId, 'visibility', 'visible');
      } else {
        map.addSource(fillSrcId, { type: 'geojson', data: fullData } as any);
        map.addLayer({
          id: fillLayerId, type: 'line', source: fillSrcId,
          paint: {
            'line-color': element.lineColor || '#FF0000',
            'line-width': element.lineWidth || 8,
            'line-opacity': 0.35,
            ...(element.lineDashArray ? { 'line-dasharray': element.lineDashArray } : {}),
          },
          layout: { 'line-cap': 'round', 'line-join': 'round' },
        });
      }
    } catch { /* style 未就绪 */ }
  } else if (map.getLayer(fillLayerId)) {
    try { map.removeLayer(fillLayerId); } catch { /* */ }
    try { if (map.getSource(fillSrcId)) map.removeSource(fillSrcId); } catch { /* */ }
  }

  // 飞行拱形：不再显示幽灵垫层（fill 完整线 / march 剩余段）。
  // 原因：垫层从当前头部沿拱弧降回终点，视觉上形成"空中一段 + 地面一段"的双影；
  // 飞行模式下主线（含 fill/march 的拱上进度段）已足够表达，直接隐藏贴地填充层并清理旧垫层。
  if (flyActive) {
    try { if (map.getLayer(fillLayerId)) map.setLayoutProperty(fillLayerId, 'visibility', 'none'); } catch { /* */ }
  }
  setFlyRibbon(map, `${element.id}|ghost`, null);

  // fly 航迹已并入路线本体（不再有独立虚线航迹层）；此处仅清理旧版本/同会话切换的残留层
  const raySrcId = `fly-ray-src-${element.id}`;
  const rayLayerId = `fly-ray-${element.id}`;
  if (map.getLayer(rayLayerId)) {
    try { map.removeLayer(rayLayerId); } catch { /* */ }
    try { if (map.getSource(raySrcId)) map.removeSource(raySrcId); } catch { /* */ }
  }

  // 移动图标（标记点沿路径）：showIcon 或 animEffect='move'
  const hasAnim = !!element.animEffect;
  const iconSrcId = `line-move-src-${element.id}`;
  const iconLayerId = `line-move-layer-${element.id}`;
  const mi = element.moveIcon;
  const mLabelText = mi?.labelText ?? '';
  const mShape = (mi?.shape === 'bubble' || mi?.shape === 'text') && !mLabelText ? 'dot' : (mi?.shape || 'dot');
  const mColor = mi?.color || element.lineColor || '#FF6600';
  const mScale = mi?.scale ?? 1;
  const mEmoji = mi?.emoji || '📍';
  const mLabelColor = mi?.labelColor || '#000000';
  const mLabelBg = mi?.labelBg || '#FFFFFF';
  const mImgId = mShape === 'emoji'
    ? 'pt-emoji-' + Array.from(mEmoji).map((c) => (c as string).codePointAt(0)!.toString(16)).join('-')
    : mShape === 'bubble'
      ? `pt-mbub-${hashStr(mLabelText + mLabelBg + mLabelColor + mScale + (mi?.labelSize ?? 12) + (mi?.labelPadding ?? 8) + (mi?.labelRadius ?? 6) + (mi?.labelPos || 'bottom'))}`
      : mShape === 'text'
        ? `pt-mtxt-${hashStr(mLabelText + mLabelColor + mScale + (mi?.labelSize ?? 13))}`
        : mShape === 'flag'
          ? `pt-mflag-${hashStr((mi?.flagText || '旗') + (mi?.flagColor || mColor) + mScale)}`
          : (mShape === 'image' || mShape === 'gif' || mShape === 'model' || mShape === 'icon' || mShape === 'military_symbol')
            ? `pt-mvis-${hashStr(mShape + (mi?.builtinId || '') + (mi?.assetId || '') + (mi?.iconLib || '') + (mi?.iconName || '') + mColor)}`
            : (mShape === 'pin' ? `pt-pin-${mColor.replace('#', '')}` : `pt-dot-${mColor.replace('#', '')}`);
  const inDisplay = frame >= element.startFrame && frame <= element.endFrame;
  const beforeAnim = inDisplay && hasAnim && frame < animStart;
  const duringAnim = inDisplay && hasAnim && frame >= animStart && frame <= animEnd;
  const afterAnim = inDisplay && hasAnim && frame > animEnd;
  // 标记：仅「显示标记」开启才渲染；动画前在起点、动画中移动、动画结束后停在终点，直到路线显示结束一起消失
  const needMarker = !!element.showIcon && (beforeAnim || duringAnim || afterAnim || inDisplay);

  // 图标位置比例（0..1）：与 move 一致（动画窗口插值；grow/fill 用绘制进度；非均匀按各点到达帧）
  const iconRatio = (nonUniform && inDisplay)
    ? nonUniformRatio(element, frame)
    : beforeAnim ? 0
    : afterAnim ? 1
    : (duringAnim || (element.showIcon && !hasAnim))
      ? (isGrowOrFill ? progress : (animEnd > animStart ? Math.max(0, Math.min(1, (frame - animStart) / (animEnd - animStart))) : 0))
      : 0;
  if (needMarker && effective.length >= 2) {
    const ratio = iconRatio;
    // march：标记骑在定长亮段头部；其余：沿路线（弧长）取点
    const iconCoord: [number, number] = (isMarch && marchHead)
      ? marchHead
      : interpolatePath(effective, Math.max(0, Math.min(1, ratio)));
    const iconData = turf.featureCollection([turf.point(iconCoord, { name: element.name })]);
    try {
      if (mShape === 'pin') ensureShapeImage(map, mImgId, getCached(`pin-${mColor}`, () => makePinImageData(mColor)));
      else if (mShape === 'emoji') ensureShapeImage(map, mImgId, getCached(mImgId, () => makeEmojiImageData(mEmoji)));
      else if (mShape === 'bubble') ensureShapeImage(map, mImgId, getCached(mImgId, () => makeBubbleImageData(mLabelText, mLabelBg, mLabelColor, (mi?.labelSize ?? 12) * mScale, mi?.labelRadius ?? 6, mi?.labelPadding ?? 8, false)));
      else if (mShape === 'text') ensureShapeImage(map, mImgId, getCached(mImgId, () => makeBubbleImageData(mLabelText, 'rgba(0,0,0,0)', mLabelColor, (mi?.labelSize ?? 13) * mScale, mi?.labelRadius ?? 3, mi?.labelPadding ?? 4, false)));
      else if (mShape === 'flag') ensureShapeImage(map, mImgId, getCached(mImgId, () => makeFlagImageData({ text: mi?.flagText || '旗', flagColor: mi?.flagColor || mColor, textColor: mi?.labelColor || '#FFFFFF', fontSize: Math.round(16 * mScale), flagWidth: Math.round(72 * mScale), scale: 1 }) || makeDotImageData(mColor)));
      else if (mShape === 'image' || mShape === 'gif' || mShape === 'model' || mShape === 'icon' || mShape === 'military_symbol') {
        // 资源形态：与标记共用资源管线（内置 / 上传素材 / 图标库）
        const vsrc = moveIconVisualSrc(mi);
        if (mShape === 'gif') {
          ensureGifFrame(map, { startFrame: element.startFrame }, mImgId, `gif:${vsrc.type === 'asset' ? vsrc.assetId : vsrc.type === 'builtin' ? vsrc.asset.id : element.id}`, vsrc, frame, mColor);
        } else if (mShape === 'model') {
          ensureModelImage(map, mImgId, vsrc, 0, mColor);
        } else {
          ensureVisualImage(map, mImgId, () => {
            if (vsrc.type === 'builtin') return vsrc.asset.src || null;
            if (vsrc.type === 'asset') return getAssetUrl(vsrc.assetId);
            if (vsrc.type === 'icon') return iconNameToDataUrl(vsrc.lib, vsrc.name, mColor);
            if (vsrc.type === 'legacy-url') return vsrc.url;
            return null;
          }, mColor);
        }
      }
      else ensureShapeImage(map, mImgId, getCached(`dot-${mColor}`, () => makeDotImageData(mColor)));
      if (map.getSource(iconSrcId)) {
        (map.getSource(iconSrcId) as GeoJSONSource).setData(iconData);
      } else {
        map.addSource(iconSrcId, { type: 'geojson', data: iconData } as any);
        map.addLayer({
          id: iconLayerId, type: 'symbol', source: iconSrcId,
          layout: {
            'icon-image': mImgId, 'icon-size': mScale,
            'icon-anchor': mShape === 'pin' ? 'bottom' : 'center',
            'icon-offset': [0, 0] as any, 'icon-allow-overlap': true,
            // 朝向：与标记设置一致（faceCam 面向镜头 / flat 贴地 + 地图空间旋转）
            'icon-pitch-alignment': (mi?.orientation === 'flat' ? 'map' : 'viewport') as any,
            'icon-rotation-alignment': (mi?.orientation === 'flat' ? 'map' : 'viewport') as any,
            'icon-rotate': (mi?.orientation === 'flat' ? (mi?.rotation || 0) : 0) as any,
          },
        });
      }
      if (map.getLayer(iconLayerId)) {
        map.setLayoutProperty(iconLayerId, 'icon-image', mImgId);
        map.setLayoutProperty(iconLayerId, 'icon-size', mScale);
        map.setLayoutProperty(iconLayerId, 'icon-anchor', mShape === 'pin' ? 'bottom' : 'center');
        map.setLayoutProperty(iconLayerId, 'icon-offset', [0, 0] as any);
        map.setLayoutProperty(iconLayerId, 'icon-pitch-alignment', (mi?.orientation === 'flat' ? 'map' : 'viewport') as any);
        map.setLayoutProperty(iconLayerId, 'icon-rotation-alignment', (mi?.orientation === 'flat' ? 'map' : 'viewport') as any);
        map.setLayoutProperty(iconLayerId, 'icon-rotate', (mi?.orientation === 'flat' ? (mi?.rotation || 0) : 0) as any);
        map.setLayoutProperty(iconLayerId, 'visibility', 'visible');
      }
      // 标记标签：showLabel 开启且非 bubble/text 形状时，在标记旁显示文字气泡
      if (mi?.showLabel && mShape !== 'bubble' && mShape !== 'text' && mLabelText) {
        const lSrcId = `line-mlabel-src-${element.id}`;
        const lLayerId = `line-mlabel-${element.id}`;
        const lImgId = `pt-mlbl-${hashStr(mLabelText + mLabelColor + mLabelBg + mScale + (mi?.labelSize ?? 12) + (mi?.labelPadding ?? 4) + (mi?.labelRadius ?? 3))}`;
        ensureShapeImage(map, lImgId, getCached(lImgId, () => makeBubbleImageData(mLabelText, mLabelBg, mLabelColor, (mi?.labelSize ?? 12) * mScale, mi?.labelRadius ?? 3, mi?.labelPadding ?? 4, false)));
        // 标签偏移：优先连续偏移（中心锚 + 像素，offsetY 正值向上）；未设置时回退旧位置枚举
        const useLabelOff = typeof mi?.labelOffsetX === 'number' || typeof mi?.labelOffsetY === 'number';
        const off: [number, number] = useLabelOff
          ? [(mi?.labelOffsetX ?? 0) * mScale, -(mi?.labelOffsetY ?? 40) * mScale]
          : ((mi?.labelPos || 'top') === 'top' ? [0, -28] : (mi?.labelPos || 'top') === 'left' ? [-40, 0] : (mi?.labelPos || 'top') === 'right' ? [40, 0] : [0, 26]);
        try {
          if (map.getSource(lSrcId)) {
            (map.getSource(lSrcId) as GeoJSONSource).setData(iconData);
          } else {
            map.addSource(lSrcId, { type: 'geojson', data: iconData } as any);
            map.addLayer({
              id: lLayerId, type: 'symbol', source: lSrcId,
              layout: { 'icon-image': lImgId, 'icon-size': 1, 'icon-offset': off, 'icon-allow-overlap': true },
            });
          }
          if (map.getLayer(lLayerId)) {
            map.setLayoutProperty(lLayerId, 'icon-image', lImgId);
            map.setLayoutProperty(lLayerId, 'icon-offset', off);
            map.setLayoutProperty(lLayerId, 'visibility', 'visible');
          }
        } catch { /* */ }
} else if (map.getLayer('line-mlabel-' + element.id)) {
        try { map.removeLayer('line-mlabel-' + element.id); } catch { /* */ }
        try { if (map.getSource('line-mlabel-src-' + element.id)) map.removeSource('line-mlabel-src-' + element.id); } catch { /* */ }
      }
      // 飞行模式：标记点改由 fly-ribbon 自定义层绘制（与拱形同一投影，精确对齐），隐藏 symbol 层
      if (flyActive) {
        try { if (map.getLayer(iconLayerId)) map.setLayoutProperty(iconLayerId, 'visibility', 'none'); } catch { /* */ }
        try { if (map.getLayer(`line-mlabel-${element.id}`)) map.setLayoutProperty(`line-mlabel-${element.id}`, 'visibility', 'none'); } catch { /* */ }
        const imgH = (map.getImage(mImgId) as any)?.data?.height || 32;
        setFlyMarker(map, `${element.id}|icon`, [{
          imgId: mImgId, lnglat: iconCoord,
          lift01: flyHeight01(Math.max(0, Math.min(1, iconRatio))),
          heightM: flyHeightM,
          sizePx: imgH * mScale,
          anchorX: 0.5, anchorY: mShape === 'pin' ? 1 : 0.5,
        }]);
      } else {
        setFlyMarker(map, `${element.id}|icon`, null);
      }
    } catch { /* style 未就绪 */ }
  } else if (map.getLayer(iconLayerId)) {
    try { map.removeLayer(iconLayerId); } catch { /* */ }
    try { if (map.getSource(iconSrcId)) map.removeSource(iconSrcId); } catch { /* */ }
    setFlyMarker(map, `${element.id}|icon`, null);
  }

  // 战线梳齿（钢铁雄心防线风格）：主线指向的右手侧/左手侧短齿
  const frontSrcId = `line-front-src-${element.id}`;
  const frontLayerId = `line-front-${element.id}`;
  const haveFront = !!element.frontStyle;
  if (haveFront) {
    const fs = element.frontStyle!;
    const toothLen = fs.toothLength ?? 14;
    const toothGap = fs.toothGap ?? 24;
    const side = fs.side ?? 1;
    const tilt = ((fs.toothAngle ?? 0) * Math.PI) / 180;
    // 沿有效线等距采样生成梳齿（屏幕像素级）
    const proj = effective.map((c) => map.project(c));
    const lines: [number, number][][] = [];
    if (proj.length >= 2) {
      const stepPx = toothGap;
      let acc = 0;
      let prev = proj[0] as any;
      for (let i = 1; i < proj.length; i++) {
        const cur = proj[i] as any;
        let seg = Math.hypot(cur.x - prev.x, cur.y - prev.y);
        if (seg <= 0) continue;
        while (seg > 0 && acc + seg >= stepPx) {
          const t = (stepPx - acc) / seg;
          const bx = prev.x + (cur.x - prev.x) * t;
          const by = prev.y + (cur.y - prev.y) * t;
          // 主线切向
          let tx = cur.x - prev.x, ty = cur.y - prev.y;
          const tl = Math.hypot(tx, ty) || 1;
          tx /= tl; ty /= tl;
          // 法向（右=顺时针）
          const nx = -ty, ny = tx;
          const ang = Math.cos(tilt), sine = Math.sin(tilt);
          const dirX = nx * side * ang - tx * side * sine;
          const dirY = ny * side * ang - ty * side * sine;
          const ex = bx + dirX * toothLen;
          const ey = by + dirY * toothLen;
          const ll1 = map.unproject([bx, by]);
          const ll2 = map.unproject([ex, ey]);
          lines.push([[ll1.lng, ll1.lat], [ll2.lng, ll2.lat]]);
          // 扣减已走长度，推进到下一个齿位
          seg -= (stepPx - acc);
          prev = { x: bx, y: by };
          acc = 0;
        }
        acc += seg;
        prev = cur;
      }
    }
    const fc = turf.featureCollection(lines.map((l) => turf.lineString(l)));
    try {
      if (map.getSource(frontSrcId)) {
        (map.getSource(frontSrcId) as GeoJSONSource).setData(fc);
      } else {
        map.addSource(frontSrcId, { type: 'geojson', data: fc } as any);
        map.addLayer({
          id: frontLayerId, type: 'line', source: frontSrcId,
          paint: { 'line-color': element.lineColor || '#FF0000', 'line-width': Math.max(2, (element.lineWidth || 8) * 0.35) },
          layout: { 'line-cap': 'round' },
        });
      }
    } catch { /* style 未就绪 */ }
  } else if (map.getLayer(frontLayerId)) {
    try { map.removeLayer(frontLayerId); } catch { /* */ }
    try { if (map.getSource(frontSrcId)) map.removeSource(frontSrcId); } catch { /* */ }
  }

  // 方向箭头（示意）：线末端小三角，随线色；SVG 图标按像素固定尺寸渲染，与 zoom 无关
  const headSrcId = `line-head-src-${element.id}`;
  const headLayerId = `line-head-${element.id}`;
  // 箭头头部始终显示（有 lineArrow 即显示），位置跟随**当前线段末端**：
  //   原实现仅 progress>=1 时显示且取完整路径末端 → 动画期间看不见、出现时与线段脱节。
  const showHead = !!element.lineArrow && effective.length >= 2;
  (window as any).__hl = { lineArrow: !!element.lineArrow, progress, effLen: effective.length, showHead };
  if (showHead) {
    // 优先用本帧实际绘制的线段（动画中即进度位置），保证头部与线严格相连
    const curLine = (data?.features?.[0]?.geometry?.coordinates as [number, number][] | undefined) ?? null;
    let tipLL = (curLine && curLine.length >= 2 ? curLine[curLine.length - 1] : effective[effective.length - 1]) as [number, number];
    let prevLL = (curLine && curLine.length >= 2 ? curLine[curLine.length - 2] : effective[effective.length - 2]) as [number, number];
    if (isMarch && marchHead && effective.length >= 2) {
      // march：方向箭头骑在亮段头部，方向取亮段末端两点
      const bw = marchBright?.features?.[0]?.geometry?.coordinates as [number, number][] | undefined;
      if (bw && bw.length >= 2) { tipLL = bw[bw.length - 1]; prevLL = bw[bw.length - 2]; }
      else { tipLL = marchHead; prevLL = effective[0] as [number, number]; }
    }
    const a = map.project(prevLL);
    const b = map.project(tipLL);
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    // 像素角度：project 已含 bearing/投影，viewport 对齐直接用屏幕角
    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    const size = (element.lineWidth || 8) * 3;
    const color = element.lineColor || '#FF0000';
    const headImgId = `line-head-img-${element.id}`;
    try {
      const headCache = renderedHeadColorByMap.get(map) || new Map<string, string>();
      const cacheKey = `${color}|${size}`;
      if (!map.hasImage(headImgId) || headCache.get(element.id) !== cacheKey) {
        if (map.hasImage(headImgId)) map.removeImage(headImgId);
        map.addImage(headImgId, makeTriangleImage(color, size));
        headCache.set(element.id, cacheKey);
        renderedHeadColorByMap.set(map, headCache);
      }
      const headData = turf.featureCollection([turf.point(tipLL, { rot: angleDeg })]);
      if (map.getSource(headSrcId)) {
        (map.getSource(headSrcId) as GeoJSONSource).setData(headData);
        if (map.getLayer(headLayerId)) {
          map.setLayoutProperty(headLayerId, 'icon-rotate', ['get', 'rot'] as any);
          map.setLayoutProperty(headLayerId, 'visibility', 'visible');
        }
      } else {
        map.addSource(headSrcId, { type: 'geojson', data: headData } as any);
        map.addLayer({
          id: headLayerId, type: 'symbol', source: headSrcId,
          layout: {
            'icon-image': headImgId,
            'icon-size': 1,
            'icon-rotate': ['get', 'rot'],
            'icon-rotation-alignment': 'viewport',
            'icon-anchor': 'center',
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          },
        });
        if (map.getLayer(headLayerId)) map.moveLayer(headLayerId);
      }
    } catch { /* style 未就绪或图标未加载 */ }
  } else if (map.getLayer(headLayerId)) {
    map.setLayoutProperty(headLayerId, 'visibility', 'none');
  }

  // 线中点文案
  const labelSourceId = `linelabel-src-${element.id}`;
  const labelBgId = `linelabel-bg-${element.id}`;
  const labelLayerId = `linelabel-${element.id}`;
  const hasLabel = !!element.label?.text;

  if (hasLabel) {
    // 取有效几何的中点
    const effective = lineEffectiveCoordinates(element);
    const midCoord = getLineMidpoint(effective);
    const labelData = turf.featureCollection([turf.point(midCoord, { text: element.label!.text })]);

    if (map.getSource(labelSourceId)) {
      (map.getSource(labelSourceId) as GeoJSONSource).setData(labelData);
      // LABEL STYLE 实时同步
      if (map.getLayer(labelBgId)) {
        const L = element.label!;
        map.setLayoutProperty(labelBgId, 'text-size', L.fontSize || 12);
        map.setPaintProperty(labelBgId, 'text-color', L.color || '#FFFFFF');
        map.setPaintProperty(labelBgId, 'text-halo-color', L.bgColor || 'rgba(0,0,0,0.7)');
        map.setPaintProperty(labelBgId, 'text-halo-width', L.bgPadding ?? 3);
        map.setPaintProperty(labelBgId, 'text-halo-blur', L.bgRadius ?? 2);
      }
      if (map.getLayer(labelLayerId)) {
        const L = element.label!;
        map.setLayoutProperty(labelLayerId, 'text-size', L.fontSize || 12);
        map.setPaintProperty(labelLayerId, 'text-color', L.color || '#FFFFFF');
      }
    } else {
      map.addSource(labelSourceId, { type: 'geojson', data: labelData });
    }

    if (!map.getLayer(labelBgId)) {
      map.addLayer({
        id: labelBgId, type: 'symbol', source: labelSourceId,
        layout: {
          'text-field': ['get', 'text'],
          'text-size': element.label?.fontSize || 12,
          'text-anchor': 'center',
          'text-offset': [0, 0],
        },
        paint: {
          'text-color': element.label?.color || '#FFFFFF',
          'text-halo-color': element.label?.bgColor || 'rgba(0,0,0,0.7)',
          'text-halo-width': element.label?.bgPadding ?? 3,
          'text-halo-blur': element.label?.bgRadius ?? 2,
        },
      });
    }
    if (!map.getLayer(labelLayerId)) {
      map.addLayer({
        id: labelLayerId, type: 'symbol', source: labelSourceId,
        layout: {
          'text-field': ['get', 'text'],
          'text-size': element.label?.fontSize || 12,
          'text-anchor': 'center',
  
        },
        paint: {
          'text-color': element.label?.color || '#FFFFFF',
        },
      });
    }
  } else {
    // 无 label 时清理
    if (map.getLayer(labelBgId)) map.removeLayer(labelBgId);
    if (map.getLayer(labelLayerId)) map.removeLayer(labelLayerId);
    if (map.getSource(labelSourceId)) map.removeSource(labelSourceId);
  }

  // 行军路线流动光点（多颗错位滚动）
  const dots = Math.max(1, element.routeEffect?.dotCount ?? 1);
  if ((element.routeEffect?.enabled || (element.flowSpeed && element.flowSpeed > 0)) && dots > 0) {
    const frameStep = element.routeEffect?.frameStep || element.flowSpeed || 10;
    const basePhase = (Math.floor(frame / frameStep) % 1000) / 1000;
    for (let i = 0; i < dots; i++) {
      const offset = i / dots;
      const idx = Math.floor((basePhase + offset) * effective.length) % effective.length;
      const spotCoord = effective[idx];
      const spotSourceId = `linespot-${element.id}-${i}`;
      const spotLayerId = `linespot-layer-${element.id}-${i}`;
      const spotData = turf.featureCollection([turf.point(spotCoord)]);
      if (map.getSource(spotSourceId)) {
        (map.getSource(spotSourceId) as GeoJSONSource).setData(spotData);
      } else {
        map.addSource(spotSourceId, { type: 'geojson', data: spotData });
        map.addLayer({
          id: spotLayerId, type: 'circle', source: spotSourceId,
          paint: {
            'circle-radius': element.routeEffect?.spotWidth || 6,
            'circle-color': element.routeEffect?.spotColor || '#FFE066',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#FFFFFF',
          },
        });
      }
      // 飞行拱形：光点按所在沿线位置取高度（与 ribbon 同测地线弧长、同 3D 投影）
      if (flyActive && flyFullCumGeo) {
        const s = flyFullCumGeo[Math.min(idx, flyFullCumGeo.length - 1)] / flyFullKm;
        try {
          const tr = liftTranslate(map, spotCoord, flyHeight01(Math.max(0, Math.min(1, s))), flyHeightM);
          map.setPaintProperty(spotLayerId, 'circle-translate', tr as any);
          map.setPaintProperty(spotLayerId, 'circle-translate-anchor', 'viewport');
        } catch { /* */ }
      }
    }
  }

  // 飞行拱形：各挂点按自身「沿线位置」取高度（translate=3D 抬升后的屏幕位置，anchor=viewport）。
  // 主线/热区/幽灵垫层在拱形模式下由分段层替代（已隐藏，无需平移）；战线梳齿保持贴地。
  const zeroShift: [number, number] = [0, 0];
  const iconLnglat: [number, number] | null = (isMarch && marchHead)
    ? marchHead
    : (effective.length >= 2 ? interpolatePath(effective, Math.max(0, Math.min(1, iconRatio))) : null);
  const headLnglat: [number, number] | null = (isMarch && marchHead)
    ? marchHead
    : (flyActive && effective.length >= 2 ? interpolatePath(effective, Math.max(0, Math.min(1, flyFracB))) : null);
  const flyIconShift: [number, number] = flyActive && iconLnglat
    ? liftTranslate(map, iconLnglat, flyHeight01(Math.max(0, Math.min(1, iconRatio))), flyHeightM)
    : zeroShift;
  const flyHeadShift: [number, number] = flyActive && headLnglat
    ? liftTranslate(map, headLnglat, flyHeight01(Math.max(0, Math.min(1, flyFracB))), flyHeightM)
    : zeroShift;
  const flyLabelShift: [number, number] = flyActive && effective.length >= 2
    ? liftTranslate(map, interpolatePath(effective, 0.5), 1, flyHeightM) // 线中点文案=全程中点=拱顶
    : zeroShift;
  const translateLayer = (layer: string, prop: string, shift: [number, number]) => {
    if (!map.getLayer(layer)) return;
    try {
      map.setPaintProperty(layer, prop, shift as any);
      map.setPaintProperty(layer, `${prop}-anchor`, 'viewport');
    } catch { /* 层未创建或样式未就绪 */ }
  };
  if (flyActive) {
    translateLayer(headLayerId, 'icon-translate', flyHeadShift);
    translateLayer(iconLayerId, 'icon-translate', flyIconShift);
    translateLayer(`line-mlabel-${element.id}`, 'icon-translate', flyIconShift);
    translateLayer(labelBgId, 'text-translate', flyLabelShift);
    translateLayer(labelLayerId, 'text-translate', flyLabelShift);
  } else {
    translateLayer(layerId, 'line-translate', zeroShift);
    translateLayer(hitLayerId, 'line-translate', zeroShift);
    translateLayer(fillLayerId, 'line-translate', zeroShift);
    translateLayer(frontLayerId, 'line-translate', zeroShift);
    translateLayer(headLayerId, 'icon-translate', zeroShift);
    translateLayer(iconLayerId, 'icon-translate', zeroShift);
    translateLayer(`line-mlabel-${element.id}`, 'icon-translate', zeroShift);
    translateLayer(labelBgId, 'text-translate', zeroShift);
    translateLayer(labelLayerId, 'text-translate', zeroShift);
    for (let i = 0; i < dots; i++) translateLayer(`linespot-layer-${element.id}-${i}`, 'circle-translate', zeroShift);
  }
}

/** 将屏幕像素宽度转换为当前缩放/纬度下的经纬度偏移量（用于箭头等需要恒定屏幕尺寸的几何） */
export function pixelsToDegrees(pixels: number, zoom: number, lat: number): number {
  const latRad = (lat * Math.PI) / 180;
  const metersPerPx = (40075016.686 * Math.cos(latRad)) / (256 * Math.pow(2, zoom));
  return (pixels * metersPerPx) / 111319.49079327358;
}

// ========== 渲染：面 ==========

function renderPolygon(map: maplibregl.Map, element: PolygonElement, frame: number) {
  const sourceId = `polygon-${element.id}`;
  const fillLayerId = `polygon-fill-layer-${element.id}`;
  const strokeLayerId = `polygon-stroke-layer-${element.id}`;
  const defendSrcId = `polygon-defend-src-${element.id}`;
  const defendLayerId = `polygon-defend-${element.id}`;

  let coordinates = element.coordinates;
  if (element.morphKeyframes && element.morphKeyframes.length > 0) {
    coordinates = interpolateMorph(element.morphKeyframes, frame);
  } else {
    // 形状元数据优先（矩形/圆/五角星），旋转绕中心生效
    coordinates = compileShapeCoordinates(element);
  }

  const geojson = turf.featureCollection([turf.polygon(coordinates)]);

  // 幂等：source 与 layer 分开检查；每次 setData 后恢复 visibility（避免被 hideElementLayers 设置 none 后不复活）
  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, { type: 'geojson', data: geojson });
  }
  if (!map.getLayer(fillLayerId)) {
    map.addLayer({
      id: fillLayerId, type: 'fill', source: sourceId,
      paint: { 'fill-color': element.fillColor || '#FF0000', 'fill-opacity': element.fillOpacity ?? 0.3 },
    });
  }
  if (!map.getLayer(strokeLayerId)) {
    map.addLayer({
      id: strokeLayerId, type: 'line', source: sourceId,
      paint: { 'line-color': element.strokeColor || '#FF0000', 'line-width': element.strokeWidth || 2 },
    });
  }
  (map.getSource(sourceId) as GeoJSONSource).setData(geojson);
  map.setPaintProperty(fillLayerId, 'fill-color', element.fillColor || '#FF0000');
  map.setPaintProperty(fillLayerId, 'fill-opacity', element.fillOpacity ?? 0.3);
  map.setPaintProperty(strokeLayerId, 'line-color', element.strokeColor || '#FF0000');
  map.setPaintProperty(strokeLayerId, 'line-width', element.strokeWidth || 2);
  map.setLayoutProperty(fillLayerId, 'visibility', 'visible');
  map.setLayoutProperty(strokeLayerId, 'visibility', 'visible');

  // 防御圈锯齿（环绕一圈，类似战线梳齿，但闭合）
  const haveDefend = !!element.defenseStyle;
  if (haveDefend) {
    const ds = element.defenseStyle!;
    // 「大小」= strokeWidth：作为整体缩放系数驱动边框与锯齿（与直线战线一致，默认 8px → 100% → 缩放 1）
    const sizeScale = (element.strokeWidth || 8) / 8;
    const toothLen = (ds.toothLength ?? 14) * sizeScale;
    const toothGap = (ds.toothGap ?? 24) * sizeScale;
    const side = ds.side ?? 1;
    const tilt = ((ds.toothAngle ?? 0) * Math.PI) / 180;
    const ring = coordinates[0];
    const teeth = buildToothedTeeth(map, ring, toothLen, toothGap, side, tilt);
    const fc = turf.featureCollection(teeth.map((l) => turf.lineString(l)));
    try {
      // 幂等：source 与 layer 分开检查，避免 addLayer 抛错后 source 在而 layer 缺失导致永远不显示
      if (!map.getSource(defendSrcId)) {
        map.addSource(defendSrcId, { type: 'geojson', data: fc } as any);
      }
      if (!map.getLayer(defendLayerId)) {
        map.addLayer({
          id: defendLayerId, type: 'line', source: defendSrcId,
          paint: { 'line-color': element.strokeColor || '#FF0000', 'line-width': Math.max(2, (element.strokeWidth || 8) * 0.6) },
          layout: { 'line-cap': 'round' },
        });
      }
      (map.getSource(defendSrcId) as GeoJSONSource).setData(fc);
      map.setPaintProperty(defendLayerId, 'line-color', element.strokeColor || '#FF0000');
      map.setPaintProperty(defendLayerId, 'line-width', Math.max(2, (element.strokeWidth || 8) * 0.6));
      map.setLayoutProperty(defendLayerId, 'visibility', 'visible');
    } catch { /* style 未就绪 */ }
    // 注册到相机重算表：地图平移/缩放/旋转时锯齿随环重新投影，避免锚定旧相机
    const jobs = defendJobsByMap.get(map) || defendJobsByMap.set(map, new Map()).get(map)!;
    jobs.set(element.id, { srcId: defendSrcId, layerId: defendLayerId, ring, toothLen, toothGap, side, tiltRad: tilt });
    ensureDefendRecompute(map);
  } else if (map.getLayer(defendLayerId)) {
    try { map.removeLayer(defendLayerId); } catch { /* */ }
    try { if (map.getSource(defendSrcId)) map.removeSource(defendSrcId); } catch { /* */ }
    clearDefendJob(map, element.id);
  }
}

/** 沿封闭环生成防御圈锯齿线段（屏幕像素级等距采样，法向偏移一圈） */
function buildToothedTeeth(
  map: maplibregl.Map, ring: [number, number][], toothLen: number, toothGap: number,
  side: 1 | -1, tiltRad: number,
): [number, number][][] {
  // 首尾相同 = 环已闭合，需遍历回到起点的最后一段；首尾不同 = 开放线只采样 n-1 段
  const closed = ring.length > 1 && Math.abs(ring[0][0] - ring[ring.length - 1][0]) < 1e-9 && Math.abs(ring[0][1] - ring[ring.length - 1][1]) < 1e-9;
  const proj = ring.map((c) => map.project(c));
  const lines: [number, number][][] = [];
  const n = proj.length;
  if (n < 2) return lines;
  // 环质心（屏幕像素）：用于判定"外侧"，保证 side=1 恒朝外、-1 恒朝内，
  // 不随绘制时的缠绕方向（顺时针/逆时针）而反转。
  let cx = 0, cy = 0;
  for (const p of proj) { cx += p.x; cy += p.y; }
  cx /= n; cy /= n;
  // 逐边采样（含闭合时回到起点的边）
  let acc = 0;
  let prev = proj[0] as any;
  for (let i = 1; i <= (closed ? n : n - 1); i++) {
    const cur = proj[i % n] as any;
    let seg = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    if (seg <= 0) continue;
    const ux = (cur.x - prev.x) / seg, uy = (cur.y - prev.y) / seg;
    const nx = -uy, ny = ux; // 法向（右=顺时针）
    const ang = Math.cos(tiltRad), sine = Math.sin(tiltRad);
    while (seg > 0 && acc + seg >= toothGap) {
      const t = (toothGap - acc) / seg;
      const bx = prev.x + (cur.x - prev.x) * t;
      const by = prev.y + (cur.y - prev.y) * t;
      // 以质心判向：默认法向若指向环内则取反，得到"朝外"单位法向
      let px = nx, py = ny;
      if ((bx - cx) * nx + (by - cy) * ny < 0) { px = -nx; py = -ny; }
      const dirX = px * side * ang - ux * side * sine;
      const dirY = py * side * ang - uy * side * sine;
      const ex = bx + dirX * toothLen;
      const ey = by + dirY * toothLen;
      const ll1 = map.unproject([bx, by]);
      const ll2 = map.unproject([ex, ey]);
      lines.push([[ll1.lng, ll1.lat], [ll2.lng, ll2.lat]]);
      seg -= (toothGap - acc);
      prev = { x: bx, y: by };
      acc = 0;
    }
    acc += seg;
    prev = cur;
  }
  return lines;
}

// ========== 渲染：疆域（国家/地块/兼并动画） ==========

/** 国界并集缓存：plots 数组引用 → 归属签名 → 边界要素 + 国名锚点（归属不变即命中） */
const terrCacheByPlots = new WeakMap<object, Map<string, { borderFC: any; anchors: { name: string; color: string; lng: number; lat: number }[] }>>();

function renderTerritory(map: maplibregl.Map, element: TerritoryElement, frame: number) {
  const { countries, plots, events } = element;
  const display = normalizeTerritoryDisplay(element.display);
  const srcId = `terr-${element.id}`;
  const fillId = `terr-layer-${element.id}`;        // 填充层（同时是点选命中层，-layer- 命名）
  const plineId = `terr-pline-${element.id}`;       // 地块边界
  const bSrcId = `terr-bsrc-${element.id}`;
  const borderId = `terr-border-${element.id}`;     // 国界
  const dSrcId = `terr-dsrc-${element.id}`;
  const drawId = `terr-draw-${element.id}`;         // 兼并描线
  const gSrcId = `terr-gsrc-${element.id}`;
  const glowFillId = `terr-gfill-${element.id}`;    // 高亮脉冲
  const glowLineId = `terr-gline-${element.id}`;
  const lSrcId = `terr-lsrc-${element.id}`;
  const labelId = `terr-label-${element.id}`;       // 名称标签

  const emptyFC = turf.featureCollection([] as any[]);

  // —— 每帧推导归属 / 颜色 / 特效进度 ——
  const fillFeatures: any[] = [];
  const drawFeatures: any[] = [];
  const glowFeatures: any[] = [];
  const borderOwner = new Map<string, string>();   // 已被吃尽的地块 → 国界/标签归属提前翻转（与吃尽同帧）
  for (const p of plots) {
    if (!p.rings?.[0] || p.rings[0].length < 4) continue;
    const color = plotColorAt(p, events, frame, countries, plots);
    const fx = plotFxAt(p, events, frame, countries);
    const props = { pid: p.id, tid: element.id, color, op: display.fillOpacity };
    // 扩散：把填充拆成 未覆盖(旧色) + 覆盖(新色) 两块 → 视觉与终态一致（无叠色/跳变），
    // 两块边界即推进前沿（随地块边界样式描出）
    let pushed = false;
    const sp = plotSpreadAt(p, events, frame, countries, plots);
    if (sp.active) {
      if (!sp.region) {
        // 已被完全覆盖 → 整块新色
        fillFeatures.push(turf.polygon(p.rings as [number, number][][], { ...props, color: sp.color }));
        borderOwner.set(p.id, ownerAt(p, events, frame));
        pushed = true;
      } else {
        let diffPolys: [number, number][][][] | null = null;
        try {
          const cutFc = turf.featureCollection([
            turf.polygon(p.rings as [number, number][][]),
            ...sp.region.map((rings) => turf.polygon(rings as [number, number][][])),
          ]);
          const diff = turf.difference(cutFc);
          const dg = (diff as unknown as { geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon } | null)?.geometry;
          if (dg) {
            diffPolys = dg.type === 'Polygon'
              ? [dg.coordinates as [number, number][][]]
              : (dg.coordinates as [number, number][][][]);
          }
        } catch (e) {
          console.warn('[territory] spread 切分失败，回退叠色:', e);
        }
        if (diffPolys) {
          for (const rings of diffPolys) fillFeatures.push(turf.polygon(rings as [number, number][][], props));
          for (const rings of sp.region) {
            fillFeatures.push(turf.polygon(rings as [number, number][][], { ...props, color: sp.color }));
          }
          pushed = true;
        }
      }
    }
    // 蚕食：与扩散同思路互斥两块——未吞并区=旧色，已吞并区=整块差集（占领方新色），
    // 前线带起伏单向推进（推过即自然消失）。切分失败时只画未吞并区旧色（绝不叠色）。
    if (!pushed) {
      const sh = plotShrinkAt(p, events, frame, countries, plots);
      if (sh.active) {
        if (!sh.region) {
          fillFeatures.push(turf.polygon(p.rings as [number, number][][], { ...props, color: sh.color }));
          borderOwner.set(p.id, ownerAt(p, events, frame));
        } else {
          let eatenPolys: [number, number][][][] | null = null;
          try {
            const cutFc = turf.featureCollection([
              turf.polygon(p.rings as [number, number][][]),
              ...sh.region.map((rings) => turf.polygon(rings as [number, number][][])),
            ]);
            const diff = turf.difference(cutFc);
            const dg = (diff as unknown as { geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon } | null)?.geometry;
            if (dg) {
              const polys = dg.type === 'Polygon'
                ? [dg.coordinates as [number, number][][]]
                : dg.type === 'MultiPolygon'
                  ? (dg.coordinates as [number, number][][][])
                  : [];
              if (polys.length) eatenPolys = polys;
            }
          } catch (e) {
            console.warn('[territory] shrink 切分失败，只画未吞并区:', e);
          }
          for (const rings of sh.region) {
            fillFeatures.push(turf.polygon(rings as [number, number][][], { ...props, color: sh.prevColor, op: display.fillOpacity * sh.fade }));
          }
          if (eatenPolys) {
            for (const rings of eatenPolys) {
              fillFeatures.push(turf.polygon(rings as [number, number][][], { ...props, color: sh.color }));
            }
          }
        }
        pushed = true;
      }
    }
    if (!pushed) fillFeatures.push(turf.polygon(p.rings as [number, number][][], props));
    if (fx.draw < 1) {
      const sliced = sliceRingClosed(p.rings[0], fx.draw);
      if (sliced.length >= 2) drawFeatures.push(turf.lineString(sliced, { color }));
    }
    if (fx.glow > 0.01) {
      glowFeatures.push(turf.polygon(p.rings as [number, number][][], { gop: fx.glow }));
    }
  }

  // —— 势力边界：同势力地块并集（缓存：plots 引用 + 归属签名）。
  // 归属 = borderOwner（已吃尽，与吃尽同帧切换）?? ownerVisualAt（动画未完成保持旧归属，
  // 完成才切换；避免兼并一开始整圈描边就变新色） ——
  const ownerForBorder = (p: typeof plots[number]) => borderOwner.get(p.id) ?? ownerVisualAt(p, events, frame);
  const ownSig = plots.map((p) => `${p.id}:${ownerForBorder(p)}`).join('|');
  let cache = terrCacheByPlots.get(plots);
  if (!cache) { cache = new Map(); terrCacheByPlots.set(plots, cache); }
  let cached = cache.get(ownSig);
  if (!cached) {
    const byCountry = new Map<string, [number, number][][][]>();
    for (const p of plots) {
      if (!p.rings?.[0] || p.rings[0].length < 4) continue;
      const ow = ownerForBorder(p);
      const arr = byCountry.get(ow) || [];
      arr.push(p.rings);
      byCountry.set(ow, arr);
    }
    const borderFCs: any[] = [];
    const anchors: { name: string; color: string; lng: number; lat: number }[] = [];
    for (const [cid, ringsList] of byCountry) {
      const c = countries.find((x) => x.id === cid);
      const u = unionCountryRings(ringsList);
      if (u) {
        const geom = u.geometry;
        const polys: [number, number][][][] = geom.type === 'Polygon' ? [geom.coordinates as [number, number][][]] : (geom.coordinates as [number, number][][][]);
        for (const rings of polys) borderFCs.push(turf.polygon(rings, { color: c?.color || '#888888' }));
        const ctr = centerOfFeature(u);
        if (ctr) anchors.push({ name: c?.name || '', color: c?.color || '#FFFFFF', lng: ctr[0], lat: ctr[1] });
      } else {
        // union 失败回退：逐地块外环描边
        for (const rings of ringsList) {
          borderFCs.push(turf.polygon([rings[0]], { color: c?.color || '#888888' }));
        }
      }
    }
    cached = { borderFC: turf.featureCollection(borderFCs), anchors };
    cache.set(ownSig, cached);
  }

  // —— 势力/地块名锚点（势力=大号白字+描边+势力色圆点；地块=小号+圆角底条）——
  const labelFeatures: any[] = [];
  const registerLabel = (text: string, size: number, extra?: Partial<TerritoryLabelStyle>) => {
    const st: TerritoryLabelStyle = { size, color: '#FFFFFF', halo: 'rgba(0,0,0,0.85)', haloWidth: 3, ...extra };
    const imgId = territoryLabelImageId(text, st);
    if (!map.hasImage(imgId)) {
      try { map.addImage(imgId, makeTerritoryLabelImageData(text, st), { pixelRatio: 1 }); } catch { /* style 未就绪 */ }
    }
    return imgId;
  };
  if (display.countryNames) {
    for (const a of cached.anchors) {
      if (!a.name) continue;
      const imgId = registerLabel(a.name, Math.round(15 * display.labelScale), { dotColor: a.color });
      labelFeatures.push(turf.point([a.lng, a.lat], { img: imgId, sc: 1 }));
    }
  }
  if (display.plotNames) {
    // 单地块势力：势力标签锚点（并集质心）与地块质心几乎重合，只显示势力名避免遮挡
    const plotCountByOwner = new Map<string, number>();
    if (display.countryNames) {
      for (const p of plots) {
        const ow = ownerForBorder(p);
        plotCountByOwner.set(ow, (plotCountByOwner.get(ow) || 0) + 1);
      }
    }
    for (const p of plots) {
      if (!p.rings?.[0] || p.rings[0].length < 4) continue;
      const c = countries.find((x) => x.id === (borderOwner.get(p.id) ?? ownerVisualAt(p, events, frame)));
      if (display.countryNames && c && (plotCountByOwner.get(c.id) || 0) === 1) continue;
      const ctr = centerOfFeature({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: p.rings } } as any);
      if (!ctr) continue;
      const imgId = registerLabel(p.name || c?.name || '', Math.round(11 * display.labelScale), {
        bg: 'rgba(12,10,9,0.55)', color: 'rgba(255,255,255,0.95)', halo: 'rgba(0,0,0,0.75)', haloWidth: 2,
      });
      labelFeatures.push(turf.point(ctr, { img: imgId, sc: 1 }));
    }
  }

  try {
    // 填充 + 地块边界（同源）
    if (!map.getSource(srcId)) {
      map.addSource(srcId, { type: 'geojson', data: turf.featureCollection(fillFeatures) } as any);
      map.addLayer({
        id: fillId, type: 'fill', source: srcId,
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'op'] },
      });
      map.addLayer({
        id: plineId, type: 'line', source: srcId,
        paint: { 'line-color': 'rgba(255,255,255,0.55)', 'line-width': 1, 'line-opacity': 0.6 },
      });
    }
    (map.getSource(srcId) as GeoJSONSource).setData(turf.featureCollection(fillFeatures));
    map.setLayoutProperty(plineId, 'visibility', display.plotBorders ? 'visible' : 'none');

    // 国界
    if (!map.getSource(bSrcId)) {
      map.addSource(bSrcId, { type: 'geojson', data: cached.borderFC } as any);
      map.addLayer({
        id: borderId, type: 'line', source: bSrcId,
        paint: { 'line-color': ['get', 'color'], 'line-width': display.borderWidth, 'line-opacity': 0.95 },
      });
    }
    (map.getSource(bSrcId) as GeoJSONSource).setData(cached.borderFC);
    map.setPaintProperty(borderId, 'line-width', display.borderWidth);
    map.setLayoutProperty(borderId, 'visibility', display.countryBorders ? 'visible' : 'none');

    // 兼并描线
    if (!map.getSource(dSrcId)) {
      map.addSource(dSrcId, { type: 'geojson', data: turf.featureCollection(drawFeatures) } as any);
      map.addLayer({
        id: drawId, type: 'line', source: dSrcId,
        paint: { 'line-color': ['get', 'color'], 'line-width': Math.max(2, display.borderWidth + 1), 'line-opacity': 0.95 },
        layout: { 'line-cap': 'round' },
      });
    }
    (map.getSource(dSrcId) as GeoJSONSource).setData(drawFeatures.length ? turf.featureCollection(drawFeatures) : emptyFC);
    map.setPaintProperty(drawId, 'line-width', Math.max(2, display.borderWidth + 1));
    map.setLayoutProperty(drawId, 'visibility', drawFeatures.length ? 'visible' : 'none');

    // 高亮脉冲（填充提亮 + 白闪描边）
    if (!map.getSource(gSrcId)) {
      map.addSource(gSrcId, { type: 'geojson', data: emptyFC } as any);
      map.addLayer({
        id: glowFillId, type: 'fill', source: gSrcId,
        paint: { 'fill-color': '#FFFFFF', 'fill-opacity': ['get', 'gop'] },
      });
      map.addLayer({
        id: glowLineId, type: 'line', source: gSrcId,
        paint: { 'line-color': '#FFFFFF', 'line-width': 4, 'line-opacity': ['get', 'gop'] },
      });
    }
    (map.getSource(gSrcId) as GeoJSONSource).setData(glowFeatures.length ? turf.featureCollection(glowFeatures) : emptyFC);
    map.setPaintProperty(glowLineId, 'line-width', 3 + display.borderWidth);
    map.setLayoutProperty(glowFillId, 'visibility', glowFeatures.length ? 'visible' : 'none');
    map.setLayoutProperty(glowLineId, 'visibility', glowFeatures.length ? 'visible' : 'none');

    // 名称标签
    if (!map.getSource(lSrcId)) {
      map.addSource(lSrcId, { type: 'geojson', data: turf.featureCollection(labelFeatures) } as any);
      map.addLayer({
        id: labelId, type: 'symbol', source: lSrcId,
        layout: {
          'icon-image': ['get', 'img'],
          'icon-size': ['get', 'sc'],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
          'icon-rotation-alignment': display.labelAlign === 'map' ? 'map' : 'viewport',
          'icon-pitch-alignment': display.labelAlign === 'map' ? 'map' : 'viewport',
        },
      });
    }
    (map.getSource(lSrcId) as GeoJSONSource).setData(turf.featureCollection(labelFeatures));
    map.setLayoutProperty(labelId, 'visibility', labelFeatures.length ? 'visible' : 'none');
    map.setLayoutProperty(labelId, 'icon-rotation-alignment', display.labelAlign === 'map' ? 'map' : 'viewport');
    map.setLayoutProperty(labelId, 'icon-pitch-alignment', display.labelAlign === 'map' ? 'map' : 'viewport');
  } catch { /* style 未就绪，下一帧重试 */ }
}

// ========== 渲染：军事箭头（燕尾） ==========

/**
 * 生成军标箭头多边形。
 * 局部坐标系：from 为原点，x 轴指向 to；y 为垂直方向。燕尾在尾部内凹。
 * 返回单环（旧式）或多个环（钳形/弯弓）。渲染层按需包成 MultiPolygon。
 */
export function buildArrowGeometry(
  from: [number, number],
  to: [number, number],
  width: number,
  arrowType: 'swallowtail' | 'simple' | 'block' | 'pincer' | 'curved' | 'curved-simple' | 'attack' | 'straight',
  path?: [number, number][]
): [number, number][][] {
  // 钳形：两条燕尾相对中心
  if (arrowType === 'pincer') {
    return buildPincerGeometry(from, to, width);
  }
  // 弯曲燕尾：沿贝塞尔曲线采样构造条带
  if (arrowType === 'curved' && path && path.length >= 2) {
    return buildCurvedSwallowtail(path, width);
  }
  // 弯曲普通行军箭头：无燕尾切口、平尾
  if (arrowType === 'curved-simple' && path && path.length >= 2) {
    return buildCurvedSwallowtailWithOpts(path, width, { simpleTail: true });
  }
  // 进攻箭头（AttackArrow）：用 plot_ol 标准算法，path 为控制点（<3 点时退化直线箭头）
  if (arrowType === 'attack' && path && path.length >= 2) {
    if (path.length < 3) {
      const a = path[0], b = path[path.length - 1];
      // 构造中间辅助点，使 buildAttackArrow 能生成完整箭头
      const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const out = buildAttackArrow([a, mid, b]);
      if (out.length >= 4) return [out as [number, number][]];
      return [buildStraightArrow([a, b]) as [number, number][]];
    }
    return [buildAttackArrow(path) as [number, number][]];
  }
  // 直线箭头（StraightArrow）：两点
  if (arrowType === 'straight') {
    return [buildStraightArrow([from, to]) as [number, number][]];
  }

  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const L = Math.hypot(dx, dy);
  if (L === 0) return [[from, to, from]];

  const ux = dx / L, uy = dy / L;
  const px = -uy, py = ux;
  const P = (a: number, b: number): [number, number] =>
    [from[0] + ux * a + px * b, from[1] + uy * a + py * b];

  const u = width;
  let hl = Math.min(u * 2.4, L * 0.42);
  const hw = u * 1.15;
  const sw = u * 0.42;
  let fl = Math.min(u * 1.7, L * 0.35);
  const fw = u * 1.05;
  const nd = u * 0.85;

  const shrink = Math.min(1, L / (u * 5));
  const HW = hw * shrink, SW = sw * shrink, FW = fw * shrink;

  if (arrowType === 'simple') {
    return [[
      P(L - hl, -HW), P(L, 0), P(L - hl, HW),
      P(L - hl, SW), P(0, SW), P(0, -SW), P(L - hl, -SW),
    ]];
  }
  if (arrowType === 'block') {
    return [[P(L - hl, -hw), P(L, 0), P(L - hl, hw)]];
  }
  // swallowtail
  return [[
    P(L, 0),
    P(L - hl, HW),
    P(L - hl, SW),
    P(-fl, FW),
    P(-fl + nd, 0),
    P(-fl, -FW),
    P(L - hl, -SW),
    P(L - hl, -HW),
  ]];
}

/** 钳形（pincer）：两条燕尾箭头从两侧向 `to`（目标）收敛。 */
function buildPincerGeometry(
  from: [number, number],
  to: [number, number],
  width: number
): [number, number][][] {
  // 来向：from→to；两条箭杆在来向两侧，尾部离 to 一定远处，尖端指向 to
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const L = Math.hypot(dx, dy) || 1;
  const px = -dy / L, py = dx / L;     // 垂直方向

  const u = width;
  const gap = Math.max(u * 0.5, L * 0.05);   // 两箭离中轴的间距
  const back = Math.min(u * 2.2, L * 0.25);  // 尾部落点相对 to 的轴向回退

  // 上/下箭杆的"尾基点"（从 to 横移 gap、纵移 back）
  const tipTo = [to[0], to[1]] as [number, number];
  const upBase: [number, number] = [
    to[0] - px * gap - (dx / L) * back,
    to[1] - py * gap - (dy / L) * back,
  ];
  const downBase: [number, number] = [
    to[0] + px * gap - (dx / L) * back,
    to[1] + py * gap - (dy / L) * back,
  ];

  const upArrow = swallowtail(upBase, tipTo, width);
  const downArrow = swallowtail(downBase, tipTo, width);
  return [upArrow, downArrow];
}

/** 从 base 指向 tip 的单条燕尾箭头（复用直线箭头的几何逻辑） */
function swallowtail(base: [number, number], tip: [number, number], width: number): [number, number][] {
  return buildArrowGeometry(base, tip, width, 'swallowtail')[0];
}

/**
 * 弯曲燕尾箭头：沿贝塞尔曲线采样生成左右条带 + 头部箭头 + 尾部燕尾。
 * coords 为控制点；先用 turf.bezierSpline 拟合，再等弧长采样。
 */
function buildCurvedSwallowtail(coords: [number, number][], width: number): [number, number][][] {
  return buildCurvedSwallowtailWithOpts(coords, width);
}

function buildCurvedSwallowtailWithOpts(
  coords: [number, number][],
  width: number,
  opts?: { simpleTail?: boolean }
): [number, number][][] {
  if (coords.length < 2) return [];
  const spline = turf.bezierSpline(turf.lineString(coords), { resolution: 6000, sharpness: 0.6 });
  const pts = spline.geometry.coordinates as [number, number][];
  if (pts.length < 2) return [];

  const u = width;
  const half = u * 0.5;            // 杆半宽
  const hw = u * 1.2;             // 头半宽
  const hl = u * 2.4;             // 头长（沿切向）
  const fl = u * 1.7;             // 燕尾长
  const fw = u * 1.1;             // 燕尾半宽
  const fn = u * 0.9;             // 燕尾内凹深度

  // 等弧长采样（含起点 0 与终点 1）
  const line = turf.lineString(pts);
  const total = turf.length(line);
  const segCount = 32;
  const samples: [number, number][] = [];
  for (let i = 0; i <= segCount; i++) {
    const d = (i / segCount) * total;
    const pt = turf.along(line, Math.min(d, total));
    samples.push(pt.geometry.coordinates as [number, number]);
  }

  // 切线：中间点用前后差分，端点用端点差分
  const tangent = (i: number): [number, number] => {
    const a = samples[Math.max(0, i - 1)];
    const b = samples[Math.min(samples.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  };
  const normal = (t: [number, number]): [number, number] => [-t[1], t[0]];

  // 左右杆沿曲线
  const leftEdge: [number, number][] = [];
  const rightEdge: [number, number][] = [];
  for (let i = 0; i < samples.length; i++) {
    const t = tangent(i);
    const n = normal(t);
    leftEdge.push([samples[i][0] + n[0] * half, samples[i][1] + n[1] * half]);
    rightEdge.push([samples[i][0] - n[0] * half, samples[i][1] - n[1] * half]);
  }

  // 尾部（起点）燕尾：沿起点切线反向 → 两条尾羽 + 内凹点
  const head = samples[samples.length - 1];
  const tHead = tangent(samples.length - 1);
  const nHead = normal(tHead);
  const headTip: [number, number] = [head[0] + tHead[0] * hl, head[1] + tHead[1] * hl];
  const headBL: [number, number] = [head[0] + nHead[0] * hw, head[1] + nHead[1] * hw];
  const headBR: [number, number] = [head[0] - nHead[0] * hw, head[1] - nHead[1] * hw];

  const tail = samples[0];
  const tTail = tangent(0);          // 起点切线（指向曲线前进方向）
  const nTail = normal(tTail);
  const tailOuterL: [number, number] = [tail[0] - tTail[0] * fl + nTail[0] * fw, tail[1] - tTail[1] * fl + nTail[1] * fw];
  const tailOuterR: [number, number] = [tail[0] - tTail[0] * fl - nTail[0] * fw, tail[1] - tTail[1] * fl - nTail[1] * fw];
  const tailNotch: [number, number] = [tail[0] - tTail[0] * fl + tTail[0] * fn, tail[1] - tTail[1] * fl + tTail[1] * fn];

  // 多边形：右侧杆（正向）→ 头尖 → 左侧杆（反向）→ 尾部（燕尾切口 或 平起点）
  const polygon: [number, number][] = opts?.simpleTail
    ? [
        rightEdge[0],
        ...rightEdge.slice(1),
        headBR,
        headTip,
        headBL,
        ...leftEdge.slice().reverse(),
      ]
    : [
        rightEdge[0],
        ...rightEdge.slice(1),
        headBR,
        headTip,
        headBL,
        ...leftEdge.slice().reverse(),
        tailOuterL,
        tailNotch,
        tailOuterR,
      ];

  return [polygon];
}

// ===== 飞行拱形（高度沿路线变化）公共工具 =====
// 剖面：flyHeight01(沿线弧长比例) —— 起点贴地 → 逐渐抬升 → 巡航 → 逐渐降落回贴地。
// mercator 与 globe 均由 fly-ribbon 自定义层（世界空间高程「加高程」）逐顶点完成；这里只提供
// 标记点/光点/头部图标与拱形一致的屏幕平移、箭头多边形 → 轨道比例环（subdivFlyRing）与旧 band 分段层的遗留清理。

/** 地面投影 + 世界空间高程(米)抬升 → 屏幕平移（viewport 锚）；与 ribbon 同一投影矩阵。
 *  heightM：弧顶高度（由路径总长决定，与相机无关），与所在路线的 ribbon 保持一致。 */
function liftTranslate(map: maplibregl.Map, lnglat: [number, number], lift01: number, heightM = flyLiftMeters(map)): [number, number] {
  const g = map.project(lnglat as any);
  const l = projectLifted(map, lnglat, Math.max(0, Math.min(1, lift01)) * heightM, lift01);
  return [l.x - g.x, l.y - g.y];
}

/** 累计弧长表（首项 0） */
function cumArcOf(coords: [number, number][]): number[] {
  const cum = new Array<number>(Math.max(0, coords.length));
  for (let i = 0; i < coords.length; i++) {
    cum[i] = i === 0 ? 0 : cum[i - 1] + Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
  }
  return cum;
}

/** 测地线（haversine）距离 km —— 标记点轨迹与 ribbon 高度共用同一弧长空间，避免漂移 */
function geoKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function geodesicCum(coords: [number, number][]): number[] {
  const c = new Array<number>(coords.length);
  c[0] = 0;
  for (let i = 1; i < coords.length; i++) c[i] = c[i - 1] + geoKm(coords[i - 1], coords[i]);
  return c;
}
/** 各点在全路线中的测地线绝对分数（0..~frac），与标记点 interpolatePath(turf.along) 同一空间 */
function geodesicFracAbs(coords: [number, number][], fullKm: number): number[] {
  const c = geodesicCum(coords);
  const f = new Array<number>(coords.length);
  for (let i = 0; i < coords.length; i++) f[i] = fullKm > 0 ? Math.max(0, Math.min(1, c[i] / fullKm)) : 0;
  return f;
}
function geoLengthKm(coords: [number, number][]): number {
  const c = geodesicCum(coords);
  return c[c.length - 1] || 0;
}
/** 轨道索引：粗化采样（≤80 点）+ 累计弧长 + 任意点 → 沿线比例 */
interface RailIndex {
  pts: [number, number][];
  cum: number[];
  total: number;
  fracOf(pt: [number, number]): number;
}

function buildRailIndex(rail: [number, number][]): RailIndex | null {
  let projRail = rail;
  if (rail && rail.length > 80) {
    const step = Math.ceil(rail.length / 80);
    const sampled: [number, number][] = [];
    for (let i = 0; i < rail.length; i += step) sampled.push(rail[i]);
    if (sampled[sampled.length - 1] !== rail[rail.length - 1]) sampled.push(rail[rail.length - 1]);
    projRail = sampled;
  }
  if (!projRail || projRail.length < 2) return null;
  const railCum = cumArcOf(projRail);
  const railTotal = railCum[railCum.length - 1];
  if (!(railTotal > 0)) return null;
  return {
    pts: projRail,
    cum: railCum,
    total: railTotal,
    fracOf(pt: [number, number]): number {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < projRail.length; i++) {
        const dx = pt[0] - projRail[i][0];
        const dy = pt[1] - projRail[i][1];
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = i; }
      }
      return railCum[best] / railTotal;
    },
  };
}

/** 环 → {coords,f}：逐点取轨道 frac，按 Δf 与边长细分（连续拱形，无分段台阶） */
function subdivFlyRing(ring: [number, number][], railIdx: RailIndex | null): { coords: [number, number][]; f: number[] } {
  const coords: [number, number][] = [];
  const fs: number[] = [];
  if (!ring || ring.length < 3) return { coords, f: fs };
  let perim = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    perim += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const maxLen = perim / 200;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const fa = railIdx ? railIdx.fracOf(a) : 0;
    const fb = railIdx ? railIdx.fracOf(b) : 0;
    const edgeLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let steps = Math.max(
      railIdx ? Math.ceil(Math.abs(fb - fa) / 0.03) : 1,
      maxLen > 0 ? Math.ceil(edgeLen / maxLen) : 1
    );
    steps = Math.max(1, Math.min(8, steps));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      coords.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      fs.push(fa + (fb - fa) * t);
    }
  }
  return { coords, f: fs };
}

/** 一次性清理旧「分段 band」遗留的 -f{i} 图层与 band 源（拱形已整体迁入 fly-ribbon 自定义层） */
const legacyFlyBandsCleaned = new WeakMap<maplibregl.Map, true>();
function cleanupLegacyFlyBands(map: maplibregl.Map): void {
  if (legacyFlyBandsCleaned.has(map)) return;
  legacyFlyBandsCleaned.set(map, true);
  try {
    const style = map.getStyle();
    for (const l of style.layers) {
      if (/-f\d+$/.test(l.id) && /^(arrow-|line-)/.test(l.id)) { try { map.removeLayer(l.id); } catch { /* */ } }
    }
    for (const sid of Object.keys(style.sources || {})) {
      if (/^arrow-bands-/.test(sid) || /^line-.*-fly$/.test(sid) || /^line-fill-fly-/.test(sid)) {
        try { map.removeSource(sid); } catch { /* */ }
      }
    }
  } catch { /* */ }
}
/** 箭头飞行/行进的弧长轨道（curved 燕尾先贝塞尔加密） */
function arrowRailOf(element: ArrowElement): [number, number][] {
  const basePts = element.path && element.path.length > 2 ? element.path : [element.from, element.to];
  if (element.arrowType === 'curved' || element.arrowType === 'curved-simple') {
    try {
      return turf.bezierSpline(turf.lineString(basePts as any), { resolution: 4000, sharpness: 0.6 }).geometry.coordinates as [number, number][];
    } catch { /* 采样失败退化为原路径 */ }
  }
  return basePts as [number, number][];
}

/** march 填充行进的剩余段：与箭身等宽的素条带（无燕尾/无头部，避免双燕尾） */
function ribbonRing(coords: [number, number][], widthDeg: number): [number, number][] | null {
  if (!coords || coords.length < 2 || !(widthDeg > 0)) return null;
  const half = widthDeg / 2;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < coords.length; i++) {
    const prev = coords[Math.max(0, i - 1)];
    const next = coords[Math.min(coords.length - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dy = next[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    left.push([coords[i][0] - dy * half, coords[i][1] + dx * half]);
    right.push([coords[i][0] + dy * half, coords[i][1] - dx * half]);
  }
  return [...left, ...right.reverse(), left[0]];
}

function renderArrow(map: maplibregl.Map, element: ArrowElement, frame: number) {
  const sourceId = `arrow-${element.id}`;
  const layerId = `arrow-layer-${element.id}`;
  const strokeLayerId = `arrow-stroke-layer-${element.id}`;

  const animStart = (element as any).moveStartFrame ?? element.startFrame;
  const animEnd = (element as any).moveEndFrame ?? element.endFrame;
  const animEff = (element as any).animEffect;
  const isGrowFill = animEff === 'grow' || animEff === 'fill';
  const isShapeArrow = element.shapeCategory === 'multi' || element.shapeCategory === 'special';
  const isMarchA = (animEff === 'march' || animEff === 'marchplain') && !isShapeArrow;
  const isFlyMode = !!element.flyMode && !isShapeArrow;
  const nonUniform = (element as any).uniformMove === false && (element as any).pointTimes && (element as any).pointTimes.length >= 2;
  const progress = isShapeArrow
    ? 1
    : isGrowFill || isMarchA
      ? (animEnd > animStart ? Math.max(0, Math.min(1, (frame - animStart) / (animEnd - animStart))) : 1)
      : getProgress(element.progress, frame);
  // 非均匀移动：箭头增长与标记同步
  const growProgress = nonUniform && isGrowFill
    ? nonUniformRatio(element as any, frame)
    : progress;
  let curTo: [number, number] = [
    element.from[0] + (element.to[0] - element.from[0]) * growProgress,
    element.from[1] + (element.to[1] - element.from[1]) * growProgress,
  ];
  let effFrom = element.from;
  let effTo = curTo;
  let animPathOverride: [number, number][] | null = null;

  // march 行进：定长箭头沿路径推进，走过段消失，剩余段半透明（不断变短）
  let marchHead: [number, number] | null = null;
  let marchBaseGeo: { path: [number, number][] } | null = null;
  if (isMarchA) {
    const rail = arrowRailOf(element);
    const railLine = turf.lineString(rail as any);
    const total = turf.length(railLine);
    if (total > 0) {
      const L = total * 0.35;
      const h = L + (total - L) * growProgress;
      const win = turf.lineSliceAlong(railLine, Math.max(0, h - L), h).geometry.coordinates as [number, number][];
      if (win.length >= 2) {
        effFrom = win[0];
        effTo = win[win.length - 1];
        animPathOverride = win;
      }
      marchHead = turf.along(railLine, h).geometry.coordinates as [number, number];
      const remain = turf.lineSliceAlong(railLine, h, total).geometry.coordinates as [number, number][];
      if (animEff === 'march' && remain.length >= 2) marchBaseGeo = { path: remain };
    }
  }

  // 固定地理宽度：用绘制时的 drawZoom 换算，箭头在地图中尺寸固定，随 zoom 缩放
  const lat = (effFrom[1] + effTo[1]) / 2;
  const geoWidth = typeof element.drawZoom === 'number'
    ? pixelsToDegrees(element.width, element.drawZoom, lat)
    : element.width / 111;

  // 增长动画：curved/curved-simple 用弧长截取贝塞尔（平滑增长，与标记点同步，避免分段）
  let animPath = animPathOverride ?? element.path;
  const growProg = growProgress;
  if (!isMarchA && animPathOverride === null && element.path && element.path.length > 2 && growProg < 1 && (element.arrowType === 'curved' || element.arrowType === 'curved-simple')) {
    try {
      const spline = turf.bezierSpline(turf.lineString(element.path), { resolution: 4000, sharpness: 0.6 });
      const line = turf.lineString(spline.geometry.coordinates);
      const total = turf.length(line);
      const sliced = turf.lineSliceAlong(line, 0, total * Math.max(0.002, growProg));
      animPath = sliced.geometry.coordinates as [number, number][];
    } catch {
      const n = Math.max(2, Math.ceil(element.path.length * Math.max(0.001, growProg)));
      animPath = element.path.slice(0, n);
    }
  } else if (!isMarchA && animPathOverride === null && element.path && element.path.length > 2 && growProg < 1 && element.arrowType === 'attack') {
    const n = Math.max(2, Math.ceil(element.path.length * Math.max(0.001, growProg)));
    animPath = element.path.slice(0, n);
  }

  const rings = buildArrowGeometry(effFrom, effTo, geoWidth, element.arrowType, animPath);
  // 转成 MultiPolygon：每个 ring 是一个 polygon；飞行模式下几何不变，由函数末尾统一 paint 平移实现悬停
  const polys = rings.map((ring) => turf.polygon([[...ring, ring[0]]]));
  const geojson = turf.featureCollection(polys);

  const fillColor = element.color || '#E23B3B';
  const fillOpacity = element.fillOpacity ?? 0.92;
  if (map.getSource(sourceId)) {
    (map.getSource(sourceId) as GeoJSONSource).setData(geojson);
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, 'visibility', 'visible');
      map.setPaintProperty(layerId, 'fill-color', fillColor);
      map.setPaintProperty(layerId, 'fill-opacity', fillOpacity);
    }
    if (map.getLayer(strokeLayerId)) map.setPaintProperty(strokeLayerId, 'line-color', fillColor);
  } else {
    map.addSource(sourceId, { type: 'geojson', data: geojson });
    map.addLayer({
      id: layerId, type: 'fill', source: sourceId,
      paint: { 'fill-color': fillColor, 'fill-opacity': fillOpacity },
    });
    map.addLayer({
      id: strokeLayerId, type: 'line', source: sourceId,
      paint: { 'line-color': fillColor, 'line-width': 1.2, 'line-opacity': 0.8 },
    });
  }

  // 填充效果：底层完整半透明箭头（animEff==='fill'）；march：剩余段半透明（不断变短）
  const fillSrcId = `arrow-fill-src-${element.id}`;
  const fillLayerId = `arrow-fill-layer-${element.id}`;
  if (animEff === 'fill' || isMarchA) {
    let fullGeojson: any;
    if (isMarchA) {
      // 剩余段：素条带（无燕尾无头部），仅填充行进(march)显示
      const ring = animEff === 'march' && marchBaseGeo ? ribbonRing(marchBaseGeo.path, geoWidth) : null;
      fullGeojson = turf.featureCollection(ring ? [turf.polygon([ring])] : []);
    } else {
      const fullPath = element.path;
      const fullRings = buildArrowGeometry(element.from, element.to, geoWidth, element.arrowType, fullPath);
      fullGeojson = turf.featureCollection(fullRings.map((ring) => turf.polygon([[...ring, ring[0]]])));
    }
    try {
      // 飞行模式：底部完整/剩余箭头不贴地显示（它们在拱上由 |afill 挤出块呈现），
      // 否则会形成"空中一段 + 地面一段"的双影
      const baseVis = (isFlyMode && rings.length > 0) ? 'none' : 'visible';
      if (map.getSource(fillSrcId)) {
        (map.getSource(fillSrcId) as GeoJSONSource).setData(fullGeojson);
        if (map.getLayer(fillLayerId)) {
          map.setLayoutProperty(fillLayerId, 'visibility', baseVis);
          map.setPaintProperty(fillLayerId, 'fill-color', fillColor);
        }
      } else {
        map.addSource(fillSrcId, { type: 'geojson', data: fullGeojson } as any);
        map.addLayer({
          id: fillLayerId, type: 'fill', source: fillSrcId,
          paint: { 'fill-color': fillColor, 'fill-opacity': 0.3 },
        });
      }
    } catch { /* style 未就绪 */ }
  } else if (map.getLayer(fillLayerId)) {
    try { map.removeLayer(fillLayerId); } catch { /* */ }
    try { if (map.getSource(fillSrcId)) map.removeSource(fillSrcId); } catch { /* */ }
  }

  // ===== 飞行拱形（箭头）：与路线同一 fly-ribbon（逐顶点平滑拱形，mercator/globe 通用）=====
  // 填充=三角化多边形、描边=闭合 ribbon；幽灵垫层(march 剩余/fill)保持贴地。
  cleanupLegacyFlyBands(map);
  const flyActiveA = isFlyMode && rings.length > 0;
  if (flyActiveA) {
    const rail = arrowRailOf(element);
    const railIdx = buildRailIndex(rail);
    // 飞行模式：箭头**始终用完整几何**，不随增长动画裁剪。原因：
    //   ① 头部位于路径末端，裁剪后头部缺失 → 箭头看不见（grow/move/fill 全中招）；
    //   ② 条带的弧长比例只到动画进度、头部固定在 f≈1（终点），高度剖面断裂 → 视觉两段。
    // 完整几何下条带与头部共享同一条 0→1 弧线剖面，自然连成一体。
    const flyRings = buildArrowGeometry(element.from, element.to, geoWidth, element.arrowType, element.path)
      .map((ring) => subdivFlyRing(ring, railIdx))
      .filter((r) => r.coords.length >= 3);
    if (flyRings.length > 0) {
      try { if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', 'none'); } catch { /* */ }
      try { if (map.getLayer(strokeLayerId)) map.setLayoutProperty(strokeLayerId, 'visibility', 'none'); } catch { /* */ }
      // 弧顶高度：由箭头路径总长决定，与相机无关；与填充/描边共用
      const flyHeightA = flyArcHeightMeters(geoLengthKm(rail) * 1000);
      setFlyRibbon(map, `${element.id}|afill`, {
        kind: 'poly',
        rings: flyRings,
        color: fillColor,
        opacity: fillOpacity,
        heightM: flyHeightA,
      });
      setFlyRibbon(map, `${element.id}|astroke`, {
        paths: flyRings.map((r) => ({ coords: r.coords, f: r.f, closed: true })),
        color: fillColor,
        widthPx: 1.2,
        opacity: 0.8,
        heightM: flyHeightA,
      });
    }
  } else {
    setFlyRibbon(map, `${element.id}|afill`, null);
    setFlyRibbon(map, `${element.id}|astroke`, null);
    try { if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', 'visible'); } catch { /* */ }
    try { if (map.getLayer(strokeLayerId)) map.setLayoutProperty(strokeLayerId, 'visibility', 'visible'); } catch { /* */ }
  }
  // fly 航迹已并入箭头本体（不再有独立虚线航迹层）；此处仅清理旧版本/同会话切换的残留层
  const flySrcId = `arrow-fly-src-${element.id}`;
  const flyLayerId = `arrow-fly-${element.id}`;
  if (map.getLayer(flyLayerId)) {
    try { map.removeLayer(flyLayerId); } catch { /* */ }
    try { if (map.getSource(flySrcId)) map.removeSource(flySrcId); } catch { /* */ }
  }

  // 移动图标（箭头路径上沿移动点）：三段式（动画前静态/动画中移动/动画后隐藏）
  const iconSrcId = `arrow-move-src-${element.id}`;
  const iconLayerId = `arrow-move-layer-${element.id}`;
  const inDisplay = frame >= element.startFrame && frame <= element.endFrame;
  const beforeAnim = inDisplay && animEff && frame < animStart;
  const duringAnim = inDisplay && animEff && frame >= animStart && frame <= animEnd;
  const afterAnim = inDisplay && animEff && frame > animEnd;
  // 图标位置比例（0..1）：非均匀按各路径点到达帧；grow/fill 用绘制进度；其余按动画窗口插值
  const iconRatio = (nonUniform && inDisplay)
    ? nonUniformRatio(element as any, frame)
    : beforeAnim ? 0
    : afterAnim ? 1
    : duringAnim ? (isGrowFill ? progress : (animEnd > animStart ? Math.max(0, Math.min(1, (frame - animStart) / (animEnd - animStart))) : 0))
    : 0;
  // 动画结束后标记停在终点，与箭头一起在显示结束消失；仅「显示标记」开启才渲染
  const needIcon = !!element.showIcon && (beforeAnim || duringAnim || afterAnim || inDisplay);
  if (needIcon) {
    const path = element.path && element.path.length >= 2 ? element.path : [element.from, element.to];
    const ratio = iconRatio;
    const iconCoord = (isMarchA && marchHead) ? marchHead : interpolatePath(path, Math.max(0, Math.min(1, ratio)));
    const iconData = turf.featureCollection([turf.point(iconCoord)]);
    const mi = (element as any).moveIcon;
    const mShape = mi?.shape || 'dot';
    const mColor = mi?.color || element.color || '#E23B3B';
    const mScale = mi?.scale ?? 1;
    const mLabelText = mi?.labelText ?? '';
    const mLabelColor = mi?.labelColor || '#000000';
    const mLabelBg = (mi?.labelBg || '#FFFFFF') !== 'transparent' && (mi?.labelBg || '#FFFFFF') !== 'rgba(0,0,0,0)' ? (mi?.labelBg || '#FFFFFF') : 'rgba(0,0,0,0)';
    const mEffShape = (mShape === 'bubble' || mShape === 'text') && !mLabelText ? 'dot' : mShape;
    const mVisKey = `${mi?.builtinId || ''}|${mi?.assetId || ''}|${mi?.iconLib || ''}:${mi?.iconName || ''}`;
    const mImgId = mEffShape === 'emoji'
      ? 'pt-emoji-' + Array.from(String(mi?.emoji || '📍')).map((c) => (c as string).codePointAt(0)!.toString(16)).join('-')
      : mEffShape === 'bubble'
        ? `pt-abub-${hashStr(mLabelText + mLabelBg + mLabelColor + mScale + (mi?.labelSize ?? 12) + (mi?.labelPadding ?? 8) + (mi?.labelRadius ?? 6))}`
        : mEffShape === 'text'
          ? `pt-atxt-${hashStr(mLabelText + mLabelColor + mScale + (mi?.labelSize ?? 13))}`
          : mEffShape === 'flag'
            ? `pt-aflag-${hashStr((mi?.flagText || '旗') + (mi?.flagColor || mColor) + mScale)}`
            : (mEffShape === 'image' || mEffShape === 'gif' || mEffShape === 'model' || mEffShape === 'icon' || mEffShape === 'military_symbol')
              ? `pt-mvis-${hashStr(mEffShape + mVisKey + mColor)}`
              : (mShape === 'pin' ? `pt-pin-${mColor.replace('#', '')}` : `pt-dot-${mColor.replace('#', '')}`);
    try {
      if (mEffShape === 'pin') ensureShapeImage(map, mImgId, getCached(`pin-${mColor}`, () => makePinImageData(mColor)));
      else if (mEffShape === 'emoji') ensureShapeImage(map, mImgId, getCached(mImgId, () => makeEmojiImageData(mi?.emoji || '📍')));
      else if (mEffShape === 'bubble') ensureShapeImage(map, mImgId, getCached(mImgId, () => makeBubbleImageData(mLabelText, mLabelBg, mLabelColor, (mi?.labelSize ?? 12) * mScale, mi?.labelRadius ?? 6, mi?.labelPadding ?? 8, false)));
      else if (mEffShape === 'text') ensureShapeImage(map, mImgId, getCached(mImgId, () => makeBubbleImageData(mLabelText, 'rgba(0,0,0,0)', mLabelColor, (mi?.labelSize ?? 13) * mScale, mi?.labelRadius ?? 3, mi?.labelPadding ?? 4, false)));
      else if (mEffShape === 'flag') ensureShapeImage(map, mImgId, getCached(mImgId, () => makeFlagImageData({ text: mi?.flagText || '旗', flagColor: mi?.flagColor || mColor, textColor: mi?.labelColor || '#FFFFFF', fontSize: Math.round(16 * mScale), flagWidth: Math.round(72 * mScale), scale: 1 }) || makeDotImageData(mColor)));
      else if (mEffShape === 'image' || mEffShape === 'gif' || mEffShape === 'model' || mEffShape === 'icon' || mEffShape === 'military_symbol') {
        // 资源形态：与标记/路线共用资源管线
        const vsrc = moveIconVisualSrc(mi);
        if (mEffShape === 'gif') {
          ensureGifFrame(map, { startFrame: element.startFrame }, mImgId, `gif:${vsrc.type === 'asset' ? vsrc.assetId : vsrc.type === 'builtin' ? vsrc.asset.id : element.id}`, vsrc, frame, mColor);
        } else if (mEffShape === 'model') {
          ensureModelImage(map, mImgId, vsrc, 0, mColor);
        } else {
          ensureVisualImage(map, mImgId, () => {
            if (vsrc.type === 'builtin') return vsrc.asset.src || null;
            if (vsrc.type === 'asset') return getAssetUrl(vsrc.assetId);
            if (vsrc.type === 'icon') return iconNameToDataUrl(vsrc.lib, vsrc.name, mColor);
            if (vsrc.type === 'legacy-url') return vsrc.url;
            return null;
          }, mColor);
        }
      }
      else ensureShapeImage(map, mImgId, getCached(`dot-${mColor}`, () => makeDotImageData(mColor)));
      if (map.getSource(iconSrcId)) {
        (map.getSource(iconSrcId) as GeoJSONSource).setData(iconData);
      } else {
        map.addSource(iconSrcId, { type: 'geojson', data: iconData } as any);
        map.addLayer({
          id: iconLayerId, type: 'symbol', source: iconSrcId,
          layout: { 'icon-image': mImgId, 'icon-size': mScale, 'icon-anchor': mEffShape === 'pin' ? 'bottom' : 'center', 'icon-offset': [0, 0] as any, 'icon-allow-overlap': true },
        });
      }
      if (map.getLayer(iconLayerId)) {
        const flat = mi?.orientation === 'flat';
        map.setLayoutProperty(iconLayerId, 'icon-image', mImgId);
        map.setLayoutProperty(iconLayerId, 'icon-size', mScale);
        map.setLayoutProperty(iconLayerId, 'icon-anchor', mEffShape === 'pin' ? 'bottom' : 'center');
        map.setLayoutProperty(iconLayerId, 'icon-offset', [0, 0] as any);
        map.setLayoutProperty(iconLayerId, 'icon-pitch-alignment', flat ? 'map' : 'viewport');
        map.setLayoutProperty(iconLayerId, 'icon-rotation-alignment', flat ? 'map' : 'viewport');
        map.setLayoutProperty(iconLayerId, 'icon-rotate', flat ? (mi?.rotation || 0) : 0);
        map.setLayoutProperty(iconLayerId, 'visibility', 'visible');
      }
      // 标记标签（showLabel 开启且非 bubble/text 形状时，在标记旁显示文字气泡）
      if (mi?.showLabel && mEffShape !== 'bubble' && mEffShape !== 'text' && mLabelText) {
        const lSrcId = `arrow-mlabel-src-${element.id}`;
        const lLayerId = `arrow-mlabel-${element.id}`;
        const lImgId = `pt-albl-${hashStr(mLabelText + mLabelColor + mLabelBg + mScale + (mi?.labelSize ?? 12))}`;
        ensureShapeImage(map, lImgId, getCached(lImgId, () => makeBubbleImageData(mLabelText, mLabelBg, mLabelColor, (mi?.labelSize ?? 12) * mScale, 3, 4, false)));
        // 标签偏移：优先连续偏移（中心锚 + 像素，offsetY 正值向上）；未设置时回退旧位置枚举
        const useLabelOff = typeof mi?.labelOffsetX === 'number' || typeof mi?.labelOffsetY === 'number';
        const off: [number, number] = useLabelOff
          ? [(mi?.labelOffsetX ?? 0) * mScale, -(mi?.labelOffsetY ?? 40) * mScale]
          : ((mi?.labelPos || 'top') === 'top' ? [0, -28] : (mi?.labelPos || 'top') === 'left' ? [-40, 0] : (mi?.labelPos || 'top') === 'right' ? [40, 0] : [0, 26]);
        try {
          if (map.getSource(lSrcId)) {
            (map.getSource(lSrcId) as GeoJSONSource).setData(iconData);
          } else {
            map.addSource(lSrcId, { type: 'geojson', data: iconData } as any);
            map.addLayer({
              id: lLayerId, type: 'symbol', source: lSrcId,
              layout: { 'icon-image': lImgId, 'icon-size': 1, 'icon-offset': off, 'icon-allow-overlap': true },
            });
          }
          if (map.getLayer(lLayerId)) {
            map.setLayoutProperty(lLayerId, 'icon-image', lImgId);
            map.setLayoutProperty(lLayerId, 'icon-offset', off);
            map.setLayoutProperty(lLayerId, 'visibility', 'visible');
          }
        } catch { /* */ }
      } else if (map.getLayer('arrow-mlabel-' + element.id)) {
        try { map.removeLayer('arrow-mlabel-' + element.id); } catch { /* */ }
        try { if (map.getSource('arrow-mlabel-src-' + element.id)) map.removeSource('arrow-mlabel-src-' + element.id); } catch { /* */ }
      }
      // 飞行模式：箭头标记点改由 fly-ribbon 自定义层绘制（与拱形同一投影，精确对齐）
      if (flyActiveA) {
        try { if (map.getLayer(iconLayerId)) map.setLayoutProperty(iconLayerId, 'visibility', 'none'); } catch { /* */ }
        try { if (map.getLayer(`arrow-mlabel-${element.id}`)) map.setLayoutProperty(`arrow-mlabel-${element.id}`, 'visibility', 'none'); } catch { /* */ }
        const imgH = (map.getImage(mImgId) as any)?.data?.height || 32;
        setFlyMarker(map, `${element.id}|icon`, [{
          imgId: mImgId, lnglat: iconCoord,
          lift01: flyHeight01(Math.max(0, Math.min(1, iconRatio))),
          sizePx: imgH * mScale,
          anchorX: 0.5, anchorY: mEffShape === 'pin' ? 1 : 0.5,
        }]);
      } else {
        setFlyMarker(map, `${element.id}|icon`, null);
      }
    } catch { /* style 未就绪 */ }
  } else if (map.getLayer(iconLayerId)) {
    try { map.removeLayer(iconLayerId); } catch { /* */ }
    try { if (map.getSource(iconSrcId)) map.removeSource(iconSrcId); } catch { /* */ }
    setFlyMarker(map, `${element.id}|icon`, null);
  }

  // 飞行拱形：移动图标/标签按「沿线位置」取高度；基础填充/描边由分段层替代（已隐藏，平移归零）；
  // 幽灵垫层（fill/march 剩余）保持贴地。
  const zeroShiftA: [number, number] = [0, 0];
  const arrowPathL = element.path && element.path.length >= 2 ? element.path : [element.from, element.to];
  const iconLnglatA: [number, number] = (isMarchA && marchHead) ? marchHead : interpolatePath(arrowPathL, Math.max(0, Math.min(1, iconRatio)));
  const flyIconShiftA: [number, number] = flyActiveA
    ? liftTranslate(map, iconLnglatA, flyHeight01(Math.max(0, Math.min(1, iconRatio))))
    : zeroShiftA;
  for (const [flyLayer, flyProp, shift] of [
    [layerId, 'fill-translate', zeroShiftA],
    [strokeLayerId, 'line-translate', zeroShiftA],
    [fillLayerId, 'fill-translate', zeroShiftA],
    [iconLayerId, 'icon-translate', flyIconShiftA],
    [`arrow-mlabel-${element.id}`, 'icon-translate', flyIconShiftA],
  ] as [string, string, [number, number]][]) {
    if (!map.getLayer(flyLayer)) continue;
    try {
      map.setPaintProperty(flyLayer, flyProp, shift as any);
      map.setPaintProperty(flyLayer, `${flyProp}-anchor`, 'viewport');
    } catch { /* 层未创建或样式未就绪 */ }
  }
}

// ========== 渲染：双箭头（钳形攻势） ==========

function renderDoubleArrow(map: maplibregl.Map, element: DoubleArrowElement, frame: number) {
  const sourceId = `darrow-${element.id}`;
  const layerId = `darrow-layer-${element.id}`;
  const strokeLayerId = `darrow-stroke-layer-${element.id}`;

  if (element.points.length < 4) return;

  const progress = getProgress(element.progress, frame);
  // 用完整控制点生成
  const ring = buildDoubleArrow(element.points.map((p) => p as number[]));
  if (ring.length < 3) return;
  if (progress < 1) {
    // 渐进绘制：按点比例截断
    const sliced = ring.slice(0, Math.max(3, Math.ceil(ring.length * progress)));
    const geojsonN = turf.featureCollection([turf.polygon([[...sliced, sliced[0]]])]);
    (map.getSource(sourceId) as GeoJSONSource)?.setData(geojsonN);
    return;
  }
  const geojson = turf.featureCollection([turf.polygon([[...ring, ring[0]]])]);

  if (map.getSource(sourceId)) {
    (map.getSource(sourceId) as GeoJSONSource).setData(geojson);
  } else {
    map.addSource(sourceId, { type: 'geojson', data: geojson });
    map.addLayer({
      id: layerId, type: 'fill', source: sourceId,
      paint: { 'fill-color': element.color || '#E23B3B', 'fill-opacity': 0.92 },
    });
    map.addLayer({
      id: strokeLayerId, type: 'line', source: sourceId,
      paint: { 'line-color': '#7A1010', 'line-width': 1.2, 'line-opacity': 0.8 },
    });
  }
}

// ========== 渲染：包围圈 ==========

function circleRing(center: [number, number], radiusKm: number, segments = 72): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const dx = (radiusKm / 111) * Math.cos(a);
    const dy = (radiusKm / 111) * Math.sin(a);
    pts.push([center[0] + dx, center[1] + dy]);
  }
  return pts;
}

/** 五角星外轮廓（outer=radiusKm, inner=0.4×，绕中心可旋 rotation 度；闭合环） */
function starRing(center: [number, number], radiusKm: number, rotationDeg = 0): [number, number][] {
  const outer = radiusKm / 111;
  const inner = outer * 0.4;
  const rot = ((rotationDeg || 0) * Math.PI) / 180;
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2 + rot;
    pts.push([center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)]);
  }
  pts.push([pts[0][0], pts[0][1]]);
  return pts;
}

/** 矩形环（对角点） */
function rectRingCoords(c1: [number, number], c2: [number, number]): [number, number][] {
  return [[c1[0], c1[1]], [c2[0], c1[1]], [c2[0], c2[1]], [c1[0], c2[1]], [c1[0], c1[1]]];
}

/** 绕 center 旋转 ring（平面等角近似，度） */
function rotateRing(ring: [number, number][], center: [number, number], deg: number): [number, number][] {
  if (!deg) return ring;
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  return ring.map((p) => {
    const dx = p[0] - center[0];
    const dy = p[1] - center[1];
    return [center[0] + dx * cos - dy * sin, center[1] + dx * sin + dy * cos];
  });
}

/** 由 shapeKind/meta 编译 polygon 坐标（编辑器与导出端一致） */
function compileShapeCoordinates(element: PolygonElement): [number, number][][] {
  if (element.shapeKind === 'rect' && element.rectMeta) {
    const ring = rectRingCoords(element.rectMeta.c1, element.rectMeta.c2);
    const cx = (element.rectMeta.c1[0] + element.rectMeta.c2[0]) / 2;
    const cy = (element.rectMeta.c1[1] + element.rectMeta.c2[1]) / 2;
    return [rotateRing(ring, [cx, cy], element.rotation || 0)];
  }
  if (element.shapeKind === 'circle' && element.circleMeta) {
    return [circleRing(element.circleMeta.center, element.circleMeta.radius)];
  }
  if (element.shapeKind === 'star' && element.starMeta) {
    return [starRing(element.starMeta.center, element.starMeta.radius, element.rotation || 0)];
  }
  // 曲线多边：对闭合环做贝塞尔拟合（边曲线化）
  if (element.polyCurve) {
    const rings = element.coordinates.map((ring) => smoothClosedRing(ring));
    return rings.length ? rings : element.coordinates;
  }
  return element.coordinates;
}

/** 闭合环曲线化：对闭环贝塞尔拟合后统一采样（首尾保持同点） */
function smoothClosedRing(ring: [number, number][]): [number, number][] {
  if (!ring || ring.length < 3) return ring;
  // 保证闭环：若首尾不一致则补尾
  let pts = ring;
  if (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1]) {
    pts = [...pts, pts[0]];
  }
  try {
    const spline = turf.bezierSpline(turf.lineString(pts), { resolution: 4000, sharpness: 0.6 });
    const cs = spline.geometry.coordinates as [number, number][];
    return cs.length >= 3 ? cs : ring;
  } catch {
    return ring;
  }
}

/** 点绕 center 旋转 deg 度（平面近似） */
export function rotatePt(p: [number, number], center: [number, number], deg: number): [number, number] {
  if (!deg) return p;
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  const dx = p[0] - center[0];
  const dy = p[1] - center[1];
  return [center[0] + dx * cos - dy * sin, center[1] + dx * sin + dy * cos];
}

function renderEncirclement(map: maplibregl.Map, element: EncirclementElement, _frame: number) {
  const sourceId = `encirclement-${element.id}`;
  const fillLayerId = `encirclement-fill-layer-${element.id}`;
  const layerId = `encirclement-layer-${element.id}`;

  const ring = circleRing(element.center, element.radius);
  const geojson = turf.featureCollection([turf.polygon([[...ring, ring[0]]])]);

  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, { type: 'geojson', data: geojson });
    map.addLayer({
      id: fillLayerId, type: 'fill', source: sourceId,
      paint: { 'fill-color': element.strokeColor || '#D33030', 'fill-opacity': 0.08 },
    });
    map.addLayer({
      id: layerId, type: 'line', source: sourceId,
      paint: { 'line-color': element.strokeColor || '#D33030', 'line-width': 3.5, 'line-dasharray': [4, 2.5] },
    });
  } else {
    (map.getSource(sourceId) as GeoJSONSource).setData(geojson);
  }
}

// ========== 渲染：集结点 ==========

function renderGathering(map: maplibregl.Map, element: GatheringElement, frame: number) {
  const sourceId = `gathering-${element.id}`;
  const layerId = `gathering-layer-${element.id}`;
  const strokeLayerId = `gathering-stroke-layer-${element.id}`;

  // 用 plot_ol GatheringPlace 算法：以 center 为基、radius 为尺寸生成平滑曲边集结地
  const c = element.center;
  const rDeg = element.radius / 111;
  let scaleR = rDeg;
  if (element.pulseAnimation) {
    const phase = (frame % 50) / 50;
    scaleR = rDeg * (0.96 + 0.06 * Math.sin(phase * Math.PI * 2));
  }

  // 三个控制点：左、上、右，构成集结地的骨架
  const p0: [number, number] = [c[0] - scaleR * 1.1, c[1]];
  const p1: [number, number] = [c[0], c[1] + scaleR * 1.5];
  const p2: [number, number] = [c[0] + scaleR * 1.1, c[1]];
  let ring = buildGatheringPlace([p0, p1, p2] as any) as [number, number][];
  if (element.rotation) {
    ring = rotateRing(ring, c, element.rotation);
  }
  const closed: [number, number][] = ring.length > 0 ? [...ring, ring[0]] : [];

  const geojson = turf.featureCollection([
    turf.polygon([closed], { part: 'gather' }),
  ]);

  if (map.getSource(sourceId)) {
    (map.getSource(sourceId) as GeoJSONSource).setData(geojson);
    if (map.getLayer(layerId)) {
      map.setPaintProperty(layerId, 'line-color', element.color || '#FF6600');
    }
  } else {
    map.addSource(sourceId, { type: 'geojson', data: geojson });
    map.addLayer({
      id: layerId, type: 'fill', source: sourceId,
      paint: { 'fill-color': element.color || '#FF6600', 'fill-opacity': 0.15 },
    });
    map.addLayer({
      id: strokeLayerId, type: 'line', source: sourceId,
      paint: { 'line-color': element.color || '#FF6600', 'line-width': 3, 'line-dasharray': [8, 3], 'line-opacity': 0.9 },
    });
  }
}

// ========== 渲染：军事符号（已并入标记 shape 管线） ==========
//
// military_symbol 现在是 PointShape 的一种资源形态（与图片/图标一致）：
// 符号图由 builtin-assets 的 getBuiltinAsset('milsym:<SIDC>') 调用 milsymbol
// 按官方规范生成，走通用位图管线（renderPoint），属性（大小/朝向/颜色/标签）
// 与图片形态完全一致。旧的独立元素渲染（renderMilitarySymbol）已移除。

// ========== 渲染：连线 ==========

// 依赖注入：connector 坐标解析
let connectorCoordResolver: ((element: ConnectorElement) => [number, number][] | null) | null = null;
export function setConnectorCoordResolver(resolver: ((element: ConnectorElement) => [number, number][] | null) | null): void {
  connectorCoordResolver = resolver;
}

function renderConnector(map: maplibregl.Map, element: ConnectorElement) {
  const coords = connectorCoordResolver?.(element);
  const sourceId = `connector-${element.id}`;
  const layerId = `connector-layer-${element.id}`;
  if (!coords) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
    return;
  }

  const geojson = turf.featureCollection([turf.lineString(coords)]);
  if (map.getSource(sourceId)) {
    (map.getSource(sourceId) as GeoJSONSource).setData(geojson);
  } else {
    map.addSource(sourceId, { type: 'geojson', data: geojson });
    map.addLayer({
      id: layerId, type: 'line', source: sourceId,
      paint: {
        'line-color': element.lineColor || '#FF8800',
        'line-width': element.lineWidth || 2,
        ...(element.animated ? { 'line-dasharray': [4, 4] } : {}),
      },
    });
  }

  if (element.arrowhead && !map.getLayer(`connector-arrow-layer-${element.id}`)) {
    const arrowSrc = `connector-arrow-${element.id}`;
    map.addSource(arrowSrc, { type: 'geojson', data: turf.featureCollection([turf.point(coords[coords.length - 1])]) });
    map.addLayer({
      id: `connector-arrow-layer-${element.id}`, type: 'symbol', source: arrowSrc,
      layout: { 'text-field': '▶', 'text-size': 11, 'text-rotate': 90 },
      paint: { 'text-color': element.lineColor || '#FF8800' },
    });
  }
}

// ========== 图片图标缓存（供「移动图标」image 样式复用） ==========

const customIconPending = new Set<string>();

function ensureImageIcon(map: maplibregl.Map, imageId: string, url: string, _size: number, color?: string) {
  if (map.hasImage(imageId) || customIconPending.has(imageId)) return;
  customIconPending.add(imageId);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    customIconPending.delete(imageId);
    if (map.hasImage(imageId)) return;
    try {
      const scale = 64 / Math.max(img.width, img.height);
      const w = Math.max(2, Math.round(img.width * scale));
      const h = Math.max(2, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);
      // 图标着色：乘法混合（白色=原图，选色后白色区域染色、深色细节保留）
      const tint = (color || '#FFFFFF').toUpperCase();
      if (tint !== '#FFFFFF') {
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = tint;
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(img, 0, 0, w, h); // 恢复原 alpha
      }
      const data = ctx.getImageData(0, 0, w, h);
      map.addImage(imageId, data, { pixelRatio: 1 });
      notifyVisualReady(map);
    } catch { /* 跨域等失败 */ }
  };
  img.onerror = () => customIconPending.delete(imageId);
  img.src = url;
}

/** 计算线的中点坐标 */
function getLineMidpoint(coords: [number, number][]): [number, number] {
  if (coords.length === 0) return [0, 0];
  if (coords.length === 1) return coords[0];
  const line = turf.lineString(coords);
  const len = turf.length(line);
  const mid = turf.along(line, len / 2);
  return mid.geometry.coordinates as [number, number];
}

// ========== 渲染：旗帜（canvas 动态生成） ==========

const flagIconCache = new Map<string, boolean>();

interface FlagStyle {
  text: string;
  flagColor: string;
  textColor: string;
  fontSize: number;
  flagWidth: number;
  scale: number;
}

function flagIconId(s: FlagStyle): string {
  return `flag-${s.flagWidth}-${s.fontSize}-${hashStr(s.text)}-${s.flagColor.replace('#', '')}-${s.textColor.replace('#', '')}`;
}

function hashStr(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

function makeFlagImageData(s: FlagStyle): ImageData | null {
  const dpr = 2;
  const fw = s.flagWidth;
  const fh = Math.max(18, Math.round(fw * 0.62));
  const poleW = 3 * dpr;
  const padT = 4 * dpr;
  const poleH = fh + 10 * dpr;
  const cw = Math.ceil((fw + poleW + 10 * dpr));
  const chh = Math.ceil(poleH + padT + 4 * dpr);

  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = chh;
  const ctx = canvas.getContext('2d')!;

  // 旗杆
  ctx.fillStyle = '#4A4A4A';
  ctx.fillRect(padT, padT, poleW, poleH);

  // 旗面（右侧微切角增加动感）
  const fx = padT + poleW;
  const fy = padT;
  ctx.fillStyle = s.flagColor;
  ctx.beginPath();
  ctx.moveTo(fx, fy);
  ctx.lineTo(fx + fw, fy);
  ctx.lineTo(fx + fw - 4 * dpr, fy + fh / 2);
  ctx.lineTo(fx + fw, fy + fh);
  ctx.lineTo(fx, fy + fh);
  ctx.closePath();
  ctx.fill();

  // 描边
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1 * dpr;
  ctx.stroke();

  // 文字
  if (s.text) {
    let fs = s.fontSize * (s.scale || 1) * dpr;
    ctx.font = `bold ${fs}px "Microsoft YaHei", sans-serif`;
    const maxW = (fw - 8 * dpr);
    while (fs > 8 * dpr && ctx.measureText(s.text).width > maxW) {
      fs -= 1 * dpr;
      ctx.font = `bold ${fs}px "Microsoft YaHei", sans-serif`;
    }
    ctx.fillStyle = s.textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 2 * dpr;
    const tx = fx + fw / 2;
    const ty = fy + fh / 2;
    ctx.fillText(s.text, tx, ty);
    ctx.shadowBlur = 0;
  }

  return ctx.getImageData(0, 0, cw, chh);
}

function renderFlag(map: maplibregl.Map, element: FlagElement) {
  const sourceId = `flag-${element.id}`;
  const scale = element.scale ?? 1;
  const style: FlagStyle = {
    text: element.text || '',
    flagColor: element.flagColor || '#E23B3B',
    textColor: element.textColor || '#FFFFFF',
    fontSize: element.fontSize || 28,
    flagWidth: Math.max(36, Math.round((element.flagWidth || 72) * scale)),
    scale,
  };
  const imageId = flagIconId(style);
  const layerId = `flag-layer-${element.id}`;

  const geojson = turf.featureCollection([
    turf.point(element.coordinates, { name: element.text || element.name }),
  ]);

  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, { type: 'geojson', data: geojson });
    map.addLayer({
      id: layerId, type: 'symbol', source: sourceId,
      layout: {
        'icon-image': imageId,
        'icon-size': 0.5,
        'icon-anchor': 'center',
        'icon-allow-overlap': true,
      },
    });
  } else {
    (map.getSource(sourceId) as GeoJSONSource).setData(geojson);
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, 'icon-image', imageId);
    }
  }

  if (!map.hasImage(imageId) && !flagIconCache.has(imageId)) {
    flagIconCache.set(imageId, true);
    const data = makeFlagImageData(style);
    if (data) {
      try {
        map.addImage(imageId, data, { pixelRatio: 2 });
        map.triggerRepaint();
      } catch { /* */ }
    }
  }
}

// ========== 选中高亮几何构建（供 EditableMap 使用） ==========

export function buildSelectionFeature(element: MapElement): any | null {
  switch (element.type) {
    case 'point':
    case 'flag':
      return turf.point((element as any).coordinates);
    case 'moving_point':
      return turf.lineString(element.path);
    case 'line':
      return turf.lineString(lineEffectiveCoordinates(element));
    case 'polygon':
      return turf.polygon(compileShapeCoordinates(element));
    case 'encirclement':
      return turf.polygon([[...circleRing(element.center, element.radius), circleRing(element.center, element.radius)[0]]]);
    case 'gathering': {
      const c = element.center;
      const rDeg = element.radius / 111;
      const p0: [number, number] = [c[0] - rDeg * 1.1, c[1]];
      const p1: [number, number] = [c[0], c[1] + rDeg * 1.5];
      const p2: [number, number] = [c[0] + rDeg * 1.1, c[1]];
      const ring = buildGatheringPlace([p0, p1, p2] as any) as [number, number][];
      const closed: [number, number][] = ring.length > 0 ? [...ring, ring[0]] : [];
      return turf.polygon([closed]);
    }
    case 'arrow': {
      const lat = (element.from[1] + element.to[1]) / 2;
      const w = typeof element.drawZoom === 'number'
        ? pixelsToDegrees(element.width, element.drawZoom, lat)
        : element.width / 111;
      return turf.feature({
        type: 'MultiPolygon',
        coordinates: buildArrowGeometry(element.from, element.to, w, element.arrowType, element.path)
          .map((r) => [[...r, r[0]]]),
      } as any);
    }
    case 'double_arrow':
      return turf.feature({
        type: 'Polygon',
        coordinates: [[...buildDoubleArrow(element.points as any), buildDoubleArrow(element.points as any)[0]]],
      } as any);
    default:
      return null;
  }
}

/** 跟随视角解析：center=路线动画进度点，bearing=切线方向（followDirection 开启时） */
export function resolveFollowCam(elements: MapElement[], kf: CameraKeyframe, frame: number): { center: [number, number]; zoom: number; pitch: number; bearing: number } | null {
  if (!kf.followRoute) return null;
  const route = elements.find((e) => e.id === kf.followRoute!.routeElementId);
  if (!route) return null;
  let path: [number, number][] | undefined;
  if (route.type === 'line') path = lineEffectiveCoordinates(route);
  else if (route.type === 'moving_point') path = route.path;
  else if (route.type === 'arrow') path = route.path && route.path.length >= 2 ? route.path : [route.from, route.to];
  if (!path || path.length < 2) return null;
  const le = route as any;
  let ratio = 0;
  // 跟随动画区间：跟随视角的 startFrame/endFrame 优先（默认路线显示起止）
  const fStart = kf.followRoute!.startFrame ?? le.startFrame;
  const fEnd = kf.followRoute!.endFrame ?? le.endFrame;
  if (le.uniformMove === false && le.pointTimes && le.pointTimes.length >= 2) {
    ratio = nonUniformRatio(route, frame);
  } else {
    ratio = fEnd > fStart ? Math.max(0, Math.min(1, (frame - fStart) / (fEnd - fStart))) : 0;
  }
  ratio = Math.max(0, Math.min(1, ratio));
  const coord = interpolatePath(path, ratio);
  let bearing = kf.bearing || 0;
  if (kf.followRoute.followDirection !== false) {
    const segIdx = Math.max(0, Math.min(path.length - 2, Math.floor(ratio * (path.length - 1))));
    const a = path[segIdx];
    const b = path[Math.min(path.length - 1, segIdx + 1)];
    const rad = Math.atan2(b[0] - a[0], b[1] - a[1]);
    bearing = (rad * 180) / Math.PI;
    if (bearing < 0) bearing += 360;
  }
  return { center: [coord[0], coord[1]], zoom: kf.zoom, pitch: kf.pitch || 0, bearing };
}

/** 环绕视角解析：相机绕 center 旋转（bearing 随时间按速度递增），center/zoom/pitch 保持 */
export function resolveOrbitCam(kf: CameraKeyframe, frame: number, fps: number): { center: [number, number]; zoom: number; pitch: number; bearing: number } | null {
  if (!kf.orbit) return null;
  const speed = kf.orbit.speed ?? 45;            // 度/秒
  const duration = kf.orbit.duration ?? 2;         // 秒
  const startFrame = kf.frame;
  const elapsed = (frame - startFrame) / fps;      // 秒
  // 在环绕时长内持续旋转；之后保持最终角度
  const t = Math.max(0, Math.min(duration, elapsed));
  const bearing = ((kf.bearing || 0) + speed * t) % 360;
  return { center: kf.center, zoom: kf.zoom, pitch: kf.pitch || 0, bearing };
}

// ========== 辅助 ==========

function interpolateMorph(
  morphKeyframes: { frame: number; coordinates: [number, number][][] }[],
  frame: number
): [number, number][][] {
  if (morphKeyframes.length === 0) return [];
  if (morphKeyframes.length === 1) return morphKeyframes[0].coordinates;

  let prev = morphKeyframes[0];
  let next = morphKeyframes[morphKeyframes.length - 1];

  for (let i = 0; i < morphKeyframes.length - 1; i++) {
    if (frame >= morphKeyframes[i].frame && frame <= morphKeyframes[i + 1].frame) {
      prev = morphKeyframes[i];
      next = morphKeyframes[i + 1];
      break;
    }
  }

  const range = next.frame - prev.frame;
  const t = range === 0 ? 0 : (frame - prev.frame) / range;

  return prev.coordinates.map((ring, i) =>
    ring.map((coord, j) => {
      const nc = next.coordinates[i]?.[j] || coord;
      return [coord[0] + (nc[0] - coord[0]) * t, coord[1] + (nc[1] - coord[1]) * t] as [number, number];
    })
  );
}
