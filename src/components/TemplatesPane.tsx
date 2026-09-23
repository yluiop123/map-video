/**
 * TemplatesPane.tsx — ⚙ 设置 · AI 左侧的「接口模板」页（三栏）
 *
 * 一份模板 = 数据库一行，里面同时装着：headers、实例级参数、同步 / 异步两套接口、
 * 下载 / 上传桥接、克隆音色。三层参数（实例级 / 请求级 / 调用级）都在这页自由增删改 ——
 * 引擎里没有任何按厂商名写的分支，界面配不出来的东西就不该存在。
 *
 * 「预览请求」零网络（只跑求值 + 密钥打码），「试调用」真发一条。
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { useT } from './ui/primitives';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Badge } from './ui/badge';
import { Separator } from './ui/separator';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { Textarea } from './ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Switch } from './ui/switch';
import { useConfirm } from './ui/ConfirmHost';
import { useProviderStore } from '../stores/providerStore';
import { seedTemplate } from '../lib/template-seed';
import {
  REQ_KEYS, callKeysOf, requestOf, validateTemplate,
  type Category, type InstanceDef, type OutputFormat, type ParamSpec, type ReqKey,
  type RequestDef, type TemplateDef, type ValueType,
} from '../lib/request-engine';
import { previewRequest, SAMPLE_CALL_ARGS } from '../lib/providers';

const CATEGORY_LABEL: Record<Category, { zh: string; en: string }> = {
  llm: { zh: '文案生成', en: 'Text' },
  tts: { zh: '语音', en: 'Voice' },
  image: { zh: '图片', en: 'Image' },
};

/** 每条请求在界面上的名字（这是界面自身的文案，所以中英两份） */
const REQ_LABEL: Record<ReqKey, { zh: string; en: string }> = {
  'sync.submit': { zh: '同步 · 提交', en: 'Sync · submit' },
  'async.submit': { zh: '异步 · 提交', en: 'Async · submit' },
  'async.query': { zh: '异步 · 查询', en: 'Async · query' },
  download: { zh: '桥接 · 下载', en: 'Bridge · download' },
  upload: { zh: '桥接 · 上传', en: 'Bridge · upload' },
  clone: { zh: '核心 · 克隆音色', en: 'Core · voice clone' },
};

const VALUE_TYPES: ValueType[] = ['string', 'text', 'number', 'boolean', 'enum', 'multiEnum', 'array', 'secret', 'file', 'json'];
const FORMATS: (OutputFormat | 'none')[] = ['none', 'binary', 'hex', 'base64', 'url'];

const present = (t: TemplateDef, key: ReqKey) => !!requestOf(t, key);

/** 还能补哪些请求：异步要成对（提交 + 查询），上传只在克隆时有意义 */
function addable(t: TemplateDef): ReqKey[] {
  const out: ReqKey[] = [];
  if (t.category !== 'llm') {
    if (!t.async?.submit) out.push('async.submit');
    if (t.async?.submit && !t.async.query) out.push('async.query');
    if (!t.download) out.push('download');
  }
  if (t.category === 'tts') {
    if (!t.clone) out.push('clone');
    else if (t.useClone && !t.upload) out.push('upload');
  }
  return out;
}

const blankRequest = (key: ReqKey): RequestDef => (key === 'async.query'
  ? { path: '${baseUrl}/tasks/${taskId}', method: 'GET', body: {}, outputs: { status: 'status' }, successValues: ['SUCCEEDED'], failureValues: ['FAILED'] }
  : { path: '${baseUrl}/', method: 'POST', requestParams: [], callParams: [{ key: 'text', label: '文本', valueType: 'text' }], body: { model: '${model}' }, outputs: {} });

