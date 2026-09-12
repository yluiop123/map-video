// ========== 项目类型 ==========

/** 合集：项目之上的一层分组容器 */
export interface Collection {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  /** 排序权重（越小越靠前；默认合集恒为 -1） */
  order?: number;
}

/** 默认合集：新建项目未指定归属时落在这里；不可删除 */
export const DEFAULT_COLLECTION_ID = 'default';
export const DEFAULT_COLLECTION_NAME = '默认合集';

export interface MapVideoProject {
  id: string;
  name: string;
  description?: string;
  /** 所属合集 id；缺省视为默认合集 */
  collectionId?: string;
  createdAt: Date;
  updatedAt: Date;
  globalConfig: GlobalConfig;
  chapters: Chapter[];
  baseMaps: BaseMapConfig[];
  /** 新建章节的**默认底图**；实际生效的是章节上的 `chapter.baseMapId` */
  activeBaseMapId: string;
  elevationMaps: ElevationMapConfig[];
  /** 新建章节的**默认高程**；实际生效的是章节上的 `chapter.elevationMapId` */
  activeElevationMapId: string | null;
}

export interface GlobalConfig {
  defaultDuration: number;       // 默认时长（帧）
  defaultFPS: number;
  defaultResolution: Resolution;
  defaultEasing: EasingType;
  /** 地图投影：平面（默认）/ 3D 球体 —— 仅作新建章节的默认值，实际生效的是 `chapter.projection` */
  projection?: 'mercator' | 'globe';
}

export interface Resolution {
  width: number;
  height: number;
  label: string;
}

// ========== 底图 / 高程图 ==========

export interface BaseMapConfig {
  id: string;
  name: string;
  /** MapLibre style URL 或内联样式对象 */
  style: string | import('maplibre-gl').StyleSpecification;
}

export interface ElevationMapConfig {
  id: string;
  name: string;
  url: string;                   // 高程栅格瓦片 URL (terrain-rgb / terrarium)
  encoding?: 'mapbox' | 'terrarium';
  exaggeration?: number;         // 地形夸张系数
  style?: string;                // 可选的关联底图样式
}

// ========== 章节类型 ==========

export interface Chapter {
  id: string;
  title: string;
  order: number;
  startFrame: number;
  endFrame: number;
  elements: MapElement[];
  camera?: CameraKeyframe[];
  overlays: OverlayItem[];
  effects: ChapterEffect[];
  /** 特效窗口：天气/画面特效层（屏幕空间，非地图元素），startFrame/endFrame 为绝对帧 */
  fx?: ScreenFxItem[];
  /** 章节标题样式（导出与预览共用渲染）；缺省用默认样式 */
  titleStyle?: TitleStyle;
  transition?: TransitionConfig; // 进入本节的转场
  /**
   * 底图 / 高程 / 投影 —— **按章节绑定**（不同章节可以不同底图、地形与 2D/3D 投影）。
   * 为空时继承项目级默认值（`project.activeBaseMapId` / `activeElevationMapId` /
   * `globalConfig.projection`），项目级那三个字段只作为「新建章节的初始值」，不直接生效。
   */
  baseMapId?: string;
  elevationMapId?: string | null;
  projection?: 'mercator' | 'globe';
  /** 字幕/配音轨道（章内绝对帧） */
  narration?: NarrationTrack;
  /** 背景音乐段（章内绝对帧，可多段循环） */
  music?: MusicTrack[];
}

// ========== 元素类型 ==========

export type ElementType =
  | 'point'
  | 'moving_point'
  | 'line'
  | 'polygon'
  | 'arrow'
  | 'double_arrow'
  | 'encirclement'
  | 'gathering'
  | 'military_symbol'
  | 'connector'
  | 'flag'
  | 'territory';

export interface MapElementBase {
  id: string;
  type: ElementType;
  name: string;
  visible: boolean;
  locked: boolean;
  startFrame: number;
  endFrame: number;
  style: ElementStyle;
  zIndex?: number;
  /** 来源分类：区分形状工具绘制（multi=多点/two=两点/special=特殊）与路线工具绘制（route）。
   * 属性面板据此选择对应设置面板；无标记时按语义回退。 */
  shapeCategory?: 'multi' | 'two' | 'special' | 'route';
  /** 动画效果：grow=普通增长(默认) / move=路线移动 / fill=填充 / march=填充行进(定长段+剩余半透明变短) / marchplain=行进(仅定长段沿路线移动) */
  animEffect?: 'grow' | 'move' | 'fill' | 'march' | 'marchplain';
  /** 飞行模式：开启后路线与移动图标均不贴地，按高度剖面悬空显示（起点爬升→巡航→终点落地）。
   * 与动画效果叠加时路线整条悬空显示，图标沿路线随播放进度移动。 */
  flyMode?: boolean;
  /** 显示移动图标（标记点沿路径移动） */
  showIcon?: boolean;
  /** 移动标记样式（与标记 Pin 相同的形态集合与样式项：dot/pin/emoji/bubble/text/flag + 图片/动图/模型/图标库） */
  moveIcon?: {
    shape?: 'dot' | 'pin' | 'emoji' | 'bubble' | 'text' | 'flag' | 'image' | 'gif' | 'model' | 'icon';
    color?: string;
    emoji?: string;
    scale?: number;
    labelText?: string;
    labelColor?: string;
    labelBg?: string;
    labelSize?: number;
    labelPadding?: number;
    labelRadius?: number;
    labelPos?: string;
    /** 旗帜文字 */
    flagText?: string;
    flagColor?: string;
    /** 自定义图标 symbolId（上传入口，保留兼容） */
    symbolId?: string;
    /** 资源来源（与标记的 element.builtinId/assetId/iconLib+iconName 语义一致） */
    builtinId?: string;
    assetId?: string;
    iconLib?: string;
    iconName?: string;
    /** 朝向：faceCam=面向镜头(默认)；flat=贴地 */
    orientation?: 'faceCam' | 'flat';
    /** flat 贴地时的旋转角 */
    rotation?: number;
    /** 是否显示标签（文字/气泡/点旁的标记标签） */
    showLabel?: boolean;
  };
  /** 移动图标动画起始帧（图标从路径起点出发） */
  moveStartFrame?: number;
  /** 移动图标动画结束帧（图标到达终点） */
  moveEndFrame?: number;
  /** 均匀移动：true=全程匀速；false=各路径点自定义到达时间 */
  uniformMove?: boolean;
  /** 非均匀移动时每个路径点（含首点）的到达帧 */
  pointTimes?: number[];
}

