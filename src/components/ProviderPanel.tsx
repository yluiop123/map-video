/**
 * ProviderPanel.tsx — ⚙ 设置 · AI 的「实例设置」页
 *
 * 一个能力一屏，里面是**这个能力的实例列表** + 选中实例的表单：
 * 名称、用哪份模板、同步还是异步、模板声明的实例级参数（含 Base URL 与密钥），
 * 以及按请求分区的请求级参数（同步与异步的 model 可以不一样）。
 * 「怎么发请求」不在这页 —— 那是左侧单独的「接口模板」入口（TemplatesPane）。
 */
import { useState } from 'react';
import { OptionBlocks, ProblemList, useT } from './ui/primitives';
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
  VOICE_FILE_KEY, openKeysOf, paramLabelOf, requestOf, selectableModesOf, submitKeyOf, usedSlotsOf, validateTemplate,
  type Category, type FileValue, type InstanceDef, type ParamSpec, type ReqKey, type TemplateDef,
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

/**
 * 页签与分区的名字：这条实例只走自己那一侧（`usedSlotsOf`），所以不用带「同步 · / 异步 ·」前缀
 * —— 那一排的右边「请求方式」已经说明在看哪一侧了。
 */
const REQ_TITLE: Record<ReqKey, { zh: string; en: string }> = {
  upload: { zh: '上传', en: 'Upload' },
  clone: { zh: '克隆', en: 'Clone' },
  'sync.submit': { zh: '提交', en: 'Submit' },
  'async.submit': { zh: '提交', en: 'Submit' },
  'async.query': { zh: '查询', en: 'Query' },
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

      {sel && <InstanceForm inst={sel} missingTpl={!tplOf(sel)} />}
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
function InstanceForm({ inst, missingTpl }: { inst: InstanceDef; missingTpl: boolean }) {
  const t = useT();
  const store = useProviderStore.getState();
  const templates = useProviderStore((s) => s.templates);
  const confirm = useConfirm();
  const tpl = templates.find((x) => x.id === inst.tplId);
  const mine = templates.filter((x) => x.category === (tpl?.category ?? 'llm'));
  const setValues = (patch: Partial<InstanceDef>, values?: Parameters<typeof store.updateInstance>[2]) => store.updateInstance(inst.id, patch, values);
  const problems = tpl ? validateTemplate(tpl) : [`模板「${inst.tplId}」已经不在了`];
  /** 只给这份模板真有的接法；只有一种时整行不显示（见 `selectableModesOf`） */
  const modes = selectableModesOf(tpl, inst);
  const curMode = inst.sync ? 'sync' : 'async';
  /** 实例存的那一档在这份模板里根本没有接口（换了模板才会这样）：这一行必须长出来，否则那条红报错在界面上消不掉 */
  const badMode = !tpl || !requestOf(tpl, submitKeyOf(inst.sync));
  const modeLabel = (m: 'sync' | 'async') => (m === 'sync' ? t('同步', 'Sync') : t('异步任务', 'Async task'));

  /** 这一屏的页签 = 这条实例真会走到的那几格；激活哪格就看哪格的参数与试调用 */
  const slots = tpl ? usedSlotsOf(tpl, inst) : [];
  const [pickedSlot, setPickedSlot] = useState<ReqKey | ''>('');
  const slot = slots.find((k) => k === pickedSlot) ?? slots[0];
  const slotDef = slot && tpl ? requestOf(tpl, slot) : undefined;

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

      {(modes.length > 1 || badMode) && (
        <div className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-3">
          <Label className="text-right text-[10px] font-normal text-muted-foreground">{t('请求方式', 'Mode')}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <OptionBlocks<string>
              value={badMode ? '' : curMode}
              options={modes.map((m) => ({ value: m, label: modeLabel(m) }))}
              onChange={(v) => setValues({ sync: v === 'sync' })}
            />
            {badMode && (
              <span className="text-[10px] text-red-400">
                {t(`这条实例存的是${inst.sync ? '同步' : '异步'}，但这份模板没有那一套接口 —— 点上面改回来`,
                  'Stored mode has no matching endpoint in this template — pick the one above')}
              </span>
            )}
          </div>
        </div>
      )}

      {/* 左：激活哪格看哪格（参数 + 试调用都用同一排页签）；右：实例参数固定在这，切页签不动它 */}
      <div className="grid gap-x-4 gap-y-2 md:grid-cols-[minmax(0,1fr)_240px]">
        <div className="min-w-0 space-y-2">
          {slot && (
            <Tabs value={slot} onValueChange={(v) => setPickedSlot(v as ReqKey)}>
              <TabsList className="h-8">
                {slots.map((k) => (
                  <TabsTrigger key={k} value={k} className="text-[11px]">{t(REQ_TITLE[k].zh, REQ_TITLE[k].en)}</TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
          {!!slotDef?.requestParams?.length && (
            <Group title={`${t(REQ_TITLE[slot].zh, REQ_TITLE[slot].en)} · ${t('参数', 'params')}`}
              hint={t('填了值的存这条实例（同名参数在别的格可以取不同值）；留空的由调用点现场给', 'fill what this account pins; leave the rest to the call site')}>
              {slotDef.requestParams.map((p) => (
                <ParamControl key={p.key} p={p} value={inst.values.requests?.[slot]?.[p.key]}
                  onChange={(v) => setValues({}, { requests: { [slot]: { ...(inst.values.requests?.[slot] ?? {}), [p.key]: v } } })} />
              ))}
            </Group>
          )}
          {/* 换页签要重挂载：试调用的草稿（现场参数与选中的文件）按参数名存，两格里同名参数不是一回事（见 §6.30） */}
          {tpl && slot && <TrialBox key={slot} inst={inst} tpl={tpl} slot={slot} />}
        </div>
        {!!tpl?.instanceParams?.length && (
          <div className="self-start md:sticky md:top-0">
            <Group title={t('实例参数', 'Instance params')} hint={t('这份模板声明的，全部请求共用', 'declared by the template, shared')}>
              {tpl.instanceParams.map((p) => (
                <ParamControl key={p.key} block p={p} value={inst.values.instance?.[p.key]}
                  onChange={(v) => setValues({}, { instance: { [p.key]: v } })} />
              ))}
            </Group>
          </div>
        )}
      </div>

      <ProblemList problems={problems} />
    </div>
  );
}

/**
 * 试调用：真发一条，用**这条实例**的取值与 Key（模板页不发请求）。
 * 哪一格由上面那排页签决定 —— 参数与试调用读同一个激活格，所以这里不再自带第二排页签。
 * 要现场给哪些参数 = 这一格引用了、而实例里没填的那些名字（从占位符反推，不靠第二张声明表）。
 * 产物只回显字节数与取到的字段，不落库 —— 落库是各业务动作自己的事。
 */
function TrialBox({ inst, tpl, slot }: { inst: InstanceDef; tpl: TemplateDef; slot: ReqKey }) {
  const t = useT();
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<Record<string, FileValue>>({});
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState('');
  const cur = slot;
  const callKeys = openKeysOf(tpl, inst, cur);
  /** `${voiceData}` 是引擎注入的那个文件（不是声明出来的参数）：这里长文件选择框，别的长文本框 */
  const isFileParam = (k: string) => k === VOICE_FILE_KEY;
  const argLabel = (k: string) => (k === VOICE_FILE_KEY ? t('参考音频', 'Reference audio') : paramLabelOf(tpl, cur, k));
  const args = (): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    for (const k of callKeys) {
      const v = files[k] ?? inputs[k] ?? SAMPLE_CALL_ARGS[k];
      if (v !== undefined) o[k] = v;
    }
    return o;
  };
  const pickFile = async (k: string, f?: File) => {
    if (!f) { setFiles((s) => { const n = { ...s }; delete n[k]; return n; }); return; }
    const bytes = new Uint8Array(await f.arrayBuffer());
    setFiles((s) => ({ ...s, [k]: { bytes, mime: f.type || 'application/octet-stream', name: f.name } }));
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
      {callKeys.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {callKeys.map((k) => (
            // 换页签不重挂载会留着上一格选中的那个文件（见 §6.30）：定位按「哪一格的哪个参数」
            <label key={`${cur}:${k}`} className="flex items-center gap-1 text-[10px]">
              {/* 显示模板声明的名字，裸 key 只作 title */}
              <span className="text-muted-foreground" title={k}>{argLabel(k)}</span>
              {isFileParam(k) ? (
                /* 就是那个引擎注入的文件：点按钮选，选了显示名字与大小（裸 input[type=file] 太不起眼，看着像不能上传） */
                <span className="flex items-center gap-1.5">
                  <label className="cursor-pointer rounded border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] hover:bg-white/10">
                    {files[k] ? t('换一份', 'Replace') : t('上传文件', 'Choose file')}
                    <input type="file" className="hidden" accept="audio/*"
                      onChange={(e) => void pickFile(k, e.target.files?.[0])} />
                  </label>
                  {files[k] && (
                    <span className="max-w-40 truncate text-muted-foreground" title={files[k].name}>
                      {files[k].name} · {(files[k].bytes.length / 1024).toFixed(0)}KB
                    </span>
                  )}
                </span>
              ) : (
                <Input value={inputs[k] ?? SAMPLE_CALL_ARGS[k] ?? ''} className="h-6 w-40 text-[11px]"
                  onChange={(e) => setInputs((s) => ({ ...s, [k]: e.target.value }))} />
              )}
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
function ParamControl({ p, value, onChange, block }: { p: ParamSpec; value: unknown; onChange: (v: unknown) => void; block?: boolean }) {
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
  /**
   * `block` = 标签在控件上方（右栏那种窄列）：一行两列在这里会把输入框挤成一百来像素，
   * 地址与 Key 恰恰是最长的那两个。
   */
  const wrap = (children: React.ReactNode) => block ? (
    <div className="space-y-1">
      <Label className="block text-[10px] font-normal text-muted-foreground" title={p.key}>{label}</Label>
      <div className="min-w-0">
        {children}
        {hint && <div className="mt-0.5 text-[9px] text-muted-foreground/60">{hint}</div>}
      </div>
    </div>
  ) : (
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
    return wrap(
      <label className="flex items-center gap-2">
        <Switch checked={empty ? p.defaultValue !== false : value === true} onCheckedChange={onChange} />
        <span className="text-[10px] text-muted-foreground">{value === false || (empty && p.defaultValue === false) ? t('关', 'off') : t('开', 'on')}</span>
      </label>,
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
