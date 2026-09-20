/**
 * VoicePicker — 字幕生成里的「配音音色」区：系统音色（男声 / 女声）+ 我的克隆音色 + 一键克隆。
 *
 * 选中的音色写回**当前生效的 TTS 供应商**（voice 是供应商配置的一部分，不是项目数据）；
 * 克隆出的 voice_id 绑在克隆时的模型上，所以一并记下模型，换模型即视为另一条音色。
 * 入口只在这里（设置面板 ⚙ 已不再放音色与克隆）。
 */
import { useRef, useState } from 'react';
import { useT } from './ui/primitives';
import { activeProvider, useProviderStore } from '../stores/providerStore';
import { callTTS, cloneVoice } from '../lib/providers';
import {
  CLIP_PRESETS, findCloned, forgetClonedVoice, fetchClipBytes, listClonedVoices,
  rememberClonedVoice, systemVoicesFor, type ClonedVoice,
} from '../lib/voices';

export function VoicePicker() {
  const t = useT();
  const tts = activeProvider('tts');
  const providerList = useProviderStore((s) => s.tts);
  void providerList; // 订阅：改完音色后这里要反映选中态
  const [cloned, setCloned] = useState<ClonedVoice[]>(() => listClonedVoices());
  const [busy, setBusy] = useState<'clone' | 'audition' | null>(null);
  const [msg, setMsg] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const model = tts?.model || '';
  const current = tts?.voice || '';
  const system = systemVoicesFor(tts?.protocol);
  const genders: { key: 'male' | 'female'; label: string }[] = [
    { key: 'male', label: t('男声', 'Male') },
    { key: 'female', label: t('女声', 'Female') },
  ];

  const pick = (voiceId: string) => {
    if (!tts) return;
    useProviderStore.getState().update(tts.id, { voice: voiceId });
    setMsg('');
  };

  /** 参考音频 → voice_id；同样本同模型已克隆过就直接复用，不在服务端反复建音色 */
  const cloneFrom = async (bytes: ArrayBuffer, label: string, prefix: string) => {
    if (!tts?.baseUrl) { setMsg(t('未配置语音服务（顶栏 ⚙ 设置）', 'No TTS provider configured')); return; }
    const hit = findCloned(label, model);
    if (hit) {
      pick(hit.voiceId);
      setMsg(t(`已复用之前的克隆 ${hit.voiceId}`, `Reused previous clone ${hit.voiceId}`));
      return;
    }
    setBusy('clone'); setMsg(t('克隆中…（约几秒）', 'Cloning…'));
    try {
      const vid = await cloneVoice(tts, bytes, model, prefix);
      setCloned(rememberClonedVoice({ label, voiceId: vid, model, createdAt: Date.now() }));
      pick(vid);
      setMsg(`✓ ${vid}`);
    } catch (e) {
      setMsg(`✕ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
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
      setBusy(null);
    }
  };

  /** 当前值不在系统表也不在克隆账本里（如更早克隆的 voice_id）：显示出来并可移除 */
  const known = new Set<string>([...system.map((v) => v.id), ...cloned.map((c) => c.voiceId)]);
  const orphan = current && !known.has(current);

  const cell = (id: string, title: string, sub?: string) => (
    <button
      key={id}
      onClick={() => pick(id)}
      disabled={!tts}
      title={`${id}${sub ? ` · ${sub}` : ''}`}
      className={`h-7 px-2 rounded-md border text-[11px] truncate transition-colors disabled:opacity-40 ${
        current === id ? 'bg-brand/20 border-brand text-foreground font-semibold' : 'border-white/15 text-foreground/80 hover:bg-white/10'
      }`}
    >
      {title}
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {genders.map((g) => {
        const vs = system.filter((v) => v.gender === g.key);
        if (!vs.length) return null;
        return (
          <div key={g.key} className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-muted-foreground/80 shrink-0">{g.label}</span>
            {vs.map((v) => cell(v.id, v.name, `${v.note || ''} ${v.id}`))}
          </div>
        );
      })}

      {cloned.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-muted-foreground/80 shrink-0">{t('我的克隆', 'Mine')}</span>
          {cloned.map((c) => (
            <span key={c.voiceId} className="inline-flex items-center">
              {cell(c.voiceId, `${c.label}·${c.model.replace(/^cosyvoice-|^qwen-audio-/, '')}`, c.voiceId)}
              <button
                onClick={() => setCloned(forgetClonedVoice(c.voiceId))}
                className="h-7 w-5 rounded-r-md border border-l-0 border-white/15 text-[10px] text-muted-foreground hover:text-red-400 hover:bg-white/10"
                title={t('从列表移除（不删服务端音色）', 'Remove from list (keeps the server-side voice)')}
              >✕</button>
            </span>
          ))}
        </div>
      )}

      {orphan && (
        <span className="inline-flex items-center">
          {cell(current, t('当前音色', 'Current'), t('不在系统表与克隆记录里', 'Not in the catalog or clone list'))}
        </span>
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] text-muted-foreground/80 shrink-0">{t('克隆音色', 'Clone')}</span>
        {CLIP_PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() => void fetchClipBytes(p.file).then((b) => cloneFrom(b, p.label, `mv${p.key === 'male' ? 'm' : 'f'}`)).catch((e) => setMsg(`✕ ${e instanceof Error ? e.message : String(e)}`))}
            disabled={busy !== null || !tts?.baseUrl}
            className="h-7 px-2 rounded-md border border-emerald-400/35 bg-emerald-500/10 text-[11px] text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-40"
            title={t(`用内置样本 ${p.file} 克隆一个${p.label}音色（目标模型 = 当前配音模型 ${model || '未设'}）`, `Clone a ${p.label} voice from the bundled sample (target model = current)`)}
          >
            ⬇ {p.label}
          </button>
        ))}
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy !== null || !tts?.baseUrl}
          className="h-7 px-2 rounded-md border border-white/15 text-[11px] hover:bg-white/10 disabled:opacity-40"
          title={t('上传 3~60 秒参考音频克隆音色', 'Upload 3–60s reference audio to clone a voice')}
        >⬆ {t('上传参考音频', 'Upload reference')}</button>
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
        <input
          value={orphan ? current : ''}
          onChange={(e) => pick(e.target.value.trim())}
          disabled={!tts}
          className="input h-7 w-28 text-[11px] disabled:opacity-40"
          placeholder={t('或手填音色 ID', 'or paste voice ID')}
          title={t('填入官方音色名或已有的 voice_id（不在列表里的音色也能用）', 'Any voice name or existing voice_id, including ones not listed here')}
        />
        <button
          onClick={() => void audition()}
          disabled={busy !== null || !current}
          className="h-7 px-2 rounded-md border border-white/15 text-[11px] hover:bg-white/10 disabled:opacity-40"
          title={t('用当前音色合成一句试听', 'Synthesize one preview line with the current voice')}
        >{busy === 'audition' ? '⏳' : '▶'} {t('试听', 'Audition')}</button>
      </div>

      <span className="text-[10px] text-muted-foreground/70 w-full truncate" title={current}>
        {t('音色写回当前配音供应商', 'Voice is saved on the active TTS provider')}
        {current ? ` · ${current}` : ''}
        {msg ? ` · ${msg}` : ''}
      </span>
    </div>
  );
}
