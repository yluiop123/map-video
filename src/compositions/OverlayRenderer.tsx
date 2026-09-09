/**
 * 导出端弹窗渲染（编辑器预览共用 components/fx/FxRender 的实现）。
 * 保留原组件 API（overlays + frame），其余表现全部走共享层。
 */
import { AbsoluteFill } from 'remotion';
import type { OverlayItem } from '../types';
import { OverlayCard } from '../components/fx/FxRender';

interface OverlayRendererProps {
  overlays: OverlayItem[];
  /** 绝对帧号（相对整个项目时间线）。overlay.startFrame/endFrame 为绝对帧。 */
  frame: number;
}

export function OverlayRenderer({ overlays, frame }: OverlayRendererProps) {
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {(overlays || []).map((overlay) => (
        <OverlayCard key={overlay.id} overlay={overlay} frame={frame} />
      ))}
    </AbsoluteFill>
  );
}
