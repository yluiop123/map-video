# 供应商配置设计：接口模板 · 实例 · 音色 · 任务 · 取回管线

> 一句话：**模板 = 一份完整接法（一行存下同步 / 异步 / 桥接 / 克隆的全部形状，纯数据）；实例 = 选哪份模板 + 一组取值（密钥也只是取值）；音色与异步任务是两份账本；调用正文与产物 URL 不落库。**

## 一、四层职责

| 层 | 存哪 | 装什么 | 谁编辑 |
|---|---|---|---|
| **模板** | `provider_template`（**一行 = 一份完整模板**） | 这一家这个功能怎么发、返回从哪取、产物怎么变成字节 | 接口模板页（专家） |
| **实例** | `provider` | 引用哪份模板 + 同步还是异步 + 全部取值（地址 / 密钥 / 模型 / 尺寸…） | ⚙ 实例设置页（日常） |
| **音色** | `voice` | 参考音频 → 厂商 voiceId 的账本（幂等、绑模型、可重建） | 字幕生成里的音色区 |
| **任务** | `task` | 在途异步任务（跨重启续跑、逐条进度与产物） | 无界面写入，调度器读写 |

没有「模板组」这一层：一份模板就是一行，同步异步桥接克隆都是它 JSON 列里的键，所以不存在跨行一致性要防，也不需要组表与唯一索引。

**一份模板可以配多条实例**（两套账号 = 两条实例），调用处显式选一条用 —— 没有 `active` 标记，也不存在「哪条生效」这种第二处真相。

## 二、`provider_template`（一行一份）

```sql
CREATE TABLE IF NOT EXISTS provider_template (
  tpl_id      TEXT PRIMARY KEY,          -- deepseek-chat / qwen-image / qwen-tts / custom-1 …
  name        TEXT NOT NULL DEFAULT '',  -- 模板名（用户自填的单个字符串，不做中英两份）
  category    TEXT NOT NULL,             -- llm / tts / image（不加 CHECK，取值由 TS 联合类型管）
  caps_json   TEXT NOT NULL CHECK (json_valid(caps_json)),  -- 能力开关：接法 / 产物形式 / 建音色 / 建前先上传
  headers_json TEXT,     instance_params_json TEXT,     -- 模板级请求头 / 实例级参数声明
  sync_json    TEXT,     async_json    TEXT,            -- 同步 {submit} / 异步 {submit,query}
  download_json TEXT,    upload_json   TEXT,   clone_json TEXT,   -- 三条桥接 / 核心请求
  ref_sample_rate INTEGER,                              -- 克隆参考音频采样率 Hz（各家不同）
  ord INTEGER NOT NULL DEFAULT 0,  created_at INTEGER,  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_tpl_category ON provider_template(category, ord, name);
```

所有 JSON 列都带 `CHECK (… IS NULL OR json_valid(…))`；`category` 不写 CHECK —— 接一家新供应商不改表、不加 switch。

**能力开关只有一列**：`caps_json = { modes: sync|async|both, artifact: none|binary|base64|hex|url|viaDownload, clone, uploadFirst }`。
早先是 `use_clone` / `upload` 两个布尔列 —— 它们与「`clone_json` / `upload_json` 空不空」是同一条事实的第二、第三份，
`validateTemplate` 还得专门写两条报错去拦它们不一致，而判「能不能克隆」的 `supports()` 读的又是槽位。
现在开关是输入、槽位与固定返回项都是它的推导结果（`slotsOf` / `requiredOutputsOf`），不一致没有发生的余地。

内置模板由 seed（`src/lib/template-seed.ts`）在首次建库时铺成行，之后就是普通可编辑数据；「恢复默认」= 用 seed 覆盖那一行。

## 三、接口槽：六个形状，由能力开关推导该有哪几格

`caps_json` 里那几个开关一答完，`slotsOf(tpl)` 就给出这一份模板**该有哪些接口槽** —— 界面上没有「＋ 加一条接口」这回事，
也不给「删掉这条接口」（不想要就关对应的开关）。六个槽位：

