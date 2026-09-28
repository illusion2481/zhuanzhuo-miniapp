#!/usr/bin/env node
/**
 * 全系统功能自检（本地 mock 版）
 * ============================================================
 * 用途：把「专注座」小程序**所有云函数的所有功能**用内存 mock 数据库真实跑一遍，
 *      端到端串起用户主流程、超时违约链路、管理后台、AI、通知五条线，
 *      并**对账前端调用契约**（参数名 / 白名单是否会把前端传的字段静默吃掉）。
 *
 * 运行：node scripts/full-audit.cjs
 *
 * 与 scripts/cloud-logic.test.cjs 的分工：
 *   - cloud-logic.test.cjs：单元级断言（290 项），守具体逻辑边界；
 *   - full-audit.cjs：**链路级**自检，回答「这套系统整体还能不能跑通、哪里断了」。
 *   两者互补，本脚本刻意不复用其 mock（保持测试基线绝对稳定、互不影响）。
 *
 * ⚠️ mock 的语义必须与真实 wx-server-sdk 对齐，否则会掩盖线上 bug：
 *   - runTransaction 返回**回调返回值本身**（无 {result} 包装）
 *   - where().update() 返回 { stats: { updated: n } }（login 的惰性结算靠它保幂等）
 *   - doc().set() / doc().remove() 真实存在（seedData 依赖）
 */
const Module = require('module')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.resolve(__dirname, '..')
const CLOUD = (name) => path.join(ROOT, 'cloudfunctions', name, 'index.js')

// ══════════════ 内存 mock 数据库 ══════════════
const store = {}
let WX_OPENID = 'audit-owner-001'

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32)
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString()

/** 北京时间；预约用例以「真实 now 为中心」构造 start/end，
 * 保证 checkin 用真实时钟比较时始终落在签到窗口（start±15min）内。
 * 超过营业时段（22:00+）才把基准挪到次日凌晨：此时签到类用例已被
 * IN_BIZ_HOURS 跳过，改基准仅影响「预约创建」等不依赖真实 now 的用例。
 * ⚠️ 分界必须与 IN_BIZ_HOURS（<22）对齐，否则 19:00–21:59 会出现
 * 「BASE 已挪次日、checkin 仍跑真实 now」→ 误报「尚未到签到时间」。 */
const BJ = 8 * 3600e3
const BASE_MS = (() => {
  const now = Date.now()
  const bj = new Date(now + BJ)
  if (bj.getUTCHours() < 22) return now
  return Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() + 1, 1, 0, 0) - BJ
})()
/** 营业时段守卫：checkin/leaveSeat/cancel「端到端」用例依赖真实时钟落在 start±15min 窗口内。
 * 深夜/凌晨真实时钟在关门外（晚间 22:00 后），必然报「尚未到签到时间」——这是 audit 自身
 * 的时间敏感缺陷，不是产品 bug（白天 08:00–22:00 运行全绿）。营业时段外跳过这些用例。
 * 2026-09-21 发现（用户晚间调试时 audit 假红 5 项）。 */
const IN_BIZ_HOURS = (() => {
  const bj = new Date(Date.now() + BJ)
  return bj.getUTCHours() >= 8 && bj.getUTCHours() < 22
})()
/** 相对基准生成 ISO（未来 / 同日） */
const isoB = (offsetMs) => new Date(BASE_MS + offsetMs).toISOString()

function matches(doc, cond) {
  for (const [k, v] of Object.entries(cond)) {
    const cur = doc[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v
      if ('__exists' in o) {
        const has = cur !== undefined && cur !== null
        if (o.__exists ? !has : has) return false
      }
      if ('__neq' in o && cur === o.__neq) return false
      if ('__regexp' in o) {
        try {
          if (!new RegExp(o.__regexp).test(String(cur == null ? '' : cur))) return false
        } catch { return false }
      }
      for (const op of ['__lt', '__lte', '__gt', '__gte']) {
        if (op in o) {
          const val = o[op]
          if (op === '__lt' && !(cur < val)) return false
          if (op === '__lte' && !(cur <= val)) return false
          if (op === '__gt' && !(cur > val)) return false
          if (op === '__gte' && !(cur >= val)) return false
        }
      }
    } else if (Array.isArray(v)) {
      if (v[0] && v[0].__in && !v[0].__in.includes(cur)) return false
      if (v[0] && v[0].__nin && v[0].__nin.includes(cur)) return false
    } else if (cur !== v) return false
  }
  return true
}

function applyPatch(target, data) {
  for (const [k, v] of Object.entries(data)) {
    if (k.indexOf('.') !== -1) {
      const parts = k.split('.')
      let node = target
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i]
        if (typeof node[p] !== 'object' || node[p] === null) node[p] = {}
        node = node[p]
      }
      node[parts[parts.length - 1]] = v
    } else if (v && typeof v === 'object' && v.__inc !== undefined) {
      target[k] = (typeof target[k] === 'number' ? target[k] : 0) + v.__inc
    } else {
      target[k] = v
    }
  }
  return target
}

function makeQuery(cond) {
  const q = { cond, skip: 0, limit: Infinity, order: null }
  const query = {
    skip(n) { q.skip = n; return query },
    limit(n) { q.limit = n; return query },
    orderBy(field, dir) { q.order = { field, dir }; return query },
    async get() {
      let rows = Object.values(store).filter((d) => matches(d, q.cond))
      if (q.order) {
        const sign = q.order.dir === 'desc' ? -1 : 1
        rows.sort((a, b) => {
          const av = a[q.order.field] == null ? '' : String(a[q.order.field])
          const bv = b[q.order.field] == null ? '' : String(b[q.order.field])
          return av < bv ? -sign : av > bv ? sign : 0
        })
      }
      rows = rows.slice(q.skip, q.skip + q.limit)
      return { data: JSON.parse(JSON.stringify(rows)) }
    },
    async count() {
      return { total: Object.values(store).filter((d) => matches(d, q.cond)).length }
    },
    async update({ data }) {
      const rows = Object.values(store).filter((d) => matches(d, q.cond))
      rows.forEach((r) => applyPatch(r, data))
      return { stats: { updated: rows.length } }
    },
  }
  return query
}

/* ── 聚合（aggregate）最小可用实现 ──
   studyRank 依赖 match/group/sort/limit/count。真实云数据库在服务端跑聚合，
   这里在内存里等价重放，让自检能覆盖排行榜逻辑。 */
