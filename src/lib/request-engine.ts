/**
 * request-engine.ts — 模板求值引擎（纯函数 + 可注入传输，离线可单测）
 *
 * 一份数据描述「一个接口怎么发、返回从哪取」，双端共用，代码里没有协议分支。
 * 设计见 docs/provider-engine.md；本文件不碰网络、不碰 DOM、不 import store。
 *
 * 求值规则刻意做小：
 *   {name}   独占一个标量 → 整段替换、保留原类型；在字符串内部 → 插值
 *   {@name}  只能独占一个值位 → 整段展开（数组/对象/数字类型全保留）
 * 没有循环、没有表达式语言，只有 `when: "a == b"` 等值门控与 omitIfEmpty ——
 * 模板里一旦能写程序，出错时看模板就看不出实际发了什么，「试调用」也就失去意义。
 */
import type { L } from './i18n';

/** 引擎不依赖界面层：自检信息一律取中文那一份（L = string | {zh,en}） */
const zh = (l: L | undefined): string => (l == null ? '' : typeof l === 'string' ? l : l.zh);

// ========== 类型 ==========

export type ProviderKind = 'llm' | 'tts' | 'image';
/** 组内用途；kind 已在组上，所以这里不带前缀 */
export type Role = 'generate' | 'synthesize' | 'query' | 'clone';
export type Mode = 'sync' | 'async';
export type VarType = 'int' | 'string' | 'bool' | 'list' | 'json';
/** instance = 建实例时填（进实例页参数表）；call = 调用时传（界面只读展示） */
export type VarStage = 'instance' | 'call';

export interface VarOption {
  value: string | number | boolean;
  /** 省略则显示 value；只有 value 会进请求体 */
  label?: L;
}

export interface VarSpec {
  name: string;
  stage: VarStage;
  type?: VarType;
  label?: L;
  default?: string | number | boolean;
  /** 有 options 就用选项块；bool 隐含两个选项，不必写 */
  options?: (VarOption | string | number | boolean)[];
  /** true → 选项块旁再给输入框（默认 false：宁可显式加候选，也不放开门让上游报错教人） */
  allowCustom?: boolean;
  /** 没给值时连父键一起删（不少上游拒绝空数组 / 空对象 / null，但键不存在是合法的） */
  omitIfEmpty?: boolean;
  /** 等值门控，如 "mode == async" */
  when?: string;
  /** type='list' 时的元素子模板：body 里用 {@name} 展开，fields 决定行编辑器长什么样 */
  item?: { body: unknown; fields?: VarSpec[] };
}

/** 出参固定槽位：界面按 role+mode 只渲染该填的那几格 */
export interface RespSlots {
  content?: string;
  image?: string;
  audio?: string;
  voiceId?: string;
  taskId?: string;
  status?: string;
  success?: string[];
  fail?: string[];
  pending?: string[];
  errorCode?: string;
  error?: string;
}

export interface TemplateRow {
  tplId?: string;
  role: Role;
  /** 这条变体服务哪种方式；query / clone 恒 sync */
  mode: Mode;
  ord?: number;
  label?: L;
  method?: string;
  /** 完整地址模板，{baseUrl} 出现在哪由它自己决定 */
  url: string;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  vars?: VarSpec[];
  resp?: RespSlots;
  /** 产物怎么还原成字节：hex（MiniMax）/ base64 / url（远端链接，当场下载） */
  decode?: 'hex' | 'base64' | 'url';
  /** 下载产物时附带的请求头；空 = 裸 GET 签名链接 */
  fetchHeaders?: Record<string, unknown>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** clone 行：参考音频要求采样率（CosyVoice 16k、Qwen-TTS ≥24k，写死过一次就出事） */
  refSampleRateHz?: number;
}

export interface TemplateGroup {
  tplGroup: string;
  kind: ProviderKind;
  label: L;
  note?: L;
  ord?: number;
  /** 新建实例时的预填建议 */
  baseUrl?: string;
  models?: string[];
  defaultModel?: string;
  defaultVoice?: string;
  rows: TemplateRow[];
}

