import { useRef, useState } from 'react';
import { Layers, Search, Eye, EyeOff, FolderOpen, Compass, FileDown, X, Trash2 } from 'lucide-react';
import { useProjectStore } from '../stores/projectStore';
import { useEditorStore } from '../stores/editorStore';
import { useInteractionStore } from '../stores/interactionStore';
import { uploadGeoJSON, elementsToGeoJSON } from '../lib/geojson';
import { parseGpx } from '../lib/gpx';
import { useT } from './ui/primitives';
import type { MapElement } from '../types';

/**
 * 左侧浮动元素面板（对齐 Mapimator Project Layers 浮层）：
 * 搜索 / 可见性切换 / 导入导出 / 底部统计；由 App 以绝对定位浮在地图上。
 */
export function ElementsPanel() {
  const project = useProjectStore((s) => s.project);
  const addElements = useProjectStore((s) => s.addElements);
  const deleteElement = useProjectStore((s) => s.deleteElement);
  const updateElement = useProjectStore((s) => s.updateElement);
  const selectedElementId = useEditorStore((s) => s.selectedElementId);
  const selectedChapterId = useEditorStore((s) => s.selectedChapterId);
  const selectElement = useEditorStore((s) => s.selectElement);
  const setElementsOpen = useEditorStore((s) => s.setElementsOpen);
  const openFx = useEditorStore((s) => s.openFx);
  const addElement = useProjectStore((s) => s.addElement);
  const geoRef = useRef<HTMLInputElement>(null);
  const gpxRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState('');
  const t = useT();

  if (!project) return null;

  const chapter = project.chapters.find((c) => c.id === selectedChapterId) || project.chapters[0];
  const chapterElements = chapter?.elements || [];
  const kw = filter.trim().toLowerCase();
  const shown = kw ? chapterElements.filter((el) => (el.name || '').toLowerCase().includes(kw)) : chapterElements;

  const handleImportGeoJSON = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !chapter) return;
    try {
      const elements = await uploadGeoJSON(file);
      if (elements.length > 0) {
        // 修正时间范围到当前章节
        const fixed = elements.map((el) => ({
          ...el,
          startFrame: chapter.startFrame,
          endFrame: chapter.endFrame,
        }));
        addElements(chapter.id, fixed);
      }
    } catch (err) {
      console.error(err);
      alert('GeoJSON 导入失败');
    } finally {
      e.target.value = '';
    }
  };

  const handleImportGpx = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !chapter) return;
    try {
      const text = await file.text();
      const track = parseGpx(text, file.name.replace(/\.gpx$/i, ''));
      const el: MapElement = {
        id: Math.random().toString(36).slice(2),
        type: 'line', name: track.name, visible: true, locked: false,
        startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
        coordinates: track.coords,
        drawProgress: [{ frame: chapter.startFrame, value: 1 }],
        lineWidth: 8, lineColor: '#FF6600',
      };
      addElement(chapter.id, el);
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'GPX 导入失败');
    } finally {
      e.target.value = '';
    }
  };

  return (
    <div className="h-full flex flex-col rounded-xl overflow-hidden">
      {/* 头部 */}
      <div className="h-12 shrink-0 px-3 flex items-center justify-between bg-white/[0.05] border-b border-white/[0.06]">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Layers size={14} className="text-muted-foreground" /> {t('元素', 'Layers')}
        </div>
        <div className="flex items-center gap-0.5">
          <button onClick={() => geoRef.current?.click()} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5" title="导入GeoJSON">
            <FolderOpen size={14} />
          </button>
          <button onClick={() => gpxRef.current?.click()} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5" title="导入GPX轨迹→行军路线">
            <Compass size={14} />
          </button>
          <button onClick={() => {
            const data = elementsToGeoJSON(chapterElements);
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/geo+json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${chapter?.title || 'chapter'}.geojson`;
            a.click();
            URL.revokeObjectURL(url);
          }} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5" title="导出GeoJSON">
            <FileDown size={14} />
          </button>
          <button onClick={() => setElementsOpen(false)} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5" title="收起">
            <X size={14} />
          </button>
        </div>
      </div>
      <input ref={geoRef} type="file" accept=".geojson,.json" className="hidden" onChange={handleImportGeoJSON} />
      <input ref={gpxRef} type="file" accept=".gpx,application/gpx+xml,text/xml" className="hidden" onChange={handleImportGpx} />

      {/* 搜索 */}
      <div className="px-3 pt-2.5 pb-1">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('搜索元素...', 'Search layers...')}
            className="input pl-7 h-8 text-xs"
          />
        </div>
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto px-2 py-1.5">
        {shown.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8">{kw ? t('无匹配元素', 'No match') : t('本章暂无元素', 'No layers in this chapter')}</p>
        ) : (
          shown.map((element) => {
            const active = selectedElementId === element.id;
            return (
              <div
                key={element.id}
                className={`group flex items-center gap-2 px-2 py-1.5 mb-0.5 text-sm cursor-pointer rounded-lg border transition-colors ${
                  active ? 'bg-brand/15 border-brand/50' : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.06]'
                }`}
                onClick={() => {
                  selectElement(element.id);
                  useInteractionStore.getState().requestFocus(element.id);
                }}
              >
                <span className="text-sm w-5 text-center shrink-0">{getElementIcon(element.type)}</span>
                <span className={`flex-1 truncate text-xs ${element.visible === false ? 'text-muted-foreground line-through' : ''}`}>{element.name}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); selectElement(element.id); openFx('popup'); }}
                  className={`p-1 rounded shrink-0 ${active ? 'text-brand' : 'text-muted-foreground'} opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-white/10 transition-opacity`}
                  title="特效（弹窗/天气/画面/标题）"
                >
                  ✨
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); updateElement(chapter.id, element.id, { visible: element.visible === false } as Partial<MapElement>); }}
                  className={`p-1 rounded shrink-0 ${element.visible === false ? 'text-muted-foreground' : 'text-foreground/70'} hover:text-foreground hover:bg-white/10`}
                  title={element.visible === false ? '显示' : '隐藏'}
                >
                  {element.visible === false ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteElement(chapter.id, element.id); }}
                  className="p-1 rounded shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-white/10 transition-opacity"
                  title="删除"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* 底部统计 */}
      <div className="h-8 shrink-0 px-3 flex items-center border-t border-white/[0.06] text-[11px] text-muted-foreground">
        {t('显示', 'Showing')} {shown.length} / {chapterElements.length} {t('个元素', 'layers')}
      </div>
    </div>
  );
}

function getElementIcon(type: MapElement['type']): string {
  const icons: Record<string, string> = {
    point: '📍', moving_point: '🏃', line: '📏', polygon: '⬛',
    arrow: '➡️', double_arrow: '🩹', encirclement: '⭕', gathering: '⚔️', military_symbol: '🎖️',
    connector: '🔗', flag: '🚩', territory: '🗺️',
  };
  return icons[type] || '❓';
}
