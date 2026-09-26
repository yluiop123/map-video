/**
 * request-engine.ts — 接口模板的求值与执行（「模板即数据」的那一半）
 *
 * 形状照 `docs/provider-engine.md`：一份模板 = 一行（同步 / 异步 / 上传 / 克隆都在里面），
 * 参数分三层（实例级 / 请求级 / 调用级），占位符统一 `${x}`，中间变量靠 `outputs` 隐式流转。
 * **这里没有按厂商名写的分支**：三家的差异（认证头、taskId 在 path 还是 body、hex 还是 url、
 * 发音修正的数组形状）全部是模板里的数据。
 * 引擎不碰网络、不碰 DOM —— 传输由调用端注入 deps.send / deps.fetchBytes。
 */
import { JSONPath } from 'jsonpath-plus';

// ========== 类型 ==========

export type Category = 'llm' | 'tts' | 'image';
/** 请求在模板里的位置；界面与 values.requests 都用这个名字 */
export type ReqKey = 'sync.submit' | 'async.submit' | 'async.query' | 'upload' | 'clone';
export type ValueType =
  | 'string' | 'text' | 'number' | 'boolean' | 'enum' | 'multiEnum' | 'array' | 'secret' | 'json';
/** 产物封装方式：binary 响应体即产物 / hex / base64 / url 是带时效的链接 */
export type OutputFormat = 'binary' | 'hex' | 'base64' | 'url';

export interface OptionSpec { value: string | number | boolean; label?: string }

/**
 * 一条参数声明。名字 / 说明都是用户自填的单个字符串（自定义的东西没有自动翻这回事）。
 * **没有「必填」也没有「加工方式」**：声明出来的参数要么在实例里填、要么在调用时给，
 * 没有第三种来源，所以「必不必填」这个问题问得没意义；取值成形只看 `valueType`。
 */
export interface ParamSpec {
  key: string;
  label?: string;
  valueType?: ValueType;
  defaultValue?: unknown;
  /** 有 options 就是选项块；enum 单值、multiEnum 数组 */
  options?: (OptionSpec | string | number | boolean)[];
  min?: number;
  max?: number;
  step?: number;
  minCount?: number;
  maxCount?: number;
  /** array 的元素类型 */
  itemType?: 'string' | 'number';
}

/** 一条请求（核心或桥接）。请求头逐条各配一份：同一个账号的认证头家家一样，但异步开关头只有提交那条要 */
export interface RequestDef {
  /** 地址模板，`${x}` 随便写；查询参数直接拼在串上（各家 taskId 位置不同，写在这里就行） */
  path: string;
  method?: string;
  /** 这一条请求自己的头；值里同样可写 `${apiKey}` 这类占位符 */
  headers?: Record<string, unknown>;
  /**
   * 这一格的参数声明（只有一张表 —— 原先分「请求级 / 调用级」两张，长得像两套东西，
   * 其实说的是「值从哪来」，而那由取值优先级决定，不由声明在哪决定）。
   * 填了值的走实例，没填的由调用点现场给；两者都是同一个 `${key}`。
   */
  requestParams?: ParamSpec[];
  body?: unknown;
  /** multipart 表单（发这一格的判据见 `multipartSlotOf`：上传那格恒用，克隆格在 `cloneVia:'form'` 时用） */
  form?: Record<string, unknown>;
  /**
   * **这一格**的产物以什么形式回 —— 与固定项「产物」（`ARTIFACT_KEY`）成对配置：
   * 这一档决定怎么变成字节，那一格决定去响应的哪个字段取。
   * `none` = 这一格没有产物（文案生成就是，取一段文本），`binary` = 响应体本身即产物（不用取字段）。
   * 早先它是整份模板一份（`caps.artifact`），于是同步回链接、异步回 base64 这种配不出来，
   * 而且和固定项 `fileRef` 撞过一次名 —— 现在逐格一份，固定项统一叫 `artifact`。
   */
  artifactForm?: ArtifactEncoding;
  /** 从响应里取字段：固定项名字写死（见 requiredOutputsOf），其余键是留给下游 `${x}` 的变量 */
  outputs?: Record<string, string>;
  /** 只有 query 用；中间态不配（没命中两个列表就继续查） */
  successValues?: string[];
  failureValues?: string[];
}

/**
 * 产物在响应里以什么形式给 —— 整份模板问一次，同步与异步共用。
 * `none` 是 llm 那种「没有产物，取文本」；`url` 是带时效的链接，**当场下载**（不留到以后）。
 */
export type ArtifactEncoding = 'none' | 'binary' | 'base64' | 'hex' | 'url';
/** 真要还原成字节时的四种封装（`none` 没有产物可言） */
export type ArtifactFormat = Exclude<ArtifactEncoding, 'none'>;

/** 参考音频交到克隆接口手里的三种形式（一家一种，全是数据，不是代码分支） */
export type CloneVia = 'upload' | 'base64' | 'form';

/**
 * 能力开关：模板头上那几个问题的答案。**这是唯一输入** —— 该有哪些接口槽、
 * 每槽必须交出哪些字段、那一格发 JSON 体还是表单，全部由它推导，不再让人自己挑。
 */
export interface Caps {
  /** 调用方式：只同步 / 只异步 / 两套都有（llm 恒 sync）；界面上是两个复选框 */
  modes: 'sync' | 'async' | 'both';
  /** 要不要建音色（仅 tts） */
  clone?: boolean;
  /**
   * 建音色时，参考音频以什么形式交过去（仅 clone 开着时有意义）：
   * - `upload`：先单独上传拿文件引用，克隆那格写 `${voiceData}` 拿到的就是它（于是多出「上传」那一格）
   * - `base64`：文件转成 `data:<mime>;base64,…` 当 JSON 字段（克隆那格写 `${voiceData}`）
   * - `form`：克隆那一格自己发 multipart 表单 —— 文件是其中的分片，没有 Body
   */
  cloneVia?: CloneVia;
}

