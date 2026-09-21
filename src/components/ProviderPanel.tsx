/**
 * ProviderPanel — ⚙ 设置 · AI 的右侧面板（供应商列表 + 两页签）
 *
 * 页签拆分的理由是**心智不同**：「配置」= 换 Key / 换模型 / 调参数（日常）；
 * 「接口模板」= 改这家怎么发请求（专家，接新服务或上游改了字段才动）。
 * 两者混在一条滚动长流里，结果是没人敢动模板，也看不清自己改了什么。
 *
 * 模板页每个接口都带「预览请求」（纯本地、零网络）与「试调用」（真发一次）：
 * 有了可观察的中间层，才不用拿上游一句 `Model not exist.` 反推。
 */
import { useEffect, useState } from 'react';
import { OptionBlocks, NumberInput, Toggle, useT } from './ui/primitives';
import { useEditorStore } from '../stores/editorStore';
import { useProviderStore } from '../stores/providerStore';
import type { ProviderConfig, ProviderEndpoint } from '../types';
import { recipesFor, recipeById, REQUIRED_ROLES, ROLES_BY_KIND, seedTemplate, type Recipe } from '../lib/recipes';
import { useConfirm } from './ui/ConfirmHost';
import { endpointsOfRecipe } from '../lib/providers';
import { pickLabel } from '../lib/i18n';
import { previewRequest, runRoleDebug } from '../lib/providers';
import { validateTemplate, whenOk, type Role, type VarSpec } from '../lib/request-engine';
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
/** 试调用的默认输入（够跑通连通性，不必每次手打） */
const TRIAL_DEFAULT: Record<string, string> = {
  text: '这段旁白用来试听音色。',
  systemPrompt: '你是连通性测试助手。',
  userPrompt: '只回复两个字：正常',
  prompt: '一只戴宇航员头盔的橘猫，赛博朋克风格',
  preferredName: 'mapvideo',
  prefix: 'mv',
};

