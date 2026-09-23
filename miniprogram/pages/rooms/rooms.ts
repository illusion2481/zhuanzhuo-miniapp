import { listRooms, isRealtimeSeats, describeRoomSource } from '../../services/room';
import { showError } from '../../utils/error';
import type { RoomSummary } from '../../types/room';
import { floorPlans } from '../../config/floorPlans';

/** 房间 code 前缀 / 关键词 → floorPlans key 映射（与 seats 页共用同一套映射逻辑） */
const ROOM_FLOORPLAN_MAP: Record<string, string> = {
  library: 'library',
  teaching: 'classroom',
  cafe: 'coffee-corner',
  coffee: 'coffee-corner',
};

/** 根据房间 code 匹配平面图配置 */
function resolveRoomFloorPlan(roomCode: string): (typeof floorPlans)[string] | null {
  if (!roomCode) return null;
  if (floorPlans[roomCode]) return floorPlans[roomCode];
  const prefix = roomCode.split('_')[0];
  const key = ROOM_FLOORPLAN_MAP[prefix] || ROOM_FLOORPLAN_MAP[roomCode];
  return key ? floorPlans[key] : null;
}

/**
 * 迷你座位预览的渲染上限。房间座位数通常 ≤ 20，实际不会触发；
 * 仅用于兜底极端房间（如 200 座大自习室）时不把卡片撑爆 —— 超出部分用「+N」表达。
 */
const MINI_SEAT_MAX = 40;

/** 单个座位状态 → 迷你格样式后缀 */
function toMiniStatus(s: { status?: string }): string {
  const st = String((s && s.status) || 'free').toLowerCase();
  if (st === 'maintain' || st === 'maintenance') return 'maintain';
  if (st === 'reserved' || st === 'booked') return 'reserved';
  if (st === 'active' || st === 'in_use' || st === 'occupied' || st === 'using') return 'in-use';
  return 'free';
}

/** 无座位明细时，用 free/total 合成占位（占位不代表真实座位，仅保证格数可读） */
function synthesizeMini(room: RoomSummary): string[] {
  const total = Number(room.total) || 0;
  const free = Number(room.freeCount) || 0;
  const arr: string[] = [];
  for (let i = 0; i < total; i++) arr.push(i < free ? 'free' : 'reserved');
  return arr;
}

interface MiniSeats {
  /** 迷你格状态数组 */
  cells: string[];
  /** 因超过 MINI_SEAT_MAX 而未渲染的格数（0 表示全部展示） */
  overflow: number;
}

/**
 * 把房间座位压成迷你密度图。
 * ⚠️ 格数必须与徽标「空闲 x/y」的 y 完全同源，否则会出现「徽标 18 / 格子 16」的不一致。
 * 因此这里以 room.seats 的长度为准（roomList 云函数的 total 也是 seats.length），
 * 不再使用早期写死的 slice(0, 16)。
 */
function miniStatuses(room: RoomSummary): MiniSeats {
  const seats = (room.seats || []) as Array<{ status?: string }>;
  const all = seats.length ? seats.map(toMiniStatus) : synthesizeMini(room);
  return {
    cells: all.slice(0, MINI_SEAT_MAX),
    overflow: Math.max(0, all.length - MINI_SEAT_MAX),
  };
}

/**
 * 座位总数与空闲数：优先用 seats 明细现算，保证与迷你格、与选座页口径一致；
 * 明细缺失时才回退到云端返回的 total / freeCount。
 */
function seatCounts(room: RoomSummary): { total: number; freeCount: number } {
  const seats = (room.seats || []) as Array<{ status?: string }>;
  if (seats.length) {
    return {
      total: seats.length,
      freeCount: seats.filter((s) => toMiniStatus(s) === 'free').length,
    };
  }
  return { total: Number(room.total) || 0, freeCount: Number(room.freeCount) || 0 };
}

