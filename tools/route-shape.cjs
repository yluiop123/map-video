// 路线/形状改造：删航线燕尾、燕尾入形状、categoryOf 归类
const fs = require('fs');
const rep = (s, from, to, tag) => {
  if (!s.includes(from)) { console.log('MISS', tag || from.slice(0, 50)); return s; }
  return s.split(from).join(to);
};

const p = 'src/components/PropertiesPanel.tsx';
let s = fs.readFileSync(p, 'utf8');

// 1) 路线类型删除 航线/燕尾
s = rep(s,
  "            { value: 'straight', label: '─ 直线' },\n            { value: 'bezier', label: '〰 曲线' },\n            { value: 'arc', label: '🛫 航线' },\n            { value: 'swallowtail', label: '➡ 燕尾' },\n            { value: 'curved', label: '🗡 弯曲' },\n            { value: 'pincer', label: '🩹 钳形' },",
  "            { value: 'straight', label: '─ 直线' },\n            { value: 'bezier', label: '〰 曲线' },\n            { value: 'curved', label: '🗡 弯曲' },\n            { value: 'pincer', label: '🩹 钳形' },",
  'route-options'
);

// 2) ShapeStyle 加 swallowtail
s = rep(s,
  "type ShapeStyle = 'poly' | 'rect' | 'circle' | 'encirclement' | 'gathering';",
  "type ShapeStyle = 'poly' | 'rect' | 'circle' | 'encirclement' | 'gathering' | 'swallowtail';",
  'shapestyle-type'
);

// 3) ShapeSettings current 识别燕尾箭头
s = rep(s,
  "  const current: ShapeStyle =\n    element.type === 'encirclement' ? 'encirclement'",
  "  const current: ShapeStyle =\n    (element.type === 'arrow' && (element as ArrowElement).arrowType === 'swallowtail') ? 'swallowtail'\n    : element.type === 'encirclement' ? 'encirclement'",
  'current'
);

// 4) ShapeSettings setStyle 加 swallowtail 分支（挂在 gathering 前，用元素自身时间）
s = rep(s,
  "    } else if (s === 'encirclement') {",
  `    } else if (s === 'swallowtail') {
      const pts = ring && ring.length >= 2 ? ring : [[104, 35], [105, 36]];
      patch({
        type: 'arrow', from: pts[0], to: pts[pts.length - 1], path: pts,
        arrowType: 'swallowtail', width: 15, color: fill,
        progress: [{ frame: element.startFrame, value: 1 }], drawZoom: undefined,
      } as Partial<MapElement>);
    } else if (s === 'encirclement') {`
  , 'shape-setStyle');

// 5) 形状类型选项加 燕尾
s = rep(s,
  "            { value: 'encirclement', label: '⭕ 包围圈' },\n            { value: 'gathering', label: '⚔️ 集结点' },",
  "            { value: 'encirclement', label: '⭕ 包围圈' },\n            { value: 'gathering', label: '⚔️ 集结点' },\n            { value: 'swallowtail', label: '➡ 燕尾' },",
  'shape-options'
);

// 6) categoryOf：swallowtail 箭头归 shape（改为接收元素）
s = rep(s,
  `function categoryOf(t: MapElement['type']): Category {
  if (t === 'point' || t === 'flag') return 'pin';
  if (t === 'line' || t === 'moving_point' || t === 'arrow' || t === 'double_arrow') return 'route';
  if (t === 'polygon' || t === 'encirclement' || t === 'gathering') return 'shape';
  return 'image';
}`,
  `function categoryOf(el: MapElement): Category {
  const t = el.type;
  if (t === 'point' || t === 'flag') return 'pin';
  if (t === 'arrow' && (el as ArrowElement).arrowType === 'swallowtail') return 'shape';
  if (t === 'line' || t === 'moving_point' || t === 'arrow' || t === 'double_arrow') return 'route';
  if (t === 'polygon' || t === 'encirclement' || t === 'gathering') return 'shape';
  return 'image';
}`
  , 'categoryOf');
s = rep(s, '  const cat = categoryOf(element.type);', '  const cat = categoryOf(element);', 'cat-call');

fs.writeFileSync(p, s, 'utf8');
console.log('PropertiesPanel done');
