import { useEffect, useMemo, useState } from 'react';
import { useProjectStore } from '../stores/projectStore';
import { useEditorStore } from '../stores/editorStore';
import { useInteractionStore } from '../stores/interactionStore';
import { generateId } from '../types';
import { listRegionNames, findRegionByName, regionHitsToShapes } from '../lib/regions';
import type { PolygonElement } from '../types';

/** 常用国家英文名 → 中文（数据源为英文属性，未映射的保持英文显示与搜索） */
const CN_NAMES: Record<string, string> = {
  China: '中国', Taiwan: '台湾', 'United States of America': '美国', Russia: '俄罗斯', Japan: '日本',
  'South Korea': '韩国', 'North Korea': '朝鲜', India: '印度', Vietnam: '越南', France: '法国',
  Germany: '德国', 'United Kingdom': '英国', Italy: '意大利', Spain: '西班牙', Portugal: '葡萄牙',
  Netherlands: '荷兰', Belgium: '比利时', Switzerland: '瑞士', Austria: '奥地利', Poland: '波兰',
  Ukraine: '乌克兰', Turkey: '土耳其', Iran: '伊朗', Iraq: '伊拉克', Israel: '以色列',
  'Saudi Arabia': '沙特阿拉伯', Egypt: '埃及', 'South Africa': '南非', Nigeria: '尼日利亚', Kenya: '肯尼亚',
  Ethiopia: '埃塞俄比亚', Brazil: '巴西', Argentina: '阿根廷', Chile: '智利', Colombia: '哥伦比亚',
  Mexico: '墨西哥', Canada: '加拿大', Australia: '澳大利亚', 'New Zealand': '新西兰', Indonesia: '印度尼西亚',
  Malaysia: '马来西亚', Thailand: '泰国', Myanmar: '缅甸', Philippines: '菲律宾', Cambodia: '柬埔寨',
  Laos: '老挝', Bangladesh: '孟加拉国', Pakistan: '巴基斯坦', Afghanistan: '阿富汗', Kazakhstan: '哈萨克斯坦',
  Mongolia: '蒙古', Nepal: '尼泊尔', Greece: '希腊', Sweden: '瑞典', Norway: '挪威',
  Finland: '芬兰', Denmark: '丹麦', Ireland: '爱尔兰', Romania: '罗马尼亚', Hungary: '匈牙利',
  Serbia: '塞尔维亚', Cuba: '古巴', Venezuela: '委内瑞拉', Peru: '秘鲁', Bolivia: '玻利维亚',
  Morocco: '摩洛哥', Algeria: '阿尔及利亚', Libya: '利比亚', Sudan: '苏丹', Tanzania: '坦桑尼亚',
  Angola: '安哥拉', Mozambique: '莫桑比克', Zimbabwe: '津巴布韦', Zambia: '赞比亚', Somalia: '索马里',
  Chad: '乍得', Mali: '马里', Niger: '尼日尔', Qatar: '卡塔尔', 'United Arab Emirates': '阿联酋',
  Oman: '阿曼', Yemen: '也门', Jordan: '约旦', Syria: '叙利亚', Lebanon: '黎巴嫩',
  Kuwait: '科威特', Singapore: '新加坡', 'Sri Lanka': '斯里兰卡', Uzbekistan: '乌兹别克斯坦',
  Turkmenistan: '土库曼斯坦', Kyrgyzstan: '吉尔吉斯斯坦', Tajikistan: '塔吉克斯坦', Bhutan: '不丹',
  Czechia: '捷克', 'Slovakia': '斯洛伐克', Bulgaria: '保加利亚', Croatia: '克罗地亚',
  'Bosnia and Herzegovina': '波黑', Albania: '阿尔巴尼亚', 'North Macedonia': '北马其顿',
  Lithuania: '立陶宛', Latvia: '拉脱维亚', Estonia: '爱沙尼亚', Belarus: '白俄罗斯',
  'Moldova': '摩尔多瓦', Georgia: '格鲁吉亚', Armenia: '亚美尼亚', Azerbaijan: '阿塞拜疆',
};

export function cnName(en: string): string {
  return CN_NAMES[en] || en;
}

