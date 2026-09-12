import { createElement, useRef, useState, useEffect, useMemo, useCallback, type ReactNode } from 'react';
import { MapPin, Route as RouteIcon, Square, Trash2, Plus, Landmark, Crosshair } from 'lucide-react';
import { useProjectStore } from '../stores/projectStore';
import { useEditorStore } from '../stores/editorStore';
import { useInteractionStore } from '../stores/interactionStore';
import { generateId } from '../types';
import { FrameTimeField } from './FrameTimeField';
import { frameToSeconds, secondsToFrame, round2 } from '../lib/time';
import { TERRITORY_PALETTE } from '../lib/territory';
import { Section, Field, StyleGrid, Toggle, ColorPicker, OptionBlocks, PanelHeader, useT, NumberInput } from './ui/primitives';
import { useConfirm } from './ui/ConfirmHost';

import type {
  MapElement, PointElement, LineElement,
  PolygonElement, ArrowElement, FlagElement,
  DoubleArrowElement, EncirclementElement, GatheringElement,
  CameraKeyframe, TerritoryElement, PointShape,
} from '../types';
import { BUILTIN_IMAGES, BUILTIN_GIFS, BUILTIN_MODELS, BUILTIN_ICON_NAMES } from '../lib/builtin-assets';
import { defaultVisualFor, getPinCapability } from '../lib/pin-visual';
import { loadLucideIcons, filterExistingIcons, type IconComponent } from '../lib/icon-library';
import { uploadAsset, getAssetUrl, removeAsset, listMedia, type MediaItem, type AssetKind } from '../lib/assets';
import ms from 'milsymbol';
import { IS_DESKTOP } from '../lib/backend';
import { distributePointTimes, ensurePointTimes } from '../lib/route-time';

type Category = 'pin' | 'route' | 'shape-multi' | 'shape-two' | 'shape-special' | 'territory';

const CATEGORY_META: Record<Category, { icon: React.ReactNode; zh: string; en: string }> = {
  pin: { icon: <MapPin size={14} className="text-red-400" />, zh: '标记设置', en: 'Pin Settings' },
  route: { icon: <RouteIcon size={14} className="text-blue-400" />, zh: '路线设置', en: 'Route Settings' },
  'shape-multi': { icon: <Square size={14} className="text-orange-400" />, zh: '多点绘制设置', en: 'Multi-Point Shape Settings' },
  'shape-two': { icon: <Square size={14} className="text-orange-400" />, zh: '两点绘制设置', en: 'Two-Point Shape Settings' },
  'shape-special': { icon: <Square size={14} className="text-orange-400" />, zh: '特殊图形设置', en: 'Special Shape Settings' },
  territory: { icon: <Landmark size={14} className="text-violet-400" />, zh: '疆域设置', en: 'Territory Settings' },
};

