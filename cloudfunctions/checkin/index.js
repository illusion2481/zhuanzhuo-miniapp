const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { validateEvent, normalizeSeatCode } = require('./shared/validator')
const { bumpPresenceVersion } = require('./shared/presence')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

/** 入参白名单（F7） */
const SCHEMA = {
  record_id: { type: 'string', max: 128 },
  seat_code: { type: 'string', max: 64, optional: true },
  checkin_code: { type: 'string', max: 16, optional: true },
  // 地理围栏签到：由前端 wx.getLocation({ type: 'gcj02' }) 上报
  lat: { type: 'number', min: -90, max: 90, optional: true },
  lng: { type: 'number', min: -180, max: 180, optional: true },
  /** 定位精度（米），用于识别「精度过差」的定位结果 */
  accuracy: { type: 'number', min: 0, max: 100000, optional: true },
}

/**
 * 签到宽限：开始后 15 分钟内必须签到。
 * ⚠️ 必须与 roomList.isStale / expireRecords / createReservation.releasedByTimeout 同值。
 * 语义：超过这个点，「待签到」不再算占用，座位已可被别人预约。
 * 若此时还放行签到，就会出现同一座位两条 active 记录（两人同时「使用中」）。
 */
const CHECKIN_GRACE_MS = 15 * 60 * 1000

function ok(data, message = '操作成功') {
  return {
    success: true,
    data,
    message,
    request_id: 'req_' + Date.now(),
  }
}

function fail(message, data = null, code = 'ERROR') {
  return {
    success: false,
    data,
    code,
    message,
    request_id: 'req_' + Date.now(),
  }
}

/* ══════════════ 到店签到码（防远程签到） ══════════════ */

/** 北京时间 YYYY-MM-DD */
function beijingDateKey(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function codeSecret() {
  // 固定内置盐值，不读 CHECKIN_CODE_SECRET：
  // 该密钥只用于派生贴在门口的每日码，本身无保密价值；而环境变量在
  // checkin / adminOps 两个函数上配置不一致时，管理页展示的码会和学生
  // 输入的码对不上（线上真实事故）。两侧都固化同一常量，杜绝这类漂移。
  return 'zz-focusseat-checkin-v1'
}

/**
 * 派生「某房间 + 某天」的 4 位签到码（HMAC 确定性生成，无需落库）。
 * 每天 0 点自动轮换，商家在管理页查看并张贴/发群即可。
 */
function dailyRoomCode(roomId, dateKey) {
  const h = crypto.createHmac('sha256', codeSecret()).update(`${roomId}|${dateKey}`).digest('hex')
  return String(parseInt(h.slice(0, 8), 16) % 10000).padStart(4, '0')
}

/** 是否强制校验到店签到码（默认强制；仅在环境变量显式设为 '0' 时关闭） */
function requireCodeEnabled() {
  return String(process.env.CHECKIN_REQUIRE_CODE || '1') !== '0'
}

/* ══════════════ 地理围栏签到（防「拍照远程签到」） ══════════════ */
/*
 * 背景：静态签到码贴在座位上，任何人拍照即可异地签到，等同于没有防作弊。
 * 因此围栏是**主防线**：只要该自习室配置了围栏，无论手动 / 签到码 / 扫码
 * 三种方式中的哪一种，都必须先通过位置校验（拍照的人拿不到现场 GPS）。
 * 签到码降级为可选的二次验证，保留给「同楼多店 / 拒绝定位授权」等场景。
 *
 * 坐标口径统一为 **gcj02（国测局）**：wx.getLocation 与 wx.chooseLocation
 * 都返回 gcj02，直接配对即可；若从高德/百度地图复制坐标，需先转成 gcj02。
 */

const EARTH_RADIUS_M = 6371000

/** 定位精度上限（米）：超过则认为定位不可信（高楼内/仅基站定位） */
function geoMaxAccuracy() {
  const raw = Number(process.env.CHECKIN_GEO_MAX_ACCURACY)
  return Number.isFinite(raw) && raw > 0 ? raw : 500
}

/** 默认围栏半径（米） */
function defaultGeoRadius() {
  const raw = Number(process.env.CHECKIN_GEO_RADIUS)
  return Number.isFinite(raw) && raw > 0 ? clampGeoRadius(raw) : 200
}

/** 半径夹取：20 ~ 2000 米，避免配成 0（永远签不上）或全球（形同虚设） */
function clampGeoRadius(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return defaultGeoRadius()
  return Math.min(2000, Math.max(20, Math.round(n)))
}

/** Haversine 球面距离（米） */
function haversineDistance(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** 经纬度是否为合法有限数值 */
function isValidLatLng(lat, lng) {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0) // 排除「几内亚湾」空坐标
  )
}

