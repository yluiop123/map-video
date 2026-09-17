import { create } from 'zustand';

export type InteractionMode =
  | 'select'           // 选择/编辑模式
  // 点
  | 'add_point'        // 标记点
  | 'add_text'         // 文字贴片（Mapimator Text）
  | 'add_moving_line'  // 移动点（直线路径）
  | 'add_moving_bezier'// 移动点（贝塞尔曲线路径）
  | 'add_flag'         // 旗帜
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
  | 'add_shape_poly_curve'       // 曲线多边（多点采点闭合，边曲线化）
  | 'add_shape_poly_defend'      // 直线防御圈（闭合多边形 + 锯齿一圈）
  | 'add_shape_poly_curve_defend'// 曲线防御圈（闭合曲线多边形 + 锯齿一圈）
  // 疆域
  | 'add_terr_plot'    // 绘制地块（多点采点闭合 → 加入选中疆域）
  | 'terr_split'       // 分割地块（两点画切线切开当前编辑地块）
  | 'terr_annex'       // 兼并（点选地块多选 → 面板生成事件）
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
export type PlaceKind = 'pin' | 'territory';

/** 标记弹窗可选样式（对应标记设置的样式区） */
export type PinPlaceStyle = 'pin' | 'bubble' | 'flag' | 'text' | 'emoji' | 'image' | 'gif' | 'model' | 'icon' | 'milsym';

/** 路线弹窗的样式请求（落到对应绘制模式完成时套用） */
export type RouteDrawStyle = 'arrow-line' | 'arrow-curve' | 'plain-straight' | 'plain-bezier' | 'swallowtail' | 'march';

interface InteractionState {
  mode: InteractionMode;
  isDrawing: boolean;
  selectedElementId: string | null;   // 仅内部使用，选中以 editorStore 为准
  focusReq: FocusRequest | null;
  pendingPlace: { kind: PlaceKind; pinStyle?: PinPlaceStyle; ts: number } | null;
  /** 路线弹窗选中的样式；仅在 mode 匹配的绘制完成时生效并清除 */
  pendingRouteStyle: { style: RouteDrawStyle; mode: InteractionMode } | null;

  setMode: (mode: InteractionMode) => void;
  setSelectedElement: (id: string | null) => void;
  requestFocus: (elementId: string) => void;
  clearFocus: () => void;
  requestPlace: (kind: PlaceKind, pinStyle?: PinPlaceStyle) => void;
  clearPendingPlace: () => void;
  setPendingRouteStyle: (style: RouteDrawStyle, mode: InteractionMode) => void;
  clearPendingRouteStyle: () => void;
}

export const useInteractionStore = create<InteractionState>()((set) => ({
  mode: 'select',
  isDrawing: false,
  selectedElementId: null,
  focusReq: null,
  pendingPlace: null,
  pendingRouteStyle: null,

  // 切模式即作废未消费的路线样式请求（弹窗在 setMode 之后重挂，避免取消绘制后残留）
  setMode: (mode) => set({ mode, isDrawing: false, pendingRouteStyle: null }),
  setSelectedElement: (id) => set({ selectedElementId: id }),
  requestFocus: (elementId) => set({ focusReq: { elementId, ts: Date.now() } }),
  clearFocus: () => set({ focusReq: null }),
  requestPlace: (kind, pinStyle) => set({ pendingPlace: { kind, pinStyle, ts: Date.now() } }),
  clearPendingPlace: () => set({ pendingPlace: null }),
  setPendingRouteStyle: (style, mode) => set({ pendingRouteStyle: { style, mode } }),
  clearPendingRouteStyle: () => set({ pendingRouteStyle: null }),
}));
