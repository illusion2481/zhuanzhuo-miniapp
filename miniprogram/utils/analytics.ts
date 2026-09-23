/**
 * 数据埋点工具（微信分析 wx.reportAnalytics）。
 *
 * 设计原则：
 * 1. **全静默**：任何失败 / 未配置版本 / 低版本基础库都不抛错、不阻塞业务。
 * 2. **防抖**：频繁事件（如 15s 轮询触发的座位刷新）不埋，只埋用户真实动作。
 * 3. 事件名遵循微信分析自定义事件命名规范（1-32 字符，小写 + 下划线）。
 *
 * 前端埋点只是「地基」，真正要看数需在小程序后台「统计 → 自定义分析」里
 * 配置并上报事件 ID；未配置时 wx.reportAnalytics 内部自动忽略，零成本。
 */

const EVENT_NAMES = {
  /** 打开选座页（带房间维度） */
  room_enter: 'room_enter',
  /** 点击空闲座位（弹出预约抽屉） */
  seat_tap: 'seat_tap',
  /** 提交预约（含服务端成功与否） */
  booking_confirm: 'booking_confirm',
  /** 手动/扫码签到成功 */
  checkin_done: 'checkin_done',
  /** 一键续时（extend_minutes 分钟数） */
  extend_done: 'extend_done',
  /** 分享小程序 */
  share_link: 'share_link',
} as const;

type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];

/**
 * 上报自定义事件。失败/无该方法时静默。
 * @param name 事件名
 * @param params 附加参数（值须为 string | number）
 */
export function track(name: EventName, params: Record<string, string | number> = {}): void {
  try {
    const fn = typeof wx !== 'undefined' ? (wx as { reportAnalytics?: (n: string, p: unknown) => void }).reportAnalytics : undefined;
    if (typeof fn !== 'function') return;
    fn(name, params);
  } catch {
    // 埋点失败绝不影响业务
  }
}

/** 打开选自习页 */
export function trackRoomEnter(roomId: string, roomName: string): void {
  track(EVENT_NAMES.room_enter, { room_id: roomId, room_name: roomName });
}

/** 点空闲座位准备预约 */
export function trackSeatTap(seatId: string, roomId: string): void {
  track(EVENT_NAMES.seat_tap, { seat_id: seatId, room_id: roomId });
}

/** 提交预约（success: 'ok' | 'fail'） */
export function trackBookingConfirm(roomId: string, startAt: string, ok: boolean): void {
  track(EVENT_NAMES.booking_confirm, {
    room_id: roomId,
    start_at: startAt,
    result: ok ? 'ok' : 'fail',
  });
}

/** 签到成功（method：manual 我的预约 / scan 扫码 / home 首页待签到卡） */
export function trackCheckinDone(roomId: string, method: 'manual' | 'scan' | 'home'): void {
  track(EVENT_NAMES.checkin_done, { room_id: roomId, method });
}

/** 一键续时 */
export function trackExtend(roomId: string, extendMinutes: number): void {
  track(EVENT_NAMES.extend_done, { room_id: roomId, minutes: extendMinutes });
}

/** 分享点击 / 分享成功 */
export function trackShare(method: 'tap' | 'success' | 'invite_tap'): void {
  track(EVENT_NAMES.share_link, { method });
}

export { EVENT_NAMES };