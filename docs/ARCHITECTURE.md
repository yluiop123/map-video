# MapVideo - 地图视频生成框架架构设计

## 1. 项目概述

MapVideo 是一个基于 **Remotion** 的地图视频生成框架，支持浏览器内预览、编辑和导出。

### 核心特性

- **Remotion 驱动** — React 组件写 Composition，帧级精确控制
- **实时预览** — @remotion/player 浏览器内实时预览编辑效果
- **客户端导出** — @remotion/web-renderer 纯浏览器导出 MP4，无需服务器
- **APP-6 兼容** — 军事符号支持 APP-6/MIL-STD-2525 标准
- **GitHub Pages 部署** — 构建产物为纯静态文件

### 技术栈

| 层级 | 技术选型 | 理由 |
|------|----------|------|
| 视频框架 | Remotion 4.x | React 驱动，帧级控制，官方 MapLibre 支持 |
| 前端框架 | React 18+ / TypeScript | 与 Remotion 统一 |
| 构建工具 | Vite | 快速，支持 GitHub Pages |
| 地图引擎 | MapLibre GL JS v5.11+ | WebGL 渲染，开源免费 |
| 地理计算 | Turf.js | 空间分析，路径计算 |
| 军事符号 | milsymbol | APP-6 兼容，SVG 输出，可扩展 |
| 数据存储 | IndexedDB (Dexie.js) | 本地持久化 |
| 状态管理 | Zustand | 轻量级，与 Remotion 无缝集成 |
| UI组件 | Radix UI / Tailwind CSS | 轻量 |

---

## 2. 核心架构：Remotion 驱动

### 2.1 数据流

```
┌─────────────────────────────────────────────────────────────────┐
│                         编辑器 UI                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │ Elements │  │Timeline  │  │Properties│  │ Symbol   │       │
│  │  Panel   │  │ Editor   │  │  Panel   │  │ Picker   │       │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘       │
│       └──────────────┼──────────────┼──────────────┘             │
│                      ▼                                           │
│              ┌───────────────┐                                   │
│              │  Zustand Store │  ← 项目状态                       │
│              └───────┬───────┘                                   │
│         ┌────────────┼────────────┐                              │
│         ▼                         ▼                              │
│  ┌─────────────┐          ┌─────────────┐                       │
│  │  @remotion  │          │  @remotion  │                       │
│  │   Player    │          │ web-renderer│                       │
│  │  (预览)     │          │  (导出)     │                       │
│  └──────┬──────┘          └──────┬──────┘                       │
│         ▼                        ▼                               │
│  ┌─────────────┐          ┌─────────────┐                       │
│  │ MapVideo    │          │ MapVideo    │                       │
│  │ Composition │          │ Composition │                       │
│  │ (实时渲染)  │          │ (逐帧导出)  │                       │
│  └──────┬──────┘          └──────┬──────┘                       │
│         │                        │                               │
│         ▼                        ▼                               │
│  ┌─────────────┐          ┌─────────────┐                       │
│  │  MapLibre   │          │  MapLibre   │                       │
│  │  GL JS      │          │  GL JS      │                       │
│  └─────────────┘          └──────┬──────┘                       │
│                                  ▼                               │
│                           ┌─────────────┐                       │
│                           │  MP4 下载   │                       │
│                           └─────────────┘                       │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 关键设计原则

**状态驱动渲染**：
- Zustand store 持有所有项目数据
- Remotion Composition 从 store 读取数据渲染
- 编辑操作更新 store → Player 自动重新渲染当前帧
- 导出时 web-renderer 逐帧渲染整个 Composition

**预览 = 导出**：
- 浏览器内预览和最终导出使用同一个 React 组件
- 所见即所得，无差异

---

## 3. Remotion Composition 设计

### 3.1 Root 入口

```tsx
// src/compositions/Root.tsx
import { Composition } from 'remotion';
import { MapVideo } from './MapVideo';
import { useProjectStore } from '../stores/projectStore';

