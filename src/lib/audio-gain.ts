/**
 * audio-gain.ts —— 配音音量超过 100% 时唯一的拿法：**把倍率烘进字节**。
 *
 * 为什么不在播放器里乘：预览的 `HTMLAudioElement.volume` 取值域就是 [0,1]，
 * 导出用的 `@remotion/web-renderer` 也不支持 Remotion 那套 >1 放大（见 AGENTS §6.31）。
 * 所以 ≤100% 走混音（即时、零成本），>100% 只能解码 → 增益 → 重编码一次（本地，不碰上游、不花配额）。
 *
 * 两端都读同一个 `narrationGain`，别在调用处各写一份判据。
 */

/** 整片配音音量（0–3）：1 以下混音，1 以上离线增益 */
export function narrationGain(volume: number | undefined): number {
  return Math.min(3, Math.max(0, volume ?? 1));
}

/** 需要烘进字节的那一份倍率（≤1 时恒为 1，交给混音去做） */
export function bakeGain(g: number): number {
  return g > 1 ? g : 1;
}

/** 交给播放器 / Remotion 的那一份倍率（烘进字节后就不再乘，避免算两遍） */
export function mixGain(g: number): number {
  return g > 1 ? 1 : g;
}

/** Float32 → 16 位 PCM WAV（浏览器没有编码器，只能自己写头） */
function encodeWav(buf: AudioBuffer): Blob {
  const ch = buf.numberOfChannels, rate = buf.sampleRate, n = buf.length;
  const bytes = 44 + n * ch * 2;
  const out = new DataView(new ArrayBuffer(bytes));
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) out.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, bytes - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * ch * 2, true);
  out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, n * ch * 2, true);
  const chans: Float32Array[] = [];
  for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
  let off = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      out.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}

/**
 * 按倍率放大一段音频，返回可直接播放的 objectURL。
 * 失败（解码不了 / 没上下文）返回 null，调用端退回原始地址 —— 顶多是不响，别把导出整条堵死。
 */
export async function amplifiedWavUrl(bytes: Uint8Array, gain: number): Promise<string | null> {
  if (gain <= 1) return null;
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const probe = new Ctor();
    const decoded = await probe.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    void probe.close();
    const off = new OfflineAudioContext(decoded.numberOfChannels, decoded.length, decoded.sampleRate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    const g = off.createGain();
    g.gain.value = gain;
    src.connect(g).connect(off.destination);
    src.start();
    const wav = encodeWav(await off.startRendering());
    return URL.createObjectURL(wav);
  } catch {
    return null;
  }
}
