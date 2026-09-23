import type { UserProfile } from '../types/user';

/** 登录态本地缓存键（仅存脱敏后的档案，绝不含 openid / token） */
const STORAGE_KEY = 'focusseat_user';

/** 启动即同步读盘，避免冷启动时出现「未登录」闪烁 */
function loadFromStorage(): UserProfile | null {
  try {
    return wx.getStorageSync(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

/** 用户状态（内存 + 本地持久化双层） */
let currentUser: UserProfile | null = loadFromStorage();

export function getUser(): UserProfile | null {
  return currentUser;
}

export function setUser(user: UserProfile | null): void {
  currentUser = user;
  if (user) {
    try {
      wx.setStorageSync(STORAGE_KEY, user);
    } catch {
      /* 存储不可用时降级为仅内存 */
    }
  } else {
    try {
      wx.removeStorageSync(STORAGE_KEY);
    } catch {
      /* 忽略 */
    }
  }
  // 同步到 App 全局，供 tabBar / 页面直接读取
  const app = getApp<IAppOption>();
  if (app && app.globalData) {
    app.globalData.userInfo = user
      ? {
          userId: user.userId,
          nickName: user.nickName,
          avatarUrl: user.avatarUrl,
          role: user.role,
        }
      : null;
  }
}

export function clearUser(): void {
  setUser(null);
}
