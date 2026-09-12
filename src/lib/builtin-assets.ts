/**
 * builtin-assets.ts — 内置标记资源（打包进应用，不落库、零网络依赖）
 *
 * 三种内置资源形态：
 *   · 图片：内联 SVG dataURL（矢量、可着色、约 1KB/个）
 *   · 动图：程序化动画描述符（渲染端用 canvas 逐帧绘制，不依赖 GIF 文件）
 *   · 模型：程序化几何描述符（three.js 用基础几何拼装简模）
 *
 * 想换成真实文件（png / gif / glb）时：把文件放进 `src/assets/builtin/`，
 * 并把对应条目的 `src` / `anim` / `model` 换成文件路径即可 —— 其余代码无需改动。
 *
 * 元素侧只需存 `builtinId`（如 `image:flag`），不把资源本体写进项目。
 */

/** 程序化动画描述符（内置动图） */
export type ProceduralAnim =
  | { type: 'radar' }                       // 雷达扫描（扇形旋转）
  | { type: 'pulse'; rings?: number }       // 脉冲圈（同心圆扩散）
  | { type: 'sonar' }                       // 声呐波纹
  | { type: 'blink' }                       // 闪烁点
  | { type: 'sweep' }                       // 横向扫描线
  | { type: 'spin' }                        // 旋转箭头
  | { type: 'crosshair' }                   // 准星呼吸
  | { type: 'wave' };                       // 波浪（信号）

/** 程序化模型描述符（内置 3D 简模） */
export type ProceduralModel =
  | { kind: 'drone' }      // 无人机（机身 + 四旋翼）
  | { kind: 'jet' }        // 战机
  | { kind: 'tank' }       // 坦克
  | { kind: 'ship' }       // 军舰
  | { kind: 'missile' };   // 导弹

export interface BuiltinAsset {
  /** 内置资源 id，写入元素 builtinId */
  id: string;
  /** 资源种类，与 id 前缀一致 */
  kind: 'image' | 'gif' | 'model' | 'icon';
  /** 中文名（面板展示 / 搜索） */
  name: string;
  /** 搜索关键词 */
  tags?: string[];
  /** 是否可着色（白色=原色；image/gif/model 内置资源均为白色/浅色基图，multiply 染色） */
  tintable?: boolean;
  /** image：SVG dataURL */
  src?: string;
  /** gif：程序化动画 */
  anim?: ProceduralAnim;
  /** model：程序化几何 */
  model?: ProceduralModel;
  /** model：默认包围盒尺寸（米，供缩放换算与离地高度参考） */
  sizeMeters?: number;
}

