import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { blankTemplate, seedCopy, seedTemplate } from '../lib/template-seed';
import type { Category, InstanceDef, InstanceValues, TemplateDef } from '../lib/request-engine';
import { IS_DESKTOP } from '../lib/backend';

/**
 * providerStore.ts — 接口模板（共享数据） + 能力实例（凭证与取值）两份账
 *
 * 一份模板可以配多条实例（一个能力多套账号），调用处选一条实例用；
 * 「选哪条」是会话内状态（picked），不入库 —— 入库的是实例本身。
 * 设计口径见 docs/provider-engine.md；模板形状与求值在 lib/request-engine.ts。
 */

interface ProviderState {
  templates: TemplateDef[];
  instances: InstanceDef[];
  /** 每个能力当前选用的实例（不入库；没选就是该能力的第一条） */
  picked: Record<Category, string | null>;

  categoryOf: (tplId: string) => Category | undefined;
  instancesOf: (category: Category) => InstanceDef[];
  /** 该能力当前拿来调用的那个实例 */
  current: (category: Category) => InstanceDef | null;
  pick: (category: Category, providerId: string | null) => void;
  /** 新建一条实例（模板建议值照抄，Key 只能他自己填） */
  addInstance: (category: Category, tplId?: string) => InstanceDef;
  saveInstance: (inst: InstanceDef) => void;
  updateInstance: (providerId: string, patch: Partial<InstanceDef>, valuesPatch?: InstanceValues) => void;
  removeInstance: (providerId: string) => void;

  templateOf: (tplId: string) => TemplateDef | undefined;
  templatesOf: (category: Category) => TemplateDef[];
  saveTemplate: (t: TemplateDef) => void;
  addTemplate: (category: Category) => TemplateDef;
  removeTemplate: (tplId: string) => void;
  /** 丢弃本地改动，取回内置默认形状 */
  restoreTemplate: (tplId: string) => void;

  hydrate: () => Promise<void>;
}

const rid = () => Math.random().toString(36).slice(2, 8);
export const CATEGORIES: Category[] = ['llm', 'tts', 'image'];

/** 单飞：同一时刻只允许一次 hydrate 真的在跑 */
let hydrating: Promise<void> | null = null;

/** 一条新实例：只抄模板建议的形状，凭证一律空（Key 只有用户能填） */
function draftInstance(tpl: TemplateDef): InstanceDef {
  return {
    id: `prov_${tpl.category}_${rid()}`,
    tplId: tpl.id,
    name: tpl.name,
    // 模板只配了异步就没得选同步
    sync: !tpl.async?.submit,
    // 取值全在这两包里：baseUrl / 密钥都是模板声明出来的普通参数
    values: { instance: {}, requests: {} },
  };
}

