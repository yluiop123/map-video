import { IS_DESKTOP } from './backend';
import { useProviderStore } from '../stores/providerStore';
import {
  EngineError, buildRequest, redact, runSync, runClone, submitAsync, queryOnce,
  requestOf, submitKeyOf, secretsOf,
  type Category, type Deps, type InstanceDef, type ReqKey, type ResolvedRequest, type TemplateDef,
} from './request-engine';

/**
 * providers.ts — 供应商调用门面（薄壳）
 *
 * 这里没有任何按厂商名写的分支：一个实例引用一份接口模板，怎么发、怎么取回全在模板里
 * （docs/provider-engine.md）。本文件只做三件事 —— 注入传输（桌面走主进程 / 网页走 fetch）、
 * 把结果换算成界面要用的形状（dataURL、时长、voiceId…）、异步时先把「内存轮询」顶着
 * （task 表 + 调度器在批次 5 接管这一段）。
 * 历史上这里是 renderer 的 6 条 switch + 主进程再来一份，同一条事实四处维护，事故见 AGENTS §6.22 / §6.24。
 */

// ========== 模板与实例的取用 ==========

export function templateOf(inst: InstanceDef | null | undefined): TemplateDef | undefined {
  if (!inst) return undefined;
  return useProviderStore.getState().templates.find((t) => t.id === inst.tplId);
}

export const categoryOf = (inst: InstanceDef | null | undefined): Category | undefined => templateOf(inst)?.category;

/** 这份模板有没有某条请求（VoicePicker 用它决定「克隆音色」区显示与否） */
export function supports(inst: InstanceDef | null | undefined, key: 'clone' | 'upload' | 'download' | 'async'): boolean {
  const t = templateOf(inst);
  if (!t) return false;
  return key === 'async' ? !!t.async?.submit : !!t[key];
}

/** 参数的声明位置：实例级 + 两条提交接口的请求级 —— 与引擎取值同一批来源，界面不另立一套 */
function specOf(inst: InstanceDef | null | undefined, key: string) {
  const t = templateOf(inst);
  if (!t) return undefined;
  const all = [...(t.instanceParams ?? []), ...(requestOf(t, 'sync.submit')?.requestParams ?? []), ...(requestOf(t, 'async.submit')?.requestParams ?? [])];
  return all.find((s) => s.key === key);
}

/** 某个参数在模板里声明的候选值（有就长按钮组，没有就是文本框） */
export function declaredOptions(inst: InstanceDef | null | undefined, key: string): string[] {
  return (specOf(inst, key)?.options ?? []).map((o) => String(typeof o === 'object' && o !== null ? (o as { value: unknown }).value : o));
}

/** 某个参数声明的默认值 —— 只当输入框的占位提示，真实取值仍由引擎三层解析 */
export const declaredDefault = (inst: InstanceDef | null | undefined, key: string): string => String(specOf(inst, key)?.defaultValue ?? '');

/** 该实例这次该走哪条提交接口（实例的同步开关决定） */
export function submitKeyOfInstance(inst: InstanceDef): ReqKey {
  const t = templateOf(inst);
  if (!t) throw new EngineError(`没找到实例引用的模板「${inst.tplId}」（去接口模板页检查）`);
  const key = submitKeyOf(inst.sync);
  if (!requestOf(t, key)) {
    if (key === 'sync.submit') throw new EngineError('这份模板没有同步提交接口，把实例改成异步');
    throw new EngineError('这份模板没有异步提交接口（或没配查询接口），把实例改成同步');
  }
  return key;
}

/** 这份模板声明的默认音色（callParams 里 voice 的 defaultValue）；没声明返回空，由界面要求用户选 */
export function defaultVoiceOf(inst: InstanceDef | null | undefined): string {
  const tpl = inst ? templateOf(inst) : undefined;
  const spec = (tpl ? requestOf(tpl, 'sync.submit')?.callParams ?? [] : []).find((x) => x.key === 'voice');
  return String(spec?.defaultValue ?? '');
}

/** 参考音频要求采样率：CosyVoice 16k、Qwen-TTS ≥24k，各家不同，写死过一次就出事 */
export function refSampleRateOf(inst: InstanceDef | null | undefined): number {
  return templateOf(inst)?.refSampleRateHz ?? 16000;
}

