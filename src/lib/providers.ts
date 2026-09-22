import type { ProviderConfig } from '../types';
import { IS_DESKTOP } from './backend';
import { useProviderStore } from '../stores/providerStore';
import {
  buildRequest, callRole, pickRow, redact, EngineError,
  type CallResult, type ProviderKind, type ReqCtx, type ResolvedRequest, type Role, type SendResult, type TemplateGroup, type TemplateRow,
} from './request-engine';

/**
 * providers.ts — 供应商调用门面（薄壳）
 *
 * 这里没有任何协议分支：一个能力实例引用一组接口模板，怎么发、怎么取回全在模板里
 * （docs/provider-engine.md）。本文件只做三件事 —— 把实例变成引擎上下文、注入传输
 * （桌面走主进程 / 网页走 fetch）、把结果换算成界面要用的形状（dataURL、时长、voice_id…）。
 * 历史上这里是 renderer 的 6 条 switch + 主进程再来一份，同一条事实四处维护，事故见 AGENTS §6.22 / §6.24。
 */

// ========== 模板取用 ==========

/** 这个实例用的模板组（共享数据，界面编辑的就是它） */
export function groupOf(cfg: ProviderConfig | null | undefined): TemplateGroup | undefined {
  if (!cfg) return undefined;
  return useProviderStore.getState().groups.find((g) => g.tplGroup === cfg.tplGroup);
}

/** 这个供应商能不能做某件事（例：VoicePicker 用它决定「克隆音色」区显示与否） */
export function supports(cfg: ProviderConfig | null | undefined, role: Role): boolean {
  return !!groupOf(cfg)?.rows.some((r) => r.role === role);
}

/** 该组建议的候选模型（界面下拉用） */
export function modelsOf(cfg: ProviderConfig | null | undefined): string[] {
  return groupOf(cfg)?.models ?? [];
}

/** 参考音频转码采样率：CosyVoice 16k、Qwen-TTS ≥24k，各家不同，写死过一次就出事 */
export function refSampleRateOf(cfg: ProviderConfig | null | undefined): number {
  return groupOf(cfg)?.rows.find((r) => r.role === 'clone')?.refSampleRateHz ?? 16000;
}

/** 这组模板要不要第二凭证 */
export function needsSecret2(cfg: ProviderConfig | null | undefined): boolean {
  return JSON.stringify(groupOf(cfg)?.rows ?? []).includes('{apiKey2}');
}

/** 实例页要渲染的参数：该组各接口的 instParams（同名合并成一个控件） */
export function instanceVars(cfg: ProviderConfig | null | undefined) {
  const seen = new Map<string, NonNullable<TemplateRow['instParams']>[number]>();
  for (const r of groupOf(cfg)?.rows ?? []) {
    for (const v of r.instParams ?? []) if (!seen.has(v.name)) seen.set(v.name, v);
  }
  return [...seen.values()];
}

// ========== 引擎上下文 ==========

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target: unknown, patch: unknown): unknown {
  if (!isObj(patch)) return target;
  const base = isObj(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) base[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  return base;
}

function ctxOf(cfg: ProviderConfig): ReqCtx {
  return {
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey ?? '',
    apiKey2: cfg.apiKey2 ?? '',
    model: cfg.model,
    voice: cfg.voice,
    speed: cfg.speed ?? 1,
    mode: cfg.mode,
    params: cfg.params ?? {},
  };
}

function safeExtra(s?: string): Record<string, unknown> | null {
  if (!s?.trim()) return null;
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; }
}

async function runRole(cfg: ProviderConfig, role: Role, inputs: Record<string, unknown> = {}): Promise<CallResult> {
  const group = groupOf(cfg);
  if (!group) throw new EngineError(`没找到模板组「${cfg.tplGroup}」（去接口模板页检查）`);
  const extra = safeExtra(cfg.extra);
  const send = async (req: ResolvedRequest): Promise<SendResult> =>
    rawSend(extra ? { ...req, body: deepMerge(req.body, extra) } : req);
  return callRole(group, ctxOf(cfg), role, inputs, { send, fetchBytes });
}

// ========== 传输（桌面走主进程，网页直连） ==========

async function rawSend(req: ResolvedRequest): Promise<SendResult> {
  if (IS_DESKTOP) {
    const r = await window.mapvideo!.net.request(req);
    if (r.error) throw new EngineError(r.error);
    return { status: r.status ?? 0, contentType: r.contentType, bytes: r.bytes ? new Uint8Array(r.bytes) : undefined, json: r.json, text: r.text };
  }
  const url = new URL(req.url);
  for (const [k, v] of Object.entries(req.query)) url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(url.href, { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : JSON.stringify(req.body ?? {}) });
  } catch {
    throw new EngineError('请求失败（可能被 CORS 拦截）——桌面版无此限制，或把 Base URL 换成自己的代理地址');
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) return { status: res.status, contentType: ct, json: await res.json().catch(() => undefined) };
  if (ct.startsWith('text/') || ct.includes('xml')) return { status: res.status, contentType: ct, text: await res.text() };
  return { status: res.status, contentType: ct, bytes: new Uint8Array(await res.arrayBuffer()) };
}