export function ProviderPanel({ kind }: { kind: Kind }) {
  const t = useT();
  const lang = useEditorStore((s) => (s.lang === 'en' ? 'en' : 'zh'));
  const list = useProviderStore((s) => (kind === 'llm' ? s.llm : kind === 'tts' ? s.tts : s.image));
  const activeId = useProviderStore((s) => (kind === 'llm' ? s.activeLlmId : kind === 'tts' ? s.activeTtsId : s.activeImageId));
  const store = useProviderStore.getState();
  const [selId, setSelId] = useState<string | null>(activeId || list[0]?.id || null);
  // 接口模板是**另一个页面**（不是同一区里的页签）：日常改 Key/模型/参数，改接口形状是偶发的专家动作
  const [showTpl, setShowTpl] = useState(false);
  const recipes = recipesFor(kind);
  useEffect(() => { setShowTpl(false); }, [kind, selId]);
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
            onClick={() => { setSelId(store.addFromRecipe(r.id, kind)); setShowTpl(false); }}
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

      {sel && (showTpl
        ? <TemplateTab cfg={sel} recipe={recipeById(sel.recipe)} onBack={() => setShowTpl(false)} />
        : (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground/70">{t('这一页只放日常项', 'Everyday settings live on this page')}</span>
              <button
                onClick={() => setShowTpl(true)}
                className="h-7 px-2.5 rounded-md border border-white/15 bg-white/[0.045] text-[11px] hover:bg-white/10"
                title={t('编辑 provider_endpoint 表里的接口模板', 'Edit the provider_endpoint templates')}
              >{t('接口模板', 'Endpoints')} · {sel.endpoints.length} →</button>
            </div>
            <ConfigTab kind={kind} cfg={sel} recipe={recipeById(sel.recipe)} />
          </>
        ))}
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
          if (v === 'async' && !poll) {
            patch({ mode: 'async', poll: { taskId: '', statusRole: queries[0]?.role ?? ep.role.replace(/\.\w+$/, '.query') as Role, intervalMs: 1500, timeoutMs: 120000, done: { path: '', equals: 'SUCCEEDED' } } });
          } else patch({ mode: v as 'sync' | 'async' });
        }}
      />
      {!canAsync && ep.mode !== 'async' && (
        <span className="text-[10px] text-muted-foreground/60" title={t('该供应商没配 *.query 接口；要接异步任务，去「接口模板」添加', 'No *.query endpoint; add one under Endpoints to use async')}>
          {t('（无可用查询接口）', '(no query endpoint)')}
        </span>
      )}
      {ep.mode === 'async' && poll && (
        <>
          <select
            value={poll.statusRole}
            onChange={(e) => patch({ poll: { ...poll, statusRole: e.target.value as Role } })}
            className="input h-7 text-xs w-32"
          >
            {(queries.length ? queries : [ep]).map((q) => <option key={q.role} value={q.role}>{q.role}</option>)}
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
    return wrap(<NumberInput className="input h-7 w-24 text-xs" value={Number(value ?? v.default ?? 0)} step={1} onCommit={(n) => onChange(n)} />);
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

// ========== 接口模板页 ==========

function TemplateTab({ cfg, recipe, onBack }: { cfg: ProviderConfig; recipe?: Recipe; onBack: () => void }) {
  const t = useT();
  const confirm = useConfirm();
  const setEndpoints = (endpoints: ProviderEndpoint[]) => useProviderStore.getState().update(cfg.id, { endpoints });
  const missing = ROLES_BY_KIND[cfg.kind].filter((r) => !cfg.endpoints.some((e) => e.role === r));
  const addRole = (role: Role) => {
    const seed = seedTemplate(cfg.kind, role);
    setEndpoints([...cfg.endpoints, { ...seed, enabled: true, overrides: {} }]);
  };
  const drop = async (role: Role) => {
    if (await confirm({ message: t(`从这家供应商移除接口「${role}」？模板包的默认形状不受影响，可再点「＋」加回来（你在模板里改过的内容会丢）`, `Remove endpoint ${role}? Re-adding it from the recipe loses your edits.`), danger: true })) {
      setEndpoints(cfg.endpoints.filter((e) => e.role !== role));
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="h-7 px-2 rounded-md border border-white/15 text-[11px] hover:bg-white/10">← {t('返回配置', 'Back')}</button>
        <span className="text-[11px] font-medium truncate">{cfg.label} · {t('接口模板', 'Endpoints')}</span>
        <span className="text-[10px] font-mono text-muted-foreground/60 truncate">{cfg.recipe}</span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {t('改的是「这家怎么发请求」（存 provider_endpoint 表）。占位符：{name} 取变量（标量保留类型），{@name} 在数组里展开成多个元素。', 'Edits what gets sent (stored in provider_endpoint). {name} = variable, {@name} splices array elements.')}
      </p>
      {cfg.endpoints.map((e) => (
        <EndpointCard key={e.role} cfg={cfg} ep={e} onDelete={() => void drop(e.role)}
          defaults={recipe ? endpointsOfRecipe(recipe.id).find((d) => d.role === e.role) : undefined} />
      ))}
      {missing.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground/70">{t('可添加的接口', 'Add endpoint')}</span>
          {missing.map((r) => (
            <button key={r} onClick={() => addRole(r)} className="h-6 px-2 rounded-md border border-white/15 text-[10px] font-mono hover:bg-white/10">＋ {r}</button>
          ))}
        </div>
      )}
      <p className="text-[10px] text-muted-foreground/70">{t('改完自动存本机库；「预览请求」不联网，「试调用」会真发一次请求。', 'Saved locally; Preview never touches the network, Test does.')}</p>
    </div>
  );
}

function EndpointCard({ cfg, ep, defaults, onDelete }: { cfg: ProviderConfig; ep: ProviderEndpoint; defaults?: ProviderEndpoint; onDelete: () => void }) {
  const t = useT();
  const lang = useEditorStore((s) => (s.lang === 'en' ? 'en' : 'zh'));
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<string>('');
  const [run, setRun] = useState<{ s: 'idle' | 'run' | 'ok' | 'err'; text?: string; audio?: string }>({ s: 'idle' });
  const patch = (p: Partial<ProviderEndpoint>) => {
    const endpoints = (cfg.endpoints ?? []).map((e) => (e.role === ep.role ? { ...e, ...p } : e));
    useProviderStore.getState().update(cfg.id, { endpoints });
    setPreview('');
  };
  const problems = validateTemplate(ep);
  const injects = (ep.vars ?? []).filter((v) => v.kind === 'inject').map((v) => v.name);

  const doPreview = () => {
    try {
      const r = previewRequest({ ...cfg, endpoints: (cfg.endpoints ?? []).map((e) => (e.role === ep.role ? ep : e)) }, ep.role, filledInputs(ep, inputs));
      setPreview(`${r.method} ${r.url}\nheaders: ${JSON.stringify(r.headers)}\nquery: ${JSON.stringify(r.query)}\nbody: ${JSON.stringify(r.body, null, 1)}`);
    } catch (e) { setPreview(`✕ ${e instanceof Error ? e.message : String(e)}`); }
  };
  const doRun = async () => {
    setRun({ s: 'run' });
    try {
      const r = await runRoleDebug({ ...cfg, endpoints: (cfg.endpoints ?? []).map((e) => (e.role === ep.role ? ep : e)) }, ep.role, filledInputs(ep, inputs));
      const shown = r.steps.map((s) => `${s.label} HTTP ${s.status} ${JSON.stringify(s.values)}`).join('\n');
      setRun({ s: 'ok', text: `${shown}${r.bytes ? `\n→ 音频/图片 ${r.bytes.length} 字节（${r.mime || '未知类型'}）` : ''}`, audio: undefined });
    } catch (e) { setRun({ s: 'err', text: e instanceof Error ? e.message : String(e) }); }
  };

  return (
    <div className="border border-white/10 rounded-lg p-2 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium flex-1 truncate">{pickLabel(ep.label, lang) || ep.role}</span>
        <span className="text-[10px] font-mono text-muted-foreground/70">{ep.role}</span>
        <Toggle checked={ep.enabled !== false} label={t('启用', 'Enabled')} onChange={(v) => patch({ enabled: v })} />
        <button
          onClick={onDelete}
          className="h-6 px-1.5 rounded-md border border-white/15 text-[10px] text-red-400/80 hover:bg-red-500/10" title={t('移除这个接口（模板包里的形状没丢，随时可再加回来）', 'Remove this endpoint')}
        >✕</button>
        {defaults && (
          <button
            onClick={() => patch({ ...defaults, overrides: ep.overrides })}
            className="h-6 px-2 rounded-md border border-white/15 text-[10px] hover:bg-white/10" title={t('丢弃本地改动，取模板包这一条', 'Restore this endpoint from the recipe')}
          >{t('恢复默认', 'Restore')}</button>
        )}
      </div>

      {problems.length > 0 && <p className="text-[10px] text-red-400 whitespace-pre-line">{problems.join('\n')}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <OptionBlocks<string>
          value={ep.method || 'POST'}
          options={(['GET', 'POST', 'PUT', 'DELETE'] as string[]).map((m) => ({ value: m, label: m }))}
          onChange={(v) => patch({ method: v })}
        />
        <input value={ep.path} onChange={(e) => patch({ path: e.target.value })} className="input h-7 flex-1 min-w-40 text-[11px] font-mono" placeholder="{baseUrl}/…" />
      </div>

      <JsonField label="Headers" value={ep.headers} onCommit={(v) => patch({ headers: v as Record<string, unknown> })} />
      <JsonField label="Query" value={ep.query} onCommit={(v) => patch({ query: v as Record<string, unknown> })} />
      <JsonField label="Body" value={ep.body} onCommit={(v) => patch({ body: v })} />
      <div className="flex flex-wrap gap-2">
        <JsonField label={t('出参取法', 'Pick')} value={ep.resp?.pick} onCommit={(v) => patch({ resp: { ...(ep.resp ?? {}), pick: v as Record<string, string> } })} />
        <JsonField label={t('异步规则', 'Poll')} value={ep.poll} onCommit={(v) => patch({ poll: v as typeof ep.poll })} />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
        <span>{t('响应', 'resp')}</span>
        <OptionBlocks<string>
          value={ep.resp?.kind ?? 'auto'}
          options={(['auto', 'audio', 'json', 'text'] as string[]).map((m) => ({ value: m, label: m }))}
          onChange={(v) => patch({ resp: { ...(ep.resp ?? {}), kind: v as 'auto' } })}
        />
        <OptionBlocks<string>
          value={ep.resp?.decode ?? '-'}
          options={(['-', 'hex', 'base64', 'url'] as string[]).map((m) => ({ value: m, label: m }))}
          onChange={(v) => patch({ resp: { ...(ep.resp ?? {}), decode: v === '-' ? undefined : v as 'hex' } })}
        />
      </div>
      <div className="flex flex-wrap gap-1">
        {(ep.vars ?? []).map((v) => (
          <span key={v.name} className="h-5 px-1.5 rounded bg-white/[0.06] text-[10px] font-mono text-muted-foreground" title={v.kind === 'inject' ? t('调用端注入', 'injected at call time') : t('配置期可填', 'set in Config')}>
            {v.kind === 'inject' ? '{' : '['}{v.name}{v.kind === 'inject' ? '}' : ']'}
          </span>
        ))}
      </div>

      <div className="border-t border-white/[0.06] pt-1.5 space-y-1">
        <div className="flex flex-wrap items-end gap-1.5">
          {injects.filter((n) => n !== 'wavB64').map((n) => (
            <label key={n} className="flex flex-col text-[10px] text-muted-foreground">
              {n}
              <input value={inputs[n] ?? TRIAL_DEFAULT[n] ?? ''} onChange={(e) => setInputs((s) => ({ ...s, [n]: e.target.value }))} className="input h-6 w-32 text-[11px]" />
            </label>
          ))}
          {injects.includes('wavB64') && (
            <label className="h-6 px-2 inline-flex items-center rounded-md border border-white/15 text-[10px] hover:bg-white/10 cursor-pointer">
              ⬆ {t('参考音频', 'reference audio')}
              <input
                type="file" accept="audio/*" className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    const buf = await f.arrayBuffer();
                    let bin = ''; const b = new Uint8Array(buf);
                    for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
                    setInputs((s) => ({ ...s, wavB64: btoa(bin) }));
                  }
                  e.target.value = '';
                }}
              />
            </label>
          )}
          <button onClick={doPreview} className="h-7 px-2.5 rounded-md border border-white/15 text-[11px] hover:bg-white/10">{t('预览请求', 'Preview request')}</button>
          <button onClick={doRun} disabled={run.s === 'run'} className="h-7 px-2.5 rounded-md border border-sky-400/40 bg-sky-500/10 text-[11px] text-sky-200 hover:bg-sky-500/20 disabled:opacity-50">
            {run.s === 'run' ? t('调用中…', 'Calling…') : t('试调用', 'Test call')}
          </button>
        </div>
        {preview && <pre className="max-h-40 overflow-auto text-[10px] font-mono text-muted-foreground whitespace-pre-wrap break-all">{preview}</pre>}
        {run.s !== 'idle' && run.s !== 'run' && (
          <pre className={`max-h-40 overflow-auto text-[10px] font-mono whitespace-pre-wrap break-all ${run.s === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}>{run.text}</pre>
        )}
      </div>
    </div>
  );
}

/** 试调用输入：没填的走默认值（免得每次手打） */
function filledInputs(ep: ProviderEndpoint, inputs: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const v of ep.vars ?? []) {
    if (v.kind !== 'inject') continue;
    const val = inputs[v.name] ?? TRIAL_DEFAULT[v.name];
    if (val !== undefined) out[v.name] = val;
  }
  return out;
}

/** JSON 字段：编辑期本地文本，失焦/回车才解析并写回（非法只红字提示，不吞内容） */
function JsonField({ label, value, onCommit }: { label: string; value: unknown; onCommit: (v: unknown) => void }) {
  const [txt, setTxt] = useState(() => JSON.stringify(value ?? {}, null, 1));
  const [err, setErr] = useState('');
  useEffect(() => { setTxt(JSON.stringify(value ?? {}, null, 1)); setErr(''); }, [label, JSON.stringify(value)]);
  const commit = () => {
    try { const parsed = JSON.parse(txt); setErr(''); onCommit(parsed); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className="flex-1 min-w-40">
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-muted-foreground">{label}</span>
        {err && <span className="text-[10px] text-red-400 truncate" title={err}>✕ {err}</span>}
      </div>
      <textarea
        value={txt} rows={Math.min(8, txt.split('\n').length)} onChange={(e) => setTxt(e.target.value)}
        onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); } }}
        className="input w-full text-[10px] font-mono resize-y leading-snug"
      />
    </div>
  );
}
