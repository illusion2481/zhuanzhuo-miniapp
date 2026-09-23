const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { chatCompletionWithRetry } = require('./shared/aiClient')
const { validateEvent } = require('./shared/validator')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

/** 入参白名单（F7） */
const SCHEMA = {
  action: {
    type: 'enum',
    values: ['recommend', 'generate_plan', 'recommend_courses'],
    optional: true,
    default: 'recommend',
  },
  goal: { type: 'string', max: 200, optional: true },
  durationMinutes: { type: 'number', min: 1, optional: true },
  preferences: { type: 'array<string>', maxItems: 6, itemMax: 64, optional: true },
  // 前端已获得的课程推荐（供 AI 按课程设计每个时段的学习方式）；不传由云端兜底自取
  courses: {
    type: 'array<object>',
    maxItems: 3,
    optional: true,
    itemFields: { title: 20, reason: 60, level: 8 },
    itemArrayFields: { tags: 3 },
  },
}

function ok(data, message = '操作成功') {
  return { success: true, data, message, request_id: 'req_' + Date.now() }
}
function fail(message, data = null) {
  return { success: false, data, message, request_id: 'req_' + Date.now() }
}

function getUserId() {
  const openId = cloud.getWXContext().OPENID
  if (!openId) return null
  return crypto.createHash('sha256').update(openId).digest('hex').slice(0, 32)
}

function safeStr(v, max) {
  if (typeof v !== 'string') return ''
  return v.length > max ? v.slice(0, max) : v
}

async function listActiveCategories(type) {
  const res = await db.collection('categories').where({ type, status: 'active' }).orderBy('sort', 'asc').limit(100).get()
  return (res.data || []).filter(Boolean)
}

async function listRoomsFromCategories() {
  const rooms = await listActiveCategories('room')
  const nowIso = new Date().toISOString()
  // 实时占用：与 roomList 同口径 —— 待签到/使用中/暂离 且在时段内视为占用，
  // 否则 AI 会把「已被别人约走」的座位推给用户。
  // ⚠️ 不做 15/30 分钟超时剔除：推荐只要求当下真实性，边界几秒差异可忽略。
  const occupyRes = await db
    .collection('records')
    .where({
      record_type: 'reservation',
      status: _.in(['pending_checkin', 'active', 'paused']),
      start_at: _.lt(nowIso),
      end_at: _.gt(nowIso),
    })
    .limit(1000)
    .get()
    .catch(() => ({ data: [] }))
  const occupied = new Set(
    (occupyRes.data || []).map((r) => `${r.room_id}:${r.seat_id}`),
  )

  // 评价回流：按 房间:座位 聚合历史评分（平均分 + 条数），喂给 AI 作为「人气/口碑」信号。
  // 聚合失败不阻断推荐（评价是增强信号，不是必需数据）。
  let reviewAgg = {}
  try {
    const revRes = await db.collection('reviews').limit(2000).get()
    for (const r of revRes.data || []) {
      if (!r || !r.room_id || !r.seat_id) continue
      const key = `${r.room_id}:${r.seat_id}`
      const g = reviewAgg[key] || { sum: 0, count: 0, score: 0 }
      g.sum += Number(r.rating) || 0
      g.count += 1
      g.score = g.count ? Math.round((g.sum / g.count) * 10) / 10 : 0
      reviewAgg[key] = g
    }
  } catch (e) {
    // 评价集合不可用 → 不参与加权
  }

  return rooms.map((r) => ({
    _id: r._id,
    name: r.name,
    description: r.description,
    building: r.metadata && r.metadata.building,
    floor: r.metadata && r.metadata.floor,
    open_time: r.metadata && r.metadata.open_time,
    close_time: r.metadata && r.metadata.close_time,
    seats: Array.isArray(r.metadata && r.metadata.seats) ? r.metadata.seats.map((s) => {
      const agg = reviewAgg[`${r._id}:${s.seat_id}`] || { score: 0, count: 0 }
      return {
        seat_id: s.seat_id,
        row: s.row,
        col: s.col,
        features: s.features || [],
        status: s.status || 'free',
        // 真实可用性：维护中 或 当前有进行中预约 → 不可推荐
        _free: s.status !== 'maintain' && !occupied.has(`${r._id}:${s.seat_id}`),
        // 评价回流：平均分 + 评价条数（0/0 表示尚未有人评价）
        rating: agg.score,
        review_count: agg.count,
      }
    }) : [],
  }))
}