/** 每个 kind 至少要有的 role，缺了这家不可用 */
export const REQUIRED_ROLE: Record<ProviderKind, Role> = { llm: 'generate', tts: 'synthesize', image: 'generate' };

/** 各类功能可能出现的 role（模板页据此列出还能补哪条接口） */
export const ROLES_BY_KIND: Record<ProviderKind, Role[]> = {
  llm: ['generate'],
  tts: ['synthesize', 'query', 'clone'],
  image: ['generate', 'query'],
};

/** 界面标题：role + mode */
export const ROLE_LABEL: Record<Role, L> = {
  generate: { zh: '生成', en: 'Generate' },
  synthesize: { zh: '语音合成', en: 'Synthesize' },
  query: { zh: '状态查询', en: 'Status query' },
  clone: { zh: '音色克隆', en: 'Voice clone' },
};

// ========== 求值上下文 ==========

export interface ReqCtx {
  baseUrl?: string;
  apiKey?: string;
  apiKey2?: string;
  model?: string;
  voice?: string;
  speed?: number;
  /** 实例选的同步 / 异步 */
  mode?: Mode;
  /** 实例期参数（stage=instance） */
  params?: Record<string, unknown>;
  [k: string]: unknown;
}

/** 不必声明的保留占位符 */
export const RESERVED = ['baseUrl', 'apiKey', 'apiKey2', 'model', 'voice', 'speed', 'mode', 'taskId', 'params'];

const WHOLE = /^\{([A-Za-z_][A-Za-z0-9_.]*)\}$/;
const SPLICE = /^\{@([A-Za-z_][A-Za-z0-9_.]*)\}$/;
const EMBED = /\{([A-Za-z_][A-Za-z0-9_.]*)\}/g;

export class EngineError extends Error {
  /** 带上游状态码，调度层才知道这条能不能重试（429 / 5xx 才重试） */
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const isPlain = (v: unknown) => v !== undefined && v !== null && v !== '';

/** 路径支持 `a.b[0].c` 与 `a.b.0.c` 两种写法；界面与文档统一用前者 */
export function normalizePath(path: string): string {
  return path.replace(/\[(\d+)\]/g, '.$1');
}

export function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of normalizePath(path).split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (Number.isNaN(i)) return undefined;
      cur = cur[i];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

function lookup(ctx: ReqCtx, name: string): unknown {
  const direct = name.split('.').reduce<unknown>((acc, seg) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[seg];
  }, ctx);
  if (direct !== undefined) return direct;
  // model / voice 这类既可能在顶层也可能在实例参数里，统一兜到 params
  return readPath(ctx.params ?? {}, name);
}

type VarMap = Map<string, VarSpec>;

/** gated = 声明了但被 when 关掉的变量，引用到就当作「不给值、连键删掉」 */
interface Scope {
  ctx: ReqCtx;
  vars: VarMap;
  gated: Set<string>;
}

function resolveValue(name: string, s: Scope): { present: boolean; value: unknown } {
  if (s.gated.has(name)) return { present: false, value: undefined };
  const spec = s.vars.get(name);
  let v = lookup(s.ctx, name);
  if (v === undefined && spec?.stage === 'instance' && spec.default !== undefined) v = spec.default;
  if (v === undefined) {
    if (spec?.omitIfEmpty) return { present: false, value: undefined };
    throw new EngineError(`缺少变量「${name}」（模板没它发不出请求）`);
  }
  if ((v === null || v === '') && spec?.omitIfEmpty) return { present: false, value: undefined };
  return { present: true, value: v };
}

function interpolate(str: string, s: Scope): string {
  return str.replace(EMBED, (_m, name: string) => {
    const { value } = resolveValue(name, s);
    return typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  });
}

