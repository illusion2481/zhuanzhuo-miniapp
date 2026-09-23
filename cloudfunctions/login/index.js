const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { validateEvent } = require('./shared/validator')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const USERS = 'users'
const RECORDS = 'records'

/** 未签到自动释放座位并记违约的宽限（分钟）—— 口径同 `expireRecords.PENDING_GRACE_MINUTES` */
const PENDING_GRACE_MINUTES = 15
/** 暂离超时（分钟）—— 口径同 `expireRecords.LEAVE_TIMEOUT_MINUTES` */
const LEAVE_TIMEOUT_MINUTES = 30

/**
 * 违约惩罚梯度（分钟）—— 口径同 `expireRecords.banMinutesFor`
 * 第 1 次 30 分钟 / 第 2 次 2 小时 / 第 3 次起 24 小时
 */
function banMinutesFor(count) {
  if (count <= 1) return 30
  if (count === 2) return 120
  return 1440
}

/**
 * 惰性结算本人的超时预约（幂等）。
 *
 * 为什么放在 login：`expireRecords` 依赖云函数定时触发器，触发器没部署或失效时，
 * 「我的」页的违约次数会一直不涨 —— 用户看到的就是「明明超时了却没记违约」。
 * 这里在每次登录（含冷启动）顺手结算一次，**不依赖任何定时器**。
 *
 * 幂等保证：逐条用 `where({_id, status})` 条件更新，只有真正把
 * pending_checkin / paused 翻成 no_show 的那一次才计数；
 * 与 expireRecords 并发时也不会有两条路径同时更新成功，因此不会重复计数。
 */
async function settleMyViolations(userId, now) {
  const cutoff = new Date(Date.now() - PENDING_GRACE_MINUTES * 60 * 1000).toISOString()
  const leaveCutoff = new Date(Date.now() - LEAVE_TIMEOUT_MINUTES * 60 * 1000).toISOString()
  const base = { user_id: userId, record_type: 'reservation' }
  const jobs = [
    {
      status: 'pending_checkin',
      extra: { start_at: _.lt(cutoff) },
      patch: {
        'payload.violation_type': 'pending_timeout',
        'payload.violation_at': now,
        'payload.violation_note': `预约开始 ${PENDING_GRACE_MINUTES} 分钟内未签到`,
      },
    },
    {
      status: 'paused',
      extra: { updated_at: _.lt(leaveCutoff) },
      patch: {
        'payload.violation_type': 'leave_timeout',
        'payload.violation_at': now,
        'payload.violation_note': `暂离超过 ${LEAVE_TIMEOUT_MINUTES} 分钟未返回，座位已释放`,
      },
    },
  ]

  let settled = 0
  for (const job of jobs) {
    let rows = []
    try {
      const res = await db
        .collection(RECORDS)
        .where({ ...base, status: job.status, ...job.extra })
        .limit(50)
        .get()
      rows = res.data || []
    } catch (e) {
      continue
    }
    for (const row of rows) {
      try {
        const up = await db
          .collection(RECORDS)
          .where({ _id: row._id, status: job.status })
          .update({ data: { status: 'no_show', updated_at: now, ...job.patch } })
        if (up && up.stats && up.stats.updated === 1) settled += 1
      } catch (e) {
        // 单条失败不影响其余记录
      }
    }
  }
  return settled
}

/** 入参白名单（F7） */
const SCHEMA = {
  nickName: { type: 'string', max: 32, optional: true },
  avatarUrl: { type: 'string', max: 512, optional: true },
  /** 邀请人 userId（分享卡进入）：仅首次创建用户时写入 invited_by */
  inviter: { type: 'string', max: 64, optional: true },
  /** 首次完善资料标记：置位 profile_completed_at（由引导页提交） */
  completeProfile: { type: 'boolean', optional: true },
}

function ok(data, message) {
  return {
    success: true,
    data,
    message: message || '操作成功',
    request_id: 'req_' + Date.now(),
  }
}

function fail(message, data) {
  return {
    success: false,
    data: data || null,
    message,
    request_id: 'req_' + Date.now(),
  }
}

function hashOpenId(openId) {
  return crypto.createHash('sha256').update(openId).digest('hex').slice(0, 32)
}

/**
 * 内容安全检测（UGC 护栏）：昵称入库前过检。
 * 运行环境不支持（本地测试 mock / 未开通权限）时返回 null 放行，不阻塞登录。
 */
async function checkSafeNick(nickName) {
  const text = String(nickName || '').trim()
  if (!text) return null
  const api = cloud.openapi && cloud.openapi.security && cloud.openapi.security.msgSecCheck
  if (typeof api !== 'function') return null
  try {
    const res = await api({ content: text.slice(0, 1000) })
    const risky =
      (res && res.result && res.result.suggest === 'risky') ||
      (res && res.errCode === 87014)
    return risky ? '昵称包含敏感信息，请更换后重试' : null
  } catch (e) {
    console.warn('[msgSecCheck] skip:', (e && e.message) || e)
    return null
  }
}

