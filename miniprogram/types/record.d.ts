/** 业务记录表类型 — 对齐 Plan §5.2 */

export type RecordType = 'reservation' | 'checkin' | 'leave' | 'study' | 'feedback';

export type ReservationStatus =
  | 'pending_checkin'
  | 'active'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export type CheckinStatus = 'success' | 'expired';
export type LeaveStatus = 'active' | 'returned' | 'expired';
export type StudyStatus = 'running' | 'completed' | 'abandoned';
export type FeedbackStatus = 'submitted' | 'resolved';

export type RecordStatus =
  | ReservationStatus
  | CheckinStatus
  | LeaveStatus
  | StudyStatus
  | FeedbackStatus;

export interface BusinessRecord {
  _id: string;
  record_type: RecordType;
  user_id: string;
  category_ids?: string[];
  room_id?: string;
  seat_id?: string;
  start_at?: string;
  end_at?: string;
  status: RecordStatus;
  payload?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface RecordListQuery {
  record_type?: RecordType;
  status?: RecordStatus;
  room_id?: string;
  seat_id?: string;
  user_id?: string;
  limit?: number;
}