function resolvePath(obj, expr) {
  if (typeof expr === 'string' && expr.startsWith('$')) {
    return expr.slice(1).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
  }
  return expr
}

function doGroup(rows, spec) {
  const buckets = new Map()
  rows.forEach((row) => {
    const id = resolvePath(row, spec._id)
    if (!buckets.has(id)) buckets.set(id, [])
    buckets.get(id).push(row)
  })
  const out = []
  buckets.forEach((groupRows, id) => {
    const doc = { _id: id }
    Object.entries(spec).forEach(([k, v]) => {
      if (k === '_id') return
      if (v && typeof v === 'object' && '__aggSum' in v) {
        doc[k] = groupRows.reduce((sum, r) => sum + (Number(resolvePath(r, v.__aggSum)) || 0), 0)
      }
    })
    out.push(doc)
  })
  return out
}

function makeAggregate() {
  const stages = []
  const agg = {
    match(c) { stages.push(['match', c]); return agg },
    group(g) { stages.push(['group', g]); return agg },
    sort(s) { stages.push(['sort', s]); return agg },
    limit(n) { stages.push(['limit', n]); return agg },
    count(name) { stages.push(['count', name]); return agg },
    async end() {
      let rows = Object.values(store).map((d) => JSON.parse(JSON.stringify(d)))
      for (const [type, arg] of stages) {
        if (type === 'match') rows = rows.filter((d) => matches(d, arg))
        else if (type === 'group') rows = doGroup(rows, arg)
        else if (type === 'sort') {
          const [field, dir] = Object.entries(arg)[0]
          const sign = dir === -1 || dir === 'desc' ? -1 : 1
          rows.sort((a, b) => sign * ((Number(a[field]) || 0) - (Number(b[field]) || 0)))
        } else if (type === 'limit') rows = rows.slice(0, arg)
        else if (type === 'count') return { list: [{ [arg]: rows.length }] }
      }
      return { list: rows }
    },
  }
  return agg
}

const mockDb = {
  command: {
    lt: (v) => ({ __lt: v }),
    lte: (v) => ({ __lte: v }),
    gt: (v) => ({ __gt: v }),
    gte: (v) => ({ __gte: v }),
    in: (a) => [{ __in: a }],
    nin: (a) => [{ __nin: a }],
    inc: (v) => ({ __inc: v }),
    exists: (v) => ({ __exists: v }),
    neq: (v) => ({ __neq: v }),
    and: (...args) => Object.assign({}, ...(Array.isArray(args[0]) ? args[0] : args)),
    or: (...args) => ({ __or: Array.isArray(args[0]) ? args[0] : args }),
    // 聚合表达式标记（studyRank 用 $.sum(...) 求和）
    aggregate: {
      sum: (expr) => ({ __aggSum: expr }),
    },
  },
  RegExp: (opt) => ({ __regexp: (opt && opt.regexp) || '' }),
  collection() {
    const base = {
      doc(id) {
        return {
          async get() {
            const r = store[id]
            if (!r) throw new Error('doc not found: ' + id)
            return { data: JSON.parse(JSON.stringify(r)) }
          },
          async set({ data }) {
            // 真实语义：不存在则插入，存在则整文档覆盖（保留 _id）
            store[id] = Object.assign({ _id: id }, JSON.parse(JSON.stringify(data)))
            return { stats: { updated: 1 } }
          },
          async update({ data }) {
            const r = store[id]
            if (!r) throw new Error('doc not found: ' + id)
            applyPatch(r, data)
            return { stats: { updated: 1 } }
          },
          async remove() {
            const had = !!store[id]
            delete store[id]
            return { stats: { removed: had ? 1 : 0 } }
          },
        }
      },
      where(cond) { return makeQuery(cond) },
      aggregate() { return makeAggregate() },
      limit(n) { return makeQuery({}).limit(n) },
      orderBy(f, d) { return makeQuery({}).orderBy(f, d) },
      async get() { return makeQuery({}).get() },
      async count() { return { total: Object.keys(store).length } },
      async add({ data }) {
        const id = data._id || 'auto-' + crypto.randomBytes(5).toString('hex')
        store[id] = Object.assign({ _id: id }, JSON.parse(JSON.stringify(data)))
        return { _id: id }
      },
    }
    return base
  },
  async runTransaction(callback) {
    const snapshot = JSON.parse(JSON.stringify(store))
    const transaction = { collection: () => mockDb.collection() }
    try {
      // ⚠️ 返回回调返回值本身，不做 { result } 包装（与 @cloudbase/database 一致）
      return await callback(transaction)
    } catch (err) {
      Object.keys(store).forEach((k) => delete store[k])
      Object.assign(store, snapshot)
      throw err
    }
  },
}

/** 记录跨云函数调用与订阅消息下发，便于断言 */
const notifyCalls = []
const openapiSends = []

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'wx-server-sdk') {
    const p = path.join(__dirname, '_audit_wx_sdk.cjs')
    require.cache[p] = { id: p, filename: p, loaded: true, exports: {}, children: [], paths: [] }
    require.cache[p].exports = {
      init() {},
      database() { return mockDb },
      getWXContext() { return { OPENID: WX_OPENID, APPID: 'wxtest', UNIONID: '' } },
      DYNAMIC_CURRENT_ENV: 'env',
      openapi: {
        subscribeMessage: {
          send: async (payload) => { openapiSends.push(payload); return { errCode: 0 } },
        },
      },
      callFunction: async (opts) => {
        if (opts && opts.name === 'notify') {
          notifyCalls.push(opts.data)
          const notifyFn = require(CLOUD('notify'))
          return notifyFn.main(opts.data)
        }
        if (opts && opts.name) {
          const f = require(CLOUD(opts.name))
          return f.main(opts.data || {})
        }
        return { success: true }
      },
    }
    return p
  }
  return origResolve.call(this, request, ...args)
}

// ══════════════ 断言框架 ══════════════
const rows = []
function check(area, name, cond, detail = '') {
  rows.push({ area, name, ok: !!cond, detail: cond ? '' : String(detail) })
}
/** 记录一条「发现的问题」（不阻塞流程，汇总时单列） */
const findings = []
function finding(severity, area, title, evidence) {
  findings.push({ severity, area, title, evidence })
}

const fn = (name) => require(CLOUD(name))
function resetStore() { Object.keys(store).forEach((k) => delete store[k]) }
function seedDoc(id, doc) { store[id] = Object.assign({ _id: id }, doc) }

