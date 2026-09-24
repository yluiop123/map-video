/**
 * 特效窗口面板主体：天气 / 画面 / 弹窗 / 字幕 / 音乐 五个标签。
 * FxDialog（弹窗）使用本组件。
 */
import { useState, useEffect, useRef } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useEditorStore, type FxTab } from '../stores/editorStore';
import { useT, Section, Field, OptionBlocks, Toggle, ColorPicker, NumberInput } from './ui/primitives';
import { FrameTimeField } from './FrameTimeField';
import {
  generateId, POS_BASE,
  defaultPersonContent, normalizePersonContent, PERSON_PRESETS, PERSON_STYLE_DEFAULTS,
  type MapVideoProject, type ScreenFxItem, type WeatherType, type ScreenFxType,
  type OverlayItem, type OverlayType, type OverlayBlock, type ChartType,
  type OverlayPosition, type AnimationPreset,
  type PersonContent, type PersonStyle,
  type MusicTrack,
} from '../types';
import { readAudioFile } from '../lib/providers';
import { ImageGenerateField } from './ImageGenerateField';
import { projectContentEndFrame } from '../lib/project-duration';

const FPS_FALLBACK = 30;

function useChapterFps(_project?: MapVideoProject): number {
  const project = useProjectStore((s) => s.project);
  return project?.globalConfig.defaultFPS ?? FPS_FALLBACK;
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** 读取音频真实时长（秒）；失败/超时返回 null */
function probeAudioDuration(url: string, timeoutMs = 5000): Promise<number | null> {
  return new Promise((resolve) => {
    const el = new Audio();
    el.preload = 'metadata';
    let settled = false;
    const finish = (v: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.onloadedmetadata = null;
      el.onerror = null;
      el.removeAttribute('src');
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    el.onloadedmetadata = () => {
      const d = el.duration;
      finish(Number.isFinite(d) && d > 0 ? d : null);
    };
    el.onerror = () => finish(null);
    el.src = url;
  });
}

function UploadButton({ label, accept, onPick }: { label: string; accept: string; onPick: (dataUrl: string) => void }) {
  const t = useT();
  return (
    <label className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border bg-white/[0.045] text-xs text-foreground/80 hover:border-white/25 cursor-pointer transition-colors w-fit">
      ⬆ {label}
      <input
        type="file"
        accept={accept}
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) onPick(await fileToDataUrl(f));
          e.target.value = '';
        }}
      />
      <span className="sr-only">{t('上传', 'Upload')}</span>
    </label>
  );
}

function FxTimeRow({ fx, fps }: { fx: ScreenFxItem; fps: number }) {
  const t = useT();
  const updateScreenFx = useProjectStore((s) => s.updateScreenFx);
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted-foreground shrink-0">{t('时间', 'Time')}</span>
      <div className="w-24"><FrameTimeField value={fx.startFrame} fps={fps} onFrameChange={(f) => updateScreenFx(fx.id, { startFrame: Math.max(0, Math.min(Math.round(f), fx.endFrame - 1)) })} /></div>
      <span className="text-muted-foreground">→</span>
      <div className="w-24"><FrameTimeField value={fx.endFrame} fps={fps} onFrameChange={(f) => updateScreenFx(fx.id, { endFrame: Math.max(fx.startFrame + 1, Math.round(f)) })} /></div>
    </div>
  );
}

function IntensityRow({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted-foreground w-8 shrink-0">{label}</span>
      <input type="range" min={0} max={1} step={0.05} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} className="flex-1 h-1 accent-[var(--brand)]" />
      <span className="text-[11px] text-muted-foreground w-8 text-right tabular-nums">{Math.round(value * 100)}%</span>
    </div>
  );
}

/** 通用数值滑杆行（字号/粗细等）：一行 = 标签 + 滑杆 + 数值 */
function SliderRow({ label, value, min, max, step, onChange, display }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; display: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted-foreground w-8 shrink-0">{label}</span>
      <input type="range" min={min} max={max} step={step ?? 1} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} className="flex-1 h-1 accent-[var(--brand)]" />
      <span className="text-[11px] text-muted-foreground w-9 text-right tabular-nums">{display}</span>
    </div>
  );
}

// ========== 天气 ==========

/** 天气/画面/弹窗元数据表（TimelineEditor 特效轨道块复用图标与名称） */
export const WEATHERS: { type: WeatherType; label: string; icon: string }[] = [
  { type: 'rain', label: '雨', icon: '🌧' },
  { type: 'snow', label: '雪', icon: '❄️' },
  { type: 'lightning', label: '雷电', icon: '⚡' },
  { type: 'fog', label: '雾', icon: '🌫' },
];