async function listSeatFeatures() {
  const list = await listActiveCategories('seat_feature')
  return list.map((c) => ({ code: c.code, name: c.name }))
}

async function listStudyGoals() {
  const list = await listActiveCategories('study_goal')
  return list.map((c) => ({ code: c.code, name: c.name }))
}

function buildPrompt({ goal, durationMinutes, preferences, goals, rooms, features }) {
  const system = '你是「专注座」自习室推荐助手，根据用户学习目标与偏好，从给定的房间座位列表中挑选最适合的 3 个候选项，并给出简短理由。返回严格 JSON，不要任何解释性文字或 Markdown 代码块。'
  const userLines = [
    `用户目标：${goal || '（未填写）'}`,
    `计划时长：${durationMinutes || 120} 分钟`,
    `用户偏好：${(preferences && preferences.length) ? preferences.join('、') : '（无）'}`,
    `学习目标分类：${goals.map((g) => `${g.code}=${g.name}`).join('；')}`,
    `座位属性：${features.map((f) => `${f.code}=${f.name}`).join('；')}`,
    '可选房间与座位：',
  ]
  for (const r of rooms) {
    userLines.push(`- ${r._id} ${r.name}（${r.building || ''} ${r.floor || ''}楼，开放 ${r.open_time || ''}-${r.close_time || ''}）`)
    const free = r.seats.filter((s) => s._free)
    userLines.push(`  空闲座位：${free.map((s) => `${s.seat_id}[${(s.features || []).join('/')}]${s.review_count ? ` 口碑${s.rating}分(${s.review_count}评)` : ''}`).join('、')}`)
    if (free.length === 0) userLines.push('  当前无空闲座位')
  }
  userLines.push('输出 JSON 格式：{"picks":[{"room_id":"…","seat_id":"…","reason":"≤30字"}],"note":"≤80字整体说明"}')
  const user = userLines.join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

function extractJsonFromContent(content) {
  if (!content) return null
  const trimmed = String(content).trim()
  // 去掉 ```json 包裹
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i)
  const candidate = fenced ? fenced[1].trim() : trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end < 0 || end <= start) return null
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch (e) {
    return null
  }
}

function fallbackRecommendations({ preferences, durationMinutes, rooms }) {
  const list = []
  for (const r of rooms) {
    const free = (r.seats || []).filter((s) => s._free)
    for (const s of free) {
      const match = (s.features || []).filter((f) => preferences.includes(f)).length
      const haveAll = preferences.length > 0 && preferences.every((p) => (s.features || []).includes(p))
      // 评价回流加权：口碑 ≥4.5 且 ≥3 人评价 → 显著加分（经多人验证的高分座位优先）
      const ratingBonus = s.review_count >= 3 && s.rating >= 4.5 ? 6 : s.review_count >= 1 ? 2 : 0
      list.push({
        room_id: r._id,
        room_name: r.name,
        seat_id: s.seat_id,
        features: s.features || [],
        score: match * 10 + (haveAll ? 5 : 0) + (s.features && s.features.includes('power') ? 1 : 0) + ratingBonus,
        reason: haveAll
          ? '同时满足所有座位偏好'
          : (match > 0 ? `匹配 ${match} 项座位偏好` : '当前可用座位'),
      })
    }
  }
  list.sort((a, b) => b.score - a.score || a.seat_id.localeCompare(b.seat_id))
  const top = list.slice(0, 3)
  return {
    picks: top,
    note: top.length
      ? `已按 ${preferences.length || 0} 项偏好匹配度排序（前 ${top.length} 项）`
      : '暂无可推荐座位，可调整偏好后重试',
  }
}

function buildPlanPrompt({ goal, durationMinutes, preferences, goals, courseInfo }) {
  const system = '你是「专注座」学习计划助手，根据用户学习目标与总时长，把一次自习拆成 2~4 个番茄时段（每段 20~30 分钟）。'
    + '每个时段必须：title 写清「本段具体学习任务」（可引用下面推荐的课程），tip 写清「本段采用的学习方式」（如跟着课程做例题、背单词用卡片记忆、笔记复盘）。'
    + '禁止使用「热身」「保持专注」「冲刺」这类空洞文案。返回严格 JSON，不要任何解释性文字或 Markdown 代码块。'
  const userLines = [
    `用户目标：${goal || '（未填写）'}`,
    `计划总时长：${durationMinutes || 120} 分钟`,
    `偏好：${(preferences && preferences.length) ? preferences.join('、') : '（无）'}`,
    `可选学习目标分类：${goals.map((g) => `${g.code}=${g.name}`).join('；')}`,
    `已为本次自习推荐课程（每个时段请尽量紧扣其中一门来安排学习方式）：${courseInfo || '（暂无，按目标自行安排）'}`,
    '输出 JSON 格式：{"blocks":[{"title":"本段任务 ≤20字","duration_min":25,"tip":"本段学习方式 ≤40字"}],"summary":"≤80字整体鼓励"}',
  ]
  return [
    { role: 'system', content: system },
    { role: 'user', content: userLines.join('\n') },
  ]
}

