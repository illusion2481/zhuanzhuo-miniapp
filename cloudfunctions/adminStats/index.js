/**
 * 管理统计 — 依据 records 集合作状态聚合
 * event.start_at / event.end_at 可选，过滤 records.created_at 区间
 *
 * 权限：仅 ADMIN_OPENID_HASHES 配置的 OPENID 可调用
 *
 * 【自包含】本函数不 require './shared/*'：鉴权 / 入参校验 / 分页拉取均已内联。
 * 背景：云端曾报 `Cannot find module './shared/auth'`（部署包里缺 shared 目录），
 *       内联后只要 index.js 上传成功即可运行，不再受共享目录是否随包上传影响。
 * 若要修改内联实现，请同步核对 cloudfunctions/shared/{auth,validator,db}.js。
 */
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/* ══════════════ 内联：鉴权（同步自 shared/auth.js） ══════════════ */

function hashOpenId(openId) {
  if (!openId) return '';
  return crypto.createHash('sha256').update(String(openId)).digest('hex').slice(0, 32);
}

function getAuthContext() {
  const wxContext = cloud.getWXContext();
  const openId = (wxContext && wxContext.OPENID) || '';
  return {
    openId,
    openIdHash: hashOpenId(openId),
    appId: (wxContext && wxContext.APPID) || '',
    unionId: wxContext && wxContext.UNIONID,
  };
}

function listAdminOpenIdHashes() {
  return String(process.env.ADMIN_OPENID_HASHES || '')
    .split(',')
    .map((s) => String(s || '').trim())
    .filter(Boolean);
}

/**
 * 管理员鉴权：环境变量白名单 **或** users.role === 'admin'（两条通道任一通过即可）。
 *
 * ⚠️ 2026-09-17 修复：本函数原先**只认环境变量** ADMIN_OPENID_HASHES，
 * 而 adminOps / adminSeatMaintain 都支持「users.role === 'admin'」这条回退通道。
 * 后果：靠 role 提权的管理员（login 仅在配置了环境变量时才写 role，其余情况保留库中
 * 人工提权的值）在管理页能看预约、能改座位，却一进「统计」就报 ADMIN_NOT_CONFIGURED ——
 * 同一个后台两套权限判定，自相矛盾。现与另两个云函数对齐。
 */
async function assertAdminByOpenId(openId, openIdHash) {
  const adminHashes = listAdminOpenIdHashes();
  const myHash = openIdHash || hashOpenId(openId || '');
  if (myHash && adminHashes.includes(myHash)) return myHash;

  if (myHash) {
    try {
      const found = await db.collection('users').doc(myHash).get();
      if (found && found.data && found.data.role === 'admin') return myHash;
    } catch (e) {
      /* 用户文档不存在 / 查询失败 → 继续走下面的报错，不影响白名单通道 */
    }
  }

  const err = new Error(
    adminHashes.length
      ? '无管理员权限'
      : '管理员白名单未配置（缺少环境变量 ADMIN_OPENID_HASHES），且该账号在 users 集合中不是 admin',
  );
  err.code = adminHashes.length ? 'FORBIDDEN' : 'ADMIN_NOT_CONFIGURED';
  throw err;
}

/* ══════════ 内联：入参白名单校验（同步自 shared/validator.js） ══════════ */

/** 是否为可解析的 ISO 时间字符串 */
function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  const t = Date.parse(value);
  return !Number.isNaN(t);
}

/** 数字：有限数字原样通过；纯数字字符串强转 */
function coerceNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function checkField(name, raw, rule) {
  const type = rule.type;

  if (type === 'string' || type === 'enum') {
    if (typeof raw !== 'string') return { ok: false, error: `字段 ${name} 必须为字符串` };
    let s = raw.trim();
    if (rule.max && s.length > rule.max) s = s.slice(0, rule.max);
    if (!rule.optional && s === '') return { ok: false, error: `缺少必填字段：${name}` };
    if (rule.isoDate && s !== '' && !isIsoDate(s)) {
      return { ok: false, error: `字段 ${name} 不是有效时间` };
    }
    if (rule.values && s !== '' && !rule.values.includes(s)) {
      return { ok: false, error: `字段 ${name} 取值无效：${s}` };
    }
    return { ok: true, value: s };
  }

  if (type === 'number') {
    const n = coerceNumber(raw);
    if (n === null) return { ok: false, error: `字段 ${name} 必须为数字` };
    let v = n;
    if (rule.min !== undefined && v < rule.min) v = rule.min;
    if (rule.max !== undefined && v > rule.max) v = rule.max;
    return { ok: true, value: v };
  }

  if (type === 'boolean') {
    if (typeof raw !== 'boolean') return { ok: false, error: `字段 ${name} 必须为布尔值` };
    return { ok: true, value: raw };
  }

  if (type === 'array<string>') {
    if (!Array.isArray(raw)) return { ok: false, error: `字段 ${name} 必须为字符串数组` };
    const items = [];
    for (const it of raw.slice(0, rule.maxItems || raw.length)) {
      if (typeof it !== 'string') continue;
      let s = it.trim();
      if (!s) continue;
      if (rule.itemMax && s.length > rule.itemMax) s = s.slice(0, rule.itemMax);
      items.push(s);
    }
    return { ok: true, value: items };
  }

  return { ok: false, error: `字段 ${name} 的类型规则未知：${type}` };
}

