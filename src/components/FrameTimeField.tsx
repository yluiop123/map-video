import type { CSSProperties } from 'react';
import { frameToSeconds, secondsToFrame } from '../lib/time';
import { NumberInput } from './ui/primitives';

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
 * 编辑期间展示原始文本，失焦/回车提交，避免输入过程被回写打断。
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
  const secs = Math.round(frameToSeconds(value, fps) * 100) / 100;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, ...style }}>
      <NumberInput
        value={secs}
        onCommit={(v) => onFrameChange(secondsToFrame(Math.max(min, v || 0), fps))}
        className={className ?? 'input'}
        min={min}
        step={1 / fps}
        title={title}
        style={{ flex: 1, minWidth: 0 }}
      />
      <span className={textClass ?? 'text-xs text-muted-foreground shrink-0'}>s</span>
    </div>
  );
}