/** 需要第二把 Key 吗（实例页据此决定那一格出不出现） */
export function needsSecret2(inst: InstanceDef | null | undefined): boolean {
  return JSON.stringify(templateOf(inst)?.headers ?? {}).includes('${apiKey2}');
}

/** 查询节奏（实例级：账号限额，不属模板形状） */
function pacing(inst: InstanceDef) {
  const v = inst.values.instance ?? {};
  const n = (k: string, d: number) => (typeof v[k] === 'number' ? (v[k] as number) : Number(v[k]) || d);
  return { intervalMs: n('queryIntervalMs', 1500), maxAttempts: n('queryMaxAttempts', 120), timeoutMs: n('timeoutMs', 30000) };
}

// ========== 传输 ==========

async function rawSend(r: ResolvedRequest): Promise<{ status: number; contentType?: string; json?: unknown; text?: string; bytes?: Uint8Array }> {
  if (IS_DESKTOP) {
    const res = await window.mapvideo!.net.request(r);
    if (res.error) throw new EngineError(res.error);
    return {
      status: res.status ?? 0, contentType: res.contentType, json: res.json, text: res.text,
      bytes: res.bytes ? new Uint8Array(res.bytes) : undefined,
    };
  }
  let res: Response;
  try {
    res = await fetch(r.url, {
      method: r.method, headers: r.headers,
      body: r.method === 'GET' ? undefined : JSON.stringify(r.body ?? {}),
    });
  } catch {
    throw new EngineError('请求失败（可能被 CORS 拦截）——桌面版无此限制，或把 Base URL 换成自己的代理地址');
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) return { status: res.status, contentType: ct, json: await res.json().catch(() => undefined) };
  if (ct.startsWith('text/') || ct.includes('xml')) return { status: res.status, contentType: ct, text: await res.text() };
  return { status: res.status, contentType: ct, bytes: new Uint8Array(await res.arrayBuffer()) };
}

