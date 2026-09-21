import type { ProviderConfig, ProviderEndpoint } from '../types';
import { IS_DESKTOP } from './backend';
import { recipeById, type Recipe } from './recipes';
import {
  callEndpoint, EngineError, type CallResult, type EndpointTemplate,
  type ReqCtx, type ResolvedRequest, type Role, type SendResult,
} from './request-engine';

/**
 * providers.ts — 供应商调用门面（薄壳）
 *
 * 这里**不再有协议分支**：怎么发请求由 `recipe` 铺出的一组接口模板决定（见 docs/provider-engine.md）。
 * 本文件只做三件事：把 ProviderConfig 变成引擎上下文、注入传输（桌面走主进程 / 网页走 fetch）、
 * 把引擎结果换算成界面要用的形状（dataURL、时长、voice_id…）。
 * 历史上这里是 renderer 的 6 条 switch + 主进程再来一份，同一条事实四处维护，事故见 AGENTS §6.22 / §6.24。
 */

// ========== 模板取用 ==========

/** 取该供应商某个角色的接口模板（配置里的 endpoints 优先，没配则按模板包现铺） */
export function endpointOf(cfg: ProviderConfig, role: Role): ProviderEndpoint | undefined {
  const rows = cfg.endpoints?.length ? cfg.endpoints : endpointsOfRecipe(cfg.recipe);
  return rows.find((e) => e.role === role && e.enabled !== false);
}

/** 这个供应商能不能做某件事（例：VoicePicker 用它决定「克隆音色」区显示与否） */
export function supports(cfg: ProviderConfig | null | undefined, role: Role): boolean {
  return !!cfg && !!endpointOf(cfg, role);
}

export function recipeOf(cfg: ProviderConfig | null | undefined): Recipe | undefined {
  return cfg ? recipeById(cfg.recipe) : undefined;
}

/** 按模板包铺出接口行（新建供应商 / 老库升级时都用它） */
export function endpointsOfRecipe(recipeId: string): ProviderEndpoint[] {
  const r = recipeById(recipeId);
  return (r?.roles ?? []).map((t) => ({ ...t, enabled: true }));
}

