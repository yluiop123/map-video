/**
 * assets.ts — 素材仓库门面（双端统一）
 *
 * **素材是用户级全局资源**：跨项目可用，不属于任何一个项目。
 *
 * assetId = **随机 id**（与文件名/内容解耦，改名不影响引用）
 *   · 桌面端：Electron IPC → userData/media/<类型>/<时间戳>-<assetId><ext>
 *     （按类型分文件夹、时间戳命名；assetId→相对路径登记在 V2 的 asset 表，只有这一本账）
 *   · 网页端：Dexie `assets` 表（Blob，无文件系统）
 *
 * 不再做 sha256 内容寻址去重 —— 同一文件上传两次就是两份。
 * 渲染端只需要 URL：统一走 getAssetUrl（objectURL，按 assetId 缓存，避免重复解码）。
 * 之所以必须外置：模型（几 MB）与 GIF 若内联进 project JSON，存档会膨胀到不可用。
 */
import { IS_DESKTOP } from './backend';
import * as dexie from '../stores/db';
import { generateId } from '../types';

export interface AssetRef {
  /** 随机 id，元素里存这个 */
  assetId: string;
  mime: string;
  byteSize: number;
}

/** 素材库列表项（全局，供面板浏览选择） */
export interface MediaItem {
  assetId: string;
  name: string;
  mime: string;
}

/** 素材类别：与标记设置的资源形态一一对应（落盘目录与素材库分类由此确定） */
export type AssetKind = 'image' | 'gif' | 'model' | 'icon';

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

/**
 * 把一份**已在手的字节**登记进素材库 → 返回 assetId（元素只存 id）。
 * 桌面端落 userData/media 并在 asset 表登记；网页端存 Dexie 的 Blob 行。
 * （UI 上的「上传」按钮仍只在桌面端给，但配置 JSON 导入必须能还原素材，所以这里不拦网页端。）
 */
export async function putAssetBytes(bytes: Uint8Array, mime: string, name: string, kind: AssetKind): Promise<AssetRef> {
  if (IS_DESKTOP) {
    const r = await window.mapvideo!.assets.save({ mime, bytes, name, kind });
    return { assetId: r.assetId, mime, byteSize: r.byteSize };
  }
  const assetId = 'a' + generateId();
  await dexie.saveAsset({ assetId, projectId: '', mime, name, byteSize: bytes.length, blob: new Blob([bytes], { type: mime }), createdAt: Date.now() });
  return { assetId, mime, byteSize: bytes.length };
}

/** 上传文件 → 素材库（走原生文件对话框，仅桌面端 UI 提供该入口） */
export async function uploadAsset(file: File | Blob, kind: AssetKind): Promise<AssetRef> {
  const buf = await file.arrayBuffer();
  return putAssetBytes(new Uint8Array(buf), resolveMime(file), (file as File).name || '', kind);
}

/** 列出全局素材库（kindPrefix 如 'image' / 'model' / 'audio'，按 mime 前缀过滤；不传返回全部） */
export async function listMedia(kindPrefix?: string): Promise<MediaItem[]> {
  if (!IS_DESKTOP) return [];   // 网页端不支持上传 → 无本机素材库
  const rows = await window.mapvideo!.assets.list(kindPrefix);
  return kindPrefix ? rows.filter((r) => r.mime.startsWith(kindPrefix)) : rows;
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
