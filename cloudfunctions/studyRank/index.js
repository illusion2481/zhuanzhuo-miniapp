const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const $ = db.command.aggregate
const RECORDS = 'records'
const USERS = 'users'

function ok(data, message) {
  return { success: true, data, message: message || 'ok', request_id: 'req_' + Date.now() }
}

function fail(message, data) {
  return { success: false, data: data || null, message, request_id: 'req_' + Date.now() }
}

function hashOpenId(openId) {
  return crypto.createHash('sha256').update(openId).digest('hex').slice(0, 32)
}

/**
 * 北京时间（项目面向中国大陆用户）下某时段的起始 ISO。
 * - today: 北京时间当日 00:00
 * - week:  北京时间本周一 00:00
 * - 其它:  返回 null（总榜，不做时间过滤）
 */
function periodStartIso(period) {
  if (period !== 'today' && period !== 'week') return null
  const now = new Date()
  // 转到北京时间
  const bj = new Date(now.getTime() + 8 * 3600 * 1000)
  if (period === 'today') {
    bj.setHours(0, 0, 0, 0)
  } else {
    const day = bj.getDay() // 0=周日
    const diff = day === 0 ? 6 : day - 1
    bj.setDate(bj.getDate() - diff)
    bj.setHours(0, 0, 0, 0)
  }
  // 转回 UTC ISO
  return new Date(bj.getTime() - 8 * 3600 * 1000).toISOString()
}

/** 批量取用户昵称 + 头像（按 _id 分片，避免一次 in 过多） */
async function batchUserInfo(ids) {
  const map = {}
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20)
    try {
      const res = await db
        .collection(USERS)
        .where({ _id: _.in(chunk) })
        .limit(20)
        .get()
      for (const d of (res.data || [])) {
        const name = (d.nick_name && String(d.nick_name).trim()) || '学友' + String(d._id).slice(-4)
        const avatar = (d.avatar_url && String(d.avatar_url).trim()) || ''
        map[d._id] = { name, avatar }
      }
    } catch (e) {
      /* 昵称/头像缺失不影响榜单 */
    }
  }
  return map
}

