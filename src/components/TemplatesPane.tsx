/**
 * TemplatesPane.tsx — 接口模板（provider_template_group / provider_template）
 *
 * ⚙ 设置 · AI 左侧的独立入口，与「实例设置」不在同一个页面：
 * 这一页改的是「一家怎么发请求」（共享数据，改完所有引用它的实例都受影响），
 * 实例设置页改的是「这个账号用什么 Key、走同步还是异步、参数取多少」。
 */
import { useMemo, useState } from 'react';
import { JsonField, NumberInput, OptionBlocks, useT } from './ui/primitives';
import { useConfirm } from './ui/ConfirmHost';
import { useEditorStore } from '../stores/editorStore';
import { useProviderStore } from '../stores/providerStore';
import { pickLabel, type L } from '../lib/i18n';
import {
  callVarsOf, validateGroup, validateRow,
  type Mode, type ProviderKind, type RespSlots, type Role, type TemplateGroup, type TemplateRow, type VarSpec,
} from '../lib/request-engine';
import { previewRequest, runRoleDebug } from '../lib/providers';
import { SEED_GROUPS } from '../lib/template-seed';
import type { ProviderConfig } from '../types';

const KIND_LABEL: Record<ProviderKind, L> = {
  llm: { zh: '文案生成', en: 'Text' },
  tts: { zh: '语音', en: 'Voice' },
  image: { zh: '图片', en: 'Image' },
};

const ROLE_LABEL: Record<Role, L> = {
  generate: { zh: '生成接口', en: 'Generate' },
  synthesize: { zh: '语音合成', en: 'Synthesize' },
  query: { zh: '查询接口', en: 'Status query' },
  clone: { zh: '音色克隆', en: 'Voice clone' },
};

/** 每类功能可以有哪些接口行（已存在的不再列） */
const ADDABLE: Record<ProviderKind, { role: Role; mode: Mode }[]> = {
  llm: [{ role: 'generate', mode: 'sync' }],
  image: [{ role: 'generate', mode: 'sync' }, { role: 'generate', mode: 'async' }, { role: 'query', mode: 'sync' }],
  tts: [{ role: 'synthesize', mode: 'sync' }, { role: 'synthesize', mode: 'async' }, { role: 'query', mode: 'sync' }, { role: 'clone', mode: 'sync' }],
};

/** 试调用要拿一个真实账号提供 Key，没账号时只能零网络预览 */
function instanceOf(list: ProviderConfig[], tplGroup: string): ProviderConfig | undefined {
  return list.find((c) => c.tplGroup === tplGroup);
}

