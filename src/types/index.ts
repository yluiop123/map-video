import type { Mode, ProviderKind } from '../lib/request-engine';

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

/**
 * 项目 = 一条 0→endFrame 的**连续时间线**（无时间线）。
 * 元素 / 相机 / 弹窗 / 特效 / 字幕 / 音乐全部用**项目绝对帧**。
 */
export interface MapVideoProject {
  id: string;
  name: string;
  description?: string;
  /** 所属合集 id；缺省视为默认合集 */
  collectionId?: string;
  createdAt: Date;
  updatedAt: Date;
  globalConfig: GlobalConfig;
  /** 时间线原点（恒为 0，统一坐标） */
  startFrame: number;
  /** 全片总长（帧）；内容超出时由 projectContentDuration 扩展 */
  endFrame: number;
  /** 全片图层（元素归属图层；图层可含多种元素类型） */
  layers: Layer[];
  /** 派生镜像：所有图层元素的扁平数组（由 store 从 layers 自动重算，勿直接写） */
  elements: MapElement[];
  /** 一条相机关键帧轴（绝对帧） */
  camera: CameraKeyframe[];
  /** 弹窗卡片（绝对帧） */
  overlays: OverlayItem[];
  /** 天气/画面特效窗口（绝对帧） */
  fx: ScreenFxItem[];
  /** 字幕/配音轨（绝对帧） */
  narration: NarrationTrack;
  /** 项目级背景音乐：单轨多段（绝对帧，段内循环） */
  music: MusicTrack[];
  baseMaps: BaseMapConfig[];
  /** 生效底图（项目固定） */
  activeBaseMapId: string;
  elevationMaps: ElevationMapConfig[];
  /** 生效高程（项目固定） */
  activeElevationMapId: string | null;
}

