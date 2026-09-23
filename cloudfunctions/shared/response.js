function ok(data, message = '操作成功', requestId) {
  return {
    success: true,
    data,
    message,
    request_id: requestId || `req_${Date.now()}`,
  }
}

function fail(message, data = null, requestId) {
  return {
    success: false,
    data,
    message,
    request_id: requestId || `req_${Date.now()}`,
  }
}

module.exports = { ok, fail }
