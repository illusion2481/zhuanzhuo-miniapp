import { callCloud } from './cloud';
import { requestSubscribe, type SubscribeOutcome } from '../utils/subscribe';
import { SUBSCRIBE_TEMPLATES } from '../config/subscribe';
import type { BusinessRecord } from '../types/record';

/**
 * 预约相关的订阅消息：授权（前端）+ 发送（云端）。
 *
 * ⚠️ 职责边界（2026-09-17 收敛，改动前请先读）：
 *   - **授权**只能在前端做：`wx.requestSubscribeMessage` 需要用户点击手势，
 *     它用 `config/subscribe.ts` 里的模板 ID（主 tmplId 的唯一用途）。
 *   - **发送**只认云端：`cloudfunctions/notify` 是「模板 ID + 关键词编号 + 文案截断」
 *     的唯一数据源。本文件只负责把**内容**（自习室名 / 时间 / 座位）交给它。
 *
 * 收敛前这里是「传 templateId + 自己拼好 data」的旧路径，问题有两个：
 *   ① 前端与云端各维护一份「模板 ID + 关键词编号 + 20 字截断」→ 两边不一致时
 *      会出现「授权用 A、发送用 B」，用户永远收不到；
 *   ② 云端对事物型关键词的 20 字截断在旧路径下**完全不生效**（它只处理 type 路径）。
 * 现在发送一律走 `type`，只有「授权用的 tmplId」这一份值仍需前后端保持一致
 * —— 该一致性由 `scripts/full-audit.cjs` 的「模板 ID 一致」断言守住。
 */

export interface NotifyExtra {
  /** 自习室显示名（优先于 record.room_id，避免推文出现内部 ID） */
  roomName?: string;
  /** 座位展示名，如「一楼 · A-1」 */
  seatLabel?: string;
}

/** 事物型关键词限 20 字以内，超出会整条被云端拒绝 → 前端先截一道（云端还有一道） */
function clamp(text: string, max = 20): string {
  const t = String(text || '').trim();
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * 在用户「点击手势」内提前拉取预约类订阅授权（最多 3 张，微信单次上限）。
 * ⚠️ 必须在任何异步云调用之前调用，否则授权弹窗无法在手势内弹出，导致授权失败、
 * 后续所有订阅消息（含预约成功确认、签到提醒、超时/违约预警）都收不到。
 * 由预约提交按钮的回调同步触发；notifyReservationConfirmed 仅负责发送。
 */
export function requestReservationConfirmSubscribes(): Promise<SubscribeOutcome> {
  return requestSubscribe(['reservationConfirmed', 'checkinReminder', 'reservationWarn']);
}

/**
 * 在用户「点击手势」内提前拉取取消类订阅授权（模板 ④ 预约取消通知）。
 * 同样必须在取消的异步云调用之前调用。
 */
export function requestCancelSubscribes(): Promise<SubscribeOutcome> {
  return requestSubscribe(['reservationCancel']);
}

/**
 * 预约成功后：发一条「预约成功」确认推送。
 *
 * 整条链路对主流程零侵入：
 * - 未配置模板 ID → 直接 return，不发云调用；
 * - 用户拒绝授权 → requestSubscribe 已静默；
 * - 云函数未上传 / 发送失败 → callCloud 抛错被 catch 吞掉。
 * 因此本函数「只管发，不报错」。
 */
export async function notifyReservationConfirmed(
  record: BusinessRecord,
  extra: NotifyExtra = {},
): Promise<void> {
  try {
    const type = 'reservationConfirmed';
    // 前端这份 tmplId 是**授权**用的：没配就等于用户从未授权，发送必然失败，不必白跑云调用
    if (!SUBSCRIBE_TEMPLATES[type]) return;

    const roomName = clamp(
      extra.roomName && extra.roomName !== '预约座位' ? extra.roomName : '专注座自习室',
    );
    const seatText = clamp(
      extra.seatLabel || record.seat_id
        ? `${extra.seatLabel || `座位 ${record.seat_id}`}，请提前到店签到`
        : '请提前到店签到，凭店内签到码完成签到',
    );

    await callCloud('notify', {
      action: 'send',
      type,
      main: roomName,
      // 传原始 ISO，由云端按**北京时间**格式化 —— 前端不再自己格式化，
      // 避免「运行环境本地时区」与云端口径不一致（跨时区用户会看到错的开场时间）。
      time: record.start_at,
      extra: seatText,
      page: `subpages/myReservations/myReservations`,
    });
  } catch {
    /* 推送失败不影响预约 */
  }
}

/**
 * ⚠️ 「预约取消通知」④ 不再由前端发送：云端 cancelReservation 在取消成功（status→cancelled）
 * 时已统一发送（见 cloudfunctions/cancelReservation）。前端只负责在点击手势内申请授权
 * （requestCancelSubscribes），避免一次性订阅额度被前端+云端双发浪费。
 * 故本文件不再保留 notifyReservationCancelled。
 */
