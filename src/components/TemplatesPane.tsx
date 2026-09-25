/**
 * TemplatesPane.tsx — ⚙ 设置 · AI 左侧的「接口模板」页（三栏）
 *
 * 一份模板 = 数据库一行，里面同时装着：实例级参数、同步 / 异步两套接口、上传、克隆。
 * 请求头与参数都挂在各条接口自己身上（同一家不同端点要的头并不相同）；三层参数（实例级 / 请求级 /
 * 调用级）都在这页自由增删改 —— 引擎里没有任何按厂商名写的分支，界面配不出来的东西就不该存在。
 *
 * 页面上不写解释性长句：小节名旁边一枚 ⓘ，点开才看说明。
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import { OptionBlocks, ProblemList, useT } from './ui/primitives';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Badge } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Separator } from './ui/separator';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { Textarea } from './ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Switch } from './ui/switch';
import { Checkbox } from './ui/checkbox';
import { useConfirm } from './ui/ConfirmHost';
import { useProviderStore } from '../stores/providerStore';
import { seedTemplate } from '../lib/template-seed';
import {
  ARTIFACT_KEY, REQ_KEYS, requestOf, requiredOutputsOf, slotsOf, validateTemplate,
  type ArtifactEncoding, type Caps, type Category, type ParamSpec, type ReqKey,
  type RequestDef, type TemplateDef, type ValueType,
} from '../lib/request-engine';

const CATEGORY_LABEL: Record<Category, { zh: string; en: string }> = {
  llm: { zh: '文案生成', en: 'Text' },
  tts: { zh: '语音', en: 'Voice' },
  image: { zh: '图片', en: 'Image' },
};

/** 页签上的名字（界面自身的文案，所以中英两份）；顺序就是调用顺序：上传 → 克隆 → 提交 → 查询 */
const REQ_LABEL: Record<ReqKey, { zh: string; en: string }> = {
  upload: { zh: '上传', en: 'Upload' },
  clone: { zh: '克隆', en: 'Clone' },
  'sync.submit': { zh: '同步 · 提交', en: 'Sync · submit' },
  'async.submit': { zh: '异步 · 提交', en: 'Async · submit' },
  'async.query': { zh: '异步 · 查询', en: 'Async · query' },
};

const VALUE_TYPES: ValueType[] = ['string', 'text', 'number', 'boolean', 'enum', 'multiEnum', 'array', 'secret', 'file', 'json'];

/**
 * 同步 / 异步 两个复选框 ↔ `caps.modes` 三态。
 * 两个都不勾 = 这份模板没有任何接口可配，所以最后一个勾不让掉（不让界面进入那个状态）。
 */
function nextModes(cur: Caps['modes'], which: 'sync' | 'async', on: boolean): Caps['modes'] {
  const has = { sync: cur !== 'async', async: cur !== 'sync' };
  if (!on && !has[which === 'sync' ? 'async' : 'sync']) return cur;
  const next = { ...has, [which]: on };
  return next.sync && next.async ? 'both' : next.async ? 'async' : 'sync';
}

/** 产物以什么形式给 —— 整份模板问一次，同步与异步共用；下载没有接口，按这一档直接生成 */
const ARTIFACT_OPTIONS = (t: (a: string, b: string) => string) => [
  { value: 'binary' as const, label: 'bin', hint: t('图片和音频直接在响应体里，不用从字段中取', 'the response body is the artifact') },
  { value: 'base64' as const, label: 'base64', hint: t('字节以 base64 写在某个字段里', 'bytes as base64 in a field') },
  { value: 'hex' as const, label: 'hex', hint: t('字节以十六进制写在某个字段里', 'bytes as hex in a field') },
  { value: 'url' as const, label: 'url', hint: t('响应给一个链接，当场下载成字节（没有单独的下载接口）', 'a URL, downloaded on the spot — there is no download endpoint') },
];

const present = (t: TemplateDef, key: ReqKey) => !!requestOf(t, key);

