// 带箭头直线/箭头曲线：line 元素 + lineArrow（末端方向小箭头），行军箭头保留
const fs = require('fs');
const rep = (s, a, b, tag) => {
  if (!s.includes(a)) { console.log('MISS', tag); process.exit(1); }
  return s.split(a).join(b);
};

// 1) types: LineElement.lineArrow
let t = fs.readFileSync('src/types/index.ts', 'utf8');
t = rep(t, '  lineType?: \'straight\' | \'bezier\' | \'arc\';',
  '  lineType?: \'straight\' | \'bezier\' | \'arc\';\n  lineArrow?: boolean;         // 线末端方向箭头（示意方向）', 'lineArrow-type');
fs.writeFileSync('src/types/index.ts', t, 'utf8');

// 2) renderLine：箭头头部图层
const p = 'src/lib/map-renderer.ts';
let s = fs.readFileSync(p, 'utf8');
s = rep(s,
`  // 线中点文案
  const labelSourceId = \`linelabel-src-\${element.id}\`;`,
`  // 方向箭头（示意）：线末端小三角，随线色
  const headSrcId = \`line-head-src-\${element.id}\`;
  const headLayerId = \`line-head-\${element.id}\`;
  const showHead = !!element.lineArrow && progress >= 1 && effective.length >= 2;
  if (showHead) {
    const zoom = map.getZoom();
    const tipLL = effective[effective.length - 1] as [number, number];
    const prevLL = effective[effective.length - 2] as [number, number];
    const a = map.project(prevLL);
    const b = map.project(tipLL);
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const size = (element.lineWidth || 3) * 4;
    const c1 = [b.x + (-dy) * size * 0.5, b.y + dx * size * 0.5];
    const c2 = [b.x - (-dy) * size * 0.5, b.y - dx * size * 0.5];
    const tip = [b.x + dx * size, b.y + dy * size];
    const toLL = (px: number, py: number): [number, number] => {
      const ll = map.unproject([px, py]);
      return [ll.lng, ll.lat];
    };
    const ring = [toLL(tip[0], tip[1]), toLL(c1[0], c1[1]), toLL(c2[0], c2[1]), toLL(tip[0], tip[1])];
    const headData = turf.featureCollection([turf.polygon([ring])]);
    try {
      if (map.getSource(headSrcId)) {
        (map.getSource(headSrcId) as GeoJSONSource).setData(headData);
        if (map.getLayer(headLayerId)) {
          map.setPaintProperty(headLayerId, 'fill-color', element.lineColor || '#FF0000');
          map.setLayoutProperty(headLayerId, 'visibility', 'visible');
        }
      } else {
        map.addSource(headSrcId, { type: 'geojson', data: headData } as any);
        map.addLayer({
          id: headLayerId, type: 'fill', source: headSrcId,
          paint: { 'fill-color': element.lineColor || '#FF0000', 'fill-opacity': 1 },
        });
        if (map.getLayer(headLayerId)) map.moveLayer(headLayerId);
      }
    } catch { /* style 未就绪 */ }
  } else if (map.getLayer(headLayerId)) {
    map.setLayoutProperty(headLayerId, 'visibility', 'none');
  }

  // 线中点文案
  const labelSourceId = \`linelabel-src-\${element.id}\`;`
, 'renderLine-head');

fs.writeFileSync(p, s, 'utf8');
console.log('renderer head:', s.includes('line-head-src-'));