/** 把 SVG 片段包成 dataURL（固定白色填充，渲染时按 color 乘法着色） */
const S = (inner: string): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#FFFFFF">${inner}</svg>`,
  )}`;

/** 内置图集（20 个，军事/地图常用图形；全部可着色） */
export const BUILTIN_IMAGES: BuiltinAsset[] = [
  { id: 'image:flag', kind: 'image', name: '旗帜', tags: ['标记', 'flag'], tintable: true, src: S('<path d="M6 3v18h2v-7h8.5l-1.8-4.5H8V3z"/>') },
  { id: 'image:flag-outline', kind: 'image', name: '空心旗', tags: ['标记', 'flag'], tintable: true, src: S('<path d="M6 3h1.6v18H6z"/><path d="M9 5h7.6l1.8 4.5-1.8 4.5H9V5zm1.6 1.6v5.8h5.2l-1.2-2.9 1.2-2.9H10.6z"/>') },
  { id: 'image:objective', kind: 'image', name: '目标', tags: ['标记', '目标'], tintable: true, src: S('<path d="M12 2A10 10 0 1 0 22 12A10 10 0 0 0 12 2zm0 3a7 7 0 1 1-7 7a7 7 0 0 1 7-7z"/><circle cx="12" cy="12" r="3"/>') },
  { id: 'image:target', kind: 'image', name: '靶心', tags: ['标记', '靶'], tintable: true, src: S('<circle cx="12" cy="12" r="9" fill="none" stroke="#FFFFFF" stroke-width="2"/><circle cx="12" cy="12" r="4"/><path d="M12 0v5M12 19v5M0 12h5M19 12h5" stroke="#FFFFFF" stroke-width="2"/>') },
  { id: 'image:waypoint', kind: 'image', name: '航点', tags: ['标记', '航点'], tintable: true, src: S('<path d="M12 1.5 22.5 12 12 22.5 1.5 12z"/>') },
  { id: 'image:base', kind: 'image', name: '基地', tags: ['设施', '基地'], tintable: true, src: S('<path d="M3 20V9l9-6 9 6v11h-6v-6h-6v6z"/>') },
  { id: 'image:radar-station', kind: 'image', name: '雷达站', tags: ['设施', '雷达'], tintable: true, src: S('<path d="M12 20v-7"/><path d="M4.6 7.6a10.5 10.5 0 0 1 14.8 0" fill="none" stroke="#FFFFFF" stroke-width="2"/><path d="M7.8 11a6 6 0 0 1 8.4 0" fill="none" stroke="#FFFFFF" stroke-width="2"/><circle cx="12" cy="13" r="2"/>') },
  { id: 'image:airfield', kind: 'image', name: '机场', tags: ['设施', '航空'], tintable: true, src: S('<path d="M12 2 13.4 9.2 21 12v2l-7.6-.8L12 22l-1.4-8.8L3 14v-2l7.6-2.8z"/>') },
  { id: 'image:port', kind: 'image', name: '港口', tags: ['设施', '港口'], tintable: true, src: S('<path d="M12 3a2 2 0 1 1-2 2a2 2 0 0 1 2-2zm-1 5h2v4h5v2h-5v3.2c2.3-.4 4-1.7 4-1.7l1 1.7s-2.6 2.3-6 2.3s-6-2.3-6-2.3l1-1.7s1.7 1.3 4 1.7V14H7v-2h4z"/>') },
  { id: 'image:bridge', kind: 'image', name: '桥梁', tags: ['设施', '桥梁'], tintable: true, src: S('<path d="M2 15h20v2H2z"/><path d="M6 15c0-4 2.7-7 6-7s6 3 6 7h-2c0-3-1.8-5-4-5s-4 2-4 5z"/>') },
  { id: 'image:danger', kind: 'image', name: '危险', tags: ['警示'], tintable: true, src: S('<path d="M12 2 23 21H1zM11 9h2v6h-2zm0 7h2v2h-2z"/>') },
  { id: 'image:warning-outline', kind: 'image', name: '警告（空心）', tags: ['警示'], tintable: true, src: S('<path d="M12 3.3 21.2 20H2.8zM12 6.6 5.6 18h12.8z"/><rect x="11" y="10" width="2" height="4"/><rect x="11" y="15" width="2" height="2"/>') },
  { id: 'image:star', kind: 'image', name: '五角星', tags: ['图形'], tintable: true, src: S('<path d="m12 2 3 7 7.5.6-5.7 4.9 1.7 7.3L12 17.9 5.5 21.8l1.7-7.3L1.5 9.6 9 9z"/>') },
  { id: 'image:cross', kind: 'image', name: '十字', tags: ['医疗', '图形'], tintable: true, src: S('<path d="M10 3h4v7h7v4h-7v7h-4v-7H3v-4h7z"/>') },
  { id: 'image:shield', kind: 'image', name: '盾牌', tags: ['防御'], tintable: true, src: S('<path d="M12 2 21 5v7c0 5-3.8 8.6-9 10-5.2-1.4-9-5-9-10V5z"/>') },
  { id: 'image:hexagon', kind: 'image', name: '六边形', tags: ['图形'], tintable: true, src: S('<path d="M12 2 21 7v10l-9 5-9-5V7z"/>') },
  { id: 'image:square', kind: 'image', name: '方块', tags: ['图形'], tintable: true, src: S('<rect x="4" y="4" width="16" height="16" rx="2"/>') },
  { id: 'image:triangle', kind: 'image', name: '三角', tags: ['图形'], tintable: true, src: S('<path d="M12 3 22 20H2z"/>') },
  { id: 'image:pin-classic', kind: 'image', name: '定位针', tags: ['标记'], tintable: true, src: S('<path d="M12 22s7-7.4 7-12a7 7 0 1 0-14 0c0 4.6 7 12 7 12z"/><circle cx="12" cy="10" r="2.6" fill="#00000055"/>') },
  { id: 'image:arrow-up', kind: 'image', name: '上行箭头', tags: ['箭头'], tintable: true, src: S('<path d="M12 2 20 12h-5v10H9V12H4z"/>') },
];

/** 内置动图（8 个程序化动画；白色基图，可着色） */
export const BUILTIN_GIFS: BuiltinAsset[] = [
  { id: 'gif:radar', kind: 'gif', name: '雷达扫描', tags: ['扫描'], tintable: true, anim: { type: 'radar' } },
  { id: 'gif:pulse', kind: 'gif', name: '脉冲圈', tags: ['脉冲'], tintable: true, anim: { type: 'pulse', rings: 3 } },
  { id: 'gif:sonar', kind: 'gif', name: '声呐波纹', tags: ['波纹'], tintable: true, anim: { type: 'sonar' } },
  { id: 'gif:blink', kind: 'gif', name: '闪烁点', tags: ['闪烁'], tintable: true, anim: { type: 'blink' } },
  { id: 'gif:sweep', kind: 'gif', name: '扫描线', tags: ['扫描'], tintable: true, anim: { type: 'sweep' } },
  { id: 'gif:spin', kind: 'gif', name: '旋转箭头', tags: ['旋转'], tintable: true, anim: { type: 'spin' } },
  { id: 'gif:crosshair', kind: 'gif', name: '准星呼吸', tags: ['准星'], tintable: true, anim: { type: 'crosshair' } },
  { id: 'gif:wave', kind: 'gif', name: '信号波', tags: ['信号'], tintable: true, anim: { type: 'wave' } },
];

/** 内置模型（5 个程序化简模；可着色、不能贴地） */
export const BUILTIN_MODELS: BuiltinAsset[] = [
  { id: 'model:drone', kind: 'model', name: '无人机', tags: ['航空'], tintable: true, model: { kind: 'drone' }, sizeMeters: 200 },
  { id: 'model:jet', kind: 'model', name: '战机', tags: ['航空'], tintable: true, model: { kind: 'jet' }, sizeMeters: 400 },
  { id: 'model:tank', kind: 'model', name: '坦克', tags: ['地面'], tintable: true, model: { kind: 'tank' }, sizeMeters: 150 },
  { id: 'model:ship', kind: 'model', name: '军舰', tags: ['海上'], tintable: true, model: { kind: 'ship' }, sizeMeters: 600 },
  { id: 'model:missile', kind: 'model', name: '导弹', tags: ['武器'], tintable: true, model: { kind: 'missile' }, sizeMeters: 100 },
];

// 军标不在此文件：它是独立元素类型（MilitarySymbolElement / type='military_symbol'），
// 由 milsymbol 库（APP-6 / MIL-STD-2525 官方规范实现）按 SIDC 编码生成标准符号图，
// 不走标记的 builtin 图集管线（见 PropertiesPanel 的 MilSymSettings 与 map-renderer 的 renderMilitarySymbol）。

/** 全部内置资源（按 id 索引） */
export const BUILTIN_ALL: BuiltinAsset[] = [...BUILTIN_IMAGES, ...BUILTIN_GIFS, ...BUILTIN_MODELS];

const BY_ID = new Map(BUILTIN_ALL.map((a) => [a.id, a]));

// ========== 军标（milsymbol 动态生成） ==========
//
// builtinId = 'milsym:<SIDC>'（如 milsym:SFG-UCI---），不落在静态图集里：
// 首次访问时用 milsymbol（APP-6 / MIL-STD-2525 官方规范实现）渲染 64px SVG 并缓存。
// 元素属性（大小/朝向/颜色/标签）与图片形态完全一致，复用标记的位图管线。

import ms from 'milsymbol';

const MILSYM_CACHE = new Map<string, BuiltinAsset>();

/** 按 id 取内置资源；不存在返回 undefined（渲染端需自行回退） */
export function getBuiltinAsset(id?: string | null): BuiltinAsset | undefined {
  if (id && id.startsWith('milsym:')) {
    const sidc = id.slice('milsym:'.length);
    let asset = MILSYM_CACHE.get(sidc);
    if (!asset) {
      try {
        const svg = new ms.Symbol(sidc, { size: 64, fill: true }).asSVG();
        asset = { id, kind: 'image', name: '军标', tags: ['军标'], tintable: true, src: `data:image/svg+xml,${encodeURIComponent(svg)}` };
      } catch {
        return undefined;
      }
      MILSYM_CACHE.set(sidc, asset);
    }
    return asset;
  }
  return id ? BY_ID.get(id) : undefined;
}

/**
 * 内置图标库：推荐图标名清单（用于面板默认展示与排序）。
 * 全量图标在打开图标库面板时通过 `import('lucide-react')` 懒加载（见 icon-library.ts），
 * 首屏不受影响。
 */
export const BUILTIN_ICON_NAMES: string[] = [
  // 位置 / 导航
  'MapPin', 'MapPinned', 'LocateFixed', 'Crosshair', 'Navigation', 'Compass', 'Route', 'Milestone', 'Signpost',
  // 军事 / 目标
  'Target', 'Crosshair', 'Swords', 'Shield', 'ShieldAlert', 'Bomb', 'Radar', 'Rocket',
  // 交通 / 载具
  'Plane', 'PlaneTakeoff', 'Ship', 'Anchor', 'Truck', 'Car', 'TrainFront', 'Bike',
  // 设施 / 建筑
  'Building2', 'Factory', 'Warehouse', 'TowerControl', 'Radio', 'Antenna', 'Satellite', 'Fuel',
  // 人物 / 编组
  'User', 'Users', 'UserRound', 'Flag', 'Star', 'Heart', 'Skull',
  // 状态 / 警示（lucide 0.4xx 重命名：AlertTriangle→TriangleAlert、CheckCircle2→CircleCheckBig、XCircle→CircleX、Unlock→LockOpen）
  'TriangleAlert', 'Info', 'CircleCheckBig', 'CircleX', 'Eye', 'EyeOff', 'Lock', 'LockOpen',
  // 通用
  'Circle', 'Square', 'Triangle', 'Hexagon', 'Diamond', 'ArrowUp', 'ArrowRight', 'Zap', 'Flame', 'Cloud', 'Wind', 'Waves',
];
