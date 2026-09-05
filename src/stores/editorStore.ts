import { create } from 'zustand';

export type ChapterTab = 'transition' | 'overlay' | 'effects';

interface EditorState {
  currentFrame: number;
  isPlaying: boolean;
  selectedElementId: string | null;
  selectedChapterId: string | null;

  // 右侧面板模式：元素属性 / 章节全局设置 / 镜头关键帧属性
  panelMode: 'element' | 'chapter' | 'keyframe';
  // 章节全局设置下的子标签
  chapterTab: ChapterTab;
  // 底部 Storyboard 选中的镜头关键帧序号（进入关键帧属性面板）
  selectedKeyframeIdx: number | null;

  // 当前地图视角（用于新增镜关键帧时的默认值）
  currentCamera: { center: [number, number]; zoom: number; pitch: number; bearing: number };

  // 镜头跳转指令：EditableMap 监听到后按关键帧缓动/时长动画到指定视角
  cameraSeek: { cam: { center: [number, number]; zoom: number; pitch: number; bearing: number }; easing?: string; duration?: number; ts: number } | null;

  // 左侧浮动元素面板开合（对齐 Mapimator Layers，默认收起）
  elementsOpen: boolean;
  setElementsOpen: (open: boolean) => void;

  // 路线路径点编辑模式：none / add（添加点）/ del（删除点）
  routeEdit: 'none' | 'add' | 'del';
  setRouteEdit: (m: 'none' | 'add' | 'del') => void;

  // 疆域：当前顶点编辑的地块 / 兼并工具点选的地块集合
  terrPlotId: string | null;
  setTerrPlotId: (id: string | null) => void;
  terrSelPlots: string[];
  toggleTerrSelPlot: (id: string) => void;
  setTerrSelPlots: (ids: string[]) => void;

  // 属性面板界面语言（顶栏最右切换）：zh=中文 / en=English
  lang: 'zh' | 'en';
  setLang: (l: 'zh' | 'en') => void;

  setCurrentFrame: (frame: number) => void;
  setIsPlaying: (playing: boolean) => void;
  selectElement: (id: string | null) => void;
  selectChapter: (id: string | null) => void;
  setPanelMode: (mode: 'element' | 'chapter' | 'keyframe') => void;
  setChapterTab: (tab: ChapterTab) => void;
  /** 选中镜头关键帧（进入右侧视角属性面板） */
  selectKeyframe: (idx: number | null) => void;
  setCurrentCamera: (cam: { center: [number, number]; zoom: number; pitch: number; bearing: number }) => void;
  seekCamera: (cam: { center: [number, number]; zoom: number; pitch: number; bearing: number }, easing?: string, duration?: number) => void;
}

export const useEditorStore = create<EditorState>()((set) => ({
  currentFrame: 0,
  isPlaying: false,
  selectedElementId: null,
  selectedChapterId: null,
  panelMode: 'element',
  chapterTab: 'transition',
  selectedKeyframeIdx: null,
  currentCamera: { center: [104.0, 35.0], zoom: 4, pitch: 0, bearing: 0 },
  cameraSeek: null,

  setCurrentFrame: (frame) => set({ currentFrame: frame }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  selectElement: (id) => set({ selectedElementId: id, panelMode: 'element' }),
  selectChapter: (id) => set({ selectedChapterId: id }),
  setPanelMode: (mode) => set({ panelMode: mode }),
  setChapterTab: (tab) => set({ chapterTab: tab }),
  selectKeyframe: (idx) => set({ selectedKeyframeIdx: idx, panelMode: idx !== null ? 'keyframe' : 'chapter' }),
  setCurrentCamera: (cam) => set({ currentCamera: cam }),
  seekCamera: (cam, easing, duration) => set({ cameraSeek: { cam, easing, duration, ts: Date.now() } }),
  elementsOpen: false,
  setElementsOpen: (open) => set({ elementsOpen: open }),
  lang: 'zh',
  setLang: (l) => set({ lang: l }),
  routeEdit: 'none',
  setRouteEdit: (m) => set({ routeEdit: m }),
  terrPlotId: null,
  setTerrPlotId: (id) => set({ terrPlotId: id }),
  terrSelPlots: [],
  toggleTerrSelPlot: (id) => set((s) => ({
    terrSelPlots: s.terrSelPlots.includes(id)
      ? s.terrSelPlots.filter((x) => x !== id)
      : [...s.terrSelPlots, id],
  })),
  setTerrSelPlots: (ids) => set({ terrSelPlots: ids }),
}));
