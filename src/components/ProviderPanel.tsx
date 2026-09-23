/**
 * ProviderPanel.tsx — ⚙ 设置 · AI 的「实例设置」页
 *
 * 一个能力就一处配置（库里 provider 以 kind 为主键）：用哪组模板（只读，换组去模板页）、Base URL、
 * Key、走同步还是异步、模板声明的实例参数、并发与重试。「一家怎么发请求」不在这页 ——
 * 那是左侧单独的「接口模板」入口（TemplatesPane）。
 */
import { useEffect } from 'react';
import { NumberInput, OptionBlocks, useT } from './ui/primitives';
import { useEditorStore } from '../stores/editorStore';
import { useProviderStore } from '../stores/providerStore';
import type { ProviderConfig } from '../types';
import { needsSecret2 } from '../lib/template-seed';
import { validateGroup, type Mode, type ProviderKind, type TemplateGroup, type VarSpec } from '../lib/request-engine';
import { instanceVars, modelsOf } from '../lib/providers';
import { pickLabel } from '../lib/i18n';
import { IS_DESKTOP } from '../lib/backend';

const KIND_TITLE: Record<ProviderKind, { zh: string; en: string }> = {
  llm: { zh: '🤖 文案生成 AI', en: '🤖 Text AI' },
  tts: { zh: '🔊 配音 / 声音克隆', en: '🔊 Voice (TTS / clone)' },
  image: { zh: '🖼 图片生成 AI', en: '🖼 Image AI' },
};

/** 一个能力一处配置：kind → 那一份（没配过是 null） */
const cfgOf = (s: { llm: ProviderConfig | null; tts: ProviderConfig | null; image: ProviderConfig | null }, kind: ProviderKind) =>
  kind === 'llm' ? s.llm : kind === 'tts' ? s.tts : s.image;

export function ProviderPanel({ kind }: { kind: ProviderKind }) {
  const t = useT();
  const lang = useEditorStore((s) => (s.lang === 'en' ? 'en' : 'zh'));
  const cfg = useProviderStore((s) => cfgOf(s, kind));
  const groups = useProviderStore((s) => s.groups);

  // 一处一份：没配过的能力按该 kind 的模板组建一份空的（Base URL / 模型抄建议值，Key 只能他自己填）
  useEffect(() => {
    const st = useProviderStore.getState();
    if (cfgOf(st, kind)) return;
    const first = st.groups.find((g) => g.kind === kind && !g.tplGroup.startsWith('custom-'))
      ?? st.groups.find((g) => g.kind === kind);
    if (first) st.ensureConfig(kind, first.tplGroup);
  }, [kind]);

  const group = cfg ? groups.find((g) => g.tplGroup === cfg.tplGroup) ?? null : null;

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{pickLabel(KIND_TITLE[kind], lang)}</h3>
      <p className="text-[11px] text-muted-foreground">
        {IS_DESKTOP
          ? t('一处一份：这个能力只用一个 Base URL + 一个 Key，配置存本机 SQLite，请求经主进程转发（无 CORS）。Key 不出本机。', 'One capability, one set of credentials. Stored in local SQLite; requests go through the main process.')
          : t('网页开发模式：浏览器直连可能被 CORS 拦截；正式使用请走桌面版。', 'Web dev mode: direct calls may hit CORS; use the desktop app.')}
      </p>
      {cfg && <ConfigForm kind={kind} cfg={cfg} group={group} />}
    </div>
  );
}

