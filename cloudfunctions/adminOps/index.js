/**
 * 管理端运营接口（商家后台）—— 一个函数承载全部管理动作，通过 action 分发。
 *
 * 支持的 action：
 *   overview            经营看板：实时占用 / 今日与近 7 日预约 / 高峰时段
 *   listReservations    预约订单列表（可按状态、房间、日期筛选）
 *   reservationAction   对单条预约做 cancel / no_show / checkin / complete
 *   releaseSeat         管理员强制释放座位（取消占用该座位的全部进行中预约，不计违约）
 *   listUsers           用户列表（含违规次数与禁约状态）
 *   userAction          用户信用：clear_penalty / ban / unban
 *   upsertRoom          新增或编辑自习室
 *   setRoomStatus       启用 / 停用自习室
 *   addSeats            批量新增座位（新座位从现有网格后续排，不重排靠窗）
 *   updateSeat          编辑单个座位属性（靠窗/插座）与状态（维护/空闲）
 *   removeSeats         删除座位（有进行中预约的座位会跳过）
 *   batchSeatStatus     批量设维护 / 解除维护
 *   checkinCodes        查询各房间当前生效的到店签到码
 *   setCheckinCode      设置 / 清除某房间的固定签到码
 *
 * 【自包含】不 require './shared/*'：鉴权与入参校验全部内联，
 * 单文件上传即可运行，避免共享目录漏传导致 MODULE_NOT_FOUND。
 *
 * 鉴权两级（任一通过）：
 *   1) 环境变量 ADMIN_OPENID_HASHES
 *   2) users 集合中本人记录的 role === 'admin'
 */
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const OCCUPYING = ['pending_checkin', 'active', 'paused'];
const ROOM_STATUS = ['active', 'disabled'];
const SEAT_STATUS = ['free', 'maintain'];

/* ══════════════ 内联：鉴权 ══════════════ */

function hashOpenId(openId) {
  if (!openId) return '';
  return crypto.createHash('sha256').update(String(openId)).digest('hex').slice(0, 32);
}

function listAdminOpenIdHashes() {
  return String(process.env.ADMIN_OPENID_HASHES || '')
    .split(',')
    .map((s) => String(s || '').trim())
    .filter(Boolean);
}

async function assertAdmin() {
  const wxContext = cloud.getWXContext();
  const openId = (wxContext && wxContext.OPENID) || '';
  const myHash = hashOpenId(openId);

  if (myHash && listAdminOpenIdHashes().includes(myHash)) return myHash;

  let isAdminByRole = false;
  if (myHash) {
    try {
      const found = await db.collection('users').doc(myHash).get();
      isAdminByRole = !!(found && found.data && found.data.role === 'admin');
    } catch (e) {
      isAdminByRole = false;
    }
  }
  if (isAdminByRole) return myHash;

  const err = new Error(
    listAdminOpenIdHashes().length
      ? '无管理员权限'
      : '管理员白名单未配置（缺少环境变量 ADMIN_OPENID_HASHES），且该账号在 users 集合中不是 admin',
  );
  err.code = listAdminOpenIdHashes().length ? 'FORBIDDEN' : 'ADMIN_NOT_CONFIGURED';
  throw err;
}

/* ══════════════ 内联：基础工具 ══════════════ */

function ok(data, message = '操作成功') {
  return { success: true, data, message, request_id: 'req_' + Date.now() };
}

function fail(message, data = null, code = 'ERROR') {
  return { success: false, data, code, message, request_id: 'req_' + Date.now() };
}

