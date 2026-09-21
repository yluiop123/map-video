/**
 * MapVideo 桌面端主进程：
 * - app:// 自定义协议托管 dist（规避 file:// 的 worker/模块限制）
 * - node:sqlite 内嵌数据库（projects + provider，库文件在 userData）
 * - AI/TTS 管道：渲染进程无 CORS，主进程持配置转发厂商（协议实现与 web 服务端同源）
 */
import { app, BrowserWindow, ipcMain, protocol, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ensureV2Schema, migrateLegacyProjects, saveProjectV2, getProjectV2, listProjectsV2, removeProjectV2, listPublicLayersV2, saveLayerToPublicV2, importPublicLayerV2, removePublicLayerV2,
  listProvidersV2, upsertProviderV2, removeProviderV2, setActiveProviderV2 } from './db-v2.mjs';

const DIST = path.join(app.getAppPath(), 'dist');

// ---------- SQLite ----------
let db;
function initDb() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, 'mapvideo.db'));
  // 应用配置：统一用 V2 `provider` 表（旧 `providers` 表数据迁移后删除）。
  const now = Date.now();

  // V2 关系型表 + 旧 JSON 项目一次性迁移
  if (ensureV2Schema(db)) {
    try {
      db.prepare("INSERT OR IGNORE INTO collection (collection_id, name, ord, created_at, updated_at) VALUES ('default','默认合集',-1,?,?)").run(now, now);
    } catch { /* 忽略 */ }
    migrateLegacyProjects(db);
  }
}


