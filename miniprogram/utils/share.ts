/**
 * 分享配置统一构造。
 * 各页面 onShareAppMessage 直接 return buildShare({...}) 即可，
 * 保证标题/路径风格一致，避免散落硬编码。
 */
import { getUser } from '../store/user';

export interface ShareOptions {
  title: string;
  path?: string;
  imageUrl?: string;
}

export function buildShare(opts: ShareOptions) {
  return {
    title: opts.title,
    path: opts.path || 'pages/home/home',
    imageUrl: opts.imageUrl,
  };
}

/** 朋友圈分享（基础库 2.11.3+，onShareTimeline 用） */
export function buildTimeline(opts: { title: string; query?: string; imageUrl?: string }) {
  return {
    title: opts.title,
    query: opts.query || '',
    imageUrl: opts.imageUrl,
  };
}

/** 邀请分享落地参数：优先读本地用户档案；未登录则不带 inviter */
function currentUserId(): string {
  try {
    const user = getUser();
    return (user && user.userId) || '';
  } catch {
    return '';
  }
}

/**
 * 邀请分享：路径自动拼上 `inviter=<userId>`。
 * 被邀请人通过分享卡片进入小程序时，app.ts 会解析该参数并落库到用户档案，
 * 完成首次签到后邀请双方各得 1 分（见 cloudfunctions/checkin）。
 */
export function buildShareInvite(opts: ShareOptions): ReturnType<typeof buildShare> {
  const uid = currentUserId();
  const base = buildShare(opts);
  if (!uid) return base;
  const sep = base.path.indexOf('?') === -1 ? '?' : '&';
  return { ...base, path: `${base.path}${sep}inviter=${encodeURIComponent(uid)}` };
}

/** 邀请分享进朋友圈：query 同样带 inviter */
export function buildTimelineInvite(opts: { title: string; imageUrl?: string }): ReturnType<typeof buildTimeline> {
  const userId = currentUserId();
  const query = userId ? `inviter=${encodeURIComponent(userId)}` : '';
  return buildTimeline({ title: opts.title, imageUrl: opts.imageUrl, query });
}
