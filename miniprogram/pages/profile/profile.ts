import { login, getCachedUser, getLoginError, onLoginErrorChange, clearLoginError, isProfileComplete } from '../../services/auth';
import { fetchStudySummary, listMyReservations } from '../../services/record';
import { useCreditWaive } from '../../services/credit';
import { showError, showBusinessError } from '../../utils/error';
import { buildShareInvite, buildTimelineInvite } from '../../utils/share';
import type { UserProfile } from '../../types/user';
import { trackShare } from '../../utils/analytics';

/**
 * 客服会话上下文（button open-type="contact" 的 session-from）。
 *
 * 微信会把它作为「用户来源」透传给客服，客服一开口就知道是谁、从哪来，
 * 不用再问一遍「请问你的账号 / 手机号是」—— 这是人工客服环节最省时间的一行。
 * 只放单向哈希的用户 ID 与页面标记，不含昵称手机号等敏感信息。
 */
function buildContactSessionFrom(user: UserProfile | null): string {
  const uid = (user && user.userId) || '';
  return JSON.stringify({ uid: uid.slice(0, 32), p: 'profile', s: 'focus-seat' });
}

Page({
  data: {
    loggedIn: false,
    nickName: '',
    /** 微信头像（云存储 fileID）；为空时回退到首字母色块 */
    avatarUrl: '',
    avatarChar: '',
    avatarTone: 0,
    role: '',
    /**
     * 进入客服会话时透传的上下文（session-from）。
     * 客服侧能看到「谁来了、从哪来」，不用再问一遍「请问你的账号是」。
     */
    contactSessionFrom: '',
    loading: false,
    statsLoading: false,
    /** 头像上传中（避免连点） */
    avatarSaving: false,
    /** 昵称保存中 */
    nickSaving: false,
    totalSeconds: 0,
    completedCount: 0,
    reservationCount: 0,
    pomodoroTotal: 0,
    formatHours: '0',
    noShowCount: 0,
    banText: '',
    /** 邀请积分（受邀人首次签到后双方各 +1；可抵免违约） */
    inviteCredit: 0,
    /** 已用积分抵免次数（上限见 useCredit 云函数） */
    waiverTotalUsed: 0,
    /** 是否可点「抵免违约」（积分>0 且违约>0 且未达上限；由 applyUser 计算） */
    waiveAble: false,
    /** 抵免请求中（避免连点） */
    waiveSaving: false,
    /** 首次资料未完善：展示「去完善资料」入口 */
    profileIncomplete: false,
    /** 连续签到天数（checkin 云函数维护，登录时透出） */
    streak: 0,
    totalCheckin: 0,
    /** 累计履约次数（签退 +1，取消不计） */
    totalCheckout: 0,
    /** 登录失败横幅（云端不可用时非阻断提示 + 一键重试） */
    loginError: '',
    loginRetrying: false,
  },

  onShow() {
    // 同步 tabBar 选中态（组件 pageLifetimes.show 的路由计算时机不稳，官方推荐页面侧显式刷新）
    this.getTabBar()?.refresh?.();
    this.syncLocalUser();
    // 订阅全局登录错误变化：app.ts 静默登录失败时 setLoginError → 实时刷新横幅
    onLoginErrorChange(() => this.setData({ loginError: getLoginError() || '' }));
    this.setData({ loginError: getLoginError() || '' });
  },

  /** 横幅一键重试：重新登录，成功后自动清除横幅 */
  async onRetryLogin() {
    if (this.data.loginRetrying) return;
    this.setData({ loginRetrying: true });
    try {
      await login();
      clearLoginError();
      this.setData({ loginError: '' });
      wx.showToast({ title: '登录成功', icon: 'success' });
      this.syncLocalUser();
    } catch (err) {
      const msg = (err as { message?: string })?.message || '登录失败，云端暂不可用';
      this.setData({ loginError: msg });
    } finally {
      this.setData({ loginRetrying: false });
    }
  },

  /** 把云端/本地档案灌进页面（登录、改头像、改昵称共用） */
  applyUser(user: UserProfile) {
    const name = user.nickName || '专注座用户';
    const { char, tone } = this.avatarMeta(name);
    this.setData({
      loggedIn: true,
      nickName: name,
      avatarUrl: user.avatarUrl || '',
      avatarChar: char,
      avatarTone: tone,
      role: user.role,
      contactSessionFrom: buildContactSessionFrom(user),
      noShowCount: user.noShowCount || 0,
      banText: this.computeBanText(user.bannedUntil),
      inviteCredit: user.inviteCredit || 0,
      waiverTotalUsed: user.waiverTotalUsed || 0,
      waiveAble: (user.inviteCredit || 0) > 0 && (user.noShowCount || 0) > 0,
      profileIncomplete: !isProfileComplete(user),
      streak: user.streak || 0,
      totalCheckin: user.totalCheckin || 0,
      totalCheckout: user.totalCheckout || 0,
    });
  },

  syncLocalUser() {
    const user = getCachedUser();
    if (user) {
      this.applyUser(user);
      this.loadStats();
    } else {
      this.setData({
        loggedIn: false,
        nickName: '',
        avatarUrl: '',
        avatarChar: '',
        avatarTone: 0,
        role: '',
        totalSeconds: 0,
        completedCount: 0,
        reservationCount: 0,
        pomodoroTotal: 0,
        formatHours: '0',
        noShowCount: 0,
        banText: '',
        inviteCredit: 0,
        waiverTotalUsed: 0,
        waiveAble: false,
        waiveSaving: false,
        profileIncomplete: false,
        streak: 0,
        totalCheckin: 0,
        totalCheckout: 0,
      });
    }
  },

  /**
   * 选择微信头像（button open-type="chooseAvatar"）。
   * e.detail.avatarUrl 是临时文件路径，重启即失效 → 必须先上传到云存储换 fileID 再落库，
   * 否则下次启动头像就变成空白。
   */
  async onChooseAvatar(e: WechatMiniprogram.CustomEvent<{ avatarUrl?: string }>) {
    const tempPath = String(e.detail?.avatarUrl || '');
    if (!tempPath || this.data.avatarSaving) return;
    this.setData({ avatarSaving: true });
    wx.showLoading({ title: '上传头像…', mask: true });
    try {
      if (!wx.cloud || typeof wx.cloud.uploadFile !== 'function') {
        throw new Error('云开发未初始化，无法上传头像');
      }
      const user = getCachedUser();
      const extMatch = tempPath.match(/\.([a-zA-Z0-9]+)$/);
      const ext = extMatch ? extMatch[1].toLowerCase() : 'png';
      const cloudPath = `avatars/${user?.userId || 'anon'}_${Date.now()}.${ext}`;
      const uploaded = await wx.cloud.uploadFile({ cloudPath, filePath: tempPath });
      const fileID = String(uploaded?.fileID || '');
      if (!fileID) throw new Error('头像上传失败，请确认云存储已开通');
      const saved = await login({ avatarUrl: fileID, completeProfile: true });
      wx.hideLoading();
      this.applyUser(saved);
      wx.showToast({ title: '头像已更新', icon: 'success' });
    } catch (err) {
      wx.hideLoading();
      showError(err, '头像更新失败，请检查云存储是否已开通');
    } finally {
      this.setData({ avatarSaving: false });
    }
  },

  /**
   * 微信昵称填写（input type="nickname"）。
   * 用户选完微信昵称后 change / blur / confirm 都可能触发，这里做去重避免重复请求。
   */
  async onNicknameChange(e: WechatMiniprogram.Input) {
    const value = String(e.detail?.value || '').trim();
    if (!value || value === this.data.nickName || this.data.nickSaving) return;
    this.setData({ nickSaving: true });
    try {
      const saved = await login({ nickName: value, completeProfile: true });
      this.applyUser(saved);
      wx.showToast({ title: '昵称已更新', icon: 'success' });
    } catch (err) {
      // 失败回滚到当前有效昵称（可能是敏感词被拒）
      this.syncLocalUser();
      showError(err, '昵称更新失败');
    } finally {
      this.setData({ nickSaving: false });
    }
  },

  /** 根据昵称计算头像字符与色调（品牌深绿系内取色，稳定不随刷新变） */
  avatarMeta(name: string): { char: string; tone: number } {
    const trimmed = (name || '').trim();
    const char = trimmed ? Array.from(trimmed)[0] : '座';
    let hash = 0;
    for (let i = 0; i < trimmed.length; i += 1) hash = (hash * 31 + trimmed.charCodeAt(i)) >>> 0;
    return { char, tone: hash % 5 };
  },

  computeBanText(bannedUntil?: string): string {
    if (!bannedUntil) return '';
    const until = new Date(bannedUntil).getTime();
    if (Number.isNaN(until) || until <= Date.now()) return '';
    const mins = Math.ceil((until - Date.now()) / 60000);
    if (mins >= 60) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return `因违约过多，${h} 小时 ${m} 分内不可预约`;
    }
    return `因违约过多，${mins} 分钟内不可预约`;
  },

  async loadStats() {
    this.setData({ statsLoading: true });
    try {
      // 今日累计
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayIso = today.toISOString();
      const summary = await fetchStudySummary(todayIso);
      const totalSeconds = summary.total_seconds || 0;
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const formatHours = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

      // 累计预约数
      const reservations = await listMyReservations({ limit: 100 });
      this.setData({
        totalSeconds,
        completedCount: summary.completed_count || 0,
        reservationCount: reservations.length,
        pomodoroTotal: summary.pomodoro_total || 0,
        formatHours,
        statsLoading: false,
      });
    } catch (err) {
      // 静默：失败不阻断主流程
      this.setData({ statsLoading: false });
      void err;
    }
  },

  async onLogin() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const user = await login();
      this.applyUser(user);
      wx.showToast({ title: '登录成功', icon: 'success' });
      this.loadStats();
    } catch (err) {
      showError(err, '登录失败，请确认已部署 login 云函数');
    } finally {
      this.setData({ loading: false });
    }
  },

  goRank() {
    wx.navigateTo({ url: '/subpages/rank/rank' });
  },

  goMyReservations() {
    wx.navigateTo({ url: '/subpages/myReservations/myReservations' });
  },

  goFeedback() {
    wx.navigateTo({ url: '/subpages/feedback/feedback' });
  },

  /** 常见问题：客服会话无人值守时的自助出口 */
  goFaq() {
    wx.navigateTo({ url: '/subpages/faq/faq' });
  },

  /** 联系客服：进入 AI 客服聊天页（AI 顶岗 24h，答不上转人工/表单兜底） */
  goAiChat() {
    wx.navigateTo({ url: '/subpages/aiChat/aiChat' });
  },

  /** 首次资料未完善时，引导去完善资料页 */
  goProfileSetup() {
    wx.navigateTo({ url: '/subpages/profileSetup/profileSetup' });
  },

  /**
   * 用 1 积分抵免 1 次违约。
   * useCredit 云函数在积分不足/违约已清空/达上限时返回 success:true + 说明，
   * 这里统一转成轻提示；成功后刷新本地档案（违规数/积分变化可见）。
   */
  async onWaiveCredit() {
    if (this.data.waiveSaving) return;
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: '使用积分抵免',
        content: `将消耗 1 积分，抵消 1 次违约（当前积分 ${this.data.inviteCredit}，违约 ${this.data.noShowCount} 次）`,
        confirmText: '抵免',
        cancelText: '再想想',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    this.setData({ waiveSaving: true });
    try {
      const res = await useCreditWaive();
      if (res.can_waive) {
        // 成功后云端 no_show_count / invite_credit 已变，刷新本地档案
        const fresh = await login();
        this.applyUser(fresh);
        wx.showToast({ title: '已用 1 积分抵免 1 次违约', icon: 'success' });
      } else {
        // 不可抵免：云端已返回原因（无违约 / 积分不足 / 达上限）
        const reason =
          res.no_show_count <= 0
            ? '当前没有可抵扣的违约记录'
            : res.credit <= 0
              ? '积分不足，邀请好友完成首次签到可获积分'
              : `每人最多使用 10 次积分抵免，已达上限`;
        showBusinessError(reason);
      }
    } catch (err) {
      showError(err, '抵免失败，请重试');
    } finally {
      this.setData({ waiveSaving: false });
    }
  },

  /** 分享邀请（带积分引导文案）：复用项目分享工具 */
  onInviteFriend() {
    trackShare('invite_tap');
    if (wx.showShareMenu) {
      wx.showShareMenu({ withShareTicket: true });
    }
    // 轻提示引导用户点右上角转发
    wx.showToast({ title: '点右上角「分享」邀请好友', icon: 'none' });
  },

  onShareAppMessage() {
    // 埋点：分享入口（首页也可能触发，见 home.ts）
    trackShare('tap');
    return buildShareInvite({
      title: '专注座 · 记录我的专注时光',
      path: 'pages/profile/profile',
    });
  },

  onShareTimeline() {
    return buildTimelineInvite({
      title: '专注座 · 记录我的专注时光',
    });
  },
});
