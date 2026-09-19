import { create } from 'zustand';
import { storage } from '../lib/storage';
import type {
  MapVideoProject, MapElement, GlobalConfig, BaseMapConfig,
  ElevationMapConfig, OverlayItem, CameraKeyframe,
  ProjectExport, ScreenFxItem, ExportedAsset,
  NarrationEntry, NarrationStyle, MusicTrack,
  GeneratedChapterPlan, Layer, LayerType,
} from '../types';
import { generateId, DEFAULT_COLLECTION_ID, normalizeOverlayContent, normalizeNarrationTrack, defaultNarrationStyle } from '../types';
import { normalizeTerritoryDisplay } from '../lib/territory';
import { deriveElements, layerTypeOf, insertLayerSorted, LAYER_TYPE_LABEL, resolveTargetLayerId } from '../lib/layers';
import { useEditorStore } from './editorStore';
import { planChapterCamera } from '../lib/camera-plan';
import { releaseAssetUrls, getAssetBytes, putAssetBytes, type AssetKind } from '../lib/assets';
import { clearGifCache } from '../lib/gif-decoder';

/** 元素归一化：custom_icon 下线 → 点；旧 fly 动画 → move；疆域 display 补默认 */
function normalizeElement(raw: MapElement): MapElement {
  let e = raw;
  if ((e as any).type === 'custom_icon') {
    const { symbolId: _sid, size: _size, ...rest } = e as any;
    e = { ...rest, type: 'point', shape: undefined } as unknown as MapElement;
  }
  const legacyFly = (e as any).animEffect === 'fly';
  const el = legacyFly ? { ...e, flyMode: true, animEffect: 'move' as const } : e;
  return (e.type === 'territory' ? { ...el, display: normalizeTerritoryDisplay((el as any).display) } : el) as MapElement;
}

/** 新建默认图层（用于无图层时承接新元素；单类型图层，按类型命名） */
function makeDefaultLayer(p: MapVideoProject, type: LayerType): Layer {
  const n = (p.layers?.filter((L) => L.type === type).length || 0) + 1;
  return {
    id: generateId(), type, name: `${LAYER_TYPE_LABEL[type]} ${n}`, visible: true,
    startFrame: 0, endFrame: Math.max(1, p.endFrame || 1), elements: [],
  };
}

/** 平移元素的所有时间字段（图层显示起点变化时同步，保持相对观感） */
function shiftElementTime(el: MapElement, d: number): MapElement {
  const out = {
    ...el,
    startFrame: el.startFrame + d,
    endFrame: el.endFrame + d,
  } as MapElement & { moveStartFrame?: number; moveEndFrame?: number; pointTimes?: number[] };
  if (typeof out.moveStartFrame === 'number') out.moveStartFrame += d;
  if (typeof out.moveEndFrame === 'number') out.moveEndFrame += d;
  if (Array.isArray(out.pointTimes)) out.pointTimes = out.pointTimes.map((t) => t + d);
  return out as MapElement;
}

function normalizeOverlays(overlays: OverlayItem[] | undefined): OverlayItem[] {
  return (overlays || []).map((o) => {
    const legacy = o as typeof o & { offset?: { x: number; y: number }; widthPct?: number };
    const { offset: _off, widthPct: _wp, ...rest } = legacy;
    return { ...rest, offsetX: rest.offsetX ?? 0, offsetY: rest.offsetY ?? 0, content: normalizeOverlayContent(o.content) };
  });
}

/** 项目级背景音乐归一化：单轨多段，缺省字段补默认值 */
function normalizeMusic(music?: MusicTrack[]): MusicTrack[] {
  return (music || []).map((m) => ({ ...m, fadeIn: m.fadeIn ?? 0, fadeOut: m.fadeOut ?? 0, volume: m.volume ?? 0.6, loop: m.loop ?? false }));
}

/** 项目内容结束帧：所有随时间内容的最大帧（用于兜底 endFrame） */
export function projectContentEnd(project: MapVideoProject): number {
  let end = 0;
  const push = (v?: number | null) => { if (typeof v === 'number' && Number.isFinite(v) && v > end) end = v; };
  for (const el of project.elements || []) { push(el.endFrame); push((el as { moveEndFrame?: number }).moveEndFrame); }
  for (const kf of project.camera || []) push(kf.frame);
  for (const o of project.overlays || []) push(o.endFrame);
  for (const fx of project.fx || []) push(fx.endFrame);
  for (const e of project.narration?.entries || []) push((e.startFrame ?? 0) + (e.durationFrames ?? 0));
  for (const m of project.music || []) push(m.endFrame);
  return end;
}

