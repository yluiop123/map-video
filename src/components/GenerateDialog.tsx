/**
 * 一键生成：需求 → LLM 文案（整片一条连续脚本：字幕 + 弹窗 + 特效 + 元素）→ 人工确认 → 可选配音 → 生成时间线。
 * 不分段落；第一步只出文案，确认后才生成配音；生成后可继续编辑。
 */
import { useState } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useEditorStore } from '../stores/editorStore';
import { useProviderStore, activeProvider } from '../stores/providerStore';
import { useT } from './ui/primitives';
import { callLLM, callTTS } from '../lib/providers';
import { extractPlaces, extractCandidateNames, type Place } from '../lib/gazetteer';
import { geocodePlace } from '../lib/geocode';
import { buildGeneratedElement, buildGeneratedTerritory, type GenElementSpec } from '../lib/generate-elements';
import {
  estimateTextDurationFrames, generateId, defaultPersonContent,
  type NarrationEntry, type GeneratedChapterPlan, type GeneratedOverlaySpec,
  type OverlayType, type OverlayPosition, type OverlayContent, type ChartType,
  type ScreenFxType, type MapElement,
} from '../types';

interface GenOverlay {
  kind: string;                       // quote | timeline | compare | chart | person
  title?: string;
  text?: string;
  source?: string;
  name?: string;
  intro?: string;
  quote?: string;
  value?: number;
  prefix?: string;
  items?: { time?: string; text: string }[];
  left?: { label: string; value: number };
  right?: { label: string; value: number };
  unit?: string;
  data?: { label: string; value: number }[];
}
interface GenChapter {
  title: string;
  subtitles: string[];
  fx?: string[];
  overlays?: GenOverlay[];
  elements?: GenElementSpec[];
}

const FXS = new Set(['vignette', 'fadeBlack', 'fadeWhite', 'flash']);

/** 解析为**整片一条连续脚本**（不分段）。兼容旧的整片 JSON：合并所有段为一条。 */
function parsePlan(raw: string): GenChapter[] {
  let obj: unknown = null;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    obj = JSON.parse(m ? m[0] : raw);
  } catch { obj = null; }
  const root = (obj && typeof obj === 'object' ? obj : {}) as Record<string, unknown>;
  const sources: Record<string, unknown>[] = Array.isArray(root.chapters)
    ? (root.chapters as Record<string, unknown>[])
    : [root];

  const subtitles: string[] = [];
  const overlays: GenOverlay[] = [];
  const elements: GenElementSpec[] = [];
  const fx: string[] = [];
  let title = typeof root.title === 'string' ? root.title.trim() : '';
  for (const c of sources) {
    if (!title && typeof c.title === 'string') title = c.title.trim();
    if (Array.isArray(c.subtitles)) {
      for (const s of c.subtitles) if (typeof s === 'string' && s.trim()) subtitles.push(s.trim());
    }
    if (Array.isArray(c.overlays)) overlays.push(...(c.overlays as GenOverlay[]));
    if (Array.isArray(c.elements)) elements.push(...(c.elements as GenElementSpec[]));
    if (Array.isArray(c.fx)) for (const f of c.fx) if (typeof f === 'string') fx.push(f);
  }
  if (!subtitles.length) {
    const lines = raw.split('\n').map((l) => l.replace(/^\s*[\d.、.\-]+\s*/, '').trim()).filter(Boolean);
    if (!lines.length) return [{ title, subtitles: [] }];
    return [{ title: title || '生成内容', subtitles: lines }];
  }
  return [{
    title,
    subtitles,
    fx: fx.length ? fx : undefined,
    overlays: overlays.length ? overlays : undefined,
    elements: elements.length ? elements : undefined,
  }];
}

