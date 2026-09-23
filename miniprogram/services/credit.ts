import { callCloud } from './cloud';

/** 积分抵免返回值（useCredit 云函数） */
export interface CreditWaiveResult {
  /** 剩余邀请积分 */
  credit: number;
  /** 剩余违约次数 */
  no_show_count: number;
  /** 已用抵免次数 */
  waived_total: number;
  /** 是否可继续抵免 */
  can_waive: boolean;
  /** 剩余可用抵免次数 */
  remaining_waives: number;
}

/**
 * 用 1 积分抵免 1 次违约。
 * 成功返回最新积分/违约/已用数；不满足条件时云函数返回 success:true 但 can_waive:false，
 * 前端据此提示原因（无违约/积分不足/达上限）。
 */
export async function useCreditWaive(): Promise<CreditWaiveResult> {
  const res = await callCloud<CreditWaiveResult>('useCredit', {});
  if (!res.success || !res.data) {
    throw new Error(res.message || '抵免失败');
  }
  return res.data;
}