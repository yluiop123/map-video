import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ProviderConfig } from '../types';
import { configFromPreset } from '../lib/providers';
import { IS_DESKTOP } from '../lib/backend';

type ProviderKind = 'llm' | 'tts' | 'image';

interface ProviderState {
  llm: ProviderConfig[];
  tts: ProviderConfig[];
  image: ProviderConfig[];
  activeLlmId: string | null;
  activeTtsId: string | null;
  activeImageId: string | null;
  addFromPreset: (presetId: string, kind: ProviderKind) => string;
  addCustom: (kind: ProviderKind) => string;
  update: (id: string, patch: Partial<ProviderConfig>) => void;
  remove: (id: string) => void;
  setActive: (kind: ProviderKind, id: string | null) => void;
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

const CUSTOM_PRESET: Record<ProviderKind, string> = { llm: 'custom-llm', tts: 'custom-tts', image: 'custom-image' };
const CUSTOM_LABEL: Record<ProviderKind, string> = { llm: '自定义文案 AI', tts: '自定义语音', image: '自定义图片 AI' };

export const useProviderStore = create<ProviderState>()(
  persist(
    (set, get) => ({
      llm: [],
      tts: [],
      image: [],
      activeLlmId: null,
      activeTtsId: null,
      activeImageId: null,
      addFromPreset: (presetId, kind) => {
        const cfg = configFromPreset(presetId, kind);
        set((s) => {
          const list = (kind === 'llm' ? s.llm : kind === 'tts' ? s.tts : s.image).concat(cfg);
          return {
            llm: kind === 'llm' ? list : s.llm,
            tts: kind === 'tts' ? list : s.tts,
            image: kind === 'image' ? list : s.image,
            ...(kind === 'llm'
              ? { activeLlmId: ensureActive(list, s.activeLlmId) }
              : kind === 'tts'
                ? { activeTtsId: ensureActive(list, s.activeTtsId) }
                : { activeImageId: ensureActive(list, s.activeImageId) }),
          };
        });
        dbSync(() => window.mapvideo!.providers.upsert(cfg));
        return cfg.id;
      },
      addCustom: (kind) => {
        const base = configFromPreset(CUSTOM_PRESET[kind], kind);
        const cfg = { ...base, label: CUSTOM_LABEL[kind] };
        set((s) => {
          const list = (kind === 'llm' ? s.llm : kind === 'tts' ? s.tts : s.image).concat(cfg);
          return {
            llm: kind === 'llm' ? list : s.llm,
            tts: kind === 'tts' ? list : s.tts,
            image: kind === 'image' ? list : s.image,
            ...(kind === 'llm'
              ? { activeLlmId: ensureActive(list, s.activeLlmId) }
              : kind === 'tts'
                ? { activeTtsId: ensureActive(list, s.activeTtsId) }
                : { activeImageId: ensureActive(list, s.activeImageId) }),
          };
        });
        dbSync(() => window.mapvideo!.providers.upsert(cfg));
        return cfg.id;
      },
      update: (id, patch) => {
        set((s) => ({
          llm: s.llm.map((c) => (c.id === id ? { ...c, ...patch } : c)),
          tts: s.tts.map((c) => (c.id === id ? { ...c, ...patch } : c)),
          image: s.image.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        }));
        const cfg = [...get().llm, ...get().tts, ...get().image].find((c) => c.id === id);
        if (cfg) dbSync(() => window.mapvideo!.providers.upsert(cfg));
      },
      remove: (id) => {
        set((s) => {
          const llm = s.llm.filter((c) => c.id !== id);
          const tts = s.tts.filter((c) => c.id !== id);
          const image = s.image.filter((c) => c.id !== id);
          return {
            llm,
            tts,
            image,
            activeLlmId: ensureActive(llm, s.activeLlmId),
            activeTtsId: ensureActive(tts, s.activeTtsId),
            activeImageId: ensureActive(image, s.activeImageId),
          };
        });
        dbSync(() => window.mapvideo!.providers.remove(id));
      },
      setActive: (kind, id) => {
        set(kind === 'llm' ? { activeLlmId: id } : kind === 'tts' ? { activeTtsId: id } : { activeImageId: id });
        dbSync(() => window.mapvideo!.providers.setActive(kind, id));
      },
      /** 桌面端启动时从 SQLite 加载 */
      hydrate: async () => {
        if (!IS_DESKTOP) return;
        try {
          const list = await window.mapvideo!.providers.list();
          const llm = list.filter((c) => c.kind === 'llm');
          const tts = list.filter((c) => c.kind === 'tts');
          const image = list.filter((c) => c.kind === 'image');
          const activeOf = (kind: ProviderKind, arr: ProviderConfig[]) =>
            list.find((c) => c.kind === kind && (c as ProviderConfig & { active?: number }).active === 1)?.id
            ?? ensureActive(arr, null);
          set({
            llm,
            tts,
            image,
            activeLlmId: activeOf('llm', llm),
            activeTtsId: activeOf('tts', tts),
            activeImageId: activeOf('image', image),
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
export function activeProvider(kind: ProviderKind): ProviderConfig | null {
  const s = useProviderStore.getState();
  const list = kind === 'llm' ? s.llm : kind === 'tts' ? s.tts : s.image;
  const activeId = kind === 'llm' ? s.activeLlmId : kind === 'tts' ? s.activeTtsId : s.activeImageId;
  const cfg = list.find((c) => c.id === activeId) || list[0];
  return cfg || null;
}
