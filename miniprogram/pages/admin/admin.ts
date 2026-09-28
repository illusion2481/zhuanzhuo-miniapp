import { fetchAdminStats, type AdminStats } from '../../services/statistics';
import { getCachedUser } from '../../services/auth';
import { callCloud } from '../../services/cloud';
import { showError } from '../../utils/error';
import { IS_DEV } from '../../config/env';
import {
  setSeatMaintain,
  fetchRoomSeats,
  releaseSeat,
  setCheckinCode,
  setRoomGeo,
  fetchCheckinConfig,
  adminOps,
  listFeedback,
  markFeedbackHandled,
  replyFeedback,
  CloudBizError,
  type SeatMaintainStatus,
  type OverviewData,
  type ReservationRow,
  type ReservationOp,
  type UserRow,
  type UserOp,
  type CheckinRoom,
  type FeedbackRow,
} from '../../services/admin';
import { chooseLocation } from '../../utils/geo';
import type { RoomSummary, SeatDef } from '../../types/room';
import { sortSeatsByNumber, needsSeatRenumber } from '../../utils/seatOrder';

/**
 * 编号自动补正的防重入标志（模块级：同一时刻只允许一次补正，避免并发写库）。
 * 场景：进入座位页 / 切换房间时，若当前房间编号有洞或仍是旧格式，自动补正一次。
 */
let seatNumberingFixing = false;

/**
 * 后台顶部「数据大屏」实时时钟定时器（模块级：onShow 启动 / onHide·onUnload 停止）。
 * 后台是 tabBar 页，切走必须停表，否则每秒一次的 setData 会在后台持续空转。
 */
let clockTimer: ReturnType<typeof setInterval> | null = null;

/** 管理后台 Tab 点击（dataset: key） */
interface TabTapEvent {
  currentTarget: { dataset: { key?: string } };
}

/** 运营操作点击（dataset: id / op / status） */
interface OpTapEvent {
  currentTarget: { dataset: { id?: string; op?: string; status?: string } };
}

/** 表单输入点击（dataset: field） */
interface FieldInputEvent {
  currentTarget: { dataset: { field?: string } };
  detail: { value?: string };
}

const STATUS_LABELS: Record<string, string> = {
  pending_checkin: '待签到',
  active: '使用中',
  paused: '暂离中',
  completed: '已完成',
  cancelled: '已取消',
  no_show: '违约',
};

const OCCUPYING = ['pending_checkin', 'active', 'paused'];

/**
 * 反馈工单状态文案（与 submitFeedback / adminOps 的三态保持一致）。
 * replied 是「已回复、等用户确认」的中间态 —— 用户追问会打回 pending，
 * 所以后台不能把「回复过」当成「结束了」。
 */
const FEEDBACK_STATUS_TEXT: Record<string, string> = {
  pending: '待处理',
  replied: '已回复',
  handled: '已关闭',
};

