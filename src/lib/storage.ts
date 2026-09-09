/**
 * 项目存储抽象：网页（IndexedDB/Dexie）⇄ 桌面（Electron SQLite via IPC）。
 * 接口对齐 db.ts 现有形状，projectStore 无感切换。
 */
import type { MapVideoProject } from '../types';
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
      await window.mapvideo!.projects.save({ id: project.id, name: project.name, data: project });
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
        if (data) out.push({ ...data, updatedAt: new Date(r.updatedAt) });
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
};
