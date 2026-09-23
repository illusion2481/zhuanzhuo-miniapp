/**
 * 云函数逻辑单元测试（本地 mock 版）
 * -------------------------------------------------
 * 用途：在无云环境时，用内存 mock 数据库一次性走查关键云函数的核心状态机与边界逻辑。
 * 运行：node scripts/cloud-logic.test.cjs
 * 说明：只验证纯逻辑（状态流转/鉴权/字段写入/分页），不验证真实云数据库能力与网络。
 *
 * 覆盖（对应 PLAN-v3 §0.5 F11-F14 及 F5/F6/F8/F9）：
 *   - leaveSeat         暂离/返回状态机（active↔paused）+ 越权拦截 + 未知 action
 *   - expireRecords     超时自动处理 + >100 条分页拉全量 + 分批并发写入
 *   - studyRecord       computeActiveSeconds 单元（多段暂停/跨天/未闭合）
 *                       start 单 running 防重 / complete 状态机 / summary >200 条统计 / list 分页
 *   - createReservation 座位冲突 / 用户冲突 / 成功写入 / 入参校验
 *   - adminStats        鉴权（未配置/白名单外/放行）+ 统计口径快照 + 入参校验
 *   - checkin           时间窗边界 / 扫码座位号规范化比对 / 归属 / 状态守卫
 *   - validator         validateEvent 白名单/类型/长度单元
 *   - 暂离占用口径      roomList / createReservation / cancelReservation 对 paused 的处理
 *   - adminSeatMaintain 管理员设置/解除座位维护（鉴权 + 占用护栏 + 整数组回写）
 */
const Module = require('module')
const path = require('path')
const crypto = require('crypto')

// ============ 内存 mock 数据库 ============
const store = {}
let WX_OPENID = 'owner-001'
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32)
const OWNER_HASH = hash('owner-001')
const OTHER_HASH = hash('other-001')

const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString()

/**
 * 预约用例专用的时间基准 + 偏移构造。
 *
 * ⚠️ 为什么不能直接用 now + 偏移（2026-09-16 20:01 实测踩坑，用例误报失败）：
 * createReservation 对「同日营业」的房间（如 room-tx / r-persist，00:00-23:59）
 * 有「预约须在同一天内」校验。20:00 之后跑测试时 now+3h~now+4h 直接跨天 →
 * 报「预约须在同一天内」，用例挂掉但代码其实没问题。
 *
 * 同时窗口必须落在「未来」：否则会被超时释放口径（releasedByTimeout）当成
 * 已释放记录，座位/用户冲突断言会**静默失效** —— 所以不能简单回拨到过去。
 *
 * 取法：当天还放得下（北京 19:00 之前，+4h 不跨天）就用「现在」；
 * 放不下就顺延到次日 01:00（仍是未来、且 +4h 不跨天）。
 */
const BJ_OFFSET_MS = 8 * 3600e3
const BOOKING_BASE_MS = (() => {
  const now = Date.now()
  const bj = new Date(now + BJ_OFFSET_MS)
  if (bj.getUTCHours() < 19) return now
  return Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() + 1, 1, 0, 0) - BJ_OFFSET_MS
})()
/** 相对基准生成 ISO：始终在未来，且 start/end 永远同一天 */
const isoB = (offsetMs) => new Date(BOOKING_BASE_MS + offsetMs).toISOString()

function matches(doc, cond) {
  for (const [k, v] of Object.entries(cond)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('__exists' in v) {
        const has = doc[k] !== undefined && doc[k] !== null
        if (v.__exists ? !has : has) return false
      }
      if ('__neq' in v) {
        if (doc[k] === v.__neq) return false
      }
      for (const op of ['__lt', '__lte', '__gt', '__gte']) {
        if (op in v) {
          const val = v[op]
          if (op === '__lt' && !(doc[k] < val)) return false
          if (op === '__lte' && !(doc[k] <= val)) return false
          if (op === '__gt' && !(doc[k] > val)) return false
          if (op === '__gte' && !(doc[k] >= val)) return false
        }
      }
    } else if (Array.isArray(v)) {
      if (v[0] && v[0].__in && !v[0].__in.includes(doc[k])) return false
    } else {
      if (doc[k] !== v) return false
    }
  }
  return true
}

/** 把一份 patch 写进文档（支持点路径 / __inc），doc.update 与 where.update 共用 */
function applyPatch(target, data) {
  for (const [k, v] of Object.entries(data)) {
    if (k.indexOf('.') !== -1) {
      // 支持任意层级的点路径写入（如 payload.x / metadata.seats）
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
          if (av < bv) return -sign
          if (av > bv) return sign
          return 0
        })
      }
      rows = rows.slice(q.skip, q.skip + q.limit)
      return { data: JSON.parse(JSON.stringify(rows)) }
    },
    async count() {
      const rows = Object.values(store).filter((d) => matches(d, q.cond))
      return { total: rows.slice(q.skip, q.skip + q.limit).length }
    },
    /**
     * where().update() —— 真实 SDK 支持，返回 { stats: { updated: n } }。
     * login 的惰性结算靠「条件更新 + stats.updated === 1」保证幂等，
     * mock 若不支持会退化成无条件更新，把幂等性一起测丢。
     */
    async update({ data }) {
      const rows = Object.values(store).filter((d) => matches(d, q.cond))
      rows.forEach((r) => applyPatch(r, data))
      return { stats: { updated: rows.length } }
    },
  }
  return query
}

const mockDb = {
  command: {
    lt: (v) => ({ __lt: v }),
    lte: (v) => ({ __lte: v }),
    gt: (v) => ({ __gt: v }),
    gte: (v) => ({ __gte: v }),
    in: (a) => [{ __in: a }],
    inc: (v) => ({ __inc: v }),
    exists: (v) => ({ __exists: v }),
    neq: (v) => ({ __neq: v }),
    and: (...args) => {
      const list = Array.isArray(args[0]) ? args[0] : args
      return Object.assign({}, ...list)
    },
  },
  RegExp: (opt) => ({ __regexp: (opt && opt.regexp) || '' }),
  collection() {
    return {
      doc(id) {
        return {
          async get() {
            const r = store[id]
            if (!r) throw new Error('doc not found: ' + id)
            return { data: JSON.parse(JSON.stringify(r)) }
          },
          async update({ data }) {
            const r = store[id]
            if (!r) throw new Error('doc not found: ' + id)
            applyPatch(r, data)
            return { stats: { updated: 1 } }
          },
          async remove() {
            if (!store[id]) throw new Error('doc not found: ' + id)
            delete store[id]
            return { stats: { removed: 1 } }
          },
        }
      },
      where(cond) {
        return makeQuery(cond)
      },
      async count() {
        return { total: Object.keys(store).length }
      },
      async add({ data }) {
        const id = data._id || 'auto-' + Math.random().toString(36).slice(2, 10)
        store[id] = { _id: id, ...JSON.parse(JSON.stringify(data)) }
        return { _id: id }
      },
    }
  },
  /**
   * 事务 mock —— 语义必须严格对齐真实 SDK，否则会掩盖线上 bug：
   *   wx-server-sdk 2.6.3 → @cloudbase/database 的 runTransaction 返回
   *   **回调的返回值本身**，不做 { result } 包装（见 node_modules/@cloudbase/database
   *   /dist/commonjs/transaction/index.js: `const callbackRes = await callback(transaction); ... return callbackRes`）。
   * 真实 SDK 还会在失败时回滚未提交的写入，这里用快照还原保持同样语义。
   *
   * ⚠️ 早期 mock 没有 runTransaction，导致 createReservation 的事务路径（== 生产路径）
   * 从未被测试覆盖，一个「事务已提交却返回预约失败」的 bug 因此逃逸到真机。
   */
  async runTransaction(callback) {
    const snapshot = JSON.parse(JSON.stringify(store))
    const transaction = { collection: () => mockDb.collection() }
    try {
      return await callback(transaction)
    } catch (err) {
      Object.keys(store).forEach((k) => delete store[k])
      Object.assign(store, snapshot)
      throw err
    }
  },
}

// 拦截 require('wx-server-sdk')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'wx-server-sdk') {
    const p = path.join(process.cwd(), 'scripts', '_sandbox_wx_server_sdk.cjs')
    require.cache[p] = { id: p, filename: p, loaded: true, exports: {}, children: [], paths: [] }
    require.cache[p].exports = {
      init() {},
      database() { return mockDb },
      getWXContext() { return { OPENID: WX_OPENID } },
      DYNAMIC_CURRENT_ENV: 'env',
      openapi: {
        subscribeMessage: {
          send: async (p) => { openapiSends.push(p); return { errCode: 0 } },
        },
      },
      callFunction: async (opts) => {
        if (opts && opts.name === 'notify') {
          notifyCalls.push(opts.data)
          const notifyFn = require(path.join(process.cwd(), 'cloudfunctions', 'notify', 'index.js'))
          return notifyFn.main(opts.data)
        }
        return { success: true }
      },
    }
    return p
  }
  return origResolve.call(this, request, ...args)
}

let pass = 0
let fail = 0
// 记录云函数间调用（expireRecords/cancelReservation → notify）与 openapi 发送，便于断言
const notifyCalls = []
const openapiSends = []
function expect(name, cond, detail = '') {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, detail) }
}
function resetStore() { Object.keys(store).forEach((k) => delete store[k]) }

// ============ validator 单元（F7） ============
async function testValidator() {
  console.log('\n== validator: 白名单/类型/长度 ==')
  const { validateEvent, normalizeSeatCode } = require(path.join(process.cwd(), 'cloudfunctions', 'shared', 'validator.js'))

  let r = validateEvent({ action: 'start', evil: 'x', limit: 50 }, { action: { type: 'enum', values: ['start', 'stop'] }, limit: { type: 'number', min: 1, max: 100 } })
  expect('白名单剥离未知字段', r.ok && !('evil' in r.value), JSON.stringify(r))
  expect('number 数值通过', r.ok && r.value.limit === 50)

  r = validateEvent({ action: 'start', limit: '30' }, { action: { type: 'enum', values: ['start'] }, limit: { type: 'number' } })
  expect('数字字符串强转', r.ok && r.value.limit === 30, JSON.stringify(r))

  r = validateEvent({ action: 'fly' }, { action: { type: 'enum', values: ['start'] } })
  expect('enum 非法取值拒绝', !r.ok, JSON.stringify(r))

  r = validateEvent({}, { record_id: { type: 'string' } })
  expect('必填缺失拒绝', !r.ok && /record_id/.test(r.error), JSON.stringify(r))

  r = validateEvent({ goal: 'x'.repeat(500) }, { goal: { type: 'string', max: 200, optional: true } })
  expect('超长字符串截断', r.ok && r.value.goal.length === 200)

  r = validateEvent({ category_ids: ['a', 1, 'b', null] }, { category_ids: { type: 'array<string>', optional: true } })
  expect('数组过滤非字符串项', r.ok && JSON.stringify(r.value.category_ids) === '["a","b"]', JSON.stringify(r.value))

  r = validateEvent({ start_at: 'not-a-date' }, { start_at: { type: 'string', isoDate: true } })
  expect('非法 ISO 时间拒绝', !r.ok, JSON.stringify(r))

  expect('座位号规范化', normalizeSeatCode(' a 01 ') === 'A01' && normalizeSeatCode('b-02') === 'B-02')
}

