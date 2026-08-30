// PinStyleChooser：自定义图标文字块（同款样式、可删）排在基础样式后，+ 最后
const fs = require('fs');
const p = 'src/components/PropertiesPanel.tsx';
let s = fs.readFileSync(p, 'utf8');

const startMark = "<Section title={t('样式', 'Pin Style')}>";
const start = s.indexOf(startMark);
const end = s.indexOf('</Section>', start);
if (start === -1 || end === -1) { console.log('BOUNDS NOT FOUND'); process.exit(1); }
const end2 = end + '</Section>'.length;

const newBlock = `<Section title={t('样式', 'Pin Style')}>
      <div className="flex flex-wrap gap-1.5">
        {/* 基础样式 */}
        {([
          { value: 'pin', label: '📍 PIN' },
          { value: 'dot', label: '⚫ DOT' },
          { value: 'bubble', label: '💬 BUBBLE' },
          { value: 'flag', label: '🚩 MARKER' },
          { value: 'text', label: 'Aa TEXT' },
          { value: 'emoji', label: '😀 EMOJI' },
        ] as { value: PinStyle; label: string }[]).map((o) => (
          <button
            key={o.value}
            onClick={() => setStyle(o.value)}
            className={\`px-2.5 py-1.5 text-[11px] font-medium rounded-md border truncate transition-colors \${
              style === o.value
                ? 'bg-brand/20 border-brand text-foreground font-semibold'
                : 'bg-white/[0.03] border-white/10 text-foreground/80 hover:bg-accent hover:border-white/20'
            }\`}
          >
            {o.label}
          </button>
        ))}
        {/* 自定义图标：文字块同款样式，可删除 */}
        {project.customSymbols.map((s) => (
          <div key={s.id} className="relative group/sym">
            <button
              title={s.name}
              onClick={() => patch({ type: 'custom_icon', symbolId: s.id, coordinates: coords, size: 40, rotation: 0 } as Partial<MapElement>)}
              className={\`px-2.5 py-1.5 text-[11px] font-medium rounded-md border max-w-[88px] flex items-center gap-1 transition-colors \${
                style === 'image' && (element as unknown as CustomIconElement).symbolId === s.id
                  ? 'bg-brand/20 border-brand text-foreground font-semibold'
                  : 'bg-white/[0.03] border-white/10 text-foreground/80 hover:bg-accent hover:border-white/20'
              }\`}
            >
              <span className="truncate">{s.name}</span>
            </button>
            <button
              title={t('删除图标', 'Delete icon')}
              onClick={(e) => {
                e.stopPropagation();
                void confirm({ message: t(\`从图标库删除「\${s.name}」？\`, \`Delete "\${s.name}" from library?\`), danger: true, confirmText: t('删除', 'Delete') }).then((ok: boolean) => ok && removeCustomSymbol(s.id));
              }}
              className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white items-center justify-center hidden group-hover/sym:flex hover:bg-red-400"
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>
        ))}
        {/* 上传入口固定在最后 */}
        <IconUploadButton
          onPick={(id) => patch({ type: 'custom_icon', symbolId: id, coordinates: coords, size: 40, rotation: 0 } as Partial<MapElement>)}
        />
      </div>
    </Section>`;

s = s.slice(0, start) + newBlock + s.slice(end2);

// IconUploadButton 改成与选项块同款样式（+ 图标 + 文案）
s = s.replace(
  `      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        title="上传图片作为图标"
        className={\`w-9 h-9 rounded-md border border-dashed border-white/20 text-muted-foreground hover:text-foreground hover:border-white/40 transition-colors flex items-center justify-center \${className}\`}
      >
        <Plus size={14} />
      </button>`,
  `      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        title={t('上传图片作为图标', 'Upload image as icon')}
        className={\`px-2.5 py-1.5 text-[11px] font-medium rounded-md border border-dashed border-white/20 text-muted-foreground hover:text-foreground hover:border-white/40 transition-colors flex items-center gap-1 \${className}\`}
      >
        <Plus size={12} /> {t('上传', 'Upload')}
      </button>`
);
// IconUploadButton 需要 t
s = s.replace(
  'function IconUploadButton({ onPick, className = \'\' }: {\n  onPick: (symbolId: string) => void;\n  className?: string;\n}) {\n  const fileRef = useRef<HTMLInputElement>(null);',
  'function IconUploadButton({ onPick, className = \'\' }: {\n  onPick: (symbolId: string) => void;\n  className?: string;\n}) {\n  const t = useT();\n  const fileRef = useRef<HTMLInputElement>(null);'
);

fs.writeFileSync(p, s, 'utf8');
console.log('PinStyleChooser done');