/** 校验 event 入参（白名单：schema 未声明的字段一律剥离） */
function validateEvent(event, schema) {
  const source = event && typeof event === 'object' ? event : {};
  const value = {};
  for (const [name, rule] of Object.entries(schema)) {
    let raw = source[name];
    if (raw === undefined && rule.default !== undefined) raw = rule.default;
    if (raw === undefined) {
      if (!rule.optional) return { ok: false, error: `缺少必填字段：${name}` };
      continue;
    }
    const checked = checkField(name, raw, rule);
    if (!checked.ok) return { ok: false, error: checked.error };
    value[name] = checked.value;
  }
  return { ok: true, value };
}

/* ═══════════ 内联：分页拉全量（同步自 shared/db.js） ═══════════ */

/**
 * 基于 _id 游标循环分页，避免单次 limit 截断导致统计漏数。
 * @param {string} collectionName 集合名
 * @param {object} where 查询条件（可使用 db.command 表达式）
 * @param {{pageSize?: number, maxPages?: number}} options
 */
async function fetchAllPaged(collectionName, where, options = {}) {
  const pageSize = Math.min(Math.max(options.pageSize || 100, 1), 1000);
  const maxPages = options.maxPages || 100;
  const out = [];
  let cursor = null;
  for (let i = 0; i < maxPages; i++) {
    const cond = cursor ? _.and(where, { _id: _.gt(cursor) }) : where;
    const res = await db
      .collection(collectionName)
      .where(cond)
      .orderBy('_id', 'asc')
      .limit(pageSize)
      .get();
    const rows = (res && res.data) || [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    cursor = rows[rows.length - 1]._id;
  }
  return out;
}

/* ══════════════════════ 业务逻辑 ══════════════════════ */

const RESERVATION_PAGE = 1000;
const RESERVATION_MAX_PAGES = 50;

const SCHEMA = {
  start_at: { type: 'string', isoDate: true, optional: true },
  end_at: { type: 'string', isoDate: true, optional: true },
  startAt: { type: 'string', isoDate: true, optional: true },
  endAt: { type: 'string', isoDate: true, optional: true },
};

function ok(data, message = '操作成功') {
  return {
    success: true,
    data,
    message,
    request_id: 'req_' + Date.now(),
  };
}

function fail(message, data = null, code) {
  return {
    success: false,
    data,
    code: code || 'ERROR',
    message,
    request_id: 'req_' + Date.now(),
  };
}

/** 百分比，保留 1 位小数；分母为 0 时返回 0 */
function pct(num, den) {
  if (!den) return 0;
  return Math.round((num / den) * 1000) / 10;
}

/** 分页拉取某段时间内的预约记录（F5：游标循环，避免 limit 截断漏统计） */
async function loadReservations(startAt, endAt) {
  const conds = [{ record_type: 'reservation' }];
  if (startAt || endAt) {
    conds.push({
      created_at: _.and(
        _.gte(startAt || '1970-01-01T00:00:00.000Z'),
        _.lte(endAt || '2999-01-01T00:00:00.000Z'),
      ),
    });
  }
  const baseWhere = conds.length > 1 ? _.and(conds) : conds[0];
  try {
    return await fetchAllPaged('records', baseWhere, {
      pageSize: RESERVATION_PAGE,
      maxPages: RESERVATION_MAX_PAGES,
    });
  } catch (e) {
    // 兼容无索引环境：退化为全量拉取 + 内存过滤
    const all = await fetchAllPaged('records', { record_type: 'reservation' }, {
      pageSize: RESERVATION_PAGE,
      maxPages: RESERVATION_MAX_PAGES,
    });
    return all.filter((r) => {
      if (startAt && (!r.created_at || r.created_at < startAt)) return false;
      if (endAt && (!r.created_at || r.created_at > endAt)) return false;
      return true;
    });
  }
}

exports.main = async (event = {}) => {
  // 1. 鉴权（先鉴权后校验入参，避免未授权方探测校验规则）
  try {
    const { openId, openIdHash } = getAuthContext();
    await assertAdminByOpenId(openId, openIdHash);
  } catch (authErr) {
    const code = (authErr && authErr.code) || 'FORBIDDEN';
    const message = (authErr && authErr.message) || '鉴权失败';
    console.warn('[adminStats] forbidden:', code, message);
    return fail(message, null, code);
  }

  // 2. 入参白名单校验（F7）
  const check = validateEvent(event, SCHEMA);
  if (!check.ok) return fail(check.error, null, 'INVALID_PAYLOAD');

  // 3. 业务逻辑
  try {
    const v = check.value;
    const startAt = v.start_at || v.startAt;
    const endAt = v.end_at || v.endAt;
    const list = await loadReservations(startAt, endAt);

    const total = list.length;
    const byStatus = {
      pending_checkin: 0,
      active: 0,
      paused: 0,
      completed: 0,
      cancelled: 0,
      no_show: 0,
    };
    for (const r of list) {
      const s = r.status || 'pending_checkin';
      if (byStatus[s] === undefined) byStatus[s] = 0;
      byStatus[s] += 1;
    }

    // 签到口径：存在 payload.checked_in_at（实签）才计入，避免把到期自动 completed 计入实签
    let checkedIn = 0;
    for (const r of list) {
      const p = r.payload || {};
      if (p.checked_in_at) checkedIn += 1;
    }
    const finished = byStatus.completed + byStatus.no_show + byStatus.cancelled;
    const completedCount = byStatus.completed;
    const noShowCount = byStatus.no_show;
    const cancelledCount = byStatus.cancelled;

    // 当前占用：pending_checkin + active + paused（暂离保留座位）处于有效时间窗内
    const now = new Date().toISOString();
    let currentOccupied = 0;
    for (const r of list) {
      if (r.status !== 'pending_checkin' && r.status !== 'active' && r.status !== 'paused') continue;
      const s = r.start_at;
      const e = r.end_at;
      if (s && e && s <= now && now <= e) currentOccupied += 1;
    }

    // 总座位数（来自 categories type=room 的 metadata.seats）
    let totalSeats = 0;
    try {
      const rooms = await db
        .collection('categories')
        .where({ type: 'room', status: 'active' })
        .limit(100)
        .get();
      totalSeats = (rooms.data || []).reduce((acc, c) => {
        const seats = (c.metadata && c.metadata.seats) || [];
        return acc + seats.length;
      }, 0);
    } catch (e) {
      // 忽略：无法统计总座位时 occupancyRate 基于预约数
    }

    // 诊断：定位「统计为 0」到底是 records 集合为空，还是写库字段口径不符
    const diag = { recordsTotal: null, reservationCount: null, error: '' };
    try {
      const counted = await db.collection('records').count();
      diag.recordsTotal = counted.total;
    } catch (e) {
      diag.error = (e && e.message) || 'records 集合不可读';
    }
    try {
      const counted = await db
        .collection('records')
        .where({ record_type: 'reservation' })
        .count();
      diag.reservationCount = counted.total;
    } catch (e) {
      diag.error = diag.error || (e && e.message) || '预约记录计数失败';
    }

    return ok(
      {
        total,
        byStatus,
        checkedIn,
        finished,
        totalSeats,
        occupiedNow: currentOccupied,
        diag,
        rates: {
          noShowRate: pct(noShowCount, finished + checkedIn),
          checkInRate: pct(checkedIn, total),
          completionRate: pct(completedCount, finished || checkedIn),
          occupancyRate: pct(currentOccupied, totalSeats || currentOccupied || 1),
        },
        generatedAt: new Date().toISOString(),
        hints: [
          '数据来自 records 集合（可选按 created_at 区间过滤）',
          '占用率 = 当前在窗内的预约 / 全量座位数',
          'diag.recordsTotal 为 0 ⇒ 尚未产生任何记录；recordsTotal > 0 但 reservationCount 为 0 ⇒ 写库字段口径不符，需重新部署 createReservation',
        ],
      },
      '管理统计生成成功',
    );
  } catch (err) {
    console.error('[adminStats]', err);
    return fail((err && err.message) || '统计生成失败', null, 'INTERNAL');
  }
};
