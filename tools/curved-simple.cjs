// curved-simple：types + buildArrowGeometry 签名与分支
const fs = require('fs');
const rep = (s, a, b, tag) => {
  if (!s.includes(a)) { console.log('MISS', tag); process.exit(1); }
  return s.split(a).join(b);
};

// types
let t = fs.readFileSync('src/types/index.ts', 'utf8');
t = rep(t,
  "arrowType: 'swallowtail' | 'simple' | 'block' | 'pincer' | 'curved' | 'attack' | 'straight';",
  "arrowType: 'swallowtail' | 'simple' | 'block' | 'pincer' | 'curved' | 'curved-simple' | 'attack' | 'straight';",
  'types'
);
fs.writeFileSync('src/types/index.ts', t, 'utf8');

const p = 'src/lib/map-renderer.ts';
let s = fs.readFileSync(p, 'utf8');
s = rep(s,
  "  arrowType: 'swallowtail' | 'simple' | 'block' | 'pincer' | 'curved' | 'attack' | 'straight',",
  "  arrowType: 'swallowtail' | 'simple' | 'block' | 'pincer' | 'curved' | 'curved-simple' | 'attack' | 'straight',",
  'geometry-sig'
);
s = rep(s,
  [
    '  // 弯曲燕尾：沿贝塞尔曲线采样构造条带',
    "  if (arrowType === 'curved' && path && path.length >= 2) {",
    '    return buildCurvedSwallowtail(path, width);',
    '  }',
  ].join('\n'),
  [
    '  // 弯曲燕尾：沿贝塞尔曲线采样构造条带',
    "  if (arrowType === 'curved' && path && path.length >= 2) {",
    '    return buildCurvedSwallowtail(path, width);',
    '  }',
    '  // 弯曲普通行军箭头：无燕尾切口、平尾',
    "  if (arrowType === 'curved-simple' && path && path.length >= 2) {",
    '    return buildCurvedSwallowtailWithOpts(path, width, { simpleTail: true });',
    '  }',
  ].join('\n'),
  'geometry-branch'
);
fs.writeFileSync(p, s, 'utf8');
console.log('all ok');