export interface GlobalConfig {
  defaultDuration: number;       // 默认时长（帧，仅新建项目初始值）
  defaultFPS: number;
  defaultResolution: Resolution;
  defaultEasing: EasingType;
  /** 全片地图投影（项目固定）：平面（默认）/ 3D 球体 */
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
  | 'flag'
  | 'territory'
  | 'geo_image';

export interface MapElementBase {
  id: string;
  type: ElementType;
  name: string;
  visible: boolean;
  locked: boolean;
  startFrame: number;
  endFrame: number;
  /**
   * 是否自定义显示时间（相对所在图层）。关闭（默认）时元素在**图层显示期间全程可见**；
   * 开启时用 startFrame/endFrame（与图层区间取交集）。派生镜像里 startFrame/endFrame 已是解析后的绝对帧。
   */
  customTime?: boolean;
  /** 所属图层 id（派生镜像里由 deriveElements 回填；源数据中元素嵌套在 layer.elements，无需存） */
  layerId?: string;
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
    shape?: 'dot' | 'pin' | 'emoji' | 'bubble' | 'text' | 'flag' | 'image' | 'gif' | 'model' | 'icon' | 'military_symbol';
    color?: string;
    emoji?: string;
    scale?: number;
    labelText?: string;
    labelColor?: string;
    labelBg?: string;
    labelSize?: number;
    labelPadding?: number;
    labelRadius?: number;
    /** @deprecated 旧位置枚举；新数据用 labelOffsetX / labelOffsetY（未设置偏移时兼容此字段） */
    labelPos?: string;
    /** 标签水平偏移（像素，0 = 居中；负左正右）——与标记文案位置语义一致 */
    labelOffsetX?: number;
    /** 标签垂直偏移（像素，0 = 居中；**正值向上**，默认 40） */
    labelOffsetY?: number;
    /** 旗帜文字 */
    flagText?: string;
    flagColor?: string;
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

/** 点的视觉形态（10 种）：5 种矢量基础形态 + 5 种资源形态。
 *  军标（military_symbol）与图片/图标同属资源形态：符号图由 milsymbol 按 APP-6
 *  规范生成（builtinId = 'milsym:<SIDC>'），属性（大小/朝向/颜色/标签）与图片完全一致。 */
export type PointShape =
  | 'circle'   // 圆点
  | 'text'     // 文字贴片
  | 'pin'      // 水滴针
  | 'bubble'   // 气泡
  | 'emoji'    // 表情
  | 'image'    // 图片（内置 SVG 图集 / 上传 png·jpg·webp·svg）
  | 'gif'      // 动图（内置程序化动画 / 上传 gif·webp）
  | 'model'    // 3D 模型（内置程序化简模 / 上传 glb·gltf；three.js + custom layer）
  | 'icon'     // 图标库（lucide / react-icons / 自建库）
  | 'military_symbol';  // 军标（milsymbol 标准符号，四阵营框架由 SIDC 身份码决定）

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

/**
 * 地理配准图片（贴图）：把导入的图片按控制点网格贴到地图上。
 * · cols=1,rows=1（即 2×2 网格点）= 四角投影配准（处理透视/斜切/旋转/缩放）
 * · cols/rows 更大 = 网格变形配准（切片逐格贴图，纠正任意不规则扭曲）
 * 图片存全局素材库（assetId，跨项目可用），本元素只保存配准参数。
 */
export interface GeoImageElement extends MapElementBase {
  type: 'geo_image';
  /** 全局素材库图片 id */
  assetId: string;
  /** 图片像素宽高比（宽/高），切片渲染用 */
  aspect: number;
  /** 网格列数/行数（1 = 四角；≥2 = 网格变形） */
  cols: number;
  rows: number;
  /** 控制点（行优先，(rows+1)×(cols+1) 个 [lng,lat]） */
  grid: [number, number][];
  /** 不透明度 0–1（默认 1） */
  opacity?: number;
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
  | FlagElement
  | TerritoryElement
  | GeoImageElement;

/** 图层类型（单类型图层）：标记 / 路线 / 形状 / 疆域 / 图片 */
export type LayerType = 'marker' | 'route' | 'shape' | 'territory' | 'image';

/** 图层：元素的分组，带自己的显隐与显示区间（**单类型**，只能放对应类别的元素） */
export interface Layer {
  id: string;
  type: LayerType;
  name: string;
  visible: boolean;
  /** 图层显示起点（项目绝对帧） */
  startFrame: number;
  /** 图层显示终点（项目绝对帧） */
  endFrame: number;
  /** 图层内的元素（相对图层的显示时间由元素的 customTime/start/end 决定） */
  elements: MapElement[];
}

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
  /** @deprecated 旧的位置枚举；新数据用 offsetX / offsetY 连续偏移（未设置偏移时仍兼容此字段） */
  position?: 'top' | 'bottom' | 'left' | 'right' | 'center';
  /** 水平偏移（像素，0 = 水平居中；负左正右），随标记缩放 */
  offsetX?: number;
  /** 垂直偏移（像素，0 = 垂直居中；**正值向上**），随标记缩放；默认 40（位于上方） */
  offsetY?: number;
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

// ========== 人物卡（精简：常用预设 + 少量参数） ==========

/** 常用样式：人物简介 / 名言台词 / 海报大图 / 纯文字 */
export type PersonStyle = 'profile' | 'quote' | 'poster' | 'text';

export interface PersonContent {
  style: PersonStyle;
  /** 是否显示照片 */
  showImage: boolean;
  imageUrl?: string;
  /** 照片形状 */
  imageShape: 'square' | 'circle';
  /** 照片方位（简介样式：左/右） */
  imageSide: 'left' | 'right';
  name?: string;
  /** 职务 / 身份（姓名下小字） */
  title?: string;
  /** 简介 */
  intro?: string;
  /** 名言 / 台词 */
  quote?: string;
  /** 整卡语音（编辑端可试听；导出为纯视觉） */
  audioUrl?: string;
}

export const PERSON_PRESETS: { id: PersonStyle; zh: string; en: string }[] = [
  { id: 'profile', zh: '人物简介', en: 'Profile' },
  { id: 'quote', zh: '名言台词', en: 'Quote' },
  { id: 'poster', zh: '海报大图', en: 'Poster' },
  { id: 'text', zh: '纯文字', en: 'Text' },
];

/** 预设对应的默认图片参数（不动已填文字） */
export const PERSON_STYLE_DEFAULTS: Record<PersonStyle, Partial<PersonContent>> = {
  profile: { showImage: true, imageShape: 'square', imageSide: 'left' },
  quote: { showImage: false },
  poster: { showImage: true, imageShape: 'square' },
  text: { showImage: false },
};

export function defaultPersonContent(): PersonContent {
  return {
    style: 'profile', showImage: true, imageShape: 'square', imageSide: 'left',
    name: '', title: '', intro: '', quote: '',
  };
}

/** 兼容旧数据（块化 / v1 平铺）→ 精简结构 */
export function normalizePersonContent(p: unknown): PersonContent {
  const def = defaultPersonContent();
  if (!p || typeof p !== 'object') return def;
  const obj = p as Record<string, unknown> & Partial<PersonContent>;
  if (obj.style) return { ...def, ...obj } as PersonContent;
  const blocks = Array.isArray(obj.blocks)
    ? (obj.blocks as { kind?: string; show?: boolean; text?: string; imageUrl?: string }[])
    : [];
  const find = (k: string) => blocks.find((b) => b && b.kind === k && b.show !== false);
  const vis = blocks.filter((b) => b && b.show !== false);
  const imgOnly = vis.length === 1 && vis[0]?.kind === 'image';
  const layout = (obj.layout || {}) as { imageSide?: string };
  let style: PersonStyle = 'profile';
  if (imgOnly) style = 'poster';
  else if (find('quote')) style = 'quote';
  else if (!find('intro') && !find('image')) style = 'text';
  return {
    ...def,
    style,
    showImage: !!find('image') || imgOnly,
    imageUrl: find('image')?.imageUrl || (obj.imageUrl as string) || undefined,
    imageShape: 'square',
    imageSide: layout.imageSide === 'right' ? 'right' : 'left',
    name: find('name')?.text || (obj.name as string) || '',
    title: (obj.title as string) || '',
    intro: find('intro')?.text || (obj.description as string) || '',
    quote: find('quote')?.text || find('dialogue')?.text || (obj.speech as string) || '',
    audioUrl: obj.audioUrl,
  };
}

export type OverlayType =
  | 'custom'                                        // 自定义（文字/图片/视频块组合 + 背景语音）
  | 'chart'
  | 'person'                                        // 人物卡（头像+姓名+职务+介绍+说话+音效）
  | 'timeline' | 'quote' | 'compare'               // 时间线 / 引用 / 对比
  | 'stat'                                          // 数字卡
  | 'stats' | 'counter' | 'dialogue' | 'place' | 'report';  // [已删除] 态势 / 计数 / 对话卡 / 地点卡 / 战报卡（仅保留类型用于旧数据迁移）

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
  /** [已删除] report 战报卡：仅兼容旧数据，加载时迁移为 custom 文字块 */
  report?: { title?: string; value: number | string; unit?: string; note?: string };
  /** timeline 时间线卡：逐条错峰进场 */
  timeline?: { title?: string; items: { time?: string; text: string }[] };
  /** quote 引用卡：史料/电文/回忆录引文 + 出处 */
  quote?: { text: string; source?: string };
  /** compare 对比卡：左右两列 VS */
  compare?: { title?: string; left: { label: string; value: number }; right: { label: string; value: number }; unit?: string };
  /** stat 数字卡：大数字 + 标签 + 单位（可选从 0 滚动计数） */
  stat?: { value: number; label?: string; prefix?: string; unit?: string; countUp?: boolean };
  /** [已删除] counter 计数卡：仅兼容旧数据，加载时迁移为 custom 文字块 */
  counter?: { value: number; label?: string; prefix?: string; unit?: string; durationFrames?: number };
  /** [已删除] dialogue 对话卡：仅兼容旧数据，加载时迁移为 custom 文字块 */
  dialogue?: { title?: string; items: { who: string; avatarUrl?: string; text: string }[] };
  /** [已删除] stats 态势卡：仅兼容旧数据，加载时迁移为 custom 文字块 */
  stats?: { title?: string; items: { label: string; value: number; unit?: string; max?: number }[] };
  /** [已删除] place 地点卡：仅兼容旧数据，加载时迁移为 custom 文字块 */
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
  'custom', 'chart', 'person', 'timeline', 'quote', 'compare',
  'stat',
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
  if (content.type === 'report') {
    // 战报卡已删除：迁移为自定义文字块（标题 + 大数字 + 注释）
    const r = content.report;
    const blocks: OverlayBlock[] = [];
    if (r?.title) blocks.push({ id: generateId(), type: 'text', text: { content: r.title, fontSize: 16, color: '#FFFFFF', bold: true, align: 'left' } });
    if (r && r.value !== undefined && r.value !== '') blocks.push({ id: generateId(), type: 'text', text: { content: `${r.value}${r.unit || ''}`, fontSize: 28, color: '#FFFFFF', bold: true, align: 'left' } });
    if (r?.note) blocks.push({ id: generateId(), type: 'text', text: { content: r.note, fontSize: 14, color: '#e7e5e4', align: 'left' } });
    return { type: 'custom', custom: { blocks } };
  }
  if (content.type === 'counter') {
    // 计数卡已删除：迁移为自定义文字块（大数字 + 标签）
    const ct = content.counter;
    const blocks: OverlayBlock[] = [];
    if (ct) blocks.push({ id: generateId(), type: 'text', text: { content: `${ct.prefix || ''}${ct.value}${ct.unit || ''}`, fontSize: 28, color: '#FFFFFF', bold: true, align: 'left' } });
    if (ct?.label) blocks.push({ id: generateId(), type: 'text', text: { content: ct.label, fontSize: 14, color: '#e7e5e4', align: 'left' } });
    return { type: 'custom', custom: { blocks } };
  }
  if (content.type === 'dialogue') {
    // 对话卡已删除：迁移为自定义文字块（标题 + 说话人：内容）
    const dl = content.dialogue;
    const blocks: OverlayBlock[] = [];
    if (dl?.title) blocks.push({ id: generateId(), type: 'text', text: { content: dl.title, fontSize: 16, color: '#FFFFFF', bold: true, align: 'left' } });
    for (const it of dl?.items || []) blocks.push({ id: generateId(), type: 'text', text: { content: [it.who, it.text].filter(Boolean).join('：'), fontSize: 14, color: '#e7e5e4', align: 'left' } });
    return { type: 'custom', custom: { blocks } };
  }
  if (content.type === 'place') {
    // 地点卡已删除：迁移为自定义块（地名 + 简介 + 配图）
    const pl = content.place;
    const blocks: OverlayBlock[] = [];
    if (pl?.imageUrl) blocks.push({ id: generateId(), type: 'image', url: pl.imageUrl });
    if (pl?.name) blocks.push({ id: generateId(), type: 'text', text: { content: pl.name, fontSize: 18, color: '#FFFFFF', bold: true, align: 'left' } });
    if (pl?.description) blocks.push({ id: generateId(), type: 'text', text: { content: pl.description, fontSize: 14, color: '#e7e5e4', align: 'left' } });
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
  /** 字体族（默认 楷体 KaiTi, SimSun） */
  fontFamily?: string;
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

/** 背景音乐段（项目级单轨的一段）：项目绝对帧区间，段内可循环 */
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

/**
 * AI 服务的一个「能力实例」（密钥只存本机，不入项目文件）
 *
 * 一个能力 = 一行实例 = 一份 base_url + 一个 Key；「怎么发请求」在它引用的模板组里
 * （`provider_template_group` + `provider_template`，见 docs/provider-engine.md）。
 */
export interface ProviderConfig {
  /** llm=文案生成 / tts=语音（含克隆）/ image=图片生成 —— 能力就是身份（provider 表以 kind 为主键，一处一套） */
  kind: ProviderKind;
  /** 这个能力当前引用哪一组模板 */
  tplGroup: string;
  baseUrl: string;
  apiKey: string;
  /** 第二凭证：只有组里有行引用 {apiKey2} 时才出现（火山 Access Key） */
  apiKey2?: string;
  /** 这个能力走同步还是异步 —— 决定用组里哪条生成变体、要不要查询接口 */
  mode: Mode;
  /** LLM 模型名 / TTS 音色模型 / 图片模型 */
  model: string;
  /** TTS 音色 / 说话人 ID */
  voice?: string;
  /** 语速 0.5–2 */
  speed?: number;
  /** 实例参数取值：模板 inst_params_json 里那些名字的取值（size / format / sampleRate…） */
  params: Record<string, unknown>;
  /** 附加 JSON 参数（深合并进请求体的兜底口） */
  extra?: string;
  /** 批量时的并发上限，1 = 串行 */
  maxConcurrency?: number;
  /** 限流 / 网络错的退避重试次数 */
  retryTimes?: number;
}

/** 无音频时按字数估算字幕时长：0.28s/字 + 0.3s 尾巴 */
export function estimateTextDurationFrames(text: string, fps: number): number {
  const sec = Math.max(0.8, text.length * 0.28 + 0.3);
  return Math.max(1, Math.round(sec * fps));
}

export function defaultNarrationStyle(): NarrationStyle {
  // 默认对齐纪录片《千古一帝》字幕：楷体、40px、米白字、半透明黑底、底部居中
  return {
    fontSize: 40,
    fontFamily: "'KaiTi', 'STKaiti', 'SimSun', serif",
    color: '#E9DEC4',
    strokeColor: '#000000',
    strokeWidth: 0,
    bg: 'bar',
    bgColor: '#000000',
    posY: 2,
    maxPct: 92,
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
  /** 项目引用的全部素材字节（导入时逐个还原成新 assetId，并改写项目里的引用） */
  assets?: ExportedAsset[];
}
