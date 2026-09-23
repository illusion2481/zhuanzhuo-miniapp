/**
 * 微信实时日志（线上排障神器）。
 *
 * 基础库 2.7.1+ 提供 wx.getRealtimeLogManager；在「小程序后台 → 开发管理 →
 * 实时日志」可查看。比 console.log 更可靠（发布版也能捞到），且自带 userId 关联。
 *
 * 用法：rlog('login ok', userId) / rlogError('pay fail', err)
 * 低版本或不支持时静默降级，绝不抛错。
 */

let mgr: WechatMiniprogram.RealtimeLogManager | null | undefined;

function getMgr(): WechatMiniprogram.RealtimeLogManager | null {
  if (mgr === undefined) {
    try {
      mgr = wx.getRealtimeLogManager ? wx.getRealtimeLogManager() : null;
    } catch {
      mgr = null;
    }
  }
  return mgr || null;
}

export function rlog(...args: unknown[]): void {
  const m = getMgr();
  if (m && m.info) {
    try {
      m.info(...(args as []));
    } catch {
      /* noop */
    }
  }
}

export function rlogWarn(...args: unknown[]): void {
  const m = getMgr();
  if (m && m.warn) {
    try {
      m.warn(...(args as []));
    } catch {
      /* noop */
    }
  }
}

export function rlogError(...args: unknown[]): void {
  const m = getMgr();
  if (m && m.error) {
    try {
      m.error(...(args as []));
    } catch {
      /* noop */
    }
  }
}
