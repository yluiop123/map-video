import { create } from 'zustand';
import { storage } from '../lib/storage';
import type {
  MapVideoProject, Chapter, MapElement, GlobalConfig, BaseMapConfig,
  ElevationMapConfig, CustomSymbol, OverlayItem, CameraKeyframe, TransitionConfig,
  ChapterEffect, ProjectExport, ScreenFxItem,
  NarrationEntry, NarrationStyle, MusicTrack
} from '../types';
import { generateId, normalizeOverlayContent, normalizeTitleStyle, normalizeNarrationTrack, defaultNarrationStyle } from '../types';
import { normalizeTerritoryDisplay } from '../lib/territory';

/** 兼容旧存档：疆域 display / 章节特效层 / 旧弹窗类型缺字段时补默认值（load/import 入口统一过一遍） */
function normalizeChapters(chapters: Chapter[]): Chapter[] {
  return chapters.map((c) => ({
    ...c,
    fx: (c.fx || []).map((f) => ({ enabled: true, ...f })),
    titleStyle: c.titleStyle ? normalizeTitleStyle(c.titleStyle) : undefined,
    elements: (c.elements || []).map((raw) => {
      // 迁移：custom_icon 元素类型已下线 → 退化为普通标记点（保留坐标、名称与时间）
      let e = raw;
      if ((e as any).type === 'custom_icon') {
        const { symbolId: _sid, size: _size, ...rest } = e as any;
        e = { ...rest, type: 'point', shape: undefined } as unknown as MapElement;
      }
// 迁移：旧版飞行动画效果 → 飞行模式开关（路线/图标整条悬空）+ 路线移动（图标随播放进度沿航迹移动）
      const legacyFly = (e as any).animEffect === 'fly';
      const el = legacyFly ? { ...e, flyMode: true, animEffect: 'move' as const } : e;
      return e.type === 'territory' ? { ...el, display: normalizeTerritoryDisplay((el as any).display) } : el;
    }),
    overlays: (c.overlays || []).map((o) => {
      const legacy = o as typeof o & { offset?: { x: number; y: number }; widthPct?: number };
      const { offset: _off, widthPct: _wp, ...rest } = legacy;
      return { ...rest, offsetX: rest.offsetX ?? 0, offsetY: rest.offsetY ?? 0, content: normalizeOverlayContent(o.content) };
    }),
    narration: c.narration ? normalizeNarrationTrack(c.narration) : { entries: [], style: defaultNarrationStyle() },
    music: (c.music || []).map((m) => ({ ...m, fadeIn: m.fadeIn ?? 0, fadeOut: m.fadeOut ?? 0, volume: m.volume ?? 0.6, loop: m.loop ?? false })),
  }));
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
  { id: 'demotiles', name: 'MapLibre 示例', style: 'https://demotiles.maplibre.org/style.json' },
];