/** 一份完整模板 */
export interface TemplateDef {
  id: string;
  name: string;
  category: Category;
  /** 能力开关：槽位与承重输出的唯一来源 */
  caps: Caps;
  /** 实例级参数声明：所有请求共用（超时 / 批次并发 / 查询节奏…） */
  instanceParams?: ParamSpec[];
  sync?: { submit?: RequestDef };
  async?: { submit?: RequestDef; query?: RequestDef };
  /** 桥接：本地文件 → 文件引用（url 或文件号） */
  upload?: RequestDef;
  /** 核心：参考音频 → 音色 ID */
  clone?: RequestDef;
}

/** 实例的取值：`{ instance: {…}, requests: { "async.submit": {…} } }`（密钥也在里面，模板把它声明成 `valueType:'secret'`） */
export interface InstanceValues {
  instance?: Record<string, unknown>;
  requests?: Record<string, Record<string, unknown>>;
}

/**
 * 一条实例 = 一行 provider。
 * **没有任何内置字段**：baseUrl / apiKey / 模型 / 音色都是模板里声明出来的参数，
 * 取值统一在 `values` 里（`instance` 整实例共用、`requests[<请求>]` 按请求各存各的）。
 * 界面上 `valueType:'secret'` 的参数渲染成密码框，密钥就落在这份 JSON 里（只存本机，不进项目文件）。
 */
export interface InstanceDef {
  id: string;
  /** 用哪一份模板 */
  tplId: string;
  name: string;
  /** 走同步还是异步 */
  sync: boolean;
  values: InstanceValues;
}

/**
 * 一个文件值 —— 调用端给文件时交的就是这个形状（不是裸字节）。
 * 有了 `mime`，模板才谈得上注入：`data:<mime>;base64,…` 与 multipart 分片都要它。
 */
export interface FileValue { bytes: Uint8Array; mime: string; name?: string }

export const isFileValue = (v: unknown): v is FileValue =>
  !!v && typeof v === 'object' && (v as FileValue).bytes instanceof Uint8Array && typeof (v as FileValue).mime === 'string';

const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(s);
};
/** 文件 → 纯 base64（`${它.base64}`） */
export const fileBase64 = (f: FileValue): string => b64(f.bytes);
/** 文件 → data URI（`${它}`、`${它.dataUri}`：直接克隆那类要的形状） */
export const fileDataUri = (f: FileValue): string => `data:${f.mime};base64,${fileBase64(f)}`;
/** 文件值上能被 `${它.什么}` 取到的名字 */
const FILE_FIELD = (f: FileValue, what: string): unknown =>
  what === 'mime' ? f.mime : what === 'name' ? f.name : what === 'base64' ? fileBase64(f) : what === 'dataUri' ? fileDataUri(f) : undefined;

/** 求值后的请求 */
export interface ResolvedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  /** multipart 表单：字符串是普通字段，文件值是那一个二进制分片（带自己的 mime 与文件名） */
  form?: Record<string, string | FileValue>;
  timeoutMs?: number;
}

export interface HttpResult {
  status: number;
  contentType?: string;
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
}

export interface Deps {
  send: (r: ResolvedRequest) => Promise<HttpResult>;
  fetchBytes: (url: string, headers?: Record<string, string>) => Promise<{ bytes: Uint8Array; mime?: string }>;
}

/** 引擎不依赖界面层：自带的标签类型这里只留 string（用户自定义的东西不做中英两份） */