// ============ leaveSeat ============
async function testLeaveSeat() {
  console.log('\n== leaveSeat: 暂离/返回状态机 ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'leaveSeat', 'index.js'))
  const id = 'rev-001'
  store[id] = {
    _id: id, user_id: OWNER_HASH, record_type: 'reservation', status: 'active',
    room_id: 'r1', seat_id: 's1',
    start_at: iso(-3600e3), end_at: iso(3600e3),
    payload: { checked_in_at: iso(0) },
    created_at: iso(-3600e3), updated_at: iso(-3600e3),
  }

  let res = await fn.main({ action: 'leave', record_id: id })
  expect('leave: active->paused', res.success && store[id].status === 'paused', JSON.stringify(res))
  expect('leave: leave_count=1', store[id].payload.leave_count === 1, JSON.stringify(store[id].payload))

  res = await fn.main({ action: 'return', record_id: id })
  expect('return: paused->active', res.success && store[id].status === 'active', JSON.stringify(res))

  res = await fn.main({ action: 'leave', record_id: id })
  expect('再次暂离 leave_count=2', res.success && store[id].payload.leave_count === 2, JSON.stringify(store[id].payload))

  WX_OPENID = 'attacker-001'
  res = await fn.main({ action: 'return', record_id: id })
  expect('越权访问被拒', res.success === false && store[id].status === 'paused', JSON.stringify(res))
  WX_OPENID = 'owner-001'

  res = await fn.main({ action: 'fly', record_id: id })
  expect('未知 action 报错（validator 拦截）', res.success === false)
  res = await fn.main({ action: 'return' })
  expect('缺少 record_id 报错', res.success === false && /record_id/.test(res.message), JSON.stringify(res))
}

// ============ expireRecords（含 >100 分页 + 分批） ============
async function testExpireRecords() {
  console.log('\n== expireRecords: 超时自动处理 ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'expireRecords', 'index.js'))
  const old = iso(-40 * 60 * 1000)

  store['p1'] = { _id: 'p1', record_type: 'reservation', status: 'paused', updated_at: old, payload: {}, start_at: old, end_at: iso(3600e3) }
  store['p2'] = { _id: 'p2', record_type: 'reservation', status: 'paused', updated_at: iso(0), payload: {} }
  store['pd1'] = { _id: 'pd1', record_type: 'reservation', status: 'pending_checkin', start_at: old }
  store['ac1'] = { _id: 'ac1', record_type: 'reservation', status: 'active', end_at: old }

  const res = await fn.main({})

  expect('暂离>30min → 释放座位并记违规', store.p1.status === 'no_show' && store.p1.payload.violation_type === 'leave_timeout', JSON.stringify(store.p1))
  expect('暂离未超时保持 paused', store.p2.status === 'paused')
  expect('pending 超时 -> no_show', store.pd1.status === 'no_show')
  expect('active 到时 -> completed', store.ac1.status === 'completed')
  expect('统计 leave_released=1', res.data && res.data.leave_released === 1, JSON.stringify(res.data))
  expect('统计 no_show=1', res.data && res.data.no_show === 1, JSON.stringify(res.data))
  expect('统计 completed=1', res.data && res.data.completed === 1, JSON.stringify(res.data))
}

async function testExpirePagination() {
  console.log('\n== expireRecords: >100 条分页拉全量（F5/F8） ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'expireRecords', 'index.js'))
  const old = iso(-40 * 60 * 1000)
  const pad = (n) => String(n).padStart(4, '0')

  for (let i = 0; i < 250; i++) {
    store['p-' + pad(i)] = { _id: 'p-' + pad(i), record_type: 'reservation', status: 'pending_checkin', start_at: old }
  }
  for (let i = 0; i < 120; i++) {
    store['z-' + pad(i)] = { _id: 'z-' + pad(i), record_type: 'reservation', status: 'paused', updated_at: old, payload: {} }
  }
  for (let i = 0; i < 15; i++) {
    store['c-' + pad(i)] = { _id: 'c-' + pad(i), record_type: 'reservation', status: 'active', end_at: old }
  }

  const res = await fn.main({})
  const pendingNoShow = Object.values(store).filter((d) => d.status === 'no_show' && d.payload && d.payload.violation_type === 'pending_timeout').length
  const leaveReleased = Object.values(store).filter((d) => d.status === 'no_show' && d.payload && d.payload.violation_type === 'leave_timeout').length
  const completedCount = Object.values(store).filter((d) => d._id.startsWith('c-') && d.status === 'completed').length

  expect('250 pending 全部 no_show（3 页游标）', res.data.no_show === 250 && pendingNoShow === 250, JSON.stringify({ data: res.data, actual: pendingNoShow }))
  expect('120 paused 全部释放座位（2 页游标）', res.data.leave_released === 120 && leaveReleased === 120, JSON.stringify({ data: res.data, actual: leaveReleased }))
  expect('15 active 全部 completed', res.data.completed === 15 && completedCount === 15, JSON.stringify({ data: res.data, actual: completedCount }))
  expect('processed_total=385', res.data.processed_total === 385, JSON.stringify(res.data))
}

// ============ studyRecord ============
async function testComputeActiveSeconds() {
  console.log('\n== studyRecord: computeActiveSeconds 单元（F11） ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'studyRecord', 'index.js'))
  const { computeActiveSeconds } = fn.__test
  const now = Date.now()
  const t = (offsetMs) => new Date(now + offsetMs).toISOString()

  let r = computeActiveSeconds({ start_at: t(-3600e3), end_at: t(0), payload: {} }, now)
  expect('无暂停 1 小时 = 3600s', r === 3600, String(r))

  r = computeActiveSeconds({
    start_at: t(-3600e3), end_at: t(0),
    payload: { pause_segments: [{ start: t(-3000e3), end: t(-2700e3) }, { start: t(-1200e3), end: t(-600e3) }] },
  }, now)
  expect('两段暂停 300+600 → 2700s', r === 2700, String(r))

  r = computeActiveSeconds({
    start_at: t(-3600e3), end_at: null,
    payload: { pause_segments: [{ start: t(-600e3), end: null }] },
  }, now)
  expect('暂停未闭合按 now 兜底 → 3000s', r === 3000, String(r))

  const yesterday23 = new Date(now - 1 * 3600e3)
  yesterday23.setHours(23, 0, 0, 0)
  const today1 = new Date(yesterday23.getTime() + 2 * 3600e3)
  r = computeActiveSeconds({ start_at: yesterday23.toISOString(), end_at: today1.toISOString(), payload: {} }, now)
  expect('跨天 23:00→次日01:00 = 7200s', r === 7200, String(r))

  r = computeActiveSeconds({ start_at: t(0), end_at: t(-3600e3), payload: {} }, now)
  expect('end 早于 start 归零', r === 0, String(r))
}

async function testStudyStartDupAndComplete() {
  console.log('\n== studyRecord: start 防重 / complete 状态机 ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'studyRecord', 'index.js'))
  WX_OPENID = 'owner-001'

  let res = await fn.main({ action: 'start', goal: '复习高数', category_ids: ['a', 1, 'b'] })
  const firstId = res.data && res.data._id
  expect('start 成功写入 running 记录', res.success && store[firstId] && store[firstId].status === 'running', JSON.stringify(res))
  expect('category_ids 已过滤非字符串项', JSON.stringify(store[firstId].category_ids) === '["a","b"]', JSON.stringify(store[firstId].category_ids))

  res = await fn.main({ action: 'start', goal: '再来一个' })
  expect('单用户仅一个 running（第二次返回已有记录）', res.success && res.data && res.data._id === firstId, JSON.stringify(res))

  // complete 状态机：预置 running + 未闭合暂停段
  store['st-run'] = {
    _id: 'st-run', user_id: OWNER_HASH, record_type: 'study', status: 'running',
    start_at: iso(-3600e3), end_at: null,
    payload: { goal: 'x', pause_segments: [{ start: iso(-600e3), end: null }] },
    created_at: iso(-3600e3), updated_at: iso(-3600e3),
  }
  res = await fn.main({ action: 'complete', record_id: 'st-run' })
  const d = store['st-run']
  const dur = d.payload.actual_duration_sec
  expect('complete: 状态 completed + end_at 写入', res.success && d.status === 'completed' && !!d.end_at, JSON.stringify(res))
  expect('complete: 暂停段已闭合', d.payload.pause_segments[0].end && d.payload.pause_segments[0].end.length > 0, JSON.stringify(d.payload.pause_segments))
  expect('complete: goal 保留（回归：closeOpenPause 返回结构）', d.payload.goal === 'x', JSON.stringify(d.payload))
  expect('complete: 时长 ≈3000s（扣暂停）', dur >= 2990 && dur <= 3010, String(dur))
  expect('complete: pomodoro_count=floor(时长/1500)', d.payload.pomodoro_count === Math.floor(dur / 1500), String(d.payload.pomodoro_count))

  res = await fn.main({ action: 'pause', record_id: 'st-run' })
  expect('completed 记录不可再 pause', res.success === false, JSON.stringify(res))
}

async function testStudyRecordEdit() {
  console.log('\n== studyRecord: update 编辑名称与时长 ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'studyRecord', 'index.js'))
  WX_OPENID = 'owner-001'

  store['ed-1'] = {
    _id: 'ed-1', user_id: OWNER_HASH, record_type: 'study', status: 'completed',
    start_at: iso(-3600e3), end_at: iso(-1800e3),
    payload: { goal: '旧名称', pause_segments: [], pomodoro_count: 1, actual_duration_sec: 1800 },
    created_at: iso(-3600e3), updated_at: iso(-1800e3),
  }

  let res = await fn.main({ action: 'update', record_id: 'ed-1', goal: '新名称' })
  expect('改名称成功', res.success && store['ed-1'].payload.goal === '新名称', JSON.stringify(res))
  expect('改名称不动时长', store['ed-1'].payload.actual_duration_sec === 1800, String(store['ed-1'].payload.actual_duration_sec))

  res = await fn.main({ action: 'update', record_id: 'ed-1', duration_min: 45 })
  expect('改时长 → 2700s', res.success && store['ed-1'].payload.actual_duration_sec === 2700, JSON.stringify(res))
  expect('改时长不动名称', store['ed-1'].payload.goal === '新名称', store['ed-1'].payload.goal)
  expect('pomodoro_count 重算 = floor(2700/1500)', store['ed-1'].payload.pomodoro_count === 1, String(store['ed-1'].payload.pomodoro_count))
  expect('manual_edited 标记', store['ed-1'].payload.manual_edited === true, JSON.stringify(store['ed-1'].payload))
  const span1 = new Date(store['ed-1'].end_at).getTime() - new Date(store['ed-1'].start_at).getTime()
  expect('end_at 回推 = start + 45min', span1 === 2700e3, String(span1))

  // 含暂停段：end_at = start + 时长 + 暂停总时长，净时长仍等于用户填的值
  store['ed-2'] = {
    _id: 'ed-2', user_id: OWNER_HASH, record_type: 'study', status: 'completed',
    start_at: iso(-7200e3), end_at: iso(-3600e3),
    payload: { goal: 'p', pause_segments: [{ start: iso(-6000e3), end: iso(-5400e3) }], pomodoro_count: 2, actual_duration_sec: 3000 },
    created_at: iso(-7200e3), updated_at: iso(-3600e3),
  }
  res = await fn.main({ action: 'update', record_id: 'ed-2', duration_min: 90 })
  const span2 = new Date(store['ed-2'].end_at).getTime() - new Date(store['ed-2'].start_at).getTime()
  expect('含暂停段：end_at = start + 90min + 10min 暂停', span2 === (90 * 60 + 600) * 1000, String(span2))
  expect('含暂停段：净时长仍为 5400s', store['ed-2'].payload.actual_duration_sec === 5400, String(store['ed-2'].payload.actual_duration_sec))

  // running：只能改名称
  store['ed-3'] = {
    _id: 'ed-3', user_id: OWNER_HASH, record_type: 'study', status: 'running',
    start_at: iso(-600e3), end_at: null,
    payload: { goal: '进行中', pause_segments: [] },
    created_at: iso(-600e3), updated_at: iso(-600e3),
  }
  res = await fn.main({ action: 'update', record_id: 'ed-3', duration_min: 30 })
  expect('running 不可改时长', res.success === false, JSON.stringify(res))
  res = await fn.main({ action: 'update', record_id: 'ed-3', goal: '进行中改名' })
  expect('running 可以改名称', res.success && store['ed-3'].payload.goal === '进行中改名', JSON.stringify(res))

  // 越权与类型护栏
  store['ed-4'] = { _id: 'ed-4', user_id: OWNER_HASH, record_type: 'reservation', status: 'completed', payload: {} }
  res = await fn.main({ action: 'update', record_id: 'ed-4', goal: 'x' })
  expect('非学习记录不可编辑', res.success === false, JSON.stringify(res))

  store['ed-5'] = { _id: 'ed-5', user_id: 'someone-else', record_type: 'study', status: 'completed', payload: {} }
  res = await fn.main({ action: 'update', record_id: 'ed-5', goal: 'x' })
  expect('他人记录无权编辑', res.success === false, JSON.stringify(res))

  res = await fn.main({ action: 'update', record_id: 'ed-1' })
  expect('无更新内容 → 失败', res.success === false, JSON.stringify(res))

  // 边界收敛
  res = await fn.main({ action: 'update', record_id: 'ed-1', duration_min: 99999 })
  expect('时长上限收敛到 1440 分钟', res.success && store['ed-1'].payload.actual_duration_sec === 1440 * 60, String(store['ed-1'].payload.actual_duration_sec))
  res = await fn.main({ action: 'update', record_id: 'ed-1', duration_min: -5 })
  expect('时长下限收敛到 1 分钟', res.success && store['ed-1'].payload.actual_duration_sec === 60, String(store['ed-1'].payload.actual_duration_sec))

  // —— delete：护栏与成功路径 ——
  res = await fn.main({ action: 'delete', record_id: 'ed-3' })
  expect('running 记录不可删除', res.success === false, JSON.stringify(res))
  expect('running 删除失败后记录仍在', !!store['ed-3'], 'ed-3 exists')
  res = await fn.main({ action: 'delete', record_id: 'ed-5' })
  expect('他人记录无权删除', res.success === false, JSON.stringify(res))
  res = await fn.main({ action: 'delete', record_id: 'ed-4' })
  expect('非学习记录（预约）不可删除', res.success === false, JSON.stringify(res))
  res = await fn.main({ action: 'delete', record_id: 'ed-1' })
  expect('已完成记录删除成功且从库中移除', res.success && !store['ed-1'], JSON.stringify(res))
  res = await fn.main({ action: 'delete', record_id: 'ed-1' })
  expect('重复删除 → 记录不存在报错', res.success === false, JSON.stringify(res))
}

// ============ studyRecord: 真番茄钟（sync_pomodoro）============
async function testStudyPomodoro() {
  console.log('\n== studyRecord: 番茄段同步与真实番茄计数 ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'studyRecord', 'index.js'))
  WX_OPENID = 'owner-001'

  store['pm-1'] = {
    _id: 'pm-1', user_id: OWNER_HASH, record_type: 'study', status: 'running',
    start_at: iso(-3600e3), end_at: null,
    payload: { goal: '番茄会话', pause_segments: [], pomodoro_segments: [], pomodoro_count: 0 },
    created_at: iso(-3600e3), updated_at: iso(-3600e3),
  }

  const t0 = iso(-3000e3)
  const seg = (type, startOff, endOff, completed) => {
    const item = { type, start: iso(startOff) }
    if (endOff !== undefined && endOff !== null) item.end = iso(endOff)
    if (completed) item.completed = true
    return item
  }

  // 两段专注走完 + 一段休息（休息时长要从专注时间里扣掉）
  let res = await fn.main({
    action: 'sync_pomodoro', record_id: 'pm-1', focus_min: 25, break_min: 5,
    segments: [
      seg('focus', -3000e3, -1500e3, true),
      seg('break', -1500e3, -1200e3, true),
      seg('focus', -1200e3, 0, true),
      seg('break', 0, null, false),
    ],
  })
  expect('sync 成功', res.success, JSON.stringify(res))
  expect('番茄数 = 完成的专注段数 2', res.data.pomodoro_count === 2, JSON.stringify(res.data))
  expect('段落数保留 4', res.data.segment_count === 4, JSON.stringify(res.data))

  let p = store['pm-1'].payload
  expect('pomodoro_segments 落库', Array.isArray(p.pomodoro_segments) && p.pomodoro_segments.length === 4, JSON.stringify(p))
  const breakPauses = (p.pause_segments || []).filter((s) => s.source === 'pomodoro')
  expect('休息段派生为 pause（2 条）', breakPauses.length === 2, JSON.stringify(p.pause_segments))

  // 幂等：重复推同一批数据不应叠加
  res = await fn.main({
    action: 'sync_pomodoro', record_id: 'pm-1', focus_min: 25, break_min: 5,
    segments: p.pomodoro_segments,
  })
  const again = (store['pm-1'].payload.pause_segments || []).filter((s) => s.source === 'pomodoro')
  expect('重复同步幂等（不重复累加）', again.length === 2, JSON.stringify(store['pm-1'].payload.pause_segments))

  // 手动 pause 段必须被保留，不能被全量重推抹掉
  store['pm-1'].payload.pause_segments = [
    { start: t0, end: iso(-2900e3) },
    ...store['pm-1'].payload.pause_segments,
  ]
  res = await fn.main({
    action: 'sync_pomodoro', record_id: 'pm-1',
    segments: [{ type: 'focus', start: iso(-3000e3), end: iso(-1500e3), completed: true }],
  })
  const manual = (store['pm-1'].payload.pause_segments || []).filter((s) => s.source !== 'pomodoro')
  expect('手动 pause 段保留', manual.length === 1, JSON.stringify(store['pm-1'].payload.pause_segments))
  expect('重推后番茄数按新轨迹 = 1', res.data.pomodoro_count === 1, JSON.stringify(res.data))

  // 护栏
  res = await fn.main({ action: 'sync_pomodoro', record_id: 'pm-nope', segments: [] })
  expect('不存在的记录 → 失败', res.success === false, JSON.stringify(res))

  store['pm-2'] = {
    _id: 'pm-2', user_id: OWNER_HASH, record_type: 'reservation', status: 'pending_checkin',
    payload: {}, created_at: iso(0), updated_at: iso(0),
  }
  res = await fn.main({ action: 'sync_pomodoro', record_id: 'pm-2', segments: [] })
  expect('非学习记录 → 拒绝', res.success === false, JSON.stringify(res))

  store['pm-3'] = {
    _id: 'pm-3', user_id: OWNER_HASH, record_type: 'study', status: 'completed',
    payload: { pomodoro_segments: [] }, created_at: iso(0), updated_at: iso(0),
  }
  res = await fn.main({ action: 'sync_pomodoro', record_id: 'pm-3', segments: [] })
  expect('已结束的会话 → 拒绝', res.success === false, JSON.stringify(res))

  store['pm-4'] = {
    _id: 'pm-4', user_id: 'intruder', record_type: 'study', status: 'running',
    payload: {}, created_at: iso(0), updated_at: iso(0),
  }
  res = await fn.main({ action: 'sync_pomodoro', record_id: 'pm-4', segments: [] })
  expect('他人会话 → 拒绝', res.success === false, JSON.stringify(res))

  // 脏数据要被清洗掉（type 非法 / 缺 start）
  res = await fn.main({
    action: 'sync_pomodoro', record_id: 'pm-1',
    segments: [
      { type: 'nope', start: iso(0), completed: true },
      { type: 'focus' },
      { type: 'focus', start: iso(-3000e3), end: iso(-1500e3), completed: true },
    ],
  })
  expect('脏段落被清洗（只剩 1 条合法）', res.success && res.data.segment_count === 1, JSON.stringify(res.data))

  // 完成后番茄数不再按除法换算：有分段时保留真实段数
  store['pm-5'] = {
    _id: 'pm-5', user_id: OWNER_HASH, record_type: 'study', status: 'running',
    start_at: iso(-5400e3), end_at: null,
    payload: {
      pause_segments: [],
      pomodoro_segments: [
        { type: 'focus', start: iso(-5400e3), end: iso(-3900e3), completed: true },
        { type: 'break', start: iso(-3900e3), end: iso(-3600e3), completed: true },
        { type: 'focus', start: iso(-3600e3), end: null, completed: false },
      ],
      pomodoro_count: 1,
    },
    created_at: iso(-5400e3), updated_at: iso(-5400e3),
  }
  res = await fn.main({ action: 'complete', record_id: 'pm-5' })
  expect('完成成功', res.success, JSON.stringify(res))
  expect(
    '完成时番茄 = 真实专注段 1（不是 90 分钟÷25=3）',
    store['pm-5'].payload.pomodoro_count === 1,
    JSON.stringify(store['pm-5'].payload),
  )
  // 休息 5 分钟必须从专注时长里扣掉：总跨度 90 分钟 - 休息 5 分钟 = 85 分钟
  expect(
    '休息时长不计入专注（85 分钟）',
    store['pm-5'].payload.actual_duration_sec === 85 * 60,
    String(store['pm-5'].payload.actual_duration_sec),
  )

  // 旧会话（无分段）仍走除法口径，兼容历史数据
  store['pm-6'] = {
    _id: 'pm-6', user_id: OWNER_HASH, record_type: 'study', status: 'running',
    start_at: iso(-3000e3), end_at: null,
    payload: { pause_segments: [] },
    created_at: iso(-3000e3), updated_at: iso(-3000e3),
  }
  res = await fn.main({ action: 'complete', record_id: 'pm-6' })
  expect('无分段的历史会话回退除法（50 分钟 → 2 个）', store['pm-6'].payload.pomodoro_count === 2, String(store['pm-6'].payload.pomodoro_count))

  // 手动改时长不得把番茄换算掉
  store['pm-7'] = {
    _id: 'pm-7', user_id: OWNER_HASH, record_type: 'study', status: 'completed',
    start_at: iso(-1800e3), end_at: iso(0),
    payload: {
      pause_segments: [],
      pomodoro_segments: [{ type: 'focus', start: iso(-1800e3), end: iso(0), completed: true }],
      pomodoro_count: 1,
    },
    created_at: iso(-1800e3), updated_at: iso(0),
  }
  res = await fn.main({ action: 'update', record_id: 'pm-7', duration_min: 120 })
  expect('改时长后番茄保持真实值 1', res.success && store['pm-7'].payload.pomodoro_count === 1, JSON.stringify(store['pm-7'].payload))

  // 纯函数：countPomodoro / derivePauseSegments / sanitizeSegments
  const helpers = fn.__test
  expect('countPomodoro 空 paused → 0', helpers.countPomodoro({}, 0) === 0)
  expect(
    'derivePauseSegments 只吃 break 段',
    helpers.derivePauseSegments([{ start: 'a', end: 'b' }], [
      { type: 'focus', start: 'x', end: 'y' },
      { type: 'break', start: 'p', end: 'q' },
    ]).length === 2,
    JSON.stringify(helpers.derivePauseSegments([{ start: 'a', end: 'b' }], [{ type: 'break', start: 'p', end: 'q' }])),
  )
  expect('sanitizeSegments 剔除非法项', helpers.sanitizeSegments([null, { type: 'x', start: 'a' }, { type: 'focus', start: 'b' }]).length === 1)
}

async function testStudySummaryPagination() {
  console.log('\n== studyRecord: summary >200 条统计准确（F6） ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'studyRecord', 'index.js'))
  WX_OPENID = 'owner-001'
  const pad = (n) => String(n).padStart(4, '0')
  const since = iso(-10 * 24 * 3600e3)

  for (let i = 0; i < 230; i++) {
    store['s-' + pad(i)] = {
      _id: 's-' + pad(i), user_id: OWNER_HASH, record_type: 'study', status: 'completed',
      start_at: iso(-3600e3), end_at: iso(0),
      payload: { actual_duration_sec: 1500, pomodoro_count: 1 },
      created_at: iso(-3600e3), updated_at: iso(0),
    }
  }
  for (let i = 0; i < 10; i++) {
    store['r-' + pad(i)] = {
      _id: 'r-' + pad(i), user_id: OWNER_HASH, record_type: 'study', status: 'running',
      start_at: iso(-1800e3), end_at: null,
      payload: { actual_duration_sec: 900 },
      created_at: iso(-1800e3), updated_at: iso(-1800e3),
    }
  }
  // 时间窗外的记录 + 他人记录应被排除
  store['s-old'] = {
    _id: 's-old', user_id: OWNER_HASH, record_type: 'study', status: 'completed',
    payload: { actual_duration_sec: 9999 }, created_at: iso(-20 * 24 * 3600e3),
  }
  store['s-other'] = {
    _id: 's-other', user_id: OTHER_HASH, record_type: 'study', status: 'completed',
    payload: { actual_duration_sec: 9999 }, created_at: iso(-3600e3),
  }

  const res = await fn.main({ action: 'summary', since })
  const d = res.data || {}
  expect('session_total=240（3 页游标拉全）', d.session_total === 240, JSON.stringify(d))
  expect('completed_count=230', d.completed_count === 230, JSON.stringify(d))
  expect('active_count=10', d.active_count === 10, JSON.stringify(d))
  expect('completed_seconds=345000', d.completed_seconds === 345000, String(d.completed_seconds))
  expect('total_seconds=354000', d.total_seconds === 354000, String(d.total_seconds))
  expect('pomodoro_total=230', d.pomodoro_total === 230, String(d.pomodoro_total))
  expect('average=1500', d.average_seconds_per_session === 1500, String(d.average_seconds_per_session))
}

async function testStudyListPagination() {
  console.log('\n== studyRecord: list 分页 ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'studyRecord', 'index.js'))
  WX_OPENID = 'owner-001'
  for (let i = 0; i < 25; i++) {
    store['l-' + String(i).padStart(2, '0')] = {
      _id: 'l-' + String(i).padStart(2, '0'), user_id: OWNER_HASH, record_type: 'study', status: 'completed',
      created_at: iso(-(25 - i) * 60e3), updated_at: iso(0),
    }
  }
  store['l-other'] = { _id: 'l-other', user_id: OTHER_HASH, record_type: 'study', status: 'completed', created_at: iso(-60e3) }

  let res = await fn.main({ action: 'list', limit: 10 })
  expect('list 首页 10 条', res.success && res.data.length === 10, JSON.stringify(res.data && res.data.length))
  res = await fn.main({ action: 'list', limit: 10, page: 3 })
  expect('list 第 3 页 5 条（skip=20）', res.success && res.data.length === 5, JSON.stringify(res.data && res.data.length))
  res = await fn.main({ action: 'list', limit: 10, skip: 10 })
  expect('list skip=10 返回 10 条且不与首页重复', res.success && res.data.length === 10
    && res.data[0]._id === 'l-14', JSON.stringify(res.data && res.data[0] && res.data[0]._id))
  res = await fn.main({ action: 'list', limit: 200 })
  expect('limit 超上限收敛（返回全部 25 条）', res.success && res.data.length === 25, String(res.data && res.data.length))
}

// ============ createReservation（F12） ============
async function testCreateReservation() {
  console.log('\n== createReservation: 冲突检测 ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'createReservation', 'index.js'))
  WX_OPENID = 'owner-001'
  store['res-1'] = {
    _id: 'res-1', user_id: OWNER_HASH, record_type: 'reservation', status: 'active',
    room_id: 'r1', seat_id: 's1', start_at: iso(-3600e3), end_at: iso(3600e3),
    created_at: iso(-3600e3), updated_at: iso(-3600e3),
  }

  let res = await fn.main({ room_id: 'r1', seat_id: 's1', start_at: iso(0), end_at: iso(7200e3) })
  expect('座位冲突 → SEAT_CONFLICT', !res.success && res.data && res.data.code === 'SEAT_CONFLICT', JSON.stringify(res))

  res = await fn.main({ room_id: 'r1', seat_id: 's2', start_at: iso(0), end_at: iso(7200e3) })
  expect('用户冲突 → USER_CONFLICT 带冲突信息', !res.success && res.data && res.data.code === 'USER_CONFLICT'
    && res.data.conflict && res.data.conflict._id === 'res-1', JSON.stringify(res))

  WX_OPENID = 'other-001'
  res = await fn.main({ room_id: 'r2', seat_id: 's9', start_at: isoB(3600e3), end_at: isoB(7200e3), goal: '复习' })
  const newId = res.data && res.data._id
  expect('无冲突预约成功', res.success && store[newId] && store[newId].status === 'pending_checkin', JSON.stringify(res))
  expect('写入 payload.goal', store[newId] && store[newId].payload && store[newId].payload.goal === '复习')

  res = await fn.main({ room_id: 'r2', seat_id: 's9', start_at: iso(7200e3), end_at: iso(3600e3) })
  expect('end <= start 拒绝', !res.success, JSON.stringify(res))
  res = await fn.main({ room_id: 'r2', seat_id: 's9' })
  expect('缺必填字段拒绝（validator）', !res.success && /start_at|end_at/.test(res.message), JSON.stringify(res))
  res = await fn.main({ room_id: 'r2', seat_id: 's9', start_at: 'bad-date', end_at: iso(7200e3) })
  expect('非法时间格式拒绝', !res.success, JSON.stringify(res))
}

// ============ createReservation：事务路径（= 生产路径）============
// 回归目标：db.runTransaction 的返回值不是 { result } 包装。
// 历史 bug：代码写 `const transaction = await db.runTransaction(...)` 后读 `transaction.result`，
// 恒为 undefined → 事务已提交、记录已入库，却返回「预约失败，请稍后重试」；
// 用户重试又撞上自己刚建的记录 → 「该时段座位已被预约」。
async function testCreateReservationTransaction() {
  console.log('\n== createReservation: 事务路径（生产路径回归） ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'createReservation', 'index.js'))

  // 先校验 mock 与真实 SDK 同语义（防止有人把 mock 改成 { result } 而让回归失效）
  const probe = await mockDb.runTransaction(async () => ({ _id: 'probe' }))
  expect('mock: runTransaction 直接返回回调值（无 .result 包装）',
    !!probe && probe._id === 'probe' && probe.result === undefined, JSON.stringify(probe))

  WX_OPENID = 'tx-owner'
  store['room-tx'] = {
    _id: 'room-tx', type: 'room', status: 'active', name: '事务室',
    metadata: { open_time: '00:00', close_time: '23:59' },
  }

  let res = await fn.main({ room_id: 'room-tx', seat_id: 'T-1', start_at: isoB(3600e3), end_at: isoB(7200e3), goal: '复习' })
  const newId = res.data && res.data._id
  expect('事务路径：预约成功（不再返回「预约失败，请稍后重试」）', res.success === true, JSON.stringify(res))
  expect('事务路径：返回真实 _id', !!newId, JSON.stringify(res))
  expect('事务路径：记录已落库且为 pending_checkin',
    !!store[newId] && store[newId].status === 'pending_checkin', JSON.stringify(store[newId]))
  expect('事务路径：payload.openid 落库（后端推送依赖）',
    !!store[newId] && store[newId].payload.openid === 'tx-owner')
  expect('事务路径：payload.room_name 落库',
    !!store[newId] && store[newId].payload.room_name === '事务室')

  // 同座位同时段 → 座位冲突
  res = await fn.main({ room_id: 'room-tx', seat_id: 'T-1', start_at: isoB(3600e3), end_at: isoB(7200e3) })
  expect('事务路径：同座位同时段 → SEAT_CONFLICT',
    !res.success && res.data && res.data.code === 'SEAT_CONFLICT', JSON.stringify(res))

  // 同用户同时段换座位 → 用户冲突，且结构要与降级路径一致（data.conflict）
  res = await fn.main({ room_id: 'room-tx', seat_id: 'T-2', start_at: isoB(3600e3), end_at: isoB(7200e3) })
  expect('事务路径：同用户同时段 → USER_CONFLICT 带 data.conflict',
    !res.success && res.data && res.data.code === 'USER_CONFLICT'
    && res.data.conflict && res.data.conflict._id === newId, JSON.stringify(res))

  // 冲突时不得产生任何写入（mock 会回滚，真实 SDK 同样会回滚）
  const before = Object.keys(store).length
  res = await fn.main({ room_id: 'room-tx', seat_id: 'T-3', start_at: isoB(3600e3), end_at: isoB(7200e3) })
  expect('事务路径：冲突时无多余写入（回滚生效）',
    !res.success && Object.keys(store).length === before, `${Object.keys(store).length} vs ${before}`)

  // 同一座位换到不重叠时段 → 应当成功（证明冲突判断按时间窗而非「座位是否被约过」）
  // ⚠️ 必须用 isoB（当天可容纳的基准）：room-tx 是 00:00-23:59 同日营业的房间，
  // 用 now+3h/now+4h 在 20:00 之后会跨天，被「须在同一天内」拒绝 → 用例误挂。
  res = await fn.main({ room_id: 'room-tx', seat_id: 'T-1', start_at: isoB(10800e3), end_at: isoB(14400e3) })
  expect('事务路径：同座位不重叠时段 → 可成功',
    res.success === true && !!store[res.data._id], JSON.stringify(res))
}

// ============ adminStats（F13） ============
async function testAdminStats() {
  console.log('\n== adminStats: 鉴权 + 统计口径快照 ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'adminStats', 'index.js'))

  delete process.env.ADMIN_OPENID_HASHES
  WX_OPENID = 'owner-001'
  let res = await fn.main({})
  expect('未配置白名单 → ADMIN_NOT_CONFIGURED', !res.success && res.code === 'ADMIN_NOT_CONFIGURED', JSON.stringify(res))

  process.env.ADMIN_OPENID_HASHES = OWNER_HASH
  WX_OPENID = 'attacker-001'
  res = await fn.main({})
  expect('白名单外 → FORBIDDEN', !res.success && res.code === 'FORBIDDEN', JSON.stringify(res))

  WX_OPENID = 'owner-001'
  res = await fn.main({ start_at: 'not-a-date' })
  expect('非法入参 → INVALID_PAYLOAD', !res.success && res.code === 'INVALID_PAYLOAD', JSON.stringify(res))

  // 统计口径快照：7 条预约 + 2 个房间（10 个座位）
  const inWin = (startOff, endOff) => ({ start_at: iso(startOff), end_at: iso(endOff) })
  const r1 = { _id: 'a1', record_type: 'reservation', status: 'pending_checkin', created_at: iso(-3600e3), payload: {}, ...inWin(-3600e3, 3600e3) }
  const r2 = { _id: 'a2', record_type: 'reservation', status: 'active', created_at: iso(-3600e3), payload: { checked_in_at: iso(-1800e3) }, ...inWin(-3600e3, 3600e3) }
  const r3 = { _id: 'a3', record_type: 'reservation', status: 'paused', created_at: iso(-3600e3), payload: { checked_in_at: iso(-1800e3) }, ...inWin(-3600e3, 3600e3) }
  const r4 = { _id: 'a4', record_type: 'reservation', status: 'completed', created_at: iso(-3600e3), payload: { checked_in_at: iso(-1800e3) }, ...inWin(-7200e3, -3600e3) }
  const r5 = { _id: 'a5', record_type: 'reservation', status: 'completed', created_at: iso(-3600e3), payload: {}, ...inWin(-7200e3, -3600e3) }
  const r6 = { _id: 'a6', record_type: 'reservation', status: 'no_show', created_at: iso(-3600e3), payload: {}, ...inWin(-7200e3, -3600e3) }
  const r7 = { _id: 'a7', record_type: 'reservation', status: 'cancelled', created_at: iso(-3600e3), payload: {}, ...inWin(-7200e3, -3600e3) }
  ;[r1, r2, r3, r4, r5, r6, r7].forEach((r) => { store[r._id] = r })
  store['room-1'] = { _id: 'room-1', type: 'room', status: 'active', metadata: { seats: [{}, {}, {}, {}] } }
  store['room-2'] = { _id: 'room-2', type: 'room', status: 'active', metadata: { seats: [{}, {}, {}, {}, {}, {}] } }

  res = await fn.main({})
  const d = res.data || {}
  expect('鉴权通过返回 success', res.success, JSON.stringify(res))
  expect('total=7', d.total === 7, JSON.stringify(d))
  expect('checkedIn=3（仅 payload.checked_in_at）', d.checkedIn === 3, JSON.stringify({ checkedIn: d.checkedIn, byStatus: d.byStatus }))
  expect('finished=4', d.finished === 4, JSON.stringify(d))
  expect('byStatus.paused=1', d.byStatus.paused === 1, JSON.stringify(d.byStatus))
  expect('byStatus.completed=2（含自动到期）', d.byStatus.completed === 2, JSON.stringify(d.byStatus))
  expect('occupiedNow=3（pending+active+paused 在窗）', d.occupiedNow === 3, JSON.stringify({ occupiedNow: d.occupiedNow }))
  expect('totalSeats=10', d.totalSeats === 10, String(d.totalSeats))
  expect('noShowRate=14.3', d.rates.noShowRate === 14.3, JSON.stringify(d.rates))
  expect('checkInRate=42.9', d.rates.checkInRate === 42.9, JSON.stringify(d.rates))
  expect('completionRate=50', d.rates.completionRate === 50, JSON.stringify(d.rates))
  expect('occupancyRate=30', d.rates.occupancyRate === 30, JSON.stringify(d.rates))
  // 诊断字段（用于区分「集合为空」与「写库字段口径不符」）
  expect('diag.recordsTotal=9（7 预约 + 2 房间）', d.diag && d.diag.recordsTotal === 9, JSON.stringify(d.diag))
  expect('diag.reservationCount=7', d.diag && d.diag.reservationCount === 7, JSON.stringify(d.diag))
  expect('diag.error 为空', d.diag && !d.diag.error, JSON.stringify(d.diag))

  delete process.env.ADMIN_OPENID_HASHES
}

// ============ checkin（F14 / F9） ============
async function testCheckin() {
  console.log('\n== checkin: 时间窗边界 + 扫码规范化 ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'checkin', 'index.js'))
  WX_OPENID = 'owner-001'
  // 本组用例覆盖「未开启到店签到码」的旧行为，显式关掉码校验；
  // 需要签到码的场景见 testCheckinCode()
  const prevRequire = process.env.CHECKIN_REQUIRE_CODE
  process.env.CHECKIN_REQUIRE_CODE = '0'
  const mk = (id, extra) => {
    store[id] = {
      _id: id, user_id: OWNER_HASH, record_type: 'reservation', status: 'pending_checkin',
      room_id: 'r1', seat_id: 'A01', payload: {}, created_at: iso(-3600e3), updated_at: iso(-3600e3),
      ...extra,
    }
  }

  mk('ck-early', { start_at: iso(20 * 60e3), end_at: iso(2 * 3600e3) })
  let res = await fn.main({ record_id: 'ck-early' })
  expect('早于 start-15min 拒绝', !res.success && /尚未到签到/.test(res.message), JSON.stringify(res))

  mk('ck-boundary', { start_at: iso(15 * 60e3 - 5e3), end_at: iso(2 * 3600e3) })
  res = await fn.main({ record_id: 'ck-boundary' })
  expect('start-15min 边界内可签到', res.success, JSON.stringify(res))

  mk('ck-ok', { start_at: iso(-10 * 60e3), end_at: iso(3600e3) })
  res = await fn.main({ record_id: 'ck-ok' })
  expect('签到成功 → active + checked_in_at', res.success && store['ck-ok'].status === 'active'
    && !!store['ck-ok'].payload.checked_in_at, JSON.stringify(res))
  expect('手动签到 checkin_method=manual', store['ck-ok'].payload.checkin_method === 'manual', JSON.stringify(store['ck-ok'].payload))

  mk('ck-ended', { start_at: iso(-2 * 3600e3), end_at: iso(-10 * 60e3) })
  res = await fn.main({ record_id: 'ck-ended' })
  expect('预约已结束拒绝', !res.success && /已结束/.test(res.message), JSON.stringify(res))

  // 签到上限：与 roomList.isStale / expireRecords / createReservation.releasedByTimeout 同口径。
  // 超过 start+15min 座位已被系统释放（甚至已被他人预约），此时放行签到会造成「一椅两人 active」。
  mk('ck-late', { start_at: iso(-20 * 60e3), end_at: iso(3600e3) })
  res = await fn.main({ record_id: 'ck-late' })
  expect('超过 start+15min 拒绝签到（座位已释放）',
    !res.success && res.code === 'CHECKIN_EXPIRED' && store['ck-late'].status === 'pending_checkin',
    JSON.stringify(res))

  mk('ck-late-edge', { start_at: iso(-15 * 60e3 + 5e3), end_at: iso(3600e3) })
  res = await fn.main({ record_id: 'ck-late-edge' })
  expect('start+15min 边界内仍可签到', res.success, JSON.stringify(res))

  mk('ck-mismatch', { start_at: iso(-10 * 60e3), end_at: iso(3600e3) })
  res = await fn.main({ record_id: 'ck-mismatch', seat_code: 'B02' })
  expect('扫码座位不一致拒绝（带 expected）', !res.success && res.data && res.data.expected === 'A01', JSON.stringify(res))

  mk('ck-scan', { seat_id: 'A 01', start_at: iso(-10 * 60e3), end_at: iso(3600e3) })
  res = await fn.main({ record_id: 'ck-scan', seat_code: 'a01' })
  expect('座位号规范化后匹配（F9：A 01 vs a01）', res.success && store['ck-scan'].status === 'active'
    && store['ck-scan'].payload.checkin_method === 'scan', JSON.stringify(res))

  mk('ck-other', { user_id: OTHER_HASH, start_at: iso(-10 * 60e3), end_at: iso(3600e3) })
  res = await fn.main({ record_id: 'ck-other' })
  expect('非本人预约拒绝', !res.success && /无权/.test(res.message), JSON.stringify(res))

  store['ck-active'] = { _id: 'ck-active', user_id: OWNER_HASH, record_type: 'reservation', status: 'active', start_at: iso(-10 * 60e3), end_at: iso(3600e3), payload: {} }
  res = await fn.main({ record_id: 'ck-active' })
  expect('active 状态不可重复签到', !res.success && /不可签到/.test(res.message), JSON.stringify(res))

  res = await fn.main({ record_id: 'ck-ok', seat_code: 12345 })
  expect('seat_code 非字符串拒绝（validator）', !res.success && /seat_code/.test(res.message), JSON.stringify(res))

  // streak：签到成功会更新 users 文档（幂等容错，失败不阻断签到）
  const t = fn.__test
  expect('nextStreak: 首次签到=1', t.nextStreak(0, '', '2026-09-18', '2026-09-17') === 1, 'first')
  expect('nextStreak: 昨天签过=2', t.nextStreak(1, '2026-09-17', '2026-09-18', '2026-09-17') === 2, 'yesterday')
  expect('nextStreak: 断签重计=1', t.nextStreak(5, '2026-09-10', '2026-09-18', '2026-09-17') === 1, 'broken')
  expect('nextStreak: 同日保持', t.nextStreak(3, '2026-09-18', '2026-09-18', '2026-09-17') === 3, 'same-day')
  // users 文档记账
  const todayKey = t.beijingDateKey(Date.now())
  const us = { _id: OWNER_HASH, open_id_hash: OWNER_HASH, streak: 1, last_checkin_date: t.beijingDateKey(Date.now() - 24 * 3600e3), total_checkin: 1 }
  store[OWNER_HASH] = us
  try {
    await t.recordDailyCheckin(OWNER_HASH, new Date().toISOString())
    const updated = store[OWNER_HASH]
    expect('签到后 streak=2', updated.streak === 2, JSON.stringify(updated))
    expect('签到后 total_checkin=2', updated.total_checkin === 2, JSON.stringify(updated))
    expect('签到后 last_checkin_date=今天', updated.last_checkin_date === todayKey, JSON.stringify(updated))
  } catch (e) {
    expect('recordDailyCheckin 执行无异常', false, (e && e.message) || String(e))
  }

  // 邀请裂变奖励：被邀人首次签到 → 双方各 +1
  const INVITER_HASH = hash('inviter-001')
  store[OWNER_HASH] = { _id: OWNER_HASH, open_id_hash: OWNER_HASH, invited_by: INVITER_HASH, invite_credit: 0 }
  store[INVITER_HASH] = { _id: INVITER_HASH, open_id_hash: INVITER_HASH, invite_credit: 0 }
  try {
    await t.rewardInviterOnFirstCheckin(OWNER_HASH, new Date().toISOString())
    expect('被邀人标记已奖励', store[OWNER_HASH].invite_rewarded === true, JSON.stringify(store[OWNER_HASH]))
    expect('被邀人自己 invite_credit +1', store[OWNER_HASH].invite_credit === 1, JSON.stringify(store[OWNER_HASH]))
    expect('邀请人 invite_credit +1', store[INVITER_HASH].invite_credit === 1, JSON.stringify(store[INVITER_HASH]))
    // 幂等：再次调用不加
    await t.rewardInviterOnFirstCheckin(OWNER_HASH, new Date().toISOString())
    expect('重复调用不再加分（双方幂等）', store[INVITER_HASH].invite_credit === 1 && store[OWNER_HASH].invite_credit === 1, JSON.stringify(store[INVITER_HASH]) + ' / ' + JSON.stringify(store[OWNER_HASH]))
  } catch (e) {
    expect('rewardInviter 执行无异常', false, (e && e.message) || String(e))
  }

  if (prevRequire === undefined) delete process.env.CHECKIN_REQUIRE_CODE
  else process.env.CHECKIN_REQUIRE_CODE = prevRequire
}

// ============ checkin：到店签到码（防远程签到） ============
async function testCheckinCode() {
  console.log('\n== checkin: 到店签到码 ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'checkin', 'index.js'))
  const t = fn.__test
  WX_OPENID = 'owner-001'
  const prevRequire = process.env.CHECKIN_REQUIRE_CODE
  delete process.env.CHECKIN_REQUIRE_CODE // 默认即强制校验

  const today = t.beijingDateKey(Date.now())
  const expectCode = t.dailyRoomCode('r1', today)
  const mk = (id, extra) => {
    store[id] = {
      _id: id, user_id: OWNER_HASH, record_type: 'reservation', status: 'pending_checkin',
      room_id: 'r1', seat_id: 'A01', payload: {}, created_at: iso(-3600e3), updated_at: iso(-3600e3),
      start_at: iso(-10 * 60e3), end_at: iso(3600e3),
      ...extra,
    }
  }

  expect('派生码为 4 位数字', /^\d{4}$/.test(expectCode), expectCode)
  expect('同房间同日派生稳定', t.dailyRoomCode('r1', today) === expectCode, expectCode)
  expect('不同房间派生不同', t.dailyRoomCode('r2', today) !== expectCode,
    `${t.dailyRoomCode('r1', today)} vs ${t.dailyRoomCode('r2', today)}`)
  expect('不同日期派生不同', t.dailyRoomCode('r1', '2000-01-01') !== expectCode, expectCode)
  expect('默认强制校验', t.requireCodeEnabled() === true, String(t.requireCodeEnabled()))

  // 1) 无凭证 → 拒绝并要求签到码
  mk('cc-none')
  let res = await fn.main({ record_id: 'cc-none' })
  expect('无凭证拒绝 + NEED_CHECKIN_CODE', !res.success && res.code === 'NEED_CHECKIN_CODE'
    && store['cc-none'].status === 'pending_checkin', JSON.stringify(res))

  // 2) 错误码 → 拒绝
  mk('cc-wrong')
  res = await fn.main({ record_id: 'cc-wrong', checkin_code: '0000' === expectCode ? '1111' : '0000' })
  expect('错误签到码拒绝', !res.success && res.code === 'NEED_CHECKIN_CODE'
    && store['cc-wrong'].status === 'pending_checkin', JSON.stringify(res))

  // 3) 正确动态码 → 签到成功
  mk('cc-ok')
  res = await fn.main({ record_id: 'cc-ok', checkin_code: expectCode })
  expect('正确签到码 → active + method=code', res.success && store['cc-ok'].status === 'active'
    && store['cc-ok'].payload.checkin_method === 'code', JSON.stringify(res))

  // 4) 房间自定义固定码优先于动态码
  store['r-fixed'] = { _id: 'r-fixed', type: 'room', name: '固定码房间', metadata: { checkin_code: '8899' } }
  mk('cc-fixed', { room_id: 'r-fixed' })
  res = await fn.main({ record_id: 'cc-fixed', checkin_code: '8899' })
  expect('房间固定码可签到', res.success && store['cc-fixed'].payload.checkin_method === 'code', JSON.stringify(res))

  mk('cc-fixed-dyn', { room_id: 'r-fixed' })
  res = await fn.main({
    record_id: 'cc-fixed-dyn',
    checkin_code: t.dailyRoomCode('r-fixed', today),
  })
  expect('设了固定码后动态码失效', !res.success && res.code === 'NEED_CHECKIN_CODE', JSON.stringify(res))

  // 4.5) 管理页展示码兜底（metadata.checkin_code_today）：管理页看到的码一定能签
  store['r1'] = { _id: 'r1', type: 'room', name: '演示自习室', metadata: { checkin_code_today: { date: today, code: '2468' } } }
  mk('cc-displayed')
  res = await fn.main({ record_id: 'cc-displayed', checkin_code: '2468' })
  expect('管理页展示码兜底可签到', res.success && store['cc-displayed'].payload.checkin_method === 'code', JSON.stringify(res))

  // 4.6) 字母码大小写不敏感（AB12 输成 ab12 不误拒）
  store['r-case'] = { _id: 'r-case', type: 'room', name: '大小写房', metadata: { checkin_code: 'AB12' } }
  mk('cc-case', { room_id: 'r-case' })
  res = await fn.main({ record_id: 'cc-case', checkin_code: 'ab12' })
  expect('字母码大小写不敏感', res.success && store['cc-case'].payload.checkin_method === 'code', JSON.stringify(res))

  // 5) 扫码路径不受签到码约束（座位码匹配即通过）
  mk('cc-scan')
  res = await fn.main({ record_id: 'cc-scan', seat_code: 'a01' })
  expect('扫码签到无需签到码', res.success && store['cc-scan'].payload.checkin_method === 'scan', JSON.stringify(res))

  // 6) 显式关闭开关 → 无凭证放行（manual）
  process.env.CHECKIN_REQUIRE_CODE = '0'
  mk('cc-off')
  res = await fn.main({ record_id: 'cc-off' })
  expect('关闭开关后无凭证放行 method=manual', res.success
    && store['cc-off'].payload.checkin_method === 'manual', JSON.stringify(res))

  // 7) checkin_code 入参类型守卫
  mk('cc-type')
  res = await fn.main({ record_id: 'cc-type', checkin_code: 1234 })
  expect('checkin_code 非字符串拒绝（validator）', !res.success && /checkin_code/.test(res.message), JSON.stringify(res))

  if (prevRequire === undefined) delete process.env.CHECKIN_REQUIRE_CODE
  else process.env.CHECKIN_REQUIRE_CODE = prevRequire
}

// ============ adminOps：签到地理围栏配置 ============
async function testAdminOpsRoomGeo() {
  console.log('\n== adminOps: 签到地理围栏 ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'adminOps', 'index.js'))
  const checkin = require(path.join(process.cwd(), 'cloudfunctions', 'checkin', 'index.js'))
  delete process.env.ADMIN_OPENID_HASHES
  WX_OPENID = 'owner-001'
  store[OWNER_HASH] = { _id: OWNER_HASH, role: 'admin', nick_name: '管理员', created_at: iso(-1000) }
  store['geo-room'] = {
    _id: 'geo-room', type: 'room', status: 'active', name: '围栏店', code: 'g',
    metadata: { seats: [] }, created_at: iso(-3000),
  }

  let res = await fn.main({ action: 'roomGeo' })
  expect('roomGeo: 未配置时 enabled=false',
    res.success && res.data.rooms.length === 1 && res.data.rooms[0].enabled === false, JSON.stringify(res.data))
  expect('roomGeo: 声明坐标口径 gcj02', res.data.coord_system === 'gcj02', JSON.stringify(res.data))

  res = await fn.main({
    action: 'setRoomGeo', room_id: 'geo-room', lat: 39.9, lng: 116.4, radius: 150, address: '某某大厦 3 楼',
  })
  expect('setRoomGeo: 写入 metadata.geo',
    res.success && store['geo-room'].metadata.geo.lat === 39.9 && store['geo-room'].metadata.geo.radius === 150,
    JSON.stringify(res))

  res = await fn.main({ action: 'roomGeo' })
  const row = res.data.rooms.find((r) => r.room_id === 'geo-room')
  expect('roomGeo: 查询回填配置', row.enabled === true && row.radius === 150 && row.address === '某某大厦 3 楼', JSON.stringify(row))

  res = await fn.main({ action: 'setRoomGeo', room_id: 'geo-room', lat: 39.9, lng: 116.4, radius: 99999 })
  expect('半径上限夹取 2000', res.success && store['geo-room'].metadata.geo.radius === 2000, JSON.stringify(res))

  res = await fn.main({ action: 'setRoomGeo', room_id: 'geo-room', lat: 0, lng: 0 })
  expect('(0,0) 坐标拒绝', !res.success && res.code === 'INVALID_PAYLOAD', JSON.stringify(res))

  res = await fn.main({ action: 'setRoomGeo', room_id: 'ghost', lat: 39.9, lng: 116.4 })
  expect('房间不存在 → NOT_FOUND', !res.success && res.code === 'NOT_FOUND', JSON.stringify(res))

  // 端到端：管理端配的围栏必须被 checkin 云函数认可（两处半径/坐标口径必须一致）
  await fn.main({ action: 'setRoomGeo', room_id: 'geo-room', lat: 39.9, lng: 116.4, radius: 200 })
  store['geo-rec'] = {
    _id: 'geo-rec', user_id: OWNER_HASH, record_type: 'reservation', status: 'pending_checkin',
    room_id: 'geo-room', seat_id: 'A-1', payload: {},
    start_at: iso(-600e3), end_at: iso(3600e3), created_at: iso(-900e3), updated_at: iso(-900e3),
  }
  const prevRequire = process.env.CHECKIN_REQUIRE_CODE
  process.env.CHECKIN_REQUIRE_CODE = '0'
  let ck = await checkin.main({ record_id: 'geo-rec', lat: 39.9, lng: 116.45, accuracy: 20 })
  expect('★ 管理端配置的围栏对签到生效（围栏外拒绝）', !ck.success && ck.code === 'GEO_TOO_FAR', JSON.stringify(ck))
  ck = await checkin.main({ record_id: 'geo-rec', lat: 39.9002, lng: 116.4, accuracy: 20 })
  expect('围栏内签到成功（端到端）', ck.success && store['geo-rec'].status === 'active', JSON.stringify(ck))
  if (prevRequire === undefined) delete process.env.CHECKIN_REQUIRE_CODE
  else process.env.CHECKIN_REQUIRE_CODE = prevRequire

  res = await fn.main({ action: 'setRoomGeo', room_id: 'geo-room', clear: true })
  expect('clear 后关闭围栏', res.success && !store['geo-room'].metadata.geo, JSON.stringify(res))
}

// ============ checkin：地理围栏（防「拍照远程签到」） ============
async function testCheckinGeo() {
  console.log('\n== checkin: 地理围栏签到 ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'checkin', 'index.js'))
  const t = fn.__test
  WX_OPENID = 'owner-001'
  const prevRequire = process.env.CHECKIN_REQUIRE_CODE
  process.env.CHECKIN_REQUIRE_CODE = '0' // 先隔离签到码因素，单独测围栏

  /* ── 纯函数 ── */
  expect('同点距离为 0', t.haversineDistance(39.9, 116.4, 39.9, 116.4) === 0, 'same')
  const d111 = t.haversineDistance(39.9, 116.4, 39.901, 116.4)
  expect('纬度差 0.001° ≈ 111 米', Math.abs(d111 - 111) < 3, String(d111))
  expect('(0,0) 视为无效坐标', t.isValidLatLng(0, 0) === false, 'null-island')
  expect('越界纬度无效', t.isValidLatLng(91, 116.4) === false, 'lat91')
  expect('NaN 坐标无效', t.isValidLatLng(NaN, 116.4) === false, 'nan')
  expect('缺省半径 200', t.defaultGeoRadius() === 200, String(t.defaultGeoRadius()))
  expect('半径上限 2000', t.clampGeoRadius(99999) === 2000, 'max')
  expect('半径下限 20', t.clampGeoRadius(1) === 20, 'min')
  expect('非法半径回落默认', t.clampGeoRadius(-5) === 200, 'negative')
  expect('无 geo 配置 → 无围栏', t.resolveGeoFence({}) === null, 'empty')
  expect('geo 坐标非法 → 无围栏', t.resolveGeoFence({ geo: { lat: 0, lng: 0 } }) === null, 'bad')
  const f300 = t.resolveGeoFence({ geo: { lat: 39.9, lng: 116.4, radius: 300 } })
  expect('正常围栏解析', !!f300 && f300.lat === 39.9 && f300.radius === 300, JSON.stringify(f300))
  expect('未配半径取默认 200', (t.resolveGeoFence({ geo: { lat: 39.9, lng: 116.4 } }) || {}).radius === 200, 'default')

  const fence = { lat: 39.9, lng: 116.4, radius: 200 }
  const noFence = t.verifyGeo(null, 39.9, 116.4, 30)
  expect('无围栏放行（向后兼容）', noFence.ok === true && noFence.reason === 'no_fence', JSON.stringify(noFence))
  expect('围栏内通过', t.verifyGeo(fence, 39.9005, 116.4, 30).ok === true, 'inside')
  const far = t.verifyGeo(fence, 39.9, 116.41, 30)
  expect('围栏外拒绝 + 返回距离', !far.ok && far.reason === 'out_of_range' && far.distance > 200, JSON.stringify(far))
  expect('无坐标拒绝', t.verifyGeo(fence, undefined, undefined, undefined).reason === 'no_location', 'noloc')
  expect('定位精度过差拒绝', t.verifyGeo(fence, 39.9001, 116.4, 900).reason === 'low_accuracy', 'acc')

  /* ── 主流程 ── */
  const mk = (id, extra) => {
    store[id] = {
      _id: id, user_id: OWNER_HASH, record_type: 'reservation', status: 'pending_checkin',
      room_id: 'geo-room', seat_id: 'A01', payload: {}, created_at: iso(-3600e3), updated_at: iso(-3600e3),
      start_at: iso(-10 * 60e3), end_at: iso(3600e3),
      ...extra,
    }
  }
  store['geo-room'] = { _id: 'geo-room', type: 'room', name: '围栏店', metadata: { geo: { lat: 39.9, lng: 116.4, radius: 200 } } }
  store['nofence-room'] = { _id: 'nofence-room', type: 'room', name: '无围栏店', metadata: {} }
  const INSIDE = { lat: 39.9005, lng: 116.4, accuracy: 30 }
  const FAR = { lat: 39.9, lng: 116.41, accuracy: 30 }

  mk('g-ok')
  let res = await fn.main({ record_id: 'g-ok', ...INSIDE })
  expect('围栏内签到成功', res.success && store['g-ok'].status === 'active', JSON.stringify(res))
  expect('留痕签到距离（审计用）',
    !!(store['g-ok'].payload && store['g-ok'].payload.checkin_geo)
    && store['g-ok'].payload.checkin_geo.distance <= 200,
    JSON.stringify(store['g-ok'].payload))

  mk('g-far')
  res = await fn.main({ record_id: 'g-far', ...FAR })
  expect('围栏外拒绝 GEO_TOO_FAR 且不改状态',
    !res.success && res.code === 'GEO_TOO_FAR' && store['g-far'].status === 'pending_checkin', JSON.stringify(res))

  mk('g-noloc')
  res = await fn.main({ record_id: 'g-noloc' })
  expect('拿不到定位拒绝 GEO_REQUIRED', !res.success && res.code === 'GEO_REQUIRED', JSON.stringify(res))

  mk('g-acc')
  res = await fn.main({ record_id: 'g-acc', lat: 39.9001, lng: 116.4, accuracy: 900 })
  expect('定位精度过差拒绝 GEO_LOW_ACCURACY', !res.success && res.code === 'GEO_LOW_ACCURACY', JSON.stringify(res))

  /* ★ 核心防作弊：签到码正确、但人在围栏外 → 依然拒绝。
     静态码贴在座位上会被拍照传给别人，只有「人在现场」挡得住，
     所以围栏必须先于签到码校验。 */
  process.env.CHECKIN_REQUIRE_CODE = '1'
  const code = t.dailyRoomCode('geo-room', t.beijingDateKey(Date.now()))
  mk('g-code-far')
  res = await fn.main({ record_id: 'g-code-far', checkin_code: code, ...FAR })
  expect('★ 签到码正确但围栏外仍拒绝（拍照远程签到无效）',
    !res.success && res.code === 'GEO_TOO_FAR' && store['g-code-far'].status === 'pending_checkin', JSON.stringify(res))

  mk('g-code-in')
  res = await fn.main({ record_id: 'g-code-in', checkin_code: code, ...INSIDE })
  expect('围栏内 + 正确码 → 成功 method=code',
    res.success && store['g-code-in'].payload.checkin_method === 'code', JSON.stringify(res))
  process.env.CHECKIN_REQUIRE_CODE = '0'

  // 未配围栏的门店：无坐标也放行（平滑过渡，不给存量门店制造障碍）
  mk('g-nofence', { room_id: 'nofence-room' })
  res = await fn.main({ record_id: 'g-nofence' })
  expect('未配围栏门店无坐标也放行（向后兼容）', res.success, JSON.stringify(res))

  // 清理本组写入的房间，避免污染后续 adminOps 的房间列表断言
  delete store['geo-room']
  delete store['nofence-room']

  if (prevRequire === undefined) delete process.env.CHECKIN_REQUIRE_CODE
  else process.env.CHECKIN_REQUIRE_CODE = prevRequire
}

// ============ updateReservation（改约：冲突重校验 + 状态守卫） ============
async function testUpdateReservation() {
  console.log('\n== updateReservation: 改约（冲突重校验 + 状态守卫） ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'updateReservation', 'index.js'))
  WX_OPENID = 'owner-001'
  const OID = hash('owner-001')
  store['upd-1'] = {
    _id: 'upd-1', user_id: OID, record_type: 'reservation', status: 'pending_checkin',
    room_id: 'r1', seat_id: 's1', start_at: isoB(3600e3), end_at: isoB(7200e3),
    payload: { goal: '旧目标' }, created_at: iso(0), updated_at: iso(0),
  }
  store['upd-other'] = {
    _id: 'upd-other', user_id: 'x', record_type: 'reservation', status: 'pending_checkin',
    room_id: 'r1', seat_id: 's1', start_at: iso(9000e3), end_at: iso(12000e3),
  }

  // 注意：iso() 依赖 Date.now()，同一断言里两次调用可能相差 1ms，
  // 因此先取变量再比对，避免毫秒级抖动导致的偶发失败。
  const newStart = iso(13000e3)
  const newEnd = iso(15000e3)
  let res = await fn.main({ record_id: 'upd-1', start_at: newStart, end_at: newEnd, goal: '新目标' })
  expect('改约成功 → 更新 start/end', res.success && store['upd-1'].start_at === newStart && store['upd-1'].end_at === newEnd, JSON.stringify(res))
  expect('改约保留并覆盖 goal', store['upd-1'].payload.goal === '新目标', JSON.stringify(store['upd-1'].payload))

  WX_OPENID = 'owner-001'
  res = await fn.main({ record_id: 'upd-1', start_at: iso(9500e3), end_at: iso(11000e3) })
  expect('改约时段冲突 → SEAT_CONFLICT', !res.success && res.data && res.data.code === 'SEAT_CONFLICT', JSON.stringify(res))

  store['upd-active'] = {
    _id: 'upd-active', user_id: OID, record_type: 'reservation', status: 'active',
    room_id: 'r1', seat_id: 's2', start_at: iso(0), end_at: iso(7200e3),
  }
  res = await fn.main({ record_id: 'upd-active', start_at: isoB(3600e3), end_at: isoB(7200e3) })
  expect('非 pending_checkin 拒绝改约', !res.success && /待签到/.test(res.message), JSON.stringify(res))

  WX_OPENID = 'other-001'
  res = await fn.main({ record_id: 'upd-1', start_at: iso(13000e3), end_at: iso(15000e3) })
  expect('非本人预约拒绝', !res.success && /无权/.test(res.message), JSON.stringify(res))
  WX_OPENID = 'owner-001'

  res = await fn.main({ record_id: 'upd-1', start_at: iso(15000e3), end_at: iso(13000e3) })
  expect('end<=start 拒绝', !res.success, JSON.stringify(res))

  // ── 一键续时（extend_minutes）：active 仅顺延 end_at，start_at 不动 ──
  store['upd-ext'] = {
    _id: 'upd-ext', user_id: OID, record_type: 'reservation', status: 'active',
    room_id: 'r1', seat_id: 's3', start_at: iso(3600e3), end_at: iso(7200e3),
    payload: { goal: '专注' }, created_at: iso(0), updated_at: iso(0),
  }
  const extBefore = store['upd-ext'].end_at
  const startBefore = store['upd-ext'].start_at // 固化建档时刻：断言用同一值，避免 Date.now 毫秒抖动造成假失败
  res = await fn.main({ record_id: 'upd-ext', extend_minutes: 30 })
  expect('续时成功 → end_at 顺延 30 分钟', res.success && store['upd-ext'].end_at === new Date(new Date(extBefore).getTime() + 30 * 60 * 1000).toISOString(), JSON.stringify(res))
  expect('续时不改 start_at', store['upd-ext'].start_at === startBefore, JSON.stringify(store['upd-ext'].start_at))
  expect('续时记录 extended 标记', store['upd-ext'].payload.extended === true, JSON.stringify(store['upd-ext'].payload))

  res = await fn.main({ record_id: 'upd-ext', extend_minutes: 30, start_at: iso(13000e3) })
  expect('续时同时带改约时间 → 拒绝', !res.success, JSON.stringify(res))

  store['upd-pending-ext'] = {
    _id: 'upd-pending-ext', user_id: OID, record_type: 'reservation', status: 'pending_checkin',
    room_id: 'r1', seat_id: 's4', start_at: iso(9000e3), end_at: iso(10000e3),
    created_at: iso(0), updated_at: iso(0),
  }
  res = await fn.main({ record_id: 'upd-pending-ext', extend_minutes: 30 })
  expect('待签到状态续时 → 拒绝', !res.success && /使用中|暂离/.test(res.message), JSON.stringify(res))

  res = await fn.main({ record_id: 'upd-ext', extend_minutes: 10 })
  // validator 对 number 的 min/max 是「收敛（clamp）」而非「拒绝」：
  // 10 分钟会被钳到 15 分钟下限，续时仍然成功（服务端防恶意短续时）
  const clampBefore = new Date(store['upd-ext'].end_at).getTime()
  res = await fn.main({ record_id: 'upd-ext', extend_minutes: 10 })
  const clampOk =
    res.success &&
    new Date(store['upd-ext'].end_at).getTime() === clampBefore + 15 * 60 * 1000
  expect('续时 10 分钟被钳到 15 分钟下限', clampOk, JSON.stringify(res))

  WX_OPENID = 'other-001'
  res = await fn.main({ record_id: 'upd-ext', extend_minutes: 30 })
  expect('非本人记录续时 → 拒绝', !res.success && /无权/.test(res.message), JSON.stringify(res))
  WX_OPENID = 'owner-001'
}

// ============ expireRecords 爽约惩罚（no_show_count + 禁约） ============
async function testExpireNoShowPenalty() {
  console.log('\n== expireRecords: 爽约惩罚（no_show_count + 禁约） ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'expireRecords', 'index.js'))
  const old = iso(-40 * 60 * 1000)
  store['users-u1'] = { _id: 'users-u1', no_show_count: 1 }
  store['ns1'] = { _id: 'ns1', user_id: 'users-u1', record_type: 'reservation', status: 'pending_checkin', start_at: old }
  store['users-u2'] = { _id: 'users-u2', no_show_count: 0 }
  store['ns2'] = { _id: 'ns2', user_id: 'users-u2', record_type: 'reservation', status: 'pending_checkin', start_at: old }

  const res = await fn.main({})
  expect('u1 no_show_count 1→2', store['users-u1'].no_show_count === 2, JSON.stringify(store['users-u1']))
  expect('u1 第 2 次违规 → 禁约 2 小时', (() => {
    const ms = Date.parse(store['users-u1'].banned_until || '') - Date.now()
    return ms > 110 * 60 * 1000 && ms <= 120 * 60 * 1000
  })(), JSON.stringify(store['users-u1']))
  expect('u2 no_show_count 0→1', store['users-u2'].no_show_count === 1, JSON.stringify(store['users-u2']))
  expect('u2 第 1 次违规 → 禁约 30 分钟', (() => {
    const ms = Date.parse(store['users-u2'].banned_until || '') - Date.now()
    return ms > 28 * 60 * 1000 && ms <= 30 * 60 * 1000
  })(), JSON.stringify(store['users-u2']))
  expect('penalized_users=2', res.data && res.data.penalized_users === 2, JSON.stringify(res.data))
  expect('no_show=2', res.data && res.data.no_show === 2, JSON.stringify(res.data))
}

// ============ createReservation 禁约校验 ============
async function testCreateReservationBan() {
  console.log('\n== createReservation: 禁约校验 ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'createReservation', 'index.js'))
  WX_OPENID = 'banned-001'
  const BID = hash('banned-001')
  store[BID] = { _id: BID, no_show_count: 5, banned_until: new Date(Date.now() + 3600e3).toISOString() }
  let res = await fn.main({ room_id: 'r9', seat_id: 's9', start_at: isoB(3600e3), end_at: isoB(7200e3) })
  expect('禁约期内新建预约被拒（BANNED）', !res.success && res.data && res.data.code === 'BANNED', JSON.stringify(res))

  store[BID].banned_until = new Date(Date.now() - 3600e3).toISOString()
  res = await fn.main({ room_id: 'r9', seat_id: 's9', start_at: isoB(3600e3), end_at: isoB(7200e3) })
  expect('禁约期过后可正常预约', res.success, JSON.stringify(res))
  WX_OPENID = 'owner-001'
}

// ============ notify：type 路径拼装（单一配置源） ============
async function testNotifyTypePath() {
  console.log('\n== notify: type 路径拼装（单一配置源） ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'notify', 'index.js'))
  openapiSends.length = 0

  let res = await fn.main({
    action: 'send', type: 'reservationWarn', openid: 'u-1',
    main: '静学馆', time: '2026年9月16日 16:28', extra: '未签到已记为爽约', page: 'pages/x/x',
  })
  expect('type 路径发送成功', res.success === true, JSON.stringify(res))
  expect('openapi.send 被调用一次', openapiSends.length === 1, JSON.stringify(openapiSends))
  const d = openapiSends[0] && openapiSends[0].data
  // 2026-09-22 起字段名与公众平台模板详情逐字对齐：客户预约提醒 = 门店thing1/时间time7/事项thing6/预约人thing2
  expect('thing1=main(门店)', d && d.thing1 && d.thing1.value === '静学馆', JSON.stringify(d))
  expect('time7=time', d && d.time7 && d.time7.value === '2026年9月16日 16:28', JSON.stringify(d))
  expect('thing6=extra(预约事项)', d && d.thing6 && d.thing6.value === '未签到已记为爽约', JSON.stringify(d))
  expect('thing2=预约人兜底非空', d && d.thing2 && d.thing2.value === '专注座用户', JSON.stringify(d))
  expect('模板 4 个关键词全部有值（缺一即 47003）', d && ['thing1', 'time7', 'thing6', 'thing2'].every((k) => d[k] && d[k].value), JSON.stringify(d))
  expect('touser=传入 openid', openapiSends[0] && openapiSends[0].touser === 'u-1', JSON.stringify(openapiSends[0]))

  // 事物型字段超 20 字 → 截断兜底
  openapiSends.length = 0
  await fn.main({ action: 'send', type: 'reservationCancel', openid: 'u-2', main: 'x'.repeat(50), extra: '已为您取消预约' })
  const d2 = openapiSends[0] && openapiSends[0].data
  expect('main 超长被截断到 20 字', d2 && d2.thing1.value.length === 20, d2 && d2.thing1.value)

  // 缺 openid → NO_OPENID（临时把 mock 的 OPENID 置空）
  const saved = WX_OPENID
  WX_OPENID = ''
  res = await fn.main({ action: 'send', type: 'reservationWarn' })
  WX_OPENID = saved
  expect('缺 openid → NO_OPENID', res.success === false && res.code === 'NO_OPENID', JSON.stringify(res))

  // 缺 type 且无 templateId → NO_TEMPLATE
  res = await fn.main({ action: 'send', openid: 'u' })
  expect('缺 type/templateId → NO_TEMPLATE', res.success === false && res.code === 'NO_TEMPLATE', JSON.stringify(res))

  // 兼容旧路径：templateId + data 直达
  openapiSends.length = 0
  res = await fn.main({ action: 'send', openid: 'u-3', templateId: 'TID', data: { thing1: { value: 'A' } } })
  expect('旧路径 templateId 可用', res.success && openapiSends[0] && openapiSends[0].templateId === 'TID', JSON.stringify(openapiSends[0]))
}

// ============ createReservation：payload 持久化 openid/room_name ============
async function testCreateReservationPersistOpenid() {
  console.log('\n== createReservation: payload 持久化 openid/room_name ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'createReservation', 'index.js'))
  WX_OPENID = 'owner-001'
  store['r-persist'] = { _id: 'r-persist', type: 'room', name: '静学馆', metadata: { open_time: '00:00', close_time: '23:59' } }

  const res = await fn.main({ room_id: 'r-persist', seat_id: 's-p', start_at: isoB(3600e3), end_at: isoB(7200e3), goal: '复习' })
  const newId = res.data && res.data._id
  expect('预约成功', res.success && !!store[newId], JSON.stringify(res))
  expect('payload.openid 落库', store[newId] && store[newId].payload && store[newId].payload.openid === 'owner-001', JSON.stringify(store[newId] && store[newId].payload))
  expect('payload.room_name 落库', store[newId] && store[newId].payload && store[newId].payload.room_name === '静学馆', JSON.stringify(store[newId] && store[newId].payload))
}

// ============ expireRecords：签到提醒 + 超时预警推送 ============
async function testExpireReminderAndWarn() {
  console.log('\n== expireRecords: 签到提醒 + 超时预警推送 ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'expireRecords', 'index.js'))
  notifyCalls.length = 0

  const future = iso(20 * 60 * 1000) // 20 分钟后开始（落在 30min 提醒窗口内）
  store['rem-1'] = {
    _id: 'rem-1', user_id: OWNER_HASH, record_type: 'reservation', status: 'pending_checkin',
    room_id: 'r1', seat_id: 's1', start_at: future,
    payload: { openid: 'user-rem', room_name: '静学馆' },
    created_at: iso(0), updated_at: iso(0),
  }
  store['rem-done'] = {
    _id: 'rem-done', user_id: OWNER_HASH, record_type: 'reservation', status: 'pending_checkin',
    room_id: 'r1', seat_id: 's2', start_at: future,
    payload: { openid: 'user-done', room_name: '静学馆', checkin_reminded: true },
    created_at: iso(0), updated_at: iso(0),
  }
  const past = iso(-40 * 60 * 1000)
  store['ns-a'] = {
    _id: 'ns-a', user_id: OWNER_HASH, record_type: 'reservation', status: 'pending_checkin',
    start_at: past, payload: { openid: 'user-ns', room_name: '静学馆' },
  }
  store['ns-b'] = {
    _id: 'ns-b', user_id: OWNER_HASH, record_type: 'reservation', status: 'paused',
    updated_at: past, start_at: past, payload: { openid: 'user-ns2', room_name: '静学馆' },
  }

  const res = await fn.main({})

  const remind = notifyCalls.filter((c) => c.type === 'checkinReminder')
  expect('签到提醒发给 rem-1', remind.length === 1 && remind[0].openid === 'user-rem', JSON.stringify(notifyCalls))
  expect('已提醒过的不重复发', store['rem-done'].payload.checkin_reminded === true && remind.every((c) => c.openid !== 'user-done'), JSON.stringify(notifyCalls))
  expect('rem-1 标记已提醒', store['rem-1'].payload.checkin_reminded === true, JSON.stringify(store['rem-1'].payload))

  const warn = notifyCalls.filter((c) => c.type === 'reservationWarn')
  expect('超时预警 2 条', warn.length === 2, JSON.stringify(notifyCalls))
  expect('ns-a 收到 pending 预警', warn.some((c) => c.openid === 'user-ns' && /已记为爽约/.test(c.extra)), JSON.stringify(notifyCalls))
  expect('ns-b 收到 leave 预警', warn.some((c) => c.openid === 'user-ns2' && /座位已释放/.test(c.extra)), JSON.stringify(notifyCalls))
  expect('提醒数计入统计', res.data && res.data.reminded === 1, JSON.stringify(res.data))
}

// ============ submitReview（评价闭环：completed 可评 / 幂等 / validator clamp） ============
async function testSubmitReview() {
  console.log('\n== submitReview: completed 可评 / 幂等 / clamp ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'submitReview', 'index.js'))
  const prevHash = WX_OPENID
  WX_OPENID = 'review-user-001'
  const RID = hash('review-user-001')

  // 1) completed 记录可评价 → 落 reviews 集合
  store['rev-rec'] = {
    _id: 'rev-rec', user_id: RID, record_type: 'reservation', status: 'completed',
    room_id: 'r1', seat_id: 'A01', start_at: '2026-09-17T02:00:00.000Z', end_at: '2026-09-17T04:00:00.000Z', payload: {},
  }
  let res = await fn.main({ record_id: 'rev-rec', rating: 5, content: '靠窗很好，推荐' })
  expect('completed 可评价成功', res.success, JSON.stringify(res))
  // 落库在独立文档 rev_<record_id>（reviews 集合），不覆盖原预约记录
  const revDoc = store['rev_rev-rec']
  expect('reviews 落库评分 5 + 文案 + 房间', revDoc && revDoc.rating === 5 && revDoc.content === '靠窗很好，推荐' && revDoc.room_id === 'r1', JSON.stringify(revDoc))
  expect('原预约记录未被覆盖', store['rev-rec'].record_type === 'reservation' && store['rev-rec'].status === 'completed', JSON.stringify(store['rev-rec']))

  // 2) 重复提交幂等（已存在 → 直接返回 already）
  res = await fn.main({ record_id: 'rev-rec', rating: 4, content: '改主意' })
  expect('重复提交幂等成功（already）', res.success && res.data.already === true, JSON.stringify(res))

  // 3) 非 completed 拒绝
  store['rev-pp'] = { _id: 'rev-pp', user_id: RID, record_type: 'reservation', status: 'pending_checkin', payload: {} }
  res = await fn.main({ record_id: 'rev-pp', rating: 3 })
  expect('pending_checkin 拒绝', !res.success && /已完成/.test(res.message), JSON.stringify(res))

  // 4) 非本人拒绝
  store['rev-other'] = { _id: 'rev-other', user_id: 'someone-else', record_type: 'reservation', status: 'completed', payload: {} }
  res = await fn.main({ record_id: 'rev-other', rating: 5 })
  expect('非本人拒绝', !res.success && /无权/.test(res.message), JSON.stringify(res))

  // 5) rating>5 被 validator 收敛到 5
  res = await fn.main({ record_id: 'rev-rec', rating: 99 })
  expect('rating>5 收敛到 5', res.success && res.data.rating === 5, JSON.stringify(res))

  WX_OPENID = prevHash
}

// ============ 意见反馈闭环（submitFeedback + adminOps listFeedback/markFeedbackHandled）+ 手机号绑定守卫 ============
async function testFeedbackLoop() {
  console.log('\n== 意见反馈闭环 + 手机号绑定守卫 ==')
  resetStore()
  const sf = require(path.join(process.cwd(), 'cloudfunctions', 'submitFeedback', 'index.js'))
  const admin = require(path.join(process.cwd(), 'cloudfunctions', 'adminOps', 'index.js'))
  const bp = require(path.join(process.cwd(), 'cloudfunctions', 'bindPhone', 'index.js'))

  const prevHash = WX_OPENID
  WX_OPENID = 'owner-001'
  store[OWNER_HASH] = { _id: OWNER_HASH, role: 'admin', nick_name: '管理员', created_at: iso(-1000) }

  // 1) 正常提交 → 落 records 集合
  let res = await sf.main({ category: '功能建议', content: '希望增加一个静音区', images: ['cloud://a', 'cloud://b'] })
  expect('submitFeedback 成功', res.success, JSON.stringify(res))
  const fb = Object.values(store).find((d) => d.record_type === 'feedback')
  expect('反馈落库 records(record_type=feedback)', !!fb, JSON.stringify(store))
  expect('反馈字段正确', fb && fb.user_id === OWNER_HASH && fb.status === 'pending' &&
    fb.category === '功能建议' && fb.content === '希望增加一个静音区' && fb.images.length === 2,
    JSON.stringify(fb))

  // 2) 非法类型拒绝
  res = await sf.main({ category: '作弊', content: '随便写点东西啦' })
  expect('非法反馈类型拒绝', !res.success && /类型/.test(res.message), JSON.stringify(res))

  // 3) 内容过短拒绝
  res = await sf.main({ category: '其他', content: '短' })
  expect('内容过短拒绝', !res.success && /5 个字/.test(res.message), JSON.stringify(res))

  // 4) 管理端列表（待处理）命中
  res = await admin.main({ action: 'listFeedback', status: 'pending' })
  expect('listFeedback(pending) 命中 1 条', res.success && res.data.list.length === 1 &&
    res.data.list[0].feedback_id === fb._id, JSON.stringify(res.data))

  // 5) 标记已处理
  res = await admin.main({ action: 'markFeedbackHandled', feedback_id: fb._id })
  expect('markFeedbackHandled 成功', res.success && res.data.status === 'handled', JSON.stringify(res))
  expect('原记录状态已更新为 handled', store[fb._id].status === 'handled', JSON.stringify(store[fb._id]))

  // 6) 过滤：handled 命中 / pending 清空
  res = await admin.main({ action: 'listFeedback', status: 'handled' })
  expect('listFeedback(handled) 命中 1 条', res.success && res.data.list.length === 1, JSON.stringify(res.data))
  res = await admin.main({ action: 'listFeedback', status: 'pending' })
  expect('listFeedback(pending) 已清空', res.success && res.data.list.length === 0, JSON.stringify(res.data))

  // 7) 手机号绑定：未配置 WX_APP_SECRET → 优雅失败（不崩、不发起网络请求）
  const prevSecret = process.env.WX_APP_SECRET
  delete process.env.WX_APP_SECRET
  WX_OPENID = 'phone-user'
  res = await bp.main({ code: 'dummy-code' })
  expect('bindPhone 未配置密钥优雅失败', !res.success && res.code === 'NOT_CONFIGURED', JSON.stringify(res))
  if (prevSecret === undefined) delete process.env.WX_APP_SECRET
  else process.env.WX_APP_SECRET = prevSecret

  WX_OPENID = prevHash
}

// ============ 客服闭环：后台回复 + 用户端「我的反馈」可见 ============
async function testFeedbackReplyLoop() {
  console.log('\n== 客服闭环：replyFeedback + listMine ==')
  resetStore()
  const sf = require(path.join(process.cwd(), 'cloudfunctions', 'submitFeedback', 'index.js'))
  const admin = require(path.join(process.cwd(), 'cloudfunctions', 'adminOps', 'index.js'))

  const prevHash = WX_OPENID
  const USER = 'fb-user-001'
  WX_OPENID = USER
  const UH = hash(USER)
  store[UH] = { _id: UH, role: 'student', nick_name: '同学', created_at: iso(-1000) }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // 1) 用户提交两条反馈（间隔一下，保证 created_at 不同，才测得准倒序）
  let res = await sf.main({ category: '问题反馈', content: '签到码输入后一直提示错误' })
  expect('用户提交反馈 A', res.success, JSON.stringify(res))
  await sleep(5)
  res = await sf.main({ category: '功能建议', content: '希望能预约一整天的座位' })
  expect('用户提交反馈 B', res.success, JSON.stringify(res))

  // 2) listMine 只返回本人的两条，倒序（新的在前）
  res = await sf.main({ action: 'listMine' })
  expect('listMine 返回 2 条', res.success && res.data.list.length === 2, JSON.stringify(res.data))
  expect('listMine 倒序（新在前）', res.data.list[0].content.indexOf('一整天') >= 0, JSON.stringify(res.data.list))
  expect('listMine 初始无回复', res.data.list.every((x) => !x.reply && x.status === 'pending'),
    JSON.stringify(res.data.list))

  // 3) 他人看不到：换 openid 后为空
  WX_OPENID = 'fb-user-002'
  const resOther = await sf.main({ action: 'listMine' })
  expect('listMine 隔离他人数据', resOther.success && resOther.data.list.length === 0, JSON.stringify(resOther.data))

  // 4) 取两条待回复的 id（切回用户身份）
  WX_OPENID = USER
  const mine = await sf.main({ action: 'listMine' })
  const fid = mine.data.list[0].feedback_id
  const fid2 = mine.data.list[1].feedback_id

  // 5) 后台回复（切到管理员身份；本用例未配 ADMIN_OPENID_HASHES，靠 users.role=admin 放行）
  WX_OPENID = 'owner-001'
  store[hash('owner-001')] = {
    _id: hash('owner-001'), role: 'admin', nick_name: '管理员', created_at: iso(-1000),
  }
  res = await admin.main({ action: 'replyFeedback', feedback_id: fid, reply: '已修复，请更新后重试' })
  expect('replyFeedback 成功', res.success && res.data.status === 'replied', JSON.stringify(res))
  expect('replyFeedback 回显回复内容', res.success && res.data.reply === '已修复，请更新后重试', JSON.stringify(res))

  // 6) 空回复退化为仅标记已处理（不写 reply / replied_at，直接关闭）
  res = await admin.main({ action: 'replyFeedback', feedback_id: fid2, reply: '' })
  expect('空回复退化为已关闭', res.success && res.data.status === 'handled' && res.data.reply === '', JSON.stringify(res))

  // 7) 缺 feedback_id 拒绝
  res = await admin.main({ action: 'replyFeedback', reply: '没有 id' })
  expect('replyFeedback 缺 id 拒绝', !res.success && /feedback_id/.test(res.message), JSON.stringify(res))

  // 8) 后台列表按「已回复」筛选并回显 reply / followups
  res = await admin.main({ action: 'listFeedback', status: 'replied' })
  expect('listFeedback 按 replied 筛选', res.success && res.data.list.length === 1, JSON.stringify(res.data))
  expect('listFeedback 回显 reply', res.success && res.data.list.some((x) => x.reply === '已修复，请更新后重试'),
    JSON.stringify(res.data))

  // 9) 回到用户身份：能看到回复，状态是「已回复」而不是直接关闭
  WX_OPENID = USER
  const after = await sf.main({ action: 'listMine' })
  const hit = after.data.list.find((x) => x.feedback_id === fid)
  expect('用户端可见后台回复', hit && hit.reply === '已修复，请更新后重试' && !!hit.replied_at, JSON.stringify(hit))
  expect('回复后状态为 replied（等用户确认）', hit && hit.status === 'replied', JSON.stringify(hit))
  const hit2 = after.data.list.find((x) => x.feedback_id === fid2)
  expect('空回复不写入 reply/replied_at', hit2 && !hit2.reply && !hit2.replied_at && hit2.status === 'handled',
    JSON.stringify(hit2))

  // 10) 用户追问：工单打回 pending，后台重新看到它（闭环不能断在「回了一句」）
  res = await sf.main({ action: 'followUp', feedback_id: fid, content: '更新后还是不行，怎么办' })
  expect('追问成功且状态打回 pending', res.success && res.data.status === 'pending', JSON.stringify(res))
  res = await sf.main({ action: 'listMine' })
  const hit3 = res.data.list.find((x) => x.feedback_id === fid)
  expect('追问内容留痕', hit3 && hit3.followups.length === 1
    && hit3.followups[0].content === '更新后还是不行，怎么办', JSON.stringify(hit3))
  expect('追问后仍保留原回复', hit3 && hit3.reply === '已修复，请更新后重试', JSON.stringify(hit3))
  WX_OPENID = 'owner-001'
  res = await admin.main({ action: 'listFeedback', status: 'pending' })
  expect('追问后重新出现在待处理', res.success && res.data.list.some((x) => x.feedback_id === fid
    && x.followups.length === 1), JSON.stringify(res.data))
  WX_OPENID = USER

  // 11) 追问校验：太短 / 缺 id / 他人越权
  res = await sf.main({ action: 'followUp', feedback_id: fid, content: '好' })
  expect('追问过短拒绝', !res.success, JSON.stringify(res))
  res = await sf.main({ action: 'followUp', content: '没有 id 的追问' })
  expect('追问缺 id 拒绝', !res.success && /feedback_id/.test(res.message), JSON.stringify(res))
  WX_OPENID = 'fb-user-002'
  res = await sf.main({ action: 'followUp', feedback_id: fid, content: '我不是本人也想追问' })
  expect('追问越权拒绝', !res.success, JSON.stringify(res))
  res = await sf.main({ action: 'close', feedback_id: fid })
  expect('关闭越权拒绝', !res.success, JSON.stringify(res))

  // 12) 后台再回复一轮 → 用户确认解决 → 关闭
  WX_OPENID = 'owner-001'
  res = await admin.main({ action: 'replyFeedback', feedback_id: fid, reply: '请重新安装小程序再试' })
  expect('二次回复成功', res.success && res.data.status === 'replied', JSON.stringify(res))
  WX_OPENID = USER
  res = await sf.main({ action: 'close', feedback_id: fid })
  expect('用户确认解决后关闭', res.success && res.data.status === 'handled', JSON.stringify(res))
  res = await sf.main({ action: 'listMine' })
  const hit4 = res.data.list.find((x) => x.feedback_id === fid)
  expect('关闭后状态为 handled 且保留两条往来', hit4 && hit4.status === 'handled'
    && hit4.followups.length === 1 && !!hit4.reply, JSON.stringify(hit4))

  WX_OPENID = prevHash
}

// ============ 工单身份与 SLA（后台要认人、要知道等了多久） ============
async function testFeedbackIdentityAndSla() {
  console.log('\n== 客服工单：提交者身份 + SLA 超时 ==')
  const sf = require(path.join(process.cwd(), 'cloudfunctions', 'submitFeedback', 'index.js'))
  const admin = require(path.join(process.cwd(), 'cloudfunctions', 'adminOps', 'index.js'))
  const prevHash = WX_OPENID
  const USER = 'fb-sla-user'
  const UH = hash(USER)
  const OH = hash('owner-001')

  // 管理员身份（前面用例可能改过，这里兜底补一次）
  if (store[OH]) store[OH].role = 'admin'
  else store[OH] = { _id: OH, open_id_hash: OH, nick_name: '管理员', role: 'admin', created_at: iso(0) }
  store[UH] = { _id: UH, open_id_hash: UH, nick_name: '小林', role: 'student', created_at: iso(0) }

  // 1) 提交时把昵称写进工单 —— 后台只有 32 位哈希是认不出人的
  WX_OPENID = USER
  let res = await sf.main({ category: '问题反馈', content: '座位图点了没反应，一直转圈' })
  expect('提交成功', res.success, JSON.stringify(res))
  const fid = res.data && res.data._id
  expect('工单写入提交者昵称', store[fid] && store[fid].nick_name === '小林', JSON.stringify(store[fid]))

  // 2) 后台列表：认人 + 计时
  WX_OPENID = 'owner-001'
  res = await admin.main({ action: 'listFeedback', status: 'pending' })
  let row = (res.data.list || []).find((x) => x.feedback_id === fid)
  expect('后台可见提交者昵称', row && row.nick_name === '小林', JSON.stringify(row))
  expect('后台可见短 ID', row && row.user_short === UH.slice(0, 6), JSON.stringify(row))
  expect('新工单未超时', row && row.overdue === false && row.waiting_ms >= 0, JSON.stringify(row))

  // 3) 搁置超过 24 小时 → 标超时
  store[fid].created_at = new Date(Date.now() - 25 * 3600 * 1000).toISOString()
  res = await admin.main({ action: 'listFeedback', status: 'pending' })
  row = (res.data.list || []).find((x) => x.feedback_id === fid)
  expect('超过 24h 标记超时', row && row.overdue === true, JSON.stringify(row))

  // 4) 用户追问后重新计时（否则刚催过的单子会被误判成超时）
  store[fid].followups = [{ content: '还在吗？', created_at: new Date().toISOString() }]
  res = await admin.main({ action: 'listFeedback', status: 'pending' })
  row = (res.data.list || []).find((x) => x.feedback_id === fid)
  expect('追问后重新计时不再超时', row && row.overdue === false, JSON.stringify(row))

  // 5) 看板统计：不用切进「反馈」Tab 也知道有几条待处理
  res = await admin.main({ action: 'overview' })
  const fb = res.data && res.data.feedback
  expect('overview 含反馈统计', !!fb && typeof fb.pending === 'number', JSON.stringify(fb))
  expect('overview 待处理 >= 1', !!fb && fb.pending >= 1, JSON.stringify(fb))

  // 6) 查不到档案也必须能提交（昵称只是增强信息，不能阻断反馈）
  WX_OPENID = 'fb-no-profile'
  res = await sf.main({ category: '其他', content: '没有档案也要能提交反馈' })
  expect('无档案也能提交', res.success, JSON.stringify(res))
  expect('无档案时昵称为空串', store[res.data._id].nick_name === '', JSON.stringify(store[res.data._id]))

  WX_OPENID = prevHash
}

// ============ login 返回信誉字段 ============
async function testLoginBanFields() {
  console.log('\n== login: 返回信誉字段（noShowCount / bannedUntil） ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'login', 'index.js'))
  WX_OPENID = 'login-001'
  const LID = hash('login-001')
  store[LID] = {
    _id: LID, open_id_hash: LID, nick_name: '阿强', role: 'student',
    no_show_count: 3, banned_until: new Date(Date.now() + 3600e3).toISOString(),
    created_at: iso(0), updated_at: iso(0),
  }
  const res = await fn.main({})
  expect('login 返回 noShowCount=3', res.success && res.data.noShowCount === 3, JSON.stringify(res.data))
  expect('login 返回 bannedUntil', res.success && !!res.data.bannedUntil, JSON.stringify(res.data))

  WX_OPENID = 'login-new'
  const res2 = await fn.main({})
  expect('新用户 noShowCount 默认 0', res2.success && res2.data.noShowCount === 0, JSON.stringify(res2.data))
  WX_OPENID = 'owner-001'
}

// ============ 暂离中(paused) 座位仍视为占用 ============
async function testPausedSeatOccupancy() {
  console.log('\n== 暂离中(paused) 座位仍占用 ==')
  const roomListFn = require(path.join(process.cwd(), 'cloudfunctions', 'roomList', 'index.js'))
  const createFn = require(path.join(process.cwd(), 'cloudfunctions', 'createReservation', 'index.js'))
  const cancelFn = require(path.join(process.cwd(), 'cloudfunctions', 'cancelReservation', 'index.js'))

  store['room-p'] = {
    _id: 'room-p', type: 'room', status: 'active', code: 'p', name: 'P 室', sort: 1,
    metadata: {
      seats: [
        { seat_id: 'P-1', row: 1, col: 1, features: [] },
        { seat_id: 'P-2', row: 1, col: 2, features: [] },
        { seat_id: 'P-3', row: 1, col: 3, features: [], status: 'maintain' },
      ],
    },
  }
  store['res-paused'] = {
    _id: 'res-paused', user_id: OTHER_HASH, record_type: 'reservation', status: 'paused',
    room_id: 'room-p', seat_id: 'P-1', start_at: iso(-1800e3), end_at: iso(3600e3),
    created_at: iso(-3600e3), updated_at: iso(-600e3),
  }

  WX_OPENID = 'owner-001'
  let res = await roomListFn.main({ startAt: iso(0), endAt: iso(3600e3) })
  const seats = res.data && res.data[0] && res.data[0].seats
  const p1 = seats && seats.find((s) => s.seat_id === 'P-1')
  const p3 = seats && seats.find((s) => s.seat_id === 'P-3')
  expect('roomList: 暂离座位 → reserved（不再显示空闲）', res.success && !!p1 && p1.status === 'reserved', JSON.stringify(res.data && res.data[0]))
  expect('roomList: 维护座位仍为 maintain', !!p3 && p3.status === 'maintain', JSON.stringify(p3))
  expect('roomList: freeCount 不含暂离座位', res.data[0].freeCount === 1, String(res.data[0].freeCount))

  res = await createFn.main({ room_id: 'room-p', seat_id: 'P-1', start_at: iso(0), end_at: iso(1800e3) })
  expect('createReservation: 抢暂离中座位 → SEAT_CONFLICT', !res.success && res.data && res.data.code === 'SEAT_CONFLICT', JSON.stringify(res))

  WX_OPENID = 'other-001'
  res = await cancelFn.main({ record_id: 'res-paused' })
  // 新语义：暂离/使用中提前结束 = completed（已结束），不再记 cancelled
  expect('cancelReservation: 暂离中提前结束 → completed（座位仍释放）', res.success && store['res-paused'].status === 'completed', JSON.stringify(res))
  WX_OPENID = 'owner-001'
}

// ============ 超时释放口径一致性：显示 free ⇔ 能约上 ============
// 历史 bug（2026-09-16）：roomList 用 isStale 过滤「已超时的 pending_checkin」→ 座位图显示绿色空闲；
// 而 createReservation 的冲突检查不做同样过滤 → 用户点「立即预约」才弹「该时段座位已被预约」。
// 座位图看着全空、却怎么也约不上。两者必须同口径：显示为占用 = 写入时拦截。
async function testStaleOccupancyParity() {
  console.log('\n== 超时释放口径一致（显示 free ⇔ 可预约） ==')
  const roomListFn = require(path.join(process.cwd(), 'cloudfunctions', 'roomList', 'index.js'))
  const createFn = require(path.join(process.cwd(), 'cloudfunctions', 'createReservation', 'index.js'))

  const ago = (min) => new Date(Date.now() - min * 60 * 1000).toISOString()
  const mk = (id, seatId, status, startAt, endAt, updatedAt) => {
    store[id] = {
      _id: id, record_type: 'reservation', user_id: OTHER_HASH, status,
      room_id: 'room-s', seat_id: seatId,
      start_at: startAt, end_at: endAt,
      created_at: startAt, updated_at: updatedAt || startAt,
    }
  }

  store['room-s'] = {
    _id: 'room-s', type: 'room', status: 'active', code: 's', name: 'S 室', sort: 1,
    metadata: {
      seats: [{ seat_id: 'S-1' }, { seat_id: 'S-2' }, { seat_id: 'S-3' }, { seat_id: 'S-4' }],
    },
  }
  // S-1 待签到但开始已过 30 分钟（> 15 分钟宽限）→ 应视为已释放
  mk('rec-s1', 'S-1', 'pending_checkin', ago(30), iso(1800e3), ago(30))
  // S-2 待签到且未超时 → 仍占用
  mk('rec-s2', 'S-2', 'pending_checkin', iso(600e3), iso(7200e3))
  // S-3 使用中（人真在座，永不超时）→ 仍占用
  mk('rec-s3', 'S-3', 'active', ago(60), iso(1800e3), ago(60))
  // S-4 暂离但 40 分钟未回（> 30 分钟）→ 应视为已释放
  mk('rec-s4', 'S-4', 'paused', ago(120), iso(1800e3), ago(40))

  WX_OPENID = 'parity-a'
  let res = await roomListFn.main({ startAt: iso(600e3), endAt: iso(3600e3) })
  const seats = (res.success && res.data[0] && res.data[0].seats) || []
  const st = (id) => (seats.find((s) => s.seat_id === id) || {}).status
  expect('显示：超时待签到 S-1 → free（座位已释放）', st('S-1') === 'free', JSON.stringify(seats))
  expect('显示：未超时待签到 S-2 → reserved', st('S-2') === 'reserved', JSON.stringify(seats))
  expect('显示：使用中 S-3 → reserved（永不超时）', st('S-3') === 'reserved', JSON.stringify(seats))
  expect('显示：暂离超 30 分钟 S-4 → free', st('S-4') === 'free', JSON.stringify(seats))

  const win = { room_id: 'room-s', start_at: iso(600e3), end_at: iso(3600e3) }
  let r = await createFn.main({ ...win, seat_id: 'S-1' })
  expect('写入：S-1 显示 free → 必须能约上（不再「看着空却报已被预约」）', r.success === true, JSON.stringify(r))

  r = await createFn.main({ ...win, seat_id: 'S-2' })
  expect('写入：S-2 显示 reserved → 拦截 SEAT_CONFLICT',
    !r.success && r.data && r.data.code === 'SEAT_CONFLICT', JSON.stringify(r))

  r = await createFn.main({ ...win, seat_id: 'S-3' })
  expect('写入：S-3 使用中 → 拦截 SEAT_CONFLICT',
    !r.success && r.data && r.data.code === 'SEAT_CONFLICT', JSON.stringify(r))

  // 换一个全新用户，避免与上面 S-1 已成功的预约构成「同用户同时段」干扰
  WX_OPENID = 'parity-b'
  r = await createFn.main({ ...win, seat_id: 'S-4' })
  expect('写入：S-4 暂离超时显示 free → 必须能约上', r.success === true, JSON.stringify(r))

  WX_OPENID = 'owner-001'
}

// ============ cancelReservation：未开始=已取消 / 已使用=已完成 ============
async function testCancelSemantics() {
  console.log('\n== cancelReservation: 状态语义 ==')
  const cancelFn = require(path.join(process.cwd(), 'cloudfunctions', 'cancelReservation', 'index.js'))

  // 未开始（待签到、未使用）取消 → cancelled
  store['res-pending'] = {
    _id: 'res-pending', user_id: OWNER_HASH, record_type: 'reservation', status: 'pending_checkin',
    room_id: 'room-p', seat_id: 'P-2', start_at: iso(1800e3), end_at: iso(3600e3),
    created_at: iso(0), updated_at: iso(0),
  }
  WX_OPENID = 'owner-001'
  let res = await cancelFn.main({ record_id: 'res-pending' })
  expect('待签到取消 → cancelled（已取消）', res.success && store['res-pending'].status === 'cancelled', JSON.stringify(res))

  // 使用中（已签到）提前结束 → completed
  store['res-active'] = {
    _id: 'res-active', user_id: OWNER_HASH, record_type: 'reservation', status: 'active',
    room_id: 'room-p', seat_id: 'P-2', start_at: iso(-3600e3), end_at: iso(3600e3),
    created_at: iso(-3600e3), updated_at: iso(-3600e3),
  }
  res = await cancelFn.main({ record_id: 'res-active' })
  expect('使用中提前结束 → completed（已完成）', res.success && store['res-active'].status === 'completed', JSON.stringify(res))

  // 已结束的记录不可再次操作
  res = await cancelFn.main({ record_id: 'res-active' })
  expect('已结束后不可重复取消', res.success === false, JSON.stringify(res))
}

// ============ adminOps：商家后台（看板 / 预约 / 用户 / 房间座位） ============
async function testAdminOps() {
  console.log('\n== adminOps: 商家后台接口 ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'adminOps', 'index.js'))

  delete process.env.ADMIN_OPENID_HASHES
  WX_OPENID = 'owner-001'
  let res = await fn.main({ action: 'overview' })
  expect('未授权 → ADMIN_NOT_CONFIGURED', !res.success && res.code === 'ADMIN_NOT_CONFIGURED', JSON.stringify(res))

  store[OWNER_HASH] = { _id: OWNER_HASH, role: 'admin', nick_name: '管理员', created_at: iso(-1000) }

  // 鉴权先于 action 分发，因此要在管理员态下验证未知 action
  res = await fn.main({ action: 'no-such-action' })
  expect('未知 action → UNKNOWN_ACTION', !res.success && res.code === 'UNKNOWN_ACTION', JSON.stringify(res))

  // —— 经营看板 ——
  store['room-a'] = {
    _id: 'room-a', type: 'room', status: 'active', code: 'lib', name: '图书馆', created_at: iso(-2000),
    metadata: {
      building: 'A', floor: '1F',
      seats: [
        { seat_id: 'A-1', row: 1, col: 1, status: 'free' },
        { seat_id: 'A-2', row: 1, col: 2, status: 'free' },
        { seat_id: 'A-3', row: 1, col: 3, status: 'maintain' },
      ],
    },
  }
  store['res-now'] = {
    _id: 'res-now', record_type: 'reservation', status: 'active', room_id: 'room-a', seat_id: 'A-1',
    user_id: OWNER_HASH, start_at: iso(-600e3), end_at: iso(3600e3), created_at: iso(-900e3), payload: {},
  }
  res = await fn.main({ action: 'overview' })
  const rt = res.data && res.data.realtime
  expect('overview: 总座位 3 / 占用 1 / 维护 1', res.success && rt.total_seats === 3 && rt.used_seats === 1 && rt.maintain_seats === 1, JSON.stringify(rt))
  expect('overview: 可用 = 3-1-1 = 1', res.success && rt.available_seats === 1, JSON.stringify(rt))
  expect('overview: 房间维度占用统计', res.data.rooms[0].used === 1 && res.data.rooms[0].available === 1, JSON.stringify(res.data.rooms))
  expect('overview: 近 7 日趋势有 7 个点', (res.data.trend || []).length === 7, JSON.stringify(res.data.trend))

  // —— 预约列表 ——
  res = await fn.main({ action: 'listReservations', status: 'all' })
  const row = (res.data.list || []).find((r) => r._id === 'res-now')
  expect('listReservations: 带房间名与用户昵称', res.success && row && row.room_name === '图书馆' && row.user_name === '管理员', JSON.stringify(res.data.list))

  // —— 强制取消（释放座位）——
  res = await fn.main({ action: 'reservationAction', record_id: 'res-now', op: 'cancel' })
  expect('reservationAction: 强制取消 → cancelled', res.success && store['res-now'].status === 'cancelled', JSON.stringify(res))

  // —— 标记违约 + 记违规 ——
  store['res-now'].status = 'active'
  store['users-u9'] = { _id: 'users-u9', nick_name: '小明', no_show_count: 0, created_at: iso(-3000) }
  store['res-now'].user_id = 'users-u9'
  res = await fn.main({ action: 'reservationAction', record_id: 'res-now', op: 'no_show' })
  expect('reservationAction: 标记违约 → no_show', res.success && store['res-now'].status === 'no_show', JSON.stringify(res))
  expect('标记违约 → 违规次数 +1 且禁约 30 分钟', (() => {
    const u = store['users-u9']
    const ms = Date.parse(u.banned_until || '') - Date.now()
    return u.no_show_count === 1 && ms > 28 * 60 * 1000 && ms <= 30 * 60 * 1000
  })(), JSON.stringify(store['users-u9']))

  // —— 用户信用：解除禁约 ——
  res = await fn.main({ action: 'userAction', user_id: 'users-u9', op: 'clear_penalty' })
  expect('userAction: 解除禁约并清零违规', res.success && store['users-u9'].no_show_count === 0 && !store['users-u9'].banned_until, JSON.stringify(res))

  // —— 房间管理 ——
  res = await fn.main({ action: 'upsertRoom', name: '咖啡角', code: 'coffee', building: 'C', floor: '2F' })
  const newRoomId = res.data && res.data.room_id
  expect('upsertRoom: 新建自习室', res.success && !!newRoomId && store[newRoomId].metadata.seats.length === 0, JSON.stringify(res))

  res = await fn.main({ action: 'setRoomStatus', room_id: newRoomId, status: 'disabled' })
  expect('setRoomStatus: 停用自习室', res.success && store[newRoomId].status === 'disabled', JSON.stringify(res))

  // —— 座位管理 ——
  res = await fn.main({ action: 'addSeats', room_id: newRoomId, prefix: 'C', count: 3 })
  expect('addSeats: 新增 3 个座位且编号连号', res.success && store[newRoomId].metadata.seats.length === 3 && store[newRoomId].metadata.seats[2].seat_id === 'C-3', JSON.stringify(res.data))

  res = await fn.main({ action: 'batchSeatStatus', room_id: newRoomId, seat_ids: ['C-1', 'C-2'], status: 'maintain' })
  expect('batchSeatStatus: 批量设维护', res.success && res.data.changed === 2, JSON.stringify(res.data))

  // —— 座位属性编辑（updateSeat）——
  res = await fn.main({ action: 'updateSeat', room_id: newRoomId, seat_id: 'C-1', features: ['window'] })
  expect('updateSeat: 保存属性 → features=[window]', res.success && store[newRoomId].metadata.seats.find((s) => s.seat_id === 'C-1').features.join(',') === 'window', JSON.stringify(res.data))
  res = await fn.main({ action: 'updateSeat', room_id: newRoomId, seat_id: 'C-2', features: ['window', 'outlet'] })
  expect('updateSeat: 追加多属性', res.success && store[newRoomId].metadata.seats.find((s) => s.seat_id === 'C-2').features.sort().join(',') === 'power,window', JSON.stringify(res.data))
  res = await fn.main({ action: 'updateSeat', room_id: newRoomId, seat_id: 'C-3', status: 'free' })
  expect('updateSeat: 只改状态 → features 保留为空', res.success && store[newRoomId].metadata.seats.find((s) => s.seat_id === 'C-3').status === 'free', JSON.stringify(res.data))

  // —— 续排：新座位不从第 1 行第 1 列重新排 ——
  res = await fn.main({ action: 'addSeats', room_id: newRoomId, prefix: 'C', count: 3 })
  const addedSeats = store[newRoomId].metadata.seats
  expect('addSeats 续排: 编号 C-4~C-6 连号', res.success && addedSeats[3].seat_id === 'C-4' && addedSeats[5].seat_id === 'C-6', JSON.stringify(res.data))
  expect('addSeats 续排: 新座位排在旧格子之后（row/col 不回退）', res.success && addedSeats[3].row >= addedSeats[2].row && addedSeats[5].col >= 1, JSON.stringify(res.data))
  // 换行铺开：房间已有 1 行 3 列（targetCols=3）→ 新增 3 个应排成第 2 行 col1/2/3，而不是全堆到第 2 行 col4/5/6
  const C4 = addedSeats[3], C5 = addedSeats[4], C6 = addedSeats[5]
  expect('addSeats 续排: 换行铺开成 2 行 3 列（C-4 row2 col1）', C4.row === 2 && C4.col === 1, JSON.stringify(C4))
  expect('addSeats 续排: 换行铺开成 2 行 3 列（C-5 row2 col2）', C5.row === 2 && C5.col === 2, JSON.stringify(C5))
  expect('addSeats 续排: 换行铺开成 2 行 3 列（C-6 row2 col3）', C6.row === 2 && C6.col === 3, JSON.stringify(C6))

  // —— 编号连续性：新增优先补空号（不留空号）——
  // 人为制造「历史遗留空号」：把 C-3 从库里拿掉（模拟以前删除留下的缺口）
  store[newRoomId].metadata.seats = store[newRoomId].metadata.seats.filter((s) => s.seat_id !== 'C-3')
  res = await fn.main({ action: 'addSeats', room_id: newRoomId, prefix: 'C', count: 1 })
  expect('addSeats 补空号: 缺 C-3 → 新增补回 C-3（而不是顺延到 C-7）', res.success && res.data.added.join(',') === 'C-3', JSON.stringify(res.data))
  expect('addSeats 补空号: 总数回到 6 且编号连续 1~6', (() => {
    const nos = store[newRoomId].metadata.seats.map((s) => Number(String(s.seat_id).replace('C-', ''))).sort((a, b) => a - b)
    return nos.join(',') === '1,2,3,4,5,6'
  })(), store[newRoomId].metadata.seats.map((s) => s.seat_id).join(','))

  // —— 删除座位（removeSeats）：删后编号自动前移，不留空号 ——
  // 当前 C-1~C-6（C-1/C-2 维护态、其余空闲，均无预约）
  res = await fn.main({ action: 'removeSeats', room_id: newRoomId, seat_ids: ['C-2', 'C-5'] })
  let seatsAfterRemove = store[newRoomId].metadata.seats
  const seatIdList = (arr) => arr.map((s) => s.seat_id).sort().join(',')
  expect('removeSeats: 删除空闲座位', res.success && res.data.removed === 2, JSON.stringify(res.data))
  expect('removeSeats: 删后编号前移成 C-1~C-4（不留空号）', seatIdList(seatsAfterRemove) === 'C-1,C-2,C-3,C-4', seatIdList(seatsAfterRemove))
  expect('removeSeats: 返回改号映射 C-3→C-2 / C-4→C-3 / C-6→C-4', (() => {
    const map = (res.data.renumbered || []).map((m) => `${m.from}>${m.to}`).join(',')
    return map === 'C-3>C-2,C-4>C-3,C-6>C-4'
  })(), JSON.stringify(res.data.renumbered))

  // 占用中的座位：其后的座位被删除时编号前移，该座位的进行中预约必须同步改号
  store['res-lock2'] = {
    _id: 'res-lock2', record_type: 'reservation', status: 'active', room_id: newRoomId, seat_id: 'C-4',
    user_id: 'users-u9', start_at: iso(-600e3), end_at: iso(3600e3), created_at: iso(-900e3), payload: {},
  }
  res = await fn.main({ action: 'removeSeats', room_id: newRoomId, seat_ids: ['C-2'] })
  seatsAfterRemove = store[newRoomId].metadata.seats
  expect('removeSeats: 前移后编号仍连续 C-1~C-3', seatIdList(seatsAfterRemove) === 'C-1,C-2,C-3', seatIdList(seatsAfterRemove))
  expect('removeSeats: 占用座位改号 → 预约记录同步 C-4→C-3', res.success && res.data.removed === 1 && store['res-lock2'].seat_id === 'C-3', JSON.stringify({ data: res.data, lock2: store['res-lock2'].seat_id }))

  // 占用中的座位本身不允许删除（blocked），且一个都没删时不重排编号
  res = await fn.main({ action: 'removeSeats', room_id: newRoomId, seat_ids: ['C-3'] })
  expect('removeSeats: 占用座位跳过不删', res.success && res.data.removed === 0 && res.data.blocked === 1 && store[newRoomId].metadata.seats.length === 3, JSON.stringify(res.data))

  // 有进行中预约的座位被拦截
  store['res-lock'] = {
    _id: 'res-lock', record_type: 'reservation', status: 'active', room_id: newRoomId, seat_id: 'C-3',
    user_id: 'users-u9', start_at: iso(-600e3), end_at: iso(3600e3), created_at: iso(-900e3), payload: {},
  }
  res = await fn.main({ action: 'batchSeatStatus', room_id: newRoomId, seat_ids: ['C-3'], status: 'maintain' })
  expect('batchSeatStatus: 占用座位被拦截', res.success && res.data.changed === 0 && res.data.blocked === 1, JSON.stringify(res.data))

  // —— 编号重排（renumberSeats）：补掉历史遗留空号 ——
  // 直接写入一组「跳号」座位：C-1 / C-5 / C-9
  store[newRoomId].metadata.seats = [
    { seat_id: 'C-1', row: 1, col: 1, features: [], status: 'free' },
    { seat_id: 'C-5', row: 2, col: 1, features: ['window'], status: 'free' },
    { seat_id: 'C-9', row: 2, col: 2, features: [], status: 'maintain' },
  ]
  res = await fn.main({ action: 'renumberSeats', room_id: newRoomId })
  const renumberedSeats = store[newRoomId].metadata.seats
  expect('renumberSeats: 跳号压缩为连续 C-1~C-3', res.success && renumberedSeats.map((s) => s.seat_id).join(',') === 'C-1,C-2,C-3', JSON.stringify({ data: res.data, seats: renumberedSeats.map((s) => s.seat_id) }))
  expect('renumberSeats: 物理坐标 / 属性 / 维护态都不变', renumberedSeats[1].row === 2 && renumberedSeats[1].features.join(',') === 'window' && renumberedSeats[2].status === 'maintain', JSON.stringify(renumberedSeats))
  expect('renumberSeats: 返回改号映射 C-5→C-2 / C-9→C-3', (res.data.renumbered || []).map((m) => `${m.from}>${m.to}`).join(',') === 'C-5>C-2,C-9>C-3', JSON.stringify(res.data.renumbered))
  // 幂等：编号已连续时不再改号（避免无意义写入）
  res = await fn.main({ action: 'renumberSeats', room_id: newRoomId })
  expect('renumberSeats: 已连续时幂等无改动', res.success && (res.data.renumbered || []).length === 0 && store[newRoomId].metadata.seats.map((s) => s.seat_id).join(',') === 'C-1,C-2,C-3', JSON.stringify(res.data))

  // —— 编号格式统一：旧格式（C-001 带前导零）与新缺号一并规范为「前缀 + 自然数」——
  store[newRoomId].metadata.seats = [
    { seat_id: 'C-001', row: 1, col: 1, features: [], status: 'free' },
    { seat_id: 'C-002', row: 1, col: 2, features: [], status: 'free' },
    { seat_id: 'C-004', row: 1, col: 3, features: [], status: 'free' },
  ]
  res = await fn.main({ action: 'renumberSeats', room_id: newRoomId })
  expect(
    'renumberSeats: 旧格式 C-001 与缺号一并规范为 C-1~C-3',
    res.success && store[newRoomId].metadata.seats.map((s) => s.seat_id).join(',') === 'C-1,C-2,C-3',
    JSON.stringify({ data: res.data, seats: store[newRoomId].metadata.seats.map((s) => s.seat_id) }),
  )

  // —— 新增座位编号不带前导零（与存储/显示口径一致）——
  store[newRoomId].metadata.seats = [
    { seat_id: 'C-1', row: 1, col: 1, features: [], status: 'free' },
    { seat_id: 'C-2', row: 1, col: 2, features: [], status: 'free' },
  ]
  res = await fn.main({ action: 'addSeats', room_id: newRoomId, prefix: 'C', count: 2 })
  expect(
    'addSeats: 新编号为 C-3/C-4（前缀+自然数，不补零）',
    res.success && store[newRoomId].metadata.seats.map((s) => s.seat_id).join(',') === 'C-1,C-2,C-3,C-4',
    JSON.stringify({ data: res.data, seats: store[newRoomId].metadata.seats.map((s) => s.seat_id) }),
  )

  // —— 非管理员拦截 ——
  process.env.ADMIN_OPENID_HASHES = OWNER_HASH
  WX_OPENID = 'attacker-001'
  res = await fn.main({ action: 'overview' })
  expect('非管理员 → FORBIDDEN', !res.success && res.code === 'FORBIDDEN', JSON.stringify(res))

  delete process.env.ADMIN_OPENID_HASHES
  WX_OPENID = 'owner-001'
}

// ============ adminOps：到店签到码查询 / 设置 ============
async function testAdminOpsCheckinCodes() {
  console.log('\n== adminOps: 到店签到码 ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'adminOps', 'index.js'))
  const checkin = require(path.join(process.cwd(), 'cloudfunctions', 'checkin', 'index.js'))
  delete process.env.ADMIN_OPENID_HASHES
  WX_OPENID = 'owner-001'
  store[OWNER_HASH] = { _id: OWNER_HASH, role: 'admin', nick_name: '管理员', created_at: iso(-1000) }

  store['ci-room-1'] = {
    _id: 'ci-room-1', type: 'room', status: 'active', name: '一楼自习区', code: 'a',
    metadata: { seats: [] }, created_at: iso(-3000),
  }
  store['ci-room-2'] = {
    _id: 'ci-room-2', type: 'room', status: 'active', name: '二楼自习区', code: 'b',
    metadata: { seats: [], checkin_code: '8899' }, created_at: iso(-3000),
  }

  let res = await fn.main({ action: 'checkinCodes' })
  const rows = (res.data && res.data.rooms) || []
  const r1 = rows.find((r) => r.room_id === 'ci-room-1')
  const r2 = rows.find((r) => r.room_id === 'ci-room-2')
  const date = res.data && res.data.date
  expect('checkinCodes: 返回全部房间 + 日期', res.success && rows.length === 2 && /^\d{4}-\d{2}-\d{2}$/.test(date || ''), JSON.stringify(res.data))
  expect('动态码与 checkin 云函数同算法', r1 && r1.code === checkin.__test.dailyRoomCode('ci-room-1', date) && r1.custom === false, JSON.stringify(r1))
  expect('固定码房间返回自定义码', r2 && r2.code === '8899' && r2.custom === true, JSON.stringify(r2))
  expect('require_code 默认 true', res.data.require_code === true, JSON.stringify(res.data))

  // 设固定码
  res = await fn.main({ action: 'setCheckinCode', room_id: 'ci-room-1', code: '6688' })
  expect('setCheckinCode: 写入 metadata.checkin_code', res.success && store['ci-room-1'].metadata.checkin_code === '6688', JSON.stringify(res))

  res = await fn.main({ action: 'checkinCodes' })
  const r1b = res.data.rooms.find((r) => r.room_id === 'ci-room-1')
  expect('查询返回新固定码', r1b.code === '6688' && r1b.custom === true, JSON.stringify(r1b))

  // 用户用固定码能签到
  store['ci-rec'] = {
    _id: 'ci-rec', user_id: OWNER_HASH, record_type: 'reservation', status: 'pending_checkin',
    room_id: 'ci-room-1', seat_id: 'A-1', payload: {},
    start_at: iso(-600e3), end_at: iso(3600e3), created_at: iso(-900e3), updated_at: iso(-900e3),
  }
  const prevRequire = process.env.CHECKIN_REQUIRE_CODE
  delete process.env.CHECKIN_REQUIRE_CODE
  const ck = await checkin.main({ record_id: 'ci-rec', checkin_code: '6688' })
  expect('前端拿管理页的固定码能签到', ck.success && store['ci-rec'].status === 'active', JSON.stringify(ck))

  // 非法码格式拒绝
  res = await fn.main({ action: 'setCheckinCode', room_id: 'ci-room-1', code: '1' })
  expect('setCheckinCode: 长度不足拒绝', !res.success && /4-8 位/.test(res.message), JSON.stringify(res))

  res = await fn.main({ action: 'setCheckinCode', room_id: 'ci-room-1', code: '12ab#$' })
  expect('setCheckinCode: 非法字符拒绝', !res.success && /4-8 位/.test(res.message), JSON.stringify(res))

  res = await fn.main({ action: 'setCheckinCode', room_id: 'no-such-room', code: '6688' })
  expect('setCheckinCode: 房间不存在', !res.success && res.code === 'NOT_FOUND', JSON.stringify(res))

  res = await fn.main({ action: 'setCheckinCode', code: '6688' })
  expect('setCheckinCode: 缺 room_id', !res.success && res.code === 'INVALID_PAYLOAD', JSON.stringify(res))

  // 清空 → 恢复每日自动
  res = await fn.main({ action: 'setCheckinCode', room_id: 'ci-room-1', code: '' })
  expect('setCheckinCode: 清空恢复动态码', res.success && store['ci-room-1'].metadata.checkin_code === '', JSON.stringify(res))
  res = await fn.main({ action: 'checkinCodes' })
  const r1c = res.data.rooms.find((r) => r.room_id === 'ci-room-1')
  expect('清空后查询回到动态码', r1c.custom === false && r1c.code === checkin.__test.dailyRoomCode('ci-room-1', date), JSON.stringify(r1c))

  if (prevRequire === undefined) delete process.env.CHECKIN_REQUIRE_CODE
  else process.env.CHECKIN_REQUIRE_CODE = prevRequire
}

// ============ adminSeatMaintain：一键设置/解除维护 ============
async function testAdminSeatMaintain() {
  console.log('\n== adminSeatMaintain: 设置/解除维护 ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'adminSeatMaintain', 'index.js'))
  store['room-m'] = {
    _id: 'room-m', type: 'room', status: 'active', code: 'm', name: 'M 室',
    metadata: {
      building: 'X 楼',
      seats: [
        { seat_id: 'M-1', row: 1, col: 1, features: [] },
        { seat_id: 'M-2', row: 1, col: 2, features: [] },
        { seat_id: 'M-3', row: 1, col: 3, features: [], status: 'maintain' },
      ],
    },
  }
  const seatOf = (id) => store['room-m'].metadata.seats.find((s) => s.seat_id === id)

  // —— 鉴权 ——
  delete process.env.ADMIN_OPENID_HASHES
  WX_OPENID = 'owner-001'
  let res = await fn.main({ room_id: 'room-m', seat_id: 'M-1', status: 'maintain' })
  expect('未配置白名单 → ADMIN_NOT_CONFIGURED', !res.success && res.code === 'ADMIN_NOT_CONFIGURED', JSON.stringify(res))

  process.env.ADMIN_OPENID_HASHES = OWNER_HASH
  WX_OPENID = 'attacker-001'
  res = await fn.main({ room_id: 'room-m', seat_id: 'M-1', status: 'maintain' })
  expect('白名单外 → FORBIDDEN', !res.success && res.code === 'FORBIDDEN', JSON.stringify(res))

  // —— 入参 / 目标校验 ——
  WX_OPENID = 'owner-001'
  res = await fn.main({ room_id: 'room-m', seat_id: 'M-1', status: 'bad-status' })
  expect('非法 status → INVALID_PAYLOAD', !res.success && res.code === 'INVALID_PAYLOAD', JSON.stringify(res))

  res = await fn.main({ room_id: 'room-none', seat_id: 'M-1', status: 'maintain' })
  expect('房间不存在 → ROOM_NOT_FOUND', !res.success && res.code === 'ROOM_NOT_FOUND', JSON.stringify(res))

  res = await fn.main({ room_id: 'room-m', seat_id: 'M-9', status: 'maintain' })
  expect('座位不存在 → SEAT_NOT_FOUND', !res.success && res.code === 'SEAT_NOT_FOUND', JSON.stringify(res))

  // —— 设维护 / 解除 ——
  res = await fn.main({ room_id: 'room-m', seat_id: 'M-1', status: 'maintain' })
  expect('空闲座位设为维护成功', res.success && seatOf('M-1').status === 'maintain', JSON.stringify(res))
  expect('返回 maintainCount=2', res.success && res.data.maintainCount === 2, JSON.stringify(res.data))
  expect('回写保留其它座位字段', !!seatOf('M-1').row && !!seatOf('M-1').col)

  res = await fn.main({ room_id: 'room-m', seat_id: 'M-3', status: 'free' })
  expect('维护座位释放为空闲', res.success && seatOf('M-3').status === 'free', JSON.stringify(res))

  // —— 占用护栏：暂离中也算占用 ——
  store['res-m2'] = {
    _id: 'res-m2', user_id: OTHER_HASH, record_type: 'reservation', status: 'paused',
    room_id: 'room-m', seat_id: 'M-2', start_at: iso(-1800e3), end_at: iso(3600e3),
    created_at: iso(-3600e3), updated_at: iso(-600e3),
  }
  res = await fn.main({ room_id: 'room-m', seat_id: 'M-2', status: 'maintain' })
  expect('占用中（含暂离）座位 → SEAT_OCCUPIED', !res.success && res.code === 'SEAT_OCCUPIED', JSON.stringify(res))
  expect('被拒时未改动座位状态', seatOf('M-2').status === undefined, JSON.stringify(seatOf('M-2')))

  // —— 已结束的预约不构成阻挡 ——
  store['res-m2'].end_at = iso(-3600e3)
  res = await fn.main({ room_id: 'room-m', seat_id: 'M-2', status: 'maintain' })
  expect('预约已结束 → 可设为维护', res.success, JSON.stringify(res))

  // —— 回退鉴权：环境变量未配，但 users 集合中该账号 role=admin ——
  delete process.env.ADMIN_OPENID_HASHES
  WX_OPENID = 'owner-001'
  store[OWNER_HASH] = { _id: OWNER_HASH, open_id_hash: OWNER_HASH, role: 'admin' }
  res = await fn.main({ room_id: 'room-m', seat_id: 'M-1', status: 'free' })
  expect('环境变量缺失 + users.role=admin → 放行', res.success, JSON.stringify(res))

  store[OWNER_HASH].role = 'student'
  res = await fn.main({ room_id: 'room-m', seat_id: 'M-1', status: 'maintain' })
  expect(
    '环境变量缺失 + users.role=student → ADMIN_NOT_CONFIGURED',
    !res.success && res.code === 'ADMIN_NOT_CONFIGURED',
    JSON.stringify(res),
  )
  delete store[OWNER_HASH]

  delete process.env.ADMIN_OPENID_HASHES
  WX_OPENID = 'owner-001'
}

// ============ 开放时段自动截断：能约多久就算多久 ============
/**
 * 旧行为：结束时间越过打烊 → 直接拒绝「预约时间须在 08:00-22:00 开放时段内」，
 * 于是 20:33 想约 2 小时（到 22:33）的用户被整段挡在门外。
 * 新行为：把结束时间**夹到打烊时间**（22:00），让他照样约上 1 小时 27 分。
 */
async function testOpenWindowClamp() {
  console.log('\n== createReservation: 开放时段自动截断 ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'createReservation', 'index.js'))
  const pad = (n) => String(n).padStart(2, '0')
  const bjDay = (offset) => {
    const bj = new Date(Date.now() + 8 * 3600e3 + offset * 86400e3)
    return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())}`
  }
  const bjIso = (day, time) => new Date(`${day}T${time}:00+08:00`).toISOString()
  const D = bjDay(1) // 明天：保证落在未来，不会触发超时释放口径
  store['room-oh'] = {
    _id: 'room-oh',
    type: 'room',
    name: '限时自习室',
    metadata: { open_time: '08:00', close_time: '22:00' },
  }

  // ① 结束超出打烊 → 截断到 22:00（这是本次核心改动）
  WX_OPENID = 'clamp-1'
  let res = await fn.main({
    room_id: 'room-oh', seat_id: 'C-1',
    start_at: bjIso(D, '20:33'), end_at: bjIso(D, '22:33'),
  })
  expect('结束超打烊 → 预约成功（不再拒绝）', res.success === true, JSON.stringify(res))
  expect('结束时间被截断到 22:00', !!res.data && res.data.end_at === bjIso(D, '22:00'), String(res.data && res.data.end_at))
  expect('开始时间保持不变', !!res.data && res.data.start_at === bjIso(D, '20:33'), String(res.data && res.data.start_at))

  // ② 跨天时长（21:00 → 次日 01:00）→ 同样截断到当日 22:00
  WX_OPENID = 'clamp-2'
  res = await fn.main({
    room_id: 'room-oh', seat_id: 'C-2',
    start_at: bjIso(D, '21:00'), end_at: bjIso(bjDay(2), '01:00'),
  })
  expect('跨天时长截断到当日打烊', res.success === true && !!res.data && res.data.end_at === bjIso(D, '22:00'), JSON.stringify(res))

  // ③ 开始早于开放时间 → 前推到 08:00
  WX_OPENID = 'clamp-3'
  res = await fn.main({
    room_id: 'room-oh', seat_id: 'C-3',
    start_at: bjIso(D, '07:00'), end_at: bjIso(D, '09:00'),
  })
  expect('开始早于开门 → 前推到 08:00', res.success === true && !!res.data && res.data.start_at === bjIso(D, '08:00') && res.data.end_at === bjIso(D, '09:00'), JSON.stringify(res))

  // ④ 开始已过打烊 → 真的约不了，明确提示改天
  WX_OPENID = 'clamp-4'
  res = await fn.main({
    room_id: 'room-oh', seat_id: 'C-4',
    start_at: bjIso(D, '22:30'), end_at: bjIso(D, '23:30'),
  })
  expect('开始晚于打烊 → 拒绝并提示改天', res.success === false && /已超出本自习室开放时段/.test(res.message), JSON.stringify(res))

  // ⑤ 截断后不足最短时长 → 不放号（避免一个只有 10 分钟的空号）
  WX_OPENID = 'clamp-5'
  res = await fn.main({
    room_id: 'room-oh', seat_id: 'C-5',
    start_at: bjIso(D, '21:50'), end_at: bjIso(D, '22:30'),
  })
  expect('截断后不足最短时长 → 拒绝', res.success === false && /不足 15 分钟/.test(res.message), JSON.stringify(res))

  // ⑥ 未配置开放时段的房间：不做任何截断（回归保护）
  store['room-free'] = { _id: 'room-free', type: 'room', name: '全天自习室', metadata: {} }
  WX_OPENID = 'clamp-6'
  res = await fn.main({
    room_id: 'room-free', seat_id: 'C-6',
    start_at: bjIso(D, '23:00'), end_at: bjIso(D, '23:40'),
  })
  expect('未配置开放时段 → 原样放行', res.success === true && !!res.data && res.data.end_at === bjIso(D, '23:40'), JSON.stringify(res))

  WX_OPENID = 'owner-001'
}

// ============ login 惰性结算超时预约 ============
/**
 * expireRecords 依赖云函数定时触发器，触发器没部署/失效时「我的」页的违约次数
 * 会一直不涨 —— 用户看到的就是「明明超时了却没记违约」。
 * login 里加了一次惰性结算，这条用例守着它的正确性与**幂等性**。
 */
async function testLoginSettle() {
  console.log('\n== login: 惰性结算超时预约（不依赖定时触发器） ==')
  const fn = require(path.join(process.cwd(), 'cloudfunctions', 'login', 'index.js'))
  WX_OPENID = 'owner-001'
  store[OWNER_HASH] = {
    _id: OWNER_HASH,
    open_id_hash: OWNER_HASH,
    nick_name: '测试用户',
    role: 'student',
    no_show_count: 0,
    created_at: iso(-86400e3),
    updated_at: iso(-86400e3),
  }
  store['v-over'] = {
    _id: 'v-over', user_id: OWNER_HASH, record_type: 'reservation', status: 'pending_checkin',
    start_at: iso(-20 * 60e3), end_at: iso(60 * 60e3), payload: {},
    created_at: iso(-86400e3), updated_at: iso(-20 * 60e3),
  }
  store['v-future'] = {
    _id: 'v-future', user_id: OWNER_HASH, record_type: 'reservation', status: 'pending_checkin',
    start_at: iso(30 * 60e3), end_at: iso(120 * 60e3), payload: {},
    created_at: iso(0), updated_at: iso(0),
  }
  store['v-leave'] = {
    _id: 'v-leave', user_id: OWNER_HASH, record_type: 'reservation', status: 'paused',
    start_at: iso(-60 * 60e3), end_at: iso(60 * 60e3), payload: {},
    created_at: iso(-86400e3), updated_at: iso(-31 * 60e3),
  }
  store['v-other'] = {
    _id: 'v-other', user_id: OTHER_HASH, record_type: 'reservation', status: 'pending_checkin',
    start_at: iso(-20 * 60e3), end_at: iso(60 * 60e3), payload: {},
    created_at: iso(-86400e3), updated_at: iso(-20 * 60e3),
  }

  let res = await fn.main({})
  expect('登录成功', res.success === true, JSON.stringify(res))
  expect('待签到超时 → no_show 且标记 pending_timeout',
    store['v-over'].status === 'no_show' && store['v-over'].payload.violation_type === 'pending_timeout',
    JSON.stringify(store['v-over']))
  expect('暂离超时 → no_show 且标记 leave_timeout',
    store['v-leave'].status === 'no_show' && store['v-leave'].payload.violation_type === 'leave_timeout',
    JSON.stringify(store['v-leave']))
  expect('未超时的预约不被误判', store['v-future'].status === 'pending_checkin')
  expect('别人的记录不被波及', store['v-other'].status === 'pending_checkin')
  expect('违约次数累加到 2', !!res.data && res.data.noShowCount === 2, JSON.stringify(res.data))
  expect('按梯度下发禁约（第 2 次 = 2 小时）',
    !!res.data && !!res.data.bannedUntil && (new Date(res.data.bannedUntil).getTime() - Date.now()) > 110 * 60e3,
    String(res.data && res.data.bannedUntil))

  // 幂等：再登录一次不能把同一批记录重复计数
  res = await fn.main({})
  expect('重复登录不重复计数（幂等）', !!res.data && res.data.noShowCount === 2, JSON.stringify(res.data))
}

// ============ 违约规则口径一致性（前端常量 vs 四个云函数） ============
/**
 * 「三处口径必须同值」是本项目最容易踩的坑：任一处漏改就会出现
 * 「座位图显示空闲 → 点预约却报已被预约」这类自相矛盾。
 * 这里直接读源码断言数字相等，比靠人记靠谱。
 */
async function testViolationRuleParity() {
  console.log('\n== 违约规则口径一致性（前端常量 vs 云端） ==')
  const fs = require('fs')
  const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
  const pick = (src, re) => {
    const m = re.exec(src)
    return m ? Number(m[1]) : NaN
  }

  const feConst = read('miniprogram/config/constants.ts')
  const exp = read('cloudfunctions/expireRecords/index.js')
  const cr = read('cloudfunctions/createReservation/index.js')
  const ur = read('cloudfunctions/updateReservation/index.js')
  const lg = read('cloudfunctions/login/index.js')
  const mr = read('miniprogram/subpages/myReservations/myReservations.ts')

  const feGrace = pick(feConst, /CHECKIN_TIMEOUT_MINUTES\s*=\s*(\d+)/)
  const feLeave = pick(feConst, /LEAVE_TIMEOUT_MINUTES\s*=\s*(\d+)/)
  const feMin = pick(feConst, /MIN_BOOKING_MINUTES\s*=\s*(\d+)/)

  expect('待签到宽限：前端 == expireRecords == createReservation == login',
    feGrace === pick(exp, /PENDING_GRACE_MINUTES\s*=\s*(\d+)/) &&
    feGrace === pick(cr, /PENDING_GRACE_MINUTES\s*=\s*(\d+)/) &&
    feGrace === pick(lg, /PENDING_GRACE_MINUTES\s*=\s*(\d+)/),
    `前端=${feGrace} exp=${pick(exp, /PENDING_GRACE_MINUTES\s*=\s*(\d+)/)} cr=${pick(cr, /PENDING_GRACE_MINUTES\s*=\s*(\d+)/)} login=${pick(lg, /PENDING_GRACE_MINUTES\s*=\s*(\d+)/)}`)

  expect('暂离时限：前端 == expireRecords == createReservation == login',
    feLeave === pick(exp, /LEAVE_TIMEOUT_MINUTES\s*=\s*(\d+)/) &&
    feLeave === pick(cr, /LEAVE_TIMEOUT_MINUTES\s*=\s*(\d+)/) &&
    feLeave === pick(lg, /LEAVE_TIMEOUT_MINUTES\s*=\s*(\d+)/),
    `前端=${feLeave}`)

  expect('最短可约时长：前端 == createReservation == updateReservation',
    feMin === pick(cr, /MIN_BOOKING_MINUTES\s*=\s*(\d+)/) &&
    feMin === pick(ur, /MIN_BOOKING_MINUTES\s*=\s*(\d+)/),
    `前端=${feMin} cr=${pick(cr, /MIN_BOOKING_MINUTES\s*=\s*(\d+)/)} ur=${pick(ur, /MIN_BOOKING_MINUTES\s*=\s*(\d+)/)}`)

  // roomList 的显示口径内联在 isStale 里，单独断言它与常量同值
  const roomList = read('cloudfunctions/roomList/index.js')
  expect('座位图显示口径（roomList.isStale）与常量同值',
    new RegExp(`${feGrace} \\* 60 \\* 1000`).test(roomList) && new RegExp(`${feLeave} \\* 60 \\* 1000`).test(roomList),
    'roomList 未与常量对齐')

  const grad = (src) => {
    const m = /function banMinutesFor\(count\)\s*\{([\s\S]*?)\n\}/.exec(src)
    return m ? m[1].replace(/\s+/g, '') : ''
  }
  expect('禁约梯度：expireRecords == login（第3次起 24 小时）',
    !!grad(exp) && grad(exp) === grad(lg) && /return1440/.test(grad(lg)),
    '两处梯度必须完全一致')

  expect('前端不再硬编码 15/30 分钟宽限（改从 constants 引用）',
    !/GRACE_MS\s*=\s*15\s*\*/.test(mr) && !/LEAVE_LIMIT_MS\s*=\s*30\s*\*/.test(mr),
    'myReservations 里仍有写死的宽限值')
}

// ============ useCredit: 邀请积分抵免违约 ============
async function testUseCredit() {
  console.log('\n== useCredit: 邀请积分抵免违约 ==')
  const useCredit = require(path.join(process.cwd(), 'cloudfunctions', 'useCredit', 'index.js'))
  const U = OWNER_HASH // 用 owner 作为被测试用户

  // 提前写入用户：owner 有 3 积分、2 违约、已用 0 次
  store[U] = {
    _id: U,
    open_id_hash: U,
    nick_name: 'owner',
    invite_credit: 3,
    no_show_count: 2,
    waiver_total_used: 0,
    waiver_log: [],
  }

  let r = await useCredit.main({})
  expect('有积分+有违约 → 抵免成功', r && r.success === true && r.data && r.data.can_waive === true, JSON.stringify(r))
  expect('积分 -=1 (3→2)', r.data && r.data.credit === 2, `credit=${r.data && r.data.credit}`)
  expect('违约 -=1 (2→1)', r.data && r.data.no_show_count === 1, `no_show=${r.data && r.data.no_show_count}`)
  expect('已用次数 +1 (0→1)', r.data && r.data.waived_total === 1, `waived=${r.data && r.data.waived_total}`)
  expect('留痕写入 waiver_log', Array.isArray(store[U].waiver_log) && store[U].waiver_log.length === 1, JSON.stringify(store[U].waiver_log))

  // 重置为「无违约但有积分」的干净状态
  store[U].invite_credit = 5
  store[U].no_show_count = 0
  store[U].waiver_total_used = 0
  r = await useCredit.main({})
  expect('无违约 → can_waive=false 且不扣分', r.success === true && r.data && r.data.can_waive === false && store[U].invite_credit === 5, JSON.stringify(r))

  // 积分不足但违约存在 → 拒绝且不扣分
  store[U].invite_credit = 0
  store[U].no_show_count = 5
  store[U].waiver_total_used = 0
  r = await useCredit.main({})
  expect('积分不足 → 不扣分不改违约', r.success === true && r.data && r.data.can_waive === false && store[U].no_show_count === 5 && store[U].invite_credit === 0, JSON.stringify(r))

  // 达上限（waiver_total_used >= WAIVER_LIMIT）→ 拒绝
  store[U].invite_credit = 5
  store[U].no_show_count = 5
  store[U].waiver_total_used = 10
  r = await useCredit.main({})
  expect('达上限 10 次 → 拒绝且不扣分', r.success === true && r.data && r.data.can_waive === false && r.data.remaining_waives === 0 && store[U].invite_credit === 5, JSON.stringify(r))

  // 并发：条件更新只扣一次（两条并发同跑，只成功一条）
  store[U] = { _id: U, invite_credit: 1, no_show_count: 5, waiver_total_used: 9, waiver_log: [] }
  const [ra, rb] = await Promise.all([useCredit.main({}), useCredit.main({})])
  expect('并发只成功一次', (ra.data && ra.data.can_waive ? 1 : 0) + (rb.data && rb.data.can_waive ? 1 : 0) === 1, `ra=${JSON.stringify(ra)} rb=${JSON.stringify(rb)}`)
  expect('并发后积分归 0', store[U].invite_credit === 0 && store[U].no_show_count === 4, JSON.stringify(store[U]))

  // 未知用户 → ok + can_waive=false
  resetStore()
  WX_OPENID = 'nobody-001'
  r = await useCredit.main({})
  expect('未建档用户 → 不崩且 can_waive=false', r.success === true && r.data && r.data.can_waive === false, JSON.stringify(r))
}

;(async () => {
  await testValidator()
  resetStore()
  await testLeaveSeat()
  resetStore()
  await testExpireRecords()
  resetStore()
  await testExpirePagination()
  resetStore()
  await testComputeActiveSeconds()
  resetStore()
  await testStudyStartDupAndComplete()
  resetStore()
  await testStudySummaryPagination()
  await testStudyRecordEdit()
  await testStudyPomodoro()
  resetStore()
  await testStudyListPagination()
  resetStore()
  await testCreateReservation()
  resetStore()
  await testCreateReservationTransaction()
  resetStore()
  await testAdminStats()
  resetStore()
  await testCheckin()
  resetStore()
  await testCheckinCode()
  await testCheckinGeo()
  resetStore()
  await testUpdateReservation()
  resetStore()
  await testExpireNoShowPenalty()
  resetStore()
  await testCreateReservationBan()
  resetStore()
  await testNotifyTypePath()
  resetStore()
  await testCreateReservationPersistOpenid()
  resetStore()
  await testExpireReminderAndWarn()
  resetStore()
  await testSubmitReview()
  resetStore()
  await testLoginBanFields()
  resetStore()
  await testPausedSeatOccupancy()
  resetStore()
  await testStaleOccupancyParity()
  resetStore()
  await testCancelSemantics()
  resetStore()
  await testAdminSeatMaintain()
  resetStore()
  await testAdminOps()
  resetStore()
  await testAdminOpsCheckinCodes()
  resetStore()
  await testAdminOpsRoomGeo()
  resetStore()
  await testOpenWindowClamp()
  resetStore()
  await testLoginSettle()
  resetStore()
  await testViolationRuleParity()
  resetStore()
  await testUseCredit()
  resetStore()
  await testFeedbackReplyLoop()
  await testFeedbackIdentityAndSla()
  console.log('\n==== cloud-logic: pass=' + pass + ' fail=' + fail + ' ====')
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('test crashed:', e); process.exit(2) })
