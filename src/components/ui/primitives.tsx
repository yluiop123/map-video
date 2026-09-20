/**
 * 共享 UI 基础组件（Mapimator Studio 深色风格对齐）
 * 此前 Section/Field/StyleGrid/Toggle 在 PropertiesPanel 与 KeyframePanel 各有一份，收敛于此统一维护。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditorStore } from '../../stores/editorStore';
import { TW_COLUMN_500, TW_FAMILIES, TW_MONO, TW_SHADES, twLabelOf } from '../../lib/tw-colors';

/** 属性面板双语标签：t('中文', 'English')，随顶栏语言切换 */
export function useT() {
  const lang = useEditorStore((s) => s.lang);
  return (zh: string, en: string) => (lang === 'en' ? en : zh);
}

export function Section({ title, icon, children, className = '' }: {
  title?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`border-t border-white/[0.06] pt-3 first:border-t-0 first:pt-0 ${className}`}>
      {title && (
        <h3 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2">
          {icon}
          {title}
        </h3>
      )}
      {children}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2 last:mb-0">
      <label className="text-[11px] font-medium text-muted-foreground block mb-1">{label}</label>
      {children}
    </div>
  );
}

export function StyleGrid<T extends string>({ value, options, onChange, cols = 3 }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  cols?: number;
}) {
  return (
    <div className={`grid gap-1.5`} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`flex items-center justify-center gap-1 px-1 py-1.5 text-[11px] font-medium rounded-md border truncate transition-colors ${
            value === o.value
              ? 'bg-brand/20 border-brand text-foreground font-semibold shadow-[0_0_0_1px_rgba(59,130,246,0.4)]'
              : 'bg-white/[0.03] border-white/10 text-foreground/80 hover:bg-accent hover:border-white/20'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 横向选项块（替代原生 select）：单行流式排列，样式对齐颜色选择块 */
export function OptionBlocks<T extends string>({ value, options, onChange }: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title || o.label}
          onClick={() => onChange(o.value)}
          className={`px-2.5 py-1.5 text-xs font-medium rounded-md border truncate transition-colors ${
            value === o.value
              ? 'bg-brand/20 border-brand text-foreground font-semibold shadow-[0_0_0_1px_rgba(59,130,246,0.4)]'
              : 'bg-white/[0.03] border-white/10 text-foreground/70 hover:bg-white/[0.07] hover:border-white/20'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <div
      className="flex items-center justify-between py-1 cursor-pointer select-none"
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      role="switch"
      aria-checked={checked}
    >
      {label !== undefined && <span className="text-sm text-foreground/90">{label}</span>}
      <button
        type="button"
        tabIndex={-1}
        onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
        className={`relative w-9 h-5 rounded-full transition-colors shrink-0 pointer-events-none ${checked ? 'bg-brand' : 'bg-white/15'}`}
        aria-checked={checked}
        role="switch"
      >
        <span
          className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`}
        />
      </button>
    </div>
  );
}

/** 右侧浮层面板头部：h-12 bg-white/5，左图标+标题，右关闭 */
export function PanelHeader({ icon, title, onClose }: {
  icon?: React.ReactNode;
  title: string;
  onClose?: () => void;
}) {
  return (
    <div className="h-12 shrink-0 px-4 flex items-center justify-between bg-white/[0.05] border-b border-white/[0.06] sticky top-0 z-10">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        {icon}
        {title}
      </div>
      {onClose && (
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors" aria-label="关闭">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      )}
    </div>
  );
}

/**
 * 预设色板 = Tailwind 官方色板（`lib/tw-colors.ts`）：
 * 默认只铺「500 这一列」（每个色族一格 + 纯白/纯黑），要别的深浅点「展开全色阶」。
 * 替代裸 input[type=color]（.input-color）。
 */
export function ColorPicker({ value, onChange, disabled, title }: {
  value: string;
  onChange: (c: string) => void;
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    // fixed 面板不会跟着触发按钮走，滚动/改窗口尺寸时直接收起
    const close = () => setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  // 面板挂在 body 上：嵌在 overflow-y-auto 弹窗里时，absolute 定位会被宿主容器裁掉
  // （字幕生成的「文字色」就是这么被挡住的），所以按触发块 + 视口算一次位置。
  useLayoutEffect(() => {
    const trig = wrapRef.current;
    const pop = popRef.current;
    if (!open || !trig || !pop) return;
    const r = trig.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = pop;
    const M = 8;
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - M) top = r.top - 4 - h;
    top = Math.min(Math.max(M, top), Math.max(M, window.innerHeight - M - h));
    let left = r.right - w;
    if (left < M) left = M;
    if (left + w > window.innerWidth - M) left = window.innerWidth - M - w;
    left = Math.min(Math.max(M, left), Math.max(M, window.innerWidth - M - w));
    pop.style.top = `${Math.round(top)}px`;
    pop.style.left = `${Math.round(left)}px`;
  }, [open, value, full]);

  const same = (hex: string) => (value || '').trim().toUpperCase() === hex.toUpperCase();
  const pick = (hex: string) => { onChange(hex); setOpen(false); };
  const swatch = (hex: string, label: string, cls: string, style?: React.CSSProperties) => (
    <button
      key={label}
      type="button"
      title={`${label} · ${hex}`}
      onClick={() => pick(hex)}
      className={`${cls} rounded border-2 shrink-0 transition-transform hover:scale-110 ${same(hex) ? 'border-white/80' : 'border-white/15'}`}
      style={{ backgroundColor: hex, ...style }}
    />
  );

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        title={title || '选择颜色'}
        onClick={() => setOpen(!open)}
        className="w-full h-8 px-2 rounded-md border bg-white/[0.045] flex items-center gap-2 transition-colors hover:border-white/25 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span className="w-4 h-4 rounded border border-white/25 shrink-0" style={{ backgroundColor: value }} />
        <span className="text-xs text-foreground/70 font-mono uppercase truncate">{value || '—'}</span>
      </button>
      {open && !disabled && createPortal(
        <div ref={popRef} className="fixed top-0 left-0 z-[120] w-[300px] max-w-[86vw] bg-card border border-white/10 rounded-xl shadow-2xl p-2.5">
          {full ? (
            <div className="max-h-[42vh] overflow-y-auto pr-1">
              <div className="flex items-center gap-[2px] mb-1 pl-[22px]">
                {TW_SHADES.map((s) => (
                  <span key={s} className="w-[18px] shrink-0 text-[8px] leading-none text-center text-muted-foreground/70 tabular-nums">{s}</span>
                ))}
              </div>
              {TW_FAMILIES.map((f) => (
                <div key={f.family} className="flex items-center gap-[2px] mb-[2px]">
                  <span className="w-[20px] shrink-0 text-[9px] text-muted-foreground/80" title={f.cn}>{f.family.slice(0, 4)}</span>
                  {f.shades.map((hex, i) => swatch(hex, `${f.family}-${TW_SHADES[i]}`, 'w-[18px] h-[18px]'))}
                </div>
              ))}
              <div className="flex items-center gap-[2px] mt-1">
                <span className="w-[20px] shrink-0 text-[9px] text-muted-foreground/80">base</span>
                {TW_MONO.map((m) => swatch(m.hex, m.family, 'w-[18px] h-[18px]', { marginRight: 2 }))}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-8 gap-1.5">
              {TW_COLUMN_500.map((s) => swatch(s.hex, s.label, 'w-7 h-7'))}
            </div>
          )}
          <button
            type="button"
            onClick={() => setFull(!full)}
            className="mt-2 text-[11px] text-muted-foreground hover:text-foreground"
            title={full ? '只保留每族 500 那一列' : 'Tailwind 全色板：每族 50–950'}
          >
            {full ? '▴ 只看 500' : `▾ 展开全色阶（${TW_FAMILIES.length} 族 × ${TW_SHADES.length} 阶）`}
          </button>
          <div className="flex items-center gap-2 mt-2 pt-2 border-t border-white/[0.06]">
            <input
              type="color"
              value={toHex6(value)}
              onChange={(e) => onChange(e.target.value)}
              className="w-7 h-7 rounded cursor-pointer bg-transparent border border-white/15 p-0.5"
            />
            <span className="text-[11px] text-muted-foreground">自定义颜色</span>
            {twLabelOf(value) && <span className="text-[11px] text-muted-foreground/70 ml-auto">{twLabelOf(value)}</span>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** input[type=color] 只认 #rrggbb，把 8 位 hex / rgba 等归一化 */
function toHex6(value: string): string {
  if (!value) return '#000000';
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}/.test(v)) return v.slice(0, 7);
  if (/^#[0-9a-fA-F]{3}$/.test(v)) return v;
  return '#000000';
}

/**
 * 数字输入框（文本受控 + 失焦/回车提交）。
 * 修复受控 number 输入框"输不进"问题：编辑期间只更新本地字符串，
 * 提交时才解析并回调；光标位置始终保留。
 */
export function NumberInput({ value, onCommit, className, step, min, max, title, disabled, style }: {
  value: number | string;
  onCommit: (v: number) => void;
  className?: string;
  step?: number | string;
  min?: number | string;
  max?: number | string;
  title?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  const [txt, setTxt] = useState<string>(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setTxt(String(value));
  }, [value, focused]);
  return (
    <input
      type="text"
      inputMode="decimal"
      value={txt}
      onChange={(e) => setTxt(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        const v = parseFloat(txt);
        if (!Number.isNaN(v)) onCommit(v);
        else setTxt(String(value));
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className={className ?? 'input'}
      step={step}
      min={min}
      max={max}
      title={title}
      disabled={disabled}
      style={style}
    />
  );
}
