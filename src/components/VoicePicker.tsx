/**
 * VoicePicker — 字幕生成里的音色区：上「配音音色」（系统音色，男声 / 女声两组，默认折叠），
 * 下「克隆音色」（内置男声 / 女声样本格 + ⬆ 上传其它参考音频克隆）。
 *
 * **音色是调用级参数**（不写进实例配置）：这个组件受控 —— 选择结果交给调用方（字幕生成）保存并随每次合成传下去。
 * 克隆出的 voiceId 绑在「哪个实例 + 哪个目标模型」上，所以账本（`voice` 表 / `useVoiceStore`）
 * 三样一起记，换模型即视为另一条音色；参考音频原件也存着，音色失效时靠它重建。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from './ui/primitives';
import { useProviderStore } from '../stores/providerStore';
import { callTTS, supports, templateOf } from '../lib/providers';
import { playAudition, stopAudition } from '../lib/audition';
import { requestOf, type InstanceDef, type ParamSpec } from '../lib/request-engine';
import { CLIP_PRESETS, fetchClipBytes, systemVoicesFor, type VoiceGender } from '../lib/voices';
import { useVoiceStore } from '../stores/voiceStore';
import type { VoiceRow } from '../types';

const SAMPLE_LABELS: string[] = CLIP_PRESETS.map((pr) => pr.label);

/** 这个实例配音用的模型：先看请求级（同步那条），再退到实例级 */
export function voiceModelOf(inst: InstanceDef | null | undefined): string {
  if (!inst) return '';
  const v = inst.values;
  const given = v.requests?.['sync.submit']?.model ?? v.requests?.['async.submit']?.model ?? v.instance?.model;
  if (typeof given === 'string' && given.trim()) return given.trim();
  // 实例没显式填过就走模板声明的默认值 —— 与引擎三层取值同一条规则，别在这儿另起一套
  const tpl = templateOf(inst);
  const spec = [...(tpl?.instanceParams ?? []), ...(tpl ? requestOf(tpl, 'sync.submit')?.requestParams ?? [] : [])]
    .find((x) => x.key === 'model');
  return String(spec?.defaultValue ?? '');
}

const strOf = (v: unknown) => (typeof v === 'string' ? v : '');

