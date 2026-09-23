import {
  cancelReservation,
  leaveSeat,
  returnSeat,
  listMyReservations,
  updateReservation,
  extendReservation,
  submitReview,
} from '../../services/record';
import { listRooms } from '../../services/room';
import { login } from '../../services/auth';
import {
  notifyReservationConfirmed,
  requestReservationConfirmSubscribes,
  requestCancelSubscribes,
} from '../../services/notify';
import type { SubscribeOutcome } from '../../utils/subscribe';
import { formatDateTime } from '../../utils/time';
import { showBusinessError, showError } from '../../utils/error';
import { checkinWithCode } from '../../utils/checkin';
import { toSeatDisplayName } from '../../utils/seatName';
import type { BusinessRecord, ReservationStatus } from '../../types/record';
import { CHECKIN_TIMEOUT_MINUTES, LEAVE_TIMEOUT_MINUTES } from '../../config/constants';
import { setActiveReservation } from '../../store/reservation';
import { trackCheckinDone, trackExtend } from '../../utils/analytics';

type TabKey = 'all' | 'pending_checkin' | 'active' | 'history';

/**
 * 弹层开关：同一时刻最多只有一个。
 * ⚠️ 刻意不用四个独立布尔量——只要有一个残留在 true，对应面板就会常驻在
 *    预约列表下方，看起来像"页面上多出来的一块表单"；而且它渲染在列表末尾、
 *    常常不在可视区，点里面的按钮会显得"毫无反应"。
 */
type SheetKey = '' | 'cancel' | 'extend' | 'review' | 'reschedule';

interface Tab {
  key: TabKey;
  label: string;
}

/**
 * 卡片操作项。
 *
 * ⚠️ 2026-09-19 重构：原来一张卡平铺 3~4 个等宽按钮（手动签到/扫码签到/改约/取消），
 * 视觉权重相同 → 用户不知道该点哪个；而且「手动签到」和「扫码签到」本质是同一个动作
 * 的两种实现方式，占了两个主位。行业做法（学习通/高校图书馆）是**单一签到入口**，
 * 扫码/定位只是它的实现手段。现在拆成 primary（唯一主行动）+ more（折叠次级）。
 */
interface ActionItem {
  type: 'checkin' | 'cancel' | 'leave' | 'return' | 'reschedule' | 'extend' | 'review' | 'checkout';
  label: string;
}

interface ReservationRow {
  _id: string;
  room_id?: string;
  roomName?: string;
  seatLabel: string;
  seat_id?: string;
  startLabel: string;
  endLabel: string;
  goal: string;
  /** 服务端返回的真实状态 */
  status: ReservationStatus;
  /**
   * 展示用状态：与 status 基本一致，唯一的差别是
   * **待签到已超过签到时限**时显示为 no_show（徽标「已违约」+ 危险色）。
   * 服务端要靠 expireRecords 定时器才会把它翻成 no_show，
   * 在此之前徽标还写着「待签到」、正文却写着「已超时」，自相矛盾。
   */
  displayStatus: ReservationStatus;
  statusLabel: string;
  /** 时长即预约提示文案（距开始/可签到/使用中/已结束） */
  countdown: string;
  countdownLevel: 'soon' | 'active' | 'idle' | 'done';
  /** 座位自动释放的截止时刻（毫秒）；0 表示当前状态不涉及自动释放 */
  releaseAt: number;
  /** 违约/释放倒计时文案；空串表示不涉及 */
  releaseText: string;
  /** 紧急程度：safe 充裕 / warn 临近 / danger 即将释放 / released 已释放 / '' 不涉及 */
  releaseLevel: 'safe' | 'warn' | 'danger' | 'released' | '';
  /** 是否仍可签到。超过释放截止时刻后与服务端一致地禁止签到，避免和他人重复占座 */
  canCheckin: boolean;
  /** 主行动：每张卡最多一个，渲染为实心主按钮 */
  primary: ActionItem | null;
  /** 次级行动：折叠在「更多」里，点开才展示 */
  more: ActionItem[];
  /** active 状态：剩余时长 < 60 分钟时高亮「续时」，更重要时用普通描边 */
  canExtend: boolean;
  /** 续时选项（分钟）：30 / 60 / 90 */
  extendOptions: number[];
  /** 是否已完成（可评价） */
  canReview: boolean;
  /** 本次会话内已评价过（服务端一单一评、幂等；这里只用于收起按钮） */
  reviewed: boolean;
}

