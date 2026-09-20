/**
 * voices.ts — 配音音色目录 + 「我的克隆音色」账本
 *
 * ★ 系统音色名一律取自阿里云百炼官方音色表（CosyVoice 与 Qwen-TTS 是两套端点，
 *   名字互串上游就回 HTTP 400 "Model not exist."），不要在界面上现编。
 * 克隆出的 voice_id 绑在「克隆时用的模型」上，换模型即失效 —— 所以账本里连模型一起存。
 */

export type VoiceGender = 'male' | 'female';

export interface SystemVoice {
  /** 请求体 input.voice 的确切取值 */
  id: string;
  /** 表里的中文名 */
  name: string;
  gender: VoiceGender;
  /** 风格/用途（官方备注的摘要） */
  note?: string;
}

/**
 * CosyVoice 端点（/services/audio/tts/SpeechSynthesizer，含 qwen-audio-3.0-tts-flash）
 * 可用的成人叙述向音色。名字带 _v3 的属 v3 家族，与 v2 不通用。
 */
export const COSYVOICE_VOICES: SystemVoice[] = [
  { id: 'longanyang', name: '龙安洋', gender: 'male', note: '阳光男声 · 支持情感指令' },
  { id: 'longshuo_v3', name: '硕', gender: 'male', note: '新闻播报' },
  { id: 'longshu_v3', name: '书', gender: 'male', note: '新闻播报' },
  { id: 'longze_v3', name: '泽', gender: 'male', note: '活力男声' },
  { id: 'longtian_v3', name: '天', gender: 'male', note: '磁性理性' },
  { id: 'longcheng_v3', name: '橙', gender: 'male', note: '睿智青年' },
  { id: 'longanyun_v3', name: '安昀', gender: 'male', note: '居家温暖' },
  { id: 'longanzhi_v3', name: '安智', gender: 'male', note: '成熟稳重' },
  { id: 'longxiu_v3', name: '修', gender: 'male', note: '说书人' },
  { id: 'longnan_v3', name: '楠', gender: 'male', note: '睿智青年旁白' },
  { id: 'longsanshu_v3', name: '三叔', gender: 'male', note: '低沉沉稳旁白' },
  { id: 'longyichen_v3', name: '逸尘', gender: 'male', note: '洒脱旁白' },
  { id: 'longanhuan', name: '龙安欢', gender: 'female', note: '欢快女声 · 支持情感指令' },
  { id: 'longxiaochun_v3', name: '小淳', gender: 'female', note: '助理音' },
  { id: 'longyuan_v3', name: '媛', gender: 'female', note: '治愈系旁白' },
  { id: 'longyue_v3', name: '悦', gender: 'female', note: '磁性旁白' },
  { id: 'longwan_v3', name: '婉', gender: 'female', note: '细腻柔美' },
  { id: 'longanya_v3', name: '安雅', gender: 'female', note: '优雅高级' },
  { id: 'longanwen_v3', name: '安温', gender: 'female', note: '温婉知性' },
  { id: 'longanli_v3', name: '安莉', gender: 'female', note: '干练女声' },
  { id: 'longanling_v3', name: '安灵', gender: 'female', note: '敏捷思绪' },
  { id: 'longyingmu_v3', name: '应沐', gender: 'female', note: '优雅女声' },
  { id: 'longxing_v3', name: '星', gender: 'female', note: '邻家温柔' },
  { id: 'longmiao_v3', name: '妙', gender: 'female', note: '有声书讲述' },
  { id: 'loongbella_v3', name: 'Bella3.0', gender: 'female', note: '专业清晰' },
];

/** Qwen-TTS 端点（/services/aigc/multimodal-generation/generation）的系统音色 */
export const QWEN_TTS_VOICES: SystemVoice[] = [
  { id: 'Cherry', name: 'Cherry', gender: 'female', note: '官方示例音色（中英）' },
];

/** 按协议取可用系统音色 */
export function systemVoicesFor(protocol?: string): SystemVoice[] {
  return protocol === 'qwen-tts' ? QWEN_TTS_VOICES : COSYVOICE_VOICES;
}

/**
 * 打进应用的参考音频（public/voices/）：一键克隆的样本，
 * 来自本地录音（历史-男.mp3 / 历史-女.mp3）。换掉文件即换音色来源。
 */
export const CLIP_PRESETS = [
  { key: 'male', label: '男声', file: 'voices/male.mp3' },
  { key: 'female', label: '女声', file: 'voices/female.mp3' },
] as const;

export type ClipKey = (typeof CLIP_PRESETS)[number]['key'];

/** 一次克隆的结果：voice_id 只在克隆时用的那个模型下有效 */
export interface ClonedVoice {
  /** 展示名（男声 / 女声 / 文件名） */
  label: string;
  voiceId: string;
  model: string;
  createdAt: number;
}

const KEY = 'mapvideo.clonedVoices';

export function listClonedVoices(): ClonedVoice[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeCloned(list: ClonedVoice[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* 容量不足等 */ }
}

/** 记住一次克隆结果（同 voiceId 覆盖，不堆重复条目） */
export function rememberClonedVoice(v: ClonedVoice): ClonedVoice[] {
  const rest = listClonedVoices().filter((x) => x.voiceId !== v.voiceId);
  const next = [v, ...rest];
  writeCloned(next);
  return next;
}

export function forgetClonedVoice(voiceId: string): ClonedVoice[] {
  const next = listClonedVoices().filter((x) => x.voiceId !== voiceId);
  writeCloned(next);
  return next;
}

/**
 * 同一份样本 + 同一个目标模型已经克隆过就直接复用：
 * 每次重新克隆都会在服务端新建一条音色，既慢也可能触到额度上限。
 */
export function findCloned(label: string, model: string): ClonedVoice | undefined {
  return listClonedVoices().find((x) => x.label === label && x.model === model);
}

/** 取应用内参考音频的字节（相对 BASE_URL 解析） */
export async function fetchClipBytes(file: string): Promise<ArrayBuffer> {
  // 与内置音乐库同一套解析方式（document.baseURI 已含 vite base 前缀）
  const res = await fetch(new URL(file, document.baseURI).href);
  if (!res.ok) throw new Error(`读取参考音频失败 ${file}（HTTP ${res.status}）`);
  return res.arrayBuffer();
}
