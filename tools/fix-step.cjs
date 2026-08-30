const fs = require('fs');
const files = [
  'src/components/PropertiesPanel.tsx',
  'src/components/CameraEditor.tsx',
  'src/components/KeyframePanel.tsx',
];
for (const f of files) {
  let s = fs.readFileSync(f, 'utf8');
  const before = s.split('step="0.0001"').length - 1;
  s = s.split('step="0.0001"').join('step="0.00001"');
  fs.writeFileSync(f, s, 'utf8');
  console.log(f, 'replaced', before);
}
