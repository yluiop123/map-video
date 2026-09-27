# 供应商配置设计：接口模板 · 实例 · 音色 · 任务 · 取回管线

> 一句话：**模板 = 一份完整接法（一行存下同步 / 异步 / 上传 / 克隆的全部形状，纯数据）；实例 = 选哪份模板 + 一组取值（密钥也只是取值）；音色与异步任务是两份账本；调用正文与产物 URL 不落库。**

## 一、四层职责

| 层 | 存哪 | 装什么 | 谁编辑 |
|---|---|---|---|
| **模板** | `provider_template`（**一行 = 一份完整模板**） | 这一家这个功能怎么发、返回从哪取、产物怎么变成字节 | 接口模板页（专家） |
| **实例** | `provider` | 引用哪份模板 + 同步还是异步 + 全部取值（地址 / 密钥 / 模型 / 尺寸…） | ⚙ 实例设置页（日常） |
| **音色** | `voice` | 参考音频 → 厂商 voiceId 的账本（幂等、绑模型、可重建） | 字幕生成里的音色区 |
| **任务** | `task` | 在途异步任务（跨重启续跑、逐条进度与产物） | 无界面写入，调度器读写 |

没有「模板组」这一层：一份模板就是一行，同步异步上传克隆都是它 JSON 列里的键，所以不存在跨行一致性要防，也不需要组表与唯一索引。

**一份模板可以配多条实例**（两套账号 = 两条实例），调用处显式选一条用 —— 没有 `active` 标记，也不存在「哪条生效」这种第二处真相。

## 二、`provider_template`（一行一份）

```sql
CREATE TABLE IF NOT EXISTS provider_template (
  tpl_id      TEXT PRIMARY KEY,          -- deepseek-chat / qwen-image / qwen-tts / custom-1 …
  name        TEXT NOT NULL DEFAULT '',  -- 模板名（用户自填的单个字符串，不做中英两份）
  category    TEXT NOT NULL,             -- llm / tts / image（不加 CHECK，取值由 TS 联合类型管）
  caps_json   TEXT NOT NULL CHECK (json_valid(caps_json)),  -- 能力开关：调用方式 / 建音色 / 参考音频怎么交
  instance_params_json TEXT,                -- 实例级参数声明
  sync_json    TEXT,     async_json    TEXT,            -- 同步 {submit} / 异步 {submit,query}
  upload_json  TEXT,    clone_json TEXT,                      -- 上传 / 核心请求
  ord INTEGER NOT NULL DEFAULT 0,  created_at INTEGER,  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_tpl_category ON provider_template(category, ord, name);
```

所有 JSON 列都带 `CHECK (… IS NULL OR json_valid(…))`；`category` 不写 CHECK —— 接一家新供应商不改表、不加 switch。

**能力开关只有一列**：`caps_json = { modes: sync|async|both, artifact: none|binary|base64|hex|url, clone, cloneVia: upload|base64|form|url }`。
开关是输入，该有哪些接口槽、每槽必须交出哪些字段、那一格发 Body 还是表单，都是它的推导结果（`slotsOf` / `requiredOutputsOf` / `multipartSlotOf`），界面上没有第二处「配了却没人读」的开关。

内置模板由 seed（`src/lib/template-seed.ts`）在首次建库时铺成行，之后就是普通可编辑数据；「恢复默认」= 用 seed 覆盖那一行。

## 三、接口槽：五个形状，由能力开关推导该有哪几格

`caps_json` 里那几个开关一答完，`slotsOf(tpl)` 就给出这一份模板**该有哪些接口槽** —— 界面上没有「＋ 加一条接口」这回事，
也不给「删掉这条接口」（不想要就关对应的开关）。**关开关时当场问一次**：不再被调用的那几格连内容一起移除（取消 = 开关不动）—— 不留一格「界面上进不去、校验却每次点名」的死结。`validateTemplate` 仍留着那条兜底（数据可能被别处改过），措辞指向这个操作。

页签按**调用顺序**排：上传 → 克隆 → 同步·提交 → 异步·提交 → 异步·查询；**同步与异步都勾了**时这一排右边多一个下拉，只挑一侧看（只勾一种时不出现）。小节名旁边一枚 **ⓘ**，说明收在弹层里 —— 页面上不铺解释性长句。五个槽位：

| ReqKey | 存哪列 | 干什么 | 什么时候有 |
|---|---|---|---|
| `sync.submit` | `sync_json.submit` | 一把梭：发出去就拿到产物或结果字段 | `modes` 含 sync（llm 恒有） |
| `async.submit` | `async_json.submit` | 只负责提交并交出任务号 | `modes` 含 async |
| `async.query` | `async_json.query` | 怎么查、什么算成/败、产物在哪 | 同上 —— **与 submit 成对，缺一即报错** |
| `upload` | `upload_json` | 桥接：本地文件 → 文件引用（固定项 `artifact`：url 或文件号） | `clone` 且 `cloneVia=upload` |
| `clone` | `clone_json` | 核心：参考音频 → `voiceId` | `clone`（仅 tts） |

**每一格自己说产物怎么到手**（`artifactForm` = `bin` 响应体即产物 / `base64` / `hex` / `url` 链接，或 `none` = 这一格没产物），
`url` 一律**当场下载**成字节 —— 没有「先问一次才拿到地址」那种中间档：它把一件事拆成两问，多一格要配、多一处会写错，
而这几家上游里没有一家真的需要。

**`upload` 那一格与别的接口不一样**：它发的是一张 multipart 表单 —— 要传的只有那一个文件（`${voiceData}`，引擎注入、不在参数表里声明），随文件一起发的字段写在表单里。卡片里还是那三节，只是「发出去的内容」那一节换成 Headers → 表单。表单是空的会被 `validateTemplate` 点名。

**`caps.clone`（建音色）开着时再问一句：参考音频以什么形式交过去 —— 四选一（`caps.cloneVia`）**。这一问同时决定该不该多出「上传」那一格、以及克隆那一格发什么：

| `cloneVia` | 接口格 | 克隆格发什么 | 那个文件怎么写进去 | 参照 |
|---|---|---|---|---|
| `upload` 单独上传 | 多一格 `upload` | JSON 体 | 先跑上传那一格（文件交给它），它交回的文件引用由引擎**注入成下一步的 `${voiceData}`**，所以克隆那格写的还是同一个名字 | MiniMax `/v1/voice_clone` 的 `file_id` |
| `url` 公网地址 | 只有 `clone` | JSON 体 | **不给文件**：界面上是一个地址输入框（不是上传按钮，内置样本那两格也不出现），填的东西落进克隆那格写的 `${voiceUrl}`；那份音频另存一份进 `asset`，音色失效时靠它重建 | 千问 SpeechSynthesizer 一族的 `input.url` |
| `base64` | 无 | JSON 体 | 体里写 `${voiceData}`，引擎换成 `data:<mime>;base64,…`；要裸 base64 写 `${voiceData.base64}` | 千问 voice cloning 的 `input.audio.data`（收 Data URL） |
| `form` | 无 | **multipart 表单，没有 Body** | `${voiceData}` 就是那个二进制分片（自带 mime 与文件名），`name` / `language` 这些参数写成同表的字段 | ElevenLabs IVC `/v1/voices/add` 的 `files` + `name` |

**`${voiceData}` 是引擎注入的那个文件，不是声明出来的参数**（与固定返回项 `artifact` 对偶：一个是「这一步交进来的文件」，一个是「那一步交回去的文件 / 地址」）。所以：三种接法在模板里写的是同一句 `${voiceData}`；参数表里没有它（声明了会被 `validateTemplate` 点名 —— 同一个名字两个来源）；`valueType` 也不再收 `file` 这一档，`accept` / `maxSize` 两格随之作废。界面只在「试调用」那儿给它一个文件选择框。

于是「发哪部分内容」只有一个判据：`multipartSlotOf(tpl, slot)`（上传那格恒为表单；克隆那格看 `cloneVia`，**这一项没填过按 `base64` 算** —— 兜底写在 `cloneViaOf` 一处）。界面摆 Body 还是表单、`validateTemplate` 查哪一格为空、新建草稿给什么形状、`buildRequest` 真发什么，全读它 —— **一格的两种形状不会同时发出去**，换了接法之后留在另一格里的旧内容就地失效（不报错，也不发半个请求）。

每个接口槽的结构（`RequestDef`）：

```jsonc
{ "path": "${baseUrl}/services/aigc/image-generation/generation",  // 查询串直接拼在串上
  "method": "POST",
  "headers": { "Content-Type": "application/json", "Authorization": "Bearer ${apiKey}", "X-DashScope-Async": "enable" },
  "requestParams": [ /* 这一格的参数声明：model / size / prompt / 文件… 一张表，不再分两张 */ ],
  "body": { "model": "${model}", "input": { "text": "${text}" } },
  "form": { "file": "${voiceData}", "name": "${voiceName}" },   // 发 multipart 的那格用（判据：multipartSlotOf）
  "outputs": { "taskId": "output.task_id", "error": "message" },  // 固定项 + 自定义变量，见下
  "successValues": ["SUCCEEDED"], "failureValues": ["FAILED","CANCELED","UNKNOWN"] }  // 只有 query 用
```

- **超时只有实例级那一份**（模板把 `timeoutMs` 声明成一条实例参数），槽上没有这一格。

- **请求头逐条接口各配一份**，值里同样能写 `${apiKey}` 这类占位符。**没有模板级那一份**：同一家不同端点要的头本来就不一样
  （查询是 GET，没什么 Content-Type 可声明；异步开关头 `X-DashScope-Async` 只有异步提交那条该带），
  共用一份等于替别的端点也塞上它。

- **`outputs` 分两种，界面上也分两处**：
  - **固定项**（`requiredOutputsOf(tpl, slot)`）—— 名字由引擎写死，只能填路径：`content`（文案）、`artifact`（产物，
    或上传回来的文件地址 / 文件号）、`taskId`（任务号）、`status`（任务状态）、`voiceId`、`error` / `errorCode`。
    产物与上传引用**共用一个名字** `artifact`（`ARTIFACT_KEY`）：两者说的是同一件事 —— 这一步拿到的那个文件 / 地址，
    下一步 `${artifact}` 也只有一种写法。早先代码里那串 `values.audio ?? values.image ?? values.url ?? values.resultUrl ?? values.fileUrl`
    是同一条事实的五份真相，填对了五个之一才碰巧能用 —— 现在没有「碰巧」这回事，`validateTemplate` 会要求必填的固定项必须填路径。
    **`error` / `errorCode` 取到值不等于报错**：`0` / `ok` / `success` 这三种写法按「没有错误」算（MiniMax 一类的成功响应就是
    `base_resp:{status_code:0,status_msg:'success'}`，HTTP 照样回 200 —— 按「取到值就算错」会把每一次成功读成失败）。
    **`voiceId` 可以不填路径**：判据是这一格自己有没有写 `${voiceId}` —— 上游不回音色 id 的那种（MiniMax 的 `voice_clone`
    成功响应里只有 `base_resp`，名字就是请求里传的 `voice_id`），路径留空、引擎拿本轮发出去的那个名字当结果；
    既不填路径又不写 `${voiceId}` 的仍然点名（那样克隆完真的拿不到 id）。
  - **自定义变量**（可选、界面默认折叠）—— 只用于在别的请求里写 `${它}`，引擎从不读它们。
    与三层参数同名会被点名（同一个 `${x}` 有两个来源，谁赢取决于调用时给没给值）。
