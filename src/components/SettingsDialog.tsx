/**
 * SettingsDialog.tsx — ⚙ 设置 · AI 外壳
 *
 * 左侧三类能力 + 独立的「接口模板」入口，右侧是对应页面（日常项与专家项不混在同一屏）。
 * 用 shadcn 的 Dialog（自带遮罩 / Esc / 焦点管理 / 关闭按钮）+ 竖排 Tabs 当左侧导航。
 */
import { useState } from 'react';
import { Bot, AudioLines, ImageIcon, Blocks } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { ProviderPanel } from './ProviderPanel';
import { TemplatesPane } from './TemplatesPane';
import { useT } from './ui/primitives';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

type Section = 'llm' | 'tts' | 'image' | 'templates';

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const t = useT();
  const [section, setSection] = useState<Section>('llm');

  const TABS: { id: Section; label: string; icon: React.ReactNode }[] = [
    { id: 'llm', label: t('文案生成', 'Text'), icon: <Bot size={15} className="text-emerald-400" /> },
    { id: 'tts', label: t('语音克隆', 'Voice'), icon: <AudioLines size={15} className="text-sky-400" /> },
    { id: 'image', label: t('图片生成', 'Image'), icon: <ImageIcon size={15} className="text-amber-400" /> },
    { id: 'templates', label: t('接口模板', 'Templates'), icon: <Blocks size={15} className="text-violet-400" /> },
  ];

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        className="flex h-[min(860px,92vh)] w-[min(1200px,95vw)] max-w-none flex-col gap-0 overflow-hidden bg-card p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader className="shrink-0 flex-row items-center gap-2 space-y-0 border-b border-white/10 px-4 py-3 text-left sm:text-left">
          <DialogTitle className="text-base font-bold">{t('设置 · AI', 'Settings · AI')}</DialogTitle>
        </DialogHeader>

        <Tabs value={section} onValueChange={(v) => setSection(v as Section)} orientation="vertical" className="flex min-h-0 flex-1">
          <TabsList className="h-auto w-44 shrink-0 flex-col items-stretch justify-start gap-1 rounded-none border-r border-white/10 bg-transparent p-2">
            {TABS.map((tab) => (
              <TabsTrigger
                key={tab.id}
                value={tab.id}
                className="justify-start gap-2 rounded-md px-3 py-2 text-sm data-[state=active]:bg-white/10 data-[state=active]:text-foreground data-[state=active]:shadow-none"
              >
                {tab.icon}
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="min-h-0 min-w-0 flex-1 overflow-hidden p-4">
            {section === 'templates'
              ? <TemplatesPane />
              : <div className="h-full overflow-y-auto pr-1"><ProviderPanel kind={section} /></div>}
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
