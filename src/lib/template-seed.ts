/**
 * template-seed.ts — 内置模板组 seed（首次建库时铺成 provider_template_group / provider_template 的行）
 *
 * 这里是**数据**，不是运行时分支：铺进库之后，接口模板就是普通可编辑行；
 * 「恢复默认」= 用本文件的对应组覆盖回去。加一家新供应商 = 在这里加一条，不改 DDL、不加 switch。
 *
 * 每行的字段都照实际能跑的形状搬：
 *   文案 / 语音 / 图片的同步形状 = 本机 `D:\createVideo\scripts` 里在用的 qwen 脚本（gen_images / gen_tts_qwen / clone_qwen_voice）
 *   带 note「未实测」的 = 照官方文档写，接入时要用「试调用」确认
 */
import type { L } from './i18n';
import type { Mode, ProviderKind, RespSlots, Role, TemplateGroup, TemplateRow, VarSpec } from './request-engine';

const AUTH = { 'Content-Type': 'application/json', Authorization: 'Bearer {apiKey}' };

const v = (name: string, extra: Partial<VarSpec> = {}): VarSpec => ({ name, type: 'string', ...extra });

function row(role: Role, mode: Mode, o: Partial<TemplateRow> & { url: string }): TemplateRow {
  return { role, mode, method: 'POST', headers: AUTH, vars: [], resp: {}, ...o } as TemplateRow;
}

function group(tplGroup: string, kind: ProviderKind, label: L, o: Partial<TemplateGroup> & { rows: TemplateRow[] }): TemplateGroup {
  return { tplGroup, kind, label, ord: 0, ...o };
}

// ========== 文案 ==========

const openaiChatRows: TemplateRow[] = [
  row('generate', 'sync', {
    label: { zh: '文案生成', en: 'Generate' },
    url: '{baseUrl}/chat/completions',
    body: {
      model: '{model}',
      messages: [
        { role: 'system', content: '{systemPrompt}' },
        { role: 'user', content: '{userPrompt}' },
      ],
      temperature: '{temperature}',
      max_tokens: '{maxTokens}',
    },
    vars: [
      v('temperature', { type: 'int', default: 7, label: { zh: '温度（×10）', en: 'Temperature ×10' } }),
      v('maxTokens', { type: 'int', default: '', omitIfEmpty: true, label: { zh: '最大输出 token', en: 'Max tokens' } }),
    ],
    resp: { content: 'choices[0].message.content', errorCode: 'error.code', error: 'error.message' } as RespSlots,
  }),
];

// ========== 语音 ==========

/** CosyVoice 系克隆：voice-enrollment + action=create_voice + prefix → output.voice_id */
const cosyClone = row('clone', 'sync', {
  label: { zh: '音色克隆', en: 'Voice clone' },
  url: '{baseUrl}/services/audio/tts/customization',
  body: {
    model: 'voice-enrollment',
    input: { action: 'create_voice', target_model: '{model}', prefix: '{prefix}', url: 'data:audio/wav;base64,{wavB64}' },
  },
  vars: [v('prefix', { default: 'mv', label: { zh: '音色名前缀', en: 'Voice prefix' } })],
  resp: { voiceId: 'output.voice_id', errorCode: 'code', error: 'message' } as RespSlots,
  refSampleRateHz: 16000,
});

const formatVar = (opts: (string | { value: string; label?: L })[]) =>
  v('format', { default: 'mp3', label: { zh: '音频格式', en: 'Audio format' }, options: opts });

const dashscopeCosyvoice = group('dashscope-cosyvoice', 'tts', { zh: '通义语音（CosyVoice）', en: 'DashScope CosyVoice' }, {
  note: { zh: '走 SpeechSynthesizer；音色是 long* 那一套，也承载 qwen-audio-3.0-tts-flash', en: 'SpeechSynthesizer endpoint; long* voices' },
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  models: ['cosyvoice-v3-flash', 'cosyvoice-v3.5-flash', 'cosyvoice-v3-plus', 'cosyvoice-v3.5-plus', 'cosyvoice-v2', 'qwen-audio-3.0-tts-flash'],
  // 实测：v3.5-flash 不认系统音色 longanyang（418），它承载的是克隆音色；
  // v3-flash + longanyang 是可用组合，所以默认落在 v3-flash
  defaultModel: 'cosyvoice-v3-flash',
  defaultVoice: 'longanyang',
  rows: [
    row('synthesize', 'sync', {
      label: { zh: '语音合成', en: 'Synthesize' },
      url: '{baseUrl}/services/audio/tts/SpeechSynthesizer',
      body: {
        model: '{model}',
        input: { text: '{text}', voice: '{voice}' },
        parameters: { format: '{format}', sample_rate: '{sampleRate}', instruction: '{instruction}' },
      },
      vars: [
        formatVar(['mp3', 'wav', 'pcm']),
        v('sampleRate', {
          type: 'int', default: 24000, label: { zh: '采样率', en: 'Sample rate' },
          options: [16000, 24000, 48000],
        }),
        v('instruction', { default: '', omitIfEmpty: true, label: { zh: '情感指令（部分音色支持）', en: 'Instruction (some voices)' } }),
      ],
      // 实测（2026-09-22）：这个端点回的是 JSON，output.audio.url 是带时效的 OSS 链接 → 当场下载
      resp: { audio: 'output.audio.url', errorCode: 'code', error: 'message' } as RespSlots,
      decode: 'url',
    }),
    cosyClone,
  ],
});