/** 新建一份供应商配置（key 留空待填） */
export function configFromRecipe(recipeId: string, kind: 'llm' | 'tts' | 'image'): ProviderConfig {
  const r = recipeById(recipeId);
  return {
    id: `${recipeId}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    recipe: recipeId,
    label: r ? (typeof r.label === 'string' ? r.label : r.label.zh) : recipeId,
    baseUrl: r?.baseUrl ?? '',
    secrets: { apiKey: '' },
    model: r?.defaultModel ?? '',
    voice: r?.defaultVoice,
    speed: 1,
    endpoints: endpointsOfRecipe(recipeId),
  };
}

/** 参考音频转码采样率：CosyVoice 16k、Qwen-TTS ≥24k，各家不同，写死过一次就出事 */
export function refSampleRateOf(cfg: ProviderConfig): number {
  return recipeOf(cfg)?.clone?.refSampleRateHz ?? 16000;
}

/** 该供应商的候选模型（模板包给的列表，UI 下拉用） */
export function modelsOf(cfg: ProviderConfig): string[] {
  return recipeOf(cfg)?.models ?? [];
}

// ========== 引擎上下文 ==========

function deepMerge(target: unknown, patch: unknown): unknown {
  if (!isObj(patch)) return target;
  const base = isObj(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    base[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  }
  return base;
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function ctxOf(cfg: ProviderConfig, inputs: Record<string, unknown> = {}): ReqCtx {
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    voice: cfg.voice,
    speed: cfg.speed ?? 1,
    secrets: { apiKey: cfg.secrets?.apiKey ?? '', secret2: cfg.secrets?.secret2 ?? '' },
    ...inputs,
  };
}

/** 引擎只认模板，配置期参数与 extra 兜底在这里并进 ctx / body */
async function runRole(
  cfg: ProviderConfig,
  role: Role,
  inputs: Record<string, unknown>,
): Promise<CallResult> {
  const row = endpointOf(cfg, role);
  if (!row) throw new EngineError(`这个供应商没配 ${role} 接口（去 ⚙ 设置 · AI 检查）`);
  const tpl: EndpointTemplate = row;
  const ctx = ctxOf(cfg, { ...(row.overrides ?? {}), ...inputs });
  let extra: Record<string, unknown> | null = null;
  if (cfg.extra?.trim()) {
    try { extra = JSON.parse(cfg.extra) as Record<string, unknown>; }
    catch { throw new EngineError('附加参数（extra）不是合法 JSON'); }
  }
  const send = async (req: ResolvedRequest): Promise<SendResult> =>
    rawSend(extra ? { ...req, body: deepMerge(req.body, extra) } : req);
  // 异步的查询接口就在同一供应商名下，按 role 取
  const statusTemplates: Partial<Record<Role, EndpointTemplate>> = {};
  for (const e of cfg.endpoints ?? []) statusTemplates[e.role] = e;
  return callEndpoint(tpl, ctx, { send, fetchBytes }, statusTemplates);
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
    res = await fetch(url.href, {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' ? undefined : JSON.stringify(req.body ?? {}),
    });
  } catch {
    throw new EngineError('请求失败（可能被 CORS 拦截）——桌面版无此限制，或把 Base URL 换成自己的代理地址');
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.startsWith('application/json') || ct.includes('json')) {
    return { status: res.status, contentType: ct, json: await res.json().catch(() => undefined), text: undefined };
  }
  if (ct.startsWith('text/') || ct.includes('xml')) {
    return { status: res.status, contentType: ct, text: await res.text() };
  }
  const buf = await res.arrayBuffer();
  return { status: res.status, contentType: ct, bytes: new Uint8Array(buf) };
}

async function fetchBytes(url: string): Promise<{ bytes: Uint8Array; mime?: string }> {
  if (IS_DESKTOP) {
    const r = await window.mapvideo!.net.fetchUrl(url);
    if (r.error) throw new EngineError(r.error);
    return { bytes: new Uint8Array(r.bytes ?? new ArrayBuffer(0)), mime: r.contentType };
  }
  const res = await fetch(url);
  if (!res.ok) throw new EngineError(`下载结果失败 HTTP ${res.status}`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime: res.headers.get('content-type') || undefined };
}

// ========== 对外四个动作（签名与旧版一致，调用点不用改） ==========

export async function callLLM(cfg: ProviderConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  const r = await runRole(cfg, 'llm.generate', { systemPrompt, userPrompt });
  const text = r.values.text;
  if (typeof text !== 'string') throw new EngineError('响应里没取到文本，检查「接口模板 → 出参取法」');
  return text;
}

export interface TtsResult {
  /** dataURL（blob 转存） */
  dataUrl: string;
  durationSec: number;
}

export async function callTTS(cfg: ProviderConfig, text: string): Promise<TtsResult> {
  const r = await runRole(cfg, 'tts.synthesize', { text, reqId: `mv-${Date.now()}` });
  if (!r.bytes?.length) throw new EngineError('没拿到音频：检查模板的出参取法 / 解码方式');
  const blob = new Blob([r.bytes], { type: r.mime || 'audio/mpeg' });
  const dataUrl = await blobToDataUrl(blob);
  return { dataUrl, durationSec: await decodeAudioDuration(dataUrl, text) };
}

/** 文生图：返回 URL 或 dataURL */
export async function callImage(cfg: ProviderConfig, prompt: string): Promise<string> {
  const r = await runRole(cfg, 'image.generate', { prompt });
  const url = r.values.image ?? r.values.url;
  if (typeof url === 'string' && url) return normalizeImage(url);
  if (r.bytes?.length) return `data:${r.mime || 'image/png'};base64,${bytesToBase64(r.bytes)}`;
  throw new EngineError('响应里没取到图片，检查「接口模板 → 出参取法」');
}

/** 参考音频 → 音色 ID。targetModel 必须与之后合成用的 model 一致。 */
export async function cloneVoice(cfg: ProviderConfig, refBytes: ArrayBuffer, targetModel: string, prefix = 'mv'): Promise<string> {
  const wav = await toWavMono(refBytes, refSampleRateOf(cfg));
  if (wav.length > 10 * 1024 * 1024) throw new EngineError('参考音频超过 10MB');
  const r = await runRole(cfg, 'tts.clone', {
    wavB64: bytesToBase64(wav),
    prefix,
    preferredName: String(prefix || 'mv').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'mv',
    model: targetModel || cfg.model,
  });
  const vid = r.values.voiceId ?? r.values.voice;
  if (typeof vid !== 'string' || !vid) throw new EngineError('克隆响应里没取到音色 ID，检查「出参取法」');
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

/** 任意音频 → 单声道 WAV（各家要求的采样率不同，见 recipe.clone.refSampleRateHz） */
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
      // 去掉序号行与时间轴行
      return lines
        .filter((l) => !/^\d+$/.test(l.trim()) && !/-->\s|\d{2}:\d{2}:\d{2}/.test(l))
        .join(' ')
        .trim();
    })
    .filter((x) => x);
}