/** 把生成弹窗规格转成 store 可用的帧化规格（时间按“首次提及”摆放） */
function buildOverlays(
  gen: GenChapter,
  opt: { holdFrames: number; mentionAt: (names: string[]) => number },
): GeneratedOverlaySpec[] {
  const specs: GeneratedOverlaySpec[] = [];
  const hold = Math.max(1, Math.round(opt.holdFrames));
  const list = gen.overlays || [];
  for (let idx = 0; idx < list.length; idx++) {
    const o = list[idx];
    const kind = (o.kind || '').toLowerCase();
    let type: OverlayType | null = null;
    let position: OverlayPosition = 'right';
    let content: OverlayContent | null = null;
    if (kind === 'quote' && o.text) {
      type = 'quote'; position = 'bottom';
      content = { type: 'quote', quote: { text: o.text, source: o.source } };
    } else if (kind === 'timeline' && o.items?.length) {
      type = 'timeline'; position = 'left';
      content = { type: 'timeline', timeline: { title: o.title, items: o.items } };
    } else if (kind === 'compare' && o.left && o.right) {
      type = 'compare'; position = 'center';
      content = { type: 'compare', compare: { title: o.title, left: o.left, right: o.right, unit: o.unit } };
    } else if (kind === 'chart' && o.data?.length) {
      type = 'chart'; position = 'right';
      content = { type: 'chart', chart: { type: 'bar' as ChartType, title: o.title, data: o.data } };
    } else if (kind === 'stat' && (o.value != null || o.text)) {
      type = 'stat'; position = 'center';
      const num = o.value != null ? Number(o.value) : parseFloat(String(o.text).replace(/[^\d.]/g, ''));
      content = { type: 'stat', stat: { value: Number.isFinite(num) ? num : 0, label: o.title, prefix: o.prefix, unit: o.unit, countUp: true } };
    } else if (kind === 'person' && (o.name || o.text)) {
      type = 'person'; position = 'right';
      content = {
        type: 'person',
        person: {
          ...defaultPersonContent(),
          name: o.name || o.text || '',
          title: o.title,
          intro: o.intro,
          quote: o.quote,
          showImage: false,
          imageShape: 'square',
        },
      };
    }
    if (!type || !content) continue;
    const names = [o.title, o.text, o.source, o.name].filter((x): x is string => !!x);
    specs.push({ type, position, content, startOffset: opt.mentionAt(names), duration: hold, animation: 'fadeIn', exitAnimation: 'fadeOut' });
  }
  return specs;
}

/** 把生成元素的相对时间与关键帧整体平移到 startRel，并设显示时长 hold（帧） */
function shiftElementTime(el: MapElement, startRel: number, hold: number): MapElement {
  const off = Math.max(0, startRel);
  const e = { ...el } as Record<string, unknown>;
  const shift = (arr: unknown): unknown =>
    Array.isArray(arr) ? arr.map((k) => ({ ...(k as object), frame: (k as { frame: number }).frame + off })) : arr;
  e.startFrame = off;
  e.endFrame = off + Math.max(1, hold);
  for (const key of ['drawProgress', 'progress', 'pathProgress', 'fillProgress', 'morphKeyframes']) e[key] = shift(e[key]);
  const style = e.style as Record<string, unknown> | undefined;
  if (style) e.style = { opacity: shift(style.opacity), scale: shift(style.scale), rotation: shift(style.rotation) };
  return e as unknown as MapElement;
}

