# 供应商配置设计：模板表 · 实例表 · 取回管线 · 调度

> 一句话：**模板 = 一个接口怎么发、怎么取回（共享数据）；实例 = 选哪组模板 + 账号 + 同步/异步 + 实例期参数；调用期正文与 `taskId` 不落库；一次动作发多条请求走内存队列。**

## 一、四层职责

| 层 | 存哪 | 装什么 | 谁编辑 |
|---|---|---|---|
| **模板** | `provider_template` | 一个接口怎么发（url / headers / body）、声明哪些入参、返回从哪取 | 接口模板页（专家） |
| **实例** | `provider` | 用哪组模板、Base URL、密钥、同步还是异步、模板要求实例填的参数值、并发与重试 | ⚙ 实例设置页（日常） |
| **调用** | **不落库** | 一次动作的正文（字幕文本、图片描述、参考音频字节）与在途 `taskId` | 代码调用点 |
| **调度** | **内存队列** | 批量动作的并发上限、退避重试、取消、逐条进度 | 代码，不给界面 |

## 二、`provider_template`（模板表）

**一行 = 一个接口**；同一功能的几个接口用 `tpl_group` 归成一组。

```sql
CREATE TABLE IF NOT EXISTS provider_template (
  tpl_id      TEXT PRIMARY KEY,                       -- 模板行 id
  tpl_group   TEXT NOT NULL,                          -- 组 id：openai-chat / dashscope-image …
  kind        TEXT NOT NULL,                          -- llm / tts / image（组内必须一致）
  group_label TEXT NOT NULL DEFAULT '',               -- 组显示名「通义图片生成」（组内冗余同值）
  role        TEXT NOT NULL,                          -- generate / synthesize / query / clone
  mode        TEXT NOT NULL DEFAULT 'sync',           -- 这条变体服务哪种方式：sync / async
  ord         INTEGER NOT NULL DEFAULT 0,             -- 组内展示顺序
  method      TEXT NOT NULL DEFAULT 'POST',
  url         TEXT NOT NULL DEFAULT '',               -- 地址模板，占位符决定 {baseUrl} 出现在哪
  headers_json TEXT,  query_json TEXT,  body_json TEXT,  vars_json TEXT,  resp_json TEXT,
  decode      TEXT,                                   -- 产物解码：NULL / hex / base64 / url
  fetch_headers_json TEXT,                             -- 下载产物时附带的请求头（NULL = 裸 GET 签名链接）
  poll_interval_ms INTEGER NOT NULL DEFAULT 1500,     -- 离散步长类参数，存原值
  poll_timeout_ms  INTEGER NOT NULL DEFAULT 120000,
  note        TEXT,                                   -- 组/接口说明（L 的 JSON）
  created_at INTEGER, updated_at INTEGER,
  CHECK (headers_json IS NULL OR json_valid(headers_json))   /* 其余 JSON 列同理 */
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tpl_role ON provider_template(tpl_group, role, mode);
CREATE INDEX IF NOT EXISTS ix_tpl_group ON provider_template(tpl_group, ord);
CREATE INDEX IF NOT EXISTS ix_tpl_kind  ON provider_template(kind, tpl_group);
```

- `kind` / `role` / `mode` / `decode` **不写 DDL CHECK**：取值由 TS 联合类型 + 保存前 `validateTemplate()` 管，接一家新供应商不改表结构。
- `kind` / `group_label` 冗余在每行（组不另开表），由自检视图 `v_check_tpl_group` 保证组内一致。
- 内置模板由 seed 目录在首次建库时铺成行；之后行就是普通可编辑数据。`恢复默认` = 用 seed 覆盖该行；`另存为副本` = 复制成新 `tpl_group`。
- 一个 `tpl_group` 里的 role 组合：
  - `llm`：`generate`
  - `image`：`generate·sync` ｜ `generate·async` + `query`（可两种变体并存，实例选）
  - `tts`：`synthesize·sync` ｜ `synthesize·async` + `query`，外加独立的 `clone`（恒 `sync`，与同步/异步无关）

## 三、`provider`（实例表）

