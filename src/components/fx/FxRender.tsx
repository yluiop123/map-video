/**
 * 特效窗口的表现层（双端同源）：弹窗卡片 / 屏幕特效层。
 * 编辑器预览（App 内 FxPreviewLayer）与导出端（compositions/MapVideo）调用同一实现，
 * 全部为 frame 的纯渲染（时间相关样式由 lib/screenfx 确定性计算）。
 */
import React, { useEffect, useRef, useState } from 'react';
import type { AnimationPreset, MapVideoProject, OverlayBlock, OverlayContent, OverlayItem, ScreenFxItem, NarrationTrack } from '../../types';
import { normalizePersonContent, normalizeNarrationTrack, POS_BASE } from '../../types';
import { screenFxCombinedAt } from '../../lib/screenfx';
import { FxCanvas } from './FxCanvas';

// ========== 工具 ==========

function hexToRgba(hex: string, alpha: number): string {
  let v = (hex || '#000000').trim();
  if (v.startsWith('rgba') || v.startsWith('rgb')) return v;
  if (!v.startsWith('#')) v = `#${v}`;
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    const r = v[1], g = v[2], b = v[3];
    return `rgba(${parseInt(r + r, 16)},${parseInt(g + g, 16)},${parseInt(b + b, 16)},${alpha})`;
  }
  const m = /^#([0-9a-fA-F]{6})/.exec(v);
  if (!m) return `rgba(12,10,9,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

const ANIM_DUR = 20; // 入/退场动画帧数

/** 单个动画预设 → { 不透明度系数, 位移/缩放 transform 片段 }（progress 0→1） */
function animStyle(preset: AnimationPreset | undefined, progress: number): { op: number; tf: string } {
  const t = Math.max(0, Math.min(1, progress));
  switch (preset) {
    case 'fadeIn': return { op: t, tf: '' };
    case 'fadeOut': return { op: 1 - t, tf: '' };
    case 'popIn': return { op: t, tf: `scale(${0.4 + 0.6 * t})` };
    case 'popOut': return { op: 1 - t, tf: `scale(${1 - 0.6 * t})` };
    case 'scaleIn': return { op: t, tf: `scale(${t})` };
    case 'scaleOut': return { op: 1 - t, tf: `scale(${1 - t})` };
    case 'slideInLeft': return { op: t, tf: `translateX(${(t - 1) * 120}px)` };
    case 'slideInRight': return { op: t, tf: `translateX(${(1 - t) * 120}px)` };
    case 'slideInTop': return { op: t, tf: `translateY(${(t - 1) * 90}px)` };
    case 'slideInBottom': return { op: t, tf: `translateY(${(1 - t) * 90}px)` };
    default: return { op: 1, tf: '' };
  }
}

/** 退场插值：outP 语义=1 停留(完全可见) → 0 消失（与入场预设区分，*Out 系列在此归一） */
function exitStyle(preset: AnimationPreset | undefined, outP: number): { op: number; tf: string } {
  const t = Math.max(0, Math.min(1, outP));
  switch (preset) {
    case 'fadeOut':
    case 'fadeIn':
      return { op: t, tf: '' };
    case 'popOut':
    case 'popIn':
      return { op: t, tf: `scale(${0.4 + 0.6 * t})` };
    case 'scaleOut':
    case 'scaleIn':
      return { op: t, tf: `scale(${t})` };
    case 'slideInLeft': return { op: t, tf: `translateX(${-(1 - t) * 120}px)` };
    case 'slideInRight': return { op: t, tf: `translateX(${(1 - t) * 120}px)` };
    case 'slideInTop': return { op: t, tf: `translateY(${-(1 - t) * 90}px)` };
    case 'slideInBottom': return { op: t, tf: `translateY(${(1 - t) * 90}px)` };
    default: return { op: t, tf: '' };
  }
}

/** 卡片缺省背景（person/chart/list/audio 等卡片型内容；text 裸文字无背景） */
function defaultBg(): NonNullable<OverlayItem['bg']> {
  return { color: '#0c0a09', opacity: 0.78, blur: 10, radius: 14, border: '1px solid rgba(255,255,255,0.10)' };
}

// ========== 弹窗卡片 ==========

export function OverlayCard({ overlay, frame, fps, interactive = false }: {
  overlay: OverlayItem;
  frame: number;
  /** 项目帧率：卡片内按帧计时的动画（如对比条增长）需要它 —— 不能硬编码 30 */
  fps: number;
  /** 编辑器传 true：语音卡片显示可点的播放按钮 */
  interactive?: boolean;
}) {
  if (frame < overlay.startFrame || frame > overlay.endFrame) return null;
  const posId = overlay.position;
  const inA = animStyle(overlay.animation, (frame - overlay.startFrame) / ANIM_DUR);
  const outA = exitStyle(overlay.exitAnimation, (overlay.endFrame - frame) / ANIM_DUR);
  const op = inA.op * outA.op;
  if (op <= 0.01) return null;
  // 位置 = 九宫格标准位（POS_BASE）+ 微调量（offsetX/Y），锚点=盒子中心：左右/上下完全对称
  const clampOff = (v: number) => Math.max(-40, Math.min(40, v));
  const base = POS_BASE[posId] ?? [0, 0];
  const offX = clampOff(base[0] + (overlay.offsetX || 0));
  const offY = clampOff(base[1] + (overlay.offsetY || 0));
  const bg = overlay.bg;
  // 人物卡纯图模式（仅图片块可见）→ 透明浮层，除非用户显式设置了卡片背景
  const cardBg = bg ?? (isImageOnlyPerson(overlay.content) ? undefined : defaultBg());
  const tf = [
    'translate(-50%, -50%)',
    inA.tf, outA.tf, overlay.scale ? `scale(${overlay.scale})` : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      style={{
        position: 'absolute',
        left: `calc(50% + ${offX}%)`,
        top: `calc(50% + ${offY}%)`,
        zIndex: (overlay.zIndex || 0) + 30,
        opacity: op,
        transform: tf || undefined,
        transformOrigin: 'center',
        width: 'max-content',
        maxWidth: '86%',
        pointerEvents: interactive ? 'auto' : undefined,
      }}
    >
      <div
        style={{
          ...(cardBg ? {
            background: hexToRgba(cardBg.color, cardBg.opacity ?? 0.78),
            backdropFilter: cardBg.blur ? `blur(${cardBg.blur}px)` : undefined,
            WebkitBackdropFilter: cardBg.blur ? `blur(${cardBg.blur}px)` : undefined,
            borderRadius: cardBg.radius ?? 14,
            border: cardBg.border,
          } : {}),
          padding: cardBg ? 16 : undefined,
          boxSizing: 'border-box',
          maxWidth: '100%',
        }}
      >
        <OverlayContentView content={overlay.content} frame={frame} local={frame - overlay.startFrame} interactive={interactive} fps={fps} />
      </div>
    </div>
  );
}

function OverlayContentView({ content, frame, local, fps, interactive }: { content: OverlayContent; frame: number; local: number; fps: number; interactive: boolean }) {
  switch (content.type) {
    case 'custom':
      return <CustomView content={content} frame={frame} interactive={interactive} />;
    case 'person':
      return <PersonView content={content} interactive={interactive} />;
    case 'timeline':
      return <TimelineView content={content} local={local} />;
    case 'quote':
      return <QuoteView content={content} />;
    case 'compare':
      return <CompareView content={content} local={local} fps={fps} />;
    case 'chart':
      return <ChartView content={content} local={local} />;
    case 'stat':
      return <StatView content={content} local={local} fps={fps} />;
    default:
      return null;
  }
}

// ========== 人物卡（精简） ==========

/** 纯图模式：仅照片、无任何文字（透明浮层，无卡片背景） */
function isImageOnlyPerson(c: OverlayContent): boolean {
  if (c.type !== 'person' || !c.person) return false;
  const p = normalizePersonContent(c.person);
  return p.showImage && !!p.imageUrl && !p.name && !p.title && !p.intro && !p.quote;
}

/** 人物卡：4 种常用样式（简介/名言/海报/纯文字）+ 少量参数；照片形状与方位可调 */
function PersonView({ content, interactive }: { content: OverlayContent; interactive: boolean }) {
  const p = normalizePersonContent(content.person);
  const audio = p.audioUrl ? <AutoAudio url={p.audioUrl} interactive={interactive} /> : null;
  const radius = p.imageShape === 'circle' ? 999 : 10;

  const avatar = (size: number) =>
    p.imageUrl ? (
      <img src={p.imageUrl} alt="" style={{ width: size, height: size, objectFit: 'cover', borderRadius: radius, display: 'block', flexShrink: 0 }} />
    ) : (
      <div style={{ width: size, height: size, borderRadius: radius, background: 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.42, flexShrink: 0 }}>👤</div>
    );

  const nameEl = p.name ? <div style={{ color: '#fff', fontSize: 18, fontWeight: 700, lineHeight: 1.25 }}>{p.name}</div> : null;
  const titleEl = p.title ? <div style={{ color: '#a8a29e', fontSize: 12, lineHeight: 1.3 }}>{p.title}</div> : null;
  const introEl = p.intro ? <div style={{ color: '#d6d3d1', fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{p.intro}</div> : null;
  const quoteEl = p.quote ? (
    <div style={{ color: '#f5f5f4', fontSize: 16, fontWeight: 600, lineHeight: 1.5, whiteSpace: 'pre-wrap', fontStyle: 'italic' }}>“{p.quote}”</div>
  ) : null;

  // 海报大图：大图 + 底部压暗叠加姓名/职务/简介
  if (p.style === 'poster' && p.showImage) {
    return (
      <div style={{ position: 'relative', width: 380, maxWidth: '100%' }}>
        {p.imageUrl ? (
          <img src={p.imageUrl} alt="" style={{ width: '100%', height: 240, objectFit: 'cover', borderRadius: 12, display: 'block' }} />
        ) : (
          <div style={{ width: '100%', height: 240, borderRadius: 12, background: 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 72 }}>👤</div>
        )}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 14, borderRadius: '0 0 12px 12px', background: 'linear-gradient(transparent, rgba(0,0,0,0.72))', display: 'flex', flexDirection: 'column', gap: 3 }}>
          {nameEl}
          {titleEl}
          {p.intro ? <div style={{ color: '#e7e5e4', fontSize: 12.5, lineHeight: 1.5 }}>{p.intro}</div> : null}
        </div>
        {audio}
      </div>
    );
  }

  // 名言台词：居中大字引用（可选小头像）
  if (p.style === 'quote') {
    return (
      <div style={{ width: 360, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', textAlign: 'center' }}>
        {p.showImage ? avatar(84) : null}
        {quoteEl}
        {(nameEl || titleEl) ? <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>{nameEl}{titleEl}</div> : null}
        {audio}
      </div>
    );
  }

  // 纯文字：仅文字
  if (p.style === 'text') {
    return <div style={{ width: 340, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>{nameEl}{titleEl}{introEl}{quoteEl}{audio}</div>;
  }

  // 人物简介（默认）：左/右 照片 + 文字
  const info = <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>{nameEl}{titleEl}{introEl}{quoteEl}</div>;
  if (!p.showImage) return <div style={{ width: 340, maxWidth: '100%' }}>{info}{audio}</div>;
  return (
    <div style={{ width: 380, maxWidth: '100%', display: 'flex', flexDirection: p.imageSide === 'right' ? 'row-reverse' : 'row', gap: 14, alignItems: 'flex-start' }}>
      {avatar(84)}
      {info}
      {audio}
    </div>
  );
}

/** 语音卡片：确定性律动条 + 标题；编辑端可点播放（导出为纯视觉卡片） */
function AudioCardView({ audio, frame, interactive }: { audio?: { url: string; title?: string }; frame: number; interactive: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) { el.pause(); setPlaying(false); }
    else { el.play().then(() => setPlaying(true)).catch(() => setPlaying(false)); }
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 220 }}>
      <button
        type="button"
        onClick={interactive ? toggle : undefined}
        style={{
          width: 40, height: 40, borderRadius: 999, border: 'none', cursor: interactive ? 'pointer' : 'default',
          background: 'rgba(76,158,255,0.9)', color: '#fff', fontSize: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: '#fff', fontSize: 14, fontWeight: 600, marginBottom: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {audio?.title || '语音'}
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 22 }}>
          {Array.from({ length: 28 }, (_, i) => {
            const hgt = 4 + Math.abs(Math.sin(frame * 0.21 + i * 1.31) * Math.sin(i * 0.53 + 1.2)) * 18;
            return <span key={i} style={{ width: 3, borderRadius: 2, background: 'rgba(76,158,255,0.75)', height: hgt }} />;
          })}
        </div>
      </div>
      {audio?.url && interactive && <audio ref={audioRef} src={audio.url} onEnded={() => setPlaying(false)} style={{ display: 'none' }} />}
    </div>
  );
}

// ========== 图表（全部帧驱动动画，双端确定性一致） ==========

const CHART_PALETTE = ['#4C9EFF', '#51CF66', '#FFA94D', '#F783AC', '#B197FC', '#66D9E8'];
type ChartCfg = NonNullable<OverlayContent['chart']>;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** 千分位整数字符串（不用 toLocaleString，保证导出端一致） */
const fmtInt = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function ChartView({ content, local }: { content: OverlayContent; local: number }) {
  const chart = content.chart;
  if (!chart || chart.data.length === 0) return null;
  const prog = clamp01((local - 6) / 48); // 稍候入场后开始生长
  const color = chart.color || '#4C9EFF';
  const color2 = chart.color2 || '#F87171';
  switch (chart.type) {
    case 'pie': return <PieChart chart={chart} color={color} progress={prog} />;
    case 'donut': return <DonutChart chart={chart} color={color} progress={prog} />;
    case 'line': return <LineChart chart={chart} color={color} progress={prog} area={false} />;
    case 'area': return <LineChart chart={chart} color={color} progress={prog} area />;
    case 'bar': return <BarChart chart={chart} color={color} progress={prog} />;
    case 'hbar': return <HBarChart chart={chart} color={color} progress={prog} />;
    case 'radar': return <RadarChart chart={chart} color={color} color2={color2} progress={prog} />;
    case 'gauge': return <GaugeChart chart={chart} color={color} progress={prog} />;
    case 'vs': return <VsChart chart={chart} color={color} color2={color2} progress={prog} />;
    default: return null;
  }
}

function ChartTitle({ title }: { title?: string }) {
  if (!title) return null;
  return <div style={{ color: '#fff', fontSize: 15, fontWeight: 700, marginBottom: 10, textAlign: 'center' }}>{title}</div>;
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {items.map((it, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: it.color, flexShrink: 0 }} />
          <span style={{ color: '#d6d3d1', fontSize: 12 }}>{it.label}</span>
        </div>
      ))}
    </div>
  );
}

/** 饼图：扇形随进度按角度扫出 */
function PieChart({ chart, color, progress }: { chart: ChartCfg; color: string; progress: number }) {
  const data = chart.data;
  const palette = [color, ...CHART_PALETTE.slice(1)];
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const sweep = progress * 2 * Math.PI - 0.0001;
  let acc = 0;
  const sectors = data.map((d, i) => {
    const start = (acc / total) * 2 * Math.PI;
    acc += d.value;
    const end = Math.min((acc / total) * 2 * Math.PI, sweep);
    return { d, i, start, end, color: palette[i % palette.length] };
  }).filter((s) => s.end > s.start);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <svg width={104} height={104} viewBox="0 0 100 100">
        {sectors.map((s) => {
          const large = s.end - s.start > Math.PI ? 1 : 0;
          const x1 = 50 + 40 * Math.cos(s.start), y1 = 50 + 40 * Math.sin(s.start);
          const x2 = 50 + 40 * Math.cos(s.end), y2 = 50 + 40 * Math.sin(s.end);
          return <path key={s.i} d={`M50 50 L${x1.toFixed(2)} ${y1.toFixed(2)} A40 40 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`} fill={s.color} />;
        })}
      </svg>
      <Legend items={data.map((d, i) => ({ label: `${d.label} ${fmtInt(d.value)}`, color: palette[i % palette.length] }))} />
    </div>
  );
}

/** 环形图：圆弧随进度扫出 */
function DonutChart({ chart, color, progress }: { chart: ChartCfg; color: string; progress: number }) {
  const data = chart.data;
  const palette = [color, ...CHART_PALETTE.slice(1)];
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const sweep = progress * 2 * Math.PI - 0.0001;
  let acc = 0;
  const arcs = data.map((d, i) => {
    const start = (acc / total) * 2 * Math.PI;
    acc += d.value;
    const end = Math.min((acc / total) * 2 * Math.PI, sweep);
    return { d, i, start, end, color: palette[i % palette.length] };
  }).filter((s) => s.end > s.start);
  const R = 36, C = 50;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <svg width={110} height={110} viewBox="0 0 100 100">
        {arcs.map((s) => {
          const large = s.end - s.start > Math.PI ? 1 : 0;
          const x1 = C + R * Math.cos(s.start), y1 = C + R * Math.sin(s.start);
          const x2 = C + R * Math.cos(s.end), y2 = C + R * Math.sin(s.end);
          return <path key={s.i} d={`M${x1.toFixed(2)} ${y1.toFixed(2)} A${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`} fill="none" stroke={s.color} strokeWidth={13} />;
        })}
      </svg>
      <Legend items={data.map((d, i) => ({ label: `${d.label} ${fmtInt(d.value)}`, color: palette[i % palette.length] }))} />
    </div>
  );
}

/** 折线/面积：逐点绘制（按折线总长截断），带坐标轴 */
function LineChart({ chart, color, progress, area }: { chart: ChartCfg; color: string; progress: number; area: boolean }) {
  const data = chart.data;
  if (data.length < 2) return null;
  const W = 320, H = 176, padL = 42, padR = 12, padT = 14, padB = 26;
  const maxV = Math.max(...data.map((d) => d.value)) * 1.12 || 1;
  const xOf = (i: number) => padL + (i / (data.length - 1)) * (W - padL - padR);
  const yOf = (v: number) => H - padB - (v / maxV) * (H - padT - padB);
  const pts = data.map((d, i) => ({ x: xOf(i), y: yOf(d.value) }));
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const drawn = (cum[cum.length - 1] || 1) * progress;
  const linePts: string[] = [];
  let shown = pts.length;
  for (let i = 0; i < pts.length; i++) {
    if (cum[i] <= drawn) { linePts.push(`${pts[i].x.toFixed(1)},${pts[i].y.toFixed(1)}`); continue; }
    const t = (drawn - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    const x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t;
    const y = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t;
    linePts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    shown = i;
    break;
  }
  const ticks = 3;
  const baseline = H - padB;
  return (
    <div>
      <ChartTitle title={chart.title} />
      <svg width={W} height={H} style={{ display: 'block' }}>
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const v = (maxV / ticks) * i;
          const y = yOf(v);
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="rgba(255,255,255,0.10)" strokeWidth={1} />
              <text x={padL - 5} y={y + 3} textAnchor="end" fill="#a8a29e" fontSize={9}>{fmtInt(v)}</text>
            </g>
          );
        })}
        {area && linePts.length >= 2 && (
          <polygon
            points={`${linePts.join(' ')} ${linePts[linePts.length - 1].split(',')[0]},${baseline} ${pts[0].x.toFixed(1)},${baseline}`}
            fill={hexToRgba(color, 0.2)}
          />
        )}
        <polyline points={linePts.join(' ')} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
        {pts.map((pt, i) => (i < shown ? <circle key={i} cx={pt.x} cy={pt.y} r={3} fill={color} /> : null))}
        {data.map((d, i) => (
          <text key={i} x={xOf(i)} y={H - 8} textAnchor="middle" fill="#a8a29e" fontSize={9}>{d.label}</text>
        ))}
      </svg>
    </div>
  );
}

/** 柱状图：竖柱逐根错峰生长 */
function BarChart({ chart, color, progress }: { chart: ChartCfg; color: string; progress: number }) {
  const data = chart.data;
  if (!data.length) return null;
  const W = 320, H = 190, padL = 42, padR = 12, padT = 16, padB = 26;
  const maxV = Math.max(...data.map((d) => d.value)) * 1.12 || 1;
  const slot = (W - padL - padR) / data.length;
  const bw = Math.min(40, slot * 0.6);
  const ticks = 3;
  return (
    <div>
      <ChartTitle title={chart.title} />
      <svg width={W} height={H} style={{ display: 'block' }}>
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const v = (maxV / ticks) * i;
          const y = H - padB - (v / maxV) * (H - padT - padB);
          return (
            <g key={i}>
              <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="rgba(255,255,255,0.10)" strokeWidth={1} />
              <text x={padL - 5} y={y + 3} textAnchor="end" fill="#a8a29e" fontSize={9}>{fmtInt(v)}</text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const cx = padL + (i + 0.5) * slot;
          const p = clamp01(progress * (data.length + 2) - i);
          const h = (d.value / maxV) * (H - padT - padB) * p;
          return (
            <g key={i}>
              <rect x={cx - bw / 2} y={H - padB - h} width={bw} height={h} rx={3} fill={color} opacity={0.92} />
              {p >= 1 && <text x={cx} y={H - padB - h - 4} textAnchor="middle" fill="#e7e5e4" fontSize={10}>{fmtInt(d.value)}</text>}
              <text x={cx} y={H - 8} textAnchor="middle" fill="#a8a29e" fontSize={10}>{d.label}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** 横向条形：条长逐行错峰生长 */
function HBarChart({ chart, color, progress }: { chart: ChartCfg; color: string; progress: number }) {
  const data = chart.data;
  if (!data.length) return null;
  const maxV = Math.max(...data.map((d) => d.value)) || 1;
  return (
    <div style={{ minWidth: 300 }}>
      <ChartTitle title={chart.title} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {data.map((d, i) => {
          const p = clamp01(progress * (data.length + 2) - i);
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: '#a8a29e', fontSize: 11, width: 64, textAlign: 'right', flexShrink: 0 }}>{d.label}</span>
              <div style={{ flex: 1, background: 'rgba(255,255,255,0.08)', borderRadius: 4, height: 16, overflow: 'hidden' }}>
                <div style={{ width: `${(d.value / maxV) * 100 * p}%`, height: '100%', background: color, borderRadius: 4 }} />
              </div>
              <span style={{ color: '#d6d3d1', fontSize: 11, width: 48, flexShrink: 0 }}>{p > 0.98 ? fmtInt(d.value) : ''}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 雷达图：网格+多边形随进度展开（data2 可叠加第二系列对比） */
function RadarChart({ chart, color, color2, progress }: { chart: ChartCfg; color: string; color2: string; progress: number }) {
  const data = chart.data;
  const data2 = chart.data2;
  const n = data.length;
  if (n < 3) return null;
  const S = 216, C = S / 2, R = 64;
  const maxV = Math.max(...data.map((d) => d.value), ...(data2 || []).map((d) => d.value)) * 1.1 || 1;
  const ang = (i: number) => (i / n) * 2 * Math.PI - Math.PI / 2;
  const poly = (arr: { value: number }[]) => arr.map((d, i) => {
    const r = R * clamp01(d.value / maxV) * progress;
    return `${(C + Math.cos(ang(i)) * r).toFixed(1)},${(C + Math.sin(ang(i)) * r).toFixed(1)}`;
  }).join(' ');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <svg width={S} height={S} style={{ display: 'block' }}>
        {[1 / 3, 2 / 3, 1].map((k, ki) => (
          <polygon
            key={ki}
            points={data.map((_, i) => `${(C + Math.cos(ang(i)) * R * k).toFixed(1)},${(C + Math.sin(ang(i)) * R * k).toFixed(1)}`).join(' ')}
            fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth={1}
          />
        ))}
        {data.map((_, i) => (
          <line key={i} x1={C} y1={C} x2={C + Math.cos(ang(i)) * R} y2={C + Math.sin(ang(i)) * R} stroke="rgba(255,255,255,0.10)" strokeWidth={1} />
        ))}
        {data2 && data2.length >= 3 && <polygon points={poly(data2)} fill={hexToRgba(color2, 0.16)} stroke={color2} strokeWidth={2} />}
        <polygon points={poly(data)} fill={hexToRgba(color, 0.25)} stroke={color} strokeWidth={2} />
        {data.map((d, i) => {
          const lx = C + Math.cos(ang(i)) * (R + 18), ly = C + Math.sin(ang(i)) * (R + 18);
          return <text key={i} x={lx} y={ly + 3} textAnchor="middle" fill="#a8a29e" fontSize={10}>{d.label}</text>;
        })}
      </svg>
      {data2 && (
        <Legend items={[{ label: '系列 1', color }, { label: '系列 2', color: color2 }]} />
      )}
    </div>
  );
}

/** 仪表盘：240° 进度弧扫到值位 */
function GaugeChart({ chart, color, progress }: { chart: ChartCfg; color: string; progress: number }) {
  const v = chart.data[0]?.value || 0;
  const maxV = Math.max(100, v);
  const W = 190, H = 140, C = 95, R = 58;
  const A0 = Math.PI * 0.75, A1 = Math.PI * 2.25;
  const sweepEnd = A0 + (A1 - A0) * clamp01(v / maxV) * progress;
  const arcPath = (a0: number, a1: number) => {
    const x0 = C + R * Math.cos(a0), y0 = C + R * Math.sin(a0);
    const x1 = C + R * Math.cos(a1), y1 = C + R * Math.sin(a1);
    return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${R} ${R} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  };
  return (
    <div style={{ textAlign: 'center' }}>
      <ChartTitle title={chart.title} />
      <svg width={W} height={H} style={{ display: 'block' }}>
        <path d={arcPath(A0, A1)} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth={11} strokeLinecap="round" />
        {sweepEnd > A0 + 0.02 && <path d={arcPath(A0, sweepEnd)} fill="none" stroke={color} strokeWidth={11} strokeLinecap="round" />}
        <text x={C} y={C + 8} textAnchor="middle" fill="#fff" fontSize={27} fontWeight={800}>{fmtInt(v * progress)}</text>
        <text x={C} y={C + 26} textAnchor="middle" fill="#a8a29e" fontSize={10}>{chart.data[0]?.label || ''}</text>
      </svg>
    </div>
  );
}

/** 双向对比条形：中轴标签，左右两系列背向生长 */
function VsChart({ chart, color, color2, progress }: { chart: ChartCfg; color: string; color2: string; progress: number }) {
  const data = chart.data, data2 = chart.data2;
  if (!data.length) return null;
  const mx = Math.max(...data.map((d) => d.value), ...(data2 || []).map((d) => d.value)) || 1;
  return (
    <div style={{ minWidth: 340 }}>
      <ChartTitle title={chart.title} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {data.map((d, i) => {
          const p = clamp01(progress * (data.length + 2) - i);
          const v2 = data2?.[i]?.value || 0;
          return (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 76px 1fr', alignItems: 'center', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, minWidth: 0 }}>
                <span style={{ color: '#e7e5e4', fontSize: 11 }}>{p > 0.6 ? fmtInt(d.value) : ''}</span>
                <div style={{ width: '70%', display: 'flex', justifyContent: 'flex-end' }}>
                  <div style={{ width: `${(d.value / mx) * 100 * p}%`, height: 14, background: color, borderRadius: '4px 0 0 4px' }} />
                </div>
              </div>
              <span style={{ textAlign: 'center', color: '#a8a29e', fontSize: 11 }}>{d.label}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <div style={{ width: '70%' }}>
                  <div style={{ width: `${(v2 / mx) * 100 * p}%`, height: 14, background: color2, borderRadius: '0 4px 4px 0' }} />
                </div>
                <span style={{ color: '#e7e5e4', fontSize: 11 }}>{data2?.[i] && p > 0.6 ? fmtInt(v2) : ''}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ========== 预设卡片视图 ==========

/** 语音自动播放（编辑端）：挂载即播放，卸载即停；导出端不渲染音频 */
function AutoAudio({ url, interactive }: { url: string; interactive: boolean }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    el.currentTime = 0;
    el.play().then(() => { if (!cancelled) { setPlaying(true); setStarted(true); } }).catch(() => { if (!cancelled) setStarted(false); });
    return () => { cancelled = true; try { el.pause(); } catch { /* noop */ } };
  }, []);
  const toggle = () => {
    const el = ref.current;
    if (!el) return;
    if (playing) { el.pause(); setPlaying(false); }
    else { el.play().then(() => setPlaying(true)).catch(() => { /* noop */ }); }
  };
  if (!interactive) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
      <button
        type="button"
        onClick={toggle}
        style={{
          width: 22, height: 22, borderRadius: 999, border: 'none', cursor: 'pointer',
          background: 'rgba(76,158,255,0.9)', color: '#fff', fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}
      >
        {playing ? '❚❚' : '▶'}
      </button>
      <span style={{ color: '#a8a29e', fontSize: 11 }}>{started ? (playing ? '语音播放中' : '语音') : '点击播放语音'}</span>
      <audio ref={ref} src={url} style={{ display: 'none' }} />
    </div>
  );
}

/** 自定义块：文字 / 图片 / 视频 */
function BlockView({ b }: { b: OverlayBlock }) {
  if (b.type === 'image') {
    return b.url ? <img src={b.url} alt="" style={{ display: 'block', maxWidth: '100%', maxHeight: 320, borderRadius: 10 }} /> : null;
  }
  if (b.type === 'video') {
    return b.url ? (
      <video src={b.url} autoPlay loop muted playsInline style={{ display: 'block', maxWidth: '100%', maxHeight: 320, borderRadius: 10 }} />
    ) : null;
  }
  const tx = b.text;
  return (
    <div style={{
      color: tx?.color || '#FFFFFF', fontSize: tx?.fontSize || 16, fontWeight: tx?.bold ? 700 : 400,
      textAlign: tx?.align || 'left', whiteSpace: 'pre-wrap', lineHeight: 1.45, textShadow: '0 1px 6px rgba(0,0,0,0.6)',
    }}>
      {tx?.content}
    </div>
  );
}

function CustomView({ content, frame, interactive }: { content: OverlayContent; frame: number; interactive: boolean }) {
  const cust = content.custom;
  const blocks = cust?.blocks || [];
  if (!blocks.length) {
    return cust?.audio?.url
      ? <AudioCardView audio={cust.audio} frame={frame} interactive={interactive} />
      : <span style={{ color: '#a8a29e', fontSize: 13 }}>空卡片</span>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 160, maxWidth: 460 }}>
      {blocks.map((b) => <BlockView key={b.id} b={b} />)}
      {cust?.audio?.url && <AutoAudio url={cust.audio.url} interactive={interactive} />}
    </div>
  );
}

function TimelineView({ content, local }: { content: OverlayContent; local: number }) {
  const tl = content.timeline;
  const items = tl?.items || [];
  return (
    <div style={{ minWidth: 220, maxWidth: 380 }}>
      {tl?.title && <div style={{ color: '#fff', fontSize: 15, fontWeight: 700, marginBottom: 10 }}>{tl.title}</div>}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {items.map((it, i) => {
          const op = clamp01((local - 8 - i * 8) / 10);
          const last = i === items.length - 1;
          return (
            <div key={i} style={{ display: 'flex', gap: 10, opacity: op }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 10, flexShrink: 0 }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: '#4C9EFF', marginTop: 5, boxShadow: '0 0 6px rgba(76,158,255,0.8)' }} />
                {!last && <span style={{ flex: 1, width: 1, minHeight: 14, background: 'rgba(255,255,255,0.18)' }} />}
              </div>
              <div style={{ paddingBottom: last ? 0 : 10 }}>
                {it.time && <span style={{ color: '#4C9EFF', fontSize: 12, fontFamily: "'Courier New', monospace", marginRight: 8 }}>{it.time}</span>}
                <span style={{ color: '#e7e5e4', fontSize: 13.5, lineHeight: 1.55 }}>{it.text}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function QuoteView({ content }: { content: OverlayContent }) {
  const q = content.quote;
  return (
    <div style={{ maxWidth: 400 }}>
      <div style={{ fontSize: 34, color: '#4C9EFF', lineHeight: 0.7, marginBottom: 6 }}>❝</div>
      <div style={{ color: '#f5f5f4', fontSize: 16, lineHeight: 1.7 }}>{q?.text}</div>
      {q?.source && <div style={{ color: '#a8a29e', fontSize: 12, marginTop: 8, textAlign: 'right' }}>—— {q.source}</div>}
    </div>
  );
}

function CompareView({ content, local, fps }: { content: OverlayContent; local: number; fps: number }) {
  const cp = content.compare;
  const l = cp?.left, r = cp?.right;
  const mx = Math.max(l?.value || 0, r?.value || 0) || 1;
  // 增长动画时长 = 1 秒（按项目帧率换算，此前硬编码 /30，换帧率的项目时长会变）
  const p = clamp01(local / fps);
  const unit = cp?.unit ? <span style={{ fontSize: 13, fontWeight: 400, color: '#a8a29e', marginLeft: 3 }}>{cp.unit}</span> : null;
  return (
    <div style={{ minWidth: 260 }}>
      {cp?.title && <div style={{ color: '#fff', fontSize: 15, fontWeight: 700, marginBottom: 10, textAlign: 'center' }}>{cp.title}</div>}
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 10 }}>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ color: '#a8a29e', fontSize: 12, marginBottom: 2 }}>{l?.label}</div>
          <div style={{ color: '#4C9EFF', fontSize: 26, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{fmtInt(l?.value || 0)}{unit}</div>
          <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.08)', marginTop: 6, overflow: 'hidden' }}>
            <div style={{ height: '100%', background: '#4C9EFF', width: `${((l?.value || 0) / mx) * 100 * p}%` }} />
          </div>
        </div>
        <div style={{ alignSelf: 'center', color: '#a8a29e', fontWeight: 800, fontSize: 13 }}>VS</div>
        <div style={{ flex: 1, textAlign: 'center' }}>
          <div style={{ color: '#a8a29e', fontSize: 12, marginBottom: 2 }}>{r?.label}</div>
          <div style={{ color: '#F87171', fontSize: 26, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{fmtInt(r?.value || 0)}{unit}</div>
          <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.08)', marginTop: 6, overflow: 'hidden' }}>
            <div style={{ height: '100%', background: '#F87171', width: `${((r?.value || 0) / mx) * 100 * p}%`, marginLeft: 'auto' }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function StatView({ content, local, fps }: { content: OverlayContent; local: number; fps: number }) {
  const s = content.stat;
  const target = s?.value ?? 0;
  const p = s?.countUp === false ? 1 : clamp01(local / fps);
  const shown = s?.countUp === false ? target : Math.round(target * (1 - Math.pow(1 - p, 3)));
  return (
    <div style={{ textAlign: 'center', minWidth: 180 }}>
      {s?.label && <div style={{ color: '#a8a29e', fontSize: 12, marginBottom: 2 }}>{s.label}</div>}
      <div style={{ color: '#fff', fontSize: 40, fontWeight: 800, lineHeight: 1.05, fontVariantNumeric: 'tabular-nums' }}>
        {s?.prefix || ''}{fmtInt(shown)}
        {s?.unit && <span style={{ fontSize: 16, fontWeight: 600, color: '#e7e5e4', marginLeft: 4 }}>{s.unit}</span>}
      </div>
    </div>
  );
}


// ========== 屏幕特效层（天气/云层/闪光/暗角/黑白场；震动由调用方做 transform） ==========

export function ScreenFxLayer({ fxList, frame, fps }: { fxList: ScreenFxItem[] | undefined; frame: number; fps: number }) {
  const state = screenFxCombinedAt(fxList, frame, fps);
  return (
    <>
      {/* 天气（画布，位于弹窗之下） */}
      {(fxList || []).map((fx) =>
        fx.kind === 'weather' && fx.weather ? <FxCanvas key={fx.id} fx={fx} frame={frame} fps={fps} style={{ zIndex: 8 }} /> : null,
      )}
      {/* 云层散开（盖住地图，低于编辑器 UI/弹窗/标题，随进度消散） */}
      {state.cloud && (fxList || []).map((fx) =>
        fx.kind === 'screen' && fx.effect?.type === 'cloudReveal' ? <FxCanvas key={fx.id} fx={fx} frame={frame} fps={fps} style={{ zIndex: 12 }} /> : null,
      )}
      {/* 全屏叠加：flash / fadeBlack / fadeWhite / vignette */}
      {state.overlay && (() => {
        const ov = state.overlay;
        let style: React.CSSProperties;
        if (ov.color === 'vignette') {
          // 强度越大中心亮区越小（inner 为亮区半径%），边缘渐变更实
          const inner = ov.inner ?? 52;
          const mid = inner + (100 - inner) / 2;
          const edge = Math.min(0.92, ov.opacity);
          style = { background: `radial-gradient(ellipse at center, rgba(0,0,0,0) ${inner}%, rgba(0,0,0,${(edge * 0.55).toFixed(3)}) ${mid.toFixed(1)}%, rgba(0,0,0,${edge}) 100%)` };
        } else {
          style = { background: ov.color, opacity: ov.opacity };
        }
        return <div style={{ position: 'absolute', inset: 0, zIndex: 16, pointerEvents: 'none', ...style }} />;
      })()}
    </>
  );
}

/** 编辑器舞台预览层：弹窗卡片 + 屏幕特效 + 字幕（不含震动 transform，调用方处理） */
export function FxPreviewLayer({ project, frame, fps }: { project: MapVideoProject; frame: number; fps: number }) {
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      {(project.overlays || []).map((o) => (
        <OverlayCard key={o.id} overlay={o} frame={frame} fps={fps} interactive />
      ))}
      <SubtitleLayer narration={project.narration} frame={frame} fps={fps} />
      <ScreenFxLayer fxList={project.fx} frame={frame} fps={fps} />
    </div>
  );
}

// ========== 字幕层（配音时长决定显示时长；编辑器/导出同源） ==========

export function SubtitleLayer({
  narration,
  frame,
  fps,
}: {
  narration: NarrationTrack | undefined;
  /** 项目绝对帧（与条目 startFrame 同基准） */
  frame: number;
  fps: number;
}) {
  const track = narration ? normalizeNarrationTrack(narration) : null;
  if (!track || track.entries.length === 0) return null;
  const active = track.entries.find((e) => frame >= e.startFrame && frame < e.startFrame + e.durationFrames);
  if (!active || !active.text.trim()) return null;
  const st = track.style;
  // 进出各 6 帧淡入淡出
  const fadeIn = Math.min(1, (frame - active.startFrame) / Math.max(1, Math.min(6, fps * 0.2)));
  const fadeOut = Math.min(1, (active.startFrame + active.durationFrames - frame) / Math.max(1, Math.min(6, fps * 0.2)));
  const op = Math.min(fadeIn, fadeOut);
  const barBg: React.CSSProperties =
    st.bg === 'bar'
      ? { background: hexToRgba(st.bgColor, 0.55), padding: '8px 20px', borderRadius: 6 }
      : {};
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 60,
        pointerEvents: 'none',
        opacity: op,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        paddingBottom: `${st.posY}%`,
      }}
    >
      <div
        style={{
          ...barBg,
          width: 'max-content',
          maxWidth: `${st.maxPct}%`,
          textAlign: 'center',
          color: st.color,
          fontFamily: st.fontFamily || "'KaiTi', 'STKaiti', 'SimSun', serif",
          fontSize: st.fontSize,
          fontWeight: 500,
          lineHeight: 1.35,
          WebkitTextStroke: st.strokeWidth > 0 ? `${st.strokeWidth * 0.4}px ${st.strokeColor}` : undefined,
          paintOrder: 'stroke fill',
          textShadow: st.strokeWidth > 0 ? `0 1px 6px rgba(0,0,0,${Math.min(0.9, st.strokeWidth / 10)})` : undefined,
        }}
      >
        {active.text}
      </div>
    </div>
  );
}
