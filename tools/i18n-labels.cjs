// 批量把属性面板标签改为双语 t('中文','English')
// 用法：node tools/i18n-labels.cjs
const fs = require('fs');

const rep = (s, from, to) => {
  if (!s.includes(from)) { console.log('MISS:', from.slice(0, 60)); return s; }
  return s.split(from).join(to);
};

// ---------- PropertiesPanel ----------
{
  const p = 'src/components/PropertiesPanel.tsx';
  let s = fs.readFileSync(p, 'utf8');

  // import useT
  s = rep(s,
    "import { Section, Field, StyleGrid, Toggle, ColorPicker, OptionBlocks, PanelHeader } from './ui/primitives';",
    "import { Section, Field, StyleGrid, Toggle, ColorPicker, OptionBlocks, PanelHeader, useT } from './ui/primitives';"
  );

  // 各组件注入 const t = useT();
  s = rep(s,
    '  const removeCustomSymbol = useProjectStore((s) => s.removeCustomSymbol);',
    '  const removeCustomSymbol = useProjectStore((s) => s.removeCustomSymbol);\n  const t = useT();'
  );
  s = rep(s, '  const coords = element.coordinates;', '  const coords = element.coordinates;\n  const t = useT();');
  s = rep(s, '  const hasBg = !transparent;', '  const hasBg = !transparent;\n  const t = useT();');
  s = rep(s,
    "  const update = (changes: Partial<HighlightConfig>) => setHighlight({ ...(highlight || { type: 'blink', color: '#FFD700', duration: fps, intensity: 1 }), ...changes });",
    "  const update = (changes: Partial<HighlightConfig>) => setHighlight({ ...(highlight || { type: 'blink', color: '#FFD700', duration: fps, intensity: 1 }), ...changes });\n  const t = useT();"
  );
  s = rep(s,
    'function FlagFields({ element, patch }: { element: FlagElement; patch: (c: Partial<MapElement>) => void }) {\n  return (',
    'function FlagFields({ element, patch }: { element: FlagElement; patch: (c: Partial<MapElement>) => void }) {\n  const t = useT();\n  return ('
  );
  s = rep(s,
    'function ImageSettings({ element, patch }: { element: CustomIconElement; patch: (c: Partial<MapElement>) => void }) {\n  return (',
    'function ImageSettings({ element, patch }: { element: CustomIconElement; patch: (c: Partial<MapElement>) => void }) {\n  const t = useT();\n  return ('
  );
  s = rep(s,
    'function EmptyPanel() {\n  return (',
    'function EmptyPanel() {\n  const t = useT();\n  return ('
  );

  // Section 标题
  s = rep(s, '<Section title="PIN STYLE（样式）">', "<Section title={t('PIN STYLE（样式）', 'PIN STYLE')}>");
  s = rep(s, '<Section title="SIZE（等比缩放）">', "<Section title={t('SIZE（等比缩放）', 'SIZE')}>");
  s = rep(s, '<Section title="ORIENTATION（朝向）">', "<Section title={t('ORIENTATION（朝向）', 'ORIENTATION')}>");
  s = rep(s, '<Section title="EMOJI（表情）">', "<Section title={t('EMOJI（表情）', 'EMOJI')}>");
  s = rep(s, '<Section title="MARKER（旗帜样式）">', "<Section title={t('MARKER（旗帜样式）', 'MARKER (Flag)')}>");
  s = rep(s, '<Section title="图标颜色">', "<Section title={t('图标颜色', 'Icon Color')}>");
  s = rep(s, '<Section title="ICON（图标库）">', "<Section title={t('ICON（图标库）', 'ICON LIBRARY')}>");
  s = rep(s, '<Section title="SIZE（大小与旋转）">', "<Section title={t('SIZE（大小与旋转）', 'SIZE')}>");
  s = rep(s, '<Section title="时间">', "<Section title={t('时间', 'Time')}>");
  s = rep(s, '<Section title="点动画">', "<Section title={t('点动画', 'Point Animation')}>");
  s = rep(s, '<Section title="LABEL STYLE（文案样式）">', "<Section title={t('LABEL STYLE（文案样式）', 'LABEL STYLE')}>");

  // Field 标签（全局唯一或语义一致的直接替换）
  s = rep(s, '<Field label="经度">', "<Field label={t('经度', 'Longitude')}>");
  s = rep(s, '<Field label="纬度">', "<Field label={t('纬度', 'Latitude')}>");
  s = rep(s, '<Field label="旋转">', "<Field label={t('旋转', 'Rotation')}>");
  s = rep(s, '<Field label="旗上文字">', "<Field label={t('旗上文字', 'Flag Text')}>");
  s = rep(s, '<Field label="文字颜色">', "<Field label={t('文字颜色', 'Text Color')}>");
  s = rep(s, '<Field label="文字大小">', "<Field label={t('文字大小', 'Font Size')}>");
  s = rep(s, '<Field label="旗面宽度">', "<Field label={t('旗面宽度', 'Flag Width')}>");
  s = rep(s, '<Field label="大小 (px)">', "<Field label={t('大小 (px)', 'Size (px)')}>");
  s = rep(s, '<Field label="开始">', "<Field label={t('开始', 'Start')}>");
  s = rep(s, '<Field label="结束">', "<Field label={t('结束', 'End')}>");
  s = rep(s, '<Field label="效果">', "<Field label={t('效果', 'Effect')}>");
  s = rep(s, '<Field label="颜色">', "<Field label={t('颜色', 'Color')}>");
  s = rep(s, '<Field label="周期(秒)">', "<Field label={t('周期(秒)', 'Period (s)')}>");
  s = rep(s, '<Field label="强度(0-1)">', "<Field label={t('强度(0-1)', 'Intensity (0-1)')}>");
  s = rep(s, '<Field label="位置">', "<Field label={t('位置', 'Position')}>");
  s = rep(s, '<Field label="背景颜色">', "<Field label={t('背景颜色', 'Background Color')}>");
  s = rep(s, '<Field label="背景边距">', "<Field label={t('背景边距', 'Bg Padding')}>");
  s = rep(s, '<Field label="背景圆角">', "<Field label={t('背景圆角', 'Bg Radius')}>");
  s = rep(s, '<Field label="字体粗细">', "<Field label={t('字体粗细', 'Font Weight')}>");

  // Toggle / hints / options
  s = rep(s, 'label="开启动画"', "label={t('开启动画', 'Animate')}");
  s = rep(s, 'label="背景"', "label={t('背景', 'Background')}");
  s = rep(s, '{t(\'点大小与文案标签等比放大（30%–300%）\')', 'SKIP'); // 占位防误替换
  s = s.replace('点大小与文案标签等比放大（30%–300%）', "{t('点大小与文案标签等比放大（30%–300%）', 'Scales point and label together (30%–300%)')}");
  s = s.replace("{pe.orientation === 'flat' ? '贴地：图形平铺在地图上，可旋转' : '面向摄像机：始终正对镜头（默认）'}",
    "{pe.orientation === 'flat' ? t('贴地：图形平铺在地图上，可旋转', 'Flat: lies on the ground, rotatable') : t('面向摄像机：始终正对镜头（默认）', 'Faces the camera (default)')}");
  s = s.replace("上传的图片统一为 64×64 方形图标，随项目保存", "{t('上传的图片统一为 64×64 方形图标，随项目保存', 'Uploads are normalized to 64×64 square icons, saved with the project')}");
  s = s.replace("选中地图上的元素以编辑属性", "{t('选中地图上的元素以编辑属性', 'Select an element on the map to edit')}");

  // 位置 / 字重 / 效果 选项块
  s = rep(s, "{ value: 'top', label: '上' }", "{ value: 'top', label: t('上', 'Top') }");
  s = rep(s, "{ value: 'bottom', label: '下' }", "{ value: 'bottom', label: t('下', 'Bottom') }");
  s = rep(s, "{ value: 'left', label: '左' }", "{ value: 'left', label: t('左', 'Left') }");
  s = rep(s, "{ value: 'right', label: '右' }", "{ value: 'right', label: t('右', 'Right') }");
  s = rep(s, "{ value: 'center' as const, label: '居中' }", "{ value: 'center' as const, label: t('居中', 'Center') }");
  s = rep(s, "{ value: 'normal', label: '常规' }", "{ value: 'normal', label: t('常规', 'Regular') }");
  s = rep(s, "{ value: 'bold', label: '加粗' }", "{ value: 'bold', label: t('加粗', 'Bold') }");
  s = rep(s, "{ value: 'blink', label: '闪烁' }", "{ value: 'blink', label: t('闪烁', 'Blink') }");
  s = rep(s, "{ value: 'pulse', label: '脉冲' }", "{ value: 'pulse', label: t('脉冲', 'Pulse') }");
  s = rep(s, "{ value: 'glow', label: '发光' }", "{ value: 'glow', label: t('发光', 'Glow') }");
  s = rep(s, "{ value: 'colorShift', label: '变色' }", "{ value: 'colorShift', label: t('变色', 'Color Shift') }");
  s = rep(s, "{ value: 'ring', label: '外环' }", "{ value: 'ring', label: t('外环', 'Ring') }");

  fs.writeFileSync(p, s, 'utf8');
  console.log('PropertiesPanel done, remaining bare 位置 label:', (s.match(/label="位置"/g) || []).length);
}