/** 改能力开关 → 该出现的槽自动补一份空白 */
function withCaps(tpl: TemplateDef, caps: Caps): TemplateDef {
  const next: TemplateDef = { ...tpl, caps };
  for (const key of slotsOf(next)) {
    if (present(next, key)) continue;
    const blank = blankRequest(key);
    if (key === 'sync.submit') next.sync = { ...next.sync, submit: blank };
    else if (key === 'async.submit') next.async = { ...next.async, submit: blank };
    else if (key === 'async.query') next.async = { ...next.async, query: blank };
    else next[key] = blank;
  }
  return next;
}

/** 新建一格时给的头：认证头是每条都要的，Content-Type 只有带 JSON 体的那条要 */
const AUTH_HDR = { Authorization: 'Bearer ${apiKey}' };
const blankRequest = (key: ReqKey): RequestDef => {
  if (key === 'async.query') {
    return { path: '${baseUrl}/tasks/${taskId}', method: 'GET', headers: { ...AUTH_HDR }, body: {}, outputs: { status: 'status' }, successValues: ['SUCCEEDED'], failureValues: ['FAILED'] };
  }
  // 上传那一格发的是 multipart 表单，不是 JSON 体：入参只有一个文件，随附字段写在表单里
  if (key === 'upload') {
    return {
      path: '${baseUrl}/files', method: 'POST', headers: { ...AUTH_HDR }, requestParams: [],
      callParams: [{ key: 'audioFile', label: '要上传的音频', valueType: 'file', accept: '.mp3,.wav,.m4a', maxSize: 10485760 }],
      form: { file: '${audioFile}', purpose: 'voice_clone' }, outputs: {},
    };
  }
  return { path: '${baseUrl}/', method: 'POST', headers: { 'Content-Type': 'application/json', ...AUTH_HDR }, requestParams: [], callParams: [{ key: 'text', label: '文本', valueType: 'text' }], body: { model: '${model}' }, outputs: {} };
};

