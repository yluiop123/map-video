/**
 * ProviderPanel.tsx — ⚙ 设置 · AI 的「实例设置」页
 *
 * 一个能力一屏，里面是**这个能力的实例列表** + 选中实例的表单：
 * 名称、用哪份模板、同步还是异步、模板声明的实例级参数（含 Base URL 与密钥），
 * 以及按请求分区的请求级参数（同步与异步的 model 可以不一样）。
 * 「怎么发请求」不在这页 —— 那是左侧单独的「接口模板」入口（TemplatesPane）。
 */
import { useState } from 'react';
import { OptionBlocks, useT } from './ui/primitives';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Separator } from './ui/separator';
import { Switch } from './ui/switch';
import { Textarea } from './ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { Button } from './ui/button';
import { useEditorStore } from '../stores/editorStore';
import { useProviderStore } from '../stores/providerStore';
import {
  REQ_KEYS, callKeysOf, requestOf, validateTemplate,
  type Category, type InstanceDef, type ParamSpec, type ReqKey, type TemplateDef,
} from '../lib/request-engine';
import { pickLabel } from '../lib/i18n';
import { previewRequest, trialCall, SAMPLE_CALL_ARGS } from '../lib/providers';
import { IS_DESKTOP } from '../lib/backend';
import { useConfirm } from './ui/ConfirmHost';

const KIND_TITLE: Record<Category, { zh: string; en: string }> = {
  llm: { zh: '🤖 文案生成 AI', en: '🤖 Text AI' },
  tts: { zh: '🔊 配音 / 声音克隆', en: '🔊 Voice (TTS / clone)' },
  image: { zh: '🖼 图片生成 AI', en: '🖼 Image AI' },
};

const REQ_TITLE: Record<ReqKey, { zh: string; en: string }> = {
  'sync.submit': { zh: '同步 · 提交', en: 'Sync · submit' },
  'async.submit': { zh: '异步 · 提交', en: 'Async · submit' },
  'async.query': { zh: '异步 · 查询', en: 'Async · query' },
  download: { zh: '桥接 · 下载', en: 'Bridge · download' },
  upload: { zh: '桥接 · 上传', en: 'Bridge · upload' },
  clone: { zh: '核心 · 克隆音色', en: 'Core · clone' },
};

export function ProviderPanel({ kind }: { kind: Category }) {
  const t = useT();
  const lang = useEditorStore((s) => (s.lang === 'en' ? 'en' : 'zh'));
  const templates = useProviderStore((s) => s.templates);
  const instances = useProviderStore((s) => s.instances);
  const picked = useProviderStore((s) => s.picked[kind]);
  const pick = useProviderStore((s) => s.pick);
  const addInstance = useProviderStore((s) => s.addInstance);
  const list = instances.filter((i) => templates.find((x) => x.id === i.tplId)?.category === kind);
  const sel = list.find((i) => i.id === picked) ?? list[0] ?? null;

  const tplOf = (i: InstanceDef) => templates.find((x) => x.id === i.tplId);

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{pickLabel(KIND_TITLE[kind], lang)}</h3>
      <p className="text-[11px] text-muted-foreground">
        {IS_DESKTOP
          ? t('一条实例 = 一份 Base URL + 一把 Key；存在本机 SQLite，请求经主进程转发（无 CORS）。密钥不出本机。',
            'One instance = one base URL + key, stored in local SQLite; requests go through the main process.')
          : t('网页版不含 AI 调用，请在桌面版使用。', 'AI runs in the desktop app only.')}
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        {list.map((i) => (
          <button key={i.id} onClick={() => pick(kind, i.id)}
            className={`h-7 px-2 rounded-md border text-[11px] ${i.id === sel?.id ? 'border-white/35 bg-white/10' : 'border-white/10 hover:bg-white/[0.06]'}`}>
            {i.name || i.id}
          </button>
        ))}
        <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => { const n = addInstance(kind); pick(kind, n.id); }}>
          ＋ {t('实例', 'instance')}
        </Button>
      </div>

      {sel && <InstanceForm inst={sel} tplName={tplOf(sel)?.name ?? sel.tplId} missingTpl={!tplOf(sel)} />}
      {!list.length && (
        <p className="rounded-md border border-dashed border-white/15 px-3 py-4 text-center text-[11px] text-muted-foreground">
          {t('这个能力还没有实例：点上面「＋实例」建一条，选模板并填地址与 Key。',
            'No instance yet — use ＋instance above, pick a template, fill base URL and key.')}
        </p>
      )}
    </div>
  );
}

