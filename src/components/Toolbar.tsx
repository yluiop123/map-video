import { useState, useMemo } from 'react';
import {
  MapPin, Route as RouteIcon,
  Shapes, Undo2, Redo2, FolderOpen, Settings2, Download, Languages, Landmark, UserRound, Sparkles,
  Image as ImageIcon, ChevronDown, Check, Plus,
} from 'lucide-react';
import { useProjectStore, isProjectDirty } from '../stores/projectStore';
import { useEditorStore } from '../stores/editorStore';
import { useInteractionStore, type InteractionMode, type PinPlaceStyle, type RouteDrawStyle } from '../stores/interactionStore';
import { sharedMap } from '../lib/shared-map';
import { stopPreviewAudio } from '../lib/preview-audio';
import { IS_DESKTOP } from '../lib/backend';
import { uploadAsset } from '../lib/assets';
import { loadImageAspect, createGeoImageElement } from '../lib/geo-image';
import { LAYER_TYPE_LABEL } from '../lib/layers';
import type { LayerType } from '../types';
import { MapSearchBox } from './MapSearchBox';
import { TerritoryImportDialog } from './TerritoryImportDialog';
import { GenerateDialog } from './GenerateDialog';

interface ToolbarProps {
  onOpenExport: () => void;
  onOpenSettings: () => void;
}

interface ModeItem {
  mode?: InteractionMode;
  icon: React.ReactNode;
  label: string;
  zh: string;
  /** 非绘图动作 */
  action?: 'place-pin' | 'image';
}

/** 浮动工具条（对齐 Mapimator：一键直达，样式在右侧 Settings 切换） */
const TOOLS: ModeItem[] = [
  { icon: <MapPin size={15} className="text-red-400" />, label: 'Pin', zh: '标记', action: 'place-pin' },
  { icon: <RouteIcon size={15} className="text-blue-400" />, label: 'Route', zh: '路线', mode: 'add_line' },
  { icon: <Shapes size={15} className="text-orange-400" />, label: 'Shape', zh: '形状', mode: 'add_polygon' },
  { icon: <Landmark size={15} className="text-violet-400" />, label: 'Terr', zh: '疆域', mode: 'add_terr_plot' },
  { icon: <ImageIcon size={15} className="text-emerald-400" />, label: 'Image', zh: '图片', action: 'image' },
];

const ROUTE_MODES: InteractionMode[] = ['add_line', 'add_bezier', 'add_line_arc', 'add_arrow', 'add_curved', 'add_pincer'];

/** 工具按钮 → 图层类型（决定「写入图层」芯片当前展示哪一类） */
const TOOL_LAYER_TYPE: Record<string, LayerType> = {
  Pin: 'marker', Route: 'route', Shape: 'shape', Terr: 'territory', Image: 'image',
};

/** 疆域工具的模式（«疆域»按钮高亮判定） */
const TERR_MODES: InteractionMode[] = ['add_terr_plot', 'terr_annex'];

/** 形状工具的模式（«形状»按钮高亮判定） */
const SHAPE_MODES: InteractionMode[] = [
  'add_shape_line', 'add_shape_bezier', 'add_shape_line_arrow', 'add_shape_bezier_arrow',
  'add_shape_front_line', 'add_shape_front_curve',
  'add_shape_march', 'add_shape_circle', 'add_shape_star', 'add_special_swallow',
  'add_shape_swallowtail', 'add_shape_poly_curve', 'add_shape_poly_defend', 'add_shape_poly_curve_defend',
  'add_polygon', 'add_rect', 'add_gathering', 'add_pincer',
];

