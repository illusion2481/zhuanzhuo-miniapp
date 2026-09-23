import { callCloud } from './cloud';
import type { RoomSummary, SeatRuntimeStatus } from '../types/room';

export type SeatMaintainStatus = 'maintain' | 'free';

/** 云函数返回的业务错误（带 code，便于区分 SEAT_OCCUPIED） */
export class CloudBizError extends Error {
  code: string;

  data: unknown;

  constructor(message: string, code: string, data: unknown) {
    super(message);
    this.name = 'CloudBizError';
    this.code = code;
    this.data = data;
  }
}

/* ══════════════ 商家后台（adminOps）══════════════ */

export interface OverviewRoomView {
  room_id: string;
  name: string;
  code: string;
  status: string;
  building: string;
  floor: string;
  total: number;
  maintain: number;
  used: number;
  available: number;
  usage_rate: number;
}

export interface OverviewData {
  realtime: {
    total_seats: number;
    used_seats: number;
    maintain_seats: number;
    available_seats: number;
    usage_rate: number;
    active_rooms: number;
  };
  today: { created: number; by_status: Record<string, number>; no_show: number; cancelled: number; completed: number };
  trend: Array<{ date: string; count: number }>;
  peak_hours: Array<{ hour: number; count: number }>;
  rooms: OverviewRoomView[];
  /** 客服工单概览：供 Tab 角标与看板显示，避免「不看反馈 Tab 就不知道有新工单」 */
  feedback: {
    pending: number;
    replied: number;
    handled: number;
    total: number;
    overdue: number;
  };
}

export interface ReservationRow {
  _id: string;
  status: string;
  room_id: string;
  room_name: string;
  seat_id: string;
  user_id: string;
  user_name: string;
  start_at: string;
  end_at: string;
  created_at: string;
  goal: string;
  violation_type: string;
}

export interface UserRow {
  user_id: string;
  nick_name: string;
  role: string;
  no_show_count: number;
  banned_until: string;
  banned: boolean;
  /** 邀请积分（1 分 = 抵免 1 次违约） */
  invite_credit: number;
  /** 可选绑定手机号（脱敏后原值；为空表示未绑） */
  phone: string;
  created_at: string;
}

export type ReservationOp = 'cancel' | 'no_show' | 'checkin' | 'complete';
export type UserOp = 'clear_penalty' | 'ban' | 'unban';

/**
 * 统一的管理端运营接口入口。
 * 注意：外层的 action 用于分发，具体动作参数名是 op（避免同名覆盖）。
 */
export async function adminOps<T>(
  action: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const res = await callCloud<T>('adminOps', { action, ...payload });
  if (!res.success || !res.data) {
    throw new CloudBizError(res.message || '操作失败', pickCode(res), res.data);
  }
  return res.data;
}

export interface SeatMaintainResult {
  room_id: string;
  seat_id: string;
  status: SeatMaintainStatus;
  updated_at: string;
  seats: Array<{ seat_id: string; status?: SeatRuntimeStatus }>;
  maintainCount: number;
}

/** 从云函数返回体里安全取业务错误码 */
function pickCode(res: { success: boolean; data: unknown }): string {
  return String((res as unknown as { code?: string }).code || 'ERROR');
}

/**
 * 管理员设置 / 解除座位维护态。
 * - 座位存在进行中的预约时，云函数返回 code = 'SEAT_OCCUPIED'
 */
export async function setSeatMaintain(params: {
  roomId: string;
  seatId: string;
  status: SeatMaintainStatus;
}): Promise<SeatMaintainResult> {
  const res = await callCloud<SeatMaintainResult>('adminSeatMaintain', {
    room_id: params.roomId,
    seat_id: params.seatId,
    status: params.status,
  });
  if (!res.success || !res.data) {
    throw new CloudBizError(res.message || '操作失败', pickCode(res), res.data);
  }
  return res.data;
}

/**
 * 管理员强制释放座位（最高权限）：
 * 取消占用该座位的全部进行中预约（不计用户违约），座位恢复可约。
 */
export async function releaseSeat(roomId: string, seatId: string): Promise<{ released: number }> {
  return adminOps<{ released: number }>('releaseSeat', { room_id: roomId, seat_id: seatId });
}

/**
 * 管理端座位图数据：直连 roomList 云函数，**不做本地演示兜底**，
 * 保证管理页看到的座位状态一定是云端真实数据（失败时明确抛错）。
 */
export async function fetchRoomSeats(
  params: { startAt?: string; endAt?: string } = {},
): Promise<RoomSummary[]> {
  const res = await callCloud<RoomSummary[]>('roomList', { ...params });
  if (!res.success || !Array.isArray(res.data)) {
    throw new CloudBizError(res.message || '获取座位失败', pickCode(res), res.data);
  }
  return res.data;
}

/* ══════════════ 到店签到码 ══════════════ */

export interface CheckinCodeRoom {
  room_id: string;
  name: string;
  /** 是否商家自定义的固定码（false = 每日自动轮换的动态码） */
  custom: boolean;
  code: string;
  date: string;
}

export interface CheckinCodesData {
  rooms: CheckinCodeRoom[];
  date: string;
  /** 云函数是否强制校验签到码（关闭时用户可直接签到） */
  require_code: boolean;
}

/** 查询各自习室当前生效的到店签到码 */
export async function fetchCheckinCodes(): Promise<CheckinCodesData> {
  return adminOps<CheckinCodesData>('checkinCodes');
}

/** 设置 / 清除（传空串）某自习室的固定签到码 */
export async function setCheckinCode(
  roomId: string,
  code: string,
): Promise<{ room_id: string; custom: boolean; code: string }> {
  return adminOps<{ room_id: string; custom: boolean; code: string }>('setCheckinCode', {
    room_id: roomId,
    code,
  });
}