- **候选值（`options`）可以带形状**：`{ value, label, group, note, models }`。`group` 是分组名（自由字面量，界面按它分组、组名就是它）；`note` 是备注；`models` 声明「这条候选值只在同格 `model` 取这些值时可选」，由 `visibleOptions` 按当前取值过滤 —— **只影响界面上让你选哪些，不参与求值**。
  参数自己还可以勾 `voiceTable`：这一条候选值就是**音色表**，界面因此长成分组选择器 + 克隆音色那一段（`VoiceField`，⚙ 与字幕生成共用）。**代码里没有音色表**：千问 38 条与 ElevenLabs 21 条是 seed 里那份模板的候选值，铺进库后可在模板页改；`lib/voices.ts` 只剩随包发布的克隆样本清单。
  另有一条自检：**有候选值的参数，默认值必须在候选值里**（界面选不到、真发却照它发的那个值是最难查的错）。
- **产物形式是逐格的一件事**（`RequestDef.artifactForm`：这一格没产物 / 响应体即字节 / base64 / hex / 链接当场下），
  与固定项「产物」并排配在界面「从响应里取」那一节。它以前住在 `caps` 里（整份模板一份），于是「同步回链接、异步回 base64」配不出来，还和固定项撞过一次名；改成逐格后一个词只管一件事。
  **上游那个「你要 hex 还是 url」的字段（MiniMax 叫 `output_format`）seed 里没有声明** —— 它必须与这一格的产物形式配套，
  摆一个能单独改的格子等于造一个静默错（改了字段没改档位，就把一串十六进制当音频用）。
- **两个枚举而不是三个**：`successValues` / `failureValues`，都没命中 = 中间态继续查。省掉 `pendingValues` 是因为它没法穷举（`PENDING`/`RUNNING`/`QUEUING`/…），漏一个就把在途任务判成失败。
- 路径写法用**方括号下标**（`output.choices[0].message.content[0].image`），与上游文档、jq 逐字一致；纯点号 `output.results.0.url` 同样收，库存原样。只支持 `[数字]`，不做 `$..` / `[*]` / 过滤表达式 —— 模板里一旦能写表达式，「看模板就知道实际发了什么」这个前提就没了。

## 四、`provider`（实例）：只有五个业务列

```sql
CREATE TABLE IF NOT EXISTS provider (
  provider_id TEXT PRIMARY KEY,
  tpl_id      TEXT NOT NULL REFERENCES provider_template(tpl_id),  -- 真外键：模板被引用时删不掉
  name        TEXT NOT NULL DEFAULT '',   -- 实例名（界面与任务列表用它认）
  sync        INTEGER NOT NULL DEFAULT 1 CHECK (sync IN (0,1)),
  values_json TEXT CHECK (values_json IS NULL OR json_valid(values_json)),
  created_at INTEGER, updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_provider_tpl ON provider(tpl_id);
```

**实例不内置任何字段**：`baseUrl`、密钥、模型、音色、超时、并发、查询节奏全是模板声明出来的参数，取值统一存在 `values_json`：

```jsonc
{ "instance": { "baseUrl": "https://api.deepseek.com", "apiKey": "sk-…", "timeoutMs": 60000,
                 "queryIntervalMs": 5000, "queryMaxAttempts": 360 },     // 整实例共用
  "requests": { "sync.submit": { "model": "deepseek-flash", "temperature": 0.7 } } }  // 按请求各存各的
```

- **密钥 = `valueType:'secret'` 的普通参数**，不占具名列、不建密钥表：界面上渲染成密码框、永不回显原文，试调用回显与日志里按声明打码（`Bearer sk-****（长度 35）`）。哪些名字算密钥只有一处答案 —— 模板本身。
- `sync` 在这一处：决定这次走 `sync.submit` 还是 `async.submit` + `async.query`。该模板没有 async 时界面上这一格直接不出现（**显式不可用，不做隐式降级**）。
- 同一份模板挂两条实例 = 两套账号；界面在 ⚙ 里以芯片列出，调用处选一条。

## 五、参数声明与取值优先级

**声明只有两处**：整份模板共用的实例级参数，和每一格自己的一张参数表（`requestParams`）。
同一格里的参数，填了值的走实例、没填的由调用点现场给 —— 谁在什么时候给由取值优先级决定，不再靠「声明在哪张表」表达。

| 声明在哪 | 取值 | 界面上在哪填 |
|---|---|---|
| `instance_params_json`（整份模板共用） | `values.instance[key]`（落库） | ⚙ 实例设置页**右栏**（固定显示，不随接口页签切走） |
| 该接口槽的 `requestParams`（一格一张表） | 填了 → `values.requests[<ReqKey>][key]`（落库）；没填 → 每次调用现场给，不落库 | ⚙ 实例设置页**激活那一格的页签里**；没填的出现在同一格的试调用与业务界面 |

求值时一个 `${name}` 的取值顺序：**声明的默认值 → `values.instance` → `values.requests[<本槽>]` → 上游 `outputs` 产出的同名变量 → 调用参数**。

- 两处声明**都不是表**，就是那几个 JSON 字段里的键。
- 「这一格要现场给哪些参数」不靠第二张表标，由 `openKeysOf` 反推：这一格引用了、而上面几层都没给来源的名字。
  **「试调用」那一栏再收一道：`trialKeysOf` = `openKeysOf` 去掉这一格声明出来的参数** —— 声明了的在上面「这一格 · 参数」那张表里填，同一个名字不在下一栏再摆一个框（原先两处都有，试调用那个还悄悄预填一句示例文案，看着像两个入口管同一件事）。剩下的才是它该收的：`${voiceData}` 那个文件、上游产出的中间变量（如 `${taskId}`）、自建模板里引用了却没声明的名字。
- 谁都没给的占位符 = 直接**点名报错**（`这些占位符没有任何来源给值：${size}`），不发半个请求。
- 声明了但这次没填值 → **删键**（父对象被删空则连父键一起删）。这是「可选参数」的正确形态：不少上游拒绝 `"thinking":{}` 但接受不含该键。
- `${x}` 用在整串位置保留原类型（`${n}` 是数字就发数字）；嵌在字符串里就是插值。
- **注入的那个文件的值是「文件值」`{ bytes, mime, name }`，不是裸字节** —— 上传与克隆两类接口都要把 mime 注进去，写死过一次就会和实际字节不一致。同一个 `${voiceData}` 在两个位置长成两种样子：
  进 **JSON 体** = `data:<mime>;base64,…`（`cloneVia=base64` 那类要的形状），进 **multipart 表单** = 那个二进制分片（分片自带 `mime` 与文件名，由主进程拼 FormData）；`cloneVia=upload` 时克隆那格拿到的是上一步交回的**引用字符串**（不再是文件值）。
  要单独拿某一项就写点号：`${voiceData.mime}`（如 `audio/x-wav`）、`${voiceData.base64}`、`${voiceData.name}`、`${voiceData.dataUri}`。
- 参数字段表（`ParamSpec`）：

| 字段 | 含义 |
|---|---|
| `key` | 占位符名（`${key}`） |
| `label` | 显示名，**单个字符串**（纯显示，不进请求体） |
| `valueType` | `string`｜`text`｜`number`｜`boolean`｜`enum`｜`secret`｜`list`｜`json`（模板页是下拉框；**没有 `file` 这一档** —— 那个文件是引擎注入的 `${voiceData}`，不在声明表里） |
| `defaultValue` | 模板给的默认值（实例没填就用它） |
| `options` | 候选值：裸值或 `{value,label}`；有候选 → `OptionBlocks`，**不写原生 `<select>`** |
| `min`/`max`/`step` | number 控件范围 |
| `itemType`/`item` | list 的行编辑器（`item` 可给元素子模板） |

- **声明里没有「必填」也没有「加工方式」这两格**：一份声明出来的参数只有两个来源 —— 要么在实例里填，要么在调用时给，
  「必不必填」问得没意义（没给值就是那个键删掉，级联到空父键，见 §四）；取值成形只看 `valueType`，不叠加第二层加工选项。
- **文件转 base64 只会在一个地方发生**：`cloneVia=base64` 的克隆格求值时（`${voiceData}` 落进 JSON 体 = `data:<mime>;base64,…`，写 `${voiceData.base64}` = 不含前缀的那串）。
  调用点（`providers.ts` 的 `cloneVoice`）只把参考音频转成单声道 WAV、认出一个 mime，交出一个**文件值**，自己不编码；
  `cloneVia=form` 那一格发的是二进制分片，`cloneVia=upload` 传的文件同样不编码。

- **内置 seed 只声明真正引用到的参数**，并且只到「该请求用得上」为止；`{text}` `{prompt}` 这类正文由调用点给值，要渲染成输入框就从占位符反推，不靠声明。
- 候选值由模板写死，**不运行时从上游拉**（各家没有统一的 list 接口，顺序与文案不可控）。
- **发音修正（`hotFix`）是「形状照上游存」的样例**：界面（`HotFixField`，项目级，存进 `narration.hot_fix_json`）保存的就是
  上游那份对象形状 `{pronunciation:[{词:读音}], replace:[{原:换}]}`，模板在 `input` 里写 `hot_fix: '${hotFix}'`、
  把这条参数声明成 `json` 即可原样发出（引擎不改形状，代码里也就没有厂商名分支）。
  没填修正时那个键整个消失，不会发半个空对象给上游（回归 `verify-request-engine` 3.5–3.7）。
  注意**不是每条端点都吃这个参数**：非实时 CosyVoice / Qwen-Audio-TTS（`/services/audio/tts/SpeechSynthesizer`）有 `hot_fix`（`cosyvoice-v2` 除外），
  而 seed 里那条 `qwen3-tts`（`/services/aigc/multimodal-generation/generation`）**没有**（两条都按 2026-09-24 官方 API 参考逐字核对，未实测）—— 自建 CosyVoice 模板时才用得上。

## 六、取回管线

