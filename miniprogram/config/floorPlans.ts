/**
 * 平面图座位坐标配置
 *
 * 每个房间类型一张俯视背景图 + 座位坐标。
 * 两种坐标模式（互斥）：
 *   • positions：预定义的固定坐标点数组（%），按索引与 seats 一一对应，精准贴合底图
 *   + bounds：  百分比边界框，座位按 row/col 均匀铺满此区域（fallback）
 */

export interface SeatPoint {
  /** 座位中心 X（相对底图宽度的百分比） */
  x: number;
  /** 座位中心 Y（相对底图高度的百分比） */
  y: number;
}

export interface FloorPlanConfig {
  /** 底图资源路径（相对 miniprogram/） */
  image: string;
  /** 座位按钮占图宽百分比（默认 5） */
  seatSize?: number;
  /** 底图宽高比（宽/高），用于把正方形按钮换算成百分比高度 */
  aspect?: number;
  /**
   * 预定义座位坐标点（%）。
   * 若提供，buildFloorPlan 按索引逐一映射真实 seat（有几个 seat 就用前几个点）；
   * 若不提供，fallback 到 bounds 均匀分布。
   */
  positions?: SeatPoint[];
  /** 座位可放置区域的百分比边界（仅 positions 未设置时生效） */
  bounds?: { top: number; bottom: number; left: number; right: number };
}

/* ═══════════════════════════════════════════════════════════════
   ① 图书馆 Library（日式木质风）
   12 个座位分左右两区，每区 2 行 × 3 列，中间为主过道。
   坐标严格网格对齐：同列同 X、同行同 Y。
   ═══════════════════════════════════════════════════════════════ */
export const libraryFloorPlan: FloorPlanConfig = {
  image: '/assets/seats/library-v2.jpg',
  seatSize: 7.5,
  aspect: 1920 / 1077,
  // ── 左区列 X / 右区列 X（每区内等距）──
  // ── 上排 Y / 下排 Y（全区统一）──────────────
  positions: [
    // ── 左区上排（3 座）──
    { x: 18.0, y: 43 },  // 0
    { x: 27.5, y: 43 },  // 1
    { x: 37.5, y: 43 },  // 2
    // ── 右区上排（3 座）──
    { x: 64.5, y: 43 },  // 3
    { x: 74.5, y: 43 },  // 4
    { x: 85.5, y: 43 },  // 5
    // ── 左区下排（3 座）──
    { x: 18.0, y: 67 },  // 6
    { x: 27.5, y: 67 },  // 7
    { x: 37.5, y: 67 },  // 8
    // ── 右区下排（3 座）──
    { x: 64.5, y: 67 },  // 9
    { x: 74.5, y: 67 },  // 10
    { x: 85.5, y: 67 },  // 11
  ],
};

/* ═══════════════════════════════════════════════════════════════
   ② 教学楼 Classroom（日式教室风）
   8 个座位分 2 行 × 4 列，严格网格对齐，居中紧凑。
   X 范围 31~70（中心 50.5），列间距 13；Y 范围 48~62（中心 55），行间距 14。
   ═══════════════════════════════════════════════════════════════ */
export const classroomFloorPlan: FloorPlanConfig = {
  image: '/assets/seats/classroom.jpg',
  seatSize: 7.5,
  aspect: 1920 / 1078,
  positions: [
    // ── 上排（4 座）──
    { x: 31.0, y: 48 },  // 0
    { x: 44.0, y: 48 },  // 1
    { x: 57.0, y: 48 },  // 2
    { x: 70.0, y: 48 },  // 3
    // ── 下排（4 座）──
    { x: 31.0, y: 62 },  // 4
    { x: 44.0, y: 62 },  // 5
    { x: 57.0, y: 62 },  // 6
    { x: 70.0, y: 62 },  // 7
  ],
};

/* ═══════════════════════════════════════════════════════════════
   ③ 咖啡角 Coffee Corner（休闲咖啡风）
   6 个座位分 2 行 × 3 列，严格网格对齐，居中紧凑。
   X 范围 34~66（中心 50），列间距 16；Y 范围 48~62（中心 55），行间距 14。
   ═══════════════════════════════════════════════════════════════ */
export const coffeeCornerFloorPlan: FloorPlanConfig = {
  image: '/assets/seats/coffee-corner.jpg',
  seatSize: 7.5,
  aspect: 1920 / 1078,
  positions: [
    // ── 上排（3 座）──
    { x: 34.0, y: 48 },  // 0
    { x: 50.0, y: 48 },  // 1
    { x: 66.0, y: 48 },  // 2
    // ── 下排（3 座）──
    { x: 34.0, y: 62 },  // 3
    { x: 50.0, y: 62 },  // 4
    { x: 66.0, y: 62 },  // 5
  ],
};

/** 已注册的平面图配置，按 key 索引 */
export const floorPlans: Record<string, FloorPlanConfig> = {
  library: libraryFloorPlan,
  classroom: classroomFloorPlan,
  'coffee-corner': coffeeCornerFloorPlan,
};