function WeatherTab({ project }: { project: MapVideoProject }) {
  const t = useT();
  const fps = useChapterFps(project);
  const addScreenFx = useProjectStore((s) => s.addScreenFx);
  const updateScreenFx = useProjectStore((s) => s.updateScreenFx);
  const removeScreenFx = useProjectStore((s) => s.removeScreenFx);
  const currentFrame = useEditorStore((s) => s.currentFrame);
  const fxSelId = useEditorStore((s) => s.fxSelId);
  const setFxSelId = useEditorStore((s) => s.setFxSelId);
  const list = (project.fx || []).filter((f) => f.kind === 'weather');
  const sel = list.find((f) => f.id === fxSelId) || list[0] || null;
  const idx = sel ? list.indexOf(sel) : -1;

  const add = (w: WeatherType) => {
    const info = WEATHERS.find((x) => x.type === w)!;
    if (sel) {
      // 已有天气：原地切换类型，不新增条目
      if (sel.weather?.type === w) return;
      updateScreenFx(sel.id, {
        name: info.label,
        weather: { type: w, intensity: sel.weather?.intensity ?? 0.6, wind: sel.weather?.wind ?? 0.15 },
      });
      setFxSelId(sel.id);
      return;
    }
    const fx: ScreenFxItem = {
      id: generateId(), kind: 'weather', name: `${info.label}`,
      startFrame: Math.max(0, currentFrame), endFrame: Math.max(0, currentFrame) + Math.max(1, Math.round(DEFAULT_FX_SEC * fps)),
      weather: { type: w, intensity: 0.6, wind: 0.15 }, enabled: true,
    };
    addScreenFx(fx);
    setFxSelId(fx.id);
  };
  const remove = () => {
    if (!sel) return;
    removeScreenFx(sel.id);
    const rest = list.filter((f) => f.id !== sel.id);
    setFxSelId(rest.length ? rest[Math.min(idx, rest.length - 1)].id : null);
  };

  return (
    <div className="space-y-3">
      <Section title={t('添加天气', 'Add weather')}>
        <div className="flex flex-wrap gap-1.5">
          {WEATHERS.map((w) => (
            <button
              key={w.type}
              onClick={() => add(w.type)}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                sel?.weather?.type === w.type
                  ? 'bg-brand/25 border-brand text-foreground'
                  : 'bg-white/[0.03] border-white/10 text-foreground/80 hover:bg-white/[0.07] hover:border-white/20'
              }`}
            >
              {w.icon} {w.label}
            </button>
          ))}
        </div>
      </Section>
      {sel ? (
        <div className="space-y-2.5">
          <FxTimeRow fx={sel} fps={fps} />
          <IntensityRow label={t('强度', 'Level')} value={sel.weather?.intensity ?? 0.6} onChange={(v) => updateScreenFx(sel.id, { weather: { ...(sel.weather || { type: 'rain', wind: 0 }), intensity: v, type: sel.weather?.type || 'rain' } })} />
          {sel.weather?.type !== 'fog' && sel.weather?.type !== 'lightning' && (
            <IntensityRow label={t('风向', 'Wind')} value={sel.weather?.wind ?? 0} onChange={(v) => updateScreenFx(sel.id, { weather: { ...(sel.weather || { type: 'rain', intensity: 0.6 }), wind: Math.max(-1, Math.min(1, v)), type: sel.weather?.type || 'rain' } })} />
          )}
          <button onClick={remove} className="w-full h-8 rounded-md border border-red-500/30 text-red-400/90 hover:bg-red-500/10 text-xs transition-colors">
            {t('删除该天气', 'Delete weather')}
          </button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground text-center py-4">{t('暂无天气，在上方添加', 'No weather yet — add above')}</p>
      )}
    </div>
  );
}

// ========== 画面特效（screen fx） ==========

export const SCREEN_FXS: { type: ScreenFxType; label: string; icon: string }[] = [
  { type: 'shake', label: '震动', icon: '💥' },
  { type: 'flash', label: '闪光', icon: '✨' },
  { type: 'vignette', label: '暗角', icon: '🌑' },
  { type: 'cloudReveal', label: '云层散开', icon: '☁️' },
  { type: 'fadeBlack', label: '黑场淡入', icon: '⬛' },
  { type: 'fadeWhite', label: '白场淡入', icon: '⬜' },
];

/** 新增天气 / 画面特效 / 弹窗的默认时长（秒） */
const DEFAULT_FX_SEC = 3;

function ScreenTab({ project }: { project: MapVideoProject }) {
  const t = useT();
  const fps = useChapterFps(project);
  const addScreenFx = useProjectStore((s) => s.addScreenFx);
  const updateScreenFx = useProjectStore((s) => s.updateScreenFx);
  const removeScreenFx = useProjectStore((s) => s.removeScreenFx);
  const currentFrame = useEditorStore((s) => s.currentFrame);
  const fxSelId = useEditorStore((s) => s.fxSelId);
  const setFxSelId = useEditorStore((s) => s.setFxSelId);
  const list = (project.fx || []).filter((f) => f.kind === 'screen');
  const sel = list.find((f) => f.id === fxSelId) || list[0] || null;
  const idx = sel ? list.indexOf(sel) : -1;

  const add = (type: ScreenFxType) => {
    const info = SCREEN_FXS.find((x) => x.type === type)!;
    const start = Math.max(0, currentFrame);
    const fx: ScreenFxItem = {
      id: generateId(), kind: 'screen', name: info.label,
      startFrame: start, endFrame: start + Math.max(1, Math.round(DEFAULT_FX_SEC * fps)),
      effect: {
        type, intensity: type === 'shake' ? 0.5 : 0.6,
        color: type === 'fadeBlack' ? '#000000' : '#FFFFFF',
      },
      enabled: true,
    };
    addScreenFx(fx);
    setFxSelId(fx.id);
  };
  const remove = () => {
    if (!sel) return;
    removeScreenFx(sel.id);
    const rest = list.filter((f) => f.id !== sel.id);
    setFxSelId(rest.length ? rest[Math.min(idx, rest.length - 1)].id : null);
  };

  return (
    <div className="space-y-3">
      <Section title={t('添加画面特效', 'Add screen effect')}>
        <div className="flex flex-wrap gap-1.5">
          {SCREEN_FXS.map((s) => (
            <button
              key={s.type}
              onClick={() => add(s.type)}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                sel?.effect?.type === s.type
                  ? 'bg-brand/25 border-brand text-foreground'
                  : 'bg-white/[0.03] border-white/10 text-foreground/80 hover:bg-white/[0.07] hover:border-white/20'
              }`}
            >
              {s.icon} {s.label}
            </button>
          ))}
        </div>
      </Section>
      {sel ? (
        <div className="space-y-2.5">
          <FxTimeRow fx={sel} fps={fps} />
          <IntensityRow label={t('强度', 'Level')} value={sel.effect?.intensity ?? 0.6} onChange={(v) => updateScreenFx(sel.id, { effect: { ...(sel.effect || { type: 'shake' }), intensity: v, type: sel.effect?.type || 'shake' } })} />
          {(sel.effect?.type === 'flash' || sel.effect?.type === 'fadeWhite') && (
            <Field label={t('闪光/遮罩颜色', 'Color')}>
              <ColorPicker value={sel.effect?.color || '#FFFFFF'} onChange={(c) => updateScreenFx(sel.id, { effect: { ...(sel.effect || { type: 'flash', intensity: 0.6 }), color: c, type: sel.effect?.type || 'flash' } })} />
            </Field>
          )}
          <button onClick={remove} className="w-full h-8 rounded-md border border-red-500/30 text-red-400/90 hover:bg-red-500/10 text-xs transition-colors">
            {t('删除该特效', 'Delete effect')}
          </button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground text-center py-4">{t('暂无画面特效，在上方添加', 'No screen effects yet — add above')}</p>
      )}
    </div>
  );
}

// ========== 弹窗卡片 ==========

export const POPUP_TYPES: { type: OverlayType; label: string; icon: string }[] = [
  { type: 'chart', label: '图表', icon: '📊' },
  { type: 'person', label: '人物', icon: '👤' },
  { type: 'timeline', label: '时间线', icon: '🕒' },
  { type: 'quote', label: '引用', icon: '❝' },
  { type: 'compare', label: '对比', icon: '⚖️' },
  { type: 'stat', label: '数字', icon: '🔢' },
];

const POS_GRID: { value: OverlayPosition; label: string }[] = [
  { value: 'topLeft', label: '↖' }, { value: 'top', label: '↑' }, { value: 'topRight', label: '↗' },
  { value: 'left', label: '←' }, { value: 'center', label: '◉' }, { value: 'right', label: '→' },
  { value: 'bottomLeft', label: '↙' }, { value: 'bottom', label: '↓' }, { value: 'bottomRight', label: '↘' },
];