/** 点的视觉形态（9 种）：5 种矢量基础形态 + 4 种资源形态 */
export type PointShape =
  | 'circle'   // 圆点
  | 'text'     // 文字贴片
  | 'pin'      // 水滴针
  | 'bubble'   // 气泡
  | 'emoji'    // 表情
  | 'image'    // 图片（内置 SVG 图集 / 上传 png·jpg·webp·svg）
  | 'gif'      // 动图（内置程序化动画 / 上传 gif·webp）
  | 'model'    // 3D 模型（内置程序化简模 / 上传 glb·gltf；three.js + custom layer）
  | 'icon';    // 图标库（lucide / react-icons / 自建库）

/** 形态专属表现参数（对应数据库 element_marker.visual_meta_json） */
export interface VisualMeta {
  /** image：适配方式 */
  fit?: 'contain' | 'cover';
  /** image：是否允许着色 */
  tintable?: boolean;
  /** gif：帧率 */
  fps?: number;
  /** gif：是否循环 */
  loop?: boolean;
  /** model：离地高度（米） */
  altitude?: number;
  /** model：自转角速度（度/秒） */
  autoRotate?: number;
  /** model：初始朝向（度） */
  spin?: number;
  /** model：是否随地图俯仰倾斜 */
  pitchAlign?: boolean;
  /** model：播放的动画片段名 */
  animation?: string;
  /** icon：描边粗细 */
  strokeWidth?: number;
}

export interface PointElement extends MapElementBase {
  type: 'point';
  coordinates: [number, number];
  icon?: string;
  iconSize?: number;
  color?: string;
  label?: LabelConfig;
  /** 自定义图片（data URL 或 http URL）；等价于 shape='image' + 资源来源之一 */
  iconUrl?: string;
  /** 呈现形态（9 种） */
  shape?: PointShape;
  /** shape==='emoji' 时的表情字符 */
  emoji?: string;
  /** 等比缩放：30%–300%（默认 1）。影响圆点大小与文案标签字号，替代固定像素 */
  scale?: number;
  /** 朝向：faceCam=始终面向摄像机（默认）；flat=贴地（可配合 rotation 旋转）。model 形态强制 faceCam */
  orientation?: 'faceCam' | 'flat';
  /** 贴地时的旋转角（0-360，地图空间） */
  rotation?: number;

  // ── 资源来源（与数据库 element_marker 的 builtin_id / asset_id / icon_lib+icon_name 一一对应）──
  /** 内置资源 id：image:flag-red / gif:radar / model:drone / icon:lucide:MapPin */
  builtinId?: string;
  /** 上传的媒体素材 id（asset 表） */
  assetId?: string;
  /** 图标库命名空间：lucide / react-icons/tabler / 自建库名 */
  iconLib?: string;
  /** 图标名（shape='icon' 时必填） */
  iconName?: string;
  /** 形态专属表现参数 */
  visualMeta?: VisualMeta;
}

export interface MovingPointElement extends MapElementBase {
  type: 'moving_point';
  path: [number, number][];
  pathProgress: Keyframe<number>[];
  trail?: TrailConfig;
  color?: string;
}

export interface LineElement extends MapElementBase {
  type: 'line';
  coordinates: [number, number][];
  drawProgress: Keyframe<number>[];
  lineWidth: number;
  lineColor: string;
  lineDashArray?: [number, number];
  /** 直线 / 贝塞尔曲线（coordinates 为控制点）/ 大圆弧航线 */
  lineType?: 'straight' | 'bezier' | 'arc';
  lineArrow?: boolean;         // 线末端方向箭头（示意方向）
  /** 行军路线动画：光标/脉冲沿路径推进 */
  routeEffect?: {
    enabled: boolean;
    spotColor: string;
    spotWidth: number;
    frameStep: number;
    dotCount: number;          // 同时存在的光点数
  };
  /** 自动变化的线：循环流动的虚线段（行军蚁效果） */
  flowSpeed?: number;          // 0 = 关闭；>0 启用，每 N 帧相位前进一步
  /** 无样式路线：预览/导出不显示线条本身（仅显示移动图标） */
  plainPath?: boolean;
  /** 战线装饰（钢铁雄心防线风格）：主线一侧的短梳齿 */
  frontStyle?: {
    /** 齿长度（px，屏幕像素） */
    toothLength?: number;
    /** 齿间距（px，屏幕像素） */
    toothGap?: number;
    /** 齿偏角（度，相对主线法向；0=垂直） */
    toothAngle?: number;
    /** 齿朝向哪一侧：1=顺时针侧（右），-1=逆时针侧（左） */
    side?: 1 | -1;
  };
  /** 线中点文案 */
  label?: LabelConfig;
}

