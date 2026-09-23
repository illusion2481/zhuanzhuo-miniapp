import { callCloud } from './cloud';
import type { Category, CategoryListQuery, CategoryType } from '../types/category';
import type { RoomSummary, SeatDef } from '../types/room';

export async function listCategories(query: CategoryListQuery | CategoryType = {}): Promise<Category[]> {
  const payload: CategoryListQuery =
    typeof query === 'string' ? { type: query } : query || {};
  const res = await callCloud<Category[]>('categoryList', { ...payload });
  if (!res.success) {
    throw new Error(res.message || '获取分类失败');
  }
  return res.data || [];
}

export async function listSeatFeatures(): Promise<Category[]> {
  return listCategories({ type: 'seat_feature' });
}

export async function listStudyGoals(): Promise<Category[]> {
  return listCategories({ type: 'study_goal' });
}

export async function listRoomCategories(): Promise<Category[]> {
  return listCategories({ type: 'room' });
}

/**
 * 将 room 分类转为列表摘要。
 *
 * ⚠️ metadata.seats 是**座位定义**，其中的 status 是静态值（建座时写入，如 maintain），
 * **不含任何实时占用**。要让座位随预约变红，必须走 roomList 云函数。
 * 这里仍然把 seats 原样带出去，是为了让降级状态下平面图/座位数仍可渲染，
 * 但调用方（services/room.ts）会把数据源标记为 'static' 并提示用户。
 */
export function toRoomSummary(category: Category): RoomSummary {
  const meta = (category.metadata || {}) as {
    building?: string;
    /**
     * 楼层。库里**统一为字符串**（adminOps 写入时归一、seed 也是字符串），
     * 但历史数据可能是数字 → 这里按 `string | number` 读入，输出时统一转成字符串，
     * 与 `RoomSummary.floor: string` 的声明保持一致。
     */
    floor?: string | number;
    open_time?: string;
    close_time?: string;
    seats?: SeatDef[];
  };
  const seats = meta.seats || [];
  const freeCount = seats.filter((s) => s.status !== 'maintain').length;
  return {
    room_id: category._id,
    code: category.code,
    name: category.name,
    description: category.description,
    building: meta.building,
    floor: meta.floor === undefined || meta.floor === null ? undefined : String(meta.floor),
    open_time: meta.open_time,
    close_time: meta.close_time,
    freeCount,
    total: seats.length,
    seats,
  };
}

export async function listRoomSummaries(): Promise<RoomSummary[]> {
  const rooms = await listRoomCategories();
  return rooms.map(toRoomSummary);
}
