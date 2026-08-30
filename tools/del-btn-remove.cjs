// 删除「删除点」按钮 + 更新提示文案
const fs = require('fs');
const p = 'src/components/PropertiesPanel.tsx';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b, tag) => {
  if (!s.includes(a)) { console.log('MISS', tag); process.exit(1); }
  s = s.split(a).join(b);
};

rep(
`            <button
              onClick={() => setRouteEdit(routeEdit === 'del' ? 'none' : 'del')}
              className={\`px-2 py-1 text-[11px] font-medium rounded-md border transition-colors \${routeEdit === 'del' ? 'bg-brand/20 border-brand text-foreground font-semibold' : 'bg-white/[0.03] border-white/10 text-foreground/80 hover:bg-accent'}\`}
            >
              {t('－ 删除点', '－ Delete Point')}
            </button>
`,
'',
'del-btn'
);

rep(
"              {routeEdit === 'add' ? t('点击地图上的位置插入路径点', 'Click the map to insert a point') : t('点击要删除的节点（至少保留 2 个点）', 'Click a node to delete (keep at least 2 points)')}",
"              {routeEdit === 'add' ? t('点击地图上的位置新增路径点（追加到终点）', 'Click the map to append a point at the end') : ''}",
'hint'
);

fs.writeFileSync(p, s, 'utf8');
console.log('done');
