import { create } from 'zustand';
import type { LayerType, MapVideoProject } from '../types';
import type { TargetLayers } from '../lib/layers';

export type FxTab = 'weather' | 'screen' | 'popup' | 'music';

interface EditorState {
  currentFrame: number;
  isPlaying: boolean;
  selectedElementId: string | null;
  /**
   * 选中的图层 = 地图上的「可编辑层」：只有它的元素在地图上有激活态编辑效果
   * （可点选 / 可拖 / 顶点 / 高亮）。为 null 时全部图层可编辑。
   * 同时 Del 键优先删选中元素、无选中元素时删整层。
   */
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

  /** 演示模式：隐藏全部编辑界面 + 全屏播放（PPT 式），F5 进出 / Esc 退出 */
  presenting: boolean;
  setPresenting: (on: boolean) => void;

  /**
   * 「字幕生成」弹窗开关：顶栏按钮与时间线「🎙 配音」块共用同一个入口
   * （字幕条目与样式的唯一编辑处，特效弹窗里已无字幕页签）。
   */
  subtitleOpen: boolean;
  setSubtitleOpen: (on: boolean) => void;

  /**
   * 每类图层的「写入目标」：新建 / 改类型的元素进哪个图层（见 resolveTargetLayerId）。
   * 点选图层行即设为该层类型的目标；未设置的类型走「该类第一个图层」。
   */
  targetLayers: TargetLayers;
  setTargetLayer: (type: LayerType, layerId: string | null) => void;
  /** 芯片当前展示哪一类的目标（随激活的工具与点选的图层切换） */
  activeLayerType: LayerType;
  setActiveLayerType: (type: LayerType) => void;

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
  /** 预览播放倍速（1–5）：只影响编辑器/演示的播放头推进，不影响导出（导出逐帧渲染） */
  playRate: number;
  setPlayRate: (rate: number) => void;
  selectElement: (id: string | null) => void;
  /** 选中图层 = 该图层成为地图上的「可编辑层」；选元素不会取消它（见 selectedLayerId 注释） */
  selectLayer: (id: string | null, type?: LayerType) => void;
  /** 只把某层设为「可编辑层」，不动「写入目标」（点中元素时随宿主层收口用） */
  focusLayer: (id: string | null) => void;
  /** 切项目 / 新建项目时清掉所有指向旧项目对象的选中态 */
  resetSelection: () => void;
  /** 撤销 / 重做换掉整份快照后，按新快照丢掉指向已消失对象的选中 id */
  pruneSelectionTo: (project: MapVideoProject | null) => void;
  setPanelMode: (mode: 'element' | 'keyframe' | 'fx' | 'none') => void;
  /** 选中镜头关键帧（进入右侧视角属性面板） */
  selectKeyframe: (idx: number | null) => void;
  setCurrentCamera: (cam: { center: [number, number]; zoom: number; pitch: number; bearing: number }) => void;
  seekCamera: (cam: { center: [number, number]; zoom: number; pitch: number; bearing: number }, easing?: string, duration?: number) => void;
}

export const useEditorStore = create<EditorState>()((set) => ({
  currentFrame: 0,
  isPlaying: false,
  playRate: 1,
  setPlayRate: (rate) => set({ playRate: Math.min(5, Math.max(1, rate)) }),
  selectedElementId: null,
  selectedLayerId: null,
  panelMode: 'element',
  selectedKeyframeIdx: null,
  currentCamera: { center: [104.0, 35.0], zoom: 4, pitch: 0, bearing: 0 },
  cameraSeek: null,

  setCurrentFrame: (frame) => set({ currentFrame: frame }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  // 选元素**不再**清掉 selectedLayerId：图层选中态就是地图的「可编辑层」门禁，
  // 点中该层里的元素不该让它自己失效（否则「点一下元素这层就不可编辑了」）。
  selectElement: (id) => set({ selectedElementId: id, panelMode: 'element' }),
  // 点选图层 = 同时把它设为该类型的「写入目标」（选中即写入，与 Figma 选容器一致）
  selectLayer: (id, type) => set((s) => {
    if (!id || !type) return { selectedLayerId: id };
    return { selectedLayerId: id, activeLayerType: type, targetLayers: { ...s.targetLayers, [type]: id } };
  }),
  focusLayer: (id) => set({ selectedLayerId: id }),
  // 选中态存的是**项目内对象的 id**，换项目后全部指向不存在的东西（元素面板高亮、
  // 时间线选中块、属性面板都会跟着错位），所以随项目切换一并清掉。
  resetSelection: () => set({
    selectedElementId: null, selectedLayerId: null, selectedKeyframeIdx: null,
    fxSelId: null, panelMode: 'element',
  }),
  // 撤销 / 重做只是换掉 project 引用（不经 patch，也就不会走上面那条「换项目才清」的路），
  // 但选中 id 可能正指向上一次编辑里刚被删掉的元素 / 图层 / 关键帧：属性面板拿空 id 去
  // find、时间线高亮错位、Del 打到不存在的东西。按新快照逐个校验，没了就清。
  pruneSelectionTo: (project) => set((s) => {
    const alive = (list: { id: string }[] | undefined, id: string | null) =>
      id !== null && !!list?.some((x) => x.id === id);
    const out: Partial<EditorState> = {};
    if (!alive(project?.elements, s.selectedElementId)) out.selectedElementId = null;
    if (!alive(project?.layers, s.selectedLayerId)) out.selectedLayerId = null;
    if (!alive(project?.fx, s.fxSelId) && !alive(project?.overlays, s.fxSelId)) out.fxSelId = null;
    if (s.selectedKeyframeIdx != null && s.selectedKeyframeIdx >= (project?.camera.length ?? 0)) {
      out.selectedKeyframeIdx = null;
      if (s.panelMode === 'keyframe') out.panelMode = 'none';
    }
    return out;
  }),
  setPanelMode: (mode) => set({ panelMode: mode }),
  selectKeyframe: (idx) => set({ selectedKeyframeIdx: idx, panelMode: idx !== null ? 'keyframe' : 'none' }),
  setCurrentCamera: (cam) => set({ currentCamera: cam }),
  seekCamera: (cam, easing, duration) => set({ cameraSeek: { cam, easing, duration, ts: Date.now() } }),
  elementsOpen: false,
  setElementsOpen: (open) => set({ elementsOpen: open }),

  presenting: false,
  setPresenting: (on) => set({ presenting: on }),

  subtitleOpen: false,
  setSubtitleOpen: (on) => set({ subtitleOpen: on }),

  targetLayers: {},
  setTargetLayer: (type, layerId) => set((s) => {
    const next: TargetLayers = { ...s.targetLayers };
    if (layerId) next[type] = layerId; else delete next[type];
    return { targetLayers: next };
  }),
  activeLayerType: 'marker',
  setActiveLayerType: (type) => set({ activeLayerType: type }),

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
