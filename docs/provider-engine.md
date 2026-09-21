# 供应商请求引擎设计（模板即数据）

> 状态：**8 条拍板已按建议值确认；批次 1–3 已实现** —— 批次 1：`src/lib/request-engine.ts`（引擎纯函数）+ `src/lib/recipes.ts`（11 个模板包）+ `src/lib/i18n.ts`（`L` + `pickLabel`），`tools/verify-request-engine.mjs` 55 项离线回归全绿；批次 2：`provider_endpoint` 建表 + 旧库搬迁 + 双端持久化，`main.mjs` 的两处协议 switch 与 4 个 AI 通道全部删除，换成通用 `net:request` / `net:fetchUrl`，`tools/verify-provider-endpoint.mjs` 18 项全绿；批次 3：`src/components/ProviderPanel.tsx` 两页签（配置 / 接口模板）+ 每接口「预览请求」「试调用」，⚙ 成为唯一入口（内联那份删了）。
> 第 2 批才动 DDL 与调用链：`provider.protocol` 一删，主进程 switch 与 upsert SQL 同时失效，所以「建表 + 持久化 + 切引擎」必须同批，否则中间态会打断配音与导出。
> 目标：把「某家供应商怎么发请求」从散落 4 处的代码，收敛成一份可配置、可自检、双端共用的数据。

## 一、病根：同一条事实现在有四份真相

| 位置 | 装的是什么 |
|---|---|
| `src/lib/providers.ts` | renderer 侧 `switch (cfg.protocol)`（openai-speech / minimax-t2a / volc-tts / cosyvoice / qwen-tts / custom 六条分支） |
| `electron/main.mjs` | 主进程侧**第二份** `switch (cfg.protocol)`（aiChat / aiTts / aiImage / aiVoiceClone 里各自组装请求） |
| `providers.ts: assertTtsPairing` | 手写的「协议 ↔ 模型名 ↔ 音色」白名单 |
| `docs/db-schema-v2.sql` `provider.protocol` CHECK | 第四份白名单 |

后果已经实测踩过三次：
1. 模型名发错端点 → 上游只回 `HTTP 400 Model not exist.`，看不出真因（AGENTS §6.22）；
2. 拆出 `cosyvoice` 协议时漏改 DDL 的 CHECK → 新建行「当场能用、重启就丢」（AGENTS §6.24，已修）；
3. 声音克隆只实现了 CosyVoice 那条形状，Qwen-TTS 其实另有一套（`qwen-voice-enrollment` / `action:'create'` / `preferred_name` / 返回 `output.voice`），代码里没有位置表达「同一个 role、第二种形状」。

另外三件结构性缺失：
- **没有异步任务的位置**：「提交 → 记 task_id → 轮询状态 → 再取结果」这条链路在类型里根本不存在。
- **可变参数只有一个自由 JSON `extra`**：UI 看不见、无法校验，`思考强度 / size / sample_rate` 这类没有一等位置。
- **headers 与 query 不可配**：所以 MiniMax 的 `group_id`、火山的 `appid|token` 只能塞进 `apiKey` 字符串里用 `&&` / `|` 拆。

## 二、四层概念

1. **role（用途）**：一次业务动作。集合见第三节。
2. **endpoint（接口模板）**：一个 role 一行，完整描述「怎么发 + 怎么取回 + 同步还是异步」。
3. **recipe（模板包）**：按 kind 配齐一组 role（必填/可选 + 默认值 + 建议参数）。这就是「关联请求成对配置」的载体。
4. **引擎 `callRole(provider, role, inputs)`**：唯一请求出口。双端跑同一份模板求值代码。

## 三、role 集合与配对规则

| kind | 必填 role | 可选 role |
|---|---|---|
| `llm` | `llm.generate` | `llm.models`（列模型，暂不做） |
| `tts` | `tts.synthesize` | `tts.clone`（声音克隆）、`tts.query`（**仅当 synthesize 为异步**） |
| `image` | `image.generate` | `image.query`（仅当异步） |

