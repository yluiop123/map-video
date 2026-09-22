/**
 * verify-request-engine.mjs — 引擎 + 内置模板 seed 的离线回归（不联网、不动库）
 *
 * 覆盖：路径两种写法、模板求值（类型保留 / 插值 / {@name} 展开 / omitIfEmpty / when 门控）、
 *       五步取回管线（响应体即产物 / hex / base64 / 远端链接当场下载并带鉴权头）、
 *       异步（提交 → taskId → 同组 query 行轮询 → 三枚举判定 → 超时）、密钥打码、
 *       行与组的保存前校验，以及全部内置模板组逐组试构造。
 * 运行：node --experimental-strip-types tools/verify-request-engine.mjs
 * 退出码非 0 表示有失败项。
 */
import {
  buildRequest, callRole, readPath, redact, validateRow, validateGroup, pickRow, applySlots,
} from '../src/lib/request-engine.ts';
import { SEED_GROUPS, needsSecret2, seedRow } from '../src/lib/template-seed.ts';

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed += 1;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail !== undefined && !pass ? `\n         ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
const throws = async (name, fn, wantIncludes) => {
  try { await fn(); check(name, false, '没抛错'); }
  catch (e) { const m = e instanceof Error ? e.message : String(e); check(name, !wantIncludes || m.includes(wantIncludes), m); }
};

const groupOf = (id) => SEED_GROUPS.find((g) => g.tplGroup === id);
const rowOf = (id, role, mode = 'sync') => groupOf(id).rows.find((r) => r.role === role && r.mode === mode);

// ========== 1. 路径 ==========
const DOC = { output: { choices: [{ message: { content: [{ image: 'u' }] } }], results: [{ url: 'r' }] } };
eq('1.1 方括号下标', readPath(DOC, 'output.choices[0].message.content[0].image'), 'u');
eq('1.2 纯点号下标同样收', readPath(DOC, 'output.results.0.url'), 'r');
check('1.3 下标越界返回 undefined', readPath(DOC, 'output.choices[5].message') === undefined);
check('1.4 键名当字符串取不到数组元素', readPath(DOC, 'output.choices.x') === undefined);

// ========== 2. 求值 ==========
const chat = rowOf('openai-chat', 'generate');
// 实例行提供的保留占位符（真实调用里由 ctxOf 一律给齐：speed 缺省 1、voice 来自实例列）
const ctx = {
  baseUrl: 'https://api.deepseek.com', apiKey: 'sk-abcdefghij1234', apiKey2: '', model: 'deepseek-chat',
  voice: 'longanyang', speed: 1, mode: 'sync', params: { temperature: 7, maxTokens: 2048 },
};
let req = buildRequest(chat, { ...ctx, systemPrompt: '你是助手', userPrompt: '写三行' });
eq('2.1 {baseUrl} 拼出完整地址', req.url, 'https://api.deepseek.com/chat/completions');
eq('2.2 header 插值密钥', req.headers.Authorization, 'Bearer sk-abcdefghij1234');
eq('2.3 标量槽保留数字类型', req.body.temperature, 7);
eq('2.4 常量骨架数组里的槽位', req.body.messages.map((m) => m.role), ['system', 'user']);
eq('2.5 骨架里的字符串槽仍是字符串', req.body.messages[1].content, '写三行');
const noMax = buildRequest(chat, { ...ctx, params: {}, systemPrompt: 'a', userPrompt: 'b' });
check('2.6 omitIfEmpty 的键没值时连键删掉', !('max_tokens' in noMax.body), noMax.body);
const img = rowOf('dashscope-image', 'generate');
const imgReq = buildRequest(img, { ...ctx, baseUrl: 'https://dashscope.aliyuncs.com/api/v1', params: { size: '1024*1024', promptExtend: false, watermark: false }, prompt: '猫' });
eq('2.7 嵌套对象骨架', imgReq.body.input.messages[0].content[0].text, '猫');
eq('2.8 bool 参数保留布尔', imgReq.body.parameters.watermark, false);
check('2.9 空 parameters 不会被误删（模板写死的键留着）', !!imgReq.body.parameters && 'size' in imgReq.body.parameters);

// {@name} 展开 + when 门控
const spliceRow = {
  role: 'generate', mode: 'sync', method: 'POST', url: '{baseUrl}/x',
  body: { model: '{model}', messages: [{ role: 'user', content: '{text}' }, '{@history}'] },
  vars: [
    { name: 'text', stage: 'call', type: 'string' },
    { name: 'history', stage: 'instance', type: 'list', omitIfEmpty: true, item: { body: { role: '{role}', content: '{content}' }, fields: [] } },
  ],
};
eq('2.10 空 list 展开后不留空位', buildRequest(spliceRow, { ...ctx, text: 'hi' }).body.messages.length, 1);
const spliced = buildRequest(spliceRow, { ...ctx, text: 'hi', history: [{ role: 'assistant', content: '上一句' }] });
eq('2.11 {@name} 整段展开且保留对象类型', spliced.body.messages[1], { role: 'assistant', content: '上一句' });
const gatedRow = {
  role: 'generate', mode: 'sync', url: '{baseUrl}/g',
  body: { a: '{a}', b: '{b}' },
  vars: [{ name: 'a', stage: 'instance', when: 'mode == async' }, { name: 'b', stage: 'instance' }],
};
eq('2.12 when 不成立的变量连父键一起消失', buildRequest(gatedRow, { ...ctx, params: { b: 2 } }).body, { b: 2 });
eq('2.13 实例 mode 决定 when 是否成立', buildRequest(gatedRow, { ...ctx, mode: 'async', params: { a: 1, b: 2 } }).body, { a: 1, b: 2 });

// ========== 3. 打码 ==========
const masked = redact(req, ctx);
check('3.1 预览里密钥打码', masked.headers.Authorization.includes('****') && !masked.headers.Authorization.includes('bcdef'), masked.headers.Authorization);
check('3.2 原文不在任何字段里', !JSON.stringify(masked).includes('sk-abcdefghij1234'));

// ========== 4. 取回与解码（五步管线） ==========
/** 造一个假传输：按顺序吐响应（吐完重复最后一个），并记下每次发出的请求与下载 */
const mk = (...replies) => {
  const sent = [];
  const fetches = [];
  let i = 0;
  return {
    sent, fetches,
    send: async (r) => { sent.push(r); return replies[Math.min(i++, replies.length - 1)]; },
    fetchBytes: async (u, h) => { fetches.push({ u, h }); return { bytes: new Uint8Array([1, 2, 3]), mime: 'audio/wav' }; },
    sleep: async () => {},
    // 每次 +1000ms，用来测超时分支
    now: (() => { let t = 0; return () => (t += 1000); })(),
  };
};

const cosy = groupOf('dashscope-cosyvoice');
let c = mk({ status: 200, contentType: 'audio/mpeg', bytes: new Uint8Array([9, 9, 9]) });
let out = await callRole(cosy, { ...ctx, baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'cosyvoice-v3.5-flash', voice: 'longanyang', params: { format: 'mp3', sampleRate: 24000 } }, 'synthesize', { text: '你好' }, c);
check('4.1 响应体本身就是音频（audio 槽留空）', out.bytes?.length === 3 && out.mime === 'audio/mpeg');

c = mk({ status: 200, contentType: 'application/json', json: { output: { audio: { url: 'https://x/a.wav' } } } });
out = await callRole(groupOf('dashscope-qwen-tts'), { ...ctx, baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'qwen3-tts-flash', voice: 'Cherry', params: {} }, 'synthesize', { text: '你好' }, c);
check('4.2 产物是远端链接 → 当场下载', out.bytes?.length === 3, out.values);
eq('4.3 下载走的是那个链接', c.fetches.map((f) => f.u), ['https://x/a.wav']);

c = mk({ status: 200, contentType: 'application/json', json: { data: { audio: 'deadbeef' } } });
out = await callRole(groupOf('minimax-t2a'), { ...ctx, baseUrl: 'https://api.minimax.chat/v1/t2a_v2', model: 'm', voice: 'v', params: { groupId: 'g1', format: 'mp3' } }, 'synthesize', { text: '你好' }, c);
eq('4.4 hex 解码', Array.from(out.bytes ?? []), [0xde, 0xad, 0xbe, 0xef]);
eq('4.5 group_id 走 query（实例参数，不占密钥列）', c.sent[0].query, { group_id: 'g1' });
check('4.6 第二凭证列没被 group_id 占用', !JSON.stringify(c.sent[0]).includes('apiKey2'));

c = mk({ status: 200, contentType: 'application/json', json: { output: { voice_id: 'cosyvoice-x-f' } } });
out = await callRole(cosy, { ...ctx, baseUrl: 'https://dashscope.aliyuncs.com/api/v1', model: 'cosyvoice-v3.5-flash', params: { prefix: 'mv' } }, 'clone', { wavB64: 'AAAA' }, c);
eq('4.7 克隆取音色 ID', out.values.voiceId, 'cosyvoice-x-f');
const dataUri = buildRequest(rowOf('dashscope-cosyvoice', 'clone'), { ...ctx, baseUrl: 'https://d', params: { prefix: 'mv' }, wavB64: 'ab+cd==' });
eq('4.8 data URI 里的 +/= 没被当占位符', dataUri.body.input.url, 'data:audio/wav;base64,ab+cd==');

// ========== 5. 异步（同组 query 行轮询） ==========
const imgAsync = groupOf('dashscope-image');
const actx = { ...ctx, baseUrl: 'https://dashscope.aliyuncs.com/api/v1', mode: 'async', model: 'wan2.6-t2i', params: { size: '1024*1024', count: 1, promptExtend: false, watermark: false } };
c = mk(
  { status: 200, contentType: 'application/json', json: { output: { task_id: 'T9' } } },
  { status: 200, contentType: 'application/json', json: { output: { task_status: 'RUNNING' } } },
  { status: 200, contentType: 'application/json', json: { output: { task_status: 'SUCCEEDED', results: [{ url: 'https://x/r.png' }] } } },
);
out = await callRole(imgAsync, actx, 'generate', { prompt: '猫' }, c);
check('5.1 异步产物来自 query 行', out.bytes?.length === 3, out.values);
eq('5.2 taskId 交回界面', out.values.taskId, 'T9');
eq('5.3 轮询过程逐步记录', out.steps.map((s) => s.label), ['generate 提交', '查询状态', '查询状态']);
check('5.4 第二次请求把 {taskId} 拼进了地址', c.sent[1].url.endsWith('/tasks/T9'), c.sent[1].url);
eq('5.5 异步变体的头与同步不同', buildRequest(rowOf('dashscope-image', 'generate', 'async'), { ...actx, prompt: '猫' }).headers['X-DashScope-Async'], 'enable');
const qrow = rowOf('dashscope-image', 'query');
check('5.6 查询行的 url 用 {taskId} 占位', qrow.url.includes('{taskId}'));

c = mk(
  { status: 200, contentType: 'application/json', json: { output: { task_id: 'T9' } } },
  { status: 200, contentType: 'application/json', json: { output: { task_status: 'FAILED' } } },
);
await throws('5.7 命中 fail 枚举 → 点名状态原文', () => callRole(imgAsync, actx, 'generate', { prompt: '猫' }, c), 'FAILED');

c = mk(
  { status: 200, contentType: 'application/json', json: { output: { task_id: 'T9' } } },
  { status: 200, contentType: 'application/json', json: { output: { task_status: 'RUNNING' } } },
);
await throws('5.8 轮询超时会报错', () => callRole(imgAsync, actx, 'generate', { prompt: '猫' }, c), '超时');

c = mk(
  { status: 200, contentType: 'application/json', json: { output: { task_id: 'T9' } } },
  { status: 200, contentType: 'application/json', json: { output: { task_status: 'WEIRD' } } },
);
await throws('5.9 三枚举都没命中的状态要点名（不是死循环）', () => callRole(imgAsync, actx, 'generate', { prompt: '猫' }, c), '未识别的任务状态');

const noQuery = { ...imgAsync, rows: imgAsync.rows.filter((r) => r.role !== 'query') };
await throws('5.10 缺查询接口时报错点名', () => callRole(noQuery, actx, 'generate', { prompt: '猫' }, mk({ status: 200, contentType: 'application/json', json: { output: { task_id: 'T9' } } })), '查询接口');

// ========== 6. 保存前校验 ==========
check('6.1 异步生成行缺 taskId 会点名', validateRow({ ...rowOf('dashscope-image', 'generate', 'async'), resp: {} }, 'image').some((p) => p.includes('任务 id')));
check('6.2 同步行配了状态会点名', validateRow({ ...rowOf('dashscope-image', 'generate'), resp: { image: 'a', status: 'b' } }, 'image').some((p) => p.includes('同步接口不该配')));
check('6.3 查询行缺成功枚举会点名', validateRow({ ...qrow, resp: { ...qrow.resp, success: [] } }, 'image').some((p) => p.includes('成功')));
check('6.4 未声明的占位符会点名', validateRow({ ...chat, body: { x: '{nope}' } }, 'llm').some((p) => p.includes('nope')));
check('6.5 list 变量缺 item 会点名', validateRow({ ...chat, vars: [{ name: 'l', stage: 'instance', type: 'list' }] }, 'llm').some((p) => p.includes('元素子模板')));
check('6.6 音频槽留空是合法的（响应体即音频）', validateRow(rowOf('dashscope-cosyvoice', 'synthesize'), 'tts').length === 0);
check('6.7 异步实例缺查询接口 → 组级点名', validateGroup(noQuery, 'async').some((p) => p.includes('查询接口')));
check('6.8 缺必需 role → 组级点名', validateGroup({ ...cosy, rows: [] }, 'sync').some((p) => p.includes('必需')));

// ========== 7. seed 自检 ==========
for (const g of SEED_GROUPS) {
  const problems = validateGroup(g, 'sync');
  check(`7.1 ${g.tplGroup} 同步形状可用`, problems.length === 0, problems);
  const keys = g.rows.map((r) => `${r.role}:${r.mode}`);
  check(`7.2 ${g.tplGroup} 没有重复 role+mode`, new Set(keys).size === keys.length, keys);
  const asyncProblems = g.rows.some((r) => r.mode === 'async') ? validateGroup(g, 'async') : [];
  check(`7.3 ${g.tplGroup} 异步形状可用`, asyncProblems.length === 0, asyncProblems);
}
check('7.4 火山要第二凭证', needsSecret2(groupOf('volc-tts')));
check('7.5 通义语音不要第二凭证', !needsSecret2(groupOf('dashscope-cosyvoice')));
check('7.6 新建行种子带齐槽位', !!seedRow('image', 'query').resp?.status && Array.isArray(seedRow('image', 'query').resp?.success));
check('7.7 pickRow 按实例 mode 选变体', pickRow(groupOf('dashscope-image'), 'generate', 'async')?.url.includes('image-synthesis'));
eq('7.8 没填的槽不参与取值', applySlots(DOC, { image: '', audio: undefined, status: 'output.results[0].url' }), { status: 'r' });
check('7.9 只有同步变体的组：选异步会被点名', validateGroup(groupOf('dashscope-cosyvoice'), 'async').some((p) => p.includes('没有异步')));
check('7.10 音频槽留空 → 取值表里没有 audio 键', Object.keys(applySlots({ x: 1 }, { audio: '' })).length === 0);

console.log(failed ? `\n===== ${failed} 项失败 =====` : '\n===== 全部通过 =====');
process.exit(failed ? 1 : 0);