function categoryOf(el: MapElement): Category {
  const t = el.type;
  if (t === 'territory') return 'territory';
  const sc = el.shapeCategory;
  if (sc === 'multi') return 'shape-multi';
  if (sc === 'two') return 'shape-two';
  if (sc === 'special') return 'shape-special';
  if (sc === 'route') return 'route';
  if (t === 'point' || t === 'flag') return 'pin';
  // 旧数据兼容：无 shapeCategory
  if (t === 'arrow' && (el as ArrowElement).arrowType === 'swallowtail') return 'shape-special';
  if (t === 'double_arrow' || t === 'encirclement') return 'shape-two';
  if (t === 'gathering') return 'shape-two';
  if (t === 'arrow' && (el as ArrowElement).arrowType === 'attack') return 'shape-special';
  // curvel/curved-simple 旧线面：路线菜单优先（路线燕尾/行军箭头）
  if (t === 'line' || t === 'moving_point' || t === 'arrow') return 'route';
  if (t === 'polygon') {
    const pk = (el as PolygonElement).shapeKind;
    if (pk === 'circle' || pk === 'rect') return 'shape-two';
    return 'shape-multi';
  }
  return 'pin';
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export function PropertiesPanel() {
  const t = useT();
  const confirm = useConfirm();
  const project = useProjectStore((s) => s.project);
  const updateElement = useProjectStore((s) => s.updateElement);
  const deleteElement = useProjectStore((s) => s.deleteElement);
  const selectedElementId = useEditorStore((s) => s.selectedElementId);
  const selectElement = useEditorStore((s) => s.selectElement);

  if (!project) return <EmptyPanel />;

  let element: MapElement | null = null;
  let chapterId = '';
  for (const chapter of project.chapters) {
    const found = chapter.elements.find((el) => el.id === selectedElementId);
    if (found) { element = found; chapterId = chapter.id; break; }
  }
  if (!element) return <EmptyPanel />;

  const cat = categoryOf(element);
  const meta = CATEGORY_META[cat];

  const patch = (changes: Partial<MapElement>) => {
    for (const [k, v] of Object.entries(changes)) {
      updateElement(chapterId, element!.id, { [k]: v } as Partial<MapElement>);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      {/* ===== 面板头：图标 + Settings 标题 + 关闭 ===== */}
      <PanelHeader icon={meta.icon} title={t(meta.zh, meta.en)} onClose={() => selectElement(null)} />

      <div className="p-3 space-y-3">
        {/* 顶部 LABEL：point/line 写 label.text，flag 写 text（旗上文字） */}
        <Section title={t('标签', 'Label')}>
          <input
            type="text"
            value={element.type === 'point' || element.type === 'line'
              ? (element.label?.text ?? '')
              : element.type === 'flag'
                ? (element as FlagElement).text
                : element.name}
            onChange={(e) => {
              const v = e.target.value;
              if (element.type === 'point' || element.type === 'line') {
                patch({
                  label: { ...(element.label || { fontSize: 13, color: '#FFFFFF' }), text: v },
                  name: v || element.name,
                });
              } else if (element.type === 'flag') {
                patch({ text: v, name: v });
              } else {
                patch({ name: v });
              }
            }}
            className="input"
            placeholder="LabelText"
          />
        </Section>

        {cat === 'pin' && <PinSettings element={element as PointElement | FlagElement} patch={patch} />}
        {cat === 'route' && <RouteSettings element={element} patch={patch} chapter={findChapterOf(project, element.id)!} />}
        {cat === 'shape-multi' && <MultiShapeSettings element={element} patch={patch} />}
        {cat === 'shape-two' && <TwoShapeSettings element={element} patch={patch} />}
        {cat === 'shape-special' && <SpecialShapeSettings element={element} patch={patch} />}
        {cat === 'territory' && <TerritorySettings element={element as TerritoryElement} patch={patch} project={project} />}

        {/* 显示时间：标记（含军标 / 旗）与图形类都有；路线有自己的时长体系故不显示 */}
        {cat !== 'route' && (
          <Section title={t('显示时间', 'Display Time')}>
            <DisplayTimeToggle element={element} patch={patch} project={project} />
          </Section>
        )}

        {/* LABEL 相关（Show Label / LABEL STYLE）：位于时间之后 */}
        {cat === 'pin' && element.type === 'point' && (() => {
          const pe = element as PointElement;
          const st = pinStyleOf(pe);
          // 所有点形态（含图片/动图/模型/图标）都支持标签，与 PIN/DOT 一致
          const fixedCenter = st === 'text' || st === 'bubble';
          return (
            <>
              <ShowLabelToggle element={pe} patch={patch} />
              {pe.label?.text && (
                <LabelStyleFields
                  label={pe.label}
                  fixedCenter={fixedCenter}
                  onChange={(l) => patch({ label: fixedCenter ? { ...l, position: 'center' } : l })}
                />
              )}
            </>
          );
        })()}

        {/* Delete Layer */}
        <button
          onClick={async () => { if (await confirm({ message: `删除「${element!.name}」？`, danger: true, confirmText: '删除' })) { deleteElement(chapterId, element!.id); selectElement(null); } }}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-red-400/80 rounded-md hover:bg-red-500/10 hover:text-red-400 transition-colors"
        >
          <Trash2 size={14} /> {t('删除图层', 'Delete Layer')}
        </button>


      </div>
    </div>
  );
}

function findChapterOf(project: NonNullable<ReturnType<typeof useProjectStore.getState>['project']>, elementId: string) {
  return project.chapters.find((c) => c.elements.some((e) => e.id === elementId)) || null;
}

function EmptyPanel() {
  const t = useT();
  return (
    <div className="p-4">
      <p className="text-sm text-muted-foreground">{t('选中地图上的元素以编辑属性', 'Select an element on the map to edit')}</p>
    </div>
  );
}

// ========== 通用 UI 原子：统一引用 ./ui/primitives ==========

/** 外观色板（图标颜色） */
function Appearance({ color, onChange }: { color: string; onChange: (c: string) => void }) {
  const t = useT();
  return (
    <Section title={t('图标颜色', 'Icon Color')}>
      <ColorPicker value={color} onChange={onChange} />
    </Section>
  );
}

/** 文案样式字段（文本输入在面板顶部 LABEL；此处只管样式） */
function LabelStyleFields({ label, onChange, allowCenter, fixedCenter }: {
  label: { text: string; fontSize?: number; color?: string; position?: string; bgColor?: string; bgPadding?: number; bgRadius?: number; fontWeight?: string };
  onChange: (l: any) => void;
  allowCenter?: boolean;
  fixedCenter?: boolean;
}) {
  const transparent = label.bgColor === 'transparent' || /rgba\([^)]*,\s*0\)\s*$/.test(label.bgColor || 'transparent');
  const hasBg = !transparent;
  const t = useT();
  return (
    <Section>
      {!fixedCenter && (
        <Field label={t('文案位置', 'Text Position')}>
          <OptionBlocks<'top' | 'bottom' | 'left' | 'right' | 'center'>
            value={(label.position || 'top') as any}
            onChange={(v) => onChange({ ...label, position: v })}
            options={[
              { value: 'top', label: t('上', 'Top') },
              { value: 'bottom', label: t('下', 'Bottom') },
              { value: 'left', label: t('左', 'Left') },
              { value: 'right', label: t('右', 'Right') },
              ...(allowCenter ? [{ value: 'center' as const, label: t('居中', 'Center') }] : []),
            ]}
          />
        </Field>
      )}
      <Field label={t('文字颜色', 'Text Color')}>
        <ColorPicker value={label.color || '#000000'} onChange={(c) => onChange({ ...label, color: c })} />
      </Field>

      {/* 背景开关：开启后才有背景颜色/边距/圆角 */}
      <Toggle
        checked={hasBg}
        label={t('背景', 'Background')}
        onChange={(v) => {
          const prev = label.bgColor && label.bgColor !== 'rgba(0,0,0,0)' && label.bgColor !== 'transparent'
            ? label.bgColor
            : '#FFFFFF';
          onChange({ ...label, bgColor: v ? prev : 'rgba(0,0,0,0)' });
        }}
      />
      {hasBg && (
        <>
          <Field label={t('背景颜色', 'Background Color')}>
            <ColorPicker value={label.bgColor || '#FFFFFF'} onChange={(c) => onChange({ ...label, bgColor: c })} />
          </Field>
        </>
      )}
    </Section>
  );
}

// ========== PIN ==========

type PinStyle = 'dot' | 'pin' | 'bubble' | 'emoji' | 'text' | 'flag' | 'image' | 'gif' | 'model' | 'icon' | 'milsym';

const EMOJI_CHOICES = ['📍', '🚩', '⚔️', '🏰', '🔥', '⭐', '✅', '❌', '💀', '🛡️', '⚓', '✈️', '🚀', '💥', '👑', '🎯', '🪖', '☢️', '🕊️', '🩸', '⚠️', '💤', '🧭', '📕'];

function PinSettings({ element, patch }: {
  element: PointElement | FlagElement;
  patch: (changes: Partial<MapElement>) => void;
}) {
  const pe = element as PointElement;
  const style: PinStyle = element.type === 'flag' ? 'flag' : pinStyleOf(pe);
  const coords = element.coordinates;
  const cap = getPinCapability(pe.shape);   // 能力矩阵：决定哪些控件可用
  const t = useT();

  return (
    <>
      <PinStyleChooser element={element} patch={patch} />

      <div className="grid grid-cols-2 gap-2">
        <Field label={t('经度', 'Longitude')}>
          <NumberInput value={coords[0].toFixed(5)} onCommit={(v) => patch({ coordinates: [v || 0, coords[1]] })} className="input" step="0.00001" />
        </Field>
        <Field label={t('纬度', 'Latitude')}>
          <NumberInput value={coords[1].toFixed(5)} onCommit={(v) => patch({ coordinates: [coords[0], v || 0] })} className="input" step="0.00001" />
        </Field>
      </div>

      {(
        <Section title={t('大小', 'Size')}>
          <div className="flex items-center gap-2">
            <input
              type="range" min="0.3" max="3" step="0.05" value={pe.scale ?? 1}
              onChange={(e) => patch({ scale: parseFloat(e.target.value) })}
              className="w-full"
            />
            <span className="text-xs w-12 text-right shrink-0">{Math.round((pe.scale ?? 1) * 100)}%</span>
          </div>
        </Section>
      )}

      {cap.canFlat && style !== 'flag' && (
        <Section title={t('朝向', 'Orientation')}>
          <StyleGrid<'faceCam' | 'flat'>
            value={pe.orientation ?? 'faceCam'}
            options={[
              { value: 'faceCam', label: t('🎥 面向镜头', '🎥 Face Cam') },
              { value: 'flat', label: t('🗺 贴地', '🗺 Flat') },
            ]}
            onChange={(v) => patch({ orientation: v, ...(v === 'faceCam' ? { rotation: 0 } : {}) })}
          />
          {(pe.orientation ?? 'faceCam') === 'flat' && (
            <Field label={t('旋转', 'Rotation')}>
              <div className="flex items-center gap-2">
                <input
                  type="range" min="0" max="360" step="1" value={Math.round(pe.rotation || 0)}
                  onChange={(e) => patch({ rotation: clamp(parseFloat(e.target.value) || 0, 0, 360) })}
                  className="w-full"
                />
                <span className="text-xs w-10 text-right shrink-0">{Math.round(pe.rotation || 0)}°</span>
              </div>
            </Field>
          )}
        </Section>
      )}

      {style === 'emoji' && (
        <Section title={t('表情', 'Emoji')}>
          <div className="grid grid-cols-8 gap-1 mb-2">
            {EMOJI_CHOICES.map((e2) => (
              <button
                key={e2}
                onClick={() => patch({ emoji: e2 })}
                className={`h-8 text-lg border rounded ${pe.emoji === e2 ? 'border-primary bg-accent' : 'hover:bg-accent'}`}
              >
                {e2}
              </button>
            ))}
          </div>
          <input
            type="text" maxLength={4} value={pe.emoji || '📍'}
            onChange={(e) => patch({ emoji: e.target.value })}
            className="input" placeholder="自定义字符"
          />
        </Section>
      )}

      {style === 'flag' && <FlagFields element={element as FlagElement} patch={patch} />}

      {/* 图标颜色：flag 的主色是旗面颜色，与其他点类型的「图标颜色」对齐 */}
      {style === 'flag' && (
        <Section title={t('图标颜色', 'Icon Color')}>
          <ColorPicker value={(element as FlagElement).flagColor} onChange={(c) => patch({ flagColor: c })} />
        </Section>
      )}

      {((['dot', 'pin', 'image', 'gif', 'model', 'icon'] as PinStyle[]).includes(style)) && cap.canTint && (
        <Appearance color={pe.color || '#FF4444'} onChange={(c) => patch({ color: c })} />
      )}

      {style === 'model' && (
        <Section title={t('模型', 'Model')}>
          <Field label={t('自转角速度（度/秒）', 'Auto rotate (°/s)')}>
            <NumberInput
              value={String(pe.visualMeta?.autoRotate ?? 0)}
              onCommit={(v) => patch({ visualMeta: { ...pe.visualMeta, autoRotate: v || 0 } })}
              className="input"
            />
          </Field>
          <Field label={t('初始朝向（度）', 'Initial angle (°)')}>
            <NumberInput
              value={String(pe.visualMeta?.spin ?? 0)}
              onCommit={(v) => patch({ visualMeta: { ...pe.visualMeta, spin: v || 0 } })}
              className="input"
            />
          </Field>
          <p className="text-[10px] text-muted-foreground/70">
            {t('模型以位图贴片呈现：不可着色、不能贴地，俯仰变化时不做透视变形', 'Rendered as billboard: no tint, no flat, no perspective')}
          </p>
        </Section>
      )}

      {style === 'icon' && (
        <Section title={t('图标', 'Icon')}>
          <Field label={t('描边粗细', 'Stroke width')}>
            <NumberInput
              value={String(pe.visualMeta?.strokeWidth ?? 2)}
              step="0.5"
              onCommit={(v) => patch({ visualMeta: { ...pe.visualMeta, strokeWidth: v || 2 } })}
              className="input"
            />
          </Field>
        </Section>
      )}

    </>
  );
}

/** PIN STYLE 选择区（标记与旗帜共用）：基础样式切换（图片 / 自定义图标已随 custom_icon 类型下线） */
function PinStyleChooser({ element, patch }: {
  element: MapElement;
  patch: (c: Partial<MapElement>) => void;
}) {
  const coords = (element as PointElement).coordinates;
  const pe = element as PointElement;
  const isFlag = element.type === 'flag';
  const style: PinStyle = isFlag ? 'flag' : pinStyleOf(pe);
  const t = useT();

  const setStyle = (s: PinStyle) => {
    // 从旗帜切回其他样式时，把残留的白色 color 重置为默认红
    const leavingFlag = style === 'flag';
    const colorReset = leavingFlag ? { color: '#FF4444' } : {};
    if (s === 'dot') {
      patch({ type: 'point', shape: undefined, iconUrl: undefined, coordinates: coords, ...colorReset } as Partial<MapElement>);
    } else if (s === 'pin' || s === 'bubble' || s === 'emoji') {
      patch({
        type: 'point', shape: s, iconUrl: undefined, coordinates: coords,
        ...(s === 'emoji' && !pe.emoji ? { emoji: '📍' } : {}),
        ...colorReset,
      } as Partial<MapElement>);
    } else if (s === 'text') {
      patch({
        type: 'point', shape: 'text', iconUrl: undefined, coordinates: coords, iconSize: 0,
        label: pe.label || { text: element.name || '文字', fontSize: 14, color: '#000000', position: 'center', bgColor: '#FFFFFF', bgPadding: 3, bgRadius: 3, fontWeight: 'bold' },
        ...colorReset,
      } as Partial<MapElement>);
    } else if (s === 'flag') {
      const lbl = pe.label;
      patch({
        type: 'flag', coordinates: coords, text: lbl?.text || element.name || '旗',
        flagColor: leavingFlag ? '#E23B3B' : (pe.color || '#E23B3B'), textColor: lbl?.color || '#FFFFFF',
        fontSize: 28, flagWidth: 216, scale: 1,
      } as Partial<MapElement>);
    } else if (s === 'image' || s === 'gif' || s === 'model' || s === 'icon' || s === 'milsym') {
      // 资源形态：交给能力矩阵补默认值，并清掉该形态不支持的字段（与数据库 CHECK 一致）。
      // 军标同样是 point 的资源形态：符号图 = milsymbol 生成（builtinId 'milsym:<SIDC>'），
      // 属性（大小/朝向/颜色/标签）与图片形态完全一致。
      patch({ type: 'point', coordinates: coords, ...defaultVisualFor(s === 'milsym' ? 'military_symbol' : (s as PointShape), pe) } as Partial<MapElement>);
    }
  };

  const blockBtn = 'flex items-center justify-center gap-1 px-1 py-1.5 text-[11px] font-medium rounded-md border truncate transition-colors';
  const blockOn = 'bg-brand/20 border-brand text-foreground font-semibold';
  const blockOff = 'bg-white/[0.03] border-white/10 text-foreground/80 hover:bg-accent hover:border-white/20';

  return (
    <Section title={t('样式', 'Pin Style')}>
      <div className="grid grid-cols-4 gap-1.5">
        {/* 基础样式（圆点 / 水滴针已归入「图片」类别） */}
        {([
          { value: 'bubble', label: '💬 BUBBLE' },
          { value: 'flag', label: t('🚩 旗帜', '🚩 MARKER') },
          { value: 'text', label: 'Aa TEXT' },
          { value: 'emoji', label: '😀 EMOJI' },
        ] as { value: PinStyle; label: string }[]).map((o) => (
          <button
            key={o.value}
            onClick={() => setStyle(o.value)}
            className={`${blockBtn} ${style === o.value ? blockOn : blockOff}`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {/* 资源形态：图片 / 动图 / 模型 / 图标库 / 军标 */}
      <div className="grid grid-cols-5 gap-1.5 mt-1.5">
        {([
          { value: 'image', label: t('🖼 图片', '🖼 IMAGE') },
          { value: 'gif', label: t('🎞 动图', '🎞 GIF') },
          { value: 'model', label: t('🧊 模型', '🧊 MODEL') },
          { value: 'icon', label: t('🔷 图标', '🔷 ICON') },
          { value: 'milsym', label: t('🎖 军标', '🎖 MIL') },
        ] as { value: PinStyle; label: string }[]).map((o) => (
          <button
            key={o.value}
            onClick={() => setStyle(o.value)}
            className={`${blockBtn} ${style === o.value ? blockOn : blockOff}`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <PinResourcePicker element={pe} style={style} patch={patch} />
    </Section>
  );
}

/** 资源形态的资源选择区：内置网格（图片 / 动图 / 模型 / 图标库）；上传入口下一步接入 */
/** 资源格子统一样式（标记 / 路线「显示标记」/ 自定义图片共用） */
const CELL_BASE = 'flex items-center justify-center rounded border transition-colors';
const CELL_ON = 'border-brand ring-2 ring-brand/60 bg-brand/20';
const CELL_OFF = 'border-white/10 bg-white/[0.03] hover:bg-accent hover:border-white/20';

/** lucide 图标网格（标记与路线「显示标记」共用；精选静态导入，同步可得） */
function IconGrid({ activeName, onPick }: { activeName?: string; onPick: (name: string) => void }) {
  const t = useT();
  const icons = useMemo(() => {
    const all = loadLucideIcons();
    const picked: Record<string, IconComponent> = {};
    for (const n of filterExistingIcons(BUILTIN_ICON_NAMES)) picked[n] = all[n];
    return picked;
  }, []);
  const names = Object.keys(icons);
  return (
    <div className="mt-2 rounded-md border border-white/10 bg-white/[0.02] p-2">
      {names.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t('无可用图标', 'No icons available')}</p>
      ) : (
        <div className="grid grid-cols-8 gap-1 max-h-44 overflow-y-auto">
          {names.map((name) => {
            const Icon = icons[name];
            return (
              <button
                key={name}
                title={name}
                onClick={() => onPick(name)}
                className={`${CELL_BASE} h-7 ${activeName === name ? CELL_ON : CELL_OFF}`}
              >
                {createElement(Icon, { size: 14 })}
              </button>
            );
          })}
        </div>
      )}
      <p className="mt-1.5 text-[10px] text-muted-foreground/70">
        {t(`内置 lucide 图标 ${names.length} 个`, `lucide icons (${names.length})`)}
      </p>
    </div>
  );
}

/**
 * 资源形态选择区（标记设置与路线「显示标记」共用）：内置图集 / 图标库 / 全局素材库 / 上传。
 * value 抽出两侧共有的资源字段；onPatch 把选择写回各自容器（元素顶层 / moveIcon）。
 * extraCells：插入在图集网格开头的额外单元格（标记为圆点 / 水滴针）。
 */
function VisualResourcePicker({ value, style, onPatch, extraCells }: {
  value: { builtinId?: string; assetId?: string; iconLib?: string; iconName?: string };
  style: 'image' | 'gif' | 'model' | 'icon';
  onPatch: (c: Record<string, unknown>) => void;
  extraCells?: ReactNode;
}) {
  const t = useT();
  // 全局图片素材库（跨项目可用）：列表 + 缩略图按 assetId 异步取 URL
  const { items: customImages, thumbs, refresh: refreshLibrary } = useImageLibrary(style === 'image');
  const deleteMedia = useDeleteMedia(refreshLibrary);

  if (style === 'icon') {
    return (
      <IconGrid
        activeName={value.iconName}
        onPick={(name) => onPatch({ shape: 'icon', iconLib: 'lucide', iconName: name, builtinId: undefined, assetId: undefined })}
      />
    );
  }

  const list = style === 'image' ? BUILTIN_IMAGES : style === 'gif' ? BUILTIN_GIFS : BUILTIN_MODELS;
  const resettable = { builtinId: undefined, assetId: undefined, iconUrl: undefined, iconLib: undefined, iconName: undefined };
  return (
    <div className="mt-2 rounded-md border border-white/10 bg-white/[0.02] p-2">
      {/* 图集网格（extraCells：标记的圆点 / 水滴针插入在首位） */}
      <div className="grid grid-cols-4 gap-1.5 max-h-44 overflow-y-auto">
        {extraCells}
        {list.map((a) => (
          <button
            key={a.id}
            title={a.name}
            onClick={() => onPatch({ ...resettable, shape: style, builtinId: a.id })}
            className={`${CELL_BASE} h-12 px-1 text-[10px] leading-tight text-center ${value.builtinId === a.id ? CELL_ON : CELL_OFF}`}
          >
            {a.src
              ? <img src={a.src} alt={a.name} className="w-6 h-6 object-contain" />
              : <span className="text-foreground/80">{a.name}</span>}
          </button>
        ))}
      </div>

      {/* 自定义图片：全局素材库（跨项目可用），上传后即可复用 */}
      {style === 'image' && (
        <>
          <p className="mt-2 mb-1 text-[10px] text-muted-foreground/70">{t('自定义图片（全局素材库）', 'Custom images (global library)')}</p>
          {customImages.length > 0 && (
            <CustomImageGrid
              images={customImages}
              thumbs={thumbs}
              activeId={value.assetId}
              onPick={(assetId) => onPatch({ ...resettable, shape: 'image', assetId })}
              onDelete={deleteMedia}
            />
          )}
          <ResourceUploadRow style="image" onLoaded={(assetId) => { onPatch({ ...resettable, shape: 'image', assetId }); refreshLibrary(); }} />
        </>
      )}
      {style !== 'image' && <ResourceUploadRow style={style} onLoaded={(assetId) => onPatch({ ...resettable, shape: style, assetId })} />}
    </div>
  );
}

/** 标记的资源选择（军标网格 + 圆点 / 水滴针快捷项 + 公共资源选择区） */
function PinResourcePicker({ element, style, patch }: {
  element: PointElement;
  style: PinStyle;
  patch: (c: Partial<MapElement>) => void;
}) {
  const t = useT();
  // 军标：按兵种 × 四阵营选符号（符号图由 milsymbol 生成，无上传）
  if (style === 'milsym') {
    return (
      <MilSymGrid
        activeSidc={element.builtinId?.startsWith('milsym:') ? element.builtinId.slice('milsym:'.length) : undefined}
        onPick={(sidc) => patch({
          shape: 'military_symbol' as PointShape, builtinId: `milsym:${sidc}`,
          assetId: undefined, iconUrl: undefined, iconLib: undefined, iconName: undefined,
        } as Partial<MapElement>)}
      />
    );
  }
  if (style !== 'image' && style !== 'gif' && style !== 'model' && style !== 'icon') return null;
  const isDot = !element.shape || element.shape === 'circle';
  return (
    <VisualResourcePicker
      value={element}
      style={style}
      onPatch={(c) => patch(c as Partial<MapElement>)}
      extraCells={style === 'image' ? (
        <>
          <button
            title={t('圆点', 'Dot')}
            onClick={() => patch({ builtinId: undefined, assetId: undefined, iconUrl: undefined, iconLib: undefined, iconName: undefined, shape: 'circle', color: element.color || '#FF4444' } as Partial<MapElement>)}
            className={`${CELL_BASE} h-12 ${isDot ? CELL_ON : CELL_OFF}`}
          >
            <span className="block w-4 h-4 rounded-full bg-white" />
          </button>
          <button
            title={t('水滴针', 'Pin')}
            onClick={() => patch({ builtinId: undefined, assetId: undefined, iconUrl: undefined, iconLib: undefined, iconName: undefined, shape: 'pin', color: element.color || '#FF4444' } as Partial<MapElement>)}
            className={`${CELL_BASE} h-12 ${element.shape === 'pin' ? CELL_ON : CELL_OFF}`}
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-white"><path d="M12 2c4.2 6.2 6 8.8 6 12.2A6 6 0 1 1 6 14.2C6 10.8 7.8 8.2 12 2z" /></svg>
          </button>
        </>
      ) : undefined}
    />
  );
}

/** 自定义图片网格（标记与路线共用，数据源为**全局素材库**）：缩略图 + 悬停删除 */
function CustomImageGrid({ images, thumbs, activeId, onPick, onDelete }: {
  images: MediaItem[];
  thumbs: Record<string, string>;
  activeId?: string;
  onPick: (assetId: string) => void;
  onDelete: (item: MediaItem) => void;
}) {
  return (
    <div className="grid grid-cols-4 gap-1.5 mb-1.5">
      {images.map((ci) => (
        <div key={ci.assetId} className="relative group">
          <button
            title={ci.name}
            onClick={() => onPick(ci.assetId)}
            className={`${CELL_BASE} h-12 w-full overflow-hidden ${activeId === ci.assetId ? CELL_ON : CELL_OFF}`}
          >
            {thumbs[ci.assetId]
              ? <img src={thumbs[ci.assetId]} alt={ci.name} className="w-6 h-6 object-contain" />
              : <span className="text-[10px] text-foreground/60">{ci.name.slice(0, 3)}</span>}
          </button>
          <button
            title="删除"
            onClick={(e) => { e.stopPropagation(); onDelete(ci); }}
            className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] leading-none hidden group-hover:flex items-center justify-center shadow"
          >×</button>
        </div>
      ))}
    </div>
  );
}

/** 全局图片素材库（跨项目可用）：列表 + 缩略图 URL；enabled 时加载 */
function useImageLibrary(enabled: boolean) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const refresh = useCallback(() => {
    void (async () => {
      const items = await listMedia('image');
      setItems(items);
      const next: Record<string, string> = {};
      for (const it of items) {
        const u = await getAssetUrl(it.assetId);
        if (u) next[it.assetId] = u;
      }
      setThumbs(next);
    })();
  }, []);
  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);
  return { items, thumbs, refresh };
}

/**
 * 删除全局素材：素材是**用户级资源**（跨项目共享），删除后所有项目都不再显示该条目。
 * 仍被元素引用时会有裂图风险，因此弹确认框由用户决定。
 */
function useDeleteMedia(refresh: () => void) {
  const confirm = useConfirm();
  const t = useT();
  return async (item: MediaItem) => {
    const ok = await confirm({
      message: `${t('从素材库删除', 'Delete from library')}「${item.name}」？${t('该素材将从所有项目中移除。', 'It will disappear from all projects.')}`,
      danger: true,
      confirmText: t('删除', 'Delete'),
    });
    if (!ok) return;
    await removeAsset(item.assetId);
    refresh();
  };
}

/** 路线「显示标记」的资源选择区（与标记的 PinResourcePicker 同构，选择写入 moveIcon） */
/** 路线「显示标记」的资源选择：完全复用标记的 VisualResourcePicker（图集/图标库/素材库/上传） */
function MoveResourcePicker({ mi, patch }: {
  mi: NonNullable<LineElement['moveIcon']>;
  patch: (c: Partial<MapElement>) => void;
}) {
  const t = useT();
  const shape = mi.shape as 'image' | 'gif' | 'model' | 'icon';
  const set = (c: Record<string, unknown>) =>
    patch({ moveIcon: { ...mi, ...c } } as Partial<MapElement>);
  const isDotMi = !mi.shape || mi.shape === 'dot';
  return (
    <VisualResourcePicker
      value={mi}
      style={shape}
      onPatch={set}
      extraCells={shape === 'image' ? (
        <>
          <button
            title={t('圆点', 'Dot')}
            onClick={() => set({ builtinId: undefined, assetId: undefined, iconLib: undefined, iconName: undefined, shape: 'dot', color: mi.color || '#FF6600' })}
            className={`${CELL_BASE} h-12 ${isDotMi ? CELL_ON : CELL_OFF}`}
          >
            <span className="block w-4 h-4 rounded-full bg-white" />
          </button>
          <button
            title={t('水滴针', 'Pin')}
            onClick={() => set({ builtinId: undefined, assetId: undefined, iconLib: undefined, iconName: undefined, shape: 'pin', color: mi.color || '#FF6600' })}
            className={`${CELL_BASE} h-12 ${mi.shape === 'pin' ? CELL_ON : CELL_OFF}`}
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-white"><path d="M12 2c4.2 6.2 6 8.8 6 12.2A6 6 0 1 1 6 14.2C6 10.8 7.8 8.2 12 2z" /></svg>
          </button>
        </>
      ) : undefined}
    />
  );
}

/**
 * 资源上传：按形态限定格式，上传后进 asset 表（外置存储）。
 * 图片形态同时登记进项目「自定义图片」库（内容寻址去重），之后可跨元素 / 跨路线复用。
 * onLoaded 决定把 assetId 落到哪里（元素顶层 或 moveIcon）。
 */
function ResourceUploadRow({ style, onLoaded }: {
  style: PinStyle;
  onLoaded: (assetId: string, fileName: string) => void;
}) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 每次上传后重建 input（key 变化）→ 彻底避免 value 残留导致「再选同一文件不触发 onChange」
  const [nonce, setNonce] = useState(0);

  const accept =
    style === 'image' ? 'image/png,image/jpeg,image/webp,image/svg+xml' :
      style === 'gif' ? 'image/gif,image/webp' :
        style === 'model' ? '.glb,.gltf,model/gltf-binary,model/gltf+json' : '';
  const hint =
    style === 'image' ? t('PNG / JPG / WEBP / SVG', 'PNG / JPG / WEBP / SVG') :
      style === 'gif' ? t('GIF / 动态 WEBP', 'GIF / animated WEBP') :
        t('GLB / GLTF（建议 < 20MB）', 'GLB / GLTF (< 20MB recommended)');

  // 网页端为静态浏览形态，不支持上传（定位见用户约定：仅桌面端上传）
  if (!IS_DESKTOP) {
    return <p className="mt-1.5 text-[10px] text-muted-foreground/70">{t('上传功能仅桌面端支持', 'Upload is desktop-only')}</p>;
  }

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        className="w-full h-7 rounded border border-dashed border-white/15 text-[11px] text-foreground/80 hover:bg-accent transition-colors disabled:opacity-50"
      >
        {busy ? t('上传中…', 'Uploading…') : t('⬆ 上传自有资源', '⬆ Upload')}
      </button>
      <input
        key={nonce}
        ref={fileRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setErr(null);
          setBusy(true);
          try {
            // kind 由面板形态显式指定（图片 / 动图 / 模型），落盘目录与素材库分类随之确定
            const kind: AssetKind = style === 'gif' ? 'gif' : style === 'model' ? 'model' : 'image';
            const ref = await uploadAsset(file, kind);
            onLoaded(ref.assetId, file.name);
            // 素材进入**全局素材库**（跨项目可用），不属于任何项目 —— 无需写项目、无回滚问题
          } catch (e2) {
            console.error('[asset] 上传失败', e2);
            setErr(String((e2 as Error)?.message || e2));
          } finally {
            setBusy(false);
            setNonce((n) => n + 1);   // 重建 input，下一次可继续上传（含同一文件）
          }
        }}
      />
      <p className="mt-1 text-[10px] text-muted-foreground/70">{hint}</p>
      {err && <p className="mt-1 text-[10px] text-red-400">{t('上传失败', 'Upload failed')}：{err}</p>}
    </div>
  );
}
/** 显示时间：默认全程显示（不开启），开启后可自定义起止时间 */
function DisplayTimeToggle({ element, patch, project }: {
  element: MapElement;
  patch: (c: Partial<MapElement>) => void;
  project: NonNullable<ReturnType<typeof useProjectStore.getState>['project']>;
}) {
  const t = useT();
  const ch = project.chapters.find((c) => c.elements.some((e) => e.id === element.id)) || project.chapters[0];
  const fps = project.globalConfig.defaultFPS;
  // 与章节全范围一致 → 关闭（全程显示）
  const on = element.startFrame !== ch.startFrame || element.endFrame !== ch.endFrame;

  return (
    <>
      <Toggle
        checked={on}
        label={t('自定义显示时间', 'Custom display time')}
        onChange={(v) => {
          if (v) {
            // 开启：写入默认自定义区间（章节中段 25%~75%），使 on 立即生效，用户随后微调
            const span = Math.max(1, ch.endFrame - ch.startFrame);
            patch({
              startFrame: ch.startFrame + Math.round(span * 0.25),
              endFrame: ch.startFrame + Math.round(span * 0.75),
            });
          } else {
            patch({ startFrame: ch.startFrame, endFrame: ch.endFrame });
          }
        }}
      />
      {on && (
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('开始时间', 'Start Time')}>
            <FrameTimeField value={element.startFrame} fps={fps} onFrameChange={(f) => patch({ startFrame: f })} />
          </Field>
          <Field label={t('结束时间', 'End Time')}>
            <FrameTimeField value={element.endFrame} fps={fps} onFrameChange={(f) => patch({ endFrame: f })} />
          </Field>
        </div>
      )}
    </>
  );
}