- role 缺失的语义**显式**，不做隐式降级：缺必填 → 供应商标红不可用；缺 `tts.clone` → 「克隆音色」区显示一句「该供应商不支持克隆」（不是摆一排死按钮）。
- 查询接口只被 `mode = async` 的生成接口引用；同步接口的配置界面**不出现**查询区块。
- `tts.synthesize` 与 `tts.clone` 必须指向同一个 `model` 家族（克隆产出的 voice 绑 target_model）→ 由 recipe 声明「共享变量」（`model` / `voice` / `secrets` 在 provider 级，天然共享）。

## 四、endpoint 模板的形状

```json
{
  "role": "tts.synthesize",
  "mode": "sync",
  "method": "POST",
  "path": "{baseUrl}/services/aigc/multimodal-generation/generation",
  "headers": { "Authorization": "Bearer {secrets.apiKey}", "Content-Type": "application/json" },
  "query": {},
  "body": {
    "model": "{model}",
    "input": { "text": "{text}", "voice": "{voice}" },
    "parameters": { "sample_rate": "{sample_rate}" }
  },
  "vars": [
    { "name": "text", "kind": "inject" },
    { "name": "voice", "kind": "inject" },
    { "name": "sample_rate", "kind": "param", "type": "number", "default": 24000, "cn": "合成采样率" },
    { "name": "enable_thinking", "kind": "param", "type": "bool", "default": false, "cn": "思考强度（开关）" }
  ],
  "resp": {
    "kind": "auto",
    "pick": { "audio": "output.audio.url", "errorCode": "code", "error": "message" }
  },
  "poll": null
}
```

异步的 `poll`：

```json
{
  "taskId": "output.task_id",
  "status": "image.query",
  "intervalMs": 1500,
  "timeoutMs": 120000,
  "done": { "path": "output.task_status", "equals": "SUCCEEDED" },
  "fail": { "path": "output.task_status", "in": ["FAILED", "CANCELED", "UNKNOWN"] },
  "then": { "image": "output.results.0.url" }
}
```

### 求值规则（刻意做小，不建表达式语言）

- `{var}` 独占一个标量时**保留原类型**：`"size": "{size}"` + size=1024 → number `1024`；写在字符串内部则是插值：`"Bearer {secrets.apiKey}"`、`"data:audio/wav;base64,{wavB64}"`。
- 路径写法：点号 + 数字下标（`output.choices.0.message.content`），**不引 JSONPath 依赖**。
- 未声明的占位符 → 保存模板时直接报错（「引用了未声明变量 x」），不留到运行时。
- 整段可选参数用等值门控：`"when": "mode == async"`（只支持 `==`，其余情况宁可多加一个 param）。
- base64 data URI 里的 `+` / `=` / `,` 不参与占位符解析（正则只认 `{[A-Za-z_][A-Za-z0-9_.]*}`）。

### 变量类型与前端控件

`type` 管**存什么类型**，`options` 管**用什么控件**，两者正交：有 `options` 就渲染成选项块（项目里一律用 `OptionBlocks`，不写原生 `<select>`，见 §7），值仍按 `type` 落库。

```json
{ "name": "sample_rate", "kind": "param", "type": "number", "default": 24000, "cn": "采样率",
  "options": [ { "value": 16000, "label": "16k" },
               { "value": 24000, "label": "24k" },
               { "value": 48000, "label": "48k" } ] },
{ "name": "format",      "kind": "param", "type": "string", "default": "mp3", "cn": "音频格式",
  "options": ["mp3", "wav", "pcm"] },
{ "name": "enable_thinking", "kind": "param", "type": "bool", "default": false, "cn": "思考强度（开关）" },
{ "name": "size",        "kind": "param", "type": "string", "default": "2048*1152", "cn": "出图尺寸",
  "options": ["1024*1024", "2048*1152", "2688*1536"], "allowCustom": true }
```

- `type`：`string`｜`number`｜`bool`｜`json`｜`list`。`bool` 隐含两个选项（是/否），不用写 `options`。
- `options` 支持裸值或 `{value,label}`（要中文说明时用后者）。
- `allowCustom: true` → 选项块旁再给一个输入框，允许填表外的值；不给就只能选。默认 **false**（宁可显式加候选，也不要放开自由输入再靠上游报错教人）——现有 `voice` / `size` 这类才开。
- 候选值由**模板包**给，不是运行时从上游拉（各家没有统一的 list 接口，且拉回来的顺序/文案不可控）。