function fallbackPlan({ durationMinutes, goal }) {
  const total = Math.max(30, Math.min(240, durationMinutes || 120))
  const seg = 25
  const blocks = []
  let remaining = total
  let i = 1
  while (remaining > 0) {
    const dur = Math.min(seg, remaining)
    if (dur < 10) break
    blocks.push({
      title: `${goal || '专注'} · 第${i}段`,
      duration_min: dur,
      tip: i === 1 ? '热身进入状态' : i === blocks.length + 1 ? '冲刺收尾' : '保持专注',
    })
    remaining -= dur
    i += 1
  }
  return {
    blocks,
    summary: `已按 ${total} 分钟自动拆分为 ${blocks.length} 个 ${seg} 分钟番茄段，开始第 1 段。`,
  }
}

/** 课程推荐关键词库（本地兜底与 Prompt 提示共用）：主题 → 适合人群/场景 */
const COURSE_KEYWORDS = {
  '高数': '高等数学 · 刷题与概念梳理',
  '线代': '线性代数 · 公式推导',
  '概率': '概率论与数理统计',
  '英语': '英语四六级 / 考研英语阅读',
  '考研': '考研全科 · 政治数学英语',
  '期末': '期末冲刺 · 各科突击',
  '编程': '编程语言 / 数据结构与算法',
  '代码': '编程实践 · 刷题',
  '算法': '算法竞赛 / 数据结构',
  '论文': '毕业论文 · 文献阅读',
  '写作': '写作 · 文书',
  '复习': '考前复习 · 知识点串讲',
  '预习': '课前预习 · 概念导入',
  '专业课': '专业课 · 考点梳理',
}

function guessCourseTopics(goal) {
  const g = String(goal || '')
  const hits = Object.keys(COURSE_KEYWORDS)
    .filter((k) => k !== ' ' && g.indexOf(k) !== -1)
    .map((k) => COURSE_KEYWORDS[k])
  return hits.length ? hits.slice(0, 3) : ['高效自习 · 通用提升']
}

function buildCoursesPrompt({ goal, durationMinutes, preferences, goals }) {
  const system =
    '你是「专注座」的学习 AI 助手。根据用户学习目标推荐 2~3 门**最匹配的课程/学习主题**，要求有针对性、有营养。返回严格 JSON，不要任何解释性文字或 Markdown 代码块。'
  const userLines = [
    `用户学习目标：${goal || '（未填写）'}`,
    `计划时长：${durationMinutes || 120} 分钟`,
    `偏好：${(preferences && preferences.length) ? preferences.join('、') : '（无）'}`,
    `可选学习目标分类：${goals.map((g) => `${g.code}=${g.name}`).join('；')}`,
    '输出 JSON 格式：{"courses":[{"title":"课程主题 ≤16 字","reason":"为什么适合，≤40 字","level":"入门/进阶","tags":["≤3 个标签"]}],"note":"总建议 ≤60 字"}',
  ]
  return [
    { role: 'system', content: system },
    { role: 'user', content: userLines.join('\n') },
  ]
}

function fallbackCourses({ goal, preferences }) {
  const topics = guessCourseTopics(goal)
  const prefs = preferences || []
  const prefsZh = prefs.length ? prefs.map((p) => (p === 'quiet' ? '安静环境' : p)).join('、') : '无特定偏好'
  const courses = topics.map((t, i) => ({
    title: t.length > 16 ? t.slice(0, 16) : t,
    reason: i === 0 ? '最贴近你的目标，建议优先投入' : '与目标相关，可作为补充提升',
    level: i === 0 ? '入门' : '进阶',
    tags: [t.length > 4 ? t.slice(0, 4) : t, prefsZh],
  }))
  return {
    source: 'fallback',
    courses,
    topic: `围绕「${goal || '高效学习'}」精选 ${courses.length} 门课程，先从最贴近的一件事开始。`,
    fallback_reason: 'AI 未配置或调用失败，已使用本地精选',
  }
}

