/**
 * recipes.ts — 内置模板包（一份数据描述「一家供应商配齐哪几个接口、各自怎么发」）
 *
 * 每个模板的字段都照现有实现搬（`providers.ts` 的 renderer 分支 + `electron/main.mjs` 的主进程分支），
 * 目的是让第 2 批切引擎时行为不变。**带「未实测」标记的是照官方文档写的**，接进来要用「试调用」确认。
 *
 * 加一家新供应商 = 在这里加一条 recipe；不用动 DDL、不用动 switch（原先那四处真相就是这么长出来的）。
 */
import type { L } from './i18n';
import type { EndpointTemplate, Role } from './request-engine';

export type ProviderKind = 'llm' | 'tts' | 'image';

export interface Recipe {
  id: string;
  kind: ProviderKind;
  label: L;
  note?: L;
  baseUrl?: string;
  models?: string[];
  defaultModel?: string;
  defaultVoice?: string;
  /** 克隆参考音频的要求（各家采样率不同：CosyVoice 转 16k、Qwen-TTS 要 ≥24k） */
  clone?: { refSampleRateHz: number };
  roles: EndpointTemplate[];
}

const AUTH = { 'Content-Type': 'application/json', Authorization: 'Bearer {secrets.apiKey}' };

/** 每个 kind 至少要有一个这些 role，否则供应商不可用 */
export const REQUIRED_ROLES: Record<ProviderKind, Role[]> = {
  llm: ['llm.generate'],
  tts: ['tts.synthesize'],
  image: ['image.generate'],
};

// ========== 文案 ==========

const openaiChat: Recipe = {
  id: 'openai-chat',
  kind: 'llm',
  label: { zh: 'OpenAI 兼容对话', en: 'OpenAI-compatible chat' },
  note: { zh: 'DeepSeek / 通义 / Kimi 等一切 /chat/completions 兼容服务', en: 'Any /chat/completions-compatible service' },
  baseUrl: 'https://api.deepseek.com',
  models: ['deepseek-chat', 'deepseek-v4-pro'],
  defaultModel: 'deepseek-chat',
  roles: [{
    role: 'llm.generate',
    mode: 'sync',
    method: 'POST',
    path: '{baseUrl}/chat/completions',
    headers: AUTH,
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
      { name: 'systemPrompt', kind: 'inject', type: 'string' },
      { name: 'userPrompt', kind: 'inject', type: 'string' },
      { name: 'temperature', kind: 'param', type: 'number', default: 0.7, label: { zh: '温度', en: 'Temperature' } },
      {
        name: 'maxTokens', kind: 'param', type: 'number', default: '', omitIfEmpty: true,
        label: { zh: '最大输出 token', en: 'Max tokens' },
      },
    ],
    resp: { kind: 'json', pick: { text: 'choices.0.message.content', errorCode: 'error.code', error: 'error.message' } },
  }],
};

const customLlm: Recipe = {
  id: 'custom-llm',
  kind: 'llm',
  label: { zh: '自定义（对话形状）', en: 'Custom (chat shape)' },
  roles: openaiChat.roles,
};

// ========== 语音 ==========

/** 参考音频：克隆时要转成什么采样率由 recipe.clone 决定，请求里只有一个 base64 槽 */
const cosyClone: EndpointTemplate = {
  role: 'tts.clone',
  mode: 'sync',
  method: 'POST',
  label: { zh: '声音克隆', en: 'Voice clone' },
  path: '{baseUrl}/services/audio/tts/customization',
  headers: AUTH,
  body: {
    model: 'voice-enrollment',
    input: {
      action: 'create_voice',
      target_model: '{model}',
      prefix: '{prefix}',
      url: 'data:audio/wav;base64,{wavB64}',
    },
  },
  vars: [
    { name: 'wavB64', kind: 'inject', type: 'string' },
    { name: 'prefix', kind: 'param', type: 'string', default: 'mv', label: { zh: '音色名前缀', en: 'Voice name prefix' } },
  ],
  resp: { kind: 'json', pick: { voiceId: 'output.voice_id', errorCode: 'code', error: 'message' } },
};

