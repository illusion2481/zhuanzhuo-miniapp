import { getCachedUser } from '../../services/auth';
import { showError } from '../../utils/error';
import {
  submitFeedback,
  listMyFeedback,
  followUpFeedback,
  closeFeedback,
  FEEDBACK_CATEGORIES,
  type MyFeedbackItem,
} from '../services/feedback';

/** 工单状态文案：replied 是「已回复、等你确认」的中间态，不是结束 */
const STATUS_TEXT: Record<string, string> = {
  pending: '待处理',
  replied: '已回复',
  handled: '已关闭',
};

/** ISO 时间 → 「9/20 17:29」短标签（本地时区，与学习页口径一致） */
function shortTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

Page({
  data: {
    categories: FEEDBACK_CATEGORIES as readonly string[] as string[],
    activeCategory: '',
    content: '',
    images: [] as string[],
    submitting: false,

    /** 我的反馈：展示后台处理状态与回复（客服闭环的用户侧） */
    myList: [] as Array<
      MyFeedbackItem & {
        time_label: string;
        status_text: string;
        followups: Array<{ content: string; time_label: string }>;
      }
    >,
    myLoading: false,
    myError: '',
    /** 每条反馈独立的追问草稿，key = feedback_id（避免多张卡串字） */
    followupDrafts: {} as Record<string, string>,
    /** 正在提交追问/关闭的 feedback_id，用于按钮 loading 与防重复点击 */
    actingId: '',
    /** 转人工客服时透传的上下文（同 profile / faq 页口径） */
    contactSessionFrom: '',
  },

  onShow() {
    this.loadMine();
    const user = getCachedUser();
    const uid = (user && user.userId) || '';
    // 工单 → 人工：客服一开口就知道是谁、已经提过什么，不用从头复述
    this.setData({
      contactSessionFrom: JSON.stringify({ uid: uid.slice(0, 32), p: 'feedback', s: 'focus-seat' }),
    });
  },

  onPickCategory(e: WechatMiniprogram.TouchEvent) {
    const cat = String(e.currentTarget.dataset.cat || '');
    this.setData({ activeCategory: cat });
  },

  onContentInput(e: WechatMiniprogram.CustomEvent<{ value?: string }>) {
    this.setData({ content: String(e.detail?.value || '') });
  },

  onChooseImage() {
    const remain = 4 - this.data.images.length;
    if (remain <= 0) return;
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: async (res) => {
        const user = getCachedUser();
        const userId = user?.userId || 'anon';
        wx.showLoading({ title: '上传中…', mask: true });
        try {
          const uploaded: string[] = [];
          for (const f of res.tempFiles) {
            const extMatch = String(f.tempFilePath).match(/\.([a-zA-Z0-9]+)$/);
            const ext = extMatch ? extMatch[1].toLowerCase() : 'jpg';
            const cloudPath = `feedback/${userId}_${Date.now()}_${uploaded.length}.${ext}`;
            const r = await wx.cloud.uploadFile({ cloudPath, filePath: f.tempFilePath });
            const fileID = String(r?.fileID || '');
            if (fileID) uploaded.push(fileID);
          }
          this.setData({ images: [...this.data.images, ...uploaded] });
        } catch (err) {
          showError(err, '图片上传失败，请检查云存储是否已开通');
        } finally {
          wx.hideLoading();
        }
      },
      fail: () => {
        /* 用户取消选择，不提示 */
      },
    });
  },

  onRemoveImage(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index) || 0;
    const images = this.data.images.slice();
    images.splice(index, 1);
    this.setData({ images });
  },

  async onSubmit() {
    if (this.data.submitting) return;
    const category = this.data.activeCategory;
    const content = this.data.content.trim();
    if (!category) {
      wx.showToast({ title: '请选择反馈类型', icon: 'none' });
      return;
    }
    if (content.length < 5) {
      wx.showToast({ title: '请至少输入 5 个字', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      await submitFeedback({ category, content, images: this.data.images });
      wx.showToast({ title: '反馈已提交', icon: 'success' });
      // 清空表单，并立刻刷新「我的反馈」，让用户看到刚提交的那条
      this.setData({ content: '', images: [], activeCategory: '' });
      await this.loadMine();
    } catch (err) {
      showError(err, '提交失败，请稍后重试');
    } finally {
      this.setData({ submitting: false });
    }
  },

  /** 拉取我的反馈（含后台回复） */
  async loadMine() {
    if (this.data.myLoading) return;
    this.setData({ myLoading: true, myError: '' });
    try {
      const list = await listMyFeedback();
      const myList = list.map((item) => ({
        ...item,
        time_label: shortTime(item.created_at),
        status_text: STATUS_TEXT[item.status] || '待处理',
        followups: (item.followups || []).map((fu) => ({
          content: fu.content,
          created_at: fu.created_at,
          time_label: shortTime(fu.created_at),
        })),
      }));
      this.setData({ myList, myLoading: false });
    } catch (err) {
      this.setData({ myLoading: false, myError: (err as Error).message || '加载失败' });
    }
  },

  /** 追问草稿输入：按 feedback_id 独立存储 */
  onFollowupInput(e: WechatMiniprogram.CustomEvent<{ value?: string }>) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id) return;
    this.setData({
      followupDrafts: { ...this.data.followupDrafts, [id]: String(e.detail?.value || '') },
    });
  },

  /**
   * 提交追问：工单打回「待处理」，管理员重新看到它。
   * 没有这个动作，用户看完回复想再说一句就只能重新提一条，上下文全断。
   */
  async onSubmitFollowup(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id || this.data.actingId) return;
    const content = String(this.data.followupDrafts[id] || '').trim();
    if (content.length < 2) {
      wx.showToast({ title: '请至少输入 2 个字', icon: 'none' });
      return;
    }
    this.setData({ actingId: id });
    wx.showLoading({ title: '提交中', mask: true });
    try {
      await followUpFeedback(id, content);
      const next = { ...this.data.followupDrafts };
      delete next[id];
      this.setData({ followupDrafts: next });
      wx.showToast({ title: '已提交，我们会继续跟进', icon: 'none' });
      await this.loadMine();
    } catch (err) {
      showError(err, '追问失败，请稍后重试');
    } finally {
      wx.hideLoading();
      this.setData({ actingId: '' });
    }
  },

  /** 确认已解决：关闭工单 */
  async onCloseFeedback(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id || this.data.actingId) return;
    const res = await wx.showModal({
      title: '问题已解决？',
      content: '关闭后可在「意见反馈」重新提交新的问题',
    });
    if (!res.confirm) return;
    this.setData({ actingId: id });
    try {
      await closeFeedback(id);
      wx.showToast({ title: '已关闭，感谢反馈', icon: 'success' });
      await this.loadMine();
    } catch (err) {
      showError(err, '操作失败，请稍后重试');
    } finally {
      this.setData({ actingId: '' });
    }
  },

  /** 转自助：先看 FAQ，解决不了再回来提工单或转人工 */
  goFaq() {
    wx.navigateTo({ url: '/subpages/faq/faq' });
  },
});
