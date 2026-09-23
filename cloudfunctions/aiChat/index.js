/**
 * aiChat 云函数：AI 客服（方案 A）
 * -------------------------------------------------
 * 让「联系客服」在无人值守时也有回复 —— 复用项目已有的 AI 通道
 * （CODING_PLAN_API_KEY / chatapi.weixin.qq.com，模型 Deepseek-v4-flash）。
 *
 * 交互模型：
 *   用户在小程序「AI 客服」聊天页发消息
 *     → 本函数按 FAQ 知识库（本地静态，随代码部署）+ 少量实时数据（开放时段/规则）
 *       构造 system 提示词，让 AI 用「专注座」的口吻回答基本问题
 *     → 答不出 / 涉及退款等需人工的 → 返回 need_human:true，前端引导转「意见反馈 / 联系人工」
 *
 * 设计要点：
 *   1) 知识库内置于代码（与前端 FAQ 页 list 同源同构，避免两份漂移），部署即生效；
 *   2) 复用 aiRecommend/shared/aiClient.js —— 10 分钟缓存 / 模型回退 / 401 不重试全都有；
 *   3) 单用户 1 分钟 10 次限流（防刷 AI 次数），key 在内存，冷启动后自动清零可接受；
 *   4) 内容安全：user 输入先过 validator（max）截断，返回前 sanitize 粗过滤（不透传原始敏感词）；
 *   5) 失败/超时 → 返回 need_human:true，优雅降级到人工，绝不抛错中断会话；
 *   6) 无用户态（OPENID 缺失）时也允许走（聊天页只当匿名咨询），限流键退化为匿名+分钟。
 *
 * 环境变量：CODING_PLAN_API_KEY（必填，与 aiRecommend 同一个）
 * 部署：开发者工具右键 cloudfunctions/aiChat → 上传并部署：云端安装依赖（shared 会一起传）。
 */

const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { chatCompletionWithRetry } = require('./shared/aiClient')
const { validateEvent } = require('./shared/validator')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

/** 入参白名单（F7 风格） */
const SCHEMA = {
  action: { type: 'enum', values: ['chat'], optional: true, default: 'chat' },
  /** 用户消息（≤200 字，超长截断） */
  msg: { type: 'string', max: 200, optional: true, default: '' },
  /** 会话来源页（faq / profile / feedback / aiChat） */
  from: { type: 'string', max: 16, optional: true, default: 'aiChat' },
  /** 最近 3 条上下文（防多轮失忆） */
  history: {
    type: 'array<object>',
    maxItems: 3,
    optional: true,
    itemFields: { role: 8, content: 200 },
  },
}

/** 高频问答知识库 —— 与 miniprogram/pages/faq/faq.ts 的 list 保持同构。
 * ⚠️ 改这里必须同步改 faq.ts，两份都是「常见问题」的数据源，
 * 由 scripts/full-audit.cjs 的「FAQ 双端一致」断言守护。 */
