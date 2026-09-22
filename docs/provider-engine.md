# 供应商配置设计：模板组 · 接口模板 · 实例 · 取回管线 · 调度

> 一句话：**模板组 = 一个功能有哪几条接口、各自怎么发怎么取回（共享数据）；实例 = 选哪组模板 + 账号（base_url / Key）+ 同步还是异步 + 实例期参数；调用期正文与 `taskId` 不落库；一次动作发多条请求走内存队列。**

## 一、四层职责

| 层 | 存哪 | 装什么 | 谁编辑 |
|---|---|---|---|
| **模板** | `provider_template_group` + `provider_template` | 一个功能需要哪几条接口（组）+ 每条接口怎么发、返回从哪取（行） | 接口模板页（专家） |
| **实例** | `provider` | 用哪组模板、Base URL、密钥、同步还是异步、模板要求实例填的参数值、并发与重试 | ⚙ 实例设置页（日常） |
| **调用** | **不落库** | 一次动作的正文（字幕文本、图片描述、参考音频字节）与在途 `taskId` | 代码调用点 |
| **调度** | **内存队列** | 批量动作的并发上限、退避重试、取消、逐条进度 | 代码，不给界面 |

**一个能力 = 一行实例 = 一份 base_url + 一个 Key。** 组里那几条接口（生成 / 查询 / 克隆）都是模板行，它们没有 Key 这一格可填，求值时从实例行取 —— 所以异步图片不会让你填两次凭证。

## 二、模板：组表 + 接口表

```sql
CREATE TABLE IF NOT EXISTS provider_template_group (
  tpl_group TEXT PRIMARY KEY,                       -- 组 id：openai-chat / dashscope-image …
  kind      TEXT NOT NULL,                          -- llm / tts / image
  label     TEXT NOT NULL DEFAULT '',               -- 显示名「通义图片生成」
  note      TEXT,                                   -- 说明（L 的 JSON）
  ord       INTEGER NOT NULL DEFAULT 0,             -- 组列表排序
  created_at INTEGER, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_tg_kind ON provider_template_group(kind, ord);

CREATE TABLE IF NOT EXISTS provider_template (
  tpl_id      TEXT PRIMARY KEY,                     -- 接口行 id
  tpl_group   TEXT NOT NULL REFERENCES provider_template_group(tpl_group) ON DELETE CASCADE,
  role        TEXT NOT NULL,                        -- generate / synthesize / query / clone
  mode        TEXT NOT NULL DEFAULT 'sync',         -- 这条变体服务哪种方式：sync / async
  ord         INTEGER NOT NULL DEFAULT 0,           -- 组内展示顺序
  method      TEXT NOT NULL DEFAULT 'POST',
  url         TEXT NOT NULL DEFAULT '',             -- 地址模板，占位符决定 {baseUrl} 出现在哪
  headers_json TEXT,  query_json TEXT,  body_json TEXT,  resp_json TEXT,
  inst_params_json TEXT,  req_params_json TEXT,
  decode      TEXT,                                 -- 产物解码：NULL / hex / base64 / url
  fetch_headers_json TEXT,                          -- 下载产物时附带的请求头（NULL = 裸 GET 签名链接）
  poll_interval_ms INTEGER NOT NULL DEFAULT 1500,   -- 离散步长类参数，存原值
  poll_timeout_ms  INTEGER NOT NULL DEFAULT 120000,
  created_at INTEGER, updated_at INTEGER,
  CHECK (headers_json IS NULL OR json_valid(headers_json))   /* 其余 JSON 列同理 */
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tpl_role ON provider_template(tpl_group, role, mode);
CREATE INDEX IF NOT EXISTS ix_tpl_group ON provider_template(tpl_group, ord);
```

- **组级信息（`kind` / `label` / `note`）只在组表一份**，接口表只剩「一个接口怎么发怎么取」。同组不一致这类 bug 结构上不可能出现，也不需要自检视图去盯。
- `kind` / `role` / `mode` / `decode` **不写 DDL CHECK**：取值由 TS 联合类型 + 保存前 `validateTemplate()` 管，接一家新供应商不改表结构。
- 内置模板由 seed 目录在首次建库时铺成两张表的行；之后就是普通可编辑数据。`恢复默认` = 用 seed 覆盖该组及其行；`另存为副本` = 复制组行 + 其下接口行为新 `tpl_group`。
- 一个组里的 role 组合：
  - `llm`：`generate`
  - `image`：`generate·sync` ｜ `generate·async` + `query`（两种变体可并存，实例选）
  - `tts`：`synthesize·sync` ｜ `synthesize·async` + `query`，外加独立的 `clone`（恒 `sync`，与同步/异步无关）