// ---------- KeyframePanel ----------
{
  const p = 'src/components/KeyframePanel.tsx';
  let s = fs.readFileSync(p, 'utf8');
  s = rep(s, "import { Section, Field, OptionBlocks } from './ui/primitives';",
    "import { Section, Field, OptionBlocks, useT } from './ui/primitives';");
  s = rep(s, '  const selectKeyframe = useEditorStore((s) => s.selectKeyframe);',
    '  const selectKeyframe = useEditorStore((s) => s.selectKeyframe);\n  const t = useT();');

  s = rep(s, '<h2 className="text-sm font-semibold">视角 {index + 1}</h2>',
    "<h2 className=\"text-sm font-semibold\">{t('视角', 'View')} {index + 1}</h2>");
  s = rep(s, '<Trash2 size={12} /> 删除', '<Trash2 size={12} /> {t(\'删除\', \'Delete\')}');
  s = rep(s, "<Crosshair size={12} /> 跳此视角", "<Crosshair size={12} /> {t('跳此视角', 'Go to View')}");
  s = rep(s, "<Plus size={12} /> 新视角", "<Plus size={12} /> {t('新视角', 'New View')}");
  s = rep(s, '<Section title="时间与过渡">', "<Section title={t('时间与过渡', 'Timing & Transition')}>");
  s = rep(s, '<Section title="视角参数">', "<Section title={t('视角参数', 'View Parameters')}>");
  s = rep(s, '<Field label="到达时间 (秒)">', "<Field label={t('到达时间 (秒)', 'Arrival Time (s)')}>");
  s = rep(s, '<Field label="移动持续时长 (秒，默认 2s)">', "<Field label={t('移动持续时长 (秒，默认 2s)', 'Move Duration (s, default 2s)')}>");
  s = rep(s, '<Field label="经度 (-180 ~ 180)">', "<Field label={t('经度 (-180 ~ 180)', 'Longitude (-180 ~ 180)')}>");
  s = rep(s, '<Field label="纬度 (-85 ~ 85)">', "<Field label={t('纬度 (-85 ~ 85)', 'Latitude (-85 ~ 85)')}>");
  s = rep(s, '<Field label="缩放 (0 ~ 22)">', "<Field label={t('缩放 (0 ~ 22)', 'Zoom (0 ~ 22)')}>");
  s = rep(s, '<Field label="俯仰 (0 ~ 85)">', "<Field label={t('俯仰 (0 ~ 85)', 'Pitch (0 ~ 85)')}>");
  s = rep(s, '<Field label="方向 (-180 ~ 180)">', "<Field label={t('方向 (-180 ~ 180)', 'Bearing (-180 ~ 180)')}>");
  s = rep(s, '<Field label="缓动">', "<Field label={t('缓动', 'Easing')}>");

  // 警告与提示双语
  s = s.replace('⚠️ 本视角与上一视角画面完全相同——这段播放时镜头不会移动。请先在地图上换个位置/缩放，再点「＋ 新视角」或直接修改下方参数。',
    "{t('⚠️ 本视角与上一视角画面完全相同——这段播放时镜头不会移动。请先在地图上换个位置/缩放，再点「＋ 新视角」或直接修改下方参数。', '⚠️ This view is identical to the previous one — the camera will stay still during playback. Move/zoom the map first, then add a new view or edit the parameters below.')}");
  s = s.replace('所有输入自动夹取到合法范围；相邻视角至少间隔 1 帧，起始视角（视角1）不可删除。',
    "{t('所有输入自动夹取到合法范围；相邻视角至少间隔 1 帧，起始视角（视角1）不可删除。', 'All inputs are clamped to valid ranges. Adjacent views are at least 1 frame apart; the first view cannot be deleted.')}");
  // 缓动选项双语
  s = s.replace('options={EASING_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.title }))}',
    `options={EASING_OPTIONS.map((o) => ({ value: o.value, title: o.title, label: t(o.label, { '平滑': 'Smooth', '匀速': 'Linear', '缓入': 'Ease In', '急停': 'Ease Out', '加速': 'Accelerate', '减速': 'Decelerate', '强平滑': 'Smooth+', '弹性': 'Spring', '弹跳': 'Bounce' }[o.label] || o.label) }))}`);

  fs.writeFileSync(p, s, 'utf8');
  console.log('KeyframePanel done');
}

