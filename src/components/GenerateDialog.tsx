/**
 * 字幕生成：需求 → LLM 口播文案 → 逐行字幕 + 逐行配音 → 应用。
 *
 * 这里同时是**字幕条目与字幕样式的唯一编辑处**（特效弹窗已无字幕页签）：
 * 打开时若项目已有字幕就直接载入继续编辑；只做字幕与配音，
 * 不生成也不改动元素 / 弹窗 / 特效 / 相机（那套生成链路已于 2026-09-20 删除）。
 *
 * 布局：需求在最上（唯一的生成入口贴着它），中间是**行列表 —— 这一屏的脊柱**，
 * 其余三块（字幕文案 / 配音音色 / 发音修正）与底部的字幕样式都是**可折叠区**，
 * 标题上带着摘要（几行 / 哪个音色 / 几条修正），默认收起 —— 不然六块同一种小灰字挤在一起，找不到主次。
 */
import { useState, useRef, useEffect, type ComponentProps, type ReactNode } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useEditorStore } from '../stores/editorStore';
import { IS_DESKTOP } from '../lib/backend';
import { useProviderStore } from '../stores/providerStore';
import { useT, OptionBlocks, ColorPicker, NumberInput } from './ui/primitives';
import { Badge } from './ui/badge';
import { Progress } from './ui/progress';
import { callLLM, defaultVoiceOf, templateOf } from '../lib/providers';
import { referencesArg, submitKeyOf, type ReqKey } from '../lib/request-engine';
import { useTaskStore } from '../stores/taskStore';
import { useVoiceStore } from '../stores/voiceStore';
import { playAudition, stopAudition } from '../lib/audition';
import { getAssetUrl } from '../lib/assets';
import { VoiceField, voiceLabelOf, voiceSpecOf } from './VoiceField';
import { HotFixField } from './HotFixField';
import type { InstanceDef } from '../lib/request-engine';
import type { TaskRow } from '../types';
import { estimateTextDurationFrames, generateId, defaultNarrationStyle, hotFixPayload, type HotFix, type NarrationEntry } from '../types';

/** 没填修正时的稳定空值（selector / prop 每帧给新引用会让组件白重渲染） */
const NO_HOT_FIX: HotFix = { pronunciation: [], replace: [] };

/** 一行 = 一条字幕 + 它自己的配音（可单独生成 / 覆盖） */
interface SubRow {
  id: string;
  text: string;
  audioId?: string;
  durationFrames: number;
  startFrame: number;
  status?: 'none' | 'pending' | 'ready' | 'error';
  /** 失败原因（上游 code/message 原样留着，界面上不翻译） */
  error?: string;
  /** 在时间线上手动拖过 → 保住起点，不参与顺排 */
  locked?: boolean;
  /** 这一行读完停多久（秒）；空 = 跟整片的 `gapSec`，0 = 这一行明确不间隔 */
  gapSec?: number;
}

/**
 * 顺排：未锁定的行首尾相接，中间留 `gapOf(r)` 的停顿；锁定行保住自己的起点，并把游标推到它之后。
 * 间隔是**这一屏的排版规则**，落库的还是算好的 startFrame —— 渲染端与时间线不用懂它。
 */
function resequenceRows(rows: SubRow[], gapSec = 0, fps = 30): SubRow[] {
  let cursor = 0;
  return rows.map((r) => {
    const dur = Math.max(1, r.durationFrames);
    const gap = Math.max(0, Math.round((r.gapSec ?? gapSec) * fps));
    const s0 = r.locked ? Math.max(cursor, r.startFrame) : cursor;
    cursor = s0 + dur + gap;
    return { ...r, startFrame: s0 };
  });
}

/** 项目里已有的字幕 → 编辑行（重新打开就是继续编辑，配音也一起带回来） */
function rowsFromProject(entries: NarrationEntry[] | undefined): SubRow[] {
  return (entries || []).map((e) => ({
    id: e.id, text: e.text, audioId: e.audioId, durationFrames: Math.max(1, e.durationFrames),
    startFrame: e.startFrame, status: e.status, error: e.error, locked: e.locked, gapSec: e.gapSec,
  }));
}

/**
 * 把整篇文本拆成字幕行：去掉空行、SRT 的序号 / 时间轴 / 头部，
 * 并容错模型爱加的行首符号（- · " " 与 1. 1、 等）。
 */
function splitScript(raw: string): string[] {
  return (raw || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l
      && !/^\d+$/.test(l)                                        // SRT 的序号行
      && !/^\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(l)        // 时间轴行
      && !/^(WEBVTT|NOTE\b|STYLE\b|CUE-OFFSETS)/i.test(l))       // WebVTT 头部
    .map((l) => l.replace(/^[-*·•]+\s*/, '').replace(/^\d+[.、)]\s*/, '').replace(/^["“”]([\s\S]*)["“”]$/, '$1').trim())
    .filter(Boolean);
}

/** 一行高封顶 160px；没顶到封顶时不出滚动条 */
const LINE_MAX_H = 160;

/**
 * 字幕行输入框：默认只有一行高，文字换行了才继续增高。
 *
 * 高度要加回边框：`scrollHeight` 不含 border，而 `.input` 是 border-box（上下各 1px），
 * 照 scrollHeight 设就等于少给 2px —— 一行文字也会溢出，表现为「一行也带滚动条」。
 */
