import type { ProviderConfig, ProviderPreset } from '../types';
import { IS_DESKTOP } from './backend';

// ========== 内置厂商预设（均可复制修改，用户可在设置里自建/扩展） ==========

export const LLM_PRESETS: ProviderPreset[] = [
  { id: 'gpt', label: 'OpenAI GPT', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyHint: 'platform.openai.com/api-keys' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyHint: 'platform.deepseek.com' },
  { id: 'glm', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', keyHint: 'open.bigmodel.cn' },
  { id: 'kimi', label: 'Kimi (月之暗面)', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', keyHint: 'platform.moonshot.cn' },
  { id: 'qwen', label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', keyHint: 'bailian.console.aliyun.com' },
  { id: 'mimo', label: '小米 MiMo', baseUrl: 'https://api.mimo.xiaomi.com/v1', model: 'mimo-vl', keyHint: '以官方文档为准，可改地址' },
  { id: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1/text/chatcompletion_v2', model: 'abab6.5s-chat', keyHint: 'platform.minimaxi.com', note: 'URL 已含完整路径，不再自动拼接 /chat/completions' },
  { id: 'seedance', label: '火山豆包 (Seed)', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-1-6-250615', keyHint: 'console.volcengine.com/ark', note: 'OpenAI 兼容接口' },
  { id: 'custom-llm', label: '自定义 (OpenAI 兼容)', baseUrl: '', model: '', note: '任何 OpenAI /chat/completions 兼容服务' },
];

export const TTS_PRESETS: ProviderPreset[] = [
  { id: 'qwen-tts', label: '通义 CosyVoice', baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', model: 'cosyvoice-v2', voice: 'longxiaochun', protocol: 'qwen-tts', keyHint: 'bailian.console.aliyun.com' },
  { id: 'mimo-tts', label: '小米 MiMo Audio', baseUrl: '', model: '', voice: '', protocol: 'custom', keyHint: '以官方文档为准，可改地址' },
  { id: 'minimax-tts', label: 'MiniMax 语音', baseUrl: 'https://api.minimax.chat/v1/t2a_v2', model: 'speech-02-turbo', voice: 'male-qn-qingse', protocol: 'minimax-t2a', keyHint: 'platform.minimaxi.com' },
  { id: 'seedance-tts', label: '火山豆包语音', baseUrl: 'https://openspeech.bytedance.com/api/v1/tts', model: 'seed-tts', voice: 'zh_female_cancan', protocol: 'volc-tts', keyHint: '控制台需 AppID + Access Token' },
  { id: 'openai-tts', label: 'OpenAI 语音', baseUrl: 'https://api.openai.com/v1', model: 'tts-1', voice: 'alloy', protocol: 'openai-speech', keyHint: 'platform.openai.com' },
  { id: 'sovits', label: 'GPT-SoVITS (本地)', baseUrl: 'http://127.0.0.1:9880', model: '', voice: '', protocol: 'custom', note: '本地推理服务，POST JSON 返回音频' },
  { id: 'custom-tts', label: '自定义', baseUrl: '', model: '', voice: '', protocol: 'custom', note: 'POST JSON（含 extra 合并），响应为音频或 JSON 内 base64' },
];

function findById(list: ProviderPreset[], id: string): ProviderPreset {
  return list.find((p) => p.id === id) || list[list.length - 1];
}

/** 从预设创建一份用户配置（key 留空待填） */
export function configFromPreset(presetId: string, kind: 'llm' | 'tts'): ProviderConfig {
  const p = findById(kind === 'llm' ? LLM_PRESETS : TTS_PRESETS, presetId);
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
      case 'qwen-tts':
        headers.Authorization = `Bearer ${cfg.apiKey}`;
        body = {
          model: cfg.model,
          input: { text, voice: cfg.voice },
          parameters: { rate: speed },
          ...extra,
        };
        res = await fetch(cfg.baseUrl.replace(/\/+$/, ''), { method: 'POST', headers, body: JSON.stringify(body) });
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
