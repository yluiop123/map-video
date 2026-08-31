// ========== 项目类型 ==========

export interface MapVideoProject {
  id: string;
  name: string;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
  globalConfig: GlobalConfig;
  chapters: Chapter[];
  baseMaps: BaseMapConfig[];
  activeBaseMapId: string;
  elevationMaps: ElevationMapConfig[];
  activeElevationMapId: string | null;
  customSymbols: CustomSymbol[];
}

export interface GlobalConfig {
  defaultDuration: number;       // 默认时长（帧）
  defaultFPS: number;
  defaultResolution: Resolution;
  defaultEasing: EasingType;
  /** 地图投影：平面（默认）/ 3D 球体 */
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
  style: string;                 // MapLibre style URL 或内联样式对象
}

export interface ElevationMapConfig {
  id: string;
  name: string;
  url: string;                   // 高程栅格瓦片 URL (terrain-rgb / terrarium)
  encoding?: 'mapbox' | 'terrarium';
  exaggeration?: number;         // 地形夸张系数
  style?: string;                // 可选的关联底图样式
}

export interface CustomSymbol {
  id: string;
  name: string;
  type: 'icon' | 'image' | 'svg';
  url: string;                   // 图片/svg 地址或 data URL
  width: number;
  height: number;
}

// ========== 章节类型 ==========

export interface Chapter {
  id: string;
  title: string;
  subtitle?: string;
  order: number;
  startFrame: number;
  endFrame: number;
  elements: MapElement[];
  camera?: CameraKeyframe[];
  overlays: OverlayItem[];
  effects: ChapterEffect[];
  transition?: TransitionConfig; // 进入本节的转场
  baseMapId?: string;            // 可选覆盖底图
  elevationMapId?: string | null;
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
  | 'custom_icon'
  | 'flag';

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
  /** 动画效果：grow=普通增长(默认) / move=路线移动 / fill=填充 */
  animEffect?: 'grow' | 'move' | 'fill';
  /** 显示移动图标（标记点沿路径移动） */
  showIcon?: boolean;
  /** 移动标记样式（复用标记 Pin 的 dot/pin/emoji/bubble/text/flag/自定义图标） */
  moveIcon?: {
    shape?: 'dot' | 'pin' | 'emoji' | 'bubble' | 'text' | 'flag' | 'image';
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
    /** 自定义图标 symbolId */
    symbolId?: string;
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

export interface PointElement extends MapElementBase {
  type: 'point';
  coordinates: [number, number];
  icon?: string;
  iconSize?: number;
  color?: string;
  label?: LabelConfig;
  /** 自定义图片（data URL 或 http URL） */
  iconUrl?: string;
  /** 呈现形态：圆点 / 纯文字贴片 / 水滴针 / 气泡 / Emoji */
  shape?: 'circle' | 'text' | 'pin' | 'bubble' | 'emoji';
  /** shape==='emoji' 时的表情字符 */
  emoji?: string;
  /** 等比缩放：30%–300%（默认 1）。影响圆点大小与文案标签字号，替代固定像素 */
  scale?: number;
  /** 朝向：faceCam=始终面向摄像机（默认）；flat=贴地（可配合 rotation 旋转） */
  orientation?: 'faceCam' | 'flat';
  /** 贴地时的旋转角（0-360，地图空间） */
  rotation?: number;
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

export interface CustomIconElement extends MapElementBase {
  type: 'custom_icon';
  coordinates: [number, number];
  symbolId: string;
  size: number;
  rotation?: number;
  color?: string;      // 图标着色（乘法混合，白色=原图）
  orientation?: 'faceCam' | 'flat';      // 图标着色（乘法混合，白色=原图）
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
  | CustomIconElement
  | FlagElement;

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
  scale?: number;
  zIndex?: number;
}

export type OverlayType = 'text' | 'person' | 'chart' | 'video' | 'image' | 'group';

export type OverlayPosition =
  | 'top' | 'bottom' | 'left' | 'right' | 'center'
  | 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

export interface OverlayContent {
  type: OverlayType;
  text?: { content: string; fontSize: number; color: string; bold?: boolean; align?: 'left' | 'center' | 'right' };
  person?: { imageUrl: string; name: string; title?: string; description?: string };
  chart?: { type: 'bar' | 'line' | 'pie' | 'area'; title?: string; data: { label: string; value: number }[]; color?: string };
  src?: string;                   // video / image 源
  image?: { url: string; alt?: string };
  children?: OverlayItem[];       // group 组合
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

// ========== 工具函数 ==========

export function generateId(): string {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

// ========== 导出/导入格式 ==========

export interface ProjectExport {
  version: number;
  exportedAt: Date;
  project: MapVideoProject;
}
