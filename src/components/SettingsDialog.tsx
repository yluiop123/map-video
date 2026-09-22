import { useState } from 'react';
import { Bot, AudioLines, ImageIcon, Blocks, X } from 'lucide-react';
import { ProviderPanel } from './ProviderPanel';
import { TemplatesPane } from './TemplatesPane';
import { useT } from './ui/primitives';

interface SettingsDialogProps {
  onClose: () => void;
}

type Section = 'llm' | 'tts' | 'image' | 'templates';

/** 设置 · AI：左侧三类能力 + 独立的「接口模板」入口，右侧是对应页面（两页不混在一起） */
export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const t = useT();
  const [section, setSection] = useState<Section>('llm');

  const TABS: { id: Section; label: string; icon: React.ReactNode }[] = [
    { id: 'llm', label: t('文案生成', 'Text'), icon: <Bot size={15} className="text-emerald-400" /> },
    { id: 'tts', label: t('语音克隆', 'Voice'), icon: <AudioLines size={15} className="text-sky-400" /> },
    { id: 'image', label: t('图片生成', 'Image'), icon: <ImageIcon size={15} className="text-amber-400" /> },
    { id: 'templates', label: t('接口模板', 'Templates'), icon: <Blocks size={15} className="text-violet-400" /> },
  ];

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-card border border-white/10 rounded-xl shadow-2xl w-[760px] max-w-[94vw] h-[560px] max-h-[88vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 h-12 border-b border-white/10 shrink-0">
          <h2 className="text-base font-bold">{t('设置 · AI', 'Settings · AI')}</h2>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5">
            <X size={16} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <aside className="w-44 shrink-0 border-r border-white/10 p-2 space-y-1">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setSection(tab.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                  section === tab.id ? 'bg-white/[0.1] text-foreground font-medium' : 'text-foreground/75 hover:bg-white/[0.05]'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </aside>
          <main className="flex-1 min-w-0 overflow-y-auto p-4">
            {section === 'templates'
              ? <TemplatesPane />
              : <ProviderPanel kind={section} />}
          </main>
        </div>
      </div>
    </div>
  );
}
