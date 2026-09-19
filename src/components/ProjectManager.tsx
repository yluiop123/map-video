import { useState, useEffect, useRef } from 'react';
import { useProjectStore, isProjectNameTaken } from '../stores/projectStore';
import { useConfirm } from './ui/ConfirmHost';
import { IS_DESKTOP } from '../lib/backend';
import { storage } from '../lib/storage';
import type { MapVideoProject, ProjectExport, Collection } from '../types';
import { generateId, DEFAULT_COLLECTION_ID, DEFAULT_COLLECTION_NAME } from '../types';

/** 「全部项目」虚拟视图 id（仅用于 UI 过滤，不落库） */
const ALL_ID = '__all__';

export function ProjectManager() {
  const [projects, setProjects] = useState<MapVideoProject[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [activeId, setActiveId] = useState<string>(DEFAULT_COLLECTION_ID);
  const [newName, setNewName] = useState('');
  const [newCollection, setNewCollection] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [createError, setCreateError] = useState('');
  const { createProject, loadProject, deleteProject, listProjects, importProjectConfig } = useProjectStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();

  const reload = async () => {
    setProjects(await listProjects());
    setCollections(await storage.listCollections());
  };

  useEffect(() => {
    void reload();
  }, [listProjects]);

  const collectionOf = (p: MapVideoProject) => p.collectionId || DEFAULT_COLLECTION_ID;
  const nameOf = (id: string) =>
    id === DEFAULT_COLLECTION_ID
      ? DEFAULT_COLLECTION_NAME
      : collections.find((c) => c.id === id)?.name || DEFAULT_COLLECTION_NAME;

  const targetCollectionId = activeId === ALL_ID ? DEFAULT_COLLECTION_ID : activeId;
  const visibleProjects =
    activeId === ALL_ID ? projects : projects.filter((p) => collectionOf(p) === activeId);
  const countOf = (id: string) =>
    id === ALL_ID ? projects.length : projects.filter((p) => collectionOf(p) === id).length;

  const itemCls = (on: boolean) =>
    `w-full flex items-center justify-between gap-1 px-2.5 py-1.5 rounded-md text-sm text-left transition-colors ${
      on ? 'bg-white/[0.1] text-foreground font-medium' : 'text-foreground/75 hover:bg-white/[0.05]'
    }`;

  const nameDuplicated = isProjectNameTaken(newName, projects.map((p) => p.name));

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    if (isProjectNameTaken(name, projects.map((p) => p.name))) {
      setCreateError('已存在同名项目，请换一个名称');
      return;
    }
    try {
      await createProject(name, targetCollectionId);
      setNewName('');
      setCreateError('');
      await reload();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : '创建失败');
    }
  };

  const handleAddCollection = async () => {
    const name = newCollection.trim();
    if (!name) return;
    const now = new Date();
    const c: Collection = { id: generateId(), name, order: collections.length, createdAt: now, updatedAt: now };
    await storage.saveCollection(c);
    setNewCollection('');
    setCollections(await storage.listCollections());
    setActiveId(c.id);
  };

  const handleRename = async (c: Collection) => {
    // 默认合集不可改名（名称由常量决定）
    if (c.id === DEFAULT_COLLECTION_ID) { setRenamingId(null); return; }
    const name = renameValue.trim();
    setRenamingId(null);
    if (!name || name === c.name) return;
    await storage.saveCollection({ ...c, name });
    setCollections(await storage.listCollections());
  };

  const handleDeleteCollection = async (c: Collection) => {
    const ok = await confirm({
      message: `删除合集「${c.name}」？其中的项目会移到「${DEFAULT_COLLECTION_NAME}」，项目本身不会被删除。`,
      danger: true,
      confirmText: '删除合集',
    });
    if (!ok) return;
    await storage.removeCollection(c.id);
    if (activeId === c.id) setActiveId(DEFAULT_COLLECTION_ID);
    await reload();
  };

  const handleDelete = async (id: string) => {
    const ok = await confirm({ message: '确定删除此项目？', danger: true, confirmText: '删除' });
    if (!ok) return;
    await deleteProject(id);
    setProjects((prev) => prev.filter((p) => p.id !== id));
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text) as ProjectExport;
      if (!data.project) {
        alert('无效的配置文件');
        return;
      }
      await importProjectConfig(data, targetCollectionId);
      await reload();
    } catch (err) {
      console.error(err);
      alert(err instanceof Error && err.message ? `导入失败：${err.message}` : '导入失败，请检查文件格式');
    } finally {
      e.target.value = '';
    }
  };

  return (
    <div className="h-screen flex items-center justify-center bg-background p-4">
      <div className="w-[880px] max-w-full max-h-[92vh] bg-card border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2.5 py-5 border-b border-white/10 shrink-0">
          <div className="h-9 w-9 rounded-xl bg-white/10 flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-foreground">
              <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">MapVideo</h1>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左：合集栏 */}
          <aside className="w-56 shrink-0 border-r border-white/10 p-4 flex flex-col min-h-0">
            <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2">合集</h2>
            <div className="flex-1 overflow-y-auto space-y-1">
              <button onClick={() => setActiveId(ALL_ID)} className={itemCls(activeId === ALL_ID)}>
                <span className="truncate">全部项目</span>
                <span className="text-xs text-muted-foreground shrink-0">{projects.length}</span>
              </button>
              {collections.map((c) => {
                const immutable = c.id === DEFAULT_COLLECTION_ID;
                if (renamingId === c.id) {
                  return (
                    <input
                      key={c.id}
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => handleRename(c)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRename(c);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      className="w-full px-2.5 py-1.5 border border-brand/60 bg-white/[0.06] rounded-md text-sm outline-none"
                    />
                  );
                }
                return (
                  <div key={c.id} className="group relative">
                    <button onClick={() => setActiveId(c.id)} className={itemCls(activeId === c.id)}>
                      <span className="truncate">{c.name}</span>
                      <span className={`text-xs text-muted-foreground shrink-0 ${immutable ? '' : 'group-hover:hidden'}`}>{countOf(c.id)}</span>
                    </button>
                    {/* 默认合集不可改名、不可删除 → 不渲染任何操作项 */}
                    {!immutable && (
                      <div className="hidden group-hover:flex items-center gap-1.5 absolute right-2 top-1/2 -translate-y-1/2 text-xs">
                        <span
                          onClick={(e) => { e.stopPropagation(); setRenamingId(c.id); setRenameValue(c.name); }}
                          className="cursor-pointer text-muted-foreground hover:text-foreground"
                          title="重命名"
                        >
                          改名
                        </span>
                        <span
                          onClick={(e) => { e.stopPropagation(); void handleDeleteCollection(c); }}
                          className="cursor-pointer text-red-400/80 hover:text-red-400"
                          title="删除合集（项目移入默认合集）"
                        >
                          删除
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex gap-1.5 shrink-0">
              <input
                value={newCollection}
                onChange={(e) => setNewCollection(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddCollection()}
                placeholder="新建合集"
                className="flex-1 min-w-0 px-2.5 py-1.5 border border-white/10 bg-white/[0.045] rounded-md text-sm"
              />
              <button
                onClick={handleAddCollection}
                className="px-2.5 py-1.5 border border-white/10 bg-white/[0.03] rounded-md text-sm hover:bg-white/[0.08]"
                title="新建合集"
              >
                ＋
              </button>
            </div>
          </aside>

          {/* 右：项目区 */}
          <main className="flex-1 min-w-0 overflow-y-auto p-5">
            {/* 新建项目（归属当前合集） */}
            <div className="mb-5">
              <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2">
                新建项目<span className="normal-case tracking-normal"> · 归属「{nameOf(targetCollectionId)}」</span>
              </h2>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => { setNewName(e.target.value); setCreateError(''); }}
                  placeholder="项目名称"
                  className={`flex-1 px-3 py-2 border bg-white/[0.045] rounded-md text-sm ${nameDuplicated ? 'border-red-500/60' : 'border-white/10'}`}
                  onKeyDown={(e) => e.key === 'Enter' && !nameDuplicated && handleCreate()}
                />
                <button
                  onClick={handleCreate}
                  disabled={!newName.trim() || nameDuplicated}
                  className="px-4 py-2 bg-white text-black rounded-md text-sm font-medium hover:bg-white/90 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white"
                >
                  创建
                </button>
              </div>
              <p className={`text-xs mt-1.5 ${nameDuplicated || createError ? 'text-red-400' : 'text-muted-foreground'}`}>
                {createError || (nameDuplicated ? '已存在同名项目，请换一个名称' : `未选择合集时自动存入「${DEFAULT_COLLECTION_NAME}」。`)}
              </p>
            </div>

            {/* 导入 */}
            <div className="mb-5">
              <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2">导入项目</h2>
              <input ref={fileRef} type="file" accept=".json,.geojson" className="hidden" onChange={handleImportFile} />
              <button
                onClick={() => fileRef.current?.click()}
                className="w-full px-4 py-2 border border-white/10 bg-white/[0.03] rounded-md text-sm hover:bg-white/[0.07] transition-colors"
              >
                📂 导入配置文件（归入「{nameOf(targetCollectionId)}」）
              </button>
              <p className="text-xs text-muted-foreground mt-1">支持导入导出的 .json 配置</p>
            </div>

            {/* 存储形态 */}
            <div className="mb-5">
              <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2">
                存储 {IS_DESKTOP ? '· 桌面版（SQLite 本地库）' : '· 浏览器（IndexedDB）'}
              </h2>
              <p className="text-xs text-muted-foreground">
                {IS_DESKTOP
                  ? '项目、合集与 AI/配音配置存本机数据库；AI 与配音在字幕/音乐页签使用。'
                  : '纯前端模式：数据存浏览器 IndexedDB，可导出/导入 JSON 迁移；AI/配音需桌面版。'}
              </p>
            </div>

            {/* 项目列表 */}
            <div>
              <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2">
                {activeId === ALL_ID ? '全部项目' : `「${nameOf(activeId)}」的项目`}
                <span className="ml-1.5 text-muted-foreground/60">{visibleProjects.length}</span>
              </h2>
              {visibleProjects.length === 0 ? (
                <p className="text-sm text-muted-foreground">暂无项目</p>
              ) : (
                <div className="space-y-2">
                  {visibleProjects.map((project) => (
                    <div
                      key={project.id}
                      className="flex items-center justify-between p-3 border border-white/10 bg-white/[0.03] rounded-lg hover:bg-white/[0.07] hover:border-white/20 cursor-pointer transition-colors"
                      onClick={() => loadProject(project.id)}
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-sm truncate">{project.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {activeId === ALL_ID && <span className="mr-2">📁 {nameOf(collectionOf(project))}</span>}
                          {new Date(project.updatedAt).toLocaleDateString()}
                        </div>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); void handleDelete(project.id); }}
                        className="text-red-400/80 hover:text-red-400 text-sm shrink-0 ml-3"
                      >
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
