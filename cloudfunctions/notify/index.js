/**
 * notify 云函数：发送订阅消息（微信开放能力）。
 *
 * 设计要点：
 *   1) 本函数是「模板 ID + 关键词编号」的**唯一配置源**（见下方 TEMPLATES）。
 *      前端在调用时只需传 `type`（reservationConfirmed / checkinReminder /
 *      reservationWarn / reservationCancel）+ 内容字段，由本函数完成
 *      「模板 ID 查找 + 关键词编号拼装 + 发送」。这样改文案/编号只动这一处。
 *   2) 兼容旧路径：仍支持上层直接传 `templateId` + 已拼好的 `data`。
 *   3) 触发方：
 *      - 客户端（预约成功/取消）：调用时带微信登录态，`cloud.getWXContext().OPENID`
 *        即为接收人，无需传 openid；
 *      - 后端定时器（expireRecords 的签到提醒/超时预警）：无用户态，必须显式传 `openid`。
 *
 * 任一层缺失（模板未配 / 用户未授权 / 发送失败）均优雅返回 success:false + code，
 * 不抛错、不中断调用方主流程。
 */
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

/**
 * 模板配置：4 张公共模板（与 miniprogram/config/subscribe.ts 的 SUBSCRIBE_TEMPLATES
 * 一一对应，ID 必须保持一致）。当公众平台重新选用模板、得到新 ID 时，改这里一行即可。
 * 也可用环境变量覆盖（便于线上切换而不改代码）。
 *
 * ⚠️ keys 是各关键词的**真实字段名**，来自公众平台「我的模板 → 详情」里的
 *    {{thingN.DATA}} / {{timeN.DATA}} 标注（2026-09-22 实抄）。
 *    微信校验规则：模板定义的**每一个**关键词都必须给非空值，缺任何一个即
 *    47003 "data.thingN.value is empty" 整条拒绝；多余的字段名会被忽略。
 *    所以 keys 与详情页逐字对齐是硬要求，不能用「想当然」的 thing1/time2/thing3。
 */
const TEMPLATES = {
  // 预约成功通知：预约门店 thing9 / 预约时间 time2 / 温馨提示 thing18
  reservationConfirmed: {
    id: process.env.TPL_RESERVATION_CONFIRMED || '6UvoDgpF701v8p0gWOjF949tJJy25xxy85KFhLUSNHI',
    keys: { main: 'thing9', time: 'time2', extra: 'thing18' },
  },
  // 签到提醒：签到地点 thing14 / 签到时间 time23 / 温馨提示 thing16
  checkinReminder: {
    id: process.env.TPL_CHECKIN_REMINDER || '4Efagae9eO8Hr_ebTqIpYnToQ-CUOt0eNU5wRx5R-Q4',
    keys: { main: 'thing14', time: 'time23', extra: 'thing16' },
  },
  // 客户预约提醒（4 词全填）：门店 thing1 / 预约时间 time7 / 预约事项 thing6 / 预约人 thing2
  // 调用方（expireRecords 定时器）传 main=门店名、extra=预警文案；「预约人」无数据源，用 person 兜底
  reservationWarn: {
    id: process.env.TPL_RESERVATION_WARN || 'fHT0daY9spalZOPwR2Nb-wJSAxPs56pPL7KChXjtOL8',
    keys: { main: 'thing1', time: 'time7', extra: 'thing6', person: 'thing2' },
  },
  // 预约取消通知：预约项目 thing1 / 预约时间 time20 / 温馨提示 thing13
  reservationCancel: {
    id: process.env.TPL_RESERVATION_CANCEL || 'n-kM6Ft1-t3ZsR5w20FJ81wo2ZJkKkNGX3PYEBJmLsk',
    keys: { main: 'thing1', time: 'time20', extra: 'thing13' },
  },
}

/** 事物型关键词限 20 字以内，超出会被云端整条拒绝 → 主动截断兜底 */
function clamp(text, max = 20) {
  const t = String(text == null ? '' : text).trim()
  return t.length > max ? t.slice(0, max) : t
}

/** 北京时间（UTC+8）格式化：2026年9月16日 16:28（订阅消息时间型关键词要求 24 小时制） */
function formatBeijing(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const bj = new Date(d.getTime() + 8 * 3600 * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${bj.getUTCFullYear()}年${bj.getUTCMonth() + 1}月${bj.getUTCDate()}日 ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`
}

exports.main = async (event) => {
  const action = (event && event.action) || ''
  if (action === 'send') return sendSubscribe(event)
  return { success: false, code: 'BAD_ACTION', message: '未知 action' }
}

async function sendSubscribe(event) {
  const wxContext = cloud.getWXContext()
  const touser = event.openid || (wxContext && wxContext.OPENID)
  if (!touser) {
    return { success: false, code: 'NO_OPENID', message: '无法获取接收人 openid' }
  }

  let templateId
  let data

  if (event.type && TEMPLATES[event.type]) {
    const t = TEMPLATES[event.type]
    templateId = t.id
    if (!templateId) {
      return { success: false, code: 'NO_TEMPLATE', message: `未配置订阅消息模板：${event.type}` }
    }
    const k = t.keys
    data = {}
    if (k.main && event.main) data[k.main] = { value: clamp(event.main) }
    if (k.time && event.time) {
      // 时间型关键词要求 24 小时制。统一在**云端按北京时间**格式化，
      // 避免前端按「运行环境本地时区」格式化造成跨时区错乱
      // （2026-09-17：前端原先自己 formatTime，与这里口径不同，已收敛到本函数）。
      const raw = String(event.time)
      data[k.time] = { value: formatBeijing(raw) || raw }
    }
    if (k.extra && event.extra) data[k.extra] = { value: clamp(event.extra) }
    // 第 4 关键词（仅「客户预约提醒」的「预约人」thing2）：调用方大多没有用户昵称，
    // 定时器更是完全无用户态 → 用中性文案兜底，保证模板定义的每个关键词都非空
    if (k.person) data[k.person] = { value: clamp(event.person || '专注座用户') }
  } else if (event.templateId) {
    // 兼容旧路径：上层已拼好 data（历史调用方 / 手工补发）
    templateId = event.templateId
    data = event.data || {}
  } else {
    return { success: false, code: 'NO_TEMPLATE', message: '缺少 type 或 templateId' }
  }

  try {
    await cloud.openapi.subscribeMessage.send({
      touser,
      templateId,
      page: event.page || 'pages/home/home',
      data,
    })
    return { success: true }
  } catch (err) {
    return {
      success: false,
      code: 'SEND_FAIL',
      message: (err && err.message) || '订阅消息发送失败',
    }
  }
}

// 纯函数导出，供单测复用
exports.__test = { clamp, formatBeijing, TEMPLATES }
