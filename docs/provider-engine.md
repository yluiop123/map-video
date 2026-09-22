# 供应商配置设计：模板表 + 实例表 + 调度层

> 状态：**v2 设计稿（2026-09-22）**，第十二节 7 条待拍板；确认后按第十一节批次 A 开工。
> v1（批次 1–3，**已实现并本地提交**）：`src/lib/request-engine.ts`（模板求值 / 解码 / 轮询 / 校验，55 项离线回归）+ `src/lib/recipes.ts`（11 个模板包）+ `provider_endpoint` 建表与双端持久化 + ⚙ 实例设置页与整屏接口模板页 `EndpointTemplatesPage.tsx`。
> **v2 改的是四件事**：模板放在哪（代码 → 表）、参数分几期（同一行混存 → 声明分期）、返回怎么取（自由 map → 固定槽位）、批量怎么调度（`for` 里 await → 队列）。求值规则、双语约定、两页 UI 骨架沿用 v1。
> 本文写的是「将要改成什么样」；当前实现的权威事实仍是 `AGENTS.md` §4/§7/§10 与 `docs/db-tables.md`，批次 D 才回头同步它们。

## 〇、v1 留下的四个问题

| 症状 | v1 现状 | 为什么是问题 |
|---|---|---|
| **模板不是数据** | 真正的模板是 `src/lib/recipes.ts` 里的 TS 常量；`provider_endpoint` 只是「每个实例各自复制一份的副本」 | 改一个内置模板要改代码重打包；新建第二家同厂商会整组复制接口行，之后两份各改各的 → 又回到「同一条事实多处真相」 |
| **模板与实例混在同一行** | `provider_endpoint` 既有形状（`path` / `body_json`）又有实例值（`overrides_json`、`mode`、`enabled`） | 「这个格子属于模板还是属于实例」只靠注释维持，界面上分不清 |
| **同步/异步挂在接口行上** | `mode` 是每条 endpoint 的列 | 用户的心智是「这个账号走同步还是异步」，切一次要改多行；实测还留下「切回同步但 `poll` 残留」的脏行（2026-09-22 桌面端截图复现） |
| **出参要手打 JSON** | `pick_json` 自由 map + `poll_json{done,fail}` | 要人写 `statusRole`、`done.equals`，认知负担高，填错了只在运行时报 |

## 一、四层职责（v2 的地基）

| 层 | 存哪 | 装什么 | 谁编辑 |
|---|---|---|---|
| **模板** | `provider_template` 表 | 一个接口怎么发（url / headers / body）、声明哪些入参、返回从哪取 | 接口模板页（专家） |
| **实例** | `provider` 表 | 用哪组模板、Base URL、密钥、**同步还是异步**、模板要求实例填的参数值 | ⚙ 实例设置页（日常） |
| **调用** | **不落库** | 一次动作的正文（字幕文本、图片描述、参考音频字节）与在途 `taskId` | 代码调用点 |
| **调度** | **内存队列**（`provider-queue.ts`） | 一次批量动作的并发上限、退避重试、取消、逐条进度 | 代码，不给界面 |

一句话：**模板 = 形状（共享，与账号无关）；实例 = 账号 + 方式 + 取值；调度 = 一次动作发多条请求。**

## 二、`provider_template`（模板表）

**一行 = 一个接口**；同一功能的几个接口用 `tpl_group` 归成一组（「文案 / 图片 / 语音各是一组接口，不是一个」）。

