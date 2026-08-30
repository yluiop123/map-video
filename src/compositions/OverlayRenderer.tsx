import { AbsoluteFill, interpolate } from 'remotion';
import type { OverlayItem, OverlayContent, AnimationPreset, OverlayPosition } from '../types';

interface OverlayRendererProps {
  overlays: OverlayItem[];
  /** 绝对帧号（相对整个项目时间线）。overlay.startFrame/endFrame 为绝对帧。 */
  frame: number;
}

const positionStyles: Record<OverlayPosition, React.CSSProperties> = {
  top: { top: 0, left: '50%', transform: 'translateX(-50%)' },
  bottom: { bottom: 0, left: '50%', transform: 'translateX(-50%)' },
  left: { left: 0, top: '50%', transform: 'translateY(-50%)' },
  right: { right: 0, top: '50%', transform: 'translateY(-50%)' },
  center: { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' },
  topLeft: { top: 0, left: 0 },
  topRight: { top: 0, right: 0 },
  bottomLeft: { bottom: 0, left: 0 },
  bottomRight: { bottom: 0, right: 0 },
};

export function OverlayRenderer({ overlays, frame }: OverlayRendererProps) {
  return (
    <AbsoluteFill>
      {overlays.map((overlay) => {
        if (frame < overlay.startFrame || frame > overlay.endFrame) return null;

        const animDurationFrames = 20;
        const entryProgress = interpolate(
          frame - overlay.startFrame,
          [0, animDurationFrames],
          [0, 1],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
        );

        const animation = applyAnimation(overlay.animation, entryProgress);
        const posStyle = positionStyles[overlay.position] || positionStyles.center;
        const scale = overlay.scale || 1;

        return (
          <div
            key={overlay.id}
            style={{
              position: 'absolute',
              padding: 16,
              zIndex: (overlay.zIndex || 100) + 100,
              ...posStyle,
              ...animation,
            }}
          >
            <div style={{ transform: `scale(${scale})`, transformOrigin: posStyle.transform ? posStyle.transform : 'center' }}>
              <OverlayContentRenderer content={overlay.content} />
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
}

function applyAnimation(preset: AnimationPreset | undefined, progress: number): React.CSSProperties {
  if (!preset) {
    return { opacity: 1 };
  }

  const clamped = Math.max(0, Math.min(1, progress));

  switch (preset) {
    case 'fadeIn': return { opacity: clamped };
    case 'fadeOut': return { opacity: 1 - clamped };
    case 'popIn': return { opacity: clamped, transform: `scale(${0.4 + 0.6 * clamped})` };
    case 'popOut': return { opacity: 1 - clamped, transform: `scale(${1 - 0.6 * clamped})` };
    case 'scaleIn': return { opacity: clamped, transform: `scale(${clamped})` };
    case 'scaleOut': return { opacity: 1 - clamped, transform: `scale(${1 - clamped})` };
    case 'slideInLeft': return { opacity: clamped, transform: `translateX(${(-1 + clamped) * 200}px)` };
    case 'slideInRight': return { opacity: clamped, transform: `translateX(${(1 - clamped) * 200}px)` };
    case 'slideInTop': return { opacity: clamped, transform: `translateY(${(-1 + clamped) * 200}px)` };
    case 'slideInBottom': return { opacity: clamped, transform: `translateY(${(1 - clamped) * 200}px)` };
    default: return { opacity: 1 };
  }
}

function OverlayContentRenderer({ content }: { content: OverlayContent }) {
  switch (content.type) {
    case 'text':
      return (
        <div
          style={{
            color: content.text?.color || '#FFFFFF',
            fontSize: content.text?.fontSize || 28,
            fontWeight: content.text?.bold ? 700 : 400,
            textAlign: content.text?.align || 'center',
            textShadow: '0 2px 8px rgba(0,0,0,0.8)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {content.text?.content}
        </div>
      );

    case 'person':
      return (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: 'rgba(0,0,0,0.75)',
            borderRadius: 12,
            padding: '12px 16px',
            maxWidth: 360,
          }}
        >
          {content.person?.imageUrl && (
            <img
              src={content.person.imageUrl}
              alt={content.person.name}
              style={{
                width: 56,
                height: 56,
                borderRadius: 8,
                objectFit: 'cover',
                background: '#333',
              }}
            />
          )}
          <div>
            <div style={{ color: '#fff', fontSize: 18, fontWeight: 700 }}>
              {content.person?.name}
            </div>
            {content.person?.title && (
              <div style={{ color: '#aaa', fontSize: 14 }}>{content.person.title}</div>
            )}
            {content.person?.description && (
              <div style={{ color: '#ccc', fontSize: 13, marginTop: 4, maxWidth: 280 }}>
                {content.person.description}
              </div>
            )}
          </div>
        </div>
      );

    case 'chart':
      return <ChartView content={content} />;

    case 'image':
      return (
        <img
          src={content.image?.url || content.src}
          alt={content.image?.alt || ''}
          style={{ maxWidth: 360, maxHeight: 200, borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}
        />
      );

    case 'video':
      return (
        <video
          src={content.src}
          autoPlay
          loop
          muted
          style={{ maxWidth: 360, maxHeight: 200, borderRadius: 8, boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}
        />
      );

    case 'group':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {content.children?.map((child, i) => (
            <OverlayContentRenderer key={i} content={child.content} />
          ))}
        </div>
      );

    default:
      return null;
  }
}

function ChartView({ content }: { content: OverlayContent }) {
  const chart = content.chart;
  if (!chart || chart.data.length === 0) return null;

  const width = 320;
  const height = 200;
  const padding = 30;
  const maxValue = Math.max(...chart.data.map((d) => d.value)) || 1;

  return (
    <div
      style={{
        width,
        height,
        background: 'rgba(0,0,0,0.85)',
        borderRadius: 12,
        padding,
        boxSizing: 'border-box',
        position: 'relative',
      }}
    >
      {chart.title && (
        <div style={{ color: '#fff', fontSize: 16, fontWeight: 700, marginBottom: 14, textAlign: 'center' }}>
          {chart.title}
        </div>
      )}

      {chart.type === 'bar' || chart.type === 'area' || chart.type === 'line' ? (
        <div style={{ display: 'flex', flexDirection: 'column', height: height - padding * 2 - 30, justifyContent: 'space-between' }}>
          {chart.data.map((d, i) => {
            const h = (d.value / maxValue) * 100;
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: '#aaa', fontSize: 11, width: 60, textAlign: 'right' }}>{d.label}</span>
                <div style={{ flex: 1, background: 'rgba(255,255,255,0.1)', borderRadius: 3, height: 16 }}>
                  <div
                    style={{
                      width: `${h}%`,
                      height: '100%',
                      background: chart.color || '#4C9EFF',
                      borderRadius: 3,
                    }}
                  />
                </div>
                <span style={{ color: '#ccc', fontSize: 11, width: 40 }}>{d.value}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <PieChart data={chart.data} color={chart.color} />
      )}
    </div>
  );
}

function PieChart({ data, color }: { data: { label: string; value: number }[]; color?: string }) {
  const palette = color ? [color, '#4C9EFF', '#51CF66', '#FFA94D', '#F783AC', '#B197FC'] : ['#4C9EFF', '#51CF66', '#FFA94D', '#F783AC', '#B197FC'];
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  let acc = 0;

  const sectors = data.map((d, i) => {
    const start = acc / total * 2 * Math.PI;
    acc += d.value;
    const end = acc / total * 2 * Math.PI;
    return {
      d,
      i,
      start,
      end,
      color: palette[i % palette.length],
    };
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <svg width={100} height={100}>
        {sectors.map((s) => {
          const large = s.end - s.start > Math.PI ? 1 : 0;
          const x1 = 50 + 40 * Math.cos(s.start);
          const y1 = 50 + 40 * Math.sin(s.start);
          const x2 = 50 + 40 * Math.cos(s.end);
          const y2 = 50 + 40 * Math.sin(s.end);
          return (
            <path
              key={s.i}
              d={`M50 50 L${x1} ${y1} A40 40 0 ${large} 1 ${x2} ${y2} Z`}
              fill={s.color}
            />
          );
        })}
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {data.map((d, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: palette[i % palette.length] }} />
            <span style={{ color: '#ccc', fontSize: 11 }}>{d.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
