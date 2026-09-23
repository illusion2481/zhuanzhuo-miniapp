const cloud = require('wx-server-sdk')
const { fetchAllPaged } = require('./shared/db')
const { validateEvent } = require('./shared/validator')
const { bumpPresenceVersion } = require('./shared/presence')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const PENDING_GRACE_MINUTES = 15
const LEAVE_TIMEOUT_MINUTES = 30
const REMIND_BEFORE_MINUTES = 30
const PAGE_SIZE = 100
const MAX_PAGES = 100
const UPDATE_CHUNK = 20

/**
 * 爽约 / 违规惩罚梯度（按累计违规次数递增，单位：分钟）
 *   第 1 次 → 30 分钟
 *   第 2 次 → 2 小时
 *   第 3 次及以上 → 24 小时
 * 管理员可在管理后台「用户与信用」里一键解除禁约、清零违规次数。
 */
function banMinutesFor(count) {
  if (count <= 1) return 30
  if (count === 2) return 120
  return 1440
}

/** 把禁约截止时间转成「X分钟 / X小时 / X天」文案（基于实际生效时长，含历史更长禁约） */
function banTextFor(bannedUntilIso) {
  const ms = Date.parse(bannedUntilIso) - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${minutes}分钟`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}小时`
  return `${Math.round(hours / 24)}天`
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

/**
 * 分批串行更新（F8）：每批 UPDATE_CHUNK 条并发，
 * 避免超限时触发云数据库并发写上限；批间串行保证可控。
 */
async function applyUpdates(items, buildPatch) {
  for (let i = 0; i < items.length; i += UPDATE_CHUNK) {
    const chunk = items.slice(i, i + UPDATE_CHUNK)
    await Promise.all(
      chunk.map((item) =>
        db.collection('records').doc(item._id).update({ data: buildPatch(item) }),
      ),
    )
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
 * 后端定时推送：经 notify 云函数发给具体用户。定时器无用户态，必须显式传 openid
 * （来自 createReservation 落库的 record.payload.openid）。
 * 任何异常一律静默吞掉，绝不阻断 expireRecords 的超时主流程。
 */
async function pushNotify(type, openid, main, timeIso, extra, recordId) {
  if (!openid) return
  if (typeof cloud.callFunction !== 'function') return
  try {
    await cloud.callFunction({
      name: 'notify',
      data: {
        action: 'send',
        type,
        openid,
        page: `pages/reservation/reservation?id=${recordId}`,
        main: main || '专注座自习室',
        time: formatBeijing(timeIso),
        extra: extra || '',
      },
    })
  } catch (e) {
    console.warn('[notify] push failed:', type, recordId, (e && e.message) || e)
  }
}

/** 对一批 no_show 记录发「超时/违约预警」（模板 ③ reservationWarn）；banByUser 提供禁约时长文案 */
async function notifyNoShows(items, violationType, banByUser) {
  for (const item of items) {
    if (!item || !item._id) continue
    const openid = item.payload && item.payload.openid
    const roomName = (item.payload && item.payload.room_name) || '专注座自习室'
    let extra =
      violationType === 'leave_timeout' ? '暂离超时，座位已释放' : '未签到已记为爽约'
    const ban = banByUser && banByUser[item.user_id]
    if (ban) {
      const txt = banTextFor(ban.bannedUntil)
      if (txt) extra += `，已禁约${txt}`
    }
    await pushNotify('reservationWarn', openid, roomName, item.start_at, extra, item._id)
  }
}

exports.main = async (event) => {
  try {
    // 定时任务无入参；空 schema 即白名单校验（剥离一切未知字段）
    const check = validateEvent(event, {})
    if (!check.ok) return fail(check.error)

    const now = new Date().toISOString()
    // pending_checkin 超时（宽限 15 分钟）→ no_show
    const cutoff = new Date(Date.now() - PENDING_GRACE_MINUTES * 60 * 1000).toISOString()
    // paused 暂离超时（30 分钟）→ no_show（释放座位并计违约，见下方 applyUpdates）
    const leaveCutoff = new Date(Date.now() - LEAVE_TIMEOUT_MINUTES * 60 * 1000).toISOString()

    // —— ② 签到提醒（复用本 5 分钟定时器）—— 预约开始前 30 分钟内、且未提醒过的待签到记录
    //    openid 来自 createReservation 落库的 record.payload.openid（定时器无用户态）
    const remindEnd = new Date(Date.now() + REMIND_BEFORE_MINUTES * 60 * 1000).toISOString()
    const futurePending = await fetchAllPaged(
      'records',
      { record_type: 'reservation', status: 'pending_checkin', start_at: _.gte(now) },
      { pageSize: PAGE_SIZE, maxPages: MAX_PAGES },
    )
    const toRemind = futurePending.filter(
      (r) => r.start_at <= remindEnd && !(r.payload && r.payload.checkin_reminded),
    )
    for (const r of toRemind) {
      const openid = r.payload && r.payload.openid
      const roomName = (r.payload && r.payload.room_name) || '专注座自习室'
      await pushNotify('checkinReminder', openid, roomName, r.start_at, '请凭店内签到码到店签到', r._id)
      await db
        .collection('records')
        .doc(r._id)
        .update({ data: { 'payload.checkin_reminded': true, updated_at: now } })
        .catch(() => {})
    }

    // 循环分页拉全量（F5），避免 limit 截断导致漏处理
    const pending = await fetchAllPaged(
      'records',
      { record_type: 'reservation', status: 'pending_checkin', start_at: _.lt(cutoff) },
      { pageSize: PAGE_SIZE, maxPages: MAX_PAGES },
    )
    const completed = await fetchAllPaged(
      'records',
      { record_type: 'reservation', status: 'active', end_at: _.lt(now) },
      { pageSize: PAGE_SIZE, maxPages: MAX_PAGES },
    )
    const pausedExpired = await fetchAllPaged(
      'records',
      { record_type: 'reservation', status: 'paused', updated_at: _.lt(leaveCutoff) },
      { pageSize: PAGE_SIZE, maxPages: MAX_PAGES },
    )

    await applyUpdates(pending, (item) => ({
      status: 'no_show',
      updated_at: now,
      'payload.violation_type': 'pending_timeout',
      'payload.violation_at': now,
      'payload.violation_note': `预约开始 ${PENDING_GRACE_MINUTES} 分钟内未签到`,
    }))
    await applyUpdates(completed, () => ({ status: 'completed', updated_at: now }))
    // 暂离超时 → 视同违约：释放座位（不再保留占用）并计入违规次数
    await applyUpdates(pausedExpired, (item) => ({
      status: 'no_show',
      updated_at: now,
      'payload.violation_type': 'leave_timeout',
      'payload.violation_at': now,
      'payload.leave_count': (item.payload && item.payload.leave_count) || 0,
      'payload.violation_note': `暂离超过 ${LEAVE_TIMEOUT_MINUTES} 分钟未返回，座位已释放`,
    }))

    // 实时信号：本轮翻转涉及的所有房间统一 bump，通知前端 watch 重拉占用
    const affectedRooms = Array.from(
      new Set(
        pending
          .concat(completed)
          .concat(pausedExpired)
          .map((item) => item.room_id)
          .filter(Boolean),
      ),
    )
    await Promise.all(affectedRooms.map((roomId) => bumpPresenceVersion(roomId)))

    // 违规惩罚预计算（先算后发，便于把禁约时长带进 ③ 预警文案，且避免重复读库）
    const violators = pending.concat(pausedExpired)
    const banByUser = {}
    if (violators.length) {
      const userIds = Array.from(new Set(violators.map((v) => v.user_id).filter(Boolean)))
      for (const uid of userIds) {
        const times = violators.filter((v) => v.user_id === uid).length
        const doc = await db.collection('users').doc(uid).get().catch(() => null)
        if (!doc || !doc.data) continue
        const prev = doc.data || {}
        const nextCount = (typeof prev.no_show_count === 'number' ? prev.no_show_count : 0) + times
        const banMs = banMinutesFor(nextCount) * 60 * 1000
        const newBan = new Date(Date.now() + banMs).toISOString()
        // 已有更晚的禁约则不缩短
        const prevBanMs = prev.banned_until ? Date.parse(prev.banned_until) : 0
        const bannedUntil = Number.isFinite(prevBanMs) && prevBanMs > Date.now() + banMs ? prev.banned_until : newBan
        banByUser[uid] = { nextCount, bannedUntil }
      }
    }

    // ③ 超时/违约预警推送：带禁约时长，让用户知道被禁多久（已禁约X分钟/小时/天）
    await notifyNoShows(pending, 'pending_timeout', banByUser)
    await notifyNoShows(pausedExpired, 'leave_timeout', banByUser)

    // 落地违规计数与禁约（用上面预计算的 banByUser，不再重复读库）
    let penalizedCount = 0
    for (const uid of Object.keys(banByUser)) {
      const { nextCount, bannedUntil } = banByUser[uid]
      await db
        .collection('users')
        .doc(uid)
        .update({ data: { no_show_count: nextCount, banned_until: bannedUntil, updated_at: now } })
        .catch(() => {})
      penalizedCount += 1
    }

    return ok(
      {
        no_show: pending.length,
        completed: completed.length,
        leave_released: pausedExpired.length,
        reminded: toRemind.length,
        penalized_users: penalizedCount,
        processed_total: pending.length + completed.length + pausedExpired.length,
      },
      '超时记录处理完成',
    )
  } catch (err) {
    return fail((err && err.message) || '云函数执行失败')
  }
}