```sql
CREATE TABLE IF NOT EXISTS provider (
  provider_id TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                     -- llm / tts / image
  label       TEXT NOT NULL DEFAULT '',
  tpl_group   TEXT NOT NULL,                     -- 引用哪一组模板
  base_url    TEXT NOT NULL DEFAULT '',
  secrets_json TEXT,                             -- {apiKey, secret2}，UI 永不回显只显长度
  mode        TEXT NOT NULL DEFAULT 'sync',      -- 这个账号走同步还是异步
  model       TEXT NOT NULL DEFAULT '',
  voice       TEXT,
  speed       REAL NOT NULL DEFAULT 1,
  params_json TEXT,                              -- 只存 stage=instance 的参数值
  max_concurrency INTEGER NOT NULL DEFAULT 1,    -- 批量并发上限（1 = 串行）
  retry_times     INTEGER NOT NULL DEFAULT 2,    -- 限流/网络错的退避重试次数
  extra       TEXT,                              -- 兜底：深合并进 body 的附加 JSON
  active      INTEGER NOT NULL DEFAULT 0,        -- 每个 kind 至多一条为 1
  ord         INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_provider_active ON provider(kind) WHERE active = 1;
CREATE INDEX IF NOT EXISTS ix_provider_kind ON provider(kind, ord);
```

- **`mode` 在实例上**：选完就决定用组里哪条 `generate` 变体、要不要 `query`。该组没有 async 变体时界面上不给这个选项（**显式不可用，不做隐式降级**）。
- `max_concurrency` / `retry_times` 是账号/上游限额属性（同一家不同账号额度不同），所以属实例层。
- `params_json` 的键 = 该组各接口 `stage=instance` 变量名的并集；同名跨接口共用一个值（`synthesize` 与 `clone` 天然共用 `model`，这就是「克隆产出的音色绑同款 target_model」的落法）。
- 取值优先级：**调用端显式传入 > 实例 `params_json` > 模板 `default`**。

## 四、入参声明 `vars_json`

```jsonc
[ { "name": "size", "stage": "instance", "type": "string",
    "label": { "zh": "出图尺寸", "en": "Size" }, "default": "1024*1024",
    "options": [ { "value": "1024*1024", "label": { "zh": "方图", "en": "Square" } },
                 { "value": "2048*1152", "label": "2048×1152" } ], "allowCustom": true },
  { "name": "prompt", "stage": "call", "type": "string" } ]
```

| 字段 | 含义 |
|---|---|
| `stage` | `instance`（建实例时填）｜`call`（调用时传） |
| `type` | `int`｜`string`｜`bool`｜`list`｜`json` |
| `label` | `L = string \| {zh,en}`，纯显示；**只有 `value` 进请求体** |
| `default` | 模板给的默认值（实例没填就用它） |
| `options` | 候选值：裸值或 `{value,label}`；有候选 → `OptionBlocks`，不写原生 `<select>` |
| `allowCustom` | 才给「其它值」输入框；默认只能选 |
| `when` | 等值门控（`"mode == async"`），不成立则该槽不参与求值、界面也不显示 |
| `omitIfEmpty` | 没给值时**连父键一起删**（不少上游拒绝空数组 / 空 `parameters`，但"键不存在"合法） |
| `item` | `list` 的元素子模板：`body` + `fields[]`，界面是行编辑器 |

- 控件由 `options` 决定、与 `type` 正交；`bool` 隐含开/关两个选项。
- 保留占位符不必声明，由实例行直接提供：`{baseUrl}` `{apiKey}` `{secret2}` `{model}` `{voice}` `{speed}` `{mode}` `{taskId}`。其中 `voice` 默认取实例列、调用端可逐行覆盖。
- 候选值由模板写死，**不运行时从上游拉**（各家没有统一 list 接口，顺序/文案不可控）。
- 界面规则：实例页只渲染 `stage=instance` 且 `when` 成立的变量；`stage=call` 的只读展示（标「调用时传入」）。

## 五、返回槽位 `resp_json`

固定键，界面按 role+mode 只渲染该填的那几格：

```jsonc
{ "content":"", "image":"", "audio":"", "voiceId":"", "taskId":"",
  "status":"", "success":[], "fail":[], "pending":[],
  "errorCode":"code", "error":"message" }
```

