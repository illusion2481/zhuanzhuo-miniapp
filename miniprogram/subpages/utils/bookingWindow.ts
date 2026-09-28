/**
 * 预约时段规划：把「开始时间 + 时长 / 手动结束时间」夹（clamp）到自习室开放时段内。
 *
 * 为什么需要它：
 *   之前只要结束时间越过打烊时间（例如 20:33 → 22:33，而 22:00 打烊），
 *   服务端直接拒绝「预约时间须在 08:00-22:00 开放时段内」，用户被硬生生挡在门外。
 *   更合理的是**能约多久就约多久** —— 把结束时间截断到打烊时间。
 *
 * ⚠️ 本文件的规则与 `cloudfunctions/createReservation.clampToOpenWindow`
 *    及 `cloudfunctions/updateReservation.clampToOpenWindow` 逐条对齐，改一处必须同步另两处。
 *
 * 规则：
 *   1. 未配置 open_time/close_time，或跨夜营业（open > close）：不做截断，原样返回；
 *   2. 同日营业（open <= close）：
 *      - 开始早于开放时间 → 推到开放时间；
 *      - 开始已晚于打烊   → 顺延到次日开放时间；
 *      - 结束晚于打烊     → 截断到当日打烊时间；
 *      - 截断后不足 MIN_BOOKING_MINUTES → 顺延到次日开放时间。
 */
import { MIN_BOOKING_MINUTES } from '../../config/constants';

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 'HH:mm' → 当天第几分钟；非法返回 null */
function toMin(t: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function toHHmm(min: number): string {
  const v = Math.max(0, Math.min(1439, Math.round(min)));
  return `${pad(Math.floor(v / 60))}:${pad(v % 60)}`;
}

/** 'YYYY-MM-DD' 加减天数（用数值分量构造 Date，避开微信引擎对字符串解析的不稳定） */
function shiftDate(date: string, days: number): string {
  const [y, m, d] = String(date || '').split('-').map(Number);
  const dt = new Date(y || 1970, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export interface BookingWindow {
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  /** 截断后的实际时长（分钟） */
  durationMinutes: number;
  /** 是否因开放时段被自动调整过 */
  clamped: boolean;
  /** 被自动调整时的说明文案；未调整则为空串 */
  note: string;
  openTime: string;
  closeTime: string;
  /** 是否未配置开放时段 / 跨夜营业（此时不做任何截断） */
  unrestricted: boolean;
}

export function planBookingWindow(options: {
  startDate: string;
  startTime: string;
  durationMinutes: number;
  openTime?: string;
  closeTime?: string;
  /** 用户手动选择的结束时间（HH:mm）；有效时优先于 durationMinutes */
  manualEndTime?: string;
}): BookingWindow {
  const openTime = String(options.openTime || '');
  const closeTime = String(options.closeTime || '');
  const asked = Math.max(1, Math.round(options.durationMinutes || 60));
  let startDate = options.startDate;
  let startTime = options.startTime;

  const openMin = toMin(openTime);
  const closeMin = toMin(closeTime);
  const sameDay = openMin !== null && closeMin !== null && openMin <= closeMin;
  const notes: string[] = [];
  let clamped = false;

  // ① 不受开放时段约束
  if (!sameDay) {
    const s = toMin(startTime);
    const eMin = (s === null ? 0 : s) + asked;
    const shifted = eMin >= 1440;
    return {
      startDate,
      startTime,
      endDate: shifted ? shiftDate(startDate, 1) : startDate,
      endTime: toHHmm(eMin >= 1440 ? eMin - 1440 : eMin),
      durationMinutes: asked,
      clamped: false,
      note: '',
      openTime,
      closeTime,
      unrestricted: true,
    };
  }

  const open = openMin as number;
  const close = closeMin as number;
  const rawStart = toMin(startTime);
  let sMin = rawStart === null ? open : rawStart;

  /**
   * 用户「原意」的结束时间：优先手动值，其次「原开始 + 时长」。
   * ⚠️ 必须在把开始时间前推**之前**算出来 —— 否则 07:00→09:00 的预约会被改写成
   *    08:00→10:00（凭空多送 1 小时），而云端 createReservation 保留用户选的 09:00，
   *    两边就此不一致。口径必须与 `clampToOpenWindow` 完全相同。
   */
  const manual = toMin(String(options.manualEndTime || ''));
  let eMin = manual !== null && manual > sMin ? manual : sMin + asked;

  // ② 开始时间早于开放时间 → 前推到开放时间（结束时间保持用户原意）
  if (sMin < open) {
    sMin = open;
    startTime = openTime;
    clamped = true;
    notes.push(`开始时间早于开放时间，已调整为 ${openTime}`);
  }

  // ③ 开始时间已晚于打烊 → 顺延到次日开放时间
  if (sMin >= close) {
    const askedDate = startDate;
    startDate = shiftDate(startDate, 1);
    startTime = openTime;
    sMin = open;
    eMin = open + asked;
    clamped = true;
    notes.push(`所选时段超出开放时间（${openTime}-${closeTime}），已顺延到 ${startDate} 的 ${openTime}（原选 ${askedDate}）`);
  }

  // ④ 开始被前推后结束时间可能已落到开始之前 / 不足最短时长 → 用原时长重推
  if (eMin - sMin < MIN_BOOKING_MINUTES) eMin = sMin + asked;
  if (eMin > close) {
    eMin = close;
    clamped = true;
    notes.push(`结束时间超出打烊时间，已截断到 ${closeTime}`);
  }

  let durationMinutes = eMin - sMin;

  // ⑤ 截断后太短 → 顺延到次日（取「原时长」与整段营业时长的较小值）
  if (durationMinutes < MIN_BOOKING_MINUTES) {
    const askedDate = startDate;
    startDate = shiftDate(startDate, 1);
    startTime = openTime;
    sMin = open;
    eMin = Math.min(close, open + asked);
    durationMinutes = eMin - sMin;
    clamped = true;
    notes.push(
      `${askedDate} 剩余开放时间不足 ${MIN_BOOKING_MINUTES} 分钟，已顺延到 ${startDate} 的 ${openTime}`,
    );
  }

  return {
    startDate,
    startTime,
    endDate: startDate,
    endTime: toHHmm(eMin),
    durationMinutes,
    clamped,
    note: notes.join('；'),
    openTime,
    closeTime,
    unrestricted: false,
  };
}

/** 把 BookingWindow 转成 ISO（用数值分量构造，避开字符串解析差异） */
export function windowToIso(date: string, time: string): string {
  const [yy, mm, dd] = String(date).split('-').map(Number);
  const [hh, mi] = String(time).split(':').map(Number);
  return new Date(yy, mm - 1, dd, hh, mi).toISOString();
}
