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

const DIST = path.join(app.getAppPath(), 'dist');

// ---------- SQLite ----------
let db;
function initDb() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, 'mapvideo.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      size INTEGER DEFAULT 0,
      updated_at INTEGER
    );
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
      headers.Authorization = `Bearer ${cfg.apiKey}`;
      body = { model: cfg.model, input: { text, voice: cfg.voice }, parameters: { rate: speed } };
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
  // 项目
  ipcMain.handle('db:projects:list', () => {
    return db.prepare('SELECT id, name, updated_at AS updatedAt, size FROM projects ORDER BY updated_at DESC').all();
  });
  ipcMain.handle('db:projects:get', (_e, id) => {
    const row = db.prepare('SELECT data FROM projects WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  });
  ipcMain.handle('db:projects:save', (_e, { id, name, data }) => {
    const json = JSON.stringify(data);
    db.prepare(`
      INSERT INTO projects (id, name, data, size, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data, size = excluded.size, updated_at = excluded.updated_at
    `).run(id, name || '未命名', json, json.length, Date.now());
    return { id };
  });
  ipcMain.handle('db:projects:remove', (_e, id) => {
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
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

  ipcMain.handle('env:get', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    userData: app.getPath('userData'),
  }));

  // 素材（asset）：图片 / GIF / 模型等大文件外置到 userData/assets/<sha256><ext>
  // 项目 JSON 里只存 asset_id(=sha256)，彻底避免 base64 内联撑爆存档。
  const EXT_BY_MIME = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'model/gltf-binary': '.glb', 'model/gltf+json': '.gltf', 'model/obj': '.obj',
    'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'video/mp4': '.mp4',
  };
  const assetsDir = () => {
    const dir = path.join(app.getPath('userData'), 'assets');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  /** 把 assetId 收敛成目录内的安全文件名（防目录穿越） */
  const assetPath = (assetId) => {
    const id = path.basename(String(assetId || ''));
    const dir = assetsDir();
    if (!/^[0-9a-f]{64}$/i.test(id)) return null;
    const hit = fs.readdirSync(dir).find((f) => f === id || f.startsWith(id + '.'));
    return hit ? path.join(dir, hit) : null;
  };

  ipcMain.handle('assets:save', (_e, { mime, bytes }) => {
    const buf = Buffer.from(bytes);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const relPath = sha256 + (EXT_BY_MIME[mime] || '');
    const abs = path.join(assetsDir(), relPath);
    if (!fs.existsSync(abs)) fs.writeFileSync(abs, buf);
    return { assetId: sha256, relPath, byteSize: buf.length };
  });
  ipcMain.handle('assets:read', (_e, assetId) => {
    const abs = assetPath(assetId);
    if (!abs) return null;
    return { bytes: new Uint8Array(fs.readFileSync(abs)) };
  });
  ipcMain.handle('assets:remove', (_e, assetId) => {
    const abs = assetPath(assetId);
    if (abs) fs.unlinkSync(abs);
    return { ok: true };
  });
  ipcMain.handle('assets:exists', (_e, assetId) => !!assetPath(assetId));
  /** 孤儿素材扫描：返回目录内文件数与总字节数（供设置页/维护用） */
  ipcMain.handle('assets:stat', () => {
    const dir = assetsDir();
    const files = fs.readdirSync(dir);
    let bytes = 0;
    for (const f of files) bytes += fs.statSync(path.join(dir, f)).size;
    return { count: files.length, bytes, dir };
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
