import { useState, useMemo } from 'react';
import {
  MapPin, Route as RouteIcon, Image as ImageIcon,
  Shapes, Globe, Undo2, Redo2, FolderOpen, Settings2, Download, Languages,
} from 'lucide-react';
import { useProjectStore, isProjectDirty } from '../stores/projectStore';
import { useEditorStore } from '../stores/editorStore';
import { useInteractionStore, type InteractionMode } from '../stores/interactionStore';
import { exportVideo, downloadBlob } from '../lib/export-video';
import { sharedMap } from '../lib/shared-map';
import { MapSearchBox } from './MapSearchBox';
import { ChapterMenu } from './ChapterMenu';
import { RegionPickerDialog } from './RegionPickerDialog';

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
];

const ROUTE_MODES: InteractionMode[] = ['add_line', 'add_bezier', 'add_line_arc', 'add_arrow', 'add_curved', 'add_pincer'];

/** 工具当前是否激活（用于高亮） */
function toolActive(t: ModeItem, mode: InteractionMode): boolean {
  if (t.mode) return t.mode === mode || (t.label === 'Route' && ROUTE_MODES.includes(mode));
  if (t.label === 'Pin') return mode === 'add_point' || mode === 'add_flag';
  if (t.label === 'Text') return mode === 'add_text';
  if (t.label === 'Image') return mode === 'add_custom';
  return false;
}

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
  // 有未保存修改时保存按钮才可用
  const dirty = useMemo(() => isProjectDirty(project), [project]);

  if (!project) return null;

  const handleExport = async () => {
    setExporting(true);
    try {
      const blob = await exportVideo({ project, onProgress: (p) => console.log('Export:', p) });
      downloadBlob(blob, `${project.name || 'map-video'}.mp4`);
    } catch (err) {
      console.error(err);
    } finally {
      setExporting(false);
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

      {/* 导出视频（白底主按钮） */}
      <button
        onClick={handleExport}
        disabled={exporting}
        className="h-9 px-3.5 flex items-center gap-1.5 rounded-md bg-white text-black text-sm font-medium hover:bg-white/90 transition-colors disabled:opacity-50 shrink-0"
      >
        <Download size={14} />
        {exporting ? '导出中...' : '导出视频'}
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
    </div>
  );
}

/** 地图上方浮动工具条：选择 + 六大扁平工具 */
export function FloatingTools() {
  const mode = useInteractionStore((s) => s.mode);
  const setMode = useInteractionStore((s) => s.setMode);
  const lang = useEditorStore((s) => s.lang);
  const [regionPickerOpen, setRegionPickerOpen] = useState(false);

  const item = 'h-8 px-2.5 flex items-center gap-1.5 rounded-full text-xs font-medium transition-colors shrink-0';

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
              else if (tool.mode) setMode(tool.mode);
            }}
            className={`${item} ${toolActive(tool, mode) ? 'bg-white/15 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-white/5'}`}
          >
            {tool.icon}
            <span className="hidden xl:inline">{lang === 'en' ? tool.label : tool.zh}</span>
          </button>
        ))}
      </div>

      {regionPickerOpen && <RegionPickerDialog onClose={() => setRegionPickerOpen(false)} />}
    </>
  );
}

/** 兼容旧引用（已拆分为 TopBar） */
export const Toolbar = TopBar;
