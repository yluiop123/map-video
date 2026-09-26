/**
 * template-seed.ts — 内置接口模板 seed（首次建库铺成 provider_template 的行）
 *
 * 按用户要求内置这四份（= 六种上游形状）：
 *   deepseek-chat     文案生成                —— https://api-docs.deepseek.com/zh-cn/
 *   qwen-image        图片生成（同步 + 异步 + 任务查询）
 *                     —— platform.qianwenai.com/docs/api-reference/image-generation/qwen-text-to-image{,-30-async,-task-query}
 *   qwen-tts          语音：非流式合成 + 声音复刻（文件直接进体）
 *                     —— platform.qianwenai.com/docs/developer-guides/speech/voice-cloning
 *   elevenlabs-voice  语音：合成（响应体即音频）+ 声音复刻（自己发 multipart 表单）
 *                     —— elevenlabs.io/docs/api-reference/voices/add · /text-to-speech/convert
 *
 * 这里是**数据**：铺进库后模板就是普通可编辑行，「恢复默认」用本文件覆盖回去；
 * 要接别家 = 界面上「＋ 模板」自己填（引擎里没有任何按厂商名写的分支）。
 * 只声明到「该请求真引用到的那几个参数」为止，其余留给用户自己加。
 */
import type { Category, ParamSpec, RequestDef, TemplateDef } from './request-engine';

const AUTH = { Authorization: 'Bearer ${apiKey}' };
const JSON_CT = { 'Content-Type': 'application/json' };

const req = (path: string, o: Partial<RequestDef> = {}): RequestDef => ({ path, method: 'POST', ...o });
/** 认证 + JSON：每条请求各写一份（逐槽配，不再有模板级那份） */
const jsonReq = (path: string, o: Partial<RequestDef> = {}): RequestDef => req(path, { headers: { ...JSON_CT, ...AUTH }, ...o });
const p = (key: string, label: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ key, label, valueType: 'string', ...extra });
const secret = (key: string, label: string): ParamSpec => ({ key, label, valueType: 'secret' });
const num = (key: string, label: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ key, label, valueType: 'number', ...extra });
const en = (key: string, label: string, options: string[], extra: Partial<ParamSpec> = {}): ParamSpec =>
  ({ key, label, valueType: 'enum', options, ...extra });
const bool = (key: string, label: string, defaultValue = false): ParamSpec => ({ key, label, valueType: 'boolean', defaultValue });
const text = (key: string, label: string): ParamSpec => ({ key, label, valueType: 'text' });

/** 实例级共用的三样：地址、密钥、超时（密钥就是 valueType=secret 的普通参数，界面渲染成密码框） */
const net = (baseUrl: string): ParamSpec[] => [p('baseUrl', '服务地址', { defaultValue: baseUrl }), secret('apiKey', 'API Key'), num('timeoutMs', '单次超时 ms', { defaultValue: 60000 })];

/** 异步任务的查询节奏（实例级：账号排队时长差很多，所以给默认值也给人改） */
const pacing = (intervalMs: number, attempts: number): ParamSpec[] => [
  num('queryIntervalMs', '查询间隔 ms', { defaultValue: intervalMs }),
  num('queryMaxAttempts', '查询次数上限', { defaultValue: attempts }),
];

// ========== 文案：DeepSeek ==========

const deepseekChat: TemplateDef = {
  id: 'deepseek-chat', name: 'DeepSeek 对话', category: 'llm',
  caps: { modes: 'sync', artifact: 'none' },

  instanceParams: net('https://api.deepseek.com'),
  sync: {
    submit: jsonReq('${baseUrl}/chat/completions', {
      requestParams: [
        en('model', '模型', ['deepseek-flash', 'deepseek-v4-pro'], { defaultValue: 'deepseek-flash' }),
        en('reasoningEffort', '思考强度', ['high', 'medium', 'low']),
        en('thinking', '深度思考', ['enabled', 'disabled']),
        num('temperature', '温度', { min: 0, max: 2, step: 0.1 }),
        num('maxTokens', '最大输出 token'),
        // 这两条不在这儿填值 —— 每次调用由字幕生成那边给；声明出来是为了有中文名与类型
        text('systemPrompt', '系统提示词'), text('userPrompt', '用户提示词'),
      ],
      body: {
        model: '${model}',
        messages: [{ role: 'system', content: '${systemPrompt}' }, { role: 'user', content: '${userPrompt}' }],
        stream: false,
        reasoning_effort: '${reasoningEffort}',
        thinking: { type: '${thinking}' },
        temperature: '${temperature}',
        max_tokens: '${maxTokens}',
      },
      // thinking 没勾时 {type:${thinking}} 取不到值 → 整个 thinking 键一起删（上游就不会收到半成品）
      outputs: { content: 'choices[0].message.content', errorCode: 'error.code', error: 'error.message' },
    }),
  },
};

