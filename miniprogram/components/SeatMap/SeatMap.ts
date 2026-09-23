import { toSeatDisplayName } from '../../utils/seatName';
import { sortSeatsByNumber } from '../../utils/seatOrder';
import type { FloorPlanConfig } from '../../config/floorPlans';

type NormStatus = 'free' | 'reserved' | 'in-use' | 'maintain';

/** 归一化云端返回的座位状态，避免 free/reserved/active/in_use 等命名不一致导致着色错位 */
function normalizeStatus(raw?: string): NormStatus {
  const s = String(raw || '').toLowerCase();
  if (s === 'free' || s === 'available' || s === 'empty') return 'free';
  if (s === 'reserved' || s === 'booked') return 'reserved';
  if (s === 'maintain' || s === 'maintenance' || s === 'repair') return 'maintain';
  if (s === 'active' || s === 'occupied' || s === 'in_use' || s === 'in-use' || s === 'using') return 'in-use';
  return 'free';
}

/* ── 网格模式常量（原有逻辑） ── */
const GUTTER_LEFT = 44;
const GUTTER_TOP = 36;
const CELL = 84;
const SEAT = 72;

interface RawSeat {
  seat_id: string;
  label?: string;
  features?: string[];
  status?: string;
  row?: number;
  col?: number;
  /** 页面侧按特征筛选打的高亮标记（靠窗/有电源等），组件负责透出渲染 */
  highlighted?: boolean;
  /** 本人已预约的座位（与查看时段无关），页面侧叠加，组件负责透出「我的」样式 */
  mine?: boolean;
}

interface MappedSeat {
  seat_id: string;
  short: string;
  displayName: string;
  status: NormStatus;
  bookable: boolean;
  highlighted: boolean;
  mine: boolean;
  style: string;
}

interface AxisCell {
  label: string;
  style: string;
}