/** 形状分类菜单数据 */
interface ShapeItem {
  mode: InteractionMode;
  zh: string;
  en: string;
  glyph: string;
  hint?: string;
}
const SHAPE_GROUPS: { zh: string; en: string; items: ShapeItem[] }[] = [
  {
    zh: '多点绘制', en: 'Multi-point',
    items: [
      { mode: 'add_shape_line', zh: '直线', en: 'Straight Line', glyph: '─' },
      { mode: 'add_shape_bezier', zh: '曲线', en: 'Curve', glyph: '〰' },
      { mode: 'add_shape_line_arrow', zh: '带箭头直线', en: 'Arrow Line', glyph: '──▶' },
      { mode: 'add_shape_bezier_arrow', zh: '带箭头曲线', en: 'Arrow Curve', glyph: '➤' },
      { mode: 'add_shape_front_line', zh: '直线战线', en: 'Front Line', glyph: '▮─' },
      { mode: 'add_shape_front_curve', zh: '弯曲战线', en: 'Curved Front', glyph: 'ㅤ〰' },
      { mode: 'add_shape_march', zh: '行军箭头', en: 'March Arrow', glyph: '⚔️' },
      { mode: 'add_shape_swallowtail', zh: '燕尾箭头', en: 'Swallowtail', glyph: '🏹' },
      { mode: 'add_polygon', zh: '多边形', en: 'Polygon', glyph: '⬛' },
      { mode: 'add_shape_poly_curve', zh: '曲线多边', en: 'Curved Poly', glyph: '🌀' },
      { mode: 'add_shape_poly_defend', zh: '直线防御圈', en: 'Straight Defense', glyph: '▮⬛' },
      { mode: 'add_shape_poly_curve_defend', zh: '曲线防御圈', en: 'Curved Defense', glyph: '🌀⬛' },
    ],
  },
  {
    zh: '两点绘制', en: 'Two-point',
    items: [
      { mode: 'add_shape_circle', zh: '圆', en: 'Circle', glyph: '◯', hint: '不可旋转' },
      { mode: 'add_rect', zh: '矩形', en: 'Rectangle', glyph: '▭', hint: '可旋转' },
      { mode: 'add_gathering', zh: '集结点', en: 'Gathering', glyph: '⚙', hint: '可旋转' },
      { mode: 'add_shape_star', zh: '五角星', en: 'Star', glyph: '⭐', hint: '可旋转' },
    ],
  },
  {
    zh: '特殊图形', en: 'Special',
    items: [
      { mode: 'add_special_swallow', zh: '自定义燕尾箭头', en: 'Custom Swallowtail', glyph: '🏹', hint: 'attack+燕尾' },
      { mode: 'add_attack', zh: '自定义箭头', en: 'Custom Arrow', glyph: '➹', hint: 'bent attack' },
      { mode: 'add_pincer', zh: '钳形', en: 'Pincer', glyph: '🩹', hint: '4点自动合成' },
    ],
  },
];

/** 工具当前是否激活（用于高亮）；路线弹窗的样式请求会临时归属路线工具 */
function toolActive(t: ModeItem, mode: InteractionMode, routeReq: { mode: InteractionMode } | null): boolean {
  if (t.mode) {
    if (t.label === 'Route') return ROUTE_MODES.includes(mode) || routeReq?.mode === mode;
    if (t.label === 'Shape') return SHAPE_MODES.includes(mode) && routeReq?.mode !== mode;
    if (t.label === 'Terr') return TERR_MODES.includes(mode);
    return t.mode === mode;
  }
  if (t.label === 'Pin') return mode === 'add_point' || mode === 'add_flag';
  if (t.label === 'Text') return mode === 'add_text';
  return false;
}

/** 标记弹窗数据（对应标记设置的样式） */
interface PinItem { style: PinPlaceStyle; zh: string; en: string; glyph: string }
const PIN_ITEMS: PinItem[] = [
  { style: 'bubble', zh: '气泡', en: 'Bubble', glyph: '💬' },
  { style: 'flag', zh: '旗帜', en: 'Marker', glyph: '🚩' },
  { style: 'text', zh: '文字', en: 'Text', glyph: 'Aa' },
  { style: 'emoji', zh: '表情', en: 'Emoji', glyph: '😀' },
  { style: 'image', zh: '图片', en: 'Image', glyph: '🖼' },
  { style: 'gif', zh: '动图', en: 'GIF', glyph: '🎞' },
  { style: 'model', zh: '模型', en: 'Model', glyph: '🧊' },
  { style: 'icon', zh: '图标', en: 'Icon', glyph: '🔷' },
  { style: 'milsym', zh: '军标', en: 'Mil', glyph: '🎖' },
];

