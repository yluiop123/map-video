import { useRef, useState, useEffect } from 'react';
import { MapPin, Route as RouteIcon, Square, Trash2, Plus } from 'lucide-react';
import { useProjectStore } from '../stores/projectStore';
import { useEditorStore } from '../stores/editorStore';
import { generateId } from '../types';
import { FrameTimeField } from './FrameTimeField';
import { frameToSeconds, secondsToFrame, round2 } from '../lib/time';
import { Section, Field, StyleGrid, Toggle, ColorPicker, OptionBlocks, PanelHeader, useT, NumberInput } from './ui/primitives';
import { useConfirm } from './ui/ConfirmHost';
import Cropper from 'react-easy-crop';
import 'react-easy-crop/react-easy-crop.css';
import type {
  MapElement, PointElement, LineElement,
  PolygonElement, ArrowElement, CustomIconElement, FlagElement,
  DoubleArrowElement, EncirclementElement, GatheringElement,
  CameraKeyframe,
} from '../types';

type Category = 'pin' | 'route' | 'shape-multi' | 'shape-two' | 'shape-special' | 'image';

const CATEGORY_META: Record<Category, { icon: React.ReactNode; zh: string; en: string }> = {
  pin: { icon: <MapPin size={14} className="text-red-400" />, zh: '标记设置', en: 'Pin Settings' },
  route: { icon: <RouteIcon size={14} className="text-blue-400" />, zh: '路线设置', en: 'Route Settings' },
  'shape-multi': { icon: <Square size={14} className="text-orange-400" />, zh: '多点绘制设置', en: 'Multi-Point Shape Settings' },
  'shape-two': { icon: <Square size={14} className="text-orange-400" />, zh: '两点绘制设置', en: 'Two-Point Shape Settings' },
  'shape-special': { icon: <Square size={14} className="text-orange-400" />, zh: '特殊图形设置', en: 'Special Shape Settings' },
  image: { icon: <MapPin size={14} className="text-red-400" />, zh: '标记设置', en: 'Marker Settings' },
};