const dashscopeCosyvoice: Recipe = {
  id: 'dashscope-cosyvoice',
  kind: 'tts',
  label: { zh: '通义语音 (CosyVoice)', en: 'DashScope CosyVoice' },
  note: { zh: '走 SpeechSynthesizer；音色是 long* 那一套，也承载 qwen-audio-3.0-tts-flash', en: 'SpeechSynthesizer endpoint; long* voices' },
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  models: ['cosyvoice-v3-flash', 'cosyvoice-v3.5-flash', 'cosyvoice-v3-plus', 'cosyvoice-v3.5-plus', 'cosyvoice-v2', 'qwen-audio-3.0-tts-flash'],
  defaultModel: 'cosyvoice-v3-flash',
  defaultVoice: 'longanyang',
  clone: { refSampleRateHz: 16000 },
  roles: [
    {
      role: 'tts.synthesize',
      mode: 'sync',
      method: 'POST',
      label: { zh: '语音合成', en: 'Synthesize' },
      path: '{baseUrl}/services/audio/tts/SpeechSynthesizer',
      headers: AUTH,
      body: {
        model: '{model}',
        input: { text: '{text}', voice: '{voice}' },
        parameters: { format: '{format}', sample_rate: '{sampleRate}', instruction: '{instruction}' },
      },
      vars: [
        { name: 'text', kind: 'inject', type: 'string' },
        { name: 'voice', kind: 'inject', type: 'string' },
        {
          name: 'format', kind: 'param', type: 'string', default: 'mp3', label: { zh: '音频格式', en: 'Audio format' },
          options: ['mp3', 'wav', 'pcm'],
        },
        {
          name: 'sampleRate', kind: 'param', type: 'number', default: 24000, label: { zh: '采样率', en: 'Sample rate' },
          options: [
            { value: 16000, label: { zh: '16k', en: '16k' } },
            { value: 24000, label: { zh: '24k', en: '24k' } },
            { value: 48000, label: { zh: '48k', en: '48k' } },
          ],
        },
        {
          name: 'instruction', kind: 'param', type: 'string', default: '', omitIfEmpty: true,
          label: { zh: '情感指令（部分音色支持）', en: 'Instruction (some voices)' },
        },
      ],
      resp: { kind: 'audio' },
    },
    cosyClone,
  ],
};

const dashscopeQwenTts: Recipe = {
  id: 'dashscope-qwen-tts',
  kind: 'tts',
  label: { zh: '通义语音 (Qwen-TTS)', en: 'DashScope Qwen-TTS' },
  note: { zh: '走 multimodal-generation；音色是 Cherry / Ethan 那一套，与 long* 不通用', en: 'multimodal-generation; Cherry/Ethan voices' },
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  models: ['qwen3-tts-flash', 'qwen3-tts-vc-2026-01-22', 'qwen-tts'],
  defaultModel: 'qwen3-tts-flash',
  defaultVoice: 'Cherry',
  // 官方文档：Qwen-TTS 的克隆参考音频要求 ≥24kHz 单声道（未实测，接入时以试调用确认）
  clone: { refSampleRateHz: 24000 },
  roles: [
    {
      role: 'tts.synthesize',
      mode: 'sync',
      method: 'POST',
      label: { zh: '语音合成', en: 'Synthesize' },
      path: '{baseUrl}/services/aigc/multimodal-generation/generation',
      headers: AUTH,
      body: { model: '{model}', input: { text: '{text}', voice: '{voice}' } },
      vars: [
        { name: 'text', kind: 'inject', type: 'string' },
        { name: 'voice', kind: 'inject', type: 'string' },
      ],
      // 这一族的响应给的是远端音频 URL（现有网页端就是「拿到 url 再下载」）
      resp: { kind: 'json', decode: 'url', pick: { audio: 'output.audio.url', errorCode: 'code', error: 'message' } },
    },
    {
      role: 'tts.clone',
      mode: 'sync',
      method: 'POST',
      label: { zh: '声音克隆', en: 'Voice clone' },
      path: '{baseUrl}/services/audio/tts/customization',
      headers: AUTH,
      // 与 CosyVoice 同一端点、不同形状：action='create' / preferred_name / audio.data → output.voice
      body: {
        model: 'qwen-voice-enrollment',
        input: {
          action: 'create',
          target_model: '{model}',
          preferred_name: '{preferredName}',
          audio: { data: 'data:audio/wav;base64,{wavB64}' },
        },
      },
      vars: [
        { name: 'wavB64', kind: 'inject', type: 'string' },
        { name: 'preferredName', kind: 'param', type: 'string', default: 'mapvideo', label: { zh: '音色名', en: 'Voice name' } },
      ],
      resp: { kind: 'json', pick: { voiceId: 'output.voice', errorCode: 'code', error: 'message' } },
    },
  ],
};