export class EngineError extends Error {
  /** 带上游状态码，调度层才知道这条能不能重试（429 / 5xx 才重试） */
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** 引擎的 EngineError 带 status；调度层按鸭子类型取，免得为一次 instanceof 把两个模块绑死 */
function httpStatus(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
}

/**
 * 只重试「再试一次可能成」的错：限流与服务端故障。
 * 业务错（模型名不存在、参数非法）重试只是白烧配额；没带状态码的错（CORS、参数缺失）同理。
 */
export function retriable(e: unknown): boolean {
  const status = httpStatus(e);
  return status === 429 || (status !== undefined && status >= 500 && status < 600);
}

/**
 * **没有任何内置占位符**：`${baseUrl}` `${apiKey}` 都是模板 instanceParams 里声明出来的参数，
 * 取值落在实例的 values.instance；中间变量（taskId / artifact / voiceId）靠 outputs 流转，也不进声明表。
 * 于是"这一份模板要人填什么"只有一处答案 —— 模板本身，界面照它渲染，密钥那几条渲染成密码框。
 */
export function secretKeysOf(tpl: TemplateDef, reqKey: ReqKey): string[] {
  const req = requestOf(tpl, reqKey);
  return [...(tpl.instanceParams ?? []), ...(req?.requestParams ?? [])]
    .filter((p) => p.valueType === 'secret')
    .map((p) => p.key);
}

/** 页签与校验都按**调用顺序**排：上传 → 克隆 → 提交 → 查询 */
export const REQ_KEYS: ReqKey[] = ['upload', 'clone', 'sync.submit', 'async.submit', 'async.query'];

export const CATEGORY_LABEL: Record<Category, string> = { llm: '文案生成', tts: '语音', image: '图片' };

/**
 * 产物 / 上传回来的引用，全项目只有这一个名字 —— 引擎按它找产物。
 * 它以前叫 `fileRef`：那阵子「产物形式」也占着 `artifact` 这个名字，两个不同的东西撞名，
 * 于是改叫 fileRef 躲开。现在产物形式挪到**每一格**上（`artifactForm`），这里就回到 `artifact` —— 与界面那行「产物」同名。
 */
export const ARTIFACT_KEY = 'artifact';

/**
 * 交进来的那一个文件，全项目只有这一个名字 —— 与固定返回项 `artifact`（产物 / 上传回来的引用）对偶：
 * 一个是「这一步现场交进来的文件」，一个是「那一步交回去的文件 / 地址」。
 * **它不是模板声明的参数**：三种接法用的都是同一个文件，所以不让人重复声明，界面上也没有
 * 「要传的文件」那张表 —— 表单里写 `${voiceData}` 就是那个二进制分片，JSON 体里写它就是 data URI。
 */
export const VOICE_FILE_KEY = 'voiceData';

// ========== 能力开关 → 槽位与承重输出（唯一推导处） ==========

/**
 * 参考音频的接法。**没选过时按 `base64` 算**（千问那类，也是 seed 用的那份）——
 * 这一句只写一次，界面与推导都读它，不在两处各写一个兜底。
 */
export const cloneViaOf = (tpl: TemplateDef): CloneVia => tpl.caps.cloneVia ?? 'base64';

/** 这一份模板该有哪些接口槽 —— 由 caps 推出来，不是让人一条条加 */
export function slotsOf(tpl: TemplateDef): ReqKey[] {
  const c = tpl.caps;
  const out: ReqKey[] = [];
  if (c.modes !== 'async') out.push('sync.submit');
  if (c.modes !== 'sync') out.push('async.submit', 'async.query');
  if (tpl.category === 'tts' && c.clone) {
    // 只有「先单独上传拿文件引用」这一种接法需要多一格；另两种都是文件直接进克隆那一条
    if (cloneViaOf(tpl) === 'upload') out.push('upload');
    out.push('clone');
  }
  return REQ_KEYS.filter((k) => out.includes(k));
}

/**
 * 这一格发的是 multipart 表单还是 JSON 体 —— 界面摆哪一格、校验查哪一格、新建草稿给什么形状、真发什么，全读这一处。
 * 判据是 caps，不是槽名：上传那一格恒为表单，而克隆那一格跟着 `cloneVia` 变（form 时它发的是文件分片）。
 */
export function multipartSlotOf(tpl: TemplateDef, key: ReqKey): boolean {
  if (key === 'upload') return true;
  return key === 'clone' && cloneViaOf(tpl) === 'form';
}

/** 某个槽必须交出的字段：名字写死、界面只能填路径。`required:false` = 建议项（不填错误信息会退化） */
export interface OutputSpec { name: string; label: string; hint: string; required: boolean }

/** 这一格的产物形式（没填 = 这一格没有产物）——「产物怎么变成字节」的唯一答案 */
export function artifactFormOf(tpl: TemplateDef, key: ReqKey): ArtifactEncoding {
  return requestOf(tpl, key)?.artifactForm ?? 'none';
}

/** 这一格的产物要不要从响应的某个字段里取（`bin` = 响应体本身，`none` = 没有产物：这两档都没有那一格） */
const artifactFromField = (form: ArtifactEncoding) => form !== 'none' && form !== 'binary';

export function requiredOutputsOf(tpl: TemplateDef, key: ReqKey): OutputSpec[] {
  const err: OutputSpec[] = [
    { name: 'error', label: '错误信息', hint: '上游报的原文，界面直接显示它', required: false },
    { name: 'errorCode', label: '错误码', hint: '和错误信息拼在一起，方便对文档查', required: false },
  ];
  const form = artifactFormOf(tpl, key);
  // 产物这一项只在该格「要从响应里某个字段取产物」时才存在：bin 用响应体本身，none 干脆没产物
  const artifact: OutputSpec[] =
    !artifactFromField(form) ? [] :
      [{ name: ARTIFACT_KEY, label: '产物', hint: form === 'url' ? '图片或音频的下载地址（带时效，当场下载）' : '图片或音频的字节所在字段', required: true }];
  switch (key) {
    case 'sync.submit':
      return tpl.category === 'llm'
        ? [{ name: 'content', label: '生成的文本', hint: '引擎只认这个名字', required: true }, ...err]
        : [...artifact, ...err];
    case 'async.submit':
      return [{ name: 'taskId', label: '任务号', hint: '交给调度器存着，之后拿它去查', required: true }, ...err];
    case 'async.query':
      return [
        { name: 'status', label: '任务状态', hint: '没取到它就一直算「还在跑」，查到次数上限才失败', required: true },
        ...artifact, ...err,
      ];
    case 'upload':
      // 上传交回来的引用不靠模板写名字：引擎把它注入成下一步的 ${voiceData}
      return [{ name: ARTIFACT_KEY, label: '文件地址 / 文件号', hint: `下一步建音色要用它：引擎把它注入成 \${${VOICE_FILE_KEY}}，克隆那一格写这个名就行`, required: true }, ...err];
    case 'clone':
      return [{ name: 'voiceId', label: '音色 ID', hint: '存进音色账本，绑这条实例与目标模型', required: true }, ...err];
  }
}

/** 这一格该不该出现（界面与校验共用；不再让 supports 读槽位、引擎读开关） */
export function supportsOf(tpl: TemplateDef, key: 'clone' | 'upload' | 'async'): boolean {
  const slots = tpl ? slotsOf(tpl) : [];
  return key === 'async' ? slots.includes('async.submit') : slots.includes(key);
}

// ========== 请求定位 ==========

export function requestOf(tpl: TemplateDef, key: ReqKey): RequestDef | undefined {
  switch (key) {
    case 'sync.submit': return tpl.sync?.submit;
    case 'async.submit': return tpl.async?.submit;
    case 'async.query': return tpl.async?.query;
    case 'upload': return tpl.upload;
    case 'clone': return tpl.clone;
  }
}

/** 实例的同步 / 异步开关决定用哪条提交接口（模板本身不参与判断） */
export function submitKeyOf(sync: boolean): ReqKey {
  return sync ? 'sync.submit' : 'async.submit';
}

/**
 * 这条实例真会走到的那几格：模板两套都配了，实例也只吃自己那一侧（上传 / 克隆与这一选无关）。
 * 早先配置页把 REQ_KEYS 整个铺出来，于是「千问 文生图」那条同步实例下面同时挂着「提交」「查询」
 * 两组格子 —— 异步那两组它这辈子都不会读，填了也没消费者。
 */
export function usedSlotsOf(tpl: TemplateDef, inst: InstanceDef): ReqKey[] {
  const side = new Set<ReqKey>(inst.sync ? ['sync.submit'] : ['async.submit', 'async.query']);
  return slotsOf(tpl).filter((k) => !k.includes('.') || side.has(k));
}

/** 这一格引用了哪些名字（按出现顺序去重；`${它.mime}` 记作 `它`）—— 只扫真发出去的那部分内容 */
function referencedIn(def: RequestDef, multipart: boolean): string[] {
  const out: string[] = [];
  const scan = (node: unknown) => {
    if (typeof node === 'string') {
      for (const m of node.matchAll(new RegExp(WHOLE.source, 'g'))) out.push(m[1].split('.')[0]);
      for (const m of node.matchAll(EMBED)) out.push(m[1].split('.')[0]);
      return;
    }
    if (Array.isArray(node)) node.forEach(scan);
    else if (node && typeof node === 'object') Object.values(node).forEach(scan);
  };
  scan(def.path); scan(def.headers);
  if (multipart) scan(def.form); else scan(def.body);
  return [...new Set(out)];
}

/**
 * 这一格要「现场给值」的参数 = 引用到了、但实例与默认值都没给来源的名字。
 * 声明只有一张表，谁在调用时给不用另外标 —— 从占位符反推（试调用与调用页据此长控件）。
 * `${voiceData}` 也算一个：它是引擎注入的那个文件，界面上因此长文件选择框
 * （先上传那类从「克隆」这一格试发时也要它 —— 试调用跑的是整条链）。
 */
export function openKeysOf(tpl: TemplateDef, inst: InstanceDef, key: ReqKey): string[] {
  const def = requestOf(tpl, key);
  if (!def) return [];
  const s = scopeOf(tpl, inst, key, {}, {});
  return referencedIn(def, multipartSlotOf(tpl, key)).filter((n) => !(n in s.values));
}

/** 这一格声明的参数（实例设置页按格分区渲染） */
export function requestParamsOf(tpl: TemplateDef, key: ReqKey): ParamSpec[] {
  return requestOf(tpl, key)?.requestParams ?? [];
}

/** 参数的显示名：模板声明了 label 就用它，否则退回 key —— 界面上不该露一排裸英文变量名 */
export function paramLabelOf(tpl: TemplateDef, reqKey: ReqKey, paramKey: string): string {
  const def = requestOf(tpl, reqKey);
  const spec = [...(def?.requestParams ?? []), ...(tpl.instanceParams ?? [])].find((p) => p.key === paramKey);
  return spec?.label || paramKey;
}

/** 整份模板的实例级参数（密钥那三个走 provider 的具名列，不在这里重复） */
export const instanceParamsOf = (tpl: TemplateDef): ParamSpec[] => tpl.instanceParams ?? [];

// ========== 取值 ==========

/** 路径支持 `output.a[0].b`；不以 `$` 开头就补上，与上游文档逐字一致 */
export function readPath(doc: unknown, rel: string): unknown {
  if (!rel) return undefined;
  const path = rel.startsWith('$') ? rel : `$.${rel}`;
  try {
    const got = JSONPath({ path, json: doc as object, resultType: 'value' }) as unknown[];
    if (!Array.isArray(got) || !got.length) return undefined;
    return got.length === 1 ? got[0] : got;
  } catch {
    return undefined;
  }
}

/** 按 outputs 声明从响应里取一批中间变量 */
export function applyOutputs(doc: unknown, outputs?: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, rel] of Object.entries(outputs ?? {})) {
    const v = readPath(doc, rel);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/**
 * 参数声明的 valueType 落到实际值：控件给的是字符串，进请求体前按声明成形。
 * 未识别的键（界面里手打的 `${x}`）原样传出去，交给「未声明占位符」那条校验点名。
 */
function castParam(spec: ParamSpec | undefined, raw: unknown): unknown {
  if (raw === undefined || raw === null) return raw;
  const t = spec?.valueType;
  if (typeof raw !== 'string') return raw;
  if (t === 'number') return raw === '' ? raw : Number(raw);
  if (t === 'boolean') return raw === 'true';
  if (t === 'json') { try { return JSON.parse(raw); } catch { return raw; } }
  return raw;
}

/** 一次求值的作用域：调用参数 > 上游 outputs > 请求级 > 实例级 > 声明的 defaultValue > 内置 */
export interface Scope {
  values: Record<string, unknown>;
  /** 三层声明 + outputs 产出 + 内置字段的合集：在里面就说明是「可选参数没给值」，不是写错 */
  declared: Set<string>;
  /** 引用了但**任何地方都没声明**的名字 —— 只可能是占位符打错字，预览与校验要点名 */
  missing: Set<string>;
}

export function scopeOf(
  tpl: TemplateDef,
  inst: InstanceDef,
  reqKey: ReqKey,
  callArgs: Record<string, unknown> = {},
  upstream: Record<string, unknown> = {},
): Scope {
  const req = requestOf(tpl, reqKey);
  const specs = new Map<string, ParamSpec>();
  for (const p of tpl.instanceParams ?? []) specs.set(p.key, p);
  for (const p of req?.requestParams ?? []) specs.set(p.key, p);

  const values: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => { if (v !== undefined) values[k] = castParam(specs.get(k), v); };

  // 先铺声明里的默认值，再逐层往上覆盖
  for (const p of [...(tpl.instanceParams ?? []), ...(req?.requestParams ?? [])]) {
    if (p.defaultValue !== undefined) put(p.key, p.defaultValue);
  }
  // 实例级取值（含 baseUrl / 密钥）
  for (const [k, v] of Object.entries(inst.values.instance ?? {})) put(k, v);
  // 请求级取值（同名 key 在不同请求下各存各的：同步与异步的 model 可以不一样）
  for (const [k, v] of Object.entries(inst.values.requests?.[reqKey] ?? {})) put(k, v);
  // 上游 outputs
  for (const [k, v] of Object.entries(upstream)) put(k, v);
  // 调用参数最高
  for (const [k, v] of Object.entries(callArgs)) put(k, v);

  const declared = new Set<string>([...specs.keys(), ...Object.keys(upstream)]);
  return { values, declared, missing: new Set<string>() };
}

// ========== 求值 ==========

const WHOLE = /^\$\{([A-Za-z_][A-Za-z0-9_.]*)\}$/;
const EMBED = /\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g;

/**
 * 取一个占位符的值：整名命中最直接；`它.什么` 只认文件值的那几个派生字段
 * （`${voiceData}` 是 data URI，`${voiceData.mime}` 是 audio/x-wav —— 上传与克隆两类接口都要把 mime 注进去）。
 */
function lookup(s: Scope, name: string): { found: boolean; value?: unknown } {
  if (name in s.values) return { found: true, value: s.values[name] };
  const dot = name.indexOf('.');
  if (dot > 0) {
    const root = s.values[name.slice(0, dot)];
    if (isFileValue(root)) return { found: true, value: FILE_FIELD(root, name.slice(dot + 1)) };
  }
  return { found: false };
}

/** 递归求值：返回 undefined 表示「这个键 / 这个元素应当删掉」（没给值就不把空键发给上游） */
function walk(node: unknown, s: Scope): unknown {
  if (typeof node === 'string') {
    const whole = WHOLE.exec(node);
    if (whole) {
      const name = whole[1];
      const got = lookup(s, name);
      if (got.found) return got.value;
      // 声明过 → 只是这个可选参数没填：删键；没声明 → 十有八九是占位符写错，点名
      if (!s.declared.has(name.split('.')[0])) s.missing.add(name);
      return undefined;
    }
    if (!node.includes('${')) return node;
    return node.replace(EMBED, (_m, name: string) => {
      const got = lookup(s, name);
      if (!got.found) {
        if (!s.declared.has(name.split('.')[0])) s.missing.add(name);
        return '';
      }
      const v = got.value;
      if (isFileValue(v)) return fileDataUri(v);
      return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
    });
  }
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const item of node) {
      const v = walk(item, s);
      if (v !== undefined) out.push(v);
    }
    // 原本有内容、结果全被省略 → 连这个数组一起删（不留空数组给上游挑理）
    return node.length > 0 && out.length === 0 ? undefined : out;
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const rv = walk(v, s);
      if (rv !== undefined) out[k] = rv;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return node;
}

