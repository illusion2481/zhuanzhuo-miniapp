/** 自习室与座位类型 — 房间以 categories(type=room) 存储，座位在 metadata.seats */

/**
 * 座位运行时状态。
 *
 * ⚠️ `in_use` 云端当前**不产出**（roomList 只给 free / reserved / maintain）。
 * 保留它是有意的：SeatMap 与 rooms 页都做了状态归一化兜底
 * （active / occupied / using / in_use → in-use），类型里留着它，
 * 这些兜底才有类型依据；删掉会让防御代码与类型声明对不上。
 * 若将来云端新增状态，请**同时**改这里与两处归一表。
 */
export type SeatRuntimeStatus = 'free' | 'reserved' | 'in_use' | 'maintain';

export interface SeatDef {
  seat_id: string;
  label?: string;
  row: number;
  col: number;
  /** 关联 seat_feature 的 code 列表 */
  features: string[];
  /** 初始/维护态；预约占用由 records 动态计算 */
  status: SeatRuntimeStatus;
  /** 口碑均分（1 位小数；0 = 尚无人评价），由 roomList 聚合 reviews 下发 */
  rating?: number;
  /** 评价条数，由 roomList 聚合 reviews 下发 */
  review_count?: number;
}

export interface RoomMetadata {
  building?: string;
  /**
   * 楼层。**统一为字符串**：管理后台表单提交的是字符串，adminOps 写入时
   * 也归一为 String；只有 seed 初始数据曾是数字，2026-09-17 已一并统一。
   */
  floor?: string;
  open_time?: string;
  close_time?: string;
  capacity?: number;
  seats: SeatDef[];
}

export interface RoomSummary {
  room_id: string;
  code: string;
  name: string;
  description?: string;
  building?: string;
  /** 楼层（字符串，与云端 adminOps / roomList 的口径一致） */
  floor?: string;
  open_time?: string;
  close_time?: string;
  freeCount: number;
  total: number;
  /**
   * 该房间当前被占用的座位数（由 roomList 计算下发）。
   * 与 freeCount 互补：total = freeCount + occupiedCount + 维护中。
   */
  occupiedCount?: number;
  seats?: Array<SeatDef & { status: SeatRuntimeStatus }>;
  features?: string[];
}
