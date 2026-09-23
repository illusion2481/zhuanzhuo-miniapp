const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { validateEvent } = require('./shared/validator')
const { bumpPresenceVersion } = require('./shared/presence')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const LEAVE_TIMEOUT_MINUTES = 30

/** 入参白名单（F7） */
const SCHEMA = {
  action: { type: 'enum', values: ['leave', 'return'] },
  record_id: { type: 'string', max: 128 },
}

function getUserId() {
  const openId = cloud.getWXContext().OPENID
  if (!openId) return null
  return crypto.createHash('sha256').update(openId).digest('hex').slice(0, 32)
}

function ok(data, message = '操作成功') {
  return { success: true, data, message, request_id: 'req_' + Date.now() }
}

function fail(message, data = null) {
  return { success: false, data, message, request_id: 'req_' + Date.now() }
}

async function fetchReservation(recordId) {
  if (!recordId) return null
  try {
    const found = await db.collection('records').doc(recordId).get()
    return found.data || null
  } catch (e) {
    return null
  }
}

exports.main = async (event) => {
  try {
    const check = validateEvent(event, SCHEMA)
    if (!check.ok) return fail(check.error)
    const action = check.value.action
    const recordId = check.value.record_id
    const userId = getUserId()
    if (!userId) return fail('无法获取用户身份，请重新登录')

    const record = await fetchReservation(recordId)
    if (!record) return fail('预约记录不存在')
    if (record.user_id !== userId) return fail('无权操作该预约')
    // 仅预约类型记录可暂离
    if (record.record_type !== 'reservation') return fail('该记录不支持暂离')
    if (record.status !== 'active' && record.status !== 'paused') return fail('当前状态不可暂离/返回')

    const now = new Date().toISOString()
    const payload = record.payload || {}

    if (action === 'leave') {
      // active -> paused
      if (record.status !== 'active') return fail('当前不在使用中，无法暂离')
      const newPayload = {
        ...payload,
        leave_at: now,
        return_at: null,
        leave_count: (payload.leave_count || 0) + 1,
      }
      await db.collection('records').doc(recordId).update({
        data: { status: 'paused', payload: newPayload, updated_at: now },
      })
      await bumpPresenceVersion(record.room_id)
      return ok({ ...record, status: 'paused', payload: newPayload, updated_at: now }, '已暂离座位')
    }

    if (action === 'return') {
      // paused -> active
      if (record.status !== 'paused') return fail('当前未处于暂停状态')
      const newPayload = { ...payload, return_at: now }
      await db.collection('records').doc(recordId).update({
        data: { status: 'active', payload: newPayload, updated_at: now },
      })
      await bumpPresenceVersion(record.room_id)
      return ok({ ...record, status: 'active', payload: newPayload, updated_at: now }, '已返回座位')
    }

    return fail(`未知操作：${action}`)
  } catch (err) {
    return fail((err && err.message) || '云函数执行失败')
  }
}