const openaiSpeech: Recipe = {
  id: 'openai-speech',
  kind: 'tts',
  label: { zh: 'OpenAI /audio/speech', en: 'OpenAI /audio/speech' },
  baseUrl: 'https://api.openai.com/v1',
  roles: [{
    role: 'tts.synthesize',
    mode: 'sync',
    method: 'POST',
    label: { zh: '语音合成', en: 'Synthesize' },
    path: '{baseUrl}/audio/speech',
    headers: AUTH,
    body: { model: '{model}', voice: '{voice}', input: '{text}', speed: '{speed}', response_format: '{format}' },
    vars: [
      { name: 'text', kind: 'inject', type: 'string' },
      { name: 'speed', kind: 'param', type: 'number', default: 1, label: { zh: '语速', en: 'Speed' } },
      { name: 'format', kind: 'param', type: 'string', default: 'mp3', label: { zh: '音频格式', en: 'Audio format' }, options: ['mp3', 'wav', 'flac', 'pcm'] },
    ],
    resp: { kind: 'audio' },
  }],
};

const minimaxT2a: Recipe = {
  id: 'minimax-t2a',
  kind: 'tts',
  label: 'MiniMax t2a_v2',
  note: { zh: 'group_id 走 query（第二个密钥槽）；响应里的音频是 hex 字符串', en: 'group_id via query; audio comes back as hex' },
  baseUrl: 'https://api.minimax.chat/v1/t2a_v2',
  roles: [{
    role: 'tts.synthesize',
    mode: 'sync',
    method: 'POST',
    label: { zh: '语音合成', en: 'Synthesize' },
    path: '{baseUrl}',
    headers: AUTH,
    query: { group_id: '{secrets.secret2}' },
    body: {
      model: '{model}',
      text: '{text}',
      voice_setting: { voice_id: '{voice}', speed: '{speed}', vol: 1, format: '{format}' },
      audio_setting: { format: '{format}' },
    },
    vars: [
      { name: 'text', kind: 'inject', type: 'string' },
      { name: 'speed', kind: 'param', type: 'number', default: 1, label: { zh: '语速', en: 'Speed' } },
      { name: 'format', kind: 'param', type: 'string', default: 'mp3', label: { zh: '音频格式', en: 'Audio format' }, options: ['mp3', 'wav', 'pcm', 'flac'] },
    ],
    resp: { kind: 'json', decode: 'hex', pick: { audio: 'data.audio', errorCode: 'status_code', error: 'status_msg' } },
  }],
};

