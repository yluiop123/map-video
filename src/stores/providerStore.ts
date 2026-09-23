import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ProviderConfig } from '../types';
import { SEED_GROUPS, cloneRow, seedRow } from '../lib/template-seed';
import type { Mode, ProviderKind, Role, TemplateGroup, TemplateRow } from '../lib/request-engine';
import { IS_DESKTOP } from '../lib/backend';

type NewGroup = Omit<TemplateGroup, 'rows'> & { rows: TemplateRow[] };

interface ProviderState {
  /** 接口模板组（共享数据：一个功能有哪几条接口、各自怎么发怎么取回） */
  groups: TemplateGroup[];
  /** 一个能力一份配置（库里 provider 以 kind 为主键）；没配过是 null */
  llm: ProviderConfig | null;
  tts: ProviderConfig | null;
  image: ProviderConfig | null;
  /** 取该能力的配置；还没有就按模板组的建议建一份空的（界面没有"新建实例"这个动作） */
  ensureConfig: (kind: ProviderKind, tplGroup?: string) => ProviderConfig;
  saveConfig: (kind: ProviderKind, patch: Partial<ProviderConfig>) => void;
  /** 「用作本能力」：这一处配置改指向另一组模板，已填的 Base URL / Key 不重填 */
  useGroup: (kind: ProviderKind, tplGroup: string) => void;
  /** 模板组：整组保存 / 删除 / 恢复 seed 默认 */
  saveGroup: (g: TemplateGroup) => void;
  addGroup: (g: NewGroup) => string;
  removeGroup: (tplGroup: string) => void;
  restoreGroup: (tplGroup: string) => void;
  /** 组内接口行 */
  addRow: (tplGroup: string, role: Role, mode?: Mode) => void;
  removeRow: (tplGroup: string, role: Role, mode: Mode) => void;
  updateRow: (tplGroup: string, role: Role, mode: Mode, patch: Partial<TemplateRow>) => void;
  hydrate: () => Promise<void>;
}

const CFG_OF: Record<ProviderKind, 'llm' | 'tts' | 'image'> = { llm: 'llm', tts: 'tts', image: 'image' };
const CUSTOM_GROUP: Record<ProviderKind, string> = { llm: 'custom-llm', tts: 'custom-tts', image: 'custom-image' };

/** 单飞：同一时刻只允许一次 hydrate 真的在跑 */
let hydrating: Promise<void> | null = null;

/** 每个 kind 占一个槽位；算出来的键名写不进 zustand，按 kind 分派 */
const putKind = (
  set: (partial: Partial<ProviderState>) => void,
  kind: ProviderKind,
  cfg: ProviderConfig | null,
) => set(kind === 'llm' ? { llm: cfg } : kind === 'tts' ? { tts: cfg } : { image: cfg });

/** 桌面端写穿 SQLite（web 模式由 persist 落 localStorage） */
function saveGroupDb(g: TemplateGroup): void {
  if (!IS_DESKTOP) return;
  window.mapvideo!.templates.save(g).catch((e) => console.warn('[templates] SQLite 同步失败:', e));
}
function removeGroupDb(tplGroup: string): void {
  if (!IS_DESKTOP) return;
  window.mapvideo!.templates.remove(tplGroup).catch((e) => console.warn('[templates] 删除失败:', e));
}
function saveConfigDb(cfg: ProviderConfig): void {
  if (!IS_DESKTOP) return;
  window.mapvideo!.providers.upsert(cfg).catch((e) => console.warn('[providers] SQLite 同步失败:', e));
}

/** 一份空配置：Base URL / 模型 / 音色按该组模板的建议预填，Key 一律留空（Key 只有用户能填） */
function draftConfig(g: TemplateGroup | undefined, kind: ProviderKind): ProviderConfig {
  return {
    kind,
    tplGroup: g?.tplGroup ?? CUSTOM_GROUP[kind],
    baseUrl: g?.baseUrl ?? '',
    apiKey: '',
    mode: 'sync',
    model: g?.defaultModel ?? '',
    voice: g?.defaultVoice,
    speed: 1,
    params: {},
    maxConcurrency: 1,
    retryTimes: 2,
  };
}

/** seed 深拷贝（界面编辑绝不能改到常量本身） */
function seedCopy(): TemplateGroup[] {
  return JSON.parse(JSON.stringify(SEED_GROUPS)) as TemplateGroup[];
}