```sql
CREATE TABLE IF NOT EXISTS provider_template (
  tpl_id      TEXT PRIMARY KEY,                       -- 模板行 id
  tpl_group   TEXT NOT NULL,                          -- 组 id：openai-chat / dashscope-image / custom-tts-1 …
  kind        TEXT NOT NULL,                          -- llm / tts / image（组内必须一致，见 v_check_tpl_group）
  group_label TEXT NOT NULL DEFAULT '',               -- 组显示名「通义图片生成」（组内冗余同值）
  role        TEXT NOT NULL,                          -- generate / synthesize / query / clone
  mode        TEXT NOT NULL DEFAULT 'sync',           -- 这条变体服务哪种方式：sync / async（query·clone 恒 sync）
  ord         INTEGER NOT NULL DEFAULT 0,             -- 组内展示顺序
  method      TEXT NOT NULL DEFAULT 'POST',
  url         TEXT NOT NULL DEFAULT '',               -- 地址模板，含 {baseUrl} {apiKey} {model} … 占位符
  headers_json TEXT,  query_json TEXT,  body_json TEXT,  vars_json TEXT,  resp_json TEXT,  -- 均 JSON，建表统一 json_valid 检查
  decode      TEXT,                                   -- 产物解码：NULL / hex / base64 / url
  fetch_headers_json TEXT,                             -- ★ 「下载产物」这一步附带的请求头（NULL = 裸 GET 签名链接）
  poll_interval_ms INTEGER NOT NULL DEFAULT 1500,     -- 离散步长类参数，存原值（AGENTS §10 例外②）
  poll_timeout_ms  INTEGER NOT NULL DEFAULT 120000,
  note        TEXT,                                   -- 组/接口说明（L 的 JSON）
  created_at INTEGER, updated_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tpl_role ON provider_template(tpl_group, role, mode);
CREATE INDEX IF NOT EXISTS ix_tpl_group ON provider_template(tpl_group, ord);
CREATE INDEX IF NOT EXISTS ix_tpl_kind  ON provider_template(kind, tpl_group);
```

- **`kind` / `mode` / `role` / `decode` 一律不加 CHECK**（AGENTS §6.24）：取值由 TS 联合类型 + 保存前 `validateTemplate()` 管，以后接一家新供应商不改表结构。
- `kind` / `group_label` 冗余在每行，是为了守住「只有两张表」；代价由自检视图 `v_check_tpl_group`（同组内不一致即报）兜，**不用触发器**。
- 内置模板：`recipes.ts` 降级成 **seed 目录**，首次建库时铺成表里的行；之后**行就是普通可编辑数据**。`恢复默认` = 用 seed 覆盖该行；`另存为副本` = 复制成新 `tpl_group` 给实例引用（改共享模板会影响所有引用它的实例，必须显式）。
- `url` 取代 v1 的 `path`：v1 靠「以 `{baseUrl}` 开头就是完整地址」的隐式规则，v2 只有一列，占位符自己决定 base 出现在哪（火山那种 base 与路径不连续的写法不用再绕）。

## 三、入参声明 `vars_json`

```jsonc
[ { "name": "size", "stage": "instance", "type": "string",
    "label": { "zh": "出图尺寸", "en": "Size" }, "default": "1024*1024",
    "options": [ { "value": "1024*1024", "label": { "zh": "方图", "en": "Square" } },
                 { "value": "2048*1152", "label": "2048×1152" } ], "allowCustom": true },
  { "name": "prompt", "stage": "call", "type": "string" } ]
```

- **`stage`：`instance`（建实例时填）｜`call`（调用时传）**。这就是 v1 的 `param` / `inject` 改名 —— 语义不变，但名字要说清「哪一期」，界面上才有对应措辞。
- **`type`：`int`｜`string`｜`bool`｜`list`｜`json`**（v1 的 `number` 归入 `int`，按上游需要保留小数）。`bool` 隐含两个选项，不写 `options`。
- 控件由 `options` 决定、与 `type` 正交：有候选 → `OptionBlocks`；`bool` → 开/关；`list` → 行编辑器；`json` → 多行 JSON 框；都没有 → 文本/数字框。**不写原生 `<select>`**。
- `allowCustom: true` 才给「其它值」输入框；默认只能选（宁可显式加候选，也不要放开自由输入再靠上游报错教人）。
- 一切给人看的字都是 `L = string | {zh,en}`，**只有 `value` 入库、进请求体**（选「16k · 通用」发出去的是 `16000`；`voice` 显示 龙安洋 / 值 `longanyang`）。渲染前统一过 `pickLabel(l, lang)`，语言切换不影响已存值。
- 候选值由模板写死，**不运行时从上游拉**（各家没有统一的 list 接口，拉回来的顺序/文案不可控）。
- 参数名**可自由增删**（内置常用项只做下拉提示、不做白名单）：`size` `quality` `format` `sample_rate` `temperature` `top_p` `max_tokens` `enable_thinking` `thinking_budget` `seed` `watermark` `prompt_extend`。
- 保留占位符由实例行直接提供、不必声明：`{baseUrl}` `{apiKey}` `{secret2}` `{model}` `{voice}` `{speed}` `{mode}`。`model` / `voice` / `speed` 同时是实例表列，因为 `VoicePicker` 与字幕链路要直接读它们。
- 界面规则：**实例页只渲染 `stage=instance` 且 `when` 成立的变量**（`when` 不成立就不显示，否则是「看着能配、实际不发」）；`stage=call` 的只读展示（标「调用时传入」），防止把请求正文当设置改。