/**
 * JSON 体里的文件值一律换成 data URI —— 只有 multipart 那一格保留成文件（它要的是分片本身）。
 * 于是 `${voiceData}` 在 body 里是 `data:audio/x-wav;base64,…`，在 form 里是那个二进制分片。
 */
function inlineFiles(node: unknown): unknown {
  if (isFileValue(node)) return fileDataUri(node);
  if (Array.isArray(node)) return node.map(inlineFiles);
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([k, v]) => [k, inlineFiles(v)]));
  }
  return node;
}

/** 求值成一条可发出的请求（不发送；预览与发送共用这一份） */
export function buildRequest(
  tpl: TemplateDef,
  inst: InstanceDef,
  reqKey: ReqKey,
  callArgs: Record<string, unknown> = {},
  upstream: Record<string, unknown> = {},
): { req: ResolvedRequest; missing: Set<string> } {
  const def = requestOf(tpl, reqKey);
  if (!def) throw new EngineError(`模板「${tpl.name}」没有 ${reqKey} 这条请求`);
  const s = scopeOf(tpl, inst, reqKey, callArgs, upstream);
  const headers: Record<string, string> = {};
  // 请求头逐条请求各配一份：认证头家家一样是巧合不是约定，而异步开关头只有提交那条要
  // （早先整份模板共用一份，同步端点也被塞了那个头）。
  for (const [k, v] of Object.entries(def.headers ?? {})) {
    const rv = walk(v, s);
    if (rv !== undefined && rv !== '') headers[k] = isFileValue(rv) ? fileDataUri(rv) : String(rv);
  }
  const url = String(walk(def.path, s) ?? '');
  // 一格只发一种内容：发表单的格不会同时塞一份 JSON 体（反过来也一样）——
  // 换 `cloneVia` 时另一格里留着的内容就地失效，界面上也不摆那一格（判据同为 multipartSlotOf）
  const multipart = multipartSlotOf(tpl, reqKey);
  const body = multipart || def.body === undefined ? undefined : inlineFiles(walk(structuredClone(def.body), s));
  const form: Record<string, string | FileValue> = {};
  if (multipart) {
    for (const [k, v] of Object.entries(def.form ?? {})) {
      const rv = walk(v, s);
      // 文件值在这一格保持成文件（传输层要拿它的字节与 mime 去拼 multipart 分片）
      if (typeof rv === 'string') form[k] = rv;
      else if (isFileValue(rv)) form[k] = rv;
    }
  }
  return {
    req: {
      method: (def.method ?? 'POST').toUpperCase(),
      url: url.startsWith('http') ? url : `${String(s.values.baseUrl ?? '').replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`,
      headers,
      body: body && Object.keys(body).length ? body : undefined,
      form: Object.keys(form).length ? form : undefined,
      // 超时只有实例级那一份（模板把它声明成一条实例参数）—— 槽上那一格从来没有生产者
      timeoutMs: numberValue(s.values.timeoutMs),
    },
    missing: s.missing,
  };
}