export interface PolygonElement extends MapElementBase {
  type: 'polygon';
  coordinates: [number, number][][];
  fillColor: string;
  fillOpacity: number;
  strokeColor: string;
  strokeWidth: number;
  morphKeyframes?: MorphKeyframe[];
  /** 战线/占领区推进动画：从一侧到另一侧 */
  fillProgress?: Keyframe<number>[];
  fillGradient?: { enabled: boolean; fromColor: string; toColor: string };
  /** 形状种类（Shape Settings 切换用）：普通多边形 / 矩形 / 圆 / 五角星 */
  shapeKind?: 'poly' | 'rect' | 'circle' | 'star';
  /** shapeKind==='circle' 时的可编辑参数 */
  circleMeta?: { center: [number, number]; radius: number };
  /** shapeKind==='rect' 时的对角点 */
  rectMeta?: { c1: [number, number]; c2: [number, number] };
  /** shapeKind==='star' 时的参数 */
  starMeta?: { center: [number, number]; radius: number };
  /** 曲线多边：多边形各边曲线化（闭合贝塞尔拟合） */
  polyCurve?: boolean;
  /** 防御圈锯齿（钢铁雄心防线风格，环绕一圈）：存在即有锯齿 */
  defenseStyle?: {
    /** 齿长度（px，屏幕像素） */
    toothLength?: number;
    /** 齿间距（px，屏幕像素） */
    toothGap?: number;
    /** 齿偏角（度，相对边法向；0=垂直） */
    toothAngle?: number;
    /** 齿朝向哪一侧:1=顺时针侧(右)，-1=逆时针侧(左) */
    side?: 1 | -1;
  };
  /** 旋转角（绕中心，度；与矩形/五角星配合；圆对称不受影响） */
  rotation?: number;
}

export interface ArrowElement extends MapElementBase {
  type: 'arrow';
  from: [number, number];
  to: [number, number];
  /** 弯曲燕尾箭头的控制点（≥2 时使用贝塞尔曲线渲染） */
  path?: [number, number][];
  arrowType: 'swallowtail' | 'simple' | 'block' | 'pincer' | 'curved' | 'curved-simple' | 'attack' | 'straight';
  width: number;
  color: string;
  /** 箭头填充透明度（0–1），仅燕尾/行军等面状箭头生效 */
  fillOpacity?: number;
  progress: Keyframe<number>[];
  /** 绘制完成时的缩放级别，用于换算固定地理宽度的箭头（地图固定，随缩放变大变小） */
  drawZoom?: number;
}

/** 双箭头（钳形攻势）：4 控制点，两箭头对进 */
export interface DoubleArrowElement extends MapElementBase {
  type: 'double_arrow';
  points: [number, number][];
  color: string;
  progress: Keyframe<number>[];
}

export interface EncirclementElement extends MapElementBase {
  type: 'encirclement';
  center: [number, number];
  radius: number;
  fillColor: string;
  strokeColor: string;
}

export interface GatheringElement extends MapElementBase {
  type: 'gathering';
  center: [number, number];
  radius: number;
  color: string;
  pulseAnimation?: boolean;
  /** 旋转角（度，绕中心） */
  rotation?: number;
}

export interface MilitarySymbolElement extends MapElementBase {
  type: 'military_symbol';
  sidc: string;
  coordinates: [number, number];
  rotation?: number;
  symbolSize?: number;
  echelon?: string;
  label?: string;
}

export interface ConnectorElement extends MapElementBase {
  type: 'connector';
  fromElementId: string;
  toElementId: string;
  lineWidth: number;
  lineColor: string;
  lineDashArray?: [number, number];
  animated?: boolean;            // 流动动画
  arrowhead?: boolean;
}

export interface FlagElement extends MapElementBase {
  type: 'flag';
  coordinates: [number, number];
  text: string;
  flagColor: string;
  textColor: string;
  fontSize: number;
  flagWidth: number;   // 旗面宽度(px)
  scale?: number;      // 整体缩放倍数（默认 1）
}

// ========== 疆域（势力/地块/兼并） ==========

/** 势力：名字 + 颜色（地块归属势力的配色） */
export interface TerritoryCountry {
  id: string;
  name: string;
  color: string;
}

/** 地块：一块领土（多边形环），初始归属某势力；势力边界=同势力地块并集外边界 */
export interface TerritoryPlot {
  id: string;
  name?: string;
  /** GeoJSON Polygon rings：rings[0]=外环，其余=洞 */
  rings: [number, number][][];
  ownerId: string;             // 初始归属势力 id
}

/** 兼并事件：在 frame 帧，把若干地块划给目标势力；带描线/渐变/高亮特效 */
export interface TerritoryEvent {
  id: string;
  frame: number;               // 兼并时刻（绝对帧）
  plotIds: string[];           // 被占领的地块
  toCountryId: string;         // 占领方
  effect?: {
    /** instant=瞬时换色 / fade=颜色渐变 / draw=边界描线+渐变 / spread=从占领方边界向外扩散 / shrink=扩散推进+湍流置换前沿（蚕食） */
    preset: 'instant' | 'fade' | 'draw' | 'spread' | 'shrink';
    /** 特效时长（帧）：渐变/描线占用 */
    duration?: number;
    /** 完成后高亮脉冲 */
    highlight?: boolean;
  };
}