export function VoicePicker({ inst, voice, onPick }: {
  inst: InstanceDef | null;
  voice: string;
  onPick: (voiceId: string) => void;
}) {
  const t = useT();
  const updateInstance = useProviderStore((s) => s.updateInstance);
  const voiceRows = useVoiceStore((s) => s.rows);
  const cloneLedger = useVoiceStore((s) => s.clone);
  const forgetVoice = useVoiceStore((s) => s.remove);
  const usableVoice = useVoiceStore((s) => s.usable);
  const [busy, setBusy] = useState<'clone' | 'audition' | null>(null);
  const [busyLabel, setBusyLabel] = useState('');
  const [openGender, setOpenGender] = useState<Record<VoiceGender, boolean>>({ male: false, female: false });
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  /** 试听中（全应用只有一路声音，见 lib/audition） */
  const [auditioning, setAuditioning] = useState(false);

  const tpl = templateOf(inst);
  const model = voiceModelOf(inst);
  const system = systemVoicesFor(tpl?.id, model);
  /** 能不能克隆 = 这份模板有没有配 clone 请求（不再是协议字符串判断） */
  const canClone = supports(inst, 'clone');
  /**
   * 克隆出的音色绑在「克隆时用的模型」上，合成时 model 必须一模一样。
   * Qwen-TTS 的系统模型不吃克隆音色，只有 vc 那条吃 —— 克隆时顺带切过去并在提示里说明（不静默改）。
   */
  // 「哪条模型能吃克隆音色」不写死在代码里：从模板给 model 参数配的候选值里找那条 -vc
  const modelOptions = (key: string): string[] => {
    if (!tpl) return [];
    const all: ParamSpec[] = [...(tpl.instanceParams ?? []), ...(requestOf(tpl, 'sync.submit')?.requestParams ?? [])];
    return (all.find((x) => x.key === key)?.options ?? []).map((o) => String(typeof o === 'object' && o !== null ? o.value : o));
  };
  const vcModel = modelOptions('model').find((m) => m.includes('-vc')) ?? '';
  // 「哪条模型吃克隆音色」看模板给 model 配的候选值（-vc 是上游的命名），不认模板 id —— 换一家也不用改这里
  const bindModel = canClone && vcModel && !model.includes('-vc') ? vcModel : model;

  const setModel = (m: string) => {
    if (!inst) return;
    updateInstance(inst.id, {}, {
      instance: { model: m },
      requests: { 'sync.submit': { ...(inst.values.requests?.['sync.submit'] ?? {}), model: m } },
    });
  };

  const pick = (voiceId: string) => { onPick(voiceId); setMsg(''); };

  /** 该实例 + 当前模型下能用的音色（含别人在别的机器上建好后同步过来的） */
  const cloned: VoiceRow[] = inst
    ? voiceRows.filter((x) => x.providerId === inst.id && x.targetModel === bindModel && usableVoice(x))
    : [];
  /** 按内置样本名找：样本格要能认出「这条就是那个样本克隆出来的」 */
  const cloneOfLabel = (label: string) => cloned.find((x) => x.label === label);

  /** 参考音频 → 音色 ID；同样本同模型已克隆过就直接复用，不在服务端反复建音色 */
  const cloneFrom = async (bytes: ArrayBuffer, label: string, prefix: string, mime = 'audio/wav', name = `${prefix}.wav`) => {
    if (!inst || !strOf(inst.values.instance?.baseUrl)) { setMsg(t('未配置语音服务（顶栏 ⚙ 设置）', 'No TTS instance configured')); return; }
    const alsoModel = bindModel !== model ? bindModel : undefined;
    const done = (s: string) => (alsoModel ? `${s} · ${t('配音模型已切成', 'model switched to')} ${bindModel}` : s);
    setBusy('clone'); setBusyLabel(label); setMsg(t('克隆中…（约几秒）', 'Cloning…'));
    try {
      const row = await cloneLedger({ inst, bytes, mime, name, label, targetModel: bindModel, prefix });
      if (row.voiceId) pick(row.voiceId);
      if (alsoModel) setModel(alsoModel);
      setMsg(done(`✓ ${row.voiceId ?? ''}`));
    } catch (e) {
      setMsg(`✕ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null); setBusyLabel('');
    }
  };

  useEffect(() => () => stopAudition(), []);

  const audition = async () => {
    if (!inst || !voice) { setMsg(t('先选一个音色', 'Pick a voice first')); return; }
    setBusy('audition'); setMsg('');
    try {
      const { dataUrl } = await callTTS(inst, t('这段旁白用来试听音色。', 'This line previews the voice.'), voice);
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
        onClick={o.onClick || (() => pick(o.id || ''))}
        disabled={!inst || (!o.onClick && !o.id)}
        title={`${o.title}${o.sub ? ` · ${o.sub}` : ''}`}
        className={`h-7 px-2 border text-[11px] truncate transition-colors disabled:opacity-40 max-w-[10rem] ${
          o.dashed ? 'rounded-md border-dashed' : 'rounded-l-md'
        } ${o.id && voice === o.id ? 'bg-brand/20 border-brand text-foreground font-semibold' : 'border-white/15 text-foreground/80 hover:bg-white/10'}`}
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
      title: `${pr.label}·内置`,
      sub: hit
        ? t(`已克隆为 ${hit.voiceId}（模型 ${hit.targetModel}）`, `Cloned as ${hit.voiceId} (model ${hit.targetModel})`)
        : t(`用内置样本 ${pr.file} 克隆一个${pr.label}（目标模型 ${bindModel || '未设'}）`, `Clone from bundled sample ${pr.file} (target ${bindModel || 'unset'})`),
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
  const known = new Set<string>([...system.map((v) => v.id), ...cloned.map((c) => c.voiceId ?? '')]);
  /** 当前值既不在系统表也不在克隆记录里（如换模型后失效的 voiceId）：显示出来，别让它凭空消失 */
  const orphan = voice && !known.has(voice);
  const groups: { key: VoiceGender; label: string }[] = [
    { key: 'male', label: t('男声', 'Male') },
    { key: 'female', label: t('女声', 'Female') },
  ];

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        {groups.map((g) => {
          const vs = system.filter((v) => v.gender === g.key);
          if (!vs.length) return null;
          const sel = vs.find((v) => v.id === voice);
          const opened = openGender[g.key];
          return (
            <div key={g.key}>
              <button
                onClick={() => setOpenGender((s) => ({ ...s, [g.key]: !s[g.key] }))}
                className="flex items-center gap-1.5 h-6 text-[11px] text-muted-foreground hover:text-foreground"
                title={opened ? t('收起', 'Collapse') : t('展开可选音色', 'Expand voices')}
              >
                <span className="w-2.5">{opened ? '▾' : '▸'}</span>
                <span className="font-medium">{g.label}</span>
                <span className="tabular-nums opacity-70">{vs.length}</span>
                {!opened && (sel ? <span className="text-foreground">{sel.name}</span> : <span className="opacity-50">{t('未选', 'none')}</span>)}
              </button>
              {opened && (
                <div className="flex flex-wrap gap-1 pl-4 pt-0.5">
                  {vs.map((v) => cell({ id: v.id, title: v.name, sub: `${v.note || ''} ${v.id}` }))}
                </div>
              )}
            </div>
          );
        })}
        {/* 自定义模板没有官方音色表：给一个手填音色 ID 的框，别让人只能干瞪眼 */}
        {!system.length && (
          <label className="flex items-center gap-1.5 text-[11px]">
            <span className="text-muted-foreground">{t('音色 ID', 'Voice id')}</span>
            <input value={voice} onChange={(e) => pick(e.target.value)} placeholder="voice_id / speaker"
              className="input h-7 w-52 text-xs font-mono" />
          </label>
        )}
      </div>

      <div className="border-t border-white/10 pt-1.5">
        <p className="text-[11px] text-muted-foreground mb-1">{t('克隆音色', 'Cloned voices')}</p>
        {canClone ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {sampleCells}
            {myClones.map((c) => cell({
              id: c.voiceId,
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
            {orphan && cell({ id: voice, title: t('当前音色', 'Current'), sub: t('不在系统表与克隆记录里', 'Not in the catalog or clone list') })}
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy !== null || !inst}
              className="h-7 px-2 rounded-md border border-white/15 text-[11px] hover:bg-white/10 disabled:opacity-40"
              title={t('上传 3~60 秒参考音频，克隆成绑定当前模型的新音色', 'Upload 3–60s reference audio to clone a voice for the current model')}
            >⬆ {t('上传其它音色', 'Upload reference')}</button>
            <input
              ref={fileRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) await cloneFrom(await f.arrayBuffer(), f.name.replace(/\.[^.]+$/, ''), 'mv');
                e.target.value = '';
              }}
            />
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground/70">
            {t('这份模板没配克隆接口（在接口模板里勾「有克隆音色接口」并补 clone 请求）', 'This template has no clone endpoint — add one in the templates page')}
          </p>
        )}
        <div className="flex items-center gap-1.5 mt-1.5">
          <button
            onClick={() => {
              if (auditioning) { stopAudition(); setAuditioning(false); return; }
              void audition();
            }}
            disabled={busy !== null || (!auditioning && !voice)}
            className="h-7 px-2 rounded-md border border-white/15 text-[11px] hover:bg-white/10 disabled:opacity-40"
            title={auditioning ? t('停止试听', 'Stop') : t('用当前音色合成一句试听', 'Synthesize one preview line with the current voice')}
          >{busy === 'audition' ? '⏳' : auditioning ? '⏸' : '▶'} {auditioning ? t('停止', 'Stop') : t('试听', 'Audition')}</button>
          <span className="text-[10px] text-muted-foreground/70 truncate" title={voice}>
            {t('音色随每次合成传下去（不写进实例配置）', 'The voice goes with each call, not the instance')}
            {voice ? ` · ${voice}` : ''}
            {tpl?.id === 'dashscope-qwen-tts' && model === 'qwen-tts'
              ? t(' · 旧模型 qwen-tts 只带 4 个系统音色，改用 qwen3-tts-flash 可选全部', ' · the legacy model qwen-tts ships 4 voices only; use qwen3-tts-flash for the full list')
              : ''}
            {msg ? ` · ${msg}` : ''}
          </span>
        </div>
      </div>
    </div>
  );
}