/**
 * 解析房间围栏配置（categories.metadata.geo = { lat, lng, radius }）。
 * 未配置或配置非法 → 返回 null（该房间不启用围栏，保持旧行为）。
 */
function resolveGeoFence(roomMeta) {
  const geo = roomMeta && roomMeta.geo ? roomMeta.geo : null
  if (!geo) return null
  const lat = Number(geo.lat)
  const lng = Number(geo.lng)
  if (!isValidLatLng(lat, lng)) return null
  const radius = clampGeoRadius(Number(geo.radius) > 0 ? Number(geo.radius) : defaultGeoRadius())
  return { lat, lng, radius }
}

/**
 * 位置校验（纯函数，便于测试）。
 * @returns {{ ok: boolean, reason: string, distance?: number, radius?: number, accuracy?: number }}
 *  reason: 'no_fence' 未启用围栏（放行） | 'ok' 通过
 *          | 'no_location' 没拿到坐标 | 'out_of_range' 超出围栏 | 'low_accuracy' 精度不足
 */
function verifyGeo(fence, lat, lng, accuracy) {
  if (!fence) return { ok: true, reason: 'no_fence' }
  if (!isValidLatLng(lat, lng)) {
    return { ok: false, reason: 'no_location', radius: fence.radius }
  }
  const distance = Math.round(haversineDistance(fence.lat, fence.lng, lat, lng))
  if (distance > fence.radius) {
    return { ok: false, reason: 'out_of_range', distance, radius: fence.radius }
  }
  const acc = Number(accuracy)
  if (Number.isFinite(acc) && acc > geoMaxAccuracy()) {
    return { ok: false, reason: 'low_accuracy', distance, radius: fence.radius, accuracy: acc }
  }
  return { ok: true, reason: 'ok', distance, radius: fence.radius }
}

/* ══════════════ 连续签到 streak（行为激励） ══════════════ */

/**
 * 计算下一次连续签到天数（纯函数，便于测试）。
 * - 同日重复签到：不增长，保持原连续天数（≥1）
 * - 昨天签过：连续天数 +1
 * - 断签（前天或更早）：重新从 1 计
 */
function nextStreak(prevStreak, lastCheckinDate, todayKey, yesterdayKey) {
  const prev = Number.isFinite(prevStreak) && prevStreak > 0 ? Math.floor(prevStreak) : 0
  if (lastCheckinDate === todayKey) return Math.max(1, prev)
  if (lastCheckinDate === yesterdayKey) return prev + 1
  return 1
}

/**
 * 签到成功后的连续签到记账（幂等容错：失败绝不阻断签到主流程）。
 * users 集合以 userId（openid 哈希）为 _id；同名/同日重复签到只把 streak 保持住。
 */