/** 递归求值：undefined 表示「这个键 / 这个元素应当删掉」 */
function walk(node: unknown, s: Scope): unknown {
  if (typeof node === 'string') {
    const whole = WHOLE.exec(node);
    if (whole) {
      const r = resolveValue(whole[1], s);
      return r.present ? r.value : undefined;
    }
    if (SPLICE.test(node)) throw new EngineError(`「${node}」只能出现在数组里（{@name} 是数组展开）`);
    return node.includes('{') ? interpolate(node, s) : node;
  }
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const item of node) {
      if (typeof item === 'string') {
        const sp = SPLICE.exec(item);
        if (sp) {
          const r = resolveValue(sp[1], s);
          if (r.present) {
            const arr = Array.isArray(r.value) ? r.value : [r.value];
            for (const e of arr) out.push(walk(e, s));
          }
          continue;
        }
      }
      const v = walk(item, s);
      if (v !== undefined) out.push(v);
    }
    // 原本有内容、结果全被省略 → 连这个数组一起删（不留空数组给上游挑理）
    if (node.length > 0 && out.length === 0) return undefined;
    return out;
  }
  if (node && typeof node === 'object') {
    const entries = Object.entries(node as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      const rv = walk(v, s);
      if (rv !== undefined) out[k] = rv;
    }
    if (entries.length > 0 && Object.keys(out).length === 0) return undefined;
    return out;
  }
  return node;
}

/** `when: "a == b"`：只支持 == / !=，路径从 ctx 取（界面也用它决定某个参数该不该出现） */
export function whenOk(cond: string | undefined, ctx: ReqCtx): boolean {
  if (!cond) return true;
  const m = /^([\w.]+)\s*(==|!=)\s*(.+)$/.exec(cond.trim());
  if (!m) return true;
  const left = String(lookup(ctx, m[1]) ?? '');
  const right = m[3].trim().replace(/^['"]|['"]$/g, '');
  return m[2] === '==' ? left === right : left !== right;
}

export interface ResolvedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const b = (base || '').replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

export function buildRequest(row: TemplateRow, ctx: ReqCtx): ResolvedRequest {
  const vars: VarMap = new Map();
  const gated = new Set<string>();
  for (const v of row.vars ?? []) {
    if (whenOk(v.when, ctx)) vars.set(v.name, v);
    else gated.add(v.name);
  }
  const s: Scope = { ctx, vars, gated };
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(row.headers ?? {})) {
    const rv = walk(v, s);
    if (rv !== undefined) headers[k] = String(rv);
  }
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(row.query ?? {})) {
    const rv = walk(v, s);
    if (rv !== undefined) query[k] = String(rv);
  }
  const body = row.body === undefined ? undefined : walk(row.body, s);
  return {
    url: joinUrl(ctx.baseUrl || '', walk(row.url, s) as string),
    method: (row.method || 'POST').toUpperCase(),
    headers,
    query,
    body,
  };
}

/** 打码：试调用与日志里绝不让密钥原文出现 */
export function redact(req: ResolvedRequest, ctx: ReqCtx): ResolvedRequest {
  const secrets = [ctx.apiKey, ctx.apiKey2].filter((s) => !!s && s.length >= 6) as string[];
  const mask = (s: string) => {
    let out = s;
    for (const v of secrets) out = out.split(v).join(`${v.slice(0, 4)}****（长度 ${v.length}）`);
    return out;
  };
  return {
    ...req,
    url: mask(req.url),
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, mask(v)])),
    body: JSON.parse(mask(JSON.stringify(req.body ?? null))),
  };
}

// ========== 响应侧 ==========

export interface SendResult {
  status: number;
  contentType?: string;
  bytes?: Uint8Array;
  json?: unknown;
  text?: string;
}

export interface CallResult {
  /** 按槽位取出的值（content / image / audio / voiceId / taskId / status / errorCode …） */
  values: Record<string, unknown>;
  /** 解出来的音频 / 图片字节 */
  bytes?: Uint8Array;
  mime?: string;
  /** 异步时逐次轮询的过程，试调用面板直接渲染它 */
  steps: { label: string; url: string; status: number; values: Record<string, unknown> }[];
}

