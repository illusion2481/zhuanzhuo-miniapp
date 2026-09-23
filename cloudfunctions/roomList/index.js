const cloud = require('wx-server-sdk')
const { validateEvent } = require('./shared/validator')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

/** 入参白名单（F7） */
const SCHEMA = {
  startAt: { type: 'string', isoDate: true, optional: true },
  endAt: { type: 'string', isoDate: true, optional: true },
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
 * 分页拉全符合查询条件的预约记录。
 * ⚠️ 云数据库单次 .get() 最多返回 1000 条；占用查询若直接 .limit(1000)，
 * 活跃预约超量时会被静默截断 → 部分占用漏报 → 座位图显示空闲、
 * 但 createReservation 的精确查询仍能命中冲突，表现为「座位看着空却约不上」。
 * 这里循环 skip 拉全（上限封顶，避免极端数据下失控）。
 */
async function fetchAllReservations(db, where, maxPages = 50) {
  const all = []
  for (let page = 0; page < maxPages; page++) {
    const res = await db
      .collection('records')
      .where(where)
      .orderBy('created_at', 'asc')
      .skip(page * 1000)
      .limit(1000)
      .get()
    const list = (res && res.data) || []
    for (const item of list) all.push(item)
    if (list.length < 1000) break
  }
  return all
}

exports.main = async (event, context) => {
  try {
    const check = validateEvent(event, SCHEMA)
    if (!check.ok) return fail(check.error)
    const startAt = check.value.startAt || new Date().toISOString()
    const endAt = check.value.endAt || new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    const categories = await db.collection('categories').where({ type: 'room', status: 'active' }).orderBy('sort', 'asc').get()
    // 占用口径：待签到 / 使用中 / 暂离中 均视为已占用（暂离保留座位，不可被他人预约）
    // ⚠️ 必须用分页拉全（见 fetchAllReservations）：单条 .get() 上限 1000，
    // 超过会被截断 → 座位图漏报占用 → 「看着空却约不上」。
    const reservations = await fetchAllReservations(db, {
      record_type: 'reservation',
      status: _.in(['pending_checkin', 'active', 'paused']),
      start_at: _.lt(endAt),
      end_at: _.gt(startAt),
    })
    // 惰性兜底：即便定时清理没跑（未部署 / 执行超时 / 失败），
    // 已超时的「待签到」与「暂离中」也不再算占用，避免出现人走了位子还永久锁着。
    // 阈值与 expireRecords 保持一致：待签到 15 分钟、暂离 30 分钟。
    const nowMs = Date.now()
    const isStale = (item) => {
      if (item.status === 'pending_checkin') {
        const t = Date.parse(item.start_at || '')
        return Number.isFinite(t) && nowMs - t > 15 * 60 * 1000
      }
      if (item.status === 'paused') {
        const t = Date.parse(item.updated_at || item.created_at || '')
        return Number.isFinite(t) && nowMs - t > 30 * 60 * 1000
      }
      return false
    }
    const occupied = new Set(
      reservations
        .filter((item) => !isStale(item))
        .map((item) => `${item.room_id}:${item.seat_id}`),
    )
    // 房间维度占用数：与座位图「行级」口径一致（同房间内所有占位维度合并统计）。
    // 注意 occupied 是 Set<room:seat>，若同房间出现多条同一座位记录只会计 1，
    // 与行级 occupied.has() 判定完全等价，不会多算。
    const usedByRoom = new Map()
    reservations
      .filter((item) => !isStale(item))
      .forEach((item) => {
        const key = `${item.room_id}:${item.seat_id}`
        if (!occupied.has(key)) return
        usedByRoom.set(item.room_id, (usedByRoom.get(item.room_id) || 0) + 1)
      })
    // 评价回流：按 房间:座位 聚合历史评分（平均分 + 条数），供选座页展示「口碑」。
    // 失败 / 集合不存在时不阻断房间列表（评价是增强信号，不是必需数据）。
    const reviewAgg = new Map()
    try {
      const revRes = await db.collection('reviews').limit(2000).get()
      for (const r of revRes.data || []) {
        if (!r || !r.room_id || !r.seat_id) continue
        const key = `${r.room_id}:${r.seat_id}`
        const g = reviewAgg.get(key) || { sum: 0, count: 0 }
        g.sum += Number(r.rating) || 0
        g.count += 1
        reviewAgg.set(key, g)
      }
    } catch (e) {
      // 评价集合不可用 → 不参与展示
    }
    const data = categories.data.map((category) => {
      const meta = category.metadata || {}
      const seats = (meta.seats || []).map((seat) => {
        const agg = reviewAgg.get(`${category._id}:${seat.seat_id}`)
        return {
          ...seat,
          status: seat.status === 'maintain' ? 'maintain' : occupied.has(`${category._id}:${seat.seat_id}`) ? 'reserved' : 'free',
          // 评价回流：平均分（0 = 尚无人评价）+ 评价条数
          rating: agg && agg.count ? Math.round((agg.sum / agg.count) * 10) / 10 : 0,
          review_count: agg ? agg.count : 0,
        }
      })
      const occupiedCount = usedByRoom.get(category._id) || 0
      return { room_id: category._id, code: category.code, name: category.name, description: category.description, building: meta.building, floor: meta.floor, open_time: meta.open_time, close_time: meta.close_time, seats, freeCount: seats.filter((seat) => seat.status === 'free').length, total: seats.length, occupiedCount }
    })
    return ok(data, '自习室查询成功')
  } catch (err) {
    return fail((err && err.message) || '云函数执行失败')
  }
}