export interface TerritoryDisplay {
  countryBorders: boolean;     // 势力边界（并集外边界，势力色）
  plotBorders: boolean;        // 地块边界（内部细线）
  borderWidth: number;         // 势力边界线宽(px)
  fillOpacity: number;
  countryNames: boolean;       // 势力标签
  plotNames: boolean;          // 地块名标签
  /** 贴地（map，随地图旋转/俯仰）/ 面向镜头（viewport，广告牌） */
  labelAlign: 'map' | 'viewport';
  labelScale: number;          // 标签整体缩放（默认 1）
}

export interface TerritoryElement extends MapElementBase {
  type: 'territory';
  countries: TerritoryCountry[];
  plots: TerritoryPlot[];
  events: TerritoryEvent[];    // 按 frame 升序应用
  display: TerritoryDisplay;
}

export type MapElement =
  | PointElement
  | MovingPointElement
  | LineElement
  | PolygonElement
  | ArrowElement
  | DoubleArrowElement
  | EncirclementElement
  | GatheringElement
  | MilitarySymbolElement
  | ConnectorElement
  | FlagElement
  | TerritoryElement;

// ========== 样式类型 ==========

export interface ElementStyle {
  opacity?: Keyframe<number>[];
  scale?: Keyframe<number>[];
  rotation?: Keyframe<number>[];
}

// ========== 高亮效果 ==========



// ========== 标签 / 轨迹 ==========

export interface LabelConfig {
  text: string;
  fontSize?: number;
  color?: string;
  position?: 'top' | 'bottom' | 'left' | 'right' | 'center';
  /** 文案背景 */
  bgColor?: string;
  bgPadding?: number;
  bgRadius?: number;
  fontWeight?: 'normal' | 'bold';
}

export interface TrailConfig {
  color?: string;
  width?: number;
  length?: number;       // 长度（帧）
}

// ========== 关键帧类型 ==========

export interface Keyframe<T> {
  frame: number;
  value: T;
  easing?: EasingType;
}

export type EasingType =
  | 'linear'
  | 'easeIn' | 'easeOut' | 'easeInOut'
  | 'cubicIn' | 'cubicOut' | 'cubicInOut'
  | 'spring' | 'bounce';

export interface MorphKeyframe {
  frame: number;
  coordinates: [number, number][][];
  easing?: EasingType;
}

// ========== 相机类型 ==========

export interface CameraKeyframe {
  frame: number;
  center: [number, number];
  zoom: number;
  pitch?: number;
  bearing?: number;
  easing?: EasingType;
  /** 进入本视角的镜头移动持续帧数；未设置=从上一视角立即开始移动（旧行为） */
  moveDuration?: number;
  /** 视角类型：fixed=固定(默认) / follow=跟随 / orbit=环绕 */
  cameraType?: 'fixed' | 'follow' | 'orbit';
  /** 跟随视角：center 动态跟随路线元素上的动画进度点（坐标动态） */
  followRoute?: {
    routeElementId: string;
    /** 跟随路线方向：开启后按路线切线自动计算视角朝向（默认开） */
    followDirection?: boolean;
    /** 跟随动画开始帧（默认=路线显示开始时间） */
    startFrame?: number;
    /** 跟随动画结束帧（默认=路线显示结束时间） */
    endFrame?: number;
  };
  /** 环绕视角：相机绕中心点旋转（bearing 随时间变化） */
  orbit?: {
    /** 旋转速度（度/秒） */
    speed?: number;
    /** 环绕时长（秒） */
    duration?: number;
  };
}

// ========== 转场类型 ==========

export interface TransitionConfig {
  type: TransitionType;
  duration: number;      // 帧数
}

export type TransitionType =
  | 'cut' | 'fade' | 'fadeBlack' | 'fadeWhite'
  | 'dissolve' | 'wipeLeft' | 'wipeRight'
  | 'zoom' | 'mapFly';

// ========== 叠加层类型（弹出元素） ==========

export interface OverlayItem {
  id: string;
  type: OverlayType;
  name: string;
  position: OverlayPosition;   // 在地图上的相对位置
  content: OverlayContent;
  startFrame: number;
  endFrame: number;
  animation?: AnimationPreset; // 入场动画
  exitAnimation?: AnimationPreset; // 退场动画（结束前 20 帧播放）
  scale?: number;
  /** 九宫格标准位（POS_BASE）基础上的微调 %（-80..80 实际由渲染端钳制到 -40..40） */
  offsetX?: number;
  offsetY?: number;
  /** 卡片背景样式 */
  bg?: { color: string; opacity: number; blur: number; radius: number; border?: string };
  zIndex?: number;
}

/** 自定义弹窗内容块：文字 / 图片 / 视频，任意数量纵向堆叠 */
export interface OverlayBlock {
  id: string;
  type: 'text' | 'image' | 'video';
  text?: { content: string; fontSize: number; color: string; bold?: boolean; align?: 'left' | 'center' | 'right' };
  /** image / video 源 */
  url?: string;
}

// ========== 人物卡（块化：图片/姓名/介绍/名言/对话，各块开关+语音，布局可配） ==========

export type PersonBlockKind = 'image' | 'name' | 'intro' | 'quote' | 'dialogue';

export interface PersonBlock {
  id: string;
  kind: PersonBlockKind;
  /** 显示开关 */
  show: boolean;
  /** name=姓名 / intro=介绍 / quote=名言 / dialogue=说的话（单角色自述） */
  text?: string;
  /** image 块图片 */
  imageUrl?: string;
  /** image 块尺寸 px（60–360） */
  size?: number;
  /** image 块遮罩：bottom/top=渐变压暗、circle=圆形裁剪、feather=边缘羽化 */
  mask?: 'none' | 'bottom' | 'top' | 'circle' | 'feather';
}