function fmtClock(iso: string): string {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '--:--';
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtDayTime(iso: string): string {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtClock(iso)}`;
}

/** 工单等待时长：把毫秒数说成人话（客服 SLA 提示用） */
function fmtWait(ms: number): string {
  const v = Number(ms) || 0;
  if (v <= 0) return '';
  const mins = Math.floor(v / 60000);
  if (mins < 60) return `${Math.max(mins, 1)} 分钟`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

/** 座位维护网格的点击事件（dataset: seat / status） */
interface SeatTapEvent {
  currentTarget: { dataset: { seat?: string; status?: string } };
}

/** 房间切换点击事件（dataset: index） */
interface RoomTabEvent {
  currentTarget: { dataset: { index?: number } };
}

/** 座位格展示模型 */
interface SeatCell {
  seat_id: string;
  label: string;
  status: string;
  features: string[];
}

interface SeedResult {
  categories?: { written: number; skipped: number; total: number };
  records?: { written: number; skipped: number; total: number };
}

Page({
  data: {
    authorized: false,
    loading: false,
    seeding: false,
    seedText: '',
    /** 开发期显示数据初始化工具（IS_DEV 关闭后交付版自动隐藏） */
    showDevTools: IS_DEV,
    hasData: false,
    errorText: '',
    diagText: '',
    stats: null as AdminStats | null,
    /** 展示用：状态分布列表 [{key,label,count,percent}] */
    statusRows: [] as Array<{ key: string; label: string; count: number; percent: number }>,
    unauthorizedHint:
      '该页面仅限管理员访问。请使用配置在 ADMIN_OPENID_HASHES 中的微信号登录后重试。',

    // —— 座位维护 ——
    seatRooms: [] as RoomSummary[],
    activeRoomIndex: 0,
    activeRoomName: '',
    seatCells: [] as SeatCell[],
    seatSummary: '',
    seatLoading: false,
    seatMsg: '',
    seatError: '',
    // 座位操作面板（点座位格弹出：属性勾选 / 设维护 / 删除）
    seatPanelVisible: false,
    editingSeat: null as (SeatCell & { room_id: string }) | null,
    seatPanelFeatures: [] as string[],
    /** 面板内属性勾选视图模型（WXML 不支持 indexOf，必须带 checked 标记） */
    seatPanelFeatureItems: [] as Array<{ key: string; label: string; checked: boolean }>,
    seatPanelSaving: false,

    // —— 商家后台（adminOps）——
    tabs: [
      { key: 'checkin', label: '签到' },
      { key: 'dashboard', label: '看板' },
      { key: 'reservations', label: '预约' },
      { key: 'seats', label: '座位' },
      { key: 'users', label: '用户' },
      { key: 'feedback', label: '反馈' },
    ],
    activeTab: 'dashboard',
    overview: null as OverviewData | null,
    /** 近 7 日预约趋势柱状图 [{date,label,count,heightPercent}] */
    trendBars: [] as Array<{ date: string; label: string; count: number; heightPercent: number }>,
    /** 高峰开始时段排行条 [{hour,label,count,widthPercent,rank,isTop}] */
    peakBars: [] as Array<{
      hour: number;
      label: string;
      count: number;
      widthPercent: number;
      rank: number;
      isTop: boolean;
    }>,
    /** 关键指标进度条（签到率/完成率/违约率） */
    rateMetrics: [] as Array<{ key: string; label: string; value: number; tone: string }>,
    /** 状态分布环形图背景（inline conic-gradient，空串则用 .donut--empty 兜底） */
    statusDonutStyle: '',

    // 预约订单
    resvStatusTabs: [
      { key: 'all', label: '全部' },
      { key: 'pending_checkin', label: '待签到' },
      { key: 'active', label: '使用中' },
      { key: 'paused', label: '暂离中' },
      { key: 'no_show', label: '违约' },
      { key: 'completed', label: '已完成' },
    ],
    resvStatus: 'all',
    // ⚠️ 默认「全部」而非「今日」：商家打开预约 tab 第一眼要看全量订单，
    // 默认按「今日」会把非今天的预约（含其他用户的）过滤掉，误以为「预约不显示」。
    // 「今日」仍可在筛选条点选。
    resvDate: 'all',
    resvCustomDate: '',
    resvList: [] as Array<
      ReservationRow & {
        status_label: string;
        seat_label: string;
        time_label: string;
        can_operate: boolean;
      }
    >,
    resvLoading: false,
    resvError: '',

    // 用户与信用
    userKeyword: '',
    userList: [] as Array<UserRow & { ban_label: string }>,
    userLoading: false,
    userError: '',

    // 意见反馈
    feedbackList: [] as Array<
      FeedbackRow & {
        created_label: string;
        replied_label: string;
        status_text: string;
        followups: Array<{ content: string; created_at: string; time_label: string }>;
      }
    >,
    feedbackLoading: false,
    feedbackError: '',
    feedbackFilter: 'all' as 'all' | 'pending' | 'replied' | 'handled',
    /** 客服闭环：每张反馈卡独立的回复草稿，key = feedback_id */
    feedbackReplies: {} as Record<string, string>,
    /** 待处理工单数（Tab 角标，来自 overview，避免必须切进来才知道） */
    feedbackPending: 0,
    /** 超过 24 小时未响应的工单数 */
    feedbackOverdue: 0,

    // 房间与批量座位
    roomForm: { name: '', building: '', floor: '', open_time: '', close_time: '' },
    roomStatus: 'active',
    roomSaving: false,
    roomMsg: '',
    roomError: '',
    seatPrefix: 'A',
    seatAddCount: '6',
    // 批量删除：删掉编号末尾的 N 个座位（撤销误加最方便）。
    // seatCells 按编号升序排，末尾即编号最大的那批 —— 正好是最近新增的。
    seatRemoveCount: '1',
    // 座位属性（新增座位时勾选）。
    // ⚠️ key 用 power（与全系统归一一致：AI 推荐/座位筛选只认 power，绝不写 outlet），
    //    selected 用于 WXML 直接判断高亮（WXML 不支持 indexOf）。
    seatFeatures: [
      { key: 'window', label: '靠窗', selected: false },
      { key: 'power', label: '有插座', selected: false },
    ],
    seatSelectedFeatures: [] as string[],

    // ═══ 签到方式（2026-09-19 两卡合一）═══
    // 原来「到店签到码」和「位置签到」是两张卡、各自维护一份房间列表与一个房间选择器，
    // 功能重叠且要配两遍。现在共用 checkinRooms 一份列表、checkinRoomIndex 一个选择器。
    checkinRooms: [] as CheckinRoom[],
    checkinRoomIndex: 0,
    checkinRequireCode: true,
    checkinCodeDate: '',
    checkinCodeInput: '',
    checkinSaving: false,
    checkinMsg: '',
    checkinError: '',

    // 位置围栏编辑态（签到方式卡 · 位置签到区）
    geoDefaultRadius: 200,
    geoLat: 0,
    geoLng: 0,
    geoAddress: '',
    geoRadiusInput: '200',
    geoSaving: false,
    geoMsg: '',
    geoError: '',

    // ═══ 顶部数据大屏（实时时钟 + 今日签到码）═══
    clockDate: '',
    clockTime: '',
  },

  onShow() {
    // 同步 tabBar 选中态（组件 pageLifetimes.show 的路由计算时机不稳，官方推荐页面侧显式刷新）
    this.getTabBar()?.refresh?.();
    this.checkAuth();
    this.startClock();
  },

  onHide() {
    this.stopClock();
  },

  onUnload() {
    this.stopClock();
  },

  /** 大屏实时时钟：每秒刷新日期（含星期）与 HH:MM:SS */
  startClock() {
    this.stopClock();
    const tick = () => {
      const now = new Date();
      const week = '日一二三四五六'.charAt(now.getDay());
      this.setData({
        clockDate: `${now.getMonth() + 1}月${now.getDate()}日 星期${week}`,
        clockTime: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`,
      });
    };
    tick();
    clockTimer = setInterval(tick, 1000);
  },

  stopClock() {
    if (clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  },

  /**
   * 鉴权：读取本地缓存的用户档案
   * - 未登录：authorized=false（提示登录）
   * - 角色非 admin：authorized=false（提示无权限）
   * - admin：authorized=true 并加载统计
   */
  checkAuth() {
    const user = getCachedUser();
    if (!user) {
      this.setData({ authorized: false });
      return;
    }
    if (user.role !== 'admin') {
      this.setData({ authorized: false });
      return;
    }
    this.setData({ authorized: true });
    // 首帧只加载当前 tab（dashboard）需要的数据；seats / checkin 等
    // 数据在用户真正切到对应 tab 时由 onTabSwitch 按需加载，
    // 避免一进页面就把 5 个云函数全打出去（冷启动最慢的恰恰是这些首屏用不到的）。
    this.load();
    this.loadOverview();
    this.onTabSwitch({ currentTarget: { dataset: { key: this.data.activeTab } } });
  },

  async load() {
    this.setData({ loading: true, errorText: '' });
    try {
      const stats = await fetchAdminStats();
      const statusRows = this.buildStatusRows(stats);
      this.setData({
        stats,
        hasData: stats.total > 0,
        statusRows,
        statusDonutStyle: this.buildStatusDonut(statusRows, stats.total),
        rateMetrics: this.buildRateMetrics(stats),
        diagText: this.buildDiagText(stats),
        loading: false,
      });
    } catch (err) {
      const code =
        (err as { code?: string }).code ||
        (err as { data?: { code?: string } }).data?.code ||
        '';
      // 云端 FORBIDDEN 时（管理员白名单配置不一致）也归类为未授权
      if (code === 'FORBIDDEN' || code === 'ADMIN_NOT_CONFIGURED') {
        this.setData({ authorized: false, loading: false });
        return;
      }
      this.setData({ loading: false, diagText: '', errorText: (err as Error).message || '加载失败' });
      showError(err, '加载统计失败，请先部署 adminStats 云函数');
    }
  },

  /**
   * 组装诊断文案：区分「集合为空」与「写库字段口径不符」
   * - recordsTotal = 0                        → 还没有任何记录
   * - recordsTotal > 0 且 reservationCount = 0 → 字段口径不符，需重新部署 createReservation
   */
  buildDiagText(stats: AdminStats) {
    const diag = stats.diag;
    if (!diag) return '';
    const parts: string[] = [];
    if (typeof diag.recordsTotal === 'number') parts.push(`记录总数 ${diag.recordsTotal}`);
    if (typeof diag.reservationCount === 'number') parts.push(`其中预约 ${diag.reservationCount}`);
    if (diag.error) parts.push(`读取异常：${diag.error}`);
    if (!parts.length) return '';
    const total = diag.recordsTotal;
    const reservation = diag.reservationCount;
    if (total === 0) {
      parts.push('还没有任何记录，请先在小程序里完成一次预约');
    } else if (total !== null && reservation === 0) {
      parts.push('有记录却没有预约类型，属写库字段口径不符，请重新部署 createReservation');
    }
    return parts.join(' · ');
  },

  buildStatusRows(stats: AdminStats) {
    const labels: Record<string, string> = {
      pending_checkin: '待签到',
      active: '使用中',
      paused: '暂离中',
      completed: '已完成',
      cancelled: '已取消',
      no_show: '已违约',
    };
    return Object.entries(stats.byStatus || {}).map(([key, count]) => {
      const total = stats.total || 1;
      return {
        key,
        label: labels[key] || key,
        count,
        percent: Math.round((count / total) * 100),
      };
    });
  },

  /**
   * 状态色（与 admin.scss 的 .status-* 一致）。
   * TS 侧无法 import SCSS 变量，故此处硬编码同一组色值，改色时两处同步。
   */
  statusColor(key: string): string {
    const map: Record<string, string> = {
      pending_checkin: '#FAAD14',
      active: '#1DB5B5',
      paused: '#1677FF',
      completed: '#36B37E',
      cancelled: '#7F8C8D',
      no_show: '#E54D42',
    };
    return map[key] || '#9CA3AF';
  },

  /**
   * 生成状态分布环形图背景（从 12 点方向顺时针铺色）。
   * 返回完整 inline style；total=0 时返回空串，由 .donut--empty 类兜底底色。
   */
  buildStatusDonut(rows: Array<{ key: string; count: number }>, total: number): string {
    if (!total || total <= 0) return '';
    let acc = 0;
    const stops: string[] = [];
    rows.forEach((r) => {
      if (!r.count || r.count <= 0) return;
      const start = (acc / total) * 100;
      acc += r.count;
      const end = (acc / total) * 100;
      stops.push(`${this.statusColor(r.key)} ${start.toFixed(2)}% ${end.toFixed(2)}%`);
    });
    if (!stops.length) return '';
    return `background-image: conic-gradient(from -90deg, ${stops.join(', ')});`;
  },

  /** 关键指标进度条：签到率 / 完成率 / 违约率 */
  buildRateMetrics(stats: AdminStats) {
    const r = stats.rates || ({} as AdminStats['rates']);
    return [
      { key: 'checkIn', label: '签到率', value: r.checkInRate || 0, tone: 'primary' },
      { key: 'completion', label: '完成率', value: r.completionRate || 0, tone: 'success' },
      { key: 'noShow', label: '违约率', value: r.noShowRate || 0, tone: 'danger' },
    ];
  },

  /** 日期 → 紧凑标签 M/D */
  fmtTrendLabel(date: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''));
    if (!m) return String(date || '');
    return `${Number(m[2])}/${Number(m[3])}`;
  },

  /** 近 7 日趋势 → 柱状图（高度按最大值归一，非零至少 10% 保证可见） */
  buildTrendBars(trend: Array<{ date: string; count: number }>) {
    const max = trend.reduce((m, t) => Math.max(m, t.count || 0), 0);
    return trend.map((t) => {
      const count = t.count || 0;
      const raw = max > 0 ? (count / max) * 100 : 0;
      return {
        date: t.date,
        label: this.fmtTrendLabel(t.date),
        count,
        heightPercent: count > 0 ? Math.max(10, Math.round(raw)) : 0,
      };
    });
  },

  /** 高峰开始时段 → 排行横条（宽度按最大值归一，非零至少 12%） */
  buildPeakBars(peak: Array<{ hour: number; count: number }>) {
    const max = peak.reduce((m, p) => Math.max(m, p.count || 0), 0);
    return peak.map((p, i) => {
      const count = p.count || 0;
      const raw = max > 0 ? (count / max) * 100 : 0;
      return {
        hour: p.hour,
        label: `${String(p.hour).padStart(2, '0')}:00`,
        count,
        widthPercent: count > 0 ? Math.max(12, Math.round(raw)) : 0,
        rank: i + 1,
        isTop: i < 3,
      };
    });
  },

  refresh() {
    if (!this.data.authorized || this.data.loading) return;
    this.load();
  },

  // ===================== 座位维护 =====================

  /**
   * 拉取房间与座位（窗口取「现在 ~ 30 天后」，
   * 这样未来时段已被预约的座位也会显示为占用，避免误设维护）。
   * 直连 roomList，不走本地演示兜底 —— 管理页必须看到云端真实状态。
   */
  async loadSeats() {
    if (this.data.seatLoading) return;
    this.setData({ seatLoading: true, seatError: '' });
    try {
      const now = new Date();
      const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const rooms = await fetchRoomSeats({
        startAt: now.toISOString(),
        endAt: end.toISOString(),
      });
      if (!rooms.length) {
        this.setData({ seatRooms: [], seatCells: [], seatSummary: '', seatError: '云端暂无自习室数据，请先执行数据初始化' });
        return;
      }
      // 编号体检：存在缺号 / 旧格式（A-001）时自动补正为连续编号，用户无需手动点按钮
      const fixed = await this.ensureSeatNumbering(rooms, this.data.activeRoomIndex);
      this.setData({ seatRooms: fixed });
      this.applyRoom(fixed, this.data.activeRoomIndex);
    } catch (err) {
      this.setData({
        seatRooms: [],
        seatCells: [],
        seatSummary: '',
        seatError: (err as Error).message || '座位加载失败',
      });
    } finally {
      this.setData({ seatLoading: false });
    }
  },

  /**
   * 编号自动补正：当前房间若存在「缺号」或「旧格式（A-001 带前导零）」的座位，
   * 自动调云端 renumberSeats 压缩成连续编号（A-1、A-2…），进行中的预约一起改号。
   *
   * 为什么放在前端自动做：用户明确要求「删掉后面的号要往前补、不要有缺号」，
   * 但历史遗留的洞（改动上线前删出来的）不会自己消失 —— 这里进页面自动兜底，
   * 用户不必知道有「编号重排」这个按钮。
   * 只在体检发现问题时才写库；失败静默降级，不阻塞座位页浏览。
   */
  async ensureSeatNumbering(rooms: RoomSummary[], index: number): Promise<RoomSummary[]> {
    const list = rooms && rooms.length ? rooms : [];
    if (!list.length || seatNumberingFixing) return list;
    const safeIndex = Math.min(Math.max(index, 0), list.length - 1);
    const room = list[safeIndex];
    const seats = (room && room.seats) || [];
    if (!needsSeatRenumber(seats)) return list;

    seatNumberingFixing = true;
    try {
      const res = await adminOps<{
        renumbered: Array<{ from: string; to: string }>;
        renamed?: number;
      }>('renumberSeats', { room_id: room.room_id });
      const moved = res.renumbered || [];
      if (!moved.length) return list;
      const sample = moved
        .slice(0, 3)
        .map((m) => `${m.from}→${m.to}`)
        .join('、');
      this.setData({
        roomMsg:
          `编号已自动补正 ${moved.length} 个（${sample}${moved.length > 3 ? ' 等' : ''}）` +
          (res.renamed ? `，${res.renamed} 条进行中预约已同步改号` : ''),
      });
      // 重新拉一遍，拿补正后的编号（避免本地拼号与云端不一致）
      const now = new Date();
      const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      const fresh = await fetchRoomSeats({
        startAt: now.toISOString(),
        endAt: end.toISOString(),
      });
      return fresh.length ? fresh : list;
    } catch {
      // 静默降级：自动补正是体验优化，失败不阻断座位页
      return list;
    } finally {
      seatNumberingFixing = false;
    }
  },

  /** 把指定房间展开为座位格并统计 */
  applyRoom(rooms: RoomSummary[], index: number) {
    const list = rooms && rooms.length ? rooms : this.data.seatRooms;
    if (!list.length) {
      this.setData({ activeRoomIndex: 0, activeRoomName: '', seatCells: [], seatSummary: '' });
      return;
    }
    const safeIndex = Math.min(Math.max(index, 0), list.length - 1);
    const room = list[safeIndex];
    // 座位格按「编号升序」展示（A-1 → A-13）：新增的接在最后、删除中间的不打乱其余顺序。
    // ⚠️ 不再按 row/col 排 —— 新增座位带的坐标会把 A-13 插到 A-9 后面，看着像乱序。
    //    与用户端 SeatMap 共用 utils/seatOrder 的 sortSeatsByNumber，两处顺序口径一致。
    //    row/col 数据仍保留在库里（云端 addSeats 续号还要用），只是不参与此处排序。
    const seatDefs = (room.seats || []) as Array<
      SeatDef & { status?: string }
    >;
    const cells: SeatCell[] = sortSeatsByNumber(seatDefs).map((s) => ({
      seat_id: s.seat_id,
      label: s.label || s.seat_id,
      status: String(s.status || 'free'),
      features: Array.isArray(s.features) ? s.features : [],
    }));
    const free = cells.filter((c) => c.status === 'free').length;
    const maintain = cells.filter((c) => c.status === 'maintain').length;
    // roomList 不返回 status、floor 可能是数字，这里做宽松取值
    const meta = room as unknown as {
      name?: string;
      building?: string;
      floor?: string | number;
      open_time?: string;
      close_time?: string;
      status?: string;
    };
    this.setData({
      activeRoomIndex: safeIndex,
      activeRoomName: String(meta.name || ''),
      seatCells: cells,
      seatSummary: `空闲 ${free} · 占用 ${cells.length - free - maintain} · 维护 ${maintain} · 共 ${cells.length}`,
      // 房间设置表单与当前选中房间保持同步
      roomForm: {
        name: String(meta.name || ''),
        building: String(meta.building || ''),
        floor: String(meta.floor ?? ''),
        open_time: String(meta.open_time || ''),
        close_time: String(meta.close_time || ''),
      },
      roomStatus: meta.status || 'active',
      roomMsg: '',
      roomError: '',
      seatPrefix: (String(cells[0]?.seat_id || 'A').match(/^[A-Za-z]+/) || ['A'])[0],
    });
  },

  async onRoomSwitch(e: RoomTabEvent) {
    const index = Number(e.currentTarget.dataset.index || 0);
    // 切换房间时同样做一次编号体检：新房间若有缺号 / 旧格式也会自动补正
    const rooms = await this.ensureSeatNumbering(this.data.seatRooms, index);
    if (rooms !== this.data.seatRooms) this.setData({ seatRooms: rooms });
    this.applyRoom(rooms, index);
  },

  /** 点座位：空闲 → 设为维护；维护 → 释放为空闲；占用 → 提示不可操作 */
  /** 点座位格 → 打开座位操作面板（属性勾选 / 设维护 / 删除） */
  onSeatTap(e: SeatTapEvent) {
    if (this.data.seatLoading) return;
    const seatId = String(e.currentTarget.dataset.seat || '');
    const room = this.data.seatRooms[this.data.activeRoomIndex];
    if (!seatId || !room) return;
    const cell = this.data.seatCells.find((c) => c.seat_id === seatId);
    if (!cell) return;
    const features = (cell.features || []).slice();
    this.setData({
      seatPanelVisible: true,
      editingSeat: { ...cell, room_id: room.room_id },
      seatPanelFeatures: features,
      seatPanelFeatureItems: this.data.seatFeatures.map((f) => ({
        key: f.key,
        label: f.label,
        checked: features.indexOf(f.key) >= 0,
      })),
      seatPanelSaving: false,
    });
  },

  /** 占位：阻止遮罩点击冒泡穿透到面板 */
  noop() {},

  /** 关闭座位操作面板 */
  closeSeatPanel() {
    if (this.data.seatPanelSaving) return;
    this.setData({ seatPanelVisible: false, editingSeat: null });
  },

  /** 面板内：勾选 / 取消勾选属性 */
  onSeatFeatureCheck(e: TabTapEvent) {
    const key = String(e.currentTarget.dataset.key || '');
    if (!key || !this.data.editingSeat) return;
    const next = [...this.data.seatPanelFeatures];
    const idx = next.indexOf(key);
    if (idx >= 0) next.splice(idx, 1);
    else next.push(key);
    this.setData({
      seatPanelFeatures: next,
      seatPanelFeatureItems: this.data.seatFeatures.map((f) => ({
        key: f.key,
        label: f.label,
        checked: next.indexOf(f.key) >= 0,
      })),
    });
  },

  /** 面板内：设为维护 / 恢复空闲 */
  async onSeatPanelSetStatus(e: OpTapEvent) {
    const target = String(e.currentTarget.dataset.status || '');
    if (!this.data.editingSeat || this.data.seatPanelSaving) return;
    const seat = this.data.editingSeat;
    if (target === seat.status) return;
    if (target !== 'free' && target !== 'maintain') return;
    this.setData({ seatPanelSaving: true });
    try {
      await adminOps('updateSeat', {
        room_id: seat.room_id,
        seat_id: seat.seat_id,
        status: target,
      });
      wx.showToast({ title: target === 'maintain' ? '已设为维护' : '已恢复空闲', icon: 'success' });
      this.setData({ seatPanelVisible: false, editingSeat: null });
      await this.loadSeats();
    } catch (err) {
      this.setData({ seatMsg: `${seat.seat_id} 操作失败：${(err as Error).message || '未知错误'}` });
      showError(err, '座位状态修改失败');
    } finally {
      this.setData({ seatPanelSaving: false });
    }
  },

  /** 面板内：强制释放占用中的座位（管理员最高权限，取消占用预约且不计用户违约） */
  async onSeatPanelRelease() {
    const seat = this.data.editingSeat;
    if (!seat || this.data.seatPanelSaving) return;
    const confirmed = await this.confirmModal(
      '释放座位',
      `强制释放 ${seat.seat_id}？该座位上的进行中预约会被取消（不计用户违约）。`,
      '释放',
    );
    if (!confirmed) return;
    this.setData({ seatPanelSaving: true });
    try {
      const res = await releaseSeat(seat.room_id, seat.seat_id);
      wx.showToast({
        title: res.released ? `已释放（${res.released} 条预约被取消）` : '该座位本无占用预约',
        icon: 'none',
      });
      this.setData({ seatPanelVisible: false, editingSeat: null });
      await this.loadSeats();
      await this.loadReservations();
    } catch (err) {
      this.setData({ seatMsg: `${seat.seat_id} 释放失败：${(err as Error).message || '未知错误'}` });
      showError(err, '释放座位失败');
    } finally {
      this.setData({ seatPanelSaving: false });
    }
  },

  /** 面板内：保存属性勾选 */
  async onSaveSeatPanel() {
    const seat = this.data.editingSeat;
    if (!seat || this.data.seatPanelSaving) return;
    this.setData({ seatPanelSaving: true });
    try {
      await adminOps('updateSeat', {
        room_id: seat.room_id,
        seat_id: seat.seat_id,
        features: this.data.seatPanelFeatures,
      });
      wx.showToast({ title: '属性已保存', icon: 'success' });
      this.setData({ seatPanelVisible: false, editingSeat: null });
      await this.loadSeats();
    } catch (err) {
      this.setData({ seatMsg: `${seat.seat_id} 保存失败：${(err as Error).message || '未知错误'}` });
      showError(err, '座位属性保存失败');
    } finally {
      this.setData({ seatPanelSaving: false });
    }
  },

  /** 面板内：删除座位（云端会拦截仍有进行中预约的座位） */
  async onDeleteSeat() {
    const seat = this.data.editingSeat;
    if (!seat || this.data.seatPanelSaving) return;
    const confirmed = await this.confirmModal(
      '删除座位',
      `确定删除 ${seat.seat_id} 吗？删除后不可恢复。若有进行中预约，云端会自动跳过该座位。`,
      '删除',
    );
    if (!confirmed) return;
    this.setData({ seatPanelSaving: true });
    try {
      const res = await adminOps<{ removed: number; blocked: number }>('removeSeats', {
        room_id: seat.room_id,
        seat_ids: [seat.seat_id],
      });
      wx.showToast({
        title: res.removed > 0 ? '已删除' : '该座位有进行中的预约，未删除',
        icon: res.removed > 0 ? 'success' : 'none',
        duration: 2400,
      });
      if (res.blocked > 0 && res.removed === 0) {
        this.setData({ seatMsg: `${seat.seat_id} 有进行中的预约，未删除，可稍后再试` });
        return;
      }
      this.setData({ seatPanelVisible: false, editingSeat: null });
      await this.loadSeats();
    } catch (err) {
      this.setData({ seatMsg: `${seat.seat_id} 删除失败：${(err as Error).message || '未知错误'}` });
      showError(err, '座位删除失败');
    } finally {
      this.setData({ seatPanelSaving: false });
    }
  },

  /** 提交座位状态变更并局部刷新 */
  async pushSeat(roomId: string, seatId: string, status: SeatMaintainStatus) {
    this.setData({ seatLoading: true, seatMsg: '' });
    try {
      await setSeatMaintain({ roomId, seatId, status });
      this.setData({
        seatMsg: `${seatId} ${status === 'maintain' ? '已设为维护' : '已恢复空闲'}`,
      });
      wx.showToast({ title: '已生效', icon: 'success' });
      await this.loadSeats();
    } catch (err) {
      const code = err instanceof CloudBizError ? err.code : '';
      if (code === 'SEAT_OCCUPIED') {
        this.setData({ seatMsg: `${seatId} 仍有进行中的预约，未做修改` });
        wx.showToast({ title: '该座位有进行中的预约', icon: 'none', duration: 2400 });
      } else {
        this.setData({ seatMsg: `${seatId} 操作失败：${(err as Error).message || '未知错误'}` });
        showError(err, '座位维护操作失败');
      }
    } finally {
      this.setData({ seatLoading: false });
    }
  },

  // ===================== 商家后台：Tab 与看板 =====================

  onTabSwitch(e: TabTapEvent) {
    const key = String((e && e.currentTarget && e.currentTarget.dataset.key) || 'dashboard');
    this.setData({ activeTab: key });
    if (!this.data.authorized) return;
    if (key === 'checkin') this.loadCheckinConfig();
    else if (key === 'reservations') this.loadReservations();
    else if (key === 'users') this.loadUsers();
    else if (key === 'seats') {
      this.loadSeats();
      this.loadCheckinConfig();
    }
    else if (key === 'dashboard') this.loadOverview();
    else if (key === 'feedback') this.loadFeedback();
  },

  // ===================== 签到方式（位置围栏 + 到店签到码） =====================

  /** 一次拉回所有房间的「位置围栏 + 到店签到码」配置 */
  async loadCheckinConfig() {
    try {
      const res = await fetchCheckinConfig();
      this.setData({
        checkinRooms: res.rooms || [],
        checkinRequireCode: res.require_code !== false,
        checkinCodeDate: res.date || '',
        geoDefaultRadius: res.default_radius || 200,
        checkinError: '',
        geoError: '',
      });
      this.syncGeoForm();
    } catch (err) {
      const msg = (err as Error).message || '签到方式配置加载失败';
      this.setData({ checkinRooms: [], checkinError: msg, geoError: msg });
    }
  },

  /** 当前选中的房间：位置围栏与到店签到码共用同一个选择器 */
  currentCheckinRoom(): CheckinRoom | null {
    return this.data.checkinRooms[this.data.checkinRoomIndex] || null;
  },

  onCheckinRoomChange(e: { detail: { value: string | number } }) {
    this.setData(
      { checkinRoomIndex: Number(e.detail.value) || 0, checkinMsg: '', checkinError: '', geoMsg: '', geoError: '' },
      () => {
        this.syncGeoForm();
      },
    );
  },

  /** 点击按钮直接切换签到配置的房间 */
  onCheckinRoomTap(e: WechatMiniprogram.TouchEvent) {
    const index = Number(e.currentTarget.dataset.index) || 0;
    if (index === this.data.checkinRoomIndex) return;
    this.setData(
      { checkinRoomIndex: index, checkinMsg: '', checkinError: '', geoMsg: '', geoError: '' },
      () => {
        this.syncGeoForm();
      },
    );
  },

  onCheckinCodeInput(e: { detail: { value: string } }) {
    this.setData({ checkinCodeInput: String(e.detail.value || ''), checkinMsg: '', checkinError: '' });
  },

  /** 设为固定码（商家可张贴固定码，不再每日轮换） */
  async onSaveCheckinCode() {
    const room = this.currentCheckinRoom();
    if (!room || this.data.checkinSaving) return;
    const code = String(this.data.checkinCodeInput || '').trim();
    if (!/^[0-9A-Za-z]{4,8}$/.test(code)) {
      this.setData({ checkinError: '签到码需为 4-8 位数字或字母', checkinMsg: '' });
      return;
    }
    await this.submitCheckinCode(room.room_id, code);
  },

  /** 恢复每日自动轮换的动态码 */
  async onClearCheckinCode() {
    const room = this.currentCheckinRoom();
    if (!room || this.data.checkinSaving) return;
    await this.submitCheckinCode(room.room_id, '');
  },

  async submitCheckinCode(roomId: string, code: string) {
    this.setData({ checkinSaving: true, checkinMsg: '', checkinError: '' });
    try {
      const res = await setCheckinCode(roomId, code);
      this.setData({
        checkinSaving: false,
        checkinCodeInput: '',
        checkinMsg: code ? `已设置固定签到码 ${res.code}` : '已恢复每日自动签到码',
      });
      await this.loadCheckinConfig();
    } catch (err) {
      this.setData({ checkinSaving: false, checkinError: (err as Error).message || '保存失败' });
    }
  },

  /** 把当前选中房间的围栏配置回填到表单（未配置的房间给默认值） */
  syncGeoForm() {
    const room = this.currentCheckinRoom();
    const radius = this.data.geoDefaultRadius || 200;
    this.setData({
      geoLat: room && room.geo_enabled ? Number(room.geo_lat) : 0,
      geoLng: room && room.geo_enabled ? Number(room.geo_lng) : 0,
      geoAddress: room && room.geo_address ? room.geo_address : '',
      geoRadiusInput: String((room && room.geo_radius) || radius),
    });
  },

  onGeoRadiusInput(e: { detail: { value: string } }) {
    this.setData({ geoRadiusInput: String(e.detail.value || ''), geoMsg: '', geoError: '' });
  },

  /** 打开地图选点：坐标口径 gcj02，与 wx.getLocation 一致，可直接配对 */
  async onPickGeoLocation() {
    if (this.data.geoSaving) return;
    const picked = await chooseLocation();
    if (!picked) return; // 用户取消
    this.setData({
      geoLat: picked.lat,
      geoLng: picked.lng,
      geoAddress: picked.address || picked.name || '',
      geoMsg: '',
      geoError: '',
    });
  },

  async onSaveRoomGeo() {
    const room = this.currentCheckinRoom();
    if (!room || this.data.geoSaving) return;
    const lat = Number(this.data.geoLat);
    const lng = Number(this.data.geoLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
      this.setData({ geoError: '请先在地图上选择门店位置', geoMsg: '' });
      return;
    }
    const radius = Number(this.data.geoRadiusInput);
    if (!Number.isFinite(radius) || radius <= 0) {
      this.setData({ geoError: '半径需为大于 0 的数字（单位：米）', geoMsg: '' });
      return;
    }
    this.setData({ geoSaving: true, geoMsg: '', geoError: '' });
    try {
      await setRoomGeo(room.room_id, {
        lat,
        lng,
        radius,
        address: String(this.data.geoAddress || ''),
      });
      this.setData({ geoSaving: false, geoMsg: `已开启位置签到（半径 ${radius} 米）` });
      await this.loadCheckinConfig();
    } catch (err) {
      this.setData({ geoSaving: false, geoError: (err as Error).message || '保存失败' });
    }
  },

  /** 关闭该店的位置校验（回退到「签到码 / 直接签到」） */
  async onClearRoomGeo() {
    const room = this.currentCheckinRoom();
    if (!room || this.data.geoSaving) return;
    this.setData({ geoSaving: true, geoMsg: '', geoError: '' });
    try {
      await setRoomGeo(room.room_id, null);
      this.setData({ geoSaving: false, geoMsg: '已关闭该店的位置签到' });
      await this.loadCheckinConfig();
    } catch (err) {
      this.setData({ geoSaving: false, geoError: (err as Error).message || '操作失败' });
    }
  },

  async loadOverview() {
    try {
      const overview = await adminOps<OverviewData>('overview');
      const fb = overview.feedback || { pending: 0, replied: 0, handled: 0, total: 0, overdue: 0 };
      this.setData({
        overview,
        trendBars: this.buildTrendBars(overview.trend || []),
        peakBars: this.buildPeakBars((overview.peak_hours || []).slice(0, 5)),
        // Tab 角标：不用切进「反馈」也能看到有几条待处理 / 几条已超时
        feedbackPending: fb.pending,
        feedbackOverdue: fb.overdue,
      });
    } catch {
      /* 看板失败不打断其它模块 */
    }
  },

  // ===================== 预约订单 =====================

  onResvStatusSwitch(e: TabTapEvent) {
    this.setData({ resvStatus: String(e.currentTarget.dataset.key || 'all') });
    this.loadReservations();
  },

  onResvDateSwitch(e: TabTapEvent) {
    const key = String(e.currentTarget.dataset.key || 'today');
    this.setData({ resvDate: key });
    if (key !== 'custom') this.loadReservations();
  },

  onResvCustomDateChange(e: WechatMiniprogram.PickerChange) {
    this.setData({ resvCustomDate: String(e.detail.value), resvDate: 'custom' });
    this.loadReservations();
  },

  async loadReservations() {
    if (this.data.resvLoading) return;
    this.setData({ resvLoading: true, resvError: '' });
    try {
      const dateValue = this.data.resvDate === 'custom' ? this.data.resvCustomDate : this.data.resvDate;
      const data = await adminOps<{ list: ReservationRow[] }>('listReservations', {
        status: this.data.resvStatus,
        date: dateValue,
        limit: 50,
      });
      const list = (data.list || []).map((r) => ({
        ...r,
        status_label: STATUS_LABELS[r.status] || r.status,
        seat_label: r.seat_id,
        time_label: `${fmtDayTime(r.start_at)} - ${fmtClock(r.end_at)}`,
        can_operate: OCCUPYING.includes(r.status),
      }));
      this.setData({ resvList: list, resvLoading: false });
    } catch (err) {
      this.setData({
        resvList: [],
        resvLoading: false,
        resvError: (err as Error).message || '预约加载失败',
      });
    }
  },

  async onResvOp(e: OpTapEvent) {
    const id = String(e.currentTarget.dataset.id || '');
    const op = String(e.currentTarget.dataset.op || '') as ReservationOp;
    if (!id || !op) return;
    const tips: Record<string, string> = {
      cancel: '取消该预约并释放座位？',
      no_show: '标记违约？座位会被释放，并计入该用户违规次数。',
      checkin: '把该预约标记为已到店使用？',
      complete: '结束该预约并释放座位？',
    };
    const confirmed = await this.confirmModal('订单操作', tips[op] || '确认执行该操作？', '确认');
    if (!confirmed) return;
    wx.showLoading({ title: '处理中', mask: true });
    try {
      await adminOps('reservationAction', { record_id: id, op });
      wx.showToast({ title: '已处理', icon: 'success' });
      await this.loadReservations();
      await this.loadSeats();
    } catch (err) {
      showError(err, '操作失败');
    } finally {
      wx.hideLoading();
    }
  },

  // ===================== 用户与信用 =====================

  onUserKeyword(e: FieldInputEvent) {
    this.setData({ userKeyword: e.detail.value || '' });
  },

  async loadUsers() {
    if (this.data.userLoading) return;
    this.setData({ userLoading: true, userError: '' });
    try {
      const data = await adminOps<{ list: UserRow[] }>('listUsers', {
        keyword: this.data.userKeyword,
        limit: 50,
      });
      const list = (data.list || []).map((u) => ({
        ...u,
        ban_label: u.banned ? `禁约至 ${fmtDayTime(u.banned_until)}` : '当前无禁约',
        // 手机号脱敏展示（后台甄别用户用；未绑则为空）
        phone_label: u.phone
          ? (String(u.phone).length >= 11
              ? `${String(u.phone).slice(0, 3)}****${String(u.phone).slice(-4)}`
              : String(u.phone))
          : '',
      }));
      this.setData({ userList: list, userLoading: false });
    } catch (err) {
      this.setData({
        userList: [],
        userLoading: false,
        userError: (err as Error).message || '用户加载失败',
      });
    }
  },

  async onUserOp(e: OpTapEvent) {
    const id = String(e.currentTarget.dataset.id || '');
    const op = String(e.currentTarget.dataset.op || '') as UserOp;
    if (!id || !op) return;
    if (op === 'ban') {
      const confirmed = await this.confirmModal(
        '封禁用户',
        '封禁后该用户 24 小时内无法新建预约。是否继续？',
        '封禁',
      );
      if (!confirmed) return;
    }
    wx.showLoading({ title: '处理中', mask: true });
    try {
      await adminOps('userAction', { user_id: id, op, hours: 24 });
      wx.showToast({ title: '已处理', icon: 'success' });
      await this.loadUsers();
    } catch (err) {
      showError(err, '操作失败');
    } finally {
      wx.hideLoading();
    }
  },

  // ===================== 意见反馈 =====================

  onFeedbackFilter(e: WechatMiniprogram.TouchEvent) {
    const f = String(e.currentTarget.dataset.f || 'all') as
      | 'all'
      | 'pending'
      | 'replied'
      | 'handled';
    this.setData({ feedbackFilter: f }, () => this.loadFeedback());
  },

  async loadFeedback() {
    if (this.data.feedbackLoading) return;
    const status =
      this.data.feedbackFilter === 'all' ? undefined : this.data.feedbackFilter;
    this.setData({ feedbackLoading: true, feedbackError: '' });
    try {
      const data = await listFeedback({ status, limit: 100 });
      const list = (data.list || []).map((r) => ({
        ...r,
        created_label: fmtDayTime(r.created_at),
        replied_label: r.replied_at ? fmtDayTime(r.replied_at) : '',
        status_text: FEEDBACK_STATUS_TEXT[r.status] || '待处理',
        // 谁提的：有昵称就「昵称·短ID」，没有就只显示短 ID（比 32 位哈希可读）
        user_label: r.nick_name ? `${r.nick_name} · ${r.user_short}` : r.user_short || '匿名用户',
        wait_label: fmtWait(r.waiting_ms),
        followups: (Array.isArray(r.followups) ? r.followups : []).map((fu) => ({
          ...fu,
          time_label: fmtDayTime(fu.created_at),
        })),
      }));
      this.setData({ feedbackList: list, feedbackLoading: false });
    } catch (err) {
      this.setData({
        feedbackList: [],
        feedbackLoading: false,
        feedbackError: (err as Error).message || '反馈加载失败',
      });
    }
  },

  async onMarkFeedbackHandled(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id || this.data.feedbackLoading) return;
    wx.showLoading({ title: '处理中', mask: true });
    try {
      await markFeedbackHandled(id);
      wx.showToast({ title: '已标记处理', icon: 'success' });
      await this.loadFeedback();
    } catch (err) {
      showError(err, '操作失败');
    } finally {
      wx.hideLoading();
    }
  },

  /** 回复草稿输入：按 feedback_id 独立存储，避免多张卡互相串字 */
  onFeedbackReplyInput(e: WechatMiniprogram.CustomEvent<{ value?: string }>) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id) return;
    const value = String(e.detail?.value || '');
    this.setData({ feedbackReplies: { ...this.data.feedbackReplies, [id]: value } });
  },

  /** 客服闭环：后台回复用户反馈（回复即置为已处理，用户在「我的反馈」可见） */
  async onReplyFeedback(e: WechatMiniprogram.TouchEvent) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id || this.data.feedbackLoading) return;
    const reply = String(this.data.feedbackReplies[id] || '').trim();
    if (!reply) {
      wx.showToast({ title: '请先填写回复内容', icon: 'none' });
      return;
    }
    this.setData({ feedbackLoading: true });
    wx.showLoading({ title: '发送中', mask: true });
    try {
      await replyFeedback(id, reply);
      // 清空该条草稿，避免刷新后旧内容还在输入框里
      const next = { ...this.data.feedbackReplies };
      delete next[id];
      this.setData({ feedbackReplies: next, feedbackLoading: false });
      wx.showToast({ title: '回复已发送', icon: 'success' });
      await this.loadFeedback();
    } catch (err) {
      this.setData({ feedbackLoading: false });
      showError(err, '回复失败，请稍后重试');
    } finally {
      wx.hideLoading();
    }
  },

  // ===================== 房间与批量座位 =====================

  onRoomFormInput(e: FieldInputEvent) {
    const field = String(e.currentTarget.dataset.field || '');
    if (!field) return;
    this.setData({ roomForm: { ...this.data.roomForm, [field]: e.detail.value || '' } });
  },

  onSeatFormInput(e: FieldInputEvent) {
    const field = String(e.currentTarget.dataset.field || '');
    if (field === 'prefix') this.setData({ seatPrefix: e.detail.value || '' });
    else if (field === 'count') this.setData({ seatAddCount: e.detail.value || '' });
    else if (field === 'removeCount') this.setData({ seatRemoveCount: e.detail.value || '' });
  },

  onSeatFeatureToggle(e: TabTapEvent) {
    const key = String(e.currentTarget.dataset.key || '');
    if (!key) return;
    const selected = [...this.data.seatSelectedFeatures];
    const idx = selected.indexOf(key);
    if (idx >= 0) selected.splice(idx, 1);
    else selected.push(key);
    // 同步更新 seatFeatures[].selected，供 WXML 直接判断高亮（WXML 不支持 indexOf）
    const seatFeatures = this.data.seatFeatures.map((f) => ({
      ...f,
      selected: selected.indexOf(f.key) >= 0,
    }));
    this.setData({ seatSelectedFeatures: selected, seatFeatures });
  },

  /** 当前选中的房间（含 roomList 未返回的 status 字段，做宽松取值） */
  currentRoom() {
    return this.data.seatRooms[this.data.activeRoomIndex] as unknown as
      | { room_id: string; name?: string; building?: string; floor?: string; status?: string }
      | undefined;
  },

  async onSaveRoom() {
    const room = this.currentRoom();
    if (!room) return;
    const f = this.data.roomForm;
    if (!f.name.trim()) {
      wx.showToast({ title: '请填写自习室名称', icon: 'none' });
      return;
    }
    this.setData({ roomSaving: true, roomMsg: '', roomError: '' });
    try {
      await adminOps('upsertRoom', {
        room_id: room.room_id,
        name: f.name,
        building: f.building,
        floor: f.floor,
        open_time: f.open_time,
        close_time: f.close_time,
      });
      wx.showToast({ title: '已保存', icon: 'success' });
      await this.loadSeats();
    } catch (err) {
      this.setData({ roomError: (err as Error).message || '保存失败' });
    } finally {
      this.setData({ roomSaving: false });
    }
  },

  async onToggleRoom() {
    const room = this.currentRoom();
    if (!room) return;
    const next = this.data.roomStatus === 'active' ? 'disabled' : 'active';
    this.setData({ roomMsg: '', roomError: '' });
    try {
      await adminOps('setRoomStatus', { room_id: room.room_id, status: next });
      wx.showToast({ title: next === 'active' ? '已启用' : '已停用', icon: 'success' });
      await this.loadSeats();
    } catch (err) {
      this.setData({ roomError: (err as Error).message || '操作失败' });
    }
  },

  async onAddSeats() {
    const room = this.currentRoom();
    if (!room) return;
    const count = Number(this.data.seatAddCount);
    if (!Number.isFinite(count) || count <= 0 || count > 200) {
      wx.showToast({ title: '新增数量需在 1~200 之间', icon: 'none' });
      return;
    }
    this.setData({ roomMsg: '', roomError: '' });
    wx.showLoading({ title: '新增中', mask: true });
    try {
      const res = await adminOps<{ added: string[] }>('addSeats', {
        room_id: room.room_id,
        prefix: this.data.seatPrefix || 'A',
        count,
        features: this.data.seatSelectedFeatures,
      });
      wx.showToast({ title: `已新增 ${(res.added || []).length} 座`, icon: 'success' });
      await this.loadSeats();
    } catch (err) {
      this.setData({ roomError: (err as Error).message || '新增失败' });
    } finally {
      wx.hideLoading();
    }
  },

  /**
   * 批量删除：删掉编号末尾的 N 个座位。
   * seatCells 按编号升序排，末尾即编号最大的那批 —— 正好是最近新增的，撤销误加最方便。
   * 占用中的座位云端会自动跳过（不删），只删真正空闲的。
   */
  async onRemoveLastSeats() {
    const room = this.currentRoom();
    if (!room) return;
    const count = Number(this.data.seatRemoveCount);
    if (!Number.isFinite(count) || count <= 0 || count > 200) {
      wx.showToast({ title: '删除数量需在 1~200 之间', icon: 'none' });
      return;
    }
    const total = this.data.seatCells.length;
    if (!total) {
      wx.showToast({ title: '当前自习室没有座位', icon: 'none' });
      return;
    }
    const take = Math.min(count, total);
    const targets = this.data.seatCells.slice(total - take);
    const labels = targets.map((c) => c.seat_id).join('、');
    const occupied = targets.filter((c) => c.status !== 'free');
    const confirmed = await this.confirmModal(
      '删除座位',
      `将删除末尾 ${take} 个座位：${labels}${
        occupied.length ? `\n其中 ${occupied.length} 个占用中，云端会自动跳过` : ''
      }。删除后不可恢复。`,
      '删除',
    );
    if (!confirmed) return;
    this.setData({ roomMsg: '', roomError: '' });
    wx.showLoading({ title: '删除中', mask: true });
    try {
      const res = await adminOps<{
        removed: number;
        blocked: number;
        renamed?: number;
        renumbered?: Array<{ from: string; to: string }>;
      }>('removeSeats', {
        room_id: room.room_id,
        seat_ids: targets.map((c) => c.seat_id),
      });
      const removed = Number(res.removed) || 0;
      const blocked = Number(res.blocked) || 0;
      const moved = (res.renumbered || []).length;
      const parts = [`已删除 ${removed} 个座位`];
      if (blocked > 0) parts.push(`${blocked} 个有进行中预约已跳过`);
      // 编号前移是「不留空号」规则的一部分，明确告知，避免管理员以为号被改乱了
      if (moved > 0) parts.push(`后面 ${moved} 个座位编号已前移`);
      this.setData({ roomMsg: parts.join('，') });
      wx.showToast({ title: `已删除 ${removed} 座`, icon: removed > 0 ? 'success' : 'none' });
      await this.loadSeats();
    } catch (err) {
      this.setData({ roomError: (err as Error).message || '删除失败' });
      showError(err, '批量删除失败');
    } finally {
      wx.hideLoading();
    }
  },

  /**
   * 编号重排：把当前房间的座位编号压缩成连续 1..N，补掉历史遗留的空号
   * （例如列表里出现 A-001…A-011、A-013、A-014，点一下补回 A-012）。
   * 删除座位现在会自动前移编号，这个按钮用于兜底「改动之前就已经缺号」的房间。
   */
  async onRenumberSeats() {
    const room = this.currentRoom();
    if (!room) return;
    const total = this.data.seatCells.length;
    if (total < 2) {
      wx.showToast({ title: '座位太少，无需重排', icon: 'none' });
      return;
    }
    const confirmed = await this.confirmModal(
      '编号重排',
      `将把 ${total} 个座位的编号重排为连续序号（如 A-1、A-2…），补掉中间缺的号。\n` +
        '物理位置、属性、维护状态都不变；进行中的预约会跟着改号。',
      '重排',
    );
    if (!confirmed) return;
    this.setData({ roomMsg: '', roomError: '' });
    wx.showLoading({ title: '重排中', mask: true });
    try {
      const res = await adminOps<{
        renumbered: Array<{ from: string; to: string }>;
        renamed?: number;
        total: number;
      }>('renumberSeats', { room_id: room.room_id });
      const moved = res.renumbered || [];
      if (!moved.length) {
        this.setData({ roomMsg: '编号已经是连续的，无需重排' });
        wx.showToast({ title: '编号已连续', icon: 'none' });
      } else {
        const sample = moved
          .slice(0, 3)
          .map((m) => `${m.from}→${m.to}`)
          .join('、');
        this.setData({
          roomMsg:
            `编号已重排 ${moved.length} 个（${sample}${moved.length > 3 ? ' 等' : ''}）` +
            (res.renamed ? `，${res.renamed} 条进行中预约已同步改号` : ''),
        });
        wx.showToast({ title: `已重排 ${moved.length} 个`, icon: 'success' });
      }
      await this.loadSeats();
    } catch (err) {
      this.setData({ roomError: (err as Error).message || '重排失败' });
      showError(err, '编号重排失败');
    } finally {
      wx.hideLoading();
    }
  },

  async onBatchSeats(e: OpTapEvent) {
    const room = this.currentRoom();
    if (!room) return;
    const status = String(e.currentTarget.dataset.status || 'maintain');
    const cells = this.data.seatCells.filter((c) =>
      status === 'maintain' ? c.status === 'free' : c.status === 'maintain',
    );
    if (!cells.length) {
      wx.showToast({
        title: status === 'maintain' ? '没有空闲座位' : '没有维护中的座位',
        icon: 'none',
      });
      return;
    }
    const confirmed = await this.confirmModal(
      status === 'maintain' ? '批量设维护' : '批量解除维护',
      `将对 ${cells.length} 个座位执行操作${
        status === 'maintain' ? '（有进行中预约的会自动跳过）' : ''
      }。是否继续？`,
      '确认',
    );
    if (!confirmed) return;
    this.setData({ roomMsg: '', roomError: '' });
    wx.showLoading({ title: '处理中', mask: true });
    try {
      const res = await adminOps<{ changed: number; blocked: number }>('batchSeatStatus', {
        room_id: room.room_id,
        seat_ids: cells.map((c) => c.seat_id),
        status,
      });
      this.setData({
        roomMsg: `已处理 ${res.changed} 个${
          res.blocked ? `，跳过 ${res.blocked} 个（有进行中预约）` : ''
        }`,
      });
      wx.showToast({ title: '已生效', icon: 'success' });
      await this.loadSeats();
    } catch (err) {
      this.setData({ roomError: (err as Error).message || '操作失败' });
    } finally {
      wx.hideLoading();
    }
  },

  /** Promise 化的确认弹窗 */
  confirmModal(title: string, content: string, confirmText: string) {
    return new Promise<boolean>((resolve) => {
      wx.showModal({
        title,
        content,
        confirmText,
        cancelText: '取消',
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false),
      });
    });
  },

  /**
   * 一键初始化 / 修复云端种子数据。
   * 调用已部署的 seedData 云函数（等同控制台「云端测试」点一下），
   * 用于 categories 为空导致小程序降级本地演示数据时，在端上直接修复。
   */
  async onSeedData() {
    if (this.data.seeding) return;
    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: '初始化数据',
        content: '将写入 3 个自习室及座位到云端数据库（已有数据会被覆盖为初始值），是否继续？',
        confirmText: '初始化',
        cancelText: '取消',
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;

    this.setData({ seeding: true, seedText: '正在写入…' });
    try {
      const res = await callCloud<SeedResult>('seedData', { includeDemoRecords: false });
      const c = res.data?.categories;
      this.setData({
        seedText: c
          ? `自习室写入成功 ${c.written}/${c.total}${c.skipped ? `（跳过 ${c.skipped}）` : ''}`
          : '已执行初始化',
      });
      wx.showToast({ title: '初始化完成', icon: 'success' });
      // 数据库就绪后重新拉取统计
      if (this.data.authorized) this.load();
    } catch (err) {
      this.setData({ seedText: '初始化失败' });
      showError(err, '初始化失败，请确认 seedData 已部署');
    } finally {
      this.setData({ seeding: false });
    }
  },

  goBack() {
    if (wx.canIUse('switchTab') && typeof wx.switchTab === 'function') {
      wx.switchTab({ url: '/pages/home/home' });
      return;
    }
    wx.navigateBack({ delta: 1, fail: () => wx.redirectTo({ url: '/pages/home/home' }) });
  },
});