// ========== 图片：千问 文生图（同步 + 异步 + 任务查询） ==========

// 画面描述每次调用由出图那一栏给；声明出来是为了有中文名与类型
const imagePrompt: ParamSpec[] = [text('prompt', '画面描述')];
const imageOutputs = { fileRef: 'output.choices[0].message.content[0].image', errorCode: 'code', error: 'message' };

const qwenImage: TemplateDef = {
  id: 'qwen-image', name: '千问 文生图', category: 'image',
  caps: { modes: 'both', artifact: 'url' },

  // 异步开关头只挂在异步提交那一条上（早先整份模板共用一份，同步端点也被塞了它 —— 那是个没实测过的风险）。
  instanceParams: [...net('https://maas.qianwenaiapi.com/api/v1'), ...pacing(5000, 360)],
  sync: {
    submit: jsonReq('${baseUrl}/services/aigc/multimodal-generation/generation', {
      requestParams: [
        en('model', '模型', ['qwen-image-3.0-pro'], { defaultValue: 'qwen-image-3.0-pro' }),
        p('size', '出图尺寸', { defaultValue: '2048*2048' }),
        bool('watermark', '水印'),
        ...imagePrompt,
      ],
      body: {
        model: '${model}',
        input: { messages: [{ role: 'user', content: [{ text: '${prompt}' }] }] },
        parameters: { size: '${size}', watermark: '${watermark}' },
      },
      outputs: imageOutputs,
    }),
  },
  async: {
    submit: req('${baseUrl}/services/aigc/image-generation/generation', {
      headers: { ...JSON_CT, ...AUTH, 'X-DashScope-Async': 'enable' },
      requestParams: [
        en('model', '模型', ['qwen-image-3.0-pro'], { defaultValue: 'qwen-image-3.0-pro' }),
        p('size', '出图尺寸', { defaultValue: '2048*2048' }),
        num('n', '张数', { defaultValue: 1, min: 1, max: 4 }),
        ...imagePrompt,
      ],
      body: {
        model: '${model}',
        input: { messages: [{ role: 'user', content: [{ text: '${prompt}' }] }] },
        parameters: { size: '${size}', n: '${n}' },
      },
      outputs: { taskId: 'output.task_id', errorCode: 'code', error: 'message' },
    }),
    query: req('${baseUrl}/tasks/${taskId}', {
      method: 'GET',
      // GET 没有请求体，也就没什么 Content-Type 可声明 —— 逐槽配头之后这类「跟着模板级一起被塞进来」的头就没得了
      headers: { ...AUTH },
      // 实测（2026-09-23）：异步产物与同步同一路径 output.choices[0].message.content[0].image，
      // 文档写的 output.results[].url 是这个模型不再用的旧形状；任务要排几分钟，queryMaxAttempts 得给够
      outputs: { status: 'output.task_status', fileRef: 'output.choices[0].message.content[0].image', errorCode: 'code', error: 'message' },
      successValues: ['SUCCEEDED'],
      failureValues: ['FAILED', 'CANCELED', 'UNKNOWN'],
    }),
  },
};

// ========== 语音：千问 TTS（非流式合成 + 声音复刻） ==========