Component({
  properties: {
    roomId: { type: String, value: '' },
    seats: { type: Array, value: [] },
    /**
     * 平面图配置：传入 FloorPlanConfig 对象（含 seats 坐标）即走平面图模式；
     * 传 null/undefined 走原有网格模式。
     */
    floorPlan: { type: null, value: null as FloorPlanConfig | null },
    /**
     * 座位状态是否为实时数据（roomList 云函数返回）。
     * false 时座位颜色只是默认值（一律 free），必须显式降调，避免被误读成「全部空闲」。
     */
    realtime: { type: Boolean, value: true },
  },
  data: {
    displaySeats: [] as MappedSeat[],
    rowLabels: [] as AxisCell[],
    colLabels: [] as AxisCell[],
    gridStyle: '',
    cornerStyle: '',
    /* 平面图模式 */
    isFloorPlan: false,
    floorPlanImage: '',
  },
  observers: {
    /** seats 或 floorPlan 任一变化都重算 */
    'seats, floorPlan'(rawSeats: RawSeat[], fp: FloorPlanConfig | null) {
      // 统一按编号升序（A-1 → A-13）后再落位，与后台座位格共用 sortSeatsByNumber。
      // ⚠️ 必须在这里排：两种模式都依赖数组顺序——
      //   平面图模式按索引 i 取 fp.positions[i] 的坐标；网格模式无坐标时按 i 推算 row/col。
      //   顺序乱 → 座位会落在错误的坐标点/格子上（表现为 A-13 排在 A-9 旁边）。
      const ordered = sortSeatsByNumber(rawSeats || []);
      // 传入 floorPlan（含底图 + bounds）即走平面图模式，座位坐标由真实 seats 动态生成
      if (fp && fp.image) {
        this.buildFloorPlan(ordered, fp);
      } else {
        this.buildGrid(ordered);
      }
    },
  },
  methods: {
    /**
     * 平面图模式：优先用固定坐标点（positions），fallback 到 bounds 均匀分布。
     * 关键保护：真实座位数与坐标数不匹配时自动适配，绝不堆叠/崩溃。
     */
    buildFloorPlan(rawSeats: RawSeat[], fp: FloorPlanConfig) {
      const size = fp.seatSize ?? 5;
      const aspect = fp.aspect ?? 1.78;
      const list = rawSeats || [];
      const pts = fp.positions && fp.positions.length > 0 ? fp.positions : null;

      // 既无坐标点也无边界框 → 回退网格模式，保证不崩
      if (!pts && !fp.bounds) {
        this.buildGrid(list);
        return;
      }

      const overflowBase = pts ? pts.length : 0;
      const totalOverflow = Math.max(0, list.length - overflowBase);
      const cols = Math.max(1, Math.ceil(Math.sqrt(totalOverflow || 1)));
      const rows = Math.max(1, Math.ceil(totalOverflow / cols));
      // 未显式配置 bounds 时用整图范围兜底，避免溢出座位堆在中心
      const b = fp.bounds || { top: 6, bottom: 94, left: 6, right: 94 };

      if (pts && pts.length !== list.length) {
        console.warn(
          `[SeatMap] 座位坐标数(${pts.length}) 与真实座位数(${list.length}) 不一致，已自动适配（溢出座位在边界内网格兜底）`,
        );
      }

      const displaySeats = list.map((s, i) => {
        const status = normalizeStatus(s.status);
        let x: number;
        let y: number;

        if (pts && i < pts.length) {
          // 1:1 映射：座位数 ≤ 坐标数，或前半部分精确落点
          x = pts[i].x;
          y = pts[i].y;
        } else {
          // 溢出（座位数 > 坐标数）或完全无 positions：在边界内网格兜底
          const idxInOverflow = i - overflowBase;
          const rowIdx = Math.floor(idxInOverflow / cols);
          const colIdx = idxInOverflow % cols;
          x = b.left + ((colIdx + 0.5) / cols) * (b.right - b.left);
          y = b.top + ((rowIdx + 0.5) / rows) * (b.bottom - b.top);
        }

        const style = `left:${x}%; top:${y}%; width:${size}%; height:${size * aspect}%;`;
        return {
          seat_id: s.seat_id,
          status,
          bookable: status === 'free' && s.mine !== true,
          highlighted: s.highlighted === true,
          mine: s.mine === true,
          // 兼容旧格式：早期库里存 A-001，2026-09-17 起统一为 A-1；此处兜底去前导零，保证显示口径一致
          short: s.seat_id.replace(/^([A-Za-z]+)-0+/, '$1-'),
          displayName: toSeatDisplayName(s),
          style,
        };
      });
      this.setData({
        displaySeats,
        isFloorPlan: true,
        floorPlanImage: fp.image,
        rowLabels: [],
        colLabels: [],
        gridStyle: '',
        cornerStyle: '',
      });
    },

    /** 网格模式（原有逻辑）：按 row/col 绝对定位 */
    buildGrid(rawSeats: RawSeat[]) {
      this.setData({ isFloorPlan: false, floorPlanImage: '' });
      const list = rawSeats || [];
      const hasLayout =
        list.length > 0 && list.every((s) => typeof s.row === 'number' && typeof s.col === 'number');
      const cols = hasLayout ? Math.max(...list.map((s) => s.col as number)) : Math.ceil(Math.sqrt(list.length)) || 1;

      const displaySeats = list.map((seat, i) => {
        const status = normalizeStatus(seat.status);
        const row = hasLayout ? (seat.row as number) : Math.floor(i / cols) + 1;
        const col = hasLayout ? (seat.col as number) : (i % cols) + 1;
        const style = `left:${GUTTER_LEFT + (col - 1) * CELL}rpx; top:${GUTTER_TOP + (row - 1) * CELL}rpx; width:${SEAT}rpx; height:${SEAT}rpx;`;
        return {
          seat_id: seat.seat_id,
          status,
          bookable: status === 'free' && seat.mine !== true,
          highlighted: seat.highlighted === true,
          mine: seat.mine === true,
          row,
          col,
          // 兼容旧格式：早期库里存 A-001，2026-09-17 起统一为 A-1（同平面图模式）
          short: seat.seat_id.replace(/^([A-Za-z]+)-0+/, '$1-'),
          displayName: toSeatDisplayName(seat),
          style,
        } as MappedSeat;
      });

      const maxRow = displaySeats.reduce((m, s) => Math.max(m, (s as MappedSeat & { row: number }).row), 0);
      const maxCol = displaySeats.reduce((m, s) => Math.max(m, (s as MappedSeat & { col: number }).col), 0);
      const colLabels = Array.from({ length: maxCol }, (_, i) => ({
        label: `列${i + 1}`,
        style: `left:${GUTTER_LEFT + i * CELL}rpx; top:0; width:${SEAT}rpx;`,
      }));
      const rowLabels = Array.from({ length: maxRow }, (_, i) => ({
        label: `排${i + 1}`,
        style: `left:0; top:${GUTTER_TOP + i * CELL}rpx; width:${GUTTER_LEFT}rpx;`,
      }));
      this.setData({
        displaySeats,
        rowLabels,
        colLabels,
        gridStyle: `width:${GUTTER_LEFT + maxCol * CELL}rpx; height:${GUTTER_TOP + maxRow * CELL}rpx;`,
        cornerStyle: `left:0; top:0; width:${GUTTER_LEFT}rpx; height:${GUTTER_TOP}rpx;`,
      });
    },

    onSeatTap(e: WechatMiniprogram.TouchEvent) {
      const seatId = e.currentTarget.dataset.id as string;
      this.triggerEvent('seatselect', { seatId });
    },
  },
});