### 选项与字段的显示文案（可本地化）

一切**给人看的字**都是同一个类型 `L = string | { zh, en }`：选项 `label`、变量 `cn`（参数名说明）、`item.fields[].label`、role 显示名、recipe 显示名。裸字符串 = 中英同值（`mp3` / `24000` / `CosyVoice` 这类专有名词不必写两份）。

```json
{ "name": "sample_rate", "kind": "param", "type": "number", "default": 24000,
  "cn": { "zh": "采样率", "en": "Sample rate" },
  "options": [
    { "value": 16000, "label": { "zh": "16k · 通用", "en": "16k · general" } },
    { "value": 24000, "label": { "zh": "24k · Qwen 克隆要求", "en": "24k · required by Qwen clone" } }
  ] }
```

- **只有 `value` 入库、进请求体**；`label` 纯显示。所以选完中文「16k · 通用」发出去的是 `16000`，绝不会把中文塞进 body（`voice` 这种"显示名与请求值不同"的也一样：显示 龙安洋 / 值 `longanyang`）。
- 前端渲染前统一过一遍 `pickLabel(l, lang)`（放 `src/lib/i18n.ts`），与顶栏 `editorStore.lang` + `useT()` 同源；`OptionBlocks` 仍收 `{value,label:string}`，双语在传进去之前解一次，组件不新增第二套约定。
- 语言切了不影响已存的值（存的是 `value`），也不需要重新保存模板。
- `label` 省略时直接显示 `value`（数字/格式串这类不需要翻译）。

### 数组 / 对象参数

分三种情形，只有第二种需要新机制：

| 情形 | 例 | 做法 |
|---|---|---|
| 数组是**常量骨架**，只有里面几个槽是变量 | chat 的 `messages:[{role:'system',…},{role:'user',…}]`、图片的 `content:[{text:prompt}]` | 数组直接写在 body 模板里，元素内用 `{var}` 填槽（`systemPrompt` / `userPrompt` 是 inject 变量）。**零新机制** |
| 元素形状固定、**条数可变** | 多轮 `history`、多张参考图、`stop` 词表 | 声明 `type: 'list'` 变量：`item` 子模板 + body 里 `{@name}` 展开 |
| **整段由用户给** | 自定义 `tools` 之类透传 | `type: 'json'`，body 里 `{@name}`，UI 给多行 JSON + 解析校验（现在的 `extra` 就是它的粗糙版） |

```json
"body": { "model": "{model}",
  "messages": [ { "role": "system", "content": "{systemPrompt}" },
                { "role": "user", "content": "{userPrompt}" } ] }

"body": { "messages": [ { "role": "user", "content": "{text}" } {@history} ] }
{ "name": "history", "kind": "param", "type": "list", "omitIfEmpty": true,
  "item": { "body": { "role": "{role}", "content": "{content}" },
            "fields": [ { "name": "role", "type": "string", "options": ["user", "assistant"] },
                        { "name": "content", "type": "string" } ] } }
```

求值规则再补两条：

- `{@name}`（带 `@`）**只能独占一个值位**，整段替换为解析后的 JSON 值，数组 / 对象 / 数字类型全保留；`{name}` 才是字符串插值。分开写是为了消除"到底拼字符串还是塞对象"的歧义。
- `omitIfEmpty: true` 的变量没给值时**连父键一起删**（不少上游拒绝空数组、空 `parameters`、`null`，但"键不存在"是合法的）。
- 同一级联也适用于 `when`：某个对象的子键被全部省略 → 这个对象的键也消失；但模板里**写死**的 `{}` / `[]` 原样保留（有的接口确实要传空 `parameters`）。
- `list` 变量在「简单」页渲染成**行编辑器**（字段取自 `item.fields`，`role` 是选项块、`content` 是文本，可增删调序），落库仍是 `overrides_json` 里的数组值 —— 用户不必手打嵌套 JSON。
- 嵌套对象（`{audio:{voice,format}}`）不需要点号路径语法糖：body 模板本来就是 JSON，直接写层级 + 槽位，比"路径输入框 + 冲突检测"少一套会出 bug 的代码。
- **不做循环 / 条件表达式**（只有 `when: "a == b"` 等值门控与 `omitIfEmpty`）。一旦模板里能写表达式，配置就从"填表"变成"写程序"，出错时看模板也看不出实际发了什么，「试调用」的请求预览就失去意义。

