# 音色表进模板 · 技术方案

> 状态：**四个批次已实施完**（`92efcd2` 形状 / `d62e1bf` 搬表 / `ff4cd6a` ⚙ 接上 / `7bbbac5` 模板页可编辑 + 文档摘要）。结论已并入 `docs/provider-engine.md`（§三 候选值形状 / §八 界面 / §十 实测）与 `AGENTS.md` §5 §7 —— 本文件按计划该删，留着只为让你对着验收；验收完说一声就删。
> 未做（原第七节的「明确不做」之外）：MiniMax 的预置音色表仍缺（要逐字核对官方 + 真发），它现在走「手填音色 ID + 克隆池」那条退化路径。
> 需求三条：① 模板里能配置内置音色，分男声 / 女声；② ⚙ 语音克隆的「提交」那一格里能选内置音色**或**克隆出来的音色；③ 字幕生成的音色区按不同模板显示不同。

## 一、这一改动真正在解决什么

`src/lib/voices.ts:139` 的 `systemVoicesFor(tplId, model)` 是一个 **switch 模板 id**：

```ts
case 'qwen-tts': return model === 'qwen-tts' ? QWEN_TTS_VOICES.filter((v) => v.legacy) : QWEN_TTS_VOICES;
case 'cosyvoice': return COSYVOICE_VOICES;
case 'elevenlabs-voice': return ELEVENLABS_VOICES;
```

这是 §6.24 里被干掉那类「按厂商名分支」的**最后一处**：一家上游有哪些音色是**它的数据**，却写死在代码里。后果就是这三条需求——自定义模板永远拿不到音色表（只能手填 ID）、界面上「按模板显示不同」要靠代码分支、克隆音色与内置音色在两个地方各长一套控件。

所以本方案的**唯一结构性动作**是：把音色表从代码搬成**一条参数声明的候选值**，其余全是它的推论。

## 二、定稿判据

| # | 决定 | 为什么 |
|---|---|---|
| D1 | 音色表 = `voice` 那条参数的 `options` | 「哪个值能填进 `${voice}`」只有一处答案；模板页那张参数表就是编辑入口；自建模板天然能填 |
| D2 | 分组用 `OptionSpec.group?: string`（自由字面量，如 `男声` / `女声` / `中性`） | 不把「性别」这个语义硬编码进通用参数模型；组名即模板里写的字面量，界面按首次出现顺序排 |
| D3 | 谁长成分组选择器的判据 = **`valueType='enum'` 且 options 里有 `group`** | 不认参数名、不认厂商、不加新 `valueType`（上一轮刚删掉没有消费者的 `file` 那一档） |
| D4 | 另加 `OptionSpec.note?: string`（官方风格摘要） | 现在表里有 `note`，不带着它就得丢信息 |
| D5 | 另加 `OptionSpec.models?: string[]`：这条候选值只在同格 `model` 参数取这些值时可用 | 一条字段解决「`-vc` 模型不吃系统音色」这类实测约束；不引入「参数间依赖」那套新机制 |
| D6 | 过滤后为空 → 退化成手填输入框（现有行为） | 接不上表的一家照样能用，且**不猜**音色名 |
| D7 | 选择器两段并列：「内置」按 `group` 分，「克隆」单独一组**不分性别** | `voice` 表没有性别列，也不该在克隆时问用户「这是男是女」——我们不知道 |
| D8 | ⚙ 那一格与字幕生成**复用同一个受控组件**（现在的 `VoicePicker`，改名 `VoiceField`） | 两处填的是同一个名字，两套控件就是两份真相 |
| D9 | 「哪个音色绑哪条模型」收进一处 `voiceModelFor(...)`：该值命中克隆账本 → 用那条的 `target_model`；否则用这一格 `model` 的取值 | 现在这条规则散在 `VoicePicker`（`vcModel` 靠 `options.find(m => m.includes('-vc'))` 猜），搬到 options 上之后 D5 就是它的正式表达 |
| D10 | 选择器里**不放试听按钮** | 试听 = 真发一次合成，⚙ 里那一次的正确入口就是「试调用」（选完点它就能听）；字幕生成里保留现有逐行试听 |
| D11 | 老数据不迁移：字幕里存的 voice 若既不在当前模板的候选值、也不在该实例的克隆账本 → 显示为 orphan + 一行说明，不自动改值 | §8「不为兼容性牺牲设计」；现在的 orphan 显示逻辑已经是这个行为，只补一句原因 |
| D12 | `COSYVOICE_VOICES`（25 条）**删除**，不补 CosyVoice 模板行 | 它没有任何 seed 模板引用（上一代协议遗产），是一张没人查却会骗人的表 |

