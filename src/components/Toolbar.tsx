import { useState, useMemo } from 'react';
import {
  MapPin, Route as RouteIcon, Image as ImageIcon,
  Shapes, Globe, Undo2, Redo2, FolderOpen, Settings2, Download, Languages, Landmark, UserRound,
} from 'lucide-react';
import { useProjectStore, isProjectDirty } from '../stores/projectStore';
import { useEditorStore } from '../stores/editorStore';
import { useInteractionStore, type InteractionMode } from '../stores/interactionStore';
import { exportVideo, downloadBlob } from '../lib/export-video';
import { sharedMap } from '../lib/shared-map';
import { IS_DESKTOP } from '../lib/backend';
import { MapSearchBox } from './MapSearchBox';
import { ChapterMenu } from './ChapterMenu';
import { RegionPickerDialog } from './RegionPickerDialog';
import { TerritoryImportDialog } from './TerritoryImportDialog';

interface ToolbarProps {
  onOpenExport: () => void;
}

interface ModeItem {
  mode?: InteractionMode;
  icon: React.ReactNode;
  label: string;
  zh: string;
  /** 非绘图动作 */
  action?: 'regionPicker' | 'place-pin' | 'place-image';
}

/** 浮动工具条（对齐 Mapimator：一键直达，样式在右侧 Settings 切换） */
const TOOLS: ModeItem[] = [
  { icon: <MapPin size={15} className="text-red-400" />, label: 'Pin', zh: '标记', action: 'place-pin' },
  { icon: <RouteIcon size={15} className="text-blue-400" />, label: 'Route', zh: '路线', mode: 'add_line' },
  { icon: <ImageIcon size={15} className="text-emerald-400" />, label: 'Image', zh: '图片', action: 'place-image' },
  { icon: <Shapes size={15} className="text-orange-400" />, label: 'Shape', zh: '形状', mode: 'add_polygon' },
  { icon: <Globe size={15} className="text-sky-400" />, label: 'Region', zh: '区域', action: 'regionPicker' },
  { icon: <Landmark size={15} className="text-violet-400" />, label: 'Terr', zh: '疆域', mode: 'add_terr_plot' },
];

const ROUTE_MODES: InteractionMode[] = ['add_line', 'add_bezier', 'add_line_arc', 'add_arrow', 'add_curved', 'add_pincer'];

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

/** 工具当前是否激活（用于高亮） */
function toolActive(t: ModeItem, mode: InteractionMode): boolean {
  if (t.mode) {
    if (t.label === 'Route') return ROUTE_MODES.includes(mode);
    if (t.label === 'Shape') return SHAPE_MODES.includes(mode);
    if (t.label === 'Terr') return TERR_MODES.includes(mode);
    return t.mode === mode;
  }
  if (t.label === 'Pin') return mode === 'add_point' || mode === 'add_flag';
  if (t.label === 'Text') return mode === 'add_text';
  if (t.label === 'Image') return mode === 'add_custom';
  return false;
}

/** 疆域分类菜单数据 */
interface TerrItem { zh: string; en: string; glyph: string; hint?: string; act: 'new' | 'import' | 'plot' | 'annex' }
const TERR_ITEMS: TerrItem[] = [
  { zh: '新建疆域', en: 'New Territory', glyph: '🗺️', hint: '地图中心新建', act: 'new' },
  { zh: '导入疆域', en: 'Import', glyph: '📥', hint: '势力库/GeoJSON', act: 'import' },
  { zh: '绘制地块', en: 'Draw Plot', glyph: '✏️', hint: '多点闭合', act: 'plot' },
  { zh: '兼并', en: 'Annex', glyph: '⚔️', hint: '点选地块→事件', act: 'annex' },
];

/**
 * 顶部栏（对齐 Mapimator 顶栏）：
 * Logo + 项目芯片 + 章节菜单 ｜ 地名搜索 ｜ 撤销重做 · 保存 · 导出
 * 底图/高程/3D 在地图左下角 MapStyleChip。
 */