### 出参取法

`resp.kind`：`auto`（按 Content-Type 判音频/JSON）｜`audio`｜`json`｜`text`。
`pick` 里可登记：`text` / `audio`（URL 或 base64）/ `image` / `taskId`（在 `poll.taskId`）/ `errorCode` / `error`。
**「需要记录的返回参数」= pick 的键值表**；`audio` 命中的是 URL 时引擎自动下载转 bytes（现有网页端已是这个行为）。

## 五、表结构

```sql
provider (                         -- 瘦身
  provider_id TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,       -- llm / tts / image（联合类型约束，不再加 CHECK）
  label       TEXT NOT NULL DEFAULT '',
  recipe      TEXT NOT NULL DEFAULT '',   -- 用哪个内置模板包（输入原值：UI 显示「恢复默认」用）
  base_url    TEXT NOT NULL DEFAULT '',
  secrets_json TEXT CHECK (secrets_json IS NULL OR json_valid(secrets_json)),
  model  TEXT NOT NULL DEFAULT '',
  voice  TEXT,
  speed  REAL NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 0,
  ord    INTEGER NOT NULL DEFAULT 0
);

provider_endpoint (
  endpoint_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES provider(provider_id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  ord         INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  mode        TEXT NOT NULL DEFAULT 'sync',      -- sync / async
  method      TEXT NOT NULL DEFAULT 'POST',
  path        TEXT NOT NULL DEFAULT '',
  headers_json TEXT, query_json TEXT, body_json TEXT, vars_json TEXT,
  overrides_json TEXT,                            -- 用户填的 param 覆盖值
  resp_kind   TEXT, pick_json TEXT, poll_json TEXT,
  status_endpoint_id TEXT,                        -- 弱引用（同表自引用），见下
  created_at INTEGER, updated_at INTEGER,
  CHECK (headers_json IS NULL OR json_valid(headers_json)) /* …其余 JSON 列同理 */
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pe_role ON provider_endpoint(provider_id, role);
CREATE INDEX IF NOT EXISTS ix_pe_provider ON provider_endpoint(provider_id);
CREATE INDEX IF NOT EXISTS ix_pe_status ON provider_endpoint(status_endpoint_id);
```

- **删 `provider.protocol` 列**（第四节模板里已经没有「协议」这个概念，它是四份白名单的源头）。
- `role` / `mode` / `resp_kind` 的取值由 TS 联合类型 + 保存时校验约束，**不写进 DDL CHECK** —— 以后加一家供应商不需要动表结构。
- `status_endpoint_id` 是**弱引用**（同表自引用，建不了真外键）：按 §10 的规矩补自检视图（指向不存在或 role 不是 `*.query` 的行即报）+ 该列索引，并加进 `v_check_dangling` 一族。
- `secrets_json = { "apiKey": "…", "secret2": "…" }`：火山的 appid/token 各占一格，`apiKey.includes('|')` / `'&&'` 那套 hack 删掉。UI 永不回显，只显示长度。
- 所有时间点遵循 §10「存输入原值」：`poll.intervalMs` / `timeoutMs` 是**毫秒常量参数**（非播放时间），存原值即可；`created_at/updated_at` 仍是 epoch 毫秒。

### 旧数据

**只搬 `api_key` → `secrets_json.apiKey`（以及 model / voice / label / baseUrl）**，其余一律按 recipe 重建。这是「不丢用户资产」，不是「兼容旧结构」：body/headers 模板过去不存在，无物可迁。搬迁动作复用 `retireProviderIfStale` 那套「旧表让位 → 新 DDL 建表 → 按交集列搬回」的路径（该逻辑已落地并回归）。

