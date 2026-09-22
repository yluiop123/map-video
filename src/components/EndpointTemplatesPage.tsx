/**
 * EndpointTemplatesPage — 「接口模板」独立整屏页面（对应 provider_endpoint 表）
 *
 * 与 ⚙ 里的实例设置**不在同一个页面**：那一页管「这家用什么 Key、哪个模型、参数取多少」，
 * 这一页管「这家到底怎么发请求」（path / headers / body / 出参取法 / 异步轮询）。
 * 放在一起（哪怕分页签）会让日常操作和专家操作互相遮挡，所以拆成两个入口。
 */
import { useEffect, useMemo, useState } from 'react';
import { JsonField, OptionBlocks, Toggle, useT } from './ui/primitives';
import { useConfirm } from './ui/ConfirmHost';
import { useEditorStore } from '../stores/editorStore';
import { useProviderStore } from '../stores/providerStore';
import type { ProviderConfig, ProviderEndpoint } from '../types';
import { ROLES_BY_KIND, recipeById, seedTemplate } from '../lib/recipes';
import { endpointsOfRecipe, previewRequest, runRoleDebug } from '../lib/providers';
import { validateTemplate, type Role } from '../lib/request-engine';
import { pickLabel } from '../lib/i18n';

/** 试调用的默认输入（够跑通连通性，不必每次手打） */
const TRIAL_DEFAULT: Record<string, string> = {
  text: '这段旁白用来试听音色。',
  systemPrompt: '你是连通性测试助手。',
  userPrompt: '只回复两个字：正常',
  prompt: '一只戴宇航员头盔的橘猫，赛博朋克风格',
  preferredName: 'mapvideo',
  prefix: 'mv',
};