| 步 | 做什么 | 由哪格决定 |
|---|---|---|
| ① 求值 | 三层取值 + 上游变量拼出真实请求；有占位符没来源 → 当场点名 | `path` / `headers` / `body` / `form` + 三层声明 |
| ② 发送 | 桌面走主进程 `net:request`（无 CORS、Key 不出本机），网页走 `fetch` | 实例参数 `timeoutMs` |
| ③ 取字段 | 按 `outputs` 从响应里取名字，取到的进作用域 | `outputs` |
| ④ 判状态 | `classify(status, successValues, failureValues)`；中间态就再来一轮 | `async.query` 两个枚举 |
| ⑤ 变字节 | `binary` 响应体即产物；`hex`/`base64` 从固定项 `artifact` 解；`url` **当场下载**（时效链接绝不留到以后） | 这一格的 `artifactForm` + 「产物」那格的路径 |

```
同步：sync.submit → 字节
异步：async.submit 交出 taskId → 调度器/内存轮询按节奏打 async.query → SUCCEEDED → 字节
克隆：cloneVia=upload → upload 交出 artifact（文件引用），引擎把它注入成下一步的 ${voiceData}，再 clone 交出 voiceId
     cloneVia=base64 / form → 只有 clone 这一步，${voiceData} 就是那份文件
     cloneVia=url → 也没有上传那一格，且连 ${voiceData} 都不出现：界面收一个公网地址，交进 ${voiceUrl}
```

两条硬规矩：

- **⑤ 是当场下载并立刻落 `asset`**：异步查询给的链接带时效，跨会话必失效。项目数据里**绝不存远端产物 URL**，只存 `assetId`。
- **产物取不到时必须点名这一步实际取到了什么**（错误消息里列出 `outputs` 取到的键与值前缀）—— 这类毛病九成是路径写错，不列出来只能瞎猜。

异步的配对靠**同一行模板内的两个键**（`async.submit` ↔ `async.query`），不是指针列，所以没有「查询接口指向自己」这种脏行的可能。

## 七、`voice`（克隆音色账本）与 `task`（在途任务）

```sql
CREATE TABLE IF NOT EXISTS voice (
  voice_row_id TEXT PRIMARY KEY,
  provider_id  TEXT NOT NULL REFERENCES provider(provider_id) ON DELETE CASCADE,  -- 音色池按实例隔离
  source_hash  TEXT NOT NULL,          -- 参考音频内容哈希
  target_model TEXT NOT NULL,          -- voiceId 绑模型，换模型即另一条音色
  source_asset_id TEXT NOT NULL REFERENCES asset(asset_id) ON DELETE RESTRICT,  -- 失效靠原件重建；删素材会被拦
  label TEXT NOT NULL DEFAULT '',  file_id TEXT,  file_id_expires_at INTEGER,
  voice_id TEXT,  voice_id_expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'cloning',   -- cloning / ready / failed / expired
  error TEXT,  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER, updated_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_voice_once ON voice(provider_id, source_hash, target_model);
```

- **「只克隆一次」由这条唯一键保证**：同一实例 + 同一份音频 + 同一目标模型只有一行，`status` 就是抢占标志（并发点两次不会在建音色上打两次）。
- 参考音频原件走 `asset`（`RESTRICT`：删素材会被拦），音色失效时靠原件重建 —— 界面上不记「手填音色 ID」。

`task` 的唯一价值是**跨重启续跑**（关窗口、刷新页面都不丢在途任务）：`batch_id`（一次「全部生成配音」= 一个批次 + N 条）、`status`（`submitting`/`querying`/`success`/`failed`/`canceled`）、`input_json`（提交参数快照，重试 = 取原值重发）、`provider_task_id`、`artifact_id`（产物落 `asset` 后回填）、`query_count`/`rebuild_count`/`next_query_at`（调度器按它错峰，不做每任务独立循环）。`project_id` 与 `entry_id` 都是**弱引用**：保存项目是「删掉项目那一行 + 连子表整批重写」，挂成 `ON DELETE CASCADE` 真外键就等于让用户每次自动保存都 CASCADE 掉自己正在跑的任务（实测踩过）。所以删项目由 `removeProjectV2` 显式清掉它的在途任务，字幕行没了就是「没地方放」，调度器当场跳过；`provider_id` 仍是真外键 `CASCADE`（删实例连带删它的任务）。

**llm 不进 `task`**：文案生成是同步一把梭，没有跨重启续跑的语义。

## 八、界面：两页 + 一处选实例

| 页面 | 装什么 |
|---|---|
| **⚙ 实例设置**（`ProviderPanel`，按 文案 / 语音 / 图片 三屏） | 实例芯片一排 + `＋实例`；当前实例：名称 → 模板下拉 → **请求方式**（`selectableModesOf`：**模板只有一种接法时整行不显示** —— 没得选还摆一排单选就是假控件；但实例存的那一档在模板里没有接口时仍然长出来，否则那条红报错在界面上消不掉）→ **一排接口页签**（只列这条实例真会走到的那几格：`usedSlotsOf`，模板两套都配了也只列自己那一侧；名字只写动作名 上传 / 克隆 / 提交 / 查询）→ 左栏是**激活那一格的参数**（按 `requestParams`）与**试调用**（回显每一步的响应原文 → 取到的字段 → 产物预览：音频给播放器、图片直接显示；失败时那一步的响应原文照带回来，挂在 `EngineError.step` 上），右栏是**实例参数**（固定显示、切页签不动它，`sticky`）。现场要给的按 `trialKeysOf`（= `openKeysOf` 去掉这一格声明出来的参数 —— 那些在上面的参数表里填，不重复一栏）长控件，`${voiceData}` 那一个是「上传文件」按钮 + 已选文件名与大小 —— 三种接法都在这儿发得出去；试调用挂在页签上，所以**换页签会重挂载它**（草稿按参数名存，两格同名参数不是一回事，见 §6.30）。控件一律按 `valueType`+`options` 渲染（`secret` → 密码框，枚举 → `OptionBlocks`） |
| **接口模板页**（`TemplatesPane`，⚙ 左侧独立入口，**只在开发构建里露出来**：`IS_DEV = import.meta.env.DEV`） | 左：模板列表（按 category 分组，**只显示 name，主键不外显**）；中：模板头（名字 + 恢复默认 + 删除）→ **能力开关那几行**（**调用方式 = 同步 / 异步 两个复选框**、建音色（**克隆开关 + 参考音频四选一：单独上传 / base64 / form / 公网地址**），按 category 只显示问得上的；文案生成全用不上就不显示，且界面不写「机制怎么运作」的解说句）→ 开关推导出的接口槽卡片（关掉开关会弹窗问「移除这几格吗」，确定即连内容一起删），页签按调用顺序排、**一个页签就是这一个接口的全部配置**、只写动作名（提交 / 查询）—— 两套都勾了时「同步 \| 异步」切换在这一排**最左边**，切换说清在看哪一侧，所以两份名字不重复；卡片标题行只有方法与地址（格名已在页签上，不重复）；卡片内按**发出去的顺序**排：**发出去的内容**（这一条自己的 headers → body；发 multipart 的那格换成表单，判据 `multipartSlotOf`）→ **参数**（这一格一张表：填了值的走实例，没填的调用时给）→ **从响应里取**（**「产物形式」与固定项「产物」是并排的两行、逐格一份**；其余固定项逐行 + 折叠的自定义变量；查询那一格的两个状态值也在这一节里）；右：实例级参数表。**两层参数表不用颜色区分**：小标题 + 一条延伸到右边界的细线，会留在库里的层每行装框、调用时给值的那种不装框并整组缩进一道竖线。小节名旁一枚 **ⓘ**（说明收在弹层里，页面不铺长句）。**这一页不发请求、也不预览请求** —— 看形状与真发都在实例页 |
| **字幕生成 / 出图处** | 选哪条实例 + 调用级参数（文本、描述、尺寸、文件），不碰模板 |

- **验收口只有一个：实例页的「试调用」**（它同时给求值后的请求形状与真发一条的结果 —— 真发要的是这条实例的 Key，所以这件事只能在实例页做）。模板页不预览、不发请求：那一页只有形状本身，拼得出拼不出由保存前自检点名。
- 缺配项**当场点名**（`validateTemplate`）：开关要求的槽没配、槽没填地址、**必填的固定项没填路径**、自定义变量与参数同名、
  开关不需要的槽还留着、有 `async.submit` 没 `async.query`、查询没 `successValues`、实例参数同名重复、占位符没人给值 —— 不留到运行时。
- 新界面用 shadcn 原子（`src/components/ui/`），旧面板沿用 `ui/primitives.tsx`；两边都不写原生 `<select>`。
- **AI 功能只有桌面端有**：网页端不配 Key、不显示字幕生成里的 AI 区（浏览器直连必然 CORS，且 Key 没地方安全存）。
## 九、内置模板的具体参数与逐列 JSON

<!-- BEGIN generated:seed-templates -->
_（本节由 `node --experimental-strip-types tools/gen-template-json-doc.mjs` 从 `src/lib/template-seed.ts` 生成，改 seed 后重跑；`--check` 只校验。）_

### 9.1 能力开关

`caps_json` 一列装着全部开关，**该有哪些接口槽、每槽必须交出哪些字段、那一格发 Body 还是表单，全由它推导**（`slotsOf` / `requiredOutputsOf` / `multipartSlotOf`）。
界面上「调用方式」是**同步 / 异步 两个复选框**（存的就是 `modes`：只勾一个 = `sync`/`async`，都勾 = `both`）；「建音色」是**克隆开关 + 参考音频三选一**（`cloneVia`：`upload` 先传、交回的引用注入成下一步的 `${voiceData}` / `base64` 文件进 JSON 体 / `form` 克隆那格自己发 multipart —— 三种接法在模板里写的都是 `${voiceData}`，它不在参数表里声明）。

| 模板 | 调用方式 | 建音色 | 参考音频怎么交 | 推导出的接口槽 |
|---|---|---|---|---|
| `deepseek-chat` | sync | 否 | — | `同步 · 提交` |
| `qwen-image` | both | 否 | — | `同步 · 提交` + `异步 · 提交` + `异步 · 查询` |
| `qwen-tts` | sync | 是 | `base64` | `克隆` + `同步 · 提交` |
| `qwen-audio-tts` | sync | 是 | `url` | `克隆` + `同步 · 提交` |
| `elevenlabs-voice` | sync | 是 | `form` | `克隆` + `同步 · 提交` |
| `minimax-voice` | sync | 是 | `upload` | `上传` + `克隆` + `同步 · 提交` |
| `minimax-image` | sync | 否 | — | `同步 · 提交` |

### 9.2 每格必须交出的返回项（名字写死，只能填路径）——「产物形式」也是逐格一行，与「产物」成对

这些名字就是引擎读取的键 —— 写错不会报错，只会「产物取不到」或「一路查到超时」，所以不给自定义。
自定义变量（只给下游 `${它}` 用、引擎不读）另在一格，不进这张表。

