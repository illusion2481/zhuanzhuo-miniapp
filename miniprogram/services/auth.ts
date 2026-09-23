import { callCloud } from './cloud';
import type { UserProfile } from '../types/user';
import { setUser, getUser, clearUser } from '../store/user';
import { rlog } from '../utils/logger';

export interface LoginPayload {
  nickName?: string;
  avatarUrl?: string;
  /** 邀请人 userId（分享卡带来）：首次登录时上报绑定 */
  inviter?: string;
  /** 首次完善资料标记：置位 profile_completed_at（首次引导页提交） */
  completeProfile?: boolean;
}

/** 邀请参数本地键（与 app.ts 一致） */
const INVITER_KEY = 'focusseat_inviter';

/** 读取暂存的邀请人并清空（只消费一次） */
function consumeInviter(): string {
  try {
    const inviter = String(wx.getStorageSync(INVITER_KEY) || '');
    if (inviter) wx.removeStorageSync(INVITER_KEY);
    return inviter;
  } catch {
    return '';
  }
}

/** 调 login 云函数取最新档案并写入本地缓存（不含邀请人消费/上报） */
async function fetchProfile(): Promise<UserProfile> {
  const res = await callCloud<UserProfile>('login', {});
  if (!res.success || !res.data) {
    throw new Error(res.message || '登录失败');
  }
  setUser(res.data);
  clearLoginError();
  return res.data;
}

export async function login(payload: LoginPayload = {}): Promise<UserProfile> {
  const inviter = consumeInviter();
  const res = await callCloud<UserProfile>('login', { ...payload, ...(inviter ? { inviter } : {}) });
  if (!res.success || !res.data) {
    throw new Error(res.message || '登录失败');
  }
  setUser(res.data);
  clearLoginError();
  rlog('login ok', res.data.userId, res.data.role);
  return res.data;
}

/**
 * 仅刷新本地档案（禁约状态 / 连续签到等），不消费、不上报邀请人。
 *
 * 用途：页面展示前拉取服务端最新禁约状态。否则管理端解封、或封禁自然到期后，
 * 本地缓存里残留的 `bannedUntil` 会让「解封后仍然不可预约」——这是
 * 2026-09-18 真机「解封也不能预约」的根因：客户端横幅与点击拦截读的是陈旧缓存，
 * 而服务端已经放行。
 */
export async function refreshUser(): Promise<UserProfile> {
  return fetchProfile();
}

/** 读取本地缓存的用户；未登录返回 null */
export function getCachedUser(): UserProfile | null {
  return getUser();
}

/**
 * 默认昵称（login 云函数给新注册用户的占位名）。
 * 仅用于「资料完整度」判断，不参与任何文案展示。
 */
const DEFAULT_NICKNAME = '专注座用户';

/**
 * 判断用户资料是否已完善。
 *
 * 判据（满足其一即完成）：
 * 1. 云端已有 profile_completed_at 置位标记（首次引导完成过）；
 * 2. 已有真实头像（avatarUrl 非空）；
 * 3. 已设置过非默认昵称。
 *
 * 不用「单一置位标记」判断，是因为老用户可能此前只在「我的」页直接换过
 * 头像/昵称（未走 profileSetup 引导），若只看 profileCompletedAt 会误判为
 * 未完善 → 横幅常驻 + 每次启动强制跳完善页。此函数是 app.ts 冷启动跳转、
 * 「我的」页横幅、profileSetup 防重复进入三处的统一口径。
 */
export function isProfileComplete(user: UserProfile | null): boolean {
  if (!user) return false;
  if (user.profileCompletedAt) return true;
  if (user.avatarUrl) return true;
  const nick = (user.nickName || '').trim();
  return nick !== '' && nick !== DEFAULT_NICKNAME;
}

export function logout(): void {
  clearUser();
}

/* ══════════════ 登录失败状态（全局） ══════════════
 * 静默登录失败（云函数未部署 / 网络异常）时，app.ts 会 setLoginError；
 * 首页与「我的」页据此展示非阻断横幅并支持一键重试，避免用户无感知地停留在陈旧缓存态。
 */

let loginError: string | null = null;
const loginErrorListeners = new Set<() => void>();

export function setLoginError(msg: string | null): void {
  loginError = msg;
  loginErrorListeners.forEach((fn) => fn());
}

export function getLoginError(): string | null {
  return loginError;
}

export function clearLoginError(): void {
  if (loginError !== null) {
    loginError = null;
    loginErrorListeners.forEach((fn) => fn());
  }
}

/** 订阅登录错误变化，返回取消订阅函数 */
export function onLoginErrorChange(fn: () => void): () => void {
  loginErrorListeners.add(fn);
  return () => {
    loginErrorListeners.delete(fn);
  };
}
