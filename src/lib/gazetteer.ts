/**
 * gazetteer.ts — 本地地名库 + 从文本抽取地名（**不依赖 AI / 可离线**）
 *
 * 用途：一键生成时从字幕文本里找出地名 → 作为相机中心 + 自动落点标记。
 * 抽到即用；抽不到就回退默认概览。所有结果都可在编辑器里手动增删改。
 */

export interface Place {
  name: string;
  /** 别名（含古称 / 简称） */
  aliases?: string[];
  center: [number, number];
  /** 相机缩放（缺省 5） */
  zoom?: number;
}

/** 中国省级 + 省会/直辖市 */
const CHINA: Place[] = [
  { name: '北京', aliases: ['蓟', '燕京', '大都'], center: [116.4, 39.9], zoom: 7 },
  { name: '天津', center: [117.2, 39.1], zoom: 7 },
  { name: '上海', center: [121.47, 31.23], zoom: 7 },
  { name: '重庆', aliases: ['巴郡'], center: [106.55, 29.56], zoom: 7 },
  { name: '石家庄', center: [114.5, 38.0], zoom: 7 },
  { name: '太原', aliases: ['晋阳'], center: [112.55, 37.87], zoom: 7 },
  { name: '呼和浩特', center: [111.75, 40.84], zoom: 7 },
  { name: '沈阳', center: [123.43, 41.8], zoom: 7 },
  { name: '长春', center: [125.32, 43.9], zoom: 7 },
  { name: '哈尔滨', center: [126.53, 45.8], zoom: 7 },
  { name: '南京', aliases: ['建康', '金陵'], center: [118.8, 32.06], zoom: 7 },
  { name: '杭州', aliases: ['临安'], center: [120.15, 30.27], zoom: 7 },
  { name: '合肥', center: [117.28, 31.86], zoom: 7 },
  { name: '福州', center: [119.3, 26.08], zoom: 7 },
  { name: '南昌', center: [115.89, 28.68], zoom: 7 },
  { name: '济南', center: [117.0, 36.65], zoom: 7 },
  { name: '郑州', center: [113.62, 34.75], zoom: 7 },
  { name: '武汉', center: [114.3, 30.6], zoom: 7 },
  { name: '长沙', center: [112.98, 28.19], zoom: 7 },
  { name: '广州', aliases: ['南海郡', '番禺'], center: [113.26, 23.13], zoom: 7 },
  { name: '南宁', center: [108.32, 22.82], zoom: 7 },
  { name: '海口', center: [110.2, 20.04], zoom: 7 },
  { name: '成都', aliases: ['蜀郡', '益州'], center: [104.07, 30.67], zoom: 7 },
  { name: '贵阳', center: [106.63, 26.65], zoom: 7 },
  { name: '昆明', center: [102.83, 24.88], zoom: 7 },
  { name: '拉萨', center: [91.14, 29.65], zoom: 7 },
  { name: '西安', aliases: ['长安', '镐京', '栎阳'], center: [108.95, 34.27], zoom: 7 },
  { name: '兰州', center: [103.83, 36.06], zoom: 7 },
  { name: '西宁', center: [101.78, 36.62], zoom: 7 },
  { name: '银川', center: [106.23, 38.49], zoom: 7 },
  { name: '乌鲁木齐', center: [87.62, 43.82], zoom: 7 },
  { name: '香港', center: [114.17, 22.32], zoom: 8 },
  { name: '澳门', center: [113.55, 22.2], zoom: 8 },
  { name: '台北', center: [121.56, 25.03], zoom: 8 },
];