export interface PersonLayoutCfg {
  /** 图片相对文字的方位（none=不显示图片区，仅图片块单独渲染） */
  imageSide: 'left' | 'right' | 'top' | 'bottom' | 'none';
  align: 'left' | 'center';
  /** 块间距 px */
  gap: number;
  /** 卡片最大宽 px（240–560） */
  width: number;
  /** 名言样式：bubble 引用气泡 / line 竖线引用 / big 大字居中 */
  quoteStyle: 'bubble' | 'line' | 'big';
  /** 海报式：姓名/介绍叠加在图片底部（配合 bottom 遮罩） */
  textOverImage: boolean;
}

export interface PersonContent {
  blocks: PersonBlock[];
  layout: PersonLayoutCfg;
  /** 整卡语音（唯一；编辑端点击播放，导出端纯视觉） */
  audioUrl?: string;
}

/** 人物卡布局预设：应用=改 layout + 块显隐/顺序（不动已填内容） */
export const PERSON_PRESETS: {
  id: string; zh: string; en: string;
  layout: PersonLayoutCfg;
  order: PersonBlockKind[];
  show: Partial<Record<PersonBlockKind, boolean>>;
}[] = [
  {
    id: 'profile', zh: '人物简介', en: 'Profile',
    layout: { imageSide: 'left', align: 'left', gap: 14, width: 380, quoteStyle: 'bubble', textOverImage: false },
    order: ['image', 'name', 'intro'], show: { intro: true, quote: false, dialogue: false },
  },
  {
    id: 'quoteCard', zh: '名言卡', en: 'Quote',
    layout: { imageSide: 'top', align: 'center', gap: 12, width: 360, quoteStyle: 'big', textOverImage: false },
    order: ['image', 'quote', 'name'], show: { intro: false, quote: true, dialogue: false },
  },
  {
    id: 'dialogueCard', zh: '对话卡', en: 'Dialogue',
    layout: { imageSide: 'left', align: 'left', gap: 12, width: 380, quoteStyle: 'bubble', textOverImage: false },
    order: ['image', 'name', 'dialogue'], show: { intro: false, quote: false, dialogue: true },
  },
  {
    id: 'poster', zh: '海报', en: 'Poster',
    layout: { imageSide: 'top', align: 'left', gap: 10, width: 440, quoteStyle: 'line', textOverImage: true },
    order: ['image', 'name', 'intro'], show: { intro: true, quote: false, dialogue: false },
  },
  {
    id: 'imageOnly', zh: '仅图片', en: 'Image only',
    layout: { imageSide: 'left', align: 'center', gap: 0, width: 420, quoteStyle: 'bubble', textOverImage: false },
    order: ['image'], show: { name: false, intro: false, quote: false, dialogue: false },
  },
  {
    id: 'all', zh: '全展示', en: 'All',
    layout: { imageSide: 'left', align: 'left', gap: 14, width: 420, quoteStyle: 'bubble', textOverImage: false },
    order: ['image', 'name', 'intro', 'quote', 'dialogue'],
    show: {},
  },
];

export function defaultPersonContent(): PersonContent {
  const b = (kind: PersonBlockKind, extra: Partial<PersonBlock> = {}): PersonBlock =>
    ({ id: generateId(), kind, show: kind !== 'quote' && kind !== 'dialogue', ...extra });
  return {
    layout: { imageSide: 'left', align: 'left', gap: 14, width: 380, quoteStyle: 'bubble', textOverImage: false },
    blocks: [
      b('image', { size: 72, mask: 'none' }),
      b('name'),
      b('intro'),
      b('quote', { show: false }),
      b('dialogue', { show: false }),
    ],
  };
}

/** person 旧结构（imageUrl/name/title/description/speech/audioUrl）→ 块化；缺字段补默认 */
export function normalizePersonContent(p: unknown): PersonContent {
  const def = defaultPersonContent();
  if (!p || typeof p !== 'object') return def;
  const obj = p as Partial<PersonContent> & { imageUrl?: string; name?: string; title?: string; description?: string; speech?: string };
  if (Array.isArray(obj.blocks) && obj.blocks.length > 0) {
    const layout: PersonLayoutCfg = { ...def.layout, ...(obj.layout || {}) };
    const blocks = def.blocks.map((db) => {
      const old = (obj.blocks as PersonBlock[]).find((x) => x && x.kind === db.kind);
      return old ? { ...db, ...old, id: old.id || db.id } : db;
    });
    return { blocks, layout, audioUrl: obj.audioUrl };
  }
  // v1 → v2
  const text: Partial<Record<PersonBlockKind, Partial<PersonBlock>>> = {};
  if (obj.imageUrl) text.image = { imageUrl: obj.imageUrl };
  if (obj.name) text.name = { text: obj.name };
  if (obj.description) text.intro = { text: obj.description };
  if (obj.speech) text.dialogue = { text: obj.speech };
  return {
    layout: def.layout,
    blocks: def.blocks.map((db) => ({ ...db, ...(text[db.kind] || {}) })),
    audioUrl: obj.audioUrl,
  };
}

