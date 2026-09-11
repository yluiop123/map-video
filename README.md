# MapVideo

基于 Remotion + MapLibre GL 的「地图视频」编辑器：用军事态势符号、路线动画、区域高亮、相机关键帧、弹出元素制作分章节的地图讲解视频，浏览器/桌面端内直接导出 MP4（含配音/背景音乐混流）。

**同一份前端代码，两种形态**：

| 形态 | AI/配音 | 存储 | 运行 |
|---|---|---|---|
| **桌面端**（Electron） | ✅ 走主进程（无 CORS） | SQLite（本机库） | `dist:win` 打包 / `electron` 直启 |
| **网页 Lite**（GH Pages） | ❌ 入口自动隐藏 | IndexedDB + JSON 导入导出 | 静态托管 `dist/` |

## 环境依赖

| 依赖 | 要求 | 说明 |
|---|---|---|
| **Node.js** | ≥ 20（推荐 22 LTS） | 构建 + 打包 |
| **Electron** | 44（随 devDependencies 安装） | 首次 `npm i` 自动下载二进制；慢/失败时设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` |
| 数据库 | **无需安装** | 主进程用内置 `node:sqlite`，零原生模块 |
| 浏览器 | Chrome/Edge 最新 | 仅网页开发调试用 |

## 常用命令

```bash
npm install            # 首次安装

npm run dev            # 网页开发（5173 热更，Lite/本地调试形态）
npm run build          # GH Pages 产物（base=/map-video/）→ 发布 dist/
npm run build:desktop  # 桌面产物（相对路径）→ dist/

npm run electron       # 以当前 dist/ 启动桌面端（需先 build:desktop）
npm run electron:dev   # 桌面开发：vite 热更 + Electron 窗口（一条命令）
npm run dist:win       # 打 Windows 安装包/portable exe → release/
```

> 注意：`dist/` 是两个形态共用的产物目录——发布 GH Pages 用 `npm run build`，跑/打包桌面用 `npm run build:desktop`，切换时重新构建即可。

## 打包产物（`release/`）

`npm run dist:win` 的输出目录；`build.win.target = ["nsis", "portable"]`，因此会产出**两种分发形态**：

| 文件 | 大小 | 用途 |
|---|---|---|
| `MapVideo Setup <版本>.exe` | ~157 MB | **安装版（NSIS）**：安装向导、可自选安装目录、自动创建快捷方式 → **对外分发用这个** |
| `MapVideo <版本>.exe` | ~157 MB | **便携版（Portable）**：免安装，双击即跑；功能与安装版完全相同 |
| `MapVideo Setup <版本>.exe.blockmap` | ~0.2 MB | 差分更新的块映射表（electron-updater 升级时只下改动部分） |
| `latest.yml` | — | electron-updater 更新元数据（版本号 / 校验和 / 下载地址） |
| `builder-debug.yml` | — | electron-builder 调试清单，非必需 |
| `win-unpacked/` | — | **中间产物**：未压缩的程序目录（真正的程序是里面的 `MapVideo.exe` + `resources/`），上面两个 exe 由它压缩而来 |

- 整个目录都是**产物、不入库**（`.gitignore` 已忽略），可整目录删除后重新打包
- 只需留存一份给用户时：删掉 `win-unpacked/`、`builder-debug.yml` 与两个形态中的一个即可
- 已知体积浪费：`win-unpacked/resources/app.asar.unpacked/node_modules/@esbuild/*/esbuild.exe`（~11 MB）是 `@remotion/bundler` 依赖链带进来的**构建期**二进制，运行不需要

## 桌面端架构

```
┌ 渲染进程（现有前端，零改动复用）─┐       ┌ 主进程 electron/main.mjs ─┐
│  window.mapvideo.* (preload)  │◀─IPC─▶│ • node:sqlite: projects/providers │
│  providerStore → 写穿 SQLite   │       │ • AI/TTS 管道（协议转发，无 CORS） │
│  callLLM/callTTS → IPC 通道    │       │ • app:// 协议托管 dist            │
└──────────────────────────────┘       └──────────────────────────┘
```

- **数据位置**：`%APPDATA%/map-video/mapvideo.db`（项目 + AI/配音配置含 Key，均在本机）
- **AI 配置**：特效弹窗「字幕」页签 → 配音服务设置；内置 千问/MiMo/MiniMax/豆包/DeepSeek/GLM/Kimi/GPT 预设，可自定义扩展；四种 TTS 协议（OpenAI speech / MiniMax / 火山 / CosyVoice / custom）
- **导出 MP4 带声音**：字幕逐条生成配音（或导入音频）→ 导出即混流（WebCodecs + AAC）

## 网页 Lite（GH Pages）

- `npm run build` 后把 `dist/` 发到 Pages（仓库名即 `/map-video/` base 路径）
- AI/配音入口自动隐藏；数据存浏览器 IndexedDB，可「导出配置 JSON / 导入」迁移到桌面端

## 数据库设计

### 桌面端（SQLite）

- **引擎**：Electron 内置 `node:sqlite`（DatabaseSync），零原生模块、零安装
- **文件**：`%APPDATA%/map-video/mapvideo.db`——单文件库，**拷走即备份**，换机恢复放回同路径即可
- **建表**：`electron/main.mjs → initDb()`（幂等 `CREATE TABLE IF NOT EXISTS`，升级时按列补齐）

**projects 表（项目库）**

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PRIMARY KEY | 项目 ID |
| name | TEXT NOT NULL | 项目名 |
| data | TEXT NOT NULL | 完整项目 JSON（章节/元素/镜头/特效/字幕/音乐/底图/自定义符号全部内嵌其中） |
| size | INTEGER | JSON 字节数 |
| updated_at | INTEGER | 保存时间（epoch ms），列表按此倒序 |

**providers 表（AI/配音配置，Key 存本机不出库）**

| 列 | 类型 | 说明 |
|---|---|---|
| id | TEXT PRIMARY KEY | 配置 ID（预设复制或自定义） |
| kind | TEXT | `llm` \| `tts` |
| label / base_url / api_key / model | TEXT | 厂商连接信息 |
| protocol | TEXT | TTS 协议：`openai-speech` / `minimax-t2a` / `volc-tts` / `qwen-tts` / `custom`；LLM 统一 OpenAI 兼容 chat/completions |
| voice | TEXT | 音色/说话人 ID |
| speed | REAL | 语速 0.5–2 |
| extra | TEXT | 附加 JSON 参数（合并进请求体） |
| active | INTEGER | 生效标记（每 kind 仅一条 =1） |
| sort | INTEGER | 列表排序 |

**访问边界**：SQLite 仅主进程读写；渲染进程通过 `window.mapvideo.projects / providers` IPC CRUD（contextIsolation 开启，渲染进程摸不到库文件）。

### 网页端（GH Pages Lite）

| 介质 | 内容 |
|---|---|
| IndexedDB `MapVideoDB`（Dexie v1，表 projects：`id, name, createdAt, updatedAt`） | 完整项目 JSON（结构同桌面端 data 列） |
| localStorage `mapvideo-providers` | AI/配音配置（仅本地开发直连模式用，GH Pages 不展示入口） |

**跨端迁移**：桌面 ⇄ 网页统一走「导出配置 JSON / 导入」（`ProjectExport` 格式，两端数据结构相同）。

## 技术

React 18 · TypeScript 5 · Vite 6 · maplibre-gl 5 · Remotion 4（web-renderer 浏览器端导出）· zustand · Dexie（网页存储）· Electron 44 + node:sqlite（桌面）· electron-builder（打包）
