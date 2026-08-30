// 面板：行军箭头→燕尾箭头 改名 + 新增普通行军箭头（military-simple）
const fs = require('fs');
const p = 'src/components/PropertiesPanel.tsx';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b, tag) => {
  if (!s.includes(a)) { console.log('MISS', tag); process.exit(1); }
  s = s.split(a).join(b);
};

// RouteStyle 加 military-simple
rep("type RouteStyle = 'straight' | 'bezier' | 'arc' | 'swallowtail' | 'curved' | 'pincer' | 'straight-arrow' | 'curved-arrow' | 'military-arrow';",
    "type RouteStyle = 'straight' | 'bezier' | 'arc' | 'swallowtail' | 'curved' | 'pincer' | 'straight-arrow' | 'curved-arrow' | 'military-arrow' | 'military-simple';",
    'type');

// current 归类：arrow 按 arrowType
rep("    : element.type === 'arrow' ? 'military-arrow'",
    "    : element.type === 'arrow' ? ((element as ArrowElement).arrowType === 'curved-simple' ? 'military-simple' : 'military-arrow')",
    'current');

// setStyle：military-arrow 保持燕尾（改名后语义）；新增 military-simple
rep(`    } else if (s === 'military-arrow') {
      const pts = coords.length >= 2 ? coords : [[104, 35], [105, 36]];
      patch({
        type: 'arrow', from: pts[0], to: pts[pts.length - 1], path: pts,
        arrowType: 'curved', width: 15, color: colorOf,
        progress: [{ frame: start, value: 1 }], drawZoom: undefined,
      } as Partial<MapElement>);
    } else {`,
`    } else if (s === 'military-arrow') {
      const pts = coords.length >= 2 ? coords : [[104, 35], [105, 36]];
      patch({
        type: 'arrow', from: pts[0], to: pts[pts.length - 1], path: pts,
        arrowType: 'curved', width: 15, color: colorOf,
        progress: [{ frame: start, value: 1 }], drawZoom: undefined,
      } as Partial<MapElement>);
    } else if (s === 'military-simple') {
      const pts = coords.length >= 2 ? coords : [[104, 35], [105, 36]];
      patch({
        type: 'arrow', from: pts[0], to: pts[pts.length - 1], path: pts,
        arrowType: 'curved-simple', width: 15, color: colorOf,
        progress: [{ frame: start, value: 1 }], drawZoom: undefined,
      } as Partial<MapElement>);
    } else {`
, 'setstyle');

// 选项：改名燕尾箭头 + 新增普通行军箭头
rep("            { value: 'military-arrow', label: t('⚔️ 行军箭头', '⚔️ March Arrow') },",
    "            { value: 'military-arrow', label: t('🪶 燕尾箭头', '🪶 Swallowtail') },\n            { value: 'military-simple', label: t('⚔️ 行军箭头', '⚔️ March Arrow') },",
    'options');

fs.writeFileSync(p, s, 'utf8');
console.log('panel ok');