export function GenerateDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const project = useProjectStore((s) => s.project);
  const applyGeneratedProject = useProjectStore((s) => s.applyGeneratedProject);
  const setCurrentFrame = useEditorStore((s) => s.setCurrentFrame);
  const llmList = useProviderStore((s) => s.llm);
  const ttsList = useProviderStore((s) => s.tts);

  const [topic, setTopic] = useState('');
  const [reference, setReference] = useState('');
  // 整片一条连续脚本；此值仅作「无内容时」的时长兜底
  const secondsPerChapter = 20;
  const [withTts, setWithTts] = useState(false);
  const [plan, setPlan] = useState<GenChapter[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  // 地名解析：本地库未命中且联网也查不到 → 待用户手工提供坐标
  const [unresolved, setUnresolved] = useState<{ ci: number; name: string }[] | null>(null);
  const [placeInputs, setPlaceInputs] = useState<Record<string, string>>({});
  const [pendingPlaces, setPendingPlaces] = useState<Place[][] | null>(null);

  void llmList; void ttsList; // 订阅服务状态
  const fps = project?.globalConfig.defaultFPS || 30;

  const llm = activeProvider('llm');
  const tts = activeProvider('tts');
  const hasContent = !!plan?.some((c) => c.subtitles.some((s) => s.trim()));

  const genText = async () => {
    if (!project) return;
    if (!topic.trim()) { setError(t('请先填写你的需求', 'Enter your requirements first')); return; }
    if (!llm || !llm.baseUrl) { setError(t('未配置文案生成服务（顶栏 ⚙ 设置）', 'No LLM provider configured (top-bar ⚙)')); return; }
    setBusy(true); setError(null); setPlan(null);
    try {
      const sys = '你是历史/军事题材「地图讲解视频」的策划。根据用户需求与参考，输出整片一条连续的口播脚本，只返回 JSON。';
      const user = [
        `【需求】\n${topic.trim()}`,
        reference.trim() && `【参考资料】\n${reference.trim()}`,
        [
          '【输出要求】',
          '- 整片**一条连续脚本**（不要分段/整片），8–24 条口播字幕，按时间顺序排列，每条不超过 40 字，语言与需求一致',
          '- 给整片一个 12 字以内的标题',
          '- 可选 0–3 个弹窗 overlays，kind 取：',
          '  quote(引用，需 text/source) / person(人物卡，需 name，可选 title(职务)/intro(简介)/quote(名言))',
          '  stat(数字卡，需 value，可选 title(标签)/prefix(前缀)/unit(单位))',
          '  timeline(需 items[{time,text}]) / compare(需 left/right{label,value} 与 unit) / chart(需 data[{label,value}])',
          '- 可选画面特效 fx，取值：' + [...FXS].join('/'),
          '- 可选 0–4 个地图元素 elements（表达行军/攻守/疆域，地名必须是字幕里出现的中文地名）：',
          '  {"kind":"route","places":["咸阳","邯郸"],"label":"秦军东进","animate":"move"} 或 {"kind":"arrow","places":["起点","终点"],"label":"进攻","arrowType":"attack"}',
          '  {"kind":"double_arrow","places":["A","B"]} / {"kind":"encircle","at":"邯郸","radiusKm":60,"label":"包围"} / {"kind":"gather","at":"咸阳","radiusKm":50}',
          '  {"kind":"polygon","places":["A","B","C"],"label":"战区"} / {"kind":"circle","at":"洛阳","radiusKm":80} / {"kind":"flag","at":"邯郸","label":"赵都"}',
          '  {"kind":"territory","region":"中国","label":"秦"（region 用国家/地区名，如 中国/韩国/日本/俄罗斯）}',
          '- 只输出 JSON：{"title":"…","subtitles":["…"],"fx":["vignette"],"overlays":[{"kind":"quote","text":"…","source":"…"}],"elements":[{"kind":"arrow","places":["咸阳","邯郸"],"label":"秦军东进"}]}',
        ].join('\n'),
      ].filter(Boolean).join('\n\n');

      setProgress(t('正在生成文案…', 'Generating script…'));
      const raw = await callLLM(llm, sys, user);
      const parsed = parsePlan(raw);
      if (!parsed[0]?.subtitles.length) throw new Error(t('模型未返回可用内容', 'Model returned no usable content'));
      setPlan(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false); setProgress('');
    }
  };

  const blobOf = (ch: GenChapter) =>
    [
      ch.title,
      ...ch.subtitles,
      ...(ch.overlays || []).map((o) => [o.title, o.text, o.source, (o.items || []).map((x) => x.text).join(' ')].filter(Boolean).join(' ')),
      ...(ch.elements || []).map((e) => [e.label, e.region, ...(e.places || []), e.at].filter(Boolean).join(' ')),
    ].filter(Boolean).join(' ');

  /** ① 解析地名：本地库 → 联网 → 收集查不到的（暂停等用户提供坐标） */
  const confirm = async () => {
    if (!project || !plan) return;
    setBusy(true); setError(null);
    try {
      setProgress(t('正在解析地名…', 'Resolving places…'));
      const per: Place[][] = plan.map((ch) => extractPlaces(blobOf(ch), 4));
      const miss: { ci: number; name: string }[] = [];
      for (let i = 0; i < plan.length; i++) {
        const localNames = per[i].map((p) => p.name);
        for (const cand of extractCandidateNames(blobOf(plan[i]), localNames, 3)) {
          setProgress(t(`联网查询地名：${cand}…`, `Looking up place: ${cand}…`));
          const hit = await geocodePlace(cand);
          if (hit) per[i].push({ name: cand, center: hit.center, zoom: hit.zoom });
          else miss.push({ ci: i, name: cand });
        }
      }
      if (miss.length) { setPendingPlaces(per); setUnresolved(miss); return; }
      await finish(per, []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false); setProgress('');
    }
  };

  /** ② 建章：TTS / 弹窗 / 特效 / 相机 / 落点 */
  const finish = async (per: Place[][], extra: { ci: number; name: string; center: [number, number] }[]) => {
    if (!project || !plan) return;
    const doTts = withTts && tts && tts.baseUrl;
    setBusy(true); setError(null);
    try {
      const total = plan.reduce((a, c) => a + c.subtitles.length, 0);
      let done = 0;
      let terrMiss = 0;
      const items: GeneratedChapterPlan[] = [];
      for (let i = 0; i < plan.length; i++) {
        const ch = plan[i];
        const entries: NarrationEntry[] = [];
        for (const txt of ch.subtitles) {
          let durationFrames = estimateTextDurationFrames(txt, fps);
          let audioUrl: string | undefined;
          if (doTts) {
            setProgress(t(`正在生成配音 ${done + 1}/${total}…`, `Generating voiceover ${done + 1}/${total}…`));
            try {
              const r = await callTTS(tts!, txt);
              audioUrl = r.dataUrl;
              durationFrames = Math.max(1, Math.round(r.durationSec * fps));
            } catch { /* 单条失败退回估算时长 */ }
          }
          entries.push({ id: generateId(), text: txt, durationFrames, startFrame: 0, audioUrl, status: audioUrl ? 'ready' : 'none' });
          done++;
        }
        // 每条字幕的相对起始帧：用于按「首次提及」给元素/弹窗定时
        const entryStarts: number[] = [];
        let acc = 0;
        for (const e of entries) { entryStarts.push(acc); acc += Math.max(1, e.durationFrames); }
        const holdFrames = Math.max(1, Math.round(5 * fps));
        const mentionAt = (names: string[]): number => {
          const keys = names.filter((x) => x && x.length >= 2);
          if (!keys.length) return 0;
          for (let si = 0; si < ch.subtitles.length; si++) {
            const txt = ch.subtitles[si];
            if (keys.some((k) => txt.includes(k))) return entryStarts[si] ?? 0;
          }
          return 0;
        };

        // 地名 → 相机中心 + 落点标记（本地库 + 联网 + 用户手工补充）
        const places: Place[] = [
          ...per[i],
          ...extra.filter((e) => e.ci === i).map((e) => ({ name: e.name, center: e.center, zoom: undefined })),
        ];
        // 元素意图 → 内置元素（路线/箭头/包围/集结/形状/旗标/疆域…）
        const byName = new Map<string, [number, number]>(places.map((p) => [p.name, p.center]));
        const duration = Math.max(1, Math.round(secondsPerChapter * fps));
        const genElements: MapElement[] = [];
        for (const spec of ch.elements || []) {
          const namesForEl = [spec.label, spec.at, spec.region, ...(spec.places || [])].filter((x): x is string => !!x);
          const at = mentionAt(namesForEl);
          if ((spec.kind || '').toLowerCase() === 'territory') {
            setProgress(t(`正在构造疆域：${spec.region || spec.label || ''}…`, `Building territory: ${spec.region || spec.label || ''}…`));
            const el = spec.region ? await buildGeneratedTerritory(spec.region, duration) : null;
            if (el) genElements.push(shiftElementTime(el, at, Math.max(holdFrames, Math.round(8 * fps))));
            else terrMiss++;
          } else {
            const el = buildGeneratedElement(spec, byName, duration);
            if (el) genElements.push(shiftElementTime(el, at, holdFrames));
          }
        }
        items.push({
          title: ch.title,
          entries,
          elements: genElements,
          overlays: buildOverlays(ch, { holdFrames, mentionAt }),
          fx: (ch.fx || []).filter((f) => FXS.has(f)).slice(0, 2) as ScreenFxType[],
          cameraTarget: places[0] ? { center: places[0].center, zoom: places[0].zoom } : undefined,
          markers: places.map((p) => ({ name: p.name, center: p.center })),
        });
      }
      setProgress(t('正在生成时间线…', 'Building timeline…'));
      applyGeneratedProject(items, secondsPerChapter);
      setCurrentFrame(0);
      if (terrMiss > 0) {
        const parts: string[] = [];
        if (terrMiss > 0) parts.push(t(`${terrMiss} 个疆域未找到边界数据`, `${terrMiss} territory region(s) not found`));
        alert(t(`时间线已生成；但 ${parts.join('、')}。可在对应页签手动补。`, `Timeline built, but ${parts.join(', ')}. Add them manually.`));
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false); setProgress('');
    }
  };

  /** 用户填完坐标后继续 */
  const resume = () => {
    if (!unresolved || !pendingPlaces) return;
    const parse = (s: string): [number, number] | null => {
      const nums = s.split(/[,，\s]+/).map((x) => parseFloat(x)).filter((x) => Number.isFinite(x));
      return nums.length >= 2 ? [nums[0], nums[1]] : null;
    };
    const extra = unresolved
      .map((u) => {
        const c = parse(placeInputs[`${u.ci}:${u.name}`] || '');
        return c ? { ci: u.ci, name: u.name, center: c } : null;
      })
      .filter((x): x is { ci: number; name: string; center: [number, number] } => !!x);
    setUnresolved(null);
    finish(pendingPlaces, extra);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div className="bg-card border border-white/10 rounded-xl shadow-2xl p-4 w-[34rem] max-h-[88vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold mb-2">✨ {t('一键生成', 'One-click generate')}</h3>

        <textarea value={topic} onChange={(e) => setTopic(e.target.value)} rows={4} className="input text-xs resize-none mb-2" placeholder={t('描述你的需求（主题 / 大纲 / 风格 / 口吻 / 受众 / 时长 / 侧重点…任何要求）', 'Describe your requirements (topic / outline / style / tone / audience / length … anything)')} />

        <div className="flex items-center gap-2 mb-1">
          <span className="text-[11px] text-muted-foreground shrink-0">{t('参考资料', 'Reference')}</span>
          <label className="inline-flex items-center gap-1.5 h-6 px-2 rounded-md border border-white/15 bg-white/[0.045] text-[11px] hover:border-white/25 cursor-pointer transition-colors">
            ⬆ {t('上传（txt/md/json）', 'Upload (txt/md/json)')}
            <input
              type="file"
              accept=".txt,.md,.markdown,.json,.csv,text/*"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) {
                  try {
                    const text = await f.text();
                    setReference((prev) => (prev ? prev + '\n\n' + text : text));
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  }
                }
                e.target.value = '';
              }}
            />
          </label>
        </div>
        <textarea value={reference} onChange={(e) => setReference(e.target.value)} rows={3} className="input text-xs resize-none mb-2" placeholder={t('可粘贴，或上传文件后自动填入', 'Paste, or upload a file to fill in')} />

        {progress && <p className="text-[11px] text-sky-400/90 mb-2">{progress}</p>}
        {error && <p className="text-[11px] text-red-400/90 mb-2">{error}</p>}

        {!plan && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPlan([{ title: '', subtitles: [''] }])}
              disabled={busy}
              className="h-8 px-3 rounded-md border border-white/15 text-xs hover:bg-white/10 disabled:opacity-40"
              title={t('不用 AI，手工写文案', 'No AI: write the script manually')}
            >
              ＋ {t('手动填写文案', 'Write script manually')}
            </button>
            <div className="flex-1" />
            <button onClick={onClose} disabled={busy} className="h-8 px-3 rounded-md border border-white/15 text-xs hover:bg-white/10 disabled:opacity-40">{t('取消', 'Cancel')}</button>
            <button onClick={genText} disabled={busy || !topic.trim() || !llm?.baseUrl} className="h-8 px-3.5 rounded-md bg-white text-black text-xs font-medium hover:bg-white/90 disabled:opacity-40">
              {busy ? t('生成中…', 'Working…') : t('① AI 生成文案', '① AI generate script')}
            </button>
          </div>
        )}

        {plan && (
          <>
            <div className="border-t border-white/10 pt-2 mb-2">
              <p className="text-[11px] text-muted-foreground mb-1">{t('确认/编辑文案（每行一条字幕）', 'Confirm/edit script (one subtitle per line)')}</p>
              <div className="space-y-2 max-h-[38vh] overflow-y-auto pr-1">
                {(() => {
                  const ch = plan[0];
                  return (
                    <div className="rounded-md border border-white/10 bg-white/[0.03] p-2 space-y-1">
                      <textarea
                        value={ch.subtitles.join('\n')}
                        onChange={(e) => setPlan([{ ...ch, subtitles: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) }])}
                        rows={Math.min(14, Math.max(4, ch.subtitles.length))}
                        className="input text-xs resize-none w-full"
                        placeholder={t('每行一条字幕', 'One subtitle per line')}
                      />
                      <div className="text-[10px] text-muted-foreground">
                        {ch.fx?.length ? `特效: ${ch.fx.join(',')}` : ''}
                        {ch.overlays?.length ? ` · 弹窗: ${ch.overlays.map((o) => o.kind).join(',')}` : ''}
                        {ch.elements?.length ? ` · 元素: ${ch.elements.map((e) => e.kind).join(',')}` : ''}
                        {(() => {
                          const p = extractPlaces([ch.title, ...ch.subtitles].join(' '), 4).map((x) => x.name);
                          return p.length ? ` · 地名: ${p.join(',')}` : '';
                        })()}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>

            <div className="flex items-center gap-3 mb-2 flex-wrap">
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={withTts} disabled={!tts?.baseUrl} onChange={(e) => setWithTts(e.target.checked)} />
                {t('② 生成配音（耗时）', '② Generate voiceover (slow)')}
              </label>
            </div>

            {unresolved && (
              <div className="border-t border-white/10 pt-2 mb-2">
                <p className="text-[11px] text-amber-400/90 mb-1">
                  {t('以下地名本地库与联网均未找到，请填坐标（经度,纬度），留空则跳过：', 'Not found locally or online — enter coordinates (lng,lat), or leave blank to skip:')}
                </p>
                <div className="space-y-1 max-h-[24vh] overflow-y-auto pr-1">
                  {unresolved.map((u) => {
                    const key = `${u.ci}:${u.name}`;
                    return (
                      <div key={key} className="flex items-center gap-2">
                        <span className="text-[11px] w-24 truncate" title={u.name}>{u.name}</span>
                        <span className="text-[10px] text-muted-foreground truncate flex-1">{plan[u.ci]?.title}</span>
                        <input
                          value={placeInputs[key] || ''}
                          onChange={(e) => setPlaceInputs((p) => ({ ...p, [key]: e.target.value }))}
                          placeholder="116.4,39.9"
                          className="input h-7 text-xs w-28 shrink-0"
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setPlan(null); setUnresolved(null); setPendingPlaces(null); setPlaceInputs({}); }}
                disabled={busy}
                className="h-8 px-3 rounded-md border border-white/15 text-xs hover:bg-white/10 disabled:opacity-40"
              >{t('返回重写', 'Back')}</button>
              <button
                onClick={unresolved ? resume : confirm}
                disabled={busy || !hasContent}
                className="h-8 px-3.5 rounded-md bg-white text-black text-xs font-medium hover:bg-white/90 disabled:opacity-40"
              >
                {busy ? t('生成中…', 'Working…') : unresolved ? t('继续生成', 'Continue') : t('② 确认并生成', '② Confirm & build')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