const FAQ_ITEMS = [
  { q: '怎么预约座位', a: '首页选推荐座位，或进「自习室」挑房间 → 在座位图上点绿色空闲座 → 确认时段后点「确认预约」。预约成功后会生成一条待签到的预约记录。' },
  { q: '预约后必须在多久内签到', a: '预约开始时间起 15 分钟内要完成签到，否则系统会自动释放座位并记一次违约。' },
  { q: '签到方式有哪几种', a: '两种：① 到店扫码或输入「今日签到码」（每个自习室每天一个码，管理员在后台「签到」页查看）；② 位置签到（需授权定位，且在门店设定范围内）。' },
  { q: '签到失败 提示不在范围内', a: '位置签到要求你在门店设定半径内（默认几百米）。先确认手机已授权定位、且用的不是飞行模式；室内 GPS 漂移较大时，可走到窗边重试，或改用「今日签到码」签到。' },
  { q: '签到失败 提示签到码错误', a: '每个自习室每天一个签到码，后台「签到」页可查看当日码。常见原因：① 输错或复制带了空格；② 看的是别的房间的码；③ 管理员刚重置过码。确认后重输一次即可。' },
  { q: '签到失败 提示当前预约不可签到', a: '说明这条预约当前不在可签到状态：可能已超过开始时间 15 分钟（系统已释放并记违约）、预约已被取消，或这条已经签过到了。可点「我的预约」确认状态。' },
  { q: '临时离开座位会被释放吗', a: '可以点「暂离」，座位为你保留 30 分钟；超过 30 分钟未返回，座位自动释放并记一次违约。' },
  { q: '怎么取消预约', a: '在「我的预约」里点对应记录 → 取消预约。开始前取消不计违约，可放心取消；已开始使用的预约可以点「提前结束」。' },
  { q: '违约会有什么后果', a: '按累计次数梯度禁约：第 1 次 30 分钟、第 2 次 2 小时、第 3 次起 24 小时，期间无法预约。禁约到期后自动恢复，无需申诉。' },
  { q: '学习时长不够 能续时吗', a: '可以。在「我的预约」里点「续时」，选择追加时长即可；若该座位后续时段已被他人预约，则无法续时。' },
  { q: '收不到预约提醒怎么办', a: '在「我的」→「开启预约通知」里授权订阅消息。注意：微信的订阅消息是一次性的，每次授权对应一条通知，预约后建议顺手再点一次「开启」。' },
  { q: '预约通知是实时给我推吗', a: '是服务通知。授权后，预约成功、签到提醒、超时预警等会推送到微信「服务通知」。若收不到，先看「我的 → 开启预约通知」是否授权过。' },
  { q: '怎么修改自己的资料', a: '在「我的」页点头像卡可更换微信头像、编辑昵称；头像昵称仅用于展示，不影响预约/签到。' },
  { q: '排行榜怎么计算的', a: '学习排行榜按「累计学习时长」排序，周榜按本周、总榜按全部历史。学习时长来自番茄钟，每完成一个番茄段记一次。' },
  { q: '番茄钟怎么用', a: '在「学习」页点开始番茄钟，专注 25 分钟后完成即记一次学习；中途可暂停/结束。学习时长会计入你的学习记录与排行榜。' },
  { q: '会有哪些情况影响信誉分', a: '爽约（预约未签到）、暂离超时会被记录并影响后续预约（梯度禁约）。认真学习、按时签到不会影响。' },
  { q: '可以开空调/有插座吗', a: '座位图上有「靠窗」「电源」「安静」等标签，支持按标签筛选。具体设施以自习室页面展示为准。' },
  { q: '邀请好友有什么奖励 积分怎么用', a: '邀请好友通过你的分享进入小程序，并在好友首次完成签到后，你和好友各得 1 积分。积分可在「我的」页用来「抵免违约」：1 积分抵消 1 次违约记录（每人累计最多使用 10 次）。' },
  { q: '开放时间是什么时候', a: '每个自习室的开放时间不同，可在自习室列表/详情页看到当天开放时段；未到开放时间或已打烊的座位会显示为不可预约。' },
]

/** 实时数据（可选）：读 categories 里的 room 开放时段，拼接给 AI 参考。失败不阻断 */
async function buildOpenRules() {
  try {
    const res = await db
      .collection('categories')
      .where({ type: 'room', status: 'active' })
      .limit(20)
      .get()
    const rooms = (res.data || []).slice(0, 6)
    if (!rooms.length) return ''
    return rooms
      .map((r) => {
        const m = r.metadata || {}
        return `${r.name}：${m.open_time || '?'}-${m.close_time || '?'}`
      })
      .join('；')
  } catch (e) {
    return ''
  }
}

/** 构造 system 提示词（知识库 + 规则 + 实时时段 + 会话上下文） */
async function buildSystemPrompt(from, uid, openRules) {
  const lines = []
  lines.push('你是「专注座」自习室的 AI 客服助手，负责回答用户在预约、签到、违约、通知、学习等场景下的常见问题。')
  lines.push('保底规则：只根据下面的知识库回答，不要编造自习室政策；与自习室无关的话题礼貌拒绝；回答简洁（≤120 字）、口语化、礼貌。')
  lines.push('如果你无法从知识库确定答案，或者问题涉及退款、纠纷、账号封禁等敏感事项，必须如实说「这个问题需要转人工客服处理」，不要硬答。')
  lines.push('')
  lines.push('【知识库】')
  FAQ_ITEMS.forEach((it, i) => lines.push(`${i + 1}. Q：${it.q}\n   A：${it.a}`))
  lines.push('')
  lines.push('【规则】')
  lines.push('- 预约开始时间起 15 分钟内签到有效；')
  lines.push('- 暂离最长保留 30 分钟；')
  lines.push('- 违约梯度：第 1 次 30 分钟、第 2 次 2 小时、第 3 次起 24 小时禁约；')
  lines.push('- 反馈工单：在「我的 → 意见反馈」提交，后台按 24 小时内首响跟进；')
  lines.push('- 需要转人工时，引导用户：去「意见反馈」提交工单，或点「联系客服」转人工。')
  if (openRules) {
    lines.push('')
    lines.push(`【今日自习室开放时段】${openRules}`)
  }
  lines.push('')
  lines.push(`【当前会话】用户来源：${from || 'aiChat'}`)
  if (uid) lines.push(`用户标识：${uid.slice(0, 8)}…（仅用于识别，不要追问）`)
  return lines.join('\n')
}

/** 纯函数：是否需要人工介入（启发式关键词，避免让 AI 乱承诺退款/纠纷） */
function needHumanKeywords(text) {
  const t = String(text || '').toLowerCase()
  return /(退款|退钱|赔偿|投诉|纠纷|人工|真人|举报|差评|生气|客服电话|电话|维权|不满意|怎么投诉)/.test(t)
}