export const RemotionRoot: React.FC = () => {
  const project = useProjectStore((s) => s.project);
  if (!project) return null;

  const totalFrames = calculateTotalFrames(project);

  return (
    <Composition
      id="MapVideo"
      component={MapVideo}
      durationInFrames={totalFrames}
      fps={project.globalConfig.defaultFPS}
      width={project.globalConfig.defaultResolution.width}
      height={project.globalConfig.defaultResolution.height}
      defaultProps={{ projectId: project.id }}
    />
  );
};
```

### 3.2 主 Composition

```tsx
// src/compositions/MapVideo.tsx
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { MapScene } from './MapScene';
import { OverlayLayer } from './OverlayLayer';
import { ChapterTitle } from './ChapterTitle';
import { useProjectStore } from '../stores/projectStore';

export const MapVideo: React.FC<{ projectId: string }> = ({ projectId }) => {
  const frame = useCurrentFrame();
  const project = useProjectStore((s) => s.project);
  if (!project) return null;

  const currentChapter = getCurrentChapter(project, frame);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <Sequence from={currentChapter.startFrame}
        durationInFrames={currentChapter.endFrame - currentChapter.startFrame}>
        <MapScene chapter={currentChapter} baseMap={project.activeBaseMapId}
          baseMaps={project.baseMaps} />
      </Sequence>

      {currentChapter.title && (
        <ChapterTitle title={currentChapter.title} subtitle={currentChapter.subtitle} />
      )}

      <OverlayLayer overlays={currentChapter.overlays} />
      <TransitionLayer transition={currentChapter.transition} />
    </AbsoluteFill>
  );
};

function getCurrentChapter(project: MapVideoProject, frame: number): Chapter {
  return project.chapters.find(
    (ch) => frame >= ch.startFrame && frame < ch.endFrame
  ) || project.chapters[0];
}
```

### 3.3 MapScene 组件（核心）

```tsx
// src/compositions/MapScene.tsx
import { useEffect, useRef, useState } from 'react';
import { AbsoluteFill, useDelayRender, useVideoConfig, useCurrentFrame } from 'remotion';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { renderElements } from '../lib/map-renderer';
import { interpolateCamera } from '../lib/keyframe-interpolation';

interface MapSceneProps {
  chapter: Chapter;
  baseMap: string;
  baseMaps: BaseMapConfig[];
}