const STATUS_LABEL: Record<ReservationStatus, string> = {
  pending_checkin: '待签到',
  active: '使用中',
  paused: '暂离中',
  completed: '已完成',
  cancelled: '已取消',
  no_show: '已违约',
};

const TABS: Tab[] = [
  { key: 'all', label: '全部' },
  { key: 'pending_checkin', label: '待签到' },
  { key: 'active', label: '使用中' },
  { key: 'history', label: '历史' },
];

const HISTORY_STATUSES: ReservationStatus[] = ['completed', 'cancelled', 'no_show'];

/**
 * 待签到宽限（开始后必须签到的分钟数）。
 * ⚠️ 取自 `config/constants.ts`，与云端 expireRecords / roomList / createReservation 同源，
 *    以前这里是写死的 15，任何一处改了都不会被发现。
 */
const GRACE_MS = CHECKIN_TIMEOUT_MINUTES * 60 * 1000;
/** 暂离保留时长（分钟），同样与云端同源 */
const LEAVE_LIMIT_MS = LEAVE_TIMEOUT_MINUTES * 60 * 1000;
/** 剩余不足该时长即升级为红色「即将释放」警示 */
const URGENT_MS = 5 * 60 * 1000;

function isHistory(status: ReservationStatus): boolean {
  return HISTORY_STATUSES.includes(status);
}

function fmtRemaining(ms: number): string {
  if (ms <= 0) return '0 分钟';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return '不足 1 分钟';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
}

/**
 * 卡片操作：主行动 + 折叠次级。
 *
 * 每个状态只给**一个**主行动——用户第一眼就知道该干什么：
 *   待签到 → 签到（定位/围栏，必要时补店内码）
 *   使用中 → 签退（行业叫「退座」，签退记履约 +1）
 *   暂离中 → 返回座位
 *   已完成 → 评价
 * 改约 / 取消 / 暂离 / 续时这些低频或破坏性操作一律收进「更多」。
 */
function buildActionList(status: ReservationStatus): { primary: ActionItem | null; more: ActionItem[] } {
  if (status === 'pending_checkin') {
    return {
      primary: { type: 'checkin', label: '签到' },
      more: [
        { type: 'reschedule', label: '改约' },
        { type: 'cancel', label: '取消预约' },
      ],
    };
  }
  if (status === 'active') {
    return {
      primary: { type: 'checkout', label: '签退' },
      more: [
        { type: 'leave', label: '暂离' },
        { type: 'extend', label: '续时' },
      ],
    };
  }
  if (status === 'paused') {
    return {
      primary: { type: 'return', label: '返回座位' },
      more: [{ type: 'checkout', label: '签退' }],
    };
  }
  if (status === 'completed') {
    return { primary: { type: 'review', label: '评价' }, more: [] };
  }
  return { primary: null, more: [] };
}

/**
 * 可评价口径 —— 与云函数 submitReview 的 isReviewable 必须同值，改一处必须改两处：
 * ① status === 'completed'
 * ② status === 'active' 但 end_at 已过（视为已结束）
 * ② 是 expireRecords 定时器未部署时的兜底，否则用户永远等不到「已完成」。
 */
function canReviewOf(record: BusinessRecord, now: number): boolean {
  const status = record.status as ReservationStatus;
  if (status === 'completed') return true;
  if (status !== 'active') return false;
  const end = record.end_at ? new Date(record.end_at).getTime() : 0;
  return end > 0 && end <= now;
}

