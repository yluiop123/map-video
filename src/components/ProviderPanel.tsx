/**
 * ProviderPanel.tsx — ⚙ 设置 · AI 的「实例设置」页
 *
 * 一个能力一屏，里面是**这个能力的实例列表** + 选中实例的表单：
 * 名称、用哪份模板、同步还是异步、模板声明的实例级参数（含 Base URL 与密钥），
 * 以及按请求分区的请求级参数（同步与异步的 model 可以不一样）。
 * 「怎么发请求」不在这页 —— 那是左侧单独的「接口模板」入口（TemplatesPane）。
 */
import { useEffect } from 'react';
import { OptionBlocks, useT } from './ui/primitives';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Button } from './ui/button';
import { useEditorStore } from '../stores/editorStore';
import { useProviderStore } from '../stores/providerStore';
import { REQ_KEYS, requestOf, validateTemplate, type Category, type InstanceDef, type ParamSpec, type ReqKey } from '../lib/request-engine';
import { pickLabel } from '../lib/i18n';
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

  // 一条实例都没有时自动建一条（一个能力一处起点，不必先学"怎么加实例"）
  useEffect(() => { if (!sel && kind) addInstance(kind); }, [sel, kind, addInstance]);

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
    </div>
  );
}

/** 一条实例的表单 */
function InstanceForm({ inst, tplName, missingTpl }: { inst: InstanceDef; tplName: string; missingTpl: boolean }) {
  const t = useT();
  const lang = useEditorStore((s) => (s.lang === 'en' ? 'en' : 'zh'));
  const store = useProviderStore.getState();
  const templates = useProviderStore((s) => s.templates);
  const confirm = useConfirm();
  const tpl = templates.find((x) => x.id === inst.tplId);
  const mine = templates.filter((x) => x.category === (tpl?.category ?? 'llm'));
  const setValues = (patch: Partial<InstanceDef>, values?: Parameters<typeof store.updateInstance>[2]) => store.updateInstance(inst.id, patch, values);
  const problems = tpl ? validateTemplate(tpl) : [`模板「${inst.tplId}」已经不在了`];
  const canPickMode = !!(tpl?.sync?.submit && tpl.async?.submit);

  const drop = async () => {
    const ok = await confirm({ message: t(`删除实例「${inst.name || inst.id}」？密钥与取值一起删。`, 'Delete this instance?'), danger: true });
    if (ok) store.removeInstance(inst.id);
  };

  return (
    <div className="space-y-2 border-t border-white/10 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input value={inst.name} onChange={(e) => setValues({ name: e.target.value })} className="h-7 text-xs w-40" placeholder={t('实例名', 'Name')} />
        <Select value={inst.tplId} onValueChange={(tplId) => setValues({ tplId })}>
          <SelectTrigger className="h-7 flex-1 min-w-40 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{mine.map((x) => <SelectItem key={x.id} value={x.id} className="text-xs">{x.name || x.id}</SelectItem>)}</SelectContent>
        </Select>
        <Button variant="outline" size="sm" className="h-7 text-[11px] text-red-400/90" onClick={() => void drop()}>✕ {t('删除', 'delete')}</Button>
      </div>
      {missingTpl && <p className="text-[10px] text-red-400">{t('这条实例引用的模板已被删除，换一份或去接口模板重建。', 'Its template is gone.')}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] text-muted-foreground">{t('请求方式', 'Mode')}</span>
        <OptionBlocks<string>
          value={inst.sync ? 'sync' : 'async'}
          options={[{ value: 'sync', label: t('同步', 'Sync') }, { value: 'async', label: t('异步任务', 'Async task') }]}
          onChange={(v) => setValues({ sync: v === 'sync' })}
        />
        {!canPickMode && <span className="text-[10px] text-muted-foreground/60">
          {t(`这份模板（${tplName}）只有${inst.sync ? '同步' : '异步'}一种接法`, 'This template only has one mode')}
        </span>}
      </div>

      {!!tpl?.instanceParams?.length && (
        <div className="space-y-1">
          <div className="text-[10px] text-muted-foreground font-medium">{t('实例参数（这份模板声明的，全部请求共用）', 'Instance params')}</div>
          {tpl.instanceParams.map((p) => (
            <ParamControl key={p.key} p={p} value={inst.values.instance?.[p.key]}
              onChange={(v) => setValues({}, { instance: { [p.key]: v } })} />
          ))}
        </div>
      )}

      {tpl && REQ_KEYS.filter((k) => k !== 'async.query' && !!requestOf(tpl, k)?.requestParams?.length).map((k) => (
        <div key={k} className="space-y-1">
          <div className="text-[10px] text-muted-foreground font-medium">
            {t(REQ_TITLE[k].zh, REQ_TITLE[k].en)} · {t('请求参数', 'request params')}
          </div>
          {(requestOf(tpl, k)?.requestParams ?? []).map((p) => (
            <ParamControl key={p.key} p={p} value={inst.values.requests?.[k]?.[p.key]}
              onChange={(v) => setValues({}, { requests: { [k]: { ...(inst.values.requests?.[k] ?? {}), [p.key]: v } } })} />
          ))}
        </div>
      ))}

      {problems.length > 0
        ? <p className="text-[10px] text-red-400 whitespace-pre-line">{problems.join('\n')}</p>
        : <p className="text-[10px] text-muted-foreground">{pickLabel(tpl?.note ?? '', lang) || t('接口形状齐备', 'Endpoints look complete')}</p>}
    </div>
  );
}

