const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { validateEvent } = require('./shared/validator')
const { bumpPresenceVersion } = require('./shared/presence')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

/** 把 'HH:mm' 解析成分钟数（0-1439） */
function toMinutes(hhmm) {
  const [h = 0, m = 0] = String(hhmm || '').split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  return h * 60 + m
}

/**
 * 判断某分钟是否落在开放区间内。
 * 支持跨午夜（close < open，视为 wrap-around）：如 22:00-06:00。
 * open==close 视为全天开放。
 */
function withinOpenRange(min, openMin, closeMin) {
  if (openMin === null || closeMin === null) return true // 未配置开放时间 → 不拦
  if (openMin === closeMin) return true // 全天
  if (openMin < closeMin) return min >= openMin && min < closeMin
  // 跨午夜
  return min >= openMin || min < closeMin
}

/**
 * 超时「不再占座」阈值 —— 必须与 roomList 的 isStale、expireRecords 的 PENDING_GRACE_MINUTES /
 * LEAVE_TIMEOUT_MINUTES 保持完全一致。
 * ⚠️ 三处口径要同步修改，否则会出现「座位图显示空闲，一点预约却报已被预约」的自相矛盾。
 */
const PENDING_GRACE_MINUTES = 15
const LEAVE_TIMEOUT_MINUTES = 30

/**
 * 该记录是否已因超时而被视为「不再占座」：
 * - 待签到：开始时间已过 15 分钟仍未签到 → 视为爽约，座位释放
 * - 暂离：最后更新已过 30 分钟仍未返回 → 座位释放
 * 与 roomList 的 isStale 逐字对齐，保证「显示的占用」与「写入时的拦截」同口径。
 */
function releasedByTimeout(item, nowMs) {
  if (!item) return false
  if (item.status === 'pending_checkin') {
    const t = Date.parse(item.start_at || '')
    return Number.isFinite(t) && nowMs - t > PENDING_GRACE_MINUTES * 60 * 1000
  }
  if (item.status === 'paused') {
    const t = Date.parse(item.updated_at || item.created_at || '')
    return Number.isFinite(t) && nowMs - t > LEAVE_TIMEOUT_MINUTES * 60 * 1000
  }
  return false
}

