/**
 * 特效窗口面板主体：天气 / 画面 / 弹窗 / 标题 / 字幕 / 音乐 六个标签。
 * ChapterSettingsPanel（章节设置页签）与 FxDialog（弹窗）共用本组件。
 */
import { useState } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useEditorStore, type FxTab } from '../stores/editorStore';
import { useProviderStore, activeProvider } from '../stores/providerStore';
import { IS_DESKTOP, aiAvailable } from '../lib/backend';
import { useT, Section, Field, OptionBlocks, Toggle, ColorPicker, NumberInput } from './ui/primitives';
import { FrameTimeField } from './FrameTimeField';
import {
  generateId, TITLE_PRESETS, POS_BASE, normalizeTitleStyle,
  defaultPersonContent, normalizePersonContent, PERSON_PRESETS,
  estimateTextDurationFrames, defaultNarrationStyle,
  type Chapter, type ScreenFxItem, type WeatherType, type ScreenFxType,
  type OverlayItem, type OverlayType, type OverlayBlock, type ChartType,
  type OverlayPosition, type AnimationPreset, type TitleStyle,
  type PersonContent, type PersonLayoutCfg, type PersonBlock, type PersonBlockKind,
  type NarrationEntry, type MusicTrack, type TtsProtocol,
} from '../types';
import { callLLM, callTTS, readAudioFile, srtTime, parseSrt, LLM_PRESETS, TTS_PRESETS } from '../lib/providers';

const FPS_FALLBACK = 30;

