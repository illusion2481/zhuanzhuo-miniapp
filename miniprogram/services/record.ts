import { callCloud } from './cloud';
import type { BusinessRecord, RecordListQuery } from '../types/record';
import type { PomodoroSegment } from '../utils/pomodoro';

export async function createReservation(payload: {
  room_id: string;
  seat_id: string;
  start_at: string;
  end_at: string;
  category_ids?: string[];
  goal?: string;
}): Promise<BusinessRecord> {
  const res = await callCloud<BusinessRecord>('createReservation', payload);
  if (!res.success || !res.data) {
    throw new Error(res.message || '预约失败');
  }
  return res.data;
}

export async function cancelReservation(recordId: string): Promise<BusinessRecord> {
  const res = await callCloud<BusinessRecord>('cancelReservation', { record_id: recordId });
  if (!res.success || !res.data) {
    throw new Error(res.message || '取消失败');
  }
  return res.data;
}

/** 云函数返回的业务错误（带 code，便于区分「需要到店签到码」等分支） */
export class RecordBizError extends Error {
  code: string;

  data: unknown;

  constructor(message: string, code: string, data: unknown) {
    super(message);
    this.name = 'RecordBizError';
    this.code = code;
    this.data = data;
  }
}

/**
 * 签到。
 * - seatCode：扫座位二维码时传入，服务端校验与预约座位一致
 * - checkinCode：到店签到码（商家张贴的固定码或每日动态码）
 * - lat / lng / accuracy：地理围栏坐标（gcj02）。门店配置了围栏却拿不到坐标时，
 *   服务端会返回 GEO_REQUIRED / GEO_TOO_FAR / GEO_LOW_ACCURACY 由页面提示。
 */
export async function checkinReservation(
  recordId: string,
  options: {
    seatCode?: string;
    checkinCode?: string;
    lat?: number;
    lng?: number;
    accuracy?: number;
  } = {},
): Promise<BusinessRecord> {
  const payload: Record<string, unknown> = { record_id: recordId };
  if (options.seatCode) payload.seat_code = options.seatCode;
  if (options.checkinCode) payload.checkin_code = options.checkinCode;
  // 只在拿到有效坐标时上传：传 0 / null 会被服务端判为「未定位」
  if (typeof options.lat === 'number' && typeof options.lng === 'number') {
    payload.lat = options.lat;
    payload.lng = options.lng;
    if (typeof options.accuracy === 'number') payload.accuracy = options.accuracy;
  }
  const res = await callCloud<BusinessRecord>('checkin', payload);
  if (!res.success || !res.data) {
    throw new RecordBizError(res.message || '签到失败', res.code || 'ERROR', res.data);
  }
  return res.data;
}

/** 暂离座位：active -> paused */
export async function leaveSeat(recordId: string): Promise<BusinessRecord> {
  const res = await callCloud<BusinessRecord>('leaveSeat', { action: 'leave', record_id: recordId });
  if (!res.success || !res.data) throw new Error(res.message || '暂离失败');
  return res.data;
}

/** 返回座位：paused -> active */
export async function returnSeat(recordId: string): Promise<BusinessRecord> {
  const res = await callCloud<BusinessRecord>('leaveSeat', { action: 'return', record_id: recordId });
  if (!res.success || !res.data) throw new Error(res.message || '返回座位失败');
  return res.data;
}

/**
 * 学习/预约记录查询占位：Phase 5 由 studyRecord / 专用 list 云函数承接。
 * 当前仅保留类型安全的调用形状，避免页面层直接拼云函数名。
 */
export async function listRecords(query: RecordListQuery = {}): Promise<BusinessRecord[]> {
  const res = await callCloud<BusinessRecord[]>('studyRecord', {
    action: 'list',
    ...query,
  });
  if (!res.success) {
    throw new Error(res.message || '获取记录失败');
  }
  return res.data || [];
}

// ===== 学习记录 / 番茄钟（Plan §9 Phase 5） =====

export interface StudyStartPayload {
  goal?: string;
  reservation_id?: string;
  room_id?: string;
  seat_id?: string;
  category_ids?: string[];
  /** 番茄配置：单个专注段与休息段时长（分钟），随会话写入以便多端一致 */
  focus_min?: number;
  break_min?: number;
}