## 六、参数（可变化参数）

- `vars[].kind = 'inject'`：调用端注入，UI 只读展示（`text` / `voice` / `model` / `prompt` / `wavB64` / `taskId` / `refAudioUrl`…），防止把请求正文当设置改。
- `vars[].kind = 'param'`：出现在「简单」页的参数小表（名称 / 类型 / 默认 / 中文说明），值存 `overrides_json`。**控件按第四节的 `type` + `options` 决定**：有 `options` 就是选项块（`sample_rate` 16k/24k/48k、`format` mp3/wav/pcm），`bool` 自动是两个选项，`list` 是行编辑器，`json` 是多行 JSON 框。
- 参数名**可自由增删**（内置常用项只做下拉提示、不做白名单）：`size` `quality` `format` `sample_rate` `voice_format` `temperature` `top_p` `max_tokens` `enable_thinking` `thinking_budget` `seed` `watermark` `prompt_extend`。
- `extra` 自由 JSON 保留为兜底（深合并进 body），但不再是唯一出口。
- 采样率这类「协议相关」的默认值写在 recipe 里（Qwen-TTS 克隆参考音频要求 ≥24kHz、CosyVoice 现有实现转 16k），不再硬编进 `toWav16kMono`。

## 七、代码落点

| 文件 | 变化 |
|---|---|
| `src/lib/request-engine.ts`（新） | `buildRequest(tpl, ctx)` / `parseResponse(tpl, res)` 纯函数（离线可单测）+ `callRole()` 编排（含轮询：`await` + `setTimeout`，不用 rAF） |
| `src/lib/recipes.ts`（新） | 内置模板包（TS 常量，可序列化成 endpoint 行） |
| `src/lib/providers.ts` | 删 renderer 侧 `switch (protocol)`、删 `assertTtsPairing`（配对变成「模板 + 试调用」的问题）；`callLLM/callTTS/callImage/cloneVoice` 改成薄壳，**签名不变** → 调用点（`GenerateDialog` 逐行配音、`VoicePicker` 试听/克隆、`FxPanelBody` 连通性测试）不动 |
| `electron/main.mjs` | 删 4 个 AI 专用通道与全部协议 `switch`，只留通用 `net:request`（入：url/method/headers/query/body/期望响应类型；出：bytes+mime 或 json） |
| `src/stores/providerStore.ts` | 供应商 + endpoint 集合一起读写；`activeProvider()` 返回值带解析好的模板 |
| `src/components/VoicePicker.tsx` | `protocol === 'cosyvoice'` → `hasRole(tts, 'tts.clone')` |

网页端跑同一引擎（CORS 靠用户自己的代理 baseUrl，失败提示保持现有措辞）；导出链路不涉网络（配音已落音频），无影响。

## 八、UI：页面分工与参数归属

### 8.1 不新增顶级入口，⚙ 里分两层两页签

现状（`SettingsDialog` + `FxPanelBody:ProviderSettingsDialog`）：⚙ 设置 · AI → 左侧三类（文案 / 语音 / 图片）→ 右侧上方是厂商芯片 + 供应商行（● 生效 / ✕ 删除），下方是选中项的编辑区。改造保持这个骨架，只把下方编辑区拆成两个页签：

| 页面 | 装什么 | 面向 |
|---|---|---|
| **配置** | 模板包 → 密钥 → Base URL → 模型 → 音色 → 参数表（`kind=param`）→ 每个 role 的**同步 / 异步** | 日常：换 Key、换模型、调参数 |
| **接口模板** | 每 role 一卡片：URL / Method / Headers / Query / Body 模板 / 出参取法 / 轮询与状态判定 + **试调用** | 专家：接一家没预置的服务、或上游改了字段 |

两条硬性约束：