## 三、`provider`（实例表）

```sql
CREATE TABLE IF NOT EXISTS provider (
  provider_id TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                     -- llm / tts / image
  label       TEXT NOT NULL DEFAULT '',
  tpl_group   TEXT NOT NULL REFERENCES provider_template_group(tpl_group),
  base_url    TEXT NOT NULL DEFAULT '',
  api_key     TEXT NOT NULL DEFAULT '',          -- 主密钥（{apiKey}）
  api_key2    TEXT,                              -- 第二凭证（{apiKey2}）：火山 TTS 的 Access Key
  mode        TEXT NOT NULL DEFAULT 'sync',      -- 这个账号走同步还是异步
  model       TEXT NOT NULL DEFAULT '',
  voice       TEXT,
  speed       REAL NOT NULL DEFAULT 1,
  params_json TEXT,                              -- 只存模板声明的那些入参的取值
  max_concurrency INTEGER NOT NULL DEFAULT 1,    -- 批量并发上限（1 = 串行）
  retry_times     INTEGER NOT NULL DEFAULT 2,    -- 限流/网络错的退避重试次数
  extra       TEXT,                              -- 兜底：深合并进 body 的附加 JSON
  active      INTEGER NOT NULL DEFAULT 0,        -- 每个 kind 至多一条为 1
  ord         INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_provider_active ON provider(kind) WHERE active = 1;
CREATE INDEX IF NOT EXISTS ix_provider_kind ON provider(kind, ord);
```

- **两个密钥就是两个具名列**（`api_key` / `api_key2`），不用 JSON 槽位表：槽数固定，拆列之后界面一格对一列、读写两端少一次序列化，`json_valid` 检查也不必了。两列都是 `type=password` 输入框，**永不回显原文**，预览里只显 `Bearer sk-****（长度 35）`。
- **只装凭证**：MiniMax 的 `group_id` 是 query 串上的账号标识（`POST {base}?group_id=…`），由模板声明成普通入参、存 `params_json`、界面正常显示 —— 借住在密钥列会让"这列都是敏感值"的语义失效，将来做导出脱敏时说不清。
- **`mode` 在实例上**：选完就决定用组里哪条 `generate` 变体、要不要 `query`。该组没有 async 变体时界面上不给这个选项（**显式不可用，不做隐式降级**）。
- `max_concurrency` / `retry_times` 是账号/上游限额属性（同一家不同账号额度不同），所以属实例层。
- `params_json` 的键 = 该组各接口声明表里入参名的并集；同名跨接口共用一个值（`synthesize` 与 `clone` 天然共用 `model`，这就是「克隆产出的音色绑同款 target_model」的落法）。
- 取值优先级：**调用端显式传入 > 实例 `params_json` > 模板 `default`**。
- **凭证按能力各配一份**：llm / tts / image 三处各自填 `base_url` + `api_key`，**不抽公共凭证表**。一次配置只管一个能力，删改互不影响，界面也不必多一层「账号」概念。代价是同一家厂商（如通义一个 Key 打通三类）的 Key 要填三遍 —— 这个代价明确接受。

## 四、入参声明：`inst_params_json` 与 `req_params_json`

两类参数**各存一个 JSON 列**，界面上也是两块独立的表（不再用一个 `stage` 判别字段区分）：

- **实例参数**（`inst_params_json`）：建实例时在 ⚙ 配的值 —— `size` / `format` / `sampleRate` / `temperature`…
- **请求参数**（`req_params_json`）：每次调用由程序传进来的值 —— `text` / `prompt` / `systemPrompt` / `userPrompt` / `wavB64`…

两份结构完全相同（下面的字段表），只是归属不同：实例页只渲染前者，试调用面板只给后者长输入框。
**名字与说明都是用户自己填的单个字符串，不做中英两份**（自定义的东西没法自动翻译）。

```jsonc
// inst_params_json —— 实例页渲染成控件
[ { "name": "size", "type": "string",
    "label": "出图尺寸", "default": "1024*1024",
    "options": [ { "value": "1024*1024", "label": "方图" },
                 { "value": "2048*1152", "label": "2048×1152" } ], "allowCustom": true } ]

// req_params_json —— 实例页不出现，只在试调用面板长输入框
[ { "name": "prompt", "type": "string" } ]
```

