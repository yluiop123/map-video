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
- **AI 配置只有一个入口**：顶栏 ⚙「设置 · AI」——右侧「实例设置」（几套账号 = 几条实例，含试调用）与左侧「接口模板」（怎么发请求）两处；**代码里没有厂商名分支**，端点、参数、产物路径全是模板数据（`docs/provider-engine.md`）
- **AI 功能只在桌面端**：网页版隐藏 ⚙ 与配音入口
- **导出 MP4 带声音**：字幕逐条生成配音（或导入音频）→ 导出即混流（WebCodecs + AAC）

## 网页 Lite（GH Pages）

- `npm run build` 后把 `dist/` 发到 Pages（仓库名即 `/map-video/` base 路径）
- AI/配音入口自动隐藏；数据存浏览器 IndexedDB，可「导出配置 JSON / 导入」迁移到桌面端

## 数据库设计

> 唯一事实源是 `docs/db-schema-v2.sql`（可直接 `node --experimental-sqlite` 执行验证）；
> 逐表职责与逐列字典见 `docs/db-tables.md`，设计依据见 `docs/db-redesign.md`。本节只给个形状。

### 桌面端（SQLite）

- **引擎**：Electron 内置 `node:sqlite`（`DatabaseSync`），零原生模块、零安装；外键默认开启
- **文件**：`%APPDATA%/map-video/mapvideo.db` —— 单文件库，**拷走即备份**，换机恢复放回同路径即可
- **建表**：`ensureV2Schema()`（幂等 `CREATE TABLE IF NOT EXISTS` + 缺列自动补 + 旧形状启动让位）
- **规模**：27 张表 · 4 个视图 · **0 个触发器** · 704 列

三条贯穿全库的约定：

| 约定 | 意思 |
|---|---|
| **时间一律存秒（REAL）** | 存用户在界面上输入的原值，帧是渲染时按 `default_fps` 派生的量，不入库 |
| **只存输入原值** | 凡能从别处算出来的都不入库（片长、字幕时长…），改帧率时时长语义才不会失真 |
| **不用触发器** | 网页端（IndexedDB）没有触发器，同一条规则两套真相；规则要么在表定义里（外键 / CHECK），要么在应用层 + 自检视图 |

内容侧的归属链是 **项目 ▸ 图层 ▸ 元素**：`project` → 单类型 `layer`（标记 / 路线 / 形状 / 疆域 / 图片）→ 五张按工具聚合的类别宽表（`element_marker` / `_route` / `_shape` / `_territory` / `_image`，表内 `type` 判别子类型）。素材（图片 / GIF / 模型 / 图标 / 音频）统一登记在 `asset` 一张表，桌面端文件落 `userData/media/<类>/`。

AI 配置层四张表，**接一家新供应商不改表、不加代码分支**（模板行就是数据）：

| 表 | 一行是什么 |
|---|---|
| `provider_template` | 一份完整接口模板：六个接口槽（同步 / 异步提交 / 异步查询 / 下载 / 上传 / 克隆）+ 三层参数声明 |
| `provider` | 一条实例：引用哪份模板 + 名字 + 同步异步 + `values_json{instance,requests}`（一份模板可挂多条 = 几套账号） |
| `voice` | 一个克隆音色：唯一键 `(实例, 参考音频哈希, 目标模型)`，参考音频原件存 `asset` |
| `task` | 一条在途异步任务：关窗口、刷新页面、换进程都不丢，重启续跑 |

**访问边界**：SQLite 只在主进程读写（SQL 全在 `electron/db-v2.mjs`，因此可离线用 `node --experimental-sqlite` 回归）；渲染进程经 `window.mapvideo.*` IPC，contextIsolation 开启，摸不到库文件。

### 网页端（GH Pages Lite）

整项目 JSON 存 Dexie（IndexedDB），**没有 V2 的多表与秒约定**，也不含任何 AI 功能（⚙ 设置与配音入口按 `IS_DESKTOP` 隐藏）。

**跨端迁移**：桌面 ⇄ 网页统一走「导出配置 JSON / 导入」（`ProjectExport` 格式，素材以 base64 内嵌，文件自包含）。

## 技术

React 18 · TypeScript 5 · Vite 6 · maplibre-gl 5 · Remotion 4（web-renderer 浏览器端导出）· zustand · Dexie（网页存储）· Electron 44 + node:sqlite（桌面）· electron-builder（打包）