### 数组 / 对象参数（沿用 v1 的三情形，零新机制）

| 情形 | 例 | 做法 |
|---|---|---|
| 数组是**常量骨架**，只有几个槽是变量 | chat 的 `messages:[{role:'system',…},{role:'user',…}]` | 数组直接写在 body 模板里，元素内用 `{var}` 填槽 |
| 元素形状固定、**条数可变** | 多轮 `history`、多张参考图、`stop` 词表 | 声明 `type:'list'`：`item` 子模板 + body 里 `{@name}` 展开，UI 是行编辑器 |
| **整段由用户给** | 自定义 `tools` 透传 | `type:'json'` + `{@name}`，UI 多行 JSON 带解析校验 |

嵌套对象（`{audio:{voice,format}}`）不需要点号路径语法糖：body 本来就是 JSON，直接写层级 + 槽位，比「路径输入框 + 冲突检测」少一套会出 bug 的代码。

## 四、返回槽位 `resp_json`（不再自由 map）

固定键，界面按 role+mode 只渲染该填的那几格，每格一个带标签的路径输入框：

```jsonc
{ "content":"", "image":"", "audio":"", "voiceId":"", "taskId":"",
  "status":"", "success":[], "fail":[], "pending":[],
  "errorCode":"code", "error":"message" }
```

| 功能 | 组内接口（role·mode） | 必填槽位 | 取回步骤 |
|---|---|---|---|
| 文案生成 | `generate·sync` | `content` | ① |
| 图片生成·同步 | `generate·sync` | `image` | ①→④（产物是链接时） |
| 图片生成·异步 | `generate·async` + `query·sync` | generate：`taskId`；query：`image` + `status` + `success[]`/`fail[]`/`pending[]` | ①→②→③→④ |
| 语音生成·同步 | `synthesize·sync` | `audio` | ①（响应体即字节）或 ①→④ |
| 语音生成·异步 | `synthesize·async` + `query·sync` | `taskId` / `audio` + `status` + 三枚举 | ①→②→③→④ |
| 声音克隆（tts 组内的第三条接口） | `clone·sync` | `voiceId` | ①（返回 json，不产字节） |

**tts 一组最多三条接口**：`synthesize`（合成）+ `query`（仅异步要）+ `clone`（音色克隆）。三者同属一个 `tpl_group`、共用实例的 `model` / `voice` / 密钥 —— 克隆产出的 voice 绑的就是同一个 `target_model`，这就是「关联请求成对配置」的落法。`clone` 与同步/异步**无关**（建音色这一步各家都是同步的），所以它恒 `mode=sync`。

### 产物取回管线（引擎固定四步，模板只给每步的参数）

| 步 | 做什么 | 由哪些列决定 |
|---|---|---|
| ① **提交** | 按 `generate`/`synthesize` 行发请求 | `url` / `method` / `headers_json` / `body_json` / `vars_json` |
| ② **取任务 id** | 从①的响应里读 `taskId` | `resp.taskId` |
| ③ **轮询状态** | 用 `query` 行反复查，直到命中三枚举之一 | `query` 行的 `url`（含 `{taskId}` 占位）+ `resp.status` / `success[]` / `fail[]` / `pending[]` + `poll_interval_ms` / `poll_timeout_ms` |
| ④ **下载产物** | 产物若是**链接**（`decode='url'`）就当场 GET 成字节，立刻落 `asset` | `fetch_headers_json`（默认 NULL = 裸 GET 签名链接；私有桶要带 `Authorization` 才填这里） |

