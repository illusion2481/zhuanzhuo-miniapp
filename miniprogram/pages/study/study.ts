import {
  startStudy,
  pauseStudy,
  resumeStudy,
  completeStudy,
  abandonStudy,
  listMyStudies,
  fetchStudySummary,
  computeStudyActiveSeconds,
  updateStudyRecord,
  deleteStudyRecord,
  syncPomodoro,
  type StudySummary,
} from '../../services/record';
import { fetchStudyAiSummary, type StudySummaryResult } from '../../services/recommendation';
import { showError } from '../../utils/error';
import { buildShare } from '../../utils/share';
import {
  applyPhaseCatchUp,
  configFromPayload,
  currentPhase,
  deriveCount,
  formatRemain,
  loadConfig,
  normalizeConfig,
  saveConfig,
  DEFAULT_BREAK_MIN,
  DEFAULT_FOCUS_MIN,
  MAX_BREAK_MIN,
  MAX_FOCUS_MIN,
  type PomodoroConfig,
  type PomodoroSegment,
  type CatchUpResult,
} from '../../utils/pomodoro';
import { PENDING_STUDY_TASK_KEY, PENDING_STUDY_TASK_TTL } from '../../config/constants';
import type { BusinessRecord } from '../../types/record';

interface SessionView {
  id: string;
  goal: string;
  startLabel: string;
  durationLabel: string;
  statusLabel: string;
  /** 真实完成的专注段数（不再由时长换算） */
  pomodoroHint: number;
  /** 当前阶段：专注 / 休息 */
  phaseType: 'focus' | 'break' | '';
  phaseLabel: string;
  phaseRemain: string;
  phasePercent: number;
  configLabel: string;
}

interface RecentSessionView extends SessionView {
  endLabel: string;
  status: string;
}

/** 首页学习计划交接过来的「某一段」待办 */
interface PendingStudyTask {
  goal?: string;
  duration_min?: number;
  segment_index?: number;
  created_at?: number;
}

interface DailyChartCell {
  date: string;
  label: string;
  minutes: number;
  height: number;
  active: boolean;
  today: boolean;
  /** 本周尚未到达的日期（周一~周日固定轴，未来日淡化显示） */
  future: boolean;
}

const CHART_DAYS = 7;
/** 切 tab 回本研究页时，距上次全量刷新小于该毫秒数则跳过（避免频繁 5 连发云函数） */
const STUDY_REFRESH_DEBOUNCE_MS = 30_000;
/** 番茄时长快捷档 */
const POMODORO_PRESETS = [
  { label: '标准 25/5', focus_min: 25, break_min: 5 },
  { label: '长专注 45/10', focus_min: 45, break_min: 10 },
  { label: '课堂 50/10', focus_min: 50, break_min: 10 },
];
/** 编辑时长上限（分钟），与云函数 EDIT_MAX_MINUTES 保持一致 */
const EDIT_MAX_MINUTES = 1440;
/** runCatchUp 在暂停期间返回的空结果 */
const NO_CHANGE: CatchUpResult = { segments: [], changed: false, focusDone: 0, breakDone: 0 };

function startOfDayIso(d: Date = new Date()): string {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.toISOString();
}

