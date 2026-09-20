/**
 * tw-colors.ts — Tailwind 官方色板（颜色选择器的唯一取色来源）
 *
 * 数值不手抄：全部由 `require('tailwindcss/colors')`（与 https://tailwindcss.com/docs/colors 同一份表）
 * 导出后落盘，升级 tailwind 时重跑一次即可，避免表与实际样式漂移。
 * 每族 11 阶，顺序与 TW_SHADES 对齐；「500」是默认展示的那一列。
 */

export const TW_SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'] as const;
export const TW_SHADE_500 = 5;

export interface TwFamily {
  /** 色族名（小写，和 Tailwind 类名一致：red / slate / …） */
  family: string;
  /** 中文名，用于悬停说明 */
  cn: string;
  /** 与 TW_SHADES 同序的 11 个 hex */
  shades: string[];
}

/**
 * 色族顺序与 https://tailwindcss.com/docs/colors 页面一致：
 * 先彩色系（red→rose）再中性系（slate→stone）。
 * 页面另外列的 taupe / mauve / mist / olive 是 Tailwind v4 新增，本项目锁在 3.4，
 * `tailwindcss/colors` 里没有这四族，故不收录。
 */
export const TW_FAMILIES: TwFamily[] = [
  { family: 'red', cn: '红', shades: ['#FEF2F2', '#FEE2E2', '#FECACA', '#FCA5A5', '#F87171', '#EF4444', '#DC2626', '#B91C1C', '#991B1B', '#7F1D1D', '#450A0A'] },
  { family: 'orange', cn: '橙', shades: ['#FFF7ED', '#FFEDD5', '#FED7AA', '#FDBA74', '#FB923C', '#F97316', '#EA580C', '#C2410C', '#9A3412', '#7C2D12', '#431407'] },
  { family: 'amber', cn: '琥珀', shades: ['#FFFBEB', '#FEF3C7', '#FDE68A', '#FCD34D', '#FBBF24', '#F59E0B', '#D97706', '#B45309', '#92400E', '#78350F', '#451A03'] },
  { family: 'yellow', cn: '黄', shades: ['#FEFCE8', '#FEF9C3', '#FEF08A', '#FDE047', '#FACC15', '#EAB308', '#CA8A04', '#A16207', '#854D0E', '#713F12', '#422006'] },
  { family: 'lime', cn: '青柠', shades: ['#F7FEE7', '#ECFCCB', '#D9F99D', '#BEF264', '#A3E635', '#84CC16', '#65A30D', '#4D7C0F', '#3F6212', '#365314', '#1A2E05'] },
  { family: 'green', cn: '绿', shades: ['#F0FDF4', '#DCFCE7', '#BBF7D0', '#86EFAC', '#4ADE80', '#22C55E', '#16A34A', '#15803D', '#166534', '#14532D', '#052E16'] },
  { family: 'emerald', cn: '翡翠', shades: ['#ECFDF5', '#D1FAE5', '#A7F3D0', '#6EE7B7', '#34D399', '#10B981', '#059669', '#047857', '#065F46', '#064E3B', '#022C22'] },
  { family: 'teal', cn: '蓝绿', shades: ['#F0FDFA', '#CCFBF1', '#99F6E4', '#5EEAD4', '#2DD4BF', '#14B8A6', '#0D9488', '#0F766E', '#115E59', '#134E4A', '#042F2E'] },
  { family: 'cyan', cn: '青', shades: ['#ECFEFF', '#CFFAFE', '#A5F3FC', '#67E8F9', '#22D3EE', '#06B6D4', '#0891B2', '#0E7490', '#155E75', '#164E63', '#083344'] },
  { family: 'sky', cn: '天蓝', shades: ['#F0F9FF', '#E0F2FE', '#BAE6FD', '#7DD3FC', '#38BDF8', '#0EA5E9', '#0284C7', '#0369A1', '#075985', '#0C4A6E', '#082F49'] },
  { family: 'blue', cn: '蓝', shades: ['#EFF6FF', '#DBEAFE', '#BFDBFE', '#93C5FD', '#60A5FA', '#3B82F6', '#2563EB', '#1D4ED8', '#1E40AF', '#1E3A8A', '#172554'] },
  { family: 'indigo', cn: '靛蓝', shades: ['#EEF2FF', '#E0E7FF', '#C7D2FE', '#A5B4FC', '#818CF8', '#6366F1', '#4F46E5', '#4338CA', '#3730A3', '#312E81', '#1E1B4B'] },
  { family: 'violet', cn: '紫罗兰', shades: ['#F5F3FF', '#EDE9FE', '#DDD6FE', '#C4B5FD', '#A78BFA', '#8B5CF6', '#7C3AED', '#6D28D9', '#5B21B6', '#4C1D95', '#2E1065'] },
  { family: 'purple', cn: '紫', shades: ['#FAF5FF', '#F3E8FF', '#E9D5FF', '#D8B4FE', '#C084FC', '#A855F7', '#9333EA', '#7E22CE', '#6B21A8', '#581C87', '#3B0764'] },
  { family: 'fuchsia', cn: '洋红', shades: ['#FDF4FF', '#FAE8FF', '#F5D0FE', '#F0ABFC', '#E879F9', '#D946EF', '#C026D3', '#A21CAF', '#86198F', '#701A75', '#4A044E'] },
  { family: 'pink', cn: '粉', shades: ['#FDF2F8', '#FCE7F3', '#FBCFE8', '#F9A8D4', '#F472B6', '#EC4899', '#DB2777', '#BE185D', '#9D174D', '#831843', '#500724'] },
  { family: 'rose', cn: '玫红', shades: ['#FFF1F2', '#FFE4E6', '#FECDD3', '#FDA4AF', '#FB7185', '#F43F5E', '#E11D48', '#BE123C', '#9F1239', '#881337', '#4C0519'] },
  { family: 'slate', cn: '石板灰', shades: ['#F8FAFC', '#F1F5F9', '#E2E8F0', '#CBD5E1', '#94A3B8', '#64748B', '#475569', '#334155', '#1E293B', '#0F172A', '#020617'] },
  { family: 'gray', cn: '灰', shades: ['#F9FAFB', '#F3F4F6', '#E5E7EB', '#D1D5DB', '#9CA3AF', '#6B7280', '#4B5563', '#374151', '#1F2937', '#111827', '#030712'] },
  { family: 'zinc', cn: '锌灰', shades: ['#FAFAFA', '#F4F4F5', '#E4E4E7', '#D4D4D8', '#A1A1AA', '#71717A', '#52525B', '#3F3F46', '#27272A', '#18181B', '#09090B'] },
  { family: 'neutral', cn: '中性灰', shades: ['#FAFAFA', '#F5F5F5', '#E5E5E5', '#D4D4D4', '#A3A3A3', '#737373', '#525252', '#404040', '#262626', '#171717', '#0A0A0A'] },
  { family: 'stone', cn: '石灰（界面主题色族）', shades: ['#FAFAF9', '#F5F5F4', '#E7E5E4', '#D6D3D1', '#A8A29E', '#78716C', '#57534E', '#44403C', '#292524', '#1C1917', '#0C0A09'] },
];