- ④ 不建第三条「下载 role」：下载没有业务语义、没有出参槽位，建成接口行会让人以为要配两个查询接口；它只是 `decode='url'` 的**执行方式**。但**能不能带鉴权头必须可配**（各家 CDN 行为不一），所以给 `fetch_headers_json` 一列。
- 路径写法仍是**点号 + 数字下标**（`output.choices.0.message.content`、`audios.0.url`），不引 JSONPath。所以上游是 batch 接口（一个请求回多条）时，取回侧不用新机制。
- `decode`：`hex`（MiniMax 音频）｜`base64`｜`url`（产物是远端链接）｜NULL（响应体本身即字节 / JSON）。
- **`decode:'url'` 的语义是「当场下载」**：异步查询返回的链接带时效，必须立刻取字节并落成 `asset`，**绝不能把这个 URL 存进项目数据** —— 否则第二天导出是一片空图。这条把「批次 6：音频/图片落 asset」从待办顶成 v2 的前置依赖。
- 三枚举（`success` / `fail` / `pending`）用标签编辑器（可增删多个值），因为上游状态名不止一个（`FAILED` / `CANCELED` / `UNKNOWN`）。
- `resp_kind` 那一列（v1 的 auto/audio/json/text）不再要：响应是字节还是 JSON 由 `Content-Type` + `decode` 判，属引擎行为不是配置项。

## 五、`provider`（实例表）

```sql
CREATE TABLE IF NOT EXISTS provider (
  provider_id TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,                     -- llm / tts / image
  label       TEXT NOT NULL DEFAULT '',
  tpl_group   TEXT NOT NULL,                     -- ★ 取代 recipe：引用哪一组模板
  base_url    TEXT NOT NULL DEFAULT '',
  secrets_json TEXT,                             -- {apiKey, secret2}，UI 永不回显只显长度
  mode        TEXT NOT NULL DEFAULT 'sync',      -- ★ 新增：这个账号走同步还是异步
  model       TEXT NOT NULL DEFAULT '',
  voice       TEXT,
  speed       REAL NOT NULL DEFAULT 1,
  params_json TEXT,                              -- ★ 取代各接口行的 overrides_json：只存 stage=instance 的值
  max_concurrency INTEGER NOT NULL DEFAULT 1,    -- ★ 新增：批量并发上限（1 = 串行，即现行为）
  retry_times     INTEGER NOT NULL DEFAULT 2,    -- ★ 新增：限流/网络错的退避重试次数
  extra       TEXT,                              -- 兜底：深合并进 body 的附加 JSON
  active      INTEGER NOT NULL DEFAULT 0,
  ord         INTEGER NOT NULL DEFAULT 0
);
```

- **`mode` 在实例上**：同一家往往两种接法都有，选完 `mode` 就决定用组里哪条 `generate` 变体、要不要 `query`。该组没有 async 变体时界面上就不给这个选项（**显式不可用，不做隐式降级**）。
- `max_concurrency` / `retry_times` 是**账号/上游限额**属性（同一家不同账号额度不同），所以属实例层、不进模板表；它们是用户输入的原值，符合「只存输入原值」。
- `params_json` 的键 = 该组各接口 `stage=instance` 变量名的并集；同名跨接口共用一个值（`model` / `voice` 天然共享，这正是「synthesize 与 clone 必须同模型家族」的落法）。
- 优先级：**调用端显式传入 > 实例 `params_json` > 模板 `default`**。
- `extra` 保留为兜底出口，但不再是唯一出口。

## 六、配对与保存前校验

1. **组内 role 齐备性**（seed 铺组时就按这张表检查，缺哪条点名哪条）：

   | kind | 必填 | 条件必填 | 可选 |
   |---|---|---|---|
   | `llm` | `generate·sync` | — | — |
   | `image` | `generate`（sync 或 async 至少一条） | 实例选 async → `generate·async` + `query` | — |
   | `tts` | `synthesize`（sync 或 async 至少一条） | 实例选 async → `synthesize·async` + `query` | `clone`（没有则「克隆音色」区显示「该供应商不支持克隆」，不是摆一排死按钮） |

