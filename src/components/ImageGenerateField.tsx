/**
 * ImageGenerateField — 「描述 → 一张图」的输入区（现在只有弹窗·人物的配图在用）。
 *
 * 尺寸 / 模型都是**模板声明的参数**：有候选值就长按钮组、没有就是文本框，占位提示取声明的默认值 ——
 * 接一家新供应商不用改这个组件（同一条事实只有模板那一份）。产物是 dataURL，与「上传照片」同一条路，
 * 写到哪儿由调用方决定。AI 功能只在桌面端（AGENTS §8）。
 */
import { useState } from 'react';
import { IS_DESKTOP } from '../lib/backend';
import { useProviderStore } from '../stores/providerStore';
import { callImage, declaredDefault, declaredOptions } from '../lib/providers';
import { useT, OptionBlocks } from './ui/primitives';

export function ImageGenerateField({ onPick }: { onPick: (dataUrl: string) => void }) {
  const t = useT();
  const inst = useProviderStore((s) => s.current('image'));
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const models = declaredOptions(inst, 'model');
  const ready = !!inst && !!String(inst.values.instance?.baseUrl ?? '');
  if (!IS_DESKTOP) return null;

  const go = async () => {
    if (!inst || !prompt.trim()) return;
    setBusy(true); setErr('');
    try {
      onPick(await callImage(inst, prompt.trim(), { ...(size ? { size } : {}), ...(model ? { model } : {}) }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-white/10 bg-white/[0.03] p-2 space-y-1.5">
      <p className="text-[11px] text-muted-foreground">
        {t('AI 生成图片', 'Generate image')}
        {!ready && ` · ${t('未配置图片服务（顶栏 ⚙ 设置）', 'no image instance configured')}`}
      </p>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={2}
        className="input text-xs resize-none"
        placeholder={t('描述要生成的图（主体 / 风格 / 构图…）', 'Describe the image (subject / style / framing…)')}
      />
      {models.length > 1 && (
        <OptionBlocks
          value={model || declaredDefault(inst, 'model')}
          options={models.map((m) => ({ value: m, label: m }))}
          onChange={setModel}
        />
      )}
      <div className="flex items-center gap-1.5">
        <input
          value={size}
          onChange={(e) => setSize(e.target.value)}
          className="input h-7 w-28 text-xs font-mono"
          placeholder={declaredDefault(inst, 'size') || t('尺寸', 'size')}
          title={t('出图尺寸（留空 = 用实例或模板声明的默认值）', 'Image size (empty = the declared default)')}
        />
        <button
          onClick={() => void go()}
          disabled={busy || !prompt.trim() || !ready}
          className="h-7 px-2.5 rounded-md bg-white text-black text-[11px] font-medium hover:bg-white/90 disabled:opacity-40"
          title={t('按描述生成一张图，并用作照片', 'Generate one image from the description and use it as the photo')}
        >
          {busy ? t('生成中…', 'Working…') : `🤖 ${t('生成', 'Generate')}`}
        </button>
      </div>
      {!!err && <p className="text-[11px] text-red-400 break-words" title={err}>{err}</p>}
    </div>
  );
}