/** 周一为周开始（中国习惯） */
function startOfWeekIso(d: Date = new Date()): string {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay() === 0 ? 7 : x.getDay();
  x.setDate(x.getDate() - (day - 1));
  return x.toISOString();
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(safe / 3600);
  const mm = Math.floor((safe % 3600) / 60);
  const ss = safe % 60;
  if (hh > 0) {
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function formatTimeLabel(iso: string | undefined): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 只显示 时:分（HH:MM），用于同日时段的结束侧，避免「9/20 17:29 → 9/20 17:50」这类重复 */
function formatClockLabel(iso: string | undefined): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function isSameDayLabel(aIso: string | undefined, bIso: string | undefined): boolean {
  if (!aIso || !bIso) return false;
  const a = new Date(aIso);
  const b = new Date(bIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function payloadOf(record: BusinessRecord): {
  goal: string;
  pause_segments: Array<{ start: string; end?: string | null }>;
  pomodoro_count: number;
  actual_duration_sec: number;
  pomodoro_segments: Array<{ type: string; start: string; end?: string; completed?: boolean }>;
  focus_min: number;
  break_min: number;
} {
  const payload = (record.payload || {}) as Record<string, unknown>;
  return {
    goal: typeof payload.goal === 'string' ? payload.goal : '',
    pause_segments: Array.isArray(payload.pause_segments)
      ? (payload.pause_segments as Array<{ start: string; end?: string | null }>)
      : [],
    pomodoro_count: typeof payload.pomodoro_count === 'number' ? payload.pomodoro_count : 0,
    actual_duration_sec: typeof payload.actual_duration_sec === 'number' ? payload.actual_duration_sec : 0,
    pomodoro_segments: Array.isArray(payload.pomodoro_segments)
      ? (payload.pomodoro_segments as Array<{ type: string; start: string; end?: string; completed?: boolean }>)
      : [],
    focus_min: typeof payload.focus_min === 'number' ? payload.focus_min : 0,
    break_min: typeof payload.break_min === 'number' ? payload.break_min : 0,
  };
}

function isRunning(record: BusinessRecord): boolean {
  return record.status === 'running';
}

function isPausedNow(record: BusinessRecord): boolean {
  if (!isRunning(record)) return false;
  const seg = payloadOf(record).pause_segments;
  const last = seg[seg.length - 1];
  return !!(last && !last.end);
}

Page({
  data: {
    loading: false,
    actionInFlight: false,
    goalInput: '',
    current: null as SessionView | null,
    isPaused: false,
    todayMinutes: 0,
    todaySessions: 0,
    weekMinutes: 0,
    weekPomodoros: 0,
    weekSessions: 0,
    recent: [] as RecentSessionView[],
    aiSummary: null as StudySummaryResult | null,
    aiSummaryLoading: false,
    chart: [] as DailyChartCell[],
    /** 本周柱状图是否全空（用于空态文案，避免用户误以为图表坏了） */
    chartEmpty: true,
    loadError: '',

    // ====== 番茄钟 ======
    pomodoroPresets: POMODORO_PRESETS,
    pomodoroRangeHint: `专注 1~${MAX_FOCUS_MIN} 分钟 · 休息 1~${MAX_BREAK_MIN} 分钟`,
    pomodoroConfig: normalizeConfig(null) as PomodoroConfig,
    pomodoroSettingsVisible: false,
    pomodoroFocusInput: String(DEFAULT_FOCUS_MIN),
    pomodoroBreakInput: String(DEFAULT_BREAK_MIN),
    phaseAlertVisible: false,
    phaseAlertTitle: '',
    phaseAlertBody: '',
    phaseAlertCanSkip: false,

    // ====== 学习记录编辑 ======
    editVisible: false,
    editId: '',
    editGoal: '',
    editDuration: '',
    // 进行中的记录时长由系统实时推算，不允许手改
    editDurationDisabled: false,
    editSaving: false,
    editDeleting: false,
  },

  // ====== 本地计时器 ======
  tickerTimer: 0 as number,
  currentRecord: null as BusinessRecord | null,
  // recent 的原始记录，编辑弹窗需要读当前时长做默认值
  recentRecords: [] as BusinessRecord[],
  // ====== 番茄状态（不进 data，避免每秒 diff） ======
  pomodoroSegments: [] as PomodoroSegment[],
  pomodoroConfig: normalizeConfig(null) as PomodoroConfig,
  pauseStartMs: 0 as number,
  pomodoroSyncing: false as boolean,

  onUnload() {
    this.clearTicker();
  },

  onHide() {
    // 切后台后回来再拉一次云端，避免本地秒数长期漂移
    this.clearTicker();
  },

  clearTicker() {
    if (this.tickerTimer) {
      clearInterval(this.tickerTimer as unknown as number);
      this.tickerTimer = 0;
    }
  },

  startTicker(record: BusinessRecord) {
    this.clearTicker();
    const refreshView = () => {
      const res = this.runCatchUp(record);
      if (res.changed) {
        // 段落发生推进才上报云端并提醒，避免每秒打接口
        void this.persistPomodoro(record);
        this.notifyPhaseEnd(res.focusDone, res.breakDone);
      }
      this.setData({
        current: this.composeCurrentView(record),
        isPaused: isPausedNow(record),
      });
    };
    refreshView();
    this.tickerTimer = setInterval(refreshView, 1000) as unknown as number;
  },

  // ====== 番茄钟：基于时间戳的惰性结算 ======

  /** 从云端记录恢复本次会话的段落轨迹与配置 */
  restorePomodoro(record: BusinessRecord) {
    const payload = payloadOf(record);
    const cloud = Array.isArray(payload.pomodoro_segments)
      ? (payload.pomodoro_segments as unknown as PomodoroSegment[])
      : [];
    this.pomodoroSegments = cloud.filter((s) => s && s.start).map((s) => ({ ...s }));
    // 会话自带配置优先，旧会话没有则沿用本地设置
    this.pomodoroConfig = payload.focus_min
      ? configFromPayload(payload)
      : loadConfig();
    this.setData({
      pomodoroConfig: this.pomodoroConfig,
      pomodoroFocusInput: String(this.pomodoroConfig.focus_min),
      pomodoroBreakInput: String(this.pomodoroConfig.break_min),
    });
  },

  /**
   * 结算到期段落：把已经走完的专注/休息段落标记为完成，并自动开启下一段。
   * 暂停期间不推进（主动暂停不该被算进番茄）。
   */
  runCatchUp(record: BusinessRecord): CatchUpResult {
    if (this.pauseStartMs) return NO_CHANGE;
    const nowMs = Date.now();
    const startMs = new Date(record.start_at || record.created_at).getTime();
    const res = applyPhaseCatchUp(startMs, this.pomodoroSegments, this.pomodoroConfig, nowMs);
    if (res.changed) this.pomodoroSegments = res.segments;
    return res;
  },

  /** 全量重推到云端，幂等；失败静默，下一次结算会自动重试 */
  async persistPomodoro(record: BusinessRecord | null) {
    if (!record || this.pomodoroSyncing) return;
    this.pomodoroSyncing = true;
    try {
      await syncPomodoro({
        record_id: record._id,
        segments: this.pomodoroSegments,
        focus_min: this.pomodoroConfig.focus_min,
        break_min: this.pomodoroConfig.break_min,
      });
    } catch {
      /* 网络抖动忽略：下次段落变化或每轮 tick 会再推 */
    } finally {
      this.pomodoroSyncing = false;
    }
  },

  /** 到点提醒：震动 + 弹窗 */
  notifyPhaseEnd(focusDone: number, breakDone: number) {
    const cfg = this.pomodoroConfig;
    try {
      wx.vibrateLong({});
    } catch {
      /* 部分机型不支持震动 */
    }
    if (focusDone > 0) {
      this.setData({
        phaseAlertVisible: true,
        phaseAlertTitle: `第 ${deriveCount(this.pomodoroSegments)} 个番茄完成`,
        phaseAlertBody: `专注了 ${cfg.focus_min} 分钟，去休息 ${cfg.break_min} 分钟吧`,
        phaseAlertCanSkip: true,
      });
      return;
    }
    if (breakDone > 0) {
      this.setData({
        phaseAlertVisible: true,
        phaseAlertTitle: '休息结束',
        phaseAlertBody: `准备开始下一个 ${cfg.focus_min} 分钟专注`,
        phaseAlertCanSkip: false,
      });
    }
  },

  onClosePhaseAlert() {
    this.setData({ phaseAlertVisible: false });
  },

  /** 跳过休息：立刻结束当前休息段并开启专注段 */
  async onSkipBreak() {
    const list = this.pomodoroSegments;
    const last = list[list.length - 1];
    if (last && last.type === 'break' && !last.completed) {
      last.end = new Date().toISOString();
      last.completed = true;
      list.push({ type: 'focus', start: last.end, completed: false });
      void this.persistPomodoro(this.currentRecord);
    }
    this.setData({ phaseAlertVisible: false });
    if (this.currentRecord) {
      this.setData({ current: this.composeCurrentView(this.currentRecord) });
    }
  },

  // ====== 番茄设置 ======

  onOpenPomodoroSettings() {
    this.setData({
      pomodoroSettingsVisible: true,
      pomodoroFocusInput: String(this.pomodoroConfig.focus_min),
      pomodoroBreakInput: String(this.pomodoroConfig.break_min),
    });
  },

  /** 空闲卡：直接点选番茄节奏方案，立即生效（不走「调整」弹窗） */
  onPickIdlePreset(e: WechatMiniprogram.CustomEvent) {
    const index = Number((e.currentTarget as unknown as { dataset: { index?: string } }).dataset.index);
    const preset = POMODORO_PRESETS[index];
    if (!preset) return;
    const next = saveConfig({ focus_min: preset.focus_min, break_min: preset.break_min });
    this.pomodoroConfig = next;
    this.setData({
      pomodoroConfig: next,
      pomodoroFocusInput: String(next.focus_min),
      pomodoroBreakInput: String(next.break_min),
    });
    void this.persistPomodoro(this.currentRecord);
  },

  onClosePomodoroSettings() {
    this.setData({ pomodoroSettingsVisible: false });
  },

  onPomodoroFocusInput(e: WechatMiniprogram.Input) {
    this.setData({ pomodoroFocusInput: e.detail.value });
  },

  onPomodoroBreakInput(e: WechatMiniprogram.Input) {
    this.setData({ pomodoroBreakInput: e.detail.value });
  },

  onPickPomodoroPreset(e: WechatMiniprogram.CustomEvent) {
    const index = Number((e.currentTarget as unknown as { dataset: { index?: string } }).dataset.index);
    const preset = POMODORO_PRESETS[index];
    if (!preset) return;
    this.setData({
      pomodoroFocusInput: String(preset.focus_min),
      pomodoroBreakInput: String(preset.break_min),
    });
  },

  onSavePomodoroConfig() {
    const rawFocus = (this.data.pomodoroFocusInput || '').trim();
    const rawBreak = (this.data.pomodoroBreakInput || '').trim();
    // normalizeConfig 内部会 clamp 到合法区间；空值或非法值回退默认档
    const next = saveConfig({
      focus_min: rawFocus ? Number(rawFocus) : DEFAULT_FOCUS_MIN,
      break_min: rawBreak ? Number(rawBreak) : DEFAULT_BREAK_MIN,
    });
    this.pomodoroConfig = next;
    this.setData({
      pomodoroSettingsVisible: false,
      pomodoroConfig: next,
      pomodoroFocusInput: String(next.focus_min),
      pomodoroBreakInput: String(next.break_min),
    });
    // 运行中改配置立即作用于当前段，并同步给云端保证多端一致
    void this.persistPomodoro(this.currentRecord);
    if (this.currentRecord) {
      this.setData({ current: this.composeCurrentView(this.currentRecord) });
    }
    wx.showToast({ title: `${next.focus_min}/${next.break_min} 分钟`, icon: 'none' });
  },

  // ====== 视图合成 ======

  composeCurrentView(record: BusinessRecord): SessionView {
    const payload = payloadOf(record);
    const seg = computeStudyActiveSeconds(record);
    // 结算一次，保证恢复/切换后台回来时显示不落后
    this.runCatchUp(record);
    const phase = currentPhase(this.pomodoroSegments, this.pomodoroConfig, Date.now());
    const cfg = this.pomodoroConfig;
    return {
      id: record._id,
      goal: payload.goal || '（未命名目标）',
      startLabel: `开始于 ${formatTimeLabel(record.start_at || record.created_at)}`,
      durationLabel: formatDuration(seg),
      statusLabel: isPausedNow(record) ? '已暂停' : '进行中',
      pomodoroHint: deriveCount(this.pomodoroSegments),
      phaseType: phase ? phase.type : '',
      phaseLabel: phase ? (phase.type === 'focus' ? '专注中' : '休息中') : '未开始',
      phaseRemain: phase ? formatRemain(phase.remainMs) : '--:--',
      phasePercent: phase ? Math.round(phase.progress * 100) : 0,
      configLabel: `${cfg.focus_min} 分钟专注 · ${cfg.break_min} 分钟休息`,
    };
  },

  composeRecent(record: BusinessRecord): RecentSessionView {
    const payload = payloadOf(record);
    const seg = payload.actual_duration_sec || computeStudyActiveSeconds(record);
    const statusMap: Record<string, string> = {
      running: '进行中',
      completed: '已完成',
      abandoned: '已结束',
    };
    return {
      id: record._id,
      status: record.status,
      goal: payload.goal || '（未命名目标）',
      startLabel: formatTimeLabel(record.start_at || record.created_at),
      // 同日结束只显 HH:MM，跨日才带日期；不再有「结束于」前缀
      endLabel: record.end_at
        ? isSameDayLabel(record.start_at || record.created_at, record.end_at)
          ? formatClockLabel(record.end_at)
          : formatTimeLabel(record.end_at)
        : '',
      durationLabel: formatDuration(seg),
      statusLabel: statusMap[record.status] || record.status,
      // 有分段轨迹用真实完成数，历史记录回退除法
      pomodoroHint: deriveCount(payload.pomodoro_segments) || Math.floor(seg / 1500) || payload.pomodoro_count || 0,
      phaseType: '',
      phaseLabel: '',
      phaseRemain: '',
      phasePercent: 0,
      configLabel: '',
    };
  },

  // ====== 生命周期 ======

  async onShow() {
    // 同步 tabBar 选中态（组件 pageLifetimes.show 的路由计算时机不稳，官方推荐页面侧显式刷新）
    this.getTabBar()?.refresh?.();
    // 防抖：刚从别处切回（30s 内）且有已加载数据时，不再全量重拉 5 个云函数，
    // 由进行中番茄钟的秒级 ticker 兜底保持屏幕新鲜；避免频繁切 tab 触发 5 连发。
    const recentRefresh = this._lastRefreshAt && Date.now() - this._lastRefreshAt < STUDY_REFRESH_DEBOUNCE_MS;
    if (recentRefresh && this.currentRecord) {
      // onHide 已清掉 ticker，防抖命中时若有进行中会话须重启秒级刷新，否则界面静止
      this.startTicker(this.currentRecord);
      await this.consumePendingPlanTask();
      return;
    }
    if (!recentRefresh) {
      await this.refresh();
    }
    await this.consumePendingPlanTask();
  },

  /** 最近一次全量刷新的时间戳（毫秒），用于切 tab 防抖 */
  _lastRefreshAt: 0,

  /**
   * 消费首页「学习计划」交接过来的待办：预填目标并自动开始一次专注。
   * 已经有一段进行中时不覆盖，只提示，避免打断当前番茄钟。
   */
  async consumePendingPlanTask() {
    let task: PendingStudyTask | null = null;
    try {
      task = (wx.getStorageSync(PENDING_STUDY_TASK_KEY) as PendingStudyTask) || null;
    } catch {
      task = null;
    }
    if (!task) return;
    try {
      wx.removeStorageSync(PENDING_STUDY_TASK_KEY);
    } catch {
      /* 清理失败不影响主流程 */
    }
    // 放太久的计划不再自动开始，避免隔天回来莫名启动番茄钟
    if (task.created_at && Date.now() - task.created_at > PENDING_STUDY_TASK_TTL) return;
    if (this.data.current) {
      wx.showToast({ title: '已有进行中的学习，先完成它', icon: 'none' });
      return;
    }
    const minutes = Number(task.duration_min) || 0;
    const goalText = String(task.goal || '').trim();
    this.setData({
      goalInput: minutes ? `${goalText}（计划 ${minutes} 分钟）` : goalText,
    });
    // 计划段自带时长时，用该时长作为本次专注长度，「开始第 N 段」才名副其实
    if (minutes >= 1) {
      this.pomodoroConfig = normalizeConfig({
        focus_min: minutes,
        break_min: this.pomodoroConfig.break_min,
      });
      this.setData({
        pomodoroConfig: this.pomodoroConfig,
        pomodoroFocusInput: String(this.pomodoroConfig.focus_min),
      });
    }
    await this.onStart();
  },

  async refresh() {
    this.setData({ loading: true });
    try {
      const tasks: Array<Promise<unknown>> = [];
      const state: {
        current: BusinessRecord | null;
        today: StudySummary | null;
        week: StudySummary | null;
        recent: BusinessRecord[];
        weekRecords: BusinessRecord[];
      } = { current: null, today: null, week: null, recent: [], weekRecords: [] };

      tasks.push(
        listMyStudies({ status: 'running', limit: 1 })
          .then((rows) => { state.current = rows && rows[0] ? rows[0] : null; })
          .catch(() => { state.current = null; }),
      );

      tasks.push(
        fetchStudySummary(startOfDayIso())
          .then((s) => { state.today = s; })
          .catch(() => { state.today = null; }),
      );

      tasks.push(
        fetchStudySummary(startOfWeekIso())
          .then((s) => { state.week = s; })
          .catch(() => { state.week = null; }),
      );

      tasks.push(
        listMyStudies({ limit: 10 })
          .then((rows) => { state.recent = rows || []; })
          .catch(() => { state.recent = []; }),
      );

      tasks.push(
        listMyStudies({ limit: 200, since: startOfWeekIso() })
          .then((rows) => { state.weekRecords = rows || []; })
          .catch(() => { state.weekRecords = []; }),
      );

      await Promise.all(tasks);

      this.recentRecords = state.recent;
      const recentView = state.recent.map((r) => this.composeRecent(r));
      const todayView = state.today || { total_seconds: 0, completed_count: 0 } as StudySummary;
      const weekView = state.week || { total_seconds: 0, pomodoro_total: 0, completed_count: 0 } as StudySummary;
      const chart = this.composeChart(state.weekRecords);

      this.currentRecord = state.current;
      if (state.current) {
        this.restorePomodoro(state.current);
        this.runCatchUp(state.current);
      }
      this.setData({
        loading: false,
        current: state.current ? this.composeCurrentView(state.current) : null,
        isPaused: state.current ? isPausedNow(state.current) : false,
        todayMinutes: Math.floor((todayView.total_seconds || 0) / 60),
        todaySessions: todayView.completed_count || 0,
        weekMinutes: Math.floor((weekView.total_seconds || 0) / 60),
        weekPomodoros: weekView.pomodoro_total || 0,
        weekSessions: weekView.completed_count || 0,
        recent: recentView,
        chart,
        chartEmpty: chart.every((c) => c.minutes === 0),
        loadError: '',
      });
      this._lastRefreshAt = Date.now();

      if (state.current) {
        // 回到前台先补推可能漏同步的段落，再启动秒级刷新
        void this.persistPomodoro(state.current);
        this.startTicker(state.current);
      } else {
        this.clearTicker();
      }
    } catch (err) {
      this.setData({ loading: false, loadError: String(((err as { message?: string }) || {}).message || '刷新学习页失败') });
    }
  },

  onRetryRefresh() {
    this.refresh();
  },

  // ====== 用户交互 ======

  onGoalInput(e: WechatMiniprogram.Input) {
    this.setData({ goalInput: e.detail.value });
  },

  async onStart() {
    if (this.data.actionInFlight) return;
    this.setData({ actionInFlight: true });
    try {
      const goal = (this.data.goalInput || '').trim();
      const reservation = wx.getStorageSync('activeReservation') as { _id?: string; room_id?: string; seat_id?: string } | null;
      const cfg = this.pomodoroConfig;
      const record = await startStudy({
        goal: goal || undefined,
        reservation_id: reservation?._id,
        room_id: reservation?.room_id,
        seat_id: reservation?.seat_id,
        // 番茄配置随会话写入，换设备续学时口径一致
        focus_min: cfg.focus_min,
        break_min: cfg.break_min,
      });
      this.currentRecord = record;
      this.pomodoroSegments = [];
      this.pauseStartMs = 0;
      this.runCatchUp(record);
      this.setData({
        current: this.composeCurrentView(record),
        isPaused: false,
        goalInput: '',
      });
      this.startTicker(record);
      wx.showToast({ title: `开始 ${cfg.focus_min} 分钟专注`, icon: 'success' });
    } catch (err) {
      showError(err, '开始专注失败');
    } finally {
      this.setData({ actionInFlight: false });
    }
  },

  async onPause() {
    const record = this.currentRecord;
    if (!record || this.data.actionInFlight) return;
    this.setData({ actionInFlight: true });
    try {
      void this.persistPomodoro(record);
      const updated = await pauseStudy(record._id);
      this.currentRecord = updated;
      // 主动暂停期间冻结番茄推进
      this.pauseStartMs = Date.now();
      this.setData({
        current: this.composeCurrentView(updated),
        isPaused: true,
      });
    } catch (err) {
      showError(err, '暂停失败');
    } finally {
      this.setData({ actionInFlight: false });
    }
  },

  async onResume() {
    const record = this.currentRecord;
    if (!record || this.data.actionInFlight) return;
    this.setData({ actionInFlight: true });
    try {
      const updated = await resumeStudy(record._id);
      this.currentRecord = updated;
      // 把当前未完成的段整体后移暂停时长，暂停时间不被算进番茄
      if (this.pauseStartMs) {
        const pausedMs = Date.now() - this.pauseStartMs;
        this.pauseStartMs = 0;
        const last = this.pomodoroSegments[this.pomodoroSegments.length - 1];
        if (last && !last.completed && last.start) {
          last.start = new Date(new Date(last.start).getTime() + pausedMs).toISOString();
        }
      }
      void this.persistPomodoro(updated);
      this.startTicker(updated);
      this.setData({
        current: this.composeCurrentView(updated),
        isPaused: false,
      });
    } catch (err) {
      showError(err, '恢复失败');
    } finally {
      this.setData({ actionInFlight: false });
    }
  },

  async onComplete() {
    const record = this.currentRecord;
    if (!record || this.data.actionInFlight) return;
    this.setData({ actionInFlight: true });
    try {
      // 结束前必须把最后一段推上去，否则本次番茄会被漏记
      this.runCatchUp(record);
      await this.persistPomodoro(record);
      const updated = await completeStudy(record._id);
      this.clearTicker();
      this.currentRecord = null;
      this.pomodoroSegments = [];
      this.setData({ current: null, isPaused: false });
      const duration = ((updated.payload as { actual_duration_sec?: number } | undefined)?.actual_duration_sec || 0);
      wx.showToast({ title: `完成 ${formatDuration(duration)}`, icon: 'success' });
      await this.refresh();
    } catch (err) {
      showError(err, '结束学习失败');
    } finally {
      this.setData({ actionInFlight: false });
    }
  },

  async onAbandon() {
    const record = this.currentRecord;
    if (!record || this.data.actionInFlight) return;
    this.setData({ actionInFlight: true });
    try {
      this.runCatchUp(record);
      await this.persistPomodoro(record);
      await abandonStudy(record._id, '用户主动结束');
      this.clearTicker();
      this.currentRecord = null;
      this.pomodoroSegments = [];
      this.setData({ current: null, isPaused: false });
      wx.showToast({ title: '已结束', icon: 'none' });
      await this.refresh();
    } catch (err) {
      showError(err, '结束学习失败');
    } finally {
      this.setData({ actionInFlight: false });
    }
  },

  async onPullRefresh() {
    await this.refresh();
    wx.stopPullDownRefresh();
  },

  async onFetchAiSummary() {
    if (this.data.aiSummaryLoading) return;
    this.setData({ aiSummaryLoading: true });
    try {
      const result = await fetchStudyAiSummary({ since: startOfWeekIso() });
      this.setData({ aiSummary: result });
      if (result.source === 'fallback') {
        const reason = result.fallback_reason || '';
        const code = (result as { fallback_code?: string }).fallback_code || '';
        console.error('[study:onFetchAiSummary] 总结降级', code, reason);
        const title = reason === 'AI_NOT_CONFIGURED'
          ? 'AI 未配置，已为你生成基础总结'
          : reason.indexOf('CODING_PLAN_API_KEY') !== -1 || reason.indexOf('AI_NOT_CONFIGURED') !== -1
            ? 'AI 未配置，已为你生成基础总结'
            : 'AI 暂不可用，已为你生成基础总结';
        wx.showToast({ title, icon: 'none', duration: 2200 });
      }
    } catch (err) {
      if ((err as { code?: string })?.code === 'AI_NOT_CONFIGURED') {
        wx.showToast({ title: 'AI 功能暂未开启', icon: 'none' });
        return;
      }
      showError(err, '生成 AI 总结失败');
    } finally {
      this.setData({ aiSummaryLoading: false });
    }
  },

  onCloseAiSummary() {
    this.setData({ aiSummary: null });
  },

  // ====== 学习记录编辑（名称 / 时长）======

  onEditRecent(e: WechatMiniprogram.TouchEvent) {
    const ds = e.currentTarget.dataset as { id?: string };
    const id = String(ds.id || '');
    if (!id) return;
    const record = this.recentRecords.find((r) => r._id === id);
    if (!record) return;
    const payload = payloadOf(record);
    const sec = payload.actual_duration_sec || computeStudyActiveSeconds(record);
    // 进行中的记录时长由系统实时推算，手改没有意义
    const running = isRunning(record);
    this.setData({
      editVisible: true,
      editId: id,
      editGoal: payload.goal,
      editDuration: running ? '' : String(Math.max(1, Math.round(sec / 60))),
      editDurationDisabled: running,
    });
  },

  onEditGoalInput(e: WechatMiniprogram.Input) {
    this.setData({ editGoal: e.detail.value });
  },

  onEditDurationInput(e: WechatMiniprogram.Input) {
    this.setData({ editDuration: e.detail.value });
  },

  onCloseEdit() {
    this.setData({ editVisible: false });
  },

  /** 阻止弹窗内部点击冒泡到遮罩层（避免点输入框时误关闭） */
  onNoop() {
    /* 故意空实现 */
  },

  async onSaveEdit() {
    if (this.data.editSaving) return;
    const goal = (this.data.editGoal || '').trim();
    const rawDuration = (this.data.editDuration || '').trim();
    const payload: { record_id: string; goal?: string; duration_min?: number } = {
      record_id: this.data.editId,
      goal,
    };

    if (this.data.editDurationDisabled) {
      // 进行中：只提交名称
    } else if (rawDuration !== '') {
      const minutes = Number(rawDuration);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        wx.showToast({ title: '时长请填正整数分钟', icon: 'none' });
        return;
      }
      if (minutes > EDIT_MAX_MINUTES) {
        wx.showToast({ title: `时长不能超过 ${EDIT_MAX_MINUTES} 分钟`, icon: 'none' });
        return;
      }
      payload.duration_min = Math.round(minutes);
    }

    this.setData({ editSaving: true });
    try {
      await updateStudyRecord(payload);
      this.setData({ editVisible: false });
      wx.showToast({ title: '已保存', icon: 'success' });
      await this.refresh();
    } catch (err) {
      showError(err, '保存失败');
    } finally {
      this.setData({ editSaving: false });
    }
  },

  /** 删除当前编辑的学习记录：二次确认后调云端删除，成功后刷新列表 */
  onDeleteEdit() {
    if (this.data.editDeleting) return;
    const id = this.data.editId;
    if (!id) return;
    wx.showModal({
      title: '删除学习记录',
      content: '删除后不可恢复，确定删除这条记录吗？',
      confirmText: '删除',
      confirmColor: '#E5484D',
      success: async (res) => {
        if (!res.confirm) return;
        this.setData({ editDeleting: true });
        try {
          await deleteStudyRecord(id);
          this.setData({ editVisible: false });
          wx.showToast({ title: '已删除', icon: 'success' });
          await this.refresh();
        } catch (err) {
          showError(err, '删除失败');
        } finally {
          this.setData({ editDeleting: false });
        }
      },
    });
  },

  /** 把「本周（周一~周日）」的 records 按天 group 成 7 个柱状图 cells */
  composeChart(records: BusinessRecord[]): DailyChartCell[] {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // 与「本周」统计卡同口径：从本周一 00:00 起，共 7 天。
    // 曾用「今天往前 7 天」画轴，但数据只取本周 → 周一/周二时半张图必然全空，
    // 且轴上会出现上周日期，与标题「本周」矛盾。
    const weekStart = new Date(today.getTime());
    const weekday = weekStart.getDay() === 0 ? 7 : weekStart.getDay();
    weekStart.setDate(weekStart.getDate() - (weekday - 1));
    const WEEK_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const buckets: Array<{ key: string; label: string; minutes: number; today: boolean; future: boolean }> = [];
    for (let i = 0; i < CHART_DAYS; i += 1) {
      const d = new Date(weekStart.getTime());
      d.setDate(weekStart.getDate() + i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const isToday = d.getTime() === today.getTime();
      buckets.push({
        key,
        label: isToday ? '今' : WEEK_LABELS[i],
        minutes: 0,
        today: isToday,
        future: d.getTime() > today.getTime(),
      });
    }
    for (const r of records) {
      const seg = payloadOf(r).actual_duration_sec || computeStudyActiveSeconds(r);
      const startedAt = new Date(r.start_at || r.created_at);
      if (Number.isNaN(startedAt.getTime())) continue;
      const k = `${startedAt.getFullYear()}-${String(startedAt.getMonth() + 1).padStart(2, '0')}-${String(startedAt.getDate()).padStart(2, '0')}`;
      const bucket = buckets.find((b) => b.key === k);
      if (bucket) bucket.minutes += Math.floor(seg / 60);
    }
    const max = Math.max(1, ...buckets.map((b) => b.minutes));
    return buckets.map((b) => ({
      date: b.key,
      label: b.label,
      minutes: b.minutes,
      // 空数据日不画柱；有数据的柱子最低 10% 保证小值也看得见
      height: b.minutes > 0 ? Math.min(100, Math.max(10, Math.round((b.minutes / max) * 100))) : 0,
      active: b.minutes > 0,
      today: b.today,
      future: b.future,
    }));
  },

  onShareAppMessage() {
    return buildShare({
      title: '专注座 · 番茄钟 + 学习记录，让专注看得见',
      path: 'pages/study/study',
    });
  },
});