| 槽位 | 含义 | 出现在哪条接口 |
|---|---|---|
| `content` | 文案正文路径 | `generate`（llm） |
| `image` / `audio` | 产物路径；**留空 = 响应体本身即产物字节** | `generate` / `synthesize` / `query` |
| `voiceId` | 新建音色的 id 路径 | `clone` |
| `taskId` | 任务 id 路径 | `generate·async` |
| `status` + `success[]` / `fail[]` / `pending[]` | 状态路径与三组枚举值 | `query` |
| `errorCode` / `error` | 失败时要点名的上游错误码/错误信息路径 | 所有行 |

- 路径写法：**点号 + 数字下标**（`output.choices.0.message.content`、`audios.0.url`），不引 JSONPath。上游是 batch 接口（一个请求回多条）时同样够用。
- 三枚举用标签编辑器（可增删多个值），因为上游状态名不止一个（`FAILED` / `CANCELED` / `UNKNOWN`）。
- `decode` 描述"拿到的东西怎么变成字节"：`NULL`（响应体即字节 / 或槽位里就是 data URI）｜`hex`（MiniMax 音频）｜`base64`｜`url`（槽位取到的是远端链接 → 走第六步下载）。

## 六、产物取回管线（引擎固定五步）

| 步 | 做什么 | 由哪些列决定 |
|---|---|---|
| ① **提交** | 按 `generate` / `synthesize` 行发请求 | `url` / `method` / `headers_json` / `body_json` / `vars_json` |
| ② **取任务 id** | 从 ① 的响应读 `taskId`（仅异步） | `resp.taskId` |
| ③ **轮询状态** | 用 `query` 行反复查，直到命中 `success` / `fail` / `pending` 之一；超时报错 | `query` 行的 `url`（含 `{taskId}`）+ `resp.status` + 三枚举 + `poll_interval_ms` / `poll_timeout_ms` |
| ④ **取产物** | 按 `image` / `audio` 槽取值；槽位为空则整个响应体即产物 | `resp` + `decode` |
| ⑤ **下载并落库** | `decode='url'` 时当场 GET 成字节，**立刻落 `asset`** | `fetch_headers_json`（默认裸 GET；私有 CDN 要带 `Authorization` 才填） |

- **⑤ 是硬规矩**：异步查询返回的链接带时效，跨会话必失效。项目数据里**绝不存远端产物 URL**，只存 `asset` id —— 否则第二天导出是一片空图。
- 下载不单独建 `download` 接口行：它没有业务语义、没有出参槽位，做成行会让人以为要配两条查询接口；唯一需要配的"能不能带鉴权头"由 `fetch_headers_json` 一列承担。
- `clone` 只走 ①④（返回 json，不产字节）。

## 七、配对与保存前校验

**组内 role 齐备性**：

| kind | 必填 | 条件必填 | 可选 |
|---|---|---|---|
| `llm` | `generate·sync`（`content` 非空） | — | — |
| `image` | `generate`（sync / async 至少一条） | 实例 `mode=async` → `generate·async`（`taskId`）+ `query`（`image` + `status` + `success`） | `generate` 的另一条变体 |
| `tts` | `synthesize`（sync / async 至少一条） | 实例 `mode=async` → `synthesize·async`（`taskId`）+ `query`（`audio` + `status` + `success`） | `clone`（缺则「克隆音色」区显示「该供应商不支持克隆」，不摆死按钮） |

**其余规则**：

1. 实例 `mode=sync` → 该 `generate` 行**不允许**出现 `taskId` / `status` / 三枚举 / 轮询列。
2. `decode='url'` 的行必须有产物槽位（`image` / `audio`），否则第⑤步没有可下载的东西。
3. `url` / `headers` / `body` 引用的占位符必须都在 `vars_json` 声明，或属保留占位符（`query` 行的 `{taskId}` 由引擎在②之后注入）。
4. `list` 变量必须给 `item`；`bool` 变量不必给 `options`（给了即报错）。
5. 缺必填 role → 实例行标红不可用；缺项**当场点名**，不留到运行时。
6. 自检视图三条（只体检不拦写入）：`v_check_async_pairing`、`v_check_tpl_group`、`v_check_dangling`（`provider.tpl_group` 指向不存在的组）。
7. 模板行被实例引用时允许改（模板是共享数据），但界面顶部显式提示「N 个实例正在使用这组模板」，并给「另存为副本」。