async function fetchBytes(url: string, headers?: Record<string, string>): Promise<{ bytes: Uint8Array; mime?: string }> {
  if (IS_DESKTOP) {
    const r = await window.mapvideo!.net.fetchUrl(url, headers);
    if (r.error) throw new EngineError(r.error);
    return { bytes: new Uint8Array(r.bytes ?? new ArrayBuffer(0)), mime: r.contentType };
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new EngineError(`下载结果失败 HTTP ${res.status}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type') || undefined };
}

/**
 * 「预览请求」：只跑模板求值 + 密钥打码，**一个字节都不发出去**。
 * 有了它，改完模板先看实际会长成什么样，再决定要不要花一次真调用。
 */
export function previewRequest(cfg: ProviderConfig, role: Role, inputs: Record<string, unknown> = {}): ResolvedRequest {
  const group = groupOf(cfg);
  const r = group ? pickRow(group, role, cfg.mode) : undefined;
  if (!r) throw new EngineError(`这组模板没配 ${role} 接口`);
  const ctx = { ...ctxOf(cfg), ...inputs };
  const extra = safeExtra(cfg.extra);
  const req = buildRequest(r, ctx);
  return redact(extra ? { ...req, body: deepMerge(req.body, extra) } : req, ctx);
}

/** 「试调用」：走完整引擎（含异步轮询），把 steps / 取到的字段 / 字节数原样交回界面 */
export function runRoleDebug(cfg: ProviderConfig, role: Role, inputs: Record<string, unknown> = {}): Promise<CallResult> {
  return runRole(cfg, role, inputs);
}

// ========== 对外四个动作 ==========

export async function callLLM(cfg: ProviderConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  const r = await runRole(cfg, 'generate', { systemPrompt, userPrompt });
  const text = r.values.content;
  if (typeof text !== 'string') throw new EngineError('响应里没取到文本，检查接口模板的「返回内容」路径');
  return text;
}

export interface TtsResult {
  /** dataURL（blob 转存） */
  dataUrl: string;
  durationSec: number;
}

export async function callTTS(cfg: ProviderConfig, text: string, voice?: string): Promise<TtsResult> {
  const r = await runRole(cfg, 'synthesize', { text, reqId: `mv-${Date.now()}`, ...(voice ? { voice } : {}) });
  if (!r.bytes?.length) throw new EngineError('没拿到音频：检查接口模板的音频路径 / 解码方式');
  const dataUrl = await blobToDataUrl(new Blob([r.bytes], { type: r.mime || 'audio/mpeg' }));
  return { dataUrl, durationSec: await decodeAudioDuration(dataUrl, text) };
}

/** 文生图：产物一律当场下载后转 dataURL（上游给的是带时效的链接） */
export async function callImage(cfg: ProviderConfig, prompt: string): Promise<string> {
  const r = await runRole(cfg, 'generate', { prompt });
  if (r.bytes?.length) return `data:${r.mime || 'image/png'};base64,${bytesToBase64(r.bytes)}`;
  const url = r.values.image;
  if (typeof url === 'string' && url) return normalizeImage(url);
  throw new EngineError('响应里没取到图片，检查接口模板的图片路径');
}

/** 参考音频 → 音色 ID。targetModel 必须与之后合成用的 model 一致。 */
export async function cloneVoice(cfg: ProviderConfig, refBytes: ArrayBuffer, targetModel: string, prefix = 'mv'): Promise<string> {
  const wav = await toWavMono(refBytes, refSampleRateOf(cfg));
  if (wav.length > 10 * 1024 * 1024) throw new EngineError('参考音频超过 10MB');
  const r = await runRole(cfg, 'clone', {
    wavB64: bytesToBase64(wav),
    prefix,
    preferredName: String(prefix || 'mv').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'mv',
    model: targetModel || cfg.model,
  });
  const vid = r.values.voiceId;
  if (typeof vid !== 'string' || !vid) throw new EngineError('克隆响应里没取到音色 ID，检查「音色 ID」路径');
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

/** 解码音频取时长（失败按字数估算兜底） */
export async function decodeAudioDuration(dataUrl: string, fallbackText = ''): Promise<number> {
  try {
    const AC: typeof AudioContext = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    const buf = await ctx.decodeAudioData(await (await fetch(dataUrl)).arrayBuffer());
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

/** 任意音频 → 单声道 WAV（各家要求的采样率不同，见 clone 行的 refSampleRateHz） */
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
  for (let i = 0; i < len; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, ch[i]));
    dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** 解析 dataURL 音频为 Blob（导入时用） */
export async function readAudioFile(file: File): Promise<{ dataUrl: string; durationSec: number }> {
  const dataUrl = await blobToDataUrl(file);
  const durationSec = await decodeAudioDuration(dataUrl);
  return { dataUrl, durationSec };
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

export type { ProviderKind };
