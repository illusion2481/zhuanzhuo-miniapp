/** 业务与状态常量 — 与 Plan 数据库设计对齐 */

export const RECORD_TYPE = {
  RESERVATION: 'reservation',
  CHECKIN: 'checkin',
  LEAVE: 'leave',
  STUDY: 'study',
  FEEDBACK: 'feedback',
} as const;

export const RESERVATION_STATUS = {
  PENDING_CHECKIN: 'pending_checkin',
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  NO_SHOW: 'no_show',
} as const;

export const CHECKIN_STATUS = {
  SUCCESS: 'success',
  EXPIRED: 'expired',
} as const;

export const LEAVE_STATUS = {
  ACTIVE: 'active',
  RETURNED: 'returned',
  EXPIRED: 'expired',
} as const;

export const STUDY_STATUS = {
  RUNNING: 'running',
  COMPLETED: 'completed',
  ABANDONED: 'abandoned',
} as const;

export const CATEGORY_TYPE = {
  ROOM: 'room',
  SEAT_FEATURE: 'seat_feature',
  STUDY_GOAL: 'study_goal',
  FEEDBACK_TAG: 'feedback_tag',
} as const;

export const CATEGORY_STATUS = {
  ACTIVE: 'active',
  DISABLED: 'disabled',
} as const;

/**
 * 预约后未签到自动释放座位并记违约的宽限（分钟）。
 * ⚠️ 口径必须与云端三处完全一致，改这里要同步改：
 *   - `cloudfunctions/expireRecords` 的 `PENDING_GRACE_MINUTES`
 *   - `cloudfunctions/roomList` 的 `isStale()` 宽限
 *   - `cloudfunctions/createReservation` 的 `releasedByTimeout()`
 * `scripts/cloud-logic.test.cjs` 里有一条断言专门守着这个一致性。
 */
export const CHECKIN_TIMEOUT_MINUTES = 15;

/** 单次暂离最长时长（分钟）。口径同 `expireRecords.LEAVE_TIMEOUT_MINUTES` */
export const LEAVE_TIMEOUT_MINUTES = 30;

/**
 * 单次预约的最短时长（分钟）：剩余开放时间不足此值就不再放号，
 * 由 `utils/bookingWindow.ts` 顺延到次日开放时间。
 * ⚠️ 口径同 `cloudfunctions/createReservation` 的 `MIN_BOOKING_MINUTES`。
 */
export const MIN_BOOKING_MINUTES = 15;

/** AI 每日调用上限 */
export const AI_DAILY_LIMIT = 20;

/** AI 单次输入字数上限 */
export const AI_INPUT_MAX_CHARS = 2000;

/**
 * AI 请求超时参考值（毫秒）——**当前没有任何代码引用它**，保留作口径备忘。
 * 别把它当成「小程序端有 15 秒超时」，真实超时控制在两层：
 *   ① 云函数内 `shared/aiClient` 单次 9~12s，失败重试 1 次；
 *   ② 云函数自身的执行超时（config.json / 控制台，20~30s）。
 * 小程序端**刻意不加本地超时**，否则会比云端先放弃，把「还在生成」误报成失败。
 */
export const AI_TIMEOUT_MS = 15000;

/** TabBar 页面路径 */
export const TAB_PAGES = {
  HOME: '/pages/home/home',
  ROOMS: '/pages/rooms/rooms',
  STUDY: '/pages/study/study',
  PROFILE: '/pages/profile/profile',
} as const;

/**
 * 学习计划 → 学习页的交接键。
 * 学习页是 Tab 页，switchTab 不支持 query 传参，
 * 因此首页把「某一段计划」先落到本地缓存，学习页 onShow 时取出并自动开始。
 */
export const PENDING_STUDY_TASK_KEY = 'zz_pending_study_task';

/** 待开始的学习计划多久后作废（毫秒） */
export const PENDING_STUDY_TASK_TTL = 10 * 60 * 1000;
