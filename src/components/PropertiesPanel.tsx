import { useRef, useState, useEffect } from 'react';
import { MapPin, Route as RouteIcon, Square, Trash2, Plus } from 'lucide-react';
import { useProjectStore } from '../stores/projectStore';
import { useEditorStore } from '../stores/editorStore';
import { generateId } from '../types';
import { FrameTimeField } from './FrameTimeField';
import { Section, Field, StyleGrid, Toggle, ColorPicker, OptionBlocks, PanelHeader, useT } from './ui/primitives';
import { useConfirm } from './ui/ConfirmHost';
import Cropper from 'react-easy-crop';
import 'react-easy-crop/react-easy-crop.css';
import type {
  MapElement, PointElement, LineElement,
  PolygonElement, ArrowElement, CustomIconElement, FlagElement,
  CameraKeyframe,
} from '../types';

type Category = 'pin' | 'route' | 'shape' | 'image';

const CATEGORY_META: Record<Category, { icon: React.ReactNode; zh: string; en: string }> = {
  pin: { icon: <MapPin size={14} className="text-red-400" />, zh: '标记设置', en: 'Pin Settings' },
  route: { icon: <RouteIcon size={14} className="text-blue-400" />, zh: '路线设置', en: 'Route Settings' },
  shape: { icon: <Square size={14} className="text-orange-400" />, zh: '形状设置', en: 'Shape Settings' },
  image: { icon: <MapPin size={14} className="text-red-400" />, zh: '标记设置', en: 'Marker Settings' },
};

