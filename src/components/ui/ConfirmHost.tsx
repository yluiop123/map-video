/**
 * 全局确认弹窗（替代原生 confirm()，深色主题统一）：
 * 组件内 const confirm = useConfirm();
 * if (await confirm({ message: '删除「xx」？', danger: true })) { ... }
 * 需在 App 挂载 <ConfirmHost />。
 */
import { create } from 'zustand';
import { TriangleAlert } from 'lucide-react';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface ConfirmState {
  opts: ConfirmOptions | null;
  resolve: ((v: boolean) => void) | null;
  ask: (o: ConfirmOptions) => Promise<boolean>;
  answer: (v: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  opts: null,
  resolve: null,
  ask: (o) => new Promise<boolean>((resolve) => set({ opts: o, resolve })),
  answer: (v) => {
    const r = get().resolve;
    set({ opts: null, resolve: null });
    r?.(v);
  },
}));

export function useConfirm() {
  return useConfirmStore((s) => s.ask);
}

export function ConfirmHost() {
  const opts = useConfirmStore((s) => s.opts);
  const answer = useConfirmStore((s) => s.answer);
  if (!opts) return null;

  return (
    <div className="fixed inset-0 bg-black/60 z-[80] flex items-center justify-center" onClick={() => answer(false)}>
      <div className="w-80 bg-card border border-white/10 rounded-2xl shadow-2xl p-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-4">
          <span className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${opts.danger ? 'bg-red-500/15 text-red-400' : 'bg-white/[0.06] text-foreground/80'}`}>
            <TriangleAlert size={15} />
          </span>
          <div className="min-w-0">
            {opts.title && <p className="text-sm font-semibold mb-0.5">{opts.title}</p>}
            <p className="text-sm text-foreground/80 break-words">{opts.message}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => answer(false)}
            className="flex-1 py-1.5 rounded-md text-xs font-medium border border-white/15 text-foreground/80 hover:bg-white/[0.06] transition-colors"
          >
            {opts.cancelText || '取消'}
          </button>
          <button
            onClick={() => answer(true)}
            className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${
              opts.danger
                ? 'bg-red-500 text-white hover:bg-red-400'
                : 'bg-white text-black hover:bg-white/90'
            }`}
          >
            {opts.confirmText || '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}
