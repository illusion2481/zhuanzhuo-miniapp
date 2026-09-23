/**
 * 统一 event payload 校验（Sprint 0 · F7）
 * -------------------------------------------------
 * 所有云函数通过 validateEvent(event, schema) 获得「干净入参」：
 *   - 白名单：schema 未声明的字段一律剥离（防 NoSQL 注入 / 字段污染）
 *   - 类型校验：string / number / boolean / array<string> / enum / ISO 时间
 *   - 长度限制：字符串按 max 截断；数组按 maxItems 截断、每项按 itemMax 截断
 *   - number 支持数字字符串（与旧代码 Number(x) 行为一致），按 min/max 收敛
 * 返回 { ok: true, value } 或 { ok: false, error }；调用方自行 fail(error)。
 *
 * 与 shared/validator.ts 保持同步。
 */

/** 必填字段检查（保留旧接口，向后兼容） */
function requireFields(payload, fields) {
  for (const field of fields) {
    const value = payload[field]
    if (value === undefined || value === null || value === '') {
      return `缺少必填字段：${field}`
    }
  }
  return null
}

/** 是否为可解析的 ISO 时间字符串 */
function isIsoDate(value) {
  if (typeof value !== 'string') return false
  const t = Date.parse(value)
  return !Number.isNaN(t)
}

/** 数字：有限数字原样通过；纯数字字符串强转（与旧代码 Number(x) 一致） */
function coerceNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

function checkField(name, raw, rule) {
  const type = rule.type

  if (type === 'string' || type === 'enum') {
    if (typeof raw !== 'string') return { ok: false, error: `字段 ${name} 必须为字符串` }
    let s = raw.trim()
    if (rule.max && s.length > rule.max) s = s.slice(0, rule.max)
    if (!rule.optional && s === '') return { ok: false, error: `缺少必填字段：${name}` }
    if (rule.isoDate && s !== '' && !isIsoDate(s)) {
      return { ok: false, error: `字段 ${name} 不是有效时间` }
    }
    if (rule.values && s !== '' && !rule.values.includes(s)) {
      return { ok: false, error: `字段 ${name} 取值无效：${s}` }
    }
    return { ok: true, value: s }
  }

  if (type === 'number') {
    const n = coerceNumber(raw)
    if (n === null) return { ok: false, error: `字段 ${name} 必须为数字` }
    let v = n
    if (rule.min !== undefined && v < rule.min) v = rule.min
    if (rule.max !== undefined && v > rule.max) v = rule.max
    return { ok: true, value: v }
  }

  if (type === 'boolean') {
    if (typeof raw !== 'boolean') return { ok: false, error: `字段 ${name} 必须为布尔值` }
    return { ok: true, value: raw }
  }

  if (type === 'array<string>') {
    if (!Array.isArray(raw)) return { ok: false, error: `字段 ${name} 必须为字符串数组` }
    const items = []
    for (const it of raw.slice(0, rule.maxItems || raw.length)) {
      if (typeof it !== 'string') continue
      let s = it.trim()
      if (!s) continue
      if (rule.itemMax && s.length > rule.itemMax) s = s.slice(0, rule.itemMax)
      items.push(s)
    }
    return { ok: true, value: items }
  }

  if (type === 'array<object>') {
    if (!Array.isArray(raw)) return { ok: false, error: `字段 ${name} 必须为数组` }
    const keys = rule.itemKeys || []
    const items = []
    for (const it of raw.slice(0, rule.maxItems || 50)) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) continue
      const obj = {}
      for (const k of keys) {
        const val = it[k]
        if (typeof val === 'string') {
          if (val) obj[k] = val.slice(0, rule.itemMax || 64)
        } else if (typeof val === 'boolean') {
          obj[k] = val
        } else if (typeof val === 'number' && Number.isFinite(val)) {
          obj[k] = val
        }
      }
      if (Object.keys(obj).length) items.push(obj)
    }
    return { ok: true, value: items }
  }

  return { ok: false, error: `字段 ${name} 的类型规则未知：${type}` }
}

/**
 * 校验 event 入参。schema 形如：
 *   field: { type: 'string'|'number'|'boolean'|'array<string>'|'enum',
 *            optional?: true, default?: any, max?, min?, itemMax?, maxItems?,
 *            values?: string[], isoDate?: true }
 * 结果对象只包含校验通过的字段（不包含 undefined 键）。
 */
function validateEvent(event, schema) {
  const source = event && typeof event === 'object' ? event : {}
  const value = {}
  for (const [name, rule] of Object.entries(schema)) {
    let raw = source[name]
    if (raw === undefined && rule.default !== undefined) raw = rule.default
    if (raw === undefined) {
      if (!rule.optional) return { ok: false, error: `缺少必填字段：${name}` }
      continue
    }
    const checked = checkField(name, raw, rule)
    if (!checked.ok) return { ok: false, error: checked.error }
    value[name] = checked.value
  }
  return { ok: true, value }
}

/**
 * 座位号规范化（F9）：去首尾空格、压缩内部空白、转大写。
 * 用于扫码签到等场景，避免「A 01」与「a01」被误判为不一致。
 */
function normalizeSeatCode(value) {
  return String(value || '').replace(/\s+/g, '').toUpperCase()
}

module.exports = { requireFields, isIsoDate, validateEvent, normalizeSeatCode }
