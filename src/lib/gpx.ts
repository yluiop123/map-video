// GPX 轨迹文件解析 → 线路径坐标
export interface GpxTrack {
  /** 轨迹名（trk/name 或文件名） */
  name: string;
  /** [lng, lat] 坐标串 */
  coords: [number, number][];
}

/**
 * 解析 GPX XML（支持 <trkpt> / <rtept>，多 <trkseg> 合并）
 */
export function parseGpx(xmlText: string, fallbackName = 'GPX 轨迹'): GpxTrack {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('GPX 文件解析失败');
  }

  const readPoint = (el: Element): [number, number] | null => {
    const lat = parseFloat(el.getAttribute('lat') ?? 'NaN');
    const lon = parseFloat(el.getAttribute('lon') ?? 'NaN');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    // 经度在前
    return [lon, lat];
  };

  const coords: [number, number][] = [];

  // 轨迹点（多段合并）
  doc.querySelectorAll('trkpt').forEach((pt) => {
    const c = readPoint(pt);
    if (c) coords.push(c);
  });

  // 无轨迹则退回路线点
  if (coords.length === 0) {
    doc.querySelectorAll('rtept').forEach((pt) => {
      const c = readPoint(pt);
      if (c) coords.push(c);
    });
  }

  // 仅一个独立点位时也接受
  if (coords.length === 0) {
    doc.querySelectorAll('wpt').forEach((pt) => {
      const c = readPoint(pt);
      if (c) coords.push(c);
    });
  }

  if (coords.length < 2) {
    throw new Error('GPX 中未找到有效轨迹（需要至少 2 个轨迹点）');
  }

  const nameEl = doc.querySelector('trk > name, rte > name');
  const name = nameEl?.textContent?.trim() || fallbackName;

  return { name: name || fallbackName, coords };
}
