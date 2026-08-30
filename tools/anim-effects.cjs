// 点动画特效系统重构：波纹扩散 + 脉冲尺寸呼吸 + 移除属性字段
const fs = require('fs');
const rep = (s, from, to, tag) => {
  if (!s.includes(from)) { console.log('MISS', tag || from.slice(0, 50)); return s; }
  return s.split(from).join(to);
};

// ---------- map-renderer.ts ----------
{
  const p = 'src/lib/map-renderer.ts';
  let s = fs.readFileSync(p, 'utf8');

  // 1) 注册表带 opts
  s = rep(s,
    "let highlightTargets: { layerId: string; kind: 'circle' | 'line' | 'fill' | 'symbol'; highlight: HighlightConfig }[] = [];",
    `type HighlightKind = 'circle' | 'line' | 'fill' | 'symbol' | 'ripple';
interface HighlightOpts { offset?: number; scale?: number; color?: string }
let highlightTargets: { layerId: string; kind: HighlightKind; highlight: HighlightConfig; opts?: HighlightOpts }[] = [];`
  , 'registry');

  // 2) applyHighlight 签名 + 透传 opts
  s = rep(s,
    `function applyHighlight(
  map: maplibregl.Map,
  layerId: string,
  highlight: HighlightConfig | undefined,
  frame: number,
  kind: 'circle' | 'line' | 'fill' | 'symbol'
): void {
  if (!highlight || !map.getLayer(layerId)) return;
  highlightTargets.push({ layerId, kind, highlight });
  applyHighlightPaint(map, layerId, highlight, frame, kind);
}`,
    `function applyHighlight(
  map: maplibregl.Map,
  layerId: string,
  highlight: HighlightConfig | undefined,
  frame: number,
  kind: HighlightKind,
  opts?: HighlightOpts
): void {
  if (!highlight || !map.getLayer(layerId)) return;
  highlightTargets.push({ layerId, kind, highlight, opts });
  applyHighlightPaint(map, layerId, highlight, frame, kind, opts);
}`
  , 'applyHighlight');

  // 3) applyHighlightPaint 签名
  s = rep(s,
    `function applyHighlightPaint(
  map: maplibregl.Map,
  layerId: string,
  highlight: HighlightConfig,
  frame: number,
  kind: 'circle' | 'line' | 'fill' | 'symbol'
): void {
  if (!map.getLayer(layerId)) return;`,
    `function applyHighlightPaint(
  map: maplibregl.Map,
  layerId: string,
  highlight: HighlightConfig,
  frame: number,
  kind: HighlightKind,
  opts?: HighlightOpts
): void {
  if (!map.getLayer(layerId)) return;`
  , 'paint-sign');

  // 4) pulse：symbol 位图真正尺寸呼吸
  s = rep(s,
    `      case 'pulse': {
        if (kind === 'symbol') {
          // 位图脉冲：透明度呼吸（尺寸呼吸交给 scale 参数）
          map.setPaintProperty(layerId, 'icon-opacity', 0.55 + 0.45 * ((wave + 1) / 2));
          break;
        }`,
    `      case 'pulse': {
        if (kind === 'symbol') {
          // 位图脉冲：尺寸呼吸 + 轻微透明度
          const s = (opts?.scale ?? 1) * (1 + 0.22 * wave);
          map.setLayoutProperty(layerId, 'icon-size', s);
          map.setPaintProperty(layerId, 'icon-opacity', 0.7 + 0.3 * ((wave + 1) / 2));
          break;
        }`
  , 'pulse');

  // 5) 新增 ripple case（插在 colorShift 前）
  s = rep(s,
    `      case 'colorShift': {`,
    `      case 'ripple': {
        // 波纹：圆环从点位向外扩散并淡出（opts.offset 双层错相）
        const s = opts?.scale ?? 1;
        const color = opts?.color || '#FF4444';
        const dur = Math.max(1, highlight.duration);
        const p = (((frame / dur) + (opts?.offset ?? 0)) % 1 + 1) % 1;
        map.setPaintProperty(layerId, 'circle-radius', 10 * s + p * 36 * s);
        map.setPaintProperty(layerId, 'circle-stroke-color', color);
        map.setPaintProperty(layerId, 'circle-stroke-opacity', (1 - p) * 0.9);
        break;
      }
      case 'colorShift': {`
  , 'ripple-case');

  // 6) renderPoint：高亮调用带 opts + 波纹层创建/注册
  s = rep(s,
    `  // 点动画：只作用于当前可见的图层（圆点 / 形状位图 / emoji / 标签位图）
  if (circleVisible) applyHighlight(map, layerId, element.highlight, frame, 'circle');
  const symbolLayers = [
    useShapeImg ? \`\${layerId}-shape\` : null,
    isEmoji ? \`\${layerId}-emoji\` : null,
    hasLabel ? labelLayerId : null,
  ].filter(Boolean) as string[];
  for (const lid of symbolLayers) {
    applyHighlight(map, lid, element.highlight, frame, 'symbol');
  }
}`,
    `  // 点动画：只作用于当前可见的图层（圆点 / 形状位图 / emoji / 标签位图）
  const hlOpts: HighlightOpts = { scale, color: pinColor };
  if (circleVisible) applyHighlight(map, layerId, element.highlight, frame, 'circle', hlOpts);
  const symbolLayers = [
    useShapeImg ? \`\${layerId}-shape\` : null,
    isEmoji ? \`\${layerId}-emoji\` : null,
    hasLabel ? labelLayerId : null,
  ].filter(Boolean) as string[];
  for (const lid of symbolLayers) {
    applyHighlight(map, lid, element.highlight, frame, 'symbol', hlOpts);
  }
  // 波纹特效层：highlight.type === 'ripple' 时叠加两层错相扩散圆环
  if (element.highlight?.type === 'ripple' && !hasIcon) {
    for (const [suffix, offset] of [['a', 0], ['b', 0.5]] as const) {
      const rid = \`\${layerId}-ripple-\${suffix}\`;
      if (!map.getLayer(rid)) {
        map.addLayer({
          id: rid, type: 'circle', source: sourceId,
          paint: {
            'circle-radius': 10,
            'circle-color': pinColor,
            'circle-opacity': 0,
            'circle-stroke-color': pinColor,
            'circle-stroke-width': 3,
            'circle-stroke-opacity': 0,
          },
        });
      }
      highlightTargets.push({ layerId: rid, kind: 'ripple', highlight: element.highlight, opts: { offset, scale, color: pinColor } });
    }
  }
}`
  , 'renderPoint-ripple');

  fs.writeFileSync(p, s, 'utf8');
  console.log('map-renderer done | ripple case:', s.includes("case 'ripple'"), '| opts:', s.includes('HighlightOpts'));
}