## 八、调度层（`src/lib/provider-queue.ts`，内存，不是表）

一次用户动作会发多条请求：逐行配音（30 行字幕 = 30 次 `synthesize`，异步的每次还要轮询十几秒）、批量出图、整片重配音。

| 项 | 规则 |
|---|---|
| 并发 | 按实例 `max_concurrency` 取任务，默认 1（串行）；同一实例的单行配音 / 试听与批量走**同一个队列**，否则两条路会同时打上游 |
| 重试 | 只重试 **429 / 5xx / 网络错**，指数退避 + 尊重 `Retry-After`；**业务错（模型名不存在、参数非法）不重试**，直接点名 |
| 取消 | `AbortController` 透传到主进程 `net:request` 的 fetch signal；取消后已完成条目保留 |
| 进度 | 逐条回调 → 字幕生成显示 `7/30 · 已用 2:10 · ✕ 取消` |
| 落库 | **产物一拿到就逐条落 `asset`**，不等整批：30 行跑到第 20 行失败，前 19 行不能白跑；失败行下次被「只补没配音的」自然重跑 |

不建任务表：`taskId` 只在一次调用内有意义（上游任务几十分钟过期），而「哪几行还没配音」项目数据本身就是清单（`narration_entry` 有没有音频），再存一份就是第二处真相。

## 九、界面：两页分工

| 页面 | 装什么 |
|---|---|
| **⚙ 实例设置**（`ProviderPanel`） | 模板组下拉（按 kind 过滤）→ Base URL / API Key（+ 第二密钥槽）→ **同步 / 异步** → 该组 `stage=instance` 参数表 → 并发数 / 重试次数 → 底部「接口模板 · N →」 |
| **接口模板页**（`EndpointTemplatesPage`，整屏） | 左侧模板组列表（含「N 个实例在用」）→ 右侧组内接口卡片：url / method / headers / body / **入参声明表** / **返回槽位表单** / 解码 / 下载头 / 轮询节奏 + 预览请求 · 试调用 |

- 两页不混在同一屏；⚙ 是唯一入口（`VoicePicker` 只留选音色 + 试听）。
- 实例页每个控件都要对得上库里某一列；空值写成「删键」而不是存 `null`。
- **试调用**是这套设计的验收口：每张接口卡片给「实际发出的请求」（密钥打码 `Bearer sk-****（长度 116）`）+「响应摘要」（状态码、按槽位取到的值、音频给播放键、异步逐次显示轮询过程与状态原文、失败原样带上游 `code/message`）。
- 模板里**不做循环 / 条件表达式**（只有 `when` 等值门控）。一旦能写表达式，配置就从填表变成写程序，出错时看模板也看不出实际发了什么，试调用就失去意义。

## 十、内容示例

### 10.1 文案生成 · `openai-chat`（一组一行）

```jsonc
// provider_template
{ "tpl_group":"openai-chat", "kind":"llm", "group_label":{"zh":"OpenAI 兼容对话","en":"OpenAI-compatible"},
  "role":"generate", "mode":"sync", "method":"POST",
  "url":"{baseUrl}/chat/completions",
  "headers":{ "Content-Type":"application/json", "Authorization":"Bearer {apiKey}" },
  "body":{ "model":"{model}",
           "messages":[ { "role":"system", "content":"{systemPrompt}" },
                        { "role":"user",   "content":"{userPrompt}" } ],
           "temperature":"{temperature}", "max_tokens":"{max_tokens}",
           "enable_thinking":"{enable_thinking}" },
  "vars":[ { "name":"systemPrompt", "stage":"call", "type":"string" },
           { "name":"userPrompt",   "stage":"call", "type":"string" },
           { "name":"temperature",  "stage":"instance", "type":"int", "default":7,
             "label":{"zh":"温度（×10）","en":"Temperature ×10"}, "omitIfEmpty":true },
           { "name":"max_tokens",   "stage":"instance", "type":"int", "default":2048,
             "label":{"zh":"最大输出 token","en":"Max tokens"}, "omitIfEmpty":true },
           { "name":"enable_thinking","stage":"instance","type":"bool","default":false,
             "label":{"zh":"思考模式","en":"Thinking"} } ],
  "resp":{ "content":"choices.0.message.content", "errorCode":"error.code", "error":"error.message" } }
```