- **同一份配置只有一处能改**（已落地）：`FxPanelBody` 的 `inline` 版与 ⚙ 曾是同一组件的两个入口，属 UI 版「双份真相」→ 内联那份已删，`VoicePicker` 只留「选音色 + 试听」。
- **「内置」的判定换成 `provider.recipe`**。现在靠 `sel.label === preset.label` 反查，用户改个显示名就掉出内置形态（`builtin` 分支失效、裸露出 baseUrl 等）；模板包 id 落在列上，改名无感。

两页签独立滚动容器，不混在一条长流里 —— 混了以后没人敢动 body 模板，也看不清自己改了什么。

### 8.2 同步 / 异步归属

`mode` 存在 **`provider_endpoint`**（它是接口形状的一部分），但**在「配置」页就能改**，改的是该 role 那一行：

- 选异步 → 配置页当场长出四行：状态接口（下拉，来自本供应商 role 为 `*.query` 的 endpoint）、`poll.taskId` 路径、轮询间隔 / 超时、done/fail 判定；默认值由模板包带来，一般不用动。
- 选同步 → 这四行整块消失，接口模板页的对应区块同样隐藏（同步接口**不给**配查询）。
- 粒度是**每个 role 一个**，不做供应商级全局开关 —— `tts` 同步 + `image` 异步是常见组合。
- 保存前校验：`mode=async` 却挑不到 `*.query` 模板 → 红字点名并禁保存，不留到运行时才发现（第 6/7 条要求的「成对」在这里落地）。

### 8.3 三个阶段：装配期 / 配置期 / 调用期

| 阶段 | 存哪 | 谁来填 | 例子 |
|---|---|---|---|
| **装配期**（模板结构） | `provider_endpoint.*_json`（path / headers / body 骨架 / vars 声明 / pick / poll） | 内置模板包，或「接口模板」页 | URL 路径、`Authorization: Bearer {secrets.apiKey}`、body 里有哪些槽 |
| **配置期**（供应商取值） | `provider`（base_url / secrets_json / model / voice / `overrides_json`） | 「配置」页 | Base URL、Key、模型、音色、`size`、`sample_rate`、思考开关 |
| **调用期**（请求正文） | **不落库** | 调用点 `callRole(role, inputs)` | 字幕那一行文本、图片描述、参考音频字节、`taskId`（引擎内部） |

区分开关就是 `vars[].kind`：`param` = 配置期可填（有 `options` 就渲染成选项块），`inject` = 调用期注入（UI 只读显示"由调用端传入"，不给填 —— 防止把请求正文当设置改）。

同名冲突时的优先级：**调用端显式传入 > 配置期 `overrides_json` > 模板包 `default`**。
所以「图片 size」这类两边都可能要改的，在模板包里就同时是 param（配置期给默认值）与可被调用端覆盖的变量；首批只有图片有这需求，`GenerateDialog` / 字幕链路**不**画这些控件（否则每处调用点都要长一套参数表）。

### 8.4 首批模板包（recipe 清单）

`openai-chat`、`dashscope-cosyvoice`、`dashscope-qwen-tts`（含 `qwen-voice-enrollment` 克隆）、`dashscope-image`（同步与异步各一份示例）、`minimax-t2a`、`volc-tts`、`custom` 空白包。

### 8.5 试调用（这一节是整个重构的目的所在）

每张 role 卡片一个按钮，填一句测试输入后显示两栏：

1. **实际发出的请求**：URL、headers（`Authorization` 只显 `Bearer sk-****（长度 116）`，永不显原文）、展开后的 body/query。
2. **响应摘要**：状态码、耗时、按 `pick` 解析出的字段值（音频给播放键、图片给缩略、异步逐次显示轮询过程与 `task_status`）、失败时原样带上游 `code/message`。

有了这两栏，"模板对不对"当场可判定，不再靠 `HTTP 400 Model not exist.` 反推 —— 这两天三个 bug 的共同成因就是配置与请求之间没有可观察的中间层。

## 九、分期与验收