export const useProviderStore = create<ProviderState>()(
  persist(
    (set, get) => ({
      groups: seedCopy(),
      llm: null,
      tts: null,
      image: null,

      ensureConfig: (kind, tplGroup) => {
        const cur = get()[CFG_OF[kind]];
        if (cur) return cur;
        const g = get().groups.find((x) => x.tplGroup === (tplGroup ?? CUSTOM_GROUP[kind]));
        const cfg = draftConfig(g, kind);
        putKind(set, kind, cfg);
        saveConfigDb(cfg);
        return cfg;
      },
      saveConfig: (kind, patch) => {
        const cur = get()[CFG_OF[kind]] ?? draftConfig(undefined, kind);
        const next: ProviderConfig = { ...cur, ...patch, kind };
        putKind(set, kind, next);
        saveConfigDb(next);
      },
      useGroup: (kind, tplGroup) => {
        const cur = get()[CFG_OF[kind]];
        if (!cur) { get().ensureConfig(kind, tplGroup); return; }
        const g = get().groups.find((x) => x.tplGroup === tplGroup);
        // 换组只换"用哪套接口"，空着的建议值顺手填上，已经填过的不动
        const patch: Partial<ProviderConfig> = { tplGroup };
        if (g) {
          if (!cur.baseUrl && g.baseUrl) patch.baseUrl = g.baseUrl;
          if (!cur.model && g.defaultModel) patch.model = g.defaultModel;
          if (!cur.voice && g.defaultVoice) patch.voice = g.defaultVoice;
        }
        get().saveConfig(kind, patch);
      },

      saveGroup: (g) => {
        set((s) => ({
          groups: s.groups.some((x) => x.tplGroup === g.tplGroup)
            ? s.groups.map((x) => (x.tplGroup === g.tplGroup ? g : x))
            : [...s.groups, g],
        }));
        saveGroupDb(g);
      },
      addGroup: (g) => {
        const id = g.tplGroup || `custom-${Math.random().toString(36).slice(2, 7)}`;
        get().saveGroup({ ...g, tplGroup: id });
        return id;
      },
      removeGroup: (tplGroup) => {
        set((s) => ({ groups: s.groups.filter((g) => g.tplGroup !== tplGroup) }));
        removeGroupDb(tplGroup);
      },
      restoreGroup: (tplGroup) => {
        const seed = SEED_GROUPS.find((g) => g.tplGroup === tplGroup);
        if (seed) get().saveGroup(JSON.parse(JSON.stringify(seed)) as TemplateGroup);
      },
      addRow: (tplGroup, role, mode = 'sync') => {
        const g = get().groups.find((x) => x.tplGroup === tplGroup);
        if (!g || g.rows.some((r) => r.role === role && r.mode === mode)) return;
        get().saveGroup({ ...g, rows: [...g.rows, seedRow(g.kind, role, mode)] });
      },
      removeRow: (tplGroup, role, mode) => {
        const g = get().groups.find((x) => x.tplGroup === tplGroup);
        if (!g) return;
        get().saveGroup({ ...g, rows: g.rows.filter((r) => !(r.role === role && r.mode === mode)) });
      },
      updateRow: (tplGroup, role, mode, patch) => {
        const g = get().groups.find((x) => x.tplGroup === tplGroup);
        if (!g) return;
        get().saveGroup({
          ...g,
          rows: g.rows.map((r) => (r.role === role && r.mode === mode ? { ...r, ...patch } : r)),
        });
      },

      /** 桌面端启动时从 SQLite 加载；库里没有模板行时按 seed 铺一次表 */
      hydrate: async () => {
        if (!IS_DESKTOP) return;
        // StrictMode 会把 effect 跑两遍，两次并发 hydrate 会各自铺一遍 seed（幂等但白写一遍库）
        if (hydrating) return hydrating;
        hydrating = (async () => {
        try {
          let rawGroups = await window.mapvideo!.templates.list();
          if (!rawGroups.length) {
            for (const g of seedCopy()) await window.mapvideo!.templates.save(g);
            rawGroups = await window.mapvideo!.templates.list();
            console.log(`[templates] 已按内置 seed 铺出 ${rawGroups.length} 组接口模板`);
          }
          // 旧形状（每能力多条实例 / provider_endpoint 副本）在这一步压成每能力一行 —— 必须等模板组就位，
          // provider.tpl_group 是真外键
          await window.mapvideo!.providers.migrate();
          const rawProviders = await window.mapvideo!.providers.list();
          const groups = rawGroups;
          const known = new Set(groups.map((g) => g.tplGroup));
          const cfgByKind: Record<ProviderKind, ProviderConfig | null> = { llm: null, tts: null, image: null };
          for (const kind of ['llm', 'tts', 'image'] as ProviderKind[]) {
            const found = rawProviders.find((x) => x.kind === kind);
            if (!found) continue;
            const c: ProviderConfig = { ...found, params: found.params ?? {} };
            // 引用的模板组不在了（组被删过 / 模板表漂移重铺）—— tpl_group 是真外键，
            // 挂着不修这一行既显示不出模板、也写不回库，回落到同 kind 的自定义组。
            if (!known.has(c.tplGroup)) {
              const to = known.has(CUSTOM_GROUP[kind]) ? CUSTOM_GROUP[kind] : groups.find((g) => g.kind === kind)?.tplGroup;
              if (to) {
                c.tplGroup = to;
                saveConfigDb(c);
                console.log(`[providers] ${kind} 引用的模板组已不存在，回落到 ${to}`);
              }
            }
            cfgByKind[kind] = c;
          }
          set({ groups, llm: cfgByKind.llm, tts: cfgByKind.tts, image: cfgByKind.image });
        } catch (e) {
          console.warn('[providers] SQLite 加载失败:', e);
        } finally {
          hydrating = null;
        }
        })();
        return hydrating;
      },
    }),
    {
      // 换成「每能力一份配置」后旧本地存储作废（按「不为兼容牺牲设计」直接换 key）
      name: 'mapvideo-providers.v4',
      storage: {
        getItem: (name) => {
          if (IS_DESKTOP) return null;
          const str = localStorage.getItem(name);
          return str ? JSON.parse(str) : null;
        },
        setItem: (name, value) => {
          if (IS_DESKTOP) return;
          localStorage.setItem(name, JSON.stringify(value));
        },
        removeItem: (name) => {
          if (IS_DESKTOP) return;
          localStorage.removeItem(name);
        },
      },
    }
  )
);

/** 取该能力的那一份配置（没配过是 null）。一个能力一处，不存在"选哪条生效"。 */
export function configOf(kind: ProviderKind): ProviderConfig | null {
  return useProviderStore.getState()[CFG_OF[kind]];
}

export { cloneRow };
