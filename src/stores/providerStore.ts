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
  llm: ProviderConfig[];
  tts: ProviderConfig[];
  image: ProviderConfig[];
  activeLlmId: string | null;
  activeTtsId: string | null;
  activeImageId: string | null;
  /** 新建一个能力实例（预填这组模板建议的 baseUrl / 模型 / 音色） */
  addFromGroup: (tplGroup: string, kind: ProviderKind) => string;
  addCustom: (kind: ProviderKind) => string;
  update: (id: string, patch: Partial<ProviderConfig>) => void;
  remove: (id: string) => void;
  setActive: (kind: ProviderKind, id: string | null) => void;
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

const LIST_OF: Record<ProviderKind, 'llm' | 'tts' | 'image'> = { llm: 'llm', tts: 'tts', image: 'image' };
const ACTIVE_OF: Record<ProviderKind, 'activeLlmId' | 'activeTtsId' | 'activeImageId'> = {
  llm: 'activeLlmId', tts: 'activeTtsId', image: 'activeImageId',
};
const CUSTOM_GROUP: Record<ProviderKind, string> = { llm: 'custom-llm', tts: 'custom-tts', image: 'custom-image' };

/** 单飞：同一时刻只允许一次 hydrate 真的在跑 */
let hydrating: Promise<void> | null = null;

function ensureActive(cfgs: ProviderConfig[], activeId: string | null): string | null {
  if (activeId && cfgs.some((c) => c.id === activeId)) return activeId;
  return cfgs[0]?.id ?? null;
}

/** 桌面端写穿 SQLite（web 模式由 persist 落 localStorage） */
function saveGroupDb(g: TemplateGroup): void {
  if (!IS_DESKTOP) return;
  window.mapvideo!.templates.save(g).catch((e) => console.warn('[templates] SQLite 同步失败:', e));
}
function removeGroupDb(tplGroup: string): void {
  if (!IS_DESKTOP) return;
  window.mapvideo!.templates.remove(tplGroup).catch((e) => console.warn('[templates] 删除失败:', e));
}

function newConfig(g: TemplateGroup | undefined, kind: ProviderKind, label?: string): ProviderConfig {
  return {
    id: `${kind}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    label: label ?? (g ? g.label : kind),
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
      llm: [],
      tts: [],
      image: [],
      activeLlmId: null,
      activeTtsId: null,
      activeImageId: null,

      addFromGroup: (tplGroup, kind) => {
        const cfg = newConfig(get().groups.find((g) => g.tplGroup === tplGroup), kind);
        set((s) => {
          const list = s[LIST_OF[kind]].concat(cfg);
          return { [LIST_OF[kind]]: list, [ACTIVE_OF[kind]]: ensureActive(list, s[ACTIVE_OF[kind]]) } as Partial<ProviderState>;
        });
        get().update(cfg.id, {});
        return cfg.id;
      },
      addCustom: (kind) => get().addFromGroup(CUSTOM_GROUP[kind], kind),
      update: (id, patch) => {
        set((s) => ({
          llm: s.llm.map((c) => (c.id === id ? { ...c, ...patch } : c)),
          tts: s.tts.map((c) => (c.id === id ? { ...c, ...patch } : c)),
          image: s.image.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        }));
        const cfg = [...get().llm, ...get().tts, ...get().image].find((c) => c.id === id);
        if (cfg && IS_DESKTOP) window.mapvideo!.providers.upsert(cfg).catch((e) => console.warn('[providers] SQLite 同步失败:', e));
      },
      remove: (id) => {
        set((s) => {
          const llm = s.llm.filter((c) => c.id !== id);
          const tts = s.tts.filter((c) => c.id !== id);
          const image = s.image.filter((c) => c.id !== id);
          return {
            llm, tts, image,
            activeLlmId: ensureActive(llm, s.activeLlmId),
            activeTtsId: ensureActive(tts, s.activeTtsId),
            activeImageId: ensureActive(image, s.activeImageId),
          };
        });
        if (IS_DESKTOP) window.mapvideo!.providers.remove(id).catch((e) => console.warn('[providers] 删除失败:', e));
      },
      setActive: (kind, id) => {
        set(kind === 'llm' ? { activeLlmId: id } : kind === 'tts' ? { activeTtsId: id } : { activeImageId: id });
        if (IS_DESKTOP) window.mapvideo!.providers.setActive(kind, id).catch((e) => console.warn('[providers] 设为生效失败:', e));
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
          // 旧形状（provider_endpoint 副本）在这一步搬回 —— 必须等模板组就位，provider.tpl_group 是真外键
          await window.mapvideo!.providers.migrate();
          const rawProviders = await window.mapvideo!.providers.list();
          const groups = rawGroups;
          const list = rawProviders.map((c) => ({ ...c, params: c.params ?? {} }));
          // 实例引用的模板组不在了（模板表形状漂移让位重铺、或那组被删过）—— `tpl_group` 是真外键，
          // 挂着不修的话这一行既显示不出模板、也写不回库。回落到同 kind 的自定义组。
          const known = new Set(groups.map((g) => g.tplGroup));
          for (const c of list) {
            if (known.has(c.tplGroup)) continue;
            const to = known.has(CUSTOM_GROUP[c.kind]) ? CUSTOM_GROUP[c.kind] : groups.find((g) => g.kind === c.kind)?.tplGroup;
            if (!to) continue;
            c.tplGroup = to;
            await window.mapvideo!.providers.upsert(c);
            console.log(`[providers] 「${c.label || c.id}」引用的模板组已不存在，回落到 ${to}`);
          }
          const byKind = (kind: ProviderKind) => list.filter((c) => c.kind === kind);
          const activeOf = (kind: ProviderKind, arr: ProviderConfig[]) =>
            list.find((c) => c.kind === kind && (c as ProviderConfig & { active?: boolean }).active === true)?.id
            ?? ensureActive(arr, null);
          set({
            groups,
            llm: byKind('llm'), tts: byKind('tts'), image: byKind('image'),
            activeLlmId: activeOf('llm', byKind('llm')),
            activeTtsId: activeOf('tts', byKind('tts')),
            activeImageId: activeOf('image', byKind('image')),
          });
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
      // 换成「模板组 + 实例」两份数据后旧本地存储作废（按「不为兼容牺牲设计」直接换 key）
      name: 'mapvideo-providers.v3',
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

/** 取当前生效的配置（无配置返回 null）。桌面/本地网页均可编辑多个，取激活项。 */
export function activeProvider(kind: ProviderKind): ProviderConfig | null {
  const s = useProviderStore.getState();
  const list = s[LIST_OF[kind]];
  const activeId = s[ACTIVE_OF[kind]];
  return list.find((c) => c.id === activeId) || list[0] || null;
}

export { cloneRow };
