/**
 * template-seed.ts — 内置接口模板 seed（首次建库铺成 provider_template 的行）
 *
 * 按用户要求内置这七份（= 七种上游形状）：
 *   deepseek-chat     文案生成（显示名按他在界面里改的那一份：`openai`；id 不变）
 *                     —— https://api-docs.deepseek.com/zh-cn/
 *   qwen-image        图片生成（同步 + 异步 + 任务查询）
 *                     —— platform.qianwenai.com/docs/api-reference/image-generation/qwen-text-to-image{,-30-async,-task-query}
 *   qwen-tts          语音：非流式合成 + 声音复刻（文件直接进体）
 *                     —— platform.qianwenai.com/docs/developer-guides/speech/voice-cloning
 *   qwen-audio-tts    语音：SpeechSynthesizer 那条 —— **只有它带 input.volume 与 input.hot_fix**
 *                     —— help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api · 音色表 qwen-audio-tts-voice-list
 *   elevenlabs-voice  语音：合成（响应体即音频）+ 声音复刻（自己发 multipart 表单）
 *                     —— elevenlabs.io/docs/api-reference/voices/add · /text-to-speech/convert
 *   minimax-voice     语音：合成（hex）+ 复刻（先单独上传拿 file_id · 上游不回音色 id）
 *                     —— platform.minimax.io/docs/api-reference/voice-cloning-{uploadcloneaudio,clone} · /speech-t2a-http
 *   minimax-image     图片：只有同步，链接 24 小时过期
 *                     —— platform.minimax.io/docs/api-reference/image-generation-t2i
 *
 * 这里是**数据**：铺进库后模板就是普通可编辑行，「恢复默认」用本文件覆盖回去；
 * 要接别家 = 界面上「＋ 模板」自己填（引擎里没有任何按厂商名写的分支）。
 * 只声明到「该请求真引用到的那几个参数」为止，其余留给用户自己加。
 */
import type { Category, OptionSpec, ParamSpec, RequestDef, TemplateDef } from './request-engine';

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
/**
 * 一条**音色表**参数：候选值带分组，且这一格声明成音色表 ——
 * 界面因此长成分组选择器 + 克隆音色那一段（判据是声明的形状，不认参数名，也不认厂商）。
 */
