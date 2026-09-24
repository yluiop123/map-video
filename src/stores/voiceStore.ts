/**
 * voiceStore — 克隆音色账本（`voice` 表）
 *
 * 为什么这份账本必须在库里而不是 localStorage：voiceId 绑「哪个实例 + 哪个目标模型」，
 * 还要记住参考音频原件（音色失效时靠它重建）、fileId 与各自的过期时间。
 * 存 localStorage 的话换台机器/清一次缓存，服务端建好的音色就在界面上永远找不回来了。
 *
 * 幂等键是 `(providerId, sourceHash, targetModel)`（库里是同一条唯一索引）：
 * 同一份样本重复点只会有一行，`status` 就是抢占标志。
 */
import { create } from 'zustand';
import type { VoiceRow } from '../types';
import type { InstanceDef } from '../lib/request-engine';
import { IS_DESKTOP } from '../lib/backend';
import { putAssetBytes } from '../lib/assets';
import { cloneVoice } from '../lib/providers';

/** 参考音频内容哈希（幂等键的一维）。FNV-1a 64bit 足够：只用来判「同一份字节」 */
export function hashBytes(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= BigInt(bytes[i]);
    h = BigInt.asUintN(64, h * prime);
  }
  return h.toString(16).padStart(16, '0');
}

interface VoiceState {
  rows: VoiceRow[];
  hydrate: () => Promise<void>;
  /** 这一行能不能直接用：已就绪且没过期 */
  usable: (v: VoiceRow) => boolean;
  /** 同实例 + 同样本 + 同模型已有的那条（可能还在 cloning / 已失败） */
  findFor: (providerId: string, sourceHash: string, targetModel: string) => VoiceRow | undefined;
  /** 该实例在这个模型下的可用音色 */
  readyFor: (providerId: string, targetModel: string) => VoiceRow[];
  /**
   * 参考音频 → 音色 ID。已有可用条目直接复用（不重复建），否则先落一行 `cloning` 再真克隆。
   * 失败不吞：写回 `failed` + 原因，界面上要看得见为什么没成。
   */
  clone: (o: {
    inst: InstanceDef; bytes: ArrayBuffer; mime: string; name: string;
    label: string; targetModel: string; prefix: string;
  }) => Promise<VoiceRow>;
  remove: (rowId: string) => Promise<void>;
}

const toU8 = (buf: ArrayBuffer) => new Uint8Array(buf);

export const useVoiceStore = create<VoiceState>((set, get) => ({
  rows: [],

  hydrate: async () => {
    if (!IS_DESKTOP) return;
    try {
      set({ rows: await window.mapvideo!.voices.list() });
    } catch (e) {
      console.warn('[voices] 读取失败:', e);
    }
  },

  usable: (v) => v.status === 'ready' && !!v.voiceId && (!v.voiceIdExpiresAt || v.voiceIdExpiresAt > Date.now()),

  findFor: (providerId, sourceHash, targetModel) =>
    get().rows.find((x) => x.providerId === providerId && x.sourceHash === sourceHash && x.targetModel === targetModel),

  readyFor: (providerId, targetModel) =>
    get().rows.filter((x) => x.providerId === providerId && x.targetModel === targetModel && get().usable(x)),

  clone: async ({ inst, bytes, mime, name, label, targetModel, prefix }) => {
    const hash = hashBytes(toU8(bytes));
    const hit = get().findFor(inst.id, hash, targetModel);
    if (hit && get().usable(hit)) return hit;

    const base = {
      rowId: hit?.rowId ?? `vc_${Math.random().toString(36).slice(2, 10)}`,
      providerId: inst.id, sourceHash: hash, targetModel, label,
      attempts: (hit?.attempts ?? 0) + 1, createdAt: hit?.createdAt ?? Date.now(),
    };
    let assetId = hit?.sourceAssetId;
    try {
      // 原件先入库再占行：`source_asset_id` 是 NOT NULL —— 账本上每一行都必须带着能重建自己的那段音频
      assetId ??= (await putAssetBytes(toU8(bytes), mime, name, 'audio')).assetId;
      // 先占住这一行：并发的第二次点同一个样本会读到 cloning，而不再往服务端建第二条音色
      await writeRow({ ...base, sourceAssetId: assetId, status: 'cloning' });
      const voiceId = await cloneVoice(inst, bytes, targetModel, prefix);
      return await writeRow({ ...base, sourceAssetId: assetId, voiceId, status: 'ready' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (assetId) await writeRow({ ...base, sourceAssetId: assetId, status: 'failed', error: msg });
      throw e;
    }
  },

  remove: async (rowId) => {
    set((s) => ({ rows: s.rows.filter((x) => x.rowId !== rowId) }));
    if (IS_DESKTOP) await window.mapvideo!.voices.remove(rowId);
  },
}));

/** 写一行并同步内存态（web 模式没有库，只在内存里走一遍，界面对它透明） */
async function writeRow(row: VoiceRow): Promise<VoiceRow> {
  const stamped = { ...row, updatedAt: Date.now() };
  if (IS_DESKTOP) {
    const r = await window.mapvideo!.voices.save(stamped);
    stamped.rowId = r.rowId;
  }
  useVoiceStore.setState((s) => ({
    rows: s.rows.some((x) => x.rowId === stamped.rowId)
      ? s.rows.map((x) => (x.rowId === stamped.rowId ? stamped : x))
      : [stamped, ...s.rows],
  }));
  return stamped;
}
