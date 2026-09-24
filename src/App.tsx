import { useState, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { TopBar, FloatingTools } from './components/Toolbar';
import { EditableMap } from './components/EditableMap';
import { ElementsPanel } from './components/ElementsPanel';
import { PresentationMode } from './components/PresentationMode';
import { TimelineEditor } from './components/TimelineEditor';
import { PropertiesPanel } from './components/PropertiesPanel';
import { ExportDialog } from './components/ExportDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { ProjectManager } from './components/ProjectManager';
import { KeyframePanel } from './components/KeyframePanel';
import { MapStyleChip } from './components/MapStyleChip';
import { FxPanelBody } from './components/FxPanelBody';
import { FxPreviewLayer } from './components/fx/FxRender';
import { screenFxCombinedAt } from './lib/screenfx';
import { mountPreviewAudio } from './lib/preview-audio';
import { useProviderStore } from './stores/providerStore';
import { useVoiceStore } from './stores/voiceStore';
import { useTaskStore } from './stores/taskStore';
import { ConfirmHost } from './components/ui/ConfirmHost';
import { PanelHeader } from './components/ui/primitives';

import { useProjectStore, isProjectDirty } from './stores/projectStore';
import { useEditorStore } from './stores/editorStore';
import { generateId, type MapElement, type MapVideoProject } from './types';

/** 自动保存：停止编辑这么久后静默落盘 */
const AUTOSAVE_DELAY_MS = 5000;

/** 在容器内按目标画幅等比居中（contain），返回舞台 box 的像素尺寸与偏移 */
function computeStageFit(container: { w: number; h: number }, res: { width: number; height: number }) {
  const cw = Math.max(1, container.w);
  const ch = Math.max(1, container.h);
  const ratio = (res.width || 16) / (res.height || 9);
  let w = cw;
  let h = cw / ratio;
  if (h > ch) { h = ch; w = ch * ratio; }
  return { left: (cw - w) / 2, top: (ch - h) / 2, w, h };
}

/**
 * 舞台的「画面震动」包络层。
 * 播放头订阅放在这一层，而不是 App 根：App 每帧重渲染会把 TopBar / 时间线 / 左右浮层
 * 整棵树一起拖着 diff 一遍（实测 1× 播放时 248 次 DOM mutation/s）。
 * children 由 App 传进来、引用不变，所以本层逐帧更新不会波及舞台内部。
 */
function StageShake({ project, fps, box, children }: {
  project: MapVideoProject;
  fps: number;
  box: CSSProperties;
  children: ReactNode;
}) {
  const frame = useEditorStore((s) => s.currentFrame);
  const shake = screenFxCombinedAt(project.fx, frame, fps).shake;
  return (
    <div
      className="absolute isolate overflow-hidden"
      style={{ ...box, transform: shake ? `translate(${shake.x.toFixed(2)}px, ${shake.y.toFixed(2)}px)` : undefined }}
    >
      {children}
    </div>
  );
}

export default function App() {
  const project = useProjectStore((s) => s.project);

  const panelMode = useEditorStore((s) => s.panelMode);
  const selectedKeyframeIdx = useEditorStore((s) => s.selectedKeyframeIdx);
  const selectedElementId = useEditorStore((s) => s.selectedElementId);
  const elementsOpen = useEditorStore((s) => s.elementsOpen);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const presenting = useEditorStore((s) => s.presenting);
  const setPanelMode = useEditorStore((s) => s.setPanelMode);

  const [exportOpen, setExportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 画幅：地图舞台按项目画幅等比居中（黑边 letterbox），预览即导出取景
  const stageRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setStageSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, [project]);

  // 演示模式：整棵应用树进全屏（地图实例保持挂载，不重建）。
  // 全屏失败或被用户用系统方式退出时，布局仍是「无界面」的演示态，不会卡住。
  useEffect(() => {
    const el = rootRef.current;
    if (!presenting) {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      return;
    }
    if (el && !document.fullscreenElement) void el.requestFullscreen().catch(() => {});
    // 顶栏/时间线卸载只改容器尺寸，MapLibre 只听 window resize；主动补一次
    const t = setTimeout(() => window.dispatchEvent(new Event('resize')), 120);
    return () => clearTimeout(t);
  }, [presenting]);

  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement) useEditorStore.getState().setPresenting(false);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // 桌面端：启动时从 SQLite 加载 AI/配音配置
  useEffect(() => {
    useProviderStore.getState().hydrate();
    void useVoiceStore.getState().hydrate();
    void useTaskStore.getState().hydrate();
  }, []);

  // 预览音频（配音/BGM）随播放头同步（订阅式，挂载一次）
  useEffect(() => {
    mountPreviewAudio();
  }, []);

  // 编辑器快捷键：F5 演示 / Delete 删除 / Ctrl+D 复制 / Ctrl+S 保存 / Ctrl+Z 撤销 / Ctrl+Y(Shift+Z) 重做
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const ed = useEditorStore.getState();
      const elId = ed.selectedElementId;

      // F5 进出演示模式（演示中的按键由 PresentationMode 自己处理，这里只管进入）
      if (e.key === 'F5' && !ed.presenting) {
        e.preventDefault();
        ed.setPresenting(true);
        return;
      }

      // Delete/Backspace 的删除逻辑统一在 EditableMap 的 keydown 里处理（元素/特效/图层，带确认），
      // 这里不再重复删除，否则会绕过确认框且与 EditableMap 形成双重删除。

      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        useProjectStore.getState().undo();
      } else if ((e.key === 'y') || (e.key === 'z' && e.shiftKey)) {
        e.preventDefault();
        useProjectStore.getState().redo();
      } else if (e.key === 's') {
        e.preventDefault();
        void useProjectStore.getState().saveProject();
      } else if (e.key === 'd' && elId) {
        // 复制选中元素：新 id、位置相同，随后直接拖动即可
        e.preventDefault();
        const st = useProjectStore.getState();
        const el = st.project?.elements.find((x) => x.id === elId);
        if (el) {
          const copy = JSON.parse(JSON.stringify(el)) as MapElement;
          copy.id = generateId();
          st.addElements([copy]);
          ed.selectElement(copy.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 自动保存：停止编辑 5s 后静默落盘。
  // 视频编辑是长时创作，此前只能手动保存且无关闭保护 —— 崩溃/误关会丢掉全部未保存工作。
  useEffect(() => {
    // 必须先看脏标记：saveProject 会 set 一个新 project 引用 → 本 effect 重跑 →
    // 无条件排程就成了「每 5 秒无限写库」，updatedAt 持续变化还会让列表排序抖动。
    if (!project || !isProjectDirty(project)) return;
    const t = setTimeout(() => {
      void useProjectStore.getState().saveProject().catch((err) => console.warn('[autosave] 保存失败:', err));
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [project]);

  // 未保存提醒：刷新 / 关闭窗口前拦截（自动保存已覆盖多数场景，这是最后一道保险）
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isProjectDirty(useProjectStore.getState().project)) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  if (!project) {
    // 项目列表页同样要挂 ConfirmHost：useConfirm 依赖它渲染弹窗并 resolve，
    // 缺了会导致 await confirm(...) 永久挂起（删除合集/项目“点了没反应”）
    return (
      <>
        <ProjectManager />
        <ConfirmHost />
      </>
    );
  }

  // 右侧浮层：元素模式需有选中元素；关键帧/特效模式始终显示；播放预览时隐藏
  const showRightPanel =
    !isPlaying &&
    !presenting &&
    (panelMode === 'keyframe' ||
      panelMode === 'fx' ||
      (panelMode === 'element' && !!selectedElementId));

  // 画幅：地图舞台按项目画幅等比居中（黑边），改画幅后地图区域随之变化
  const fps = project.globalConfig.defaultFPS ?? 30;
  const fit = computeStageFit(stageSize, project.globalConfig.defaultResolution);
  const stageBoxStyle = stageSize.w > 0
    ? { left: fit.left, top: fit.top, width: fit.w, height: fit.h }
    : { left: 0, top: 0, right: 0, bottom: 0 } as const;

  return (
    <div ref={rootRef} className={`flex flex-col bg-background text-foreground ${presenting ? 'fixed inset-0' : 'relative h-screen'}`}>
      {/* 顶部栏：Logo + 项目芯片 + 底图/高程/3D + 撤销重做/保存/导出（演示时隐藏） */}
      {!presenting && <TopBar onOpenExport={() => setExportOpen(true)} onOpenSettings={() => setSettingsOpen(true)} />}

      {/* 地图舞台：全幅画布 + 特效预览层 + 浮动工具条/面板（震动=整体画面位移，见 StageShake） */}
      <div ref={stageRef} className={`relative flex-1 overflow-hidden ${presenting ? 'bg-black' : 'bg-[#0c0a09]'}`}>
        <StageShake project={project} fps={fps} box={stageBoxStyle}>
          <EditableMap project={project} />
          {/* 特效窗口预览层：弹窗卡片/字幕/天气/画面特效（双端同源渲染） */}
          <FxPreviewLayer project={project} fps={fps} />
        </StageShake>

        {/* 浮动工具条（选择 + 六大工具）；播放预览时隐藏 */}
        {!isPlaying && !presenting && <FloatingTools />}

        {/* 左下角底图/高程/3D 芯片 */}
        {!presenting && <MapStyleChip />}

        {/* 左侧浮动元素面板 */}
        {elementsOpen && !presenting && (
          <div className="absolute left-3 top-16 bottom-3 w-64 z-30 bg-card/95 backdrop-blur border border-white/10 shadow-2xl rounded-xl overflow-hidden">
            <ElementsPanel />
          </div>
        )}

        {/* 演示模式：全屏播控 + HUD（覆盖在舞台上） */}
        {presenting && <PresentationMode project={project} />}
      </div>

      {/* 时间线（播放条 + 轨道） */}
      {!presenting && <TimelineEditor />}

      {/* 右侧浮动设置面板：覆盖到屏幕底部（在时间线之上），保证属性区有足够高度 */}
      {showRightPanel && (
        <div className="absolute right-0 top-14 bottom-0 w-80 z-40 bg-card border-l border-white/10 shadow-2xl flex flex-col overflow-hidden">
          {panelMode === 'element' ? (
            <PropertiesPanel />
          ) : panelMode === 'keyframe' ? (
            <KeyframePanel project={project} index={selectedKeyframeIdx ?? 0} />
          ) : panelMode === 'fx' ? (
            <div className="h-full flex flex-col min-h-0">
              <PanelHeader title="特效" icon={<span className="text-base">✨</span>} onClose={() => setPanelMode('none')} />
              <div className="flex-1 min-h-0">
                <FxPanelBody project={project} />
              </div>
            </div>
          ) : null}
        </div>
      )}

      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      {settingsOpen && <SettingsDialog open onClose={() => setSettingsOpen(false)} />}
      <ConfirmHost />
    </div>
  );
}
