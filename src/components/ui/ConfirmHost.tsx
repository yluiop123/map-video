/**
 * 全局确认弹窗（替代原生 confirm()）：
 *   const confirm = useConfirm();
 *   if (await confirm({ message: '删除「xx」？', danger: true })) { ... }
 * 需在 App 挂载 <ConfirmHost />。
 *
 * 必须是真 Dialog 而不是手写遮罩：这些确认常常从别的模态窗（⚙ 设置）里点出来，
 * Radix 模态窗打开时会给 body 加 `pointer-events: none`，只有它自己的内容重新开启指针事件 ——
 * 手写遮罩因此**接不到点击**，表现为「确认框还开着，底下照样能操作」。
 */
import { create } from 'zustand';
import { TriangleAlert } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog';
import { Button } from './button';

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

  return (
    <Dialog open={!!opts} onOpenChange={(v) => { if (!v) answer(false); }}>
      <DialogContent className="max-w-sm gap-3" onEscapeKeyDown={() => answer(false)}>
        {opts && (
          <>
            <div className="flex items-start gap-3">
              <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                opts.danger ? 'bg-red-500/15 text-red-400' : 'bg-white/[0.06] text-foreground/80'}`}>
                <TriangleAlert size={15} />
              </span>
              <div className="min-w-0 space-y-1">
                <DialogTitle className="text-sm">{opts.title ?? (opts.danger ? '确认删除' : '请确认')}</DialogTitle>
                <DialogDescription className="break-words text-sm text-foreground/80">{opts.message}</DialogDescription>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => answer(false)}>
                {opts.cancelText || '取消'}
              </Button>
              <Button size="sm" className={`h-8 text-xs ${opts.danger ? 'bg-red-500 text-white hover:bg-red-400' : ''}`} onClick={() => answer(true)}>
                {opts.confirmText || '确定'}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
