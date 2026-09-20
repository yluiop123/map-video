import type { ProviderConfig, ProviderPreset } from '../types';
import { IS_DESKTOP } from './backend';

// ========== 内置厂商预设（均可复制修改，用户可在设置里自建/扩展） ==========

export const LLM_PRESETS: ProviderPreset[] = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', models: ['deepseek-flash', 'deepseek-v4-pro'], keyHint: 'platform.deepseek.com（API 文档：api-docs.deepseek.com）', note: '只需填 API Key；deepseek-flash = DeepSeek-V4.1-Flash，deepseek-v4-pro = 更强版' },
  { id: 'custom-llm', label: '自定义供应商', baseUrl: '', model: '', note: '自己输入名称、Base URL、API Key（OpenAI /chat/completions 兼容）' },
];

export const TTS_PRESETS: ProviderPreset[] = [
  // 模型名与音色必须配对：CosyVoice 走 /services/audio/tts/SpeechSynthesizer（音色 long* 系列），
  // Qwen-TTS 走 /services/aigc/multimodal-generation/generation（音色 Cherry 系列）。
  // 名字不能互串——把 qwen3-tts* 发给 CosyVoice 端点，上游就是 HTTP 400 "Model not exist."
  { id: 'cosyvoice', label: '通义语音 (CosyVoice)', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'cosyvoice-v3-flash', models: ['cosyvoice-v3-flash', 'cosyvoice-v3.5-flash', 'cosyvoice-v3-plus', 'cosyvoice-v3.5-plus', 'cosyvoice-v2'], voice: 'longanyang', protocol: 'cosyvoice', keyHint: 'bailian.console.aliyun.com（DashScope Key）', note: '只需填 DashScope API Key；音色填官方列表里的 long* 名，或用下方声音克隆得到的 voice_id' },
  { id: 'qwen-tts', label: '通义语音 (Qwen-TTS)', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen3-tts-flash', models: ['qwen3-tts-flash', 'qwen-tts'], voice: 'Cherry', protocol: 'qwen-tts', keyHint: 'bailian.console.aliyun.com（DashScope Key）', note: 'Qwen-TTS 合成：音色用 Cherry / Serena 等系统音色名（不是 long* 那套）' },
  { id: 'custom-tts', label: '自定义语音', baseUrl: '', model: '', voice: '', protocol: 'custom', note: 'POST JSON（含 extra 合并），响应为音频或 JSON 内 base64 / url' },
];

/** 图片生成预设（文生图） */
export const IMAGE_PRESETS: ProviderPreset[] = [
  { id: 'qwen-image', label: '通义图片 (Qwen)', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen-image', models: ['qwen-image', 'z-image-turbo'], keyHint: 'bailian.console.aliyun.com（DashScope Key）', note: '只需填 DashScope API Key；模型 qwen-image / z-image-turbo，默认尺寸 2048*1152' },
  { id: 'custom-image', label: '自定义图片', baseUrl: '', model: '', note: '任何兼容的文生图接口' },
];

function findById(list: ProviderPreset[], id: string): ProviderPreset {
  return list.find((p) => p.id === id) || list[list.length - 1];
}

/** 从预设创建一份用户配置（key 留空待填） */
export function configFromPreset(presetId: string, kind: 'llm' | 'tts' | 'image'): ProviderConfig {
  const list = kind === 'llm' ? LLM_PRESETS : kind === 'tts' ? TTS_PRESETS : IMAGE_PRESETS;
  const p = findById(list, presetId);
  return {
    id: `${presetId}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    label: p.label,
    baseUrl: p.baseUrl,
    apiKey: '',
    model: p.model,
    protocol: p.protocol,
    voice: p.voice,
    speed: 1,
  };
}

// ========== LLM（OpenAI 兼容 /chat/completions） ==========

/** baseUrl 已含完整路径（如 minimax chatcompletion_v2）则不再拼接 */
function chatUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, '');
  return /chatcompletion|chat\/completions/i.test(b) ? b : `${b}/chat/completions`;
}

export async function callLLM(cfg: ProviderConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  let extra: Record<string, unknown> = {};
  if (cfg.extra) {
    try { extra = JSON.parse(cfg.extra); } catch { /* 忽略非法 JSON */ }
  }
  // 桌面端：主进程管道（无 CORS，Key 在本地库）
  if (IS_DESKTOP) {
    const res = await window.mapvideo!.aiChat(cfg, systemPrompt, userPrompt);
    if (res.error) throw new Error(res.error);
    if (typeof res.content !== 'string') throw new Error('桌面端响应格式异常');
    return res.content;
  }
  if (!cfg.baseUrl) throw new Error('未配置服务地址 (baseUrl)');
  let res: Response;
  try {
    res = await fetch(chatUrl(cfg.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        ...extra,
      }),
    });
  } catch {
    throw new Error('请求失败（可能被 CORS 拦截）——可运行本地后端 (npm run server) 或配置反向代理地址');
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${txt ? `: ${txt.slice(0, 200)}` : ''}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('响应格式异常：无 choices[0].message.content');
  return content;
}

// ========== TTS（多协议） ==========

export interface TtsResult {
  /** dataURL（blob 转存） */
  dataUrl: string;
  durationSec: number;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error('读取音频失败'));
    r.readAsDataURL(blob);
  });
}

/** 解码音频取时长（失败按字数估算兜底） */
export async function decodeAudioDuration(dataUrl: string, fallbackText = ''): Promise<number> {
  try {
    const AC: typeof AudioContext = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    const buf = await ctx.decodeAudioData(await (await fetch(dataUrl)).arrayBuffer());
    void ctx.close();
    return buf.duration;
  } catch {
    return Math.max(0.8, fallbackText.length * 0.28 + 0.3);
  }
}

export async function callTTS(cfg: ProviderConfig, text: string): Promise<TtsResult> {
  // 桌面端：主进程管道（返回音频字节）
  if (IS_DESKTOP) {
    const res = await window.mapvideo!.aiTts(cfg, text);
    if (res.error) throw new Error(res.error);
    if (!res.bytes) throw new Error('桌面端未返回音频');
    const blob = new Blob([res.bytes], { type: res.mime || 'audio/mpeg' });
    const dataUrl = await blobToDataUrl(blob);
    const durationSec = await decodeAudioDuration(dataUrl, text);
    return { dataUrl, durationSec };
  }
  if (!cfg.baseUrl) throw new Error('未配置服务地址 (baseUrl)');
  let extra: Record<string, unknown> = {};
  if (cfg.extra) {
    try { extra = JSON.parse(cfg.extra); } catch { /* 忽略非法 JSON */ }
  }
  const speed = cfg.speed ?? 1;
  let res: Response;
  try {
    let body: Record<string, unknown>;
    let headers: Record<string, string> = { 'Content-Type': 'application/json' };
    switch (cfg.protocol) {
      case 'minimax-t2a':
        body = {
          model: cfg.model,
          text,
          voice_setting: { voice_id: cfg.voice, speed, vol: 1, format: 'mp3' },
          audio_setting: { format: 'mp3' },
          ...extra,
        };
        if (cfg.apiKey.includes('&&')) {
          // minimax: group_id 需拼接在 URL query
          const [key, group] = cfg.apiKey.split('&&');
          headers.Authorization = `Bearer ${key}`;
          res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}?group_id=${group}`, { method: 'POST', headers, body: JSON.stringify(body) });
        } else {
          headers.Authorization = `Bearer ${cfg.apiKey}`;
          res = await fetch(cfg.baseUrl.replace(/\/+$/, ''), { method: 'POST', headers, body: JSON.stringify(body) });
        }
        break;
      case 'volc-tts':
        // 火山语音: apiKey 填 `appid|token`
        {
          const [appid, token] = cfg.apiKey.split('|');
          headers['X-Api-App-Key'] = appid || '';
          headers['X-Api-Access-Key'] = token || '';
          headers['X-Api-Resource-Id'] = 'volc.service_type.10029';
          body = {
            user: { uid: 'mapvideo' },
            audio: { voice_type: cfg.voice, encoding: 'mp3', speed_ratio: speed },
            request: { reqid: `mv-${Date.now()}`, text, operation: 'query' },
            ...extra,
          };
          res = await fetch(cfg.baseUrl.replace(/\/+$/, ''), { method: 'POST', headers, body: JSON.stringify(body) });
        }
        break;
      case 'cosyvoice':
        // 通义 CosyVoice（参照 createVideo/scripts）：POST /services/audio/tts/SpeechSynthesizer
        headers.Authorization = `Bearer ${cfg.apiKey}`;
        body = {
          model: cfg.model || 'cosyvoice-v3-flash',
          input: { text, voice: cfg.voice },
          parameters: { format: 'mp3', sample_rate: 24000, ...extra },
        };
        res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/services/audio/tts/SpeechSynthesizer`, { method: 'POST', headers, body: JSON.stringify(body) });
        break;
      case 'qwen-tts':
        // Qwen-TTS 非实时合成：POST /services/aigc/multimodal-generation/generation
        // 响应里给 output.audio.url（下面统一的 JSON 解析分支已覆盖该字段）
        headers.Authorization = `Bearer ${cfg.apiKey}`;
        body = {
          model: cfg.model || 'qwen3-tts-flash',
          input: { text, voice: cfg.voice || 'Cherry', ...extra },
        };
        res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/services/aigc/multimodal-generation/generation`, { method: 'POST', headers, body: JSON.stringify(body) });
        break;
      case 'openai-speech':
        headers.Authorization = `Bearer ${cfg.apiKey}`;
        body = { model: cfg.model, voice: cfg.voice, input: text, speed, response_format: 'mp3', ...extra };
        res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/audio/speech`, { method: 'POST', headers, body: JSON.stringify(body) });
        break;
      default:
        // custom: POST JSON {text, voice, speed} → 期望音频响应；JSON 内 base64(audio/data) 亦可
        headers.Authorization = cfg.apiKey ? `Bearer ${cfg.apiKey}` : '';
        body = { text, voice: cfg.voice, speed, model: cfg.model, ...extra };
        res = await fetch(cfg.baseUrl.replace(/\/+$/, ''), { method: 'POST', headers, body: JSON.stringify(body) });
        break;
    }
  } catch {
    throw new Error('请求失败（可能被 CORS 拦截）——可配置反向代理地址');
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${txt ? `: ${txt.slice(0, 200)}` : ''}`);
  }

  const ctype = res.headers.get('content-type') || '';
  let blob: Blob | null = null;
  if (ctype.startsWith('audio/')) {
    blob = await res.blob();
  } else {
    const data = await res.json().catch(() => null);
    if (!data) throw new Error('响应不是音频也不是 JSON');
    // 常见字段名兼容
    const b64 = data?.data?.audio || data?.audio?.data || data?.data || data?.audio || data?.output?.audio?.data;
    const audioUrlField = data?.output?.audio?.url || data?.audio_url || data?.url;
    if (typeof b64 === 'string' && b64.length > 100 && !/^https?:/i.test(b64)) {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      blob = new Blob([bytes], { type: ctype.includes('wav') ? 'audio/wav' : 'audio/mpeg' });
    } else if (typeof audioUrlField === 'string') {
      const r2 = await fetch(audioUrlField);
      blob = await r2.blob();
    } else if (typeof data === 'object' && (data as { hex?: string }).hex) {
      // minimax 返回 hex 音频
      const hex = (data as { hex?: string }).hex as string;
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
      blob = new Blob([bytes], { type: 'audio/mpeg' });
    }
  }
  if (!blob) throw new Error('无法从响应中提取音频（检查协议/extra 参数）');
  const dataUrl = await blobToDataUrl(blob);
  const durationSec = await decodeAudioDuration(dataUrl, text);
  return { dataUrl, durationSec };
}