| ReqKey | 存哪列 | 干什么 | 什么时候有 |
|---|---|---|---|
| `sync.submit` | `sync_json.submit` | 一把梭：发出去就拿到产物或结果字段 | `modes` 含 sync（llm 恒有） |
| `async.submit` | `async_json.submit` | 只负责提交并交出任务号 | `modes` 含 async |
| `async.query` | `async_json.query` | 怎么查、什么算成/败、产物在哪 | 同上 —— **与 submit 成对，缺一即报错** |
| `download` | `download_json` | 桥接：中间量 → 最终下载地址 | `artifact = viaDownload` |
| `upload` | `upload_json` | 桥接：本地文件 → `fileId` | `clone` 且 `uploadFirst` |
| `clone` | `clone_json` | 核心：参考音频 → `voiceId` | `clone`（仅 tts） |

每个接口槽的结构（`RequestDef`）：

```jsonc
{ "path": "${baseUrl}/services/aigc/image-generation/generation",  // 查询串直接拼在串上
  "method": "POST",
  "headers": { "X-DashScope-Async": "enable" },        // 与模板级 headers 合并，这一层的赢
  "requestParams": [ /* 这个请求专属的参数声明：model / size… */ ],
  "callParams":    [ /* 每次调用由界面或程序给的参数：text / prompt / 文件… */ ],
  "body": { "model": "${model}", "input": { "text": "${text}" } },
  "form": { "file": "${audioFile}", "purpose": "voice_clone" },   // 只有 upload 那一格用（multipart）
  "outputs": { "taskId": "output.task_id", "error": "message" },  // 固定项 + 自定义变量，见下
  "successValues": ["SUCCEEDED"], "failureValues": ["FAILED","CANCELED","UNKNOWN"],  // 只有 query 用
  "timeoutMs": 60000 }
```

- **`outputs` 分两种，界面上也分两处**：
  - **固定项**（`requiredOutputsOf(tpl, slot)`）—— 名字由引擎写死，只能填路径：`content`（文案）、`artifact`（产物）、
    `taskId`（任务号）、`status`（任务状态）、`fileId`、`voiceId`、`error` / `errorCode`。
    产物**只有一个名字** `artifact`，早先代码里那串 `values.audio ?? values.image ?? values.url ?? values.resultUrl ?? values.fileUrl`
    是同一条事实的五份真相，填对了五个之一才碰巧能用 —— 现在没有「碰巧」这回事，`validateTemplate` 会要求必填的固定项必须填路径。
  - **自定义变量**（可选、界面默认折叠）—— 只用于在别的请求里写 `${它}`，引擎从不读它们。
    与三层参数同名会被点名（同一个 `${x}` 有两个来源，谁赢取决于调用时给没给值）。
- **产物以什么形式给是模板级的一件事**（`caps.artifact`：响应体即字节 / base64 / hex / 链接当场下 / 链接要再问一次），
  不再有每槽一个 `outputFormat` —— 同步与异步共用一个答案。
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

- **密钥 = `valueType:'secret'` 的普通参数**，不占具名列、不建密钥表：界面上渲染成密码框、永不回显原文，预览与日志里按声明打码（`Bearer sk-****（长度 35）`）。哪些名字算密钥只有一处答案 —— 模板本身。
- `sync` 在这一处：决定这次走 `sync.submit` 还是 `async.submit` + `async.query`。该模板没有 async 时界面上这一格直接不出现（**显式不可用，不做隐式降级**）。
- 同一份模板挂两条实例 = 两套账号；界面在 ⚙ 里以芯片列出，调用处选一条。

## 五、三层参数与取值优先级

| 层 | 声明在哪 | 取值存哪 | 界面 |
|---|---|---|---|
| **实例级** | `instance_params_json`（所有请求共用一份） | `values.instance[key]` | ⚙ 实例设置页 |
| **请求级** | 该接口槽的 `requestParams` | `values.requests[<ReqKey>][key]` | ⚙ 实例设置页，按请求分区 |
| **调用级** | 该接口槽的 `callParams` | **不落库**，每次调用由代码给 | 业务界面（字幕行文本、出图描述、上传的文件） |