| 字段 | 含义 |
|---|---|
| `name` | 占位符名（body / url / headers 里写 `{name}`） |
| `type` | `int`｜`string`｜`bool`｜`list`｜`json`（模板页是**下拉框**，不给自由输入） |
| `label` | 显示名，**单个字符串**（纯显示，不进请求体） |
| `default` | 模板给的默认值（实例没填就用它） |
| `options` | 候选值：裸值或 `{value,label}`；有候选 → `OptionBlocks`，不写原生 `<select>` |
| `allowCustom` | 才给「其它值」输入框；默认只能选 |
| `when` | 等值门控（`"mode == async"`），不成立则该槽不参与求值、界面也不显示 |
| `omitIfEmpty` | 没给值时**连父键一起删**（不少上游拒绝空数组 / 空 `parameters`，但"键不存在"合法） |
| `item` | `list` 的元素子模板：`body` + `fields[]`，界面是行编辑器 |

- 控件由 `options` 决定、与 `type` 正交；`bool` 隐含开/关两个选项。
- 保留占位符不必声明，由实例行直接提供：`{baseUrl}` `{apiKey}` `{apiKey2}` `{model}` `{voice}` `{speed}` `{mode}` `{taskId}`。其中 `voice` 默认取实例列、调用端可逐行覆盖。
- 候选值由模板写死，**不运行时从上游拉**（各家没有统一 list 接口，顺序/文案不可控）。
- **调用期的正文为什么要声明出来**：`{text}`（待合成文本）`{prompt}`（出图描述）`{systemPrompt}` / `{userPrompt}`（对话）`{wavB64}`（参考音频）这些值每次调用由程序给，声明它们不是为了让人配，而是为了：① 试调用面板知道该长几个输入框（`callVarsOf`）；② 校验时能区分「声明过的调用期参数」和「打错字的占位符」。它们**放在 `req_params_json`**，实例页因此一个都不会渲染出来 —— 早先那种「一整排没人能配的灰字」就是这么来的。`{taskId}` 是例外：②之后由引擎自注，不声明。
- 界面规则：实例页只渲染该组各接口 `inst_params_json` 里 `when` 成立的参数（写回 `provider.params_json`）；模板页两张表都在，`req_params_json` 那张标「每次调用由程序传进来」。

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

- **路径写法用方括号下标**：`output.choices[0].message.content[0].image`、`audios[0].url` —— 与上游文档、jq、JSONPath 的写法逐字一致，抄过来就能用。求值前一行归一化：`path.replace(/\[(\d+)\]/g, '.$1').split('.')`，**存库存原样**（不做"存进去跟输入不一样"的把戏）。`output.choices.0.message.content` 这种纯点号写法同样收，但不是界面与文档的写法。
- **只支持 `[数字]`**，不做完整 JSONPath（`$..`、`[*]`、`[?(@.x=='y')]`）：那要引依赖或写解析器，而且模板里一旦能写表达式，「看模板就知道实际发了什么」这个前提就没了。上游是 batch 接口（一个请求回多条）时，按下标取就够了。
- 三枚举用标签编辑器（可增删多个值），因为上游状态名不止一个（`FAILED` / `CANCELED` / `UNKNOWN`）。
- `decode` 描述"拿到的东西怎么变成字节"：`NULL`（响应体即字节 / 槽位里就是 data URI）｜`hex`（MiniMax 音频）｜`base64`｜`url`（槽位取到的是远端链接 → 走第⑤步下载）。

## 六、产物取回管线与异步的组装规则

### 五步管线（引擎固定动作，模板只给每步的参数）

| 步 | 做什么 | 由哪些列决定 |
|---|---|---|
| ① **提交** | 按 `generate` / `synthesize` 行发请求 | `url` / `method` / `headers_json` / `body_json` / 两份参数声明 |
| ② **取任务 id** | 从 ① 的响应读 `taskId`（仅异步） | `generate·async` 行的 `resp.taskId` |
| ③ **轮询状态** | 用 `query` 行反复查，直到命中三枚举之一 | `query` 行的 `url`（含 `{taskId}`）+ `resp.status` + 三枚举 + `poll_interval_ms` / `poll_timeout_ms` |
| ④ **取产物** | 按产物槽取值；槽为空则整个响应体即产物 | `query`（异步）或 `generate`（同步）行的 `resp.image` / `resp.audio` |
| ⑤ **下载并落库** | `decode='url'` 时当场 GET 成字节，**立刻落 `asset`** | 同一行的 `fetch_headers_json`（默认裸 GET；私有 CDN 要带 `Authorization` 才填） |