| 模板 | 接口槽 | 这一格的产物形式 | 固定项 | 名字（写死） | 必填 | 引擎拿它干什么 |
|---|---|---|---|---|---|---|
| `deepseek-chat` | 同步 · 提交 | `none` | 生成的文本 | `content` | 是 | 引擎只认这个名字 |
| `deepseek-chat` | 同步 · 提交 | `none` | 错误信息 | `error` | 建议 | 上游报的原文，界面直接显示它 |
| `deepseek-chat` | 同步 · 提交 | `none` | 错误码 | `errorCode` | 建议 | 和错误信息拼在一起，方便对文档查 |
| `qwen-image` | 同步 · 提交 | `url` | 产物 | `artifact` | 是 | 图片或音频的下载地址（带时效，当场下载） |
| `qwen-image` | 同步 · 提交 | `url` | 错误信息 | `error` | 建议 | 上游报的原文，界面直接显示它 |
| `qwen-image` | 同步 · 提交 | `url` | 错误码 | `errorCode` | 建议 | 和错误信息拼在一起，方便对文档查 |
| `qwen-image` | 异步 · 提交 | `none` | 任务号 | `taskId` | 是 | 交给调度器存着，之后拿它去查 |
| `qwen-image` | 异步 · 提交 | `none` | 错误信息 | `error` | 建议 | 上游报的原文，界面直接显示它 |
| `qwen-image` | 异步 · 提交 | `none` | 错误码 | `errorCode` | 建议 | 和错误信息拼在一起，方便对文档查 |
| `qwen-image` | 异步 · 查询 | `url` | 任务状态 | `status` | 是 | 没取到它就一直算「还在跑」，查到次数上限才失败 |
| `qwen-image` | 异步 · 查询 | `url` | 产物 | `artifact` | 是 | 图片或音频的下载地址（带时效，当场下载） |
| `qwen-image` | 异步 · 查询 | `url` | 错误信息 | `error` | 建议 | 上游报的原文，界面直接显示它 |
| `qwen-image` | 异步 · 查询 | `url` | 错误码 | `errorCode` | 建议 | 和错误信息拼在一起，方便对文档查 |
| `qwen-tts` | 克隆 | `none` | 音色 ID | `voiceId` | 是 | 存进音色账本，绑这条实例与目标模型 |
| `qwen-tts` | 克隆 | `none` | 错误信息 | `error` | 建议 | 上游报的原文，界面直接显示它 |
| `qwen-tts` | 克隆 | `none` | 错误码 | `errorCode` | 建议 | 和错误信息拼在一起，方便对文档查 |
| `qwen-tts` | 同步 · 提交 | `url` | 产物 | `artifact` | 是 | 图片或音频的下载地址（带时效，当场下载） |
| `qwen-tts` | 同步 · 提交 | `url` | 错误信息 | `error` | 建议 | 上游报的原文，界面直接显示它 |
| `qwen-tts` | 同步 · 提交 | `url` | 错误码 | `errorCode` | 建议 | 和错误信息拼在一起，方便对文档查 |
| `qwen-audio-tts` | 克隆 | `none` | 音色 ID | `voiceId` | 是 | 存进音色账本，绑这条实例与目标模型 |
| `qwen-audio-tts` | 克隆 | `none` | 错误信息 | `error` | 建议 | 上游报的原文，界面直接显示它 |
| `qwen-audio-tts` | 克隆 | `none` | 错误码 | `errorCode` | 建议 | 和错误信息拼在一起，方便对文档查 |
| `qwen-audio-tts` | 同步 · 提交 | `url` | 产物 | `artifact` | 是 | 图片或音频的下载地址（带时效，当场下载） |
| `qwen-audio-tts` | 同步 · 提交 | `url` | 错误信息 | `error` | 建议 | 上游报的原文，界面直接显示它 |
| `qwen-audio-tts` | 同步 · 提交 | `url` | 错误码 | `errorCode` | 建议 | 和错误信息拼在一起，方便对文档查 |
| `elevenlabs-voice` | 克隆 | `none` | 音色 ID | `voiceId` | 是 | 存进音色账本，绑这条实例与目标模型 |
| `elevenlabs-voice` | 克隆 | `none` | 错误信息 | `error` | 建议 | 上游报的原文，界面直接显示它 |
| `elevenlabs-voice` | 克隆 | `none` | 错误码 | `errorCode` | 建议 | 和错误信息拼在一起，方便对文档查 |
| `elevenlabs-voice` | 同步 · 提交 | `binary` | 错误信息 | `error` | 建议 | 上游报的原文，界面直接显示它 |
| `elevenlabs-voice` | 同步 · 提交 | `binary` | 错误码 | `errorCode` | 建议 | 和错误信息拼在一起，方便对文档查 |
| `minimax-voice` | 上传 | `none` | 文件地址 / 文件号 | `artifact` | 是 | 下一步建音色要用它：引擎把它注入成 ${voiceData}，克隆那一格写这个名就行 |
| `minimax-voice` | 上传 | `none` | 错误信息 | `error` | 建议 | 上游报的原文，界面直接显示它 |
| `minimax-voice` | 上传 | `none` | 错误码 | `errorCode` | 建议 | 和错误信息拼在一起，方便对文档查 |
| `minimax-voice` | 克隆 | `none` | 音色 ID | `voiceId` | 建议 | 这一格自己写了 ${voiceId} —— 名字是你起的、上游不回它，路径留空，引擎拿本轮发出去的那个名字当结果 |
| `minimax-voice` | 克隆 | `none` | 错误信息 | `error` | 建议 | 上游报的原文，界面直接显示它 |
| `minimax-voice` | 克隆 | `none` | 错误码 | `errorCode` | 建议 | 和错误信息拼在一起，方便对文档查 |
| `minimax-voice` | 同步 · 提交 | `hex` | 产物 | `artifact` | 是 | 图片或音频的字节所在字段 |
| `minimax-voice` | 同步 · 提交 | `hex` | 错误信息 | `error` | 建议 | 上游报的原文，界面直接显示它 |
| `minimax-voice` | 同步 · 提交 | `hex` | 错误码 | `errorCode` | 建议 | 和错误信息拼在一起，方便对文档查 |
| `minimax-image` | 同步 · 提交 | `url` | 产物 | `artifact` | 是 | 图片或音频的下载地址（带时效，当场下载） |
| `minimax-image` | 同步 · 提交 | `url` | 错误信息 | `error` | 建议 | 上游报的原文，界面直接显示它 |
| `minimax-image` | 同步 · 提交 | `url` | 错误码 | `errorCode` | 建议 | 和错误信息拼在一起，方便对文档查 |

### 9.3 7 份模板各自声明了哪些参数

「层」只有两处声明：实例级整条实例共用、每一格各一张表。同一格里填了值的走实例，没填的由调用点现场给（业务界面或试调用）—— 谁在什么时候给由取值优先级决定，不再靠「声明在哪张表」表达。

#### `deepseek-chat` · openai（llm）

| 层 | key | 显示名 | 类型 | 默认值 | 候选值 / 范围 |
|---|---|---|---|---|---|
| 实例级 | `baseUrl` | 服务地址 | string | `"https://api.deepseek.com"` | — |
| 实例级 | `apiKey` | API Key | secret | — | — |
| 实例级 | `timeoutMs` | 单次超时 ms | number | `60000` | — |
| 这一格 `sync.submit` | `model` | 模型 | enum | `"deepseek-flash"` | deepseek-flash · deepseek-v4-pro |
| 这一格 `sync.submit` | `reasoningEffort` | 思考强度 | enum | — | none · low · high · max |
| 这一格 `sync.submit` | `thinking` | 深度思考 | enum | — | enabled · disabled |
| 这一格 `sync.submit` | `temperature` | 温度 | number | `1` | ≥0 ≤2 步长 0.1 |
| 这一格 `sync.submit` | `maxTokens` | 最大输出 token | number | `200000` | — |
| 这一格 `sync.submit` | `systemPrompt` | 系统提示词 | text | — | — |
| 这一格 `sync.submit` | `userPrompt` | 用户提示词 | text | — | — |

#### `qwen-image` · 千问 文生图（image）

| 层 | key | 显示名 | 类型 | 默认值 | 候选值 / 范围 |
|---|---|---|---|---|---|
| 实例级 | `baseUrl` | 服务地址 | string | `"https://maas.qianwenaiapi.com/api/v1"` | — |
| 实例级 | `apiKey` | API Key | secret | — | — |
| 实例级 | `timeoutMs` | 单次超时 ms | number | `60000` | — |
| 实例级 | `queryIntervalMs` | 查询间隔 ms | number | `5000` | — |
| 实例级 | `queryMaxAttempts` | 查询次数上限 | number | `360` | — |
| 这一格 `sync.submit` | `model` | 模型 | enum | `"qwen-image-3.0-pro"` | qwen-image-3.0-pro |
| 这一格 `sync.submit` | `size` | 出图尺寸 | string | `"2048*2048"` | — |
| 这一格 `sync.submit` | `watermark` | 水印 | boolean | `false` | — |
| 这一格 `sync.submit` | `prompt` | 画面描述 | text | — | — |
| 这一格 `async.submit` | `model` | 模型 | enum | `"qwen-image-3.0-pro"` | qwen-image-3.0-pro |
| 这一格 `async.submit` | `size` | 出图尺寸 | string | `"2048*2048"` | — |
| 这一格 `async.submit` | `n` | 张数 | number | `1` | ≥1 ≤4 |
| 这一格 `async.submit` | `prompt` | 画面描述 | text | — | — |

#### `qwen-tts` · 千问 TTS（tts）

| 层 | key | 显示名 | 类型 | 默认值 | 候选值 / 范围 |
|---|---|---|---|---|---|
| 实例级 | `baseUrl` | 服务地址 | string | `"https://maas.qianwenaiapi.com/api/v1"` | — |
| 实例级 | `apiKey` | API Key | secret | — | — |
| 实例级 | `timeoutMs` | 单次超时 ms | number | `60000` | — |
| 这一格 `sync.submit` | `model` | 模型 | enum | `"qwen3-tts-flash"` | qwen3-tts-flash · qwen3-tts-vc-2026-01-22 |
| 这一格 `sync.submit` | `languageType` | 语种 | enum | `"Chinese"` | Chinese · English · Auto |
| 这一格 `sync.submit` | `text` | 合成文本 | text | — | — |
| 这一格 `sync.submit` | `voice` | 音色 ID | enum | `"Ethan"` | 38 条（女声 19 / 男声 19） —— 逐条见下面那列 JSON |
| 这一格 `clone` | `model` | 复刻目标模型（须与合成同款） | enum | `"qwen3-tts-vc-2026-01-22"` | qwen3-tts-vc-2026-01-22 |
| 这一格 `clone` | `preferredName` | 音色名 | string | `"mapvideo"` | — |

#### `qwen-audio-tts` · 千问语音（音量 / 发音修正）（tts）

