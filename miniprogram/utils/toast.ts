/**
 * 统一错误处理 & Toast 工具
 *
 * - toAppError(err): 将任意错误转为结构化 AppError
 * - showError(err, fallback): 统一错误 toast（最长 7 个汉字，使用 icon='none'）
 * - showInfo(title): 信息类 toast（短标题、icon='none'）
 * - showSuccess(title): 成功 toast（icon='success'）
 * - showWarn(title): 警示 toast（icon='none'，黄色主题由文案自行表达）
 */

export type ErrorCategory = 'network' | 'auth' | 'business' | 'config' | 'unknown';

export interface AppError {
  code: string;
  category: ErrorCategory;
  message: string;
  detail?: unknown;
}

const NETWORK_HINT = ['request:fail', 'cloud has not been', 'cloud has no permission', 'timeout', 'ETIMEDOUT', 'ENOTFOUND'];
const AUTH_HINT = ['login', 'auth', '无权限', 'FORBIDDEN', 'UNAUTHORIZED', 'openid'];
const CONFIG_HINT = ['未配置', 'NOT_CONFIGURED', 'CODING_PLAN'];

function classify(message: string): ErrorCategory {
  const m = String(message || '');
  if (NETWORK_HINT.some((k) => m.indexOf(k) !== -1)) return 'network';
  if (CONFIG_HINT.some((k) => m.indexOf(k) !== -1)) return 'config';
  if (AUTH_HINT.some((k) => m.indexOf(k) !== -1)) return 'auth';
  return 'business';
}

export function toAppError(err: unknown, fallback = '操作失败，请稍后重试'): AppError {
  const detail = err;
  let message = fallback;
  let code = 'UNKNOWN';
  if (err && typeof err === 'object') {
    const e = err as { errMsg?: unknown; message?: unknown; code?: unknown };
    // 严格守卫 typeof string，避免 [object Object] 漏出
    if (typeof e.message === 'string' && e.message) {
      message = e.message;
    } else if (typeof e.errMsg === 'string' && e.errMsg) {
      message = e.errMsg;
    }
    if (typeof e.code === 'string' || typeof e.code === 'number') {
      code = String(e.code);
    }
  }
  return {
    code,
    category: classify(message),
    message,
    detail,
  };
}

function sliceTitle(title: string, max = 7): string {
  // 微信 toast title 限制 7 个汉字（或约 14 个字符），超出截断
  const chars = Array.from(String(title || ''));
  return chars.slice(0, max).join('');
}

function defaultMessage(category: ErrorCategory): string {
  switch (category) {
    case 'network':
      return '网络异常，请稍后再试';
    case 'auth':
      return '登录状态失效，请重新进入';
    case 'config':
      return '服务暂未配置，请联系管理员';
    default:
      return '操作失败，请稍后重试';
  }
}

export function showError(err: unknown, fallback?: string): void {
  const appErr = toAppError(err, fallback);
  const message = appErr.message === 'unknown' || appErr.message === '操作失败，请稍后重试'
    ? defaultMessage(appErr.category)
    : appErr.message;
  wx.showToast({
    title: sliceTitle(message),
    icon: 'none',
    duration: 2200,
  });
}

export function showInfo(title: string, duration = 1500): void {
  wx.showToast({ title: sliceTitle(title), icon: 'none', duration });
}

export function showSuccess(title: string, duration = 1500): void {
  wx.showToast({ title: sliceTitle(title), icon: 'success', duration });
}

export function showWarn(title: string, duration = 1800): void {
  wx.showToast({ title: sliceTitle(title), icon: 'none', duration });
}

/**
 * 业务报错展示：短文案（≤7 字）走 toast；
 * 长文案（如「预约时间须在 08:00-22:00 开放时段内」）走弹窗，
 * 避免 toast 截断导致用户看不到完整原因。
 */
export function showBusinessError(err: unknown, fallback?: string): void {
  const appErr = toAppError(err, fallback);
  const message = appErr.message === 'unknown' || appErr.message === '操作失败，请稍后重试'
    ? defaultMessage(appErr.category)
    : appErr.message;
  if (Array.from(message).length > 7) {
    wx.showModal({ title: '提示', content: message, showCancel: false, confirmText: '知道了' });
    return;
  }
  wx.showToast({ title: message, icon: 'none', duration: 2200 });
}