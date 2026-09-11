/**
 * 共享 UI 基础组件（Mapimator Studio 深色风格对齐）
 * 此前 Section/Field/StyleGrid/Toggle 在 PropertiesPanel 与 KeyframePanel 各有一份，收敛于此统一维护。
 */
import React, { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../../stores/editorStore';

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
 * 预设色板（全局统一，40 色 = 5 行 × 8 列）
 * 排列顺序：红橙 → 黄绿 → 青蓝 → 紫粉 → 中性明暗；深浅成对，便于成体系地挑色。
 */
export const COLOR_PALETTE = [
  // 红 / 橙
  '#7F1D1D', '#B91C1C', '#DC2626', '#EF4444', '#F87171', '#FDA4AF', '#EA580C', '#F97316',
  // 黄 / 绿
  '#D97706', '#F59E0B', '#FBBF24', '#FDE68A', '#365314', '#4D7C0F', '#22C55E', '#4ADE80',
  // 青 / 蓝
  '#0F766E', '#14B8A6', '#06B6D4', '#22D3EE', '#1E3A8A', '#2563EB', '#3B82F6', '#60A5FA',
  // 紫 / 粉
  '#4C1D95', '#6D28D9', '#8B5CF6', '#C4B5FD', '#86198F', '#C026D3', '#DB2777', '#EC4899',
  // 中性 / 明暗
  '#000000', '#1F2937', '#374151', '#6B7280', '#9CA3AF', '#D1D5DB', '#F5F5F4', '#FFFFFF',
];

/** input[type=color] 只认 #rrggbb，把 8 位 hex / rgba 等归一化 */
function toHex6(value: string): string {
  if (!value) return '#000000';
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}/.test(v)) return v.slice(0, 7);
  if (/^#[0-9a-fA-F]{3}$/.test(v)) return v;
  return '#000000';
}

/**
 * 统一颜色选择器：色块按钮 + 弹出预设色板/自定义取色。
 * 替代裸 input[type=color]（.input-color）。
 */
export function ColorPicker({ value, onChange, palette = COLOR_PALETTE, disabled, title }: {
  value: string;
  onChange: (c: string) => void;
  palette?: string[];
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
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
      {open && !disabled && (
        <div className="absolute right-0 top-full mt-1 w-[300px] max-w-[86vw] bg-card border border-white/10 rounded-xl shadow-2xl p-2.5 z-50">
          <div className="grid grid-cols-8 gap-1.5">
            {palette.map((c) => (
              <button
                key={c}
                type="button"
                title={c}
                onClick={() => { onChange(c); setOpen(false); }}
                className={`w-7 h-7 rounded-md border-2 transition-transform hover:scale-110 ${
                  value.toLowerCase() === c.toLowerCase() ? 'border-white/80' : 'border-white/15'
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          <div className="flex items-center gap-2 mt-2.5 pt-2.5 border-t border-white/[0.06]">
            <input
              type="color"
              value={toHex6(value)}
              onChange={(e) => onChange(e.target.value)}
              className="w-7 h-7 rounded cursor-pointer bg-transparent border border-white/15 p-0.5"
            />
            <span className="text-[11px] text-muted-foreground">自定义颜色</span>
          </div>
        </div>
      )}
    </div>
  );
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