function categoryOf(el: MapElement): Category {
  const t = el.type;
  if (t === 'point' || t === 'flag') return 'pin';
  if (t === 'arrow' && (el as ArrowElement).arrowType === 'swallowtail') return 'shape';
  if (t === 'double_arrow') return 'shape';
  if (t === 'line' || t === 'moving_point' || t === 'arrow') return 'route';
  if (t === 'polygon' || t === 'encirclement' || t === 'gathering') return 'shape';
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

  const fps = project.globalConfig.defaultFPS;
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
        {cat === 'shape' && <ShapeSettings element={element} patch={patch} />}
        {cat === 'image' && <ImageSettings element={element as CustomIconElement} patch={patch} />}

        {cat !== 'pin' && (
          <Section>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('开始时间', 'Start Time')}>
                <FrameTimeField value={element.startFrame} fps={fps} onFrameChange={(f) => patch({ startFrame: f })} />
              </Field>
              <Field label={t('结束时间', 'End Time')}>
                <FrameTimeField value={element.endFrame} fps={fps} onFrameChange={(f) => patch({ endFrame: f })} />
              </Field>
            </div>
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

        {/* 显示时间：默认全程显示，开启后可自定义起止时间 */}
        <PinTimeSettings key={element.id} element={element} patch={patch} project={project} />
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
            value={(label.position || 'bottom') as any}
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
          const prev = label.bgColor && label.bgColor !== 'rgba(0,0,0,0)' && label.bgColor !== 'transparent' ? label.bgColor : '#000000';
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
          <input type="number" value={coords[0].toFixed(5)} onChange={(e) => patch({ coordinates: [parseFloat(e.target.value) || 0, coords[1]] })} className="input" step="0.00001" />
        </Field>
        <Field label={t('纬度', 'Latitude')}>
          <input type="number" value={coords[1].toFixed(5)} onChange={(e) => patch({ coordinates: [coords[0], parseFloat(e.target.value) || 0] })} className="input" step="0.00001" />
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
function PinTimeSettings({ element, patch, project }: {
  element: MapElement;
  patch: (c: Partial<MapElement>) => void;
  project: NonNullable<ReturnType<typeof useProjectStore.getState>['project']>;
}) {
  const t = useT();
  const ch = project.chapters.find((c) => c.elements.some((e) => e.id === element.id)) || project.chapters[0];
  const fps = project.globalConfig.defaultFPS;
  const [on, setOn] = useState(element.startFrame !== ch.startFrame || element.endFrame !== ch.endFrame);

  return (
    <Section title={t('显示时间', 'Display Time')}>
      <Toggle
        checked={on}
        label={t('自定义显示时间', 'Custom display time')}
        onChange={(v) => {
          setOn(v);
          if (!v) patch({ startFrame: ch.startFrame, endFrame: ch.endFrame });
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
    </Section>
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
                position: base.position ?? (element.shape === 'text' ? 'center' : 'bottom'),
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

type RouteStyle = 'straight' | 'bezier' | 'arc' | 'swallowtail' | 'curved' | 'pincer' | 'straight-arrow' | 'curved-arrow' | 'military-arrow' | 'military-simple';

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
    element.type === 'line' ? ((element as LineElement).lineArrow
      ? ((element as LineElement).lineType === 'bezier' ? 'curved-arrow' : 'straight-arrow')
      : ((element as LineElement).lineType === 'bezier' ? 'bezier' : (element as LineElement).lineType === 'arc' ? 'arc' : 'straight'))
    : element.type === 'arrow' ? ((element as ArrowElement).arrowType === 'curved-simple' ? 'military-simple' : 'military-arrow')
    : element.type === 'double_arrow' ? 'pincer'
    : 'straight';

  const setStyle = (s: RouteStyle) => {
    const start = chapter.startFrame;
    if (s === 'straight' || s === 'bezier' || s === 'arc') {
      patch({
        type: 'line', coordinates: coords.length >= 2 ? coords : [[104, 35], [105, 36]],
        lineType: s, lineArrow: false, drawProgress: [{ frame: start, value: 1 }],
        lineWidth: 3, lineColor: colorOf,
      } as Partial<MapElement>);
    } else if (s === 'straight-arrow') {
      patch({
        type: 'line', coordinates: coords.length >= 2 ? coords : [[104, 35], [105, 36]],
        lineType: 'straight', lineArrow: true, drawProgress: [{ frame: start, value: 1 }],
        lineWidth: 3, lineColor: colorOf,
      } as Partial<MapElement>);
    } else if (s === 'curved-arrow') {
      patch({
        type: 'line', coordinates: coords.length >= 2 ? coords : [[104, 35], [105, 36]],
        lineType: 'bezier', lineArrow: true, drawProgress: [{ frame: start, value: 1 }],
        lineWidth: 3, lineColor: colorOf,
      } as Partial<MapElement>);
    } else if (s === 'military-arrow') {
      const pts = coords.length >= 2 ? coords : [[104, 35], [105, 36]];
      patch({
        type: 'arrow', from: pts[0], to: pts[pts.length - 1], path: pts.map(p => [p[0], p[1]]),
        arrowType: 'curved', width: 15, color: colorOf,
        progress: [{ frame: start, value: 1 }], drawZoom: undefined,
      } as Partial<MapElement>);
    } else if (s === 'military-simple') {
      const pts = coords.length >= 2 ? coords : [[104, 35], [105, 36]];
      patch({
        type: 'arrow', from: pts[0], to: pts[pts.length - 1], path: pts.map(p => [p[0], p[1]]),
        arrowType: 'curved-simple', width: 15, color: colorOf,
        progress: [{ frame: start, value: 1 }], drawZoom: undefined,
      } as Partial<MapElement>);
    } else {
      patch({
        type: 'double_arrow', points: pad4(coords), color: colorOf,
        progress: [{ frame: start, value: 1 }],
      } as Partial<MapElement>);
    }
  };

  const isMoving = element.type === 'moving_point';

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
          ]}
          onChange={setStyle}
        />
      </Section>

      <Section title={t('动画', 'Animation')}>
        <Toggle
          checked={isMoving}
          label="🏃 移动动画（沿路径运动）"
          onChange={(v) => {
            if (v) {
              patch({
                type: 'moving_point', path: coords.length >= 2 ? coords : [[104, 35], [105, 36]],
                pathProgress: [{ frame: chapter.startFrame, value: 0 }, { frame: chapter.endFrame, value: 1 }],
                color: colorOf,
              } as Partial<MapElement>);
            } else if (element.type === 'moving_point' && wasArrowRef.current) {
              // 从箭头转来的移动点：恢复为行军箭头
              patch({
                type: 'arrow', from: coords[0], to: coords[coords.length - 1], path: coords.map(p => [p[0], p[1]]),
                progress: [{ frame: chapter.startFrame, value: 1 }], drawZoom: undefined,
              } as Partial<MapElement>);
              wasArrowRef.current = null;
            } else {
              patch({
                type: 'line', coordinates: coords.length >= 2 ? coords : [[104, 35], [105, 36]],
                drawProgress: [{ frame: chapter.startFrame, value: 1 }],
                lineWidth: 3, lineColor: colorOf,
              } as Partial<MapElement>);
            }
          }}
        />
      </Section>

      <Section title={t('笔触', 'Stroke')}>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('宽度', 'Width')}>
            <input type="number" min="1" max="40" className="input" value={widthOf}
              onChange={(e) => {
                const w = parseInt(e.target.value) || 3;
                if (element.type === 'line') patch({ lineWidth: w });
                else if (element.type === 'arrow') patch({ width: w } as Partial<MapElement>);
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
            {coords.map((coord, i) => (
              <div key={i} className="flex items-center gap-1 mb-1">
                <span className="text-xs w-6">P{i + 1}</span>
                <input type="number" step="0.00001" className="input flex-1" value={coord[0].toFixed(5)}
                  onChange={(e) => {
                    const c = [...coords]; c[i] = [parseFloat(e.target.value) || 0, coord[1]];
                    patch(pathField === 'coordinates' ? { coordinates: c } : { [pathField]: c } as Partial<MapElement>);
                  }} />
                <input type="number" step="0.00001" className="input flex-1" value={coord[1].toFixed(5)}
                  onChange={(e) => {
                    const c = [...coords]; c[i] = [coord[0], parseFloat(e.target.value) || 0];
                    patch(pathField === 'coordinates' ? { coordinates: c } : { [pathField]: c } as Partial<MapElement>);
                  }} />
                <button onClick={() => {
                  if (coords.length <= 2) return;
                  const c = coords.filter((_, x) => x !== i);
                  patch(pathField === 'coordinates' ? { coordinates: c } : { [pathField]: c } as Partial<MapElement>);
                }} className="text-xs text-red-500 disabled:opacity-30" disabled={coords.length <= 2}>×</button>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Appearance color={colorOf} onChange={(c) => {
        if (element.type === 'line') patch({ lineColor: c });
        else if (element.type === 'moving_point') patch({ color: c });
        else patch({ color: c });
      }} />
    </>
  );
}

// ========== SHAPE ==========

type ShapeStyle = 'poly' | 'rect' | 'circle' | 'encirclement' | 'gathering' | 'swallowtail' | 'pincer';

function rectRing(c1: [number, number], c2: [number, number]): [number, number][] {
  return [[c1[0], c1[1]], [c2[0], c1[1]], [c2[0], c2[1]], [c1[0], c2[1]], [c1[0], c1[1]]];
}
function bboxOf(ring: [number, number][] | null): { c1: [number, number]; c2: [number, number] } {
  const pts = (ring && ring.length > 2 ? ring.slice(0, -1) : [[104, 35], [105, 36]]) as [number, number][];
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y] of pts) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
  return { c1: [x1, y1], c2: [x2, y2] };
}

function ShapeSettings({ element, patch }: { element: MapElement; patch: (c: Partial<MapElement>) => void }) {
  const t = useT();
  const poly = element.type === 'polygon' ? element as PolygonElement : null;
  const current: ShapeStyle =
    (element.type === 'arrow' && (element as ArrowElement).arrowType === 'swallowtail') ? 'swallowtail'
    : element.type === 'double_arrow' ? 'pincer'
    : element.type === 'encirclement' ? 'encirclement'
    : element.type === 'gathering' ? 'gathering'
    : poly?.shapeKind === 'rect' ? 'rect'
    : poly?.shapeKind === 'circle' ? 'circle'
    : 'poly';
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

  const setStyle = (s: ShapeStyle) => {
    const fill = element.type === 'polygon'
      ? element.fillColor
      : ((element as any).fillColor || (element as any).color || '#E23B3B');
    if (s === 'poly') {
      const rings: [number, number][][] = element.type === 'encirclement' || element.type === 'gathering'
        ? [circleRing(element.center, element.radius)]
        : (element as PolygonElement).coordinates;
      patch({
        type: 'polygon', coordinates: rings, shapeKind: 'poly', circleMeta: undefined, rectMeta: undefined,
        fillColor: fill,
        fillOpacity: element.type === 'polygon' ? element.fillOpacity : 0.25,
        strokeColor: element.type === 'polygon' ? element.strokeColor : fill, strokeWidth: 2,
      } as Partial<MapElement>);
    } else if (s === 'rect') {
      const bb = bboxOf(ring);
      patch({
        type: 'polygon', coordinates: [rectRing(bb.c1, bb.c2)], shapeKind: 'rect',
        circleMeta: undefined, rectMeta: bb,
        fillColor: fill, fillOpacity: 0.25, strokeColor: fill, strokeWidth: 2,
      } as Partial<MapElement>);
    } else if (s === 'circle') {
      const center = centroid(); const radius = radiusKm();
      patch({
        type: 'polygon', coordinates: [circleRing(center, radius)], shapeKind: 'circle',
        circleMeta: { center, radius }, rectMeta: undefined,
        fillColor: fill, fillOpacity: 0.25, strokeColor: fill, strokeWidth: 2,
      } as Partial<MapElement>);
    } else if (s === 'swallowtail') {
      const pts = ring && ring.length >= 2 ? ring : [[104, 35], [105, 36]];
      patch({
        type: 'arrow', from: pts[0], to: pts[pts.length - 1], path: pts,
        arrowType: 'swallowtail', width: 15, color: fill,
        progress: [{ frame: element.startFrame, value: 1 }], drawZoom: undefined,
      } as Partial<MapElement>);
    } else if (s === 'pincer') {
      const pts = ring && ring.length >= 2 ? ring : ([[104, 35], [105, 36]] as [number, number][]);
      const pad4 = (c: [number, number][]) => {
        const out = [...c];
        let last = out[out.length - 1];
        while (out.length < 4) { last = [last[0] + 0.5, last[1] + 0.5]; out.push(last); }
        return out.slice(0, 4);
      };
      patch({
        type: 'double_arrow', points: pad4(pts), color: fill,
        progress: [{ frame: element.startFrame, value: 1 }],
      } as Partial<MapElement>);
    } else if (s === 'encirclement') {
      patch({
        type: 'encirclement', center: centroid(), radius: radiusKm(),
        fillColor: fill, strokeColor: fill,
      } as Partial<MapElement>);
    } else {
      patch({ type: 'gathering', center: centroid(), radius: radiusKm(), color: fill, pulseAnimation: true } as Partial<MapElement>);
    }
  };

  return (
    <>
      <Section title={t('形状类型', 'Shape Type')}>
        <StyleGrid<ShapeStyle>
          value={current}
          options={[
            { value: 'poly', label: '⬛ 多边形' },
            { value: 'rect', label: '▭ 矩形' },
            { value: 'circle', label: '◯ 圆' },
            { value: 'encirclement', label: '⭕ 包围圈' },
            { value: 'gathering', label: '⚔️ 集结点' },
            { value: 'swallowtail', label: '➡ 燕尾' },
            { value: 'pincer', label: '🩹 钳形' },
          ]}
          onChange={setStyle}
        />
        <p className="text-[11px] text-muted-foreground mt-1.5">
          Region 添加的国界面即「多边形」，可在此互转矩形/圆/包围圈等
        </p>
      </Section>

      {poly?.shapeKind === 'circle' && poly.circleMeta && (
        <Section title={t('圆参数', 'Circle')}>
          <div className="grid grid-cols-2 gap-2">
            <Field label="中心经度">
              <input type="number" step="0.00001" className="input" value={Number(poly.circleMeta.center[0]).toFixed(5)}
                onChange={(e) => {
                  const c: [number, number] = [parseFloat(e.target.value) || 0, poly.circleMeta!.center[1]];
                  patch({ circleMeta: { ...poly.circleMeta!, center: c }, coordinates: [circleRing(c, poly.circleMeta!.radius)] });
                }} />
            </Field>
            <Field label="中心纬度">
              <input type="number" step="0.00001" className="input" value={Number(poly.circleMeta.center[1]).toFixed(5)}
                onChange={(e) => {
                  const c: [number, number] = [poly.circleMeta!.center[0], parseFloat(e.target.value) || 0];
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
        </Section>
      )}

      {poly?.shapeKind === 'rect' && poly.rectMeta && (
        <Section title={t('矩形对角点', 'Rectangle Corners')}>
          <div className="grid grid-cols-2 gap-2">
            <Field label="角1 经度">
              <input type="number" step="0.00001" className="input" value={Number(poly.rectMeta.c1[0]).toFixed(5)}
                onChange={(e) => {
                  const c1: [number, number] = [parseFloat(e.target.value) || 0, poly.rectMeta!.c1[1]];
                  patch({ rectMeta: { ...poly.rectMeta!, c1 }, coordinates: [rectRing(c1, poly.rectMeta!.c2)] });
                }} />
            </Field>
            <Field label="角1 纬度">
              <input type="number" step="0.00001" className="input" value={Number(poly.rectMeta.c1[1]).toFixed(5)}
                onChange={(e) => {
                  const c1: [number, number] = [poly.rectMeta!.c1[0], parseFloat(e.target.value) || 0];
                  patch({ rectMeta: { ...poly.rectMeta!, c1 }, coordinates: [rectRing(c1, poly.rectMeta!.c2)] });
                }} />
            </Field>
            <Field label="角2 经度">
              <input type="number" step="0.00001" className="input" value={Number(poly.rectMeta.c2[0]).toFixed(5)}
                onChange={(e) => {
                  const c2: [number, number] = [parseFloat(e.target.value) || 0, poly.rectMeta!.c2[1]];
                  patch({ rectMeta: { ...poly.rectMeta!, c2 }, coordinates: [rectRing(poly.rectMeta!.c1, c2)] });
                }} />
            </Field>
            <Field label="角2 纬度">
              <input type="number" step="0.00001" className="input" value={Number(poly.rectMeta.c2[1]).toFixed(5)}
                onChange={(e) => {
                  const c2: [number, number] = [poly.rectMeta!.c2[0], parseFloat(e.target.value) || 0];
                  patch({ rectMeta: { ...poly.rectMeta!, c2 }, coordinates: [rectRing(poly.rectMeta!.c1, c2)] });
                }} />
            </Field>
          </div>
        </Section>
      )}

      {element.type === 'polygon' && (
        <>
          <Section title="FILL / STROKE">
            <div className="grid grid-cols-2 gap-2">
              <Field label="填充颜色">
                <ColorPicker value={element.fillColor} onChange={(c) => patch({ fillColor: c })} />
              </Field>
              <Field label="填充透明度">
                <input type="range" min="0" max="1" step="0.05" value={element.fillOpacity}
                  onChange={(e) => patch({ fillOpacity: parseFloat(e.target.value) })} className="w-full" />
              </Field>
              <Field label="边框颜色">
                <ColorPicker value={element.strokeColor} onChange={(c) => patch({ strokeColor: c })} />
              </Field>
              <Field label="边框宽度">
                <input type="number" min="1" max="10" className="input" value={element.strokeWidth}
                  onChange={(e) => patch({ strokeWidth: parseInt(e.target.value) || 2 })} />
              </Field>
            </div>
          </Section>
          {(!poly || poly.shapeKind === 'poly') && (
          <Section title="VERTICES（顶点）">
            <div className="max-h-40 overflow-y-auto">
              {(ring || []).slice(0, -1).map((coord, i) => (
                <div key={i} className="flex items-center gap-1 mb-1">
                  <span className="text-xs w-6">P{i + 1}</span>
                  <input type="number" step="0.00001" className="input flex-1" value={coord[0].toFixed(5)}
                    onChange={(e) => {
                      const r = [...(ring || [])]; r[i] = [parseFloat(e.target.value) || 0, coord[1]];
                      if (i === 0) r[r.length - 1] = r[0];
                      patch({ coordinates: [r] });
                    }} />
                  <input type="number" step="0.00001" className="input flex-1" value={coord[1].toFixed(5)}
                    onChange={(e) => {
                      const r = [...(ring || [])]; r[i] = [coord[0], parseFloat(e.target.value) || 0];
                      if (i === 0) r[r.length - 1] = r[0];
                      patch({ coordinates: [r] });
                    }} />
                </div>
              ))}
            </div>
          </Section>
          )}
          <Appearance color={element.fillColor} onChange={(c) => patch({ fillColor: c })} />
        </>
      )}

      {element.type === 'encirclement' && (
        <Section title="包围圈参数">
          <div className="grid grid-cols-2 gap-2">
            <Field label="中心经度">
              <input type="number" step="0.00001" className="input" value={Number(element.center[0]).toFixed(5)}
                onChange={(e) => patch({ center: [parseFloat(e.target.value) || 0, element.center[1]] })} />
            </Field>
            <Field label="中心纬度">
              <input type="number" step="0.00001" className="input" value={Number(element.center[1]).toFixed(5)}
                onChange={(e) => patch({ center: [element.center[0], parseFloat(e.target.value) || 0] })} />
            </Field>
          </div>
          <Field label="半径 (km)">
            <input type="number" min="1" max="2000" className="input" value={element.radius}
              onChange={(e) => patch({ radius: parseFloat(e.target.value) || 50 })} />
          </Field>
          <Appearance color={element.strokeColor} onChange={(c) => patch({ strokeColor: c, fillColor: c })} />
        </Section>
      )}

      {element.type === 'gathering' && (
        <Section title="集结点参数">
          <div className="grid grid-cols-2 gap-2">
            <Field label="中心经度">
              <input type="number" step="0.00001" className="input" value={Number(element.center[0]).toFixed(5)}
                onChange={(e) => patch({ center: [parseFloat(e.target.value) || 0, element.center[1]] })} />
            </Field>
            <Field label="中心纬度">
              <input type="number" step="0.00001" className="input" value={Number(element.center[1]).toFixed(5)}
                onChange={(e) => patch({ center: [element.center[0], parseFloat(e.target.value) || 0] })} />
            </Field>
          </div>
          <Field label="半径 (km)">
            <input type="number" min="1" max="500" className="input" value={element.radius}
              onChange={(e) => patch({ radius: parseFloat(e.target.value) || 30 })} />
          </Field>
          <Toggle checked={!!element.pulseAnimation} label="脉冲动画" onChange={(v) => patch({ pulseAnimation: v })} />
          <Appearance color={element.color} onChange={(c) => patch({ color: c })} />
        </Section>
      )}
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
          <input type="number" step="0.00001" className="input" value={Number(el.coordinates[0]).toFixed(5)}
            onChange={(e) => patch({ coordinates: [parseFloat(e.target.value) || 0, el.coordinates[1]] })} />
        </Field>
        <Field label={t('纬度', 'Latitude')}>
          <input type="number" step="0.00001" className="input" value={Number(el.coordinates[1]).toFixed(5)}
            onChange={(e) => patch({ coordinates: [el.coordinates[0], parseFloat(e.target.value) || 0] })} />
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