function useChapterFps(chapter: Chapter): number {
  const project = useProjectStore((s) => s.project);
  void chapter;
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

function FxTimeRow({ fx, chapterId, fps }: { fx: ScreenFxItem; chapterId: string; fps: number }) {
  const t = useT();
  const updateScreenFx = useProjectStore((s) => s.updateScreenFx);
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-muted-foreground shrink-0">{t('时间', 'Time')}</span>
      <div className="w-24"><FrameTimeField value={fx.startFrame} fps={fps} onFrameChange={(f) => updateScreenFx(chapterId, fx.id, { startFrame: f })} /></div>
      <span className="text-muted-foreground">→</span>
      <div className="w-24"><FrameTimeField value={fx.endFrame} fps={fps} onFrameChange={(f) => updateScreenFx(chapterId, fx.id, { endFrame: f })} /></div>
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

function WeatherTab({ chapter }: { chapter: Chapter }) {
  const t = useT();
  const fps = useChapterFps(chapter);
  const addScreenFx = useProjectStore((s) => s.addScreenFx);
  const updateScreenFx = useProjectStore((s) => s.updateScreenFx);
  const removeScreenFx = useProjectStore((s) => s.removeScreenFx);
  const currentFrame = useEditorStore((s) => s.currentFrame);
  const fxSelId = useEditorStore((s) => s.fxSelId);
  const setFxSelId = useEditorStore((s) => s.setFxSelId);
  const list = (chapter.fx || []).filter((f) => f.kind === 'weather');
  const sel = list.find((f) => f.id === fxSelId) || list[0] || null;
  const idx = sel ? list.indexOf(sel) : -1;

  const add = (w: WeatherType) => {
    const info = WEATHERS.find((x) => x.type === w)!;
    if (sel) {
      // 已有天气：原地切换类型，不新增条目
      if (sel.weather?.type === w) return;
      updateScreenFx(chapter.id, sel.id, {
        name: info.label,
        weather: { type: w, intensity: sel.weather?.intensity ?? 0.6, wind: sel.weather?.wind ?? 0.15 },
      });
      setFxSelId(sel.id);
      return;
    }
    const fx: ScreenFxItem = {
      id: generateId(), kind: 'weather', name: `${info.label}`,
      startFrame: Math.max(chapter.startFrame, currentFrame), endFrame: chapter.endFrame,
      weather: { type: w, intensity: 0.6, wind: 0.15 }, enabled: true,
    };
    addScreenFx(chapter.id, fx);
    setFxSelId(fx.id);
  };
  const remove = () => {
    if (!sel) return;
    removeScreenFx(chapter.id, sel.id);
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
          <FxTimeRow fx={sel} chapterId={chapter.id} fps={fps} />
          <IntensityRow label={t('强度', 'Level')} value={sel.weather?.intensity ?? 0.6} onChange={(v) => updateScreenFx(chapter.id, sel.id, { weather: { ...(sel.weather || { type: 'rain', wind: 0 }), intensity: v, type: sel.weather?.type || 'rain' } })} />
          {sel.weather?.type !== 'fog' && sel.weather?.type !== 'lightning' && (
            <IntensityRow label={t('风向', 'Wind')} value={sel.weather?.wind ?? 0} onChange={(v) => updateScreenFx(chapter.id, sel.id, { weather: { ...(sel.weather || { type: 'rain', intensity: 0.6 }), wind: Math.max(-1, Math.min(1, v)), type: sel.weather?.type || 'rain' } })} />
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

// ========== 画面特效 ==========

export const SCREEN_FXS: { type: ScreenFxType; label: string; icon: string; dur: number }[] = [
  { type: 'shake', label: '震动', icon: '💥', dur: 60 },
  { type: 'flash', label: '闪光', icon: '✨', dur: 60 },
  { type: 'vignette', label: '暗角', icon: '🌑', dur: 3000 },
  { type: 'cloudReveal', label: '云层散开', icon: '☁️', dur: 120 },
  { type: 'fadeBlack', label: '黑场淡入', icon: '⬛', dur: 60 },
  { type: 'fadeWhite', label: '白场淡入', icon: '⬜', dur: 60 },
];

function ScreenTab({ chapter }: { chapter: Chapter }) {
  const t = useT();
  const fps = useChapterFps(chapter);
  const addScreenFx = useProjectStore((s) => s.addScreenFx);
  const updateScreenFx = useProjectStore((s) => s.updateScreenFx);
  const removeScreenFx = useProjectStore((s) => s.removeScreenFx);
  const currentFrame = useEditorStore((s) => s.currentFrame);
  const fxSelId = useEditorStore((s) => s.fxSelId);
  const setFxSelId = useEditorStore((s) => s.setFxSelId);
  const list = (chapter.fx || []).filter((f) => f.kind === 'screen');
  const sel = list.find((f) => f.id === fxSelId) || list[0] || null;
  const idx = sel ? list.indexOf(sel) : -1;

  const add = (type: ScreenFxType) => {
    const info = SCREEN_FXS.find((x) => x.type === type)!;
    const start = Math.max(chapter.startFrame, currentFrame);
    const fx: ScreenFxItem = {
      id: generateId(), kind: 'screen', name: info.label,
      startFrame: start, endFrame: Math.min(chapter.endFrame, start + info.dur),
      effect: { type, intensity: type === 'shake' ? 0.5 : 0.6, color: type === 'fadeBlack' ? '#000000' : '#FFFFFF' },
      enabled: true,
    };
    addScreenFx(chapter.id, fx);
    setFxSelId(fx.id);
  };
  const remove = () => {
    if (!sel) return;
    removeScreenFx(chapter.id, sel.id);
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
          <FxTimeRow fx={sel} chapterId={chapter.id} fps={fps} />
          <IntensityRow label={t('强度', 'Level')} value={sel.effect?.intensity ?? 0.6} onChange={(v) => updateScreenFx(chapter.id, sel.id, { effect: { ...(sel.effect || { type: 'shake' }), intensity: v, type: sel.effect?.type || 'shake' } })} />
          {(sel.effect?.type === 'flash' || sel.effect?.type === 'fadeWhite') && (
            <Field label={t('闪光/遮罩颜色', 'Color')}>
              <ColorPicker value={sel.effect?.color || '#FFFFFF'} onChange={(c) => updateScreenFx(chapter.id, sel.id, { effect: { ...(sel.effect || { type: 'flash', intensity: 0.6 }), color: c, type: sel.effect?.type || 'flash' } })} />
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
  { type: 'custom', label: '自定义', icon: '🧱' },
  { type: 'chart', label: '图表', icon: '📊' },
  { type: 'person', label: '人物', icon: '👤' },
  { type: 'report', label: '战报', icon: '📋' },
  { type: 'timeline', label: '时间线', icon: '🕒' },
  { type: 'quote', label: '引用', icon: '❝' },
  { type: 'compare', label: '对比', icon: '⚖️' },
  { type: 'counter', label: '计数', icon: '🔢' },
  { type: 'dialogue', label: '对话', icon: '💬' },
  { type: 'place', label: '地点', icon: '📍' },
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
    case 'report':
      return { type, report: { title: '战报', value: '3.2万', unit: '人', note: '补充说明…' } };
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
    case 'counter':
      return { type, counter: { value: 32000, label: '伤亡统计', prefix: '', unit: '人', durationFrames: 90 } };
    case 'dialogue':
      return {
        type,
        dialogue: {
          title: '往来电文',
          items: [{ who: '张司令', text: '命令：即刻渡江！' }, { who: '李军长', text: '收到，部队已集结完毕。' }],
        },
      };
    case 'place':
      return { type, place: { name: '地名', description: '地点简介…', imageUrl: '' } };
    case 'chart':
      return { type, chart: { type: 'bar', title: '图表', data: [{ label: '兵力', value: 5000 }, { label: '装备', value: 1200 }] } };
    default:
      return { type };
  }
}

function PopupTab({ chapter }: { chapter: Chapter }) {
  const t = useT();
  const fps = useChapterFps(chapter);
  const addOverlay = useProjectStore((s) => s.addOverlay);
  const deleteOverlay = useProjectStore((s) => s.deleteOverlay);
  const currentFrame = useEditorStore((s) => s.currentFrame);
  const fxSelId = useEditorStore((s) => s.fxSelId);
  const setFxSelId = useEditorStore((s) => s.setFxSelId);
  const list = chapter.overlays || [];
  const sel = list.find((o) => o.id === fxSelId) || list[0] || null;
  const idx = sel ? list.indexOf(sel) : -1;

  const add = (type: OverlayType) => {
    const info = POPUP_TYPES.find((x) => x.type === type)!;
    const overlay: OverlayItem = {
      id: generateId(), type, name: info.label,
      position: type === 'quote' || type === 'counter' ? 'top' : 'bottomLeft',
      content: createPopupContent(type),
      startFrame: Math.max(chapter.startFrame, currentFrame),
      endFrame: chapter.endFrame,
      animation: 'fadeIn', exitAnimation: 'fadeOut',
      scale: 1,
    };
    addOverlay(chapter.id, overlay);
    setFxSelId(overlay.id);
  };
  const remove = () => {
    if (!sel) return;
    deleteOverlay(chapter.id, sel.id);
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
          <PopupItemEditor overlay={sel} chapter={chapter} fps={fps} />
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

function PopupItemEditor({ overlay: o, chapter, fps }: { overlay: OverlayItem; chapter: Chapter; fps: number }) {
  const t = useT();
  const update = (changes: Partial<OverlayItem>) => useProjectStore.getState().updateOverlay(chapter.id, o.id, changes);

  return (
    <div className="space-y-2">
      <FxTimeLikeRow fps={fps} label={t('时间', 'Time')}
        start={o.startFrame} end={o.endFrame}
        onStart={(f) => update({ startFrame: f })} onEnd={(f) => update({ endFrame: f })} />

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

/** 位置微调滑杆：显示值=九宫格标准位(POS_BASE)+微调量，写入的是相对标准位的 delta */
function PopupOffsetSliders({ o, update, t }: {
  o: OverlayItem;
  update: (changes: Partial<OverlayItem>) => void;
  t: (zh: string, en: string) => string;
}) {
  const base = POS_BASE[o.position] ?? [0, 0];
  const hx = base[0] + (o.offsetX ?? 0);
  const vy = base[1] + (o.offsetY ?? 0);
  return (
    <>
      <SliderRow label={t('横向微调', 'H-Offset')} min={-40} max={40} value={hx}
        onChange={(v) => update({ offsetX: v - base[0] })} display={`${Math.round(hx)}%`} />
      <SliderRow label={t('纵向微调', 'V-Offset')} min={-40} max={40} value={vy}
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
      const setLayout = (ch: Partial<PersonLayoutCfg>) => setP({ layout: { ...pc.layout, ...ch } });
      const setBlock = (kind: PersonBlockKind, ch: Partial<PersonBlock>) =>
        setP({ blocks: pc.blocks.map((b) => (b.kind === kind ? { ...b, ...ch } : b)) });
      const move = (kind: PersonBlockKind, dir: -1 | 1) => {
        const arr = [...pc.blocks];
        const i = arr.findIndex((b) => b.kind === kind);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= arr.length) return;
        [arr[i], arr[j]] = [arr[j], arr[i]];
        setP({ blocks: arr });
      };
      const applyPreset = (id: string) => {
        const p = PERSON_PRESETS.find((x) => x.id === id);
        if (!p) return;
        const order = [...p.order];
        const blocks = [...pc.blocks]
          .sort((a, b) => {
            const ia = order.indexOf(a.kind);
            const ib = order.indexOf(b.kind);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
          })
          .map((b) => ({ ...b, show: p.order.includes(b.kind) ? (p.show[b.kind] ?? true) : false }));
        setP({ layout: { ...p.layout }, blocks });
      };
      const blk = (kind: PersonBlockKind) => pc.blocks.find((b) => b.kind === kind);
      const rowMini = 'px-1.5 h-7 text-xs rounded-md border bg-white/[0.03] border-white/10 text-muted-foreground hover:bg-white/[0.07] transition-colors';
      const textKinds: { kind: PersonBlockKind; label: string; ph: string }[] = [
        { kind: 'name', label: t('姓名', 'Name'), ph: t('姓名', 'Name') },
        { kind: 'intro', label: t('介绍', 'Intro'), ph: t('人物介绍…', 'Bio…') },
        { kind: 'quote', label: t('名言', 'Quote'), ph: t('名言/引语…', 'Quote…') },
        { kind: 'dialogue', label: t('对话', 'Speech'), ph: t('说的话（单角色）', 'Speech (single role)') },
      ];
      return (
        <div className="space-y-2">
          <Field label={t('布局预设', 'Layout')}>
            <OptionBlocks value="" options={PERSON_PRESETS.map((p) => ({ value: p.id, label: t(p.zh, p.en) }))} onChange={applyPreset} />
          </Field>
          <Field label={t('图片方位', 'Image side')}>
            <OptionBlocks<PersonLayoutCfg['imageSide']>
              value={pc.layout.imageSide}
              options={[
                { value: 'left', label: t('左', 'L') }, { value: 'right', label: t('右', 'R') },
                { value: 'top', label: t('上', 'T') }, { value: 'bottom', label: t('下', 'B') },
              ]}
              onChange={(v) => setLayout({ imageSide: v })}
            />
          </Field>
          <Field label={t('对齐', 'Align')}>
            <OptionBlocks<PersonLayoutCfg['align']>
              value={pc.layout.align}
              options={[{ value: 'left', label: t('左', 'Left') }, { value: 'center', label: t('中', 'Center') }]}
              onChange={(v) => setLayout({ align: v })}
            />
          </Field>
          <SliderRow label={t('卡片宽度', 'Width')} min={240} max={560} step={10} value={pc.layout.width} onChange={(v) => setLayout({ width: v })} display={`${Math.round(pc.layout.width)}px`} />
          <Toggle checked={!!pc.layout.textOverImage} onChange={(v) => setLayout({ textOverImage: v })} label={t('文字叠加图片（海报式）', 'Text over image (poster)')} />

          <Section title={t('图片', 'Image')}>
            <div className="flex items-center gap-2">
              <UploadButton label={t('上传图片', 'Image')} accept="image/*" onPick={(url) => setBlock('image', { imageUrl: url })} />
              {blk('image')?.imageUrl && <img src={blk('image')!.imageUrl} className="w-8 h-8 rounded object-cover border border-white/15" alt="" />}
              {blk('image')?.imageUrl && (
                <button className={rowMini} onClick={() => setBlock('image', { imageUrl: '' })} title={t('移除', 'Remove')}>✕</button>
              )}
            </div>
            <SliderRow label={t('图片大小', 'Size')} min={60} max={360} step={4} value={blk('image')?.size ?? 72} onChange={(v) => setBlock('image', { size: v })} display={`${Math.round(blk('image')?.size ?? 72)}px`} />
            <Field label={t('遮罩', 'Mask')}>
              <OptionBlocks<NonNullable<PersonBlock['mask']>>
                value={blk('image')?.mask || 'none'}
                options={[
                  { value: 'none', label: t('无', 'None') },
                  { value: 'bottom', label: t('下渐变', 'Bottom') },
                  { value: 'top', label: t('上渐变', 'Top') },
                  { value: 'circle', label: t('圆形', 'Circle') },
                  { value: 'feather', label: t('羽化', 'Feather') },
                ]}
                onChange={(v) => setBlock('image', { mask: v })}
              />
            </Field>
          </Section>

          {textKinds.map(({ kind, label, ph }) => {
            const b = blk(kind);
            if (!b) return null;
            return (
              <Section key={kind} title={label}>
                <Toggle checked={b.show !== false} onChange={(v) => setBlock(kind, { show: v })} label={t('显示', 'Show')} />
                {b.show !== false && (
                  <>
                    <textarea
                      value={b.text || ''}
                      onChange={(e) => setBlock(kind, { text: e.target.value })}
                      className="input h-14 resize-none text-xs"
                      placeholder={ph}
                    />
                    <div className="flex items-center gap-2">
                      <span className="flex-1" />
                      <button className={rowMini} onClick={() => move(kind, -1)} title={t('上移', 'Up')}>▲</button>
                      <button className={rowMini} onClick={() => move(kind, 1)} title={t('下移', 'Down')}>▼</button>
                    </div>
                  </>
                )}
              </Section>
            );
          })}

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
            <p className="text-[11px] text-muted-foreground mt-1">{t('卡片出现后可在预览中点击播放（交互演示用；导出 MP4 的声音请用「字幕→配音」或「音乐」轨道）', 'Click to play in preview; use Subs/Music tracks for exported audio')}</p>
          </Section>
        </div>
      );
    }
    case 'report': {
      const r = c.report || { value: '' };
      return (
        <div className="space-y-2">
          <input value={r.title || ''} onChange={(e) => onContent({ ...c, report: { ...r, title: e.target.value } })} className="input h-7 text-xs" placeholder={t('标题', 'Title')} />
          <div className="flex gap-2">
            <input value={String(r.value ?? '')} onChange={(e) => onContent({ ...c, report: { ...r, value: e.target.value } })} className="input h-7 flex-1 text-xs" placeholder={t('战果数字（如 3.2万）', 'Value')} />
            <input value={r.unit || ''} onChange={(e) => onContent({ ...c, report: { ...r, unit: e.target.value } })} className="input h-7 w-16 text-xs" placeholder={t('单位', 'Unit')} />
          </div>
          <textarea value={r.note || ''} onChange={(e) => onContent({ ...c, report: { ...r, note: e.target.value } })} className="input h-12 resize-none text-xs" placeholder={t('注释（可选）', 'Note')} />
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
    case 'counter': {
      const ct = c.counter || { value: 0 };
      return (
        <div className="space-y-2">
          <input value={ct.label || ''} onChange={(e) => onContent({ ...c, counter: { ...ct, label: e.target.value } })} className="input h-7 text-xs" placeholder={t('标签（如：伤亡统计）', 'Label')} />
          <div className="flex gap-2">
            <NumberInput className="input h-7 flex-1 text-xs" value={ct.value ?? 0} step={100} onCommit={(v) => onContent({ ...c, counter: { ...ct, value: Math.max(0, v) } })} title={t('终值', 'Value')} />
            <input value={ct.prefix || ''} onChange={(e) => onContent({ ...c, counter: { ...ct, prefix: e.target.value } })} className="input h-7 w-14 text-xs" placeholder={t('前缀', 'Prefix')} />
            <input value={ct.unit || ''} onChange={(e) => onContent({ ...c, counter: { ...ct, unit: e.target.value } })} className="input h-7 w-14 text-xs" placeholder={t('单位', 'Unit')} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground shrink-0">{t('计数时长(帧)', 'Count dur')}</span>
            <NumberInput className="input h-7 w-20 text-xs" value={ct.durationFrames ?? 90} step={10} min={10} max={600} onCommit={(v) => onContent({ ...c, counter: { ...ct, durationFrames: Math.max(10, Math.min(600, v || 90)) } })} />
          </div>
        </div>
      );
    }
    case 'dialogue': {
      const dl = c.dialogue || { items: [] };
      return (
        <div className="space-y-2">
          <input value={dl.title || ''} onChange={(e) => onContent({ ...c, dialogue: { ...dl, title: e.target.value } })} className="input h-7 text-xs" placeholder={t('标题(可选)', 'Title (optional)')} />
          <textarea
            value={(dl.items || []).map((it) => `${it.who}|${it.text}`).join('\n')}
            onChange={(e) => onContent({
              ...c,
              dialogue: {
                ...dl,
                items: e.target.value.split('\n').filter((x) => x.trim()).map((line) => {
                  const [who, text] = line.split('|');
                  return { who: (who || '').trim(), text: (text || '').trim() };
                }),
              },
            })}
            className="input h-20 resize-none text-xs"
            placeholder={t('每行一条：说话人|内容', 'One per line: who|text')}
          />
        </div>
      );
    }
    case 'place': {
      const pl = c.place || { name: '' };
      return (
        <div className="space-y-2">
          <input value={pl.name} onChange={(e) => onContent({ ...c, place: { ...pl, name: e.target.value } })} className="input h-7 text-xs" placeholder={t('地名', 'Name')} />
          <textarea value={pl.description || ''} onChange={(e) => onContent({ ...c, place: { ...pl, description: e.target.value } })} className="input h-14 resize-none text-xs" placeholder={t('简介', 'Description')} />
          <div className="flex items-center gap-2">
            <UploadButton label={t('配图', 'Image')} accept="image/*" onPick={(u) => onContent({ ...c, place: { ...pl, imageUrl: u } })} />
            {pl.imageUrl && <img src={pl.imageUrl} className="w-8 h-8 rounded object-cover border border-white/15" alt="" />}
          </div>
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

// ========== 章节标题 ==========

function TitleTab({ chapter }: { chapter: Chapter }) {
  const t = useT();
  const updateChapter = useProjectStore((s) => s.updateChapter);
  const st: TitleStyle = normalizeTitleStyle(chapter.titleStyle);
  const set = (changes: Partial<TitleStyle>) => updateChapter(chapter.id, { titleStyle: { ...st, ...changes, preset: changes.preset ?? 'custom' } });
  const FONTS: { value: string; label: string }[] = [
    { value: "'Geist', 'Noto Sans SC', system-ui, sans-serif", label: t('无衬线', 'Sans') },
    { value: "Georgia, 'Noto Serif SC', 'SimSun', serif", label: t('宋体衬线', 'Serif') },
    { value: "'KaiTi', 'STKaiti', serif", label: t('楷体', 'Kai') },
    { value: "'Courier New', monospace", label: t('等宽', 'Mono') },
  ];

  return (
    <div className="space-y-2">
      <Toggle checked={st.show} onChange={(v) => set({ show: v })} label={t('显示章节标题', 'Show title')} />
      <Field label={t('内置样式', 'Preset')}>
        <OptionBlocks
          value={st.preset || ''}
          options={TITLE_PRESETS.map((p) => ({ value: p.id, label: t(p.zh, p.en) }))}
          onChange={(id) => {
            const p = TITLE_PRESETS.find((x) => x.id === id);
            if (p) set({ ...p.values, preset: id });
          }}
        />
      </Field>
      <Toggle checked={st.shadow} onChange={(v) => set({ shadow: v })} label={t('文字阴影', 'Text shadow')} />
      <Field label={t('字体', 'Font')}>
        <OptionBlocks value={st.fontFamily} options={FONTS} onChange={(v) => set({ fontFamily: v })} />
      </Field>
      <SliderRow label={t('字号', 'Size')} min={12} max={120} value={st.fontSize} onChange={(v) => set({ fontSize: v })} display={`${Math.round(st.fontSize)}px`} />
      <SliderRow label={t('粗细', 'Weight')} min={300} max={900} step={100} value={st.weight} onChange={(v) => set({ weight: v })} display={String(Math.round(st.weight))} />
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground shrink-0">{t('颜色', 'Color')}</span>
        <div className="w-32"><ColorPicker value={st.color} onChange={(c) => set({ color: c })} /></div>
      </div>
      <Field label={t('位置', 'Position')}>
        <div className="grid grid-cols-3 gap-1 w-fit">
          {POS_GRID.map((p) => (
            <button
              key={p.value}
              onClick={() => set({ pos: p.value, offsetX: 0, offsetY: 0 })}
              title={p.label}
              className={`w-8 h-8 flex items-center justify-center text-xs rounded-md border transition-colors ${
                st.pos === p.value && !st.offsetX && !st.offsetY
                  ? 'bg-brand/25 border-brand text-foreground'
                  : 'bg-white/[0.03] border-white/10 text-foreground/70 hover:bg-white/[0.07]'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </Field>
      <PopupOffsetSliders o={{ position: st.pos, offsetX: st.offsetX, offsetY: st.offsetY } as OverlayItem}
        update={(ch) => set(ch as Partial<TitleStyle>)} t={t} />
      <Field label={t('背景样式', 'Background')}>
        <OptionBlocks value={st.bg} options={[{ value: 'none', label: t('无', 'None') }, { value: 'bar', label: t('条带', 'Bar') }, { value: 'card', label: t('卡片', 'Card') }]} onChange={(v) => set({ bg: v })} />
      </Field>
      {st.bg !== 'none' && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground shrink-0">{t('背景色', 'BG')}</span>
          <div className="w-32"><ColorPicker value={st.bgColor} onChange={(c) => set({ bgColor: c })} /></div>
        </div>
      )}
    </div>
  );
}

// ========== 字幕 / 配音 ==========

/** 顺排：未锁定条目依次衔接（起点=章首），锁定条目占据其后 */
function resequenceEntries(entries: NarrationEntry[], chapterStart: number): NarrationEntry[] {
  let cursor = chapterStart;
  return entries.map((e) => {
    const startFrame = e.locked ? e.startFrame : cursor;
    cursor = Math.max(startFrame + e.durationFrames, e.locked ? cursor : cursor);
    return { ...e, startFrame };
  });
}

function SubtitleTab({ chapter }: { chapter: Chapter }) {
  const t = useT();
  const fps = useChapterFps(chapter);
  const setNarrationStyleOp = useProjectStore((s) => s.setNarrationStyle);
  const setNarrationEntries = useProjectStore((s) => s.setNarrationEntries);
  const updateNarrationEntry = useProjectStore((s) => s.updateNarrationEntry);
  const [showAi, setShowAi] = useState(false);
  const [showProviders, setShowProviders] = useState(false);
  const [genIdx, setGenIdx] = useState<number | null>(null); // 正在生成配音的条目下标
  const [auditingId, setAuditingId] = useState<string | null>(null);
  const narration = chapter.narration || { entries: [], style: defaultNarrationStyle() };
  const entries = narration.entries;
  const ttsCfg = activeProvider('tts');
  const canAi = aiAvailable();

  const setStyle = (patch: Partial<typeof narration.style>) => setNarrationStyleOp(chapter.id, patch);

  /** 更新文本：有配音保持配音时长（时长由音频决定），否则按字数估算；统一顺排 */
  const updateText = (id: string, text: string) => {
    const next = entries.map((e) =>
      e.id === id
        ? { ...e, text, durationFrames: e.audioUrl ? e.durationFrames : estimateTextDurationFrames(text, fps) }
        : e
    );
    setNarrationEntries(chapter.id, resequenceEntries(next, chapter.startFrame));
  };

  const addEntry = () => {
    const last = entries[entries.length - 1];
    const e: NarrationEntry = {
      id: generateId(),
      text: '',
      durationFrames: estimateTextDurationFrames('', fps),
      startFrame: last ? last.startFrame + last.durationFrames : chapter.startFrame,
      status: 'none',
    };
    setNarrationEntries(chapter.id, [...entries, e]);
  };

  const deleteEntry = (id: string) => {
    setNarrationEntries(chapter.id, resequenceEntries(entries.filter((e) => e.id !== id), chapter.startFrame));
  };

  /** 手动改起始帧 → 锁定该条，其后顺排 */
  const changeStart = (id: string, f: number) => {
    const next = entries.map((e) => (e.id === id ? { ...e, startFrame: f, locked: true } : e));
    setNarrationEntries(chapter.id, resequenceEntries(next, chapter.startFrame));
  };

  /** 单条生成配音（时长回填 + 顺排） */
  const genOne = async (idx: number) => {
    const e = entries[idx];
    if (!e || !e.text.trim()) { alert(t('请先填写字幕文本', 'Fill in text first')); return; }
    const cfg = ttsCfg;
    if (!cfg || !cfg.baseUrl) { alert(t('请先在「配音服务」里配置 TTS 服务', 'Configure TTS provider first')); setShowProviders(true); return; }
    setGenIdx(idx);
    updateNarrationEntry(chapter.id, e.id, { status: 'pending', error: undefined });
    try {
      const { dataUrl, durationSec } = await callTTS(cfg, e.text);
      const next = entries.map((x) =>
        x.id === e.id
          ? { ...x, audioUrl: dataUrl, durationFrames: Math.max(1, Math.round(durationSec * fps)), status: 'ready' as const }
          : x
      );
      setNarrationEntries(chapter.id, resequenceEntries(next, chapter.startFrame));
    } catch (err) {
      updateNarrationEntry(chapter.id, e.id, { status: 'error', error: err instanceof Error ? err.message : String(err) });
    } finally {
      setGenIdx(null);
    }
  };

  /** 全部生成（顺序执行，避免并发限流） */
  const genAll = async () => {
    for (let i = 0; i < entries.length; i++) {
      if (!entries[i].text.trim()) continue;
      await genOne(i);
    }
  };

  /** 导入配音音频文件（时长自动解析） */
  const importAudio = async (id: string, file: File) => {
    try {
      const { dataUrl, durationSec } = await readAudioFile(file);
      const next = entries.map((x) =>
        x.id === id
          ? { ...x, audioUrl: dataUrl, durationFrames: Math.max(1, Math.round(durationSec * fps)), status: 'ready' as const }
          : x
      );
      setNarrationEntries(chapter.id, resequenceEntries(next, chapter.startFrame));
    } catch (err) {
      alert(`${t('音频解析失败', 'Audio parse failed')}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const audit = (e: NarrationEntry) => {
    if (!e.audioUrl) return;
    const el = new Audio(e.audioUrl);
    setAuditingId(e.id);
    el.onended = () => setAuditingId(null);
    el.play().catch(() => setAuditingId(null));
  };

  const importSrt = async (file: File) => {
    const text = await file.text();
    const lines = parseSrt(text);
    let cursor = chapter.startFrame;
    const list: NarrationEntry[] = lines.map((l) => {
      const dur = estimateTextDurationFrames(l, fps);
      const e: NarrationEntry = { id: generateId(), text: l, durationFrames: dur, startFrame: cursor, status: 'none' };
      cursor += dur;
      return e;
    });
    setNarrationEntries(chapter.id, list);
  };

  const exportSrt = () => {
    let t0 = 0;
    const srt = entries
      .map((e, i) => {
        const startSec = (e.startFrame - chapter.startFrame) / fps;
        const durSec = e.durationFrames / fps;
        const entry = `${i + 1}\n${srtTime(startSec)} --> ${srtTime(startSec + durSec)}\n${e.text}\n`;
        t0 += durSec;
        return entry;
      })
      .join('\n');
    void t0;
    const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${chapter.title || 'chapter'}.srt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      {/* 配音服务（Lite 纯静态无 AI，隐藏） */}
      {canAi && (
      <Section title={t('配音服务', 'TTS Provider')}>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowProviders(true)}
            className="flex-1 h-8 px-2.5 rounded-md border border-white/10 bg-white/[0.045] text-xs text-left truncate hover:border-white/25 transition-colors"
            title={t('点击配置配音服务（内置千问/MiMo/MiniMax/豆包/SoVITS，可自定义扩展）', 'Configure TTS providers')}
          >
            🔊 {ttsCfg ? `${ttsCfg.label}${ttsCfg.model ? ` · ${ttsCfg.model}` : ''}` : t('未配置（点击设置）', 'Not configured')}
          </button>
        </div>
        {ttsCfg && (
          <div className="flex items-center gap-2 mt-1.5">
            <span className="text-[11px] text-muted-foreground shrink-0">{t('语速', 'Speed')}</span>
            <input type="range" min={0.5} max={2} step={0.05} value={ttsCfg.speed ?? 1}
              onChange={(e) => useProviderStore.getState().update(ttsCfg.id, { speed: parseFloat(e.target.value) })}
              className="flex-1 h-1 accent-[var(--brand)]" />
            <span className="text-[11px] text-muted-foreground w-8 text-right tabular-nums">{(ttsCfg.speed ?? 1).toFixed(2)}</span>
          </div>
        )}
      </Section>
      )}

      {/* 字幕列表 */}
      <Section title={t('字幕 / 配音列表', 'Subtitles')}>
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          <button onClick={addEntry} className="h-7 px-2 rounded-md border border-white/10 bg-white/[0.045] text-xs hover:border-white/25 transition-colors">＋ {t('添加', 'Add')}</button>
          {canAi && (
            <>
              <button onClick={() => setShowAi(true)} className="h-7 px-2 rounded-md border border-white/10 bg-white/[0.045] text-xs hover:border-white/25 transition-colors">✨ {t('AI 文案', 'AI script')}</button>
              <button onClick={genAll} className="h-7 px-2 rounded-md border border-white/10 bg-white/[0.045] text-xs hover:border-white/25 transition-colors">▶▶ {t('全部生成配音', 'Gen all TTS')}</button>
            </>
          )}
          <label className="h-7 px-2 rounded-md border border-white/10 bg-white/[0.045] text-xs hover:border-white/25 transition-colors cursor-pointer w-fit">
            {t('导入 SRT', 'Import SRT')}
            <input type="file" accept=".srt,.txt" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importSrt(f); e.target.value = ''; }} />
          </label>
          {entries.length > 0 && (
            <button onClick={exportSrt} className="h-7 px-2 rounded-md border border-white/10 bg-white/[0.045] text-xs hover:border-white/25 transition-colors">{t('导出 SRT', 'Export SRT')}</button>
          )}
        </div>
        {entries.length === 0 && (
          <p className="text-[11px] text-muted-foreground">{t('添加字幕行 → 点「全部生成配音」（时长按配音自动顺排），或导入 SRT 文本。', 'Add lines, generate TTS (timing auto-follows audio), or import SRT.')}</p>
        )}
        <div className="space-y-2">
          {entries.map((e, i) => (
            <div key={e.id} className={`rounded-md border p-1.5 ${e.status === 'error' ? 'border-red-500/40' : 'border-white/10'} bg-white/[0.03]`}>
              <div className="flex items-start gap-1.5">
                <span className="text-[11px] text-muted-foreground w-5 shrink-0 text-right pt-1.5 tabular-nums">{i + 1}</span>
                <textarea
                  value={e.text}
                  onChange={(ev) => updateText(e.id, ev.target.value)}
                  rows={Math.min(3, Math.max(1, Math.ceil(e.text.length / 22)))}
                  className="flex-1 input resize-none text-xs py-1 min-h-7"
                  placeholder={t('字幕文本（= 配音朗读内容）', 'Subtitle text (= TTS input)')}
                />
                <div className="flex flex-col gap-1 shrink-0">
                  {(e.audioUrl || canAi) && (
                    <button
                      onClick={() => (e.audioUrl ? audit(e) : genOne(i))}
                      className="h-7 w-7 rounded border border-white/10 bg-white/[0.05] text-[11px] hover:bg-white/10 transition-colors"
                      title={e.audioUrl ? t('试听', 'Play') : t('生成配音', 'Generate TTS')}
                    >
                      {genIdx === i ? '⏳' : auditingId === e.id ? '⏸' : e.audioUrl ? '▶' : '🔊'}
                    </button>
                  )}
                  <button onClick={() => deleteEntry(e.id)} className="h-7 w-7 rounded border border-white/10 bg-white/[0.05] text-[11px] text-red-400/80 hover:bg-red-500/10 transition-colors" title={t('删除', 'Delete')}>✕</button>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-1.5 pl-6">
                <span className="text-[11px] text-muted-foreground">{t('时长', 'Dur')}</span>
                <span className="text-[11px] tabular-nums w-12">{(e.durationFrames / fps).toFixed(1)}s</span>
                <span className="text-[11px] text-muted-foreground">{t('起始', 'Start')}</span>
                <div className="w-24"><FrameTimeField value={e.startFrame} fps={fps} onFrameChange={(f) => changeStart(e.id, f)} /></div>
                {e.locked && <span className="text-[10px] text-amber-400/80" title={t('手动定位，不再自动顺排', 'Manually locked')}>🔒</span>}
                <label className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground" title={t('导入配音音频', 'Import audio')}>
                  {e.audioUrl ? '🎵' : '⬆'}
                  <input type="file" accept="audio/*" className="hidden" onChange={(ev) => { const f = ev.target.files?.[0]; if (f) importAudio(e.id, f); ev.target.value = ''; }} />
                </label>
                <span className="text-[10px] text-muted-foreground truncate">
                  {e.status === 'pending' ? t('生成中…', 'Generating…') : e.status === 'error' ? `⚠ ${e.error || 'error'}` : e.audioUrl ? t('配音已就绪', 'TTS ready') : ''}
                </span>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* 字幕样式 */}
      <Section title={t('字幕样式', 'Style')}>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground shrink-0 w-14">{t('字号', 'Size')}</span>
          <NumberInput className="input h-7 w-16 text-xs" value={narration.style.fontSize} step={2} min={12} onCommit={(v) => setStyle({ fontSize: Math.max(12, v) })} />
          <ColorPicker value={narration.style.color} onChange={(c) => setStyle({ color: c })} />
        </div>
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-[11px] text-muted-foreground shrink-0 w-14">{t('描边', 'Stroke')}</span>
          <NumberInput className="input h-7 w-16 text-xs" value={narration.style.strokeWidth} step={1} min={0} onCommit={(v) => setStyle({ strokeWidth: Math.max(0, v) })} />
          <ColorPicker value={narration.style.strokeColor} onChange={(c) => setStyle({ strokeColor: c })} />
        </div>
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-[11px] text-muted-foreground shrink-0 w-14">{t('底部', 'Bottom')}</span>
          <input type="range" min={0} max={40} step={1} value={narration.style.posY} onChange={(e) => setStyle({ posY: parseInt(e.target.value) })} className="flex-1 h-1 accent-[var(--brand)]" />
          <span className="text-[11px] text-muted-foreground w-8 text-right tabular-nums">{narration.style.posY}%</span>
        </div>
        <Field label={t('背景', 'BG')}>
          <OptionBlocks<'none' | 'bar'>
            value={narration.style.bg}
            options={[{ value: 'none', label: t('无', 'None') }, { value: 'bar', label: t('长条', 'Bar') }]}
            onChange={(v) => setStyle({ bg: v })}
          />
        </Field>
        {narration.style.bg === 'bar' && (
          <ColorPicker value={narration.style.bgColor} onChange={(c) => setStyle({ bgColor: c })} />
        )}
      </Section>

      {showAi && <AiScriptDialog chapter={chapter} onClose={() => setShowAi(false)} />}
      {showProviders && <ProviderSettingsDialog kind="tts" onClose={() => setShowProviders(false)} />}
    </>
  );
}

// ========== AI 文案生成 ==========

function AiScriptDialog({ chapter, onClose }: { chapter: Chapter; onClose: () => void }) {
  const t = useT();
  const fps = useChapterFps(chapter);
  const setNarrationEntries = useProjectStore((s) => s.setNarrationEntries);
  const [material, setMaterial] = useState('');
  const [requirement, setRequirement] = useState('');
  const [segCount, setSegCount] = useState(6);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string[]>([]);
  const [showProviders, setShowProviders] = useState(false);

  const gen = async () => {
    const cfg = activeProvider('llm');
    if (!cfg || !cfg.baseUrl) { setShowProviders(true); return; }
    setBusy(true);
    setError(null);
    try {
      const sys = '你是军事/历史题材地图讲解视频的文案写手。根据素材与要求，输出口播文案，拆分成多条字幕。只输出 JSON 数组（字符串数组），每条不超过 40 字，语言与素材一致。';
      const user = [
        material && `【素材】\n${material}`,
        requirement && `【要求】\n${requirement}`,
        `输出 ${segCount} 条字幕（JSON 字符串数组）。`,
      ].filter(Boolean).join('\n\n');
      const raw = await callLLM(cfg, sys, user);
      let arr: string[] = [];
      try {
        const m = raw.match(/\[[\s\S]*\]/);
        arr = JSON.parse(m ? m[0] : raw);
      } catch {
        arr = raw.split('\n').map((l) => l.replace(/^\s*[\d.、-]+\s*/, '').trim()).filter(Boolean);
      }
      setResult(arr.filter((x) => typeof x === 'string' && x.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const apply = (replace: boolean) => {
    const list: NarrationEntry[] = result.map((txt, i) => {
      const dur = estimateTextDurationFrames(txt, fps);
      const prev = i > 0 ? list[i - 1] : null;
      return { id: generateId(), text: txt, durationFrames: dur, startFrame: prev ? prev.startFrame + prev.durationFrames : chapter.startFrame, status: 'none' as const };
    });
    const base = replace ? [] : chapter.narration?.entries || [];
    setNarrationEntries(chapter.id, resequenceEntries([...base, ...list], chapter.startFrame));
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div className="bg-card border border-white/10 rounded-xl shadow-2xl p-4 w-[26rem] max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold mb-2">✨ {t('AI 生成文案', 'AI script')}</h3>
        {(() => {
          const cfg = activeProvider('llm');
          return (
            <button
              onClick={() => setShowProviders(true)}
              className="w-full h-8 px-2.5 rounded-md border border-white/10 bg-white/[0.045] text-xs text-left truncate hover:border-white/25 transition-colors mb-2"
            >
              🤖 {cfg ? `${cfg.label}${cfg.model ? ` · ${cfg.model}` : ''}` : t('未配置 AI 服务（点击设置）', 'Not configured')}
            </button>
          );
        })()}
        <textarea value={material} onChange={(e) => setMaterial(e.target.value)} rows={4} className="input text-xs resize-none mb-2" placeholder={t('粘贴素材/要点/史实资料…', 'Paste source material…')} />
        <input value={requirement} onChange={(e) => setRequirement(e.target.value)} className="input text-xs mb-2" placeholder={t('要求：风格/受众/口吻…', 'Requirements: style/tone…')} />
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[11px] text-muted-foreground shrink-0">{t('段数', 'Lines')}</span>
          <NumberInput className="input h-7 w-16 text-xs" value={segCount} step={1} min={1} onCommit={(v) => setSegCount(Math.max(1, v))} />
          <button onClick={gen} disabled={busy} className="h-7 px-3 rounded-md bg-[var(--brand)] text-white text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-50 ml-auto">
            {busy ? t('生成中…', 'Generating…') : t('生成', 'Generate')}
          </button>
        </div>
        {error && <p className="text-xs text-red-500 mb-2 break-all">{error}</p>}
        {result.length > 0 && (
          <>
            <div className="space-y-1 mb-2 max-h-52 overflow-y-auto">
              {result.map((r, i) => (
                <div key={i} className="flex items-start gap-2 text-xs bg-white/[0.03] rounded p-1.5">
                  <span className="text-muted-foreground tabular-nums">{i + 1}</span>
                  <input value={r} onChange={(e) => setResult(result.map((x, j) => (j === i ? e.target.value : x)))} className="flex-1 bg-transparent outline-none" />
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <button onClick={() => apply(false)} className="flex-1 h-8 rounded-md bg-[var(--brand)] text-white text-xs font-medium hover:opacity-90">{t('追加到字幕', 'Append')}</button>
              <button onClick={() => apply(true)} className="flex-1 h-8 rounded-md border border-white/15 bg-white/[0.05] text-xs hover:bg-white/10">{t('替换全部', 'Replace all')}</button>
            </div>
          </>
        )}
        <button onClick={onClose} className="mt-3 w-full text-xs text-muted-foreground hover:text-foreground">{t('关闭', 'Close')}</button>
      </div>
      {showProviders && <ProviderSettingsDialog kind="llm" onClose={() => setShowProviders(false)} />}
    </div>
  );
}

// ========== 配音 / AI 服务设置（可扩展） ==========

function ProviderSettingsDialog({ kind, onClose }: { kind: 'llm' | 'tts'; onClose: () => void }) {
  const t = useT();
  const list = useProviderStore((s) => (kind === 'llm' ? s.llm : s.tts));
  const activeId = useProviderStore((s) => (kind === 'llm' ? s.activeLlmId : s.activeTtsId));
  const presets = kind === 'llm' ? LLM_PRESETS : TTS_PRESETS;
  const [selId, setSelId] = useState<string | null>(activeId || list[0]?.id || null);
  const sel = list.find((c) => c.id === selId) || null;
  const store = useProviderStore.getState();

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div className="bg-card border border-white/10 rounded-xl shadow-2xl p-4 w-[30rem] max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold mb-2">{kind === 'llm' ? '🤖 ' + t('AI 服务设置', 'AI providers') : '🔊 ' + t('配音服务设置', 'TTS providers')}</h3>
        <p className="text-[11px] text-muted-foreground mb-2">
          {IS_DESKTOP
            ? t('配置存本机 SQLite 数据库；请求经主进程转发（无 CORS）。Key 不出本机。', 'Stored in local SQLite; requests go through the main process. Keys never leave this machine.')
            : t('网页开发模式：浏览器直连，可能被 CORS 拦截；正式使用请用桌面版。', 'Web dev mode: direct browser calls may hit CORS; use the desktop app.')}
        </p>
        <p className="text-[11px] text-muted-foreground mb-2">
          {t('内置常用厂商，可直接添加并填 Key；也可「自定义」接入任何兼容服务。Key 仅存本机浏览器，不会写入项目文件。', 'Built-in presets + custom. Keys stay in this browser only.')}
        </p>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {presets.map((p) => (
            <button key={p.id} onClick={() => setSelId(store.addFromPreset(p.id, kind))} className="h-7 px-2 rounded-md border border-white/10 bg-white/[0.045] text-[11px] hover:border-white/25 transition-colors" title={p.note || p.keyHint}>
              ＋ {p.label}
            </button>
          ))}
        </div>
        {list.length === 0 && <p className="text-xs text-muted-foreground mb-2">{t('点上方厂商按钮添加一个服务。', 'Add a provider above.')}</p>}
        <div className="flex flex-wrap gap-1.5 mb-3">
          {list.map((c) => (
            <div key={c.id} className="flex items-center rounded-md border overflow-hidden" style={{ borderColor: c.id === activeId ? 'var(--brand)' : 'rgba(255,255,255,0.1)' }}>
              <button onClick={() => { store.setActive(kind, c.id); setSelId(c.id); }} className={`h-7 px-2 text-[11px] ${c.id === selId ? 'bg-white/10' : ''} hover:bg-white/10`}>
                {c.id === activeId ? '● ' : ''}{c.label}
              </button>
              <button onClick={() => { store.remove(c.id); if (selId === c.id) setSelId(null); }} className="h-7 px-1.5 text-[11px] text-red-400/80 hover:bg-red-500/10" title={t('删除', 'Delete')}>✕</button>
            </div>
          ))}
        </div>
        {sel && (
          <div className="space-y-2 border-t border-white/10 pt-2">
            <div className="flex gap-2">
              <input value={sel.label} onChange={(e) => store.update(sel.id, { label: e.target.value })} className="input h-7 text-xs flex-1" placeholder={t('名称', 'Label')} />
              <input value={sel.model} onChange={(e) => store.update(sel.id, { model: e.target.value })} className="input h-7 text-xs w-32" placeholder={kind === 'llm' ? t('模型', 'Model') : t('TTS 模型', 'TTS model')} />
            </div>
            <input value={sel.baseUrl} onChange={(e) => store.update(sel.id, { baseUrl: e.target.value })} className="input h-7 text-xs w-full" placeholder="https://…/v1" />
            <input value={sel.apiKey} onChange={(e) => store.update(sel.id, { apiKey: e.target.value })} type="password" className="input h-7 text-xs w-full" placeholder={t('API Key', 'API Key')} />
            {kind === 'tts' && (
              <>
                <div className="flex gap-2">
                  <input value={sel.voice || ''} onChange={(e) => store.update(sel.id, { voice: e.target.value })} className="input h-7 text-xs flex-1" placeholder={t('音色/说话人 ID', 'Voice ID')} />
                  <select value={sel.protocol || 'custom'} onChange={(e) => store.update(sel.id, { protocol: e.target.value as TtsProtocol })} className="input h-7 text-xs w-36">
                    <option value="openai-speech">OpenAI /audio/speech</option>
                    <option value="minimax-t2a">MiniMax t2a_v2</option>
                    <option value="volc-tts">火山 TTS (appid|token)</option>
                    <option value="qwen-tts">DashScope CosyVoice</option>
                    <option value="custom">{t('自定义协议', 'Custom')}</option>
                  </select>
                </div>
                <input value={sel.extra || ''} onChange={(e) => store.update(sel.id, { extra: e.target.value })} className="input h-7 text-xs w-full" placeholder={t('附加 JSON 参数（可选）', 'Extra JSON (optional)')} />
              </>
            )}
            {kind === 'llm' && (
              <input value={sel.extra || ''} onChange={(e) => store.update(sel.id, { extra: e.target.value })} className="input h-7 text-xs w-full" placeholder={t('附加 JSON 参数（可选，如 max_tokens）', 'Extra JSON (optional)')} />
            )}
            <p className="text-[10px] text-muted-foreground">
              {presets.find((p) => sel.label === p.label)?.note || presets.find((p) => sel.label === p.label)?.keyHint || ''}
              {kind === 'tts' && (sel.protocol === 'volc-tts') ? ' Key 填 AppID|AccessToken' : ''}
              {kind === 'tts' && (sel.protocol === 'minimax-t2a') ? ' Key 填 Key&&GroupId' : ''}
            </p>
          </div>
        )}
        <button onClick={onClose} className="mt-3 w-full text-xs text-muted-foreground hover:text-foreground">{t('完成', 'Done')}</button>
      </div>
    </div>
  );
}

// ========== 背景音乐 ==========

function MusicTab({ chapter }: { chapter: Chapter }) {
  const t = useT();
  const fps = useChapterFps(chapter);
  const setMusicTracks = useProjectStore((s) => s.setMusicTracks);
  const updateMusicTrack = useProjectStore((s) => s.updateMusicTrack);
  const [auditingId, setAuditingId] = useState<string | null>(null);
  const tracks = chapter.music || [];
  const chapterDur = chapter.endFrame - chapter.startFrame;

  const importMusic = async (file: File) => {
    try {
      const { dataUrl } = await readAudioFile(file);
      const track: MusicTrack = {
        id: generateId(),
        name: file.name.replace(/\.[^.]+$/, ''),
        url: dataUrl,
        startFrame: 0,
        endFrame: chapterDur,
        volume: 0.6,
        loop: true,
        fadeIn: 1,
        fadeOut: 1,
      };
      setMusicTracks(chapter.id, [...tracks, track]);
    } catch (err) {
      alert(`${t('音频解析失败', 'Audio parse failed')}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const audit = (m: MusicTrack) => {
    if (auditingId) { setAuditingId(null); return; }
    const el = new Audio(m.url);
    el.volume = m.volume;
    el.loop = true;
    setAuditingId(m.id);
    el.onended = () => setAuditingId(null);
    el.play().catch(() => setAuditingId(null));
  };

  return (
    <>
      <Section title={t('音乐轨', 'Music tracks')}>
        <label className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border bg-white/[0.045] text-xs text-foreground/80 hover:border-white/25 cursor-pointer transition-colors w-fit mb-2">
          ⬆ {t('导入音乐', 'Import music')}
          <input type="file" accept="audio/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) importMusic(f); e.target.value = ''; }} />
        </label>
        {tracks.length === 0 && (
          <p className="text-[11px] text-muted-foreground">{t('导入背景音乐（支持多段，可循环、调音量、淡入淡出）。', 'Import BGM (multiple segments, loop, volume, fades).')}</p>
        )}
        <div className="space-y-2">
          {tracks.map((m) => (
            <div key={m.id} className="rounded-md border border-white/10 bg-white/[0.03] p-2 space-y-1.5">
              <div className="flex items-center gap-2">
                <button onClick={() => audit(m)} className="h-7 w-7 rounded border border-white/10 bg-white/[0.05] text-[11px] hover:bg-white/10 transition-colors shrink-0">
                  {auditingId === m.id ? '⏸' : '▶'}
                </button>
                <input value={m.name} onChange={(e) => updateMusicTrack(chapter.id, m.id, { name: e.target.value })} className="flex-1 input h-7 text-xs" placeholder={t('音乐名', 'Name')} />
                <button onClick={() => setMusicTracks(chapter.id, tracks.filter((x) => x.id !== m.id))} className="h-7 w-7 rounded border border-white/10 bg-white/[0.05] text-[11px] text-red-400/80 hover:bg-red-500/10 transition-colors shrink-0">✕</button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground shrink-0">{t('音量', 'Vol')}</span>
                <input type="range" min={0} max={1} step={0.05} value={m.volume} onChange={(e) => updateMusicTrack(chapter.id, m.id, { volume: parseFloat(e.target.value) })} className="flex-1 h-1 accent-[var(--brand)]" />
                <span className="text-[11px] text-muted-foreground w-8 text-right tabular-nums">{Math.round(m.volume * 100)}%</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground shrink-0">{t('区间', 'Range')}</span>
                <div className="w-24"><FrameTimeField value={chapter.startFrame + m.startFrame} fps={fps} onFrameChange={(f) => updateMusicTrack(chapter.id, m.id, { startFrame: Math.max(0, f - chapter.startFrame) })} /></div>
                <span className="text-muted-foreground">→</span>
                <div className="w-24"><FrameTimeField value={chapter.startFrame + m.endFrame} fps={fps} onFrameChange={(f) => updateMusicTrack(chapter.id, m.id, { endFrame: Math.max(chapter.startFrame + m.startFrame + 1, f - chapter.startFrame) })} /></div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground shrink-0">{t('淡入', 'Fade in')}</span>
                <NumberInput className="input h-7 w-14 text-xs" value={m.fadeIn} step={0.5} min={0} onCommit={(v) => updateMusicTrack(chapter.id, m.id, { fadeIn: Math.max(0, v) })} />
                <span className="text-[11px] text-muted-foreground shrink-0">{t('淡出', 'Fade out')}</span>
                <NumberInput className="input h-7 w-14 text-xs" value={m.fadeOut} step={0.5} min={0} onCommit={(v) => updateMusicTrack(chapter.id, m.id, { fadeOut: Math.max(0, v) })} />
                <div className="ml-auto w-28">
                  <Toggle label={t('循环', 'Loop')} checked={m.loop} onChange={(v) => updateMusicTrack(chapter.id, m.id, { loop: v })} />
                </div>
              </div>
            </div>
          ))}
        </div>
      </Section>
      <p className="text-[11px] text-muted-foreground mt-1">
        {t('音乐随当前章节播放；导出 MP4 会混入配音与音乐（Loop 循环）。预览播放时自动同步。', 'Plays with this chapter; mixed into exported MP4. Auto-synced during preview.')}
      </p>
    </>
  );
}

// ========== 面板主体 ==========

const FX_TABS: { id: FxTab; label: string }[] = [
  { id: 'weather', label: '天气' },
  { id: 'screen', label: '画面' },
  { id: 'popup', label: '弹窗' },
  { id: 'title', label: '标题' },
  { id: 'subtitle', label: '字幕' },
  { id: 'music', label: '音乐' },
];

export function FxPanelBody({ chapter }: { chapter: Chapter }) {
  const t = useT();
  const fxTab = useEditorStore((s) => s.fxTab);
  const setFxTab = useEditorStore((s) => s.setFxTab);
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 pt-3 pb-2 shrink-0">
        <OptionBlocks<FxTab>
          value={fxTab}
          onChange={setFxTab}
          options={FX_TABS.map((x) => ({ value: x.id, label: t(x.label, { weather: 'Weather', screen: 'Screen', popup: 'Popup', title: 'Title', subtitle: 'Subs', music: 'Music' }[x.id]) }))}
        />
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-4">
        {fxTab === 'weather' && <WeatherTab chapter={chapter} />}
        {fxTab === 'screen' && <ScreenTab chapter={chapter} />}
        {fxTab === 'popup' && <PopupTab chapter={chapter} />}
        {fxTab === 'title' && <TitleTab chapter={chapter} />}
        {fxTab === 'subtitle' && <SubtitleTab chapter={chapter} />}
        {fxTab === 'music' && <MusicTab chapter={chapter} />}
      </div>
    </div>
  );
}
