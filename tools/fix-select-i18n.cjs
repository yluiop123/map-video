// 修：①工具条工具名双语 ②纯中文化区块标题 ③选中高亮 isStyleLoaded 门禁
const fs = require('fs');
const rep = (s, from, to, tag) => {
  if (!s.includes(from)) { console.log('MISS', tag || from.slice(0, 40)); return s; }
  return s.split(from).join(to);
};

// ---------- ③ 选中效果修复（EditableMap） ----------
{
  const p = 'src/components/EditableMap.tsx';
  let s = fs.readFileSync(p, 'utf8');

  // load 完成时打一个 styleTick，通知依赖 style 的 effect 重跑
  s = rep(s,
    "  const isPlaying = useEditorStore((s) => s.isPlaying);",
    "  const isPlaying = useEditorStore((s) => s.isPlaying);\n  const [styleTick, setStyleTick] = useState(0);",
    'styleTick-decl'
  );
  s = rep(s,
    "    map.on('load', () => {\n      mapRef.current = map;\n      sharedMap.set(map);",
    "    map.on('load', () => {\n      mapRef.current = map;\n      sharedMap.set(map);\n      setStyleTick((n) => n + 1);",
    'styleTick-bump'
  );

  // 选中高亮 effect：去掉 isStyleLoaded 门禁，try/catch + styleTick 依赖
  s = rep(s,
    "  useEffect(() => {\n    const map = mapRef.current;\n    if (!map || !map.isStyleLoaded()) return;\n    const sourceId = 'selection-highlight';",
    "  useEffect(() => {\n    const map = mapRef.current;\n    if (!map) return;\n    const sourceId = 'selection-highlight';",
    'selection-gate'
  );
  s = rep(s,
    "    try {\n      const feature = buildSelectionFeature(el);\n    if (!feature) return;",
    "    try {\n    const feature = buildSelectionFeature(el);\n    if (!feature) return;",
    'sel-try-open'
  );
  // 给选中 effect 包 try/catch：从 try { 到 </div> 前的整段——用结尾锚点
  s = rep(s,
    "      }\n    </div>\n  );\n}",
    "      }\n    </div>\n  );\n}",
    'noop-tail'
  );

  // 元素刷新 effect 加 styleTick 依赖
  s = rep(s,
    "  }, [chapter, currentFrame, project.globalConfig.defaultFPS]);",
    "  }, [chapter, currentFrame, project.globalConfig.defaultFPS, styleTick]);",
    'refresh-deps'
  );
  // 选中 effect 与 selection-move effect 加 styleTick 依赖
  s = rep(s,
    "  }, [selectedElementId, chapter]);",
    "  }, [selectedElementId, chapter, styleTick]);",
    'sel-deps'
  );

  // 选中高亮主体包 try/catch（把 addSource 之后到最后一层添加包起来）
  s = rep(s,
    "    const data = { type: 'FeatureCollection', features: [feature] };",
    "    const data = { type: 'FeatureCollection', features: [feature] };\n    try {",
    'sel-try'
  );
  s = rep(s,
    "        }}\n      );\n    }\n  }, [selectedElementId, chapter, styleTick]);",
    "        }}\n      );\n    } catch { /* style 未就绪，下次选择或 load 后重试 */ }\n  }, [selectedElementId, chapter, styleTick]);",
    'sel-try-close'
  );

  // selection-move 创建分支同样处理
  s = rep(s,
    "    } else if (map.isStyleLoaded()) {\n      map.addSource(srcId, { type: 'geojson', data: fc } as any);",
    "    } else {\n      map.addSource(srcId, { type: 'geojson', data: fc } as any);",
    'move-gate'
  );

  fs.writeFileSync(p, s, 'utf8');
  console.log('EditableMap patched');
}

