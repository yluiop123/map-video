import Dexie, { type Table } from 'dexie';
import type { MapVideoProject, Collection } from '../types';
import { generateId, DEFAULT_COLLECTION_ID } from '../types';

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
  collections: Table<Collection, string>;
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
// v3：新增 collections 表（项目之上的合分层级）；projects 补 collectionId 索引
db.version(3).stores({
  projects: 'id, name, createdAt, updatedAt, collectionId',
  assets: 'assetId, projectId, createdAt',
  collections: 'id, name, order, updatedAt',
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
  await db.collections.clear();
}

// ---------- 合集（项目之上的一层分组） ----------

export async function listCollections(): Promise<Collection[]> {
  const rows = await db.collections.toArray();
  return rows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
}

export async function saveCollection(c: Collection): Promise<void> {
  await db.collections.put({ ...c, updatedAt: new Date() });
}

/** 删除合集：其下项目回落默认合集（不删项目）；默认合集不可删 */
export async function deleteCollection(id: string): Promise<void> {
  if (id === DEFAULT_COLLECTION_ID) return;
  await db.collections.delete(id);
  const affected = await db.projects.where('collectionId').equals(id).toArray();
  for (const p of affected) await db.projects.put({ ...p, collectionId: DEFAULT_COLLECTION_ID });
}

// ---------- 素材 ----------

export async function saveAsset(row: AssetRow): Promise<void> {
  // 已存在则不覆盖：素材是内容寻址（sha256 全局唯一），同一文件被第二个项目引用时
  // 若直接 put 会改写 projectId 归属，让前一个项目失去归属记录（孤儿素材）。
  const existing = await db.assets.get(row.assetId);
  if (existing) return;
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
