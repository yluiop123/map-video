// 疆域导入对话框：内置势力库（搜索选国边界，MultiPolygon 自动拆地块） / GeoJSON 上传
// 导入合并进目标疆域元素（选中元素为疆域则用之，否则自动新建）
import { useEffect, useMemo, useRef, useState } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useEditorStore } from '../stores/editorStore';
import { generateId } from '../types';
import { listRegionNames, findRegionByName, regionHitsToShapes } from '../lib/regions';
import {
  defaultTerritoryDisplay, mergeShapesIntoTerritory, parseTerritoryGeoJSON,
  type TerritoryShapeInput,
} from '../lib/territory';
import { sharedMap } from '../lib/shared-map';
import { cnName } from './RegionPickerDialog';
import type { TerritoryElement } from '../types';

interface TerritoryImportDialogProps {
  onClose: () => void;
}

export function TerritoryImportDialog({ onClose }: TerritoryImportDialogProps) {
  const project = useProjectStore((s) => s.project);
  const addElement = useProjectStore((s) => s.addElement);
  const updateElement = useProjectStore((s) => s.updateElement);
  const selectedElementId = useEditorStore((s) => s.selectedElementId);
  const selectElement = useEditorStore((s) => s.selectElement);

  const [tab, setTab] = useState<'built' | 'geojson'>('built');
  const [names, setNames] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [geo, setGeo] = useState<TerritoryShapeInput[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const chapter = project;

  useEffect(() => {
    let alive = true;
    listRegionNames()
      .then((n) => { if (alive) setNames(n); })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : '势力边界数据加载失败'); });
    return () => { alive = false; };
  }, []);

  /** 目标疆域：当前选中的疆域元素；否则新建一个并选中 */
  const ensureTarget = (): { chapterId: string; el: TerritoryElement } | null => {
    if (!chapter) return null;
    const sel = chapter.elements.find((e) => e.id === selectedElementId);
    if (sel?.type === 'territory') return { chapterId: chapter.id, el: sel as TerritoryElement };
    const el: TerritoryElement = {
      id: generateId(), type: 'territory', name: '疆域', visible: true, locked: false,
      startFrame: 0, endFrame: chapter.endFrame, style: {},
      countries: [], plots: [], events: [], display: defaultTerritoryDisplay(),
    };
    addElement(el);
    selectElement(el.id);
    return { chapterId: chapter.id, el };
  };

  /** 合并入库（同名地块跳过防重） */
  const applyShapes = (tgt: { chapterId: string; el: TerritoryElement }, shapes: TerritoryShapeInput[], label: string) => {
    const existing = new Set(tgt.el.plots.map((p) => p.name));
    const fresh = shapes.filter((s) => !existing.has(s.plotName));
    const skipped = shapes.length - fresh.length;
    if (fresh.length === 0) {
      setMsg(`「${label}」的地块已存在，跳过${skipped ? `（重复 ${skipped}）` : ''}`);
      return;
    }
    const merged = mergeShapesIntoTerritory(tgt.el, fresh);
    updateElement(tgt.el.id, { countries: merged.countries, plots: merged.plots } as any);
    const cCount = new Set(fresh.map((s) => s.countryName)).size;
    // 导入成功后：视野定位到新增地块范围（无需手动去地图上找）
    const map = sharedMap.get();
    if (map) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of fresh) {
        for (const ring of s.rings) {
          for (const pt of ring) {
            if (pt[0] < minX) minX = pt[0];
            if (pt[1] < minY) minY = pt[1];
            if (pt[0] > maxX) maxX = pt[0];
            if (pt[1] > maxY) maxY = pt[1];
          }
        }
      }
      if (Number.isFinite(minX) && minX < maxX) {
        try { map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 90, duration: 700, maxZoom: 9 }); } catch { /* ignore */ }
      }
    }
    setMsg(`已导入 ${label}：${cCount} 个势力 / ${fresh.length} 个地块${skipped ? `，跳过重复 ${skipped}` : ''}`);
  };

  const importBuilt = async (en: string) => {
    const tgt = ensureTarget();
    if (!tgt || busy) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const hit = await findRegionByName(en);
      if (!hit) { setErr('未找到该区域边界'); return; }
      const cn = cnName(en);
      // regionHitsToShapes 会给 MultiPolygon 各面加 ·N 后缀：国名取纯名（中文），地块名带后缀
      const shapes: TerritoryShapeInput[] = regionHitsToShapes([hit]).map((s) => {
        const m = /^(.*?)(·\d+)$/.exec(s.name);
        const suffix = m ? m[2] : '';
        return { countryName: cn, plotName: `${cn}${suffix}`, rings: s.rings as [number, number][][] };
      });
      applyShapes(tgt, shapes, cn);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '导入失败');
    } finally {
      setBusy(false);
    }
  };

  const onPickFile = (file: File | undefined) => {
    if (!file) return;
    setErr(null); setMsg(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parseTerritoryGeoJSON(JSON.parse(reader.result as string));
        if (!parsed.length) { setErr('未找到面要素（Polygon / MultiPolygon）'); setGeo(null); return; }
        setGeo(parsed);
      } catch {
        setErr('GeoJSON 解析失败'); setGeo(null);
      }
    };
    reader.onerror = () => setErr('文件读取失败');
    reader.readAsText(file);
  };

  const importGeo = () => {
    const tgt = ensureTarget();
    if (!tgt || !geo) return;
    applyShapes(tgt, geo, 'GeoJSON');
  };

  // 过滤：中文名 / 英文名
  const filtered = useMemo(() => {
    if (!names) return [];
    const query = q.trim().toLowerCase();
    if (!query) return names;
    return names.filter((n) => {
      const cn = cnName(n);
      return n.toLowerCase().includes(query) || cn.toLowerCase().includes(query);
    });
  }, [names, q]);

  const geoCountries = geo ? new Set(geo.map((s) => s.countryName)).size : 0;

  return (
    <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-card border border-white/10 rounded-xl shadow-xl w-[460px] max-w-[92vw] flex flex-col"
        style={{ maxHeight: '80vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-4 pb-2">
          <h2 className="text-base font-semibold">🗺️ 导入疆域</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            导入到「{chapter?.name || '-'}」{project ? '' : ''}
            {(() => {
              const sel = chapter?.elements.find((e) => e.id === selectedElementId);
              return sel?.type === 'territory' ? ` · 疆域「${sel.name}」` : ' · 将新建疆域';
            })()}
          </p>
        </div>

        {/* Tabs */}
        <div className="px-4 pb-2 flex gap-1">
          {([['built', '内置势力库'], ['geojson', 'GeoJSON 上传']] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                tab === k ? 'bg-brand/20 border-brand text-foreground' : 'bg-white/[0.04] border-white/10 text-foreground/80 hover:bg-white/10'
              }`}
            >{label}</button>
          ))}
        </div>

        {tab === 'built' && (
          <>
            <div className="px-4 pb-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索：中国 / Japan / 巴西 …"
                className="w-full px-3 py-2 text-sm bg-background border rounded"
              />
            </div>
            <div className="flex-1 overflow-y-auto px-4 pb-2" style={{ minHeight: 180 }}>
              {err && (
                <div className="text-xs text-red-500 py-4 text-center">
                  {err}
                  <button
                    onClick={() => { setErr(null); setNames(null); listRegionNames().then(setNames).catch((e2) => setErr(e2.message)); }}
                    className="ml-2 underline"
                  >重试</button>
                </div>
              )}
              {!err && names === null && (
                <div className="text-xs text-muted-foreground py-6 text-center">势力边界数据加载中…（首次约 250KB）</div>
              )}
              {names !== null && filtered.length === 0 && (
                <div className="text-xs text-muted-foreground py-6 text-center">未匹配区域</div>
              )}
              {names !== null && filtered.length > 0 && (
                <div className="grid grid-cols-2 gap-1 pb-2">
                  {filtered.map((n) => (
                    <button
                      key={n}
                      disabled={busy}
                      onClick={() => importBuilt(n)}
                      className="text-left px-2 py-1.5 text-xs border rounded hover:bg-accent disabled:opacity-50 truncate"
                      title={busy ? '导入中…' : `导入 ${cnName(n)}`}
                    >
                      <span className="font-medium">{cnName(n)}</span>
                      {cnName(n) !== n && <span className="text-muted-foreground ml-1">{n}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'geojson' && (
          <div className="px-4 pb-3 space-y-2">
            <input
              ref={fileRef}
              type="file"
              accept=".geojson,.json,application/geo+json,application/json"
              className="hidden"
              onChange={(e) => onPickFile(e.target.files?.[0])}
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="w-full py-6 text-sm border border-dashed rounded-lg bg-white/[0.03] hover:bg-white/[0.06] transition-colors text-muted-foreground"
            >
              点击选择 GeoJSON 文件（FeatureCollection）<br />
                <span className="text-[10px]">按 country 属性聚合势力；MultiPolygon 自动拆分地块</span>
            </button>
            {geo && (
              <div className="text-xs text-foreground/85 bg-white/[0.04] border border-white/10 rounded-lg px-3 py-2">
                已解析：{geoCountries} 个势力 / {geo.length} 个地块
              </div>
            )}
            <button
              disabled={!geo || busy}
              onClick={importGeo}
              className="w-full py-2 text-sm font-medium rounded-md bg-brand text-white disabled:opacity-40"
            >导入</button>
          </div>
        )}

        <div className="px-4 py-2 border-t flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground truncate">
            {err && <span className="text-red-500">{err}</span>}
            {!err && msg && <span className="text-emerald-500">{msg}</span>}
            {!err && !msg && busy && <span>导入中…</span>}
          </span>
          <button onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground shrink-0">完成</button>
        </div>
      </div>
    </div>
  );
}
