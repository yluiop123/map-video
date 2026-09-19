import { useState, useEffect } from 'react';
import { Video, FileJson, X } from 'lucide-react';
import { useProjectStore } from '../stores/projectStore';
import { exportVideo, downloadBlob, checkExportSupport } from '../lib/export-video';

interface ExportDialogProps {
  onClose: () => void;
}


type ExportTab = 'video' | 'config';

export function ExportDialog({ onClose }: ExportDialogProps) {
  const project = useProjectStore((s) => s.project);
  const [tab, setTab] = useState<ExportTab>('video');
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [support, setSupport] = useState<boolean | null>(null);

  const resolution = project?.globalConfig.defaultResolution;

  useEffect(() => {
    if (!project || !resolution) return;
    checkExportSupport(project, resolution.width, resolution.height).then(setSupport);
  }, [project, resolution?.width, resolution?.height]);

  if (!project || !resolution) return null;

  const handleExportVideo = async () => {
    setExporting(true);
    setError(null);
    setProgress(0);
    try {
      const blob = await exportVideo({
        project,
        width: resolution.width,
        height: resolution.height,
        onProgress: (p) => setProgress(p),
      });
      downloadBlob(blob, `${project.name || 'map-video'}.mp4`);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setExporting(false);
    }
  };

  const handleExportConfig = async () => {
    setError(null);
    const data = await useProjectStore.getState().createExport().catch((err) => {
      console.error(err);
      setError(err instanceof Error ? err.message : '导出配置失败');
      return null;
    });
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name || 'project'}-config.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const navBtn = (on: boolean) =>
    `w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
      on ? 'bg-white/[0.1] text-foreground font-medium' : 'text-foreground/75 hover:bg-white/[0.05]'
    }`;

  const TABS: { id: ExportTab; label: string; icon: React.ReactNode }[] = [
    { id: 'video', label: '视频', icon: <Video size={15} className="text-sky-400" /> },
    { id: 'config', label: '项目配置', icon: <FileJson size={15} className="text-amber-400" /> },
  ];

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-card border border-white/10 rounded-xl shadow-2xl w-[620px] max-w-[92vw] h-[420px] max-h-[86vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 h-12 border-b border-white/10 shrink-0">
          <h2 className="text-base font-bold">导出</h2>
          <button onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-white/5">
            <X size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左侧设置按钮 */}
          <aside className="w-40 shrink-0 border-r border-white/10 p-2 space-y-1">
            {TABS.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)} className={navBtn(tab === t.id)}>
                {t.icon}
                {t.label}
              </button>
            ))}
          </aside>

          {/* 右侧内容 */}
          <main className="flex-1 min-w-0 overflow-y-auto p-4">
            {tab === 'video' ? (
              <div className="space-y-3">
                <div>
                  <h3 className="font-medium text-sm mb-2">导出视频 (MP4)</h3>
                  <p className="text-xs text-muted-foreground">
                    画幅 {resolution.width}×{resolution.height} px（在时间线「画幅」按钮切换）
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">
                  使用 Remotion 在浏览器中渲染导出。
                  {support === false && <span className="text-red-500"> 当前浏览器不支持 WebCodecs，可能无法导出。</span>}
                </p>
                {exporting ? (
                  <div>
                    <div className="w-full h-2 bg-white/10 rounded overflow-hidden">
                      <div className="h-full bg-primary transition-[width]" style={{ width: `${progress * 100}%` }} />
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">导出中… {Math.round(progress * 100)}%</p>
                  </div>
                ) : (
                  <button onClick={handleExportVideo} className="btn-primary text-sm w-full py-2">开始导出视频</button>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <h3 className="font-medium text-sm">导出项目配置 (JSON)</h3>
                <p className="text-xs text-muted-foreground">导出整个项目，可导入复用（跨设备/跨端迁移）。</p>
                <button onClick={handleExportConfig} className="btn-outline text-sm w-full py-2">导出配置</button>
              </div>
            )}
            {error && <p className="text-xs text-red-500 mt-3">{error}</p>}
          </main>
        </div>
      </div>
    </div>
  );
}