async function recommendCourses(v) {
  const goal = v.goal || ''
  const durationMinutes = Math.max(30, Math.min(6 * 60, Number(v.durationMinutes) || 120))
  const preferences = v.preferences || []
  const [goals] = await Promise.all([listStudyGoals()])
  try {
    const messages = buildCoursesPrompt({ goal, durationMinutes, preferences, goals })
    const content = await chatCompletionWithRetry(messages, { timeoutMs: 12000, retries: 1 })
    const parsed = extractJsonFromContent(content)
    if (parsed && Array.isArray(parsed.courses) && parsed.courses.length) {
      const courses = parsed.courses.slice(0, 3)
        .map((c) => ({
          title: safeStr(c.title, 20),
          reason: safeStr(c.reason, 60),
          level: safeStr(c.level, 8) || '入门',
          tags: Array.isArray(c.tags) ? c.tags.slice(0, 3).map((t) => safeStr(t, 12)) : [],
        }))
        .filter((c) => c.title)
      if (courses.length) {
        return ok(
          {
            source: 'ai',
            courses,
            topic: safeStr(parsed.topic, 80) || `围绕「${goal || '学习提升'}」的推荐课程`,
          },
          '课程推荐成功',
        )
      }
    }
    console.error('[aiRecommend:recommendCourses] AI 返回无法解析，原文片段:', String(content || '').slice(0, 300))
    const fb = fallbackCourses({ goal, preferences })
    return ok({ ...fb, note: 'AI 返回无法解析，已使用本地精选', fallback_code: 'AI_PARSE_FAIL' }, '已使用本地课程')
  } catch (err) {
    console.error('[aiRecommend:recommendCourses] AI 调用失败', err && err.code, (err && err.message) || err)
    const fb = fallbackCourses({ goal, preferences })
    return ok({
      ...fb,
      fallback_reason: (err && err.message) || 'AI 调用失败',
      fallback_code: err && err.code,
    }, err && err.code === 'AI_NOT_CONFIGURED' ? 'AI 未配置，使用本地课程' : 'AI 失败已自动降级')
  }
}

async function generatePlan(v) {
  const goal = v.goal || ''
  const durationMinutes = Math.max(30, Math.min(6 * 60, Number(v.durationMinutes) || 120))
  const preferences = v.preferences || []
  const suppliedCourses = Array.isArray(v.courses) && v.courses.length ? v.courses : null
  const [goals] = await Promise.all([listStudyGoals()])
  // 优先复用前端已获得的课程推荐（避免重复调用课程 AI 消耗限次）；
  // 前端没传才在云端兜底取一次，失败静默降级，不影响计划生成
  let courseInfo = ''
  if (suppliedCourses) {
    courseInfo = suppliedCourses
      .map((c, i) => `${i + 1}.《${safeStr(c.title, 20)}》——${safeStr(c.reason, 60)}（${safeStr(c.level, 8) || '入门'}）`)
      .join('；')
  } else {
    try {
      const coursesRes = await recommendCourses(v)
      const courses = (coursesRes && coursesRes.data && coursesRes.data.courses) || []
      if (courses.length) {
        courseInfo = courses.map((c, i) => `${i + 1}.《${c.title}》——${c.reason}（${c.level}）`).join('；')
      }
    } catch {
      courseInfo = ''
    }
  }
  try {
    const messages = buildPlanPrompt({ goal, durationMinutes, preferences, goals, courseInfo })
    const content = await chatCompletionWithRetry(messages, { timeoutMs: 12000, retries: 1 })
    const parsed = extractJsonFromContent(content)
    if (parsed && Array.isArray(parsed.blocks) && parsed.blocks.length) {
      const blocks = parsed.blocks.slice(0, 4).map((b) => ({
        title: safeStr(b.title, 30) || '专注一段',
        duration_min: Math.max(5, Math.min(60, Number(b.duration_min) || 25)),
        tip: safeStr(b.tip, 80),
      })).filter((b) => b.duration_min >= 5)
      if (blocks.length) {
        return ok({
          source: 'ai',
          blocks,
          courses: suppliedCourses || coursesFromInfo(courseInfo),
          summary: safeStr(parsed.summary, 200) || 'AI 已为你拆好今晚的学习节奏',
        }, 'AI 计划生成成功')
      }
    }
    console.error('[aiRecommend:generatePlan] AI 返回无法解析，原文片段:', String(content || '').slice(0, 300))
    const fb = fallbackPlan({ durationMinutes, goal })
    return ok({ source: 'fallback', ...fb, courses: [], note: 'AI 返回无法解析，已使用基础节奏', fallback_code: 'AI_PARSE_FAIL' }, '已使用基础计划')
  } catch (err) {
    console.error('[aiRecommend:generatePlan] AI 调用失败', err && err.code, (err && err.message) || err)
    const fb = fallbackPlan({ durationMinutes, goal })
    return ok({
      source: 'fallback',
      ...fb,
      courses: [],
      fallback_reason: (err && err.message) || 'AI 调用失败',
      fallback_code: err && err.code,
    }, err && err.code === 'AI_NOT_CONFIGURED' ? 'AI 未配置，使用基础计划' : 'AI 失败已自动降级')
  }
}

