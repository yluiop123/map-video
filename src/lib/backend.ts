/**
 * 运行形态（双端一体）：
 * - 桌面端（Electron）：preload 注入 window.mapvideo → Full 能力（AI 走主进程 IPC、SQLite 存储）
 * - 网页（GH Pages）：无注入 → Lite（AI/配音隐藏，IndexedDB + JSON 导入导出）
 * 无后端、无远程地址配置。
 */
import { create } from 'zustand';

declare global {
  interface Window {
    mapvideo?: {
      desktop: boolean;
      projects: {
        list: () => Promise<{ id: string; name: string; updatedAt: number; size: number; collectionId?: string }[]>;
        get: (id: string) => Promise<unknown>;
        save: (p: { id: string; name: string; data: unknown; collectionId?: string }) => Promise<{ id: string }>;
        remove: (id: string) => Promise<{ ok: boolean }>;
      };
      /** 合集：项目之上的一层分组（不指定归属时落默认合集） */
      collections: {
        list: () => Promise<{ id: string; name: string; order?: number; createdAt?: number; updatedAt?: number }[]>;
        save: (c: { id: string; name: string; order?: number }) => Promise<{ id: string }>;
        remove: (id: string) => Promise<{ ok: boolean; reason?: string }>;
      };
      /** 清空项目数据：项目 + 合集 + 素材（保留 providers），与网页端 clearAll 同义 */
      clearAll: () => Promise<{ ok: boolean }>;
      /** 公共图层库（跨项目）：把项目图层连元素复制过去 / 导入回项目 */
      publicLayers: {
        list: () => Promise<{ id: string; type: string; name: string; count: number; updatedAt?: number }[]>;
        save: (p: { layerId: string }) => Promise<{ id: string | null }>;
        import: (p: { publicLayerId: string; projectId: string }) => Promise<{ layerId: string | null }>;
        remove: (id: string) => Promise<{ ok: boolean }>;
      };
      providers: {
        list: () => Promise<import('../types').ProviderConfig[]>;
        upsert: (cfg: import('../types').ProviderConfig) => Promise<{ ok: boolean }>;
        remove: (id: string) => Promise<{ ok: boolean }>;
        setActive: (kind: 'llm' | 'tts' | 'image', id: string | null) => Promise<{ ok: boolean }>;
      };
      /** 素材仓库：图片 / GIF / 模型等大文件外置（assetId = sha256） */
      assets: {
        save: (p: { mime: string; bytes: Uint8Array; name?: string; kind?: string }) => Promise<{ assetId: string; relPath: string; byteSize: number }>;
        read: (assetId: string) => Promise<{ bytes: Uint8Array; mime?: string; name?: string } | null>;
        remove: (assetId: string) => Promise<{ ok: boolean }>;
        exists: (assetId: string) => Promise<boolean>;
        list: (kindPrefix?: string) => Promise<{ assetId: string; name: string; mime: string }[]>;
        stat: () => Promise<{ count: number; bytes: number; dir: string }>;
      };
      aiChat: (config: import('../types').ProviderConfig, system: string, user: string) => Promise<{ content?: string; error?: string }>;
      aiTts: (config: import('../types').ProviderConfig, text: string) => Promise<{ bytes?: Uint8Array; mime?: string; error?: string }>;
      aiImage: (config: import('../types').ProviderConfig, prompt: string) => Promise<{ image?: string; error?: string }>;
      aiVoiceClone: (config: import('../types').ProviderConfig, body: unknown) => Promise<{ voiceId?: string; error?: string }>;
      netJson: (url: string) => Promise<{ text?: string; error?: string }>;
      env: () => Promise<{ version: string; electron: string; node: string; userData: string }>;
      openExternal: (url: string) => void;
    };
  }
}

export const IS_DESKTOP = typeof window !== 'undefined' && !!window.mapvideo?.desktop;

export type AppMode = 'desktop' | 'web-full' | 'lite';

interface BackendState {
  ready: boolean;
  mode: AppMode;
}

/** mode 语义：
 *  - desktop：Electron 桌面端（AI 可用，走 IPC）
 *  - web-full：本地网页开发（vite 5173；AI 可用但浏览器直连，受 CORS 限制）
 *  - lite：纯静态（GH Pages；AI/配音隐藏） */
function detectMode(): AppMode {
  if (IS_DESKTOP) return 'desktop';
  if (typeof window !== 'undefined' && /^localhost|^127\./.test(window.location.hostname)) return 'web-full';
  return 'lite';
}

export const useBackendStore = create<BackendState>()(() => ({
  ready: true,
  mode: detectMode(),
}));

/** 兼容旧引用：AI 可用 = 桌面或本地网页开发 */
export function aiAvailable(): boolean {
  const m = useBackendStore.getState().mode;
  return m === 'desktop' || m === 'web-full';
}
