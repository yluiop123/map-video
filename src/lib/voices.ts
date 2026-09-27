/**
 * voices.ts — 内置的**克隆参考样本**清单
 *
 * 系统音色表不在这里：那是一家上游的数据，住在接口模板里
 * （`src/lib/template-seed.ts` 的 `qwenVoices` / `elevenLabsVoices`，作为「音色 ID」那条参数的候选值），
 * 铺进库后可以在 ⚙ 的接口模板页里改。这里只留随包发布的两段样本音频 —— 它们不是上游数据，
 * 是「拿去克隆的素材」，换文件即换音色来源。
 * **克隆出来的音色账本也不在这里**：那是 `voice` 表的事（stores/voiceStore.ts），
 * voiceId 绑「哪个实例 + 哪个目标模型」，还要记住参考音频原件，localStorage 担不住。
 */

/**
 * 打进应用的参考音频（public/voices/）：一键克隆的样本，
 * 来自本地录音（历史-男.mp3 / 历史-女.mp3）。
 */
export const CLIP_PRESETS = [
  { key: 'male', label: '男声', file: 'voices/male.mp3' },
  { key: 'female', label: '女声', file: 'voices/female.mp3' },
] as const;

export type ClipKey = (typeof CLIP_PRESETS)[number]['key'];

/** 取应用内参考音频的字节（相对 BASE_URL 解析） */
export async function fetchClipBytes(file: string): Promise<ArrayBuffer> {
  // 与内置音乐库同一套解析方式（document.baseURI 已含 vite base 前缀）
  const res = await fetch(new URL(file, document.baseURI).href);
  if (!res.ok) throw new Error(`读取参考音频失败 ${file}（HTTP ${res.status}）`);
  return res.arrayBuffer();
}