/** 一条实例的表单 */
function InstanceForm({ inst, tplName, missingTpl }: { inst: InstanceDef; tplName: string; missingTpl: boolean }) {
  const t = useT();
  const store = useProviderStore.getState();
  const templates = useProviderStore((s) => s.templates);
  const confirm = useConfirm();
  const tpl = templates.find((x) => x.id === inst.tplId);
  const mine = templates.filter((x) => x.category === (tpl?.category ?? 'llm'));
  const setValues = (patch: Partial<InstanceDef>, values?: Parameters<typeof store.updateInstance>[2]) => store.updateInstance(inst.id, patch, values);
  const problems = tpl ? validateTemplate(tpl) : [`模板「${inst.tplId}」已经不在了`];
  /** 只给这份模板真有的接法：没有异步接口就不摆「异步任务」这一格（不做隐式降级，也不给配错的机会） */
  const modes = [
    ...(tpl?.sync?.submit ? [{ value: 'sync', label: t('同步', 'Sync') }] : []),
    ...(tpl?.async?.submit ? [{ value: 'async', label: t('异步任务', 'Async task') }] : []),
  ];
  const curMode = inst.sync ? 'sync' : 'async';
  const badMode = modes.length > 0 && !modes.some((m) => m.value === curMode);

  const drop = async () => {
    const ok = await confirm({ message: t(`删除实例「${inst.name || inst.id}」？密钥与取值一起删。`, 'Delete this instance?'), danger: true });
    if (ok) store.removeInstance(inst.id);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={inst.name} onChange={(e) => setValues({ name: e.target.value })} className="h-7 w-40 text-xs" placeholder={t('实例名', 'Name')} />
        <Select value={inst.tplId} onValueChange={(tplId) => setValues({ tplId })}>
          <SelectTrigger className="h-7 min-w-40 flex-1 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{mine.map((x) => <SelectItem key={x.id} value={x.id} className="text-xs">{x.name || x.id}</SelectItem>)}</SelectContent>
        </Select>
        <Button variant="outline" size="sm" className="h-7 shrink-0 text-[11px] text-red-400/90" onClick={() => void drop()}>
          {t('删除实例', 'Delete')}
        </Button>
      </div>
      {missingTpl && <p className="text-[10px] text-red-400">{t('这条实例引用的模板已被删除，换一份或去接口模板重建。', 'Its template is gone.')}</p>}

      <div className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-3">
        <Label className="text-right text-[10px] font-normal text-muted-foreground">{t('请求方式', 'Mode')}</Label>
        <div className="flex flex-wrap items-center gap-2">
          <OptionBlocks<string>
            value={badMode ? '' : curMode}
            options={modes}
            onChange={(v) => setValues({ sync: v === 'sync' })}
          />
          {badMode && (
            <span className="text-[10px] text-red-400">
              {t(`这条实例存的是${inst.sync ? '同步' : '异步'}，但这份模板没有那一套接口 —— 点上面改回来`,
                'Stored mode has no matching endpoint in this template — pick the one above')}
            </span>
          )}
          {modes.length === 1 && !badMode && (
            <span className="text-[10px] text-muted-foreground/60">
              {t(`这份模板（${tplName}）只有${inst.sync ? '同步' : '异步'}一种接法`, 'This template only has one mode')}
            </span>
          )}
        </div>
      </div>

      {!!tpl?.instanceParams?.length && (
        <Group title={t('实例参数', 'Instance params')} hint={t('这份模板声明的，全部请求共用', 'declared by the template, shared')}>
          {tpl.instanceParams.map((p) => (
            <ParamControl key={p.key} p={p} value={inst.values.instance?.[p.key]}
              onChange={(v) => setValues({}, { instance: { [p.key]: v } })} />
          ))}
        </Group>
      )}

      {tpl && REQ_KEYS.filter((k) => k !== 'async.query' && !!requestOf(tpl, k)?.requestParams?.length).map((k) => (
        <Group key={k} title={`${t(REQ_TITLE[k].zh, REQ_TITLE[k].en)} · ${t('参数', 'params')}`}
          hint={t('这个请求专属，同名参数不同请求可以取不同值', 'per-request values')}>
          {(requestOf(tpl, k)?.requestParams ?? []).map((p) => (
            <ParamControl key={p.key} p={p} value={inst.values.requests?.[k]?.[p.key]}
              onChange={(v) => setValues({}, { requests: { [k]: { ...(inst.values.requests?.[k] ?? {}), [p.key]: v } } })} />
          ))}
        </Group>
      ))}

      {tpl && <TrialBox inst={inst} tpl={tpl} />}

      {problems.length > 0
        ? <p className="text-[10px] text-red-400 whitespace-pre-line">{problems.join('\n')}</p>
        : null}
    </div>
  );
}

