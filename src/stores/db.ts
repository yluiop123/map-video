import Dexie, { type Table } from 'dexie';
import type { MapVideoProject } from '../types';
import { generateId } from '../types';

/** 素材行：图片 / GIF / 模型等大文件，存 Blob（内容寻址，assetId = sha256） */
export interface AssetRow {
  /** 内容哈希，同文件天然去重 */
  assetId: string;
  /** 归属项目（'' 表示未归属，交由孤儿清理任务回收） */
  projectId: string;
  mime: string;
  name: string;
  byteSize: number;
  blob: Blob;
  createdAt: number;
}

interface MapVideoDB {
  projects: Table<MapVideoProject, string>;
  assets: Table<AssetRow, string>;
}

const db = new Dexie('MapVideoDB') as Dexie & MapVideoDB;
db.version(1).stores({
  projects: 'id, name, createdAt, updatedAt',
});
// v2：新增 assets 表 —— 标记的图片 / GIF / 模型不再以 base64 内联进项目 JSON
db.version(2).stores({
  projects: 'id, name, createdAt, updatedAt',
  assets: 'assetId, projectId, createdAt',
});

export async function saveProject(project: MapVideoProject): Promise<void> {
  await db.projects.put({ ...project, updatedAt: new Date() });
}

export async function getProject(id: string): Promise<MapVideoProject | undefined> {
  return await db.projects.get(id);
}

export async function deleteProject(id: string): Promise<void> {
  await db.projects.delete(id);
}

export async function listProjects(): Promise<MapVideoProject[]> {
  return await db.projects.orderBy('updatedAt').reverse().toArray();
}

export async function clearAll(): Promise<void> {
  await db.projects.clear();
  await db.assets.clear();
}

// ---------- 素材 ----------

export async function saveAsset(row: AssetRow): Promise<void> {
  await db.assets.put(row);
}

export async function getAsset(assetId: string): Promise<AssetRow | undefined> {
  return await db.assets.get(assetId);
}

export async function removeAsset(assetId: string): Promise<void> {
  await db.assets.delete(assetId);
}

export async function listAssets(projectId?: string): Promise<AssetRow[]> {
  return projectId
    ? await db.assets.where('projectId').equals(projectId).toArray()
    : await db.assets.toArray();
}

export { generateId };
