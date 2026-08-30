import { useProjectStore } from '../stores/projectStore';
import { ColorPicker } from './ui/primitives';
import { OptionBlocks } from './ui/primitives';
import { generateId } from '../types';
import { FrameTimeField } from './FrameTimeField';
import type { Chapter, OverlayItem, OverlayType, OverlayPosition, AnimationPreset } from '../types';

interface OverlayPanelProps {
  chapter: Chapter;
}

const OVERLAY_TYPES: { type: OverlayType; label: string; icon: string }[] = [
  { type: 'text', label: '文字', icon: '📝' },
  { type: 'person', label: '人物', icon: '👤' },
  { type: 'chart', label: '图表', icon: '📊' },
  { type: 'image', label: '图片', icon: '🖼️' },
  { type: 'video', label: '视频', icon: '🎬' },
  { type: 'group', label: '组合', icon: '🧩' },
];

const POSITIONS: { value: OverlayPosition; label: string }[] = [
  { value: 'topLeft', label: '左上' },
  { value: 'top', label: '上' },
  { value: 'topRight', label: '右上' },
  { value: 'left', label: '左' },
  { value: 'center', label: '中' },
  { value: 'right', label: '右' },
  { value: 'bottomLeft', label: '左下' },
  { value: 'bottom', label: '下' },
  { value: 'bottomRight', label: '右下' },
];

const ANIMATIONS: { value: AnimationPreset; label: string }[] = [
  { value: 'fadeIn', label: '淡入' },
  { value: 'popIn', label: '弹入' },
  { value: 'scaleIn', label: '缩放入' },
  { value: 'slideInLeft', label: '左滑入' },
  { value: 'slideInRight', label: '右滑入' },
  { value: 'slideInTop', label: '上滑入' },
  { value: 'slideInBottom', label: '下滑入' },
];

