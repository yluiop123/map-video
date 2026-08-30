import { useProjectStore } from '../stores/projectStore';
import type { Chapter, TransitionType } from '../types';

const TRANSITIONS: { value: TransitionType; label: string }[] = [
  { value: 'cut', label: '硬切' },
  { value: 'fade', label: '淡入淡出' },
  { value: 'fadeBlack', label: '黑场淡入' },
  { value: 'fadeWhite', label: '白场淡入' },
  { value: 'dissolve', label: '溶解' },
  { value: 'wipeLeft', label: '左擦拭' },
  { value: 'wipeRight', label: '右擦拭' },
  { value: 'zoom', label: '缩放' },
  { value: 'mapFly', label: '地图飞行' },
];

export function TransitionEditor({ chapter }: { chapter: Chapter }) {
  const setChapterTransition = useProjectStore((s) => s.setChapterTransition);

  const transition = chapter.transition;

  const setType = (type: TransitionType) => {
    setChapterTransition(chapter.id, {
      type,
      duration: transition?.duration || 30,
    });
  };

  return (
    <div className="p-3 space-y-3">
      <h2 className="text-sm font-semibold">转场效果</h2>

      <div>
        <label className="text-xs text-muted-foreground block mb-1">章节进入方式</label>
        <div className="grid grid-cols-3 gap-1">
          {TRANSITIONS.map((t) => (
            <button
              key={t.value}
              onClick={() => setType(t.value)}
              className={`px-1 py-1 text-xs border rounded ${
                transition?.type === t.value ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-xs text-muted-foreground block mb-1">转场时长（帧）</label>
        <input
          type="number"
          value={transition?.duration || 30}
          onChange={(e) => setChapterTransition(chapter.id, { type: transition?.type || 'fade', duration: parseInt(e.target.value) || 30 })}
          className="input"
          min="0"
          max="120"
        />
        <p className="text-xs text-muted-foreground mt-1">
          30帧 ≈ 1秒（30fps）。0 表示立即切换。
        </p>
      </div>

      {transition?.type === 'mapFly' && (
        <div className="p-2 bg-white/[0.06] rounded text-xs text-muted-foreground">
          "地图飞行"转场会在章节开始前从上一章位置平滑飞行到本章位置。
        </div>
      )}
    </div>
  );
}
