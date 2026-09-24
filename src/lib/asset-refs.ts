/**
 * 项目里所有「指向素材」的引用位。
 *
 * 导出配置 JSON 按这一份带字节、导入按这一份改 id —— 新增素材引用位**只改这里**，
 * 不要在 createExport / 导入还原里各写一遍（原先只收 point 的 assetId，
 * 移动图标、地理贴图与全部音频都静默丢在导出文件外面）。
 */
import type { MapVideoProject } from '../types';

/** 元素上可能带素材的两个位子（本体 / 路线移动图标）；geo_image 用 assetId 同一位 */
interface AssetBearing { assetId?: string; moveIcon?: { assetId?: string } }

export function projectAssetIds(project: MapVideoProject): string[] {
  const ids = new Set<string>();
  const add = (v?: string | null) => { if (v) ids.add(v); };
  for (const el of project.elements || []) {
    const e = el as unknown as AssetBearing;
    add(e.assetId);
    add(e.moveIcon?.assetId);
  }
  for (const e of project.narration?.entries || []) add(e.audioId);
  for (const m of project.music || []) add(m.audioId);
  for (const o of project.overlays || []) {
    add(o.content?.custom?.audio?.audioId);
    add(o.content?.person?.audioId);
  }
  return [...ids];
}

/** 导入后把项目里的素材引用换成新库里生成的 id（映射里没有的原样留着） */
export function remapProjectAssetIds(project: MapVideoProject, map: Record<string, string>): MapVideoProject {
  if (!Object.keys(map).length) return project;
  const id = (v?: string) => (v ? map[v] || v : v);
  return {
    ...project,
    elements: (project.elements || []).map((el) => {
      const e = el as unknown as AssetBearing;
      if (!e.assetId && !e.moveIcon?.assetId) return el;
      return {
        ...e,
        assetId: id(e.assetId),
        moveIcon: e.moveIcon ? { ...e.moveIcon, assetId: id(e.moveIcon.assetId) } : e.moveIcon,
      } as typeof el;
    }),
    narration: project.narration
      ? { ...project.narration, entries: project.narration.entries.map((e) => (e.audioId ? { ...e, audioId: id(e.audioId) } : e)) }
      : project.narration,
    music: (project.music || []).map((m) => ({ ...m, audioId: id(m.audioId) || m.audioId })),
    overlays: (project.overlays || []).map((o) => {
      const c = o.content;
      if (!c) return o;
      const next = { ...c };
      if (next.custom?.audio?.audioId) next.custom = { ...next.custom, audio: { ...next.custom.audio, audioId: id(next.custom.audio.audioId)! } };
      if (next.person?.audioId) next.person = { ...next.person, audioId: id(next.person.audioId) };
      return { ...o, content: next };
    }),
  };
}