export interface StudySummary {
  since: string;
  since_now: string;
  session_total: number;
  active_count: number;
  completed_count: number;
  abandoned_count: number;
  total_seconds: number;
  completed_seconds: number;
  pomodoro_total: number;
  average_seconds_per_session: number;
}

export async function startStudy(payload: StudyStartPayload = {}): Promise<BusinessRecord> {
  const res = await callCloud<BusinessRecord>('studyRecord', { action: 'start', ...payload });
  if (!res.success || !res.data) {
    throw new Error(res.message || '开始专注失败');
  }
  return res.data;
}

export async function pauseStudy(recordId: string): Promise<BusinessRecord> {
  const res = await callCloud<BusinessRecord>('studyRecord', { action: 'pause', record_id: recordId });
  if (!res.success || !res.data) throw new Error(res.message || '暂停失败');
  return res.data;
}

export async function resumeStudy(recordId: string): Promise<BusinessRecord> {
  const res = await callCloud<BusinessRecord>('studyRecord', { action: 'resume', record_id: recordId });
  if (!res.success || !res.data) throw new Error(res.message || '恢复失败');
  return res.data;
}

export async function completeStudy(recordId: string): Promise<BusinessRecord> {
  const res = await callCloud<BusinessRecord>('studyRecord', { action: 'complete', record_id: recordId });
  if (!res.success || !res.data) throw new Error(res.message || '结束学习失败');
  return res.data;
}

export async function abandonStudy(recordId: string, reason?: string): Promise<BusinessRecord> {
  const data: Record<string, unknown> = { action: 'abandon', record_id: recordId };
  if (reason) data.reason = reason;
  const res = await callCloud<BusinessRecord>('studyRecord', data);
  if (!res.success || !res.data) throw new Error(res.message || '结束学习失败');
  return res.data;
}

export interface PomodoroSyncResult {
  pomodoro_count: number;
  segment_count: number;
}

/**
 * 同步番茄段轨迹：全量重推，云端据此重算番茄数与休息扣减，幂等可重复调用。
 * 失败不抛出业务错误以外的东西：调用方应吞掉网络异常，下次记账时会自动补推。
 */
export async function syncPomodoro(payload: {
  record_id: string;
  segments: PomodoroSegment[];
  focus_min: number;
  break_min: number;
}): Promise<PomodoroSyncResult> {
  const res = await callCloud<PomodoroSyncResult>('studyRecord', {
    action: 'sync_pomodoro',
    record_id: payload.record_id,
    segments: payload.segments,
    focus_min: payload.focus_min,
    break_min: payload.break_min,
  });
  if (!res.success || !res.data) {
    throw new Error(res.message || '番茄同步失败');
  }
  return res.data;
}

/**
 * 编辑学习记录：名称（goal）与时长（duration_min）。
 * 两者至少传一个；进行中（running）的记录只能改名称，不能改时长。
 */
export async function updateStudyRecord(payload: {
  record_id: string;
  goal?: string;
  duration_min?: number;
}): Promise<BusinessRecord> {
  const data: Record<string, unknown> = { action: 'update', record_id: payload.record_id };
  if (payload.goal !== undefined) data.goal = payload.goal;
  if (payload.duration_min !== undefined) data.duration_min = payload.duration_min;
  const res = await callCloud<BusinessRecord>('studyRecord', data);
  if (!res.success || !res.data) {
    throw new Error(res.message || '保存失败');
  }
  return res.data;
}

/** 删除学习记录（仅限本人非进行中的记录；云端有类型与状态护栏） */
export async function deleteStudyRecord(recordId: string): Promise<void> {
  const res = await callCloud<null>('studyRecord', { action: 'delete', record_id: recordId });
  if (!res.success) {
    throw new Error(res.message || '删除失败');
  }
}

export async function listMyStudies(options: { status?: string; limit?: number; since?: string } = {}): Promise<BusinessRecord[]> {
  const res = await callCloud<BusinessRecord[]>('studyRecord', { action: 'list', ...options });
  if (!res.success) {
    throw new Error(res.message || '获取学习记录失败');
  }
  return res.data || [];
}

/**
 * 列本人预约记录（不含学习/签到/暂离）
 * - status?: 按状态过滤
 * - limit?:  1~100，默认 50
 */
