// 路线编辑终修：①顶点命中优先选中元素 ②添加模式十字光标+橡皮筋预览 ③清理调试
const fs = require('fs');
const p = 'src/components/EditableMap.tsx';
let s = fs.readFileSync(p, 'utf8');
const rep = (a, b, tag) => {
  if (!s.includes(a)) { console.log('MISS', tag); process.exit(1); }
  return s.split(a).join(b);
};

// ① hitRouteVertex：选中元素优先
rep(
`function hitRouteVertex(map: maplibregl.Map, point: maplibregl.PointLike, elements: MapElement[]): { eid: string; idx: number } | null {
  let best: { eid: string; idx: number } | null = null;
  let bestD = 25;
  for (const el of elements) {
    const path = routePathOf(el);
    if (!path) continue;
    for (let i = 0; i < path.length; i++) {
      const p = map.project(path[i] as [number, number]);
      const pt = point as maplibregl.Point;
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < bestD) { bestD = d; best = { eid: el.id, idx: i }; }
      (window as any).__hv.best = Math.min((window as any).__hv.best ?? 1e9, d);
    }
  }
  return best;
}`,
`function hitRouteVertex(
  map: maplibregl.Map,
  point: maplibregl.PointLike,
  elements: MapElement[],
  preferId?: string | null
): { eid: string; idx: number } | null {
  const pt = point as maplibregl.Point;
  const hitIn = (els: MapElement[]): { eid: string; idx: number } | null => {
    let best: { eid: string; idx: number } | null = null;
    let bestD = 25;
    for (const el of els) {
      const path = routePathOf(el);
      if (!path) continue;
      for (let i = 0; i < path.length; i++) {
        const p = map.project(path[i] as [number, number]);
        const d = Math.hypot(p.x - pt.x, p.y - pt.y);
        if (d < bestD) { bestD = d; best = { eid: el.id, idx: i }; }
      }
    }
    return best;
  };
  // 选中元素的顶点优先（避免其他路线重叠顶点抢命中）
  const sel = preferId ? elements.find((e) => e.id === preferId) : null;
  if (sel) {
    const hit = hitIn([sel]);
    if (hit) return hit;
  }
  return hitIn(elements.filter((e) => e.id !== preferId));
}`,
'hit-priority'
);

// ② 添加模式十字光标：getCursor
rep(
"  const getCursor = () => (mode.startsWith('add_') ? 'crosshair' : 'default');",
"  const getCursor = () => (mode.startsWith('add_') || routeEditMode === 'add' ? 'crosshair' : 'default');",
'getCursor'
);

// ② handleHover：添加模式下光标恒为十字
rep(
`    if (useInteractionStore.getState().mode !== 'select') return; // 其他模式由 getCursor 处理
    if (dragRef.current.active) { m.getCanvas().style.cursor = 'move'; return; }`,
`    if (useInteractionStore.getState().mode !== 'select') return; // 其他模式由 getCursor 处理
    if (dragRef.current.active) { m.getCanvas().style.cursor = 'move'; return; }
    if (useEditorStore.getState().routeEdit === 'add') { m.getCanvas().style.cursor = 'crosshair'; return; }`,
'hover-crosshair'
);

// ③ 橡皮筋预览：mousemove 跟踪 + 专用图层
rep(
`    // 绘制中更新光标位置 → 预览
    if (map && DRAW_MODES.includes(useInteractionStore.getState().mode)) {`,
`    // 添加点模式：终点 → 光标 橡皮筋预览
    if (map && useEditorStore.getState().routeEdit === 'add') {
      const selEl = chapter.elements.find((x) => x.id === selectedElementId);
      const path = selEl ? routePathOf(selEl) : null;
      const bbox = containerRef.current?.getBoundingClientRect();
      if (path && bbox) {
        const p = map.unproject([e.clientX - bbox.left, e.clientY - bbox.top]);
        const last = path[path.length - 1] as [number, number];
        const line = turf.lineString([last, [p.lng, p.lat]]);
        try {
          if (map.getSource('route-add-preview')) {
            (map.getSource('route-add-preview') as GeoJSONSource).setData(turf.featureCollection([line]));
          } else {
            map.addSource('route-add-preview', { type: 'geojson', data: turf.featureCollection([line]) } as any);
            map.addLayer({
              id: 'route-add-preview', type: 'line', source: 'route-add-preview',
              paint: { 'line-color': '#3B82F6', 'line-width': 2, 'line-dasharray': [2, 2] },
            });
          }
          if (map.getLayer('route-add-preview')) map.moveLayer('route-add-preview');
        } catch { /* style 未就绪 */ }
      }
      // 顶点拖拽逻辑照常
    }

    // 绘制中更新光标位置 → 预览
    if (map && DRAW_MODES.includes(useInteractionStore.getState().mode)) {`
, 'rubber-band');

// ④ 退出添加模式时隐藏预览线（选中复位 effect 里处理）
rep(
`  // ===== 选中变化：路径点编辑模式自动复位 =====
  useEffect(() => {
    if (routeEditMode === 'none') return;
    const el = selectedElementId ? chapter.elements.find((x) => x.id === selectedElementId) : null;
    if (!el || !routePathOf(el)) useEditorStore.getState().setRouteEdit('none');
  }, [selectedElementId, chapter, routeEditMode]);`,
`  // ===== 选中变化：路径点编辑模式自动复位 =====
  useEffect(() => {
    const map = mapRef.current;
    if (routeEditMode !== 'add' && map && map.getLayer('route-add-preview')) {
      map.setLayoutProperty('route-add-preview', 'visibility', 'none');
    }
    if (routeEditMode === 'none') return;
    const el = selectedElementId ? chapter.elements.find((x) => x.id === selectedElementId) : null;
    if (!el || !routePathOf(el)) useEditorStore.getState().setRouteEdit('none');
  }, [selectedElementId, chapter, routeEditMode]);`
, 'preview-hide');

fs.writeFileSync(p, s, 'utf8');
console.log('done');