export const MapScene: React.FC<MapSceneProps> = ({ chapter, baseMap, baseMaps }) => {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const { delayRender, continueRender } = useDelayRender();
  const { width, height, fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const [handle] = useState(() => delayRender('Loading map...'));

  const styleUrl = baseMaps.find((b) => b.id === baseMap)?.style || baseMap;

  // 初始化地图（只执行一次）
  useEffect(() => {
    if (!ref.current) return;
    const map = new maplibregl.Map({
      container: ref.current,
      style: styleUrl,
      center: [0, 0], zoom: 2,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    map.on('load', () => {
      mapRef.current = map;
      map.once('idle', () => continueRender(handle));
    });
  }, [styleUrl, handle, continueRender]);

  // 帧更新：相机 + 元素
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const h = delayRender('Rendering frame...');

    if (chapter.camera && chapter.camera.length > 0) {
      const cam = interpolateCamera(chapter.camera, frame);
      map.jumpTo({ center: cam.center, zoom: cam.zoom, pitch: cam.pitch || 0, bearing: cam.bearing || 0 });
    }

    renderElements(map, chapter.elements, frame, fps);
    map.once('idle', () => continueRender(h));
    map.triggerRepaint();
  }, [frame, chapter, fps, delayRender, continueRender]);

  return (
    <AbsoluteFill>
      <div ref={ref} style={{ width, height, position: 'absolute' }} />
    </AbsoluteFill>
  );
};
```

---

## 4. 编辑器与预览集成

### 4.1 编辑器主布局

```tsx
// src/App.tsx
import { Player } from '@remotion/player';
import { RemotionRoot } from './compositions/Root';
import { ElementsPanel } from './components/ElementsPanel';
import { TimelineEditor } from './components/TimelineEditor';
import { PropertiesPanel } from './components/PropertiesPanel';
import { useProjectStore } from './stores/projectStore';
import { useEditorStore } from './stores/editorStore';

export const App: React.FC = () => {
  const project = useProjectStore((s) => s.project);
  if (!project) return <ProjectManager />;

  return (
    <div className="flex flex-col h-screen">
      <Toolbar />
      <div className="flex flex-1 overflow-hidden">
        <ElementsPanel />
        <div className="flex-1 flex flex-col">
          <div className="flex-1 relative bg-gray-900">
            <Player
              component={RemotionRoot}
              compositionWidth={project.globalConfig.defaultResolution.width}
              compositionHeight={project.globalConfig.defaultResolution.height}
              fps={project.globalConfig.defaultFPS}
              durationInFrames={calculateTotalFrames(project)}
              controls
              style={{ width: '100%', height: '100%' }}
            />
          </div>
          <TimelineEditor />
        </div>
        <PropertiesPanel />
      </div>
    </div>
  );
};
```

### 4.2 Timeline 与 Player 同步

```tsx
// src/components/TimelineEditor.tsx
import { useEditorStore } from '../stores/editorStore';
import { useProjectStore } from '../stores/projectStore';

export const TimelineEditor: React.FC = () => {
  const project = useProjectStore((s) => s.project);
  const currentFrame = useEditorStore((s) => s.currentFrame);
  const setCurrentFrame = useEditorStore((s) => s.setCurrentFrame);

  if (!project) return null;

  const totalFrames = calculateTotalFrames(project);
  const fps = project.globalConfig.defaultFPS;

  return (
    <div className="border-t bg-white" style={{ height: 200 }}>
      <div className="flex items-center gap-2 p-2 border-b">
        <button onClick={() => setCurrentFrame(0)}>⏮</button>
        <span className="text-sm text-gray-500">
          {formatTime(currentFrame, fps)} / {formatTime(totalFrames, fps)}
        </span>
      </div>
      <div className="overflow-auto" style={{ height: 150 }}>
        {project.chapters.map((chapter) => (
          <ChapterTrack key={chapter.id} chapter={chapter}
            currentFrame={currentFrame} onFrameClick={setCurrentFrame} />
        ))}
      </div>
    </div>
  );
};

function formatTime(frame: number, fps: number): string {
  const totalSeconds = frame / fps;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  const f = frame % fps;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}
```

### 4.3 Zustand Store

```tsx
// src/stores/projectStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ProjectState {
  project: MapVideoProject | null;
  createProject: (config: CreateProjectConfig) => void;
  loadProject: (id: string) => Promise<void>;
  saveProject: () => Promise<void>;
  addChapter: (chapter: Chapter) => void;
  updateChapter: (id: string, changes: Partial<Chapter>) => void;
  addElement: (chapterId: string, element: MapElement) => void;
  updateElement: (chapterId: string, elementId: string, changes: Partial<MapElement>) => void;
  deleteElement: (chapterId: string, elementId: string) => void;
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      project: null,
      createProject: (config) => set({ project: createDefaultProject(config) }),
      loadProject: async (id) => {
        const project = await projectDB.get(id);
        set({ project: project || null });
      },
      saveProject: async () => {
        const { project } = get();
        if (project) await projectDB.update(project.id, project);
      },
      addElement: (chapterId, element) => set((state) => {
        if (!state.project) return state;
        const ch = state.project.chapters.find((c) => c.id === chapterId);
        if (ch) ch.elements.push(element);
        return { project: { ...state.project } };
      }),
      // ... 其他操作
    }),
    { name: 'map-video-project' }
  )
);

