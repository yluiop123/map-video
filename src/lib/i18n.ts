/**
 * i18n.ts — 「给人看的字」的统一类型（纯函数，不依赖 store，方便离线单测）
 *
 * 一切显示文案（参数名、选项标签、role 名、模板包名）都是 L：裸字符串 = 中英同值，
 * 对象 = 双语。**只有 value 会进请求体**，label 纯显示（见 lib/request-engine 的变量声明）。
 * 跟着顶栏语言取值的 hook 在 components/ui/primitives.tsx 的 useLabel()。
 */

export type L = string | { zh: string; en: string };

export function pickLabel(l: L | undefined, lang: 'zh' | 'en'): string {
  if (l == null) return '';
  return typeof l === 'string' ? l : lang === 'en' ? l.en : l.zh;
}