export type OverlayType =
  | 'custom'                                        // 自定义（文字/图片/视频块组合 + 背景语音）
  | 'chart'
  | 'person'                                        // 人物卡（头像+姓名+职务+介绍+说话+音效）
  | 'report' | 'timeline' | 'quote' | 'compare'     // 战报 / 时间线 / 引用 / 对比
  | 'counter' | 'dialogue' | 'stats' | 'place';     // 计数 / 对话 / 态势 / 地点

export type ChartType = 'bar' | 'line' | 'pie' | 'area' | 'hbar' | 'donut' | 'radar' | 'gauge' | 'vs';

export type OverlayPosition =
  | 'top' | 'bottom' | 'left' | 'right' | 'center'
  | 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

/** 九宫格 → 中心相对偏移（%，横向正值向右、纵向正值向下；±40 = 距边 10%） */
export const POS_BASE: Record<OverlayPosition, [number, number]> = {
  topLeft: [-40, -40], top: [0, -40], topRight: [40, -40],
  left: [-40, 0], center: [0, 0], right: [40, 0],
  bottomLeft: [-40, 40], bottom: [0, 40], bottomRight: [40, 40],
};

export interface OverlayContent {
  type: OverlayType;
  /** custom：内容块组合（文字/图片/视频任意数量）+ 背景语音（卡片可见时播放，导出音频混流待支持） */
  custom?: { blocks: OverlayBlock[]; audio?: { url: string; title?: string } };
  /** person：块化人物卡（图片/姓名/介绍/名言/对话，各块开关+语音，布局可配；见 PersonContent） */
  person?: PersonContent;
  chart?: { type: ChartType; title?: string; data: { label: string; value: number }[]; data2?: { label: string; value: number }[]; color?: string; color2?: string };
  /** report 战报卡：大数字战果 */
  report?: { title?: string; value: number | string; unit?: string; note?: string };
  /** timeline 时间线卡：逐条错峰进场 */
  timeline?: { title?: string; items: { time?: string; text: string }[] };
  /** quote 引用卡：史料/电文/回忆录引文 + 出处 */
  quote?: { text: string; source?: string };
  /** compare 对比卡：左右两列 VS */
  compare?: { title?: string; left: { label: string; value: number }; right: { label: string; value: number }; unit?: string };
  /** counter 计数卡：大数字随播放滚动增长（durationFrames=计数时长） */
  counter?: { value: number; label?: string; prefix?: string; unit?: string; durationFrames?: number };
  /** dialogue 对话卡：头像+聊天气泡（往来命令/电文） */
  dialogue?: { title?: string; items: { who: string; avatarUrl?: string; text: string }[] };
  /** [已删除] stats 态势卡：仅兼容旧数据，加载时迁移为 custom 文字块 */
  stats?: { title?: string; items: { label: string; value: number; unit?: string; max?: number }[] };
  /** place 地点卡：地名+简介+配图 */
  place?: { name: string; description?: string; imageUrl?: string };
  /** 兼容旧数据（text/list/image/video/audio/group），加载时自动迁移为 custom */
  text?: { content: string; fontSize: number; color: string; bold?: boolean; align?: 'left' | 'center' | 'right' };
  list?: { title?: string; items: string[] };
  src?: string;
  image?: { url: string; alt?: string };
  audio?: { url: string; title?: string };
  children?: OverlayItem[];
}

const NEW_OVERLAY_TYPES = new Set<OverlayType>([
  'custom', 'chart', 'person', 'report', 'timeline', 'quote', 'compare', 'counter', 'dialogue', 'place',
]);

/** 旧弹窗内容迁移为自定义块（load/import 入口调用；audio→纯背景语音卡，group 子内容递归拍平；person 迁移为块化） */
export function normalizeOverlayContent(content: OverlayContent): OverlayContent {
  if (content.type === 'person' && content.person) {
    return { ...content, person: normalizePersonContent(content.person) };
  }
  if (content.type === 'stats') {
    // 态势卡已删除：迁移为自定义文字块（标题 + 指标行）
    const st = content.stats;
    const blocks: OverlayBlock[] = [];
    if (st?.title) blocks.push({ id: generateId(), type: 'text', text: { content: st.title, fontSize: 16, color: '#FFFFFF', bold: true, align: 'left' } });
    for (const it of st?.items || []) {
      blocks.push({ id: generateId(), type: 'text', text: { content: [it.label, String(it.value), it.unit].filter(Boolean).join('：'), fontSize: 14, color: '#e7e5e4', align: 'left' } });
    }
    return { type: 'custom', custom: { blocks } };
  }
  if (NEW_OVERLAY_TYPES.has(content.type)) return content;
  const t = content.type as string;
  if (t === 'audio' && content.audio) {
    return { type: 'custom', custom: { blocks: [], audio: content.audio } };
  }
  const blocks: OverlayBlock[] = [];
  const push = (b: Omit<OverlayBlock, 'id'>) => blocks.push({ id: generateId(), ...b });
  if (t === 'text' && content.text) push({ type: 'text', text: content.text });
  if (t === 'list') {
    if (content.list?.title) push({ type: 'text', text: { content: content.list.title, fontSize: 18, color: '#FFFFFF', bold: true, align: 'left' } });
    for (const it of content.list?.items || []) {
      push({ type: 'text', text: { content: it, fontSize: 14, color: '#e7e5e4', align: 'left' } });
    }
  }
  if (t === 'image') {
    const url = content.image?.url || content.src;
    if (url) push({ type: 'image', url });
  }
  if (t === 'video' && content.src) push({ type: 'video', url: content.src });
  if (t === 'group') {
    for (const child of content.children || []) {
      const cc = normalizeOverlayContent(child.content);
      if (cc.type === 'custom') blocks.push(...(cc.custom?.blocks || []));
    }
  }
  return { type: 'custom', custom: { blocks } };
}