function LineInput(props: ComponentProps<'textarea'>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const need = el.scrollHeight + 2;
    el.style.height = `${Math.min(need, LINE_MAX_H)}px`;
    el.style.overflowY = need > LINE_MAX_H ? 'auto' : 'hidden';
  };
  // 值被外部改写（整篇文案应用 / 拆行）时也要重算
  useEffect(fit, [props.value]);
  return <textarea ref={ref} rows={1} {...props} onInput={fit} style={{ ...props.style, resize: 'none' }} />;
}

/**
 * 一个可折叠区：标题 + 摘要 + ▸/▾。
 * 摘要写的是**里面现在是什么**（几行 / 哪个音色 / 几条修正），收起时信息不丢。
 */
function Fold({ title, summary, open, onToggle, children }: {
  title: string; summary?: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div className="mb-2 rounded-md border border-white/10 bg-white/[0.02]">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] hover:bg-white/[0.04]"
        aria-expanded={open}
      >
        <span className="w-2.5 shrink-0 text-muted-foreground">{open ? '▾' : '▸'}</span>
        <span className="shrink-0 font-medium text-foreground/90">{title}</span>
        {summary && <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">{summary}</span>}
      </button>
      {open && <div className="border-t border-white/[0.08] px-2.5 py-2">{children}</div>}
    </div>
  );
}

/**
 * 这一行的配音到哪一步了。批量 30 行时，只有顶部一个汇总数字根本看不出是哪行卡住、
 * 哪行失败，所以状态逐行摆：排队中 / 合成中 / 时长 / 失败（原因在 title 里，不翻译）。
 */
function RowStatus({ r, task, fps }: { r: SubRow; task?: TaskRow; fps: number }) {
  const t = useT();
  const base = 'w-14 justify-center px-1 py-0 text-[9px] font-normal tabular-nums';
  if (task?.status === 'querying') return <Badge className={`${base} animate-pulse border-sky-400/40 bg-sky-500/15 text-sky-200`}>{t('查询中', 'polling')}</Badge>;
  if (task && (task.status === 'submitting')) return <Badge className={`${base} animate-pulse border-sky-400/40 bg-sky-500/15 text-sky-200`}>{t('合成中', 'synth')}</Badge>;
  if (task?.status === 'failed' || r.status === 'error') {
    return <Badge variant="outline" className={`${base} border-red-400/40 text-red-300`} title={task?.error || r.error || t('合成失败', 'failed')}>{t('失败', 'failed')}</Badge>;
  }
  if (r.audioId) {
    return <Badge variant="outline" className={`${base} border-white/10 text-muted-foreground`} title={t('配音时长', 'clip length')}>
      {(r.durationFrames / fps).toFixed(1)}s
    </Badge>;
  }
  if (task?.status === 'canceled') return <Badge variant="outline" className={`${base} border-white/10 text-muted-foreground/60`}>{t('已取消', 'canceled')}</Badge>;
  if (task || r.status === 'pending') return <Badge variant="outline" className={`${base} border-white/10 text-muted-foreground/70`}>{t('排队中', 'queued')}</Badge>;
  // 空行也占这一格（返回 null 会让刚点「＋加一行」的那一行输入框比别的行宽）
  return <Badge variant="outline" className={`${base} border-white/10 text-muted-foreground/50`}>{t('未配音', 'no audio')}</Badge>;
}

