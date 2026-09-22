/**
 * template-seed.ts — 内置模板组 seed（首次建库时铺成 provider_template_group / provider_template 的行）
 *
 * 这里是**数据**，不是运行时分支：铺进库之后，接口模板就是普通可编辑行；
 * 「恢复默认」= 用本文件的对应组覆盖回去。加一家新供应商 = 在这里加一条，不改 DDL、不加 switch。
 *
 * 每行的字段都照实际能跑的形状搬：
 *   文案 / 语音 / 图片的形状 = 2026-09-22 用 `tools/try-real-calls.mjs` 真实调用确认过的响应
 *
 * 内置 seed 只声明**必需的形状**：`instParams` 只放各家确实要人定的参数（size / format / sampleRate…），
 * 调用期正文（`{text}` / `{prompt}` / `{systemPrompt}` / `{userPrompt}` / `{wavB64}` / `{reqId}`）是保留占位符、
 * **一行都不声明** —— 每张卡片的「实例参数 / 请求参数」初始都是空的，要什么由用户自己加。
 * 名字与说明都是单个字符串（自定义的东西没有自动翻这回事）。
 */
import type { Mode, ProviderKind, RespSlots, Role, TemplateGroup, TemplateRow, VarSpec } from './request-engine';

const AUTH = { 'Content-Type': 'application/json', Authorization: 'Bearer {apiKey}' };

/** 实例参数（会出现在 ⚙ 实例页的参数表里） */
function ip(name: string, extra: Partial<VarSpec> = {}): VarSpec {
  return { name, type: 'string', ...extra };
}

function row(role: Role, mode: Mode, o: Partial<TemplateRow> & { url: string }): TemplateRow {
  return { role, mode, method: 'POST', headers: AUTH, instParams: [], reqParams: [], resp: {}, ...o } as TemplateRow;
}

function group(tplGroup: string, kind: ProviderKind, label: string, o: Partial<TemplateGroup> & { rows: TemplateRow[] }): TemplateGroup {
  return { tplGroup, kind, label, ord: 0, ...o };
}

// ========== 文案 ==========

const openaiChatRows: TemplateRow[] = [
  row('generate', 'sync', {
    url: '{baseUrl}/chat/completions',
    body: {
      model: '{model}',
      messages: [
        { role: 'system', content: '{systemPrompt}' },
        { role: 'user', content: '{userPrompt}' },
      ],
    },
    resp: { content: 'choices[0].message.content', errorCode: 'error.code', error: 'error.message' } as RespSlots,
  }),
];

// ========== 语音 ==========

/** CosyVoice 系克隆：voice-enrollment + action=create_voice + prefix → output.voice_id */
const cosyClone = row('clone', 'sync', {
  url: '{baseUrl}/services/audio/tts/customization',
  body: {
    model: 'voice-enrollment',
    input: { action: 'create_voice', target_model: '{model}', prefix: '{prefix}', url: 'data:audio/wav;base64,{wavB64}' },
  },
  instParams: [ip('prefix', { default: 'mv', label: '音色名前缀' })],
  resp: { voiceId: 'output.voice_id', errorCode: 'code', error: 'message' } as RespSlots,
  refSampleRateHz: 16000,
});

const formatParam = (opts: (string | { value: string; label?: string })[]) =>
  ip('format', { default: 'mp3', label: '音频格式', options: opts });

const dashscopeCosyvoice = group('dashscope-cosyvoice', 'tts', '通义语音（CosyVoice）', {
  note: '走 SpeechSynthesizer；音色是 long* 那一套，也承载 qwen-audio-3.0-tts-flash',
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  models: ['cosyvoice-v3-flash', 'cosyvoice-v3.5-flash', 'cosyvoice-v3-plus', 'cosyvoice-v3.5-plus', 'cosyvoice-v2', 'qwen-audio-3.0-tts-flash'],
  defaultModel: 'cosyvoice-v3-flash',
  defaultVoice: 'longanyang',
  rows: [
    row('synthesize', 'sync', {
      url: '{baseUrl}/services/audio/tts/SpeechSynthesizer',
      body: {
        model: '{model}',
        input: { text: '{text}', voice: '{voice}', format: '{format}', sample_rate: '{sampleRate}' },
      },
      instParams: [
        formatParam(['mp3', 'wav', 'pcm']),
        ip('sampleRate', { type: 'int', default: 24000, label: '采样率', options: [16000, 24000, 48000] }),
      ],
      // 实测（2026-09-22）：这个端点回的是 JSON，output.audio.url 是带时效的 OSS 链接 → 当场下载
      resp: { audio: 'output.audio.url', errorCode: 'code', error: 'message' } as RespSlots,
      decode: 'url',
    }),
    cosyClone,
  ],
});

