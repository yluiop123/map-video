import { create } from 'zustand';

export type InteractionMode =
  | 'select'           // 选择/编辑模式
  // 点
  | 'add_point'        // 标记点
  | 'add_text'         // 文字贴片（Mapimator Text）
  | 'add_moving_line'  // 移动点（直线路径）
  | 'add_moving_bezier'// 移动点（贝塞尔曲线路径）
  | 'add_flag'         // 旗帜
  | 'add_custom'       // 图片（自定义图标上传）
  // 线
  | 'add_line'         // 直线
  | 'add_bezier'       // 贝塞尔曲线
  | 'add_line_arc'     // 大圆弧航线（相邻点按地球大圆展开）
  // 面
  | 'add_polygon'      // 区域
  | 'add_rect'         // 矩形（两点拖定）
  | 'add_region'       // 行政区一键高亮（点选国家边界）
  // 形状（工具条「形状」菜单分类，绘制后按类型入库）
  | 'add_shape_line'          // 直线（标注）
  | 'add_shape_bezier'        // 曲线（标注）
  | 'add_shape_line_arrow'    // 带箭头直线
  | 'add_shape_bezier_arrow'  // 带箭头曲线
  | 'add_shape_march'         // 行军箭头（多点，curved-simple）
  | 'add_shape_swallowtail'   // 燕尾箭头（多点，路线燕尾绘制方式 curved）
  | 'add_shape_circle'        // 圆（两点：圆心→半径）
  | 'add_shape_star'          // 五角星（两点：圆心→外接半径）
  | 'add_special_swallow'     // 燕尾箭头（特殊图形：多点采集，curved 燕尾造型）
  | 'add_shape_front_line'    // 直线战线（多点采点，主线直连 + 一侧梳齿）
  | 'add_shape_front_curve'   // 弯曲战线（多点采点，主线贝塞尔 + 一侧梳齿）
  // 军事
  | 'add_arrow'        // 直线箭头
  | 'add_curved'       // 弯曲燕尾箭头（沿贝塞尔曲线）
  | 'add_attack'       // 进攻箭头（多点弯曲）
  | 'add_pincer'       // 钳形攻势（双箭头）
  | 'add_encirclement' // 包围圈
  | 'add_gathering';   // 集结点

export interface FocusRequest {
  elementId: string;
  ts: number;
}

/** 一键在地图中心放置元素（对应 Mapimator 点击工具即落点） */
export type PlaceKind = 'pin' | 'image';

interface InteractionState {
  mode: InteractionMode;
  isDrawing: boolean;
  selectedElementId: string | null;   // 仅内部使用，选中以 editorStore 为准
  focusReq: FocusRequest | null;
  pendingPlace: { kind: PlaceKind; ts: number } | null;

  setMode: (mode: InteractionMode) => void;
  setSelectedElement: (id: string | null) => void;
  requestFocus: (elementId: string) => void;
  clearFocus: () => void;
  requestPlace: (kind: PlaceKind) => void;
  clearPendingPlace: () => void;
}

export const useInteractionStore = create<InteractionState>()((set) => ({
  mode: 'select',
  isDrawing: false,
  selectedElementId: null,
  focusReq: null,
  pendingPlace: null,

  setMode: (mode) => set({ mode, isDrawing: false }),
  setSelectedElement: (id) => set({ selectedElementId: id }),
  requestFocus: (elementId) => set({ focusReq: { elementId, ts: Date.now() } }),
  clearFocus: () => set({ focusReq: null }),
  requestPlace: (kind) => set({ pendingPlace: { kind, ts: Date.now() } }),
  clearPendingPlace: () => set({ pendingPlace: null }),
}));
