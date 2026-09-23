/**
 * 用户意见反馈域（自包含，单文件上传即可运行）。
 *
 * action='submit'（默认，不传即此）：写入 records 集合 record_type='feedback'，
 *   配合管理端「反馈」Tab（listFeedback / replyFeedback）形成闭环。
 * action='listMine'：返回本人反馈列表（含后台 reply 与追问记录），供用户端「我的反馈」展示。
 * action='followUp'：用户对已回复的反馈继续追问 —— 追加到 followups 并把状态打回 pending，
 *   管理员在后台重新看到它（工单重开），避免「回了一句就没下文」。
 * action='close'：用户确认问题已解决 → status='handled'（已关闭），工单生命周期结束。
 *
 * 状态机：pending（待处理）→ replied（已回复，用户可追问/可确认解决）→ handled（已关闭）
 *        任意一步都可被 followUp 打回 pending；后台「仅标记已处理」直接 → handled。
 *
 * 仅依赖 wx-server-sdk，不 require 共享目录（避免漏传导致 MODULE_NOT_FOUND）。
 */
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const RECORDS = 'records';
const CATEGORIES = ['功能建议', '问题反馈', '投诉', '其他'];
const MIN_CONTENT = 5;
const MAX_CONTENT = 500;
const MAX_IMAGES = 4;

function hashOpenId(openId) {
  if (!openId) return '';
  return crypto.createHash('sha256').update(String(openId)).digest('hex').slice(0, 32);
}

function ok(data, message = '提交成功') {
  return { success: true, data, message, request_id: 'req_' + Date.now() };
}

function fail(message, data = null, code = 'ERROR') {
  return { success: false, data, code, message, request_id: 'req_' + Date.now() };
}

/**
 * 本人反馈列表（客服闭环的用户侧）。
 *
 * 只按 openIdHash 过滤，天然隔离他人数据；先取最近 50 条再在内存里倒序，
 * 避免 `where + orderBy` 组合在云开发上因缺索引直接报错。
 */
async function listMine(openIdHash) {
  const res = await db
    .collection(RECORDS)
    .where({ record_type: 'feedback', user_id: openIdHash })
    .limit(50)
    .get();
  const rows = (res && res.data) || [];
  const list = rows
    .slice()
    .sort((a, b) => {
      // 同一毫秒提交时按 _id 倒序兜底，保证顺序稳定（不会两条记录来回跳）
      const diff = String(b.created_at || '').localeCompare(String(a.created_at || ''));
      return diff !== 0 ? diff : String(b._id || '').localeCompare(String(a._id || ''));
    })
    .slice(0, 20)
    .map((r) => ({
      feedback_id: r._id,
      category: r.category || '其他',
      content: r.content || '',
      images: Array.isArray(r.images) ? r.images.slice(0, MAX_IMAGES) : [],
      status: r.status || 'pending',
      // 客服回复：后台 replyFeedback 写入，用户在此可见（闭环的另一半）
      reply: r.reply || '',
      replied_at: r.replied_at || '',
      // 追问记录：用户每次 followUp 追加一条，管理员可见（工单可多轮往来）
      followups: Array.isArray(r.followups) ? r.followups.slice(-10) : [],
      created_at: r.created_at || '',
    }));
  return ok({ list }, '查询成功');
}

/**
 * 读取一条反馈并校验归属权。
 * 只按 user_id 过滤，天然隔离他人数据 —— 追问/关闭前必须先过这一关。
 */
async function getOwnFeedback(id, openIdHash) {
  if (!id) return null;
  try {
    const res = await db.collection(RECORDS).doc(id).get();
    const doc = res && res.data;
    if (!doc || doc.record_type !== 'feedback') return null;
    if (doc.user_id !== openIdHash) return null;
    return doc;
  } catch (e) {
    return null;
  }
}

/**
 * 取用户昵称，供后台工单展示（管理员要能认出是谁提的）。
 * users 集合里字段名两种都兼容；查不到一律返回空串 —— 昵称只是增强信息，
 * 绝不能因为查档案失败就阻断用户提交反馈。
 */
async function fetchNickName(openIdHash) {
  try {
    const res = await db.collection('users').doc(openIdHash).get();
    const u = (res && res.data) || null;
    if (!u) return '';
    return String(u.nick_name || u.nickName || '').slice(0, 40);
  } catch (e) {
    return '';
  }
}