function rowOf(record: BusinessRecord, roomMap: Record<string, string>, reviewedIds: string[] = []): ReservationRow {
  const status = record.status as ReservationStatus;
  const goal =
    (record.payload && typeof (record.payload as { goal?: unknown }).goal === 'string'
      ? ((record.payload as { goal: string }).goal)
      : '');
  const seatLabel = record.seat_id ? toSeatDisplayName({ seat_id: record.seat_id }) : (record.seat_id || '座位');
  const roomName = (record.room_id && roomMap[record.room_id]) || '';

  // 时长即预约：状态提示
  const now = Date.now();
  const start = record.start_at ? new Date(record.start_at).getTime() : 0;
  const end = record.end_at ? new Date(record.end_at).getTime() : 0;
  let countdown = STATUS_LABEL[status] || status;
  let countdownLevel: ReservationRow['countdownLevel'] = 'done';
  let releaseAt = 0;
  let releaseText = '';
  let releaseLevel: ReservationRow['releaseLevel'] = '';
  let canCheckin = false;
  /** 展示用状态（默认等于服务端状态，超时未签到时升级为 no_show） */
  let displayStatus: ReservationStatus = status;

  if (status === 'pending_checkin') {
    // 违约倒计时：开始后 CHECKIN_TIMEOUT_MINUTES 分钟内未签到 → 服务端判违约并释放座位
    releaseAt = start ? start + GRACE_MS : 0;
    const overdue = releaseAt > 0 && now > releaseAt;
    if (overdue) {
      // 已过签到时限：徽标同步显示「已违约」。
      // 服务端要等 expireRecords 定时器才翻状态，之前徽标一直写「待签到」、
      // 正文却写「已超过签到时限」，自相矛盾。
      displayStatus = 'no_show';
      countdown = '已超过签到时限，座位已释放';
      countdownLevel = 'done';
    } else if (now < start - GRACE_MS) {
      countdown = `距开始还有 ${fmtRemaining(start - now)}`;
      countdownLevel = 'idle';
    } else {
      countdown = `可签到 · ${fmtRemaining(end - now)}后结束`;
      countdownLevel = 'soon';
    }
    // 记录当前「可学习」的进行中预约：学习页（study.ts）据此自动关联座位
    if (!overdue && now >= start - GRACE_MS) {
      setActiveReservation(record);
    }
    if (releaseAt) {
      const remain = releaseAt - now;
      if (remain <= 0) {
        releaseLevel = 'released';
        releaseText = `已超过签到时限（开始后 ${CHECKIN_TIMEOUT_MINUTES} 分钟），座位已释放，本条记为违约`;
      } else {
        releaseLevel = remain <= URGENT_MS ? 'danger' : 'warn';
        releaseText = `未签到将在 ${fmtRemaining(remain)}后自动释放座位并记违约`;
      }
    }
    // 与服务端口径一致：超过释放时刻后不再允许签到，否则会和已抢到该座位的人重复占座
    canCheckin = releaseLevel !== 'released';
  } else if (status === 'active') {
    countdown = now > end ? '已超时使用' : `使用中 · ${fmtRemaining(end - now)}后结束`;
    countdownLevel = now > end ? 'done' : 'active';
  } else if (status === 'paused') {
    // 暂离计时从最后一次状态变更（暂离动作）算起，与 roomList 的 updated_at 口径一致
    const pausedAt = record.updated_at ? new Date(record.updated_at).getTime() : 0;
    releaseAt = pausedAt ? pausedAt + LEAVE_LIMIT_MS : 0;
    if (releaseAt) {
      const remain = releaseAt - now;
      if (remain <= 0) {
        releaseLevel = 'released';
        displayStatus = 'no_show';
        releaseText = `暂离已超过 ${LEAVE_TIMEOUT_MINUTES} 分钟，座位已释放，本条记为违约`;
        countdown = '暂离超时 · 座位已释放';
        countdownLevel = 'done';
      } else {
        releaseLevel = remain <= URGENT_MS ? 'danger' : 'warn';
        releaseText = `暂离超时将自动释放座位并记违约，剩余 ${fmtRemaining(remain)}`;
        countdown = `暂离中 · 座位保留 ${LEAVE_TIMEOUT_MINUTES} 分钟`;
        countdownLevel = 'idle';
      }
    } else {
      countdown = `暂离中 · 座位保留 ${LEAVE_TIMEOUT_MINUTES} 分钟`;
      countdownLevel = 'idle';
    }
  }

  // 超过签到时限后，签到类按钮已无意义（服务端会拒绝），直接从操作区移除；
  // 暂离超时后「返回座位」同样失效（服务端 status 已翻 no_show），一并隐藏，避免点了被拒。
  const reviewed = reviewedIds.indexOf(record._id as string) >= 0;
  const canReview = canReviewOf(record, now) && !reviewed;

  const built = buildActionList(status);
  // 超过签到时限后，签到按钮已无意义（服务端会拒绝），直接移除；
  // 暂离超时后「返回座位」同样失效（服务端已翻 no_show），一并隐藏，避免点了被拒。
  const keep = (act: ActionItem): boolean => {
    if (act.type === 'checkin' && !canCheckin) return false;
    if (act.type === 'return' && releaseLevel === 'released') return false;
    if (act.type === 'review') return canReview;
    return true;
  };
  const primary = built.primary && keep(built.primary) ? built.primary : null;
  const more = built.more.filter(keep);
  // 「使用中但已过结束时间」也可评价（buildActionList 只认 completed，这里补进「更多」）
  if (canReview && status === 'active' && !more.some((act) => act.type === 'review')) {
    more.push({ type: 'review', label: '评价' });
  }

  return {
    _id: record._id,
    room_id: record.room_id,
    roomName,
    seatLabel,
    seat_id: record.seat_id,
    startLabel: record.start_at ? formatDateTime(record.start_at) : '',
    endLabel: record.end_at ? formatDateTime(record.end_at) : '',
    goal,
    status,
    displayStatus,
    statusLabel: STATUS_LABEL[displayStatus] || status,
    countdown,
    countdownLevel,
    releaseAt,
    releaseText,
    releaseLevel,
    canCheckin,
    primary,
    more,
    // 续时：仅 active 且距离打烊尚有空间时提供；剩余 < 60 分钟高亮
    canExtend: status === 'active' && now < end,
    extendOptions: [30, 60, 90],
    canReview,
    reviewed,
  };
}

