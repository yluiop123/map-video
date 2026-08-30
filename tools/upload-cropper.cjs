// 上传图标弹窗改用 react-easy-crop：方形/圆形/原图 三种模式
const fs = require('fs');
const p = 'src/components/PropertiesPanel.tsx';
let s = fs.readFileSync(p, 'utf8');

// 1) imports
s = s.replace(
  "import { useConfirm } from './ui/ConfirmHost';",
  "import { useConfirm } from './ui/ConfirmHost';\nimport Cropper from 'react-easy-crop';\nimport 'react-easy-crop/dist/react-easy-crop.css';"
);

// 2) 替换整个 UploadIconDialog（从其文档注释到 IconUploadButton 注释之前）
const startMark = '/** 上传图标弹窗：拖选裁剪区域 + 形状（方/圆）+ 实时 64×64 预览 + 命名入图标库 */';
const endMark = '/** 上传图标按钮：';
const start = s.indexOf(startMark);
const end = s.indexOf(endMark);
if (start === -1 || end === -1) { console.log('BOUNDS NOT FOUND', start, end); process.exit(1); }

const newDialog = `/** 上传图标弹窗（react-easy-crop）：方形/圆形裁剪 或 原图直传，统一输出 64×64 */
function UploadIconDialog({ dataUrl, defaultName, onConfirm, onCancel }: {
  dataUrl: string;
  defaultName: string;
  onConfirm: (symbolId: string) => void;
  onCancel: () => void;
}) {
  const addCustomSymbol = useProjectStore((s) => s.addCustomSymbol);
  const t = useT();
  const [name, setName] = useState(defaultName);
  const [mode, setMode] = useState<'square' | 'circle' | 'original'>('square');
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const cropPxRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);

  const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });

  // 实时预览（模式/裁剪变化时重绘 64×64）
  useEffect(() => {
    let alive = true;
    (async () => {
      const cv = previewRef.current;
      if (!cv) return;
      const ctx = cv.getContext('2d')!;
      ctx.clearRect(0, 0, 64, 64);
      try {
        const img = await loadImage(dataUrl);
        if (!alive) return;
        if (mode === 'original') {
          const k = Math.min(64 / img.naturalWidth, 64 / img.naturalHeight);
          const w = img.naturalWidth * k, h = img.naturalHeight * k;
          ctx.drawImage(img, (64 - w) / 2, (64 - h) / 2, w, h);
          return;
        }
        const px = cropPxRef.current;
        if (!px || px.width < 4 || px.height < 4) return;
        ctx.save();
        if (mode === 'circle') { ctx.beginPath(); ctx.arc(32, 32, 32, 0, Math.PI * 2); ctx.clip(); }
        ctx.drawImage(img, px.x, px.y, px.width, px.height, 0, 0, 64, 64);
        ctx.restore();
      } catch { /* 忽略预览失败 */ }
    })();
    return () => { alive = false; };
  }, [dataUrl, mode, crop, zoom]);

  const buildExport = async (): Promise<string | null> => {
    const img = await loadImage(dataUrl);
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const ctx = c.getContext('2d')!;
    if (mode === 'original') {
      const k = Math.min(64 / img.naturalWidth, 64 / img.naturalHeight);
      const w = img.naturalWidth * k, h = img.naturalHeight * k;
      ctx.drawImage(img, (64 - w) / 2, (64 - h) / 2, w, h);
      return c.toDataURL('image/png');
    }
    const px = cropPxRef.current;
    if (!px || px.width < 4 || px.height < 4) return null;
    if (mode === 'circle') { ctx.beginPath(); ctx.arc(32, 32, 32, 0, Math.PI * 2); ctx.clip(); }
    ctx.drawImage(img, px.x, px.y, px.width, px.height, 0, 0, 64, 64);
    return c.toDataURL('image/png');
  };

  const confirmAdd = async () => {
    const url = await buildExport();
    if (!url) return;
    const id = generateId();
    addCustomSymbol({ id, name: name.trim() || '图标', type: 'image', url, width: 64, height: 64 });
    onConfirm(id);
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-[70] flex items-center justify-center" onClick={onCancel}>
      <div className="w-[380px] bg-card border border-white/10 rounded-2xl shadow-2xl p-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold mb-3">{t('上传图标', 'Upload Icon')}</h3>

        {/* 裁剪模式 */}
        <OptionBlocks<'square' | 'circle' | 'original'>
          value={mode}
          onChange={(v) => { setMode(v); setCrop({ x: 0, y: 0 }); setZoom(1); }}
          options={[
            { value: 'square', label: t('方形', 'Square') },
            { value: 'circle', label: t('圆形', 'Circle') },
            { value: 'original', label: t('原图', 'Original') },
          ]}
        />

        {/* 裁剪器 / 原图预览 */}
        <div className="mt-2 mb-3">
          {mode === 'original' ? (
            <div className="h-48 rounded-lg border border-white/10 bg-white/[0.04] flex items-center justify-center overflow-hidden">
              <img src={dataUrl} alt="" className="max-w-full max-h-full object-contain" />
            </div>
          ) : (
            <Cropper
              image={dataUrl}
              crop={crop}
              zoom={zoom}
              aspect={1}
              cropShape={mode === 'circle' ? 'round' : 'rect'}
              showGrid={false}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={(_, px) => { cropPxRef.current = px; }}
              style={{ containerStyle: { height: 200, width: '100%', borderRadius: 8 } }}
            />
          )}
        </div>

        {/* 预览 + 命名 */}
        <div className="flex items-center gap-3 mb-3">
          <div className="w-14 h-14 rounded-lg border border-white/10 bg-white/[0.04] flex items-center justify-center overflow-hidden shrink-0">
            <canvas ref={previewRef} width={64} height={64} className="w-full h-full object-contain" />
          </div>
          <div className="flex-1 min-w-0">
            <label className="text-[11px] text-muted-foreground block mb-1">{t('图标名称', 'Icon Name')}</label>
            <input
              autoFocus value={name} onChange={(e) => setName(e.target.value)}
              className="input h-8 text-xs" placeholder={t('图标名称', 'Icon Name')}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmAdd(); }}
            />
            <p className="text-[10px] text-muted-foreground mt-1">{t('统一输出 64×64 图标', 'Outputs a 64×64 icon')}</p>
          </div>
        </div>

        <div className="flex gap-2">
          <button onClick={onCancel} className="btn-outline text-xs flex-1 py-1.5">{t('取消', 'Cancel')}</button>
          <button onClick={confirmAdd} className="btn-primary text-xs flex-1 py-1.5">{t('添加', 'Add')}</button>
        </div>
      </div>
    </div>
  );
}

`;

s = s.slice(0, start) + newDialog + s.slice(end);
fs.writeFileSync(p, s, 'utf8');
console.log('UploadIconDialog replaced, cropPxRef used:', s.includes('cropPxRef'));