/**
 * 文生图（通义万相 / 兼容接口）：返回图片 URL 或 dataURL。
 * 参照 createVideo/scripts：POST /services/aigc/multimodal-generation/generation，
 * 取 output.choices[0].message.content[0].image。
 */
/** 统一图片返回：http(s)/dataURL 原样；纯 base64 补 dataURL 前缀，否则 <img> 无法显示 */
function normalizeImage(s: string): string {
  const v = (s || '').trim();
  if (!v) return v;
  if (/^https?:\/\//i.test(v) || v.startsWith('data:')) return v;
  return `data:image/png;base64,${v}`;
}

export async function callImage(cfg: ProviderConfig, prompt: string): Promise<string> {
  if (IS_DESKTOP) {
    const res = await window.mapvideo!.aiImage(cfg, prompt);
    if (res.error) throw new Error(res.error);
    if (!res.image) throw new Error('桌面端未返回图片');
    return normalizeImage(res.image);
  }
  if (!cfg.baseUrl) throw new Error('未配置服务地址 (baseUrl)');
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/services/aigc/multimodal-generation/generation`;
  const body = {
    model: cfg.model || 'z-image-turbo',
    input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
    parameters: { prompt_extend: false, size: '2048*1152' },
  };
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('请求失败（可能被 CORS 拦截）——建议用桌面版');
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${txt ? `: ${txt.slice(0, 200)}` : ''}`);
  }
  const data = await res.json().catch(() => null);
  const img = data?.output?.choices?.[0]?.message?.content?.[0]?.image;
  if (typeof img !== 'string') throw new Error('响应中无 image 字段');
  return normalizeImage(img);
}

