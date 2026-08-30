const fs = require('fs');
const files = [
  'src/components/PropertiesPanel.tsx',
  'src/components/CameraEditor.tsx',
  'src/components/KeyframePanel.tsx',
];
// 匹配 value={X} 后跟 onChange，且 X 是经纬度 accessor（coordinates/center/c1/c2/circleMeta.center 的 [i]）
const re = /value=\{([^{}]+)\}(\s+onChange=)/g;
const accessor = /(coordinates|center|c1|c2)\[\d\]$/;

let total = 0;
for (const f of files) {
  let s = fs.readFileSync(f, 'utf8');
  s = s.replace(re, (m, x, rest) => {
    const inner = x.trim();
    if (!accessor.test(inner)) return m;
    if (inner.includes('toFixed')) return m;
    total++;
    return `value={Number(${inner}).toFixed(5)}${rest}`;
  });
  fs.writeFileSync(f, s, 'utf8');
}
console.log('patched inputs:', total);
