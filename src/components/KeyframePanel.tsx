import { Trash2, Crosshair, Plus } from 'lucide-react';
import { useProjectStore } from '../stores/projectStore';
import { useConfirm } from './ui/ConfirmHost';
import { useEditorStore } from '../stores/editorStore';
import { FrameTimeField } from './FrameTimeField';
import { EASING_OPTIONS } from '../lib/easing-labels';
import { Section, Field, OptionBlocks, useT } from './ui/primitives';
import type { CameraKeyframe, EasingType } from '../types';

/**
 * 镜头关键帧属性面板（选中底部 Storyboard 卡片时出现在右侧）
 */
export function KeyframePanel({ chapter, index }: { chapter: NonNullable<ReturnType<typeof useProjectStore.getState>['project']>['chapters'][number]; index: number }) {
  const fps = useProjectStore((s) => s.project?.globalConfig.defaultFPS ?? 30);
  const setChapterCamera = useProjectStore((s) => s.setChapterCamera);
  const selectChapter = useEditorStore((s) => s.selectChapter);
  const setCurrentFrame = useEditorStore((s) => s.setCurrentFrame);
  const selectKeyframe = useEditorStore((s) => s.selectKeyframe);
  const t = useT();
  const confirm = useConfirm();

  const kfs = [...(chapter.camera || [])].sort((a, b) => a.frame - b.frame);
  const kf = kfs[index];

  if (!kf) {
    return <div className="p-4 text-sm text-muted-foreground">该关键帧已被删除</div>;
  }

  const patchKf = (changes: Partial<CameraKeyframe>) => {
    setChapterCamera(chapter.id, kfs.map((k, i) => (i === index ? { ...k, ...changes } : k)));
  };

  /** 删除本关键帧（起始帧锚定不可删） */
  const removeKf = async () => {
    if (index === 0) return;
    const ok = await confirm({ message: `删除「视角 ${index + 1}」？`, danger: true, confirmText: '删除' });
    if (!ok) return;
    setChapterCamera(chapter.id, kfs.filter((_, i) => i !== index));
    selectKeyframe(null);
  };

  // ===== 时间约束：必须落在 [上一帧+1, 下一帧-1] 且在本章范围内 =====
  const MIN_GAP = 1; // 相邻关键帧最小间隔（帧）
  const prevF = index > 0 ? kfs[index - 1].frame : chapter.startFrame;
  const nextF = index < kfs.length - 1 ? kfs[index + 1].frame : chapter.endFrame;
  const lo = Math.max(chapter.startFrame, index === 0 ? chapter.startFrame : prevF + MIN_GAP);
  let hi = Math.min(chapter.endFrame, nextF - MIN_GAP);
  if (hi < lo) hi = lo; // 区间过窄时兜底

  const gapFrames = Math.max(0, kf.frame - prevF); // 与上一帧的间隔
  const gapSec = gapFrames / fps;

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

  const patchTime = (f: number) => {
    const nf = clamp(Math.round(f), lo, hi);
    const changes: Partial<CameraKeyframe> = { frame: nf };
    // 到达时间提前后，移动时长若超出新间隔则同步截断
    const newGap = Math.max(0, nf - prevF);
    if (typeof kf.moveDuration === 'number') {
      changes.moveDuration = Math.min(kf.moveDuration, newGap);
    }
    patchKf(changes);
  };

  const patchMoveSec = (sec: number) => {
    patchKf({ moveDuration: clamp(Math.round(sec * fps), 0, gapFrames) });
  };

  const jumpTo = () => {
    selectChapter(chapter.id);
    setCurrentFrame(Math.round(kf.frame));
    const startF = index > 0 ? kfs[index - 1].frame : chapter.startFrame;
    const moveFrames = typeof kf.moveDuration === 'number' ? Math.min(kf.moveDuration, kf.frame - startF) : kf.frame - startF;
    const dur = Math.max(0.2, Math.min(6, moveFrames / fps));
    useEditorStore.getState().seekCamera(
      { center: kf.center, zoom: kf.zoom, pitch: kf.pitch || 0, bearing: kf.bearing || 0 },
      kf.easing || 'linear',
      dur
    );
  };

  const gapFramesTotal = Math.max(0, kf.frame - prevF);
  const moveSec = typeof kf.moveDuration === 'number' ? kf.moveDuration / fps : Math.min(2, gapFramesTotal / fps);

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t('视角', 'View')} {index + 1}</h2>
        <div className="flex items-center gap-1">
          <button onClick={jumpTo} className="btn-outline text-xs px-2 py-1 flex items-center gap-1"><Crosshair size={12} /> {t('跳此视角', 'Go to View')}</button>
          <button
            onClick={() => {
              const cam = useEditorStore.getState().currentCamera;
              let frame = Math.max(chapter.startFrame, Math.round(useEditorStore.getState().currentFrame));
              while (kfs.some((k) => Math.abs(k.frame - frame) < 1)) frame += fps;
              const next = [...kfs, {
                frame, center: [cam.center[0], cam.center[1]] as [number, number],
                zoom: cam.zoom, pitch: cam.pitch || 0, bearing: cam.bearing || 0, easing: 'easeInOut' as const,
              }].sort((a, b) => a.frame - b.frame);
              setChapterCamera(chapter.id, next);
              selectKeyframe(next.findIndex((k) => k.frame === frame));
            }}
            className="btn-outline text-xs px-2 py-1 flex items-center gap-1"
            title="以当前地图视角+当前播放帧新增一个视角"
          >
            <Plus size={12} /> {t('新视角', 'New View')}
          </button>
          <button
            onClick={removeKf}
            disabled={index === 0}
            className="btn-outline text-xs px-2 py-1 flex items-center gap-1 text-red-400/80 hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed"
            title={index === 0 ? '起始视角不可删除' : '删除该视角'}
          >
            <Trash2 size={12} /> {t('删除', 'Delete')}
          </button>
        </div>
      </div>

      <Section title={t('时间与过渡', 'Timing & Transition')}>
        {index > 0 && kfs[index - 1] && (() => {
          const p = kfs[index - 1];
          const same = Math.abs(p.center[0] - kf.center[0]) < 1e-6
            && Math.abs(p.center[1] - kf.center[1]) < 1e-6
            && Math.abs(p.zoom - kf.zoom) < 0.01
            && Math.abs((p.pitch || 0) - (kf.pitch || 0)) < 0.5
            && Math.abs((p.bearing || 0) - (kf.bearing || 0)) < 0.5;
          return same ? (
            <p className="text-[11px] text-amber-500/90 bg-amber-500/10 border border-amber-500/20 rounded-md px-2 py-1.5 mb-2">
              {t('⚠️ 本视角与上一视角画面完全相同——这段播放时镜头不会移动。请先在地图上换个位置/缩放，再点「＋ 新视角」或直接修改下方参数。', '⚠️ This view is identical to the previous one — the camera will stay still during playback. Move/zoom the map first, then add a new view or edit the parameters below.')}
            </p>
          ) : null;
        })()}
        <Field label={t('到达时间 (秒)', 'Arrival Time (s)')}>
          <FrameTimeField value={kf.frame} fps={fps} onFrameChange={patchTime} />
          <p className="text-[11px] text-muted-foreground mt-1">
            允许 {((lo - chapter.startFrame) / fps).toFixed(1)}s – {((hi - chapter.startFrame) / fps).toFixed(1)}s（不得越过相邻视角）
          </p>
        </Field>
        <Field label={t('移动持续时长 (秒，默认 2s)', 'Move Duration (s, default 2s)')}>
          <input
            type="number" step={Math.max(0.01, 1 / fps)} min={0}
            max={gapSec}
            className="input"
            value={moveSec.toFixed(2)}
            onChange={(e) => patchMoveSec(parseFloat(e.target.value) || 0)}
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            0 – {gapSec.toFixed(1)}s（不超过与上一视角的间隔）；到期前镜头停留在上一视角
          </p>
        </Field>
      </Section>

      <Section title={t('视角参数', 'View Parameters')}>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('经度 (-180 ~ 180)', 'Longitude (-180 ~ 180)')}>
            <input type="number" step="0.00001" min={-180} max={180} className="input" value={Number(kf.center[0]).toFixed(5)}
              onChange={(e) => patchKf({ center: [clamp(parseFloat(e.target.value) || 0, -180, 180), kf.center[1]] })} />
          </Field>
          <Field label={t('纬度 (-85 ~ 85)', 'Latitude (-85 ~ 85)')}>
            <input type="number" step="0.00001" min={-85} max={85} className="input" value={Number(kf.center[1]).toFixed(5)}
              onChange={(e) => patchKf({ center: [kf.center[0], clamp(parseFloat(e.target.value) || 0, -85, 85)] })} />
          </Field>
          <Field label={t('缩放 (0 ~ 22)', 'Zoom (0 ~ 22)')}>
            <input type="number" step="0.1" min="0" max="22" className="input" value={Number(kf.zoom.toFixed(1))}
              onChange={(e) => patchKf({ zoom: clamp(parseFloat(e.target.value) || 0, 0, 22) })} />
          </Field>
          <Field label={t('俯仰 (0 ~ 85)', 'Pitch (0 ~ 85)')}>
            <input type="number" step="1" min="0" max="85" className="input" value={Math.round(kf.pitch || 0)}
              onChange={(e) => patchKf({ pitch: clamp(parseFloat(e.target.value) || 0, 0, 85) })} />
          </Field>
          <Field label={t('方向 (-180 ~ 180)', 'Bearing (-180 ~ 180)')}>
            <input type="number" step="1" min="-180" max="180" className="input" value={Math.round(kf.bearing || 0)}
              onChange={(e) => patchKf({ bearing: clamp(parseFloat(e.target.value) || 0, -180, 180) })} />
          </Field>
          <Field label={t('缓动', 'Easing')}>
            <OptionBlocks<EasingType>
              value={kf.easing || 'linear'}
              onChange={(v) => patchKf({ easing: v })}
              options={EASING_OPTIONS.map((o) => ({ value: o.value, title: o.title, label: t(o.label, { '平滑': 'Smooth', '匀速': 'Linear', '缓入': 'Ease In', '急停': 'Ease Out', '加速': 'Accelerate', '减速': 'Decelerate', '强平滑': 'Smooth+', '弹性': 'Spring', '弹跳': 'Bounce' }[o.label] || o.label) }))}
            />
          </Field>
        </div>
      </Section>

      <p className="text-[11px] text-muted-foreground leading-relaxed">
        {t('所有输入自动夹取到合法范围；相邻视角至少间隔 1 帧，起始视角（视角1）不可删除。', 'All inputs are clamped to valid ranges. Adjacent views are at least 1 frame apart; the first view cannot be deleted.')}
      </p>
    </div>
  );
}
