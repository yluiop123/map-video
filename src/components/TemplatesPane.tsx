/**
 * TemplatesPane.tsx — ⚙ 设置 · AI 左侧的「接口模板」页（三栏）
 *
 * 一份模板 = 数据库一行，里面同时装着：实例级参数、同步 / 异步两套接口、下载 / 上传桥接、克隆音色。
 * 请求头与参数都挂在各条接口自己身上（同一家不同端点要的头并不相同）；三层参数（实例级 / 请求级 /
 * 调用级）都在这页自由增删改 —— 引擎里没有任何按厂商名写的分支，界面配不出来的东西就不该存在。
 *
 * 「预览请求」零网络（只跑求值 + 密钥打码），「试调用」真发一条。
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { OptionBlocks, ProblemList, useT } from './ui/primitives';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Badge } from './ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Separator } from './ui/separator';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { Textarea } from './ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Switch } from './ui/switch';
import { useConfirm } from './ui/ConfirmHost';
import { useProviderStore } from '../stores/providerStore';
import { seedTemplate } from '../lib/template-seed';
import {
  ARTIFACT_KEY, callKeysOf, paramLabelOf, requestOf, requiredOutputsOf, slotsOf, validateTemplate,
  type ArtifactEncoding, type Caps, type Category, type InstanceDef, type ParamSpec, type ReqKey,
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

/** 接法：这一家有几种交活方式 */
const MODE_OPTIONS = (t: (a: string, b: string) => string) => [
  { value: 'sync' as const, label: t('只要同步', 'Sync') },
  { value: 'async' as const, label: t('只要异步', 'Async') },
  { value: 'both' as const, label: t('两套都有', 'Both') },
];

/** 产物以什么形式给 —— 整份模板问一次，同步与异步共用 */
const ARTIFACT_OPTIONS = (t: (a: string, b: string) => string) => [
  { value: 'binary' as const, label: t('响应体就是', 'Body'), hint: t('图片和音频直接在响应体里，不用从字段中取', 'the response body is the artifact') },
  { value: 'base64' as const, label: 'base64', hint: t('字节以 base64 写在某个字段里', 'bytes as base64 in a field') },
  { value: 'hex' as const, label: 'hex', hint: t('字节以十六进制写在某个字段里', 'bytes as hex in a field') },
  { value: 'url' as const, label: t('下载链接', 'URL'), hint: t('响应给一个带时效的链接，当场下载下来', 'a time-limited URL, downloaded on the spot') },
  { value: 'viaDownload' as const, label: t('链接要再问一次', 'URL via bridge'), hint: t('响应先给一个文件号 / 中间量，再问一次才拿到地址', 'ask a second time for the real URL') },
];

const present = (t: TemplateDef, key: ReqKey) => !!requestOf(t, key);

