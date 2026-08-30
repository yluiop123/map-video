import Dexie, { type Table } from 'dexie';
import type { MapVideoProject } from '../types';
import { generateId } from '../types';

interface MapVideoDB {
  projects: Table<MapVideoProject, string>;
}

const db = new Dexie('MapVideoDB') as Dexie & MapVideoDB;
db.version(1).stores({
  projects: 'id, name, createdAt, updatedAt',
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
}

export { generateId };
