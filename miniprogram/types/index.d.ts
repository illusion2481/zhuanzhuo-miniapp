/** 全局 App 类型 */

interface IUserInfo {
  userId: string;
  nickName?: string;
  avatarUrl?: string;
  role?: 'student' | 'admin';
}

interface IAppOption {
  globalData: {
    userInfo: IUserInfo | null;
    cloudReady: boolean;
  };
  onLaunch(): void;
  /** 检测新版本并引导重启 */
  checkUpdate(): void;
  /** 隐私合规：检查并弹隐私授权 */
  checkPrivacy(): void;
  /** 邀请参数捕获：分享卡 / 朋友圈进入时暂存 inviter，随 login 上报绑定 */
  captureInviter(options?: { query?: Record<string, string | undefined> }): void;
}

// App/Page/Component/getApp are provided globally by miniprogram-api-typings.
