/**
 * 到店签到统一流程（「我的预约」「预约成功页」「扫码深链页」共用）
 *
 * 防作弊两道闸（顺序不可颠倒）：
 *   ① 地理围栏（主防线）：签到前取 gcj02 坐标交给云端，云端按
 *      categories.metadata.geo 判断是否在门店半径内。
 *      静态签到码贴在座位上会被拍照远程签到，只有「人在现场」挡得住，
 *      因此围栏先于签到码校验，且对手动 / 码 / 扫码三种方式都强制。
 *   ② 到店签到码（可选二次验证）：服务端返回 NEED_CHECKIN_CODE 时弹输入框重试一次。
 *
 * 返回值：
 *   - 成功 → 更新后的预约记录
 *   - 用户在弹窗点了取消 / 知道了 → null（调用方静默处理，提示已在这里弹过）
 *   - 其它失败（时间窗不符 / 座位不一致）→ 抛错，由调用方展示
 */
import { checkinReservation, RecordBizError } from '../services/record';
import { login } from '../services/auth';
import { getCheckinLocation, type GeoPoint } from './geo';
import type { BusinessRecord } from '../types/record';
import { rlog } from '../utils/logger';

/** 云端围栏相关错误码 */
const GEO_CODES = ['GEO_REQUIRED', 'GEO_TOO_FAR', 'GEO_LOW_ACCURACY'];

export interface CheckinFlowOptions {
  /** 扫到的座位二维码内容（扫码签到时传入，服务端校验与预约座位一致） */
  seatCode?: string;
  /** 成功后是否弹「签到成功」toast，默认 true */
  toast?: boolean;
  /** 跳过定位（仅供调试 / 门店未开围栏时用，正常路径不要传） */
  skipGeo?: boolean;
  /** 调用方已取好的坐标（避免同一次交互里重复定位） */
  geoPoint?: GeoPoint | null;
}

function isNeedCheckinCode(err: unknown): boolean {
  if (err instanceof RecordBizError && err.code === 'NEED_CHECKIN_CODE') return true;
  const msg = String(((err as { message?: string }) || {}).message || '');
  return msg.indexOf('签到码') !== -1;
}

function geoCodeOf(err: unknown): string | null {
  if (err instanceof RecordBizError && GEO_CODES.indexOf(err.code) !== -1) return err.code;
  return null;
}

/** 弹出签到码输入框；返回 null 表示用户取消 */
async function promptCheckinCode(): Promise<string | null> {
  const res = await wx.showModal({
    title: '到店签到',
    content: '',
    editable: true,
    placeholderText: '请输入店内签到码',
    confirmText: '签到',
    cancelText: '取消',
  });
  if (!res.confirm) return null;
  return String(res.content || '').trim();
}

/**
 * 围栏 / 定位失败提示。用 modal 而非 toast：
 * 距离、半径这些文案较长，toast 会被截断成看不懂的半句话。
 * @returns true = 用户选择「重新定位」，调用方应重试
 */
async function alertGeoAndAskRetry(message: string): Promise<boolean> {
  try {
    const res = await wx.showModal({
      title: '暂时无法签到',
      content: message,
      confirmText: '重新定位',
      cancelText: '知道了',
    });
    return !!res.confirm;
  } catch {
    return false;
  }
}

function geoPayload(point: GeoPoint | null): { lat?: number; lng?: number; accuracy?: number } {
  if (!point) return {};
  return { lat: point.lat, lng: point.lng, accuracy: point.accuracy };
}

export async function checkinWithCode(
  recordId: string,
  options: CheckinFlowOptions = {},
): Promise<BusinessRecord | null> {
  const first = options.seatCode ? { seatCode: options.seatCode } : {};
  // 定位只取一次，失败也继续走云端（由云端统一判定并给出可执行的提示）
  let point: GeoPoint | null = options.geoPoint || null;
  if (!point && options.skipGeo !== true) {
    point = await getCheckinLocation({ silent: true });
  }

  let record: BusinessRecord;
  let geoRetries = 0;
  let codeRetries = 0;
  let pendingCode = '';

  for (;;) {
    try {
      record = await checkinReservation(recordId, {
        ...first,
        ...(pendingCode ? { checkinCode: pendingCode } : {}),
        ...geoPayload(point),
      });
      break;
    } catch (err) {
      const geoCode = geoCodeOf(err);
      if (geoCode) {
        const retry = await alertGeoAndAskRetry(String((err as Error).message || '无法确认你的位置'));
        if (!retry || geoRetries >= 2) {
          // 提示已弹过，返回 null 让调用方静默；不抛错避免调用方再弹一次
          return null;
        }
        geoRetries += 1;
        point = await getCheckinLocation();
        continue;
      }

      if (!isNeedCheckinCode(err)) throw err;

      // 已经输过码仍失败：先把云端完整原因弹出来（首页等调用方的 toast 只显示
      // 7 个字，「（房间名）」等关键信息全被截掉），再让用户重新输入——
      // 输错一次就直接终止整个签到流程，用户只能从头再来，体验极差。
      if (pendingCode) {
        codeRetries += 1;
        if (codeRetries >= 5) throw err;
        await new Promise<void>((resolve) => {
          wx.showModal({
            title: '签到码未通过',
            content: String((err as Error).message || '签到码不正确，请核对后重试'),
            showCancel: false,
            confirmText: '重新输入',
            complete: () => resolve(),
          });
        });
      }

      const code = await promptCheckinCode();
      if (code === null) return null;
      if (!code) {
        // 输入为空：明确提示后中止（不当作成功）
        throw new Error('请输入店内签到码');
      }
      // 重试时同样带上坐标：围栏与签到码是两道独立的闸，不能因为填了码就放过围栏
      pendingCode = code;
    }
  }

  if (options.toast !== false) {
    wx.showToast({ title: '签到成功', icon: 'success' });
  }
  rlog('checkin ok', recordId, record && record.seat_id);
  // 签到改变了用户档案（连续签到 streak / 累计次数 / 邀请奖励），
  // 静默重新登录拉最新档案，否则「我的」页 streak 会一直停在旧值，
  // 用户会以为「签到没有用」。失败不影响签到本身。
  void login().catch(() => {});
  return record;
}