/** 移除一格（同步 / 异步的提交与查询是同一行里的键，删干净要连父对象一起处理） */
function dropSlotOf(tpl: TemplateDef, key: ReqKey): TemplateDef {
  const next: TemplateDef = { ...tpl };
  if (key === 'sync.submit') next.sync = { ...next.sync, submit: undefined };
  else if (key === 'async.submit') next.async = { ...next.async, submit: undefined };
  else if (key === 'async.query') next.async = { ...next.async, query: undefined };
  else next[key as 'upload' | 'clone'] = undefined;
  return next;
}

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
  /** 两套都勾了才用得上：页签只看这一侧 */
  const [view, setView] = useState<'sync' | 'async'>('sync');

  const mine = useMemo(() => templates.filter((x) => x.category === category), [templates, category]);
  const tpl = mine.find((x) => x.id === selId) ?? mine[0];
  const slots = useMemo(() => (tpl ? slotsOf(tpl) : []), [tpl]);
  // 开关是数据改出来的（别的机器改过、恢复默认之前），这一格可能还在：让它进得去，别报一条没法执行的错
  const orphans = tpl ? REQ_KEYS.filter((k) => !slots.includes(k) && present(tpl, k)) : [];
  const both = tpl?.caps.modes === 'both';
  const all = [...slots, ...orphans];
  const tabs = REQ_KEYS.filter((k) => all.includes(k) && !hiddenByView(k));
  /** 只勾一种时没有「藏起来」这回事；两套都勾了才按下拉的选择只看一侧 */
  function hiddenByView(k: ReqKey) {
    if (!both) return false;
    return view === 'sync' ? k.startsWith('async.') : k === 'sync.submit';
  }
  const curReq = tabs.includes(selReq) ? selReq : tabs[0];
  useEffect(() => { if (tpl && tpl.id !== selId) setSelId(tpl.id); }, [tpl, selId]);
  useEffect(() => {
    if (tpl && !present(tpl, selReq)) setSelReq(tabs[0] ?? 'sync.submit');
  }, [tpl, selReq, tabs.join(',')]);

  const patch = (next: TemplateDef) => { if (next.id) saveTemplate(next); };
  /**
   * 改能力开关。关掉之后不再被调用的那一格**当场问一次、确定就移除** ——
   * 而不是留着它、回头在页签上挂一条消不掉的报错。取消 = 开关不动。
   */
  const setCaps = async (next: Caps) => {
    if (!tpl) return;
    const after = withCaps(tpl, next);
    const dropped = REQ_KEYS.filter((k) => present(tpl, k) && !slotsOf(after).includes(k));
    if (!dropped.length) { patch(after); return; }
    const names = dropped.map((k) => `「${t(REQ_LABEL[k].zh, REQ_LABEL[k].en)}」`).join('、');
    const ok = await confirm({
      message: t(`关掉之后${names}不再被调用，一起移除吗？填过的内容会删掉。`,
        `These endpoints are no longer called — remove them? Their content goes too.`),
      confirmText: t('移除', 'Remove'), danger: true,
    });
    if (!ok) return;
    let cut = after;
    for (const k of dropped) cut = dropSlotOf(cut, k);
    patch(cut);
  };
  const toggleMode = (which: 'sync' | 'async', on: boolean) => {
    if (!tpl) return;
    const modes = nextModes(tpl.caps.modes, which, on);
    if (modes !== tpl.caps.modes) void setCaps({ ...tpl.caps, modes });
  };
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
      </div>

      <Tabs value={category} onValueChange={(k) => { setCategory(k as Category); setSelId(''); }} className="shrink-0">
        <TabsList className="h-8">
          {(Object.keys(CATEGORY_LABEL) as Category[]).map((k) => (
            <TabsTrigger key={k} value={k} className="text-[11px]">{t(CATEGORY_LABEL[k].zh, CATEGORY_LABEL[k].en)}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="grid min-h-0 flex-1 grid-cols-[150px_minmax(0,1fr)] gap-3 xl:grid-cols-[150px_minmax(0,1fr)_340px]">
        {/* 左：这一类的模板列表 */}
        <div className="min-h-0 space-y-1 overflow-y-auto pr-0.5">
          {mine.map((x) => (
            <button key={x.id} onClick={() => setSelId(x.id)}
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
            {/* 主键不显示也不给改：新建时由 store 生成（custom-<类>-<随机串>），列表与标题只认 name */}
            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5">
              <Input value={tpl.name} onChange={(e) => patch({ ...tpl, name: e.target.value })} className="h-7 text-xs" placeholder={t('模板名', 'Name')} />
              <div className="flex items-center gap-1.5">
                <Button variant="outline" size="sm" className="h-7 text-[11px]" disabled={!seedTemplate(tpl.id)}
                  onClick={() => restoreTemplate(tpl.id)} title={t('丢弃本地改动，取回内置默认形状', 'Restore the built-in shape')}>
                  {t('恢复默认', 'Restore')}
                </Button>
                <Button variant="outline" size="sm" className="h-7 text-[11px] text-red-400/90" onClick={() => void drop()}>{t('删除', 'Delete')}</Button>
              </div>
            </div>

            {/* 能力开关：文案生成只取一段文本，这几问都用不上，整块不显示 */}
            {tpl.category !== 'llm' && (
              <>
                <Separator />
                <div className="space-y-2 text-[11px]">
                  <div className="grid grid-cols-[86px_minmax(0,1fr)] items-center gap-x-3">
                    <Label className="text-right text-[10px] font-normal text-muted-foreground">{t('调用方式', 'Call mode')}</Label>
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
                      {([['sync', t('同步', 'Sync')], ['async', t('异步', 'Async')]] as const).map(([k, label]) => (
                        <label key={k} className="flex items-center gap-2">
                          <Checkbox id={`tpl-mode-${k}`}
                            checked={k === 'sync' ? tpl.caps.modes !== 'async' : tpl.caps.modes !== 'sync'}
                            onCheckedChange={(on) => toggleMode(k, !!on)} />
                          <Label htmlFor={`tpl-mode-${k}`} className="text-[11px] font-normal">{label}</Label>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-[86px_minmax(0,1fr)] items-center gap-x-3">
                    <Label className="text-right text-[10px] font-normal text-muted-foreground">{t('产物形式', 'Artifact')}</Label>
                    <div className="flex items-center gap-1.5">
                      <OptionBlocks<ArtifactEncoding> value={tpl.caps.artifact}
                        options={ARTIFACT_OPTIONS(t).map((o) => ({ value: o.value, label: o.label }))}
                        onChange={(artifact) => void setCaps({ ...tpl.caps, artifact })} />
                      <InfoHint text={ARTIFACT_OPTIONS(t).find((o) => o.value === tpl.caps.artifact)?.hint} />
                    </div>
                  </div>
                  {tpl.category === 'tts' && (
                    <div className="grid grid-cols-[86px_minmax(0,1fr)] items-center gap-x-3">
                      <Label className="text-right text-[10px] font-normal text-muted-foreground">{t('建音色', 'Voice clone')}</Label>
                      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
                        <label className="flex items-center gap-2">
                          <Switch id="tpl-clone" checked={!!tpl.caps.clone}
                            onCheckedChange={(clone) => void setCaps({ ...tpl.caps, clone, uploadFirst: clone ? tpl.caps.uploadFirst : undefined })} />
                          <Label htmlFor="tpl-clone" className="text-[11px] font-normal">{t('克隆', 'Clone')}</Label>
                        </label>
                        {tpl.caps.clone && (
                          <>
                            <label className="flex items-center gap-2">
                              <Switch id="tpl-upload" checked={!!tpl.caps.uploadFirst}
                                onCheckedChange={(uploadFirst) => void setCaps({ ...tpl.caps, uploadFirst })} />
                              <Label htmlFor="tpl-upload" className="text-[11px] font-normal">{t('上传', 'Upload')}</Label>
                            </label>
                            <label className="flex items-center gap-1.5">
                              <span className="text-[10px] text-muted-foreground">{t('参考音频采样率', 'ref rate')}</span>
                              <Input type="number" value={tpl.refSampleRateHz ?? ''} className="h-6 w-24 text-[10px]"
                                onChange={(e) => patch({ ...tpl, refSampleRateHz: e.target.value ? Number(e.target.value) : undefined })} />
                            </label>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}

            <Separator />

            {/* 页签 = 开关推出来的那几格，按调用顺序排；两套都勾了才给这一排最右边一个「同步 | 异步」切换 */}
            <Tabs value={curReq} onValueChange={(k) => setSelReq(k as ReqKey)} className="w-full">
              <div className="flex items-center gap-2">
                <TabsList className="h-8 flex-wrap">
                  {tabs.map((k) => (
                    <TabsTrigger key={k} value={k} className="text-[11px]">{t(REQ_LABEL[k].zh, REQ_LABEL[k].en)}</TabsTrigger>
                  ))}
                </TabsList>
                {both && (
                  <div className="ml-auto shrink-0">
                    <OptionBlocks<'sync' | 'async'> value={view}
                      options={[{ value: 'sync', label: t('同步', 'Sync') }, { value: 'async', label: t('异步', 'Async') }]}
                      onChange={setView} />
                  </div>
                )}
              </div>
              {curReq && present(tpl, curReq) && (
                <div className="mt-2">
                  <RequestEditor tpl={tpl} reqKey={curReq} onChange={patch} />
                </div>
              )}
            </Tabs>

            <ProblemList problems={problems} />
          </div>
        )}

        {/* 右：实例级参数（整份模板共用）。窄屏时换到第二行整宽显示，别「藏起来就摸不到」 */}
        {tpl && (
          <div className="col-span-2 min-h-0 min-w-0 overflow-y-auto border-t border-white/10 pt-2 xl:col-span-1 xl:border-l xl:border-t-0 xl:pl-3 xl:pt-0">
            <ParamTable title={t('实例级参数', 'Instance params')}
              hint={t('整份模板共用；Base URL 与密钥就在这儿声明，声明成 secret 的渲染成密码框。', 'shared by every request; declare baseUrl and keys here')}
              params={tpl.instanceParams ?? []} onChange={(instanceParams) => patch({ ...tpl, instanceParams })} />
          </div>
        )}
      </div>
    </div>
  );
}

// ========== 选中请求 ==========

function RequestEditor({ tpl, reqKey, onChange }: {
  tpl: TemplateDef; reqKey: ReqKey; onChange: (t: TemplateDef) => void;
}) {
  const t = useT();
  const def = requestOf(tpl, reqKey)!;
  const set = (p: Partial<RequestDef>) => {
    const merged = { ...def, ...p };
    const next: TemplateDef = { ...tpl };
    if (reqKey === 'sync.submit') next.sync = { submit: merged };
    else if (reqKey === 'async.submit') next.async = { submit: merged, query: next.async?.query };
    else if (reqKey === 'async.query') next.async = { submit: next.async?.submit, query: merged };
    else next[reqKey as 'upload' | 'clone'] = merged;
    onChange(next);
  };
  const [showVars, setShowVars] = useState(false);
  /** 固定项之外的 outputs 就是自定义变量（引擎不读它们） */
  const fixedNames = new Set(requiredOutputsOf(tpl, reqKey).map((o) => o.name));
  const custom = Object.entries(def.outputs ?? {}).filter(([k]) => !fixedNames.has(k));
  const isUpload = reqKey === 'upload';

  return (
    <Card className="gap-0 p-0">
      <CardHeader className="px-2 py-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-[11px] font-medium text-muted-foreground">
          <Select value={def.method ?? 'POST'} onValueChange={(method) => set({ method })}>
            <SelectTrigger className="h-7 w-[70px] text-[11px]"><SelectValue /></SelectTrigger>
            <SelectContent>{['GET', 'POST', 'PUT'].map((m) => <SelectItem key={m} value={m} className="text-[11px]">{m}</SelectItem>)}</SelectContent>
          </Select>
          <Input value={def.path} onChange={(e) => set({ path: e.target.value })} className="h-7 min-w-40 flex-1 text-xs font-mono" placeholder="${baseUrl}/…" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 p-2 pt-0">

        {/* 顺序照发出去的样子排：先这条请求自己的头与体，再声明它引用了哪些参数 */}
        <Group title={t('发出去的内容', 'Payload')}>
          <JsonBox label="Headers" rows={3} value={def.headers ?? {}}
            hint={isUpload
              ? t('认证头写在这儿。multipart 的 Content-Type 由传输层生成，不用写。', 'auth headers; the multipart Content-Type comes from the transport')
              : t('这一条自己的头。${apiKey} 会换成实例里填的那把 Key。', "this endpoint's own headers; ${apiKey} comes from the instance")}
            onChange={(headers) => set({ headers: headers as Record<string, unknown> })} />
          {isUpload ? (
            <JsonBox label={t('表单（multipart 字段）', 'Form')} value={def.form ?? {}}
              hint={t('例 { "file": "${audioFile}", "purpose": "voice_clone" }', 'e.g. { "file": "${audioFile}", "purpose": "voice_clone" }')}
              onChange={(form) => set({ form: form as Record<string, unknown> })} />
          ) : (
            <JsonBox label="Body" value={def.body ?? {}} onChange={(body) => set({ body })} />
          )}
        </Group>

        {/* 上传那一格的入参与别的接口不同：只有一个要传的文件，model / size 那类请求级参数对它没意义 */}
        <Group title={t('要填的参数', 'Parameters')}>
          {isUpload ? (
            <ParamTable variant="flush" title={t('要传的文件', 'File to upload')}
              hint={t('引用写 ${它的名字}：进 multipart 表单就是那个二进制分片（自带 mime 与文件名），进 JSON 体就是 data:<mime>;base64,…；单取格式写 ${它的名字.mime}。',
                'reference it as ${name}: a binary part in the form, a data: URI in a JSON body; ${name.mime} for the type alone')}
              params={def.callParams ?? []} onChange={(callParams) => set({ callParams })} />
          ) : (
            <>
              <ParamTable variant="framed" title={t('请求级参数', 'Request params')}
                hint={t('这一格专属，取值存在实例里；同名参数在别的格可以取不同值（比如同步与异步的 model 不同）。', 'specific to this endpoint; the same name may hold a different value elsewhere')}
                params={def.requestParams ?? []} onChange={(requestParams) => set({ requestParams })} />
              <ParamTable variant="flush" title={t('调用级参数', 'Call params')}
                hint={t('每次调用现场给（正文文本、画面描述、文件），不落库；调用页与「试调用」按这些长输入框。', 'given per call; the call UI and 试调用 build inputs from these')}
                params={def.callParams ?? []} onChange={(callParams) => set({ callParams })} />
            </>
          )}
        </Group>

        {/* 引擎要读的返回项：名字写死（写错就没有消费者），只能填路径 */}
        <Group title={t('从响应里取', 'Read from response')}
          hint={t('左列名字由引擎写死，只能填路径；剩下的写在折叠的「给下一个请求用的变量」里。', 'names are fixed by the engine — fill the path only')}>
          <div className="space-y-1">
            {requiredOutputsOf(tpl, reqKey).map((o) => {
              const filled = !!def.outputs?.[o.name]?.trim();
              return (
                <div key={o.name} className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-x-2">
                  <Label className="pt-1.5 text-right text-[10px] font-normal text-muted-foreground" title={o.name}>
                    {o.label}{o.required && !filled && <span className="text-red-400"> *</span>}
                  </Label>
                  <div className="min-w-0">
                    <Input value={def.outputs?.[o.name] ?? ''} className="h-7 text-[11px] font-mono"
                      placeholder={o.name === 'status' ? 'output.task_status' : o.name === ARTIFACT_KEY ? 'output.choices[0].message.content[0].image' : 'error.message'}
                      onChange={(e) => set({ outputs: { ...mapOf(def), [o.name]: e.target.value } })} />
                  </div>
                </div>
              );
            })}
            {/* 剩下的就是自定义变量：引擎不认，只给下一个请求的 ${它} 用 */}
            <div className="flex items-center gap-1.5">
              <button type="button" className="text-[10px] text-muted-foreground/80 underline-offset-2 hover:underline"
                onClick={() => setShowVars((v) => !v)}>
                {showVars ? '▾' : '▸'} {t(`给下一个请求用的变量（${custom.length}）`, `Variables for the next request (${custom.length})`)}
              </button>
              <InfoHint text={t('引擎不读这些名字，它们只用于在别的请求里写 ${这个名字}。', 'The engine never reads these; they exist to be referenced as ${name} elsewhere.')} />
            </div>
            {showVars && (
              <div className="space-y-1">
                {custom.map(([k, v]) => (
                  <div key={k} className="flex min-w-0 items-center gap-1">
                    <Input value={k} className="h-6 w-28 min-w-0 text-[10px] font-mono" placeholder="requestId"
                      onChange={(e) => set({ outputs: rename(mapOf(def), k, e.target.value) })} />
                    <Input value={String(v)} className="h-6 min-w-0 flex-1 text-[10px] font-mono" placeholder="output.request_id"
                      onChange={(e) => set({ outputs: { ...mapOf(def), [k]: e.target.value } })} />
                    <Button variant="ghost" size="sm" className="h-6 w-6 text-[10px]"
                      onClick={() => { const n = { ...mapOf(def) }; delete n[k]; set({ outputs: n }); }}>✕</Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => set({ outputs: { ...mapOf(def), '': '' } })}>
                  ＋ {t('变量', 'variable')}
                </Button>
              </div>
            )}
            {/* 查询这一格判的就是上面取到的 status，所以并在这里，不再单开一节 */}
            {reqKey === 'async.query' && (
              <div className="mt-1.5 space-y-1.5">
                <ListField label={t('算成功的状态值', 'successValues')} value={def.successValues ?? []} onChange={(successValues) => set({ successValues })}
                  hint={t('取到的 status 等于其中任一个 = 查完了，去拿产物。', 'any match means the job is done')} />
                <ListField label={t('算失败的状态值', 'failureValues')} value={def.failureValues ?? []} onChange={(failureValues) => set({ failureValues })}
                  hint={t('两个列表都没命中就继续查，所以中间态不用配。', 'anything unlisted keeps polling')} />
              </div>
            )}
          </div>
        </Group>

      </CardContent>
    </Card>
  );
}

const mapOf = (def: RequestDef) => def.outputs ?? {};
const rename = (map: Record<string, string>, from: string, to: string) => {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) next[k === from ? to : k] = v;
  return next;
};

// ========== 参数表：三层 ==========
// 分层不用颜色（三块各涂一种色，看着像三套不同的东西，其实同一套行的三种归属）。
// 区分靠**装不装框**：会留在库里的（实例级 / 请求级）每行一个框；每次调用现场给的（调用级）不装框，
// 整组缩在一道竖线后面 —— 一眼就是「这里是临时值」。

function ParamTable({ title, hint, variant = 'framed', params, onChange }: {
  title: string; hint?: string; variant?: 'framed' | 'flush'; params: ParamSpec[]; onChange: (p: ParamSpec[]) => void;
}) {
  const t = useT();
  const at = (i: number, p: Partial<ParamSpec>) => onChange(params.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const optsText = (p: ParamSpec) => (p.options ?? []).map((o) => (typeof o === 'object' && o !== null ? `${o.value}${o.label ? `=${o.label}` : ''}` : String(o))).join(', ');
  const row = (p: ParamSpec, i: number) => (
    <div key={i} className={`min-w-0 space-y-1 ${variant === 'framed' ? 'rounded-md border border-white/10 bg-white/[0.02] p-1.5' : 'py-1.5'}`}>
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_86px_22px] items-center gap-1">
        <Input value={p.key} onChange={(e) => at(i, { key: e.target.value })} className="h-6 min-w-0 text-[10px] font-mono" placeholder="key" />
        <Select value={p.valueType ?? 'string'} onValueChange={(v) => at(i, { valueType: v as ValueType })}>
          <SelectTrigger className="h-6 min-w-0 text-[10px]"><SelectValue /></SelectTrigger>
          <SelectContent>{VALUE_TYPES.map((v) => <SelectItem key={v} value={v} className="text-[10px]">{v}</SelectItem>)}</SelectContent>
        </Select>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-[10px]" onClick={() => onChange(params.filter((_, j) => j !== i))}>✕</Button>
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-1">
        <Input value={p.label ?? ''} onChange={(e) => at(i, { label: e.target.value })} className="h-6 min-w-0 text-[10px]" placeholder={t('说明', 'label')} />
        <Input value={String(p.defaultValue ?? '')} onChange={(e) => at(i, { defaultValue: e.target.value })} className="h-6 min-w-0 text-[10px]" placeholder={t('默认值', 'default')} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {(p.valueType === 'enum' || p.valueType === 'multiEnum' || p.valueType === 'array') && (
          <Input value={optsText(p)} onChange={(e) => at(i, { options: parseList(e.target.value) })} className="h-6 min-w-0 flex-1 basis-32 text-[10px] font-mono"
            placeholder={t('候选值：mp3, wav 或 16000=16k', 'options: mp3, wav or 16000=16k')} />
        )}
        {p.valueType === 'number' && (
          <div className="grid min-w-0 flex-1 basis-32 grid-cols-3 gap-1">
            <Input type="number" value={p.min ?? ''} onChange={(e) => at(i, { min: num(e.target.value) })} className="h-6 min-w-0 text-[10px]" placeholder="min" />
            <Input type="number" value={p.max ?? ''} onChange={(e) => at(i, { max: num(e.target.value) })} className="h-6 min-w-0 text-[10px]" placeholder="max" />
            <Input type="number" step="0.1" value={p.step ?? ''} onChange={(e) => at(i, { step: num(e.target.value) })} className="h-6 min-w-0 text-[10px]" placeholder="step" />
          </div>
        )}
        {p.valueType === 'file' && (
          <>
            <Input value={p.accept ?? ''} onChange={(e) => at(i, { accept: e.target.value })} className="h-6 min-w-0 flex-1 basis-20 text-[10px] font-mono" placeholder=".mp3,.wav" />
            <Input type="number" value={p.maxSize ?? ''} onChange={(e) => at(i, { maxSize: num(e.target.value) })} className="h-6 w-20 min-w-0 text-[10px]" placeholder={t('上限字节', 'maxSize')} />
          </>
        )}
      </div>
    </div>
  );
  const add = (
    <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => onChange([...params, { key: '', label: '', valueType: 'string' }])}>
      ＋ {t('参数', 'param')}
    </Button>
  );
  return (
    <div className="space-y-1">
      {/* 小标题 + 一条延伸到右边界细线：线把这一组的范围画出来，比色块安静 */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-medium text-foreground/85">{title}</span>
        <InfoHint text={hint} />
        <span className="h-px min-w-4 flex-1 bg-white/10" />
      </div>
      {variant === 'framed'
        ? <div className="space-y-1">{params.map(row)}{add}</div>
        : <div className="border-l border-white/15 pl-2">{params.map(row)}{add}</div>}
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

/** 小节名旁边那枚 ⓘ：说明收在弹层里，页面不铺长句 */
function InfoHint({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="shrink-0 rounded-full text-muted-foreground/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <Info size={11} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-64 rounded-md border-white/15 bg-card p-2 text-[10px] leading-4 text-muted-foreground">
        {text}
      </PopoverContent>
    </Popover>
  );
}

/** 一小节：分隔线 + 小节名（+ ⓘ） */
function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Separator />
      <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
        {title}<InfoHint text={hint} />
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function JsonBox({ label, value, onChange, hint, rows = 3 }: { label: string; value: unknown; onChange: (v: unknown) => void; hint?: string; rows?: number }) {
  const t = useT();
  const id = useId();
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 1));
  const [bad, setBad] = useState(false);
  const commit = (next: string) => {
    setText(next);
    try { onChange(JSON.parse(next || '{}')); setBad(false); } catch { setBad(true); }
  };
  /**
   * 换到别的一格时这份文本必须跟着换：切页签不会重挂载这个框（同一位置的同种组件），
   * 于是上一格的 JSON 会留在框里 —— 看着像内容，落库就写进另一格了。
   */
  useEffect(() => {
    try { if (JSON.stringify(JSON.parse(text || 'null')) === JSON.stringify(value ?? null)) return; } catch { return; }
    setText(JSON.stringify(value ?? {}, null, 1)); setBad(false);
  }, [value]);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <Label htmlFor={id} className="text-[10px] font-normal text-muted-foreground">{label}</Label>
        <InfoHint text={hint ?? t('JSON，值里可写 ${key}。', 'JSON; ${key} references a param.')} />
        {bad && <span className="text-[10px] text-red-400">{t('还不成形，暂不应用', 'not valid yet')}</span>}
      </div>
      <Textarea id={id} value={text} onChange={(e) => commit(e.target.value)} rows={rows} className={`min-h-0 text-[10px] font-mono ${bad ? 'border-red-400/60' : ''}`} />
    </div>
  );
}

function ListField({ label, value, hint, onChange }: { label: string; value: string[]; hint?: string; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
      <span className="flex w-28 shrink-0 items-center gap-1 text-muted-foreground">{label}<InfoHint text={hint} /></span>
      <Input value={value.join(', ')} className="h-6 min-w-40 flex-1 text-[10px] font-mono"
        onChange={(e) => onChange(e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean))} />
    </div>
  );
}
