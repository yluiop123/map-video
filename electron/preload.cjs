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
  providers: {
    list: () => ipcRenderer.invoke('db:providers:list'),
    upsert: (cfg) => ipcRenderer.invoke('db:providers:upsert', cfg),
    remove: (id) => ipcRenderer.invoke('db:providers:remove', id),
    setActive: (kind, id) => ipcRenderer.invoke('db:providers:setActive', { kind, id }),
  },
  assets: {
    save: (p) => ipcRenderer.invoke('assets:save', p),
    read: (assetId) => ipcRenderer.invoke('assets:read', assetId),
    remove: (assetId) => ipcRenderer.invoke('assets:remove', assetId),
    exists: (assetId) => ipcRenderer.invoke('assets:exists', assetId),
    stat: () => ipcRenderer.invoke('assets:stat'),
  },
  aiChat: (config, system, user) => ipcRenderer.invoke('ai:chat', { config, system, user }),
  aiTts: (config, text) => ipcRenderer.invoke('ai:tts', { config, text }),
  env: () => ipcRenderer.invoke('env:get'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
});
