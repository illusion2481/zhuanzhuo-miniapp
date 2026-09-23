/**
 * 座位占用「实时信号」工具 —— 供所有会改变预约占用状态的云函数复用。
 *
 * 【为什么需要它】
 * 座位占用状态存于 records 集合，而 records 的读权限是收紧的（DEPLOY.md §6：
 * doc.user_id == auth.openid），因此小程序前端无法直接 watch records 来感知
 * 「别人预约/取消/签到」导致的座位变化。
 *
 * 【方案】
 * 在 categories 房间文档上维护一个单调递增的 `metadata.presence` 版本号。
 * 任何导致座位占用变化的写操作（预约/取消/签到/暂离/返回/超时释放），
 * 在数据库写入成功后调用 `bumpPresenceVersion(roomId)` 递增版本号。
 *
 * 前端 seats 页对当前房间的 categories 文档做 `watch`：
 * 只要该文档的 presence 版本变化，立即触发一次 `roomList` 重拉。
 * 最终座位占用状态仍然只由 roomList（唯一权威源）计算，本模块不引入
 * 第二套占用口径 —— 这正是报告 §4「五处一致性」红线要求的。
 *
 * 【降级】
 * 即使 watch 断连/不支持，现有 15s 轮询仍保留兜底，功能不会退化。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/**
 * 对某个房间的 categories 文档做一次「存在性版本戳」更新。
 * 任意写入失败被静默吞掉：版本戳只是实时信号，不能阻塞业务主流程。
 *
 * @param {string} roomId categories 集合文档 _id（房间）
 * @returns {Promise<void>}
 */
async function bumpPresenceVersion(roomId) {
  if (!roomId) return;
  try {
    const now = new Date().toISOString();
    await db
      .collection('categories')
      .doc(roomId)
      .update({
        data: {
          updated_at: now,
          presence: { version: Date.now(), at: now },
        },
      });
  } catch (e) {
    // 静默失败：bump 只是提速手段，失败回退到轮询
    console.warn('[presence] bump failed for room:', roomId, (e && e.message) || e);
  }
}

module.exports = { bumpPresenceVersion };