export function TopBar({ onOpenExport }: ToolbarProps) {
  const project = useProjectStore((s) => s.project);
  const saveProject = useProjectStore((s) => s.saveProject);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const historyLen = useProjectStore((s) => s.history.length);
  const futureLen = useProjectStore((s) => s.future.length);
  const lang = useEditorStore((s) => s.lang);
  const setLang = useEditorStore((s) => s.setLang);

  const [exporting, setExporting] = useState(false);
  const [exportPct, setExportPct] = useState(0);
  // 有未保存修改时保存按钮才可用
  const dirty = useMemo(() => isProjectDirty(project), [project]);

  if (!project) return null;

  const handleExport = async () => {
    setExporting(true);
    setExportPct(0);
    try {
      const blob = await exportVideo({ project, onProgress: (p) => setExportPct(p) });
      downloadBlob(blob, `${project.name || 'map-video'}.mp4`);
    } catch (err) {
      console.error(err);
      alert(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
      setExportPct(0);
    }
  };

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
        onClick={() => useProjectStore.setState({ project: null })}
        className="h-9 px-3 flex items-center gap-2 rounded-lg bg-white/[0.05] border border-white/10 text-sm text-foreground/90 hover:bg-white/10 transition-colors shrink-0"
        title="项目列表"
      >
        <FolderOpen size={14} className="text-muted-foreground" />
        <span className="max-w-[160px] truncate">{project.name || '未命名项目'}</span>
      </button>

      {/* 章节菜单：切换 / 重命名 / 复制 / 删除 / 新增 */}
      <ChapterMenu />

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
        onClick={() => saveProject()}
        disabled={!dirty}
        className="h-8 px-3 flex items-center gap-1.5 rounded-md bg-white/[0.05] border border-white/15 text-xs font-medium text-amber-400/90 hover:bg-white/10 transition-colors disabled:opacity-35 disabled:cursor-not-allowed shrink-0"
        title={dirty ? '保存到浏览器' : '没有需要保存的修改'}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${dirty ? 'bg-amber-400' : 'bg-white/25'}`} />
        保存
      </button>

      {/* 导出配置 */}
      <button onClick={onOpenExport} className={iconBtn} title="导出配置 / GeoJSON">
        <Settings2 size={15} />
      </button>

      {/* 导出视频（白底主按钮，导出时显示进度百分比+细进度条） */}
      <button
        onClick={handleExport}
        disabled={exporting}
        className="relative h-9 px-3.5 flex items-center gap-1.5 rounded-md bg-white text-black text-sm font-medium hover:bg-white/90 transition-colors disabled:opacity-50 shrink-0 overflow-hidden"
      >
        <Download size={14} />
        {exporting ? `导出中 ${Math.round(exportPct * 100)}%` : '导出视频'}
        {exporting && <span className="absolute left-0 bottom-0 h-0.5 bg-[var(--brand)]" style={{ width: `${exportPct * 100}%` }} />}
      </button>

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

/** 地图上方浮动工具条：选择 + 扁平工具（形状/疆域点击展开分类菜单） */
export function FloatingTools() {
  const mode = useInteractionStore((s) => s.mode);
  const setMode = useInteractionStore((s) => s.setMode);
  const lang = useEditorStore((s) => s.lang);
  const [regionPickerOpen, setRegionPickerOpen] = useState(false);
  const [shapeOpen, setShapeOpen] = useState(false);
  const [terrOpen, setTerrOpen] = useState(false);
  const [terrImportOpen, setTerrImportOpen] = useState(false);

  const item = 'h-8 px-2.5 flex items-center gap-1.5 rounded-full text-xs font-medium transition-colors shrink-0';

  const runTerrAction = (act: TerrItem['act']) => {
    setTerrOpen(false);
    if (act === 'new') { useInteractionStore.getState().requestPlace('territory'); setMode('select'); }
    else if (act === 'import') setTerrImportOpen(true);
    else if (act === 'plot') setMode('add_terr_plot');
    else if (act === 'annex') setMode('terr_annex');
  };

  return (
    <>
      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-0.5 h-10 px-1.5 rounded-full bg-[#1c1917]/95 backdrop-blur border border-white/10 shadow-lg">
        {TOOLS.map((tool) => (
          <button
            key={tool.label}
            title={lang === 'en' ? tool.label : tool.zh}
            onClick={() => {
              if (tool.action === 'regionPicker') setRegionPickerOpen(true);
              else if (tool.action === 'place-pin') { useInteractionStore.getState().requestPlace('pin'); setMode('select'); }
              else if (tool.action === 'place-image') { useInteractionStore.getState().requestPlace('image'); setMode('select'); }
              else if (tool.mode === 'add_polygon') { setShapeOpen((v) => !v); setTerrOpen(false); }
              else if (tool.label === 'Terr') { setTerrOpen((v) => !v); setShapeOpen(false); }
              else if (tool.mode) { setShapeOpen(false); setTerrOpen(false); setMode(tool.mode); }
            }}
            className={`${item} ${toolActive(tool, mode) ? 'bg-white/15 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-white/5'}`}
          >
            {tool.icon}
            <span className="hidden xl:inline">{lang === 'en' ? tool.label : tool.zh}</span>
          </button>
        ))}
      </div>

      {/* 形状分类菜单（展开在工具条下方） */}
      {shapeOpen && (
        <div className="absolute top-[52px] left-1/2 -translate-x-1/2 z-30 w-[460px] rounded-xl bg-[#171412]/95 backdrop-blur-md border border-white/[0.14] shadow-2xl p-3 space-y-3">
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
          <p className="px-1 pt-1 text-[10px] text-muted-foreground/75 border-t border-white/[0.08]">
            {lang === 'en' ? 'Click map to draw; multi-point dblclick to finish; right-click/Esc cancel. Shapes: drag vertices, rotate in panel.' : '点击地图绘制；多点图形双击完成，右键/Esc 取消。形状可拖拽顶点编辑，矩形/集结点/五角星可旋转。'}
          </p>
        </div>
      )}

      {/* 疆域分类菜单（展开在工具条下方） */}
      {terrOpen && (
        <div className="absolute top-[52px] left-1/2 -translate-x-1/2 z-30 w-[420px] rounded-xl bg-[#171412]/95 backdrop-blur-md border border-white/[0.14] shadow-2xl p-3 space-y-3">
          <div className="flex items-center gap-2">
            <div className="px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-violet-300/90 bg-violet-500/10 rounded">
              {lang === 'en' ? 'Territory' : '疆域'}
            </div>
            <div className="flex-1 h-px bg-white/[0.08]" />
          </div>
          <div className="grid grid-cols-4 gap-1.5">
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
          <p className="px-1 pt-1 text-[10px] text-muted-foreground/75 border-t border-white/[0.08]">
            {lang === 'en'
              ? 'Annex events recolor plots: instant / fade / border draw / spread from invader / nibble by an advancing ragged front, plus glow.'
              : '兼并事件按帧生效：瞬时 / 渐变 / 描线 / 扩散（从占领方边界推进）/ 蚕食（扩散推进+湍流置换前沿），可加高亮。'}
          </p>
        </div>
      )}

      {regionPickerOpen && <RegionPickerDialog onClose={() => setRegionPickerOpen(false)} />}
      {terrImportOpen && <TerritoryImportDialog onClose={() => setTerrImportOpen(false)} />}
    </>
  );
}

/** 兼容旧引用（已拆分为 TopBar） */
export const Toolbar = TopBar;
