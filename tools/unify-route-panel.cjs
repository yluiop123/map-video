// 统一路线面板：宽度可编辑 + 路径点扩展到 arrow/double_arrow
const fs = require('fs');
const p = 'src/components/PropertiesPanel.tsx';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b, tag) => {
  if (!s.includes(a)) { console.log('MISS', tag); process.exit(1); }
  s = s.split(a).join(b);
};

// 1) 宽度字段
rep(
`          <Field label="宽度">
            <input type="number" min="1" max="20" className="input" value={element.type === 'line' ? element.lineWidth : 3}
              onChange={(e) => element.type === 'line' && patch({ lineWidth: parseInt(e.target.value) || 3 })} />
          </Field>`,
`          <Field label={t('宽度', 'Width')}>
            <input type="number" min="1" max="40" className="input" value={widthOf}
              onChange={(e) => {
                const w = parseInt(e.target.value) || 3;
                if (element.type === 'line') patch({ lineWidth: w });
                else if (element.type === 'arrow') patch({ width: w } as Partial<MapElement>);
              }} />
          </Field>`,
'width'
);

// 2) widthOf + pathField
rep(
"  const colorOf = element.type === 'line' ? element.lineColor",
`  const widthOf = element.type === 'line' ? element.lineWidth : element.type === 'arrow' ? (element as ArrowElement).width : 3;
  const pathField = element.type === 'moving_point' || element.type === 'arrow' ? 'path' : element.type === 'double_arrow' ? 'points' : 'coordinates';
  const colorOf = element.type === 'line' ? element.lineColor`,
'helpers'
);

// 3) 路径点区块范围
rep(
`      {/* 线/箭头顶点编辑 */}
      {(element.type === 'line' || element.type === 'moving_point') && (`,
`      {/* 路线路径点编辑（所有路线类型一致） */}
      {(
        element.type === 'line' || element.type === 'moving_point' || element.type === 'arrow' || element.type === 'double_arrow'
      ) && (`,
'scope'
);

// 4) 三处 patch 改用 pathField
rep(`                  onChange={(e) => {
                    const c = [...coords]; c[i] = [parseFloat(e.target.value) || 0, coord[1]];
                    patch(element.type === 'line' ? { coordinates: c } : { path: c });
                  }} />`,
`                  onChange={(e) => {
                    const c = [...coords]; c[i] = [parseFloat(e.target.value) || 0, coord[1]];
                    patch(pathField === 'coordinates' ? { coordinates: c } : { [pathField]: c } as Partial<MapElement>);
                  }} />`,
'lng'
);
rep(`                  onChange={(e) => {
                    const c = [...coords]; c[i] = [coord[0], parseFloat(e.target.value) || 0];
                    patch(element.type === 'line' ? { coordinates: c } : { path: c });
                  }} />`,
`                  onChange={(e) => {
                    const c = [...coords]; c[i] = [coord[0], parseFloat(e.target.value) || 0];
                    patch(pathField === 'coordinates' ? { coordinates: c } : { [pathField]: c } as Partial<MapElement>);
                  }} />`,
'lat'
);

// 5) 删除按钮：至少保留 2 点
rep(`                <button onClick={() => {
                  const c = coords.filter((_, x) => x !== i);
                  patch(element.type === 'line' ? { coordinates: c } : { path: c });
                }} className="text-xs text-red-500">×</button>`,
`                <button onClick={() => {
                  if (coords.length <= 2) return;
                  const c = coords.filter((_, x) => x !== i);
                  patch(pathField === 'coordinates' ? { coordinates: c } : { [pathField]: c } as Partial<MapElement>);
                }} className="text-xs text-red-500 disabled:opacity-30" disabled={coords.length <= 2}>×</button>`,
'del-btn'
);

fs.writeFileSync(p, s, 'utf8');
console.log('all done | widthOf:', s.includes('widthOf'), '| pathField:', s.includes('const pathField'));
