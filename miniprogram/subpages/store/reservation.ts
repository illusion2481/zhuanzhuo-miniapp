import type { BusinessRecord } from '../../types/record';

/** 当前预约状态 */

const STORAGE_KEY = 'activeReservation';

let activeReservation: BusinessRecord | null = null;

/** 从内存读取当前预约；内存为空时回退到本地缓存（换设备/冷启动后仍可恢复） */
export function getActiveReservation(): BusinessRecord | null {
  if (activeReservation) return activeReservation;
  try {
    const cached = wx.getStorageSync(STORAGE_KEY) as BusinessRecord | '';
    return cached || null;
  } catch {
    return null;
  }
}

/** 写入当前预约：同步内存 + 本地缓存，保证「预约 → 学习」链路（study.ts 读取的是 storage） */
export function setActiveReservation(record: BusinessRecord | null): void {
  activeReservation = record;
  try {
    if (record) wx.setStorageSync(STORAGE_KEY, record);
    else wx.removeStorageSync(STORAGE_KEY);
  } catch {
    /* 存储失败不影响本次会话 */
  }
}

/** 校验本地预约是否仍有效（status 属于可学习状态且未过期）；无效时清理缓存 */
export function clearStaleActiveReservation(
  statuses: string[],
  nowMs: number = Date.now(),
): void {
  const cur = getActiveReservation();
  if (!cur) return;
  const valid = statuses.includes(cur.status) &&
    (!cur.end_at || new Date(cur.end_at).getTime() > nowMs);
  if (!valid) setActiveReservation(null);
}
