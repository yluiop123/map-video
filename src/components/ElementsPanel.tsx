import { useRef, useState, useEffect } from 'react';
import { Layers, Search, Eye, EyeOff, FileDown, X, Trash2, Plus, ChevronRight, ChevronDown, Star, Upload } from 'lucide-react';
import { useProjectStore } from '../stores/projectStore';
import { useEditorStore } from '../stores/editorStore';
import { useInteractionStore } from '../stores/interactionStore';
import { uploadGeoJSON, elementsToGeoJSON } from '../lib/geojson';
import { listPublicLayers, savePublicLayer, removePublicLayer, layerTypeOf, LAYER_TYPE_LABEL, LAYER_TYPES, type PublicLayer } from '../lib/layers';
import { useT } from './ui/primitives';
import type { Layer, LayerType, MapElement } from '../types';
import { generateId } from '../types';

/** 把公共图层的元素平移到以自身最早时间为 0（导入到其它项目时对齐） */
function rezeroElements(elements: MapElement[]): MapElement[] {
  if (!elements.length) return elements;
  const min = Math.min(...elements.map((el) => el.startFrame ?? 0));
  if (!Number.isFinite(min) || min === 0) return elements;
  return elements.map((el) => ({ ...el, startFrame: el.startFrame - min, endFrame: el.endFrame - min }));
}

/**
 * 左侧浮动「图层」面板：图层列表（新增 / 删除 / 显隐 / 展开元素）+ 搜索
 * + 每图层 GeoJSON 导入导出 / 加入公共图层 / 导入公共图层。
 */