/** load/import 入口统一归一化 */
function normalizeProject(project: MapVideoProject): MapVideoProject {
  // 图层：新格式用 layers；旧数据（只有扁平 elements）包进一个默认图层
  const rawLayers: Layer[] = project.layers?.length
    ? project.layers.map((L) => ({ ...L, type: L.type || 'marker', elements: (L.elements || []).map(normalizeElement) }))
    : [{ id: generateId(), type: 'marker', name: '标记 1', visible: true, startFrame: 0, endFrame: Math.max(1, project.endFrame || 1), elements: (project.elements || []).map(normalizeElement) }];
  const elements = deriveElements(rawLayers);
  const endFrame = project.endFrame && project.endFrame > 0 ? project.endFrame : Math.max(1, projectContentEnd({ ...project, elements }));
  return {
    ...project,
    startFrame: 0,
    // 底图 / 高程兜底：旧数据或缺失时补默认，避免「高程图不见了」
    baseMaps: project.baseMaps?.length ? project.baseMaps : [...DEFAULT_BASE_MAPS],
    elevationMaps: project.elevationMaps?.length ? project.elevationMaps : [...DEFAULT_ELEVATION_MAPS],
    activeBaseMapId: project.activeBaseMapId || 'satellite',
    activeElevationMapId: project.activeElevationMapId ?? 'none',
    layers: rawLayers,
    elements,
    camera: project.camera?.length ? project.camera : [{ frame: 0, center: [104.0, 35.0], zoom: 4 }],
    overlays: normalizeOverlays(project.overlays),
    fx: (project.fx || []).map((f) => ({ enabled: true, ...f })),
    narration: project.narration ? normalizeNarrationTrack(project.narration) : { entries: [], style: defaultNarrationStyle() },
    music: normalizeMusic(project.music),
    endFrame,
  };
}

/** 项目名唯一性（大小写不敏感）。返回在 existing 中不冲突的名称：重复则追加 (2)/(3)… */
export function uniqueProjectName(base: string, existing: string[]): string {
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
  const name = base.trim() || '未命名项目';
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; i < 100000; i++) {
    const cand = `${name} (${i})`;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return `${name} (${Date.now()})`;
}

/** 判断项目名是否已被占用（供 UI 内联校验） */
export function isProjectNameTaken(name: string, existing: string[]): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  return existing.some((x) => x.trim().toLowerCase() === n);
}

/** 已下线的底图 id：MapLibre 示例（Natural Earth，中国边界不符合国标） */
const REMOVED_BASE_MAP_IDS = new Set(['demotiles']);

/** 底图归一化（load/import 时调用）：只清掉已下线的底图 id */
function stripRemovedBaseMaps(project: MapVideoProject): MapVideoProject {
  const source = project.baseMaps || [];
  const baseMaps = source.filter((b) => !REMOVED_BASE_MAP_IDS.has(b.id));
  if (baseMaps.length === source.length) return project;
  const activeBaseMapId = baseMaps.some((b) => b.id === project.activeBaseMapId)
    ? project.activeBaseMapId
    : (baseMaps[0]?.id || 'osm');
  return { ...project, baseMaps, activeBaseMapId };
}

// ========== 默认配置 ==========

const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  defaultDuration: 3000,
  defaultFPS: 30,
  defaultResolution: { width: 1920, height: 1080, label: '1080p' },
  defaultEasing: 'easeInOut',
  projection: 'mercator',
};