/** 路线弹窗数据（对应路线设置的路线类型；route 为绘制完成时套用的样式请求） */
interface RouteItem { zh: string; en: string; glyph: string; mode: InteractionMode; route?: RouteDrawStyle }
const ROUTE_ITEMS: RouteItem[] = [
  { zh: '直线', en: 'Straight', glyph: '─', mode: 'add_line' },
  { zh: '曲线', en: 'Curve', glyph: '〰', mode: 'add_bezier' },
  { zh: '带箭头直线', en: 'Arrow Line', glyph: '──▶', mode: 'add_shape_line_arrow', route: 'arrow-line' },
  { zh: '箭头曲线', en: 'Arrow Curve', glyph: '➤', mode: 'add_shape_bezier_arrow', route: 'arrow-curve' },
  { zh: '燕尾箭头', en: 'Swallowtail', glyph: '🏹', mode: 'add_curved', route: 'swallowtail' },
  { zh: '行军箭头', en: 'March Arrow', glyph: '⚔️', mode: 'add_shape_march', route: 'march' },
  { zh: '无样式直线', en: 'Plain Line', glyph: '➖', mode: 'add_line', route: 'plain-straight' },
  { zh: '无样式曲线', en: 'Plain Curve', glyph: '〰️', mode: 'add_bezier', route: 'plain-bezier' },
];

/** 疆域分类菜单数据 */
interface TerrItem { zh: string; en: string; glyph: string; hint?: string; act: 'import' | 'plot' | 'split' | 'annex' }
const TERR_ITEMS: TerrItem[] = [
  { zh: '导入疆域', en: 'Import', glyph: '📥', hint: '势力库/GeoJSON', act: 'import' },
  { zh: '绘制地块', en: 'Draw Plot', glyph: '✏️', hint: '多点闭合', act: 'plot' },
  { zh: '分割地块', en: 'Split Plot', glyph: '✂️', hint: '画线切开编辑地块', act: 'split' },
  { zh: '兼并', en: 'Annex', glyph: '⚔️', hint: '点选地块→事件', act: 'annex' },
];

/**
 * 顶部栏（对齐 Mapimator 顶栏）：
 * Logo + 项目芯片 ｜ 地名搜索 ｜ 撤销重做 · 保存 · 导出
 * 底图/高程/3D 在地图左下角 MapStyleChip。
 */
