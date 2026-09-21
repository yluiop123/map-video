/**
 * request-engine.ts — 「模板即数据」的请求引擎（纯函数 + 可注入传输，离线可单测）
 *
 * 为什么要它：同一条「某家怎么发请求」的事实，原先散在 renderer 的 switch、主进程的 switch、
 * assertTtsPairing 白名单、DDL 的 CHECK 四处（AGENTS §6.22 / §6.24 两次事故都是这么来的）。
 * 这里把它收成一份数据：EndpointTemplate = 怎么发 + 怎么取回 + 同步还是异步。
 *
 * 求值规则刻意做小（见 docs/provider-engine.md 第四节）：
 *   {name}    独占一个标量 → 整段替换、**保留原类型**；在字符串内部 → 插值成字符串
 *   {@name}   只能在数组里，整段展开为该 list 变量的元素序列
 * 没有循环、没有表达式语言，只有 `when: "a == b"` 等值门控与 omitIfEmpty ——
 * 模板里一旦能写程序，出错时看模板就看不出实际发了什么。
 *
 * 本文件**不碰网络、不碰 DOM、不 import store**：真实收发由调用端注入 deps.send。
 */
import type { L } from './i18n';

// ========== 类型 ==========

export type Role =
  | 'llm.generate'
  | 'tts.synthesize'
  | 'tts.clone'
  | 'tts.query'
  | 'image.generate'
  | 'image.query';

export type VarType = 'string' | 'number' | 'bool' | 'json' | 'list';

export interface VarOption {
  value: string | number | boolean;
  /** 省略则直接显示 value；只有 value 会进请求体 */
  label?: L;
}

export interface VarSpec {
  name: string;
  /** inject = 调用端传（UI 只读）；param = 配置期可填（渲染成控件） */
  kind: 'inject' | 'param';
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

export interface PollSpec {
  /** 从提交响应里记任务 id 的路径（第四节的「需要记录的返回参数」） */
  taskId: string;
  /** 查询接口的 role；同步接口不会出现在这里 */
  statusRole: Role;
  intervalMs?: number;
  timeoutMs?: number;
  done: { path: string; equals?: string; in?: string[] };
  fail?: { path: string; in?: string[] };
  /** 任务完成后再从查询响应里取值 */
  then?: Record<string, string>;
}

export interface RespSpec {
  /** auto = 按 Content-Type 判音频/JSON */
  kind?: 'auto' | 'audio' | 'json' | 'text';
  /** 取到的是 hex / base64 / 远端 URL 时怎么还原成字节 */
  decode?: 'hex' | 'base64' | 'url';
  /** 字段登记：text / audio / image / voiceId / taskId / errorCode / error … */
  pick?: Record<string, string>;
}

export interface EndpointTemplate {
  role: Role;
  label?: L;
  method?: string;
  /** 相对 baseUrl 或完整 URL；两者都支持 {var} */
  path: string;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  vars?: VarSpec[];
  resp?: RespSpec;
  mode: 'sync' | 'async';
  poll?: PollSpec;
}

// ========== 变量池 ==========

export interface ReqCtx {
  baseUrl?: string;
  model?: string;
  voice?: string;
  speed?: number;
  mode?: string;
  secrets?: Record<string, string>;
  [k: string]: unknown;
}

const WHOLE = /^\{([A-Za-z_][A-Za-z0-9_.]*)\}$/;
const SPLICE = /^\{@([A-Za-z_][A-Za-z0-9_.]*)\}$/;
const EMBED = /\{([A-Za-z_][A-Za-z0-9_.]*)\}/g;

export class EngineError extends Error {}

const isPlain = (v: unknown) => v !== undefined && v !== null && v !== '';

export function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
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
  if (name.startsWith('secrets.')) return ctx.secrets?.[name.slice('secrets.'.length)];
  const direct = name.split('.').reduce<unknown>((acc, seg) => {
    if (acc == null) return undefined;
    if (typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[seg];
  }, ctx);
  if (direct !== undefined) return direct;
  // model / voice 这类既可能在顶层也可能在 params 里，统一兜到 params
  return readPath(ctx.params ?? {}, name);
}

/** 变量声明表（name → spec），用于 default / omitIfEmpty / 类型 */
type VarMap = Map<string, VarSpec>;

/** 求值作用域：gated = 声明了但被 when 关掉的变量，引用到就当作「不给值、连键删掉」 */
interface Scope {
  ctx: ReqCtx;
  vars: VarMap;
  gated: Set<string>;
}

function resolveValue(name: string, s: Scope): { present: boolean; value: unknown } {
  if (s.gated.has(name)) return { present: false, value: undefined };
  const spec = s.vars.get(name);
  let v = lookup(s.ctx, name);
  if (v === undefined && spec?.kind === 'param' && spec.default !== undefined) v = spec.default;
  if (v === undefined) {
    if (spec?.omitIfEmpty) return { present: false, value: undefined };
    throw new EngineError(`缺少变量「${name}」（模板没它发不出请求）`);
  }
  if (v === null || v === '') {
    if (spec?.omitIfEmpty) return { present: false, value: undefined };
  }
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

export function buildRequest(tpl: EndpointTemplate, ctx: ReqCtx): ResolvedRequest {
  const scope: ReqCtx = { mode: tpl.mode, ...ctx };
  const vars: VarMap = new Map();
  const gated = new Set<string>();
  for (const v of tpl.vars ?? []) {
    if (whenOk(v.when, scope)) vars.set(v.name, v);
    else gated.add(v.name);
  }
  const s: Scope = { ctx: scope, vars, gated };
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(tpl.headers ?? {})) {
    const rv = walk(v, s);
    if (rv !== undefined) headers[k] = String(rv);
  }
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(tpl.query ?? {})) {
    const rv = walk(v, s);
    if (rv !== undefined) query[k] = String(rv);
  }
  const body = tpl.body === undefined ? undefined : walk(tpl.body, s);
  return {
    url: joinUrl(ctx.baseUrl || '', walk(tpl.path, s) as string),
    method: (tpl.method || 'POST').toUpperCase(),
    headers,
    query,
    body,
  };
}

