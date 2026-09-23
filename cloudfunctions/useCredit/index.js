/* 邀请积分：1 分 = 抵免 1 次违约（上限 WAIVER_LIMIT 次）。
 *
 * 背景（2026-09-23）：
 *   原 invite_credit 只写不读——用户完全不知道积分有何用。
 *   本函数把「积分」做成可消费的权益：用户 >0 积分且 >0 违约时，
 *   消耗 1 积分抵消 1 次违约（no_show_count -1），保留可抵扣余额。
 *
 * 防刷/幂等：
 *   - 条件更新（where _id + invite_credit >= 1）保证并发只扣 1 次；
 *   - 每人累计可用（WAIVER_LIMIT）次，达到上限后拒绝并提示；
 *   - 每次抵免写 waiver_log 留痕（时间 / 剩余积分 / 剩余违约）；
 *   - 无全局事务需求，单条条件更新 + 一次读取即可。
 */
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/** 每人累计可用积分抵免违约的上限（防刷） */
const WAIVER_LIMIT = 10;

function hashOpenId(openId) {
  if (!openId) return '';
  return crypto.createHash('sha256').update(String(openId)).digest('hex').slice(0, 32);
}

function ok(data, message = '操作成功') {
  return { success: true, data, message, request_id: 'req_' + Date.now() };
}

function fail(message, data = null, code = 'ERROR') {
  return { success: false, data, code, message, request_id: 'req_' + Date.now() };
}

/** 从用户文档安全取数值 */
function num(v) {
  return Number.isFinite(v) ? v : 0;
}

exports.main = async (event = {}) => {
  try {
    const wxContext = cloud.getWXContext();
    const openId = (wxContext && wxContext.OPENID) || '';
    if (!openId) {
      return fail('无法获取用户身份，请在真机或已登录开发者工具中重试');
    }
    const userId = hashOpenId(openId);

    // 读取本人档案（含积分 / 违约 / 已用次数）
    let doc = null;
    try {
      const found = await db.collection('users').doc(userId).get();
      doc = found.data || null;
    } catch (e) {
      doc = null;
    }
    if (!doc) {
      return ok(
        { credit: 0, no_show_count: 0, waived_total: 0, can_waive: false, remaining_waives: WAIVER_LIMIT },
        '用户尚未产生违约记录',
      );
    }

    const credit = num(doc.invite_credit);
    const noShow = num(doc.no_show_count);
    const waivedTotal = num(doc.waiver_total_used);

    if (noShow <= 0) {
      return ok(
        { credit, no_show_count: noShow, waived_total: waivedTotal, can_waive: false, remaining_waives: WAIVER_LIMIT - waivedTotal },
        '当前没有可抵扣的违约记录',
      );
    }
    if (credit <= 0) {
      return ok(
        { credit, no_show_count: noShow, waived_total: waivedTotal, can_waive: false, remaining_waives: WAIVER_LIMIT - waivedTotal },
        '积分不足，邀请好友完成首次签到可获得积分',
      );
    }
    if (waivedTotal >= WAIVER_LIMIT) {
      return ok(
        { credit, no_show_count: noShow, waived_total: waivedTotal, can_waive: false, remaining_waives: 0 },
        `每人最多使用 ${WAIVER_LIMIT} 次积分抵免，已达到上限`,
      );
    }

    const now = new Date().toISOString();
    const logEntry = {
      at: now,
      credit_after: credit - 1,
      no_show_after: noShow - 1,
    };
    // 条件更新：积分 >= 1 才扣（并发安全，只成功一次）。
    // waiver_log 用「读-改-写」方式追加（读旧数组 + 拼新数组），避免依赖 db.command.push。
    let waiverLog = Array.isArray(doc.waiver_log) ? doc.waiver_log : [];
    waiverLog = waiverLog.slice(-49).concat([logEntry]); // 最多留 50 条
    const up = await db
      .collection('users')
      .where({ _id: userId, invite_credit: _.gte(1) })
      .update({
        data: {
          invite_credit: _.inc(-1),
          no_show_count: _.inc(-1),
          waiver_total_used: _.inc(1),
          updated_at: now,
          // 留痕：最近一次抵免
          last_waiver_at: now,
          waiver_log: waiverLog,
        },
      });
    if (!up || !up.stats || up.stats.updated !== 1) {
      return fail('抵免失败，请重试', null, 'WAIVE_CONFLICT');
    }

    return ok(
      { credit: credit - 1, no_show_count: noShow - 1, waived_total: waivedTotal + 1, can_waive: true, remaining_waives: WAIVER_LIMIT - (waivedTotal + 1) },
      '已用 1 积分抵免 1 次违约',
    );
  } catch (err) {
    console.error('[useCredit]', err);
    return fail((err && err.message) || '抵免失败', null, 'ERROR');
  }
};