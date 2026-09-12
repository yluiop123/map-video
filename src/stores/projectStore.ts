import { create } from 'zustand';
import { storage } from '../lib/storage';
import type {
  MapVideoProject, Chapter, MapElement, GlobalConfig, BaseMapConfig,
  ElevationMapConfig, OverlayItem, CameraKeyframe, TransitionConfig,
  ProjectExport, ScreenFxItem, ExportedAsset,
  NarrationEntry, NarrationStyle, MusicTrack, ConnectorElement
} from '../types';
import { generateId, DEFAULT_COLLECTION_ID, normalizeOverlayContent, normalizeTitleStyle, normalizeNarrationTrack, defaultNarrationStyle } from '../types';
import { normalizeTerritoryDisplay } from '../lib/territory';
import { releaseAssetUrls, getAssetBytes, uploadAsset, type AssetKind } from '../lib/assets';
import { clearGifCache } from '../lib/gif-decoder';

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

/** 新建章节时从项目级默认值继承的「底图 / 高程 / 投影」 */
interface ChapterVisualDefaults {
  projection?: Chapter['projection'];
  baseMapId?: string;
  elevationMapId?: string | null;
}

function createDefaultChapter(
  index = 0,
  startFrame = 0,
  duration = 3000,
  defaults: ChapterVisualDefaults = {},
): Chapter {
  const titles = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  return {
    id: generateId(),
    title: `第${titles[Math.min(index, titles.length - 1)]}章`,
    order: index,
    // 底图 / 高程 / 投影按章节绑定，初始值继承项目默认
    projection: defaults.projection,
    baseMapId: defaults.baseMapId,
    elevationMapId: defaults.elevationMapId,
    startFrame,
    endFrame: startFrame + duration,
    elements: [],
    camera: [{ frame: startFrame, center: [104.0, 35.0], zoom: 4 }],
    overlays: [],
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

/**
 * 脏标记基准：保存时记下**引用**。
 * 项目走不可变更新（每次 set 都产生新对象），引用比较即 O(1) 判脏；
 * 旧实现每次 isProjectDirty 都 JSON.stringify 整个项目（面板每敲一个字符都全量序列化）。
 */
let savedProjectRef: MapVideoProject | null = null;
function markProjectSaved(p: MapVideoProject) { savedProjectRef = p; }
/** 项目是否有未保存修改（内存 vs 最近一次落盘态） */
export function isProjectDirty(p: MapVideoProject | null): boolean {
  if (!p) return false;
  return p !== savedProjectRef;
}

/** 立即压一次历史（不受拖拽静音影响），用于拖拽开始前快照 */
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

  // 底图操作
  setActiveBaseMap: (id: string) => void;
  addBaseMap: (baseMap: BaseMapConfig) => void;
  removeBaseMap: (id: string) => void;

  // 高程图操作
  setActiveElevationMap: (id: string | null) => void;
  addElevationMap: (e: ElevationMapConfig) => void;
  /** 更新某条高程图配置（如调节地形夸张系数） */
  updateElevationMap: (id: string, patch: Partial<ElevationMapConfig>) => void;

  // 全局配置（如 3D 球体投影开关）
  updateGlobalConfig: (changes: Partial<GlobalConfig>) => void;

  // 导入导出
  importProjectConfig: (data: ProjectExport, collectionId?: string) => Promise<void>;
  /** 导出项目配置（含素材字节，自包含）；无项目时抛错 */
  createExport: () => Promise<ProjectExport>;
  clear: () => void;

  // 撤回/重做
  undo: () => void;
  redo: () => void;
}

/** 导入的素材字节 → 素材类别（按 mime 推断；导出侧只收集图片 / GIF / 模型） */
function mimeToAssetKind(mime: string): AssetKind {
  return mime === 'image/gif' ? 'gif'
    : mime.startsWith('model/') ? 'model'
      : mime.startsWith('image/') ? 'image' : 'icon';
}

/** 导入后把项目里所有 assetId 旧引用换成新 id（素材 id 已改为随机，不再内容寻址） */
function remapAssetIds(project: MapVideoProject, map: Record<string, string>): MapVideoProject {
  if (!Object.keys(map).length) return project;
  return {
    ...project,
    chapters: project.chapters.map((ch) => ({
      ...ch,
      elements: ch.elements.map((el) => {
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
    })),
  };
}

// ========== Store 实现 ==========

export const useProjectStore = create<ProjectState>()((set, get) => {
  /**
   * 把当前项目压入历史栈。
   * 历史存的是**引用**（项目不可变更新，旧引用永不变化），零拷贝成本，
   * 因此**不做时间节流** —— 节流会吞掉 700ms 窗口内第二次独立操作的快照，
   * 造成一次 undo 连带回退两步。输入粒度由控件「失焦/回车才提交」保证。
   */
  const commit = () => {
    if (historyMuted) return;
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
    createProject: async (name: string, collectionId?: string) => {
      const project: MapVideoProject = {
        id: generateId(), name, collectionId: collectionId || DEFAULT_COLLECTION_ID,
        createdAt: new Date(), updatedAt: new Date(),
        globalConfig: { ...DEFAULT_GLOBAL_CONFIG },
        chapters: [createDefaultChapter(0, 0, DEFAULT_GLOBAL_CONFIG.defaultDuration, {
          projection: DEFAULT_GLOBAL_CONFIG.projection,
          baseMapId: 'osm',
          elevationMapId: 'none',
        })],
        baseMaps: [...DEFAULT_BASE_MAPS],
        activeBaseMapId: 'osm',
        elevationMaps: [...DEFAULT_ELEVATION_MAPS],
        activeElevationMapId: 'none',
      };
      set({ project, history: [], future: [] });
      await storage.saveProject(project);
      markProjectSaved(project);
    },

    loadProject: async (id: string) => {
      // 切项目：释放上一项目的素材 objectURL 与解码缓存（这些缓存只增不减，不清会长会话内存持续上涨）
      releaseAssetUrls();
      clearGifCache();
      (await import('../lib/map-renderer')).clearRenderCaches();
      (await import('../lib/model-renderer')).clearModelCaches();
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
        // 底图 / 高程 / 投影按章节绑定：新章节继承项目级默认值作为初始值
        const newCh = createDefaultChapter(
          idx,
          last ? last.endFrame : 0,
          state.project.globalConfig.defaultDuration,
          {
            projection: state.project.globalConfig.projection,
            baseMapId: state.project.activeBaseMapId,
            elevationMapId: state.project.activeElevationMapId,
          },
        );
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

    /**
     * 删除元素 —— 必须一并清理引用它的弱引用。
     * 数据库层既无外键也无触发器（见 AGENTS.md），这两处引用只能由写入端清理，否则留下悬空引用：
     *   1) 以该元素为端点的连接线（connector）：整条移除
     *   2) 跟随机位指向该元素的视角关键帧：退化为固定镜头（等价于外键的 SET NULL）
     */
    deleteElement: (chapterId: string, elementId: string) => {
      commit();
      set((state) => {
        if (!state.project) return state;
        const chapters = state.project.chapters.map((ch) => {
          if (ch.id !== chapterId) return ch;
          const elements = ch.elements.filter((el) => {
            if (el.id === elementId) return false;
            if (el.type === 'connector') {
              const c = el as ConnectorElement;
              return c.fromElementId !== elementId && c.toElementId !== elementId;
            }
            return true;
          });
          const camera = ch.camera?.map((kf) =>
            kf.followRoute?.routeElementId === elementId
              ? { ...kf, cameraType: 'fixed' as const, followRoute: undefined }
              : kf
          );
          return { ...ch, elements, ...(camera ? { camera } : {}) };
        });
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

    updateElevationMap: (id: string, patch: Partial<ElevationMapConfig>) => {
      commit();
      set((state) => state.project
        ? {
            project: {
              ...state.project,
              elevationMaps: state.project.elevationMaps.map((e) => (e.id === id ? { ...e, ...patch } : e)),
            },
          }
        : state);
    },

    updateGlobalConfig: (changes: Partial<GlobalConfig>) => {
      commit();
      set((state) => state.project
        ? { project: { ...state.project, globalConfig: { ...state.project.globalConfig, ...changes } } }
        : state);
    },

    importProjectConfig: async (data: ProjectExport, collectionId?: string) => {
      // 还原内嵌素材并**重映射 assetId**：素材 id 是随机的，导入后生成新 id，
      // 元素 / 图片库里的旧引用必须全部换成新 id（原内容寻址方案靠 sha256 天然同 id，已废除）
      let imported = data;
      if (data.assets?.length) {
        const idMap: Record<string, string> = {};
        for (const a of data.assets) {
          try {
            const bin = atob(a.dataUrl.split(',')[1] || '');
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const ref = await uploadAsset(new Blob([bytes], { type: a.mime }), mimeToAssetKind(a.mime));
            idMap[a.assetId] = ref.assetId;
          } catch { /* 单个素材失败不阻塞导入 */ }
        }
        imported = { ...data, project: remapAssetIds(data.project, idMap) };
      }
      const project = {
        ...imported.project,
        id: generateId(),
        collectionId: collectionId || DEFAULT_COLLECTION_ID,
        updatedAt: new Date(),
        chapters: normalizeChapters(imported.project.chapters),
      };
      set({ project, history: [], future: [] });
      await storage.saveProject(project);
      markProjectSaved(project);
    },

    createExport: async () => {
      const { project } = get();
      if (!project) throw new Error('没有可导出的项目');
      // 收集全部被引用的素材（point 元素 + 自定义图片库），内嵌为 base64 ——
      // 否则导出的 JSON 在别的机器导入时，assetId 指向的本地素材不存在，全部裂图
      const ids = new Set<string>();
      for (const ch of project.chapters) {
        for (const el of ch.elements) {
          if (el.type === 'point' && el.assetId) ids.add(el.assetId);
        }
      }
      const assets: ExportedAsset[] = [];
      for (const assetId of ids) {
        const bytes = await getAssetBytes(assetId);
        if (!bytes) continue; // 素材已缺失：跳过（导出其余，不让单个缺失阻塞整体）
        // 分块转 base64，避免超大文件一次性 String.fromCharCode 爆栈
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        const b64 = btoa(bin);
        const mime = bytes[0] === 0x89 && bytes[1] === 0x50 ? 'image/png'
          : bytes[0] === 0x47 && bytes[1] === 0x49 ? 'image/gif'
          : bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
          : bytes[0] === 0x67 && bytes[1] === 0x6c ? 'model/gltf-binary'  // "glTF"
          : 'application/octet-stream';
        assets.push({ assetId, mime, byteSize: bytes.length, dataUrl: `data:${mime};base64,${b64}` });
      }
      return { version: 1, exportedAt: new Date(), project, assets };
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
