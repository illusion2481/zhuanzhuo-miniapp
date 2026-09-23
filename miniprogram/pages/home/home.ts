import {
  fetchStudyPlan,
  recommendSeats,
  recommendCourses,
  type RecommendationResult,
  type StudyPlanResult,
  type CourseRecommendResult,
} from '../../services/recommendation';
import { callCloud } from '../../services/cloud';
import { listMyReservations } from '../../services/record';
import { listRooms } from '../../services/room';
import { toSeatDisplayName, seatFeatures } from '../../utils/seatName';
import { showError, showBusinessError } from '../../utils/error';
import { checkinWithCode } from '../../utils/checkin';
import { buildShareInvite, buildTimelineInvite } from '../../utils/share';
import { trackShare, trackCheckinDone } from '../../utils/analytics';
import { PENDING_STUDY_TASK_KEY, CHECKIN_TIMEOUT_MINUTES, TAB_PAGES } from '../../config/constants';
import { getLoginError, onLoginErrorChange, clearLoginError, login } from '../../services/auth';

interface FeatureChip {
  code: string;
  name: string;
  selected: boolean;
}

interface RoomQuick {
  room_id: string;
  name: string;
  code: string;
}

type ChipTapEvent = WechatMiniprogram.BaseEvent<
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>
>;

/**
 * 首页待签到卡（C2）：有「临近可签到」预约时展示。
 * 文案与 myReservations.rowOf 同源同构：距开始 → 可签到（剩余时长）→ 已超时。
 */
interface UpcomingCheckin {
  /** 预约记录 _id */
  id: string;
  /** 座位名（用户可读） */
  seatLabel: string;
  /** 主文案 */
  title: string;
  /** 副文案 */
  desc: string;
  /** soon=可签到 / idle=距开始还有 / danger=即将超时 / released=已释放 */
  level: 'soon' | 'idle' | 'danger' | 'released';
  /** 距开始还有多少分钟（仅 idle） */
  mins: number;
  /** 是否仍允许签到 */
  canCheckin: boolean;
}

const DURATION_OPTIONS = [
  { label: '1 小时', value: 60 },
  { label: '2 小时', value: 120 },
  { label: '3 小时', value: 180 },
];

/** 快捷入口卡片配置 */
const QUICK_ENTRIES = [
  { mode: 'quiet', icon: '/assets/icons/icon-doc.jpg', name: '安静模式', desc: '图书馆·沉浸学习' },
  { mode: 'window', icon: '/assets/icons/icon-desk-chair.jpg', name: '靠窗座位', desc: '自然光·视野开阔' },
  { mode: 'coffee', icon: '/assets/icons/icon-search.jpg', name: '休闲角落', desc: '咖啡角·轻松氛围' },
] as const;

