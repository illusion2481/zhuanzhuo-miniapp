import { CLOUD_ENV_ID } from './config/env';
import { login, setLoginError, isProfileComplete } from './services/auth';
import { getUser } from './store/user';

/** 邀请落地参数暂存键：分享卡带 inviter 进入时存下，首次登录时随 login 上报 */
const INVITER_KEY = 'focusseat_inviter';

App<IAppOption>({
  globalData: {
    userInfo: null,
    cloudReady: false,
  },

  onLaunch(options?: { query?: Record<string, string | undefined> }) {
    if (!wx.cloud) {
      console.error('[FocusSeat] 请使用支持云开发的基础库');
      return;
    }

    // 分享参数解析：?inviter=<userId> → 存本地，登录时上报绑定
    this.captureInviter(options);

    wx.cloud.init({
      env: CLOUD_ENV_ID || undefined,
      traceUser: true,
    });
    this.globalData.cloudReady = true;

    // 新版本检测：用户打开小程序时若有新版本，弹窗引导重启（线上最重要的更新通路）
    this.checkUpdate();

    // 隐私合规：按微信要求，若需处理用户隐私信息，先检查授权状态并弹出隐私指引
    this.checkPrivacy();

    // 同步恢复本地登录态，避免启动瞬间未登录态闪烁（云端刷新会覆盖为最新角色/禁约）
    const cached = getUser();
    if (cached) {
      this.globalData.userInfo = {
        userId: cached.userId,
        nickName: cached.nickName,
        avatarUrl: cached.avatarUrl,
        role: cached.role,
      };
    }

    // 静默登录：云函数未部署时不阻断启动
    login()
      .then((user) => {
        this.globalData.userInfo = {
          userId: user.userId,
          nickName: user.nickName,
          avatarUrl: user.avatarUrl,
          role: user.role,
        };
        // 首次进入且资料未完善 → 引导完善（仅一次；跳陌生分包页需在路由就绪后）
        // 判据统一用 isProfileComplete：有头像 / 非默认昵称 / 已置位标记 任一即算完善，
        // 避免老用户（在「我的」页直接改过头像昵称）被反复拉去引导页。
        if (!isProfileComplete(user)) {
          setTimeout(() => {
            const pages = getCurrentPages();
            const cur = pages.length ? pages[pages.length - 1] : null;
            const route = (cur && cur.route) || '';
            // 避免在引导页/登录异常页重复跳
            if (route !== 'subpages/profileSetup/profileSetup') {
              wx.reLaunch({ url: '/subpages/profileSetup/profileSetup' });
            }
          }, 600);
        }
      })
      .catch((err) => {
        // err 已被 cloud.ts:normalizeError 规范化为带字符串 message 的 Error 实例
        const msg = err && (err as { message?: string }).message;
        console.warn('自动登录跳过:', msg || err);
        // 暴露给首页/「我的」页：横幅提示 + 一键重试，避免用户无感知停留在陈旧缓存态
        setLoginError(msg || '登录失败，云端暂不可用');
      });
  },

  /**
   * 版本更新：检测到新版本时用 wx.showModal 引导用户重启。
   * 注意：getUpdateManager 需基础库 2.9.1+，低版本静默跳过。
   */
  checkUpdate() {
    if (!wx.getUpdateManager) return;
    const updateManager = wx.getUpdateManager();
    updateManager.onUpdateReady(() => {
      wx.showModal({
        title: '更新提示',
        content: '新版本已经准备好，重启后即可体验。',
        showCancel: false,
        confirmText: '立即重启',
        success: () => updateManager.applyUpdate(),
      });
    });
    updateManager.onUpdateFailed(() => {
      wx.showModal({
        title: '更新提示',
        content: '新版本下载失败，请检查网络后重试',
        showCancel: false,
      });
    });
  },

  /**
   * 隐私合规：
   * 1. 若 wx.getPrivacySetting 存在（基础库 2.32.3+），检查是否需要弹隐私指引；
   * 2. 需要时调用 wx.requirePrivacyAuthorize 弹出官方隐私授权组件；
   * 3. 用户拒绝时提示可到设置中重新授权。
   * 注意：首次需要界面触发，onLaunch 阶段多数情况静默通过；真正的隐私弹窗依赖
   *       mp 后台已配置《用户隐私保护指引》并声明收集字段（openid、昵称、头像等）。
   */
  checkPrivacy() {
    if (!wx.getPrivacySetting || !wx.requirePrivacyAuthorize) return;
    wx.getPrivacySetting({
      success: (res: WechatMiniprogram.GetPrivacySettingSuccessCallbackResult) => {
        if (!res.needAuthorization) return;
        wx.requirePrivacyAuthorize({
          success: () => {
            // 用户已同意，继续正常业务流程
            console.log('[FocusSeat] 隐私授权已同意');
          },
          fail: () => {
            console.warn('[FocusSeat] 隐私授权被拒绝');
          },
        });
      },
    });
  },

  /**
   * 邀请参数捕获：分享卡片 / 朋友圈进入时，options.query.inviter 即邀请人 userId。
   * 只在本地未绑定过邀请人时暂存（防止被覆盖），随后随 login 上报云函数绑定。
   */
  captureInviter(options?: { query?: Record<string, string | undefined> }) {
    try {
      const inviter = (options && options.query && options.query.inviter) || '';
      if (!inviter) return;
      if (wx.getStorageSync(INVITER_KEY)) return; // 已有邀请人，不覆盖
      if (inviter === getUser()?.userId) return; // 自己邀自己不记
      wx.setStorageSync(INVITER_KEY, inviter);
    } catch {
      /* 存储不可用则静默 */
    }
  },
});