```jsonc
// provider（实例）
{ "kind":"llm", "label":"DeepSeek", "tpl_group":"openai-chat",
  "base_url":"https://api.deepseek.com/v1", "secrets":{ "apiKey":"sk-…" },
  "mode":"sync", "model":"deepseek-chat",
  "params":{ "temperature":7, "max_tokens":2048, "enable_thinking":false },
  "max_concurrency":1, "retry_times":2 }
```

### 10.2 语音 · `dashscope-cosyvoice`（合成同步 + 克隆，无查询接口）

```jsonc
// ① synthesize·sync —— 响应体本身就是音频字节，所以 audio 槽留空
{ "tpl_group":"dashscope-cosyvoice", "kind":"tts", "group_label":{"zh":"通义语音（CosyVoice）","en":"DashScope CosyVoice"},
  "role":"synthesize", "mode":"sync", "method":"POST",
  "url":"{baseUrl}/api/v1/services/audio/tts/SpeechSynthesizer",
  "headers":{ "Content-Type":"application/json", "Authorization":"Bearer {apiKey}" },
  "body":{ "model":"{model}",
           "input":{ "text":"{text}", "voice":"{voice}", "format":"{format}", "sample_rate":"{sample_rate}" } },
  "vars":[ { "name":"text","stage":"call","type":"string" },
           { "name":"format","stage":"instance","type":"string","default":"mp3",
             "label":{"zh":"音频格式","en":"Format"},"options":["mp3","wav","pcm"] },
           { "name":"sample_rate","stage":"instance","type":"int","default":24000,
             "label":{"zh":"采样率","en":"Sample rate"},
             "options":[ {"value":16000,"label":{"zh":"16k · 通用","en":"16k · general"}},
                         {"value":24000,"label":{"zh":"24k · 克隆要求","en":"24k · clone required"}},
                         {"value":48000,"label":"48k"} ] } ],
  "resp":{ "audio":"", "decode":null, "errorCode":"code", "error":"message" } }

// ② clone·sync —— 建音色这一步各家都是同步，恒 mode=sync；与 synthesize 共用实例的 model
{ "tpl_group":"dashscope-cosyvoice", "kind":"tts", "role":"clone", "mode":"sync", "method":"POST",
  "url":"{baseUrl}/api/v1/services/audio/tts/customization",
  "headers":{ "Content-Type":"application/json", "Authorization":"Bearer {apiKey}" },
  "body":{ "model":"voice-enrollment",
           "input":{ "action":"create_voice", "target_model":"{model}", "prefix":"{prefix}",
                     "url":"data:audio/wav;base64,{wavB64}" } },
  "vars":[ { "name":"wavB64","stage":"call","type":"string" },
           { "name":"prefix","stage":"instance","type":"string","default":"mv",
             "label":{"zh":"音色名前缀","en":"Voice name prefix"} } ],
  "resp":{ "voiceId":"output.voice_id", "errorCode":"code", "error":"message" } }
```

```jsonc
// provider（实例）
{ "kind":"tts", "label":"通义配音", "tpl_group":"dashscope-cosyvoice",
  "base_url":"https://dashscope.aliyuncs.com", "secrets":{ "apiKey":"sk-…" },
  "mode":"sync", "model":"cosyvoice-v3.5-flash", "voice":"longanyang", "speed":1,
  "params":{ "format":"mp3", "sample_rate":24000, "prefix":"mv" },
  "max_concurrency":1, "retry_times":2 }
```

### 10.3 语音 · 异步形状（合成异步 + 查询 + 克隆，三条一组）