const numberValue = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : undefined);

/**
 * 这份模板声明成 secret 的参数，在这个实例里的实际取值（打码用）。
 * **按声明认，不按长度猜** —— 否则 baseUrl 这种长值会被遮成"密钥"，而真密钥短一点反而漏遮。
 */
export function secretsOf(tpl: TemplateDef, inst: InstanceDef): string[] {
  const keys = new Set<string>();
  for (const k of secretKeysOf(tpl, 'sync.submit')) keys.add(k);
  for (const key of REQ_KEYS) for (const k of secretKeysOf(tpl, key)) keys.add(k);
  return [...keys].map((k) => inst.values.instance?.[k]).filter((v): v is string => typeof v === 'string' && !!v);
}

/** GET 不带体；有 form 时交给传输层拼 multipart */
export function hasBody(r: ResolvedRequest): boolean {
  return r.method !== 'GET' && (r.body !== undefined || r.form !== undefined);
}

/** 密钥打码：预览与日志都走这里，长度留着（对不上 Key 长度时一眼能看出来） */
const mask = (s: string) => `${s.slice(0, 2)}****（长度 ${s.length}）`;

export function redactUrl(url: string, secrets: string[]): string {
  let out = url;
  for (const s of secrets) if (s) out = out.split(s).join(mask(s));
  return out;
}

