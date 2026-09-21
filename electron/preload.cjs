// MapVideo 桌面端 preload：向渲染进程暴露最小 IPC 面（contextIsolation 开启）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mapvideo', {
  desktop: true,
  projects: {
    list: () => ipcRenderer.invoke('db:projects:list'),
    get: (id) => ipcRenderer.invoke('db:projects:get', id),
    save: (p) => ipcRenderer.invoke('db:projects:save', p),
    remove: (id) => ipcRenderer.invoke('db:projects:remove', id),
  },
  collections: {
    list: () => ipcRenderer.invoke('db:collections:list'),
    save: (c) => ipcRenderer.invoke('db:collections:save', c),
    remove: (id) => ipcRenderer.invoke('db:collections:remove', id),
  },
  /** 公共图层库（跨项目）：把项目图层连元素复制过去 / 导入回项目 */
  publicLayers: {
    list: () => ipcRenderer.invoke('db:publicLayers:list'),
    save: (p) => ipcRenderer.invoke('db:publicLayers:save', p),          // p: { layerId }
    import: (p) => ipcRenderer.invoke('db:publicLayers:import', p),      // p: { publicLayerId, projectId }
    remove: (id) => ipcRenderer.invoke('db:publicLayers:remove', id),
  },
  /** 清空项目数据（项目 + 合集 + 素材），保留应用配置 providers */
  clearAll: () => ipcRenderer.invoke('db:clearAll'),
  providers: {
    list: () => ipcRenderer.invoke('db:providers:list'),
    upsert: (cfg) => ipcRenderer.invoke('db:providers:upsert', cfg),
    remove: (id) => ipcRenderer.invoke('db:providers:remove', id),
    setActive: (kind, id) => ipcRenderer.invoke('db:providers:setActive', { kind, id }),
  },
  assets: {
    save: (p) => ipcRenderer.invoke('assets:save', p),   // p: { mime, bytes, name?, kind? }
    read: (assetId) => ipcRenderer.invoke('assets:read', assetId),
    remove: (assetId) => ipcRenderer.invoke('assets:remove', assetId),
    exists: (assetId) => ipcRenderer.invoke('assets:exists', assetId),
    list: (kindPrefix) => ipcRenderer.invoke('assets:list', kindPrefix),
    stat: () => ipcRenderer.invoke('assets:stat'),
  },
  /** 通用网络：渲染进程按接口模板算好请求，主进程代发（无 CORS，Key 不出本机） */
  net: {
    request: (req) => ipcRenderer.invoke('net:request', req),
    fetchUrl: (url) => ipcRenderer.invoke('net:fetchUrl', url),
  },
  /** 主进程代拉 JSON/GeoJSON 文本（避开渲染进程 CORS） */
  netJson: (url) => ipcRenderer.invoke('net:json', url),
  env: () => ipcRenderer.invoke('env:get'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
});