const dashscopeQwenTts = group('dashscope-qwen-tts', 'tts', '通义语音（Qwen-TTS）', {
  note: '走 multimodal-generation；音色是 Cherry / Ethan 那一套，与 long* 不通用',
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  models: ['qwen3-tts-flash', 'qwen3-tts-vc-2026-01-22', 'qwen-tts'],
  defaultModel: 'qwen3-tts-flash',
  defaultVoice: 'Cherry',
  rows: [
    row('synthesize', 'sync', {
      url: '{baseUrl}/services/aigc/multimodal-generation/generation',
      body: { model: '{model}', input: { text: '{text}', voice: '{voice}' } },
      // 实测：这一族的响应给的是远端音频 URL（带时效）→ 当场下载
      resp: { audio: 'output.audio.url', errorCode: 'code', error: 'message' } as RespSlots,
      decode: 'url',
    }),
    row('clone', 'sync', {
      url: '{baseUrl}/services/audio/tts/customization',
      // 与 CosyVoice 同一端点、不同形状：action=create / preferred_name / audio.data → output.voice
      body: {
        model: 'qwen-voice-enrollment',
        input: {
          action: 'create',
          target_model: '{model}',
          preferred_name: '{preferredName}',
          audio: { data: 'data:audio/wav;base64,{wavB64}' },
        },
      },
      instParams: [ip('preferredName', { default: 'mapvideo', label: '音色名' })],
      resp: { voiceId: 'output.voice', errorCode: 'code', error: 'message' } as RespSlots,
      refSampleRateHz: 24000,
    }),
  ],
});

const openaiSpeech = group('openai-speech', 'tts', 'OpenAI /audio/speech', {
  baseUrl: 'https://api.openai.com/v1',
  rows: [row('synthesize', 'sync', {
    url: '{baseUrl}/audio/speech',
    body: { model: '{model}', voice: '{voice}', input: '{text}', speed: '{speed}', response_format: '{format}' },
    instParams: [formatParam(['mp3', 'wav', 'flac', 'pcm'])],
    // 这一家响应体本身就是音频，所以音频路径留空
    resp: { audio: '', errorCode: 'error.code', error: 'error.message' } as RespSlots,
  })],
});

const minimaxT2a = group('minimax-t2a', 'tts', 'MiniMax t2a_v2', {
  note: 'group_id 走 query（实例参数）；响应里的音频是 hex 字符串',
  baseUrl: 'https://api.minimax.chat/v1/t2a_v2',
  rows: [row('synthesize', 'sync', {
    url: '{baseUrl}',
    query: { group_id: '{groupId}' },
    body: {
      model: '{model}',
      text: '{text}',
      voice_setting: { voice_id: '{voice}', speed: '{speed}', vol: 1, format: '{format}' },
      audio_setting: { format: '{format}' },
    },
    instParams: [ip('groupId', { label: 'group_id', default: '' }), formatParam(['mp3', 'wav', 'pcm', 'flac'])],
    resp: { audio: 'data.audio', errorCode: 'status_code', error: 'status_msg' } as RespSlots,
    decode: 'hex',
  })],
});

const volcTts = group('volc-tts', 'tts', '火山 TTS', {
  note: '鉴权两个 header：App Key + Access Key（第二凭证填 Access Key）',
  baseUrl: 'https://openspeech.bytedance.com/api/v1/tts',
  rows: [row('synthesize', 'sync', {
    url: '{baseUrl}',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-App-Key': '{apiKey}',
      'X-Api-Access-Key': '{apiKey2}',
      'X-Api-Resource-Id': 'volc.service_type.10029',
    },
    body: {
      user: { uid: 'mapvideo' },
      audio: { voice_type: '{voice}', encoding: 'mp3', speed_ratio: '{speed}' },
      request: { reqid: '{reqId}', text: '{text}', operation: 'query' },
    },
    resp: { audio: '', errorCode: 'code', error: 'message' } as RespSlots,
  })],
});

const customTts = group('custom-tts', 'tts', '自定义语音', {
  rows: [row('synthesize', 'sync', {
    url: '{baseUrl}',
    body: { model: '{model}', voice: '{voice}', text: '{text}', speed: '{speed}' },
    resp: { audio: '', errorCode: 'code', error: 'message' } as RespSlots,
  })],
});

// ========== 图片 ==========

const imageInstParams: VarSpec[] = [
  ip('size', { default: '2048*1152', allowCustom: true, label: '出图尺寸', options: ['1024*1024', '2048*1152', '2688*1536'] }),
  ip('promptExtend', { type: 'bool', default: false, label: '提示词改写' }),
  ip('watermark', { type: 'bool', default: false, label: '水印' }),
];

/**
 * 一组两变体：同步一次到位（形状照本机 gen_images.py 在用那份，已实测），
 * 异步 = image-generation 提交 + /tasks/{id} 轮询（实测：只认万相模型，产物在 choices[0]…）。
 */
