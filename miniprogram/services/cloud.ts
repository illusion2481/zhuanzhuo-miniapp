/** 云函数调用封装 */

export interface CloudResult<T = unknown> {
  success: boolean;
  data: T;
  message: string;
  /** 云函数返回的业务错误码（如 NEED_CHECKIN_CODE / SEAT_CONFLICT） */
  code?: string;
  request_id?: string;
}

/** 把任意错误规范化为带字符串 message 的 Error 实例（避免 [object Object] 漏出） */
function normalizeError(err: unknown, fallback: string): Error {
  if (err instanceof Error && typeof err.message === 'string' && err.message) {
    return err;
  }
  const e = err as { errMsg?: unknown; message?: unknown } | null | undefined;
  const raw = (typeof e?.errMsg === 'string' && e.errMsg)
    || (typeof e?.message === 'string' && e.message)
    || fallback;
  return new Error(raw);
}

export async function callCloud<T = unknown>(
  name: string,
  data: Record<string, unknown> = {},
): Promise<CloudResult<T>> {
  let res: { result?: unknown };
  try {
    res = await wx.cloud.callFunction({ name, data });
  } catch (err) {
    // 统一将 wx.cloud.callFunction 抛出的错误（通常是 {errMsg, ...}）包装为标准 Error
    throw normalizeError(err, `云函数 ${name} 调用失败`);
  }
  const result = ((res && res.result) || {}) as CloudResult<T>;
  if (typeof (result as { success?: unknown }).success === 'undefined') {
    return {
      success: true,
      data: result as unknown as T,
      message: 'ok',
    };
  }
  // 云函数返回 {success:false, message} 时,message 也兜底为字符串
  if (typeof result.message !== 'string') {
    return { ...result, message: '' };
  }
  return result;
}