/** 这一处配置的表单：用哪组模板（只读）+ Base URL + Key + 同步异步 + 实例参数 + 并发重试 */
function ConfigForm({ kind, cfg, group }: { kind: ProviderKind; cfg: ProviderConfig; group: TemplateGroup | null }) {
  const t = useT();
  const patch = (p: Partial<ProviderConfig>) => useProviderStore.getState().saveConfig(kind, p);
  const problems = group
    ? validateGroup(group, cfg.mode)
    : [`这处配置指向的模板组「${cfg.tplGroup}」已经不在了 —— 去左侧「接口模板」换一组`];
  const canAsync = !!group?.rows.some((r) => r.mode === 'async');

  return (
    <div className="space-y-2 border-t border-white/10 pt-2">
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
        <span>{t('当前模板组', 'Template group')}</span>
        <span className="h-6 inline-flex items-center px-2 rounded-md border border-white/10 bg-white/[0.045] text-[11px] text-foreground">
          {group?.label || cfg.tplGroup}
        </span>
        <span className="text-muted-foreground/60">{t('换组在左侧「接口模板」里点「用作本能力」', 'Switch groups from "Endpoint templates" → "Use for this capability"')}</span>
      </div>

      <input value={cfg.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} className="input h-7 text-xs w-full font-mono" placeholder="https://…/v1" />
      <input value={cfg.apiKey} type="password" onChange={(e) => patch({ apiKey: e.target.value })} className="input h-7 text-xs w-full" placeholder="API Key" />
      {needsSecret2(group ?? undefined) && (
        <input value={cfg.apiKey2 ?? ''} type="password" onChange={(e) => patch({ apiKey2: e.target.value })} className="input h-7 text-xs w-full"
          placeholder={t('第二凭证（这组模板的某个 header 要用它）', 'Second credential (a header needs it)')} />
      )}

      {canAsync && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] text-muted-foreground">{t('请求方式', 'Mode')}</span>
          <OptionBlocks<string>
            value={cfg.mode}
            options={[{ value: 'sync', label: t('同步', 'Sync') }, { value: 'async', label: t('异步任务', 'Async task') }]}
            onChange={(v) => patch({ mode: v as Mode })}
          />
          <span className="text-[10px] text-muted-foreground/60">{t('异步 = 提交后轮询查询接口，产物当场下载', 'Async = submit, poll, download on the spot')}</span>
        </div>
      )}

      <ModelField cfg={cfg} onModel={(m) => patch({ model: m })} />

      {instanceVars(cfg).map((v) => (
        <VarControl key={v.name} v={v} value={cfg.params?.[v.name]} onChange={(val) => {
          const next = { ...(cfg.params ?? {}) };
          if (val === undefined || val === null || val === '') delete next[v.name];
          else next[v.name] = val;
          patch({ params: next });
        }} />
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1 text-[10px] text-muted-foreground">{t('并发数', 'Concurrency')}
          <NumberInput className="input h-7 w-16 text-xs" value={cfg.maxConcurrency ?? 1} step={1} min={1} max={8} onCommit={(n) => patch({ maxConcurrency: Math.max(1, Math.round(n)) })} />
        </label>
        <label className="flex items-center gap-1 text-[10px] text-muted-foreground">{t('失败重试', 'Retries')}
          <NumberInput className="input h-7 w-16 text-xs" value={cfg.retryTimes ?? 2} step={1} min={0} max={5} onCommit={(n) => patch({ retryTimes: Math.max(0, Math.round(n)) })} />
        </label>
        <span className="text-[10px] text-muted-foreground/60">{t('批量配音 / 出图时用；只重试限流与网络错', 'Used for batch calls; only rate-limit / network errors retry')}</span>
      </div>

      <input value={cfg.extra ?? ''} onChange={(e) => patch({ extra: e.target.value })} className="input h-7 text-xs w-full font-mono"
        placeholder={t('附加 JSON 参数（兜底，深合并进请求体）', 'Extra JSON (deep-merged into body)')} />

      {problems.length > 0 ? (
        <p className="text-[10px] text-red-400 whitespace-pre-line">
          {problems.join('\n')}
        </p>
      ) : (
        <p className="text-[10px] text-muted-foreground">{pickLabel(group?.note ?? '', 'zh') || t('接口形状齐备', 'Endpoints look complete')}</p>
      )}
    </div>
  );
}

function ModelField({ cfg, onModel }: { cfg: ProviderConfig; onModel: (m: string) => void }) {
  const t = useT();
  const ms = modelsOf(cfg);
  if (!ms.length) {
    return <input value={cfg.model} onChange={(e) => onModel(e.target.value)} className="input h-7 text-xs w-44" placeholder={t('模型', 'Model')} />;
  }
  const opts = cfg.model && !ms.includes(cfg.model) ? [cfg.model, ...ms] : ms;
  return (
    <select value={cfg.model} onChange={(e) => onModel(e.target.value)} className="input h-7 text-xs w-44">
      {opts.map((m) => <option key={m} value={m}>{m}</option>)}
    </select>
  );
}

/** 参数控件：type 定存储类型，options 定控件（有候选值就用选项块，不写原生 select） */
function VarControl({ v, value, onChange }: { v: VarSpec; value: unknown; onChange: (val: unknown) => void }) {
  const t = useT();
  const lang = useEditorStore((s) => (s.lang === 'en' ? 'en' : 'zh'));
  const label = pickLabel(v.label, lang) || v.name;
  const opts = (v.options ?? []).map((o) => (typeof o === 'object' && o !== null ? o : { value: o as string | number | boolean }));
  const wrap = (children: React.ReactNode) => (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-28 shrink-0 text-[10px] text-muted-foreground" title={`${v.name}${v.default !== undefined ? ` · ${t('默认', 'default')} ${String(v.default)}` : ''}`}>{label}</span>
      {children}
    </div>
  );

  if (v.type === 'bool') {
    return wrap(
      <OptionBlocks<string>
        value={value === undefined ? String(v.default ?? false) : String(value)}
        options={[{ value: 'true', label: t('开', 'On') }, { value: 'false', label: t('关', 'Off') }]}
        onChange={(s) => onChange(s === 'true')}
      />
    );
  }
  if (opts.length) {
    return wrap(
      <div className="flex flex-wrap items-center gap-1.5">
        <OptionBlocks<string>
          value={String(value ?? v.default ?? '')}
          options={opts.map((o) => ({ value: String(o.value), label: pickLabel(o.label, lang) || String(o.value) }))}
          onChange={(val) => onChange(cast(v.type, val))}
        />
        {v.allowCustom && (
          <input value={String(value ?? '')} onChange={(e) => onChange(cast(v.type, e.target.value))} className="input h-6 w-24 text-[11px]" placeholder={t('其它值', 'other')} />
        )}
      </div>
    );
  }
  if (v.type === 'int') {
    // 未设 = 空串，绝不能显示成 0：0 是合法值（会被当真值发出去），两者必须分得开
    const raw = value ?? v.default;
    return wrap(
      <NumberInput className="input h-7 w-24 text-xs" value={raw === undefined || raw === '' ? '' : Number(raw)} step={1}
        onCommit={(n) => onChange(Number.isNaN(n) ? '' : n)} />
    );
  }
  if (v.type === 'list') return wrap(<ListEditor v={v} value={Array.isArray(value) ? (value as unknown[]) : []} onChange={onChange} />);
  return wrap(<input value={String(value ?? v.default ?? '')} onChange={(e) => onChange(e.target.value)} className="input h-7 w-40 text-xs" />);
}

function cast(type: VarSpec['type'], s: string): string | number | boolean {
  if (type === 'int') return s === '' ? '' : Number(s);
  if (type === 'bool') return s === 'true';
  return s;
}

/** list 参数 = 行编辑器：字段来自 item.fields，用户永远不用手打嵌套 JSON */
function ListEditor({ v, value, onChange }: { v: VarSpec; value: unknown[]; onChange: (val: unknown) => void }) {
  const t = useT();
  const lang = useEditorStore((s) => (s.lang === 'en' ? 'en' : 'zh'));
  const fields = v.item?.fields ?? [{ name: 'value', type: 'string' } as VarSpec];
  const get = (row: unknown, name: string) => String((row as Record<string, unknown> | undefined)?.[name] ?? '');
  const write = (i: number, name: string, val: string) => {
    onChange(value.map((row, j) => (i === j ? { ...(row as object), [name]: val } : row)));
  };
  const blank = Object.fromEntries(fields.map((f) => [f.name, f.options?.length ? String(f.options[0]) : '']));
  return (
    <div className="space-y-1">
      {value.map((row, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1">
          {fields.map((f) => (
            f.options?.length
              ? (
                <select value={get(row, f.name)} onChange={(e) => write(i, f.name, e.target.value)} className="input h-6 text-[11px] w-24">
                  {f.options.map((o) => {
                    const val = typeof o === 'object' && o !== null ? String(o.value) : String(o);
                    return <option key={val} value={val}>{val}</option>;
                  })}
                </select>
              )
              : <input value={get(row, f.name)} onChange={(e) => write(i, f.name, e.target.value)} className="input h-6 w-40 text-[11px]" placeholder={pickLabel(f.label, lang) || f.name} />
          ))}
          <button onClick={() => onChange(value.filter((_, j) => j !== i))} className="h-6 w-6 rounded text-[10px] text-muted-foreground hover:text-red-400 hover:bg-white/10">✕</button>
        </div>
      ))}
      <button onClick={() => onChange([...value, blank])} className="h-6 px-2 rounded-md border border-white/15 text-[10px] hover:bg-white/10">＋ {t('加一行', 'Add row')}</button>
    </div>
  );
}