// ══════════════ 测试数据准备 ══════════════

/** 全天开放的房间：避免因当前时刻不在营业时段导致预约用例不稳定 */
const ROOM = 'room-audit-allday'
const SEATS = ['S-1', 'S-2', 'S-3']

function seedRoom() {
  seedDoc(ROOM, {
    type: 'room',
    status: 'active',
    sort: 1,
    name: '自检自习室',
    code: 'audit',
    description: '全系统自检用',
    metadata: {
      building: '自检楼',
      floor: '1',
      open_time: '00:00',
      close_time: '23:59',
      capacity: SEATS.length,
      // 固定到店签到码：checkin 默认**强制**校验凭证（CHECKIN_REQUIRE_CODE !== '0'），
      // 房间若配了自定义码则优先用它。自检里设一个固定码，才能真实走完「带码签到」路径。
      checkin_code: '8848',
      seats: SEATS.map((id, i) => ({
        seat_id: id,
        label: id,
        row: 1,
        col: i + 1,
        features: ['quiet', 'power'],
        status: 'free',
      })),
    },
  })
}

/**
 * 写入用户档案。
 * ⚠️ 字段名必须用 **snake_case**（open_id_hash / nick_name / no_show_count / banned_until）：
 * 这是 login 云函数的存储口径，由 toProfile() 转成前端用的 camelCase。
 * 早期自检脚本误用 camelCase，导致「违约计数」永远读到 0、断言静默失效。
 */
function seedUser(openid, extra = {}) {
  const h = sha(openid)
  seedDoc(h, {
    open_id_hash: h,
    nick_name: '自检用户',
    avatar_url: '',
    role: 'student',
    no_show_count: 0,
    banned_until: '',
    created_at: iso(0),
    updated_at: iso(0),
    ...extra,
  })
  return h
}

// ══════════════ 区域 1：数据初始化 ══════════════
async function auditSeed() {
  const A = '数据初始化'
  const res = await fn('seedData').main({ includeDemoRecords: false, resetCategories: true })
  check(A, 'seedData 写入 categories 成功', res.success, JSON.stringify(res.data))
  const cats = Object.values(store).filter((d) => d.type === 'room' || d.type === 'study_goal' || d.type === 'seat_feature' || d.type === 'feedback_tag')
  check(A, 'seedData 至少写入 3 个房间', Object.values(store).filter((d) => d.type === 'room').length >= 3,
    JSON.stringify(Object.values(store).filter((d) => d.type === 'room').map((r) => r._id)))
  check(A, 'seedData 座位编号已是新格式（无补零）',
    Object.values(store).filter((d) => d.type === 'room').every((r) =>
      (r.metadata?.seats || []).every((s) => !/^[A-Za-z]+-0\d/.test(String(s.seat_id)))),
    JSON.stringify(Object.values(store).filter((d) => d.type === 'room').flatMap((r) => (r.metadata?.seats || []).map((s) => s.seat_id)).slice(0, 6)))
  void cats
}

