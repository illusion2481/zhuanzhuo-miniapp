const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { validateEvent } = require('./shared/validator')
const { bumpPresenceVersion } = require('./shared/presence')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

/** 入参白名单（F7） */
const SCHEMA = {
  record_id: { type: 'string', max: 128 },
}

function ok(data, message = '操作成功') {
  return {
    success: true,
    data,
    message,
    request_id: 'req_' + Date.now(),
  }
}

function fail(message, data = null) {
  return {
    success: false,
    data,
    message,
    request_id: 'req_' + Date.now(),
  }
}

/** 北京时间格式化：2026年9月16日 16:28（订阅消息时间型关键词要求 24 小时制） */
function formatBeijing(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const bj = new Date(d.getTime() + 8 * 3600 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${bj.getUTCFullYear()}年${bj.getUTCMonth() + 1}月${bj.getUTCDate()}日 ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`
}

/**
 * 取消/爽约通知（模板 ④ reservationCancel）。cancelReservation 由用户主动调用，
 * 此时带登录态，openid 直接取自上下文，无需像定时器那样从 payload 读取。
 * 异常静默吞掉，不影响取消主流程。
 */
async function pushCancelNotify(openId, record) {
  if (!openId || !record) return
  if (typeof cloud.callFunction !== 'function') return
  try {
    const roomName = (record.payload && record.payload.room_name) || '专注座自习室'
    await cloud.callFunction({
      name: 'notify',
      data: {
        action: 'send',
        type: 'reservationCancel',
        openid: openId,
        page: `pages/reservation/reservation?id=${record._id}`,
        main: roomName,
        time: formatBeijing(record.start_at),
        extra: '已为您取消预约',
      },
    })
  } catch (e) {
    console.warn('[notify] cancel push failed:', record && record._id, (e && e.message) || e)
  }
}

/**
 * 履约记账：签退（status → completed）才 +1，中途取消不计。
 *
 * 与「累计签到」区分开——签到只证明人来了，签退才证明完整用完了这一单，
 * 行业（学习通/高校图书馆）把「退座」记为**履约成功一次**。
 *
 * 幂等：重复签退会被主流程的状态守卫拦下（completed 不在可取消列表里），
 * 因此不存在同一单重复计数。失败只影响展示，绝不阻断签退本身。
 *
 * @returns {Promise<number>} 记账后的累计履约次数
 */
async function recordFulfillment(userId, nowIso) {
  let doc = null
  try {
    const found = await db.collection('users').doc(userId).get()
    doc = found && found.data ? found.data : null
  } catch (e) {
    doc = null
  }
  const prev = doc && typeof doc.total_checkout === 'number' ? doc.total_checkout : 0
  const next = prev + 1
  const patch = { total_checkout: next, updated_at: nowIso }
  if (doc) {
    await db.collection('users').doc(userId).update({ data: patch })
  } else {
    // 档案缺失（清库 / 老数据）：顺手建一份，避免履约数永远记不上
    await db
      .collection('users')
      .add({ data: { _id: userId, open_id_hash: userId, role: 'student', created_at: nowIso, ...patch } })
  }
  return next
}

exports.main = async (event, context) => {
  try {
    const check = validateEvent(event, SCHEMA)
    if (!check.ok) return fail(check.error)
    const recordId = check.value.record_id
    const openId = cloud.getWXContext().OPENID
    if (!openId) return fail('无法获取用户身份，请重新登录')
    const userId = crypto.createHash('sha256').update(openId).digest('hex').slice(0, 32)
    const found = await db.collection('records').doc(recordId).get()
    const record = found.data
    if (!record || record.user_id !== userId) return fail('无权取消该预约')
    // 暂离中(paused)同样允许结束，结束后座位立即释放
    if (!['pending_checkin', 'active', 'paused'].includes(record.status)) return fail('当前预约状态不可取消')
    // 状态语义：未到使用时间/未签到就取消 → cancelled（已取消）；
    // 已签到使用过（active/paused）提前结束 → completed（已完成），
    // 避免「约 2 小时用了 1 小时提前走」被记成取消。
    const isUsed = record.status === 'active' || record.status === 'paused'
    const nextStatus = isUsed ? 'completed' : 'cancelled'
    const updated_at = new Date().toISOString()
    await db.collection('records').doc(recordId).update({ data: { status: nextStatus, updated_at } })
    // 实时信号：取消/结束使用 → 座位释放，通知前端 watch 立即重拉
    await bumpPresenceVersion(record.room_id)
    // 用户主动取消（未开始使用）→ 推送「预约取消通知」；已使用提前结束不发（避免骚扰）
    if (nextStatus === 'cancelled') {
      await pushCancelNotify(openId, { ...record, _id: recordId, start_at: record.start_at, payload: record.payload })
    }
    // 签退 = 履约一次（取消不计）。失败只记日志，不影响签退结果。
    let totalCheckout = 0
    if (nextStatus === 'completed') {
      try {
        totalCheckout = await recordFulfillment(userId, updated_at)
      } catch (e) {
        console.warn('[cancelReservation] fulfillment skip:', (e && e.message) || e)
      }
    }
    return ok(
      { ...record, status: nextStatus, updated_at, total_checkout: totalCheckout },
      isUsed ? '已签退，履约 +1' : '预约已取消',
    )
  } catch (err) {
    return fail((err && err.message) || '云函数执行失败')
  }
}