const volcTts: Recipe = {
  id: 'volc-tts',
  kind: 'tts',
  label: { zh: '火山 TTS', en: 'Volcengine TTS' },
  note: { zh: '鉴权是两个 header：App Key + Access Key（不再拼成 appid|token）', en: 'Two header slots instead of appid|token' },
  baseUrl: 'https://openspeech.bytedance.com/api/v1/tts',
  roles: [{
    role: 'tts.synthesize',
    mode: 'sync',
    method: 'POST',
    label: { zh: '语音合成', en: 'Synthesize' },
    path: '{baseUrl}',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-App-Key': '{secrets.apiKey}',
      'X-Api-Access-Key': '{secrets.secret2}',
      'X-Api-Resource-Id': 'volc.service_type.10029',
    },
    body: {
      user: { uid: 'mapvideo' },
      audio: { voice_type: '{voice}', encoding: 'mp3', speed_ratio: '{speed}' },
      request: { reqid: '{reqId}', text: '{text}', operation: 'query' },
    },
    vars: [
      { name: 'text', kind: 'inject', type: 'string' },
      { name: 'reqId', kind: 'inject', type: 'string' },
      { name: 'speed', kind: 'param', type: 'number', default: 1, label: { zh: '语速', en: 'Speed' } },
    ],
    resp: { kind: 'audio' },
  }],
};

const customTts: Recipe = {
  id: 'custom-tts',
  kind: 'tts',
  label: { zh: '自定义语音', en: 'Custom voice' },
  roles: [{
    role: 'tts.synthesize',
    mode: 'sync',
    method: 'POST',
    path: '{baseUrl}',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {secrets.apiKey}' },
    body: { model: '{model}', voice: '{voice}', text: '{text}', speed: '{speed}' },
    vars: [
      { name: 'text', kind: 'inject', type: 'string' },
      { name: 'speed', kind: 'param', type: 'number', default: 1, label: { zh: '语速', en: 'Speed' } },
    ],
    resp: { kind: 'auto' },
  }],
};

// ========== 图片 ==========

const dashscopeImageSync: Recipe = {
  id: 'dashscope-image',
  kind: 'image',
  label: { zh: '通义图片 (同步)', en: 'DashScope image (sync)' },
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  models: ['qwen-image', 'z-image-turbo'],
  defaultModel: 'z-image-turbo',
  roles: [{
    role: 'image.generate',
    mode: 'sync',
    method: 'POST',
    label: { zh: '文生图', en: 'Text to image' },
    path: '{baseUrl}/services/aigc/multimodal-generation/generation',
    headers: AUTH,
    body: {
      model: '{model}',
      input: { messages: [{ role: 'user', content: [{ text: '{prompt}' }] }] },
      parameters: { size: '{size}', prompt_extend: '{promptExtend}', watermark: '{watermark}' },
    },
    vars: [
      { name: 'prompt', kind: 'inject', type: 'string' },
      {
        name: 'size', kind: 'param', type: 'string', default: '2048*1152', allowCustom: true,
        label: { zh: '出图尺寸', en: 'Size' },
        options: ['1024*1024', '2048*1152', '2688*1536'],
      },
      { name: 'promptExtend', kind: 'param', type: 'bool', default: false, label: { zh: '提示词改写', en: 'Prompt extend' } },
      { name: 'watermark', kind: 'param', type: 'bool', default: false, label: { zh: '水印', en: 'Watermark' } },
    ],
    resp: { kind: 'json', decode: 'url', pick: { image: 'output.choices.0.message.content.0.image', errorCode: 'code', error: 'message' } },
  }],
};

/**
 * 异步形状：提交 → 记 task_id → 轮询 tasks/{id} → SUCCEEDED 后取 results.0.url。
 * 路径与判定照官方文档写，**本机未实测**，接入时用「试调用」确认后再定为默认。
 */
