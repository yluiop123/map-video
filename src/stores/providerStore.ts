import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ProviderConfig } from '../types';
import { configFromPreset } from '../lib/providers';
import { IS_DESKTOP } from '../lib/backend';

interface ProviderState {
  llm: ProviderConfig[];
  tts: ProviderConfig[];
  activeLlmId: string | null;
  activeTtsId: string | null;
  addFromPreset: (presetId: string, kind: 'llm' | 'tts') => string;
  addCustom: (kind: 'llm' | 'tts') => string;
  update: (id: string, patch: Partial<ProviderConfig>) => void;
  remove: (id: string) => void;
  setActive: (kind: 'llm' | 'tts', id: string | null) => void;
  hydrate: () => Promise<void>;
}

function ensureActive(cfgs: ProviderConfig[], activeId: string | null): string | null {
  if (activeId && cfgs.some((c) => c.id === activeId)) return activeId;
  return cfgs[0]?.id ?? null;
}

/** 桌面端写穿 SQLite（web 模式 persist 到 localStorage，无需写库） */
function dbSync(action: () => Promise<unknown>): void {
  if (!IS_DESKTOP) return;
  action().catch((e) => console.warn('[providers] SQLite 同步失败:', e));
}

export const useProviderStore = create<ProviderState>()(
  persist(
    (set, get) => ({
      llm: [],
      tts: [],
      activeLlmId: null,
      activeTtsId: null,
      addFromPreset: (presetId, kind) => {
        const cfg = configFromPreset(presetId, kind);
        set((s) => {
          const list = kind === 'llm' ? [...s.llm, cfg] : [...s.tts, cfg];
          return {
            llm: kind === 'llm' ? list : s.llm,
            tts: kind === 'tts' ? list : s.tts,
            ...(kind === 'llm'
              ? { activeLlmId: ensureActive(list, s.activeLlmId) }
              : { activeTtsId: ensureActive(list, s.activeTtsId) }),
          };
        });
        dbSync(() => window.mapvideo!.providers.upsert(cfg));
        return cfg.id;
      },
      addCustom: (kind) => {
        const base = configFromPreset(kind === 'llm' ? 'custom-llm' : 'custom-tts', kind);
        const cfg = { ...base, label: kind === 'llm' ? '自定义 AI' : '自定义配音', id: `${base.id}` };
        set((s) => {
          const list = kind === 'llm' ? [...s.llm, cfg] : [...s.tts, cfg];
          return {
            llm: kind === 'llm' ? list : s.llm,
            tts: kind === 'tts' ? list : s.tts,
            ...(kind === 'llm'
              ? { activeLlmId: ensureActive(list, s.activeLlmId) }
              : { activeTtsId: ensureActive(list, s.activeTtsId) }),
          };
        });
        dbSync(() => window.mapvideo!.providers.upsert(cfg));
        return cfg.id;
      },
      update: (id, patch) => {
        set((s) => ({
          llm: s.llm.map((c) => (c.id === id ? { ...c, ...patch } : c)),
          tts: s.tts.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        }));
        const cfg = [...get().llm, ...get().tts].find((c) => c.id === id);
        if (cfg) dbSync(() => window.mapvideo!.providers.upsert(cfg));
      },
      remove: (id) => {
        set((s) => {
          const llm = s.llm.filter((c) => c.id !== id);
          const tts = s.tts.filter((c) => c.id !== id);
          return {
            llm,
            tts,
            activeLlmId: ensureActive(llm, s.activeLlmId),
            activeTtsId: ensureActive(tts, s.activeTtsId),
          };
        });
        dbSync(() => window.mapvideo!.providers.remove(id));
      },
      setActive: (kind, id) => {
        set(kind === 'llm' ? { activeLlmId: id } : { activeTtsId: id });
        dbSync(() => window.mapvideo!.providers.setActive(kind, id));
      },
      /** 桌面端启动时从 SQLite 加载 */
      hydrate: async () => {
        if (!IS_DESKTOP) return;
        try {
          const list = await window.mapvideo!.providers.list();
          const llm = list.filter((c) => c.kind === 'llm');
          const tts = list.filter((c) => c.kind === 'tts');
          // active 标记以库为准；无标记取第一个
          const activeLlmRow = list.find((c) => c.kind === 'llm' && (c as ProviderConfig & { active?: number }).active === 1);
          const activeTtsRow = list.find((c) => c.kind === 'tts' && (c as ProviderConfig & { active?: number }).active === 1);
          set({
            llm,
            tts,
            activeLlmId: activeLlmRow?.id ?? ensureActive(llm, null),
            activeTtsId: activeTtsRow?.id ?? ensureActive(tts, null),
          });
        } catch (e) {
          console.warn('[providers] SQLite 加载失败:', e);
        }
      },
    }),
    {
      name: 'mapvideo-providers',
      // 桌面端以 SQLite 为源，跳过 localStorage 持久化
      skipHydration: false,
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
export function activeProvider(kind: 'llm' | 'tts'): ProviderConfig | null {
  const s = useProviderStore.getState();
  const list = kind === 'llm' ? s.llm : s.tts;
  const activeId = kind === 'llm' ? s.activeLlmId : s.activeTtsId;
  const cfg = list.find((c) => c.id === activeId) || list[0];
  return cfg || null;
}