const dashscopeQwenTts = group('dashscope-qwen-tts', 'tts', { zh: '通义语音（Qwen-TTS）', en: 'DashScope Qwen-TTS' }, {
  note: { zh: '走 multimodal-generation；音色是 Cherry / Ethan 那一套，与 long* 不通用', en: 'multimodal-generation; Cherry/Ethan voices' },
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  models: ['qwen3-tts-flash', 'qwen3-tts-vc-2026-01-22', 'qwen-tts'],
  defaultModel: 'qwen3-tts-flash',
  defaultVoice: 'Cherry',
  rows: [
    row('synthesize', 'sync', {
      label: { zh: '语音合成', en: 'Synthesize' },
      url: '{baseUrl}/services/aigc/multimodal-generation/generation',
      body: { model: '{model}', input: { text: '{text}', voice: '{voice}' } },
      vars: [],
      // 这一族的响应给的是远端音频 URL（带时效）→ 当场下载
      resp: { audio: 'output.audio.url', errorCode: 'code', error: 'message' } as RespSlots,
      decode: 'url',
    }),
    row('clone', 'sync', {
      label: { zh: '音色克隆', en: 'Voice clone' },
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
      vars: [v('preferredName', { default: 'mapvideo', label: { zh: '音色名', en: 'Voice name' } })],
      resp: { voiceId: 'output.voice', errorCode: 'code', error: 'message' } as RespSlots,
      refSampleRateHz: 24000,
    }),
  ],
});

const openaiSpeech = group('openai-speech', 'tts', { zh: 'OpenAI /audio/speech', en: 'OpenAI /audio/speech' }, {
  baseUrl: 'https://api.openai.com/v1',
  rows: [row('synthesize', 'sync', {
    label: { zh: '语音合成', en: 'Synthesize' },
    url: '{baseUrl}/audio/speech',
    body: { model: '{model}', voice: '{voice}', input: '{text}', speed: '{speed}', response_format: '{format}' },
    vars: [formatVar(['mp3', 'wav', 'flac', 'pcm'])],
    resp: { audio: '', errorCode: 'error.code', error: 'error.message' } as RespSlots,
  })],
});

const minimaxT2a = group('minimax-t2a', 'tts', 'MiniMax t2a_v2', {
  note: { zh: 'group_id 走 query（实例期参数）；响应里的音频是 hex 字符串', en: 'group_id via query; audio comes back as hex' },
  baseUrl: 'https://api.minimax.chat/v1/t2a_v2',
  rows: [row('synthesize', 'sync', {
    label: { zh: '语音合成', en: 'Synthesize' },
    url: '{baseUrl}',
    query: { group_id: '{groupId}' },
    body: {
      model: '{model}',
      text: '{text}',
      voice_setting: { voice_id: '{voice}', speed: '{speed}', vol: 1, format: '{format}' },
      audio_setting: { format: '{format}' },
    },
    vars: [
      v('groupId', { label: 'group_id', default: '' }),
      formatVar(['mp3', 'wav', 'pcm', 'flac']),
    ],
    resp: { audio: 'data.audio', errorCode: 'status_code', error: 'status_msg' } as RespSlots,
    decode: 'hex',
  })],
});

const volcTts = group('volc-tts', 'tts', { zh: '火山 TTS', en: 'Volcengine TTS' }, {
  note: { zh: '鉴权两个 header：App Key + Access Key（第二凭证填 Access Key）', en: 'Two header slots: app key + access key' },
  baseUrl: 'https://openspeech.bytedance.com/api/v1/tts',
  rows: [row('synthesize', 'sync', {
    label: { zh: '语音合成', en: 'Synthesize' },
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
    vars: [],
    resp: { audio: '', errorCode: 'code', error: 'message' } as RespSlots,
  })],
});