function categoryOf(el: MapElement): Category {
  const sc = el.shapeCategory;
  if (sc === 'multi') return 'shape-multi';
  if (sc === 'two') return 'shape-two';
  if (sc === 'special') return 'shape-special';
  if (sc === 'route') return 'route';
  const t = el.type;
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
  return 'image';
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

        {cat === 'pin' && <PinSettings element={element as PointElement | FlagElement} patch={patch} project={project} />}
        {cat === 'route' && <RouteSettings element={element} patch={patch} chapter={findChapterOf(project, element.id)!} />}
        {cat === 'shape-multi' && <MultiShapeSettings element={element} patch={patch} />}
        {cat === 'shape-two' && <TwoShapeSettings element={element} patch={patch} />}
        {cat === 'shape-special' && <SpecialShapeSettings element={element} patch={patch} />}
        {cat === 'image' && <ImageSettings element={element as CustomIconElement} patch={patch} />}

        {cat !== 'pin' && cat !== 'route' && (
          <Section title={t('显示时间', 'Display Time')}>
            <DisplayTimeToggle element={element} patch={patch} project={project} />
          </Section>
        )}

        {/* LABEL 相关（Show Label / LABEL STYLE）：位于时间之后 */}
        {cat === 'pin' && element.type === 'point' && (() => {
          const pe = element as PointElement;
          const st = pinStyleOf(pe);
          if (st === 'image') return null;
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

type PinStyle = 'dot' | 'pin' | 'bubble' | 'emoji' | 'text' | 'flag' | 'image';

const EMOJI_CHOICES = ['📍', '🚩', '⚔️', '🏰', '🔥', '⭐', '✅', '❌', '💀', '🛡️', '⚓', '✈️', '🚀', '💥', '👑', '🎯', '🪖', '☢️', '🕊️', '🩸', '⚠️', '💤', '🧭', '📕'];

function PinSettings({ element, patch, project }: {
  element: PointElement | FlagElement;
  patch: (changes: Partial<MapElement>) => void;
  project: NonNullable<ReturnType<typeof useProjectStore.getState>['project']>;
}) {
  const pe = element as PointElement;
  const style: PinStyle = element.type === 'flag' ? 'flag' : pinStyleOf(pe);
  const coords = element.coordinates;
  const t = useT();

  return (
    <>
      <PinStyleChooser element={element} patch={patch} project={project} />

      <div className="grid grid-cols-2 gap-2">
        <Field label={t('经度', 'Longitude')}>
          <NumberInput value={coords[0].toFixed(5)} onCommit={(v) => patch({ coordinates: [v || 0, coords[1]] })} className="input" step="0.00001" />
        </Field>
        <Field label={t('纬度', 'Latitude')}>
          <NumberInput value={coords[1].toFixed(5)} onCommit={(v) => patch({ coordinates: [coords[0], v || 0] })} className="input" step="0.00001" />
        </Field>
      </div>

      {(style === 'dot' || style === 'pin' || style === 'bubble' || style === 'emoji' || style === 'text' || style === 'flag') && (
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

      {(style === 'dot' || style === 'pin' || style === 'bubble' || style === 'emoji' || style === 'text') && (
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

      {(style === 'dot' || style === 'pin') && (
        <Appearance color={pe.color || '#FF4444'} onChange={(c) => patch({ color: c })} />
      )}

    </>
  );
}

/** PIN STYLE 选择区（PinSettings 与 ImageSettings 共用）：基础样式 + 图标库（上传的自定义图标） */
function PinStyleChooser({ element, patch, project }: {
  element: MapElement;
  patch: (c: Partial<MapElement>) => void;
  project: NonNullable<ReturnType<typeof useProjectStore.getState>['project']>;
}) {
  const coords = (element as unknown as CustomIconElement).coordinates;
  const pe = element as PointElement;
  const isFlag = element.type === 'flag';
  const style: PinStyle = isFlag ? 'flag' : element.type === 'custom_icon' ? 'image' : pinStyleOf(pe);
  const removeCustomSymbol = useProjectStore((s) => s.removeCustomSymbol);
  const t = useT();
  const confirm = useConfirm();

  const setStyle = (s: PinStyle) => {
    // 从自定义图标或旗帜切回其他样式时，把残留的白色 color 重置为默认红
    const leavingIcon = style === 'image' || style === 'flag';
    const colorReset = leavingIcon ? { color: '#FF4444' } : {};
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
        flagColor: leavingIcon ? '#E23B3B' : (pe.color || '#E23B3B'), textColor: lbl?.color || '#FFFFFF',
        fontSize: 28, flagWidth: 216, scale: 1,
      } as Partial<MapElement>);
    } else {
      const first = project.customSymbols[0];
      patch({ type: 'custom_icon', symbolId: first?.id || '', size: 40, rotation: 0, color: '#FFFFFF' } as Partial<MapElement>);
    }
  };

  const blockBtn = 'flex items-center justify-center gap-1 px-1 py-1.5 text-[11px] font-medium rounded-md border truncate transition-colors';
  const blockOn = 'bg-brand/20 border-brand text-foreground font-semibold';
  const blockOff = 'bg-white/[0.03] border-white/10 text-foreground/80 hover:bg-accent hover:border-white/20';

  return (
    <Section title={t('样式', 'Pin Style')}>
      <div className="grid grid-cols-3 gap-1.5">
        {/* 基础样式 */}
        {([
          { value: 'pin', label: '📍 PIN' },
          { value: 'dot', label: '⚫ DOT' },
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
        {/* 自定义图标：文字块同款样式，可删除 */}
        {project.customSymbols.map((s) => (
          <div key={s.id} className="relative group/sym">
            <button
              title={s.name}
              onClick={() => patch({ type: 'custom_icon', symbolId: s.id, coordinates: coords, size: 40, rotation: 0, color: '#FFFFFF' } as Partial<MapElement>)}
              className={`${blockBtn} w-full ${
                style === 'image' && (element as unknown as CustomIconElement).symbolId === s.id
                  ? blockOn
                  : blockOff
              }`}
            >
              <span className="truncate">{s.name}</span>
            </button>
            <button
              title={t('删除图标', 'Delete icon')}
              onClick={(e) => {
                e.stopPropagation();
                void confirm({ message: t(`从图标库删除「${s.name}」？`, `Delete "${s.name}" from library?`), danger: true, confirmText: t('删除', 'Delete') }).then((ok: boolean) => ok && removeCustomSymbol(s.id));
              }}
              className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white items-center justify-center hidden group-hover/sym:flex hover:bg-red-400"
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>
        ))}
        {/* 上传入口固定在最后 */}
        <IconUploadButton
          onPick={(id) => patch({ type: 'custom_icon', symbolId: id, coordinates: coords, size: 40, rotation: 0, color: '#FFFFFF' } as Partial<MapElement>)}
        />
      </div>
    </Section>
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

function pinStyleOf(pe: PointElement): 'dot' | 'pin' | 'bubble' | 'emoji' | 'text' | 'image' {
  if (pe.iconUrl) return 'image';
  if (pe.shape === 'text') return 'text';
  if (pe.shape === 'pin') return 'pin';
  if (pe.shape === 'bubble') return 'bubble';
  if (pe.shape === 'emoji') return 'emoji';
  return 'dot';
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
            { value: 'military-arrow', label: t('🪶 燕尾箭头', '🪶 Swallowtail') },
            { value: 'military-simple', label: t('⚔️ 行军箭头', '⚔️ March Arrow') },
            { value: 'plain-straight', label: t('▫ 无样式直线', '▫ Plain Line') },
            { value: 'plain-bezier', label: t('▫ 无样式曲线', '▫ Plain Curve') },
          ]}
          onChange={setStyle}
        />
      </Section>

      <Section title={t('动画效果', 'Animation Effect')}>
        <OptionBlocks<'grow' | 'move' | 'fill'>
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
          ]}
        />
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
                onChange={(v) => patch({ uniformMove: v, ...(!v ? { pointTimes: undefined } : {}) } as Partial<MapElement>)}
              />
            </div>
          )}
          {((element as LineElement).uniformMove !== false) && !!((element as LineElement).animEffect) && (
            <div className="mb-2 space-y-2 border-t border-white/[0.08] pt-2">
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('动画开始时间', 'Anim Start')}>
                  <FrameTimeField value={(element as LineElement).moveStartFrame ?? element.startFrame} fps={fps} onFrameChange={(f) => patch({ moveStartFrame: Math.max(element.startFrame, Math.min(element.endFrame, f)) } as Partial<MapElement>)} />
                </Field>
                <Field label={t('动画结束时间', 'Anim End')}>
                  <FrameTimeField value={(element as LineElement).moveEndFrame ?? element.endFrame} fps={fps} onFrameChange={(f) => patch({ moveEndFrame: Math.max(element.startFrame, Math.min(element.endFrame, f)) } as Partial<MapElement>)} />
                </Field>
              </div>
              <p className="text-[10px] text-muted-foreground">必须在显示时间区间内</p>
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
              const showTimes = !!le.animEffect && le.uniformMove === false;
              const times = le.pointTimes || [];
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
                        const arr = coords.map((_, x) => times[x] ?? (x === 0 ? (le.moveStartFrame ?? element.startFrame) : (le.moveEndFrame ?? element.endFrame)));
                        arr[i] = secondsToFrame(v || 0, fps);
                        patch({ pointTimes: arr } as Partial<MapElement>);
                      }} />
                )}
                <button onClick={() => {
                  if (coords.length <= 2) return;
                  const c = coords.filter((_, x) => x !== i);
                  patch(pathField === 'coordinates' ? { coordinates: c } : { [pathField]: c } as Partial<MapElement>);
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
              <div className="grid grid-cols-3 gap-1.5">
                {([
                  { value: 'pin', label: '📍 PIN' },
                  { value: 'dot', label: '⚫ DOT' },
                  { value: 'bubble', label: '💬 BUBBLE' },
                  { value: 'flag', label: t('🚩 旗帜', '🚩 MARKER') },
                  { value: 'text', label: 'Aa TEXT' },
                  { value: 'emoji', label: '😀 EMOJI' },
                ] as { value: 'dot' | 'pin' | 'bubble' | 'flag' | 'text' | 'emoji'; label: string }[]).map((o) => (
                  <button
                    key={o.value}
                    onClick={() => patch({ moveIcon: { ...(element as LineElement).moveIcon, shape: o.value } } as Partial<MapElement>)}
                    className={`flex items-center justify-center gap-1 px-1 py-1.5 text-[11px] font-medium rounded-md border truncate transition-colors ${((element as LineElement).moveIcon?.shape || 'dot') === o.value ? 'bg-brand/20 border-brand text-foreground font-semibold' : 'bg-white/[0.03] border-white/10 text-foreground/80 hover:bg-accent hover:border-white/20'}`}
                  >
                    {o.label}
                  </button>
                ))}
                {/* 自定义图标（与标记共用图标库） */}
                {(useProjectStore.getState().project?.customSymbols || []).map((sym) => (
                  <button
                    key={sym.id}
                    title={sym.name}
                    onClick={() => patch({ moveIcon: { ...(element as LineElement).moveIcon, shape: 'image', symbolId: sym.id } } as Partial<MapElement>)}
                    className={`flex items-center justify-center gap-1 px-1 py-1.5 text-[11px] font-medium rounded-md border truncate transition-colors overflow-hidden ${((element as LineElement).moveIcon?.shape === 'image' && (element as LineElement).moveIcon?.symbolId === sym.id) ? 'bg-brand/20 border-brand text-foreground font-semibold' : 'bg-white/[0.03] border-white/10 text-foreground/80 hover:bg-accent hover:border-white/20'}`}
                  >
                    <img src={sym.url} alt={sym.name} className="w-5 h-5 object-contain" />
                  </button>
                ))}
                <IconUploadButton
                  onPick={(id) => patch({ moveIcon: { ...(element as LineElement).moveIcon, shape: 'image', symbolId: id } } as Partial<MapElement>)}
                />
              </div>
            </Field>

            {((element as LineElement).moveIcon?.shape || 'dot') !== 'image' && (
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
            { value: 'swallowtail', label: t('🪶 燕尾箭头', '🪶 Swallowtail') },
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

// ========== IMAGE ==========

function ImageSettings({ element, patch }: { element: CustomIconElement; patch: (c: Partial<MapElement>) => void }) {
  const t = useT();
  const el = element;
  const sizePct = Math.round(((el.size || 32) / 64) * 100);

  return (
    <>
      <PinStyleChooser element={element} patch={patch} project={useProjectStore.getState().project!} />

      <div className="grid grid-cols-2 gap-2">
        <Field label={t('经度', 'Longitude')}>
          <NumberInput step="0.00001" className="input" value={Number(el.coordinates[0]).toFixed(5)}
            onCommit={(v) => patch({ coordinates: [v || 0, el.coordinates[1]] })} />
        </Field>
        <Field label={t('纬度', 'Latitude')}>
          <NumberInput step="0.00001" className="input" value={Number(el.coordinates[1]).toFixed(5)}
            onCommit={(v) => patch({ coordinates: [el.coordinates[0], v || 0] })} />
        </Field>
      </div>

      <Section title={t('大小', 'Size')}>
        <div className="flex items-center gap-2">
          <input
            type="range" min={30} max={300} step={5} value={sizePct}
            onChange={(e) => patch({ size: Math.max(8, Math.round((parseInt(e.target.value) || 100) * 0.64)) })}
            className="w-full"
          />
          <span className="text-xs w-12 text-right shrink-0">{sizePct}%</span>
        </div>
      </Section>

      <Section title={t('朝向', 'Orientation')}>
        <OptionBlocks<'faceCam' | 'flat'>
          value={el.orientation ?? 'faceCam'}
          onChange={(v) => patch({ orientation: v, ...(v === 'faceCam' ? { rotation: 0 } : {}) } as Partial<MapElement>)}
          options={[
            { value: 'faceCam', label: t('🎥 面向镜头', '🎥 Face Cam') },
            { value: 'flat', label: t('🗺 贴地', '🗺 Flat') },
          ]}
        />
        <Field label={t('旋转', 'Rotation')}>
          <div className="flex items-center gap-2">
            <input
              type="range" min="0" max="360" step="1" value={Math.round(el.rotation || 0)}
              onChange={(e) => patch({ rotation: parseFloat(e.target.value) || 0 } as Partial<MapElement>)}
              className="w-full"
            />
            <span className="text-xs w-10 text-right shrink-0">{Math.round(el.rotation || 0)}°</span>
          </div>
        </Field>
      </Section>

      <Section title={t('图标颜色', 'Icon Color')}>
        <ColorPicker
          value={el.color || '#FFFFFF'}
          onChange={(c) => patch({ color: c } as Partial<MapElement>)}
        />
      </Section>
    </>
  );
}
function UploadIconDialog({ dataUrl, defaultName, onConfirm, onCancel }: {
  dataUrl: string;
  defaultName: string;
  onConfirm: (symbolId: string) => void;
  onCancel: () => void;
}) {
  const addCustomSymbol = useProjectStore((s) => s.addCustomSymbol);
  const t = useT();
  const [name, setName] = useState(defaultName);
  const [mode, setMode] = useState<'square' | 'circle' | 'original'>('square');
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const cropPxRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);

  const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });

  // 实时预览（模式/裁剪变化时重绘 64×64）
  useEffect(() => {
    let alive = true;
    (async () => {
      const cv = previewRef.current;
      if (!cv) return;
      const ctx = cv.getContext('2d')!;
      ctx.clearRect(0, 0, 64, 64);
      try {
        const img = await loadImage(dataUrl);
        if (!alive) return;
        if (mode === 'original') {
          const k = Math.min(64 / img.naturalWidth, 64 / img.naturalHeight);
          const w = img.naturalWidth * k, h = img.naturalHeight * k;
          ctx.drawImage(img, (64 - w) / 2, (64 - h) / 2, w, h);
          return;
        }
        const px = cropPxRef.current;
        if (!px || px.width < 4 || px.height < 4) return;
        ctx.save();
        if (mode === 'circle') { ctx.beginPath(); ctx.arc(32, 32, 32, 0, Math.PI * 2); ctx.clip(); }
        ctx.drawImage(img, px.x, px.y, px.width, px.height, 0, 0, 64, 64);
        ctx.restore();
      } catch { /* 忽略预览失败 */ }
    })();
    return () => { alive = false; };
  }, [dataUrl, mode, crop, zoom]);

  const buildExport = async (): Promise<string | null> => {
    const img = await loadImage(dataUrl);
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d')!;
    if (mode === 'original') {
      const k = Math.min(64 / img.naturalWidth, 64 / img.naturalHeight);
      const w = img.naturalWidth * k, h = img.naturalHeight * k;
      ctx.drawImage(img, (64 - w) / 2, (64 - h) / 2, w, h);
      return c.toDataURL('image/png');
    }
    const px = cropPxRef.current;
    if (!px || px.width < 4 || px.height < 4) return null;
    if (mode === 'circle') { ctx.beginPath(); ctx.arc(32, 32, 32, 0, Math.PI * 2); ctx.clip(); }
    ctx.drawImage(img, px.x, px.y, px.width, px.height, 0, 0, 64, 64);
    return c.toDataURL('image/png');
  };

  const confirmAdd = async () => {
    const url = await buildExport();
    if (!url) return;
    const id = generateId();
    addCustomSymbol({ id, name: name.trim() || '图标', type: 'image', url, width: 64, height: 64 });
    onConfirm(id);
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-[70] flex items-center justify-center" onClick={onCancel}>
      <div className="w-[380px] bg-card border border-white/10 rounded-2xl shadow-2xl p-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold mb-3">{t('上传图标', 'Upload Icon')}</h3>

        {/* 裁剪模式 */}
        <OptionBlocks<'square' | 'circle' | 'original'>
          value={mode}
          onChange={(v) => { setMode(v); setCrop({ x: 0, y: 0 }); setZoom(1); }}
          options={[
            { value: 'square', label: t('方形', 'Square') },
            { value: 'circle', label: t('圆形', 'Circle') },
            { value: 'original', label: t('原图', 'Original') },
          ]}
        />

        {/* 裁剪器 / 原图预览 */}
        <div className="mt-2 mb-3">
          {mode === 'original' ? (
            <div className="h-48 rounded-lg border border-white/10 bg-white/[0.04] flex items-center justify-center overflow-hidden">
              <img src={dataUrl} alt="" className="max-w-full max-h-full object-contain" />
            </div>
          ) : (
            <div className="relative h-48 rounded-lg overflow-hidden">
              <Cropper
                image={dataUrl}
                crop={crop}
                zoom={zoom}
                aspect={1}
                cropShape={mode === 'circle' ? 'round' : 'rect'}
                showGrid={false}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={(_, px) => { cropPxRef.current = px; }}
              />
            </div>
          )}
        </div>

        {/* 预览 + 命名 */}
        <div className="flex items-center gap-3 mb-3">
          <div className="w-14 h-14 rounded-lg border border-white/10 bg-white/[0.04] flex items-center justify-center overflow-hidden shrink-0">
            <canvas ref={previewRef} width={64} height={64} className="w-full h-full object-contain" />
          </div>
          <div className="flex-1 min-w-0">
            <label className="text-[11px] text-muted-foreground block mb-1">{t('图标名称', 'Icon Name')}</label>
            <input
              autoFocus value={name} onChange={(e) => setName(e.target.value)}
              className="input h-8 text-xs" placeholder={t('图标名称', 'Icon Name')}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmAdd(); }}
            />
            <p className="text-[10px] text-muted-foreground mt-1">{t('统一输出 64×64 图标', 'Outputs a 64×64 icon')}</p>
          </div>
        </div>

        <div className="flex gap-2">
          <button onClick={onCancel} className="btn-outline text-xs flex-1 py-1.5">{t('取消', 'Cancel')}</button>
          <button onClick={confirmAdd} className="btn-primary text-xs flex-1 py-1.5">{t('添加', 'Add')}</button>
        </div>
      </div>
    </div>
  );
}

/** 上传图标按钮：选图 → 统一长宽 → 命名 → 加入图标库 */
function IconUploadButton({ onPick, className = '' }: {
  onPick: (symbolId: string) => void;
  className?: string;
}) {
  const t = useT();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ dataUrl: string; name: string } | null>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        title={t('上传图片作为图标', 'Upload image as icon')}
        className={`px-1 py-1.5 text-[11px] font-medium rounded-md border border-dashed border-white/20 text-muted-foreground hover:text-foreground hover:border-white/40 transition-colors flex items-center justify-center gap-1 w-full ${className}`}
      >
        <Plus size={12} /> {t('上传', 'Upload')}
      </button>
      <input
        ref={fileRef} type="file" accept="image/*" className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => setPending({ dataUrl: reader.result as string, name: file.name.replace(/\.[^.]+$/, '') });
          reader.readAsDataURL(file);
          e.target.value = '';
        }}
      />
      {pending && (
        <UploadIconDialog
          dataUrl={pending.dataUrl}
          defaultName={pending.name}
          onCancel={() => setPending(null)}
          onConfirm={(id) => { setPending(null); onPick(id); }}
        />
      )}

    </>
  );
}

// ========== 通用保留区 ==========

// 避免 CameraKeyframe 未使用告警（导出给未来扩展）
export type { CameraKeyframe };