/** 把 courseInfo 描述串还原为课程数组（供前端复用课程区） */
function coursesFromInfo(info) {
  if (!info) return []
  const re = /\d+\.《([^》]+)》——([^（]+)（([^）]+)）/g
  const out = []
  let m
  while ((m = re.exec(info))) {
    out.push({ title: m[1], reason: m[2].trim(), level: m[3] || '入门', tags: [] })
  }
  return out
}

exports.main = async (event) => {
  try {
    const check = validateEvent(event, SCHEMA)
    if (!check.ok) return fail(check.error)
    const v = check.value
    const action = v.action || 'recommend'
    if (action === 'generate_plan') {
      const userId = getUserId()
      if (!userId) return fail('无法获取用户身份，请重新登录')
      return await generatePlan(v)
    }
    if (action === 'recommend_courses') {
      const userId = getUserId()
      if (!userId) return fail('无法获取用户身份，请重新登录')
      return await recommendCourses(v)
    }
    const userId = getUserId()
    if (!userId) return fail('无法获取用户身份，请重新登录')

    const goal = v.goal || ''
    const durationMinutes = Math.max(15, Math.min(8 * 60, Number(v.durationMinutes) || 120))
    const preferences = v.preferences || []

    const [rooms, features, goals] = await Promise.all([
      listRoomsFromCategories(),
      listSeatFeatures(),
      listStudyGoals(),
    ])

    if (rooms.length === 0) {
      return ok({ source: 'fallback', picks: [], note: '当前系统暂无自习室数据' }, '无可推荐资源')
    }

    try {
      const messages = buildPrompt({ goal, durationMinutes, preferences, goals, rooms, features })
      const content = await chatCompletionWithRetry(messages, { timeoutMs: 12000, retries: 1 })
      const parsed = extractJsonFromContent(content)
      if (parsed && Array.isArray(parsed.picks) && parsed.picks.length) {
        const flat = []
        for (const p of parsed.picks.slice(0, 3)) {
          if (!p || typeof p.room_id !== 'string' || typeof p.seat_id !== 'string') continue
          const room = rooms.find((r) => r._id === p.room_id)
          const seat = room && room.seats.find((s) => s.seat_id === p.seat_id && s._free)
          if (!seat) continue
          flat.push({
            room_id: room._id,
            room_name: room.name,
            seat_id: seat.seat_id,
            features: seat.features || [],
            reason: safeStr(p.reason, 80) || 'AI 推荐',
          })
        }
        if (flat.length) {
          return ok({
            source: 'ai',
            picks: flat,
            note: safeStr(parsed.note, 200) || 'AI 已根据你的目标与偏好完成推荐',
          }, 'AI 推荐成功')
        }
      }
      // AI 返回但解析失败 → 兜底
      const fb = fallbackRecommendations({ preferences, durationMinutes, rooms })
      return ok({ source: 'fallback', picks: fb.picks, note: 'AI 返回无法解析，已切换为基础推荐' }, '已使用基础推荐')
    } catch (err) {
      console.error('[aiRecommend:recommend] AI 调用失败', err && err.code, (err && err.message) || err)
      const fallback = fallbackRecommendations({ preferences, durationMinutes, rooms })
      return ok({
        source: 'fallback',
        picks: fallback.picks,
        note: fallback.note,
        fallback_reason: (err && err.message) || 'AI 调用失败',
        fallback_code: err && err.code,
      }, err && err.code === 'AI_NOT_CONFIGURED' ? 'AI 未配置，使用基础推荐' : 'AI 失败已自动降级')
    }
  } catch (err) {
    return fail((err && err.message) || '云函数执行失败')
  }
}
