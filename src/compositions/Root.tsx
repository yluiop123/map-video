import { Composition } from 'remotion';
import { MapVideo } from './MapVideo';
import { useProjectStore } from '../stores/projectStore';
import { calculateTotalDuration } from '../lib/keyframe-interpolation';

export const RemotionRoot: React.FC = () => {
  const project = useProjectStore((s) => s.project);

  if (!project) return null;

  const totalFrames = calculateTotalDuration(project.chapters);

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