Page({
  data: {
    tabs: TABS,
    activeTab: 'all' as TabKey,
    activeLabel: '全部',
    loading: false,
    submitting: false,
    items: [] as ReservationRow[],
    raw: [] as BusinessRecord[],
    roomMap: {} as Record<string, string>,
    loadError: '',
    upcoming: null as { seatLabel: string; text: string } | null,
    /** 当前展开「更多」的卡片 _id；空串表示全部收起（同一时刻最多展开一张） */
    expandedId: '',
    /**
     * 唯一弹层开关：'' | 'cancel' | 'extend' | 'review' | 'reschedule'
     * （弹层为页面自绘：原生 wx.showModal 的 await 会丢失点击手势，之后调
     *  wx.requestSubscribeMessage 会报 can only be invoked by user TAP gesture）
     */
    sheet: '' as SheetKey,
    cancelId: '',
    cancelIsActive: false,
    cancelTitle: '',
    cancelText: '',
    cancelConfirmText: '',
    // 改约抽屉
    rescheduleId: '',
    rescheduleSeat: '',
    rescheduleStart: '',          // 改约日期（默认今天）
    rescheduleStartTime: '',       // 改约开始时间（默认当前时刻）
    rescheduleStartMin: '',
    rescheduleStartMax: '',
    // 续时弹层
    extendId: '',
    extendSeat: '',
    // 评价弹层
    /** 本次会话内已提交过评价的预约 _id（收起「评价」按钮，避免重复弹窗） */
    reviewedIds: [] as string[],
    reviewId: '',
    reviewSeat: '',
    reviewStars: 5,
    reviewContent: '',
    reviewSubmitting: false,
  },

  _timer: undefined as ReturnType<typeof setInterval> | undefined,

  onShow() {
    // 回到页面时收起可能残留的弹层，避免它跟着页面一起被"看见"
    if (this.data.sheet) this.setData({ sheet: '' });
    this.load();
    this.startTicker();
  },

  onHide() {
    this.stopTicker();
  },

  onUnload() {
    this.stopTicker();
  },

  startTicker() {
    this.stopTicker();
    this._timer = setInterval(() => this.rebuild(), 30000);
  },

  stopTicker() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  },

  onPullDownRefresh() {
    this.load()
      .then(() => wx.stopPullDownRefresh())
      .catch(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: true });
    try {
      const [records, rooms] = await Promise.all([
        listMyReservations({ limit: 100 }),
        listRooms().catch(() => []),
      ]);
      const roomMap: Record<string, string> = {};
      (rooms || []).forEach((r) => {
        if (r.room_id) roomMap[r.room_id] = r.name;
      });
      this.setData({ raw: records, roomMap, loading: false, loadError: '' });
      this.rebuild();
    } catch (err) {
      this.setData({ loading: false, loadError: String(((err as { message?: string }) || {}).message || '加载预约失败') });
    }
  },

  /** 依据当前 tab 过滤 + 实时倒计时重算 */
  rebuild() {
    const tab = this.data.activeTab;
    let filtered = this.data.raw;
    if (tab === 'history') {
      filtered = filtered.filter((r) => isHistory(r.status as ReservationStatus));
    } else if (tab !== 'all') {
      filtered = filtered.filter((r) => r.status === tab);
    }
    const items = filtered.map((r) => rowOf(r, this.data.roomMap, this.data.reviewedIds));
    // 即将开始提醒：待签到里最近一个 30 分钟内开始的
    const soon = this.data.raw
      .filter((r) => r.status === 'pending_checkin' && r.start_at)
      .map((r) => ({ r, start: new Date(r.start_at as string).getTime() }))
      .filter((x) => x.start - Date.now() <= 30 * 60 * 1000)
      .sort((a, b) => a.start - b.start)[0];
    const upcoming = soon
      ? {
          seatLabel: soon.r.seat_id ? toSeatDisplayName({ seat_id: soon.r.seat_id }) : '座位',
          text: `将在 ${fmtRemaining(soon.start - Date.now())}后开始`,
        }
      : null;
    this.setData({ items, upcoming });
  },

  onSwitchTab(e: WechatMiniprogram.BaseEvent) {
    const key = String(
      (e.currentTarget.dataset as { key?: string }).key || 'all',
    ) as TabKey;
    if (key === this.data.activeTab) return;
    const labelMap: Record<TabKey, string> = {
      all: '全部',
      pending_checkin: '待签到',
      active: '使用中',
      history: '历史',
    };
    this.setData({ activeTab: key, activeLabel: labelMap[key], sheet: '', expandedId: '' }, () => {
      this.rebuild();
    });
  },

  onRetryLoad() {
    this.load();
  },

  /** 弹层面板内容区的点击占位（catch:tap 阻止冒泡到遮罩关闭） */
  noop() {
    // intentionally empty
  },

  goSeatMap(e: WechatMiniprogram.BaseEvent) {
    const roomId = String((e.currentTarget.dataset as { roomId?: string }).roomId || '');
    const roomName = String((e.currentTarget.dataset as { roomName?: string }).roomName || '');
    if (!roomId) return;
    wx.navigateTo({ url: `/subpages/seats/seats?roomId=${encodeURIComponent(roomId)}&name=${encodeURIComponent(roomName)}` });
  },

  /** 手动签到：需要到店签到码时自动弹输入框 */
  /** 「更多」折叠开关：同一时刻最多展开一张卡 */
  onToggleMore(e: WechatMiniprogram.BaseEvent) {
    const id = String((e.currentTarget.dataset as { id?: string }).id || '');
    this.setData({ expandedId: this.data.expandedId === id ? '' : id });
  },

  /**
   * 操作区分发：主按钮与「更多」里的按钮都带 data-type，由这里转给具体 handler。
   * 转发是**同步**调用，handler 内部若涉及订阅授权（取消预约）仍处于真实点击手势内，
   * 不会触发 `can only be invoked by user TAP gesture`。
   */
  onAction(e: WechatMiniprogram.BaseEvent) {
    const type = String((e.currentTarget.dataset as { type?: string }).type || '');
    if (this.data.submitting) return;
    switch (type) {
      case 'checkin':
        void this.onCheckin(e);
        break;
      case 'checkout':
      case 'cancel':
        this.onCancel(e);
        break;
      case 'leave':
        void this.onLeave(e);
        break;
      case 'return':
        void this.onReturn(e);
        break;
      case 'extend':
        this.onExtend(e);
        break;
      case 'reschedule':
        this.onReschedule(e);
        break;
      case 'review':
        this.onReview(e);
        break;
      default:
        break;
    }
  },

  /** 签到：唯一入口。先取 gcj02 坐标交云端判围栏，云端要求店内码时才补弹输入框 */
  async onCheckin(e: WechatMiniprogram.BaseEvent) {
    const id = String((e.currentTarget.dataset as { id?: string }).id || '');
    if (!id || this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      const done = await checkinWithCode(id);
      if (done) {
        // 埋点：签到成功（用户点按钮，实际到店校验由云端围栏完成）
        const rec = this.data.raw.find((r) => r._id === id);
        trackCheckinDone((rec && rec.room_id) || '', 'manual');
        this.setData({ expandedId: '' });
        await this.load();
      }
    } catch (err) {
      showBusinessError(err, '签到失败');
    } finally {
      this.setData({ submitting: false });
    }
  },

  // 2026-09-19：按用户要求移除「扫码签到」按钮 —— 签到只保留定位（围栏）单一入口。
  // 扫店内座位码进入签到页的深链（subpages/checkin/checkin?rid=xxx）依旧可用，
  // 那是**被动**入口（用户扫码自动拉起），不需要在卡片上占一个按钮位。

  async onLeave(e: WechatMiniprogram.BaseEvent) {
    const id = String((e.currentTarget.dataset as { id?: string }).id || '');
    if (!id || this.data.submitting) return;
    const res = await wx.showModal({
      title: '暂离座位',
      content: '暂离后座位将保留 30 分钟，超时自动回到使用中。确定暂离吗？',
      confirmText: '暂离',
      cancelText: '再想想',
    });
    if (!res.confirm) return;
    this.setData({ submitting: true });
    try {
      await leaveSeat(id);
      wx.showToast({ title: '已暂离', icon: 'success' });
      await this.load();
    } catch (err) {
      showError(err, '暂离失败');
    } finally {
      this.setData({ submitting: false });
    }
  },

  async onReturn(e: WechatMiniprogram.BaseEvent) {
    const id = String((e.currentTarget.dataset as { id?: string }).id || '');
    if (!id || this.data.submitting) return;
    this.setData({ submitting: true });
    try {
      await returnSeat(id);
      wx.showToast({ title: '已返回座位', icon: 'success' });
      await this.load();
    } catch (err) {
      showError(err, '返回座位失败');
    } finally {
      this.setData({ submitting: false });
    }
  },

  /** 续时弹层：展示时长选项（30/60/90 分钟），用户点选后调用云端 */
  onExtend(e: WechatMiniprogram.BaseEvent) {
    const id = String((e.currentTarget.dataset as { id?: string }).id || '');
    if (!id || this.data.submitting) return;
    const rec = this.data.raw.find((r) => r._id === id);
    if (!rec) {
      // 不做静默 return：静默会被用户当成"点了没反应"
      wx.showToast({ title: '预约数据已变化，请下拉刷新', icon: 'none' });
      return;
    }
    this.setData({ sheet: 'extend', extendId: id, extendSeat: rec.seat_id || '' });
  },

  onCloseExtend() {
    this.setData({ sheet: '' });
  },

  /** 选择续时时长并提交（30/60/90 分钟） */
  async onExtendConfirm(e: WechatMiniprogram.CustomEvent<{ minutes: string }>) {
    const minutes = Number(e.currentTarget?.dataset?.minutes);
    if (!minutes || this.data.submitting) return;
    const id = this.data.extendId;
    if (!id) {
      // 兜底：弹层处于"没有目标预约"的脏状态时，明确告知而非静默无反应
      this.setData({ sheet: '' });
      wx.showToast({ title: '请重新点「续时」选择预约', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      await extendReservation(id, minutes);
      this.setData({ sheet: '' });
      wx.showToast({ title: `已续时 ${minutes} 分钟`, icon: 'success' });
      const extRec = this.data.raw.find((r) => r._id === id);
      trackExtend((extRec && extRec.room_id) || '', minutes);
      await this.load();
    } catch (err) {
      showBusinessError(err, '续时失败');
    } finally {
      this.setData({ submitting: false });
    }
  },

  /* 评价：已完成预约可点评座位（弹层选星）+ 可选一句评价 */
  onReview(e: WechatMiniprogram.BaseEvent) {
    const id = String((e.currentTarget.dataset as { id?: string }).id || '');
    const rec = this.data.raw.find((r) => r._id === id);
    if (!rec) {
      // 不做静默 return：静默会被用户当成"点了没反应"
      wx.showToast({ title: '预约数据已变化，请下拉刷新', icon: 'none' });
      return;
    }
    if (this.data.reviewedIds.indexOf(id) >= 0) {
      wx.showToast({ title: '这单已评价过啦', icon: 'none' });
      return;
    }
    if (!canReviewOf(rec, Date.now())) {
      wx.showToast({ title: '用完座位后才能评价', icon: 'none' });
      return;
    }
    this.setData({
      sheet: 'review',
      reviewId: id,
      reviewSeat: rec.seat_id ? toSeatDisplayName({ seat_id: rec.seat_id }) : '该座位',
      reviewStars: 5,
      reviewContent: '',
    });
  },

  onCloseReview() {
    if (this.data.reviewSubmitting) return;
    this.setData({ sheet: '' });
  },

  /** 选择星数 */
  onReviewStars(e: WechatMiniprogram.BaseEvent) {
    const v = Number((e.currentTarget.dataset as { star?: string }).star);
    if (v >= 1 && v <= 5) this.setData({ reviewStars: v });
  },

  /** 评价文字输入 */
  onReviewContent(e: WechatMiniprogram.Input) {
    const v = String(e.detail?.value || '').slice(0, 200);
    this.setData({ reviewContent: v });
  },

  /** 提交评价 */
  async onSubmitReview() {
    const id = this.data.reviewId;
    if (this.data.reviewSubmitting) return;
    if (!id) {
      // 兜底：无目标预约时明确告知，避免"点了没反应"
      this.setData({ sheet: '' });
      wx.showToast({ title: '请重新点「评价」选择预约', icon: 'none' });
      return;
    }
    this.setData({ reviewSubmitting: true });
    try {
      const res = await submitReview({ record_id: id, rating: this.data.reviewStars, content: this.data.reviewContent });
      // 收起弹层 + 记住已评价（刷新前不再重复弹）
      const reviewedIds = this.data.reviewedIds.indexOf(id) >= 0
        ? this.data.reviewedIds
        : this.data.reviewedIds.concat(id);
      this.setData({ sheet: '', reviewedIds });
      wx.showToast({ title: res.already ? '这单已评价过' : '评价成功', icon: 'success' });
      this.rebuild();
    } catch (err) {
      // ⚠️ 不用 showError：它把文案截成 7 个字，云端的「请确认已创建 reviews 集合」
      // 会变成看不懂的半句话。showBusinessError 文案长时自动改弹窗，能看全。
      showBusinessError(err, '评价提交失败');
    } finally {
      this.setData({ reviewSubmitting: false });
    }
  },

  /**
   * 点「取消预约」/「结束使用」：只打开自绘确认弹层（纯同步，不 await）。
   *
   * ⚠️ 不用 wx.showModal 的原因：原生确认框的 await 会让后续订阅授权调用
   * 脱离点击手势 → 微信报 `fail can only be invoked by user TAP gesture`，
   * 授权卡一张都弹不出来（2026-09-16 真机实测）。
   */
  onCancel(e: WechatMiniprogram.BaseEvent) {
    const id = String((e.currentTarget.dataset as { id?: string }).id || '');
    if (!id || this.data.submitting) return;
    // 语义正名（2026-09-19）：已签到使用中的出口叫「签退」（行业称「退座」，
    // 签退是**履约成功**并计数），只有未开始的才是「取消预约」。
    // 之前这里叫「结束使用」，走的是取消语义，把正向反馈吃掉了。
    const rec = this.data.raw.find((r) => r._id === id);
    const isActive = !!rec && (rec.status === 'active' || rec.status === 'paused');
    this.setData({
      sheet: 'cancel',
      cancelId: id,
      cancelIsActive: isActive,
      cancelTitle: isActive ? '签退' : '取消预约',
      cancelText: isActive ? '签退后座位立即释放，并为你记录 1 次履约。' : '确定要取消这次预约吗？',
      cancelConfirmText: isActive ? '确认签退' : '确认取消',
    });
  },

  /** 关闭确认弹层（点「再想想」或遮罩） */
  onCloseCancel() {
    this.setData({ sheet: '' });
  },

  /**
   * 确认取消 / 结束使用。
   *
   * ⚠️ `requestCancelSubscribes()` 必须是本回调的**第一条语句**（前面不能有 await）：
   * 它内部第一句就是 wx.requestSubscribeMessage，只有在这个真实点击手势里同步触达，
   * 微信才会弹授权卡。另外「结束使用」（active/paused）不发取消通知，故不申请授权，
   * 避免白弹一次卡。
   */
  onConfirmCancel() {
    const id = this.data.cancelId;
    if (!id || this.data.submitting) return;
    const isActive = this.data.cancelIsActive;
    const pending = isActive ? null : requestCancelSubscribes();
    this.setData({ sheet: '' });
    void this.doCancel(id, isActive, pending);
  },

  /** 真正执行取消/结束（这里已离开点击手势，可放心 await） */
  async doCancel(id: string, isActive: boolean, pending: Promise<SubscribeOutcome> | null) {
    if (pending) await pending;
    this.setData({ submitting: true });
    try {
      const updated = await cancelReservation(id);
      const isCheckout = updated.status === 'completed';
      wx.showToast({ title: isCheckout ? '已签退' : '已取消', icon: 'success' });
      // 签退 = 履约一次，云端会 +1 到用户档案。静默重新登录拉最新值，
      // 否则「我的」页的累计履约会一直停在旧值（与签到 streak 同一个坑）。
      if (isCheckout) {
        void login().catch(() => {});
      }
      // 取消 / 结束时同步清掉「进行中」缓存，避免学习页拿到失效的预约
      // ⚠️ 「预约取消通知」④ 由云端 cancelReservation 统一发送（见 cloudfunctions/cancelReservation），
      // 前端不再重复发，避免一次性订阅额度被双发浪费。
      setActiveReservation(null);
      await this.load();
    } catch (err) {
      showError(err, isActive ? '结束失败' : '取消失败');
    } finally {
      this.setData({ submitting: false });
    }
  },

  // —— 改约 ——
  onReschedule(e: WechatMiniprogram.BaseEvent) {
    const id = String((e.currentTarget.dataset as { id?: string }).id || '');
    const rec = this.data.raw.find((r) => r._id === id);
    if (!rec || !rec.start_at) return;
    // 座位名从记录里算，不再依赖 wxml 传 data-seat（走 onAction 转发后 dataset 只有 id/type）
    const seat = rec.seat_id ? toSeatDisplayName({ seat_id: rec.seat_id }) : '该座位';
    const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
    const toDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const toTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const now = new Date();
    // 默认改约到“现在”：日期=今天，开始时间=当前时刻（不再沿用原预约时间）
    this.setData({
      sheet: 'reschedule',
      rescheduleId: id,
      rescheduleSeat: seat,
      rescheduleStart: toDate(now),
      rescheduleStartTime: toTime(now),
      rescheduleStartMin: toDate(now),
      rescheduleStartMax: toDate(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)),
    });
  },

  onRescheduleStartChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ rescheduleStart: String(e.detail.value) });
  },

  onRescheduleStartTimeChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ rescheduleStartTime: String(e.detail.value) });
  },

  onCloseReschedule() {
    this.setData({ sheet: '' });
  },

  async onConfirmReschedule() {
    const { rescheduleId, rescheduleStart, rescheduleStartTime } = this.data;
    if (!rescheduleId) {
      this.setData({ sheet: '' });
      wx.showToast({ title: '请重新点「改约」选择预约', icon: 'none' });
      return;
    }
    const [yy, mm, dd] = rescheduleStart.split('-').map(Number);
    const [hh, mi] = rescheduleStartTime.split(':').map(Number);
    const startIso = new Date(yy, mm - 1, dd, hh, mi).toISOString();
    const endIso = new Date(yy, mm - 1, dd, hh + 2, mi).toISOString();
    if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
      wx.showToast({ title: '结束需晚于开始', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    try {
      // 改约 = 新的预约时段，需重新申请「预约成功通知」授权（一次性订阅额度已用完）。
      // 必须在手势内、任意 await 之前同步唤起（与创建预约同理）。
      requestReservationConfirmSubscribes();
      const updated = await updateReservation({ record_id: rescheduleId, start_at: startIso, end_at: endIso });
      this.setData({ sheet: '', submitting: false });
      // 改约后原预约起始时间变了，置空由下次 rebuild 按最新记录重写
      setActiveReservation(null);
      wx.showToast({ title: '改约成功', icon: 'success' });
      // 改约成功后复用 ① 预约成功通知，告知用户新的预约时段（授权已在上方手势内申请）
      void notifyReservationConfirmed(updated, {
        seatLabel: this.data.rescheduleSeat || undefined,
      });
      await this.load();
    } catch (err) {
      this.setData({ submitting: false });
      // 开放时段等长文案走弹窗，避免 toast 7 字截断
      showBusinessError(err, '改约失败');
    }
  },
});