/** Tailwind 只有 white / black 两个不带阶的底色 */
export const TW_MONO = [
  { family: 'white', cn: '纯白', hex: '#FFFFFF' },
  { family: 'black', cn: '纯黑', hex: '#000000' },
];

export interface TwSwatch {
  /** 类名式标签：red-500 / white */
  label: string;
  hex: string;
  cn: string;
}

/** 默认展示的那一列：每个色族的 500 + 纯白/纯黑（24 格，正好 3 行 × 8 列） */
export const TW_COLUMN_500: TwSwatch[] = [
  ...TW_FAMILIES.map((f) => ({ label: `${f.family}-500`, hex: f.shades[TW_SHADE_500], cn: f.cn })),
  ...TW_MONO.map((m) => ({ label: m.family, hex: m.hex, cn: m.cn })),
];

/** 当前值是不是表里的某个色（用于回显类名） */
export function twLabelOf(hex: string): string | undefined {
  const want = (hex || '').trim().toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(want)) return undefined;
  for (const f of TW_FAMILIES) {
    const i = f.shades.findIndex((s) => s.toUpperCase() === want);
    if (i >= 0) return `${f.family}-${TW_SHADES[i]}`;
  }
  return TW_MONO.find((m) => m.hex.toUpperCase() === want)?.family;
}
