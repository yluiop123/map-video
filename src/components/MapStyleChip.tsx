import { useEffect, useRef, useState } from 'react';
import { Layers, Mountain, Globe, Grid2x2, Check } from 'lucide-react';
import { useProjectStore } from '../stores/projectStore';
import { useEditorStore } from '../stores/editorStore';

/**
 * 地图左下角底图芯片（对齐 Mapimator SATELLITE 样式）：
 * 缩略芯片显示当前底图名，点击弹出 底图/高程/3D 投影 面板。
 */
export function MapStyleChip() {
  const project = useProjectStore((s) => s.project);
  const isPlaying = useEditorStore((s) => s.isPlaying);
  const setActiveBaseMap = useProjectStore((s) => s.setActiveBaseMap);
  const setActiveElevationMap = useProjectStore((s) => s.setActiveElevationMap);
  const updateGlobalConfig = useProjectStore((s) => s.updateGlobalConfig);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!project || isPlaying) return null;

  const activeBaseMap = project.baseMaps.find((b) => b.id === project.activeBaseMapId);
  const isGlobe = (project.globalConfig.projection || 'mercator') === 'globe';

  return (
    <div ref={boxRef} className="absolute left-3 bottom-3 z-20">
      {/* 芯片：图标 + 当前底图名 */}
      <button
        onClick={() => setOpen(!open)}
        className="flex flex-col items-center gap-0.5 w-[64px] py-1.5 rounded-lg bg-card/95 backdrop-blur border border-white/15 shadow-lg hover:border-white/30 transition-colors"
        title="底图 / 高程 / 3D"
      >
        <span className="relative">
          <Layers size={18} className="text-foreground/90" />
          <Grid2x2 size={9} className="absolute -top-1 -right-1.5 text-muted-foreground" />
        </span>
        <span className="max-w-[56px] truncate text-[9px] font-semibold tracking-wide text-foreground/80 uppercase">
          {activeBaseMap?.name || '底图'}
        </span>
      </button>

      {/* 弹出面板 */}
      {open && (
        <div className="absolute left-0 bottom-full mb-2 w-60 bg-card/95 backdrop-blur border border-white/10 rounded-xl shadow-2xl p-2">
          {/* 底图 */}
          <p className="px-2 pt-1 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">底图</p>
          {project.baseMaps.map((bm) => {
            const active = bm.id === project.activeBaseMapId;
            return (
              <button
                key={bm.id}
                onClick={() => setActiveBaseMap(bm.id)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors ${
                  active ? 'bg-brand/15 text-foreground' : 'text-foreground/80 hover:bg-white/[0.06]'
                }`}
              >
                <Layers size={12} className={active ? 'text-brand' : 'text-muted-foreground'} />
                <span className="flex-1 text-left truncate">{bm.name}</span>
                {active && <Check size={12} className="text-brand" />}
              </button>
            );
          })}

          <div className="h-px bg-white/[0.06] my-1.5" />

          {/* 高程（store 默认自带 id='none' 的无高程项） */}
          <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">高程</p>
          {project.elevationMaps.map((em) => {
            const active = em.id === (project.activeElevationMapId || 'none');
            return (
              <button
                key={em.id || 'none'}
                onClick={() => setActiveElevationMap(em.id === 'none' ? null : em.id)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors ${
                  active ? 'bg-brand/15 text-foreground' : 'text-foreground/80 hover:bg-white/[0.06]'
                }`}
              >
                <Mountain size={12} className={active ? 'text-brand' : 'text-muted-foreground'} />
                <span className="flex-1 text-left truncate">{em.name}</span>
                {active && <Check size={12} className="text-brand" />}
              </button>
            );
          })}

          <div className="h-px bg-white/[0.06] my-1.5" />

          {/* 3D 投影 */}
          <button
            onClick={() => updateGlobalConfig({ projection: isGlobe ? 'mercator' : 'globe' })}
            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs transition-colors ${
              isGlobe ? 'bg-brand/15 text-foreground' : 'text-foreground/80 hover:bg-white/[0.06]'
            }`}
            title="3D 球体 / 平面投影切换（导出视频同步生效）"
          >
            <Globe size={12} className={isGlobe ? 'text-brand' : 'text-muted-foreground'} />
            <span className="flex-1 text-left">{isGlobe ? '3D 球体投影' : '平面投影（Mercator）'}</span>
            <span className={`w-8 h-4 rounded-full relative transition-colors ${isGlobe ? 'bg-brand' : 'bg-white/15'}`}>
              <span className={`absolute top-0.5 w-3 h-3 bg-white rounded-full shadow transition-all ${isGlobe ? 'left-[18px]' : 'left-0.5'}`} />
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
