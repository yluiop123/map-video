import { useProjectStore } from '../stores/projectStore';
import type { Chapter, ChapterEffect } from '../types';

export function EffectsEditor({ chapter }: { chapter: Chapter }) {
  const addChapterEffect = useProjectStore((s) => s.addChapterEffect);
  const removeChapterEffect = useProjectStore((s) => s.removeChapterEffect);
  const effects = chapter.effects || [];

  const addEffect = (type: ChapterEffect['type']) => {
    let effect: ChapterEffect;
    switch (type) {
      case 'cursor_track':
        effect = { type: 'cursor_track', path: [[104, 35], [107, 37]], color: '#FF4C4C', frameStep: 10 };
        break;
      case 'focus_glow':
        effect = { type: 'focus_glow', center: [106, 36], radius: 80, color: '#FFFF00' };
        break;
      case 'scan_line':
        effect = { type: 'scan_line', direction: 'horizontal', color: '#00FFAA' };
        break;
      default:
        return;
    }
    addChapterEffect(chapter.id, effect);
  };

  const EFF: { type: ChapterEffect['type']; label: string; icon: string }[] = [
    { type: 'cursor_track', label: '光标轨迹', icon: '🖱️' },
    { type: 'focus_glow', label: '聚焦高亮', icon: '🔦' },
    { type: 'scan_line', label: '扫描线', icon: '📡' },
  ];

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">章节特效</h2>
        <div className="flex gap-1">
          {EFF.map((e) => (
            <button
              key={e.type}
              onClick={() => addEffect(e.type)}
              className="px-2 py-1 text-xs border rounded hover:bg-accent"
              title={e.label}
            >
              {e.icon} {e.label}
            </button>
          ))}
        </div>
      </div>

      {effects.length === 0 && (
        <p className="text-xs text-muted-foreground">暂无特效。点击上方按钮添加。</p>
      )}

      <div className="space-y-2">
        {effects.map((effect, i) => (
          <div key={i} className="border rounded p-2 flex items-center justify-between">
            <span className="text-sm">{renderEffectLabel(effect)}</span>
            <button
              onClick={() => removeChapterEffect(chapter.id, i)}
              className="text-xs text-red-500 hover:text-red-700"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function renderEffectLabel(effect: ChapterEffect): string {
  switch (effect.type) {
    case 'cursor_track':
      return `光标轨迹 (${effect.color}, 每${effect.frameStep}帧)`;
    case 'focus_glow':
      return `聚焦高亮 (${effect.color})`;
    case 'scan_line':
      return `扫描线 (${effect.direction}, ${effect.color})`;
    default:
      return '自定义特效';
  }
}
