const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { validateEvent } = require('./shared/validator')
const { fetchAllPaged } = require('./shared/db')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const COLLECTION = 'records'
const STUDY_TYPE = 'study'
const POMODORO_SECONDS = 1500
const MAX_LIMIT = 100
const SUMMARY_PAGE = 100
const SUMMARY_MAX_PAGES = 200
/** 编辑时长上限（分钟）：24 小时 */
const EDIT_MAX_MINUTES = 1440

/** 入参白名单（F7）：未声明字段一律剥离 */
const SCHEMA = {
  action: {
    type: 'enum',
    values: [
      'start',
      'pause',
      'resume',
      'complete',
      'abandon',
      'update',
      'delete',
      'sync_pomodoro',
      'list',
      'list_reservations',
      'summary',
    ],
    optional: true,
    default: 'list',
  },
  record_id: { type: 'string', max: 128, optional: true },
  /** 番茄段配置：单个专注段 / 休息段时长（分钟），随 sync_pomodoro 或 start 写入 */
  focus_min: { type: 'number', min: 1, max: 240, optional: true },
  break_min: { type: 'number', min: 1, max: 120, optional: true },
  /** 番茄段轨迹（全量重推，幂等）：[{type:'focus'|'break', start, end?, completed}] */
  segments: {
    type: 'array<object>',
    maxItems: 300,
    itemKeys: ['type', 'start', 'end', 'completed'],
    optional: true,
  },
  /** 编辑时长（分钟）：1~1440，即最长 24 小时 */
  duration_min: { type: 'number', min: 1, max: EDIT_MAX_MINUTES, optional: true },
  category_ids: { type: 'array<string>', maxItems: 8, itemMax: 64, optional: true },
  goal: { type: 'string', max: 200, optional: true },
  reservation_id: { type: 'string', max: 128, optional: true },
  room_id: { type: 'string', max: 64, optional: true },
  seat_id: { type: 'string', max: 64, optional: true },
  reason: { type: 'string', max: 120, optional: true },
  status: { type: 'string', max: 20, optional: true },
  since: { type: 'string', isoDate: true, optional: true },
  limit: { type: 'number', min: 1, max: MAX_LIMIT, optional: true },
  skip: { type: 'number', min: 0, optional: true },
  page: { type: 'number', min: 1, optional: true },
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

/**
 * 计算有效学习时长（秒）：
 * 累计运行时间 = end - start
 * 再减去 pause_segments 中各段的暂停时间
 */
function computeActiveSeconds(record, nowMs) {
  const startMs = new Date(record.start_at || record.created_at).getTime()
  const endMs = record.end_at ? new Date(record.end_at).getTime() : nowMs
  let seconds = Math.max(0, endMs - startMs) / 1000
  const segments = (record.payload && Array.isArray(record.payload.pause_segments))
    ? record.payload.pause_segments
    : []
  for (const seg of segments) {
    if (!seg || !seg.start) continue
    const segStart = new Date(seg.start).getTime()
    const segEnd = seg.end ? new Date(seg.end).getTime() : nowMs
    seconds -= Math.max(0, segEnd - segStart) / 1000
  }
  return Math.max(0, Math.floor(seconds))
}

/** 暂停总秒数：编辑时长后回推 end_at 时需要加上这部分 */
function sumPausedSeconds(payload, nowMs) {
  const segments = (payload && Array.isArray(payload.pause_segments)) ? payload.pause_segments : []
  let total = 0
  for (const seg of segments) {
    if (!seg || !seg.start) continue
    const segStart = new Date(seg.start).getTime()
    if (Number.isNaN(segStart)) continue
    const segEnd = seg.end ? new Date(seg.end).getTime() : nowMs
    total += Math.max(0, segEnd - segStart) / 1000
  }
  return Math.max(0, Math.floor(total))
}

/**
 * 番茄计数：优先按「真实完成的专注段」计，否则回退到旧的除法口径。
 * 两者解耦的意义：手动把时长改成 90 分钟，番茄仍是实际走完的段数，不会被换算污染。
 */
function countPomodoro(payload, durationSec) {
  const segments = payload && Array.isArray(payload.pomodoro_segments) ? payload.pomodoro_segments : []
  if (segments.length) {
    return segments.filter((s) => s && s.type === 'focus' && s.completed).length
  }
  return Math.floor(Math.max(0, durationSec || 0) / POMODORO_SECONDS)
}

/** 由番茄段轨迹派生 pause_segments：休息段不计入专注时长 */
function derivePauseSegments(existingPauses, pomodoroSegments) {
  const manual = (Array.isArray(existingPauses) ? existingPauses : []).filter(
    (s) => s && s.source !== 'pomodoro',
  )
  const fromBreak = []
  for (const seg of Array.isArray(pomodoroSegments) ? pomodoroSegments : []) {
    if (!seg || seg.type !== 'break' || !seg.start) continue
    const item = { start: seg.start, end: seg.end || null, source: 'pomodoro' }
    fromBreak.push(item)
  }
  return manual.concat(fromBreak)
}

/** 规范化番茄段：剔除非法项，保证写入库里的数据结构稳定 */
function sanitizeSegments(input) {
  const out = []
  for (const raw of Array.isArray(input) ? input : []) {
    if (!raw || (raw.type !== 'focus' && raw.type !== 'break')) continue
    if (!raw.start) continue
    const item = { type: raw.type, start: raw.start, completed: raw.completed === true }
    if (raw.end) item.end = raw.end
    out.push(item)
  }
  return out
}

function closeOpenPause(record) {
  const payload = record.payload || {}
  const segments = Array.isArray(payload.pause_segments) ? [...payload.pause_segments] : []
  const last = segments[segments.length - 1]
  if (last && !last.end) last.end = new Date().toISOString()
  // 注意：必须把新 payload 嵌套在 payload 键下返回，
  // 否则调用方解构 { payload: newPayload } 会拿到 undefined，
  // 导致 goal / pause_segments 等字段在 complete/abandon 时被静默清空
  return { payload: { ...payload, pause_segments: segments }, segments }
}

async function findRunning(userId) {
  const res = await db.collection(COLLECTION).where({
    user_id: userId,
    record_type: STUDY_TYPE,
    status: 'running',
  }).limit(1).get()
  return res.data && res.data[0] ? res.data[0] : null
}

async function fetchOwnedRecord(recordId, userId) {
  const found = await db.collection(COLLECTION).doc(recordId).get()
  const record = found.data
  if (!record || record.user_id !== userId) return null
  return record
}

function clampLimit(input) {
  const n = Number.isFinite(input) ? Math.floor(input) : 20
  if (n < 1) return 1
  if (n > MAX_LIMIT) return MAX_LIMIT
  return n
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
    const risky =
      (res && res.result && res.result.suggest === 'risky') ||
      (res && res.errCode === 87014)
    return risky ? '内容包含敏感信息，请调整后重试' : null
  } catch (e) {
    // 检测服务不可用（网络/权限/超时）时放行，避免主流程被误伤
    console.warn('[msgSecCheck] skip:', (e && e.message) || e)
    return null
  }
}