// ---------- ElementsPanel ----------
{
  const p = 'src/components/ElementsPanel.tsx';
  let s = fs.readFileSync(p, 'utf8');
  s = rep(s, "import type { MapElement } from '../types';",
    "import { useT } from './ui/primitives';\nimport type { MapElement } from '../types';");
  s = rep(s, "  const [filter, setFilter] = useState('');",
    "  const [filter, setFilter] = useState('');\n  const t = useT();");
  s = s.replace('<Layers size={14} className="text-muted-foreground" /> 元素',
    '<Layers size={14} className="text-muted-foreground" /> {t(\'元素\', \'Layers\')}');
  s = s.replace('placeholder="搜索元素..."', 'placeholder={t(\'搜索元素...\', \'Search layers...\')}');
  s = s.replace('{kw ? \'无匹配元素\' : \'本章暂无元素\'}', '{kw ? t(\'无匹配元素\', \'No match\') : t(\'本章暂无元素\', \'No layers in this chapter\')}');
  s = s.replace('显示 {shown.length} / {chapterElements.length} 个元素',
    '{t(\'显示\', \'Showing\')} {shown.length} / {chapterElements.length} {t(\'个元素\', \'layers\')}');
  fs.writeFileSync(p, s, 'utf8');
  console.log('ElementsPanel done');
}

console.log('ALL DONE');