export function OverlayPanel({ chapter }: OverlayPanelProps) {
  const project = useProjectStore((s) => s.project);
  const addOverlay = useProjectStore((s) => s.addOverlay);
  const updateOverlay = useProjectStore((s) => s.updateOverlay);
  const deleteOverlay = useProjectStore((s) => s.deleteOverlay);

  const handleAdd = (type: OverlayType) => {
    const overlay: OverlayItem = {
      id: generateId(),
      type,
      name: OVERLAY_TYPES.find((t) => t.type === type)?.label || '元素',
      position: 'center',
      content: createContent(type),
      startFrame: chapter.startFrame,
      endFrame: chapter.endFrame,
      animation: 'fadeIn',
    };
    addOverlay(chapter.id, overlay);
  };

  const getOverlays = () => {
    const ch = project?.chapters.find((c) => c.id === chapter.id);
    return ch?.overlays || [];
  };

  const fps = project?.globalConfig.defaultFPS ?? 30;

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b">
        <h2 className="text-sm font-semibold">弹出元素</h2>
        <p className="text-xs text-muted-foreground mt-0.5">在预览地图上弹出的独立元素</p>
      </div>

      <div className="p-2 border-b flex flex-wrap gap-1">
        {OVERLAY_TYPES.map((t) => (
          <button
            key={t.type}
            onClick={() => handleAdd(t.type)}
            className="px-2 py-1 text-xs border rounded hover:bg-accent"
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {getOverlays().length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8">暂无弹出元素，点击上方按钮添加</p>
        ) : (
          getOverlays().map((overlay) => (
            <div key={overlay.id} className="border rounded p-2 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{overlay.name}</span>
                <button
                  onClick={() => deleteOverlay(chapter.id, overlay.id)}
                  className="text-xs text-red-500 hover:text-red-700"
                >
                  ×
                </button>
              </div>

              {/* 名称 */}
              <input
                type="text"
                value={overlay.name}
                onChange={(e) => updateOverlay(chapter.id, overlay.id, { name: e.target.value })}
                className="input"
                placeholder="名称"
              />

              {/* 位置 */}
              <div>
                <label className="text-xs text-muted-foreground block mb-1">位置</label>
                <div className="grid grid-cols-3 gap-1">
                  {POSITIONS.map((p) => (
                    <button
                      key={p.value}
                      onClick={() => updateOverlay(chapter.id, overlay.id, { position: p.value })}
                      className={`px-1 py-0.5 text-xs border rounded ${
                        overlay.position === p.value ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 动画 */}
              <div>
                <label className="text-xs text-muted-foreground block mb-1">动画</label>
                <OptionBlocks<AnimationPreset>
                  value={overlay.animation || 'fadeIn'}
                  onChange={(v) => updateOverlay(chapter.id, overlay.id, { animation: v })}
                  options={ANIMATIONS}
                />
              </div>

              {/* 时间 */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">开始(秒)</label>
                  <FrameTimeField
                    value={overlay.startFrame}
                    fps={fps}
                    onFrameChange={(f) => updateOverlay(chapter.id, overlay.id, { startFrame: f })}
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">结束(秒)</label>
                  <FrameTimeField
                    value={overlay.endFrame}
                    fps={fps}
                    onFrameChange={(f) => updateOverlay(chapter.id, overlay.id, { endFrame: f })}
                  />
                </div>
              </div>

              {/* 内容编辑 */}
              <OverlayContentEditor overlay={overlay} chapterId={chapter.id} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function OverlayContentEditor({ overlay, chapterId }: { overlay: OverlayItem; chapterId: string }) {
  const updateOverlay = useProjectStore((s) => s.updateOverlay);
  const content = overlay.content;

  switch (overlay.type) {
    case 'text':
      return (
        <div>
          <label className="text-xs text-muted-foreground block mb-1">文字内容</label>
          <textarea
            value={content.text?.content || ''}
            onChange={(e) => updateOverlay(chapterId, overlay.id, {
              content: { ...content, text: { ...(content.text || { content: '', fontSize: 28, color: '#fff' }), content: e.target.value } },
            })}
            className="input h-20 resize-none"
          />
          <div className="grid grid-cols-2 gap-2 mt-2">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">字号</label>
              <input
                type="number"
                value={content.text?.fontSize || 28}
                onChange={(e) => updateOverlay(chapterId, overlay.id, {
                  content: { ...content, text: { ...(content.text || { content: '', fontSize: 28, color: '#fff' }), fontSize: parseInt(e.target.value) || 28 } },
                })}
                className="input"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">颜色</label>
              <ColorPicker
                value={content.text?.color || '#fff'}
                onChange={(c) => updateOverlay(chapterId, overlay.id, {
                  content: { ...content, text: { ...(content.text || { content: '', fontSize: 28, color: '#fff' }), color: c } },
                })}
              />
            </div>
          </div>
        </div>
      );

    case 'person':
      return (
        <div className="space-y-2">
          <input
            type="text"
            value={content.person?.name || ''}
            onChange={(e) => updateOverlay(chapterId, overlay.id, { content: { ...content, person: { ...(content.person || { imageUrl: '', name: '' }), name: e.target.value } } })}
            className="input"
            placeholder="姓名"
          />
          <input
            type="text"
            value={content.person?.title || ''}
            onChange={(e) => updateOverlay(chapterId, overlay.id, { content: { ...content, person: { ...(content.person || { imageUrl: '', name: '' }), title: e.target.value } } })}
            className="input"
            placeholder="职务"
          />
          <input
            type="text"
            value={content.person?.description || ''}
            onChange={(e) => updateOverlay(chapterId, overlay.id, { content: { ...content, person: { ...(content.person || { imageUrl: '', name: '' }), description: e.target.value } } })}
            className="input"
            placeholder="描述"
          />
          <input
            type="text"
            value={content.person?.imageUrl || ''}
            onChange={(e) => updateOverlay(chapterId, overlay.id, { content: { ...content, person: { ...(content.person || { imageUrl: '', name: '' }), imageUrl: e.target.value } } })}
            className="input"
            placeholder="头像URL"
          />
        </div>
      );

    case 'chart':
      return (
        <div className="space-y-2">
          <input
            type="text"
            value={content.chart?.title || ''}
            onChange={(e) => updateOverlay(chapterId, overlay.id, { content: { ...content, chart: { ...content.chart, title: e.target.value, data: content.chart?.data || [], type: content.chart?.type || 'bar' } } })}
            className="input"
            placeholder="图表标题"
          />
          <OptionBlocks<'bar' | 'line' | 'pie' | 'area'>
            value={(content.chart?.type || 'bar') as any}
            onChange={(v) => updateOverlay(chapterId, overlay.id, { content: { ...content, chart: { ...content.chart, type: v, data: content.chart?.data || [] } } })}
            options={[
              { value: 'bar', label: '柱状图' },
              { value: 'line', label: '折线图' },
              { value: 'pie', label: '饼图' },
              { value: 'area', label: '面积图' },
            ]}
          />
          <textarea
            value={(content.chart?.data || []).map((d) => `${d.label}:${d.value}`).join('\n')}
            onChange={(e) => {
              const rows = e.target.value.split('\n')
                .map((r) => {
                  const [label, value] = r.split(':');
                  return { label: label?.trim() || '', value: parseFloat(value) || 0 };
                })
                .filter((d) => d.label);
              updateOverlay(chapterId, overlay.id, { content: { ...content, chart: { ...content.chart, data: rows, type: content.chart?.type || 'bar' } } });
            }}
            className="input h-20 resize-none"
            placeholder={'标签:数值，每行一个\n如: 兵力:5000\n装备:1200'}
          />
        </div>
      );

    case 'image':
      return (
        <input
          type="text"
          value={content.image?.url || content.src || ''}
          onChange={(e) => updateOverlay(chapterId, overlay.id, { content: { ...content, image: { url: e.target.value }, src: e.target.value } })}
          className="input"
          placeholder="图片URL"
        />
      );

    case 'video':
      return (
        <input
          type="text"
          value={content.src || ''}
          onChange={(e) => updateOverlay(chapterId, overlay.id, { content: { ...content, src: e.target.value, type: 'video' } })}
          className="input"
          placeholder="视频URL"
        />
      );

    case 'group':
      return (
        <p className="text-xs text-muted-foreground">组合元素：可包含多个子元素（由数据层级决定）</p>
      );

    default:
      return null;
  }
}

function createContent(type: OverlayType): any {
  switch (type) {
    case 'text':
      return { type, text: { content: '文本内容', fontSize: 28, color: '#FFFFFF' } };
    case 'person':
      return { type, person: { imageUrl: '', name: '人物', title: '', description: '' } };
    case 'chart':
      return { type, chart: { type: 'bar', title: '图表', data: [{ label: 'A', value: 30 }, { label: 'B', value: 50 }] } };
    case 'image':
      return { type, image: { url: '' } };
    case 'video':
      return { type, src: '' };
    case 'group':
      return { type, children: [] };
    default:
      return { type };
  }
}