function toProfile(doc) {
  return {
    userId: doc.open_id_hash || doc._id,
    openIdHash: doc.open_id_hash || doc._id,
    nickName: doc.nick_name || '专注座用户',
    avatarUrl: doc.avatar_url || '',
    role: doc.role || 'student',
    noShowCount: doc.no_show_count || 0,
    bannedUntil: doc.banned_until || '',
    // 连续签到激励：streak=连续天数，total_checkin=累计签到，last_checkin_date=最近签到日
    streak: typeof doc.streak === 'number' ? doc.streak : 0,
    totalCheckin: typeof doc.total_checkin === 'number' ? doc.total_checkin : 0,
    // 累计履约次数：签退（cancelReservation 中 status → completed）时 +1，取消不计
    totalCheckout: typeof doc.total_checkout === 'number' ? doc.total_checkout : 0,
    lastCheckinDate: doc.last_checkin_date || '',
    // 邀请裂变：invite_credit 邀请积分；invited_by 我的邀请人
    inviteCredit: typeof doc.invite_credit === 'number' ? doc.invite_credit : 0,
    invitedBy: doc.invited_by || '',
    phone: doc.phone || '',
    /** 首次完善资料的 ISO 时间；为空 = 未完成引导（前端据此弹出「完善资料」） */
    profileCompletedAt: doc.profile_completed_at || '',
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  }
}

/**
 * 微信登录 + 用户初始化
 * event.nickName / event.avatarUrl 可选（来自前端授权资料）
 */
exports.main = async (event = {}) => {
  try {
    const check = validateEvent(event, SCHEMA)
    if (!check.ok) return fail(check.error)
    const wxContext = cloud.getWXContext()
    const openId = wxContext.OPENID
    if (!openId) {
      return fail('无法获取用户身份，请在真机或已登录开发者工具中重试')
    }

    const openIdHash = hashOpenId(openId)
    const now = new Date().toISOString()
    const nickName = check.value.nickName || ''
    const avatarUrl = check.value.avatarUrl || ''
    const inviter = check.value.inviter || ''
    const completeProfile = check.value.completeProfile === true

    // UGC 护栏：昵称过检后才能入库
    const safeIssue = nickName ? await checkSafeNick(nickName) : null
    if (safeIssue) return fail(safeIssue)

    // 管理员 openId 哈希列表（环境变量，逗号分隔；勿把明文 Key 写入仓库）
    const adminHashes = String(process.env.ADMIN_OPENID_HASHES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const role = adminHashes.includes(openIdHash) ? 'admin' : 'student'

    const col = db.collection(USERS)
    let doc = null

    // 惰性结算本人已超时的预约：不依赖 expireRecords 定时触发器，
    // 保证「我的」页的违约次数 / 禁约状态在每次登录时都是真实的。
    let settled = 0
    try {
      settled = await settleMyViolations(openIdHash, now)
    } catch (e) {
      console.warn('[login] settle skipped:', (e && e.message) || e)
    }

    try {
      const found = await col.doc(openIdHash).get()
      doc = found.data
    } catch (e) {
      doc = null
    }

    if (!doc) {
      const createData = {
        open_id_hash: openIdHash,
        nick_name: nickName || '专注座用户',
        avatar_url: avatarUrl || '',
        role,
        no_show_count: 0,
        streak: 0,
        total_checkin: 0,
        total_checkout: 0,
        last_checkin_date: '',
        created_at: now,
        updated_at: now,
      }
      // 邀请人：仅首次创建记录绑定（可能为空，表示自然流量进入）
      if (inviter) {
        // 防自邀 & 防注入：邀请人不得等于本人，且要求形如 32 位 hex 哈希
        if (inviter !== openIdHash && /^[a-f0-9]{32}$/i.test(inviter)) {
          createData.invited_by = inviter.toLowerCase()
        }
      }
      try {
        await col.doc(openIdHash).set({ data: createData })
      } catch (e) {
        await col.add({ data: { _id: openIdHash, ...createData } })
      }
      doc = { _id: openIdHash, ...createData }
    } else {
      const patch = {
        updated_at: now,
        role: adminHashes.length ? role : doc.role || 'student',
      }
      if (nickName) patch.nick_name = nickName
      if (avatarUrl) patch.avatar_url = avatarUrl
      // 首次完善资料：置位后不再弹引导页（每次重复提交只是刷新时间，幂等）
      if (completeProfile) patch.profile_completed_at = now
      await col.doc(openIdHash).update({ data: patch })
      doc = { ...doc, ...patch }
    }

    // 结算出的违约次数累加到用户档，并按梯度刷新禁约截止时间
    if (settled > 0) {
      const prevCount = typeof doc.no_show_count === 'number' ? doc.no_show_count : 0
      const nextCount = prevCount + settled
      const banMs = banMinutesFor(nextCount) * 60 * 1000
      const newBan = new Date(Date.now() + banMs).toISOString()
      const prevBanMs = doc.banned_until ? Date.parse(doc.banned_until) : 0
      // 已有更晚的禁约则不缩短
      const bannedUntil =
        Number.isFinite(prevBanMs) && prevBanMs > Date.now() + banMs ? doc.banned_until : newBan
      await col
        .doc(openIdHash)
        .update({ data: { no_show_count: nextCount, banned_until: bannedUntil, updated_at: now } })
        .catch(() => {})
      doc = { ...doc, no_show_count: nextCount, banned_until: bannedUntil }
    }

    return ok(toProfile(doc), '登录成功')
  } catch (err) {
    console.error('[login]', err)
    return fail((err && err.message) || '登录失败')
  }
}