// src/stores/editorStore.ts
interface EditorState {
  currentFrame: number;
  isPlaying: boolean;
  selectedElementId: string | null;
  selectedChapterId: string | null;
  setCurrentFrame: (frame: number) => void;
  setIsPlaying: (playing: boolean) => void;
  selectElement: (id: string | null) => void;
  selectChapter: (id: string | null) => void;
}

export const useEditorStore = create<EditorState>()((set) => ({
  currentFrame: 0,
  isPlaying: false,
  selectedElementId: null,
  selectedChapterId: null,
  setCurrentFrame: (frame) => set({ currentFrame: frame }),
  setIsPlaying: (playing) => set({ isPlaying: playing }),
  selectElement: (id) => set({ selectedElementId: id }),
  selectChapter: (id) => set({ selectedChapterId: id }),
}));
```

---

## 5. 视频导出（客户端）

```tsx
// src/lib/video-exporter.ts
import { renderMedia, selectComposition } from '@remotion/renderer';
import { bundle } from '@remotion/bundler';
import { RemotionRoot } from '../compositions/Root';

export async function exportVideo(
  project: MapVideoProject,
  onProgress: (progress: number) => void
): Promise<Blob> {
  // 打包 Remotion 组件
  const bundled = await bundle({
    entryPoint: './src/index.tsx',
    webpackOverride: (config) => config,
  });

  // 选择 Composition
  const composition = await selectComposition({
    serveUrl: bundled,
    id: 'MapVideo',
    inputProps: { projectId: project.id },
  });

  // 渲染视频
  const buffer = await renderMedia({
    composition,
    serveUrl: bundled,
    codec: 'h264',
    outputLocation: undefined, // 不写入文件系统
    onProgress: ({ progress }) => onProgress(progress),
  });

  return new Blob([buffer], { type: 'video/mp4' });
}
```

---

## 6. 数据模型

### 6.1 项目

```typescript
interface MapVideoProject {
  id: string;
  name: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
  globalConfig: {
    defaultDuration: number;
    defaultFPS: number;
    defaultResolution: { width: number; height: number; label: string };
    defaultEasing: EasingType;
  };
  chapters: Chapter[];
  baseMaps: BaseMapConfig[];
  activeBaseMapId: string;
  symbolSets: SymbolSetConfig[];
  presets: PresetCollection;
}
```

### 6.2 章节

```typescript
interface Chapter {
  id: string;
  title: string;
  subtitle?: string;
  order: number;
  startFrame: number;
  endFrame: number;
  elements: MapElement[];
  tracks: Track[];
  transition?: TransitionConfig;
  camera?: CameraKeyframe[];
  overlays?: OverlayItem[];
}
```

### 6.3 地图元素

```typescript
type ElementType =
  | 'point' | 'moving_point' | 'line' | 'polygon'
  | 'arrow' | 'encirclement' | 'gathering'
  | 'military_symbol' | 'custom';

interface MapElementBase {
  id: string;
  type: ElementType;
  name: string;
  visible: boolean;
  locked: boolean;
  startFrame: number;
  endFrame: number;
  style: ElementStyle;
  keyframes: Keyframe[];
}

interface PointElement extends MapElementBase {
  type: 'point';
  coordinates: [number, number];
  icon?: string;
  iconSize?: number;
  label?: LabelConfig;
}

interface MovingPointElement extends MapElementBase {
  type: 'moving_point';
  path: [number, number][];
  pathProgress: Keyframe<number>;
  trail?: TrailConfig;
}

interface LineElement extends MapElementBase {
  type: 'line';
  coordinates: [number, number][];
  drawProgress: Keyframe<number>;
  lineWidth: number;
  lineColor: string;
}