/** 入参白名单（F7） */
const SCHEMA = {
  room_id: { type: 'string', max: 64 },
  seat_id: { type: 'string', max: 64 },
  start_at: { type: 'string', isoDate: true },
  end_at: { type: 'string', isoDate: true },
  category_ids: { type: 'array<string>', maxItems: 8, itemMax: 64, optional: true },
  goal: { type: 'string', max: 200, optional: true },
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

/** 业务异常：可在事务内 throw，被外层 catch 还原为 fail 响应（保留 code/conflict 等结构） */
function bizFail(code, message, data) {
  const err = new Error(message)
  err.isBiz = true
  err.code = code
  err.data = { code, ...(data || {}) }
  return err
}

/**
 * 内容安全检测（UGC 护栏）：入参文本涉嫌诱导/含风险时返回提示。
 * 运行环境不支持（本地测试 mock / 未开通权限）时返回 null 放行，不阻塞主流程。
 */
async function checkSafeText(content) {
  const text = String(content || '').trim()
  if (!text) return null
  const api = cloud.openapi && cloud.openapi.security && cloud.openapi.security.msgSecCheck
  if (typeof api !== 'function') return null
  try {
    const res = await api({ content: text.slice(0, 1000) })
    const risky = (res && res.result && res.result.suggest === 'risky') ||
      (res && res.errCode === 87014)
    return risky ? '内容包含敏感信息，请调整后重试' : null
  } catch (e) {
    // 检测服务不可用（网络/权限/超时）时放行，避免预约主流程被误伤
    console.warn('[msgSecCheck] skip:', (e && e.message) || e)
    return null
  }
}

/** 单次预约最短时长（分钟）：剩余开放时间不足则拒绝放号，而不是给一个 5 分钟的空号 */
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
 * 把预约时段夹（clamp）到房间开放时段内 —— **能约多久就算多久**。
 *
 * 旧行为：结束时间越过打烊就直接拒绝「预约时间须在 08:00-22:00 开放时段内」，
 * 于是 20:33 想约 2 小时（到 22:33）的用户被整段挡在门外。
 * 新行为：把结束时间截断到打烊时间（22:00），让他照样约上 1 小时 27 分。
 *
 * ⚠️ 与前端 `miniprogram/utils/bookingWindow.ts` 的 `planBookingWindow` 逐条对齐，
 *    以及 `cloudfunctions/updateReservation` 的同名函数，改一处必须同步另两处。
 *
 * 仅两种「真的约不了」才返回 ok:false：
 *   ① 开始时间已晚于打烊时间 → 请改天；
 *   ② 截断后不足 MIN_BOOKING_MINUTES → 请改天。
 * 跨夜营业（open > close）无法简单截断，沿用旧的闭馆区间拦截逻辑。
 */
function clampToOpenWindow(startIso, endIso, openTime, closeTime) {
  if (!openTime || !closeTime) {
    return { ok: true, start_at: startIso, end_at: endIso, clamped: false }
  }
  const openMin = toMin(openTime)
  const closeMin = toMin(closeTime)

  // 跨夜营业（如 22:00-06:00）：时段天然跨两个自然日，只拦截落在闭馆区间的部分
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

  // ① 开始早于开放时间 → 推到开放时间
  if (sMin < openMin) {
    sMin = openMin
    clamped = true
  }

  // ② 开始已晚于打烊 → 无法截断成有效时段
  if (sMin >= closeMin) {
    return {
      ok: false,
      code: 'ROOM_CLOSED',
      message: `所选开始时间 ${s.time} 已超出本自习室开放时段（${openTime}-${closeTime}），请选择明天 ${openTime} 之后再预约`,
    }
  }

  // ③ 结束时间：优先用户给的值；若因开始被前推而变得无效，则用原时长重新推导
  let eMin = toMin(e.time)
  if (e.date !== s.date) eMin += 1440
  if (eMin - sMin < MIN_BOOKING_MINUTES) eMin = sMin + askedMin
  // ④ 越过打烊 → 截断到打烊（本次核心行为）
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
    const { room_id, seat_id, start_at: reqStart, end_at: reqEnd } = check.value
    const category_ids = check.value.category_ids || []
    const goal = check.value.goal || ''
    if (new Date(reqStart) >= new Date(reqEnd)) return fail('预约时间或座位参数无效')
    const openId = cloud.getWXContext().OPENID
    if (!openId) return fail('无法获取用户身份，请重新登录')
    const userId = crypto.createHash('sha256').update(openId).digest('hex').slice(0, 32)

    // UGC 护栏：预约备注过检后才能入库
    const safeIssue = goal ? await checkSafeText(goal) : null
    if (safeIssue) return fail(safeIssue)
    // 0.5 房间开放时段：**夹到开放时段内**，而不是直接把超出的预约拒掉
    //     （20:33 想约 2 小时而 22:00 打烊 → 自动截断成 20:33-22:00，能约多久算多久）
    const roomDoc = await db.collection('categories').doc(room_id).get().catch(() => null)
    const roomMeta = roomDoc && roomDoc.data ? roomDoc.data.metadata || {} : {}
    // 房间显示名随预约落库，供后端定时推送（签到提醒/超时预警）直接拼文案，无需二次查库
    const roomName = (roomDoc && roomDoc.data && roomDoc.data.name) || ''
    const win = clampToOpenWindow(reqStart, reqEnd, roomMeta.open_time, roomMeta.close_time)
    if (!win.ok) return fail(win.message, { code: win.code })
    // 后续冲突校验与落库统一使用「夹过的」时段，保证与前端显示、roomList 占用口径一致
    const start_at = win.start_at
    const end_at = win.end_at
    // 0. 违约惩罚校验：处于禁约期内则拒绝新建预约
    const userDoc = await db.collection('users').doc(userId).get().catch(() => null)
    if (userDoc && userDoc.data && userDoc.data.banned_until) {
      const until = new Date(userDoc.data.banned_until).getTime()
      if (until > Date.now()) {
        const mins = Math.ceil((until - Date.now()) / 60000)
        return fail(`你因违约次数过多，${mins} 分钟后才能再次预约`, { code: 'BANNED' })
      }
    }

    // 1-3. 冲突检查 + 插入 合并为单个事务：并发抢同一座位时由数据库层互斥，杜绝双订
    if (typeof db.runTransaction === 'function') {
      // ⚠️ 血泪坑：db.runTransaction(cb) 的 resolve 值 **就是 cb 的返回值本身**，
      // 云端 SDK（wx-server-sdk 2.6.3 / @cloudbase/database）不做 { result } 包装。
      // 旧代码写 `const transaction = await db.runTransaction(...)` 再读 `transaction.result`，
      // 永远拿到 undefined → 事务其实已提交、记录已入库，却给用户返回「预约失败，请稍后重试」。
      // 用户重试时又撞上自己刚建的那条记录 → 「该时段座位已被预约」。
      // 表现就是「约不上 + 座位看着是空的 + 我的预约里莫名多出记录」。
      // 正确写法：直接用 await 的返回值。
      const txResult = await db.runTransaction(async (transaction) => {
        // 与 roomList 显示口径对齐：已超时的「待签到/暂离」不再占座（见 releasedByTimeout 注释）
        const nowMs = Date.now()
        // 1. 座位时段冲突检查（同座位同时段不可重叠）
        const conflict = await transaction
          .collection('records')
          .where({
            room_id,
            seat_id,
            record_type: 'reservation',
            status: _.in(['pending_checkin', 'active', 'paused']),
            start_at: _.lt(end_at),
            end_at: _.gt(start_at),
          })
          .limit(20)
          .get()
        const seatConflict = conflict.data.find((item) => !releasedByTimeout(item, nowMs))
        if (seatConflict) {
          throw bizFail('SEAT_CONFLICT', '该时段座位已被预约', { code: 'SEAT_CONFLICT' })
        }
        // 2. 用户同时段冲突检查（同一用户在同一时段只允许一条预约 Plan §5.2）
        const userConflict = await transaction
          .collection('records')
          .where({
            user_id: userId,
            record_type: 'reservation',
            status: _.in(['pending_checkin', 'active', 'paused']),
            start_at: _.lt(end_at),
            end_at: _.gt(start_at),
          })
          .limit(20)
          .get()
        const liveUserConflict = userConflict.data.find((item) => !releasedByTimeout(item, nowMs))
        if (liveUserConflict) {
          const exist = liveUserConflict
          // 结构与降级路径保持一致（conflict 嵌套），避免两条路径返回不同形状
          throw bizFail('USER_CONFLICT', '你此时段已有预约，请先取消或调整时间', {
            conflict: {
              _id: exist._id,
              room_id: exist.room_id,
              seat_id: exist.seat_id,
              start_at: exist.start_at,
              end_at: exist.end_at,
            },
          })
        }
        const now = new Date().toISOString()
        const record = {
          record_type: 'reservation',
          user_id: userId,
          category_ids,
          room_id,
          seat_id,
          start_at,
          end_at,
          status: 'pending_checkin',
          // openid 随预约落库：后端定时推送（签到提醒/超时预警/违规）无用户态，必须凭此定位接收人
          payload: { goal, openid: openId, room_name: roomName },
          created_at: now,
          updated_at: now,
        }
        const addRes = await transaction.collection('records').add({ data: record })
        // wx-server-sdk 的 collection.add 已把云端 id 归一化为 _id（见 sdk 源码 resolve({ _id: addResult.id })）
        return { _id: addRes._id, ...record }
      })
      if (!txResult || !txResult._id) return fail('预约失败，请稍后重试')
      // 实时信号：预约成功 → 座位占用变化，通知前端 watch 立即重拉占用
      await bumpPresenceVersion(room_id)
      return ok(txResult, '预约成功')
    }

    // 降级路径（本地测试 / 旧版运行环境不支持事务时保留原逻辑）
    // 同样按 releasedByTimeout 过滤已超时的记录，保持与事务路径、与 roomList 显示口径一致
    const nowMs = Date.now()
    const conflict = await db.collection('records').where({ room_id, seat_id, record_type: 'reservation', status: _.in(['pending_checkin', 'active', 'paused']), start_at: _.lt(end_at), end_at: _.gt(start_at) }).limit(20).get()
    const seatConflict = conflict.data.find((item) => !releasedByTimeout(item, nowMs))
    if (seatConflict) return fail('该时段座位已被预约', { code: 'SEAT_CONFLICT' })
    // 2. 用户同时段冲突检查（同一用户在同一时段只允许一条预约 Plan §5.2）
    const userConflict = await db.collection('records').where({
      user_id: userId,
      record_type: 'reservation',
      status: _.in(['pending_checkin', 'active', 'paused']),
      start_at: _.lt(end_at),
      end_at: _.gt(start_at),
    }).limit(20).get()
    const liveUserConflict = userConflict.data.find((item) => !releasedByTimeout(item, nowMs))
    if (liveUserConflict) {
      const exist = liveUserConflict
      return fail('你此时段已有预约，请先取消或调整时间', {
        code: 'USER_CONFLICT',
        conflict: {
          _id: exist._id,
          room_id: exist.room_id,
          seat_id: exist.seat_id,
          start_at: exist.start_at,
          end_at: exist.end_at,
        },
      })
    }
    const now = new Date().toISOString()
    const record = { record_type: 'reservation', user_id: userId, category_ids, room_id, seat_id, start_at, end_at, status: 'pending_checkin', payload: { goal, openid: openId, room_name: roomName }, created_at: now, updated_at: now }
    const result = await db.collection('records').add({ data: record })
    await bumpPresenceVersion(room_id)
    return ok({ _id: result._id, ...record }, '预约成功')
  } catch (err) {
    // 事务内抛出的业务错误（座位/用户冲突）保留原有结构与文案
    if (err && err.isBiz) {
      return fail(err.message, err.data)
    }
    return fail((err && err.message) || '云函数执行失败')
  }
}
