import { listRooms, describeRoomSource, isRealtimeSeats } from '../../services/room';
import { getCachedUser, refreshUser } from '../../services/auth';
import { showBusinessError, showError } from '../../utils/error';
import { createReservation, listMyReservations } from '../../services/record';
import {
  requestReservationConfirmSubscribes,
  notifyReservationConfirmed,
} from '../../services/notify';
import { toSeatDisplayName, seatFeatures } from '../../utils/seatName';
import type { SeatDef } from '../../types/room';
import type { BusinessRecord } from '../../types/record';
import { floorPlans } from '../../config/floorPlans';
import { planBookingWindow, windowToIso } from '../../utils/bookingWindow';
import { trackRoomEnter, trackSeatTap, trackBookingConfirm } from '../../utils/analytics';

/** 座位状态轮询间隔（ms）：watch 断连/不支持时的兜底 */
const POLL_INTERVAL = 15000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function clearPoll() {
  if (pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * 房间文档（categories）实时监听器。
 * 云函数（createReservation/cancelReservation/checkin/leaveSeat/expireRecords/
 * updateReservation）在占用状态变更后 bump `presence` 版本戳，前端 watch 到变化
 * 立即静默重拉 roomList —— 座位占用仍是 roomList 唯一权威源，本监听只是「快进键」。
 */
let roomWatcher: { close: () => void } | null = null;

function clearWatch() {
  if (roomWatcher != null) {
    try {
      roomWatcher.close();
    } catch {
      // 关闭失败无碍：轮询兜底
    }
    roomWatcher = null;
  }
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function localParts(d: Date): { date: string; time: string } {
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/** 时长文案：整小时说「N 小时」，否则说「N 分钟」（截断后常出现 86 分钟这种非整点值） */
function durationLabel(minutes: number): string {
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}

/** 北京时间（UTC+8）日期时间标注：与云端 createReservation 的时区口径一致 */
function bjDateTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`;
}

/** 本人预约状态 → 中文标签 */
function reservationStatusLabel(status?: string): string {
  if (status === 'active') return '使用中';
  if (status === 'paused') return '暂离中';
  return '待签到';
}

interface DurationOption {
  label: string;
  minutes: number;
}

/** 房间 code 前缀 / 关键词 → floorPlans key 映射表 */
const ROOM_FLOORPLAN_MAP: Record<string, string> = {
  library: 'library',
  teaching: 'classroom',
  cafe: 'coffee-corner',
  coffee: 'coffee-corner',
};

/** 特征筛选：''=全部，window=靠窗，power=有电源，both=靠窗+电源（AND） */
type FeatureFilter = '' | 'window' | 'power' | 'both';

const FILTER_OPTIONS: Array<{ key: FeatureFilter; label: string }> = [
  { key: '', label: '全部' },
  { key: 'window', label: '靠窗' },
  { key: 'power', label: '有电源' },
  { key: 'both', label: '靠窗+电源' },
];

const FILTER_NAME: Record<string, string> = { window: '靠窗', power: '有电源', both: '靠窗+电源' };

function hasWindowFeature(features?: string[]): boolean {
  return (features || []).some((f) => f === 'window');
}

function hasPowerFeature(features?: string[]): boolean {
  // outlet 是管理端批量新增座位时的电源标识，与 seed 数据的 power 同义
  return (features || []).some((f) => f === 'power' || f === 'outlet');
}

function matchFeatureFilter(features: string[] | undefined, filter: FeatureFilter): boolean {
  if (filter === 'window') return hasWindowFeature(features);
  if (filter === 'power') return hasPowerFeature(features);
  if (filter === 'both') return hasWindowFeature(features) && hasPowerFeature(features);
  return false;
}

/** 根据房间 code 匹配平面图配置（无匹配则返回 null 走网格模式） */
function resolveFloorPlan(roomCode: string): (typeof floorPlans)[string] | null {
  if (!roomCode) return null;
  // 精确匹配 key
  if (floorPlans[roomCode]) return floorPlans[roomCode];
  // 按映射表匹配（取 code 下划线前段或全量关键词）
  const prefix = roomCode.split('_')[0];
  const key = ROOM_FLOORPLAN_MAP[prefix] || ROOM_FLOORPLAN_MAP[roomCode];
  return key ? floorPlans[key] : null;
}

Page({
  data: {
    roomId: '',
    roomName: '座位平面图',
    seats: [] as Array<SeatDef & { status: string; mine?: boolean; mineStatus?: string; mineStart?: string; mineEnd?: string }>,
    /** 本人本房间的活跃/即将开始的预约（pending_checkin/active/paused），用于座位图上标「我的」 */
    myReservations: [] as BusinessRecord[],
    loading: false,
    startMode: 'now' as 'now' | 'later',
    startDate: '',
    startTime: '',
    durationIndex: 1,
    durations: [
      { label: '1 小时', minutes: 60 },
      { label: '2 小时', minutes: 120 },
      { label: '3 小时', minutes: 180 },
      { label: '4 小时', minutes: 240 },
    ] as DurationOption[],
    endDate: '',
    endTime: '',
    /** 手动选择的结束时间（HH:mm）；仅在 durationIndex === -1（自定义）时生效 */
    manualEndTime: '',
    windowLabel: '',
    /** 时段被自动截断/顺延时的说明（空串 = 无需提示） */
    windowNote: '',
    /** 本房间开放时段（来自云端 roomList 的 room.category metadata） */
    openTime: '',
    closeTime: '',
    minDate: '',
    maxDate: '',
    occupancyText: '',
    /** 是否为 roomList 实时占用数据；false 时座位颜色不可信，页面必须显式标注 */
    realtime: true,
    openTimeText: '', // 本自习室开放时段（如「08:00-22:00」，抽屉信息行展示用）
    // —— 底部抽屉（选座确认）——
    detailVisible: false,
    detailSeatId: '',
    detailName: '',
    detailFeatures: [] as string[],
    /** 抽屉里展示的口碑：均分（0=无人评价）与评价条数 */
    detailRating: 0,
    detailReviewCount: 0,
    submitting: false,
    /** 首页推荐入口带 seat 参数直达：进入后自动展开该座位确认抽屉 */
    pendingSeat: '',
    // —— 平面图模式（根据房间 code 自动匹配，null 则走网格模式）——
    floorPlan: null as (typeof floorPlans)[string] | null,
    // —— 特征筛选（高亮靠窗/有电源座位）——
    featureFilter: '' as FeatureFilter,
    filterOptions: FILTER_OPTIONS,
    highlightHint: '',
    demoNotice: '',
    /** 违约禁约提示（非空 = 当前账号被禁约，进场横幅 + 点座位拦截） */
    banNotice: '',
  },

  /** 从服务端最新档案读禁约状态；返回给横幅与点击拦截共用 */
  async refreshBanNotice() {
    // 先用服务端最新档案覆盖本地缓存：管理端解封 / 封禁自然到期后，
    // 本地缓存里残留的 bannedUntil 不会自动清空，必须主动拉一次才能解除拦截。
    try {
      await refreshUser();
    } catch {
      // 刷新失败：退化为读旧缓存，至少不比现在更糟
    }
    const bannedUntil = getCachedUser()?.bannedUntil || '';
    const until = bannedUntil ? new Date(bannedUntil).getTime() : 0;
    if (!until || Number.isNaN(until) || until <= Date.now()) {
      this.setData({ banNotice: '' });
      return;
    }
    const mins = Math.ceil((until - Date.now()) / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const text = h > 0 ? `${h} 小时 ${m} 分` : `${mins} 分钟`;
    this.setData({ banNotice: `因违约过多，你已被禁约，${text}内暂不可预约（可先浏览座位）` });
  },

  /** onLoad 已初始化；onShow 在页面再次可见时（预约/签到返回、退出后台重进）重新拉最新占用 */
  onShow() {
    this.refreshBanNotice();
    if (this.data.roomId) {
      this.loadMyReservations();
      this.loadSeats();
      this.startPoll();
      this.startWatch();
    }
  },

  onPullDownRefresh() {
    this.loadSeats(() => wx.stopPullDownRefresh());
  },

  onLoad(query: Record<string, string | undefined>) {
    const now = new Date();
    const startParts = localParts(now);
    const max = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    this.setData({
      roomId: query.roomId || '',
      roomName: query.name ? decodeURIComponent(query.name) : '座位平面图',
      startDate: startParts.date,
      startTime: startParts.time,
      minDate: localParts(now).date,
      maxDate: localParts(max).date,
      durationIndex: 1,
      // 兼容首页快捷入口 ?highlight=window/power → 直接落到对应筛选档
      featureFilter: (query.highlight === 'window' || query.highlight === 'power'
        ? query.highlight
        : '') as FeatureFilter,
      // 首页推荐座位直达：记录待展开座位，座位加载完成后自动展开确认抽屉
      pendingSeat: query.seat ? decodeURIComponent(query.seat) : '',
    });
    this.refreshBanNotice();
    this.recomputeWindow();
    this.loadMyReservations();
    this.loadSeats();
    this.startPoll();
    this.startWatch();
    // 埋点：进入选座页（带房间维度，便于分析各房转化）
    trackRoomEnter(query.roomId || '', query.name ? decodeURIComponent(query.name) : '');
  },

  /**
   * 当前生效的预约时段（已夹到自习室开放时段内）。
   * 查询座位占用、提交预约都必须以它为准，否则会出现「页面显示能约、一提交被拒」。
   * 纯函数、无副作用，可在 setData 落地之前安全调用。
   */
  currentWindow() {
    const idx = this.data.durationIndex;
    return planBookingWindow({
      startDate: this.data.startDate,
      startTime: this.data.startTime,
      durationMinutes: this.data.durations[idx]?.minutes || 120,
      manualEndTime: idx < 0 ? this.data.manualEndTime : '',
      openTime: this.data.openTime,
      closeTime: this.data.closeTime,
    });
  },

  /**
   * 重算并落地时段文案。
   * 核心行为：**能约多久就算多久** —— 结束时间越过打烊时间时截断到打烊，
   * 而不是像以前那样直接拒绝「预约时间须在 08:00-22:00 开放时段内」。
   */
  recomputeWindow() {
    const w = this.currentWindow();
    const custom = this.data.durationIndex < 0;
    this.setData({
      startDate: w.startDate,
      startTime: w.startTime,
      endDate: w.endDate,
      endTime: w.endTime,
      // 自定义结束时间被截断时同步手动值，避免「显示的」与「生效的」不一致
      manualEndTime: custom ? w.endTime : '',
      windowLabel: `${w.startDate} ${w.startTime} → ${w.endTime}（${durationLabel(w.durationMinutes)}）`,
      windowNote: w.note,
    });
  },

  /** 特征筛选按钮：纯本地重标高亮，座位特征不随占用变化，无需重新拉取 */
  onFilterTap(e: WechatMiniprogram.CustomEvent<{ key: string }>) {
    const key = String(e.currentTarget?.dataset?.key || '') as FeatureFilter;
    if (key === this.data.featureFilter) return;
    const filter = key;
    let highlightHint = '';
    const seats = this.data.seats.map((s) => ({
      ...s,
      highlighted: filter ? matchFeatureFilter(s.features, filter) : false,
    }));
    if (filter) {
      const matched = seats.filter((s) => s.highlighted).length;
      highlightHint = matched > 0
        ? `已标出 ${FILTER_NAME[filter]} 座位（${matched} 个）`
        : `当前时段无 ${FILTER_NAME[filter]} 座位`;
    }
    this.setData({ featureFilter: filter, seats, highlightHint });
  },

  /** 拉取本人本房间活跃/即将开始的预约，用于座位图标「我的」。失败不影响座位展示 */
  async loadMyReservations() {
    if (!this.data.roomId) return;
    try {
      const list = await listMyReservations({ limit: 50 });
      const mine = (list || []).filter(
        (r) => r.room_id === this.data.roomId && ['pending_checkin', 'active', 'paused'].includes(r.status),
      );
      this.setData({ myReservations: mine });
      // myReservations 可能晚于首次 loadSeats 到位，立刻把标记叠加到已渲染的座位上
      this.applyMineToSeats();
    } catch {
      // 拉取失败：退化为不标记「我的」，不影响正常选座
    }
  },

  /** 把 myReservations 的「我的」标记叠加到当前已渲染的座位上（不重新拉 roomList） */
  applyMineToSeats() {
    const seats = this.data.seats;
    if (!seats || !seats.length) return;
    const mineInfo = new Map<string, { status: string; start_at?: string; end_at?: string }>();
    (this.data.myReservations || [])
      .filter((r) => r.room_id === this.data.roomId && r.seat_id)
      .forEach((r) => mineInfo.set(r.seat_id as string, { status: r.status, start_at: r.start_at, end_at: r.end_at }));
    const next = seats.map((s) => {
      const info = mineInfo.get(s.seat_id);
      if (info) {
        return { ...s, mine: true, mineStatus: info.status, mineStart: info.start_at, mineEnd: info.end_at };
      }
      // 不标「我的」：清掉可能残留的标记（座位数据始终带 mine 字段，置 false 即可）
      return { ...s, mine: false, mineStatus: '', mineStart: '', mineEnd: '' };
    });
    this.setData({ seats: next });
  },

  // 显式标注返回类型：函数内部会递归调用自己（拿到开放时段后用截断时段重查一次）
  async loadSeats(done?: () => void, silent = false): Promise<void> {
    if (!this.data.roomId) {
      done?.();
      return;
    }
    if (!silent) this.setData({ loading: true });
    try {
      // 时段一律取自 currentWindow()：已按开放时段截断，
      // 保证「看到的时段」=「查询的时段」=「提交的时段」，三者口径统一
      const win = this.currentWindow();
      const startAt = windowToIso(win.startDate, win.startTime);
      const endAt = windowToIso(win.endDate, win.endTime);
      if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
        wx.showToast({ title: '结束时间需晚于开始时间', icon: 'none' });
        if (!silent) this.setData({ loading: false });
        done?.();
        return;
      }
      const rooms = await listRooms({ startAt, endAt });
      // ⚠️ 降级到 categoryList 时只有座位定义、没有实时占用：座位会一律显示空闲，
      // 但提交预约仍会被服务端按真实记录拦下。必须显式告知，否则用户只会觉得「系统坏了」。
      const realtime = isRealtimeSeats();
      const demoNotice = describeRoomSource();
      const room = rooms.find((item) => item.room_id === this.data.roomId);
      // 首次拿到本房间开放时段后，用截断后的时段重查一次：
      // 否则可能拿着「20:33→22:33」这个其实无效的时段去渲染座位占用
      const openTime = String((room && room.open_time) || '');
      const closeTime = String((room && room.close_time) || '');
      const hadWindow = !!(this.data.openTime || this.data.closeTime);
      if (openTime !== this.data.openTime || closeTime !== this.data.closeTime) {
        this.setData({ openTime, closeTime });
        // 开放时段首次到达/变化后必须补算展示文案：onLoad 时 open/close 还没到，
        // windowLabel/windowNote 是「未截断」的旧值（抽屉会显示越过打烊的 23:21 且无警示）。
        // 查询与提交走 currentWindow() 实时计算不受影响，这里修的是「看到的」口径。
        this.recomputeWindow();
        if (!hadWindow && (openTime || closeTime)) {
          return this.loadSeats(undefined, silent);
        }
      }
      const rawSeats = room?.seats || [];
      // 特征筛选：标记符合条件的座位（靠窗/有电源/两者兼具）+ 生成提示
      const filter = this.data.featureFilter;
      let highlightHint = '';
      const seats = rawSeats.map((s) => ({
        ...s,
        highlighted: filter ? matchFeatureFilter(s.features, filter) : false,
      }));
      if (filter) {
        const matched = seats.filter((s) => s.highlighted).length;
        highlightHint = matched > 0
          ? `已标出 ${FILTER_NAME[filter]} 座位（${matched} 个）`
          : `当前时段无 ${FILTER_NAME[filter]} 座位`;
      }
      // 叠加「我的预约」标记：与查看时段无关，只要本房间有本人活跃/即将开始的预约就标「我的」，
      // 这样退出后台重进、或浏览其他时段时，自己约过的座位也能一眼看到（不再误以为空闲）。
      const mineMap = new Map<string, { status: string; start_at?: string; end_at?: string }>();
      (this.data.myReservations || [])
        .filter((r) => r.room_id === this.data.roomId && r.seat_id)
        .forEach((r) => mineMap.set(r.seat_id as string, { status: r.status, start_at: r.start_at, end_at: r.end_at }));
      const seatsWithMine = seats.map((s) => {
        const m = mineMap.get(s.seat_id);
        return m ? { ...s, mine: true, mineStatus: m.status, mineStart: m.start_at, mineEnd: m.end_at } : { ...s, mine: false, mineStatus: '', mineStart: '', mineEnd: '' };
      });
      const freeCount = seatsWithMine.filter((s) => s.status === 'free' && !s.mine).length;
      // 平面图模式：根据房间 code 匹配底图，座位数量/坐标由真实 seats（row/col）动态生成
      const basePlan = resolveFloorPlan(room?.code || '');
      const floorPlan = basePlan
        ? {
            image: basePlan.image,
            seatSize: basePlan.seatSize,
            aspect: basePlan.aspect,
            bounds: basePlan.bounds,
            positions: basePlan.positions,
          }
        : null;
      this.setData({
        seats: seatsWithMine,
        floorPlan,
        // 非实时数据时不再报「空闲 N」：这个数字只是静态默认值，会误导用户以为能约
        occupancyText: realtime
          ? `所选时段空闲 ${freeCount} / 共 ${seatsWithMine.length}`
          : '座位占用状态暂不可用',
        realtime,
        highlightHint,
        demoNotice,
        openTimeText: openTime && closeTime ? `${openTime}-${closeTime}` : '',
        ...(silent ? {} : { loading: false }),
      });
      // 首页推荐座位直达：座位就绪后自动展开确认抽屉（空闲才弹，占用/维护/我的不弹）
      if (this.data.pendingSeat) {
        const target = this.data.pendingSeat;
        const seat = seatsWithMine.find((s) => s.seat_id === target);
        if (seat && seat.status === 'free' && !seat.mine) {
          this.openSeatDetail(seat);
        }
        this.setData({ pendingSeat: '' });
      }
    } catch (err) {
      // silent = 后台轮询/冲突后重拉：失败时绝不能弹错，否则 15s 一次的轮询会反复弹 toast
      if (!silent) {
        // 加载失败后页面上的座位颜色同样不可信，标记出来
        this.setData({ loading: false, realtime: false });
        showError(err, '加载座位失败，请先部署 roomList 云函数');
      }
    } finally {
      done?.();
    }
  },

  /** 启动座位状态轮询：定期拉取最新占用，弥补 watch 断连/不可用时的短板 */
  startPoll() {
    clearPoll();
    pollTimer = setInterval(() => {
      if (!this.data.roomId) return;
      this.loadSeats(undefined, true);
    }, POLL_INTERVAL);
  },

  /**
   * 监听本房间 categories 文档：任一云函数 bump 了 `presence` 版本戳
   * （有人预约/取消/签到/暂离/超时释放），立即静默重拉一次 roomList。
   * onError / onClose 一律静默降级到轮询，绝不抛错。
   */
  startWatch() {
    clearWatch();
    const roomId = this.data.roomId;
    if (!roomId) return;
    try {
      // categories 集合读权限放行全员（房间是公开信息），watch 成功后
      // 任何 bump（即使是别人的操作）都会触发 onSnapshot
      const db = wx.cloud.database();
      const watcher = db
        .collection('categories')
        .doc(roomId)
        // 只关注 presence/timestamp 字段，避免整文档内容参与对比
        .watch({
          onChange: () => {
            // 静默重拉：最终占用口径仍由 roomList 给出，这里不做任何本地推算
            this.loadSeats(undefined, true);
          },
          onError: () => {
            // watch 失败静默降级：15s 轮询兜底
          },
        });
      roomWatcher = watcher;
    } catch {
      // 低版本基础库无 watch 时静默降级轮询
      roomWatcher = null;
    }
  },

  onHide() {
    clearPoll();
    clearWatch();
  },

  onUnload() {
    clearPoll();
    clearWatch();
  },

  onStartModeChange(e: WechatMiniprogram.CustomEvent<{ mode: string }>) {
    const mode = (e.currentTarget?.dataset?.mode || 'now') as 'now' | 'later';
    if (mode === this.data.startMode) return;
    if (mode === 'now') {
      const start = new Date(Date.now() + 30 * 60 * 1000);
      const p = localParts(start);
      this.setData({ startMode: 'now', startDate: p.date, startTime: p.time }, () => {
        this.recomputeWindow();
        this.loadSeats();
      });
    } else {
      this.setData({ startMode: 'later' }, () => {
        this.loadSeats();
      });
    }
  },

  onStartDateChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ startDate: String(e.detail.value) }, () => {
      this.recomputeWindow();
      this.loadSeats();
    });
  },
  onStartTimeChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ startTime: String(e.detail.value) }, () => {
      this.recomputeWindow();
      this.loadSeats();
    });
  },

  onDurationTap(e: WechatMiniprogram.CustomEvent<{ index: string }>) {
    const index = Number(e.currentTarget?.dataset?.index);
    if (Number.isNaN(index) || index < 0) return;
    // 选回「时长」档即放弃手动结束时间
    this.setData({ durationIndex: index, manualEndTime: '' }, () => {
      this.recomputeWindow();
      this.loadSeats();
    });
  },

  /** 「自定义」档：时长由「开始 → 结束」反推，结束时刻点右侧时间选择器自由定 */
  onCustomDurationTap() {
    if (this.data.durationIndex === -1) return;
    this.setData({ durationIndex: -1, manualEndTime: this.data.endTime }, () => {
      this.recomputeWindow();
      this.loadSeats();
    });
    wx.showToast({ title: '点「结束」时间选择结束时刻', icon: 'none', duration: 1800 });
  },

  /**
   * 手动选择结束时间。
   * 时长档位切到「自定义」(-1)：此时时长由「开始 → 结束」反推，
   * 越过打烊时间会被自动截断，并在 windowNote 里说明。
   */
  onEndTimeChange(e: WechatMiniprogram.PickerChange) {
    const value = String(e.detail.value);
    this.setData({ durationIndex: -1, manualEndTime: value }, () => {
      this.recomputeWindow();
      this.loadSeats();
    });
  },

  async onSeatTap(e: WechatMiniprogram.CustomEvent<{ seatId: string }>) {
    // 诊断日志：真机上「点座位没反应」时，vConsole 里先看这行有没有出现——
    // 没有这行 = 事件根本没触发（渲染/遮挡问题）；有这行 = 往下看处理分支。
    console.info('[seats] seat tap', e?.detail, 'banNotice=', this.data.banNotice);
    // 禁约中：进场横幅已提示，点击座位再拦一次（否则填完抽屉提交才被拒）
    if (this.data.banNotice) {
      wx.showModal({
        title: '当前不可预约',
        content: `${this.data.banNotice}。可到「我的预约」按时到店签到避免违约，或联系商家处理。`,
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    const seatId = e?.detail?.seatId;
    const seat = seatId ? this.data.seats.find((item) => item.seat_id === seatId) : null;
    if (!seat) {
      // 兜底反馈：绝不允许「点了没任何反应」——数据未就绪时明确告知
      wx.showToast({ title: '座位数据未就绪，请下拉刷新', icon: 'none' });
      return;
    }
    // 「我的预约」座位：不再打开预约抽屉（否则会命中 USER_CONFLICT 报「你此时段已有预约」），
    // 而是明确告知这是你已约的座位，避免误以为空闲、反复重试。
    if (seat.mine) {
      const time = `${bjDateTime(seat.mineStart)} → ${bjDateTime(seat.mineEnd)}`;
      await wx.showModal({
        title: '这是你已预约的座位',
        content: `${seat.seat_id}\n时段：${time}\n状态：${reservationStatusLabel(seat.mineStatus)}\n\n如需调整，请到「我的预约」改约或取消。`,
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    if (seat.status !== 'free') {
      wx.showToast({ title: '该座位当前不可预约', icon: 'none' });
      return;
    }
    this.openSeatDetail(seat);
  },

  /** 展开某空闲座位的确认抽屉（事件点选 / 首页推荐直达共用） */
  openSeatDetail(seat: SeatDef & { status: string }) {
    // 展示名的计算绝不允许抛错中断弹层（失败时退回座位号）
    let displayName = seat.seat_id;
    let feats: string[] = [];
    try {
      displayName = toSeatDisplayName(seat);
      feats = seatFeatures(seat.features);
    } catch (err) {
      console.warn('[seats] seat display name fallback', err);
    }
    // 点空闲座位 → 底部抽屉一次确认（不再跳转到预约页）
    this.setData({
      detailVisible: true,
      detailSeatId: seat.seat_id,
      detailName: displayName,
      detailFeatures: feats,
      // 口碑回流：把大家对该座的评价显示出来，评价才有「被看见」的意义
      detailRating: Number(seat.rating) || 0,
      detailReviewCount: Number(seat.review_count) || 0,
    });
    try {
      trackSeatTap(seat.seat_id, this.data.roomId);
    } catch {
      // 埋点失败不影响主流程
    }
  },

  onCloseDetail() {
    this.setData({ detailVisible: false });
  },

  /** 抽屉内「立即预约」：直接调 createReservation，时长即预约，成功跳我的预约 */
  async onConfirmBooking() {
    const seatId = this.data.detailSeatId;
    if (!seatId || !this.data.roomId || this.data.submitting) return;
    if (this.data.banNotice) {
      this.setData({ detailVisible: false });
      wx.showModal({
        title: '当前不可预约',
        content: this.data.banNotice,
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }
    const win = this.currentWindow();
    const startAt = windowToIso(win.startDate, win.startTime);
    const endAt = windowToIso(win.endDate, win.endTime);
    if (new Date(endAt).getTime() <= new Date(startAt).getTime()) {
      wx.showToast({ title: '结束时间需晚于开始时间', icon: 'none' });
      return;
    }
    // ⚠️ 必须在点击手势内、任何异步云调用之前拉取订阅授权。
    // 本页（座位图底部抽屉）是用户实际下单的入口，早期漏了这一步，
    // 导致授权弹窗从未出现、后续「预约成功/签到提醒/超时预警」全部收不到。
    await requestReservationConfirmSubscribes();
    this.setData({ submitting: true });
    try {
      const record = await createReservation({
        room_id: this.data.roomId,
        seat_id: seatId,
        start_at: startAt,
        end_at: endAt,
      });
      // 服务端也可能把结束时间截断到打烊（例如前端拿到的开放时段是旧值）：
      // 只要实际落库的结束时间与提交值不一致，就必须说清楚，否则用户以为时长被悄悄改了。
      const actualStartMs = new Date(record.start_at || startAt).getTime();
      const actualEndMs = record.end_at ? new Date(record.end_at).getTime() : 0;
      const trimmed = !!actualEndMs && Math.abs(actualEndMs - new Date(endAt).getTime()) > 60 * 1000;
      this.setData({ detailVisible: false, submitting: false });
      if (trimmed) {
        const p1 = localParts(new Date(actualStartMs));
        const p2 = localParts(new Date(actualEndMs));
        const mins = Math.max(0, Math.round((actualEndMs - actualStartMs) / 60000));
        await wx.showModal({
          title: '已按开放时间调整',
          content:
            `本自习室开放 ${this.data.openTime}-${this.data.closeTime}，` +
            `结束时间已自动截断到打烊时间。\n\n实际时段：${p1.date} ${p1.time} → ${p2.time}（${durationLabel(mins)}）`,
          showCancel: false,
          confirmText: '知道了',
        });
      } else {
        wx.showToast({ title: '预约成功', icon: 'success' });
      }
      // 埋点：预约提交成功
      trackBookingConfirm(this.data.roomId, startAt, true);
      // 预约成功：立即刷新「我的」标记，让刚约的座位在图上显示「我」，避免再被当成空闲
      this.loadMyReservations();
      // 预约成功确认推送（未授权 / 未配置模板时静默跳过，不阻塞主流程）
      void notifyReservationConfirmed(record, {
        roomName: this.data.roomName,
        seatLabel: this.data.detailName,
      });
      setTimeout(() => {
        wx.redirectTo({ url: '/subpages/myReservations/myReservations' });
      }, 600);
    } catch (err) {
      this.setData({ submitting: false });
      const msg = String((err && (err as { message?: string }).message) || '');
      if (msg.indexOf('你此时段已有预约') !== -1) {
        const modal = await wx.showModal({
          title: '此时段你已有预约',
          content: '请到「我的预约」取消或调整时间后再来。',
          confirmText: '去看预约',
          cancelText: '留在此页',
        });
        if (modal.confirm) wx.redirectTo({ url: '/subpages/myReservations/myReservations' });
        return;
      }
      // 非实时数据时，座位颜色本来就不可信 —— 此刻必须把这一点说破，
      // 否则用户只会看成「有空位却约不上」，反复换座位重试。
      if (!this.data.realtime) {
        await wx.showModal({
          title: '座位状态不是实时的',
          content:
            `${msg || '本次预约未成功。'}\n\n` +
            '当前未取到座位的实时占用状态（roomList 云函数未部署或调用失败），' +
            '页面上的座位颜色只是默认值，并不代表真的空闲，能否预约以服务端校验为准。\n\n' +
            '请先在开发者工具里对 roomList 云函数「上传并部署：云端安装依赖」后再试。',
          showCancel: false,
          confirmText: '知道了',
        });
        return;
      }
      // 冲突/失败后立刻静默重拉座位状态：否则顶部可能仍写着「空闲 18/18」，
      // 而该座位已被别人（或自己上一次「失败但其实已落库」的预约）占用，形成自相矛盾的观感。
      void this.loadSeats(undefined, true);
      // 埋点：预约提交失败
      trackBookingConfirm(this.data.roomId, startAt, false);
      // 开放时段等长文案走弹窗，避免 toast 7 字截断
      showBusinessError(err, '预约失败');
    }
  },
});