/** 整条请求打码后的副本（「预览请求」面板用，绝不回显 Key 原文） */
export function redact(r: ResolvedRequest, secrets: string[]): ResolvedRequest {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.headers)) {
    headers[k] = secrets.some((s) => s && v.includes(s)) ? v.replace(/(Bearer |bearer )?\S*$/, '$1****') : v;
  }
  // 文件值不能整个序列化（几 MB 字节会糊满预览框），只留「这是什么文件」
  const form: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r.form ?? {})) {
    form[k] = isFileValue(v) ? { mime: v.mime, name: v.name, bytes: `${v.bytes.length} 字节` } : v;
  }
  return { ...r, url: redactUrl(r.url, secrets), headers, form: Object.keys(form).length ? form as ResolvedRequest['form'] : r.form };
}

// ========== 状态判定 ==========

export type Outcome = 'success' | 'failed' | 'pending';

/** 只配成功与失败：没命中两个列表就是「继续查」，多一种状态就少一格要填 */
export function classify(raw: unknown, successValues?: string[], failureValues?: string[]): Outcome {
  const v = String(raw ?? '').trim();
  if ((successValues ?? []).some((s) => s.toLowerCase() === v.toLowerCase())) return 'success';
  if ((failureValues ?? []).some((s) => s.toLowerCase() === v.toLowerCase())) return 'failed';
  return 'pending';
}

/**
 * 上游错误原样带回来，界面不做二次翻译（否则查不到根因）。
 * 状态码本身不算错：产物可能压根不在 JSON 里（binary），由调用方按情况判。
 */
export function errorOf(values: Record<string, unknown>, res: HttpResult): string | null {
  const text = String(values.error ?? '').trim();
  const code = String(values.errorCode ?? '').trim();
  if (!text && !code) return res.status >= 400 ? `HTTP ${res.status}${res.text ? ` · ${res.text.slice(0, 200)}` : ''}` : null;
  return [code, text].filter(Boolean).join(' · ');
}

// ========== 产物还原 ==========