export function TemplatesPane() {
  const t = useT();
  const templates = useProviderStore((s) => s.templates);
  const instances = useProviderStore((s) => s.instances);
  const saveTemplate = useProviderStore((s) => s.saveTemplate);
  const addTemplate = useProviderStore((s) => s.addTemplate);
  const removeTemplate = useProviderStore((s) => s.removeTemplate);
  const restoreTemplate = useProviderStore((s) => s.restoreTemplate);
  const confirm = useConfirm();
  const [category, setCategory] = useState<Category>('llm');
  const [selId, setSelId] = useState('');
  const [selReq, setSelReq] = useState<ReqKey>('sync.submit');

  const mine = useMemo(() => templates.filter((x) => x.category === category), [templates, category]);
  const tpl = mine.find((x) => x.id === selId) ?? mine[0];
  useEffect(() => { if (tpl && tpl.id !== selId) setSelId(tpl.id); }, [tpl, selId]);
  useEffect(() => {
    if (tpl && !present(tpl, selReq)) setSelReq(REQ_KEYS.find((k) => present(tpl, k)) ?? 'sync.submit');
  }, [tpl, selReq]);

  const patch = (next: TemplateDef) => { if (next.id) saveTemplate(next); };
  const usedBy = (id: string) => instances.filter((i) => i.tplId === id);
  const problems = tpl ? validateTemplate(tpl) : [];

  const drop = async () => {
    if (!tpl) return;
    const users = usedBy(tpl.id).length;
    const ok = await confirm({
      message: t(`删除模板「${tpl.name || tpl.id}」？${users ? `有 ${users} 条实例在用它，会一起删掉。` : ''}`,
        `Delete this template? ${users ? `${users} instance(s) go with it.` : ''}`),
      danger: true,
    });
    if (ok) { removeTemplate(tpl.id); setSelId(''); }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="shrink-0">
        <h3 className="text-sm font-semibold">{t('🧩 接口模板', '🧩 Endpoint templates')}</h3>
        <p className="text-[11px] text-muted-foreground">
          {t('一份模板 = 一个功能用到的全部接口（同步 / 异步 / 下载 / 上传 / 克隆）。三层参数都在这儿填，实例那边只填取值与密钥。',
            'One template = every endpoint a capability needs. All three parameter layers live here; instances only hold values and keys.')}
        </p>
      </div>

      <Tabs value={category} onValueChange={(k) => { setCategory(k as Category); setSelId(''); }} className="shrink-0">
        <TabsList className="h-8">
          {(Object.keys(CATEGORY_LABEL) as Category[]).map((k) => (
            <TabsTrigger key={k} value={k} className="text-[11px]">{t(CATEGORY_LABEL[k].zh, CATEGORY_LABEL[k].en)}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="grid min-h-0 flex-1 grid-cols-[150px_minmax(0,1fr)] gap-3 xl:grid-cols-[150px_minmax(0,1fr)_300px]">
        {/* 左：这一类的模板列表 */}
        <div className="min-h-0 space-y-1 overflow-y-auto pr-0.5">
          {mine.map((x) => (
            <button key={x.id} onClick={() => setSelId(x.id)} title={x.id}
              className={`flex w-full items-center gap-1.5 rounded-md border px-2 py-1 text-left text-[11px] ${
                x.id === tpl?.id ? 'border-white/35 bg-white/10' : 'border-white/10 hover:bg-white/[0.06]'}`}>
              <span className="min-w-0 flex-1 truncate">{x.name || x.id}</span>
              <Badge variant="outline" className="shrink-0 px-1 py-0 text-[9px] font-normal tabular-nums">{usedBy(x.id).length}</Badge>
            </button>
          ))}
          <Button variant="outline" size="sm" className="w-full h-7 text-[11px]" onClick={() => setSelId(addTemplate(category).id)}>
            ＋ {t('模板', 'template')}
          </Button>
        </div>

        {/* 中：模板头 + 选中的那条接口 */}
        {tpl && (
          <div className="min-h-0 min-w-0 space-y-2 overflow-y-auto pr-1">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1.5">
              <Input value={tpl.name} onChange={(e) => patch({ ...tpl, name: e.target.value })} className="h-7 text-xs" placeholder={t('模板名', 'Name')} />
              <Input value={tpl.id} onChange={(e) => patch({ ...tpl, id: e.target.value })} className="h-7 text-xs font-mono" placeholder="id" />
              <div className="flex items-center gap-1.5">
                <Button variant="outline" size="sm" className="h-7 text-[11px]" disabled={!seedTemplate(tpl.id)}
                  onClick={() => restoreTemplate(tpl.id)} title={t('丢弃本地改动，取回内置默认形状', 'Restore the built-in shape')}>
                  {t('恢复默认', 'Restore')}
                </Button>
                <Button variant="outline" size="sm" className="h-7 text-[11px] text-red-400/90" onClick={() => void drop()}>{t('删除', 'Delete')}</Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11px]">
              <label className="flex items-center gap-2">
                <Switch id="tpl-clone" checked={!!tpl.useClone} onCheckedChange={(v) => patch({ ...tpl, useClone: v })} />
                <Label htmlFor="tpl-clone" className="text-[11px] font-normal">{t('有克隆音色接口', 'voice clone')}</Label>
              </label>
              <label className="flex items-center gap-2">
                <Switch id="tpl-upload" checked={!!tpl.hasUpload} disabled={!tpl.useClone} onCheckedChange={(v) => patch({ ...tpl, hasUpload: v })} />
                <Label htmlFor="tpl-upload" className="text-[11px] font-normal">{t('克隆前先上传拿 fileId', 'upload first')}</Label>
              </label>
              <label className="flex items-center gap-2">
                <span className="text-muted-foreground text-[10px]">{t('参考音频采样率', 'ref rate')}</span>
                <Input type="number" value={tpl.refSampleRateHz ?? ''} className="h-6 w-24 text-[10px]"
                  onChange={(e) => patch({ ...tpl, refSampleRateHz: e.target.value ? Number(e.target.value) : undefined })} />
              </label>
            </div>

            <JsonBox label="Headers" value={tpl.headers ?? {}} onChange={(headers) => patch({ ...tpl, headers: headers as Record<string, unknown> })}
              hint={t('所有请求共用一份，值里可写 ${apiKey}', 'shared by every request; ${apiKey} allowed')} />

            <Separator />

            <Tabs value={selReq} onValueChange={(k) => setSelReq(k as ReqKey)} className="w-full">
              <TabsList className="h-8 flex-wrap">
                {REQ_KEYS.filter((k) => present(tpl, k)).map((k) => (
                  <TabsTrigger key={k} value={k} className="text-[11px]">{t(REQ_LABEL[k].zh, REQ_LABEL[k].en)}</TabsTrigger>
                ))}
              </TabsList>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {addable(tpl).map((k) => (
                  <Button key={k} variant="outline" size="sm" className="h-7 text-[11px]"
                    onClick={() => {
                      const next: TemplateDef = { ...tpl };
                      if (k === 'sync.submit') next.sync = { submit: blankRequest(k) };
                      else if (k === 'async.submit') next.async = { submit: blankRequest(k), query: undefined };
                      else if (k === 'async.query') next.async = { submit: next.async?.submit, query: blankRequest(k) };
                      else next[k] = blankRequest(k);
                      if (k === 'clone') next.useClone = true;
                      if (k === 'upload') next.hasUpload = true;
                      patch(next); setSelReq(k);
                    }}>
                    ＋ {t(REQ_LABEL[k].zh, REQ_LABEL[k].en)}
                  </Button>
                ))}
              </div>
              {present(tpl, selReq) && (
                <div className="mt-2"><RequestEditor tpl={tpl} reqKey={selReq} inst={usedBy(tpl.id)[0] ?? null} onChange={patch} /></div>
              )}
            </Tabs>

            {problems.length > 0 && <p className="text-[10px] text-red-400 whitespace-pre-line">{problems.join('\n')}</p>}
          </div>
        )}

        {/* 右：实例级参数（整份模板共用） */}
        {tpl && (
          <div className="hidden min-h-0 overflow-y-auto border-l border-white/10 pl-3 xl:block">
            <ParamTable title={t('实例级参数', 'Instance params')}
              hint={t('全请求共用；Base URL 与密钥就在这儿声明，secret 渲染成密码框', 'declare baseUrl / keys here')}
              params={tpl.instanceParams ?? []} onChange={(instanceParams) => patch({ ...tpl, instanceParams })} />
          </div>
        )}
      </div>
    </div>
  );
}

// ========== 选中请求 ==========

function RequestEditor({ tpl, reqKey, inst, onChange }: {
  tpl: TemplateDef; reqKey: ReqKey; inst: InstanceDef | null; onChange: (t: TemplateDef) => void;
}) {
  const t = useT();
  const def = requestOf(tpl, reqKey)!;
  const set = (p: Partial<RequestDef>) => {
    const merged = { ...def, ...p };
    const next: TemplateDef = { ...tpl };
    if (reqKey === 'sync.submit') next.sync = { submit: merged };
    else if (reqKey === 'async.submit') next.async = { submit: merged, query: next.async?.query };
    else if (reqKey === 'async.query') next.async = { submit: next.async?.submit, query: merged };
    else next[reqKey as 'download' | 'upload' | 'clone'] = merged;
    onChange(next);
  };
  const dropReq = () => {
    const next: TemplateDef = { ...tpl };
    if (reqKey === 'sync.submit') next.sync = {};
    else if (reqKey === 'async.submit') next.async = {};
    else if (reqKey === 'async.query') next.async = { submit: next.async?.submit };
    else delete (next as unknown as Record<string, unknown>)[reqKey];
    if (reqKey === 'clone') next.useClone = false;
    if (reqKey === 'upload') next.hasUpload = false;
    onChange(next);
  };
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState('');
  const callKeys = callKeysOf(tpl, reqKey);

  const args = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of callKeys) {
      const v = inputs[k] ?? SAMPLE_CALL_ARGS[k];
      if (v !== undefined) out[k] = v;
    }
    return out;
  };
  const doPreview = () => {
    if (!inst) { setPreview(t('还没有实例用这份模板 —— 预览要用它填的取值才拼得出真实请求。', 'No instance uses this template yet.')); return; }
    try { setPreview(JSON.stringify(previewRequest(inst, reqKey, args()), null, 1)); }
    catch (e) { setPreview(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="space-y-2 rounded-md border border-white/10 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={def.method ?? 'POST'} onValueChange={(method) => set({ method })}>
          <SelectTrigger className="h-7 w-[70px] text-[11px]"><SelectValue /></SelectTrigger>
          <SelectContent>{['GET', 'POST', 'PUT'].map((m) => <SelectItem key={m} value={m} className="text-[11px]">{m}</SelectItem>)}</SelectContent>
        </Select>
        <Input value={def.path} onChange={(e) => set({ path: e.target.value })} className="h-7 text-xs flex-1 min-w-40 font-mono" placeholder="{baseUrl}/…" />
        <Button variant="outline" size="sm" className="h-7 text-[11px] text-red-400/90" onClick={dropReq}>{t('删这条接口', 'remove')}</Button>
      </div>

      <JsonBox label={t('附加请求头', 'Extra headers')} value={def.headers ?? {}} onChange={(headers) => set({ headers: headers as Record<string, unknown> })}
        hint={t('只写需要覆盖模板级的那几个（如异步开关头）', 'only what this request overrides')} />
      <ParamTable title={t('请求级参数（这个请求专属）', 'Request params')}
        hint={t('取值存实例的「按请求」那一区，同名可不同值', 'values stored per request')}
        params={def.requestParams ?? []} onChange={(requestParams) => set({ requestParams })} />
      <ParamTable title={t('调用级参数（每次调用现场给）', 'Call params')}
        hint={t('不落库；调用页与「试调用」按这些长输入框', 'given at call time')}
        params={def.callParams ?? []} onChange={(callParams) => set({ callParams })} />

      <JsonBox label="Body" value={def.body ?? {}} onChange={(body) => set({ body })}
        hint={t('值里写 ${key} 引用上面的参数', 'use ${key}')} />
      <JsonBox label="Form" value={def.form ?? {}} onChange={(form) => set({ form: form as Record<string, unknown> })}
        hint={t('multipart 字段（上传文件用）', 'multipart fields')} />

      <div className="space-y-1">
        <div className="text-[10px] text-muted-foreground">
          {t('从响应里取字段（outputs）', 'Outputs')} · {t('取出来的名字下一个请求直接 ${它}', 'downstream requests use ${name}')}
        </div>
        {Object.entries(def.outputs ?? {}).map(([k, v]) => (
          <div key={k} className="flex items-center gap-1">
            <Input value={k} className="h-6 w-28 text-[10px] font-mono" placeholder="taskId"
              onChange={(e) => set({ outputs: rename(mapOf(def), k, e.target.value) })} />
            <Input value={String(v)} className="h-6 flex-1 text-[10px] font-mono" placeholder="output.task_id"
              onChange={(e) => set({ outputs: { ...mapOf(def), [k]: e.target.value } })} />
            <Button variant="ghost" size="sm" className="h-6 w-6 text-[10px]" onClick={() => { const n = { ...mapOf(def) }; delete n[k]; set({ outputs: n }); }}>✕</Button>
          </div>
        ))}
        <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => set({ outputs: { ...mapOf(def), '': '' } })}>
          ＋ {t('取值', 'output')}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[10px]">
        <span className="text-muted-foreground">{t('产物封装', 'outputFormat')}</span>
        <Select value={def.outputFormat ?? 'none'} onValueChange={(v) => set({ outputFormat: v === 'none' ? undefined : (v as OutputFormat) })}>
          <SelectTrigger className="h-7 w-32 text-[11px]"><SelectValue /></SelectTrigger>
          <SelectContent>{FORMATS.map((f) => (
            <SelectItem key={f} value={f} className="text-[11px]">
              {f === 'none' ? t('无（不取产物）', 'none') : f === 'binary' ? t('binary 响应体即产物', 'binary') : f === 'url' ? t('url 当场下载', 'url') : f}
            </SelectItem>
          ))}</SelectContent>
        </Select>
        <span className="text-muted-foreground">{t('超时 ms', 'timeout')}</span>
        <Input type="number" value={def.timeoutMs ?? ''} className="h-7 w-24 text-[11px]"
          onChange={(e) => set({ timeoutMs: e.target.value ? Number(e.target.value) : undefined })} />
      </div>

      {reqKey === 'async.query' && (
        <div className="space-y-1.5">
          <ListField label={t('算成功的状态值', 'successValues')} value={def.successValues ?? []} onChange={(successValues) => set({ successValues })} />
          <ListField label={t('算失败的状态值', 'failureValues')} value={def.failureValues ?? []} onChange={(failureValues) => set({ failureValues })} />
          <p className="text-[10px] text-muted-foreground/70">{t('中间态不用配：两个列表都没命中就继续查。', 'Anything unlisted keeps polling.')}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        {callKeys.map((k) => (
          <label key={k} className="flex items-center gap-1 text-[10px]">
            <span className="text-muted-foreground">{k}</span>
            <Input value={inputs[k] ?? SAMPLE_CALL_ARGS[k] ?? ''} className="h-6 w-28 text-[11px]" onChange={(e) => setInputs((s) => ({ ...s, [k]: e.target.value }))} />
          </label>
        ))}
        <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={doPreview}>🔍 {t('预览请求', 'Preview')}</Button>
        <span className="text-[10px] text-muted-foreground/60">
          {t('只算不发；真发一条去「实例设置」页的试调用', 'no bytes sent; real calls live on the instance page')}
        </span>
      </div>
      {preview && (
        <pre className="max-h-40 overflow-auto rounded bg-black/40 p-2 text-[10px] whitespace-pre-wrap break-all">{preview}</pre>
      )}
    </div>
  );
}

const mapOf = (def: RequestDef) => def.outputs ?? {};
const rename = (map: Record<string, string>, from: string, to: string) => {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) next[k === from ? to : k] = v;
  return next;
};
// ========== 三层参数共用的编辑器 ==========

function ParamTable({ title, hint, params, onChange }: {
  title: string; hint?: string; params: ParamSpec[]; onChange: (p: ParamSpec[]) => void;
}) {
  const t = useT();
  const uid = useId();
  const sid = (i: number) => `${uid}-req-${i}`;
  const at = (i: number, p: Partial<ParamSpec>) => onChange(params.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const optsText = (p: ParamSpec) => (p.options ?? []).map((o) => (typeof o === 'object' && o !== null ? `${o.value}${o.label ? `=${o.label}` : ''}` : String(o))).join(', ');
  return (
    <div className="space-y-1">
      <div className="text-[10px] text-muted-foreground font-medium">
        {title}{hint && <span className="font-normal text-muted-foreground/70"> · {hint}</span>}
      </div>
      {params.map((p, i) => (
        <div key={i} className="space-y-1 rounded border border-white/10 p-1.5">
          <div className="grid grid-cols-[minmax(0,1fr)_86px_22px] items-center gap-1">
            <Input value={p.key} onChange={(e) => at(i, { key: e.target.value })} className="h-6 text-[10px] font-mono" placeholder="key" />
            <Select value={p.valueType ?? 'string'} onValueChange={(v) => at(i, { valueType: v as ValueType })}>
              <SelectTrigger className="h-6 text-[10px]"><SelectValue /></SelectTrigger>
              <SelectContent>{VALUE_TYPES.map((v) => <SelectItem key={v} value={v} className="text-[10px]">{v}</SelectItem>)}</SelectContent>
            </Select>
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-[10px]" onClick={() => onChange(params.filter((_, j) => j !== i))}>✕</Button>
          </div>
          <div className="grid grid-cols-2 gap-1">
            <Input value={p.label ?? ''} onChange={(e) => at(i, { label: e.target.value })} className="h-6 text-[10px]" placeholder={t('说明', 'label')} />
            <Input value={String(p.defaultValue ?? '')} onChange={(e) => at(i, { defaultValue: e.target.value })} className="h-6 text-[10px]" placeholder={t('默认值', 'default')} />
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <label className="flex items-center gap-1 pr-1 text-[10px] text-muted-foreground">
              <Switch id={sid(i)} checked={!!p.required} onCheckedChange={(v) => at(i, { required: v })} />
              <Label htmlFor={sid(i)} className="text-[10px] font-normal">{t('必填', 'required')}</Label>
            </label>
            {(p.valueType === 'enum' || p.valueType === 'multiEnum' || p.valueType === 'array') && (
              <Input value={optsText(p)} onChange={(e) => at(i, { options: parseList(e.target.value) })} className="h-6 min-w-32 flex-1 basis-40 text-[10px] font-mono"
                placeholder={t('候选值：mp3, wav 或 16000=16k', 'options: mp3, wav or 16000=16k')} />
            )}
            {p.valueType === 'number' && (
              <div className="grid min-w-32 flex-1 basis-40 grid-cols-3 gap-1">
                <Input type="number" value={p.min ?? ''} onChange={(e) => at(i, { min: num(e.target.value) })} className="h-6 min-w-0 text-[10px]" placeholder="min" />
                <Input type="number" value={p.max ?? ''} onChange={(e) => at(i, { max: num(e.target.value) })} className="h-6 min-w-0 text-[10px]" placeholder="max" />
                <Input type="number" step="0.1" value={p.step ?? ''} onChange={(e) => at(i, { step: num(e.target.value) })} className="h-6 min-w-0 text-[10px]" placeholder="step" />
              </div>
            )}
            {p.valueType === 'file' && (
              <>
                <Input value={p.accept ?? ''} onChange={(e) => at(i, { accept: e.target.value })} className="h-6 min-w-20 flex-1 text-[10px] font-mono" placeholder=".mp3,.wav" />
                <Input type="number" value={p.maxSize ?? ''} onChange={(e) => at(i, { maxSize: num(e.target.value) })} className="h-6 w-20 text-[10px]" placeholder={t('上限字节', 'maxSize')} />
              </>
            )}
            <Select value={p.transform ?? 'none'} onValueChange={(v) => at(i, { transform: v === 'none' ? undefined : (v as ParamSpec['transform']) })}>
              <SelectTrigger className="h-6 w-32 text-[10px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none" className="text-[10px]">{t('不做转换', 'no transform')}</SelectItem>
                <SelectItem value="hotFixArray" className="text-[10px]">hotFix → 数组</SelectItem>
                <SelectItem value="base64DataUri" className="text-[10px]">文件 → data URI</SelectItem>
                <SelectItem value="json" className="text-[10px]">字符串 → JSON</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      ))}
      <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => onChange([...params, { key: '', label: '', valueType: 'string' }])}>
        ＋ {t('参数', 'param')}
      </Button>
    </div>
  );
}

const num = (s: string) => (s === '' ? undefined : Number(s));

/** `a, b=乙, 16000=16k` → 候选值（数字 / 真假自动成形；只有 value 会进请求体） */
function parseList(s: string): ParamSpec['options'] {
  const parts = s.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  return parts.map((raw) => {
    const [v, label] = raw.split('=');
    const value = v === 'true' ? true : v === 'false' ? false : Number.isNaN(Number(v)) || v === '' ? v : Number(v);
    return label ? { value, label } : value;
  }) as ParamSpec['options'];
}

// ========== 小块 ==========

function JsonBox({ label, value, onChange, hint }: { label: string; value: unknown; onChange: (v: unknown) => void; hint?: string }) {
  const t = useT();
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 1));
  const [bad, setBad] = useState(false);
  const commit = (next: string) => {
    setText(next);
    try { onChange(JSON.parse(next || '{}')); setBad(false); } catch { setBad(true); }
  };
  return (
    <div className="space-y-1">
      <div className="text-[10px] text-muted-foreground">
        {label} · {hint ?? t('JSON', 'JSON')}{bad && <span className="text-red-400"> · {t('还不成形，暂不应用', 'not valid yet')}</span>}
      </div>
      <Textarea value={text} onChange={(e) => commit(e.target.value)} rows={4} className={`text-[10px] font-mono ${bad ? 'border-red-400/60' : ''}`} />
    </div>
  );
}

function ListField({ label, value, onChange }: { label: string; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <Input value={value.join(', ')} className="h-6 flex-1 min-w-40 text-[10px] font-mono"
        onChange={(e) => onChange(e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean))} />
    </div>
  );
}