/**
 * 试调用：真发一条，用**这条实例**的取值与 Key（模板页只有零网络的预览）。
 * 产物只回显字节数与取到的字段，不落库 —— 落库是各业务动作自己的事。
 */
function TrialBox({ inst, tpl }: { inst: InstanceDef; tpl: TemplateDef }) {
  const t = useT();
  const keys = REQ_KEYS.filter((k) => !!requestOf(tpl, k));
  const [key, setKey] = useState<ReqKey>('sync.submit');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState('');
  const cur = keys.includes(key) ? key : keys[0];
  if (!cur) return null;
  const callKeys = callKeysOf(tpl, cur);
  const args = (): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    for (const k of callKeys) {
      const v = inputs[k] ?? SAMPLE_CALL_ARGS[k];
      if (v !== undefined) o[k] = v;
    }
    return o;
  };
  const preview = () => {
    try { setOut(JSON.stringify(previewRequest(inst, cur, args()), null, 1)); }
    catch (e) { setOut(e instanceof Error ? e.message : String(e)); }
  };
  const run = async () => {
    setBusy(true); setOut('');
    try {
      const r = await trialCall(inst, cur, args());
      const size = r.bytes?.length ? ` → ${(r.bytes.length / 1024).toFixed(0)}KB` : '';
      setOut(`${r.steps.map((x) => `${x.key} HTTP ${x.status}`).join(' → ')}${size}\n${JSON.stringify(r.values, null, 1)}`);
    } catch (e) { setOut(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <Group title={t('试调用', 'Try a call')} hint={t('用这条实例的取值与 Key 真发一条；产物只回显，不落库', 'sends a real request with this instance key')}>
      <Tabs value={cur} onValueChange={(v) => setKey(v as ReqKey)}>
        <TabsList className="h-8">
          {keys.map((k) => (
            <TabsTrigger key={k} value={k} className="text-[11px]">{t(REQ_TITLE[k].zh, REQ_TITLE[k].en)}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {callKeys.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {callKeys.map((k) => (
            <label key={k} className="flex items-center gap-1 text-[10px]">
              <span className="text-muted-foreground">{k}</span>
              <Input value={inputs[k] ?? SAMPLE_CALL_ARGS[k] ?? ''} className="h-6 w-40 text-[11px]"
                onChange={(e) => setInputs((s) => ({ ...s, [k]: e.target.value }))} />
            </label>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={preview}>🔍 {t('预览请求', 'Preview')}</Button>
        <Button size="sm" className="h-7 text-[11px]" disabled={busy} onClick={() => void run()}>
          {busy ? '⏳' : '▶'} {t('试调用', 'Run')}
        </Button>
      </div>
      {out && <pre className="max-h-44 overflow-auto rounded bg-black/40 p-2 text-[10px] whitespace-pre-wrap break-all">{out}</pre>}
    </Group>
  );
}

/** 一组参数：标题 + 说明 + 分隔线（界面自身的文案，走 t()） */
function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Separator />
      <div className="text-[10px] font-medium text-muted-foreground">
        {title}{hint && <span className="font-normal text-muted-foreground/60"> · {hint}</span>}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

/** 单个参数控件：valueType 定存储类型，options 定控件形态（有候选值用选项块，不写原生 select） */
function ParamControl({ p, value, onChange }: { p: ParamSpec; value: unknown; onChange: (v: unknown) => void }) {
  const t = useT();
  const label = p.label || p.key;
  const opts = (p.options ?? []).map((o) => (typeof o === 'object' && o !== null ? o : { value: o as string | number | boolean }));
  const empty = value === undefined || value === null || value === '';
  // 「没填」与「填了默认值」要看得见：控件下方单列一行说明，不挤在控件右边
  const hint = empty && p.defaultValue !== undefined && p.valueType !== 'secret'
    ? `${t('未填，按默认', 'unset, using default')} ${String(p.defaultValue)}`
    : p.valueType === 'number' && (p.min !== undefined || p.max !== undefined)
      ? `${p.min ?? '-'} … ${p.max ?? '-'}`
      : '';
  const wrap = (children: React.ReactNode) => (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5">
      <Label className="text-right text-[10px] font-normal text-muted-foreground" title={p.key}>{label}</Label>
      <div className="min-w-0">
        {children}
        {hint && <div className="mt-0.5 text-[9px] text-muted-foreground/60">{hint}</div>}
      </div>
    </div>
  );

  if (p.valueType === 'secret') {
    return wrap(<Input type="password" value={String(value ?? '')} className="h-7 text-xs" placeholder="••••••"
      onChange={(e) => onChange(e.target.value)} title={t('只存本机，不回显', 'stored locally, never shown')} />);
  }
  if (p.valueType === 'boolean') {
    return (
      <div className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-3">
        <Label className="text-right text-[10px] font-normal text-muted-foreground" title={p.key}>{label}</Label>
        <label className="flex items-center gap-2">
          <Switch checked={empty ? p.defaultValue !== false : value === true} onCheckedChange={onChange} />
          <span className="text-[10px] text-muted-foreground">{value === false || (empty && p.defaultValue === false) ? t('关', 'off') : t('开', 'on')}</span>
        </label>
      </div>
    );
  }
  if (opts.length) {
    return wrap(
      <OptionBlocks<string> value={String(empty ? p.defaultValue ?? '' : value)}
        options={opts.map((o) => ({ value: String(o.value), label: o.label ?? String(o.value) }))}
        onChange={(v) => onChange(p.valueType === 'number' ? Number(v) : v)} />,
    );
  }
  if (p.valueType === 'number') {
    // 未填 = 空串，绝不能显示成 0：0 是合法值（会真发出去），两者必须分得开
    return wrap(<Input type="number" value={empty && p.defaultValue === undefined ? '' : String(value ?? p.defaultValue ?? '')}
      min={p.min} max={p.max} step={p.step ?? 1} className="h-7 w-28 text-xs"
      onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />);
  }
  if (p.valueType === 'text' || p.valueType === 'json') {
    return wrap(<Textarea rows={2} value={String(value ?? '')} className="text-[11px] font-mono"
      placeholder={p.valueType === 'json' ? '{}' : ''} onChange={(e) => onChange(e.target.value)} />);
  }
  return wrap(<Input value={String(value ?? '')} className="h-7 text-xs font-mono" placeholder={String(p.defaultValue ?? '')}
    onChange={(e) => onChange(e.target.value)} />);
}