2. 实例 `mode=async` → `generate·async` 的 `taskId` 非空，且 `query` 的产物路径 + `status` + `success` 非空。
3. 实例 `mode=sync` → `generate·sync` 的产物路径非空，且**不允许**出现 `status` / 三枚举 / 轮询列。
4. `decode='url'` 的行必须有产物路径（`image` / `audio`）—— 否则第④步「下载产物」没有可下载的东西；`fetch_headers_json` 留空即裸 GET。
5. 缺必填 role → 实例行标红不可用。
6. `url` / `headers` / `body` 引用的占位符必须都在 `vars_json` 声明（或属保留占位符）—— v1 的 `validateTemplate` 已实现，沿用。`query` 行的 `{taskId}` 由引擎在②之后注入，属保留占位符。
7. 自检视图三条：`v_check_async_pairing`（异步实例有没有对应 query 模板）、`v_check_tpl_group`（组内 kind/label 一致）、`v_check_dangling`（`provider.tpl_group` 指向不存在的组）。三条都只体检不拦写入。
8. 模板行被实例引用时**允许改**（模板是共享数据，这是设计意图），但界面顶部要显式提示「N 个实例正在使用这组模板」，并给「另存为副本」。

## 七、调度层（`src/lib/provider-queue.ts`，内存，不是表）

**为什么需要它**：一次用户动作会发多条请求 —— 逐行配音（30 行字幕 = 30 次 `synthesize`，异步的话每次还要轮询十几秒）、批量出图、整片重配音。v1 是 `for` 循环里 `await`：没有并发上限、没有取消、失败只能整批重来。

**为什么不建任务表**（考虑过，结论是不）：

- 任务表存的是**在途状态**，而 `taskId` 只在一次调用内有意义（上游任务几十分钟就过期）；跨重启的「续等」要额外处理任务过期与结果 URL 失效，收益小、复杂度高。
- 更关键：**「哪几行还没配音」这件事项目数据本身就是那张清单**（`narration_entry` 有没有音频）。重开应用点「全部生成配音」天然只补没配音的行 —— 再存一份任务表就是第二份真相（AGENTS §6.24）。

**队列职责**：

| 项 | 规则 |
|---|---|
| 并发 | 按实例 `max_concurrency` 取任务，默认 1（串行）；同一实例的单行配音 / 试听与批量走**同一个队列**，否则两条路会同时打上游 |
| 重试 | 只重试 **429 / 5xx / 网络错**，指数退避 + 尊重 `Retry-After`；**业务错（模型名不存在、参数非法）不重试**，直接点名 —— 否则一个坏配置会被重试 60 次 |
| 取消 | `AbortController` 透传到主进程 `net:request` 的 fetch signal；取消后已完成条目保留 |
| 进度 | 逐条回调 → 字幕生成显示 `7/30 · 已用 2:10 · ✕ 取消` |
| 落库 | **产物一拿到就立刻落 `asset`**（逐条，不等整批）：30 行跑到第 20 行失败，前 19 行不能白跑；失败行下次被「只补没配音的」自然重跑 |

## 八、求值规则（沿用 v1，不动）

- `{var}` 独占一个标量时**保留原类型**：`"size": "{size}"` + size=1024 → number `1024`；写在字符串内部则是插值：`"Bearer {apiKey}"`、`"data:audio/wav;base64,{wavB64}"`。
- `{@name}`（带 `@`）**只能独占一个值位**，整段替换为解析后的 JSON 值（数组 / 对象 / 数字类型全保留）；`{name}` 才是字符串插值。分开写是为了消除「到底拼字符串还是塞对象」的歧义。
- `omitIfEmpty: true` 的变量没给值时**连父键一起删**（不少上游拒绝空数组、空 `parameters`、`null`，但「键不存在」合法）；`when` 门控同理级联。模板里**写死**的 `{}` / `[]` 原样保留。
- 未声明的占位符 → 保存模板时直接报错（「引用了未声明变量 x」），不留到运行时。
- base64 data URI 里的 `+` / `=` / `,` 不参与占位符解析（正则只认 `{[A-Za-z_][A-Za-z0-9_.]*}`）。
- **不做循环 / 条件表达式**（只有 `when: "a == b"` 等值门控与 `omitIfEmpty`）。一旦模板里能写表达式，配置就从「填表」变成「写程序」，出错时看模板也看不出实际发了什么，「试调用」的请求预览就失去意义。
- 密钥在预览里一律打码：`Bearer sk-****（长度 116）`，永不显原文。

## 九、UI：两页怎么变

