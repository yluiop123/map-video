// 箭头直线/箭头曲线 → line+lineArrow；行军箭头(military curved)独立选项
const fs = require('fs');
const p = 'src/components/PropertiesPanel.tsx';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b, tag) => {
  if (!s.includes(a)) { console.log('MISS', tag); process.exit(1); }
  return s.split(a).join(b);
};

// 1) RouteStyle：military-arrow 替代
rep("type RouteStyle = 'straight' | 'bezier' | 'arc' | 'swallowtail' | 'curved' | 'pincer' | 'straight-arrow' | 'curved-arrow';",
    "type RouteStyle = 'straight' | 'bezier' | 'arc' | 'swallowtail' | 'curved' | 'pincer' | 'straight-arrow' | 'curved-arrow' | 'military-arrow';",
    'type');

// 2) current 归类
rep(`  const current: RouteStyle =
    element.type === 'line' ? ((element as LineElement).lineType === 'bezier' ? 'bezier' : (element as LineElement).lineType === 'arc' ? 'arc' : 'straight')
    : element.type === 'arrow' ? ((element as ArrowElement).arrowType === 'straight' ? 'straight-arrow' : 'curved-arrow')
    : element.type === 'double_arrow' ? 'pincer'
    : 'straight';`,
`  const current: RouteStyle =
    element.type === 'line' ? ((element as LineElement).lineArrow
      ? ((element as LineElement).lineType === 'bezier' ? 'curved-arrow' : 'straight-arrow')
      : ((element as LineElement).lineType === 'bezier' ? 'bezier' : (element as LineElement).lineType === 'arc' ? 'arc' : 'straight'))
    : element.type === 'arrow' ? 'military-arrow'
    : element.type === 'double_arrow' ? 'pincer'
    : 'straight';`
, 'current');

// 3) 选项：带箭头直线/箭头曲线（line 系）+ 行军箭头（military）
rep("            { value: 'straight-arrow', label: t('──▶ 带箭头直线', '──▶ Arrow Line') },\n            { value: 'curved-arrow', label: t('➤ 箭头曲线', '➤ Curved Arrow') },",
    "            { value: 'straight-arrow', label: t('──▶ 带箭头直线', '──▶ Arrow Line') },\n            { value: 'curved-arrow', label: t('➤ 箭头曲线', '➤ Curved Arrow') },\n            { value: 'military-arrow', label: t('⚔️ 行军箭头', '⚔️ March Arrow') },"
, 'options');

// 4) setStyle：straight/bezier/arc 关闭 lineArrow；新增 straight-arrow/curved-arrow（line 系）；military-arrow（旧弯曲军事箭头）
rep(`    if (s === 'straight' || s === 'bezier' || s === 'arc') {
      patch({
        type: 'line', coordinates: coords.length >= 2 ? coords : [[104, 35], [105, 36]],
        lineType: s, drawProgress: [{ frame: start, value: 1 }],
        lineWidth: 3, lineColor: colorOf,
      } as Partial<MapElement>);
    }`,
`    if (s === 'straight' || s === 'bezier' || s === 'arc') {
      patch({
        type: 'line', coordinates: coords.length >= 2 ? coords : [[104, 35], [105, 36]],
        lineType: s, lineArrow: false, drawProgress: [{ frame: start, value: 1 }],
        lineWidth: 3, lineColor: colorOf,
      } as Partial<MapElement>);
    } else if (s === 'straight-arrow' || s === 'curved-arrow') {
      const lineType = s === 'straight-arrow' ? 'straight' : 'bezier';
      patch({
        type: 'line', coordinates: coords.length >= 2 ? coords : [[104, 35], [105, 36]],
        lineType, lineArrow: true, drawProgress: [{ frame: start, value: 1 }],
        lineWidth: 3, lineColor: colorOf,
      } as Partial<MapElement>);
    } else if (s === 'military-arrow') {
      const pts = coords.length >= 2 ? coords : [[104, 35], [105, 36]];
      patch({
        type: 'arrow', from: pts[0], to: pts[pts.length - 1], path: pts,
        arrowType: 'curved', width: 15, color: colorOf,
        progress: [{ frame: start, value: 1 }], drawZoom: undefined,
      } as Partial<MapElement>);
    }`
, 'setstyle');

fs.writeFileSync(p, s, 'utf8');
console.log('panel done');