type RoomView = RoomSummary & {
  miniSeats: string[];
  /** 超出渲染上限的座位数，>0 时卡片显示「+N」 */
  miniOverflow: number;
  /** 徽标用：与 miniSeats 同源，保证「空闲 x/y」与格子数一致 */
  total: number;
  freeCount: number;
  floorPlanImage: string;
};

/** 房间特征筛选（本地做：roomList 白名单只收 startAt/endAt，属性筛选由前端完成） */
type RoomFeatureFilter = '' | 'power' | 'window' | 'quiet';

const ROOM_FEATURE_FILTERS: Array<{ key: RoomFeatureFilter; label: string }> = [
  { key: '', label: '全部' },
  { key: 'power', label: '有电源' },
  { key: 'window', label: '靠窗' },
  { key: 'quiet', label: '安静' },
];

/** 排序方式：空闲优先 / 座位最多 / 离打烊近 */
type RoomSort = 'free' | 'total' | 'window';

const ROOM_SORTS: Array<{ key: RoomSort; label: string }> = [
  { key: 'free', label: '空闲优先' },
  { key: 'total', label: '座位最多' },
  { key: 'window', label: '离打烊近' },
];

/** 房间是否含某特征（座位级聚合：任一座位含即算；维护中座位不参与） */
function roomHasFeature(room: RoomSummary, feature: string): boolean {
  const seats = (room.seats || []) as Array<{ features?: string[]; status?: string }>;
  return seats.some((s) => {
    if (toMiniStatus(s) === 'maintain') return false;
    return ((s.features || []) as string[])
      .map((f) => String(f).toLowerCase())
      .indexOf(feature) !== -1;
  });
}

/** 距打烊剩余分钟数（负数 = 已打烊） */
function minutesUntilClose(room: RoomSummary, now = new Date()): number {
  const parts = String(room.close_time || '0:0').split(':').map(Number);
  const h = Number(parts[0]) || 0;
  const m = Number(parts[1]) || 0;
  return h * 60 + m - (now.getHours() * 60 + now.getMinutes());
}

/**
 * 应用搜索（关键词命中：名称/楼栋/楼层/描述均计入）+ 特征筛选 + 排序。
 * 全部纯函数、本地执行，不申请额外云函数入参。
 */
function applyRoomFilters(
  rooms: RoomView[],
  keyword: string,
  feature: RoomFeatureFilter,
  sort: RoomSort,
): RoomView[] {
  const kw = keyword.trim().toLowerCase();
  const filtered = rooms.filter((r) => {
    if (kw) {
      const haystack = [r.name, r.building, r.floor, r.description, r.code]
        .map((x) => String(x || '').toLowerCase())
        .join(' ');
      if (haystack.indexOf(kw) === -1) return false;
    }
    if (feature && !roomHasFeature(r, feature)) return false;
    return true;
  });
  const now = new Date();
  return filtered.slice().sort((a, b) => {
    if (sort === 'free') {
      const fa = a.freeCount / Math.max(1, a.total);
      const fb = b.freeCount / Math.max(1, b.total);
      if (fa !== fb) return fb - fa;
      return b.total - a.total;
    }
    if (sort === 'total') return b.total - a.total;
    return minutesUntilClose(a, now) - minutesUntilClose(b, now);
  });
}