**列的归属**：`poll_interval_ms` / `poll_timeout_ms` / `decode` / `fetch_headers_json` 四列**只有 `role=query` 的行读**（异步时产物出自 query 行）；同步出图/出音没有 query 行，才落在 `generate·sync` / `synthesize·sync` 行上。在 generate 行上调轮询间隔不生效 —— 界面按 mode 只渲染真正被读的那一行。

### 查询接口怎么和生成接口组装在一块

**靠"同组 + role"，不靠指针**：组装键是 `(tpl_group, role='query')`，唯一索引 `ux_tpl_role` 保证一个组最多一条 query，所以「该找谁查」没有歧义、也没有可填错的字段。

```
实例 mode=async  →  组内取两行：generate·async（提交） + query（查询）
① 用 generate 行发请求
② 按 generate 行的 resp.taskId 读出 id  →  注入求值上下文 {taskId}
③ 用 query 行：url "{baseUrl}/api/v1/tasks/{taskId}" 求值后发请求
     状态 = readPath(json, query.resp.status)
       ∈ query.resp.pending → 等 query.poll_interval_ms 再来一次
       ∈ query.resp.success → 进 ④
       ∈ query.resp.fail    → 报错，点名状态原文 + errorCode / error
       超过 query.poll_timeout_ms → 超时
④ 产物路径取 query 行的 resp.image / resp.audio（不是 generate 行的）
⑤ 下载用 query 行的 decode + fetch_headers_json
```

即异步这一组的分工是：**`generate·async` 只负责「提交 + 交出 taskId」，`query` 负责「怎么查、什么算成功、产物在哪、怎么下载」**。

不用 `poll.statusRole = "image.query"` 那种显式指针：v1 是指针，实测造出过「指向自己」的脏行（切异步时自动补一条 query，状态下拉里只有它自己，调用才报错）。代价是一个组只能有一条 query —— 目前没有「同组两条异步 generate 各配不同查询接口」的上游，真出现再加回指针列。

### 两条硬规矩

- **⑤ 是当场下载**：异步查询返回的链接带时效，跨会话必失效。项目数据里**绝不存远端产物 URL**，只存 `asset` id —— 否则第二天导出是一片空图。
- 下载不单独建 `download` 接口行：它没有业务语义、没有出参槽位，做成行会让人以为要配两条查询接口；唯一需要配的"能不能带鉴权头"由 `fetch_headers_json` 一列承担。`clone` 只走 ①④（返回 json，不产字节）。

## 七、配对与保存前校验

**组内 role 齐备性**：

| kind | 必填 | 条件必填 | 可选 |
|---|---|---|---|
| `llm` | `generate·sync`（`content` 非空） | — | — |
| `image` | `generate`（sync / async 至少一条） | 实例 `mode=async` → `generate·async`（`taskId`）+ `query`（产物 + `status` + `success`） | `generate` 的另一条变体 |
| `tts` | `synthesize`（sync / async 至少一条） | 实例 `mode=async` → `synthesize·async`（`taskId`）+ `query`（产物 + `status` + `success`） | `clone`（缺则「克隆音色」区显示「该供应商不支持克隆」，不摆死按钮） |

**其余规则**：

1. 实例 `mode=sync` → 该 `generate` 行**不允许**出现 `taskId` / `status` / 三枚举；组里若有 `query` 行也不参与求值（界面提示「本实例走同步，查询接口未使用」）。
2. `decode='url'` 的行必须有产物槽位（`image` / `audio`），否则第⑤步没有可下载的东西。
3. `url` / `headers` / `body` 引用的占位符必须**在两份声明表之一里**，或属保留占位符（`{baseUrl}` `{apiKey}` `{model}` `{voice}` `{speed}` `{taskId}` 由实例或引擎给，不必声明）。
4. `list` 变量必须给 `item`；`bool` 变量不必给 `options`（给了即报错）。
5. 缺必填 role → 实例行标红不可用；缺项**当场点名**，不留到运行时。
6. 引用完整性由**真外键**保证：`provider.tpl_group` → 组表（删组会拦住或级联，按外键策略定），`provider_template.tpl_group` → 组表 `ON DELETE CASCADE`（删组连带删接口行）。只有 `poll` 关系（generate ↔ query）是隐式的，不需要自检视图。
7. 模板行被实例引用时允许改（模板是共享数据），但界面顶部显式提示「N 个实例正在使用这组模板」，并给「另存为副本」。

