/**
 * verify-request-engine.mjs — 引擎 + 内置模板的离线回归（不联网、不动库）
 *
 * 覆盖：路径两种写法与未命中、三层参数取值优先级、`${}` 求值（类型保留 / 可选参数没填即删键 /
 *       没声明的占位符点名）、headers 逐请求覆盖、outputs 隐式流转、hotFix 数据驱动转换、
 *       产物四种封装（binary / hex / base64 / url）与 download 桥接当场下载、
 *       异步两步（提交 → 两枚举判定 → 取产物）、克隆的一体式与分离式、密钥打码、模板自检，
 *       以及全部内置模板逐份试构造。
 * 运行：node --experimental-strip-types tools/verify-request-engine.mjs
 */
import {
  REQ_KEYS, applyOutputs, buildRequest, callKeysOf, classify, hotFixToArrays, readPath,
  redact, requestOf, runClone, runSync, secretsOf, submitAsync, queryOnce, validateTemplate, EngineError,
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
  eq('2.4 没填的可选参数连键删掉', 'max_tokens' in req.body, false);
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
}

// ========== 3. headers 覆盖 / outputs / 发音修正 ==========
console.log('\n[3] headers 覆盖、outputs 流转、hotFix');
{
  const tpl = seedTemplate('qwen-image');
  const i = inst('qwen-image', { sync: false });
  const s = buildRequest(tpl, i, 'sync.submit', { prompt: '猫' }).req;
  const a = buildRequest(tpl, i, 'async.submit', { prompt: '猫' }).req;
  check('3.1 异步头只加在异步那条', a.headers['X-DashScope-Async'] === 'enable' && !('X-DashScope-Async' in s.headers), a.headers);
  eq('3.2 两条都用模板级 Authorization', [s.headers.Authorization, a.headers.Authorization], ['Bearer sk-abcdefghij1234', 'Bearer sk-abcdefghij1234']);
  eq('3.3 outputs 把 task_id 收成中间变量', applyOutputs({ output: { task_id: 'T9' } }, { taskId: 'output.task_id' }), { taskId: 'T9' });
  eq('3.4 查询请求直接 ${taskId}', buildRequest(tpl, i, 'async.query', {}, { taskId: 'T9' }).req.url, 'https://x.example/v1/tasks/T9');
  eq('3.5 hotFix 摊成上游要的数组', hotFixToArrays({ pronunciation: [{ 重庆: 'chong2 qing4' }], replace: [{ AI: '人工智能' }] }), ['重庆/chong2 qing4', 'AI/人工智能']);
  const t2 = { ...tpl, sync: { submit: { ...tpl.sync.submit, callParams: [{ key: 'hotFix', label: '发音修正', valueType: 'json', transform: 'hotFixArray' }], body: { a: '${hotFix}' } } } };
  eq('3.6 声明了 transform 的参数自动成形', buildRequest(t2, inst('x'), 'sync.submit', { hotFix: { pronunciation: [{ 长: 'chang2' }] } }).req.body.a, ['长/chang2']);
  check('3.7 没给 hotFix 时整键消失（只这一个键时连 body 都不发）', buildRequest(t2, inst('x'), 'sync.submit', {}).req.body === undefined);
  const t3 = { ...tpl, sync: { submit: { path: '${baseUrl}/x', body: { n: '${n}' }, callParams: [{ key: 'n', label: '个数', valueType: 'number' }] } } };
  eq('3.8 字符串数字按声明转成数字', buildRequest(t3, inst('x'), 'sync.submit', { n: '3' }).req.body.n, 3);
  // 千问 CosyVoice 端点（/services/audio/tts/SpeechSynthesizer）要的就是上游那份对象形状：
  // 界面存进项目 hotFix 的就是它，模板**不选 transform** 时原样进 body（选了才摊平）
  const t4 = { ...tpl, sync: { submit: { path: '${baseUrl}/x', body: { input: { text: '${text}', hot_fix: '${hotFix}' } }, callParams: [{ key: 'text', label: '文本' }, { key: 'hotFix', label: '发音修正', valueType: 'json' }] } } };
  eq('3.9 不选 transform 时 hotFix 原样进 body（上游对象形状）',
    buildRequest(t4, inst('x'), 'sync.submit', { text: '重庆', hotFix: { pronunciation: [{ 重庆: 'chong2 qing4' }], replace: [] } }).req.body.input.hot_fix,
    { pronunciation: [{ 重庆: 'chong2 qing4' }], replace: [] });
  check('3.10 没填修正 → hot_fix 这个键整个消失（不发给上游）',
    buildRequest(t4, inst('x'), 'sync.submit', { text: '重庆' }).req.body.input.hot_fix === undefined);
}