/* ══════════════ 签到地理围栏（防拍照远程签到） ══════════════ */

export interface RoomGeoRow {
  room_id: string;
  name: string;
  /** 是否已配置围栏（false = 该店不做位置校验，用户可直接签到） */
  enabled: boolean;
  lat: number | null;
  lng: number | null;
  radius: number | null;
  address: string;
}

export interface RoomGeoData {
  rooms: RoomGeoRow[];
  default_radius: number;
  min_radius: number;
  max_radius: number;
  /** 坐标系口径：gcj02（与 wx.getLocation / wx.chooseLocation 一致） */
  coord_system: string;
}

/** 查询各自习室的位置签到配置 */
export async function fetchRoomGeo(): Promise<RoomGeoData> {
  return adminOps<RoomGeoData>('roomGeo');
}

/* ══════════════ 签到方式总览（位置围栏 + 到店签到码） ══════════════ */

/**
 * 单个自习室的签到方式配置。
 *
 * 2026-09-19：由 adminOps 的 `checkinConfig` 一次返回。之前管理端要分别调
 * `checkinCodes` 和 `roomGeo`，页面上就出现了两张功能重叠的卡片（都要先选房间、
 * 都要点保存）。合并后前端只维护一份房间列表与一个房间选择器。
 */
export interface CheckinRoom {
  room_id: string;
  name: string;
  /** ① 位置围栏：是否已开启（false = 该店不做位置校验） */
  geo_enabled: boolean;
  geo_lat: number | null;
  geo_lng: number | null;
  geo_radius: number | null;
  geo_address: string;
  /** ② 到店签到码：是否商家自定义的固定码（false = 每日自动轮换） */
  code_custom: boolean;
  code: string;
}

export interface CheckinConfigData {
  rooms: CheckinRoom[];
  date: string;
  /** 云函数是否强制校验签到码（关闭时用户可直接签到） */
  require_code: boolean;
  default_radius: number;
  min_radius: number;
  max_radius: number;
  /** 坐标系口径：gcj02（与 wx.getLocation / wx.chooseLocation 一致） */
  coord_system: string;
}

/** 查询各自习室的签到方式配置（位置围栏 + 到店签到码，一次拿全） */
export async function fetchCheckinConfig(): Promise<CheckinConfigData> {
  return adminOps<CheckinConfigData>('checkinConfig');
}

/**
 * 设置某自习室的位置签到围栏。
 * @param geo 传 null 表示关闭该店的位置校验
 */
export async function setRoomGeo(
  roomId: string,
  geo: { lat: number; lng: number; radius: number; address?: string } | null,
): Promise<{ room_id: string; enabled: boolean }> {
  if (!geo) {
    return adminOps<{ room_id: string; enabled: boolean }>('setRoomGeo', {
      room_id: roomId,
      clear: true,
    });
  }
  return adminOps<{ room_id: string; enabled: boolean }>('setRoomGeo', {
    room_id: roomId,
    lat: geo.lat,
    lng: geo.lng,
    radius: geo.radius,
    address: geo.address || '',
  });
}

/* ══════════════ 意见反馈 ══════════════ */

/** 工单状态：pending 待处理 / replied 已回复等用户确认 / handled 已关闭 */
export type FeedbackStatus = 'pending' | 'replied' | 'handled';

export interface FeedbackFollowup {
  content: string;
  created_at: string;
}

export interface FeedbackRow {
  feedback_id: string;
  user_id: string;
  /** 提交者昵称（后台要认出是谁提的；可能为空） */
  nick_name: string;
  /** user_id 前 6 位，卡片上简短展示用 */
  user_short: string;
  category: string;
  content: string;
  images: string[];
  status: FeedbackStatus;
  /** 待处理等待毫秒数（非 pending 为 0） */
  waiting_ms: number;
  /** 等待超过 24 小时，需标红提醒 */
  overdue: boolean;
  /** 后台回复内容（客服闭环：用户在「我的反馈」可见） */
  reply: string;
  /** 回复时间 */
  replied_at: string;
  /** 用户追问记录：出现追问说明上一轮回复没解决问题，需重点跟进 */
  followups: FeedbackFollowup[];
  created_at: string;
  updated_at: string;
}

export interface FeedbackListData {
  list: FeedbackRow[];
  total: number;
  returned: number;
}

/** 查询意见反馈列表（默认全部；可传 status 过滤 pending/handled） */
export async function listFeedback(
  opts: { status?: FeedbackStatus; limit?: number } = {},
): Promise<FeedbackListData> {
  const payload: Record<string, unknown> = {};
  if (opts.status) payload.status = opts.status;
  if (opts.limit) payload.limit = opts.limit;
  return adminOps<FeedbackListData>('listFeedback', payload);
}

/** 将某条反馈标记为已处理 */
export async function markFeedbackHandled(feedbackId: string): Promise<{ feedback_id: string; status: string }> {
  return adminOps<{ feedback_id: string; status: string }>('markFeedbackHandled', {
    feedback_id: feedbackId,
  });
}

/**
 * 后台回复反馈：写入回复内容并置为已处理。
 * reply 为空串时等价 markFeedbackHandled（只关单、不回复）。
 */
export async function replyFeedback(
  feedbackId: string,
  reply: string,
): Promise<{ feedback_id: string; status: string; reply: string }> {
  return adminOps<{ feedback_id: string; status: string; reply: string }>('replyFeedback', {
    feedback_id: feedbackId,
    reply,
  });
}
