import { toSeatDisplayName } from '../../utils/seatName';
import { showBusinessError } from '../../utils/error';
import { checkinWithCode } from '../../utils/checkin';

type CheckinState = 'loading' | 'success' | 'already' | 'cancelled' | 'error' | 'empty';

const TITLES: Record<CheckinState, string> = {
  loading: '正在签到',
  success: '签到成功',
  already: '无需重复签到',
  cancelled: '已取消签到',
  error: '签到未成功',
  empty: '缺少预约信息',
};

Page({
  data: {
    state: 'loading' as CheckinState,
    title: TITLES.loading as string,
    message: '正在确认到店信息…',
    seatLabel: '',
    canRetry: false,
    recordId: '',
  },

  async onLoad(query: Record<string, string | undefined>) {
    const rid = String(query.rid || '');
    this.setData({ recordId: rid });
    if (!rid) {
      this.setData({
        state: 'empty',
        title: TITLES.empty,
        message: '未获取到预约信息，请在「我的预约」中点击签到',
      });
      return;
    }
    await this.doCheckin();
  },

  async doCheckin() {
    const rid = this.data.recordId;
    if (!rid) return;
    this.setData({ state: 'loading', title: TITLES.loading, message: '正在确认到店信息…', canRetry: false });
    try {
      const rec = await checkinWithCode(rid, { toast: false });
      if (!rec) {
        // 用户在签到码弹窗点了取消
        this.setData({
          state: 'cancelled',
          title: TITLES.cancelled,
          message: '未完成到店签到，可点击下方按钮重试',
          canRetry: true,
        });
        return;
      }
      const seatLabel = rec.seat_id ? toSeatDisplayName({ seat_id: rec.seat_id }) : '';
      this.setData({ state: 'success', title: TITLES.success, message: '签到成功，专注开始', seatLabel });
    } catch (err) {
      const msg = String(((err as { message?: string }) || {}).message || '签到失败');
      if (msg.indexOf('当前预约不可签到') !== -1) {
        this.setData({ state: 'already', title: TITLES.already, message: msg });
        return;
      }
      showBusinessError(err, '签到失败');
      this.setData({ state: 'error', title: TITLES.error, message: msg, canRetry: true });
    }
  },

  onRetry() {
    this.doCheckin();
  },

  goMyReservations() {
    wx.redirectTo({ url: '/subpages/myReservations/myReservations' });
  },

  goHome() {
    wx.reLaunch({ url: '/pages/home/home' });
  },

  /**
   * 求助入口：自助客服要埋在「用户卡住的那一刻」，而不是只放在「我的」页。
   * 签到失败是最高频的卡点（定位失败 / 签到码错误 / 超出时间窗），
   * 在这里直接给出口，能挡掉一大半人工客服咨询。
   */
  goFaq() {
    wx.navigateTo({ url: '/subpages/faq/faq' });
  },
});