const ANIM_IN: { value: AnimationPreset; label: string }[] = [
  { value: 'fadeIn', label: '淡入' }, { value: 'popIn', label: '弹入' }, { value: 'scaleIn', label: '缩放' },
  { value: 'slideInLeft', label: '左滑' }, { value: 'slideInRight', label: '右滑' },
  { value: 'slideInTop', label: '上滑' }, { value: 'slideInBottom', label: '下滑' },
];
const ANIM_OUT: { value: AnimationPreset; label: string }[] = [
  { value: 'fadeOut', label: '淡出' }, { value: 'popOut', label: '弹出' }, { value: 'scaleOut', label: '缩放' },
  { value: 'slideInLeft', label: '左出' }, { value: 'slideInRight', label: '右出' },
  { value: 'slideInTop', label: '上出' }, { value: 'slideInBottom', label: '下出' },
];

function createPopupContent(type: OverlayType): OverlayItem['content'] {
  switch (type) {
    case 'custom':
      return {
        type,
        custom: {
          blocks: [{ id: generateId(), type: 'text', text: { content: '文字内容', fontSize: 16, color: '#FFFFFF', align: 'left' } }],
        },
      };
    case 'person':
      return { type, person: defaultPersonContent() };
    case 'timeline':
      return {
        type,
        timeline: {
          title: '战役进程',
          items: [{ time: '3月5日', text: '渡江集结' }, { time: '3月8日', text: '总攻发起' }],
        },
      };
    case 'quote':
      return { type, quote: { text: '兵者，国之大事，死生之地，存亡之道，不可不察也。', source: '《孙子兵法·始计》' } };
    case 'compare':
      return {
        type,
        compare: { title: '双方对比', left: { label: '我方', value: 80000 }, right: { label: '敌方', value: 52000 }, unit: '人' },
      };
    case 'chart':
      return { type, chart: { type: 'bar', title: '图表', data: [{ label: '兵力', value: 5000 }, { label: '装备', value: 1200 }] } };
    case 'stat':
      return { type, stat: { value: 221, label: '公元前', unit: '年', countUp: true } };
    default:
      return { type };
  }
}

function PopupTab({ project }: { project: MapVideoProject }) {
  const t = useT();
  const fps = useChapterFps(project);
  const addOverlay = useProjectStore((s) => s.addOverlay);
  const deleteOverlay = useProjectStore((s) => s.deleteOverlay);
  const currentFrame = useEditorStore((s) => s.currentFrame);
  const fxSelId = useEditorStore((s) => s.fxSelId);
  const setFxSelId = useEditorStore((s) => s.setFxSelId);
  const list = project.overlays || [];
  const sel = list.find((o) => o.id === fxSelId) || list[0] || null;
  const idx = sel ? list.indexOf(sel) : -1;

  const add = (type: OverlayType) => {
    const info = POPUP_TYPES.find((x) => x.type === type)!;
    const start = Math.max(0, currentFrame);
    const overlay: OverlayItem = {
      id: generateId(), type, name: info.label,
      position: type === 'quote' ? 'top' : 'bottomLeft',
      content: createPopupContent(type),
      startFrame: start,
      endFrame: start + Math.max(1, Math.round(DEFAULT_FX_SEC * fps)),
      animation: 'fadeIn', exitAnimation: 'fadeOut',
      scale: 1,
    };
    addOverlay(overlay);
    setFxSelId(overlay.id);
  };
  const remove = () => {
    if (!sel) return;
    deleteOverlay(sel.id);
    const rest = list.filter((o) => o.id !== sel.id);
    setFxSelId(rest.length ? rest[Math.min(idx, rest.length - 1)].id : null);
  };

  return (
    <div className="space-y-3">
      <Section title={t('添加弹窗卡片', 'Add popup')}>
        <div className="flex flex-wrap gap-1.5">
          {POPUP_TYPES.map((x) => (
            <button
              key={x.type}
              onClick={() => add(x.type)}
              className="px-2.5 py-1.5 text-xs font-medium rounded-md border bg-white/[0.03] border-white/10 text-foreground/80 hover:bg-white/[0.07] hover:border-white/20 transition-colors"
            >
              {x.icon} {x.label}
            </button>
          ))}
        </div>
      </Section>
      {sel ? (
        <div className="space-y-2.5">
          <PopupItemEditor overlay={sel} project={project} fps={fps} />
          <button onClick={remove} className="w-full h-8 rounded-md border border-red-500/30 text-red-400/90 hover:bg-red-500/10 text-xs transition-colors">
            {t('删除该弹窗', 'Delete popup')}
          </button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground text-center py-4">{t('暂无弹窗，在上方添加', 'No popups yet — add above')}</p>
      )}
    </div>
  );
}

function PopupItemEditor({ overlay: o, fps }: { overlay: OverlayItem; project: MapVideoProject; fps: number }) {
  const t = useT();
  const update = (changes: Partial<OverlayItem>) => useProjectStore.getState().updateOverlay(o.id, changes);

  return (
    <div className="space-y-2">
      <FxTimeLikeRow fps={fps} label={t('时间', 'Time')}
        start={o.startFrame} end={o.endFrame}
        onStart={(f) => update({ startFrame: Math.max(0, Math.min(Math.round(f), o.endFrame - 1)) })}
        onEnd={(f) => update({ endFrame: Math.max(o.startFrame + 1, Math.round(f)) })} />

      <Field label={t('位置（九宫格）', 'Position')}>
        <div className="grid grid-cols-3 gap-1 w-fit">
          {POS_GRID.map((p) => (
            <button
              key={p.value}
              onClick={() => update({ position: p.value, offsetX: 0, offsetY: 0 })}
              title={p.label}
              className={`w-8 h-7 rounded-md border text-xs transition-colors ${
                o.position === p.value && !o.offsetX && !o.offsetY
                  ? 'bg-brand/20 border-brand text-foreground'
                  : 'bg-white/[0.03] border-white/10 text-muted-foreground hover:bg-white/[0.07]'
              }`}
            >{p.label}</button>
          ))}
        </div>
      </Field>
      <PopupOffsetSliders o={o} update={update} t={t} />

      <Field label={t('入场动画', 'Enter anim')}>
        <OptionBlocks<AnimationPreset> value={o.animation || 'fadeIn'} options={ANIM_IN} onChange={(v) => update({ animation: v })} />
      </Field>
      <Field label={t('退场动画', 'Exit anim')}>
        <OptionBlocks<AnimationPreset> value={o.exitAnimation || 'fadeOut'} options={ANIM_OUT} onChange={(v) => update({ exitAnimation: v })} />
      </Field>
      <Section title={t('背景样式', 'Background')}>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground shrink-0">{t('背景色', 'BG')}</span>
          <div className="w-32"><ColorPicker value={(o.bg || { color: '#0c0a09' }).color} onChange={(c) => update({ bg: { ...(o.bg || { opacity: 0.78, blur: 10, radius: 14 }), color: c } })} /></div>
        </div>
        <SliderRow label={t('不透明度', 'Opacity')} min={0} max={1} step={0.05} value={o.bg?.opacity ?? 0.78} onChange={(v) => update({ bg: { ...(o.bg || { color: '#0c0a09', blur: 10, radius: 14 }), opacity: v } })} display={`${Math.round((o.bg?.opacity ?? 0.78) * 100)}%`} />
        <SliderRow label={t('圆角', 'Radius')} min={0} max={30} step={2} value={o.bg?.radius ?? 14} onChange={(v) => update({ bg: { ...(o.bg || { color: '#0c0a09', opacity: 0.78, blur: 10 }), radius: Math.max(0, v) } })} display={`${Math.round(o.bg?.radius ?? 14)}px`} />
        <SliderRow label={t('毛玻璃', 'Blur')} min={0} max={30} step={1} value={o.bg?.blur ?? 10} onChange={(v) => update({ bg: { ...(o.bg || { color: '#0c0a09', opacity: 0.78, radius: 14 }), blur: v } })} display={`${Math.round(o.bg?.blur ?? 10)}`} />
      </Section>

      <Section title={t('内容', 'Content')}>
        <PopupContentEditor overlay={o} onContent={(c) => update({ content: c })} />
      </Section>
    </div>
  );
}