## 八、调度层（`src/lib/provider-queue.ts`，内存，不是表）

一次用户动作会发多条请求：逐行配音（30 行字幕 = 30 次 `synthesize`，异步的每次还要轮询十几秒）、批量出图、整片重配音。

| 项 | 规则 |
|---|---|
| 并发 | 按实例 `max_concurrency` 取任务，默认 1（串行）；同一实例的单行配音 / 试听与批量走**同一个队列**，否则两条路会同时打上游 |
| 重试 | 只重试 **429 / 5xx**（`EngineError` 带上游状态码），500ms 起指数退避；**业务错（模型名不存在、参数非法）与不带状态码的错（CORS、缺变量）不重试**，直接点名。`Retry-After` 要主进程回传该响应头，暂未做 |
| 取消 | 每次取下一条前检查取消标志 —— **在途的那条会跑完**，未开始的行不再发起，已完成条目保留。（真中断要把 abort signal 一路透传到主进程 fetch，IPC 通道得带会话 id，暂未做） |
| 进度 | 逐条回调 → 字幕生成显示 `7/30 · 已用 2:10 · ✕ 取消` |
| 落库 | **产物一拿到就逐条落 `asset`**，不等整批：30 行跑到第 20 行失败，前 19 行不能白跑；失败行下次被「只补没配音的」自然重跑 |

不建任务表：`taskId` 只在一次调用内有意义（上游任务几十分钟过期），而「哪几行还没配音」项目数据本身就是清单（`narration_entry` 有没有音频），再存一份就是第二处真相。

## 九、界面：两页分工

| 页面 | 装什么 |
|---|---|
| **⚙ 实例设置**（`ProviderPanel`） | 模板组下拉（查组表，按 kind 过滤）→ Base URL / API Key / 第二凭证 → **同步 / 异步** → 该组的**实例参数**表 → 并发数 / 重试次数 |
| **接口模板页**（`TemplatesPane`，⚙ 左侧第 4 个独立入口） | 模板组列表（含「N 个实例在用」）→ **每个 role 一张接口卡片**：url / method / headers / body / **实例参数**表 / **请求参数**表（名字 · 类型下拉 · 默认 · 说明 · 候选值）/ **返回槽位表单** / 解码 / 下载头 / 轮询节奏 + 预览请求 · 试调用；底部一排「＋」补接口 |

### 查询接口与音色克隆在哪配

**一个组里每个 role 一张卡片**，seed 铺组时就把该有的行铺上；手工接一家时靠底部那排「＋」补：

| kind | 卡片（role·mode） | 出现条件 | 新增入口 |
|---|---|---|---|
| `llm` | 文案生成 `generate·sync` | 恒有 | 唯一必需行，不给删 |
| `image` | 图片生成·同步 `generate·sync` | 该家有同步接法 | 「＋ 生成接口·同步」 |
| `image` | 图片生成·异步 `generate·async` | 该家有异步接法 | 「＋ 生成接口·异步」 |
| `image` | **状态查询 `query`** | 组里有 async 生成行时才有意义 | 「＋ 查询接口」 |
| `tts` | 语音合成 `synthesize·sync` / `·async` | 同图片两行 | 「＋ 合成接口·同步 / ·异步」 |
| `tts` | **状态查询 `query`** | 同上 | 「＋ 查询接口」 |
| `tts` | **音色克隆 `clone`** | 该家支持建音色 | 「＋ 音色克隆」 |

- 成对关系写在两处，谁都不必猜：`query` 卡片顶部一行「↑ 供 `generate·async` 轮询使用」；`generate·async` 卡片顶部一行「轮询用：`query` ✓」或「轮询用：**缺查询接口** → 点下方「＋ 查询接口」」。
- 同一 role 只能有一张（唯一索引 `(tpl_group, role, mode)`），所以已有 `query` 时「＋ 查询接口」不出现 —— 不给配出两条查询接口的机会。
- 「✕ 删接口」走二次确认，说清「模板组的默认形状不受影响，可再点＋加回来，但你在模板里改过的内容会丢」。
- 缺必填 role 时实例页顶部红字点名（第七节），并给「＋ 去补」直接跳到模板页。
- 两页不混在同一屏；⚙ 是唯一入口（`VoicePicker` 只留选音色 + 试听）。
- 实例页每个控件都要对得上库里某一列（`api_key` 一格对 `api_key` 一列，参数一格对 `params_json` 的一个键）；空值写成「删键」而不是存 `null`。
- **试调用**是这套设计的验收口：每张接口卡片给「实际发出的请求」（密钥打码）+「响应摘要」（状态码、按槽位取到的值、音频给播放键、异步逐次显示轮询过程与状态原文、失败原样带上游 `code/message`）。
- 模板里**不做循环 / 条件表达式**（只有 `when` 等值门控）。一旦能写表达式，配置就从填表变成写程序，出错时看模板也看不出实际发了什么，试调用就失去意义。

