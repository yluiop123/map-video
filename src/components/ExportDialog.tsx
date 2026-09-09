import { useState, useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore';
import {
  exportVideo, downloadBlob, checkExportSupport, EXPORT_PRESETS,
} from '../lib/export-video';
import { downloadGeoJSON } from '../lib/geojson';

interface ExportDialogProps {
  onClose: () => void;
}

const FPS_OPTIONS = [24, 30, 60];

export function ExportDialog({ onClose }: ExportDialogProps) {
  const project = useProjectStore((s) => s.project);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [support, setSupport] = useState<boolean | null>(null);

  // 导出画幅预设（默认横屏1080p）
  const [presetIdx, setPresetIdx] = useState(0);
  const [fps, setFps] = useState(project?.globalConfig.defaultFPS ?? 30);
  const preset = EXPORT_PRESETS[presetIdx];

  useEffect(() => {
    if (!project) return;
    checkExportSupport(project, preset.width, preset.height).then(setSupport);
  }, [project, preset.width, preset.height]);

  if (!project) return null;

  const handleExportVideo = async () => {
    setExporting(true);
    setError(null);
    try {
      const blob = await exportVideo({
        project,
        width: preset.width,
        height: preset.height,
        fps,
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

  const handleExportConfig = () => {
    const data = useProjectStore.getState().createExport();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${project.name || 'project'}-config.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportGeoJSON = () => {
    const elements = project.chapters.flatMap((ch) => ch.elements);
    downloadGeoJSON(elements, `${project.name || 'map'}`);
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-card border border-white/10 rounded-xl shadow-2xl p-5 w-96" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold mb-4">导出</h2>

        <div className="space-y-3">
          {/* 视频导出 */}
          <div className="border border-white/10 bg-white/[0.03] rounded-lg p-3">
            <h3 className="font-medium text-sm mb-2">导出视频 (MP4)</h3>

            {/* 画幅预设 */}
            <div className="mb-2">
              <label className="text-xs text-muted-foreground block mb-1">画幅</label>
              <div className="grid grid-cols-2 gap-1">
                {EXPORT_PRESETS.map((p, i) => (
                  <button
                    key={p.label}
                    onClick={() => setPresetIdx(i)}
                    className={`px-2 py-1 text-xs border rounded truncate ${
                      presetIdx === i ? 'bg-white text-black border-white' : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.07]'
                    }`}
                    title={`${p.width}×${p.height}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {preset.width}×{preset.height} px
              </div>
            </div>

            {/* 帧率 */}
            <div className="mb-3">
              <label className="text-xs text-muted-foreground block mb-1">帧率</label>
              <div className="flex gap-1">
                {FPS_OPTIONS.map((f) => (
                  <button
                    key={f}
                    onClick={() => setFps(f)}
                    className={`px-3 py-1 text-xs border rounded ${
                      fps === f ? 'bg-white text-black border-white' : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.07]'
                    }`}
                  >
                    {f} fps
                  </button>
                ))}
              </div>
            </div>

            <p className="text-xs text-muted-foreground mb-2">
              使用 Remotion 在浏览器中渲染导出。
              {support === false && <span className="text-red-500"> 当前浏览器不支持 WebCodecs，可能无法导出。</span>}
            </p>
            {exporting ? (
              <div>
                <div className="w-full h-2 bg-white/10 rounded overflow-hidden">
                  <div className="h-full bg-primary" style={{ width: `${progress * 100}%` }} />
                </div>
                <p className="text-xs text-muted-foreground mt-1">{Math.round(progress * 100)}%</p>
              </div>
            ) : (
              <button onClick={handleExportVideo} className="btn-primary text-sm w-full py-2">开始导出视频</button>
            )}
            {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
          </div>

          {/* 配置文件导出 */}
          <div className="border border-white/10 bg-white/[0.03] rounded-lg p-3">
            <h3 className="font-medium text-sm mb-2">导出项目配置 (JSON)</h3>
            <p className="text-xs text-muted-foreground mb-2">导出整个项目，可导入复用（跨设备/跨端迁移）。</p>
            <button onClick={handleExportConfig} className="btn-outline text-sm w-full py-2">导出配置</button>
          </div>

          {/* GeoJSON 导出 */}
          <div className="border border-white/10 bg-white/[0.03] rounded-lg p-3">
            <h3 className="font-medium text-sm mb-2">导出要素 (GeoJSON)</h3>
            <p className="text-xs text-muted-foreground mb-2">导出所有点线面要素为 GeoJSON。</p>
            <button onClick={handleExportGeoJSON} className="btn-outline text-sm w-full py-2">导出 GeoJSON</button>
          </div>
        </div>

        <button onClick={onClose} className="mt-4 text-sm text-muted-foreground hover:text-foreground w-full text-center">
          关闭
        </button>
      </div>
    </div>
  );
}
