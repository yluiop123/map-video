/**
 * PublicLayerDialog — 公共图层库弹窗：按「类型 + 名称」搜索，导入到当前项目。
 * 桌面端走后端 DB（整层复制），网页端走 localStorage。
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, Star, Upload, Trash2 } from 'lucide-react';
import { useProjectStore } from '../stores/projectStore';
import { listPublicLayers, importPublicLayer, removePublicLayer, layerTypeOf, LAYER_TYPE_LABEL, type PublicLayerInfo } from '../lib/layers';
import { useT, OptionBlocks } from './ui/primitives';
import { generateId, type LayerType, type MapElement } from '../types';

export function PublicLayerDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const project = useProjectStore((s) => s.project);
  const addLayerFull = useProjectStore((s) => s.addLayerFull);
  const [list, setList] = useState<PublicLayerInfo[]>([]);
  const [q, setQ] = useState('');
  const [type, setType] = useState<LayerType | 'all'>('all');
  const [busy, setBusy] = useState(false);

  const load = () => { void listPublicLayers().then(setList).catch(() => setList([])); };
  useEffect(load, []);

  const kw = q.trim().toLowerCase();
  const shown = list.filter((x) => (type === 'all' || x.type === type) && (!kw || x.name.toLowerCase().includes(kw) || LAYER_TYPE_LABEL[x.type].includes(kw)));

  const doImport = async (pl: PublicLayerInfo) => {
    if (!project) return;
    setBusy(true);
    try {
      const r = await importPublicLayer(pl.id, project.id);
      if (r.layerId) {
        await useProjectStore.getState().loadProject(project.id);
      } else if (r.local) {
        const min = Math.min(...r.local.elements.map((el) => el.startFrame ?? 0), 0);
        const els = r.local.elements.map((el) => ({ ...el, startFrame: el.startFrame - min, endFrame: el.endFrame - min })) as MapElement[];
        const lt = els.length ? layerTypeOf(els[0]) : 'marker';
        addLayerFull({ id: generateId(), type: lt, name: r.local.name, visible: true, startFrame: 0, endFrame: Math.max(1, project.endFrame), elements: els });
      }
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doRemove = async (id: string) => { await removePublicLayer(id); load(); };

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div className="w-[30rem] max-h-[82vh] flex flex-col bg-card border border-white/10 rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* 头 */}
        <div className="h-12 shrink-0 px-4 flex items-center justify-between border-b border-white/[0.06]">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Star size={14} className="text-amber-400" /> {t('公共图层', 'Public layers')}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5" title={t('关闭', 'Close')}>
            <X size={14} />
          </button>
        </div>

        {/* 搜索 + 类型筛选 */}
        <div className="px-4 pt-3 space-y-2 shrink-0">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('按图层名称搜索...', 'Search by layer name...')}
              className="input pl-7 h-8 text-xs"
            />
          </div>
          <OptionBlocks<LayerType | 'all'>
            value={type}
            onChange={setType}
            options={[
              { value: 'all', label: t('全部', 'All') },
              { value: 'marker', label: t('标记', 'Marker') },
              { value: 'route', label: t('路线', 'Route') },
              { value: 'shape', label: t('形状', 'Shape') },
              { value: 'territory', label: t('疆域', 'Terr') },
              { value: 'image', label: t('图片', 'Image') },
            ]}
          />
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1.5 min-h-0">
          {shown.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-10">{t('无匹配的公共图层', 'No matching public layers')}</p>
          ) : shown.map((pl) => (
            <div key={pl.id} className="group flex items-center gap-2 rounded-md border border-white/[0.07] bg-white/[0.03] px-2 py-1.5">
              <span className="text-xs shrink-0">{layerIcon(pl.type)}</span>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">{pl.name}</div>
                <div className="text-[10px] text-muted-foreground">{t(LAYER_TYPE_LABEL[pl.type], pl.type)} · {pl.count} {t('个元素', 'elements')}</div>
              </div>
              <button
                onClick={() => void doImport(pl)}
                disabled={busy}
                className="h-7 px-2 rounded-md border border-white/15 bg-white/[0.05] text-[11px] hover:border-white/30 hover:bg-white/10 transition-colors disabled:opacity-40 flex items-center gap-1"
              >
                <Upload size={11} /> {t('导入', 'Import')}
              </button>
              <button onClick={() => void doRemove(pl.id)} className="p-1 rounded text-muted-foreground hover:text-red-400 hover:bg-white/10" title={t('删除', 'Delete')}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>

        <div className="h-9 shrink-0 px-4 flex items-center border-t border-white/[0.06] text-[11px] text-muted-foreground">
          {t('共', 'Total')} {shown.length} / {list.length} {t('个公共图层', 'public layers')}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function layerIcon(type: LayerType): string {
  return ({ marker: '📍', route: '📏', shape: '⬛', territory: '🗺️', image: '🖼️' } as Record<string, string>)[type] || '📦';
}