| 页面 | v2 装什么 | 相对 v1 的变化 |
|---|---|---|
| **⚙ 实例设置**（`ProviderPanel`） | 模板组下拉（按 kind 过滤）→ Base URL / API Key（+ 第二密钥槽）→ **同步 / 异步** → 该组 `stage=instance` 参数表 → 并发数 / 重试次数 | `mode` 从每接口一行**上移成实例一格**；参数表读写 `provider.params_json`（不再 per-endpoint overrides）；新增并发 / 重试两格 |
| **接口模板页**（`EndpointTemplatesPage`） | 左侧模板组列表（含「N 个实例在用」）→ 右侧组内接口卡片（tts 一组最多三条：合成 / 查询 / 克隆）：url / method / headers / body / **入参声明表**（名字·stage·type·候选值·默认·说明）/ **返回槽位表单** / 解码 / 下载头 / 轮询节奏 + 预览请求 · 试调用 | 编辑对象从「这个实例的副本」变成**共享模板行**；出参从两个 JSON 框变成按 role+mode 渲染的**带标签输入框 + 枚举标签编辑器**；加「另存为副本」「恢复默认」 |

不变的两条硬约束：**同一份配置只有一处能改**（⚙ 是唯一入口，`VoicePicker` 只留选音色 + 试听）；**两页不混在同一屏**（整屏页 + 「← 返回实例设置」）。

**试调用**仍是这套设计的价值所在：每张接口卡片给「实际发出的请求」（密钥打码）+「响应摘要」（状态码、按槽位取到的值、音频给播放键、异步逐次显示轮询过程与状态原文）。没有这两栏，「模板对不对」只能靠 `HTTP 400 Model not exist.` 反推。

## 十、代码落点（v1 → v2 差量）

| 文件 | 变化 |
|---|---|
| `docs/db-schema-v2.sql` | `provider_template` 新表；`provider_endpoint` 整张作废；`provider` 加 `tpl_group` / `mode` / `params_json` / `max_concurrency` / `retry_times`，删 `recipe` |
| `src/lib/request-engine.ts` | `EndpointTemplate` 拆成 `TemplateRow`（形状）+ 实例入参；`vars[].kind` → `stage`；`pick` / `poll` → 固定 `resp` 槽位；`mode` 由实例传入而非行内 |
| `src/lib/recipes.ts` | 从「运行时模板」降级为 **seed 目录**（首次建库铺表 + 「恢复默认」的覆盖源） |
| `src/lib/provider-queue.ts`（新） | 队列：并发 / 退避重试 / 取消 / 进度回调 |
| `src/lib/providers.ts` | `callLLM` / `callTTS` / `callImage` / `cloneVoice` **签名不变**，内部改为「实例 → 解析组模板 → 走引擎 → 产物交回（或落 asset）」 |
| `src/stores/providerStore.ts` | 两份实体：模板组（可增删改、seed 补齐）+ 实例；`activeProvider()` 返回带解析后的组模板 |
| `electron/db-v2.mjs` / `main.mjs` | 新表映射与 IPC（`templates:list/upsert/remove`、`providers:*` 带 `params_json`）；`net:request` 不动 |
| `src/components/GenerateDialog.tsx` | 逐行 / 全部配音改走队列（进度 + 取消），产物即时落 asset |

## 十一、批次与验收（一批一个可验证 commit）

| 批次 | 内容 | 验证 |
|---|---|---|
| **A** | 两张表 DDL + seed 铺表 + 引擎改造（`stage` / `resp` 槽位 / mode 来自实例） | `tools/verify-request-engine.mjs` 扩：槽位按 role+mode 必填校验、`audios.0.url` 下标取法、异步 mock（success/fail/pending 三枚举判定） |
| **B** | 双端持久化 + 调用链切新表 + **调度层** | `tools/verify-provider-endpoint.mjs` 重写为模板组往返；新增 `tools/verify-provider-queue.mjs`（并发上限、429 退避重试、业务错不重试、取消后已完成项保留）—— 全离线 mock |
| **C** | 两页 UI（实例页参数表读 `params_json`；模板页按组编辑 + 槽位表单化 + 另存为副本）+ 字幕生成的进度 / 取消 | 桌面端实测：切 kind、模板组下拉、缺 role 红字、预览请求打码、试调用（需你点头才动 Key） |
| **D** | 文档链（`db-field-notes` → `gen-db-field-dict` → `comment-ddl` → 六条回归全绿）+ AGENTS §4/§7/§10 与 `db-tables.md` 同步 | 六条全绿 |
| **前置** | 音频 / 图片产物落 `asset`（原批次 6）：`decode:'url'` 当场下载、逐条落库 | `verify-project-roundtrip` 扩一条：项目里不残留远端产物 URL |

