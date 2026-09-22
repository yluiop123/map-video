/**
 * ProviderPanel — ⚙ 设置 · AI 的右侧面板（**只管实例设置**：选哪家、填 Key、选模型、调参数）
 *
 * 接口模板不在这里 —— 它是另一个页面（`EndpointTemplatesPage.tsx`，整屏），本页只留一个跳转按钮。
 * 理由：一个是日常操作、一个是改请求形状的专家操作，放同一个页面（哪怕分页签）互相干扰。
 */
import { useEffect, useState } from 'react';
import { JsonField, NumberInput, OptionBlocks, useT } from './ui/primitives';
import { useEditorStore } from '../stores/editorStore';
import { useProviderStore } from '../stores/providerStore';
import type { ProviderConfig, ProviderEndpoint } from '../types';
import { REQUIRED_ROLES, ROLES_BY_KIND, recipeById, recipesFor, seedTemplate, type Recipe } from '../lib/recipes';
import { pickLabel } from '../lib/i18n';
import { whenOk, type Role, type VarSpec } from '../lib/request-engine';
import { IS_DESKTOP } from '../lib/backend';

type Kind = 'llm' | 'tts' | 'image';

const KIND_TITLE: Record<Kind, { zh: string; en: string }> = {
  llm: { zh: '🤖 文案生成 AI', en: '🤖 Text AI' },
  tts: { zh: '🔊 配音 / 声音克隆', en: '🔊 Voice (TTS / clone)' },
  image: { zh: '🖼 图片生成 AI', en: '🖼 Image AI' },
};
/** 需要第二个密钥槽的两家（早先把两个值拼进 apiKey 字符串，现在各占一格） */
const NEEDS_SECRET2 = ['volc-tts', 'minimax-t2a'];
const DEFAULT_RECIPE: Record<Kind, string> = { llm: 'openai-chat', tts: 'dashscope-cosyvoice', image: 'dashscope-image' };