// ========== 4. 产物四种封装与桥接 ==========
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
  const t2 = { ...bin, sync: { submit: { ...bin.sync.submit, outputFormat: 'binary', outputs: undefined } } };
  eq('4.4 binary = 响应体即产物', Array.from((await runSync(t2, inst('qwen-tts'), d2.deps, 'sync.submit', { text: 'a', voice: 'v' })).bytes ?? []), [9, 9, 9]);

  const hexT = { ...bin, sync: { submit: { path: '${baseUrl}/x', body: {}, outputs: { audio: 'data.audio' }, outputFormat: 'hex' } } };
  const d3 = mk([{ on: '/x', res: json({ data: { audio: 'deadbeef' } }) }]);
  eq('4.5 hex 解码', Array.from((await runSync(hexT, inst('qwen-tts'), d3.deps, 'sync.submit', {})).bytes ?? []), [0xde, 0xad, 0xbe, 0xef]);
  const b64T = { ...hexT, sync: { submit: { path: '${baseUrl}/x', body: {}, outputs: { audio: 'data.audio' }, outputFormat: 'base64' } } };
  const d4 = mk([{ on: '/x', res: json({ data: { audio: 'AAEC' } }) }]);
  eq('4.6 base64 解码', Array.from((await runSync(b64T, inst('qwen-tts'), d4.deps, 'sync.submit', {})).bytes ?? []), [0, 1, 2]);

  const bridge = {
    ...bin,
    sync: { submit: { path: '${baseUrl}/submit', body: {}, outputs: { fileId: 'data.file_id' } } },
    download: { path: '${baseUrl}/files/retrieve?file_id=${fileId}', method: 'GET', outputs: { url: 'file.download_url' } },
  };
  const d5 = mk([
    { on: '/submit', res: json({ data: { file_id: 'F1' } }) },
    { on: 'retrieve', res: json({ file: { download_url: 'https://cdn/f1' } }) },
  ]);
  const via = await runSync(bridge, inst('qwen-tts'), d5.deps, 'sync.submit', {});
  eq('4.7 配了 download 桥接：先取 fileId 再拿地址下载', [via.bytes?.length, d5.sent.map((x) => (x.url.includes('retrieve') ? 'download' : 'submit'))], [4, ['submit', 'download']]);
  const noProd = await runSync({ ...bridge, download: undefined, sync: { submit: { path: '${baseUrl}/submit', body: {} } } }, inst('qwen-tts'), mk([{ on: '/submit', res: json({ ok: 1 }) }]).deps, 'sync.submit', {});
  check('4.8 只取字段不要产物（文案类就是这样）→ bytes 留空不抛错', noProd.bytes === undefined, noProd.bytes);
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
  eq('5.7b 真机响应的产物路径取得到', applyOutputs(REAL, tpl.async.query.outputs).url, 'https://cdn.real/i.png');
  eq('5.8 状态值大小写不敏感（各家写法不一）', classify('Succeeded', ['succeeded'], ['failed']), 'success');
  await throws('5.9 5xx / 429 带状态码抛回（调度层才知道能不能重试）', async () => {
    const d = mk([{ on: '/tasks/', res: () => ({ status: 429, text: 'too many' }) }]);
    try { await queryOnce(tpl, i, d.deps, { taskId: 'T1' }); }
    catch (e) { if (e.status !== 429) throw new EngineError(`状态码没带回来：${e.status}`); throw e; }
  }, (e) => e.status === 429);
}

// ========== 6. 克隆 ==========
console.log('\n[6] 音色克隆');
{
  const qwen = seedTemplate('qwen-tts');
  const d = mk([{ on: 'customization', res: json({ output: { voice: 'qwen-voice-77' } }) }]);
  const r = await runClone(qwen, inst('qwen-tts'), d.deps, { audioDataUri: 'data:audio/wav;base64,AA==', model: 'qwen3-tts-vc-2026-01-22', preferredName: 'mv' });
  eq('6.1 一体式：data URI 直接进 body，一步拿音色 ID', [r.values.voiceId, d.sent.length], ['qwen-voice-77', 1]);
  const body = d.sent[0].body;
  eq('6.2 复刻目标模型走请求级参数（合成必须同款）', body.input.target_model, 'qwen3-tts-vc-2026-01-22');
  eq('6.3 外层 model 是写死的注册服务名', body.model, 'qwen-voice-enrollment');

  const up = { ...qwen, hasUpload: true, upload: { path: '${baseUrl}/files/upload', body: {}, outputs: { fileId: 'file.file_id' } }, clone: { path: '${baseUrl}/v1/voice_clone', body: { file_id: '${fileId}', name: '${preferredName}' }, outputs: { voiceId: 'voice_id' } } };
  const d2 = mk([{ on: 'files/upload', res: json({ file: { file_id: 'F7' } }) }, { on: 'voice_clone', res: json({ voice_id: 'mm-7' }) }]);
  const r2 = await runClone(up, inst('qwen-tts'), d2.deps, { preferredName: 'mv' });
  eq('6.4 分离式：先上传拿 fileId 再克隆', [r2.values.voiceId, d2.sent.map((x) => x.url.split('/').pop())], ['mm-7', ['upload', 'voice_clone']]);
  eq('6.5 中间变量 fileId 自动流进克隆请求体', d2.sent[1].body.file_id, 'F7');
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
  check('8.2 有异步提交没查询 → 点名', validateTemplate({ ...base, async: { submit: base.async.submit } }).some((x) => x.includes('查询')));
  check('8.3 查询没配成功值 → 点名', validateTemplate({ ...base, async: { submit: base.async.submit, query: { ...base.async.query, successValues: [] } } }).some((x) => x.includes('successValues')));
  check('8.4 实例参数同名重复 → 点名', validateTemplate({ ...base, instanceParams: [...base.instanceParams, { key: 'baseUrl', label: '重' }] }).some((x) => x.includes('重复')));
  check('8.5 勾了克隆却没配 clone 请求 → 点名', validateTemplate({ ...base, category: 'tts', useClone: true }).some((x) => x.includes('clone')));
  check('8.6 谁都能自己加异步（分类不限制接口形状）', validateTemplate({ ...seedTemplate('deepseek-chat'), async: base.async }).length === 0,
    validateTemplate({ ...seedTemplate('deepseek-chat'), async: base.async }));
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
      for (const x of callKeysOf(t, k)) args[x] = `v-${x}`;
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