/** 单个参数控件：type 定存储类型，options 定控件形态（有候选值用选项块，不写原生 select） */
function ParamControl({ p, value, onChange }: { p: ParamSpec; value: unknown; onChange: (v: unknown) => void }) {
  const t = useT();
  const label = p.label || p.key;
  const opts = (p.options ?? []).map((o) => (typeof o === 'object' && o !== null ? o : { value: o as string | number | boolean }));
  const wrap = (children: React.ReactNode) => (
    <div className="flex flex-wrap items-center gap-2">
      <Label className="w-28 shrink-0 text-[10px] font-normal text-muted-foreground" title={p.key}>{label}</Label>
      {children}
    </div>
  );
  const empty = value === undefined || value === null || value === '';

  if (p.valueType === 'secret') {
    return wrap(<Input type="password" value={String(value ?? '')} className="h-7 text-xs flex-1 min-w-32" placeholder="••••••"
      onChange={(e) => onChange(e.target.value)} title={t('只存本机，不回显', 'stored locally, never shown')} />);
  }
  if (p.valueType === 'boolean') {
    return wrap(<OptionBlocks<string> value={String(value ?? p.defaultValue ?? 'false')}
      options={[{ value: 'true', label: t('开', 'On') }, { value: 'false', label: t('关', 'Off') }]}
      onChange={(v) => onChange(v === 'true')} />);
  }
  if (opts.length) {
    return wrap(
      <div className="flex flex-wrap items-center gap-1.5">
        <OptionBlocks<string> value={String(empty ? p.defaultValue ?? '' : value)}
          options={opts.map((o) => ({ value: String(o.value), label: o.label ?? String(o.value) }))}
          onChange={(v) => onChange(p.valueType === 'number' ? Number(v) : v)} />
        {empty && p.defaultValue !== undefined && <span className="text-[10px] text-muted-foreground/60">{t('默认', 'default')} {String(p.defaultValue)}</span>}
      </div>,
    );
  }
  if (p.valueType === 'number') {
    // 未填 = 空串，绝不能显示成 0：0 是合法值（会真发出去），两者必须分得开
    return wrap(<Input type="number" value={empty && p.defaultValue === undefined ? '' : String(value ?? p.defaultValue ?? '')}
      min={p.min} max={p.max} step={p.step ?? 1} className="h-7 w-28 text-xs"
      onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />);
  }
  if (p.valueType === 'text' || p.valueType === 'json') {
    return wrap(<textarea value={String(value ?? '')} rows={2} className="input flex-1 min-w-40 text-[11px] font-mono resize-y"
      placeholder={p.valueType === 'json' ? '{}' : ''} onChange={(e) => onChange(e.target.value)} />);
  }
  return wrap(<Input value={String(value ?? '')} className="h-7 text-xs flex-1 min-w-32 font-mono" placeholder={String(p.defaultValue ?? '')}
    onChange={(e) => onChange(e.target.value)} />);
}
