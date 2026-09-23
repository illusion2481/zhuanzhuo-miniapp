/**
 * 管理员座位维护 — 一键设置 / 解除某个座位的「维护」状态
 *
 * event: { room_id, seat_id, status: 'maintain' | 'free' }
 * 权限：仅 ADMIN_OPENID_HASHES 中配置的 OPENID 可调用（与 adminStats 同一套白名单）
 *
 * 写入位置：categories 集合中该房间记录的 metadata.seats[].status
 * 注意：roomList 判定座位状态时，`maintain` 优先级最高（先于占用计算），
 *       因此设为维护后座位图会立即显示为灰色且不可预约。
 *
 * 【自包含】本函数不 require './shared/*'：鉴权 / 入参校验均已内联，
 * 只要 index.js 上传成功即可运行（避免共享目录漏传导致 MODULE_NOT_FOUND）。
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
 * 管理员鉴权（两级，任一通过即可）：
 *   1) 环境变量 ADMIN_OPENID_HASHES —— 优先，但微信云开发按「函数」独立配置，新函数不会继承
 *   2) 回退：users 集合中本人记录的 role === 'admin'
 *      login 云函数（已配好白名单）会把管理员的 role 写进 users 集合，因此即使某个
 *      新函数忘了配环境变量，只要该微信账号本身已是管理员也能正常调用。
 *      安全前提：users 集合权限须为「仅管理端可写」（云函数写入的文档没有 _openid，
 *      客户端在任何权限模式下都改不动），客户端代码也从不写 users 集合。
 */
async function assertAdminByOpenId(openId, openIdHash) {
  const adminHashes = listAdminOpenIdHashes();
  const myHash = openIdHash || hashOpenId(openId || '');

  // ① 环境变量白名单
  if (myHash && adminHashes.includes(myHash)) return;

  // ② 回退：读 users 集合中自己的角色
  let isAdminByRole = false;
  if (myHash) {
    try {
      const found = await db.collection('users').doc(myHash).get();
      isAdminByRole = !!(found && found.data && found.data.role === 'admin');
    } catch (e) {
      isAdminByRole = false;
    }
  }
  if (isAdminByRole) return;

  if (!adminHashes.length) {
    const err = new Error(
      '管理员白名单未配置（缺少环境变量 ADMIN_OPENID_HASHES），且该账号在 users 集合中不是 admin',
    );
    err.code = 'ADMIN_NOT_CONFIGURED';
    throw err;
  }
  const err = new Error('无管理员权限');
  err.code = 'FORBIDDEN';
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

/* ══════════════════════ 业务逻辑 ══════════════════════ */

/**
 * 视为「占用」的预约状态 —— 与 roomList / createReservation / updateReservation 保持一致。
 * 暂离中（paused）同样保留座位，因此也属于占用。
 */
const OCCUPYING_STATUSES = ['pending_checkin', 'active', 'paused'];

/** 入参白名单（F7） */
const SCHEMA = {
  room_id: { type: 'string', max: 64 },
  seat_id: { type: 'string', max: 64 },
  status: { type: 'enum', values: ['maintain', 'free'] },
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

exports.main = async (event = {}) => {
  // 1. 鉴权（先鉴权后校验入参，避免未授权方探测校验规则）
  try {
    const { openId, openIdHash } = getAuthContext();
    await assertAdminByOpenId(openId, openIdHash);
  } catch (authErr) {
    const code = (authErr && authErr.code) || 'FORBIDDEN';
    const message = (authErr && authErr.message) || '鉴权失败';
    console.warn('[adminSeatMaintain] forbidden:', code, message);
    return fail(message, null, code);
  }

  // 2. 入参白名单校验（F7）
  const check = validateEvent(event, SCHEMA);
  if (!check.ok) return fail(check.error, null, 'INVALID_PAYLOAD');
  const { room_id, seat_id, status } = check.value;

  // 3. 业务逻辑
  try {
    // 3.1 读取房间
    let room = null;
    try {
      const found = await db.collection('categories').doc(room_id).get();
      room = found.data || null;
    } catch (e) {
      return fail('自习室不存在', null, 'ROOM_NOT_FOUND');
    }
    if (!room || room.type !== 'room') return fail('该分类不是自习室', null, 'ROOM_NOT_FOUND');

    const metadata = room.metadata || {};
    const seats = Array.isArray(metadata.seats) ? metadata.seats : [];
    const index = seats.findIndex((s) => s && s.seat_id === seat_id);
    if (index < 0) return fail('座位不存在', null, 'SEAT_NOT_FOUND');

    // 3.2 占用护栏：设为维护前，若该座位仍存在「未结束」的进行中预约则拒绝，
    //     避免把正在使用 / 已预约（含未来时段）的座位直接维护掉。
    if (status === 'maintain') {
      const now = new Date().toISOString();
      const busy = await db
        .collection('records')
        .where({
          room_id,
          seat_id,
          record_type: 'reservation',
          status: _.in(OCCUPYING_STATUSES),
          end_at: _.gt(now),
        })
        .limit(1)
        .get();
      if (busy.data && busy.data.length) {
        const r = busy.data[0];
        return fail(
          '该座位仍有进行中的预约，无法设为维护',
          {
            code: 'SEAT_OCCUPIED',
            conflict: {
              _id: r._id,
              status: r.status,
              start_at: r.start_at,
              end_at: r.end_at,
            },
          },
          'SEAT_OCCUPIED',
        );
      }
    }

    // 3.3 写入（整数组回写，避免嵌套数组按下标定位带来的歧义）
    const nextSeats = seats.map((s, i) =>
      i === index ? Object.assign({}, s, { status }) : s,
    );
    const updated_at = new Date().toISOString();
    try {
      await db.collection('categories').doc(room_id).update({
        data: { 'metadata.seats': nextSeats, updated_at },
      });
    } catch (pathErr) {
      // 兼容不支持点路径更新的环境：整段 metadata 回写
      await db.collection('categories').doc(room_id).update({
        data: {
          metadata: Object.assign({}, metadata, { seats: nextSeats }),
          updated_at,
        },
      });
    }

    return ok(
      {
        room_id,
        seat_id,
        status,
        updated_at,
        seats: nextSeats,
        maintainCount: nextSeats.filter((s) => s && s.status === 'maintain').length,
      },
      status === 'maintain' ? '已设为维护' : '已解除维护',
    );
  } catch (err) {
    console.error('[adminSeatMaintain]', err);
    return fail((err && err.message) || '操作失败', null, 'INTERNAL');
  }
};
