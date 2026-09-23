/**
 * 番茄钟引擎（纯函数）
 *
 * 设计要点：小程序切后台后 setInterval 会被冻结/降频，所以**不能靠计时器累计**。
 * 这里统一采用「时间戳惰性结算」：任意时刻拿 (开始时间, 已有段落, 配置, 当前时间)
 * 就能推算出此刻应该处于哪个阶段，切后台再回来也能自动补齐漏掉的段落。
 */

export type PomodoroPhase = 'focus' | 'break';

export interface PomodoroSegment {
  type: PomodoroPhase;
  /** 段落开始时间（ISO）；首段取自学习记录 start_at */
  start: string;
  /** 段落结束时间（ISO）；缺失表示进行中 */
  end?: string;
  completed?: boolean;
}

export interface PomodoroConfig {
  focus_min: number;
  break_min: number;
}

export const DEFAULT_FOCUS_MIN = 25;
export const DEFAULT_BREAK_MIN = 5;
export const MIN_PHASE_MIN = 1;
export const MAX_FOCUS_MIN = 180;
export const MAX_BREAK_MIN = 60;
export const POMODORO_CONFIG_KEY = 'study_pomodoro_config';

/** 一次惰性结算最多补多少段，防止超长后台时间导致死循环 */
const MAX_CATCHUP = 300;

export function normalizeConfig(raw: Partial<PomodoroConfig> | null | undefined): PomodoroConfig {
  const focus = clampPhase(raw && raw.focus_min, DEFAULT_FOCUS_MIN, MIN_PHASE_MIN, MAX_FOCUS_MIN);
  const rest = clampPhase(raw && raw.break_min, DEFAULT_BREAK_MIN, MIN_PHASE_MIN, MAX_BREAK_MIN);
  return { focus_min: focus, break_min: rest };
}

function clampPhase(input: unknown, fallback: number, min: number, max: number): number {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

/** 从学习记录 payload 里读取番茄配置（旧记录没有时回退默认） */
export function configFromPayload(payload: Record<string, unknown> | null | undefined): PomodoroConfig {
  if (!payload) return normalizeConfig(null);
  return normalizeConfig({
    focus_min: payload.focus_min as number,
    break_min: payload.break_min as number,
  });
}

/** 已完成专注段的数量 = 真实番茄数（放宽入参，便于直接吃云端 payload 里的宽类型数组） */
export function deriveCount(
  segments: ReadonlyArray<{ type?: string; completed?: boolean }> | null | undefined,
): number {
  if (!Array.isArray(segments)) return 0;
  return segments.filter((s) => s && s.type === 'focus' && s.completed).length;
}

function phaseLengthMs(type: PomodoroPhase, config: PomodoroConfig): number {
  return (type === 'focus' ? config.focus_min : config.break_min) * 60000;
}

export interface CatchUpResult {
  segments: PomodoroSegment[];
  /** 本次结算是否产生了变化（用于决定是否上报云端） */
  changed: boolean;
  /** 本次结算刚走完的专注段数（用于到点提醒文案） */
  focusDone: number;
  /** 刚走完的休息段数 */
  breakDone: number;
}

/**
 * 惰性结算：把到期段落依次结算，并自动开启下一段，直到当前段尚未到期。
 * @param startMs  学习开始时间毫秒（segments 为空时用它生成首段）
 */
export function applyPhaseCatchUp(
  startMs: number,
  segments: PomodoroSegment[] | null | undefined,
  config: PomodoroConfig,
  nowMs: number,
): CatchUpResult {
  const list: PomodoroSegment[] = Array.isArray(segments)
    ? segments.filter((s) => s && s.start).map((s) => ({ ...s }))
    : [];
  let changed = false;
  let focusDone = 0;
  let breakDone = 0;

  if (!list.length) {
    if (!Number.isFinite(startMs)) return { segments: list, changed: false, focusDone: 0, breakDone: 0 };
    list.push({ type: 'focus', start: new Date(startMs).toISOString(), completed: false });
    changed = true;
  }

  for (let i = 0; i < MAX_CATCHUP; i += 1) {
    const last = list[list.length - 1];
    if (!last || last.completed) break;
    const beganMs = new Date(last.start).getTime();
    if (!Number.isFinite(beganMs)) break;
    const span = phaseLengthMs(last.type, config);
    if (nowMs - beganMs < span) break;

    const endMs = beganMs + span;
    last.end = new Date(endMs).toISOString();
    last.completed = true;
    changed = true;
    if (last.type === 'focus') focusDone += 1;
    else breakDone += 1;

    // 自动开启下一段（休息结束接着专注，专注结束进入休息）
    if (list.length < MAX_CATCHUP) {
      list.push({
        type: last.type === 'focus' ? 'break' : 'focus',
        start: last.end,
        completed: false,
      });
    }
  }

  return { segments: list, changed, focusDone, breakDone };
}

export interface PhaseView {
  type: PomodoroPhase;
  /** 本段已进行毫秒 */
  elapsedMs: number;
  /** 本段总长毫秒 */
  totalMs: number;
  /** 剩余毫秒（>=0） */
  remainMs: number;
  /** 进度 0~1 */
  progress: number;
}

/** 当前阶段的可视化数据；无有效时段返回 null */
export function currentPhase(
  segments: PomodoroSegment[] | null | undefined,
  config: PomodoroConfig,
  nowMs: number,
): PhaseView | null {
  if (!Array.isArray(segments) || !segments.length) return null;
  const last = segments[segments.length - 1];
  if (!last || last.completed || !last.start) return null;
  const beganMs = new Date(last.start).getTime();
  if (!Number.isFinite(beganMs)) return null;
  const totalMs = phaseLengthMs(last.type, config);
  const elapsedMs = Math.max(0, Math.min(totalMs, nowMs - beganMs));
  return {
    type: last.type,
    elapsedMs,
    totalMs,
    remainMs: Math.max(0, totalMs - elapsedMs),
    progress: totalMs > 0 ? elapsedMs / totalMs : 0,
  };
}

/** 剩余时间格式化 mm:ss */
export function formatRemain(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${pad(m)}:${pad(s)}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 本地配置持久化 */
export function loadConfig(): PomodoroConfig {
  try {
    const raw = wx.getStorageSync(POMODORO_CONFIG_KEY) as Partial<PomodoroConfig> | '';
    if (!raw) return normalizeConfig(null);
    return normalizeConfig(raw);
  } catch {
    return normalizeConfig(null);
  }
}

export function saveConfig(config: PomodoroConfig): PomodoroConfig {
  const next = normalizeConfig(config);
  try {
    wx.setStorageSync(POMODORO_CONFIG_KEY, next);
  } catch {
    /* 存储失败不影响本次使用 */
  }
  return next;
}