export function ElementsPanel() {
  const project = useProjectStore((s) => s.project);
  const addElements = useProjectStore((s) => s.addElements);
  const updateElement = useProjectStore((s) => s.updateElement);
  const deleteElement = useProjectStore((s) => s.deleteElement);
  const addLayer = useProjectStore((s) => s.addLayer);
  const addLayerFull = useProjectStore((s) => s.addLayerFull);
  const updateLayer = useProjectStore((s) => s.updateLayer);
  const deleteLayer = useProjectStore((s) => s.deleteLayer);
  const selectedElementId = useEditorStore((s) => s.selectedElementId);
  const selectElement = useEditorStore((s) => s.selectElement);
  const setElementsOpen = useEditorStore((s) => s.setElementsOpen);
  const openFx = useEditorStore((s) => s.openFx);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [newLayerOpen, setNewLayerOpen] = useState(false);
  const [pubOpen, setPubOpen] = useState(false);
  const [pubList, setPubList] = useState<PublicLayer[]>([]);
  const geoRef = useRef<HTMLInputElement>(null);
  const importingLayerRef = useRef<string | null>(null);
  const t = useT();

  useEffect(() => { if (pubOpen) setPubList(listPublicLayers()); }, [pubOpen]);

  if (!project) return null;

  const layers = project.layers || [];
  const kw = filter.trim().toLowerCase();
  const matchLayer = (L: Layer) => !kw || L.name.toLowerCase().includes(kw) || L.elements.some((el) => (el.name || '').toLowerCase().includes(kw));
  const shown = layers.filter(matchLayer);
  const totalElements = layers.reduce((n, L) => n + L.elements.length, 0);

  const importGeoJSONTo = async (file: File, layerId: string | null) => {
    try {
      const els = await uploadGeoJSON(file);
      if (!els.length) return;
      // 导入的元素默认「随图层显示」（customTime 关）
      const fixed = els.map((el) => ({ ...el, customTime: false } as MapElement));
      if (layerId) {
        // 单类型图层：只保留与该图层类型匹配的要素
        const L = layers.find((x) => x.id === layerId);
        const fit = L ? fixed.filter((el) => layerTypeOf(el) === L.type) : fixed;
        if (fit.length) addElements(fit, layerId);
      } else {
        // 未指定图层：按元素类型自动拆成多个同类型图层
        addElements(fixed);
      }
    } catch {
      alert(t('GeoJSON 导入失败', 'GeoJSON import failed'));
    }
  };

  const exportLayer = (L: Layer) => {
    const data = elementsToGeoJSON(L.elements);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${L.name || 'layer'}.geojson`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importPublic = (pl: PublicLayer) => {
    const els = rezeroElements(pl.elements) as MapElement[];
    const type = els.length ? layerTypeOf(els[0]) : 'marker';
    addLayerFull({ id: generateId(), type, name: pl.name, visible: true, startFrame: 0, endFrame: Math.max(1, project.endFrame), elements: els });
    setPubOpen(false);
  };

  return (
    <div className="h-full flex flex-col rounded-xl overflow-hidden">
      {/* 头部：仅标题 + 关闭（导入/导出移到每图层操作） */}
      <div className="h-12 shrink-0 px-3 flex items-center justify-between bg-white/[0.05] border-b border-white/[0.06]">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Layers size={14} className="text-muted-foreground" /> {t('图层', 'Layers')}
        </div>
        <button onClick={() => setElementsOpen(false)} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5" title={t('收起', 'Collapse')}>
          <X size={14} />
        </button>
      </div>

      {/* 搜索 + 新建/导入公共 */}
      <div className="px-3 pt-2.5 pb-1 space-y-2">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('搜索图层或元素...', 'Search layers or elements...')}
            className="input pl-7 h-8 text-xs"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setNewLayerOpen((v) => !v)} className={`flex-1 h-7 rounded-md border text-xs transition-colors flex items-center justify-center gap-1 ${newLayerOpen ? 'border-brand bg-brand/20' : 'border-white/10 bg-white/[0.045] hover:border-white/25'}`}>
            <Plus size={12} /> {t('新建图层', 'New layer')}
          </button>
          <button onClick={() => setPubOpen((v) => !v)} className={`h-7 px-2 rounded-md border text-xs transition-colors flex items-center gap-1 ${pubOpen ? 'border-brand bg-brand/20' : 'border-white/10 bg-white/[0.045] hover:border-white/25'}`} title={t('导入公共图层', 'Import public layer')}>
            <Star size={12} /> {t('公共', 'Public')}
          </button>
        </div>
        {newLayerOpen && (
          <div className="flex flex-wrap gap-1.5">
            {LAYER_TYPES.map((lt) => (
              <button key={lt} onClick={() => { addLayer(lt); setNewLayerOpen(false); }} className="h-7 px-2 rounded-md border border-white/10 bg-white/[0.045] text-[11px] hover:border-brand hover:bg-brand/15 transition-colors">
                {layerIcon(lt)} {t(LAYER_TYPE_LABEL[lt], lt)}
              </button>
            ))}
          </div>
        )}
        {pubOpen && (
          <div className="rounded-md border border-white/10 bg-white/[0.03] p-1.5 max-h-40 overflow-y-auto">
            {pubList.length === 0 ? (
              <p className="text-[11px] text-muted-foreground text-center py-2">{t('暂无公共图层；在图层上用 ★ 保存', 'No public layers yet — use ★ on a layer')}</p>
            ) : pubList.map((pl) => (
              <div key={pl.id} className="flex items-center gap-1 mb-0.5">
                <button onClick={() => importPublic(pl)} className="flex-1 text-left px-1.5 py-1 rounded text-[11px] hover:bg-white/10 truncate" title={t('导入为图层', 'Import as layer')}>
                  ⭐ {pl.name} <span className="text-muted-foreground">({pl.elements.length})</span>
                </button>
                <button onClick={() => setPubList(removePublicLayer(pl.id))} className="p-1 rounded text-muted-foreground hover:text-red-400 hover:bg-white/10" title={t('删除公共图层', 'Delete')}>
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <input
        ref={geoRef}
        type="file"
        accept=".geojson,.json"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void importGeoJSONTo(f, importingLayerRef.current); e.target.value = ''; }}
      />

      {/* 图层列表 */}
      <div className="flex-1 overflow-y-auto px-2 py-1.5">
        {shown.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8">{kw ? t('无匹配图层', 'No match') : t('暂无图层', 'No layers')}</p>
        ) : shown.map((L) => {
          const open = !!expanded[L.id];
          const els = kw ? L.elements.filter((el) => L.name.toLowerCase().includes(kw) || (el.name || '').toLowerCase().includes(kw)) : L.elements;
          return (
            <div key={L.id} className="mb-1 rounded-lg border border-white/[0.06] bg-white/[0.03]">
              {/* 图层行 */}
              <div className="group flex items-center gap-1.5 px-2 py-1.5 text-sm">
                <button onClick={() => setExpanded((m) => ({ ...m, [L.id]: !open }))} className="p-0.5 rounded shrink-0 text-muted-foreground hover:text-foreground" title={t('展开/收起', 'Expand')}>
                  {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
                <span className={`flex-1 truncate text-xs font-medium ${L.visible === false ? 'text-muted-foreground line-through' : ''}`} title={L.name}>
                  {layerIcon(L.type)} {L.name} <span className="text-muted-foreground">({L.elements.length})</span>
                </span>
                <button onClick={() => { importingLayerRef.current = L.id; geoRef.current?.click(); }} className="p-1 rounded shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-white/10 transition-opacity" title={t('导入 GeoJSON 到此图层', 'Import GeoJSON into layer')}>
                  <Upload size={13} />
                </button>
                <button onClick={() => exportLayer(L)} className="p-1 rounded shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-white/10 transition-opacity" title={t('导出该图层 GeoJSON', 'Export layer GeoJSON')}>
                  <FileDown size={13} />
                </button>
                <button onClick={() => { setPubList(savePublicLayer(L.name, L.elements)); }} className="p-1 rounded shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-amber-400 hover:bg-white/10 transition-opacity" title={t('加入公共图层库', 'Save to public library')}>
                  <Star size={13} />
                </button>
                <button onClick={() => updateLayer(L.id, { visible: L.visible === false })} className={`p-1 rounded shrink-0 ${L.visible === false ? 'text-muted-foreground' : 'text-foreground/70'} hover:text-foreground hover:bg-white/10`} title={L.visible === false ? t('显示', 'Show') : t('隐藏', 'Hide')}>
                  {L.visible === false ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button onClick={() => deleteLayer(L.id)} className="p-1 rounded shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-white/10 transition-opacity" title={t('删除图层', 'Delete layer')}>
                  <Trash2 size={13} />
                </button>
              </div>
              {/* 元素行 */}
              {open && (
                <div className="px-1.5 pb-1.5">
                  {els.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground px-2 py-1">{t('图层内暂无元素', 'No elements')}</p>
                  ) : els.map((el) => {
                    const active = selectedElementId === el.id;
                    return (
                      <div
                        key={el.id}
                        onClick={() => { selectElement(el.id); useInteractionStore.getState().requestFocus(el.id); }}
                        className={`group flex items-center gap-1.5 px-2 py-1 mb-0.5 text-sm cursor-pointer rounded-md border transition-colors ${active ? 'bg-brand/15 border-brand/50' : 'bg-white/[0.02] border-white/[0.05] hover:bg-white/[0.06]'}`}
                      >
                        <span className="text-xs w-4 text-center shrink-0">{getElementIcon(el.type)}</span>
                        <span className={`flex-1 truncate text-[11px] ${el.visible === false ? 'text-muted-foreground line-through' : ''}`}>{el.name}</span>
                        <button onClick={(e) => { e.stopPropagation(); selectElement(el.id); openFx('popup'); }} className="p-0.5 rounded shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-white/10" title={t('特效', 'FX')}>✨</button>
                        <button onClick={(e) => { e.stopPropagation(); updateElement(el.id, { visible: el.visible === false }); }} className={`p-0.5 rounded shrink-0 ${el.visible === false ? 'text-muted-foreground' : 'text-foreground/70'} hover:text-foreground hover:bg-white/10`} title={el.visible === false ? t('显示', 'Show') : t('隐藏', 'Hide')}>
                          {el.visible === false ? <EyeOff size={12} /> : <Eye size={12} />}
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); deleteElement(el.id); }} className="p-0.5 rounded shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-white/10" title={t('删除', 'Delete')}>
                          <Trash2 size={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 底部统计 */}
      <div className="h-8 shrink-0 px-3 flex items-center border-t border-white/[0.06] text-[11px] text-muted-foreground">
        {t('图层', 'Layers')} {shown.length} / {layers.length} · {t('元素', 'elements')} {totalElements}
      </div>
    </div>
  );
}

function getElementIcon(type: MapElement['type']): string {
  const icons: Record<string, string> = {
    point: '📍', moving_point: '🏃', line: '📏', polygon: '⬛',
    arrow: '➡️', double_arrow: '🩹', encirclement: '⭕', gathering: '⚔️',
    connector: '🔗', flag: '🚩', territory: '🗺️', geo_image: '🖼️',
  };
  return icons[type] || '❓';
}

function layerIcon(type: LayerType): string {
  return ({ marker: '📍', route: '📏', shape: '⬛', territory: '🗺️', image: '🖼️' } as Record<string, string>)[type] || '📦';
}
