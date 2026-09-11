/**
 * 项目存储抽象：网页（IndexedDB/Dexie）⇄ 桌面（Electron SQLite via IPC）。
 * 接口对齐 db.ts 现有形状，projectStore 无感切换。
 */
import type { MapVideoProject, Collection } from '../types';
import { DEFAULT_COLLECTION_ID, DEFAULT_COLLECTION_NAME } from '../types';
import { IS_DESKTOP } from './backend';
import * as dexie from '../stores/db';

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: Date | number;
  size?: number;
}

export const storage = {
  async saveProject(project: MapVideoProject): Promise<void> {
    if (IS_DESKTOP) {
      await window.mapvideo!.projects.save({
        id: project.id,
        name: project.name,
        data: project,
        collectionId: project.collectionId || DEFAULT_COLLECTION_ID,
      });
      return;
    }
    await dexie.saveProject(project);
  },

  async getProject(id: string): Promise<MapVideoProject | undefined> {
    if (IS_DESKTOP) {
      const data = (await window.mapvideo!.projects.get(id)) as MapVideoProject | null;
      return data ?? undefined;
    }
    return await dexie.getProject(id);
  },

  async deleteProject(id: string): Promise<void> {
    if (IS_DESKTOP) {
      await window.mapvideo!.projects.remove(id);
      return;
    }
    await dexie.deleteProject(id);
  },

  async listProjects(): Promise<MapVideoProject[]> {
    if (IS_DESKTOP) {
      const rows = await window.mapvideo!.projects.list();
      // 列表页需要完整 project（现有 UI 直接读字段）；按需全量拉取
      const out: MapVideoProject[] = [];
      for (const r of rows) {
        const data = (await window.mapvideo!.projects.get(r.id)) as MapVideoProject | null;
        if (data) {
          out.push({
            ...data,
            updatedAt: new Date(r.updatedAt),
            collectionId: data.collectionId || r.collectionId || DEFAULT_COLLECTION_ID,
          });
        }
      }
      return out;
    }
    return await dexie.listProjects();
  },

  async clearAll(): Promise<void> {
    if (IS_DESKTOP) {
      const rows = await window.mapvideo!.projects.list();
      for (const r of rows) await window.mapvideo!.projects.remove(r.id);
      return;
    }
    await dexie.clearAll();
  },

  // ---------- 合集（项目之上的一层分组） ----------

  /** 列出合集；「默认合集」懒创建，保证至少一条且恒排最前 */
  async listCollections(): Promise<Collection[]> {
    let list: Collection[];
    if (IS_DESKTOP) {
      const rows = await window.mapvideo!.collections.list();
      list = rows.map((r) => ({
        id: r.id,
        name: r.name,
        order: r.order ?? 0,
        createdAt: new Date(r.createdAt ?? Date.now()),
        updatedAt: new Date(r.updatedAt ?? Date.now()),
      }));
    } else {
      list = await dexie.listCollections();
    }
    if (!list.some((c) => c.id === DEFAULT_COLLECTION_ID)) {
      const def: Collection = {
        id: DEFAULT_COLLECTION_ID,
        name: DEFAULT_COLLECTION_NAME,
        order: -1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await storage.saveCollection(def);
      list = [def, ...list];
    }
    return list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  },

  async saveCollection(c: Collection): Promise<void> {
    if (IS_DESKTOP) {
      await window.mapvideo!.collections.save({ id: c.id, name: c.name, order: c.order ?? 0 });
      return;
    }
    await dexie.saveCollection(c);
  },

  /** 删除合集：其下项目回落默认合集（不删项目）；默认合集不可删 */
  async removeCollection(id: string): Promise<void> {
    if (id === DEFAULT_COLLECTION_ID) return;
    if (IS_DESKTOP) {
      await window.mapvideo!.collections.remove(id);
      return;
    }
    await dexie.deleteCollection(id);
  },
};