```jsonc
// ① synthesize·async —— 提交，只登记 taskId
{ "tpl_group":"example-tts-async", "kind":"tts", "role":"synthesize", "mode":"async", "method":"POST",
  "url":"{baseUrl}/…/tts/submit",
  "headers":{ "Content-Type":"application/json", "Authorization":"Bearer {apiKey}", "X-Async":"enable" },
  "body":{ "model":"{model}", "input":{ "text":"{text}", "voice":"{voice}" } },
  "vars":[ { "name":"text","stage":"call","type":"string" } ],
  "resp":{ "taskId":"output.task_id", "errorCode":"code", "error":"message" } }

// ② query·sync —— 轮询；产物是链接 → 第五步下载
{ "tpl_group":"example-tts-async", "kind":"tts", "role":"query", "mode":"sync", "method":"GET",
  "url":"{baseUrl}/api/v1/tasks/{taskId}",
  "headers":{ "Authorization":"Bearer {apiKey}" },
  "vars":[], "decode":"url",
  "poll_interval_ms":1500, "poll_timeout_ms":120000,
  "resp":{ "audio":"output.results.0.url", "status":"output.task_status",
           "success":["SUCCEEDED"], "pending":["PENDING","RUNNING"],
           "fail":["FAILED","CANCELED","UNKNOWN"], "errorCode":"code", "error":"message" } }

// ③ clone·sync —— 同 10.2
```

### 10.4 图片 · `dashscope-image`（同一条功能两种变体并存，实例选）

```jsonc
// ① generate·sync —— 一次到位，产物仍是链接 → 第五步下载
{ "tpl_group":"dashscope-image", "kind":"image", "group_label":{"zh":"通义图片生成","en":"DashScope Image"},
  "role":"generate", "mode":"sync", "method":"POST",
  "url":"{baseUrl}/api/v1/services/aigc/multimodal-generation/generation",
  "headers":{ "Content-Type":"application/json", "Authorization":"Bearer {apiKey}" },
  "body":{ "model":"{model}", "input":{ "messages":[ { "role":"user",
                     "content":[ { "text":"{prompt}" } ] } ] },
           "parameters":{ "size":"{size}", "n":"{n}", "watermark":"{watermark}" } },
  "vars":[ { "name":"prompt","stage":"call","type":"string" },
           { "name":"size","stage":"instance","type":"string","default":"1024*1024",
             "label":{"zh":"出图尺寸","en":"Size"},
             "options":["1024*1024","2048*1152","2688*1536"],"allowCustom":true },
           { "name":"n","stage":"instance","type":"int","default":1,"label":{"zh":"张数","en":"Count"} },
           { "name":"watermark","stage":"instance","type":"bool","default":false,"label":{"zh":"水印","en":"Watermark"} } ],
  "decode":"url",
  "resp":{ "image":"output.choices.0.message.content.0.image", "errorCode":"code", "error":"message" } }

// ② generate·async —— 提交，多一个异步头，只登记 taskId
{ "tpl_group":"dashscope-image", "kind":"image", "role":"generate", "mode":"async", "method":"POST",
  "url":"{baseUrl}/api/v1/services/aigc/text2image/image-synthesis",
  "headers":{ "Content-Type":"application/json", "Authorization":"Bearer {apiKey}",
              "X-DashScope-Async":"enable" },
  "body":{ "model":"{model}", "input":{ "prompt":"{prompt}" },
           "parameters":{ "size":"{size}", "n":"{n}" } },
  "vars":[ /* 同上 */ ],
  "resp":{ "taskId":"output.task_id", "errorCode":"code", "error":"message" } }

// ③ query·sync —— 轮询 + 取产物
{ "tpl_group":"dashscope-image", "kind":"image", "role":"query", "mode":"sync", "method":"GET",
  "url":"{baseUrl}/api/v1/tasks/{taskId}",
  "headers":{ "Authorization":"Bearer {apiKey}" },
  "vars":[], "decode":"url", "poll_interval_ms":1500, "poll_timeout_ms":180000,
  "resp":{ "image":"output.results.0.url", "status":"output.task_status",
           "success":["SUCCEEDED"], "pending":["PENDING","RUNNING"],
           "fail":["FAILED","CANCELED","UNKNOWN"], "errorCode":"code", "error":"message" } }
```