export type AnimationPreset =
  | 'fadeIn' | 'fadeOut' | 'popIn' | 'popOut'
  | 'slideInLeft' | 'slideInRight'
  | 'slideInTop' | 'slideInBottom'
  | 'scaleIn' | 'scaleOut';

// ========== 章节特效 ==========

export type ChapterEffect =
  | {
      type: 'cursor_track';      // 鼠标指针轨迹（引导观众视线）
      path: [number, number][];  // 地理路径（可选）
      color: string;
      frameStep: number;
    }
  | {
      type: 'focus_glow';        // 区域渐显高亮
      center: [number, number];
      radius: number;
      color: string;
    }
  | {
      type: 'scan_line';         // 扫描线
      direction: 'horizontal' | 'vertical';
      color: string;
    };

// ========== 特效窗口：天气 / 画面特效（屏幕空间层） ==========

export type WeatherType = 'rain' | 'snow' | 'lightning' | 'fog';

export type ScreenFxType =
  | 'shake'       // 画面震动（整体位移包络）
  | 'flash'       // 闪光（全屏色闪）
  | 'vignette'    // 暗角
  | 'cloudReveal' // 云层散开（程序化云层消散显露画面）
  | 'fadeBlack'   // 黑场淡入（由黑渐显）
  | 'fadeWhite';  // 白场淡入（由白渐显）

export interface ScreenFxItem {
  id: string;
  kind: 'weather' | 'screen';
  name: string;
  startFrame: number;
  endFrame: number;
  /** kind==='weather'：天气参数（intensity 0–1，wind -1..1 向右为正） */
  weather?: { type: WeatherType; intensity: number; wind: number };
  /** kind==='screen'：画面特效参数（intensity 0–1；flash/fade 用 color） */
  effect?: { type: ScreenFxType; intensity: number; color?: string };
  enabled?: boolean;
}

/** 章节标题样式（双端同源渲染） */
export interface TitleStyle {
  show: boolean;
  preset?: string;                         // 内置样式 id；手动改属性后变 'custom'
  fontFamily: string;
  fontSize: number;
  color: string;
  weight: number;                          // 300–900
  pos: OverlayPosition;                    // 9 宫格位置（同弹窗）
  offsetX: number;                         // 横向微调 %（-40..40，正值向右）
  offsetY: number;                         // 纵向微调 %（-40..40，正值向下）
  bg: 'none' | 'bar' | 'card';             // 无背景 / 半透明条带 / 卡片
  bgColor: string;
  shadow: boolean;
}

/** 内置标题样式预设：选中即套用一组参数，之后各项仍可自由调整 */
export const TITLE_PRESETS: { id: string; zh: string; en: string; values: Omit<TitleStyle, 'show' | 'preset'> }[] = [
  {
    id: 'classic', zh: '默认卡片', en: 'Classic',
    values: {
      fontFamily: "'Geist', 'Noto Sans SC', system-ui, sans-serif", fontSize: 36, color: '#FFFFFF',
      weight: 700, pos: 'bottomLeft', offsetX: 0, offsetY: 0, bg: 'card', bgColor: '#0c0a09', shadow: true,
    },
  },
  {
    id: 'documentary', zh: '纪录片', en: 'Documentary',
    values: {
      fontFamily: "Georgia, 'Noto Serif SC', 'SimSun', serif", fontSize: 46, color: '#FFFFFF',
      weight: 700, pos: 'bottomLeft', offsetX: 0, offsetY: 0, bg: 'none', bgColor: '#0c0a09', shadow: true,
    },
  },
  {
    id: 'inkpaper', zh: '宣纸墨韵', en: 'Ink Paper',
    values: {
      fontFamily: "'KaiTi', 'STKaiti', serif", fontSize: 42, color: '#3a2e1c',
      weight: 700, pos: 'bottomLeft', offsetX: 0, offsetY: 0, bg: 'card', bgColor: '#f3ecd8', shadow: false,
    },
  },
  {
    id: 'golden', zh: '金色史诗', en: 'Golden Epic',
    values: {
      fontFamily: "Georgia, 'Noto Serif SC', 'SimSun', serif", fontSize: 56, color: '#e8c56a',
      weight: 900, pos: 'top', offsetX: 0, offsetY: 0, bg: 'none', bgColor: '#0c0a09', shadow: true,
    },
  },
  {
    id: 'military', zh: '军报横幅', en: 'Military',
    values: {
      fontFamily: "'SimHei', 'Microsoft YaHei', 'Noto Sans SC', sans-serif", fontSize: 38, color: '#FFFFFF',
      weight: 900, pos: 'bottomLeft', offsetX: 0, offsetY: 0, bg: 'bar', bgColor: '#233318', shadow: false,
    },
  },
  {
    id: 'cinema', zh: '电影黑条', en: 'Cinema',
    values: {
      fontFamily: "'Geist', 'Noto Sans SC', system-ui, sans-serif", fontSize: 30, color: '#FFFFFF',
      weight: 400, pos: 'bottom', offsetX: 0, offsetY: 40, bg: 'bar', bgColor: '#000000', shadow: false,
    },
  },
];

export function defaultTitleStyle(): TitleStyle {
  return {
    show: true,
    preset: 'classic',
    fontFamily: "'Geist', 'Noto Sans SC', system-ui, sans-serif",
    fontSize: 36,
    color: '#FFFFFF',
    weight: 700,
    pos: 'bottomLeft',
    offsetX: 0,
    offsetY: 0,
    bg: 'card',
    bgColor: '#0c0a09',
    shadow: true,
  };
}