求值时一个 `${name}` 的取值顺序：**声明的默认值 → `values.instance` → `values.requests[<本槽>]` → 上游 `outputs` 产出的同名变量 → 调用参数**。

- 三层**不是三张表**，就是上面那几个 JSON 字段里的键。
- 谁都没给的占位符 = 直接**点名报错**（`这些占位符没有任何来源给值：${size}`），不发半个请求。
- 声明了但这次没填值 → **删键**（父对象被删空则连父键一起删）。这是「可选参数」的正确形态：不少上游拒绝 `"thinking":{}` 但接受不含该键。
- `${x}` 用在整串位置保留原类型（`${n}` 是数字就发数字）；嵌在字符串里就是插值。
- 参数字段表（`ParamSpec`）：

| 字段 | 含义 |
|---|---|
| `key` | 占位符名（`${key}`） |
| `label` | 显示名，**单个字符串**（纯显示，不进请求体） |
| `valueType` | `string`｜`text`｜`number`｜`boolean`｜`enum`｜`secret`｜`file`｜`list`｜`json`（模板页是下拉框） |
| `defaultValue` | 模板给的默认值（实例没填就用它） |
| `required` | 没值时报错而不是删键 |
| `options` | 候选值：裸值或 `{value,label}`；有候选 → `OptionBlocks`，**不写原生 `<select>`** |
| `min`/`max`/`step` | number 控件范围 |
| `accept`/`maxSize` | file 控件：接受类型与体积上限 |
| `itemType`/`item` | list 的行编辑器（`item` 可给元素子模板） |
| `transform` | 数据驱动的取值加工：`base64DataUri`｜`json`｜`hotFixArray`（**不按厂商名写分支**） |

- **内置 seed 只声明真正引用到的参数**，并且只到「该请求用得上」为止；`{text}` `{prompt}` 这类正文由调用点给值，要渲染成输入框就从占位符反推，不靠声明。
- 候选值由模板写死，**不运行时从上游拉**（各家没有统一的 list 接口，顺序与文案不可控）。
- **发音修正（`hotFix`）是这条规则的样例**：界面（`HotFixField`，项目级，存进 `narration.hot_fix_json`）保存的就是
  上游那份对象形状 `{pronunciation:[{词:读音}], replace:[{原:换}]}`，模板在 `input` 里写 `hot_fix: '${hotFix}'` 即可（不选 transform → 原样发出）；
  要数组形状的供应商（`"词/读音"`）给这个参数选 `transform: hotFixArray`，由引擎摊平 —— 差别只在模板，代码里没有厂商名分支。
  没填修正时那个键整个消失，不会发半个空对象给上游（回归 `verify-request-engine` 3.9 / 3.10）。
  注意**不是每条端点都吃这个参数**：非实时 CosyVoice / Qwen-Audio-TTS（`/services/audio/tts/SpeechSynthesizer`）有 `hot_fix`（`cosyvoice-v2` 除外），
  而 seed 里那条 `qwen3-tts`（`/services/aigc/multimodal-generation/generation`）**没有**（两条都按 2026-09-24 官方 API 参考逐字核对，未实测）—— 自建 CosyVoice 模板时才用得上。

## 六、取回管线

| 步 | 做什么 | 由哪格决定 |
|---|---|---|
| ① 求值 | 三层取值 + 上游变量拼出真实请求；有占位符没来源 → 当场点名 | `path` / `headers` / `body` / `form` + 三层声明 |
| ② 发送 | 桌面走主进程 `net:request`（无 CORS、Key 不出本机），网页走 `fetch` | 该槽的 `timeoutMs` |
| ③ 取字段 | 按 `outputs` 从响应里取名字，取到的进作用域 | `outputs` |
| ④ 判状态 | `classify(status, successValues, failureValues)`；中间态就再来一轮 | `async.query` 两个枚举 |
| ⑤ 变字节 | `binary` 响应体即产物；`hex`/`base64` 从固定项 `artifact` 解；`url` **当场下载**（`viaDownload` 则先走 `download` 桥接拿地址） | `caps.artifact` + `artifact` 那格的路径 |

