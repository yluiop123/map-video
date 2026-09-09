import { useState, useEffect, useRef } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useConfirm } from './ui/ConfirmHost';
import { IS_DESKTOP } from '../lib/backend';
import type { MapVideoProject, ProjectExport } from '../types';

export function ProjectManager() {
  const [projects, setProjects] = useState<MapVideoProject[]>([]);
  const [newName, setNewName] = useState('');
  const { createProject, loadProject, deleteProject, listProjects, importProjectConfig } = useProjectStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();

  useEffect(() => {
    listProjects().then(setProjects);
  }, [listProjects]);

  const handleCreate = () => {
    if (!newName.trim()) return;
    createProject(newName.trim());
    setNewName('');
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
      importProjectConfig(data);
      setProjects(await listProjects());
    } catch (err) {
      console.error(err);
      alert('导入失败，请检查文件格式');
    } finally {
      e.target.value = '';
    }
  };

  return (
    <div className="h-screen flex items-center justify-center bg-background">
      <div className="w-96 max-h-[92vh] overflow-y-auto bg-card border border-white/10 rounded-2xl shadow-2xl p-6">
        <div className="flex items-center justify-center gap-2.5 mb-6">
          <div className="h-9 w-9 rounded-xl bg-white/10 flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-foreground">
              <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold tracking-tight">MapVideo</h1>
        </div>

        {/* 新建项目 */}
        <div className="mb-6">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2">新建项目</h2>
          <div className="flex gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="项目名称"
              className="flex-1 px-3 py-2 border border-white/10 bg-white/[0.045] rounded-md text-sm"
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
            <button
              onClick={handleCreate}
              className="px-4 py-2 bg-white text-black rounded-md text-sm font-medium hover:bg-white/90"
            >
              创建
            </button>
          </div>
        </div>

        {/* 导入项目 */}
        <div className="mb-6">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2">导入项目</h2>
          <input ref={fileRef} type="file" accept=".json,.geojson" className="hidden" onChange={handleImportFile} />
          <button
            onClick={() => fileRef.current?.click()}
            className="w-full px-4 py-2 border border-white/10 bg-white/[0.03] rounded-md text-sm hover:bg-white/[0.07] transition-colors"
          >
            📂 导入配置文件
          </button>
          <p className="text-xs text-muted-foreground mt-1">支持导入导出的 .json 配置</p>
        </div>

        {/* 存储形态说明 */}
        <div className="mb-6">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2">
            存储 {IS_DESKTOP ? '· 桌面版（SQLite 本地库）' : '· 浏览器（IndexedDB）'}
          </h2>
          <p className="text-xs text-muted-foreground">
            {IS_DESKTOP
              ? '项目与 AI/配音配置存本机数据库；AI 与配音在字幕/音乐页签使用。'
              : '纯前端模式：数据存浏览器 IndexedDB，可导出/导入 JSON 迁移；AI/配音需桌面版。'}
          </p>
        </div>

        {/* 项目列表 */}
        <div>
          <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2">最近项目</h2>
          {projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无项目</p>
          ) : (
            <div className="space-y-2">
              {projects.map((project) => (
                <div
                  key={project.id}
                  className="flex items-center justify-between p-3 border border-white/10 bg-white/[0.03] rounded-lg hover:bg-white/[0.07] hover:border-white/20 cursor-pointer transition-colors"
                  onClick={() => loadProject(project.id)}
                >
                  <div>
                    <div className="font-medium text-sm">{project.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(project.updatedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDelete(project.id); }}
                    className="text-red-400/80 hover:text-red-400 text-sm"
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