| 层 | key | 显示名 | 类型 | 默认值 | 候选值 / 范围 |
|---|---|---|---|---|---|
| 实例级 | `baseUrl` | 服务地址 | string | `"https://maas.qianwenaiapi.com/api/v1"` | — |
| 实例级 | `apiKey` | API Key | secret | — | — |
| 实例级 | `timeoutMs` | 单次超时 ms | number | `60000` | — |
| 这一格 `sync.submit` | `model` | 模型 | enum | `"qwen-audio-3.0-tts-flash"` | qwen-audio-3.0-tts-flash · qwen-audio-3.0-tts-plus |
| 这一格 `sync.submit` | `text` | 合成文本 | text | — | — |
| 这一格 `sync.submit` | `voice` | 音色 ID | enum | `"longanfengyue"` | 14 条（女声 9 / 男声 5） —— 逐条见下面那列 JSON |
| 这一格 `sync.submit` | `volume` | 音量（0–100） | number | `100` | ≥0 ≤100 |
| 这一格 `sync.submit` | `hotFix` | 发音修正 | json | — | — |
| 这一格 `clone` | `model` | 复刻目标模型（须与合成同款） | enum | `"qwen-audio-3.0-tts-flash"` | qwen-audio-3.0-tts-flash · qwen-audio-3.0-tts-plus |
| 这一格 `clone` | `prefix` | 音色前缀（只收字母数字，≤10） | string | `"mapvideo"` | — |
| 这一格 `clone` | `voiceUrl` | 参考音频地址（公网可取的 https 直链） | string | — | — |

#### `elevenlabs-voice` · ElevenLabs 语音（tts）

| 层 | key | 显示名 | 类型 | 默认值 | 候选值 / 范围 |
|---|---|---|---|---|---|
| 实例级 | `baseUrl` | 服务地址 | string | `"https://api.elevenlabs.io/v1"` | — |
| 实例级 | `apiKey` | API Key | secret | — | — |
| 实例级 | `timeoutMs` | 单次超时 ms | number | `60000` | — |
| 这一格 `sync.submit` | `model` | 模型 | enum | `"eleven_multilingual_v2"` | eleven_multilingual_v2 · eleven_flash_v2_5 |
| 这一格 `sync.submit` | `text` | 合成文本 | text | — | — |
| 这一格 `sync.submit` | `voice` | 音色 ID | enum | `"CwhRBWXzGAHq8TQ4Fs17"` | 21 条（男声 13 / 女声 7 / 中性 1） —— 逐条见下面那列 JSON |
| 这一格 `clone` | `preferredName` | 音色名 | string | `"mapvideo"` | — |

#### `minimax-voice` · MiniMax 语音（tts）

| 层 | key | 显示名 | 类型 | 默认值 | 候选值 / 范围 |
|---|---|---|---|---|---|
| 实例级 | `baseUrl` | 服务地址 | string | `"https://api.minimax.io/v1"` | — |
| 实例级 | `apiKey` | API Key | secret | — | — |
| 实例级 | `timeoutMs` | 单次超时 ms | number | `60000` | — |
| 这一格 `sync.submit` | `model` | 模型 | enum | `"speech-2.8-hd"` | speech-2.8-hd · speech-2.8-turbo · speech-2.6-hd · speech-2.6-turbo · speech-02-hd · speech-02-turbo |
| 这一格 `sync.submit` | `text` | 合成文本 | text | — | — |
| 这一格 `sync.submit` | `voice` | 音色 ID | string | `"male-qn-qingse"` | — |
| 这一格 `clone` | `voiceId` | 音色名（自己起 · 上游不回它） | string | `"mapvideo"` | — |

#### `minimax-image` · MiniMax 文生图（image）

| 层 | key | 显示名 | 类型 | 默认值 | 候选值 / 范围 |
|---|---|---|---|---|---|
| 实例级 | `baseUrl` | 服务地址 | string | `"https://api.minimax.io/v1"` | — |
| 实例级 | `apiKey` | API Key | secret | — | — |
| 实例级 | `timeoutMs` | 单次超时 ms | number | `60000` | — |
| 这一格 `sync.submit` | `model` | 模型 | enum | `"image-01"` | image-01 |
| 这一格 `sync.submit` | `aspectRatio` | 画幅 | enum | `"1:1"` | 1:1 · 16:9 · 9:16 · 4:3 · 3:4 · 3:2 · 2:3 · 21:9 |
| 这一格 `sync.submit` | `promptOptimizer` | 提示词润色 | boolean | `false` | — |
| 这一格 `sync.submit` | `prompt` | 画面描述 | text | — | — |

### 9.4 逐列 JSON（照抄可用）

下面每块就是 `provider_template` 那一行对应列里存的内容，键名与列名一一对应；`null` = 该列没配（界面上那一格也就不出现）。

#### `deepseek-chat`

- 标量列：`category=llm`，`caps_json={"modes":"sync"}`

- 请求头**没有独立列**：每条接口自己的 `headers` 就写在下面那几列的 JSON 里（同一家不同端点要的头并不相同）。

**`instance_params_json`**（实例级参数**声明**）

```json
[
  {
    "key": "baseUrl",
    "label": "服务地址",
    "valueType": "string",
    "defaultValue": "https://api.deepseek.com"
  },
  {
    "key": "apiKey",
    "label": "API Key",
    "valueType": "secret"
  },
  {
    "key": "timeoutMs",
    "label": "单次超时 ms",
    "valueType": "number",
    "defaultValue": 60000
  }
]
```

**`sync_json`**（sync.submit）

```json
{
  "submit": {
    "path": "${baseUrl}/chat/completions",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "Authorization": "Bearer ${apiKey}"
    },
    "requestParams": [
      {
        "key": "model",
        "label": "模型",
        "valueType": "enum",
        "options": [
          "deepseek-flash",
          "deepseek-v4-pro"
        ],
        "defaultValue": "deepseek-flash"
      },
      {
        "key": "reasoningEffort",
        "label": "思考强度",
        "valueType": "enum",
        "options": [
          "none",
          "low",
          "high",
          "max"
        ]
      },
      {
        "key": "thinking",
        "label": "深度思考",
        "valueType": "enum",
        "options": [
          "enabled",
          "disabled"
        ]
      },
      {
        "key": "temperature",
        "label": "温度",
        "valueType": "number",
        "defaultValue": 1,
        "min": 0,
        "max": 2,
        "step": 0.1
      },
      {
        "key": "maxTokens",
        "label": "最大输出 token",
        "valueType": "number",
        "defaultValue": 200000
      },
      {
        "key": "systemPrompt",
        "label": "系统提示词",
        "valueType": "text"
      },
      {
        "key": "userPrompt",
        "label": "用户提示词",
        "valueType": "text"
      }
    ],
    "body": {
      "model": "${model}",
      "messages": [
        {
          "role": "system",
          "content": "${systemPrompt}"
        },
        {
          "role": "user",
          "content": "${userPrompt}"
        }
      ],
      "stream": false,
      "reasoning_effort": "${reasoningEffort}",
      "thinking": {
        "type": "${thinking}"
      },
      "temperature": "${temperature}",
      "max_tokens": "${maxTokens}"
    },
    "outputs": {
      "content": "choices[0].message.content",
      "errorCode": "error.code",
      "error": "error.message"
    }
  }
}
```

**`async_json`**（async.submit）

```json
null
```

**`upload_json`**（upload）

```json
null
```

**`clone_json`**（clone）

```json
null
```

#### `qwen-image`

- 标量列：`category=image`，`caps_json={"modes":"both"}`

- 请求头**没有独立列**：每条接口自己的 `headers` 就写在下面那几列的 JSON 里（同一家不同端点要的头并不相同）。

**`instance_params_json`**（实例级参数**声明**）

```json
[
  {
    "key": "baseUrl",
    "label": "服务地址",
    "valueType": "string",
    "defaultValue": "https://maas.qianwenaiapi.com/api/v1"
  },
  {
    "key": "apiKey",
    "label": "API Key",
    "valueType": "secret"
  },
  {
    "key": "timeoutMs",
    "label": "单次超时 ms",
    "valueType": "number",
    "defaultValue": 60000
  },
  {
    "key": "queryIntervalMs",
    "label": "查询间隔 ms",
    "valueType": "number",
    "defaultValue": 5000
  },
  {
    "key": "queryMaxAttempts",
    "label": "查询次数上限",
    "valueType": "number",
    "defaultValue": 360
  }
]
```

**`sync_json`**（sync.submit）

```json
{
  "submit": {
    "path": "${baseUrl}/services/aigc/multimodal-generation/generation",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "Authorization": "Bearer ${apiKey}"
    },
    "requestParams": [
      {
        "key": "model",
        "label": "模型",
        "valueType": "enum",
        "options": [
          "qwen-image-3.0-pro"
        ],
        "defaultValue": "qwen-image-3.0-pro"
      },
      {
        "key": "size",
        "label": "出图尺寸",
        "valueType": "string",
        "defaultValue": "2048*2048"
      },
      {
        "key": "watermark",
        "label": "水印",
        "valueType": "boolean",
        "defaultValue": false
      },
      {
        "key": "prompt",
        "label": "画面描述",
        "valueType": "text"
      }
    ],
    "body": {
      "model": "${model}",
      "input": {
        "messages": [
          {
            "role": "user",
            "content": [
              {
                "text": "${prompt}"
              }
            ]
          }
        ]
      },
      "parameters": {
        "size": "${size}",
        "watermark": "${watermark}"
      }
    },
    "artifactForm": "url",
    "outputs": {
      "artifact": "output.choices[0].message.content[0].image",
      "errorCode": "code",
      "error": "message"
    }
  }
}
```

**`async_json`**（async.submit）

```json
{
  "submit": {
    "path": "${baseUrl}/services/aigc/image-generation/generation",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "Authorization": "Bearer ${apiKey}",
      "X-DashScope-Async": "enable"
    },
    "requestParams": [
      {
        "key": "model",
        "label": "模型",
        "valueType": "enum",
        "options": [
          "qwen-image-3.0-pro"
        ],
        "defaultValue": "qwen-image-3.0-pro"
      },
      {
        "key": "size",
        "label": "出图尺寸",
        "valueType": "string",
        "defaultValue": "2048*2048"
      },
      {
        "key": "n",
        "label": "张数",
        "valueType": "number",
        "defaultValue": 1,
        "min": 1,
        "max": 4
      },
      {
        "key": "prompt",
        "label": "画面描述",
        "valueType": "text"
      }
    ],
    "body": {
      "model": "${model}",
      "input": {
        "messages": [
          {
            "role": "user",
            "content": [
              {
                "text": "${prompt}"
              }
            ]
          }
        ]
      },
      "parameters": {
        "size": "${size}",
        "n": "${n}"
      }
    },
    "outputs": {
      "taskId": "output.task_id",
      "errorCode": "code",
      "error": "message"
    }
  },
  "query": {
    "path": "${baseUrl}/tasks/${taskId}",
    "method": "GET",
    "headers": {
      "Authorization": "Bearer ${apiKey}"
    },
    "artifactForm": "url",
    "outputs": {
      "status": "output.task_status",
      "artifact": "output.choices[0].message.content[0].image",
      "errorCode": "code",
      "error": "message"
    },
    "successValues": [
      "SUCCEEDED"
    ],
    "failureValues": [
      "FAILED",
      "CANCELED",
      "UNKNOWN"
    ]
  }
}
```

