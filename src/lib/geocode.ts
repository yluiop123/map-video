/**
 * geocode.ts — 联网地理编码（OpenStreetMap Nominatim，与顶栏地名搜索同源）
 *
 * 用于本地地名库（gazetteer）未命中时的补充查询；查不到返回 null，
 * 由调用方提示用户手工提供坐标。
 */
export interface GeoHit {
  center: [number, number];
  zoom?: number;
  displayName?: string;
}

export async function geocodePlace(name: string): Promise<GeoHit | null> {
  const q = name.trim();
  if (q.length < 2) return null;
  try {
    const url =
      'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=zh-CN' +
      '&q=' + encodeURIComponent(q);
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const data = (await res.json()) as { lat: string; lon: string; display_name?: string; boundingbox?: string[] }[];
    const r = data[0];
    if (!r) return null;
    const lat = parseFloat(r.lat);
    const lon = parseFloat(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    let zoom = 8;
    const bb = r.boundingbox; // [south, north, west, east]
    if (bb && bb.length === 4) {
      const span = Math.max(parseFloat(bb[1]) - parseFloat(bb[0]), parseFloat(bb[3]) - parseFloat(bb[2]));
      if (span > 0) zoom = Math.max(3, Math.min(11, Math.round(Math.log2(360 / span)) - 1));
    }
    return { center: [lon, lat], zoom, displayName: r.display_name };
  } catch {
    return null;
  }
}