/** 任意音频 → WAV 16k 单声道 s16（CosyVoice 参考音频要求，参照 clone_qwen_voice.py 的 ffmpeg 步骤） */
async function toWav16kMono(bytes: ArrayBuffer): Promise<Uint8Array> {
  const AC: typeof AudioContext = window.AudioContext
    || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  const decoded = await ctx.decodeAudioData(bytes.slice(0));
  void ctx.close();
  const target = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const src = target.createBufferSource();
  src.buffer = decoded;
  src.connect(target.destination);
  src.start();
  const rendered = await target.startRendering();
  const ch = rendered.getChannelData(0);
  const len = ch.length;
  const buf = new ArrayBuffer(44 + len * 2);
  const dv = new DataView(buf);
  const ws = (off: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + len * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 16000, true); dv.setUint32(28, 16000 * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, len * 2, true);
  let off = 44;
  for (let i = 0; i < len; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, ch[i]));
    dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** CosyVoice 声音克隆：参考音频字节（3~60s）→ voice_id（绑定 targetModel）。参照 clone_qwen_voice.py。 */
export async function cloneVoice(cfg: ProviderConfig, refBytes: ArrayBuffer, targetModel: string, prefix = 'mv'): Promise<string> {
  const wav = await toWav16kMono(refBytes);
  if (wav.length > 10 * 1024 * 1024) throw new Error('参考音频超过 10MB');
  const body = {
    model: 'voice-enrollment',
    input: {
      action: 'create_voice',
      target_model: targetModel || cfg.model || 'cosyvoice-v3.5-flash',
      prefix: String(prefix || 'mv').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'mv',
      url: `data:audio/wav;base64,${bytesToBase64(wav)}`,
    },
  };
  if (IS_DESKTOP) {
    const res = await window.mapvideo!.aiVoiceClone(cfg, body);
    if (res.error) throw new Error(res.error);
    if (!res.voiceId) throw new Error('未返回 voice_id');
    return res.voiceId;
  }
  if (!cfg.baseUrl) throw new Error('未配置服务地址 (baseUrl)');
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/services/audio/tts/customization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('请求失败（可能被 CORS 拦截）——建议用桌面版');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json().catch(() => null);
  const voice = data?.output?.voice_id || data?.output?.voice;
  if (typeof voice !== 'string') throw new Error('响应中无 voice_id');
  return voice;
}

/** 解析 dataURL 音频为 Blob（导入时用） */
export async function readAudioFile(file: File): Promise<{ dataUrl: string; durationSec: number }> {
  const dataUrl = await blobToDataUrl(file);
  const durationSec = await decodeAudioDuration(dataUrl);
  return { dataUrl, durationSec };
}

// ========== SRT ==========

export function srtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msPart = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(msPart).padStart(3, '0')}`;
}

export function parseSrt(content: string): string[] {
  // 兼容编号行/时间行，只取文本行（按空行分段）
  return content
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((blk) => {
      const lines = blk.split('\n').filter((l) => l.trim());
      // 去掉序号行与时间轴行
      return lines
        .filter((l) => !/^\d+$/.test(l.trim()) && !/-->\s|\d{2}:\d{2}:\d{2}/.test(l))
        .join(' ')
        .trim();
    })
    .filter((x) => x);
}
