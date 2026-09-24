/**
 * voices.ts — 配音音色目录（系统音色）与内置参考音频清单
 *
 * ★ 系统音色名一律取自上游官方音色表（按模板 id 取，见 systemVoicesFor；
 *   两套端点的名字互串上游就回 HTTP 400 "Model not exist."），不要在界面上现编。
 * **克隆音色的账本不在这里** —— 那是 `voice` 表的事（stores/voiceStore.ts）：
 * voiceId 绑「实例 + 目标模型」，还要记住参考音频原件，localStorage 担不住。
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
  /** Qwen 侧：旧模型 `qwen-tts` 也带这个音色（其余只有 qwen3-tts* 认） */
  legacy?: boolean;
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

/**
 * Qwen-TTS 端点（/services/aigc/multimodal-generation/generation）的系统音色。
 * id / 中文名 / 性别逐条取自官方音色列表，不要手改；这一套与 CosyVoice 的 long* 完全不通用。
 * 全部为「中文普通话 + 英/法/德/俄/意/西/葡/日/韩」。
 * 官方另有 10 个方言音色（上海-阿珍 Jada、北京-晓东 Dylan、南京-老李 Li、陕西-秦川 Marcus、
 * 闽南-阿杰 Roy、天津-李彼得 Peter、四川-晴儿 Sunny、四川-程川 Eric、粤语-阿强 Rocky、粤语-阿清 Kiki）
 * 需要时用下方「手填音色 ID」直接填。
 */
export const QWEN_TTS_VOICES: SystemVoice[] = [
  { id: 'Cherry', name: '芊悦', gender: 'female', note: '中英多语', legacy: true },
  { id: 'Serena', name: '苏瑶', gender: 'female', note: '中英多语', legacy: true },
  { id: 'Chelsie', name: '千雪', gender: 'female', note: '中英多语', legacy: true },
  { id: 'Ethan', name: '晨煦', gender: 'male', note: '中英多语', legacy: true },
  { id: 'Moon', name: '月白', gender: 'male', note: '中英多语' },
  { id: 'Kai', name: '凯', gender: 'male', note: '中英多语' },
  { id: 'Nofish', name: '不吃鱼', gender: 'male', note: '中英多语' },
  { id: 'Ryan', name: '甜茶', gender: 'male', note: '中英多语' },
  { id: 'Aiden', name: '艾登', gender: 'male', note: '中英多语' },
  { id: 'Eldric Sage', name: '沧明子', gender: 'male', note: '中英多语' },
  { id: 'Mochi', name: '沙小弥', gender: 'male', note: '中英多语' },
  { id: 'Vincent', name: '田叔', gender: 'male', note: '中英多语' },
  { id: 'Neil', name: '阿闻', gender: 'male', note: '中英多语' },
  { id: 'Arthur', name: '徐大爷', gender: 'male', note: '中英多语' },
  { id: 'Pip', name: '顽屁小孩', gender: 'male', note: '中英多语' },
  { id: 'Bodega', name: '博德加', gender: 'male', note: '中英多语' },
  { id: 'Alek', name: '阿列克', gender: 'male', note: '中英多语' },
  { id: 'Dolce', name: '多尔切', gender: 'male', note: '中英多语' },
  { id: 'Lenn', name: '莱恩', gender: 'male', note: '中英多语' },
  { id: 'Emilien', name: '埃米尔安', gender: 'male', note: '中英多语' },
  { id: 'Andre', name: '安德雷', gender: 'male', note: '中英多语' },
  { id: 'Radio Gol', name: '拉迪奥·戈尔', gender: 'male', note: '中英多语' },
  { id: 'Momo', name: '茉兔', gender: 'female', note: '中英多语' },
  { id: 'Vivian', name: '十三', gender: 'female', note: '中英多语' },
  { id: 'Maia', name: '四月', gender: 'female', note: '中英多语' },
  { id: 'Bella', name: '萌宝', gender: 'female', note: '中英多语' },
  { id: 'Jennifer', name: '詹妮弗', gender: 'female', note: '中英多语' },
  { id: 'Katerina', name: '卡捷琳娜', gender: 'female', note: '中英多语' },
  { id: 'Mia', name: '乖小妹', gender: 'female', note: '中英多语' },
  { id: 'Bellona', name: '燕铮莺', gender: 'female', note: '中英多语' },
  { id: 'Bunny', name: '萌小姬', gender: 'female', note: '中英多语' },
  { id: 'Elias', name: '墨讲师', gender: 'female', note: '中英多语' },
  { id: 'Nini', name: '邻家妹妹', gender: 'female', note: '中英多语' },
  { id: 'Seren', name: '小婉', gender: 'female', note: '中英多语' },
  { id: 'Stella', name: '少女阿月', gender: 'female', note: '中英多语' },
  { id: 'Sonrisa', name: '索尼莎', gender: 'female', note: '中英多语' },
  { id: 'Sohee', name: '素熙', gender: 'female', note: '中英多语' },
  { id: 'Ono Anna', name: '小野杏', gender: 'female', note: '中英多语' },
];

/**
/**
 * 这个模板自带的系统音色表。名字一律逐字抄官方表 —— 认的是**模板 id**
 * （自定义模板没有官方表可抄，返回空，界面退化成手填音色 ID）。
 */
export function systemVoicesFor(tplId?: string, model?: string): SystemVoice[] {
  switch (tplId) {
    // 认的是 seed 里的模板 id（`dashscope-qwen-tts` 那个旧 id 随「一行一份模板」改版没了）
    case 'qwen-tts':
      return (model || '').trim() === 'qwen-tts' ? QWEN_TTS_VOICES.filter((v) => v.legacy) : QWEN_TTS_VOICES;
    case 'cosyvoice':
      return COSYVOICE_VOICES;
    default:
      // 手工建的模板没有官方表可抄（名字必须逐字对上游，猜不得）→ 界面退化成手填音色 ID
      return [];
  }
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


/** 取应用内参考音频的字节（相对 BASE_URL 解析） */
export async function fetchClipBytes(file: string): Promise<ArrayBuffer> {
  // 与内置音乐库同一套解析方式（document.baseURI 已含 vite base 前缀）
  const res = await fetch(new URL(file, document.baseURI).href);
  if (!res.ok) throw new Error(`读取参考音频失败 ${file}（HTTP ${res.status}）`);
  return res.arrayBuffer();
}