interface RegionPickerDialogProps {
  onClose: () => void;
}

/** 区域列表选择器：搜索国家名 → 一键生成本段高亮面（无需在地图上点选） */
export function RegionPickerDialog({ onClose }: RegionPickerDialogProps) {
  const project = useProjectStore((s) => s.project);
  const selectedChapterId = useEditorStore((s) => s.selectedChapterId);
  const addElements = useProjectStore((s) => s.addElements);
  const selectElement = useEditorStore((s) => s.selectElement);

  const [names, setNames] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    listRegionNames()
      .then((n) => { if (alive) setNames(n); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : '边界数据加载失败'); });
    return () => { alive = false; };
  }, []);

  const chapter = project?.chapters.find((c) => c.id === selectedChapterId) || project?.chapters[0];

  // 过滤：中文名 / 英文名
  const filtered = useMemo(() => {
    if (!names) return [];
    const query = q.trim().toLowerCase();
    if (!query) return names;
    return names.filter((n) => {
      const cn = cnName(n);
      return n.toLowerCase().includes(query) || cn.toLowerCase().includes(query);
    });
  }, [names, q]);

  const handleAdd = async (en: string) => {
    if (!chapter || busy) return;
    setBusy(true);
    try {
      const hit = await findRegionByName(en);
      if (!hit) { alert('未找到该区域边界'); return; }
      const shapes = regionHitsToShapes([hit]);
      const els: PolygonElement[] = shapes.map((s) => ({
        id: generateId(), type: 'polygon', name: s.name, visible: true, locked: false,
        startFrame: chapter.startFrame, endFrame: chapter.endFrame, style: {},
        coordinates: s.rings as [number, number][][],
        fillColor: '#E23B3B', fillOpacity: 0.25, strokeColor: '#FF6666', strokeWidth: 2,
      } as PolygonElement));
      addElements(chapter.id, els);
      selectElement(els[0].id);
      onClose();
    } catch (e) {
      alert(e instanceof Error ? e.message : '生成区域失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-[100] flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-card border border-white/10 rounded-xl shadow-xl w-[420px] max-w-[92vw] flex flex-col"
        style={{ maxHeight: '80vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-4 pb-2">
          <h2 className="text-base font-semibold">🌐 高亮区域</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            搜索国家/地区并一键添加为本段高亮面（添加到「{chapter?.title || '-'}」）
          </p>
        </div>

        <div className="px-4 pb-2">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索：中国 / Japan / 巴西 …"
            className="w-full px-3 py-2 text-sm bg-background border rounded"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-2" style={{ minHeight: 160 }}>
          {error && (
            <div className="text-xs text-red-500 py-4 text-center">
              {error}
              <button
                onClick={() => { setError(null); setNames(null); listRegionNames().then(setNames).catch((e2) => setError(e2.message)); }}
                className="ml-2 underline"
              >重试</button>
            </div>
          )}
          {!error && names === null && (
            <div className="text-xs text-muted-foreground py-6 text-center">边界数据加载中…（首次约 250KB）</div>
          )}
          {names !== null && filtered.length === 0 && (
            <div className="text-xs text-muted-foreground py-6 text-center">未匹配区域</div>
          )}
          {names !== null && filtered.length > 0 && (
            <div className="grid grid-cols-2 gap-1 pb-2">
              {filtered.map((n) => (
                <button
                  key={n}
                  disabled={busy}
                  onClick={() => handleAdd(n)}
                  className="text-left px-2 py-1.5 text-xs border rounded hover:bg-accent disabled:opacity-50 truncate"
                  title={busy ? '生成中…' : `添加 ${cnName(n)}`}
                >
                  <span className="font-medium">{cnName(n)}</span>
                  {cnName(n) !== n && <span className="text-muted-foreground ml-1">{n}</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="px-4 py-2 border-t flex items-center justify-between">
          <button
            onClick={() => {
              useInteractionStore.getState().setMode('add_region');
              onClose();
            }}
            className="text-xs text-blue-600 hover:underline"
          >
            🪄 或在地图上直接点选国土
          </button>
          <button onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground">关闭</button>
        </div>
      </div>
    </div>
  );
}
