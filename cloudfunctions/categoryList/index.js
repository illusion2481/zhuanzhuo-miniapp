const cloud = require('wx-server-sdk')
const { validateEvent } = require('./shared/validator')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

function ok(data, message) {
  return {
    success: true,
    data,
    message: message || '操作成功',
    request_id: 'req_' + Date.now(),
  }
}

function fail(message, data) {
  return {
    success: false,
    data: data || null,
    message,
    request_id: 'req_' + Date.now(),
  }
}

const ALLOWED_TYPES = ['room', 'seat_feature', 'study_goal', 'feedback_tag']

/** 入参白名单（F7） */
const SCHEMA = {
  type: { type: 'string', values: ALLOWED_TYPES, optional: true },
  status: { type: 'string', max: 16, optional: true },
  includeDisabled: { type: 'boolean', optional: true },
}

/**
 * 分类查询
 * event.type 可选；event.status 默认 active；event.includeDisabled 为 true 时不过滤 status
 */
exports.main = async (event = {}) => {
  try {
    const check = validateEvent(event, SCHEMA)
    if (!check.ok) return fail(check.error)
    const type = check.value.type

    const includeDisabled = !!check.value.includeDisabled
    const status = check.value.status || 'active'

    const where = {}
    if (type) where.type = type
    if (!includeDisabled) where.status = status

    const MAX = 100
    let query = db.collection('categories').where(where)
    // 云数据库 orderBy 需配合索引；失败时回退内存排序
    let list = []
    try {
      const res = await query.orderBy('sort', 'asc').limit(MAX).get()
      list = res.data || []
    } catch (e) {
      const res = await db.collection('categories').where(where).limit(MAX).get()
      list = (res.data || []).sort((a, b) => (a.sort || 0) - (b.sort || 0))
    }

    return ok(list, '查询成功')
  } catch (err) {
    console.error('[categoryList]', err)
    return fail((err && err.message) || '分类查询失败')
  }
}
