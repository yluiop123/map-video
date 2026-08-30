// ① 播放时隐藏编辑点/高亮 ② Pin 时间移到最后+自定义开关 ③ 路线删绘制动画/流动光点
const fs = require('fs');
const rep = (s, from, to, tag) => {
  if (!s.includes(from)) { console.log('MISS', tag || from.slice(0, 50)); return s; }
  return s.split(from).join(to);
};

// ---------- ① EditableMap：播放时隐藏编辑辅助层 ----------
{
  const p = 'src/components/EditableMap.tsx';
  let s = fs.readFileSync(p, 'utf8');
  // 重新订阅 isPlaying
  s = rep(s,
    '  const [styleTick, setStyleTick] = useState(0);',
    '  const [styleTick, setStyleTick] = useState(0);\n  const isPlaying = useEditorStore((s) => s.isPlaying);',
    'isPlaying-decl'
  );
  // 顶点 effect 之后追加隐藏 effect（锚定顶点 effect 的结尾）
  s = rep(s,
    "    } catch { /* style 未就绪：styleTick 后重试 */ }\n  }, [chapter, selectedElementId, styleTick]);",
    `    } catch { /* style 未就绪：styleTick 后重试 */ }
  }, [chapter, selectedElementId, styleTick]);

  // ===== 播放时隐藏编辑辅助（顶点标识 / 选中高亮） =====
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const vis = isPlaying ? 'none' : 'visible';
    ['vertex-dot', 'selection-line', 'selection-fill', 'selection-point', 'selection-move'].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    });
  }, [isPlaying, chapter, selectedElementId, styleTick]);`
  , 'hide-effect');

  fs.writeFileSync(p, s, 'utf8');
  console.log('EditableMap done');
}

// ---------- ②③ PropertiesPanel ----------
{
  const p = 'src/components/PropertiesPanel.tsx';
  let s = fs.readFileSync(p, 'utf8');

  // ③ 路线：删两处 ProgressAnimationToggle + 流动光点速度字段
  s = rep(s,
    `            <ProgressAnimationToggle
              keyframes={element.drawProgress}
              startFrame={element.startFrame}
              endFrame={element.endFrame}
              onChange={(v) => patch({ drawProgress: v })}
            />
            <Field label="流动光点速度（0=关）">
              <input type="range" min="0" max="20" step="1" value={element.flowSpeed || 0}
                onChange={(e) => patch({ flowSpeed: parseInt(e.target.value) || 0 })} className="w-full" />
            </Field>
          </>`,
    `          </>`
  , 'toggle-line');
  s = rep(s,
    `        {isMoving && (
          <ProgressAnimationToggle
            keyframes={(element as MovingPointElement).pathProgress}
            startFrame={element.startFrame}
            endFrame={element.endFrame}
            onChange={(v) => patch({ pathProgress: v })}
          />
        )}
      </Section>`,
    `      </Section>`
  , 'toggle-moving');

  // ProgressAnimationToggle 组件定义删除
  const cStart = s.indexOf('function ProgressAnimationToggle({ keyframes, startFrame, endFrame, onChange }: {');
  if (cStart !== -1) {
    const cEnd = s.indexOf('\n// 避免 CameraKeyframe', cStart);
    if (cEnd === -1) { console.log('PA component end MISS'); process.exit(1); }
    s = s.slice(0, cStart) + s.slice(cEnd + 1);
  } else { console.log('PA component MISS'); }

  // MovingPointElement 引用清理（删除后可能不再使用）
  if (!s.includes('MovingPointElement')) {
    s = s.replace('  MovingPointElement, LineElement, PolygonElement, ArrowElement,', '  LineElement, PolygonElement, ArrowElement,');
  }

  // ② 主面板：pin 的时间区块跳过
  s = rep(s,
    `        <Section title={undefined}>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('开始时间', 'Start Time')}>
              <FrameTimeField value={element.startFrame} fps={fps} onFrameChange={(f) => patch({ startFrame: f })} />
            </Field>
            <Field label={t('结束时间', 'End Time')}>
              <FrameTimeField value={element.endFrame} fps={fps} onFrameChange={(f) => patch({ endFrame: f })} />
            </Field>
          </div>
        </Section>`,
    `        {cat !== 'pin' && (
          <Section>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('开始时间', 'Start Time')}>
                <FrameTimeField value={element.startFrame} fps={fps} onFrameChange={(f) => patch({ startFrame: f })} />
              </Field>
              <Field label={t('结束时间', 'End Time')}>
                <FrameTimeField value={element.endFrame} fps={fps} onFrameChange={(f) => patch({ endFrame: f })} />
              </Field>
            </div>
          </Section>
        )}`
  , 'main-time-skip');

  // ② PinSettings 末尾（Delete Layer 之后）加 PinTimeSettings
  s = rep(s,
    `          <Trash2 size={14} /> {t('删除图层', 'Delete Layer')}
        </button>
      </div>
    </div>
  );
}`,
    `          <Trash2 size={14} /> {t('删除图层', 'Delete Layer')}
        </button>

        {/* 显示时间：默认全程显示，开启后可自定义起止时间 */}
        <PinTimeSettings key={element.id} element={element} patch={patch} project={project} />
      </div>
    </div>
  );
}`
  , 'pin-time-mount');

  // PinTimeSettings 组件定义（挂在 PinSettings 函数后）
  const anchor = '\nfunction pinStyleOf(';
  const comp = `
/** 显示时间：默认全程显示（不开启），开启后可自定义起止时间 */
function PinTimeSettings({ element, patch, project }: {
  element: MapElement;
  patch: (c: Partial<MapElement>) => void;
  project: NonNullable<ReturnType<typeof useProjectStore.getState>['project']>;
}) {
  const t = useT();
  const ch = project.chapters.find((c) => c.elements.some((e) => e.id === element.id)) || project.chapters[0];
  const fps = project.globalConfig.defaultFPS;
  const [on, setOn] = useState(element.startFrame !== ch.startFrame || element.endFrame !== ch.endFrame);

  return (
    <Section title={t('显示时间', 'Display Time')}>
      <Toggle
        checked={on}
        label={t('自定义显示时间', 'Custom display time')}
        onChange={(v) => {
          setOn(v);
          if (!v) patch({ startFrame: ch.startFrame, endFrame: ch.endFrame });
        }}
      />
      {on && (
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('开始时间', 'Start Time')}>
            <FrameTimeField value={element.startFrame} fps={fps} onFrameChange={(f) => patch({ startFrame: f })} />
          </Field>
          <Field label={t('结束时间', 'End Time')}>
            <FrameTimeField value={element.endFrame} fps={fps} onFrameChange={(f) => patch({ endFrame: f })} />
          </Field>
        </div>
      )}
    </Section>
  );
}
`;
  s = rep(s, anchor, comp + anchor, 'pin-time-comp');
  // FrameTimeField 已引入 ✓（顶部已有）

  fs.writeFileSync(p, s, 'utf8');
  console.log('PropertiesPanel done | PA refs:', (s.match(/ProgressAnimationToggle/g) || []).length, '| flowSpeed ui:', s.includes('流动光点速度'));
}
console.log('ALL DONE');