/** 简单内容安全：粗过滤反链/电话号，不透传原始敏感内容 */
function sanitize(text) {
  if (!text) return text
  return String(text).replace(/(https?:\/\/|www\.|\.com|\.cn|\+?86|1[3-9]\d{9})/gi, '')
}

function fail(message, data = null) {
  return { success: false, data, message, request_id: 'req_' + Date.now() }
}
function ok(data, message = 'ok') {
  return { success: true, data, message, request_id: 'req_' + Date.now() }
}

/**
 * 降级文案分档。
 * 原先所有失败都回同一句「暂时走神了（可能网络波动）」，把「Key 没配」
 * 这种配置问题伪装成网络抖动 —— 用户被误导，排查者也无从下手。
 * 现在按错误码给不同说法，用户侧能自助，日志侧可定位。
 */
function fallbackReplyOf(code) {
  if (code === 'AI_NOT_CONFIGURED') {
    return 'AI 客服正在配置中，暂时还不能回答问题。你可以先看「常见问题」，或点下方「联系客服」转人工。'
  }
  // 与「没配 Key」分开措辞：两者都属于配置问题，但处置方式完全不同，
  // 合并成一句话会让排查者只能靠翻日志区分（2026-09-22 踩过）。
  if (code === 'AI_NO_FETCH') {
    return 'AI 客服的运行环境缺少必要组件，暂时无法回答。你可以先看「常见问题」，或点下方「转人工客服」。'
  }
  if (code === 'AI_HTTP_429') {
    return '现在咨询的人有点多，AI 客服需要排队。你可以稍后再问我一次，或点下方「转人工客服」。'
  }
  if (code === 'AI_HTTP_401' || code === 'AI_HTTP_403') {
    return 'AI 客服的服务凭据需要更新，暂时无法回答。你可以先看「常见问题」，或点下方「转人工客服」。'
  }
  if (code === 'AI_HTTP_400') {
    return 'AI 客服暂时没法处理这个问题。你可以换个说法再问一次，或点下方「转人工客服」。'
  }
  if (code === 'AI_INPUT_TOO_LONG') {
    return '你的问题有点长，我没能读完。可以精简成一句话再发一次，或点下方「转人工客服」。'
  }
  return 'AI 助手暂时走神了（可能网络波动）。建议你先看「常见问题」，或点下方「联系客服」转人工，也可在「意见反馈」提交工单。'
}

/** 内存限流表（云函数冷启动归零，可接受）：uid → 最近 1 分钟内时间戳数组 */
const RATE = {}

/**
 * 全路径留痕前缀。
 * 排查价值在于「有没有这条日志」本身 —— 此前只有失败分支写日志，
 * 于是「AI 调不动」和「云函数压根没起来」在控制台里长得一模一样：
 *   没有 ▶入口        → 云函数没被调起来（前端调度 / 环境 / 权限问题，与 AI 无关）
 *   有 ▶入口 无 ▶调AI  → 被本地规则拦下（限流 / 空消息 / 命中人工关键词）
 *   有 ▶调AI 无 ✔或✘  → 卡在上游，或撞上 20s 网关超时（容器被强杀，catch 来不及执行）
 * 注意：只打印环境变量的「有无与长度」，绝不打印值本身。
 */
const TRACE = '[aiChat]'