/** 用户追问：追加一条 followup 并把工单打回 pending（重新进入管理员视野） */
async function followUp(openIdHash, feedbackId, content) {
  const text = String(content || '').trim();
  if (!feedbackId) return fail('缺少 feedback_id', null, 'INVALID_PAYLOAD');
  if (text.length < 2) return fail('追问内容至少 2 个字', null, 'INVALID_PAYLOAD');
  if (text.length > MAX_CONTENT) return fail(`追问不能超过 ${MAX_CONTENT} 字`, null, 'INVALID_PAYLOAD');

  const doc = await getOwnFeedback(feedbackId, openIdHash);
  if (!doc) return fail('反馈不存在或无权操作', null, 'NOT_FOUND');

  const now = new Date().toISOString();
  const prev = Array.isArray(doc.followups) ? doc.followups : [];
  const followups = prev.concat([{ content: text, created_at: now }]).slice(-10);
  try {
    await db.collection(RECORDS).doc(feedbackId).update({
      data: { followups, status: 'pending', updated_at: now },
    });
  } catch (e) {
    return fail(`追问失败：${(e && e.message) || '请稍后重试'}`, null, 'UPDATE_FAILED');
  }
  return ok({ feedback_id: feedbackId, status: 'pending', followups }, '追问已提交，我们会继续跟进');
}

/** 用户确认解决：工单关闭（status='handled'） */
async function close(openIdHash, feedbackId) {
  if (!feedbackId) return fail('缺少 feedback_id', null, 'INVALID_PAYLOAD');
  const doc = await getOwnFeedback(feedbackId, openIdHash);
  if (!doc) return fail('反馈不存在或无权操作', null, 'NOT_FOUND');
  if (doc.status === 'handled') return ok({ feedback_id: feedbackId, status: 'handled' }, '该反馈已关闭');

  const now = new Date().toISOString();
  try {
    await db.collection(RECORDS).doc(feedbackId).update({
      data: { status: 'handled', closed_at: now, updated_at: now },
    });
  } catch (e) {
    return fail(`关闭失败：${(e && e.message) || '请稍后重试'}`, null, 'UPDATE_FAILED');
  }
  return ok({ feedback_id: feedbackId, status: 'handled' }, '已关闭，感谢你的反馈');
}

exports.main = async (event = {}) => {
  try {
    const wxContext = cloud.getWXContext();
    const openId = (wxContext && wxContext.OPENID) || '';
    if (!openId) {
      return fail('无法获取用户身份，请在真机或已登录开发者工具中重试');
    }
    const openIdHash = hashOpenId(openId);

    // 动作分发：默认 submit（兼容旧调用方不传 action）
    const action = String((event && event.action) || 'submit').trim();
    const feedbackId = String((event && event.feedback_id) || '').trim();
    if (action === 'listMine') return listMine(openIdHash);
    if (action === 'followUp') return followUp(openIdHash, feedbackId, event && event.content);
    if (action === 'close') return close(openIdHash, feedbackId);

    const category = String((event && event.category) || '').trim();
    const content = String((event && event.content) || '').trim();
    const images = Array.isArray(event.images)
      ? event.images.filter((x) => typeof x === 'string' && x).slice(0, MAX_IMAGES)
      : [];

    if (!CATEGORIES.includes(category)) return fail('请选择反馈类型');
    if (content.length < MIN_CONTENT) return fail(`请至少输入 ${MIN_CONTENT} 个字的描述`);
    if (content.length > MAX_CONTENT) return fail(`描述不能超过 ${MAX_CONTENT} 字`);

    // 后台要「认出是谁提的」：只靠 32 位 user_id 哈希，管理员根本对不上号。
    // 这里顺手把昵称写进工单（查不到就留空，绝不能因此阻断提交）。
    const nickName = await fetchNickName(openIdHash);

    const now = new Date().toISOString();
    const doc = {
      record_type: 'feedback',
      user_id: openIdHash,
      nick_name: nickName,
      category,
      content,
      images,
      status: 'pending',
      created_at: now,
      updated_at: now,
    };
    const added = await db.collection(RECORDS).add({ data: doc });
    return ok({ _id: (added && added._id) || '' }, '反馈已提交，感谢你的反馈');
  } catch (err) {
    console.error('[submitFeedback]', err);
    return fail((err && err.message) || '提交失败');
  }
};
