/**
 * 字幕生成：需求 → LLM 口播文案 → 逐行字幕 + 逐行配音 → 应用。
 *
 * 这里同时是**字幕条目与字幕样式的唯一编辑处**（特效弹窗已无字幕页签）：
 * 打开时若项目已有字幕就直接载入继续编辑；只做字幕与配音，
 * 不生成也不改动元素 / 弹窗 / 特效 / 相机（那套生成链路已于 2026-09-20 删除）。
 * 单页布局：需求与参考在上，字幕行在中，样式在下 —— 没有「步骤①/②」，也没有「返回重写」。
 */
import { useState, useRef, useEffect, type ComponentProps } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { IS_DESKTOP } from '../lib/backend';
import { useProviderStore } from '../stores/providerStore';
import { useT, Section, Field, OptionBlocks, ColorPicker, NumberInput } from './ui/primitives';
import { callLLM, callTTS, parseSrt, srtTime } from '../lib/providers';
import { runBatch } from '../lib/provider-queue';
import { VoicePicker } from './VoicePicker';
import { estimateTextDurationFrames, generateId, defaultNarrationStyle, type NarrationEntry } from '../types';

/** 一行 = 一条字幕 + 它自己的配音（可单独生成 / 覆盖） */
interface SubRow {
  id: string;
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

/** 项目里已有的字幕 → 编辑行（重新打开就是继续编辑，配音也一起带回来） */
function rowsFromProject(entries: NarrationEntry[] | undefined): SubRow[] {
  return (entries || []).map((e) => ({
    id: e.id, text: e.text, audioUrl: e.audioUrl, durationFrames: Math.max(1, e.durationFrames),
    startFrame: e.startFrame, status: e.status, locked: e.locked,
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

/** 字幕行输入框：默认只有一行高，文字换行了才继续增高 */
function LineInput(props: ComponentProps<'textarea'>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };
  // 值被外部改写（导入 SRT / 粘贴整篇）时也要重算
  useEffect(fit, [props.value]);
  return <textarea ref={ref} rows={1} {...props} onInput={fit} />;
}

export function GenerateDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const project = useProjectStore((s) => s.project);
  const setNarrationEntries = useProjectStore((s) => s.setNarrationEntries);
  const setProjectEndFrame = useProjectStore((s) => s.setProjectEndFrame);
  const setStyle = useProjectStore((s) => s.setNarrationStyle);

  const [topic, setTopic] = useState('');
  const [reference, setReference] = useState('');
  const [refFiles, setRefFiles] = useState<string[]>([]);
  // 已有字幕直接载入：一次性初始值，不跟随 project 引用变化重置（否则打字途中会被冲掉）
  const [rows, setRows] = useState<SubRow[]>(() => rowsFromProject(project?.narration?.entries));
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [genIdx, setGenIdx] = useState<number | null>(null);
  const [auditingId, setAuditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 一个能力一份配置；订阅它 = 改完服务立刻反映到本弹窗
  const llm = useProviderStore((s) => s.llm);
  const tts = useProviderStore((s) => s.tts);
  const fps = project?.globalConfig.defaultFPS || 30;
  const hasContent = rows.some((r) => r.text.trim());
  const style = project?.narration?.style || defaultNarrationStyle();

  const mkRow = (text: string): SubRow => ({
    id: generateId(), text, durationFrames: estimateTextDurationFrames(text, fps), startFrame: 0, status: 'none',
  });

  /** 用整篇文本替换当前行（AI 生成 / 粘贴 / 导入 SRT 共用） */
  const replaceRows = (texts: string[]) => setRows(resequenceRows(texts.map(mkRow)));

  /** 改文本：已有配音则保住音频时长，否则按字数重估 */
  const editText = (id: string, text: string) => setRows((rs) => resequenceRows(rs.map((r) => (
    r.id === id
      ? { ...r, text, durationFrames: r.audioUrl ? r.durationFrames : estimateTextDurationFrames(text, fps) }
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
      return resequenceRows([
        ...rs.slice(0, at),
        { ...base, text: first, durationFrames: base.audioUrl ? base.durationFrames : estimateTextDurationFrames(first, fps) },
        ...parts.slice(1).map((p) => mkRow(p)),
        ...rs.slice(at + 1),
      ]);
    });
  };

  const addRow = () => setRows((rs) => [...rs, mkRow('')]);
  const delRow = (id: string) => setRows((rs) => resequenceRows(rs.filter((r) => r.id !== id)));

  /** 合成一行并写回；抛错交给调度层判要不要重试 */
  const synthesizeInto = async (idx: number) => {
    const r = rows[idx];
    if (!r?.text.trim() || !tts) return;
    setRows((rs) => rs.map((x, i) => (i === idx ? { ...x, status: 'pending' } : x)));
    try {
      const { dataUrl, durationSec } = await callTTS(tts, r.text);
      setRows((rs) => resequenceRows(rs.map((x, i) => (
        i === idx
          ? { ...x, audioUrl: dataUrl, durationFrames: Math.max(1, Math.round(durationSec * fps)), status: 'ready' as const }
          : x
      ))));
    } catch (e) {
      setRows((rs) => rs.map((x, i) => (i === idx ? { ...x, status: 'error' as const } : x)));
      throw e;
    }
  };

  /** 单行生成配音（已有音频即覆盖） */
  const genRow = async (idx: number) => {
    if (!rows[idx]?.text.trim()) { setError(t('请先填写字幕文本', 'Fill in this line first')); return; }
    if (!tts?.baseUrl) { setError(t('未配置语音服务（顶栏 ⚙ 设置）', 'No TTS provider configured')); return; }
    setGenIdx(idx); setError(null);
    try { await synthesizeInto(idx); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setGenIdx(null); }
  };

  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null);
  const cancelBatch = useRef(false);

  /**
   * 全部生成：只补没有配音的行，走队列（并发上限与重试次数来自这个语音实例）。
   * 每行成功即刻写回，中途取消或失败都不影响已完成的行 —— 下次点它天然只补剩下的。
   */
  const genAllMissing = async () => {
    if (!tts?.baseUrl) { setError(t('未配置语音服务（顶栏 ⚙ 设置）', 'No TTS provider configured')); return; }
    const todo = rows.map((_, i) => i).filter((i) => rows[i].text.trim() && !rows[i].audioUrl);
    if (!todo.length) return;
    cancelBatch.current = false;
    setBatch({ done: 0, total: todo.length });
    setError(null);
    const res = await runBatch(todo.map((i) => () => synthesizeInto(i)), {
      concurrency: tts.maxConcurrency ?? 1,
      retries: tts.retryTimes ?? 0,
      isCancelled: () => cancelBatch.current,
      onProgress: (done, total) => setBatch({ done, total }),
    });
    setBatch(null);
    if (res.failed.length) {
      const head = res.failed.slice(0, 3).map((f) => `#${f.index + 1} ${f.error}`).join(' · ');
      setError(`${res.failed.length} ${t('行失败', 'line(s) failed')}: ${head}`);
    }
  };

  const audit = (r: SubRow) => {
    if (!r.audioUrl) return;
    const el = new Audio(r.audioUrl);
    setAuditingId(r.id);
    el.onended = () => setAuditingId(null);
    el.play().catch(() => setAuditingId(null));
  };

  const genText = async () => {
    if (!topic.trim()) { setError(t('请先填写你的需求', 'Enter your requirements first')); return; }
    if (!llm?.baseUrl) { setError(t('未配置文案生成服务（顶栏 ⚙ 设置）', 'No LLM provider configured')); return; }
    setBusy(true); setError(null);
    try {
      const sys = '你是「地图讲解视频」的文案策划。按用户需求与参考资料，写出可直接播报的连续口播稿。';
      const user = [
        `【需求】\n${topic.trim()}`,
        reference.trim() && `【参考资料】\n${reference.trim()}`,
        [
          '【输出要求】',
          '- 8–24 条口播字幕，按时间顺序排列，每条不超过 40 字，语言与需求一致',
          '- 每条占一行，行内不要再换行',
          '- 只输出字幕正文：不要编号、不要时间码、不要 Markdown、不要标题与解释',
        ].join('\n'),
      ].filter(Boolean).join('\n\n');

      const texts = splitScript(await callLLM(llm, sys, user));
      if (!texts.length) throw new Error(t('模型未返回可用内容', 'Model returned no usable content'));
      replaceRows(texts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const importSrt = async (file: File) => {
    try {
      const texts = parseSrt(await file.text());
      if (!texts.length) { setError(t('SRT 里没有可用文本', 'No usable cues in this SRT')); return; }
      replaceRows(texts);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 纯文本导入：按行拆分（带序号 / 时间轴的片段也能识别） */
  const importPasted = () => {
    const texts = splitScript(pasteText);
    if (!texts.length) { setError(t('粘贴的内容里没有可用文本', 'Nothing usable in the pasted text')); return; }
    replaceRows(texts);
    setPasteOpen(false);
    setPasteText('');
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

  /** 写回项目：只动字幕与配音；字幕比现有片长更久时把片长撑够 */
  const apply = () => {
    const entries: NarrationEntry[] = resequenceRows(rows)
      .filter((r) => r.text.trim())
      .map((r) => ({
        id: r.id, text: r.text, audioUrl: r.audioUrl, durationFrames: Math.max(1, r.durationFrames),
        startFrame: r.startFrame, locked: r.locked, status: r.status,
      }));
    setNarrationEntries(entries);
    const last = entries.reduce((n, e) => Math.max(n, e.startFrame + e.durationFrames), 0);
    if (last > (project?.endFrame || 0)) setProjectEndFrame(last);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div className="bg-card border border-white/10 rounded-xl shadow-2xl p-4 w-[34rem] max-h-[88vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">✨ {t('字幕生成', 'Subtitle studio')}</h3>
          <button
            onClick={onClose}
            className="h-6 px-2 rounded-md border border-white/15 text-[11px] text-muted-foreground hover:text-foreground hover:bg-white/10"
            title={t('关闭（不应用改动）', 'Close without applying')}
          >✕</button>
        </div>

        <textarea
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          rows={3}
          className="input text-xs resize-none mb-2"
          placeholder={t('描述你的需求（主题 / 大纲 / 风格 / 口吻 / 受众 / 时长 / 侧重点…任何要求）', 'Describe your requirements (topic / outline / style / tone / audience / length … anything)')}
        />

        <div className="flex items-center gap-2 mb-1">
          <span className="text-[11px] text-muted-foreground shrink-0">{t('参考资料', 'Reference')}</span>
          <label className="inline-flex items-center gap-1.5 h-6 px-2 rounded-md border border-white/15 bg-white/[0.045] text-[11px] hover:border-white/25 cursor-pointer transition-colors">
            ⬆ {t('上传文件（txt/md/json）', 'Upload file (txt/md/json)')}
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
                    setRefFiles((prev) => [...prev, f.name]);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  }
                }
                e.target.value = '';
              }}
            />
          </label>
        </div>
        {/* 参考资料只走文件上传：它只是提示词上下文，不需要用户手改 */}
        <div className="flex items-center gap-1.5 mb-2 min-h-5">
          <span className="text-[11px] text-muted-foreground truncate">
            {reference
              ? t(`已载入 ${refFiles.join('、')} · ${reference.length} 字`, `Loaded ${refFiles.join(', ')} · ${reference.length} chars`)
              : t('未载入（上传后自动拼进提示词）', 'Nothing loaded (uploaded text is appended to the prompt)')}
          </span>
          {!!reference && (
            <button
              onClick={() => { setReference(''); setRefFiles([]); }}
              className="h-5 px-1.5 rounded text-[10px] text-muted-foreground hover:text-foreground hover:bg-white/10 shrink-0"
              title={t('清除参考资料', 'Clear reference')}
            >✕ {t('清除', 'Clear')}</button>
          )}
        </div>

        <div className="flex items-center gap-1.5 mb-2 flex-wrap">
          {!IS_DESKTOP && <p className="w-full text-[11px] text-muted-foreground">{t('网页版不含 AI：文案请用「粘贴文本 / 导入 SRT」或逐行手写。AI 生成与配音在桌面版可用。', 'Web build has no AI: paste text, import an SRT, or type lines. AI lives in the desktop app.')}</p>}
          {IS_DESKTOP && <button
            onClick={genText}
            disabled={busy || !topic.trim() || !llm?.baseUrl}
            className="h-7 px-2.5 rounded-md bg-white text-black text-[11px] font-medium hover:bg-white/90 disabled:opacity-40"
            title={llm?.baseUrl
              ? t('按上面的需求与参考生成整篇文案（覆盖当前行）', 'Generate the script from the prompt (replaces lines)')
              : t('未配置文案生成服务（顶栏 ⚙ 设置）', 'No LLM provider configured')}
          >
            {busy ? t('生成中…', 'Working…') : t('🤖 AI 生成文案', '🤖 Generate script')}
          </button>}
          <label className="h-7 px-2 inline-flex items-center rounded-md border border-white/15 text-[11px] hover:bg-white/10 cursor-pointer" title={t('导入 SRT 覆盖当前行', 'Import SRT (replaces lines)')}>
            📥 {t('导入 SRT', 'Import SRT')}
            <input type="file" accept=".srt,text/plain" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importSrt(f); e.target.value = ''; }} />
          </label>
          <button
            onClick={() => setPasteOpen((v) => !v)}
            className={`h-7 px-2 rounded-md border text-[11px] hover:bg-white/10 ${pasteOpen ? 'border-brand bg-brand/20' : 'border-white/15'}`}
            title={t('直接粘贴整篇文案，按行拆成字幕', 'Paste a whole script; one subtitle per line')}
          >📥 {t('粘贴文本', 'Paste text')}</button>
          <button
            onClick={exportSrt}
            disabled={!rows.length}
            className="h-7 px-2 rounded-md border border-white/15 text-[11px] hover:bg-white/10 disabled:opacity-40"
            title={t('导出为 SRT', 'Export SRT')}
          >📤 {t('导出 SRT', 'Export SRT')}</button>
          <button onClick={addRow} className="h-7 px-2 rounded-md border border-white/15 text-[11px] hover:bg-white/10" title={t('在末尾加一行字幕', 'Append a line')}>＋ {t('加一行', 'Add')}</button>
          {IS_DESKTOP && <button
            onClick={genAllMissing}
            disabled={busy || genIdx !== null || !tts?.baseUrl || !rows.some((r) => r.text.trim() && !r.audioUrl)}
            className="h-7 px-2 rounded-md border border-sky-400/40 bg-sky-500/10 text-[11px] text-sky-200 hover:bg-sky-500/20 disabled:opacity-40"
            title={t('给所有还没有配音的行生成语音（已有配音的行不动）', 'Generate voice for every line without audio')}
          >
            ▶▶ {t('全部生成配音', 'Generate all voice')}
          </button>}
          {IS_DESKTOP && batch && (
            <>
              <span className="h-7 px-2 inline-flex items-center rounded-md border border-white/10 text-[11px] font-mono text-sky-200">
                {batch.done}/{batch.total}
              </span>
              <button
                onClick={() => { cancelBatch.current = true; }}
                className="h-7 px-2 rounded-md border border-white/15 text-[11px] hover:bg-white/10"
                title={t('不再开始新的行（在途的那条会跑完）', 'Stop starting new lines; the in-flight one finishes')}
              >✕ {t('取消', 'Cancel')}</button>
            </>
          )}
        </div>

        {pasteOpen && (
          <div className="mb-2 rounded-md border border-white/10 bg-white/[0.03] p-2">
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={5}
              className="input text-xs resize-y w-full mb-1.5"
              placeholder={t('把文案整段粘进来：每一行会变成一条字幕（带序号 / 时间轴的 SRT 片段也能识别）', 'Paste the script here: each line becomes one subtitle (numbered / timecoded cues are recognized too)')}
              autoFocus
            />
            <div className="flex items-center gap-2">
              <button
                onClick={importPasted}
                disabled={!pasteText.trim()}
                className="h-7 px-2.5 rounded-md bg-white text-black text-[11px] font-medium hover:bg-white/90 disabled:opacity-40"
              >{t('按行导入（覆盖当前行）', 'Import by line (replaces lines)')}</button>
              <span className="text-[10px] text-muted-foreground">
                {t(`识别到 ${splitScript(pasteText).length} 行`, `${splitScript(pasteText).length} line(s) detected`)}
              </span>
            </div>
          </div>
        )}

        {IS_DESKTOP && (
          <div className="mb-2">
            <p className="text-[11px] text-muted-foreground mb-1.5">{t('配音音色', 'Voice')}</p>
            <VoicePicker />
          </div>
        )}

        <div className="border-t border-white/10 pt-2 mb-2">
          <div className="space-y-1.5 max-h-[38vh] overflow-y-auto pr-1">
            {rows.map((r, idx) => (
              <div key={r.id} className="flex items-start gap-1.5 rounded-md border border-white/10 bg-white/[0.03] p-1.5">
                <span className="shrink-0 w-5 pt-1.5 text-right text-[10px] text-muted-foreground tabular-nums">{idx + 1}</span>
                <LineInput
                  value={r.text}
                  onChange={(e) => commitRowText(r.id, e.target.value)}
                  className="input text-xs resize-none flex-1 min-w-0"
                  placeholder={t('一行字幕（可直接贴入整篇文案，按行拆分）', 'One subtitle per line (paste a whole script to split)')}
                />
                <div className="shrink-0 flex items-center gap-1 pt-0.5">
                  {IS_DESKTOP && <button
                    onClick={() => genRow(idx)}
                    disabled={genIdx !== null || !r.text.trim()}
                    className="w-7 h-7 rounded-md border border-white/15 text-[11px] hover:bg-white/10 disabled:opacity-40"
                    title={r.audioUrl ? t('重新生成并覆盖原配音', 'Regenerate (overwrites audio)') : t('生成本句配音', 'Generate voice for this line')}
                  >
                    {genIdx === idx ? '⏳' : r.status === 'error' ? '⚠' : r.audioUrl ? '🔁' : '🔊'}
                  </button>}
                  {r.audioUrl && (
                    <button
                      onClick={() => audit(r)}
                      className="w-7 h-7 rounded-md border border-white/15 text-[11px] hover:bg-white/10"
                      title={t('试听本句配音', 'Preview this clip')}
                    >{auditingId === r.id ? '⏸' : '▶'}</button>
                  )}
                  <button
                    onClick={() => delRow(r.id)}
                    className="w-7 h-7 rounded-md text-[11px] text-muted-foreground hover:text-red-400 hover:bg-white/10"
                    title={t('删除本行', 'Delete line')}
                  >✕</button>
                </div>
              </div>
            ))}
            {!rows.length && (
              <p className="text-[11px] text-muted-foreground text-center py-4">
                {t('还没有字幕：点「AI 生成文案」，或用「粘贴文本 / 导入 SRT」，或「＋ 加一行」手写', 'No lines yet — generate, paste, import an SRT, or add one')}
              </p>
            )}
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground/80">
            {t('每行 = 一条字幕 + 一段配音；🔁 覆盖该行原配音；有配音时显示时长跟随音频', 'One line = one subtitle + one clip; 🔁 overwrites its audio; audio drives duration')}
          </p>
        </div>

        {error && <p className="text-[11px] text-red-400/90 mb-2">{error}</p>}

        <div className="flex justify-end gap-2 mb-1">
          <button onClick={onClose} disabled={busy} className="h-8 px-3 rounded-md border border-white/15 text-xs hover:bg-white/10 disabled:opacity-40">{t('取消', 'Cancel')}</button>
          <button
            onClick={apply}
            disabled={busy || !hasContent}
            className="h-8 px-3.5 rounded-md bg-white text-black text-xs font-medium hover:bg-white/90 disabled:opacity-40"
            title={t('把当前字幕与配音写回项目（只改字幕，不动元素 / 弹窗 / 特效 / 相机）', 'Apply subtitles & voice to the project')}
          >
            {busy ? t('生成中…', 'Working…') : t('应用字幕与配音', 'Apply subtitles & voice')}
          </button>
        </div>

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
            <span className="w-14 shrink-0 text-[11px] text-muted-foreground">{t('描边', 'Stroke')}</span>
            <NumberInput className="input h-7 w-16 text-xs" value={style.strokeWidth} step={1} min={0} onCommit={(v) => setStyle({ strokeWidth: Math.max(0, v) })} />
            <ColorPicker value={style.strokeColor} onChange={(c) => setStyle({ strokeColor: c })} />
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="w-14 shrink-0 text-[11px] text-muted-foreground">{t('底部', 'Bottom')}</span>
            <input type="range" min={0} max={40} step={1} value={style.posY} onChange={(e) => setStyle({ posY: parseInt(e.target.value, 10) })} className="flex-1" />
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
