const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { validateEvent } = require('./shared/validator')
const { bumpPresenceVersion } = require('./shared/presence')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

/** 入参白名单（F7） */
const SCHEMA = {
  record_id: { type: 'string', max: 128 },
  start_at: { type: 'string', isoDate: true, optional: true },
  end_at: { type: 'string', isoDate: true, optional: true },
  goal: { type: 'string', max: 200, optional: true },
  /** 一键续时：仅 active/paused 可用，end_at 顺延该分钟数（start_at 不变） */
  extend_minutes: { type: 'number', min: 15, max: 240, optional: true },
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
    data: data || null,
    message,
    request_id: 'req_' + Date.now(),
  }
}

/** 取北京时间（UTC+8）的日期与时间，避免依赖运行环境时区 */
function beijingParts(iso) {
  const d = new Date(iso)
  const bj = new Date(d.getTime() + 8 * 3600 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return {
    date: `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())}`,
    time: `${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`,
  }
}

function toMin(t) {
  const [h, m] = String(t || '00:00').split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/** 单次预约最短时长（分钟）：剩余开放时间不足则拒绝放号 */
const MIN_BOOKING_MINUTES = 15

/** 当天第几分钟 → 'HH:mm' */
function minToHHmm(min) {
  const v = Math.max(0, Math.min(1439, Math.round(min)))
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(Math.floor(v / 60))}:${pad(v % 60)}`
}

/** 北京日期 + 'HH:mm' → ISO（北京恒为 UTC+8，无夏令时） */
function beijingToIso(date, time) {
  return new Date(`${date}T${time}:00+08:00`).toISOString()
}

/**
 * 把改约时段夹（clamp）到房间开放时段内 —— 能约多久就算多久。
 * ⚠️ 与 `cloudfunctions/createReservation.clampToOpenWindow` 及前端
 *    `miniprogram/utils/bookingWindow.ts` 逐条对齐，改一处必须同步另两处。
 */
function clampToOpenWindow(startIso, endIso, openTime, closeTime) {
  if (!openTime || !closeTime) {
    return { ok: true, start_at: startIso, end_at: endIso, clamped: false }
  }
  const openMin = toMin(openTime)
  const closeMin = toMin(closeTime)

  // 跨夜营业：时段天然跨两个自然日，只拦截落在闭馆区间的部分
  if (openMin > closeMin) {
    const s = beijingParts(startIso)
    const e = beijingParts(endIso)
    const inGap = (x) => x > closeMin && x < openMin
    if (inGap(toMin(s.time)) || inGap(toMin(e.time))) {
      return {
        ok: false,
        code: 'ROOM_CLOSED',
        message: `预约时间须在开放时段内（本自习室 ${openTime}-${closeTime} 次日）`,
      }
    }
    return { ok: true, start_at: startIso, end_at: endIso, clamped: false }
  }

  const s = beijingParts(startIso)
  const e = beijingParts(endIso)
  const askedMin = Math.max(
    MIN_BOOKING_MINUTES,
    Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000) || MIN_BOOKING_MINUTES,
  )
  let sMin = toMin(s.time)
  let clamped = false

  if (sMin < openMin) {
    sMin = openMin
    clamped = true
  }
  if (sMin >= closeMin) {
    return {
      ok: false,
      code: 'ROOM_CLOSED',
      message: `所选开始时间 ${s.time} 已超出本自习室开放时段（${openTime}-${closeTime}），请选择明天 ${openTime} 之后再预约`,
    }
  }

  let eMin = toMin(e.time)
  if (e.date !== s.date) eMin += 1440
  if (eMin - sMin < MIN_BOOKING_MINUTES) eMin = sMin + askedMin
  if (eMin > closeMin) {
    eMin = closeMin
    clamped = true
  }

  const durationMin = eMin - sMin
  if (durationMin < MIN_BOOKING_MINUTES) {
    return {
      ok: false,
      code: 'WINDOW_TOO_SHORT',
      message: `距打烊时间（${closeTime}）仅剩 ${Math.max(0, durationMin)} 分钟，不足 ${MIN_BOOKING_MINUTES} 分钟，请选择明天再预约`,
    }
  }

  const newStart = beijingToIso(s.date, minToHHmm(sMin))
  const newEnd = beijingToIso(s.date, minToHHmm(eMin))
  return {
    ok: true,
    start_at: newStart,
    end_at: newEnd,
    clamped: clamped || newStart !== startIso || newEnd !== endIso,
  }
}

exports.main = async (event, context) => {
  try {
    const check = validateEvent(event, SCHEMA)
    if (!check.ok) return fail(check.error)
    const { record_id, start_at: reqStart, end_at: reqEnd, goal, extend_minutes } = check.value

    const openId = cloud.getWXContext().OPENID
    if (!openId) return fail('无法获取用户身份，请重新登录')
    const userId = crypto.createHash('sha256').update(openId).digest('hex').slice(0, 32)

    // 1. 仅本人、且当前为待签到的预约可改约
    const found = await db.collection('records').doc(record_id).get()
    const record = found.data
    if (!record || record.user_id !== userId) return fail('无权操作该预约')
    if (record.record_type !== 'reservation') return fail('该记录不是预约')

    // ── 一键续时（active/paused）：只顺延 end_at，start_at 不动 ──
    if (extend_minutes != null) {
      if (record.status !== 'active' && record.status !== 'paused') {
        return fail('仅使用中或暂离中的预约可续时')
      }
      if (reqStart || reqEnd) return fail('续时不可同时指定开始/结束时间')
      const oldEndMs = record.end_at ? new Date(record.end_at).getTime() : 0
      if (!oldEndMs) return fail('原预约缺少结束时间，无法续时')
      const oldStartIso = record.start_at
      const requested = new Date(oldEndMs + extend_minutes * 60 * 1000).toISOString()

      // 房间开放时段：续时同样夹到打烊（不改 start_at）
      const roomDoc = await db.collection('categories').doc(record.room_id).get().catch(() => null)
      const roomMeta2 = roomDoc && roomDoc.data ? roomDoc.data.metadata || {} : {}
      const win2 = clampToOpenWindow(record.start_at, requested, roomMeta2.open_time, roomMeta2.close_time)
      if (!win2.ok) return fail(win2.message, { code: win2.code })
      const newEndIso = win2.end_at
      if (new Date(newEndIso).getTime() <= oldEndMs) {
        return fail('距打烊不足续时时长，无法续时', { code: 'ROOM_CLOSED' })
      }

      // 冲突重校验（排除自身）：续时后的时段不能撞上他人预约
      const conflict = await db
        .collection('records')
        .where({
          room_id: record.room_id,
          seat_id: record.seat_id,
          record_type: 'reservation',
          status: _.in(['pending_checkin', 'active', 'paused']),
          _id: _.neq(record_id),
          start_at: _.lt(newEndIso),
          end_at: _.gt(oldStartIso),
        })
        .limit(1)
        .get()
      if (conflict.data.length) return fail('该时段被他人预约，无法续时', { code: 'SEAT_CONFLICT' })

      const nowExt = new Date().toISOString()
      const payloadExt = Object.assign({}, record.payload || {}, {
        goal: String(goal || (record.payload && record.payload.goal) || ''),
        extended: true,
      })
      await db.collection('records').doc(record_id).update({
        data: { end_at: newEndIso, payload: payloadExt, updated_at: nowExt },
      })
      // 续时改变座位释放 → bump presence 让前端立即刷新
      await bumpPresenceVersion(record.room_id)
      return ok(
        { _id: record_id, ...record, end_at: newEndIso, payload: payloadExt, updated_at: nowExt },
        '续时成功',
      )
    }

    if (!reqStart || !reqEnd) return fail('改约需提供开始与结束时间')
    if (new Date(reqStart) >= new Date(reqEnd)) return fail('预约时间或座位参数无效')
    if (record.status !== 'pending_checkin') return fail('仅「待签到」预约可改约')

    // 1.5 房间开放时段：改约后同样**夹到开放时段内**（能约多久算多久），而不是直接拒绝
    const roomDoc = await db.collection('categories').doc(record.room_id).get().catch(() => null)
    const roomMeta = roomDoc && roomDoc.data ? roomDoc.data.metadata || {} : {}
    const win = clampToOpenWindow(reqStart, reqEnd, roomMeta.open_time, roomMeta.close_time)
    if (!win.ok) return fail(win.message, { code: win.code })
    // 后续冲突校验与落库统一使用「夹过的」时段
    const start_at = win.start_at
    const end_at = win.end_at

    // 2. 时段冲突重校验（排除自身）
    const conflict = await db
      .collection('records')
      .where({
        room_id: record.room_id,
        seat_id: record.seat_id,
        record_type: 'reservation',
        status: _.in(['pending_checkin', 'active', 'paused']),
        _id: _.neq(record_id),
        start_at: _.lt(end_at),
        end_at: _.gt(start_at),
      })
      .limit(1)
      .get()
    if (conflict.data.length) return fail('该时段座位已被预约', { code: 'SEAT_CONFLICT' })

    const now = new Date().toISOString()
    const payload = Object.assign({}, record.payload || {}, { goal: goal || (record.payload && record.payload.goal) || '' })
    await db.collection('records').doc(record_id).update({
      data: {
        start_at,
        end_at,
        payload,
        updated_at: now,
      },
    })
    // 改约后时段变化 → 通知前端刷新占用视图（touched 房间文档触发 watch 重新拉取 roomList）
    await bumpPresenceVersion(record.room_id)
    return ok({ _id: record_id, ...record, start_at, end_at, payload, updated_at: now }, '改约成功')
  } catch (err) {
    return fail((err && err.message) || '云函数执行失败')
  }
}