// ══════════════ 区域 2：用户主流程 ══════════════
async function auditUserFlow() {
  const A = '用户主流程'
  WX_OPENID = 'audit-owner-001'
  seedRoom()
  seedUser(WX_OPENID)

  // ① 登录
  let r = await fn('login').main({})
  check(A, 'login 返回用户档案', r.success && r.data && r.data.role, JSON.stringify(r.data))
  const uid = sha(WX_OPENID)

  // ② 分类/房间列表
  r = await fn('categoryList').main({})
  check(A, 'categoryList 返回分类', r.success && Array.isArray(r.data), JSON.stringify(r.data).slice(0, 120))

  // ③ 房间列表（含实时占用）
  r = await fn('roomList').main({ startAt: isoB(0), endAt: isoB(2 * 3600e3) })
  const room = (r.data || []).find((x) => x.room_id === ROOM)
  check(A, 'roomList 返回全部房间', r.success && Array.isArray(r.data) && r.data.length > 0, JSON.stringify(r.data).slice(0, 120))
  check(A, 'roomList 座位带实时状态', !!room && room.seats.every((s) => ['free', 'reserved', 'maintain'].includes(s.status)),
    JSON.stringify(room && room.seats.map((s) => s.status)))
  check(A, 'roomList 返回 occupiedCount 字段', !!room && typeof room.occupiedCount === 'number',
    JSON.stringify(room && Object.keys(room)))

  // ④ 创建预约
  // start 取「5 分钟前」：既落在 checkin 的签到窗口内（start ± 15 分钟），
  // 又不会触发「待签到超 15 分钟即释放座位」的口径。
  const start = isoB(-5 * 60e3)
  const end = isoB(55 * 60e3)
  r = await fn('createReservation').main({ room_id: ROOM, seat_id: 'S-1', start_at: start, end_at: end, goal: '自检' })
  const recId = r.data && (r.data._id || r.data.record_id || (r.data.record && r.data.record._id))
  check(A, 'createReservation 创建成功', r.success && !!recId, JSON.stringify(r))
  check(A, 'createReservation 初始状态为 pending_checkin',
    !!recId && store[recId] && store[recId].status === 'pending_checkin',
    JSON.stringify(recId && store[recId] && store[recId].status))

  // ⑤ 同座位重复预约被拦（座位冲突）
  r = await fn('createReservation').main({ room_id: ROOM, seat_id: 'S-1', start_at: start, end_at: end })
  check(A, '同座位重复预约被拦截', !r.success && /SEAT_CONFLICT|已被|占用/.test(String(r.message || '') + String(r.code || '')),
    JSON.stringify(r))

  // ⑥ 同一用户重复预约被拦（用户冲突）
  r = await fn('createReservation').main({ room_id: ROOM, seat_id: 'S-2', start_at: start, end_at: end })
  check(A, '同一用户同时段重复预约被拦截', !r.success, JSON.stringify(r))

  // ⑦ 预约后座位图变红
  r = await fn('roomList').main({ startAt: start, endAt: end })
  const s1 = ((r.data || []).find((x) => x.room_id === ROOM) || {}).seats?.find((s) => s.seat_id === 'S-1')
  check(A, '预约后座位图显示 reserved', !!s1 && s1.status === 'reserved', JSON.stringify(s1))

  // ⑧ 签到（到店凭证：错误码先被拒，正确码才放行）
  // ⚠️ 依赖真实时钟：深夜/凌晨真实 now 不在营业窗口，checkin 会判「尚未到签到时间」，
  // 这是 audit 的时间敏感缺陷（白天 08:00 后运行全绿）→ 非营业时段整段跳过。
  if (IN_BIZ_HOURS) {
    r = await fn('checkin').main({ record_id: recId, checkin_code: '0000' })
    check(A, 'checkin 拒绝错误签到码', !r.success && r.code === 'NEED_CHECKIN_CODE', JSON.stringify(r))
    r = await fn('checkin').main({ record_id: recId, checkin_code: '8848' })
    check(A, 'checkin 使 pending_checkin → active', r.success && store[recId].status === 'active',
      JSON.stringify({ res: r, status: store[recId] && store[recId].status }))

    // ⑨ 暂离 / 返回
    r = await fn('leaveSeat').main({ action: 'leave', record_id: recId })
    check(A, 'leaveSeat.leave 使 active → paused', r.success && store[recId].status === 'paused',
      JSON.stringify({ res: r, status: store[recId] && store[recId].status }))
    r = await fn('leaveSeat').main({ action: 'return', record_id: recId })
    check(A, 'leaveSeat.return 使 paused → active', r.success && store[recId].status === 'active',
      JSON.stringify({ res: r, status: store[recId] && store[recId].status }))
  }

  // ⑩ 学习记录状态机
  r = await fn('studyRecord').main({ action: 'start', reservation_id: recId, room_id: ROOM, seat_id: 'S-1', goal: '自检学习' })
  const studyId = r.data && (r.data._id || r.data.record_id)
  check(A, 'studyRecord.start 创建学习记录', r.success && !!studyId, JSON.stringify(r))
  check(A, '学习记录初态为 running', !!studyId && store[studyId] && store[studyId].status === 'running',
    JSON.stringify(studyId && store[studyId] && store[studyId].status))
  r = await fn('studyRecord').main({ action: 'pause', record_id: studyId })
  // ⚠️ 暂停**不改 status**（仍为 running）：学习记录用「未闭合的 pause_segment」表达暂停中，
  // 这样多段暂停可精确累加，暂停时长也不会被算进专注时长。
  const pauseSegs = store[studyId].payload.pause_segments || []
  check(A, 'studyRecord.pause 打开未闭合的暂停段',
    r.success && pauseSegs.length >= 1 && pauseSegs[pauseSegs.length - 1].end == null,
    JSON.stringify({ res: r, segs: pauseSegs }))
  r = await fn('studyRecord').main({ action: 'resume', record_id: studyId })
  check(A, 'studyRecord.resume → running', r.success && store[studyId].status === 'running', JSON.stringify(r))
  r = await fn('studyRecord').main({ action: 'sync_pomodoro', record_id: studyId, focus_min: 25, break_min: 5, segments: [{ type: 'focus', start: iso(0), end: iso(60e3), completed: true }] })
  check(A, 'studyRecord.sync_pomodoro 写入番茄段', r.success, JSON.stringify(r))
  r = await fn('studyRecord').main({ action: 'complete', record_id: studyId })
  check(A, 'studyRecord.complete → completed', r.success && store[studyId].status === 'completed', JSON.stringify(r))

  // ⑪ 结束使用（已签到的预约 → 提前结束）
  // 语义依赖 ⑧⑨ 已将 recId 置为 active/paused（守卫跳过时 recId 仍为 pending_checkin，
  // cancel 会走「待签取消 → 发取消通知」分支，与断言冲突）→ 一并守卫。
  if (IN_BIZ_HOURS) {
    notifyCalls.length = 0
    r = await fn('cancelReservation').main({ record_id: recId })
    check(A, 'cancelReservation 使 active → completed', r.success && ['completed', 'cancelled'].includes(store[recId].status),
      JSON.stringify({ res: r, status: store[recId] && store[recId].status }))
    // 设计如此：已开始使用（active/paused）的「结束使用」**不发**取消通知 ——
    // 只有「还没开始就被取消」才发，免得白弹授权卡、也免得推一条让人困惑的「已取消」。
    check(A, '「结束使用」不发取消通知（符合设计）', notifyCalls.length === 0, JSON.stringify(notifyCalls))
  }

  // 对照：待签到的预约被取消 → 应发取消通知
  notifyCalls.length = 0
  r = await fn('createReservation').main({ room_id: ROOM, seat_id: 'S-2', start_at: isoB(120 * 60e3), end_at: isoB(180 * 60e3) })
  const recId3 = r.data && (r.data._id || r.data.record_id || (r.data.record && r.data.record._id))
  if (recId3) {
    await fn('cancelReservation').main({ record_id: recId3 })
    check(A, '取消「未开始」的预约会发取消通知', notifyCalls.length > 0, JSON.stringify(notifyCalls.length))
  } else {
    check(A, '取消「未开始」的预约会发取消通知', false, '创建对照预约失败：' + JSON.stringify(r))
  }

  // ⑫ 改约（依赖 ⑪ 已释放 recId 的时段：非营业跳过 ⑪ 时 recId 仍占用，
  // 会导致 USER_CONFLICT → 与 ⑪ 同一守卫，营业时段才断言）
  if (IN_BIZ_HOURS) {
    r = await fn('createReservation').main({ room_id: ROOM, seat_id: 'S-3', start_at: start, end_at: end })
    const recId2 = r.data && (r.data._id || r.data.record_id)
    check(A, '结束使用后可再次预约', r.success && !!recId2, JSON.stringify(r))
    if (recId2) {
      r = await fn('updateReservation').main({ record_id: recId2, start_at: isoB(40 * 60e3), end_at: isoB(100 * 60e3) })
      check(A, 'updateReservation 改约成功', r.success, JSON.stringify(r))
    }
  }

  // ⑬ 学习汇总 / 排行
  r = await fn('studyRecord').main({ action: 'summary', since: iso(-7 * 24 * 3600e3) })
  check(A, 'studyRecord.summary 返回汇总', r.success, JSON.stringify(r).slice(0, 160))
  r = await fn('studyRecord').main({ action: 'list_reservations', limit: 20 })
  check(A, 'studyRecord.list_reservations 返回预约列表', r.success, JSON.stringify(r).slice(0, 160))
  r = await fn('studyRank').main({ period: 'all' })
  check(A, 'studyRank 返回排行榜', r.success && Array.isArray(r.data.top), JSON.stringify(r).slice(0, 160))
}

