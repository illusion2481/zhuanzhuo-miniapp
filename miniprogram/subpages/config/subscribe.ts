/**
 * 订阅消息配置：模板 ID + 关键词编号（一个 slot = 一张公众平台选用的模板）。
 *
 * ⚠️ 模板 ID 到【微信公众平台 → 功能 → 订阅消息 → 我的模板】选用后获得，
 * 填到下面字符串里（或配到云函数 notify 的环境变量 TPL_*）。
 * 未配置时：所有订阅请求与推送都会静默跳过，不影响主流程（不报错、不阻塞）。
 *
 * 一次性订阅：用户授权一次 = 可下发一条该模板的通知（用完即失效，需要再次授权）。
 * 长期订阅：需小程序类目支持（政务/金融/教育等），自习室类目通常只能一次性。
 *
 * 选用清单与增减订阅见 docs/订阅消息模板配置.md —— 共 4 张模板覆盖全部可推送功能：
 *   1) 预约成功通知   → reservationConfirmed
 *   2) 签到提醒       → checkinReminder（同时复用于暂离/离场超时预警的内容）
 *   3) 预约提醒通知   → reservationWarn（待签到超时预警、暂离超时提醒）
 *   4) 预约取消通知   → reservationCancel（预约取消、违约、违规禁约）
 */
export const SUBSCRIBE_TEMPLATES = {
  /** ① 预约成功通知（预约门店/预约时间/温馨提示）：用户创建预约后即时确认（reservation.ts 已接，上线即可用） */
  reservationConfirmed: '6UvoDgpF701v8p0gWOjF949tJJy25xxy85KFhLUSNHI',

  /** ② 签到提醒（签到地点/签到时间/温馨提示）：预约开始前提醒到店签到（需定时触发器 + notify 云函数，进阶项） */
  checkinReminder: '4Efagae9eO8Hr_ebTqIpYnToQ-CUOt0eNU5wRx5R-Q4',

  /** ③ 客户预约提醒（预约人/预约时间/预约事项…）：待签到超时预警 / 暂离超时提醒（进阶项，待接触发器） */
  reservationWarn: 'fHT0daY9spalZOPwR2Nb-wJSAxPs56pPL7KChXjtOL8',

  /** ④ 预约取消通知（预约项目/预约时间/温馨提示）：预约被取消 / 记为违约 / 触发违规禁约时告知用户（进阶项，待接） */
  reservationCancel: 'n-kM6Ft1-t3ZsR5w20FJ81wo2ZJkKkNGX3PYEBJmLsk',
} as const;

export type SubscribeType = keyof typeof SUBSCRIBE_TEMPLATES;

/**
 * 每个场景的「关键词编号」—— 对应模板详情里的 `{{xxxN.DATA}}` 名字。
 *
 * ⚠️ 云端的编号由你在公众平台**勾选关键词的顺序**决定（第 N 个词的编号就是 N，
 * 前缀是它的类型：事物=thing / 时间=time / 日期=date / 字符型=character_string）。
 *
 * 选好模板后务必打开【我的模板 → 点开该模板】把真实的 `{{thingN.DATA}}` 名字抄到这里
 * （发送侧的唯一配置源在 cloudfunctions/notify/index.js 的 TEMPLATES.keys，两处必须同改）。
 * 若实际编号与默认不同（例如时间是 `date2` 而不是 `time2`），只改对应行即可。
 */
export interface SubscribeKeyMap {
  /** 主信息（门店 / 自习室名 / 预约项目） */
  main?: string;
  /** 时间信息（预约时间 / 签到时间） */
  time?: string;
  /** 附加信息（温馨提示 / 预约事项） */
  extra?: string;
  /** 第 4 关键词（仅「客户预约提醒」的「预约人」），云端用中性文案兜底 */
  person?: string;
}

/**
 * ⚠️ 以下字段名是 2026-09-22 从公众平台「我的模板 → 详情」**逐张实抄**的真实
 * {{thingN.DATA}} / {{timeN.DATA}} 名。微信校验规则：模板定义的每一个关键词都必须
 * 给非空值，缺任何一个 → 47003 "data.thingN.value is empty" 整条拒绝。
 * 此前默认假设 thing1/time2/thing3 与实际模板全部不符（仅预约成功通知的 time2 碰巧对上），
 * 导致「预约成功通知」发送 47003 静默失败 —— 今后换模板必须同步改这里 + notify/index.js。
 */
export const SUBSCRIBE_KEYS: Record<SubscribeType, SubscribeKeyMap> = {
  // 预约成功通知：预约门店 thing9 / 预约时间 time2 / 温馨提示 thing18
  reservationConfirmed: { main: 'thing9', time: 'time2', extra: 'thing18' },
  // 签到提醒：签到地点 thing14 / 签到时间 time23 / 温馨提示 thing16
  checkinReminder: { main: 'thing14', time: 'time23', extra: 'thing16' },
  // 客户预约提醒（4 词）：门店 thing1 / 预约时间 time7 / 预约事项 thing6 / 预约人 thing2
  reservationWarn: { main: 'thing1', time: 'time7', extra: 'thing6', person: 'thing2' },
  // 预约取消通知：预约项目 thing1 / 预约时间 time20 / 温馨提示 thing13
  reservationCancel: { main: 'thing1', time: 'time20', extra: 'thing13' },
};