export function TemplatesPane() {
  const t = useT();
  const lang = useEditorStore((s) => (s.lang === 'en' ? 'en' : 'zh'));
  const confirm = useConfirm();
  const groups = useProviderStore((s) => s.groups);
  const llm = useProviderStore((s) => s.llm);
  const tts = useProviderStore((s) => s.tts);
  const image = useProviderStore((s) => s.image);
  const [kind, setKind] = useState<ProviderKind>('llm');
  const listOf = kind === 'llm' ? llm : kind === 'tts' ? tts : image;
  const kindGroups = useMemo(() => groups.filter((g) => g.kind === kind), [groups, kind]);
  const [sel, setSel] = useState('openai-chat');
  const group = kindGroups.find((g) => g.tplGroup === sel) ?? kindGroups[0] ?? null;

  const pickKind = (k: ProviderKind) => {
    setKind(k);
    setSel(groups.find((g) => g.kind === k)?.tplGroup ?? '');
  };
  const addGroup = () => {
    const id = `custom-${kind}-${Math.random().toString(36).slice(2, 6)}`;
    useProviderStore.getState().addGroup({
      tplGroup: id, kind, rows: [],
      label: { zh: `自定义${pickLabel(KIND_LABEL[kind], lang)}`, en: `Custom ${kind}` },
    });
    setSel(id);
  };
  const dropGroup = async () => {
    if (!group) return;
    const used = listOf.filter((c) => c.tplGroup === group.tplGroup).length;
    const ok = await confirm({
      message: t(`删除模板组「${pickLabel(group.label, lang)}」？${used ? `还有 ${used} 个实例在用它，删掉后这些实例不可用。` : ''}`, `Delete this group? ${used ? `${used} instance(s) use it.` : ''}`),
      danger: true,
    });
    if (!ok) return;
    useProviderStore.getState().removeGroup(group.tplGroup);
    setSel(kindGroups.find((g) => g.tplGroup !== group.tplGroup)?.tplGroup ?? '');
  };

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{t('🧩 接口模板', '🧩 Endpoint templates')}</h3>
      <p className="text-[11px] text-muted-foreground">
        {t('一组 = 一个功能要哪几条接口；一行 = 一条接口怎么发、返回从哪取。模板是共享的，改完所有引用它的实例都跟着变。', 'A group = the endpoints one capability needs; a row = how it is sent and where results are read. Groups are shared by every instance using them.')}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {(['llm', 'tts', 'image'] as ProviderKind[]).map((k) => (
          <button key={k} onClick={() => pickKind(k)} className={`h-7 px-2.5 rounded-md border text-[11px] ${k === kind ? 'border-white/30 bg-white/10' : 'border-white/10 hover:bg-white/[0.06]'}`}>
            {pickLabel(KIND_LABEL[k], lang)}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {kindGroups.map((g) => {
          const used = listOf.filter((c) => c.tplGroup === g.tplGroup).length;
          return (
            <button key={g.tplGroup} onClick={() => setSel(g.tplGroup)} title={g.tplGroup}
              className={`h-7 px-2 rounded-md border text-[11px] ${g.tplGroup === group?.tplGroup ? 'border-white/35 bg-white/10' : 'border-white/10 hover:bg-white/[0.06]'}`}>
              {pickLabel(g.label, lang)}{used ? ` · ${used}` : ''}
            </button>
          );
        })}
        <button onClick={addGroup} className="h-7 px-2 rounded-md border border-white/15 text-[11px] hover:bg-white/10">＋ {t('模板组', 'Group')}</button>
      </div>

      {group && <GroupEditor key={group.tplGroup} group={group} instances={listOf} onDelete={() => void dropGroup()} />}
    </div>
  );
}

function GroupEditor({ group, instances, onDelete }: { group: TemplateGroup; instances: ProviderConfig[]; onDelete: () => void }) {
  const t = useT();
  const lang = useEditorStore((s) => (s.lang === 'en' ? 'en' : 'zh'));
  const store = useProviderStore.getState();
  const problems = validateGroup(group, 'sync');
  const seed = SEED_GROUPS.some((g) => g.tplGroup === group.tplGroup);
  const missing = ADDABLE[group.kind].filter((x) => !group.rows.some((r) => r.role === x.role && r.mode === x.mode));
  const patch = (g: TemplateGroup) => store.saveGroup(g);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input value={pickLabel(group.label, lang)} onChange={(e) => patch({ ...group, label: e.target.value })} className="input h-7 text-xs w-40" placeholder={t('组名称', 'Group name')} />
        <input value={group.baseUrl ?? ''} onChange={(e) => patch({ ...group, baseUrl: e.target.value })} className="input h-7 text-xs flex-1 min-w-40 font-mono" placeholder="https://…/api/v1" />
        <button
          onClick={() => store.restoreGroup(group.tplGroup)}
          disabled={!seed} title={t('丢弃本地改动，取回内置默认形状', 'Restore the built-in shape')}
          className="h-7 px-2 rounded-md border border-white/15 text-[10px] hover:bg-white/10 disabled:opacity-40"
        >{t('恢复默认', 'Restore')}</button>
        <button onClick={onDelete} className="h-7 px-2 rounded-md border border-white/15 text-[10px] text-red-400/80 hover:bg-red-500/10">{t('删除组', 'Delete')}</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] text-muted-foreground/70 shrink-0">{t('候选模型', 'Models')}</span>
        <input
          value={(group.models ?? []).join(', ')} placeholder="deepseek-chat, …"
          onChange={(e) => patch({ ...group, models: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })}
          className="input h-6 flex-1 min-w-40 text-[10px] font-mono"
        />
      </div>
      {!!group.note && <p className="text-[10px] text-muted-foreground/80">{pickLabel(group.note, lang)}</p>}
      {problems.length > 0 && <p className="text-[10px] text-red-400 whitespace-pre-line">{problems.join('\n')}</p>}

      {group.rows.map((row) => (
        <RowEditor key={`${row.role}:${row.mode}`} group={group} row={row} instance={instanceOf(instances, group.tplGroup)} lang={lang} />
      ))}

      {missing.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground/70">{t('可添加的接口', 'Add endpoint')}</span>
          {missing.map((m) => (
            <button key={`${m.role}:${m.mode}`} onClick={() => store.addRow(group.tplGroup, m.role, m.mode)}
              className="h-6 px-2 rounded-md border border-white/15 text-[10px] hover:bg-white/10">
              ＋ {pickLabel(ROLE_LABEL[m.role], lang)}{m.mode === 'async' ? `·${t('异步', 'async')}` : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RowEditor({ group, row, instance, lang }: { group: TemplateGroup; row: TemplateRow; instance?: ProviderConfig; lang: 'zh' | 'en' }) {
  const t = useT();
  const confirm = useConfirm();
  const store = useProviderStore.getState();
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState('');
  const [run, setRun] = useState<{ s: 'idle' | 'run' | 'ok' | 'err'; text?: string }>({ s: 'idle' });
  const patch = (p: Partial<TemplateRow>) => {
    store.updateRow(group.tplGroup, row.role, row.mode, p);
    setPreview('');
  };
  const problems = validateRow(row, group.kind);
  const ownsProduct = row.role === 'query' || (row.role !== 'clone' && row.mode === 'sync');
  const injects = callVarsOf(row);
  const title = pickLabel(ROLE_LABEL[row.role], lang);

  const dropRow = async () => {
    if (await confirm({ message: t(`从这组模板移除「${title}」？引用这组的实例会立刻少掉这条能力。`, 'Remove this endpoint?'), danger: true })) {
      store.removeRow(group.tplGroup, row.role, row.mode);
    }
  };
  const doPreview = () => {
    if (!instance) { setPreview(t('还没有实例引用这组模板 —— 预览要用它的 Key 才能拼出真实请求。', 'No instance uses this group yet — preview needs its credentials.')); return; }
    try {
      const r = previewRequest(instance, row.role, filledInputs(row, inputs));
      setPreview(`${r.method} ${r.url}\nheaders: ${JSON.stringify(r.headers)}\nquery: ${JSON.stringify(r.query)}\nbody: ${JSON.stringify(r.body, null, 1)}`);
    } catch (e) { setPreview(`✕ ${e instanceof Error ? e.message : String(e)}`); }
  };
  const doRun = async () => {
    if (!instance) return;
    setRun({ s: 'run' });
    try {
      const r = await runRoleDebug(instance, row.role, filledInputs(row, inputs));
      const shown = r.steps.map((s) => `${s.label} HTTP ${s.status} ${JSON.stringify(s.values)}`).join('\n');
      setRun({ s: 'ok', text: `${shown}${r.bytes ? `\n→ 音频/图片 ${r.bytes.length} 字节（${r.mime || '未知类型'}）` : ''}` });
    } catch (e) { setRun({ s: 'err', text: e instanceof Error ? e.message : String(e) }); }
  };

  return (
    <div className="border border-white/10 rounded-lg p-2.5 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium">{title}</span>
        {row.role !== 'clone' && (
          <OptionBlocks<string>
            value={row.mode}
            options={[{ value: 'sync', label: t('同步', 'Sync') }, { value: 'async', label: t('异步', 'Async') }]}
            onChange={(v) => patch({ mode: v as Mode })}
          />
        )}
        <span className="text-[10px] font-mono text-muted-foreground/60 flex-1 truncate">{row.role}·{row.mode}</span>
        <button onClick={() => void dropRow()} className="h-6 px-1.5 rounded-md border border-white/15 text-[10px] text-red-400/80 hover:bg-red-500/10">✕</button>
      </div>

      {row.role === 'query' && <p className="text-[10px] text-muted-foreground/70">↑ {t('供异步生成接口轮询使用', 'Used to poll the async submit endpoint')}</p>}
      {row.mode === 'async' && row.role !== 'query' && (
        <p className="text-[10px] text-muted-foreground/70">
          {group.rows.some((r) => r.role === 'query')
            ? t('轮询用：查询接口 ✓', 'Polled by the status query endpoint ✓')
            : `⚠ ${t('缺查询接口 —— 点下方「＋ 查询接口」补', 'Missing the status query endpoint')}`}
        </p>
      )}
      {problems.length > 0 && <p className="text-[10px] text-red-400 whitespace-pre-line">{problems.join('\n')}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <OptionBlocks<string> value={row.method || 'POST'} options={['GET', 'POST', 'PUT', 'DELETE'].map((m) => ({ value: m, label: m }))} onChange={(v) => patch({ method: v })} />
        <input value={row.url} onChange={(e) => patch({ url: e.target.value })} className="input h-7 flex-1 min-w-40 text-[11px] font-mono" placeholder="{baseUrl}/…" />
      </div>

      <JsonField label="Headers" value={row.headers} onCommit={(v) => patch({ headers: v as Record<string, unknown> })} />
      <JsonField label="Query" value={row.query} onCommit={(v) => patch({ query: v as Record<string, unknown> })} />
      <JsonField label="Body" value={row.body} onCommit={(v) => patch({ body: v })} />

      <VarsEditor row={row} onCommit={(vars) => patch({ vars })} lang={lang} />
      <RespEditor row={row} kind={group.kind} onCommit={(resp) => patch({ resp })} />

      {ownsProduct && (
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          <span>{t('产物解码', 'decode')}</span>
          <OptionBlocks<string> value={row.decode ?? '-'} options={['-', 'hex', 'base64', 'url'].map((m) => ({ value: m, label: m }))}
            onChange={(v) => patch({ decode: v === '-' ? undefined : v as 'hex' })} />
          <span className="text-muted-foreground/60">{t('url = 查询完成后当场下载转存，不保存远端链接', 'url = downloaded on the spot; the remote link is never stored')}</span>
        </div>
      )}
      {row.role === 'query' && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
            <label className="flex items-center gap-1">{t('轮询间隔 ms', 'interval ms')}
              <NumberInput className="input h-7 w-20 text-xs" value={row.pollIntervalMs ?? 1500} step={100} min={200} onCommit={(n) => patch({ pollIntervalMs: n })} />
            </label>
            <label className="flex items-center gap-1">{t('超时 ms', 'timeout ms')}
              <NumberInput className="input h-7 w-24 text-xs" value={row.pollTimeoutMs ?? 120000} step={1000} min={1000} onCommit={(n) => patch({ pollTimeoutMs: n })} />
            </label>
          </div>
          <JsonField label={t('下载产物附带的头', 'Download headers')} value={row.fetchHeaders} onCommit={(v) => patch({ fetchHeaders: v as Record<string, unknown> })} />
        </>
      )}

      <div className="border-t border-white/[0.06] pt-1.5 space-y-1">
        <div className="flex flex-wrap items-end gap-1.5">
          {injects.filter((n) => n !== 'wavB64').map((n) => (
            <label key={n} className="flex flex-col text-[10px] text-muted-foreground">
              {n}
              <input value={inputs[n] ?? DEFAULT_INPUT[n] ?? ''} onChange={(e) => setInputs((s) => ({ ...s, [n]: e.target.value }))} className="input h-6 w-32 text-[11px]" />
            </label>
          ))}
          {injects.includes('wavB64') && (
            <label className="h-6 px-2 inline-flex items-center rounded-md border border-white/15 text-[10px] hover:bg-white/10 cursor-pointer">
              ⬆ {t('参考音频', 'reference audio')}
              <input type="file" accept="audio/*" className="hidden" onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) {
                  const b = new Uint8Array(await f.arrayBuffer());
                  let bin = '';
                  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
                  setInputs((s) => ({ ...s, wavB64: btoa(bin) }));
                }
                e.target.value = '';
              }} />
            </label>
          )}
          <button onClick={doPreview} className="h-7 px-2.5 rounded-md border border-white/15 text-[11px] hover:bg-white/10">{t('预览请求', 'Preview')}</button>
          <button
            onClick={() => void doRun()} disabled={run.s === 'run' || !instance}
            title={instance ? '' : t('需要先有一个引用这组模板的实例（试调用要用它的 Key）', 'Needs an instance with a key')}
            className="h-7 px-2.5 rounded-md border border-sky-400/40 bg-sky-500/10 text-[11px] text-sky-200 hover:bg-sky-500/20 disabled:opacity-40"
          >
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

const DEFAULT_INPUT: Record<string, string> = {
  text: '这段旁白用来试听音色。',
  systemPrompt: '你是连通性测试助手。',
  userPrompt: '只回复两个字：正常',
  prompt: '一只戴宇航员头盔的橘猫，赛博朋克风格',
  preferredName: 'mapvideo',
  prefix: 'mv',
};

/** 试调用输入：只给「调用端要填的」占位符长输入框，没填的走默认值 */
function filledInputs(row: TemplateRow, inputs: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of callVarsOf(row)) {
    const val = inputs[name] ?? DEFAULT_INPUT[name];
    if (val !== undefined) out[name] = val;
  }
  return out;
}

/** 入参声明表：只放实例期要人配的参数 —— 名字 / 类型 / 默认 / 说明 / 候选值 */
function VarsEditor({ row, onCommit, lang }: { row: TemplateRow; onCommit: (vars: VarSpec[]) => void; lang: 'zh' | 'en' }) {
  const t = useT();
  const vars = row.vars ?? [];
  const write = (next: VarSpec[]) => onCommit(next);
  const at = (i: number, p: Partial<VarSpec>) => write(vars.map((v, j) => (i === j ? { ...v, ...p } : v)));
  const optText = (v: VarSpec) => (v.options ?? []).map((o) => {
    const obj = typeof o === 'object' && o !== null;
    const val = obj ? String((o as { value: unknown }).value) : String(o);
    const lab = obj && (o as { label?: L }).label ? `=${pickLabel((o as { label: L }).label, lang)}` : '';
    return `${val}${lab}`;
  }).join(', ');
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
        <span>{t('入参声明', 'Variables')}</span>
        <span className="text-muted-foreground/60">{t('只声明「建实例时要配的参数」；{text} {prompt} 这类调用正文由程序传，不必声明。占位符 {name} 取标量（保留类型），{@name} 在数组里展开', 'Declare only the parameters an instance configures; {text}/{prompt} come from the caller. {name} = scalar, {@name} splices') }</span>
      </div>
      {vars.map((v, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1">
          <input value={v.name} onChange={(e) => at(i, { name: e.target.value })} className="input h-6 w-24 text-[10px] font-mono" placeholder="name" />
          <OptionBlocks<string> value={v.type ?? 'string'} options={['string', 'int', 'bool', 'list', 'json'].map((m) => ({ value: m, label: m }))} onChange={(s) => at(i, { type: s as VarSpec['type'] })} />
          <input value={String(v.default ?? '')} onChange={(e) => at(i, { default: e.target.value })} className="input h-6 w-16 text-[10px]" placeholder={t('默认', 'default')} />
          <input value={pickLabel(v.label, lang) ?? ''} onChange={(e) => at(i, { label: e.target.value })} className="input h-6 w-24 text-[10px]" placeholder={t('说明', 'label')} />
          <input value={optText(v)} onChange={(e) => at(i, { options: parseOptions(e.target.value) })} className="input h-6 flex-1 min-w-28 text-[10px] font-mono" placeholder={t('候选值：16000=16k, 24000=24k', 'options: 16000=16k, 24000=24k')} />
          <button onClick={() => write(vars.filter((_, j) => j !== i))} className="h-6 w-6 rounded text-[10px] text-muted-foreground hover:text-red-400 hover:bg-white/10">✕</button>
        </div>
      ))}
      <button onClick={() => write([...vars, { name: '', type: 'string' }])} className="h-6 px-2 rounded-md border border-white/15 text-[10px] hover:bg-white/10">＋ {t('入参', 'variable')}</button>
    </div>
  );
}

function parseOptions(s: string): VarSpec['options'] | undefined {
  const parts = s.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  return parts.map((p) => {
    const [raw, label] = p.split('=');
    const num = Number(raw);
    const value = raw === 'true' ? true : raw === 'false' ? false : Number.isNaN(num) || raw === '' ? raw : num;
    return label ? { value, label } : value;
  }) as VarSpec['options'];
}

/** 返回槽位：按 role + mode 只渲染该填的那几格 */
function RespEditor({ row, kind, onCommit }: { row: TemplateRow; kind: ProviderKind; onCommit: (resp: RespSlots) => void }) {
  const t = useT();
  const resp = row.resp ?? {};
  const at = (p: Partial<RespSlots>) => onCommit({ ...resp, ...p });
  const list = (arr?: string[]) => (arr ?? []).join(', ');
  const fields: { key: keyof RespSlots; label: string; placeholder?: string; show: boolean }[] = [
    { key: 'content', label: t('返回内容路径', 'Content path'), placeholder: 'choices[0].message.content', show: kind === 'llm' && row.mode === 'sync' },
    { key: 'image', label: t('图片路径', 'Image path'), placeholder: 'output.choices[0].message.content[0].image', show: kind === 'image' && (row.role === 'query' || row.mode === 'sync') },
    { key: 'audio', label: t('音频路径', 'Audio path'), placeholder: t('留空 = 响应体本身就是音频', 'empty = the body is the audio'), show: kind === 'tts' && (row.role === 'query' || row.mode === 'sync') },
    { key: 'voiceId', label: t('音色 ID 路径', 'Voice id path'), placeholder: 'output.voice_id', show: row.role === 'clone' },
    { key: 'taskId', label: t('任务 id 路径', 'Task id path'), placeholder: 'output.task_id', show: row.mode === 'async' && row.role !== 'query' },
    { key: 'status', label: t('任务状态路径', 'Status path'), placeholder: 'output.task_status', show: row.role === 'query' },
  ];
  return (
    <div className="space-y-1">
      <span className="text-[10px] text-muted-foreground">{t('返回取法', 'Result paths')}</span>
      {fields.filter((f) => f.show).map((f) => (
        <div key={String(f.key)} className="flex items-center gap-2">
          <span className="w-28 shrink-0 text-[10px] text-muted-foreground">{f.label}</span>
          <input
            value={String(resp[f.key] ?? '')}
            onChange={(e) => at({ [f.key]: e.target.value } as Partial<RespSlots>)}
            className="input h-6 flex-1 text-[10px] font-mono" placeholder={f.placeholder}
          />
        </div>
      ))}
      {row.role === 'query' && (
        <div className="flex flex-wrap items-center gap-2">
          {(['success', 'pending', 'fail'] as const).map((k) => (
            <label key={k} className="flex items-center gap-1 text-[10px] text-muted-foreground">
              {k === 'success' ? t('成功状态', 'success') : k === 'pending' ? t('在途状态', 'pending') : t('失败状态', 'fail')}
              <input
                value={list(resp[k])}
                onChange={(e) => at({ [k]: e.target.value.split(/[,，]/).map((x) => x.trim()).filter(Boolean) } as Partial<RespSlots>)}
                className="input h-6 w-40 text-[10px] font-mono" placeholder="SUCCEEDED"
              />
            </label>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] text-muted-foreground/70">{t('错误取值', 'error paths')}</span>
        <input value={String(resp.errorCode ?? '')} onChange={(e) => at({ errorCode: e.target.value })} className="input h-6 w-28 text-[10px] font-mono" placeholder="code" />
        <input value={String(resp.error ?? '')} onChange={(e) => at({ error: e.target.value })} className="input h-6 w-28 text-[10px] font-mono" placeholder="message" />
      </div>
    </div>
  );
}