Page({
  data: {
    rooms: [] as RoomView[],
    filteredRooms: [] as RoomView[],
    loading: false,
    empty: true,
    /** 是否为 roomList 返回的实时占用数据；false 时座位状态不可信，UI 必须显式标注 */
    realtime: true,
    /** 数据源降级 / 演示数据提示文案（空串 = 实时数据正常） */
    demoNotice: '',
    // —— 搜索 / 筛选 / 排序（全部本地执行）——
    keyword: '',
    featureFilter: '' as RoomFeatureFilter,
    sort: 'free' as RoomSort,
    featureFilters: ROOM_FEATURE_FILTERS,
    sorts: ROOM_SORTS,
    filterCount: 0,
    /** 是否有房间数据（区别于「筛选后无匹配」） */
    hasRooms: false,
  },

  onShow() {
    // 同步 tabBar 选中态（组件 pageLifetimes.show 的路由计算时机不稳，官方推荐页面侧显式刷新）
    this.getTabBar()?.refresh?.();
    this.loadRooms();
  },

  async loadRooms() {
    this.setData({ loading: true });
    try {
      const raw = await listRooms();
      // ⚠️ 降级到 categoryList 时座位只有定义、没有实时占用，会一律显示空闲；
      // 必须让用户看见「状态不可信」，否则会误判成「座位是空的却约不上」。
      const realtime = isRealtimeSeats();
      const demoNotice = describeRoomSource();
      const rooms = raw.map((r) => {
        const fp = resolveRoomFloorPlan(r.code || '');
        const mini = miniStatuses(r);
        const counts = seatCounts(r);
        return {
          ...r,
          miniSeats: mini.cells,
          miniOverflow: mini.overflow,
          // 用同一份 seats 明细重算，避免徽标与格子数来自不同口径
          total: counts.total,
          freeCount: counts.freeCount,
          floorPlanImage: fp?.image || '',
        };
      });
      this.setData({
        rooms,
        hasRooms: rooms.length > 0,
        loading: false,
        realtime,
        demoNotice,
      });
      // 先落 rooms，再基于新数据应用当前筛选/排序（empty 由 applyFilters 统一维护）
      this.applyFilters();
    } catch (err) {
      this.setData({ loading: false, empty: true, rooms: [], filteredRooms: [], hasRooms: false, realtime: false });
      showError(err, '自习室暂时加载不出来，请稍后重试');
    }
  },

  /** 对已加载的 rooms 应用当前搜索/筛选/排序，产出 filteredRooms */
  applyFilters() {
    // 没有任何可筛数据（还未加载 / 云端空）→ 保持原始空态
    if (!this.data.hasRooms) {
      this.setData({ filteredRooms: [], filterCount: 0, empty: true });
      return;
    }
    const filteredRooms = applyRoomFilters(
      this.data.rooms,
      this.data.keyword,
      this.data.featureFilter,
      this.data.sort,
    );
    this.setData({
      filteredRooms,
      empty: filteredRooms.length === 0,
      filterCount: filteredRooms.length,
    });
  },

  /** 搜索输入（防抖由用户输入频率天然控制，本地过滤无压力） */
  onKeywordInput(e: WechatMiniprogram.Input) {
    this.setData({ keyword: String(e.detail.value || '') });
    this.applyFilters();
  },

  /** 特征筛选切换 */
  onFeatureFilterTap(e: WechatMiniprogram.CustomEvent<{ key: string }>) {
    const key = String(e.currentTarget?.dataset?.key || '') as RoomFeatureFilter;
    if (key === this.data.featureFilter) return;
    this.setData({ featureFilter: key });
    this.applyFilters();
  },

  /** 排序切换 */
  onSortTap(e: WechatMiniprogram.CustomEvent<{ key: string }>) {
    const key = String(e.currentTarget?.dataset?.key || '') as RoomSort;
    if (key === this.data.sort) return;
    this.setData({ sort: key });
    this.applyFilters();
  },

  /** 清除全部搜索/筛选条件 */
  onClearFilters() {
    this.setData({ keyword: '', featureFilter: '', sort: 'free' });
    this.applyFilters();
  },

  onRoomTap(e: WechatMiniprogram.CustomEvent<{ roomId?: string }> & WechatMiniprogram.TouchEvent) {
    const roomId = (e.currentTarget?.dataset?.roomId as string) || e.detail?.roomId;
    if (!roomId) return;
    const room = (this.data.rooms as RoomView[]).find((r) => r.room_id === roomId);
    wx.navigateTo({
      url: `/subpages/seats/seats?roomId=${roomId}&name=${encodeURIComponent(room?.name || '')}`,
    });
  },
});