export function ProviderPanel({ kind, onOpenTemplates }: { kind: Kind; onOpenTemplates: (providerId: string) => void }) {
  const t = useT();
  const lang = useEditorStore((s) => (s.lang === 'en' ? 'en' : 'zh'));
  const list = useProviderStore((s) => (kind === 'llm' ? s.llm : kind === 'tts' ? s.tts : s.image));
  const activeId = useProviderStore((s) => (kind === 'llm' ? s.activeLlmId : kind === 'tts' ? s.activeTtsId : s.activeImageId));
  const store = useProviderStore.getState();
  const [selId, setSelId] = useState<string | null>(activeId || list[0]?.id || null);
  const recipes = recipesFor(kind);
  // 切换 kind 时组件不重挂载，selId 会带着上一类的 id 过来；选不中就退到生效项 / 第一项，
  // 否则新建完供应商面板还是空的（要再点一次才显示）
  const sel = list.find((c) => c.id === selId) || list.find((c) => c.id === activeId) || list[0] || null;

  // 首次进入且一个都没有时预置一家，用户只填 Key
  useEffect(() => {
    const st = useProviderStore.getState();
    if ((kind === 'llm' ? st.llm : kind === 'tts' ? st.tts : st.image).length === 0) {
      setSelId(st.addFromRecipe(DEFAULT_RECIPE[kind], kind));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{pickLabel(KIND_TITLE[kind], lang)}</h3>
      <p className="text-[11px] text-muted-foreground">
        {IS_DESKTOP
          ? t('配置与接口模板存本机 SQLite；请求经主进程转发（无 CORS）。Key 不出本机。', 'Config & templates live in local SQLite; requests go through the main process. Keys never leave this machine.')
          : t('网页开发模式：浏览器直连可能被 CORS 拦截；正式使用请走桌面版。', 'Web dev mode: direct calls may hit CORS; use the desktop app.')}
      </p>

      <div className="flex flex-wrap gap-1.5">
        {recipes.map((r) => (
          <button
            key={r.id}
            onClick={() => setSelId(store.addFromRecipe(r.id, kind))}
            className="h-7 px-2 rounded-md border border-white/10 bg-white/[0.045] text-[11px] hover:border-white/25 transition-colors"
            title={pickLabel(r.note, lang)}
          >＋ {pickLabel(r.label, lang)}</button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {list.map((c) => (
          <div key={c.id} className="flex items-center rounded-md border overflow-hidden" style={{ borderColor: c.id === activeId ? 'var(--brand)' : 'rgba(255,255,255,0.1)' }}>
            <button onClick={() => { store.setActive(kind, c.id); setSelId(c.id); }} className={`h-7 px-2 text-[11px] hover:bg-white/10 ${c.id === selId ? 'bg-white/10' : ''}`}>
              {c.id === activeId ? '● ' : ''}{c.label}
            </button>
            <button
              onClick={() => { store.remove(c.id); if (selId === c.id) setSelId(null); }}
              className="h-7 px-1.5 text-[11px] text-red-400/80 hover:bg-red-500/10" title={t('删除', 'Delete')}
            >✕</button>
          </div>
        ))}
        {!list.length && <p className="text-[11px] text-muted-foreground">{t('点上方模板包添加一家服务。', 'Add a provider above.')}</p>}
      </div>

      {sel && (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground/70">{t('这一页只管实例设置', 'This page is about this provider only')}</span>
            <button
              onClick={() => onOpenTemplates(sel.id)}
              className="h-7 px-2.5 rounded-md border border-white/15 bg-white/[0.045] text-[11px] hover:bg-white/10"
              title={t('打开独立的接口模板页面（编辑 provider_endpoint 表）', 'Open the standalone endpoint-template page (provider_endpoint)')}
            >{t('接口模板', 'Endpoints')} · {sel.endpoints.length} →</button>
          </div>
          <ConfigTab kind={kind} cfg={sel} recipe={recipeById(sel.recipe)} />
        </>
      )}
    </div>
  );
}

// ========== 配置页 ==========

function ConfigTab({ kind, cfg, recipe }: { kind: Kind; cfg: ProviderConfig; recipe?: Recipe }) {
  const t = useT();
  const lang = useEditorStore((s) => (s.lang === 'en' ? 'en' : 'zh'));
  const store = useProviderStore.getState();
  const builtin = !!recipe && !recipe.id.startsWith('custom');
  const patch = (p: Partial<ProviderConfig>) => store.update(cfg.id, p);
  const missing = REQUIRED_ROLES[kind].filter((r) => !cfg.endpoints.some((e) => e.role === r));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {!builtin && <input value={cfg.label} onChange={(e) => patch({ label: e.target.value })} className="input h-7 text-xs flex-1 min-w-28" placeholder={t('名称', 'Label')} />}
        {!builtin && <input value={cfg.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} className="input h-7 text-xs flex-1 min-w-40" placeholder="https://…/v1" />}
        <ModelField cfg={cfg} recipe={recipe} onPatch={patch} />
      </div>

      <input
        value={cfg.secrets.apiKey} type="password"
        onChange={(e) => patch({ secrets: { ...cfg.secrets, apiKey: e.target.value } })}
        className="input h-7 text-xs w-full" placeholder={t('API Key', 'API Key')}
      />
      {NEEDS_SECRET2.includes(cfg.recipe) && (
        <input
          value={cfg.secrets.secret2 || ''} type="password"
          onChange={(e) => patch({ secrets: { ...cfg.secrets, secret2: e.target.value } })}
          className="input h-7 text-xs w-full"
          placeholder={t('第二个密钥：火山 Access Key / MiniMax group_id', 'Second secret: Volc access key / MiniMax group_id')}
        />
      )}

      {missing.length > 0 && (
        <p className="text-[11px] text-red-400">
          {t(`缺少必需接口：${missing.join(' / ')} —— 这家供应商不可用（去「接口模板」补，或换模板包）`, `Missing required endpoint(s): ${missing.join(' / ')}`)}
        </p>
      )}

      {kind === 'tts' && (
        <p className="text-[10px] text-muted-foreground/80">{t('音色与声音克隆在顶栏「字幕生成」里做', 'Voice picking & cloning live in the Subtitle studio')}</p>
      )}

      {cfg.endpoints.map((e) => (
        <div key={e.role} className="border border-white/10 rounded-lg p-2 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium">{pickLabel(e.label, lang) || e.role}</span>
            <span className="text-[10px] text-muted-foreground/70 font-mono">{e.role}</span>
          </div>
          <ModeRow cfg={cfg} ep={e} />
          {/* 参数直接来自该行 provider_endpoint.vars_json（kind=param），并按 when 门控隐藏；
              存回该行 overrides_json —— 页面上不该出现表里没有的控件 */}
          {(e.vars ?? []).filter((v) => v.kind === 'param' && whenOk(v.when, { mode: e.mode })).map((v) => (
            <VarControl key={v.name} v={v} value={(e.overrides ?? {})[v.name]} onChange={(val) => writeOverride(cfg, e.role, v.name, val)} />
          ))}
          {(e.vars ?? []).some((v) => v.kind === 'inject') && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-muted-foreground/60">{t('调用时传入', 'At call time')}</span>
              {(e.vars ?? []).filter((v) => v.kind === 'inject').map((v) => (
                <span key={v.name} className="h-5 px-1.5 rounded bg-white/[0.05] text-[10px] font-mono text-muted-foreground" title={t('由程序在调用时填入，这里不能设', 'Filled in by the caller; not editable')}>{v.name}</span>
              ))}
            </div>
          )}
          {!hasParams(e) && <p className="text-[10px] text-muted-foreground/60">{t('该接口没有可配置参数', 'No configurable parameters')}</p>}
        </div>
      ))}

      <input
        value={cfg.extra || ''} onChange={(e) => patch({ extra: e.target.value })}
        className="input h-7 text-xs w-full" placeholder={t('附加 JSON 参数（兜底，深合并进请求体）', 'Extra JSON (deep-merged into body)')}
      />
      <p className="text-[10px] text-muted-foreground">
        {pickLabel(recipe?.note, lang)}
        {cfg.endpoints.length > 0 && ` · ${t('接口', 'Endpoints')}: ${cfg.endpoints.map((e) => e.role).join(' / ')}`}
      </p>
    </div>
  );
}

const hasParams = (e: ProviderEndpoint) => (e.vars ?? []).some((v) => v.kind === 'param');

/** 写参数覆盖值；空值 = 删掉这个键（模板里的 omitIfEmpty 才有意义） */
function writeOverride(cfg: ProviderConfig, role: Role, name: string, val: unknown) {
  const endpoints = (cfg.endpoints ?? []).map((e) => {
    if (e.role !== role) return e;
    const next: Record<string, string | number | boolean> = { ...(e.overrides ?? {}) };
    if (val === undefined || val === null || val === '') delete next[name];
    else next[name] = val as string | number | boolean;
    return { ...e, overrides: next };
  });
  useProviderStore.getState().update(cfg.id, { endpoints });
}

function ModelField({ cfg, recipe, onPatch }: { cfg: ProviderConfig; recipe?: Recipe; onPatch: (p: Partial<ProviderConfig>) => void }) {
  const t = useT();
  const ms = recipe?.models ?? [];
  if (!ms.length) {
    return <input value={cfg.model} onChange={(e) => onPatch({ model: e.target.value })} className="input h-7 text-xs w-40" placeholder={t('模型', 'Model')} />;
  }
  const opts = cfg.model && !ms.includes(cfg.model) ? [cfg.model, ...ms] : ms;
  return (
    <select value={cfg.model} onChange={(e) => onPatch({ model: e.target.value })} className="input h-7 text-xs w-44">
      {opts.map((m) => <option key={m} value={m}>{m}</option>)}
    </select>
  );
}

/** 同步 / 异步：归属在接口模板上，但日常最常在这里改（同一能力常有两种接法） */
function ModeRow({ cfg, ep }: { cfg: ProviderConfig; ep: ProviderEndpoint }) {
  const t = useT();
  const patch = (p: Partial<ProviderEndpoint>) => {
    const endpoints = (cfg.endpoints ?? []).map((e) => (e.role === ep.role ? { ...e, ...p } : e));
    useProviderStore.getState().update(cfg.id, { endpoints });
  };
  // 这一类接口压根没有「查询任务状态」这种 role（LLM 就是纯同步）→ 整行不出现，别留噪音
  const queryRole = `${ep.role.split('.')[0]}.query` as Role;
  if (!ROLES_BY_KIND[cfg.kind].includes(queryRole)) return null;
  const queries = cfg.endpoints.filter((e) => e.role.endsWith('.query'));
  const canAsync = queries.length > 0;
  const poll = ep.poll ?? null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <OptionBlocks<string>
        value={ep.mode}
        options={[
          { value: 'sync', label: t('同步', 'Sync') },
          { value: 'async', label: t('异步任务', 'Async task') },
        ]}
        onChange={(v) => {
          // 退回同步必须把 poll 一起清掉，否则残留的轮询规则会在接口模板页被判「同步接口不该配查询规则」
          if (v !== 'async') { patch({ mode: 'sync', poll: undefined }); return; }
          // 切异步就得有地方查状态：没有查询接口就当场补一条（同类模板包里通常有现成形状），
          // 而不是让状态下拉里只有它自己 —— 那等于自己指向自己，调用了才报错
          const seed = queries.some((q) => q.role === queryRole) ? null : { ...seedTemplate(cfg.kind, queryRole), enabled: true, overrides: {} };
          const endpoints = (cfg.endpoints ?? []).map((e) => (e.role === ep.role
            ? { ...e, mode: 'async' as const, poll: e.poll ?? { taskId: '', statusRole: queryRole, intervalMs: 1500, timeoutMs: 120000, done: { path: '', equals: 'SUCCEEDED' } } }
            : e));
          useProviderStore.getState().update(cfg.id, { endpoints: seed ? [...endpoints, seed] : endpoints });
        }}
      />
      {!canAsync && ep.mode !== 'async' && (
        <span className="text-[10px] text-muted-foreground/60">
          {t(`选异步会自动补一条 ${queryRole} 接口`, `Choosing async adds a ${queryRole} endpoint`)}
        </span>
      )}
      {ep.mode === 'async' && poll && (
        <>
          <select
            value={poll.statusRole}
            onChange={(e) => patch({ poll: { ...poll, statusRole: e.target.value as Role } })}
            className="input h-7 text-xs w-32"
            title={t('轮询用哪个接口查任务状态', 'Which endpoint reports task status')}
          >
            {cfg.endpoints.filter((q) => q.role.endsWith('.query')).map((q) => <option key={q.role} value={q.role}>{q.role}</option>)}
          </select>
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
            {t('间隔 ms', 'interval ms')}
            <NumberInput className="input h-7 w-20 text-xs" value={poll.intervalMs ?? 1500} step={100} min={200} onCommit={(v) => patch({ poll: { ...poll, intervalMs: v } })} />
          </label>
          <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
            {t('超时 ms', 'timeout ms')}
            <NumberInput className="input h-7 w-24 text-xs" value={poll.timeoutMs ?? 120000} step={1000} min={1000} onCommit={(v) => patch({ poll: { ...poll, timeoutMs: v } })} />
          </label>
        </>
      )}
    </div>
  );
}

/** 参数控件：type 定存储类型，options 定控件（有候选值就用 OptionBlocks，不写原生 select） */
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

  if (v.type === 'bool' || opts.length === 2 && opts.every((o) => typeof o.value === 'boolean')) {
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
          <input
            value={String(value ?? '')} onChange={(e) => onChange(v.allowCustom ? cast(v.type, e.target.value) : e.target.value)}
            className="input h-6 w-24 text-[11px]" placeholder={t('其它值', 'other')}
          />
        )}
      </div>
    );
  }
  if (v.type === 'number') {
    // 未设 = 空串，绝不能显示成 0：0 是合法值（会被当真值发出去），两者必须分得开
    const raw = value ?? v.default;
    return wrap(
      <NumberInput
        className="input h-7 w-24 text-xs"
        value={raw === undefined || raw === '' ? '' : Number(raw)}
        step={1}
        onCommit={(n) => onChange(Number.isNaN(n) ? '' : n)}
      />
    );
  }
  if (v.type === 'json') {
    return wrap(<JsonField label={t('JSON', 'JSON')} value={value ?? {}} onCommit={(o) => onChange(o)} />);
  }
  if (v.type === 'list') return wrap(<ListEditor v={v} value={Array.isArray(value) ? (value as unknown[]) : []} onChange={onChange} />);
  return wrap(<input value={String(value ?? v.default ?? '')} onChange={(e) => onChange(e.target.value)} className="input h-7 w-40 text-xs" />);
}

function cast(type: VarSpec['type'], s: string): string | number | boolean {
  if (type === 'number') return s === '' ? '' : Number(s);
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

