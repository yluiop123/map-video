// 删除点动画：UI 区块、渲染端 highlight 全套、预览循环、类型定义
const fs = require('fs');

// ---------- map-renderer.ts ----------
{
  const p = 'src/lib/map-renderer.ts';
  let s = fs.readFileSync(p, 'utf8');

  // 1) 注册表 + 预览函数（从注释起到 renderHighlightsPreview 结束）
  const rStart = s.indexOf('/** 当前带点动画的图层目标');
  if (rStart === -1) { console.log('registry start MISS'); process.exit(1); }
  const pvEnd = s.indexOf('\n}\n', s.indexOf('renderHighlightsPreview')) + 3;
  s = s.slice(0, rStart) + s.slice(pvEnd);

  // 2) renderElements 内清空注册表行
  s = s.replace('  highlightTargets = [];\n', '');

  // 3) applyHighlight + applyHighlightPaint + setPaint + getBasePaint 整段删除
  const fStart = s.indexOf('function applyHighlight(');
  const fEnd = s.indexOf('// ========== 渲染：固定点 ==========', fStart);
  if (fStart === -1 || fEnd === -1) { console.log('fn bounds MISS', fStart, fEnd); process.exit(1); }
  s = s.slice(0, fStart) + s.slice(fEnd);

  // 4) renderPoint 内的高亮块 + 波纹层注册整段删除（到 renderPoint 结束的 }\n）
  const bStart = s.indexOf('  // 点动画：只作用于当前可见的图层');
  if (bStart === -1) { console.log('renderPoint block MISS'); process.exit(1); }
  const bEnd = s.indexOf('\n}\n', bStart) + 3;
  s = s.slice(0, bStart) + '}\n\n' + s.slice(bEnd);

  // 5) import 去掉 HighlightConfig
  s = s.replace('  CustomIconElement, FlagElement, HighlightConfig, CustomSymbol', '  CustomIconElement, FlagElement, CustomSymbol');

  fs.writeFileSync(p, s, 'utf8');
  console.log('map-renderer cleaned, highlight refs:', (s.match(/applyHighlight|highlightTargets|renderHighlightsPreview|HighlightConfig/g) || []).length);
}

// ---------- EditableMap.tsx ----------
{
  const p = 'src/components/EditableMap.tsx';
  let s = fs.readFileSync(p, 'utf8');
  s = s.replace('  renderElements, renderHighlightsPreview, setCustomSymbols,', '  renderElements, setCustomSymbols,');
  s = s.replace('  const isPlaying = useEditorStore((s) => s.isPlaying);\n', '');
  // 预览循环 effect 整段删除
  const eStart = s.indexOf('  // ===== 点动画暂停预览：');
  if (eStart !== -1) {
    const eEnd = s.indexOf('\n  }, [isPlaying, chapter, project.globalConfig.defaultFPS]);', eStart);
    if (eEnd === -1) { console.log('loop end MISS'); process.exit(1); }
    s = s.slice(0, eStart) + s.slice(eEnd + '\n  }, [isPlaying, chapter, project.globalConfig.defaultFPS]);'.length + 1);
  }
  fs.writeFileSync(p, s, 'utf8');
  console.log('EditableMap cleaned, refs:', (s.match(/highlight|renderHighlightsPreview/gi) || []).length);
}

// ---------- PropertiesPanel.tsx ----------
{
  const p = 'src/components/PropertiesPanel.tsx';
  let s = fs.readFileSync(p, 'utf8');
  // 渲染调用
  s = s.replace('        <HighlightSection element={element} onChange={(k, v) => patch({ [k]: v } as Partial<MapElement>)} fps={fps} />\n\n', '');
  s = s.replace(/.*<HighlightSection element=\{element\}.*\n/, '');
  // 组件定义
  const cStart = s.indexOf('function HighlightSection({ element, onChange, fps }');
  if (cStart !== -1) {
    const cEnd = s.indexOf('\nfunction ', cStart);
    if (cEnd === -1) { console.log('HighlightSection end MISS'); process.exit(1); }
    s = s.slice(0, cStart) + s.slice(cEnd + 1);
  }
  // import
  s = s.replace('  PolygonElement, ArrowElement, CustomIconElement, FlagElement, HighlightConfig, HighlightType,',
    '  PolygonElement, ArrowElement, CustomIconElement, FlagElement,');
  fs.writeFileSync(p, s, 'utf8');
  console.log('PropertiesPanel cleaned, refs:', (s.match(/Highlight|点动画/g) || []).length);
}

// ---------- types/index.ts ----------
{
  const p = 'src/types/index.ts';
  let s = fs.readFileSync(p, 'utf8');
  s = s.replace("export type HighlightType = 'blink' | 'pulse' | 'glow' | 'ripple' | 'colorShift' | 'ring';\n", '');
  s = s.replace(/export interface HighlightConfig \{[^}]*\}\n/, '');
  s = s.replace(/.*highlight\?: HighlightConfig;.*\n/, '');
  fs.writeFileSync(p, s, 'utf8');
  console.log('types cleaned, refs:', (s.match(/Highlight/g) || []).length);
}
console.log('ALL DONE');
