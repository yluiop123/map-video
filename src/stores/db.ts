import Dexie, { type Table } from 'dexie';
import type { MapVideoProject, Collection, BaseMapConfig, ElevationMapConfig } from '../types';
import { generateId, DEFAULT_COLLECTION_ID } from '../types';

/** 素材行：图片 / GIF / 模型等大文件，存 Blob（assetId 为随机 id，与文件名/内容解耦） */
export interface AssetRow {
  /** 随机 id（同一文件传两次就是两份，不做内容去重） */
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
  /** 底图目录（全库一份，所有项目共用） */
  baseMaps: Table<BaseMapConfig & { ord?: number }, string>;
  /** 高程目录（同上；夸张系数不在这里，它在项目上） */
  elevationMaps: Table<ElevationMapConfig & { ord?: number }, string>;
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
// v4：底图 / 高程目录从「每个项目自带一份」改成**全库一份**（与桌面端 SQLite 的 base_map / elevation_map 同构）。
// 项目 JSON 里那两个数组随之作废（按 §8 不做迁移）：读旧项目时目录走这里，项目只记选了哪一行。
db.version(4).stores({
  projects: 'id, name, createdAt, updatedAt, collectionId',
  assets: 'assetId, projectId, createdAt',
  collections: 'id, name, order, updatedAt',
  baseMaps: 'id, ord',
  elevationMaps: 'id, ord',
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

// ---------- 底图 / 高程目录（全库一份，与桌面端 SQLite 同构） ----------

export async function listBaseMaps(): Promise<BaseMapConfig[]> {
  const rows = await db.baseMaps.toArray();
  return rows.sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0) || a.name.localeCompare(b.name))
    .map(({ ord: _ord, ...rest }) => rest);
}

export async function saveBaseMap(row: BaseMapConfig, ord = 0): Promise<void> {
  await db.baseMaps.put({ ...row, ord });
}

export async function deleteBaseMap(id: string): Promise<void> {
  await db.baseMaps.delete(id);
}

export async function listElevationMaps(): Promise<ElevationMapConfig[]> {
  const rows = await db.elevationMaps.toArray();
  return rows.sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0) || a.name.localeCompare(b.name))
    .map(({ ord: _ord, ...rest }) => rest);
}

export async function saveElevationMap(row: ElevationMapConfig, ord = 0): Promise<void> {
  await db.elevationMaps.put({ ...row, ord });
}

export async function deleteElevationMap(id: string): Promise<void> {
  await db.elevationMaps.delete(id);
}

// ---------- 素材 ----------

export async function saveAsset(row: AssetRow): Promise<void> {
  // 已存在则不覆盖：同一 assetId 可能被多个项目引用，直接 put 会改写 projectId 归属，
  // 让前一个项目失去归属记录（表现为孤儿素材）。
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