async function fetchBytes(url: string, headers?: Record<string, string>) {
  if (IS_DESKTOP) {
    const r = await window.mapvideo!.net.fetchUrl(url, headers);
    if (r.error) throw new EngineError(r.error);
    return { bytes: new Uint8Array(r.bytes ?? new ArrayBuffer(0)), mime: r.contentType };
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new EngineError(`下载结果失败 HTTP ${res.status}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type') || undefined };
}

const deps: Deps = { send: rawSend, fetchBytes };

const tplOf = (inst: InstanceDef): TemplateDef => {
  const t = templateOf(inst);
  if (!t) throw new EngineError(`没找到实例引用的模板「${inst.tplId}」（去接口模板页检查）`);
  return t;
};

/**
 * 一条调用：同步就一把梭；异步在这里**内存轮询**顶着（跨重启续跑等批次 5 的 task 表 + 调度器）。
 * 失败一律抛 EngineError，把上游 code/message 原样带上（界面不翻译，否则查不到根因）。
 */
async function run(inst: InstanceDef, callArgs: Record<string, unknown>): Promise<{ values: Record<string, unknown>; bytes?: Uint8Array; mime?: string }> {
  const tpl = tplOf(inst);
  const key = submitKeyOfInstance(inst);
  if (key === 'sync.submit') return runSync(tpl, inst, deps, 'sync.submit', callArgs);
  const first = await submitAsync(tpl, inst, deps, callArgs);
  const { intervalMs, maxAttempts } = pacing(inst);
  let upstream = first.values;
  for (let i = 0; i < maxAttempts; i += 1) {
    await sleep(intervalMs);
    const one = await queryOnce(tpl, inst, deps, upstream);
    upstream = one.values;
    if (one.outcome === 'success') return { values: one.values, bytes: one.bytes, mime: one.mime };
    if (one.outcome === 'failed') throw new EngineError('上游报任务失败');
  }
  throw new EngineError(`查询超过 ${maxAttempts} 次还没完成（上游任务可能还在排队）`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 「预览请求」：只跑模板求值 + 密钥打码，**一个字节都不发出去** */
export function previewRequest(inst: InstanceDef, key: ReqKey, callArgs: Record<string, unknown> = {}): ResolvedRequest {
  return redact(buildRequest(tplOf(inst), inst, key, callArgs).req, secretsOf(tplOf(inst), inst));
}

/** 「试调用」：真发一条，把 steps / 取到的字段 / 字节数原样交回界面 */
export async function trialCall(inst: InstanceDef, key: ReqKey, callArgs: Record<string, unknown> = {}) {
  const tpl = tplOf(inst);
  if (key === 'clone' || key === 'upload') {
    const r = await runClone(tpl, inst, deps, callArgs);
    return { values: r.values, bytes: undefined as Uint8Array | undefined, mime: undefined as string | undefined, steps: r.steps };
  }
  if (key === 'async.query') {
    const one = await queryOnce(tpl, inst, deps, callArgs);
    return { values: one.values, bytes: one.bytes, mime: one.mime, steps: [one.step] };
  }
  const r = await runSync(tpl, inst, deps, key, callArgs);
  return { values: r.values, bytes: r.bytes, mime: r.mime, steps: r.steps };
}

// ========== 调度器用的两步（一次推进一步，状态由调用方落 task 表） ==========

/** 第一步：提交。同步模板一步到底拿到产物；异步模板交出任务号 */
export async function submitStep(inst: InstanceDef, callArgs: Record<string, unknown>): Promise<
  { done: true; bytes: Uint8Array; mime?: string } | { done: false; providerTaskId: string; upstream: Record<string, unknown> }
> {
  const tpl = tplOf(inst);
  if (submitKeyOfInstance(inst) === 'sync.submit') {
    const r = await runSync(tpl, inst, deps, 'sync.submit', callArgs);
    if (!r.bytes?.length) throw new EngineError('这一步没拿到产物，检查模板的产物路径与 outputFormat');
    return { done: true, bytes: r.bytes, mime: r.mime };
  }
  const r = await submitAsync(tpl, inst, deps, callArgs);
  if (!r.taskId) throw new EngineError(`提交响应里没取到任务 id，检查 async.submit 的 outputs（取到的是 ${JSON.stringify(r.values)}）`);
  return { done: false, providerTaskId: r.taskId, upstream: r.values };
}

/** 第二步：查一次。没成就是没成 —— 下次什么时候再来由调度器定 */
export async function queryStep(inst: InstanceDef, upstream: Record<string, unknown>): Promise<
  { done: true; bytes: Uint8Array; mime?: string } | { done: false; status?: string }
> {
  const one = await queryOnce(tplOf(inst), inst, deps, upstream);
  if (one.outcome !== 'success') return { done: false, status: one.status };
  if (!one.bytes?.length) throw new EngineError('任务说成功了，但产物没取回来 —— 检查查询接口的产物路径');
  return { done: true, bytes: one.bytes, mime: one.mime };
}

/** base64 → 字节（配置 JSON 导入时还原素材） */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** 预览 / 试调用时给调用级参数占位的样例文本（只有界面用，不进真实调用） */
export const SAMPLE_CALL_ARGS: Record<string, string> = {
  text: '这段旁白用来试听音色。',
  prompt: '一只戴宇航员头盔的橘猫',
  systemPrompt: '你是连通性测试助手。',
  userPrompt: '只回复两个字：正常',
};

// ========== 对外几个动作 ==========

export async function callLLM(inst: InstanceDef, systemPrompt: string, userPrompt: string): Promise<string> {
  const r = await run(inst, { systemPrompt, userPrompt });
  const text = r.values.content;
  if (typeof text !== 'string') throw new EngineError('响应里没取到文本，检查模板 sync.submit 的 outputs.content 路径');
  return text;
}

export interface TtsResult {
  /** dataURL（blob 转存） */
  dataUrl: string;
  durationSec: number;
}

/** 合成一段配音；voiceId 传了就用它（内置 / 克隆音色都是厂商的 voice id），不传用实例的默认音色 */
export async function callTTS(inst: InstanceDef, text: string, voiceId?: string, extra: Record<string, unknown> = {}): Promise<TtsResult> {
  const r = await run(inst, { text, reqId: `mv-${Date.now()}`, ...(voiceId ? { voice: voiceId } : {}), ...extra });
  if (!r.bytes?.length) throw new EngineError('没拿到音频：检查模板的产物路径与 outputFormat');
  const dataUrl = await blobToDataUrl(new Blob([r.bytes], { type: r.mime || 'audio/mpeg' }));
  return { dataUrl, durationSec: await decodeAudioDuration(dataUrl, text) };
}

/** 文生图：产物一律当场下载后转 dataURL（上游给的是带时效的链接） */
export async function callImage(inst: InstanceDef, prompt: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await run(inst, { prompt, ...extra });
  if (r.bytes?.length) return `data:${r.mime || 'image/png'};base64,${bytesToBase64(r.bytes)}`;
  const url = r.values.url ?? r.values.image;
  if (typeof url === 'string' && url) return normalizeImage(url);
  throw new EngineError('响应里没取到图片，检查模板 outputs 里的产物路径');
}

/** 参考音频 → 音色 ID。targetModel 必须与之后合成用的 model 一致（换模型 voiceId 即失效） */
export async function cloneVoice(inst: InstanceDef, refBytes: ArrayBuffer, targetModel: string, label = 'mv'): Promise<string> {
  const tpl = tplOf(inst);
  if (!tpl.clone) throw new EngineError('这份模板没配克隆接口');
  const wav = await toWavMono(refBytes, refSampleRateOf(inst));
  if (wav.length > 10 * 1024 * 1024) throw new EngineError('参考音频超过 10MB');
  // 音色名优先用实例在 ⚙ 里填的那条，没填才用样本名兜底；两者都要过滤 ——
  // 实测上游对 `preferred_name` 只收字母数字（带连字符直接 InvalidParameter）
  const declared = String(inst.values.requests?.clone?.preferredName ?? '').trim();
  const preferred = (declared || label).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'mv';
  const one: InstanceDef = { ...inst, values: { ...inst.values, instance: { ...inst.values.instance, model: targetModel || inst.values.instance?.model } } };
  const r = await runClone(tpl, one, deps, {
    file: wav,
    audioDataUri: `data:audio/wav;base64,${bytesToBase64(wav)}`,
    prefix: preferred, preferredName: preferred,
  });
  const vid = r.values.voiceId ?? r.values.voice;
  if (typeof vid !== 'string' || !vid) throw new EngineError('克隆响应里没取到音色 ID，检查 clone.outputs.voiceId 路径');
  return vid;
}

// ========== 音频 / 图片小工具 ==========

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error('读取音频失败'));
    r.readAsDataURL(blob);
  });
}

/** 解码音频取时长（失败按字数估算兜底）。给字节时不用绕一趟 URL（产物刚落库，字节就在手上） */
export async function decodeAudioDuration(src: string | Uint8Array, fallbackText = ''): Promise<number> {
  try {
    const AC: typeof AudioContext = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    // decodeAudioData 会 detach 传进去的 buffer —— 给副本，别把调用方那份字节作废掉
    const buf = await ctx.decodeAudioData(typeof src === 'string' ? await (await fetch(src)).arrayBuffer() : src.slice().buffer);
    void ctx.close();
    return buf.duration;
  } catch {
    return Math.max(0.8, fallbackText.length * 0.28 + 0.3);
  }
}

/** 统一图片返回：http(s)/dataURL 原样；纯 base64 补 dataURL 前缀，否则 <img> 无法显示 */
function normalizeImage(s: string): string {
  const v = (s || '').trim();
  if (!v) return v;
  if (/^https?:\/\//i.test(v) || v.startsWith('data:')) return v;
  return `data:image/png;base64,${v}`;
}

/** 任意音频 → 单声道 WAV（各家要求的采样率不同，见模板的 refSampleRateHz） */
async function toWavMono(bytes: ArrayBuffer, rateHz: number): Promise<Uint8Array> {
  const AC: typeof AudioContext = window.AudioContext
    || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  const decoded = await ctx.decodeAudioData(bytes.slice(0));
  void ctx.close();
  const target = new OfflineAudioContext(1, Math.ceil(decoded.duration * rateHz), rateHz);
  const src = target.createBufferSource();
  src.buffer = decoded;
  src.connect(target.destination);
  src.start();
  const rendered = await target.startRendering();
  const ch = rendered.getChannelData(0);
  const len = ch.length;
  const buf = new ArrayBuffer(44 + len * 2);
  const dv = new DataView(buf);
  const ws = (off: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + len * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(16, 16, true); dv.setUint32(24, rateHz, true); dv.setUint32(28, rateHz * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, len * 2, true);
  let off = 44;
  for (let i = 0; i < len; i += 1, off += 2) {
    const s = Math.max(-1, Math.min(1, ch[i]));
    dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
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
      return lines
        .filter((l) => !/^\d+$/.test(l.trim()) && !/-->\s|\d{2}:\d{2}:\d{2}/.test(l))
        .join(' ')
        .trim();
    })
    .filter((x) => x);
}

export type { Category, InstanceDef, ReqKey, ResolvedRequest, TemplateDef };