function FxTimeLikeRow({ fps, label, start, end, onStart, onEnd }: {
  fps: number; label: string; start: number; end: number; onStart: (f: number) => void; onEnd: (f: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted-foreground shrink-0">{label}</span>
      <div className="w-24"><FrameTimeField value={start} fps={fps} onFrameChange={onStart} /></div>
      <span className="text-muted-foreground">→</span>
      <div className="w-24"><FrameTimeField value={end} fps={fps} onFrameChange={onEnd} /></div>
    </div>
  );
}

/** 位置微调滑杆：显示值=九宫格标准位(POS_BASE)+微调量，写入的是相对标准位的 delta。
 *  range = 微调可达的最大正负值（弹窗卡默认 40）。 */
function PopupOffsetSliders({ o, update, t, range = 40 }: {
  o: OverlayItem;
  update: (changes: Partial<OverlayItem>) => void;
  t: (zh: string, en: string) => string;
  range?: number;
}) {
  const base = POS_BASE[o.position] ?? [0, 0];
  const hx = base[0] + (o.offsetX ?? 0);
  const vy = base[1] + (o.offsetY ?? 0);
  return (
    <>
      <SliderRow label={t('横向微调', 'H-Offset')} min={-range} max={range} value={hx}
        onChange={(v) => update({ offsetX: v - base[0] })} display={`${Math.round(hx)}%`} />
      <SliderRow label={t('纵向微调', 'V-Offset')} min={-range} max={range} value={vy}
        onChange={(v) => update({ offsetY: v - base[1] })} display={`${Math.round(vy)}%`} />
    </>
  );
}

function PopupContentEditor({ overlay: o, onContent }: { overlay: OverlayItem; onContent: (c: OverlayItem['content']) => void }) {
  const t = useT();
  const c = o.content;
  switch (o.type) {
    case 'custom': {
      const cust = c.custom || { blocks: [] };
      const blocks = cust.blocks || [];
      const setBlocks = (bs: OverlayBlock[]) => onContent({ ...c, custom: { ...cust, blocks: bs } });
      const upd = (i: number, patch: Partial<OverlayBlock>) => setBlocks(blocks.map((b, j) => (j === i ? { ...b, ...patch } as OverlayBlock : b)));
      const del = (i: number) => setBlocks(blocks.filter((_, j) => j !== i));
      const move = (i: number, d: number) => {
        const j = i + d;
        if (j < 0 || j >= blocks.length) return;
        const bs = [...blocks];
        [bs[i], bs[j]] = [bs[j], bs[i]];
        setBlocks(bs);
      };
      const add = (bt: 'text' | 'image' | 'video') => setBlocks([
        ...blocks,
        bt === 'text'
          ? { id: generateId(), type: 'text', text: { content: '文字内容', fontSize: 16, color: '#FFFFFF', align: 'left' as const } }
          : { id: generateId(), type: bt, url: '' },
      ]);
      const mini = 'w-6 h-6 rounded border border-white/10 bg-white/[0.03] text-muted-foreground hover:text-foreground hover:bg-white/[0.07] text-[11px] transition-colors';
      return (
        <div className="space-y-2">
          {blocks.map((b, i) => (
            <div key={b.id} className="rounded-md border border-white/10 bg-white/[0.03] p-2 space-y-1.5">
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-muted-foreground flex-1">
                  {b.type === 'text' ? '📝 文字' : b.type === 'image' ? '🖼️ 图片' : '🎬 视频'} {i + 1}
                </span>
                <button className={mini} onClick={() => move(i, -1)} disabled={i === 0} title={t('上移', 'Up')}>↑</button>
                <button className={mini} onClick={() => move(i, 1)} disabled={i === blocks.length - 1} title={t('下移', 'Down')}>↓</button>
                <button className={mini} onClick={() => del(i)} title={t('删除', 'Delete')}>✕</button>
              </div>
              {b.type === 'text' && (
                <>
                  <textarea
                    value={b.text?.content || ''}
                    onChange={(e) => upd(i, { text: { ...(b.text || { fontSize: 16, color: '#FFFFFF' }), content: e.target.value } })}
                    className="input h-14 resize-none text-xs"
                  />
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <NumberInput className="input h-7 w-14 text-xs" value={b.text?.fontSize ?? 16} onCommit={(v) => upd(i, { text: { ...(b.text || { content: '', color: '#FFFFFF' }), fontSize: Math.max(10, v) } })} title={t('字号', 'Size')} />
                    <div className="w-20"><ColorPicker value={b.text?.color || '#FFFFFF'} onChange={(col) => upd(i, { text: { ...(b.text || { content: '', fontSize: 16 }), color: col } })} /></div>
                    <Toggle checked={!!b.text?.bold} onChange={(v) => upd(i, { text: { ...(b.text || { content: '', fontSize: 16, color: '#FFFFFF' }), bold: v } })} label={t('粗', 'B')} />
                    <OptionBlocks<'left' | 'center' | 'right'>
                      value={b.text?.align || 'left'}
                      options={[{ value: 'left', label: t('左', 'L') }, { value: 'center', label: t('中', 'C') }, { value: 'right', label: t('右', 'R') }]}
                      onChange={(v) => upd(i, { text: { ...(b.text || { content: '', fontSize: 16, color: '#FFFFFF' }), align: v } })}
                    />
                  </div>
                </>
              )}
              {b.type === 'image' && (
                <>
                  <UploadButton label={t('上传图片', 'Upload')} accept="image/*" onPick={(u) => upd(i, { url: u })} />
                  <input value={b.url?.startsWith('data:') ? '' : b.url || ''} onChange={(e) => upd(i, { url: e.target.value })} className="input h-7 text-xs" placeholder={t('或图片URL', 'or image URL')} />
                  {b.url && <img src={b.url} className="max-h-20 rounded border border-white/15" alt="" />}
                </>
              )}
              {b.type === 'video' && (
                <input value={b.url || ''} onChange={(e) => upd(i, { url: e.target.value })} className="input h-7 text-xs" placeholder={t('视频URL', 'Video URL')} />
              )}
            </div>
          ))}
          <div className="flex gap-1.5">
            <button onClick={() => add('text')} className="flex-1 h-7 rounded-md border border-white/10 bg-white/[0.03] hover:bg-white/[0.07] text-xs text-foreground/80 transition-colors">+ {t('文字', 'Text')}</button>
            <button onClick={() => add('image')} className="flex-1 h-7 rounded-md border border-white/10 bg-white/[0.03] hover:bg-white/[0.07] text-xs text-foreground/80 transition-colors">+ {t('图片', 'Image')}</button>
            <button onClick={() => add('video')} className="flex-1 h-7 rounded-md border border-white/10 bg-white/[0.03] hover:bg-white/[0.07] text-xs text-foreground/80 transition-colors">+ {t('视频', 'Video')}</button>
          </div>
          <div className="flex items-center gap-2 pt-1 border-t border-white/5">
            <span className="text-[11px] text-muted-foreground shrink-0">🎙️ {t('背景语音', 'Voiceover')}</span>
            <UploadButton
              label={cust.audio?.url ? t('更换', 'Change') : t('上传', 'Upload')}
              accept="audio/*"
              onPick={(u) => onContent({ ...c, custom: { ...cust, blocks, audio: { url: u, title: cust.audio?.title || t('背景语音', 'Voiceover') } } })}
            />
            {cust.audio?.url && (
              <>
                <span className="text-[11px] text-muted-foreground truncate max-w-[90px]">{cust.audio.url.startsWith('data:') ? t('已上传', 'attached') : cust.audio.url}</span>
                <button className={mini} onClick={() => onContent({ ...c, custom: { ...cust, blocks, audio: undefined } })} title={t('移除语音', 'Remove')}>✕</button>
              </>
            )}
          </div>
        </div>
      );
    }
    case 'person': {
      const pc = normalizePersonContent(c.person);
      const setP = (next: Partial<PersonContent>) => onContent({ ...c, person: { ...pc, ...next } });
      const applyStyle = (style: PersonStyle) => setP({ style, ...PERSON_STYLE_DEFAULTS[style] });
      const rowMini = 'px-1.5 h-7 text-xs rounded-md border bg-white/[0.03] border-white/10 text-muted-foreground hover:bg-white/[0.07] transition-colors';
      return (
        <div className="space-y-2">
          <Field label={t('样式', 'Style')}>
            <OptionBlocks<PersonStyle>
              value={pc.style}
              options={PERSON_PRESETS.map((x) => ({ value: x.id, label: t(x.zh, x.en) }))}
              onChange={applyStyle}
            />
          </Field>
          <Toggle checked={pc.showImage} onChange={(v) => setP({ showImage: v })} label={t('显示照片', 'Show photo')} />
          {pc.showImage && (
            <>
              <div className="flex items-center gap-2">
                <UploadButton label={t('上传照片', 'Photo')} accept="image/*" onPick={(url) => setP({ imageUrl: url })} />
                {pc.imageUrl && <img src={pc.imageUrl} className="w-8 h-8 rounded object-cover border border-white/15" alt="" />}
                {pc.imageUrl && (
                  <button className={rowMini} onClick={() => setP({ imageUrl: undefined })} title={t('移除', 'Remove')}>✕</button>
                )}
              </div>
              <ImageGenerateField onPick={(url) => setP({ imageUrl: url })} />
              <Field label={t('形状', 'Shape')}>
                <OptionBlocks<PersonContent['imageShape']>
                  value={pc.imageShape}
                  options={[{ value: 'square', label: t('方形', 'Square') }, { value: 'circle', label: t('圆形', 'Circle') }]}
                  onChange={(v) => setP({ imageShape: v })}
                />
              </Field>
              {pc.style === 'profile' && (
                <Field label={t('照片方位', 'Side')}>
                  <OptionBlocks<PersonContent['imageSide']>
                    value={pc.imageSide}
                    options={[{ value: 'left', label: t('左', 'L') }, { value: 'right', label: t('右', 'R') }]}
                    onChange={(v) => setP({ imageSide: v })}
                  />
                </Field>
              )}
            </>
          )}
          <Field label={t('姓名', 'Name')}>
            <input value={pc.name || ''} onChange={(e) => setP({ name: e.target.value })} className="input h-7 text-xs" placeholder={t('姓名', 'Name')} />
          </Field>
          <Field label={t('职务/身份', 'Title')}>
            <input value={pc.title || ''} onChange={(e) => setP({ title: e.target.value })} className="input h-7 text-xs" placeholder={t('职务 / 身份（可选）', 'Title (optional)')} />
          </Field>
          <Field label={t('简介', 'Intro')}>
            <textarea value={pc.intro || ''} onChange={(e) => setP({ intro: e.target.value })} className="input h-14 resize-none text-xs" placeholder={t('人物简介…', 'Bio…')} />
          </Field>
          <Field label={t('名言/台词', 'Quote')}>
            <textarea value={pc.quote || ''} onChange={(e) => setP({ quote: e.target.value })} className="input h-14 resize-none text-xs" placeholder={t('名言 / 台词（可选）', 'Quote (optional)')} />
          </Field>
          <Section title={t('语音（整卡一条）', 'Voice (one per card)')}>
            <div className="flex items-center gap-2">
              <UploadButton label={t('上传语音', 'Upload voice')} accept="audio/*" onPick={(u) => setP({ audioUrl: u })} />
              {pc.audioUrl && (
                <>
                  <span className="text-[11px] text-muted-foreground truncate max-w-[100px]">{pc.audioUrl.startsWith('data:') ? t('已上传', 'attached') : pc.audioUrl}</span>
                  <button className={rowMini} onClick={() => setP({ audioUrl: undefined })} title={t('移除语音', 'Remove')}>✕</button>
                </>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">{t('卡片出现后可在预览中点击播放（交互演示用）。', 'Click to play in preview (demo only).')}</p>
          </Section>
        </div>
      );
    }
    case 'timeline': {
      const tl = c.timeline || { items: [] };
      return (
        <div className="space-y-2">
          <input value={tl.title || ''} onChange={(e) => onContent({ ...c, timeline: { ...tl, title: e.target.value } })} className="input h-7 text-xs" placeholder={t('标题(可选)', 'Title (optional)')} />
          <textarea
            value={(tl.items || []).map((it) => [it.time, it.text].filter(Boolean).join('|')).join('\n')}
            onChange={(e) => onContent({
              ...c,
              timeline: {
                ...tl,
                items: e.target.value.split('\n').filter((x) => x.trim()).map((line) => {
                  const [time, text] = line.split('|');
                  return { time: (time || '').trim(), text: (text ?? time ?? '').trim() };
                }),
              },
            })}
            className="input h-20 resize-none text-xs"
            placeholder={t('每行一条：时间|事件\n如：3月5日|渡江集结', 'One per line: time|text')}
          />
        </div>
      );
    }
    case 'quote': {
      const q = c.quote || { text: '' };
      return (
        <div className="space-y-2">
          <textarea value={q.text} onChange={(e) => onContent({ ...c, quote: { ...q, text: e.target.value } })} className="input h-16 resize-none text-xs" placeholder={t('引文内容', 'Quote text')} />
          <input value={q.source || ''} onChange={(e) => onContent({ ...c, quote: { ...q, source: e.target.value } })} className="input h-7 text-xs" placeholder={t('出处（如《孙子兵法》）', 'Source')} />
        </div>
      );
    }
    case 'compare': {
      const cp = c.compare || { left: { label: '', value: 0 }, right: { label: '', value: 0 } };
      return (
        <div className="space-y-2">
          <input value={cp.title || ''} onChange={(e) => onContent({ ...c, compare: { ...cp, title: e.target.value } })} className="input h-7 text-xs" placeholder={t('标题', 'Title')} />
          <div className="flex gap-2">
            <input value={cp.left?.label || ''} onChange={(e) => onContent({ ...c, compare: { ...cp, left: { ...(cp.left || { value: 0 }), label: e.target.value } } })} className="input h-7 flex-1 text-xs" placeholder={t('左方名', 'Left')} />
            <NumberInput className="input h-7 w-20 text-xs" value={cp.left?.value ?? 0} step={100} onCommit={(v) => onContent({ ...c, compare: { ...cp, left: { ...(cp.left || { label: '' }), value: v } } })} title={t('左值', 'L value')} />
          </div>
          <div className="flex gap-2">
            <input value={cp.right?.label || ''} onChange={(e) => onContent({ ...c, compare: { ...cp, right: { ...(cp.right || { value: 0 }), label: e.target.value } } })} className="input h-7 flex-1 text-xs" placeholder={t('右方名', 'Right')} />
            <NumberInput className="input h-7 w-20 text-xs" value={cp.right?.value ?? 0} step={100} onCommit={(v) => onContent({ ...c, compare: { ...cp, right: { ...(cp.right || { label: '' }), value: v } } })} title={t('右值', 'R value')} />
          </div>
          <input value={cp.unit || ''} onChange={(e) => onContent({ ...c, compare: { ...cp, unit: e.target.value } })} className="input h-7 text-xs" placeholder={t('单位', 'Unit')} />
        </div>
      );
    }
    case 'stat': {
      const st = c.stat || { value: 0 };
      return (
        <div className="space-y-2">
          <Field label={t('数值', 'Value')}>
            <input type="number" value={st.value} onChange={(e) => onContent({ ...c, stat: { ...st, value: parseFloat(e.target.value) || 0 } })} className="input h-7 text-xs" />
          </Field>
          <Field label={t('标签', 'Label')}>
            <input value={st.label || ''} onChange={(e) => onContent({ ...c, stat: { ...st, label: e.target.value } })} className="input h-7 text-xs" placeholder={t('说明文字', 'Caption')} />
          </Field>
          <Field label={t('前缀 / 单位', 'Prefix / Unit')}>
            <div className="flex gap-2">
              <input value={st.prefix || ''} onChange={(e) => onContent({ ...c, stat: { ...st, prefix: e.target.value } })} className="input h-7 text-xs w-20" placeholder={t('前缀', 'Prefix')} />
              <input value={st.unit || ''} onChange={(e) => onContent({ ...c, stat: { ...st, unit: e.target.value } })} className="input h-7 text-xs w-20" placeholder={t('单位', 'Unit')} />
            </div>
          </Field>
          <Toggle checked={st.countUp !== false} onChange={(v) => onContent({ ...c, stat: { ...st, countUp: v } })} label={t('滚动计数', 'Count up')} />
        </div>
      );
    }
    case 'chart': {
      const ch = c.chart || { type: 'bar' as const, data: [] };
      const isVs = ch.type === 'vs';
      return (
        <div className="space-y-2">
          <OptionBlocks<ChartType>
            value={ch.type}
            onChange={(v) => onContent({ ...c, chart: { ...ch, type: v } })}
            options={[
              { value: 'bar', label: t('柱状', 'Bar') }, { value: 'hbar', label: t('横向', 'HBar') },
              { value: 'line', label: t('折线', 'Line') }, { value: 'area', label: t('面积', 'Area') },
              { value: 'pie', label: t('饼图', 'Pie') }, { value: 'donut', label: t('环形', 'Donut') },
              { value: 'radar', label: t('雷达', 'Radar') }, { value: 'gauge', label: t('仪表', 'Gauge') },
              { value: 'vs', label: t('对比', 'VS') },
            ]}
          />
          <input value={ch.title || ''} onChange={(e) => onContent({ ...c, chart: { ...ch, title: e.target.value } })} className="input h-7 text-xs" placeholder={t('图表标题', 'Chart title')} />
          <textarea
            value={(ch.data || []).map((d) => `${d.label}:${d.value}`).join('\n')}
            onChange={(e) => onContent({ ...c, chart: { ...ch, data: e.target.value.split('\n').map((r) => { const [label, value] = r.split(':'); return { label: (label || '').trim(), value: parseFloat(value) || 0 }; }).filter((d) => d.label) } })}
            className="input h-20 resize-none text-xs"
            placeholder={isVs ? t('每行：类别|我方值\n如：兵力|80000', 'label|left value') : '兵力:5000\n装备:1200'}
          />
          {isVs && (
            <textarea
              value={(ch.data2 || []).map((d) => `${d.label}:${d.value}`).join('\n')}
              onChange={(e) => onContent({ ...c, chart: { ...ch, data2: e.target.value.split('\n').map((r) => { const [label, value] = r.split(':'); return { label: (label || '').trim(), value: parseFloat(value) || 0 }; }).filter((d) => d.label) } })}
              className="input h-20 resize-none text-xs"
              placeholder={t('右列（顺序与左列对应）\n如：兵力|52000', 'right column values')}
            />
          )}
          <div className="flex items-center gap-2">
            <div className="w-20"><ColorPicker value={ch.color || '#4C9EFF'} onChange={(col) => onContent({ ...c, chart: { ...ch, color: col } })} /></div>
            {(isVs || ch.type === 'radar') && (
              <div className="w-20"><ColorPicker value={ch.color2 || '#F87171'} onChange={(col) => onContent({ ...c, chart: { ...ch, color2: col } })} /></div>
            )}
          </div>
        </div>
      );
    }
    default:
      return null;
  }
}

// ========== 弹窗微调辅助 ==========

// ========== 背景音乐 ==========

function MusicTab({ project }: { project: MapVideoProject }) {
  const t = useT();
  const fps = useChapterFps(project);
  const setProjectMusic = useProjectStore((s) => s.setProjectMusic);
  const updateProjectMusic = useProjectStore((s) => s.updateProjectMusic);
  const [auditingId, setAuditingId] = useState<string | null>(null);
  const tracks = project?.music || [];
  const projectEnd = Math.max(1, project?.endFrame ?? 1);
  /** 音乐可用长轴：与时间线一致（内容结束 / 项目长度 / 至少 60s），避免编辑结束时间被过小的 endFrame 卡住 */
  const laneMax = Math.max(projectEnd, projectContentEndFrame(project), Math.round(60 * fps));

  // 试听音频：删除该段 / 关闭面板 / 退出项目时都要停止
  const auditRef = useRef<HTMLAudioElement | null>(null);
  const stopAudit = () => {
    const el = auditRef.current;
    if (el) { el.pause(); auditRef.current = null; }
  };
  useEffect(() => stopAudit, []);
  useEffect(() => {
    if (auditingId && !tracks.some((x) => x.id === auditingId)) {
      stopAudit();
      setAuditingId(null);
    }
  }, [tracks, auditingId]);

  // 内置音乐库：读取 public/bgm/manifest.json（打包随附）
  const [builtin, setBuiltin] = useState<{ name: string; file: string }[]>([]);
  useEffect(() => {
    fetch(new URL('bgm/manifest.json', document.baseURI).href)
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => setBuiltin(Array.isArray(list) ? list : []))
      .catch(() => setBuiltin([]));
  }, []);

  /** 相邻段（单轨顺序即时间顺序；用相邻边界保证段与段不重合） */
  const neighborsOf = (id: string) => {
    const i = tracks.findIndex((x) => x.id === id);
    return {
      index: i,
      prev: i > 0 ? tracks[i - 1] : null,
      next: i >= 0 && i < tracks.length - 1 ? tracks[i + 1] : null,
    };
  };

  /** 从 idx 之后重新顺排：每段接在上一段结束处；循环段铺满到片尾，其余保持原时长 */
  const rippleAfter = (list: MusicTrack[], idx: number): MusicTrack[] => {
    const out = [...list];
    for (let i = idx + 1; i < out.length; i++) {
      const start = Math.min(out[i - 1].endFrame, Math.max(0, laneMax - 1));
      const len = Math.max(1, out[i].endFrame - out[i].startFrame);
      const end = out[i].loop ? laneMax : Math.min(laneMax, start + len);
      out[i] = { ...out[i], startFrame: start, endFrame: Math.max(start + 1, end) };
    }
    return out;
  };

  /**
   * 追加一段音乐（单条轨道，接在上一段之后、不重合）：
   * 上一段若循环铺满到片尾，先把它收短为「开始 + 音频时长」腾出位置；新段铺满剩余到片尾。
   */
  const appendTrack = async (name: string, url: string) => {
    const last = tracks[tracks.length - 1];
    let base = tracks;
    if (last && last.endFrame >= laneMax) {
      const dur = await probeAudioDuration(last.url);
      const shortenTo = dur != null
        ? Math.min(laneMax, last.startFrame + Math.max(1, Math.round(dur * fps)))
        : laneMax;
      if (shortenTo < last.endFrame) {
        base = tracks.map((x) => (x.id === last.id
          ? { ...x, loop: false, endFrame: Math.max(x.startFrame + 1, shortenTo) }
          : x));
      }
    }
    const prev = base[base.length - 1];
    const start = Math.min(prev ? prev.endFrame : 0, laneMax);
    if (start >= laneMax) {
      alert(t('片尾已铺满，无法再追加音乐（可先关闭某段的循环或缩短时长）', 'No room left at the end — turn off loop or shorten a segment first.'));
      return;
    }
    const next: MusicTrack = {
      id: generateId(), name, url,
      startFrame: start, endFrame: laneMax,
      volume: 0.6, loop: true, fadeIn: 1, fadeOut: 1,
    };
    setProjectMusic([...base, next]);
  };

  /** 循环开关：关 → 时长=音频时长（并顺排后续段）；开 → 铺满到下一段开始 / 片尾 */
  const setLoop = async (m: MusicTrack, loop: boolean) => {
    const { index, next } = neighborsOf(m.id);
    if (index < 0) return;
    if (loop) {
      const end = next ? next.startFrame : laneMax;
      const list = [...tracks];
      list[index] = { ...m, loop: true, endFrame: Math.max(m.startFrame + 1, end) };
      setProjectMusic(list);
      return;
    }
    const dur = await probeAudioDuration(m.url);
    const durF = dur != null ? Math.max(1, Math.round(dur * fps)) : (m.endFrame - m.startFrame);
    const end = Math.max(m.startFrame + 1, Math.min(m.startFrame + durF, laneMax));
    const list = [...tracks];
    list[index] = { ...m, loop: false, endFrame: end };
    setProjectMusic(rippleAfter(list, index));
  };

  /** 手动改区间：拖动结束时间会顺排其后各段，保证不重合且编辑一定生效 */
  const changeRange = (m: MusicTrack, which: 'start' | 'end', frame: number) => {
    const { index, prev, next } = neighborsOf(m.id);
    if (index < 0) return;
    const list = [...tracks];
    if (which === 'start') {
      const lo = prev ? prev.endFrame : 0;
      const start = Math.max(lo, Math.min(Math.round(frame), m.endFrame - 1));
      const cap = next ? next.startFrame : laneMax;
      const end = m.loop ? cap : Math.min(cap, start + (m.endFrame - m.startFrame));
      list[index] = { ...m, startFrame: start, endFrame: Math.max(start + 1, end) };
      setProjectMusic(rippleAfter(list, index));
      return;
    }
    const end = Math.max(m.startFrame + 1, Math.min(Math.round(frame), laneMax));
    list[index] = { ...m, endFrame: end };
    setProjectMusic(rippleAfter(list, index));
  };

  const pickBuiltin = (b: { name: string; file: string }) => {
    void appendTrack(b.name, new URL('bgm/' + b.file, document.baseURI).href);
  };

  const importMusic = async (file: File) => {
    try {
      const { dataUrl } = await readAudioFile(file);
      await appendTrack(file.name.replace(/\.[^.]+$/, ''), dataUrl);
    } catch (err) {
      alert(`${t('音频解析失败', 'Audio parse failed')}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const audit = (m: MusicTrack) => {
    const same = auditingId === m.id;
    stopAudit();
    if (same) { setAuditingId(null); return; }
    const el = new Audio(m.url);
    el.volume = m.volume;
    el.loop = true;
    auditRef.current = el;
    setAuditingId(m.id);
    const done = () => {
      if (auditRef.current === el) auditRef.current = null;
      setAuditingId(null);
    };
    el.onended = done;
    el.play().catch(done);
  };

  return (
    <>
      {builtin.length > 0 && (
        <Section title={t('内置音乐', 'Built-in BGM')}>
          <div className="grid grid-cols-2 gap-1.5">
            {builtin.map((b) => (
              <button
                key={b.file}
                onClick={() => pickBuiltin(b)}
                className="h-7 px-2 rounded-md border border-white/10 bg-white/[0.045] text-[11px] truncate hover:border-white/25 transition-colors text-left"
                title={t('点击添加一段音乐（串在上一段之后）', 'Click to append a music segment')}
              >
                ＋ 🎵 {b.name}
              </button>
            ))}
          </div>
        </Section>
      )}
      <Section title={t('项目音乐（一条轨道）', 'Project music (one lane)')}>
        <label className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border bg-white/[0.045] text-xs text-foreground/80 hover:border-white/25 cursor-pointer transition-colors w-fit mb-2">
          ⬆ {t('导入音乐', 'Import music')}
          <input type="file" accept="audio/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importMusic(f); e.target.value = ''; }} />
        </label>
        {tracks.length === 0 && (
          <p className="text-[11px] text-muted-foreground">{t('整个项目共用一条音乐轨：新段接在上一段之后、互不重合。关闭循环时长度=音频时长（自动计算）；开启循环时铺满到下一段开始 / 片尾。', 'One music lane: new segments append after the previous without overlapping. Loop off = length follows the audio duration; loop on = fills until the next segment / project end.')}</p>
        )}
        <div className="space-y-2">
          {tracks.map((m) => (
            <div key={m.id} className="rounded-md border border-white/10 bg-white/[0.03] p-2 space-y-1.5">
              <div className="flex items-center gap-2">
                <button onClick={() => audit(m)} className="h-7 w-7 rounded border border-white/10 bg-white/[0.05] text-[11px] hover:bg-white/10 transition-colors shrink-0">
                  {auditingId === m.id ? '⏸' : '▶'}
                </button>
                <input value={m.name} onChange={(e) => updateProjectMusic(m.id, { name: e.target.value })} className="flex-1 input h-7 text-xs" placeholder={t('音乐名', 'Name')} />
                <button onClick={() => setProjectMusic(tracks.filter((x) => x.id !== m.id))} className="h-7 w-7 rounded border border-white/10 bg-white/[0.05] text-[11px] text-red-400/80 hover:bg-red-500/10 transition-colors shrink-0">✕</button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground shrink-0">{t('音量', 'Vol')}</span>
                <input type="range" min={0} max={1} step={0.05} value={m.volume} onChange={(e) => updateProjectMusic(m.id, { volume: parseFloat(e.target.value) })} className="flex-1 h-1 accent-[var(--brand)]" />
                <span className="text-[11px] text-muted-foreground w-8 text-right tabular-nums">{Math.round(m.volume * 100)}%</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground shrink-0">{t('区间', 'Range')}</span>
                <div className="w-24"><FrameTimeField value={m.startFrame} fps={fps} onFrameChange={(f) => changeRange(m, 'start', f)} /></div>
                <span className="text-muted-foreground">→</span>
                <div className="w-24"><FrameTimeField value={m.endFrame} fps={fps} onFrameChange={(f) => changeRange(m, 'end', f)} /></div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground shrink-0">{t('淡入', 'Fade in')}</span>
                <NumberInput className="input h-7 w-14 text-xs" value={m.fadeIn} step={0.5} min={0} onCommit={(v) => updateProjectMusic(m.id, { fadeIn: Math.max(0, v) })} />
                <span className="text-[11px] text-muted-foreground shrink-0">{t('淡出', 'Fade out')}</span>
                <NumberInput className="input h-7 w-14 text-xs" value={m.fadeOut} step={0.5} min={0} onCommit={(v) => updateProjectMusic(m.id, { fadeOut: Math.max(0, v) })} />
                <div className="ml-auto w-28">
                  <Toggle label={t('循环', 'Loop')} checked={m.loop} onChange={(v) => void setLoop(m, v)} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </Section>
      <p className="text-[11px] text-muted-foreground mt-1">
        {t('音乐按项目绝对时间播放；导出 MP4 会混入配音与音乐（段内 Loop）。预览播放时自动同步。', 'Plays on the project timeline; mixed into exported MP4 (per-segment Loop). Auto-synced during preview.')}
      </p>
    </>
  );
}
// ========== 面板主体 ==========

const FX_TABS: { id: FxTab; label: string }[] = [
  { id: 'weather', label: '天气' },
  { id: 'screen', label: '画面' },
  { id: 'popup', label: '弹窗' },
  { id: 'music', label: '音乐' },
];

export function FxPanelBody({ project }: { project: MapVideoProject }) {
  const t = useT();
  const fxTab = useEditorStore((s) => s.fxTab);
  const setFxTab = useEditorStore((s) => s.setFxTab);
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 pt-3 pb-2 shrink-0">
        <OptionBlocks<FxTab>
          value={fxTab}
          onChange={setFxTab}
          options={FX_TABS.map((x) => ({ value: x.id, label: t(x.label, { weather: 'Weather', screen: 'Screen', popup: 'Popup', music: 'Music' }[x.id]) }))}
        />
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-4">
        {fxTab === 'weather' && <WeatherTab project={project} />}
        {fxTab === 'screen' && <ScreenTab project={project} />}
        {fxTab === 'popup' && <PopupTab project={project} />}
        {fxTab === 'music' && <MusicTab project={project} />}
      </div>
    </div>
  );
}
