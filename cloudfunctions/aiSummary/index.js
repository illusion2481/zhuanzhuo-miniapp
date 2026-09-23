const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const { chatCompletionWithRetry } = require('./shared/aiClient')
const { validateEvent } = require('./shared/validator')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

/** 入参白名单（F7） */
const SCHEMA = {
  record_ids: { type: 'array<string>', maxItems: 50, itemMax: 128, optional: true },
  since: { type: 'string', isoDate: true, optional: true },
  until: { type: 'string', isoDate: true, optional: true },
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

function computeActiveSec(record, nowMs) {
  const startMs = new Date(record.start_at || record.created_at).getTime()
  const endMs = record.end_at ? new Date(record.end_at).getTime() : nowMs
  let seconds = Math.max(0, endMs - startMs) / 1000
  const segments = (record.payload && Array.isArray(record.payload.pause_segments)) ? record.payload.pause_segments : []
  for (const seg of segments) {
    if (!seg || !seg.start) continue
    const segStart = new Date(seg.start).getTime()
    const segEnd = seg.end ? new Date(seg.end).getTime() : nowMs
    seconds -= Math.max(0, segEnd - segStart) / 1000
  }
  return Math.max(0, Math.floor(seconds))
}

async function fetchOwnedRecords(userId, opts) {
  const where = { user_id: userId, record_type: 'study' }
  if (Array.isArray(opts.record_ids) && opts.record_ids.length) {
    where._id = _.in(opts.record_ids.slice(0, 50))
  } else {
    if (opts.since) where.created_at = _.gte(opts.since)
    if (opts.until) {
      where.created_at = where.created_at || {}
      where.created_at = _.and(_.gte(opts.since || '1970-01-01T00:00:00.000Z'), _.lte(opts.until))
    }
  }
  const res = await db.collection('records').where(where).orderBy('created_at', 'desc').limit(50).get()
  return res.data || []
}

function buildStats(records, nowMs) {
  const goalMap = new Map()
  let totalSec = 0
  let completedCount = 0
  let abandonedCount = 0
  let activeCount = 0
  let pomodoroTotal = 0
  for (const r of records) {
    const sec = (r.payload && r.payload.actual_duration_sec) || (r.status === 'running' ? computeActiveSec(r, nowMs) : 0)
    totalSec += sec
    if (r.status === 'completed') {
      completedCount += 1
      pomodoroTotal += (r.payload && r.payload.pomodoro_count) || 0
    } else if (r.status === 'abandoned') {
      abandonedCount += 1
    } else if (r.status === 'running') {
      activeCount += 1
    }
    const goal = (r.payload && r.payload.goal) || '（未命名）'
    goalMap.set(goal, (goalMap.get(goal) || 0) + sec)
  }
  const goalSummary = Array.from(goalMap.entries())
    .map(([goal, seconds]) => ({ goal, minutes: Math.floor(seconds / 60) }))
    .filter((g) => g.minutes > 0)
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, 5)
  return {
    total_sessions: records.length,
    completed_sessions: completedCount,
    abandoned_sessions: abandonedCount,
    active_sessions: activeCount,
    total_minutes: Math.floor(totalSec / 60),
    pomodoros: pomodoroTotal,
    goal_summary: goalSummary,
  }
}

