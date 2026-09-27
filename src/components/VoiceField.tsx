/**
 * VoiceField — 音色选择器（⚙ 那一格与字幕生成**共用这一个组件**）
 *
 * 上半：这一份模板声明的**音色表**（就是「音色 ID」那条参数的候选值，按 `group` 分组、默认折叠，
 * 组名与条数都来自模板 —— 换一家上游、自己填一份表，界面就跟着变，代码里没有音色表）。
 * 下半：这条实例的**克隆音色池**（内置样本格 + ⬆ 上传参考音频克隆）—— 只有声明成音色表
 * （`voiceTable`）且这份模板配了克隆接口才长这一段。
 *
 * **音色是调用级参数**：组件受控，选择结果（音色 id + 它绑的模型）交给调用方
 * （字幕生成存进每一行；⚙ 存进这条实例的这一格）。克隆出的 voiceId 绑「哪个实例 + 哪个目标模型」，
 * 所以账本（`voice` 表 / `useVoiceStore`）三样一起记，参考音频原件也存着 —— 音色失效时靠它重建。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from './ui/primitives';
import { callTTS, cloneTargetModel, supports, templateOf, voiceModelOf } from '../lib/providers';
import { playAudition, stopAudition } from '../lib/audition';
import { cloneTakesUrl, paramSpec, scopeOf, visibleOptions, type InstanceDef, type ParamSpec, type ReqKey } from '../lib/request-engine';
import { CLIP_PRESETS, fetchClipBytes } from '../lib/voices';
import { useVoiceStore } from '../stores/voiceStore';
import type { VoiceRow } from '../types';

const SAMPLE_LABELS: string[] = CLIP_PRESETS.map((pr) => pr.label);
const strOf = (v: unknown) => (typeof v === 'string' ? v : '');

export function VoiceField({ inst, slot, spec, value, extra, audition = false, onPick }: {
  inst: InstanceDef | null;
  /** 这一格在哪：过滤候选值要读同格 `model` 的取值，选克隆音色也要把那一格的 model 一起改掉 */
  slot: ReqKey;
  /** 「音色 ID」那条声明（候选值就是音色表） */
  spec: ParamSpec;
  value: string;
  /** 试听也要带下去的调用级参数（如项目级发音修正）；模板没引用的键引擎自会忽略 */
  extra?: Record<string, unknown>;
  /** ⚙ 里不开（那次真发的正确入口是「试调用」），字幕生成开 */
  audition?: boolean;
  /** 选中一个音色；第二个参数是它绑的模型（克隆音色才有 —— 合成必须同款，实测系统音色喂 `-vc` 上游直接拒） */
  onPick: (voiceId: string, voiceModel?: string) => void;
}) {
  const t = useT();
  const voiceRows = useVoiceStore((s) => s.rows);
  const cloneLedger = useVoiceStore((s) => s.clone);
  const forgetVoice = useVoiceStore((s) => s.remove);
  const usableVoice = useVoiceStore((s) => s.usable);
  const [busy, setBusy] = useState<'clone' | 'audition' | null>(null);
  const [busyLabel, setBusyLabel] = useState('');
  const [openGroup, setOpenGroup] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  /** 试听中（全应用只有一路声音，见 lib/audition） */
  const [auditioning, setAuditioning] = useState(false);

  const tpl = templateOf(inst);
  /**
   * 显示与选中态看**这一格实际会发出去的那个值**：调用方没显式给（⚙ 里没在这格钉过音色）时，
   * 回落到模板声明的默认音色 —— 否则组标题上永远写着「未选」，而真发用的是默认值。
   */
  const shown = value || (tpl && inst ? String(scopeOf(tpl, inst, slot).values[spec.key] ?? '') : '');
  /** 音色表：候选值按这一格当前 `model` 的取值过滤过（`-vc` 那条模型不吃系统音色，实测） */
  const catalog = tpl && inst ? visibleOptions(tpl, inst, slot, spec.key) : [];
  /** 组名取模板里写的字面量，顺序 = 首次出现；没写 group 的归到不分组那一批（下面 groups 为空即平铺） */
  const groups = [...new Set(catalog.map((o) => o.group ?? '').filter(Boolean))];
  const flat = catalog.filter((o) => !o.group);
  /** 能不能克隆 = 这份模板有没有配 clone 请求（不再是协议字符串判断）—— 与有没有音色表无关 */
  const canClone = supports(inst, 'clone');
  /** 这一家怎么收参考音频：给文件（三种接法）还是**只给一个公网地址** —— 界面因此长得不一样 */
  const viaUrl = cloneTakesUrl(templateOf(inst));
  const [urlDraft, setUrlDraft] = useState('');
  const cloneModel = cloneTargetModel(inst);
  const instModel = voiceModelOf(inst);

  /** 该实例下能用的克隆音色：每条自带它的目标模型，所以不受实例当前模型限制 */
  const cloned: VoiceRow[] = inst
    ? voiceRows.filter((x) => x.providerId === inst.id && usableVoice(x))
    : [];
  /** 按内置样本名找：样本格要能认出「这条就是那个样本克隆出来的」 */
  const cloneOfLabel = (label: string) => cloned.find((x) => x.label === label);

  const pick = (voiceId: string, model?: string) => { onPick(voiceId, model); setMsg(''); };

  /** 参考音频 → 音色 ID；同样本同模型已克隆过就直接复用，不在服务端反复建音色 */
  const cloneFrom = async (bytes: ArrayBuffer, label: string, prefix: string, mime = 'audio/wav', name = `${prefix}.wav`, url?: string) => {
    if (!inst || !strOf(inst.values.instance?.baseUrl)) { setMsg(t('未配置语音服务（顶栏 ⚙ 设置）', 'No TTS instance configured')); return; }
    setBusy('clone'); setBusyLabel(label); setMsg(t('克隆中…（约几秒）', 'Cloning…'));
    try {
      const row = await cloneLedger({ inst, bytes, mime, name, url, label, targetModel: cloneModel, prefix });
      if (row.voiceId) pick(row.voiceId, row.targetModel || cloneModel);
      setMsg(`✓ ${row.voiceId ?? ''}`);
    } catch (e) {
      setMsg(`✕ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null); setBusyLabel('');
    }
  };

  /** 公网地址 → 音色 ID（那一家不吃文件；原件仍会被取回存进素材库，账本才重建得起来） */
  const cloneFromUrl = async () => {
    const link = urlDraft.trim();
    if (!link) { setMsg(t('先粘一个可访问的音频地址', 'Paste a reachable audio URL first')); return; }
    await cloneFrom(undefined as unknown as ArrayBuffer, `地址 ${link.slice(-18)}`, 'mvurl', undefined, undefined, link);
  };

  useEffect(() => () => stopAudition(), []);

  const runAudition = async () => {
    if (!inst || !shown) { setMsg(t('先选一个音色', 'Pick a voice first')); return; }
    setBusy('audition'); setMsg('');
    try {
      const { dataUrl } = await callTTS(inst, t('这段旁白用来试听音色。', 'This line previews the voice.'), shown,
        { ...(valueModel ? { model: valueModel } : {}), ...(extra ?? {}) });
      setAuditioning(true);
      // 播不出去（浏览器拦自动播放）就当没在播，别让按钮一直显示在响
      if (!await playAudition(dataUrl, () => setAuditioning(false))) setAuditioning(false);
    } catch (e) {
      setMsg(`✕ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null); setBusyLabel('');
    }
  };

  const cell = (o: {
    id?: string;
    /** 这条音色绑的模型（克隆音色才有；系统音色不填 = 用实例配的） */
    model?: string;
    title: string;
    sub?: string;
    extra?: ReactNode;
    /** 虚线格 = 还没克隆出来，点它先克隆 */
    dashed?: boolean;
    busy?: boolean;
    onClick?: () => void;
  }) => (
    <span key={o.id || o.title} className="inline-flex items-center">
      <button
        onClick={o.onClick || (() => pick(o.id || '', o.model))}
        disabled={!inst || (!o.onClick && !o.id)}
        title={`${o.title}${o.sub ? ` · ${o.sub}` : ''}`}
        className={`h-7 px-2 border text-[11px] truncate transition-colors disabled:opacity-40 max-w-[10rem] ${
          o.dashed ? 'rounded-md border-dashed' : 'rounded-l-md'
        } ${o.id && shown === o.id ? 'bg-brand/20 border-brand text-foreground font-semibold' : 'border-white/15 text-foreground/80 hover:bg-white/10'}`}
      >
        {o.busy ? '⏳' : o.title}
      </button>
      {o.extra}
    </span>
  );

  /** 内置样本格：没克隆过的那一格是虚线（点下去 = 先克隆再选中），克隆过就与寻常音色无异 */
  const sampleCells = CLIP_PRESETS.map((pr) => {
    const hit = cloneOfLabel(pr.label);
    return cell({
      id: hit?.voiceId,
      model: hit?.targetModel,
      title: `${pr.label}·内置`,
      sub: hit
        ? t(`已克隆为 ${hit.voiceId}（模型 ${hit.targetModel}）`, `Cloned as ${hit.voiceId} (model ${hit.targetModel})`)
        : t(`用内置样本 ${pr.file} 克隆一个${pr.label}（目标模型 ${cloneModel || '未设'}）`, `Clone from bundled sample ${pr.file} (target ${cloneModel || 'unset'})`),
      dashed: !hit,
      busy: busy === 'clone' && busyLabel === pr.label,
      onClick: hit ? undefined : async () => {
        try {
          const bytes = await fetchClipBytes(pr.file);
          await cloneFrom(bytes, pr.label, `mv${pr.key === 'male' ? 'm' : 'f'}`,
            pr.file.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav', pr.file.split('/').pop() ?? 'sample');
        } catch (e) { setMsg(`✕ ${e instanceof Error ? e.message : String(e)}`); }
      },
    });
  });

  const myClones = cloned.filter((c) => !SAMPLE_LABELS.includes(c.label));
  /** 当前值是哪来的：表里 / 克隆账本里 / 都不是（换了模板或换了模型后失效的那个） */
  const inCatalog = catalog.find((o) => String(o.value) === shown);
  const inLedger = cloned.find((c) => c.voiceId === shown);
  /** 选中项绑的模型：克隆账本说了算（合成必须同款），表里的值用实例当前模型 */
  const valueModel = inLedger?.targetModel ?? '';
  const orphan = !!shown && !inCatalog && !inLedger;
  const renderCells = (list: typeof catalog) => list.map((o) => cell({
    id: String(o.value), title: o.label ?? String(o.value), sub: [o.note, String(o.value)].filter(Boolean).join(' · '),
  }));

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        {groups.map((g) => {
          const vs = catalog.filter((o) => o.group === g);
          const sel = vs.find((o) => String(o.value) === shown);
          const opened = openGroup[g];
          return (
            <div key={g}>
              <button
                onClick={() => setOpenGroup((s) => ({ ...s, [g]: !s[g] }))}
                className="flex items-center gap-1.5 h-6 text-[11px] text-muted-foreground hover:text-foreground"
                title={opened ? t('收起', 'Collapse') : t('展开可选音色', 'Expand voices')}
              >
                <span className="w-2.5">{opened ? '▾' : '▸'}</span>
                <span className="font-medium">{g}</span>
                <span className="tabular-nums opacity-70">{vs.length}</span>
                {!opened && (sel ? <span className="text-foreground">{sel.label}</span> : <span className="opacity-50">{t('未选', 'none')}</span>)}
              </button>
              {opened && <div className="flex flex-wrap gap-1 pl-4 pt-0.5">{renderCells(vs)}</div>}
            </div>
          );
        })}
        {!!flat.length && <div className="flex flex-wrap gap-1">{renderCells(flat)}</div>}
        {/* 这份模板没填音色表（或当前模型下一条都不适用）：给一个手填框，别让人只能干瞪眼 */}
        {!catalog.length && (
          <label className="flex items-center gap-1.5 text-[11px]">
            <span className="text-muted-foreground">{spec.label || spec.key}</span>
            <input value={shown} onChange={(e) => pick(e.target.value)} placeholder="voice_id / speaker"
              className="input h-7 w-52 text-xs font-mono" />
          </label>
        )}
        {!!catalog.length && orphan && (
          <p className="text-[10px] text-red-400">
            {t(`当前值「${shown}」不在这份模板的音色表里，也不在这条实例的克隆记录里（换过模板或换过模型？）—— 换个音色，或在接口模板里把它加进表`,
              `Current value isn't in this template's catalog or this instance's clone list`)}
          </p>
        )}
      </div>

      {canClone || cloned.length ? (
        <div className="border-t border-white/10 pt-1.5">
          <p className="text-[11px] text-muted-foreground mb-1">{t('克隆音色', 'Cloned voices')}</p>
          {canClone ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {!viaUrl && sampleCells}
              {myClones.map((c) => cell({
                id: c.voiceId,
                model: c.targetModel,
                title: c.label,
                sub: t(`上传样本克隆 · ${c.voiceId}（模型 ${c.targetModel}）`, `Uploaded clone · ${c.voiceId} (model ${c.targetModel})`),
                extra: (
                  <button
                    onClick={() => void forgetVoice(c.rowId)}
                    className="h-7 w-5 rounded-r-md border border-l-0 border-white/15 text-[10px] text-muted-foreground hover:text-red-400 hover:bg-white/10"
                    title={t('从列表移除（不删服务端音色）', 'Remove from list (keeps the server-side voice)')}
                  >✕</button>
                ),
              }))}
              {orphan && cell({ id: shown, model: valueModel || undefined, title: t('当前音色', 'Current'), sub: t('不在音色表与克隆记录里', 'Not in the catalog or clone list') })}
              {viaUrl && <input
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                placeholder={t('参考音频的公网 https 直链', 'Public https link to the reference audio')}
                className="input h-7 min-w-0 flex-1 text-[11px]"
                title={t('这一家的复刻只收可访问的音频地址（不吃本地文件）；地址指向的音频会另存一份进素材库，音色失效时靠它重建', 'This upstream takes only a reachable audio URL; the file is copied into the asset store so the voice can be rebuilt')}
              />}
              {viaUrl && <button
                onClick={() => void cloneFromUrl()}
                disabled={busy !== null || !inst}
                className="h-7 shrink-0 whitespace-nowrap rounded-md border border-white/15 px-2 text-[11px] hover:bg-white/10 disabled:opacity-40"
                title={t(`用这个地址造一个绑定模型 ${cloneModel || '未设'} 的新音色`, 'Create a voice for model from this URL')}
              >✚ {t('造一个音色', 'Create voice')}</button>}
              {!viaUrl && <button
                onClick={() => fileRef.current?.click()}
                disabled={busy !== null || !inst}
                className="h-7 shrink-0 whitespace-nowrap rounded-md border border-white/15 px-2 text-[11px] hover:bg-white/10 disabled:opacity-40"
                title={t(`上传 10 秒 ~ 5 分钟参考音频，克隆成绑定模型 ${cloneModel || '未设'} 的新音色`, `Upload reference audio to clone a voice for model ${cloneModel || 'unset'}`)}
              >⬆ {t('上传其它音色', 'Upload reference')}</button>}
              {!viaUrl && <input
                ref={fileRef}
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) await cloneFrom(await f.arrayBuffer(), f.name.replace(/\.[^.]+$/, ''), 'mv');
                  e.target.value = '';
                }}
              />}
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground/70">
              {t('这份模板没配克隆接口（在接口模板里勾「建音色」并补克隆那一格）', 'This template has no clone endpoint — turn it on in the templates page')}
            </p>
          )}
        </div>
      ) : null}

      <div className="flex items-center gap-1.5">
        {audition && (
          <button
            onClick={() => {
              if (auditioning) { stopAudition(); setAuditioning(false); return; }
              void runAudition();
            }}
            disabled={busy !== null || (!auditioning && !shown)}
            className="h-7 shrink-0 whitespace-nowrap rounded-md border border-white/15 px-2 text-[11px] hover:bg-white/10 disabled:opacity-40"
            title={auditioning ? t('停止试听', 'Stop') : t('用当前音色合成一句试听', 'Synthesize one preview line with the current voice')}
          >{busy === 'audition' ? '⏳' : auditioning ? '⏸' : '▶'} {auditioning ? t('停止', 'Stop') : t('试听', 'Audition')}</button>
        )}
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/70" title={shown}>
          {shown ? `${shown}` : ''}
          {(valueModel || inCatalog) ? ` · ${valueModel || instModel}` : ''}
          {msg ? ` · ${msg}` : ''}
        </span>
      </div>
    </div>
  );
}

/** 字幕生成那侧：从实例里找出那条声明成音色表的参数（找不到就没有音色区，退化成手填） */
export function voiceSpecOf(inst: InstanceDef | null, slot: ReqKey): ParamSpec | undefined {
  const tpl = templateOf(inst);
  if (!tpl) return undefined;
  const all = [...(tpl.instanceParams ?? []), ...(tpl.sync?.submit?.requestParams ?? []), ...(tpl.async?.submit?.requestParams ?? [])];
  return all.find((p) => p.voiceTable) ?? paramSpec(tpl, slot, 'voice');
}