export interface Deps {
  send: (req: ResolvedRequest) => Promise<SendResult>;
  /** decode:'url' 时下载远端结果 */
  fetchBytes?: (url: string, headers?: Record<string, string>) => Promise<{ bytes: Uint8Array; mime?: string }>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/^data:[^,]*,/, '').trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function jsonOf(res: SendResult): unknown {
  if (res.json !== undefined) return res.json;
  if (typeof res.text === 'string' && res.text) {
    try { return JSON.parse(res.text); } catch { /* 非 JSON 响应 */ }
  }
  return undefined;
}

function looksLikeMedia(res: SendResult): boolean {
  const ct = (res.contentType || '').toLowerCase();
  return !!res.bytes && (ct.startsWith('audio/') || ct.startsWith('image/') || ct.startsWith('video/') || ct === 'application/octet-stream');
}

/** 按槽位从一份 JSON 里取值（三枚举与空串不参与取值） */
export function applySlots(json: unknown, resp?: RespSlots): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['content', 'image', 'audio', 'voiceId', 'taskId', 'status', 'errorCode', 'error'] as const) {
    const path = resp?.[key];
    if (!path) continue;
    const v = readPath(json, path);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function errOf(values: Record<string, unknown>, res: SendResult): string | null {
  const code = values.errorCode ?? values.code;
  const msg = values.error ?? values.message ?? values.errMsg;
  if (res.status >= 200 && res.status < 300 && !code) return null;
  if (msg || code) return `${code ? `${code} · ` : ''}${msg || `HTTP ${res.status}`}`;
  return res.status >= 400 ? `HTTP ${res.status}` : null;
}

/** 第④⑤步：取产物 + 还原成字节（响应体即产物 / 槽位里是 hex·base64·链接） */
async function extract(
  row: TemplateRow,
  json: unknown,
  res: SendResult,
  deps: Deps,
  ctx: ReqCtx,
): Promise<Pick<CallResult, 'values' | 'bytes' | 'mime'>> {
  let values = applySlots(json, row.resp);
  const e = errOf(values, res);
  if (e) throw new EngineError(e, res.status);
  let bytes: Uint8Array | undefined;
  let mime: string | undefined;
  const raw = (values.audio ?? values.image ?? '') as unknown;
  if (looksLikeMedia(res) && typeof raw !== 'string') {
    bytes = res.bytes;
    mime = res.contentType;
  } else if (typeof raw === 'string' && raw) {
    if (raw.startsWith('data:')) bytes = b64ToBytes(raw);
    else if (row.decode === 'hex') bytes = hexToBytes(raw);
    else if (row.decode === 'base64') bytes = b64ToBytes(raw);
    else if (row.decode === 'url' || /^https?:/i.test(raw)) {
      if (!deps.fetchBytes) throw new EngineError(`产物是远端 URL，但没注入 fetchBytes：${raw}`);
      const hdr = buildRequest({ ...row, url: '', body: undefined, headers: row.fetchHeaders, query: {} }, ctx);
      const got = await deps.fetchBytes(raw, hdr.headers);
      bytes = got.bytes;
      mime = got.mime;
    } else bytes = b64ToBytes(raw);
    if (bytes) values = { ...values, productBytes: `${bytes.length} 字节` };
  } else if (res.bytes) {
    bytes = res.bytes;
    mime = res.contentType;
  }
  return { values, bytes, mime };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 组内取行：先按 role + 实例 mode 配，配不到再退到同 role 的任意一条 */
export function pickRow(group: TemplateGroup, role: Role, mode?: Mode): TemplateRow | undefined {
  const rows = group.rows.filter((r) => r.role === role);
  return (mode ? rows.find((r) => r.mode === mode) : undefined) ?? rows[0];
}

/**
 * 跑一个功能：同步一次到位；异步 = 提交 → 记 taskId → 同组 query 行轮询 → 完成后取产物并下载。
 * 组装键是 (tpl_group, role='query')，没有可填错的指针列。
 */
export async function callRole(
  group: TemplateGroup,
  ctx: ReqCtx,
  role: Role,
  inputs: Record<string, unknown>,
  deps: Deps,
): Promise<CallResult> {
  const submit = pickRow(group, role, ctx.mode);
  if (!submit) throw new EngineError(`模板组「${group.tplGroup}」没配 ${role} 接口`);
  const full: ReqCtx = { ...ctx, ...inputs };
  const steps: CallResult['steps'] = [];
  const req = buildRequest(submit, full);
  const first = await deps.send(req);
  const firstJson = jsonOf(first);
  steps.push({ label: `${role} 提交`, url: redact(req, full).url, status: first.status, values: applySlots(firstJson, submit.resp) });
  const firstErr = errOf(steps[0].values, first);

  if (submit.mode !== 'async') {
    if (firstErr) throw new EngineError(firstErr, first.status);
    const tail = await extract(submit, firstJson, first, deps, full);
    return { ...tail, steps };
  }

  const query = pickRow(group, 'query');
  if (!query) throw new EngineError('异步需要「状态查询」接口，这组模板里没有（去接口模板点「＋ 查询接口」）');
  const taskId = readPath(firstJson, submit.resp?.taskId ?? '');
  if (!isPlain(taskId)) throw new EngineError(`提交响应里没找到任务 id（槽位 taskId = ${submit.resp?.taskId || '未填'}）${firstErr ? ` · ${firstErr}` : ''}`);

  const sleep = deps.sleep ?? wait;
  const started = deps.now?.() ?? Date.now();
  const interval = query.pollIntervalMs ?? 1500;
  const timeout = query.pollTimeoutMs ?? 120_000;
  const done = (query.resp?.success ?? []).map(String);
  const bad = (query.resp?.fail ?? []).map(String);
  for (;;) {
    if ((deps.now?.() ?? Date.now()) - started > timeout) throw new EngineError(`任务 ${taskId} 轮询超时（${timeout}ms）`);
    await sleep(interval);
    const qreq = buildRequest(query, { ...full, taskId });
    const qres = await deps.send(qreq);
    const qjson = jsonOf(qres);
    const qValues = applySlots(qjson, query.resp);
    steps.push({ label: '查询状态', url: redact(qreq, full).url, status: qres.status, values: qValues });
    const st = String(qValues.status ?? '');
    if (bad.includes(st)) throw new EngineError(`任务失败：${st}${qValues.error ? ` · ${String(qValues.error)}` : ''}`, qres.status);
    if (done.includes(st)) {
      const tail = await extract(query, qjson, qres, deps, full);
      return { values: { ...tail.values, taskId }, bytes: tail.bytes, mime: tail.mime, steps };
    }
    const e = errOf(qValues, qres);
    if (e) throw new EngineError(e, qres.status);
    const pending = (query.resp?.pending ?? []).map(String);
    if (pending.length && !pending.includes(st)) throw new EngineError(`未识别的任务状态「${st}」——请在查询接口的「在途状态」里补上它`);
  }
}

// ========== 模板自检（保存前跑，别把问题留到运行时） ==========

export function referencedVars(row: TemplateRow): string[] {
  const names = new Set<string>();
  const scan = (node: unknown) => {
    if (typeof node === 'string') {
      for (const m of node.matchAll(new RegExp(WHOLE.source, 'g'))) names.add(m[1]);
      for (const m of node.matchAll(new RegExp(SPLICE.source, 'g'))) names.add(m[1]);
      for (const m of node.matchAll(EMBED)) names.add(m[1]);
      return;
    }
    if (Array.isArray(node)) node.forEach(scan);
    else if (node && typeof node === 'object') Object.values(node).forEach(scan);
  };
  scan([row.url, row.headers, row.query, row.body]);
  return [...names];
}

/** 该行的产物槽：llm 取文本、语音取音频、图片取图片 */
function productSlotOf(row: TemplateRow, kind: ProviderKind): 'content' | 'audio' | 'image' {
  if (kind === 'llm') return 'content';
  return row.role === 'synthesize' ? 'audio' : 'image';
}

/** 单条接口行的问题清单；空数组 = 可用 */
export function validateRow(row: TemplateRow, kind: ProviderKind): string[] {
  const problems: string[] = [];
  const declared = new Set((row.vars ?? []).map((v) => v.name));
  for (const n of referencedVars(row)) {
    if (RESERVED.includes(n)) continue;
    if (!declared.has(n)) problems.push(`模板引用了未声明的变量「${n}」`);
  }
  for (const v of row.vars ?? []) {
    if (v.type === 'list' && !v.item) problems.push(`变量「${v.name}」是 list 但没给元素子模板`);
    if (v.type === 'bool' && v.options) problems.push(`变量「${v.name}」是 bool，两个选项已隐含，不必写 options`);
  }
  const resp = row.resp ?? {};
  const product = productSlotOf(row, kind);
  if (row.role === 'query') {
    if (!resp.status) problems.push('必须登记「任务状态」的取值路径');
    if (!resp.success?.length) problems.push('必须定义「成功」的状态值');
    if (!resp.image && !resp.audio) problems.push('必须登记产物路径（完成后可从这里取图 / 音频）');
    if (resp.taskId) problems.push('任务 id 由生成接口登记，查询接口不用填');
  } else if (row.role === 'clone') {
    if (!resp.voiceId) problems.push('必须登记「音色 ID」的取值路径');
    if (row.decode) problems.push('克隆接口只返回 json，不需要解码方式');
  } else if (row.mode === 'async') {
    if (!resp.taskId) problems.push('标成异步就必须登记「任务 id」的取值路径');
    if (resp.status || resp.success?.length || resp[product]) problems.push('产物与状态都由查询接口登记，生成行不要再填');
  } else {
    // 音频允许登记成「空」：CosyVoice / OpenAI speech 的响应体本身就是音频
    if (product === 'audio' ? resp.audio === undefined : !resp[product]) {
      problems.push(product === 'audio'
        ? '必须登记音频路径（响应体本身就是音频时，路径留空即可）'
        : `必须登记${product === 'content' ? '返回内容' : '图片'}的取值路径`);
    }
    if (resp.status || resp.taskId) problems.push('同步接口不该配任务 id / 状态判定');
  }
  if (row.decode === 'url' && !resp.image && !resp.audio) problems.push('解码方式是「远端链接」，但没登记产物路径');
  return problems;
}

/** 整组 + 实例的成对校验：缺 role、异步没配查询、同步配了查询都在这一步点名 */
export function validateGroup(group: TemplateGroup, mode: Mode = 'sync'): string[] {
  const problems: string[] = group.rows.flatMap((r) => validateRow(r, group.kind).map((p) => `${rowTitle(r)}：${p}`));
  const need = REQUIRED_ROLE[group.kind];
  if (!group.rows.some((r) => r.role === need)) problems.push(`缺少必需的「${zh(ROLE_LABEL[need])}」接口`);
  if (mode === 'async') {
    const submit = group.rows.find((r) => r.role === need && r.mode === 'async');
    if (!submit) problems.push('这个实例选了异步，但这组模板没有异步的生成接口');
    else if (!group.rows.some((r) => r.role === 'query')) problems.push('异步需要「状态查询」接口，点「＋ 查询接口」补');
  } else if (group.rows.some((r) => r.role === 'query') && !group.rows.some((r) => r.mode === 'async')) {
    problems.push('配了查询接口却没有异步生成接口（本实例走同步，它不会被用到）');
  }
  return problems;
}

/** 界面用的行标题：音色克隆 / 语音合成·异步 / 状态查询 */
export function rowTitle(row: TemplateRow): string {
  const name = zh(ROLE_LABEL[row.role]);
  return row.mode === 'async' ? `${name}·异步` : name;
}
