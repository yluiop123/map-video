import { Composition } from 'remotion';
import { MapVideo } from './MapVideo';
import { useProjectStore } from '../stores/projectStore';
import { projectContentDuration } from '../lib/project-duration';

export const RemotionRoot: React.FC = () => {
  const project = useProjectStore((s) => s.project);

  if (!project) return null;

  // 与导出一致：按内容结束帧，而不是容器 endFrame
  const totalFrames = projectContentDuration([project]);

  return (
    <Composition
      id="MapVideo"
      component={MapVideo as unknown as React.FC<Record<string, unknown>>}
      durationInFrames={totalFrames}
      fps={project.globalConfig.defaultFPS}
      width={project.globalConfig.defaultResolution.width}
      height={project.globalConfig.defaultResolution.height}
      defaultProps={{ projectId: project.id }}
    />
  );
};
