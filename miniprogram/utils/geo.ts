/**
 * 签到定位（地理围栏防作弊）统一封装
 *
 * 背景：静态签到码贴在座位上，拍张照就能异地签到。因此签到必须先确认
 * 「人在门店范围内」——由云端 checkin 按 categories.metadata.geo 围栏校验。
 * 本模块只负责**拿到可信坐标并交给云端**，不做任何距离判断
 * （前端判断=可伪造，真正的校验在服务端）。
 *
 * 坐标口径：gcj02（国测局）。wx.getLocation / wx.chooseLocation 都是这个口径，
 * 与后台配置直接配对即可。
 */
import { rlog } from './logger';

export interface GeoPoint {
  lat: number;
  lng: number;
  /** 定位精度（米），越大越不可信 */
  accuracy: number;
}

interface GetLocationResultLike {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

/**
 * wx.getLocation 的 Promise 包装。
 * 用回调写法而非 Promise 风格：老基础库不支持 Promise 化，回调写法兼容性最好。
 */
function wxGetLocation(): Promise<GetLocationResultLike> {
  return new Promise((resolve, reject) => {
    wx.getLocation({
      type: 'gcj02',
      isHighAccuracy: true,
      highAccuracyExpireTime: 4000,
      success: (res: GetLocationResultLike) => resolve(res),
      fail: (err: { errMsg?: string }) => reject(err || new Error('getLocation failed')),
    });
  });
}

function isAuthDenied(err: unknown): boolean {
  const msg = String(((err as { errMsg?: string }) || {}).errMsg || '');
  return msg.indexOf('auth deny') !== -1 || msg.indexOf('auth denied') !== -1 || msg.indexOf('authorize') !== -1;
}

/** 引导用户到设置页开启定位权限（用户点「去设置」才跳） */
async function guideOpenSetting(): Promise<void> {
  try {
    const res = await wx.showModal({
      title: '需要位置权限',
      content: '到店签到需要确认你在自习室范围内（仅签到时获取，不会持续定位）。请在设置中允许「使用我的地理位置」。',
      confirmText: '去设置',
      cancelText: '暂不',
    });
    if (!res.confirm) return;
    await wx.openSetting({});
  } catch {
    // 引导失败不阻断：用户可在系统设置里自行开启
  }
}

/**
 * 取当前位置用于签到。
 * - 拿到 → 返回 GeoPoint
 * - 拿不到（拒绝授权 / 系统定位关闭 / 超时）→ 已给出引导提示，返回 null
 *   调用方把 null 传给云端即可：云端会返回 GEO_REQUIRED，由签到流程统一提示。
 *
 * @param silent true 时不弹任何提示（由调用方统一处理错误文案）
 */
export async function getCheckinLocation(options: { silent?: boolean } = {}): Promise<GeoPoint | null> {
  try {
    const res = await wxGetLocation();
    const lat = Number(res.latitude);
    const lng = Number(res.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
      if (!options.silent) {
        wx.showToast({ title: '定位结果异常，请重试', icon: 'none' });
      }
      return null;
    }
    const acc = Number(res.accuracy);
    rlog('geo ok', lat.toFixed(5), lng.toFixed(5), Number.isFinite(acc) ? `${Math.round(acc)}m` : 'n/a');
    return { lat, lng, accuracy: Number.isFinite(acc) ? acc : 0 };
  } catch (err) {
    if (isAuthDenied(err)) {
      if (!options.silent) await guideOpenSetting();
      return null;
    }
    const msg = String(((err as { errMsg?: string }) || {}).errMsg || '');
    rlog('geo fail', msg);
    if (!options.silent) {
      if (msg.indexOf('timeout') !== -1 || msg.indexOf('expire') !== -1) {
        wx.showToast({ title: '定位超时，请到窗边或连接 Wi-Fi 重试', icon: 'none' });
      } else {
        wx.showToast({ title: '定位失败，请检查手机定位是否开启', icon: 'none' });
      }
    }
    return null;
  }
}

/**
 * 管理端选点：打开地图选位置（gcj02）。
 * 用户取消时返回 null（wx.chooseLocation 取消走 fail，errMsg 含 cancel）。
 */
export function chooseLocation(): Promise<{ lat: number; lng: number; address: string; name: string } | null> {
  return new Promise((resolve) => {
    wx.chooseLocation({
      success: (res: { latitude: number; longitude: number; address?: string; name?: string }) => {
        const lat = Number(res.latitude);
        const lng = Number(res.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          resolve(null);
          return;
        }
        resolve({
          lat,
          lng,
          address: String(res.address || ''),
          name: String(res.name || ''),
        });
      },
      fail: () => resolve(null),
    });
  });
}