// ---------- PropertiesPanel：HighlightSection 精简 ----------
{
  const p = 'src/components/PropertiesPanel.tsx';
  let s = fs.readFileSync(p, 'utf8');

  // 默认创建：周期固定 1.5s
  s = rep(s,
    "setHighlight(highlight || { type: 'blink', color: '#FFD700', duration: Math.max(1, fps), intensity: 1 });",
    "setHighlight(highlight || { type: 'blink', color: '#FFD700', duration: Math.max(1, Math.round(fps * 1.5)), intensity: 1 });"
  , 'default-create');

  // 效果选项：闪烁/脉冲/发光/波纹（去掉点位上无效的变色/外环）
  s = rep(s,
    `options={[
                { value: 'blink', label: t('闪烁', 'Blink') },
                { value: 'pulse', label: t('脉冲', 'Pulse') },
                { value: 'glow', label: t('发光', 'Glow') },
                { value: 'colorShift', label: t('变色', 'Color Shift') },
                { value: 'ring', label: t('外环', 'Ring') },
              ]}`,
    `options={[
                { value: 'blink', label: t('闪烁', 'Blink') },
                { value: 'pulse', label: t('脉冲', 'Pulse') },
                { value: 'glow', label: t('光晕', 'Glow') },
                { value: 'ripple', label: t('波纹', 'Ripple') },
              ]}`
  , 'options');

  // 删除 颜色/周期/强度 属性字段
  s = rep(s,
    `          <Field label={t('颜色', 'Color')}>
            <ColorPicker value={highlight.color} onChange={(c) => update({ color: c })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('周期(秒)', 'Period (s)')}>
              <FrameTimeField value={highlight.duration} fps={fps} min={1} onFrameChange={(f) => update({ duration: Math.max(1, f) })} />
            </Field>
            <Field label={t('强度(0-1)', 'Intensity (0-1)')}>
              <input type="number" value={highlight.intensity} onChange={(e) => update({ intensity: clamp(parseFloat(e.target.value) || 1, 0, 1) })} className="input" step="0.1" />
            </Field>
          </div>`,
    `          <p className="text-[11px] text-muted-foreground leading-snug">${''}
            {t('周期固定 1.5 秒，波纹颜色跟随点的图标颜色。', 'Fixed 1.5s cycle; ripple color follows the point color.')}
          </p>`
  , 'remove-props');

  fs.writeFileSync(p, s, 'utf8');
  console.log('HighlightSection done | 颜色 removed:', !s.includes("value={highlight.color}"));
}
console.log('ALL DONE');