function buildMessages(stats, since, nowIso) {
  const system = '你是「专注座」学习总结助手，请根据用户学习数据生成温暖、具体、可执行的学习总结与建议。返回严格 JSON，无 Markdown 包裹。'
  const user = [
    `时间段：${since || '最近'} 至 ${nowIso}`,
    `总学习分钟：${stats.total_minutes} 分钟（完成 ${stats.completed_sessions} 次，结束 ${stats.abandoned_sessions} 次，进行中 ${stats.active_sessions} 次）`,
    `番茄数：${stats.pomodoros}`,
    '目标分布（分钟）：',
    ...stats.goal_summary.map((g) => `  - ${g.goal}: ${g.minutes} 分钟`),
    '请输出 JSON：{"summary":"≤120字总结","suggestions":["≤40字建议", "≤40字建议", "≤40字建议"]}',
  ].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

function buildFallbackSummary(stats) {
  const total = stats.total_minutes
  const sessions = stats.completed_sessions
  const pomodoros = stats.pomodoros
  const top = stats.goal_summary[0]
  const lines = [`这段时间共完成 ${sessions} 次专注，累计 ${total} 分钟（${pomodoros} 个番茄）。`]
  if (top) lines.push(`主要投入在「${top.goal}」，时长约 ${top.minutes} 分钟。`)
  const suggestions = []
  if (pomodoros >= 4) suggestions.push('保持当前节奏，注意间歇休息与补水。')
  else if (sessions === 0) suggestions.push('可尝试先完成一个 25 分钟番茄，再调整计划。')
  else suggestions.push('尝试把目标拆成 25 分钟一轮的番茄节奏。')
  if (stats.abandoned_sessions > stats.completed_sessions) suggestions.push('被中断的次数偏多，可在前置环节屏蔽社交通知。')
  suggestions.push('下次专注前可先在「专注座」记录一个明确目标。')
  return {
    summary: lines.join(''),
    suggestions: suggestions.slice(0, 3),
  }
}

function extractJson(content) {
  if (!content) return null
  const trimmed = String(content).trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/i)
  const candidate = fenced ? fenced[1].trim() : trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end < 0 || end <= start) return null
  try { return JSON.parse(candidate.slice(start, end + 1)) } catch (e) { return null }
}

exports.main = async (event) => {
  try {
    const check = validateEvent(event, SCHEMA)
    if (!check.ok) return fail(check.error)
    const v = check.value
    const userId = getUserId()
    if (!userId) return fail('无法获取用户身份，请重新登录')

    const now = new Date()
    const nowIso = now.toISOString()
    const nowMs = now.getTime()

    const records = await fetchOwnedRecords(userId, {
      record_ids: v.record_ids,
      since: v.since,
      until: v.until,
    })

    if (!records.length) {
      return ok({
        source: 'fallback',
        stats: buildStats([], nowMs),
        summary: '暂无学习记录，完成首次专注后再来查看总结。',
        suggestions: ['前往「学习」页面开启第一个专注番茄。'],
        fallback_reason: 'NO_RECORDS',
      }, '暂无数据')
    }

    const stats = buildStats(records, nowMs)

    try {
      const messages = buildMessages(stats, v.since || '本周期开始', nowIso)
      const content = await chatCompletionWithRetry(messages, { timeoutMs: 12000, retries: 1 })
      const parsed = extractJson(content)
      if (parsed && typeof parsed.summary === 'string' && Array.isArray(parsed.suggestions)) {
        return ok({
          source: 'ai',
          stats,
          summary: safeStr(parsed.summary, 240),
          suggestions: parsed.suggestions.slice(0, 4).map((s) => safeStr(String(s), 80)).filter(Boolean),
        }, '总结生成成功')
      }
      console.error('[aiSummary] AI 返回无法解析，原文片段:', String(content || '').slice(0, 300))
      const fb = buildFallbackSummary(stats)
      return ok({ source: 'fallback', stats, summary: fb.summary, suggestions: fb.suggestions, fallback_reason: 'AI_PARSE_FAIL' }, '已使用基础总结')
    } catch (err) {
      console.error('[aiSummary] AI 调用失败', err && err.code, (err && err.message) || err)
      const fb = buildFallbackSummary(stats)
      return ok({
        source: 'fallback',
        stats,
        summary: fb.summary,
        suggestions: fb.suggestions,
        fallback_reason: (err && err.message) || 'AI 调用失败',
        fallback_code: err && err.code,
      }, err && err.code === 'AI_NOT_CONFIGURED' ? 'AI 未配置，使用基础总结' : 'AI 失败已自动降级')
    }
  } catch (err) {
    return fail((err && err.message) || '云函数执行失败')
  }
}