/** 大小滑杆（百分比形式：base px = 100%，变化时箭头等比缩放） */
function SizeSlider({ value, base = 8, minPct = 15, maxPct = 400, step = 5, onChange }: {
  value: number;
  base?: number;
  minPct?: number;
  maxPct?: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  const pct = Math.round((value / base) * 100);
  const displayPct = Math.min(maxPct, Math.max(minPct, pct));
  return (
    <div className="w-full">
      <div className="relative flex items-center">
        <input
          type="range"
          min={minPct}
          max={maxPct}
          step={step}
          value={displayPct}
          onChange={(e) => {
            const p = parseFloat(e.target.value) || minPct;
            onChange(Math.max(0.5, (p / 100) * base));
          }}
          className="w-full appearance-none h-4 bg-transparent
            [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full
            [&::-webkit-slider-runnable-track]:bg-white/10
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand
            [&::-webkit-slider-thumb]:-mt-[5px] [&::-webkit-slider-thumb]:shadow-[0_0_0_3px_rgba(0,0,0,0.35)]
            [&::-webkit-slider-thumb]:hover:bg-brand/90
            focus:outline-none"
        />
      </div>
      <div className="flex items-center justify-between mt-0.5">
        <span className="text-[10px] text-muted-foreground">{minPct}%</span>
        <span className="text-[11px] font-medium text-foreground/90">{displayPct}%</span>
        <span className="text-[10px] text-muted-foreground">{maxPct}%</span>
      </div>
    </div>
  );
}

const rangeCls = `w-full appearance-none h-4 bg-transparent
  [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full
  [&::-webkit-slider-runnable-track]:bg-white/10
  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5
  [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-brand
  [&::-webkit-slider-thumb]:-mt-[5px] [&::-webkit-slider-thumb]:shadow-[0_0_0_3px_rgba(0,0,0,0.35)]
  [&::-webkit-slider-thumb]:hover:bg-brand/90
  focus:outline-none`;

/** 绝对值滑杆（数值随标签显示），用于边框宽度/防御圈齿参/填充透明度等 */
function RangeInput({ value, min, max, step = 1, suffix = '', onChange }: {
  value: number; min: number; max: number; step?: number; suffix?: string; onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className={`${rangeCls} flex-1`} />
      <span className="text-[11px] font-medium text-foreground/90 w-10 text-right shrink-0">{value}{suffix}</span>
    </div>
  );
}

// ========== 军标（military_symbol 元素）==========

/** 四种阵营（SIDC 身份码，位置 2）：框架形状与配色由 milsymbol 按标准自动生成 */
const MILSYM_AFFS = [
  { aff: 'F', name: '友好' },   // 蓝色矩形
  { aff: 'H', name: '敌对' },   // 红色菱形
  { aff: 'N', name: '中性' },   // 绿色方形
  { aff: 'U', name: '未知' },   // 黄色四叶
] as const;

/** 地面单元主图标全集（功能码取自 milsymbol 内部 2525C 映射表，100% 对应官方规范）。
 *  fid = SIDC 功能段（6 位，如 UCI---）；SIDC = S<身份>G-<fid>。 */
const MILSYM_ICONS: { fid: string; name: string }[] = [
  // —— 战斗兵种（Combat Arms，UC*）——
  { fid: 'UCI---', name: '步兵' },
  { fid: 'UCA---', name: '装甲' },
  { fid: 'UCF---', name: '炮兵' },
  { fid: 'UCD---', name: '防空' },
  { fid: 'UCVF--', name: '固定翼' },
  { fid: 'UCV---', name: '直升机' },
  { fid: 'UCE---', name: '工程' },
  { fid: 'UCR---', name: '侦察' },
  { fid: 'UCM---', name: '导弹' },
  { fid: 'UCS---', name: '警戒' },
  // —— 战斗勤务支援（Combat Service Support，US*）——
  { fid: 'USM---', name: '医疗' },
  { fid: 'USS---', name: '补给' },
  { fid: 'UST---', name: '运输' },
  { fid: 'USX---', name: '维护' },
  { fid: 'USA---', name: '行政' },
  // —— 其它职能（UU*）——
  { fid: 'UUS---', name: '通信' },
  { fid: 'UUM---', name: '军事情报' },
  { fid: 'UUL---', name: '宪兵' },
  { fid: 'UUA---', name: '核生化' },
  { fid: 'UUE---', name: '排爆' },
  { fid: 'UUI---', name: '信息作战' },
  { fid: 'UUT---', name: '测绘' },
  { fid: 'UUX---', name: '两栖' },
  { fid: 'UUD---', name: '钻探' },
];

/** 由「身份 + 功能码」拼 SIDC（2525C） */
const milSymSidc = (aff: string, fid: string): string => `S${aff}G-${fid}`;

/** 军标选择网格：每兵种一行 × [友好|敌对|中性|未知] 四阵营。
 *  选中写入 shape='military_symbol' + builtinId='milsym:<SIDC>'，
 *  符号图由 milsymbol 按官方规范生成；其余属性（大小/朝向/颜色/标签）与图片形态一致。 */
function MilSymGrid({ activeSidc, onPick }: {
  activeSidc?: string;
  onPick: (sidc: string) => void;
}) {
  const t = useT();
  // SIDC → 预览 dataURL（一次生成；单个符号失败不影响其余）
  const previews = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of MILSYM_ICONS) {
      for (const a of MILSYM_AFFS) {
        const sidc = milSymSidc(a.aff, row.fid);
        try { map.set(sidc, new ms.Symbol(sidc, { size: 28, fill: true }).toDataURL()); } catch { /* */ }
      }
    }
    return map;
  }, []);

  return (
    <div className="mt-2 rounded-md border border-white/10 bg-white/[0.02] p-2">
      {/* 阵营列头 */}
      <div className="grid grid-cols-[56px_repeat(4,1fr)] gap-1 mb-1">
        <span />
        {MILSYM_AFFS.map((a) => (
          <span key={a.aff} className="text-center text-[10px] text-muted-foreground">{t(a.name, a.name)}</span>
        ))}
      </div>
      {/* 每兵种一行：行首中文名 + 四阵营符号 */}
      <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
        {MILSYM_ICONS.map((row) => (
          <div key={row.fid} className="grid grid-cols-[56px_repeat(4,1fr)] gap-1">
            <span className="flex items-center text-[10px] text-foreground/80">{row.name}</span>
            {MILSYM_AFFS.map((a) => {
              const sidc = milSymSidc(a.aff, row.fid);
              const active = activeSidc === sidc;
              return (
                <button
                  key={a.aff}
                  title={`${row.name} · ${a.name}`}
                  onClick={() => onPick(sidc)}
                  className={`h-11 rounded-md border flex items-center justify-center transition-colors ${
                    active ? 'border-primary bg-accent' : 'border-white/10 bg-white/[0.03] hover:bg-accent'
                  }`}
                >
                  {previews.get(sidc) && <img src={previews.get(sidc)} alt={`${row.name} ${a.name}`} className="w-7 h-7 object-contain" />}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function pinStyleOf(pe: PointElement): PinStyle {
  if (pe.shape === 'gif') return 'gif';
  if (pe.shape === 'model') return 'model';
  if (pe.shape === 'icon') return 'icon';
  if (pe.shape === 'military_symbol') return 'milsym';
  if (pe.shape === 'text') return 'text';
  if (pe.shape === 'bubble') return 'bubble';
  if (pe.shape === 'emoji') return 'emoji';
  // 「图片」类别：圆点 / 水滴针是内置图形（shape = circle / pin），与内置图片同属一类
  return 'image';
}

function ShowLabelToggle({ element, patch }: { element: PointElement; patch: (c: Partial<MapElement>) => void }) {
  const t = useT();
  const shown = !!element.label?.text;
  return (
    <div className="bg-black/40 border border-white/[0.08] rounded-[10px] px-3 py-2.5">
      <Toggle
        checked={shown}
        label={t('显示标签', 'Show Label')}
        onChange={(v) => {
          if (v) {
            const base = (element.label || {}) as NonNullable<PointElement['label']>;
            patch({
              label: {
                ...base,
                text: base.text || element.name || '标签',
                color: base.color ?? '#000000',
                position: base.position ?? (element.shape === 'text' ? 'center' : 'top'),
                bgColor: base.bgColor ?? '#FFFFFF',
                bgPadding: base.bgPadding ?? 6,
              },
            });
          } else {
            patch({ label: { ...(element.label || {}), text: '' } });
          }
        }}
      />
    </div>
  );
}

function FlagFields({ element, patch }: { element: FlagElement; patch: (c: Partial<MapElement>) => void }) {
  const t = useT();
  return (
    <Section title={t('旗帜样式', 'Marker Style')}>
      <Field label={t('文字颜色', 'Text Color')}>
        <ColorPicker value={element.textColor} onChange={(c) => patch({ textColor: c })} />
      </Field>
      <Field label={t('文字大小', 'Font Size')}>
        <input type="number" value={element.fontSize} onChange={(e) => patch({ fontSize: parseInt(e.target.value) || 14 })} className="input" min="8" max="40" />
      </Field>
    </Section>
  );
}

// ========== ROUTE ==========

type RouteStyle = 'straight' | 'bezier' | 'arc' | 'swallowtail' | 'curved' | 'pincer' | 'straight-arrow' | 'curved-arrow' | 'military-arrow' | 'military-simple' | 'plain-straight' | 'plain-bezier';

function routeCoords(el: MapElement): [number, number][] {
  switch (el.type) {
    case 'line': return el.coordinates;
    case 'moving_point': return el.path;
    case 'arrow': return el.path && el.path.length >= 2 ? el.path : [el.from, el.to];
    case 'double_arrow': return el.points;
    default: return [];
  }
}

function pad4(c: [number, number][]): [number, number][] {
  if (c.length === 0) return [[104, 35], [105, 35], [105, 36], [104, 36]];
  const out = [...c];
  let last = out[out.length - 1];
  while (out.length < 4) {
    last = [last[0] + 0.5, last[1] + 0.5];
    out.push(last);
  }
  return out.slice(0, 4);
}

function RouteSettings({ element, patch, chapter }: {
  element: MapElement;
  patch: (changes: Partial<MapElement>) => void;
  chapter: NonNullable<ReturnType<typeof useProjectStore.getState>['project']>['chapters'][number];
}) {
  const t = useT();
  const fps = useProjectStore((s) => s.project?.globalConfig.defaultFPS ?? 30);
  const routeEdit = useEditorStore((s) => s.routeEdit);
  const setRouteEdit = useEditorStore((s) => s.setRouteEdit);
  const coords = routeCoords(element);
  const wasArrowRef = useRef<{ type: ArrowElement['arrowType']; width: number } | null>(null);
  if (element.type === 'arrow') wasArrowRef.current = { type: element.arrowType, width: element.width };
  if (element.type !== 'moving_point' && element.type !== 'arrow') wasArrowRef.current = null;
  const widthOf = element.type === 'line' ? element.lineWidth : element.type === 'arrow' ? (element as ArrowElement).width : 3;
  const pathField = element.type === 'moving_point' || element.type === 'arrow' ? 'path' : element.type === 'double_arrow' ? 'points' : 'coordinates';
  const colorOf = element.type === 'line' ? element.lineColor
    : element.type === 'moving_point' ? element.color || '#FF6600'
    : (element as ArrowElement).color || '#E23B3B';

  const current: RouteStyle =
    element.type === 'line' ? ((element as LineElement).plainPath
      ? ((element as LineElement).lineType === 'bezier' ? 'plain-bezier' : 'plain-straight')
      : ((element as LineElement).lineArrow
        ? ((element as LineElement).lineType === 'bezier' ? 'curved-arrow' : 'straight-arrow')
        : ((element as LineElement).lineType === 'bezier' ? 'bezier' : (element as LineElement).lineType === 'arc' ? 'arc' : 'straight')))
    : element.type === 'arrow' ? ((element as ArrowElement).arrowType === 'curved-simple' ? 'military-simple' : 'military-arrow')
    : element.type === 'double_arrow' ? 'pincer'
    : 'straight';

  const setStyle = (s: RouteStyle) => {
    const start = chapter.startFrame;
    if (s === 'plain-straight' || s === 'plain-bezier') {
      patch({
        type: 'line', coordinates: coords.length >= 2 ? coords : [[104, 35], [105, 36]],
        lineType: s === 'plain-bezier' ? 'bezier' : 'straight', lineArrow: false, plainPath: true,
        drawProgress: [{ frame: start, value: 1 }],
        lineWidth: 8, lineColor: colorOf, shapeCategory: 'route' as const,
      } as Partial<MapElement>);
    } else if (s === 'straight' || s === 'bezier' || s === 'arc') {
      patch({
        type: 'line', coordinates: coords.length >= 2 ? coords : [[104, 35], [105, 36]],
        lineType: s, lineArrow: false, drawProgress: [{ frame: start, value: 1 }],
        lineWidth: 8, lineColor: colorOf, shapeCategory: 'route' as const, plainPath: undefined,
      } as Partial<MapElement>);
    } else if (s === 'straight-arrow') {
      patch({
        type: 'line', coordinates: coords.length >= 2 ? coords : [[104, 35], [105, 36]],
        lineType: 'straight', lineArrow: true, drawProgress: [{ frame: start, value: 1 }],
        lineWidth: 8, lineColor: colorOf, shapeCategory: 'route' as const,
      } as Partial<MapElement>);
    } else if (s === 'curved-arrow') {
      patch({
        type: 'line', coordinates: coords.length >= 2 ? coords : [[104, 35], [105, 36]],
        lineType: 'bezier', lineArrow: true, drawProgress: [{ frame: start, value: 1 }],
        lineWidth: 8, lineColor: colorOf, shapeCategory: 'route' as const,
      } as Partial<MapElement>);
    } else if (s === 'military-arrow') {
      const pts = coords.length >= 2 ? coords : [[104, 35], [105, 36]];
      patch({
        type: 'arrow', from: pts[0] as [number, number], to: pts[pts.length - 1] as [number, number], path: pts.map(p => [p[0], p[1]]),
        arrowType: 'curved', width: 15, color: colorOf,
        progress: [{ frame: start, value: 1 }], drawZoom: undefined,
        shapeCategory: 'route' as const,
      } as Partial<MapElement>);
    } else if (s === 'military-simple') {
      const pts = coords.length >= 2 ? coords : [[104, 35], [105, 36]];
      patch({
        type: 'arrow', from: pts[0] as [number, number], to: pts[pts.length - 1] as [number, number], path: pts.map(p => [p[0], p[1]]),
        arrowType: 'curved-simple', width: 15, color: colorOf,
        progress: [{ frame: start, value: 1 }], drawZoom: undefined,
        shapeCategory: 'route' as const,
      } as Partial<MapElement>);
    } else {
      patch({
        type: 'double_arrow', points: pad4(coords), color: colorOf,
        progress: [{ frame: start, value: 1 }],
      } as Partial<MapElement>);
    }
  };

  return (
    <>
      <Section title={t('路线类型', 'Route Type')}>
        <StyleGrid<RouteStyle>
          value={current}
          options={[
            { value: 'straight', label: '─ 直线' },
            { value: 'bezier', label: '〰 曲线' },
            { value: 'straight-arrow', label: t('──▶ 带箭头直线', '──▶ Arrow Line') },
            { value: 'curved-arrow', label: t('➤ 箭头曲线', '➤ Curved Arrow') },
            { value: 'military-arrow', label: t('🏹 燕尾箭头', '🏹 Swallowtail') },
            { value: 'military-simple', label: t('⚔️ 行军箭头', '⚔️ March Arrow') },
            { value: 'plain-straight', label: t('➖ 无样式直线', '➖ Plain Line') },
            { value: 'plain-bezier', label: t('〰️ 无样式曲线', '〰️ Plain Curve') },
          ]}
          onChange={setStyle}
        />
      </Section>

      <Section title={t('动画效果', 'Animation Effect')}>
        <OptionBlocks<'grow' | 'move' | 'fill' | 'march' | 'marchplain'>
          value={(element as LineElement).animEffect || 'grow'}
          onChange={(v) => {
            const le = element as LineElement;
            const start = element.startFrame;
            const end = element.endFrame;
            // 选择动画效果时自动配置动画区间（drawProgress 增长 / 移动起止）
            const isDone = (le.drawProgress?.length ?? 0) === 0 || (le.drawProgress?.[le.drawProgress.length - 1]?.value ?? 1) >= 1;
            const patchBase: Record<string, unknown> = { animEffect: v };
            if (v === 'move') {
              patchBase.moveStartFrame = le.moveStartFrame ?? start;
              patchBase.moveEndFrame = le.moveEndFrame ?? end;
              patchBase.showIcon = le.showIcon ?? true;
            } else if (isDone) {
              // grow / fill：线从 0 增长到 1
              patchBase.drawProgress = [{ frame: start, value: 0 }, { frame: end, value: 1 }];
            }
            patch(patchBase as unknown as Partial<MapElement>);
          }}
          options={[
            { value: 'grow', label: t('📈 普通增长', '📈 Grow') },
            { value: 'move', label: t('🏃 路线移动', '🏃 Move') },
            { value: 'fill', label: t('🎨 填充', '🎨 Fill') },
            { value: 'march', label: t('🚶 填充行进', '🚶 Fill March') },
            { value: 'marchplain', label: t('👣 行进', '👣 March') },
          ]}
        />
        <div className="mt-2">
          <Toggle
            checked={!!(element as MapElement).flyMode}
            label={t('✈️ 飞行（路线与图标不贴地）', '✈️ Fly (route & icon elevated)')}
            onChange={(v) => patch({ flyMode: v } as Partial<MapElement>)}
          />
        </div>
      </Section>

      <Section title={t('显示时间', 'Display Time')}>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('开始时间', 'Start Time')}>
            <FrameTimeField value={element.startFrame} fps={fps} onFrameChange={(f) => patch({ startFrame: Math.max(0, f) } as Partial<MapElement>)} />
          </Field>
          <Field label={t('结束时间', 'End Time')}>
            <FrameTimeField value={element.endFrame} fps={fps} onFrameChange={(f) => patch({ endFrame: Math.max(element.startFrame + 1, f) } as Partial<MapElement>)} />
          </Field>
        </div>
      </Section>

      <Section title={t('笔触', 'Stroke')}>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('大小', 'Size')}>
            <SizeSlider base={element.type === 'arrow' ? 15 : 8} value={widthOf} onChange={(v) => {
              if (element.type === 'line') patch({ lineWidth: v });
              else if (element.type === 'arrow') patch({ width: v } as Partial<MapElement>);
            }} />
          </Field>
          <Field label={t('颜色', 'Color')}>
            <ColorPicker value={colorOf} onChange={(c) => {
              if (element.type === 'line') patch({ lineColor: c });
              else if (element.type === 'moving_point') patch({ color: c });
              else if (element.type === 'arrow') patch({ color: c });
              else patch({ color: c });
            }} />
          </Field>
        </div>
      </Section>



      {/* 路线路径点编辑（所有路线类型一致） */}
      {(
        element.type === 'line' || element.type === 'moving_point' || element.type === 'arrow' || element.type === 'double_arrow'
      ) && (
        <Section title={t('路径点', 'Path Points')}>
          {((element as LineElement).showIcon || (element as LineElement).animEffect === 'move') && (
            <div className="mb-2">
              <Toggle
                checked={(element as LineElement).uniformMove !== false}
                label={t('均匀移动', 'Uniform Move')}
                onChange={(v) => {
                  if (v) return void patch({ uniformMove: true } as Partial<MapElement>);
                  // 关闭：按路径长度比例生成各点到达时间作为初始值（等价于匀速，之后可逐点微调）
                  const s = (element as LineElement).moveStartFrame ?? element.startFrame;
                  const e = (element as LineElement).moveEndFrame ?? element.endFrame;
                  patch({ uniformMove: false, pointTimes: distributePointTimes(coords, s, e) } as Partial<MapElement>);
                }}
              />
            </div>
          )}
          {((element as LineElement).uniformMove !== false) && (
            <div className="mb-2 space-y-2 border-t border-white/[0.08] pt-2">
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('动画开始时间', 'Anim Start')}>
                  <FrameTimeField value={(element as LineElement).moveStartFrame ?? element.startFrame} fps={fps} onFrameChange={(f) => patch({ moveStartFrame: Math.max(element.startFrame, Math.min(element.endFrame, f)) } as Partial<MapElement>)} />
                </Field>
                <Field label={t('动画结束时间', 'Anim End')}>
                  <FrameTimeField value={(element as LineElement).moveEndFrame ?? element.endFrame} fps={fps} onFrameChange={(f) => patch({ moveEndFrame: Math.max(element.startFrame, Math.min(element.endFrame, f)) } as Partial<MapElement>)} />
                </Field>
              </div>
              <p className="text-[10px] text-muted-foreground">必须在显示时间区间内；由「路线移动」动画使用</p>
            </div>
          )}
          <div className="flex gap-1.5 mb-1.5">
            <button
              onClick={() => setRouteEdit(routeEdit === 'add' ? 'none' : 'add')}
              className={`px-2 py-1 text-[11px] font-medium rounded-md border transition-colors ${routeEdit === 'add' ? 'bg-brand/20 border-brand text-foreground font-semibold' : 'bg-white/[0.03] border-white/10 text-foreground/80 hover:bg-accent'}`}
            >
              {t('＋ 添加点', '＋ Add Point')}
            </button>
          </div>
          {routeEdit !== 'none' && (
            <p className="text-[11px] text-muted-foreground mb-1.5">
              {routeEdit === 'add' ? t('点击地图上的位置新增路径点（追加到终点）', 'Click the map to append a point at the end') : ''}
            </p>
          )}
          <div className="max-h-44 overflow-y-auto">
            {coords.map((coord, i) => {
              const le = element as LineElement;
              const showTimes = le.uniformMove === false;
              const times = ensurePointTimes(coords, le.pointTimes, le.moveStartFrame ?? element.startFrame, le.moveEndFrame ?? element.endFrame);
              const ptTime = times[i] ?? (i === 0 ? (le.moveStartFrame ?? element.startFrame) : (le.moveEndFrame ?? element.endFrame));
              return (
              <div key={i} className="flex items-center gap-1 mb-1">
                <span className="text-xs w-6">P{i + 1}</span>
                <NumberInput step="0.00001" className="input flex-1" value={coord[0].toFixed(5)}
                  onCommit={(v) => {
                    const c = [...coords]; c[i] = [v || 0, coord[1]];
                    patch(pathField === 'coordinates' ? { coordinates: c } : { [pathField]: c } as Partial<MapElement>);
                  }} />
                <NumberInput step="0.00001" className="input flex-1" value={coord[1].toFixed(5)}
                  onCommit={(v) => {
                    const c = [...coords]; c[i] = [coord[0], v || 0];
                    patch(pathField === 'coordinates' ? { coordinates: c } : { [pathField]: c } as Partial<MapElement>);
                  }} />
                {showTimes && (
                  <NumberInput min="0" step={Math.max(0.01, 1 / fps)} className="input w-16 shrink-0" title={t('到达时间 (秒)', 'Arrival (s)')}
                      value={round2(frameToSeconds(ptTime, fps))}
                      onCommit={(v) => {
                        // 保留已设置的其他点到达时间，仅更新当前行（面板以秒显示，内部存帧）
                        const arr = ensurePointTimes(coords, le.pointTimes, le.moveStartFrame ?? element.startFrame, le.moveEndFrame ?? element.endFrame);
                        arr[i] = secondsToFrame(v || 0, fps);
                        patch({ pointTimes: arr } as Partial<MapElement>);
                      }} />
                )}
                <button onClick={() => {
                  if (coords.length <= 2) return;
                  const c = coords.filter((_, x) => x !== i);
                  const base = pathField === 'coordinates' ? { coordinates: c } : { [pathField]: c };
                  // 非匀速：删点后到达时间数组要跟着重排（否则点数与时间数组错位）
                  const extra = le.uniformMove === false
                    ? { pointTimes: distributePointTimes(c, le.moveStartFrame ?? element.startFrame, le.moveEndFrame ?? element.endFrame) }
                    : {};
                  patch({ ...base, ...extra } as Partial<MapElement>);
                }} className="text-xs text-red-500 disabled:opacity-30" disabled={coords.length <= 2}>×</button>
              </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* 显示标记（含与标记一致的样式设置；上传图标与标记共用 customSymbols） */}
      <div className="border-t border-white/[0.06] pt-3 mt-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold tracking-wide">{t('显示标记', 'Show Marker')}</h3>
          <Toggle
            checked={!!(element as LineElement).showIcon}
            onChange={(v) => patch({ showIcon: v, ...(v && !(element as LineElement).animEffect ? { animEffect: 'move' as const } : {}) } as Partial<MapElement>)}
          />
        </div>
        {!!(element as LineElement).showIcon && (
          <div className="space-y-3">
            {/* 图标样式（等宽网格，参照标记设置） */}
            <Field label={t('图标样式', 'Icon Style')}>
              <div className="grid grid-cols-4 gap-1.5">
                {([
                  { value: 'bubble', label: '💬 BUBBLE' },
                  { value: 'flag', label: t('🚩 旗帜', '🚩 MARKER') },
                  { value: 'text', label: 'Aa TEXT' },
                  { value: 'emoji', label: '😀 EMOJI' },
                ] as { value: 'bubble' | 'flag' | 'text' | 'emoji'; label: string }[]).map((o) => (
                  <button
                    key={o.value}
                    onClick={() => patch({ moveIcon: { ...(element as LineElement).moveIcon, shape: o.value } } as Partial<MapElement>)}
                    className={`flex items-center justify-center gap-1 px-1 py-1.5 text-[11px] font-medium rounded-md border truncate transition-colors ${((element as LineElement).moveIcon?.shape || 'dot') === o.value ? 'bg-brand/20 border-brand text-foreground font-semibold' : 'bg-white/[0.03] border-white/10 text-foreground/80 hover:bg-accent hover:border-white/20'}`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              {/* 资源形态（与标记设置一致：图片 / 动图 / 模型 / 图标库） */}
              <div className="grid grid-cols-4 gap-1.5 mt-1.5">
                {([
                  { value: 'image', label: t('🖼 图片', '🖼 IMAGE') },
                  { value: 'gif', label: t('🎞 动图', '🎞 GIF') },
                  { value: 'model', label: t('🧊 模型', '🧊 MODEL') },
                  { value: 'icon', label: t('🔷 图标', '🔷 ICON') },
                ] as { value: NonNullable<LineElement['moveIcon']>['shape']; label: string }[]).map((o) => (
                  <button
                    key={o.value}
                    onClick={() => patch({ moveIcon: { ...(element as LineElement).moveIcon, shape: o.value } } as Partial<MapElement>)}
                    className={`flex items-center justify-center gap-1 px-1 py-1.5 text-[11px] font-medium rounded-md border truncate transition-colors ${((element as LineElement).moveIcon?.shape || 'dot') === o.value ? 'bg-brand/20 border-brand text-foreground font-semibold' : 'bg-white/[0.03] border-white/10 text-foreground/80 hover:bg-accent hover:border-white/20'}`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </Field>

            {['image', 'gif', 'model', 'icon'].includes((element as LineElement).moveIcon?.shape || '') && (
              <MoveResourcePicker
                mi={(element as LineElement).moveIcon || { shape: 'image' }}
                patch={patch}
              />
            )}

            {((element as LineElement).moveIcon?.shape || 'dot') !== 'emoji' && (
              <Field label={t('图标颜色', 'Icon Color')}>
                <ColorPicker value={(element as LineElement).moveIcon?.color || '#FF6600'} onChange={(c) => patch({ moveIcon: { ...(element as LineElement).moveIcon, color: c } } as Partial<MapElement>)} />
              </Field>
            )}

            {(element as LineElement).moveIcon?.shape === 'emoji' && (
              <Field label={t('表情', 'Emoji')}>
                <div className="grid grid-cols-8 gap-1 mb-2">
                  {EMOJI_CHOICES.map((e2) => (
                    <button
                      key={e2}
                      onClick={() => patch({ moveIcon: { ...(element as LineElement).moveIcon, emoji: e2 } } as Partial<MapElement>)}
                      className={`h-8 text-lg border rounded ${(element as LineElement).moveIcon?.emoji === e2 ? 'border-primary bg-accent' : 'hover:bg-accent'}`}
                    >
                      {e2}
                    </button>
                  ))}
                </div>
                <input type="text" maxLength={4} className="input" value={(element as LineElement).moveIcon?.emoji || '📍'}
                  onChange={(e) => patch({ moveIcon: { ...(element as LineElement).moveIcon, emoji: e.target.value } } as Partial<MapElement>)} />
              </Field>
            )}

            {(element as LineElement).moveIcon?.shape === 'flag' && (
              <>
                <Field label={t('旗上文字', 'Flag Text')}>
                  <input type="text" className="input" value={(element as LineElement).moveIcon?.flagText ?? '旗'}
                    onChange={(e) => patch({ moveIcon: { ...(element as LineElement).moveIcon, flagText: e.target.value } } as Partial<MapElement>)} />
                </Field>
                <Field label={t('旗帜颜色', 'Flag Color')}>
                  <ColorPicker value={(element as LineElement).moveIcon?.flagColor || '#E23B3B'} onChange={(c) => patch({ moveIcon: { ...(element as LineElement).moveIcon, flagColor: c } } as Partial<MapElement>)} />
                </Field>
              </>
            )}

            <Field label={t('大小', 'Size')}>
              <div className="flex items-center gap-2">
                <input type="range" min="0.3" max="3" step="0.05" value={(element as LineElement).moveIcon?.scale ?? 1}
                  onChange={(e) => patch({ moveIcon: { ...(element as LineElement).moveIcon, scale: parseFloat(e.target.value) || 1 } } as Partial<MapElement>)}
                  className="w-full" />
                <span className="text-xs w-12 text-right shrink-0">{Math.round(((element as LineElement).moveIcon?.scale ?? 1) * 100)}%</span>
              </div>
            </Field>

            {/* 显示标签（仅 PIN/DOT/EMOJI 支持；参照标记 Label：位置、文字颜色、背景开关+背景色） */}
            {(() => {
              const mkShape = (element as LineElement).moveIcon?.shape || 'dot';
              const canLabel = mkShape === 'dot' || mkShape === 'pin' || mkShape === 'emoji';
              if (!canLabel) return null;
              return (
                <>
            <div className="border-t border-white/[0.08] pt-2">
              <Toggle
                checked={!!(element as LineElement).moveIcon?.showLabel}
                label={t('显示标签', 'Show Label')}
                onChange={(v) => patch({ moveIcon: { ...(element as LineElement).moveIcon, showLabel: v } } as Partial<MapElement>)}
              />
            </div>
            {!!(element as LineElement).moveIcon?.showLabel && (
              <>
                <Field label={t('标记标签', 'Marker Label')}>
                  <input type="text" className="input" value={(element as LineElement).moveIcon?.labelText ?? ''}
                    onChange={(e) => patch({ moveIcon: { ...(element as LineElement).moveIcon, labelText: e.target.value } } as Partial<MapElement>)} />
                </Field>
                <Field label={t('标记文字颜色', 'Marker Text Color')}>
                  <ColorPicker value={(element as LineElement).moveIcon?.labelColor || '#000000'} onChange={(c) => patch({ moveIcon: { ...(element as LineElement).moveIcon, labelColor: c } } as Partial<MapElement>)} />
                </Field>
                <Field label={t('标记位置', 'Marker Position')}>
                  <OptionBlocks<'top' | 'bottom' | 'left' | 'right'>
                    value={((element as LineElement).moveIcon?.labelPos || 'top') as 'top' | 'bottom' | 'left' | 'right'}
                    onChange={(v) => patch({ moveIcon: { ...(element as LineElement).moveIcon, labelPos: v } } as Partial<MapElement>)}
                    options={[
                      { value: 'top', label: t('上', 'Top') },
                      { value: 'bottom', label: t('下', 'Bottom') },
                      { value: 'left', label: t('左', 'Left') },
                      { value: 'right', label: t('右', 'Right') },
                    ]}
                  />
                </Field>
                <Field label={t('标记背景', 'Marker Background')}>
                  <div className="space-y-2">
                    <Toggle
                      checked={((element as LineElement).moveIcon?.labelBg || '#FFFFFF') !== 'transparent' && ((element as LineElement).moveIcon?.labelBg || '#FFFFFF') !== 'rgba(0,0,0,0)'}
                      label={t('显示背景', 'Show Background')}
                      onChange={(v) => patch({ moveIcon: { ...(element as LineElement).moveIcon, labelBg: v ? '#FFFFFF' : 'transparent' } } as Partial<MapElement>)}
                    />
                    {((element as LineElement).moveIcon?.labelBg || '#FFFFFF') !== 'transparent' && ((element as LineElement).moveIcon?.labelBg || '#FFFFFF') !== 'rgba(0,0,0,0)' && (
                      <ColorPicker value={(element as LineElement).moveIcon?.labelBg || '#FFFFFF'} onChange={(c) => patch({ moveIcon: { ...(element as LineElement).moveIcon, labelBg: c } } as Partial<MapElement>)} />
                    )}
                  </div>
                </Field>
              </>
            )}
                </>
              );
            })()}
          </div>
        )}
      </div>

    </>
  );
}

// ========== SHAPE ==========

function rectRing(c1: [number, number], c2: [number, number]): [number, number][] {
  return [[c1[0], c1[1]], [c2[0], c1[1]], [c2[0], c2[1]], [c1[0], c2[1]], [c1[0], c1[1]]];
}
function bboxOf(ring: [number, number][] | null): { c1: [number, number]; c2: [number, number] } {
  const pts = (ring && ring.length > 2 ? ring.slice(0, -1) : [[104, 35], [105, 36]]) as [number, number][];
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y] of pts) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
  return { c1: [x1, y1], c2: [x2, y2] };
}
function starRingR(c: [number, number], rKm: number, deg = 0): [number, number][] {
  const outer = rKm / 111;
  const inner = outer * 0.4;
  const rot = ((deg || 0) * Math.PI) / 180;
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2 + rot;
    pts.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  pts.push([pts[0][0], pts[0][1]]);
  return pts;
}
function rotateRingR(ring: [number, number][], center: [number, number], deg: number): [number, number][] {
  if (!deg) return ring;
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r), sin = Math.sin(r);
  return ring.map((p) => {
    const dx = p[0] - center[0];
    const dy = p[1] - center[1];
    return [center[0] + dx * cos - dy * sin, center[1] + dx * sin + dy * cos];
  });
}
function rectCenter(c1: [number, number], c2: [number, number]): [number, number] {
  return [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2];
}

/** 旋转角滑杆（0–360°） */
function RotationField({ value, onChange }: { value: number; onChange: (deg: number) => void }) {
  const t = useT();
  return (
    <Field label={t('旋转', 'Rotation')}>
      <div className="flex items-center gap-2">
        <input
          type="range" min="0" max="360" step="1" value={Math.round(value) % 360}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-full"
        />
        <span className="text-xs w-10 text-right shrink-0">{Math.round(value) % 360}°</span>
      </div>
    </Field>
  );
}

// ========== 形状面板：多点绘制 ==========

type MultiPointStyle = 'line' | 'bezier' | 'line-arrow' | 'bezier-arrow' | 'swallowtail' | 'march' | 'poly' | 'poly-curve' | 'poly-defend' | 'poly-curve-defend' | 'front-line' | 'front-curve';

/** 从任意元素提取点串（去闭合点） */
function shapeCoords(el: MapElement): [number, number][] {
  const t = el.type;
  if (t === 'line') return (el.coordinates || []).slice();
  if (t === 'arrow') {
    const ar = el as ArrowElement;
    if (ar.path && ar.path.length >= 2) return ar.path;
    return ar.from && ar.to ? [ar.from, ar.to] : [];
  }
  if (t === 'moving_point') return (el.path || []).slice();
  if (t === 'polygon') {
    const ring = (el as PolygonElement).coordinates[0] || [];
    if (ring.length > 2 && Math.abs(ring[0][0] - ring[ring.length - 1][0]) < 1e-9) return ring.slice(0, -1);
    return ring;
  }
  if (t === 'encirclement' || t === 'gathering') {
    const c = (el as any).center as [number, number];
    const r = (el as any).radius || 30;
    return [c, [c[0] + r / 111, c[1]]];
  }
  return [];
}

function MultiShapeSettings({ element, patch }: { element: MapElement; patch: (c: Partial<MapElement>) => void }) {
  const t = useT();
  const poly = element.type === 'polygon' ? element as PolygonElement : null;
  const coords = shapeCoords(element);
  const colorOf = element.type === 'line'
    ? element.lineColor
    : element.type === 'polygon'
      ? element.fillColor
      : ((element as ArrowElement).color || '#E23B3B');
  const widthOf = element.type === 'line' ? element.lineWidth : element.type === 'arrow' ? (element as ArrowElement).width : 3;

  const current: MultiPointStyle =
    element.type === 'line'
      ? ((element as LineElement).frontStyle === undefined
        ? ((element as LineElement).lineArrow
          ? ((element as LineElement).lineType === 'bezier' ? 'bezier-arrow' : 'line-arrow')
          : ((element as LineElement).lineType === 'bezier' ? 'bezier' : 'line'))
        : ((element as LineElement).lineType === 'bezier' ? 'front-curve' : 'front-line'))
      : element.type === 'arrow'
        ? ((element as ArrowElement).arrowType === 'curved-simple' ? 'march'
          : ((element as ArrowElement).arrowType === 'curved' ? 'swallowtail' : 'line'))
        : element.type === 'polygon'
          ? ((element as PolygonElement).defenseStyle
            ? ((element as PolygonElement).polyCurve ? 'poly-curve-defend' : 'poly-defend')
            : ((element as PolygonElement).polyCurve ? 'poly-curve' : 'poly'))
          : 'line';

  const setStyle = (s: MultiPointStyle) => {
    const start = element.startFrame;
    const pts = coords.length >= 2 ? coords : [[104, 35], [105, 36]];
    if (s === 'front-line' || s === 'front-curve') {
      patch({
        type: 'line', coordinates: pts, lineType: s === 'front-curve' ? 'bezier' : 'straight', lineArrow: false,
        drawProgress: [{ frame: start, value: 1 }], lineWidth: 8, lineColor: colorOf,
        frontStyle: { toothLength: 14, toothGap: 24, toothAngle: 0, side: 1 },
        shapeCategory: 'multi',
      } as Partial<MapElement>);
      return;
    }
    // 其他类型：清除战线梳齿
    if (element.type === 'line' && (element as LineElement).frontStyle) {
      patch({ frontStyle: undefined } as Partial<MapElement>);
    }
    if (s === 'line' || s === 'bezier') {
      patch({
        type: 'line', coordinates: pts, lineType: s, lineArrow: false,
        drawProgress: [{ frame: start, value: 1 }], lineWidth: 8, lineColor: colorOf,
        shapeCategory: 'multi',
      } as Partial<MapElement>);
    } else if (s === 'line-arrow' || s === 'bezier-arrow') {
      patch({
        type: 'line', coordinates: pts, lineType: s === 'bezier-arrow' ? 'bezier' : 'straight', lineArrow: true,
        drawProgress: [{ frame: start, value: 1 }], lineWidth: 8, lineColor: colorOf,
        shapeCategory: 'multi',
      } as Partial<MapElement>);
    } else if (s === 'swallowtail') {
      patch({
        type: 'arrow', from: pts[0] as [number, number], to: pts[pts.length - 1] as [number, number], path: pts.map(p => [p[0], p[1]]),
        arrowType: 'curved', width: 15, color: colorOf,
        progress: [{ frame: start, value: 1 }], drawZoom: undefined,
        shapeCategory: 'multi',
      } as Partial<MapElement>);
    } else if (s === 'march') {
      patch({
        type: 'arrow', from: pts[0] as [number, number], to: pts[pts.length - 1] as [number, number], path: pts.map(p => [p[0], p[1]]),
        arrowType: 'curved-simple', width: 15, color: colorOf,
        progress: [{ frame: start, value: 1 }], drawZoom: undefined,
        shapeCategory: 'multi',
      } as Partial<MapElement>);
    } else {
      // poly / poly-curve / poly-defend / poly-curve-defend（多边形类，均为闭合环 + 可选曲线边/锯齿）
      const ring = pts.length >= 3 ? [...pts.map((p) => [p[0], p[1]] as [number, number]), pts[0]] : pts;
      const isCurve = s === 'poly-curve' || s === 'poly-curve-defend';
      const isDefend = s === 'poly-defend' || s === 'poly-curve-defend';
      patch({
        type: 'polygon', coordinates: [ring], shapeKind: 'poly',
        polyCurve: isCurve || undefined,
        defenseStyle: isDefend ? { toothLength: 14, toothGap: 24, toothAngle: 0, side: 1 } : undefined,
        fillColor: colorOf, fillOpacity: 0.25, strokeColor: colorOf, strokeWidth: isDefend ? 8 : 2,
        circleMeta: undefined, rectMeta: undefined, starMeta: undefined,
        shapeCategory: 'multi',
      } as Partial<MapElement>);
    }
  };

  const ring = poly?.coordinates[0] || null;

  return (
    <>
      <Section title={t('绘制类型', 'Draw Type')}>
        <StyleGrid<MultiPointStyle>
          value={current}
          options={[
            { value: 'line', label: '─ 直线' },
            { value: 'bezier', label: '〰 曲线' },
            { value: 'line-arrow', label: t('──▶ 带箭头直线', '──▶ Arrow Line') },
            { value: 'bezier-arrow', label: t('➤ 带箭头曲线', '➤ Arrow Curve') },
            { value: 'front-line', label: t('▮─ 直线战线', '▮─ Front Line') },
            { value: 'front-curve', label: t('ㅤ〰 弯曲战线', 'ㅤ〰 Curved Front') },
            { value: 'swallowtail', label: t('🏹 燕尾箭头', '🏹 Swallowtail') },
            { value: 'march', label: t('⚔️ 行军箭头', '⚔️ March Arrow') },
            { value: 'poly', label: '⬛ 多边形' },
            { value: 'poly-curve', label: '🌀 曲线多边' },
            { value: 'poly-defend', label: t('▮⬛ 直线防御圈', '▮⬛ Straight Defense') },
            { value: 'poly-curve-defend', label: t('🌀⬛ 曲线防御圈', '🌀⬛ Curved Defense') },
          ]}
          onChange={setStyle}
        />
      </Section>

      {element.type !== 'polygon' && (
        <>
          <Field label={t('大小', 'Size')}>
            <SizeSlider base={element.type === 'arrow' ? 15 : 8} value={widthOf} onChange={(v) => {
              if (element.type === 'line') patch({ lineWidth: v });
              else if (element.type === 'arrow') patch({ width: v } as Partial<MapElement>);
            }} />
          </Field>
          <Field label={t('颜色', 'Color')}>
            <ColorPicker value={colorOf} onChange={(c) => {
              if (element.type === 'line') patch({ lineColor: c });
              else patch({ color: c } as Partial<MapElement>);
            }} />
          </Field>
          {element.type === 'arrow' && (
            <Field label={t('填充透明度', 'Fill Opacity')}>
              <RangeInput value={(element as ArrowElement).fillOpacity ?? 0.92} min={0.1} max={1} step={0.05}
                onChange={(v) => patch({ fillOpacity: v } as Partial<MapElement>)} />
            </Field>
          )}
        </>
      )}

      {element.type === 'line' && (element as LineElement).frontStyle && (
        <Section title={t('战线参数', 'Front Style')}>
          <Field label={t('齿长', 'Tooth Length')}>
            <RangeInput value={(element as LineElement).frontStyle!.toothLength ?? 14} min={4} max={60} step={1} suffix="px"
              onChange={(v) => patch({ frontStyle: { ...(element as LineElement).frontStyle!, toothLength: v } } as Partial<MapElement>)} />
          </Field>
          <Field label={t('齿距', 'Tooth Gap')}>
            <RangeInput value={(element as LineElement).frontStyle!.toothGap ?? 24} min={8} max={120} step={1} suffix="px"
              onChange={(v) => patch({ frontStyle: { ...(element as LineElement).frontStyle!, toothGap: v } } as Partial<MapElement>)} />
          </Field>
          <Field label={t('偏角', 'Tooth Angle')}>
            <RangeInput value={(element as LineElement).frontStyle!.toothAngle ?? 0} min={-60} max={60} step={1} suffix="°"
              onChange={(v) => patch({ frontStyle: { ...(element as LineElement).frontStyle!, toothAngle: v } } as Partial<MapElement>)} />
          </Field>
          <Field label={t('梳齿朝向', 'Tooth Side')}>
            <OptionBlocks<'1' | '-1'>
              value={String((element as LineElement).frontStyle!.side ?? 1) as '1' | '-1'}
              onChange={(v) => patch({ frontStyle: { ...(element as LineElement).frontStyle!, side: v === '1' ? 1 : -1 } } as Partial<MapElement>)}
              options={[
                { value: '1', label: t('→ 右', '→ Right') },
                { value: '-1', label: t('← 左', '← Left') },
              ]}
            />
          </Field>
        </Section>
      )}

      {element.type === 'polygon' && (
        <Section title="FILL / STROKE">
          <Field label={t('颜色', 'Color')}>
            <ColorPicker value={element.fillColor} onChange={(c) => patch({ fillColor: c, strokeColor: c })} />
          </Field>
          <Field label={t('填充透明度', 'Fill Opacity')}>
            <RangeInput value={element.fillOpacity} min={0} max={1} step={0.05} onChange={(v) => patch({ fillOpacity: v })} />
          </Field>
          {element.defenseStyle ? (
            <Field label={t('大小', 'Size')}>
              <SizeSlider base={8} value={element.strokeWidth} onChange={(v) => patch({ strokeWidth: Math.max(1, v) })} />
            </Field>
          ) : (
            <Field label={t('边框宽度', 'Stroke Width')}>
              <RangeInput value={element.strokeWidth} min={1} max={10} step={1} suffix="px" onChange={(v) => patch({ strokeWidth: Math.max(1, v) })} />
            </Field>
          )}
        </Section>
      )}

      {element.type === 'polygon' && (element as PolygonElement).defenseStyle && (
        <Section title={t('防御圈参数', 'Defense Style')}>
          <Field label={t('齿长', 'Tooth Length')}>
            <RangeInput value={(element as PolygonElement).defenseStyle!.toothLength ?? 14} min={4} max={60} step={1} suffix="px"
              onChange={(v) => patch({ defenseStyle: { ...(element as PolygonElement).defenseStyle!, toothLength: v } } as Partial<MapElement>)} />
          </Field>
          <Field label={t('齿距', 'Tooth Gap')}>
            <RangeInput value={(element as PolygonElement).defenseStyle!.toothGap ?? 24} min={8} max={120} step={1} suffix="px"
              onChange={(v) => patch({ defenseStyle: { ...(element as PolygonElement).defenseStyle!, toothGap: v } } as Partial<MapElement>)} />
          </Field>
          <Field label={t('偏角', 'Tooth Angle')}>
            <RangeInput value={(element as PolygonElement).defenseStyle!.toothAngle ?? 0} min={-60} max={60} step={1} suffix="°"
              onChange={(v) => patch({ defenseStyle: { ...(element as PolygonElement).defenseStyle!, toothAngle: v } } as Partial<MapElement>)} />
          </Field>
          <Field label={t('齿朝向', 'Tooth Side')}>
            <OptionBlocks<'1' | '-1'>
              value={String((element as PolygonElement).defenseStyle!.side ?? 1) as '1' | '-1'}
              onChange={(v) => patch({ defenseStyle: { ...(element as PolygonElement).defenseStyle!, side: v === '1' ? 1 : -1 } } as Partial<MapElement>)}
              options={[
                { value: '1', label: t('→ 外', '→ Out') },
                { value: '-1', label: t('← 内', '← In') },
              ]}
            />
          </Field>
        </Section>
      )}

      {element.type !== 'polygon' && (
        <Section title={t('路径点', 'Path Points')}>
          <div className="max-h-44 overflow-y-auto">
            {coords.map((coord, i) => (
              <div key={i} className="flex items-center gap-1 mb-1">
                <span className="text-xs w-6">P{i + 1}</span>
                <NumberInput step="0.00001" className="input flex-1" value={coord[0].toFixed(5)}
                  onCommit={(v) => {
                    const c = coords.map((p) => [p[0], p[1]] as [number, number]);
                    c[i] = [v || 0, coord[1]];
                    const field = element.type === 'arrow' ? 'path' : 'coordinates';
                    patch({ [field]: c } as Partial<MapElement>);
                  }} />
                <NumberInput step="0.00001" className="input flex-1" value={coord[1].toFixed(5)}
                  onCommit={(v) => {
                    const c = coords.map((p) => [p[0], p[1]] as [number, number]);
                    c[i] = [coord[0], v || 0];
                    const field = element.type === 'arrow' ? 'path' : 'coordinates';
                    patch({ [field]: c } as Partial<MapElement>);
                  }} />
              </div>
            ))}
          </div>
        </Section>
      )}

      {poly && (
        <Section title="VERTICES（顶点）">
          <div className="max-h-40 overflow-y-auto">
            {(ring || []).slice(0, -1).map((coord, i) => (
              <div key={i} className="flex items-center gap-1 mb-1">
                <span className="text-xs w-6">P{i + 1}</span>
                <NumberInput step="0.00001" className="input flex-1" value={coord[0].toFixed(5)}
                  onCommit={(v) => {
                    const r = [...(ring || [])]; r[i] = [v || 0, coord[1]];
                    if (i === 0) r[r.length - 1] = r[0];
                    patch({ coordinates: [r] });
                  }} />
                <NumberInput step="0.00001" className="input flex-1" value={coord[1].toFixed(5)}
                  onCommit={(v) => {
                    const r = [...(ring || [])]; r[i] = [coord[0], v || 0];
                    if (i === 0) r[r.length - 1] = r[0];
                    patch({ coordinates: [r] });
                  }} />
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

// ========== 形状面板：两点绘制 ==========

type TwoPointStyle = 'circle' | 'rect' | 'gathering';

function TwoShapeSettings({ element, patch }: { element: MapElement; patch: (c: Partial<MapElement>) => void }) {
  const t = useT();
  const poly = element.type === 'polygon' ? element as PolygonElement : null;
  const gather = element.type === 'gathering' ? element as GatheringElement : null;

  const ring = poly?.coordinates[0] || null;
  const centroid = (): [number, number] => {
    const pts = ring || [];
    if (!pts.length) return [104, 35];
    const n = pts.length - 1;
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { sx += pts[i][0]; sy += pts[i][1]; }
    return [sx / n, sy / n];
  };
  const radiusKm = (): number => {
    if (gather) return gather.radius || 30;
    const c = centroid(); const pts = ring || [];
    if (!pts.length) return 50;
    let s = 0; const n = Math.max(1, pts.length - 1);
    for (let i = 0; i < n; i++) s += Math.hypot(pts[i][0] - c[0], pts[i][1] - c[1]) * 111;
    return Math.max(1, s / n);
  };
  const circleRing = (c: [number, number], rKm: number): [number, number][] => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      pts.push([c[0] + (rKm / 111) * Math.cos(a), c[1] + (rKm / 111) * Math.sin(a)]);
    }
    return pts;
  };

  const current: TwoPointStyle =
    poly?.shapeKind === 'rect' ? 'rect'
    : poly?.shapeKind === 'circle' ? 'circle'
    : 'gathering';

  const fill = poly ? poly.fillColor : gather ? gather.color : '#E23B3B';

  const setStyle = (s: TwoPointStyle) => {
    if (s === 'circle') {
      const c = gather ? gather.center : centroid();
      const r = radiusKm();
      patch({
        type: 'polygon', coordinates: [circleRing(c, r)], shapeKind: 'circle',
        circleMeta: { center: c, radius: r }, rectMeta: undefined, starMeta: undefined, rotation: 0,
        fillColor: fill, fillOpacity: 0.25, strokeColor: fill, strokeWidth: 2,
        shapeCategory: 'two',
      } as Partial<MapElement>);
    } else if (s === 'rect') {
      const bb = bboxOf(ring);
      patch({
        type: 'polygon', coordinates: [rectRing(bb.c1, bb.c2)], shapeKind: 'rect',
        circleMeta: undefined, rectMeta: bb, starMeta: undefined, rotation: (element as any).rotation ?? 0,
        fillColor: fill, fillOpacity: 0.25, strokeColor: fill, strokeWidth: 2,
        shapeCategory: 'two',
      } as Partial<MapElement>);
    } else {
      patch({
        type: 'gathering', center: gather ? gather.center : centroid(), radius: radiusKm(), color: fill,
        pulseAnimation: gather ? !!gather.pulseAnimation : true,
        shapeCategory: 'two',
      } as Partial<MapElement>);
    }
  };

  return (
    <>
      <Section title={t('绘制类型', 'Draw Type')}>
        <StyleGrid<TwoPointStyle>
          value={current}
          options={[
            { value: 'circle', label: '◯ 圆' },
            { value: 'rect', label: t('▭ 矩形', '▭ Rectangle') },
            { value: 'gathering', label: t('⚙ 集结点', '⚙ Gathering') },
          ]}
          onChange={setStyle}
        />
      </Section>

      {poly?.shapeKind === 'circle' && poly.circleMeta && (
        <Section title={t('圆参数', 'Circle')}>
          <div className="grid grid-cols-2 gap-2">
            <Field label="中心经度">
              <NumberInput step="0.00001" className="input" value={Number(poly.circleMeta.center[0]).toFixed(5)}
                onCommit={(v) => {
                  const c: [number, number] = [v || 0, poly.circleMeta!.center[1]];
                  patch({ circleMeta: { ...poly.circleMeta!, center: c }, coordinates: [circleRing(c, poly.circleMeta!.radius)] });
                }} />
            </Field>
            <Field label="中心纬度">
              <NumberInput step="0.00001" className="input" value={Number(poly.circleMeta.center[1]).toFixed(5)}
                onCommit={(v) => {
                  const c: [number, number] = [poly.circleMeta!.center[0], v || 0];
                  patch({ circleMeta: { ...poly.circleMeta!, center: c }, coordinates: [circleRing(c, poly.circleMeta!.radius)] });
                }} />
            </Field>
          </div>
          <Field label="半径 (km)">
            <input type="number" min="0.1" className="input" value={poly.circleMeta.radius}
              onChange={(e) => {
                const r = Math.max(0.1, parseFloat(e.target.value) || 1);
                patch({ circleMeta: { ...poly.circleMeta!, radius: r }, coordinates: [circleRing(poly.circleMeta!.center, r)] });
              }} />
          </Field>
          <p className="text-[10px] text-muted-foreground mt-1">圆对称不可旋转</p>
        </Section>
      )}

      {poly?.shapeKind === 'rect' && poly.rectMeta && (
        <Section title={t('矩形对角点', 'Rectangle Corners')}>
          <div className="grid grid-cols-2 gap-2">
            <Field label="角1 经度">
              <NumberInput step="0.00001" className="input" value={Number(poly.rectMeta.c1[0]).toFixed(5)}
                onCommit={(v) => {
                  const c1: [number, number] = [v || 0, poly.rectMeta!.c1[1]];
                  patch({
                    rectMeta: { ...poly.rectMeta!, c1 },
                    coordinates: [rotateRingR(rectRing(c1, poly.rectMeta!.c2), rectCenter(c1, poly.rectMeta!.c2), poly.rotation || 0)],
                  });
                }} />
            </Field>
            <Field label="角1 纬度">
              <NumberInput step="0.00001" className="input" value={Number(poly.rectMeta.c1[1]).toFixed(5)}
                onCommit={(v) => {
                  const c1: [number, number] = [poly.rectMeta!.c1[0], v || 0];
                  patch({
                    rectMeta: { ...poly.rectMeta!, c1 },
                    coordinates: [rotateRingR(rectRing(c1, poly.rectMeta!.c2), rectCenter(c1, poly.rectMeta!.c2), poly.rotation || 0)],
                  });
                }} />
            </Field>
            <Field label="角2 经度">
              <NumberInput step="0.00001" className="input" value={Number(poly.rectMeta.c2[0]).toFixed(5)}
                onCommit={(v) => {
                  const c2: [number, number] = [v || 0, poly.rectMeta!.c2[1]];
                  patch({
                    rectMeta: { ...poly.rectMeta!, c2 },
                    coordinates: [rotateRingR(rectRing(poly.rectMeta!.c1, c2), rectCenter(poly.rectMeta!.c1, c2), poly.rotation || 0)],
                  });
                }} />
            </Field>
            <Field label="角2 纬度">
              <NumberInput step="0.00001" className="input" value={Number(poly.rectMeta.c2[1]).toFixed(5)}
                onCommit={(v) => {
                  const c2: [number, number] = [poly.rectMeta!.c2[0], v || 0];
                  patch({
                    rectMeta: { ...poly.rectMeta!, c2 },
                    coordinates: [rotateRingR(rectRing(poly.rectMeta!.c1, c2), rectCenter(poly.rectMeta!.c1, c2), poly.rotation || 0)],
                  });
                }} />
            </Field>
          </div>
          <RotationField value={poly.rotation ?? 0} onChange={(deg) => {
            const rm = poly.rectMeta!;
            patch({
              rotation: deg,
              coordinates: [rotateRingR(rectRing(rm.c1, rm.c2), rectCenter(rm.c1, rm.c2), deg)],
            });
          }} />
        </Section>
      )}

      {gather && (
        <Section title="集结点参数">
          <div className="grid grid-cols-2 gap-2">
            <Field label="中心经度">
              <NumberInput step="0.00001" className="input" value={Number(gather.center[0]).toFixed(5)}
                onCommit={(v) => patch({ center: [v || 0, gather.center[1]] })} />
            </Field>
            <Field label="中心纬度">
              <NumberInput step="0.00001" className="input" value={Number(gather.center[1]).toFixed(5)}
                onCommit={(v) => patch({ center: [gather.center[0], v || 0] })} />
            </Field>
          </div>
          <Field label="半径 (km)">
            <input type="number" min="1" max="500" className="input" value={gather.radius}
              onChange={(e) => patch({ radius: parseFloat(e.target.value) || 30 })} />
          </Field>
          <RotationField value={gather.rotation ?? 0} onChange={(deg) => patch({ rotation: deg })} />
          <Toggle checked={!!gather.pulseAnimation} label="脉冲动画" onChange={(v) => patch({ pulseAnimation: v })} />
          <Appearance color={gather.color} onChange={(c) => patch({ color: c })} />
        </Section>
      )}
    </>
  );
}

// ========== 形状面板：特殊图形 ==========

function SpecialShapeSettings({ element, patch }: { element: MapElement; patch: (c: Partial<MapElement>) => void }) {
  const t = useT();
  const poly = element.type === 'polygon' ? element as PolygonElement : null;

  // 各自独立的参数弹窗（不互转类型）
  if (element.type === 'double_arrow') {
    const ar = element as DoubleArrowElement;
    return (
      <>
        <Section title={t('钳形', 'Pincer')}>
          <Field label={t('颜色', 'Color')}>
            <ColorPicker value={ar.color || '#E23B3B'} onChange={(c) => patch({ color: c })} />
          </Field>
          <p className="text-[10px] text-muted-foreground mt-1">路径点在地图拖拽编辑</p>
        </Section>
        <Appearance color={ar.color || '#E23B3B'} onChange={(c) => patch({ color: c })} />
      </>
    );
  }

  if (element.type === 'arrow') {
    const ar = element as ArrowElement;
    const isSwallowtail = ar.arrowType === 'curved' || element.name.includes('燕尾');
    return (
      <>
        <Section title={isSwallowtail ? t('自定义燕尾箭头', 'Custom Swallowtail') : t('自定义箭头', 'Custom Arrow')}>
          <Field label={t('大小', 'Size')}>
            <SizeSlider base={15} minPct={25} maxPct={400} value={ar.width ?? 15} onChange={(v) => patch({ width: v } as Partial<MapElement>)} />
          </Field>
          <Field label={t('颜色', 'Color')}>
            <ColorPicker value={ar.color || '#E23B3B'} onChange={(c) => patch({ color: c })} />
          </Field>
          <p className="text-[10px] text-muted-foreground mt-1">路径点在地图拖拽编辑</p>
        </Section>
        <Appearance color={ar.color || '#E23B3B'} onChange={(c) => patch({ color: c })} />
      </>
    );
  }

  if (element.type === 'encirclement') {
    const el = element as EncirclementElement;
    return (
      <>
        <Section title="包围圈参数">
          <div className="grid grid-cols-2 gap-2">
            <Field label="中心经度">
              <NumberInput step="0.00001" className="input" value={Number(el.center[0]).toFixed(5)}
                onCommit={(v) => patch({ center: [v || 0, el.center[1]] })} />
            </Field>
            <Field label="中心纬度">
              <NumberInput step="0.00001" className="input" value={Number(el.center[1]).toFixed(5)}
                onCommit={(v) => patch({ center: [el.center[0], v || 0] })} />
            </Field>
          </div>
          <Field label="半径 (km)">
            <input type="number" min="1" max="2000" className="input" value={el.radius}
              onChange={(e) => patch({ radius: parseFloat(e.target.value) || 50 })} />
          </Field>
          <Appearance color={el.strokeColor} onChange={(c) => patch({ strokeColor: c, fillColor: c })} />
        </Section>
      </>
    );
  }

  if (poly && poly.shapeKind === 'star' && poly.starMeta) {
    return (
      <>
        <Section title={t('五角星参数', 'Star')}>
          <div className="grid grid-cols-2 gap-2">
            <Field label="中心经度">
              <NumberInput step="0.00001" className="input" value={Number(poly.starMeta.center[0]).toFixed(5)}
                onCommit={(v) => {
                  const c: [number, number] = [v || 0, poly.starMeta!.center[1]];
                  patch({ starMeta: { ...poly.starMeta!, center: c }, coordinates: [starRingR(c, poly.starMeta!.radius, poly.rotation || 0)] });
                }} />
            </Field>
            <Field label="中心纬度">
              <NumberInput step="0.00001" className="input" value={Number(poly.starMeta.center[1]).toFixed(5)}
                onCommit={(v) => {
                  const c: [number, number] = [poly.starMeta!.center[0], v || 0];
                  patch({ starMeta: { ...poly.starMeta!, center: c }, coordinates: [starRingR(c, poly.starMeta!.radius, poly.rotation || 0)] });
                }} />
            </Field>
          </div>
          <Field label="半径 (km)">
            <input type="number" min="0.1" className="input" value={poly.starMeta.radius}
              onChange={(e) => {
                const r = Math.max(0.1, parseFloat(e.target.value) || 1);
                patch({ starMeta: { ...poly.starMeta!, radius: r }, coordinates: [starRingR(poly.starMeta!.center, r, poly.rotation || 0)] });
              }} />
          </Field>
          <RotationField value={poly.rotation ?? 0} onChange={(deg) => {
            patch({ rotation: deg, coordinates: [starRingR(poly.starMeta!.center, poly.starMeta!.radius, deg)] });
          }} />
        </Section>
        <Section title="FILL / STROKE">
          <div className="grid grid-cols-2 gap-2">
            <Field label="填充颜色">
              <ColorPicker value={poly.fillColor} onChange={(c) => patch({ fillColor: c })} />
            </Field>
            <Field label="填充透明度">
              <input type="range" min="0" max="1" step="0.05" value={poly.fillOpacity}
                onChange={(e) => patch({ fillOpacity: parseFloat(e.target.value) })} className="w-full" />
            </Field>
            <Field label="边框颜色">
              <ColorPicker value={poly.strokeColor} onChange={(c) => patch({ strokeColor: c })} />
            </Field>
            <Field label="边框宽度">
              <input type="number" min="1" max="10" className="input" value={poly.strokeWidth}
                onChange={(e) => patch({ strokeWidth: parseInt(e.target.value) || 2 })} />
            </Field>
          </div>
        </Section>
        <Appearance color={poly.fillColor} onChange={(c) => patch({ fillColor: c, strokeColor: c })} />
      </>
    );
  }

  // 兜底：普通显示颜色
  const colorOf = element.type === 'polygon' ? (element as PolygonElement).fillColor : ((element as any).color || '#E23B3B');
  return (
    <>
      <Section title="参数">
        <Appearance color={colorOf} onChange={(c) => patch({ color: c, fillColor: c })} />
      </Section>
    </>
  );
}

// ========== 通用保留区 ==========

// 避免 CameraKeyframe 未使用告警（导出给未来扩展）
export type { CameraKeyframe };

// ========== 疆域设置面板 ==========

type ProjectOf = NonNullable<ReturnType<typeof useProjectStore.getState>['project']>;

/** 势力色点选择条（地块归属/事件占领方共用） */
function CountryDots({ countries, value, onChange }: {
  countries: TerritoryElement['countries'];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {countries.map((c) => (
        <button
          key={c.id}
          title={c.name}
          onClick={() => onChange(c.id)}
          className={`w-4 h-4 rounded-full border-2 transition-transform ${value === c.id ? 'border-white scale-110' : 'border-transparent opacity-70 hover:opacity-100'}`}
          style={{ backgroundColor: c.color }}
        />
      ))}
    </div>
  );
}

/** 势力颜色设置弹窗：用全局 ColorPicker 选色（地图实时预览），支持一键自动配色 */
function CountryColorDialog({ country, onClose, onChange, onAuto }: {
  country: TerritoryElement['countries'][number];
  onClose: () => void;
  onChange: (color: string) => void;
  onAuto: () => void;
}) {
  const t = useT();
  return (
    <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-card border border-white/10 rounded-xl shadow-xl w-[320px] max-w-[92vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-4 pb-2 flex items-center gap-2">
          <span className="w-4 h-4 rounded-full border border-white/25 shrink-0" style={{ backgroundColor: country.color }} />
          <h2 className="text-base font-semibold shrink-0">{t('势力颜色', 'Faction Color')}</h2>
          <span className="text-xs text-muted-foreground truncate">{country.name}</span>
          <button onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground shrink-0" aria-label={t('关闭', 'Close')}>✕</button>
        </div>
        <div className="px-4 pb-3">
          {/* 复用全局统一的 ColorPicker（不再自制色板 + 裸 input[type=color]） */}
          <ColorPicker value={country.color} onChange={onChange} title={t('势力颜色', 'Faction Color')} />
        </div>
        <div className="px-4 py-2.5 border-t border-white/[0.06] flex items-center justify-between">
          <button
            onClick={onAuto}
            className="px-2.5 py-1.5 text-[11px] font-medium rounded-md border bg-white/[0.04] border-white/10 hover:bg-white/10"
          >{t('全部自动配色', 'Auto All')}</button>
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand text-white">
            {t('完成', 'Done')}
          </button>
        </div>
      </div>
    </div>
  );
}

function TerritorySettings({ element, patch, project }: {
  element: TerritoryElement;
  patch: (changes: Partial<MapElement>) => void;
  project: ProjectOf;
}) {
  const t = useT();
  const confirm = useConfirm();
  const fps = project.globalConfig.defaultFPS;
  const currentFrame = useEditorStore((s) => s.currentFrame);
  const terrSelPlots = useEditorStore((s) => s.terrSelPlots);
  const setTerrSelPlots = useEditorStore((s) => s.setTerrSelPlots);
  const terrPlotId = useEditorStore((s) => s.terrPlotId);
  const setTerrPlotId = useEditorStore((s) => s.setTerrPlotId);
  const mode = useInteractionStore((s) => s.mode);
  const [colorEditId, setColorEditId] = useState<string | null>(null);

  const { countries, plots, events, display } = element;
  const patchEl = (p: Partial<TerritoryElement>) => patch(p as Partial<MapElement>);

  const setCountries = (next: TerritoryElement['countries']) => patchEl({ countries: next });
  const setPlots = (next: TerritoryElement['plots']) => patchEl({ plots: next });
  const setEvents = (next: TerritoryElement['events']) => patchEl({ events: next });
  const setDisplay = (d: Partial<TerritoryElement['display']>) => patchEl({ display: { ...display, ...d } });

  const addCountry = () => {
    setCountries([...countries, {
      id: generateId(), name: `势力${countries.length + 1}`,
      color: TERRITORY_PALETTE[countries.length % TERRITORY_PALETTE.length],
    }]);
  };
  const autoColor = () => {
    setCountries(countries.map((c, i) => ({ ...c, color: TERRITORY_PALETTE[i % TERRITORY_PALETTE.length] })));
  };
  const deleteCountry = (c: TerritoryElement['countries'][number]) => {
    const used = plots.some((p) => p.ownerId === c.id) || events.some((ev) => ev.toCountryId === c.id);
    if (used) return; // 被引用的按钮已禁用
    setCountries(countries.filter((x) => x.id !== c.id));
  };

  const deletePlot = (p: TerritoryElement['plots'][number]) => {
    void confirm({
      message: `删除地块「${p.name || '未命名'}」？`,
      danger: true, confirmText: t('删除', 'Delete'),
    }).then((ok) => {
      if (!ok) return;
      setPlots(plots.filter((x) => x.id !== p.id));
      // 同步清理引用该地块的事件
      setEvents(events
        .map((ev) => ({ ...ev, plotIds: ev.plotIds.filter((id) => id !== p.id) }))
        .filter((ev) => ev.plotIds.length > 0));
      if (terrPlotId === p.id) {
        const rest = plots.filter((x) => x.id !== p.id);
        setTerrPlotId(rest[0]?.id ?? null);
      }
      setTerrSelPlots(terrSelPlots.filter((id) => id !== p.id));
    });
  };

  const createEvent = () => {
    if (countries.length === 0 || terrSelPlots.length === 0) return;
    setEvents([...events, {
      id: generateId(),
      frame: currentFrame,
      plotIds: [...terrSelPlots],
      toCountryId: countries[0].id,
      effect: { preset: 'draw', duration: Math.max(1, Math.round(fps)), highlight: true },
    }]);
    setTerrSelPlots([]);
  };

  const plotLabel = (ids: string[]) =>
    ids.map((id) => plots.find((p) => p.id === id)?.name || '?').join('、');

  return (
    <>
      {/* ===== 势力 ===== */}
      <Section title={t('势力', 'Factions')}>
        <div className="space-y-1.5 mb-2 max-h-44 overflow-y-auto">
          {countries.map((c) => {
            const used = plots.some((p) => p.ownerId === c.id) || events.some((ev) => ev.toCountryId === c.id);
            const cnt = plots.filter((p) => p.ownerId === c.id).length;
            return (
              <div key={c.id} className="flex items-center gap-1.5">
                <button
                  title={t('设置颜色', 'Set color')}
                  onClick={() => setColorEditId(c.id)}
                  className="w-5 h-5 rounded-full border border-white/25 shrink-0 transition-transform hover:scale-110"
                  style={{ backgroundColor: c.color }}
                />
                <input
                  className="input h-7 text-xs flex-1 min-w-0"
                  value={c.name}
                  onChange={(e) => setCountries(countries.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)))}
                />
                <span className="text-[10px] text-muted-foreground w-8 text-right shrink-0">{cnt} 地块</span>
                <button
                  disabled={used}
                  title={used ? t('该势力被地块/事件引用，无法删除', 'Referenced by plots/events') : t('删除势力', 'Delete')}
                  onClick={() => deleteCountry(c)}
                  className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-red-400 disabled:opacity-25 disabled:hover:text-muted-foreground shrink-0"
                ><Trash2 size={12} /></button>
              </div>
            );
          })}
          {countries.length === 0 && (
            <p className="text-[11px] text-muted-foreground">{t('还没有势力，可新增或导入', 'No factions yet')}</p>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={addCountry} className="px-2 py-1.5 text-[11px] font-medium rounded-md border bg-white/[0.04] border-white/10 hover:bg-white/10 flex items-center gap-1">
            <Plus size={12} /> {t('新增势力', 'Add Faction')}
          </button>
          <button onClick={autoColor} className="px-2 py-1.5 text-[11px] font-medium rounded-md border bg-white/[0.04] border-white/10 hover:bg-white/10">
            {t('自动配色', 'Auto Colors')}
          </button>
        </div>
      </Section>

      {/* ===== 地块 ===== */}
      <Section title={t('地块', 'Plots')}>
        <div className="space-y-1.5 mb-2 max-h-56 overflow-y-auto">
          {plots.map((p) => (
            <div key={p.id} className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 border ${terrPlotId === p.id ? 'border-brand bg-brand/10' : 'border-transparent'}`}>
              <button
                title={t('设为编辑目标（也可在地图上双击该地块）· 拖顶点编辑 · Alt+点顶点删除', 'Set edit target (or dblclick plot on map) · drag vertices · Alt+click to delete')}
                onClick={() => setTerrPlotId(terrPlotId === p.id ? null : p.id)}
                className={`h-6 w-6 flex items-center justify-center rounded shrink-0 ${terrPlotId === p.id ? 'text-brand' : 'text-muted-foreground hover:text-foreground'}`}
              ><Crosshair size={12} /></button>
              <input
                className="input h-7 text-xs flex-1 min-w-0"
                value={p.name || ''}
                placeholder={t('地块名称', 'Plot name')}
                onChange={(e) => setPlots(plots.map((x) => (x.id === p.id ? { ...x, name: e.target.value } : x)))}
              />
              <CountryDots
                countries={countries}
                value={p.ownerId}
                onChange={(cid) => setPlots(plots.map((x) => (x.id === p.id ? { ...x, ownerId: cid } : x)))}
              />
              <button
                title={t('删除地块', 'Delete plot')}
                onClick={() => deletePlot(p)}
                className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-red-400 shrink-0"
              ><Trash2 size={12} /></button>
            </div>
          ))}
          {plots.length === 0 && (
            <p className="text-[11px] text-muted-foreground">
              {t('用「疆域 → 绘制地块」或「导入疆域」添加', 'Draw or import plots')}
            </p>
          )}
        </div>
      </Section>

      {/* ===== 兼并事件 ===== */}
      <Section title={t('兼并事件', 'Annex Events')}>
        <div className="flex items-center gap-1.5 mb-2">
          <button
            disabled={terrSelPlots.length === 0 || countries.length === 0}
            onClick={createEvent}
            title={mode === 'terr_annex' ? undefined : t('提示：先在工具条进入「疆域 → 兼并」点选地块', 'Use Territory → Annex tool to pick plots')}
            className="px-2 py-1.5 text-[11px] font-medium rounded-md bg-brand text-white disabled:opacity-40"
          >
            {terrSelPlots.length > 0
              ? t(`生成兼并事件（已选 ${terrSelPlots.length} 地块）`, `Create event (${terrSelPlots.length} plots)`)
              : t('生成兼并事件（请点选地块）', 'Create event (pick plots)')}
          </button>
          {terrSelPlots.length > 0 && (
            <button onClick={() => setTerrSelPlots([])} className="px-2 py-1.5 text-[11px] rounded-md border bg-white/[0.04] border-white/10 hover:bg-white/10">
              {t('清除选择', 'Clear')}
            </button>
          )}
        </div>
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {[...events].sort((a, b) => a.frame - b.frame).map((ev) => (
            <div key={ev.id} className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground shrink-0">{t('时间', 'Time')}</span>
                <div className="w-20 shrink-0">
                  <FrameTimeField value={ev.frame} fps={fps} onFrameChange={(f) => setEvents(events.map((x) => (x.id === ev.id ? { ...x, frame: f } : x)))} />
                </div>
                <span className="text-[10px] text-muted-foreground shrink-0 ml-1">{t('占领', '→')}</span>
                <div className="flex-1 min-w-0 overflow-x-auto">
                  <CountryDots
                    countries={countries}
                    value={ev.toCountryId}
                    onChange={(cid) => setEvents(events.map((x) => (x.id === ev.id ? { ...x, toCountryId: cid } : x)))}
                  />
                </div>
                <button
                  title={t('删除事件', 'Delete event')}
                  onClick={() => setEvents(events.filter((x) => x.id !== ev.id))}
                  className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground hover:text-red-400 shrink-0"
                ><Trash2 size={12} /></button>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <OptionBlocks<'instant' | 'fade' | 'draw' | 'spread' | 'shrink'>
                  value={ev.effect?.preset || 'draw'}
                  onChange={(v) => setEvents(events.map((x) => (x.id === ev.id ? { ...x, effect: { preset: v, duration: x.effect?.duration, highlight: x.effect?.highlight } } : x)))}
                  options={[
                    { value: 'instant', label: t('瞬时', 'Instant') },
                    { value: 'fade', label: t('渐变', 'Fade') },
                    { value: 'draw', label: t('描线', 'Draw') },
                    { value: 'spread', label: t('扩散', 'Spread') },
                    { value: 'shrink', label: t('蚕食', 'Nibble') },
                  ]}
                />
                <div className="w-24 shrink-0">
                  <FrameTimeField
                    value={ev.effect?.duration ?? Math.round(fps)}
                    fps={fps}
                    onFrameChange={(f) => setEvents(events.map((x) => (x.id === ev.id ? { ...x, effect: { preset: x.effect?.preset || 'draw', duration: Math.max(1, f), highlight: x.effect?.highlight } } : x)))}
                  />
                </div>
                <Toggle
                  checked={!!ev.effect?.highlight}
                  label={t('高亮', 'Glow')}
                  onChange={(v) => setEvents(events.map((x) => (x.id === ev.id ? { ...x, effect: { preset: x.effect?.preset || 'draw', duration: x.effect?.duration, highlight: v } } : x)))}
                />
              </div>
              <p className="text-[10px] text-muted-foreground truncate">{plotLabel(ev.plotIds)}</p>
            </div>
          ))}
          {events.length === 0 && (
            <p className="text-[11px] text-muted-foreground">
              {t('暂无事件：点选地块后生成，播放到该时间即播放兼并动画', 'No events yet')}
            </p>
          )}
        </div>
      </Section>

      {/* ===== 显示 ===== */}
      <Section title={t('显示', 'Display')}>
        <div className="bg-black/40 border border-white/[0.08] rounded-[10px] px-3 py-2.5 space-y-2.5">
          <Toggle checked={display.countryBorders} label={t('势力边界（并集外边界）', 'Faction Borders')} onChange={(v) => setDisplay({ countryBorders: v })} />
          <Toggle checked={display.plotBorders} label={t('地块边界', 'Plot Borders')} onChange={(v) => setDisplay({ plotBorders: v })} />
          <Toggle checked={display.countryNames} label={t('势力标签', 'Faction Labels')} onChange={(v) => setDisplay({ countryNames: v })} />
          <Toggle checked={display.plotNames} label={t('地块名标签', 'Plot Names')} onChange={(v) => setDisplay({ plotNames: v })} />
        </div>
        <Field label={t('标签朝向', 'Label Align')}>
          <OptionBlocks<'map' | 'viewport'>
            value={display.labelAlign}
            onChange={(v) => setDisplay({ labelAlign: v })}
            options={[
              { value: 'map', label: t('🧭 贴地', '🧭 Ground') },
              { value: 'viewport', label: t('🎥 面向镜头', '🎥 Face Cam') },
            ]}
          />
        </Field>
        <Field label={t('标签缩放', 'Label Scale')}>
          <RangeInput value={display.labelScale} min={0.5} max={3} step={0.1} suffix="×" onChange={(v) => setDisplay({ labelScale: v })} />
        </Field>
        <Field label={t('边界宽度', 'Border Width')}>
          <RangeInput value={display.borderWidth} min={1} max={8} step={1} suffix="px" onChange={(v) => setDisplay({ borderWidth: Math.max(1, v) })} />
        </Field>
        <Field label={t('填充透明度', 'Fill Opacity')}>
          <RangeInput value={display.fillOpacity} min={0} max={1} step={0.05} onChange={(v) => setDisplay({ fillOpacity: v })} />
        </Field>
      </Section>

      {colorEditId && (() => {
        const colorCountry = countries.find((c) => c.id === colorEditId);
        if (!colorCountry) return null;
        return (
          <CountryColorDialog
            country={colorCountry}
            onClose={() => setColorEditId(null)}
            onChange={(col) => setCountries(countries.map((x) => (x.id === colorCountry.id ? { ...x, color: col } : x)))}
            onAuto={autoColor}
          />
        );
      })()}
    </>
  );
}
