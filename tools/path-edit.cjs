// 路径点：5位小数 + 添加/删除点按钮 + RouteSettings 订阅 routeEdit
const fs = require('fs');
const p = 'src/components/PropertiesPanel.tsx';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b, tag) => {
  if (!s.includes(a)) { console.log('MISS', tag); process.exit(1); }
  s = s.split(a).join(b);
};

// 1) 5 位小数
rep('className="input flex-1" value={coord[0]}', 'className="input flex-1" value={coord[0].toFixed(5)}', 'lng5');
rep('className="input flex-1" value={coord[1]}', 'className="input flex-1" value={coord[1].toFixed(5)}', 'lat5');

// 2) 添加点/删除点按钮
rep(
`        <Section title={t('路径点', 'Path Points')}>
          <div className="max-h-44 overflow-y-auto">`,
`        <Section title={t('路径点', 'Path Points')}>
          <div className="flex gap-1.5 mb-1.5">
            <button
              onClick={() => setRouteEdit(routeEdit === 'add' ? 'none' : 'add')}
              className={\`px-2 py-1 text-[11px] font-medium rounded-md border transition-colors \${routeEdit === 'add' ? 'bg-brand/20 border-brand text-foreground font-semibold' : 'bg-white/[0.03] border-white/10 text-foreground/80 hover:bg-accent'}\`}
            >
              {t('＋ 添加点', '＋ Add Point')}
            </button>
            <button
              onClick={() => setRouteEdit(routeEdit === 'del' ? 'none' : 'del')}
              className={\`px-2 py-1 text-[11px] font-medium rounded-md border transition-colors \${routeEdit === 'del' ? 'bg-brand/20 border-brand text-foreground font-semibold' : 'bg-white/[0.03] border-white/10 text-foreground/80 hover:bg-accent'}\`}
            >
              {t('－ 删除点', '－ Delete Point')}
            </button>
          </div>
          {routeEdit !== 'none' && (
            <p className="text-[11px] text-muted-foreground mb-1.5">
              {routeEdit === 'add' ? t('点击地图上的位置插入路径点', 'Click the map to insert a point') : t('点击要删除的节点（至少保留 2 个点）', 'Click a node to delete (keep at least 2 points)')}
            </p>
          )}
          <div className="max-h-44 overflow-y-auto">`,
'buttons'
);

// 3) RouteSettings 订阅 routeEdit
rep(
'  const confirm = useConfirm();\n  const coords = routeCoords(element);',
'  const confirm = useConfirm();\n  const routeEdit = useEditorStore((s) => s.routeEdit);\n  const setRouteEdit = useEditorStore((s) => s.setRouteEdit);\n  const coords = routeCoords(element);',
'sub'
);

// 4) editorStore import（若无）
if (!s.includes("import { useEditorStore } from '../stores/editorStore';")) {
  s = s.replace("import { useProjectStore } from '../stores/projectStore';",
    "import { useProjectStore } from '../stores/projectStore';\nimport { useEditorStore } from '../stores/editorStore';");
}

fs.writeFileSync(p, s, 'utf8');
console.log('panel ok');