export function TopBar({ onOpenExport, onOpenSettings }: ToolbarProps) {
  const project = useProjectStore((s) => s.project);
  const saveProject = useProjectStore((s) => s.saveProject);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const historyLen = useProjectStore((s) => s.history.length);
  const futureLen = useProjectStore((s) => s.future.length);
  const lang = useEditorStore((s) => s.lang);
  const setLang = useEditorStore((s) => s.setLang);
  const genOpen = useEditorStore((s) => s.subtitleOpen);
  const setGenOpen = useEditorStore((s) => s.setSubtitleOpen);

  // 有未保存修改时保存按钮才可用
  const dirty = useMemo(() => isProjectDirty(project), [project]);

  if (!project) return null;

  const iconBtn = 'h-8 w-8 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors disabled:opacity-30 shrink-0';

  return (
    <div className="h-14 shrink-0 border-b border-white/[0.06] bg-background flex items-center gap-2 px-3 relative z-40">
      {/* Logo */}
      <div className="flex items-center gap-2 pr-1 shrink-0">
        <div className="h-7 w-7 rounded-lg bg-white/10 flex items-center justify-center">
          <MapPin size={15} className="text-foreground" />
        </div>
        <span className="font-bold text-[15px] tracking-tight">MapVideo</span>
      </div>

      {/* 项目芯片：点击回项目列表 */}
      <button
        onClick={() => {
          // 退出项目：停止播放与预览音频，避免音乐在项目列表页继续响
          useEditorStore.getState().setIsPlaying(false);
          stopPreviewAudio();
          // 自动保存有 5s 延迟，退出前补存一次，否则最后一次编辑静默丢失（应用内导航不触发 beforeunload）
          void useProjectStore.getState().saveProject().catch((err) => console.warn('[autosave] 退出前保存失败:', err));
          useProjectStore.setState({ project: null });
        }}
        className="h-9 px-3 flex items-center gap-2 rounded-lg bg-white/[0.05] border border-white/10 text-sm text-foreground/90 hover:bg-white/10 transition-colors shrink-0"
        title="项目列表"
      >
        <FolderOpen size={14} className="text-muted-foreground" />
        <span className="max-w-[160px] truncate">{project.name || '未命名项目'}</span>
      </button>

      {/* 地名/坐标搜索（跳转当前地图） */}
      <MapSearchBox getMap={() => sharedMap.get()} />

      <div className="w-px h-5 bg-white/10 mx-1 shrink-0" />

      {/* 撤销/重做 */}
      <button onClick={undo} disabled={historyLen === 0} className={iconBtn} title="撤销 (Ctrl+Z)">
        <Undo2 size={15} />
      </button>
      <button onClick={redo} disabled={futureLen === 0} className={iconBtn} title="重做 (Ctrl+Y)">
        <Redo2 size={15} />
      </button>

      {/* 保存（有未保存修改时才可点） */}
      <button
        onClick={() => { void saveProject().catch((e) => alert('保存失败：' + (e instanceof Error ? e.message : String(e)))); }}
        disabled={!dirty}
        className="h-8 px-3 flex items-center gap-1.5 rounded-md bg-white/[0.05] border border-white/15 text-xs font-medium text-amber-400/90 hover:bg-white/10 transition-colors disabled:opacity-35 disabled:cursor-not-allowed shrink-0"
        title={dirty ? '保存到浏览器' : '没有需要保存的修改'}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${dirty ? 'bg-amber-400' : 'bg-white/25'}`} />
        保存
      </button>

      {/* 设置（AI 能力：文案生成 / 语音克隆 / 图片生成） */}
      <button onClick={onOpenSettings} className={iconBtn} title="设置 · AI">
        <Settings2 size={15} />
      </button>

      {/* 字幕生成：主题 → 整片 + 字幕 + 配音（顶栏与时间线「🎙 配音」块同一入口） */}
      <button
        onClick={() => setGenOpen(true)}
        className="h-9 px-3 flex items-center gap-1.5 rounded-md border border-white/15 bg-white/[0.05] text-xs font-medium hover:bg-white/10 transition-colors shrink-0"
        title="字幕 / 配音 / 字幕样式"
      >
        <Sparkles size={14} />
        字幕生成
      </button>

      {/* 导出（弹出左侧设置按钮的导出窗口） */}
      <button
        onClick={onOpenExport}
        className="relative h-9 px-3.5 flex items-center gap-1.5 rounded-md bg-white text-black text-sm font-medium hover:bg-white/90 transition-colors shrink-0"
      >
        <Download size={14} />
        导出视频
      </button>

      {genOpen && <GenerateDialog onClose={() => setGenOpen(false)} />}

      {/* 界面语言切换（属性面板标签 中/EN） */}
      <div className="h-9 px-1 flex items-center gap-0.5 rounded-full border border-white/10 bg-white/[0.05] shrink-0" title="界面语言 / Language">
        <Languages size={13} className="text-muted-foreground mx-1" />
        <button
          onClick={() => setLang('zh')}
          className={`h-7 px-2.5 rounded-full text-xs font-medium transition-colors ${lang === 'zh' ? 'bg-white/15 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          中
        </button>
        <button
          onClick={() => setLang('en')}
          className={`h-7 px-2.5 rounded-full text-xs font-medium transition-colors ${lang === 'en' ? 'bg-white/15 text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          EN
        </button>
      </div>

      {/* 桌面版徽标（Electron preload 注入；网页/GH Pages 不显示） */}
      {IS_DESKTOP && (
        <div className="h-9 px-2.5 flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.05] shrink-0" title="桌面版：AI/配音/SQLite 本地库可用">
          <UserRound size={13} className="text-muted-foreground" />
          <span className="text-xs">桌面版</span>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        </div>
      )}
    </div>
  );
}

/**
 * 工具弹窗里的「加入图层」行：只列该类型的图层，选中即成为当前图层（图层面板与时间线同步激活）。
 * 该类型一个图层都没有时只给「新建」——新元素必须有图层可进，不做「自动」这种隐式选项。
 */
function LayerPickRow({ type, lang }: { type: LayerType; lang: 'zh' | 'en' }) {
  const layers = useProjectStore((s) => s.project?.layers) ?? [];
  const addLayer = useProjectStore((s) => s.addLayer);
  const selectedLayerId = useEditorStore((s) => s.selectedLayerId);
  const selectLayer = useEditorStore((s) => s.selectLayer);
  const [open, setOpen] = useState(false);

  const sameType = layers.filter((L) => L.type === type);
  const cur = sameType.find((L) => L.id === selectedLayerId) || sameType[0];
  const label = LAYER_TYPE_LABEL[type];
  const pick = (id: string) => { selectLayer(id, type); setOpen(false); };
  const create = () => { const L = addLayer(type); if (L) selectLayer(L.id, type); setOpen(false); };

  if (!cur) {
    return (
      <button
        onClick={create}
        className="w-full flex items-center justify-center gap-1.5 h-8 rounded-lg border border-dashed border-white/20 text-xs text-muted-foreground hover:text-foreground hover:border-white/40 hover:bg-white/5 transition-colors"
      >
        <Plus size={12} /> {lang === 'en' ? `New ${label} layer` : `新建${label}图层`}
      </button>
    );
  }
  const row = 'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors';
  return (
    <div className="relative flex items-center gap-2">
      <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">
        {lang === 'en' ? 'Layer' : '图层'}
      </span>
      <button
        onClick={() => setOpen((v) => !v)}
        title={lang === 'en' ? `New ${label} elements go to this layer` : `新建的${label}元素进入这个图层`}
        className="flex-1 min-w-0 h-8 px-2 flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.04] text-xs text-foreground/90 hover:bg-white/10 transition-colors"
      >
        <span className="truncate">{cur.name}</span>
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">{cur.elements.length}</span>
        <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full mt-1.5 left-0 z-50 w-full min-w-[190px] rounded-xl bg-[#171412]/95 backdrop-blur-md border border-white/[0.14] shadow-2xl p-1.5">
            <div className="max-h-52 overflow-y-auto">
              {sameType.map((L) => (
                <button
                  key={L.id}
                  onClick={() => pick(L.id)}
                  className={`${row} ${L.id === cur.id ? 'text-foreground bg-white/[0.07]' : 'text-muted-foreground hover:text-foreground hover:bg-white/5'}`}
                >
                  <Check size={12} className={L.id === cur.id ? '' : 'opacity-0'} />
                  <span className="flex-1 text-left truncate">{L.name}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground/70">{L.elements.length}</span>
                </button>
              ))}
            </div>
            <button
              onClick={create}
              className={`${row} mt-0.5 pt-2 border-t border-white/[0.08] text-muted-foreground hover:text-foreground hover:bg-white/5`}
            >
              <Plus size={12} /> {lang === 'en' ? `New ${label} layer` : `新建${label}图层`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function FloatingTools() {
  const mode = useInteractionStore((s) => s.mode);
  const setMode = useInteractionStore((s) => s.setMode);
  const routeReq = useInteractionStore((s) => s.pendingRouteStyle);
  const lang = useEditorStore((s) => s.lang);
  const [pinOpen, setPinOpen] = useState(false);
  const [routeOpen, setRouteOpen] = useState(false);
  const [shapeOpen, setShapeOpen] = useState(false);
  const [terrOpen, setTerrOpen] = useState(false);
  const [terrImportOpen, setTerrImportOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);

  const item = 'h-8 px-2.5 flex items-center gap-1.5 rounded-full text-xs font-medium transition-colors shrink-0';

  const closeAll = () => { setPinOpen(false); setRouteOpen(false); setShapeOpen(false); setTerrOpen(false); setImageOpen(false); };
  /** 该工具的弹窗是否展开（用于按钮激活态 + 再次点击关闭） */
  const openOf = (label: string) =>
    label === 'Pin' ? pinOpen : label === 'Route' ? routeOpen : label === 'Shape' ? shapeOpen : label === 'Terr' ? terrOpen : label === 'Image' ? imageOpen : false;
  /** 点击工具：展开自己的弹窗；已是展开态则再次点击关闭（不能依赖 setState 的函数式更新——
   *  closeAll 会先把状态排到 false，updater 拿到的是 closeAll 后的 false，导致永远重新打开）。 */
  const toggleMenu = (label: string, setOpen: (v: boolean) => void) => {
    const was = openOf(label);
    closeAll();
    if (!was) setOpen(true);
  };

  const runTerrAction = (act: TerrItem['act']) => {
    setTerrOpen(false);
    if (act === 'import') setTerrImportOpen(true);
    else if (act === 'plot') setMode('add_terr_plot');
    else if (act === 'split') setMode('terr_split');
    else if (act === 'annex') setMode('terr_annex');
  };

  /** 在地图当前视野中心插入一张贴图（四角配准） */
  const insertGeoImage = async (assetId: string) => {
    const map = sharedMap.get();
    const project = useProjectStore.getState().project;
    if (!map || !project) return;
    const b = map.getBounds();
    const aspect = await loadImageAspect(assetId);
    const el = createGeoImageElement(project, assetId, aspect, {
      west: b.getWest(), east: b.getEast(), south: b.getSouth(), north: b.getNorth(),
    });
    useProjectStore.getState().addElement(el);
    useEditorStore.getState().selectElement(el.id);
    setImageOpen(false);
  };

  const importImageFile = async (file: File) => {
    setImageBusy(true);
    try {
      const ref = await uploadAsset(file, 'image');
      await insertGeoImage(ref.assetId);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setImageBusy(false);
    }
  };

  return (
    <>
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-0.5 h-10 px-1.5 rounded-full bg-[#1c1917]/95 backdrop-blur border border-white/10 shadow-lg">
        {TOOLS.map((tool) => (
          <button
            key={tool.label}
            title={lang === 'en' ? tool.label : tool.zh}
            onClick={() => {
              const t = TOOL_LAYER_TYPE[tool.label];
              if (t) useEditorStore.getState().setActiveLayerType(t);
              if (tool.action === 'place-pin') toggleMenu('Pin', setPinOpen);
              else if (tool.action === 'image') toggleMenu('Image', setImageOpen);
              else if (tool.mode === 'add_line') toggleMenu('Route', setRouteOpen);
              else if (tool.mode === 'add_polygon') toggleMenu('Shape', setShapeOpen);
              else if (tool.label === 'Terr') toggleMenu('Terr', setTerrOpen);
              else if (tool.mode) { closeAll(); setMode(tool.mode); }
            }}
            className={`${item} ${
              openOf(tool.label)
                ? 'bg-white/20 text-foreground'
                : toolActive(tool, mode, routeReq)
                  ? 'bg-white/15 text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-white/5'
            }`}
          >
            {tool.icon}
            <span className="hidden xl:inline">{lang === 'en' ? tool.label : tool.zh}</span>
          </button>
        ))}
      </div>

      {/* 标记样式弹窗（标题=类型名称；内容=标记设置的样式） */}
      {pinOpen && (
        <div className="absolute top-[52px] left-1/2 -translate-x-1/2 z-30 w-[340px] rounded-xl bg-[#171412]/95 backdrop-blur-md border border-white/[0.14] shadow-2xl p-3 space-y-3">
          <div className="flex items-center gap-2">
            <div className="px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-300/90 bg-red-500/10 rounded">
              {lang === 'en' ? 'Pin' : '标记'}
            </div>
            <div className="flex-1 h-px bg-white/[0.08]" />
          </div>
          <div className="grid grid-cols-5 gap-1.5">
            {PIN_ITEMS.map((s) => (
              <button
                key={s.style}
                title={lang === 'en' ? s.en : s.zh}
                onClick={() => {
                  setPinOpen(false);
                  useInteractionStore.getState().requestPlace('pin', s.style);
                  setMode('select');
                }}
                className="flex flex-col items-center gap-1 py-2 px-1 rounded-lg border bg-white/[0.04] border-white/[0.09] text-foreground/85 hover:bg-white/10 hover:border-white/25 transition-colors"
              >
                <span className="text-lg leading-none drop-shadow-sm">{s.glyph}</span>
                <span className="text-[10.5px] leading-tight font-medium text-center">
                  {lang === 'en' ? s.en : s.zh}
                </span>
              </button>
            ))}
          </div>
          <LayerPickRow type="marker" lang={lang} />
          <p className="px-1 pt-1 text-[10px] text-muted-foreground/75 border-t border-white/[0.08]">
            {lang === 'en' ? 'Pick a style to place the marker at map center; drag to fine-tune.' : '选择样式即在地图中心放置标记，可拖拽微调；具体属性在右侧面板设置。'}
          </p>
        </div>
      )}

      {/* 路线类型弹窗（标题=类型名称；内容=路线设置的路线类型） */}
      {routeOpen && (
        <div className="absolute top-[52px] left-1/2 -translate-x-1/2 z-30 w-[340px] rounded-xl bg-[#171412]/95 backdrop-blur-md border border-white/[0.14] shadow-2xl p-3 space-y-3">
          <div className="flex items-center gap-2">
            <div className="px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-blue-300/90 bg-blue-500/10 rounded">
              {lang === 'en' ? 'Route' : '路线'}
            </div>
            <div className="flex-1 h-px bg-white/[0.08]" />
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {ROUTE_ITEMS.map((s) => (
              <button
                key={s.zh}
                title={lang === 'en' ? s.en : s.zh}
                onClick={() => {
                  setRouteOpen(false);
                  setMode(s.mode);
                  if (s.route) useInteractionStore.getState().setPendingRouteStyle(s.route, s.mode);
                }}
                className="flex flex-col items-center gap-1 py-2 px-1 rounded-lg border bg-white/[0.04] border-white/[0.09] text-foreground/85 hover:bg-white/10 hover:border-white/25 transition-colors"
              >
                <span className="text-lg leading-none drop-shadow-sm">{s.glyph}</span>
                <span className="text-[10.5px] leading-tight font-medium text-center">
                  {lang === 'en' ? s.en : s.zh}
                </span>
              </button>
            ))}
          </div>
          <LayerPickRow type="route" lang={lang} />
          <p className="px-1 pt-1 text-[10px] text-muted-foreground/75 border-t border-white/[0.08]">
            {lang === 'en' ? 'Click map to draw; dblclick to finish; right-click/Esc cancel. Colors, animation and move marker in panel.' : '点击地图绘制，双击完成，右键/Esc 取消；颜色、动画、移动标记在右侧面板设置。'}
          </p>
        </div>
      )}

      {/* 形状分类菜单（展开在工具条下方） */}
      {shapeOpen && (
        <div className="absolute top-[52px] left-1/2 -translate-x-1/2 z-30 w-[460px] rounded-xl bg-[#171412]/95 backdrop-blur-md border border-white/[0.14] shadow-2xl p-3 space-y-3">
          <div className="flex items-center gap-2">
            <div className="px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-orange-300/90 bg-orange-500/10 rounded">
              {lang === 'en' ? 'Shape' : '形状'}
            </div>
            <div className="flex-1 h-px bg-white/[0.08]" />
          </div>
          {SHAPE_GROUPS.map((g) => (
            <div key={g.zh}>
              <div className="flex items-center gap-2 mb-1.5">
                <div className="px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-orange-300/90 bg-orange-500/10 rounded">
                  {lang === 'en' ? g.en : g.zh}
                </div>
                <div className="flex-1 h-px bg-white/[0.08]" />
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {g.items.map((s) => (
                  <button
                    key={s.mode}
                    title={s.hint ? `${lang === 'en' ? s.en : s.zh}（${s.hint}）` : (lang === 'en' ? s.en : s.zh)}
                    onClick={() => { setShapeOpen(false); setMode(s.mode); }}
                    className={`flex flex-col items-center gap-1 py-2 px-1 rounded-lg border transition-colors ${
                      mode === s.mode
                        ? 'bg-brand/25 border-brand/60 text-foreground shadow-inner'
                        : 'bg-white/[0.04] border-white/[0.09] text-foreground/85 hover:bg-white/10 hover:border-white/25'
                    }`}
                  >
                    <span className="text-lg leading-none drop-shadow-sm">{s.glyph}</span>
                    <span className="text-[10.5px] leading-tight font-medium text-center">
                      {lang === 'en' ? s.en : s.zh}
                    </span>
                    {s.hint && (
                      <span className="text-[9px] leading-tight text-muted-foreground/80 text-center">{s.hint}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <LayerPickRow type="shape" lang={lang} />
          <p className="px-1 pt-1 text-[10px] text-muted-foreground/75 border-t border-white/[0.08]">
            {lang === 'en' ? 'Click map to draw; multi-point dblclick to finish; right-click/Esc cancel. Shapes: drag vertices, rotate in panel.' : '点击地图绘制；多点图形双击完成，右键/Esc 取消。形状可拖拽顶点编辑，矩形/集结点/五角星可旋转。'}
          </p>
        </div>
      )}

      {/* 疆域分类菜单（展开在工具条下方） */}
      {terrOpen && (
        <div className="absolute top-[52px] left-1/2 -translate-x-1/2 z-30 w-[320px] rounded-xl bg-[#171412]/95 backdrop-blur-md border border-white/[0.14] shadow-2xl p-3 space-y-3">
          <div className="flex items-center gap-2">
            <div className="px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-violet-300/90 bg-violet-500/10 rounded">
              {lang === 'en' ? 'Territory' : '疆域'}
            </div>
            <div className="flex-1 h-px bg-white/[0.08]" />
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {TERR_ITEMS.map((s) => (
              <button
                key={s.act}
                title={s.hint ? `${lang === 'en' ? s.en : s.zh}（${s.hint}）` : (lang === 'en' ? s.en : s.zh)}
                onClick={() => runTerrAction(s.act)}
                className="flex flex-col items-center gap-1 py-2 px-1 rounded-lg border bg-white/[0.04] border-white/[0.09] text-foreground/85 hover:bg-white/10 hover:border-white/25 transition-colors"
              >
                <span className="text-lg leading-none drop-shadow-sm">{s.glyph}</span>
                <span className="text-[10.5px] leading-tight font-medium text-center">
                  {lang === 'en' ? s.en : s.zh}
                </span>
                {s.hint && (
                  <span className="text-[9px] leading-tight text-muted-foreground/80 text-center">{s.hint}</span>
                )}
              </button>
            ))}
          </div>
          <LayerPickRow type="territory" lang={lang} />
          <p className="px-1 pt-1 text-[10px] text-muted-foreground/75 border-t border-white/[0.08]">
            {lang === 'en'
              ? 'Annex events recolor plots: instant / fade / border draw / spread from invader / nibble by an advancing ragged front, plus glow.'
              : '兼并事件按帧生效：瞬时 / 渐变 / 描线 / 扩散（从占领方边界推进）/ 蚕食（扩散推进+湍流置换前沿），可加高亮。'}
          </p>
        </div>
      )}

      {/* 图片贴图菜单：导入新图 / 从全局素材库插入 */}
      {imageOpen && (
        <div className="absolute top-[52px] left-1/2 -translate-x-1/2 z-30 w-[380px] rounded-xl bg-[#171412]/95 backdrop-blur-md border border-white/[0.14] shadow-2xl p-3 space-y-3">
          <div className="flex items-center gap-2">
            <div className="px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300/90 bg-emerald-500/10 rounded">
              {lang === 'en' ? 'Image' : '图片贴图'}
            </div>
            <div className="flex-1 h-px bg-white/[0.08]" />
          </div>
          <label className={`flex items-center justify-center gap-1.5 h-9 rounded-lg border border-dashed border-white/20 text-xs transition-colors ${IS_DESKTOP && !imageBusy ? 'cursor-pointer hover:border-white/40 hover:bg-white/5' : 'opacity-50 cursor-not-allowed'}`}>
            {imageBusy ? (lang === 'en' ? 'Importing…' : '导入中…') : `⬆ ${lang === 'en' ? 'Import image' : '导入图片'}`}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              disabled={!IS_DESKTOP || imageBusy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void importImageFile(f); e.target.value = ''; }}
            />
          </label>
          <LayerPickRow type="image" lang={lang} />
          <p className="px-1 pt-1 text-[10px] text-muted-foreground/75 border-t border-white/[0.08]">
            {lang === 'en'
              ? 'Inserted at map center; drag the 4 corner points to georeference; grid density & opacity in the right panel.'
              : '插入到当前地图视野中心；拖动四角控制点做配准；网格密度与不透明度在右侧面板调整。'}
          </p>
        </div>
      )}

      {terrImportOpen && <TerritoryImportDialog onClose={() => setTerrImportOpen(false)} />}
    </>
  );
}

/** 兼容旧引用（已拆分为 TopBar） */
export const Toolbar = TopBar;