## 十、内容示例

> 权威副本是 `src/lib/template-seed.ts`（seed 就是这些行）；这里挑三组说明读法。
> 名字与说明都是**单个字符串**；`reqParams` = 每次调用由程序给，`instParams` = 建实例时在 ⚙ 配。

### 10.1 文案生成 · `openai-chat`（一组一行）

```jsonc
// provider_template_group
{ "tpl_group":"openai-chat", "kind":"llm", "label":"OpenAI 兼容对话",
  "note":"DeepSeek / 通义 / Kimi 等一切 /chat/completions 兼容服务",
  "base_url":"https://api.deepseek.com", "models":["deepseek-chat","deepseek-v4-pro"],
  "default_model":"deepseek-chat" }

// provider_template
{ "tpl_group":"openai-chat", "role":"generate", "mode":"sync", "method":"POST",
  "url":"{baseUrl}/chat/completions",
  "headers":{ "Content-Type":"application/json", "Authorization":"Bearer {apiKey}" },
  "body":{ "model":"{model}",
           "messages":[ { "role":"system", "content":"{systemPrompt}" },
                        { "role":"user",   "content":"{userPrompt}" } ],
           "temperature":"{temperature}", "max_tokens":"{maxTokens}" },
  "req_params":[ { "name":"systemPrompt", "type":"string" },
                 { "name":"userPrompt",   "type":"string" } ],
  "inst_params":[ { "name":"temperature", "type":"int", "default":7, "label":"温度（×10）" },
                  { "name":"maxTokens",   "type":"int", "default":"", "omitIfEmpty":true, "label":"最大输出 token" } ],
  "resp":{ "content":"choices[0].message.content", "errorCode":"error.code", "error":"error.message" } }

// provider（实例）
{ "kind":"llm", "label":"DeepSeek", "tpl_group":"openai-chat",
  "base_url":"https://api.deepseek.com", "api_key":"sk-…", "mode":"sync",
  "model":"deepseek-chat", "params":{ "temperature":7, "maxTokens":2048 },
  "max_concurrency":1, "retry_times":2 }
```

### 10.2 语音 · `dashscope-cosyvoice`（合成 + 克隆，没有查询接口）

```jsonc
// ① synthesize·sync —— 实测：回的是 JSON，音频在 output.audio.url（带时效）→ 当场下载
{ "tpl_group":"dashscope-cosyvoice", "role":"synthesize", "mode":"sync", "method":"POST",
  "url":"{baseUrl}/services/audio/tts/SpeechSynthesizer",
  "headers":{ "Content-Type":"application/json", "Authorization":"Bearer {apiKey}" },
  "body":{ "model":"{model}",
           "input":{ "text":"{text}", "voice":"{voice}", "format":"{format}", "sample_rate":"{sampleRate}" } },
  "req_params":[ { "name":"text", "type":"string" } ],
  "inst_params":[ { "name":"format","type":"string","default":"mp3","label":"音频格式","options":["mp3","wav","pcm"] },
                  { "name":"sampleRate","type":"int","default":24000,"label":"采样率","options":[16000,24000,48000] } ],
  "resp":{ "audio":"output.audio.url", "errorCode":"code", "error":"message" },
  "decode":"url" }

// ② clone·sync —— 建音色各家都是同步，恒 mode=sync；与 synthesize 共用实例的 model
{ "tpl_group":"dashscope-cosyvoice", "role":"clone", "mode":"sync", "method":"POST",
  "url":"{baseUrl}/services/audio/tts/customization",
  "body":{ "model":"voice-enrollment",
           "input":{ "action":"create_voice", "target_model":"{model}", "prefix":"{prefix}",
                     "url":"data:audio/wav;base64,{wavB64}" } },
  "req_params":[ { "name":"wavB64", "type":"string" } ],
  "inst_params":[ { "name":"prefix", "type":"string", "default":"mv", "label":"音色名前缀" } ],
  "resp":{ "voiceId":"output.voice_id", "errorCode":"code", "error":"message" },
  "ref_sample_rate":16000 }

// provider（实例）—— 合成与克隆共用这一份 base_url + Key + model
{ "kind":"tts", "label":"通义配音", "tpl_group":"dashscope-cosyvoice",
  "base_url":"https://dashscope.aliyuncs.com/api/v1", "api_key":"sk-…", "mode":"sync",
  "model":"cosyvoice-v3-flash", "voice":"longanyang", "speed":1,
  "params":{ "format":"mp3", "sampleRate":24000, "prefix":"mv" } }
```