/** 历史地名 / 关隘 / 山川 / 郡县 */
const HISTORIC: Place[] = [
  { name: '咸阳', aliases: ['秦都', '秦'], center: [108.7, 34.33], zoom: 8 },
  { name: '洛阳', aliases: ['成周', '东都'], center: [112.45, 34.62], zoom: 8 },
  { name: '邯郸', aliases: ['赵'], center: [114.5, 36.6], zoom: 8 },
  { name: '开封', aliases: ['大梁', '汴梁', '魏'], center: [114.3, 34.8], zoom: 8 },
  { name: '淄博', aliases: ['临淄', '齐'], center: [118.05, 36.8], zoom: 8 },
  { name: '荆州', aliases: ['郢', '楚'], center: [112.2, 30.35], zoom: 8 },
  { name: '新郑', aliases: ['郑', '韩'], center: [113.74, 34.4], zoom: 8 },
  { name: '临汾', aliases: ['平阳'], center: [111.5, 36.08], zoom: 8 },
  { name: '凤翔', aliases: ['雍城'], center: [107.4, 34.5], zoom: 8 },
  { name: '长城', center: [113.0, 40.5], zoom: 6 },
  { name: '骊山', aliases: ['骊山陵', '秦始皇陵', '兵马俑'], center: [109.27, 34.38], zoom: 9 },
  { name: '函谷关', center: [110.9, 34.6], zoom: 9 },
  { name: '郑国渠', center: [108.6, 34.6], zoom: 9 },
  { name: '都江堰', center: [103.6, 31.0], zoom: 9 },
  { name: '会稽', center: [120.58, 30.0], zoom: 8 },
  { name: '琅琊', center: [119.9, 35.7], zoom: 8 },
  { name: '泰山', center: [117.1, 36.25], zoom: 8 },
  { name: '沙丘', aliases: ['邢台'], center: [115.0, 37.1], zoom: 8 },
  { name: '云梦', center: [113.6, 31.0], zoom: 8 },
  { name: '桂林', aliases: ['桂林郡'], center: [110.3, 25.27], zoom: 8 },
  { name: '象郡', aliases: ['崇左'], center: [107.36, 22.4], zoom: 8 },
  { name: '辽东', center: [123.0, 41.0], zoom: 7 },
  { name: '陇西', center: [104.6, 35.0], zoom: 7 },
  { name: '三晋', center: [112.5, 36.5], zoom: 6 },
  { name: '中原', center: [113.6, 34.7], zoom: 6 },
  { name: '黄河', center: [110.0, 36.0], zoom: 5 },
  { name: '长江', center: [112.0, 30.5], zoom: 5 },
  { name: '淮河', center: [116.5, 33.0], zoom: 6 },
];

export const GAZETTEER: Place[] = [...CHINA, ...HISTORIC];

interface Hit { place: Place; index: number; alias: string }

/** 地名后缀启发式（用于本地库未命中时，联网查询候选） */
const PLACE_SUFFIX = '市县区镇村山关城郡州京都岛海岭口门陵原江川阳阴塞台峰港湾洲';
const CANDIDATE_RE = new RegExp(`([\\u4e00-\\u9fa5]{1,5}[${PLACE_SUFFIX}])`, 'g');

/**
 * 抽取「像地名」的候选词（本地库未命中时用），供联网地理编码。
 * 纯启发式、保守取前若干条；查不到就交给用户手工确认。
 */
export function extractCandidateNames(text: string, exclude: string[] = [], limit = 4): string[] {
  if (!text) return [];
  const seen = new Set(exclude);
  const out: string[] = [];
  CANDIDATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CANDIDATE_RE.exec(text))) {
    const name = m[1];
    if (name.length < 2 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

/** 从文本中抽取命中的地名（按出现位置排序、去重；多词命中取最长别名避免子串误配） */
export function extractPlaces(text: string, limit = 6): Place[] {
  if (!text) return [];
  const hits: Hit[] = [];
  for (const place of GAZETTEER) {
    const names = [place.name, ...(place.aliases || [])].sort((a, b) => b.length - a.length);
    for (const alias of names) {
      const idx = text.indexOf(alias);
      if (idx >= 0) { hits.push({ place, index: idx, alias }); break; }
    }
  }
  // 同一地名只保留一次；按出现位置排序
  const seen = new Set<string>();
  return hits
    .sort((a, b) => a.index - b.index)
    .filter((h) => (seen.has(h.place.name) ? false : (seen.add(h.place.name), true)))
    .map((h) => h.place)
    .slice(0, limit);
}