exports.main = async (event = {}) => {
  try {
    const period = ['today', 'week', 'all'].includes(event.period) ? event.period : 'week'
    const type = event.type === 'checkin' ? 'checkin' : 'focus'
    const since = periodStartIso(period)

    if (type === 'checkin') {
      // 签到排行榜：按「已到店使用」的预约数排名（active / paused / completed 都算已签到；
      // pending_checkin 还没签、cancelled / no_show 不算）。
      const match = { record_type: 'reservation', status: _.in(['active', 'paused', 'completed']) }
      if (since) match.created_at = _.gte(since)

      const agg = await db
        .collection(RECORDS)
        .aggregate()
        .match(match)
        .group({ _id: '$user_id', checkin_count: $.sum(1) })
        .sort({ checkin_count: -1 })
        .limit(50)
        .end()

      const list = (agg.list || [])
        .filter((g) => g && g._id)
        .map((g, idx) => ({
          rank: idx + 1,
          user_id: g._id,
          checkin_count: Math.max(0, Math.floor(g.checkin_count || 0)),
          focus_sec: 0,
          pomodoro: 0,
          sessions: 0,
        }))

      const ids = list.map((r) => r.user_id)
      const infoMap = await batchUserInfo(ids)
      for (const r of list) {
        const info = infoMap[r.user_id]
        r.name = info ? info.name : '学友' + String(r.user_id).slice(-4)
        r.avatar = info ? info.avatar : ''
      }

      // 当前用户名次（不在前 50 时单独补算）
      let me = null
      const wxContext = cloud.getWXContext()
      const meId = wxContext.OPENID ? hashOpenId(wxContext.OPENID) : ''
      if (meId) {
        const found = list.find((r) => r.user_id === meId)
        if (found) {
          me = { rank: found.rank, checkin_count: found.checkin_count, focus_sec: 0, pomodoro: 0, sessions: 0 }
        } else {
          try {
            const myAgg = await db
              .collection(RECORDS)
              .aggregate()
              .match({ ...match, user_id: meId })
              .group({ _id: '$user_id', checkin_count: $.sum(1) })
              .end()
            const my = (myAgg.list || [])[0]
            if (my && (my.checkin_count || 0) > 0) {
              const above = await db
                .collection(RECORDS)
                .aggregate()
                .match(match)
                .group({ _id: '$user_id', checkin_count: $.sum(1) })
                .match({ checkin_count: _.gt(Math.floor(my.checkin_count || 0)) })
                .count('c')
                .end()
              const c = (above.list && above.list[0] && above.list[0].c) || 0
              me = { rank: c + 1, checkin_count: Math.max(0, Math.floor(my.checkin_count || 0)), focus_sec: 0, pomodoro: 0, sessions: 0 }
            }
          } catch (e) {
            /* 不影响榜单主体 */
          }
        }
      }

      return ok({ period, type, updated_at: new Date().toISOString(), top: list, me })
    }

    // ── 专注榜（原逻辑不变）──
    const match = { record_type: 'study', status: 'completed' }
    if (since) match.created_at = _.gte(since)

    const agg = await db
      .collection(RECORDS)
      .aggregate()
      .match(match)
      .group({
        _id: '$user_id',
        focus_sec: $.sum('$payload.actual_duration_sec'),
        pomodoro: $.sum('$payload.pomodoro_count'),
        sessions: $.sum(1),
      })
      .sort({ focus_sec: -1 })
      .limit(50)
      .end()

    const list = (agg.list || [])
      .filter((g) => g && g._id)
      .map((g, idx) => ({
        rank: idx + 1,
        user_id: g._id,
        focus_sec: Math.max(0, Math.floor(g.focus_sec || 0)),
        pomodoro: Math.max(0, Math.floor(g.pomodoro || 0)),
        sessions: Math.max(0, Math.floor(g.sessions || 0)),
      }))

    const ids = list.map((r) => r.user_id)
    const infoMap = await batchUserInfo(ids)
    for (const r of list) {
      const info = infoMap[r.user_id]
      r.name = info ? info.name : '学友' + String(r.user_id).slice(-4)
      r.avatar = info ? info.avatar : ''
    }

    // 当前用户名次
    let me = null
    const wxContext = cloud.getWXContext()
    const openId = wxContext.OPENID
    if (openId) {
      const meId = hashOpenId(openId)
      const found = list.find((r) => r.user_id === meId)
      if (found) {
        me = {
          rank: found.rank,
          focus_sec: found.focus_sec,
          pomodoro: found.pomodoro,
          sessions: found.sessions,
        }
      } else {
        // 不在前 50：单独算我的总量与排名
        try {
          const myAgg = await db
            .collection(RECORDS)
            .aggregate()
            .match({ ...match, user_id: meId })
            .group({
              _id: '$user_id',
              focus_sec: $.sum('$payload.actual_duration_sec'),
              pomodoro: $.sum('$payload.pomodoro_count'),
              sessions: $.sum(1),
            })
            .end()
          const my = (myAgg.list || [])[0]
          if (my && (my.focus_sec || 0) > 0) {
            const above = await db
              .collection(RECORDS)
              .aggregate()
              .match(match)
              .group({ _id: '$user_id', focus_sec: $.sum('$payload.actual_duration_sec') })
              .match({ focus_sec: _.gt(Math.floor(my.focus_sec || 0)) })
              .count('c')
              .end()
            const c = (above.list && above.list[0] && above.list[0].c) || 0
            me = {
              rank: c + 1,
              focus_sec: Math.max(0, Math.floor(my.focus_sec || 0)),
              pomodoro: Math.max(0, Math.floor(my.pomodoro || 0)),
              sessions: Math.max(0, Math.floor(my.sessions || 0)),
            }
          }
        } catch (e) {
          /* 不影响榜单主体 */
        }
      }
    }

    return ok({ period, type: 'focus', updated_at: new Date().toISOString(), top: list, me })
  } catch (err) {
    return fail((err && err.message) || '排行榜生成失败')
  }
}