export function GenerateDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const project = useProjectStore((s) => s.project);
  const setNarrationEntries = useProjectStore((s) => s.setNarrationEntries);
  const setNarrationHotFix = useProjectStore((s) => s.setNarrationHotFix);
  const saveProject = useProjectStore((s) => s.saveProject);
  const setProjectEndFrame = useProjectStore((s) => s.setProjectEndFrame);
  const setStyle = useProjectStore((s) => s.setNarrationStyle);

  const [topic, setTopic] = useState('');
  // 已有字幕直接载入：一次性初始值，不跟随 project 引用变化重置（否则打字途中会被冲掉）
  const [rows, setRows] = useState<SubRow[]>(() => rowsFromProject(project?.narration?.entries));
  /** 整片字幕间隔（秒，项目级）：改了立刻重排未锁定的行 */
  const gapSec = project?.narration?.gapSec ?? 0;
  const setGapSec = useProjectStore((s) => s.setNarrationGap);
  /** 整片配音音量（0–1，项目级）：与背景音乐相对调，预览与导出同一个倍率 */
  const volume = project?.narration?.volume ?? 1;
  const setVolume = useProjectStore((s) => s.setNarrationVolume);
  /**
   * 字幕文案 = 整篇草稿，与下面的行列表是**同一份内容的两种看法**。
   * 没编辑过草稿时它显示行的 join（改哪边都跟得上）；一旦动过草稿就锁定草稿，
   * 直到点「按行应用」—— 逐字符重拆行会打断输入（敲回车那一下光标会跳）。
   */
  const [draft, setDraft] = useState('');
  const [draftDirty, setDraftDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 一个能力一条实例（选了哪条就订阅哪条）；改完服务立刻反映到本弹窗
  const llm = useProviderStore((s) => s.current('llm'));
  const tts = useProviderStore((s) => s.current('tts'));
  const updateInstance = useProviderStore((s) => s.updateInstance);
  /** 音色区读的是这条实例那一格的候选值（音色表），所以要知道看哪一格 */
  const voiceSlot: ReqKey = submitKeyOf(tts?.sync ?? true);
  const voiceSpec = voiceSpecOf(tts, voiceSlot);
  /**
   * 音色**记在实例上**（⚙ 那一格写的是同一处）：下次打开、换项目都还是它，也不用第二本账。
   * 选克隆音色时它绑的模型一起写进这一格 —— 于是引擎三层取值自己就用对模型，
   * 这里不再单独攥一份 voiceModel。
   */
  const voice = String(tts?.values.requests?.[voiceSlot]?.voice ?? '') || defaultVoiceOf(tts);
  const pickVoice = (voiceId: string, voiceModel?: string) => {
    if (!tts) return;
    const cur = tts.values.requests?.[voiceSlot] ?? {};
    updateInstance(tts.id, {}, { requests: { [voiceSlot]: { ...cur, voice: voiceId, ...(voiceModel ? { model: voiceModel } : {}) } } });
  };
  /** 项目级发音修正（存进配音档，每次合成原样带下去）；没填完的行在这一步被滤掉，全空 = 不传这个参数 */
  const hotFix = hotFixPayload(project?.narration?.hotFix);
  /** 这一格到底吃不吃 hotFix：看请求体里有没有 `${hotFix}` —— 没有就别假装生效（AGENTS §6.29） */
  const hotFixSupported = referencesArg(templateOf(tts), voiceSlot, 'hotFix');
  const hotFixRows = project?.narration?.hotFix ?? NO_HOT_FIX;
  const ready = (i: InstanceDef | null) => !!i && !!String(i.values.instance?.baseUrl ?? '');
  const fps = project?.globalConfig.defaultFPS || 30;
  const hasContent = rows.some((r) => r.text.trim());
  const style = project?.narration?.style || defaultNarrationStyle();

  const mkRow = (text: string): SubRow => ({
    id: generateId(), text, durationFrames: estimateTextDurationFrames(text, fps), startFrame: 0, status: 'none',
  });

  /** 按整片间隔顺排（单行改过的用自己的） */
  const seq = (rs: SubRow[]) => resequenceRows(rs, gapSec, fps);

  /** 用整篇文本替换当前行（AI 生成 / 字幕文案应用共用） */
  const replaceRows = (texts: string[]) => { setRows(seq(texts.map(mkRow))); setDraftDirty(false); };

  /** 整篇草稿 = 各行连起来（没编辑过草稿时，行列表改了什么这里立刻跟着变） */
  const draftText = draftDirty ? draft : rows.map((r) => r.text).join('\n');
  const draftLines = splitScript(draftText).length;
  const applyDraft = () => {
    const texts = splitScript(draftText);
    if (!texts.length) { setError(t('文案里没有可用文本', 'Nothing usable in the script')); return; }
    replaceRows(texts);
  };

  /** 改文本：已有配音则保住音频时长，否则按字数重估；改过就把上一次的失败状态清掉（别让徽标说谎） */
  const editText = (id: string, text: string) => setRows((rs) => seq(rs.map((r) => (
    r.id === id
      ? {
        ...r, text,
        durationFrames: r.audioId ? r.durationFrames : estimateTextDurationFrames(text, fps),
        status: r.status === 'error' ? (r.audioId ? 'ready' as const : 'none' as const) : r.status,
        error: r.status === 'error' ? undefined : r.error,
      }
      : r
  ))));

  /** 改文本；**一旦含换行就按行拆成多条字幕**（整篇文案一次贴入的入口，回车同义） */
  const commitRowText = (id: string, text: string) => {
    if (!text.includes('\n')) return editText(id, text);
    const parts = splitScript(text);
    setRows((rs) => {
      const at = rs.findIndex((r) => r.id === id);
      if (at < 0) return rs;
      const base = rs[at];
      const first = parts[0] || '';
      return seq([
        ...rs.slice(0, at),
        { ...base, text: first, durationFrames: base.audioId ? base.durationFrames : estimateTextDurationFrames(first, fps) },
        ...parts.slice(1).map((p) => mkRow(p)),
        ...rs.slice(at + 1),
      ]);
    });
  };

  const addRow = () => setRows((rs) => [...rs, mkRow('')]);
  const delRow = (id: string) => setRows((rs) => seq(rs.filter((r) => r.id !== id)));
  /** 这一行的停顿：填了就脱离整片默认（0 也是有效值，与「没填」必须分得开） */
  const setRowGap = (id: string, sec?: number) => setRows((rs) => seq(rs.map((r) => (r.id === id ? { ...r, gapSec: sec } : r))));

  /** 这条实例的克隆记录：标题要把 voice_id 翻成「男声·克隆」那样的话 */
  const voiceRows = useVoiceStore((s) => s.rows);
  const voiceClones = voiceRows.filter((r) => r.providerId === tts?.id && r.voiceId).map((r) => ({ voiceId: r.voiceId!, label: r.label }));
  const taskRows = useTaskStore((s) => s.rows);
  const taskResults = useTaskStore((s) => s.results);
  const startTask = useTaskStore((s) => s.start);
  const cancelTasks = useTaskStore((s) => s.cancelBatch);
  const [batchId, setBatchId] = useState<string | null>(null);
  /** 这一行最近的那条任务（重跑就再点一次，取最新一条） */
  const taskOf = (entryId: string) => taskRows.filter((x) => x.entryId === entryId).slice(-1)[0];
  const stillOpen = (x: TaskRow) => x.status === 'submitting' || x.status === 'querying';

  /**
   * 生成配音前先把当前行落库。
   * 不这么做就有两个洞：① 任务在途时关掉弹窗 / 刷新页面，重启后续跑成功，
   * 但产物要回填的那条字幕**还没入库**，音频只能凭空消失；② `task.entry_id` 是对
   * `narration_entry` 的**真外键**，而行还没进库（自动保存是停止编辑 5 秒后才落盘），
   * 于是插任务直接被拒 —— 表现成「点了生成本句配音，什么也没发生」。
   * 落库之后 entryId 一直有效 —— 谁在跑、跑完给谁，都不依赖弹窗还开着。
   */
  const ensureLinesSaved = async () => {
    // 本地行还没镜像到、但项目里已经有音频的（任务刚跑完那一刻），以项目为准 —— 别把刚落库的产物覆盖成空
    const saved = new Map((project?.narration?.entries ?? []).map((e) => [e.id, e]));
    setNarrationEntries(
      seq(rows).filter((r) => r.text.trim()).map((r) => {
        const cur = saved.get(r.id);
        const keep = !r.audioId && cur?.audioId ? cur : undefined;
        return {
          id: r.id, text: r.text,
          audioId: r.audioId ?? keep?.audioId,
          durationFrames: Math.max(1, r.audioId ? r.durationFrames : keep?.durationFrames ?? r.durationFrames),
          startFrame: r.startFrame, locked: r.locked, gapSec: r.gapSec,
          status: keep?.status ?? r.status, error: keep ? undefined : (r.status === 'error' ? r.error : undefined),
        };
      }),
    );
    await saveProject();
  };

  /**
   * 生成一行配音：交给 `task` 表，不在本组件里跑。
   * 于是关窗口、刷新页面都不断进度 —— 产物回来时调度器直接写项目里的条目，
   * 弹窗若还开着，由下面的 effect 从任务结果镜像进编辑行。
   */
  const genVoice = async (r: SubRow, batch?: string) => {
    if (!r.text.trim()) { setError(t('请先填写字幕文本', 'Fill in this line first')); return; }
    if (!tts || !ready(tts)) { setError(t('未配置配音服务（顶栏 ⚙ 设置）', 'No TTS instance configured')); return; }
    setError(null);
    // 整批那条路已经存过一次，不必每行再写一遍库
    if (!batch) await ensureLinesSaved();
    try {
      await startTask({
        category: 'tts', providerId: tts.id, projectId: project?.id, entryId: r.id,
        batchId: batch,
        // 音色与它绑的模型不在这儿传：它们记在这条实例上（⚙ 那一格写的是同一处），引擎三层取值自会拿
        input: { text: r.text, ...(hotFix ? { hotFix } : {}) },
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      setError(t(`任务建不起来：${why}`, `Could not create the task: ${why}`));
    }
  };

  /** 整批生成：给这一批一个 batchId（进度与取消都按批算），只补没有配音的行 */
  const genAllMissing = async () => {
    const todo = rows.filter((r) => r.text.trim() && !r.audioId);
    if (!todo.length) return;
    if (!tts || !ready(tts)) { setError(t('未配置配音服务（顶栏 ⚙ 设置）', 'No TTS instance configured')); return; }
    const id = `bt_${Date.now()}`;
    setBatchId(id);
    setError(null);
    await ensureLinesSaved();
    for (const r of todo) await genVoice(r, id);
  };
  const batchTasks = batchId ? taskRows.filter((x) => x.batchId === batchId) : [];
  const batch = batchTasks.length ? { done: batchTasks.filter((x) => !stillOpen(x)).length, total: batchTasks.length } : null;
  // 批内失败不汇总成一句「N 行失败」就完事：徽标标红，这里再点名第一条，其余看行
  const batchFail = batchTasks.find((x) => x.status === 'failed');

  /** 产物回来后镜像到编辑行（项目里那条字幕由调度器写，这里只跟着显示，不另存一份真相） */
  useEffect(() => {
    setRows((rs) => {
      let touched = false;
      const next = rs.map((r) => {
        const tk = taskOf(r.id);
        const res = tk ? taskResults[tk.taskId] : undefined;
        if (!tk || tk.status !== 'success' || !res || r.audioId === res.assetId) return r;
        touched = true;
        return {
          ...r, audioId: res.assetId,
          durationFrames: Math.max(1, Math.round(res.durationSec * fps)),
          status: 'ready' as const, error: undefined,
        };
      });
      return touched ? seq(next) : rs;
    });
  }, [taskRows, taskResults, fps]);

  /**
   * 试听：**全局只留一路声音**（见 lib/audition）。
   * 早先这里每次 `new Audio()` 且不留句柄 —— 播下一条不停上一条、点「停止」也停不掉，
   * 关掉弹窗还在响。现在再点同一行即停止，播完自动复位。
   */
  const [auditingId, setAuditingId] = useState<string | null>(null);
  const audit = async (r: SubRow) => {
    if (!r.audioId) return;
    if (auditingId === r.id) {
      stopAudition();
      setAuditingId(null);
      return;
    }
    setAuditingId(r.id);
    const src = await getAssetUrl(r.audioId);
    if (!src) { setAuditingId(null); return; }   // 素材没了：徽标留着，别把按钮卡在「正在播」
    void playAudition(src, () => setAuditingId(null));
  };
  // 时间线开始播放时停掉试听，否则两路声音叠着响
  const isPlaying = useEditorStore((s) => s.isPlaying);
  useEffect(() => { if (isPlaying) { stopAudition(); setAuditingId(null); } }, [isPlaying]);
  // 弹窗关闭即卸载：留着在播的 Audio 会盖住时间线的声音
  useEffect(() => () => stopAudition(), []);

  const genText = async () => {
    if (!topic.trim()) { setError(t('请先填写你的需求', 'Enter your requirements first')); return; }
    if (!llm || !ready(llm)) { setError(t('未配置文案生成服务（顶栏 ⚙ 设置）', 'No LLM instance configured')); return; }
    setBusy(true); setError(null);
    try {
      const sys = '你是「地图讲解视频」的文案策划。按用户需求写出可直接播报的连续口播稿。';
      const user = [
        `【需求】\n${topic.trim()}`,
        [
          '【输出要求】',
          '- 8–24 条口播字幕，按时间顺序排列，每条不超过 40 字，语言与需求一致',
          '- 每条占一行，行内不要再换行',
          '- 只输出字幕正文：不要编号、不要时间码、不要 Markdown、不要标题与解释',
        ].join('\n'),
      ].join('\n\n');

      const texts = splitScript(await callLLM(llm, sys, user));
      if (!texts.length) throw new Error(t('模型未返回可用内容', 'Model returned no usable content'));
      replaceRows(texts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** 写回项目：只动字幕与配音；字幕比现有片长更久时把片长撑够 */
  const apply = () => {
    const entries: NarrationEntry[] = seq(rows)
      .filter((r) => r.text.trim())
      .map((r) => ({
        id: r.id, text: r.text, audioId: r.audioId, durationFrames: Math.max(1, r.durationFrames),
        startFrame: r.startFrame, locked: r.locked, gapSec: r.gapSec,
        status: r.status, error: r.status === 'error' ? r.error : undefined,
      }));
    setNarrationEntries(entries);
    const last = entries.reduce((n, e) => Math.max(n, e.startFrame + e.durationFrames), 0);
    if (last > (project?.endFrame || 0)) setProjectEndFrame(last);
    onClose();
  };


/** 字体族：值就是 CSS 的 `font-family`（编辑器预览与导出同源），标签才是给人看的中文名 */
function fontPresets(t: (zh: string, en: string) => string) {
  return [
    { value: "'KaiTi', 'STKaiti', 'SimSun', serif", label: t('楷体', 'KaiTi') },
    { value: "'SimSun', 'Songti SC', serif", label: t('宋体', 'SimSun') },
    { value: "'SimHei', 'Microsoft YaHei', sans-serif", label: t('黑体', 'SimHei') },
    { value: 'system-ui, sans-serif', label: t('系统', 'System') },
  ];
}

/** 样式表的一行：标签在左（固定宽）、控件在右 —— 每一项都叫得出名字，不再靠位置猜是谁 */
function StyleRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-x-2">
      <span className="text-right text-[11px] text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** 滑杆 + 读数：拖的时候只改本地，松手 / 离开才写回（每格都写库会把自动保存刷个不停） */
function SliderRow({ min, max, value, suffix, onCommit }: {
  min: number; max: number; value: number; suffix: string; onCommit: (v: number) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <span className="flex items-center gap-2">
      <input
        type="range" min={min} max={max} step={1} value={v}
        onChange={(e) => setV(parseInt(e.target.value, 10))}
        onPointerUp={() => onCommit(v)} onBlur={() => onCommit(v)}
        className="min-w-0 flex-1"
      />
      <span className="w-9 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">{v}{suffix}</span>
    </span>
  );
}

  const fontList = fontPresets(t);
  const fontName = (fontList.find((f) => f.value === (style.fontFamily || fontList[0].value))?.label) ?? t('自定义', 'custom');
  const hotFixCount = (hotFix?.pronunciation.length ?? 0) + (hotFix?.replace.length ?? 0);

  /** 折叠状态记在会话里（editorStore）：同一屏里刚展开的东西，不该因为重开弹窗又缩回去 */
  const sections = useEditorStore((s) => s.dialogSections);
  const toggleSection = useEditorStore((s) => s.toggleDialogSection);
  /** 折叠区的键统一带弹窗前缀（一屏一个命名空间，别和别的弹窗撞） */
  const fold = (k: string) => ({ open: !!sections[`subtitle:${k}`], onToggle: () => toggleSection(`subtitle:${k}`) });
  /** 折叠标题显示「是谁」（「男声 · 晨煦」/「男声·克隆」），不是那串发给上游的音色 id */
  const voiceLabel = voiceLabelOf(voiceSpec?.options, voiceClones, voice);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center"
      onClick={onClose}
      onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && hasContent && !busy) apply(); }}
    >
      <div className="bg-card border border-white/10 rounded-xl shadow-2xl p-4 w-[42rem] max-w-[95vw] max-h-[88vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">✨ {t('字幕生成', 'Subtitle studio')}</h3>
          <button
            onClick={onClose}
            className="h-6 shrink-0 px-2 rounded-md border border-white/15 text-[11px] text-muted-foreground hover:text-foreground hover:bg-white/10"
            title={t('关闭（不应用改动）', 'Close without applying')}
          >✕</button>
        </div>

        {/* 需求：唯一的生成入口贴着它，不再和五个按钮排成一排 */}
        <div className="mb-2 rounded-md border border-white/15 bg-white/[0.03] focus-within:border-white/30 transition-colors">
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            rows={3}
            className="w-full bg-transparent px-2.5 pt-2 text-xs resize-none outline-none placeholder:text-muted-foreground/50"
            placeholder={t('描述你的需求（主题 / 大纲 / 风格 / 口吻 / 受众 / 时长 / 侧重点…任何要求）', 'Describe your requirements (topic / outline / style / tone / audience / length … anything)')}
          />
          <div className="flex items-center justify-end gap-2 border-t border-white/[0.08] px-2 py-1.5">
            {!IS_DESKTOP && (
              <span className="mr-auto text-[11px] text-muted-foreground">{t('网页版不含 AI：展开「字幕文案」直接写，或逐行手写。', 'Web build has no AI: write the script in 字幕文案, or type lines.')}</span>
            )}
            {IS_DESKTOP && <button
              onClick={genText}
              disabled={busy || !topic.trim() || !ready(llm)}
              className="h-7 shrink-0 px-2.5 rounded-md bg-white text-black text-[11px] font-medium hover:bg-white/90 disabled:opacity-40"
              title={ready(llm)
                ? t('按上面的需求生成整篇文案（覆盖当前行）', 'Generate the script from the prompt (replaces lines)')
                : t('未配置文案生成服务（顶栏 ⚙ 设置）', 'No LLM provider configured')}
            >
              {busy ? t('生成中…', 'Working…') : t('🤖 AI 生成文案', '🤖 Generate script')}
            </button>}
          </div>
        </div>

        <Fold
          title={t('字幕文案', 'Script')}
          summary={t(`${draftLines} 行 · ${draftText.length} 字${draftDirty ? ' · 未应用的改动' : ''}`, `${draftLines} lines · ${draftText.length} chars${draftDirty ? ' · unapplied' : ''}`)}
          {...fold('draft')}
          onToggle={() => { if (fold('draft').open) setDraftDirty(false); fold('draft').onToggle(); }}
        >
          <textarea
            value={draftText}
            onChange={(e) => { setDraft(e.target.value); setDraftDirty(true); }}
            rows={8}
            className="input text-xs resize-y w-full"
            placeholder={t('整篇文案：一行一条字幕。带序号 / 时间轴的 SRT 片段粘进来也能识别。', 'The whole script: one subtitle per line. Numbered / timecoded SRT text is recognized too.')}
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button
              onClick={applyDraft}
              disabled={!draftDirty || !splitScript(draftText).length}
              className="h-7 px-2.5 rounded-md bg-white text-black text-[11px] font-medium hover:bg-white/90 disabled:opacity-40"
              title={t('按行重写下面的字幕列表', 'Rewrite the line list from this text')}
            >{t('按行应用', 'Apply by line')}</button>
            <span className="text-[10px] text-muted-foreground">
              {t('改下面的行，这里跟着变；这里改了要按一次才落到行上（免得打字途中被重排）', 'Editing lines below updates this; edits here need one Apply')}
            </span>
          </div>
        </Fold>

        {IS_DESKTOP && voiceSpec && (
          <Fold
            title={t('配音音色', 'Voice')}
            summary={voice ? voiceLabel : t('未选', 'none')}
            {...fold('voice')}
          >
            <VoiceField inst={tts} slot={voiceSlot} spec={voiceSpec} value={voice} audition
              extra={hotFix ? { hotFix } : undefined}
              onPick={pickVoice} />
          </Fold>
        )}

        {/* 这一格在不在，看当前这条实例的请求体里有没有 ${hotFix}：不认就整段不显示（填了也不会发出去的东西不该占一屏） */}
        {IS_DESKTOP && hotFixSupported && (
          <Fold
            title={t('发音修正', 'Pronunciation fixes')}
            summary={hotFixCount ? t(`${hotFixCount} 条`, `${hotFixCount} rule(s)`) : t('未填', 'none')}
            {...fold('hotfix')}
          >
            <p className="mb-1.5 text-[10px] text-muted-foreground">
              {t('项目级，随每次配音带下去', 'Project-wide; goes with every synthesis')}
            </p>
            <HotFixField value={hotFixRows} onChange={setNarrationHotFix} />
          </Fold>
        )}

        {/* 脊柱：一行 = 一条字幕 + 一段配音。左边读出场的秒数，右边读时长与停顿 */}
        <div className="border-t border-white/10 pt-2 mb-2">
          <div className="space-y-1.5 max-h-[38vh] overflow-y-auto pr-1">
            {seq(rows).map((r, idx) => (
              <div key={r.id} className="flex items-start gap-1.5 rounded-md border border-white/10 bg-white/[0.03] p-1.5">
                <span className="shrink-0 w-11 pt-1.5 text-right text-[10px] text-muted-foreground tabular-nums"
                  title={t('这一行开始显示的时间（顺排算出来的）', 'When this line starts (from the sequence)')}>
                  {(r.startFrame / fps).toFixed(1)}s
                </span>
                <span className="shrink-0 w-4 pt-1.5 text-right text-[10px] text-muted-foreground/60 tabular-nums">{idx + 1}</span>
                <LineInput
                  value={r.text}
                  onChange={(e) => commitRowText(r.id, e.target.value)}
                  className="input text-xs flex-1 min-w-0"
                  placeholder={t('一行字幕（可直接贴入整篇文案，按行拆分）', 'One subtitle per line (paste a whole script to split)')}
                />
                <div className="shrink-0 flex items-center gap-1 pt-0.5">
                  {IS_DESKTOP && <RowStatus r={r} task={taskOf(r.id)} fps={fps} />}
                  {/* 这一行的停顿：占位显示整片的默认值，填了才脱离 */}
                  <span className="flex items-center gap-0.5" title={t('这行读完停几秒再排下一行；留空 = 用下面的整片默认', 'Pause after this line; blank = the track-wide default below')}>
                    <span className="text-[10px] text-muted-foreground/70">{t('停', 'gap')}</span>
                    <input
                      type="number" min={0} max={10} step={0.1}
                      value={r.gapSec ?? ''}
                      placeholder={gapSec.toFixed(1)}
                      onChange={(e) => setRowGap(r.id, e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)))}
                      className="input h-7 w-14 text-right text-[10px] tabular-nums"
                    />
                    <span className="text-[10px] text-muted-foreground/70">s</span>
                  </span>
                  {IS_DESKTOP && <button
                    onClick={() => void genVoice(r)}
                    disabled={!r.text.trim()}
                    className="w-7 h-7 shrink-0 rounded-md border border-white/15 text-[11px] hover:bg-white/10 disabled:opacity-40"
                    title={r.audioId ? t('重新生成并覆盖原配音', 'Regenerate (overwrites audio)') : t('生成本句配音', 'Generate voice for this line')}
                  >
                    {taskOf(r.id) && stillOpen(taskOf(r.id)!) ? '⏳' : r.status === 'error' ? '⚠' : r.audioId ? '🔁' : '🔊'}
                  </button>}
                  {/* 没有配音时也在（只是按不动）—— 否则这一行比别的行少一格，输入框就宽了一截 */}
                  <button
                    onClick={() => audit(r)}
                    disabled={!r.audioId}
                    className="w-7 h-7 shrink-0 rounded-md border border-white/15 text-[11px] hover:bg-white/10 disabled:opacity-40"
                    title={!r.audioId ? t('这一行还没有配音', 'No clip yet') : auditingId === r.id ? t('停止试听本句', 'Stop this clip') : t('试听本句配音', 'Preview this clip')}
                  >{auditingId === r.id ? '⏸' : '▶'}</button>
                  <button
                    onClick={() => delRow(r.id)}
                    className="w-7 h-7 shrink-0 rounded-md text-[11px] text-muted-foreground hover:text-red-400 hover:bg-white/10"
                    title={t('删除本行', 'Delete line')}
                  >✕</button>
                </div>
              </div>
            ))}
            {!rows.length && (
              <p className="text-[11px] text-muted-foreground text-center py-4">
                {t('还没有字幕：在上面的需求里写一句让 AI 生成，或展开「字幕文案」直接贴一篇。', 'No lines yet — describe what you want above, or paste a whole script in 字幕文案.')}
              </p>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-2 flex-wrap">
            <button onClick={addRow} className="h-7 px-2 rounded-md border border-white/15 text-[11px] hover:bg-white/10" title={t('在末尾加一行字幕', 'Append a line')}>＋ {t('加一行', 'Add line')}</button>
            {IS_DESKTOP && <button
              onClick={() => void genAllMissing()}
              disabled={busy || !ready(tts) || !rows.some((r) => r.text.trim() && !r.audioId)}
              className="h-7 px-2 rounded-md border border-sky-400/40 bg-sky-500/10 text-[11px] text-sky-200 hover:bg-sky-500/20 disabled:opacity-40"
              title={t('给所有还没有配音的行生成语音（已有配音的行不动）', 'Generate voice for every line without audio')}
            >▶▶ {t('全部生成配音', 'Generate all voice')}</button>}
            <span className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {t('整片字幕间隔', 'Track gap')}
              <input
                type="range" min={0} max={5} step={0.1} value={gapSec}
                onChange={(e) => setGapSec(parseFloat(e.target.value))}
                className="w-20 h-1 accent-[var(--brand)]"
                title={t('每行读完停几秒再排下一行（单行右边那格可以覆盖它）', 'Pause after each line; a line can override it on its right')}
              />
              <span className="w-9 text-right tabular-nums">{gapSec.toFixed(1)}s</span>
              {IS_DESKTOP && <>
                <span className="text-muted-foreground/40">·</span>
                {t('配音音量', 'Volume')}
                <input
                  type="range" min={0} max={3} step={0.05} value={volume}
                  onChange={(e) => setVolume(parseFloat(e.target.value))}
                  className="w-20 h-1 accent-[var(--brand)]"
                  title={t('配音在成片里的音量（与背景音乐相对调）。超过 100% 走本地增益：不重跑配音，但可能削顶', 'Narration level; above 100% is applied by local gain — no re-synthesis, may clip')}
                />
                <span className="w-9 text-right tabular-nums">{Math.round(volume * 100)}%</span>
              </>}
            </span>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground/80">
            {t('每行 = 一条字幕 + 一段配音；🔁 覆盖该行原配音；有配音时时长跟随音频', 'One line = one subtitle + one clip; 🔁 overwrites its audio; audio drives duration')}
          </p>
        </div>

        {IS_DESKTOP && batch && (
          <div className="mb-2">
            <Progress value={batch.total ? (batch.done / batch.total) * 100 : 0} className="h-1.5" />
            <div className="mt-1 flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground tabular-nums">{t('配音', 'voice')} {batch.done}/{batch.total}</span>
              <button
                onClick={() => batchId && void cancelTasks(batchId)}
                className="h-6 px-2 rounded-md border border-white/15 text-[11px] hover:bg-white/10"
                title={t('不再开始新的行（在途的那条会跑完）', 'Stop starting new lines; the in-flight one finishes')}
              >✕ {t('取消', 'Cancel')}</button>
            </div>
          </div>
        )}

        {(error || batchFail) && (
          <p className="text-[11px] text-red-400/90 mb-2">
            {error ?? `${t('有行配音失败：', 'a line failed: ')}${batchFail?.error ?? ''}`}
          </p>
        )}

        <Fold
          title={t('字幕样式', 'Subtitle style')}
          summary={t(`${fontName} · ${style.fontSize} 号 · 距底 ${style.posY}%`, `${fontName} · ${style.fontSize}px · ${style.posY}% from bottom`)}
          {...fold('style')}
        >
          <div className="space-y-1.5">
            <StyleRow label={t('字体', 'Font')}>
              <OptionBlocks<string>
                value={style.fontFamily || fontPresets(t)[0].value}
                options={fontPresets(t)}
                onChange={(v) => setStyle({ fontFamily: v })}
              />
            </StyleRow>
            <StyleRow label={t('字号', 'Size')}>
              <NumberInput className="input h-7 w-16 text-xs" value={style.fontSize} step={2} min={12} onCommit={(v) => setStyle({ fontSize: Math.max(12, v) })} />
            </StyleRow>
            <StyleRow label={t('文字色', 'Text color')}>
              <ColorPicker value={style.color} onChange={(c) => setStyle({ color: c })} />
            </StyleRow>
            <StyleRow label={t('描边', 'Stroke')}>
              <span className="flex items-center gap-1.5">
                <NumberInput className="input h-7 w-16 text-xs" value={style.strokeWidth} step={1} min={0} onCommit={(v) => setStyle({ strokeWidth: Math.max(0, v) })} />
                <ColorPicker value={style.strokeColor} onChange={(c) => setStyle({ strokeColor: c })} />
              </span>
            </StyleRow>
            <StyleRow label={t('背景', 'Background')}>
              <span className="flex items-center gap-1.5">
                <OptionBlocks<'none' | 'bar'>
                  value={style.bg}
                  options={[{ value: 'none', label: t('无', 'None') }, { value: 'bar', label: t('底部长条', 'Bar') }]}
                  onChange={(v) => setStyle({ bg: v })}
                />
                {style.bg === 'bar' && <ColorPicker value={style.bgColor} onChange={(c) => setStyle({ bgColor: c })} />}
              </span>
            </StyleRow>
            <StyleRow label={t('距底', 'Bottom offset')}>
              <SliderRow min={0} max={40} value={style.posY} suffix="%" onCommit={(v) => setStyle({ posY: v })} />
            </StyleRow>
            <StyleRow label={t('最大宽度', 'Max width')}>
              <SliderRow min={40} max={100} value={style.maxPct} suffix="%" onCommit={(v) => setStyle({ maxPct: Math.min(100, Math.max(40, v)) })} />
            </StyleRow>
            <p className="pt-1 text-[10px] text-muted-foreground/80">
              {t('样式对整片字幕生效，随时可改（编辑器预览与导出同源）', 'Applies to all subtitles; preview and export share it')}
            </p>
          </div>
        </Fold>

        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="h-8 px-3 rounded-md border border-white/15 text-xs hover:bg-white/10 disabled:opacity-40">{t('取消', 'Cancel')}</button>
          <button
            onClick={apply}
            disabled={busy || !hasContent}
            className="h-8 px-3.5 rounded-md bg-white text-black text-xs font-medium hover:bg-white/90 disabled:opacity-40"
            title={t('把当前字幕与配音写回项目（只改字幕，不动元素 / 弹窗 / 特效 / 相机）· Ctrl+Enter', 'Apply subtitles & voice to the project')}
          >
            {busy ? t('生成中…', 'Working…') : t('应用字幕与配音', 'Apply subtitles & voice')}
          </button>
        </div>
      </div>
    </div>
  );
}
