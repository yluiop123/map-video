import type maplibregl from 'maplibre-gl';

/**
 * 编辑器地图实例的共享引用。
 * MapSearchBox 渲染在 TopBar（远离 EditableMap），通过这里拿到当前地图实例做跳转。
 */
let current: maplibregl.Map | null = null;

export const sharedMap = {
  get: () => current,
  set: (m: maplibregl.Map | null) => { current = m; },
};

// 调试便捷入口（生产无副作用）
if (typeof window !== 'undefined') (window as any).__sharedMap = sharedMap;