const qwenTts: TemplateDef = {
  id: 'qwen-tts', name: '千问 TTS', category: 'tts',
  caps: { modes: 'sync', artifact: 'url', clone: true, cloneVia: 'base64' },
  instanceParams: net('https://maas.qianwenaiapi.com/api/v1'),
  sync: {
    submit: jsonReq('${baseUrl}/services/aigc/multimodal-generation/generation', {
      requestParams: [
        en('model', '模型', ['qwen3-tts-flash', 'qwen3-tts-vc-2026-01-22'], { defaultValue: 'qwen3-tts-flash' }),
        en('languageType', '语种', ['Chinese', 'English', 'Auto'], { defaultValue: 'Chinese' }),
        // 这两条每次调用由字幕生成那一行给（voice 也可以在这儿钉死一个默认音色）
        text('text', '合成文本'), p('voice', '音色 ID', { defaultValue: 'Ethan' }),
      ],
      body: {
        model: '${model}',
        // 官方形状：language_type 在 input 里（不是 parameters —— 那是 CosyVoice 那一套的位置）
        input: { text: '${text}', voice: '${voice}', language_type: '${languageType}' },
      },
      outputs: { fileRef: 'output.audio.url', errorCode: 'code', error: 'message' },
    }),
  },
  clone: jsonReq('${baseUrl}/services/audio/tts/customization', {
    requestParams: [
      en('model', '复刻目标模型（须与合成同款）', ['qwen3-tts-vc-2026-01-22'], { defaultValue: 'qwen3-tts-vc-2026-01-22' }),
      p('preferredName', '音色名', { defaultValue: 'mapvideo' }),
    ],
    body: {
      model: 'qwen-voice-enrollment',
      // `${voiceData}` 是引擎注入的那个文件（不在上面声明）：这一家要的是 `data:<mime>;base64,…`
      input: { action: 'create', target_model: '${model}', preferred_name: '${preferredName}', audio: { data: '${voiceData}' } },
    },
    outputs: { voiceId: 'output.voice', errorCode: 'code', error: 'message' },
  }),
};

// ========== 语音：ElevenLabs（合成 = 响应体裸字节 · 复刻 = 自己发 multipart 表单） ==========

/**
 * 这一家与千问那两条的差异全是数据：
 * 认证头叫 `xi-api-key`（不是 Bearer）；产物不用从字段里取（`caps.artifact='binary'`）；
 * 音色 id 走 **URL 路径**；建音色前不单独上传 —— 文件与 name 一起进同一张 multipart 表单（`cloneVia='form'`）。
 * 官网：https://elevenlabs.io/docs/api-reference/voices/add · /text-to-speech/convert
 * **未实测**（没有这家的 Key）：路径与字段名照官网逐字抄，产物与错误结构等真发过再改。
 */
const elevenLabsVoice: TemplateDef = {
  id: 'elevenlabs-voice', name: 'ElevenLabs 语音', category: 'tts',
  caps: { modes: 'sync', artifact: 'binary', clone: true, cloneVia: 'form' },
  instanceParams: net('https://api.elevenlabs.io/v1'),
  sync: {
    submit: req('${baseUrl}/text-to-speech/${voice}', {
      // 音色名在地址里，不在体里 —— 各家把音色放哪一栏不一样，这正是逐槽配地址的意义
      headers: { ...JSON_CT, 'xi-api-key': '${apiKey}' },
      requestParams: [
        en('model', '模型', ['eleven_multilingual_v2', 'eleven_flash_v2_5'], { defaultValue: 'eleven_multilingual_v2' }),
        text('text', '合成文本'), p('voice', '音色 ID'),
      ],
      body: { text: '${text}', model_id: '${model}' },
      outputs: { errorCode: 'detail.status', error: 'detail.message' },
    }),
  },
  clone: req('${baseUrl}/voices/add', {
    // 发的是表单：Content-Type 由传输层生成（它要带 boundary），所以这儿只声明认证头
    headers: { 'xi-api-key': '${apiKey}' },
    requestParams: [p('preferredName', '音色名', { defaultValue: 'mapvideo' })],
    // 官网字段名是复数 `files`（可交多份样本），`${voiceData}` 就是那个二进制分片
    form: { name: '${preferredName}', files: '${voiceData}' },
    outputs: { voiceId: 'voice_id', errorCode: 'detail.status', error: 'detail.message' },
  }),
};

export const SEED_TEMPLATES: TemplateDef[] = [deepseekChat, qwenImage, qwenTts, elevenLabsVoice];

export const seedTemplate = (id: string): TemplateDef | undefined => SEED_TEMPLATES.find((t) => t.id === id);

export const templatesFor = (category: Category): TemplateDef[] => SEED_TEMPLATES.filter((t) => t.category === category);

/** 「＋ 模板」的空壳：只带地址与密钥两条声明，接口与参数全由用户自己填 */
export function blankTemplate(category: Category): TemplateDef {
  return {
    id: '', name: '', category,
    caps: category === 'llm' ? { modes: 'sync', artifact: 'none' } : { modes: 'sync', artifact: 'url' },
    instanceParams: net(''),
    sync: {
      submit: jsonReq('${baseUrl}', {
        requestParams: [text(category === 'image' ? 'prompt' : 'text', category === 'image' ? '画面描述' : '文本')],
        body: { model: '${model}' },
      }),
    },
  };
}

/** seed 深拷贝（界面编辑绝不能改到常量本身） */
export function seedCopy(): TemplateDef[] {
  return structuredClone(SEED_TEMPLATES);
}
