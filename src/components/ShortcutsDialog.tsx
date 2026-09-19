import { useEffect } from 'react';
import {
  Move, RotateCw, ZoomIn, Play, Trash2, Undo2, Redo2, Check, X, CornerDownLeft, Layers,
} from 'lucide-react';

/** 键位帽 */
function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="px-2 py-0.5 rounded-md bg-white/[0.07] border border-white/15 text-[11px] font-medium text-foreground/90 whitespace-nowrap">
      {children}
    </kbd>
  );
}

function Row({ icon, iconClass, name, desc, keys }: {
  icon: React.ReactNode;
  iconClass?: string;
  name: string;
  desc?: string;
  keys: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.06]">
      <span className={`w-7 h-7 rounded-full bg-white/[0.06] flex items-center justify-center shrink-0 ${iconClass || 'text-foreground/80'}`}>
        {icon}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground">{name}</p>
        {desc && <p className="text-[11px] text-muted-foreground">{desc}</p>}
      </div>
      <div className="flex items-center gap-1 shrink-0">{keys}</div>
    </div>
  );
}

/**
 * 快捷键速查弹窗（对齐 Mapimator Shortcuts）。
 * 内容与实际绑定保持同步：EditableMap（Enter/Esc/Del）、TimelineEditor（Space）、App（Ctrl+Z/Y）。
 */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[480px] max-h-[86vh] overflow-y-auto bg-card border border-white/10 rounded-2xl shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">快捷键</h2>
          <button onClick={onClose} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5" aria-label="关闭">
            <X size={16} />
          </button>
        </div>

        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2">地图交互</p>
        <div className="space-y-1.5 mb-5">
          <Row icon={<Move size={13} />} name="平移" keys={<Key>左键拖拽</Key>} />
          <Row icon={<RotateCw size={13} />} name="旋转 / 倾角" desc="也可用右键拖拽" keys={<Key>Ctrl + 拖拽</Key>} />
          <Row icon={<ZoomIn size={13} />} name="缩放" keys={<Key>滚轮</Key>} />
        </div>

        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2">键盘快捷键</p>
        <div className="space-y-1.5">
          <Row icon={<Play size={13} />} name="播放 / 暂停" keys={<Key>Space</Key>} />
          <Row icon={<Layers size={13} />} name="删除选中图层（含其元素）" keys={<><Key>Del</Key><span className="text-muted-foreground">/</span><Key>Backspace</Key></>} />
          <Row icon={<Trash2 size={13} />} name="删除选中元素" keys={<><Key>Del</Key><span className="text-muted-foreground">/</span><Key>Backspace</Key></>} />
          <Row icon={<Trash2 size={13} />} name="删除选中特效 / 弹窗" keys={<><Key>Del</Key><span className="text-muted-foreground">/</span><Key>Backspace</Key></>} />
          <Row icon={<Undo2 size={13} />} name="撤销" keys={<Key>Ctrl/Cmd + Z</Key>} />
          <Row icon={<Redo2 size={13} />} name="重做" keys={<><Key>Ctrl + Y</Key><span className="text-muted-foreground">/</span><Key>Ctrl/Cmd + Shift + Z</Key></>} />
          <Row icon={<Check size={13} />} name="完成绘制" keys={<Key>Enter</Key>} />
          <Row icon={<CornerDownLeft size={13} />} name="绘制中撤销上一个点" keys={<Key>Backspace</Key>} />
          <Row icon={<X size={13} />} name="取消绘制 / 取消选择" keys={<Key>Esc</Key>} />
        </div>
      </div>
    </div>
  );
}