exports.main = async (event) => {
  console.log(TRACE, '▶入口 收到请求', JSON.stringify({
    action: event && event.action,
    from: event && event.from,
    msgLen: ((event && event.msg) || '').length,
    historyLen: Array.isArray(event && event.history) ? event.history.length : 0,
    node: process.version,
  }))
  const check = validateEvent(event, SCHEMA)
  if (!check.ok) {
    console.log(TRACE, '✘入参校验失败', check.error)
    return fail(check.error)
  }
  const v = check.value

  const wxContext = cloud.getWXContext()
  const openid = (wxContext && wxContext.OPENID) || ''
  const uid = openid
    ? crypto.createHash('sha256').update(openid).digest('hex').slice(0, 32)
    : ''

  // 限流：同用户（或匿名）1 分钟内至多 8 次
  const now = Date.now()
  const rk = uid || `anon:${Math.floor(now / 60000)}`
  const arr = RATE[rk] || []
  while (arr.length && now - arr[0] > 60000) arr.shift()
  if (arr.length >= 8) {
    console.log(TRACE, '⚠限流命中（1 分钟内 ≥8 次），未调 AI 直接返回')
    return ok({
      reply: '你问得有点密，先歇一下～ 也可以直接在「意见反馈」提交工单，管理员看到会回复。',
      need_human: false,
      rate_limited: true,
    })
  }
  arr.push(now)
  RATE[rk] = arr

  const msg = (v.msg || '').trim()
  if (!msg) {
    console.log(TRACE, '⚠空消息，返回欢迎语，未调 AI')
    return ok({ reply: '你好，我是专注座 AI 客服，可以问我预约、签到、违约、通知等问题～', need_human: false })
  }

  // 1) 命中人工关键词 → 直接转人工，不让 AI 乱承诺
  if (needHumanKeywords(msg)) {
    console.log(TRACE, '⚠命中人工关键词，未调 AI 直接转人工')
    return ok({
      reply: '这个问题涉及人工处理，我先帮你标记为「需人工」。可以点下方「联系人工客服」直接对话，或提交「意见反馈」工单，我们会尽快跟进。',
      need_human: true,
      suggest: 'feedback',
    })
  }

  // 2) 组装对话（system + 上下文 3 条 + 当前消息）
  const openRules = await buildOpenRules()
  const sys = await buildSystemPrompt(v.from || 'aiChat', uid, openRules)
  const messages = [{ role: 'system', content: sys }]
  for (const h of (Array.isArray(v.history) ? v.history : []).slice(-3)) {
    if (h && (h.role === 'user' || h.role === 'assistant') && h.content) {
      messages.push({
        role: h.role === 'assistant' ? 'assistant' : 'user',
        content: sanitize(String(h.content).slice(0, 200)),
      })
    }
  }
  messages.push({ role: 'user', content: sanitize(msg) })

  // 3) 调 AI（失败 → 优雅降级）
  const t0 = Date.now()
  // 关键：把「配置有没有到位」在这一刻原地摊开。之前必须翻到 aiClient 里才知道
  // Key 有没有被读到，而这个信息在控制台第一屏就能看吐，白白多花一轮沟通。
  console.log(
    TRACE,
    '▶调AI 开始',
    JSON.stringify({
      hasKey: !!process.env.CODING_PLAN_API_KEY,
      keyLen: String(process.env.CODING_PLAN_API_KEY || '').length,
      model: process.env.CODING_PLAN_MODEL || '(默认)',
      baseUrl: (process.env.CODING_PLAN_BASE_URL || '(默认)').slice(-28),
      node: process.version,
      hasGlobalFetch: typeof fetch === 'function',
      msgChars: messages.reduce((n, m) => n + String((m && m.content) || '').length, 0),
    }),
  )
  try {
    const content = await chatCompletionWithRetry(messages, { timeoutMs: 9000, retries: 1 })
    const reply = String(content || '').trim().slice(0, 200)
    if (!reply) {
      console.log(TRACE, '⚠AI 调用成功但返回空内容（' + (Date.now() - t0) + 'ms）')
      return ok({ reply: '我暂时没想到好答案，建议转人工或提交意见反馈。', need_human: true, suggest: 'faq' })
    }
    console.log(TRACE, '✔AI 返回成功 len=' + reply.length + ' 耗时=' + (Date.now() - t0) + 'ms')
    return ok({ reply: sanitize(reply), need_human: false })
  } catch (err) {
    // 降级必须留痕。此前这里直接 return，不写任何日志，
    // 于是控制台里只看到"成功返回一句走神了"，完全分不清是
    // Key 没配、Key 过期、还是上游限流 —— 排查等于盲人摸象。
    const code = (err && err.code) || 'AI_UNKNOWN'
    // log 与 error 各打一遍：控制台不同视图的过滤口径不一致，
    // 只写 console.error 时，一旦视图过滤掉 error 级别，整段线索就凭空消失。
    console.log(
      TRACE,
      '✘AI 调用失败 耗时=' +
        (Date.now() - t0) +
        'ms code=' + code +
        ' name=' + (err && err.name) +
        ' msg=' + String((err && err.message) || err).slice(0, 300),
    )
    console.error('[aiChat] AI 调用失败', code, (err && err.message) || err)
    if (code === 'AI_NOT_CONFIGURED') {
      console.error(
        '[aiChat] 未读到环境变量 CODING_PLAN_API_KEY。云函数环境变量按函数隔离，' +
          '不会从 aiRecommend 继承，请到「云开发控制台 → 云函数 → aiChat → 配置 → 环境变量」单独配置。',
      )
    }
    return ok({
      reply: fallbackReplyOf(code),
      need_human: true,
      suggest: 'faq',
      // 降级是把「错误码」透出到前端：客服这条链路是「云函数成功返回一句降级文案」，
      // 前端日志干净、云函数日志也是 200 —— 只看这两处永远查不出原因。
      // 把 code 一并返回，前端显示在气泡下方，截图即可定位。
      ai_error_code: code,
    })
  }
}

// 纯函数导出，供单测复用
exports.__test = { FAQ_ITEMS, needHumanKeywords, sanitize, buildSystemPrompt, fallbackReplyOf }