export function EndpointTemplatesPage({ providerId, onClose }: { providerId: string; onClose: () => void }) {
  const t = useT();
  const lang = useEditorStore((s) => (s.lang === 'en' ? 'en' : 'zh'));
  const confirm = useConfirm();
  const llm = useProviderStore((s) => s.llm);
  const tts = useProviderStore((s) => s.tts);
  const image = useProviderStore((s) => s.image);
  const all = useMemo(() => [...llm, ...tts, ...image], [llm, tts, image]);
  const [selId, setSelId] = useState(providerId);
  const cfg = all.find((c) => c.id === selId) ?? null;
  // 在这页里把这家供应商删了就别停在空页上
  useEffect(() => { if (!cfg && all.length) setSelId(all[0].id); }, [cfg, all]);

  const recipe = cfg ? recipeById(cfg.recipe) : undefined;
  const setEndpoints = (endpoints: ProviderEndpoint[]) => {
    if (cfg) useProviderStore.getState().update(cfg.id, { endpoints });
  };
  const missing = cfg ? ROLES_BY_KIND[cfg.kind].filter((r) => !cfg.endpoints.some((e) => e.role === r)) : [];
  const addRole = (role: Role) => {
    if (!cfg) return;
    setEndpoints([...cfg.endpoints, { ...seedTemplate(cfg.kind, role), enabled: true, overrides: {} }]);
  };
  const drop = async (role: Role) => {
    if (!cfg) return;
    if (await confirm({ message: t(`从这家供应商移除接口「${role}」？模板包的默认形状不受影响，可再点「＋」加回来（你在模板里改过的内容会丢）`, `Remove endpoint ${role}? Re-adding it from the recipe loses your edits.`), danger: true })) {
      setEndpoints(cfg.endpoints.filter((e) => e.role !== role));
    }
  };

  const sameKind = cfg ? all.filter((c) => c.kind === cfg.kind) : [];

  return (
    <div className="fixed inset-0 z-50 bg-background overflow-y-auto">
      <div className="mx-auto w-[54rem] max-w-[96vw] py-4 space-y-3">
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="h-7 px-2.5 rounded-md border border-white/15 text-[11px] hover:bg-white/10 shrink-0">← {t('返回实例设置', 'Back')}</button>
          <h2 className="text-sm font-semibold shrink-0">{t('接口模板', 'Endpoint templates')}</h2>
          <span className="text-[10px] font-mono text-muted-foreground/60 truncate">provider_endpoint</span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {sameKind.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelId(c.id)}
              className={`h-7 px-2 rounded-md border text-[11px] transition-colors ${c.id === selId ? 'border-white/30 bg-white/10' : 'border-white/10 hover:bg-white/[0.06]'}`}
              title={c.recipe}
            >{c.label}</button>
          ))}
        </div>

        <p className="text-[11px] text-muted-foreground">
          {t('改的是「这家怎么发请求」（每行存 provider_endpoint 的 headers_json / query_json / body_json / vars_json / resp_json / poll_json）。占位符：{name} 取变量（标量保留类型），{@name} 在数组里展开成多个元素。', 'Edits what gets sent (one provider_endpoint row each). {name} = variable, {@name} splices array elements.')}
        </p>

        {cfg && (
          <div className="space-y-2">
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
            <p className="text-[10px] text-muted-foreground/70">
              {pickLabel(recipe?.note, lang)} · {t('改完自动存本机库；「预览请求」不联网，「试调用」会真发一次请求。', 'Saved locally; Preview never touches the network, Test does.')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function EndpointCard({ cfg, ep, defaults, onDelete }: { cfg: ProviderConfig; ep: ProviderEndpoint; defaults?: ProviderEndpoint; onDelete: () => void }) {
  const t = useT();
  const lang = useEditorStore((s) => (s.lang === 'en' ? 'en' : 'zh'));
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<string>('');
  const [run, setRun] = useState<{ s: 'idle' | 'run' | 'ok' | 'err'; text?: string }>({ s: 'idle' });
  const patch = (p: Partial<ProviderEndpoint>) => {
    useProviderStore.getState().updateEndpoint(cfg.id, ep.role, p);
    setPreview('');
  };
  const problems = validateTemplate(ep);
  const injects = (ep.vars ?? []).filter((v) => v.kind === 'inject').map((v) => v.name);
  /** 预览/试调用要拿「当前这一行的改动 + 其余行」拼一份临时配置（store 是异步的，不能等它） */
  const withThis = () => ({ ...cfg, endpoints: (cfg.endpoints ?? []).map((e) => (e.role === ep.role ? ep : e)) });

  const doPreview = () => {
    try {
      const r = previewRequest(withThis(), ep.role, filledInputs(ep, inputs));
      setPreview(`${r.method} ${r.url}\nheaders: ${JSON.stringify(r.headers)}\nquery: ${JSON.stringify(r.query)}\nbody: ${JSON.stringify(r.body, null, 1)}`);
    } catch (e) { setPreview(`✕ ${e instanceof Error ? e.message : String(e)}`); }
  };
  const doRun = async () => {
    setRun({ s: 'run' });
    try {
      const r = await runRoleDebug(withThis(), ep.role, filledInputs(ep, inputs));
      const shown = r.steps.map((s) => `${s.label} HTTP ${s.status} ${JSON.stringify(s.values)}`).join('\n');
      setRun({ s: 'ok', text: `${shown}${r.bytes ? `\n→ 音频/图片 ${r.bytes.length} 字节（${r.mime || '未知类型'}）` : ''}` });
    } catch (e) { setRun({ s: 'err', text: e instanceof Error ? e.message : String(e) }); }
  };

  return (
    <div className="border border-white/10 rounded-lg p-2.5 space-y-1.5">
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
            onClick={() => setEndpoints(cfg, ep.role, { ...defaults, enabled: ep.enabled, overrides: ep.overrides })}
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
        <JsonField label={t('异步规则', 'Poll')} value={ep.poll} onCommit={(v) => patch({ poll: isBlank(v) ? undefined : v as typeof ep.poll })} />
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

/** 整行替换（不是合并）：「恢复默认」要能把模板包里没有的键（如残留的 poll）一起清掉 */
function setEndpoints(cfg: ProviderConfig, role: Role, next: ProviderEndpoint) {
  const endpoints = (cfg.endpoints ?? []).map((e) => (e.role === role ? next : e));
  useProviderStore.getState().update(cfg.id, { endpoints });
}

/** 空对象 = 「没配」：poll 的 JsonField 空着时是 {}，直接写回去会让同步接口被判定「配了查询规则」 */
const isBlank = (v: unknown) => v == null || (typeof v === 'object' && Object.keys(v as object).length === 0);

/** 试调用输入：没填的走默认值（免得每次手打） */function filledInputs(ep: ProviderEndpoint, inputs: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const v of ep.vars ?? []) {
    if (v.kind !== 'inject') continue;
    const val = inputs[v.name] ?? TRIAL_DEFAULT[v.name];
    if (val !== undefined) out[v.name] = val;
  }
  return out;
}
