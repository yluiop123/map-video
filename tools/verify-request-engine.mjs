/**
 * verify-request-engine.mjs — 请求引擎与内置模板包的离线回归（不联网、不动库）
 *
 * 覆盖：模板求值（类型保留 / 插值 / 数组骨架 / {@name} 展开 / omitIfEmpty / when 门控）、
 *       取回与解码（audio / hex / base64 / 远端 URL）、异步轮询（成功·失败·超时）、
 *       密钥打码、模板自检，以及 11 个内置模板包逐一试构造。
 * 运行：node --experimental-strip-types tools/verify-request-engine.mjs
 * 退出码非 0 表示有失败项。
 */
import {
  buildRequest, callEndpoint, redact, validateTemplate, readPath, applyPick, EngineError,
} from '../src/lib/request-engine.ts';
import { RECIPES, recipeById, hasRole } from '../src/lib/recipes.ts';

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed += 1;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail !== undefined && !pass ? `\n         ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

const tplOf = (recipeId, role) => recipeById(recipeId).roles.find((r) => r.role === role);

// 每个 role 跑一遍「把所有 inject 都喂上」的最小上下文
const INJECT_FIXTURE = {
  systemPrompt: '你是助手', userPrompt: '写三行文案', text: '今天天气不错', prompt: '一只戴头盔的橘猫',
  voice: 'longanyang', model: 'm', prefix: 'mv', preferredName: 'mapvideo', wavB64: 'AAAA+bb/==', reqId: 'mv-1',
};
const CTX = { baseUrl: 'https://x.test/api/v1', secrets: { apiKey: 'sk-abcdefghij1234', secret2: 'grp-9' }, ...INJECT_FIXTURE };

// ---------- 1. 模板自检 + 全部 role 试构造 ----------
console.log('\n[1] 内置模板包逐个自检');
for (const r of RECIPES) {
  for (const t of r.roles) {
    const problems = validateTemplate(t);
    let err = null;
    // taskId 由引擎在轮询时注入，试构造时给个假值（真实 UI 的「试调用」会给查询接口留一个手填框）
    try { buildRequest(t, { ...CTX, taskId: 't-demo', model: r.defaultModel || CTX.model, voice: r.defaultVoice || CTX.voice }); }
    catch (e) { err = e; }
    check(`1 ${r.id} / ${t.role}`, problems.length === 0 && !err, problems.length ? problems.join('; ') : err?.message);
  }
}
check('1.x role 覆盖：tts 有克隆的两家', hasRole(recipeById('dashscope-cosyvoice'), 'tts.clone') && hasRole(recipeById('dashscope-qwen-tts'), 'tts.clone'));
check('1.y 异步模板成对：image-async 同时有 generate 与 query',
  hasRole(recipeById('dashscope-image-async'), 'image.generate') && hasRole(recipeById('dashscope-image-async'), 'image.query'));

// ---------- 2. 求值规则 ----------
console.log('\n[2] 求值规则');
{
  const t = tplOf('openai-chat', 'llm.generate');
  const req = buildRequest(t, CTX);
  eq('2.1 URL 拼接 baseUrl + path', req.url, 'https://x.test/api/v1/chat/completions');
  eq('2.2 messages 是模板里的常量骨架，只有槽被替换', req.body.messages.map((m) => m.role), ['system', 'user']);
  eq('2.3 messages 内容取自变量', req.body.messages[1].content, '写三行文案');
  eq('2.4 number 保留类型（不是 "0.7"）', req.body.temperature, 0.7);
  check('2.5 omitIfEmpty：未给 max_tokens 时键不存在', !('max_tokens' in req.body), Object.keys(req.body));
  eq('2.6 给了就写进 body 且保持 number', buildRequest(t, { ...CTX, maxTokens: 512 }).body.max_tokens, 512);

  const bad = { role: 'llm.generate', mode: 'sync', path: '{baseUrl}/x', body: { q: '{undeclaredThing}' } };
  check('2.7 引用未声明变量 → 自检点名', validateTemplate(bad).some((p) => p.includes('undeclaredThing')), validateTemplate(bad));
  let threw = null;
  try { buildRequest({ ...bad, vars: [] }, CTX); } catch (e) { threw = e; }
  check('2.8 运行时同样拒绝（不静默发半截请求）', threw instanceof EngineError, threw?.message);
}
{
  // 数组展开 + when 门控
  const listTpl = {
    role: 'llm.generate', mode: 'sync', path: '{baseUrl}/c',
    body: {
      model: '{model}',
      messages: [{ role: 'user', content: '{text}' }, '{@history}'],
      parameters: { seed: '{seed}' },
    },
    vars: [
      { name: 'text', kind: 'inject' },
      { name: 'history', kind: 'param', type: 'list', omitIfEmpty: true, item: { body: { role: '{role}', content: '{content}' } } },
      { name: 'seed', kind: 'param', type: 'number', default: 7, when: 'mode == async' },
    ],
  };
  const empty = buildRequest(listTpl, CTX);
  eq('2.9 list 变量为空 → 只留骨架那一条', empty.body.messages.length, 1);
  const filled = buildRequest(listTpl, { ...CTX, history: [{ role: 'assistant', content: '上一句' }, { role: 'user', content: '再一句' }] });
  eq('2.10 {@name} 展开成多个元素', filled.body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  check('2.11 when 不成立时 param 视为未给（同步不带 seed，空的 parameters 一起消失）',
    !('parameters' in filled.body), JSON.stringify(filled.body));
  eq('2.11b 模板里写死的空对象照样保留（有的接口要 parameters:{}）',
    buildRequest({ role: 'llm.generate', mode: 'sync', path: '{baseUrl}/c', body: { parameters: {}, q: '{omitMe}' }, vars: [{ name: 'omitMe', kind: 'param', default: '', omitIfEmpty: true }] }, CTX).body,
    { parameters: {} });
  const asyncList = { ...listTpl, mode: 'async' };
  eq('2.12 when 成立时才带 seed', buildRequest(asyncList, { ...CTX, history: [] }).body.parameters, { seed: 7 });
  let spliceErr = null;
  try { buildRequest({ ...listTpl, body: { x: '{@history}' }, vars: listTpl.vars }, { ...CTX, history: [1] }); }
  catch (e) { spliceErr = e; }
  check('2.13 {@name} 出现在对象里直接报错（只能在数组）', spliceErr instanceof EngineError, spliceErr?.message);
}
{
  // base64 / data URI 安全
  const c = tplOf('dashscope-cosyvoice', 'tts.clone');
  const req = buildRequest(c, { ...CTX, wavB64: 'AA+BB/CC==' });
  eq('2.14 data URI 插值不吞 + / = 字符', req.body.input.url, 'data:audio/wav;base64,AA+BB/CC==');
  const q = tplOf('dashscope-qwen-tts', 'tts.clone');
  const req2 = buildRequest(q, { ...CTX, wavB64: 'AA+BB/CC==', model: 'qwen3-tts-vc-2026-01-22' });
  eq('2.15 Qwen 克隆形状：model/action/preferred_name/audio.data',
    [req2.body.model, req2.body.input.action, req2.body.input.preferred_name, req2.body.input.audio.data.slice(0, 22)],
    ['qwen-voice-enrollment', 'create', 'mapvideo', 'data:audio/wav;base64,']);
  eq('2.16 两家克隆的返回字段不同（voice_id vs voice）',
    [applyPick({ output: { voice_id: 'a' } }, c.resp.pick).voiceId, applyPick({ output: { voice: 'b' } }, q.resp.pick).voiceId], ['a', 'b']);
}
{
  // 点号 + 数组下标
  const j = { output: { choices: [{ message: { content: [{ image: 'http://i/1.png' }] } }] } };
  eq('2.17 readPath 支持数组下标', readPath(j, 'output.choices.0.message.content.0.image'), 'http://i/1.png');
  eq('2.18 路径不存在 → undefined 而不是抛', readPath(j, 'output.nope.0.deep'), undefined);
}

// ---------- 3. 取回与解码 ----------
console.log('\n[3] 取回与解码');
const bytesOf = (s) => Uint8Array.from([...s].map((ch) => ch.charCodeAt(0)));
async function audioVia(tpl, send, fetchBytes) {
  return callEndpoint(tpl, CTX, { send, fetchBytes, sleep: async () => {} });
}
{
  const t = tplOf('dashscope-cosyvoice', 'tts.synthesize');
  const req = buildRequest(t, { ...CTX, sampleRate: 24000, format: 'mp3' });
  eq('3.1 CosyVoice 请求带 format/sample_rate', req.body.parameters, { format: 'mp3', sample_rate: 24000 });
  check('3.2 空的情感指令不进 parameters',
    !('instruction' in buildRequest(t, { ...CTX, instruction: '' }).body.parameters));
  const r = await audioVia(t, async () => ({ status: 200, contentType: 'audio/mpeg', bytes: bytesOf('MP3') }));
  eq('3.3 音频字节直接返回', [...r.bytes], [...bytesOf('MP3')]);
}
{
  const t = tplOf('dashscope-qwen-tts', 'tts.synthesize');
  let fetched = null;
  const r = await audioVia(t, async () => ({ status: 200, contentType: 'application/json', json: { output: { audio: { url: 'https://cdn/a.mp3' } } } }),
    async (u) => { fetched = u; return { bytes: bytesOf('WAVV'), mime: 'audio/wav' }; });
  eq('3.4 远端 URL 自动下载（decode:url）', fetched, 'https://cdn/a.mp3');
  eq('3.5 下载后给到字节', [...r.bytes], [...bytesOf('WAVV')]);
}
{
  const t = tplOf('minimax-t2a', 'tts.synthesize');
  const req = buildRequest(t, { ...CTX, format: 'mp3', speed: 1 });
  eq('3.6 group_id 走 query、取自第二个密钥槽', req.query, { group_id: 'grp-9' });
  const r = await audioVia(t, async () => ({ status: 200, contentType: 'application/json', json: { data: { audio: '48656c6c6f' } } }));
  eq('3.7 hex 解码成字节', [...r.bytes], [...bytesOf('Hello')]);
}
{
  const t = tplOf('volc-tts', 'tts.synthesize');
  const req = buildRequest(t, CTX);
  eq('3.8 火山两个 header 各取一个密钥槽（不再拆 appid|token）',
    [req.headers['X-Api-App-Key'], req.headers['X-Api-Access-Key']], ['sk-abcdefghij1234', 'grp-9']);
}
{
  const t = tplOf('dashscope-qwen-tts', 'tts.synthesize');
  await audioVia(t, async () => ({ status: 400, contentType: 'application/json', json: { code: 'InvalidParameter', message: 'Model not exist.' } }))
    .then(() => check('3.9 上游错误必须抛出且带原文', false))
    .catch((e) => check('3.9 上游错误必须抛出且带原文', /InvalidParameter.*Model not exist\./.test(e.message), e.message));
}

// ---------- 4. 异步轮询 ----------
console.log('\n[4] 异步任务');
{
  const gen = tplOf('dashscope-image-async', 'image.generate');
  const query = tplOf('dashscope-image-async', 'image.query');
  let polls = 0;
  const send = async (req) => {
    if (req.method === 'GET') {
      polls += 1;
      const status = polls < 2 ? 'RUNNING' : 'SUCCEEDED';
      return { status: 200, contentType: 'application/json', json: { output: { task_status: status, results: [{ url: 'https://cdn/r.png' }] } } };
    }
    return { status: 200, contentType: 'application/json', json: { output: { task_id: 't-77' } } };
  };
  const r = await callEndpoint(gen, { ...CTX, prompt: '橘猫' }, {
    send, sleep: async () => {}, fetchBytes: async (u) => ({ bytes: bytesOf('PNG'), mime: u }),
  }, { 'image.query': query });
  eq('4.1 轮询次数符合 mock', polls, 2);
  eq('4.2 步骤数 = 提交 + 两次查询', r.steps.length, 3);
  eq('4.3 taskId 被登记', r.values.taskId, 't-77');
  eq('4.4 完成后再取产物 URL 并下载', r.mime, 'https://cdn/r.png');
  eq('4.5 查询请求用 {taskId} 拼 URL', readPath(r.steps[1], '0.url') ?? r.steps[1].url, 'https://x.test/api/v1/services/aigc/tasks/t-77');

  const failSend = async (req) => req.method === 'GET'
    ? { status: 200, contentType: 'application/json', json: { output: { task_status: 'FAILED' } } }
    : { status: 200, contentType: 'application/json', json: { output: { task_id: 't-1' } } };
  await callEndpoint(gen, { ...CTX, prompt: 'x' }, { send: failSend, sleep: async () => {} }, { 'image.query': query })
    .then(() => check('4.6 任务失败要抛', false))
    .catch((e) => check('4.6 任务失败要抛', /任务失败/.test(e.message), e.message));

  let clock = 0;
  await callEndpoint(gen, { ...CTX, prompt: 'x' }, {
    send: async () => (clock < 1 ? (clock += 1, { status: 200, contentType: 'application/json', json: { output: { task_id: 't-2' } } })
      : { status: 200, contentType: 'application/json', json: { output: { task_status: 'RUNNING' } } }),
    sleep: async () => { clock += 999_999; },
    now: () => clock,
  }, { 'image.query': query })
    .then(() => check('4.7 超时要抛', false))
    .catch((e) => check('4.7 超时要抛', /轮询超时/.test(e.message), e.message));

  await callEndpoint(gen, { ...CTX, prompt: 'x' }, { send: async () => ({ status: 200, contentType: 'application/json', json: { output: {} } }), sleep: async () => {} }, {})
    .then(() => check('4.8 异步缺查询模板 → 明确报错（不是运行时瞎猜）', false))
    .catch((e) => check('4.8 异步缺查询模板 → 明确报错（不是运行时瞎猜）', /image\.query/.test(e.message), e.message));
}

// ---------- 5. 密钥打码 ----------
console.log('\n[5] 打码');
{
  const t = tplOf('dashscope-cosyvoice', 'tts.synthesize');
  const raw = buildRequest(t, CTX);
  const red = redact(raw, CTX);
  check('5.1 原文不出现在 headers', !JSON.stringify(red.headers).includes('sk-abcdefghij1234'), red.headers.Authorization);
  check('5.2 打码后仍看得出是哪把钥匙（前缀 + 长度）', /^Bearer sk-a\*{4}（长度 \d+）$/.test(red.headers.Authorization), red.headers.Authorization);
  check('5.3 body 保持可序列化结构', typeof red.body === 'object' && red.body.input.text === INJECT_FIXTURE.text);
}

console.log(`\n===== ${failed ? `${failed} 项失败` : '全部通过'} =====`);
process.exit(failed ? 1 : 0);
