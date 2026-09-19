import { create } from 'zustand';

export type FxTab = 'weather' | 'screen' | 'popup' | 'subtitle' | 'music';

interface EditorState {
  currentFrame: number;
  isPlaying: boolean;
  selectedElementId: string | null;
  /** 选中的图层 id（时间线图层块 / 图层面板行点击选中）；Del 优先删图层 */
  selectedLayerId: string | null;

  // 右侧面板模式：元素属性 / 镜头关键帧属性 / 特效 / 无面板
  panelMode: 'element' | 'keyframe' | 'fx' | 'none';
  // 视角属性面板选中的镜头关键帧序号（进入关键帧属性面板）
  selectedKeyframeIdx: number | null;

  // 当前地图视角（用于新增镜关键帧时的默认值）
  currentCamera: { center: [number, number]; zoom: number; pitch: number; bearing: number };

  // 镜头跳转指令：EditableMap 监听到后按关键帧缓动/时长动画到指定视角
  cameraSeek: { cam: { center: [number, number]; zoom: number; pitch: number; bearing: number }; easing?: string; duration?: number; ts: number } | null;

  // 左侧浮动元素面板开合（对齐 Mapimator Layers，默认收起）
  elementsOpen: boolean;
  setElementsOpen: (open: boolean) => void;

  // 特效（天气/画面/弹窗/标题）：在右侧面板编辑；单次只编辑一个特效项（fxSelId）
  fxTab: FxTab;
  /** 当前正在编辑的特效项 id（weather/screen/popup 项；title 无需） */
  fxSelId: string | null;
  openFx: (tab?: FxTab, selId?: string | null) => void;
  setFxTab: (tab: FxTab) => void;
  setFxSelId: (id: string | null) => void;

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
  selectLayer: (id: string | null) => void;
  setPanelMode: (mode: 'element' | 'keyframe' | 'fx' | 'none') => void;
  /** 选中镜头关键帧（进入右侧视角属性面板） */
  selectKeyframe: (idx: number | null) => void;
  setCurrentCamera: (cam: { center: [number, number]; zoom: number; pitch: number; bearing: number }) => void;
  seekCamera: (cam: { center: [number, number]; zoom: number; pitch: number; bearing: number }, easing?: string, duration?: number) => void;
}

export const useEditorStore = create<EditorState>()((set) => ({
  currentFrame: 0,
  isPlaying: false,
  selectedElementId: null,
  selectedLayerId: null,
  panelMode: 'element',
  selectedKeyframeIdx: null,
  currentCamera: { center: [104.0, 35.0], zoom: 4, pitch: 0, bearing: 0 },
  cameraSeek: null,

  setCurrentFrame: (frame) => set({ currentFrame: frame }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  selectElement: (id) => set({ selectedElementId: id, selectedLayerId: null, panelMode: 'element' }),
  selectLayer: (id) => set({ selectedLayerId: id }),
  setPanelMode: (mode) => set({ panelMode: mode }),
  selectKeyframe: (idx) => set({ selectedKeyframeIdx: idx, panelMode: idx !== null ? 'keyframe' : 'none' }),
  setCurrentCamera: (cam) => set({ currentCamera: cam }),
  seekCamera: (cam, easing, duration) => set({ cameraSeek: { cam, easing, duration, ts: Date.now() } }),
  elementsOpen: false,
  setElementsOpen: (open) => set({ elementsOpen: open }),

  fxTab: 'popup',
  fxSelId: null,
  openFx: (tab, selId) => set((s) => ({
    panelMode: 'fx',
    fxTab: tab || s.fxTab,
    fxSelId: selId !== undefined ? selId : s.fxSelId,
  })),
  setFxTab: (tab) => set({ fxTab: tab }),
  setFxSelId: (id) => set({ fxSelId: id }),
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

// 调试便捷入口（生产无副作用）：自动化脚本直控播放头/读取选中
if (typeof window !== 'undefined') (window as any).__editorStore = useEditorStore;
