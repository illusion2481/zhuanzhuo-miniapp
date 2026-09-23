/**
 * categories / records / users 集合约定与示例结构
 * 与 Plan §5 对齐；运行时数据由云函数 seedData 写入
 */

export const COLLECTIONS = {
  CATEGORIES: 'categories',
  RECORDS: 'records',
  USERS: 'users',
} as const;

/** 建议在云控制台创建的索引 */
export const SUGGESTED_INDEXES = [
  {
    collection: 'categories',
    fields: [
      { name: 'type', direction: 'asc' },
      { name: 'status', direction: 'asc' },
      { name: 'sort', direction: 'asc' },
    ],
  },
  {
    collection: 'records',
    fields: [
      { name: 'user_id', direction: 'asc' },
      { name: 'record_type', direction: 'asc' },
      { name: 'created_at', direction: 'desc' },
    ],
  },
  {
    collection: 'records',
    fields: [
      { name: 'room_id', direction: 'asc' },
      { name: 'seat_id', direction: 'asc' },
      { name: 'start_at', direction: 'asc' },
      { name: 'end_at', direction: 'asc' },
    ],
  },
  {
    collection: 'records',
    fields: [
      { name: 'record_type', direction: 'asc' },
      { name: 'status', direction: 'asc' },
      { name: 'start_at', direction: 'asc' },
    ],
  },
  {
    collection: 'users',
    fields: [{ name: 'open_id_hash', direction: 'asc' }],
  },
] as const;