## 三、数据形状

```ts
export interface OptionSpec {
  value: string | number | boolean;
  label?: string;
  /** 分组名：界面按它分组（组名就是这个字面量，顺序 = 首次出现）；不填 = 一排平铺 */
  group?: string;
  /** 备注（音色表里是官方风格摘要） */
  note?: string;
  /** 只在同格 `model` 参数取这些值时可用（如克隆音色只在 `-vc` 模型上有效） */
  models?: string[];
}
```

seed 里那份 qwen 表变成（38 条，男 19 / 女 19，其中 4 条只属旧模型 `qwen-tts`）：

```ts
const qwenVoices: OptionSpec[] = [
  { value: 'Cherry', label: 'Cherry', group: '女声', note: '中英多语' },
  …
  { value: 'Ethan',  label: 'Ethan',  group: '男声', note: '中英多语', models: ['qwen3-tts-flash'] },
];
// voice 那条参数声明：
p('voice', '音色 ID', { valueType: 'enum', options: qwenVoices, defaultValue: 'Ethan' }),
```

ElevenLabs 21 条（男 13 / 女 7 / 中性 1）同法进 `elevenlabs-voice` 那份模板。`minimax-voice` **先不挂表**：预置音色名没逐字核对过上游，按 D6 走手填（要补就是另一次官网核对 + 真发，见第七节）。

**没有 DDL 改动**：`options` 本来就住在各槽 JSON 里。要改的是 `tools/db-field-notes.mjs` 里那句字段说明（提到候选值可带 `group` / `note` / `models`）→ 重跑生成链。

## 四、改动点（已实施）

| 文件 | 做什么 |
|---|---|
| `src/lib/request-engine.ts` | `OptionSpec` 加三个可选字段（D2/D4/D5）；新增 `visibleOptions(tpl, inst, key, callArgs?)` —— 按这一格 `model` 的**求值后取值**过滤 `models`，一处判据；`validateTemplate` 加一条：**enum 参数的默认值必须在候选值里**（对所有 enum，不只音色） |
| `src/lib/voices.ts` | 删 `SystemVoice` / `VoiceGender` / 三张表 / `systemVoicesFor`；**留** `CLIP_PRESETS` 与 `fetchClipBytes`（那是随包发布的克隆素材，不是上游数据） |
| `src/components/VoicePicker.tsx` | 改名 `VoiceField.tsx`：内置那半段改读 `visibleOptions(...)`（按 `group` 分组、`note` 进 title），克隆那半段不变（读 `voiceStore`）；`onPick(voiceId, voiceModel)` 的第二个参数改由 D9 的 `voiceModelFor` 给，不再 `find(m => m.includes('-vc'))` |
| `src/components/ProviderPanel.tsx` | `ParamControl` 遇到「enum 且 options 带 group」→ 渲染 `VoiceField`（把 `inst` 传进去，克隆段要它）；于是 ⚙ 里选的就是「这条实例钉的默认音色」，写回 `values.requests['sync.submit'].voice` |
| `src/components/TemplatesPane.tsx` | 参数表的「候选值」那一格从纯文本升级成可行编辑器（一行一条：值 / 显示名 / 分组 / 备注 / 适用模型）—— 否则表进了模板却没法在界面上改，等于换了个地方写死 |
| `src/lib/template-seed.ts` | 两份 tts 模板的 `voice` 参数挂上 options；`p()` 辅助要支持 enum+options（已有 `en()`，但 `en()` 只收字符串数组 → 加一个收 `OptionSpec[]` 的写法） |
| `tools/gen-template-json-doc.mjs` | §九 参数总表里音色这种大表**只写摘要**（`音色 38 条（男 19 / 女 19）`），逐列 JSON 保留全量（照抄仍可用，页面不炸） |
| `docs/provider-engine.md` / `AGENTS.md` | §三 参数形状、§八 两页界面、§6.29 判据段各补一条；`AGENTS.md` §4 里 `voices.ts` 那行改成「克隆样本清单」 |

