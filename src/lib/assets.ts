/**
 * assets.ts — 素材仓库门面（双端统一）
 *
 * assetId = sha256（内容寻址，同文件天然去重）
 *   · 桌面端：Electron IPC → userData/assets/<sha256><ext>（文件系统，由主进程算哈希）
 *   · 网页端：Dexie `assets` 表（Blob，浏览器 WebCrypto 算哈希）
 *
 * 渲染端只需要 URL：统一走 getAssetUrl（objectURL，按 assetId 缓存，避免重复解码）。
 * 之所以必须外置：模型（几 MB）与 GIF 若内联进 project JSON，存档会膨胀到不可用。
 */
import { IS_DESKTOP } from './backend';
import * as dexie from '../stores/db';

export interface AssetRef {
  /** 内容哈希，元素里存这个 */
  assetId: string;
  mime: string;
  byteSize: number;
}

const urlCache = new Map<string, string>();

/**
 * 按扩展名补 mime：部分系统/浏览器给 .glb / .gltf 的 `file.type` 是空串，
 * 会导致桌面端落盘时取不到后缀（功能不受影响，但文件难以辨认）。
 */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', svg: 'image/svg+xml',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', obj: 'model/obj',
  mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4',
};

function resolveMime(file: File | Blob): string {
  if (file.type) return file.type;
  const ext = ((file as File).name || '').split('.').pop()?.toLowerCase() || '';
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 上传素材 → 返回 assetId；元素只需存这个 id */
export async function uploadAsset(file: File | Blob, projectId = ''): Promise<AssetRef> {
  const buf = await file.arrayBuffer();
  const mime = resolveMime(file);

  if (IS_DESKTOP) {
    // 桌面端交给主进程算哈希并落盘（渲染进程不依赖 crypto.subtle 的安全上下文）
    const r = await window.mapvideo!.assets.save({ mime, bytes: new Uint8Array(buf) });
    return { assetId: r.assetId, mime, byteSize: r.byteSize };
  }

  const assetId = await sha256Hex(buf);
  const name = (file as File).name || '';
  await dexie.saveAsset({
    assetId,
    projectId,
    mime,
    name,
    byteSize: buf.byteLength,
    blob: new Blob([buf], { type: mime }),
    createdAt: Date.now(),
  });
  return { assetId, mime, byteSize: buf.byteLength };
}

async function readBlob(assetId: string): Promise<Blob | null> {
  if (IS_DESKTOP) {
    const r = await window.mapvideo!.assets.read(assetId);
    return r?.bytes ? new Blob([r.bytes]) : null;
  }
  const row = await dexie.getAsset(assetId);
  return row?.blob ?? null;
}

/** 取可直接使用的 objectURL（按 assetId 缓存）；素材不存在返回 null */
export async function getAssetUrl(assetId?: string | null): Promise<string | null> {
  if (!assetId) return null;
  const hit = urlCache.get(assetId);
  if (hit) return hit;
  const blob = await readBlob(assetId);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(assetId, url);
  return url;
}

/** 取原始字节（3D 模型解析 / 校验用） */
export async function getAssetBytes(assetId?: string | null): Promise<Uint8Array | null> {
  if (!assetId) return null;
  if (IS_DESKTOP) {
    const r = await window.mapvideo!.assets.read(assetId);
    return r?.bytes ?? null;
  }
  const row = await dexie.getAsset(assetId);
  if (!row) return null;
  return new Uint8Array(await row.blob.arrayBuffer());
}

export async function removeAsset(assetId: string): Promise<void> {
  const url = urlCache.get(assetId);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(assetId);
  }
  if (IS_DESKTOP) {
    await window.mapvideo!.assets.remove(assetId);
    return;
  }
  await dexie.removeAsset(assetId);
}

/** 释放全部 objectURL（切项目 / 卸载时调用） */
export function releaseAssetUrls(): void {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

/** 素材仓库统计（桌面端可拿到目录；网页端统计数量与体积） */
export async function statAssets(): Promise<{ count: number; bytes: number; dir?: string }> {
  if (IS_DESKTOP) return await window.mapvideo!.assets.stat();
  const rows = await dexie.listAssets();
  return { count: rows.length, bytes: rows.reduce((n, r) => n + r.byteSize, 0) };
}