/** 兼容旧标题样式（align+vPos → 9 宫格 pos；offsetX/Y=相对 POS_BASE 标准位的微调量），load/import 时调用 */
export function normalizeTitleStyle(ts?: Partial<TitleStyle> & { align?: string; vPos?: string } | null): TitleStyle {
  const m: Record<string, unknown> = { ...defaultTitleStyle(), ...(ts || {}) };
  if (!m.pos) {
    const a = m.align === 'right' ? 'right' : m.align === 'center' ? 'center' : 'left';
    const v = m.vPos === 'top' ? 'top' : m.vPos === 'center' ? 'center' : 'bottom';
    m.pos = v === 'center'
      ? (a === 'center' ? 'center' : a === 'right' ? 'right' : 'left')
      : v === 'top'
        ? (a === 'center' ? 'top' : a === 'right' ? 'topRight' : 'topLeft')
        : (a === 'center' ? 'bottom' : a === 'right' ? 'bottomRight' : 'bottomLeft');
  }
  if (typeof m.offsetX !== 'number') m.offsetX = 0;
  if (typeof m.offsetY !== 'number') m.offsetY = 0;
  delete m.align;
  delete m.vPos;
  return m as unknown as TitleStyle;
}

// ========== 工具函数 ==========

export function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

// ========== 字幕 / 配音 / 背景音乐（章级轨道） ==========

/** 字幕/配音条：显示时长 = 配音音频时长（frames），无音频按字数估算 */
export interface NarrationEntry {
  id: string;
  /** 字幕文本 = 配音朗读文本 */
  text: string;
  /** 配音音频（TTS 生成或导入，dataURL/远程 URL） */
  audioUrl?: string;
  /** 字幕显示时长（帧） */
  durationFrames: number;
  /** 章内起始帧（自动顺排，手动调整后 locked） */
  startFrame: number;
  /** 手动定位后不再自动顺排 */
  locked?: boolean;
  status?: 'none' | 'pending' | 'ready' | 'error';
  error?: string;
}

export interface NarrationStyle {
  fontSize: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  /** none=无底 / bar=底部长条 */
  bg: 'none' | 'bar';
  bgColor: string;
  /** 距画面底部百分比（0–40） */
  posY: number;
  /** 最大宽度百分比（超出换行） */
  maxPct: number;
}

export interface NarrationTrack {
  entries: NarrationEntry[];
  style: NarrationStyle;
}

/** 背景音乐段：章内生效区间，可循环 */
export interface MusicTrack {
  id: string;
  name: string;
  url: string;
  startFrame: number;
  endFrame: number;
  /** 0–1 */
  volume: number;
  loop: boolean;
  /** 淡入/淡出（秒） */
  fadeIn: number;
  fadeOut: number;
}

/** AI / 配音服务配置（localStorage 持久化，不入项目文件防泄密） */
export interface ProviderConfig {
  id: string;
  kind: 'llm' | 'tts';
  label: string;
  baseUrl: string;
  apiKey: string;
  /** LLM 模型名 / TTS 音色模型 */
  model: string;
  /** TTS 接口协议 */
  protocol?: TtsProtocol;
  /** TTS 音色/说话人 ID */
  voice?: string;
  /** 语速 0.5–2 */
  speed?: number;
  /** 附加 JSON 参数（合并进请求体） */
  extra?: string;
  /** true=走 MapVideo 后端代理（Full 模式，Key 在服务端）；false/缺省=浏览器直连 */
  viaBackend?: boolean;
}

export type TtsProtocol = 'openai-speech' | 'minimax-t2a' | 'volc-tts' | 'qwen-tts' | 'custom';

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  voice?: string;
  protocol?: TtsProtocol;
  /** 申请 Key 的地址提示 */
  keyHint?: string;
  /** 备注（CORS/协议说明） */
  note?: string;
}

/** 无音频时按字数估算字幕时长：0.28s/字 + 0.3s 尾巴 */
export function estimateTextDurationFrames(text: string, fps: number): number {
  const sec = Math.max(0.8, text.length * 0.28 + 0.3);
  return Math.max(1, Math.round(sec * fps));
}

export function defaultNarrationStyle(): NarrationStyle {
  return {
    fontSize: 30,
    color: '#FFFFFF',
    strokeColor: '#000000',
    strokeWidth: 4,
    bg: 'none',
    bgColor: '#000000',
    posY: 8,
    maxPct: 80,
  };
}

export function normalizeNarrationTrack(t?: NarrationTrack | null): NarrationTrack {
  const style = { ...defaultNarrationStyle(), ...(t?.style || {}) };
  const entries = (t?.entries || []).map((e) => ({
    ...e,
    durationFrames: Math.max(1, e.durationFrames || estimateTextDurationFrames(e.text || '', 30)),
  }));
  return { style, entries };
}

// ========== 导出/导入格式 ==========

/** 导出内嵌素材（base64 dataUrl）：让导出文件自包含，跨设备导入不裂图 */
export interface ExportedAsset {
  assetId: string;
  mime: string;
  byteSize: number;
  dataUrl: string;
}

export interface ProjectExport {
  version: number;
  exportedAt: Date;
  project: MapVideoProject;
  /** 项目引用的全部素材字节（导入时按 sha256 内容寻址幂等还原） */
  assets?: ExportedAsset[];
}
