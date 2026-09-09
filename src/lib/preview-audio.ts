/**
 * 预览音频同步（编辑器）：订阅 editorStore 播放头，驱动 配音 + 背景音乐 HTMLAudio 池。
 * - 播放中：按帧计算目标偏移，漂移 >0.3s 自动 seek；BGM 循环取模
 * - 暂停/跳帧/出章：全部暂停
 * 导出端不走这里（Remotion <Audio> 混流）。
 */
import { useEditorStore } from '../stores/editorStore';
import { useProjectStore } from '../stores/projectStore';
import type { Chapter } from '../types';

const pool = new Map<string, HTMLAudioElement>();

function getEl(url: string): HTMLAudioElement {
  let el = pool.get(url);
  if (!el) {
    el = new Audio(url);
    el.preload = 'auto';
    pool.set(url, el);
  }
  return el;
}

function pauseAll(): void {
  for (const el of pool.values()) {
    if (!el.paused) el.pause();
  }
}

interface Desired {
  vol: number;
  /** 目标播放偏移（秒，章内相对） */
  offset: number;
  loop: boolean;
}

function desiredAt(chapter: Chapter, frame: number, fps: number): Map<string, Desired> {
  const f = frame - chapter.startFrame; // 章内相对帧
  const map = new Map<string, Desired>();
  // 配音：字幕条激活区间播放，音量恒定
  const nar = chapter.narration;
  if (nar) {
    for (const e of nar.entries) {
      if (!e.audioUrl) continue;
      if (f >= e.startFrame && f < e.startFrame + e.durationFrames) {
        map.set(e.audioUrl, { vol: 1, offset: (f - e.startFrame) / fps, loop: false });
      }
    }
  }
  // 背景音乐：区间 + 音量淡入淡出
  for (const m of chapter.music || []) {
    if (f < m.startFrame || f >= m.endFrame) continue;
    const local = f - m.startFrame;
    const len = Math.max(1, m.endFrame - m.startFrame);
    const fadeInF = Math.max(1, Math.round((m.fadeIn || 0) * fps));
    const fadeOutF = Math.max(1, Math.round((m.fadeOut || 0) * fps));
    const inV = m.fadeIn > 0 ? Math.min(1, local / fadeInF) : 1;
    const outV = m.fadeOut > 0 ? Math.min(1, (len - local) / fadeOutF) : 1;
    map.set(m.url, { vol: (m.volume ?? 0.6) * Math.min(inV, outV), offset: local / fps, loop: !!m.loop });
  }
  return map;
}

let syncing = false;

function sync(): void {
  if (syncing) return;
  syncing = true;
  try {
    const { isPlaying, currentFrame, selectedChapterId } = useEditorStore.getState();
    const project = useProjectStore.getState().project;
    if (!isPlaying || !project) {
      pauseAll();
      return;
    }
    const chapter = project.chapters.find((c) => c.id === selectedChapterId) || project.chapters[0];
    if (!chapter || currentFrame < chapter.startFrame || currentFrame >= chapter.endFrame) {
      pauseAll();
      return;
    }
    const fps = project.globalConfig.defaultFPS || 30;
    const want = desiredAt(chapter, currentFrame, fps);
    // 激活需要的音频
    for (const [url, d] of want) {
      const el = getEl(url);
      el.loop = d.loop;
      el.volume = Math.max(0, Math.min(1, d.vol));
      const target = d.loop && el.duration > 0 ? d.offset % el.duration : d.offset;
      if (el.paused) {
        try {
          el.currentTime = target;
          void el.play().catch(() => { /* 自动播放策略拒绝时静默 */ });
        } catch { /* seek 未就绪 */ }
      } else {
        // 漂移校正（循环音频取模距离）
        const dur = el.duration || Infinity;
        let drift = el.currentTime - target;
        if (d.loop && dur !== Infinity) {
          drift = ((drift % dur) + dur) % dur;
          drift = Math.min(drift, dur - drift);
        }
        if (Math.abs(drift) > 0.3) {
          try { el.currentTime = target; } catch { /* 未就绪 */ }
        }
      }
    }
    // 停掉不再需要的
    for (const [url, el] of pool) {
      if (!want.has(url) && !el.paused) el.pause();
    }
  } finally {
    syncing = false;
  }
}

let mounted = false;

/** App 挂载时调用一次；订阅播放头/播放态变化驱动音频 */
export function mountPreviewAudio(): void {
  if (mounted) return;
  mounted = true;
  useEditorStore.subscribe(sync);
}