const DEFAULT_ELEVATION_MAPS: ElevationMapConfig[] = [
{ id: 'none', name: '无高程（平面）', url: '' },
  { id: 'maplibre-terrain', name: '地形高程 (MapLibre)', url: 'https://demotiles.maplibre.org/terrain-tiles/tiles.json', encoding: 'terrarium', exaggeration: 1.5 },
  { id: 'aws-terrain', name: '地形高程 (AWS Terrarium)', url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png', encoding: 'terrarium', exaggeration: 1.5 },
];

function createDefaultChapter(index = 0, startFrame = 0, duration = 3000): Chapter {
const titles = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  return {
    id: generateId(),
title: `第${titles[Math.min(index, titles.length - 1)]}章`,
    subtitle: '',
    order: index,
    startFrame,
    endFrame: startFrame + duration,
    elements: [],
    camera: [{ frame: startFrame, center: [104.0, 35.0], zoom: 4 }],
    overlays: [],
    effects: [],
    fx: [],
    narration: { entries: [], style: defaultNarrationStyle() },
    music: [],
  };
}

// ========== 历史栈控制 ==========

const HISTORY_LIMIT = 50;

let historyMuted = false;
export function setHistoryMuted(v: boolean) {
  historyMuted = v;
}

let lastHistoryTime = 0;

/** 已保存（写入 IndexedDB）项目的 JSON 快照，用于保存按钮的脏标记 */
let savedProjectJSON = '';
function markProjectSaved(p: MapVideoProject) { savedProjectJSON = JSON.stringify(p); }
/** 项目是否有未保存修改（内存 vs 最近一次落盘态） */
export function isProjectDirty(p: MapVideoProject | null): boolean {
  if (!p) return false;
  if (!savedProjectJSON) return true;
  return JSON.stringify(p) !== savedProjectJSON;
}
const HISTORY_THROTTLE_MS = 700;

/** 立即压一次历史（不受节流和拖拽静音影响），用于拖拽开始前快照 */
export function snapshotHistory() {
  const store = useProjectStore.getState();
  if (!store.project) return;
  const next = [...store.history, store.project];
  if (next.length > HISTORY_LIMIT) next.shift();
  useProjectStore.setState({ history: next, future: [] });
  lastHistoryTime = Date.now();
}

// ========== Store 接口 ==========

interface ProjectState {
  project: MapVideoProject | null;
  history: MapVideoProject[];
  future: MapVideoProject[];

  // 项目操作
  createProject: (name: string) => void;
  loadProject: (id: string) => Promise<void>;
  saveProject: () => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  listProjects: () => Promise<MapVideoProject[]>;

  // 章节操作
  addChapter: (title?: string) => void;
  updateChapter: (id: string, changes: Partial<Chapter>) => void;
  deleteChapter: (id: string) => void;
  reorderChapters: (chapters: Chapter[]) => void;
/** 复制章节（含元素/镜头/叠加层，ID 全部重建），并顺移后续章节 */
  duplicateChapter: (id: string) => void;

  // 元素操作
  addElement: (chapterId: string, element: MapElement) => void;
  updateElement: (chapterId: string, elementId: string, changes: Partial<MapElement>) => void;
  deleteElement: (chapterId: string, elementId: string) => void;
  addElements: (chapterId: string, elements: MapElement[]) => void;

    // Overlay 操作
    addOverlay: (chapterId: string, overlay: OverlayItem) => void;
    updateOverlay: (chapterId: string, overlayId: string, changes: Partial<OverlayItem>) => void;
    deleteOverlay: (chapterId: string, overlayId: string) => void;

  // 特效窗口：天气/画面特效层操作
    addScreenFx: (chapterId: string, fx: ScreenFxItem) => void;
    updateScreenFx: (chapterId: string, fxId: string, changes: Partial<ScreenFxItem>) => void;
    removeScreenFx: (chapterId: string, fxId: string) => void;

    // 字幕/配音轨道
    setNarrationStyle: (chapterId: string, patch: Partial<NarrationStyle>) => void;
    setNarrationEntries: (chapterId: string, entries: NarrationEntry[]) => void;
    updateNarrationEntry: (chapterId: string, entryId: string, patch: Partial<NarrationEntry>) => void;

    // 背景音乐
    setMusicTracks: (chapterId: string, tracks: MusicTrack[]) => void;
    updateMusicTrack: (chapterId: string, trackId: string, patch: Partial<MusicTrack>) => void;

  // 相机操作
  setChapterCamera: (chapterId: string, camera: CameraKeyframe[]) => void;

  // 转场操作
  setChapterTransition: (chapterId: string, transition: TransitionConfig | undefined) => void;

  // 特效操作
  addChapterEffect: (chapterId: string, effect: ChapterEffect) => void;
  removeChapterEffect: (chapterId: string, effectIndex: number) => void;

  // 底图操作
  setActiveBaseMap: (id: string) => void;
  addBaseMap: (baseMap: BaseMapConfig) => void;
  removeBaseMap: (id: string) => void;

  // 高程图操作
  setActiveElevationMap: (id: string | null) => void;
  addElevationMap: (e: ElevationMapConfig) => void;
  // 自定义符号
  addCustomSymbol: (symbol: CustomSymbol) => void;
  removeCustomSymbol: (id: string) => void;

  // 全局配置（如 3D 球体投影开关）
  updateGlobalConfig: (changes: Partial<GlobalConfig>) => void;

  // 导入导出
  importProjectConfig: (data: ProjectExport) => void;
  createExport: () => ProjectExport;
  clear: () => void;

  // 撤回/重做
  undo: () => void;
  redo: () => void;
}

// ========== Store 实现 ==========

export const useProjectStore = create<ProjectState>()((set, get) => {
  /** 把当前项目压入历史栈（拖拽期间和 700ms 内的连续操作不计入） */
  const commit = () => {
    if (historyMuted) return;
    const now = Date.now();
    if (now - lastHistoryTime < HISTORY_THROTTLE_MS) return;
    lastHistoryTime = now;
    const { project, history } = get();
    if (!project) return;
    const next = [...history, project];
    if (next.length > HISTORY_LIMIT) next.shift();
    set({ history: next, future: [] });
  };

  return {
    project: null,
    history: [],
    future: [],

    // ----- 项目 -----
    createProject: (name: string) => {
      const project: MapVideoProject = {
        id: generateId(), name, createdAt: new Date(), updatedAt: new Date(),
        globalConfig: { ...DEFAULT_GLOBAL_CONFIG },
        chapters: [createDefaultChapter(0, 0, DEFAULT_GLOBAL_CONFIG.defaultDuration)],
        baseMaps: [...DEFAULT_BASE_MAPS],
        activeBaseMapId: 'osm',
        elevationMaps: [...DEFAULT_ELEVATION_MAPS],
        activeElevationMapId: 'none',
        customSymbols: [],
      };
      set({ project, history: [], future: [] });
      storage.saveProject(project);
      markProjectSaved(project);
    },

    loadProject: async (id: string) => {
      const project = await storage.getProject(id);
      if (project) {
        const normalized = { ...project, chapters: normalizeChapters(project.chapters) };
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

    // ----- 章节 -----
    addChapter: (title?: string) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        const last = state.project.chapters[state.project.chapters.length - 1];
        const idx = state.project.chapters.length;
        const newCh = createDefaultChapter(idx, last ? last.endFrame : 0, state.project.globalConfig.defaultDuration);
        if (title) newCh.title = title;
        return { project: { ...state.project, chapters: [...state.project.chapters, newCh] } };
      });
    },

    updateChapter: (id: string, changes: Partial<Chapter>) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        const chapters = state.project.chapters.map((ch) => ch.id === id ? { ...ch, ...changes } : ch);
        return { project: { ...state.project, chapters } };
      });
    },

    deleteChapter: (id: string) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        return { project: { ...state.project, chapters: state.project.chapters.filter((c) => c.id !== id) } };
      });
    },

    reorderChapters: (chapters: Chapter[]) => {
      commit();
      set((state) => state.project ? { project: { ...state.project, chapters } } : state);
    },

    duplicateChapter: (id: string) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        const idx = state.project.chapters.findIndex((c) => c.id === id);
        const src = state.project.chapters[idx];
        if (!src) return state;
        const dur = src.endFrame - src.startFrame;
        const clone: Chapter = JSON.parse(JSON.stringify(src));
        clone.id = generateId();
        clone.title = `${src.title} 副本`;
        clone.startFrame = src.endFrame;
        clone.endFrame = src.endFrame + dur;
        clone.elements.forEach((e) => { (e as any).id = generateId(); });
        clone.overlays.forEach((o) => { o.id = generateId(); });
        clone.fx = (clone.fx || []).map((f) => ({ ...f, id: generateId() }));
        const chapters = [...state.project.chapters];
        chapters.splice(idx + 1, 0, clone);
        // 顺移后续章节，腾出时间轴空间
        for (let i = idx + 2; i < chapters.length; i++) {
          const c: Chapter = JSON.parse(JSON.stringify(chapters[i]));
          c.startFrame += dur; c.endFrame += dur;
          c.elements.forEach((e) => { e.startFrame += dur; e.endFrame += dur; });
          if (c.camera) c.camera = c.camera.map((k) => ({ ...k, frame: k.frame + dur }));
          c.overlays.forEach((o) => { o.startFrame += dur; o.endFrame += dur; });
          if (c.fx) c.fx = c.fx.map((f) => ({ ...f, startFrame: f.startFrame + dur, endFrame: f.endFrame + dur }));
          chapters[i] = c;
        }
        return { project: { ...state.project, chapters } };
      });
    },

    // ----- 元素 -----
    addElement: (chapterId: string, element: MapElement) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        const chapters = state.project.chapters.map((ch) =>
          ch.id === chapterId ? { ...ch, elements: [...ch.elements, element] } : ch
        );
        return { project: { ...state.project, chapters } };
      });
    },

    addElements: (chapterId: string, elements: MapElement[]) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        const chapters = state.project.chapters.map((ch) =>
          ch.id === chapterId ? { ...ch, elements: [...ch.elements, ...elements] } : ch
        );
        return { project: { ...state.project, chapters } };
      });
    },

    updateElement: (chapterId: string, elementId: string, changes: Partial<MapElement>) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        const chapters = state.project.chapters.map((ch) =>
          ch.id === chapterId
            ? {
                ...ch,
                elements: ch.elements.map((el) =>
                  el.id === elementId ? { ...el, ...changes } as MapElement : el
                ),
              }
            : ch
        );
        return { project: { ...state.project, chapters } };
      });
    },

    deleteElement: (chapterId: string, elementId: string) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        const chapters = state.project.chapters.map((ch) =>
          ch.id === chapterId
            ? { ...ch, elements: ch.elements.filter((el) => el.id !== elementId) }
            : ch
        );
        return { project: { ...state.project, chapters } };
      });
    },

    // ----- Overlay -----
    addOverlay: (chapterId: string, overlay: OverlayItem) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        const chapters = state.project.chapters.map((ch) =>
          ch.id === chapterId ? { ...ch, overlays: [...ch.overlays, overlay] } : ch
        );
        return { project: { ...state.project, chapters } };
      });
    },

    updateOverlay: (chapterId: string, overlayId: string, changes: Partial<OverlayItem>) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        const chapters = state.project.chapters.map((ch) =>
          ch.id === chapterId
            ? { ...ch, overlays: ch.overlays.map((o) => o.id === overlayId ? { ...o, ...changes } as OverlayItem : o) }
            : ch
        );
        return { project: { ...state.project, chapters } };
      });
    },

    deleteOverlay: (chapterId: string, overlayId: string) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        const chapters = state.project.chapters.map((ch) =>
          ch.id === chapterId ? { ...ch, overlays: ch.overlays.filter((o) => o.id !== overlayId) } : ch
        );
        return { project: { ...state.project, chapters } };
      });
    },

    // ----- 字幕/配音轨道 -----
    setNarrationStyle: (chapterId: string, patch: Partial<NarrationStyle>) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        const chapters = state.project.chapters.map((ch) =>
          ch.id === chapterId
            ? { ...ch, narration: { ...normalizeNarrationTrack(ch.narration), style: { ...normalizeNarrationTrack(ch.narration).style, ...patch } } }
            : ch
        );
        return { project: { ...state.project, chapters } };
      });
    },

    setNarrationEntries: (chapterId: string, entries: NarrationEntry[]) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        const chapters = state.project.chapters.map((ch) =>
          ch.id === chapterId ? { ...ch, narration: { ...normalizeNarrationTrack(ch.narration), entries } } : ch
        );
        return { project: { ...state.project, chapters } };
      });
    },

    updateNarrationEntry: (chapterId: string, entryId: string, patch: Partial<NarrationEntry>) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        const chapters = state.project.chapters.map((ch) => {
          if (ch.id !== chapterId) return ch;
          const cur = normalizeNarrationTrack(ch.narration);
          return {
            ...ch,
            narration: { ...cur, entries: cur.entries.map((e) => (e.id === entryId ? { ...e, ...patch } as NarrationEntry : e)) },
          };
        });
        return { project: { ...state.project, chapters } };
      });
    },

    // ----- 背景音乐 -----
    setMusicTracks: (chapterId: string, tracks: MusicTrack[]) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        const chapters = state.project.chapters.map((ch) =>
          ch.id === chapterId ? { ...ch, music: tracks } : ch
        );
        return { project: { ...state.project, chapters } };
      });
    },

    updateMusicTrack: (chapterId: string, trackId: string, patch: Partial<MusicTrack>) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        const chapters = state.project.chapters.map((ch) =>
          ch.id === chapterId
            ? { ...ch, music: (ch.music || []).map((m) => (m.id === trackId ? { ...m, ...patch } : m)) }
            : ch
        );
        return { project: { ...state.project, chapters } };
      });
    },
    // ----- 特效窗口：天气/画面特效层 -----
    addScreenFx: (chapterId: string, fx: ScreenFxItem) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        const chapters = state.project.chapters.map((ch) =>
          ch.id === chapterId ? { ...ch, fx: [...(ch.fx || []), fx] } : ch
        );
        return { project: { ...state.project, chapters } };
      });
    },

    updateScreenFx: (chapterId: string, fxId: string, changes: Partial<ScreenFxItem>) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        const chapters = state.project.chapters.map((ch) =>
          ch.id === chapterId
            ? { ...ch, fx: (ch.fx || []).map((f) => f.id === fxId ? { ...f, ...changes } as ScreenFxItem : f) }
            : ch
        );
        return { project: { ...state.project, chapters } };
      });
    },

    removeScreenFx: (chapterId: string, fxId: string) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        const chapters = state.project.chapters.map((ch) =>
          ch.id === chapterId ? { ...ch, fx: (ch.fx || []).filter((f) => f.id !== fxId) } : ch
        );
        return { project: { ...state.project, chapters } };
      });
    },

    setChapterCamera: (chapterId: string, camera: CameraKeyframe[]) => {
      commit();
      set((state) => state.project
        ? { project: { ...state.project, chapters: state.project.chapters.map((c) => c.id === chapterId ? { ...c, camera } : c) } }
        : state);
    },

    setChapterTransition: (chapterId: string, transition: TransitionConfig | undefined) => {
      commit();
      set((state) => state.project
        ? { project: { ...state.project, chapters: state.project.chapters.map((c) => c.id === chapterId ? { ...c, transition } : c) } }
        : state);
    },

    addChapterEffect: (chapterId: string, effect: ChapterEffect) => {
      commit();
      set((state) => state.project
        ? { project: { ...state.project, chapters: state.project.chapters.map((c) => c.id === chapterId ? { ...c, effects: [...c.effects, effect] } : c) } }
        : state);
    },

    removeChapterEffect: (chapterId: string, effectIndex: number) => {
      commit();
      set((state) => state.project
        ? { project: { ...state.project, chapters: state.project.chapters.map((c) => c.id === chapterId ? { ...c, effects: c.effects.filter((_, i) => i !== effectIndex) } : c) } }
        : state);
    },

    setActiveBaseMap: (id: string) => {
      commit();
      set((state) => state.project ? { project: { ...state.project, activeBaseMapId: id } } : state);
    },

    addBaseMap: (baseMap: BaseMapConfig) => {
      commit();
      set((state) => state.project ? { project: { ...state.project, baseMaps: [...state.project.baseMaps, baseMap] } } : state);
    },

    removeBaseMap: (id: string) => {
      commit();
      set((state) => state.project
        ? {
            project: {
              ...state.project,
              baseMaps: state.project.baseMaps.filter((b) => b.id !== id),
              activeBaseMapId: state.project.activeBaseMapId === id ? 'osm' : state.project.activeBaseMapId,
            },
          }
        : state);
    },

    setActiveElevationMap: (id: string | null) => {
      commit();
      set((state) => state.project ? { project: { ...state.project, activeElevationMapId: id } } : state);
    },

    addElevationMap: (e: ElevationMapConfig) => {
      commit();
      set((state) => state.project ? { project: { ...state.project, elevationMaps: [...state.project.elevationMaps, e] } } : state);
    },

    addCustomSymbol: (symbol: CustomSymbol) => {
      commit();
      set((state) => state.project ? { project: { ...state.project, customSymbols: [...state.project.customSymbols, symbol] } } : state);
    },

    removeCustomSymbol: (id: string) => {
      commit();
      set((state) => state.project
        ? { project: { ...state.project, customSymbols: state.project.customSymbols.filter((s) => s.id !== id) } }
        : state);
    },

    updateGlobalConfig: (changes: Partial<GlobalConfig>) => {
      commit();
      set((state) => state.project
        ? { project: { ...state.project, globalConfig: { ...state.project.globalConfig, ...changes } } }
        : state);
    },

    importProjectConfig: (data: ProjectExport) => {
      const project = {
        ...data.project,
        id: generateId(),
        updatedAt: new Date(),
        chapters: normalizeChapters(data.project.chapters),
      };
      set({ project, history: [], future: [] });
      storage.saveProject(project);
      markProjectSaved(project);
    },

    createExport: () => {
      const { project } = get();
      return { version: 1, exportedAt: new Date(), project: project! };
    },

    clear: () => set({ project: null, history: [], future: [] }),

    // ----- 撤回/重做 -----
    undo: () => {
      const { history, project, future } = get();
      if (history.length === 0 || !project) return;
      const prev = history[history.length - 1];
      const newHistory = history.slice(0, -1);
      set({
        project: prev,
        history: newHistory,
        future: [...future, project],
      });
    },

    redo: () => {
      const { history, project, future } = get();
      if (future.length === 0 || !project) return;
      const next = future[future.length - 1];
      const newFuture = future.slice(0, -1);
      set({
        project: next,
        history: [...history, project],
        future: newFuture,
      });
    },
  };
});
