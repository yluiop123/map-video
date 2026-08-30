// ① 顶点编辑修复：routeEdit 仅拦截带路径的选中路线，否则透传；选中失效自动复位
const fs = require('fs');
const p = 'src/components/EditableMap.tsx';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b, tag) => {
  if (!s.includes(a)) { console.log('MISS', tag); process.exit(1); }
  return s.split(a).join(b);
};

// 1) routeEdit 块：无选中路线时透传（不再吞点击）
rep(`    if (rEdit !== 'none') {
      const selEl = chapter.elements.find((x) => x.id === selectedElementId);
      const path = selEl ? routePathOf(selEl) : null;
      if (!path) return;`,
`    if (rEdit !== 'none' && selectedElementId) {
      const selEl = chapter.elements.find((x) => x.id === selectedElementId);
      const path = selEl ? routePathOf(selEl) : null;
      if (!path) {
        // 选中失效/非路线元素：自动退出编辑模式并透传正常选择
        useEditorStore.getState().setRouteEdit('none');
      } else {`
, 'routeEdit-guard');

// 2) 原 add/del 分支收进 else，并补上透传结尾
rep(`      if (rEdit === 'add') {`,
    `      if (rEdit === 'add') {`
  , 'add-keep');
rep(`        useProjectStore.getState().updateElement(chapter.id, (selEl as MapElement).id, { [fDel]: c } as Partial<MapElement>);
      }
      return;
    }`,
`        useProjectStore.getState().updateElement(chapter.id, (selEl as MapElement).id, { [fDel]: c } as Partial<MapElement>);
      }
      return;
      } else {
        // 无选中路线：透传正常选择/拖拽
      }
    }`
, 'routeEdit-close');

// 3) 选中变化 effect：非路线/取消选中时复位 routeEdit
rep(`  // ===== 路线顶点标识：所有路线元素显示路径点，选中的更大更亮 =====`,
`  // ===== 选中变化：路径点编辑模式自动复位 =====
  useEffect(() => {
    if (routeEditMode === 'none') return;
    const el = chapter.elements.find((x) => x.id === selectedElementId);
    if (!el || !routePathOf(el)) useEditorStore.getState().setRouteEdit('none');
  }, [selectedElementId, chapter, routeEditMode]);

  // ===== 路线顶点标识：所有路线元素显示路径点，选中的更大更亮 =====`
, 'reset-effect');

fs.writeFileSync(p, s, 'utf8');
console.log('step1 done');