exports.main = async (event) => {
  try {
    const check = validateEvent(event, SCHEMA)
    if (!check.ok) return fail(check.error)
    const v = check.value
    const action = v.action || 'list'
    const userId = getUserId()
    if (!userId) return fail('无法获取用户身份，请重新登录')

    const now = new Date()
    const nowIso = now.toISOString()
    const nowMs = now.getTime()

    if (action === 'start') {
      const existing = await findRunning(userId)
      if (existing) {
        const activeSec = computeActiveSeconds(existing, nowMs)
        return ok({ ...existing, payload: { ...(existing.payload || {}), live_active_sec: activeSec } }, '已有进行中的学习，已切换为继续')
      }
      const categoryIds = v.category_ids || []
      const goal = v.goal || ''
      const reservationId = v.reservation_id || ''
      const roomId = v.room_id || ''
      const seatId = v.seat_id || ''

      // UGC 护栏：学习目标待检测后才能入库
      const safeIssue = goal ? await checkSafeText(goal) : null
      if (safeIssue) return fail(safeIssue)

      // 若附带 reservation_id，校验同主所属的有效预约
      if (reservationId) {
        const reservation = await db.collection(COLLECTION).doc(reservationId).get().catch(() => null)
        const r = reservation && reservation.data
        if (!r || r.user_id !== userId || r.record_type !== 'reservation') {
          return fail('关联的预约无效')
        }
        // 暂离中(paused) 座位仍归本人，同样允许关联开始学习
        if (!['pending_checkin', 'active', 'paused'].includes(r.status)) {
          return fail('关联的预约不在可学习状态')
        }
      }

      const payload = {
        goal,
        reservation_id: reservationId,
        pause_segments: [],
        pomodoro_segments: [],
        pomodoro_count: 0,
      }
      if (v.focus_min !== undefined) payload.focus_min = v.focus_min
      if (v.break_min !== undefined) payload.break_min = v.break_min
      const record = {
        record_type: STUDY_TYPE,
        user_id: userId,
        category_ids: categoryIds,
        start_at: nowIso,
        end_at: null,
        status: 'running',
        payload,
        created_at: nowIso,
        updated_at: nowIso,
      }
      if (roomId) record.room_id = roomId
      if (seatId) record.seat_id = seatId

      const result = await db.collection(COLLECTION).add({ data: record })
      return ok({ _id: result._id, ...record }, '专注已开始')
    }

    if (action === 'pause') {
      const recordId = v.record_id
      if (!recordId) return fail('缺少记录 ID')
      const record = await fetchOwnedRecord(recordId, userId)
      if (!record) return fail('无权操作该学习记录')
      if (record.status !== 'running') return fail('当前学习记录不在运行')
      const segments = (record.payload && Array.isArray(record.payload.pause_segments))
        ? [...record.payload.pause_segments]
        : []
      const last = segments[segments.length - 1]
      if (last && !last.end) return fail('当前学习已处于暂停状态')
      segments.push({ start: nowIso, end: null })
      const newPayload = { ...(record.payload || {}), pause_segments: segments }
      await db.collection(COLLECTION).doc(recordId).update({
        data: { payload: newPayload, updated_at: nowIso },
      })
      return ok({ ...record, payload: newPayload, updated_at: nowIso }, '已暂停')
    }

    if (action === 'resume') {
      const recordId = v.record_id
      if (!recordId) return fail('缺少记录 ID')
      const record = await fetchOwnedRecord(recordId, userId)
      if (!record) return fail('无权操作该学习记录')
      if (record.status !== 'running') return fail('当前学习记录不在运行')
      const segments = (record.payload && Array.isArray(record.payload.pause_segments))
        ? [...record.payload.pause_segments]
        : []
      const last = segments[segments.length - 1]
      if (!last || last.end) return fail('当前学习未处于暂停状态')
      last.end = nowIso
      const newPayload = { ...(record.payload || {}), pause_segments: segments }
      await db.collection(COLLECTION).doc(recordId).update({
        data: { payload: newPayload, updated_at: nowIso },
      })
      return ok({ ...record, payload: newPayload, updated_at: nowIso }, '已恢复')
    }

    if (action === 'complete') {
      const recordId = v.record_id
      if (!recordId) return fail('缺少记录 ID')
      const record = await fetchOwnedRecord(recordId, userId)
      if (!record) return fail('无权操作该学习记录')
      if (record.status !== 'running') return fail('当前学习未在运行')
      const { payload: newPayload, segments } = closeOpenPause(record)
      // 番茄休息段同样不计入专注时长：与手动 pause 合并
      //（derivePauseSegments 幂等，sync 已派生过也不会重复扣）
      const effectivePauses = derivePauseSegments(segments, newPayload.pomodoro_segments)
      const durationSec = computeActiveSeconds(
        { ...record, end_at: nowIso, payload: { ...newPayload, pause_segments: effectivePauses } },
        nowMs,
      )
      const pomodoroCount = countPomodoro(newPayload, durationSec)
      const finalPayload = {
        ...newPayload,
        pause_segments: effectivePauses,
        actual_duration_sec: durationSec,
        pomodoro_count: pomodoroCount,
      }
      await db.collection(COLLECTION).doc(recordId).update({
        data: {
          status: 'completed',
          end_at: nowIso,
          payload: finalPayload,
          updated_at: nowIso,
        },
      })
      return ok(
        { ...record, status: 'completed', end_at: nowIso, payload: finalPayload, updated_at: nowIso },
        `已完成 ${Math.floor(durationSec / 60)} 分钟`,
      )
    }

    if (action === 'abandon') {
      const recordId = v.record_id
      if (!recordId) return fail('缺少记录 ID')
      const record = await fetchOwnedRecord(recordId, userId)
      if (!record) return fail('无权操作该学习记录')
      if (record.status !== 'running') return fail('当前学习未在运行')
      const { payload: newPayload, segments } = closeOpenPause(record)
      // 同 complete：番茄休息段不计入时长
      const effectivePauses = derivePauseSegments(segments, newPayload.pomodoro_segments)
      const durationSec = computeActiveSeconds(
        { ...record, end_at: nowIso, payload: { ...newPayload, pause_segments: effectivePauses } },
        nowMs,
      )
      const reason = v.reason || ''
      // UGC 护栏：放弃原因待检测后才能入库
      const safeIssue = reason ? await checkSafeText(reason) : null
      if (safeIssue) return fail(safeIssue)
      const finalPayload = {
        ...newPayload,
        pause_segments: effectivePauses,
        actual_duration_sec: durationSec,
        abandoned_reason: reason,
      }
      await db.collection(COLLECTION).doc(recordId).update({
        data: {
          status: 'abandoned',
          end_at: nowIso,
          payload: finalPayload,
          updated_at: nowIso,
        },
      })
      return ok(
        { ...record, status: 'abandoned', end_at: nowIso, payload: finalPayload, updated_at: nowIso },
        '已结束本次学习',
      )
    }

    if (action === 'update') {
      const recordId = v.record_id
      if (!recordId) return fail('缺少记录 ID')
      const record = await fetchOwnedRecord(recordId, userId)
      if (!record) return fail('无权操作该学习记录')
      // fetchOwnedRecord 只校验归属，这里必须补一道类型校验，
      // 否则可拿别人的预约记录 ID 来改学习字段
      if (record.record_type !== STUDY_TYPE) return fail('仅学习记录支持编辑')

      const hasGoal = typeof v.goal === 'string'
      const hasDuration = typeof v.duration_min === 'number'
      if (!hasGoal && !hasDuration) return fail('没有需要更新的内容')

      // UGC 护栏：修改目标同样过检
      if (hasGoal && v.goal) {
        const safeIssue = await checkSafeText(v.goal)
        if (safeIssue) return fail(safeIssue)
      }

      // 进行中的记录时长由 start_at 实时推算，写死反而会被下一次计时覆盖
      if (hasDuration && record.status === 'running') {
        return fail('进行中的学习无法直接改时长，请先完成或结束本次学习')
      }

      const payload = { ...(record.payload || {}) }
      const patch = { payload, updated_at: nowIso }

      if (hasGoal) payload.goal = v.goal

      if (hasDuration) {
        const durationSec = Math.max(1, Math.round(v.duration_min * 60))
        payload.actual_duration_sec = durationSec
        // 改时长不再换算番茄：有分段轨迹时保留真实完成数，没有才回退除法
        payload.pomodoro_count = countPomodoro(payload, durationSec)
        payload.manual_edited = true
        // 同步回推 end_at，保证「时长 = end - start - 暂停」在任意计算口径下都一致
        const startMs = new Date(record.start_at || record.created_at).getTime()
        if (!Number.isNaN(startMs)) {
          const pausedSec = sumPausedSeconds(record.payload, nowMs)
          patch.end_at = new Date(startMs + (durationSec + pausedSec) * 1000).toISOString()
        }
      }

      await db.collection(COLLECTION).doc(recordId).update({ data: patch })
      const merged = { ...record, ...patch }
      const message = hasGoal && hasDuration
        ? '已保存'
        : hasGoal ? '名称已更新' : `时长已更新为 ${v.duration_min} 分钟`
      return ok(merged, message)
    }

    if (action === 'delete') {
      const recordId = v.record_id
      if (!recordId) return fail('缺少记录 ID')
      const record = await fetchOwnedRecord(recordId, userId)
      if (!record) return fail('无权操作该学习记录')
      // 同 update：类型护栏，防止拿预约记录 ID 来删
      if (record.record_type !== STUDY_TYPE) return fail('仅学习记录支持删除')
      // 进行中的记录是当前会话的锚点（计时/恢复都靠它），删了会导致番茄钟状态悬空
      if (record.status === 'running') {
        return fail('进行中的学习不能删除，请先完成或结束本次学习')
      }
      await db.collection(COLLECTION).doc(recordId).remove()
      return ok(null, '记录已删除')
    }

    if (action === 'sync_pomodoro') {
      const recordId = v.record_id
      if (!recordId) return fail('缺少 record_id')
      const record = await fetchOwnedRecord(recordId, userId)
      if (!record) return fail('学习记录不存在或无权访问')
      // fetchOwnedRecord 只校验归属，必须自己补类型判断
      if (record.record_type !== STUDY_TYPE) return fail('仅学习记录支持番茄同步')
      if (record.status !== 'running') return fail('学习已结束，无法同步番茄段')

      const clean = sanitizeSegments(v.segments)
      const payload = { ...(record.payload || {}) }
      payload.pomodoro_segments = clean
      // 休息段不计入学习时长：派生为带标记的 pause_segment，全量重推保证幂等
      payload.pause_segments = derivePauseSegments(payload.pause_segments, clean)
      payload.pomodoro_count = clean.filter((s) => s.type === 'focus' && s.completed).length
      if (v.focus_min !== undefined) payload.focus_min = v.focus_min
      if (v.break_min !== undefined) payload.break_min = v.break_min

      const nowIso = new Date().toISOString()
      await db.collection(COLLECTION).doc(recordId).update({
        data: { payload, updated_at: nowIso },
      })
      return ok(
        {
          record_id: recordId,
          pomodoro_count: payload.pomodoro_count,
          segment_count: clean.length,
        },
        `已同步 ${payload.pomodoro_count} 个番茄`,
      )
    }

    if (action === 'list') {
      const where = { user_id: userId, record_type: STUDY_TYPE }
      if (v.status) where.status = v.status
      if (v.since) where.created_at = _.gte(v.since)
      const limit = clampLimit(v.limit || 20)
      const skip = Math.max(0, Math.floor(v.skip || ((v.page || 1) - 1) * limit))
      const res = await db
        .collection(COLLECTION)
        .where(where)
        .orderBy('created_at', 'desc')
        .skip(skip)
        .limit(limit)
        .get()
      return ok(res.data || [])
    }

    if (action === 'list_reservations') {
      // 列本人预约记录（不含学习/签到/暂离/反馈），仅 reservation 类型
      const where = { user_id: userId, record_type: 'reservation' }
      if (v.status) where.status = v.status
      const limit = clampLimit(v.limit || 20)
      const skip = Math.max(0, Math.floor(v.skip || ((v.page || 1) - 1) * limit))
      const res = await db
        .collection(COLLECTION)
        .where(where)
        .orderBy('created_at', 'desc')
        .skip(skip)
        .limit(limit)
        .get()
      return ok(res.data || [])
    }

    if (action === 'summary') {
      const since = v.since
      if (!since) return fail('summary 需要提供 since（ISO 字符串）')
      // 循环分页拉全量（F6）：>200 条时统计仍准确
      const items = await fetchAllPaged(
        COLLECTION,
        { user_id: userId, record_type: STUDY_TYPE, created_at: _.gte(since) },
        { pageSize: SUMMARY_PAGE, maxPages: SUMMARY_MAX_PAGES },
      )
      let totalSec = 0
      let completedSec = 0
      let completedCount = 0
      let abandonedCount = 0
      let activeCount = 0
      let pomodoroTotal = 0
      for (const item of items) {
        const payload = item.payload || {}
        const duration = payload.actual_duration_sec
          || (item.status === 'running' ? computeActiveSeconds(item, nowMs) : 0)
        totalSec += duration
        if (item.status === 'completed') {
          completedSec += duration
          completedCount += 1
          pomodoroTotal += payload.pomodoro_count || 0
        } else if (item.status === 'abandoned') {
          abandonedCount += 1
        } else if (item.status === 'running') {
          activeCount += 1
        }
      }
      return ok({
        since,
        since_now: nowIso,
        session_total: items.length,
        active_count: activeCount,
        completed_count: completedCount,
        abandoned_count: abandonedCount,
        total_seconds: totalSec,
        completed_seconds: completedSec,
        pomodoro_total: pomodoroTotal,
        average_seconds_per_session: completedCount ? Math.floor(completedSec / completedCount) : 0,
      })
    }

    return fail(`未知操作：${action}`)
  } catch (err) {
    return fail((err && err.message) || '云函数执行失败')
  }
}

// 供本地逻辑测试（scripts/cloud-logic.test.cjs）使用，不影响云函数运行
exports.__test = {
  computeActiveSeconds,
  closeOpenPause,
  clampLimit,
  sumPausedSeconds,
  countPomodoro,
  derivePauseSegments,
  sanitizeSegments,
}