响应体本身就是音频的（OpenAI /audio/speech、火山），把 `audio` 槽**留空串**即可 —— 引擎按 `Content-Type` 判定，`resp.audio === ''` 就是"整个响应体是产物"。

### 10.3 图片 · `dashscope-image`（同步与异步两种变体并存，实例选一种）

```jsonc
{ "tpl_group":"dashscope-image", "kind":"image", "label":"通义图片生成",
  "base_url":"https://dashscope.aliyuncs.com/api/v1",
  "models":["z-image-turbo","qwen-image","wan2.6-t2i"], "default_model":"z-image-turbo" }

// ① generate·sync —— 实测形状（照本机 gen_images.py 在用那份）
{ "role":"generate", "mode":"sync", "method":"POST",
  "url":"{baseUrl}/services/aigc/multimodal-generation/generation",
  "body":{ "model":"{model}", "input":{ "messages":[ { "role":"user", "content":[ { "text":"{prompt}" } ] } ] },
           "parameters":{ "size":"{size}", "prompt_extend":"{promptExtend}", "watermark":"{watermark}" } },
  "req_params":[ { "name":"prompt", "type":"string" } ],
  "inst_params":[ { "name":"size","type":"string","default":"2048*1152","allowCustom":true,"label":"出图尺寸",
                    "options":["1024*1024","2048*1152","2688*1536"] },
                  { "name":"promptExtend","type":"bool","default":false,"label":"提示词改写" },
                  { "name":"watermark","type":"bool","default":false,"label":"水印" } ],
  "resp":{ "image":"output.choices[0].message.content[0].image", "errorCode":"code", "error":"message" },
  "decode":"url" }

// ② generate·async —— 多一个异步头，只登记 taskId；参数与 ① 同（多个 count 张数）
{ "role":"generate", "mode":"async", "method":"POST",
  "url":"{baseUrl}/services/aigc/image-generation/generation",
  "headers":{ "Content-Type":"application/json", "Authorization":"Bearer {apiKey}", "X-DashScope-Async":"enable" },
  "body":{ "model":"{model}", "input":{ "messages":[ { "role":"user", "content":[ { "text":"{prompt}" } ] } ] },
           "parameters":{ "size":"{size}", "n":"{count}", "watermark":"{watermark}" } },
  "resp":{ "taskId":"output.task_id", "errorCode":"code", "error":"message" } }

// ③ query·sync —— 轮询节奏 / 产物 / 下载都在这条行上
{ "role":"query", "mode":"sync", "method":"GET",
  "url":"{baseUrl}/tasks/{taskId}",              // baseUrl 已含 /api/v1，不能再写一遍（实测 404）
  "headers":{ "Authorization":"Bearer {apiKey}" },
  "resp":{ "image":"output.choices[0].message.content[0].image", "status":"output.task_status",
           "success":["SUCCEEDED"], "pending":["PENDING","RUNNING"],
           "fail":["FAILED","CANCELED","UNKNOWN"], "errorCode":"code", "error":"message" },
  "decode":"url", "poll_interval_ms":1500, "poll_timeout_ms":180000 }

// provider（实例，选异步）—— 三条接口共用这一份 base_url + Key
{ "kind":"image", "label":"通义出图", "tpl_group":"dashscope-image",
  "base_url":"https://dashscope.aliyuncs.com/api/v1", "api_key":"sk-…",
  "mode":"async", "model":"wan2.6-t2i",
  "params":{ "size":"1024*1024", "count":1, "watermark":false },
  "max_concurrency":2, "retry_times":3 }
```

**一次异步调用的完整走查**（实例 `mode=async`，prompt=「一只戴宇航员头盔的橘猫」）：

