import { callCloud } from '../../services/cloud';

/** 反馈类型（与 submitFeedback 云函数 CATEGORIES 保持一致） */
export const FEEDBACK_CATEGORIES = ['功能建议', '问题反馈', '投诉', '其他'] as const;

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/** 工单状态：待处理 → 已回复（用户可追问/确认）→ 已关闭；追问会打回 pending */
export type FeedbackStatus = 'pending' | 'replied' | 'handled';

/** 用户对某条反馈的追问（一问一答可多轮） */
export interface FeedbackFollowup {
  content: string;
  created_at: string;
}

/** 用户侧可见的一条反馈（含后台回复与追问记录） */
export interface MyFeedbackItem {
  feedback_id: string;
  category: string;
  content: string;
  images: string[];
  status: FeedbackStatus;
  /** 后台回复内容；为空表示仅标记已处理、未回复 */
  reply: string;
  replied_at: string;
  /** 我追问过的内容，按时间正序 */
  followups: FeedbackFollowup[];
  created_at: string;
}

/** 提交意见反馈，返回新记录 _id */
export async function submitFeedback(params: {
  category: string;
  content: string;
  images?: string[];
}): Promise<{ _id: string }> {
  const res = await callCloud<{ _id?: string }>('submitFeedback', {
    action: 'submit',
    category: params.category,
    content: params.content,
    images: params.images || [],
  });
  if (!res.success) throw new Error(res.message || '提交失败');
  return { _id: res.data?._id || '' };
}

/** 查询「我的反馈」列表（最近 20 条，含后台回复与追问记录） */
export async function listMyFeedback(): Promise<MyFeedbackItem[]> {
  const res = await callCloud<{ list: MyFeedbackItem[] }>('submitFeedback', { action: 'listMine' });
  if (!res.success) throw new Error(res.message || '查询失败');
  return (res.data?.list || []).map((item) => ({
    ...item,
    images: Array.isArray(item.images) ? item.images : [],
    followups: Array.isArray(item.followups) ? item.followups : [],
  }));
}

/**
 * 追问：对已回复的反馈继续提问，工单打回「待处理」重新进入管理员视野。
 * 这是闭环里最容易缺的一环 —— 没有它，用户看到回复后想再说一句就只能重新提一条。
 */
export async function followUpFeedback(
  feedbackId: string,
  content: string,
): Promise<{ status: FeedbackStatus }> {
  const res = await callCloud<{ status: FeedbackStatus }>('submitFeedback', {
    action: 'followUp',
    feedback_id: feedbackId,
    content,
  });
  if (!res.success) throw new Error(res.message || '追问失败');
  return { status: res.data?.status || 'pending' };
}

/** 确认解决：用户看完回复后关闭工单 */
export async function closeFeedback(feedbackId: string): Promise<void> {
  const res = await callCloud('submitFeedback', { action: 'close', feedback_id: feedbackId });
  if (!res.success) throw new Error(res.message || '操作失败');
}
