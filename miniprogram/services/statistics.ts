import { callCloud } from './cloud';

/** 预约状态统计 */
export interface ReservationStatusCounts {
  pending_checkin: number;
  active: number;
  paused: number;
  completed: number;
  cancelled: number;
  no_show: number;
}

export interface AdminStatsRates {
  noShowRate: number;
  checkInRate: number;
  completionRate: number;
  occupancyRate: number;
}

/** 诊断信息：定位「统计为 0」的原因（记录总数为 0 / 字段口径不符） */
export interface AdminStatsDiag {
  /** records 集合全部记录数 */
  recordsTotal: number | null;
  /** records 中 record_type === 'reservation' 的记录数 */
  reservationCount: number | null;
  /** 读取异常信息（为空表示读取正常） */
  error: string;
}

export interface AdminStats {
  total: number;
  byStatus: ReservationStatusCounts;
  checkedIn: number;
  finished: number;
  totalSeats: number;
  occupiedNow: number;
  rates: AdminStatsRates;
  diag?: AdminStatsDiag;
  hints?: string[];
}

export interface AdminStatsRange {
  startAt?: string;
  endAt?: string;
}

/** 管理统计 — adminStats 云函数聚合 */
export async function fetchAdminStats(range: AdminStatsRange = {}): Promise<AdminStats> {
  const res = await callCloud<AdminStats>('adminStats', {
    start_at: range.startAt,
    end_at: range.endAt,
  });
  if (!res.success || !res.data) {
    throw new Error(res.message || '获取统计失败');
  }
  return res.data;
}