// ══════════════ 区域 3：超时与违约 ══════════════
async function auditTimeout() {
  const A = '超时与违约'
  resetStore()
  seedRoom()
  seedUser(WX_OPENID)
  const uid = sha(WX_OPENID)

  // ① 待签到超时 → no_show + 违约计数
  seedDoc('res-timeout-1', {
    record_type: 'reservation', status: 'pending_checkin', room_id: ROOM, seat_id: 'S-1',
    user_id: uid, open_id_hash: uid, start_at: iso(-30 * 60e3), end_at: iso(30 * 60e3),
    created_at: iso(-60 * 60e3), updated_at: iso(-60 * 60e3), payload: {},
  })
  let r = await fn('expireRecords').main({})
  check(A, 'expireRecords 执行成功', r.success !== false, JSON.stringify(r))
  check(A, '待签到超时 → no_show', store['res-timeout-1'].status === 'no_show',
    JSON.stringify(store['res-timeout-1'].status))
  check(A, '超时释放座位（roomList 不再占用）', await (async () => {
    const rr = await fn('roomList').main({ startAt: iso(-40 * 60e3), endAt: iso(40 * 60e3) })
    const seat = ((rr.data || []).find((x) => x.room_id === ROOM) || {}).seats?.find((s) => s.seat_id === 'S-1')
    return seat && seat.status === 'free'
  })())

  // ② 暂离超时 → no_show
  seedDoc('res-timeout-2', {
    record_type: 'reservation', status: 'paused', room_id: ROOM, seat_id: 'S-2',
    user_id: uid, open_id_hash: uid, start_at: iso(-2 * 3600e3), end_at: iso(3600e3),
    created_at: iso(-3 * 3600e3), updated_at: iso(-45 * 60e3), payload: {},
  })
  await fn('expireRecords').main({})
  check(A, '暂离超时 → no_show（座位释放）', store['res-timeout-2'].status === 'no_show',
    JSON.stringify(store['res-timeout-2'].status))

  // ③ login 的惰性结算：**故意不跑 expireRecords**，
  //    验证「定时器未部署 / 执行失败时靠登录兜底」这条设计真的生效。
  seedDoc(uid, Object.assign({}, store[uid], { no_show_count: 0, banned_until: '' }))
  seedDoc('res-timeout-3', {
    record_type: 'reservation', status: 'pending_checkin', room_id: ROOM, seat_id: 'S-3',
    user_id: uid, open_id_hash: uid, start_at: iso(-40 * 60e3), end_at: iso(20 * 60e3),
    created_at: iso(-70 * 60e3), updated_at: iso(-70 * 60e3), payload: {},
  })
  const before = (store[uid] || {}).no_show_count || 0
  await fn('login').main({})
  const after = (store[uid] || {}).no_show_count || 0
  check(A, 'login 惰性结算使违约计数 +1（不依赖定时器）', after === before + 1,
    JSON.stringify({ before, after, recStatus: store['res-timeout-3'] && store['res-timeout-3'].status }))

  // ④ 达阈值后禁约
  seedDoc(uid, Object.assign({}, store[uid], { noShowCount: 3, bannedUntil: iso(24 * 3600e3) }))
  r = await fn('createReservation').main({ room_id: ROOM, seat_id: 'S-3', start_at: isoB(30 * 60e3), end_at: isoB(90 * 60e3) })
  check(A, '违约达阈值后预约被禁（BANNED）', !r.success && /BANNED|禁止|违约/.test(String(r.code || '') + String(r.message || '')),
    JSON.stringify(r))

  // ⑤ 管理员解禁 / 清违约（放在管理区再测，这里只记录状态）
  void before
}

