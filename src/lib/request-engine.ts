/**
 * request-engine.ts — 接口模板的求值与执行（「模板即数据」的那一半）
 *
 * 形状照 `docs/provider-engine.md`：一份模板 = 一行（同步 / 异步 / 桥接 / 克隆都在里面），
 * 参数分三层（实例级 / 请求级 / 调用级），占位符统一 `${x}`，中间变量靠 `outputs` 隐式流转。
 * **这里没有按厂商名写的分支**：三家的差异（认证头、taskId 在 path 还是 body、hex 还是 url、
 * 发音修正的数组形状）全部是模板里的数据。
 * 引擎不碰网络、不碰 DOM —— 传输由调用端注入 deps.send / deps.fetchBytes。
 */
import { JSONPath } from 'jsonpath-plus';

// ========== 类型 ==========

export type Category = 'llm' | 'tts' | 'image';
/** 请求在模板里的位置；界面与 values.requests 都用这个名字 */
export type ReqKey = 'sync.submit' | 'async.submit' | 'async.query' | 'download' | 'upload' | 'clone';
export type ValueType =
  | 'string' | 'text' | 'number' | 'boolean' | 'enum' | 'multiEnum' | 'array' | 'secret' | 'file' | 'json';
/** 产物封装方式：binary 响应体即产物 / hex / base64 / url 是带时效的链接 */
export type OutputFormat = 'binary' | 'hex' | 'base64' | 'url';

export interface OptionSpec { value: string | number | boolean; label?: string }

/**
 * 一条参数声明。名字 / 说明都是用户自填的单个字符串（自定义的东西没有自动翻这回事）。
 * `transform` 是**数据驱动的取值变换**，用来吃掉「同一条数据在不同厂商要变成不同形状」这类差异，
 * 免得引擎里长出 `if (厂商 === 'minimax')`。
 */
export interface ParamSpec {
  key: string;
  label?: string;
  valueType?: ValueType;
  required?: boolean;
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
  accept?: string;
  maxSize?: number;
  /**
   * hotFixArray：把 {pronunciation:[{词:音}]} / {replace:[{原:换}]} 摊成 ["词/音", …]
   * base64DataUri：文件字节 → `data:<mime>;base64,…`
   * json：字符串按 JSON 解析后再入体
   */
  transform?: 'hotFixArray' | 'base64DataUri' | 'json';
}

/** 一条请求（核心或桥接）。headers 只在模板顶层配一份，请求上只写需要覆盖的那几个 */
export interface RequestDef {
  /** 地址模板，`${x}` 随便写；查询参数直接拼在串上（各家 taskId 位置不同，写在这里就行） */
  path: string;
  method?: string;
  headers?: Record<string, unknown>;
  /** 请求级参数：这个请求专属（model / size…），取值存实例的 values.requests[<本 key>] */
  requestParams?: ParamSpec[];
  /** 调用级参数：每次调用由界面 / 程序给（text / prompt / file / hotFix…） */
  callParams?: ParamSpec[];
  body?: unknown;
  /** multipart 表单（上传参考音频用；file 值由引擎换成文件部分） */
  form?: Record<string, unknown>;
  /** 从响应里取字段：{ taskId: 'output.task_id' } —— 取出来的名字进作用域，下游 ${taskId} 直接用 */
  outputs?: Record<string, string>;
  outputFormat?: OutputFormat;
  /** 只有 query 用；中间态不配（没命中两个列表就继续查） */
  successValues?: string[];
  failureValues?: string[];
  timeoutMs?: number;
}

