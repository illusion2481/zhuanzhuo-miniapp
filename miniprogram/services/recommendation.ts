import { callCloud } from './cloud';

/** AI 推荐与学习总结 — Phase 6 实写 */

/** 云函数返回结构（与 callCloud 约定一致） */
type CloudResp<T> = { success?: boolean; data?: T; message?: string };

/**
 * 统一处理 AI 类云函数返回：
 * 当「AI 未配置」导致失败时，抛出带 code='AI_NOT_CONFIGURED' 的错误，
 * 便于页面层优雅降级（展示占位文案而非通用报错）。
 */
function unwrapAi<T>(res: CloudResp<T>, fallbackMsg: string): T {
  if (!res.success || !res.data) {
    const msg = String(res.message || fallbackMsg);
    const err = new Error(msg) as Error & { code?: string };
    if (/AI_NOT_CONFIGURED|CODING_PLAN_API_KEY|未配置|NOT_CONFIGURED/i.test(msg)) {
      err.code = 'AI_NOT_CONFIGURED';
    }
    throw err;
  }
  return res.data;
}

export interface RecommendationPick {
  room_id: string;
  room_name: string;
  seat_id: string;
  features: string[];
  reason: string;
}

export interface RecommendationResult {
  source: 'ai' | 'fallback';
  picks: RecommendationPick[];
  note: string;
  fallback_reason?: string;
}

export async function recommendSeats(payload: {
  goal?: string;
  preferences?: string[];
  durationMinutes?: number;
}): Promise<RecommendationResult> {
  const res = await callCloud<RecommendationResult>('aiRecommend', payload);
  return unwrapAi(res, '推荐失败');
}

export interface StudySummaryStats {
  total_sessions: number;
  completed_sessions: number;
  abandoned_sessions: number;
  active_sessions: number;
  total_minutes: number;
  pomodoros: number;
  goal_summary: Array<{ goal: string; minutes: number }>;
}

export interface StudySummaryResult {
  source: 'ai' | 'fallback';
  stats: StudySummaryStats;
  summary: string;
  suggestions: string[];
  fallback_reason?: string;
}

export async function fetchStudyAiSummary(payload: {
  record_ids?: string[];
  since?: string;
  until?: string;
} = {}): Promise<StudySummaryResult> {
  const res = await callCloud<StudySummaryResult>('aiSummary', payload);
  return unwrapAi(res, '生成总结失败');
}

/** AI 学习计划（番茄分段） */

export interface StudyPlanBlock {
  title: string;
  duration_min: number;
  tip: string;
}

export interface StudyPlanResult {
  source: 'ai' | 'fallback';
  blocks: StudyPlanBlock[];
  summary: string;
  /** 云端已按推荐课程安排的分段（仅 AI 成功时返回，前端可复用于课程区展示） */
  courses?: RecommendedCourse[];
  fallback_reason?: string;
  note?: string;
}

export async function fetchStudyPlan(payload: {
  goal?: string;
  durationMinutes?: number;
  preferences?: string[];
  /** 已获得的课程推荐，供 AI 按课程设计每个时段的学习方式；不传则由云端兜底自取 */
  courses?: RecommendedCourse[];
} = {}): Promise<StudyPlanResult> {
  const res = await callCloud<StudyPlanResult>('aiRecommend', { action: 'generate_plan', ...payload });
  return unwrapAi(res, '生成学习计划失败');
}

/** AI 课程推荐（学习计划弹窗内展示，失败自动降级本地精选） */

export interface RecommendedCourse {
  title: string;
  reason: string;
  level: string;
  tags: string[];
}

export interface CourseRecommendResult {
  source: 'ai' | 'fallback';
  courses: RecommendedCourse[];
  topic: string;
  note?: string;
  fallback_reason?: string;
}

export async function recommendCourses(payload: {
  goal?: string;
  durationMinutes?: number;
  preferences?: string[];
} = {}): Promise<CourseRecommendResult> {
  const res = await callCloud<CourseRecommendResult>('aiRecommend', { action: 'recommend_courses', ...payload });
  return unwrapAi(res, '课程推荐失败');
}
