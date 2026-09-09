import { useEffect, useRef, useState } from 'react';
import { Film, ChevronDown, Plus, Copy, Trash2, Pencil, Check } from 'lucide-react';
import { useProjectStore } from '../stores/projectStore';
import { useConfirm } from './ui/ConfirmHost';
import { useEditorStore } from '../stores/editorStore';

/**
 * 顶栏章节菜单（替代底部章节卡片，省出地图/时间线空间）：
 * 芯片显示当前章节，弹出面板：单击切换 / 铅笔重命名 / 复制 / 删除 / 底部新增。
 */
export function ChapterMenu() {
  const project = useProjectStore((s) => s.project);
  const selectedChapterId = useEditorStore((s) => s.selectedChapterId);
  const selectChapter = useEditorStore((s) => s.selectChapter);
  const setCurrentFrame = useEditorStore((s) => s.setCurrentFrame);
  const updateChapter = useProjectStore((s) => s.updateChapter);
  const duplicateChapter = useProjectStore((s) => s.duplicateChapter);
  const deleteChapter = useProjectStore((s) => s.deleteChapter);
  const confirm = useConfirm();

  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!project) return null;

  const activeId = selectedChapterId || project.chapters[0]?.id;
  const activeIdx = project.chapters.findIndex((c) => c.id === activeId);
  const active = project.chapters[activeIdx];

  const pick = (id: string) => {
    const ch = project.chapters.find((c) => c.id === id);
    selectChapter(id);
    if (ch) setCurrentFrame(ch.startFrame);
    setOpen(false);
  };

  const commitRename = (id: string, original: string) => {
    const v = renameDraft.trim();
    if (v && v !== original) updateChapter(id, { title: v });
    setRenamingId(null);
  };

  return (
    <div ref={boxRef} className="relative shrink-0">
      {/* 芯片 */}
      <button
        onClick={() => setOpen(!open)}
        className="h-9 px-3 flex items-center gap-2 rounded-lg bg-white/[0.05] border border-white/10 text-sm text-foreground/90 hover:bg-white/10 transition-colors"
        title="章节管理：切换 / 重命名 / 复制 / 删除 / 新增"
      >
        <Film size={14} className="text-muted-foreground" />
        <span className="max-w-[140px] truncate">
          <span className="text-muted-foreground">第{activeIdx + 1}章</span> · {active?.title || '—'}
        </span>
        <ChevronDown size={13} className={`text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* 弹出面板 */}
      {open && (
        <div className="absolute left-0 top-full mt-1.5 w-64 bg-card/95 backdrop-blur border border-white/10 rounded-xl shadow-2xl p-1.5 z-50">
          <p className="px-2 pt-1 pb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">章节（单击切换）</p>
          {project.chapters.map((ch, i) => {
            const isActive = ch.id === activeId;
            return (
              <div
                key={ch.id}
                onClick={() => pick(ch.id)}
                className={`group flex items-center gap-2 px-2 py-1.5 rounded-md text-xs cursor-pointer transition-colors ${
                  isActive ? 'bg-brand/15 text-foreground' : 'text-foreground/80 hover:bg-white/[0.06]'
                }`}
              >
                <span className={`w-4 text-center shrink-0 font-medium ${isActive ? 'text-brand' : 'text-muted-foreground'}`}>{i + 1}</span>
                {renamingId === ch.id ? (
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => commitRename(ch.id, ch.title)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="flex-1 min-w-0 px-1 py-0.5 text-xs bg-background border border-white/20 rounded outline-none"
                  />
                ) : (
                  <span className="flex-1 truncate">{ch.title}</span>
                )}
                {renamingId === ch.id ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); commitRename(ch.id, ch.title); }}
                    className="p-1 rounded text-brand hover:bg-white/10"
                    title="确认"
                  >
                    <Check size={12} />
                  </button>
                ) : (
                  <span className="hidden group-hover:flex items-center gap-0.5">
                    <button
                      title="重命名"
                      onClick={(e) => { e.stopPropagation(); setRenamingId(ch.id); setRenameDraft(ch.title); }}
                      className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-white/10"
                    >
                      <Pencil size={11} />
                    </button>
                    <button
                      title="复制本章"
                      onClick={(e) => { e.stopPropagation(); duplicateChapter(ch.id); }}
                      className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-white/10"
                    >
                      <Copy size={11} />
                    </button>
                    {project.chapters.length > 1 && (
                      <button
                        title="删除本章"
                        onClick={(e) => {
                          e.stopPropagation();
                          void confirm({ message: `删除「${ch.title}」？`, danger: true, confirmText: '删除' }).then((ok) => ok && deleteChapter(ch.id));
                        }}
                        className="p-1 rounded text-muted-foreground hover:text-red-400 hover:bg-white/10"
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </span>
                )}
                {isActive && renamingId !== ch.id && <Check size={12} className="text-brand shrink-0 group-hover:hidden" />}
              </div>
            );
          })}

          <div className="h-px bg-white/[0.06] my-1.5" />

          <div className="flex items-center gap-1 px-1">
            <button
              onClick={() => {
                useProjectStore.getState().addChapter();
                setTimeout(() => {
                  const st = useProjectStore.getState();
                  const last = st.project?.chapters[st.project!.chapters.length - 1];
                  if (last) { pick(last.id); setRenamingId(last.id); setRenameDraft(last.title); }
                }, 0);
              }}
              className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs font-medium text-foreground/80 border border-dashed border-white/15 hover:bg-white/[0.06] transition-colors"
            >
              <Plus size={13} /> 新增章节
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