```
同步：sync.submit →（配了 download 再问一次）→ 字节
异步：async.submit 交出 taskId → 调度器/内存轮询按节奏打 async.query → SUCCEEDED → 字节
克隆：(upload 拿 fileId) → clone 交出 voiceId
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
| **⚙ 实例设置**（`ProviderPanel`，按 文案 / 语音 / 图片 三屏） | 实例芯片一排 + `＋实例`；当前实例：名称 → 模板下拉 → 同步/异步 → **实例级参数** → 按请求分区的**请求级参数** → **试调用**（选一条接口槽真发一次）。控件一律按 `valueType`+`options` 渲染（`secret` → 密码框，枚举 → `OptionBlocks`） |
| **接口模板页**（`TemplatesPane`，⚙ 左侧独立入口） | 左：模板列表（按 category 分组，**只显示 name，主键不外显**）；中：模板头（名字 + **能力开关**：接法 / 产物形式 / 建音色 / 建前先上传 / 采样率）→ 开关推导出的接口槽卡片（path/method/该槽 headers/请求体或上传表单/请求级与调用级参数表/**固定项逐行填路径** + 折叠的「给下一个请求用的变量」/两个枚举/超时）；右：实例级参数表。每格给**预览请求（零网络，密钥打码）** |
| **字幕生成 / 出图处** | 选哪条实例 + 调用级参数（文本、描述、尺寸、文件），不碰模板 |

- 「预览请求 → 试调用」是这套设计的验收口，两件事分在两页：**预览**在模板页（只跑求值 + 按声明打码，一个字节都不发），**试调用**在实例页（真发一条要的是这条实例的 Key）。改完模板先看形状，再决定要不要花一次真调用。
- 缺配项**当场点名**（`validateTemplate`）：开关要求的槽没配、槽没填地址、**必填的固定项没填路径**、自定义变量与参数同名、
  开关不需要的槽还留着、有 `async.submit` 没 `async.query`、查询没 `successValues`、实例参数同名重复、占位符没人给值 —— 不留到运行时。
- 新界面用 shadcn 原子（`src/components/ui/`），旧面板沿用 `ui/primitives.tsx`；两边都不写原生 `<select>`。
- **AI 功能只有桌面端有**：网页端不配 Key、不显示字幕生成里的 AI 区（浏览器直连必然 CORS，且 Key 没地方安全存）。
## 九、内置模板的具体参数与逐列 JSON

<!-- BEGIN generated:seed-templates -->
_（本节由 `node --experimental-strip-types tools/gen-template-json-doc.mjs` 从 `src/lib/template-seed.ts` 生成，改 seed 后重跑；`--check` 只校验。）_

### 9.1 能力开关：这一家怎么交活

`caps_json` 一列装着全部开关，**该有哪些接口槽、每槽必须交出哪些字段，全由它推导**（`slotsOf` / `requiredOutputsOf`）。

| 模板 | 接法 | 产物形式 | 建音色 | 建前先上传 | 参考音频采样率 | 推导出的接口槽 |
|---|---|---|---|---|---|---|
| `deepseek-chat` | sync | none | 否 | 否 | — | `同步 · 提交` |
| `qwen-image` | both | url | 否 | 否 | — | `同步 · 提交` + `异步 · 提交` + `异步 · 查询` |
| `qwen-tts` | sync | url | 是 | 否 | 24000 | `同步 · 提交` + `核心 · 克隆音色` |

### 9.2 每格必须交出的返回项（名字写死，只能填路径）

这些名字就是引擎读取的键 —— 写错不会报错，只会「产物取不到」或「一路查到超时」，所以不给自定义。
自定义变量（只给下游 `${它}` 用、引擎不读）另在一格，不进这张表。

| 模板 | 接口槽 | 固定项 | 名字（写死） | 必填 | 引擎拿它干什么 |
|---|---|---|---|---|---|
| `deepseek-chat` | 同步 · 提交 | 生成的文本 | `content` | 是 | 引擎只认这个名字 |
| `deepseek-chat` | 同步 · 提交 | 错误信息 | `error` | 建议 | 上游报的原文，界面直接显示它 |
| `deepseek-chat` | 同步 · 提交 | 错误码 | `errorCode` | 建议 | 和错误信息拼在一起，方便对文档查 |
| `qwen-image` | 同步 · 提交 | 产物 | `artifact` | 是 | 图片或音频的下载地址（带时效，当场下载） |
| `qwen-image` | 同步 · 提交 | 错误信息 | `error` | 建议 | 上游报的原文，界面直接显示它 |
| `qwen-image` | 同步 · 提交 | 错误码 | `errorCode` | 建议 | 和错误信息拼在一起，方便对文档查 |
| `qwen-image` | 异步 · 提交 | 任务号 | `taskId` | 是 | 交给调度器存着，之后拿它去查 |
| `qwen-image` | 异步 · 提交 | 错误信息 | `error` | 建议 | 上游报的原文，界面直接显示它 |
| `qwen-image` | 异步 · 提交 | 错误码 | `errorCode` | 建议 | 和错误信息拼在一起，方便对文档查 |
| `qwen-image` | 异步 · 查询 | 任务状态 | `status` | 是 | 没取到它就一直算「还在跑」，查到次数上限才失败 |
| `qwen-image` | 异步 · 查询 | 产物 | `artifact` | 是 | 图片或音频的下载地址（带时效，当场下载） |
| `qwen-image` | 异步 · 查询 | 错误信息 | `error` | 建议 | 上游报的原文，界面直接显示它 |
| `qwen-image` | 异步 · 查询 | 错误码 | `errorCode` | 建议 | 和错误信息拼在一起，方便对文档查 |
| `qwen-tts` | 同步 · 提交 | 产物 | `artifact` | 是 | 图片或音频的下载地址（带时效，当场下载） |
| `qwen-tts` | 同步 · 提交 | 错误信息 | `error` | 建议 | 上游报的原文，界面直接显示它 |
| `qwen-tts` | 同步 · 提交 | 错误码 | `errorCode` | 建议 | 和错误信息拼在一起，方便对文档查 |
| `qwen-tts` | 核心 · 克隆音色 | 音色 ID | `voiceId` | 是 | 存进音色账本，绑这条实例与目标模型 |
| `qwen-tts` | 核心 · 克隆音色 | 错误信息 | `error` | 建议 | 上游报的原文，界面直接显示它 |
| `qwen-tts` | 核心 · 克隆音色 | 错误码 | `errorCode` | 建议 | 和错误信息拼在一起，方便对文档查 |

### 9.3 三份模板各自声明了哪些参数

「层」就是取值的三级：实例级整条实例共用、请求级按接口槽各存各的、调用级不落库（由业务界面或试调用现场给）。

#### `deepseek-chat` · DeepSeek 对话（llm）

| 层 | key | 显示名 | 类型 | 默认值 | 候选值 / 范围 | 必填 | 加工 |
|---|---|---|---|---|---|---|---|
| 实例级 | `baseUrl` | 服务地址 | string | `"https://api.deepseek.com"` | — |  |  |
| 实例级 | `apiKey` | API Key | secret | — | — |  |  |
| 实例级 | `timeoutMs` | 单次超时 ms | number | `60000` | — |  |  |
| 请求级 `sync.submit` | `model` | 模型 | enum | `"deepseek-flash"` | deepseek-flash · deepseek-v4-pro |  |  |
| 请求级 `sync.submit` | `reasoningEffort` | 思考强度 | enum | — | high · medium · low |  |  |
| 请求级 `sync.submit` | `thinking` | 深度思考 | enum | — | enabled · disabled |  |  |
| 请求级 `sync.submit` | `temperature` | 温度 | number | — | ≥0 ≤2 步长 0.1 |  |  |
| 请求级 `sync.submit` | `maxTokens` | 最大输出 token | number | — | — |  |  |
| 调用级 `sync.submit` | `systemPrompt` | 系统提示词 | text | — | — | 是 |  |
| 调用级 `sync.submit` | `userPrompt` | 用户提示词 | text | — | — | 是 |  |

#### `qwen-image` · 千问 文生图（image）

| 层 | key | 显示名 | 类型 | 默认值 | 候选值 / 范围 | 必填 | 加工 |
|---|---|---|---|---|---|---|---|
| 实例级 | `baseUrl` | 服务地址 | string | `"https://maas.qianwenaiapi.com/api/v1"` | — |  |  |
| 实例级 | `apiKey` | API Key | secret | — | — |  |  |
| 实例级 | `timeoutMs` | 单次超时 ms | number | `60000` | — |  |  |
| 实例级 | `queryIntervalMs` | 查询间隔 ms | number | `5000` | — |  |  |
| 实例级 | `queryMaxAttempts` | 查询次数上限 | number | `360` | — |  |  |
| 请求级 `sync.submit` | `model` | 模型 | enum | `"qwen-image-3.0-pro"` | qwen-image-3.0-pro |  |  |
| 请求级 `sync.submit` | `size` | 出图尺寸 | string | `"2048*2048"` | — |  |  |
| 请求级 `sync.submit` | `watermark` | 水印 | boolean | `false` | — |  |  |
| 调用级 `sync.submit` | `prompt` | 画面描述 | text | — | — | 是 |  |
| 请求级 `async.submit` | `model` | 模型 | enum | `"qwen-image-3.0-pro"` | qwen-image-3.0-pro |  |  |
| 请求级 `async.submit` | `size` | 出图尺寸 | string | `"2048*2048"` | — |  |  |
| 请求级 `async.submit` | `n` | 张数 | number | `1` | ≥1 ≤4 |  |  |
| 调用级 `async.submit` | `prompt` | 画面描述 | text | — | — | 是 |  |

#### `qwen-tts` · 千问 TTS（tts）

| 层 | key | 显示名 | 类型 | 默认值 | 候选值 / 范围 | 必填 | 加工 |
|---|---|---|---|---|---|---|---|
| 实例级 | `baseUrl` | 服务地址 | string | `"https://maas.qianwenaiapi.com/api/v1"` | — |  |  |
| 实例级 | `apiKey` | API Key | secret | — | — |  |  |
| 实例级 | `timeoutMs` | 单次超时 ms | number | `60000` | — |  |  |
| 请求级 `sync.submit` | `model` | 模型 | enum | `"qwen3-tts-flash"` | qwen3-tts-flash · qwen3-tts-vc-2026-01-22 |  |  |
| 请求级 `sync.submit` | `languageType` | 语种 | enum | `"Chinese"` | Chinese · English · Auto |  |  |
| 调用级 `sync.submit` | `text` | 合成文本 | text | — | — | 是 |  |
| 调用级 `sync.submit` | `voice` | 音色 ID | string | `"Ethan"` | — |  |  |
| 请求级 `clone` | `model` | 复刻目标模型（须与合成同款） | enum | `"qwen3-tts-vc-2026-01-22"` | qwen3-tts-vc-2026-01-22 |  |  |
| 请求级 `clone` | `preferredName` | 音色名 | string | `"mapvideo"` | — |  |  |
| 调用级 `clone` | `audioDataUri` | 参考音频 | file | — | 接受 .mp3,.wav,.m4a，上限 10485760 |  | base64DataUri |

### 9.4 逐列 JSON（照抄可用）

下面每块就是 `provider_template` 那一行对应列里存的内容，键名与列名一一对应；`null` = 该列没配（界面上那一格也就不出现）。

#### `deepseek-chat`

- 标量列：`category=llm`，`caps_json={"modes":"sync","artifact":"none"}`，`ref_sample_rate=NULL`

**`headers_json`**（模板级请求头，这一行所有请求共用）

```json
{
  "Content-Type": "application/json",
  "Authorization": "Bearer ${apiKey}"
}
```

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
          "high",
          "medium",
          "low"
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
        "min": 0,
        "max": 2,
        "step": 0.1
      },
      {
        "key": "maxTokens",
        "label": "最大输出 token",
        "valueType": "number"
      }
    ],
    "callParams": [
      {
        "key": "systemPrompt",
        "label": "系统提示词",
        "valueType": "text",
        "required": true
      },
      {
        "key": "userPrompt",
        "label": "用户提示词",
        "valueType": "text",
        "required": true
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

**`download_json`**（download）

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

- 标量列：`category=image`，`caps_json={"modes":"both","artifact":"url"}`，`ref_sample_rate=NULL`

**`headers_json`**（模板级请求头，这一行所有请求共用）

```json
{
  "Content-Type": "application/json",
  "Authorization": "Bearer ${apiKey}"
}
```

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
      }
    ],
    "callParams": [
      {
        "key": "prompt",
        "label": "画面描述",
        "valueType": "text",
        "required": true
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
      }
    ],
    "callParams": [
      {
        "key": "prompt",
        "label": "画面描述",
        "valueType": "text",
        "required": true
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

**`download_json`**（download）

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

#### `qwen-tts`

- 标量列：`category=tts`，`caps_json={"modes":"sync","artifact":"url","clone":true}`，`ref_sample_rate=24000`

**`headers_json`**（模板级请求头，这一行所有请求共用）

```json
{
  "Content-Type": "application/json",
  "Authorization": "Bearer ${apiKey}"
}
```

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
      }
    ],
    "callParams": [
      {
        "key": "text",
        "label": "合成文本",
        "valueType": "text",
        "required": true
      },
      {
        "key": "voice",
        "label": "音色 ID",
        "valueType": "string",
        "defaultValue": "Ethan"
      }
    ],
    "body": {
      "model": "${model}",
      "input": {
        "text": "${text}",
        "voice": "${voice}"
      },
      "parameters": {
        "language_type": "${languageType}"
      }
    },
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

**`download_json`**（download）

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
  "callParams": [
    {
      "key": "audioDataUri",
      "label": "参考音频",
      "valueType": "file",
      "transform": "base64DataUri",
      "accept": ".mp3,.wav,.m4a",
      "maxSize": 10485760
    }
  ],
  "body": {
    "model": "qwen-voice-enrollment",
    "input": {
      "action": "create",
      "target_model": "${model}",
      "preferred_name": "${preferredName}",
      "audio": {
        "data": "${audioDataUri}"
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
<!-- END generated:seed-templates -->
## 十、内置模板清单（seed）

| `tpl_id` | category | 接口槽 | 真实上游实测 |
|---|---|---|---|
| `deepseek-chat` | llm | `sync.submit` | ✅ 2026-09-23 |
| `qwen-image` | image | `sync.submit` + `async.submit` + `async.query` | ✅ 两条路径均通过 |
| `qwen-tts` | tts | `sync.submit` + `clone` | 合成 ✅；复刻未跑（会在账号下建音色资源） |

**实测（2026-09-23）**：异步查询回的产物路径与同步**同一条**（`output.choices[0].message.content[0].image`），文档写的 `output.results[].url` 是这个模型不再用的旧形状；一次 1024×1024 出图排队 52 秒～9 分钟不等，所以查询节奏是实例级参数、默认给到 30 分钟预算。

按用户要求只留这三份。接别家 = 界面「＋ 模板」自己填（引擎里没有任何按厂商名写的分支）；`blankTemplate(category)` 给一份只有地址与密钥的壳。

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