/**
 * 改能力开关 → 该出现的槽自动补一份空白。
 * **不需要的槽留着不删**（校验会点名「开关里不需要这一格」）—— 来回切开关不该把人已填的内容弄丢。
 */
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
  /** 该出现哪些接口槽：能力开关推出来的，不是让人挑的 */
  const slots = useMemo(() => (tpl ? slotsOf(tpl) : []), [tpl]);
  const curReq = slots.includes(selReq) ? selReq : slots[0];
  useEffect(() => { if (tpl && tpl.id !== selId) setSelId(tpl.id); }, [tpl, selId]);
  useEffect(() => {
    if (tpl && !present(tpl, selReq)) setSelReq(slots[0] ?? 'sync.submit');
  }, [tpl, selReq, slots]);

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

            {/* 能力开关：这一家怎么交活。**下面的接口槽与每格必填的返回项全部由它推导**，
                所以问完这几个问题，就不需要「自己加一条接口」了。
                文案生成只取一段文本，产物形式与克隆那几问都不问。 */}
            <Group title={t('这一家怎么交活', 'Capabilities')} hint={t('下面该有哪几格接口、每格必须交出什么，都由这几个答案推出来', 'the endpoints and their required fields below are derived from these')}>
            <div className="space-y-2 text-[11px]">
              {tpl.category !== 'llm' && (
                <div className="grid grid-cols-[86px_minmax(0,1fr)] items-center gap-x-3">
                  <Label className="text-right text-[10px] font-normal text-muted-foreground">{t('接法', 'Modes')}</Label>
                  <OptionBlocks<Caps['modes']> value={tpl.caps.modes} options={MODE_OPTIONS(t)}
                    onChange={(modes) => patch(withCaps(tpl, { ...tpl.caps, modes }))} />
                </div>
              )}
              {tpl.category !== 'llm' && (
                <div className="grid grid-cols-[86px_minmax(0,1fr)] items-start gap-x-3">
                  <Label className="pt-1 text-right text-[10px] font-normal text-muted-foreground">{t('产物形式', 'Artifact')}</Label>
                  <div>
                    <OptionBlocks<ArtifactEncoding> value={tpl.caps.artifact} options={ARTIFACT_OPTIONS(t).map((o) => ({ value: o.value, label: o.label }))}
                      onChange={(artifact) => patch(withCaps(tpl, { ...tpl.caps, artifact }))} />
                    <p className="mt-1 text-[10px] text-muted-foreground/70">
                      {ARTIFACT_OPTIONS(t).find((o) => o.value === tpl.caps.artifact)?.hint}
                    </p>
                  </div>
                </div>
              )}
              {tpl.category === 'tts' && (
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
                  <label className="flex items-center gap-2">
                    <Switch id="tpl-clone" checked={!!tpl.caps.clone}
                      onCheckedChange={(clone) => patch(withCaps(tpl, { ...tpl.caps, clone, uploadFirst: clone ? tpl.caps.uploadFirst : undefined }))} />
                    <Label htmlFor="tpl-clone" className="text-[11px] font-normal">{t('要能建自己的音色', 'voice cloning')}</Label>
                  </label>
                  {tpl.caps.clone && (
                    <>
                      <label className="flex items-center gap-2">
                        <Switch id="tpl-upload" checked={!!tpl.caps.uploadFirst}
                          onCheckedChange={(uploadFirst) => patch(withCaps(tpl, { ...tpl.caps, uploadFirst }))} />
                        <Label htmlFor="tpl-upload" className="text-[11px] font-normal">{t('建音色前要先上传音频文件', 'upload the sample first')}</Label>
                      </label>
                      <label className="flex items-center gap-2">
                        <span className="text-muted-foreground text-[10px]">{t('参考音频采样率', 'ref rate')}</span>
                        <Input type="number" value={tpl.refSampleRateHz ?? ''} className="h-6 w-24 text-[10px]"
                          onChange={(e) => patch({ ...tpl, refSampleRateHz: e.target.value ? Number(e.target.value) : undefined })} />
                      </label>
                    </>
                  )}
                </div>
              )}
            </div>
            </Group>

            {/* 请求头**逐条接口各一份**（在下面的接口卡片里配）：认证头家家不同，
                异步开关头更只有提交那条要 —— 共用一份等于替同步端点也带上它。 */}
            <Separator />

            {/* 槽位 = 上面那几个开关推出来的，不给手动加删 */}
            <Tabs value={curReq} onValueChange={(k) => setSelReq(k as ReqKey)} className="w-full">
              <TabsList className="h-8 flex-wrap">
                {slots.map((k) => (
                  <TabsTrigger key={k} value={k} className="text-[11px]">{t(REQ_LABEL[k].zh, REQ_LABEL[k].en)}</TabsTrigger>
                ))}
              </TabsList>
              {!slots.length && (
                <p className="mt-1.5 text-[10px] text-red-400">{t('上面一个开关都没开，所以没有任何接口可配。', 'No capability is on, so there is nothing to configure.')}</p>
              )}
              {curReq && present(tpl, curReq) && (
                <div className="mt-2">
                  <RequestEditor tpl={tpl} reqKey={curReq} inst={usedBy(tpl.id)[0] ?? null} onChange={patch} />
                </div>
              )}
            </Tabs>

            <ProblemList problems={problems} />
          </div>
        )}

        {/* 右：实例级参数（整份模板共用）。窄屏时不再「藏起来就摸不到」—— 换到第二行整宽显示 */}
        {tpl && (
          <div className="col-span-2 min-h-0 min-w-0 overflow-y-auto border-t border-white/10 pt-2 xl:col-span-1 xl:border-l xl:border-t-0 xl:pl-3 xl:pt-0">
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
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState('');
  const [showVars, setShowVars] = useState(false);
  const callKeys = callKeysOf(tpl, reqKey);
  /** 固定项之外的 outputs 就是自定义变量（引擎不读它们） */
  const fixedNames = new Set(requiredOutputsOf(tpl, reqKey).map((o) => o.name));
  const custom = Object.entries(def.outputs ?? {}).filter(([k]) => !fixedNames.has(k));

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
    <Card className="gap-0 p-0">
      <CardHeader className="px-2 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={def.method ?? 'POST'} onValueChange={(method) => set({ method })}>
            <SelectTrigger className="h-7 w-[70px] text-[11px]"><SelectValue /></SelectTrigger>
            <SelectContent>{['GET', 'POST', 'PUT'].map((m) => <SelectItem key={m} value={m} className="text-[11px]">{m}</SelectItem>)}</SelectContent>
          </Select>
          <Input value={def.path} onChange={(e) => set({ path: e.target.value })} className="h-7 min-w-40 flex-1 text-xs font-mono" placeholder="${baseUrl}/…" />
        </div>
      </CardHeader>
      <CardContent className="space-y-1 p-2 pt-0">

      {/* 上传那一格的入参与别的接口不同：要传的只有一个**文件**（调用时给），
          没有 model / size 这类请求级 JSON 参数 —— 那些字段是 multipart 表单的一部分，在下一节里写。 */}
      <Group title={reqKey === 'upload' ? t('要上传的文件', 'File to upload') : t('要填的参数', 'Parameters')}
        hint={reqKey === 'upload'
          ? t('只有这一格是文件：随文件一起发的字段在下面「发出去的内容」里写', 'the only input is the file; the companion fields live in the payload below')
          : t('请求级存进实例的「按请求」那一区；调用级不落库，每次现场给', 'request params persist per request on the instance; call params never do')}>
        {reqKey === 'upload' ? (
          <ParamTable title={t('要传的文件（调用时给）', 'File param')}
            hint={t('表单里用 ${它的名字} 引用；格式与体积上限就在这儿声明', 'reference it from the form as ${name}')}
            params={def.callParams ?? []} onChange={(callParams) => set({ callParams })} />
        ) : (
          <>
            <ParamTable title={t('请求级参数（这个请求专属）', 'Request params')}
              hint={t('同名参数在不同请求可取不同值', 'same name, different value per request')}
              params={def.requestParams ?? []} onChange={(requestParams) => set({ requestParams })} />
            <ParamTable title={t('调用级参数（每次调用现场给）', 'Call params')}
              hint={t('调用页与「试调用」按这些长输入框', 'the call UI and 试调用 build inputs from these')}
              params={def.callParams ?? []} onChange={(callParams) => set({ callParams })} />
          </>
        )}
      </Group>

      <Group title={reqKey === 'upload' ? t('上传时发出去的内容', 'Upload payload') : t('发出去的内容', 'Request body')}
        hint={reqKey === 'upload'
          ? t('一层键值：值是 ${某参数} 时，字符串当普通字段、文件当二进制分片', 'flat fields; a ${param} holding a file becomes the binary part')
          : t('值里写 ${key} 从上面的参数表取值；没给值的键会整个删掉', 'use ${key}; unset keys are dropped')}>
        {reqKey === 'upload' ? (
          <JsonBox label={t('上传表单（multipart 字段）', 'Upload form')} value={def.form ?? {}} onChange={(form) => set({ form: form as Record<string, unknown> })}
            hint={t('例 { "file": "${audioFile}", "purpose": "voice_clone" }', 'e.g. { "file": "${audioFile}", "purpose": "voice_clone" }')} />
        ) : (
          <JsonBox label="Body" value={def.body ?? {}} onChange={(body) => set({ body })} />
        )}
        {/* 请求头逐条各一份：同一家不同端点要的头并不相同（异步开关头只有提交那条该带） */}
        <JsonBox label="Headers" rows={3} value={def.headers ?? {}}
          hint={reqKey === 'upload'
            ? t('认证头写在这儿；multipart 的 Content-Type 由传输层生成，不用写', "auth headers; the multipart Content-Type comes from the transport")
            : t('这一条自己的头，${apiKey} 会换成实例里填的 Key', "this request's own headers; ${apiKey} comes from the instance")}
          onChange={(headers) => set({ headers: headers as Record<string, unknown> })} />
      </Group>

      {/* 引擎要读的返回项：名字写死（写错就没有消费者），只能填路径 */}
      <Group title={t('从响应里取', 'Read from response')} hint={t('左列名字由引擎写死，只能填路径', 'names are fixed by the engine; fill the path only')}>
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
                <p className="mt-0.5 text-[9px] text-muted-foreground/60">{t(o.hint, o.hint)}</p>
              </div>
            </div>
          );
        })}
        {/* 剩下的就是自定义变量：引擎不认，只给下一个请求的 ${它} 用 */}
        <button type="button" className="text-[10px] text-muted-foreground/80 underline-offset-2 hover:underline"
          onClick={() => setShowVars((v) => !v)}>
          {showVars ? '▾' : '▸'} {t(`给下一个请求用的变量（${custom.length}）`, `Variables for the next request (${custom.length})`)}
        </button>
        {showVars && (
          <div className="space-y-1">
            <p className="text-[9px] text-muted-foreground/60">
              {t('引擎不认这些名字，它们只用于在别的请求里写 ${这个名字}。', 'The engine never reads these; they exist to be referenced as ${name} elsewhere.')}
            </p>
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
        {/* 查询这一格：取到的 status 等于哪些词算查完 —— 判的就是上面那个字段，所以并在这里，
            不再单开一节（超时只有实例级那一份，槽上那一格没有生产者，已删） */}
        {reqKey === 'async.query' && (
          <div className="mt-1.5 space-y-1.5">
            <ListField label={t('算成功的状态值', 'successValues')} value={def.successValues ?? []} onChange={(successValues) => set({ successValues })} />
            <ListField label={t('算失败的状态值', 'failureValues')} value={def.failureValues ?? []} onChange={(failureValues) => set({ failureValues })} />
            <p className="text-[10px] text-muted-foreground/70">{t('中间态不用配：两个列表都没命中就继续查。', 'Anything unlisted keeps polling.')}</p>
          </div>
        )}
      </div>
      </Group>

      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        {callKeys.map((k) => (
          <label key={k} className="flex items-center gap-1 text-[10px]">
            {/* 显示声明的显示名，裸 key 只作 title —— 界面上一排英文变量名没人看得懂 */}
            <span className="text-muted-foreground" title={k}>{paramLabelOf(tpl, reqKey, k)}</span>
            <Input value={inputs[k] ?? SAMPLE_CALL_ARGS[k] ?? ''} className="h-6 w-28 text-[11px]" onChange={(e) => setInputs((s) => ({ ...s, [k]: e.target.value }))} />
          </label>
        ))}
        <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={doPreview}>🔍 {t('预览请求', 'Preview')}</Button>
        <span className="text-[10px] text-muted-foreground/60">
          {t('只算不发；真发一条去「实例设置」页的试调用', 'no bytes sent; real calls live on the instance page')}
        </span>
      </div>
      {preview && (
        <pre className="max-h-40 overflow-auto rounded-md border border-white/10 bg-black/40 p-2 text-[10px] whitespace-pre-wrap break-all">{preview}</pre>
      )}
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
// ========== 三层参数共用的编辑器 ==========

function ParamTable({ title, hint, params, onChange }: {
  title: string; hint?: string; params: ParamSpec[]; onChange: (p: ParamSpec[]) => void;
}) {
  const t = useT();
  const at = (i: number, p: Partial<ParamSpec>) => onChange(params.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const optsText = (p: ParamSpec) => (p.options ?? []).map((o) => (typeof o === 'object' && o !== null ? `${o.value}${o.label ? `=${o.label}` : ''}` : String(o))).join(', ');
  return (
    <Card className="gap-0 bg-transparent p-0">
      <CardHeader className="px-0 py-0 space-y-0">
        <CardTitle className="text-[10px] font-medium text-muted-foreground">{title}</CardTitle>
        {!!hint && <CardDescription className="text-[10px] leading-4">{hint}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-1 p-0 pt-1.5">
        {params.map((p, i) => (
          <div key={i} className="min-w-0 space-y-1 rounded-md border border-white/10 bg-white/[0.02] p-1.5">
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
        ))}
        <Button variant="outline" size="sm" className="h-6 text-[10px]" onClick={() => onChange([...params, { key: '', label: '', valueType: 'string' }])}>
          ＋ {t('参数', 'param')}
        </Button>
      </CardContent>
    </Card>
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

/** 一小节：分隔线 + 小标题（+ 一句什么时候用得上）。中栏与卡片内部都用它，别让一堆框平铺着没层次 */
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

function JsonBox({ label, value, onChange, hint, rows = 3 }: { label: string; value: unknown; onChange: (v: unknown) => void; hint?: string; rows?: number }) {
  const t = useT();
  const id = useId();
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 1));
  const [bad, setBad] = useState(false);
  const commit = (next: string) => {
    setText(next);
    try { onChange(JSON.parse(next || '{}')); setBad(false); } catch { setBad(true); }
  };
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="block text-[10px] font-normal text-muted-foreground">
        {label} · {hint ?? t('JSON', 'JSON')}{bad && <span className="text-red-400"> · {t('还不成形，暂不应用', 'not valid yet')}</span>}
      </Label>
      <Textarea id={id} value={text} onChange={(e) => commit(e.target.value)} rows={rows} className={`min-h-0 text-[10px] font-mono ${bad ? 'border-red-400/60' : ''}`} />
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