// ══════════════ 区域 4：管理后台 ══════════════
async function auditAdmin() {
  const A = '管理后台'
  resetStore()
  seedRoom()
  seedUser(WX_OPENID, { role: 'admin' })   // 以「role=admin」身份测管理端（不依赖环境变量）
  const uid = sha(WX_OPENID)

  let r = await fn('adminOps').main({ action: 'overview' })
  check(A, 'adminOps.overview 成功', r.success, JSON.stringify(r).slice(0, 200))

  r = await fn('adminOps').main({ action: 'listReservations', limit: 20 })
  check(A, 'adminOps.listReservations 成功', r.success, JSON.stringify(r).slice(0, 160))

  r = await fn('adminOps').main({ action: 'listUsers', limit: 20 })
  check(A, 'adminOps.listUsers 成功', r.success, JSON.stringify(r).slice(0, 160))

  // 房间与座位管理
  r = await fn('adminOps').main({ action: 'upsertRoom', room_id: ROOM, name: '自检自习室（改名）', open_time: '08:00', close_time: '22:00' })
  check(A, 'adminOps.upsertRoom 成功', r.success, JSON.stringify(r).slice(0, 160))

  r = await fn('adminOps').main({ action: 'setRoomStatus', room_id: ROOM, status: 'active' })
  check(A, 'adminOps.setRoomStatus 成功', r.success, JSON.stringify(r).slice(0, 160))

  r = await fn('adminOps').main({ action: 'addSeats', room_id: ROOM, prefix: 'S', count: 3 })
  const seatIds = (store[ROOM].metadata.seats || []).map((s) => s.seat_id)
  check(A, 'adminOps.addSeats 新增座位成功', r.success, JSON.stringify(r).slice(0, 200))
  check(A, '新增座位编号连续（先补空号后顺延）',
    seatIds.join(',') === 'S-1,S-2,S-3,S-4,S-5,S-6', JSON.stringify(seatIds))

  r = await fn('adminOps').main({ action: 'updateSeat', room_id: ROOM, seat_id: 'S-4', features: ['window'] })
  const s4 = (store[ROOM].metadata.seats || []).find((s) => s.seat_id === 'S-4')
  check(A, 'adminOps.updateSeat 保存属性', r.success && s4 && s4.features.join(',') === 'window',
    JSON.stringify({ res: r, s4 }))

  r = await fn('adminOps').main({ action: 'removeSeats', room_id: ROOM, seat_ids: ['S-4'] })
  // 注意：删除后编号会**自动前移**（S-5→S-4、S-6→S-5），所以不能断言「不存在 S-4」，要看总数
  const seatsAfterRemove = store[ROOM].metadata.seats || []
  check(A, 'adminOps.removeSeats 删除座位（总数 6→5）', r.success && seatsAfterRemove.length === 5,
    JSON.stringify({ res: r, n: seatsAfterRemove.length }))
  check(A, '删除后编号自动前移（S-5→S-4, S-6→S-5）',
    (store[ROOM].metadata.seats || []).map((s) => s.seat_id).join(',') === 'S-1,S-2,S-3,S-4,S-5',
    JSON.stringify((store[ROOM].metadata.seats || []).map((s) => s.seat_id)))

  r = await fn('adminOps').main({ action: 'renumberSeats', room_id: ROOM })
  check(A, 'adminOps.renumberSeats 幂等（已连续无改动）',
    r.success && (r.data.renumbered || []).length === 0, JSON.stringify(r).slice(0, 200))

  r = await fn('adminOps').main({ action: 'batchSeatStatus', room_id: ROOM, seat_ids: ['S-5'], status: 'maintain' })
  check(A, 'adminOps.batchSeatStatus 设维护成功', r.success, JSON.stringify(r).slice(0, 160))

  r = await fn('adminOps').main({ action: 'checkinCodes' })
  check(A, 'adminOps.checkinCodes 成功', r.success, JSON.stringify(r).slice(0, 200))

  r = await fn('adminOps').main({ action: 'setCheckinCode', room_id: ROOM, code: '8888' })
  check(A, 'adminOps.setCheckinCode 成功', r.success, JSON.stringify(r).slice(0, 160))

  // 用户管理
  r = await fn('adminOps').main({ action: 'userAction', user_id: uid, op: 'clear_penalty' })
  check(A, 'adminOps.userAction.clear_penalty 成功', r.success, JSON.stringify(r).slice(0, 200))
  r = await fn('adminOps').main({ action: 'userAction', user_id: uid, op: 'unban' })
  check(A, 'adminOps.userAction.unban 成功', r.success, JSON.stringify(r).slice(0, 200))

  // 未知 action
  r = await fn('adminOps').main({ action: 'no_such_action' })
  check(A, 'adminOps 未知 action 返回 UNKNOWN_ACTION', !r.success, JSON.stringify(r).slice(0, 160))

  // 座位维护专用函数
  r = await fn('adminSeatMaintain').main({ room_id: ROOM, seat_id: 'S-1', status: 'maintain' })
  check(A, 'adminSeatMaintain 设维护成功', r.success, JSON.stringify(r).slice(0, 160))

  // 统计（此处重点验证「role=admin 能否通过鉴权」）
  r = await fn('adminStats').main({})
  check(A, 'adminStats 在 role=admin（未配环境变量）下可用', r.success,
    JSON.stringify(r).slice(0, 240))
  if (!r.success) {
    finding('P0', A, 'adminStats 鉴权缺少 users.role 回退',
      'adminStats 只认环境变量 ADMIN_OPENID_HASHES；adminOps / adminSeatMaintain 都支持 users.role === "admin" 回退。' +
      '未配环境变量时，已是 admin 的账号在管理页看统计必然失败。返回：' + JSON.stringify(r).slice(0, 200))
  }

  // 管理端 reservationAction
  seedDoc('res-admin-1', {
    record_type: 'reservation', status: 'pending_checkin', room_id: ROOM, seat_id: 'S-1',
    user_id: uid, open_id_hash: uid, start_at: isoB(30 * 60e3), end_at: isoB(90 * 60e3),
    created_at: iso(0), updated_at: iso(0), payload: {},
  })
  r = await fn('adminOps').main({ action: 'reservationAction', record_id: 'res-admin-1', op: 'cancel' })
  check(A, 'adminOps.reservationAction.cancel 成功', r.success, JSON.stringify(r).slice(0, 200))
}

// ══════════════ 区域 5：AI 与通知 ══════════════
async function auditAiNotify() {
  const A = 'AI 与通知'
  resetStore()
  seedRoom()
  seedUser(WX_OPENID)
  const uid = sha(WX_OPENID)

  let r = await fn('aiRecommend').main({ action: 'recommend', goal: '期末复习', durationMinutes: 60 })
  check(A, 'aiRecommend.recommend 可用（无 AI 配置时降级）',
    r.success === true || /AI_NOT_CONFIGURED/.test(String(r.code || '')),
    JSON.stringify(r).slice(0, 200))
  check(A, 'aiRecommend 降级推荐不推「已被占用」的座位（_free 过滤生效）',
    !r.success || !Array.isArray(r.data?.recommendations) || r.data.recommendations.every((x) => x.seat_id !== 'S-1'),
    JSON.stringify(r).slice(0, 240))

  r = await fn('aiRecommend').main({ action: 'generate_plan', goal: '备考', durationMinutes: 120 })
  check(A, 'aiRecommend.generate_plan 可用', r.success === true || /AI_NOT_CONFIGURED/.test(String(r.code || '')),
    JSON.stringify(r).slice(0, 160))

  r = await fn('aiRecommend').main({ action: 'recommend_courses', goal: '期末复习', durationMinutes: 60 })
  const coursesOk =
    r.success === true ||
    /AI_NOT_CONFIGURED/.test(String(r.code || ''))
    || (typeof r === 'object' && r && r.data && Array.isArray(r.data.courses) && r.data.courses.length > 0)
  check(A, 'aiRecommend.recommend_courses 可用或优雅降级', coursesOk, JSON.stringify(r).slice(0, 160))

  r = await fn('aiSummary').main({})
  check(A, 'aiSummary 可用（无记录/无 AI 时优雅降级）',
    r.success === true || /NO_RECORDS|AI_NOT_CONFIGURED/.test(String(r.code || '')),
    JSON.stringify(r).slice(0, 160))

  // 通知
  notifyCalls.length = 0
  const savedOpenid = WX_OPENID
  WX_OPENID = ''                       // 模拟「拿不到用户身份」（定时器 / 异常上下文）
  r = await fn('notify').main({ action: 'send' })
  check(A, 'notify 缺少接收人时返回 NO_OPENID', !r.success && r.code === 'NO_OPENID', JSON.stringify(r))
  WX_OPENID = savedOpenid

  r = await fn('notify').main({ action: 'send', openid: WX_OPENID })
  check(A, 'notify 缺模板时返回 NO_TEMPLATE（不抛错）', !r.success && r.code === 'NO_TEMPLATE', JSON.stringify(r))
  r = await fn('notify').main({ action: 'send', openid: WX_OPENID, templateId: 'TPL_X', data: { thing1: { value: '自习室' } } })
  check(A, 'notify 带模板可下发（兼容旧路径）', r.success, JSON.stringify(r).slice(0, 160))
  // 新路径（前端实际走这条）：传 type，由云端查表 + clamp + 北京时间格式化
  r = await fn('notify').main({
    action: 'send', openid: WX_OPENID, type: 'reservationConfirmed',
    main: '一楼自习室', time: iso(3600e3), extra: '座位 A-1',
  })
  check(A, 'notify 传 type 可下发（前端实际路径）', r.success, JSON.stringify(r).slice(0, 160))
  const lastSend = openapiSends[openapiSends.length - 1] || {}
  const timeVal = String((lastSend.data && lastSend.data.time2 && lastSend.data.time2.value) || '')
  check(A, 'notify 把时间型关键词格式化为北京时间', /年.*月.*日/.test(timeVal), JSON.stringify(timeVal))
  check(A, 'notify 下发进入 openapi 调用记录', openapiSends.length > 0, JSON.stringify(openapiSends.length))

  // 「模板 ID 有两份真源」是一致性风险：**授权**用前端那份、**发送**用云端那份，
  // 一旦不一致就会出现「授权了 A 模板、却用 B 模板发送」→ 用户永远收不到通知。
  const cfg = require('fs').readFileSync(path.join(ROOT, 'miniprogram/subpages/config/subscribe.ts'), 'utf8')
  const cloudSrc = require('fs').readFileSync(CLOUD('notify'), 'utf8')
  // 两边书写格式不同（云端 `id: process.env.TPL_X || '真实ID'`，前端 `key: '真实ID'`）：
  // 按 key 定位后，取该片段里第一个 30 位以上的引号串（模板 ID 固定 43 位）。
  // 两个文件里同名 key 会出现 2~3 次（头部注释列表、真正的模板定义、以及 SUBSCRIBE_KEYS 的
  // 关键词映射表），所以不能靠 indexOf / lastIndexOf 定位，必须按**定义形态**匹配：
  //   前端 `key: 'ID'`；云端 `key: { id: process.env.TPL_X || 'ID' }`
  const pick = (src, key) => {
    const re = new RegExp(key + "\\s*:\\s*(?:\\{[\\s\\S]{0,240}?)?'([A-Za-z0-9_-]{30,})'")
    const m = src.match(re)
    return m ? m[1] : ''
  }
  const pairs = ['reservationConfirmed', 'checkinReminder', 'reservationWarn', 'reservationCancel']
  const mismatch = pairs.filter((k) => pick(cfg, k) !== pick(cloudSrc, k))
  check(A, '前端与云端的模板 ID 完全一致（无口径分裂）', mismatch.length === 0,
    JSON.stringify(mismatch.map((k) => ({ k, fe: pick(cfg, k), be: pick(cloudSrc, k) }))))
  if (mismatch.length) {
    finding('P1', A, '订阅模板 ID 存在两份真源且不一致',
      'miniprogram/subpages/config/subscribe.ts 与 cloudfunctions/notify/index.js 各存一份模板 ID，不一致时会出现「授权用 A、发送用 B」。' +
      '当前不一致项：' + JSON.stringify(mismatch))
  }
  void uid
}