**`upload_json`**（upload）

```json
null
```

**`clone_json`**（clone）

```json
null
```

#### `qwen-tts`

- 标量列：`category=tts`，`caps_json={"modes":"sync","clone":true,"cloneVia":"base64"}`

- 请求头**没有独立列**：每条接口自己的 `headers` 就写在下面那几列的 JSON 里（同一家不同端点要的头并不相同）。

**`instance_params_json`**（实例级参数**声明**）

```json
[
  {
    "key": "baseUrl",
    "label": "服务地址",
    "valueType": "string",
    "defaultValue": "https://maas.qianwenaiapi.com/api/v1"
  },
  {
    "key": "apiKey",
    "label": "API Key",
    "valueType": "secret"
  },
  {
    "key": "timeoutMs",
    "label": "单次超时 ms",
    "valueType": "number",
    "defaultValue": 60000
  }
]
```

**`sync_json`**（sync.submit）

```json
{
  "submit": {
    "path": "${baseUrl}/services/aigc/multimodal-generation/generation",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "Authorization": "Bearer ${apiKey}"
    },
    "requestParams": [
      {
        "key": "model",
        "label": "模型",
        "valueType": "enum",
        "options": [
          "qwen3-tts-flash",
          "qwen3-tts-vc-2026-01-22"
        ],
        "defaultValue": "qwen3-tts-flash"
      },
      {
        "key": "languageType",
        "label": "语种",
        "valueType": "enum",
        "options": [
          "Chinese",
          "English",
          "Auto"
        ],
        "defaultValue": "Chinese"
      },
      {
        "key": "text",
        "label": "合成文本",
        "valueType": "text"
      },
      {
        "key": "voice",
        "label": "音色 ID",
        "valueType": "enum",
        "voiceTable": true,
        "options": [
          {
            "value": "Cherry",
            "label": "芊悦",
            "group": "女声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Serena",
            "label": "苏瑶",
            "group": "女声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Chelsie",
            "label": "千雪",
            "group": "女声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Ethan",
            "label": "晨煦",
            "group": "男声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Moon",
            "label": "月白",
            "group": "男声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Kai",
            "label": "凯",
            "group": "男声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Nofish",
            "label": "不吃鱼",
            "group": "男声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Ryan",
            "label": "甜茶",
            "group": "男声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Aiden",
            "label": "艾登",
            "group": "男声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Eldric Sage",
            "label": "沧明子",
            "group": "男声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Mochi",
            "label": "沙小弥",
            "group": "男声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Vincent",
            "label": "田叔",
            "group": "男声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Neil",
            "label": "阿闻",
            "group": "男声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Arthur",
            "label": "徐大爷",
            "group": "男声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Pip",
            "label": "顽屁小孩",
            "group": "男声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Bodega",
            "label": "博德加",
            "group": "男声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Alek",
            "label": "阿列克",
            "group": "男声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Dolce",
            "label": "多尔切",
            "group": "男声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Lenn",
            "label": "莱恩",
            "group": "男声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Emilien",
            "label": "埃米尔安",
            "group": "男声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Andre",
            "label": "安德雷",
            "group": "男声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Radio Gol",
            "label": "拉迪奥·戈尔",
            "group": "男声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Momo",
            "label": "茉兔",
            "group": "女声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Vivian",
            "label": "十三",
            "group": "女声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Maia",
            "label": "四月",
            "group": "女声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Bella",
            "label": "萌宝",
            "group": "女声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Jennifer",
            "label": "詹妮弗",
            "group": "女声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Katerina",
            "label": "卡捷琳娜",
            "group": "女声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Mia",
            "label": "乖小妹",
            "group": "女声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Bellona",
            "label": "燕铮莺",
            "group": "女声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Bunny",
            "label": "萌小姬",
            "group": "女声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Elias",
            "label": "墨讲师",
            "group": "女声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Nini",
            "label": "邻家妹妹",
            "group": "女声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Seren",
            "label": "小婉",
            "group": "女声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Stella",
            "label": "少女阿月",
            "group": "女声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Sonrisa",
            "label": "索尼莎",
            "group": "女声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Sohee",
            "label": "素熙",
            "group": "女声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          },
          {
            "value": "Ono Anna",
            "label": "小野杏",
            "group": "女声",
            "note": "中英多语",
            "models": [
              "qwen3-tts-flash"
            ]
          }
        ],
        "defaultValue": "Ethan"
      }
    ],
    "body": {
      "model": "${model}",
      "input": {
        "text": "${text}",
        "voice": "${voice}",
        "language_type": "${languageType}"
      }
    },
    "artifactForm": "url",
    "outputs": {
      "artifact": "output.audio.url",
      "errorCode": "code",
      "error": "message"
    }
  }
}
```

**`async_json`**（async.submit）

```json
null
```

**`upload_json`**（upload）

```json
null
```

**`clone_json`**（clone）

```json
{
  "path": "${baseUrl}/services/audio/tts/customization",
  "method": "POST",
  "headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer ${apiKey}"
  },
  "requestParams": [
    {
      "key": "model",
      "label": "复刻目标模型（须与合成同款）",
      "valueType": "enum",
      "options": [
        "qwen3-tts-vc-2026-01-22"
      ],
      "defaultValue": "qwen3-tts-vc-2026-01-22"
    },
    {
      "key": "preferredName",
      "label": "音色名",
      "valueType": "string",
      "defaultValue": "mapvideo"
    }
  ],
  "body": {
    "model": "qwen-voice-enrollment",
    "input": {
      "action": "create",
      "target_model": "${model}",
      "preferred_name": "${preferredName}",
      "audio": {
        "data": "${voiceData}"
      }
    }
  },
  "outputs": {
    "voiceId": "output.voice",
    "errorCode": "code",
    "error": "message"
  }
}
```

#### `qwen-audio-tts`

- 标量列：`category=tts`，`caps_json={"modes":"sync","clone":true,"cloneVia":"url"}`

- 请求头**没有独立列**：每条接口自己的 `headers` 就写在下面那几列的 JSON 里（同一家不同端点要的头并不相同）。

**`instance_params_json`**（实例级参数**声明**）

```json
[
  {
    "key": "baseUrl",
    "label": "服务地址",
    "valueType": "string",
    "defaultValue": "https://maas.qianwenaiapi.com/api/v1"
  },
  {
    "key": "apiKey",
    "label": "API Key",
    "valueType": "secret"
  },
  {
    "key": "timeoutMs",
    "label": "单次超时 ms",
    "valueType": "number",
    "defaultValue": 60000
  }
]
```

**`sync_json`**（sync.submit）

```json
{
  "submit": {
    "path": "${baseUrl}/services/audio/tts/SpeechSynthesizer",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "Authorization": "Bearer ${apiKey}"
    },
    "requestParams": [
      {
        "key": "model",
        "label": "模型",
        "valueType": "enum",
        "options": [
          "qwen-audio-3.0-tts-flash",
          "qwen-audio-3.0-tts-plus"
        ],
        "defaultValue": "qwen-audio-3.0-tts-flash"
      },
      {
        "key": "text",
        "label": "合成文本",
        "valueType": "text"
      },
      {
        "key": "voice",
        "label": "音色 ID",
        "valueType": "enum",
        "voiceTable": true,
        "options": [
          {
            "value": "longanfengyue",
            "label": "龙安风悦",
            "group": "女声",
            "note": "自然亲切音",
            "models": [
              "qwen-audio-3.0-tts-flash"
            ]
          },
          {
            "value": "longanxiaoxin",
            "label": "龙安小昕",
            "group": "女声",
            "note": "亲切活泼音",
            "models": [
              "qwen-audio-3.0-tts-flash"
            ]
          },
          {
            "value": "longanlingxi",
            "label": "龙安灵希",
            "group": "女声",
            "note": "可爱甜美音",
            "models": [
              "qwen-audio-3.0-tts-flash"
            ]
          },
          {
            "value": "longanyuanfei",
            "label": "龙安元妃",
            "group": "女声",
            "note": "高傲妃子音",
            "models": [
              "qwen-audio-3.0-tts-flash"
            ]
          },
          {
            "value": "longanhuan_v3.6",
            "label": "龙安欢",
            "group": "女声",
            "note": "基础版（后缀与 3.1 不同）",
            "models": [
              "qwen-audio-3.0-tts-flash"
            ]
          },
          {
            "value": "longpaopao_v3.6",
            "label": "龙泡泡",
            "group": "女声",
            "note": "软糯可爱音",
            "models": [
              "qwen-audio-3.0-tts-flash"
            ]
          },
          {
            "value": "loongeva_v3.6",
            "label": "loongeva",
            "group": "女声",
            "note": "高智美音",
            "models": [
              "qwen-audio-3.0-tts-flash"
            ]
          },
          {
            "value": "loongmary",
            "label": "loongmary",
            "group": "女声",
            "note": "温暖英音",
            "models": [
              "qwen-audio-3.0-tts-flash"
            ]
          },
          {
            "value": "longjielidou_v3.6",
            "label": "龙杰力豆",
            "group": "男声",
            "note": "天真男童",
            "models": [
              "qwen-audio-3.0-tts-flash"
            ]
          },
          {
            "value": "longhuohuo_v3.6",
            "label": "龙火火",
            "group": "男声",
            "note": "顽皮少年音",
            "models": [
              "qwen-audio-3.0-tts-flash"
            ]
          },
          {
            "value": "longchuanshu_v3.6",
            "label": "龙川叔",
            "group": "男声",
            "note": "川普大叔音",
            "models": [
              "qwen-audio-3.0-tts-flash"
            ]
          },
          {
            "value": "loongjohn",
            "label": "loongJohn",
            "group": "男声",
            "note": "沉稳亲切美音",
            "models": [
              "qwen-audio-3.0-tts-flash"
            ]
          },
          {
            "value": "longanlingxin",
            "label": "龙安灵心",
            "group": "女声",
            "note": "知心温暖音",
            "models": [
              "qwen-audio-3.0-tts-plus"
            ]
          },
          {
            "value": "longanlufeng",
            "label": "龙安鲁风",
            "group": "男声",
            "note": "明亮开朗音",
            "models": [
              "qwen-audio-3.0-tts-plus"
            ]
          }
        ],
        "defaultValue": "longanfengyue"
      },
      {
        "key": "volume",
        "label": "音量（0–100）",
        "valueType": "number",
        "defaultValue": 100,
        "min": 0,
        "max": 100
      },
      {
        "key": "hotFix",
        "label": "发音修正",
        "valueType": "json"
      }
    ],
    "body": {
      "model": "${model}",
      "input": {
        "text": "${text}",
        "voice": "${voice}",
        "volume": "${volume}",
        "hot_fix": "${hotFix}"
      }
    },
    "artifactForm": "url",
    "outputs": {
      "artifact": "output.audio.url",
      "errorCode": "code",
      "error": "message"
    }
  }
}
```

