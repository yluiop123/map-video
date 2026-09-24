/**
 * 预览音频同步（编辑器）：订阅 editorStore 播放头，驱动 配音 + 背景音乐 HTMLAudio 池。
 * - 播放中：按帧计算目标偏移，漂移 >0.3s 自动 seek；BGM 循环取模
 * - 倍速预览：音频速率跟着 playRate 走，seek 只当漂移兜底
 * - 暂停/跳帧/出章：全部暂停
 * 导出端不走这里（Remotion <Audio> 混流）。
 */
import { useEditorStore } from '../stores/editorStore';
import { useProjectStore } from '../stores/projectStore';
import { getAssetUrl } from './assets';
import type { MapVideoProject } from '../types';

const pool = new Map<string, HTMLAudioElement>();

/**
 * 池子按 **assetId** 存（项目里只有 id）：元素先建好、地址异步补。
 * 地址没到位的那一帧直接跳过（getAssetUrl 带缓存，下一帧就有），不阻塞播放头。
 */
function getEl(assetId: string): HTMLAudioElement | null {
  let el = pool.get(assetId);
  if (!el) {
    el = new Audio();
    el.preload = 'auto';
    pool.set(assetId, el);
    void getAssetUrl(assetId).then((url) => { if (url && pool.get(assetId) === el) el!.src = url; });
  }
  return el.src || el.currentSrc ? el : null;
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

function desiredAt(project: MapVideoProject, frame: number, fps: number): Map<string, Desired> {
  const map = new Map<string, Desired>();
  // 配音：字幕条激活区间播放（条目 startFrame 为**项目绝对帧**），音量恒定
  const nar = project.narration;
  if (nar) {
    for (const e of nar.entries) {
      if (!e.audioId) continue;
      if (frame >= e.startFrame && frame < e.startFrame + e.durationFrames) {
        map.set(e.audioId, { vol: 1, offset: (frame - e.startFrame) / fps, loop: false });
      }
    }
  }
  return map;
}

/** 项目级背景音乐（绝对帧）：区间 + 音量淡入淡出 */
function musicAt(project: MapVideoProject, frame: number, fps: number): Map<string, Desired> {
  const map = new Map<string, Desired>();
  for (const m of project.music || []) {
    if (frame < m.startFrame || frame >= m.endFrame) continue;
    const local = frame - m.startFrame;
    const len = Math.max(1, m.endFrame - m.startFrame);
    const fadeInF = Math.max(1, Math.round((m.fadeIn || 0) * fps));
    const fadeOutF = Math.max(1, Math.round((m.fadeOut || 0) * fps));
    const inV = m.fadeIn > 0 ? Math.min(1, local / fadeInF) : 1;
    const outV = m.fadeOut > 0 ? Math.min(1, (len - local) / fadeOutF) : 1;
    map.set(m.audioId, { vol: (m.volume ?? 0.6) * Math.min(inV, outV), offset: local / fps, loop: !!m.loop });
  }
  return map;
}

let syncing = false;

function sync(): void {
  if (syncing) return;
  syncing = true;
  try {
    const { isPlaying, currentFrame, playRate } = useEditorStore.getState();
    const project = useProjectStore.getState().project;
    if (!isPlaying || !project) {
      pauseAll();
      return;
    }
    const fps = project.globalConfig.defaultFPS || 30;
    const want = new Map<string, Desired>();
    // 配音：仅在本章播放区间内
    if (project && currentFrame >= 0 && currentFrame < project.endFrame) {
      for (const [k, v] of desiredAt(project, currentFrame, fps)) want.set(k, v);
    }
    // 背景音乐：项目级，跨片段连续播放
    for (const [k, v] of musicAt(project, currentFrame, fps)) want.set(k, v);
    // 激活需要的音频
    for (const [assetId, d] of want) {
      const el = getEl(assetId);
      if (!el) continue;                       // 地址还在路上
      el.loop = d.loop;
      el.volume = Math.max(0, Math.min(1, d.vol));
      // 倍速预览：让音频自己跑快。实测改之前 playbackRate 一直是 1，播放头跑到 3× / 5× 时
      // 只能靠下面的 seek 硬追。界面最高 5×（本机 Chromium 支持到 16×），
      // preservesPitch 默认为 true，所以倍速下是「连续且不变调」。
      if (el.playbackRate !== playRate) el.playbackRate = playRate;
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
    for (const [assetId, el] of pool) {
      if (!want.has(assetId) && !el.paused) el.pause();
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
  // 项目数据变化也要重算（删除/替换正在播放的音乐、退出项目 → project 变 null）
  useProjectStore.subscribe(sync);
}

/** 立即停止全部预览音频（退出项目/卸载时调用） */
export function stopPreviewAudio(): void {
  pauseAll();
}
