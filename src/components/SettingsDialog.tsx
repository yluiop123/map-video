import { useState } from 'react';
import { Bot, AudioLines, ImageIcon, X } from 'lucide-react';
import { ProviderSettingsDialog } from './FxPanelBody';

interface SettingsDialogProps {
  onClose: () => void;
}

type AiKind = 'llm' | 'tts' | 'image';

/** 设置：AI 能力配置（文案生成 / 语音克隆 / 图片生成），左侧切换、右侧配置 */
export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [kind, setKind] = useState<AiKind>('llm');

  const TABS: { id: AiKind; label: string; icon: React.ReactNode }[] = [
    { id: 'llm', label: '文案生成', icon: <Bot size={15} className="text-emerald-400" /> },
    { id: 'tts', label: '语音克隆', icon: <AudioLines size={15} className="text-sky-400" /> },
    { id: 'image', label: '图片生成', icon: <ImageIcon size={15} className="text-amber-400" /> },
  ];

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-card border border-white/10 rounded-xl shadow-2xl w-[720px] max-w-[94vw] h-[540px] max-h-[88vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 h-12 border-b border-white/10 shrink-0">
          <h2 className="text-base font-bold">设置 · AI</h2>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5">
            <X size={16} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <aside className="w-44 shrink-0 border-r border-white/10 p-2 space-y-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setKind(t.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                  kind === t.id ? 'bg-white/[0.1] text-foreground font-medium' : 'text-foreground/75 hover:bg-white/[0.05]'
                }`}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </aside>
          <main className="flex-1 min-w-0 overflow-y-auto p-4">
            <ProviderSettingsDialog kind={kind} inline />
          </main>
        </div>
      </div>
    </div>
  );
}