// ══════════════ 区域 6：前后端参数契约 ══════════════
async function auditContract() {
  const A = '参数契约'
  resetStore()
  seedRoom()
  seedUser(WX_OPENID)

  // ① studyRecord.list 传 record_type / user_id —— 前端 services/record.ts 的 RecordListQuery 会带这些字段
  let r = await fn('studyRecord').main({ action: 'list', record_type: 'reservation', user_id: 'x', limit: 10 })
  const leaked = r.success && (r.data?.list || []).some((x) => x.record_type === 'reservation')
  check(A, 'studyRecord.list 不会因 record_type 参数而返回错误类型的数据', !leaked, JSON.stringify(r).slice(0, 200))
  if (leaked) {
    finding('P1', A, 'studyRecord.list 的入参白名单缺 record_type/user_id',
      '前端 RecordListQuery 声明并可能传入 record_type / room_id / seat_id / user_id，' +
      '但云端 SCHEMA 未声明 → validateEvent 静默剥离；且 list 分支把 record_type 硬编码为 study。' +
      '若用 list 查预约会静默返回学习记录（看似成功、数据是错的）。')
  }

  // ② roomList 传 date / features —— 前端 RoomQuery 声明了这两个字段
  r = await fn('roomList').main({ date: iso(0), features: ['window'] })
  check(A, 'roomList 对未声明字段不报错（但不能静默失效）', r.success, JSON.stringify(r).slice(0, 160))
  const roomQuery = require('fs').readFileSync(path.join(ROOT, 'miniprogram/services/room.ts'), 'utf8')
  const declaresUnsupported = /date\?:/.test(roomQuery) || /features\?:/.test(roomQuery)
  check(A, 'RoomQuery 不再声明云端不支持的 date/features', !declaresUnsupported,
    'services/room.ts 的 RoomQuery 声明了 date/features，但 roomList 白名单只有 startAt/endAt')
  if (declaresUnsupported) {
    finding('P2', A, 'RoomQuery 声明了云端不接受的参数',
      'miniprogram/services/room.ts 的 RoomQuery 含 date/features，listRooms 会 { ...query } 透传给 roomList，' +
      '而 roomList 的 SCHEMA 只有 startAt/endAt → 参数被静默剥离。当前调用方未传，故暂无外显症状，属埋雷。')
  }

  // ③ 占用拦截错误码是否统一
  //    ⚠️ 必须先剔除注释再匹配：修复后代码里可能仍留有「原先是 SEAT_BUSY…」这类说明文字，
  //    直接 grep 会把注释误判成还在用旧码（自检脚本自己踩过这个坑）。
  const stripComments = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const adminPage = require('fs').readFileSync(path.join(ROOT, 'miniprogram/pages/admin/admin.ts'), 'utf8')
  const declaredCodes = new Set()
  ;[CLOUD('adminOps'), CLOUD('adminSeatMaintain')].forEach((file) => {
    const src = stripComments(require('fs').readFileSync(file, 'utf8'))
    const hits = src.match(/'SEAT_(?:BUSY|OCCUPIED)'/g) || []
    hits.forEach((h) => declaredCodes.add(h.replace(/'/g, '')))
  })
  const pageHandles = /SEAT_(?:OCCUPIED|BUSY)/.test(adminPage) ? ['有对应处理'] : []
  check(A, '占用拦截错误码前后端统一（后端只用一种且前端有处理）',
    declaredCodes.size === 1 && pageHandles.length === 1,
    JSON.stringify({ backendCodes: [...declaredCodes], pageHandles }))
  if (declaredCodes.size > 1) {
    finding('P2', A, '座位占用拦截错误码不统一（SEAT_BUSY / SEAT_OCCUPIED）',
      'adminOps 与 adminSeatMaintain 各返回一种码；管理页只对其中一种给友好提示，' +
      '走另一条路径时用户只看到笼统的「修改失败」。')
  }

  // ④ 座位状态枚举：in_use 是**容错取值**（SeatMap / rooms 会把 active/occupied/using 归一为 in-use）
  const roomDts = require('fs').readFileSync(path.join(ROOT, 'miniprogram/types/room.d.ts'), 'utf8')
  const seatMapSrc = require('fs').readFileSync(path.join(ROOT, 'miniprogram/components/SeatMap/SeatMap.ts'), 'utf8')
  const roomsSrc = require('fs').readFileSync(path.join(ROOT, 'miniprogram/pages/rooms/rooms.ts'), 'utf8')
  const hasInUse = /'in_use'/.test(roomDts)
  const hasNormFallback = /in_use/.test(seatMapSrc) && /in_use/.test(roomsSrc)
  check(A, 'in_use 类型声明有对应的状态归一化兜底', !hasInUse || hasNormFallback,
    JSON.stringify({ hasInUse, hasNormFallback }))

  // ⑤ floor 类型
  // ⑤ floor 类型：三处统一为字符串（前端声明 / adminOps 写入 / seed 初始数据）
  const adminOpsSrc = require('fs').readFileSync(CLOUD('adminOps'), 'utf8')
  const seedSrc = require('fs').readFileSync(path.join(ROOT, 'cloudfunctions/seedData/seedPayload.js'), 'utf8')
  const floorDeclaredString = /floor\?: string/.test(roomDts)
  const floorNormalizedString = /floor:\s*String\(/.test(adminOpsSrc)
  const seedFloorIsString = /floor:\s*'/.test(seedSrc)
  check(A, 'floor 统一为字符串类型（前端声明 / 云端写入 / seed 一致）',
    floorDeclaredString && floorNormalizedString && seedFloorIsString,
    JSON.stringify({ floorDeclaredString, floorNormalizedString, seedFloorIsString }))
  if (!(floorDeclaredString && floorNormalizedString && seedFloorIsString)) {
    finding('P2', A, 'floor 类型前后端不一致',
      '云端 adminOps 写入 floor: String(...)，前端 RoomSummary 声明 floor: number —— ' +
      '类型承诺与实际数据不符。统一为字符串（表单输入本身就是字符串）。')
  }

  // ⑥ occupiedCount 是否被前端使用
  const roomTypesHasOccupied = /occupiedCount/.test(roomDts)
  check(A, 'roomList 返回的 occupiedCount 已被前端声明使用', roomTypesHasOccupied,
    'cloudfunctions/roomList 返回 occupiedCount，但 types/room.d.ts 的 RoomSummary 未声明、全项目无人读取')
  if (!roomTypesHasOccupied) {
    finding('P2', A, 'roomList 返回的 occupiedCount 无人使用',
      '云端计算并下发 occupiedCount，但前端类型未声明、无任何页面读取 → 白算，且房间卡片无法显示「已占用 N」。')
  }

  // ⑦ aiRecommend.recommend 是否有前端入口
  const recSrc = require('fs').readFileSync(path.join(ROOT, 'miniprogram/services/recommendation.ts'), 'utf8')
  const recommendSeatsUsed = (() => {
    // 用 Node 原生递归扫描，不依赖外部 grep —— Windows 下没有 grep 会静默返回空，
    // 导致「明明有调用却报功能不存在」的假阳性结论。
    const fs = require('fs')
    const hits = []
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'miniprogram_npm') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|wxml)$/.test(entry.name)) continue
        if (full.replace(/\\/g, '/').endsWith('/recommendation.ts')) continue
        try {
          if (fs.readFileSync(full, 'utf8').includes('recommendSeats')) hits.push(full)
        } catch {
          // 忽略不可读文件
        }
      }
    }
    try {
      walk(path.join(ROOT, 'miniprogram'))
    } catch {
      // 目录不存在时按无调用处理
    }
    return hits
  })()
  check(A, 'aiRecommend.recommend 存在可触达的前端入口', recommendSeatsUsed.length > 0,
    JSON.stringify({ defined: /export async function recommendSeats/.test(recSrc), callers: recommendSeatsUsed }))
  if (!recommendSeatsUsed.length && /export async function recommendSeats/.test(recSrc)) {
    finding('P1', A, 'AI 座位推荐（recommend）无任何前端入口',
      'services/recommendation.ts 的 recommendSeats() 全项目 0 调用（仅定义处出现），' +
      '云端 aiRecommend 的 recommend 分支与 _free 实时占用过滤因此永远走不到 —— 功能其实不存在。')
  }
}