// ---------- ① 工具条双语（Toolbar） ----------
{
  const p = 'src/components/Toolbar.tsx';
  let s = fs.readFileSync(p, 'utf8');
  // ModeItem 增加 zh 名称
  s = rep(s,
    "interface ModeItem {\n  mode?: InteractionMode;\n  icon: React.ReactNode;\n  label: string;",
    "interface ModeItem {\n  mode?: InteractionMode;\n  icon: React.ReactNode;\n  label: string;\n  zh: string;"
  );
  s = rep(s, "{ icon: <MapPin size={15} className=\"text-red-400\" />, label: 'Pin', action: 'place-pin' }",
    "{ icon: <MapPin size={15} className=\"text-red-400\" />, label: 'Pin', zh: '标记', action: 'place-pin' }");
  s = rep(s, "{ icon: <RouteIcon size={15} className=\"text-blue-400\" />, label: 'Route', mode: 'add_line' }",
    "{ icon: <RouteIcon size={15} className=\"text-blue-400\" />, label: 'Route', zh: '路线', mode: 'add_line' }");
  s = rep(s, "{ icon: <Type size={15} />, label: 'Text', action: 'place-text' }",
    "{ icon: <Type size={15} />, label: 'Text', zh: '文字', action: 'place-text' }");
  s = rep(s, "{ icon: <ImageIcon size={15} className=\"text-emerald-400\" />, label: 'Image', action: 'place-image' }",
    "{ icon: <ImageIcon size={15} className=\"text-emerald-400\" />, label: 'Image', zh: '图片', action: 'place-image' }");
  s = rep(s, "{ icon: <Shapes size={15} className=\"text-orange-400\" />, label: 'Shape', mode: 'add_polygon' }",
    "{ icon: <Shapes size={15} className=\"text-orange-400\" />, label: 'Shape', zh: '形状', mode: 'add_polygon' }");
  s = rep(s, "{ icon: <Globe size={15} className=\"text-sky-400\" />, label: 'Region', action: 'regionPicker' }",
    "{ icon: <Globe size={15} className=\"text-sky-400\" />, label: 'Region', zh: '区域', action: 'regionPicker' }");
  // FloatingTools 使用 useT
  s = rep(s,
    "export function FloatingTools() {\n  const mode = useInteractionStore((s) => s.mode);\n  const setMode = useInteractionStore((s) => s.setMode);",
    "export function FloatingTools() {\n  const mode = useInteractionStore((s) => s.mode);\n  const setMode = useInteractionStore((s) => s.setMode);\n  const t = useT();"
  );
  s = rep(s, "import { RegionPickerDialog } from './RegionPickerDialog';",
    "import { RegionPickerDialog } from './RegionPickerDialog';\nimport { useT } from './ui/primitives';");
  // 渲染双语
  s = rep(s,
    "            {t.icon}\n            <span className=\"hidden xl:inline\">{t.label}</span>",
    "            {t.icon}\n            <span className=\"hidden xl:inline\">{lang === 'en' ? t.label : t.zh}</span>"
  );
  s = rep(s, 'title={t.label}', 'title={lang === \'en\' ? t.label : t.zh}');
  // lang 状态注入 FloatingTools
  s = rep(s,
    "  const setMode = useInteractionStore((s) => s.setMode);\n  const t = useT();",
    "  const setMode = useInteractionStore((s) => s.setMode);\n  const lang = useEditorStore((s) => s.lang);\n  const t = useT();"
  );
  s = rep(s, "import { useT } from './ui/primitives';",
    "import { useT } from './ui/primitives';");
  fs.writeFileSync(p, s, 'utf8');
  console.log('Toolbar patched');
}

// ---------- ② 纯中文化区块标题（PropertiesPanel） ----------
{
  const p = 'src/components/PropertiesPanel.tsx';
  let s = fs.readFileSync(p, 'utf8');
  s = rep(s, "t('PIN STYLE（样式）', 'PIN STYLE')", "t('样式', 'Pin Style')");
  s = rep(s, "t('SIZE（等比缩放）', 'SIZE')", "t('大小', 'Size')");
  s = rep(s, "t('ORIENTATION（朝向）', 'ORIENTATION')", "t('朝向', 'Orientation')");
  s = rep(s, "t('LABEL STYLE（文案样式）', 'LABEL STYLE')", "t('文案样式', 'Label Style')");
  s = rep(s, "t('标签（LABEL）', 'LABEL')", "t('标签', 'Label')");
  s = rep(s, "t('MARKER（旗帜样式）', 'MARKER (Flag)')", "t('旗帜样式', 'Marker')");
  s = rep(s, "t('SIZE（大小与旋转）', 'SIZE')", "t('大小与旋转', 'Size & Rotation')");
  s = rep(s, "t('EMOJI（表情）', 'EMOJI')", "t('表情', 'Emoji')");
  // 静态双语标题 → t()
  s = rep(s, '<Section title="ROUTE TYPE（路线类型）">', "<Section title={t('路线类型', 'Route Type')}>");
  s = rep(s, '<Section title="ANIMATION（动画）">', "<Section title={t('动画', 'Animation')}>");
  s = rep(s, '<Section title="STROKE（笔触）">', "<Section title={t('笔触', 'Stroke')}>");
  s = rep(s, '<Section title="PATH（路径点）">', "<Section title={t('路径点', 'Path Points')}>");
  s = rep(s, '<Section title="SHAPE TYPE（形状类型）">', "<Section title={t('形状类型', 'Shape Type')}>");
  s = rep(s, '<Section title="CIRCLE（圆参数）">', "<Section title={t('圆参数', 'Circle')}>");
  s = rep(s, '<Section title="RECT（矩形对角点）">', "<Section title={t('矩形对角点', 'Rectangle Corners')}>");
  fs.writeFileSync(p, s, 'utf8');
  console.log('PropertiesPanel titles patched');
}
console.log('ALL DONE');