## 五、实施批次（一批一 commit，每批跑完再进下一批）

1. **形状**：`OptionSpec` 三字段 + `visibleOptions` + 默认值那条自检 + 回归与文档链。验收：`verify-request-engine` 新增「带 `models` 的候选值按当前 model 过滤」「enum 默认值不在候选值里被点名」。
2. **搬表**：一次性脚本把 `lib/voices.ts` 的 qwen / elevenlabs 两张表转成 `OptionSpec[]` 字面量贴进 seed（**不手抄**），删 `systemVoicesFor` 与 cosyvoice 表，`VoiceField` 改读模板。验收：`verify-provider-templates` 模板行逐字往返仍等值；⚙ 与字幕生成两处的音色列表与改造前**逐条一致**（拿 qwen 与 ElevenLabs 各比一次）。
3. **⚙ 那一格接上**：`ParamControl` 的音色分支 + `voiceModelFor` 收口。验收：在应用里给千问配音实例钉一个内置音色 → 试调用出音频；选一个克隆音色 → 那次调用带 `-vc` 模型（回显的响应原文里能看见 model 字段）。
4. **模板页能编辑表**：候选值行编辑器 + §九 摘要。验收：新建一份模板、自己填三条音色、界面分组显示、`--check` 绿。

每批都跑：`npx tsc -b` · `npm run build` · 六条离线回归 · `gen-template-json-doc --check` · `gen-template-init-sql --check`，并在跑着的桌面端里看一屏。

## 六、验收口径（怎么算成）

* 内置音色：qwen 38 条 / ElevenLabs 21 条，**分组与条数与改造前一致**，名字逐字未变（表是搬过去的，不是重打的）。→ **已达成**：回归 2.22 / 2.23 是搬表快照（38 = 男 19 / 女 19；21 = 男 13 / 女 7 / 中性 1），应用里 ⚙ 与字幕生成两处的组标题都显示当前选中的名字。
* 克隆音色：⚙ 与字幕生成两处都能看到同一条实例的克隆池，选它即用它自己的 `target_model`（不再靠 `-vc` 猜）。→ **已达成**（`cloneTargetModel` 读克隆那一格声明的 `model`）。
* 自定义模板：没填候选值 → 手填框，行为不变；勾上「音色表」那一枚开关就用同一套控件。→ **已达成**。
* 真发：至少一条内置音色 + 一条克隆音色在 ⚙ 的试调用里各出一次音频（会花配额，跑前招呼）。→ **未跑**，等你一句话。

## 七、明确不做

* 不给 `voice` 参数名做任何硬编码约定（判据只看形状，D3）。
* 不在选择器里加试听按钮（D10），也不给 `OptionSpec` 加「试听样本路径」这一格 —— 没有消费者的格子。
* 不迁移老字幕数据（D11）。
* 不补 CosyVoice 模板行（D12）。
* MiniMax 的预置音色表**暂缓**：需要逐字核对官方 + 真发验证，等账号有余额时单独做一批。

## 八、附带发现（与本方案无关，先记一笔）

`src/lib/providers.ts:242` 的 `callImage` 还在读 `r.values.url ?? r.values.image` —— 这正是 §6.29 里说过「只允许 `artifact` 一个名字」的那串多份真相的残留。要不要顺手收掉，等你一句话。