const customTts = group('custom-tts', 'tts', { zh: '自定义语音', en: 'Custom voice' }, {
  rows: [row('synthesize', 'sync', {
    label: { zh: '语音合成', en: 'Synthesize' },
    url: '{baseUrl}',
    body: { model: '{model}', voice: '{voice}', text: '{text}', speed: '{speed}' },
    vars: [],
    resp: { audio: '', errorCode: 'code', error: 'message' } as RespSlots,
  })],
});

// ========== 图片 ==========

const imageVars: VarSpec[] = [
  v('size', {
    default: '2048*1152', allowCustom: true, label: { zh: '出图尺寸', en: 'Size' },
    options: ['1024*1024', '2048*1152', '2688*1536'],
  }),
  v('promptExtend', { type: 'bool', default: false, label: { zh: '提示词改写', en: 'Prompt extend' } }),
  v('watermark', { type: 'bool', default: false, label: { zh: '水印', en: 'Watermark' } }),
];

/**
 * 一组两变体：同步一次到位（形状照本机 gen_images.py 实测在用的那份），
 * 异步 = 提交 + 任务查询（**未实测**，照官方「提交 + tasks/{id} 轮询」文档写，接入时先用试调用确认）。
 */
const dashscopeImage = group('dashscope-image', 'image', { zh: '通义图片生成', en: 'DashScope image' }, {
  note: { zh: '同步 multimodal-generation（z-image-turbo / qwen-image）；异步 image-generation + /tasks/{id} 轮询（只认万相模型，z-image-turbo 走它会给一句误导性的 url error）', en: 'sync multimodal-generation; async image-generation + /tasks/{id} polling (wan models only)' },
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  models: ['z-image-turbo', 'qwen-image', 'wan2.6-t2i'],
  defaultModel: 'z-image-turbo',
  rows: [
    row('generate', 'sync', {
      label: { zh: '文生图（同步）', en: 'Text to image (sync)' },
      url: '{baseUrl}/services/aigc/multimodal-generation/generation',
      body: {
        model: '{model}',
        input: { messages: [{ role: 'user', content: [{ text: '{prompt}' }] }] },
        parameters: { size: '{size}', prompt_extend: '{promptExtend}', watermark: '{watermark}' },
      },
      vars: imageVars,
      resp: { image: 'output.choices[0].message.content[0].image', errorCode: 'code', error: 'message' } as RespSlots,
      decode: 'url',
    }),
    // 实测（2026-09-22）：异步走 image-generation/generation + 异步头，请求体仍是 messages 骨架（与同步同形）
    row('generate', 'async', {
      label: { zh: '文生图（异步提交）', en: 'Text to image (submit)' },
      url: '{baseUrl}/services/aigc/image-generation/generation',
      headers: { ...AUTH, 'X-DashScope-Async': 'enable' },
      body: {
        model: '{model}',
        input: { messages: [{ role: 'user', content: [{ text: '{prompt}' }] }] },
        parameters: { size: '{size}', n: '{count}', watermark: '{watermark}' },
      },
      vars: [...imageVars, v('count', { type: 'int', default: 1, label: { zh: '张数', en: 'Count' } })],
      resp: { taskId: 'output.task_id', errorCode: 'code', error: 'message' } as RespSlots,
    }),
    row('query', 'sync', {
      label: { zh: '任务状态查询', en: 'Task status' },
      method: 'GET',
      // baseUrl 已经带 /api/v1，这里不能再写一遍（实测写过就是 404）
      url: '{baseUrl}/tasks/{taskId}',
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

const customImage = group('custom-image', 'image', { zh: '自定义图片', en: 'Custom image' }, {
  rows: [row('generate', 'sync', {
    label: { zh: '文生图', en: 'Text to image' },
    url: '{baseUrl}',
    body: { model: '{model}', prompt: '{prompt}', size: '{size}' },
    vars: [
      v('size', { default: '1024*1024', allowCustom: true, label: { zh: '出图尺寸', en: 'Size' }, options: ['1024*1024', '2048*1152'] }),
    ],
    resp: { image: 'data[0].url', errorCode: 'code', error: 'message' } as RespSlots,
    decode: 'url',
  })],
});

export const SEED_GROUPS: TemplateGroup[] = [
  group('openai-chat', 'llm', { zh: 'OpenAI 兼容对话', en: 'OpenAI-compatible chat' }, {
    note: { zh: 'DeepSeek / 通义 / Kimi 等一切 /chat/completions 兼容服务', en: 'Any /chat/completions-compatible service' },
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-v4-pro'],
    defaultModel: 'deepseek-chat',
    rows: openaiChatRows,
  }),
  group('custom-llm', 'llm', { zh: '自定义（对话形状）', en: 'Custom (chat shape)' }, { rows: openaiChatRows }),
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
