/** 用户档案（云库 users 集合） */

export type UserRole = 'student' | 'admin';

export interface UserProfile {
  /** 脱敏后的用户 ID（openId 哈希），对外暴露 */
  userId: string;
  /** 与 userId 相同，便于查询 */
  openIdHash?: string;
  nickName?: string;
  avatarUrl?: string;
  role: UserRole;
  /** 累计违约次数（后端 expireRecords 定时结算 + login 惰性结算共同维护） */
  noShowCount?: number;
  /** 禁约截止时间（ISO）；为空表示未禁约 */
  bannedUntil?: string;
  /** 封禁来源：'admin'=管理员手动封禁（积分不可抵免），''=违约自动封禁 */
  banSource?: string;
  /** 连续签到天数（checkin 云函数维护） */
  streak?: number;
  /** 累计签到次数 */
  totalCheckin?: number;
  /**
   * 累计履约次数：签退（status → completed）时 +1，中途取消不计。
   * 与 totalCheckin 区分——签到只证明人到店，签退才证明完整用完这一单。
   */
  totalCheckout?: number;
  /** 最近签到日（北京时间 YYYY-MM-DD） */
  lastCheckinDate?: string;
  /** 邀请积分（被邀人首次签到后双方各 +1） */
  inviteCredit?: number;
  /** 我的邀请人 userId（分享卡进入时由 login 首次写入） */
  invitedBy?: string;
  /** 手机号（可选；bindPhone 云函数已下线，仅保留旧数据供后台展示） */
  phone?: string;
  /** 首次完善资料的时间（ISO）；为空表示尚未完成「首次引导」 */
  profileCompletedAt?: string;
  /** 已用积分抵免违约的次数（上限见 useCredit 云函数 WAIVER_LIMIT） */
  waiverTotalUsed?: number;
  created_at?: string;
  updated_at?: string;
}

/** 云数据库 users 文档（不含明文 openId） */
export interface UserDoc {
  _id: string;
  open_id_hash: string;
  nick_name: string;
  avatar_url: string;
  role: UserRole;
  created_at: string;
  updated_at: string;
}
