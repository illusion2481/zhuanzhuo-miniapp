/**
 * 服务端参数校验
 * 与 shared/validator.js 保持同步（运行时以 .js 为准）。
 */

export type FieldRule = {
  type: 'string' | 'number' | 'boolean' | 'array<string>' | 'enum';
  optional?: boolean;
  default?: unknown;
  max?: number;
  min?: number;
  itemMax?: number;
  maxItems?: number;
  values?: string[];
  isoDate?: boolean;
};

export type Schema = Record<string, FieldRule>;

export type ValidateResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/** 必填字段检查（旧接口保留） */
export function requireFields(
  payload: Record<string, unknown>,
  fields: string[],
): string | null {
  for (const field of fields) {
    const value = payload[field];
    if (value === undefined || value === null || value === '') {
      return `缺少必填字段：${field}`;
    }
  }
  return null;
}

export function isIsoDate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const t = Date.parse(value);
  return !Number.isNaN(t);
}

function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function checkField(
  name: string,
  raw: unknown,
  rule: FieldRule,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const type = rule.type;

  if (type === 'string' || type === 'enum') {
    if (typeof raw !== 'string') return { ok: false, error: `字段 ${name} 必须为字符串` };
    let s = raw.trim();
    if (rule.max && s.length > rule.max) s = s.slice(0, rule.max);
    if (!rule.optional && s === '') return { ok: false, error: `缺少必填字段：${name}` };
    if (rule.isoDate && s !== '' && !isIsoDate(s)) {
      return { ok: false, error: `字段 ${name} 不是有效时间` };
    }
    if (rule.values && s !== '' && !rule.values.includes(s)) {
      return { ok: false, error: `字段 ${name} 取值无效：${s}` };
    }
    return { ok: true, value: s };
  }

  if (type === 'number') {
    const n = coerceNumber(raw);
    if (n === null) return { ok: false, error: `字段 ${name} 必须为数字` };
    let v = n;
    if (rule.min !== undefined && v < rule.min) v = rule.min;
    if (rule.max !== undefined && v > rule.max) v = rule.max;
    return { ok: true, value: v };
  }

  if (type === 'boolean') {
    if (typeof raw !== 'boolean') return { ok: false, error: `字段 ${name} 必须为布尔值` };
    return { ok: true, value: raw };
  }

  if (type === 'array<string>') {
    if (!Array.isArray(raw)) return { ok: false, error: `字段 ${name} 必须为字符串数组` };
    const items: string[] = [];
    for (const it of raw.slice(0, rule.maxItems || raw.length)) {
      if (typeof it !== 'string') continue;
      let s = it.trim();
      if (!s) continue;
      if (rule.itemMax && s.length > rule.itemMax) s = s.slice(0, rule.itemMax);
      items.push(s);
    }
    return { ok: true, value: items };
  }

  return { ok: false, error: `字段 ${name} 的类型规则未知：${type}` };
}

/** 校验 event 入参（白名单 + 类型 + 长度），结果只含校验通过的字段 */
export function validateEvent(event: unknown, schema: Schema): ValidateResult {
  const source: Record<string, unknown> =
    event && typeof event === 'object' ? (event as Record<string, unknown>) : {};
  const value: Record<string, unknown> = {};
  for (const [name, rule] of Object.entries(schema)) {
    let raw: unknown = source[name];
    if (raw === undefined && rule.default !== undefined) raw = rule.default;
    if (raw === undefined) {
      if (!rule.optional) return { ok: false, error: `缺少必填字段：${name}` };
      continue;
    }
    const checked = checkField(name, raw, rule);
    if (!checked.ok) return { ok: false, error: checked.error };
    value[name] = checked.value;
  }
  return { ok: true, value };
}

/** 座位号规范化：去空白 + 转大写（与 validator.js 同步） */
export function normalizeSeatCode(value: unknown): string {
  return String(value || '').replace(/\s+/g, '').toUpperCase();
}
