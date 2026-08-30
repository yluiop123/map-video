import { useProjectStore } from '../stores/projectStore';
import { useEditorStore } from '../stores/editorStore';
import { FrameTimeField } from './FrameTimeField';
import type { Chapter, CameraKeyframe, EasingType } from '../types';

const EASINGS: EasingType[] = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'cubicIn', 'cubicOut', 'cubicInOut', 'spring', 'bounce'];

export function CameraEditor({ chapter }: { chapter: Chapter }) {
  const setChapterCamera = useProjectStore((s) => s.setChapterCamera);
  const fps = useProjectStore((s) => s.project?.globalConfig.defaultFPS ?? 30);
  const currentFrame = useEditorStore((s) => s.currentFrame);
  const currentCamera = useEditorStore((s) => s.currentCamera);

  const camera = chapter.camera || [];

  const addKeyframe = () => {
    // 默认值 = 当前地图视角 + 当前播放帧
    const frame = Math.max(chapter.startFrame, Math.round(currentFrame));
    const newKf: CameraKeyframe = {
      frame,
      center: currentCamera.center,
      zoom: currentCamera.zoom,
      pitch: currentCamera.pitch || 0,
      bearing: currentCamera.bearing || 0,
      easing: 'linear',
      moveDuration: Math.min(2 * fps, Math.max(0, frame - (camera.length ? camera[camera.length - 1].frame : chapter.startFrame))),
    };
    // 若该帧已有关键帧，则更新它；否则追加
    const exists = camera.some((kf) => Math.abs(kf.frame - frame) < 0.5);
    if (exists) {
      setChapterCamera(chapter.id, camera.map((kf) => (Math.abs(kf.frame - frame) < 0.5 ? { ...kf, ...newKf } : kf)));
    } else {
      setChapterCamera(chapter.id, [...camera, newKf].sort((a, b) => a.frame - b.frame));
    }
  };

  const updateKeyframe = (index: number, changes: Partial<CameraKeyframe>) => {
    const next = camera.map((kf, i) => (i === index ? { ...kf, ...changes } : kf));
    setChapterCamera(chapter.id, next);
  };

  const removeKeyframe = (index: number) => {
    setChapterCamera(chapter.id, camera.filter((_, i) => i !== index));
  };

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">镜头关键帧</h2>
        <button onClick={addKeyframe} className="btn-outline text-xs px-2 py-1">+ 添加</button>
      </div>

      {camera.length === 0 && (
        <p className="text-xs text-muted-foreground">暂无镜头关键帧。点击"添加"创建初始镜头。</p>
      )}

      {camera.map((kf, i) => (
        <div key={i} className="border rounded p-2 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">关键帧 {i + 1}</span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => {
                  const prev = camera[i - 1];
                  const startFrame = prev ? prev.frame : chapter.startFrame;
                  const dur = ((kf.frame - startFrame) / fps);
                  useEditorStore.getState().seekCamera(
                    { center: kf.center, zoom: kf.zoom, pitch: kf.pitch || 0, bearing: kf.bearing || 0 },
                    kf.easing || 'linear',
                    Math.max(0.2, Math.min(6, dur))
                  );
                }}
                className="text-xs text-blue-500 hover:text-blue-700"
                title="跳到该视角（沿用此关键帧的缓动与时长）"
              >
                跳此视角
              </button>
              <button onClick={() => removeKeyframe(i)} className="text-xs text-red-500 hover:text-red-700">×</button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">时间(秒)</label>
              <FrameTimeField value={kf.frame} fps={fps} onFrameChange={(f) => updateKeyframe(i, { frame: f })} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">缩放</label>
              <input type="number" value={kf.zoom} onChange={(e) => updateKeyframe(i, { zoom: parseFloat(e.target.value) || 0 })} className="input" step="0.1" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">经度</label>
              <input type="number" value={Number(kf.center[0]).toFixed(5)} onChange={(e) => updateKeyframe(i, { center: [parseFloat(e.target.value) || 0, kf.center[1]] })} className="input" step="0.00001" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">纬度</label>
              <input type="number" value={Number(kf.center[1]).toFixed(5)} onChange={(e) => updateKeyframe(i, { center: [kf.center[0], parseFloat(e.target.value) || 0] })} className="input" step="0.00001" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">俯仰</label>
              <input type="number" value={kf.pitch || 0} onChange={(e) => updateKeyframe(i, { pitch: parseFloat(e.target.value) || 0 })} className="input" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">旋转</label>
              <input type="number" value={kf.bearing || 0} onChange={(e) => updateKeyframe(i, { bearing: parseFloat(e.target.value) || 0 })} className="input" />
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground block mb-1">缓动</label>
            <select value={kf.easing || 'linear'} onChange={(e) => updateKeyframe(i, { easing: e.target.value as EasingType })} className="input">
              {EASINGS.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>
        </div>
      ))}
    </div>
  );
}