// ══════════════ 主流程 ══════════════
;(async () => {
  const areas = [
    ['数据初始化', auditSeed],
    ['用户主流程', auditUserFlow],
    ['超时与违约', auditTimeout],
    ['管理后台', auditAdmin],
    ['AI 与通知', auditAiNotify],
    ['参数契约', auditContract],
  ]
  for (const [name, run] of areas) {
    try {
      await run()
    } catch (err) {
      check(name, '区域执行未抛异常', false, (err && err.stack) || String(err))
    }
  }

  // ---- 输出 ----
  let lastArea = ''
  let pass = 0
  let fail = 0
  rows.forEach((r) => {
    if (r.area !== lastArea) {
      console.log(`\n── ${r.area} ──`)
      lastArea = r.area
    }
    if (r.ok) { pass += 1; console.log(`  PASS  ${r.name}`) }
    else { fail += 1; console.log(`  FAIL  ${r.name}\n        ${r.detail}`) }
  })

  console.log('\n══════════════ 汇总 ══════════════')
  console.log(`断言：pass=${pass} fail=${fail} 共 ${rows.length} 项`)

  if (findings.length) {
    console.log(`\n发现的问题（${findings.length} 条）：`)
    findings
      .sort((a, b) => a.severity.localeCompare(b.severity))
      .forEach((f) => {
        console.log(`  [${f.severity}] ${f.area} · ${f.title}`)
        console.log(`        ${f.evidence}`)
      })
  } else {
    console.log('\n未发现问题。')
  }
  process.exit(fail > 0 ? 1 : 0)
})()