export async function listMyReservations(options: { status?: string; limit?: number } = {}): Promise<BusinessRecord[]> {
  const res = await callCloud<BusinessRecord[]>('studyRecord', {
    action: 'list_reservations',
    ...options,
  });
  if (!res.success) {
    throw new Error(res.message || '获取预约记录失败');
  }
  return res.data || [];
}

/** 改约：修改已存在预约的开始/结束时间（时段冲突由云端重校验） */
export async function updateReservation(payload: {
  record_id: string;
  start_at: string;
  end_at: string;
  goal?: string;
}): Promise<BusinessRecord> {
  const res = await callCloud<BusinessRecord>('updateReservation', payload);
  if (!res.success || !res.data) {
    throw new Error(res.message || '改约失败');
  }
  return res.data;
}

/**
 * 一键续时：使用中/暂离中的预约向后顺延 end_at（start_at 不动）。
 * 云端会夹到打烊时段并复检冲突；失败时抛 RecordBizError。
 */
export async function extendReservation(recordId: string, extendMinutes: number): Promise<BusinessRecord> {
  const res = await callCloud<BusinessRecord>('updateReservation', {
    record_id: recordId,
    extend_minutes: extendMinutes,
  });
  if (!res.success || !res.data) {
    throw new Error(res.message || '续时失败');
  }
  return res.data;
}

/** 提交座位评价（仅已完成预约；一单一评，重复提交幂等返回） */
export async function submitReview(payload: {
  record_id: string;
  rating: number;
  content?: string;
}): Promise<{ record_id: string; rating: number; already?: boolean }> {
  const res = await callCloud<{ record_id: string; rating: number; already?: boolean }>('submitReview', payload);
  if (!res.success || !res.data) {
    throw new Error(res.message || '评价提交失败');
  }
  return res.data;
}

export async function fetchStudySummary(since: string): Promise<StudySummary> {
  const res = await callCloud<StudySummary>('studyRecord', { action: 'summary', since });
  if (!res.success || !res.data) {
    throw new Error(res.message || '获取学习统计失败');
  }
  return res.data;
}

/* ══════════════ 专注排行榜（studyRank）══════════════ */

export type RankPeriod = 'today' | 'week' | 'all';

/** 榜单类型：focus = 专注时长榜；checkin = 签到次数榜 */
export type RankBoard = 'focus' | 'checkin';

export interface RankEntry {
  rank: number;
  user_id: string;
  name: string;
  /** 前端生成的头像字符（取昵称首字） */
  char?: string;
  focus_sec: number;
  pomodoro: number;
  sessions: number;
  /** 签到榜专用：已到店使用的预约次数 */
  checkin_count?: number;
  /** 是否是当前用户（前端标记） */
  is_me?: boolean;
}

export interface RankMe {
  rank: number;
  focus_sec: number;
  pomodoro: number;
  sessions: number;
  checkin_count?: number;
}

export interface RankResult {
  period: RankPeriod;
  type?: RankBoard;
  updated_at: string;
  top: RankEntry[];
  me: RankMe | null;
}

/** 拉取排行榜：type=focus 按专注时长，type=checkin 按签到次数；period 控制时段 */
export async function fetchStudyRank(period: RankPeriod = 'week', type: RankBoard = 'focus'): Promise<RankResult> {
  const res = await callCloud<RankResult>('studyRank', { period, type });
  if (!res.success || !res.data) {
    throw new Error(res.message || '获取排行榜失败');
  }
  return res.data;
}

/**
 * 计算当前 running 记录的有效学习秒数（不信任本地累加，作为兜底）
 * 若 pause_segments 存在但最后一段未闭合，按 now 兜底。
 */
export function computeStudyActiveSeconds(record: BusinessRecord, nowMs: number = Date.now()): number {
  const startMs = new Date(record.start_at || record.created_at).getTime();
  const endMs = record.end_at ? new Date(record.end_at).getTime() : nowMs;
  let seconds = Math.max(0, endMs - startMs) / 1000;
  const payload = (record.payload || {}) as { pause_segments?: Array<{ start?: string; end?: string }> };
  const segments = Array.isArray(payload.pause_segments) ? payload.pause_segments : [];
  for (const seg of segments) {
    if (!seg || !seg.start) continue;
    const segStart = new Date(seg.start).getTime();
    const segEnd = seg.end ? new Date(seg.end).getTime() : nowMs;
    seconds -= Math.max(0, segEnd - segStart) / 1000;
  }
  return Math.max(0, Math.floor(seconds));
}