const dashscopeImage = group('dashscope-image', 'image', '通义图片生成', {
  note: '同步 multimodal-generation（z-image-turbo / qwen-image）；异步 image-generation + /tasks/{id} 轮询，只认万相模型',
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  models: ['z-image-turbo', 'qwen-image', 'wan2.6-t2i'],
  defaultModel: 'z-image-turbo',
  rows: [
    row('generate', 'sync', {
      url: '{baseUrl}/services/aigc/multimodal-generation/generation',
      body: {
        model: '{model}',
        input: { messages: [{ role: 'user', content: [{ text: '{prompt}' }] }] },
        parameters: { size: '{size}', prompt_extend: '{promptExtend}', watermark: '{watermark}' },
      },
      instParams: imageInstParams,
      resp: { image: 'output.choices[0].message.content[0].image', errorCode: 'code', error: 'message' } as RespSlots,
      decode: 'url',
    }),
    row('generate', 'async', {
      url: '{baseUrl}/services/aigc/image-generation/generation',
      headers: { ...AUTH, 'X-DashScope-Async': 'enable' },
      body: {
        model: '{model}',
        input: { messages: [{ role: 'user', content: [{ text: '{prompt}' }] }] },
        parameters: { size: '{size}', n: '{count}', watermark: '{watermark}' },
      },
      instParams: [...imageInstParams, ip('count', { type: 'int', default: 1, label: '张数' })],
      resp: { taskId: 'output.task_id', errorCode: 'code', error: 'message' } as RespSlots,
    }),
    row('query', 'sync', {
      // baseUrl 已经带 /api/v1，这里不能再写一遍（实测写过就是 404）
      url: '{baseUrl}/tasks/{taskId}',
      method: 'GET',
      headers: { Authorization: 'Bearer {apiKey}' },
      resp: {
        // 实测：产物在 output.choices[0].message.content[0].image（带时效的签名链接）
        image: 'output.choices[0].message.content[0].image',
        status: 'output.task_status',
        success: ['SUCCEEDED'],
        pending: ['PENDING', 'RUNNING'],
        fail: ['FAILED', 'CANCELED', 'UNKNOWN'],
        errorCode: 'code',
        error: 'message',
      } as RespSlots,
      decode: 'url',
      pollIntervalMs: 1500,
      pollTimeoutMs: 180000,
    }),
  ],
});

const customImage = group('custom-image', 'image', '自定义图片', {
  rows: [row('generate', 'sync', {
    url: '{baseUrl}',
    body: { model: '{model}', prompt: '{prompt}', size: '{size}' },
    instParams: [ip('size', { default: '1024*1024', allowCustom: true, label: '出图尺寸', options: ['1024*1024', '2048*1152'] })],
    resp: { image: 'data[0].url', errorCode: 'code', error: 'message' } as RespSlots,
    decode: 'url',
  })],
});

export const SEED_GROUPS: TemplateGroup[] = [
  group('openai-chat', 'llm', 'OpenAI 兼容对话', {
    note: 'DeepSeek / 通义 / Kimi 等一切 /chat/completions 兼容服务',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-v4-pro'],
    defaultModel: 'deepseek-chat',
    rows: openaiChatRows,
  }),
  group('custom-llm', 'llm', '自定义（对话形状）', { rows: openaiChatRows }),
  dashscopeCosyvoice, dashscopeQwenTts, openaiSpeech, minimaxT2a, volcTts, customTts,
  dashscopeImage, customImage,
];

export function seedGroup(tplGroup: string): TemplateGroup | undefined {
  return SEED_GROUPS.find((g) => g.tplGroup === tplGroup);
}

export function seedGroupsFor(kind: ProviderKind): TemplateGroup[] {
  return SEED_GROUPS.filter((g) => g.kind === kind);
}

/** 深拷贝一份，避免界面编辑改到 seed 常量本身 */
export function cloneRow(r: TemplateRow): TemplateRow {
  return JSON.parse(JSON.stringify(r)) as TemplateRow;
}

/**
 * 新建一条接口行的种子：同类任一 seed 组里有这个 role+mode 的现成形状就照它来，
 * 否则给一个最小骨架（异步查询行连状态槽一起给，省得从零手打）。
 */
export function seedRow(kind: ProviderKind, role: Role, mode: Mode = 'sync'): TemplateRow {
  for (const g of SEED_GROUPS) {
    if (g.kind !== kind) continue;
    const hit = g.rows.find((r) => r.role === role && r.mode === mode) ?? g.rows.find((r) => r.role === role);
    if (hit) return cloneRow(hit);
  }
  return row(role, mode, {
    url: '{baseUrl}/',
    body: { model: '{model}' },
    resp: (role === 'query'
      ? { status: '', success: [], pending: [], fail: [] }
      : role === 'clone' ? { voiceId: '' } : mode === 'async' ? { taskId: '' } : {}) as RespSlots,
  });
}

/** 这组模板要不要第二凭证（有行引用 {apiKey2} 就要 —— 不再写死厂商名单） */
export function needsSecret2(g: TemplateGroup | undefined): boolean {
  if (!g) return false;
  return JSON.stringify(g.rows).includes('{apiKey2}');
}
