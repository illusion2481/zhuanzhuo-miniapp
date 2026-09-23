/** 云函数统一返回格式 */

export function ok<T>(data: T, message = '操作成功', requestId?: string) {
  return {
    success: true as const,
    data,
    message,
    request_id: requestId || `req_${Date.now()}`,
  };
}

export function fail(message: string, data: unknown = null, requestId?: string) {
  return {
    success: false as const,
    data,
    message,
    request_id: requestId || `req_${Date.now()}`,
  };
}
