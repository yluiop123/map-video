/**
 * MapVideo 桌面端主进程：
 * - app:// 自定义协议托管 dist（规避 file:// 的 worker/模块限制）
 * - node:sqlite 内嵌数据库（projects + providers，库文件在 userData）
 * - AI/TTS 管道：渲染进程无 CORS，主进程持配置转发厂商（协议实现与 web 服务端同源）
 */
import { app, BrowserWindow, ipcMain, protocol, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ensureV2Schema, migrateLegacyProjects, saveProjectV2, getProjectV2, listProjectsV2, removeProjectV2 } from './db-v2.mjs';

const DIST = path.join(app.getAppPath(), 'dist');

// ---------- SQLite ----------
let db;
function initDb() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, 'mapvideo.db'));
  // 应用配置（providers / 本地 Key）。项目、合集、素材走 V2 关系表（见 db-v2.mjs）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT DEFAULT '',
      base_url TEXT DEFAULT '',
      api_key TEXT DEFAULT '',
      model TEXT DEFAULT '',
      protocol TEXT DEFAULT '',
      voice TEXT DEFAULT '',
      speed REAL DEFAULT 1,
      extra TEXT DEFAULT '',
      active INTEGER DEFAULT 0,
      sort INTEGER DEFAULT 0
    );
  `);
  const now = Date.now();

  // V2 关系型表（15 表 / 3 视图）+ 旧 JSON 项目一次性迁移
  if (ensureV2Schema(db)) {
    try {
      db.prepare("INSERT OR IGNORE INTO collection (collection_id, name, ord, created_at, updated_at) VALUES ('default','默认合集',-1,?,?)").run(now, now);
    } catch { /* 忽略 */ }
    migrateLegacyProjects(db);
  }
}

// ---------- AI / TTS（协议实现，与 web 服务端同源） ----------
function chatUrlOf(baseUrl) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  return /chatcompletion|chat\/completions/i.test(b) ? b : `${b}/chat/completions`;
}

async function forwardChat(cfg, system, user) {
  let extra = {};
  if (cfg.extra) { try { extra = JSON.parse(cfg.extra); } catch { /* ignore */ } }
  const res = await fetch(chatUrlOf(cfg.baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.7,
      ...extra,
    }),
  });
  if (!res.ok) throw new Error(`上游 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('上游响应无 choices[0].message.content');
  return content;
}

