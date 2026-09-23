import { callCloud } from './cloud';
import { listRoomSummaries } from './category';
import type { RoomSummary, SeatDef } from '../types/room';

/**
 * 房间查询参数。
 *
 * ⚠️ 只保留云端 roomList 白名单**真正接受**的字段（startAt / endAt）。
 * 历史上这里还有 `date` / `features`，但 roomList 的 SCHEMA 从未声明它们 →
 * `validateEvent` 会**静默剥离**（不报错、也不生效）：调用方以为筛过了，
 * 实际拿到的是全量数据。要按座位属性筛选请在前端做
 * （见 subpages/seats 的 matchFeatureFilter）。
 */
export interface RoomQuery {
  startAt?: string;
  endAt?: string;
}

/**
 * Sprint A-3：纯前端演示兜底数据。
 * 与 cloudfunctions/seedData/seedPayload.js 的「自习室（3 房 26 座）」严格一致，
 * 供云端未部署 / roomList 未就绪时也能点通「选房→选座→预约」UI。
 * 结构对齐 roomList 云函数返回（每个 seat 含 status），顶部列表与座位图都用它。
 */
export const DEMO_ROOMS: RoomSummary[] = [
  {
    room_id: 'room_library_1f',
    code: 'library_1f',
    name: '图书馆一楼自习区',
    description: '安静区，适合长时间备考',
    building: '图书馆',
    floor: '1',
    open_time: '08:00',
    close_time: '22:00',
    total: 12,
    freeCount: 12,
    seats: [
      seat('A-1', 1, 1, ['quiet', 'power']),
      seat('A-2', 1, 2, ['quiet']),
      seat('A-3', 1, 3, ['quiet', 'power', 'window']),
      seat('A-4', 1, 4, ['quiet', 'window']),
      seat('A-5', 2, 1, ['quiet', 'power']),
      seat('A-6', 2, 2, ['quiet']),
      seat('A-7', 2, 3, ['quiet', 'power']),
      seat('A-8', 2, 4, ['quiet']),
      seat('A-9', 3, 1, ['power', 'window']),
      seat('A-10', 3, 2, ['quiet', 'power']),
      seat('A-11', 3, 3, ['quiet']),
      seat('A-12', 3, 4, ['quiet', 'power', 'window']),
    ],
  },
  {
    room_id: 'room_teaching_3f',
    code: 'teaching_3f',
    name: '教学楼三楼自习室',
    description: '靠近教室，适合课间连续学习',
    building: '教学楼 B',
    floor: '3',
    open_time: '07:30',
    close_time: '21:30',
    total: 8,
    freeCount: 7,
    seats: [
      seat('B-1', 1, 1, ['power']),
      seat('B-2', 1, 2, ['power']),
      seat('B-3', 1, 3, ['window']),
      seat('B-4', 1, 4, ['power', 'window']),
      seat('B-5', 2, 1, []),
      seat('B-6', 2, 2, ['power']),
      seat('B-7', 2, 3, ['quiet', 'power']),
      seat('B-8', 2, 4, ['quiet'], 'maintain'),
    ],
  },
  {
    room_id: 'room_cafe_study',
    code: 'cafe_study',
    name: '咖啡学习角',
    description: '轻声交流区，适合小组讨论后独立复习',
    building: '学生中心',
    floor: '2',
    open_time: '09:00',
    close_time: '23:00',
    total: 6,
    freeCount: 6,
    seats: [
      seat('C-1', 1, 1, ['power', 'window']),
      seat('C-2', 1, 2, ['power']),
      seat('C-3', 1, 3, []),
      seat('C-4', 2, 1, ['power']),
      seat('C-5', 2, 2, ['window']),
      seat('C-6', 2, 3, ['power']),
    ],
  },
];

/** 生成 SeatDef（默认 status: 'free'） */
function seat(seat_id: string, row: number, col: number, features: string[], status: 'free' | 'maintain' = 'free') {
  return {
    seat_id,
    row,
    col,
    features,
    label: undefined as string | undefined,
    status,
  } as SeatDef & { status: 'free' | 'maintain' };
}

/**
 * 最近一次 listRooms 的数据来源。
 * - cloud ：roomList 云函数返回，**含实时占用状态**（座位会随预约变红）
 * - static：降级到 categoryList，只有房间/座位**定义**，没有任何实时占用 →
 *           座位会一律显示为空闲，这时候必须显式告知用户，否则会误判成「约不上但座位是空的」
 * - demo  ：云端完全未初始化，本地 DEMO_ROOMS 兜底
 */
export type RoomSource = 'cloud' | 'static' | 'demo';

let lastRoomSource: RoomSource = 'cloud';

export function getRoomSource(): RoomSource {
  return lastRoomSource;
}

/** 座位占用状态是否为实时数据（只有 roomList 才是） */
export function isRealtimeSeats(): boolean {
  return lastRoomSource === 'cloud';
}

/**
 * 数据源提示文案（空串 = 实时数据可用，无需提示）。
 * ⚠️ 血泪坑：降级到 categoryList 时曾经把 source 记成 'cloud'，于是页面既没有警报、
 * 座位又永远全绿，用户看到「有 18 个空位却约不上」，完全无从判断是系统降级。
 * 现在降级为 'static' 并强制显式提示。
 */
export function describeRoomSource(source: RoomSource = lastRoomSource): string {
  if (source === 'demo') {
    return '当前为本地演示数据：云端尚未初始化，座位状态不会变化。请先执行「数据初始化」或部署 roomList 云函数。';
  }
  if (source === 'static') {
    return '座位实时占用状态不可用（roomList 云函数未部署或调用失败）：本页座位一律显示为空闲，实际能否预约以提交结果为准。';
  }
  return '';
}

/**
 * Sprint A-3：列表房间。
 * 优先级：roomList 云函数成功 → 云端 categories 组装(listRoomSummaries) → 纯本地 DEMO_ROOMS 兜底。
 * 保证「云端未部署/数据未注入」时，选房→选座→预约 UI 仍能点通。
 *
 * ⚠️ 兜底到 DEMO_ROOMS 时座位永远不变色，用户会误以为「系统坏了」，
 * 因此调用方应通过 getRoomSource() 判断并给出明确提示。
 */
export async function listRooms(query: RoomQuery = {}): Promise<RoomSummary[]> {
  // 1) roomList 云函数就绪且返回非空
  try {
    const res = await callCloud<RoomSummary[]>('roomList', { ...query });
    if (res.success && Array.isArray(res.data) && res.data.length) {
      lastRoomSource = 'cloud';
      return res.data;
    }
  } catch {
    // roomList 未部署或调用失败 → 继续降级
  }

  // 2) 云端 categories 已注入（seedData 跑过但 roomList 未部署）
  //    ⚠️ 这里拿到的只有「房间/座位定义」，**没有实时占用**（seats[].status 是静态值），
  //    所以必须标记为 'static' 而不是 'cloud'，否则页面会静默地全绿且不提示。
  try {
    const rooms = await listRoomSummaries();
    if (rooms && rooms.length) {
      lastRoomSource = 'static';
      return rooms;
    }
  } catch {
    // categories 也未就绪 → 纯本地演示兜底
  }

  // 3) 纯本地演示数据（云端完全未初始化时保证 UI 可点通）
  lastRoomSource = 'demo';
  return DEMO_ROOMS;
}