**`async_json`**（async.submit）

```json
null
```

**`upload_json`**（upload）

```json
null
```

**`clone_json`**（clone）

```json
{
  "path": "${baseUrl}/services/audio/tts/customization",
  "method": "POST",
  "headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer ${apiKey}"
  },
  "requestParams": [
    {
      "key": "model",
      "label": "复刻目标模型（须与合成同款）",
      "valueType": "enum",
      "options": [
        "qwen-audio-3.0-tts-flash",
        "qwen-audio-3.0-tts-plus"
      ],
      "defaultValue": "qwen-audio-3.0-tts-flash"
    },
    {
      "key": "prefix",
      "label": "音色前缀（只收字母数字，≤10）",
      "valueType": "string",
      "defaultValue": "mapvideo"
    },
    {
      "key": "voiceUrl",
      "label": "参考音频地址（公网可取的 https 直链）",
      "valueType": "string"
    }
  ],
  "body": {
    "model": "voice-enrollment",
    "input": {
      "action": "create_voice",
      "target_model": "${model}",
      "prefix": "${prefix}",
      "url": "${voiceUrl}"
    }
  },
  "outputs": {
    "voiceId": "output.voice_id",
    "errorCode": "code",
    "error": "message"
  }
}
```

#### `elevenlabs-voice`

- 标量列：`category=tts`，`caps_json={"modes":"sync","clone":true,"cloneVia":"form"}`

- 请求头**没有独立列**：每条接口自己的 `headers` 就写在下面那几列的 JSON 里（同一家不同端点要的头并不相同）。

**`instance_params_json`**（实例级参数**声明**）

```json
[
  {
    "key": "baseUrl",
    "label": "服务地址",
    "valueType": "string",
    "defaultValue": "https://api.elevenlabs.io/v1"
  },
  {
    "key": "apiKey",
    "label": "API Key",
    "valueType": "secret"
  },
  {
    "key": "timeoutMs",
    "label": "单次超时 ms",
    "valueType": "number",
    "defaultValue": 60000
  }
]
```

**`sync_json`**（sync.submit）

```json
{
  "submit": {
    "path": "${baseUrl}/text-to-speech/${voice}",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "xi-api-key": "${apiKey}"
    },
    "requestParams": [
      {
        "key": "model",
        "label": "模型",
        "valueType": "enum",
        "options": [
          "eleven_multilingual_v2",
          "eleven_flash_v2_5"
        ],
        "defaultValue": "eleven_multilingual_v2"
      },
      {
        "key": "text",
        "label": "合成文本",
        "valueType": "text"
      },
      {
        "key": "voice",
        "label": "音色 ID",
        "valueType": "enum",
        "voiceTable": true,
        "options": [
          {
            "value": "CwhRBWXzGAHq8TQ4Fs17",
            "label": "Roger",
            "group": "男声",
            "note": "随性、浑厚 · 日常对话"
          },
          {
            "value": "IKne3meq5aSn9XLyUdCD",
            "label": "Charlie",
            "group": "男声",
            "note": "澳洲青年 · 有精神"
          },
          {
            "value": "JBFqnCBsd6RMkjVDRZzb",
            "label": "George",
            "group": "男声",
            "note": "暖 · 抓人的讲述感"
          },
          {
            "value": "N2lVS1w4EtoT3dr4eOWO",
            "label": "Callum",
            "group": "男声",
            "note": "沙哑 · 带刺"
          },
          {
            "value": "TX3LPaxmHKxFdv7VOQHJ",
            "label": "Liam",
            "group": "男声",
            "note": "短视频向 · 有活力"
          },
          {
            "value": "bIHbv24MWmeRgasZH58o",
            "label": "Will",
            "group": "男声",
            "note": "松弛 · 乐观"
          },
          {
            "value": "cjVigY5qzO86Huf0OWal",
            "label": "Eric",
            "group": "男声",
            "note": "男中音 · 稳"
          },
          {
            "value": "iP95p4xoKVk53GoZ742B",
            "label": "Chris",
            "group": "男声",
            "note": "朴实 · 百搭"
          },
          {
            "value": "nPczCjzI2devNBz1zQrb",
            "label": "Brian",
            "group": "男声",
            "note": "低沉 · 安抚"
          },
          {
            "value": "onwK4e9ZLuTAKqWW03F9",
            "label": "Daniel",
            "group": "男声",
            "note": "播音腔 · 新闻"
          },
          {
            "value": "pNInz6obpgDQGcFmaJgB",
            "label": "Adam",
            "group": "男声",
            "note": "明亮男高音 · 有压"
          },
          {
            "value": "pqHfZKP75CvOlQylNhV4",
            "label": "Bill",
            "group": "男声",
            "note": "成熟 · 讲故事"
          },
          {
            "value": "SOYHLrjzK2X1ezoPC6cr",
            "label": "Harry",
            "group": "男声",
            "note": "战士腔 · 有冲劲"
          },
          {
            "value": "EXAVITQu4vr4xnSDxMaL",
            "label": "Sarah",
            "group": "女声",
            "note": "自信 · 专业 · 让人放心"
          },
          {
            "value": "FGY2WhTYpPnrIDTdsKH5",
            "label": "Laura",
            "group": "女声",
            "note": "明媚 · 一点古怪"
          },
          {
            "value": "Xb7hH8MSUJpSbSDYk0k2",
            "label": "Alice",
            "group": "女声",
            "note": "英音 · 教学向"
          },
          {
            "value": "XrExE9yKIg1WjnnlVkGX",
            "label": "Matilda",
            "group": "女声",
            "note": "职业 · 中低音"
          },
          {
            "value": "cgSgspJ2msm6clMCkdW9",
            "label": "Jessica",
            "group": "女声",
            "note": "美式 · 俏皮"
          },
          {
            "value": "hpp4J3VqNfWAUOO0d1Us",
            "label": "Bella",
            "group": "女声",
            "note": "明亮 · 叙述感"
          },
          {
            "value": "pFZP5JQG7iQjIQuC4Bku",
            "label": "Lily",
            "group": "女声",
            "note": "英音 · 新闻与旁白"
          },
          {
            "value": "SAz9YHcvj6GT2YYXdXww",
            "label": "River",
            "group": "中性",
            "note": "松弛中性 · 旁白与对话都行"
          }
        ],
        "defaultValue": "CwhRBWXzGAHq8TQ4Fs17"
      }
    ],
    "body": {
      "text": "${text}",
      "model_id": "${model}"
    },
    "artifactForm": "binary",
    "outputs": {
      "errorCode": "detail.code",
      "error": "detail.message"
    }
  }
}
```

**`async_json`**（async.submit）

```json
null
```

**`upload_json`**（upload）

```json
null
```

**`clone_json`**（clone）

```json
{
  "path": "${baseUrl}/voices/add",
  "method": "POST",
  "headers": {
    "xi-api-key": "${apiKey}"
  },
  "requestParams": [
    {
      "key": "preferredName",
      "label": "音色名",
      "valueType": "string",
      "defaultValue": "mapvideo"
    }
  ],
  "form": {
    "name": "${preferredName}",
    "files": "${voiceData}"
  },
  "outputs": {
    "voiceId": "voice_id",
    "errorCode": "detail.code",
    "error": "detail.message"
  }
}
```

#### `minimax-voice`

- 标量列：`category=tts`，`caps_json={"modes":"sync","clone":true,"cloneVia":"upload"}`

- 请求头**没有独立列**：每条接口自己的 `headers` 就写在下面那几列的 JSON 里（同一家不同端点要的头并不相同）。

**`instance_params_json`**（实例级参数**声明**）

```json
[
  {
    "key": "baseUrl",
    "label": "服务地址",
    "valueType": "string",
    "defaultValue": "https://api.minimax.io/v1"
  },
  {
    "key": "apiKey",
    "label": "API Key",
    "valueType": "secret"
  },
  {
    "key": "timeoutMs",
    "label": "单次超时 ms",
    "valueType": "number",
    "defaultValue": 60000
  }
]
```

**`sync_json`**（sync.submit）

```json
{
  "submit": {
    "path": "${baseUrl}/t2a_v2",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "Authorization": "Bearer ${apiKey}"
    },
    "requestParams": [
      {
        "key": "model",
        "label": "模型",
        "valueType": "enum",
        "options": [
          "speech-2.8-hd",
          "speech-2.8-turbo",
          "speech-2.6-hd",
          "speech-2.6-turbo",
          "speech-02-hd",
          "speech-02-turbo"
        ],
        "defaultValue": "speech-2.8-hd"
      },
      {
        "key": "text",
        "label": "合成文本",
        "valueType": "text"
      },
      {
        "key": "voice",
        "label": "音色 ID",
        "valueType": "string",
        "defaultValue": "male-qn-qingse"
      }
    ],
    "body": {
      "model": "${model}",
      "text": "${text}",
      "voice_setting": {
        "voice_id": "${voice}"
      }
    },
    "artifactForm": "hex",
    "outputs": {
      "artifact": "data.audio",
      "errorCode": "base_resp.status_code",
      "error": "base_resp.status_msg"
    }
  }
}
```

**`async_json`**（async.submit）

```json
null
```

**`upload_json`**（upload）

```json
{
  "path": "${baseUrl}/files/upload",
  "method": "POST",
  "headers": {
    "Authorization": "Bearer ${apiKey}"
  },
  "form": {
    "purpose": "voice_clone",
    "file": "${voiceData}"
  },
  "outputs": {
    "artifact": "file.file_id",
    "errorCode": "base_resp.status_code",
    "error": "base_resp.status_msg"
  }
}
```

**`clone_json`**（clone）

```json
{
  "path": "${baseUrl}/voice_clone",
  "method": "POST",
  "headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer ${apiKey}"
  },
  "requestParams": [
    {
      "key": "voiceId",
      "label": "音色名（自己起 · 上游不回它）",
      "valueType": "string",
      "defaultValue": "mapvideo"
    }
  ],
  "body": {
    "file_id": "${voiceData}",
    "voice_id": "${voiceId}"
  },
  "outputs": {
    "errorCode": "base_resp.status_code",
    "error": "base_resp.status_msg"
  }
}
```

#### `minimax-image`

- 标量列：`category=image`，`caps_json={"modes":"sync"}`