/** 一份完整模板 */
export interface TemplateDef {
  id: string;
  name: string;
  category: Category;
  /** 有没有克隆音色接口（仅 tts 用得上） */
  useClone?: boolean;
  /** 克隆前要不要先上传拿 fileId（false = 直接把音频 base64 塞进 body） */
  hasUpload?: boolean;
  headers?: Record<string, unknown>;
  /** 实例级参数声明：所有请求共用（超时 / 批次并发 / 查询节奏 / 音色失效信号…） */
  instanceParams?: ParamSpec[];
  sync?: { submit?: RequestDef };
  async?: { submit?: RequestDef; query?: RequestDef };
  /** 桥接：fileId → 最终下载地址（同步异步共用） */
  download?: RequestDef;
  /** 桥接：本地文件 → fileId */
  upload?: RequestDef;
  /** 核心：参考音频 → 音色 ID */
  clone?: RequestDef;
  /** 克隆参考音频要求采样率 Hz（CosyVoice 16k、Qwen-TTS ≥24k） */
  refSampleRateHz?: number;
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

/** 求值后的请求 */
export interface ResolvedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  form?: Record<string, string | Uint8Array>;
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
 * 取值落在实例的 values.instance；中间变量（taskId / fileId / voiceId）靠 outputs 流转，也不进声明表。
 * 于是"这一份模板要人填什么"只有一处答案 —— 模板本身，界面照它渲染，密钥那几条渲染成密码框。
 */
export function secretKeysOf(tpl: TemplateDef, reqKey: ReqKey): string[] {
  const req = requestOf(tpl, reqKey);
  return [...(tpl.instanceParams ?? []), ...(req?.requestParams ?? []), ...(req?.callParams ?? [])]
    .filter((p) => p.valueType === 'secret')
    .map((p) => p.key);
}

export const REQ_KEYS: ReqKey[] = ['sync.submit', 'async.submit', 'async.query', 'download', 'upload', 'clone'];

export const CATEGORY_LABEL: Record<Category, string> = { llm: '文案生成', tts: '语音', image: '图片' };

// ========== 请求定位 ==========

export function requestOf(tpl: TemplateDef, key: ReqKey): RequestDef | undefined {
  switch (key) {
    case 'sync.submit': return tpl.sync?.submit;
    case 'async.submit': return tpl.async?.submit;
    case 'async.query': return tpl.async?.query;
    case 'download': return tpl.download;
    case 'upload': return tpl.upload;
    case 'clone': return tpl.clone;
  }
}

/** 实例的同步 / 异步开关决定用哪条提交接口（模板本身不参与判断） */
export function submitKeyOf(sync: boolean): ReqKey {
  return sync ? 'sync.submit' : 'async.submit';
}

/** 这个请求要调用端给值的参数名（试调用与调用页据此长输入框） */
export function callKeysOf(tpl: TemplateDef, key: ReqKey): string[] {
  return (requestOf(tpl, key)?.callParams ?? []).map((p) => p.key);
}

/** 这个请求的请求级参数（实例设置页按请求分区渲染） */
export function requestParamsOf(tpl: TemplateDef, key: ReqKey): ParamSpec[] {
  return requestOf(tpl, key)?.requestParams ?? [];
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
 * 参数声明的 valueType / transform 落到实际值：控件给的是字符串，进请求体前按声明成形。
 * 未识别的键（界面里手打的 `${x}`）原样传出去，交给「未声明占位符」那条校验点名。
 */
function castParam(spec: ParamSpec | undefined, raw: unknown): unknown {
  if (raw === undefined || raw === null) return raw;
  const t = spec?.valueType;
  if (spec?.transform === 'json' && typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  if (spec?.transform === 'hotFixArray') return hotFixToArrays(raw);
  if (spec?.transform === 'base64DataUri') return raw;     // 调用端已给 data URI
  if (typeof raw !== 'string') return raw;
  if (t === 'number') return raw === '' ? raw : Number(raw);
  if (t === 'boolean') return raw === 'true';
  if (t === 'json') { try { return JSON.parse(raw); } catch { return raw; } }
  return raw;
}

/**
 * 发音修正 → 数组形状：`{词: "chong2 qing4"}` → `"词/chong2 qing4"`。
 * 千问要对象、MiniMax / 字节要这个数组 —— 差别只在模板里选不选这个 transform。
 */
export function hotFixToArrays(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const o = raw as Record<string, unknown>;
  const one = (arr: unknown) => (Array.isArray(arr) ? arr : arr ? [arr] : []);
  const tone = [
    ...one(o.pronunciation).flatMap((m) => Object.entries((m ?? {}) as object).map(([k, v]) => `${k}/${v}`)),
    ...one(o.replace).flatMap((m) => Object.entries((m ?? {}) as object).map(([k, v]) => `${k}/${v}`)),
  ];
  return tone.length ? tone : undefined;
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
  for (const p of req?.callParams ?? []) specs.set(p.key, p);

  const values: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => { if (v !== undefined) values[k] = castParam(specs.get(k), v); };

  // 先铺声明里的默认值，再逐层往上覆盖
  for (const p of [...(tpl.instanceParams ?? []), ...(req?.requestParams ?? []), ...(req?.callParams ?? [])]) {
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

/** 递归求值：返回 undefined 表示「这个键 / 这个元素应当删掉」（没给值就不把空键发给上游） */
function walk(node: unknown, s: Scope): unknown {
  if (typeof node === 'string') {
    const whole = WHOLE.exec(node);
    if (whole) {
      const name = whole[1];
      if (name in s.values) return s.values[name];
      // 声明过 → 只是这个可选参数没填：删键；没声明 → 十有八九是占位符写错，点名
      if (!s.declared.has(name)) s.missing.add(name);
      return undefined;
    }
    if (!node.includes('${')) return node;
    return node.replace(EMBED, (_m, name: string) => {
      if (!(name in s.values)) {
        if (!s.declared.has(name)) s.missing.add(name);
        return '';
      }
      const v = s.values[name];
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
  for (const [k, v] of Object.entries({ ...(tpl.headers ?? {}), ...(def.headers ?? {}) })) {
    const rv = walk(v, s);
    if (rv !== undefined && rv !== '') headers[k] = String(rv);
  }
  const url = String(walk(def.path, s) ?? '');
  const body = def.body === undefined ? undefined : walk(structuredClone(def.body), s);
  const form: Record<string, string | Uint8Array> = {};
  for (const [k, v] of Object.entries(def.form ?? {})) {
    const rv = walk(v, s);
    if (typeof rv === 'string') form[k] = rv;
    else if (rv instanceof Uint8Array) form[k] = rv;
  }
  return {
    req: {
      method: (def.method ?? 'POST').toUpperCase(),
      url: url.startsWith('http') ? url : `${String(s.values.baseUrl ?? '').replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`,
      headers,
      body: body && Object.keys(body).length ? body : undefined,
      form: Object.keys(form).length ? form : undefined,
      timeoutMs: def.timeoutMs ?? numberValue(s.values.timeoutMs),
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
  return { ...r, url: redactUrl(r.url, secrets), headers };
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
 * 把响应变成字节：`binary` 直接就是响应体；hex / base64 从某个字段取；url 当场下载（时效链接绝不留到以后）。
 * 产物在哪个字段由模板的 `outputs` 决定（audio / image / url 这些名字随各家）。
 */
export async function toBytes(
  res: HttpResult,
  format: OutputFormat | undefined,
  values: Record<string, unknown>,
  deps: Deps,
  downloadHeaders?: Record<string, string>,
): Promise<{ bytes: Uint8Array; mime?: string; viaUrl?: string }> {
  if (!format || format === 'binary') {
    if (res.bytes) return { bytes: res.bytes, mime: res.contentType };
    throw new EngineError('上游没回字节流，但这一步按「响应体即产物」配置');
  }
  const raw = values.audio ?? values.image ?? values.url ?? values.resultUrl ?? values.fileUrl;
  if (typeof raw !== 'string' || !raw) {
    // 把实际取到的槽位点名 —— 99% 是模板的产物路径写错了，不列出来就只能瞎猜
    const got = Object.entries(values).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 40) : JSON.stringify(v)}`);
    throw new EngineError(`产物取不到（outputFormat=${format}，但 outputs 里没音频 / 图片 / 链接；这一步取到的是：${got.join('、') || '什么都没有'}）`);
  }
  if (format === 'hex') return { bytes: hexToBytes(raw) };
  if (format === 'base64') return { bytes: b64ToBytes(raw) };
  const got = await deps.fetchBytes(raw, downloadHeaders);
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

/** 同步：提交 →（配了 download 桥接就再拿一次 URL）→ 还原产物 */
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
  const def = requestOf(tpl, key)!;
  if (def.outputFormat === 'url' && !tpl.download) {
    const got = await toBytes(first.res, 'url', first.values, deps);
    bytes = got.bytes; mime = got.mime;
  } else if (def.outputFormat && def.outputFormat !== 'url') {
    const got = await toBytes(first.res, def.outputFormat, first.values, deps);
    bytes = got.bytes; mime = got.mime;
  } else if (tpl.download) {
    const dl = await http(tpl, inst, 'download', deps, callArgs, up);
    Object.assign(up, dl.values);
    steps.push({ key: 'download', url: redact(dl.req, secretsOf(tpl, inst)).url, status: dl.res.status, values: dl.values });
    const dlErr = errorOf(dl.values, dl.res);
    if (dlErr) throw new EngineError(dlErr, dl.res.status);
    const got = await toBytes(dl.res, 'url', dl.values, deps);
    bytes = got.bytes; mime = got.mime;
  } else if (first.res.bytes) {
    bytes = first.res.bytes; mime = first.res.contentType;
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
  return {
    values: got.values,
    taskId: String(got.values.taskId ?? Object.values(got.values)[0] ?? ''),
    steps: [{ key: 'async.submit', url: redact(got.req, secretsOf(tpl, inst)).url, status: got.res.status, values: got.values }],
  };
}

/** 异步第二步：查一次，命中成功就把产物取回来（可能再走 download 桥接） */
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
  if (tpl.download && values.fileId !== undefined) {
    const dl = await http(tpl, inst, 'download', deps, {}, values);
    Object.assign(values, dl.values);
    const got2 = await toBytes(dl.res, 'url', dl.values, deps);
    bytes = got2.bytes; mime = got2.mime;
  } else {
    const got2 = await toBytes(got.res, q.outputFormat ?? 'url', values, deps);
    bytes = got2.bytes; mime = got2.mime;
  }
  return { outcome, status: String(got.values.status ?? ''), values, bytes, mime, step };
}

/** 上传 + 克隆：一体式的厂商直接把音频塞 body，分离式的先传拿 fileId */
export async function runClone(
  tpl: TemplateDef, inst: InstanceDef, deps: Deps, callArgs: Record<string, unknown>,
): Promise<RunResult> {
  const steps: Step[] = [];
  const up: Record<string, unknown> = {};
  if (tpl.hasUpload && requestOf(tpl, 'upload')) {
    const up1 = await http(tpl, inst, 'upload', deps, callArgs, up);
    Object.assign(up, up1.values);
    steps.push({ key: 'upload', url: redact(up1.req, secretsOf(tpl, inst)).url, status: up1.res.status, values: up1.values });
    const e1 = errorOf(up1.values, up1.res);
    if (e1) throw new EngineError(e1, up1.res.status);
  }
  const cl = await http(tpl, inst, 'clone', deps, callArgs, up);
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
      for (const m of node.matchAll(new RegExp(WHOLE.source, 'g'))) if (!declared.has(m[1])) out.push({ key, name: m[1] });
      for (const m of node.matchAll(EMBED)) if (!declared.has(m[1])) out.push({ key, name: m[1] });
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
    const declared = new Set<string>(produced);
    for (const p of [...(tpl.instanceParams ?? []), ...(def.requestParams ?? []), ...(def.callParams ?? [])]) declared.add(p.key);
    scan(key, def.path, declared);
    scan(key, def.headers, declared);
    scan(key, def.body, declared);
    scan(key, def.form, declared);
  }
  return out;
}

/** 整份模板的问题清单；空数组 = 可用 */
export function validateTemplate(tpl: TemplateDef): string[] {
  const problems: string[] = [];
  const need = tpl.category === 'llm' ? '文案生成必须有 sync.submit' : null;
  if (need && !tpl.sync?.submit) problems.push(need);
  if (tpl.category !== 'llm' && !tpl.sync?.submit && !tpl.async?.submit) problems.push('至少要配一条提交接口（同步或异步）');
  if (tpl.async?.submit && !tpl.async.query) problems.push('配了异步提交就必须配异步查询（async.query）');
  if (tpl.async?.query && !(tpl.async.query.successValues ?? []).length) problems.push('查询接口必须配 successValues（不知道查成什么样算完成）');
  if (tpl.useClone && !tpl.clone) problems.push('勾了「支持克隆音色」但没配 clone 请求');
  if (tpl.hasUpload && !tpl.upload) problems.push('勾了「克隆前先上传」但没配 upload 请求');
  for (const key of REQ_KEYS) {
    const def = requestOf(tpl, key);
    if (def && key !== 'async.query' && !def.path?.trim()) problems.push(`${key} 没填 path`);
  }
  const dup = new Map<string, number>();
  for (const p of tpl.instanceParams ?? []) dup.set(p.key, (dup.get(p.key) ?? 0) + 1);
  for (const [k, n] of dup) if (n > 1) problems.push(`实例级参数「${k}」重复声明了`);
  const seen = new Set<string>();
  for (const { key, name } of referencedVars(tpl)) {
    const id = `${key}:\${${name}}`;
    if (seen.has(id)) continue;
    seen.add(id);
    problems.push(`${key} 引用了 \${${name}}，但没有任何来源给它（三层参数里都没有这个名字，也不是 outputs 的产出）`);
  }
  return problems;
}

/** 实例是否配齐到能发出去（缺 baseUrl / Key 时界面要说话，别只让请求炸） */
export function missingOfInstance(tpl: TemplateDef, inst: InstanceDef, key: ReqKey): string[] {
  const need: string[] = [];
  const def = requestOf(tpl, key);
  if (!def) return [`${key} 这条请求模板里没有`];
  const given = scopeOf(tpl, inst, key, {}, {});
  const has = (n: string) => n in given.values;
  for (const p of [...(tpl.instanceParams ?? []), ...(def.requestParams ?? [])]) {
    // 有默认值或可选的就不催；催的只是「非填不可、又没给值」的那些
    if (p.required === false || p.defaultValue !== undefined || has(p.key)) continue;
    need.push(`参数「${p.label || p.key}」没填`);
  }
  return need;
}