/** 分页拉全量（云函数单次最多 100 条） */
async function fetchAll(collection, where, maxPages = 20) {
  const out = [];
  let skip = 0;
  for (let i = 0; i < maxPages; i++) {
    const page = await db
      .collection(collection)
      .where(where)
      .orderBy('created_at', 'desc')
      .skip(skip)
      .limit(100)
      .get()
      .catch(() => null);
    const rows = (page && page.data) || [];
    out.push(...rows);
    if (rows.length < 100) break;
    skip += rows.length;
  }
  return out;
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function dayKey(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hourKey(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return -1;
  return new Date(t).getHours();
}

/** 读取全部房间并附带上座位数组，返回 Map<room_id, room> */
async function loadRooms() {
  const rooms = await fetchAll('categories', { type: 'room' });
  const map = new Map();
  rooms.forEach((r) => map.set(r._id, r));
  return map;
}

/* ══════════════ 内联：占用口径（与 roomList / expireRecords / createReservation 同值） ══════════════ */

/** 待签到宽限（分钟）：超过则视为爽约、座位释放 */
const PENDING_GRACE_MINUTES = 15;
/** 暂离保留时长（分钟）：超过则释放座位并计违约 */
const LEAVE_TIMEOUT_MINUTES = 30;

/** 客服工单 SLA：待处理超过 24 小时算超时，后台标红提醒（成熟工单系统的首响基线） */
const FEEDBACK_SLA_MS = 24 * 60 * 60 * 1000;

/** 该记录是否已因超时而被视为「不再占座」（与 roomList.isStale 逐字对齐，见其注释） */
function releasedByTimeout(item, nowMs) {
  if (!item) return false;
  if (item.status === 'pending_checkin') {
    const t = Date.parse(item.start_at || '');
    return Number.isFinite(t) && nowMs - t > PENDING_GRACE_MINUTES * 60 * 1000;
  }
  if (item.status === 'paused') {
    const t = Date.parse(item.updated_at || item.created_at || '');
    return Number.isFinite(t) && nowMs - t > LEAVE_TIMEOUT_MINUTES * 60 * 1000;
  }
  return false;
}

/* ══════════════ 内联：到店签到码（与 checkin 云函数同算法） ══════════════ */

/** 北京时间 YYYY-MM-DD */
function beijingDateKey(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 派生「某房间 + 某天」的 4 位签到码。
 * 与 checkin 云函数必须保持一致：两侧均固化同一内置盐值、
 * 不读 CHECKIN_CODE_SECRET —— 环境变量在两个函数上配置不一致时，
 * 管理页展示的码会和学生输入的码对不上（线上真实事故），故彻底移除该变量。
 */
function dailyRoomCode(roomId, dateKey) {
  const secret = 'zz-focusseat-checkin-v1';
  const h = crypto.createHmac('sha256', secret).update(`${roomId}|${dateKey}`).digest('hex');
  return String(parseInt(h.slice(0, 8), 16) % 10000).padStart(4, '0');
}

/** 是否强制校验到店签到码（默认强制） */
function requireCheckinCode() {
  return String(process.env.CHECKIN_REQUIRE_CODE || '1') !== '0';
}

/* ══════════════ action: 经营看板 ══════════════ */

async function actionOverview() {
  const now = new Date();
  const nowIso = now.toISOString();
  const dayStart = startOfDay(now).toISOString();
  const dayEnd = new Date(startOfDay(now).getTime() + 24 * 3600 * 1000).toISOString();
  const weekStart = new Date(startOfDay(now).getTime() - 6 * 24 * 3600 * 1000).toISOString();

  const [rooms, occupying, todayRows, weekRows, feedbackRows] = await Promise.all([
    fetchAll('categories', { type: 'room' }),
    fetchAll('records', {
      record_type: 'reservation',
      status: _.in(OCCUPYING),
      start_at: _.lt(nowIso),
      end_at: _.gt(nowIso),
    }),
    fetchAll('records', { record_type: 'reservation', created_at: _.and(_.gte(dayStart), _.lt(dayEnd)) }),
    fetchAll('records', { record_type: 'reservation', created_at: _.gte(weekStart) }),
    // 客服工单概览：管理员不用切到「反馈」Tab 也能看到有没有待处理
    fetchAll('records', { record_type: 'feedback' }),
  ]);

  const feedbackStat = { pending: 0, replied: 0, handled: 0, total: 0, overdue: 0 };
  const fbRows = Array.isArray(feedbackRows) ? feedbackRows : [];
  fbRows.forEach((r) => {
    const s = r && r.status ? r.status : 'pending';
    if (feedbackStat[s] !== undefined) feedbackStat[s] += 1;
    if (s === 'pending') {
      // 追问会把工单打回 pending，计时从最后一次追问起算才准确
      const fus = Array.isArray(r.followups) ? r.followups : [];
      const from = fus.length ? fus[fus.length - 1].created_at : r.created_at;
      const waited = now.getTime() - new Date(from || r.created_at || nowIso).getTime();
      if (waited > FEEDBACK_SLA_MS) feedbackStat.overdue += 1;
    }
  });
  feedbackStat.total = fbRows.length;

  // 实时占用（按房间）：与座位图同口径，剔除已超时的「待签到 / 暂离」，
  // 否则看板把 15 分钟前已爽约、已可被他人预约的座位仍算占用，与 roomList 显示矛盾。
  const nowMs = Date.now();
  const live = occupying.filter((r) => !releasedByTimeout(r, nowMs));
  const usedByRoom = new Map();
  live.forEach((r) => {
    usedByRoom.set(r.room_id, (usedByRoom.get(r.room_id) || 0) + 1);
  });
  const roomsView = rooms.map((r) => {
    const meta = r.metadata || {};
    const seats = Array.isArray(meta.seats) ? meta.seats : [];
    const maintain = seats.filter((s) => s && s.status === 'maintain').length;
    const total = seats.length;
    const used = usedByRoom.get(r._id) || 0;
    const available = Math.max(total - maintain - used, 0);
    return {
      room_id: r._id,
      name: r.name || '',
      code: r.code || '',
      status: r.status || 'active',
      building: meta.building || '',
      floor: meta.floor || '',
      total,
      maintain,
      used,
      available,
      usage_rate: total > 0 ? Math.round((used / total) * 100) : 0,
    };
  });

  const totalSeats = roomsView.reduce((s, r) => s + r.total, 0);
  const usedSeats = roomsView.reduce((s, r) => s + r.used, 0);
  const maintainSeats = roomsView.reduce((s, r) => s + r.maintain, 0);

  // 今日订单状态分布
  const statusCount = {};
  todayRows.forEach((r) => {
    statusCount[r.status] = (statusCount[r.status] || 0) + 1;
  });

  // 近 7 天趋势
  const trendMap = new Map();
  for (let i = 6; i >= 0; i--) {
    trendMap.set(dayKey(new Date(startOfDay(now).getTime() - i * 24 * 3600 * 1000).toISOString()), 0);
  }
  weekRows.forEach((r) => {
    const k = dayKey(r.created_at || r.start_at);
    if (trendMap.has(k)) trendMap.set(k, trendMap.get(k) + 1);
  });
  const trend = Array.from(trendMap.entries()).map(([date, count]) => ({ date, count }));

  // 高峰时段（近 7 天按开始小时聚合）
  const hourMap = new Map();
  for (let h = 0; h < 24; h++) hourMap.set(h, 0);
  weekRows.forEach((r) => {
    const h = hourKey(r.start_at);
    if (h >= 0 && hourMap.has(h)) hourMap.set(h, hourMap.get(h) + 1);
  });
  const peakHours = Array.from(hourMap.entries())
    .map(([hour, count]) => ({ hour, count }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return ok({
    realtime: {
      total_seats: totalSeats,
      used_seats: usedSeats,
      maintain_seats: maintainSeats,
      available_seats: Math.max(totalSeats - usedSeats - maintainSeats, 0),
      usage_rate: totalSeats > 0 ? Math.round((usedSeats / totalSeats) * 100) : 0,
      active_rooms: roomsView.filter((r) => r.status === 'active').length,
    },
    today: {
      created: todayRows.length,
      by_status: statusCount,
      no_show: statusCount.no_show || 0,
      cancelled: statusCount.cancelled || 0,
      completed: statusCount.completed || 0,
    },
    trend,
    peak_hours: peakHours,
    rooms: roomsView,
    // 客服工单：供后台 Tab 角标与看板展示（pending 有值就该去处理）
    feedback: feedbackStat,
  });
}

/* ══════════════ action: 预约订单 ══════════════ */

async function actionListReservations(payload) {
  const status = payload.status && payload.status !== 'all' ? String(payload.status) : null;
  const roomId = payload.room_id ? String(payload.room_id) : null;
  const date = payload.date ? String(payload.date) : null; // today | all | YYYY-MM-DD

  const where = { record_type: 'reservation' };
  if (status) where.status = status;
  if (roomId) where.room_id = roomId;

  let rows = await fetchAll('records', where);

  if (date && date !== 'all') {
    const key = date === 'today' ? dayKey(new Date().toISOString()) : date;
    rows = rows.filter((r) => dayKey(r.start_at || r.created_at) === key);
  }

  rows.sort((a, b) => String(b.start_at || '').localeCompare(String(a.start_at || '')));
  const limit = Math.min(Number(payload.limit) || 50, 200);
  const sliced = rows.slice(0, limit);

  // 补上房间名与用户昵称
  const roomMap = await loadRooms();
  const userIds = Array.from(new Set(sliced.map((r) => r.user_id).filter(Boolean)));
  const userMap = new Map();
  for (let i = 0; i < userIds.length; i += 20) {
    const chunk = userIds.slice(i, i + 20);
    const docs = await db
      .collection('users')
      .where({ _id: _.in(chunk) })
      .limit(20)
      .get()
      .catch(() => ({ data: [] }));
    (docs.data || []).forEach((u) => userMap.set(u._id, u));
  }

  const list = sliced.map((r) => {
    const room = roomMap.get(r.room_id);
    const user = userMap.get(r.user_id);
    return {
      _id: r._id,
      status: r.status,
      room_id: r.room_id,
      room_name: room ? room.name || room.code || '' : r.room_id,
      seat_id: r.seat_id,
      user_id: r.user_id || '',
      user_name: user ? user.nick_name || '（未命名）' : '（未知用户）',
      start_at: r.start_at,
      end_at: r.end_at,
      created_at: r.created_at,
      goal: (r.payload && r.payload.goal) || '',
      violation_type: (r.payload && r.payload.violation_type) || '',
    };
  });

  return ok({ list, total: rows.length, returned: list.length }, '预约列表查询成功');
}

async function actionReservationAction(payload) {
  // 注意：外层用 action 做分发，具体动作改用 op，避免同名覆盖
  const recordId = String(payload.record_id || '');
  const op = String(payload.op || '');
  if (!recordId) return fail('缺少 record_id', null, 'INVALID_PAYLOAD');
  if (!['cancel', 'no_show', 'checkin', 'complete'].includes(op)) {
    return fail('无效的 op', null, 'INVALID_PAYLOAD');
  }

  let record = null;
  try {
    const found = await db.collection('records').doc(recordId).get();
    record = found.data || null;
  } catch (e) {
    record = null;
  }
  if (!record) return fail('预约不存在', null, 'NOT_FOUND');

  const now = new Date().toISOString();
  const patch = { updated_at: now };
  let message = '操作成功';

  if (op === 'cancel') {
    if (!OCCUPYING.includes(record.status)) return fail('该预约已结束，无需取消', null, 'BAD_STATUS');
    patch.status = 'cancelled';
    message = '已强制取消，座位已释放';
  } else if (op === 'no_show') {
    if (!OCCUPYING.includes(record.status)) return fail('该预约已结束，无法标记违约', null, 'BAD_STATUS');
    patch.status = 'no_show';
    patch['payload.violation_type'] = 'admin_marked';
    patch['payload.violation_at'] = now;
    patch['payload.violation_note'] = payload.note ? String(payload.note).slice(0, 60) : '管理员标记违约';
    message = '已标记违约，座位已释放';
  } else if (op === 'checkin') {
    if (record.status !== 'pending_checkin') return fail('仅待签到的预约可以标记到店', null, 'BAD_STATUS');
    patch.status = 'active';
    patch['payload.admin_checkin_at'] = now;
    message = '已标记为到店使用';
  } else if (op === 'complete') {
    if (!OCCUPYING.includes(record.status)) return fail('该预约已结束', null, 'BAD_STATUS');
    patch.status = 'completed';
    message = '已结束该预约';
  }

  await db.collection('records').doc(recordId).update({ data: patch });

  // 标记违约时同步计入违规次数（梯度禁约与 expireRecords 一致）
  if (op === 'no_show' && payload.penalty !== false && record.user_id) {
    try {
      const doc = await db.collection('users').doc(record.user_id).get();
      const prev = doc.data || {};
      const nextCount = (typeof prev.no_show_count === 'number' ? prev.no_show_count : 0) + 1;
      const banMs = (nextCount <= 1 ? 30 : nextCount === 2 ? 120 : 1440) * 60 * 1000;
      const newBan = new Date(Date.now() + banMs).toISOString();
      const prevBanMs = prev.banned_until ? Date.parse(prev.banned_until) : 0;
      const bannedUntil = Number.isFinite(prevBanMs) && prevBanMs > Date.now() + banMs ? prev.banned_until : newBan;
      await db.collection('users').doc(record.user_id).update({
        data: { no_show_count: nextCount, banned_until: bannedUntil, updated_at: now },
      });
    } catch (e) {
      /* 用户记录缺失不阻断主流程 */
    }
  }

  return ok({ record_id: recordId, status: patch.status }, message);
}

/**
 * 管理员强制释放座位（最高权限覆盖）。
 * 用户诉求：管理端对座位应有最高处置权——不管座位被谁的预约占着，
 * 管理员都能直接释放（取消占用该座位的全部进行中预约，不计用户违约）。
 */
async function actionReleaseSeat(payload) {
  const roomId = String(payload.room_id || '');
  const seatId = String(payload.seat_id || '');
  if (!roomId || !seatId) return fail('缺少 room_id / seat_id', null, 'INVALID_PAYLOAD');

  const nowIso = new Date().toISOString();
  const busy = await db
    .collection('records')
    .where({
      room_id: roomId,
      seat_id: seatId,
      record_type: 'reservation',
      status: _.in(OCCUPYING),
      end_at: _.gt(nowIso),
    })
    .limit(100)
    .get()
    .catch(() => ({ data: [] }));

  const rows = busy.data || [];
  for (const r of rows) {
    await db
      .collection('records')
      .doc(r._id)
      .update({
        data: {
          status: 'cancelled',
          updated_at: nowIso,
          'payload.admin_released_at': nowIso,
          'payload.violation_type': '',
        },
      })
      .catch(() => null);
  }

  // 座位静态状态一并恢复空闲（若曾被设维护则一并解除，保证释放后立即可约）
  let room = null;
  try {
    const found = await db.collection('categories').doc(roomId).get();
    room = found.data || null;
  } catch (e) {
    room = null;
  }
  if (room) {
    const meta = room.metadata || {};
    const seats = Array.isArray(meta.seats) ? meta.seats : [];
    const idx = seats.findIndex((s) => s && s.seat_id === seatId);
    if (idx >= 0 && seats[idx].status !== 'free') {
      const nextSeats = seats.map((s, i) => (i === idx ? Object.assign({}, s, { status: 'free' }) : s));
      await db
        .collection('categories')
        .doc(roomId)
        .update({ data: { 'metadata.seats': nextSeats, updated_at: nowIso } })
        .catch(() => null);
    }
  }

  return ok(
    { room_id: roomId, seat_id: seatId, released: rows.length },
    rows.length ? `已释放座位（取消 ${rows.length} 条占用预约）` : '该座位本无占用预约',
  );
}

/* ══════════════ action: 用户与信用 ══════════════ */

async function actionListUsers(payload) {
  const keyword = String(payload.keyword || '').trim();
  const limit = Math.min(Number(payload.limit) || 50, 200);
  const where = {};
  if (keyword) where.nick_name = db.RegExp({ regexp: keyword, options: 'i' });

  let rows = await fetchAll('users', where);
  rows.sort((a, b) => (b.no_show_count || 0) - (a.no_show_count || 0));
  const list = rows.slice(0, limit).map((u) => ({
    user_id: u._id,
    nick_name: u.nick_name || '（未命名）',
    role: u.role || 'student',
    no_show_count: u.no_show_count || 0,
    banned_until: u.banned_until || '',
    banned: !!(u.banned_until && Date.parse(u.banned_until) > Date.now()),
    // 2026-09-23：积分（邀请裂变）与手机号（可选绑定）透出给后台展示/甄别用户
    invite_credit: u.invite_credit || 0,
    phone: u.phone || '',
    created_at: u.created_at,
  }));
  return ok({ list, total: rows.length, returned: list.length }, '用户列表查询成功');
}

async function actionUserAction(payload) {
  const userId = String(payload.user_id || '');
  const op = String(payload.op || '');
  if (!userId) return fail('缺少 user_id', null, 'INVALID_PAYLOAD');
  if (!['clear_penalty', 'ban', 'unban'].includes(op)) return fail('无效的 op', null, 'INVALID_PAYLOAD');

  const now = new Date().toISOString();
  if (op === 'clear_penalty') {
    await db.collection('users').doc(userId).update({
      data: { no_show_count: 0, banned_until: '', updated_at: now },
    });
    return ok({ user_id: userId }, '已解除禁约并清零违规次数');
  }
  if (op === 'unban') {
    await db.collection('users').doc(userId).update({ data: { banned_until: '', updated_at: now } });
    return ok({ user_id: userId }, '已解除禁约');
  }
  const hours = Math.min(Math.max(Number(payload.hours) || 24, 1), 720);
  const bannedUntil = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  await db.collection('users').doc(userId).update({ data: { banned_until: bannedUntil, updated_at: now } });
  return ok({ user_id: userId, banned_until: bannedUntil }, `已封禁 ${hours} 小时`);
}

/* ══════════════ action: 意见反馈 ══════════════ */

/**
 * 管理端反馈列表：从 records 集合读取 record_type==='feedback' 的记录。
 * 支持按 status（pending 待处理 / replied 已回复 / handled 已关闭）筛选；不传则全部。
 * 最多返回 200 条。用户追问会把状态打回 pending，管理员因此重新看到它。
 */
async function actionListFeedback(payload) {
  const where = { record_type: 'feedback' };
  const status = String(payload.status || '').trim();
  if (status && ['pending', 'replied', 'handled'].includes(status)) where.status = status;
  const limit = Math.min(Number(payload.limit) || 100, 200);

  let rows = await fetchAll('records', where);
  rows = rows.slice(0, limit);
  const nowMs = Date.now();
  const list = rows.map((r) => {
    const followups = Array.isArray(r.followups) ? r.followups.slice(-10) : [];
    // SLA：待处理的工单等了多久。用户追问过就从「最后一次追问」重新计时，
    // 否则追问后仍显示最初提交时间，会把刚催过的单子误判成超时。
    const lastWaitAt = followups.length
      ? followups[followups.length - 1].created_at || r.created_at
      : r.created_at;
    const waitingMs =
      (r.status || 'pending') === 'pending'
        ? Math.max(0, nowMs - new Date(lastWaitAt || r.created_at || nowMs).getTime())
        : 0;
    return {
      feedback_id: r._id,
      user_id: r.user_id || '',
      // 后台要认出「是谁提的」：昵称 + 短 ID，比 32 位哈希可读得多
      nick_name: r.nick_name || '',
      user_short: String(r.user_id || '').slice(0, 6),
      category: r.category || '其他',
      content: r.content || '',
      images: Array.isArray(r.images) ? r.images : [],
      status: r.status || 'pending',
      // 客服闭环：后台回复内容与回复时间（用户在「我的反馈」可见）
      reply: r.reply || '',
      replied_at: r.replied_at || '',
      // 用户追问记录：多轮往来留痕，后台据此判断问题是否真的解决了
      followups,
      // SLA：等待毫秒数（非 pending 为 0）与是否超过 24 小时未响应
      waiting_ms: waitingMs,
      overdue: waitingMs > FEEDBACK_SLA_MS,
      created_at: r.created_at || '',
      updated_at: r.updated_at || '',
    };
  });
  return ok({ list, total: rows.length, returned: list.length }, '反馈列表查询成功');
}

/** 管理端将某条反馈标记为已处理（status: 'handled'） */
async function actionMarkFeedbackHandled(payload) {
  const id = String(payload.feedback_id || '');
  if (!id) return fail('缺少 feedback_id', null, 'INVALID_PAYLOAD');
  const now = new Date().toISOString();
  await db.collection('records').doc(id).update({ data: { status: 'handled', updated_at: now } });
  return ok({ feedback_id: id, status: 'handled' }, '已标记为处理');
}

/**
 * 管理端回复反馈（客服闭环的核心动作）。
 *
 * 与 markFeedbackHandled 的区别：本动作把回复内容写进 `records.reply`，
 * 用户在「我的反馈」里能直接看到，状态进入 **replied（已回复，等用户确认）** ——
 * 不是直接关闭：用户看完还能追问（打回 pending）或点「已解决」（→ handled）。
 *
 * reply 为空串时退化为「仅标记已处理」（→ handled），管理员无需在两种按钮间选择。
 */
async function actionReplyFeedback(payload) {
  const id = String(payload.feedback_id || '');
  if (!id) return fail('缺少 feedback_id', null, 'INVALID_PAYLOAD');
  const reply = String(payload.reply || '').trim().slice(0, 500);
  const now = new Date().toISOString();
  const hasReply = !!reply;
  const patch = { status: hasReply ? 'replied' : 'handled', updated_at: now };
  if (hasReply) {
    patch.reply = reply;
    patch.replied_at = now;
  }
  try {
    await db.collection('records').doc(id).update({ data: patch });
  } catch (e) {
    return fail(`回复失败：${(e && e.message) || '记录不存在'}`, null, 'UPDATE_FAILED');
  }
  return ok(
    { feedback_id: id, status: patch.status, reply, replied_at: patch.replied_at || '' },
    hasReply ? '回复已发送，等待用户确认' : '已标记为处理',
  );
}

/* ══════════════ action: 房间与座位 ══════════════ */

async function actionUpsertRoom(payload) {
  const roomId = payload.room_id ? String(payload.room_id) : '';
  const name = String(payload.name || '').trim();
  if (!name) return fail('请填写自习室名称', null, 'INVALID_PAYLOAD');

  const now = new Date().toISOString();
  if (roomId) {
    // 编辑：只覆盖传入的字段，保留 seats
    let room = null;
    try {
      const found = await db.collection('categories').doc(roomId).get();
      room = found.data || null;
    } catch (e) {
      room = null;
    }
    if (!room) return fail('自习室不存在', null, 'NOT_FOUND');
    const meta = Object.assign({}, room.metadata || {});
    if (payload.building !== undefined) meta.building = String(payload.building);
    if (payload.floor !== undefined) meta.floor = String(payload.floor);
    if (payload.open_time !== undefined) meta.open_time = String(payload.open_time);
    if (payload.close_time !== undefined) meta.close_time = String(payload.close_time);
    if (!Array.isArray(meta.seats)) meta.seats = [];
    meta.capacity = meta.seats.length;

    const patch = {
      name,
      description: payload.description !== undefined ? String(payload.description) : room.description || '',
      metadata: meta,
      updated_at: now,
    };
    if (payload.code !== undefined) patch.code = String(payload.code);
    await db.collection('categories').doc(roomId).update({ data: patch });
    return ok({ room_id: roomId }, '自习室已更新');
  }

  // 新建
  const code = String(payload.code || '').trim() || name;
  const meta = {
    building: String(payload.building || ''),
    floor: String(payload.floor || ''),
    open_time: String(payload.open_time || '08:00'),
    close_time: String(payload.close_time || '22:00'),
    capacity: 0,
    seats: [],
  };
  const doc = {
    type: 'room',
    status: 'active',
    code,
    name,
    description: String(payload.description || ''),
    metadata: meta,
    created_at: now,
    updated_at: now,
  };
  const added = await db.collection('categories').add({ data: doc });
  return ok({ room_id: added._id }, '自习室已创建');
}

async function actionSetRoomStatus(payload) {
  const roomId = String(payload.room_id || '');
  const status = String(payload.status || '');
  if (!roomId) return fail('缺少 room_id', null, 'INVALID_PAYLOAD');
  if (!ROOM_STATUS.includes(status)) return fail('无效的房间状态', null, 'INVALID_PAYLOAD');
  await db.collection('categories').doc(roomId).update({
    data: { status, updated_at: new Date().toISOString() },
  });
  return ok({ room_id: roomId, status }, status === 'active' ? '自习室已启用' : '自习室已停用');
}

/* ══════════ 座位编号：始终连续、不留空号（2026-09-17） ══════════
 * 用户诉求：「不管是增加还是删除，都不要出现缺的序号」（例：删过 A-012 后，
 * 列表里不许出现 A-011、A-013、A-014 这种跳号）。规则：
 *   1) 新增 → 先补最小的空号，补满后再顺延（删过 A-012 就补回 A-012，而不是跳到 A-015）
 *   2) 删除 → 后面的座位整体前移，压缩成 001..00N
 *   3) 重排 → renumberSeats 一键补掉本次改动之前就已存在的历史空号
 * 改号时同步更新「进行中」预约的 records.seat_id，否则用户端座位图/预约/扫码签到会错位。
 */

/** 解析座位编号：'A-013' → { prefix: 'A-', no: 13 }；编号内无数字则返回 null（原样保留、不参与重排） */
function parseSeatNo(seatId) {
  const m = String(seatId || '').match(/^(.*?)(\d+)\s*$/);
  if (!m) return null;
  return { prefix: String(m[1] || ''), no: Number(m[2]) };
}

/**
 * 座位编号格式：前缀 + 自然数，**不补零**（A-1、A-2 … A-13）。
 *
 * 2026-09-17 统一：以前存成 A-001（三位补零），但用户端座位图一直现场去零显示 A-1，
 * 签到校验（normalizeSeatCode）又把两者当不同座位 —— 三处各写各的。
 * 现在统一成「前缀 + 自然数」，存储 / 显示 / 校验同值。
 */
function formatSeatNo(no) {
  const n = Number(no);
  return Number.isFinite(n) && n > 0 ? String(Math.floor(n)) : '0';
}

/**
 * 编号压缩：每个前缀内按编号升序重排为连续的 001..00N，补掉被删除留下的空号。
 * 例：A-001…A-011、A-013、A-014 → A-001…A-013
 * 只改 seat_id，**不动 row/col**：物理布局保持原样，改的只是「编号」这一身份。
 * @returns {{ seats: any[], moved: Array<{ from: string, to: string }> }}
 */
function compactSeatNumbers(seats) {
  const list = Array.isArray(seats) ? seats.slice() : [];
  const groups = new Map();
  list.forEach((s, idx) => {
    const parsed = parseSeatNo(s && s.seat_id);
    if (!parsed) return;
    if (!groups.has(parsed.prefix)) groups.set(parsed.prefix, []);
    groups.get(parsed.prefix).push({ idx, no: parsed.no });
  });

  const moved = [];
  groups.forEach((items, prefix) => {
    items.sort((a, b) => a.no - b.no);
    items.forEach((it, k) => {
      const want = k + 1;
      // 比较「完整编号」而不是只比数字：这样 A-001（旧格式带前导零）也会被规范成 A-1。
      const wantId = `${prefix}${formatSeatNo(want)}`;
      const from = String(list[it.idx].seat_id);
      if (from === wantId) return; // 已经连续且格式正确，不动（避免无意义写入）
      moved.push({ from, to: wantId });
      list[it.idx] = Object.assign({}, list[it.idx], { seat_id: wantId });
    });
  });
  return { seats: list, moved };
}

/**
 * 座位改号后，把仍「进行中」的预约记录一起改号
 * （否则用户端座位图与预约会错位、扫座位二维码签到会报「与预约座位不一致」）。
 * 历史记录（completed / cancelled / no_show）不改：它记录的是当时的事实。
 */
async function syncReservationSeatIds(roomId, moved) {
  if (!Array.isArray(moved) || !moved.length) return 0;
  const map = new Map(moved.map((m) => [m.from, m.to]));
  const nowIso = new Date().toISOString();
  const live = await db
    .collection('records')
    .where({
      room_id: roomId,
      record_type: 'reservation',
      status: _.in(OCCUPYING),
      end_at: _.gt(nowIso),
    })
    .limit(200)
    .get()
    .catch(() => ({ data: [] }));

  let renamed = 0;
  for (const r of live.data || []) {
    const to = map.get(String(r.seat_id || ''));
    if (!to || !r._id) continue;
    await db
      .collection('records')
      .doc(r._id)
      .update({ data: { seat_id: to, updated_at: new Date().toISOString() } })
      .catch(() => null);
    renamed += 1;
  }
  return renamed;
}

function computeNextPosition(seats, prefix) {
  // 找该前缀下所有已占用的行/列网格，新座位从现有网格后继续排，不从第 1 行第 1 列重排。
  // → 修掉“新加的座位全部贴回靠窗最前排/第一列”的问题。
  // 2026-09-16 再修：按「最多一行的座位数」作为目标列数，新座位**换行铺开**，
  // 而不是全部挤在最大列的右边一排（那样看起来像全部贴在最外侧/靠窗）。
  let maxRow = 0;
  const perRowCols = {};
  const noPrefixMatched = { value: true };
  seats.forEach((s) => {
    if (!s || !s.seat_id) return;
    if (prefix && !String(s.seat_id).startsWith(prefix + '-')) return;
    noPrefixMatched.value = false;
    const r = Number(s.row);
    const c = Number(s.col);
    if (!Number.isFinite(r) || !Number.isFinite(c)) return;
    maxRow = Math.max(maxRow, r);
    perRowCols[r] = (perRowCols[r] || 0) + 1;
  });
  // 无前缀匹配座位时，回退到全局最大行号之后继续（沿用全局编号，但不再回卷到第 1 行）
  if (noPrefixMatched.value) {
    maxRow = 0;
    seats.forEach((s) => {
      if (!s || !s.seat_id) return;
      const r = Number(s.row);
      if (Number.isFinite(r)) maxRow = Math.max(maxRow, r);
    });
  }
  // 目标列数：现有行的最大宽度（至少 1）；若没有任何坐标数据，则按 6 列兜底
  const widths = Object.values(perRowCols);
  let targetCols = widths.length ? Math.max.apply(null, widths) : 6;
  if (!Number.isFinite(targetCols) || targetCols < 1) targetCols = 6;
  return { startRow: maxRow, targetCols };
}

async function actionAddSeats(payload) {
  const roomId = String(payload.room_id || '');
  const prefix = String(payload.prefix || 'A').trim() || 'A';
  const count = Math.min(Math.max(Number(payload.count) || 0, 0), 200);
  if (!roomId) return fail('缺少 room_id', null, 'INVALID_PAYLOAD');
  if (count <= 0) return fail('新增座位数需在 1~200 之间', null, 'INVALID_PAYLOAD');

  let room = null;
  try {
    const found = await db.collection('categories').doc(roomId).get();
    room = found.data || null;
  } catch (e) {
    room = null;
  }
  if (!room) return fail('自习室不存在', null, 'NOT_FOUND');

  const meta = room.metadata || {};
  const seats = Array.isArray(meta.seats) ? meta.seats.slice() : [];
  // 统一用 power 作为电源特征标识：AI 推荐 / 座位筛选（hasPowerFeature）识别 power，
  // 若写入 outlet 会造成「管理端标了电源，用户端筛选不到、AI 不推荐」的口径分裂。
  const features = Array.isArray(payload.features)
    ? payload.features.map((f) => String(f)).filter((f) => f === 'window' || f === 'power' || f === 'outlet').map((f) => (f === 'outlet' ? 'power' : f))
    : [];

  // 编号分配：优先补掉该前缀下的空号（例如删过 A-012 之后，新增应补回 A-012，
  // 而不是跳到 A-015），空号补满后再从最大号顺延 —— 编号始终连续、不缺号。
  const prefixKey = `${prefix}-`;
  const usedNos = new Set();
  seats.forEach((s) => {
    const id = String((s && s.seat_id) || '');
    if (!id.startsWith(prefixKey)) return;
    const m = id.slice(prefixKey.length).match(/(\d+)\s*$/);
    if (m) usedNos.add(Number(m[1]));
  });
  const targetNos = [];
  for (let probe = 1; targetNos.length < count; probe += 1) {
    if (!usedNos.has(probe)) targetNos.push(probe);
  }

  // 从该前缀最后一个座位之后续排（不再从第 1 行第 1 列重新排）
  const pos = computeNextPosition(seats, prefix);

  const added = [];
  for (let i = 1; i <= count; i++) {
    const no = targetNos[i - 1];
    // 换行铺开：row 每满 targetCols 个就 +1，col 在 [1, targetCols] 内循环。
    // 这样新增座位会像真实桌椅一样按行排满，而不是全部贴在最右侧一列。
    const seat = {
      seat_id: `${prefixKey}${formatSeatNo(no)}`,
      row: pos.startRow + Math.floor((i - 1) / pos.targetCols) + 1,
      col: ((i - 1) % pos.targetCols) + 1,
      features: features.slice(),
      status: 'free',
    };
    seats.push(seat);
    added.push(seat.seat_id);
  }
  const nextMeta = Object.assign({}, meta, { seats, capacity: seats.length });
  await db.collection('categories').doc(roomId).update({
    data: { metadata: nextMeta, updated_at: new Date().toISOString() },
  });
  return ok({ room_id: roomId, added, total: seats.length }, `已新增 ${added.length} 个座位`);
}

/** 单座位编辑：修改属性（靠窗/有插座）与/或维护状态 */
async function actionUpdateSeat(payload) {
  const roomId = String(payload.room_id || '');
  const seatId = String(payload.seat_id || '');
  if (!roomId || !seatId) return fail('缺少 room_id / seat_id', null, 'INVALID_PAYLOAD');

  let room = null;
  try {
    const found = await db.collection('categories').doc(roomId).get();
    room = found.data || null;
  } catch (e) {
    room = null;
  }
  if (!room) return fail('自习室不存在', null, 'NOT_FOUND');

  const meta = room.metadata || {};
  const seats = Array.isArray(meta.seats) ? meta.seats.slice() : [];
  const idx = seats.findIndex((s) => s && s.seat_id === seatId);
  if (idx === -1) return fail('座位不存在', null, 'NOT_FOUND');

  const seat = Object.assign({}, seats[idx]);
  const nextStatusRaw = String(payload.status || '');
  const nextFeaturesRaw = Array.isArray(payload.features) ? payload.features.map((f) => String(f)) : null;

  // 维护状态变更：若目标是 maintain，须拦截仍有进行中预约的座位
  if (nextStatusRaw && nextStatusRaw !== seat.status) {
    if (!SEAT_STATUS.includes(nextStatusRaw)) return fail('无效的座位状态', null, 'INVALID_PAYLOAD');
    if (nextStatusRaw === 'maintain') {
      const nowIso = new Date().toISOString();
      const busy = await db
        .collection('records')
        .where({
          room_id: roomId,
          seat_id: seatId,
          record_type: 'reservation',
          status: _.in(OCCUPYING),
          end_at: _.gt(nowIso),
        })
        .limit(1)
        .get()
        .catch(() => ({ data: [] }));
      if (busy.data && busy.data.length) {
        // ⚠️ 错误码必须与 adminSeatMaintain 的 SEAT_OCCUPIED 一致（2026-09-17 统一）。
        // 原先是 SEAT_BUSY，而管理页只对 SEAT_OCCUPIED 给友好提示 →
        // 走 adminOps.updateSeat 改为维护时，用户只看到笼统的「修改失败」。
        return fail('该座位有进行中的预约，不能设为维护', null, 'SEAT_OCCUPIED');
      }
    }
    seat.status = nextStatusRaw;
  }

  // 属性变更：只允许 window / power（outlet 归一为 power，理由同 addSeats），且做幂等去重
  if (nextFeaturesRaw) {
    seat.features = nextFeaturesRaw
      .map((f) => String(f))
      .filter((f) => f === 'window' || f === 'power' || f === 'outlet')
      .map((f) => (f === 'outlet' ? 'power' : f));
  }

  seats[idx] = seat;
  const nextMeta = Object.assign({}, meta, { seats, capacity: seats.length });
  await db.collection('categories').doc(roomId).update({
    data: { metadata: nextMeta, updated_at: new Date().toISOString() },
  });
  return ok({ room_id: roomId, seat_id: seatId, status: seat.status, features: seat.features }, '座位已更新');
}

async function actionRemoveSeats(payload) {
  const roomId = String(payload.room_id || '');
  const seatIds = Array.isArray(payload.seat_ids) ? payload.seat_ids.map((s) => String(s)) : [];
  if (!roomId) return fail('缺少 room_id', null, 'INVALID_PAYLOAD');
  if (!seatIds.length) return fail('请选择要删除的座位', null, 'INVALID_PAYLOAD');

  let room = null;
  try {
    const found = await db.collection('categories').doc(roomId).get();
    room = found.data || null;
  } catch (e) {
    room = null;
  }
  if (!room) return fail('自习室不存在', null, 'NOT_FOUND');

  const targets = new Set(seatIds);
  const meta = room.metadata || {};
  const seats = Array.isArray(meta.seats) ? meta.seats : [];

  // 删除前拦截：仍有进行中预约的座位不允许删除
  const nowIso = new Date().toISOString();
  const busy = await db
    .collection('records')
    .where({
      room_id: roomId,
      record_type: 'reservation',
      status: _.in(OCCUPYING),
      end_at: _.gt(nowIso),
    })
    .limit(200)
    .get()
    .catch(() => ({ data: [] }));
  const busySet = new Set((busy.data || []).map((r) => r.seat_id));

  let blocked = 0;
  const nextSeats = seats.filter((s) => {
    if (!s || !targets.has(s.seat_id)) return true;
    if (busySet.has(s.seat_id)) {
      blocked += 1;
      return true; // 保留
    }
    return false; // 删除
  });

  // nextSeats 已在 filter 中去除了「目标且空闲」的座位（与 blocked 互斥：
  // blocked 计的是「占用且保留」，不参与删除，不能从差值里再减一次）
  const removed = seats.length - nextSeats.length;

  // 编号前移：删掉中间的座位后，后面的号整体补位，不留空号（用户要求「不要有缺的序号」）。
  // 只有真的删掉了座位才重排，避免「一个都没删」时也悄悄改号。
  const compacted = removed > 0 ? compactSeatNumbers(nextSeats) : { seats: nextSeats, moved: [] };
  const finalSeats = compacted.seats;
  // 改号会同步进行中的预约记录，避免用户端座位图 / 预约 / 扫码签到错位
  const renamed = await syncReservationSeatIds(roomId, compacted.moved);

  const nextMeta = Object.assign({}, meta, { seats: finalSeats, capacity: finalSeats.length });
  await db.collection('categories').doc(roomId).update({
    data: { metadata: nextMeta, updated_at: new Date().toISOString() },
  });

  const parts = [`已删除 ${removed} 个座位`];
  if (blocked) parts.push(`${blocked} 个有进行中预约已跳过`);
  if (compacted.moved.length) parts.push(`编号已前移 ${compacted.moved.length} 个`);
  return ok(
    {
      room_id: roomId,
      removed,
      blocked,
      renamed,
      renumbered: compacted.moved,
      total: finalSeats.length,
    },
    parts.join('，'),
  );
}

/**
 * 编号重排：把每个前缀的座位编号压缩成连续 001..00N。
 * 删除座位现在会自动前移编号，此动作用于兜底「本次改动之前就已缺号」的房间
 * （例：列表里出现 A-001…A-011、A-013、A-014，一键补回 A-012）。
 */
async function actionRenumberSeats(payload) {
  const roomId = String(payload.room_id || '');
  if (!roomId) return fail('缺少 room_id', null, 'INVALID_PAYLOAD');

  let room = null;
  try {
    const found = await db.collection('categories').doc(roomId).get();
    room = found.data || null;
  } catch (e) {
    room = null;
  }
  if (!room) return fail('自习室不存在', null, 'NOT_FOUND');

  const meta = room.metadata || {};
  const seats = Array.isArray(meta.seats) ? meta.seats : [];
  const compacted = compactSeatNumbers(seats);
  if (!compacted.moved.length) {
    return ok(
      { room_id: roomId, renumbered: [], renamed: 0, total: seats.length },
      '编号已经连续，无需重排',
    );
  }

  const renamed = await syncReservationSeatIds(roomId, compacted.moved);
  const nextMeta = Object.assign({}, meta, {
    seats: compacted.seats,
    capacity: compacted.seats.length,
  });
  await db.collection('categories').doc(roomId).update({
    data: { metadata: nextMeta, updated_at: new Date().toISOString() },
  });
  return ok(
    { room_id: roomId, renumbered: compacted.moved, renamed, total: compacted.seats.length },
    `编号已重排 ${compacted.moved.length} 个，现为连续 ${compacted.seats.length} 号`,
  );
}

async function actionBatchSeatStatus(payload) {
  const roomId = String(payload.room_id || '');
  const status = String(payload.status || '');
  const seatIds = Array.isArray(payload.seat_ids) ? payload.seat_ids.map((s) => String(s)) : [];
  if (!roomId) return fail('缺少 room_id', null, 'INVALID_PAYLOAD');
  if (!SEAT_STATUS.includes(status)) return fail('无效的座位状态', null, 'INVALID_PAYLOAD');
  if (!seatIds.length) return fail('请先选择座位', null, 'INVALID_PAYLOAD');

  let room = null;
  try {
    const found = await db.collection('categories').doc(roomId).get();
    room = found.data || null;
  } catch (e) {
    room = null;
  }
  if (!room) return fail('自习室不存在', null, 'NOT_FOUND');

  const targets = new Set(seatIds);
  const meta = room.metadata || {};
  const seats = Array.isArray(meta.seats) ? meta.seats : [];
  let changed = 0;
  let blocked = 0;

  // 设为维护时，拦截仍有进行中预约的座位
  const busySet = new Set();
  if (status === 'maintain') {
    const nowIso = new Date().toISOString();
    const busy = await db
      .collection('records')
      .where({
        room_id: roomId,
        record_type: 'reservation',
        status: _.in(OCCUPYING),
        end_at: _.gt(nowIso),
      })
      .limit(100)
      .get()
      .catch(() => ({ data: [] }));
    (busy.data || []).forEach((r) => busySet.add(r.seat_id));
  }

  const nextSeats = seats.map((s) => {
    if (!s || !targets.has(s.seat_id)) return s;
    if (status === 'maintain' && busySet.has(s.seat_id)) {
      blocked += 1;
      return s;
    }
    changed += 1;
    return Object.assign({}, s, { status });
  });

  const nextMeta = Object.assign({}, meta, { seats: nextSeats });
  await db.collection('categories').doc(roomId).update({
    data: { metadata: nextMeta, updated_at: new Date().toISOString() },
  });

  const word = status === 'maintain' ? '设为维护' : '解除维护';
  return ok(
    { room_id: roomId, changed, blocked, seats: nextSeats },
    blocked ? `${word} ${changed} 个座位，${blocked} 个有进行中预约已跳过` : `已${word} ${changed} 个座位`,
  );
}

/* ══════════════ action: 到店签到码 ══════════════ */

/**
 * 查询各自习室当前生效的签到码。
 * - 未设固定码的房间：返回当日动态码（每天 0 点自动轮换，商家张贴/发群即可）
 * - 已设固定码的房间：返回该固定码（custom = true）
 */
async function actionCheckinCodes() {
  const rooms = await fetchAll('categories', { type: 'room' });
  const now = Date.now();
  const date = beijingDateKey(now);
  const list = rooms
    .map((r) => {
      const meta = r.metadata || {};
      const custom = meta.checkin_code ? String(meta.checkin_code).trim() : '';
      return {
        room_id: r._id,
        name: r.name || r._id,
        custom: !!custom,
        code: custom || dailyRoomCode(r._id, date),
        date,
      };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));

  return ok({ rooms: list, date, require_code: requireCheckinCode() });
}

/** 设置 / 清除某自习室的固定签到码（code 传空 = 恢复每日自动轮换） */
async function actionSetCheckinCode(payload) {
  const roomId = String(payload.room_id || '').trim();
  if (!roomId) return fail('缺少 room_id', null, 'INVALID_PAYLOAD');
  const raw = payload.code == null ? '' : String(payload.code).trim();
  if (raw && !/^[0-9A-Za-z]{4,8}$/.test(raw)) {
    return fail('签到码需为 4-8 位数字或字母', null, 'INVALID_PAYLOAD');
  }

  let room = null;
  try {
    const found = await db.collection('categories').doc(roomId).get();
    room = (found && found.data) || null;
  } catch (e) {
    room = null;
  }
  if (!room) return fail('自习室不存在', null, 'NOT_FOUND');

  const meta = Object.assign({}, room.metadata || {});
  meta.checkin_code = raw;
  if (raw) {
    // 切回固定码后，旧的当日展示码不再生效（checkin 只认固定码），清掉避免歧义
    delete meta.checkin_code_today;
  } else {
    // 恢复每日动态码：同步刷新展示码，保证立即与 checkin 校验口径一致
    meta.checkin_code_today = { date: beijingDateKey(Date.now()), code: dailyRoomCode(roomId, beijingDateKey(Date.now())) };
  }
  await db.collection('categories').doc(roomId).update({
    data: { metadata: meta, updated_at: new Date().toISOString() },
  });

  return ok(
    { room_id: roomId, custom: !!raw, code: raw || dailyRoomCode(roomId, beijingDateKey(Date.now())) },
    raw ? '已设置固定签到码' : '已恢复每日自动签到码',
  );
}

/* ══════════════ 签到地理围栏（防拍照远程签到） ══════════════ */

/** 半径夹取 20~2000 米：与 checkin 云函数同值（两处改必须同步） */
function clampGeoRadius(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 200
  return Math.min(2000, Math.max(20, Math.round(n)))
}

/**
 * 各自习室的签到围栏配置。
 * coord_system 固定 gcj02：wx.getLocation / wx.chooseLocation 都是这个口径，
 * 直接配对即可；从高德/百度地图手抄的坐标需先转换，否则会整体偏移数百米。
 */
async function actionRoomGeo() {
  const rooms = await fetchAll('categories', { type: 'room' })
  const list = rooms
    .map((r) => {
      const geo = (r.metadata && r.metadata.geo) || null
      const lat = Number(geo && geo.lat)
      const lng = Number(geo && geo.lng)
      const enabled = Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)
      return {
        room_id: r._id,
        name: r.name || r._id,
        enabled,
        lat: enabled ? lat : null,
        lng: enabled ? lng : null,
        radius: enabled ? clampGeoRadius(geo.radius) : null,
        address: (geo && geo.address) ? String(geo.address).slice(0, 120) : '',
      }
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'))

  return ok({
    rooms: list,
    default_radius: 200,
    min_radius: 20,
    max_radius: 2000,
    coord_system: 'gcj02',
  })
}

/** 设置 / 清除（clear=true）某自习室的签到围栏 */
async function actionSetRoomGeo(payload) {
  const roomId = String(payload.room_id || '').trim()
  if (!roomId) return fail('缺少 room_id', null, 'INVALID_PAYLOAD')

  let room = null
  try {
    const found = await db.collection('categories').doc(roomId).get()
    room = (found && found.data) || null
  } catch (e) {
    room = null
  }
  if (!room) return fail('自习室不存在', null, 'NOT_FOUND')

  const meta = Object.assign({}, room.metadata || {})
  const nowIso = new Date().toISOString()

  if (payload.clear === true) {
    delete meta.geo
    await db.collection('categories').doc(roomId).update({ data: { metadata: meta, updated_at: nowIso } })
    return ok({ room_id: roomId, enabled: false }, '已关闭该自习室的位置签到')
  }

  const lat = Number(payload.lat)
  const lng = Number(payload.lng)
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180 ||
    (lat === 0 && lng === 0)
  ) {
    return fail('经纬度无效，请重新在地图上选点', null, 'INVALID_PAYLOAD')
  }

  const geo = {
    lat,
    lng,
    radius: clampGeoRadius(payload.radius),
    address: payload.address ? String(payload.address).slice(0, 120) : '',
    updated_at: nowIso,
  }
  meta.geo = geo
  await db.collection('categories').doc(roomId).update({ data: { metadata: meta, updated_at: nowIso } })

  return ok({ room_id: roomId, enabled: true, ...geo }, `已设置位置签到（半径 ${geo.radius} 米）`)
}

/**
 * 签到方式总览：一次返回各房间的「位置围栏 + 到店签到码」配置。
 *
 * 2026-09-19：管理端原来要分别调 checkinCodes 和 roomGeo 两个 action，页面上
 * 因此出现**两张功能重叠的卡片**（都要先选房间、都要点保存）——用户明确指出
 * 「不要重复出现相同功能的卡片」。合并成一个 action 后，前端只维护一份房间
 * 列表和一个房间选择器，两张卡合成一张「签到方式」。
 *
 * 旧的 checkinCodes / roomGeo 保留不动（向后兼容）。
 */
async function actionCheckinConfig() {
  const rooms = await fetchAll('categories', { type: 'room' })
  const date = beijingDateKey(Date.now())
  const list = []
  for (const r of rooms) {
    const meta = r.metadata || {}
    const custom = meta.checkin_code ? String(meta.checkin_code).trim() : ''
    const geo = meta.geo || null
    const lat = Number(geo && geo.lat)
    const lng = Number(geo && geo.lng)
    const geoEnabled = Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)
    const code = custom || dailyRoomCode(r._id, date)

    // 管理页展示的动态码同步落库（metadata.checkin_code_today）：
    // checkin 云函数校验时除 HMAC 派生码外也接受这个展示码，
    // 保证「管理页看到什么码、学生输什么码都能签」，
    // 不再受两函数部署版本 / 配置漂移影响。仅在与已存不一致时写库。
    if (!custom) {
      const prev = meta.checkin_code_today || null
      if (!prev || prev.date !== date || String(prev.code || '') !== code) {
        await db.collection('categories').doc(r._id).update({
          data: { 'metadata.checkin_code_today': { date, code }, updated_at: new Date().toISOString() },
        }).catch(() => null);
      }
    }

    list.push({
      room_id: r._id,
      name: r.name || r._id,
      // ① 位置围栏
      geo_enabled: geoEnabled,
      geo_lat: geoEnabled ? lat : null,
      geo_lng: geoEnabled ? lng : null,
      geo_radius: geoEnabled ? clampGeoRadius(geo.radius) : null,
      geo_address: geo && geo.address ? String(geo.address).slice(0, 120) : '',
      // ② 到店签到码
      code_custom: !!custom,
      code,
    })
  }

  list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'))

  return ok({
    rooms: list,
    date,
    require_code: requireCheckinCode(),
    default_radius: 200,
    min_radius: 20,
    max_radius: 2000,
    coord_system: 'gcj02',
  })
}

/* ══════════════ 入口 ══════════════ */

const ACTIONS = {
  overview: actionOverview,
  listReservations: actionListReservations,
  reservationAction: actionReservationAction,
  releaseSeat: actionReleaseSeat,
  listUsers: actionListUsers,
  userAction: actionUserAction,
  upsertRoom: actionUpsertRoom,
  setRoomStatus: actionSetRoomStatus,
  addSeats: actionAddSeats,
  updateSeat: actionUpdateSeat,
  removeSeats: actionRemoveSeats,
  renumberSeats: actionRenumberSeats,
  batchSeatStatus: actionBatchSeatStatus,
  checkinCodes: actionCheckinCodes,
  setCheckinCode: actionSetCheckinCode,
  roomGeo: actionRoomGeo,
  setRoomGeo: actionSetRoomGeo,
  checkinConfig: actionCheckinConfig,
  listFeedback: actionListFeedback,
  markFeedbackHandled: actionMarkFeedbackHandled,
  replyFeedback: actionReplyFeedback,
};

exports.main = async (event = {}) => {
  try {
    await assertAdmin();
  } catch (authErr) {
    return fail((authErr && authErr.message) || '鉴权失败', null, (authErr && authErr.code) || 'FORBIDDEN');
  }

  const action = String((event && event.action) || '');
  const handler = ACTIONS[action];
  if (!handler) return fail(`未知的 action：${action || '(空)'}`, null, 'UNKNOWN_ACTION');

  try {
    return await handler(event || {});
  } catch (err) {
    console.error('[adminOps]', action, err);
    return fail((err && err.message) || '操作失败', null, 'INTERNAL');
  }
};
