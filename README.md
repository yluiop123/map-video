# MapVideo

基于 Remotion + MapLibre GL 的「地图视频」编辑器：用军事态势符号、路线动画、区域高亮、相机关键帧、弹出元素制作地图讲解视频（一个项目 = 一条连续时间线），浏览器/桌面端内直接导出 MP4（含配音/背景音乐混流）。

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
┌ 渲染进程（与网页版同一套前端）───┐       ┌ 主进程 electron/main.mjs ──────
│  window.mapvideo.* (preload)  │◀─IPC─▶│ • node:sqlite：SQL 全在 db-v2.mjs │
│  stores/* 写穿库               │       │ • httpRequest 代理（绕 CORS）      │
│  lib/request-engine.ts 求值模板 │       │ • app:// 协议托管 dist + media     │
└──────────────────────────────┘       └─────────────────────────────────┘
```

- **数据位置**：`%APPDATA%/map-video/mapvideo.db`（项目 + AI 配置含 Key 都在本机），素材文件在 `userData/media/`
- **AI 配置只有一个入口**：顶栏 ⚙「设置 · AI」（右侧实例设置 / 左侧接口模板），**代码里没有厂商名分支**（`docs/provider-engine.md`）
- **AI 功能只在桌面端**：网页版隐藏 ⚙ 与配音入口
- **导出 MP4 带声音**：字幕逐条生成配音（或导入音频）→ 导出即混流（WebCodecs + AAC）

## 网页 Lite（GH Pages）

- `npm run build` 后把 `dist/` 发到 Pages（仓库名即 `/map-video/` base 路径）
- AI/配音入口自动隐藏；数据存浏览器 IndexedDB，可「导出配置 JSON / 导入」迁移到桌面端

## 数据库设计

> 这一节只讲「数据放在哪、谁能碰它」；结构本身不在 README 里复述，免得漂 ——
> DDL 事实源 = `docs/db-schema-v2.sql`（可直接 `node --experimental-sqlite` 执行验证）·
> 表与逐列字典 = `docs/db-tables.md`（生成，**规模数字以它顶部那一行为准**）·
> 为什么这么设计 = `docs/db-redesign.md` · 配置层四层 = `docs/provider-engine.md` ·
> 改字段时的同步清单 = `AGENTS.md` §10。

### 桌面端（SQLite）

- **引擎**：Electron 内置 `node:sqlite`（`DatabaseSync`），零原生模块、零安装；外键默认开启
- **文件**：`%APPDATA%/map-video/mapvideo.db` —— 单文件库，**拷走即备份**，换机恢复放回同路径即可；素材文件在 `userData/media/<类>/`
- **建表**：`ensureV2Schema()`（幂等建表 + 缺列补 + 旧形状启动时让位）
- **访问边界**：SQL 只在主进程读写（全在 `electron/db-v2.mjs`，因此能离线回归）；渲染进程经 `window.mapvideo.*` IPC，contextIsolation 开启，摸不到库文件
- **两条贯穿全库的取舍**（细则见 AGENTS §10）：**时间存秒、帧是派生量**；**不使用触发器**（网页端 IndexedDB 没有触发器，同一条规则不能有两套真相）
- **内容侧归属链是 项目 ▸ 图层 ▸ 元素**：单类型图层（标记 / 路线 / 形状 / 疆域 / 图片）之下是五张按工具聚合的类别宽表，素材统一登记在 `asset` 一张表
- **AI 配置四张表**：模板（怎么发请求）· 实例（哪套账号）· 克隆音色账本 · 在途任务。**接一家新供应商不改表、不加代码分支** —— 端点、参数、该有哪几格接口、产物怎么取回，全是模板里的数据

### 网页端（GH Pages Lite）

整项目 JSON 存 Dexie（IndexedDB），**没有 V2 的多表与秒约定**，也不含任何 AI 功能（⚙ 与配音入口按 `IS_DESKTOP` 隐藏）。

**跨端迁移**：桌面 ⇄ 网页统一走「导出配置 JSON / 导入」（`ProjectExport` 格式，素材以 base64 内嵌，文件自包含）。

## 技术

React 18 · TypeScript 5 · Vite 6 · maplibre-gl 5 · Remotion 4（web-renderer 浏览器端导出）· zustand · Dexie（网页存储）· Electron 44 + node:sqlite（桌面）· electron-builder（打包）