```
① 提交   取 generate·async 行
         POST https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation
         headers Authorization: Bearer sk-****（长度 35） / X-DashScope-Async: enable
         body   {"model":"wan2.6-t2i","input":{"messages":[{"role":"user","content":[{"text":"一只戴宇航员头盔的橘猫"}]}]},
                 "parameters":{"size":"1024*1024","n":1,"watermark":false}}
② 取 id  resp.taskId = "output.task_id" → 8c1b…      （注入 {taskId}）
③ 轮询   取 query 行  GET …/api/v1/tasks/8c1b…  → "RUNNING"(pending) …1.5s… → "SUCCEEDED"(success)
④ 取产物 query 行 resp.image → https://…-signed-expires-in-24h.png
⑤ 下载   query 行 decode='url' + fetch_headers 为空 → 裸 GET → 落 asset（kind='image'）
         项目里只存 assetId，不存这条 URL
```

## 十一、内置模板组清单（seed）

| `tpl_group` | kind | 组内接口 |
|---|---|---|
| `openai-chat` | llm | `generate·sync` |
| `dashscope-cosyvoice` | tts | `synthesize·sync` + `clone` |
| `dashscope-qwen-tts` | tts | `synthesize·sync`（产物是链接）+ `clone`（`qwen-voice-enrollment` / `action:'create'` / `output.voice`） |
| `openai-speech` | tts | `synthesize·sync`（响应体即音频；无 `clone` → 界面显式提示不支持克隆） |
| `minimax-t2a` | tts | `synthesize·sync`（`data.audio` 是 **hex**；`group_id` 是普通入参，进 query 串） |
| `volc-tts` | tts | `synthesize·sync`（headers 三个 `X-Api-*`；`api_key2` 填 Access Key） |
| `dashscope-image` | image | `generate·sync` + `generate·async` + `query` |
| `openai-image` | image | `generate·sync` + `generate·async` + `query` |
| `custom-*` | 三类各一 | 单条空白 `generate`，供手工接一家没预置的服务 |

> **实测状态（2026-09-22，`tools/try-real-calls.mjs`，走的就是引擎这份代码）**：
> 语音合成 CosyVoice（`cosyvoice-v3-flash` + `longanyang`）、语音合成 Qwen-TTS（产物是带时效链接 → 当场下载）、
> 图片同步（`z-image-turbo`）、图片异步（`wan2.6-t2i`：提交 → 轮询 → 取产物 → 下载）四条真实调用全通过。
> 实测改掉的三处形状：CosyVoice 回的是 JSON（音频在 `output.audio.url`，不是响应体字节）、
> 异步出图走 `image-generation/generation` 且只认万相模型、查询地址是 `{baseUrl}/tasks/{id}`（baseUrl 已含 `/api/v1`）。
> **仍未实测**：声音克隆（会在账号下建音色资源）、MiniMax hex、火山、OpenAI 两家。

## 十二、实现落点

| 文件 | 职责 |
|---|---|
| `docs/db-schema-v2.sql` | 组表 + 接口表 + 实例表 DDL（含真外键）与索引 |
| `src/lib/request-engine.ts` | 纯函数：模板求值（`{var}` 保类型 / `{@var}` 展开 / `when` 门控 / `omitIfEmpty` 级联剪枝）、出参按槽位取值、解码、五步管线编排、`validateTemplate`、密钥打码 |
| `src/lib/template-seed.ts` | 内置模板组 seed（铺两张表 + 「恢复默认」的覆盖源） |
| `src/lib/provider-queue.ts` | 队列：并发 / 退避重试 / 取消 / 进度回调 |
| `src/lib/providers.ts` | `callLLM` / `callTTS` / `callImage` / `cloneVoice` 薄壳：实例 → 解析组模板 → 走引擎 → 产物落 `asset` |
| `src/stores/providerStore.ts` | 三份实体（模板组 / 接口行 / 实例）的读写与持久化；`activeProvider()` 返回带解析后的组模板 |
| `electron/db-v2.mjs` / `main.mjs` | 表映射与 IPC（`templateGroups:*`、`templates:*`、`providers:*`）；通用 `net:request`（带 abort signal） |
| `src/components/ProviderPanel.tsx` | ⚙ 实例设置页 |
| `src/components/EndpointTemplatesPage.tsx` | 接口模板整屏页（query 作为异步卡片的子块） |
| `src/components/GenerateDialog.tsx` | 逐行 / 全部配音走队列（进度 + 取消），产物即时落 asset |