/** 文生图（通义万相 / 兼容接口）：返回图片 URL。参照 createVideo/scripts。 */
async function generateImage(cfg, prompt) {
  const url = `${String(cfg.baseUrl || '').replace(/\/+$/, '')}/services/aigc/multimodal-generation/generation`;
  const body = {
    model: cfg.model || 'z-image-turbo',
    input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
    parameters: { prompt_extend: false, size: '2048*1152' },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`上游 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const img = data?.output?.choices?.[0]?.message?.content?.[0]?.image;
  if (typeof img !== 'string') throw new Error('上游响应无 image 字段');
  return img;
}

/** CosyVoice 声音克隆：转发 customization（body 由渲染端组装，含参考音频 dataURI）。参照 clone_qwen_voice.py。 */
async function voiceClone(cfg, body) {
  const url = `${String(cfg.baseUrl || '').replace(/\/+$/, '')}/services/audio/tts/customization`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`上游 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const voice = data?.output?.voice_id || data?.output?.voice;
  if (typeof voice !== 'string') throw new Error('上游响应无 voice_id');
  return voice;
}

async function synthAudio(cfg, text) {
  const speed = cfg.speed ?? 1;
  let headers = { 'Content-Type': 'application/json' };
  let body;
  let url = String(cfg.baseUrl || '').replace(/\/+$/, '');
  switch (cfg.protocol) {
    case 'minimax-t2a': {
      if (cfg.apiKey?.includes('&&')) {
        const [key, group] = cfg.apiKey.split('&&');
        headers.Authorization = `Bearer ${key}`;
        url += `?group_id=${group}`;
      } else {
        headers.Authorization = `Bearer ${cfg.apiKey}`;
      }
      body = { model: cfg.model, text, voice_setting: { voice_id: cfg.voice, speed, vol: 1, format: 'mp3' }, audio_setting: { format: 'mp3' } };
      break;
    }
    case 'volc-tts': {
      const [appid, token] = String(cfg.apiKey || '').split('|');
      headers['X-Api-App-Key'] = appid || '';
      headers['X-Api-Access-Key'] = token || '';
      headers['X-Api-Resource-Id'] = 'volc.service_type.10029';
      body = {
        user: { uid: 'mapvideo' },
        audio: { voice_type: cfg.voice, encoding: 'mp3', speed_ratio: speed },
        request: { reqid: `mv-${Date.now()}`, text, operation: 'query' },
      };
      break;
    }
    case 'qwen-tts': {
      // 通义 CosyVoice（参照 createVideo/scripts）：POST /services/audio/tts/SpeechSynthesizer
      headers.Authorization = `Bearer ${cfg.apiKey}`;
      body = {
        model: cfg.model || 'cosyvoice-v3.5-flash',
        input: { text, voice: cfg.voice },
        parameters: { format: 'mp3', sample_rate: 24000 },
      };
      url += '/services/audio/tts/SpeechSynthesizer';
      break;
    }
    case 'openai-speech': {
      headers.Authorization = `Bearer ${cfg.apiKey}`;
      body = { model: cfg.model, voice: cfg.voice, input: text, speed, response_format: 'mp3' };
      url += '/audio/speech';
      break;
    }
    default: {
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      body = { text, voice: cfg.voice, speed, model: cfg.model };
    }
  }
  let extra = {};
  if (cfg.extra) { try { extra = JSON.parse(cfg.extra); } catch { /* ignore */ } }
  body = { ...body, ...extra };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`上游 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const ctype = res.headers.get('content-type') || '';
  if (ctype.startsWith('audio/')) return { bytes: new Uint8Array(await res.arrayBuffer()), mime: ctype };

  const data = await res.json().catch(() => null);
  if (!data) throw new Error('上游响应既不是音频也不是 JSON');
  const b64 = data?.data?.audio || data?.audio?.data || data?.data || data?.audio || data?.output?.audio?.data;
  const audioUrl = data?.output?.audio?.url || data?.audio_url || data?.url;
  if (typeof b64 === 'string' && b64.length > 100 && !/^https?:/i.test(b64)) {
    return { bytes: Uint8Array.from(Buffer.from(b64, 'base64')), mime: /wav/i.test(ctype) ? 'audio/wav' : 'audio/mpeg' };
  }
  if (typeof audioUrl === 'string') {
    const r2 = await fetch(audioUrl);
    return { bytes: new Uint8Array(await r2.arrayBuffer()), mime: r2.headers.get('content-type') || 'audio/mpeg' };
  }
  if (typeof data?.hex === 'string') {
    return { bytes: Uint8Array.from(Buffer.from(data.hex, 'hex')), mime: 'audio/mpeg' };
  }
  throw new Error('无法从上游响应提取音频（检查协议/extra 参数）');
}

// ---------- IPC ----------
function registerIpc() {
  // 项目：V2 多表读写（项目 = 单条连续时间线；旧 JSON 表已废弃）
  ipcMain.handle('db:projects:list', () => listProjectsV2(db));
  ipcMain.handle('db:projects:get', (_e, id) => getProjectV2(db, id));
  ipcMain.handle('db:projects:save', (_e, { id, data }) => {
    // 入参校验：渲染进程的数据一律不可信，缺失时给出明确错误
    if (typeof id !== 'string' || !id) throw new Error('projects.save: id 无效');
    if (!data || typeof data !== 'object') throw new Error('projects.save: data 无效');
    saveProjectV2(db, data);
    return { id };
  });
  ipcMain.handle('db:projects:remove', (_e, id) => {
    removeProjectV2(db, id);
    return { ok: true };
  });

  // 合集（项目之上的一层分组）
  ipcMain.handle('db:collections:list', () => {
    return db.prepare('SELECT collection_id AS id, name, ord AS "order", created_at AS createdAt, updated_at AS updatedAt FROM collection ORDER BY ord ASC, updated_at DESC').all();
  });
  ipcMain.handle('db:collections:save', (_e, { id, name, order }) => {
    const now = Date.now();
    db.prepare(`
      INSERT INTO collection (collection_id, name, ord, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(collection_id) DO UPDATE SET name = excluded.name, ord = excluded.ord, updated_at = excluded.updated_at
    `).run(id, name || '未命名合集', order ?? 0, now, now);
    return { id };
  });
  ipcMain.handle('db:collections:remove', (_e, id) => {
    if (id === 'default') return { ok: false, reason: 'default-immutable' };
    db.prepare("UPDATE project SET collection_id = 'default' WHERE collection_id = ?").run(id);
    db.prepare('DELETE FROM collection WHERE collection_id = ?').run(id);
    return { ok: true };
  });

  // 清空项目数据：项目 + 合集 + 素材文件（**保留**应用配置 providers）
  ipcMain.handle('db:clearAll', () => {
    try { db.exec('DELETE FROM project; DELETE FROM collection;'); } catch { /* V2 可能未建表 */ }
    try {
      const root = mediaRoot();
      for (const f of fs.readdirSync(root)) {
        const p = path.join(root, f);
        if (f === 'index.json') { fs.writeFileSync(p, '{}'); continue; }
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch { /* 目录不存在时忽略 */ }
    const now = Date.now();
    db.prepare(`
      INSERT OR IGNORE INTO collection (collection_id, name, ord, created_at, updated_at)
      VALUES ('default', '默认合集', -1, ?, ?)
    `).run(now, now);
    return { ok: true };
  });

  // Providers（Key 存本地库）
  const rowToCfg = (r) => ({
    id: r.id, kind: r.kind, label: r.label, baseUrl: r.base_url, apiKey: r.api_key,
    model: r.model, protocol: r.protocol || undefined, voice: r.voice || undefined,
    speed: r.speed ?? 1, extra: r.extra || undefined, active: r.active === 1,
  });
  ipcMain.handle('db:providers:list', () => {
    return db.prepare('SELECT * FROM providers ORDER BY sort, kind, label').all().map(rowToCfg);
  });
  ipcMain.handle('db:providers:upsert', (_e, cfg) => {
    db.prepare(`
      INSERT INTO providers (id, kind, label, base_url, api_key, model, protocol, voice, speed, extra, sort)
      VALUES (@id, @kind, @label, @baseUrl, @apiKey, @model, @protocol, @voice, @speed, @extra,
              COALESCE((SELECT sort FROM providers WHERE id = @id), (SELECT COALESCE(MAX(sort), 0) + 1 FROM providers)))
      ON CONFLICT(id) DO UPDATE SET kind=@kind, label=@label, base_url=@baseUrl, api_key=@apiKey, model=@model,
        protocol=@protocol, voice=@voice, speed=@speed, extra=@extra
    `).run({
      id: String(cfg.id), kind: cfg.kind, label: cfg.label || '', baseUrl: cfg.baseUrl || '',
      apiKey: cfg.apiKey || '', model: cfg.model || '', protocol: cfg.protocol || '',
      voice: cfg.voice || '', speed: cfg.speed ?? 1, extra: cfg.extra || '',
    });
    return { ok: true };
  });
  ipcMain.handle('db:providers:remove', (_e, id) => {
    db.prepare('DELETE FROM providers WHERE id = ?').run(id);
    return { ok: true };
  });
  ipcMain.handle('db:providers:setActive', (_e, { kind, id }) => {
    db.prepare('UPDATE providers SET active = 0 WHERE kind = ?').run(kind);
    if (id) db.prepare('UPDATE providers SET active = 1 WHERE id = ? AND kind = ?').run(id, kind);
    return { ok: true };
  });

  // AI 管道
  ipcMain.handle('ai:chat', async (_e, { config, system, user }) => {
    try {
      return { content: await forwardChat(config, system, user) };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  });
  ipcMain.handle('ai:tts', async (_e, { config, text }) => {
    try {
      const { bytes, mime } = await synthAudio(config, String(text || '').slice(0, 5000));
      return { bytes, mime };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  });
  ipcMain.handle('ai:image', async (_e, { config, prompt }) => {
    try {
      return { image: await generateImage(config, String(prompt || '').slice(0, 2000)) };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  });
  ipcMain.handle('ai:voiceClone', async (_e, { config, body }) => {
    try {
      return { voiceId: await voiceClone(config, body) };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  });

  // 通用网络：主进程代拉 JSON/GeoJSON 文本（渲染进程直连会被 CORS 拦）
  ipcMain.handle('net:json', async (_e, url) => {
    try {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('invalid url');
      const res = await fetch(url, { headers: { Accept: 'application/json,application/geo+json,*/*' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { text: await res.text() };
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  });

  ipcMain.handle('env:get', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    userData: app.getPath('userData'),
  }));

  // 素材（asset）：**用户级全局资源**（跨项目可用），按**类型分子目录、时间戳命名**（保留原格式扩展名）：
  //   userData/media/<images|models|audio|video|fonts>/<YYYYMMDD-HHmmss>-<assetId><ext>
  // assetId 是**随机 id**（与文件名解耦，改名不影响引用）；assetId → 文件的映射存在 media/index.json。
  // 不再做 sha256 内容寻址去重 —— 同一文件上传两次就是两份（时间戳命名永不重名）。
  const EXT_BY_MIME = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'model/gltf-binary': '.glb', 'model/gltf+json': '.gltf', 'model/obj': '.obj',
    'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'video/mp4': '.mp4',
  };
  const mediaRoot = () => {
    const dir = path.join(app.getPath('userData'), 'media');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  // 类别 → 子目录：与前端 AssetKind 一一对应（图片/动图/模型/图标分开存放）
  const KIND_DIR = { image: 'images', gif: 'gifs', model: 'models', icon: 'icons', audio: 'audio', video: 'video', font: 'fonts' };
  const kindDirOf = (kind, mime) =>
    KIND_DIR[kind] ||
    (mime.startsWith('image/') ? 'images'
      : mime.startsWith('model/') ? 'models'
        : mime.startsWith('audio/') ? 'audio'
          : mime.startsWith('video/') ? 'video'
            : mime.startsWith('font') ? 'fonts' : 'misc');

  const indexFile = () => path.join(mediaRoot(), 'index.json');
  const readIndex = () => {
    try { return JSON.parse(fs.readFileSync(indexFile(), 'utf8')); } catch { return {}; }
  };
  const writeIndex = (idx) => fs.writeFileSync(indexFile(), JSON.stringify(idx, null, 2));

  ipcMain.handle('assets:save', (_e, { mime, bytes, name, kind }) => {
    const buf = Buffer.from(bytes);
    const assetId = 'a' + crypto.randomBytes(8).toString('hex');
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
    const dir = path.join(mediaRoot(), kindDirOf(String(kind || ''), String(mime || '')));
    fs.mkdirSync(dir, { recursive: true });
    const fileName = `${stamp}-${assetId}${EXT_BY_MIME[mime] || ''}`;
    fs.writeFileSync(path.join(dir, fileName), buf);
    const rel = path.relative(mediaRoot(), path.join(dir, fileName)).replace(/\\/g, '/');
    const idx = readIndex();
    idx[assetId] = { rel, mime, byteSize: buf.length, name: String(name || '') };
    writeIndex(idx);
    return { assetId, relPath: rel, byteSize: buf.length };
  });
  ipcMain.handle('assets:read', (_e, assetId) => {
    const meta = readIndex()[String(assetId || '')];
    if (!meta) return null;
    const abs = path.join(mediaRoot(), meta.rel);
    if (!fs.existsSync(abs)) return null;
    return { bytes: new Uint8Array(fs.readFileSync(abs)), mime: meta.mime, name: meta.name };
  });
  ipcMain.handle('assets:remove', (_e, assetId) => {
    const idx = readIndex();
    const meta = idx[String(assetId || '')];
    if (meta) {
      const abs = path.join(mediaRoot(), meta.rel);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
      delete idx[String(assetId)];
      writeIndex(idx);
    }
    return { ok: true };
  });
  ipcMain.handle('assets:exists', (_e, assetId) => !!readIndex()[String(assetId || '')]);
  /** 全局素材库列表（可选 mime 类型前缀过滤，供面板浏览选择） */
  ipcMain.handle('assets:list', (_e, kindPrefix) => {
    const idx = readIndex();
    const out = Object.entries(idx).map(([assetId, m]) => ({ assetId, name: m.name || '', mime: m.mime || '' }));
    return kindPrefix ? out.filter((m) => m.mime.startsWith(String(kindPrefix))) : out;
  });
  /** 孤儿素材扫描：递归统计文件数与总字节数（供设置页/维护用） */
  ipcMain.handle('assets:stat', () => {
    const root = mediaRoot();
    let count = 0;
    let bytes = 0;
    const walk = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name !== 'index.json') { count++; bytes += fs.statSync(p).size; }
      }
    };
    walk(root);
    return { count, bytes, dir: root };
  });

  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
}

// ---------- app:// 协议托管 dist ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.map': 'application/json', '.geojson': 'application/geo+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

function setupProtocol() {
  protocol.handle('app', async (request) => {
    const u = new URL(request.url);
    let p = decodeURIComponent(u.pathname);
    if (p.endsWith('/')) p += 'index.html';
    if (p === '' || p === '/') p = '/index.html';
    const safe = path.normalize(p).replace(/^([/\\])+/, '');
    if (safe.startsWith('..')) return new Response('Not Found', { status: 404 });
    const file = path.join(DIST, safe);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      // 无扩展名 → SPA 回退
      if (!path.extname(safe)) {
        const index = path.join(DIST, 'index.html');
        if (fs.existsSync(index)) return new Response(fs.readFileSync(index), { headers: { 'Content-Type': MIME['.html'] } });
      }
      return new Response('Not Found', { status: 404 });
    }
    const buf = fs.readFileSync(file);
    return new Response(buf, { headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
  });
}

// ---------- 窗口 ----------
function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0c0a09',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 开发模式：vite 热更（scripts/dev-desktop.mjs 注入）；否则 app:// 托管 dist
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadURL('app://bundle/index.html');
}

app.whenReady().then(() => {
  try {
    initDb();
  } catch (e) {
    console.error('[mapvideo] node:sqlite 初始化失败:', e?.message);
  }
  setupProtocol();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