const DEFAULT_BASE_MAPS: BaseMapConfig[] = [
  {
    id: 'osm',
    name: 'OpenStreetMap',
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '© OpenStreetMap contributors',
        },
      },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    } as unknown as string,
  },
  { id: 'dark', name: '暗色地图', style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json' },
  { id: 'light', name: '亮色地图', style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json' },
  { id: 'voyager', name: '探索者地图', style: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json' },
  {
    id: 'satellite', name: '卫星影像',
    style: {
      version: 8,
      sources: {
        sat: {
          type: 'raster',
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          tileSize: 256,
          attribution: '© Esri World Imagery',
        },
      },
      layers: [{ id: 'sat', type: 'raster', source: 'sat' }],
    } as unknown as string,
  },
  { id: 'openfreemap', name: 'OpenFreeMap', style: 'https://tiles.openfreemap.org/styles/liberty' },
  { id: 'maplibre-demo', name: 'MapLibre 示例（国标）', style: 'geo/maplibre-demo.json' },
];

const DEFAULT_ELEVATION_MAPS: ElevationMapConfig[] = [
  { id: 'none', name: '无高程（平面）', url: '' },
  { id: 'maplibre-terrain', name: '地形高程 (MapLibre)', url: 'https://demotiles.maplibre.org/terrain-tiles/tiles.json', encoding: 'terrarium', exaggeration: 1.5 },
  { id: 'aws-terrain', name: '地形高程 (AWS Terrarium)', url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png', encoding: 'terrarium', exaggeration: 1.5 },
];

// ========== 历史栈控制 ==========

const HISTORY_LIMIT = 50;

let historyMuted = false;
export function setHistoryMuted(v: boolean) {
  historyMuted = v;
}

let savedProjectRef: MapVideoProject | null = null;
function markProjectSaved(p: MapVideoProject) { savedProjectRef = p; }
/** 项目是否有未保存修改（内存 vs 最近一次落盘态） */
export function isProjectDirty(p: MapVideoProject | null): boolean {
  if (!p) return false;
  return p !== savedProjectRef;
}

export function snapshotHistory() {
  const store = useProjectStore.getState();
  if (!store.project) return;
  const next = [...store.history, store.project];
  if (next.length > HISTORY_LIMIT) next.shift();
  useProjectStore.setState({ history: next, future: [] });
}

// ========== Store 接口 ==========

interface ProjectState {
  project: MapVideoProject | null;
  history: MapVideoProject[];
  future: MapVideoProject[];

  // 项目操作
  createProject: (name: string, collectionId?: string) => Promise<void>;
  loadProject: (id: string) => Promise<void>;
  saveProject: () => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  listProjects: () => Promise<MapVideoProject[]>;
  /** 一键生成：用 AI 段落计划重建整条时间线 */
  applyGeneratedProject: (segments: GeneratedChapterPlan[], secondsPerSegment: number) => void;
  setProjectEndFrame: (endFrame: number) => void;

  // 图层操作（单类型图层）
  addLayer: (type: LayerType, name?: string) => Layer;
  addLayerFull: (layer: Layer) => void;
  updateLayer: (layerId: string, changes: Partial<Pick<Layer, 'name' | 'visible' | 'startFrame' | 'endFrame'>>) => void;
  /** 拖动图层块：改显示区间；shiftElements=true（整体平移）时同步平移其元素 */
  updateLayerRange: (layerId: string, startFrame: number, endFrame: number, shiftElements: boolean) => void;
  deleteLayer: (layerId: string) => void;
  /** 拖动图层调整顺序：把 fromId 移到 toId 的位置 */
  moveLayer: (fromId: string, toId: string) => void;
  moveElementsToLayer: (elementIds: string[], layerId: string) => void;

  // 元素操作（项目级；归属图层，缺省并入首个图层）
  addElement: (element: MapElement, layerId?: string) => void;
  updateElement: (elementId: string, changes: Partial<MapElement>) => void;
  deleteElement: (elementId: string) => void;
  addElements: (elements: MapElement[], layerId?: string) => void;

  // Overlay 操作
  addOverlay: (overlay: OverlayItem) => void;
  updateOverlay: (overlayId: string, changes: Partial<OverlayItem>) => void;
  deleteOverlay: (overlayId: string) => void;

  // 天气/画面特效
  addScreenFx: (fx: ScreenFxItem) => void;
  updateScreenFx: (fxId: string, changes: Partial<ScreenFxItem>) => void;
  removeScreenFx: (fxId: string) => void;

  // 字幕/配音轨道
  setNarrationStyle: (patch: Partial<NarrationStyle>) => void;
  setNarrationEntries: (entries: NarrationEntry[]) => void;
  updateNarrationEntry: (entryId: string, patch: Partial<NarrationEntry>) => void;

  // 背景音乐（项目级）
  setProjectMusic: (tracks: MusicTrack[]) => void;
  updateProjectMusic: (trackId: string, patch: Partial<MusicTrack>) => void;

  // 相机
  setProjectCamera: (camera: CameraKeyframe[]) => void;

  // 底图 / 高程 / 全局
  setActiveBaseMap: (id: string) => void;
  addBaseMap: (baseMap: BaseMapConfig) => void;
  removeBaseMap: (id: string) => void;
  setActiveElevationMap: (id: string | null) => void;
  addElevationMap: (e: ElevationMapConfig) => void;
  updateElevationMap: (id: string, patch: Partial<ElevationMapConfig>) => void;
  updateGlobalConfig: (changes: Partial<GlobalConfig>) => void;

  // 导入导出
  importProjectConfig: (data: ProjectExport, collectionId?: string) => Promise<void>;
  createExport: () => Promise<ProjectExport>;
  clear: () => void;

  // 撤回/重做
  undo: () => void;
  redo: () => void;
}

/** 导入的素材字节 → 素材类别 */
function mimeToAssetKind(mime: string): AssetKind {
  return mime === 'image/gif' ? 'gif'
    : mime.startsWith('model/') ? 'model'
      : mime.startsWith('image/') ? 'image' : 'icon';
}

/** 导入后把项目里所有 assetId 旧引用换成新 id */
function remapAssetIds(project: MapVideoProject, map: Record<string, string>): MapVideoProject {
  if (!Object.keys(map).length) return project;
  return {
    ...project,
    elements: project.elements.map((el) => {
      const e = el as { assetId?: string; moveIcon?: { assetId?: string } };
      const hitAsset = e.assetId ? map[e.assetId] : undefined;
      const hitMove = e.moveIcon?.assetId ? map[e.moveIcon.assetId] : undefined;
      if (!hitAsset && !hitMove) return el;
      return {
        ...e,
        assetId: hitAsset ?? e.assetId,
        moveIcon: e.moveIcon
          ? { ...e.moveIcon, assetId: hitMove ?? e.moveIcon.assetId }
          : e.moveIcon,
      } as typeof el;
    }),
  };
}

// ========== Store 实现 ==========

export const useProjectStore = create<ProjectState>()((set, get) => {
  const commit = () => {
    if (historyMuted) return;
    const { project, history } = get();
    if (!project) return;
    const next = [...history, project];
    if (next.length > HISTORY_LIMIT) next.shift();
    set({ history: next, future: [] });
  };

  /** 项目级不可变更新（自动压历史）。每次更新后从 layers 重算 elements 派生镜像 */
  const patch = (fn: (p: MapVideoProject) => MapVideoProject, withHistory = true) => {
    if (withHistory) commit();
    set((state) => {
      if (!state.project) return state;
      const p = fn(state.project);
      const next: MapVideoProject = { ...p, elements: deriveElements(p.layers) };
      // 选中元素的宿主层就是地图上的「可编辑层」：新建、改类型迁移、面板/时间线点选
      // 都从这一处收口，否则「刚画完的东西自己点不动」。只改门禁，不动写入目标。
      const selId = useEditorStore.getState().selectedElementId;
      if (selId && next.elements.some((el) => el.id === selId)) {
        const host = next.layers.find((L) => L.elements.some((el) => el.id === selId));
        if (host && useEditorStore.getState().selectedLayerId !== host.id) useEditorStore.getState().focusLayer(host.id);
      }
      return { project: next };
    });
  };

  return {
    project: null,
    history: [],
    future: [],

    // ----- 项目 -----
    createProject: async (name: string, collectionId?: string) => {
      const trimmed = name.trim() || '未命名项目';
      const existing = await storage.listProjects();
      if (isProjectNameTaken(trimmed, existing.map((p) => p.name))) {
        throw new Error(`已存在同名项目「${trimmed}」`);
      }
      const project: MapVideoProject = {
        id: generateId(), name: trimmed, collectionId: collectionId || DEFAULT_COLLECTION_ID,
        createdAt: new Date(), updatedAt: new Date(),
        globalConfig: { ...DEFAULT_GLOBAL_CONFIG },
        startFrame: 0,
        endFrame: DEFAULT_GLOBAL_CONFIG.defaultDuration,
        layers: [{ id: generateId(), type: 'marker', name: '标记 1', visible: true, startFrame: 0, endFrame: DEFAULT_GLOBAL_CONFIG.defaultDuration, elements: [] }],
        elements: [],
        camera: [{ frame: 0, center: [104.0, 35.0], zoom: 4 }],
        overlays: [],
        fx: [],
        narration: { entries: [], style: defaultNarrationStyle() },
        music: [],
        baseMaps: [...DEFAULT_BASE_MAPS],
        activeBaseMapId: 'satellite',
        elevationMaps: [...DEFAULT_ELEVATION_MAPS],
        activeElevationMapId: 'none',
      };
      useEditorStore.getState().resetSelection();
      set({ project, history: [], future: [] });
      await storage.saveProject(project);
      markProjectSaved(project);
    },

    loadProject: async (id: string) => {
      useEditorStore.getState().resetSelection();
      releaseAssetUrls();
      clearGifCache();
      (await import('../lib/map-renderer')).clearRenderCaches();
      (await import('../lib/model-renderer')).clearModelCaches();
      const project = await storage.getProject(id);
      if (project) {
        const normalized = stripRemovedBaseMaps(normalizeProject(project));
        set({ project: normalized, history: [], future: [] });
        markProjectSaved(normalized);
      }
    },

    saveProject: async () => {
      const { project } = get();
      if (!project) return;
      const updated = { ...project, updatedAt: new Date() };
      await storage.saveProject(updated);
      set({ project: updated });
      markProjectSaved(updated);
    },

    deleteProject: async (id: string) => {
      await storage.deleteProject(id);
      const { project } = get();
      if (project?.id === id) set({ project: null, history: [], future: [] });
    },

    listProjects: async () => storage.listProjects(),

    /** 一键生成：把多段计划铺成一条连续时间线 */
    applyGeneratedProject: (segments, secondsPerSegment) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        const p = state.project;
        const fps = p.globalConfig.defaultFPS || 30;
        const target = Math.max(1, Math.round(secondsPerSegment * fps));
        const elements: MapElement[] = [];
        const overlays: OverlayItem[] = [];
        const fx: ScreenFxItem[] = [];
        const camera: CameraKeyframe[] = [];
        const entries: NarrationEntry[] = [];
        let cursor = 0;
        segments.forEach((seg, i) => {
          const start = cursor;
          let f = start;
          for (const e of seg.entries) {
            entries.push({ ...e, startFrame: f });
            f += Math.max(1, e.durationFrames);
          }
          const contentDur = f - start;
          const end = start + (contentDur > 0 ? contentDur : target);
          // 弹窗
          for (const o of seg.overlays || []) {
            overlays.push({
              id: generateId(), type: o.type, name: o.name || '', position: o.position, content: o.content,
              startFrame: Math.min(end - 1, start + Math.max(0, o.startOffset)),
              endFrame: Math.min(end, start + Math.max(0, o.startOffset) + Math.max(1, o.duration)),
              animation: o.animation, exitAnimation: o.exitAnimation, scale: o.scale, offsetX: 0, offsetY: 0,
            });
          }
          // 画面特效：vignette 铺满本段；其余片头 1.5s
          for (const type of seg.fx || []) {
            const full = type === 'vignette';
            const dur = full ? Math.max(1, end - start) : Math.min(Math.max(1, end - start), Math.round(1.5 * fps));
            fx.push({ id: generateId(), kind: 'screen', name: type, startFrame: start, endFrame: start + dur, effect: { type, intensity: type === 'vignette' ? 0.4 : 0.6 }, enabled: true });
          }
          // 元素（段内相对帧 → 绝对帧）
          for (const el of seg.elements || []) {
            elements.push({ ...el, startFrame: start + Math.max(0, el.startFrame), endFrame: Math.min(end, start + Math.max(1, el.endFrame)) });
          }
          // 地名落点：显示时间对齐到该地名**首次被提及**的字幕（未提及则铺满本段）
          for (const mk of seg.markers || []) {
            const hit = entries.find((e) => e.text.includes(mk.name));
            const ms = hit ? hit.startFrame : start;
            const me = Math.min(end, ms + Math.round(4 * fps));
            elements.push({
              id: generateId(), type: 'point', name: mk.name, visible: true, locked: false,
              startFrame: ms, endFrame: Math.max(ms + 1, me), style: {}, coordinates: mk.center, shape: 'pin', color: '#f59e0b',
              label: { text: mk.name, fontSize: 13, color: '#ffffff', bgColor: 'rgba(12,10,9,0.72)', offsetY: 32 },
            } as MapElement);
          }
          // 相机
          camera.push(...planChapterCamera(start, end, fps, seg.cameraTarget));
          cursor = end;
          void i;
        });
        // 单类型图层：生成元素按类型分组，各建一个图层
        const byType = new Map<LayerType, MapElement[]>();
        for (const el of elements) {
          const lt = layerTypeOf(el);
          const arr = byType.get(lt);
          if (arr) arr.push(el); else byType.set(lt, [el]);
        }
        const genLayers: Layer[] = [...byType.entries()].map(([type, els]) => ({
          id: generateId(), type, name: `${LAYER_TYPE_LABEL[type]} · 生成`, visible: true,
          startFrame: 0, endFrame: Math.max(1, cursor), elements: els,
        }));
        return {
          project: {
            ...p,
            layers: [...p.layers, ...genLayers],
            elements: [],
            overlays: [...p.overlays, ...overlays],
            fx: [...p.fx, ...fx],
            camera,
            narration: { ...p.narration, entries },
            endFrame: cursor,
          },
        };
      });
    },

    setProjectEndFrame: (endFrame: number) => patch((p) => ({ ...p, endFrame: Math.max(1, Math.round(endFrame)) })),

    // ----- 图层 -----
    addLayer: (type: LayerType, name?: string) => {
      const p0 = useProjectStore.getState().project;
      const base: Layer = p0
        ? makeDefaultLayer(p0, type)
        : { id: generateId(), type, name: LAYER_TYPE_LABEL[type], visible: true, startFrame: 0, endFrame: 1, elements: [] };
      const layer: Layer = name ? { ...base, name } : base;
      patch((p) => ({ ...p, layers: insertLayerSorted(p.layers, layer) }));
      return layer;
    },
    addLayerFull: (layer: Layer) => patch((p) => ({ ...p, layers: insertLayerSorted(p.layers, layer) })),
    updateLayer: (layerId, changes) =>
      patch((p) => ({
        ...p,
        layers: p.layers.map((L) => {
          if (L.id !== layerId) return L;
          const next: Layer = { ...L, ...changes };
          // 图层显示起点变化 → 同步平移元素，保持「相对图层」的观感
          if (changes.startFrame != null && changes.startFrame !== L.startFrame) {
            const d = changes.startFrame - L.startFrame;
            next.elements = L.elements.map((el) => shiftElementTime(el, d));
          }
          return next;
        }),
      })),
    deleteLayer: (layerId) => patch((p) => ({ ...p, layers: p.layers.filter((L) => L.id !== layerId) })),
    moveLayer: (fromId, toId) =>
      patch((p) => {
        const from = p.layers.findIndex((L) => L.id === fromId);
        const to = p.layers.findIndex((L) => L.id === toId);
        if (from < 0 || to < 0 || from === to) return p;
        const arr = [...p.layers];
        const [item] = arr.splice(from, 1);
        arr.splice(to, 0, item);
        return { ...p, layers: arr };
      }),
    updateLayerRange: (layerId, startFrame, endFrame, shiftElements) =>
      patch((p) => ({
        ...p,
        layers: p.layers.map((L) => {
          if (L.id !== layerId) return L;
          const s = Math.max(0, Math.round(startFrame));
          const e = Math.max(s + 1, Math.round(endFrame));
          const next: Layer = { ...L, startFrame: s, endFrame: e };
          if (shiftElements) {
            const d = s - L.startFrame;
            if (d) next.elements = L.elements.map((el) => shiftElementTime(el, d));
          }
          return next;
        }),
      })),
    moveElementsToLayer: (elementIds, layerId) =>
      patch((p) => {
        const ids = new Set(elementIds);
        const moving: MapElement[] = [];
        const layers = p.layers.map((L) => {
          const keep = L.elements.filter((el) => {
            if (L.id !== layerId && ids.has(el.id)) { moving.push(el); return false; }
            return true;
          });
          return keep.length === L.elements.length ? L : { ...L, elements: keep };
        });
        return { ...p, layers: layers.map((L) => (L.id === layerId ? { ...L, elements: [...L.elements, ...moving] } : L)) };
      }),

    // ----- 元素（归属单类型图层；elements 为派生镜像，由 patch 自动重算） -----
    // 归属解析顺序：显式指定 → 该类型的「写入目标」→ 该类第一个图层 → 新建
    addElement: (element, layerId) =>
      patch((p) => {
        const ltype = layerTypeOf(element);
        const targets = useEditorStore.getState().targetLayers;
        let layers = p.layers;
        const id = resolveTargetLayerId(layers, ltype, targets, layerId);
        let target = layers.find((L) => L.id === id) || null;
        if (!target) { target = makeDefaultLayer(p, ltype); layers = insertLayerSorted(layers, target); }
        return { ...p, layers: layers.map((L) => (L.id === target!.id ? { ...L, elements: [...L.elements, element] } : L)) };
      }),
    addElements: (elements, layerId) =>
      patch((p) => {
        if (!elements.length) return p;
        // 指定图层：整批并入；否则按元素类型分组，各入同类型图层（无则新建）
        if (layerId && p.layers.some((L) => L.id === layerId)) {
          return { ...p, layers: p.layers.map((L) => (L.id === layerId ? { ...L, elements: [...L.elements, ...elements] } : L)) };
        }
        const targets = useEditorStore.getState().targetLayers;
        let layers = [...p.layers];
        for (const el of elements) {
          const ltype = layerTypeOf(el);
          let idx = layers.findIndex((L) => L.id === resolveTargetLayerId(layers, ltype, targets));
          if (idx < 0) {
            layers = insertLayerSorted(layers, makeDefaultLayer({ ...p, layers }, ltype));
            idx = layers.findIndex((L) => L.type === ltype);
          }
          layers[idx] = { ...layers[idx], elements: [...layers[idx].elements, el] };
        }
        return { ...p, layers };
      }),
    updateElement: (elementId, changes) =>
      patch((p) => {
        const host = p.layers.find((L) => L.elements.some((el) => el.id === elementId));
        if (!host) return p;
        const merged = (host.elements.find((el) => el.id === elementId) as MapElement);
        const next = { ...merged, ...changes } as MapElement;
        // 改类型可能跨类别（polygon ↔ line）：图层是单类型的，必须迁走，否则不变量被破坏、落库进错表
        const want = layerTypeOf(next);
        if (want !== host.type) {
          const targets = useEditorStore.getState().targetLayers;
          const without = p.layers.map((L) => (L.id === host.id ? { ...L, elements: L.elements.filter((el) => el.id !== elementId) } : L));
          let layers = without;
          const id = resolveTargetLayerId(without, want, targets);
          let dst = layers.find((L) => L.id === id) || null;
          if (!dst) { dst = makeDefaultLayer({ ...p, layers }, want); layers = insertLayerSorted(layers, dst); }
          const dstId = dst.id;
          return { ...p, layers: layers.map((L) => (L.id === dstId ? { ...L, elements: [...L.elements, next] } : L)) };
        }
        return {
          ...p,
          layers: p.layers.map((L) => (
            L.id === host.id
              ? { ...L, elements: L.elements.map((el) => (el.id === elementId ? next : el)) }
              : L
          )),
        };
      }),

    /** 删除元素 —— 一并清理指向它的跟随机位（退化为固定镜头） */
    deleteElement: (elementId) =>
      patch((p) => {
        const layers = p.layers.map((L) => ({
          ...L,
          elements: L.elements.filter((el) => el.id !== elementId),
        }));
        const camera = p.camera.map((kf) =>
          kf.followRoute?.routeElementId === elementId ? { ...kf, cameraType: 'fixed' as const, followRoute: undefined } : kf,
        );
        return { ...p, layers, camera };
      }),

    // ----- Overlay -----
    addOverlay: (overlay: OverlayItem) => patch((p) => ({ ...p, overlays: [...p.overlays, overlay] })),
    updateOverlay: (overlayId: string, changes: Partial<OverlayItem>) =>
      patch((p) => ({ ...p, overlays: p.overlays.map((o) => (o.id === overlayId ? ({ ...o, ...changes } as OverlayItem) : o)) })),
    deleteOverlay: (overlayId: string) => patch((p) => ({ ...p, overlays: p.overlays.filter((o) => o.id !== overlayId) })),

    // ----- 特效窗口 -----
    addScreenFx: (fx: ScreenFxItem) => patch((p) => ({ ...p, fx: [...p.fx, fx] })),
    updateScreenFx: (fxId: string, changes: Partial<ScreenFxItem>) =>
      patch((p) => ({ ...p, fx: p.fx.map((f) => (f.id === fxId ? ({ ...f, ...changes } as ScreenFxItem) : f)) })),
    removeScreenFx: (fxId: string) => patch((p) => ({ ...p, fx: p.fx.filter((f) => f.id !== fxId) })),

    // ----- 字幕/配音 -----
    setNarrationStyle: (patchStyle: Partial<NarrationStyle>) =>
      patch((p) => { const cur = normalizeNarrationTrack(p.narration); return { ...p, narration: { ...cur, style: { ...cur.style, ...patchStyle } } }; }),
    setNarrationEntries: (entries: NarrationEntry[]) =>
      patch((p) => ({ ...p, narration: { ...normalizeNarrationTrack(p.narration), entries } })),
    updateNarrationEntry: (entryId: string, entryPatch: Partial<NarrationEntry>) =>
      patch((p) => {
        const cur = normalizeNarrationTrack(p.narration);
        return { ...p, narration: { ...cur, entries: cur.entries.map((e) => (e.id === entryId ? ({ ...e, ...entryPatch } as NarrationEntry) : e)) } };
      }),

    // ----- 背景音乐 -----
    setProjectMusic: (tracks: MusicTrack[]) => patch((p) => ({ ...p, music: tracks })),
    updateProjectMusic: (trackId: string, trackPatch: Partial<MusicTrack>) =>
      patch((p) => ({ ...p, music: p.music.map((m) => (m.id === trackId ? { ...m, ...trackPatch } : m)) })),

    // ----- 相机 -----
    setProjectCamera: (camera: CameraKeyframe[]) => patch((p) => ({ ...p, camera })),

    // ----- 底图 / 高程 / 全局 -----
    setActiveBaseMap: (id: string) => patch((p) => ({ ...p, activeBaseMapId: id })),
    addBaseMap: (baseMap: BaseMapConfig) => patch((p) => ({ ...p, baseMaps: [...p.baseMaps, baseMap] })),
    removeBaseMap: (id: string) => patch((p) => ({
      ...p,
      baseMaps: p.baseMaps.filter((b) => b.id !== id),
      activeBaseMapId: p.activeBaseMapId === id ? 'osm' : p.activeBaseMapId,
    })),
    setActiveElevationMap: (id: string | null) => patch((p) => ({ ...p, activeElevationMapId: id })),
    addElevationMap: (e: ElevationMapConfig) => patch((p) => ({ ...p, elevationMaps: [...p.elevationMaps, e] })),
    updateElevationMap: (id: string, ePatch: Partial<ElevationMapConfig>) =>
      patch((p) => ({ ...p, elevationMaps: p.elevationMaps.map((e) => (e.id === id ? { ...e, ...ePatch } : e)) })),
    updateGlobalConfig: (changes: Partial<GlobalConfig>) => patch((p) => ({ ...p, globalConfig: { ...p.globalConfig, ...changes } })),

    importProjectConfig: async (data: ProjectExport, collectionId?: string) => {
      let imported = data;
      if (data.assets?.length) {
        const idMap: Record<string, string> = {};
        for (const a of data.assets) {
          // 素材还原失败要中止整笔导入：留着指向空素材的 assetId，导入后是坏图，
          // 桌面端还会被 element_*.asset_id 的外键把整次保存打回。
          const bin = atob(a.dataUrl.split(',')[1] || '');
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const ref = await putAssetBytes(bytes, a.mime, '', mimeToAssetKind(a.mime));
          idMap[a.assetId] = ref.assetId;
        }
        imported = { ...data, project: remapAssetIds(data.project, idMap) };
      }
      const existing = await storage.listProjects();
      const project = stripRemovedBaseMaps(normalizeProject({
        ...imported.project,
        name: uniqueProjectName(imported.project.name || '未命名项目', existing.map((p) => p.name)),
        id: generateId(),
        collectionId: collectionId || DEFAULT_COLLECTION_ID,
        updatedAt: new Date(),
      }));
      useEditorStore.getState().resetSelection();
      set({ project, history: [], future: [] });
      await storage.saveProject(project);
      markProjectSaved(project);
    },

    createExport: async () => {
      const { project } = get();
      if (!project) throw new Error('没有可导出的项目');
      const ids = new Set<string>();
      for (const el of project.elements) {
        if (el.type === 'point' && el.assetId) ids.add(el.assetId);
      }
      const assets: ExportedAsset[] = [];
      for (const assetId of ids) {
        const bytes = await getAssetBytes(assetId);
        if (!bytes) continue;
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        const b64 = btoa(bin);
        const mime = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png'
          : bytes[0] === 0x47 && bytes[1] === 0x49 ? 'image/gif'
          : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
          : bytes[0] === 0x67 && bytes[1] === 0x6c ? 'model/gltf-binary'
          : 'application/octet-stream';
        assets.push({ assetId, mime, byteSize: bytes.length, dataUrl: `data:${mime};base64,${b64}` });
      }
      return { version: 1, exportedAt: new Date(), project, assets };
    },

    clear: () => set({ project: null, history: [], future: [] }),

    undo: () => {
      const { history, project, future } = get();
      if (history.length === 0 || !project) return;
      const prev = history[history.length - 1];
      set({ project: prev, history: history.slice(0, -1), future: [...future, project] });
    },

    redo: () => {
      const { future, project, history } = get();
      if (future.length === 0 || !project) return;
      const next = future[future.length - 1];
      set({ project: next, history: [...history, project], future: future.slice(0, -1) });
    },
  };
});
