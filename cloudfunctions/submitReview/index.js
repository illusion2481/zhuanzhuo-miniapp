const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { validateEvent } = require('./shared/validator')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

/** 入参白名单（F7） */
const SCHEMA = {
  record_id: { type: 'string', max: 128 },
  /** 1~5 星（validator 对 number 的 min/max 是收敛而非拒绝） */
  rating: { type: 'number', min: 1, max: 5 },
  /** 文字评价：最多 200 字，过 msgSecCheck */
  content: { type: 'string', max: 200, optional: true },
}

function ok(data, message = '操作成功') {
  return { success: true, data, message, request_id: 'req_' + Date.now() }
}

function fail(message, data = null, code = 'ERROR') {
  return { success: false, data, code, message, request_id: 'req_' + Date.now() }
}

function hashOpenId(openId) {
  return crypto.createHash('sha256').update(openId).digest('hex').slice(0, 32)
}

/**
 * 可评价口径（与前端 myReservations 的 canReview 必须同值，改一处必须改两处）：
 * ① status === 'completed'
 * ② status === 'active' 但 end_at 已过 —— 视为「已结束」。
 *    兜底原因：只有 expireRecords 定时器会把超时记录翻成 completed，
 *    该定时器一旦没部署，用户将永远等不到「已完成」，评价功能形同废掉。
 */
function isReviewable(record) {
  if (record.status === 'completed') return true
  if (record.status !== 'active') return false
  const end = record.end_at ? new Date(record.end_at).getTime() : 0
  return end > 0 && end <= Date.now()
}

/**
 * 落库 reviews 集合，带三级自愈：
 * ① add（自定义 _id 天然去重）
 * ② doc().set()（_id 冲突时覆盖写）
 * ③ 集合不存在 → db.createCollection 建集合后重试
 * 控制台没手动建 reviews 集合时，add 会直接抛错，用户看到的就是「评价提交失败」。
 * 返回 null 表示成功，否则返回最后的错误信息。
 */
async function saveReview(review) {
  const id = 'rev_' + review.record_id
  let last = ''
  const attempts = [
    () => db.collection('reviews').add({ data: { _id: id, ...review } }),
    () => db.collection('reviews').doc(id).set({ data: review }),
  ]
  for (const run of attempts) {
    try {
      await run()
      return null
    } catch (e) {
      last = String((e && e.message) || e)
    }
  }
  if (typeof db.createCollection === 'function') {
    try {
      await db.createCollection('reviews')
      await db.collection('reviews').add({ data: { _id: id, ...review } })
      return null
    } catch (e) {
      last = String((e && e.message) || e)
    }
  }
  return last || '写入失败'
}

/**
 * 内容安全检测（UGC 护栏），与 login.checkSafeNick 同风格。
 * 运行环境不支持 / 未开通权限时返回 null 放行，不阻断评价。
 */
async function checkSafeText(text) {
  const s = String(text || '').trim()
  if (!s) return null
  const api = cloud.openapi && cloud.openapi.security && cloud.openapi.security.msgSecCheck
  if (typeof api !== 'function') return null
  try {
    const res = await api({ content: s.slice(0, 1000) })
    const risky =
      (res && res.result && res.result.suggest === 'risky') ||
      (res && res.errCode === 87014)
    return risky ? '评价包含敏感内容，请修改后重试' : null
  } catch (e) {
    console.warn('[submitReview] msgSecCheck skip:', (e && e.message) || e)
    return null
  }
}

exports.main = async (event, context) => {
  try {
    const check = validateEvent(event, SCHEMA)
    if (!check.ok) return fail(check.error)
    const { record_id, rating, content } = check.value

    const openId = cloud.getWXContext().OPENID
    if (!openId) return fail('无法获取用户身份，请重新登录')
    const userId = hashOpenId(openId)

    // 1. 仅本人已完成（derived）的预约可评价
    const found = await db.collection('records').doc(record_id).get()
    const record = found && found.data ? found.data : null
    if (!record || record.user_id !== userId) return fail('无权评价该预约')
    if (record.record_type !== 'reservation') return fail('该记录不是预约')
    if (!isReviewable(record)) return fail('仅「已完成」的预约可评价（待签到 / 使用中暂不可评）')

    // 2. UGC 护栏：文案过检后入库
    const safeIssue = await checkSafeText(content)
    if (safeIssue) return fail(safeIssue, null, 'CONTENT_RISKY')

    // 3. 一单一评（幂等）：先查是否已评价过该预约，已评则直接成功返回
    //    文档 _id 用独立前缀 rev_<record_id>，避免与 records 集合文档冲突（测试 mock 共用 store）
    const now = new Date().toISOString()
    const review = {
      record_id,
      user_id: userId,
      room_id: record.room_id || '',
      seat_id: record.seat_id || '',
      rating: Math.max(1, Math.min(5, Number(rating))),
      content: content || '',
      created_at: now,
      updated_at: now,
    }
    const existing = await db
      .collection('reviews')
      .where({ record_id })
      .limit(1)
      .get()
      .catch(() => ({ data: [] }))
    if (existing.data && existing.data.length) {
      // 已评过：幂等返回（不覆盖，避免重复计分）
      return ok({ record_id, rating: review.rating, already: true }, '已评价过')
    }
    // 未评过：以 rev_<record_id> 为 _id 落库（唯一键天然去重）
    const writeErr = await saveReview(review)
    if (writeErr) {
      // 别把裸数据库错误丢给前端（toast 只显示 7 个字会变成天书），给可执行提示
      return fail('评价保存失败，请确认云开发控制台已创建 reviews 集合', null, 'DB_WRITE_FAILED')
    }
    return ok({ record_id, rating: review.rating }, '评价成功')
  } catch (err) {
    return fail((err && err.message) || '云函数执行失败')
  }
}

/** 供本地测试使用 */
exports.__test = { checkSafeText }