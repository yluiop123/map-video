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

## 技术

React 18 · TypeScript 5 · Vite 6 · maplibre-gl 5 · Remotion 4（web-renderer 浏览器端导出）· zustand · Dexie（网页存储）· Electron 44 + node:sqlite（桌面）· electron-builder（打包）