export const useProviderStore = create<ProviderState>()(
  persist(
    (set, get) => ({
      templates: seedCopy(),
      instances: [],
      picked: { llm: null, tts: null, image: null },

      categoryOf: (tplId) => get().templates.find((t) => t.id === tplId)?.category,
      instancesOf: (category) => {
        const ids = new Set(get().templates.filter((t) => t.category === category).map((t) => t.id));
        return get().instances.filter((i) => ids.has(i.tplId));
      },
      current: (category) => {
        const list = get().instancesOf(category);
        return list.find((i) => i.id === get().picked[category]) ?? list[0] ?? null;
      },
      pick: (category, providerId) => set((s) => ({ picked: { ...s.picked, [category]: providerId } })),

      addInstance: (category, tplId) => {
        const tpl = get().templates.find((t) => t.id === tplId)
          ?? get().templates.find((t) => t.category === category)
          ?? blankTemplate(category);
        const inst = draftInstance(tpl);
        set((s) => ({ instances: [...s.instances, inst], picked: { ...s.picked, [category]: inst.id } }));
        if (IS_DESKTOP) window.mapvideo!.providers.upsert(inst).catch((e) => console.warn('[providers] SQLite 同步失败:', e));
        return inst;
      },
      saveInstance: (inst) => {
        set((s) => ({
          instances: s.instances.some((i) => i.id === inst.id)
            ? s.instances.map((i) => (i.id === inst.id ? inst : i))
            : [...s.instances, inst],
        }));
        if (IS_DESKTOP) window.mapvideo!.providers.upsert(inst).catch((e) => console.warn('[providers] SQLite 同步失败:', e));
      },
      updateInstance: (providerId, patch, valuesPatch) => {
        const cur = get().instances.find((i) => i.id === providerId);
        if (!cur) return;
        const values: InstanceValues = {
          instance: { ...(cur.values.instance ?? {}), ...(valuesPatch?.instance ?? {}) },
          requests: { ...(cur.values.requests ?? {}), ...(valuesPatch?.requests ?? {}) },
        };
        get().saveInstance({ ...cur, ...patch, values });
      },
      removeInstance: (providerId) => {
        set((s) => ({
          instances: s.instances.filter((i) => i.id !== providerId),
          picked: Object.fromEntries(
            CATEGORIES.map((c) => [c, s.picked[c] === providerId ? null : s.picked[c]]),
          ) as Record<Category, string | null>,
        }));
        if (IS_DESKTOP) window.mapvideo!.providers.remove(providerId).catch((e) => console.warn('[providers] 删除失败:', e));
      },

      templateOf: (tplId) => get().templates.find((t) => t.id === tplId),
      templatesOf: (category) => get().templates.filter((t) => t.category === category),
      saveTemplate: (t) => {
        set((s) => ({
          templates: s.templates.some((x) => x.id === t.id)
            ? s.templates.map((x) => (x.id === t.id ? t : x))
            : [...s.templates, t],
        }));
        if (IS_DESKTOP) window.mapvideo!.templates.save(t).catch((e) => console.warn('[templates] SQLite 同步失败:', e));
      },
      addTemplate: (category) => {
        const t: TemplateDef = { ...blankTemplate(category), id: `custom-${category}-${rid()}`, name: `自定义 ${category} ${rid()}` };
        get().saveTemplate(t);
        return t;
      },
      removeTemplate: (tplId) => {
        const doomed = get().instances.filter((i) => i.tplId === tplId);
        set((s) => ({
          templates: s.templates.filter((t) => t.id !== tplId),
          instances: s.instances.filter((i) => i.tplId !== tplId),
        }));
        if (!IS_DESKTOP) return;
        // 实例对 tpl_id 是真外键：先把靠它的实例删掉，再删模板，别让库拦一下就算完
        for (const i of doomed) window.mapvideo!.providers.remove(i.id).catch((e) => console.warn('[providers] 删除失败:', e));
        window.mapvideo!.templates.remove(tplId).catch((e) => console.warn('[templates] 删除失败:', e));
      },
      restoreTemplate: (tplId) => {
        const seed = seedTemplate(tplId);
        if (seed) get().saveTemplate(structuredClone(seed));
      },

      /** 桌面端启动时从 SQLite 加载；库里一份模板都没有时按 seed 铺一次表 */
      hydrate: async () => {
        if (!IS_DESKTOP) return;
        // StrictMode 会把 effect 跑两遍，两次并发 hydrate 会各自铺一遍 seed（幂等但白写一遍库）
        if (hydrating) return hydrating;
        hydrating = (async () => {
          try {
            let templates = await window.mapvideo!.templates.list();
            if (!templates.length) {
              for (const t of seedCopy()) await window.mapvideo!.templates.save(t);
              templates = await window.mapvideo!.templates.list();
              console.log(`[templates] 已按内置 seed 铺出 ${templates.length} 份接口模板`);
            }
            // 旧形状（每能力一条 / 模板组那两套）在这一步搬回 —— 必须等模板就位，provider.tpl_id 是真外键
            await window.mapvideo!.providers.migrate();
            const rows = await window.mapvideo!.providers.list();
            const catOf = new Map(templates.map((t) => [t.id, t.category]));
            // 引用不到的实例（模板被删过）留着也没法用：不载入并说一句，别让界面出现空壳条目
            const instances = rows.filter((i) => catOf.has(i.tplId));
            if (instances.length !== rows.length)
              console.warn(`[providers] ${rows.length - instances.length} 条实例引用的模板已不存在，未载入（去实例设置重建）`);
            const picked = {} as Record<Category, string | null>;
            for (const c of CATEGORIES) picked[c] = instances.find((i) => catOf.get(i.tplId) === c)?.id ?? null;
            set({ templates, instances, picked });
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
      // 换成「一份模板一行 + 多实例」后旧本地存储作废（按「不为兼容牺牲设计」直接换 key）
      name: 'mapvideo-providers.v5',
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

/** 该能力当前拿来调用的实例（没配过是 null） */
export function currentInstance(category: Category): InstanceDef | null {
  return useProviderStore.getState().current(category);
}
