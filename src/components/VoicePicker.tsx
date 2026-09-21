/**
 * VoicePicker — 字幕生成里的音色区：上「配音音色」（系统音色，男声/女声两组，默认折叠），
 * 下「克隆音色」（内置的男声/女声样本 + 自己上传的参考音频克隆出的音色）。
 *
 * 选中的音色写回**当前生效的 TTS 供应商**（voice 是供应商配置的一部分，不是项目数据）；
 * 克隆出的 voice_id 绑在克隆时的模型上，所以账本连模型一起记，换模型即视为另一条音色。
 * 声音克隆是 CosyVoice 端点独有的（voice-enrollment），其它协议下这一区只留一句说明。
 */
import { useRef, useState, type ReactNode } from 'react';
import { useT } from './ui/primitives';
import { activeProvider, useProviderStore } from '../stores/providerStore';
import { callTTS, cloneVoice, recipeOf, supports } from '../lib/providers';
import {
  CLIP_PRESETS, findCloned, forgetClonedVoice, fetchClipBytes, listClonedVoices,
  rememberClonedVoice, systemVoicesFor, type ClonedVoice, type VoiceGender,
} from '../lib/voices';

const SAMPLE_LABELS: string[] = CLIP_PRESETS.map((p) => p.label);

export function VoicePicker() {
  const t = useT();
  const tts = activeProvider('tts');
  const providerList = useProviderStore((s) => s.tts);
  void providerList; // 订阅：改完音色后这里要反映选中态
  const [cloned, setCloned] = useState<ClonedVoice[]>(() => listClonedVoices());
  const [busy, setBusy] = useState<'clone' | 'audition' | null>(null);
  const [busyLabel, setBusyLabel] = useState('');
  const [openGender, setOpenGender] = useState<Record<VoiceGender, boolean>>({ male: false, female: false });
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const model = tts?.model || '';
  const current = tts?.voice || '';
  const recipe = recipeOf(tts);
  const system = systemVoicesFor(recipe?.id, model);
  /** 能不能克隆 = 这个供应商有没有配 tts.clone 接口（早先是硬编 protocol === 'cosyvoice'） */
  const canClone = supports(tts, 'tts.clone');
  /**
   * 克隆出的音色绑在「克隆时用的模型」上，合成时 model 必须一模一样。
   * Qwen-TTS 的系统模型（qwen3-tts-flash）不吃克隆音色，只有 vc 那条吃 —— 所以克隆时顺带切过去，
   * 并在提示里说明（不静默改：这一改会让上面的系统音色列表换成空）。
   */
  const vcModel = (recipe?.models ?? []).find((m) => m.includes('-vc')) || '';
  const bindModel = recipe?.id === 'dashscope-qwen-tts' && vcModel && !model.includes('-vc') ? vcModel : model;

  const pick = (voiceId: string) => {
    if (!tts) return;
    useProviderStore.getState().update(tts.id, { voice: voiceId });
    setMsg('');
  };

  /** 参考音频 → 音色 ID；同样本同模型已克隆过就直接复用，不在服务端反复建音色 */
  const cloneFrom = async (bytes: ArrayBuffer, label: string, prefix: string) => {
    if (!tts?.baseUrl) { setMsg(t('未配置语音服务（顶栏 ⚙ 设置）', 'No TTS provider configured')); return; }
    const alsoModel = bindModel !== model ? bindModel : undefined;
    const done = (s: string) => (alsoModel ? `${s} · ${t('配音模型已切成', 'model switched to')} ${bindModel}` : s);
    const hit = findCloned(label, bindModel);
    if (hit) {
      useProviderStore.getState().update(tts.id, { voice: hit.voiceId, ...(alsoModel ? { model: alsoModel } : {}) });
      setMsg(done(t(`已复用之前的克隆 ${hit.voiceId}`, `Reused previous clone ${hit.voiceId}`)));
      return;
    }
    setBusy('clone'); setBusyLabel(label); setMsg(t('克隆中…（约几秒）', 'Cloning…'));
    try {
      const vid = await cloneVoice(tts, bytes, bindModel, prefix);
      setCloned(rememberClonedVoice({ label, voiceId: vid, model: bindModel, createdAt: Date.now() }));
      useProviderStore.getState().update(tts.id, { voice: vid, ...(alsoModel ? { model: alsoModel } : {}) });
      setMsg(done(`✓ ${vid}`));
    } catch (e) {
      setMsg(`✕ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null); setBusyLabel('');
    }
  };

  const audition = async () => {
    if (!tts?.baseUrl || !tts.voice) { setMsg(t('先选一个音色', 'Pick a voice first')); return; }
    setBusy('audition'); setMsg('');
    try {
      const { dataUrl } = await callTTS(tts, t('这段旁白用来试听音色。', 'This line previews the voice.'));
      audioRef.current?.pause();
      const el = new Audio(dataUrl);
      audioRef.current = el;
      el.play().catch(() => { /* 自动播放被拦时忽略 */ });
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
        disabled={!tts || (!o.onClick && !o.id)}
        title={`${o.title}${o.sub ? ` · ${o.sub}` : ''}`}
        className={`h-7 px-2 border text-[11px] truncate transition-colors disabled:opacity-40 max-w-[10rem] ${
          o.dashed ? 'rounded-md border-dashed' : 'rounded-l-md'
        } ${o.id && current === o.id ? 'bg-brand/20 border-brand text-foreground font-semibold' : 'border-white/15 text-foreground/80 hover:bg-white/10'}`}
      >
        {o.busy ? '⏳' : o.title}
      </button>
      {o.extra}
    </span>
  );

  /** 内置样本：没克隆过的那一格是虚线（点下去=先克隆再选中），克隆后与寻常音色无异 */
  const sampleCells = CLIP_PRESETS.map((p) => {
    const hit = findCloned(p.label, bindModel);
    const busyHere = busy === 'clone' && busyLabel === p.label;
    return cell({
      id: hit?.voiceId,
      title: `${p.label}·内置`,
      sub: hit
        ? t(`已克隆为 ${hit.voiceId}（模型 ${hit.model}）`, `Cloned as ${hit.voiceId} (model ${hit.model})`)
        : t(`用内置样本 ${p.file} 克隆一个${p.label}（目标模型 ${bindModel || '未设'}）`, `Clone from bundled sample ${p.file} (target model ${bindModel || 'unset'})`),
      dashed: !hit,
      busy: busyHere,
      onClick: hit ? undefined : async () => {
        try { await cloneFrom(await fetchClipBytes(p.file), p.label, `mv${p.key === 'male' ? 'm' : 'f'}`); }
        catch (e) { setMsg(`✕ ${e instanceof Error ? e.message : String(e)}`); }
      },
    });
  });

  const myClones = cloned.filter((c) => !SAMPLE_LABELS.includes(c.label) && (!bindModel || c.model === bindModel));
  /** 当前值既不在系统表也不在克隆账本里（如换模型后失效的 voice_id）：显示出来 */
  const known = new Set<string>([
    ...system.map((v) => v.id),
    ...cloned.filter((c) => !bindModel || c.model === bindModel).map((c) => c.voiceId),
  ]);
  const orphan = current && !known.has(current);

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
          const sel = vs.find((v) => v.id === current);
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
      </div>

      {/* 克隆音色（在「配音音色」下面）：内置样本 + 自己上传的 */}
      <div className="border-t border-white/10 pt-1.5">
        <p className="text-[11px] text-muted-foreground mb-1">{t('克隆音色', 'Cloned voices')}</p>
        {canClone ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {sampleCells}
            {myClones.map((c) => cell({
              id: c.voiceId,
              title: c.label,
              sub: t(`上传样本克隆 · ${c.voiceId}（模型 ${c.model}）`, `Uploaded clone · ${c.voiceId} (model ${c.model})`),
              extra: (
                <button
                  onClick={() => setCloned(forgetClonedVoice(c.voiceId))}
                  className="h-7 w-5 rounded-r-md border border-l-0 border-white/15 text-[10px] text-muted-foreground hover:text-red-400 hover:bg-white/10"
                  title={t('从列表移除（不删服务端音色）', 'Remove from list (keeps the server-side voice)')}
                >✕</button>
              ),
            }))}
            {orphan && cell({ id: current, title: t('当前音色', 'Current'), sub: t('不在系统表与克隆记录里', 'Not in the catalog or clone list') })}
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy !== null || !tts?.baseUrl}
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
            {t('该协议没有克隆音色（声音克隆只在 CosyVoice 供应商下可用）', 'This protocol has no cloned voices (cloning needs a CosyVoice provider)')}
          </p>
        )}
        <div className="flex items-center gap-1.5 mt-1.5">
          <button
            onClick={() => void audition()}
            disabled={busy !== null || !current}
            className="h-7 px-2 rounded-md border border-white/15 text-[11px] hover:bg-white/10 disabled:opacity-40"
            title={t('用当前音色合成一句试听', 'Synthesize one preview line with the current voice')}
          >{busy === 'audition' ? '⏳' : '▶'} {t('试听', 'Audition')}</button>
          <span className="text-[10px] text-muted-foreground/70 truncate" title={current}>
            {t('音色写回当前配音供应商', 'Voice is saved on the active TTS provider')}
            {current ? ` · ${current}` : ''}
            {recipe?.id === 'dashscope-qwen-tts' && model === 'qwen-tts'
              ? t(' · 旧模型 qwen-tts 只带 4 个系统音色，改用 qwen3-tts-flash 可选全部', ' · the legacy model qwen-tts ships 4 voices only; use qwen3-tts-flash for the full list')
              : ''}
            {msg ? ` · ${msg}` : ''}
          </span>
        </div>
      </div>
    </div>
  );
}
