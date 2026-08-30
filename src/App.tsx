import { useState, useEffect } from 'react';
import { TopBar, FloatingTools } from './components/Toolbar';
import { EditableMap } from './components/EditableMap';
import { ElementsPanel } from './components/ElementsPanel';
import { TimelineEditor } from './components/TimelineEditor';
import { PropertiesPanel } from './components/PropertiesPanel';
import { ChapterSettingsPanel } from './components/ChapterSettingsPanel';
import { ExportDialog } from './components/ExportDialog';
import { ProjectManager } from './components/ProjectManager';
import { KeyframePanel } from './components/KeyframePanel';
import { MapStyleChip } from './components/MapStyleChip';
import { ConfirmHost } from './components/ui/ConfirmHost';

import { useProjectStore } from './stores/projectStore';
import { useEditorStore } from './stores/editorStore';

export default function App() {
  const project = useProjectStore((s) => s.project);

  const currentFrame = useEditorStore((s) => s.currentFrame);
  const selectedChapterId = useEditorStore((s) => s.selectedChapterId);
  const panelMode = useEditorStore((s) => s.panelMode);
  const selectedKeyframeIdx = useEditorStore((s) => s.selectedKeyframeIdx);
  const selectedElementId = useEditorStore((s) => s.selectedElementId);
  const elementsOpen = useEditorStore((s) => s.elementsOpen);

  const [exportOpen, setExportOpen] = useState(false);

  // 撤销/重做快捷键 (Ctrl+Z / Ctrl+Y 或 Ctrl+Shift+Z)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        useProjectStore.getState().undo();
      } else if ((e.key === 'y') || (e.key === 'z' && e.shiftKey)) {
        e.preventDefault();
        useProjectStore.getState().redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!project) {
    return <ProjectManager />;
  }

  const currentChapter = project.chapters.find((c) => c.id === selectedChapterId) || project.chapters[0];
  // 右侧浮层：元素模式需有选中元素；关键帧/章节模式始终显示
  const showRightPanel =
    panelMode === 'keyframe' ||
    panelMode === 'chapter' ||
    (panelMode === 'element' && !!selectedElementId);

  return (
    <div className="relative flex flex-col h-screen bg-background text-foreground">
      {/* 顶部栏：Logo + 项目芯片 + 底图/高程/3D + 撤销重做/保存/导出 */}
      <TopBar onOpenExport={() => setExportOpen(true)} />

      {/* 地图舞台：全幅画布 + 浮动工具条/面板 */}
      <div className="relative flex-1 overflow-hidden bg-[#0c0a09]">
        <div className="absolute inset-0">
          <EditableMap
            project={project}
            chapter={currentChapter}
            currentFrame={currentFrame}
          />
        </div>

        {/* 浮动工具条（选择 + 六大工具） */}
        <FloatingTools />

        {/* 左下角底图/高程/3D 芯片 */}
        <MapStyleChip />

        {/* 左侧浮动元素面板 */}
        {elementsOpen && (
          <div className="absolute left-3 top-16 bottom-3 w-64 z-30 bg-card/95 backdrop-blur border border-white/10 shadow-2xl rounded-xl overflow-hidden">
            <ElementsPanel />
          </div>
        )}
      </div>

      {/* 时间线（播放条 + 轨道） */}
      <TimelineEditor />

      {/* 右侧浮动设置面板：覆盖到屏幕底部（在时间线之上），保证属性区有足够高度 */}
      {showRightPanel && (
        <div className="absolute right-0 top-14 bottom-0 w-80 z-40 bg-card border-l border-white/10 shadow-2xl flex flex-col overflow-hidden">
          {panelMode === 'element' ? (
            <PropertiesPanel />
          ) : panelMode === 'keyframe' ? (
            <KeyframePanel chapter={currentChapter} index={selectedKeyframeIdx ?? 0} />
          ) : (
            <ChapterSettingsPanel chapter={currentChapter} />
          )}
        </div>
      )}

      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      <ConfirmHost />
    </div>
  );
}
