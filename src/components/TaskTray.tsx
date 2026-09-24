/**
 * TaskTray — 顶栏的「在途任务」浮层
 *
 * 配音 / 出图走 `task` 表之后，用户可以关掉字幕弹窗继续干活，所以进度得有个不在弹窗里的落点：
 * 顶栏一枚计数芯片，点开按批次列出在跑的行，能整批取消。
 */
import { useT } from './ui/primitives';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { useTaskStore } from '../stores/taskStore';
import type { TaskRow } from '../types';

const LABEL: Record<TaskRow['status'], { zh: string; en: string }> = {
  submitting: { zh: '提交中', en: 'submitting' },
  querying: { zh: '查询中', en: 'polling' },
  success: { zh: '完成', en: 'done' },
  failed: { zh: '失败', en: 'failed' },
  canceled: { zh: '已取消', en: 'canceled' },
};

export function TaskTray() {
  const t = useT();
  const rows = useTaskStore((s) => s.rows);
  const cancelBatch = useTaskStore((s) => s.cancelBatch);
  const open = rows.filter((x) => x.status === 'submitting' || x.status === 'querying');
  if (!open.length) return null;

  const batches = [...new Set(open.map((x) => x.batchId))];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="h-9 px-2.5 flex items-center gap-1.5 rounded-md border border-sky-400/40 bg-sky-500/10 text-[11px] text-sky-200 hover:bg-sky-500/20 transition-colors shrink-0">
          <span className="animate-pulse">⏳</span>
          {t('在途', 'Running')} {open.length}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        {batches.map((bid) => {
          const items = rows.filter((x) => x.batchId === bid);
          const done = items.filter((x) => x.status !== 'submitting' && x.status !== 'querying').length;
          return (
            <div key={bid} className="mb-2 last:mb-0">
              <div className="flex items-center justify-between gap-2 px-1 pb-1">
                <span className="text-[11px] font-medium tabular-nums">
                  {items.length > 1 ? `${done}/${items.length}` : t('单条任务', 'single task')}
                </span>
                {items.some((x) => x.status === 'submitting' || x.status === 'querying') && (
                  <Button variant="outline" size="sm" className="h-6 px-2 text-[10px]" onClick={() => void cancelBatch(bid)}>
                    {t('取消这批', 'Cancel')}
                  </Button>
                )}
              </div>
              <div className="max-h-56 space-y-1 overflow-y-auto pr-0.5">
                {items.map((x) => (
                  <div key={x.taskId} className="flex items-center gap-1.5 rounded border border-white/10 px-1.5 py-1">
                    <span className="min-w-0 flex-1 truncate text-[10px] text-foreground/80" title={String(x.input?.text ?? x.category)}>
                      {String(x.input?.text ?? x.category)}
                    </span>
                    {x.status === 'querying' && (
                      <span className="shrink-0 text-[9px] text-muted-foreground tabular-nums">{t('第', '#')}{x.queryCount + 1}</span>
                    )}
                    <Badge variant="outline" className={`shrink-0 px-1 py-0 text-[9px] font-normal ${
                      x.status === 'failed' ? 'border-red-400/40 text-red-300' : x.status === 'success' ? 'border-emerald-400/40 text-emerald-300' : 'border-sky-400/40 text-sky-200'
                    }`} title={x.error}>
                      {t(LABEL[x.status].zh, LABEL[x.status].en)}
                    </Badge>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
