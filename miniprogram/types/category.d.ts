/** 分类表类型 — 对齐 Plan §5.1 */

export type CategoryType = 'room' | 'seat_feature' | 'study_goal' | 'feedback_tag';
export type CategoryStatus = 'active' | 'disabled';

export interface Category {
  _id: string;
  type: CategoryType;
  code: string;
  name: string;
  description?: string;
  icon?: string;
  sort: number;
  status: CategoryStatus;
  parent_id?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CategoryListQuery {
  type?: CategoryType;
  status?: CategoryStatus;
}