function hexToBytes(s: string): Uint8Array {
  const clean = s.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 把响应变成字节：`binary` 直接就是响应体；hex / base64 从 `artifact` 那一格取；
 * `url` 当场下载（时效链接绝不留到以后）。产物在哪个字段由模板的固定项 `artifact` 决定 ——
 * **只有这一个名字**，以前那串 `audio ?? image ?? url ?? resultUrl ?? fileUrl` 是同一条事实的五份真相。
 */
export async function toBytes(
  res: HttpResult,
  format: ArtifactFormat,
  values: Record<string, unknown>,
  deps: Deps,
): Promise<{ bytes: Uint8Array; mime?: string; viaUrl?: string }> {
  if (!format || format === 'binary') {
    if (res.bytes) return { bytes: res.bytes, mime: res.contentType };
    throw new EngineError('上游没回字节流，但这一步按「响应体即产物」配置');
  }
  const raw = values[ARTIFACT_KEY];
  if (typeof raw !== 'string' || !raw) {
    // 把实际取到的槽位点名 —— 九成是模板的产物路径写错了，不列出来就只能瞎猜
    const got = Object.entries(values).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 40) : JSON.stringify(v)}`);
    throw new EngineError(`产物取不到（产物形式=${format}，但固定项「产物」没取到值；这一步取到的是：${got.join('、') || '什么都没有'}）`);
  }
  if (format === 'hex') return { bytes: hexToBytes(raw) };
  if (format === 'base64') return { bytes: b64ToBytes(raw) };
  const got = await deps.fetchBytes(raw);
  return { bytes: got.bytes, mime: got.mime, viaUrl: raw };
}

// ========== 执行（同步一把梭 / 异步分两步给调度器） ==========

export interface Step { key: ReqKey; url: string; status: number; values: Record<string, unknown> }

export interface RunResult {
  values: Record<string, unknown>;
  bytes?: Uint8Array;
  mime?: string;
  /** 异步提交后交回给调度器的东西 */
  taskId?: string;
  steps: Step[];
}

async function http(tpl: TemplateDef, inst: InstanceDef, key: ReqKey, deps: Deps, callArgs: Record<string, unknown>, upstream: Record<string, unknown>) {
  const { req, missing } = buildRequest(tpl, inst, key, callArgs, upstream);
  if (missing.size) throw new EngineError(`这些占位符没有任何来源给值：${[...missing].map((m) => `\${${m}}`).join('、')}`);
  const res = await deps.send(req);
  const doc = res.json ?? (res.bytes ? undefined : res.text);
  const values = applyOutputs(doc, requestOf(tpl, key)?.outputs);
  return { req, res, values };
}

/** 同步：提交 → 按**这一格的产物形式**还原产物（`url` 就是当场下载，不再多一问） */
export async function runSync(
  tpl: TemplateDef, inst: InstanceDef, deps: Deps,
  key: ReqKey, callArgs: Record<string, unknown> = {}, upstream0: Record<string, unknown> = {},
): Promise<RunResult> {
  const steps: Step[] = [];
  const up = { ...upstream0 };
  const first = await http(tpl, inst, key, deps, callArgs, up);
  Object.assign(up, first.values);
  steps.push({ key, url: redact(first.req, secretsOf(tpl, inst)).url, status: first.res.status, values: first.values });
  const err = errorOf(first.values, first.res);
  if (err) throw new EngineError(err, first.res.status);

  let bytes: Uint8Array | undefined;
  let mime: string | undefined;
  const enc = artifactFormOf(tpl, key);
  if (enc !== 'none') {
    const got = await toBytes(first.res, enc, first.values, deps);
    bytes = got.bytes; mime = got.mime;
  }
  return { values: up, bytes, mime, steps };
}

/** 异步第一步：提交，拿中间变量（taskId 之类）交给调度器存 */
export async function submitAsync(
  tpl: TemplateDef, inst: InstanceDef, deps: Deps, callArgs: Record<string, unknown> = {}, upstream0: Record<string, unknown> = {},
): Promise<RunResult> {
  const got = await http(tpl, inst, 'async.submit', deps, callArgs, upstream0);
  const err = errorOf(got.values, got.res);
  if (err) throw new EngineError(err, got.res.status);
  const taskId = String(got.values.taskId ?? '');
  // 没有「取第一个值当任务号」这种兜底了：任务号取不到就是模板没填固定项，问下去也没法查
  if (!taskId) {
    const got2 = Object.keys(got.values).join('、') || '什么都没有';
    throw new EngineError(`异步提交没交出任务号（固定项「任务号」的路径没填或取不到；这一步取到的是：${got2}）`);
  }
  return {
    values: got.values,
    taskId,
    steps: [{ key: 'async.submit', url: redact(got.req, secretsOf(tpl, inst)).url, status: got.res.status, values: got.values }],
  };
}

/** 异步第二步：查一次，命中成功就把产物取回来 */
export async function queryOnce(
  tpl: TemplateDef, inst: InstanceDef, deps: Deps, upstream: Record<string, unknown>,
): Promise<{ outcome: Outcome; status?: string; values: Record<string, unknown>; bytes?: Uint8Array; mime?: string; step: Step }> {
  const q = requestOf(tpl, 'async.query')!;
  const got = await http(tpl, inst, 'async.query', deps, {}, upstream);
  const values = { ...upstream, ...got.values };
  const step: Step = { key: 'async.query', url: redact(got.req, secretsOf(tpl, inst)).url, status: got.res.status, values: got.values };
  if (got.res.status >= 500 || got.res.status === 429) throw new EngineError(`查询接口 HTTP ${got.res.status}`, got.res.status);
  const outcome = classify(got.values.status, q.successValues, q.failureValues);
  if (outcome === 'failed') throw new EngineError(errorOf(got.values, got.res) ?? '上游报失败', got.res.status);
  if (outcome !== 'success') return { outcome, status: String(got.values.status ?? ''), values, step };

  let bytes: Uint8Array | undefined;
  let mime: string | undefined;
  const enc = artifactFormOf(tpl, 'async.query');
  if (enc !== 'none') {
    const got2 = await toBytes(got.res, enc, values, deps);
    bytes = got2.bytes; mime = got2.mime;
  }
  return { outcome, status: String(got.values.status ?? ''), values, bytes, mime, step };
}

/**
 * 建音色：三种接法在模板里写的都是同一个 `${voiceData}` ——
 * `upload` 那类先跑上传那一格（文件交给它），再把上传交回的引用**注入成下一步的 `${voiceData}`**，
 * 所以克隆那一格不用知道自己吃的是文件、地址还是文件号；另两种接法只跑第二步。
 */
export async function runClone(
  tpl: TemplateDef, inst: InstanceDef, deps: Deps, callArgs: Record<string, unknown>,
): Promise<RunResult> {
  const steps: Step[] = [];
  const up: Record<string, unknown> = {};
  let nextArgs = callArgs;
  if (slotsOf(tpl).includes('upload') && requestOf(tpl, 'upload')) {
    const up1 = await http(tpl, inst, 'upload', deps, callArgs, up);
    Object.assign(up, up1.values);
    steps.push({ key: 'upload', url: redact(up1.req, secretsOf(tpl, inst)).url, status: up1.res.status, values: up1.values });
    const e1 = errorOf(up1.values, up1.res);
    if (e1) throw new EngineError(e1, up1.res.status);
    const ref = up1.values[ARTIFACT_KEY];
    if (ref === undefined) throw new EngineError('上传那一格没交出文件引用 —— 检查它的固定项「文件地址 / 文件号」填的路径');
    nextArgs = { ...callArgs, [VOICE_FILE_KEY]: ref };
  }
  const cl = await http(tpl, inst, 'clone', deps, nextArgs, up);
  Object.assign(up, cl.values);
  steps.push({ key: 'clone', url: redact(cl.req, secretsOf(tpl, inst)).url, status: cl.res.status, values: cl.values });
  const err = errorOf(cl.values, cl.res);
  if (err) throw new EngineError(err, cl.res.status);
  return { values: up, steps };
}

// ========== 保存前自检（别把问题留到运行时） ==========

export function referencedVars(tpl: TemplateDef): { key: ReqKey; name: string }[] {
  const out: { key: ReqKey; name: string }[] = [];
  const scan = (key: ReqKey, node: unknown, declared: Set<string>) => {
    if (typeof node === 'string') {
      // `${它.mime}` 这类点号取的是文件值自己的字段，所以只按根名字判断有没有声明
      const root = (n: string) => n.split('.')[0];
      for (const m of node.matchAll(new RegExp(WHOLE.source, 'g'))) if (!declared.has(root(m[1]))) out.push({ key, name: m[1] });
      for (const m of node.matchAll(EMBED)) if (!declared.has(root(m[1]))) out.push({ key, name: m[1] });
      return;
    }
    if (Array.isArray(node)) node.forEach((x) => scan(key, x, declared));
    else if (node && typeof node === 'object') Object.values(node).forEach((x) => scan(key, x, declared));
  };
  const produced = new Set<string>();
  for (const key of REQ_KEYS) for (const name of Object.keys(requestOf(tpl, key)?.outputs ?? {})) produced.add(name);
  for (const key of REQ_KEYS) {
    const def = requestOf(tpl, key);
    if (!def) continue;
    const declared = new Set<string>([VOICE_FILE_KEY, ...produced]);
    for (const p of [...(tpl.instanceParams ?? []), ...(def.requestParams ?? [])]) declared.add(p.key);
    scan(key, def.path, declared);
    scan(key, def.headers, declared);
    // 与 buildRequest 同一条判据：这一格不发的那部分内容，引用的名字也不算问题
    if (multipartSlotOf(tpl, key)) scan(key, def.form, declared); else scan(key, def.body, declared);
  }
  return out;
}

/** 整份模板的问题清单；空数组 = 可用 */
/** 槽位的中文名：校验消息、界面标题、文档都用这一份（原先在两个组件里各写了一份） */
export const REQ_LABEL: Record<ReqKey, string> = {
  upload: '上传',
  clone: '克隆',
  'sync.submit': '同步 · 提交',
  'async.submit': '异步 · 提交',
  'async.query': '异步 · 查询',
};

export function validateTemplate(tpl: TemplateDef): string[] {
  const problems: string[] = [];
  const slots = slotsOf(tpl);
  if (tpl.category === 'llm' && (tpl.caps.clone || slots.some((k) => artifactFormOf(tpl, k) !== 'none'))) {
    problems.push('文案生成不该有产物或克隆开关（它只取一段文本）');
  }
  // 「该交回产物」的格就是终点那两格：同步提交、异步查询。产物形式逐格配，所以每一格各问一次
  if (tpl.category !== 'llm') {
    for (const key of slots.filter((k) => k === 'sync.submit' || k === 'async.query')) {
      if (artifactFormOf(tpl, key) === 'none') problems.push(`${REQ_LABEL[key]}：这一格该交回产物，「产物形式」别选「没有产物」`);
    }
  }
  // 那个文件是引擎注入的固定名（与 fileRef 对偶）：声明它 = 同一个 ${它} 有两个来源
  const injected = (where: string) => problems.push(`${where}：\`${VOICE_FILE_KEY}\` 是引擎注入的那个文件，不用声明 —— 表单或体里直接写 \${${VOICE_FILE_KEY}}`);
  if ((tpl.instanceParams ?? []).some((p) => p.key === VOICE_FILE_KEY)) injected('实例级参数');
  for (const key of slots) {
    const def = requestOf(tpl, key);
    if (!def) continue;
    if ((def.requestParams ?? []).some((p) => p.key === VOICE_FILE_KEY)) injected(REQ_LABEL[key]);
    if (Object.keys(def.outputs ?? {}).includes(VOICE_FILE_KEY)) injected(`${REQ_LABEL[key]} 的自定义变量`);
  }
  // 开关要求的槽：必须在、必须有地址、固定项必须填路径
  for (const key of slots) {
    const def = requestOf(tpl, key);
    if (!def) { problems.push(`${REQ_LABEL[key]}：能力开关要求这一格，但还没配`); continue; }
    if (!def.path?.trim()) problems.push(`${REQ_LABEL[key]}：没填地址`);
    // 上传那一格发出去的就是一张 multipart 表单 —— 表是空的等于什么都没传
    // 发 multipart 的那些格，表是空的等于什么都没交（文件也在那张表里引用）
    if (multipartSlotOf(tpl, key) && !Object.keys(def.form ?? {}).length) {
      problems.push(`${REQ_LABEL[key]}：这一格发的是 multipart 表单，字段一个都没写（要传的文件也在那张表里引用）`);
    }
    for (const o of requiredOutputsOf(tpl, key)) {
      if (o.required && !def.outputs?.[o.name]?.trim()) {
        problems.push(`${REQ_LABEL[key]}：固定项「${o.label}」没填路径 —— ${o.hint}`);
      }
    }
    // 反方向也要点名：产物形式选成「响应体就是产物 / 没有产物」时，那一格里填的产物路径没有消费者
    // （真发会拿 JSON 响应当音频用 —— 填了就说明想要的其实是 base64 / hex / url 那一档）
    if (!artifactFromField(artifactFormOf(tpl, key)) && def.outputs?.[ARTIFACT_KEY]?.trim()) {
      problems.push(`${REQ_LABEL[key]}：这一格的「产物形式」是「${artifactFormOf(tpl, key) === 'none' ? '没有产物' : 'bin（响应体即产物）'}」，不用从字段取产物 —— 「产物」那格填了路径说明档位选错了（要取链接该选 url）`);
    }
  }
  // 开关没要求的槽不该存在（否则就是开关与内容对不上，运行时按开关走、那一格永远用不到）
  for (const key of REQ_KEYS) {
    // 关开关不删内容（来回切不该把人填的弄没），于是这一格会变成界面上带 ⚠ 的孤儿格：
    // 要么把对应开关打开，要么在那一格里点「移除这一格」
    if (!slots.includes(key) && requestOf(tpl, key)) problems.push(`${REQ_LABEL[key]}：能力开关用不到这一格，把对应开关打开再关掉，会问你要不要移除这一格`);
  }
  if (slots.includes('async.query') && !(requestOf(tpl, 'async.query')?.successValues ?? []).length) {
    problems.push('异步查询：没配「算成功的状态值」，不知道查成什么样算完成');
  }
  const dup = new Map<string, number>();
  for (const p of tpl.instanceParams ?? []) dup.set(p.key, (dup.get(p.key) ?? 0) + 1);
  for (const [k, n] of dup) if (n > 1) problems.push(`实例级参数「${k}」重复声明了`);
  // 自定义变量与三层参数同名 = 同一个 ${x} 有两个来源，谁赢取决于调用时给没给值 —— 必须点名
  const declared = new Set<string>();
  for (const p of tpl.instanceParams ?? []) declared.add(p.key);
  for (const key of slots) {
    const def = requestOf(tpl, key);
    if (!def) continue;
    for (const p of [...(def.requestParams ?? [])]) declared.add(`${key}:${p.key}`);
    const fixed = new Set(requiredOutputsOf(tpl, key).map((o) => o.name));
    for (const name of Object.keys(def.outputs ?? {})) {
      if (fixed.has(name)) continue;
      if (declared.has(name) || declared.has(`${key}:${name}`) || (tpl.instanceParams ?? []).some((p) => p.key === name)) {
        problems.push(`${REQ_LABEL[key]}：自定义变量「${name}」与参数声明同名，同一个 \${${name}} 会有两个来源`);
      }
    }
  }
  const seen = new Set<string>();
  for (const { key, name } of referencedVars(tpl)) {
    const id = `${key}:\${${name}}`;
    if (seen.has(id)) continue;
    seen.add(id);
    problems.push(`${key} 引用了 \${${name}}，但没有任何来源给它（三层参数里都没有这个名字，也不是 outputs 的产出）`);
  }
  return problems;
}