```jsonc
// provider（实例，选异步）
{ "kind":"image", "label":"通义出图", "tpl_group":"dashscope-image",
  "base_url":"https://dashscope.aliyuncs.com", "secrets":{ "apiKey":"sk-…" },
  "mode":"async", "model":"wan2.2-t2i-flash",
  "params":{ "size":"1024*1024", "n":1, "watermark":false },
  "max_concurrency":2, "retry_times":3 }
```

**一次异步调用的完整走查**（实例 `mode=async`，prompt=「一只戴宇航员头盔的橘猫」）：

```
① 提交   POST https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis
         headers Authorization: Bearer sk-****（长度 35） / X-DashScope-Async: enable
         body   {"model":"wan2.2-t2i-flash","input":{"prompt":"一只戴宇航员头盔的橘猫"},
                 "parameters":{"size":"1024*1024","n":1}}
② 取 id  resp.taskId = "output.task_id" → 8c1b…
③ 轮询   GET  …/api/v1/tasks/8c1b…  → output.task_status = "RUNNING"  (pending)
         …1.5s… → "SUCCEEDED"  (success) → 停止轮询
④ 取产物 output.results.0.url = "https://…-signed-expires-in-24h.png"
⑤ 下载   GET 该链接（fetch_headers 为空 → 裸 GET）→ 落 asset（kind='image'）
         项目里只存 assetId，不存这条 URL
```

## 十一、内置模板组清单（seed）

| `tpl_group` | kind | 组内接口 |
|---|---|---|
| `openai-chat` | llm | `generate·sync` |
| `dashscope-cosyvoice` | tts | `synthesize·sync` + `clone` |
| `dashscope-qwen-tts` | tts | `synthesize·sync`（产物是链接）+ `clone`（`qwen-voice-enrollment` / `action:'create'` / `output.voice`） |
| `openai-speech` | tts | `synthesize·sync`（响应体即音频；无 `clone` → 界面显式提示不支持克隆） |
| `minimax-t2a` | tts | `synthesize·sync`（`data.audio` 是 **hex**；第二密钥槽填 `group_id`） |
| `volc-tts` | tts | `synthesize·sync`（headers 三个 `X-Api-*`；第二密钥槽填 Access Key） |
| `dashscope-image` | image | `generate·sync` + `generate·async` + `query` |
| `openai-image` | image | `generate·sync` + `generate·async` + `query` |
| `custom-*` | 三类各一 | 单条空白 `generate`，供手工接一家没预置的服务 |

> 表中标注的上游形状（Qwen 克隆、异步图片、MiniMax hex）以「试调用」按真实响应确认后再定稿；未确认前不作为已验证事实。

## 十二、实现落点

| 文件 | 职责 |
|---|---|
| `docs/db-schema-v2.sql` | 两张表 DDL + 三条自检视图 |
| `src/lib/request-engine.ts` | 纯函数：模板求值（`{var}` 保类型 / `{@var}` 展开 / `when` 门控 / `omitIfEmpty` 级联剪枝）、出参按槽位取值、解码、五步管线编排、`validateTemplate`、密钥打码 |
| `src/lib/template-seed.ts` | 内置模板组 seed（铺表 + 「恢复默认」的覆盖源） |
| `src/lib/provider-queue.ts` | 队列：并发 / 退避重试 / 取消 / 进度回调 |
| `src/lib/providers.ts` | `callLLM` / `callTTS` / `callImage` / `cloneVoice` 薄壳：实例 → 解析组模板 → 走引擎 → 产物落 `asset` |
| `src/stores/providerStore.ts` | 两份实体（模板组 + 实例）的读写与持久化；`activeProvider()` 返回带解析后的组模板 |
| `electron/db-v2.mjs` / `main.mjs` | 表映射与 IPC（`templates:list/upsert/remove`、`providers:*`）；通用 `net:request`（带 abort signal） |
| `src/components/ProviderPanel.tsx` | ⚙ 实例设置页 |
| `src/components/EndpointTemplatesPage.tsx` | 接口模板整屏页 |
| `src/components/GenerateDialog.tsx` | 逐行 / 全部配音走队列（进度 + 取消），产物即时落 asset |
