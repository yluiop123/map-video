/**
 * verify-request-engine.mjs — 引擎 + 内置模板的离线回归（不联网、不动库）
 *
 * 覆盖：路径两种写法与未命中、三层参数取值优先级、`${}` 求值（类型保留 / 可选参数没填即删键 /
 *       没声明的占位符点名）、headers 逐请求覆盖、outputs 隐式流转、hotFix 数据驱动转换、
 *       产物四种封装（binary / hex / base64 / url），url 一律当场下载、
 *       异步两步（提交 → 两枚举判定 → 取产物）、克隆的三种接法（单独上传 / base64 / 表单带入，含「上游不回音色 id」那一类）、
 *       成功码（0 / success）不算错、密钥打码、模板自检，
 *       以及全部内置模板逐份试构造。
 * 运行：node --experimental-strip-types tools/verify-request-engine.mjs
 */
import {
  REQ_KEYS, applyOutputs, buildRequest, classify, errorOf, openKeysOf, readPath, referencesArg, trialKeysOf, visibleOptions,
  redact, requestOf, runClone, runSync, secretsOf, slotsOf, submitAsync, queryOnce, validateTemplate, EngineError,
  retriable,
} from '../src/lib/request-engine.ts';
import { SEED_TEMPLATES, seedTemplate } from '../src/lib/template-seed.ts';

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed += 1;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail !== undefined && !pass ? `\n         ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};
const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
  : v);
const eq = (name, got, want) => check(name, JSON.stringify(canon(got)) === JSON.stringify(canon(want)), { got, want });
const throws = async (name, fn, want) => {
  try { await fn(); check(name, false, '没抛错'); }
  catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    check(name, !want || (typeof want === 'function' ? want(e) : m.includes(want)), m);
  }
};

/** 一条实例：取值全在 values 两包里（baseUrl / 密钥也是模板声明出来的普通参数） */
const inst = (tplId, o = {}) => ({
  id: `prov_${tplId}`, tplId, name: tplId, sync: o.sync ?? true,
  values: {
    instance: { baseUrl: 'https://x.example/v1', apiKey: 'sk-abcdefghij1234', model: 'm-instance', ...o.instance },
    requests: o.requests ?? {},
  },
});

/** 假传输：按 URL 关键字命中 canned，并把发出去的请求记下来 */
const mk = (canned) => {
  const sent = [];
  const fetches = [];
  const deps = {
    send: async (r) => {
      sent.push(r);
      // 同一 URL 可以排多条响应（轮询就是靠它演 RUNNING → SUCCEEDED）
      const at = canned.findIndex((c) => r.url.includes(c.on) || c.on === '*');
      if (at < 0) return { status: 404, text: 'no canned' };
      const hit = canned.length > 1 && canned.filter((c) => r.url.includes(c.on)).length > 1 ? canned.splice(at, 1)[0] : canned[at];
      return hit.res();
    },
    fetchBytes: async (u, headers) => { fetches.push({ u, headers }); return { bytes: new Uint8Array([1, 2, 3, 4]), mime: 'audio/mpeg' }; },
  };
  return { deps, sent, fetches };
};
const json = (o, status = 200) => () => ({ status, contentType: 'application/json', json: o });
const bytesOf = (o) => () => ({ status: 200, contentType: 'application/octet-stream', bytes: o });

// ========== 1. 路径 ==========
console.log('\n[1] 路径取值');
const DOC = { output: { choices: [{ message: { content: [{ image: 'u' }] } }], results: [{ url: 'r' }], task_status: 'SUCCEEDED' } };
eq('1.1 方括号下标', readPath(DOC, 'output.choices[0].message.content[0].image'), 'u');
eq('1.2 纯点号下标同样收', readPath(DOC, 'output.results.0.url'), 'r');
check('1.3 越界给 undefined（不是空数组）', readPath(DOC, 'output.choices[9].message') === undefined, readPath(DOC, 'output.choices[9].message'));
eq('1.4 完整 $ 写法也收', readPath(DOC, '$.output.task_status'), 'SUCCEEDED');
check('1.5 路径为空 = 不取', readPath(DOC, '') === undefined);

// ========== 2. 三层参数与求值 ==========
console.log('\n[2] 三层参数与求值');
{
  const tpl = seedTemplate('deepseek-chat');
  const i = inst('deepseek-chat', { requests: { 'sync.submit': { model: 'deepseek-flash', temperature: 0.6 } } });
  const { req, missing } = buildRequest(tpl, i, 'sync.submit', { systemPrompt: '你是助手', userPrompt: '写三行' });
  eq('2.1 请求级覆盖实例级（同名 key 各存各的）', req.body.model, 'deepseek-flash');
  eq('2.2 数字参数保留类型', req.body.temperature, 0.6);
  eq('2.3 写死在模板里的字面量原样带走', req.body.stream, false);
  // （max_tokens 现在有内置默认值，删键这一条改拿没默认值的 reasoning_effort 验）
  eq('2.4 没填的可选参数连键删掉', 'reasoning_effort' in req.body, false);
  eq('2.5 嵌套对象里全空 → 父键一起删（不留半成品 thinking）', 'thinking' in req.body, false);
  eq('2.6 调用级参数进骨架', [req.body.messages[0].content, req.body.messages[1].content], ['你是助手', '写三行']);
  eq('2.7 baseUrl 求值后就是完整地址（不再二次拼接）', req.url, 'https://x.example/v1/chat/completions');
  eq('2.8 密钥从实例参数进 header', req.headers.Authorization, 'Bearer sk-abcdefghij1234');
  check('2.9 声明过的参数没填 = 不算错，不点名', missing.size === 0, [...missing]);
  const typo = buildRequest({ ...tpl, sync: { submit: { ...tpl.sync.submit, body: { a: '${hasingxie}' } } } }, i, 'sync.submit', {}).missing;
  check('2.10 占位符打错字 → 点名（别静默发出去）', [...typo].includes('hasingxie'), [...typo]);
  const deep = buildRequest(tpl, inst('deepseek-chat', { requests: { 'sync.submit': { thinking: 'enabled', reasoningEffort: 'high' } } }), 'sync.submit', { systemPrompt: 'a', userPrompt: 'b' }).req;
  eq('2.11 枚举值原样进嵌套对象', deep.body.thinking, { type: 'enabled' });
  check('2.12 没选思考强度时整个 thinking 键消失', !('thinking' in buildRequest(tpl, i, 'sync.submit', { systemPrompt: 'a', userPrompt: 'b' }).req.body));
  eq('2.13 枚举参数按原值发出', deep.body.reasoning_effort, 'high');

  // 一张参数表：谁「现场给」不看声明在哪张表，看这一格引用了谁、谁没有来源
  const tOpen = {
    ...tpl,
    sync: {
      submit: {
        path: '${baseUrl}/x?m=${mark}',
        requestParams: [
          { key: 'mark', label: '标记' },                        // 没来源 → 现场给
          { key: 'size', label: '尺寸', defaultValue: '1024' },   // 有默认值 → 不用问
          { key: 'model', label: '模型' },                        // 实例里填了 → 不用问
          { key: 'prompt', label: '画面描述' },                   // 没来源 → 现场给
        ],
        body: { prompt: '${prompt}', size: '${size}', model: '${model}' },
      },
    },
  };
  eq('2.14 引用了又没来源的才算「现场给」（不看声明在哪张表）', openKeysOf(tOpen, i, 'sync.submit'), ['mark', 'prompt']);
  const filled = { ...i, values: { ...i.values, requests: { 'sync.submit': { prompt: '一只猫' } } } };
  eq('2.15 在实例里填上之后就不再要现场给', openKeysOf(tOpen, filled, 'sync.submit'), ['mark']);
  // 试调用那一栏只收「别处没有格子可填」的名字：声明出来的在上面那张参数表里填，不重复一栏
  eq('2.16 声明出来的（mark / prompt 都算）不在试调用里重复一格', trialKeysOf(tOpen, i, 'sync.submit'), []);
  eq('2.17 seed 的出图格：画面描述走参数表，试调用不再摆一个框', trialKeysOf(seedTemplate('qwen-image'), i, 'sync.submit'), []);
  eq('2.18 剩下的才是它该收的：那个文件（引擎注入、没有别处可填）',
    trialKeysOf(seedTemplate('minimax-voice'), inst('minimax-voice'), 'clone'), ['voiceData']);

  // 候选值带分组 / 备注 / 适用模型：音色表就是这么挂到模板上的（`voiceTable` 那一档）
  const voiceParams = [
    { key: 'model', label: '模型', valueType: 'enum', options: ['m-flash', 'm-vc'], defaultValue: 'm-flash' },
    { key: 'voice', label: '音色', valueType: 'enum', voiceTable: true, options: [
      { value: 'Ann', label: '安', group: '女声', note: '中英多语' },
      { value: 'Bob', label: '博', group: '男声', models: ['m-flash'] },
      { value: 'Cy', label: '赛', group: '中性', models: ['m-vc'] },
    ] },
  ];
  const tVoice = { ...tpl, sync: { submit: { path: '${baseUrl}/s', method: 'POST', body: { voice: '${voice}' }, requestParams: voiceParams } } };
  eq('2.19 候选值按当前 model 的取值过滤（没标 models 的一直在）',
    visibleOptions(tVoice, inst('deepseek-chat', { instance: { model: 'm-flash' } }), 'sync.submit', 'voice').map((o) => o.value), ['Ann', 'Bob']);
  eq('2.20 实例把 model 改成 -vc → 换一批候选值',
    visibleOptions(tVoice, inst('deepseek-chat', { requests: { 'sync.submit': { model: 'm-vc' } } }), 'sync.submit', 'voice').map((o) => o.value), ['Ann', 'Cy']);
  const badDef = { ...tVoice, sync: { submit: { ...tVoice.sync.submit, requestParams: voiceParams.map((p) => (p.key === 'voice' ? { ...p, defaultValue: 'Nobody' } : p)) } } };
  check('2.21 enum 的默认值不在候选值里 → 点名（界面选不到、真发却照它发）',
    validateTemplate(badDef).some((x) => x.includes('不在候选值')), validateTemplate(badDef));

  // 搬表快照：音色表进了 seed 之后，条数与分组必须与改造前逐字一致 —— 少一条不会报错，只会少一个音色
  const cat = (id, model) => visibleOptions(seedTemplate(id), inst(id, { instance: { model } }), 'sync.submit', 'voice');
  eq('2.22 千问音色表 38 条；换 -vc 模型一条不吃（实测系统音色喂它必拒）',
    [cat('qwen-tts', 'qwen3-tts-flash').length, cat('qwen-tts', 'qwen3-tts-vc-2026-01-22').length], [38, 0]);
  eq('2.23 ElevenLabs 21 条（男 13 / 女 7 / 中性 1，中性是官方 labels 给的）',
    cat('elevenlabs-voice', 'eleven_multilingual_v2').reduce((a, o) => ({ ...a, [o.group]: (a[o.group] ?? 0) + 1 }), {}),
    { 男声: 13, 女声: 7, 中性: 1 });
}

// ========== 3. headers 覆盖 / outputs / 发音修正 ==========
console.log('\n[3] headers 覆盖、outputs 流转、hotFix');
{
  const tpl = seedTemplate('qwen-image');
  const i = inst('qwen-image', { sync: false });
  const s = buildRequest(tpl, i, 'sync.submit', { prompt: '猫' }).req;
  const a = buildRequest(tpl, i, 'async.submit', { prompt: '猫' }).req;
  // 请求头**逐条各一份**（模板级那份已下线）：异步开关头只有异步提交那条该带，
  // 查询是 GET，也就没人替它声明 Content-Type。
  eq('3.1 异步开关头只在异步提交那条上',
    [s.headers['X-DashScope-Async'], a.headers['X-DashScope-Async']], [undefined, 'enable']);
  const q = buildRequest(tpl, i, 'async.query', {}, { taskId: 'T9' }).req;
  eq('3.1b 查询那条只带认证', [q.headers.Authorization !== undefined, q.headers['Content-Type'] === undefined], [true, true]);
  const noHdr = { ...tpl, sync: { submit: { ...tpl.sync.submit, headers: undefined } } };
  check('3.1c 没配头的那条就是没头（不会再从模板级继承）',
    Object.keys(buildRequest(noHdr, i, 'sync.submit', { prompt: '猫' }).req.headers).length === 0);
  eq('3.2 两条提交各带自己的 Authorization', [s.headers.Authorization, a.headers.Authorization], ['Bearer sk-abcdefghij1234', 'Bearer sk-abcdefghij1234']);
  eq('3.3 outputs 把 task_id 收成中间变量', applyOutputs({ output: { task_id: 'T9' } }, { taskId: 'output.task_id' }), { taskId: 'T9' });
  eq('3.4 查询请求直接 ${taskId}', buildRequest(tpl, i, 'async.query', {}, { taskId: 'T9' }).req.url, 'https://x.example/v1/tasks/T9');
  // 千问 CosyVoice 端点（/services/audio/tts/SpeechSynthesizer）要的就是上游那份对象形状：
  // 界面存进项目 hotFix 的就是它，声明成 json 就原样进 body —— 引擎不再按厂商改名（没有 transform 那格了）
  const t4 = { ...tpl, sync: { submit: { path: '${baseUrl}/x', body: { input: { text: '${text}', hot_fix: '${hotFix}' } }, requestParams: [{ key: 'text', label: '文本' }, { key: 'hotFix', label: '发音修正', valueType: 'json' }] } } };
  eq('3.5 hotFix 按声明原样进 body（上游对象形状）',
    buildRequest(t4, inst('x'), 'sync.submit', { text: '重庆', hotFix: { pronunciation: [{ 重庆: 'chong2 qing4' }], replace: [] } }).req.body.input.hot_fix,
    { pronunciation: [{ 重庆: 'chong2 qing4' }], replace: [] });
  eq('3.6 声明成 json 的字符串会解析成形（控件只会给字符串）',
    buildRequest(t4, inst('x'), 'sync.submit', { text: '重庆', hotFix: '{"replace":[{"AI":"人工智能"}]}' }).req.body.input.hot_fix,
    { replace: [{ AI: '人工智能' }] });
  check('3.7 没填修正 → hot_fix 这个键整个消失（不发给上游）',
    buildRequest(t4, inst('x'), 'sync.submit', { text: '重庆' }).req.body.input.hot_fix === undefined);
  // 内置那份「千问语音（音量 / 发音修正）」：机制之外还要证明**这一格真的接上了**（旧模板不认，界面上因此点名）
  const audio = seedTemplate('qwen-audio-tts');
  const audioBody = buildRequest(audio, inst('qwen-audio-tts'), 'sync.submit', { text: '重庆', hotFix: { pronunciation: [{ 重庆: 'chong2 qing4' }] } }).req.body;
  eq('3.7b seed 的 SpeechSynthesizer 格：hot_fix 原样进 input、volume 是数字不是字符串',
    [audioBody.input.hot_fix, audioBody.input.volume],
    [{ pronunciation: [{ 重庆: 'chong2 qing4' }] }, 100]);
  check('3.7c 这一格引用了 hotFix（界面上因此不说「不认这个参数」）',
    referencesArg(audio, 'sync.submit', 'hotFix') && !referencesArg(seedTemplate('qwen-tts'), 'sync.submit', 'hotFix'));
  const t3 = { ...tpl, sync: { submit: { path: '${baseUrl}/x', body: { n: '${n}' }, requestParams: [{ key: 'n', label: '个数', valueType: 'number' }] } } };
  eq('3.8 字符串数字按声明转成数字（只看 valueType，没有加工那格）', buildRequest(t3, inst('x'), 'sync.submit', { n: '3' }).req.body.n, 3);
}

// ========== 4. 产物四种封装（binary / hex / base64 / url） ==========
console.log('\n[4] 产物还原');
{
  const tts = seedTemplate('qwen-tts');
  const d = mk([{ on: 'multimodal-generation', res: json({ output: { audio: { url: 'https://cdn/a.wav' } } }) }]);
  const out = await runSync(tts, inst('qwen-tts'), d.deps, 'sync.submit', { text: '你好', voice: 'Cherry' });
  eq('4.1 url 产物当场下载（不留时效链接）', out.bytes?.length, 4);
  eq('4.2 下载用的就是那条链接', d.fetches.map((f) => f.u), ['https://cdn/a.wav']);
  check('4.3 裸 GET（链接自带签名，不必再带鉴权头）', !d.fetches[0].headers || Object.keys(d.fetches[0].headers).length === 0, d.fetches[0].headers);

  const bin = seedTemplate('qwen-tts');
  const d2 = mk([{ on: '*', res: bytesOf(new Uint8Array([9, 9, 9])) }]);
  const t2 = { ...bin, sync: { submit: { ...bin.sync.submit, artifactForm: 'binary', outputs: undefined } } };
  eq('4.4 binary = 响应体即产物（不需要固定项）', Array.from((await runSync(t2, inst('qwen-tts'), d2.deps, 'sync.submit', { text: 'a', voice: 'v' })).bytes ?? []), [9, 9, 9]);

  const hexT = { ...bin, sync: { submit: { path: '${baseUrl}/x', body: {}, artifactForm: 'hex', outputs: { artifact: 'data.audio' } } } };
  const d3 = mk([{ on: '/x', res: json({ data: { audio: 'deadbeef' } }) }]);
  eq('4.5 hex 解码（产物只认固定项 artifact 这一个名字）', Array.from((await runSync(hexT, inst('qwen-tts'), d3.deps, 'sync.submit', {})).bytes ?? []), [0xde, 0xad, 0xbe, 0xef]);
  const b64T = { ...hexT, sync: { submit: { ...hexT.sync.submit, artifactForm: 'base64' } } };
  const d4 = mk([{ on: '/x', res: json({ data: { audio: 'AAEC' } }) }]);
  eq('4.6 base64 解码', Array.from((await runSync(b64T, inst('qwen-tts'), d4.deps, 'sync.submit', {})).bytes ?? []), [0, 1, 2]);

  const noProd = await runSync(seedTemplate('deepseek-chat'), inst('deepseek-chat'), mk([{ on: '/chat/completions', res: json({ choices: [{ message: { content: '好' } }] }) }]).deps,
    'sync.submit', { systemPrompt: 'a', userPrompt: 'b' });
  check('4.7 文案类那一格没填产物形式（= none）→ bytes 留空不抛错', noProd.bytes === undefined && noProd.values.content === '好', noProd.bytes);
}

// ========== 5. 异步两步 ==========
console.log('\n[5] 异步：提交 → 轮询 → 取产物');
{
  const tpl = seedTemplate('qwen-image');
  const i = inst('qwen-image', { sync: false });
  const { deps, sent } = mk([
    { on: 'image-generation', res: json({ output: { task_id: 'T9' } }) },
    { on: '/tasks/T9', res: json({ output: { task_status: 'RUNNING' } }) },
    // 2026-09-23 实测：异步查询回的图片与同步同一路径（output.choices[0].message.content[0].image），
    // 文档写的 output.results[].url 是旧形状 —— 桩数据照实测写，别照文档写
    { on: '/tasks/T9', res: json({ output: { task_status: 'SUCCEEDED', choices: [{ message: { content: [{ image: 'https://cdn/i.png' }] } }] } }) },
  ]);
  const first = await submitAsync(tpl, i, deps, { prompt: '猫' });
  eq('5.1 提交拿到 taskId', first.taskId, 'T9');
  eq('5.2 中间态 = 继续查', (await queryOnce(tpl, i, deps, first.values)).outcome, 'pending');
  const ok = await queryOnce(tpl, i, deps, first.values);
  eq('5.3 命中成功值就取回产物', [ok.outcome, ok.bytes?.length], ['success', 4]);
  eq('5.4 查询打了两次同一个地址', sent.filter((x) => x.url.includes('/tasks/')).length, 2);
  eq('5.5 查询是 GET 不带体', [sent[1].method, sent[1].body], ['GET', undefined]);
  const bad = mk([{ on: '/tasks/T8', res: json({ code: 'Throttling', message: '太挤了', output: { task_status: 'FAILED' } }) }]);
  await throws('5.6 失败把上游 code/message 原样抛回', () => queryOnce(tpl, i, bad.deps, { taskId: 'T8' }), 'Throttling');
  eq('5.7 两个列表都没命中 = pending', classify('PENDING', ['SUCCEEDED'], ['FAILED']), 'pending');
  // 2026-09-23 真机抓到的完整响应（task 276a888f…，排队 9 分钟）原样留一份：
  // 谁把产物路径改回文档写法，这条就会红
  const REAL = { request_id: 'x', output: { task_id: '276a888f', task_status: 'SUCCEEDED', submit_time: '2026-09-23 20:34:42.491', end_time: '2026-09-23 20:43:57.991', choices: [{ message: { content: [{ type: 'image', image: 'https://cdn.real/i.png' }] }, finish_reason: 'stop' }], rewrite_status: 'success' }, usage: { output_image_count: 1 } };
  eq('5.7b 真机响应的产物路径取得到', applyOutputs(REAL, tpl.async.query.outputs).artifact, 'https://cdn.real/i.png');
  eq('5.8 状态值大小写不敏感（各家写法不一）', classify('Succeeded', ['succeeded'], ['failed']), 'success');
  await throws('5.9 5xx / 429 带状态码抛回（调度层才知道能不能重试）', async () => {
    const d = mk([{ on: '/tasks/', res: () => ({ status: 429, text: 'too many' }) }]);
    try { await queryOnce(tpl, i, d.deps, { taskId: 'T1' }); }
    catch (e) { if (e.status !== 429) throw new EngineError(`状态码没带回来：${e.status}`); throw e; }
  }, (e) => e.status === 429);
  // 任务号取不到 = 后面没法查，必须当场点名（旧实现会「拿第一个值」歪打正着，把错误路径藏起来）
  await throws('5.10 提交没交出任务号 → 点名，不再拿第一个值兜底', async () => {
    const d = mk([{ on: 'image-generation', res: json({ output: { request_id: 'R1' } }) }]);
    return submitAsync(tpl, i, d.deps, { prompt: '猫' });
  }, (e) => /任务号/.test(String(e?.message)));
}

// ========== 6. 克隆 ==========
console.log('\n[6] 音色克隆');
{
  const qwen = seedTemplate('qwen-tts');
  const d = mk([{ on: 'customization', res: json({ output: { voice: 'qwen-voice-77' } }) }]);
  const wav = { bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]), mime: 'audio/x-wav', name: 'reference.wav' };
  const r = await runClone(qwen, inst('qwen-tts'), d.deps, { voiceData: wav, model: 'qwen3-tts-vc-2026-01-22', preferredName: 'mv' });
  eq('6.1 接法二「base64」：文件进 body 就是 data URI，一步拿音色 ID', [r.values.voiceId, d.sent.length], ['qwen-voice-77', 1]);
  const body = d.sent[0].body;
  eq('6.2 复刻目标模型走请求级参数（合成必须同款）', body.input.target_model, 'qwen3-tts-vc-2026-01-22');
  eq('6.3 data URI 用的就是这个文件自己的 mime', body.input.audio.data, `data:audio/x-wav;base64,${btoa('RIFF')}`);
  eq('6.3b 外层 model 是写死的注册服务名', body.model, 'qwen-voice-enrollment');

  const up = {
    ...qwen, caps: { ...qwen.caps, clone: true, cloneVia: 'upload' },
    // 接法一「单独上传」：上传那一格发 multipart，文件保持成分片（不转 base64）
    // 两边的文件都写同一个 `${voiceData}` —— 它不在参数表里声明，是引擎注入的那个名字
    upload: {
      path: '${baseUrl}/files/upload', method: 'POST', headers: { Authorization: 'Bearer ${apiKey}' },
      form: { file: '${voiceData}', purpose: 'voice_clone', mime_type: '${voiceData.mime}' }, outputs: { artifact: 'file.file_id' },
    },
    clone: { path: '${baseUrl}/v1/voice_clone', body: { file_id: '${voiceData}', name: '${preferredName}' }, outputs: { voiceId: 'voice_id' } },
  };
  const d2 = mk([{ on: 'files/upload', res: json({ file: { file_id: 'F7' } }) }, { on: 'voice_clone', res: json({ voice_id: 'mm-7' }) }]);
  const r2 = await runClone(up, inst('qwen-tts'), d2.deps, { voiceData: wav, preferredName: 'mv' });
  eq('6.4 单独上传：先传拿文件引用再克隆', [r2.values.voiceId, d2.sent.map((x) => x.url.split('/').pop())], ['mm-7', ['upload', 'voice_clone']]);
  eq('6.5 上传交回的引用注入成下一步的 ${voiceData}（克隆那格不用换一个名字）', d2.sent[1].body.file_id, 'F7');
  // 走「先上传」这条路时文件不转 base64：交出去的是二进制分片（带自己的 mime 与文件名）+ 普通字段
  eq('6.6 上传那条交的是 multipart：分片仍是文件值、别的字段是字符串',
    [d2.sent[0].form.file === wav, d2.sent[0].form.purpose, d2.sent[0].body], [true, 'voice_clone', undefined]);
  eq('6.7 ${它.mime} 单独注入：拿到的就是 audio/x-wav 这个串', d2.sent[0].form.mime_type, 'audio/x-wav');
  eq('6.8 上传那条没带模板级 Content-Type（逐槽各配一份）', d2.sent[0].headers, { Authorization: 'Bearer sk-abcdefghij1234' });

  // 同一个接法，上传回来的可能是文件号也可能是地址 —— 只差固定项填的路径，下一步写的还是 ${voiceData}
  const upUrl = {
    ...up,
    upload: { ...up.upload, form: { file: '${voiceData}' }, outputs: { artifact: 'file.url' } },
    clone: { path: '${baseUrl}/v1/voice_clone', body: { audio_url: '${voiceData}', name: '${preferredName}' }, outputs: { voiceId: 'voice_id' } },
  };
  const d3 = mk([{ on: 'files/upload', res: json({ file: { url: 'https://cdn/ref.wav' } }) }, { on: 'voice_clone', res: json({ voice_id: 'mm-8' }) }]);
  await runClone(upUrl, inst('qwen-tts'), d3.deps, { voiceData: wav, preferredName: 'mv' });
  eq('6.9 上传返回 url 的那类：注入的就是那个地址', d3.sent[1].body.audio_url, 'https://cdn/ref.wav');
  const noRef = { ...up, upload: { ...up.upload, outputs: {} } };
  await throws('6.9b 上传那一格没交出引用 → 当场点名，不发半个克隆',
    () => runClone(noRef, inst('qwen-tts'), mk([{ on: 'files/upload', res: json({}) }]).deps, { voiceData: wav }), '没交出文件引用');

  // 接法三「表单带入」：克隆那一格自己发 multipart，没有 Body（ElevenLabs 那类）
  const frm = {
    ...qwen, caps: { ...qwen.caps, clone: true, cloneVia: 'form' },
    clone: {
      path: '${baseUrl}/v1/voices/add', method: 'POST', headers: { 'xi-api-key': '${apiKey}' },
      requestParams: [{ key: 'voiceName', label: '音色名' }],
      form: { files: '${voiceData}', name: '${voiceName}', language_code: 'zh' },
      body: { this_must_not_be_sent: '${voiceName}' },
      outputs: { voiceId: 'voice_id' },
    },
  };
  check('6.10 三选一推出来的槽：只有 form 才多上传那一格',
    [slotsOf(frm).includes('upload'), slotsOf(up).includes('upload'), slotsOf(qwen).includes('upload')], [false, true, false]);
  const d4 = mk([{ on: 'voices/add', res: json({ voice_id: 'el-7' }) }]);
  const r4 = await runClone(frm, inst('qwen-tts'), d4.deps, { voiceData: wav, voiceName: 'mv' });
  eq('6.11 表单带入：一次调用（没有上传那一格），音色 ID 从克隆响应取', [r4.values.voiceId, d4.sent.length], ['el-7', 1]);
  eq('6.12 克隆那格交的是 multipart：文件仍是分片、别的参数是字段',
    [d4.sent[0].form.files === wav, d4.sent[0].form.name, d4.sent[0].form.language_code], [true, 'mv', 'zh']);
  eq('6.13 一格的两种形状不会同时发出：form 模式下 body 写了也不发', d4.sent[0].body, undefined);
  eq('6.14 multipart 那格不声明 Content-Type（boundary 归传输层）', d4.sent[0].headers, { 'xi-api-key': 'sk-abcdefghij1234' });
  eq('6.15 现场要给的参数从表单反推（不靠第二张表标）', openKeysOf(frm, inst('qwen-tts'), 'clone').sort(), ['voiceData', 'voiceName'].sort());

  // MiniMax 那份真 seed：先上传拿**整数**文件号 → 复刻（它的成功响应不回音色 id，名字是本轮自己起的）
  const mm = seedTemplate('minimax-voice');
  const OK = { base_resp: { status_code: 0, status_msg: 'success' } };
  const d5 = mk([
    { on: 'files/upload', res: json({ file: { file_id: 1234567890, purpose: 'voice_clone' }, ...OK }) },
    { on: 'voice_clone', res: json({ input_sensitive: false, demo_audio: '', ...OK }) },
  ]);
  const r5 = await runClone(mm, inst('minimax-voice'), d5.deps, { voiceData: wav, voiceId: 'mvsample' });
  eq('6.16 上游不回音色 id 的那类：引擎拿本轮发出去的名字当结果', [r5.values.voiceId, d5.sent.length], ['mvsample', 2]);
  eq('6.17 上传交回的文件号是整数，注入下一格时没被转成字符串', d5.sent[1].body, { file_id: 1234567890, voice_id: 'mvsample' });
  // 它家成功 = HTTP 200 + status_code:0 + status_msg:'success'，三个值全是真值 —— 老逻辑会把每一次成功读成失败
  const d6 = mk([{ on: 't2a_v2', res: json({ data: { audio: '89504e47', status: 2 }, ...OK }) }]);
  const r6 = await runSync(mm, inst('minimax-voice'), d6.deps, 'sync.submit', { text: '喂', voice: 'mvsample' });
  eq('6.18 status_code=0 不算错（产物按 hex 还原成字节）', Array.from(r6.bytes ?? []), [0x89, 0x50, 0x4e, 0x47]);
  eq('6.19 真报错了照原样抛回', errorOf({ errorCode: 1008, error: 'insufficient balance' }, { status: 200 }), '1008 · insufficient balance');

  // 接法五「先传平台拿临时地址」：上传那一格发之前先问一次凭证（seed 里那份 qwen-audio-tts 就是这样）
  const au = seedTemplate('qwen-audio-tts');
  const POLICY = { data: { policy: 'P1', signature: 'S1', upload_host: 'https://oss.example/tmp', upload_dir: 'dashscope-instant/abc', oss_access_key_id: 'AK', x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true' } };
  const d7 = mk([
    { on: 'uploads?action=getPolicy', res: json(POLICY) },
    { on: 'oss.example/tmp', res: json({}) },
    { on: 'customization', res: json({ output: { voice_id: 'qwen-audio-mv-1' } }) },
  ]);
  const r7 = await runClone(au, inst('qwen-audio-tts'), d7.deps, { voiceData: wav, prefix: 'mv' });
  eq('6.21 三步：先问凭证 → 拿凭证 POST 文件 → 克隆', [r7.values.voiceId, d7.sent.length], ['qwen-audio-mv-1', 3]);
  eq('6.22 第一问带 model（平台按模型给目录与配额；实例填的赢过声明默认）', d7.sent[0].url, 'https://x.example/v1/uploads?action=getPolicy&model=m-instance');
  eq('6.23 表单字段全来自第一问的响应，文件仍是最后一个分片',
    [d7.sent[1].form.policy, d7.sent[1].form.OSSAccessKeyId, d7.sent[1].form.key, d7.sent[1].form.file === wav],
    ['P1', 'AK', 'dashscope-instant/abc/reference.wav', true]);
  eq('6.24 第二问的地址用第一问交回的 upload_host', d7.sent[1].url, 'https://oss.example/tmp');
  eq('6.25 固定项「产物」写成模板串：拼出来的 oss:// 就是交给下一格的引用', d7.sent[2].body.input.url, 'oss://dashscope-instant/abc/reference.wav');
  eq('6.26 克隆那一格带上去中转存储取文件的头', d7.sent[2].headers['X-DashScope-OssResourceResolve'], 'enable');
  eq('6.27 步骤里那一问单独成一步并标出来（试调用要看得清是哪一步）',
    [r7.steps.length, r7.steps[0].label, r7.steps[1].label], [3, '先问一次', undefined]);
  await throws('6.20 失败那一步把响应原文挂在错误上带回来（「试调用」要看的就是它）',
    () => runSync(mm, inst('minimax-voice'),
      mk([{ on: 't2a_v2', res: json({ data: null, base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }) }]).deps,
      'sync.submit', { text: '喂', voice: 'v' }),
    (e) => /1008/.test(String(e?.message)) && String(e?.step?.raw).includes('insufficient balance'));
}

// ========== 7. 打码 ==========
console.log('\n[7] 密钥打码');
{
  const tpl = seedTemplate('deepseek-chat');
  const i = inst('deepseek-chat', { instance: { apiKey: 'sk-super-secret-0123456789' } });
  const r = buildRequest(tpl, i, 'sync.submit', { systemPrompt: 'a', userPrompt: 'b' }).req;
  const red = redact(r, secretsOf(tpl, i));
  check('7.1 打码后不含明文 Key', !JSON.stringify(red).includes('super-secret'), JSON.stringify(red).slice(0, 120));
  check('7.2 原请求仍在（发出去用的是它，不是打码版）', r.headers.Authorization.includes('super-secret'));
  eq('7.3 只遮声明成 secret 的那个取值', redact(r, secretsOf(tpl, i)).headers.Authorization, 'Bearer ****');
  check('7.4 baseUrl 这种非 secret 参数不遮', JSON.stringify(redact(r, secretsOf(tpl, i)).url).includes('x.example'), redact(r, []).url);
}

// ========== 8. 模板自检 ==========
console.log('\n[8] 保存前自检');
{
  check('8.1 内置模板全部自检干净', SEED_TEMPLATES.every((t) => validateTemplate(t).length === 0),
    SEED_TEMPLATES.map((t) => [t.id, validateTemplate(t)]).filter(([, x]) => x.length));
  const base = seedTemplate('qwen-image');
  check('8.2 开关要求异步、却没配查询 → 点名', validateTemplate({ ...base, async: { submit: base.async.submit } }).some((x) => x.includes('查询')));
  check('8.3 查询没配成功值 → 点名', validateTemplate({ ...base, async: { submit: base.async.submit, query: { ...base.async.query, successValues: [] } } }).some((x) => x.includes('状态值')));
  check('8.4 实例参数同名重复 → 点名', validateTemplate({ ...base, instanceParams: [...base.instanceParams, { key: 'baseUrl', label: '重' }] }).some((x) => x.includes('重复')));
  check('8.5 开了克隆却没配 clone 那一格 → 点名', validateTemplate({ ...base, category: 'tts', caps: { ...base.caps, clone: true } }).some((x) => x.includes('能力开关要求这一格')));
  // 借来的那两格要把图片那档的产物路径摘掉：文案类没有产物，留着它就是 8.16 那条要点的错
  const llmAsync = { submit: base.async.submit, query: { ...base.async.query, artifactForm: undefined, outputs: { status: 'output.task_status' } } };
  check('8.6 谁都能自己加异步（分类不限制接口形状）', validateTemplate({ ...seedTemplate('deepseek-chat'), caps: { modes: 'both', artifact: 'none' }, async: llmAsync }).length === 0,
    validateTemplate({ ...seedTemplate('deepseek-chat'), caps: { modes: 'both', artifact: 'none' }, async: llmAsync }));
  // 固定项：名字写死、路径必填 —— 漏了要在保存前就点名，而不是等运行时（status 漏填会一路查到超时）
  const noStatus = { ...base, async: { submit: base.async.submit, query: { ...base.async.query, outputs: { artifact: 'x' } } } };
  check('8.7 固定项「任务状态」没填路径 → 点名', validateTemplate(noStatus).some((x) => x.includes('任务状态')), validateTemplate(noStatus));
  const noArtifact = { ...base, sync: { submit: { ...base.sync.submit, outputs: { error: 'e' } } } };
  check('8.8 固定项「产物」没填路径 → 点名', validateTemplate(noArtifact).some((x) => x.includes('产物')), validateTemplate(noArtifact));
  const shadow = { ...base, sync: { submit: { ...base.sync.submit, outputs: { ...base.sync.submit.outputs, size: 'x.y' } } } };
  check('8.9 自定义变量与参数同名 → 点名（同一个 ${size} 会有两个来源）', validateTemplate(shadow).some((x) => x.includes('size')), validateTemplate(shadow));
  const stray = { ...base, clone: { path: '${baseUrl}/x', body: {} } };
  check('8.10 开关里不需要 clone、却留着 clone 那一格 → 点名（并说清怎么消掉）',
    validateTemplate(stray).some((x) => x.includes('克隆') && x.includes('移除这一格')), validateTemplate(stray));
  check('8.11 文案类那一格选了产物形式 → 点名', validateTemplate({ ...seedTemplate('deepseek-chat'), sync: { submit: { ...seedTemplate('deepseek-chat').sync.submit, artifactForm: 'url' } } }).length > 0);
  // 发 multipart 的那格：表是空的等于什么都没交
  const emptyForm = {
    ...seedTemplate('qwen-tts'), caps: { modes: 'sync', clone: true, cloneVia: 'upload' },
    upload: { path: '${baseUrl}/files/upload', outputs: { fileId: 'file.file_id' } },
  };
  check('8.12 上传那一格没写 multipart 字段 → 点名',
    validateTemplate(emptyForm).some((x) => x.includes('multipart')), validateTemplate(emptyForm));
  const cloneNoForm = {
    ...seedTemplate('qwen-tts'), caps: { modes: 'sync', clone: true, cloneVia: 'form' },
  };
  check('8.13 「表单带入」的克隆格没写字段 → 同样点名（判据是 multipartSlotOf，不是槽名）',
    validateTemplate(cloneNoForm).some((x) => x.includes('multipart') && x.includes('克隆')), validateTemplate(cloneNoForm));
  // 那个文件是引擎注入的固定名：再声明一份 = 同一个 ${voiceData} 两个来源
  const declaredFile = {
    ...seedTemplate('qwen-tts'),
    clone: { ...seedTemplate('qwen-tts').clone, requestParams: [...(seedTemplate('qwen-tts').clone?.requestParams ?? []), { key: 'voiceData', label: '参考音频' }] },
  };
  check('8.14 把 voiceData 当参数声明 → 点名（它是引擎注入的那个文件）',
    validateTemplate(declaredFile).some((x) => x.includes('voiceData') && x.includes('不用声明')), validateTemplate(declaredFile));
  check('8.15 内置 seed 自己不再声明它（否则上面这条会打到自己）',
    !validateTemplate(seedTemplate('qwen-tts')).some((x) => x.includes('voiceData')), validateTemplate(seedTemplate('qwen-tts')));
  // 产物形式与「产物」那一格必须配套：bin / none 下填了路径 = 没有消费者，真发会拿 JSON 响应当音频
  const binWithField = {
    ...seedTemplate('qwen-tts'),
    sync: { submit: { ...seedTemplate('qwen-tts').sync.submit, artifactForm: 'binary', outputs: { ...seedTemplate('qwen-tts').sync.submit.outputs, artifact: 'output.audio.url' } } },
  };
  check('8.16 产物形式选成 bin 却还填着「产物」路径 → 点名（这一档没人读它，说明档位错了）',
    validateTemplate(binWithField).some((x) => x.includes('产物形式') && x.includes('档位选错')), validateTemplate(binWithField));
  const noneWithField = { ...seedTemplate('deepseek-chat'), sync: { submit: { ...seedTemplate('deepseek-chat').sync.submit, outputs: { ...seedTemplate('deepseek-chat').sync.submit.outputs, artifact: 'a.b' } } } };
  const lostForm = { ...seedTemplate('qwen-image'), sync: { submit: { ...seedTemplate('qwen-image').sync.submit, artifactForm: undefined, outputs: { artifact: undefined } } } };
  check('8.15b 终点格（同步提交）没选产物形式 → 点名（产物形式逐格配，就逐格问）',
    validateTemplate(lostForm).some((x) => x.includes('这一格该交回产物')), validateTemplate(lostForm));
  check('8.17 文案类（没有产物）也一样：填了产物路径就点名',
    validateTemplate(noneWithField).some((x) => x.includes('没有产物')), validateTemplate(noneWithField));
  // 固定项「音色 ID」该不该填，看这一格自己有没有写 `${voiceId}`（上游不回 id 的那种就是靠它）
  const mmv = seedTemplate('minimax-voice');
  check('8.18 克隆格自己写 ${voiceId} 的：路径留空不点名', validateTemplate(mmv).every((x) => !x.includes('音色 ID')), validateTemplate(mmv));
  const noId = { ...mmv, clone: { ...mmv.clone, requestParams: [], body: { file_id: '${voiceData}' } } };
  check('8.19 既不填路径、又没写 ${voiceId} → 点名（克隆完拿不到 id）',
    validateTemplate(noId).some((x) => x.includes('音色 ID')), validateTemplate(noId));
  // 上传那一格的 `artifact` 是文件号（消费者是 runClone），不是产物 —— 别拿终点格那条规则误伤它
  check('8.20 上传那格填着文件号路径，不被「产物形式」那条点名',
    validateTemplate(mmv).every((x) => !x.includes('上传')), validateTemplate(mmv));
}

// ========== 9. 逐份 seed 试构造 ==========
console.log('\n[9] 内置模板逐份试构造');
for (const t of SEED_TEMPLATES) {
  const keys = REQ_KEYS.filter((k) => !!requestOf(t, k));
  let ok = true;
  let why = '';
  for (const k of keys) {
    try {
      const i = inst(t.id, { sync: !(k === 'async.submit' || k === 'async.query') });
      const args = {};
      for (const x of openKeysOf(t, i, k)) args[x] = `v-${x}`;
      // 那个文件是真的文件值：有的家在表单字段里写 `${voiceData.name}`，给字符串会当成没给值
      if ('voiceData' in args) args.voiceData = { bytes: new Uint8Array([1]), mime: 'audio/wav', name: 'ref.wav' };
      if (k === 'async.query') args.taskId = 'T1';
      const built = buildRequest(t, i, k, args, k === 'async.query' ? { taskId: 'T1' } : {});
      if (built.missing.size) { ok = false; why = `没人给值：${[...built.missing].join(',')}`; break; }
    } catch (e) { ok = false; why = e instanceof Error ? e.message : String(e); break; }
  }
  check(`9 ${t.id}：${keys.join(' + ')} 都拼得出请求`, ok, why);
}

// ========== 10. 重试判据（调度层照它决定要不要再发一次） ==========
console.log('\n[10] 只有 429 / 5xx 算「重试有用」');
check('10.1 限流与服务端故障可重试', retriable(new EngineError('x', 429)) && retriable(new EngineError('x', 503)));
check('10.2 业务错不重试（400 / 404）', !retriable(new EngineError('Model not exist.', 400)) && !retriable(new EngineError('nope', 404)));
check('10.3 没带状态码的错不重试（CORS / 参数缺失）', !retriable(new EngineError('请求失败（可能被 CORS 拦截）')));
check('10.4 原始异常与 undefined 不重试', !retriable(new Error('boom')) && !retriable(undefined));

console.log(`\n===== ${failed ? `${failed} 项失败` : '全部通过'} =====`);
process.exit(failed ? 1 : 0);