async function recordDailyCheckin(userId, nowIso) {
  const nowMs = Date.parse(nowIso)
  const todayKey = beijingDateKey(nowMs)
  const yesterdayKey = beijingDateKey(nowMs - 24 * 3600 * 1000)

  let doc = null
  try {
    const found = await db.collection('users').doc(userId).get()
    doc = found && found.data ? found.data : null
  } catch (e) {
    doc = null
  }

  const prevStreak = doc && typeof doc.streak === 'number' ? doc.streak : 0
  const lastDate = (doc && doc.last_checkin_date) || ''
  const totals = doc && typeof doc.total_checkin === 'number' ? doc.total_checkin : 0
  const streak = nextStreak(prevStreak, lastDate, todayKey, yesterdayKey)

  const patch = {
    streak,
    last_checkin_date: todayKey,
    total_checkin: totals + 1,
    updated_at: nowIso,
  }
  if (doc) {
    await db.collection('users').doc(userId).update({ data: patch })
  } else {
    await db
      .collection('users')
      .add({ data: { _id: userId, open_id_hash: userId, role: 'student', created_at: nowIso, ...patch } })
  }
  return { streak, total_checkin: patch.total_checkin }
}

/**
 * 邀请裂变奖励：被邀人「首次签到」时，被邀人自己 +1，邀请人 +1。
 * 幂等靠被邀人文档的 invite_rewarded 标记（置 true 后不再重复）；
 * 全程 try/catch 容错：邀请加分失败绝不阻断签到主流程。
 * 防线：
 *  - invited_by 由 login 首次创建时写入，且服务端校验过（非本人、hex 32）
 *  - 邀请人文档不存在 / 读失败 → 直接放弃（不产生 ghost 加分）
 *  - 并发双签：条件更新 `invite_rewarded: _.exists(false)` 保证只加一次
 */
async function rewardInviterOnFirstCheckin(userId, nowIso) {
  let doc = null
  try {
    const found = await db.collection('users').doc(userId).get()
    doc = found && found.data ? found.data : null
  } catch (e) {
    doc = null
  }
  const inviter = doc && doc.invited_by ? String(doc.invited_by).trim() : ''
  if (doc && doc.invite_rewarded === true) return // 已奖励过
  if (!inviter || inviter === userId) return

  // 直接尝试条件更新：仅当被邀人还没奖励时 updated=1（并发安全）
  // 被邀人的积分也在这里 +1（与打标记同一条 update，天然幂等且并发安全）
  const up = await db
    .collection('users')
    .where({ _id: userId, invite_rewarded: _.exists(false) })
    .update({
      data: {
        invite_rewarded: true,
        invite_rewarded_at: nowIso,
        invite_credit: _.inc(1),
        updated_at: nowIso,
      },
    })
    .catch(() => ({ stats: { updated: 0 } }))
  if (!up || !up.stats || up.stats.updated !== 1) return // 已被并发抢跑

  // 给邀请人 +1（条件更新，防止文档被清）
  await db
    .collection('users')
    .where({ _id: inviter })
    .update({ data: { invite_credit: _.inc(1), updated_at: nowIso } })
    .catch(() => {})
}

/**
 * 当前有效的签到码集合：
 * - 房间自定义固定码（categories.metadata.checkin_code）优先，便于商家张贴固定码
 * - 管理端「签到方式」卡展示过的当日动态码（checkin_code_today）：管理页看到什么、
 *   学生就能输什么，即使 HMAC 派生因部署/配置漂移对不上也兜得住
 * - 否则用当日动态码；凌晨 2 点前额外容忍前一天的码（跨零点签到的边界）
 */
function acceptedCheckinCodes(roomId, roomMeta, nowMs) {
  const custom = roomMeta && roomMeta.checkin_code ? String(roomMeta.checkin_code).trim() : ''
  if (custom) return [custom]
  const today = beijingDateKey(nowMs)
  const list = [dailyRoomCode(roomId, today)]
  const displayed = roomMeta && roomMeta.checkin_code_today
  if (displayed && displayed.date === today && displayed.code) {
    list.push(String(displayed.code).trim())
  }
  const beijingHour = new Date(nowMs + 8 * 3600e3).getUTCHours()
  if (beijingHour < 2) list.push(dailyRoomCode(roomId, beijingDateKey(nowMs - 24 * 3600e3)))
  return list
}