| 批次 | 内容 | 该批的验证 |
|---|---|---|
| 1 | 类型 + `provider`/`provider_endpoint` DDL + 引擎纯函数 + 6 个模板包 + recipes 自检（role 覆盖、占位符都有声明、async 必配 status） | `tools/verify-request-engine.mjs`：类型保留、data URI 的 `+`/`=` 不被当占位符、数组下标取值、异步轮询 mock（含超时/失败判定）、密钥打码、6 家 fixture 响应解析 |
| 2 | providerStore / IPC 切引擎；`callLLM/callTTS/callImage/cloneVoice` 走 `callRole`；删两份 `switch` 与旧通道；`narration` 配音链路回归 | 桌面端逐行配音 + 试听各跑一次（需你点头才动 Key）；`verify-project-roundtrip` 扩一条 endpoint 行往返 |
| 3 | UI 两页 + 试调用 | 浏览器实测：模板包切换后 role 芯片、缺 role 红字、试调用请求预览 |
| 4 | 文档链（§10 清单：db-field-notes / gen-db-field-dict / comment-ddl / 五条回归全绿）+ AGENTS 记「模板即数据」与新的字段同步清单 + 迁移搬迁回归 | 五条全绿 + 新增 `verify-provider-endpoint.mjs`（旧行 → 新表搬 Key、role 齐备性校验、status 弱引用自检视图能抓悬挂） |

## 十、待你拍板

1. `provider.protocol` 列删掉？（建议：删）
2. 旧供应商行：只搬 API Key + 模型/音色、其余按模板包重建（建议），还是全部重填？
3. 出参取值只支持点号 + 数组下标，不引 JSONPath（建议：是）。
4. 参数允许自由增删变量名，内置常用项只做下拉提示不做白名单（建议：是）。
5. 网页端也跑同一引擎（CORS 由代理 baseUrl 解决）还是只桌面？（建议：同引擎，桌面为主）
6. `思考强度` 这类参数要不要在模板包里逐条写中文说明（写了参数表才显示说明）？（建议：首批 6 家写全）
7. 有 `options` 的参数默认**只能选不能填**，仅 `size` / `voice` 这类开 `allowCustom`（建议：是）；候选值一律由模板包写死，不从上游拉列表（建议：是）。
8. `list` 变量的行编辑器首批只做三处（chat 多轮 `history`、参考图列表、`stop` 词表），不做通用可配（建议：是）。

## 附：现有各家请求形状对照（迁移时的 fixture 依据）

| 供应商 | 端点 | 关键差异 |
|---|---|---|
| OpenAI 兼容 chat | `POST {base}/chat/completions` | `messages`；取 `choices.0.message.content` |
| OpenAI /audio/speech | `POST {base}/audio/speech` | 响应体**直接是音频字节**；`speed` |
| MiniMax t2a_v2 | `POST {base}?group_id=…` | key 里拆 `GroupId`；响应 `data.audio` 是 hex |
| 火山 TTS | `POST {base}` | headers `X-Api-App-Key` / `X-Api-Access-Key` / `X-Api-Resource-Id`；请求体三段 `user/audio/request` |
| DashScope CosyVoice | `{base}/services/audio/tts/SpeechSynthesizer` | `input.{text,voice}`；返回音频字节 |
| DashScope Qwen-TTS | `{base}/services/aigc/multimodal-generation/generation` | 返回 `output.audio.url` |
| 克隆（CosyVoice 系） | `{base}/services/audio/tts/customization` | `model:'voice-enrollment'`, `action:'create_voice'`, `prefix`, `url`(data URI) → `output.voice_id` |
| 克隆（Qwen-TTS） | 同上端点 | `model:'qwen-voice-enrollment'`, `action:'create'`, `preferred_name`, `audio.data`(data URI) → **`output.voice`**；合成须用同款 `target_model`（如 `qwen3-tts-vc-2026-01-22`）；参考音频要求 ≥24kHz 单声道 |
| DashScope 图片 | `{base}/services/aigc/multimodal-generation/generation` | 取 `output.choices.0.message.content.0.image`；同族另有「提交 + `tasks/{id}` 轮询」的异步形状 |

> 表中「克隆（Qwen-TTS）」与「异步图片」两条来自官方文档（voice-cloning-user-guide / qwen3-tts-vc），**本机未实跑**；实现时以「试调用」按真实响应确认，再定稿模板包。