const dashscopeImageAsync: Recipe = {
  id: 'dashscope-image-async',
  kind: 'image',
  label: { zh: '通义万相 (异步任务)', en: 'DashScope wanx (async task)' },
  note: { zh: '未实测：照官方「提交 + 任务查询」文档写的，接入时请先用试调用确认', en: 'Unverified: document-shaped, confirm via test call' },
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  models: ['wan2.6-t2i'],
  defaultModel: 'wan2.6-t2i',
  roles: [
    {
      role: 'image.generate',
      mode: 'async',
      method: 'POST',
      label: { zh: '文生图（提交）', en: 'Text to image (submit)' },
      path: '{baseUrl}/services/aigc/text2image/image-synthesis',
      headers: { ...AUTH, 'X-DashScope-Async': 'enable' },
      body: { model: '{model}', input: { prompt: '{prompt}' }, parameters: { size: '{size}', n: '{count}' } },
      vars: [
        { name: 'prompt', kind: 'inject', type: 'string' },
        { name: 'size', kind: 'param', type: 'string', default: '1024*1024', allowCustom: true, label: { zh: '出图尺寸', en: 'Size' }, options: ['1024*1024', '1536*1024', '1024*1536'] },
        { name: 'count', kind: 'param', type: 'number', default: 1, label: { zh: '张数', en: 'Count' } },
      ],
      resp: { kind: 'json', pick: { taskId: 'output.task_id', errorCode: 'code', error: 'message' } },
      poll: {
        taskId: 'output.task_id',
        statusRole: 'image.query',
        intervalMs: 1500,
        timeoutMs: 120000,
        done: { path: 'output.task_status', equals: 'SUCCEEDED' },
        fail: { path: 'output.task_status', in: ['FAILED', 'CANCELED', 'UNKNOWN'] },
        then: { image: 'output.results.0.url' },
      },
    },
    {
      role: 'image.query',
      mode: 'sync',
      method: 'GET',
      label: { zh: '任务状态查询', en: 'Task status' },
      path: '{baseUrl}/services/aigc/tasks/{taskId}',
      headers: { Authorization: 'Bearer {secrets.apiKey}' },
      resp: { kind: 'json', pick: { status: 'output.task_status', errorCode: 'code', error: 'message' } },
    },
  ],
};

const customImage: Recipe = {
  id: 'custom-image',
  kind: 'image',
  label: { zh: '自定义图片', en: 'Custom image' },
  roles: [{
    role: 'image.generate',
    mode: 'sync',
    method: 'POST',
    path: '{baseUrl}',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer {secrets.apiKey}' },
    body: { model: '{model}', prompt: '{prompt}', size: '{size}' },
    vars: [
      { name: 'prompt', kind: 'inject', type: 'string' },
      { name: 'size', kind: 'param', type: 'string', default: '1024*1024', allowCustom: true, label: { zh: '出图尺寸', en: 'Size' }, options: ['1024*1024', '2048*1152'] },
    ],
    resp: { kind: 'auto', pick: { image: 'data.0.url', errorCode: 'code', error: 'message' } },
  }],
};

export const RECIPES: Recipe[] = [
  openaiChat, customLlm,
  dashscopeCosyvoice, dashscopeQwenTts, openaiSpeech, minimaxT2a, volcTts, customTts,
  dashscopeImageSync, dashscopeImageAsync, customImage,
];

export function recipeById(id: string): Recipe | undefined {
  return RECIPES.find((r) => r.id === id);
}

export function recipesFor(kind: ProviderKind): Recipe[] {
  return RECIPES.filter((r) => r.kind === kind);
}

export function rolesOf(recipe: Recipe): Role[] {
  return recipe.roles.map((r) => r.role);
}

/** 该供应商能不能做某件事（例：VoicePicker 用 hasRole(recipe,'tts.clone') 决定克隆区显示与否） */
export function hasRole(recipe: Recipe | undefined, role: Role): boolean {
  return !!recipe?.roles.some((r) => r.role === role);
}

export function templateFor(recipe: Recipe | undefined, role: Role): EndpointTemplate | undefined {
  return recipe?.roles.find((r) => r.role === role);
}
