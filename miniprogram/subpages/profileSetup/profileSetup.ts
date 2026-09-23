import { login, getCachedUser, isProfileComplete } from '../../services/auth';
import { showError } from '../../utils/error';

/**
 * 首次完善资料引导页。
 *
 * 进入条件：已经登录（自动登录成功），且用户档案 `profile_completed_at` 为空。
 * 界面：点头像选微信头像（可选）、填昵称（必填，type="nickname" 可一键回填微信昵称）。
 * 保存：调 login({nickName, avatarUrl, completeProfile}) 单次落库（login 会写
 *       nick_name / avatar_url，并置位 profile_completed_at），成功后 reLaunch 回首页。
 *
 * ⚠️ 微信头像/昵称不可静默获取（2023-10 起 getUserProfile 只返回灰色占位），
 *    平台唯一可行的是 chooseAvatar + nickname 快填，本页即是最接近一键的体验。
 */
Page({
  data: {
    nickName: '',
    avatarUrl: '',
    avatarChar: '',
    avatarTone: 0,
    canSave: false,
    saving: false,
  },

  onLoad() {
    // 若资料已完善（有头像 / 非默认昵称 / 已有置位标记），直接回首页（防重复进入）。
    // 与 app.ts 冷启动跳转、profile 页横幅同一口径（isProfileComplete）。
    const user = getCachedUser();
    if (isProfileComplete(user)) {
      wx.reLaunch({ url: '/pages/home/home' });
      return;
    }
    // 预填本地已有昵称/头像（若用户之前改过）
    if (user) {
      this.setData({
        nickName: user.nickName || '',
        avatarUrl: user.avatarUrl || '',
      });
      this.recalcCanSave();
    }
  },

  /** 头像选择（chooseAvatar）：临时路径 → 上传云存储 → 更新 data 显示（不落库，保存时统一提交） */
  async onChooseAvatar(e: WechatMiniprogram.CustomEvent<{ avatarUrl?: string }>) {
    const tempPath = String(e.detail?.avatarUrl || '');
    if (!tempPath) return;
    try {
      if (!wx.cloud || typeof wx.cloud.uploadFile !== 'function') {
        throw new Error('云开发未初始化，无法上传头像');
      }
      const user = getCachedUser();
      const extMatch = tempPath.match(/\.([a-zA-Z0-9]+)$/);
      const ext = extMatch ? extMatch[1].toLowerCase() : 'png';
      const cloudPath = `avatars/${user?.userId || 'anon'}_setup_${Date.now()}.${ext}`;
      const uploaded = await wx.cloud.uploadFile({ cloudPath, filePath: tempPath });
      const fileID = String(uploaded?.fileID || '');
      if (!fileID) throw new Error('头像上传失败，请确认云存储已开通');
      this.setData({ avatarUrl: fileID });
    } catch (err) {
      showError(err, '头像上传失败');
    }
  },

  onNicknameChange(e: WechatMiniprogram.Input) {
    const value = String(e.detail?.value || '').trim();
    this.setData({ nickName: value });
    this.recalcCanSave();
  },

  /** 昵称必填：非空才可保存 */
  recalcCanSave() {
    this.setData({ canSave: Boolean(this.data.nickName.trim()) });
  },

  /** 保存资料：login 落库（含 completeProfile 置位）→ 回首页 */
  async onSave() {
    const nickName = this.data.nickName.trim();
    if (!nickName) {
      wx.showToast({ title: '请填写昵称', icon: 'none' });
      return;
    }
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      await login({
        nickName,
        avatarUrl: this.data.avatarUrl || '',
        completeProfile: true,
      });
      wx.showToast({ title: '资料已保存', icon: 'success' });
      wx.reLaunch({ url: '/pages/home/home' });
    } catch (err) {
      showError(err, '保存失败，请重试');
      this.setData({ saving: false });
    }
  },
});