// ---------- 通用 HTTP 转发 ----------
// 主进程不再认识任何供应商：怎么发请求由渲染端的接口模板算好，这里只负责发出去、按 Content-Type 分类拿回来。
// （原先这里是 5 条 `switch (cfg.protocol)`，与渲染端那份互为影子，改一家要改两处 —— 见 AGENTS §6.7 / §6.22）
async function httpRequest(req) {
  const url = new URL(req.url);
  for (const [k, v] of Object.entries(req.query || {})) url.searchParams.set(k, String(v));
  const res = await fetch(url.href, {
    method: req.method || 'POST',
    headers: req.headers || {},
    body: req.method === 'GET' || req.body == null ? undefined : JSON.stringify(req.body),
  });
  const ctype = res.headers.get('content-type') || '';
  const out = { status: res.status, contentType: ctype };
  if (ctype.includes('json')) out.json = await res.json().catch(() => undefined);
  else if (ctype.startsWith('text/') || ctype.includes('xml')) out.text = await res.text().catch(() => undefined);
  else out.bytes = new Uint8Array(await res.arrayBuffer());
  return out;
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

  // 公共图层库（跨项目）：把项目图层连元素复制过去 / 导入回项目
  ipcMain.handle('db:publicLayers:list', () => listPublicLayersV2(db));
  ipcMain.handle('db:publicLayers:save', (_e, { layerId }) => saveLayerToPublicV2(db, layerId) || { id: null });
  ipcMain.handle('db:publicLayers:import', (_e, { publicLayerId, projectId }) => {
    const r = importPublicLayerV2(db, publicLayerId, projectId);
    if (!r) return { layerId: null };
    // 把导入后的图层原样回传：渲染进程据此并入内存项目，避免整项目 reload 冲掉未保存修改与撤销栈
    const proj = getProjectV2(db, projectId);
    const layer = (proj?.layers || []).find((L) => L.id === r.id) || null;
    return { layerId: r.id, layer };
  });
  ipcMain.handle('db:publicLayers:remove', (_e, id) => { removePublicLayerV2(db, id); return { ok: true }; });

  // 清空项目数据：项目 + 合集 + 素材文件（**保留**应用配置 provider）
  ipcMain.handle('db:clearAll', () => {
    try { db.exec('DELETE FROM project; DELETE FROM collection;'); } catch { /* V2 可能未建表 */ }
    try {
      const root = mediaRoot();
      for (const f of fs.readdirSync(root)) {
        fs.rmSync(path.join(root, f), { recursive: true, force: true });
      }
      db.exec('DELETE FROM asset');   // 文件删了，登记行必须一起删（否则素材库全是死行）
    } catch { /* 目录不存在时忽略 */ }
    const now = Date.now();
    db.prepare(`
      INSERT OR IGNORE INTO collection (collection_id, name, ord, created_at, updated_at)
      VALUES ('default', '默认合集', -1, ?, ?)
    `).run(now, now);
    return { ok: true };
  });

  // Providers（Key 存本地库；「怎么发请求」是 provider_endpoint 里的接口模板行）
  // SQL 全在 db-v2.mjs —— 与项目/素材同一层，才能离线跑迁移回归
  ipcMain.handle('db:providers:list', () => listProvidersV2(db));
  ipcMain.handle('db:providers:upsert', (_e, cfg) => { upsertProviderV2(db, cfg); return { ok: true }; });
  ipcMain.handle('db:providers:remove', (_e, id) => { removeProviderV2(db, id); return { ok: true }; });
  ipcMain.handle('db:providers:setActive', (_e, { kind, id }) => { setActiveProviderV2(db, kind, id); return { ok: true }; });

  // 网络管道：渲染进程算好请求，主进程只管发与收（无 CORS，Key 不出本机）
  ipcMain.handle('net:request', async (_e, req) => {
    try {
      return await httpRequest(req);
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  });
  ipcMain.handle('net:fetchUrl', async (_e, url) => {
    try {
      const res = await fetch(String(url));
      if (!res.ok) return { error: `下载结果失败 HTTP ${res.status}` };
      const ctype = res.headers.get('content-type') || undefined;
      return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: ctype };
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
  //   userData/media/<images|gifs|models|icons|audio|video|fonts>/<YYYYMMDD-HHmmss>-<assetId><ext>
  // assetId 是**随机 id**（与文件名解耦，改名不影响引用）；不做内容寻址去重 —— 传两次就是两份。
  // ★ 登记簿**只有 V2 的 asset 表这一本**（storage='file' + rel_path）：
  //   以前另存一份 media/index.json，同一条事实两处真相，而且库里的 asset 行反而是空壳。
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

  // kind 列有 CHECK 白名单：前端没传或传了别的，一律按 mime 归到合法值上
  const ASSET_KINDS = new Set(['image', 'gif', 'model', 'audio', 'video', 'font', 'icon']);
  const kindOf = (kind, mime) => (ASSET_KINDS.has(kind) ? kind
    : mime === 'image/gif' ? 'gif'
      : mime.startsWith('image/') ? 'image'
        : mime.startsWith('model/') ? 'model'
          : mime.startsWith('audio/') ? 'audio'
            : mime.startsWith('video/') ? 'video'
              : mime.startsWith('font') ? 'font' : 'icon');
  const assetRow = (id) => db.prepare('SELECT kind, name, mime, rel_path FROM asset WHERE asset_id = ?').get(String(id || ''));

  ipcMain.handle('assets:save', (_e, { mime, bytes, name, kind }) => {
    const buf = Buffer.from(bytes);
    const assetId = 'a' + crypto.randomBytes(8).toString('hex');
    const m = String(mime || '');
    const k = kindOf(String(kind || ''), m);
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
    const dir = path.join(mediaRoot(), kindDirOf(k, m));
    fs.mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, `${stamp}-${assetId}${EXT_BY_MIME[m] || ''}`);
    fs.writeFileSync(abs, buf);
    const rel = path.relative(mediaRoot(), abs).replace(/\\/g, '/');
    db.prepare('INSERT INTO asset (asset_id, kind, name, mime, storage, rel_path, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(assetId, k, String(name || ''), m || 'application/octet-stream', 'file', rel, Date.now());
    return { assetId, relPath: rel, byteSize: buf.length };
  });
  ipcMain.handle('assets:read', (_e, assetId) => {
    const r = assetRow(assetId);
    if (!r?.rel_path) return null;
    const abs = path.join(mediaRoot(), r.rel_path);
    if (!fs.existsSync(abs)) return null;
    return { bytes: new Uint8Array(fs.readFileSync(abs)), mime: r.mime, name: r.name };
  });
  ipcMain.handle('assets:remove', (_e, assetId) => {
    const r = assetRow(assetId);
    const id = String(assetId || '');
    db.prepare('DELETE FROM asset WHERE asset_id = ?').run(id);
    // 项目侧 element_*.asset_id 有真外键（SET NULL 自动清），公共库副本没有 → 手工清，
    // 否则库里留下一条永远解析不到的死引用（v_check_dangling 会报出来）
    for (const t of ['public_element_marker', 'public_element_image']) {
      db.prepare(`UPDATE ${t} SET asset_id = NULL WHERE asset_id = ?`).run(id);
    }
    for (const t of ['public_element_route', 'public_element_shape']) {
      db.prepare(`UPDATE ${t} SET move_icon_asset_id = NULL WHERE move_icon_asset_id = ?`).run(id);
    }
    if (r?.rel_path) {
      const abs = path.join(mediaRoot(), r.rel_path);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    }
    return { ok: true };
  });
  ipcMain.handle('assets:exists', (_e, assetId) => !!assetRow(assetId));
  /** 全局素材库列表（可选 mime 类型前缀过滤，供面板浏览选择） */
  ipcMain.handle('assets:list', (_e, kindPrefix) => {
    const out = db.prepare('SELECT asset_id AS assetId, name, mime FROM asset ORDER BY created_at DESC').all();
    return kindPrefix ? out.filter((m) => (m.mime || '').startsWith(String(kindPrefix))) : out;
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
        else { count++; bytes += fs.statSync(p).size; }
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
  // Windows：autoHideMenuBar 的菜单栏在全屏时仍会留一条黑边（演示模式顶部那条），
  // 进全屏显式藏掉，退出时还原进全屏前的可见状态（不能直接设 true，那会把菜单栏钉住）。
  let menuBarBeforeFs = true;
  win.on('enter-full-screen', () => {
    menuBarBeforeFs = win.isMenuBarVisible();
    win.setMenuBarVisibility(false);
  });
  win.on('leave-full-screen', () => win.setMenuBarVisibility(menuBarBeforeFs));
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