Page({
  data: {
    title: '专注座',
    subtitle: '找到合适的座位，开始高效自习',
    phaseHint: '输入学习目标，AI 为你推荐座位',
    statusBarHeight: 44,

    goalInput: '',
    preferenceChips: [] as FeatureChip[],
    durationOptions: DURATION_OPTIONS,
    durationIndex: 1,

    planInFlight: false,
    planVisible: false,
    plan: null as StudyPlanResult | null,
    /** AI 课程推荐（学习计划弹窗内展示，与 plan 一起请求/降级） */
    planCourses: null as CourseRecommendResult | null,
    planCoursesLoading: false,
    /** 待签到卡：null 表示没有需要提醒的预约（也用于隐藏区块） */
    upcoming: null as UpcomingCheckin | null,
    checkinInFlight: false,

    // AI 选座推荐（小卡片内联式：入口直接推荐，结果横滚展示）
    recommendInFlight: false,
    recommendation: null as RecommendationResult | null,

    // 快捷入口
    quickEntries: QUICK_ENTRIES,
    roomsReady: false,

    // 登录失败横幅（云端不可用时非阻断提示 + 一键重试）
    loginError: '',
    loginRetrying: false,
  },

  async onShow() {
    // 同步 tabBar 选中态（组件 pageLifetimes.show 的路由计算时机不定，官方推荐页面侧显式刷新）
    this.getTabBar()?.refresh?.();
    // 并行拉取互不依赖的数据（categoryList / roomList），不再排队逐个 await：
    // 首帧渲染只等最快的一个回来，整体等待≈最慢一次云函数往返
    const needPref = !this.data.preferenceChips.length;
    const needRooms = !this.data.roomsReady;
    this.startTicker();
    this.loadUpcoming();
    if (needPref && needRooms) {
      await Promise.all([this.loadPreferences(), this.loadRoomsQuick()]);
    } else {
      if (needPref) await this.loadPreferences();
      if (needRooms) await this.loadRoomsQuick();
    }
  },

  onHide() {
    this.stopTicker();
  },

  onUnload() {
    this.stopTicker();
  },

  /** 每 30 秒刷新待签到卡倒计时（首页可见期间才跑） */
  _ticker: undefined as ReturnType<typeof setInterval> | undefined,
  startTicker() {
    if (this._ticker) return;
    this._ticker = setInterval(() => this.loadUpcoming(), 30000);
  },
  stopTicker() {
    if (this._ticker) {
      clearInterval(this._ticker);
      this._ticker = undefined;
    }
  },

  onLoad() {
    try {
      // getSystemInfoSync 已废弃：优先用 getWindowInfo，低版本回退
      const sysInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      this.setData({ statusBarHeight: sysInfo.statusBarHeight || 44 });
    } catch {
      // 保持默认值
    }
    // 订阅全局登录错误变化：app.ts 静默登录失败时 setLoginError → 这里实时刷新横幅
    onLoginErrorChange(() => this.syncLoginError());
    this.syncLoginError();
  },

  /** 把全局登录错误同步到本地 banner 状态 */
  syncLoginError() {
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
      this.loadUpcoming();
    } catch (err) {
      // 仍然失败：把最新错误回写到横幅
      const msg = (err as { message?: string })?.message || '登录失败，云端暂不可用';
      this.setData({ loginError: msg });
    } finally {
      this.setData({ loginRetrying: false });
    }
  },

  /** 首页待签到卡：只认「可签到」时段（开始前 30 分钟 → 签到时限内） */
  async loadUpcoming() {
    try {
      const list = await listMyReservations({ limit: 50 });
      const now = Date.now();
      const soon = list
        .filter((r) => r.status === 'pending_checkin' && !!r.start_at)
        .map((r) => ({ r, start: new Date(r.start_at as string).getTime() }))
        .filter((x) => x.start - now >= -CHECKIN_TIMEOUT_MINUTES * 60 * 1000)
        .filter((x) => x.start - now <= 30 * 60 * 1000)
        .sort((a, b) => a.start - b.start)[0];
      this.setData({ upcoming: soon ? this.upcomingCard(soon.r, soon.start, now) : null });
    } catch {
      this.setData({ upcoming: null });
    }
  },

  /** 把预约记录翻译成待签到卡数据（文案与 myReservations.rowOf 同构） */
  upcomingCard(r: { _id?: string; seat_id?: string }, start: number, now: number): UpcomingCheckin {
    const seatLabel = r.seat_id ? toSeatDisplayName({ seat_id: r.seat_id }) : '座位';
    const remain = start - now; // 距开始还差
    if (remain > 0) {
      return {
        id: r._id || '',
        seatLabel,
        title: `距开始还有 ${Math.ceil(remain / 60000)} 分钟`,
        desc: '到点后可直接签到，签到即计履约',
        level: 'idle',
        mins: Math.ceil(remain / 60000),
        canCheckin: false,
      };
    }
    const grace = CHECKIN_TIMEOUT_MINUTES * 60 * 1000; // 已过开始时刻后的宽限
    const left = grace - (now - start);
    if (left <= 0) {
      return {
        id: r._id || '',
        seatLabel,
        title: '已超过签到时限',
        desc: `开始后 ${CHECKIN_TIMEOUT_MINUTES} 分钟内未签到，座位已释放`,
        level: 'released',
        mins: 0,
        canCheckin: false,
      };
    }
    if (left <= 5 * 60 * 1000) {
      return {
        id: r._id || '',
        seatLabel,
        title: `还有 ${Math.ceil(left / 60000)} 分钟签到`,
        desc: '签到后开始计时，超时座位将被释放',
        level: 'danger',
        mins: 0,
        canCheckin: true,
      };
    }
    return {
      id: r._id || '',
      seatLabel,
      title: '现在可以签到了',
      desc: '签到后座位才会开始计时',
      level: 'soon',
      mins: 0,
      canCheckin: true,
    };
  },

  /** 待签到卡上的「去签到」：与我的预约页共用同一套定位围栏流程 */
  async onUpcomingCheckin() {
    const card = this.data.upcoming;
    if (!card || !card.canCheckin || this.data.checkinInFlight) return;
    this.setData({ checkinInFlight: true });
    try {
      const done = await checkinWithCode(card.id);
      if (done) {
        trackCheckinDone('', 'home');
        wx.showToast({ title: '签到成功', icon: 'success' });
        await this.loadUpcoming();
      }
    } catch (err) {
      // 签到失败的原因普遍是长文案（围栏距离 / 签到码房间名），toast 会截成半句话
      showBusinessError(err, '签到失败');
    } finally {
      this.setData({ checkinInFlight: false });
    }
  },

  async loadPreferences() {
    this.setData({ loadingChips: true });
    try {
      const res = await callCloud<Array<{ _id: string; code: string; name: string }>>(
        'categoryList',
        { type: 'seat_feature' },
      );
      const chips: FeatureChip[] = (res.data || [])
        // 'single'（单人位）已从种子数据移除：场馆全是单人座、无对比意义。
        // 线上库可能仍残留该分类文档（重跑 seed 是 upsert、不会删除旧文档），
        // 这里在渲染层硬过滤，保证它永远不会出现在偏好选项里。
        .filter((c) => c.code !== 'single')
        .map((c) => ({
          code: c.code,
          name: c.name,
          selected: false,
        }));
      this.setData({ preferenceChips: chips });
    } catch (err) {
      void err;
      this.setData({ preferenceChips: [] });
    } finally {
      this.setData({ loadingChips: false });
    }
  },

  /** 加载房间列表（用于快捷入口直接跳转） */
  async loadRoomsQuick() {
    try {
      const rooms = await listRooms();
      this.setData({ roomsReady: true });
      // 缓存到实例属性，供 onQuickEntry 使用
      (this as unknown as { _rooms: RoomQuick[] })._rooms = (rooms || []).map((r) => ({
        room_id: r.room_id,
        name: r.name,
        code: r.code || '',
      }));
    } catch {
      this.setData({ roomsReady: true }); // 失败也标记为已尝试
    }
  },

  /** 根据关键词从房间列表中查找 */
  findRoomByKeyword(keyword: string): RoomQuick | undefined {
    const rooms = (this as unknown as { _rooms?: RoomQuick[] })._rooms || [];
    const kw = keyword.toLowerCase();
    return rooms.find((r) =>
      r.code.toLowerCase().includes(kw) ||
      r.name.toLowerCase().includes(kw),
    );
  },

  onGoalInput(e: WechatMiniprogram.Input) {
    this.setData({ goalInput: e.detail.value });
  },

  onTogglePreference(e: ChipTapEvent) {
    const code = String(e.currentTarget.dataset.code || '');
    const chips = this.data.preferenceChips.map((c) =>
      c.code === code ? { ...c, selected: !c.selected } : c,
    );
    this.setData({ preferenceChips: chips });
  },

  onSelectDuration(e: ChipTapEvent) {
    const index = Number(e.currentTarget.dataset.index || 0);
    this.setData({ durationIndex: index });
  },

  onPickReservation(e: ChipTapEvent) {
    const dataset = e.currentTarget.dataset;
    const roomId = String(dataset.roomId || '');
    const roomName = String(dataset.roomName || '');
    const seatId = String(dataset.seatId || '');
    if (!roomId) return;
    const url = `/subpages/seats/seats?roomId=${encodeURIComponent(roomId)}&name=${encodeURIComponent(roomName)}`
      + (seatId ? `&seat=${encodeURIComponent(seatId)}` : '');
    wx.navigateTo({ url });
  },

  goRooms() {
    wx.switchTab({ url: '/pages/rooms/rooms' });
  },

  goStudy() {
    wx.switchTab({ url: '/pages/study/study' });
  },

  goSettings() {
    // 设置页（后续可接入）
    wx.showToast({ title: '设置功能开发中', icon: 'none' });
  },

  /** 快捷入口：根据模式跳转到对应房间/筛选 */
  onQuickEntry(e: ChipTapEvent) {
    const mode = String(e.currentTarget.dataset.mode || '');
    if (mode === 'quiet') {
      // 安静模式 → 图书馆
      const room = this.findRoomByKeyword('library') || this.findRoomByKeyword('图书');
      if (room) {
        wx.navigateTo({ url: `/subpages/seats/seats?roomId=${encodeURIComponent(room.room_id)}&name=${encodeURIComponent(room.name)}` });
      } else {
        wx.switchTab({ url: '/pages/rooms/rooms' });
        wx.showToast({ title: '正在前往自习室列表…', icon: 'none' });
      }
    } else if (mode === 'window') {
      // 靠窗座位 → 图书馆（靠窗座位多）
      const room = this.findRoomByKeyword('library') || this.findRoomByKeyword('图书');
      if (room) {
        wx.navigateTo({ url: `/subpages/seats/seats?roomId=${encodeURIComponent(room.room_id)}&name=${encodeURIComponent(room.name)}&highlight=window` });
      } else {
        wx.switchTab({ url: '/pages/rooms/rooms' });
        wx.showToast({ title: '正在前往自习室列表…', icon: 'none' });
      }
    } else if (mode === 'coffee') {
      // 休闲角落 → 咖啡角
      const room = this.findRoomByKeyword('coffee') || this.findRoomByKeyword('咖啡');
      if (room) {
        wx.navigateTo({ url: `/subpages/seats/seats?roomId=${encodeURIComponent(room.room_id)}&name=${encodeURIComponent(room.name)}` });
      } else {
        wx.switchTab({ url: '/pages/rooms/rooms' });
        wx.showToast({ title: '正在前往自习室列表…', icon: 'none' });
      }
    }
  },

  /** 学习计划输入框提交 */
  onPlanSubmit() {
    this.onGeneratePlan();
  },

  async onGeneratePlan() {
    if (this.data.planInFlight) return;
    this.setData({ planInFlight: true, planCoursesLoading: true, planCourses: null });
    try {
      const goal = (this.data.goalInput || '').trim();
      const preferences = this.data.preferenceChips.filter((c) => c.selected).map((c) => c.code);
      const durationMinutes = DURATION_OPTIONS[this.data.durationIndex]?.value || 120;
      // 先并行拿课程推荐（失败降级本地精选，不会拖垮计划），
      // 再把它作为「学习方式/素材」随计划请求回传，云端会按这些课程设计每个时段
      const planCourses = await recommendCourses({ goal, preferences, durationMinutes }).catch(() => null);
      const plan = await fetchStudyPlan({
        goal,
        preferences,
        durationMinutes,
        courses: planCourses?.courses || undefined,
      });
      this.setData({ plan, planCourses, planVisible: true, planInFlight: false, planCoursesLoading: false });
      if (plan.source === 'fallback') {
        const reason = plan.fallback_reason || '';
        const code = (plan as { fallback_code?: string }).fallback_code || '';
        console.error('[home:onGeneratePlan] 计划降级', code, reason);
        const title =
          reason === 'AI_NOT_CONFIGURED' || reason.indexOf('CODING_PLAN_API_KEY') !== -1
            ? 'AI 未配置，已为你生成基础计划'
            : 'AI 暂不可用，已为你生成基础计划';
        wx.showToast({ title, icon: 'none', duration: 2200 });
      }
    } catch (err) {
      this.setData({ planInFlight: false, planCoursesLoading: false });
      if ((err as { code?: string })?.code === 'AI_NOT_CONFIGURED') {
        wx.showToast({ title: 'AI 功能暂未开启', icon: 'none' });
        return;
      }
      showError(err, '生成计划失败');
    }
  },

  onClosePlan() {
    this.setData({ planVisible: false });
  },

  /**
   * 「AI 帮你选座」小卡片入口：点击**直接**推荐（不再弹全宽弹层，用户反馈）。
   * 用当前已选偏好（没有则不限）+ 默认时长；结果以小卡片横滚展示在入口下方。
   * AI 未配置时云端自动降级「基础推荐」，前端照常展示，不报错。
   */
  onRecommendSeats() {
    if (this.data.recommendInFlight) return;
    if (!this.data.preferenceChips.length) {
      // 偏好未加载完也能推荐（等价于不限偏好），静默补拉供下次使用
      void this.loadPreferences();
    }
    void this.onStartRecommend();
  },

  /** 执行推荐（入口点击 / 面板里「重新推荐」共用） */
  async onStartRecommend() {
    if (this.data.recommendInFlight) return;
    this.setData({ recommendInFlight: true });
    try {
      const goal = (this.data.goalInput || '').trim();
      const preferences = this.data.preferenceChips.filter((c) => c.selected).map((c) => c.code);
      const durationMinutes = DURATION_OPTIONS[this.data.durationIndex]?.value || 120;
      const raw = await recommendSeats({ goal, preferences, durationMinutes });
      // 给每个候选补「用户看得懂」的座位名与属性中文名（云端只回机器码）
      const picks = raw.picks.map((p) => ({
        ...p,
        seat_label: toSeatDisplayName({ seat_id: p.seat_id, features: p.features }),
        featureNames: seatFeatures(p.features),
      }));
      const recommendation = { ...raw, picks };
      this.setData({ recommendation, recommendInFlight: false });
      if (recommendation.source === 'fallback') {
        wx.showToast({ title: '已为你生成基础推荐', icon: 'none' });
      }
    } catch (err) {
      this.setData({ recommendInFlight: false });
      if ((err as { code?: string })?.code === 'AI_NOT_CONFIGURED') {
        wx.showToast({ title: 'AI 功能暂未开启，已用基础推荐', icon: 'none' });
        return;
      }
      showError(err, '推荐失败');
    }
  },

  /**
   * 开始某一段学习计划：把「段目标 + 段时长」带到学习页并自动开始番茄钟。
   * 学习页是 Tab 页，switchTab 不能带 query，所以先落本地缓存再切页。
   */
  onStartPlan(e: WechatMiniprogram.TouchEvent) {
    const plan = this.data.plan;
    const blocks = plan?.blocks || [];
    if (!blocks.length) {
      this.onClosePlan();
      return;
    }
    const rawIndex = Number(((e.currentTarget as { dataset?: { index?: unknown } }).dataset || {}).index);
    const idx = Number.isFinite(rawIndex) && rawIndex >= 0 && rawIndex < blocks.length ? rawIndex : 0;
    const block = blocks[idx];

    try {
      wx.setStorageSync(PENDING_STUDY_TASK_KEY, {
        goal: block.title || this.data.goalInput || '',
        duration_min: block.duration_min || 0,
        segment_index: idx,
        created_at: Date.now(),
      });
    } catch {
      wx.showToast({ title: '本地存储不可用', icon: 'none' });
      return;
    }

    this.setData({ planVisible: false });
    wx.showToast({
      title: block.duration_min ? `第 ${idx + 1} 段 · ${block.duration_min} 分钟` : `开始第 ${idx + 1} 段`,
      icon: 'none',
      duration: 1800,
    });
    wx.switchTab({ url: TAB_PAGES.STUDY });
  },

  onShareAppMessage() {
    // 埋点：分享入口
    trackShare('tap');
    return buildShareInvite({
      title: '专注座 · 自习室在线预约，到点自动签到',
      path: 'pages/home/home',
    });
  },

  onShareTimeline() {
    return buildTimelineInvite({
      title: '专注座 · 自习室在线预约，到点自动签到',
    });
  },
});
