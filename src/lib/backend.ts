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
        list: () => Promise<{ id: string; name: string; updatedAt: number; size: number }[]>;
        get: (id: string) => Promise<unknown>;
        save: (p: { id: string; name: string; data: unknown }) => Promise<{ id: string }>;
        remove: (id: string) => Promise<{ ok: boolean }>;
      };
      providers: {
        list: () => Promise<import('../types').ProviderConfig[]>;
        upsert: (cfg: import('../types').ProviderConfig) => Promise<{ ok: boolean }>;
        remove: (id: string) => Promise<{ ok: boolean }>;
        setActive: (kind: 'llm' | 'tts', id: string | null) => Promise<{ ok: boolean }>;
      };
      aiChat: (config: import('../types').ProviderConfig, system: string, user: string) => Promise<{ content?: string; error?: string }>;
      aiTts: (config: import('../types').ProviderConfig, text: string) => Promise<{ bytes?: Uint8Array; mime?: string; error?: string }>;
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