## 十二、待拍板（附建议值）

1. 同步 / 异步各占**一条 `generate` 模板行**（因为两种接法 URL/头常常不同，如通义异步要 `X-DashScope-Async: enable`）—— 建议：**是**。
2. 组信息（`kind` / `group_label`）冗余在模板行里，**不**开第三张组表 —— 建议：**是**（守住「两张表」，加自检视图）。
3. 轮询间隔 / 超时放**模板**（属形状），实例不给覆盖；并发数与重试次数放**实例**（属账号限额）—— 建议：**这么分**。
4. `list` 参数保留 `item.fields` 行编辑器（多轮 `history`、参考图列表要用），不只支持标量数组 —— 建议：**保留**。
5. 密钥固定两格（`apiKey` + 第二密钥，火山 appid/token、MiniMax group_id 用），不做「模板声明密钥变量」—— 建议：**固定两格**。
6. 旧数据：`provider_endpoint` 整张作废、seed 重铺；实例行 `base_url` / `secrets_json` / `model` 原样留着（**你的 Key 不用重填**），只把散在各接口行的 `overrides_json` 汇总进 `params_json`。这不算兼容层，是新表恰好接得住 —— 建议：**这么做**。
7. 「查询完成后下载」做成**引擎管线的第④步 + 一列 `fetch_headers_json`**，不建 `download` role（下载没有业务语义也没有出参槽位，做成接口行会让人以为要配两条查询接口）—— 建议：**这么做**。若你希望它在模板页里看得见、可单独试调用，就改成一个可选的 `download·sync` 行（`url` 默认 `{resultUrl}`），代价是多一行没填也能跑。

## 附：现有各家请求形状对照（seed 与 fixture 的依据）

| 供应商 | 端点 | 关键差异 |
|---|---|---|
| OpenAI 兼容 chat | `POST {base}/chat/completions` | `messages`；取 `choices.0.message.content` |
| OpenAI /audio/speech | `POST {base}/audio/speech` | 响应体**直接是音频字节**；`speed` |
| MiniMax t2a_v2 | `POST {base}?group_id=…` | key 里拆 `GroupId`；响应 `data.audio` 是 **hex** |
| 火山 TTS | `POST {base}` | headers `X-Api-App-Key` / `X-Api-Access-Key` / `X-Api-Resource-Id`；请求体三段 `user/audio/request` |
| DashScope CosyVoice | `{base}/services/audio/tts/SpeechSynthesizer` | `input.{text,voice}`；返回音频字节 |
| DashScope Qwen-TTS | `{base}/services/aigc/multimodal-generation/generation` | 返回 `output.audio.url`（**时效链接**） |
| 克隆（CosyVoice 系） | `{base}/services/audio/tts/customization` | `model:'voice-enrollment'`, `action:'create_voice'`, `prefix`, `url`(data URI) → `output.voice_id` |
| 克隆（Qwen-TTS） | 同上端点 | `model:'qwen-voice-enrollment'`, `action:'create'`, `preferred_name`, `audio.data`(data URI) → **`output.voice`**；合成须用同款 `target_model`（如 `qwen3-tts-vc-2026-01-22`）；参考音频 ≥24kHz 单声道 |
| DashScope 图片·同步 | `{base}/services/aigc/multimodal-generation/generation` | 取 `output.choices.0.message.content.0.image` |
| DashScope 图片·异步 | 同族「提交 + `tasks/{task_id}` 轮询」 | 提交要 `X-DashScope-Async: enable`；`output.task_id` → 查询取 `output.results.0.url` + `output.task_status`（`PENDING`/`RUNNING` · `SUCCEEDED` · `FAILED`,`CANCELED`,`UNKNOWN`） |

> 表中「克隆（Qwen-TTS）」与「异步图片」两行来自官方文档（voice-cloning-user-guide / qwen3-tts-vc），**本机未实跑**；实现时以「试调用」按真实响应确认，再定稿 seed。至今所有上游真实调用（试调用 / 克隆 / 配音）都还没发过一次，需用户点头才动 Key。