interface PolygonElement extends MapElementBase {
  type: 'polygon';
  coordinates: [number, number][][];
  fillColor: string;
  fillOpacity: number;
  strokeColor: string;
  strokeWidth: number;
  morphKeyframes?: MorphKeyframe[];
}

interface ArrowElement extends MapElementBase {
  type: 'arrow';
  from: [number, number];
  to: [number, number];
  arrowType: 'swallowtail' | 'simple' | 'block';
  width: number;
  color: string;
  progress: Keyframe<number>;
}

interface MilitarySymbolElement extends MapElementBase {
  type: 'military_symbol';
  sidc: string;
  coordinates: [number, number];
  rotation?: number;
  symbolSize?: number;
  echelon?: string;
  label?: string;
}
```

### 6.4 关键帧和缓动

```typescript
interface Keyframe<T> {
  frame: number;
  value: T;
  easing?: EasingType;
}

type EasingType =
  | 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'
  | 'cubicIn' | 'cubicOut' | 'cubicInOut'
  | 'spring' | 'bounce';

interface CameraKeyframe {
  frame: number;
  center: [number, number];
  zoom: number;
  pitch?: number;
  bearing?: number;
  easing?: EasingType;
}
```

---

## 7. 军事符号系统

### 7.1 APP-6 标准（基于 milsymbol 库）

```typescript
import { ms } from 'milsymbol';

function createMilitarySymbol(sidc: string, options: {
  size?: number; label?: string; echelon?: string;
}): SVGElement {
  const symbol = new ms.Symbol(sidc, {
    size: options.size || 35,
    uniqueDesignation: options.label,
  });
  return symbol.asSVG();
}
```

### 7.2 符号分类

| 归属 | 颜色 | 框架 |
|------|------|------|
| 友军 | 蓝 #0066FF | 矩形 |
| 敌军 | 红 #FF0000 | 菱形 |
| 中立 | 绿 #00FF00 | 正方形 |
| 未知 | 黄 #FFCC00 | 四叶草 |

### 7.3 自定义符号扩展

```typescript
ms.addIconParts((iconParts) => {
  iconParts['CUSTOM.ANCIENT.INFANTRY'] = {
    type: 'path',
    d: 'M50,20 L60,40 L80,40 L65,55 L70,75 L50,65 L30,75 L35,55 L20,40 L40,40 Z',
    fill: true
  };
});
```

---

## 8. 目录结构

```
map-video/
├── src/
│   ├── compositions/
│   │   ├── Root.tsx            # Remotion 入口
│   │   ├── MapVideo.tsx        # 主 Composition
│   │   ├── MapScene.tsx        # 地图场景
│   │   ├── OverlayLayer.tsx    # 叠加层
│   │   └── ChapterTitle.tsx    # 章节标题
│   ├── components/
│   │   ├── ElementsPanel/      # 元素面板
│   │   ├── TimelineEditor/     # 时间线
│   │   ├── PropertiesPanel/    # 属性面板
│   │   └── SymbolPicker/       # 符号选择器
│   ├── lib/
│   │   ├── map-renderer.ts     # 地图元素渲染
│   │   ├── keyframe-interpolation.ts
│   │   ├── video-exporter.ts   # 视频导出
│   │   ├── database.ts         # IndexedDB
│   │   └── presets/
│   ├── stores/
│   │   ├── projectStore.ts
│   │   └── editorStore.ts
│   ├── types/
│   └── App.tsx
├── package.json
├── vite.config.ts
└── tsconfig.json
```

---

## 9. 开发阶段

| 阶段 | 内容 |
|------|------|
| Phase 1 | 项目脚手架 + Remotion + MapLibre 集成 |
| Phase 2 | 基础元素（点/线/面）+ 编辑 |
| Phase 3 | Timeline 编辑器 + 关键帧系统 |
| Phase 4 | APP-6 军事符号 + 自定义符号 |
| Phase 5 | 视频导出 + 章节管理 |
| Phase 6 | 预设系统 + 转场 + 优化 |
