import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Layers, Search, Eye, EyeOff, FileDown, X, Trash2, Plus, ChevronRight, ChevronDown, Star, Upload, MoreVertical, GripVertical, FolderInput } from 'lucide-react';
import { useProjectStore, setHistoryMuted, snapshotHistory } from '../stores/projectStore';
import { useEditorStore } from '../stores/editorStore';
import { useInteractionStore } from '../stores/interactionStore';
import { uploadGeoJSON, elementsToGeoJSON } from '../lib/geojson';
import { saveLayerToPublic, layerTypeOf, movableLayersFor, LAYER_TYPE_LABEL, LAYER_TYPES } from '../lib/layers';
import { PublicLayerDialog } from './PublicLayerDialog';
import { useT } from './ui/primitives';
import type { Layer, LayerType, MapElement } from '../types';

const menuItem = 'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] text-foreground/85 hover:bg-white/10 transition-colors';

/**
 * 面板内的浮层菜单：portal 到 body + fixed 定位到触发按钮旁。
 * 图层列表容器带 overflow 裁切，内联展开会把列表撑开一截，所以必须脱离文档流。
 */
function MenuPopover({ rect, onClose, children, width = 176 }: {
  rect: DOMRect; onClose: () => void; children: ReactNode; width?: number;
}) {
  const below = window.innerHeight - rect.bottom;
  const up = below < 200 && rect.top > below;
  return createPortal(
    <>
      <div className="fixed inset-0 z-[60]" onClick={onClose} />
      <div
        className="fixed z-[61] rounded-md border border-white/[0.12] bg-[#171412] shadow-2xl p-1"
        style={{
          left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
          width,
          ...(up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
        }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

/**
 * 左侧浮动「图层」面板：图层列表（新增 / 删除 / 显隐 / 展开元素 / 拖动排序）+ 搜索
 * + 每图层 GeoJSON 导入导出 / 加入公共图层；公共图层库走 PublicLayerDialog。
 */
export function ElementsPanel() {
  const project = useProjectStore((s) => s.project);
  const addElements = useProjectStore((s) => s.addElements);
  const updateElement = useProjectStore((s) => s.updateElement);
  const deleteElement = useProjectStore((s) => s.deleteElement);
  const moveElementsToLayer = useProjectStore((s) => s.moveElementsToLayer);
  const addLayer = useProjectStore((s) => s.addLayer);
  const updateLayer = useProjectStore((s) => s.updateLayer);
  const deleteLayer = useProjectStore((s) => s.deleteLayer);
  const moveLayer = useProjectStore((s) => s.moveLayer);
  const selectedElementId = useEditorStore((s) => s.selectedElementId);
  const selectElement = useEditorStore((s) => s.selectElement);
  const selectedLayerId = useEditorStore((s) => s.selectedLayerId);
  const selectLayer = useEditorStore((s) => s.selectLayer);
  const focusLayer = useEditorStore((s) => s.focusLayer);
  const setElementsOpen = useEditorStore((s) => s.setElementsOpen);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [newLayerOpen, setNewLayerOpen] = useState(false);
  const [menuLayer, setMenuLayer] = useState<{ id: string; rect: DOMRect } | null>(null);
  /** 展开「移动到…」菜单的元素（附触发按钮矩形，用于定位浮层） */
  const [menuEl, setMenuEl] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [nameDraft, setNameDraft] = useState<Record<string, string>>({});
  const [pubOpen, setPubOpen] = useState(false);
  const geoRef = useRef<HTMLInputElement>(null);
  const importingLayerRef = useRef<string | null>(null);
  const dragLayerRef = useRef<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const t = useT();

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

  /** 图层改名：失焦/回车时落一次历史（逐字符写 store 会把 50 格撤销栈吃满） */
  const commitLayerName = (L: Layer) => {
    const draft = nameDraft[L.id];
    if (draft === undefined) return;
    setNameDraft((m) => { const next = { ...m }; delete next[L.id]; return next; });
    const name = draft.trim();
    if (name && name !== L.name) updateLayer(L.id, { name });
  };

  /** 加入公共图层：先落盘当前项目（桌面端整层复制读的是库里的当前态），再复制 */
  const saveToPublic = async (L: Layer) => {
    try {
      await useProjectStore.getState().saveProject();
      const dropped = await saveLayerToPublic(L);
      if (dropped.length) {
        alert(t(
          `已跳过 ${dropped.length} 条连接线（端点指向本图层外的元素，公共图层无法自洽）：${dropped.join('、')}`,
          `Skipped ${dropped.length} connector(s) whose endpoints live outside this layer: ${dropped.join(', ')}`,
        ));
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="h-full flex flex-col rounded-xl overflow-hidden">
      {/* 头部：图层 + 新建 + 公共 + 关闭 */}
      <div className="h-12 shrink-0 px-3 flex items-center gap-1.5 bg-white/[0.05] border-b border-white/[0.06]">
        <Layers size={14} className="text-muted-foreground shrink-0" />
        <span className="text-sm font-medium text-foreground shrink-0">{t('图层', 'Layers')}</span>
        {/* 新建图层（下拉选类型） */}
        <div className="relative shrink-0">
          <button
            onClick={() => setNewLayerOpen((v) => !v)}
            className={`h-7 px-2 rounded-md border text-xs transition-colors flex items-center gap-1 ${newLayerOpen ? 'border-brand bg-brand/20 text-foreground' : 'border-white/10 bg-white/[0.045] hover:border-white/25'}`}
            title={t('新建图层', 'New layer')}
          >
            <Plus size={13} /> {t('新建', 'New')}
          </button>
          {newLayerOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setNewLayerOpen(false)} />
              <div className="absolute left-0 top-8 z-40 w-32 rounded-lg bg-[#171412]/98 backdrop-blur-md border border-white/[0.14] shadow-2xl p-1">
                {LAYER_TYPES.map((lt) => (
                  <button key={lt} onClick={() => { addLayer(lt); setNewLayerOpen(false); }} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] text-foreground/85 hover:bg-white/10 transition-colors">
                    {layerIcon(lt)} {t(LAYER_TYPE_LABEL[lt], lt)}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        {/* 公共图层库（弹窗搜索） */}
        <button
          onClick={() => setPubOpen(true)}
          className="h-7 px-2 rounded-md border border-white/10 bg-white/[0.045] text-xs hover:border-white/25 transition-colors flex items-center gap-1 shrink-0"
          title={t('公共图层库', 'Public layers')}
        >
          <Star size={13} /> {t('公共', 'Public')}
        </button>
        <div className="flex-1" />
        <button onClick={() => setElementsOpen(false)} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5 shrink-0" title={t('收起', 'Collapse')}>
          <X size={14} />
        </button>
      </div>

      {/* 搜索 */}
      <div className="px-3 pt-2.5 pb-1">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('搜索图层或元素...', 'Search layers or elements...')}
            className="input pl-7 h-8 text-xs"
          />
        </div>
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
            <div key={L.id} className={`relative mb-1 rounded-lg border transition-colors ${selectedLayerId === L.id ? 'border-brand/60 bg-brand/10' : 'border-white/[0.06] bg-white/[0.03]'}`}>
              {/* 图层行（可拖动排序：拖过即实时重排） */}
              <div
                className={`group flex items-center gap-1.5 px-2 py-1.5 text-sm transition-opacity ${dragId === L.id ? 'opacity-40' : ''}`}
                onClick={() => selectLayer(L.id, L.type)}
                onDragOver={(e) => e.preventDefault()}
                onDragEnter={() => { const from = dragLayerRef.current; if (from && from !== L.id) moveLayer(from, L.id); }}
                onDrop={(e) => e.preventDefault()}
              >
                <span
                  draggable
                  onDragStart={(e) => { dragLayerRef.current = L.id; setDragId(L.id); setHistoryMuted(true); snapshotHistory(); e.dataTransfer.setData('text/plain', L.id); e.dataTransfer.effectAllowed = 'move'; }}
                  onDragEnd={() => { dragLayerRef.current = null; setDragId(null); setHistoryMuted(false); }}
                  className="shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground/60 hover:text-foreground"
                  title={t('拖动调整顺序', 'Drag to reorder')}
                >
                  <GripVertical size={13} />
                </span>
                <button onClick={() => setExpanded((m) => ({ ...m, [L.id]: !open }))} className="p-0.5 rounded shrink-0 text-muted-foreground hover:text-foreground" title={t('展开/收起', 'Expand')}>
                  {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
                <span className="shrink-0 text-xs">{layerIcon(L.type)}</span>
                <input
                  value={nameDraft[L.id] ?? L.name}
                  onChange={(e) => setNameDraft((m) => ({ ...m, [L.id]: e.target.value }))}
                  onBlur={() => commitLayerName(L)}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  onClick={(e) => e.stopPropagation()}
                  className={`flex-1 min-w-0 bg-transparent text-xs font-medium outline-none rounded px-1 py-0.5 focus:bg-white/10 ${L.visible === false ? 'text-muted-foreground line-through' : ''}`}
                  title={L.name}
                />
                <span className="shrink-0 text-[10px] text-muted-foreground">({L.elements.length})</span>
                <button onClick={() => updateLayer(L.id, { visible: L.visible === false })} className={`p-1 rounded shrink-0 ${L.visible === false ? 'text-muted-foreground' : 'text-foreground/70'} hover:text-foreground hover:bg-white/10`} title={L.visible === false ? t('显示', 'Show') : t('隐藏', 'Hide')}>
                  {L.visible === false ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button
                  onClick={(e) => setMenuLayer(menuLayer?.id === L.id ? null : { id: L.id, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() })}
                  className={`p-1 rounded shrink-0 hover:text-foreground hover:bg-white/10 transition-colors ${menuLayer?.id === L.id ? 'text-foreground bg-white/10' : 'text-muted-foreground'}`}
                  title={t('更多', 'More')}
                >
                  <MoreVertical size={13} />
                </button>
              </div>
              {/* 图层操作菜单：portal 浮层（面板有 overflow 裁切，内联展开会把列表撑开） */}
              {menuLayer?.id === L.id && (
                <MenuPopover rect={menuLayer.rect} onClose={() => setMenuLayer(null)}>
                  <button onClick={() => { setMenuLayer(null); importingLayerRef.current = L.id; geoRef.current?.click(); }} className={menuItem}>
                    <Upload size={12} /> {t('导入 GeoJSON', 'Import GeoJSON')}
                  </button>
                  <button onClick={() => { setMenuLayer(null); exportLayer(L); }} className={menuItem}>
                    <FileDown size={12} /> {t('导出 GeoJSON', 'Export GeoJSON')}
                  </button>
                  <button onClick={() => { setMenuLayer(null); void saveToPublic(L); }} className={`${menuItem} text-amber-300/90`}>
                    <Star size={12} /> {t('加入公共图层', 'Save to public')}
                  </button>
                  <div className="my-1 h-px bg-white/[0.08]" />
                  <button onClick={() => { setMenuLayer(null); deleteLayer(L.id); }} className={`${menuItem} text-red-400/90`}>
                    <Trash2 size={12} /> {t('删除图层', 'Delete layer')}
                  </button>
                </MenuPopover>
              )}
              {/* 元素行 */}
              {open && (
                <div className="px-1.5 pb-1.5">
                  {els.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground px-2 py-1">{t('图层内暂无元素', 'No elements')}</p>
                  ) : els.map((el) => {
                    const active = selectedElementId === el.id;
                    const dst = movableLayersFor(layers, el);
                    return (
                      <div key={el.id}>
                        <div
                          onClick={() => { focusLayer(L.id); selectElement(el.id); useInteractionStore.getState().requestFocus(el.id); }}
                          className={`group flex items-center gap-1.5 px-2 py-1 mb-0.5 text-sm cursor-pointer rounded-md border transition-colors ${active ? 'bg-brand/15 border-brand/50' : 'bg-white/[0.02] border-white/[0.05] hover:bg-white/[0.06]'}`}
                        >
                          <span className="text-xs w-4 text-center shrink-0">{getElementIcon(el.type)}</span>
                          <span className={`flex-1 truncate text-[11px] ${el.visible === false ? 'text-muted-foreground line-through' : ''}`}>{el.name}</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); setMenuEl(menuEl?.id === el.id ? null : { id: el.id, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() }); }}
                            className={`p-0.5 rounded shrink-0 text-muted-foreground group-hover:opacity-100 hover:text-foreground hover:bg-white/10 ${menuEl?.id === el.id ? 'opacity-100 text-foreground' : 'opacity-0'}`}
                            title={dst.length ? t('移动到其它图层', 'Move to another layer') : t('没有其它同类型图层', 'No other layer of this type')}
                            disabled={!dst.length}
                          >
                            <FolderInput size={12} />
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); updateElement(el.id, { visible: el.visible === false }); }} className={`p-0.5 rounded shrink-0 ${el.visible === false ? 'text-muted-foreground' : 'text-foreground/70'} hover:text-foreground hover:bg-white/10`} title={el.visible === false ? t('显示', 'Show') : t('隐藏', 'Hide')}>
                            {el.visible === false ? <EyeOff size={12} /> : <Eye size={12} />}
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); deleteElement(el.id); }} className="p-0.5 rounded shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-white/10" title={t('删除', 'Delete')}>
                            <Trash2 size={12} />
                          </button>
                        </div>
                        {/* 「移动到…」：portal 浮层，只列同类型图层（图层单类型，跨类型只能改元素类型） */}
                        {menuEl?.id === el.id && dst.length > 0 && (
                          <MenuPopover rect={menuEl.rect} onClose={() => setMenuEl(null)}>
                            <p className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">
                              {t(`移动到${LAYER_TYPE_LABEL[layerTypeOf(el)]}图层`, 'Move to layer')}
                            </p>
                            {dst.map((D) => (
                              <button
                                key={D.id}
                                onClick={(e) => { e.stopPropagation(); moveElementsToLayer([el.id], D.id); setMenuEl(null); }}
                                className={menuItem}
                              >
                                <span className="flex-1 text-left truncate">{D.name}</span>
                                <span className="shrink-0 text-[10px] text-muted-foreground/70">{D.elements.length}</span>
                              </button>
                            ))}
                          </MenuPopover>
                        )}
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

      {pubOpen && <PublicLayerDialog onClose={() => setPubOpen(false)} />}
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