async function loadRoom(roomId) {
  if (!roomId) return null
  try {
    const found = await db.collection('categories').doc(roomId).get()
    return (found && found.data) || null
  } catch (e) {
    return null
  }
}

exports.main = async (event, context) => {
  try {
    const check = validateEvent(event, SCHEMA)
    if (!check.ok) return fail(check.error)
    const recordId = check.value.record_id
    const seatCode = check.value.seat_code
    const codeInput = check.value.checkin_code ? String(check.value.checkin_code).trim() : ''
    // 地理围栏入参（optional：未传即视为「没拿到定位」，由 verifyGeo 判定）
    const lat = typeof check.value.lat === 'number' ? check.value.lat : undefined
    const lng = typeof check.value.lng === 'number' ? check.value.lng : undefined
    const accuracy = typeof check.value.accuracy === 'number' ? check.value.accuracy : undefined
    const openId = cloud.getWXContext().OPENID
    if (!openId) return fail('无法获取用户身份，请重新登录')
    const userId = crypto.createHash('sha256').update(openId).digest('hex').slice(0, 32)
    const found = await db.collection('records').doc(recordId).get()
    const record = found.data
    if (!record || record.user_id !== userId) return fail('无权操作该预约')
    if (record.status !== 'pending_checkin') return fail('当前预约不可签到')
    const now = Date.now()
    const start = new Date(record.start_at).getTime()
    const end = new Date(record.end_at).getTime()
    if (now < start - 15 * 60 * 1000) return fail('尚未到签到时间')
    if (now > end) return fail('预约已结束')
    // 签到上限：超过宽限期座位已被系统释放（并会被判爽约），必须拒绝，
    // 否则用户签上后与已经预约该座位的人形成「一椅两人」。
    if (now > start + CHECKIN_GRACE_MS) {
      return fail(
        '已超过签到时限（开始后 15 分钟），座位已释放，如需使用请重新预约',
        { code: 'CHECKIN_EXPIRED' },
        'CHECKIN_EXPIRED',
      )
    }

    /* 房间配置（围栏 + 签到码共用；读失败按「无配置」处理，绝不阻断签到） */
    const room = await loadRoom(record.room_id)
    const roomMeta = (room && room.metadata) || null

    /* ① 地理围栏校验 —— 主防线，必须**先于**签到码校验。
       顺序不可颠倒：签到码贴在座位上，拍照的人同样拿得到码，
       只有「人在现场」这个条件才能真正挡住远程签到。
       未配置围栏的房间走 no_fence 分支放行（向后兼容，平滑过渡）。 */
    const fence = resolveGeoFence(roomMeta)
    const geo = verifyGeo(fence, lat, lng, accuracy)
    if (!geo.ok) {
      if (geo.reason === 'out_of_range') {
        return fail(
          `你距该自习室约 ${geo.distance} 米，需在 ${geo.radius} 米范围内才能签到，请到店后重试`,
          { need_geo: true, distance: geo.distance, radius: geo.radius },
          'GEO_TOO_FAR',
        )
      }
      if (geo.reason === 'low_accuracy') {
        return fail(
          `定位精度约 ${Math.round(geo.accuracy)} 米，偏大无法确认到店，请靠近窗户或连接店内 Wi-Fi 后重试`,
          { need_geo: true, accuracy: geo.accuracy, radius: geo.radius },
          'GEO_LOW_ACCURACY',
        )
      }
      return fail(
        '需要获取你的位置以确认到店，请在弹窗中允许「使用我的地理位置」',
        { need_geo: true, radius: geo.radius },
        'GEO_REQUIRED',
      )
    }

    /* ② 到店凭证校验：签到码 → 座位码 → 无凭证（受开关约束） */
    let method = 'manual'
    if (codeInput) {
      // 自愈落库（与 adminOps 展示码同源）：谁先跑到谁把当日码写进
      // metadata.checkin_code_today，保证管理页展示与本校验永远收敛到同一个码，
      // 即使某个函数仍是旧版，只要其中一个更新过，另一端也能对上。
      const roomId = record.room_id || ''
      if (roomId && !(roomMeta && roomMeta.checkin_code)) {
        const todayKey = beijingDateKey(now)
        const derived = dailyRoomCode(roomId, todayKey)
        const displayed = roomMeta && roomMeta.checkin_code_today
        if (!displayed || displayed.date !== todayKey || String(displayed.code || '') !== derived) {
          await db
            .collection('categories')
            .doc(roomId)
            .update({
              data: { 'metadata.checkin_code_today': { date: todayKey, code: derived }, updated_at: new Date(now).toISOString() },
            })
            .catch(() => null)
        }
      }
      const valid = acceptedCheckinCodes(record.room_id || '', roomMeta, now)
      // 统一转大写比对：字母码「AB12」输成「ab12」不应被误拒
      const validUp = valid.map((c) => String(c).trim().toUpperCase())
      if (validUp.indexOf(codeInput.toUpperCase()) === -1) {
        const roomName = room && room.name ? String(room.name) : ''
        return fail(
          `签到码不正确${roomName ? `（${roomName}）` : ''}，请向店家确认当日签到码`,
          { need_code: true },
          'NEED_CHECKIN_CODE',
        )
      }
      method = 'code'
    } else if (seatCode) {
      // 扫码校验：若前端传来 seat_code，则必须与该预约座位一致
      // F9：两侧统一 trim + 压缩空白 + 转大写后比对，避免「A 01」vs「a01」误拒
      const scanned = normalizeSeatCode(seatCode)
      if (normalizeSeatCode(record.seat_id) !== scanned) {
        return fail('二维码与当前预约座位不一致', { expected: record.seat_id, scanned })
      }
      method = 'scan'
    } else if (requireCodeEnabled()) {
      return fail('请到店后输入店内签到码完成签到', { need_code: true }, 'NEED_CHECKIN_CODE')
    }

    const updated_at = new Date().toISOString()
    const patch = {
      status: 'active',
      updated_at,
      'payload.checked_in_at': updated_at,
      'payload.checkin_method': method,
    }
    // 围栏审计留痕：事后可核对「签到时距门店多远」，便于处理争议与调参
    if (fence && geo.reason === 'ok') {
      patch['payload.checkin_geo'] = {
        distance: geo.distance,
        radius: geo.radius,
        lat,
        lng,
        accuracy: Number.isFinite(Number(accuracy)) ? Number(accuracy) : null,
      }
    }
    await db.collection('records').doc(recordId).update({ data: patch })
    // 实时信号：待签到 → 使用中，通知前端 watch 重拉
    await bumpPresenceVersion(record.room_id)
    // 连续签到记账（幂等容错：失败只影响 streak 展示，不阻断签到）
    let streakInfo = null
    try {
      streakInfo = await recordDailyCheckin(userId, updated_at)
    } catch (e) {
      console.warn('[checkin] streak skip:', (e && e.message) || e)
    }
    // 邀请裂变奖励：被邀人首次签到 → 双方各 +1（幂等，失败不阻断签到）
    try {
      await rewardInviterOnFirstCheckin(userId, updated_at)
    } catch (e) {
      console.warn('[checkin] invite reward skip:', (e && e.message) || e)
    }
    return ok({ ...record, status: 'active', updated_at, streak: streakInfo }, '签到成功')
  } catch (err) {
    return fail((err && err.message) || '云函数执行失败')
  }
}

/** 供本地测试使用的纯函数导出 */
exports.__test = {
  beijingDateKey,
  dailyRoomCode,
  acceptedCheckinCodes,
  requireCodeEnabled,
  nextStreak,
  recordDailyCheckin,
  rewardInviterOnFirstCheckin,
  // 地理围栏
  haversineDistance,
  isValidLatLng,
  clampGeoRadius,
  defaultGeoRadius,
  resolveGeoFence,
  verifyGeo,
}