- 请求头**没有独立列**：每条接口自己的 `headers` 就写在下面那几列的 JSON 里（同一家不同端点要的头并不相同）。

**`instance_params_json`**（实例级参数**声明**）

```json
[
  {
    "key": "baseUrl",
    "label": "服务地址",
    "valueType": "string",
    "defaultValue": "https://api.minimax.io/v1"
  },
  {
    "key": "apiKey",
    "label": "API Key",
    "valueType": "secret"
  },
  {
    "key": "timeoutMs",
    "label": "单次超时 ms",
    "valueType": "number",
    "defaultValue": 60000
  }
]
```

**`sync_json`**（sync.submit）

```json
{
  "submit": {
    "path": "${baseUrl}/image_generation",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "Authorization": "Bearer ${apiKey}"
    },
    "requestParams": [
      {
        "key": "model",
        "label": "模型",
        "valueType": "enum",
        "options": [
          "image-01"
        ],
        "defaultValue": "image-01"
      },
      {
        "key": "aspectRatio",
        "label": "画幅",
        "valueType": "enum",
        "options": [
          "1:1",
          "16:9",
          "9:16",
          "4:3",
          "3:4",
          "3:2",
          "2:3",
          "21:9"
        ],
        "defaultValue": "1:1"
      },
      {
        "key": "promptOptimizer",
        "label": "提示词润色",
        "valueType": "boolean",
        "defaultValue": false
      },
      {
        "key": "prompt",
        "label": "画面描述",
        "valueType": "text"
      }
    ],
    "body": {
      "model": "${model}",
      "prompt": "${prompt}",
      "aspect_ratio": "${aspectRatio}",
      "prompt_optimizer": "${promptOptimizer}"
    },
    "artifactForm": "url",
    "outputs": {
      "artifact": "data.image_urls[0]",
      "errorCode": "base_resp.status_code",
      "error": "base_resp.status_msg"
    }
  }
}
```

**`async_json`**（async.submit）

```json
null
```

**`upload_json`**（upload）

```json
null
```

**`clone_json`**（clone）

```json
null
```
<!-- END generated:seed-templates -->
## 十、内置模板清单（seed）

| `tpl_id` | category | 接口槽 | 真实上游实测 |
|---|---|---|---|
| `deepseek-chat` | llm | `sync.submit` | ✅ 2026-09-26 重跑取到文本（1.9s） |
| `qwen-image` | image | `sync.submit` + `async.submit` + `async.query` | ✅ 两条都过：同步 50.8s · 1650KB；异步 46.9s（第 9 次查询命中）· 1465KB |
| `qwen-tts` | tts | `sync.submit` + `clone` | ✅ 合成 176KB；**复刻 → 立刻用那个音色合成** 270KB（5.1s） |
| `elevenlabs-voice` | tts | `sync.submit` + `clone` | 合成 ✅ 88KB 裸字节 · 错误形状 ✅；克隆的 multipart 发对了（`name` + `files` 分片），卡在**套餐不含即时复刻**（`paid_plan_required` → 报成跳过） |
| `minimax-voice` | tts | `upload` + `clone` + `sync.submit` | 上传 ✅ **真发通**（HTTP 200 · `file.file_id` = 整数 445802206159195 · `base_resp:{status_code:0,status_msg:'success'}`）· 复刻与合成 ⬜ 卡在账号余额（`1008`），没跑到成功响应 |
| `minimax-image` | image | `sync.submit` | ⬜ **未实测**（同样卡 `1008`；这家没有异步任务端点，链接 24 小时过期所以是 `url` 档）|

**MiniMax 这两份为什么配得出来，靠的是两条新规则**（都不按厂商名分支）：
① 它的 `/v1/voice_clone` 成功响应里**没有音色 id**（官网说名字就是请求里自己传的 `voice_id`）—— 固定项「音色 ID」现在看这一格自己有没有写 `${voiceId}`：写了就允许路径留空，`runClone` 拿本轮发出去的那个名字当结果；
② 它家成功 = HTTP 200 + `base_resp:{status_code:0,status_msg:'success'}`，三个值全是真值 —— `errorOf` 现在认 `0` / `ok` / `success` 为「没有错误」，否则**每一次成功都会被读成失败**（这条是接它家时才发现的，此前所有上游的错误项都是「取不到值 = 没事」那种形状）。

**实测（2026-09-23）**：异步查询回的产物路径与同步**同一条**（`output.choices[0].message.content[0].image`），文档写的 `output.results[].url` 是这个模型不再用的旧形状；一次 1024×1024 出图排队 52 秒～9 分钟不等，所以查询节奏是实例级参数、默认给到 30 分钟预算。

**「产物形式」确实作用在最后那一步（2026-09-26 实测）**：真查一次千问异步生图（`SUCCEEDED`，当场下载 **1522580 字节**、`image/png`），
再拿**同一份响应**只改「这一格的产物形式」与「产物」路径两格，四档回显各不相同 ——
① 这一格没选产物形式：`outcome=success` 但**零字节**（引擎不去响应找产物）；
② 选了 url、产物路径空着：抛「产物取不到（产物形式=url，但固定项「产物」没取到值；这一步取到的是 taskId、status）」—— 把实际取到的槽位列出来，不用瞎猜；
③ url + 路径按实测：1522580 字节、头四字节 `89 50 4e 47`（真 PNG 的签名）；
④ 同一份响应改成 base64 档、路径不动：把那条 `https://…` 链接当 base64 解，抛 `Invalid character`。
② 与 ④ 的区别只在档位，取的是同一个字段 —— 这一格既决定**去哪个字段取**之后的**怎么变成字节**，也证明它是逐格一份而不是整份模板一份。

按用户要求内置这七份（两份 MiniMax 里，**只有「上传」那一格真发通过**，其余卡在账号余额 `1008` —— 见第十节那张表）。接别家 = 界面「＋ 模板」自己填（引擎里没有任何按厂商名写的分支）；`blankTemplate(category)` 给一份只有地址与密钥的壳。

**「千问语音（音量 / 发音修正）」这一份只到「照官方 HTTP 参考抄对」为止，还没真发**：请求形状、`input.volume`（整数 0–100，上游默认 50，这里声明成默认 100）、`input.hot_fix`（`{pronunciation:[{词:音}], replace:[{原:换}]}`，`cosyvoice-v2` 不支持）与 14 条音色名都逐字取自文档，产物路径 `output.audio.url`（有效期 24 小时，所以 `artifactForm='url'` 当场下载）。它**不勾建音色** —— 那一家的声音复刻要的是公网可取的参考音频地址，本地文件给不出去。

**两份语音上游的实测状态（2026-09-26）**：千问的合成与复刻**都真发过并取到产物**（复刻完立刻用它合成一句，300KB wav）。

**ElevenLabs 的整条配音链路也走了一遍（桌面端 UI 里真发）**：⚙ 选这条实例 → 字幕生成 → 音色区出「男声 13 / 女声 7 / 中性 1」→ 点 `Roger` → 加一行 → 生成本句配音 → 行上徽标 `5.7s`，`narration.entries[0].audioId` 指向 `asset` 表里一条 `audio/mpeg`。
**ElevenLabs 的合成也在应用里的「试调用」跑通了** —— 音色 id 在地址里、响应体就是裸字节（200 · 40KB），`artifactForm='binary'` 这一档第一次真跑到；
错误体形状同时实测到 `{detail:{type,code,message,status}}`，所以固定项的 `error` 从猜的 `detail.status` 改成 `detail.message`
（填错不报错，只是界面只剩一条「HTTP 401」，看不出为什么）。
建音色那一步：multipart 请求本身发对了（`name` + `files` 两个字段都被受理），上游回的是
`paid_plan_required · Your subscription does not include instant voice cloning` —— **这是账号套餐，不是形状错**；
所以 `files` 这个分片名目前只有「上游受理了它」这一层证据，没有成功响应可对照。
它家的默认音色表（21 条，含官方 labels 里 `gender: neutral` 那一档）逐字取自 `/v1/voices` 的真响应，现在是 seed 里那份模板的候选值（`elevenLabsVoices`），不再是 `lib/voices.ts` 的常量。

**「试调用」的回显在应用里逐类看过（2026-09-26）**：文案生成 → 响应原文那一栏就是美化过的 JSON；语音（千问配音 · 提交）→ 播控条长出来了（`<audio controls>` 吃一个 blob 地址）；图片（千问出图 · 提交）→ 图直接显示，`naturalWidth` 报回 **2048×1152**，也就是真解码出来了、不是个坏链接。
DeepSeek 那条实例这次在应用里回的是 `HTTP 404` —— 不是引擎：他那行 `deepseek-chat` 模板被改名成 `openai`，且「提交」的地址栏里贴着一串千问异步生图的任务号（`260a1ade-…`），地址就成了那样；CLI 走 seed 是同一条链路，正常出文本。

## 十一、实现落点

| 文件 | 职责 |
|---|---|
| `docs/db-schema-v2.sql` | 四张表 DDL（模板 / 实例 / 音色 / 任务）与索引，含真外键 |
| `src/lib/request-engine.ts` | 纯函数：三层取值、`${x}` 求值与删键级联、`outputs` 取名、`classify`、字节还原、`validateTemplate`、按声明打码、`retriable`（只有 429·5xx 算「重试有用」） |
| `src/lib/template-seed.ts` | 内置模板 seed（铺表 + 「恢复默认」的覆盖源）；**第九节就是它展开出来的** |
| `tools/gen-template-json-doc.mjs` | 把 seed 展开成第九节（参数总表 + 逐列 JSON），`--check` 只校验 |
| `src/stores/taskStore.ts` | 在途任务的调度：并发上限取实例参数、按 `next_query_at` 错峰、逐条进度、失败行按 `retriable` 决定重试还是点名 |
| `src/lib/providers.ts` | `callLLM` / `callTTS` / `callImage` / `cloneVoice` 薄壳：实例 → 模板 → 引擎 → 产物落 `asset` |
| `src/stores/providerStore.ts` | 模板与实例两份实体的读写与持久化；`currentInstance(category)` 取调用处选中的实例 |
| `electron/db-v2.mjs` / `main.mjs` | 表映射与 IPC（`templates:*` / `providers:*`）、通用 `net:request`（含 multipart 与超时） |
| `src/components/ProviderPanel.tsx` `TemplatesPane.tsx` | 实例设置页 / 接口模板页 |
| `src/components/VoicePicker.tsx` `GenerateDialog.tsx` | 音色区（含克隆）/ 逐行配音与批量队列 |
| `tools/verify-request-engine.mjs` | 引擎离线回归（真机抓到的响应原样留桩） |
| `tools/verify-provider-templates.mjs` | 四张表 + 旧形状让位的库侧回归 |
| `tools/try-real-calls.mjs` | 真实上游验证（会花配额，只在明确要求时跑） |