const voice = (defaultValue: string, options: OptionSpec[]): ParamSpec =>
  ({ key: 'voice', label: '音色 ID', valueType: 'enum', voiceTable: true, options, defaultValue });
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
  id: 'deepseek-chat', name: 'openai', category: 'llm',
  caps: { modes: 'sync' },

  instanceParams: net('https://api.deepseek.com'),
  sync: {
    submit: jsonReq('${baseUrl}/chat/completions', {
      requestParams: [
        en('model', '模型', ['deepseek-flash', 'deepseek-v4-pro'], { defaultValue: 'deepseek-flash' }),
        // 官网（2026-09-26 核对）这一档的合法值就是 none / low / high / max —— `none` 直接关掉思考，
        // 没有 medium（早先那串里抄来的，填上去上游不认）
        en('reasoningEffort', '思考强度', ['none', 'low', 'high', 'max']),
        en('thinking', '深度思考', ['enabled', 'disabled']),
        num('temperature', '温度', { defaultValue: 1, min: 0, max: 2, step: 0.1 }),
        num('maxTokens', '最大输出 token', { defaultValue: 200000 }),
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
const imageOutputs = { artifact: 'output.choices[0].message.content[0].image', errorCode: 'code', error: 'message' };

const qwenImage: TemplateDef = {
  id: 'qwen-image', name: '千问 文生图', category: 'image',
  caps: { modes: 'both' },

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
      artifactForm: 'url',
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
      artifactForm: 'url',
      outputs: { status: 'output.task_status', artifact: 'output.choices[0].message.content[0].image', errorCode: 'code', error: 'message' },
      successValues: ['SUCCEEDED'],
      failureValues: ['FAILED', 'CANCELED', 'UNKNOWN'],
    }),
  },
};

// ========== 语音：千问 TTS（非流式合成 + 声音复刻） ==========

/** 千问 TTS 的系统音色（38 条：男 19 / 女 19）。id 与中文名逐字抄官方表。
 * 全部只吃 `qwen3-tts-flash` —— 实测拿系统音色喂 `-vc` 那条模型，上游回 InvalidParameter（官方另有 10 个方言音色，没进表：要用时在界面上手填）。 */
const qwenVoices: OptionSpec[] = [
  { value: 'Cherry', label: '芊悦', group: '女声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Serena', label: '苏瑶', group: '女声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Chelsie', label: '千雪', group: '女声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Ethan', label: '晨煦', group: '男声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Moon', label: '月白', group: '男声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Kai', label: '凯', group: '男声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Nofish', label: '不吃鱼', group: '男声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Ryan', label: '甜茶', group: '男声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Aiden', label: '艾登', group: '男声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Eldric Sage', label: '沧明子', group: '男声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Mochi', label: '沙小弥', group: '男声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Vincent', label: '田叔', group: '男声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Neil', label: '阿闻', group: '男声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Arthur', label: '徐大爷', group: '男声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Pip', label: '顽屁小孩', group: '男声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Bodega', label: '博德加', group: '男声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Alek', label: '阿列克', group: '男声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Dolce', label: '多尔切', group: '男声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Lenn', label: '莱恩', group: '男声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Emilien', label: '埃米尔安', group: '男声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Andre', label: '安德雷', group: '男声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Radio Gol', label: '拉迪奥·戈尔', group: '男声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Momo', label: '茉兔', group: '女声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Vivian', label: '十三', group: '女声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Maia', label: '四月', group: '女声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Bella', label: '萌宝', group: '女声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Jennifer', label: '詹妮弗', group: '女声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Katerina', label: '卡捷琳娜', group: '女声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Mia', label: '乖小妹', group: '女声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Bellona', label: '燕铮莺', group: '女声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Bunny', label: '萌小姬', group: '女声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Elias', label: '墨讲师', group: '女声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Nini', label: '邻家妹妹', group: '女声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Seren', label: '小婉', group: '女声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Stella', label: '少女阿月', group: '女声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Sonrisa', label: '索尼莎', group: '女声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Sohee', label: '素熙', group: '女声', note: '中英多语', models: ['qwen3-tts-flash'] },
  { value: 'Ono Anna', label: '小野杏', group: '女声', note: '中英多语', models: ['qwen3-tts-flash'] },
];

const qwenTts: TemplateDef = {
  id: 'qwen-tts', name: '千问 TTS', category: 'tts',
  caps: { modes: 'sync', clone: true, cloneVia: 'base64' },
  instanceParams: net('https://maas.qianwenaiapi.com/api/v1'),
  sync: {
    submit: jsonReq('${baseUrl}/services/aigc/multimodal-generation/generation', {
      requestParams: [
        en('model', '模型', ['qwen3-tts-flash', 'qwen3-tts-vc-2026-01-22'], { defaultValue: 'qwen3-tts-flash' }),
        en('languageType', '语种', ['Chinese', 'English', 'Auto'], { defaultValue: 'Chinese' }),
        // 这两条每次调用由字幕生成那一行给（voice 也可以在这儿钉死一个默认音色）
        text('text', '合成文本'),
        // 音色表就是这条参数的候选值（界面上因此长成分组选择器 + 克隆音色那段）
        voice('Ethan', qwenVoices),
      ],
      body: {
        model: '${model}',
        // 官方形状：language_type 在 input 里（不是 parameters —— 那是 CosyVoice 那一套的位置）
        input: { text: '${text}', voice: '${voice}', language_type: '${languageType}' },
      },
      artifactForm: 'url',
      outputs: { artifact: 'output.audio.url', errorCode: 'code', error: 'message' },
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

// ========== 语音：Qwen-Audio-TTS（**有音量与发音修正**的那条端点） ==========

/**
 * 官方音色表，逐字抄自「Qwen-Audio-TTS 音色列表」（2026-09-27）。
 * 只铺这两条模型的（`qwen-audio-3.1-tts-flash` 那一族有六十多条，要就在 ⚙ 里自己加 —— 表就是数据）；
 * `models` 决定选了上面那条「模型」之后露出哪些音色。
 */
const qwenAudioVoices: OptionSpec[] = [
  { value: 'longanfengyue', label: '龙安风悦', group: '女声', note: '自然亲切音', models: ['qwen-audio-3.0-tts-flash'] },
  { value: 'longanxiaoxin', label: '龙安小昕', group: '女声', note: '亲切活泼音', models: ['qwen-audio-3.0-tts-flash'] },
  { value: 'longanlingxi', label: '龙安灵希', group: '女声', note: '可爱甜美音', models: ['qwen-audio-3.0-tts-flash'] },
  { value: 'longanyuanfei', label: '龙安元妃', group: '女声', note: '高傲妃子音', models: ['qwen-audio-3.0-tts-flash'] },
  { value: 'longanhuan_v3.6', label: '龙安欢', group: '女声', note: '基础版（后缀与 3.1 不同）', models: ['qwen-audio-3.0-tts-flash'] },
  { value: 'longpaopao_v3.6', label: '龙泡泡', group: '女声', note: '软糯可爱音', models: ['qwen-audio-3.0-tts-flash'] },
  { value: 'loongeva_v3.6', label: 'loongeva', group: '女声', note: '高智美音', models: ['qwen-audio-3.0-tts-flash'] },
  { value: 'loongmary', label: 'loongmary', group: '女声', note: '温暖英音', models: ['qwen-audio-3.0-tts-flash'] },
  { value: 'longjielidou_v3.6', label: '龙杰力豆', group: '男声', note: '天真男童', models: ['qwen-audio-3.0-tts-flash'] },
  { value: 'longhuohuo_v3.6', label: '龙火火', group: '男声', note: '顽皮少年音', models: ['qwen-audio-3.0-tts-flash'] },
  { value: 'longchuanshu_v3.6', label: '龙川叔', group: '男声', note: '川普大叔音', models: ['qwen-audio-3.0-tts-flash'] },
  { value: 'loongjohn', label: 'loongJohn', group: '男声', note: '沉稳亲切美音', models: ['qwen-audio-3.0-tts-flash'] },
  { value: 'longanlingxin', label: '龙安灵心', group: '女声', note: '知心温暖音', models: ['qwen-audio-3.0-tts-plus'] },
  { value: 'longanlufeng', label: '龙安鲁风', group: '男声', note: '明亮开朗音', models: ['qwen-audio-3.0-tts-plus'] },
];

const qwenAudioTts: TemplateDef = {
  id: 'qwen-audio-tts', name: '千问语音（音量 / 发音修正）', category: 'tts',
  // 这一家要**公网可取的参考音频地址**（本地文件给不出去），所以不勾建音色 —— 要克隆就用「千问 TTS」那条
  caps: { modes: 'sync' },

  instanceParams: net('https://maas.qianwenaiapi.com/api/v1'),
  sync: {
    submit: jsonReq('${baseUrl}/services/audio/tts/SpeechSynthesizer', {
      requestParams: [
        en('model', '模型', ['qwen-audio-3.0-tts-flash', 'qwen-audio-3.0-tts-plus'], { defaultValue: 'qwen-audio-3.0-tts-flash' }),
        text('text', '合成文本'),
        voice('longanfengyue', qwenAudioVoices),
        // 上游默认 50（半量），这里钉 100：产物本身就响，预览与导出跟着响
        num('volume', '音量（0–100）', { defaultValue: 100, min: 0, max: 100 }),
        // 发音修正是字幕生成那一栏每次带下来的：声明成 json 就原样进体，没给值整键消失
        p('hotFix', '发音修正', { valueType: 'json' }),
      ],
      body: {
        model: '${model}',
        // 这一家的控制项全在 input 里（不是 parameters）
        input: { text: '${text}', voice: '${voice}', volume: '${volume}', hot_fix: '${hotFix}' },
      },
      artifactForm: 'url',
      // 非流式回的是 JSON，音频在 output.audio.url（有效期 24 小时 —— 所以当场下载）
      outputs: { artifact: 'output.audio.url', errorCode: 'code', error: 'message' },
    }),
  },
};

// ========== 语音：ElevenLabs（合成 = 响应体裸字节 · 复刻 = 自己发 multipart 表单） ==========

/** ElevenLabs 的默认音色表（21 条：男 13 / 女 7 / 中性 1），逐字取自 `/v1/voices` 的真响应（2026-09-26）。 */
const elevenLabsVoices: OptionSpec[] = [
  { value: 'CwhRBWXzGAHq8TQ4Fs17', label: 'Roger', group: '男声', note: '随性、浑厚 · 日常对话' },
  { value: 'IKne3meq5aSn9XLyUdCD', label: 'Charlie', group: '男声', note: '澳洲青年 · 有精神' },
  { value: 'JBFqnCBsd6RMkjVDRZzb', label: 'George', group: '男声', note: '暖 · 抓人的讲述感' },
  { value: 'N2lVS1w4EtoT3dr4eOWO', label: 'Callum', group: '男声', note: '沙哑 · 带刺' },
  { value: 'TX3LPaxmHKxFdv7VOQHJ', label: 'Liam', group: '男声', note: '短视频向 · 有活力' },
  { value: 'bIHbv24MWmeRgasZH58o', label: 'Will', group: '男声', note: '松弛 · 乐观' },
  { value: 'cjVigY5qzO86Huf0OWal', label: 'Eric', group: '男声', note: '男中音 · 稳' },
  { value: 'iP95p4xoKVk53GoZ742B', label: 'Chris', group: '男声', note: '朴实 · 百搭' },
  { value: 'nPczCjzI2devNBz1zQrb', label: 'Brian', group: '男声', note: '低沉 · 安抚' },
  { value: 'onwK4e9ZLuTAKqWW03F9', label: 'Daniel', group: '男声', note: '播音腔 · 新闻' },
  { value: 'pNInz6obpgDQGcFmaJgB', label: 'Adam', group: '男声', note: '明亮男高音 · 有压' },
  { value: 'pqHfZKP75CvOlQylNhV4', label: 'Bill', group: '男声', note: '成熟 · 讲故事' },
  { value: 'SOYHLrjzK2X1ezoPC6cr', label: 'Harry', group: '男声', note: '战士腔 · 有冲劲' },
  { value: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah', group: '女声', note: '自信 · 专业 · 让人放心' },
  { value: 'FGY2WhTYpPnrIDTdsKH5', label: 'Laura', group: '女声', note: '明媚 · 一点古怪' },
  { value: 'Xb7hH8MSUJpSbSDYk0k2', label: 'Alice', group: '女声', note: '英音 · 教学向' },
  { value: 'XrExE9yKIg1WjnnlVkGX', label: 'Matilda', group: '女声', note: '职业 · 中低音' },
  { value: 'cgSgspJ2msm6clMCkdW9', label: 'Jessica', group: '女声', note: '美式 · 俏皮' },
  { value: 'hpp4J3VqNfWAUOO0d1Us', label: 'Bella', group: '女声', note: '明亮 · 叙述感' },
  { value: 'pFZP5JQG7iQjIQuC4Bku', label: 'Lily', group: '女声', note: '英音 · 新闻与旁白' },
  { value: 'SAz9YHcvj6GT2YYXdXww', label: 'River', group: '中性', note: '松弛中性 · 旁白与对话都行' },
];

/**
 * 这一家与千问那两条的差异全是数据：
 * 认证头叫 `xi-api-key`（不是 Bearer）；产物不用从字段里取（这一格 `artifactForm:'binary'`）；
 * 音色 id 走 **URL 路径**；建音色前不单独上传 —— 文件与 name 一起进同一张 multipart 表单（`cloneVia='form'`）。
 * 官网：https://elevenlabs.io/docs/api-reference/voices/add · /text-to-speech/convert
 * 实测（2026-09-26，都在应用里的「试调用」跑的）：合成 ✅（200 · 40KB 裸字节）；错误体形状 ✅
 * （`{detail:{type,code,message,status}}`，人话在 `detail.message`）；建音色的 multipart 请求发对了
 * （`name` + `files` 都被受理），但上游回 `paid_plan_required`——**那是账号套餐不含即时复刻，不是形状错**。
 * 它家默认音色表逐字取自 `/v1/voices`（见 `lib/voices.ts` 的 `ELEVENLABS_VOICES`，官方 labels 里就有 `gender: neutral`）。
 */
const elevenLabsVoice: TemplateDef = {
  id: 'elevenlabs-voice', name: 'ElevenLabs 语音', category: 'tts',
  caps: { modes: 'sync', clone: true, cloneVia: 'form' },
  instanceParams: net('https://api.elevenlabs.io/v1'),
  sync: {
    submit: req('${baseUrl}/text-to-speech/${voice}', {
      // 音色名在地址里，不在体里 —— 各家把音色放哪一栏不一样，这正是逐槽配地址的意义
      headers: { ...JSON_CT, 'xi-api-key': '${apiKey}' },
      requestParams: [
        en('model', '模型', ['eleven_multilingual_v2', 'eleven_flash_v2_5'], { defaultValue: 'eleven_multilingual_v2' }),
        text('text', '合成文本'),
        voice('CwhRBWXzGAHq8TQ4Fs17', elevenLabsVoices),
      ],
      body: { text: '${text}', model_id: '${model}' },
      // 实测（2026-09-26）：错误体是 { detail: { type, code, message, status, request_id } } —— 人话在 detail.message；
      // 填成 detail 或 detail.error 会取到对象 / 空串，界面就只剩一条「HTTP 401」看不出为什么
      artifactForm: 'binary',
      outputs: { errorCode: 'detail.code', error: 'detail.message' },
    }),
  },
  clone: req('${baseUrl}/voices/add', {
    // 发的是表单：Content-Type 由传输层生成（它要带 boundary），所以这儿只声明认证头
    headers: { 'xi-api-key': '${apiKey}' },
    requestParams: [p('preferredName', '音色名', { defaultValue: 'mapvideo' })],
    // 官网字段名是复数 `files`（可交多份样本），`${voiceData}` 就是那个二进制分片
    form: { name: '${preferredName}', files: '${voiceData}' },
    outputs: { voiceId: 'voice_id', errorCode: 'detail.code', error: 'detail.message' },
  }),
};

// ========== 语音：MiniMax（先传文件拿 file_id → 复刻 → 合成 · 产物是 hex） ==========

/**
 * 这一家把「单独上传」那条接法占齐了，三格各管一段：
 * ① 上传 = multipart 表单（字段 `file` + `purpose=voice_clone`），交回 `file.file_id`（**整数**），
 *    引擎把它注入成下一格的 `${voiceData}`；② 复刻吃 `file_id` + 一个**自己起的** `voice_id`；
 * ③ 合成的音频在 `data.audio`，默认编码是 **hex**（`output_format` 还能要 url，要的话这一格的
 *    「产物形式」得跟着改，所以 seed 不声明那条参数 —— 两处得配套，少一处就会静默拿一串十六进制当字节）。
 * 关键差异：**复刻的成功响应里没有音色 id**（只有 `base_resp`），名字就是请求里传的那个 `voice_id`。
 * 所以克隆那一格写 `${voiceId}`，固定项「音色 ID」的路径留空 —— 引擎拿本轮发出去的名字当结果
 * （判据在 `requiredOutputsOf` 与 `runClone`，同一处）。
 * 报错也在 `base_resp`（HTTP 照样回 200，所以错误项必须填，不然界面只剩「成功」两个字）。
 * 官网：https://platform.minimax.io/docs/api-reference/voice-cloning-uploadcloneaudio ·
 *      /voice-cloning-clone · /speech-t2a-http
 * 实测（2026-09-26）：**上传那一格真发通了** —— HTTP 200 + `file.file_id`（**整数** 445802206159195）
 * + `base_resp:{status_code:0,status_msg:'success'}`；这一条同时证明 `errorOf` 认 `0`/`success` 为成功是必需的
 * （按老逻辑这一次成功会被读成一条 `0 · success` 的失败）。**复刻与合成仍卡在账号余额**（`1008`），没跑到成功响应。
 * 国内站的地址是 `https://api.minimaxi.com/v1`（Key 不通用）—— 那是实例级的值，改地址不用改模板。
 */
const minimaxVoice: TemplateDef = {
  id: 'minimax-voice', name: 'MiniMax 语音', category: 'tts',
  caps: { modes: 'sync', clone: true, cloneVia: 'upload' },
  instanceParams: net('https://api.minimax.io/v1'),
  sync: {
    submit: jsonReq('${baseUrl}/t2a_v2', {
      requestParams: [
        en('model', '模型', ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo'], { defaultValue: 'speech-2.8-hd' }),
        text('text', '合成文本'),
        // 预置音色或自己复刻出来的都行；这份模板没接官方音色表，所以配音那侧长的是「手填音色 ID」
        p('voice', '音色 ID', { defaultValue: 'male-qn-qingse' }),
      ],
      body: { model: '${model}', text: '${text}', voice_setting: { voice_id: '${voice}' } },
      artifactForm: 'hex',
      outputs: { artifact: 'data.audio', errorCode: 'base_resp.status_code', error: 'base_resp.status_msg' },
    }),
  },
  upload: req('${baseUrl}/files/upload', {
    // 发的是表单：Content-Type 由传输层生成（要带 boundary），所以只声明认证头
    headers: { ...AUTH },
    form: { purpose: 'voice_clone', file: '${voiceData}' },
    outputs: { artifact: 'file.file_id', errorCode: 'base_resp.status_code', error: 'base_resp.status_msg' },
  }),
  clone: jsonReq('${baseUrl}/voice_clone', {
    requestParams: [p('voiceId', '音色名（自己起 · 上游不回它）', { defaultValue: 'mapvideo' })],
    body: { file_id: '${voiceData}', voice_id: '${voiceId}' },
    // 没有 voiceId 这一项：响应不回，引擎用上面那个 `${voiceId}` 当结果（留空才是对的，见固定项那行的说明）
    outputs: { errorCode: 'base_resp.status_code', error: 'base_resp.status_msg' },
  }),
};

// ========== 图片：MiniMax 文生图（只有同步 · 链接 24 小时过期） ==========

/**
 * `POST /v1/image_generation` 当场回图，**没有异步任务端点**（所以能力开关只勾同步）。
 * 产物在 `data.image_urls[0]`（`response_format=base64` 才换 `data.image_base64` 那一串 —— 同样得跟着改产物形式）。
 * 官网明写**链接 24 小时过期**，所以这一格是 `url` 档：引擎当场下载后落 `asset`，绝不留地址。
 * `n` 没声明：一次调用只取一张产物，摆个能选 3 的格子等于骗人。
 * 官网：https://platform.minimax.io/docs/api-reference/image-generation-t2i
 * 未实测：真发被账号余额挡住（`1008`），所以这一格只按文档写过形状、没对照过成功响应。
 */
const minimaxImage: TemplateDef = {
  id: 'minimax-image', name: 'MiniMax 文生图', category: 'image',
  caps: { modes: 'sync' },
  instanceParams: net('https://api.minimax.io/v1'),
  sync: {
    submit: jsonReq('${baseUrl}/image_generation', {
      requestParams: [
        en('model', '模型', ['image-01'], { defaultValue: 'image-01' }),
        en('aspectRatio', '画幅', ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'], { defaultValue: '1:1' }),
        bool('promptOptimizer', '提示词润色'),
        ...imagePrompt,
      ],
      body: { model: '${model}', prompt: '${prompt}', aspect_ratio: '${aspectRatio}', prompt_optimizer: '${promptOptimizer}' },
      artifactForm: 'url',
      outputs: { artifact: 'data.image_urls[0]', errorCode: 'base_resp.status_code', error: 'base_resp.status_msg' },
    }),
  },
};

export const SEED_TEMPLATES: TemplateDef[] = [deepseekChat, qwenImage, qwenTts, qwenAudioTts, elevenLabsVoice, minimaxVoice, minimaxImage];

export const seedTemplate = (id: string): TemplateDef | undefined => SEED_TEMPLATES.find((t) => t.id === id);

export const templatesFor = (category: Category): TemplateDef[] => SEED_TEMPLATES.filter((t) => t.category === category);

/** 「＋ 模板」的空壳：只带地址与密钥两条声明，接口与参数全由用户自己填 */
export function blankTemplate(category: Category): TemplateDef {
  return {
    id: '', name: '', category,
    caps: { modes: 'sync' },
    instanceParams: net(''),
    sync: {
      submit: jsonReq('${baseUrl}', {
        requestParams: [text(category === 'image' ? 'prompt' : 'text', category === 'image' ? '画面描述' : '文本')],
        body: { model: '${model}' },
        artifactForm: category === 'llm' ? undefined : 'url',
      }),
    },
  };
}

/** seed 深拷贝（界面编辑绝不能改到常量本身） */
export function seedCopy(): TemplateDef[] {
  return structuredClone(SEED_TEMPLATES);
}
