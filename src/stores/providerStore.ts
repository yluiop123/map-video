import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ProviderConfig, ProviderEndpoint } from '../types';
import { configFromRecipe, endpointsOfRecipe } from '../lib/providers';
import { IS_DESKTOP } from '../lib/backend';

type ProviderKind = 'llm' | 'tts' | 'image';

interface ProviderState {
  llm: ProviderConfig[];
  tts: ProviderConfig[];
  image: ProviderConfig[];
  activeLlmId: string | null;
  activeTtsId: string | null;
  activeImageId: string | null;
  /** 按模板包新建（模板包 = 一家供应商配齐哪几个接口、各自怎么发） */
  addFromRecipe: (recipeId: string, kind: ProviderKind) => string;
  addCustom: (kind: ProviderKind) => string;
  update: (id: string, patch: Partial<ProviderConfig>) => void;
  /** 覆写某个接口的模板（「接口模板」页保存 / 恢复模板包默认） */
  updateEndpoint: (id: string, role: string, patch: Partial<ProviderEndpoint>) => void;
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

const LIST_OF: Record<ProviderKind, 'llm' | 'tts' | 'image'> = { llm: 'llm', tts: 'tts', image: 'image' };
const ACTIVE_OF: Record<ProviderKind, 'activeLlmId' | 'activeTtsId' | 'activeImageId'> = {
  llm: 'activeLlmId', tts: 'activeTtsId', image: 'activeImageId',
};
const CUSTOM_RECIPE: Record<ProviderKind, string> = { llm: 'custom-llm', tts: 'custom-tts', image: 'custom-image' };
const CUSTOM_LABEL: Record<ProviderKind, string> = { llm: '自定义文案 AI', tts: '自定义语音', image: '自定义图片 AI' };

/** 库里的配置可能还没有接口模板行（旧结构只有一个 protocol 字符串）—— 按模板包铺出来 */
function withEndpoints(cfg: ProviderConfig): ProviderConfig {
  return {
    ...cfg,
    endpoints: cfg.endpoints?.length ? cfg.endpoints : endpointsOfRecipe(cfg.recipe),
    secrets: { ...(cfg.secrets ?? {}), apiKey: cfg.secrets?.apiKey ?? '' },
  };
}

/** 新增一条供应商后的 state patch（三种 kind 走同一段逻辑，不再复制三遍） */
function appended(s: ProviderState, kind: ProviderKind, cfg: ProviderConfig): Partial<ProviderState> {
  const list = (s[LIST_OF[kind]] as ProviderConfig[]).concat(cfg);
  return { [LIST_OF[kind]]: list, [ACTIVE_OF[kind]]: ensureActive(list, s[ACTIVE_OF[kind]]) } as Partial<ProviderState>;
}

const mapAll = (s: ProviderState, fn: (c: ProviderConfig) => ProviderConfig) => ({
  llm: s.llm.map(fn),
  tts: s.tts.map(fn),
  image: s.image.map(fn),
});

export const useProviderStore = create<ProviderState>()(
  persist(
    (set, get) => ({
      llm: [],
      tts: [],
      image: [],
      activeLlmId: null,
      activeTtsId: null,
      activeImageId: null,
      addFromRecipe: (recipeId, kind) => {
        const cfg = configFromRecipe(recipeId, kind);
        set((s) => appended(s, kind, cfg));
        dbSync(() => window.mapvideo!.providers.upsert(cfg));
        return cfg.id;
      },
      addCustom: (kind) => {
        const cfg = { ...configFromRecipe(CUSTOM_RECIPE[kind], kind), label: CUSTOM_LABEL[kind] };
        set((s) => appended(s, kind, cfg));
        dbSync(() => window.mapvideo!.providers.upsert(cfg));
        return cfg.id;
      },
      update: (id, patch) => {
        set((s) => mapAll(s, (c) => (c.id === id ? { ...c, ...patch } : c)));
        const cfg = [...get().llm, ...get().tts, ...get().image].find((c) => c.id === id);
        if (cfg) dbSync(() => window.mapvideo!.providers.upsert(cfg));
      },
      updateEndpoint: (id, role, patch) => {
        set((s) => mapAll(s, (c) => (c.id === id
          ? { ...c, endpoints: (c.endpoints ?? []).map((e) => (e.role === role ? { ...e, ...patch } : e)) }
          : c)));
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
          const raw = await window.mapvideo!.providers.list();
          const list = raw.map(withEndpoints);
          const byKind = (kind: ProviderKind) => list.filter((c) => c.kind === kind);
          const llm = byKind('llm');
          const tts = byKind('tts');
          const image = byKind('image');
          const activeOf = (kind: ProviderKind, arr: ProviderConfig[]) =>
            list.find((c) => c.kind === kind && (c as ProviderConfig & { active?: boolean }).active === true)?.id
            ?? ensureActive(arr, null);
          set({
            llm,
            tts,
            image,
            activeLlmId: activeOf('llm', llm),
            activeTtsId: activeOf('tts', tts),
            activeImageId: activeOf('image', image),
          });
          // 旧库第一次跑：接口模板刚铺出来，写回去，下次启动不必再补。
          // 这里必须 await —— 早先是 fire-and-forget 的 dbSync，写失败只留一条 console.warn，
          // 实测桌面端启动后 provider_endpoint 仍是 0 行且无人发现（与 AGENTS §6.24 同一类「当场能用、重启就丢」）。
          const missing = raw.filter((r) => !r.endpoints?.length);
          for (const c of missing) {
            const filled = withEndpoints(c as ProviderConfig);
            await window.mapvideo!.providers.upsert(filled);
          }
          if (missing.length) console.log(`[providers] 已按模板包补齐 ${missing.length} 家供应商的接口模板`);
        } catch (e) {
          console.warn('[providers] SQLite 加载失败:', e);
        }
      },
    }),
    {
      // 换成接口模板结构后旧本地存储作废（按「不为兼容牺牲设计」直接换 key，不写迁移分支）
      name: 'mapvideo-providers.v2',
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
  return cfg ? withEndpoints(cfg) : null;
}
