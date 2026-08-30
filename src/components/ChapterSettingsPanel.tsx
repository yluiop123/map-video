import { useEditorStore } from '../stores/editorStore';
import type { Chapter } from '../types';
import { TransitionEditor } from './TransitionEditor';
import { OverlayPanel } from './OverlayPanel';
import { EffectsEditor } from './EffectsEditor';

interface ChapterSettingsPanelProps {
  chapter: Chapter;
}

const TABS = [
  { id: 'transition', label: '转场', icon: '🔀' },
  { id: 'overlay', label: '弹出元素', icon: '🧩' },
  { id: 'effects', label: '特效', icon: '✨' },
] as const;

export function ChapterSettingsPanel({ chapter }: ChapterSettingsPanelProps) {
  const chapterTab = useEditorStore((s) => s.chapterTab);
  const setChapterTab = useEditorStore((s) => s.setChapterTab);

  return (
    <div className="h-full flex flex-col">
      <div className="flex border-b bg-card">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setChapterTab(t.id)}
            className={`flex-1 py-2 text-xs font-medium ${
              chapterTab === t.id
                ? 'border-b-2 border-primary text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">
        {chapterTab === 'transition' && <TransitionEditor chapter={chapter} />}
        {chapterTab === 'overlay' && <OverlayPanel chapter={chapter} />}
        {chapterTab === 'effects' && <EffectsEditor chapter={chapter} />}
      </div>
    </div>
  );
}
