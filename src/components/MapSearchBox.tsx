import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';

interface NominatimResult {
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
  class?: string;
  boundingbox?: [string, string, string, string]; // south, north, west, east
}

interface MapSearchBoxProps {
  /** 取地图实例（可能尚未加载完成） */
  getMap: () => maplibregl.Map | null;
}

/**
 * 地名搜索：输入城市/地标/地址 → Nominatim 检索 → 点击结果地图跳转。
 * 也支持直接输入坐标，如 "31.23,121.47"。
 */
export function MapSearchBox({ getMap }: MapSearchBoxProps) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<NominatimResult[]>([]);
  const boxRef = useRef<HTMLDivElement>(null);

  // 防抖检索
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) { setResults([]); setOpen(false); setLoading(false); return; }
    // 直接坐标
    const coord = parseCoord(query);
    if (coord) {
      setResults([{
        display_name: `${coord[1].toFixed(5)}, ${coord[0].toFixed(5)}（坐标）`,
        lat: String(coord[1]),
        lon: String(coord[0]),
      }]);
      setOpen(true);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const url =
          'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=zh-CN' +
          '&q=' + encodeURIComponent(query);
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        const data = (await res.json()) as NominatimResult[];
        if (!cancelled) { setResults(data); setOpen(true); }
      } catch { /* 网络失败静默 */ }
      finally { if (!cancelled) setLoading(false); }
    }, 450);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [q]);

  // 点击外部关闭
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, []);

  const jumpTo = (r: NominatimResult) => {
    const map = getMap();
    if (!map) return;
    const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
    // 用 boundingbox 自适应缩放，避免"该国一眼看不到全貌"
    const bb = r.boundingbox;
    try {
      if (bb && bb.length === 4 && bb.every((v) => v !== undefined)) {
        const s = parseFloat(bb[0]), n = parseFloat(bb[1]), w = parseFloat(bb[2]), e = parseFloat(bb[3]);
        map.fitBounds([[w, s], [e, n]], { padding: 60, duration: 900, maxZoom: 12 });
      } else {
        map.flyTo({ center: [lon, lat], zoom: 10, duration: 900 });
      }
    } catch {
      map.flyTo({ center: [lon, lat], zoom: 10, duration: 900 });
    }
    setOpen(false);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && results.length > 0) {
      e.preventDefault();
      jumpTo(results[0]);
    }
  };

  return (
    <div ref={boxRef} className="relative flex-1 max-w-[440px] min-w-0 mx-2">
      <div className="relative">
        <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => { if (results.length > 0) setOpen(true); }}
          onKeyDown={handleKey}
          placeholder="搜索地名 / 坐标（Enter 跳转）"
          className="w-full h-9 pl-8 pr-3 text-sm bg-white/[0.045] text-foreground rounded-lg border border-white/10 placeholder:text-muted-foreground focus:outline-none focus:border-white/25"
        />
      </div>
      {loading && (
        <div className="absolute left-0 right-0 top-full mt-1 px-3 py-1 text-xs bg-card border border-white/15 text-muted-foreground rounded-lg shadow-xl z-50">搜索中…</div>
      )}
      {open && !loading && results.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 bg-card border border-white/15 rounded-lg shadow-2xl overflow-hidden z-50">
          {results.map((r, i) => (
            <button
              key={i}
              onClick={() => jumpTo(r)}
              className="block w-full text-left px-3 py-2 text-xs text-foreground hover:bg-white/10 whitespace-nowrap overflow-hidden text-ellipsis"
              title={r.display_name}
            >
              {r.display_name}
            </button>
          ))}
        </div>
      )}
      {open && !loading && results.length === 0 && q.trim().length >= 2 && (
        <div className="absolute left-0 right-0 top-full mt-1 px-3 py-2 text-xs bg-card border border-white/15 text-muted-foreground rounded-lg shadow-xl z-50">未找到匹配地点</div>
      )}
    </div>
  );
}

/** 解析 "纬度,经度" 或 "lat lng" 形式的坐标输入 */
function parseCoord(q: string): [number, number] | null {
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const a = parseFloat(m[1]), b = parseFloat(m[2]);
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  // 约定 [lng, lat] 输出；用户一般按 "纬度,经度" 或 "lng, lat" 均可容忍
  return Math.abs(a) <= 90 && Math.abs(b) <= 180 ? [b, a] : null;
}