/** 打码：试调用与日志里绝不让密钥原文出现 */
export function redact(req: ResolvedRequest, ctx: ReqCtx): ResolvedRequest {
  const secrets = Object.values(ctx.secrets ?? {}).filter((s) => s && s.length >= 6);
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
  /** pick 登记出来的字段（text / audio / image / voiceId / errorCode …） */
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
  fetchBytes?: (url: string) => Promise<{ bytes: Uint8Array; mime?: string }>;
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
  const bin = atob(b64.trim());
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

/** 按 resp.pick 从一份 JSON 里取登记字段 */
export function applyPick(json: unknown, pick?: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, path] of Object.entries(pick ?? {})) {
    const v = readPath(json, path);
    if (v !== undefined) out[k] = v;
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

async function finish(
  tpl: EndpointTemplate,
  json: unknown,
  res: SendResult,
  deps: Deps,
): Promise<Pick<CallResult, 'values' | 'bytes' | 'mime'>> {
  const spec = tpl.resp ?? {};
  let values = applyPick(json, spec.pick);
  const e = errOf(values, res);
  if (e) throw new EngineError(e);
  let bytes: Uint8Array | undefined;
  let mime: string | undefined;
  if (spec.kind === 'audio' || (spec.kind !== 'json' && spec.kind !== 'text' && looksLikeMedia(res))) {
    bytes = res.bytes;
    mime = res.contentType;
  } else {
    const raw = values.audio ?? values.image ?? (typeof values.text === 'string' && spec.decode ? values.text : undefined);
    if (typeof raw === 'string') {
      if (spec.decode === 'hex') bytes = hexToBytes(raw);
      else if (spec.decode === 'base64') bytes = b64ToBytes(raw);
      else if (spec.decode === 'url' || /^https?:/i.test(raw)) {
        if (!deps.fetchBytes) throw new EngineError(`结果是远端 URL，但没注入 fetchBytes：${raw}`);
        const got = await deps.fetchBytes(raw);
        bytes = got.bytes;
        mime = got.mime;
      }
      if (bytes) values = { ...values, audioBytes: `${bytes.length} 字节` };
    }
  }
  return { values, bytes, mime };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 执行一个模板：同步一次到位；异步 = 提交 → 记 taskId → 轮询状态 → 完成后再取值。
 * statusTemplates 由调用端按 role 提供（同一供应商下配对的那些行）。
 */
export async function callEndpoint(
  tpl: EndpointTemplate,
  ctx: ReqCtx,
  deps: Deps,
  statusTemplates: Partial<Record<Role, EndpointTemplate>> = {},
): Promise<CallResult> {
  const steps: CallResult['steps'] = [];
  const req = buildRequest(tpl, ctx);
  const first = await deps.send(req);
  const firstJson = jsonOf(first);
  const values = applyPick(firstJson, tpl.resp?.pick);
  steps.push({ label: `${tpl.role} 提交`, url: redact(req, ctx).url, status: first.status, values });
  const firstErr = errOf(values, first);
  if (tpl.mode !== 'async') {
    if (firstErr) throw new EngineError(firstErr);
    const tail = await finish(tpl, firstJson, first, deps);
    return { values: tail.values, bytes: tail.bytes, mime: tail.mime, steps };
  }
  const poll = tpl.poll;
  if (!poll) throw new EngineError(`${tpl.role} 标成异步却没配轮询规则`);
  const statusTpl = statusTemplates[poll.statusRole];
  if (!statusTpl) throw new EngineError(`异步需要查询接口 ${poll.statusRole}，这个供应商没配`);
  const taskId = readPath(firstJson, poll.taskId);
  if (!isPlain(taskId)) throw new EngineError(`提交响应里没找到任务 id（${poll.taskId}）`);
  const sleep = deps.sleep ?? wait;
  const started = (deps.now?.() ?? Date.now());
  const interval = poll.intervalMs ?? 1500;
  const timeout = poll.timeoutMs ?? 120_000;
  for (;;) {
    if ((deps.now?.() ?? Date.now()) - started > timeout) throw new EngineError(`任务 ${taskId} 轮询超时（${timeout}ms）`);
    await sleep(interval);
    const sreq = buildRequest(statusTpl, { ...ctx, taskId });
    const sres = await deps.send(sreq);
    const sjson = jsonOf(sres);
    const sValues = applyPick(sjson, { status: poll.done.path, ...(poll.then ?? {}) });
    steps.push({ label: `查询 ${poll.statusRole}`, url: redact(sreq, ctx).url, status: sres.status, values: sValues });
    const st = String(readPath(sjson, poll.done.path) ?? '');
    if (poll.fail && (poll.fail.in ?? []).includes(st)) throw new EngineError(`任务失败：${st}`);
    if (st === String(poll.done.equals ?? '') || (poll.done.in ?? []).includes(st)) {
      const merged = { ...applyPick(sjson, poll.then), taskId } as Record<string, unknown>;
      // 完成后的值走同一套「取回」逻辑（异步任务的产物通常是远端 URL）
      const doneTpl: EndpointTemplate = {
        ...tpl,
        mode: 'sync',
        resp: {
          ...tpl.resp,
          decode: tpl.resp?.decode ?? 'url',
          pick: Object.fromEntries(Object.keys(merged).map((k) => [k, `picked.${k}`])),
        },
        poll: undefined,
      };
      const tail = await finish(doneTpl, { picked: merged }, sres, deps);
      return { values: { ...tail.values, taskId }, bytes: tail.bytes, mime: tail.mime, steps };
    }
    const e = errOf(sValues, sres);
    if (e) throw new EngineError(e);
  }
}

// ========== 模板自检（保存前跑，别把问题留到运行时） ==========

export function referencedVars(tpl: EndpointTemplate): string[] {
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
  scan([tpl.path, tpl.headers, tpl.query, tpl.body]);
  return [...names];
}

/** 返回问题清单；空数组 = 模板可用 */
export function validateTemplate(tpl: EndpointTemplate): string[] {
  const problems: string[] = [];
  const declared = new Set((tpl.vars ?? []).map((v) => v.name));
  for (const n of referencedVars(tpl)) {
    if (n.startsWith('secrets.') || ['baseUrl', 'model', 'voice', 'speed', 'mode', 'taskId', 'params'].includes(n)) continue;
    if (!declared.has(n)) problems.push(`模板引用了未声明的变量「${n}」`);
  }
  for (const v of tpl.vars ?? []) {
    if (v.type === 'list' && !v.item) problems.push(`变量「${v.name}」是 list 但没给元素子模板`);
    if (v.type === 'bool' && v.options) problems.push(`变量「${v.name}」是 bool，两个选项已隐含，不必写 options`);
  }
  if (tpl.mode === 'async') {
    if (!tpl.poll) problems.push('标成异步却没配查询规则（同步接口才不需要）');
    else {
      if (!tpl.poll.taskId) problems.push('异步必须登记任务 id 的取值路径');
      if (!tpl.poll.statusRole) problems.push('异步必须指定查询接口');
      if (!tpl.poll.done?.path) problems.push('异步必须定义「完成」怎么判定');
    }
  } else if (tpl.poll) {
    problems.push('同步接口不该配查询规则');
  }
  return problems;
}
