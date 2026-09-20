/**
 * 字幕生成：需求 → LLM 文案（整片一条连续脚本：字幕 + 弹窗 + 特效 + 元素）→ 逐行确认与配音 → 生成时间线。
 * 这里同时是**字幕条目与字幕样式的唯一编辑处**（特效弹窗已无字幕页签）：
 * 项目已有字幕时可直接「编辑现有字幕」，该模式只改 narration，不动元素 / 弹窗 / 相机。
 */
import { useState } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useEditorStore } from '../stores/editorStore';
import { useProviderStore, activeProvider } from '../stores/providerStore';
import { useT, Section, Field, OptionBlocks, ColorPicker, NumberInput } from './ui/primitives';
import { callLLM, callTTS, parseSrt, srtTime } from '../lib/providers';
import { extractPlaces, extractCandidateNames, type Place } from '../lib/gazetteer';
import { geocodePlace } from '../lib/geocode';
import { buildGeneratedElement, buildGeneratedTerritory, type GenElementSpec } from '../lib/generate-elements';
import {
  estimateTextDurationFrames, generateId, defaultPersonContent, defaultNarrationStyle,
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

/** 一行 = 一条字幕 + 它自己的配音（可单独生成 / 覆盖） */
interface SubRow {
  id: string;
  ci: number;
  text: string;
  audioUrl?: string;
  durationFrames: number;
  startFrame: number;
  status?: 'none' | 'pending' | 'ready' | 'error';
  /** 在时间线上手动拖过 → 保住起点，不参与顺排 */
  locked?: boolean;
}

/** 顺排：未锁定的行首尾相接；锁定行保住自己的起点，并把游标推到它之后 */
function resequenceRows(rows: SubRow[]): SubRow[] {
  let cursor = 0;
  return rows.map((r) => {
    const dur = Math.max(1, r.durationFrames);
    if (r.locked) {
      const s0 = Math.max(cursor, r.startFrame);
      cursor = s0 + dur;
      return { ...r, startFrame: s0 };
    }
    const s0 = cursor;
    cursor = s0 + dur;
    return { ...r, startFrame: s0 };
  });
}

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
  const [plan, setPlan] = useState<GenChapter[] | null>(null);
  /** 逐行字幕（含各自的配音）——步骤②的编辑对象，也是「编辑现有字幕」模式的工作集 */
  const [rows, setRows] = useState<SubRow[]>([]);
  /** 只改字幕/配音，不动元素 / 弹窗 / 特效 / 相机 */
  const [editOnly, setEditOnly] = useState(false);
  const [genIdx, setGenIdx] = useState<number | null>(null);
  const [auditingId, setAuditingId] = useState<string | null>(null);
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
  const hasContent = rows.some((r) => r.text.trim());
  const style = project?.narration?.style || defaultNarrationStyle();
  const setStyle = useProjectStore((s) => s.setNarrationStyle);

  const mkRow = (text: string, ci: number, over?: Partial<SubRow>): SubRow => ({
    id: generateId(), ci, text,
    durationFrames: estimateTextDurationFrames(text, fps),
    startFrame: 0, status: 'none', ...over,
  });

  /** 改文本：已有配音则保住音频时长，否则按字数重估 */
  const editText = (id: string, text: string) => setRows((rs) => resequenceRows(rs.map((r) => (
    r.id === id
      ? { ...r, text, durationFrames: r.audioUrl ? r.durationFrames : estimateTextDurationFrames(text, fps) }
      : r
  ))));
  const addRow = () => setRows((rs) => [...rs, mkRow('', rs.length ? rs[rs.length - 1].ci : 0)]);
  const delRow = (id: string) => setRows((rs) => resequenceRows(rs.filter((r) => r.id !== id)));

  /** 单行生成配音（已有音频即覆盖） */
  const genRow = async (idx: number) => {
    const r = rows[idx];
    if (!r || !r.text.trim()) { setError(t('请先填写字幕文本', 'Fill in this line first')); return; }
    if (!tts?.baseUrl) { setError(t('未配置语音服务（顶栏 ⚙ 设置）', 'No TTS provider configured')); return; }
    setGenIdx(idx); setError(null);
    setRows((rs) => rs.map((x, i) => (i === idx ? { ...x, status: 'pending' } : x)));
    try {
      const { dataUrl, durationSec } = await callTTS(tts, r.text);
      setRows((rs) => resequenceRows(rs.map((x, i) => (
        i === idx
          ? { ...x, audioUrl: dataUrl, durationFrames: Math.max(1, Math.round(durationSec * fps)), status: 'ready' as const }
          : x
      ))));
    } catch (err) {
      setRows((rs) => rs.map((x, i) => (i === idx ? { ...x, status: 'error' as const } : x)));
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenIdx(null);
    }
  };

  /** 全部生成：串行避免限流；只补没有配音的行（已有的行保持不动） */
  const genAllMissing = async () => {
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].text.trim() || rows[i].audioUrl) continue;
      await genRow(i);
    }
  };

  const audit = (r: SubRow) => {
    if (!r.audioUrl) return;
    const el = new Audio(r.audioUrl);
    setAuditingId(r.id);
    el.onended = () => setAuditingId(null);
    el.play().catch(() => setAuditingId(null));
  };

  const importSrt = async (file: File) => {
    try {
      const texts = parseSrt(await file.text());
      if (!texts.length) { setError(t('SRT 里没有可用文本', 'No usable cues in this SRT')); return; }
      setRows(resequenceRows(texts.map((txt) => mkRow(txt, 0))));
      setPlan((prev) => prev || [{ title: '', subtitles: texts }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const exportSrt = () => {
    const srt = resequenceRows(rows)
      .filter((r) => r.text.trim())
      .map((r, i) => {
        const s0 = r.startFrame / fps;
        const s1 = s0 + r.durationFrames / fps;
        return `${i + 1}\n${srtTime(s0)} --> ${srtTime(s1)}\n${r.text}\n`;
      })
      .join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([srt], { type: 'text/plain;charset=utf-8' }));
    a.download = `${project?.name || 'narration'}.srt`;
    a.click();
  };

  /** 直接编辑项目现有字幕（不跑 AI、不动其它内容） */
  const loadExisting = () => {
    const es = project?.narration?.entries || [];
    setRows(es.map((e) => ({
      id: e.id, ci: 0, text: e.text, audioUrl: e.audioUrl, durationFrames: Math.max(1, e.durationFrames),
      startFrame: e.startFrame, status: e.status, locked: e.locked,
    })));
    setPlan([{ title: '', subtitles: es.map((e) => e.text) }]);
    setEditOnly(true);
  };

  /** 把 rows 落成 NarrationEntry（顺排后的绝对帧） */
  const rowsToEntries = (rs: SubRow[]): NarrationEntry[] => resequenceRows(rs)
    .filter((r) => r.text.trim())
    .map((r) => ({
      id: r.id, text: r.text, audioUrl: r.audioUrl, durationFrames: Math.max(1, r.durationFrames),
      startFrame: r.startFrame, locked: r.locked, status: r.status,
    }));

  const applyNarrationOnly = () => {
    if (!project) return;
    useProjectStore.getState().setNarrationEntries(rowsToEntries(rows));
    onClose();
  };

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
      setRows(resequenceRows(parsed.flatMap((c, ci) => c.subtitles.map((txt) => mkRow(txt, ci)))));
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
    setBusy(true); setError(null);
    try {
      let done = 0;
      let terrMiss = 0;
      const items: GeneratedChapterPlan[] = [];
      for (let i = 0; i < plan.length; i++) {
        const ch = plan[i];
        // 逐行字幕来自 rows（步骤②里可逐条生成 / 覆盖配音）；未生成的行按字数估算时长
        const chRows = rows.filter((r) => r.ci === i && r.text.trim());
        const entries: NarrationEntry[] = chRows.map((r) => ({
          id: r.id, text: r.text, audioUrl: r.audioUrl,
          durationFrames: Math.max(1, r.durationFrames), startFrame: 0, status: r.status || (r.audioUrl ? 'ready' : 'none'),
        }));
        done += chRows.length;
        // 每条字幕的相对起始帧：用于按「首次提及」给元素/弹窗定时
        const entryStarts: number[] = [];
        let acc = 0;
        for (const e of entries) { entryStarts.push(acc); acc += Math.max(1, e.durationFrames); }
        const holdFrames = Math.max(1, Math.round(5 * fps));
        const mentionAt = (names: string[]): number => {
          const keys = names.filter((x) => x && x.length >= 2);
          if (!keys.length) return 0;
          for (let si = 0; si < chRows.length; si++) {
            const txt = chRows[si].text;
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
        <h3 className="text-sm font-semibold mb-2">✨ {t('字幕生成', 'Subtitle studio')}</h3>

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
              onClick={() => { const ch = [{ title: '', subtitles: [''] }]; setPlan(ch); setRows([mkRow('', 0)]); }}
              disabled={busy}
              className="h-8 px-3 rounded-md border border-white/15 text-xs hover:bg-white/10 disabled:opacity-40"
              title={t('不用 AI，手工写文案', 'No AI: write the script manually')}
            >
              ＋ {t('手动填写文案', 'Write script manually')}
            </button>
            {(project?.narration?.entries?.length || 0) > 0 && (
              <button
                onClick={loadExisting}
                disabled={busy}
                className="h-8 px-3 rounded-md border border-white/15 text-xs hover:bg-white/10 disabled:opacity-40"
                title={t('只改字幕文本 / 配音 / 时长，不动元素与相机', 'Edit subtitles & voiceover only; keeps elements and camera')}
              >
                ✎ {t(`编辑现有字幕（${project!.narration.entries.length} 条）`, `Edit existing (${project!.narration.entries.length})`)}
              </button>
            )}
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
              <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                <p className="text-[11px] text-muted-foreground flex-1 min-w-[140px]">
                  {editOnly
                    ? t('编辑现有字幕（只改字幕与配音）', 'Editing existing subtitles')
                    : t('确认/编辑文案（每行一条字幕）', 'Confirm/edit script (one subtitle per line)')}
                </p>
                <button onClick={addRow} className="h-7 px-2 rounded-md border border-white/15 text-[11px] hover:bg-white/10" title={t('在末尾加一行字幕', 'Append a line')}>＋ {t('加一行', 'Add')}</button>
                <label className="h-7 px-2 inline-flex items-center rounded-md border border-white/15 text-[11px] hover:bg-white/10 cursor-pointer" title={t('导入 SRT 覆盖当前行', 'Import SRT (replaces lines)')}>
                  📥 {t('导入 SRT', 'Import SRT')}
                  <input type="file" accept=".srt,text/plain" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importSrt(f); e.target.value = ''; }} />
                </label>
                <button onClick={exportSrt} disabled={!rows.length} className="h-7 px-2 rounded-md border border-white/15 text-[11px] hover:bg-white/10 disabled:opacity-40" title={t('导出为 SRT', 'Export SRT')}>📤 {t('导出 SRT', 'Export SRT')}</button>
                <button
                  onClick={genAllMissing}
                  disabled={busy || genIdx !== null || !tts?.baseUrl}
                  className="h-7 px-2 rounded-md border border-sky-400/40 bg-sky-500/10 text-[11px] text-sky-200 hover:bg-sky-500/20 disabled:opacity-40"
                  title={t('给所有还没有配音的行生成语音（已有配音的行不动）', 'Generate voice for every line without audio')}
                >
                  ▶▶ {t('全部生成配音', 'Generate all voice')}
                </button>
              </div>
              <div className="space-y-1.5 max-h-[38vh] overflow-y-auto pr-1">
                {rows.map((r, idx) => (
                  <div key={r.id} className="flex items-start gap-1.5 rounded-md border border-white/10 bg-white/[0.03] p-1.5">
                    <span className="shrink-0 w-5 pt-1.5 text-right text-[10px] text-muted-foreground tabular-nums">{idx + 1}</span>
                    <textarea
                      value={r.text}
                      onChange={(e) => editText(r.id, e.target.value)}
                      rows={2}
                      className="input text-xs resize-none flex-1 min-w-0"
                      placeholder={t('一行字幕', 'Subtitle line')}
                    />
                    <div className="shrink-0 flex items-center gap-1 pt-0.5">
                      <button
                        onClick={() => genRow(idx)}
                        disabled={genIdx !== null || !r.text.trim()}
                        className="w-7 h-7 rounded-md border border-white/15 text-[11px] hover:bg-white/10 disabled:opacity-40"
                        title={r.audioUrl ? t('重新生成并覆盖原配音', 'Regenerate (overwrites audio)') : t('生成本句配音', 'Generate voice for this line')}
                      >
                        {genIdx === idx ? '⏳' : r.status === 'error' ? '⚠' : r.audioUrl ? '🔁' : '🔊'}
                      </button>
                      {r.audioUrl && (
                        <button
                          onClick={() => audit(r)}
                          className="w-7 h-7 rounded-md border border-white/15 text-[11px] hover:bg-white/10"
                          title={t('试听本句配音', 'Preview this clip')}
                        >
                          {auditingId === r.id ? '⏸' : '▶'}
                        </button>
                      )}
                      <button
                        onClick={() => delRow(r.id)}
                        className="w-7 h-7 rounded-md text-[11px] text-muted-foreground hover:text-red-400 hover:bg-white/10"
                        title={t('删除本行', 'Delete line')}
                      >✕</button>
                    </div>
                  </div>
                ))}
                {!rows.length && <p className="text-[11px] text-muted-foreground text-center py-4">{t('还没有字幕，点「加一行」或导入 SRT', 'No lines yet — add one or import an SRT')}</p>}
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground/80">
                {t('每行 = 一条字幕 + 一段配音；🔁 覆盖该行原配音；有配音时显示时长跟随音频', 'One line = one subtitle + one clip; 🔁 overwrites its audio; audio drives duration')}
              </p>
              {!editOnly && plan[0] && (
                <div className="mt-1 text-[10px] text-muted-foreground">
                  {plan[0].fx?.length ? `特效: ${plan[0].fx.join(',')}` : ''}
                  {plan[0].overlays?.length ? ` · 弹窗: ${plan[0].overlays.map((o) => o.kind).join(',')}` : ''}
                  {plan[0].elements?.length ? ` · 元素: ${plan[0].elements.map((e) => e.kind).join(',')}` : ''}
                </div>
              )}
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
                onClick={() => { setPlan(null); setRows([]); setEditOnly(false); setUnresolved(null); setPendingPlaces(null); setPlaceInputs({}); }}
                disabled={busy}
                className="h-8 px-3 rounded-md border border-white/15 text-xs hover:bg-white/10 disabled:opacity-40"
              >{t('返回重写', 'Back')}</button>
              <button
                onClick={editOnly ? applyNarrationOnly : (unresolved ? resume : confirm)}
                disabled={busy || !hasContent}
                className="h-8 px-3.5 rounded-md bg-white text-black text-xs font-medium hover:bg-white/90 disabled:opacity-40"
              >
                {busy
                  ? t('生成中…', 'Working…')
                  : editOnly
                    ? t('应用字幕', 'Apply subtitles')
                    : unresolved ? t('继续生成', 'Continue') : t('② 确认并生成', '② Confirm & build')}
              </button>
            </div>
          </>
        )}

        <Section title={t('字幕样式', 'Subtitle style')} className="mt-3">
          <Field label={t('字体', 'Font')}>
            <OptionBlocks<string>
              value={style.fontFamily || "'KaiTi', 'STKaiti', 'SimSun', serif"}
              options={[
                { value: "'KaiTi', 'STKaiti', 'SimSun', serif", label: t('楷体', 'KaiTi') },
                { value: "'SimSun', 'Songti SC', serif", label: t('宋体', 'SimSun') },
                { value: "'SimHei', 'Microsoft YaHei', sans-serif", label: t('黑体', 'SimHei') },
                { value: 'system-ui, sans-serif', label: t('系统', 'System') },
              ]}
              onChange={(v) => setStyle({ fontFamily: v })}
            />
          </Field>
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-[11px] text-muted-foreground">{t('字号', 'Size')}</span>
            <NumberInput className="input h-7 w-16 text-xs" value={style.fontSize} step={2} min={12} onCommit={(v) => setStyle({ fontSize: Math.max(12, v) })} />
            <ColorPicker value={style.color} onChange={(c) => setStyle({ color: c })} />
            <span className="w-14 shrink-0 text-[11px] text-muted-foreground">{t('描边', 'Stroke')}</span>
            <NumberInput className="input h-7 w-16 text-xs" value={style.strokeWidth} step={1} min={0} onCommit={(v) => setStyle({ strokeWidth: Math.max(0, v) })} />
            <ColorPicker value={style.strokeColor} onChange={(c) => setStyle({ strokeColor: c })} />
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="w-14 shrink-0 text-[11px] text-muted-foreground">{t('底部', 'Bottom')}</span>
            <input type="range" min={0} max={40} step={1} value={style.posY} onChange={(e) => setStyle({ posY: parseInt(e.target.value, 10) })} className="flex-1 h-1 accent-[var(--brand)]" />
            <span className="w-8 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">{style.posY}%</span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="w-14 shrink-0 text-[11px] text-muted-foreground">{t('文字色', 'Text')}</span>
            <ColorPicker value={style.color} onChange={(c) => setStyle({ color: c })} />
            <span className="text-[11px] text-muted-foreground">{t('背景', 'BG')}</span>
            <OptionBlocks<'none' | 'bar'>
              value={style.bg}
              options={[{ value: 'none', label: t('无', 'None') }, { value: 'bar', label: t('长条', 'Bar') }]}
              onChange={(v) => setStyle({ bg: v })}
            />
            {style.bg === 'bar' && <ColorPicker value={style.bgColor} onChange={(c) => setStyle({ bgColor: c })} />}
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground/80">
            {t('样式对整片字幕生效，随时可改（编辑器预览与导出同源）', 'Applies to all subtitles; preview and export share it')}
          </p>
        </Section>
      </div>
    </div>
  );
}
