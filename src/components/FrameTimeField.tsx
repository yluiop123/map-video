import type { CSSProperties } from 'react';
import { frameToSeconds, secondsToFrame, round2 } from '../lib/time';

interface FrameTimeFieldProps {
  value: number;
  fps: number;
  onFrameChange: (frame: number) => void;
  min?: number;
  className?: string;
  title?: string;
  textClass?: string;
  style?: CSSProperties;
}

/**
 * 以「秒」为单位的输入框，内部仍换算为帧。
 * step 默认为 1/fps，保证输入与帧对齐，尽量减少显示抖动。
 */
export function FrameTimeField({
  value,
  fps,
  onFrameChange,
  min = 0,
  className,
  title,
  textClass,
  style,
}: FrameTimeFieldProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, ...style }}>
      <input
        type="number"
        min={min}
        step={Math.max(0.01, 1 / fps)}
        value={round2(frameToSeconds(value, fps))}
        onChange={(e) => onFrameChange(secondsToFrame(parseFloat(e.target.value) || 0, fps))}
        className={className ?? 'input'}
        title={title}
        style={{ flex: 1, minWidth: 0 }}
      />
      <span className={textClass ?? 'text-xs text-muted-foreground shrink-0'}>s</span>
    </div>
  );
}
